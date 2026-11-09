#!/usr/bin/env python3
"""Writes art/manifests/*.json — the prompt list for every generated asset.
Run: python3 tools/make_manifests.py
"""
import json
import zlib
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "manifests")
os.makedirs(OUT, exist_ok=True)

BG = "centered with generous empty margins, on a plain flat light grey background, soft even studio lighting, clean 3D render"
STYLE = "stylized high-fantasy strategy game 3D asset, hand-painted PBR textures, chunky readable silhouette, rich but grounded colors"
CHAR = ("Full body stylized fantasy strategy game 3D character model with slightly chunky heroic proportions, "
        "standing in a strict T-pose with both arms straight out horizontally, palms down, open empty hands, legs slightly apart, "
        "front view at eye level, symmetrical, hand-painted PBR textures")
NEG3D = "text, watermark, logo, cropped, cut off, multiple objects, scenery, landscape, ground plane, shadow, frame, border"
NEGCHAR = NEG3D + ", weapon, holding objects, shield, sword, staff, bow, cape covering arms, extra limbs, sitting"

characters = {
    "human_commoner": "a young human peasant man with short brown hair, wearing a simple tan linen tunic with a rope belt, grey wool trousers and brown leather boots",
    "human_light": "a human ranger woman with a braided ponytail, wearing fitted brown leather armor with a forest green hooded mantle down on the shoulders, leather bracers and tall boots",
    "human_heavy": "a human knight in polished full steel plate armor with a royal blue tabard trimmed with gold, an open-faced steel helmet showing a stern bearded face",
    "human_robe": "a human battle mage man in flowing royal blue robes with gold embroidery and a wide leather belt with pouches, hood down, short silver beard",
    "human_leader": "a regal human queen commander in gilded silver plate armor with a short royal blue cape on her back, a slim golden crown on long auburn hair",
    "orc_commoner": "a muscular green-skinned orc laborer with small tusks and a black topknot, wearing a ragged brown hide tunic with a rope belt, bare arms, wrapped feet",
    "orc_light": "a lean green-skinned orc hunter with tusks and red war paint, wearing dark leather armor with fur shoulder pads and bone trinkets",
    "orc_heavy": "a hulking green-skinned orc warrior with tusks in heavy spiked dark iron plate armor with crimson cloth and a horned iron helmet",
    "orc_robe": "an old green-skinned orc shaman with tusks and white braided hair, wearing a tattered crimson hide robe with bone necklaces and feathers",
    "orc_leader": "a massive green-skinned orc warchief with big tusks in blackened iron armor with crimson fur mantle, skull shoulder guards and a horned iron crown",
    "undead_commoner": "a gaunt undead revenant laborer with pale grey-blue skin, sunken cheeks and faintly glowing violet eyes, wearing a tattered grey sackcloth tunic and rags",
    "undead_light": "a gaunt undead revenant scout with pale grey-blue skin and glowing violet eyes, wearing tattered dark leather armor and a ragged violet hood down on the shoulders",
    "undead_heavy": "an undead death knight in corroded black plate armor etched with glowing violet runes and a skull-faced black helmet",
    "undead_robe": "an undead necromancer with a pale skull-like face and glowing violet eyes, wearing a tattered violet and black robe decorated with small bones",
    "undead_leader": "a towering lich lord with a skeletal face and glowing violet eyes in ornate black and violet robes with gold trim and a tall jagged bone crown",
}

items = {
    "tools": ("a stylized builder's hammer with a wooden handle and a heavy iron head, standing vertically with the head at the top", "1:1"),
    "sword": ("a stylized fantasy iron longsword with a leather wrapped grip and a bronze crossguard, standing vertically with the blade pointing up", "9:16"),
    "spear": ("a stylized fantasy spear with a long ash wood shaft, a leaf-shaped steel spearhead and a blue cloth tassel, standing vertically with the tip pointing up", "9:16"),
    "axe": ("a stylized fantasy single-bladed war axe with a thick wooden haft wrapped in leather and a large crescent iron blade, standing vertically with the blade at the top", "9:16"),
    "bow": ("a stylized fantasy wooden recurve longbow with a leather grip and taut string, standing vertically, seen from the side so the curve of the limbs is visible", "9:16"),
    "staff": ("a stylized fantasy wizard staff of twisted dark wood topped with a large glowing blue aether crystal held by wooden roots, standing vertically", "9:16"),
    "wand": ("a short stylized fantasy magic wand of carved white wood with a gold band and a small violet crystal at the tip, standing vertically tip up", "1:1"),
    "shield_human": ("a stylized fantasy kite shield painted royal blue with a gold border and a gold crown emblem, front view, standing upright", "1:1"),
    "shield_orc": ("a stylized fantasy round wooden orc shield with crimson tribal paint, an iron rim and a central iron boss, front view, standing upright", "1:1"),
    "shield_undead": ("a stylized fantasy black iron heater shield with jagged spikes on the rim and glowing violet runes, front view, standing upright", "1:1"),
}

