import { describe, expect, test } from 'bun:test';
import { PlayerAnimationKind, PlayerSkillAnimationVariant, ServerOpcode, decodePacket } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

function decodeBinaryPacket(packet: Uint8Array) {
  const exact = packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer;
  return decodePacket(exact);
}

function makePlayer(name: string, accountId: number, packets: ReturnType<typeof decodeBinaryPacket>[]): Player {
  const ws = {
    sendBinary(packet: Uint8Array) {
      packets.push(decodeBinaryPacket(packet));
    },
    send() {},
    close() {},
  } as any;
  const player = new Player(name, 10.5 + accountId, 12.5, ws, accountId);
  player.currentMapLevel = 'kcmap';
  player.currentChunkX = 0;
  player.currentChunkZ = 0;
  return player;
}

describe('player animation bootstrap sync', () => {
  test('map-ready replay includes an already-active remote skilling animation', () => {
    const viewerPackets: ReturnType<typeof decodeBinaryPacket>[] = [];
    const subjectPackets: ReturnType<typeof decodeBinaryPacket>[] = [];
    const viewer = makePlayer('viewer', 1, viewerPackets);
    const subject = makePlayer('woodcutter', 2, subjectPackets);
    subject.animationKind = PlayerAnimationKind.Skill;
    subject.animationVariant = PlayerSkillAnimationVariant.Chop;
    subject.animationTargetId = 10042;
    subject.animationToolItemId = 31;

    const world = Object.create(World.prototype) as any;
    world.players = new Map([[viewer.id, viewer], [subject.id, subject]]);
    world.npcs = new Map();
    world.worldObjects = new Map();
    world.groundItems = new Map();
    world.chunkManagers = new Map([['kcmap', { getEntitiesNear: () => [viewer.id, subject.id] }]]);

    world.handleMapReady(viewer.id);

    const animation = viewerPackets.find((packet) => packet.opcode === ServerOpcode.PLAYER_ANIMATION);
    expect(animation?.values).toEqual([
      subject.id,
      PlayerAnimationKind.Skill,
      PlayerSkillAnimationVariant.Chop,
      subject.animationTargetId,
      subject.animationToolItemId,
    ]);
  });
});
