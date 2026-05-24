#!/usr/bin/env bun
/**
 * GLB compatibility checker for EvilQuest's character/gear pipeline.
 *
 *   bun tools/check-glb.ts <path-to-glb-or-directory> [--ref <reference-glb>]
 *
 * The reference defaults to `client/public/Character models/main character.glb`.
 * The tool reports:
 *   • Skin status (skinned/rigid) and joint count
 *   • Bone naming convention compliance (`mixamorig:*`)
 *   • Joint order alignment vs reference (critical for skinned armor)
 *   • Materials, textures, and any uses of unsupported palette shaders
 *   • Mesh bbox + height vs reference (for scale check)
 *   • Vertex weight diagnostics (max influences, zero-sum verts)
 *
 * Verdict: COMPATIBLE / WARN / INCOMPATIBLE per file.
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';

type Issue = { level: 'fail' | 'warn' | 'info'; msg: string };

type Report = {
  path: string;
  rigid: boolean;
  skinJoints: string[];
  bbox: { min: [number, number, number]; max: [number, number, number] };
  height: number;
  materials: { name: string; hasTex: boolean; baseColor: number[] }[];
  meshes: number;
  totalVerts: number;
  maxInfluencesPerVert: number;
  zeroSumVerts: number;
  issues: Issue[];
  verdict: 'COMPATIBLE' | 'WARN' | 'INCOMPATIBLE';
};

function readGlb(path: string): { gltf: any; bin: Uint8Array } {
  const buf = readFileSync(path);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== 0x46546c67) throw new Error(`${path}: not a GLB (magic=0x${magic.toString(16)})`);
  const chunkLen = dv.getUint32(12, true);
  const chunkType = dv.getUint32(16, true);
  if (chunkType !== 0x4e4f534a) throw new Error(`${path}: first chunk is not JSON`);
  const jsonBytes = buf.subarray(20, 20 + chunkLen);
  const gltf = JSON.parse(new TextDecoder().decode(jsonBytes));
  const binStart = 20 + chunkLen + 8;
  const binLen = dv.getUint32(20 + chunkLen, true);
  const bin = buf.subarray(binStart, binStart + binLen);
  return { gltf, bin };
}

function readAccessor(gltf: any, bin: Uint8Array, accIdx: number): { values: number[][]; type: string; count: number } {
  const acc = gltf.accessors[accIdx];
  const bv = gltf.bufferViews[acc.bufferView];
  const off = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type as string] ?? 1;
  const ctype = acc.componentType;
  let read: (i: number) => number;
  let bytes: number;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  switch (ctype) {
    case 5120: bytes = 1; read = (i) => dv.getInt8(off + i); break;
    case 5121: bytes = 1; read = (i) => dv.getUint8(off + i); break;
    case 5122: bytes = 2; read = (i) => dv.getInt16(off + i, true); break;
    case 5123: bytes = 2; read = (i) => dv.getUint16(off + i, true); break;
    case 5125: bytes = 4; read = (i) => dv.getUint32(off + i, true); break;
    case 5126: bytes = 4; read = (i) => dv.getFloat32(off + i, true); break;
    default: throw new Error(`unknown componentType ${ctype}`);
  }
  const values: number[][] = [];
  for (let v = 0; v < acc.count; v++) {
    const tuple: number[] = [];
    for (let c = 0; c < stride; c++) tuple.push(read((v * stride + c) * bytes));
    values.push(tuple);
  }
  return { values, type: acc.type, count: acc.count };
}

function checkGlb(path: string, refJoints: string[]): Report {
  const { gltf, bin } = readGlb(path);
  const issues: Issue[] = [];
  const skin = gltf.skins?.[0];
  const rigid = !skin;
  const skinJoints = skin ? skin.joints.map((idx: number) => gltf.nodes[idx]?.name ?? `node_${idx}`) : [];

  // Collect mesh stats
  let totalVerts = 0;
  let maxInfluences = 0;
  let zeroSumVerts = 0;
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives ?? []) {
      const posAcc = gltf.accessors[prim.attributes.POSITION];
      totalVerts += posAcc.count;
      if (posAcc.min && posAcc.max) {
        xs.push(posAcc.min[0], posAcc.max[0]);
        ys.push(posAcc.min[1], posAcc.max[1]);
        zs.push(posAcc.min[2], posAcc.max[2]);
      }
      if (prim.attributes.WEIGHTS_0 !== undefined) {
        const weights = readAccessor(gltf, bin, prim.attributes.WEIGHTS_0);
        for (const w of weights.values) {
          let nz = 0; let sum = 0;
          for (const x of w) { sum += x; if (x > 0) nz++; }
          if (nz > maxInfluences) maxInfluences = nz;
          if (sum < 0.5) zeroSumVerts++; // very loose threshold for normalized weights
        }
      }
    }
  }
  const bbox = {
    min: [Math.min(...xs, 0), Math.min(...ys, 0), Math.min(...zs, 0)] as [number, number, number],
    max: [Math.max(...xs, 0), Math.max(...ys, 0), Math.max(...zs, 0)] as [number, number, number],
  };
  const height = bbox.max[1] - bbox.min[1];

  // Material stats
  const materials = (gltf.materials ?? []).map((m: any) => ({
    name: m.name ?? '?',
    hasTex: !!(m.pbrMetallicRoughness?.baseColorTexture),
    baseColor: m.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1],
  }));

  // Compatibility checks
  if (skinJoints.length > 0) {
    const nonMixamo = skinJoints.filter((n: string) => !n.startsWith('mixamorig:') && n !== 'neutral_bone');
    if (nonMixamo.length > 0) {
      issues.push({
        level: 'fail',
        msg: `${nonMixamo.length}/${skinJoints.length} joints don't use mixamorig:* naming. Examples: ${nonMixamo.slice(0, 3).join(', ')}`,
      });
    }
    // Joint order vs reference
    if (refJoints.length > 0) {
      let mismatchAt = -1;
      const overlap = Math.min(refJoints.length, skinJoints.length);
      for (let i = 0; i < overlap; i++) {
        if (refJoints[i] !== skinJoints[i]) { mismatchAt = i; break; }
      }
      if (mismatchAt >= 0) {
        issues.push({
          level: 'fail',
          msg: `Joint order diverges from reference at index ${mismatchAt}: '${skinJoints[mismatchAt]}' vs ref '${refJoints[mismatchAt]}'`,
        });
      } else if (skinJoints.length < refJoints.length) {
        issues.push({
          level: 'warn',
          msg: `Skin has ${skinJoints.length} joints; reference has ${refJoints.length}. Compatible only if missing bones aren't weighted to.`,
        });
      } else if (skinJoints.length > refJoints.length) {
        const extra = skinJoints.slice(refJoints.length);
        const onlyNeutral = extra.every((n: string) => n === 'neutral_bone');
        if (!onlyNeutral) {
          issues.push({
            level: 'warn',
            msg: `Skin has ${skinJoints.length - refJoints.length} extra joints beyond reference. Compatible only if no vertex weights reference them. Extras: ${extra.slice(0, 5).join(', ')}`,
          });
        }
      }
    }
    if (skinJoints.includes('neutral_bone')) {
      issues.push({
        level: 'warn',
        msg: 'neutral_bone present (Blender exporter fallback). Verify no vertex weights reference it (run our extractor patch).',
      });
    }
    if (zeroSumVerts > 0) {
      issues.push({
        level: 'fail',
        msg: `${zeroSumVerts} vertices have weight sum near zero — they'll render at mesh origin as spikes.`,
      });
    }
    if (maxInfluences > 4) {
      issues.push({
        level: 'warn',
        msg: `${maxInfluences} bone influences per vertex; glTF caps at 4. Lowest-weight bones will be dropped at runtime.`,
      });
    }
  }

  // Material warnings
  for (const m of materials) {
    if (m.name.startsWith('genericRGBMat_')) {
      issues.push({
        level: 'fail',
        msg: `Material '${m.name}' uses Polytope's RGBRecolor shader convention. The runtime expects simple PBR; this material will render against a static palette texture only.`,
      });
    }
  }

  // Scale sanity
  if (height > 0) {
    if (skinJoints.length > 0) {
      // Skinned armor — should match character height (~1.5–1.8m bbox)
      if (height < 0.5) issues.push({ level: 'warn', msg: `Bbox height ${height.toFixed(2)}m looks small for skinned armor. May be cm-scale.` });
      if (height > 3.0) issues.push({ level: 'warn', msg: `Bbox height ${height.toFixed(2)}m looks large. May be authored at 100x scale (cm).` });
    } else {
      // Rigid gear — anything from a few cm (rings) to ~1.5m (greatswords)
      if (height > 3.0) issues.push({ level: 'warn', msg: `Bbox height ${height.toFixed(2)}m looks large for a single piece. May be cm-scale.` });
    }
  }

  // Verdict
  let verdict: Report['verdict'] = 'COMPATIBLE';
  if (issues.some((i) => i.level === 'fail')) verdict = 'INCOMPATIBLE';
  else if (issues.some((i) => i.level === 'warn')) verdict = 'WARN';

  return { path, rigid, skinJoints, bbox, height, materials, meshes: gltf.meshes?.length ?? 0, totalVerts, maxInfluencesPerVert: maxInfluences, zeroSumVerts, issues, verdict };
}

function printReport(r: Report) {
  const verdictColor = r.verdict === 'COMPATIBLE' ? '\x1b[32m' : r.verdict === 'WARN' ? '\x1b[33m' : '\x1b[31m';
  console.log(`\n${'='.repeat(80)}`);
  console.log(`${verdictColor}${r.verdict}\x1b[0m  ${r.path}`);
  console.log(`  ${r.rigid ? 'rigid' : 'skinned'}, ${r.meshes} mesh(es), ${r.totalVerts} verts, height ${r.height.toFixed(2)}m`);
  if (!r.rigid) console.log(`  ${r.skinJoints.length} joints, max ${r.maxInfluencesPerVert} influences/vert${r.zeroSumVerts ? `, ${r.zeroSumVerts} zero-sum verts` : ''}`);
  console.log(`  Materials: ${r.materials.map((m) => `${m.name}${m.hasTex ? '+tex' : ''}`).join(', ') || '(none)'}`);
  for (const i of r.issues) {
    const sym = i.level === 'fail' ? '\x1b[31m✗\x1b[0m' : i.level === 'warn' ? '\x1b[33m⚠\x1b[0m' : '\x1b[36mℹ\x1b[0m';
    console.log(`  ${sym} ${i.msg}`);
  }
  if (r.issues.length === 0) console.log('  no issues found.');
}

// ---- entry ----

const args = Bun.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: bun tools/check-glb.ts <path-or-dir> [--ref <reference-glb>]');
  process.exit(1);
}
const refIdx = args.indexOf('--ref');
const refPath = refIdx >= 0 ? args[refIdx + 1] : 'client/public/Character models/main character.glb';
const targets = refIdx >= 0
  ? args.filter((_, i) => i !== refIdx && i !== refIdx + 1)
  : args;

let refJoints: string[] = [];
try {
  const { gltf } = readGlb(refPath);
  if (gltf.skins?.[0]) {
    refJoints = gltf.skins[0].joints.map((idx: number) => gltf.nodes[idx]?.name ?? `node_${idx}`);
  }
  console.log(`Reference: ${refPath} (${refJoints.length} joints)`);
} catch (e) {
  console.warn(`Warning: reference ${refPath} not loaded — joint-order checks disabled. (${(e as Error).message})`);
}

const files: string[] = [];
for (const t of targets) {
  const stat = statSync(t);
  if (stat.isDirectory()) {
    for (const f of readdirSync(t, { recursive: true }) as string[]) {
      if (extname(f).toLowerCase() === '.glb') files.push(join(t, f));
    }
  } else if (extname(t).toLowerCase() === '.glb') {
    files.push(t);
  }
}

const summary: Record<Report['verdict'], number> = { COMPATIBLE: 0, WARN: 0, INCOMPATIBLE: 0 };
for (const f of files) {
  try {
    const r = checkGlb(f, refJoints);
    printReport(r);
    summary[r.verdict]++;
  } catch (e) {
    console.error(`\n\x1b[31mERROR\x1b[0m ${f}: ${(e as Error).message}`);
    summary.INCOMPATIBLE++;
  }
}
console.log(`\n${'='.repeat(80)}`);
console.log(`Summary: \x1b[32m${summary.COMPATIBLE} compatible\x1b[0m, \x1b[33m${summary.WARN} with warnings\x1b[0m, \x1b[31m${summary.INCOMPATIBLE} incompatible\x1b[0m (${files.length} total)`);
