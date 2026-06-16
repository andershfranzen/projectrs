import { describe, expect, test } from 'bun:test';
import { ServerOpcode, decodePacket, decodePacketBatch } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

function exact(packet: Uint8Array): ArrayBuffer {
  return packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer;
}

function makeEncryptedPlayer(name: string, accountId: number) {
  const packets: Uint8Array[] = [];
  const ws = {
    data: {
      crypto: {
        encryptEnabled: true,
        handshakeComplete: true,
        opcodeMappingEnabled: true,
      },
    },
    sendBinary(packet: Uint8Array) {
      packets.push(packet);
    },
    send() {},
    close() {},
  } as any;
  const player = new Player(name, 10.5 + accountId, 12.5, ws, accountId);
  player.currentMapLevel = 'kcmap';
  player.currentFloor = 0;
  player.currentChunkX = 0;
  player.currentChunkZ = 0;
  player.effectiveY = 0;
  player.syncDirty = true;
  return { player, packets };
}

describe('broadcast sync batching', () => {
  test('encrypted sessions receive one batch containing normal logical packets', () => {
    const viewer = makeEncryptedPlayer('viewer', 1);
    const subject = makeEncryptedPlayer('subject', 2);

    const world = Object.create(World.prototype) as any;
    world.players = new Map([[viewer.player.id, viewer.player], [subject.player.id, subject.player]]);
    world.npcs = new Map();
    world.worldObjects = new Map();
    world.groundItems = new Map();
    world.currentTick = 42;
    world._dirtyPlayerPackets = new Map();
    world._dirtyNpcPackets = new Map();
    world._playerMovementStepBatches = new Map([[viewer.player.id, {
      modeIndex: 1,
      steps: [{ x: viewer.player.position.x + 1, z: viewer.player.position.y, floor: 0, y: 0 }],
    }]]);
    world._batchScratch = [];
    world.chunkManagers = new Map([['kcmap', {
      forEachEntityNearChunk(_cx: number, _cz: number, fn: (id: number) => void) {
        fn(viewer.player.id);
        fn(subject.player.id);
      },
    }]]);

    world.broadcastSync();

    expect(viewer.packets).toHaveLength(1);
    expect(new DataView(exact(viewer.packets[0])).getUint8(0)).toBe(ServerOpcode.PACKET_BATCH);

    const inner = decodePacketBatch(exact(viewer.packets[0])).map(packet => decodePacket(packet));
    expect(inner[0]).toEqual({
      opcode: ServerOpcode.PLAYER_MOVE_STEPS,
      values: [viewer.player.id, 1, 1, 125, 125, 0, 0],
    });
    expect(inner[1].opcode).toBe(ServerOpcode.PLAYER_SELF_SYNC);
    const opcodes = inner.map(packet => packet.opcode);
    expect(opcodes).toContain(ServerOpcode.PLAYER_SELF_SYNC);
    expect(opcodes).toContain(ServerOpcode.PLAYER_MOVE_STEPS);
    expect(opcodes).toContain(ServerOpcode.PLAYER_SYNC);
    expect(opcodes).toContain(ServerOpcode.PLAYER_REMOTE_EQUIPMENT);
    expect(opcodes).toContain(ServerOpcode.PLAYER_REMOTE_STANCE);
    expect(opcodes).toContain(ServerOpcode.PLAYER_ANIMATION);
  });
});
