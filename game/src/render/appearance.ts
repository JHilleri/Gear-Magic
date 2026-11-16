// A unit's looks on its rigged body (DESIGN §4.9): the face model that replaces the body's own
// coarse head, the hair and beard pieces, all riding the head bone and tinted to the unit's hair,
// eye and skin colours. Shared by the unit layer (render/units.ts) and the portrait renderer
// (render/portrait.ts).
//
// Everything is placed in the **head frame** (blender/fit_hair.py): origin at the crown of the
// skull, on the centre line, at the occiput; one skull depth per unit; +Y up, +Z forward. A body's
// manifest entry gives that frame in its bind space (`head`); faces and hair are modelled in it.
import * as THREE from 'three';
import type { Appearance, Gender, SkinTone } from '../core/types';
import { eyeColorDef, hairColorDef, skinToneDef } from '../data/appearance';
import type { AssetLibrary, AssetManifest } from './types';

type UnitEntry = AssetManifest['units'][string];
type HeadEntry = AssetManifest['heads'][string];
type HeadFrame = NonNullable<UnitEntry['head']>;
type Ring = NonNullable<UnitEntry['neckRing']>;
type ShaderParams = Parameters<THREE.Material['onBeforeCompile']>[0];

/** Hair on a body's own head (no face model): scaled a little over the measured skull, so the scalp never shows through. */
const HAIR_FIT = 1.04;
/** The neck line rises this much (skull depths) from the throat to the nape (blender/fit_head.py NAPE_RISE). */
const NAPE_RISE = 0.25;
/** Radial map of a head (blender/headmap.py: the same centre, size and direction → cell mapping). */
const MAP_W = 64, MAP_H = 32;
const MAP_CENTRE = '0.0, -0.72, 0.5';
const MAP_C = new THREE.Vector3(0, -0.72, 0.5);
/** Conformed hair keeps this much more than its modelled clearance over the face's surface (skull depths). */
const FIT_CLEARANCE = 0.012;

/** GLSL shared by the body and the face: the hairline, the neck line. Frame-space position `h`. */
const FRAME_GLSL = `
// Generated albedos contain baked highlights/shadows and the original metadata sampled near
// the lips. A free multiplicative gain can therefore drive the forehead above white. Compress
// texture detail around the chosen albedo, preserving freckles/lips without changing its tone.
vec3 unitSkinColor(vec3 texel, vec3 source, vec3 target) {
  vec3 detail = pow(max(texel / max(source, vec3(0.001)), vec3(0.001)), vec3(0.55));
  return target * clamp(detail, vec3(0.18), vec3(1.22));
}
// Scalp under a hair cut: above a hairline that runs from the forehead over the temple, round the
// top of the ear and down behind it to the nape. Never the ear itself.
float unitScalp(vec3 h) {
  if (h.y < -1.25 || abs(h.x) > 0.75) return 0.0;
  float z = h.z;
  float line = z > 0.75 ? mix(-0.4, -0.2, clamp((z - 0.75) / 0.25, 0.0, 1.0))
    : z > 0.5 ? mix(-0.44, -0.4, (z - 0.5) / 0.25)
    : z > 0.22 ? mix(-0.8, -0.44, (z - 0.22) / 0.28)
    : mix(-0.98, -0.8, clamp(z / 0.22, 0.0, 1.0));
  float s = smoothstep(line, line + 0.05, h.y);
  float ear = smoothstep(0.27, 0.31, abs(h.x)) * smoothstep(0.24, 0.3, z) * (1.0 - smoothstep(0.72, 0.78, z)) * (1.0 - smoothstep(-0.42, -0.36, h.y));
  return s * (1.0 - ear);
}
// Its colour: the hair colour as a hair piece shows it, with strands combed back.
vec3 unitScalpColor(vec3 h, vec3 hair) {
  float strand = 0.5 + 0.5 * sin(h.x * 95.0 + 2.5 * sin(h.z * 21.0 + h.y * 9.0));
  return hair * (0.4 + 0.16 * strand);
}
// Height of the head / neck line at depth h.z: the throat at the front, higher at the nape.
float unitNeckLine(float z, float throat) { return throat + ${NAPE_RISE.toFixed(2)} * (1.0 - clamp(z, 0.0, 0.8) / 0.8); }
`;

