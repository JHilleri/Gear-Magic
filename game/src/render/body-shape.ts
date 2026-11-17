// Body proportions as a deformation of the shared rig. Every skinned layer (body, brows, fitted
// armor) and every bind-space attachment (hair, eyes) follows, because the change lives in the
// skeleton: each bone's inverse bind matrix gains a scale about the bone's own head, and its
// children are carried along by offset nodes. Animation clips keep working untouched: they write
// the bones' own transforms, never the offsets.
import * as THREE from 'three';
import type { BodyShape } from '../core/types';
import { SHAPE_KEYS } from '../data/appearance';

type Axis = 'x' | 'y' | 'z';
/** Per slider: bone → gain per armature axis (x across, y up, z depth) at slider value 1. Arms lie along x in the bind pose. */
const EFFECTS: Record<keyof BodyShape, Record<string, Partial<Record<Axis, number>>>> = {
  height: {},
  legs: { thigh: { y: .12 }, shin: { y: .12 } },
  shins: { shin: { y: .25 } },
  torso: { hips: { y: .05 }, spine: { y: .1 }, chest: { y: .1 } },
  arms: { upperarm: { x: .1 }, forearm: { x: .1 } },
  shoulders: { shoulder: { x: .18 }, chest: { x: .06 } },
  chest: { chest: { z: .14, x: .04 } },
  waist: { spine: { x: .14, z: .14 } },
  hips: { hips: { x: .12, z: .1 }, thigh: { x: .07, z: .07 } },
  build: { upperarm: { y: .14, z: .14 }, forearm: { y: .14, z: .14 }, thigh: { x: .1, z: .1 }, shin: { x: .12, z: .12 }, neck: { x: .1, z: .1 } },
  head: { head: { x: .08, y: .08, z: .08 } },
};
const HEIGHT_GAIN = .06;
const OFFSET = 'shape_offset_';
const baseName = (name: string) => THREE.PropertyBinding.sanitizeNodeName(name).replace(/[._]?[LR]$/, '').toLowerCase();

/** Scale of one bone's region along the armature axes for this shape. */
export function boneScale(shape: BodyShape, bone: string): THREE.Vector3 {
  const out = new THREE.Vector3(1, 1, 1);
  const name = baseName(bone);
  for (const key of SHAPE_KEYS) {
    const value = THREE.MathUtils.clamp(shape[key] ?? 0, -1, 1);
    const gain = value && EFFECTS[key][name];
    if (!gain) continue;
    for (const axis of ['x', 'y', 'z'] as const) out[axis] *= 1 + (gain[axis] ?? 0) * value;
  }
  return out;
}

const originals = new WeakMap<THREE.Skeleton, THREE.Matrix4[]>();
const parentBone = (bone: THREE.Object3D): THREE.Bone | null => {
  for (let p = bone.parent; p; p = p.parent) if ((p as THREE.Bone).isBone) return p as THREE.Bone;
  return null;
};

/**
 * Reshapes every skinned mesh under `model` that is bound to the body's bones. Call it after
 * fitted armor is attached and before bind-space attachments (hair, eyes) are placed.
 * An absent or neutral shape on an untouched model does nothing.
 */
