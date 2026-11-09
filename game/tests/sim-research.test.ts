import { describe, expect, it } from 'vitest';
import { makeTestState, makeTestUnit, at } from './helpers';
import {
  hasTech, availableTechs, canResearch, setResearch, progressResearch, itemUnlocked, buildingUnlocked,
  presetUnlocked, resourceMult, techDamageMult, researchRemaining,
} from '../src/sim/research';
import { TECH_LIST } from '../src/data/research';

describe('research', () => {
  it('lists only techs whose prerequisites are met', () => {
    const s = makeTestState();
    const roots = TECH_LIST.filter((t) => t.requires.length === 0).map((t) => t.id);
    expect(new Set(availableTechs(s, 'valen'))).toEqual(new Set(roots));
    s.factions.valen.techs = ['mining'];
    expect(availableTechs(s, 'valen')).toContain('masonry');
    expect(availableTechs(s, 'valen')).not.toContain('mining');
    expect(availableTechs(s, 'valen')).not.toContain('platesmithing'); // needs shieldcraft too
    expect(hasTech(s, 'valen', 'mining')).toBe(true);
    expect(hasTech(s, 'thorn', 'mining')).toBe(false);
  });

  it('validates research choices', () => {
    const s = makeTestState();
    expect(canResearch(s, 'valen', 'mining')).toBeNull();
    expect(canResearch(s, 'valen', 'masonry')).toMatch(/Mining/);
    expect(canResearch(s, 'valen', 'grandarchitecture')).toMatch(/Architecture and Scholarship/);
    s.factions.valen.techs = ['mining'];
    expect(canResearch(s, 'valen', 'mining')).toMatch(/already/);
    expect(canResearch(s, 'neutral', 'writing')).not.toBeNull();
    s.factions.thorn.alive = false;
    expect(canResearch(s, 'thorn', 'writing')).toMatch(/eliminated/);
  });

  it('switching projects keeps progress; completion leaves leftovers banked', () => {
    const s = makeTestState();
    const fs = s.factions.valen;
    const ev = setResearch(s, 'valen', 'mining');
    expect(fs.researching).toBe('mining');
    expect(ev.some((e) => e.type === 'log')).toBe(true);
    progressResearch(s, 'valen', 20);
    setResearch(s, 'valen', 'writing');
    expect(fs.researchProgress).toBe(20);
    expect(researchRemaining(s, 'valen')).toBe(10);
    const done = progressResearch(s, 'valen', 15);
    expect(done[0]).toEqual({ type: 'researchCompleted', faction: 'valen', tech: 'writing' });
    expect(fs.techs).toEqual(['writing']);
    expect(fs.researching).toBeNull();
    expect(fs.researchProgress).toBe(5);
    expect(fs.stats.researched).toBe(1);
    // Points with no project are banked...
    expect(progressResearch(s, 'valen', 40)).toEqual([]);
    expect(fs.researchProgress).toBe(45);
    // ...and complete the next project as soon as it is chosen and progressed.
    setResearch(s, 'valen', 'mining');
    const ev2 = progressResearch(s, 'valen', 0);
    expect(ev2[0]).toEqual({ type: 'researchCompleted', faction: 'valen', tech: 'mining' });
    expect(fs.researchProgress).toBe(15);
  });

  it('refuses illegal projects and keeps AI choices out of the log', () => {
    const s = makeTestState();
    expect(setResearch(s, 'valen', 'masonry')).toEqual([]);
    expect(s.factions.valen.researching).toBeNull();
    expect(setResearch(s, 'thorn', 'mining')).toEqual([]);
    expect(s.factions.thorn.researching).toBe('mining');
    expect(s.log).toEqual([]);
  });

  it('keeps AI discoveries out of the chronicle (the event still fires)', () => {
    const s = makeTestState();
    setResearch(s, 'thorn', 'mining');
    const evs = progressResearch(s, 'thorn', 30);
    expect(evs).toContainEqual({ type: 'researchCompleted', faction: 'thorn', tech: 'mining' });
    expect(evs.some((e) => e.type === 'log')).toBe(false);
    expect(s.log).toEqual([]);
    expect(s.factions.thorn.techs).toContain('mining');
    setResearch(s, 'valen', 'mining');
    const mine = progressResearch(s, 'valen', 30);
    expect(mine.filter((e) => e.type === 'log')).toHaveLength(1);
    expect(s.log.map((l) => l.text)).toContain('Mining discovered.');
  });

  it('tracks fractional points without drift', () => {
    const s = makeTestState();
    setResearch(s, 'valen', 'mining');
    for (let i = 0; i < 10; i++) progressResearch(s, 'valen', 0.1);
    expect(s.factions.valen.researchProgress).toBe(1);
  });

  it('answers unlock queries for items, buildings and presets', () => {
    const s = makeTestState();
    expect(itemUnlocked(s, 'valen', 'sword')).toBe(true);
    expect(itemUnlocked(s, 'valen', 'spear')).toBe(false);
    expect(presetUnlocked(s, 'valen', 'swordsman')).toBe(true);
    expect(presetUnlocked(s, 'valen', 'knight')).toBe(false);
    expect(buildingUnlocked(s, 'valen', 'farm')).toBe(true);
    expect(buildingUnlocked(s, 'valen', 'mine')).toBe(false);
    s.factions.valen.techs = ['polearms', 'tanning', 'shieldcraft', 'mining', 'platesmithing', 'horsemanship'];
    expect(itemUnlocked(s, 'valen', 'spear')).toBe(true);
    expect(presetUnlocked(s, 'valen', 'knight')).toBe(true);
    expect(buildingUnlocked(s, 'valen', 'mine')).toBe(true);
    // Skill buildings need a unit that knows the skill.
    const u = makeTestUnit(s, 'valen', at(1, 1));
    expect(buildingUnlocked(s, 'valen', 'shrine', u)).toBe(false);
    expect(buildingUnlocked(s, 'valen', 'shrine')).toBe(false);
    u.actives.push('devotion');
    expect(buildingUnlocked(s, 'valen', 'shrine', u)).toBe(true);
    expect(buildingUnlocked(s, 'valen', 'shrine')).toBe(true); // some unit of the faction knows it
    expect(buildingUnlocked(s, 'thorn', 'shrine')).toBe(false);
  });

  it('computes resource and damage multipliers', () => {
    const s = makeTestState();
    expect(resourceMult(s, 'valen', 'food')).toBe(1);
    expect(techDamageMult(s, 'valen')).toBe(1);
    s.factions.valen.techs = ['croprotation', 'guilds', 'scholarship', 'tactics'];
    expect(resourceMult(s, 'valen', 'food')).toBe(1.25);
    expect(resourceMult(s, 'valen', 'gold')).toBe(1.2);
    expect(resourceMult(s, 'valen', 'research')).toBe(1.25);
    expect(resourceMult(s, 'valen', 'wood')).toBe(1);
    expect(techDamageMult(s, 'valen')).toBe(1.1);
  });
});
