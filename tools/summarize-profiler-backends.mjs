#!/usr/bin/env bun
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  areComparableDiagnosticScenes,
  classifyPerformanceDiagnostic,
  diagnosticMapLabel,
  diagnosticSceneComparisonText,
  finiteDiagnosticNumber,
  framePacingFromDiagnosticPayload,
  rendererFromWebGlDiagnostics,
} from '../shared/performanceDiagnostics.ts';

const profilerRoot = resolve('tools', 'profiler-runs');

function formatRate(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? (value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(1))
    : 'n/a';
}

function clip(value, max = 58) {
  const text = String(value ?? 'n/a');
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function pad(value, width) {
  const text = String(value ?? '');
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function finiteNumber(value) {
  return finiteDiagnosticNumber(value);
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function extractSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.ok === true && raw.snapshot) return raw.snapshot;
  if (raw.evilQuestSnapshot?.snapshot) return raw.evilQuestSnapshot.snapshot;
  if (raw.evilQuestSnapshot && raw.evilQuestSnapshot.measuredFps != null) return raw.evilQuestSnapshot;
  if (raw.measuredFps != null || raw.sceneBudget) return raw;
  return null;
}

function rendererFromWebGl(webgl) {
  return rendererFromWebGlDiagnostics(webgl);
}

function commandLineArgs(browserDiagnostics) {
  const args = browserDiagnostics?.commandLine?.arguments;
  const raw = browserDiagnostics?.systemInfo?.commandLine;
  if (Array.isArray(args)) return args.map(String);
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  return [];
}

function flagValue(args, name) {
  const prefix = `${name}=`;
  const direct = args.find((arg) => arg === name);
  if (direct) return 'on';
  const valued = args.find((arg) => arg.startsWith(prefix));
  return valued ? valued.slice(prefix.length) : '';
}

function angleLabel(browserDiagnostics) {
  const args = commandLineArgs(browserDiagnostics);
  return flagValue(args, '--use-angle')
    || flagValue(args, '--use-gl')
    || browserDiagnostics?.systemInfo?.gpu?.auxAttributes?.glImplementationParts
    || browserDiagnostics?.systemInfo?.gpu?.auxAttributes?.displayType
    || 'default';
}

function relevantFlags(browserDiagnostics) {
  return commandLineArgs(browserDiagnostics)
    .filter((arg) => /^--(use-angle|use-gl|disable-gpu|ignore-gpu-blocklist|enable-gpu-rasterization|disable-gpu-rasterization|enable-zero-copy|disable-features|enable-features)/i.test(arg))
    .slice(0, 8);
}

function browserProduct(browserDiagnostics, pageDiagnostics) {
  if (browserDiagnostics?.browserVersion?.product) return browserDiagnostics.browserVersion.product;
  if (browserDiagnostics?.devtoolsVersion?.Browser) return browserDiagnostics.devtoolsVersion.Browser;
  const ua = String(pageDiagnostics?.browser?.userAgent ?? '');
  const match = ua.match(/(Brave|Chrome|Chromium|Edg|HeadlessChrome)\/([0-9.]+)/);
  return match ? `${match[1]}/${match[2]}` : 'unknown';
}

function gpuLabel(browserDiagnostics) {
  const device = Array.isArray(browserDiagnostics?.systemInfo?.gpu?.devices)
    ? browserDiagnostics.systemInfo.gpu.devices[0]
    : null;
  if (!device) return 'n/a';
  return [device.vendorString || device.vendorId, device.deviceString || device.deviceId].filter(Boolean).join(' ') || 'unknown GPU';
}

function rendererLabel(snapshot, browserDiagnostics) {
  const renderer = rendererFromWebGl(snapshot?.webgl);
  return renderer === 'unknown' ? gpuLabel(browserDiagnostics) : renderer;
}

function framePacing(snapshot) {
  return framePacingFromDiagnosticPayload(snapshot);
}

function formatFrame(pacing) {
  if (!pacing) return 'n/a';
  return `med ${formatRate(pacing.medianMs)} p95 ${formatRate(pacing.p95Ms)} >33 ${formatRate(pacing.over33Ms)} >50 ${formatRate(pacing.over50Ms)}`;
}

function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value).toLocaleString()
    : 'n/a';
}

function mapLabel(snapshot) {
  return diagnosticMapLabel(snapshot);
}

function comparableScene(a, b) {
  return areComparableDiagnosticScenes(a, b);
}

function sceneComparisonText(a, b) {
  return diagnosticSceneComparisonText(a, b);
}

function sceneLabel(snapshot) {
  return [
    mapLabel(snapshot),
    `${formatCount(finiteNumber(snapshot?.activeMeshes))}m`,
    `${formatCount(finiteNumber(snapshot?.totalVertices))}v`,
  ].join(' ');
}

function classification(snapshot, browserDiagnostics) {
  switch (classifyPerformanceDiagnostic(snapshot, browserDiagnostics)) {
    case 'software-low': return 'software low';
    case 'stable-30': return 'stable 30';
    case 'stalls': return 'stalls';
    case 'hardware-low':
    case 'low-fps': return 'low FPS';
    case 'healthy-high':
    case 'healthy': return 'healthy';
    default: return 'unclear';
  }
}

async function latestRunDirs(limit = 8) {
  const names = await readdir(profilerRoot);
  const dirs = [];
  for (const name of names) {
    const dir = join(profilerRoot, name);
    try {
      if ((await stat(dir)).isDirectory()) dirs.push(dir);
    } catch {
      // Ignore disappearing files.
    }
  }
  return dirs.sort().slice(-limit);
}