export function applyBodyShape(model: THREE.Object3D, shape: BodyShape | undefined): void {
  const meshes: THREE.SkinnedMesh[] = [];
  model.traverse((node) => { if ((node as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(node as THREE.SkinnedMesh); });
  const body = meshes.find((mesh) => mesh.skeleton.bones.some((bone) => bone.name === 'head'));
  if (!body) return;
  const active = !!shape && SHAPE_KEYS.some((key) => shape[key]);
  const touched = body.skeleton.bones.some((bone) => bone.parent?.name.startsWith(OFFSET)) || model.userData.shapeHeight !== undefined;
  if (!active && !touched) return;
  const s = shape ?? {};

  const bones = body.skeleton.bones;
  const source = originals.get(body.skeleton) ?? body.skeleton.boneInverses;
  const index = new Map(bones.map((bone, i) => [bone, i]));
  const bind = source.map((inverse) => inverse.clone().invert());
  const head = bind.map((m) => new THREE.Vector3().setFromMatrixPosition(m));
  const rotation = bind.map((m) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m)));
  const scale = bones.map((bone) => boneScale(s, bone.name));
  // Where each bone's head ends up: carried by its parent's scale, parents first.
  const moved: (THREE.Vector3 | null)[] = bones.map(() => null);
  const resolve = (i: number): THREE.Vector3 => {
    if (moved[i]) return moved[i]!;
    const parent = parentBone(bones[i]);
    const p = parent ? index.get(parent) : undefined;
    moved[i] = p === undefined ? head[i].clone() : head[i].clone().sub(head[p]).multiply(scale[p]).add(resolve(p));
    return moved[i]!;
  };
  bones.forEach((_, i) => resolve(i));
  // Longer legs must not sink the feet: lift everything under the root by what the feet dropped.
  let lift = 0;
  bones.forEach((bone, i) => { if (baseName(bone.name) === 'foot') lift = Math.max(lift, head[i].y - moved[i]!.y); });
  const feet = bones.some((bone) => baseName(bone.name) === 'foot');
  if (feet) bones.forEach((bone, i) => { if (parentBone(bone)) moved[i]!.y += lift; });

  // Children ride on an offset node between them and their parent bone.
  bones.forEach((bone, i) => {
    const parent = parentBone(bone);
    const p = parent ? index.get(parent) : undefined;
    if (!parent || p === undefined) return;
    const delta = moved[i]!.clone().sub(head[i]).sub(moved[p]!.clone().sub(head[p])).applyQuaternion(rotation[p].clone().invert());
    let holder = bone.parent!;
    if (!holder.name.startsWith(OFFSET)) {
      if (delta.lengthSq() < 1e-12) return;
      holder = new THREE.Group(); holder.name = OFFSET + bone.name;
      parent.add(holder); holder.add(bone);
    }
    holder.position.copy(delta);
  });
  // Sockets and other plain children of a bone keep their place on the scaled surface.
  bones.forEach((bone, i) => {
    const local = rotation[i];
    for (const child of bone.children) {
      if ((child as THREE.Bone).isBone || child.name.startsWith(OFFSET) || child.name.startsWith('unified_attachment_')) continue;
      const rest = (child.userData.shapeRest ??= child.position.clone()) as THREE.Vector3;
      child.position.copy(rest).applyQuaternion(local).multiply(scale[i]).applyQuaternion(local.clone().invert());
    }
  });
  const byName = new Map(bones.map((bone, i) => [bone, new THREE.Matrix4().makeTranslation(head[i])
    .multiply(new THREE.Matrix4().makeScale(scale[i].x, scale[i].y, scale[i].z))
    .multiply(new THREE.Matrix4().makeTranslation(head[i].clone().negate()))]));
  for (const mesh of meshes) {
    const skeleton = mesh.skeleton;
    if (!skeleton.bones.some((bone) => byName.has(bone))) continue;
    const first = originals.get(skeleton) ?? skeleton.boneInverses;
    originals.set(skeleton, first);
    // A new array: clones of one source share the original matrices.
    skeleton.boneInverses = first.map((inverse, i) => {
      const deform = byName.get(skeleton.bones[i]);
      return deform ? inverse.clone().multiply(deform) : inverse.clone();
    });
  }
  // Overall stature scales the armature node, weapons included.
  const armature = (() => { let top: THREE.Object3D = bones[0]; while (parentBone(top)) top = parentBone(top)!; return top.parent; })();
  if (armature && armature !== model.parent) {
    const rest = (model.userData.shapeHeight ??= armature.scale.clone()) as THREE.Vector3;
    armature.scale.copy(rest).multiplyScalar(1 + HEIGHT_GAIN * THREE.MathUtils.clamp(s.height ?? 0, -1, 1));
  }
  model.updateMatrixWorld(true);
}
