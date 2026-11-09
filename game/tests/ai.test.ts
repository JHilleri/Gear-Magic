// AI tests: focused decisions on hand-built states, then full AI-vs-AI games through the public
// action API driven exactly like the controller (createAiMemory → aiNextAction/applyAction until
// null → endTurn). Set AI_DEBUG=1 to print a per-10-rounds trace of every full game.
import { describe, expect, it } from 'vitest';
import type { Action, FactionId, GameEvent, GameSettings, GameState, Unit } from '../src/core/types';
import { hexDistance, hexEq, tileIndex } from '../src/core/hex';
import { createGame, currentFaction } from '../src/sim/state';
import { applyAction, validateAction } from '../src/sim/actions';
import { startTurn } from '../src/sim/turn';
import { manaCap } from '../src/sim/spells';
import { AI_STEP_CAP, aiNextAction, createAiMemory } from '../src/sim/ai/index';
import { at, makeTestBuilding, makeTestState, makeTestUnit, res, setTerrain } from './helpers';

const nodeProc = (globalThis as { process?: { env: Record<string, string | undefined>; stderr: { write(s: string): void } } }).process;
const VERBOSE = !!nodeProc?.env.AI_DEBUG;
/** Test output (vitest hides console.log of passing tests). */
const out = (...parts: unknown[]) => nodeProc?.stderr.write(parts.map(String).join(' ') + '\n');

// ───────────────────────────── helpers ─────────────────────────────

/** A two-faction test map where `thorn` is the AI to move (valen stays human, idle). */
function aiState(width = 14, height = 12): GameState {
  const s = makeTestState(width, height);
  s.currentTurn = 1; // thorn
  s.factions.thorn.resources = res({ gold: 200, food: 100, wood: 100, stone: 100, iron: 40, crystal: 40, mana: 0 });
  return s;
}

/** Play the AI's whole turn without ending it; returns the actions it took. */
function playTurn(s: GameState, f: FactionId = currentFaction(s)): Action[] {
  const mem = createAiMemory(s, f);
  const acts: Action[] = [];
  for (let i = 0; i < AI_STEP_CAP + 5; i++) {
    const a = aiNextAction(s, mem);
    if (!a) return acts;
    expect(validateAction(s, a)).toBeNull();
    const r = applyAction(s, a);
    expect(r.ok).toBe(true);
    acts.push(a);
    if (s.gameOver || currentFaction(s) !== f) return acts;
  }
  throw new Error('AI turn did not terminate');
}

/** First action of a given type in the AI's turn (actions before it are applied). */
function firstOfType<T extends Action['type']>(s: GameState, type: T): Extract<Action, { type: T }> | undefined {
  return playTurn(s).find((a) => a.type === type) as Extract<Action, { type: T }> | undefined;
}

// ───────────────────────────── decisions ─────────────────────────────