mounts = {
    "horse": "a sturdy brown warhorse wearing a royal blue caparison with gold trim and a leather saddle, standing on four legs, three-quarter front view at eye level, full body",
    "wolf": "a huge grey dire wolf with a crimson leather saddle and bone decorations, standing on four legs, three-quarter front view at eye level, full body",
    "nightmare": "a skeletal undead black horse with tattered violet barding, glowing violet eyes and a dark leather saddle, standing on four legs, three-quarter front view at eye level, full body",
}

monsters = {
    "wolf": "a lean grey wild wolf with shaggy fur, snarling, standing on four legs, three-quarter front view at eye level, full body",
    "spider": "a giant dark brown forest spider with hairy legs and a bulbous abdomen with orange markings, standing, three-quarter front view at eye level, full body",
    "golem": "a hulking ancient stone golem made of mossy carved blocks with glowing cyan rune cracks, standing upright with heavy arms down, front view at eye level, full body",
}

B3 = "front three-quarter view at a low eye-level angle, the whole building visible, isolated with no surrounding ground"
buildings = {
    "castle_valen": "a compact medieval fantasy human castle with grey stone walls, two round towers with royal blue conical roofs, blue and gold banners and a wooden gate",
    "castle_thorn": "a compact orc stronghold fortress built of dark logs and rough stone, spiked palisade walls, crimson war banners, a central wooden tower with skulls and horns",
    "castle_ashen": "a compact gothic undead necropolis fortress of black stone with pointed spires, violet glowing windows, bone decorations and tattered violet banners",
    "house": "a cosy medieval fantasy cottage with whitewashed timber-framed walls, a thatched straw roof, a small chimney and a wooden door",
    "farm": "a small medieval fantasy farmstead with a red wooden barn, a hay stack, a fenced patch of golden wheat and a few crops",
    "lumber": "a medieval fantasy lumber camp with a small log cabin, a pile of stacked logs, a large tree stump with an axe and a sawhorse",
    "quarry": "a medieval fantasy stone quarry with cut grey stone blocks, a wooden crane with rope and pulley and a pile of rubble",
    "forge": "a medieval fantasy blacksmith forge with a stone chimney, a glowing furnace, an anvil under a wooden awning and weapon racks",
    "training": "a medieval fantasy training ground with straw practice dummies, a wooden weapon rack with spears and a circular wooden fence",
    "mine": "a medieval fantasy iron mine entrance carved into a rocky outcrop with a wooden support frame, a mine cart on rails full of iron ore",
    "crystalmine": "a fantasy crystal mine with a wooden scaffold and mine cart beside large glowing violet and blue aether crystals growing from rock",
    "library": "a medieval fantasy stone library hall with tall arched windows, a dark blue tiled roof, a small dome and stacks of books by the door",
    "magetower": "a slender fantasy wizard tower of pale stone with a spiral of blue tiles, a pointed roof and a large glowing blue crystal floating above the top",
    "wall": "a short straight segment of fortified medieval stone wall with crenellations and a small square tower in the middle",
    "watchtower": "a tall wooden medieval watchtower on stilts with a stone base, a lookout platform with a small roof and a signal brazier",
    "shrine": "a small fantasy stone shrine with four white pillars, a domed roof and a glowing golden crystal on an altar in the center",
}

props = {
    "pine": "a single stylized tall pine tree with layered dark green foliage and a brown trunk",
    "oak": "a single stylized round oak tree with a lush green rounded canopy and a thick brown trunk",
    "deadtree": "a single stylized dead swamp tree with a twisted bare grey trunk and drooping moss",
    "rock": "a cluster of three stylized grey boulders with a little moss",
    "peak": "a single stylized jagged grey mountain peak rock formation with a white snow cap",
    "crystal": "a cluster of stylized glowing violet and blue aether crystals growing out of a small rock",
    "bush": "a single stylized round green shrub with a few small flowers",
    "ruin": "stylized ancient ruins: two broken marble pillars, a fallen arch and scattered carved stones with ivy",
}

jobs3d = []
seed = 100
for k, v in characters.items():
    seed += 1
    jobs3d.append({"id": k, "cat": "src_units", "alpha": True, "seed": seed, "w": 896, "h": 1152,
                   "prompt": f"{CHAR} of {v}, {BG}", "negative": NEGCHAR})
