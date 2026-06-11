#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  areComparableDiagnosticScenes,
  browserFamilyFromDiagnosticPayload,
  classifyPerformanceDiagnostic,
  diagnosticFlagsFromPayload,
  diagnosticSceneComparisonText,
  finiteDiagnosticNumber,
  framePacingFromDiagnosticPayload,
  isPlayerChromiumBrowserFamily,
  isSoftwarePerformanceDiagnostic,
  measuredFpsFromDiagnosticPayload,
  rendererFromWebGlDiagnostics,
} from '../shared/performanceDiagnostics.ts';

function parseArgs(argv) {
  const options = {
    input: 'server/data/audit.log',
    limit: 20,
    event: '',
    user: '',
    query: '',
    json: false,
    bearerEnv: 'EVILQUEST_ADMIN_TOKEN',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--limit') {
      options.limit = Math.max(1, Math.trunc(Number(argv[++i] ?? options.limit)));
    } else if (arg === '--event') {
      options.event = String(argv[++i] ?? '').toLowerCase();
    } else if (arg === '--user') {
      options.user = String(argv[++i] ?? '').toLowerCase();
    } else if (arg === '--query' || arg === '-q') {
      options.query = String(argv[++i] ?? '').toLowerCase();
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--bearer-env') {
      options.bearerEnv = String(argv[++i] ?? '').trim();
    } else if (!arg.startsWith('--')) {
      options.input = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function finiteNumber(value) {
  return finiteDiagnosticNumber(value);
}

function formatRate(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? (value >= 100 ? Math.round(value).toLocaleString() : value.toFixed(1))
    : 'n/a';
}

function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value).toLocaleString()
    : 'n/a';
}

function clip(value, max = 110) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function isPlainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEntry(raw) {
  if (!isPlainRecord(raw)) return null;
  if (raw.type === 'client.log' && isPlainRecord(raw.details)) {
    const details = raw.details;
    return {
      ts: typeof raw.ts === 'string' ? raw.ts : '',
      tick: finiteNumber(raw.tick),
      event: String(details.event ?? 'unknown'),
      username: String(details.username ?? 'unknown'),
      clientAt: finiteNumber(details.clientAt),
      payload: isPlainRecord(details.payload) ? details.payload : {},
    };
  }
  if (typeof raw.event === 'string' && 'payload' in raw) {
    return {
      ts: typeof raw.ts === 'string' ? raw.ts : '',
      tick: finiteNumber(raw.tick),
      event: raw.event,
      username: String(raw.username ?? 'unknown'),
      clientAt: finiteNumber(raw.clientAt),
      payload: isPlainRecord(raw.payload) ? raw.payload : {},
    };
  }
  return null;
}

function extractEntriesFromJson(raw) {
  if (!isPlainRecord(raw)) return [];
  if (Array.isArray(raw.events)) return raw.events.map(normalizeEntry).filter(Boolean);
  const single = normalizeEntry(raw);
  if (single) return [single];
  if (isPlainRecord(raw.details)) {
    const fromAudit = normalizeEntry({ ...raw, type: raw.type ?? 'client.log' });
    if (fromAudit) return [fromAudit];
  }
  if (raw.measuredFps != null || raw.engineFps != null || raw.webgl || raw.framePacing) {
    return [{
      ts: '',
      tick: null,
      event: 'snapshot',
      username: 'snapshot',
      clientAt: null,
      payload: raw,
    }];
  }
  return [];
}

function isHttpInput(input) {
  return /^https?:\/\//i.test(input);
}

function diagnosticUrl(input, options) {
  const url = new URL(input);
  if (url.pathname.endsWith('/api/admin/client-diagnostics')) {
    if (!url.searchParams.has('limit')) url.searchParams.set('limit', String(options.limit));
    if (options.event && !url.searchParams.has('event')) url.searchParams.set('event', options.event);
    if (options.user && !url.searchParams.has('user') && !url.searchParams.has('username')) url.searchParams.set('user', options.user);
    if (options.query && !url.searchParams.has('q') && !url.searchParams.has('query')) url.searchParams.set('q', options.query);
  }
  return url;
}

