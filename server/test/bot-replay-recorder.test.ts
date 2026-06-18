import { describe, expect, test } from 'bun:test';
import { Buffer } from 'buffer';
import { ClientOpcode, ServerOpcode, encodePacket } from '@projectrs/shared';
import { BotReplayRecorder } from '../src/BotReplayRecorder';
import { GameDatabase } from '../src/Database';
import { Player } from '../src/entity/Player';

function testPlayer(db: GameDatabase, username: string = 'trace-target'): Player {
  const session = db.loginFallbackAccount(username, '11111111-1111-4111-8111-111111111111');
  const ws = { sendBinary: () => 0, close: () => undefined, data: { type: 'game' } } as any;
  const player = new Player(username, 12.5, 18.5, ws, session.accountId);
  player.ip = '203.0.113.40';
  player.deviceId = session.wsSecret;
  player.loginRowId = db.recordLogin(session.accountId, player.ip, player.deviceId);
  return player;
}

describe('BotReplayRecorder', () => {
  test('persists the rolling buffer and evicts oldest events', () => {
    const db = new GameDatabase(':memory:');
    try {
      const player = testPlayer(db, 'replay-ring');
      const recorder = new BotReplayRecorder(db, { maxEvents: 4, minPersistIntervalMs: 0 });

      recorder.startPlayer(player, 1);
      for (let i = 0; i < 6; i++) recorder.recordSnapshot(player, 2 + i, `snap-${i}`);
      const replayId = recorder.persistPlayer(player, 9, 'manual-admin-review', ['manual-admin-review'], 0, true);
      const detail = db.getAdminBotReplay(replayId ?? 0);

      expect(replayId).toBeGreaterThan(0);
      expect(detail?.events).toHaveLength(4);
      expect(detail?.events[0]?.result).toBe('snap-3');
      expect(detail?.events.at(-1)?.result).toBe('persist:manual-admin-review');
    } finally {
      db.close();
    }
  });

  test('records accepted commands and outbound raw packets', () => {
    const db = new GameDatabase(':memory:');
    try {
      const player = testPlayer(db, 'replay-packets');
      const recorder = new BotReplayRecorder(db, { maxEvents: 20, minPersistIntervalMs: 0 });
      const packet = encodePacket(ServerOpcode.PLAYER_STATS, 7, 10);

      recorder.startPlayer(player, 1);
      recorder.recordClientCommand(player, 2, {
        opcode: ClientOpcode.PLAYER_INTERACT_OBJECT,
        values: [10001, 0],
        proof: { inputSeq: 9, capabilityId: 77, hasCapability: true },
        requiresInputProof: true,
        hasValidInputTicket: true,
        inputTicket: { kind: 1, x: 500, y: 500 },
        actionCapability: { kind: 2, targetEntityId: 10001, actionIndex: 0 },
      });
      recorder.recordServerPacket(player, 3, packet);
      recorder.recordFlag(player, 4, ClientOpcode.PLAYER_INTERACT_OBJECT, 'replayed-action-capability', [10001, 0]);
      const replayId = recorder.persistPlayer(player, 4, 'replayed-action-capability', ['replayed-action-capability'], 31, true);
      const detail = db.getAdminBotReplay(replayId ?? 0);

      const client = detail?.events.find(event => event.kind === 'client');
      const server = detail?.events.find(event => event.kind === 'server');
      const flag = detail?.events.find(event => event.kind === 'flag');

      expect(client?.opcode).toBe(ClientOpcode.PLAYER_INTERACT_OBJECT);
      expect(client?.details.proof).toEqual({ inputSeq: 9, capabilityId: 77, hasCapability: true });
      expect(server?.opcode).toBe(ServerOpcode.PLAYER_STATS);
      expect(server?.rawBase64).toBe(Buffer.from(packet).toString('base64'));
      expect(flag?.reason).toBe('replayed-action-capability');
      expect(detail?.replay.riskScore).toBe(31);
    } finally {
      db.close();
    }
  });
});