/**
 * What is painted on a bald body (bind space):
 * - `hide`: the body wears a face model, so its own head is cut away above its throat line;
 * - else its own face stays: `eyes` are drawn over the (very coarse) face texels and, under a hair
 *   cut, the `scalp` takes the hair colour so a gap in a hair piece shows cropped hair, not skin.
 */
export interface BodyPaint {
  frame: THREE.Vector4;            // head frame origin + skull depth
  hide: boolean; neck: number;     // throat line (frame units)
  eyeA: THREE.Vector3; eyeB: THREE.Vector3; eyeR: number; eyeColor: THREE.Color;   // eyeR 0: none
  scalp: boolean; hair: THREE.Color;
  skinTint: THREE.Color; skinSource: THREE.Color; skinOn: boolean;
  skinTarget: THREE.Color; neckSkinSource: THREE.Color;
}

/** Texture-relative colour adjustment, in linear space. Missing/invalid metadata stays neutral. */
export function skinTintFor(source: readonly number[] | undefined, tone: SkinTone | undefined): THREE.Color {
  const target = skinToneDef(tone);
  if (!target || !source || source.length !== 3 || source.some((c) => !Number.isFinite(c) || c <= 0 || c > 1)) return new THREE.Color(1, 1, 1);
  const to = new THREE.Color(target.color);
  return new THREE.Color().setRGB(
    to.r / Math.max(1e-4, srgbToLinear(source[0])),
    to.g / Math.max(1e-4, srgbToLinear(source[1])),
    to.b / Math.max(1e-4, srgbToLinear(source[2])),
  );
}

/** A body's throat line (frame units): where its neck begins under the chin; a measure out of range is not trusted. */
function bodyThroat(h: HeadFrame): number {
  const n = h.neck;
  return typeof n === 'number' && n <= -1.05 && n >= -1.32 ? n : -1.2;
}

/** Paint for a body wearing `look` (null: nothing to paint); `hasFace`: a face model replaces its head. */
export function bodyPaintFor(entry: UnitEntry | undefined, look: Appearance | undefined, hasFace: boolean): BodyPaint | null {
  const h = entry?.head;
  if (!look || !h) return null;
  const eye = eyeColorDef(look.eyes);
  const ownEyes = !hasFace && eye && entry?.eyes?.length === 2 ? entry.eyes : null;
  return {
    frame: new THREE.Vector4(h.x, h.y, h.z, h.depth),
    hide: hasFace, neck: bodyThroat(h),
    eyeA: new THREE.Vector3(...(ownEyes?.[0] ?? [0, 0, 0])), eyeB: new THREE.Vector3(...(ownEyes?.[1] ?? [0, 0, 0])),
    eyeR: ownEyes ? entry?.eyeR ?? 0.007 : 0, eyeColor: new THREE.Color(eye?.color ?? '#6b4423'),
    scalp: !hasFace && look.hair !== 'bald', hair: new THREE.Color(hairColorDef(look.hairColor)?.color ?? '#7a5233'),
    skinTint: skinTintFor(entry?.skin, look.skin),
    skinSource: entry?.skin ? new THREE.Color().setRGB(...entry.skin, THREE.SRGBColorSpace) : new THREE.Color(1, 1, 1),
    skinOn: !!skinToneDef(look.skin) && !!entry?.skin,
    skinTarget: new THREE.Color(skinToneDef(look.skin)?.color ?? '#ffffff'),
    neckSkinSource: new THREE.Color().setRGB(...(entry?.neckRing?.skin ?? entry?.skin ?? [1, 1, 1]), THREE.SRGBColorSpace),
  };
}

/** Program cache key of a body material patched with `paint` (the variants compile differently). */
export function bodyPaintKey(paint: BodyPaint): string {
  return paint.hide ? 'body-face' : 'body-eyes';
}

/**
 * Apply a BodyPaint in a standard material's shader (call from onBeforeCompile; give the material
 * bodyPaintKey as part of its customProgramCacheKey). Bind space, so it follows the head bone.
 */
