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
const evilQuestSnapshotMs = Number(process.env.PROFILE_EVILQUEST_SNAPSHOT_MS || 3000);
const gameReadyTimeoutMs = Number(process.env.PROFILE_GAME_READY_TIMEOUT_MS || 45000);
const extraBrowserArgs = (process.env.PROFILE_BROWSER_ARGS || '').split(/\s+/).filter(Boolean);
const authToken = process.env.PROFILE_AUTH_TOKEN || '';
const authUsername = process.env.PROFILE_AUTH_USERNAME || '';
const wsSecret = process.env.PROFILE_WS_SECRET || '';
const deviceId = process.env.PROFILE_DEVICE_ID || '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readCommand(prompt) {
  output.write(prompt);
  input.resume();
  return new Promise((resolve) => {
    input.once('data', (data) => resolve(String(data).trim().toLowerCase()));
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
      await cdpJson('/json/version');
      return;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`Chrome DevTools endpoint did not appear on port ${port}`);
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
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}: ${msg.error.data || ''}`));
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
      this.pending.set(id, { resolve, reject });
    });
  }

  on(method, handler) {
    const list = this.handlers.get(method) || [];
    list.push(handler);
    this.handlers.set(method, list);
  }
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
    WebSocket: window.WebSocket,
  };
  const stats = window.__evilQuestProfiler = {
    callbacks: [],
    resources: [],
    longTasks: [],
    websockets: [],
    fetches: [],
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
    errors: stats.errors || [],
  };
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
          && typeof gm.collectPerformanceSnapshot === 'function'
          && typeof gm.sampleRafFps === 'function'
          && document.visibilityState === 'visible';
        if (ready) {
          resolve({ ok: true, waitedMs: Math.round(performance.now() - startedAt), username: gm.username || '' });
          return;
        }
        if (performance.now() - startedAt >= ${Math.max(1000, Math.round(timeoutMs))}) {
          resolve({
            ok: false,
            waitedMs: Math.round(performance.now() - startedAt),
            hasGameManager: !!gm,
            loginSettled: gm?._loginSettled ?? null,
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

async function captureEvilQuestPerformanceSnapshot(cdp, durationMs) {
  return evaluateJson(cdp, `
    (async () => {
      const gm = window.gm;
      if (!gm || typeof gm.collectPerformanceSnapshot !== 'function') {
        return { ok: false, error: 'window.gm.collectPerformanceSnapshot unavailable' };
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
  const targets = await cdpJson('/json/list');
  const pageTarget = targets.find((target) => target.type === 'page') || targets[0];
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
  await cdp.send('Runtime.setAsyncCallStackDepth', { maxDepth: 32 });
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
  else console.log(`Type "go" then Enter to reload and record ${seconds}s, or "quit" to exit.`);

  while (true) {
    const answer = autorun ? 'go' : await readCommand('profiler> ');
    if (answer === 'quit' || answer === 'exit') break;
    if (answer !== 'go') continue;

    browserLogs.length = 0;
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
    await cdp.send('Profiler.start');
    await cdp.send('Performance.enable');
    await cdp.send('Page.reload', { ignoreCache: true });
    console.log(`Recording ${seconds}s...`);
    const gameReady = captureEvilQuestSnapshot
      ? await waitForEvilQuestGame(cdp, gameReadyTimeoutMs)
      : { ok: false, skipped: true };
    if (captureEvilQuestSnapshot && !gameReady?.ok) {
      console.log(`[evilquest-profiler] Game snapshot wait did not finish: ${JSON.stringify(gameReady)}`);
    }
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
      evilQuestSnapshot: evilQuestSnapshot?.ok ? evilQuestSnapshot.snapshot : evilQuestSnapshot,
      topFunctionSelfTime: functionSelfTime.slice(0, 100),
      browserSummary,
      performanceMetrics: perf.metrics || [],
    };
    await writeFile(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
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
      const snapshot = evilQuestSnapshot.snapshot || {};
      const flags = Array.isArray(snapshot.diagnosticFlags) ? snapshot.diagnosticFlags.join(', ') : 'none';
      const renderer = snapshot.webgl?.unmaskedRenderer || snapshot.webgl?.renderer || 'unknown';
      console.log('EvilQuest snapshot:');
      console.log(`  ${snapshot.measuredFps ?? 'n/a'} FPS, ${snapshot.activeMeshes ?? 'n/a'} active meshes, ${snapshot.totalVertices ?? 'n/a'} vertices`);
      console.log(`  Renderer: ${renderer}`);
      console.log(`  Flags: ${flags}`);
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
