# Aether & Iron — Game Design & Technical Spec

A small-scale, turn-based 4X with magic, built from `concept.md`. Inspirations: Battle for
Wesnoth (hex tactics, terrain defense, retaliation, leaders), Millennia (economy of
buildings on tiles). Each hex is the size of one building: the map is a *region*.

This document is the contract every module is built against. `game/src/core/types.ts`
is its code form; `game/src/data/*` holds the balance numbers.

---------------------------------------------------------------------------------------------

## 1. Pillars

1. **Units are not fixed classes.** Everyone starts as a Commoner. Equipment (tools,
   weapons, armor, trinkets, mounts) defines what a unit *can do*; levels define what it
   is *good at*. Presets are a convenience to recruit a pre-equipped unit.
2. **Visible equipment.** What a unit carries is what you see on the 3D model: the
   weapon in its hand, shield on its arm, the body armor model, the mount under it, a
   glowing trinket.
3. **Every hex matters.** One building per hex, terrain defense per hex, territory per
   building.
4. **Leaders are everything.** Lose your leader, lose the game. Kill every enemy leader,
   win.

## 2. Factions

| id | Name | Race | Colors | Flavor |
|---|---|---|---|---|
| `valen` | House Valen | human | royal blue `#2f6fd6` + gold `#e8c35a` | Player default. Knights, archers, battle-mages. House bonus: +10% ranged. |
| `thorn` | Thornwild Clans | orc | crimson `#c8342b` + bone `#d9c9a3` | Brutes, axes, wolves. House bonus: +10% melee. |
| `ashen` | Ashen Covenant | undead | violet `#8a4fd6` + ash `#9aa0a6` | Revenants, necromancy. House bonus: +10% magic, 0.5 food upkeep per unit. |
| `neutral` | Wilds | monsters | grey | Wolves, golems, spiders around ruins. Not a player. |