for k, (v, ar) in items.items():
    seed += 1
    w, h = (768, 1344) if ar == "9:16" else (1024, 1024)
    jobs3d.append({"id": k, "cat": "src_items", "alpha": True, "seed": seed, "w": w, "h": h,
                   "prompt": f"A single isolated {STYLE} of {v}, full length visible, {BG}", "negative": NEG3D + ", hands, person"})
for k, v in mounts.items():
    seed += 1
    jobs3d.append({"id": k, "cat": "src_mounts", "alpha": True, "seed": seed, "w": 1152, "h": 896,
                   "prompt": f"A single isolated {STYLE} of {v}, no rider, {BG}", "negative": NEG3D + ", rider, person"})
for k, v in monsters.items():
    seed += 1
    jobs3d.append({"id": k, "cat": "src_monsters", "alpha": True, "seed": seed, "w": 1024, "h": 1024,
                   "prompt": f"A single isolated {STYLE} of {v}, {BG}", "negative": NEG3D})
for k, v in buildings.items():
    seed += 1
    jobs3d.append({"id": k, "cat": "src_buildings", "alpha": True, "seed": seed, "w": 1024, "h": 1024,
                   "prompt": f"A single isolated {STYLE} of {v}, {B3}, {BG}", "negative": NEG3D + ", people, characters"})
for k, v in props.items():
    seed += 1
    jobs3d.append({"id": k, "cat": "src_props", "alpha": True, "seed": seed, "w": 1024, "h": 1024,
                   "prompt": f"A single isolated {STYLE} of {v}, front view at eye level, {BG}", "negative": NEG3D})

json.dump(jobs3d, open(os.path.join(OUT, "src3d.json"), "w"), indent=1)
print("src3d", len(jobs3d))

# ───────────────────────── 2D ─────────────────────────
ICON = ("A painted fantasy RPG inventory icon of {x}, single centered object filling most of the frame, bold clean silhouette, "
        "rich saturated colors, soft rim light, dark {bg} radial vignette background, digital painting, crisp details, no text, no border")
NEGICON = "text, letters, watermark, frame, border, multiple objects, photo, blurry"


def icon(cat, id_, x, bg="slate blue", seed=None):
    return {"id": id_, "cat": cat, "alpha": False, "seed": seed or (zlib.crc32((cat + id_).encode()) % 100000), "w": 1024, "h": 1024, "steps": 22,
            "prompt": ICON.format(x=x, bg=bg), "negative": NEGICON}


icons = []
res = {
    "gold": "a small pile of shiny gold coins", "food": "a loaf of bread with a wheat sheaf and a red apple",
    "wood": "a bundle of chopped wooden logs tied with rope", "stone": "a stack of cut grey stone blocks",
    "iron": "a few dark iron ingots stacked", "crystal": "a glowing violet aether crystal shard",
    "mana": "a swirling blue magical energy orb", "research": "an open ancient book with a glowing rune and a quill",
}
for k, v in res.items():
    icons.append(icon("icons_resources", k, v, "deep brown"))
itm = {
    "tools": "a builder's hammer crossed with a hand saw", "sword": "an iron longsword with a bronze crossguard",
    "spear": "a spear with a leaf-shaped steel head and a blue tassel", "axe": "a single-bladed iron war axe",
    "bow": "a wooden recurve longbow with an arrow", "staff": "a twisted wooden wizard staff topped with a glowing blue crystal",
    "wand": "a carved white magic wand with a violet crystal tip", "shield": "a royal blue kite shield with a gold border",
    "tunic": "a quilted padded cloth tunic", "leather": "a brown hardened leather chest armor",
    "plate": "a polished steel plate breastplate with pauldrons", "robe": "a royal blue mage robe with gold runes",
    "amulet": "a golden amulet with a glowing red gem on a chain", "ring": "a silver ring with a glowing blue gem",
    "horse": "a saddled warhorse head with a blue caparison",
}
for k, v in itm.items():
    icons.append(icon("icons_items", k, v, "charcoal"))
bld = {
    "castle": "a small stone castle with blue roofs", "house": "a thatched roof cottage", "farm": "a red barn with wheat",
    "lumber": "stacked logs and an axe in a stump", "quarry": "cut stone blocks and a pickaxe", "forge": "an anvil with a glowing hot sword",
    "training": "a straw training dummy with a wooden sword", "mine": "a mine cart full of iron ore", "crystalmine": "glowing crystals in a mine cart",
    "library": "a tall bookshelf with scrolls and candles", "magetower": "a slender wizard tower with a floating crystal",
    "wall": "a crenellated stone wall section", "watchtower": "a wooden watchtower with a brazier", "shrine": "a small domed white shrine with a golden glow",
}
for k, v in bld.items():
    icons.append(icon("icons_buildings", k, v, "dark green"))