export function patchBodyShader(sh: ShaderParams, p: BodyPaint): void {
  Object.assign(sh.uniforms, {
    uHeadFrame: { value: p.frame }, uNeck: { value: p.neck },
    uEyeA: { value: p.eyeA }, uEyeB: { value: p.eyeB }, uEyeR: { value: p.eyeR }, uEyeColor: { value: p.eyeColor },
    uScalpOn: { value: p.scalp ? 1 : 0 }, uHairColor: { value: p.hair },
    uSkinTint: { value: p.skinTint }, uSkinSource: { value: p.skinSource }, uSkinOn: { value: p.skinOn ? 1 : 0 },
    uSkinTarget: { value: p.skinTarget }, uNeckSkinSource: { value: p.neckSkinSource },
  });
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vBindPos;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vBindPos = position;');
  const head = `#include <common>
varying vec3 vBindPos; uniform vec4 uHeadFrame; uniform float uNeck;
uniform vec3 uEyeA; uniform vec3 uEyeB; uniform float uEyeR; uniform vec3 uEyeColor; uniform float uScalpOn; uniform vec3 uHairColor;
uniform vec3 uSkinTint; uniform vec3 uSkinSource; uniform float uSkinOn;
uniform vec3 uSkinTarget; uniform vec3 uNeckSkinSource;
${FRAME_GLSL}
vec4 unitEye(vec3 p, vec3 c) {
  vec3 d = p - c;
  if (abs(d.z) > uEyeR * 4.0 || abs(d.x) > uEyeR * 2.2 || abs(d.y) > uEyeR * 1.6) return vec4(0.0);
  float px = (fwidth(p.x) + 1e-5) / uEyeR;
  float edge = length(vec2(d.x / 1.7, d.y / 0.92) / uEyeR);
  float ball = 1.0 - smoothstep(1.0 - 2.0 * px, 1.0, edge);
  float rr = length(d.xy) / uEyeR;
  float iris = 1.0 - smoothstep(0.8, 0.8 + 2.0 * px, rr);
  float pupil = 1.0 - smoothstep(0.32, 0.32 + 2.0 * px, rr);
  vec3 col = mix(vec3(0.76, 0.72, 0.69), uEyeColor * mix(1.2, 0.6, smoothstep(0.4, 0.8, rr)), iris);
  col = mix(col, vec3(0.03), pupil);
  col *= mix(1.0, 0.45, smoothstep(0.1, 0.9, d.y / uEyeR));   // the lid's shade on the upper part
  col = mix(col, vec3(0.2, 0.13, 0.1), 0.7 * smoothstep(0.84, 1.0, edge)); // lash line
  return vec4(col, ball);
}`;
  // The existing bodies use a single painted texture for skin and clothing. Only tint the
  // head/neck and hands in bind space, and only skin-coloured texels there. Leather, the torso,
  // weapons and the rest of the armour must retain their authored colours.
  const skin = `#include <map_fragment>
  if (uSkinOn > 0.5) {
    vec3 hs = (vBindPos - uHeadFrame.xyz) / uHeadFrame.w;
    float headSkin = smoothstep(-1.65, -1.4, hs.y) * (1.0 - smoothstep(0.65, 0.8, abs(hs.x)));
    float handSkin = smoothstep(0.32, 0.37, abs(vBindPos.x)) * smoothstep(0.65, 0.7, vBindPos.y) * (1.0 - smoothstep(0.87, 0.92, vBindPos.y));
    vec3 source = mix(uSkinSource, uNeckSkinSource, headSkin);
    vec3 chroma = diffuseColor.rgb / max(1e-4, diffuseColor.r + diffuseColor.g + diffuseColor.b);
    vec3 sourceChroma = source / max(1e-4, source.r + source.g + source.b);
    float matchesSkin = 1.0 - smoothstep(0.075, 0.17, distance(chroma, sourceChroma));
    float exposedSkin = max(headSkin, handSkin) * matchesSkin;
    diffuseColor.rgb = mix(diffuseColor.rgb, unitSkinColor(diffuseColor.rgb, source, uSkinTarget), exposedSkin);
  }`;
  const body = p.hide
    ? `${skin}
  { vec3 h = (vBindPos - uHeadFrame.xyz) / uHeadFrame.w;
    if (h.y > unitNeckLine(h.z, uNeck) - 0.08 && length(vec2(h.x, h.z - 0.5)) < 0.8) discard; }`
    : `${skin}
  { if (uEyeR > 0.0) { vec4 eA = unitEye(vBindPos, uEyeA); vec4 eB = unitEye(vBindPos, uEyeB); vec4 e = eA.a > eB.a ? eA : eB; diffuseColor.rgb = mix(diffuseColor.rgb, e.rgb, e.a); }
    if (uScalpOn > 0.5) { vec3 hs = (vBindPos - uHeadFrame.xyz) / uHeadFrame.w; diffuseColor.rgb = mix(diffuseColor.rgb, unitScalpColor(hs, uHairColor), unitScalp(hs)); } }`;
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', head).replace('#include <map_fragment>', body);
}