The human player picks a faction in the main menu (default Valen) and the number of AI
opponents (1–2; default 2). Each faction starts with: Leader (lv 2) + 2 Commoners (one
with Builder's Tools), a Castle on the start hex, 1 Farm, 1 House, and resources
`gold 60, food 30, wood 25, stone 15, iron 12, crystal 0, mana 0` — enough iron for a forge
plus a first sword, or a couple of builders, before the first Iron Mine. Each house also starts
knowing its signature tech (`startingTechs`): Valen Tanning (archers from turn 1), Thorn Polearms
(spears and war axes), Ashen Crystal Lore (crystal mines). House bonuses apply to every
controller, player or AI.

## 3. Map

* Pointy-top hexes, axial coordinates `(q, r)`; map stored as an "odd-r" offset
  rectangle of `W × H` (default 34 × 26, small 26 × 20, large 42 × 32).
* World space: hex radius `HEX_SIZE = 1.0` (center→corner). `x = √3·(q + r/2)`, `z = 1.5·r`.
  Y is up.
* Terrain types (`TerrainId`):

| id | move cost | defense % | height | notes |
|---|---|---|---|---|
| `grass` | 1 | 40 | 0.0 | fertile → farm +1 food |
| `plains` | 1 | 40 | 0.0 | dry grass |
| `forest` | 2 | 50 | 0.05 | wood; lumber camp |
| `hills` | 2 | 50 | 0.35 | stone; quarry; mine if iron |
| `mountain` | 3 | 60 | 1.1 | impassable to mounted units; iron/crystal deposits |
| `swamp` | 3 | 20 | -0.05 | |
| `shallows` | 3 | 20 | -0.18 | ford; no buildings |
| `water` | ∞ | — | -0.35 | impassable lake |
| `crystal` | 1 | 40 | 0.05 | crystal field: crystal deposit always |
| `ruins` | 1 | 60 | 0.05 | first visit: explore XP + loot; neutral monsters spawn nearby |

* Deposits (`DepositId`): `iron` (hills/mountain), `crystal` (crystal/mountain),
  `stone` (hills), `fertile` (grass/plains). A deposit is shown as a prop on the tile.
* Generation (`sim/mapgen.ts`): seeded value-noise height + moisture → terrain; lakes
  where height is low; mountain ridges; 1–2 crystal fields per quadrant; 6–10 ruins.
  Start positions: spread as far apart as possible on `grass|plains`, each with ≥1
  forest, ≥1 hills, ≥1 iron within radius 5. All starts connected by passable tiles
  (flood fill; carve passes through mountains if needed).

## 4. Units

### 4.1 Stats (`UnitStats`)
`maxHp, str (melee), dex (ranged), int (magic), armor (% damage reduction, 0–70),
mov (movement points), vis (vision radius)`.

Commoner base: `maxHp 22, str 4, dex 4, int 3, armor 0, mov 5, vis 4`.
Leader base:  `maxHp 34, str 6, dex 5, int 5, armor 10, mov 5, vis 5`, starts level 2.

Race modifiers (added to base stats, `data/factions.ts` `statMods`): human +1 dex; orc +4 maxHp,
+1 str, −1 int; undead +2 int, +5 armor (armor is already a % reduction, so +5 points). House
damage multipliers: valen ×1.1 ranged (`rangedMult`), thorn ×1.1 melee (`meleeMult`), ashen ×1.1
magic (`magicMult`) and 0.5 food upkeep.

Effective stats (`effectiveStats` in `sim/units.ts`) = `unit.base` + equipment stats (not for
monsters) + Iron Skin (+8 armor) + armor buffs (Bless, Fortify), then the clamps (armor 0–70,
mov/maxHp/vis ≥ 1, str/dex/int ≥ 0). `statBreakdown(state, unit)` explains every stat for the unit
sheet: a `base` and signed `contributions` (`source` label, `kind`: `item`, `mount`, `passive`,
`buff`, `faction`, `tech`, `other`) whose sum is exactly the effective value. Both read one shared
sum, so they cannot drift. Since `unit.base` already holds the race mods, the level-up hit points
(+4 per level above the starting one) and the stat picks, those are split back out of it (`faction`;
`other` for "Level-ups (n × +4)" and "Level 3: +3 Strength"; a unit without a level history keeps
its picks in `base`). Clamps show as `other` ("Armor cap (70)", "Minimum Movement (1)").

### 4.2 Equipment slots (`EquipSlot`)
`main` (tool, weapon, staff, wand), `off` (shield), `body` (armor/robe), `trinket`,
`mount`. A bow uses `main` and blocks `off` (two-handed).

### 4.3 Items (`data/items.ts`)
| id | slot | effect | cost | unlock |
|---|---|---|---|---|
| `tools` Builder's Tools | main | can build/upgrade; ×1.5 production of the building it works (×1.25 bare-handed); melee 4×2 | 6 wood, 4 iron... (cheap: 5 wood 2 iron) | start |
| `sword` Iron Sword | main | melee 7×3 blade | 4 wood 6 iron | start |
| `spear` Spear | main | melee 6×3 pierce, *firststrike*, +50% vs mounted | 6 wood 4 iron | Polearms |
| `axe` War Axe | main | melee 10×2 | 4 wood 7 iron | Polearms |
| `bow` Longbow | main (2H) | ranged 6×3 range 2; melee 2×1 | 8 wood 1 iron | start |
| `staff` Magic Staff | main (2H) | magic ranged 8×2 range 2 (70% hit), +2 int | 4 wood 4 crystal | Arcana |
| `wand` Wand | main | magic ranged 5×3 range 2, +1 int, +1 mana/turn | 2 wood 3 crystal 1 iron | Wandcraft |
| `shield` Shield | off | +12 armor, +5 terrain defense | 6 wood 3 iron | Shieldcraft |
| `tunic` Padded Tunic | body | +5 armor | 4 food 2 gold (cloth) | start |
| `leather` Leather Armor | body | +15 armor | 6 food 4 wood | Tanning |
| `plate` Plate Armor | body | +30 armor, −1 mov | 10 iron 2 stone | Plate Smithing |
| `robe` Mage Robe | body | +3 armor, +2 int, +1 mana/turn | 3 crystal 4 gold | Arcana |
| `amulet` Amulet of Vigor | trinket | +8 maxHp, regen +2 | 3 crystal 6 gold | Jewelcraft |
| `ring` Ring of Focus | trinket | +2 int, +15% magic dmg | 4 crystal 4 gold | Jewelcraft |
| `horse` Warhorse (race: wolf for orc, nightmare for undead — same item, different model) | mount | +3 mov, +25% melee when attacking from flat terrain (*charge*), −10 defense in forest/hills/swamp, cannot enter mountain | 10 food 6 gold 2 iron | Horsemanship |

Items are crafted at a **Forge** into the faction **stockpile** (instant, costs
resources; a forge can craft `forgeLevel + 1` items per turn). A unit standing on an
own castle/forge/house/training ground/mage tower may **equip** from the stockpile or
**unequip** to it (free action, does not end the turn).

### 4.4 Attacks (derived, `sim/units.ts: getAttacks(unit)`)
Each unit has at most one melee and one ranged attack, from its `main` item (fists 3×2
melee if none). Damage per strike:
`base + floor(stat/2)` where stat = str (melee), dex (ranged), int (magic); then × efficiency
multipliers (attack/ranged/magic), × buffs, × race bonus; then × (1 − target armor%).
Rounded, min 1.
Spell and active-skill damage (Fireball, Storm of Ruin, Firebolt) is fixed: not scaled by stats or
multipliers and not reduced by armor. Volley is a real ranged attack (60% damage per arrow) and does
use armor.

### 4.5 Combat (`sim/combat.ts`) — Wesnoth-like
* Melee: target adjacent. Ranged/magic: target within range (2). Defender retaliates with
  the attack of the **same kind** (melee vs melee, ranged/magic vs ranged/magic) if it has
  one *and* the attacker is within that attack's range.
* Strikes alternate attacker, defender, attacker, … until both have used their strikes or
  one dies. *firststrike* on the defender makes it strike first.
* Hit chance = `100 − defender tile defense` (+ wall/castle bonus, + shield +5, mounted
  penalty), clamped [10, 90]. Magic attacks always 70%.
* Forecast (`forecastCombat`) gives exact probabilities of each side's HP outcome
  (dynamic programming over strike sequence) and expected damage; the UI shows it on
  hover before the click.
* XP: attacker and defender each get XP = 1 + 1 per strike landed, in the category of the attack
  kind each used (`melee`, `ranged` or `magic`; a defender that cannot answer learns in its own
  main weapon's kind); a kill grants `8 × target.level` (4 for level-0 summons) in the kind of
  the killing blow (Volley → `ranged`, Firebolt and spells → `magic`).
* Attacking ends the unit's movement for the rest of the turn (`mp = 0`, `acted = true`); Haste and
  Rally cannot restore it (no hit-and-run). Volley, Firebolt and Blink end movement the same way.

### 4.6 Movement & ZOC
Movement points per turn = `mov`. A* over passable terrain with move costs. Entering a
hex adjacent to an enemy unit ends movement (ZOC) unless the unit has *skirmisher*.
Units cannot pass through enemies. Own units can be passed through but not stacked.
Mounted units: mountain impassable; forest/swamp cost +1.

### 4.7 Experience & levels (`sim/progression.ts`)
Seven XP categories (`XP_CATEGORIES` in `data/skills.ts`), so a unit's trade shapes its level-ups
(an archer meets few melee options):

| category | name | earned by |
|---|---|---|
| `melee` | Melee | melee attacks and parries, melee kills, Training Ground drill (+5/+8/+10) for a unit whose main weapon is not ranged |
| `ranged` | Ranged | ranged attacks and return fire, ranged kills, Volley, Training Ground drill for a unit with a bow |
| `building` | Building | construction and upgrades with Builder's Tools (+3 per turn), the leader raising its castle |
| `civic` | Civic | working a building (+2 per turn without acting; §5), the castle included for anyone but the leader, the smith on a forge (+2 per item crafted) |
| `explore` | Exploration | +1 per 3 new hexes revealed, ruins +12 |
| `leader` | Leadership | leader only: +2 per unit recruited, +1 per allied kill within 3 hexes, working its own castle (+2) |
| `magic` | Research & Magic | magic attacks, Firebolt, Mend, spells cast from the tower the unit stands in (+6), Mage Tower drill (+3/+5/+6), working a building that yields research or mana (library, watchtower, shrine, mage tower; not the castle: it is the seat of rule, and teaches civic) |

Inspiring gives 1 XP in the ally's main category (its largest share this level, else lifetime,
else by kit: builder → `building`, archer → `ranged`, fighter → `melee`, mage → `magic`, leader
→ `leader`). Leader gets ×1.3 on all XP (fractions carry over to the next grant). Saves made
before the split load with `civil` → `civic` and `fight` → `ranged` for a unit whose main weapon
is ranged, else `melee` (`migrateUnitXp` in `sim/state.ts`).

XP to next level: `25 + 15 × level`. Level cap 10. On level-up: `maxHp += 4` (heal 4),
then the owner picks **1 of 3 options**. Options are drawn from four kinds:
`stat`, `efficiency`, `passive`, `active` (see `data/skills.ts`). Each option has category
tags; the draw weights each candidate by the share of XP earned in its categories during
that level (+ a small base weight + randomness). A level's tally closes the moment the level is
reached: XP earned while the choice waits (and the overflow) counts toward the next level. Already-owned passives/actives are
excluded. The draw softly avoids repeating an option kind on one offer, and offers at most one
option outside the level's XP categories (a cross-trade wildcard such as Firebolt for a knight);
bow skills (Volley, Keen Eye, Marksman) are less likely (×0.4) for a unit without a ranged attack,
and melee-only options (+3 Strength, Weapon Mastery, Venom Blades, Berserker, Power Strike) are
likewise ×0.4 for a unit whose main weapon shoots or casts. Option categories (`data/skills.ts`):

| option | categories |
|---|---|
| +3 str · Weapon Mastery · Venom Blades · Iron Skin · Berserker · Power Strike | melee |
| +3 dex | ranged, explore |
| +3 int · Arcane Focus · Mana Spring · Firebolt | magic |
| +6 max HP | melee, building, leader |
| +6 armor | melee, leader |
| +1 mov · Pathfinder | explore |
| +1 vis · Skirmisher | explore, ranged |
| Keen Eye · Marksman · Volley | ranged |
| Green Thumb · Harvester | civic |
| Master Builder | building |
| Deep Delver · Woodsman · Prospector | civic, explore |
| Mana Channeler · Erudite | magic, civic |
| Merchant | civic, leader |
| Regeneration · Life Drinker | melee, magic |
| Leadership | leader, melee |
| Scholar · Mend | magic, civic, leader |
| Inspiring | leader, civic |
| Rally | leader |
| Fortify | melee, building |
| Blink | magic, explore |
| Masonry | building, explore |
| Devotion | magic, building |

The AI
chooses automatically (scores options by its unit role; a unit's first combat active beats a
primary stat).

Every pick is kept in the unit's level history, `learned: { level, option }[]` (oldest first;
`level` is the level that offer belonged to, so two queued level-ups taken at level 3 record levels
2 and 3). Saves from before it load with an empty history.

