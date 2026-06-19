import { describe, expect, test } from 'bun:test';
import { INVENTORY_SIZE, MAX_SKILL_LEVEL, type ItemDef, type WorldObjectDef } from '@projectrs/shared';
import { World } from './World';
import { Player } from './entity/Player';
import { WorldObject } from './entity/WorldObject';

function makeItemDef(id: number, name: string, stackable = false): ItemDef {
  return {
    id,
    name,
    description: name,
    value: 1,
    stackable,
    equippable: false,
  };
}

function makePlayer(name: string): Player {
  return new Player(name, 5.5, 5.5, {} as any, 1);
}

function fillInventory(player: Player, slots: Array<{ itemId: number; quantity: number }>): void {
  player.inventory = Array.from({ length: INVENTORY_SIZE }, (_, index) => slots[index] ?? { itemId: 999, quantity: 1 });
}

function makeWorldHarness(itemDefs: ItemDef[]) {
  const messages: string[] = [];
  const messageColors: Array<string | undefined> = [];
  const spawned: Array<{ itemId: number; quantity: number }> = [];
  const animations: Array<{ targetId: number }> = [];
  const events: any[] = [];
  const world: any = Object.create(World.prototype);
  world.currentTick = 10;
  world.currentTickStartMs = performance.now();
  world.players = new Map<number, Player>();
  world.worldObjects = new Map<number, WorldObject>();
  world.skillingActions = new Map();
  world.data = {
    itemDefs: new Map(itemDefs.map(def => [def.id, def])),
    rareDropTableDefs: new Map(),
    getItem: (id: number) => itemDefs.find(def => def.id === id),
  };
  world.quests = { notifyQuestEvent: () => {} };
  world.canPlayerTargetObject = () => true;
  world.isAdjacentToObject = () => true;
  world.sendChatSystem = (_player: Player, message: string, color?: string) => {
    messages.push(message);
    messageColors.push(color);
  };
  world.sendXpGain = () => {};
  world.sendLevelUp = () => {};
  world.sendSingleSkill = () => {};
  world.sendInventory = () => {};
  world.recordGameEvent = (event: any) => events.push(event);
  world.setPlayerAnimation = (_player: Player, _kind: number, _variant: number, targetId: number) => {
    animations.push({ targetId });
  };
  world.spawnGroundItem = (_player: Player, itemId: number, quantity: number) => {
    spawned.push({ itemId, quantity });
  };
  world.stopPlayerSkilling = (playerId: number) => {
    world.skillingActions.delete(playerId);
  };
  return { world, messages, messageColors, spawned, animations, events };
}