async function readInputText(input, options) {
  if (input === '-') return readFile(0, 'utf8');
  if (!isHttpInput(input)) return readFile(resolve(input), 'utf8');

  const url = diagnosticUrl(input, options);
  const headers = { Accept: 'application/json' };
  const bearer = options.bearerEnv ? process.env[options.bearerEnv] : '';
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const authHint = bearer
      ? ''
      : ` Set ${options.bearerEnv}=<admin token> or pass --bearer-env NAME for admin endpoints.`;
    throw new Error(`HTTP ${response.status} for ${url}.${authHint}${body ? ` Body: ${body.slice(0, 300)}` : ''}`);
  }
  return response.text();
}

async function readEntries(input, options) {
  const text = await readInputText(input, options);
  try {
    const parsed = JSON.parse(text);
    const entries = extractEntriesFromJson(parsed);
    if (entries.length > 0) return entries;
  } catch {
    // Fall through to JSONL/audit-log parsing.
  }

  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const entry = normalizeEntry(parsed);
      if (entry) entries.push(entry);
    } catch {
      // Ignore non-JSON log lines.
    }
  }
  return entries;
}

function flags(entry) {
  return diagnosticFlagsFromPayload(entry.payload);
}

function webgl(entry) {
  return isPlainRecord(entry.payload?.webgl) ? entry.payload.webgl : {};
}

function browser(entry) {
  return isPlainRecord(entry.payload?.browser) ? entry.payload.browser : {};
}

function formatBattery(entry) {
  const raw = browser(entry).battery;
  if (!isPlainRecord(raw)) return 'battery n/a';
  const level = finiteNumber(raw.level);
  const levelText = level == null ? 'level n/a' : `${Math.round(level * 100)}%`;
  const charging = raw.charging === true ? 'charging' : raw.charging === false ? 'not charging' : 'charging n/a';
  return `${levelText} ${charging}`;
}

function formatConnection(entry) {
  const raw = browser(entry).connection;
  if (!isPlainRecord(raw)) return 'connection n/a';
  return [
    raw.effectiveType ? String(raw.effectiveType) : null,
    finiteNumber(raw.downlink) != null ? `${formatRate(finiteNumber(raw.downlink))}Mbps` : null,
    finiteNumber(raw.rtt) != null ? `${formatCount(finiteNumber(raw.rtt))}ms RTT` : null,
    raw.saveData === true ? 'save-data' : null,
  ].filter(Boolean).join(' ') || 'connection n/a';
}

function formatMedia(entry) {
  const raw = browser(entry).media;
  if (!isPlainRecord(raw)) return 'media n/a';
  const prefs = [
    raw.prefersReducedMotion === true ? 'reduced-motion' : null,
    raw.prefersReducedData === true ? 'reduced-data' : null,
    raw.prefersContrastMore === true ? 'contrast-more' : null,
    raw.forcedColors === true ? 'forced-colors' : null,
  ].filter(Boolean);
  return prefs.length > 0 ? prefs.join(', ') : 'media normal';
}

function framePacing(entry) {
  return framePacingFromDiagnosticPayload(entry.payload);
}

function measuredFps(entry) {
  return measuredFpsFromDiagnosticPayload(entry.payload);
}

function renderer(entry) {
  return rendererFromWebGlDiagnostics(webgl(entry));
}

function browserLabel(entry) {
  return browserFamilyFromDiagnosticPayload(entry.payload);
}

function isPlayerChromiumBrowser(label) {
  return isPlayerChromiumBrowserFamily(label);
}

function isLowFps(entry) {
  const fps = measuredFps(entry);
  return fps != null && fps < 55;
}

function isStableLowCadence(entry) {
  return classifyPerformanceDiagnostic(entry.payload) === 'stable-30';
}

function hasUnevenFramePacing(entry) {
  return classifyPerformanceDiagnostic(entry.payload) === 'stalls';
}

function classification(entry) {
  switch (classifyPerformanceDiagnostic(entry.payload)) {
    case 'software-low': return 'software renderer low FPS';
    case 'stable-30': return 'stable 30Hz cadence';
    case 'stalls': return 'uneven low-FPS stalls';
    case 'hardware-low': return 'hardware-backed low FPS';
    case 'low-fps': return 'low FPS';
    case 'healthy-high': return 'healthy high FPS';
    case 'healthy': return 'healthy';
    default: return 'unclear';
  }
}

