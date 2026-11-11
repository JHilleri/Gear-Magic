import { describe, expect, it } from 'vitest';
import { makeTestState, makeTestUnit, makeTestBuilding, at, setTerrain } from './helpers';
import {
  createUnit, effectiveStats, getAttackDefs, isMounted, canBuildWith, bodyVariant, eff,
  canEquip, equip, canUnequip, unequip, unitValue, isFemaleAtCreation,
} from '../src/sim/units';
import { COMMONER_STATS, LEADER_STATS } from '../src/data/presets';
import { FACTIONS, MONSTERS } from '../src/data/factions';
import { FISTS_ATTACK } from '../src/data/items';

describe('createUnit', () => {
  it('builds a commoner with race modifiers and registers it', () => {
    const s = makeTestState();
    const u = createUnit(s, { faction: 'thorn', pos: at(2, 2) });
    expect(s.units[String(u.id)]).toBe(u);
    expect(u.race).toBe('orc');
    expect(u.base).toEqual({ ...COMMONER_STATS, maxHp: COMMONER_STATS.maxHp + 5, str: COMMONER_STATS.str + 1, int: COMMONER_STATS.int - 1 });
    expect(u.hp).toBe(u.base.maxHp);
    expect(u.level).toBe(1);
    expect(u.mp).toBe(COMMONER_STATS.mov);
    expect(u.isLeader).toBe(false);
    expect(u.name.length).toBeGreaterThan(0);
    expect(u.xpByCat).toEqual({ melee: 0, ranged: 0, building: 0, civic: 0, explore: 0, leader: 0, magic: 0 });
  });

  it('applies undead armor and human dex', () => {
    const s = makeTestState();
    expect(createUnit(s, { faction: 'valen', pos: at(1, 1) }).base.dex).toBe(COMMONER_STATS.dex + 1);
    const d = createUnit(s, { faction: 'ashen', pos: at(1, 2) });
    expect(d.base.int).toBe(COMMONER_STATS.int + 2);
    expect(d.base.armor).toBe(5);
    expect(d.race).toBe('undead');
  });

  it('creates leaders with leader stats, +4 hp per level above 1, and links the faction', () => {
    const s = makeTestState();
    const l = createUnit(s, { faction: 'valen', pos: at(3, 3), isLeader: true, level: 2 });
    expect(l.isLeader).toBe(true);
    expect(l.level).toBe(2);
    expect(l.base.maxHp).toBe(LEADER_STATS.maxHp + 4);
    expect(l.base.dex).toBe(LEADER_STATS.dex + 1);
    expect(l.name).toBe('Queen Aldra Valen');
    expect(s.factions.valen.leaderId).toBe(l.id);
    const c5 = createUnit(s, { faction: 'valen', pos: at(4, 3), level: 5 });
    expect(c5.base.maxHp).toBe(COMMONER_STATS.maxHp + 16);
  });

  it('equips preset items without touching the stockpile', () => {
    const s = makeTestState();
    const k = createUnit(s, { faction: 'valen', pos: at(3, 3), preset: 'knight' });
    expect(k.equipment).toEqual({ main: 'sword', off: 'shield', body: 'plate', trinket: null, mount: 'horse' });
    expect(s.factions.valen.stockpile).toEqual({});
    expect(k.mp).toBe(effectiveStats(s, k).mov);
    const bm = createUnit(s, { faction: 'valen', pos: at(4, 3), preset: 'battlemage' });
    expect(bm.equipment.main).toBe('staff');
    expect(bm.equipment.trinket).toBe('ring');
  });

  it('creates monsters from MONSTERS with passives and a guard anchor', () => {
    const s = makeTestState();
    const g = createUnit(s, { faction: 'neutral', pos: at(5, 5), monster: 'golem' });
    expect(g.race).toBe('monster');
    expect(g.monster).toBe('golem');
    expect(g.base).toEqual(MONSTERS.golem.stats);
    expect(g.level).toBe(MONSTERS.golem.level);
    expect(g.passives).toEqual(['regeneration']);
    expect(g.home).toEqual(at(5, 5));
    expect(g.name).toBe(MONSTERS.golem.name);
    const e = createUnit(s, { faction: 'ashen', pos: at(6, 5), monster: 'elemental' });
    expect(e.level).toBe(0);
    expect(e.summonTurns).toBe(8);
    expect(e.home).toBeUndefined();
    // Monsters ignore race stat mods.
    expect(e.base.int).toBe(MONSTERS.elemental.stats.int);
    // Higher-level monsters get the per-level hp bonus.
    const w3 = createUnit(s, { faction: 'neutral', pos: at(7, 5), monster: 'wolf', level: 3 });
    expect(w3.base.maxHp).toBe(MONSTERS.wolf.stats.maxHp + 8);
  });

  it('never repeats names among living units of a faction', () => {
    const s = makeTestState(30, 30);
    const names = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const u = createUnit(s, { faction: 'valen', pos: at(i, 0) });
      expect(names.has(u.name)).toBe(false);
      names.add(u.name);
    }
    // The pool has 20 names: the rest get regnal numbers.
    expect([...names].some((n) => n.endsWith(' II'))).toBe(true);
  });

  it('names a recruit by the body it is first drawn in: human light body → a woman\'s name', () => {
    const s = makeTestState(30, 30);
    const female = new Set(FACTIONS.valen.femaleUnitNames);
    const male = new Set(FACTIONS.valen.unitNames);
    expect(female.size).toBeGreaterThanOrEqual(12);
    for (const n of female) expect(male.has(n)).toBe(false);
    // Archers and spearmen wear leather: the human_light portrait and model (a woman).
    for (const [i, preset] of (['archer', 'spearman', 'archer'] as const).entries()) {
      const u = createUnit(s, { faction: 'valen', pos: at(i, 0), preset });
      expect(bodyVariant(u)).toBe('light');
      expect(isFemaleAtCreation(u.race, bodyVariant(u))).toBe(true);
      expect(female.has(u.name), `${preset} ${u.name}`).toBe(true);
    }
    // Every other human body is male: commoner, builder, swordsman (tunic), knight (plate), mage (robe).
    for (const [i, preset] of (['commoner', 'builder', 'swordsman', 'knight', 'apprentice'] as const).entries()) {
      const u = createUnit(s, { faction: 'valen', pos: at(i, 2), preset });
      expect(male.has(u.name), `${preset} ${u.name}`).toBe(true);
    }
    // Orcs and undead in leather keep their house's (male) list; leaders keep their title.
    for (const f of ['thorn', 'ashen'] as const) {
      const u = createUnit(s, { faction: f, pos: at(f === 'thorn' ? 10 : 11, 4), preset: 'archer' });
      expect(bodyVariant(u)).toBe('light');
      expect(FACTIONS[f].unitNames).toContain(u.name);
    }
    expect(createUnit(s, { faction: 'valen', pos: at(12, 4), isLeader: true }).name).toBe(FACTIONS.valen.leaderName);
    // The name is fixed at creation: arming a commoner with leather later does not rename it.
    const c = createUnit(s, { faction: 'valen', pos: at(13, 4) });
    const before = c.name;
    c.equipment.body = 'leather';
    expect(bodyVariant(c)).toBe('light');
    expect(c.name).toBe(before);
    expect(male.has(before)).toBe(true);
  });

  it('female names run out like male ones: regnal numbers, never a repeat', () => {
    const s = makeTestState(30, 30);
    const names = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const u = createUnit(s, { faction: 'valen', pos: at(i, 0), preset: 'archer' });
      expect(names.has(u.name)).toBe(false);
      names.add(u.name);
    }
    expect([...names].some((n) => n.endsWith(' II') && FACTIONS.valen.femaleUnitNames!.includes(n.slice(0, -3)))).toBe(true);
  });
});

