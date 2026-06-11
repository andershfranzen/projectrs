#!/usr/bin/env bun
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] || 'https://evilquest.net/play';
const seconds = Number(process.env.PROFILE_SECONDS || process.argv[3] || 30);
const port = Number(process.env.CDP_PORT || 9222);
const browserBin = process.env.BROWSER_BIN || process.env.CHROME_BIN || 'google-chrome';
const userDataDir = process.env.CHROME_PROFILE_DIR || join(tmpdir(), 'evilquest-profiler-chrome');
const outDir = process.env.PROFILE_OUT_DIR || join(process.cwd(), 'tools', 'profiler-runs');
const autorun = process.env.PROFILE_AUTORUN === '1' || process.argv.includes('--autorun');
const keepProfile = process.env.PROFILE_KEEP_PROFILE === '1' || process.argv.includes('--keep-profile') || autorun;
const captureEvilQuestSnapshot = process.env.PROFILE_EVILQUEST_SNAPSHOT !== '0';
const captureStartup = process.env.PROFILE_CAPTURE_STARTUP === '1';
const reloadBeforeCapture = process.env.PROFILE_RELOAD_BEFORE_CAPTURE !== '0';
const evilQuestSnapshotMs = Number(process.env.PROFILE_EVILQUEST_SNAPSHOT_MS || 3000);
const gameReadyTimeoutMs = Number(process.env.PROFILE_GAME_READY_TIMEOUT_MS || 45000);
const extraBrowserArgs = (process.env.PROFILE_BROWSER_ARGS || '').split(/\s+/).filter(Boolean);
const authToken = process.env.PROFILE_AUTH_TOKEN || '';
const authUsername = process.env.PROFILE_AUTH_USERNAME || '';
const wsSecret = process.env.PROFILE_WS_SECRET || '';
const deviceId = process.env.PROFILE_DEVICE_ID || '';
const allowExistingCdp = process.env.PROFILE_ALLOW_EXISTING_CDP === '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stdinEnded = false;
input.on('end', () => { stdinEnded = true; });

function readCommand(prompt) {
  if (stdinEnded) return Promise.resolve('quit');
  output.write(prompt);
  input.resume();
  return new Promise((resolve) => {
    const cleanup = () => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onEnd);
    };
    const onData = (data) => {
      cleanup();
      resolve(String(data).trim().toLowerCase());
    };
    const onEnd = () => {
      stdinEnded = true;
      cleanup();
      resolve('quit');
    };
    input.once('data', onData);
    input.once('end', onEnd);
    input.once('error', onEnd);
  });
}

async function cdpJson(path, init) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  if (!res.ok) throw new Error(`CDP HTTP ${res.status} for ${path}`);
  return res.json();
}

