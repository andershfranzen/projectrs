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
  test('reserved capability is not labeled in the public wire packet', () => {
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
    const firstReserved = caps[0];
    const lastReserved = caps.at(-1);
    expect(firstReserved[5]).toBe(0);
    expect(lastReserved[5]).toBe(0);
    expect(firstReserved[1]).not.toBe(obj.id);
    expect(lastReserved[1]).not.toBe(obj.id);
    expect(player.consumeReservedActionCapability(firstReserved[3], firstReserved[4], world.currentTick)).toBe(true);
    expect(player.consumeReservedActionCapability(lastReserved[3], lastReserved[4], world.currentTick)).toBe(true);

    const visibleObjectCap = caps.find((cap: number[]) => cap[0] === ActionCapabilityKind.WorldObject && cap[1] === obj.id && cap[2] === 0);
    expect(visibleObjectCap).toBeTruthy();
    if (!visibleObjectCap) throw new Error('missing visible object capability');
    expect(visibleObjectCap?.[5]).toBe(0);
    expect(player.consumeActionCapability(
      visibleObjectCap[3],
      visibleObjectCap[4],
      ActionCapabilityKind.WorldObject,
      obj.id,
      0,
      world.currentTick,
    )).toBe('ok');
  });
});
