#!/usr/bin/env python3
"""Export generated 2D art into game/public/assets.

  icons_<sub>/<id>.png  → icons/<sub>/<id>.png   (256², slight sharpen)
  portraits/<id>.png    → portraits/<id>.png     (416×512)
  textures/<id>.png     → textures/terrain/<id>.jpg (1024², made seamless)
  ui/menu_bg|victory|defeat → ui/<id>.jpg (1920 wide); ui/parchment → ui/parchment.jpg (seamless 512²)

Usage: python3 tools/export2d.py [icons|portraits|textures|ui ...]   (default: all)
"""
import os
import sys

import random

from PIL import Image, ImageChops, ImageEnhance, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.path.dirname(ROOT), "game", "public", "assets")
SRC = os.path.join(ROOT, "outputs")


def seamless(im: Image.Image, falloff: float = 0.28) -> Image.Image:
    """Blend the image with its half-rolled copy so the result tiles without seams (pure PIL)."""
    a = im.convert("RGB")
    w, h = a.size
    b = ImageChops.offset(a, w // 2, h // 2)
    rnd = random.Random(7)
    noise = Image.new("L", (16, 16))
    noise.putdata([rnd.randrange(256) for _ in range(256)])
    noise = noise.resize((w, h), Image.BICUBIC)
    npx = noise.load()
    mask = Image.new("L", (w, h))
    mpx = mask.load()
    for y in range(h):
        fy = y / (h - 1)
        dy = min(fy, 1 - fy)
        for x in range(w):
            fx = x / (w - 1)
            d = min(dy, fx, 1 - fx) + (npx[x, y] / 255.0 - 0.5) * 0.12
            t = 0.0 if d <= 0 else (1.0 if d >= falloff else d / falloff)
            mpx[x, y] = int(255 * t * t * (3 - 2 * t))
    return Image.composite(a, b, mask)


def export_icons():
    n = 0
    for d in sorted(os.listdir(SRC)):
        if not d.startswith("icons_"):
            continue
        sub = d[len("icons_"):]
        os.makedirs(os.path.join(OUT, "icons", sub), exist_ok=True)
        for f in os.listdir(os.path.join(SRC, d)):
            if not f.endswith(".png") or f.endswith("_alpha.png"):
                continue
            im = Image.open(os.path.join(SRC, d, f)).convert("RGB").resize((256, 256), Image.LANCZOS)
            im = im.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))
            im.save(os.path.join(OUT, "icons", sub, f), optimize=True)
            n += 1
    print("icons", n)


def export_portraits():
    os.makedirs(os.path.join(OUT, "portraits"), exist_ok=True)
    n = 0
    d = os.path.join(SRC, "portraits")
    for f in os.listdir(d) if os.path.isdir(d) else []:
        if f.endswith(".png"):
            Image.open(os.path.join(d, f)).convert("RGB").resize((416, 512), Image.LANCZOS).save(os.path.join(OUT, "portraits", f), optimize=True)
            n += 1
    print("portraits", n)


# (saturation, brightness, contrast) grade per terrain texture so the palette reads natural together.
GRADE = {
    "grass": (0.58, 0.80, 1.0), "plains": (0.78, 0.76, 1.08), "crystal": (0.85, 1.45, 1.05), "dirt": (0.72, 0.95, 1.0),
    "swamp": (0.9, 1.3, 1.05), "sand": (0.8, 1.0, 1.0), "forest": (0.9, 1.0, 1.0), "hills": (0.9, 1.0, 1.0),
    "rock": (1.0, 1.0, 1.0), "snow": (0.8, 0.96, 1.0),
}


def grade(im: Image.Image, key: str) -> Image.Image:
    sat, bri, con = GRADE.get(key, (1.0, 1.0, 1.0))
    im = ImageEnhance.Color(im).enhance(sat)
    im = ImageEnhance.Brightness(im).enhance(bri)
    return ImageEnhance.Contrast(im).enhance(con)


def export_textures():
    os.makedirs(os.path.join(OUT, "textures", "terrain"), exist_ok=True)
    n = 0
    d = os.path.join(SRC, "textures")
    for f in os.listdir(d) if os.path.isdir(d) else []:
        if f.endswith(".png"):
            im = grade(seamless(Image.open(os.path.join(d, f))), f[:-4])
            im.save(os.path.join(OUT, "textures", "terrain", f[:-4] + ".jpg"), quality=90)
            n += 1
    print("textures", n)


def export_ui():
    os.makedirs(os.path.join(OUT, "ui"), exist_ok=True)
    d = os.path.join(SRC, "ui")
    for f in os.listdir(d) if os.path.isdir(d) else []:
        if not f.endswith(".png"):
            continue
        im = Image.open(os.path.join(d, f)).convert("RGB")
        name = f[:-4]
        if name == "parchment":
            seamless(im).resize((512, 512), Image.LANCZOS).save(os.path.join(OUT, "ui", "parchment.jpg"), quality=88)
        else:
            w = 1920
            im.resize((w, int(im.height * w / im.width)), Image.LANCZOS).save(os.path.join(OUT, "ui", name + ".jpg"), quality=88)
    print("ui done")


if __name__ == "__main__":
    which = sys.argv[1:] or ["icons", "portraits", "textures", "ui"]
    for w in which:
        globals()["export_" + w]()
