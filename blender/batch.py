#!/usr/bin/env python3
"""Process every TRELLIS.2 model in art/outputs/3d/<category>/ into game/public/assets/models/.

    python3 blender/batch.py [CATEGORY ...] [--force] [--only id1,id2] [--jobs N] [--no-preview]
                             [--watch [MINUTES]]

CATEGORY is any of units, items, mounts, monsters, buildings, props (default: all; `--cats a,b` also works).
units     -> rig_humanoid.py   -> models/units/<id>.glb
items     -> process_static.py --kind item     -> models/items/<id>.glb
mounts    -> process_static.py --kind mount    -> models/mounts/<id>.glb   (saddle in <id>.meta.json)
monsters  -> process_static.py --kind monster  -> models/monsters/<id>.glb
buildings -> process_static.py --kind building -> models/buildings/<id>.glb
props     -> process_static.py --kind prop     -> models/props/<id>.glb
Previews go to art/outputs/processed/<category>/<id>.png, logs next to them.  Up-to-date outputs
(newer than their source and than the scripts) are skipped unless --force.  Sources still being
written (bad GLB length or modified < 5 s ago) are skipped and picked up by the next run.  Items run
first so unit previews can show the real weapons.  Each pass ends by rebuilding manifest.json.
--watch keeps polling every 30 s and processes models as they land, until every expected id of the
selected categories (art/tools/build_manifest.py EXPECTED) is processed or MINUTES (default 90) pass.
"""
import concurrent.futures as cf
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "art", "outputs", "3d")
OUT = os.path.join(ROOT, "game", "public", "assets", "models")
PREV = os.path.join(ROOT, "art", "outputs", "processed")
BLENDER = os.environ.get("BLENDER", "/snap/bin/blender")
# Render/bake threads per Blender process: full-core Cycles alongside GPU work has shut this machine down.
THREADS = os.environ.get("BLENDER_THREADS", "4")
ORDER = ["items", "mounts", "monsters", "buildings", "props", "units"]
KIND = {"items": "item", "mounts": "mount", "monsters": "monster", "buildings": "building", "props": "prop"}


def complete_glb(path):
    """True when the file is a whole GLB (header length matches) and has not changed for 5 s."""
    import struct
    try:
        if time.time() - os.path.getmtime(path) < 5:
            return False
        with open(path, "rb") as f:
            head = f.read(12)
        return head[:4] == b"glTF" and struct.unpack("<I", head[8:12])[0] == os.path.getsize(path)
    except OSError:
        return False


def scripts_mtime(cat):
    names = ["common.py"] + (["rig_humanoid.py", "rig_anim.py"] if cat == "units" else ["process_static.py"])
    return max(os.path.getmtime(os.path.join(HERE, n)) for n in names)


def job(cat, src, dst, preview):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    os.makedirs(os.path.join(PREV, cat), exist_ok=True)
    stem = os.path.splitext(os.path.basename(dst))[0]
    logp = os.path.join(PREV, cat, stem + ".log")
    if cat == "units":
        cmd = ["nice", "-n", "15", BLENDER, "-b", "-t", THREADS, "-P", os.path.join(HERE, "rig_humanoid.py"), "--", src, dst,
               "--items", os.path.join(OUT, "items")]
    else:
        cmd = ["nice", "-n", "15", BLENDER, "-b", "-t", THREADS, "-P", os.path.join(HERE, "process_static.py"), "--", src, dst, "--kind", KIND[cat], "--id", stem]
    if preview:
        cmd += ["--preview", os.path.join(PREV, cat, stem + ".png")]
    t0 = time.time()
    with open(logp, "w") as log:
        r = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT)
    ok = r.returncode == 0 and os.path.exists(dst) and os.path.getmtime(dst) >= t0 - 1
    text = open(logp, errors="replace").read()
    if "Traceback" in text:
        ok = False
    return cat, stem, ok, time.time() - t0, logp


