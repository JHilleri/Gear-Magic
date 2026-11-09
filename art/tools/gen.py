#!/usr/bin/env python3
"""Batch image generator for the local ComfyUI (Qwen Image 2.1 + optional BiRefNet alpha).

Usage:
    python3 tools/gen.py manifests/<name>.json [--only id1,id2] [--force]

Manifest format (JSON list):
    [{"id": "castle", "cat": "buildings", "prompt": "...", "negative": "...",
      "w": 1024, "h": 1024, "seed": 1, "alpha": true}]

Outputs land in art/outputs/<cat>/<id>.png (and <id>_alpha.png when alpha=true).
The job is skipped when its outputs already exist (resumable) unless --force.

The graph is authored here directly (9-12 nodes) because comfy-cli's subgraph
flattening of the gallery template drops the prompt wire into the prompt-enhancer
switch (the sampler then receives an empty prompt).
"""
import json
import os
import random
import shutil
import sys
import time
import urllib.request

COMFY = os.environ.get("COMFY_LOCAL_URL", "http://127.0.0.1:8188")
COMFY_OUT = "/home/jeanh/ComfyUI-Shared/output"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

UNET = "qwen_image_2.1_int8_convrot.safetensors"
CLIP = "qwen3vl_8b_int8_convrot.safetensors"
VAE = "qwen_image_2.1_vae_bf16.safetensors"


def graph(job):
    w, h = job.get("w", 1024), job.get("h", 1024)
    prefix = f"magic4x/{job['cat']}/{job['id']}"
    g = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "QwenImage21Cache", "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP, "type": "qwen_image", "device": "default"}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "5": {"class_type": "TextEncodeQwenImage21", "inputs": {
            "clip": ["3", 0], "prompt": job["prompt"], "negative_prompt": job.get("negative", ""),
            "resolution": 1024}},
        "6": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "7": {"class_type": "KSampler", "inputs": {
            "model": ["2", 0], "positive": ["5", 0], "negative": ["5", 1], "latent_image": ["6", 0],
            "seed": job.get("seed", random.randint(1, 2**31)), "steps": job.get("steps", 25),
            "cfg": job.get("cfg", 1.0), "sampler_name": "euler", "scheduler": "simple", "denoise": 1.0}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["4", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": prefix}},
    }
    if job.get("alpha"):
        g["10"] = {"class_type": "LoadBackgroundRemovalModel", "inputs": {"bg_removal_name": "birefnet.safetensors"}}
        g["11"] = {"class_type": "RemoveBackground", "inputs": {"bg_removal_model": ["10", 0], "image": ["8", 0]}}
        # JoinImageWithAlpha treats its input as an inverted (LoadImage-style) mask → invert first.
        g["14"] = {"class_type": "InvertMask", "inputs": {"mask": ["11", 0]}}
        g["12"] = {"class_type": "JoinImageWithAlpha", "inputs": {"image": ["8", 0], "alpha": ["14", 0]}}
        g["13"] = {"class_type": "SaveImage", "inputs": {"images": ["12", 0], "filename_prefix": prefix + "_alpha"}}
    return g


def post(path, data):
    req = urllib.request.Request(COMFY + path, data=json.dumps(data).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def get(path):
    with urllib.request.urlopen(COMFY + path, timeout=60) as r:
        return json.loads(r.read())


def outputs_exist(job):
    d = os.path.join(ROOT, "outputs", job["cat"])
    ok = os.path.exists(os.path.join(d, job["id"] + ".png"))
    if job.get("alpha"):
        ok = ok and os.path.exists(os.path.join(d, job["id"] + "_alpha.png"))
    return ok


def looks_blank(job):
    """A failed generation is a flat grey canvas: almost no colour and little contrast."""
    from PIL import Image, ImageStat
    path = os.path.join(ROOT, "outputs", job["cat"], job["id"] + ".png")
    im = Image.open(path).convert("RGB").resize((128, 128))
    sd = ImageStat.Stat(im).stddev
    hsv = Image.open(path).convert("HSV").resize((128, 128))
    sat = ImageStat.Stat(hsv).mean[1]
    return max(sd) < 24 and sat < 18


def collect(job, hist):
    d = os.path.join(ROOT, "outputs", job["cat"])
    os.makedirs(d, exist_ok=True)
    for node_id, out in hist.get("outputs", {}).items():
        for img in out.get("images", []):
            src = os.path.join(COMFY_OUT, img.get("subfolder", ""), img["filename"])
            name = job["id"] + ("_alpha" if "_alpha" in img["filename"] else "") + ".png"
            shutil.copyfile(src, os.path.join(d, name))


def main():
    args = sys.argv[1:]
    force = "--force" in args
    only = None
    if "--only" in args:
        only = set(args[args.index("--only") + 1].split(","))
    manifest = [a for a in args if a.endswith(".json")][0]
    jobs = json.load(open(manifest))
    # One prompt at a time: with this ComfyUI build, prompts queued back to back came out as blank grey
    # canvases after the first one. Each result is checked and retried (after freeing models) when blank.
    t0 = time.time()
    for job in jobs:
        if only and job["id"] not in only:
            continue
        if not force and outputs_exist(job):
            continue
        for attempt in range(3):
            res = post("/prompt", {"prompt": graph(job), "client_id": "magic4x-gen"})
            pid = res["prompt_id"]
            print("queued", job["cat"], job["id"], pid, f"(try {attempt + 1})" if attempt else "", flush=True)
            while True:
                time.sleep(3)
                h = get(f"/history/{pid}")
                if pid in h:
                    break
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                print("FAILED", job["id"], json.dumps(st)[:800], flush=True)
                break
            collect(job, h[pid])
            if not looks_blank(job):
                print(f"done {job['cat']}/{job['id']}  t+{time.time()-t0:.0f}s", flush=True)
                break
            print(f"BLANK {job['cat']}/{job['id']} -> freeing models and retrying", flush=True)
            try:
                post("/free", {"unload_models": True, "free_memory": True})
            except Exception:
                pass
            time.sleep(5)
    print("all done")


if __name__ == "__main__":
    main()