function formatPacing(entry) {
  const pacing = framePacing(entry);
  if (!pacing) return 'n/a';
  return `med ${formatRate(pacing.medianMs)}ms p95 ${formatRate(pacing.p95Ms)}ms max ${formatRate(pacing.maxMs)}ms >33 ${formatCount(pacing.over33Ms)} >50 ${formatCount(pacing.over50Ms)}`;
}

function comparableScene(a, b) {
  return areComparableDiagnosticScenes(a.payload, b.payload);
}

function sceneComparisonText(a, b) {
  return diagnosticSceneComparisonText(a.payload, b.payload);
}

function browserGapFindings(entries, limit = 3) {
  const measured = entries
    .filter((entry) => measuredFps(entry) != null)
    .filter((entry) => isPlayerChromiumBrowser(browserLabel(entry)));
  const byUser = new Map();
  for (const entry of measured) {
    const key = entry.username || 'unknown';
    const items = byUser.get(key) ?? [];
    items.push(entry);
    byUser.set(key, items);
  }
  const findings = [];
  for (const userEntries of byUser.values()) {
    for (let i = 0; i < userEntries.length; i += 1) {
      for (let j = i + 1; j < userEntries.length; j += 1) {
        const a = userEntries[i];
        const b = userEntries[j];
        if (browserLabel(a) === browserLabel(b)) continue;
        const aFps = measuredFps(a);
        const bFps = measuredFps(b);
        if (aFps == null || bFps == null) continue;
        const high = aFps >= bFps ? a : b;
        const low = high === a ? b : a;
        const highFps = measuredFps(high);
        const lowFps = measuredFps(low);
        const ratio = highFps / Math.max(1, lowFps);
        const comparable = comparableScene(high, low);
        const sameUser = high.username === low.username && high.username !== 'unknown';
        const strong = sameUser && comparable && highFps >= 100 && lowFps < 55 && ratio >= 1.5;
        findings.push({ high, low, highFps, lowFps, ratio, comparable, sameUser, strong });
      }
    }
  }
  return findings
    .sort((a, b) => Number(b.strong) - Number(a.strong) || b.ratio - a.ratio)
    .slice(0, limit);
}

function renderBrowserGapVerdict(entries) {
  const findings = browserGapFindings(entries);
  const lines = ['Browser gap verdict'];
  if (findings.length === 0) {
    lines.push('- No cross-browser FPS pairs yet. Have the same tester run `/perf` in Chrome and Brave/Edge in the same place.');
    return lines;
  }

  const strong = findings.find((finding) => finding.strong);
  if (strong) {
    lines.push(`- Strong browser/runtime signal: ${browserLabel(strong.high)} ${formatRate(strong.highFps)} FPS vs ${browserLabel(strong.low)} ${formatRate(strong.lowFps)} FPS (${strong.ratio.toFixed(1)}x) in a comparable scene.`);
  } else {
    lines.push('- No strong healthy-vs-low browser split found in comparable snapshots yet.');
  }
  for (const finding of findings) {
    lines.push(`- ${browserLabel(finding.high)} ${formatRate(finding.highFps)} FPS vs ${browserLabel(finding.low)} ${formatRate(finding.lowFps)} FPS (${finding.ratio.toFixed(1)}x), sameUser=${finding.sameUser ? 'yes' : 'no'}, comparable=${finding.comparable ? 'yes' : 'no'}, ${sceneComparisonText(finding.high, finding.low)}`);
  }
  return lines;
}

