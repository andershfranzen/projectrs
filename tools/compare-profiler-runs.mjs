#!/usr/bin/env bun
import { basename } from 'node:path';
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

function formatBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function formatDelta(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return '';
  const delta = b - a;
  if (Math.abs(delta) < 0.05) return '0';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${Math.abs(delta) < 100 ? delta.toFixed(1) : Math.round(delta).toLocaleString()}`;
}

function formatByteDelta(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) return '';
  const delta = b - a;
  if (Math.abs(delta) < 1) return '0 B';
  const sign = delta > 0 ? '+' : '-';
  return `${sign}${formatBytes(Math.abs(delta))}`;
}

function formatCanvas(snapshot) {
  const canvas = snapshot.canvas;
  if (!canvas) return 'n/a';
  return `${formatCount(canvas.width)}x${formatCount(canvas.height)} / ${formatCount(canvas.clientWidth)}x${formatCount(canvas.clientHeight)}, DPR ${formatRate(canvas.devicePixelRatio)}`;
}

function formatShortUrl(value) {
  if (!value) return 'n/a';
  try {
    const url = new URL(String(value));
    return `${url.host}${url.pathname}${url.search}`.slice(0, 96);
  } catch {
    return String(value).slice(0, 96);
  }
}

function formatBudgetRow(row) {
  if (!row || typeof row !== 'object') return 'n/a';
  const name = row.name || row.chunk || '<unnamed>';
  const vertices = row.vertices == null ? '' : `, ${formatCount(row.vertices)}v`;
  const indices = row.indices == null ? '' : `, ${formatCount(row.indices)}i`;
  return `${name} (${formatCount(row.count)}x${vertices}${indices})`;
}

function formatResourceRow(row) {
  if (!row || typeof row !== 'object') return 'n/a';
  const label = row.name || row.url
    ? formatShortUrl(row.name ?? row.url)
    : String(row.key ?? row.type ?? 'resource');
  const parts = [
    `${formatCount(row.count ?? 1)}x`,
    `${formatRate(row.duration ?? row.totalDurationMs ?? row.totalMs)}ms`,
  ];
  if (row.transferSize != null || row.transferBytes != null) parts.push(formatBytes(row.transferSize ?? row.transferBytes));
  if (row.decodedBodySize != null || row.decodedBytes != null) parts.push(`${formatBytes(row.decodedBodySize ?? row.decodedBytes)} decoded`);
  if (row.status != null) parts.push(String(row.status));
  return `${label} (${parts.join(', ')})`;
}

function readJsonIfPresent(file) {
  return readFile(file, 'utf8')
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
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

async function readRun(input) {
  const candidate = resolve(input);
  const info = await stat(candidate);
  const dir = info.isDirectory() ? candidate : null;
  const summary = dir ? await readJsonIfPresent(join(dir, 'summary.json')) : null;
  const browserStats = dir ? await readJsonIfPresent(join(dir, 'browser-stats.json')) : null;
  const snapshot = await readSnapshot(input);
  return {
    input,
    dir,
    file: snapshot.file,
    snapshot: snapshot.snapshot,
    summary,
    browserStats,
  };
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

function aggregateResources(stats) {
  const resources = Array.isArray(stats?.resources) ? stats.resources : [];
  const summary = {
    count: resources.length,
    transferBytes: 0,
    decodedBytes: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  };
  const byType = new Map();

  for (const resource of resources) {
    const transfer = Number(resource.transferSize) || 0;
    const decoded = Number(resource.decodedBodySize) || 0;
    const duration = Number(resource.duration) || 0;
    const type = String(resource.type || 'unknown');

    summary.transferBytes += transfer;
    summary.decodedBytes += decoded;
    summary.totalDurationMs += duration;
    summary.maxDurationMs = Math.max(summary.maxDurationMs, duration);

    const row = byType.get(type) || {
      key: type,
      count: 0,
      transferBytes: 0,
      decodedBytes: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
    row.count += 1;
    row.transferBytes += transfer;
    row.decodedBytes += decoded;
    row.totalDurationMs += duration;
    row.maxDurationMs = Math.max(row.maxDurationMs, duration);
    byType.set(type, row);
  }

  return {
    summary,
    byType: [...byType.values()].sort((a, b) => b.totalDurationMs - a.totalDurationMs),
    slow: [...resources].sort((a, b) => (b.duration || 0) - (a.duration || 0)).slice(0, 10),
  };
}

function aggregateFetches(stats) {
  const fetches = Array.isArray(stats?.fetches) ? stats.fetches : [];
  return {
    count: fetches.length,
    totalDurationMs: fetches.reduce((sum, row) => sum + (Number(row.duration) || 0), 0),
    maxDurationMs: fetches.reduce((max, row) => Math.max(max, Number(row.duration) || 0), 0),
    slow: [...fetches].sort((a, b) => (b.duration || 0) - (a.duration || 0)).slice(0, 10),
  };
}

function aggregateCallbacks(stats) {
  const callbacks = Array.isArray(stats?.callbacks) ? stats.callbacks : [];
  const byKey = new Map();
  for (const cb of callbacks) {
    const key = `${cb.kind || 'callback'} ${cb.name || '<anonymous>'}`;
    const row = byKey.get(key) || { key, count: 0, totalMs: 0, maxMs: 0 };
    const duration = Number(cb.duration) || 0;
    row.count += 1;
    row.totalMs += duration;
    row.maxMs = Math.max(row.maxMs, duration);
    byKey.set(key, row);
  }
  return [...byKey.values()].sort((a, b) => b.totalMs - a.totalMs);
}

function aggregateLongTasks(stats) {
  const longTasks = Array.isArray(stats?.longTasks) ? stats.longTasks : [];
  return {
    count: longTasks.length,
    totalDurationMs: longTasks.reduce((sum, row) => sum + (Number(row.duration) || 0), 0),
    maxDurationMs: longTasks.reduce((max, row) => Math.max(max, Number(row.duration) || 0), 0),
    slow: [...longTasks].sort((a, b) => (b.duration || 0) - (a.duration || 0)).slice(0, 10),
  };
}

function printResourceMetric(label, a, b, key, formatter = formatCount) {
  const av = a?.[key];
  const bv = b?.[key];
  const delta = key.toLowerCase().includes('bytes') ? formatByteDelta(av, bv) : formatDelta(av, bv);
  console.log(`${label.padEnd(24)} ${formatter(av).padStart(12)} -> ${formatter(bv).padStart(12)}${delta ? `  (${delta})` : ''}`);
}

function printRows(label, aRows, bRows, formatter, limit = 8) {
  const leftRows = Array.isArray(aRows) ? aRows : [];
  const rightRows = Array.isArray(bRows) ? bRows : [];
  if (leftRows.length === 0 && rightRows.length === 0) return;
  console.log(`\n${label}`);
  for (let i = 0; i < Math.min(Math.max(leftRows.length, rightRows.length), limit); i += 1) {
    const left = formatter(leftRows[i]).padEnd(70);
    const right = formatter(rightRows[i]);
    console.log(`  ${left} -> ${right}`);
  }
}

function printResourceComparison(aRun, bRun) {
  if (!aRun.browserStats && !bRun.browserStats) return;

  const aResources = aggregateResources(aRun.browserStats);
  const bResources = aggregateResources(bRun.browserStats);
  const aFetches = aggregateFetches(aRun.browserStats);
  const bFetches = aggregateFetches(bRun.browserStats);
  const aLongTasks = aggregateLongTasks(aRun.browserStats);
  const bLongTasks = aggregateLongTasks(bRun.browserStats);
  const aCallbacks = aggregateCallbacks(aRun.browserStats);
  const bCallbacks = aggregateCallbacks(bRun.browserStats);

  console.log('\nBrowser/resource timing');
  printResourceMetric('Resource requests', aResources.summary, bResources.summary, 'count');
  printResourceMetric('Resource transfer', aResources.summary, bResources.summary, 'transferBytes', formatBytes);
  printResourceMetric('Resource decoded', aResources.summary, bResources.summary, 'decodedBytes', formatBytes);
  printResourceMetric('Resource total ms', aResources.summary, bResources.summary, 'totalDurationMs', formatRate);
  printResourceMetric('Resource max ms', aResources.summary, bResources.summary, 'maxDurationMs', formatRate);
  printResourceMetric('Fetch requests', aFetches, bFetches, 'count');
  printResourceMetric('Fetch total ms', aFetches, bFetches, 'totalDurationMs', formatRate);
  printResourceMetric('Fetch max ms', aFetches, bFetches, 'maxDurationMs', formatRate);
  printResourceMetric('Long tasks', aLongTasks, bLongTasks, 'count');
  printResourceMetric('Long task total ms', aLongTasks, bLongTasks, 'totalDurationMs', formatRate);
  printResourceMetric('Long task max ms', aLongTasks, bLongTasks, 'maxDurationMs', formatRate);

  printRows('Resource timing by initiator type', aResources.byType, bResources.byType, formatResourceRow, 8);
  printRows('Slow resources', aResources.slow, bResources.slow, formatResourceRow, 8);
  printRows('Slow fetches', aFetches.slow, bFetches.slow, formatResourceRow, 8);
  printRows('Slow callback totals', aCallbacks, bCallbacks, (row) => {
    if (!row) return 'n/a';
    return `${row.key} (${formatCount(row.count)}x, ${formatRate(row.totalMs)}ms total, ${formatRate(row.maxMs)}ms max)`;
  }, 8);
}

function printCpuComparison(aRun, bRun) {
  const aRows = aRun.summary?.topFunctionSelfTime;
  const bRows = bRun.summary?.topFunctionSelfTime;
  printRows('Top CPU self-time', aRows, bRows, (row) => {
    if (!row) return 'n/a';
    const location = row.url ? `${basename(row.url)}:${row.line}:${row.column}` : '<anonymous>';
    return `${formatRate(row.selfMs)}ms ${row.functionName || '(anonymous)'} @ ${location}`;
  }, 10);
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

  const a = await readRun(aArg);
  const b = await readRun(bArg);
  const aSnapshot = a.snapshot;
  const bSnapshot = b.snapshot;

  console.log(`A: ${a.file}`);
  console.log(`B: ${b.file}`);
  if (a.summary?.url || b.summary?.url) {
    console.log(`URL A: ${a.summary?.url || 'n/a'}`);
    console.log(`URL B: ${b.summary?.url || 'n/a'}`);
  }
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
  printResourceComparison(a, b);
  printCpuComparison(a, b);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