Pending level-ups are queued: a unit with `pendingLevelUps > 0` shows a glowing badge;
the player resolves them through the Level-Up modal (it opens automatically at the start
of the player's turn and when a unit levels during the player's turn). *Decide later* (or
closing the window, or ending the turn with it open — it never holds End Turn) puts the waiting
choices off: they stay behind a "Level up" reminder by End Turn and a star badge on the unit's
portrait (both open the window), and the window only opens by itself again for a newer level-up.

### 4.8 Skills (`data/skills.ts`)
* **Stats**: +3 str, +3 dex, +3 int, +6 maxHp, +6 armor, +1 mov, +1 vis.
* **Efficiency**: ×1.25 on one of `attack`, `ranged`, `magic`, `farming`, `building`
  (build points & production of the worked building), `mining` (iron/stone/crystal),
  `gathering` (wood), `mana` (also own wand/robe mana), `research`, `trade` (gold). Work
  efficiencies apply to the building the unit works (tools or not).
* **Passive**: `regeneration` (+4 hp/turn), `poison` (melee hits poison: 4 dmg/turn,
  until healed in a castle/shrine), `skirmisher` (ignores ZOC), `pathfinder` (forest/hills
  cost 1), `ironskin` (+8 armor), `leadership` (adjacent allies +15% damage),
  `harvester` (+1 food/turn), `prospector` (+1 iron/turn), `manaspring` (+1 mana/turn),
  `scholar` (+1 research/turn), `marksman` (ranged hit chance min 60%), `berserker` (+25%
  melee dmg when below 50% hp), `vampiric` (heal 30% of melee damage dealt), `inspiring`
  (+1 XP to adjacent allies per turn, in the category each ally earns most).