function summarize(entries) {
  const counts = {
    total: entries.length,
    lowFps: entries.filter(isLowFps).length,
    brave: entries.filter((entry) => browserLabel(entry) === 'Brave').length,
    braveLow: entries.filter((entry) => browserLabel(entry) === 'Brave' && isLowFps(entry)).length,
    software: entries.filter((entry) => isSoftwarePerformanceDiagnostic(entry.payload)).length,
    softwareLow: entries.filter((entry) => isSoftwarePerformanceDiagnostic(entry.payload) && isLowFps(entry)).length,
    stable30: entries.filter(isStableLowCadence).length,
    uneven: entries.filter(hasUnevenFramePacing).length,
  };
  const byClass = new Map();
  const byBrowser = new Map();
  for (const entry of entries) {
    byClass.set(classification(entry), (byClass.get(classification(entry)) ?? 0) + 1);
    byBrowser.set(browserLabel(entry), (byBrowser.get(browserLabel(entry)) ?? 0) + 1);
  }
  return {
    counts,
    byClass: Object.fromEntries([...byClass.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    byBrowser: Object.fromEntries([...byBrowser.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    browserGaps: browserGapFindings(entries).map((finding) => ({
      highBrowser: browserLabel(finding.high),
      highFps: finding.highFps,
      lowBrowser: browserLabel(finding.low),
      lowFps: finding.lowFps,
      ratio: Math.round(finding.ratio * 10) / 10,
      comparable: finding.comparable,
      sameUser: finding.sameUser,
      strong: finding.strong,
      scene: sceneComparisonText(finding.high, finding.low),
    })),
  };
}

function passesFilters(entry, options) {
  if (options.event && entry.event.toLowerCase() !== options.event) return false;
  if (options.user && !entry.username.toLowerCase().includes(options.user)) return false;
  if (options.query) {
    const haystack = `${entry.event} ${entry.username} ${JSON.stringify(entry.payload)}`.toLowerCase();
    if (!haystack.includes(options.query)) return false;
  }
  return true;
}

function timestampMs(entry) {
  const parsed = Date.parse(entry.ts);
  return Number.isFinite(parsed) ? parsed : null;
}

function newestFirst(entries) {
  return entries
    .map((entry, index) => ({ entry, index, ts: timestampMs(entry) }))
    .sort((a, b) => {
      if (a.ts != null && b.ts != null && a.ts !== b.ts) return b.ts - a.ts;
      if (a.ts != null && b.ts == null) return -1;
      if (a.ts == null && b.ts != null) return 1;
      return b.index - a.index;
    })
    .map((row) => row.entry);
}

function renderText(input, entries, options) {
  const summary = summarize(entries);
  const lines = [];
  lines.push(`Client diagnostics summary: ${input}`);
  lines.push(`Entries: ${summary.counts.total}, low FPS: ${summary.counts.lowFps}, Brave low: ${summary.counts.braveLow}, software low: ${summary.counts.softwareLow}, stable 30: ${summary.counts.stable30}, stalls: ${summary.counts.uneven}`);
  lines.push(`Browsers: ${Object.entries(summary.byBrowser).map(([name, count]) => `${name}=${count}`).join(', ') || 'none'}`);
  lines.push(`Classes: ${Object.entries(summary.byClass).map(([name, count]) => `${name}=${count}`).join(', ') || 'none'}`);
  lines.push('');
  lines.push(...renderBrowserGapVerdict(entries));
  lines.push('');
  lines.push(`Latest ${Math.min(options.limit, entries.length)} entries`);

  for (const entry of entries.slice(0, options.limit)) {
    const fps = measuredFps(entry);
    const canvas = isPlainRecord(entry.payload?.canvas) ? entry.payload.canvas : {};
    const canvasText = canvas.width != null && canvas.height != null
      ? `${formatCount(canvas.width)}x${formatCount(canvas.height)} DPR ${formatRate(canvas.devicePixelRatio)}`
      : 'canvas n/a';
    const sceneText = [
      `${formatCount(finiteNumber(entry.payload?.activeMeshes))} meshes`,
      `${formatCount(finiteNumber(entry.payload?.totalVertices))} vertices`,
    ].join(', ');
    lines.push(`- ${entry.ts || 'unknown time'} ${entry.event} user=${entry.username} browser=${browserLabel(entry)} fps=${formatRate(fps)} class=${classification(entry)}`);
    lines.push(`  frame=${formatPacing(entry)} flags=${flags(entry).join(', ') || 'none'}`);
    lines.push(`  renderer=${clip(renderer(entry))}`);
    lines.push(`  browserState=${formatBattery(entry)}; ${formatConnection(entry)}; ${formatMedia(entry)}`);
    lines.push(`  ${canvasText}; ${sceneText}; map=${entry.payload?.currentMap ?? 'n/a'} player=${isPlainRecord(entry.payload?.player) ? `${entry.payload.player.x ?? '?'},${entry.payload.player.z ?? '?'}` : 'n/a'}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const allEntries = await readEntries(options.input, options);
  const entries = newestFirst(allEntries.filter((entry) => passesFilters(entry, options)));
  const output = options.json
    ? JSON.stringify({ input: options.input, ...summarize(entries), entries: entries.slice(0, options.limit) }, null, 2)
    : renderText(options.input, entries, options);
  console.log(output);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
