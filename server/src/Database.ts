import { Database as SQLiteDB } from 'bun:sqlite';
import { randomBytes } from 'crypto';
import type { Player } from './entity/Player';
import type { SkillBlock, SkillId, MeleeStance, PlayerAppearance } from '@projectrs/shared';
import { ALL_SKILLS, initSkills, xpForLevel, normalizeAppearance } from '@projectrs/shared';
import type { EquipSlot } from './entity/Player';

const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface SessionInfo {
  accountId: number;
  username: string;
}

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
  }

  async createAccount(username: string, password: string): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
    // Validate
    if (!username || username.length < 1 || username.length > 16) {
      return { ok: false, error: 'Username must be 1-16 characters' };
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return { ok: false, error: 'Username must be alphanumeric (underscores allowed)' };
    }
    if (!password || password.length < 8 || password.length > 64) {
      return { ok: false, error: 'Password must be 8-64 characters' };
    }

    // Check if username exists
    const existing = this.db.query('SELECT id FROM accounts WHERE username = ?').get(username);
    if (existing) {
      return { ok: false, error: 'Username already taken' };
    }

    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });

    const result = this.db.query('INSERT INTO accounts (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
    const accountId = Number(result.lastInsertRowid);

    // Create initial player state with starter tools
    const starterInventory = JSON.stringify([
      { itemId: 31, quantity: 1 },
      { itemId: 33, quantity: 1 }
    ]);
    this.db.query('INSERT INTO player_state (account_id, inventory) VALUES (?, ?)').run(accountId, starterInventory);

    // Create session
    const token = this.createSession(accountId);
    return { ok: true, token };
  }

  async login(username: string, password: string): Promise<{ ok: true; token: string; username: string } | { ok: false; error: string }> {
    const row = this.db.query('SELECT id, username, password_hash FROM accounts WHERE username = ?').get(username) as { id: number; username: string; password_hash: string } | null;
    if (!row) {
      return { ok: false, error: 'Invalid username or password' };
    }

    const valid = await Bun.password.verify(password, row.password_hash);
    if (!valid) {
      return { ok: false, error: 'Invalid username or password' };
    }

    const token = this.createSession(row.id);
    return { ok: true, token, username: row.username };
  }

  private createSession(accountId: number): string {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Math.floor((Date.now() + SESSION_EXPIRY_MS) / 1000);
    this.db.query('INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)').run(token, accountId, expiresAt);
    return token;
  }

  getSession(token: string): SessionInfo | null {
    if (!token) return null;
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.query(`
      SELECT s.account_id, a.username
      FROM sessions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.token = ? AND s.expires_at > ?
    `).get(token, now) as { account_id: number; username: string } | null;

    if (!row) return null;
    return { accountId: row.account_id, username: row.username };
  }

  logout(token: string): void {
    this.db.query('DELETE FROM sessions WHERE token = ?').run(token);
  }

  savePlayerState(accountId: number, player: Player, effectiveY: number): void {
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
        stance = ?, appearance = ?, updated_at = unixepoch()
      WHERE account_id = ?
    `).run(
      player.position.x, player.position.y, effectiveY, player.currentFloor,
      player.currentMapLevel,
      JSON.stringify(skills),
      JSON.stringify(player.inventory),
      JSON.stringify(equipment),
      player.stance,
      player.appearance ? JSON.stringify(player.appearance) : null,
      accountId,
    );
  }

  loadPlayerState(accountId: number): SavedPlayerState | null {
    const row = this.db.query('SELECT x, z, y, floor, map_level, skills, inventory, equipment, stance, appearance FROM player_state WHERE account_id = ?')
      .get(accountId) as { x: number; z: number; y: number | null; floor: number | null; map_level: string; skills: string; inventory: string; equipment: string; stance: string; appearance: string | null } | null;

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

    // Parse inventory
    let inventory: ({ itemId: number; quantity: number } | null)[];
    try {
      inventory = JSON.parse(row.inventory);
    } catch {
      inventory = new Array(28).fill(null);
    }

    // Parse equipment
    let equipment: Map<EquipSlot, number>;
    try {
      const saved = JSON.parse(row.equipment) as Record<string, number>;
      equipment = new Map();
      for (const [slot, itemId] of Object.entries(saved)) {
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
    };
  }

  saveAppearance(accountId: number, appearance: PlayerAppearance): void {
    this.db.query('UPDATE player_state SET appearance = ? WHERE account_id = ?')
      .run(JSON.stringify(appearance), accountId);
  }

  cleanExpiredSessions(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.query('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  }

  close(): void {
    this.db.close();
  }
}
