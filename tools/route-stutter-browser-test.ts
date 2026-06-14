import { Database } from 'bun:sqlite';
import { chromium, firefox, webkit, type BrowserContext, type BrowserType, type ConsoleMessage } from 'playwright';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

interface BrowserRunConfig {
  name: string;
  engine: BrowserEngine;
  executablePath?: string;
  args?: string[];
  env?: Record<string, string>;
  profileSource?: string;
}

interface FrameSpikePayload {
  rafGapMs?: number;
  updateMs?: number;
  renderMs?: number;
  outsideMeasuredFrameMs?: number;
  gpuFrameMs?: number | null;
  currentMap?: string;
  currentFloor?: number;
  player?: { x?: number; z?: number };
  longTasks?: Array<{ durationMs?: number }>;
  topSlices?: Array<{ label?: string; ms?: number }>;
}

interface BrowserRunResult {
  name: string;
  ok: boolean;
  username: string;
  error?: string;
  durationMs: number;
  spikeCount: number;
  spikes: FrameSpikePayload[];
  summary: Record<string, number | null>;
  finalDiagnostics?: Record<string, unknown>;
}

const BASE_URL = process.env.EQ_BASE_URL ?? 'http://localhost:4000';
const DB_PATH = process.env.EQ_DB_PATH ?? 'projectrs.db';
const REPORT_DIR = process.env.EQ_REPORT_DIR ?? 'tmp/route-stutter-browser-tests';
const KEEP_PROFILES = process.env.EQ_KEEP_PROFILES === '1';
const ROUTE_START = parsePoint(process.env.EQ_ROUTE_START, { x: 78.5, z: 20.5 });
const ROUTE = parseRoute(process.env.EQ_ROUTE, [
  { x: 78.5, z: 50.5 },
  { x: 77.5, z: 32.5 },
  { x: 78.5, z: 20.5 },
]);
const FRAME_PACE = parseFramePace(process.env.EQ_FRAME_PACE);
const RUNS = parseRuns(process.env.EQ_BROWSER_RUNS);

function parsePoint(raw: string | undefined, fallback: { x: number; z: number }): { x: number; z: number } {
  if (!raw) return fallback;
  const [x, z] = raw.split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : fallback;
}

function parseRoute(raw: string | undefined, fallback: Array<{ x: number; z: number }>): Array<{ x: number; z: number }> {
  if (!raw) return fallback;
  const route = raw.split(';')
    .map(part => parsePoint(part, { x: Number.NaN, z: Number.NaN }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.z));
  return route.length > 0 ? route : fallback;
}

function parseFramePace(raw: string | undefined): 'smooth' | 'battery' | null {
  if (raw === 'smooth' || raw === 'battery') return raw;
  return null;
}

