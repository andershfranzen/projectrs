import { describe, expect, test } from 'bun:test';
import { GameDatabase } from '../src/Database';

describe('game event log', () => {
  test('records, lists, filters, and polls event rows', () => {
    const db = new GameDatabase(':memory:');
    try {
      const first = db.recordGameEvent({
        type: 'chat',
        message: 'alice: hello',
        actorAccountId: 1,
        actorName: 'alice',
        details: { channel: 'local', message: 'hello' },
      });
      const second = db.recordGameEvent({
        type: 'rare_drop',
        severity: 'rare',
        message: 'alice rolled a rare',
        actorAccountId: 1,
        actorName: 'alice',
        itemId: 412,
        itemName: "Knight's Cape",
        quantity: 1,
        mapLevel: 'kcmap',
        floor: 0,
        x: 12.5,
        z: 18.5,
        details: { table: 'mega_rare' },
      });
      const third = db.recordGameEvent({
        type: 'private_chat',
        message: 'bob privately messaged alice: secret',
        actorAccountId: 2,
        actorName: 'bob',
        targetAccountId: 1,
        targetName: 'alice',
        details: { channel: 'private', message: 'secret' },
      });
      if (!first || !second || !third) throw new Error('Expected event rows to be recorded');

      expect(first.id).toBe(0);
      expect(second.id).toBe(0);
      expect(third.id).toBe(0);
      expect(db.flushGameEventLog()).toBe(3);

      const rows = db.listGameEventLog({ limit: 10 });
      const chatId = rows.find(row => row.type === 'chat')?.id;
      const rareId = rows.find(row => row.type === 'rare_drop')?.id;
      const privateId = rows.find(row => row.type === 'private_chat')?.id;
      if (chatId == null || rareId == null || privateId == null) throw new Error('Expected flushed event IDs');
      expect(db.getLatestGameEventLogId()).toBe(privateId);
      expect(rareId).toBeGreaterThan(chatId);
      expect(privateId).toBeGreaterThan(rareId);
      expect(rows.map(row => row.type)).toEqual(['private_chat', 'rare_drop', 'chat']);
      expect(rows[1].itemName).toBe("Knight's Cape");
      expect(rows[1].details).toEqual({ table: 'mega_rare' });

      expect(db.listGameEventLog({ afterId: chatId }).map(row => row.id)).toEqual([rareId, privateId]);
      expect(db.listGameEventLog({ excludeTypes: ['chat'] }).map(row => row.type)).toEqual(['private_chat', 'rare_drop']);
      expect(db.listGameEventLog({ user: 'alice' }).map(row => row.type)).toEqual(['private_chat', 'rare_drop', 'chat']);
      expect(db.listGameEventLog({ user: 'bob' }).map(row => row.type)).toEqual(['private_chat']);
      expect(db.listGameEventLog({ query: 'knight' }).map(row => row.type)).toEqual(['rare_drop']);
      expect(db.listGameEventLog({ query: 'secret' }).map(row => row.type)).toEqual(['private_chat']);
    } finally {
      db.close();
    }
  });
});
