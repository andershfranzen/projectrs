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

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function browserRuntimeFromRun(run) {
  return run.snapshot?.browser && typeof run.snapshot.browser === 'object'
    ? run.snapshot.browser
    : run.pageDiagnostics?.browser && typeof run.pageDiagnostics.browser === 'object'
      ? run.pageDiagnostics.browser
      : {};
}

function screenFromRun(run) {
  const browser = browserRuntimeFromRun(run);
  return browser.screen && typeof browser.screen === 'object'
    ? browser.screen
    : run.pageDiagnostics?.screen && typeof run.pageDiagnostics.screen === 'object'
      ? run.pageDiagnostics.screen
      : null;
}

function viewportFromRun(run) {
  const browser = browserRuntimeFromRun(run);
  return run.pageDiagnostics?.viewport && typeof run.pageDiagnostics.viewport === 'object'
    ? run.pageDiagnostics.viewport
    : browser.window && typeof browser.window === 'object'
      ? browser.window
      : null;
}

function formatDisplay(run) {
  const screen = screenFromRun(run);
  const viewport = viewportFromRun(run);
  const orientation = screen?.orientation;
  const parts = [];
  if (screen) {
    const label = `${formatCount(screen.width)}x${formatCount(screen.height)}`;
    const available = screen.availWidth != null || screen.availHeight != null
      ? `avail ${formatCount(screen.availWidth)}x${formatCount(screen.availHeight)}`
      : null;
    const orient = orientation?.type ? `${orientation.type}${orientation.angle != null ? ` ${orientation.angle}deg` : ''}` : null;
    parts.push([label, available, orient].filter(Boolean).join(', '));
  }
  if (viewport) {
    parts.push(`viewport ${formatCount(viewport.innerWidth)}x${formatCount(viewport.innerHeight)} inner / ${formatCount(viewport.outerWidth)}x${formatCount(viewport.outerHeight)} outer`);
  }
  return parts.length > 0 ? parts.join('; ') : 'n/a';
}