skills = {
    "regeneration": "a glowing green heart with leaves", "poison": "a dagger dripping green venom", "skirmisher": "two crossed daggers with motion swirls",
    "pathfinder": "a leather boot on a winding trail with a compass", "ironskin": "a forearm covered in iron scales", "leadership": "a raised war banner",
    "harvester": "a golden sickle with wheat", "prospector": "a pickaxe striking an iron vein", "manaspring": "a fountain of blue glowing water",
    "scholar": "a stack of books with spectacles", "marksman": "an arrow hitting the center of a target", "berserker": "a roaring red face with flames",
    "vampiric": "a red blood drop with fangs", "inspiring": "a golden trumpet with rays of light",
    "powerstrike": "a sword strike with a burst of orange energy", "volley": "many arrows raining from the sky", "heal": "a glowing hand with green healing light",
    "firebolt": "a blazing bolt of fire", "rally": "a war horn with golden sound waves", "fortify": "a glowing blue shield bubble",
    "blink": "a swirling violet teleport portal", "masonry": "a mason's trowel and a stone brick", "devotion": "praying hands with a golden halo",
    "stat_str": "a flexing muscular arm", "stat_dex": "a feathered arrow and a quiver", "stat_int": "a glowing blue brain-like rune crystal",
    "stat_hp": "a large red heart", "stat_armor": "a steel breastplate with a shield", "stat_mov": "a winged boot", "stat_vis": "an eye with golden rays",
    "eff_attack": "two crossed swords glowing", "eff_ranged": "a hawk eye with a crosshair", "eff_magic": "a magic orb wreathed in runes",
    "eff_farming": "a sprouting seedling in rich soil", "eff_building": "a hammer and a blueprint scroll", "eff_mining": "a glowing pickaxe",
    "eff_gathering": "an axe in a tree trunk with leaves", "eff_mana": "a blue mana potion bottle", "eff_research": "a glowing magnifying glass over a scroll",
    "eff_trade": "a balance scale with coins",
}
for k, v in skills.items():
    icons.append(icon("icons_skills", k, v, "deep purple"))
techs = {
    "mining": "a pickaxe and lantern", "writing": "a quill and ink pot on parchment", "croprotation": "three fields of different crops",
    "masonry": "a stone arch with a chisel", "architecture": "a compass and building blueprint", "guilds": "a guild hall sign with coins",
    "scholarship": "a graduate cap on books", "grandarchitecture": "a grand cathedral with golden light", "tanning": "a stretched animal hide on a frame",
    "polearms": "a spear and a halberd crossed", "shieldcraft": "a shield being hammered on an anvil", "platesmithing": "a steel helmet on an anvil",
    "horsemanship": "a saddle and horseshoe", "tactics": "a war map with chess pieces", "crystallore": "a crystal under a magnifying lens",
    "arcana": "a glowing arcane tome with floating runes", "wandcraft": "a wand being carved with sparks", "jewelcraft": "a jeweler's loupe and gems",
}
for k, v in techs.items():
    icons.append(icon("icons_techs", k, v, "dark teal"))
spells = {
    "heal": "radiant golden healing light descending", "bless": "a glowing golden blessing sigil over a sword", "fireball": "a roaring fireball",
    "haste": "a glowing winged hourglass", "farsight": "a crystal ball showing a distant land", "summon": "a stone elemental rising from the ground",
    "storm": "a violent purple lightning storm",
}
for k, v in spells.items():
    icons.append(icon("icons_spells", k, v, "midnight blue"))
emblems = {
    "valen": "a heraldic royal blue shield emblem with a gold crown and silver river", "thorn": "a heraldic crimson shield emblem with a black wolf skull and thorns",
    "ashen": "a heraldic violet and black shield emblem with a glowing skull and ash", "neutral": "a grey stone emblem with a beast claw mark",
}
for k, v in emblems.items():
    icons.append(icon("icons_emblems", k, v, "black"))
json.dump(icons, open(os.path.join(OUT, "icons.json"), "w"), indent=1)
print("icons", len(icons))

# portraits
PORTRAIT = ("A painted fantasy strategy game character portrait of {x}, head and shoulders, three-quarter view, dramatic warm key light, "
            "{bg} painterly background, detailed digital painting, rich colors, no text, no border")