def parse(a):
    opt = {"force": "--force" in a, "preview": "--no-preview" not in a, "only": None, "jobs": 1, "watch": None,
           "cats": []}
    i = 0
    while i < len(a):
        k = a[i]
        nxt = a[i + 1] if i + 1 < len(a) else None
        if k == "--only":
            opt["only"] = set(nxt.split(",")); i += 1
        elif k == "--cats":
            opt["cats"] += nxt.split(","); i += 1
        elif k == "--jobs":
            opt["jobs"] = int(nxt); i += 1
        elif k == "--watch":
            opt["watch"] = 90.0
            if nxt and not nxt.startswith("-") and nxt not in ORDER:
                opt["watch"] = float(nxt); i += 1
        elif k in ("--force", "--no-preview"):
            pass
        elif k in ORDER:
            opt["cats"].append(k)
        else:
            raise SystemExit(f"unknown argument {k!r}\n" + __doc__)
        i += 1
    opt["cats"] = opt["cats"] or list(ORDER)
    return opt


def find_todo(opt, done):
    """(todo, pending): models to (re)process now, and expected-or-present ids not processed yet."""
    todo, waiting = [], []
    for cat in ORDER:
        if cat not in opt["cats"]:
            continue
        d = os.path.join(SRC, cat)
        for fn in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if not fn.endswith(".glb"):
                continue
            stem = fn[:-4]
            if opt["only"] and stem not in opt["only"]:
                continue
            src = os.path.join(d, fn)
            dst = os.path.join(OUT, cat, fn)
            if not complete_glb(src):
                waiting.append(f"{cat}/{stem}")
                continue
            fresh = os.path.exists(dst) and os.path.getmtime(dst) > max(os.path.getmtime(src), scripts_mtime(cat))
            if (opt["force"] and (cat, stem) not in done) or not fresh:
                todo.append((cat, src, dst))
    return todo, waiting


def missing_expected(opt):
    sys.path.insert(0, os.path.join(ROOT, "art", "tools"))
    from build_manifest import EXPECTED
    miss = []
    for cat in opt["cats"]:
        for i in EXPECTED.get(cat, []):
            if opt["only"] and i not in opt["only"]:
                continue
            if not os.path.exists(os.path.join(OUT, cat, i + ".glb")):
                miss.append(f"{cat}/{i}")
    return miss


def run_pass(opt, todo, failed, done):
    print(f"{len(todo)} model(s) to process", flush=True)
    # items first (unit previews use them), the rest in parallel
    for phase in (["items"], [c for c in ORDER if c != "items"]):
        batch = [t for t in todo if t[0] in phase]
        with cf.ThreadPoolExecutor(max_workers=opt["jobs"]) as ex:
            for cat, stem, ok, dt, logp in ex.map(lambda t: job(*t, opt["preview"]), batch):
                print(f"{'ok  ' if ok else 'FAIL'} {cat}/{stem} {dt:.0f}s" + ("" if ok else f"  (see {logp})"), flush=True)
                done.add((cat, stem))
                if not ok:
                    failed[f"{cat}/{stem}"] = os.path.getmtime(os.path.join(SRC, cat, stem + ".glb"))
                else:
                    failed.pop(f"{cat}/{stem}", None)
    subprocess.run([sys.executable, os.path.join(ROOT, "art", "tools", "build_manifest.py"), "--check"])


def main():
    opt = parse(sys.argv[1:])
    failed, done = {}, set()     # failed: "cat/id" -> source mtime at the failure
    t_end = time.time() + 60 * (opt["watch"] or 0)
    while True:
        todo, waiting = find_todo(opt, done)
        # a model that failed is retried only once its source changes again
        todo = [t for t in todo if failed.get(f"{t[0]}/{os.path.basename(t[1])[:-4]}") != os.path.getmtime(t[1])]
        for w in waiting:
            print(f"skip {w}: source still being written or not a valid GLB", flush=True)
        if todo or opt["watch"] is None:
            run_pass(opt, todo, failed, done)
        if opt["watch"] is None:
            break
        miss = missing_expected(opt)
        if not miss and not waiting:
            print("watch: every expected model is processed", flush=True)
            break
        if time.time() > t_end:
            print("watch: timed out; still missing:", ", ".join(miss), flush=True)
            break
        time.sleep(30)
    if failed:
        print("failed:", ", ".join(sorted(failed)))
        sys.exit(1)


if __name__ == "__main__":
    main()
