#!/usr/bin/env python3
"""Batch audio generator for the local ComfyUI: Stable Audio 3 Medium (SFX) and ACE-Step 1.5 XL Turbo (music).

Usage:
    python3 tools/gen_audio.py manifests/<name>.json [--only id1,id2] [--force] [--takes N]

Manifest format (JSON list). Every job writes art/outputs/audio/<cat>/<id>_<k>.flac, k = 0..takes-1.

    SFX (Stable Audio 3):
    {"id": "clash", "cat": "sfx", "model": "sa3", "seconds": 2.5, "takes": 4, "seed": 11,
     "prompt": "Two steel longswords clashing ... Length: 2 seconds"}

    Music (ACE-Step 1.5 XL Turbo, instrumental unless "lyrics" is given):
    {"id": "title", "cat": "music", "model": "ace", "seconds": 120, "takes": 1, "seed": 7,
     "tags": "Medieval fantasy orchestral, ...", "bpm": 72, "key": "D minor", "time": "4"}

The graphs are the gallery templates' own compiled graphs (audio_stable_audio_3_medium with the Qwen
reprompt path removed - prompts here are already written in Stable Audio's caption style - and
audio_ace_step1_5_xl_turbo). They are authored here because comfy-cli's pre-flight rejects the SA3
template's CustomCombo category selector. Jobs run one at a time (machine load limit) and are skipped
when their outputs exist (resumable). A take that comes out silent is retried after freeing models.
"""
import array
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

COMFY = os.environ.get("COMFY_LOCAL_URL", "http://127.0.0.1:8188")
COMFY_OUT = "/home/jeanh/ComfyUI-Shared/output"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SA3_CKPT = "stable_audio_3_medium.safetensors"
SA3_CLIP = "t5gemma_b_b_ul2.safetensors"
ACE_UNET = "acestep_v1.5_xl_turbo_bf16.safetensors"
ACE_CLIP1 = "qwen_0.6b_ace15.safetensors"
ACE_CLIP2 = "qwen_4b_ace15.safetensors"
ACE_VAE = "ace_1.5_vae.safetensors"


def prefix(job):
    return f"gm_audio/{job['cat']}/{job['id']}"


def graph_sa3(job, takes):
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": SA3_CKPT}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": SA3_CLIP, "type": "stable_audio", "device": "default"}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": job["prompt"], "clip": ["2", 0]}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": job.get("negative", ""), "clip": ["2", 0]}},
        "5": {"class_type": "EmptyLatentAudio", "inputs": {"seconds": float(job["seconds"]), "batch_size": takes}},
        "6": {"class_type": "KSampler", "inputs": {
            "seed": job.get("seed", 1), "steps": job.get("steps", 8), "cfg": job.get("cfg", 1.0),
            "sampler_name": "lcm", "scheduler": "simple", "denoise": 1.0,
            "model": ["1", 0], "positive": ["3", 0], "negative": ["4", 0], "latent_image": ["5", 0]}},
        "7": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["6", 0], "vae": ["1", 2]}},
        "8": {"class_type": "SaveAudioAdvanced", "inputs": {"audio": ["7", 0], "filename_prefix": prefix(job), "format": "flac"}},
    }


def graph_ace(job, takes):
    seed = job.get("seed", 0)
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": ACE_UNET, "weight_dtype": "default"}},
        "2": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": ACE_CLIP1, "clip_name2": ACE_CLIP2, "type": "ace", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": ACE_VAE}},
        "4": {"class_type": "ModelSamplingAuraFlow", "inputs": {"shift": job.get("shift", 3), "model": ["1", 0]}},
        "5": {"class_type": "TextEncodeAceStepAudio1.5", "inputs": {
            "clip": ["2", 0], "tags": job["tags"], "lyrics": job.get("lyrics", ""), "seed": seed,
            "bpm": job.get("bpm", 90), "duration": float(job["seconds"]), "timesignature": job.get("time", "4"),
            "language": job.get("language", "en"), "keyscale": job.get("key", "D minor"),
            "generate_audio_codes": True, "cfg_scale": job.get("lm_cfg", 2.0), "temperature": job.get("temperature", 0.85),
            "top_p": 0.9, "top_k": 0, "min_p": 0.0}},
        "6": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["5", 0]}},
        "7": {"class_type": "EmptyAceStep1.5LatentAudio", "inputs": {"seconds": float(job["seconds"]), "batch_size": takes}},
        "8": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": job.get("steps", 8), "cfg": 1.0, "sampler_name": "euler", "scheduler": "simple",
            "denoise": 1.0, "model": ["4", 0], "positive": ["5", 0], "negative": ["6", 0], "latent_image": ["7", 0]}},
        "9": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        "10": {"class_type": "SaveAudioAdvanced", "inputs": {"audio": ["9", 0], "filename_prefix": prefix(job), "format": "flac"}},
    }


