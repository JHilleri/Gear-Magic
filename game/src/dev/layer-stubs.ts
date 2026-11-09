// No-op entity layers for the world dev harness (see dev/vite.world.config.ts).
import type { CreateBuildingLayer, CreateFxLayer, CreateOverlayLayer, CreateUnitLayer } from '../render/types';

export const createUnitLayer: CreateUnitLayer = () => ({
  sync() {}, update() {}, dispose() {},
  async animateMove() {}, async animateCombat() {}, async animateDeath() {}, async animateSpawn() {}, async playClip() {},
  unitAnchor: () => null, refreshUnit() {},
});
export const createBuildingLayer: CreateBuildingLayer = () => ({ sync() {}, update() {}, dispose() {}, async animateConstructed() {}, async animateDestroyed() {} });
export const createOverlayLayer: CreateOverlayLayer = () => ({ set() {}, update() {}, dispose() {} });
export const createFxLayer: CreateFxLayer = () => ({
  async projectile() {}, damageNumber() {}, burst() {}, async spell() {}, levelUp() {}, hitSpark() {}, update() {}, dispose() {},
});
