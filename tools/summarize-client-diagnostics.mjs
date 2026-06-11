#!/usr/bin/env bun
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SOFTWARE_RENDERER_PATTERNS = [
  'swiftshader',
  'llvmpipe',
  'software rasterizer',
  'software renderer',
  'microsoft basic render',
  'basic render driver',
  'warp',
  'mesa offscreen',
];

function parseArgs(argv) {
  const options = {
    input: 'server/data/audit.log',
    limit: 20,
    event: '',
    user: '',
    query: '',
    json: false,
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
    } else if (!arg.startsWith('--')) {
      options.input = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

async function readEntries(input) {
  const file = resolve(input);
  const text = await readFile(file, 'utf8');
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
  const raw = entry.payload?.diagnosticFlags;
  return Array.isArray(raw) ? raw.filter((flag) => typeof flag === 'string') : [];
}

function webgl(entry) {
  return isPlainRecord(entry.payload?.webgl) ? entry.payload.webgl : {};
}

function browser(entry) {
  return isPlainRecord(entry.payload?.browser) ? entry.payload.browser : {};
}

function framePacing(entry) {
  return isPlainRecord(entry.payload?.framePacing) ? entry.payload.framePacing : null;
}

function measuredFps(entry) {
  return finiteNumber(entry.payload?.measuredFps)
    ?? finiteNumber(entry.payload?.fps)
    ?? finiteNumber(entry.payload?.engineFps);
}

function renderer(entry) {
  const info = webgl(entry);
  return String(info.unmaskedRenderer ?? info.renderer ?? 'unknown');
}

function softwareRenderer(entry) {
  if (flags(entry).includes('software-renderer-likely')) return true;
  const info = webgl(entry);
  const text = [
    info.unmaskedRenderer,
    info.renderer,
    info.unmaskedVendor,
    info.vendor,
  ].filter(Boolean).join(' ').toLowerCase();
  return SOFTWARE_RENDERER_PATTERNS.some((pattern) => text.includes(pattern));
}

function browserLabel(entry) {
  const info = browser(entry);
  if (info.brave === true || flags(entry).includes('brave-browser')) return 'Brave';
  const ua = String(info.userAgent ?? '');
  if (ua.includes('Edg/')) return 'Edge';
  if (ua.includes('HeadlessChrome/')) return 'HeadlessChrome';
  if (ua.includes('Chrome/')) return 'Chrome';
  const brands = isPlainRecord(info.userAgentData) && Array.isArray(info.userAgentData.brands)
    ? info.userAgentData.brands.map((brand) => isPlainRecord(brand) ? brand.brand : '').filter(Boolean)
    : [];
  return brands.length > 0 ? brands.join(', ') : String(info.platform ?? 'unknown');
}

function isLowFps(entry) {
  const fps = measuredFps(entry);
  return fps != null && fps < 55;
}

function isStableLowCadence(entry) {
  const fps = measuredFps(entry);
  const pacing = framePacing(entry);
  const median = finiteNumber(pacing?.medianMs);
  const p95 = finiteNumber(pacing?.p95Ms);
  const stddev = finiteNumber(pacing?.stddevMs);
  return fps != null
    && fps >= 27
    && fps <= 36
    && median != null
    && median >= 27
    && median <= 38
    && p95 != null
    && p95 <= 42
    && stddev != null
    && stddev <= 5;
}

function hasUnevenFramePacing(entry) {
  const pacing = framePacing(entry);
  const p95 = finiteNumber(pacing?.p95Ms);
  const max = finiteNumber(pacing?.maxMs);
  const stddev = finiteNumber(pacing?.stddevMs);
  const over50 = finiteNumber(pacing?.over50Ms);
  return (p95 != null && p95 >= 50)
    || (max != null && max >= 100)
    || (stddev != null && stddev >= 12)
    || (over50 != null && over50 >= 3);
}

function classification(entry) {
  if (softwareRenderer(entry) && isLowFps(entry)) return 'software renderer low FPS';
  if (isStableLowCadence(entry)) return 'stable 30Hz cadence';
  if (hasUnevenFramePacing(entry) && isLowFps(entry)) return 'uneven low-FPS stalls';
  if (flags(entry).includes('brave-low-fps') || flags(entry).includes('low-fps-with-hardware-renderer')) return 'hardware-backed low FPS';
  if (isLowFps(entry)) return 'low FPS';
  const fps = measuredFps(entry);
  if (fps != null && fps >= 100) return 'healthy high FPS';
  return 'unclear';
}

function formatPacing(entry) {
  const pacing = framePacing(entry);
  if (!pacing) return 'n/a';
  return `med ${formatRate(pacing.medianMs)}ms p95 ${formatRate(pacing.p95Ms)}ms max ${formatRate(pacing.maxMs)}ms >33 ${formatCount(pacing.over33Ms)} >50 ${formatCount(pacing.over50Ms)}`;
}

function summarize(entries) {
  const counts = {
    total: entries.length,
    lowFps: entries.filter(isLowFps).length,
    brave: entries.filter((entry) => browserLabel(entry) === 'Brave').length,
    braveLow: entries.filter((entry) => browserLabel(entry) === 'Brave' && isLowFps(entry)).length,
    software: entries.filter(softwareRenderer).length,
    softwareLow: entries.filter((entry) => softwareRenderer(entry) && isLowFps(entry)).length,
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
    lines.push(`  ${canvasText}; ${sceneText}; map=${entry.payload?.currentMap ?? 'n/a'} player=${isPlainRecord(entry.payload?.player) ? `${entry.payload.player.x ?? '?'},${entry.payload.player.z ?? '?'}` : 'n/a'}`);
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const allEntries = await readEntries(options.input);
  const entries = newestFirst(allEntries.filter((entry) => passesFilters(entry, options)));
  const output = options.json
    ? JSON.stringify({ input: options.input, ...summarize(entries), entries: entries.slice(0, options.limit) }, null, 2)
    : renderText(options.input, entries, options);
  console.log(output);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
