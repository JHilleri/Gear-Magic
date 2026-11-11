#!/usr/bin/env python3
"""Waveform contact sheet of the exported game audio (one row per sound, one cell per take)."""
import json, os, subprocess, sys
from PIL import Image, ImageDraw
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUD = os.path.join(os.path.dirname(ROOT), "game", "public", "assets", "audio")
TMP = os.path.join(ROOT, "outputs", "audio", "wave")
W, H, LABEL = 200, 46, 110
m = json.load(open(os.path.join(AUD, "audio.json")))
rows = list(m["sfx"].items())
cols = max(len(v) for _, v in rows)
sheet = Image.new("RGB", (LABEL + cols * (W + 4), len(rows) * (H + 4)), (20, 20, 24))
d = ImageDraw.Draw(sheet)
for r, (name, files) in enumerate(rows):
    y = r * (H + 4)
    d.text((4, y + 16), name, fill=(230, 230, 230))
    for c, rel in enumerate(files):
        png = os.path.join(TMP, rel.replace("/", "_") + ".png")
        # fixed 3 s time axis so lengths are comparable (pad shorter clips with silence)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", os.path.join(AUD, rel), "-af", "apad=whole_dur=3,atrim=0:3",
                        "-filter_complex", f"showwavespic=s={W}x{H}:split_channels=0:colors=0x55ddff:scale=sqrt",
                        "-frames:v", "1", png], check=True)
        sheet.paste(Image.open(png).convert("RGB"), (LABEL + c * (W + 4), y))
out = os.path.join(ROOT, "outputs", "audio", "sfx_sheet.png")
sheet.save(out)
print(out, sheet.size)