function parseRuns(raw: string | undefined): BrowserRunConfig[] {
  const all: BrowserRunConfig[] = [
    {
      name: 'chrome-stable-wayland-clean',
      engine: 'chromium',
      executablePath: '/opt/google/chrome/chrome',
      args: ['--ozone-platform=wayland', '--disable-extensions', '--disable-sync'],
    },
    {
      name: 'chrome-stable-x11-clean',
      engine: 'chromium',
      executablePath: '/opt/google/chrome/chrome',
      args: ['--ozone-platform=x11', '--disable-extensions', '--disable-sync'],
    },
    {
      name: 'snap-chromium-wayland-clean',
      engine: 'chromium',
      executablePath: '/snap/bin/chromium',
      args: ['--ozone-platform=wayland', '--disable-extensions', '--disable-sync'],
    },
    {
      name: 'brave-local-wayland-clean',
      engine: 'chromium',
      executablePath: process.env.EQ_BRAVE_EXECUTABLE ?? 'tmp/browsers/brave/opt/brave.com/brave/brave',
      args: ['--ozone-platform=wayland', '--disable-extensions', '--disable-sync'],
    },
    {
      name: 'brave-local-x11-clean',
      engine: 'chromium',
      executablePath: process.env.EQ_BRAVE_EXECUTABLE ?? 'tmp/browsers/brave/opt/brave.com/brave/brave',
      args: ['--ozone-platform=x11', '--disable-extensions', '--disable-sync'],
    },
    {
      name: 'chrome-stable-wayland-adnauseam-clean',
      engine: 'chromium',
      executablePath: '/opt/google/chrome/chrome',
      args: ['--ozone-platform=wayland', '--load-extension=/home/nick/.local/share/adnauseam/adnauseam.chromium', '--disable-sync'],
    },
    {
      name: 'chrome-normal-copy-wayland',
      engine: 'chromium',
      executablePath: '/opt/google/chrome/chrome',
      profileSource: '/home/nick/.config/google-chrome',
      args: ['--ozone-platform=wayland'],
    },
    {
      name: 'chrome-normal-copy-adnauseam-wayland',
      engine: 'chromium',
      executablePath: '/opt/google/chrome/chrome',
      profileSource: '/home/nick/.config/google-chrome',
      args: ['--ozone-platform=wayland', '--load-extension=/home/nick/.local/share/adnauseam/adnauseam.chromium'],
    },
    {
      name: 'playwright-firefox-clean',
      engine: 'firefox',
      env: {
        MOZ_DISABLE_CONTENT_SANDBOX: '1',
        MOZ_DISABLE_RDD_SANDBOX: '1',
        MOZ_DISABLE_GMP_SANDBOX: '1',
        MOZ_ENABLE_WAYLAND: '1',
      },
    },
    {
      name: 'playwright-webkit-clean',
      engine: 'webkit',
    },
  ];
  const defaultRunNames = new Set([
    'chrome-stable-wayland-clean',
    'chrome-stable-x11-clean',
    'chrome-stable-wayland-adnauseam-clean',
  ]);
  if (!raw || raw.trim() === '') return all.filter(run => defaultRunNames.has(run.name));
  if (raw.trim() === 'all') return all;
  const wanted = new Set(raw.split(',').map(part => part.trim()).filter(Boolean));
  return all.filter(run => wanted.has(run.name));
}

