import { Database as SQLiteDB } from 'bun:sqlite';
import { randomBytes } from 'crypto';
import type { Player } from './entity/Player';
import type { SkillBlock, SkillId, MeleeStance, PlayerAppearance } from '@projectrs/shared';
import { ALL_SKILLS, SKILL_NAMES, combatLevel, initSkills, xpForLevel, normalizeAppearance, validatePassword, validateUsername } from '@projectrs/shared';
import type { EquipSlot } from './entity/Player';

const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface SessionInfo {
  accountId: number;
  username: string;
  isAdmin: boolean;
  /** Browser device ID captured at login. Plumbed through the WS upgrade to
   *  the Player so login_history can record it for cross-account device
   *  correlation. Empty string when the client didn't supply one. */
  deviceId: string;
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
  last_chat_ts: number | null;
  last_action_ts: number | null;
  last_login_ts: number | null;
  /** JSON array of recent tick-align deltas (ms past tick boundary). Capped at 100. */
  tick_align_samples: string;
  /** JSON array of recent reaction times (ms after NPC death → next attack). Capped at 50. */
  reaction_samples: string;
  /** JSON map of "x,z" tile → visit count. Capped at 100 entries. */
  path_destinations: string;
  /** JSON map of skill → xp at session start. Used to compute session-rate. */
  xp_baseline: string;
  /** JSON blob of the last computed session summary (flags + stats). */
  last_session_summary: string | null;
}

/** Bump this constant to force every existing account to spawn at the map's
 *  default spawnPoint on their next login (one-time per bump). Saved skills,
 *  inventory, bank, etc. are preserved — only position is reset. On respawn
 *  the player_state row's respawn_version is updated to this value, so
 *  subsequent logins use the saved position normally. */
export const WORLD_RESPAWN_VERSION = 2;

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
}

export interface HiscoreCategory {
  id: string;
  name: string;
}

export interface HiscoreRow {
  rank: number;
  username: string;
  level: number;
  xp: number;
}

export interface HiscoreResponse {
  category: HiscoreCategory;
  categories: HiscoreCategory[];
  rows: HiscoreRow[];
}

