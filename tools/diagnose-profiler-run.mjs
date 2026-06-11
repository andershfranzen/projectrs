#!/usr/bin/env bun
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const profilerRoot = resolve('tools', 'profiler-runs');
const SOFTWARE_RENDERER_PATTERNS = [
  'swiftshader',
  'llvmpipe',
  'software rasterizer',
  'software renderer',
  'microsoft basic render',
];
const LOW_FPS_THRESHOLD = 55;
const HIGH_DPR_THRESHOLD = 1.75;
const LARGE_CANVAS_PIXELS = 4_000_000;

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

function formatBool(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return 'n/a';
}

function formatShortUrl(value) {
  if (!value) return 'n/a';
  try {
    const url = new URL(String(value));
    return `${url.host}${url.pathname}${url.search}`.slice(0, 120);
  } catch {
    return String(value).slice(0, 120);
  }
}

function uniqueStrings(items) {
  return [...new Set((Array.isArray(items) ? items : [])
    .filter((item) => typeof item === 'string' && item.length > 0))];
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

function softwareRendererFromText(...values) {
  const text = values.filter(Boolean).join(' ').toLowerCase();
  return SOFTWARE_RENDERER_PATTERNS.some((pattern) => text.includes(pattern));
}

function isSoftwareRenderer(webgl) {
  if (!webgl || typeof webgl !== 'object') return null;
  return softwareRendererFromText(
    webgl.unmaskedRenderer,
    webgl.renderer,
    webgl.unmaskedVendor,
    webgl.vendor,
  );
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
  if (!allArgs) return [];
  return allArgs
    .filter((arg) => /^--(disable|enable|use|ignore|in-process|no-|ozone|angle|gpu|swiftshader|render|use-angle)/i.test(String(arg)))
    .slice(0, 16);
}

function flagsFromRun(run) {
  const explicitFlags = Array.isArray(run.snapshot?.diagnosticFlags)
    ? run.snapshot.diagnosticFlags
    : [];
  const flags = [...explicitFlags];
  const page = run.pageDiagnostics;
  const webgl = run.snapshot?.webgl ?? page?.webgl;
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
  return uniqueStrings(flags);
}

function snapshotSource(run) {
  if (!run.snapshot) return 'none';
  if (typeof run.snapshot.snapshotSource === 'string' && run.snapshot.snapshotSource.length > 0) {
    return run.snapshot.snapshotSource;
  }
  return 'client-api';
}

function measuredFps(run) {
  const fps = run.snapshot?.measuredFps;
  return typeof fps === 'number' && Number.isFinite(fps) ? fps : null;
}

function dprFromRun(run) {
  return run.snapshot?.canvas?.devicePixelRatio ?? run.pageDiagnostics?.browser?.devicePixelRatio ?? null;
}

function canvasPixelCount(run) {
  const canvas = run.snapshot?.canvas;
  if (!canvas) return null;
  const width = Number(canvas.width);
  const height = Number(canvas.height);
  return Number.isFinite(width) && Number.isFinite(height) ? width * height : null;
}

function formatCanvas(run) {
  const canvas = run.snapshot?.canvas;
  if (canvas) {
    return `${formatCount(canvas.width)}x${formatCount(canvas.height)} / ${formatCount(canvas.clientWidth)}x${formatCount(canvas.clientHeight)}, DPR ${formatRate(canvas.devicePixelRatio)}`;
  }
  const viewport = run.pageDiagnostics?.viewport;
  if (!viewport) return 'n/a';
  return `${formatCount(viewport.innerWidth)}x${formatCount(viewport.innerHeight)} inner / ${formatCount(viewport.outerWidth)}x${formatCount(viewport.outerHeight)} outer, DPR ${formatRate(dprFromRun(run))}`;
}

function browserGlRenderer(run) {
  const aux = run.browserDiagnostics?.systemInfo?.gpu?.auxAttributes || {};
  return aux.glRenderer || aux.glVendor
    ? [aux.glVendor, aux.glRenderer].filter(Boolean).join(' / ')
    : 'n/a';
}

function runLikelySoftwareRenderer(run) {
  const flags = flagsFromRun(run);
  const snapshotWebgl = run.snapshot?.webgl;
  const pageWebgl = run.pageDiagnostics?.webgl;
  const aux = run.browserDiagnostics?.systemInfo?.gpu?.auxAttributes || {};
  return flags.includes('software-renderer-likely')
    || isSoftwareRenderer(snapshotWebgl) === true
    || isSoftwareRenderer(pageWebgl) === true
    || softwareRendererFromText(aux.glRenderer, aux.glVendor, aux.angleBackend);
}

function buildScriptFingerprint(run) {
  const build = run.pageDiagnostics?.build;
  return uniqueStrings([
    ...(build?.scriptFiles ?? []),
    ...(build?.documentScripts ?? []),
  ]);
}

function gpuProblemStatuses(run) {
  const status = gpuFeatureStatusFromBrowserDiagnostics(run.browserDiagnostics);
  const keys = ['gpu_compositing', 'webgl', 'webgl2', 'rasterization', 'canvas_oop_rasterization'];
  return keys
    .map((key) => ({ key, value: status[key] }))
    .filter((row) => typeof row.value === 'string' && /disabled|software|unavailable|uninitialized/i.test(row.value));
}

function topCpuRows(run, limit = 5) {
  const rows = Array.isArray(run.summary?.topFunctionSelfTime)
    ? run.summary.topFunctionSelfTime
    : [];
  return rows.slice(0, limit).map((row) => ({
    functionName: row.functionName || '(anonymous)',
    selfMs: row.selfMs,
    location: row.url ? `${basename(row.url)}:${row.line}:${row.column}` : '<anonymous>',
  }));
}

function finding(severity, code, title, evidence = [], nextAction = []) {
  return { severity, code, title, evidence, nextAction };
}

async function latestRunDir() {
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
  return dirs.sort().at(-1) ?? null;
}

async function readRun(input) {
  const candidate = input ? resolve(input) : await latestRunDir();
  if (!candidate) {
    throw new Error('Pass a profiler run directory/file, or create a run under tools/profiler-runs.');
  }
  const info = await stat(candidate);
  const dir = info.isDirectory() ? candidate : null;
  const raw = dir ? null : await readJsonIfPresent(candidate);
  const summary = dir ? await readJsonIfPresent(join(dir, 'summary.json')) : raw;
  const pageDiagnostics = extractPageDiagnostics(summary)
    ?? (dir ? await readJsonIfPresent(join(dir, 'page-diagnostics.json')) : extractPageDiagnostics(raw));
  const browserDiagnostics = extractBrowserDiagnostics(summary)
    ?? (dir ? await readJsonIfPresent(join(dir, 'browser-diagnostics.json')) : extractBrowserDiagnostics(raw));
  const snapshotFile = dir ? join(dir, 'evilquest-snapshot.json') : candidate;
  const snapshotRaw = dir ? await readJsonIfPresent(snapshotFile) : raw;
  const snapshot = extractCompletedSnapshot(snapshotRaw) ?? extractCompletedSnapshot(summary);
  if (!snapshot && !pageDiagnostics && !summary) {
    throw new Error(`${candidate} does not contain a completed EvilQuest snapshot, page diagnostics, or summary`);
  }
  return {
    input: input ?? candidate,
    dir,
    file: snapshot ? snapshotFile : dir ? join(dir, 'page-diagnostics.json') : candidate,
    snapshot,
    pageDiagnostics,
    browserDiagnostics,
    summary,
  };
}

function buildDiagnosis(run) {
  const flags = flagsFromRun(run);
  const fps = measuredFps(run);
  const hasSnapshot = fps != null;
  const softwareRenderer = runLikelySoftwareRenderer(run);
  const loginScreen = flags.includes('login-screen');
  const lowFps = fps != null && fps < LOW_FPS_THRESHOLD;
  const dpr = dprFromRun(run);
  const pixels = canvasPixelCount(run);
  const gpuStatuses = gpuProblemStatuses(run);
  const relevantFlags = commandLineFlags(run.browserDiagnostics);
  const scripts = buildScriptFingerprint(run);
  const findings = [];

  if (!hasSnapshot || loginScreen || flags.includes('game-not-ready')) {
    findings.push(finding(
      'high',
      'incomplete-gameplay-capture',
      'This run does not prove steady-state gameplay FPS.',
      [
        `snapshot=${hasSnapshot ? 'present' : 'missing'}`,
        `loginScreen=${formatBool(loginScreen)}`,
        `gameReady=${formatBool(run.summary?.gameReady?.ok)}`,
      ],
      [
        "Run the Windows Brave helper, log in, wait until the bad FPS is visible, type 'capture', then type 'quit'.",
      ],
    ));
  }

  if (softwareRenderer) {
    findings.push(finding(
      lowFps ? 'critical' : 'high',
      'software-renderer',
      'The browser appears to be using a software or SwiftShader-like WebGL backend.',
      [
        `snapshotRenderer=${rendererFromWebGl(run.snapshot?.webgl)}`,
        `pageRenderer=${rendererFromWebGl(run.pageDiagnostics?.webgl)}`,
        `browserGL=${browserGlRenderer(run)}`,
      ],
      [
        'In Brave, enable graphics acceleration, restart Brave fully, then check brave://gpu.',
        'On Windows, also check that Brave is assigned to the real GPU in Windows graphics settings.',
      ],
    ));
  }

  if (lowFps) {
    findings.push(finding(
      softwareRenderer ? 'critical' : 'high',
      softwareRenderer ? 'low-fps-with-software-renderer' : 'low-fps-with-hardware-renderer',
      softwareRenderer
        ? 'The low FPS matches the software-renderer signal.'
        : 'Low FPS reproduced, but the run does not look like an obvious software renderer case.',
      [
        `measuredFps=${formatRate(fps)}`,
        `activeMeshes=${formatCount(run.snapshot?.activeMeshes)}`,
        `totalVertices=${formatCount(run.snapshot?.totalVertices)}`,
        `canvas=${formatCanvas(run)}`,
      ],
      softwareRenderer
        ? ['Retest after forcing Brave back onto hardware GPU acceleration.']
        : ['Compare this run against a good Chrome run from the same location and camera angle.'],
    ));
  }

  if (dpr != null && dpr >= HIGH_DPR_THRESHOLD && pixels != null && pixels >= LARGE_CANVAS_PIXELS) {
    findings.push(finding(
      lowFps ? 'medium' : 'info',
      'large-high-dpr-canvas',
      'The canvas is large enough that fill-rate can matter, especially on a weak or software backend.',
      [
        `canvasPixels=${formatCount(pixels)}`,
        `dpr=${formatRate(dpr)}`,
      ],
      [
        'Compare the canvas/DPR against the good Chrome run before treating this as the root cause.',
      ],
    ));
  }

  if (gpuStatuses.length > 0) {
    findings.push(finding(
      softwareRenderer ? 'medium' : 'high',
      'gpu-feature-status',
      'Chrome DevTools reports disabled or software GPU feature statuses.',
      gpuStatuses.map((row) => `${row.key}=${row.value}`),
      [
        'Open brave://gpu in the same browser session and check the Graphics Feature Status table.',
      ],
    ));
  }

  if (flags.includes('webgl1-context')) {
    findings.push(finding(
      'medium',
      'webgl1-context',
      'The page fell back to WebGL 1 instead of WebGL 2.',
      [`renderer=${rendererFromWebGl(run.snapshot?.webgl ?? run.pageDiagnostics?.webgl)}`],
      ['Compare against the good Chrome run; WebGL 1 can be another browser/backend clue.'],
    ));
  }

  if (flags.includes('renderer-info-masked')) {
    findings.push(finding(
      'info',
      'renderer-info-masked',
      'The page could not read the unmasked WebGL renderer string.',
      [`pageRenderer=${rendererFromWebGl(run.pageDiagnostics?.webgl)}`],
      ['Use browser-diagnostics.json or brave://gpu for the GPU backend when the page renderer is masked.'],
    ));
  }

  if (snapshotSource(run) === 'profiler-fallback') {
    findings.push(finding(
      'info',
      'profiler-fallback-snapshot',
      'This run used the profiler fallback snapshot path for an older deployed client bundle.',
      [
        'FPS, renderer, canvas, mesh counts, and scene-budget buckets are still useful.',
      ],
      [
        'Client-only diagnostic fields may be less complete until the newer client bundle is deployed.',
      ],
    ));
  }

  if (flags.includes('snapshot-api-missing')) {
    findings.push(finding(
      'info',
      'snapshot-api-missing',
      'The loaded client bundle does not include the in-client profiler snapshot API.',
      scripts.length > 0 ? [`scripts=${scripts.slice(0, 4).join(', ')}`] : [],
      ['This is expected on the current live bundle if it has not been redeployed.'],
    ));
  }

  if (relevantFlags.some((flag) => /disable-gpu|swiftshader|use-gl=swiftshader/i.test(flag))) {
    findings.push(finding(
      'high',
      'gpu-command-line-flag',
      'The browser command line includes GPU-affecting flags.',
      relevantFlags,
      ['Remove GPU-disabling flags from the Brave shortcut or launcher before retesting.'],
    ));
  }

  let overall = 'No clear performance failure was reproduced in this run.';
  if (!hasSnapshot || loginScreen || flags.includes('game-not-ready')) {
    overall = softwareRenderer
      ? 'Renderer evidence is useful, but this is not a completed gameplay FPS capture.'
      : 'Capture is incomplete; rerun after logging into the game and reaching the bad-FPS scene.';
  } else if (softwareRenderer && lowFps) {
    overall = 'Likely browser GPU/backend issue: low FPS coincides with software/SwiftShader-like rendering.';
  } else if (softwareRenderer) {
    overall = 'Browser is using a software/SwiftShader-like renderer, even though this run did not reproduce low FPS.';
  } else if (lowFps) {
    overall = 'Low FPS reproduced without an obvious software-renderer signal; compare against a good Chrome run next.';
  } else if (fps != null && fps >= 100) {
    overall = 'This run looks healthy; it does not reproduce the reported 30 FPS Brave problem.';
  }

  return {
    run: {
      input: run.input,
      file: run.file,
      directory: run.dir,
      url: run.summary?.url || run.pageDiagnostics?.url || null,
    },
    overall,
    facts: {
      browser: browserLabel(run.pageDiagnostics),
      platform: run.pageDiagnostics?.browser?.platform ?? null,
      browserProduct: run.browserDiagnostics?.browserVersion?.product
        || run.browserDiagnostics?.devtoolsVersion?.Browser
        || null,
      primaryGpu: primaryGpuLabel(run.browserDiagnostics),
      renderer: rendererFromWebGl(run.snapshot?.webgl ?? run.pageDiagnostics?.webgl),
      browserGl: browserGlRenderer(run),
      softwareRenderer,
      snapshotSource: snapshotSource(run),
      measuredFps: fps,
      engineFps: run.snapshot?.engineFps ?? null,
      drawCalls: run.snapshot?.drawCalls ?? null,
      renderScale: run.snapshot?.renderScale ?? null,
      activeMeshes: run.snapshot?.activeMeshes ?? null,
      totalMeshes: run.snapshot?.totalMeshes ?? null,
      totalVertices: run.snapshot?.totalVertices ?? null,
      totalIndices: run.snapshot?.totalIndices ?? null,
      canvas: formatCanvas(run),
      canvasPixels: pixels,
      devicePixelRatio: dpr,
      authTokenPresent: run.pageDiagnostics?.storage?.hasAuthToken ?? null,
      gameReady: run.summary?.gameReady?.ok ?? null,
      flags,
      relevantCommandLineFlags: relevantFlags,
      gpuProblemStatuses: gpuStatuses,
      buildScripts: scripts,
      topCpuSelfTime: topCpuRows(run),
    },
    findings,
  };
}

function renderDiagnosisText(diagnosis) {
  const lines = [];
  lines.push('Profiler run diagnosis');
  lines.push(`Run: ${diagnosis.run.directory || diagnosis.run.file || diagnosis.run.input}`);
  lines.push(`URL: ${formatShortUrl(diagnosis.run.url)}`);
  lines.push(`Overall: ${diagnosis.overall}`);
  lines.push('');
  lines.push('Key facts');
  lines.push(`  Browser: ${diagnosis.facts.browser}${diagnosis.facts.browserProduct ? ` (${diagnosis.facts.browserProduct})` : ''}`);
  lines.push(`  Platform: ${diagnosis.facts.platform || 'n/a'}`);
  lines.push(`  GPU: ${diagnosis.facts.primaryGpu}`);
  lines.push(`  Renderer: ${diagnosis.facts.renderer}`);
  lines.push(`  Browser GL: ${diagnosis.facts.browserGl}`);
  lines.push(`  Software renderer: ${formatBool(diagnosis.facts.softwareRenderer)}`);
  lines.push(`  FPS: measured ${formatRate(diagnosis.facts.measuredFps)}, engine ${formatRate(diagnosis.facts.engineFps)}`);
  lines.push(`  Canvas/View: ${diagnosis.facts.canvas}`);
  lines.push(`  Scene: ${formatCount(diagnosis.facts.activeMeshes)} active meshes, ${formatCount(diagnosis.facts.totalVertices)} vertices, ${formatCount(diagnosis.facts.totalIndices)} indices`);
  lines.push(`  Snapshot source: ${diagnosis.facts.snapshotSource}`);
  lines.push(`  Flags: ${diagnosis.facts.flags.length > 0 ? diagnosis.facts.flags.join(', ') : 'none'}`);
  if (diagnosis.facts.relevantCommandLineFlags.length > 0) {
    lines.push(`  Browser flags: ${diagnosis.facts.relevantCommandLineFlags.join(' ')}`);
  }
  if (diagnosis.facts.buildScripts.length > 0) {
    lines.push(`  Client scripts: ${diagnosis.facts.buildScripts.slice(0, 6).join(', ')}${diagnosis.facts.buildScripts.length > 6 ? ', ...' : ''}`);
  }
  lines.push('');
  lines.push('Findings');
  if (diagnosis.findings.length === 0) {
    lines.push('  - none');
  } else {
    for (const item of diagnosis.findings) {
      lines.push(`  - [${item.severity}] ${item.code}: ${item.title}`);
      for (const evidence of item.evidence) lines.push(`      evidence: ${evidence}`);
      for (const next of item.nextAction) lines.push(`      next: ${next}`);
    }
  }
  if (diagnosis.facts.topCpuSelfTime.length > 0) {
    lines.push('');
    lines.push('Top CPU self-time');
    for (const row of diagnosis.facts.topCpuSelfTime) {
      lines.push(`  - ${formatRate(row.selfMs)}ms ${row.functionName} @ ${row.location}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const options = {
    input: null,
    json: false,
    write: false,
  };
  for (const arg of argv) {
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--write') {
      options.write = true;
    } else if (!options.input) {
      options.input = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const run = await readRun(options.input);
  const diagnosis = buildDiagnosis(run);
  const text = renderDiagnosisText(diagnosis);

  if (options.write) {
    if (!run.dir) throw new Error('--write requires a profiler run directory input');
    await writeFile(join(run.dir, 'diagnosis.json'), `${JSON.stringify(diagnosis, null, 2)}\n`);
    await writeFile(join(run.dir, 'diagnosis.txt'), text);
  }

  if (options.json) {
    console.log(JSON.stringify(diagnosis, null, 2));
  } else {
    process.stdout.write(text);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
