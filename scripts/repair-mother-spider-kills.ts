import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

const MOTHER_SPIDER_NPC_ID = 22;
const BLACK_SPIDER_NPC_ID = 104;

const dbPath = resolve(Bun.env.PROJECTRS_DB_PATH || 'projectrs.db');
const apply = Bun.argv.includes('--apply');

const db = new Database(dbPath);

type MobKillRow = {
  account_id: number;
  npc_def_id: number;
  kills: number;
  updated_at: number;
};

function tableExists(name: string): boolean {
  const row = db.query('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', name) as { 1: number } | null;
  return !!row;
}

if (!tableExists('mob_kills')) {
  console.error(`[repair] ${dbPath} has no mob_kills table.`);
  process.exit(1);
}

const sourceRows = db.query<MobKillRow, [number]>(`
  SELECT account_id, npc_def_id, kills, updated_at
  FROM mob_kills
  WHERE npc_def_id = ? AND kills > 0
  ORDER BY account_id ASC
`).all(MOTHER_SPIDER_NPC_ID);

const targetRows = db.query<MobKillRow, [number]>(`
  SELECT account_id, npc_def_id, kills, updated_at
  FROM mob_kills
  WHERE npc_def_id = ? AND kills > 0
  ORDER BY account_id ASC
`).all(BLACK_SPIDER_NPC_ID);

const sourceTotal = sourceRows.reduce((total, row) => total + row.kills, 0);
const targetTotal = targetRows.reduce((total, row) => total + row.kills, 0);

console.log(`[repair] db=${dbPath}`);
console.log(`[repair] Mother Spider (${MOTHER_SPIDER_NPC_ID}) rows=${sourceRows.length} kills=${sourceTotal}`);
console.log(`[repair] Black Spider (${BLACK_SPIDER_NPC_ID}) rows=${targetRows.length} kills=${targetTotal}`);

if (!apply) {
  console.log('[repair] dry run only; re-run with --apply to move Mother Spider rows onto Black Spider.');
  db.close();
  process.exit(0);
}

db.transaction(() => {
  db.query(`
    INSERT INTO mob_kills (account_id, npc_def_id, kills, updated_at)
    SELECT account_id, ?, kills, updated_at
    FROM mob_kills
    WHERE npc_def_id = ? AND kills > 0
    ON CONFLICT(account_id, npc_def_id) DO UPDATE SET
      kills = kills + excluded.kills,
      updated_at = MAX(mob_kills.updated_at, excluded.updated_at)
  `).run(BLACK_SPIDER_NPC_ID, MOTHER_SPIDER_NPC_ID);

  db.query('DELETE FROM mob_kills WHERE npc_def_id = ?').run(MOTHER_SPIDER_NPC_ID);

  if (tableExists('mob_kill_snapshots')) {
    db.query(`
      INSERT INTO mob_kill_snapshots (account_id, npc_def_id, bucket_start, kills)
      SELECT account_id, ?, bucket_start, kills
      FROM mob_kill_snapshots
      WHERE npc_def_id = ?
      ON CONFLICT(account_id, npc_def_id, bucket_start) DO UPDATE SET
        kills = mob_kill_snapshots.kills + excluded.kills
    `).run(BLACK_SPIDER_NPC_ID, MOTHER_SPIDER_NPC_ID);

    db.query('DELETE FROM mob_kill_snapshots WHERE npc_def_id = ?').run(MOTHER_SPIDER_NPC_ID);
  }
})();

const repairedSourceTotal = (db.query('SELECT COALESCE(SUM(kills), 0) AS kills FROM mob_kills WHERE npc_def_id = ?')
  .get(MOTHER_SPIDER_NPC_ID) as { kills: number }).kills;
const repairedTargetTotal = (db.query('SELECT COALESCE(SUM(kills), 0) AS kills FROM mob_kills WHERE npc_def_id = ?')
  .get(BLACK_SPIDER_NPC_ID) as { kills: number }).kills;

console.log(`[repair] applied; Mother Spider kills=${repairedSourceTotal}, Black Spider kills=${repairedTargetTotal}`);
db.close();
