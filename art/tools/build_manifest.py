#!/usr/bin/env python3
"""Scan game/public/assets and write game/public/assets/manifest.json (format: ASSETS.md).

    python3 art/tools/build_manifest.py [--assets DIR] [--check]

* models/{units,items,mounts,buildings,props,monsters}/<key>.glb -> {"file": ...}; units also get
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
MODEL_KINDS = ("units", "items", "mounts", "buildings", "props", "monsters")

EXPECTED = {
    "units": [f"{r}_{b}" for r in ("human", "orc", "undead") for b in ("commoner", "light", "heavy", "robe", "leader")],
    "items": ["tools", "sword", "spear", "axe", "bow", "staff", "wand", "shield_human", "shield_orc", "shield_undead"],
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
