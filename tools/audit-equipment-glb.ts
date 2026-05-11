#!/usr/bin/env bun
/**
 * Walk every GLB under client/public/assets/equipment/{body,legs,hands,feet,cape}
 * and verify it has proper skinning (skin block, mesh+skin-bound node, and
 * JOINTS_0/WEIGHTS_0 attributes). Skinned-slot GLBs that lack these load
 * silently — attachSkinnedArmor and attachManualSkinnedArmor both bail without
 * an obvious error, so the body-hide hook doesn't fire and the player just
 * looks normal. Catches Blender exports that forgot Armature parent + weights.
 *
 * Usage: bun tools/audit-equipment-glb.ts
 */
import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = 'client/public/assets/equipment';
const SKINNED_SLOTS = new Set(['body', 'legs', 'hands', 'feet', 'cape']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.glb')) out.push(p);
  }
  return out;
}

function inspect(file: string): { ok: boolean; reason?: string } {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== 0x46546c67) return { ok: false, reason: 'Not a GLB' };
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf-8'));
  if (!json.skins?.length) return { ok: false, reason: 'no skin block' };
  const boundMeshNode = (json.nodes || []).find((n: any) => n.mesh !== undefined && n.skin !== undefined);
  if (!boundMeshNode) return { ok: false, reason: 'no node with both mesh and skin' };
  const attrs = json.meshes?.[0]?.primitives?.[0]?.attributes ?? {};
  if (!('JOINTS_0' in attrs) || !('WEIGHTS_0' in attrs)) {
    return { ok: false, reason: `missing JOINTS_0/WEIGHTS_0 (attrs: ${Object.keys(attrs).join(',')})` };
  }
  return { ok: true };
}

const files = walk(ROOT).sort();
let broken = 0;
for (const f of files) {
  const rel = f.replace(ROOT + '/', '');
  const slot = rel.split('/')[0].toLowerCase();
  if (!SKINNED_SLOTS.has(slot)) continue;
  const r = inspect(f);
  if (!r.ok) {
    console.log(`✗ ${rel} — ${r.reason}`);
    broken++;
  }
}
console.log(`---\nScanned ${files.length} GLBs (${SKINNED_SLOTS.size} skinned slots), ${broken} broken.`);
if (broken > 0) process.exit(1);
