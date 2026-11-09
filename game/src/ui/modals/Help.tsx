// Help: controls and a rules primer.
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { BUILDINGS, BUILDING_LIST } from '../../data/buildings';
import { PRESETS } from '../../data/presets';
import { LEADER_XP_MULT } from '../../data/skills';
import { TERRAIN } from '../../data/terrain';
import { BARE_WORKER_MULT, WORK_XP, WORKER_MULT } from '../../sim/economy';
import { HEAL_ORDER_ALERT } from '../../sim/orders';
import { armoryNames, XP_SOURCES } from '../sheet';
import { Kbd } from '../common';
import { useUi } from '../ctx';
import { Icon } from '../icons';
import { cls, fmt, XP_CATS, XP_NAMES } from '../util';
import { Modal } from './Modal';

const CONTROLS: [string[], string][] = [
  [['LMB'], 'Select a unit or hex · move · attack · past the reach: head there'],
  [['Shift+LMB'], 'Attack with the other kind (melee or ranged / magic)'],
  [['RMB', 'Esc'], 'Cancel the current action / deselect'],
  [['W', 'A', 'S', 'D'], 'Pan the camera (also arrow keys, screen edges, or middle/right-drag)'],
  [['Wheel', 'PgUp', 'PgDn'], 'Zoom (also + / −)'],
  [['Q', 'E'], 'Rotate the camera'],
  [['Space', 'Enter'], 'End turn · fast-forward the enemy turn'],
  [['Tab', 'X'], 'Next unit awaiting orders (working, resting and watching units are skipped; a resting or watching one comes back once it can attack an enemy this turn) · skip this unit for the turn'],
  [['T'], 'Attack: pick a target for the selected unit'],
  [['1', '…', '6'], 'The selected unit\'s active skills'],
  [['Y', 'V'], 'Rest until healed · keep watch (sentry): the unit stays put until healed or an enemy shows up'],
  [['B', 'U'], 'Build menu (your leader, or a unit with Builder\'s Tools) · upgrade the building under it'],
  [['L'], 'Choose a waiting level-up reward'],
  [['C', 'I'], 'Unit sheet: stats and their sources, equipment, augments, experience'],
  [['R', 'M', 'F'], 'Research · Spellbook · Forge & stockpile'],
  [['G', 'N'], 'Toggle hex grid · mute sound'],
  [['Ctrl+S'], 'Save game (manual slot; autosaves are kept apart)'],
  [['H', 'F1'], 'This help · debug overlay'],
  [['Esc'], 'Close a window · game menu'],
];

// Figures below come from the data tables (or name the sim constant they mirror) so the manual
// cannot drift from the rules.
const presetName = (p: string) => PRESETS[p as keyof typeof PRESETS]?.name ?? p;
const recruitLine = BUILDING_LIST.filter((b) => b.recruits?.length)
  .map((b) => `${b.id === 'castle' ? 'the castle (your leader must stand on it)' : `${b.name === 'House' ? 'a House' : `the ${b.name}`}`}: ${b.recruits!.map(presetName).join(', ')}`)
  .join('; ');
const moveLine = Object.values(TERRAIN)
  .map((t) => `${t.name} ${Number.isFinite(t.moveCost) ? `move ${t.moveCost}, defense ${t.defense}%` : 'impassable'}`)
  .join(' · ');
const healOf = (id: keyof typeof BUILDINGS) => BUILDINGS[id]?.heal ?? 0;