* **Active** (cooldown in turns; used from the unit panel; costs the unit's action — no attack
  after it, though Fortify and Mend leave movement — except `powerstrike` and `rally`, which are
  free so they can open an attack or a march):
  `powerstrike` (next melee ×1.5 dmg, cd 3), `volley` (ranged attack on all enemies in
  radius 1 of target at 60% dmg, cd 4), `heal` (adjacent ally or self +12 hp, cd 2), `firebolt`
  (14 dmg ignoring armor, range 3, cd 3), `rally` (allies in radius 2 that have not attacked get +2 mp this turn, cd 4),
  `fortify` (+20 armor until next turn, cd 3), `blink` (teleport up to 3 hexes, cd 4),
  **building unlocks**: `masonry` (can build Watchtower), `devotion` (can build Shrine)
  — these are permanent once learned (cd 0, not an action).

### 4.9 Presets (`data/presets.ts`)
Recruit a Commoner pre-equipped; cost = commoner cost + item costs; requires item
unlocks and the listed building.

| preset | items | where |
|---|---|---|
| Commoner | — | House, Castle, Training Ground (an armory: arm it from the stockpile) |
| Builder | tools | House, Castle |
| Swordsman | sword, tunic | Training Ground, Castle |
| Spearman | spear, leather | Training Ground, Castle |
| Archer | bow, leather | Training Ground, Castle |
| Knight | sword, shield, plate, horse | Castle |
| Apprentice | wand, robe | Mage Tower, Castle |
| Battle Mage | staff, robe, ring | Mage Tower |

Names: a new unit is named once, when it is created, from its house's pool. It is a woman
when its race is human and its first body is the light body (`bodyVariant` of its starting
equipment: leather, so human Archers and Spearmen; the `human_light` portrait and model) and
draws from the house's female list (`femaleUnitNames`); every other unit is a man and draws from
`unitNames` (orcs and undead have one list). Arming a commoner later never renames it. Leaders
keep their title (Queen Aldra Valen).

Commoner cost: `15 gold, 5 food`. Recruiting from Castle requires the leader on the
castle. Each recruit site (castle, house, training ground, mage tower) can recruit once
per turn; the recruit appears on the site's hex or the nearest free adjacent hex (never on
another faction's building) and cannot move that turn — Haste and Rally do not help it — nor
capture where it stands until its next turn. Summoned elementals follow the same rules: they never
appear on another faction's building, and neither march nor capture on their first turn.

Upkeep: each unit eats 1 food/turn (undead 0.5); leader free. If food < 0 at upkeep,
every unit loses 3 hp (cannot die from starvation below 1 hp) and food is set to 0.

### 4.10 Standing orders (`sim/orders.ts`)
A unit can be told to stay put: **Rest until healed** (`'heal'`) or **Sentry** (`'sentry'`), with
the action `{ type: 'order', unit, order: 'heal' | 'sentry' | null }` (null cancels). It is free (no
movement, no action) and only for the house's own units on its turn; creatures (monsters, summons)
take no orders, and Rest is refused at full HP. The order changes no rule: a unit that stays still
already rests (+2 HP) and works the building it stands on. It only keeps the unit out of the
"awaiting orders" list (Tab, the idle count; the panel reads "Resting until healed" / "On sentry")
until something needs the player:
* any move, attack, skill, build or upgrade by the unit clears it (silently);
* at the start of its house's turn (after healing, poison and the fog refresh), a hostile unit of
  any other faction (wild monsters included) that the house can see within the unit's sight (vision
  +1 on hills/mountain) for Sentry, or within 2 hexes for Rest, ends it (`reason: 'enemy'`, with the
  nearest such hostile; checked first);
