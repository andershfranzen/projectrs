#!/usr/bin/env bun
import { basename } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const profilerRoot = resolve('tools', 'profiler-runs');
const SOFTWARE_RENDERER_PATTERNS = [
  'swiftshader',
  'llvmpipe',
  'software rasterizer',
  'software renderer',
  'microsoft basic render',
];

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
  const canvas = snapshot?.canvas;
  if (!canvas) return 'n/a';
  return `${formatCount(canvas.width)}x${formatCount(canvas.height)} / ${formatCount(canvas.clientWidth)}x${formatCount(canvas.clientHeight)}, DPR ${formatRate(canvas.devicePixelRatio)}`;
}

function formatViewport(pageDiagnostics) {
  const viewport = pageDiagnostics?.viewport;
  if (!viewport) return 'n/a';
  const dpr = pageDiagnostics?.browser?.devicePixelRatio;
  return `${formatCount(viewport.innerWidth)}x${formatCount(viewport.innerHeight)} inner / ${formatCount(viewport.outerWidth)}x${formatCount(viewport.outerHeight)} outer, DPR ${formatRate(dpr)}`;
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

function extractCompletedSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.ok === true && raw.snapshot) return raw.snapshot;
  if (raw.evilQuestSnapshot?.snapshot) return raw.evilQuestSnapshot.snapshot;
  if (raw.evilQuestSnapshot && raw.evilQuestSnapshot.measuredFps != null) return raw.evilQuestSnapshot;
  if (raw.measuredFps != null || raw.sceneBudget) return raw;
  return null;
}

function extractPageDiagnostics(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.pageDiagnostics && typeof raw.pageDiagnostics === 'object') return raw.pageDiagnostics;
  if (raw.webgl && raw.browser) return raw;
  return null;
}

function extractBrowserDiagnostics(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.browserDiagnostics && typeof raw.browserDiagnostics === 'object') return raw.browserDiagnostics;
  if (raw.systemInfo || raw.browserVersion || raw.devtoolsVersion) return raw;
  return null;
}

function rendererFromWebGl(webgl) {
  return webgl?.unmaskedRenderer || webgl?.renderer || 'unknown';
}

function isSoftwareRenderer(webgl) {
  if (!webgl || typeof webgl !== 'object') return null;
  const rendererText = [
    webgl?.unmaskedRenderer,
    webgl?.renderer,
    webgl?.unmaskedVendor,
    webgl?.vendor,
  ].filter(Boolean).join(' ').toLowerCase();
  return SOFTWARE_RENDERER_PATTERNS.some((pattern) => rendererText.includes(pattern));
}

function rendererFromRun(run) {
  return rendererFromWebGl(run.snapshot?.webgl ?? run.pageDiagnostics?.webgl);
}

function flagsFromRun(run) {
  if (Array.isArray(run.snapshot?.diagnosticFlags)) return run.snapshot.diagnosticFlags;

  const flags = [];
  const page = run.pageDiagnostics;
  const webgl = page?.webgl;
  if (page) {
    const context = String(webgl?.context ?? '');
    if (page.browser?.brave === true) flags.push('brave-browser');
    if (!context || context === 'unavailable') flags.push('webgl-unavailable');
    if (context === 'webgl') flags.push('webgl1-context');
    if (!webgl?.unmaskedRenderer) flags.push('renderer-info-masked');
    if (isSoftwareRenderer(webgl)) flags.push('software-renderer-likely');
    if (page.storage?.hasAuthToken === false) flags.push('no-auth-token');
    if (page.game?.hasGameManager === false) flags.push('game-manager-missing');
    if (page.game?.hasSnapshotApi === false) flags.push('snapshot-api-missing');
  }
  if (run.summary?.gameReady?.ok === false) flags.push('game-not-ready');
  const bodyText = String(page?.bodyText ?? run.summary?.gameReady?.bodyText ?? '');
  if (bodyText.includes('Login') && bodyText.includes('Password')) flags.push('login-screen');
  return flags;
}

