// Right panel: the selected hex — terrain, defense, deposit, building, production and site actions.
import type { Building, FactionId, GameState, Hex, ResourceId } from '../../core/types';
import { tileIndex } from '../../core/hex';
import { BUILDING_LIST, BUILDINGS } from '../../data/buildings';
import { FACTIONS } from '../../data/factions';
import { PRESETS } from '../../data/presets';
import { TECH_LIST } from '../../data/research';
import { TERRAIN } from '../../data/terrain';
import {
  BARE_WORKER_MULT, buildingOutput, buildingXpPerTurn, hasWorkableOutput, maxBuildingLevel, siteError, territoryOwner, workerMult, workerOf,
  WORK_XP, WORKER_MULT, workerResourceMult,
} from '../../sim/economy';
import { buildingUnlocked } from '../../sim/research';
import { canBuildWith } from '../../sim/units';
import { Bar, Btn, Output, TipCard } from '../common';
import { UpgradeDetails } from './UpgradeInfo';
import { fmtMult } from '../sheet';
import { useUi } from '../ctx';
import { Emblem, Icon, Sym } from '../icons';
import { tip } from '../tooltip';
import {
  buildingAtHex, cls, fmt, hexExplored, hexLabel, hexVisible, isComplete, isMyTurn, safe, tileAt, unitAtHex, viewerOf, XP_NAMES,
} from '../util';

export const DEPOSIT_INFO: Record<string, { name: string; icon: string; text: string }> = {
  iron: { name: 'Iron deposit', icon: 'resources/iron.png', text: 'An Iron Mine can be built here (requires Mining).' },
  crystal: { name: 'Crystal deposit', icon: 'resources/crystal.png', text: 'A Crystal Mine can be built here (requires Crystal Lore).' },
  stone: { name: 'Stone outcrop', icon: 'resources/stone.png', text: 'Good ground for a Quarry.' },
  fertile: { name: 'Fertile soil', icon: 'resources/food.png', text: 'Farms built here produce +1 food.' },
};

/**
 * What could be built on an empty hex the viewer can see, by the same site rules as the sim
 * (foreign land, reach of own territory, terrain, deposit), split into unlocked and researchable.
 */
function buildHint(s: GameState, f: FactionId, h: Hex): { text: string; tone: string } {
  const owner = safe(() => territoryOwner(s, h), null);
  if (owner && owner !== f) return { text: `Belongs to ${FACTIONS[owner]?.name ?? owner} — you cannot build here.`, tone: 't-bad' };
  const hasCastle = Object.values(s.buildings).some((b) => b.owner === f && b.type === 'castle');
  const errs = BUILDING_LIST.filter((d) => d.id !== 'castle' || !hasCastle)
    .map((d) => ({ d, err: safe(() => siteError(s, f, h, d.id, d.id === 'castle' && !hasCastle), 'error') }));
  const fits = errs.filter((x) => x.err === null).map((x) => x.d);
  if (!fits.length) {
    const reach = errs.some((x) => x.err === 'Must be inside or adjacent to your territory');
    return reach ? { text: 'Outside your reach — build inside or next to your territory.', tone: 't-dim' }
      : { text: 'Nothing you can build fits this hex.', tone: 't-dim' };
  }
  const open = fits.filter((d) => safe(() => buildingUnlocked(s, f, d.id), false));
  const locked = fits.filter((d) => !open.includes(d));
  const lockName = (d: typeof fits[number]) => {
    const tech = TECH_LIST.find((t) => t.unlocksBuildings?.includes(d.id))?.name ?? (d.unlockSkill ? (d.unlockSkill === 'masonry' ? 'Masonry skill' : 'Devotion skill') : null);
    return tech ? `${d.name} (${tech})` : d.name;
  };
  const parts: string[] = [];
  if (open.length) parts.push(`A builder could raise: ${open.map((d) => d.name).join(', ')}.`);
  if (locked.length) parts.push(`After research: ${locked.map(lockName).join(', ')}.`);
  return { text: parts.join(' '), tone: open.length ? 't-dim' : 't-warn' };
}

/**
 * Who works a producing building and what they add (economy.workerOf / workerResourceMult): output
 * jumps when a unit steps on, and this says why. For an own building nobody works, how to.
 */