* at the start of its house's turn, a resting unit back at full HP is done (`'healed'`);
* being attacked ends it at once: the defender of a combat it survives, or a unit hit by a hostile
  spell or skill (a Volley that misses counts; the house's own Fireball, poison and hunger do not)
  (`'attacked'`).
An order that ends by itself emits `orderEnded { unit, order, reason, enemy? }` and, for the human,
a chronicle line naming what it saw ("Wulfric is fully healed.", "Wulfric spots a Giant Spider!",
"Piers stops resting: a Giant Spider is near!", "… is attacked and stops resting."); the HUD toast
uses the same words (`orderEndText`). The AI never gives orders. A unit with an order is still
offered to Tab when an enemy is in attack reach this turn: from where it stands (the sim's rule),
or, in the HUD, by moving first — the same targets its Attack button counts (`unitsAwaitingOrders`
takes that test from the controller, so Tab and the bar agree). Giving an order while a hostile is
already inside its wake-up range is allowed but warned about (`orderWakeWarning`: the command bar's
tooltip and amber mark, a toast on Y/V), as it would end at the next turn start.

## 5. Buildings (`data/buildings.ts`)

Built by a unit with `tools` standing on a valid hex inside or adjacent to own territory.
Starting a construction pays the resource cost; the building then has `buildPoints`;
each **end of turn** a tools-equipped unit standing on it that did not attack contributes
`1 × building efficiency × (1 + 0.1 × level)` points (+ `building` 3 XP). Max level 3; an
upgrade costs `cost × level` and `buildPoints × level` and requires the tech
`Architecture` (lv 2) / `Grand Architecture` (lv 3).

Production per level is `base × (1 + 0.5 × (level − 1))`. **Working a building needs no tools:**
any own unit (not a monster or summon) standing on an own functional building with some output
(castle, house, farm, lumber camp, quarry, mines, library, mage tower, watchtower, shrine — an
upgrade in progress keeps working at the current level) is its worker and multiplies the output
by `WORKER_MULT 1.5` with Builder's Tools, `BARE_WORKER_MULT 1.25` bare-handed (any other weapon
too), times its `building` and resource efficiencies (each efficiency pick is +25% of the whole
output). A worker earns 2 XP per turn it did not act (a unit recruited or summoned that turn has
not worked yet): on the castle `leader` for the leader and `civic` for anyone else (fresh recruits
stand there; its research must not hand them magic XP), else `magic` if the building yields
research or mana, `civic` otherwise (`workerOf` / `workXpCategory` in `sim/economy.ts`). A castle with the leader on it also adds +10% to all own
buildings (and the leader standing there works the castle too). A forge, wall or training ground
produces nothing to work. Idle unarmed AI commoners work the nearest free producing building
(one making a resource the house holds under 20 of counts as 3 hexes nearer). Territory: castle radius 2, other buildings radius 1, overlapping claims go
to the older building.

| id | allowed terrain | base output | cost | build pts | unlock | special |
|---|---|---|---|---|---|---|
| `castle` | grass/plains/hills | 3 gold 1 food 3 research | 20 stone 15 wood 20 gold | 6 | start (one per faction; building a new one moves the seat: old castle is destroyed) | +25 defense; recruit any preset when leader on it; heals +8 |
| `house` | grass/plains/forest/hills | 2 gold | 8 wood 4 stone | 2 | start | recruit Commoner/Builder; heals +4 |
| `farm` | grass/plains (+1 on fertile) | 3 food | 6 wood | 2 | start | |
| `lumber` Lumber Camp | forest | 3 wood | 4 gold 2 stone | 2 | start | |
| `quarry` | hills/mountain | 3 stone | 6 wood | 2 | start | |
| `forge` | grass/plains/hills/crystal | — | 10 stone 6 wood 4 iron | 3 | start | crafting; armory |
| `training` Training Ground | grass/plains | — | 10 wood 6 gold | 3 | start | +5/+8/+10 melee XP (by level) to units on it (ranged XP for a unit whose main weapon is ranged); recruit commoners/fighters/archers |
| `mine` | iron deposit | 2 iron | 8 wood 6 stone | 3 | Mining | |
| `crystalmine` Crystal Mine | crystal deposit | 2 crystal | 10 wood 8 stone 2 iron | 3 | Crystal Lore | |
| `library` | grass/plains/hills/crystal | 3 research | 10 wood 8 stone 10 gold | 3 | Writing | |
| `magetower` Mage Tower | any land except swamp | 2 mana | 12 stone 8 crystal 10 gold | 4 | Arcana | global spells; recruit mages; +3/+5/+6 magic XP (by level) to units on it |
| `wall` | any land | — | 12 stone | 2 | Masonry (tech) | +20/+30/+40 defense; enemies cannot capture |
| `watchtower` | any land | 1 research | 8 wood 6 stone | 2 | skill `masonry` | +3 vision radius around it, +10 defense |
| `shrine` | any land | 1 mana | 6 stone 4 crystal | 2 | skill `devotion` | heals +8, cures poison |

Capture: an enemy unit that **ends its turn** on a building (not wall, not castle) of
another faction flips its ownership (construction progress is kept). A castle is
**razed** instead (destroyed) — its faction loses its seat until it builds a new one.
Buildings of an eliminated faction become neutral ruins-of-buildings (owner null, no
output) and can be captured by anyone.

## 6. Research (`data/research.ts`)

Research points accumulate into the current project (one at a time; leftover carries).
The castle's 3 points a turn put the first tier-0 tech about 9 turns into the game; Libraries
(Writing) then double that pace. Each house starts with its signature tier-0 tech already known
(§2), so its identity shows from turn 1.
~22 techs in 3 branches with prerequisites:

* **Civic**: Mining (30), Writing (30), Crop Rotation (+25% food, 60), Masonry (wall, 60),
  Architecture (lv 2 buildings, 90), Guilds (+20% gold, 90), Scholarship (+25% research,
  110), Grand Architecture (lv 3, 160).
* **Military**: Tanning (leather, 30), Polearms (spear/axe, 50), Shieldcraft (60), Plate
  Smithing (110), Horsemanship (100), Tactics (+10% damage all units, 140).
* **Arcane**: Crystal Lore (crystal mine, 50), Arcana (mage tower, staff, robe, 80),
  Wandcraft (60), Jewelcraft (amulet/ring, 80), and spells: Healing Light (70),
  Blessing (90), Fireball (110), Haste (90), Farsight (60), Summon Elemental (150),
  Storm of Ruin (180).

## 7. Global spells (`data/spells.ts`)

Cast from any own Mage Tower at a target hex within the tower's range. Range =
`spell.range + floor(int/3)` of the best unit standing on that tower (0 if empty). Costs
mana; each spell has a faction-wide cooldown. Casting gives the tower's unit 6 `magic` XP.

| spell | mana | range | cd | effect |
|---|---|---|---|---|
| Healing Light | 20 | 6 | 2 | allies radius 1: +15 hp, cure poison |
| Blessing | 25 | 6 | 3 | allies radius 1: +20% dmg, +10 armor, 2 turns |
| Fireball | 30 | 7 | 2 | 18 dmg target hex, 8 to radius 1 (all units, own included), ignores armor |
| Haste | 15 | 8 | 2 | one ally that has not attacked: +3 mp now |
| Farsight | 10 | 10 | 1 | reveal radius 4 for 3 turns |
| Summon Elemental | 50 | 4 | 5 | summon Stone Elemental (own unit, 40 hp, melee 12×2, no upkeep, lives 8 turns) on target empty hex that holds no other faction's (or abandoned) building |
| Storm of Ruin | 45 | 7 | 4 | 4 random bolts of 14 dmg in radius 2 (enemies only), ignores armor |

Mana also comes from robes/wands/passives. Mana cap: 100 + 50 per mage tower.

## 8. Turn structure (`sim/turn.ts`)

Factions act in order (player first). `endTurn(factionId)`:
1. For the faction that ended: construction progress, building work XP, training ground XP.
2. Advance to next faction; when the round wraps: `round++`.
3. At the **start** of a faction's turn: production (+ upkeep), research progress,
   healing (rest +2 if the unit didn't move or fight last turn; building heals), poison,
   buff/summon timers, cooldowns −1, `mp = mov`, `acted = false`, recruit sites reset,
   visibility refresh, standing orders (§4.10: a hostile in range or a healed rester ends them),
   level-up queue.
4. Victory when all other non-neutral factions are eliminated; defeat when the player's
   leader dies (faction eliminated immediately on leader death; its units vanish over
   1 turn — simplified: removed immediately with a death animation). The defeat names the house
   that slew the leader (`eliminatedBy`); an AI is crowned victor only if it is the last house
   standing.
Neutral monsters act after all factions each round: they guard ruins (wander within 3
hexes) and attack adjacent/near units. Respawn near ruins every 12 rounds if under cap.
Monsters never enter within 3 hexes of a castle (its territory is safe), and during rounds 1–3
they only defend their lair.

## 9. AI (`sim/ai/*.ts`)

Runs entirely through the public action API (`sim/actions.ts`), same rules as the player,
fog-of-war respected loosely (it may know building locations; it sees units only within
its vision). Layers:
* **Economy planner**: target building mix by phase (opening: farm, lumber, quarry,
  house, forge, training; mid: mine, library, crystal mine, mage tower; walls near the
  castle under threat). The forge's iron (and, without iron income, a replacement Builder's
  Tools) is kept back from recruits and crafting so the economy cannot lock itself out; a house
  that lost every builder recruits or forges a new one first. Wands, robes and trinkets never
  eat the first mage tower's crystal (from the moment Arcana is being researched). A second
  tower follows once the first one works (round 26 for the Ashen Covenant, 34 for the others);
  the Ashen Covenant, whose mages run on crystal, raises its crystal mine (and a second quarry
  when stone is short) before its iron mine. Later mage towers stand toward the
  rival. Units step off a builder's planned site. Picks sites by scoring tiles (terrain/deposit fit, distance to
  castle, safety). Builder units are assigned to construction sites; keeps 1 builder per
  ~4 buildings (min 1, max 3); an idle builder does not take a mage tower's hex while a mage
  could channel there.