describe('effectiveStats', () => {
  it('sums items, ironskin and buffs; clamps armor, block and mov', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(1, 1), { items: ['shield', 'plate', 'amulet', 'horse'] });
    const st = effectiveStats(s, u);
    expect(st.armor).toBe(30); // shield 5 + plate 25
    expect(st.block).toBe(5); // shield 2 + plate 3
    expect(st.maxHp).toBe(COMMONER_STATS.maxHp + 10);
    expect(st.mov).toBe(COMMONER_STATS.mov - 1 + 3);
    u.passives.push('ironskin');
    u.buffs.push({ id: 'fortify', turns: 1, armor: 20 }, { id: 'bless', turns: 2, armor: 10, damageMult: 1.2 });
    expect(effectiveStats(s, u).armor).toBe(60); // 30 + 20 + 10
    expect(effectiveStats(s, u).block).toBe(6); // 5 + Iron Skin 1 (Fortify adds armor only)
    u.base.armor = 20; // a veteran's own 20%: 80 → clamp 70 (DESIGN §4.1)
    expect(effectiveStats(s, u).armor).toBe(70);
    u.base.armor = 0;
    u.buffs = [{ id: 'fortify', turns: 0, armor: 20 }]; // expired buffs don't count
    expect(effectiveStats(s, u).armor).toBe(30);
    expect(effectiveStats(s, u).block).toBe(6); // 5 + Iron Skin 1
    const slow = makeTestUnit(s, 'valen', at(2, 1), { base: { ...COMMONER_STATS, mov: 1 }, items: ['plate'] });
    expect(effectiveStats(s, slow).mov).toBe(1);
    const frail = makeTestUnit(s, 'valen', at(3, 1), { base: { ...COMMONER_STATS, block: -3 } });
    expect(effectiveStats(s, frail).block).toBe(0); // never below 0
    // Base stays untouched.
    expect(u.base.armor).toBe(0);
    expect(u.base.block).toBe(0);
  });

  it('adds staff/robe/ring intellect', () => {
    const s = makeTestState();
    const u = makeTestUnit(s, 'valen', at(1, 1), { items: ['staff', 'robe', 'ring'] });
    expect(effectiveStats(s, u).int).toBe(COMMONER_STATS.int + 6);
  });
});