function formatRunViewport(run) {
  return run.snapshot?.canvas ? formatCanvas(run.snapshot) : formatViewport(run.pageDiagnostics);
}

function browserLabel(pageDiagnostics) {
  if (!pageDiagnostics) return 'n/a';
  if (pageDiagnostics.browser?.brave === true) return 'Brave';
  const brands = pageDiagnostics.browser?.userAgentData?.brands;
  if (Array.isArray(brands) && brands.length > 0) {
    return brands.map((brand) => `${brand.brand} ${brand.version}`).join(', ');
  }
  const ua = String(pageDiagnostics.browser?.userAgent ?? '');
  const match = ua.match(/(Chrome|Chromium|Edg|Firefox|Safari)\/([0-9.]+)/);
  return match ? `${match[1]} ${match[2]}` : 'Chromium';
}

function browserProcessLabel(browserDiagnostics) {
  if (!browserDiagnostics) return 'n/a';
  return browserDiagnostics.browserVersion?.product
    || browserDiagnostics.devtoolsVersion?.Browser
    || 'unknown browser';
}

function gpuDevicesFromBrowserDiagnostics(browserDiagnostics) {
  return Array.isArray(browserDiagnostics?.systemInfo?.gpu?.devices)
    ? browserDiagnostics.systemInfo.gpu.devices
    : [];
}

function gpuFeatureStatusFromBrowserDiagnostics(browserDiagnostics) {
  const status = browserDiagnostics?.systemInfo?.gpu?.featureStatus;
  return status && typeof status === 'object' ? status : {};
}

function primaryGpuLabel(browserDiagnostics) {
  const device = gpuDevicesFromBrowserDiagnostics(browserDiagnostics)[0];
  if (!device) return 'n/a';
  const name = [
    device.vendorString || device.vendorId,
    device.deviceString || device.deviceId,
  ].filter(Boolean).join(' ') || 'unknown GPU';
  const driver = [
    device.driverVendor,
    device.driverVersion,
  ].filter(Boolean).join(' ');
  return driver ? `${name} (${driver})` : name;
}

function commandLineFlags(browserDiagnostics) {
  const args = browserDiagnostics?.commandLine?.arguments;
  const rawCommandLine = browserDiagnostics?.systemInfo?.commandLine;
  const allArgs = Array.isArray(args)
    ? args
    : typeof rawCommandLine === 'string'
      ? rawCommandLine.split(/\s+/)
      : null;
  if (!allArgs) return 'n/a';
  const relevant = allArgs.filter((arg) => /^--(disable|enable|use|ignore|in-process|no-|ozone|angle|gpu|swiftshader|render|use-angle)/i.test(String(arg)));
  return relevant.length > 0 ? relevant.slice(0, 12).join(' ') : 'none';
}

function fileListLabel(items, limit = 8) {
  if (!Array.isArray(items) || items.length === 0) return 'none';
  const visible = items.slice(0, limit).join(', ');
  return items.length > limit ? `${visible}, +${items.length - limit} more` : visible;
}

function formatBuildResourceRow(row) {
  if (!row || typeof row !== 'object') return 'n/a';
  const label = row.file || row.name || 'resource';
  const parts = [
    row.type || 'resource',
    `${formatRate(row.duration)}ms`,
    formatBytes(row.transferSize),
    `${formatBytes(row.decodedBodySize)} decoded`,
  ];
  return `${label} (${parts.join(', ')})`;
}

function uniqueStrings(items) {
  return [...new Set((Array.isArray(items) ? items : [])
    .filter((item) => typeof item === 'string' && item.length > 0))];
}

function buildScriptFingerprint(run) {
  const build = run.pageDiagnostics?.build;
  return uniqueStrings([
    ...(build?.scriptFiles ?? []),
    ...(build?.documentScripts ?? []),
  ]);
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item));
}