* **Research**: Writing first (no library yet), Polearms against riders, Mining, Masonry when
  besieged; then, once a library stands, the magic road — the cheap (≤ 30) techs the house's own
  list ranks before Crystal Lore (Thorn: Tanning), Crystal Lore, Arcana — and with Arcana,
  Healing Light followed by the house's signature spell (the first on its list other than
  Healing Light and Farsight: Valen Blessing, Thorn and Ashen Fireball). Everything else follows
  the house's priority list (the Ashen Covenant's then runs Wandcraft, Jewelcraft and Summon
  Elemental before Tanning and Polearms).
* **Recruitment**: keeps army size ≈ `3 + round/3` (capped by food income; living summons
  do not count), presets chosen by flavor and available tech; crafts items when stockpile is
  short. Each mage tower, standing or rising (up to two), wants a mage: until each has one the
  next recruit takes the mage track (one recruit over the army target if need be).
* **Tactics**: for each military unit, evaluate candidate (move hex, target) pairs with
  the combat forecast: `score = expected dmg dealt × value(target) + kill prob × bonus
  (leader ×4) − expected dmg taken × self value − exposure`. Retreat to a healing site
  under 40% hp. Leader stays within 2 hexes of the castle unless the score of an attack is
  overwhelmingly good. Units without a good attack move toward the nearest enemy
  building/unit. Target house = nearest, with a player bias by difficulty (×1/0.85/0.75 on the
  distance for easy/normal/hard) for the AI whose seat is nearest the player only; a house whose
  units raid us becomes the target; a seatless house is easy prey; an army already marching keeps
  its target. Unarmed levies are raised only when something can arm them, or a few to body-block
  when armed foes threaten the castle.
