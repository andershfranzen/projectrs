#!/usr/bin/env bun
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const profilerRoot = resolve('tools', 'profiler-runs');

function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value).toLocaleString()
    : 'n/a';
}

function formatRate(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? (value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(1))
    : 'n/a';
}

function get(record, path) {
  let value = record;
  for (const key of path) {
    if (!value || typeof value !== 'object') return undefined;
    value = value[key];
  }
  return value;
}

function formatValue(value) {
  if (typeof value === 'number') return Math.abs(value) < 100 ? formatRate(value) : formatCount(value);
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'none';
  if (value == null || value === '') return 'n/a';
  return String(value);
}

function formatDelta(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return '';
  const delta = b - a;
  if (Math.abs(delta) < 0.05) return '0';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${Math.abs(delta) < 100 ? delta.toFixed(1) : Math.round(delta).toLocaleString()}`;
}

function formatCanvas(snapshot) {
  const canvas = snapshot.canvas;
  if (!canvas) return 'n/a';
  return `${formatCount(canvas.width)}x${formatCount(canvas.height)} / ${formatCount(canvas.clientWidth)}x${formatCount(canvas.clientHeight)}, DPR ${formatRate(canvas.devicePixelRatio)}`;
}

function formatBudgetRow(row) {
  if (!row || typeof row !== 'object') return 'n/a';
  const name = row.name || row.chunk || '<unnamed>';
  const vertices = row.vertices == null ? '' : `, ${formatCount(row.vertices)}v`;
  const indices = row.indices == null ? '' : `, ${formatCount(row.indices)}i`;
  return `${name} (${formatCount(row.count)}x${vertices}${indices})`;
}

async function latestRunDirs(limit = 2) {
  const names = await readdir(profilerRoot);
  const dirs = [];
  for (const name of names) {
    const dir = join(profilerRoot, name);
    try {
      if ((await stat(dir)).isDirectory()) dirs.push(dir);
    } catch {
      // Ignore files deleted between readdir/stat.
    }
  }
  return dirs.sort().slice(-limit);
}

async function snapshotPath(input) {
  const candidate = resolve(input);
  const info = await stat(candidate);
  if (!info.isDirectory()) return candidate;
  return join(candidate, 'evilquest-snapshot.json');
}

async function readSnapshot(input) {
  const file = await snapshotPath(input);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  if (raw.ok === true && raw.snapshot) return { file, snapshot: raw.snapshot };
  if (raw.evilQuestSnapshot?.snapshot) return { file, snapshot: raw.evilQuestSnapshot.snapshot };
  if (raw.evilQuestSnapshot && raw.evilQuestSnapshot.measuredFps != null) return { file, snapshot: raw.evilQuestSnapshot };
  if (raw.measuredFps != null || raw.sceneBudget) return { file, snapshot: raw };
  throw new Error(`${file} does not contain a completed EvilQuest snapshot`);
}

function printMetric(label, aSnapshot, bSnapshot, path) {
  const a = get(aSnapshot, path);
  const b = get(bSnapshot, path);
  const delta = formatDelta(a, b);
  console.log(`${label.padEnd(24)} ${formatValue(a).padStart(12)} -> ${formatValue(b).padStart(12)}${delta ? `  (${delta})` : ''}`);
}

function printBudget(label, aRows, bRows, limit = 8) {
  console.log(`\n${label}`);
  const count = Math.max(aRows?.length ?? 0, bRows?.length ?? 0, limit);
  for (let i = 0; i < Math.min(count, limit); i += 1) {
    const left = formatBudgetRow(aRows?.[i]).padEnd(54);
    const right = formatBudgetRow(bRows?.[i]);
    console.log(`  ${left} -> ${right}`);
  }
}

async function main() {
  let [aArg, bArg] = process.argv.slice(2);
  if (!aArg || !bArg) {
    const latest = await latestRunDirs(2);
    if (latest.length < 2) {
      throw new Error('Pass two profiler run directories/files, or create at least two runs under tools/profiler-runs.');
    }
    [aArg, bArg] = latest;
  }

  const a = await readSnapshot(aArg);
  const b = await readSnapshot(bArg);
  const aSnapshot = a.snapshot;
  const bSnapshot = b.snapshot;

  console.log(`A: ${a.file}`);
  console.log(`B: ${b.file}`);
  console.log('');
  console.log(`Renderer A: ${aSnapshot.webgl?.unmaskedRenderer || aSnapshot.webgl?.renderer || 'unknown'}`);
  console.log(`Renderer B: ${bSnapshot.webgl?.unmaskedRenderer || bSnapshot.webgl?.renderer || 'unknown'}`);
  console.log(`Flags A: ${formatValue(aSnapshot.diagnosticFlags)}`);
  console.log(`Flags B: ${formatValue(bSnapshot.diagnosticFlags)}`);
  console.log(`Canvas A: ${formatCanvas(aSnapshot)}`);
  console.log(`Canvas B: ${formatCanvas(bSnapshot)}`);
  console.log('');

  const metrics = [
    ['Measured FPS', ['measuredFps']],
    ['Engine FPS', ['engineFps']],
    ['Draw calls', ['drawCalls']],
    ['Active meshes', ['activeMeshes']],
    ['Total meshes', ['totalMeshes']],
    ['Total vertices', ['totalVertices']],
    ['Total indices', ['totalIndices']],
    ['Render scale', ['renderScale']],
    ['Active pickable', ['sceneBudget', 'summary', 'activePickableMeshes']],
    ['Total pickable', ['sceneBudget', 'summary', 'pickableMeshes']],
    ['Enabled meshes', ['sceneBudget', 'summary', 'enabledMeshes']],
    ['Materials', ['sceneBudget', 'summary', 'materials']],
    ['Textures', ['sceneBudget', 'summary', 'textures']],
    ['Animatables', ['sceneBudget', 'summary', 'activeAnimatables']],
    ['Grass vertices', ['chunkMeshes', 'grassVertices']],
    ['Detail vertices', ['chunkMeshes', 'detailVertices']],
  ];
  for (const [label, path] of metrics) printMetric(label, aSnapshot, bSnapshot, path);

  printBudget('Top active meshes', aSnapshot.sceneBudget?.activeByName, bSnapshot.sceneBudget?.activeByName);
  printBudget('Top active pickable meshes', aSnapshot.sceneBudget?.activePickableByName, bSnapshot.sceneBudget?.activePickableByName);
  printBudget('Top enabled meshes', aSnapshot.sceneBudget?.enabledByName, bSnapshot.sceneBudget?.enabledByName, 5);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