describe('attacks and traits', () => {
  it('derives attacks from the main item', () => {
    const s = makeTestState();
    const none = makeTestUnit(s, 'valen', at(1, 1));
    expect(getAttackDefs(none)).toEqual([FISTS_ATTACK]);
    const tools = makeTestUnit(s, 'valen', at(2, 1), { items: ['tools'] });
    expect(getAttackDefs(tools).map((a) => a.name)).toEqual(['Hammer']);
    const sword = makeTestUnit(s, 'valen', at(3, 1), { items: ['sword'] });
    expect(getAttackDefs(sword)).toEqual([{ kind: 'melee', name: 'Sword', base: 7, strikes: 3, range: 1 }]);
    const bow = makeTestUnit(s, 'valen', at(4, 1), { items: ['bow'] });
    expect(getAttackDefs(bow).map((a) => [a.kind, a.name])).toEqual([['melee', 'Bow Bash'], ['ranged', 'Longbow']]);
    const staff = makeTestUnit(s, 'valen', at(5, 1), { items: ['staff'] });
    expect(getAttackDefs(staff).map((a) => [a.kind, a.name])).toEqual([['melee', 'Staff'], ['magic', 'Arcane Bolt']]);
    const wand = makeTestUnit(s, 'valen', at(6, 1), { items: ['wand'] });
    expect(getAttackDefs(wand).map((a) => [a.kind, a.name])).toEqual([['melee', 'Fists'], ['magic', 'Spark']]);
    const spear = makeTestUnit(s, 'valen', at(7, 1), { items: ['spear'] });
    expect(getAttackDefs(spear)[0].firststrike).toBe(true);
    // Returned defs are copies (callers can't corrupt the data tables).
    getAttackDefs(sword)[0].base = 999;
    expect(getAttackDefs(sword)[0].base).toBe(7);
  });

  it('gives monsters their natural attack', () => {
    const s = makeTestState();
    const w = createUnit(s, { faction: 'neutral', pos: at(1, 1), monster: 'spider' });
    expect(getAttackDefs(w)).toEqual([MONSTERS.spider.attack]);
  });

  it('reports mounted, builder, body variant and efficiency', () => {
    const s = makeTestState();
    const k = makeTestUnit(s, 'valen', at(1, 1), { items: ['horse', 'plate'] });
    expect(isMounted(k)).toBe(true);
    expect(bodyVariant(k)).toBe('heavy');
    const b = makeTestUnit(s, 'valen', at(2, 1), { items: ['tools'] });
    expect(canBuildWith(b)).toBe(true);
    expect(isMounted(b)).toBe(false);
    expect(bodyVariant(b)).toBe('commoner');
    expect(bodyVariant(makeTestUnit(s, 'valen', at(3, 1), { items: ['robe'] }))).toBe('robe');
    expect(bodyVariant(makeTestUnit(s, 'valen', at(4, 1), { items: ['leather'] }))).toBe('light');
    expect(bodyVariant(makeTestUnit(s, 'valen', at(5, 1), { isLeader: true, items: ['plate'] }))).toBe('leader');
    expect(eff(b, 'farming')).toBe(1);
    b.efficiency.farming = 1.25;
    expect(eff(b, 'farming')).toBe(1.25);
  });

  it('values leaders and well-equipped units higher', () => {
    const s = makeTestState();
    const c = makeTestUnit(s, 'valen', at(1, 1));
    const k = makeTestUnit(s, 'valen', at(2, 1), { items: ['sword', 'shield', 'plate', 'horse'] });
    const l = makeTestUnit(s, 'valen', at(3, 1), { isLeader: true, level: 2 });
    expect(unitValue(k)).toBeGreaterThan(unitValue(c));
    expect(unitValue(l)).toBeGreaterThan(unitValue(k));
  });
});

