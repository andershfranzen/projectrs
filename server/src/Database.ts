import { Database as SQLiteDB } from 'bun:sqlite';
import { randomBytes } from 'crypto';
import type { Player } from './entity/Player';
import type { SkillBlock, SkillId, MeleeStance, PlayerAppearance } from '@projectrs/shared';
import { ALL_SKILLS, SKILL_NAMES, combatLevel, initSkills, xpForLevel, normalizeAppearance, validateDeviceId, validatePassword, validateUsername } from '@projectrs/shared';
import type { EquipSlot } from './entity/Player';

const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const ACCOUNT_CREATION_CLOSED_MESSAGE = 'We have decided to close for new accounts until the Alpha launch. Join our Discord for more info.';
const PUBLIC_SIGNUPS_ENABLED = Bun.env.PUBLIC_SIGNUPS_ENABLED === '1';
const RESET_BOBS_BURIAL_MIGRATION_ID = 'reset_bobs_burial_2026_05_18';
const BOBS_BURIAL_QUEST_ID = "Bob's Burial";
const SUSPECT_SKETCH_ITEM_ID = 236;
const HISCORE_EXCLUDED_USERNAMES = new Set(['blackberry']);

export interface SessionInfo {
  accountId: number;
  username: string;
  isAdmin: boolean;
  /** Browser device ID captured at login. Plumbed through the WS upgrade to
   *  the Player so login_history can record it for cross-account device
   *  correlation. Empty string when the client didn't supply one. */
  deviceId: string;
  /** HttpOnly cookie binding created with the session. WebSocket upgrades must
   *  present this alongside the JS-visible token, so a copied token alone
   *  cannot open raw game/chat sockets. */
  wsSecret: string;
}

export interface CreatedSession {
  token: string;
  wsSecret: string;
}

/** Persisted row in the bot_stats table. Strings are JSON-encoded blobs
 *  (the BotStats class parses/serializes them). Counters are aggregates
 *  that survive across sessions, samples are rolling windows. */
export interface BotStatsRow {
  total_skilling_actions: number;
  total_combat_swings: number;
  total_movements: number;
  total_chat_messages: number;
  total_session_minutes: number;
  total_flag_events: number;
  total_suspicious_packets: number;
  last_chat_ts: number | null;
  last_action_ts: number | null;
  last_login_ts: number | null;
  /** Persisted manual-review priority derived from the latest session summary. */
  risk_score: number;
  risk_level: string;
  risk_reasons: string;
  /** JSON array of recent tick-align deltas (ms past tick boundary). Capped at 100. */
  tick_align_samples: string;
  /** JSON array of recent reaction times (ms after NPC death → next attack). Capped at 50. */
  reaction_samples: string;
  /** JSON array of recent client heartbeat intervals in ms. Capped at 100. */
  ping_interval_samples: string;
  /** JSON map of "x,z" tile → visit count. Capped at 100 entries. */
  path_destinations: string;
  /** JSON map of route/action signatures → count. Capped at 100 entries. */
  action_signatures?: string;
  /** JSON map of deviceId → login count. Used to catch fresh-ID-per-login bots. */
  device_ids: string;
  /** JSON map of invalid packet reason → count. */
  suspicious_packet_reasons?: string;
  /** JSON map of skill → xp at session start. Used to compute session-rate. */
  xp_baseline: string;
  /** JSON blob of the last computed session summary (flags + stats). */
  last_session_summary: string | null;
  /** JSON array of recent finalized summaries. */
  session_history?: string;
}

export interface AdminBotPacketReason {
  reason: string;
  count: number;
}

export interface AdminBotPathDestination {
  tile: string;
  count: number;
}

export interface AdminSharedDeviceAlt {
  accountId: number;
  username: string;
  devices: number;
  logins: number;
  lastSeenTs: number | null;
}

export interface AdminBotReviewAccount {
  accountId: number;
  username: string;
  isAdmin: boolean;
  riskScore: number;
  riskLevel: string;
  riskReasons: string[];
  totalSkillingActions: number;
  totalCombatSwings: number;
  totalMovements: number;
  totalChatMessages: number;
  totalSessionMinutes: number;
  totalFlagEvents: number;
  totalSuspiciousPackets: number;
  lastChatTs: number | null;
  lastActionTs: number | null;
  lastLoginTs: number | null;
  lastIp: string | null;
  lastReverseDns: string | null;
  lastDeviceId: string | null;
  lastSessionMinutes: number | null;
  botStatsUpdatedAt: number | null;
  tickAlignSampleCount: number;
  reactionSampleCount: number;
  pingIntervalSampleCount: number;
  pathDestinationCount: number;
  topPathRepetition: number | null;
  topPathDestinations: AdminBotPathDestination[];
  deviceIdsSeen: number;
  suspiciousPacketReasons: AdminBotPacketReason[];
  sessionHistory: Array<Record<string, unknown>>;
  chatRatePerHour: number | null;
  actionsPerHour: number | null;
  actionsPerChat: number | null;
  sharedDeviceAlts: AdminSharedDeviceAlt[];
  lastSessionSummary: Record<string, unknown> | null;
  accountBan: AccountBanRecord | null;
  ipBan: IpBanRecord | null;
}

/** Bump this constant to force every existing account to spawn at the map's
 *  default spawnPoint on their next login (one-time per bump). Saved skills,
 *  inventory, bank, etc. are preserved — only position is reset. On respawn
 *  the player_state row's respawn_version is updated to this value, so
 *  subsequent logins use the saved position normally. */
export const WORLD_RESPAWN_VERSION = 4;

export interface SavedPlayerState {
  x: number;
  z: number;
  /** Effective walking Y at save time, captured server-side via
   *  GameMap.getEffectiveHeightOnFloor. Persisted so a player who logged out
   *  on an elevated tile (texture-plane bridge, e.g. building interiors at
   *  y≈2.73) respawns at the right elevation — without this, the client's
   *  getEffectiveHeight gates elevation reveal on the player's current Y,
   *  which is 0 at spawn time, dropping them through the floor. */
  y: number;
  floor: number;
  mapLevel: string;
  skills: SkillBlock;
  inventory: ({ itemId: number; quantity: number } | null)[];
  equipment: Map<EquipSlot, number>;
  stance: MeleeStance;
  appearance: PlayerAppearance | null;
  bank: ({ itemId: number; quantity: number } | null)[];
  respawnVersion: number;
  quests: Record<string, { stage: number; triggerProgress: number }>;
  renown: number;
}

export interface HiscoreCategory {
  id: string;
  name: string;
  hasXp: boolean;
}

export interface HiscoreRow {
  rank: number;
  username: string;
  level: number;
  xp: number;
  dailyXp: number;
}

export interface HiscoreResponse {
  category: HiscoreCategory;
  categories: HiscoreCategory[];
  rows: HiscoreRow[];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
}

export interface HiscoreProfileRow {
  category: HiscoreCategory;
  rank: number;
  level: number;
  xp: number;
  dailyXp: number;
}

export interface HiscoreProfileResponse {
  username: string;
  rows: HiscoreProfileRow[];
}

interface RankedHiscoreRow extends HiscoreRow {
  accountId: number;
}

interface HiscorePlayerRecord {
  accountId: number;
  username: string;
  skills: SkillBlock;
}

function isHiscoreExcludedUsername(username: string): boolean {
  return HISCORE_EXCLUDED_USERNAMES.has(username.trim().toLowerCase());
}

export interface BanInfo {
  reason: string;
  bannedAt: number;
  expiresAt: number | null;
}
export interface AccountBanRecord extends BanInfo {
  accountId: number;
  username: string;
  bannedBy: string;
}
export interface IpBanRecord extends BanInfo {
  ip: string;
  bannedBy: string;
}

function removeQuestFromSavedState(rawJson: string | null, questId: string): { json: string; changed: boolean } {
  try {
    const parsed = rawJson ? JSON.parse(rawJson) as Record<string, unknown> : {};
    if (!parsed || typeof parsed !== 'object' || !Object.prototype.hasOwnProperty.call(parsed, questId)) {
      return { json: rawJson || '{}', changed: false };
    }
    delete parsed[questId];
    return { json: JSON.stringify(parsed), changed: true };
  } catch {
    return { json: rawJson || '{}', changed: false };
  }
}

function removeItemFromSavedSlots(rawJson: string | null, fallbackSize: number, itemId: number): { json: string; changed: boolean } {
  try {
    const parsed = rawJson ? JSON.parse(rawJson) as unknown : [];
    const slots = Array.isArray(parsed) ? parsed : new Array(fallbackSize).fill(null);
    let changed = false;
    const cleaned = slots.map(slot => {
      if (!slot || typeof slot !== 'object') return slot;
      const maybeSlot = slot as { itemId?: unknown };
      if (maybeSlot.itemId !== itemId) return slot;
      changed = true;
      return null;
    });
    return { json: changed ? JSON.stringify(cleaned) : (rawJson || JSON.stringify(slots)), changed };
  } catch {
    return { json: rawJson || JSON.stringify(new Array(fallbackSize).fill(null)), changed: false };
  }
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonNumberArray(raw: string | null | undefined): number[] {
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)) : [];
  } catch {
    return [];
  }
}

function parseJsonNumberRecord(raw: string | null | undefined): Record<string, number> {
  try {
    const parsed = JSON.parse(raw ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw ?? 'null') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseJsonObjectArray(raw: string | null | undefined): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is Record<string, unknown> => (
      !!value && typeof value === 'object' && !Array.isArray(value)
    ));
  } catch {
    return [];
  }
}

