import { describe, expect, test } from 'bun:test';
import { ActionCapabilityKind, decodeStringPacket } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { WorldObject } from '../src/entity/WorldObject';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function makeWorld(): any {
  const world = Object.create(World.prototype) as any;
  world.currentTick = 100;
  world.players = new Map();
  world.npcs = new Map();
  world.worldObjects = new Map();
  world.groundItems = new Map();
  world.canPlayerTargetObject = () => true;
  world.currentObjectActionsForPlayer = () => ['Chop', 'Examine'];
  return world;
}

describe('action capabilities', () => {
  test('reserved capability shadows one visible action without replacing official real tokens', () => {
    const world = makeWorld();
    const player = new Player('tester', 0, 0, fakeWs, 1);
    const obj = new WorldObject({
      id: 1,
      name: 'Tree',
      category: 'tree',
      width: 1,
      height: 1,
      actions: ['Chop', 'Examine'],
    } as any, 10.5, 10.5, 'kcmap');
    world.worldObjects.set(obj.id, obj);

    const out: Array<{ data: Uint8Array }> = [];
    world.queueActionCapabilities(out, player, new Set([obj.id]), new Set(), true);

    const data = out[0].data;
    const { str } = decodeStringPacket(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    const caps = JSON.parse(str);
    const canaryIndex = caps.findIndex((cap: number[], index: number) => {
      const next = caps[index + 1];
      return (cap[5] & 1) !== 0
        && next
        && next[5] === 0
        && next[0] === cap[0]
        && next[1] === cap[1]
        && next[2] === cap[2];
    });
    expect(canaryIndex).toBeGreaterThanOrEqual(0);

    const firstReserved = caps[canaryIndex];
    const firstShadow = caps[canaryIndex + 1];
    const lastReserved = caps.at(-1);
    expect(firstReserved[5]).toBe(1);
    expect(firstShadow[5]).toBe(0);
    expect(lastReserved[5]).toBe(1);
    expect(firstReserved.slice(0, 3)).toEqual(firstShadow.slice(0, 3));
    expect(player.consumeReservedActionCapability(firstReserved[3], firstReserved[4], world.currentTick)).toBe(true);
    expect(player.consumeReservedActionCapability(lastReserved[3], lastReserved[4], world.currentTick)).toBe(true);
    expect(player.consumeActionCapability(
      firstShadow[3],
      firstShadow[4],
      firstShadow[0],
      firstShadow[1],
      firstShadow[2],
      world.currentTick,
    )).toBe('reserved');

    const officialCaps = caps.filter((cap: number[]) =>
      cap[0] === firstShadow[0]
      && cap[1] === firstShadow[1]
      && cap[2] === firstShadow[2]
      && cap[5] === 0);
    expect(officialCaps).toHaveLength(4);
    const visibleObjectCap = officialCaps.at(-1);
    expect(visibleObjectCap).toBeTruthy();
    if (!visibleObjectCap) throw new Error('missing visible object capability');
    expect(visibleObjectCap?.[5]).toBe(0);
    expect(player.consumeActionCapability(
      visibleObjectCap[3],
      visibleObjectCap[4],
      visibleObjectCap[0],
      visibleObjectCap[1],
      visibleObjectCap[2],
      world.currentTick,
    )).toBe('ok');
    expect(player.consumeActionCapability(
      visibleObjectCap[3],
      visibleObjectCap[4],
      visibleObjectCap[0],
      visibleObjectCap[1],
      visibleObjectCap[2],
      world.currentTick,
    )).toBe('replayed');
  });
});