function listForHint(items, limit = 4) {
  if (!Array.isArray(items) || items.length === 0) return 'none';
  const visible = items.slice(0, limit).join(', ');
  return items.length > limit ? `${visible}, +${items.length - limit} more` : visible;
}

function hasCompletedSnapshot(run) {
  return !!run.snapshot && typeof run.snapshot === 'object' && run.snapshot.measuredFps != null;
}

function measuredFps(run) {
  const fps = run.snapshot?.measuredFps;
  return typeof fps === 'number' && Number.isFinite(fps) ? fps : null;
}

function activeMeshCount(run) {
  const meshes = run.snapshot?.activeMeshes;
  return typeof meshes === 'number' && Number.isFinite(meshes) ? meshes : null;
}

function rendererLikelySoftware(run) {
  const flags = flagsFromRun(run);
  return flags.includes('software-renderer-likely') || isSoftwareRenderer(run.pageDiagnostics?.webgl) === true;
}

function rendererLabelForHint(run) {
  const renderer = rendererFromRun(run);
  return renderer === 'unknown' ? 'unknown renderer' : renderer;
}

function pageLooksLikeLogin(run) {
  return flagsFromRun(run).includes('login-screen');
}

function snapshotSource(run) {
  if (!run.snapshot) return 'none';
  if (typeof run.snapshot.snapshotSource === 'string' && run.snapshot.snapshotSource.length > 0) {
    return run.snapshot.snapshotSource;
  }
  return 'client-api';
}

function printComparisonHints(aRun, bRun) {
  const hints = [];
  const aScripts = buildScriptFingerprint(aRun);
  const bScripts = buildScriptFingerprint(bRun);
  const onlyA = difference(aScripts, bScripts);
  const onlyB = difference(bScripts, aScripts);
  if ((aScripts.length > 0 || bScripts.length > 0) && (onlyA.length > 0 || onlyB.length > 0)) {
    hints.push(`Client build mismatch: A-only [${listForHint(onlyA)}], B-only [${listForHint(onlyB)}]. Treat live/local FPS deltas as mixed with bundle changes.`);
  }

  const aHasSnapshot = hasCompletedSnapshot(aRun);
  const bHasSnapshot = hasCompletedSnapshot(bRun);
  if (!aHasSnapshot || !bHasSnapshot) {
    const missing = [
      !aHasSnapshot ? 'A' : null,
      !bHasSnapshot ? 'B' : null,
    ].filter(Boolean);
    hints.push(`Incomplete in-game evidence: ${missing.join(' and ')} ${missing.length === 1 ? 'lacks' : 'lack'} a completed EvilQuest FPS snapshot.`);
  }

  if (pageLooksLikeLogin(aRun) || pageLooksLikeLogin(bRun)) {
    hints.push('At least one run captured the login screen; use it for page/build/GPU diagnostics only, not steady-state gameplay FPS.');
  }

  const fallbackRuns = [
    snapshotSource(aRun) === 'profiler-fallback' ? 'A' : null,
    snapshotSource(bRun) === 'profiler-fallback' ? 'B' : null,
  ].filter(Boolean);
  if (fallbackRuns.length > 0) {
    hints.push(`${fallbackRuns.join(' and ')} used the profiler fallback snapshot path. FPS, renderer, canvas, and scene counts are comparable; client-only fields may be less complete.`);
  }

  const aSoftware = rendererLikelySoftware(aRun);
  const bSoftware = rendererLikelySoftware(bRun);
  if (aSoftware !== bSoftware) {
    hints.push(`Renderer backend mismatch: A is ${aSoftware ? 'software/SwiftShader-like' : 'hardware-like'}, B is ${bSoftware ? 'software/SwiftShader-like' : 'hardware-like'}. Renderer backend is a primary suspect for large FPS gaps.`);
  }

  const aFps = measuredFps(aRun);
  const bFps = measuredFps(bRun);
  if (aFps != null && bFps != null) {
    const lower = Math.min(aFps, bFps);
    const higher = Math.max(aFps, bFps);
    const ratio = lower > 0 ? higher / lower : Infinity;
    const aMeshes = activeMeshCount(aRun);
    const bMeshes = activeMeshCount(bRun);
    const meshDeltaRatio = aMeshes != null && bMeshes != null && Math.max(aMeshes, bMeshes) > 0
      ? Math.abs(aMeshes - bMeshes) / Math.max(aMeshes, bMeshes)
      : null;
    if (ratio >= 2 && meshDeltaRatio != null && meshDeltaRatio <= 0.2) {
      hints.push(`FPS differs by ${ratio.toFixed(1)}x while active mesh counts are similar (${formatCount(aMeshes)} -> ${formatCount(bMeshes)}); browser/GPU/backend differences are more likely than scene size alone.`);
    } else if (ratio >= 2) {
      hints.push(`FPS differs by ${ratio.toFixed(1)}x; compare renderer, canvas scale, active meshes, and bundle fingerprint before attributing it to the server.`);
    }
  }

  const aRenderer = rendererLabelForHint(aRun);
  const bRenderer = rendererLabelForHint(bRun);
  if (aRenderer !== bRenderer && aRenderer !== 'unknown renderer' && bRenderer !== 'unknown renderer') {
    hints.push(`Renderer strings differ: A [${aRenderer}], B [${bRenderer}].`);
  }

  if (hints.length === 0) return;
  console.log('Comparison hints');
  for (const hint of hints) console.log(`  - ${hint}`);
  console.log('');
}