/** The face model of a look ('head_<m|f><n>', manifest `heads`). */
export function headModelKey(gender: Gender, look: Appearance): string {
  return `head_${gender === 'female' ? 'f' : 'm'}${(Number.isInteger(look.face) ? look.face : 0) + 1}`;
}

/** Hair and beard piece keys of a look (manifest `hair`): none for a bald head / a shaven chin. */
export function hairPieceKeys(look: Appearance | undefined): string[] {
  if (!look) return [];
  const keys: string[] = [];
  if (look.hair && look.hair !== 'bald') keys.push(`hair_${look.hair}`);
  if (look.beard && look.beard !== 'none') keys.push(`beard_${look.beard}`);
  return keys;
}

/** The head bone of a rigged body and the matrix taking bind space into it. */
function headBone(model: THREE.Object3D): { bone: THREE.Bone; toBone: THREE.Matrix4 } | null {
  let found: THREE.SkinnedMesh | null = null;
  model.traverse((o) => { if (!found && (o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh; });
  const sm = found as THREE.SkinnedMesh | null;
  const bones = sm?.skeleton?.bones ?? [];
  const bi = bones.findIndex((b) => b.name === 'head');
  if (!sm || bi < 0) return null;
  return { bone: bones[bi], toBone: new THREE.Matrix4().copy(sm.skeleton.boneInverses[bi]).multiply(sm.bindMatrix) };
}

function eachMaterial(root: THREE.Object3D, fn: (m: THREE.MeshStandardMaterial) => void): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) fn(mat as THREE.MeshStandardMaterial);
  });
}
function ownMaterials(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.material = Array.isArray(m.material) ? m.material.map((x) => x.clone()) : m.material.clone();
  });
}
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** Where a face model sits on a body: the head frame it and its hair are placed in, and its shape. */
export interface FaceFit { frame: THREE.Matrix4; map: THREE.Texture | null }

const headMaps = new WeakMap<THREE.BufferGeometry, THREE.DataTexture>();
const BARY = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5], [1 / 3, 1 / 3, 1 / 3], [0.66, 0.17, 0.17], [0.17, 0.66, 0.17], [0.17, 0.17, 0.66]];

/**
 * Radial map of a face model: the distance of its outer surface from a point inside the head, by
 * direction (blender/headmap.py). Hair and beards are conformed to it: each of their vertices
 * carries the distance of the surface it was modelled on, and moves by the difference.
 */
