import { SERVER_PORT, GAME_WS_PATH, CHAT_WS_PATH, CHUNK_SIZE } from '@projectrs/shared';
import { resolve, dirname, sep } from 'path';
import { statSync, readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync, cpSync, renameSync, realpathSync } from 'fs';
import type { KCMapFile, KCMapData, KCTile, MapMeta, WallsFile, SpawnsFile, PlacedObject, BiomesFile } from '@projectrs/shared';
import { defaultKCTile } from '@projectrs/shared';
import { World } from './World';

// --- Chunked object storage helpers ---

/** Split placed objects into per-chunk buckets keyed by "chunk_{cx}_{cz}" */
function splitObjectsByChunk(objects: PlacedObject[]): Map<string, PlacedObject[]> {
  const chunks = new Map<string, PlacedObject[]>();
  for (const obj of objects) {
    if (obj.position.x == null || obj.position.z == null || isNaN(obj.position.x) || isNaN(obj.position.z)) continue;
    const cx = Math.floor(obj.position.x / CHUNK_SIZE);
    const cz = Math.floor(obj.position.z / CHUNK_SIZE);
    const key = `chunk_${cx}_${cz}`;
    let arr = chunks.get(key);
    if (!arr) { arr = []; chunks.set(key, arr); }
    arr.push(obj);
  }
  return chunks;
}

/** Save placed objects as per-chunk JSON files, removing chunks that are now empty */
function saveChunkedObjects(mapDir: string, objects: PlacedObject[]): void {
  const objectsDir = resolve(mapDir, 'objects');
  mkdirSync(objectsDir, { recursive: true });

  // Track which chunk files we write so we can delete stale ones
  const written = new Set<string>();
  const chunks = splitObjectsByChunk(objects);
  for (const [key, objs] of chunks) {
    const filePath = resolve(objectsDir, `${key}.json`);
    writeFileSync(filePath, JSON.stringify(objs, null, 2));
    written.add(`${key}.json`);
  }

  // Remove chunk files that no longer have objects
  try {
    for (const file of readdirSync(objectsDir)) {
      if (file.startsWith('chunk_') && file.endsWith('.json') && !written.has(file)) {
        rmSync(resolve(objectsDir, file));
      }
    }
  } catch { /* dir may not exist yet */ }
}

/** Load placed objects from per-chunk files, falling back to map.json for backwards compat */
function loadChunkedObjects(mapDir: string): PlacedObject[] | null {
  const objectsDir = resolve(mapDir, 'objects');
  if (!existsSync(objectsDir)) return null;
  const objects: PlacedObject[] = [];
  try {
    for (const file of readdirSync(objectsDir)) {
      if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
      const chunk: PlacedObject[] = JSON.parse(readFileSync(resolve(objectsDir, file), 'utf-8'));
      objects.push(...chunk);
    }
  } catch { return null; }
  return objects.length > 0 ? objects : null;
}

// --- Backup helper ---

/** Copy the current map dir into backups/{timestamp}/ and prune to maxKeep snapshots.
 *  Excludes the backups/ subdir itself. Any error is logged and swallowed. */