describe('equip / unequip', () => {
  function armoryState() {
    const s = makeTestState();
    s.factions.valen.stockpile = { sword: 1, bow: 1, shield: 1, plate: 1, horse: 1, amulet: 1, tunic: 2 };
    s.factions.valen.techs = ['tanning', 'shieldcraft', 'mining', 'platesmithing', 'polearms', 'horsemanship', 'crystallore', 'wandcraft', 'jewelcraft'];
    makeTestBuilding(s, 'forge', 'valen', at(3, 3));
    const u = makeTestUnit(s, 'valen', at(3, 3));
    return { s, u };
  }

  it('requires an own, finished armory building', () => {
    const { s, u } = armoryState();
    expect(canEquip(s, u, 'sword')).toBeNull();
    u.pos = at(5, 5);
    expect(canEquip(s, u, 'sword')).toMatch(/stand on/i);
    makeTestBuilding(s, 'farm', 'valen', at(5, 5));
    expect(canEquip(s, u, 'sword')).toMatch(/stand on/i); // farms have no armory
    makeTestBuilding(s, 'house', 'thorn', at(6, 5));
    u.pos = at(6, 5);
    expect(canEquip(s, u, 'sword')).toMatch(/stand on/i); // not ours
    makeTestBuilding(s, 'training', 'valen', at(7, 5), { buildLeft: 2 });
    u.pos = at(7, 5);
    expect(canEquip(s, u, 'sword')).toMatch(/construction/i);
    makeTestBuilding(s, 'house', 'valen', at(8, 5), { buildLeft: 2, upgrading: true, level: 1 });
    u.pos = at(8, 5);
    expect(canEquip(s, u, 'sword')).toBeNull(); // upgrading buildings keep working
  });

  it('requires stock, research and a free hand', () => {
    const { s, u } = armoryState();
    expect(canEquip(s, u, 'axe')).toMatch(/stockpile/i);
    s.factions.valen.stockpile.staff = 1;
    expect(canEquip(s, u, 'staff')).toMatch(/Arcana/);
    u.equipment.main = 'bow';
    expect(canEquip(s, u, 'shield')).toMatch(/two-handed/i);
    const m = createUnit(s, { faction: 'valen', pos: at(3, 3), monster: 'elemental' });
    expect(canEquip(s, m, 'sword')).toMatch(/monster/i);
    u.equipment.main = 'sword';
    expect(canEquip(s, u, 'sword')).toMatch(/already/i);
  });

  it('swaps the previous item back into the stockpile and emits events', () => {
    const { s, u } = armoryState();
    u.equipment.main = 'tools';
    const ev = equip(s, u, 'sword');
    expect(ev).toEqual([{ type: 'unitEquipped', unit: u.id, item: 'sword', slot: 'main' }]);
    expect(u.equipment.main).toBe('sword');
    expect(s.factions.valen.stockpile.sword).toBeUndefined();
    expect(s.factions.valen.stockpile.tools).toBe(1);
    // Free action.
    expect(u.acted).toBe(false);
  });

  it('a two-handed weapon pushes the shield to the stockpile', () => {
    const { s, u } = armoryState();
    equip(s, u, 'shield');
    expect(u.equipment.off).toBe('shield');
    const ev = equip(s, u, 'bow');
    expect(ev).toEqual([
      { type: 'unitEquipped', unit: u.id, item: null, slot: 'off' },
      { type: 'unitEquipped', unit: u.id, item: 'bow', slot: 'main' },
    ]);
    expect(u.equipment.off).toBeNull();
    expect(s.factions.valen.stockpile.shield).toBe(1);
  });

  it('no mounting up on a mountain (a Mage Tower may stand there)', () => {
    const { s, u } = armoryState();
    s.factions.valen.techs.push('arcana');
    const tower = makeTestBuilding(s, 'magetower', 'valen', at(6, 6));
    setTerrain(s, tower.pos, 'mountain');
    u.pos = tower.pos;
    expect(canEquip(s, u, 'horse')).toMatch(/mountains/);
    expect(canEquip(s, u, 'sword')).toBeNull();
    setTerrain(s, tower.pos, 'hills');
    expect(canEquip(s, u, 'horse')).toBeNull();
  });

  it('refuses illegal equips without side effects', () => {
    const { s, u } = armoryState();
    u.pos = at(9, 9);
    const before = JSON.stringify(s);
    expect(equip(s, u, 'sword')).toEqual([]);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('keeps hp and movement consistent', () => {
    const { s, u } = armoryState();
    equip(s, u, 'amulet');
    expect(u.hp).toBe(COMMONER_STATS.maxHp); // no free heal
    u.hp = 30;
    unequip(s, u, 'trinket');
    expect(u.hp).toBe(COMMONER_STATS.maxHp); // clamped to the lower max
    // Unmoved: a mount's movement applies immediately...
    equip(s, u, 'horse');
    expect(u.mp).toBe(COMMONER_STATS.mov + 3);
    // ...but swapping back and forth after moving can't mint movement.
    u.moved = true;
    u.mp = 1;
    unequip(s, u, 'mount');
    expect(u.mp).toBe(0);
    equip(s, u, 'horse');
    expect(u.mp).toBe(0);
    // Plate costs a movement point right away.
    u.moved = false;
    u.mp = 5;
    unequip(s, u, 'mount');
    expect(u.mp).toBe(2);
    equip(s, u, 'plate');
    expect(u.mp).toBe(1);
  });

  it('unequips to the stockpile', () => {
    const { s, u } = armoryState();
    u.equipment.body = 'leather';
    expect(canUnequip(s, u, 'body')).toBeNull();
    expect(canUnequip(s, u, 'main')).toMatch(/nothing/i);
    expect(unequip(s, u, 'body')).toEqual([{ type: 'unitEquipped', unit: u.id, item: null, slot: 'body' }]);
    expect(s.factions.valen.stockpile.leather).toBe(1);
    expect(u.equipment.body).toBeNull();
    u.equipment.body = 'tunic';
    u.pos = at(0, 9);
    expect(canUnequip(s, u, 'body')).toMatch(/stand on/i);
    expect(unequip(s, u, 'body')).toEqual([]);
  });
});