function topNumberRecordEntries(record: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(record)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function topRecordRatio(record: Record<string, number>): number | null {
  let total = 0;
  let max = 0;
  for (const value of Object.values(record)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    total += value;
    if (value > max) max = value;
  }
  return total > 0 ? max / total : null;
}

function riskLevelForScore(score: number): string {
  if (score >= 85) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function hasLegacyBotRiskReasons(reasons: string[]): boolean {
  return reasons.some((reason) => (
    reason.includes('tick-aligned action timing')
    || reason.includes('invalid/stale gameplay packets')
    || reason.includes('heavy packet fuzzing pattern')
    || reason.includes('lifetime invalid packet volume')
  ));
}

function hardInvalidPacketCount(reasons: Record<string, number>): number {
  let total = 0;
  for (const [reason, count] of Object.entries(reasons)) {
    if (reason.startsWith('rate-limit:')
      || reason === 'malformed-frame'
      || reason === 'unknown-opcode'
      || reason === 'bad-move-path-length'
      || reason === 'truncated-move-path'
      || reason === 'bad-cursor-x'
      || reason === 'bad-cursor-y') {
      total += count;
    }
  }
  return total;
}

function calibratedLegacyBotRisk(input: {
  storedReasons: string[];
  totalSessionMinutes: number;
  totalSkillingActions: number;
  totalCombatSwings: number;
  totalMovements: number;
  totalChatMessages: number;
  totalFlagEvents: number;
  totalSuspiciousPackets: number;
  pathDestinations: Record<string, number>;
  suspiciousReasons: Record<string, number>;
}): { score: number; level: string; reasons: string[] } | null {
  if (!hasLegacyBotRiskReasons(input.storedReasons)) return null;
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    if (points <= 0) return;
    score += points;
    reasons.push(`${reason} (+${points})`);
  };
  const activeActions = input.totalSkillingActions + input.totalCombatSwings + input.totalMovements;
  const hours = input.totalSessionMinutes > 0 ? input.totalSessionMinutes / 60 : null;
  const chatRate = hours ? input.totalChatMessages / hours : null;
  const pathRatio = topRecordRatio(input.pathDestinations);
  const hardInvalid = hardInvalidPacketCount(input.suspiciousReasons);

  if (input.totalSessionMinutes >= 1200 && activeActions >= 25000 && chatRate !== null && chatRate < 1) {
    add(32, `extreme low-social high-activity lifetime (${chatRate.toFixed(2)} chats/hr, ${activeActions} actions)`);
  } else if (input.totalSessionMinutes >= 600 && activeActions >= 10000 && chatRate !== null && chatRate < 2) {
    add(22, `low-social high-activity lifetime (${chatRate.toFixed(2)} chats/hr, ${activeActions} actions)`);
  }
  if (input.totalMovements >= 5000 && pathRatio !== null && pathRatio >= 0.12) {
    add(pathRatio >= 0.2 ? 22 : 16, `lifetime path concentration (${pathRatio.toFixed(2)})`);
  }
  if (hardInvalid >= 25) add(hardInvalid >= 100 ? 22 : 14, `lifetime hard invalid packets (${hardInvalid})`);
  if (input.totalFlagEvents >= 25) add(8, `lifetime flag history (${input.totalFlagEvents} prior fires)`);
  else if (input.totalFlagEvents >= 10) add(4, `lifetime flag history (${input.totalFlagEvents} prior fires)`);
  else if (input.totalFlagEvents >= 5) add(2, `lifetime flag history (${input.totalFlagEvents} prior fires)`);
  if (input.totalSuspiciousPackets >= 500) add(4, `lifetime stale/noisy invalid packet volume (${input.totalSuspiciousPackets})`);
  else if (input.totalSuspiciousPackets >= 100) add(2, `lifetime stale/noisy invalid packet volume (${input.totalSuspiciousPackets})`);

  const capped = Math.min(100, Math.round(score));
  return {
    score: capped,
    level: riskLevelForScore(capped),
    reasons: reasons.slice(0, 12),
  };
}

export class GameDatabase {
  private db: SQLiteDB;
  private lastHiscoreSnapshotPruneAt = 0;

  constructor(dbPath: string = 'projectrs.db') {
    this.db = new SQLiteDB(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        created_at INTEGER DEFAULT (unixepoch()),
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS player_state (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
        x REAL DEFAULT 96.5,
        z REAL DEFAULT 96.5,
        map_level TEXT DEFAULT 'kcmap',
        skills TEXT DEFAULT '{}',
        inventory TEXT DEFAULT '[]',
        equipment TEXT DEFAULT '{}',
        stance TEXT DEFAULT 'accurate',
        appearance TEXT DEFAULT NULL,
        renown INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER DEFAULT (unixepoch())
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS server_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);

    // Migration: add appearance column if missing (existing databases)
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN appearance TEXT DEFAULT NULL`);
    } catch { /* column already exists */ }
    // Migration: add floor column so multi-floor positions persist across logout
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN floor INTEGER DEFAULT 0`);
    } catch { /* column already exists */ }
    // Migration: add y column so elevated-tile spawns restore at correct height
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN y REAL DEFAULT 0`);
    } catch { /* column already exists */ }
    // Migration: add is_admin column so admin authorization is DB-driven instead
    // of hardcoded in source. Backfill the legacy hardcoded admin so existing
    // deployments keep working.
    try {
      this.db.exec(`ALTER TABLE accounts ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    this.db.query(`UPDATE accounts SET is_admin = 1 WHERE username = 'mogn' AND is_admin = 0`).run();
    // Migration: per-account bank container. JSON blob keeps the schema simple
    // and matches inventory/equipment storage.
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN bank TEXT DEFAULT '[]'`);
    } catch { /* column already exists */ }
    // Migration: respawn_version. Default 0 so every existing row trips the
    // < WORLD_RESPAWN_VERSION check in the login flow and gets relocated to
    // the current map spawn one time. After that, normal save flow writes
    // the new version and the row stops tripping.
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN respawn_version INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    // Migration: quests JSON column. {questId: {stage, triggerProgress}}.
    // stage: -1 = completed. Missing entries = not started.
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN quests TEXT NOT NULL DEFAULT '{}'`);
    } catch { /* column already exists */ }
    // Migration: player renown earned from quest completions.
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN renown INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    this.runOneTimeDataMigrations();

    // Bot detection telemetry. One row per account, updated on session flush
    // (every 5 min during play + at logout). Survives restarts so an account
    // that bot-grinds across multiple sessions accumulates signal over time.
    // JSON-blob columns hold sample arrays (capped) and per-skill maps —
    // simpler than a normalized schema and grep-friendly when debugging.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_stats (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
        total_skilling_actions INTEGER NOT NULL DEFAULT 0,
        total_combat_swings INTEGER NOT NULL DEFAULT 0,
        total_movements INTEGER NOT NULL DEFAULT 0,
        total_chat_messages INTEGER NOT NULL DEFAULT 0,
        total_session_minutes INTEGER NOT NULL DEFAULT 0,
        total_flag_events INTEGER NOT NULL DEFAULT 0,
        total_suspicious_packets INTEGER NOT NULL DEFAULT 0,
        last_chat_ts INTEGER,
        last_action_ts INTEGER,
        last_login_ts INTEGER,
        risk_score INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'low',
        risk_reasons TEXT NOT NULL DEFAULT '[]',
        tick_align_samples TEXT NOT NULL DEFAULT '[]',
        reaction_samples TEXT NOT NULL DEFAULT '[]',
        ping_interval_samples TEXT NOT NULL DEFAULT '[]',
        path_destinations TEXT NOT NULL DEFAULT '{}',
        action_signatures TEXT NOT NULL DEFAULT '{}',
        device_ids TEXT NOT NULL DEFAULT '{}',
        suspicious_packet_reasons TEXT NOT NULL DEFAULT '{}',
        xp_baseline TEXT NOT NULL DEFAULT '{}',
        last_session_summary TEXT,
        session_history TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN ping_interval_samples TEXT NOT NULL DEFAULT '[]'`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN device_ids TEXT NOT NULL DEFAULT '{}'`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN total_suspicious_packets INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN risk_score INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'low'`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN risk_reasons TEXT NOT NULL DEFAULT '[]'`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN action_signatures TEXT NOT NULL DEFAULT '{}'`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN suspicious_packet_reasons TEXT NOT NULL DEFAULT '{}'`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN session_history TEXT NOT NULL DEFAULT '[]'`);
    } catch { /* column already exists */ }

    // Login history: one row per session. IP is captured at WS upgrade time.
    // Indexed by ip + account_id + login_ts so the bot-review CLI can cheaply
    // find "what other accounts used this IP" and "what IPs has this account
    // ever used." Critical for catching gold-farmer rings — they routinely
    // run 5-20 accounts behind one IP and trade items between them.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS login_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        ip_address TEXT NOT NULL,
        login_ts INTEGER NOT NULL,
        logout_ts INTEGER,
        session_minutes INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_login_history_ip ON login_history(ip_address);
      CREATE INDEX IF NOT EXISTS idx_login_history_account ON login_history(account_id);
      CREATE INDEX IF NOT EXISTS idx_login_history_login_ts ON login_history(login_ts);
    `);
    // Migration: reverse_dns column. Populated async after login by a single
    // PTR lookup (best-effort — DNS failures are normal for residential IPs).
    // Pattern-match later in the review CLI to flag known-VPN / known-datacenter
    // PTR strings. Commodity VPNs almost always have telltale PTRs ("vpn",
    // "proxy", datacenter hostnames); sophisticated VPNs use clean ones and
    // slip through — that's the maintenance burden the user accepted.
    try {
      this.db.exec(`ALTER TABLE login_history ADD COLUMN reverse_dns TEXT`);
    } catch { /* column already exists */ }
    // Migration: device_id on sessions + login_history. Browser-scoped UUID
    // generated client-side and persisted in localStorage. Enforces the
    // one-account-per-browser rule (gentler than per-IP, doesn't break
    // shared-household play) and gives bot-review a second alt-detection axis.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN device_id TEXT NOT NULL DEFAULT ''`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN ws_secret TEXT NOT NULL DEFAULT ''`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE login_history ADD COLUMN device_id TEXT NOT NULL DEFAULT ''`);
    } catch { /* column already exists */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_login_history_device ON login_history(device_id)`);

    // Browser-held device signing keys. The private key stays in IndexedDB on
    // the client; the server stores only the public JWK and requires it to sign
    // each game-channel ECDH transcript before a player is spawned.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_device_keys (
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        device_id TEXT NOT NULL,
        public_jwk TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, device_id)
      );
    `);

    // Account + IP bans. Two tables instead of a single unified `bans` table so
    // each enforcement point (login API, WS upgrade) hits exactly one indexed
    // PK lookup. `banned_by` is a free-text admin username rather than a FK
    // because the admin who issued a ban may be deleted later and we don't
    // want to lose audit info.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_bans (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
        reason TEXT NOT NULL DEFAULT '',
        banned_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER,
        banned_by TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS ip_bans (
        ip_address TEXT PRIMARY KEY,
        reason TEXT NOT NULL DEFAULT '',
        banned_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER,
        banned_by TEXT NOT NULL DEFAULT ''
      );
    `);
    try {
      this.db.exec(`ALTER TABLE account_bans ADD COLUMN expires_at INTEGER`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE ip_bans ADD COLUMN expires_at INTEGER`);
    } catch { /* column already exists */ }

    // Door state persistence. One row per open (or otherwise non-default) door
    // — closed doors don't need a row (the in-memory default is closed). On
    // restart, World re-applies these to keep building interiors continuous
    // across server reboots. auto_close_at_tick is informational only.
    //
    // Keyed by (map, defId, tileX, tileZ) — stable across editor saves and
    // reboots. WorldObject runtime entity IDs come from a process-lifetime
    // counter assigned in spawn order; any editor change that adds, removes,
    // or reorders objects in placedObjects shifts every subsequent ID, so an
    // entity-ID-keyed row would silently latch onto the wrong door (with its
    // wall edges cleared) after a routine map edit.
    //
    // One-time migration: if a stale entity-id-keyed schema exists from a
    // pre-fix dev build, drop it. Production hasn't shipped this table yet
    // so the drop is safe.
    try {
      const cols = this.db.query("PRAGMA table_info(door_state)").all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some(c => c.name === 'tile_x')) {
        this.db.exec('DROP TABLE door_state');
      } else if (cols.length > 0 && !cols.some(c => c.name === 'floor')) {
        this.db.exec('ALTER TABLE door_state RENAME TO door_state_legacy_floor');
        this.db.exec(`
          CREATE TABLE door_state (
            map_level TEXT NOT NULL,
            def_id INTEGER NOT NULL,
            tile_x INTEGER NOT NULL,
            tile_z INTEGER NOT NULL,
            floor INTEGER NOT NULL DEFAULT 0,
            is_open INTEGER NOT NULL,
            auto_close_at_tick INTEGER,
            PRIMARY KEY (map_level, def_id, tile_x, tile_z, floor)
          );
        `);
        this.db.exec(`
          INSERT INTO door_state (map_level, def_id, tile_x, tile_z, floor, is_open, auto_close_at_tick)
          SELECT map_level, def_id, tile_x, tile_z, 0, is_open, auto_close_at_tick
          FROM door_state_legacy_floor
        `);
        this.db.exec('DROP TABLE door_state_legacy_floor');
      }
    } catch { /* table absent */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS door_state (
        map_level TEXT NOT NULL,
        def_id INTEGER NOT NULL,
        tile_x INTEGER NOT NULL,
        tile_z INTEGER NOT NULL,
        floor INTEGER NOT NULL DEFAULT 0,
        is_open INTEGER NOT NULL,
        auto_close_at_tick INTEGER,
        PRIMARY KEY (map_level, def_id, tile_x, tile_z, floor)
      );
    `);

    // World object respawn persistence. One row per currently-depleted
    // skilling object (trees, rocks, fishing spots). Stored as wall-clock
    // unix ms rather than ticks so a long downtime doesn't leave every node
    // depleted until the tick counter catches up — on boot, anything in the
    // past is dropped (respawns immediately) and anything in the future has
    // its remaining timer reconstructed. Keyed by stable identity for the
    // same reasons door_state is.
    try {
      const cols = this.db.query("PRAGMA table_info(world_object_respawn)").all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some(c => c.name === 'tile_x')) {
        this.db.exec('DROP TABLE world_object_respawn');
      } else if (cols.length > 0 && !cols.some(c => c.name === 'floor')) {
        this.db.exec('ALTER TABLE world_object_respawn RENAME TO world_object_respawn_legacy_floor');
        this.db.exec(`
          CREATE TABLE world_object_respawn (
            map_level TEXT NOT NULL,
            def_id INTEGER NOT NULL,
            tile_x INTEGER NOT NULL,
            tile_z INTEGER NOT NULL,
            floor INTEGER NOT NULL DEFAULT 0,
            respawn_at_unix_ms INTEGER NOT NULL,
            PRIMARY KEY (map_level, def_id, tile_x, tile_z, floor)
          );
        `);
        this.db.exec(`
          INSERT INTO world_object_respawn (map_level, def_id, tile_x, tile_z, floor, respawn_at_unix_ms)
          SELECT map_level, def_id, tile_x, tile_z, 0, respawn_at_unix_ms
          FROM world_object_respawn_legacy_floor
        `);
        this.db.exec('DROP TABLE world_object_respawn_legacy_floor');
      }
    } catch { /* table absent */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS world_object_respawn (
        map_level TEXT NOT NULL,
        def_id INTEGER NOT NULL,
        tile_x INTEGER NOT NULL,
        tile_z INTEGER NOT NULL,
        floor INTEGER NOT NULL DEFAULT 0,
        respawn_at_unix_ms INTEGER NOT NULL,
        PRIMARY KEY (map_level, def_id, tile_x, tile_z, floor)
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hiscore_snapshots (
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        category TEXT NOT NULL,
        bucket_start INTEGER NOT NULL,
        level INTEGER NOT NULL,
        xp INTEGER NOT NULL,
        PRIMARY KEY (account_id, category, bucket_start)
      );
      CREATE INDEX IF NOT EXISTS idx_hiscore_snapshots_category_bucket
        ON hiscore_snapshots(category, bucket_start);
    `);
  }

  private runOneTimeDataMigrations(): void {
    const alreadyResetBob = this.db.query('SELECT 1 FROM server_migrations WHERE id = ?')
      .get(RESET_BOBS_BURIAL_MIGRATION_ID);
    if (alreadyResetBob) return;

    const changed = this.resetBobBurialSavedState();
    this.db.query('INSERT INTO server_migrations (id) VALUES (?)').run(RESET_BOBS_BURIAL_MIGRATION_ID);
    console.log(`[migration] Reset Bob's Burial quest state for ${changed} saved player(s).`);
  }

  private resetBobBurialSavedState(): number {
    const rows = this.db.query('SELECT account_id, inventory, bank, quests FROM player_state')
      .all() as Array<{ account_id: number; inventory: string | null; bank: string | null; quests: string | null }>;
    const updates: Array<{ accountId: number; inventory: string; bank: string; quests: string }> = [];

    for (const row of rows) {
      const inventory = removeItemFromSavedSlots(row.inventory, 28, SUSPECT_SKETCH_ITEM_ID);
      const bank = removeItemFromSavedSlots(row.bank, 0, SUSPECT_SKETCH_ITEM_ID);
      const quests = removeQuestFromSavedState(row.quests, BOBS_BURIAL_QUEST_ID);
      if (!inventory.changed && !bank.changed && !quests.changed) continue;
      updates.push({
        accountId: row.account_id,
        inventory: inventory.json,
        bank: bank.json,
        quests: quests.json,
      });
    }

    if (updates.length === 0) return 0;
    const tx = this.db.transaction((rowsToUpdate: typeof updates) => {
      const stmt = this.db.query('UPDATE player_state SET inventory = ?, bank = ?, quests = ?, updated_at = unixepoch() WHERE account_id = ?');
      for (const update of rowsToUpdate) {
        stmt.run(update.inventory, update.bank, update.quests, update.accountId);
      }
    });
    tx(updates);
    return updates.length;
  }

  // -- Door state -----------------------------------------------------------

  saveDoorState(mapLevel: string, defId: number, tileX: number, tileZ: number, floor: number, isOpen: boolean, autoCloseAtTick: number | null): void {
    try {
      this.db.query(`
        INSERT INTO door_state (map_level, def_id, tile_x, tile_z, floor, is_open, auto_close_at_tick)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(map_level, def_id, tile_x, tile_z, floor) DO UPDATE SET
          is_open = excluded.is_open,
          auto_close_at_tick = excluded.auto_close_at_tick
      `).run(mapLevel, defId, tileX, tileZ, Math.max(0, Math.floor(floor)), isOpen ? 1 : 0, autoCloseAtTick);
    } catch (e) {
      console.error('saveDoorState failed:', e);
    }
  }

  loadAllDoorStates(): Array<{ mapLevel: string; defId: number; tileX: number; tileZ: number; floor: number; isOpen: boolean; autoCloseAtTick: number | null }> {
    try {
      const rows = this.db.query(`
        SELECT map_level, def_id, tile_x, tile_z, floor, is_open, auto_close_at_tick FROM door_state
      `).all() as Array<{ map_level: string; def_id: number; tile_x: number; tile_z: number; floor: number; is_open: number; auto_close_at_tick: number | null }>;
      return rows.map(r => ({
        mapLevel: r.map_level,
        defId: r.def_id,
        tileX: r.tile_x,
        tileZ: r.tile_z,
        floor: r.floor ?? 0,
        isOpen: r.is_open === 1,
        autoCloseAtTick: r.auto_close_at_tick,
      }));
    } catch (e) {
      console.error('loadAllDoorStates failed:', e);
      return [];
    }
  }

  clearDoorState(mapLevel: string, defId: number, tileX: number, tileZ: number, floor: number = 0): void {
    try {
      this.db.query('DELETE FROM door_state WHERE map_level = ? AND def_id = ? AND tile_x = ? AND tile_z = ? AND floor = ?')
        .run(mapLevel, defId, tileX, tileZ, Math.max(0, Math.floor(floor)));
    } catch (e) {
      console.error('clearDoorState failed:', e);
    }
  }

  // -- World object respawn -------------------------------------------------

  saveObjectRespawn(mapLevel: string, defId: number, tileX: number, tileZ: number, floor: number, respawnAtUnixMs: number): void {
    try {
      this.db.query(`
        INSERT INTO world_object_respawn (map_level, def_id, tile_x, tile_z, floor, respawn_at_unix_ms)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(map_level, def_id, tile_x, tile_z, floor) DO UPDATE SET
          respawn_at_unix_ms = excluded.respawn_at_unix_ms
      `).run(mapLevel, defId, tileX, tileZ, Math.max(0, Math.floor(floor)), respawnAtUnixMs);
    } catch (e) {
      console.error('saveObjectRespawn failed:', e);
    }
  }

  loadAllObjectRespawns(): Array<{ mapLevel: string; defId: number; tileX: number; tileZ: number; floor: number; respawnAtUnixMs: number }> {
    try {
      const rows = this.db.query(`
        SELECT map_level, def_id, tile_x, tile_z, floor, respawn_at_unix_ms FROM world_object_respawn
      `).all() as Array<{ map_level: string; def_id: number; tile_x: number; tile_z: number; floor: number; respawn_at_unix_ms: number }>;
      return rows.map(r => ({
        mapLevel: r.map_level,
        defId: r.def_id,
        tileX: r.tile_x,
        tileZ: r.tile_z,
        floor: r.floor ?? 0,
        respawnAtUnixMs: r.respawn_at_unix_ms,
      }));
    } catch (e) {
      console.error('loadAllObjectRespawns failed:', e);
      return [];
    }
  }

  clearObjectRespawn(mapLevel: string, defId: number, tileX: number, tileZ: number, floor: number = 0): void {
    try {
      this.db.query('DELETE FROM world_object_respawn WHERE map_level = ? AND def_id = ? AND tile_x = ? AND tile_z = ? AND floor = ?')
        .run(mapLevel, defId, tileX, tileZ, Math.max(0, Math.floor(floor)));
    } catch (e) {
      console.error('clearObjectRespawn failed:', e);
    }
  }

  async createAccount(username: string, password: string, deviceId: string = ''): Promise<{ ok: true; token: string; wsSecret: string; accountId: number; isAdmin: boolean } | { ok: false; error: string }> {
    if (!PUBLIC_SIGNUPS_ENABLED) return { ok: false, error: ACCOUNT_CREATION_CLOSED_MESSAGE };

    const usernameError = validateUsername(username);
    if (usernameError) return { ok: false, error: usernameError };
    const passwordError = validatePassword(password);
    if (passwordError) return { ok: false, error: passwordError };
    const deviceError = validateDeviceId(deviceId);
    if (deviceError) return { ok: false, error: deviceError };

    // Check if username exists
    const existing = this.db.query('SELECT id FROM accounts WHERE username = ?').get(username);
    if (existing) {
      return { ok: false, error: 'Username already taken' };
    }

    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });

    // Bootstrap admin: if no admin exists yet, the first 'mogn' signup gets
    // is_admin=1. Once any admin exists, new signups always get is_admin=0.
    // Keeps the historical "mogn is the dev admin" behavior working without
    // hardcoding the username outside this one bootstrap path.
    //
    // Race-safe: the count+insert pair runs inside a single IMMEDIATE
    // transaction so two concurrent "mogn" signups can't both see zero admins
    // and both get is_admin=1. SQLite serializes IMMEDIATE writes.
    const starterInventory = JSON.stringify([
      { itemId: 31, quantity: 1 },
      { itemId: 33, quantity: 1 }
    ]);
    const wantsAdmin = username.toLowerCase() === 'mogn';
    let accountId = 0;
    let isAdmin = 0;
    this.db.transaction(() => {
      const adminCount = (this.db.query('SELECT COUNT(*) as n FROM accounts WHERE is_admin = 1').get() as { n: number }).n;
      isAdmin = (adminCount === 0 && wantsAdmin) ? 1 : 0;
      const result = this.db.query('INSERT INTO accounts (username, password_hash, is_admin) VALUES (?, ?, ?)').run(username, passwordHash, isAdmin);
      accountId = Number(result.lastInsertRowid);
      this.db.query('INSERT INTO player_state (account_id, inventory) VALUES (?, ?)').run(accountId, starterInventory);
    }).immediate();

    // Create session
    const session = this.createSession(accountId, deviceId);
    return { ok: true, token: session.token, wsSecret: session.wsSecret, accountId, isAdmin: isAdmin === 1 };
  }

  async login(username: string, password: string, deviceId: string = ''): Promise<{ ok: true; token: string; wsSecret: string; username: string; accountId: number; isAdmin: boolean } | { ok: false; error: string }> {
    const row = this.db.query('SELECT id, username, password_hash, is_admin FROM accounts WHERE username = ?').get(username) as { id: number; username: string; password_hash: string; is_admin: number } | null;
    if (!row) {
      return { ok: false, error: 'Invalid username or password' };
    }

    const valid = await Bun.password.verify(password, row.password_hash);
    if (!valid) {
      return { ok: false, error: 'Invalid username or password' };
    }

    const session = this.createSession(row.id, deviceId);
    return { ok: true, token: session.token, wsSecret: session.wsSecret, username: row.username, accountId: row.id, isAdmin: row.is_admin === 1 };
  }

  loginFallbackAccount(username: string, deviceId: string = ''): { ok: true; token: string; wsSecret: string; username: string; accountId: number; isAdmin: boolean } {
    const starterInventory = JSON.stringify([
      { itemId: 31, quantity: 1 },
      { itemId: 33, quantity: 1 }
    ]);
    let accountId = 0;
    let normalizedUsername = username.toLowerCase();
    let isAdmin = 0;

    this.db.transaction(() => {
      let row = this.db.query('SELECT id, username, is_admin FROM accounts WHERE username = ?').get(normalizedUsername) as { id: number; username: string; is_admin: number } | null;
      if (!row) {
        const result = this.db.query('INSERT INTO accounts (username, password_hash, is_admin) VALUES (?, ?, 0)').run(normalizedUsername, 'fallback-login');
        accountId = Number(result.lastInsertRowid);
        this.db.query('INSERT OR IGNORE INTO player_state (account_id, inventory) VALUES (?, ?)').run(accountId, starterInventory);
        return;
      }
      accountId = row.id;
      normalizedUsername = row.username;
      isAdmin = row.is_admin;
      this.db.query('INSERT OR IGNORE INTO player_state (account_id, inventory) VALUES (?, ?)').run(accountId, starterInventory);
    }).immediate();

    const session = this.createSession(accountId, deviceId);
    return { ok: true, token: session.token, wsSecret: session.wsSecret, username: normalizedUsername, accountId, isAdmin: isAdmin === 1 };
  }

  createSession(accountId: number, deviceId: string = ''): CreatedSession {
    const token = randomBytes(32).toString('hex');
    const wsSecret = randomBytes(32).toString('hex');
    const expiresAt = Math.floor((Date.now() + SESSION_EXPIRY_MS) / 1000);
    // Drop any prior sessions for this account before inserting the new one.
    // Matches the "single active session" model already enforced in-game by
    // World.kickAccountIfOnline and prevents the sessions table from growing
    // unbounded per device-login.
    this.db.query('DELETE FROM sessions WHERE account_id = ?').run(accountId);
    this.db.query('INSERT INTO sessions (token, account_id, expires_at, device_id, ws_secret) VALUES (?, ?, ?, ?, ?)')
      .run(token, accountId, expiresAt, deviceId, wsSecret);
    return { token, wsSecret };
  }

  getSession(token: string): SessionInfo | null {
    if (!token) return null;
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.query(`
      SELECT s.account_id, a.username, a.is_admin, s.device_id, s.ws_secret
      FROM sessions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.token = ? AND s.expires_at > ?
    `).get(token, now) as { account_id: number; username: string; is_admin: number; device_id: string | null; ws_secret: string | null } | null;

    if (!row) return null;
    return {
      accountId: row.account_id,
      username: row.username,
      isAdmin: row.is_admin === 1,
      deviceId: row.device_id ?? '',
      wsSecret: row.ws_secret ?? '',
    };
  }

  ensureSessionWsSecret(token: string): string | null {
    if (!token) return null;
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.query('SELECT ws_secret FROM sessions WHERE token = ? AND expires_at > ?')
      .get(token, now) as { ws_secret: string | null } | null;
    if (!row) return null;
    if (row.ws_secret) return row.ws_secret;
    const wsSecret = randomBytes(32).toString('hex');
    this.db.query('UPDATE sessions SET ws_secret = ? WHERE token = ?').run(wsSecret, token);
    return wsSecret;
  }

  saveDeviceKey(accountId: number, deviceId: string, publicJwk: JsonWebKey): void {
    if (!accountId || !deviceId) throw new Error('missing account or device id');
    this.db.query(`
      INSERT INTO account_device_keys (account_id, device_id, public_jwk, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(account_id, device_id) DO UPDATE SET
        public_jwk = excluded.public_jwk,
        updated_at = excluded.updated_at
    `).run(accountId, deviceId, JSON.stringify(publicJwk));
  }

  loadDeviceKey(accountId: number, deviceId: string): JsonWebKey | null {
    if (!accountId || !deviceId) return null;
    const row = this.db.query(`
      SELECT public_jwk FROM account_device_keys
      WHERE account_id = ? AND device_id = ?
    `).get(accountId, deviceId) as { public_jwk: string } | null;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.public_jwk) as JsonWebKey;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Lookup admin status by username. Used by chat socket where the username is
   *  bound at WS upgrade time and the account_id isn't kept on the socket. */
  isAdminUsername(username: string): boolean {
    const row = this.db.query('SELECT is_admin FROM accounts WHERE username = ?').get(username) as { is_admin: number } | null;
    return row?.is_admin === 1;
  }

  logout(token: string): void {
    this.db.query('DELETE FROM sessions WHERE token = ?').run(token);
  }

  /** Run a single player_state UPDATE. Shared body between the single-row
   *  savePlayerState() and the batched savePlayersBatch() — keeps the column
   *  list and serialization logic in one place. Does NOT wrap in a transaction
   *  itself; callers wrap as appropriate (batch transaction vs implicit per-
   *  call autocommit). */
  private savePlayerRow(accountId: number, player: Player, effectiveY: number): void {
    const skills: Record<string, { xp: number; level: number; currentLevel: number }> = {};
    for (const id of ALL_SKILLS) {
      skills[id] = {
        xp: player.skills[id].xp,
        level: player.skills[id].level,
        currentLevel: player.skills[id].currentLevel,
      };
    }

    const equipment: Record<string, number> = {};
    for (const [slot, itemId] of player.equipment) {
      equipment[slot] = itemId;
    }

    this.db.query(`
      UPDATE player_state SET
        x = ?, z = ?, y = ?, floor = ?,
        map_level = ?,
        skills = ?, inventory = ?, equipment = ?,
        stance = ?, appearance = COALESCE(?, appearance), bank = ?, quests = ?, renown = ?, updated_at = unixepoch()
      WHERE account_id = ?
    `).run(
      player.position.x, player.position.y, effectiveY, player.currentFloor,
      player.currentMapLevel,
      JSON.stringify(skills),
      JSON.stringify(player.inventory),
      JSON.stringify(equipment),
      player.stance,
      player.appearance ? JSON.stringify(player.appearance) : null,
      JSON.stringify(player.bank),
      JSON.stringify(player.quests),
      Math.max(0, Math.floor(player.renown || 0)),
      accountId,
    );
    this.saveHiscoreSnapshots(accountId, player.skills);
  }

  savePlayerState(accountId: number, player: Player, effectiveY: number): void {
    this.savePlayerRow(accountId, player, effectiveY);
  }

  /** Cheap position-only checkpoint used by movement. Full state persistence
   *  still happens through savePlayerState/savePlayersBatch; this narrows the
   *  rollback window for relog/restart without serializing inventory, skills,
   *  bank, and quest JSON every walking tick. */
  savePlayerPosition(accountId: number, player: Player, effectiveY: number): void {
    this.db.query(`
      UPDATE player_state SET
        x = ?, z = ?, y = ?, floor = ?, map_level = ?, updated_at = unixepoch()
      WHERE account_id = ?
    `).run(
      player.position.x,
      player.position.y,
      effectiveY,
      player.currentFloor,
      player.currentMapLevel,
      accountId,
    );
  }

  /** Batched save: wraps every per-row UPDATE in a single SQLite transaction
   *  so 100+ players flush in one fsync instead of N. Called by the 15s
   *  auto-save loop in World.saveAllPlayers.
   *
   *  Failure mode: if any row throws (transient SQLITE_BUSY, structurally
   *  bad in-memory player field that JSON.stringify can't handle), the
   *  whole transaction rolls back — losing saves for every player in the
   *  batch. We fall back to per-row autocommits in that case so a single
   *  bad row only loses its own state, matching the pre-batch behavior. */
  savePlayersBatch(saves: Array<{ accountId: number; player: Player; effectiveY: number }>): void {
    if (saves.length === 0) return;
    const tx = this.db.transaction((rows: Array<{ accountId: number; player: Player; effectiveY: number }>) => {
      for (const r of rows) {
        this.savePlayerRow(r.accountId, r.player, r.effectiveY);
      }
    });
    try {
      tx(saves);
    } catch (e) {
      console.error('savePlayersBatch failed; falling back to per-row saves:', e);
      for (const r of saves) {
        try {
          this.savePlayerRow(r.accountId, r.player, r.effectiveY);
        } catch (rowErr) {
          console.error(`per-row save failed for accountId=${r.accountId}:`, rowErr);
        }
      }
    }
  }

  loadPlayerState(accountId: number): SavedPlayerState | null {
    const row = this.db.query('SELECT x, z, y, floor, map_level, skills, inventory, equipment, stance, appearance, bank, respawn_version, quests, renown FROM player_state WHERE account_id = ?')
      .get(accountId) as { x: number; z: number; y: number | null; floor: number | null; map_level: string; skills: string; inventory: string; equipment: string; stance: string; appearance: string | null; bank: string | null; respawn_version: number | null; quests: string | null; renown: number | null } | null;

    if (!row) return null;

    // Parse skills
    let skills: SkillBlock;
    try {
      const saved = JSON.parse(row.skills) as Record<string, { xp: number; level: number; currentLevel: number }>;
      skills = initSkills(); // Start with defaults
      for (const id of ALL_SKILLS) {
        if (saved[id]) {
          skills[id].xp = saved[id].xp;
          skills[id].level = saved[id].level;
          skills[id].currentLevel = saved[id].currentLevel;
        }
      }
    } catch {
      skills = initSkills();
    }

    // Parse inventory. Post-load validation: a corrupted DB row (or hostile
    // migration) could carry negative quantities, non-integer item IDs, or
    // quantities past MAX_STACK. Drop bad entries — silently clamping a 4B
    // coin stack to 2.1B is the kinder behavior, but inviting an attacker to
    // craft a save row that imports as a 2.1B stack is worse. Same shape for
    // equipment/bank below.
    const MAX_STACK = 0x7FFFFFFF;
    const sanitizeSlot = (s: unknown): { itemId: number; quantity: number } | null => {
      if (!s || typeof s !== 'object') return null;
      const o = s as { itemId?: unknown; quantity?: unknown };
      const id = o.itemId;
      const q = o.quantity;
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null;
      if (typeof q !== 'number' || !Number.isInteger(q) || q <= 0 || q > MAX_STACK) return null;
      return { itemId: id, quantity: q };
    };
    let inventory: ({ itemId: number; quantity: number } | null)[];
    try {
      const raw = JSON.parse(row.inventory) as unknown[];
      inventory = Array.isArray(raw) ? raw.map(sanitizeSlot) : new Array(28).fill(null);
    } catch {
      inventory = new Array(28).fill(null);
    }

    // Parse equipment — same validation
    let equipment: Map<EquipSlot, number>;
    try {
      const saved = JSON.parse(row.equipment) as Record<string, unknown>;
      equipment = new Map();
      const validSlots: Set<string> = new Set(['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape']);
      for (const [slot, itemId] of Object.entries(saved)) {
        if (!validSlots.has(slot)) continue;
        if (typeof itemId !== 'number' || !Number.isInteger(itemId) || itemId <= 0) continue;
        equipment.set(slot as EquipSlot, itemId);
      }
    } catch {
      equipment = new Map();
    }

    // Parse stance
    const validStances = ['accurate', 'aggressive', 'defensive', 'controlled'];
    const stance = validStances.includes(row.stance) ? row.stance as MeleeStance : 'accurate';

    // Parse appearance (normalizeAppearance fills in missing fields from older saves)
    let appearance: PlayerAppearance | null = null;
    if (row.appearance) {
      try { appearance = normalizeAppearance(JSON.parse(row.appearance)); } catch { /* null */ }
    }

    // Parse bank — JSON array of slots, possibly null. Older accounts may
    // have no bank row yet (column was added by migration); fall back to empty.
    // Same sanitization as inventory.
    let bank: ({ itemId: number; quantity: number } | null)[];
    try {
      const raw = row.bank ? JSON.parse(row.bank) as unknown[] : [];
      bank = Array.isArray(raw) ? raw.map(sanitizeSlot) : [];
    } catch {
      bank = [];
    }

    // Parse quests. Sanitize: only accept entries with numeric stage +
    // triggerProgress. A corrupted row falls back to an empty record so
    // quests can re-acquire normally.
    let quests: Record<string, { stage: number; triggerProgress: number }> = {};
    try {
      const raw = row.quests ? JSON.parse(row.quests) as Record<string, unknown> : {};
      for (const [k, v] of Object.entries(raw)) {
        if (!v || typeof v !== 'object') continue;
        const o = v as { stage?: unknown; triggerProgress?: unknown };
        if (typeof o.stage !== 'number' || !Number.isInteger(o.stage)) continue;
        const prog = typeof o.triggerProgress === 'number' && Number.isInteger(o.triggerProgress) && o.triggerProgress >= 0
          ? o.triggerProgress : 0;
        quests[k] = { stage: o.stage, triggerProgress: prog };
      }
    } catch {
      quests = {};
    }

    return {
      x: row.x,
      z: row.z,
      y: row.y ?? 0,
      floor: row.floor ?? 0,
      mapLevel: row.map_level || 'kcmap',
      skills,
      inventory,
      equipment,
      stance,
      appearance,
      bank,
      respawnVersion: row.respawn_version ?? 0,
      quests,
      renown: Math.max(0, Math.floor(row.renown ?? 0)),
    };
  }

  /** Persist a forced-respawn migration atomically with the version bump. This
   *  closes the window where a restart/drop could leave the row stamped as
   *  migrated while still carrying the old position. */
  saveRespawnMigration(accountId: number, player: Player, effectiveY: number, version: number): void {
    this.db.query(`
      UPDATE player_state SET
        x = ?, z = ?, y = ?, floor = ?, map_level = ?,
        respawn_version = ?, updated_at = unixepoch()
      WHERE account_id = ?
    `).run(
      player.position.x,
      player.position.y,
      effectiveY,
      player.currentFloor,
      player.currentMapLevel,
      version,
      accountId,
    );
  }

  saveAppearance(accountId: number, appearance: PlayerAppearance): void {
    this.db.query('UPDATE player_state SET appearance = ? WHERE account_id = ?')
      .run(JSON.stringify(appearance), accountId);
  }

  saveStance(accountId: number, stance: MeleeStance): void {
    this.db.query('UPDATE player_state SET stance = ?, updated_at = unixepoch() WHERE account_id = ?')
      .run(stance, accountId);
  }

  private hiscoreCategoryValue(categoryId: string, skills: SkillBlock): { level: number; xp: number } {
    if (categoryId === 'combat') {
      return {
        level: combatLevel(skills),
        xp: ALL_SKILLS.reduce((sum, id) => sum + skills[id].xp, 0),
      };
    }
    if (categoryId === 'overall') {
      return {
        level: ALL_SKILLS.reduce((sum, id) => sum + skills[id].level, 0),
        xp: ALL_SKILLS.reduce((sum, id) => sum + skills[id].xp, 0),
      };
    }
    const skillId = categoryId as SkillId;
    return {
      level: skills[skillId].level,
      xp: skills[skillId].xp,
    };
  }

  private saveHiscoreSnapshots(accountId: number, skills: SkillBlock): void {
    const now = Math.floor(Date.now() / 1000);
    const bucketStart = Math.floor(now / 3600) * 3600;
    const categories = ['overall', 'combat', ...ALL_SKILLS];
    const stmt = this.db.query(`
      INSERT INTO hiscore_snapshots (account_id, category, bucket_start, level, xp)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, category, bucket_start) DO UPDATE SET
        level = excluded.level,
        xp = excluded.xp
    `);
    for (const categoryId of categories) {
      const value = this.hiscoreCategoryValue(categoryId, skills);
      stmt.run(accountId, categoryId, bucketStart, value.level, value.xp);
    }

    // Keep roughly eight days of hourly history. This is enough for daily
    // gains plus a little deploy/restart slack without letting the table grow
    // forever during a playtest.
    if (now - this.lastHiscoreSnapshotPruneAt > 6 * 3600) {
      this.lastHiscoreSnapshotPruneAt = now;
      this.db.query('DELETE FROM hiscore_snapshots WHERE bucket_start < ?').run(now - 8 * 24 * 3600);
    }
  }

  private hiscoreCategories(players: HiscorePlayerRecord[] = []): HiscoreCategory[] {
    const startingSkills = initSkills();
    const hasEarnedSkillXp = (skillId: SkillId): boolean => {
      return players.some((player) => player.skills[skillId].xp > startingSkills[skillId].xp);
    };

    return [
      { id: 'overall', name: 'Overall', hasXp: true },
      { id: 'combat', name: 'Combat', hasXp: true },
      ...ALL_SKILLS.map((id) => ({ id, name: SKILL_NAMES[id], hasXp: hasEarnedSkillXp(id) })),
    ];
  }

  private parseHiscoreSkills(rawSkills: string): SkillBlock {
    const skills = initSkills();
    try {
      const saved = JSON.parse(rawSkills) as Partial<Record<SkillId, Partial<SkillBlock[SkillId]>>>;
      for (const id of ALL_SKILLS) {
        const skill = saved[id];
        if (!skill) continue;
        const xp = typeof skill.xp === 'number' && Number.isFinite(skill.xp) ? Math.max(0, Math.floor(skill.xp)) : skills[id].xp;
        const level = typeof skill.level === 'number' && Number.isFinite(skill.level) ? Math.max(1, Math.floor(skill.level)) : skills[id].level;
        const currentLevel = typeof skill.currentLevel === 'number' && Number.isFinite(skill.currentLevel)
          ? Math.max(0, Math.floor(skill.currentLevel))
          : level;
        skills[id] = { xp, level, currentLevel };
      }
    } catch {
      // Keep default level-1/10hp skills for corrupted or legacy rows.
    }
    return skills;
  }

  private loadHiscorePlayers(): HiscorePlayerRecord[] {
    const rows = this.db.query(`
      SELECT ps.account_id, a.username, ps.skills
      FROM player_state ps
      JOIN accounts a ON a.id = ps.account_id
      LEFT JOIN account_bans ab
        ON ab.account_id = a.id
       AND (ab.expires_at IS NULL OR ab.expires_at > unixepoch())
      WHERE ab.account_id IS NULL
    `).all() as Array<{ account_id: number; username: string; skills: string }>;

    return rows
      // Anti-bot test accounts can produce artificial XP; keep them out of public rankings.
      .filter((row) => !isHiscoreExcludedUsername(row.username))
      .map((row) => ({
        accountId: row.account_id,
        username: row.username,
        skills: this.parseHiscoreSkills(row.skills),
      }));
  }

  private loadDailyHiscoreBaselines(categoryId: string, cutoff: number): Map<number, number> {
    const baselineRows = this.db.query(`
      SELECT hs.account_id, hs.xp
      FROM hiscore_snapshots hs
      JOIN (
        SELECT account_id, MAX(bucket_start) AS bucket_start
        FROM hiscore_snapshots
        WHERE category = ? AND bucket_start <= ?
        GROUP BY account_id
      ) latest
        ON latest.account_id = hs.account_id
       AND latest.bucket_start = hs.bucket_start
      WHERE hs.category = ?
    `).all(categoryId, cutoff, categoryId) as Array<{ account_id: number; xp: number }>;
    const dailyBaselineXp = new Map<number, number>();
    for (const row of baselineRows) dailyBaselineXp.set(row.account_id, row.xp);
    return dailyBaselineXp;
  }

  private rankedHiscoreRows(category: HiscoreCategory, players: HiscorePlayerRecord[], cutoff: number): RankedHiscoreRow[] {
    const dailyBaselineXp = this.loadDailyHiscoreBaselines(category.id, cutoff);
    return players
      .map((row) => {
        const value = this.hiscoreCategoryValue(category.id, row.skills);
        const baselineXp = dailyBaselineXp.get(row.accountId);
        return {
          accountId: row.accountId,
          username: row.username,
          level: value.level,
          xp: value.xp,
          dailyXp: baselineXp == null ? 0 : Math.max(0, value.xp - baselineXp),
        };
      })
      .sort((a, b) => b.level - a.level || b.xp - a.xp || a.username.localeCompare(b.username))
      .map((row, idx) => ({ rank: idx + 1, ...row }));
  }

  getHiscores(
    categoryId: string = 'overall',
    limit: number = 25,
    page: number = 1,
    query: string = '',
  ): HiscoreResponse {
    const players = this.loadHiscorePlayers();
    const categories = this.hiscoreCategories(players);
    const category = categories.find((c) => c.id === categoryId) ?? categories[0];
    const cappedLimit = Math.max(5, Math.min(100, Math.floor(limit) || 25));
    const currentPage = Math.max(1, Math.floor(page) || 1);
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
    const ranked = this.rankedHiscoreRows(category, players, cutoff);
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery
      ? ranked.filter((row) => row.username.toLowerCase().includes(normalizedQuery))
      : ranked;

    const totalRows = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / cappedLimit));
    const safePage = Math.min(currentPage, totalPages);
    const start = (safePage - 1) * cappedLimit;

    return {
      category,
      categories,
      rows: filtered.slice(start, start + cappedLimit).map(({ accountId: _accountId, ...row }) => row),
      page: safePage,
      pageSize: cappedLimit,
      totalRows,
      totalPages,
    };
  }

  getHiscoreProfile(username: string): HiscoreProfileResponse | null {
    const normalizedUsername = username.trim().toLowerCase();
    if (!normalizedUsername) return null;

    const players = this.loadHiscorePlayers();
    const categories = this.hiscoreCategories(players);
    const target = players.find((player) => player.username.toLowerCase() === normalizedUsername);
    if (!target) return null;

    const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
    const rows = categories.map((category) => {
      const ranked = this.rankedHiscoreRows(category, players, cutoff);
      const row = ranked.find((entry) => entry.accountId === target.accountId);
      return {
        category,
        rank: row?.rank ?? 0,
        level: row?.level ?? 0,
        xp: row?.xp ?? 0,
        dailyXp: row?.dailyXp ?? 0,
      };
    });

    return {
      username: target.username,
      rows,
    };
  }

  /** Load the bot-detection telemetry blob for an account. Returns a row
   *  the caller can rehydrate into a BotStats instance, or null if the
   *  account has never logged in (BotStats will start fresh). */
  loadBotStats(accountId: number): BotStatsRow | null {
    const row = this.db.query(`
	      SELECT total_skilling_actions, total_combat_swings, total_movements,
	             total_chat_messages, total_session_minutes, total_flag_events,
	             total_suspicious_packets,
	             last_chat_ts, last_action_ts, last_login_ts,
	             risk_score, risk_level, risk_reasons,
	             tick_align_samples, reaction_samples, path_destinations,
	             action_signatures, ping_interval_samples, device_ids,
	             suspicious_packet_reasons, xp_baseline, last_session_summary, session_history
	      FROM bot_stats WHERE account_id = ?
	    `).get(accountId) as BotStatsRow | null;
    return row;
  }

  /** Record a new login session. Returns the rowid so handlePlayerDisconnect
   *  can finalize it without re-querying. */
  recordLogin(accountId: number, ip: string, deviceId: string = ''): number {
    const result = this.db.query(
      `INSERT INTO login_history (account_id, ip_address, login_ts, device_id) VALUES (?, ?, unixepoch(), ?)`
    ).run(accountId, ip, deviceId);
    return Number(result.lastInsertRowid);
  }

  /** Finalize an in-progress session row. Called on disconnect. */
  recordLogout(loginRowId: number, sessionMinutes: number): void {
    this.db.query(
      `UPDATE login_history SET logout_ts = unixepoch(), session_minutes = ? WHERE id = ?`
    ).run(sessionMinutes, loginRowId);
  }

  /** Async-callable PTR update. Called after a successful login_history insert
   *  once the dns.reverse() lookup resolves (or fails — null is fine). */
  setLoginReverseDns(loginRowId: number, ptr: string | null): void {
    this.db.query(`UPDATE login_history SET reverse_dns = ? WHERE id = ?`).run(ptr, loginRowId);
  }

  /** Upsert the bot-stats row. Called every 5 min during play + at logout. */
  saveBotStats(accountId: number, row: BotStatsRow): void {
    this.db.query(`
	      INSERT INTO bot_stats (
	        account_id, total_skilling_actions, total_combat_swings, total_movements,
	        total_chat_messages, total_session_minutes, total_flag_events, total_suspicious_packets,
	        last_chat_ts, last_action_ts, last_login_ts, risk_score, risk_level, risk_reasons,
	        tick_align_samples, reaction_samples, path_destinations,
	        action_signatures, ping_interval_samples, device_ids, suspicious_packet_reasons,
	        xp_baseline, last_session_summary, session_history, updated_at
	      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(account_id) DO UPDATE SET
        total_skilling_actions = excluded.total_skilling_actions,
        total_combat_swings = excluded.total_combat_swings,
        total_movements = excluded.total_movements,
        total_chat_messages = excluded.total_chat_messages,
        total_session_minutes = excluded.total_session_minutes,
        total_flag_events = excluded.total_flag_events,
        total_suspicious_packets = excluded.total_suspicious_packets,
        last_chat_ts = excluded.last_chat_ts,
        last_action_ts = excluded.last_action_ts,
        last_login_ts = excluded.last_login_ts,
        risk_score = excluded.risk_score,
        risk_level = excluded.risk_level,
        risk_reasons = excluded.risk_reasons,
	        tick_align_samples = excluded.tick_align_samples,
	        reaction_samples = excluded.reaction_samples,
	        path_destinations = excluded.path_destinations,
	        action_signatures = excluded.action_signatures,
	        ping_interval_samples = excluded.ping_interval_samples,
	        device_ids = excluded.device_ids,
	        suspicious_packet_reasons = excluded.suspicious_packet_reasons,
	        xp_baseline = excluded.xp_baseline,
	        last_session_summary = COALESCE(excluded.last_session_summary, bot_stats.last_session_summary),
	        session_history = excluded.session_history,
	        updated_at = unixepoch()
    `).run(
      accountId,
      row.total_skilling_actions,
      row.total_combat_swings,
      row.total_movements,
      row.total_chat_messages,
      row.total_session_minutes,
      row.total_flag_events,
      row.total_suspicious_packets,
      row.last_chat_ts ?? null,
      row.last_action_ts ?? null,
      row.last_login_ts ?? null,
      row.risk_score,
      row.risk_level,
	      row.risk_reasons,
	      row.tick_align_samples,
	      row.reaction_samples,
	      row.path_destinations,
	      row.action_signatures ?? '{}',
	      row.ping_interval_samples,
	      row.device_ids,
	      row.suspicious_packet_reasons ?? '{}',
	      row.xp_baseline,
	      row.last_session_summary ?? null,
	      row.session_history ?? '[]',
	    );
  }

  listAdminBotReviewAccounts(limit: number = 200): AdminBotReviewAccount[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(Number.isFinite(limit) ? limit : 200)));
    const rows = this.db.query(`
      SELECT
        a.id,
        a.username,
        a.is_admin,
        b.total_skilling_actions,
        b.total_combat_swings,
        b.total_movements,
        b.total_chat_messages,
        b.total_session_minutes,
        b.total_flag_events,
        b.total_suspicious_packets,
        b.last_chat_ts,
        b.last_action_ts,
        b.last_login_ts AS bot_last_login_ts,
        b.risk_score,
        b.risk_level,
        b.risk_reasons,
        b.tick_align_samples,
        b.reaction_samples,
        b.path_destinations,
        b.action_signatures,
        b.ping_interval_samples,
        b.device_ids,
        b.suspicious_packet_reasons,
        b.last_session_summary,
        b.session_history,
        b.updated_at,
        (
          SELECT lh.login_ts FROM login_history lh
          WHERE lh.account_id = a.id
          ORDER BY lh.login_ts DESC, lh.id DESC
          LIMIT 1
        ) AS latest_login_ts,
        (
          SELECT lh.ip_address FROM login_history lh
          WHERE lh.account_id = a.id
          ORDER BY lh.login_ts DESC, lh.id DESC
          LIMIT 1
        ) AS latest_ip,
        (
          SELECT lh.reverse_dns FROM login_history lh
          WHERE lh.account_id = a.id
          ORDER BY lh.login_ts DESC, lh.id DESC
          LIMIT 1
        ) AS latest_reverse_dns,
        (
          SELECT lh.device_id FROM login_history lh
          WHERE lh.account_id = a.id
          ORDER BY lh.login_ts DESC, lh.id DESC
          LIMIT 1
        ) AS latest_device_id,
        (
          SELECT lh.session_minutes FROM login_history lh
          WHERE lh.account_id = a.id
          ORDER BY lh.login_ts DESC, lh.id DESC
          LIMIT 1
        ) AS latest_session_minutes
      FROM accounts a
      LEFT JOIN bot_stats b ON b.account_id = a.id
      ORDER BY COALESCE(b.risk_score, 0) DESC,
               COALESCE(latest_login_ts, b.last_login_ts, 0) DESC,
               a.username COLLATE NOCASE ASC
      LIMIT ?
    `).all(safeLimit) as Array<{
      id: number;
      username: string;
      is_admin: number;
      total_skilling_actions: number | null;
      total_combat_swings: number | null;
      total_movements: number | null;
      total_chat_messages: number | null;
      total_session_minutes: number | null;
      total_flag_events: number | null;
      total_suspicious_packets: number | null;
      last_chat_ts: number | null;
      last_action_ts: number | null;
      bot_last_login_ts: number | null;
      risk_score: number | null;
	      risk_level: string | null;
	      risk_reasons: string | null;
	      tick_align_samples: string | null;
	      reaction_samples: string | null;
	      path_destinations: string | null;
	      action_signatures: string | null;
	      ping_interval_samples: string | null;
	      device_ids: string | null;
	      suspicious_packet_reasons: string | null;
	      last_session_summary: string | null;
	      session_history: string | null;
	      updated_at: number | null;
      latest_login_ts: number | null;
      latest_ip: string | null;
      latest_reverse_dns: string | null;
      latest_device_id: string | null;
      latest_session_minutes: number | null;
    }>;

	    const accounts = rows.map((row) => {
	      const pathDestinations = parseJsonNumberRecord(row.path_destinations);
	      const deviceIds = parseJsonNumberRecord(row.device_ids);
	      const suspiciousReasons = parseJsonNumberRecord(row.suspicious_packet_reasons);
	      const totalActions = (row.total_skilling_actions ?? 0) + (row.total_combat_swings ?? 0) + (row.total_movements ?? 0);
	      const totalMinutes = row.total_session_minutes ?? 0;
	      const totalHours = totalMinutes > 0 ? totalMinutes / 60 : null;
	      const totalChats = row.total_chat_messages ?? 0;
	      const storedRiskReasons = parseJsonStringArray(row.risk_reasons);
	      const calibratedRisk = calibratedLegacyBotRisk({
	        storedReasons: storedRiskReasons,
	        totalSessionMinutes: totalMinutes,
	        totalSkillingActions: row.total_skilling_actions ?? 0,
	        totalCombatSwings: row.total_combat_swings ?? 0,
	        totalMovements: row.total_movements ?? 0,
	        totalChatMessages: totalChats,
	        totalFlagEvents: row.total_flag_events ?? 0,
	        totalSuspiciousPackets: row.total_suspicious_packets ?? 0,
	        pathDestinations,
	        suspiciousReasons,
	      });
	      const lastIp = row.latest_ip ?? null;
	      return {
        accountId: row.id,
        username: row.username,
        isAdmin: row.is_admin === 1,
        riskScore: calibratedRisk?.score ?? row.risk_score ?? 0,
        riskLevel: calibratedRisk?.level ?? row.risk_level ?? 'low',
        riskReasons: calibratedRisk?.reasons ?? storedRiskReasons,
        totalSkillingActions: row.total_skilling_actions ?? 0,
        totalCombatSwings: row.total_combat_swings ?? 0,
        totalMovements: row.total_movements ?? 0,
        totalChatMessages: row.total_chat_messages ?? 0,
        totalSessionMinutes: row.total_session_minutes ?? 0,
        totalFlagEvents: row.total_flag_events ?? 0,
        totalSuspiciousPackets: row.total_suspicious_packets ?? 0,
        lastChatTs: row.last_chat_ts ?? null,
        lastActionTs: row.last_action_ts ?? null,
        lastLoginTs: row.latest_login_ts ?? row.bot_last_login_ts ?? null,
        lastIp,
        lastReverseDns: row.latest_reverse_dns ?? null,
        lastDeviceId: row.latest_device_id ?? null,
        lastSessionMinutes: row.latest_session_minutes ?? null,
        botStatsUpdatedAt: row.updated_at ?? null,
        tickAlignSampleCount: parseJsonNumberArray(row.tick_align_samples).length,
        reactionSampleCount: parseJsonNumberArray(row.reaction_samples).length,
        pingIntervalSampleCount: parseJsonNumberArray(row.ping_interval_samples).length,
        pathDestinationCount: Object.keys(pathDestinations).length,
        topPathRepetition: topRecordRatio(pathDestinations),
        topPathDestinations: topNumberRecordEntries(pathDestinations, 5).map(([tile, count]) => ({ tile, count })),
        deviceIdsSeen: Object.keys(deviceIds).length,
        suspiciousPacketReasons: topNumberRecordEntries(suspiciousReasons, 8).map(([reason, count]) => ({ reason, count })),
        sessionHistory: parseJsonObjectArray(row.session_history).slice(-8),
        chatRatePerHour: totalHours === null ? null : totalChats / totalHours,
        actionsPerHour: totalHours === null ? null : totalActions / totalHours,
        actionsPerChat: totalChats > 0 ? totalActions / totalChats : null,
        sharedDeviceAlts: this.getSharedDeviceAlts(row.id),
        lastSessionSummary: parseJsonObject(row.last_session_summary),
        accountBan: this.getAccountBanRecord(row.id),
        ipBan: lastIp ? this.getIpBanRecord(lastIp) : null,
      };
    });
    accounts.sort((a, b) =>
      b.riskScore - a.riskScore
      || (b.lastLoginTs ?? 0) - (a.lastLoginTs ?? 0)
      || a.username.localeCompare(b.username)
    );
    return accounts;
  }

  private getSharedDeviceAlts(accountId: number, limit: number = 8): AdminSharedDeviceAlt[] {
    const rows = this.db.query(`
      WITH my_devices AS (
        SELECT DISTINCT device_id
        FROM login_history
        WHERE account_id = ? AND device_id IS NOT NULL AND device_id <> ''
      )
      SELECT
        a.id AS account_id,
        a.username,
        COUNT(DISTINCT lh.device_id) AS devices,
        COUNT(*) AS logins,
        MAX(lh.login_ts) AS last_seen_ts
      FROM login_history lh
      JOIN my_devices md ON md.device_id = lh.device_id
      JOIN accounts a ON a.id = lh.account_id
      WHERE lh.account_id <> ?
      GROUP BY a.id, a.username
      ORDER BY devices DESC, logins DESC, last_seen_ts DESC
      LIMIT ?
    `).all(accountId, accountId, Math.max(1, Math.min(20, limit))) as Array<{
      account_id: number;
      username: string;
      devices: number;
      logins: number;
      last_seen_ts: number | null;
    }>;
    return rows.map((row) => ({
      accountId: row.account_id,
      username: row.username,
      devices: row.devices,
      logins: row.logins,
      lastSeenTs: row.last_seen_ts,
    }));
  }

  cleanExpiredSessions(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.query('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }

  // -- Bans -----------------------------------------------------------------

  /** Look up an account id by username (case-insensitive — matches the
   *  accounts.username COLLATE NOCASE constraint). Returns null when no
   *  account exists with that name. */
  getAccountIdByUsername(username: string): number | null {
    const row = this.db.query('SELECT id FROM accounts WHERE username = ?').get(username) as { id: number } | null;
    return row?.id ?? null;
  }

  getAccountModerationInfo(accountId: number): { accountId: number; username: string; isAdmin: boolean } | null {
    const row = this.db.query('SELECT id, username, is_admin FROM accounts WHERE id = ?')
      .get(accountId) as { id: number; username: string; is_admin: number } | null;
    return row ? { accountId: row.id, username: row.username, isAdmin: row.is_admin === 1 } : null;
  }

  private pruneExpiredBans(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.query('DELETE FROM account_bans WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
    this.db.query('DELETE FROM ip_bans WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
  }

  /** Shared upsert for the two ban tables. Table/keyCol come from string
   *  literals at the call site (not user input) so the template-literal SQL
   *  is safe. */
  private upsertBan(
    table: 'account_bans' | 'ip_bans',
    keyCol: 'account_id' | 'ip_address',
    key: number | string,
    reason: string,
    bannedBy: string,
    expiresAt: number | null = null,
  ): void {
    this.db.query(`
      INSERT INTO ${table} (${keyCol}, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(${keyCol}) DO UPDATE SET
        reason = excluded.reason,
        banned_by = excluded.banned_by,
        expires_at = excluded.expires_at,
        banned_at = unixepoch()
    `).run(key, reason, bannedBy, expiresAt);
  }

  private readBan(table: 'account_bans' | 'ip_bans', keyCol: 'account_id' | 'ip_address', key: number | string): BanInfo | null {
    const row = this.db.query(`SELECT reason, banned_at, expires_at FROM ${table} WHERE ${keyCol} = ?`)
      .get(key) as { reason: string; banned_at: number; expires_at: number | null } | null;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Math.floor(Date.now() / 1000)) {
      this.db.query(`DELETE FROM ${table} WHERE ${keyCol} = ?`).run(key);
      return null;
    }
    return { reason: row.reason, bannedAt: row.banned_at, expiresAt: row.expires_at };
  }

  banAccount(accountId: number, reason: string, bannedBy: string, expiresAt: number | null = null): void {
    this.upsertBan('account_bans', 'account_id', accountId, reason, bannedBy, expiresAt);
  }

  unbanAccount(accountId: number): boolean {
    return this.db.query('DELETE FROM account_bans WHERE account_id = ?').run(accountId).changes > 0;
  }

  isAccountBanned(accountId: number): BanInfo | null {
    return this.readBan('account_bans', 'account_id', accountId);
  }

  banIp(ip: string, reason: string, bannedBy: string, expiresAt: number | null = null): void {
    this.upsertBan('ip_bans', 'ip_address', ip, reason, bannedBy, expiresAt);
  }

  unbanIp(ip: string): boolean {
    return this.db.query('DELETE FROM ip_bans WHERE ip_address = ?').run(ip).changes > 0;
  }

  isIpBanned(ip: string): BanInfo | null {
    if (!ip) return null;
    return this.readBan('ip_bans', 'ip_address', ip);
  }

  /** Most-recent IP recorded for an account in login_history. Used by /ipban
   *  to resolve a username → IP without forcing the admin to look it up. */
  getLatestIpForAccount(accountId: number): string | null {
    const row = this.db.query(
      'SELECT ip_address FROM login_history WHERE account_id = ? ORDER BY login_ts DESC LIMIT 1'
    ).get(accountId) as { ip_address: string } | null;
    return row?.ip_address ?? null;
  }

  getAccountBanRecord(accountId: number): AccountBanRecord | null {
    const row = this.db.query(`
      SELECT ab.account_id, a.username, ab.reason, ab.banned_at, ab.expires_at, ab.banned_by
      FROM account_bans ab
      JOIN accounts a ON a.id = ab.account_id
      WHERE ab.account_id = ?
    `).get(accountId) as { account_id: number; username: string; reason: string; banned_at: number; expires_at: number | null; banned_by: string } | null;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Math.floor(Date.now() / 1000)) {
      this.unbanAccount(accountId);
      return null;
    }
    return {
      accountId: row.account_id,
      username: row.username,
      reason: row.reason,
      bannedAt: row.banned_at,
      expiresAt: row.expires_at,
      bannedBy: row.banned_by,
    };
  }

  getIpBanRecord(ip: string): IpBanRecord | null {
    if (!ip) return null;
    const row = this.db.query('SELECT ip_address, reason, banned_at, expires_at, banned_by FROM ip_bans WHERE ip_address = ?')
      .get(ip) as { ip_address: string; reason: string; banned_at: number; expires_at: number | null; banned_by: string } | null;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Math.floor(Date.now() / 1000)) {
      this.unbanIp(ip);
      return null;
    }
    return {
      ip: row.ip_address,
      reason: row.reason,
      bannedAt: row.banned_at,
      expiresAt: row.expires_at,
      bannedBy: row.banned_by,
    };
  }

  listAccountBans(): Array<AccountBanRecord> {
    this.pruneExpiredBans();
    return this.db.query(`
      SELECT ab.account_id, a.username, ab.reason, ab.banned_at, ab.expires_at, ab.banned_by
      FROM account_bans ab JOIN accounts a ON a.id = ab.account_id
      ORDER BY ab.banned_at DESC
    `).all().map((r) => {
      const row = r as { account_id: number; username: string; reason: string; banned_at: number; expires_at: number | null; banned_by: string };
      return { accountId: row.account_id, username: row.username, reason: row.reason, bannedAt: row.banned_at, expiresAt: row.expires_at, bannedBy: row.banned_by };
    });
  }

  listIpBans(): Array<IpBanRecord> {
    this.pruneExpiredBans();
    return this.db.query('SELECT ip_address, reason, banned_at, expires_at, banned_by FROM ip_bans ORDER BY banned_at DESC')
      .all().map((r) => {
        const row = r as { ip_address: string; reason: string; banned_at: number; expires_at: number | null; banned_by: string };
        return { ip: row.ip_address, reason: row.reason, bannedAt: row.banned_at, expiresAt: row.expires_at, bannedBy: row.banned_by };
      });
  }

  close(): void {
    this.db.close();
  }
}
