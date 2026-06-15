import { describe, expect, test } from 'bun:test';
import { Database as SQLiteDB } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { QUEST_STAGE_COMPLETED } from '@projectrs/shared';
import { GameDatabase } from '../src/Database';

const BROTHER_MONK_QUEST_ID = 'quest_8djo2';
const RESET_COMPLETED_BROTHER_MONK_MIGRATION_ID = 'reset_completed_brother_monk_2026_06_15';

describe('quest data migrations', () => {
  test('completed Brother Monk saves are reset once while active saves remain intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evilquest-brother-monk-reset-'));
    const dbPath = join(dir, 'test.db');
    try {
      const first = new GameDatabase(dbPath);
      const completed = first.loginFallbackAccount('brother-monk-completed');
      const active = first.loginFallbackAccount('brother-monk-active');
      const unrelated = first.loginFallbackAccount('brother-monk-unrelated');
      first.close();

      const raw = new SQLiteDB(dbPath);
      raw.query('UPDATE player_state SET quests = ? WHERE account_id = ?').run(
        JSON.stringify({
          [BROTHER_MONK_QUEST_ID]: { stage: QUEST_STAGE_COMPLETED, triggerProgress: 0 },
          other_quest: { stage: 1, triggerProgress: 2 },
        }),
        completed.accountId,
      );
      raw.query('UPDATE player_state SET quests = ? WHERE account_id = ?').run(
        JSON.stringify({
          [BROTHER_MONK_QUEST_ID]: { stage: 2, triggerProgress: 1 },
        }),
        active.accountId,
      );
      raw.query('UPDATE player_state SET quests = ? WHERE account_id = ?').run(
        JSON.stringify({
          other_quest: { stage: QUEST_STAGE_COMPLETED, triggerProgress: 0 },
        }),
        unrelated.accountId,
      );
      raw.query('DELETE FROM server_migrations WHERE id = ?').run(RESET_COMPLETED_BROTHER_MONK_MIGRATION_ID);
      raw.close();

      const second = new GameDatabase(dbPath);
      second.close();

      const verify = new SQLiteDB(dbPath);
      const rows = verify.query('SELECT account_id, quests FROM player_state')
        .all() as Array<{ account_id: number; quests: string }>;
      const migration = verify.query('SELECT 1 FROM server_migrations WHERE id = ?')
        .get(RESET_COMPLETED_BROTHER_MONK_MIGRATION_ID);
      verify.close();

      const byAccountId = new Map(rows.map(row => [row.account_id, JSON.parse(row.quests) as Record<string, unknown>]));
      expect(byAccountId.get(completed.accountId)).toEqual({
        other_quest: { stage: 1, triggerProgress: 2 },
      });
      expect(byAccountId.get(active.accountId)).toEqual({
        [BROTHER_MONK_QUEST_ID]: { stage: 2, triggerProgress: 1 },
      });
      expect(byAccountId.get(unrelated.accountId)).toEqual({
        other_quest: { stage: QUEST_STAGE_COMPLETED, triggerProgress: 0 },
      });
      expect(migration).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