describe('AI decisions', () => {
  it('creates a fresh memory and stays out of turns that are not its own', () => {
    const s = aiState();
    const mem = createAiMemory(s, 'valen');
    expect(mem).toMatchObject({ faction: 'valen', step: 0 });
    expect(mem.failed.size).toBe(0);
    expect(aiNextAction(s, mem)).toBeNull();          // thorn's turn
    s.gameOver = true;
    expect(aiNextAction(s, createAiMemory(s, 'thorn'))).toBeNull();
  });

  it('picks a research project when idle', () => {
    const s = aiState();
    makeTestUnit(s, 'thorn', at(2, 2), { isLeader: true });
    const a = aiNextAction(s, createAiMemory(s, 'thorn'));
    expect(a).toEqual({ type: 'research', faction: 'thorn', tech: 'writing' });
  });

  it('resolves level-ups gained during its own turn', () => {
    const s = aiState();
    s.factions.thorn.researching = 'writing';
    const u = makeTestUnit(s, 'thorn', at(2, 2), {
      items: ['sword'], pendingLevelUps: 1, levelUpOptions: [['stat_str', 'stat_vis', 'eff_farming']],
    });
    const a = aiNextAction(s, createAiMemory(s, 'thorn'));
    expect(a).toEqual({ type: 'levelup', unit: u.id, option: 'stat_str' });
  });

  it('focuses the wounded enemy it can kill', () => {
    const s = aiState();
    s.factions.thorn.researching = 'writing';
    makeTestUnit(s, 'thorn', at(10, 9), { isLeader: true });
    const me = makeTestUnit(s, 'thorn', at(5, 5), { items: ['sword', 'tunic'] });
    const healthy = makeTestUnit(s, 'valen', at(6, 5));
    const wounded = makeTestUnit(s, 'valen', at(4, 5), { hp: 4 });
    const atk = firstOfType(s, 'attack');
    expect(atk?.unit).toBe(me.id);
    expect(atk?.target).toBe(wounded.id);
    void healthy;
  });

  it('goes for the enemy leader when it can strike it', () => {
    const s = aiState();
    s.factions.thorn.researching = 'writing';
    makeTestUnit(s, 'thorn', at(12, 10), { isLeader: true });
    makeTestUnit(s, 'thorn', at(5, 5), { items: ['axe'] });
    const leader = makeTestUnit(s, 'valen', at(6, 5), { isLeader: true, hp: 10 });
    makeTestUnit(s, 'valen', at(4, 5));
    expect(firstOfType(s, 'attack')?.target).toBe(leader.id);
  });

  it('archers shoot melee units from two hexes away (no retaliation)', () => {
    const s = aiState();
    s.factions.thorn.researching = 'writing';
    makeTestUnit(s, 'thorn', at(12, 10), { isLeader: true });
    const archer = makeTestUnit(s, 'thorn', at(2, 5), { items: ['bow', 'leather'] });
    const target = makeTestUnit(s, 'valen', at(6, 5), { items: ['sword'] });
    const acts = playTurn(s);
    const atk = acts.find((a) => a.type === 'attack');
    expect(atk).toMatchObject({ unit: archer.id, target: target.id, kind: 'ranged' });
    expect(hexDistance(s.units[String(archer.id)].pos, target.pos)).toBe(2);
  });

  it('does not throw a commoner at a golem', () => {
    const s = aiState();
    s.factions.thorn.researching = 'writing';
    makeTestUnit(s, 'thorn', at(12, 10), { isLeader: true });
    const c = makeTestUnit(s, 'thorn', at(5, 5));
    const golem = makeTestUnit(s, 'neutral', at(6, 5), {
      monster: 'golem', race: 'monster', base: { maxHp: 48, str: 8, dex: 0, int: 0, armor: 30, mov: 3, vis: 3 }, hp: 48, level: 3,
    });
    const acts = playTurn(s);
    expect(acts.some((a) => a.type === 'attack' && a.target === golem.id)).toBe(false);
    void c;
  });

  it('pulls a badly wounded unit back to a healing building', () => {
    const s = aiState();
    s.factions.thorn.researching = 'writing';
    makeTestUnit(s, 'thorn', at(12, 10), { isLeader: true });
    const house = makeTestBuilding(s, 'house', 'thorn', at(2, 5));
    const hurt = makeTestUnit(s, 'thorn', at(5, 5), { items: ['sword'], hp: 5 });
    makeTestUnit(s, 'valen', at(8, 5), { items: ['sword'] });
    playTurn(s);
    expect(hexEq(s.units[String(hurt.id)].pos, house.pos)).toBe(true);
  });

  it('brings its leader home to the castle', () => {
    const s = aiState();
    s.factions.thorn.researching = 'writing';
    const castle = makeTestBuilding(s, 'castle', 'thorn', at(3, 3));
    const leader = makeTestUnit(s, 'thorn', at(6, 4), { isLeader: true, items: ['sword'] });
    playTurn(s);
    expect(hexEq(s.units[String(leader.id)].pos, castle.pos)).toBe(true);
  });

  it('recruits from the castle while the army is small', () => {
    const s = aiState();
    s.factions.thorn.researching = 'writing';
    const castle = makeTestBuilding(s, 'castle', 'thorn', at(3, 3));
    makeTestBuilding(s, 'farm', 'thorn', at(4, 3));
    makeTestBuilding(s, 'farm', 'thorn', at(3, 4));
    makeTestUnit(s, 'thorn', castle.pos, { isLeader: true, items: ['sword'] });
    makeTestUnit(s, 'thorn', at(2, 2), { items: ['tools'] });
    const acts = playTurn(s);
    expect(acts.some((a) => a.type === 'recruit' && a.site === castle.id)).toBe(true);
  });

  it('crafts and equips weapons for unarmed units standing on an armory', () => {
    const s = aiState();
    s.factions.thorn.researching = 'writing';
    makeTestBuilding(s, 'castle', 'thorn', at(3, 3));
    const forge = makeTestBuilding(s, 'forge', 'thorn', at(6, 6));
    makeTestUnit(s, 'thorn', at(3, 3), { isLeader: true, items: ['sword'] });
    const militia = makeTestUnit(s, 'thorn', forge.pos);
    const acts = playTurn(s);
    expect(acts.some((a) => a.type === 'craft' && a.forge === forge.id)).toBe(true);
    const u = s.units[String(militia.id)];
    expect(u.equipment.main).not.toBeNull();
    expect(acts.some((a) => a.type === 'equip' && a.unit === militia.id)).toBe(true);
  });

  it('arms unarmed units with the weapons already in the stockpile', () => {
    for (const item of ['sword', 'spear'] as const) {
      const s = aiState();
      s.factions.thorn.researching = 'writing';
      s.factions.thorn.techs.push('polearms');
      s.factions.thorn.resources.iron = 0;
      s.factions.thorn.stockpile = { [item]: 1 };
      makeTestBuilding(s, 'castle', 'thorn', at(3, 3));
      const forge = makeTestBuilding(s, 'forge', 'thorn', at(6, 6));
      makeTestUnit(s, 'thorn', at(3, 3), { isLeader: true, items: ['sword'] });
      const militia = makeTestUnit(s, 'thorn', forge.pos);
      expect(militia.id % 3).toBe(1); // a unit whose own taste is the axe
      playTurn(s);
      expect(s.units[String(militia.id)].equipment.main).toBe(item);
      expect(s.factions.thorn.stockpile[item] ?? 0).toBe(0);
    }
  });

  it('casts Healing Light on wounded allies', () => {
    const s = aiState();
    const fs = s.factions.thorn;
    fs.researching = 'writing';
    fs.techs = ['crystallore', 'arcana', 'spell_heal'];
    fs.resources.mana = 60;
    const tower = makeTestBuilding(s, 'magetower', 'thorn', at(3, 3));
    makeTestUnit(s, 'thorn', at(12, 10), { isLeader: true });
    const a = makeTestUnit(s, 'thorn', at(5, 5), { hp: 6, items: ['sword'], mp: 0 });
    const b = makeTestUnit(s, 'thorn', at(6, 5), { hp: 7, items: ['sword'], mp: 0 });
    const cast = firstOfType(s, 'cast');
    expect(cast).toMatchObject({ spell: 'heal', tower: tower.id });
    expect(hexDistance(cast!.target, a.pos)).toBeLessThanOrEqual(1);
    expect(hexDistance(cast!.target, b.pos)).toBeLessThanOrEqual(1);
  });

  it('drops a Fireball on a cluster of enemies, away from its own troops', () => {
    const s = aiState();
    const fs = s.factions.thorn;
    fs.researching = 'writing';
    fs.techs = ['crystallore', 'arcana', 'spell_fireball'];
    fs.resources.mana = 60;
    makeTestBuilding(s, 'magetower', 'thorn', at(3, 3));
    makeTestUnit(s, 'thorn', at(1, 1), { isLeader: true });
    const foes = [at(7, 6), at(8, 6), at(7, 7)].map((h) => makeTestUnit(s, 'valen', h, { items: ['sword'] }));
    const cast = firstOfType(s, 'cast');
    expect(cast?.spell).toBe('fireball');
    expect(foes.filter((f) => hexDistance(f.pos, cast!.target) <= 1).length).toBeGreaterThanOrEqual(2);
  });

  it('casts Healing Light on the cluster a tower can reach, not on a bigger one out of range', () => {
    const s = aiState(30, 12);
    const fs = s.factions.thorn;
    fs.researching = 'writing';
    fs.techs = ['crystallore', 'arcana', 'spell_heal'];
    fs.resources.mana = 60;
    const tower = makeTestBuilding(s, 'magetower', 'thorn', at(3, 5));
    makeTestUnit(s, 'thorn', at(1, 1), { isLeader: true });
    // A badly hurt trio far out of reach, and one wounded pair within the tower's 6 hexes.
    for (const h of [at(24, 5), at(25, 5), at(24, 6)]) makeTestUnit(s, 'thorn', h, { hp: 3, items: ['sword'], mp: 0 });
    const near = [at(6, 5), at(7, 5)].map((h) => makeTestUnit(s, 'thorn', h, { hp: 8, items: ['sword'], mp: 0 }));
    const cast = firstOfType(s, 'cast');
    expect(cast).toMatchObject({ spell: 'heal', tower: tower.id });
    expect(near.every((u) => hexDistance(cast!.target, u.pos) <= 1)).toBe(true);
  });

  it('drops a Fireball on the reachable cluster when a bigger one stands out of range', () => {
    const s = aiState(30, 12);
    const fs = s.factions.thorn;
    fs.researching = 'writing';
    fs.techs = ['crystallore', 'arcana', 'spell_fireball'];
    fs.resources.mana = 60;
    makeTestBuilding(s, 'magetower', 'thorn', at(3, 5));
    makeTestUnit(s, 'thorn', at(1, 1), { isLeader: true });
    for (const h of [at(24, 5), at(25, 5), at(24, 6), at(25, 6)]) makeTestUnit(s, 'valen', h, { items: ['sword'] });
    const near = [at(8, 5), at(9, 5), at(8, 6)].map((h) => makeTestUnit(s, 'valen', h, { items: ['sword'] }));
    const cast = firstOfType(s, 'cast');
    expect(cast?.spell).toBe('fireball');
    expect(near.filter((f) => hexDistance(f.pos, cast!.target) <= 1).length).toBeGreaterThanOrEqual(2);
  });

  it('casts Farsight into the fog when the mana pool is nearly full', () => {
    const s = aiState(30, 12);
    const fs = s.factions.thorn;
    fs.researching = 'writing';
    fs.techs = ['crystallore', 'arcana', 'spell_farsight'];
    fs.resources.mana = 145; // cap 150 with one tower
    makeTestBuilding(s, 'magetower', 'thorn', at(3, 5));
    makeTestBuilding(s, 'castle', 'thorn', at(2, 2));
    makeTestUnit(s, 'thorn', at(2, 2), { isLeader: true });
    makeTestBuilding(s, 'castle', 'valen', at(26, 6));
    makeTestUnit(s, 'valen', at(26, 6), { isLeader: true });
    // Thorn sees only its corner of the map.
    for (let i = 0; i < s.width * s.height; i++) s.factions.thorn.visible[i] = 0;
    for (const u of Object.values(s.units)) if (u.faction === 'thorn') s.factions.thorn.visible[tileIndex(u.pos, s.width)] = 1;
    const cast = firstOfType(s, 'cast');
    expect(cast?.spell).toBe('farsight');
  });

  it('keeps a Fireball\'s mana: no Farsight that would drop the pool below one', () => {
    const setup = (mana: number) => {
      const s = aiState(30, 12);
      const fs = s.factions.thorn;
      fs.researching = 'writing';
      fs.techs = ['crystallore', 'arcana', 'spell_farsight', 'spell_fireball'];
      fs.resources.mana = mana; // cap 150 with one tower: far from full
      makeTestBuilding(s, 'magetower', 'thorn', at(3, 5));
      makeTestBuilding(s, 'castle', 'thorn', at(2, 2));
      const farm = makeTestBuilding(s, 'farm', 'thorn', at(6, 5));
      makeTestUnit(s, 'thorn', at(2, 2), { isLeader: true });
      makeTestBuilding(s, 'castle', 'valen', at(26, 6));
      makeTestUnit(s, 'valen', at(26, 6), { isLeader: true });
      // A lone raider at our farm (not worth a Fireball) makes a look around worthwhile.
      const raider = makeTestUnit(s, 'valen', at(8, 5), { items: ['sword'] });
      for (let i = 0; i < s.width * s.height; i++) fs.visible[i] = 0;
      for (const h of [...Object.values(s.units).filter((u) => u.faction === 'thorn').map((u) => u.pos), raider.pos, farm.pos]) {
        fs.visible[tileIndex(h, s.width)] = 1;
      }
      return s;
    };
    expect(playTurn(setup(35)).some((a) => a.type === 'cast')).toBe(false);   // 35 − 10 < 30
    expect(firstOfType(setup(45), 'cast')?.spell).toBe('farsight');           // 45 − 10 ≥ 30
  });

  it('summons a Stone Elemental beside a building raiders stand at', () => {
    const s = aiState(20, 12);
    const fs = s.factions.thorn;
    fs.researching = 'writing';
    fs.techs = ['crystallore', 'arcana', 'spell_fireball', 'wandcraft', 'jewelcraft', 'spell_summon'];
    fs.resources.mana = 60;
    makeTestBuilding(s, 'magetower', 'thorn', at(3, 5));
    const farm = makeTestBuilding(s, 'farm', 'thorn', at(6, 5));
    makeTestUnit(s, 'thorn', at(1, 1), { isLeader: true });
    const raiders = [at(7, 5), at(7, 6)].map((h) => makeTestUnit(s, 'valen', h, { items: ['sword'] }));
    expect(raiders.every((r) => hexDistance(r.pos, farm.pos) <= 1)).toBe(true);
    const cast = firstOfType(s, 'cast');
    expect(cast?.spell).toBe('summon');
    expect(hexDistance(cast!.target, farm.pos)).toBeLessThanOrEqual(3);
    expect(Object.values(s.units).some((u) => u.faction === 'thorn' && u.monster === 'elemental')).toBe(true);
  });

  it('learns Healing Light, then the house\'s signature spell, as soon as Arcana is known', () => {
    for (const [f, signature] of [['thorn', 'spell_fireball'], ['ashen', 'spell_fireball'], ['valen', 'spell_bless']] as const) {
      const s = makeTestState(14, 12);
      s.turnOrder = ['valen', 'thorn', 'ashen'];
      s.factions.ashen = { ...s.factions.thorn, id: 'ashen', stats: { ...s.factions.thorn.stats } };
      s.factions.valen.isHuman = false;
      s.currentTurn = s.turnOrder.indexOf(f);
      const fs = s.factions[f];
      fs.techs = ['writing', 'mining', 'tanning', 'polearms', 'crystallore', 'arcana'];
      makeTestBuilding(s, 'library', f, at(4, 4));
      makeTestUnit(s, f, at(2, 2), { isLeader: true });
      expect(aiNextAction(s, createAiMemory(s, f))).toEqual({ type: 'research', faction: f, tech: 'spell_heal' });
      fs.techs.push('spell_heal');
      expect(aiNextAction(s, createAiMemory(s, f))).toEqual({ type: 'research', faction: f, tech: signature });
    }
  });

  it('takes the magic road right after Mining once a library stands (Thorn: Tanning first)', () => {
    const s = aiState();
    const fs = s.factions.thorn;
    fs.techs = ['polearms', 'writing', 'mining'];
    makeTestBuilding(s, 'library', 'thorn', at(4, 4));
    makeTestUnit(s, 'thorn', at(2, 2), { isLeader: true });
    expect(aiNextAction(s, createAiMemory(s, 'thorn'))).toEqual({ type: 'research', faction: 'thorn', tech: 'tanning' });
    fs.techs.push('tanning');
    expect(aiNextAction(s, createAiMemory(s, 'thorn'))).toEqual({ type: 'research', faction: 'thorn', tech: 'crystallore' });
  });

  it('a mage holds its tower to channel instead of chasing a raider across the fields', () => {
    const s = aiState(20, 14);
    const fs = s.factions.thorn;
    fs.researching = 'writing';
    fs.techs = ['crystallore', 'arcana'];
    const castle = makeTestBuilding(s, 'castle', 'thorn', at(3, 3));
    const tower = makeTestBuilding(s, 'magetower', 'thorn', at(3, 7));
    makeTestUnit(s, 'thorn', castle.pos, { isLeader: true, items: ['sword', 'leather'] });
    const mage = makeTestUnit(s, 'thorn', at(5, 11), { items: ['staff', 'robe'] });
    // An armed raider near the castle, out of the mage's striking reach this turn.
    const raider = makeTestUnit(s, 'valen', at(9, 2), { items: ['sword'] });
    expect(hexDistance(raider.pos, castle.pos)).toBeLessThanOrEqual(7);
    expect(hexDistance(raider.pos, mage.pos)).toBeGreaterThan(7);
    expect(hexDistance(raider.pos, mage.pos)).toBeLessThanOrEqual(12);
    const acts = playTurn(s);
    expect(acts.some((a) => a.type === 'attack' && a.unit === mage.id)).toBe(false);
    expect(hexEq(s.units[String(mage.id)].pos, tower.pos)).toBe(true);
  });

  it('holds back the first tower\'s crystal while Arcana is being researched', () => {
    const s = aiState();
    const fs = s.factions.thorn;
    fs.techs = ['polearms', 'tanning', 'writing', 'mining', 'crystallore', 'wandcraft', 'jewelcraft'];
    fs.researching = 'arcana';
    fs.researchProgress = 10;
    fs.resources = res({ gold: 200, food: 100, wood: 100, stone: 100, iron: 40, crystal: 9, mana: 0 });
    makeTestBuilding(s, 'castle', 'thorn', at(3, 3));
    makeTestBuilding(s, 'library', 'thorn', at(8, 8));
    const forge = makeTestBuilding(s, 'forge', 'thorn', at(6, 6));
    makeTestUnit(s, 'thorn', at(3, 3), { isLeader: true, items: ['sword', 'leather'] });
    makeTestUnit(s, 'thorn', at(1, 1), { items: ['tools', 'tunic'] });
    // Fighters who would love an Amulet of Vigor (3 crystal each) and a mage a Ring of Focus (4).
    makeTestUnit(s, 'thorn', at(2, 5), { items: ['sword', 'leather'] });
    makeTestUnit(s, 'thorn', forge.pos, { items: ['sword', 'leather'] });
    makeTestUnit(s, 'thorn', at(5, 3), { items: ['wand', 'tunic'] });
    const acts = playTurn(s);
    expect(s.factions.thorn.researching).toBe('arcana');
    expect(acts.some((a) => a.type === 'craft' && (a.item === 'amulet' || a.item === 'ring' || a.item === 'wand'))).toBe(false);
    expect(s.factions.thorn.resources.crystal).toBeGreaterThanOrEqual(8);
    // Once the tower stands, the crystal is free for trinkets again.
    fs.researching = 'writing';
    makeTestBuilding(s, 'magetower', 'thorn', at(8, 3));
    s.currentTurn = 1;
    for (const u of Object.values(s.units)) { u.acted = false; u.mp = 5; }
    for (const b of Object.values(s.buildings)) { b.craftedThisTurn = 0; b.recruitedThisTurn = false; }
    expect(playTurn(s).some((a) => a.type === 'craft' && (a.item === 'amulet' || a.item === 'ring'))).toBe(true);
  });

  it('a commoner squatting on the planned building site steps aside so the builder can start', () => {
    const s = aiState(14, 12);
    const fs = s.factions.thorn;
    fs.researching = 'writing';
    fs.techs = ['mining'];
    fs.resources = res({ gold: 30, food: 60, wood: 20, stone: 20, iron: 0, crystal: 0, mana: 0 });
    const C = at(5, 5);
    makeTestBuilding(s, 'castle', 'thorn', C);
    for (const [t, h] of [['farm', at(6, 5)], ['farm', at(4, 5)], ['lumber', at(5, 4)], ['quarry', at(6, 4)],
      ['forge', at(4, 6)], ['house', at(5, 6)], ['house', at(4, 4)], ['training', at(6, 6)], ['farm', at(3, 5)]] as const) {
      makeTestBuilding(s, t, 'thorn', h);
    }
    // The only iron deposit in reach, with one of our own commoners standing on it.
    const site = at(7, 5);
    setTerrain(s, site, 'hills');
    s.tiles[tileIndex(site, s.width)].deposit = 'iron';
    makeTestUnit(s, 'thorn', C, { isLeader: true, items: ['sword'] });
    const squatter = makeTestUnit(s, 'thorn', site);
    // Every post an idle commoner could take is already manned: the squatter has no errand.
    for (const h of [at(6, 6), at(6, 5), at(4, 5), at(5, 4), at(6, 4), at(3, 5)]) makeTestUnit(s, 'thorn', h);
    const builder = makeTestUnit(s, 'thorn', at(8, 5), { items: ['tools'] });
    const acts = playTurn(s);
    expect(acts.some((a) => a.type === 'move' && a.unit === squatter.id)).toBe(true);
    expect(acts.some((a) => a.type === 'build' && a.unit === builder.id && a.building === 'mine')).toBe(true);
    expect(Object.values(s.buildings).some((b) => b.type === 'mine' && hexEq(b.pos, site))).toBe(true);
  });

  it('keeps the forge\'s iron: without a forge, two recruit sites buy one sword, not two', () => {
    const s = aiState();
    const fs = s.factions.thorn;
    fs.researching = 'writing';
    fs.resources = res({ gold: 200, food: 100, wood: 30, stone: 20, iron: 12, crystal: 0, mana: 0 });
    const castle = makeTestBuilding(s, 'castle', 'thorn', at(3, 3));
    makeTestBuilding(s, 'training', 'thorn', at(5, 5));
    makeTestBuilding(s, 'farm', 'thorn', at(4, 3));
    makeTestBuilding(s, 'farm', 'thorn', at(3, 4));
    makeTestUnit(s, 'thorn', castle.pos, { isLeader: true, items: ['sword'] });
    // The one builder is busy on its site (no free builder: nothing planned, nothing reserved by plans).
    const site = makeTestBuilding(s, 'house', 'thorn', at(2, 3), { buildLeft: 2 });
    makeTestUnit(s, 'thorn', site.pos, { items: ['tools'] });
    const acts = playTurn(s);
    const swords = acts.filter((a) => a.type === 'recruit' && a.preset === 'swordsman').length;
    expect(swords).toBeLessThanOrEqual(1);
    expect(fs.resources.iron).toBeGreaterThanOrEqual(6);
  });

  it('raises no rich levy it cannot arm (no forge, no iron, no stock)', () => {
    const s = aiState();
    const fs = s.factions.thorn;
    fs.researching = 'writing';
    fs.resources = res({ gold: 200, food: 100, wood: 50, stone: 50, iron: 0, crystal: 0, mana: 0 });
    const castle = makeTestBuilding(s, 'castle', 'thorn', at(3, 3));
    makeTestBuilding(s, 'house', 'thorn', at(5, 5));
    makeTestBuilding(s, 'farm', 'thorn', at(4, 3));
    makeTestBuilding(s, 'farm', 'thorn', at(3, 4));
    makeTestUnit(s, 'thorn', castle.pos, { isLeader: true, items: ['sword'] });
    makeTestUnit(s, 'thorn', at(2, 5), { items: ['tools'] });
    makeTestUnit(s, 'thorn', at(6, 3), { items: ['sword'] });
    makeTestUnit(s, 'thorn', at(6, 2), { items: ['sword'] });
    const acts = playTurn(s);
    expect(acts.some((a) => a.type === 'recruit' && a.preset === 'commoner')).toBe(false);
  });

  it('caps emergency levies: a castle threat does not raise a fist-fighter every turn', () => {
    const s = aiState();
    const fs = s.factions.thorn;
    fs.researching = 'writing';
    fs.resources = res({ gold: 200, food: 100, wood: 50, stone: 50, iron: 0, crystal: 0, mana: 0 });
    const castle = makeTestBuilding(s, 'castle', 'thorn', at(3, 3));
    makeTestBuilding(s, 'house', 'thorn', at(2, 5));
    makeTestBuilding(s, 'farm', 'thorn', at(4, 3));
    makeTestBuilding(s, 'farm', 'thorn', at(3, 4));
    makeTestUnit(s, 'thorn', castle.pos, { isLeader: true, items: ['sword'] });
    makeTestUnit(s, 'thorn', at(1, 1), { items: ['tools'] });
    for (const h of [at(2, 2), at(4, 2), at(2, 4)]) makeTestUnit(s, 'thorn', h);
    makeTestUnit(s, 'valen', at(7, 3), { items: ['sword'] }); // armed, 4 hexes from the castle
    const acts = playTurn(s);
    expect(acts.some((a) => a.type === 'recruit' && a.preset === 'commoner')).toBe(false);
  });

  it('a house that lost every builder recruits one first, even with a foe near the castle', () => {
    const s = aiState();
    const fs = s.factions.thorn;
    fs.researching = 'writing';
    fs.resources = res({ gold: 60, food: 40, wood: 5, stone: 10, iron: 2, crystal: 0, mana: 0 });
    const castle = makeTestBuilding(s, 'castle', 'thorn', at(3, 3));
    makeTestBuilding(s, 'farm', 'thorn', at(4, 3));
    makeTestBuilding(s, 'farm', 'thorn', at(3, 4));
    makeTestUnit(s, 'thorn', castle.pos, { isLeader: true, items: ['sword', 'plate'] });
    makeTestUnit(s, 'thorn', at(2, 2), { items: ['sword'] });
    makeTestUnit(s, 'valen', at(8, 3), { items: ['sword'] }); // armed, 5 hexes out
    const acts = playTurn(s);
    expect(acts.some((a) => a.type === 'recruit' && a.preset === 'builder')).toBe(true);
  });

  it('two AIs do not both gang up on the player: only the nearer one keeps the player bias', () => {
    const targetOf = (s: GameState, f: FactionId) => {
      s.currentTurn = s.turnOrder.indexOf(f);
      const mem = createAiMemory(s, f);
      aiNextAction(s, mem);
      return ((mem.data.turn as { strategy?: { target: FactionId | null } }).strategy)?.target ?? null;
    };
    const triangle = (difficulty: GameSettings['difficulty'], vPos = at(15, 3)) => {
      const s = makeTestState(30, 26);
      s.settings.difficulty = difficulty;
      s.factions.ashen = { ...structuredClone(s.factions.thorn), id: 'ashen' };
      s.turnOrder = ['valen', 'thorn', 'ashen'];
      // The AIs sit 14 apart; the player ~17 from each (ashen wins the tie for "nearest AI").
      const seats: [FactionId, ReturnType<typeof at>][] = [['valen', vPos], ['thorn', at(8, 20)], ['ashen', at(22, 20)]];
      for (const [f, h] of seats) {
        makeTestBuilding(s, 'castle', f, h);
        makeTestUnit(s, f, h, { isLeader: true, items: ['sword'] });
        s.factions[f].researching = 'writing';
      }
      return s;
    };
    // Near-equilateral: at most one AI marches on the player.
    for (const diff of ['normal', 'hard'] as const) {
      const s = triangle(diff);
      const targets = [targetOf(s, 'thorn'), targetOf(s, 'ashen')];
      expect(targets.filter((t) => t === 'valen').length).toBeLessThanOrEqual(1);
    }
    // Easy: no player bias at all, plain distance (valen slightly farther from thorn than ashen is).
    const e = triangle('easy', at(17, 3));
    expect(targetOf(e, 'thorn')).toBe('ashen');
    // Raiders: ashen fighters among thorn's buildings make ashen thorn's war target.
    const r = triangle('hard', at(12, 8));
    expect(targetOf(r, 'thorn')).toBe('valen');
    makeTestBuilding(r, 'farm', 'thorn', at(7, 19));
    for (const h of [at(8, 18), at(8, 19), at(9, 19)]) makeTestUnit(r, 'ashen', h, { items: ['sword'] });
    expect(targetOf(r, 'thorn')).toBe('ashen');
  });

  it('never repeats an action the caller reported as failed, and always terminates', () => {
    const s = aiState();
    s.factions.thorn.researching = 'writing';
    makeTestBuilding(s, 'castle', 'thorn', at(3, 3));
    makeTestUnit(s, 'thorn', at(3, 3), { isLeader: true, items: ['sword'] });
    for (const h of [at(5, 5), at(6, 6), at(2, 7)]) makeTestUnit(s, 'thorn', h, { items: ['sword'] });
    makeTestUnit(s, 'valen', at(8, 6));
    const mem = createAiMemory(s, 'thorn');
    const seen = new Set<string>();
    let n = 0;
    for (; n < AI_STEP_CAP + 5; n++) {
      const a = aiNextAction(s, mem);
      if (!a) break;
      const key = JSON.stringify(a);
      expect(mem.failed.has(key)).toBe(false);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      mem.failed.add(key);          // pretend everything fails, like a hostile controller
    }
    expect(n).toBeLessThanOrEqual(AI_STEP_CAP);
  });
});

