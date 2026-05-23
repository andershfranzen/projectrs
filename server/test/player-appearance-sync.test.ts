import { describe, expect, test } from 'bun:test';
import { ServerOpcode, decodePacket, type PlayerAppearance } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

function decodeBinaryPacket(packet: Uint8Array) {
  const exact = packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer;
  return decodePacket(exact);
}

function makePlayer(name: string, accountId: number, appearance: PlayerAppearance) {
  const packets: ReturnType<typeof decodeBinaryPacket>[] = [];
  const ws = {
    sendBinary(packet: Uint8Array) {
      packets.push(decodeBinaryPacket(packet));
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
  player.appearance = appearance;
  player.syncDirty = true;
  return { player, packets };
}

describe('player appearance sync', () => {
  test('self sync and remote presence use the same authoritative appearance', () => {
    const appearance: PlayerAppearance = {
      shirtColor: 3,
      pantsColor: 4,
      shoesColor: 5,
      hairColor: 6,
      beltColor: 7,
      skinColor: 2,
      hairStyle: 9,
    };
    const viewer = makePlayer('viewer', 1, {
      shirtColor: 0,
      pantsColor: 1,
      shoesColor: 2,
      hairColor: 3,
      beltColor: 4,
      skinColor: 5,
      hairStyle: 6,
    });
    const subject = makePlayer('subject', 2, appearance);

    const world = Object.create(World.prototype) as any;
    world.players = new Map([[viewer.player.id, viewer.player], [subject.player.id, subject.player]]);
    world.npcs = new Map();
    world.worldObjects = new Map();
    world.groundItems = new Map();
    world.currentTick = 42;
    world._dirtyPlayerPackets = new Map();
    world._dirtyNpcPackets = new Map();
    world.chunkManagers = new Map([['kcmap', {
      forEachEntityNearChunk(_cx: number, _cz: number, fn: (id: number) => void) {
        fn(viewer.player.id);
        fn(subject.player.id);
      },
    }]]);

    world.broadcastSync();

    const selfSync = subject.packets.find((packet) => packet.opcode === ServerOpcode.PLAYER_SELF_SYNC);
    expect(selfSync?.values.slice(6, 13)).toEqual([
      appearance.shirtColor,
      appearance.pantsColor,
      appearance.shoesColor,
      appearance.hairColor,
      appearance.beltColor,
      appearance.skinColor,
      appearance.hairStyle,
    ]);

    const remoteSync = viewer.packets.find(
      (packet) => packet.opcode === ServerOpcode.PLAYER_SYNC && packet.values[0] === subject.player.id,
    );
    expect(remoteSync?.values.slice(5, 12)).toEqual(selfSync?.values.slice(6, 13));
  });
});
