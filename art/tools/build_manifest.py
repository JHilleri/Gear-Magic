#!/usr/bin/env python3
"""Scan game/public/assets and write game/public/assets/manifest.json (format: ASSETS.md).

    python3 art/tools/build_manifest.py [--assets DIR] [--check]

* models/{units,items,mounts,buildings,props,monsters,hair,heads}/<key>.glb -> {"file": ...}; units also get
  "height" and mounts "saddle" from the <key>.meta.json sidecars written by the Blender scripts.
  Files that are not valid GLB (missing 'glTF' magic, partial writes, *.tmp.glb) are skipped.
* textures/**.{jpg,png,webp}: key = path below textures/ without extension, "terrain/" stripped
  (textures/terrain/grass.jpg -> "grass"); ui/* images are listed as "ui/<name>".
* icons/<cat>/<name>.png: keyed both as "<cat>/<name>.png" (the form used in data/*.ts) and
  "<cat>/<name>" (the ASSETS.md example form).
* portraits/<key>.png -> key.
--check prints a summary of what is missing compared with the expected asset list.
"""
import json
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp")
MODEL_KINDS = ("units", "items", "mounts", "buildings", "props", "monsters", "hair", "heads")

EXPECTED = {
    # humans: a man's and a woman's (bald) body per armour, and the leader; the others: one body per armour
    "units": [f"{r}_{b}" for r in ("orc", "undead") for b in ("commoner", "light", "heavy", "robe", "leader")]
             + ["human_leader"] + [f"human_{g}_{b}" for g in ("m", "f") for b in ("commoner", "padded", "light", "heavy", "robe")],
    "hair": [f"hair_{s}" for s in ("short", "crop", "swept", "tail", "curly", "long", "braid", "bun", "bob", "ponytail", "pixie")]
            + [f"beard_{s}" for s in ("short", "full", "moustache", "goatee", "long")],
    "heads": [f"head_{g}{i}" for g in ("m", "f") for i in (1, 2, 3)],
    "items": ["tools", "sword", "spear", "axe", "bow", "staff", "wand", "shield_human", "shield_orc", "shield_undead", "pauldron_plate"],
    "mounts": ["horse", "wolf", "nightmare"],
    "buildings": ["castle_valen", "castle_thorn", "castle_ashen", "house", "farm", "lumber", "quarry", "forge", "training",
                  "mine", "crystalmine", "library", "magetower", "wall", "watchtower", "shrine"],
    "props": ["pine", "oak", "deadtree", "rock", "peak", "crystal", "bush", "ruin", "reeds"],
    "monsters": ["wolf", "spider", "golem", "elemental"],
}


def is_glb(path):
    try:
        with open(path, "rb") as f:
            head = f.read(12)
        if len(head) < 12 or head[:4] != b"glTF":
            return False
        length = struct.unpack("<I", head[8:12])[0]
        return length == os.path.getsize(path)
    except OSError:
        return False


def read_meta(path):
    meta = os.path.splitext(path)[0] + ".meta.json"
    if os.path.exists(meta):
        try:
            with open(meta) as f:
                return json.load(f)
        except (OSError, ValueError):
            pass
    return {}


def neck_ring(ring):
    """A neck ring of a sidecar (blender/headmap.py, Blender axes) in glTF head-frame axes:
    centre (cx, cz) and radii (rx, rz) of the neck under the throat line, plus its skin colour if bare."""
    if not isinstance(ring, dict) or not all(isinstance(ring.get(k), (int, float)) for k in ("cx", "cy", "rx", "ry")):
        return None
    out = {"cx": round(float(ring["cx"]), 4), "cz": round(float(-ring["cy"]), 4), "rx": round(float(ring["rx"]), 4), "rz": round(float(ring["ry"]), 4)}
    if isinstance(ring.get("skin"), list) and len(ring["skin"]) == 3:
        out["skin"] = [round(float(c), 4) for c in ring["skin"]]
    return out


def rel(assets, path):
    return os.path.relpath(path, assets).replace(os.sep, "/")