// ───────────────────────────── full games ─────────────────────────────

interface FactionSummary {
  alive: boolean; units: number; buildings: number; techs: number; kills: number; lost: number; built: number;
  armed: number; spells: number; maxLevel: number;
}
interface GameSummary {
  seed: number; size: GameSettings['mapSize']; factions: number; rounds: number; winner: FactionId | null;
  actions: number; turns: number; avgTurnMs: number; p95TurnMs: number; maxTurnMs: number; combats: number;
  maxActionsInTurn: number; perFaction: Record<string, FactionSummary>; actionTypes: Record<string, number>;
  peakArmed: number; peakBuildings: number;
}

function summarize(s: GameState): Record<string, FactionSummary> {
  const res: Record<string, FactionSummary> = {};
  for (const f of s.turnOrder) {
    const fs = s.factions[f];
    const units = Object.values(s.units).filter((u) => u.faction === f);
    res[f] = {
      alive: fs.alive, units: units.length,
      buildings: Object.values(s.buildings).filter((b) => b.owner === f).length,
      techs: fs.techs.length, kills: fs.stats.kills, lost: fs.stats.lost, built: fs.stats.built,
      armed: units.filter((u) => u.equipment.main && u.equipment.main !== 'tools').length,
      spells: fs.stats.spellsCast, maxLevel: units.reduce((m, u) => Math.max(m, u.level), 0),
    };
  }
  return res;
}