async function waitForCdp() {
  for (let i = 0; i < 80; i += 1) {
    try {
      return await cdpJson('/json/version');
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`Chrome DevTools endpoint did not appear on port ${port}`);
}

async function isCdpPortOpen() {
  try {
    await cdpJson('/json/version');
    return true;
  } catch {
    return false;
  }
}

async function withBrowserCdp(callback) {
  const version = await cdpJson('/json/version');
  if (!version?.webSocketDebuggerUrl) {
    return { error: 'Chrome DevTools browser target is unavailable', version };
  }

  const browserCdp = new CdpClient(version.webSocketDebuggerUrl);
  await browserCdp.open();
  try {
    return await callback(browserCdp, version);
  } finally {
    browserCdp.close();
  }
}

async function safeCdpSend(cdp, method, params = {}) {
  try {
    return await cdp.send(method, params);
  } catch (error) {
    return {
      error: error?.message || String(error),
    };
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = new WebSocket(wsUrl);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => this.onMessage(String(event.data)));
  }

  onMessage(raw) {
    const msg = JSON.parse(raw);
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, method } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}: ${msg.error.data || ''}`));
      else resolve(msg.result || {});
      return;
    }
    const list = this.handlers.get(msg.method);
    if (list) for (const handler of list) handler(msg.params || {});
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
  }

  on(method, handler) {
    const list = this.handlers.get(method) || [];
    list.push(handler);
    this.handlers.set(method, list);
  }

  close() {
    this.ws.close();
  }
}

async function openFreshPageTarget(initialUrl = 'about:blank') {
  return withBrowserCdp(async (browserCdp) => {
    const created = await browserCdp.send('Target.createTarget', {
      url: initialUrl,
      newWindow: false,
      background: false,
    });
    const targetId = created.targetId;
    if (!targetId) throw new Error('Chrome DevTools did not create a page target');

    for (let i = 0; i < 40; i += 1) {
      const targets = await cdpJson('/json/list');
      const target = targets.find((item) => item.id === targetId);
      if (target?.webSocketDebuggerUrl) return target;
      await sleep(100);
    }
    throw new Error(`Fresh page target ${targetId} did not become debuggable`);
  });
}

async function captureBrowserDiagnostics() {
  return withBrowserCdp(async (browserCdp, devtoolsVersion) => {
    const browserVersion = await safeCdpSend(browserCdp, 'Browser.getVersion');
    const systemInfo = await safeCdpSend(browserCdp, 'SystemInfo.getInfo');
    const processInfo = await safeCdpSend(browserCdp, 'SystemInfo.getProcessInfo');
    const commandLine = await safeCdpSend(browserCdp, 'Browser.getBrowserCommandLine');
    return {
      capturedAt: new Date().toISOString(),
      devtoolsVersion,
      browserVersion,
      systemInfo,
      processInfo,
      commandLine,
    };
  });
}

const injectedProfiler = String.raw`
(() => {
  if (window.__evilQuestProfilerInstalled) return;
  window.__evilQuestProfilerInstalled = true;
  const original = {
    addEventListener: EventTarget.prototype.addEventListener,
    setTimeout: window.setTimeout,
    setInterval: window.setInterval,
    requestAnimationFrame: window.requestAnimationFrame,
    fetch: window.fetch,
    sendBeacon: navigator.sendBeacon,
    WebSocket: window.WebSocket,
  };
  const stats = window.__evilQuestProfiler = {
    callbacks: [],
    resources: [],
    longTasks: [],
    websockets: [],
    fetches: [],
    beacons: [],
    errors: [],
    marks: [],
  };
  const now = () => performance.now();
  const clip = (value, max = 180) => String(value || '').slice(0, max);
  const record = (bucket, item) => {
    const arr = stats[bucket];
    if (!arr) return;
    arr.push(item);
    if (arr.length > 5000) arr.splice(0, arr.length - 5000);
  };
  const wrap = (kind, name, fn) => {
    if (typeof fn !== 'function' || fn.__evilQuestProfileWrapped) return fn;
    const wrapped = function(...args) {
      const start = now();
      try {
        return fn.apply(this, args);
      } catch (error) {
        record('errors', { kind, name, at: start, message: clip(error && error.message) });
        throw error;
      } finally {
        const duration = now() - start;
        if (duration >= 4) record('callbacks', { kind, name, duration, at: start });
      }
    };
    Object.defineProperty(wrapped, '__evilQuestProfileWrapped', { value: true });
    return wrapped;
  };
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    const name = listener && (listener.name || listener.handleEvent?.name) || ((this.constructor?.name || 'EventTarget') + '.' + type);
    if (typeof listener === 'function') {
      return original.addEventListener.call(this, type, wrap('event:' + type, name, listener), options);
    }
    if (listener && typeof listener.handleEvent === 'function') {
      const proxy = { ...listener, handleEvent: wrap('event:' + type, name, listener.handleEvent.bind(listener)) };
      return original.addEventListener.call(this, type, proxy, options);
    }
    return original.addEventListener.call(this, type, listener, options);
  };
  window.setTimeout = (fn, delay, ...args) => original.setTimeout.call(window, wrap('timeout', fn?.name || ('timeout:' + delay), fn), delay, ...args);
  window.setInterval = (fn, delay, ...args) => original.setInterval.call(window, wrap('interval', fn?.name || ('interval:' + delay), fn), delay, ...args);
  window.requestAnimationFrame = (fn) => original.requestAnimationFrame.call(window, wrap('raf', fn?.name || 'requestAnimationFrame', fn));
  window.fetch = async (...args) => {
    const start = now();
    try {
      const res = await original.fetch.call(window, ...args);
      record('fetches', { url: clip(args[0]?.url || args[0]), status: res.status, duration: now() - start, at: start });
      return res;
    } catch (error) {
      record('fetches', { url: clip(args[0]?.url || args[0]), error: clip(error.message), duration: now() - start, at: start });
      throw error;
    }
  };
  if (original.sendBeacon) {
    navigator.sendBeacon = function(url, data) {
      const size = typeof data === 'string'
        ? data.length
        : data?.size ?? data?.byteLength ?? 0;
      record('beacons', { url: clip(url), bytes: size, at: now() });
      return original.sendBeacon.call(this, url, data);
    };
  }
  window.WebSocket = new Proxy(original.WebSocket, {
    construct(Target, args) {
      const start = now();
      const ws = new Target(...args);
      const url = clip(args[0]);
      record('websockets', { type: 'construct', url, at: start });
      original.addEventListener.call(ws, 'open', () => record('websockets', { type: 'open', url, duration: now() - start, at: start }));
      original.addEventListener.call(ws, 'message', (event) => record('websockets', { type: 'message', url, bytes: event.data?.byteLength || event.data?.length || 0, at: now() }));
      original.addEventListener.call(ws, 'close', () => record('websockets', { type: 'close', url, at: now() }));
      return ws;
    }
  });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) record('longTasks', { name: entry.name, duration: entry.duration, at: entry.startTime });
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.initiatorType) record('resources', {
          name: clip(entry.name), type: entry.initiatorType, duration: entry.duration,
          transferSize: entry.transferSize || 0, decodedBodySize: entry.decodedBodySize || 0, at: entry.startTime
        });
      }
    }).observe({ entryTypes: ['resource'] });
  } catch {}
  console.info('[evilquest-profiler] browser hooks installed');
})();
`;

function flattenProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const samples = profile.samples || [];
  const deltas = profile.timeDeltas || [];
  const rows = new Map();
  for (let i = 0; i < samples.length; i += 1) {
    const node = nodes.get(samples[i]);
    if (!node) continue;
    const frame = node.callFrame || {};
    const urlPart = frame.url ? frame.url.replace(/^https?:\/\//, '') : '<anonymous>';
    const key = `${frame.functionName || '(anonymous)'} @ ${urlPart}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
    const prev = rows.get(key) || {
      functionName: frame.functionName || '(anonymous)',
      url: frame.url || '',
      line: (frame.lineNumber ?? -1) + 1,
      column: (frame.columnNumber ?? -1) + 1,
      selfMs: 0,
      samples: 0,
    };
    prev.selfMs += (deltas[i] || 0) / 1000;
    prev.samples += 1;
    rows.set(key, prev);
  }
  return [...rows.values()].sort((a, b) => b.selfMs - a.selfMs);
}