function createMapBackup(mapDir: string, maxKeep: number = 20): void {
  try {
    if (!existsSync(mapDir)) return;
    const backupsRoot = resolve(mapDir, 'backups');
    mkdirSync(backupsRoot, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = resolve(backupsRoot, ts);

    // Copy each non-'backups' entry from the map dir into the snapshot
    for (const entry of readdirSync(mapDir)) {
      if (entry === 'backups') continue;
      cpSync(resolve(mapDir, entry), resolve(dest, entry), { recursive: true });
    }

    // Rotate: keep the N newest snapshots, delete the rest
    const snapshots = readdirSync(backupsRoot)
      .filter((n) => n !== '.' && n !== '..')
      .map((n) => ({ n, path: resolve(backupsRoot, n) }))
      .filter((e) => { try { return statSync(e.path).isDirectory(); } catch { return false; } })
      .sort((a, b) => a.n.localeCompare(b.n)); // ISO timestamps sort lexicographically
    const toDelete = snapshots.slice(0, Math.max(0, snapshots.length - maxKeep));
    for (const s of toDelete) {
      try { rmSync(s.path, { recursive: true, force: true }); } catch {}
    }
  } catch (err) {
    console.warn('[save-map] backup failed:', (err as Error)?.message);
  }
}

// --- Chunked tile/height storage helpers ---

const EDITOR_CHUNK_SIZE = 64;

/** Default tile values for stripping unchanged fields */
const TILE_DEFAULTS: Record<string, any> = {
  ground: 'grass',
  groundB: null,
  split: 'forward',
  textureId: null,
  textureRotation: 0,
  textureScale: 1,
  textureWorldUV: false,
  textureHalfMode: false,
  textureIdB: null,
  textureRotationB: 0,
  textureScaleB: 1,
  waterPainted: false,
  waterSurface: false,
};

/** Strip default fields from a tile, returning only non-default values */
function stripTileDefaults(tile: KCTile): Partial<KCTile> | null {
  const stripped: Partial<KCTile> = {};
  let hasNonDefault = false;
  for (const key of Object.keys(TILE_DEFAULTS) as (keyof KCTile)[]) {
    if (tile[key] !== TILE_DEFAULTS[key]) {
      (stripped as Record<string, unknown>)[key] = tile[key];
      hasNonDefault = true;
    }
  }
  return hasNonDefault ? stripped : null;
}

/** Expand a partial tile back to a full KCTile */
function expandTile(partial: Partial<KCTile>): KCTile {
  return { ...defaultKCTile(), ...partial };
}

/** Save tiles as per-chunk JSON files */
function saveChunkedTiles(mapDir: string, tiles: KCTile[][], width: number, height: number): void {
  const tilesDir = resolve(mapDir, 'tiles');
  mkdirSync(tilesDir, { recursive: true });

  const chunksX = Math.ceil(width / EDITOR_CHUNK_SIZE);
  const chunksZ = Math.ceil(height / EDITOR_CHUNK_SIZE);
  const written = new Set<string>();

  for (let cz = 0; cz < chunksZ; cz++) {
    for (let cx = 0; cx < chunksX; cx++) {
      const chunkData: Record<string, Partial<KCTile>> = {};
      const startZ = cz * EDITOR_CHUNK_SIZE;
      const startX = cx * EDITOR_CHUNK_SIZE;
      const endZ = Math.min(startZ + EDITOR_CHUNK_SIZE, height);
      const endX = Math.min(startX + EDITOR_CHUNK_SIZE, width);

      for (let z = startZ; z < endZ; z++) {
        for (let x = startX; x < endX; x++) {
          const tile = tiles[z]?.[x];
          if (!tile) continue;
          const stripped = stripTileDefaults(tile);
          if (stripped) {
            const localZ = z - startZ;
            const localX = x - startX;
            chunkData[`${localZ},${localX}`] = stripped;
          }
        }
      }

      if (Object.keys(chunkData).length > 0) {
        const filename = `chunk_${cx}_${cz}.json`;
        writeFileSync(resolve(tilesDir, filename), JSON.stringify(chunkData));
        written.add(filename);
      }
    }
  }

  // Partial-payload guard: if the editor sent a tiles array with zero
  // non-default tiles across the entire map, treat it as an empty payload
  // and preserve existing chunk files instead of deleting them.
  if (written.size === 0) return;

  // Remove stale chunk files
  try {
    for (const file of readdirSync(tilesDir)) {
      if (file.startsWith('chunk_') && file.endsWith('.json') && !written.has(file)) {
        rmSync(resolve(tilesDir, file));
      }
    }
  } catch { /* dir may not exist yet */ }
}

/** Save heights as per-chunk JSON files (vertex grid: 65x65 per chunk including shared boundaries) */
function saveChunkedHeights(mapDir: string, heights: number[][], width: number, height: number): void {
  const heightsDir = resolve(mapDir, 'heights');
  mkdirSync(heightsDir, { recursive: true });

  const chunksX = Math.ceil(width / EDITOR_CHUNK_SIZE);
  const chunksZ = Math.ceil(height / EDITOR_CHUNK_SIZE);
  const written = new Set<string>();

  for (let cz = 0; cz < chunksZ; cz++) {
    for (let cx = 0; cx < chunksX; cx++) {
      const chunkData: Record<string, number> = {};
      const startZ = cz * EDITOR_CHUNK_SIZE;
      const startX = cx * EDITOR_CHUNK_SIZE;
      // Vertices: +1 for shared boundary
      const endZ = Math.min(startZ + EDITOR_CHUNK_SIZE + 1, height + 1);
      const endX = Math.min(startX + EDITOR_CHUNK_SIZE + 1, width + 1);

      for (let z = startZ; z < endZ; z++) {
        for (let x = startX; x < endX; x++) {
          const val = heights[z]?.[x] ?? 0;
          if (val !== 0) {
            const localZ = z - startZ;
            const localX = x - startX;
            chunkData[`${localZ},${localX}`] = val;
          }
        }
      }

      if (Object.keys(chunkData).length > 0) {
        const filename = `chunk_${cx}_${cz}.json`;
        writeFileSync(resolve(heightsDir, filename), JSON.stringify(chunkData));
        written.add(filename);
      }
    }
  }

  // Partial-payload guard: zero non-zero vertices across the whole map almost
  // always means a bad payload, not a deliberate flatten. Preserve existing
  // chunk files; for a real flatten, delete heights/ manually.
  if (written.size === 0) return;

  // Remove stale chunk files
  try {
    for (const file of readdirSync(heightsDir)) {
      if (file.startsWith('chunk_') && file.endsWith('.json') && !written.has(file)) {
        rmSync(resolve(heightsDir, file));
      }
    }
  } catch { /* dir may not exist yet */ }
}

/** Load tiles from per-chunk files. Returns null if tiles/ dir doesn't exist (fall back to map.json). */
function loadChunkedTiles(mapDir: string, width: number, height: number): KCTile[][] | null {
  const tilesDir = resolve(mapDir, 'tiles');
  if (!existsSync(tilesDir)) return null;

  // Initialize full array with defaults
  const tiles: KCTile[][] = [];
  for (let z = 0; z < height; z++) {
    const row: KCTile[] = [];
    for (let x = 0; x < width; x++) {
      row.push(defaultKCTile());
    }
    tiles.push(row);
  }

  try {
    for (const file of readdirSync(tilesDir)) {
      if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
      // Parse chunk coordinates from filename: chunk_cx_cz.json
      const match = file.match(/^chunk_(\d+)_(\d+)\.json$/);
      if (!match) continue;
      const cx = parseInt(match[1]);
      const cz = parseInt(match[2]);
      const startX = cx * EDITOR_CHUNK_SIZE;
      const startZ = cz * EDITOR_CHUNK_SIZE;

      const chunkData: Record<string, Partial<KCTile>> = JSON.parse(
        readFileSync(resolve(tilesDir, file), 'utf-8')
      );

      for (const [key, partial] of Object.entries(chunkData)) {
        const [localZStr, localXStr] = key.split(',');
        const z = startZ + parseInt(localZStr);
        const x = startX + parseInt(localXStr);
        if (z >= 0 && z < height && x >= 0 && x < width) {
          tiles[z][x] = expandTile(partial);
        }
      }
    }
  } catch { return null; }

  return tiles;
}

/** Load heights from per-chunk files. Returns null if heights/ dir doesn't exist (fall back to map.json). */
function loadChunkedHeights(mapDir: string, width: number, height: number): number[][] | null {
  const heightsDir = resolve(mapDir, 'heights');
  if (!existsSync(heightsDir)) return null;

  // Initialize full array with zeros (vertex grid is width+1 x height+1)
  const heights: number[][] = [];
  for (let z = 0; z <= height; z++) {
    const row: number[] = new Array(width + 1).fill(0);
    heights.push(row);
  }

  try {
    for (const file of readdirSync(heightsDir)) {
      if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
      const match = file.match(/^chunk_(\d+)_(\d+)\.json$/);
      if (!match) continue;
      const cx = parseInt(match[1]);
      const cz = parseInt(match[2]);
      const startX = cx * EDITOR_CHUNK_SIZE;
      const startZ = cz * EDITOR_CHUNK_SIZE;

      const chunkData: Record<string, number> = JSON.parse(
        readFileSync(resolve(heightsDir, file), 'utf-8')
      );

      for (const [key, val] of Object.entries(chunkData)) {
        const [localZStr, localXStr] = key.split(',');
        const z = startZ + parseInt(localZStr);
        const x = startX + parseInt(localXStr);
        if (z >= 0 && z <= height && x >= 0 && x <= width) {
          heights[z][x] = val;
        }
      }
    }
  } catch { return null; }

  return heights;
}

/** Reassemble tiles and heights from chunk files into a KCMapFile (mutates in place) */
function reassembleChunkedMapData(mapDir: string, mapFile: KCMapFile): void {
  const w = mapFile.map.width;
  const h = mapFile.map.height;
  const chunkedTiles = loadChunkedTiles(mapDir, w, h);
  if (chunkedTiles) mapFile.map.tiles = chunkedTiles;
  const chunkedHeights = loadChunkedHeights(mapDir, w, h);
  if (chunkedHeights) mapFile.map.heights = chunkedHeights;
}
import { GameDatabase } from './Database';
import { flushAuditSync } from './Audit';
import {
  handleGameSocketOpen,
  handleGameSocketMessage,
  handleGameSocketClose,
  type GameSocketData,
} from './network/GameSocket';
import {
  handleChatSocketOpen,
  handleChatSocketMessage,
  handleChatSocketClose,
  type ChatSocketData,
} from './network/ChatSocket';

const CLIENT_DIST = resolve(import.meta.dir, '../../client/dist');
const MAPS_DIR = resolve(import.meta.dir, '../data/maps');
const DATA_DIR = resolve(import.meta.dir, '../data');

/** Resolve `child` against `base` and verify the *real* path (symlinks
 *  followed) still lives under `base`. Without realpath, an attacker who
 *  could create a symlink inside `base` pointing elsewhere would defeat the
 *  startsWith check — resolve() handles `..` but doesn't follow links.
 *  Returns the canonical path if safe, null if out-of-bounds or missing. */
function resolveWithinBase(base: string, child: string): string | null {
  const candidate = resolve(base, child);
  try {
    const real = realpathSync(candidate);
    const realBase = realpathSync(base);
    return real.startsWith(realBase + sep) || real === realBase ? real : null;
  } catch {
    return null;
  }
}

// MIME type lookup
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf('.'));
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function serveStatic(pathname: string): Response | null {
  const decoded = decodeURIComponent(pathname);
  let filePath = resolve(CLIENT_DIST, decoded.startsWith('/') ? decoded.slice(1) : decoded);
  let isIndexFallback = false;

  try {
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      filePath = resolve(filePath, 'index.html');
      isIndexFallback = true;
    }
  } catch {
    filePath = resolve(CLIENT_DIST, 'index.html');
    isIndexFallback = true;
  }

  try {
    const content = readFileSync(filePath);
    // index.html must never be cached so deploys are picked up immediately.
    // Vite-hashed JS/CSS chunks under /assets/ are content-addressed and
    // safe to cache long. All other static GLBs/PNGs use a moderate cache
    // so reloads don't repeatedly re-download multi-MB character models.
    let cacheControl = 'public, max-age=3600';
    if (isIndexFallback || filePath.endsWith('.html')) {
      cacheControl = 'no-cache';
    } else if (decoded.startsWith('/assets/') && (filePath.endsWith('.js') || filePath.endsWith('.css'))) {
      cacheControl = 'public, max-age=31536000, immutable';
    }
    return new Response(content, {
      headers: {
        'Content-Type': getMimeType(filePath),
        'Cache-Control': cacheControl,
      },
    });
  } catch {
    return null;
  }
}

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// --- Auth rate limiting ---
// Bun.serve runs in one process, so an in-memory map is sufficient. If we ever
// shard, this needs to move behind a shared store (Redis). Mirrors 2004scape
// LoginServer.ts:231-249 — login limit per (account, IP), signup limit per IP.