const isArmedUnit = (u: Unit) => !!u.equipment.main && u.equipment.main !== 'tools';

/** One whole game with every faction AI-controlled, driven like game/controller.ts. */
function playAiGame(settings: GameSettings, maxRounds = 200): GameSummary {
  const s = createGame(settings);
  for (const f of s.turnOrder) s.factions[f].isHuman = false;
  startTurn(s, s.turnOrder[s.currentTurn]);
  let actions = 0, combats = 0, maxActionsInTurn = 0, peakArmed = 0, peakBuildings = 0;
  const turnMs: number[] = [];
  const actionTypes: Record<string, number> = {};
  let lastRound = s.round;
  while (!s.gameOver && s.round <= maxRounds) {
    const f = currentFaction(s);
    const mem = createAiMemory(s, f);
    let n = 0;
    let ms = 0;
    for (;;) {
      const t0 = performance.now();
      const a = aiNextAction(s, mem);
      ms += performance.now() - t0;
      if (!a) break;
      const key = JSON.stringify(a);
      if (mem.failed.has(key)) throw new Error(`AI repeated a failed action: ${key}`);
      const err = validateAction(s, a);
      if (err) throw new Error(`invalid AI action (${err}) ${key} [round ${s.round} ${f} phase ${mem.phase}]`);
      const r = applyAction(s, a);
      if (!r.ok) throw new Error(`AI action rejected: ${r.error} ${key}`);
      actionTypes[a.type] = (actionTypes[a.type] ?? 0) + 1;
      for (const e of r.events) if (e.type === 'combat') combats++;
      if (++n > AI_STEP_CAP) throw new Error(`AI action loop: ${f} round ${s.round} phase ${mem.phase}`);
      if (s.gameOver || currentFaction(s) !== f) break;
    }
    turnMs.push(ms);
    actions += n;
    maxActionsInTurn = Math.max(maxActionsInTurn, n);
    if (s.gameOver) break;
    const r = applyAction(s, { type: 'endTurn', faction: f });
    if (!r.ok) throw new Error(`endTurn rejected: ${r.error}`);
    for (const e of r.events) if (e.type === 'combat') combats++;
    for (const g of s.turnOrder) {
      peakArmed = Math.max(peakArmed, Object.values(s.units).filter((u) => u.faction === g && isArmedUnit(u)).length);
      peakBuildings = Math.max(peakBuildings, Object.values(s.buildings).filter((b) => b.owner === g).length);
    }
    if (VERBOSE && s.round !== lastRound && s.round % 10 === 0) out(`  r${s.round}`, JSON.stringify(summarize(s)));
    lastRound = s.round;
  }
  const sorted = turnMs.slice().sort((a, b) => a - b);
  return {
    seed: settings.seed, size: settings.mapSize, factions: s.turnOrder.length, rounds: s.round, winner: s.winner,
    actions, turns: turnMs.length, combats, maxActionsInTurn, actionTypes, peakArmed, peakBuildings,
    avgTurnMs: Math.round((turnMs.reduce((a, b) => a + b, 0) / Math.max(1, turnMs.length)) * 10) / 10,
    p95TurnMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
    maxTurnMs: Math.round(sorted[sorted.length - 1] ?? 0),
    perFaction: summarize(s),
  };
}