function WorkerLine({ s, b, own }: { s: GameState; b: Building; own: boolean }) {
  if (!safe(() => hasWorkableOutput(b.type), false)) return null;
  const w = safe(() => workerOf(s, b), null);
  if (!w) {
    return own ? (
      <div class="tp-note t-dim" {...tip(`Any of your units (not a creature) standing on a finished building that produces something works it. Builder's Tools work it better, a worker's efficiencies add on top, and it earns ${WORK_XP} XP each turn it does not act.`)}>
        <Sym name="hammer" />
        <span>Nobody works it: a unit here adds {fmtMult(BARE_WORKER_MULT)} ({fmtMult(WORKER_MULT)} with Builder's Tools).</span>
      </div>
    ) : null;
  }
  const tools = safe(() => canBuildWith(w), false);
  const base = safe(() => workerMult(w), BARE_WORKER_MULT);
  // With efficiencies the multiplier can differ per resource (a castle: gold, food, research).
  const res = (Object.keys(BUILDINGS[b.type].output) as ResourceId[]).filter((k) => (BUILDINGS[b.type].output[k] ?? 0) > 0);
  const totals = res.map((k) => safe(() => workerResourceMult(w, k), base));
  const lo = Math.min(...totals);
  const hi = Math.max(...totals);
  const withEff = hi > base + 1e-9;
  return (
    <div class="tp-note tp-worker" {...tip(`${w.name} stands here and works it: ${fmtMult(base)} ${tools ? "with Builder's Tools" : `bare-handed (${fmtMult(WORKER_MULT)} with Builder's Tools)`}${withEff ? `, times its work efficiencies: ${lo === hi ? fmtMult(hi) : `${fmtMult(lo)}–${fmtMult(hi)}`} in all` : ''}. It earns ${WORK_XP} XP each turn it does not act.`)}>
      <Sym name="hammer" />
      <span>Worked by <b>{w.name}</b>: {fmtMult(base)} {tools ? "with Builder's Tools" : 'bare-handed'}
        {withEff && <span class="t-good"> ({lo === hi ? fmtMult(hi) : `up to ${fmtMult(hi)}`} with its efficiencies)</span>}</span>
    </div>
  );
}

/** Total build points of the current construction step. */
function buildTotal(b: Building): number {
  const def = BUILDINGS[b.type];
  const total = b.upgrading ? def.buildPoints * Math.max(1, b.level) : def.buildPoints;
  return Math.max(total, b.buildLeft);
}

function BuildingSection({ s, b, visible }: { s: GameState; b: Building; visible: boolean }) {
  const { store } = useUi();
  const ui = store.ui;
  const viewer = viewerOf(s);
  const def = BUILDINGS[b.type];
  const own = b.owner === viewer;
  const owner = b.owner ? FACTIONS[b.owner] : null;
  const complete = isComplete(b);
  const underConstruction = b.buildLeft > 0;
  // Under the fog `b` is the last-seen copy: nothing live (output, workers) is shown for it.
  const out = complete && b.owner && visible ? safe(() => buildingOutput(s, b), def.output) : {};
  const maxLvl = b.owner ? safe(() => maxBuildingLevel(s, b.owner!), 1) : 1;
  const worker = visible ? unitAtHex(s, b.pos) : undefined;
  // Builder's Tools work any site; the leader raises its own castle without them (sim progressConstruction).
  const hasBuilder = !!worker && worker.faction === b.owner && !worker.monster
    && (safe(() => canBuildWith(worker), false) || (worker.isLeader && b.type === 'castle' && !b.upgrading));
  const myTurn = isMyTurn(s, ui);
  const total = buildTotal(b);
  const defense = def.defense?.[Math.min(def.defense.length - 1, Math.max(0, b.level - 1))];

  return (
    <div class="tp-building">
      <div class="tp-bhead">
        <Icon k={def.icon} size={44} />
        <div class="tp-bname">
          <div class="tp-btitle">{def.name} <span class="lvl" {...tip(`Level ${b.level} of ${def.maxLevel}${maxLvl < def.maxLevel ? ` (research allows ${maxLvl})` : ''}`)}>Lv {b.level}</span></div>
          <div class="tp-owner" style={owner ? { color: owner.color } : undefined}>
            {owner ? <><Emblem faction={b.owner!} size={16} />{owner.name}</> : <span class="t-dim">Abandoned — capture it by ending a turn here</span>}
          </div>
        </div>
      </div>
      {!visible && <div class="tp-note t-dim">Last seen — the area is not in view.</div>}

      {underConstruction && (
        <div class="tp-construction">
          <div class="tp-row-label">{b.upgrading ? `Upgrading to level ${b.level + 1}` : 'Under construction'}</div>
          <Bar kind="build" value={total - b.buildLeft} max={total} label={`${fmt(total - b.buildLeft)} / ${fmt(total)}`}
            tipContent={`${fmt(b.buildLeft)} build points left. A unit with Builder's Tools standing here adds points at the end of each turn${b.type === 'castle' && !b.upgrading ? ' (your leader can raise a castle without tools)' : ''}.`} />
          {own && visible && !hasBuilder && <div class="tp-note t-warn"><Sym name="hammer" /> Needs a builder standing on it to progress.</div>}
        </div>
      )}

      {complete && visible && (
        <div class="tp-kv">
          <span>Output / turn</span>
          <Output out={out} empty={def.armory && !Object.keys(def.output).length ? 'Armory' : '—'} />
        </div>
      )}
      {complete && visible && b.owner && <WorkerLine s={s} b={b} own={own} />}
      <div class="tp-desc">{def.description}</div>
      <div class="tp-tags">
        {defense ? <span class="tag" {...tip('Defense bonus for units standing here')}>+{defense}% defense</span> : null}
        {def.heal ? <span class="tag" {...tip('Healing for own units at the start of each turn')}>Heals {def.heal}</span> : null}
        {def.xpPerTurn ? (() => {
          // The drill teaches the unit stationed here in its own trade (a bowman: ranged).
          const trainee = worker && worker.faction === b.owner && !worker.monster ? worker : undefined;
          const x = safe(() => buildingXpPerTurn(b, trainee), null) ?? { cat: def.xpPerTurn.cat, amount: def.xpPerTurn.amount };
          const alt = !trainee && def.xpPerTurn.rangedCat ? def.xpPerTurn.rangedCat : null;
          return (
            <span class="tag" {...tip(alt ? `Drill XP for a unit stationed here: ${XP_NAMES[x.cat]}, or ${XP_NAMES[alt]} for a unit with a bow` : `Drill XP for ${trainee ? trainee.name : 'a unit stationed here'}`)}>
              +{x.amount} {XP_NAMES[x.cat]}{alt ? ` / ${XP_NAMES[alt]}` : ''} XP/turn
            </span>
          );
        })() : null}
        {def.visionBonus ? <span class="tag">+{def.visionBonus} vision</span> : null}
        {def.armory ? <span class="tag" {...tip('Units standing here can equip items from the stockpile')}>Armory</span> : null}
        {def.uncapturable ? <span class="tag" {...tip(b.type === 'castle' ? 'Castles are razed when an enemy ends a turn on them' : 'Cannot be captured')}>{b.type === 'castle' ? 'Razed if taken' : 'Uncapturable'}</span> : null}
      </div>
      {own && visible && !underConstruction && b.level < def.maxLevel && (
        <div class="tp-upgrade">
          <span class="tp-row-label">Upgrade to level {b.level + 1}</span>
          <UpgradeDetails s={s} b={b} have={s.factions[viewer]?.resources}
            builder={worker && worker.faction === viewer && safe(() => canBuildWith(worker), false) ? worker : undefined}
            stationed={worker && worker.faction === b.owner && !worker.monster ? worker : undefined} />
          <div class="tp-note t-dim">
            {maxLvl <= b.level
              ? `Requires research: ${TECH_LIST.find((t) => (t.bonus?.maxBuildingLevel ?? 0) > b.level)?.name ?? 'Architecture'}`
              : "A unit with Builder's Tools standing here can start the upgrade."}
          </div>
        </div>
      )}
      {def.recruits && (
        <div class="tp-recruits">
          <span class="tp-row-label">Recruits</span>
          <span class="t-dim">{def.recruits.map((p) => PRESETS[p].name).join(', ')}{b.type === 'castle' ? ' (leader must be present)' : ''}</span>
        </div>
      )}

      {own && visible && complete && (
        <div class="tp-actions">
          {def.recruits && (
            <Btn icon="recruit" disabled={!myTurn} reason={b.recruitedThisTurn ? 'Already recruited here this turn' : !myTurn ? 'Not your turn' : null}
              onClick={() => store.openModal('recruit', { site: b.id })} title={`Recruit at this ${def.name}`}>Recruit</Btn>
          )}
          {b.type === 'forge' && (
            <Btn icon="forge" disabled={!myTurn} reason={!myTurn ? 'Not your turn' : null}
              onClick={() => store.openModal('forge', { site: b.id })} title="Craft equipment into the stockpile">Forge</Btn>
          )}
          {b.type === 'magetower' && (
            <Btn icon="spellbook" hotkey="M" disabled={!myTurn} reason={!myTurn ? 'Not your turn' : null}
              onClick={() => store.openModal('spellbook')} title="Cast a global spell from your Mage Towers">Spells</Btn>
          )}
        </div>
      )}
    </div>
  );
}

export function TilePanel() {
  const { store } = useUi();
  const s = store.state!;
  const h: Hex | null = store.ui.selectedHex;
  if (!h) return null;
  const t = tileAt(s, h);
  if (!t) return null;
  const viewer = viewerOf(s);
  const explored = hexExplored(s, viewer, h);
  const visible = hexVisible(s, viewer, h);

  if (!explored) {
    return (
      <div class="tile-panel panel">
        <div class="tp-head"><span class="terrain-swatch unexplored" /><div><div class="tp-title">Unexplored</div><div class="tp-sub">Hex {hexLabel(h)}</div></div></div>
        <div class="tp-desc t-dim">Send a unit to scout this land.</div>
      </div>
    );
  }

  const tdef = TERRAIN[t.terrain];
  // Fogged hexes show what was last seen there, never the live state.
  const mem = visible ? null : store.lastSeen?.() ?? null;
  const idx = tileIndex(h, s.width);
  const b = mem ? mem.buildings[idx] ?? undefined : buildingAtHex(s, h);
  const bdef = b ? BUILDINGS[b.type] : null;
  const bDefense = b && bdef?.defense && isComplete(b) ? bdef.defense[Math.min(bdef.defense.length - 1, b.level - 1)] : 0;
  const terr = mem ? mem.territory[idx] ?? null : safe(() => territoryOwner(s, h), null);
  const dep = t.deposit ? DEPOSIT_INFO[t.deposit] : null;
  const impassable = !Number.isFinite(tdef.moveCost);

  return (
    <div class="tile-panel panel">
      <div class="tp-head">
        <span class="terrain-swatch" style={{ background: tdef.color }} />
        <div>
          <div class="tp-title">{tdef.name}</div>
          <div class="tp-sub">Hex {hexLabel(h)}{!visible ? ' · fogged' : ''}</div>
        </div>
      </div>
      <div class="tp-grid">
        <div class="tp-stat" {...tip('Chance for attacks against a unit here to miss (before shields, mounts and magic).')}>
          <span>Defense</span>
          <b>{impassable ? '—' : `${tdef.defense + bDefense}%`}</b>
          {bDefense > 0 && <small>+{bDefense} {bdef!.name}</small>}
        </div>
        <div class="tp-stat" {...tip('Movement points to enter. Mounted units pay +1 in forest and swamp and cannot enter mountains.')}>
          <span>Move cost</span>
          <b>{impassable ? 'Impassable' : tdef.moveCost}</b>
        </div>
        <div class="tp-stat" {...tip('Territory is claimed around completed buildings: castles radius 2, others radius 1.')}>
          <span>Territory</span>
          <b style={terr ? { color: FACTIONS[terr].color } : undefined}>{terr ? FACTIONS[terr].name.replace(/^(House|The)\s+/, '') : 'Unclaimed'}</b>
        </div>
      </div>
      <div class="tp-desc">{tdef.description}</div>
      {dep && (
        <div class="tp-deposit" {...tip(dep.text)}>
          <Icon k={dep.icon} size={22} />
          <span>{dep.name}</span>
        </div>
      )}
      {t.terrain === 'ruins' && (
        <div class={cls('tp-deposit', t.ruinsLooted && 'dim')}>
          <Sym name="star" />
          <span>{t.ruinsLooted ? 'Already explored' : 'Unexplored ruins — the first unit to enter finds treasure'}</span>
        </div>
      )}
      {b && <BuildingSection s={s} b={b} visible={visible} />}
      {!b && tdef.buildable && (visible
        ? (() => { const hint = buildHint(s, viewer, h); return <div class={cls('tp-note', hint.tone)}>{hint.text}</div>; })()
        : <div class="tp-note t-dim">Empty when last seen.</div>)}
      {!b && !tdef.buildable && <div class="tp-note t-dim">Nothing can be built here.</div>}
    </div>
  );
}