function headMapOf(piece: THREE.Object3D): THREE.DataTexture | null {
  let found: THREE.Mesh | null = null;
  piece.traverse((o) => { if (!found && (o as THREE.Mesh).isMesh) found = o as THREE.Mesh; });
  const mesh = found as THREE.Mesh | null;
  const pos = mesh?.geometry.getAttribute('position');
  if (!mesh || !pos) return null;
  const cached = headMaps.get(mesh.geometry);
  if (cached) return cached;
  piece.updateMatrixWorld(true);
  const n = MAP_W * MAP_H;
  let val: Float32Array = new Float32Array(n);
  let has: Float32Array = new Float32Array(n);
  const index = mesh.geometry.getIndex();
  const tris = (index ? index.count : pos.count) / 3;
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const p = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, index ? index.getX(t * 3 + k) : t * 3 + k).applyMatrix4(mesh.matrixWorld);
    for (const w of BARY) {
      p.set(0, 0, 0).addScaledVector(v[0], w[0]).addScaledVector(v[1], w[1]).addScaledVector(v[2], w[2]).sub(MAP_C);
      const rho = p.length();
      if (rho < 1e-6) continue;
      const iu = Math.min(MAP_W - 1, Math.max(0, Math.floor((Math.atan2(p.x, p.z) / (2 * Math.PI) + 0.5) * MAP_W)));
      const iv = Math.min(MAP_H - 1, Math.max(0, Math.floor((Math.acos(THREE.MathUtils.clamp(p.y / rho, -1, 1)) / Math.PI) * MAP_H)));
      const i = iv * MAP_W + iu;
      if (rho > val[i]) { val[i] = rho; has[i] = 1; }
    }
  }
  // 3×3 box blur, wrapping round the head, clamped at the poles
  const blur = (a: Float32Array): Float32Array => {
    const out = new Float32Array(n);
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(MAP_H - 1, Math.max(0, y + dy));
          for (let dx = -1; dx <= 1; dx++) sum += a[yy * MAP_W + ((x + dx + MAP_W) % MAP_W)];
        }
        out[y * MAP_W + x] = sum / 9;
      }
    }
    return out;
  };
  // directions with no surface (straight down the neck) take their neighbours', outward
  for (let it = 0; it < MAP_W && has.some((h) => h === 0); it++) {
    const sv = blur(val.map((x, i) => x * has[i]));
    const sn = blur(has);
    const nv = val.slice(), nh = has.slice();
    for (let i = 0; i < n; i++) if (has[i] === 0 && sn[i] > 0) { nv[i] = sv[i] / sn[i]; nh[i] = 1; }
    val = nv; has = nh;
  }
  val = blur(val);
  const data = new Uint16Array(n);
  for (let i = 0; i < n; i++) data[i] = THREE.DataUtils.toHalfFloat(val[i]);
  const tex = new THREE.DataTexture(data, MAP_W, MAP_H, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  headMaps.set(mesh.geometry, tex);
  return tex;
}

/** A neck ring that is bare skin and plausibly a neck (not a collar the measure took for one). */
function bareNeck(r: Ring | undefined): r is Ring & { skin: [number, number, number] } {
  return !!r && !!r.skin && Math.abs(r.cx) < 0.07 && r.rx > 0.18 && r.rx < 0.48 && r.rz > 0.18 && r.rz < 0.48;
}

/**
 * Put a face model on a bald rigged body whose own head is hidden (bodyPaintFor(…, true)).
 *
 * - **Size**: a body's head is taller for its skull than a face model's (chunky proportions), so
 *   the face is scaled until its throat is level with the body's: chin on chin, neck on neck.
 * - **Neck**: under its throat line the face keeps a short neck, which is shaped onto the body's
 *   neck ring (same width at the join, then inside it) and graded to the body's neck colour, when
 *   that neck is bare; inside a collar or a gorget it is simply drawn in.
 * - **Colour**: the face is tinted toward the body's skin, its irises are drawn in the eye colour
 *   (only on the eye itself: lids and skin are far more saturated than an eye), and under a hair
 *   cut its scalp takes the hair colour.
 *
 * `adopt` lets the caller take the piece's materials over first (else they are cloned). Returns
 * where the face sits (its hair goes in the same frame), or null when the body has no head bone.
 */