function fmt(g: GameSummary): string {
  const fac = Object.entries(g.perFaction)
    .map(([f, x]) => `${f}${x.alive ? '' : '†'}[units ${x.units} bld ${x.buildings} tech ${x.techs} kills ${x.kills} lost ${x.lost} armed ${x.armed} spells ${x.spells} lvl ${x.maxLevel}]`)
    .join(' ');
  return `seed ${g.seed} ${g.size} ${g.factions}f → ${g.winner ?? 'no winner'} at round ${g.rounds} | ${g.actions} actions, `
    + `${g.combats} combats | AI turn avg ${g.avgTurnMs}ms p95 ${g.p95TurnMs}ms max ${g.maxTurnMs}ms | ${fac}`;
}

const GAMES: { seed: number; mapSize: GameSettings['mapSize']; aiCount: number }[] = [
  { seed: 101, mapSize: 'normal', aiCount: 1 },
  { seed: 102, mapSize: 'normal', aiCount: 1 },
  { seed: 103, mapSize: 'small', aiCount: 1 },
  { seed: 104, mapSize: 'normal', aiCount: 2 },
  { seed: 105, mapSize: 'large', aiCount: 2 },
  { seed: 106, mapSize: 'small', aiCount: 2 },
];

describe('AI-vs-AI full games', () => {
  const results: GameSummary[] = [];

  for (const g of GAMES) {
    it(`seed ${g.seed}: ${g.mapSize} map, ${g.aiCount + 1} factions, up to 200 rounds`, () => {
      const sum = playAiGame({ mapSize: g.mapSize, seed: g.seed, playerFaction: 'valen', aiCount: g.aiCount, difficulty: 'normal' });
      results.push(sum);
      out(fmt(sum));
      // Bounded, valid turns (invalid / repeated / looping actions throw inside playAiGame).
      expect(sum.maxActionsInTurn).toBeLessThanOrEqual(AI_STEP_CAP);
      // Economies grow: construction, research, recruiting, crafting and equipping all happen.
      expect(sum.actionTypes.build ?? 0).toBeGreaterThan(10);
      expect(sum.actionTypes.research ?? 0).toBeGreaterThan(1);
      expect(sum.actionTypes.recruit ?? 0).toBeGreaterThan(10);
      expect(sum.actionTypes.craft ?? 0).toBeGreaterThan(5);
      expect(sum.actionTypes.equip ?? 0).toBeGreaterThan(5);
      expect(sum.peakBuildings).toBeGreaterThanOrEqual(12);
      expect(sum.peakArmed).toBeGreaterThanOrEqual(5);
      // Research before libraries is ~3 points a turn (the castle): short wars end early.
      const best = Object.values(sum.perFaction).reduce((m, x) => Math.max(m, x.techs), 0);
      expect(best).toBeGreaterThanOrEqual(Math.min(5, 1 + Math.floor(sum.rounds / 30)));
      // Combat happens, and it is not one-sided slaughter by monsters only.
      expect(sum.combats).toBeGreaterThan(20);
      expect(Object.values(sum.perFaction).some((x) => x.kills > 5)).toBe(true);
      // Fast enough for the browser (the controller yields between actions; DESIGN target < 150 ms).
      expect(sum.avgTurnMs).toBeLessThan(80);
      expect(sum.p95TurnMs).toBeLessThan(250);
    }, 300_000);
  }

  it('most games produce a winner by round 200', () => {
    expect(results.length).toBe(GAMES.length);
    const decided = results.filter((r) => r.winner !== null).length;
    out(`winners in ${decided}/${results.length} games`);
    expect(decided).toBeGreaterThanOrEqual(Math.ceil(results.length / 2));
  });

  it('is deterministic for a given seed (replays and saves agree)', () => {
    const settings: GameSettings = { mapSize: 'small', seed: 7, playerFaction: 'thorn', aiCount: 1, difficulty: 'normal' };
    const a = playAiGame(settings, 40);
    const b = playAiGame(settings, 40);
    expect(b.actions).toBe(a.actions);
    expect(b.combats).toBe(a.combats);
    expect(b.perFaction).toEqual(a.perFaction);
  }, 120_000);
});

