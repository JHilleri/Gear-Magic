#!/usr/bin/env python3
"""Invert the alpha channel of *_alpha.png files whose corners are opaque (generated before the InvertMask fix)."""
import sys, glob
from PIL import Image, ImageOps
for f in sys.argv[1:]:
    im = Image.open(f)
    if im.mode != "RGBA": continue
    a = im.getchannel("A")
    if a.getpixel((2, 2)) > 128:
        im.putalpha(ImageOps.invert(a)); im.save(f); print("fixed", f)
