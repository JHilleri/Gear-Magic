#!/usr/bin/env python3
"""Turn generated audio masters (art/outputs/audio/{sfx,music}/*.flac) into game assets.

Usage:
    python3 tools/export_audio.py [--dry]

For every SFX take: trim leading silence, cut the tail once it has decayed away (capped at the length
the manifest asked for), short fades, level it to a per-category loudness target (peak-limited to
-1 dBFS) and encode Ogg Opus. Music tracks are levelled to one target and keep their full length.
Takes that fail automatic checks (silent, clipped, nothing but noise floor) are dropped.

Which takes ship: all that pass, up to MAX_TAKES per sound, unless manifests/audio_pick.json lists
them explicitly, e.g. {"sfx": {"clash": [0, 2, 3]}, "music": {"title": [1]}} (take indices).

Writes game/public/assets/audio/{sfx,music}/*.ogg and game/public/assets/audio/audio.json:
    {"sfx": {"clash": ["sfx/clash_0.ogg", ...]}, "music": {"title": [...], "game": [...], "tension": [...]}}
"""
import array
import json
import math
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "outputs", "audio")
DST = os.path.join(os.path.dirname(ROOT), "game", "public", "assets", "audio")
SR = 48000

# Target RMS of the audible part (dBFS, mono sum) per sound. Peak is always kept under -1 dBFS.
TARGET = {
    "select": -27, "deselect": -28, "error": -26, "modalOpen": -28, "modalClose": -28, "step": -27,
    "clash": -21, "hit": -21, "miss": -24, "bow": -23, "arrowWhoosh": -25, "arrowHit": -22,
    "magicCast": -23, "magicWhoosh": -24, "magicHit": -21, "explosion": -18, "lightning": -18,
    "heal": -24, "bless": -24, "haste": -24, "farsight": -25, "summon": -19, "hammer": -23,
    "buildComplete": -22, "levelUp": -21, "turnHorn": -21, "victory": -19, "defeat": -20, "death": -22,
    "spawn": -23, "coin": -24, "research": -24, "capture": -22, "equip": -25, "craft": -22,
    "poison": -25, "destroy": -19,
}
MAX_TAKES = {"step": 6, "clash": 6, "hit": 6, "death": 6}
MUSIC_TARGET = -20
MUSIC_MOOD = {"title": "title", "game_1": "game", "game_2": "game", "game_3": "game", "battle_1": "tension", "battle_2": "tension"}


def ff(*args, inp=None):
    return subprocess.run(["ffmpeg", "-v", "error", *args], input=inp, capture_output=True, check=True).stdout