interface RateBucket { count: number; resetAt: number; }
const loginAttempts = new Map<string, RateBucket>();
const signupAttempts = new Map<string, RateBucket>();
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW_MS = 60_000;
const SIGNUP_LIMIT = 3;
const SIGNUP_WINDOW_MS = 60 * 60_000;
// Hard cap on entries so an attacker rotating usernames (or IPs, behind a
// proxy) can't fill the map between sweeps. When the cap is hit, the oldest
// entry is evicted — Map preserves insertion order, so `keys().next()` is O(1).
const RATE_MAP_MAX = 10_000;

function checkRate(map: Map<string, RateBucket>, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  let bucket = map.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    if (map.size >= RATE_MAP_MAX) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= limit;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginAttempts) if (now > v.resetAt) loginAttempts.delete(k);
  for (const [k, v] of signupAttempts) if (now > v.resetAt) signupAttempts.delete(k);
}, 5 * 60_000);

// Create database and game world
const db = new GameDatabase();
const world = new World(db);
world.start();

// --- Admin authorization for editor / dev APIs ---
// A request is admin-authorized if:
//   1. It originates from loopback (local dev / SSH-tunneled use), OR
//   2. It carries a valid `Authorization: Bearer <token>` whose session belongs
//      to an account flagged is_admin=1 in the DB.
// NOTE: behind a reverse proxy, requestIP() will report the proxy's address.
// When a reverse proxy lands, switch to a trusted X-Forwarded-For check
// (or terminate TLS in Bun directly). Until then, loopback ≡ same machine.
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function isAdminRequest(req: Request, srv: { requestIP: (r: Request) => { address: string } | null }): boolean {
  const ip = srv.requestIP(req)?.address ?? '';
  if (LOOPBACK_IPS.has(ip)) return true;
  const auth = req.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const session = db.getSession(m[1]);
  return !!session && session.isAdmin;
}

function adminForbidden(): Response {
  return new Response('Forbidden — admin authorization required', { status: 403 });
}

// --- Body size limits ---
// `req.json()` is unbounded by default — without a cap, a single 1 GB POST to
// any endpoint can OOM the process. We pre-check Content-Length and reject
// oversize requests before reading the body. Streaming requests without a
// Content-Length header are rejected outright (we don't accept chunked uploads).
function tooLarge(): Response {
  return new Response('Payload too large', { status: 413 });
}

/** Returns true if the request body fits within `maxBytes`. */
/** Validate a client-supplied device ID. Accepts UUID-shaped strings up to
 *  64 chars; anything else is treated as missing. Server-side: missing means
 *  "no enforcement applies" — better than refusing connection for users with
 *  weird browser environments (private mode, sandboxed iframes). */
function sanitizeDeviceId(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  if (raw.length < 8 || raw.length > 64) return '';
  // Permissive: alphanumeric + dash + colon (UUIDs, hashed IDs, etc.)
  if (!/^[a-zA-Z0-9:_-]+$/.test(raw)) return '';
  return raw;
}

function bodyWithinLimit(req: Request, maxBytes: number): boolean {
  const lenHdr = req.headers.get('content-length');
  if (!lenHdr) return false; // require declared length
  const len = Number(lenHdr);
  if (!Number.isFinite(len) || len < 0) return false;
  return len <= maxBytes;
}

const BODY_LIMIT_AUTH = 4 * 1024;          // 4 KB — username + password JSON
const BODY_LIMIT_DEV = 1 * 1024 * 1024;     // 1 MB — gear-overrides config
const BODY_LIMIT_EDITOR = 50 * 1024 * 1024; // 50 MB — full map import / save

// --- Origin allow-list for WebSocket upgrades ---
// Browsers always send the Origin header on WS handshakes. A CSRF-style attack
// (logged-in user lured to evil.com → that page opens a WS to our server)
// would carry Origin: https://evil.com — this list rejects it.
//
// Missing Origin is allowed because non-browser clients (bots, native launchers
// if we ever ship one) don't send it and still must clear the auth-token gate.
//
// Add production hostnames here when deploying. CLIENT_ORIGINS env can override.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:4000', 'http://127.0.0.1:4000',  // server-served client
  'http://localhost:5173', 'http://127.0.0.1:5173',  // vite dev (client)
  'http://localhost:5174', 'http://127.0.0.1:5174',  // vite dev (editor)
];
const ALLOWED_WS_ORIGINS = new Set(
  (process.env.CLIENT_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) ?? DEFAULT_ALLOWED_ORIGINS)
);

function isAllowedOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser client; auth still applies
  return ALLOWED_WS_ORIGINS.has(origin);
}

// --- Per-account WS connection cap ---
// Without this, a single authenticated account can open thousands of WebSockets
// (kickAccountIfOnline only handles game sockets — chat sockets accumulate).
// Cap: game socket (1) + chat socket (1) + 2 slack for refresh races = 4.
// Counted at `open` time, decremented at `close`. Refusing here is graceful;
// the client sees a normal close and can reconnect.
const MAX_WS_PER_ACCOUNT = 4;
const wsCountByAccount: Map<number, number> = new Map();

/** Returns false if the cap is exceeded. Caller must close the socket. */
function tryReserveWsSlot(accountId: number): boolean {
  const cur = wsCountByAccount.get(accountId) ?? 0;
  if (cur >= MAX_WS_PER_ACCOUNT) return false;
  wsCountByAccount.set(accountId, cur + 1);
  return true;
}
function releaseWsSlot(accountId: number): void {
  const cur = wsCountByAccount.get(accountId) ?? 0;
  if (cur <= 1) wsCountByAccount.delete(accountId);
  else wsCountByAccount.set(accountId, cur - 1);
}

// --- WS auth-token extraction ---
// Preferred: Sec-WebSocket-Protocol header (subprotocol). The browser sets this
// from the WebSocket constructor's 2nd arg. Tokens in this header don't appear
// in reverse-proxy access logs the way `?token=` URL params do.
//
// Convention: token is sent as a single subprotocol value of the form
// `auth.<token>`. Multiple subprotocols are allowed (comma-separated); we pick
// the first one that starts with `auth.`.
function extractWsToken(req: Request, url: URL): string | null {
  const proto = req.headers.get('sec-websocket-protocol');
  if (proto) {
    for (const raw of proto.split(',')) {
      const v = raw.trim();
      if (v.startsWith('auth.')) return v.slice(5);
    }
  }
  // Legacy fallback: query param. Will eventually be removed.
  return url.searchParams.get('token');
}