function summarizeBrowserStats(stats) {
  const callbackRows = new Map();
  for (const cb of stats.callbacks || []) {
    const key = `${cb.kind} ${cb.name}`;
    const row = callbackRows.get(key) || { key, count: 0, totalMs: 0, maxMs: 0 };
    row.count += 1;
    row.totalMs += cb.duration || 0;
    row.maxMs = Math.max(row.maxMs, cb.duration || 0);
    callbackRows.set(key, row);
  }
  return {
    slowCallbacks: [...callbackRows.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 50),
    longTasks: [...(stats.longTasks || [])].sort((a, b) => b.duration - a.duration).slice(0, 50),
    slowResources: [...(stats.resources || [])].sort((a, b) => b.duration - a.duration).slice(0, 50),
    slowFetches: [...(stats.fetches || [])].sort((a, b) => b.duration - a.duration).slice(0, 50),
    websockets: stats.websockets || [],
    beacons: stats.beacons || [],
    errors: stats.errors || [],
  };
}

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

function formatCanvas(canvas) {
  if (!canvas) return 'n/a';
  const renderSize = `${formatCount(canvas.width)}x${formatCount(canvas.height)}`;
  const clientSize = `${formatCount(canvas.clientWidth)}x${formatCount(canvas.clientHeight)}`;
  const dpr = formatRate(canvas.devicePixelRatio);
  return `${renderSize} / ${clientSize}, DPR ${dpr}`;
}

function formatBudgetRow(row) {
  if (!row || typeof row !== 'object') return 'n/a';
  const name = row.name || row.chunk || '<unnamed>';
  const vertices = row.vertices == null ? '' : `, ${formatCount(row.vertices)}v`;
  const indices = row.indices == null ? '' : `, ${formatCount(row.indices)}i`;
  const instances = row.instances == null || row.instances === 0 ? '' : `, ${formatCount(row.instances)} inst`;
  const effectiveVertices = row.effectiveVertices == null || row.effectiveVertices === row.vertices ? '' : `, ${formatCount(row.effectiveVertices)} eff-v`;
  return `${name} (${formatCount(row.count)}x${vertices}${indices}${instances}${effectiveVertices})`;
}