def post(path, data):
    req = urllib.request.Request(COMFY + path, data=json.dumps(data).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def get(path):
    with urllib.request.urlopen(COMFY + path, timeout=60) as r:
        return json.loads(r.read())


def out_path(job, k):
    return os.path.join(ROOT, "outputs", "audio", job["cat"], f"{job['id']}_{k}.flac")


def stats(path):
    """Peak and RMS (dBFS) of a file, decoded by ffmpeg to mono 16-bit (no numpy here)."""
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", "22050", "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    a = array.array("h")
    a.frombytes(raw[: len(raw) // 2 * 2])
    if not a:
        return -120.0, -120.0, 0.0
    import math
    peak = max(abs(min(a)), abs(max(a))) / 32768
    rms = math.sqrt(sum(x * x for x in a) / len(a)) / 32768
    db = lambda v: 20 * math.log10(v) if v > 0 else -120.0
    return db(peak), db(rms), len(a) / 22050


def collect(job, hist):
    files = []
    for out in hist.get("outputs", {}).values():
        for f in out.get("audio", []):
            files.append(os.path.join(COMFY_OUT, f.get("subfolder", ""), f["filename"]))
    files.sort()
    os.makedirs(os.path.dirname(out_path(job, 0)), exist_ok=True)
    got = []
    for k, src in enumerate(files):
        dst = out_path(job, k)
        shutil.copyfile(src, dst)
        got.append(dst)
    return got


def main():
    args = sys.argv[1:]
    force = "--force" in args
    only = set(args[args.index("--only") + 1].split(",")) if "--only" in args else None
    takes_override = int(args[args.index("--takes") + 1]) if "--takes" in args else None
    manifest = [a for a in args if a.endswith(".json")][0]
    jobs = json.load(open(manifest))
    t0 = time.time()
    for job in jobs:
        if only and job["id"] not in only:
            continue
        takes = takes_override or job.get("takes", 1)
        if not force and all(os.path.exists(out_path(job, k)) for k in range(takes)):
            continue
        build = graph_sa3 if job.get("model", "sa3") == "sa3" else graph_ace
        for attempt in range(3):
            res = post("/prompt", {"prompt": build(job, takes), "client_id": "magic4x-audio"})
            pid = res["prompt_id"]
            print("queued", job["cat"], job["id"], pid, f"(try {attempt + 1})" if attempt else "", flush=True)
            while True:
                time.sleep(2)
                h = get(f"/history/{pid}")
                if pid in h:
                    break
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                print("FAILED", job["id"], json.dumps(st)[:1200], flush=True)
                break
            got = collect(job, h[pid])
            silent = []
            for p in got:
                pk, rms, dur = stats(p)
                print(f"   {os.path.basename(p)}  {dur:5.1f}s  peak {pk:6.1f} dB  rms {rms:6.1f} dB", flush=True)
                if pk < -40:
                    silent.append(p)
            if got and not silent:
                print(f"done {job['cat']}/{job['id']}  t+{time.time() - t0:.0f}s", flush=True)
                break
            print(f"SILENT/EMPTY {job['id']} -> freeing models and retrying", flush=True)
            try:
                post("/free", {"unload_models": True, "free_memory": True})
            except Exception:
                pass
            time.sleep(5)
    print("all done", flush=True)


if __name__ == "__main__":
    main()
