import { describe, expect, test } from 'bun:test';
import type { RareDropTableDef } from '@projectrs/shared';
import { World } from '../src/World';
import type { GameEventLogInput } from '../src/Database';

function makeWorld(): any {
  let nextGroundItemId = 20000;
  const events: GameEventLogInput[] = [];
  const messages: string[] = [];
  const world = Object.create(World.prototype) as any;
  world.data = {
    rareDropTableDefs: new Map<string, RareDropTableDef>(),
    itemDefs: new Map([
      [1, { id: 1, name: 'Bones' }],
      [10, { id: 10, name: 'Coins' }],
      [411, { id: 411, name: 'Green Cape' }],
    ]),
    getItem(itemId: number) {
      return this.itemDefs.get(itemId) ?? null;
    },
  };
  world.groundItems = new Map();
  world.despawningItemIds = new Set();
  world.chunkManagers = new Map();
  world.players = new Map();
  world.allocateGroundItemId = () => ++nextGroundItemId;
  world.forEachPlayerNearOnFloor = () => {};
  world.sendGroundItemUpdate = () => {};
  world.sendChatSystem = (_player: unknown, message: string) => messages.push(message);
  world.db = {
    recordGameEvent(event: GameEventLogInput) {
      events.push(event);
    },
  };
  return { world, events, messages };
}

function npcWithLoot(itemId: number, chance: number = 1): any {
  return {
    currentMapLevel: 'kcmap',
    currentFloor: 0,
    position: { x: 12.5, y: 18.5 },
    def: {
      id: 501,
      name: 'Test Cub',
      lootTable: [{ itemId, quantity: 1, chance }],
      rareDropTables: [],
    },
  };
}

describe('NPC drop game event logging', () => {
  test('suppresses low-value normal NPC drop log rows without suppressing the drop', () => {
    const { world, events } = makeWorld();

    world.spawnNpcLoot(npcWithLoot(1), null);

    expect(world.groundItems.size).toBe(1);
    expect(events).toEqual([]);
  });

  test('keeps rare drop logs even when the rare item is normally low value', () => {
    const { world, events } = makeWorld();
    world.data.rareDropTableDefs.set('universal', {
      id: 'universal',
      entries: [{ type: 'item', itemId: 1, quantity: 1, weight: 1 }],
    });
    const npc = npcWithLoot(10);
    npc.def.lootTable = [];
    npc.def.rareDropTables = [{ tableId: 'universal', chance: 1 }];

    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      world.spawnNpcLoot(npc, null);
    } finally {
      Math.random = originalRandom;
    }

    expect(world.groundItems.size).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'rare_drop',
      severity: 'rare',
      itemId: 1,
      itemName: 'Bones',
      quantity: 1,
    });
  });

  test('tells the owner when they roll the rare drop table', () => {
    const { world, messages } = makeWorld();
    world.data.rareDropTableDefs.set('universal', {
      id: 'universal',
      entries: [{ type: 'item', itemId: 10, quantity: 1, weight: 1 }],
    });
    const owner = {
      id: 1234,
      accountId: 77,
      name: 'Lucky',
      currentMapLevel: 'kcmap',
      currentFloor: 0,
    };
    world.players.set(owner.id, owner);
    const npc = npcWithLoot(10);
    npc.def.lootTable = [];
    npc.def.rareDropTables = [{ tableId: 'universal', chance: 1 }];

    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      world.spawnNpcLoot(npc, owner.id);
    } finally {
      Math.random = originalRandom;
    }

    expect(messages).toEqual(["All of a sudden you're feeling very lucky..."]);
  });

  test('classifies ordinary NPC drops below one-in-32 as rare logs', () => {
    const { world, events, messages } = makeWorld();

    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      world.spawnNpcLoot(npcWithLoot(411, 1 / 128), null);
    } finally {
      Math.random = originalRandom;
    }

    expect(world.groundItems.size).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'rare_drop',
      severity: 'rare',
      itemId: 411,
      itemName: 'Green Cape',
      quantity: 1,
      details: {
        lootTableChance: 1 / 128,
        rareChanceThreshold: 1 / 32,
        rareReason: 'loot_table_chance',
      },
    });
    expect(messages).toEqual([]);
  });

  test('does not classify exact one-in-32 ordinary NPC drops as rare logs', () => {
    const { world, events } = makeWorld();

    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      world.spawnNpcLoot(npcWithLoot(10, 1 / 32), null);
    } finally {
      Math.random = originalRandom;
    }

    expect(world.groundItems.size).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'npc_drop',
      severity: 'info',
      itemId: 10,
      itemName: 'Coins',
      details: {
        lootTableChance: 1 / 32,
      },
    });
    expect(events[0].details?.rareReason).toBeUndefined();
  });
});