/** Echo the chosen subprotocol back so the client's handshake completes. The
 *  browser closes the socket if the server upgrades without echoing one of
 *  the offered subprotocols. */
function wsAcceptHeaders(req: Request): Record<string, string> | undefined {
  const proto = req.headers.get('sec-websocket-protocol');
  if (!proto) return undefined;
  for (const raw of proto.split(',')) {
    const v = raw.trim();
    if (v.startsWith('auth.')) return { 'Sec-WebSocket-Protocol': v };
  }
  return undefined;
}

// Clean expired sessions every 10 minutes
setInterval(() => db.cleanExpiredSessions(), 10 * 60 * 1000);

// Save all players on graceful shutdown so a server restart (SIGTERM from
// `bun --watch`, deploy, or operator Ctrl-C) doesn't lose the last 15 s of
// progress between auto-save ticks. World.stop() flushes one final save
// before clearing the tick/save timers.
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] received ${signal} — saving state and exiting`);
  try { world.stop(); } catch (e) { console.error('[shutdown] world.stop() failed:', e); }
  // Drain any in-memory audit events synchronously so we don't lose the last
  // ~1s of forensic log on restart.
  try { flushAuditSync(); } catch (e) { console.error('[shutdown] flushAuditSync() failed:', e); }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

type SocketData = GameSocketData | ChatSocketData;

const server = Bun.serve<SocketData>({
  port: SERVER_PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // --- REST Auth Endpoints ---

    if (url.pathname === '/api/signup' && req.method === 'POST') {
      if (!isAllowedOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      const ip = server.requestIP(req)?.address ?? 'unknown';
      if (!checkRate(signupAttempts, ip, SIGNUP_LIMIT, SIGNUP_WINDOW_MS)) {
        return jsonResponse({ ok: false, error: 'Too many signup attempts. Try again later.' }, 429);
      }
      try {
        const body = await req.json() as { username?: string; password?: string; deviceId?: string };
        const deviceId = sanitizeDeviceId(body.deviceId);
        const result = await db.createAccount(body.username || '', body.password || '', deviceId);
        if (result.ok) {
          return jsonResponse({ ok: true, token: result.token, username: body.username });
        }
        return jsonResponse({ ok: false, error: result.error }, 400);
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (!isAllowedOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      const ip = server.requestIP(req)?.address ?? 'unknown';
      try {
        const body = await req.json() as { username?: string; password?: string; deviceId?: string };
        const username = (body.username || '').toLowerCase();
        const deviceId = sanitizeDeviceId(body.deviceId);
        // Rate-limit by (username, IP) so a single attacker can't lock out a
        // legitimate user from another IP, and a NAT'd legitimate user isn't
        // locked out by an attacker on the same IP targeting a different account.
        const key = `${username}:${ip}`;
        if (!checkRate(loginAttempts, key, LOGIN_LIMIT, LOGIN_WINDOW_MS)) {
          return jsonResponse({ ok: false, error: 'Too many login attempts. Try again in a minute.' }, 429);
        }
        const result = await db.login(body.username || '', body.password || '', deviceId);
        if (result.ok) {
          // One-account-per-browser rule. A different account already in the
          // world with the same device_id is refused entry. Per-browser, not
          // per-IP — housemates / cafes / dorms are unaffected. Deterrent,
          // not a security boundary (clearing localStorage gives a new ID),
          // but pairs with the ToS rule the user enforces manually. Admin
          // accounts skip the check so dev/test multi-account work still
          // functions; missing deviceId (no enforcement) is also allowed
          // since legit users with disabled localStorage shouldn't be locked
          // out. Same-account re-login is fine — kickAccountIfOnline handles
          // the old session.
          const accountId = result.accountId;
          if (accountId != null && !result.isAdmin && deviceId && world.hasOtherActiveAccountFromDevice(deviceId, accountId)) {
            return jsonResponse({
              ok: false,
              error: 'Another account is already logged in on this browser. Only one active session per browser is allowed per the rules.',
            }, 403);
          }
          // Successful login resets the bucket so subsequent legitimate logins
          // from the same client don't hit the limit.
          loginAttempts.delete(key);
          return jsonResponse({ ok: true, token: result.token, username: result.username });
        }
        return jsonResponse({ ok: false, error: result.error }, 400);
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/validate' && req.method === 'POST') {
      if (!isAllowedOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { token?: string };
        const session = body.token ? db.getSession(body.token) : null;
        return jsonResponse({ ok: !!session });
      } catch {
        return jsonResponse({ ok: false });
      }
    }

    if (url.pathname === '/api/logout' && req.method === 'POST') {
      if (!isAllowedOrigin(req)) return new Response('Forbidden', { status: 403 });
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { token?: string };
        if (body.token) {
          // Resolve account before deleting the session so we can kick any
          // active WebSockets — otherwise the player keeps playing on a
          // logged-out token until they refresh.
          const session = db.getSession(body.token);
          db.logout(body.token);
          if (session) world.kickAccountIfOnline(session.accountId);
        }
        return jsonResponse({ ok: true });
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    // --- WebSocket Upgrades (with token auth) ---

    if (url.pathname === GAME_WS_PATH) {
      if (!isAllowedOrigin(req)) return new Response('Forbidden', { status: 403 });
      // Accept token via Sec-WebSocket-Protocol (preferred — doesn't leak to
      // proxy access logs) OR via ?token= query param (legacy). The query-
      // param path can be removed once all clients are on the new build.
      const token = extractWsToken(req, url);
      const session = token ? db.getSession(token) : null;
      if (!session) {
        return new Response('Unauthorized', { status: 401 });
      }
      // Capture IP at upgrade time. Behind a reverse proxy this is the
      // proxy's address — production deploys should be sure their proxy
      // forwards X-Forwarded-For and Bun is configured to honor it. For
      // anti-cheat purposes a stable per-NAT IP is what matters; the
      // gold-farmer correlation tolerates shared-IP noise (residential
      // CGNAT, university dorms) because flag-level review is manual.
      const wsIp = server.requestIP(req)?.address ?? 'unknown';
      const upgraded = server.upgrade(req, {
        data: { type: 'game', accountId: session.accountId, username: session.username, isAdmin: session.isAdmin, ip: wsIp, deviceId: session.deviceId } as GameSocketData,
        headers: wsAcceptHeaders(req),
      });
      if (upgraded) return undefined as unknown as Response;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    if (url.pathname === CHAT_WS_PATH) {
      if (!isAllowedOrigin(req)) return new Response('Forbidden', { status: 403 });
      const token = extractWsToken(req, url);
      const session = token ? db.getSession(token) : null;
      if (!session) {
        return new Response('Unauthorized', { status: 401 });
      }
      const upgraded = server.upgrade(req, {
        data: { type: 'chat', accountId: session.accountId, username: session.username, isAdmin: session.isAdmin } as ChatSocketData,
        headers: wsAcceptHeaders(req),
      });
      if (upgraded) return undefined as unknown as Response;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    // --- Data Assets ---

    if (url.pathname.startsWith('/data/') && url.pathname.endsWith('.json')) {
      const filename = url.pathname.slice(6); // remove '/data/'
      if (filename.includes('/') || filename.includes('..')) {
        return new Response('Forbidden', { status: 403 });
      }
      // Symlink-safe path resolution. Without realpath, a `server/data/evil ->
      // /etc/passwd` symlink would defeat the startsWith check.
      const filePath = resolveWithinBase(DATA_DIR, filename);
      if (!filePath) return new Response('Forbidden', { status: 403 });
      try {
        const content = readFileSync(filePath);
        return new Response(content, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
          },
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }

    // --- Dev API ---

    if (url.pathname === '/api/dev/gear-overrides' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_DEV)) return tooLarge();
      try {
        const body = await req.json() as Record<string, any>;
        const filePath = resolve(import.meta.dir, '../data/gear-overrides.json');

        // Two-tier sanity check before clobbering existing data:
        //   (a) Empty payload + non-empty existing → outright refuse. This is
        //       almost always a test POST or a panic-save before the dev
        //       client finished loading. Caused a 535-line wipe on 2026-05-13.
        //   (b) Drastic shrink (>50% of entries gone) → refuse. Catches the
        //       "client loaded partial state then saved" variant, which is
        //       quieter than (a) but just as destructive.
        // Both checks are bypassable by sending the requested data inline
        // (you can't accidentally drop 50% of entries unless you really mean to).
        const incomingCount = (body && typeof body === 'object') ? Object.keys(body).length : 0;
        if (existsSync(filePath)) {
          let existingCount = 0;
          try {
            const existing = JSON.parse(readFileSync(filePath, 'utf-8'));
            if (existing && typeof existing === 'object') existingCount = Object.keys(existing).length;
          } catch { /* unreadable existing → fall through */ }

          if (existingCount > 0 && incomingCount === 0) {
            return jsonResponse({ ok: false, error: 'Refusing to overwrite non-empty gear-overrides with empty payload' }, 400);
          }
          if (existingCount >= 4 && incomingCount * 2 < existingCount) {
            return jsonResponse({
              ok: false,
              error: `Refusing save: would shrink ${existingCount} → ${incomingCount} entries (>50% drop)`,
            }, 400);
          }
        }

        // Rotated timestamped backups (matches the map-editor pattern in
        // createMapBackup). Keeps the last 10 snapshots so the most recent
        // burst of edits is recoverable even if multiple bad saves chain.
        if (existsSync(filePath)) {
          try {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const bakDir = dirname(filePath);
            const bakPath = resolve(bakDir, `gear-overrides.${ts}.bak`);
            cpSync(filePath, bakPath);
            // Rotate: keep the 10 newest .bak snapshots, drop the rest.
            const baks = readdirSync(bakDir)
              .filter(n => /^gear-overrides\..+\.bak$/.test(n))
              .sort(); // ISO-prefix sorts oldest-first
            const excess = Math.max(0, baks.length - 10);
            for (let i = 0; i < excess; i++) {
              try { rmSync(resolve(bakDir, baks[i])); } catch { /* best-effort */ }
            }
          } catch { /* best-effort: never block the save on backup failure */ }
        }

        const tmpPath = filePath + '.tmp';
        writeFileSync(tmpPath, JSON.stringify(body, null, 2));
        renameSync(tmpPath, filePath);
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    if (url.pathname === '/api/dev/gear-files' && req.method === 'GET') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      const slot = url.searchParams.get('slot') || '';
      if (!slot || slot.includes('/') || slot.includes('..')) {
        return jsonResponse({ ok: false, error: 'Invalid slot' }, 400);
      }
      try {
        const equipRoot = resolve(import.meta.dir, '../../client/public/assets/equipment');
        let itemDefs: any[] = [];
        try { itemDefs = JSON.parse(readFileSync(resolve(import.meta.dir, '../data/items.json'), 'utf-8')); } catch {}
        const itemMap = new Map<number, string>();
        for (const def of itemDefs) itemMap.set(def.id, def.name);

        const manifestNames = new Map<string, string>();
        try {
          const manifest = JSON.parse(readFileSync(resolve(equipRoot, 'polytope/manifest.json'), 'utf-8'));
          for (const entries of Object.values(manifest) as any[]) {
            for (const entry of entries) manifestNames.set(entry.file, entry.name);
          }
        } catch {}

        const polytopeDirMap: Record<string, string[]> = {
          weapon:  ['weapon', 'polytope/weapons', 'Tools'],
          shield:  ['shield', 'polytope/weapons'],
          head:    ['head', 'polytope/armor_male/helmet'],
          body:    ['body', 'polytope/armor_male/body'],
          legs:    ['legs', 'polytope/armor_male/legs'],
          feet:    ['feet', 'polytope/armor_male/boots'],
          hands:   ['hands', 'polytope/armor_male/gauntlets'],
          cape:    ['cape', 'polytope/armor_male/cape'],
          neck:    ['neck'],
          ring:    ['ring'],
        };
        const dirs = polytopeDirMap[slot] || [slot];

        const seen = new Set<string>();
        const files: { file: string; path: string; itemId: number; name: string }[] = [];
        for (const dir of dirs) {
          const fullDir = resolve(equipRoot, dir);
          if (!existsSync(fullDir)) continue;
          for (const f of readdirSync(fullDir)) {
            if (!f.endsWith('.glb') && !f.endsWith('.gltf')) continue;
            const relPath = `/assets/equipment/${dir}/${f}`;
            if (seen.has(relPath)) continue;
            seen.add(relPath);
            const itemId = parseInt(f.replace(/\.[^.]+$/, ''), 10);
            files.push({
              file: f,
              path: relPath,
              itemId: isNaN(itemId) ? -1 : itemId,
              name: (!isNaN(itemId) && itemMap.get(itemId)) || manifestNames.get(relPath) || f.replace(/\.[^.]+$/, ''),
            });
          }
        }
        files.sort((a, b) => {
          if (a.itemId !== b.itemId) return a.itemId - b.itemId;
          return a.name.localeCompare(b.name);
        });
        return jsonResponse({ files });
      } catch {
        return jsonResponse({ files: [] });
      }
    }

    // --- Editor API ---

    if (url.pathname === '/api/editor/maps' && req.method === 'GET') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      try {
        const entries = readdirSync(MAPS_DIR, { withFileTypes: true });
        const maps = entries
          .filter(e => e.isDirectory())
          .map(e => {
            try {
              const meta = JSON.parse(readFileSync(resolve(MAPS_DIR, e.name, 'meta.json'), 'utf-8'));
              return { id: meta.id, name: meta.name, width: meta.width, height: meta.height };
            } catch {
              return { id: e.name, name: e.name, width: 0, height: 0 };
            }
          });
        return jsonResponse({ ok: true, maps });
      } catch {
        return jsonResponse({ ok: false, error: 'Failed to list maps' }, 500);
      }
    }

    if (url.pathname === '/api/editor/save-map' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_EDITOR)) return tooLarge();
      try {
        const body = await req.json() as {
          mapId: string;
          meta: MapMeta;
          spawns: SpawnsFile;
          mapData: KCMapFile;
          walls?: WallsFile;
          biomes?: BiomesFile;
        };
        const { mapId, meta, spawns, mapData, walls, biomes } = body;
        if (!mapId || !meta || !mapData) {
          return jsonResponse({ ok: false, error: 'Missing fields' }, 400);
        }
        const mapDir = resolve(MAPS_DIR, mapId);
        if (!mapDir.startsWith(MAPS_DIR)) {
          return new Response('Forbidden', { status: 403 });
        }

        // Snapshot current state before any writes. Cheap insurance against partial-payload wipes.
        createMapBackup(mapDir);

        // Use editor's dimensions (may have changed via chunk add/remove), preserve spawn point
        const metaPath = resolve(mapDir, 'meta.json');
        try {
          const existingMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
          if (existingMeta.spawnPoint) meta.spawnPoint = existingMeta.spawnPoint;
        } catch { /* first save */ }
        // Use dimensions from map data if available (editor backing array may have grown)
        if (mapData.map?.width) meta.width = mapData.map.width;
        if (mapData.map?.height) meta.height = mapData.map.height;
        writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        // Save spawns (NPCs, items, and any sprite-only objects from editor)
        const spawnsPath = resolve(mapDir, 'spawns.json');
        const mergedSpawns = {
          npcs: spawns?.npcs ?? [],
          objects: spawns?.objects ?? [],
          items: spawns?.items ?? [],
        };
        writeFileSync(spawnsPath, JSON.stringify(mergedSpawns, null, 2));

        // Save placed objects as per-chunk files
        const mapJsonPath = resolve(mapDir, 'map.json');
        let objectsToSave = mapData.placedObjects ?? [];
        // Preserve existing objects if editor sends empty (prevents accidental wipe)
        if (objectsToSave.length === 0) {
          const existing = loadChunkedObjects(mapDir);
          if (existing) objectsToSave = existing;
          else try {
            const existingMap: KCMapFile = JSON.parse(readFileSync(mapJsonPath, 'utf-8'));
            objectsToSave = existingMap.placedObjects ?? [];
          } catch { /* no existing data */ }
        }
        saveChunkedObjects(mapDir, objectsToSave);

        // Save tiles and heights as per-chunk files
        const mapWidth = mapData.map?.width ?? meta.width;
        const mapHeight = mapData.map?.height ?? meta.height;
        if (mapData.map?.tiles?.length > 0) {
          saveChunkedTiles(mapDir, mapData.map.tiles, mapWidth, mapHeight);
        }
        if (mapData.map?.heights?.length > 0) {
          saveChunkedHeights(mapDir, mapData.map.heights, mapWidth, mapHeight);
        }

        // Save map.json WITHOUT placedObjects, tiles, or heights (they're in chunk files now).
        // Preserve existing texturePlanes if editor didn't include the field (partial-payload protection).
        const { placedObjects: _, ...mapDataWithoutObjects } = mapData;
        let preservedTexturePlanes = mapDataWithoutObjects.map?.texturePlanes;
        if (preservedTexturePlanes === undefined) {
          try {
            const existingMap: KCMapFile = JSON.parse(readFileSync(mapJsonPath, 'utf-8'));
            preservedTexturePlanes = existingMap.map?.texturePlanes ?? [];
          } catch { preservedTexturePlanes = []; }
        }
        const mapFileToSave = {
          ...mapDataWithoutObjects,
          placedObjects: [],
          map: {
            ...mapDataWithoutObjects.map,
            tiles: [],    // stripped — stored in tiles/ chunks
            heights: [],  // stripped — stored in heights/ chunks
            texturePlanes: preservedTexturePlanes,
          },
        };
        writeFileSync(mapJsonPath, JSON.stringify(mapFileToSave, null, 2));
        // Walls — preserve existing if editor didn't include the field (partial-payload protection).
        const wallsPath = resolve(mapDir, 'walls.json');
        let wallsToSave = walls;
        if (wallsToSave === undefined) {
          try {
            wallsToSave = JSON.parse(readFileSync(wallsPath, 'utf-8')) as WallsFile;
          } catch {
            wallsToSave = { walls: {} };
          }
        }
        writeFileSync(wallsPath, JSON.stringify(wallsToSave, null, 2));

        // Biomes — preserve existing if editor didn't include the field (partial-payload protection).
        const biomesPath = resolve(mapDir, 'biomes.json');
        let biomesToSave: BiomesFile | undefined = biomes;
        if (biomesToSave === undefined) {
          try {
            biomesToSave = JSON.parse(readFileSync(biomesPath, 'utf-8')) as BiomesFile;
          } catch {
            biomesToSave = { defs: [], cells: {} };
          }
        }
        writeFileSync(biomesPath, JSON.stringify(biomesToSave, null, 2));

        // Post-save snapshot so the fresh state is immediately backed up,
        // not just the state that was about to be overwritten.
        createMapBackup(mapDir);

        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    // Save the full server/data/npcs.json from the editor's NPC inspector.
    // Body shape: { npcs: NpcDef[] }. Atomic via tmp + rename. Snapshots the
    // pre-save file into server/data/backups/npcs/<ISO>.json and keeps the
    // last 20. After a successful write we call world.data.reloadNpcs() so
    // editor edits (stats, shop, dialogue) reflect on the next NPC spawn
    // without a server restart.
    if (url.pathname === '/api/editor/npcs' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_DEV)) return tooLarge();
      try {
        const body = await req.json() as { npcs: any[] };
        if (!body || !Array.isArray(body.npcs)) {
          return jsonResponse({ ok: false, error: 'Body must be { npcs: NpcDef[] }' }, 400);
        }
        // Shrinkage guard mirrors the gear-overrides save: refuse a payload
        // that's lost more than half the entries — an editor bug or stale
        // working copy shouldn't be able to wipe the canonical defs.
        const dataDir = resolve(import.meta.dir, '../data');
        const npcsPath = resolve(dataDir, 'npcs.json');
        if (existsSync(npcsPath)) {
          try {
            const existing = JSON.parse(readFileSync(npcsPath, 'utf-8')) as any[];
            if (Array.isArray(existing) && existing.length >= 4 && body.npcs.length * 2 < existing.length) {
              return jsonResponse({
                ok: false,
                error: `Refusing save: would shrink ${existing.length} → ${body.npcs.length} NPCs (>50% drop)`,
              }, 400);
            }
          } catch { /* unreadable existing file — proceed */ }
        }
        // Pre-save snapshot. Folder lives under data/backups/npcs (separate
        // from per-map backups so they don't clutter map dirs).
        const backupsDir = resolve(dataDir, 'backups', 'npcs');
        try {
          mkdirSync(backupsDir, { recursive: true });
          if (existsSync(npcsPath)) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            cpSync(npcsPath, resolve(backupsDir, `npcs.${ts}.json`));
            // Rotate: keep the 20 newest snapshots.
            const snaps = readdirSync(backupsDir)
              .filter(n => /^npcs\..+\.json$/.test(n))
              .sort();
            const excess = Math.max(0, snaps.length - 20);
            for (let i = 0; i < excess; i++) {
              try { rmSync(resolve(backupsDir, snaps[i])); } catch { /* best-effort */ }
            }
          }
        } catch (err) {
          console.warn('[save-npcs] backup failed:', (err as Error)?.message);
        }
        const tmpPath = npcsPath + '.tmp';
        writeFileSync(tmpPath, JSON.stringify(body.npcs, null, 2));
        renameSync(tmpPath, npcsPath);
        // Hot-reload — existing live NPC instances keep their old def (changes
        // mid-fight would be jarring); newly spawned NPCs and respawns pick up
        // the new defs. Editor users can /reloadmap to force-respawn if they
        // want their changes applied to in-world NPCs right now.
        world.data.reloadNpcs();
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    if (url.pathname === '/api/editor/quests' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_DEV)) return tooLarge();
      try {
        const body = await req.json() as { quests: any[] };
        if (!body || !Array.isArray(body.quests)) {
          return jsonResponse({ ok: false, error: 'Body must be { quests: QuestDef[] }' }, 400);
        }
        const dataDir = resolve(import.meta.dir, '../data');
        const questsPath = resolve(dataDir, 'quests.json');
        // Shrinkage guard, same shape as npcs save.
        if (existsSync(questsPath)) {
          try {
            const existing = JSON.parse(readFileSync(questsPath, 'utf-8')) as any[];
            if (Array.isArray(existing) && existing.length >= 4 && body.quests.length * 2 < existing.length) {
              return jsonResponse({
                ok: false,
                error: `Refusing save: would shrink ${existing.length} → ${body.quests.length} quests (>50% drop)`,
              }, 400);
            }
          } catch { /* unreadable existing — proceed */ }
        }
        const backupsDir = resolve(dataDir, 'backups', 'quests');
        try {
          mkdirSync(backupsDir, { recursive: true });
          if (existsSync(questsPath)) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            cpSync(questsPath, resolve(backupsDir, `quests.${ts}.json`));
            const snaps = readdirSync(backupsDir).filter(n => /^quests\..+\.json$/.test(n)).sort();
            const excess = Math.max(0, snaps.length - 20);
            for (let i = 0; i < excess; i++) {
              try { rmSync(resolve(backupsDir, snaps[i])); } catch { /* best-effort */ }
            }
          }
        } catch (err) {
          console.warn('[save-quests] backup failed:', (err as Error)?.message);
        }
        const tmpPath = questsPath + '.tmp';
        writeFileSync(tmpPath, JSON.stringify(body.quests, null, 2));
        renameSync(tmpPath, questsPath);
        // Hot-reload: existing in-progress quests on players keep their state
        // (no stage-shift), but new triggers + new defs pick up immediately.
        world.data.reloadQuests();
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Save failed' }, 500);
      }
    }

    if (url.pathname === '/api/editor/new-map' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { mapId: string; name: string; width: number; height: number; dungeon?: boolean };
        const { mapId, name, width, height } = body;
        if (!mapId || !name || !width || !height) {
          return jsonResponse({ ok: false, error: 'Missing fields' }, 400);
        }
        if (width < 32 || width > 2048 || height < 32 || height > 2048) {
          return jsonResponse({ ok: false, error: 'Dimensions must be 32-2048' }, 400);
        }
        const mapDir = resolve(MAPS_DIR, mapId);
        if (!mapDir.startsWith(MAPS_DIR)) {
          return new Response('Forbidden', { status: 403 });
        }
        try { statSync(mapDir); return jsonResponse({ ok: false, error: 'Map already exists' }, 400); } catch {}

        mkdirSync(mapDir, { recursive: true });

        // Default meta
        const isDungeon = body.dungeon === true;
        const meta: MapMeta = {
          id: mapId,
          name,
          width,
          height,
          waterLevel: isDungeon ? -10 : -0.3,
          spawnPoint: { x: Math.floor(width / 2) + 0.5, z: Math.floor(height / 2) + 0.5 },
          fogColor: isDungeon ? [0.05, 0.02, 0.08] as [number, number, number] : [0.4, 0.6, 0.9] as [number, number, number],
          fogStart: isDungeon ? 8 : 30,
          fogEnd: isDungeon ? 25 : 50,
          transitions: [],
        };

        // Build metadata-only KC map data (default tiles/heights need no chunk files)
        const mapData: KCMapFile = {
          map: {
            width,
            height,
            waterLevel: -0.3,
            chunkWaterLevels: {},
            texturePlanes: [],
            tiles: [],    // metadata-only — no chunk files needed for default empty map
            heights: [],  // metadata-only — zeros are the default
          },
          placedObjects: [],
          layers: [{ id: 'default', name: 'Default', visible: true }],
          activeLayerId: 'default',
        };

        writeFileSync(resolve(mapDir, 'meta.json'), JSON.stringify(meta, null, 2));
        writeFileSync(resolve(mapDir, 'spawns.json'), JSON.stringify({ npcs: [], objects: [] }, null, 2));
        writeFileSync(resolve(mapDir, 'map.json'), JSON.stringify(mapData, null, 2));
        writeFileSync(resolve(mapDir, 'walls.json'), JSON.stringify({ walls: {} }, null, 2));
        writeFileSync(resolve(mapDir, 'biomes.json'), JSON.stringify({ defs: [], cells: {} }, null, 2));

        return jsonResponse({ ok: true, meta });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Create failed' }, 500);
      }
    }

    if (url.pathname === '/api/editor/reload-map' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { mapId: string };
        const { mapId } = body;
        if (!mapId) return jsonResponse({ ok: false, error: 'Missing mapId' }, 400);
        const mapDir = resolve(MAPS_DIR, mapId);
        if (!mapDir.startsWith(MAPS_DIR)) return new Response('Forbidden', { status: 403 });

        // Reload the map in the world (re-read JSON from disk)
        try {
          world.reloadMap(mapId);
          return jsonResponse({ ok: true });
        } catch (e: any) {
          return jsonResponse({ ok: false, error: e.message }, 500);
        }
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid request' }, 400);
      }
    }

    if (url.pathname === '/api/editor/export-map' && req.method === 'GET') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      const mapId = url.searchParams.get('mapId');
      if (!mapId) return jsonResponse({ ok: false, error: 'Missing mapId' }, 400);
      const mapDir = resolve(MAPS_DIR, mapId);
      if (!mapDir.startsWith(MAPS_DIR)) return new Response('Forbidden', { status: 403 });

      try {
        // Reassemble all chunked data for export (objects, tiles, heights)
        const mapJson: KCMapFile = JSON.parse(readFileSync(resolve(mapDir, 'map.json'), 'utf-8'));
        const chunkedObjects = loadChunkedObjects(mapDir);
        if (chunkedObjects) {
          mapJson.placedObjects = chunkedObjects;
        }
        reassembleChunkedMapData(mapDir, mapJson);
        const exportFiles: Record<string, string> = {
          'meta.json': readFileSync(resolve(mapDir, 'meta.json'), 'utf-8'),
          'spawns.json': readFileSync(resolve(mapDir, 'spawns.json'), 'utf-8'),
          'map.json': JSON.stringify(mapJson),
        };
        const wallsPath = resolve(mapDir, 'walls.json');
        if (existsSync(wallsPath)) {
          exportFiles['walls.json'] = readFileSync(wallsPath, 'utf-8');
        }
        const biomesPath = resolve(mapDir, 'biomes.json');
        if (existsSync(biomesPath)) {
          exportFiles['biomes.json'] = readFileSync(biomesPath, 'utf-8');
        }
        const exported = { ok: true, mapId, files: exportFiles };
        return new Response(JSON.stringify(exported), {
          headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${mapId}.json"`,
          },
        });
      } catch {
        return jsonResponse({ ok: false, error: 'Export failed' }, 500);
      }
    }

    if (url.pathname === '/api/editor/import-map' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_EDITOR)) return tooLarge();
      try {
        const formData = await req.formData();
        const file = formData.get('file') as File;
        if (!file) return jsonResponse({ ok: false, error: 'No file' }, 400);
        const text = await file.text();
        const data = JSON.parse(text);
        const mapId = data.mapId;
        if (!mapId || !data.files) return jsonResponse({ ok: false, error: 'Invalid format' }, 400);

        const mapDir = resolve(MAPS_DIR, mapId);
        if (!mapDir.startsWith(MAPS_DIR)) return new Response('Forbidden', { status: 403 });
        mkdirSync(mapDir, { recursive: true });

        writeFileSync(resolve(mapDir, 'meta.json'), data.files['meta.json']);
        writeFileSync(resolve(mapDir, 'spawns.json'), data.files['spawns.json']);
        if (data.files['walls.json']) {
          writeFileSync(resolve(mapDir, 'walls.json'), data.files['walls.json']);
        }
        if (data.files['biomes.json']) {
          writeFileSync(resolve(mapDir, 'biomes.json'), data.files['biomes.json']);
        }

        // Parse imported map.json, split tiles/heights into chunks, then write metadata-only map.json
        const importedMap: KCMapFile = JSON.parse(data.files['map.json']);
        const importedObjects = importedMap.placedObjects ?? [];
        if (importedObjects.length > 0) {
          saveChunkedObjects(mapDir, importedObjects);
        }
        const iw = importedMap.map?.width ?? 0;
        const ih = importedMap.map?.height ?? 0;
        if (importedMap.map?.tiles?.length > 0 && iw > 0 && ih > 0) {
          saveChunkedTiles(mapDir, importedMap.map.tiles, iw, ih);
        }
        if (importedMap.map?.heights?.length > 0 && iw > 0 && ih > 0) {
          saveChunkedHeights(mapDir, importedMap.map.heights, iw, ih);
        }
        // Write metadata-only map.json (tiles/heights/objects stripped)
        const metadataOnly: KCMapFile = {
          ...importedMap,
          placedObjects: [],
          map: { ...importedMap.map, tiles: [], heights: [] },
        };
        writeFileSync(resolve(mapDir, 'map.json'), JSON.stringify(metadataOnly, null, 2));

        return jsonResponse({ ok: true, mapId });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Import failed' }, 500);
      }
    }

    if (url.pathname === '/api/editor/delete-map' && req.method === 'POST') {
      if (!isAdminRequest(req, server)) return adminForbidden();
      if (!bodyWithinLimit(req, BODY_LIMIT_AUTH)) return tooLarge();
      try {
        const body = await req.json() as { mapId: string };
        const mapId = body.mapId;
        if (!mapId) return jsonResponse({ ok: false, error: 'mapId required' }, 400);
        const mapDir = resolve(MAPS_DIR, mapId);
        if (!mapDir.startsWith(MAPS_DIR)) return new Response('Forbidden', { status: 403 });
        if (!existsSync(mapDir)) return jsonResponse({ ok: false, error: 'Map not found' }, 404);
        rmSync(mapDir, { recursive: true, force: true });
        return jsonResponse({ ok: true });
      } catch (e: any) {
        return jsonResponse({ ok: false, error: e.message || 'Delete failed' }, 500);
      }
    }

    // --- Map Assets ---

    if (url.pathname.startsWith('/maps/')) {
      const mapPath = url.pathname.slice(6); // remove '/maps/'
      // Refuse to serve backup snapshots. These contain prior map states which
      // an attacker could enumerate (ISO timestamps are predictable) to find
      // old object placements, NPC spawns, or interim editor saves. Backups
      // are an admin operations concern, not public game data.
      if (mapPath.includes('/backups/') || mapPath.endsWith('/backups')) {
        return new Response('Forbidden', { status: 403 });
      }
      // Symlink-safe path resolution
      const filePath = resolveWithinBase(MAPS_DIR, mapPath);
      if (!filePath) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        // For map.json requests, reassemble placedObjects from chunk files
        if (mapPath.endsWith('/map.json')) {
          const mapDir = resolve(filePath, '..');
          const mapFile: KCMapFile = JSON.parse(readFileSync(filePath, 'utf-8'));
          // If ?chunked=1, skip reassembly — serve metadata-only map.json
          // (empty tiles/heights arrays, but all metadata intact)
          if (url.searchParams.get('chunked') !== '1') {
            const chunked = loadChunkedObjects(mapDir);
            if (chunked) mapFile.placedObjects = chunked;
            reassembleChunkedMapData(mapDir, mapFile);
          }
          return new Response(JSON.stringify(mapFile), {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
          });
        }
        const content = readFileSync(filePath);
        return new Response(content, {
          headers: {
            'Content-Type': getMimeType(filePath),
            'Cache-Control': 'no-cache',
          },
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    }

    // --- KC Editor Assets (GLB models, textures) ---

    if (url.pathname.startsWith('/assets/')) {
      const decodedPath = decodeURIComponent(url.pathname);
      const publicAssetsDir = resolve(import.meta.dir, '../../client/public');
      for (const baseDir of [CLIENT_DIST, publicAssetsDir]) {
        const filePath = resolve(baseDir, decodedPath.slice(1));
        if (!filePath.startsWith(baseDir)) continue;
        try {
          const content = readFileSync(filePath);
          // Vite emits hashed filenames into client/dist/assets/ — those JS
          // and CSS chunks are content-addressed and safe to cache forever.
          // Everything else under /assets/ (GLBs, textures, raw JSON pulled
          // from client/public/assets/) still uses a short cache so swapped
          // assets show up without forcing browser-data clears during dev.
          const isHashedBundle = filePath.endsWith('.js') || filePath.endsWith('.css');
          const cacheControl = isHashedBundle
            ? 'public, max-age=31536000, immutable'
            : 'no-cache, must-revalidate';
          return new Response(content, {
            headers: {
              'Content-Type': getMimeType(filePath),
              'Cache-Control': cacheControl,
            },
          });
        } catch { /* try next */ }
      }
      return new Response('Not Found', { status: 404 });
    }

    // --- Static File Serving ---

    const response = serveStatic(url.pathname);
    if (response) return response;

    return new Response('Not Found', { status: 404 });
  },

  websocket: {
    perMessageDeflate: true,
    // Hard cap on incoming WS message size. Game packets max out at a few
    // hundred bytes (movement path of 200 waypoints ≈ 800 bytes); chat messages
    // are capped client-side to 200 chars and server-side to 4096 bytes. 16 KB
    // is comfortably above both. Without this, a hostile client can send a
    // single 1 GB frame and OOM the process before our handler-level checks
    // ever run.
    maxPayloadLength: 16 * 1024,
    open(ws: import('bun').ServerWebSocket<SocketData>) {
      // Per-account cap: refuse + close if this account already has too many
      // sockets in flight. Mark the slot as "reserved" via a flag on ws.data
      // so close() knows whether to release.
      if (!tryReserveWsSlot(ws.data.accountId)) {
        try { ws.close(1008, 'Too many connections for this account'); } catch {}
        return;
      }
      (ws.data as SocketData & { _slotHeld?: boolean })._slotHeld = true;
      if (ws.data.type === 'game') {
        handleGameSocketOpen(ws as import('bun').ServerWebSocket<GameSocketData>, world);
      } else {
        handleChatSocketOpen(ws as import('bun').ServerWebSocket<ChatSocketData>, world);
      }
    },
    message(ws: import('bun').ServerWebSocket<SocketData>, message: string | Buffer) {
      if (ws.data.type === 'game') {
        const buf = message instanceof ArrayBuffer ? message : (message as unknown as Buffer).buffer.slice(0) as ArrayBuffer;
        handleGameSocketMessage(ws as import('bun').ServerWebSocket<GameSocketData>, buf, world);
      } else {
        handleChatSocketMessage(ws as import('bun').ServerWebSocket<ChatSocketData>, String(message), world);
      }
    },
    close(ws: import('bun').ServerWebSocket<SocketData>) {
      // Only release a slot we actually reserved (close fires even when the
      // cap-refusal path closed the socket, but _slotHeld won't be set there).
      if ((ws.data as SocketData & { _slotHeld?: boolean })._slotHeld) {
        releaseWsSlot(ws.data.accountId);
      }
      if (ws.data.type === 'game') {
        handleGameSocketClose(ws as import('bun').ServerWebSocket<GameSocketData>, world);
      } else {
        handleChatSocketClose(ws as import('bun').ServerWebSocket<ChatSocketData>, world);
      }
    },
  },
});

console.log(`ProjectRS server running on http://localhost:${server.port}`);
console.log(`Game WebSocket: ws://localhost:${server.port}${GAME_WS_PATH}`);
console.log(`Chat WebSocket: ws://localhost:${server.port}${CHAT_WS_PATH}`);
console.log(`World tick rate: ${600}ms — ${world.players.size} players online`);