export function attachHead(
  model: THREE.Object3D, piece: THREE.Object3D, body: UnitEntry, face: HeadEntry | undefined, look: Appearance,
  adopt?: (piece: THREE.Object3D) => void,
): FaceFit | null {
  const hb = headBone(model);
  const head = body.head;
  if (!hb || !head) return null;
  const map = headMapOf(piece);
  if (adopt) adopt(piece); else ownMaterials(piece);
  const eye = eyeColorDef(look.eyes);
  const eyes = face?.eyes?.length === 2 ? face.eyes : null;
  const faceNeck = face?.neck ?? -1.1;
  const k = THREE.MathUtils.clamp(bodyThroat(head) / faceNeck, 0.95, 1.25);

  // the face toward the body's skin (the two models were painted apart)
  const tint = new THREE.Color(1, 1, 1);
  const skinLike = (c?: number[]) => !!c && c[0] > c[1] && c[1] > c[2] && c[0] > 0.3;
  const ratio = (to: number[], from: number[], lo: number, hi: number) =>
    new THREE.Color().setRGB(...([0, 1, 2].map((i) => THREE.MathUtils.clamp(srgbToLinear(to[i]) / Math.max(1e-3, srgbToLinear(from[i])), lo, hi)) as [number, number, number]));
  if (skinLike(body.skin) && skinLike(face?.skin)) tint.copy(ratio(body.skin!, face!.skin!, 0.72, 1.4));
  const customSkin = !!skinToneDef(look.skin);
  if (customSkin) tint.copy(skinTintFor(face?.skin, look.skin));

  // the neck: the face's ring → the body's (in the face's own frame units), or drawn in
  const from = face?.neckRing ?? { cx: 0, cz: 0.4, rx: 0.28, rz: 0.28 };
  const to = body.neckRing;
  const bare = bareNeck(to) && bareNeck(face?.neckRing);
  const neckTo = bare
    ? new THREE.Vector4(to!.cx / k, (to!.cz + 0.5 * (k - 1)) / k, to!.rx / k, to!.rz / k)
    : new THREE.Vector4(from.cx, from.cz, from.rx * 0.8, from.rz * 0.8);
  const neckTint = new THREE.Color(1, 1, 1);
  if (bare) {
    // With a chosen tone both meshes aim for the same colour at the seam, independent of armour.
    const want = customSkin ? skinTintFor(face!.neckRing!.skin!, look.skin) : ratio(to!.skin!, face!.neckRing!.skin!, 0.6, 1.6);
    neckTint.setRGB(want.r / tint.r, want.g / tint.g, want.b / tint.b);
  }

  const uniforms = {
    uEyeA: { value: new THREE.Vector3(...(eyes?.[0] ?? [0, 0, 0])) }, uEyeB: { value: new THREE.Vector3(...(eyes?.[1] ?? [0, 0, 0])) },
    uEyeR: { value: eyes && eye ? face?.eyeR ?? 0.034 : 0 }, uEyeColor: { value: new THREE.Color(eye?.color ?? '#6b4423') },
    uScalpOn: { value: look.hair !== 'bald' ? 1 : 0 }, uHairColor: { value: new THREE.Color(hairColorDef(look.hairColor)?.color ?? '#7a5233') },
    uNeckH: { value: faceNeck }, uNeckFrom: { value: new THREE.Vector4(from.cx, from.cz, from.rx, from.rz) }, uNeckTo: { value: neckTo },
    uNeckTint: { value: neckTint },
    uFaceSkinTint: { value: tint }, uFaceCustomSkin: { value: customSkin ? 1 : 0 },
    uFaceSkinSource: { value: new THREE.Color().setRGB(...(face?.skin ?? [1, 1, 1]), THREE.SRGBColorSpace) },
    uFaceNeckSkinSource: { value: new THREE.Color().setRGB(...(face?.neckRing?.skin ?? face?.skin ?? [1, 1, 1]), THREE.SRGBColorSpace) },
    uFaceSkinTarget: { value: new THREE.Color(skinToneDef(look.skin)?.color ?? '#ffffff') },
  };
  eachMaterial(piece, (m) => {
    if (m.color && !customSkin) m.color.multiply(tint);
    m.side = THREE.DoubleSide;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
varying vec3 vFramePos; uniform float uNeckH; uniform vec4 uNeckFrom; uniform vec4 uNeckTo;
${FRAME_GLSL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  vFramePos = position;
  { // the neck under the throat line: onto the body's neck ring at the join, then inside it
    float line = unitNeckLine(transformed.z, uNeckH);
    float t = 1.0 - smoothstep(line - 0.1, line + 0.02, transformed.y);
    if (t > 0.0) {
      vec2 q = (transformed.xz - uNeckFrom.xy) / uNeckFrom.zw;
      q /= max(1.0, length(q));
      // a touch wider than the body's neck where the two meet (no gap shows), then inside it
      float tuck = mix(0.84, 1.035, smoothstep(line - 0.27, line - 0.15, transformed.y));
      transformed.xz = mix(transformed.xz, uNeckTo.xy + q * uNeckTo.zw * tuck, t);
    }
  }`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vFramePos; uniform vec3 uEyeA; uniform vec3 uEyeB; uniform float uEyeR; uniform vec3 uEyeColor; uniform float uScalpOn; uniform vec3 uHairColor;
uniform float uNeckH; uniform vec3 uNeckTint;
uniform vec3 uFaceSkinTint; uniform float uFaceCustomSkin;
uniform vec3 uFaceSkinSource; uniform vec3 uFaceNeckSkinSource; uniform vec3 uFaceSkinTarget;
${FRAME_GLSL}
// An iris drawn round its centre: coloured ring, darker rim, pupil, a glint.
vec4 unitIris(vec3 p, vec3 c) {
  vec3 d = p - c;
  if (abs(d.z) > 0.3) return vec4(0.0);
  vec2 q = d.xy / uEyeR;
  float rr = length(q);
  if (rr > 1.05) return vec4(0.0);
  vec3 col = uEyeColor * mix(1.5, 0.95, smoothstep(0.3, 0.9, rr));
  col = mix(col, uEyeColor * 0.3, smoothstep(0.8, 1.0, rr));
  col = mix(col, vec3(0.015), 1.0 - smoothstep(0.3, 0.4, rr));
  col = mix(col, vec3(1.0), 0.85 * (1.0 - smoothstep(0.08, 0.2, length(q - vec2(-0.3, 0.34)))));
  // between the lids: a lens, a little under the centre line
  float lids = 1.0 - smoothstep(0.52, 0.68, abs(q.y + 0.06));
  return vec4(col, (1.0 - smoothstep(0.92, 1.05, rr)) * lids);
}`)
        .replace('#include <map_fragment>', `#include <map_fragment>
  { if (uFaceCustomSkin > 0.5) {
      // Preserve the whites of both eyes; skin, lip colour and freckles keep their texture detail.
      vec3 dA = vFramePos - uEyeA, dB = vFramePos - uEyeB;
      float eyeArea = uEyeR > 0.0 ? 1.0 - smoothstep(1.4, 2.2, min(length(vec2(dA.x, dA.y * 1.6)), length(vec2(dB.x, dB.y * 1.6))) / uEyeR) : 0.0;
      eyeArea *= 1.0 - smoothstep(0.15, 0.3, min(abs(dA.z), abs(dB.z)));
      float mxSkin = max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b));
      float mnSkin = min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b));
      float whiteEye = eyeArea * (1.0 - smoothstep(0.2, 0.42, (mxSkin - mnSkin) / max(mxSkin, 1e-4)));
      float neckBlend = 1.0 - smoothstep(-0.03, 0.22, vFramePos.y - unitNeckLine(vFramePos.z, uNeckH));
      vec3 skinSource = mix(uFaceSkinSource, uFaceNeckSkinSource, neckBlend);
      diffuseColor.rgb = mix(unitSkinColor(diffuseColor.rgb, skinSource, uFaceSkinTarget), diffuseColor.rgb, whiteEye);
    }
    if (uEyeR > 0.0) {
      vec4 iA = unitIris(vFramePos, uEyeA); vec4 iB = unitIris(vFramePos, uEyeB);
      vec4 iris = iA.a > iB.a ? iA : iB;
      #ifdef USE_MAP
        vec3 raw = sampledDiffuseColor.rgb;
      #else
        vec3 raw = diffuseColor.rgb;
      #endif
      float mx = max(raw.r, max(raw.g, raw.b)), mn = min(raw.r, min(raw.g, raw.b));
      // (the eye is pale grey and the lids skin: the iris shows fully on the eye, faintly where a lid droops over it)
      float eyeball = 1.0 - smoothstep(0.3, 0.46, mx > 1e-4 ? (mx - mn) / mx : 0.0);
      diffuseColor.rgb = mix(diffuseColor.rgb, iris.rgb, iris.a * mix(0.45, 1.0, eyeball));
    }
    if (uScalpOn > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, unitScalpColor(vFramePos, uHairColor), unitScalp(vFramePos));
    // toward the body's neck colour, from under the jaw down to the join
    float g = 1.0 - smoothstep(-0.03, 0.22, vFramePos.y - unitNeckLine(vFramePos.z, uNeckH));
    if (uFaceCustomSkin < 0.5) diffuseColor.rgb *= mix(vec3(1.0), uNeckTint, g); }`);
    };
    m.customProgramCacheKey = () => 'unit-face-skin-v3';
  });
  // the face's frame on this body: crown on crown, scaled about it, centred front to back
  const frame = new THREE.Matrix4().compose(
    new THREE.Vector3(head.x, head.y, head.z - 0.5 * (k - 1) * head.depth), new THREE.Quaternion(), new THREE.Vector3().setScalar(head.depth * k));
  const holder = new THREE.Group();
  holder.name = 'face';
  holder.add(piece);
  hb.toBone.clone().multiply(frame).decompose(holder.position, holder.quaternion, holder.scale);
  hb.bone.add(holder);
  return { frame, map };
}

