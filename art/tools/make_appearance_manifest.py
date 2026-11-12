#!/usr/bin/env python3
"""Writes art/manifests/appearance.json: the gendered human bodies, the hair / beard pieces and the faces.

    python3 tools/make_appearance_manifest.py
    python3 tools/gen.py manifests/appearance.json
    python3 tools/i2m.py src_units src_hair src_heads --only <ids>

Bodies (cat src_units, ids human_<m|f>_<body>) are bald and clean-shaven: the game puts a hair and a
beard piece on the head (render/units.ts).  The pieces (cat src_hair, ids hair_<style> /
beard_<style>) are modelled on a pure green faceless mannequin head, in pale blonde: blender/fit_hair.py
keys the green head out, registers the piece on a head, and greys it so the game can tint it.
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG = "centered with generous empty margins, on a plain flat light grey background, soft even studio lighting, clean 3D render"
CHAR = ("Full body stylized fantasy strategy game 3D character model with slightly chunky heroic proportions, "
        "standing in a strict T-pose with both arms straight out horizontally, palms down, open empty hands, legs slightly apart, "
        "front view at eye level, symmetrical, hand-painted PBR textures")
NEG3D = "text, watermark, logo, cropped, cut off, multiple objects, scenery, landscape, ground plane, shadow, frame, border"
NEGCHAR = NEG3D + ", weapon, holding objects, shield, sword, staff, bow, cape covering arms, extra limbs, sitting, hair, beard, stubble, moustache, hat, helmet, hood up"
HEAD = ("Stylized fantasy strategy game 3D asset, hand-painted textures: a smooth featureless bright pure green mannequin head with no face, "
        "no eyes, no nose, no mouth, {what}, the hair is pale platinum blonde, front view at eye level, symmetrical, head only, ")
NEGHEAD = NEG3D + ", face, eyes, lips, eyebrows, skin, shoulders, body, clothes, hat, ribbon, jewelry"

WHO = {
    "m": "a young human {job} man with a completely bald shaved head and a clean-shaven face",
    "f": "a young human {job} woman with a completely bald shaved head and a friendly face",
}
# the same outfits as the first human bodies (tools/make_manifests.py), cut for a man or a woman
BODIES = {
    "commoner": ("peasant", {
        "m": "wearing a simple tan linen tunic with a rope belt, grey wool trousers and brown leather boots",
        "f": "wearing a simple tan linen dress tunic with a rope belt, grey wool trousers and brown leather boots"}),
    "padded": ("militia soldier", {
        "m": "wearing a thick quilted padded gambeson in faded royal blue and cream with stitched diamond quilting, a brown leather belt, linen trousers and leather boots",
        "f": "wearing a fitted thick quilted padded gambeson in faded royal blue and cream with stitched diamond quilting, a brown leather belt, linen trousers and leather boots"}),
    "light": ("ranger", {
        "m": "wearing brown leather armor with a forest green hooded mantle down on the shoulders, leather bracers and tall boots",
        "f": "wearing fitted brown leather armor with a forest green hooded mantle down on the shoulders, leather bracers and tall boots"}),
    "heavy": ("knight", {
        "m": "in polished full steel plate armor with a royal blue tabard trimmed with gold, bare head with no helmet",
        "f": "in polished full steel plate armor shaped for a woman with a royal blue tabard trimmed with gold, bare head with no helmet"}),
    "robe": ("battle mage", {
        "m": "in flowing royal blue robes with gold embroidery and a wide leather belt with pouches, no hood",
        "f": "in flowing royal blue robes with gold embroidery and a wide leather belt with pouches, no hood"}),
}
HAIR = {
    "short": "wearing a wig of short tousled men's hair",
    "crop": "wearing a wig of very short cropped men's hair, a close military buzz cut covering the scalp",
    "swept": "wearing a wig of men's shoulder-length hair swept back from the forehead",
    "tail": "wearing a wig of men's hair pulled back tight into a short low ponytail at the nape",
    "curly": "wearing a wig of thick short curly hair",
    "long": "wearing a wig of long wavy women's hair falling to the shoulders",
    "braid": "wearing a wig of women's hair pulled back into one long thick braid hanging down the back",
    "bun": "wearing a wig of women's hair gathered up into a neat round bun at the back of the head",
    "bob": "wearing a wig of a women's chin-length bob haircut with a fringe",
    "ponytail": "wearing a wig of women's hair pulled back into a high ponytail",
    "pixie": "wearing a wig of a women's short pixie haircut",
}
BEARD = {
    "short": "bald smooth green scalp on top, with a glued-on short trimmed boxed beard and moustache made of pale platinum blonde hair along the jaw and chin",
    "full": "bald smooth green scalp on top, with a glued-on thick full beard and moustache made of pale platinum blonde hair covering the jaw and chin",
    "moustache": "bald smooth green scalp on top, with only a glued-on thick handlebar moustache made of pale platinum blonde hair under the nose, bare green chin",
    "goatee": "bald smooth green scalp on top, with only a glued-on pointed goatee and moustache made of pale platinum blonde hair around the mouth and chin, bare green cheeks",
    "long": "bald smooth green scalp on top, with a glued-on very long thick beard and moustache made of pale platinum blonde hair hanging down to the chest",
}

# Faces: a head of its own per face, far more detailed than the head of a full-body model (whose
# face is a few dozen texels).  Bald, pale grey eyes and light brows: the game tints the irises, puts
# the hair on, and hides the body's own head (blender/fit_head.py, render/appearance.ts).
FACE = ("Stylized fantasy strategy game 3D character head with slightly chunky heroic proportions, hand-painted PBR textures: "
        "the head and bare neck of {who}, fair skin, a completely bald shaved head, clean-shaven, neutral calm expression, closed mouth, "
        "pale grey eyes looking straight ahead, thin light brown eyebrows, front view at eye level, symmetrical, head and neck only, ")
NEGFACE = NEG3D + ", hair, beard, stubble, moustache, hat, helmet, hood, shoulders, clothes, collar, jewelry, earrings, makeup, teeth, open mouth, smile"
FACES = {
    "m1": "a young man with a square jaw and a straight nose",
    "m2": "a weathered middle-aged man with a broad face, a heavy brow and a slightly crooked nose",
    "m3": "a lean young man with a narrow face, sharp cheekbones and a long nose",
    "f1": "a young woman with a soft oval face and full cheeks",
    "f2": "a mature woman with an angular face, high cheekbones and a firm jaw",
    "f3": "a young woman with a heart-shaped face, a small upturned nose and light freckles",
}

jobs = []
seed = 300
for body, (job, cuts) in BODIES.items():
    for g in ("m", "f"):
        seed += 1
        jobs.append({"id": f"human_{g}_{body}", "cat": "src_units", "alpha": True, "seed": seed, "w": 896, "h": 1152,
                     "prompt": f"{CHAR} of {WHO[g].format(job=job)}, {cuts[g]}, {BG}", "negative": NEGCHAR})
for kind, table in (("hair", HAIR), ("beard", BEARD)):
    for k, what in table.items():
        seed += 1
        jobs.append({"id": f"{kind}_{k}", "cat": "src_hair", "alpha": True, "seed": seed, "w": 1024, "h": 1024,
                     "prompt": HEAD.format(what=what) + BG, "negative": NEGHEAD})
for k, who in FACES.items():
    seed += 1
    jobs.append({"id": f"head_{k}", "cat": "src_heads", "alpha": True, "seed": seed, "w": 1024, "h": 1024,
                 "prompt": FACE.format(who=who) + BG, "negative": NEGFACE})
json.dump(jobs, open(os.path.join(ROOT, "manifests", "appearance.json"), "w"), indent=1)
print("appearance", len(jobs))