function formatBool(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return 'n/a';
}

function printDiagnosticMetric(label, a, b, formatter = formatValue) {
  console.log(`${label.padEnd(24)} ${formatter(a).padStart(24)} -> ${formatter(b)}`);
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

async function readRun(input) {
  const candidate = resolve(input);
  const info = await stat(candidate);
  const dir = info.isDirectory() ? candidate : null;
  const raw = dir ? null : await readJsonIfPresent(candidate);
  const summary = dir ? await readJsonIfPresent(join(dir, 'summary.json')) : raw;
  const browserStats = dir ? await readJsonIfPresent(join(dir, 'browser-stats.json')) : null;
  const pageDiagnostics = extractPageDiagnostics(summary)
    ?? (dir ? await readJsonIfPresent(join(dir, 'page-diagnostics.json')) : extractPageDiagnostics(raw));
  const browserDiagnostics = extractBrowserDiagnostics(summary)
    ?? (dir ? await readJsonIfPresent(join(dir, 'browser-diagnostics.json')) : extractBrowserDiagnostics(raw));
  const snapshotFile = dir ? join(dir, 'evilquest-snapshot.json') : candidate;
  const snapshotRaw = dir ? await readJsonIfPresent(snapshotFile) : raw;
  const snapshot = extractCompletedSnapshot(snapshotRaw) ?? extractCompletedSnapshot(summary);
  const file = snapshot
    ? snapshotFile
    : pageDiagnostics
      ? (dir ? join(dir, 'page-diagnostics.json') : candidate)
      : candidate;
  if (!snapshot && !pageDiagnostics && !summary && !browserStats) {
    throw new Error(`${input} does not contain a completed EvilQuest snapshot, page diagnostics, summary, or browser stats`);
  }
  return {
    input,
    dir,
    file,
    snapshot,
    pageDiagnostics,
    browserDiagnostics,
    summary,
    browserStats,
  };
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

function printPageDiagnosticComparison(aRun, bRun) {
  if (!aRun.pageDiagnostics && !bRun.pageDiagnostics) return;

  const aPage = aRun.pageDiagnostics;
  const bPage = bRun.pageDiagnostics;
  console.log('\nPage diagnostics');
  printDiagnosticMetric('Browser', browserLabel(aPage), browserLabel(bPage));
  printDiagnosticMetric('Platform', aPage?.browser?.platform, bPage?.browser?.platform);
  printDiagnosticMetric('Renderer', rendererFromWebGl(aPage?.webgl), rendererFromWebGl(bPage?.webgl));
  printDiagnosticMetric('WebGL context', aPage?.webgl?.context, bPage?.webgl?.context);
  printDiagnosticMetric('Software renderer', isSoftwareRenderer(aPage?.webgl), isSoftwareRenderer(bPage?.webgl), formatBool);
  printDiagnosticMetric('Viewport', formatViewport(aPage), formatViewport(bPage));
  printDiagnosticMetric('Auth token present', aPage?.storage?.hasAuthToken, bPage?.storage?.hasAuthToken, formatBool);
  printDiagnosticMetric('Username stored', aPage?.storage?.hasStoredUsername, bPage?.storage?.hasStoredUsername, formatBool);
  printDiagnosticMetric('Device ID stored', aPage?.storage?.hasDeviceId, bPage?.storage?.hasDeviceId, formatBool);
  printDiagnosticMetric('Game manager', aPage?.game?.hasGameManager, bPage?.game?.hasGameManager, formatBool);
  printDiagnosticMetric('Snapshot API', aPage?.game?.hasSnapshotApi, bPage?.game?.hasSnapshotApi, formatBool);
  printDiagnosticMetric('Fallback inputs', aPage?.game?.hasFallbackSnapshotInputs, bPage?.game?.hasFallbackSnapshotInputs, formatBool);
  printDiagnosticMetric('Login settled', aPage?.game?.loginSettled, bPage?.game?.loginSettled);
  printDiagnosticMetric('URL', formatShortUrl(aPage?.url), formatShortUrl(bPage?.url));
}

function printBrowserDiagnosticComparison(aRun, bRun) {
  if (!aRun.browserDiagnostics && !bRun.browserDiagnostics) return;

  const aBrowser = aRun.browserDiagnostics;
  const bBrowser = bRun.browserDiagnostics;
  const featureKeys = [
    'gpu_compositing',
    'webgl',
    'webgl2',
    'rasterization',
    'multiple_raster_threads',
    'canvas_oop_rasterization',
    'video_decode',
    'video_encode',
    'vulkan',
    'metal',
  ];

  console.log('\nBrowser process diagnostics');
  printDiagnosticMetric('Browser product', browserProcessLabel(aBrowser), browserProcessLabel(bBrowser));
  printDiagnosticMetric('Primary GPU', primaryGpuLabel(aBrowser), primaryGpuLabel(bBrowser));
  printDiagnosticMetric('GPU count', gpuDevicesFromBrowserDiagnostics(aBrowser).length, gpuDevicesFromBrowserDiagnostics(bBrowser).length, formatCount);
  for (const key of featureKeys) {
    const aStatus = gpuFeatureStatusFromBrowserDiagnostics(aBrowser)[key];
    const bStatus = gpuFeatureStatusFromBrowserDiagnostics(bBrowser)[key];
    if (aStatus != null || bStatus != null) printDiagnosticMetric(key, aStatus, bStatus);
  }
  const aAux = aBrowser?.systemInfo?.gpu?.auxAttributes || {};
  const bAux = bBrowser?.systemInfo?.gpu?.auxAttributes || {};
  printDiagnosticMetric('GL renderer', aAux.glRenderer, bAux.glRenderer);
  printDiagnosticMetric('GL vendor', aAux.glVendor, bAux.glVendor);
  printDiagnosticMetric('ANGLE backend', aAux.angleBackend, bAux.angleBackend);
  printDiagnosticMetric('Relevant flags', commandLineFlags(aBrowser), commandLineFlags(bBrowser));
}

function printBuildDiagnosticComparison(aRun, bRun) {
  const aBuild = aRun.pageDiagnostics?.build;
  const bBuild = bRun.pageDiagnostics?.build;
  if (!aBuild && !bBuild) return;

  console.log('\nClient build/resource fingerprint');
  printDiagnosticMetric('Document scripts', fileListLabel(aBuild?.documentScripts), fileListLabel(bBuild?.documentScripts));
  printDiagnosticMetric('Loaded script files', fileListLabel(aBuild?.scriptFiles), fileListLabel(bBuild?.scriptFiles));
  printDiagnosticMetric('Stylesheets', fileListLabel(aBuild?.cssFiles), fileListLabel(bBuild?.cssFiles));
  printDiagnosticMetric('Resource count', aBuild?.resourceCounts?.total, bBuild?.resourceCounts?.total, formatCount);
  printDiagnosticMetric('Asset count', aBuild?.resourceCounts?.assets, bBuild?.resourceCounts?.assets, formatCount);
  printDiagnosticMetric('Script count', aBuild?.resourceCounts?.scripts, bBuild?.resourceCounts?.scripts, formatCount);
  printDiagnosticMetric('Total transfer', aBuild?.resourceBytes?.transfer, bBuild?.resourceBytes?.transfer, formatBytes);
  printDiagnosticMetric('Total decoded', aBuild?.resourceBytes?.decoded, bBuild?.resourceBytes?.decoded, formatBytes);
  printDiagnosticMetric('Script transfer', aBuild?.resourceBytes?.scriptsTransfer, bBuild?.resourceBytes?.scriptsTransfer, formatBytes);
  printDiagnosticMetric('Script decoded', aBuild?.resourceBytes?.scriptsDecoded, bBuild?.resourceBytes?.scriptsDecoded, formatBytes);
  printRows('Top loaded assets', aBuild?.topResources, bBuild?.topResources, formatBuildResourceRow, 8);
  printRows('Top loaded scripts', aBuild?.topScripts, bBuild?.topScripts, formatBuildResourceRow, 8);
}

function printSnapshotComparison(aSnapshot, bSnapshot) {
  if (!aSnapshot && !bSnapshot) {
    console.log('\nEvilQuest snapshot: unavailable for both runs');
    return;
  }
  const left = aSnapshot ?? {};
  const right = bSnapshot ?? {};

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
  for (const [label, path] of metrics) printMetric(label, left, right, path);

  printBudget('Top active meshes', left.sceneBudget?.activeByName, right.sceneBudget?.activeByName);
  printBudget('Top active pickable meshes', left.sceneBudget?.activePickableByName, right.sceneBudget?.activePickableByName);
  printBudget('Top enabled meshes', left.sceneBudget?.enabledByName, right.sceneBudget?.enabledByName, 5);
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
  const aUrl = a.summary?.url || a.pageDiagnostics?.url;
  const bUrl = b.summary?.url || b.pageDiagnostics?.url;
  if (aUrl || bUrl) {
    console.log(`URL A: ${formatShortUrl(aUrl)}`);
    console.log(`URL B: ${formatShortUrl(bUrl)}`);
  }
  console.log('');
  console.log(`Snapshot source A: ${snapshotSource(a)}`);
  console.log(`Snapshot source B: ${snapshotSource(b)}`);
  console.log(`Renderer A: ${rendererFromRun(a)}`);
  console.log(`Renderer B: ${rendererFromRun(b)}`);
  console.log(`Flags A: ${formatValue(flagsFromRun(a))}`);
  console.log(`Flags B: ${formatValue(flagsFromRun(b))}`);
  console.log(`Canvas/View A: ${formatRunViewport(a)}`);
  console.log(`Canvas/View B: ${formatRunViewport(b)}`);
  console.log('');

  printComparisonHints(a, b);
  printPageDiagnosticComparison(a, b);
  printBuildDiagnosticComparison(a, b);
  printBrowserDiagnosticComparison(a, b);
  printSnapshotComparison(aSnapshot, bSnapshot);
  printResourceComparison(a, b);
  printCpuComparison(a, b);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