function printBudgetRows(label, rows, limit = 5) {
  const items = Array.isArray(rows) ? rows.slice(0, limit) : [];
  if (items.length === 0) return;
  console.log(`  ${label}:`);
  for (const row of items) console.log(`    ${formatBudgetRow(row)}`);
}

function printPageDiagnostics(pageDiagnostics) {
  if (!pageDiagnostics || typeof pageDiagnostics !== 'object') return;
  const renderer = pageDiagnostics.webgl?.unmaskedRenderer || pageDiagnostics.webgl?.renderer || 'unknown';
  const context = pageDiagnostics.webgl?.context || 'unavailable';
  const browserName = pageDiagnostics.browser?.brave ? 'Brave' : 'Chromium';
  const authText = pageDiagnostics.storage?.hasAuthToken
    ? 'auth token present'
    : 'no auth token';
  console.log('Page diagnostics:');
  console.log(`  ${browserName}, ${context}, renderer: ${renderer}`);
  console.log(`  ${authText}, has game manager: ${pageDiagnostics.game?.hasGameManager ? 'yes' : 'no'}, title: ${pageDiagnostics.title || 'n/a'}`);
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

function printBrowserDiagnostics(browserDiagnostics) {
  if (!browserDiagnostics || typeof browserDiagnostics !== 'object') return;
  if (browserDiagnostics.error) {
    console.log(`Browser diagnostics unavailable: ${browserDiagnostics.error}`);
    return;
  }

  const browser = browserDiagnostics.browserVersion?.product
    || browserDiagnostics.devtoolsVersion?.Browser
    || 'unknown browser';
  const devices = gpuDevicesFromBrowserDiagnostics(browserDiagnostics);
  const primaryGpu = devices[0];
  const gpuLabel = primaryGpu
    ? `${[
      primaryGpu.vendorString || primaryGpu.vendorId,
      primaryGpu.deviceString || primaryGpu.deviceId,
    ].filter(Boolean).join(' ')}${primaryGpu.driverVendor || primaryGpu.driverVersion
      ? ` (${[primaryGpu.driverVendor, primaryGpu.driverVersion].filter(Boolean).join(' ')})`
      : ''}`
    : 'unknown GPU';
  const aux = browserDiagnostics.systemInfo?.gpu?.auxAttributes || {};
  const featureStatus = gpuFeatureStatusFromBrowserDiagnostics(browserDiagnostics);
  const webglStatus = featureStatus.webgl || featureStatus.webgl2 || 'unknown';
  const gpuCompositingStatus = featureStatus.gpu_compositing || 'unknown';

  console.log('Browser process diagnostics:');
  console.log(`  ${browser}, GPU: ${gpuLabel}`);
  console.log(`  WebGL feature: ${webglStatus}, GPU compositing: ${gpuCompositingStatus}`);
  if (aux.glRenderer || aux.glVendor) {
    console.log(`  GL: ${[aux.glVendor, aux.glRenderer].filter(Boolean).join(' / ')}`);
  }
}

function printEvilQuestSnapshot(snapshot) {
  const flags = Array.isArray(snapshot.diagnosticFlags) && snapshot.diagnosticFlags.length > 0
    ? snapshot.diagnosticFlags.join(', ')
    : 'none';
  const renderer = snapshot.webgl?.unmaskedRenderer || snapshot.webgl?.renderer || 'unknown';
  const summary = snapshot.sceneBudget?.summary || {};
  const chunks = snapshot.chunkMeshes || {};

  console.log('EvilQuest snapshot:');
  console.log(`  ${formatRate(snapshot.measuredFps)} FPS, engine ${formatRate(snapshot.engineFps)}, draw calls ${formatCount(snapshot.drawCalls)}`);
  console.log(`  Active meshes ${formatCount(snapshot.activeMeshes)} / total ${formatCount(snapshot.totalMeshes)}, vertices ${formatCount(snapshot.totalVertices)}, indices ${formatCount(snapshot.totalIndices)}`);
  console.log(`  Pickable ${formatCount(summary.activePickableMeshes)} active / ${formatCount(summary.pickableMeshes)} total, enabled ${formatCount(summary.enabledMeshes)}, textures ${formatCount(summary.textures)}, materials ${formatCount(summary.materials)}`);
  console.log(`  Terrain chunks ${formatCount(chunks.ground)}, grass ${formatCount(chunks.grass)} meshes / ${formatCount(chunks.grassVertices)} vertices, detail ${formatCount(chunks.detailVertices)} vertices`);
  console.log(`  Canvas: ${formatCanvas(snapshot.canvas)}`);
  console.log(`  Renderer: ${renderer}`);
  console.log(`  Flags: ${flags}`);
  printBudgetRows('Top active', snapshot.sceneBudget?.activeByName);
  printBudgetRows('Top active pickable', snapshot.sceneBudget?.activePickableByName);
  printBudgetRows('Top enabled', snapshot.sceneBudget?.enabledByName, 3);
}

async function evaluateJson(cdp, expression, options = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    ...options,
  });
  if (result.exceptionDetails) {
    return {
      error: result.exceptionDetails.text || 'Runtime evaluation failed',
      details: result.exceptionDetails.exception?.description || '',
    };
  }
  return result.result?.value;
}