function copyProfileSource(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const result = spawnSync('rsync', [
    '-a',
    '--delete',
    '--exclude=Singleton*',
    '--exclude=BrowserMetrics*',
    '--exclude=Crash Reports',
    '--exclude=ShaderCache',
    '--exclude=GrShaderCache',
    '--exclude=GraphiteDawnCache',
    '--exclude=*/Cache',
    '--exclude=*/CacheStorage',
    '--exclude=*/Code Cache',
    '--exclude=*/GPUCache',
    '--exclude=*/DawnCache',
    '--exclude=*/DawnGraphiteCache',
    `${source.replace(/\/$/, '')}/`,
    `${destination.replace(/\/$/, '')}/`,
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`rsync profile copy failed with status ${result.status}`);
}

function browserTypeFor(engine: BrowserEngine): BrowserType {
  if (engine === 'firefox') return firefox;
  if (engine === 'webkit') return webkit;
  return chromium;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function min(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number(Math.min(...values).toFixed(2));
}

function max(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number(Math.max(...values).toFixed(2));
}

function numericField(spikes: FrameSpikePayload[], key: keyof FrameSpikePayload): number[] {
  return spikes
    .map(spike => spike[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function summarize(spikes: FrameSpikePayload[]): Record<string, number | null> {
  const gap = numericField(spikes, 'rafGapMs');
  const update = numericField(spikes, 'updateMs');
  const render = numericField(spikes, 'renderMs');
  const outside = numericField(spikes, 'outsideMeasuredFrameMs');
  const gpu = numericField(spikes, 'gpuFrameMs');
  return {
    rafGapAvg: mean(gap),
    rafGapMin: min(gap),
    rafGapMax: max(gap),
    updateAvg: mean(update),
    renderAvg: mean(render),
    outsideAvg: mean(outside),
    gpuAvg: mean(gpu),
  };
}

function cookieValue(setCookie: string | null, name: string): string {
  if (!setCookie) return '';
  const prefix = `${name}=`;
  const part = setCookie.split(/,(?=[^;,]+=)/).find(cookie => cookie.trim().startsWith(prefix));
  if (!part) return '';
  const value = part.trim().slice(prefix.length).split(';', 1)[0] ?? '';
  return decodeURIComponent(value);
}

async function createBrowserAccount(context: BrowserContext, username: string, password: string): Promise<void> {
  const deviceResponse = await fetch(`${BASE_URL}/api/device-id`, {
    method: 'GET',
    headers: { Origin: BASE_URL },
  });
  const devicePayload = await deviceResponse.json() as { ok?: boolean; deviceId?: string; error?: string };
  if (!devicePayload.ok || !devicePayload.deviceId) {
    throw new Error(`device-id failed: ${devicePayload.error ?? deviceResponse.status}`);
  }
  const deviceCookie = cookieValue(deviceResponse.headers.get('set-cookie'), 'eq_device_id') || devicePayload.deviceId;

  const signupResponse = await fetch(`${BASE_URL}/api/signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `eq_device_id=${encodeURIComponent(deviceCookie)}`,
      Origin: BASE_URL,
    },
    body: JSON.stringify({ username, password, deviceId: devicePayload.deviceId }),
  });
  const signupPayload = await signupResponse.json() as { ok?: boolean; token?: string; username?: string; error?: string };
  if (!signupPayload.ok || !signupPayload.token) {
    throw new Error(`signup failed: ${signupPayload.error ?? signupResponse.status}`);
  }
  const wsCookie = cookieValue(signupResponse.headers.get('set-cookie'), 'eq_ws_session');
  if (!wsCookie) throw new Error('signup did not return websocket session cookie');

  const db = new Database(DB_PATH);
  try {
    const account = db.query('SELECT id FROM accounts WHERE username = ?').get(username) as { id: number } | null;
    if (!account) throw new Error(`created account not found for ${username}`);
    const respawnVersionRow = db.query('SELECT MAX(respawn_version) AS version FROM player_state')
      .get() as { version: number | null } | null;
    const respawnVersion = Math.max(0, Math.floor(respawnVersionRow?.version ?? 0));
    db.query(`
      UPDATE player_state
      SET x = ?, z = ?, y = 0, floor = 0, map_level = 'kcmap', respawn_version = ?, updated_at = unixepoch()
      WHERE account_id = ?
    `).run(ROUTE_START.x, ROUTE_START.z, respawnVersion, account.id);
  } finally {
    db.close();
  }

  const origin = new URL(BASE_URL);
  await context.addCookies([
    {
      name: 'eq_device_id',
      value: deviceCookie,
      url: origin.origin,
      httpOnly: true,
      sameSite: 'Strict',
      secure: origin.protocol === 'https:',
    },
    {
      name: 'eq_ws_session',
      value: wsCookie,
      url: origin.origin,
      httpOnly: true,
      sameSite: 'Strict',
      secure: origin.protocol === 'https:',
    },
  ]);

  await context.addInitScript(({ token, signedInUsername, deviceId, framePace }) => {
    localStorage.setItem('evilquest_token', token);
    localStorage.setItem('evilquest_username', signedInUsername);
    localStorage.setItem('evilmud_device_id', deviceId);
    if (framePace) {
      localStorage.setItem('projectrs_game_settings_v1', JSON.stringify({
        groundItemLabels: 'off',
        nameplates: 'all',
        tooltips: 'on',
        framePace,
      }));
    }
  }, { token: signupPayload.token, signedInUsername: signupPayload.username ?? username, deviceId: devicePayload.deviceId, framePace: FRAME_PACE });
}

async function payloadFromConsole(message: ConsoleMessage): Promise<FrameSpikePayload | null> {
  if (!message.text().startsWith('[frame-spike]')) return null;
  const arg = message.args()[1];
  if (!arg) return null;
  try {
    return await arg.jsonValue() as FrameSpikePayload;
  } catch {
    return null;
  }
}

async function runBrowserTest(config: BrowserRunConfig, index: number): Promise<BrowserRunResult> {
  const startedAt = Date.now();
  const userDataDir = join(REPORT_DIR, `profile-${config.name}`);
  if (config.profileSource) {
    copyProfileSource(config.profileSource, userDataDir);
  } else {
    rmSync(userDataDir, { recursive: true, force: true });
    mkdirSync(userDataDir, { recursive: true });
  }

  const username = `auto${Date.now().toString(36).slice(-7)}${index}`;
  const password = `Autowalk-${Date.now()}-${index}`;
  const spikes: FrameSpikePayload[] = [];
  let context: BrowserContext | null = null;

  try {
    context = await browserTypeFor(config.engine).launchPersistentContext(userDataDir, {
      executablePath: config.executablePath,
      headless: false,
      viewport: { width: 1280, height: 720 },
      timeout: 60_000,
      env: config.env ? { ...process.env, ...config.env } : undefined,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        ...(config.args ?? []),
      ],
    });
    context.setDefaultTimeout(60_000);

    await createBrowserAccount(context, username, password);

    const page = context.pages()[0] ?? await context.newPage();
    page.on('console', (message) => {
      void payloadFromConsole(message).then(payload => {
        if (payload) spikes.push(payload);
      });
    });

    await page.goto(`${BASE_URL}/play?autowalk=1&framestats=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => window.__evilQuestAutoWalk?.ready() === true, null, { timeout: 150_000 });
    await page.waitForTimeout(3_000);
    spikes.length = 0;

    for (const point of ROUTE) {
      const started = await page.evaluate(({ x, z }) => window.__evilQuestAutoWalk?.walkTo(x, z) === true, point);
      if (!started) throw new Error(`autowalk failed to start waypoint ${point.x},${point.z}`);
      await page.waitForFunction(({ x, z }) => {
        const state = window.__evilQuestAutoWalk?.state();
        if (!state || state.moving) return false;
        return Math.max(Math.abs(state.x - x), Math.abs(state.z - z)) <= 0.08;
      }, point, { timeout: 90_000 });
      await page.waitForTimeout(900);
    }
    await page.waitForTimeout(2_000);
    const finalDiagnostics = await page.evaluate(() => {
      const gm = window.gm as unknown as {
        engine?: { getFps?: () => number };
        framePaceMode?: unknown;
        framePaceEstimatedHz?: unknown;
        framePaceTargetIntervalMs?: unknown;
        pacedSceneRenderCount?: unknown;
        pacedSceneSkippedCount?: unknown;
        renderHardwareScalingLevel?: unknown;
      } | undefined;
      const targetInterval = typeof gm?.framePaceTargetIntervalMs === 'number' ? gm.framePaceTargetIntervalMs : null;
      return {
        engineFps: typeof gm?.engine?.getFps === 'function' ? Math.round(gm.engine.getFps() * 10) / 10 : null,
        framePaceMode: gm?.framePaceMode ?? null,
        estimatedDisplayHz: typeof gm?.framePaceEstimatedHz === 'number' ? Math.round(gm.framePaceEstimatedHz * 10) / 10 : null,
        targetRenderFps: targetInterval ? Math.round((1000 / targetInterval) * 10) / 10 : null,
        renderCount: typeof gm?.pacedSceneRenderCount === 'number' ? gm.pacedSceneRenderCount : null,
        skippedRenderCount: typeof gm?.pacedSceneSkippedCount === 'number' ? gm.pacedSceneSkippedCount : null,
        renderScale: typeof gm?.renderHardwareScalingLevel === 'number' ? gm.renderHardwareScalingLevel : null,
      };
    });

    return {
      name: config.name,
      ok: true,
      username,
      durationMs: Date.now() - startedAt,
      spikeCount: spikes.length,
      spikes,
      summary: summarize(spikes),
      finalDiagnostics,
    };
  } catch (err) {
    return {
      name: config.name,
      ok: false,
      username,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
      spikeCount: spikes.length,
      spikes,
      summary: summarize(spikes),
    };
  } finally {
    await context?.close().catch(() => {});
    if (!KEEP_PROFILES) rmSync(userDataDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  mkdirSync(REPORT_DIR, { recursive: true });
  const results: BrowserRunResult[] = [];
  for (let i = 0; i < RUNS.length; i++) {
    const config = RUNS[i];
    console.log(`\n[route-test] ${config.name}`);
    const result = await runBrowserTest(config, i);
    results.push(result);
    console.log(JSON.stringify({
      name: result.name,
      ok: result.ok,
      spikeCount: result.spikeCount,
      summary: result.summary,
      error: result.error,
    }, null, 2));
  }

  const report = {
    createdAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    framePace: FRAME_PACE,
    routeStart: ROUTE_START,
    route: ROUTE,
    results,
  };
  const reportPath = join(REPORT_DIR, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\n[route-test] report ${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