* **Spells**: cast Fireball/Storm on clusters of enemies, Healing Light on clusters of
  damaged allies, Blessing before attacks, Farsight toward the rival or raiders, Summon where
  the castle, a building or our units are under attack within a tower's reach (monster raiders
  count once the pool holds two summons' worth), Haste for a decisive blow — always on the best
  target a tower can reach. The value bar drops as the pool nears its cap (×0.75 at 70%, ×0.5
  at 90%) or holds two of the dearest known spell (×0.8). Farsight never drops the pool below
  the price of the dearest known war spell (at most 30, a Fireball) unless it is 60% full; an
  overflowing pool at war (two summons' worth, fewer than two guardians alive) raises a Stone
  Elemental by the tower nearest the front. Each working tower keeps its best mage within 14
  hexes posted on it to channel (in attack stance too, while the host keeps more than two).
* Difficulty (`easy|normal|hard`): AI resource income ×0.8/1.0/1.3, recruitment cap.

## 10. Presentation

* **Renderer**: Three.js WebGL2, ACES filmic tone mapping, sRGB output, PCF soft shadows
  from a sun that follows the camera target, hemisphere fill light, exponential fog
  tinted to the sky, post-processing (bloom for magic, SMAA, subtle vignette).
* **Terrain**: one continuous heightfield mesh (≈8 samples per hex edge) whose heights and
  8-way texture splat weights are blended from per-hex values; PBR terrain shader via
  `MeshStandardMaterial.onBeforeCompile` sampling generated tileable textures (grass,
  plains, forest floor, hills, rock, swamp, sand, crystal ground). Thin hex grid lines
  (toggle `G`). Animated water plane with fresnel/waves. Instanced decorations: trees on
  forest, rocks on hills, peaks on mountain, reeds/dead trees on swamp, crystal clusters,
  ruin stones. Fog of war: unexplored = dark with drifting cloud noise, explored but not
  visible = desaturated & darkened, units/buildings hidden outside vision.
* **Buildings**: 3D models (AI-generated via TRELLIS.2 from Qwen-Image concepts,
  decimated in Blender), with a faction-colored banner/flag pole and a territory border
  line per faction. Castles use their faction's seat model; other buildings use a faction
  variant (`house_thorn`, `farm_ashen` …) where one exists, else the plain model. Ownerless
  (abandoned) buildings keep their last owner's model, drawn slate grey with no banner.
  Construction sites show scaffolding + a progress ring.
* **Units**: rigged humanoid GLB per race × body (commoner/light/heavy/robe/leader; a
  commoner in the Padded Tunic uses `<race>_padded` when that model ships; UI portraits follow the
  same body — `<race>_padded` in the tunic, recruit cards by the preset's armour — falling back to
  `<race>_commoner`, a leader's to a silhouette);
  weapons/shields attached to hand bones (`hand_R`, `hand_L`), trinket glow at the chest,
  mounts placed under the rider (rider uses `sit` pose). Animations: `idle`, `walk`,
  `attack_melee`, `attack_ranged`, `cast`, `hit`, `death`, `sit`. Faction-colored base
  ring, HP bar + level pip billboard. Selected unit gets a pulsing ring. A unit on a
  building hex stands clear of the model on the camera side; a body hidden behind terrain
  or a building shows as a faction-colored x-ray silhouette (and stays clickable). Zoomed
  far out, units show as constant-size faction shields with level and HP.
* **Feedback**: movement range overlay (reachable hexes tinted), path preview with
  move-cost dots, attackable enemies outlined red, combat forecast tooltip (placed beside the
  target, clear of the attacker's path and the HUD; lists the modifiers behind the numbers:
  charge, Power Strike, leadership, berserker, bonus vs mounted, poison / drain on hit; names the
  approach hex), spell and skill target previews (per affected unit: HP before → after, kill
  chance; damaging areas drawn fiery, and red-pink when own units are inside — such a cast needs a
  second click), terrain chip on hover with nothing selected (with a unit selected, past this turn's
  reach: the trip length, "too costly this turn" with the MP needed and when it can get there when
  the first step costs more MP than are left, or why the way is blocked), floating
  damage numbers, projectiles (arrows, magic bolts), spell VFX (fireball explosion,
  heal sparkles, lightning, summon), screen shake on big hits, level-up burst.
* **UI** (Preact DOM overlay, parchment & dark-metal theme): top bar (resources with
  per-turn delta tooltips, round, End Turn), left unit panel (portrait — click for the unit
  sheet —, name, level, XP bars by category, HP, stats, 5 equipment slots with icons, attacks,
  passive / learned skills and efficiencies, status pills incl. the standing order), bottom
  **command bar** for the selected unit (`hud/CommandBar.tsx`, centred between the chronicle and
  the End Turn column; square icon buttons with a label and hotkey badge, tooltips that say what
  the command does and, greyed out, why not): *Combat* — Attack (T, the attack command below) and
  each activated skill with its cooldown (1–6); *Orders* — Rest until healed (Y), Sentry (V), Skip
  (X), lit while active, a click cancels; *Work*, as the hex allows — Build (B), Upgrade (U),
  Recruit, Equip, Forge (F), Level up (L, glowing); *Info* — Details (C or I). Another house's
  unit gets Details only. A caveat that does not block (an enemy already close enough to end a new
  order) shows as an amber mark and in the tooltip. Past 12 buttons the bar goes dense (narrower
  buttons, one row at 1600 px); the last two groups wrap together, so Details never sits alone on a
  row. Right tile panel (terrain, defense, deposit, building + production, who works it and its
  multiplier, or how to work it), bottom-right minimap (click to jump), event log,
  modals: Research tree, Spellbook, Forge/Stockpile, Recruit, Level-Up choice, Main menu,
  Victory/Defeat, Help (controls & rules), and the **unit sheet** (`modals/UnitSheet.tsx`, helpers
  in `ui/sheet.ts`; Details, C / I or a click on the portrait): header with portrait, level, HP and
  an XP bar split by kind, condition (standing order or duty, effects with turns left, poison,
  summon timer, where it stands and its defense there); every attribute as base + each
  `statBreakdown` source = total; attacks as base + ½ stat × the multipliers that always apply,
  with situational notes and hit chance; the five slots; every augment (actives with cooldown,
  passives, building skills, efficiencies) and the level history; the seven kinds of XP (this level,
  lifetime, what earns each, the level-up options each favours); the house stockpile with Equip… on
  an armory (Equip and Level up opened from the sheet go back to it when closed). Another house's unit or a beast opens read-only, without the stockpile; own units page
  with Prev / Next. A house destroyed is announced by a banner naming it and
  its slayer, a toast and a chronicle line (none for the war's last fall: the results say it).
  Outcome toasts collapse around a fall (one line for a fallen leader, not one per unit swept away
  with them, nothing after the player's own fall) and give way to the results screen.
* **Controls**: LMB select / move / attack (LMB on an empty hex past this turn's reach walks as far
  as possible toward it, the unit stays selected); the attack command (T or the bar) marks only the
  enemies the unit can attack this turn (from where it stands or after moving, "Choose a target"
  hint): a click on one does what a click on it does with the unit selected, anything else — Esc,
  RMB, a click elsewhere — goes back to the unit; RMB or Esc cancel; WASD/arrows/edge-pan or
  MMB/RMB-drag pan; wheel, PgUp/PgDn or +/− zoom; Q/E rotate; Space/Enter end turn (an open level-up
  window does not hold it: the choice is put off; ignored for
  0.7 s after the player's turn begins, 1 s after a fast-forwarded enemy turn, and 0.45 s after the
  previous press, so a double press or mashing ends at most one turn; during an enemy turn it fast-forwards the playback, as does the End Turn
  button); Tab next unit awaiting orders (builders on a site, any unit working a producing building, units drilling at a
  training ground / mage tower, the leader on the castle and units under a standing order (§4.10) are
  skipped unless an enemy is in reach; X skips a unit for this turn); B build menu, R research, M spellbook, F forge, C / I unit sheet (window hotkeys switch between light
  windows but never replace a decision: results, level-up, new game, settings), G grid, H help,
  Ctrl+S save, F1 debug. Selected own unit, own turn, no window open: T attack, 1–6 its activated
  skills in bar order (a second press cancels the targeting), Y rest until healed / V sentry
  (pressed again: cancel), U upgrade the building it stands on, L its level-up choice. Giving an
  order moves the selection on to the next unit awaiting orders, as Skip does; an order that ends
  by itself (healed, an enemy near, attacked) toasts and puts the unit back on Tab.
* **Enemy turns**: the HUD (round, faction, "Your Turn" banner) follows the playback, including a
  "The Wilds" phase for the neutral monsters; unit panel HP / XP, chronicle lines, warning toasts and
  the end of the war (Victory / Defeat in the HUD, results) are revealed when the animation shows
  them (e.g. after the killing blow on a leader). A faction's actions are played as one schedule
  (the sim never waits for the playback): each actor's beat (a march; a strike and the deaths it
  causes; a cast) waits only for earlier beats sharing a unit, building or hex, so independent
  marches and fights play at the same time; a march behind another on the same road keeps its
  distance instead of waiting for it to arrive. The camera glides (faster at higher animation
  speeds) to beats that concern the player, grouping those one view shows, and moves on once they
  have played. Setting *Enemy turns*: *Nearby* (default) frames what concerns the player, plays
  other on-screen beats faster (×1.6; framed marches ×1.25, repeated attacks on one unit ×1.3) and
  applies the rest (off screen) at once; *Watch all* frames every visible action. At turn start
  nothing stays selected from the previous turn.
* **Audio**: procedural WebAudio SFX (clicks, steps, sword clash, bow, spell whoosh,
  build hammer) and a generative ambient pad; volume slider; mute `N`.

## 11. Architecture

```
game/src
  core/   types.ts, hex.ts, rng.ts, events.ts             — no deps
  data/   terrain, items, buildings, skills, research, spells, presets, factions
  sim/    pure deterministic rules (no three.js, no DOM)
          state.ts mapgen.ts pathfinding.ts combat.ts units.ts economy.ts progression.ts
          research.ts spells.ts visibility.ts turn.ts actions.ts neutral.ts orders.ts
          ai/ (planner.ts tactics.ts index.ts)
  render/ three.js scene (reads GameState, never mutates it)
  ui/     Preact components (read state, dispatch actions through the controller)
  game/   controller.ts (input → actions → events → animations), session.ts (save/load)
  audio/  sfx.ts
```
* All state mutations go through `sim/actions.ts` → returns `ActionResult { ok, error?,
  events: GameEvent[] }`. The controller plays `events` as animations, then re-syncs the
  render from state. Render & UI never mutate state.
* `GameState` is plain JSON-serializable data (save/load to localStorage). Two slots: the manual
  save (menu *Save game*, Ctrl+S) and the autosave (start of every player turn, quitting, closing
  the tab — the last two even during an enemy turn; loading resumes it). Load and Continue show
  each slot's round, house and age. A victory deletes the saves; a defeat keeps them and offers
  *Retry last turn*.
* Deterministic RNG stored in state (`state.rngState`) so combat outcomes are
  reproducible and save-scumming is pointless.

## 12. Asset pipeline

`art/` is a comfy project. `art/tools/gen.py` drives Qwen-Image 2.1 (text→image) and
BiRefNet (alpha). `art/tools/i2m.py` drives TRELLIS.2/Pixal3D (image→GLB).
`blender/` holds headless Blender scripts: `process_static.py` (decimate, normalize
scale/origin, compress textures, export), `rig_humanoid.py` (auto-rig a T-pose mesh,
generate animations, export skinned GLB). Final assets land in `game/public/assets/`.