export class GameDatabase {
  private db: SQLiteDB;

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
        updated_at INTEGER DEFAULT (unixepoch())
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
        last_chat_ts INTEGER,
        last_action_ts INTEGER,
        last_login_ts INTEGER,
        tick_align_samples TEXT NOT NULL DEFAULT '[]',
        reaction_samples TEXT NOT NULL DEFAULT '[]',
        path_destinations TEXT NOT NULL DEFAULT '{}',
        xp_baseline TEXT NOT NULL DEFAULT '{}',
        last_session_summary TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);

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
      this.db.exec(`ALTER TABLE login_history ADD COLUMN device_id TEXT NOT NULL DEFAULT ''`);
    } catch { /* column already exists */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_login_history_device ON login_history(device_id)`);

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
      }
    } catch { /* table absent */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS door_state (
        map_level TEXT NOT NULL,
        def_id INTEGER NOT NULL,
        tile_x INTEGER NOT NULL,
        tile_z INTEGER NOT NULL,
        is_open INTEGER NOT NULL,
        auto_close_at_tick INTEGER,
        PRIMARY KEY (map_level, def_id, tile_x, tile_z)
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
      }
    } catch { /* table absent */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS world_object_respawn (
        map_level TEXT NOT NULL,
        def_id INTEGER NOT NULL,
        tile_x INTEGER NOT NULL,
        tile_z INTEGER NOT NULL,
        respawn_at_unix_ms INTEGER NOT NULL,
        PRIMARY KEY (map_level, def_id, tile_x, tile_z)
      );
    `);
  }

  // -- Door state -----------------------------------------------------------

  saveDoorState(mapLevel: string, defId: number, tileX: number, tileZ: number, isOpen: boolean, autoCloseAtTick: number | null): void {
    try {
      this.db.query(`
        INSERT INTO door_state (map_level, def_id, tile_x, tile_z, is_open, auto_close_at_tick)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(map_level, def_id, tile_x, tile_z) DO UPDATE SET
          is_open = excluded.is_open,
          auto_close_at_tick = excluded.auto_close_at_tick
      `).run(mapLevel, defId, tileX, tileZ, isOpen ? 1 : 0, autoCloseAtTick);
    } catch (e) {
      console.error('saveDoorState failed:', e);
    }
  }

  loadAllDoorStates(): Array<{ mapLevel: string; defId: number; tileX: number; tileZ: number; isOpen: boolean; autoCloseAtTick: number | null }> {
    try {
      const rows = this.db.query(`
        SELECT map_level, def_id, tile_x, tile_z, is_open, auto_close_at_tick FROM door_state
      `).all() as Array<{ map_level: string; def_id: number; tile_x: number; tile_z: number; is_open: number; auto_close_at_tick: number | null }>;
      return rows.map(r => ({
        mapLevel: r.map_level,
        defId: r.def_id,
        tileX: r.tile_x,
        tileZ: r.tile_z,
        isOpen: r.is_open === 1,
        autoCloseAtTick: r.auto_close_at_tick,
      }));
    } catch (e) {
      console.error('loadAllDoorStates failed:', e);
      return [];
    }
  }

  clearDoorState(mapLevel: string, defId: number, tileX: number, tileZ: number): void {
    try {
      this.db.query('DELETE FROM door_state WHERE map_level = ? AND def_id = ? AND tile_x = ? AND tile_z = ?')
        .run(mapLevel, defId, tileX, tileZ);
    } catch (e) {
      console.error('clearDoorState failed:', e);
    }
  }

  // -- World object respawn -------------------------------------------------

  saveObjectRespawn(mapLevel: string, defId: number, tileX: number, tileZ: number, respawnAtUnixMs: number): void {
    try {
      this.db.query(`
        INSERT INTO world_object_respawn (map_level, def_id, tile_x, tile_z, respawn_at_unix_ms)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(map_level, def_id, tile_x, tile_z) DO UPDATE SET
          respawn_at_unix_ms = excluded.respawn_at_unix_ms
      `).run(mapLevel, defId, tileX, tileZ, respawnAtUnixMs);
    } catch (e) {
      console.error('saveObjectRespawn failed:', e);
    }
  }

  loadAllObjectRespawns(): Array<{ mapLevel: string; defId: number; tileX: number; tileZ: number; respawnAtUnixMs: number }> {
    try {
      const rows = this.db.query(`
        SELECT map_level, def_id, tile_x, tile_z, respawn_at_unix_ms FROM world_object_respawn
      `).all() as Array<{ map_level: string; def_id: number; tile_x: number; tile_z: number; respawn_at_unix_ms: number }>;
      return rows.map(r => ({
        mapLevel: r.map_level,
        defId: r.def_id,
        tileX: r.tile_x,
        tileZ: r.tile_z,
        respawnAtUnixMs: r.respawn_at_unix_ms,
      }));
    } catch (e) {
      console.error('loadAllObjectRespawns failed:', e);
      return [];
    }
  }

  clearObjectRespawn(mapLevel: string, defId: number, tileX: number, tileZ: number): void {
    try {
      this.db.query('DELETE FROM world_object_respawn WHERE map_level = ? AND def_id = ? AND tile_x = ? AND tile_z = ?')
        .run(mapLevel, defId, tileX, tileZ);
    } catch (e) {
      console.error('clearObjectRespawn failed:', e);
    }
  }

  async createAccount(username: string, password: string, deviceId: string = ''): Promise<{ ok: true; token: string; accountId: number; isAdmin: boolean } | { ok: false; error: string }> {
    const usernameError = validateUsername(username);
    if (usernameError) return { ok: false, error: usernameError };
    const passwordError = validatePassword(password);
    if (passwordError) return { ok: false, error: passwordError };

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
    const token = this.createSession(accountId, deviceId);
    return { ok: true, token, accountId, isAdmin: isAdmin === 1 };
  }

  async login(username: string, password: string, deviceId: string = ''): Promise<{ ok: true; token: string; username: string; accountId: number; isAdmin: boolean } | { ok: false; error: string }> {
    const row = this.db.query('SELECT id, username, password_hash, is_admin FROM accounts WHERE username = ?').get(username) as { id: number; username: string; password_hash: string; is_admin: number } | null;
    if (!row) {
      return { ok: false, error: 'Invalid username or password' };
    }

    const valid = await Bun.password.verify(password, row.password_hash);
    if (!valid) {
      return { ok: false, error: 'Invalid username or password' };
    }

    const token = this.createSession(row.id, deviceId);
    return { ok: true, token, username: row.username, accountId: row.id, isAdmin: row.is_admin === 1 };
  }

  createSession(accountId: number, deviceId: string = ''): string {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Math.floor((Date.now() + SESSION_EXPIRY_MS) / 1000);
    // Drop any prior sessions for this account before inserting the new one.
    // Matches the "single active session" model already enforced in-game by
    // World.kickAccountIfOnline and prevents the sessions table from growing
    // unbounded per device-login.
    this.db.query('DELETE FROM sessions WHERE account_id = ?').run(accountId);
    this.db.query('INSERT INTO sessions (token, account_id, expires_at, device_id) VALUES (?, ?, ?, ?)').run(token, accountId, expiresAt, deviceId);
    return token;
  }

  getSession(token: string): SessionInfo | null {
    if (!token) return null;
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.query(`
      SELECT s.account_id, a.username, a.is_admin, s.device_id
      FROM sessions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.token = ? AND s.expires_at > ?
    `).get(token, now) as { account_id: number; username: string; is_admin: number; device_id: string | null } | null;

    if (!row) return null;
    return { accountId: row.account_id, username: row.username, isAdmin: row.is_admin === 1, deviceId: row.device_id ?? '' };
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
        stance = ?, appearance = ?, bank = ?, quests = ?, updated_at = unixepoch()
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
      accountId,
    );
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
    const row = this.db.query('SELECT x, z, y, floor, map_level, skills, inventory, equipment, stance, appearance, bank, respawn_version, quests FROM player_state WHERE account_id = ?')
      .get(accountId) as { x: number; z: number; y: number | null; floor: number | null; map_level: string; skills: string; inventory: string; equipment: string; stance: string; appearance: string | null; bank: string | null; respawn_version: number | null; quests: string | null } | null;

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
    };
  }

  /** Mark the account's saved state as having been respawned at the current
   *  WORLD_RESPAWN_VERSION. Called from the login flow after we've relocated
   *  the player to the map's default spawn — without this, every login would
   *  re-respawn them. */
  markRespawnVersion(accountId: number, version: number): void {
    this.db.query('UPDATE player_state SET respawn_version = ? WHERE account_id = ?')
      .run(version, accountId);
  }

  saveAppearance(accountId: number, appearance: PlayerAppearance): void {
    this.db.query('UPDATE player_state SET appearance = ? WHERE account_id = ?')
      .run(JSON.stringify(appearance), accountId);
  }

  getHiscores(categoryId: string = 'overall', limit: number = 100): HiscoreResponse {
    const categories: HiscoreCategory[] = [
      { id: 'overall', name: 'Overall' },
      { id: 'combat', name: 'Combat' },
      ...ALL_SKILLS.map((id) => ({ id, name: SKILL_NAMES[id] })),
    ];
    const category = categories.find((c) => c.id === categoryId) ?? categories[0];
    const cappedLimit = Math.max(1, Math.min(500, Math.floor(limit) || 100));
    const rows = this.db.query(`
      SELECT a.username, ps.skills
      FROM player_state ps
      JOIN accounts a ON a.id = ps.account_id
    `).all() as Array<{ username: string; skills: string }>;

    const ranked = rows.map((row) => {
      const skills = initSkills();
      try {
        const saved = JSON.parse(row.skills) as Partial<Record<SkillId, Partial<SkillBlock[SkillId]>>>;
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

      if (category.id === 'combat') {
        return {
          username: row.username,
          level: combatLevel(skills),
          xp: ALL_SKILLS.reduce((sum, id) => sum + skills[id].xp, 0),
        };
      }
      if (category.id === 'overall') {
        return {
          username: row.username,
          level: ALL_SKILLS.reduce((sum, id) => sum + skills[id].level, 0),
          xp: ALL_SKILLS.reduce((sum, id) => sum + skills[id].xp, 0),
        };
      }

      const skillId = category.id as SkillId;
      return {
        username: row.username,
        level: skills[skillId].level,
        xp: skills[skillId].xp,
      };
    }).sort((a, b) => b.xp - a.xp || b.level - a.level || a.username.localeCompare(b.username));

    return {
      category,
      categories,
      rows: ranked.slice(0, cappedLimit).map((row, idx) => ({ rank: idx + 1, ...row })),
    };
  }

  /** Load the bot-detection telemetry blob for an account. Returns a row
   *  the caller can rehydrate into a BotStats instance, or null if the
   *  account has never logged in (BotStats will start fresh). */
  loadBotStats(accountId: number): BotStatsRow | null {
    const row = this.db.query(`
      SELECT total_skilling_actions, total_combat_swings, total_movements,
             total_chat_messages, total_session_minutes, total_flag_events,
             last_chat_ts, last_action_ts, last_login_ts,
             tick_align_samples, reaction_samples, path_destinations,
             xp_baseline, last_session_summary
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
        total_chat_messages, total_session_minutes, total_flag_events,
        last_chat_ts, last_action_ts, last_login_ts,
        tick_align_samples, reaction_samples, path_destinations,
        xp_baseline, last_session_summary, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(account_id) DO UPDATE SET
        total_skilling_actions = excluded.total_skilling_actions,
        total_combat_swings = excluded.total_combat_swings,
        total_movements = excluded.total_movements,
        total_chat_messages = excluded.total_chat_messages,
        total_session_minutes = excluded.total_session_minutes,
        total_flag_events = excluded.total_flag_events,
        last_chat_ts = excluded.last_chat_ts,
        last_action_ts = excluded.last_action_ts,
        last_login_ts = excluded.last_login_ts,
        tick_align_samples = excluded.tick_align_samples,
        reaction_samples = excluded.reaction_samples,
        path_destinations = excluded.path_destinations,
        xp_baseline = excluded.xp_baseline,
        last_session_summary = excluded.last_session_summary,
        updated_at = unixepoch()
    `).run(
      accountId,
      row.total_skilling_actions,
      row.total_combat_swings,
      row.total_movements,
      row.total_chat_messages,
      row.total_session_minutes,
      row.total_flag_events,
      row.last_chat_ts ?? null,
      row.last_action_ts ?? null,
      row.last_login_ts ?? null,
      row.tick_align_samples,
      row.reaction_samples,
      row.path_destinations,
      row.xp_baseline,
      row.last_session_summary ?? null,
    );
  }

  cleanExpiredSessions(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.query('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }

  close(): void {
    this.db.close();
  }
}