def decode_mono(path):
    raw = ff("-i", path, "-ac", "1", "-ar", str(SR), "-f", "s16le", "-")
    a = array.array("h")
    a.frombytes(raw[: len(raw) // 2 * 2])
    return a


def db(v):
    return 20 * math.log10(v) if v > 1e-9 else -120.0


def frames(a, win):
    """RMS (linear, 0..1) per window."""
    out = []
    for i in range(0, len(a), win):
        seg = a[i:i + win]
        out.append(math.sqrt(sum(x * x for x in seg) / max(1, len(seg))) / 32768)
    return out


def analyse(path, max_len):
    a = decode_mono(path)
    win = SR // 100  # 10 ms
    env = frames(a, win)
    if not env:
        return None
    peak_env = max(env)
    peak = max(abs(min(a)), abs(max(a))) / 32768
    clipped = sum(1 for x in a if abs(x) >= 32766)
    # start: first window within 30 dB of the loudest window (and above -50 dBFS)
    thr_start = max(peak_env * 10 ** (-30 / 20), 10 ** (-50 / 20))
    start = next((i for i, v in enumerate(env) if v >= thr_start), 0)
    # end: last window within 45 dB of the loudest (and above -60 dBFS), capped
    thr_end = max(peak_env * 10 ** (-45 / 20), 10 ** (-60 / 20))
    end = max((i for i, v in enumerate(env) if v >= thr_end), default=len(env) - 1) + 1
    s = max(0, start - 1) * win / SR          # keep 10 ms before the onset
    e = min(len(a) / SR, end * win / SR + 0.04)
    if max_len:
        e = min(e, s + max_len)
    act = [v for v in env[start:end] if v >= peak_env * 10 ** (-40 / 20)]
    rms = math.sqrt(sum(v * v for v in act) / len(act)) if act else 0
    return {"start": s, "end": e, "peak_db": db(peak), "rms_db": db(rms), "clipped": clipped, "len": len(a) / SR}


def encode(src, dst, start, end, gain_db, bitrate, fade_out):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    dur = end - start
    af = (f"atrim=start={start:.3f}:end={end:.3f},asetpts=PTS-STARTPTS,"
          f"afade=t=in:d=0.004,afade=t=out:st={max(0, dur - fade_out):.3f}:d={fade_out:.3f},volume={gain_db:.2f}dB")
    ff("-y", "-i", src, "-af", af, "-c:a", "libopus", "-b:a", bitrate, "-ar", "48000", dst)


def takes_of(cat, sid):
    d = os.path.join(SRC, cat)
    ks = sorted(int(f[len(sid) + 1:-5]) for f in os.listdir(d)
                if f.startswith(sid + "_") and f.endswith(".flac") and f[len(sid) + 1:-5].isdigit())
    return [(k, os.path.join(d, f"{sid}_{k}.flac")) for k in ks]


def main():
    dry = "--dry" in sys.argv
    manifests = {j["id"]: j for m in ("sfx.json", "music.json") for j in json.load(open(os.path.join(ROOT, "manifests", m)))}
    pick_path = os.path.join(ROOT, "manifests", "audio_pick.json")
    pick = json.load(open(pick_path)) if os.path.exists(pick_path) else {}
    out = {"sfx": {}, "music": {"title": [], "game": [], "tension": []}}
    report = []

    for sid in TARGET:
        if not os.path.isdir(os.path.join(SRC, "sfx")):
            break
        chosen = pick.get("sfx", {}).get(sid)
        files = []
        for k, path in takes_of("sfx", sid):
            if chosen is not None and k not in chosen:
                continue
            info = analyse(path, manifests.get(sid, {}).get("seconds"))
            if not info:
                continue
            bad = info["peak_db"] < -35 or info["clipped"] > 50 or info["end"] - info["start"] < 0.05
            gain = TARGET[sid] - info["rms_db"]
            gain = min(gain, -1.0 - info["peak_db"])  # keep the peak at or under -1 dBFS
            report.append(f"{'DROP' if bad else 'ok  '} sfx {sid}_{k}: {info['start']:.2f}-{info['end']:.2f}s "
                          f"peak {info['peak_db']:.1f} rms {info['rms_db']:.1f} gain {gain:+.1f} clip {info['clipped']}")
            if bad or (chosen is None and len(files) >= MAX_TAKES.get(sid, 4)):
                continue
            rel = f"sfx/{sid}_{k}.ogg"
            if not dry:
                fade = min(0.08, (info["end"] - info["start"]) * 0.2)
                encode(path, os.path.join(DST, rel), info["start"], info["end"], gain, "80k", fade)
            files.append(rel)
        if files:
            out["sfx"][sid] = files

    for tid, mood in MUSIC_MOOD.items():
        if not os.path.isdir(os.path.join(SRC, "music")):
            break
        chosen = pick.get("music", {}).get(tid)
        for k, path in takes_of("music", tid):
            if chosen is not None and k not in chosen:
                continue
            if chosen is None and k > 0:
                continue  # default: first take of each track
            info = analyse(path, None)
            bad = info["peak_db"] < -30 or info["clipped"] > 500
            gain = min(MUSIC_TARGET - info["rms_db"], -1.0 - info["peak_db"])
            report.append(f"{'DROP' if bad else 'ok  '} music {tid}_{k}: {info['start']:.2f}-{info['end']:.2f}s "
                          f"peak {info['peak_db']:.1f} rms {info['rms_db']:.1f} gain {gain:+.1f}")
            if bad:
                continue
            rel = f"music/{tid}_{k}.ogg"
            if not dry:
                encode(path, os.path.join(DST, rel), info["start"], info["end"], gain, "96k", 2.0)
            out["music"][mood].append(rel)

    print("\n".join(report))
    if not dry:
        os.makedirs(DST, exist_ok=True)
        with open(os.path.join(DST, "audio.json"), "w") as f:
            json.dump(out, f, indent=1)
        print("wrote", os.path.join(DST, "audio.json"))


if __name__ == "__main__":
    main()
