#!/usr/bin/env python3
"""Contact sheet: python3 tools/sheet.py out.png img1 img2 ... [--h 360] [--cols N]"""
import sys
from PIL import Image, ImageDraw
args = sys.argv[1:]
h = 360; cols = None
if "--h" in args: i = args.index("--h"); h = int(args[i+1]); del args[i:i+2]
if "--cols" in args: i = args.index("--cols"); cols = int(args[i+1]); del args[i:i+2]
out, files = args[0], args[1:]
ims = []
for f in files:
    im = Image.open(f).convert("RGBA")
    bg = Image.new("RGBA", im.size, (200, 200, 205, 255)); bg.alpha_composite(im)
    w = int(im.width * h / im.height); ims.append((f.split("/")[-1], bg.convert("RGB").resize((w, h))))
cols = cols or len(ims)
rows = (len(ims) + cols - 1) // cols
cw = max(i.width for _, i in ims)
sheet = Image.new("RGB", (cw * cols, (h + 18) * rows), (30, 30, 34))
d = ImageDraw.Draw(sheet)
for k, (name, im) in enumerate(ims):
    x, y = (k % cols) * cw, (k // cols) * (h + 18)
    sheet.paste(im, (x + (cw - im.width) // 2, y))
    d.text((x + 4, y + h + 3), name, fill=(230, 230, 230))
sheet.save(out); print(out, sheet.size)
