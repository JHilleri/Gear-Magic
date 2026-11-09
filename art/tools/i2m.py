#!/usr/bin/env python3
"""Batch image→3D with the TRELLIS.2 gallery template (local ComfyUI).

Usage: python3 tools/i2m.py <cat> [<cat> ...] [--only id1,id2] [--force]
  cat = src_units | src_items | src_mounts | src_monsters | src_buildings | src_props
Reads art/outputs/<cat>/<id>_alpha.png, writes art/outputs/3d/<cat-without-src_>/<id>.glb.
Slots are edited with `comfy workflow set-slot` on a per-job copy of the fetched template
(TRELLIS.2 mode, upsample 1024, 2048 textures). Resumable: existing GLBs are skipped.
"""
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(ROOT, "blueprints", "ref_trellis2_i2m.json")
JOBDIR = os.path.join(ROOT, "blueprints", "i2m_jobs")
COMFY = "http://127.0.0.1:8188"
COMFY_OUT = "/home/jeanh/ComfyUI-Shared/output"
COMFY_IN = "/home/jeanh/ComfyUI-Shared/input"

REMESH = {"src_units": 640, "src_buildings": 640}
FACES = {"src_units": 50000, "src_items": 20000, "src_mounts": 40000, "src_monsters": 40000, "src_buildings": 60000, "src_props": 25000}


def comfy(*args):
    r = subprocess.run(["comfy", "--json", *args], capture_output=True, text=True, cwd=ROOT)
    try:
        return json.loads(r.stdout)
    except Exception:
        raise RuntimeError(f"comfy {' '.join(args)} failed: {r.stdout[-500:]} {r.stderr[-500:]}")


def main():
    args = sys.argv[1:]
    force = "--force" in args
    only = set(args[args.index("--only") + 1].split(",")) if "--only" in args else None
    # --reseed N: shift every sampler seed of the template by N (re-roll a bad shape or texture bake)
    reseed = int(args[args.index("--reseed") + 1]) if "--reseed" in args else 0
    seeds = [f"{n}.seed={v + reseed}" for n, v in (("12", 43), ("18", 42), ("3", 56), ("23", 42))] if reseed else []
    cats = [a for a in args if a.startswith("src_")]
    os.makedirs(JOBDIR, exist_ok=True)
    pending = []
    for cat in cats:
        srcdir = os.path.join(ROOT, "outputs", cat)
        outdir = os.path.join(ROOT, "outputs", "3d", cat[4:])
        os.makedirs(outdir, exist_ok=True)
        for fn in sorted(os.listdir(srcdir)):
            if not fn.endswith("_alpha.png"):
                continue
            id_ = fn[: -len("_alpha.png")]
            if only and id_ not in only:
                continue
            dst = os.path.join(outdir, id_ + ".glb")
            if os.path.exists(dst) and not force:
                continue
            # Reuse a GLB ComfyUI already produced for this prefix (e.g. a run interrupted on our side).
            prev_dir = os.path.join(COMFY_OUT, "magic4x", "3d", cat)
            prev = sorted(f for f in os.listdir(prev_dir) if f.startswith(id_ + "_") and f.endswith(".glb")) if os.path.isdir(prev_dir) else []
            if prev and not force:
                shutil.copyfile(os.path.join(prev_dir, prev[-1]), dst)
                print("reused", cat, id_, flush=True)
                continue
            inname = f"m4x_{cat}_{id_}.png"
            shutil.copyfile(os.path.join(srcdir, fn), os.path.join(COMFY_IN, inname))
            wf = os.path.join(JOBDIR, f"{cat}_{id_}.json")
            shutil.copyfile(TEMPLATE, wf)
            prefix = f"magic4x/3d/{cat}/{id_}"
            res = comfy("workflow", "set-slot", wf, f'122.image="{inname}"', "316.value=true", "94.target_resolution=1024",
                        "288.value=1024", "224.resolution=1024", "233.resolution=512", "233.samples=32",
                        f"241.resolution={REMESH.get(cat, 512)}", f"186.target_face_count={FACES.get(cat, 40000)}", f'322.filename_prefix="{prefix}"', *seeds)
            if not res.get("ok"):
                print("set-slot failed", id_, res.get("error"), flush=True)
                continue
            run = comfy("run", "--workflow", wf, "--where", "local")
            if not run.get("ok"):
                print("submit failed", id_, run.get("error"), flush=True)
                continue
            pid = run["data"]["prompt_id"]
            pending.append((cat, id_, pid, dst, prefix))
            print("queued", cat, id_, pid, flush=True)
    t0 = time.time()
    while pending:
        time.sleep(5)
        still = []
        for cat, id_, pid, dst, prefix in pending:
            with urllib.request.urlopen(f"{COMFY}/history/{pid}", timeout=30) as r:
                h = json.loads(r.read())
            if pid not in h:
                still.append((cat, id_, pid, dst, prefix))
                continue
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                print("FAILED", cat, id_, json.dumps(st)[:600], flush=True)
                continue
            found = None
            for out in h[pid].get("outputs", {}).values():
                for key in ("3d", "result", "model_file", "meshes"):
                    pass
                blob = json.dumps(out)
                if prefix.split("/")[-1] in blob and ".glb" in blob:
                    found = True
            d = os.path.join(COMFY_OUT, os.path.dirname(prefix))
            cands = sorted([f for f in os.listdir(d) if f.startswith(id_ + "_") and f.endswith(".glb")]) if os.path.isdir(d) else []
            if cands:
                shutil.copyfile(os.path.join(d, cands[-1]), dst)
                print(f"done {cat}/{id_} t+{time.time()-t0:.0f}s", flush=True)
            else:
                print("NO GLB", cat, id_, flush=True)
        pending = still
    print("all done", flush=True)


if __name__ == "__main__":
    main()
