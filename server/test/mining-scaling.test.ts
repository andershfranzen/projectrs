import { describe, expect, test } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { WorldObject } from '../src/entity/WorldObject';
import type { ItemDef, WorldObjectDef } from '@projectrs/shared';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

const rockDef: WorldObjectDef = {
  id: 3,
  name: 'Copper Rock',
  category: 'rock',
  actions: ['Mine', 'Examine'],
  blocking: true,
  width: 1,
  height: 1,
  color: [140, 90, 50],
  skill: 'mining',
  levelRequired: 1,
  harvestItemId: 25,
  harvestQuantity: 1,
  harvestTime: 7,
  successChances: {},
};

function pickaxe(id: number, name: string, toolBonus: number): ItemDef {
  return {
    id,
    name,
    description: `${name} for mining.`,
    value: 1,
    stackable: false,
    equippable: true,
    equipSlot: 'weapon',
    toolType: 'pickaxe',
    toolLevel: 1,
    toolBonus,
  };
}

function miningCycleForTool(tool: ItemDef): number {
  const player = new Player('miner', 10.5, 10.5, fakeWs, 1);
  player.skills.mining.level = 99;
  player.skills.mining.currentLevel = 99;
  player.inventory[0] = { itemId: tool.id, quantity: 1 };

  const obj = new WorldObject(rockDef, 10.5, 11.5, 'kcmap');
  const world = Object.create(World.prototype) as any;
  world.data = { getItem: (id: number) => id === tool.id ? tool : undefined };
  world.skillingActions = new Map();
  world.setPlayerAnimation = () => {};
  world.sendToPlayer = () => {};
  world.sendChatSystem = () => {};

  world.handleHarvestInteraction(player.id, player, obj, 'Mine');

  return world.skillingActions.get(player.id)?.cycleTime;
}

describe('mining tool scaling', () => {
  test('pickaxe tiers shorten rock roll cycles through Crimson and Malachor', () => {
    expect(miningCycleForTool(pickaxe(33, 'Bronze Pickaxe', 0))).toBe(7);
    expect(miningCycleForTool(pickaxe(53, 'Iron Pickaxe', 1))).toBe(6);
    expect(miningCycleForTool(pickaxe(54, 'Steel Pickaxe', 2))).toBe(5);
    expect(miningCycleForTool(pickaxe(56, 'Black Bronze Pickaxe', 3))).toBe(5);
    expect(miningCycleForTool(pickaxe(55, 'Mithril Pickaxe', 4))).toBe(4);
    expect(miningCycleForTool(pickaxe(313, 'Crimson Pickaxe', 5))).toBe(3);
    expect(miningCycleForTool(pickaxe(328, 'Malachor Pickaxe', 6))).toBe(2);
  });
});