async function readRun(dir) {
  const snapshot = extractSnapshot(await readJsonIfPresent(join(dir, 'evilquest-snapshot.json')))
    ?? extractSnapshot(await readJsonIfPresent(join(dir, 'summary.json')));
  const browserDiagnostics = await readJsonIfPresent(join(dir, 'browser-diagnostics.json'))
    ?? (await readJsonIfPresent(join(dir, 'summary.json')))?.browserDiagnostics
    ?? null;
  const pageDiagnostics = await readJsonIfPresent(join(dir, 'page-diagnostics.json'))
    ?? (await readJsonIfPresent(join(dir, 'summary.json')))?.pageDiagnostics
    ?? null;
  return { dir, snapshot, browserDiagnostics, pageDiagnostics };
}

function printRows(runs) {
  const headers = [
    ['run', 29],
    ['browser', 20],
    ['angle/backend', 24],
    ['fps', 7],
    ['frame', 31],
    ['class', 12],
    ['scene', 22],
    ['webgl/gpu status', 20],
    ['renderer', 58],
  ];
  console.log(headers.map(([label, width]) => pad(label, width)).join('  '));
  console.log(headers.map(([, width]) => '-'.repeat(width)).join('  '));
  for (const run of runs) {
    const snapshot = run.snapshot || {};
    const browserDiagnostics = run.browserDiagnostics || {};
    const featureStatus = browserDiagnostics.systemInfo?.gpu?.featureStatus || {};
    const status = [
      featureStatus.webgl ? `webgl:${featureStatus.webgl}` : null,
      featureStatus.gpu_compositing ? `gpu:${featureStatus.gpu_compositing}` : null,
    ].filter(Boolean).join(' ');
    const row = [
      [basename(run.dir), 29],
      [clip(browserProduct(browserDiagnostics, run.pageDiagnostics), 20), 20],
      [clip(angleLabel(browserDiagnostics), 24), 24],
      [formatRate(snapshot.measuredFps), 7],
      [clip(formatFrame(framePacing(snapshot)), 31), 31],
      [classification(snapshot, browserDiagnostics), 12],
      [clip(sceneLabel(snapshot), 22), 22],
      [clip(status || 'n/a', 20), 20],
      [clip(rendererLabel(snapshot, browserDiagnostics)), 58],
    ];
    console.log(row.map(([value, width]) => pad(value, width)).join('  '));
  }
}

function printDetails(runs) {
  console.log('\nRelevant launch flags');
  for (const run of runs) {
    const flags = relevantFlags(run.browserDiagnostics || {});
    console.log(`- ${basename(run.dir)}: ${flags.length > 0 ? flags.join(' ') : 'none'}`);
  }
}

function measuredRows(runs) {
  return runs
    .map((run) => {
      const browserDiagnostics = run.browserDiagnostics || {};
      const fps = finiteNumber(run.snapshot?.measuredFps);
      return {
        run,
        fps,
        angle: angleLabel(browserDiagnostics),
        className: classification(run.snapshot || {}, browserDiagnostics),
      };
    })
    .filter((row) => row.fps != null);
}

function printVerdict(runs) {
  const measured = measuredRows(runs).sort((a, b) => b.fps - a.fps);
  console.log('\nBackend verdict');
  if (measured.length === 0) {
    console.log('- No in-game FPS snapshots were found. Re-run after login and type capture once the game is visible.');
    return;
  }

  const best = measured[0];
  const worst = measured[measured.length - 1];
  console.log(`- Best: ${basename(best.run.dir)} (${best.angle}) ${formatRate(best.fps)} FPS, ${best.className}`);
  if (measured.length === 1) return;

  console.log(`- Worst: ${basename(worst.run.dir)} (${worst.angle}) ${formatRate(worst.fps)} FPS, ${worst.className}`);
  const ratio = best.fps / Math.max(1, worst.fps);
  const sceneComparable = comparableScene(best.run.snapshot, worst.run.snapshot);
  console.log(`- Scene comparison: comparable=${sceneComparable ? 'yes' : 'no'}, ${sceneComparisonText(best.run.snapshot, worst.run.snapshot)}`);
  if (sceneComparable && best.fps >= 55 && worst.fps < 55 && ratio >= 1.5) {
    console.log('- Strong backend signal: one browser GPU path is playable while another is low FPS in a comparable scene.');
  } else if (measured.every((row) => row.className === 'healthy')) {
    console.log('- No low-FPS backend failure reproduced in these captures.');
  } else if (measured.every((row) => row.fps < 55)) {
    console.log('- All captured backends are low FPS; check software rendering, battery/efficiency settings, or scene-specific CPU stalls next.');
  } else if (!sceneComparable) {
    console.log('- FPS differs, but the best and worst captures are not comparable scenes. Re-capture from the same logged-in location.');
  } else {
    console.log('- Mixed result; compare the best and worst run with compare-profiler-runs.mjs for the next clue.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dirs = args.length > 0 ? args.map((arg) => resolve(arg)) : await latestRunDirs(8);
  const runs = [];
  for (const dir of dirs) {
    const run = await readRun(dir);
    if (!run.snapshot && !run.browserDiagnostics) continue;
    runs.push(run);
  }
  if (runs.length === 0) throw new Error('No profiler run directories found');
  printRows(runs);
  printDetails(runs);
  printVerdict(runs);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