// ───────────────────────────── seeded regressions (playtest findings) ─────────────────────────────

interface RoundStats {
  round: number;
  perFaction: Record<string, {
    buildings: number; forge: boolean; training: boolean; towers: number; unarmed: number; builders: number;
    manaFull: boolean;
  }>;
}
interface RunStats {
  rounds: RoundStats[]; attacks: Record<string, number>; spells: Record<string, number>; human: FactionId;
  /** Casts by spell kind, AI houses only. */
  aiSpellKinds: Record<string, number>;
}

/**
 * A game where every AI house plays itself; the player's house is either idle or driven by the
 * same AI while keeping isHuman (so the player-bias rules run). Per-round snapshots + attack counts.
 */
function playSeeded(settings: GameSettings, rounds: number, humanAi: boolean): RunStats {
  const s = createGame(settings);
  const human = s.turnOrder.find((f) => s.factions[f].isHuman)!;
  startTurn(s, s.turnOrder[s.currentTurn]);
  const out: RunStats = { rounds: [], attacks: {}, spells: {}, human, aiSpellKinds: {} };
  const count = (evs: { type: string }[], fac: Record<string, FactionId>) => {
    for (const e of evs as GameEvent[]) {
      if (e.type === 'combat') {
        const k = `${fac[String(e.attacker)]}>${fac[String(e.defender)]}`;
        out.attacks[k] = (out.attacks[k] ?? 0) + 1;
      } else if (e.type === 'spellCast') {
        out.spells[e.faction] = (out.spells[e.faction] ?? 0) + 1;
        if (e.faction !== human) out.aiSpellKinds[e.spell] = (out.aiSpellKinds[e.spell] ?? 0) + 1;
      }
    }
  };
  const factionsNow = () => { const m: Record<string, FactionId> = {}; for (const k in s.units) m[k] = s.units[k].faction; return m; };
  let last = s.round;
  while (!s.gameOver && s.round <= rounds) {
    const f = currentFaction(s);
    if (humanAi || f !== human) {
      const mem = createAiMemory(s, f);
      for (;;) {
        const a = aiNextAction(s, mem);
        if (!a) break;
        const fac = factionsNow();
        const r = applyAction(s, a);
        expect(r.ok).toBe(true);
        count(r.events, fac);
        if (s.gameOver || currentFaction(s) !== f) break;
      }
    }
    if (s.gameOver) break;
    const fac = factionsNow();
    count(applyAction(s, { type: 'endTurn', faction: f }).events, fac);
    if (s.round !== last) {
      last = s.round;
      const snap: RoundStats = { round: s.round, perFaction: {} };
      for (const g of s.turnOrder) {
        if (!s.factions[g].alive) continue;
        const bl = Object.values(s.buildings).filter((b) => b.owner === g);
        const us = Object.values(s.units).filter((u) => u.faction === g);
        snap.perFaction[g] = {
          buildings: bl.length,
          forge: bl.some((b) => b.type === 'forge'),
          training: bl.some((b) => b.type === 'training'),
          towers: bl.filter((b) => b.type === 'magetower' && b.buildLeft === 0).length,
          unarmed: us.filter((u) => !u.isLeader && !u.monster && !u.equipment.main).length,
          builders: us.filter((u) => !u.isLeader && u.equipment.main === 'tools').length,
          manaFull: s.factions[g].resources.mana >= manaCap(s, g) * 0.95,
        };
      }
      out.rounds.push(snap);
    }
  }
  return out;
}

