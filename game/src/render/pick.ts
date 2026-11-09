// Ray helpers shared by the picking code of the world and the entity layers.
import * as THREE from 'three';

/**
 * Ray vs. vertical capped cylinder standing on `base` (axis +Y, from base.y to base.y + height).
 * `d` must be normalised for the result to be a distance. Returns the nearest hit t > 0 or null.
 */
export function rayCylinder(o: THREE.Vector3, d: THREE.Vector3, base: THREE.Vector3, radius: number, height: number): number | null {
  const ox = o.x - base.x, oz = o.z - base.z;
  let best: number | null = null;
  const consider = (t: number) => { if (t > 0 && (best === null || t < best)) best = t; };
  const a = d.x * d.x + d.z * d.z;
  if (a > 1e-8) {
    const b = 2 * (ox * d.x + oz * d.z);
    const c = ox * ox + oz * oz - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      for (const t of [(-b - sq) / (2 * a), (-b + sq) / (2 * a)]) {
        const y = o.y + d.y * t - base.y;
        if (y >= 0 && y <= height) consider(t);
      }
    }
  }
  if (Math.abs(d.y) > 1e-6) {
    for (const capY of [base.y + height, base.y]) {
      const t = (capY - o.y) / d.y;
      const x = ox + d.x * t, z = oz + d.z * t;
      if (x * x + z * z <= radius * radius) consider(t);
    }
  }
  return best;
}

/** Is `o` and every ancestor up to (and including) `stop` visible? */
export function visibleUpTo(o: THREE.Object3D, stop: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === stop) return true;
  }
  return true;
}

const _hits: THREE.Intersection[] = [];
/**
 * Nearest triangle hit of the visible meshes under `root` (sprites, lines and x-ray twins are
 * skipped). Matrices are taken as last rendered. Returns the distance along the ray or null.
 */
export function raycastMeshes(raycaster: THREE.Raycaster, root: THREE.Object3D): number | null {
  let best: number | null = null;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (o as unknown as THREE.Sprite).isSprite || o.userData.xray || o.userData.noPick) return;
    if (!visibleUpTo(o, root)) return;
    _hits.length = 0;
    m.raycast(raycaster, _hits);
    for (const h of _hits) if (best === null || h.distance < best) best = h.distance;
  });
  _hits.length = 0;
  return best;
}