async function waitForEvilQuestGame(cdp, timeoutMs) {
  return evaluateJson(cdp, `
    new Promise((resolve) => {
      const startedAt = performance.now();
      const check = () => {
        const gm = window.gm;
        const ready = !!gm
          && gm._loginSettled === true
          && typeof gm.username === 'string'
          && gm.username.length > 0
          && typeof gm.localPlayerId === 'number'
          && gm.localPlayerId > 0
          && typeof gm.collectPerformanceSnapshot === 'function'
          && typeof gm.sampleRafFps === 'function'
          && document.visibilityState === 'visible';
        if (ready) {
          resolve({
            ok: true,
            waitedMs: Math.round(performance.now() - startedAt),
            username: gm.username || '',
            localPlayerId: gm.localPlayerId,
          });
          return;
        }
        if (performance.now() - startedAt >= ${Math.max(1000, Math.round(timeoutMs))}) {
          resolve({
            ok: false,
            waitedMs: Math.round(performance.now() - startedAt),
            hasGameManager: !!gm,
            loginSettled: gm?._loginSettled ?? null,
            username: gm?.username ?? null,
            localPlayerId: gm?.localPlayerId ?? null,
            hasSnapshotApi: !!gm && typeof gm.collectPerformanceSnapshot === 'function',
            visibilityState: document.visibilityState,
            title: document.title,
            bodyText: document.body?.innerText?.slice(0, 500) || '',
            location: String(location.href),
          });
          return;
        }
        setTimeout(check, 250);
      };
      check();
    })
  `);
}

async function capturePageDiagnostics(cdp) {
  return evaluateJson(cdp, `
    (() => {
      const nav = window.navigator || {};
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const debugInfo = gl?.getExtension?.('WEBGL_debug_renderer_info') || null;
      const webgl = gl ? {
        context: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl',
        version: gl.getParameter(gl.VERSION),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        vendor: gl.getParameter(gl.VENDOR),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedVendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null,
        unmaskedRenderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
      } : { context: 'unavailable' };
      const gm = window.gm;
      let storage = {
        hasAuthToken: false,
        hasStoredUsername: false,
        hasDeviceId: false,
      };
      try {
        storage = {
          hasAuthToken: !!localStorage.getItem('evilquest_token'),
          hasStoredUsername: !!localStorage.getItem('evilquest_username'),
          hasDeviceId: !!(localStorage.getItem('evilmud_device_id') || localStorage.getItem('evilquest_device_id')),
        };
      } catch {}
      return {
        url: String(location.href),
        title: document.title,
        visibilityState: document.visibilityState,
        bodyText: document.body?.innerText?.slice(0, 500) || '',
        browser: {
          userAgent: nav.userAgent,
          platform: nav.platform,
          userAgentData: nav.userAgentData ? {
            brands: nav.userAgentData.brands,
            platform: nav.userAgentData.platform,
            mobile: nav.userAgentData.mobile,
          } : null,
          brave: !!nav.brave,
          hardwareConcurrency: nav.hardwareConcurrency,
          deviceMemory: nav.deviceMemory ?? null,
          language: nav.language,
          languages: nav.languages,
          devicePixelRatio: window.devicePixelRatio,
        },
        screen: window.screen ? {
          width: window.screen.width,
          height: window.screen.height,
          availWidth: window.screen.availWidth,
          availHeight: window.screen.availHeight,
          colorDepth: window.screen.colorDepth,
          pixelDepth: window.screen.pixelDepth,
        } : null,
        viewport: {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
        },
        storage,
        webgl,
        game: {
          hasGameManager: !!gm,
          loginSettled: gm?._loginSettled ?? null,
          usernamePresent: typeof gm?.username === 'string' && gm.username.length > 0,
          localPlayerIdPresent: typeof gm?.localPlayerId === 'number' && gm.localPlayerId > 0,
          hasSnapshotApi: !!gm && typeof gm.collectPerformanceSnapshot === 'function',
        },
      };
    })()
  `);
}