/**
 * Put the hair and beard of `look` on a bald rigged body: each grey piece rides the head bone and
 * is tinted to the hair colour. On a face model (`fit`) the piece sits in the face's frame and is
 * **conformed** to it: every vertex carries the distance of the surface it was modelled on (a
 * second UV set written by blender/fit_hair.py) and moves, along its direction from the head's
 * centre, by how much the face's surface differs — so one piece fits every face. On the body's own
 * head it is placed rigidly, a little large. Returns the piece roots (`adopt` lets the caller take
 * their materials over first; else they are cloned).
 */
export function attachHair(
  assets: AssetLibrary, model: THREE.Object3D, head: HeadFrame, look: Appearance,
  adopt?: (piece: THREE.Object3D) => void, fit?: FaceFit | null,
): THREE.Object3D[] {
  const keys = hairPieceKeys(look);
  const hb = keys.length ? headBone(model) : null;
  if (!hb) return [];
  const tint = new THREE.Color(hairColorDef(look.hairColor)?.color ?? '#7a5233');
  const rigid = new THREE.Matrix4().compose(
    new THREE.Vector3(head.x, head.y + head.depth * 0.02, head.z - head.depth * 0.02),
    new THREE.Quaternion(), new THREE.Vector3().setScalar(head.depth * HAIR_FIT));
  const out: THREE.Object3D[] = [];
  for (const key of keys) {
    const piece = assets.model('hair', key);
    if (!piece) continue;
    // the fit attribute: TEXCOORD_1 = (source surface distance, weight)
    let fitted = !!fit?.map;
    piece.traverse((o) => {
      const g = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry : null;
      if (!g) return;
      if (!g.getAttribute('fitRW') && g.getAttribute('uv1')) g.setAttribute('fitRW', g.getAttribute('uv1'));
      if (!g.getAttribute('fitRW')) fitted = false;
    });
    if (adopt) adopt(piece); else ownMaterials(piece);
    const uniforms = { uHeadMap: { value: fit?.map ?? null } };
    eachMaterial(piece, (s) => {
      if (s.color) s.color.multiply(tint);
      s.side = THREE.DoubleSide;
      if (!fitted) return;
      s.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, uniforms);
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec2 fitRW; uniform sampler2D uHeadMap;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
  { vec3 rel = transformed - vec3(${MAP_CENTRE});
    float rho = max(length(rel), 1e-5);
    vec3 dn = rel / rho;
    vec2 huv = vec2(atan(dn.x, dn.z) / 6.28318530718 + 0.5, acos(clamp(dn.y, -1.0, 1.0)) / 3.14159265359);
    float target = texture2D(uHeadMap, huv).r;
    transformed = vec3(${MAP_CENTRE}) + dn * (rho + fitRW.y * (target - fitRW.x + ${FIT_CLEARANCE.toFixed(3)})); }`);
      };
      s.customProgramCacheKey = () => 'unit-hair-fit';
    });
    const holder = new THREE.Group();
    holder.name = key;
    holder.add(piece);
    hb.toBone.clone().multiply(fitted && fit ? fit.frame : rigid).decompose(holder.position, holder.quaternion, holder.scale);
    hb.bone.add(holder);
    out.push(holder);
  }
  return out;
}

/**
 * Dress a bald rigged body in `look`: its face model (when the library has it), hair and beard.
 * Returns the paint for the body's own materials (null: the body has no head frame) — apply it with
 * patchBodyShader **after** this call decided whether the body's head is hidden.
 */
export function dressHead(
  assets: AssetLibrary, model: THREE.Object3D, entry: UnitEntry | undefined, gender: Gender | undefined, look: Appearance | undefined,
  adopt?: (piece: THREE.Object3D) => void,
): BodyPaint | null {
  if (!entry?.head || !look) return null;
  const key = gender ? headModelKey(gender, look) : null;
  const piece = key ? assets.model('heads', key) : null;
  const face = piece && key ? attachHead(model, piece, entry, assets.manifest.heads?.[key], look, adopt) : null;
  attachHair(assets, model, entry.head, look, adopt, face);
  return bodyPaintFor(entry, look, !!face);
}