const atRound = (r: RunStats, n: number) => r.rounds.find((x) => x.round === n) ?? r.rounds[r.rounds.length - 1];
const longestRun = (r: RunStats, f: string, pred: (x: RoundStats['perFaction'][string]) => boolean) => {
  let best = 0, cur = 0;
  for (const x of r.rounds) { const p = x.perFaction[f]; cur = p && pred(p) ? cur + 1 : 0; best = Math.max(best, cur); }
  return best;
};

describe('AI regressions from playtests (seeded)', () => {
  const ai = (seed: number, mapSize: GameSettings['mapSize'] = 'normal'): GameSettings =>
    ({ mapSize, seed, playerFaction: 'valen', aiCount: 2, difficulty: 'normal' });

  it('keeps the forge\'s iron: every AI house has a forge by round 20 and no unarmed glut (player idle)', () => {
    for (const seed of [544774, 1, 2, 3, 4, 5, 6]) {
      const r = playSeeded(ai(seed), 20, false);
      const snap = atRound(r, 20);
      for (const f of ['thorn', 'ashen']) {
        const p = snap.perFaction[f];
        if (!p) continue;
        expect(p.forge, `seed ${seed} ${f} forge`).toBe(true);
        expect(p.unarmed, `seed ${seed} ${f} unarmed`).toBeLessThanOrEqual(4);
      }
      // (Since any unit works a building, its leader's castle pays a little more early on and thorn
      // spends it on troops first: the drill ground breaks ground in round 21 rather than 18.)
      if (seed === 544774) expect(atRound(r, 21).perFaction.thorn.training).toBe(true);
    }
  }, 120_000);

  it('a house is never left without builders for long (small seed 7, player idle)', () => {
    const r = playSeeded(ai(7, 'small'), 40, false);
    for (const f of ['thorn', 'ashen']) expect(longestRun(r, f, (p) => p.builders === 0), f).toBeLessThanOrEqual(3);
  }, 120_000);

  it('Ashen\'s economy does not stall on its own squatters (seed 42, every house AI-driven)', () => {
    const r = playSeeded(ai(42), 34, true);
    expect(atRound(r, 34).perFaction.ashen?.buildings ?? 0).toBeGreaterThan(12);
  }, 120_000);

  it('magic and war: towers by round 45, spells cast, mana not wasted, and the AIs fight each other', () => {
    let interAi = 0, onHuman = 0, spells = 0, towerHouses = 0, houses = 0, aiHouses = 0, aiTowers35 = 0;
    const kinds: Record<string, number> = {};
    for (const seed of [7, 11, 23]) {
      const r = playSeeded(ai(seed), 60, true);
      const at45 = atRound(r, 45);
      for (const f of Object.keys(at45.perFaction)) {
        houses++;
        if (at45.perFaction[f].towers > 0) towerHouses++;
        expect(longestRun(r, f, (p) => p.manaFull), `seed ${seed} ${f} mana at cap`).toBeLessThanOrEqual(5);
      }
      const at35 = atRound(r, 35);
      for (const f of ['thorn', 'ashen']) {
        if (!at35.perFaction[f]) continue;
        aiHouses++;
        if (at35.perFaction[f].towers > 0) aiTowers35++;
      }
      for (const [k, n] of Object.entries(r.aiSpellKinds)) kinds[k] = (kinds[k] ?? 0) + n;
      spells += Object.values(r.spells).reduce((a, b) => a + b, 0);
      const ais = ['thorn', 'ashen'];
      interAi += (r.attacks[`${ais[0]}>${ais[1]}`] ?? 0) + (r.attacks[`${ais[1]}>${ais[0]}`] ?? 0);
      onHuman += ais.reduce((a, f) => a + (r.attacks[`${f}>${r.human}`] ?? 0), 0);
    }
    out(`regressions: towers ${towerHouses}/${houses} houses by r45 (AI houses by r35 ${aiTowers35}/${aiHouses}), ${spells} spells `
      + `(AI houses ${JSON.stringify(kinds)}), AI-vs-AI ${interAi} vs on the player ${onHuman} attacks`);
    expect(towerHouses).toBeGreaterThanOrEqual(Math.ceil(houses * 0.6));
    expect(spells).toBeGreaterThanOrEqual(15);
    // AI houses have a working tower in mid game and spend their mana on war spells, not only on
    // looks (Farsight) and heals.
    expect(aiTowers35).toBeGreaterThanOrEqual(Math.ceil(aiHouses * 0.6));
    const war = (kinds.fireball ?? 0) + (kinds.storm ?? 0) + (kinds.summon ?? 0) + (kinds.bless ?? 0) + (kinds.haste ?? 0);
    expect(war).toBeGreaterThanOrEqual(5);
    expect(kinds.farsight ?? 0).toBeLessThanOrEqual(Object.values(kinds).reduce((a, b) => a + b, 0) / 2);
    expect(interAi).toBeGreaterThanOrEqual(onHuman * 0.35);
  }, 300_000);
});