async function captureEvilQuestPerformanceSnapshot(cdp, durationMs) {
  return evaluateJson(cdp, `
    (async () => {
      const gm = window.gm;
      if (!gm || typeof gm.collectPerformanceSnapshot !== 'function') {
        return { ok: false, error: 'window.gm.collectPerformanceSnapshot unavailable' };
      }
      if (!gm.username || !(gm.localPlayerId > 0) || gm._loginSettled !== true) {
        return {
          ok: false,
          error: 'EvilQuest login is not settled',
          username: gm.username || '',
          localPlayerId: gm.localPlayerId ?? null,
          loginSettled: gm._loginSettled ?? null,
        };
      }
      const sample = typeof gm.sampleRafFps === 'function'
        ? await gm.sampleRafFps(${Math.max(250, Math.round(durationMs))})
        : null;
      const snapshot = gm.collectPerformanceSnapshot(sample || undefined);
      return { ok: true, snapshot };
    })()
  `);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  if (!keepProfile) await rm(userDataDir, { recursive: true, force: true });
  if (!allowExistingCdp && await isCdpPortOpen()) {
    throw new Error(`CDP port ${port} is already in use. Set CDP_PORT to a free port, close the other Chromium app, or set PROFILE_ALLOW_EXISTING_CDP=1 to intentionally attach.`);
  }
  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--enable-precise-memory-info',
    ...extraBrowserArgs,
    'about:blank',
  ];
  const chrome = spawn(browserBin, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  chrome.on('error', (error) => {
    console.error(`[evilquest-profiler] Failed to launch ${browserBin}: ${error.message}`);
  });
  chrome.stderr.on('data', (data) => {
    const text = String(data);
    if (!text.includes('DevTools listening')) process.stderr.write(text);
  });
  chrome.unref();

  await waitForCdp();
  const browserDiagnostics = await captureBrowserDiagnostics();
  printBrowserDiagnostics(browserDiagnostics);
  const pageTarget = await openFreshPageTarget('about:blank');
  if (!pageTarget?.webSocketDebuggerUrl) throw new Error('No debuggable Chrome page target found');
  const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.open();

  const browserLogs = [];
  cdp.on('Runtime.consoleAPICalled', (params) => {
    browserLogs.push({
      type: params.type,
      at: params.timestamp,
      args: (params.args || []).map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? '').join(' '),
    });
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    browserLogs.push({ type: 'exception', at: Date.now(), args: params.exceptionDetails?.text || 'exception' });
  });
  cdp.on('Log.entryAdded', (params) => {
    browserLogs.push({ type: params.entry?.level || 'log', at: Date.now(), args: params.entry?.text || '' });
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('Profiler.enable');
  try {
    await cdp.send('Runtime.setAsyncCallStackDepth', { maxDepth: 32 });
  } catch (error) {
    console.warn(`[evilquest-profiler] Runtime async stack depth unavailable: ${error.message}`);
  }
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: injectedProfiler });
  if (authToken && authUsername) {
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        try {
          localStorage.setItem('evilquest_token', ${JSON.stringify(authToken)});
          localStorage.setItem('evilquest_username', ${JSON.stringify(authUsername)});
        } catch {}
      `,
    });
  }
  if (wsSecret) {
    await cdp.send('Network.setCookie', {
      url,
      name: 'eq_ws_session',
      value: wsSecret,
      sameSite: 'Strict',
      httpOnly: true,
    });
  }
  if (deviceId) {
    await cdp.send('Network.setCookie', {
      url,
      name: 'eq_device_id',
      value: deviceId,
      sameSite: 'Strict',
      httpOnly: true,
    });
  }
  await cdp.send('Page.navigate', { url });
  console.log(`Opened ${url} in ${browserBin}.`);
  if (autorun) console.log(`Autorun enabled; recording ${seconds}s immediately.`);
  else console.log(`Type "go" to reload and record ${seconds}s, "capture" to record the current tab, or "quit" to exit.`);

  while (true) {
    const answer = autorun ? 'go' : await readCommand('profiler> ');
    if (answer === 'quit' || answer === 'exit') break;
    const shouldReload = autorun ? reloadBeforeCapture : (answer === 'go' || answer === 'reload');
    const shouldCaptureCurrent = !autorun && (answer === 'capture' || answer === 'record' || answer === 'current');
    if (!shouldReload && !shouldCaptureCurrent) continue;

    await cdp.send('Performance.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    browserLogs.length = 0;
    if (captureStartup) await cdp.send('Profiler.start');
    if (shouldReload) await cdp.send('Page.reload', { ignoreCache: true });
    const gameReady = captureEvilQuestSnapshot
      ? await waitForEvilQuestGame(cdp, gameReadyTimeoutMs)
      : { ok: false, skipped: true };
    const pageDiagnostics = await capturePageDiagnostics(cdp);
    if (captureEvilQuestSnapshot && !gameReady?.ok) {
      console.log(`[evilquest-profiler] Game snapshot wait did not finish: ${JSON.stringify(gameReady)}`);
      printPageDiagnostics(pageDiagnostics);
    }
    if (!captureStartup) await cdp.send('Profiler.start');
    const recordingContext = captureStartup
      ? 'including startup'
      : captureEvilQuestSnapshot && gameReady?.ok
        ? 'after game ready'
        : 'without an in-game snapshot';
    console.log(`Recording ${seconds}s ${recordingContext}...`);
    await sleep(seconds * 1000);
    const { profile } = await cdp.send('Profiler.stop');
    const perf = await cdp.send('Performance.getMetrics');
    const statsResult = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__evilQuestProfiler || {})',
      returnByValue: true,
    });
    const browserStats = JSON.parse(statsResult.result?.value || '{}');
    const evilQuestSnapshot = captureEvilQuestSnapshot && gameReady?.ok
      ? await captureEvilQuestPerformanceSnapshot(cdp, evilQuestSnapshotMs)
      : { ok: false, skipped: true, gameReady };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const runDir = join(outDir, stamp);
    await mkdir(runDir, { recursive: true });
    const functionSelfTime = flattenProfile(profile);
    const browserSummary = summarizeBrowserStats(browserStats);
    const summary = {
      url,
      browserBin,
      seconds,
      capturedAt: new Date().toISOString(),
      gameReady,
      pageDiagnostics,
      browserDiagnostics,
      evilQuestSnapshot: evilQuestSnapshot?.ok ? evilQuestSnapshot.snapshot : evilQuestSnapshot,
      topFunctionSelfTime: functionSelfTime.slice(0, 100),
      browserSummary,
      performanceMetrics: perf.metrics || [],
    };
    await writeFile(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    await writeFile(join(runDir, 'page-diagnostics.json'), JSON.stringify(pageDiagnostics, null, 2));
    await writeFile(join(runDir, 'browser-diagnostics.json'), JSON.stringify(browserDiagnostics, null, 2));
    await writeFile(join(runDir, 'evilquest-snapshot.json'), JSON.stringify(evilQuestSnapshot, null, 2));
    await writeFile(join(runDir, 'cpu-profile.json'), JSON.stringify(profile, null, 2));
    await writeFile(join(runDir, 'browser-stats.json'), JSON.stringify(browserStats, null, 2));
    await writeFile(join(runDir, 'console.json'), JSON.stringify(browserLogs, null, 2));
    console.log(`Wrote ${runDir}`);
    console.log('Top function self-time:');
    for (const row of functionSelfTime.slice(0, 15)) {
      console.log(`${row.selfMs.toFixed(1).padStart(8)}ms  ${row.functionName}  ${row.url}:${row.line}:${row.column}`);
    }
    console.log('Slow callback totals:');
    for (const row of browserSummary.slowCallbacks.slice(0, 10)) {
      console.log(`${row.totalMs.toFixed(1).padStart(8)}ms total  ${row.maxMs.toFixed(1).padStart(6)}ms max  x${String(row.count).padEnd(4)} ${row.key}`);
    }
    if (evilQuestSnapshot?.ok) {
      printPageDiagnostics(pageDiagnostics);
      printEvilQuestSnapshot(evilQuestSnapshot.snapshot || {});
    }
    if (autorun) break;
  }
  try {
    await cdp.send('Browser.close');
  } catch {
    // Browser may already be gone if the user closed it manually.
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