def scan_models(assets, kind):
    out = {}
    d = os.path.join(assets, "models", kind)
    if not os.path.isdir(d):
        return out
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".glb") or fn.endswith(".tmp.glb"):
            continue
        p = os.path.join(d, fn)
        if not is_glb(p):
            print(f"skip (not a complete GLB): {rel(assets, p)}", file=sys.stderr)
            continue
        key = fn[:-4]
        entry = {"file": rel(assets, p)}
        meta = read_meta(p)
        if kind == "units":
            entry["height"] = float(meta.get("height", 1.0))
            if isinstance(meta.get("unified"), dict) and meta["unified"].get("version") == 2:
                entry["unified"] = meta["unified"]
            # bald bodies (blender/head_frame.py): where hair and beard pieces go, and the eyes
            head = meta.get("head")
            if isinstance(head, dict) and all(isinstance(head.get(k), (int, float)) for k in ("x", "y", "z", "depth")):
                entry["head"] = {k: round(float(head[k]), 5) for k in ("x", "y", "z", "depth")}
                if isinstance(head.get("neck"), (int, float)):
                    entry["head"]["neck"] = round(float(head["neck"]), 4)
                ring = neck_ring(head.get("ring"))
                if ring:
                    entry["neckRing"] = ring
            if isinstance(meta.get("skin"), list) and len(meta["skin"]) == 3:
                entry["skin"] = [round(float(c), 4) for c in meta["skin"]]
            eyes = meta.get("eyes")
            if isinstance(eyes, list) and len(eyes) == 2 and all(isinstance(e, list) and len(e) == 3 for e in eyes):
                entry["eyes"] = [[round(float(c), 5) for c in e] for e in eyes]
                entry["eyeR"] = round(float(meta.get("eye_r", 0.0105)), 5)
        if kind == "heads":
            # faces (blender/fit_head.py): iris centres + radius, throat line, skin colour — head-frame units
            eyes = meta.get("eyes")
            if isinstance(eyes, list) and len(eyes) == 2 and all(isinstance(e, list) and len(e) == 3 for e in eyes):
                entry["eyes"] = [[round(float(c), 4) for c in e] for e in eyes]
                entry["eyeR"] = round(float(meta.get("eye_r", 0.034)), 4)
            if isinstance(meta.get("neck"), (int, float)):
                entry["neck"] = round(float(meta["neck"]), 4)
            ring = neck_ring(meta.get("neck_ring"))
            if ring:
                entry["neckRing"] = ring
            if isinstance(meta.get("skin"), list) and len(meta["skin"]) == 3:
                entry["skin"] = [round(float(c), 4) for c in meta["skin"]]
        if kind == "mounts" and isinstance(meta.get("saddle"), list) and len(meta["saddle"]) == 3:
            entry["saddle"] = [round(float(x), 4) for x in meta["saddle"]]
        out[key] = entry
    return out


def walk_images(base):
    for dp, dn, fns in os.walk(base):
        dn.sort()
        for fn in sorted(fns):
            if fn.lower().endswith(IMG_EXT) and not fn.startswith("."):
                yield os.path.join(dp, fn)


def scan_textures(assets):
    out = {}
    tex = os.path.join(assets, "textures")
    if os.path.isdir(tex):
        for p in walk_images(tex):
            key = os.path.splitext(os.path.relpath(p, tex))[0].replace(os.sep, "/")
            if key.startswith("terrain/"):
                key = key[len("terrain/"):]
            # prefer jpg over png when both exist
            if key in out and not p.lower().endswith((".jpg", ".jpeg")):
                continue
            out[key] = rel(assets, p)
    ui = os.path.join(assets, "ui")
    if os.path.isdir(ui):
        for p in walk_images(ui):
            key = "ui/" + os.path.splitext(os.path.relpath(p, ui))[0].replace(os.sep, "/")
            out.setdefault(key, rel(assets, p))
    return out


def scan_icons(assets):
    out = {}
    d = os.path.join(assets, "icons")
    if os.path.isdir(d):
        for p in walk_images(d):
            r = os.path.relpath(p, d).replace(os.sep, "/")
            out[r] = rel(assets, p)
            out.setdefault(os.path.splitext(r)[0], rel(assets, p))
    return dict(sorted(out.items()))


def scan_portraits(assets):
    out = {}
    d = os.path.join(assets, "portraits")
    if os.path.isdir(d):
        for p in walk_images(d):
            out[os.path.splitext(os.path.relpath(p, d))[0].replace(os.sep, "/")] = rel(assets, p)
    return out


def main():
    args = sys.argv[1:]
    assets = os.path.join(ROOT, "game", "public", "assets")
    if "--assets" in args:
        assets = os.path.abspath(args[args.index("--assets") + 1])
    manifest = {k: scan_models(assets, k) for k in MODEL_KINDS}
    # Keep the original canonical key and all its appearance metadata, using the
    # repaired skirt skinning when present. Avoid preloading a duplicate unit.
    for key in ("human_f_robe", "human_f_heavy"):
        repaired = manifest["units"].pop(key + "_v2", None)
        if repaired and key in manifest["units"]:
            manifest["units"][key]["file"] = repaired["file"]
    # Authored character modules use the existing item loader/socket pipeline.
    manifest["items"].update(scan_models(assets, "characters"))
    manifest["textures"] = scan_textures(assets)
    manifest["icons"] = scan_icons(assets)
    manifest["portraits"] = scan_portraits(assets)
    path = os.path.join(assets, "manifest.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    os.replace(tmp, path)
    counts = ", ".join(f"{k} {len(v)}" for k, v in manifest.items())
    print(f"wrote {path}: {counts}")
    if "--check" in args:
        for k, ids in EXPECTED.items():
            miss = [i for i in ids if i not in manifest[k]]
            if miss:
                print(f"  missing {k}: {', '.join(miss)}")


if __name__ == "__main__":
    main()