const TOPICS: { id: string; title: string; icon: string; body: ComponentChildren[] }[] = [
  {
    id: 'goal', title: 'Goal', icon: 'buildings/castle.png', body: [
      'Every faction is led by a single Leader. If your leader falls, your house is lost. Slay every rival leader to win.',
      'Neutral beasts guard the ancient ruins; the first unit to explore a ruin claims its treasure. Unguarded ruins spawn new beasts every 12 rounds.',
    ],
  },
  {
    id: 'units', title: 'Units & equipment', icon: 'items/sword.png', body: [
      'Everyone starts as a Commoner. Equipment defines what a unit can do: Builder\'s Tools build and upgrade buildings, weapons fight, bows and staves strike from 2 hexes, armor reduces damage, a mount adds movement and a charge on open ground.',
      `Craft items at a Forge into your stockpile, then equip them while standing on an armory: ${armoryNames()}. Equipping is free and does not end the turn.`,
      'The unit sheet (C or I, or click the portrait) shows everything about a unit: each attribute and where every point comes from, its attacks, equipment, augments and level history, and its experience.',
    ],
  },
  {
    id: 'recruit', title: 'Recruiting', icon: 'buildings/house.png', body: [
      'Select one of your recruiting sites and press Recruit in the tile panel (or in the unit panel of a unit standing on it).',
      `Who trains where — ${recruitLine}.`,
      'Each site recruits once per turn. A recruit costs a commoner (gold and food) plus the items of its preset, and a preset needs its items researched.',
      'The recruit appears on or next to the site and cannot move or capture until your next turn.',
    ],
  },
  {
    id: 'move', title: 'Movement & healing', icon: 'items/horse.png', body: [
      `Terrain: ${moveLine}.`,
      'Mounted units cannot enter mountains and pay +1 in forest and swamp; the Pathfinder passive makes forest and hills cost 1. Entering a hex next to an enemy ends movement (zone of control) unless the unit is a Skirmisher.',
      `Healing at the start of your turn: +2 HP for a unit that neither moved nor fought last turn; standing on your castle +${healOf('castle')}, a shrine +${healOf('shrine')}, a house +${healOf('house')}; Regeneration +4.`,
      'Poison deals 4 damage a turn (never fatal) until cured on a castle or shrine, or by Healing Light / Mend.',
      `Standing orders keep a unit still without asking every turn: Rest until healed (Y) lasts until it is whole again or a hostile comes within ${HEAL_ORDER_ALERT} hexes; Sentry (V) lasts until a hostile comes into its sight. Being attacked ends either. Tab skips units under orders.`,
    ],
  },
  {
    id: 'combat', title: 'Combat', icon: 'skills/stat_str.png', body: [
      'Melee attacks an adjacent enemy; ranged and magic reach 2 hexes. The defender strikes back with an attack of the same kind if it has one in range. Strikes alternate; first strike lets a spear defender go first.',
      'Chance to hit = 100% minus the defender\'s terrain defense (forest 50%, hills 50%, mountains 60%, swamp 20%), plus building and shield bonuses. Magic always hits 70% of the time. Armor reduces every weapon hit; spells and Firebolt pierce it and always deal their listed damage.',
      'Hover an enemy with a unit selected to see the exact forecast before you commit. Entering a hex next to an enemy ends movement (zone of control).',
    ],
  },
  {
    id: 'growth', title: 'Experience', icon: 'skills/stat_hp.png', body: [
      'Units earn XP in seven kinds. Each level grants +4 max HP and a choice of three rewards: an attribute, an efficiency multiplier, a passive or an active skill.',
      ...XP_CATS.map((c) => <><i class={`xp-dot xp-${c}`} /><b>{XP_NAMES[c]}</b> — {XP_SOURCES[c]}</>),
      'The rewards offered favour the kinds of XP earned during that level: an archer is offered bow skills and rarely melee ones, a builder grows into a better builder, a duelist into a deadlier one. The unit sheet (C) lists which rewards each kind favours.',
      'A choice can wait: "Decide later" keeps it behind the Level up reminder by End Turn and the star on the unit\'s portrait, and the turn can still end.',
      `Leaders earn ${Math.round((LEADER_XP_MULT - 1) * 100)}% more XP.`,
    ],
  },
  {
    id: 'economy', title: 'Economy', icon: 'buildings/farm.png', body: [
      'Each hex holds one building. A unit with Builder\'s Tools starts construction on its hex (inside or next to your territory), then adds build points at the end of every turn it stays there.',
      `Any of your units standing on a finished building that produces something works it: ×${fmt(BARE_WORKER_MULT)} output bare-handed, ×${fmt(WORKER_MULT)} with Builder's Tools, times its work efficiencies. A worker earns ${WORK_XP} XP each turn it does not act (civic, the castle included; research & magic at a library, watchtower, shrine or mage tower; leadership for the leader on its castle). A unit recruited this turn has not worked yet.`,
      'Units eat 1 food per turn (leaders are free). If food runs out, everyone starves for 3 HP a turn. Your leader on the castle boosts all production by 10%.',
      'Ending a turn on an enemy building captures it; walls cannot be captured, and castles are razed instead.',
      'Moving your seat: building a new castle (any builder, or the leader) demolishes the old one — and its upgrades — the moment the new site is placed. Until the new castle is finished (6 build points) you cannot recruit at a castle, get its +10% or its defense, and its territory is gone.',
    ],
  },
  {
    id: 'magic', title: 'Research & magic', icon: 'buildings/magetower.png', body: [
      'Research points from your castle and libraries advance one project at a time. Switching keeps the progress.',
      'Mage Towers produce mana and channel global spells — heal, bless, fireball, summon and more — anywhere within their range. A spell reaches its base range from any of your towers, plus 1 per 3 Intellect of the unit standing on it.',
      'Mana comes from towers, shrines, wands, robes and skills, and is capped at 100 + 50 per Mage Tower. Each spell has a faction-wide cooldown.',
    ],
  },
];

export function HelpModal() {
  const { store } = useUi();
  const [topic, setTopic] = useState('goal');
  const t = TOPICS.find((x) => x.id === topic) ?? TOPICS[0];
  return (
    <Modal size="lg" title="Field Manual" icon={<Icon k="resources/research.png" size={40} />} onClose={() => store.closeModal()}>
      <div class="help-layout">
        <div class="help-topics">
          {TOPICS.map((x) => (
            <button type="button" key={x.id} class={cls('help-topic', x.id === topic && 'on')} onClick={() => setTopic(x.id)}>
              <Icon k={x.icon} size={28} /><span>{x.title}</span>
            </button>
          ))}
        </div>
        <div class="help-body">
          <h3>{t.title}</h3>
          {t.body.map((p, i) => <p key={i}>{p}</p>)}
        </div>
        <div class="help-controls">
          <h3>Controls</h3>
          <table>
            <tbody>
              {CONTROLS.map(([keys, what]) => (
                <tr key={what}>
                  <td class="keys">{keys.map((k) => <Kbd key={k} k={k} />)}</td>
                  <td>{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