function formatConnection(run) {
  const connection = browserRuntimeFromRun(run).connection;
  if (!connection || typeof connection !== 'object') return 'n/a';
  const parts = [
    connection.effectiveType || connection.type || null,
    connection.downlink != null ? `${formatRate(connection.downlink)}Mbps` : null,
    connection.rtt != null ? `${formatCount(connection.rtt)}ms RTT` : null,
    connection.saveData === true ? 'Save-Data on' : connection.saveData === false ? 'Save-Data off' : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'n/a';
}

function formatBattery(run) {
  const battery = browserRuntimeFromRun(run).battery;
  if (!battery || typeof battery !== 'object') return 'n/a';
  const level = finiteNumber(battery.level);
  const percent = level != null ? `${Math.round(level * 100)}%` : 'level n/a';
  const charging = battery.charging === true ? 'charging' : battery.charging === false ? 'not charging' : 'charging n/a';
  return `${percent}, ${charging}`;
}

function lowBattery(run) {
  const battery = browserRuntimeFromRun(run).battery;
  const level = finiteNumber(battery?.level);
  return battery?.charging === false && level != null && level <= 0.25;
}

function formatMediaPreferences(run) {
  const media = browserRuntimeFromRun(run).media;
  if (!media || typeof media !== 'object') return 'n/a';
  const active = [
    media.prefersReducedMotion === true ? 'reduced-motion' : null,
    media.prefersReducedData === true ? 'reduced-data' : null,
    media.prefersContrastMore === true ? 'contrast-more' : null,
    media.forcedColors === true ? 'forced-colors' : null,
  ].filter(Boolean);
  return active.length > 0 ? active.join(', ') : 'none';
}

function framePacingFromRun(run) {
  const pacing = run.snapshot?.framePacing;
  return pacing && typeof pacing === 'object' ? pacing : null;
}

function isStableLowCadence(fps, pacing) {
  if (fps == null || !pacing) return false;
  const median = finiteNumber(pacing.medianMs);
  const p95 = finiteNumber(pacing.p95Ms);
  const stddev = finiteNumber(pacing.stddevMs);
  return fps >= 27
    && fps <= 36
    && median != null
    && median >= 27
    && median <= 38
    && p95 != null
    && p95 <= 42
    && stddev != null
    && stddev <= 5;
}

function isUnevenFramePacing(pacing) {
  if (!pacing) return false;
  const p95 = finiteNumber(pacing.p95Ms);
  const max = finiteNumber(pacing.maxMs);
  const stddev = finiteNumber(pacing.stddevMs);
  const over50 = finiteNumber(pacing.over50Ms);
  return (p95 != null && p95 >= 50)
    || (max != null && max >= 100)
    || (stddev != null && stddev >= 12)
    || (over50 != null && over50 >= 3);
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

function formatFramePacing(pacing) {
  if (!pacing) return 'n/a';
  return `median ${formatRate(pacing.medianMs)}ms, p95 ${formatRate(pacing.p95Ms)}ms, max ${formatRate(pacing.maxMs)}ms, stddev ${formatRate(pacing.stddevMs)}ms, >33ms ${formatCount(pacing.over33Ms)}, >50ms ${formatCount(pacing.over50Ms)}`;
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
  const framePacing = framePacingFromRun(run);
  const gpuStatuses = gpuProblemStatuses(run);
  const relevantFlags = commandLineFlags(run.browserDiagnostics);
  const scripts = buildScriptFingerprint(run);
  const terrainDetail = run.snapshot?.chunkMeshes?.terrainDetail && typeof run.snapshot.chunkMeshes.terrainDetail === 'object'
    ? run.snapshot.chunkMeshes.terrainDetail
    : null;
  const browserRuntime = browserRuntimeFromRun(run);
  const connection = browserRuntime.connection && typeof browserRuntime.connection === 'object' ? browserRuntime.connection : null;
  const media = browserRuntime.media && typeof browserRuntime.media === 'object' ? browserRuntime.media : null;
  const grassBatchLastMs = finiteNumber(terrainDetail?.grassBladeBatchLastRebuildMs);
  const grassBatchMaxMs = finiteNumber(terrainDetail?.grassBladeBatchMaxRebuildMs);
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

  if (isStableLowCadence(fps, framePacing)) {
    findings.push(finding(
      'high',
      'stable-low-frame-cadence',
      'Frame pacing looks like a stable low refresh/cap rather than random render stalls.',
      [
        `measuredFps=${formatRate(fps)}`,
        `framePacing=${formatFramePacing(framePacing)}`,
      ],
      [
        'Check Brave/Windows graphics acceleration, display refresh, battery/efficiency settings, and ANGLE backend before changing scene complexity.',
      ],
    ));
  } else if (lowFps && isUnevenFramePacing(framePacing)) {
    findings.push(finding(
      'high',
      'uneven-frame-pacing',
      'Low FPS includes long or irregular frame intervals.',
      [
        `framePacing=${formatFramePacing(framePacing)}`,
      ],
      [
        'Use the CPU profile and scene-budget sections to identify the slow frame work, then compare against a healthy Chrome run.',
      ],
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

  if (lowFps && lowBattery(run)) {
    findings.push(finding(
      'medium',
      'low-battery-state',
      'The bad-FPS run happened while the browser reported low battery and no charging.',
      [
        `battery=${formatBattery(run)}`,
      ],
      [
        'Retest Brave while plugged in and with Windows/Brave efficiency mode disabled.',
      ],
    ));
  }

  if (connection?.saveData === true || media?.prefersReducedData === true) {
    findings.push(finding(
      lowFps ? 'medium' : 'info',
      'reduced-data-mode',
      'The browser reports a reduced-data or Save-Data preference.',
      [
        `connection=${formatConnection(run)}`,
        `media=${formatMediaPreferences(run)}`,
      ],
      [
        'This is not usually an FPS limiter by itself, but it is useful browser-state evidence when comparing Chrome and Brave.',
      ],
    ));
  }

  if ((grassBatchLastMs != null && grassBatchLastMs >= 8) || (grassBatchMaxMs != null && grassBatchMaxMs >= 8)) {
    findings.push(finding(
      'medium',
      'grass-batch-rebuild-cost',
      'Procedural grass batch rebuilds are taking a visible fraction of a frame.',
      [
        `last=${formatRate(grassBatchLastMs)}ms`,
        `max=${formatRate(grassBatchMaxMs)}ms`,
        `instances=${formatCount(terrainDetail?.grassBladeEnabledInstances)}`,
        `rebuilds=${formatCount(terrainDetail?.grassBladeBatchRebuilds)}`,
      ],
      [
        'If this appears during a low-FPS run, compare against a stationary capture after chunk streaming has settled.',
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
      display: formatDisplay(run),
      connection: formatConnection(run),
      battery: formatBattery(run),
      mediaPreferences: formatMediaPreferences(run),
      renderer: rendererFromWebGl(run.snapshot?.webgl ?? run.pageDiagnostics?.webgl),
      browserGl: browserGlRenderer(run),
      softwareRenderer,
      snapshotSource: snapshotSource(run),
      measuredFps: fps,
      engineFps: run.snapshot?.engineFps ?? null,
      drawCalls: run.snapshot?.drawCalls ?? null,
      renderScale: run.snapshot?.renderScale ?? null,
      framePacing,
      activeMeshes: run.snapshot?.activeMeshes ?? null,
      totalMeshes: run.snapshot?.totalMeshes ?? null,
      totalVertices: run.snapshot?.totalVertices ?? null,
      totalIndices: run.snapshot?.totalIndices ?? null,
      terrainDetail,
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
  lines.push(`  Display: ${diagnosis.facts.display}`);
  lines.push(`  Connection: ${diagnosis.facts.connection}`);
  lines.push(`  Battery: ${diagnosis.facts.battery}`);
  lines.push(`  Media prefs: ${diagnosis.facts.mediaPreferences}`);
  lines.push(`  GPU: ${diagnosis.facts.primaryGpu}`);
  lines.push(`  Renderer: ${diagnosis.facts.renderer}`);
  lines.push(`  Browser GL: ${diagnosis.facts.browserGl}`);
  lines.push(`  Software renderer: ${formatBool(diagnosis.facts.softwareRenderer)}`);
  lines.push(`  FPS: measured ${formatRate(diagnosis.facts.measuredFps)}, engine ${formatRate(diagnosis.facts.engineFps)}`);
  lines.push(`  Frame pacing: ${formatFramePacing(diagnosis.facts.framePacing)}`);
  lines.push(`  Canvas/View: ${diagnosis.facts.canvas}`);
  lines.push(`  Scene: ${formatCount(diagnosis.facts.activeMeshes)} active meshes, ${formatCount(diagnosis.facts.totalVertices)} vertices, ${formatCount(diagnosis.facts.totalIndices)} indices`);
  if (diagnosis.facts.terrainDetail) {
    const detail = diagnosis.facts.terrainDetail;
    lines.push(`  Grass batch: ${formatCount(detail.grassBladeEnabledInstances)} active instances, ${formatCount(detail.grassBladeBatchRebuilds)} rebuilds, last ${formatRate(detail.grassBladeBatchLastRebuildMs)}ms, max ${formatRate(detail.grassBladeBatchMaxRebuildMs)}ms`);
  }
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
