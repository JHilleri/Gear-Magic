#!/usr/bin/env python3
"""Clear the pale T-shirt bust the image model draws under a head (art/outputs/src_heads/*_alpha.png).

    python3 tools/strip_bust.py outputs/src_heads/head_m1_alpha.png [...]

Pixels in the lower 45 % of the image that are bright and nearly grey (the shirt; skin is far more
saturated) become transparent, so the image-to-3D model spends its whole budget on the head and neck.
The original is kept next to it as <name>_alpha.orig.png.
"""
import colorsys
import os
import shutil
import sys

from PIL import Image

for path in sys.argv[1:]:
    orig = path[:-4] + ".orig.png"
    if not os.path.exists(orig):
        shutil.copyfile(path, orig)
    im = Image.open(orig).convert("RGBA")
    w, h = im.size
    px = im.load()
    n = 0
    for y in range(int(h * 0.55), h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            _, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
            if s < 0.075 and v > 0.55:
                px[x, y] = (r, g, b, 0)
                n += 1
    im.save(path)
    print(os.path.basename(path), "cleared", n)
