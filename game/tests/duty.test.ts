// Which own units still await orders (Tab, the idle badge): working units are left out.
import { describe, expect, it } from 'vitest';
import { dutyOf, onDuty, unitsAwaitingOrders, unitsAtWork } from '../src/game/duty';
import { idleUnits } from '../src/sim/actions';
import { at, makeTestBuilding, makeTestState, makeTestUnit } from './helpers';

describe('units awaiting orders', () => {
  it('leaves out builders on sites and buildings, drilling units and the seated leader', () => {
    const s = makeTestState(14, 10);
    const castle = makeTestBuilding(s, 'castle', 'valen', at(2, 2));
    const site = makeTestBuilding(s, 'quarry', 'valen', at(4, 2), { buildLeft: 3 });
    const farm = makeTestBuilding(s, 'farm', 'valen', at(6, 2));
    const drill = makeTestBuilding(s, 'training', 'valen', at(8, 2));
    const forge = makeTestBuilding(s, 'forge', 'valen', at(10, 2));
    const leader = makeTestUnit(s, 'valen', castle.pos, { isLeader: true });
    const onSite = makeTestUnit(s, 'valen', site.pos, { items: ['tools'] });
    const onFarm = makeTestUnit(s, 'valen', farm.pos, { items: ['tools'] });
    const commoner = makeTestUnit(s, 'valen', at(6, 4));
    const farmHand = makeTestUnit(s, 'valen', at(6, 6));
    const trainee = makeTestUnit(s, 'valen', drill.pos, { items: ['sword'] });
    const smith = makeTestUnit(s, 'valen', forge.pos, { items: ['tools'] });
    expect(onDuty(s, leader)).toBe(true);
    expect(onDuty(s, onSite)).toBe(true);
    expect(onDuty(s, onFarm)).toBe(true);
    expect(onDuty(s, trainee)).toBe(true);
    expect(onDuty(s, smith)).toBe(false);   // a forge produces nothing to boost
    expect(dutyOf(s, onSite)).toMatch(/Building the Quarry/);
    const awaiting = unitsAwaitingOrders(s);
    expect(awaiting).toEqual([commoner.id, farmHand.id, smith.id]);
    expect(idleUnits(s)).toHaveLength(7); // the sim's "can still act" list is unchanged
    expect(unitsAtWork(s)).toBe(4);

    // a commoner without tools works a farm too (bare-handed, ×1.25)
    farmHand.pos = farm.pos;
    onFarm.pos = at(6, 8);
    expect(onDuty(s, farmHand)).toBe(true);
    expect(dutyOf(s, farmHand)).toBe('Working the Farm');
    expect(unitsAwaitingOrders(s)).not.toContain(farmHand.id);
    // the leader off the castle needs orders again
    leader.pos = at(2, 6);
    expect(unitsAwaitingOrders(s)).toContain(leader.id);
  });

  it('a working unit with an enemy in reach still needs orders; skipped units do not', () => {
    const s = makeTestState(14, 10);
    const site = makeTestBuilding(s, 'quarry', 'valen', at(4, 4), { buildLeft: 3 });
    const builder = makeTestUnit(s, 'valen', site.pos, { items: ['tools'] });
    const other = makeTestUnit(s, 'valen', at(9, 8));
    expect(unitsAwaitingOrders(s)).toEqual([other.id]);
    expect(unitsAwaitingOrders(s, new Set([other.id]))).toEqual([]);
    makeTestUnit(s, 'thorn', at(5, 4));
    expect(unitsAwaitingOrders(s)).toContain(builder.id);
  });
});
