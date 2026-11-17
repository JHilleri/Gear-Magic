#!/usr/bin/env node
// Check the shipped binary assets, including the seam and rig failures seen during assembly.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../public/assets/models/', import.meta.url));
async function glb(path) {
  const file = await readFile(resolve(root, path));
  assert.equal(file.readUInt32LE(0), 0x46546c67, `${path}: GLB header`);
  const length = file.readUInt32LE(12);
  const json = JSON.parse(file.subarray(20, 20 + length).toString());
  const binary = file.subarray(28 + length);
  const widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
  const types = { 5121: [1, 'readUInt8'], 5123: [2, 'readUInt16LE'], 5125: [4, 'readUInt32LE'], 5126: [4, 'readFloatLE'] };
  const values = (index) => {
    const a = json.accessors[index], v = json.bufferViews[a.bufferView];
    assert(!a.sparse, `${path}: sparse accessor unsupported by this check`);
    const [bytes, read] = types[a.componentType], width = widths[a.type];
    const start = (a.byteOffset ?? 0) + (v.byteOffset ?? 0), stride = v.byteStride ?? bytes * width;
    return Array.from({ length: a.count }, (_, i) => Array.from({ length: width }, (_, c) => binary[read](start + i * stride + c * bytes)));
  };
  return { json, values };
}
const key = (p) => p.map((v) => Math.round(v * 1e6)).join(',');
let checks = 0;
for (const gender of ['m', 'f']) {
  const name = `human_${gender}_base`;
  const body = await glb(`units/${name}.glb`);
  const { json: j, values } = body;
  const surface = j.meshes.find((m) => m.name === 'Continuous body and head');
  assert(surface, `${name}: one continuous head/body mesh`);
  assert.deepEqual(surface.weights, [0, 0], `${name}: neutral morphs at rest`);
  assert(j.animations.every((a) => a.channels.every((c) => c.target.path !== 'weights')), `${name}: clips must not overwrite face choice`);
  const vertices = new Map(), borders = new Map(), points = new Map(), edges = new Map();
  const parent = new Map();
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const p of surface.primitives) {
    const region = j.materials[p.material].name;
    const positions = values(p.attributes.POSITION), normals = values(p.attributes.NORMAL);
    const ids = positions.map((position, i) => {
      const id = key(position);
      if (!parent.has(id)) parent.set(id, id);
      const previous = vertices.get(id);
      if (previous && position[1] > .84) assert(Math.hypot(...normals[i].map((n, c) => n - previous[c])) < .03, `${name}: inconsistent neck/head seam normals`);
      vertices.set(id, normals[i]);
      points.set(id, position);
      if (!borders.has(id)) borders.set(id, new Set());
      borders.get(id).add(region);
      return id;
    });
    const indices = values(p.indices).flat();
    for (let i = 0; i < indices.length; i += 3) {
      const a = ids[indices[i]], b = ids[indices[i + 1]], c = ids[indices[i + 2]];
      parent.set(find(b), find(a)); parent.set(find(c), find(a));
      for (const pair of [[a,b],[b,c],[c,a]]) {
        const edge = pair.sort().join('|');
        edges.set(edge, (edges.get(edge) ?? 0) + 1);
      }
    }
    for (const w of values(p.attributes.WEIGHTS_0)) assert(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < .002, `${name}: normalized weights`);
  }
  assert.equal(new Set([...parent.keys()].map(find)).size, 1, `${name}: body/head surface must be connected`);
  assert([...borders.values()].some((r) => r.has('Skin_head') && r.has('Skin_torso')), `${name}: neck shares boundary vertices with torso`);
  const meta = JSON.parse(await readFile(resolve(root, `units/${name}.meta.json`), 'utf8'));
  const boundary = new Set([...edges].filter(([, count]) => count === 1).flatMap(([edge]) => edge.split('|')));
  for (const eye of meta.unified.eyes) {
    const rim = [...boundary].map((id) => points.get(id)).filter((p) => Math.abs(p[0]-eye.center[0]) < eye.aperture[0]*1.1 && Math.abs(p[1]-eye.center[1]) < eye.aperture[1]*1.5);
    assert(rim.length >= 8, `${name}: actual eye opening`);
    for (const p of rim) {
      const rho2 = (p[0]-eye.center[0])**2 + (p[1]-eye.center[1])**2;
      const globe = eye.center[2] + Math.sqrt(Math.max(0, eye.radius**2-rho2));
      assert(globe <= p[2]+.00005, `${name}: globe protrudes through eyelid`);
    }
  }
  const binds = values(j.skins[0].inverseBindMatrices);
  const byName = new Map(j.skins[0].joints.map((node, i) => [j.nodes[node].name, binds[i]]));
  for (const style of ['commoner', 'tunic', 'leather', 'plate', 'robe']) {
    const armor = await glb(`items/armor_${gender}_${style}.glb`);
    assert.equal(armor.json.skins.length, 1, `${gender}/${style}: skinned armor layer`);
    assert(!armor.json.animations?.length, `${gender}/${style}: follows body animation`);
    const inverse = armor.values(armor.json.skins[0].inverseBindMatrices);
    for (const [i, node] of armor.json.skins[0].joints.entries()) {
      const bone = armor.json.nodes[node].name, expected = byName.get(bone);
      assert(expected, `${gender}/${style}: unknown bone ${bone}`);
      assert(Math.max(...expected.map((v, c) => Math.abs(v - inverse[i][c]))) < .00005, `${gender}/${style}: incompatible bind for ${bone}`);
    }
    checks++;
  }
  const sourceHash = createHash('sha256').update(await readFile(resolve(root, `units/${name}.glb`))).digest('hex');
  const grooms = (await readdir(resolve(root, 'hair'))).filter((file) => file.startsWith(`unified_${gender}_`) && file.endsWith('.meta.json'));
  assert.equal(grooms.length, gender === 'm' ? 16 : 12, `${name}: complete fitted groom set`);
  for (const file of grooms) {
    const groom = JSON.parse(await readFile(resolve(root, 'hair', file), 'utf8'));
    assert.equal(groom.sourceSha256, sourceHash, `${file}: groom fitted to a stale body`);
    assert(groom.scalpClearance.min >= -.0001, `${file}: scalp penetration`);
    checks++;
  }
  checks++;
}
console.log(`PASS ${checks} unified asset checks (connected bodies, seams, eye clearance, armor binds and groom provenance)`);