describe('skilling inventory overflow', () => {
  test('non-mining harvest stops before consuming required items when inventory is full', () => {
    const fishId = 200;
    const baitId = 201;
    const junkId = 999;
    const { world, messages, spawned } = makeWorldHarness([
      makeItemDef(fishId, 'Raw fish'),
      makeItemDef(baitId, 'Fishing bait', true),
      makeItemDef(junkId, 'Junk'),
    ]);
    const player = makePlayer('fisher');
    fillInventory(player, [{ itemId: baitId, quantity: 5 }]);
    player.actionDelay = world.currentTick;

    const def: WorldObjectDef = {
      id: 500,
      name: 'Fishing spot',
      category: 'fishingspot',
      actions: ['Fish'],
      blocking: false,
      width: 1,
      height: 1,
      color: [0, 0, 255],
      skill: 'fishing',
      levelRequired: 1,
      xpReward: 10,
      harvestItemId: fishId,
      harvestQuantity: 1,
      requiredItemId: baitId,
      consumeRequiredItem: true,
    };
    const obj = new WorldObject(def, 6.5, 5.5, player.currentMapLevel, player.currentFloor);
    world.players.set(player.id, player);
    world.worldObjects.set(obj.id, obj);
    world.skillingActions.set(player.id, { objectId: obj.id, action: 'Fish', cycleTime: 4 });

    world.tickSkillingActions();

    expect(player.inventory[0]).toEqual({ itemId: baitId, quantity: 5 });
    expect(spawned).toEqual([]);
    expect(messages).toContain("You can't carry any more.");
    expect(world.skillingActions.has(player.id)).toBe(false);
  });

  test('mining with full inventory drops ore and continues skilling', () => {
    const oreId = 25;
    const junkId = 999;
    const { world, messages, spawned } = makeWorldHarness([
      makeItemDef(oreId, 'Copper ore'),
      makeItemDef(junkId, 'Junk'),
    ]);
    const player = makePlayer('miner');
    fillInventory(player, []);
    player.actionDelay = world.currentTick;

    const def: WorldObjectDef = {
      id: 501,
      name: 'Copper rock',
      category: 'rock',
      actions: ['Mine'],
      blocking: true,
      width: 1,
      height: 1,
      color: [128, 128, 128],
      skill: 'mining',
      levelRequired: 1,
      xpReward: 18,
      harvestItemId: oreId,
      harvestQuantity: 1,
    };
    const obj = new WorldObject(def, 6.5, 5.5, player.currentMapLevel, player.currentFloor);
    world.players.set(player.id, player);
    world.worldObjects.set(obj.id, obj);
    world.skillingActions.set(player.id, { objectId: obj.id, action: 'Mine', cycleTime: 3 });

    world.tickSkillingActions();

    expect(spawned).toEqual([{ itemId: oreId, quantity: 1 }]);
    expect(messages).toContain('Your inventory is full, so the harvest falls to the ground.');
    expect(world.skillingActions.has(player.id)).toBe(true);
    expect(player.actionDelay).toBe(world.currentTick + 3);
  });

  test('full-inventory crop attempts still apply interaction delay', () => {
    const cropId = 300;
    const junkId = 999;
    const { world, messages, spawned, animations } = makeWorldHarness([
      makeItemDef(cropId, 'Cabbage'),
      makeItemDef(junkId, 'Junk'),
    ]);
    const player = makePlayer('farmer');
    fillInventory(player, []);

    const def: WorldObjectDef = {
      id: 502,
      name: 'Cabbage',
      category: 'crop',
      actions: ['Pick'],
      blocking: false,
      width: 1,
      height: 1,
      color: [40, 160, 60],
      harvestItemId: cropId,
      harvestQuantity: 1,
      depletionChance: 1,
    };
    const obj = new WorldObject(def, 6.5, 5.5, player.currentMapLevel, player.currentFloor);

    world.handleHarvestInteraction(player.id, player, obj, 'Pick');

    expect(spawned).toEqual([]);
    expect(messages).toContain("You can't carry any more.");
    expect(player.delayedUntilTick).toBe(world.currentTick + 1);
    expect(animations).toEqual([{ targetId: obj.id }]);
    expect(obj.depleted).toBe(false);
  });

  test('high-level fish can roll the rare drop table', () => {
    const fishId = 200;
    const rareId = 412;
    const { world, messages, messageColors, events } = makeWorldHarness([
      makeItemDef(fishId, 'Raw fish'),
      makeItemDef(rareId, "Knight's Cape"),
    ]);
    world.data.rareDropTableDefs.set('universal', {
      id: 'universal',
      entries: [{ type: 'item', itemId: rareId, quantity: 1, weight: 1 }],
    });
    const player = makePlayer('fisher');
    player.skills.fishing.level = MAX_SKILL_LEVEL;
    player.actionDelay = world.currentTick;

    const def: WorldObjectDef = {
      id: 503,
      name: 'Fishing spot',
      category: 'fishingspot',
      actions: ['Fish'],
      blocking: false,
      width: 1,
      height: 1,
      color: [0, 0, 255],
      skill: 'fishing',
      levelRequired: MAX_SKILL_LEVEL,
      xpReward: 10,
      harvestItemId: fishId,
      harvestQuantity: 1,
    };
    const obj = new WorldObject(def, 6.5, 5.5, player.currentMapLevel, player.currentFloor);
    world.players.set(player.id, player);
    world.worldObjects.set(obj.id, obj);
    world.skillingActions.set(player.id, { objectId: obj.id, action: 'Fish', cycleTime: 4 });

    const originalRandom = Math.random;
    const rolls = [1 / (128 * 4), 0];
    Math.random = () => rolls.shift() ?? 0;
    try {
      world.tickSkillingActions();
    } finally {
      Math.random = originalRandom;
    }

    expect(messages).toContain("You find a knight's cape among the fish.. And feel incredibly lucky!");
    expect(messageColors[messages.indexOf("You find a knight's cape among the fish.. And feel incredibly lucky!")]).toBe('#1f5fbf');
    expect(player.inventory.some(slot => slot?.itemId === rareId)).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'rare_drop',
      severity: 'rare',
      itemId: rareId,
      itemName: "Knight's Cape",
      details: expect.objectContaining({
        source: 'fishing_rare_drop_table',
        chance: 1 / (128 * 3),
        fishLevelRequired: MAX_SKILL_LEVEL,
        rareTableId: 'universal',
        rareAccessTableId: 'universal',
      }),
    }));
  });
});
