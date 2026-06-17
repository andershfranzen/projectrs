import { describe, expect, test } from 'bun:test';
import { ACTION_CAPABILITY_RESERVED_FLAG, ActionCapabilityKind, decodeStringPacket } from '@projectrs/shared';
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
  world.npcs = new Map();
  world.worldObjects = new Map();
  world.groundItems = new Map();
  world.canPlayerTargetObject = () => true;
  world.currentObjectActionsForPlayer = () => ['Chop', 'Examine'];
  return world;
}

describe('action capabilities', () => {
  test('reserved capability shadows the primary visible object action', () => {
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
    const expectedTarget = [
      ActionCapabilityKind.WorldObject,
      obj.id,
      0,
    ];
    expect(firstReserved.slice(0, 3)).toEqual(expectedTarget);
    expect(lastReserved.slice(0, 3)).toEqual(expectedTarget);
    expect(firstReserved[5]).toBe(ACTION_CAPABILITY_RESERVED_FLAG);
    expect(lastReserved[5]).toBe(ACTION_CAPABILITY_RESERVED_FLAG);
    expect(caps.some((cap: number[]) => cap[1] === obj.id && cap[2] === 0 && cap[5] === 0)).toBe(true);
  });
});