port = []
pbg = {"human": "soft blue and gold", "orc": "smoky crimson and brown", "undead": "misty violet and grey"}
for k, v in characters.items():
    race = k.split("_")[0]
    port.append({"id": k, "cat": "portraits", "alpha": False, "seed": zlib.crc32(("p" + k).encode()) % 100000, "w": 832, "h": 1024, "steps": 25,
                 "prompt": PORTRAIT.format(x=v, bg=pbg[race]), "negative": NEGICON})
for k, v in monsters.items():
    port.append({"id": "monster_" + k, "cat": "portraits", "alpha": False, "seed": zlib.crc32(("m" + k).encode()) % 100000, "w": 832, "h": 1024, "steps": 25,
                 "prompt": PORTRAIT.format(x=v.split(", standing")[0].split(", snarling")[0], bg="dark forest green"), "negative": NEGICON})
port.append({"id": "monster_elemental", "cat": "portraits", "alpha": False, "seed": 777, "w": 832, "h": 1024, "steps": 25,
             "prompt": PORTRAIT.format(x="a stone earth elemental with glowing amber cracks", bg="dusty amber"), "negative": NEGICON})
json.dump(port, open(os.path.join(OUT, "portraits.json"), "w"), indent=1)
print("portraits", len(port))

# terrain textures
TEX = ("A seamless tileable top-down texture of {x}, viewed straight from above, flat even diffuse lighting without shadows, "
       "uniform density across the whole image, stylized hand-painted fantasy game ground texture, high detail")
tex = {
    "grass": "lush green meadow grass with tiny clover and a few small flowers", "plains": "dry golden yellow grass and patches of dirt",
    "forest": "forest floor with moss, fallen pine needles, leaves and small twigs", "hills": "grassy rocky hillside soil with small stones and short grass",
    "rock": "rough grey mountain rock with cracks and lichen", "swamp": "dark muddy swamp ground with puddles, moss and reeds debris",
    "sand": "wet beach sand with tiny pebbles", "crystal": "dark violet-tinted soil with small glowing violet crystal shards and pebbles",
    "snow": "fresh white snow with subtle blue shadows", "dirt": "packed brown dirt path with small stones",
}
texj = [{"id": k, "cat": "textures", "alpha": False, "seed": zlib.crc32(("t" + k).encode()) % 100000, "w": 1024, "h": 1024, "steps": 25,
         "prompt": TEX.format(x=v), "negative": "objects, perspective, horizon, text, watermark, vignette, shadows, border"} for k, v in tex.items()]
json.dump(texj, open(os.path.join(OUT, "textures.json"), "w"), indent=1)
print("textures", len(texj))

# key art
art = [
    {"id": "menu_bg", "cat": "ui", "alpha": False, "seed": 4242, "w": 1664, "h": 928, "steps": 28,
     "prompt": ("Epic painted fantasy key art of a sweeping region at golden hour seen from a hilltop: a river valley with a stone castle with blue roofs on the left, "
                "dark forests and misty hills, an orc war camp with crimson banners in the far right distance, a gothic violet-lit necropolis on a dark mountain on the horizon, "
                "glowing aether crystals in the foreground meadow, dramatic clouds and god rays, rich cinematic colors, detailed digital matte painting, no text"),
     "negative": "text, letters, watermark, logo, border"},
    {"id": "victory", "cat": "ui", "alpha": False, "seed": 5151, "w": 1664, "h": 928, "steps": 28,
     "prompt": "Painted fantasy illustration of a victorious army raising banners on a castle wall at sunrise, golden light, cheering soldiers silhouettes, triumphant mood, detailed digital painting, no text",
     "negative": "text, letters, watermark, logo, border"},
    {"id": "defeat", "cat": "ui", "alpha": False, "seed": 6161, "w": 1664, "h": 928, "steps": 28,
     "prompt": "Painted fantasy illustration of a fallen crown lying on a muddy battlefield in the rain at dusk, broken banners and smoke, somber blue grey mood, detailed digital painting, no text",
     "negative": "text, letters, watermark, logo, border"},
    {"id": "parchment", "cat": "ui", "alpha": False, "seed": 7171, "w": 1024, "h": 1024, "steps": 22,
     "prompt": "A seamless tileable texture of aged warm parchment paper with subtle fibers and faint stains, flat even lighting, viewed straight on, no text",
     "negative": "text, letters, writing, objects, border, vignette"},
]
json.dump(art, open(os.path.join(OUT, "ui.json"), "w"), indent=1)
print("ui", len(art))
