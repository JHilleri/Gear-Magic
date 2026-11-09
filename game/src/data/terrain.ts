import type { TerrainDef, TerrainId } from '../core/types';

export const TERRAIN: Record<TerrainId, TerrainDef> = {
  grass:    { id: 'grass',    name: 'Grassland',     moveCost: 1, defense: 40, height: 0.0,  buildable: true,  color: '#6fa043', description: 'Lush, fertile land. Ideal for farms.' },
  plains:   { id: 'plains',   name: 'Plains',        moveCost: 1, defense: 40, height: 0.02, buildable: true,  color: '#b8a55a', description: 'Open dry grassland.' },
  forest:   { id: 'forest',   name: 'Forest',        moveCost: 2, defense: 50, height: 0.05, buildable: true,  color: '#2f6b33', description: 'Dense woods. Good cover; source of wood.' },
  hills:    { id: 'hills',    name: 'Hills',         moveCost: 2, defense: 50, height: 0.38, buildable: true,  color: '#8d8a5c', description: 'Rolling hills. Stone and sometimes iron.' },
  mountain: { id: 'mountain', name: 'Mountains',     moveCost: 3, defense: 60, height: 1.15, buildable: true,  color: '#7d7a78', description: 'Harsh peaks. Impassable to mounts. Rich in ore.' },
  swamp:    { id: 'swamp',    name: 'Swamp',         moveCost: 3, defense: 20, height: -0.06, buildable: true, color: '#4f5e3c', description: 'Sucking mud. Slow and exposed.' },
  shallows: { id: 'shallows', name: 'Shallows',      moveCost: 3, defense: 20, height: -0.2, buildable: false, color: '#5d9db5', description: 'A shallow ford. Nothing can be built here.' },
  water:    { id: 'water',    name: 'Lake',          moveCost: Infinity, defense: 0, height: -0.36, buildable: false, color: '#2e6188', description: 'Deep water. Impassable.' },
  crystal:  { id: 'crystal',  name: 'Crystal Field', moveCost: 1, defense: 40, height: 0.05, buildable: true,  color: '#8f6fd1', description: 'Aether crystals breach the soil here.' },
  ruins:    { id: 'ruins',    name: 'Ancient Ruins', moveCost: 1, defense: 60, height: 0.05, buildable: false, color: '#a08f7a', description: 'Remains of an older age. Explore for treasure — if the guardians allow.' },
};

export const FLAT_TERRAIN: TerrainId[] = ['grass', 'plains', 'crystal', 'ruins'];
export const ROUGH_FOR_MOUNTS: TerrainId[] = ['forest', 'hills', 'swamp'];
