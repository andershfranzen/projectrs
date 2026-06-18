import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ItemDef, ItemToolType, WorldObjectDef } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { WorldObject } from '../src/entity/WorldObject';

const DATA_DIR = join(import.meta.dir, '../data');
const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

const SEAFOOD_CATCHES = [
  { itemId: 27, name: 'Raw Shrimp', model: '/assets/models/Food/ShrimpRaw.glb' },
  { itemId: 501, name: 'Raw Crayfish', model: '/assets/models/Food/CrayfishRaw.glb' },
  { itemId: 510, name: 'Raw Tuna', model: '/assets/models/Food/TunaRaw.glb' },
  { itemId: 523, name: 'Raw Oarfish', model: '/assets/models/Food/OarfishRaw.glb' },
  { itemId: 558, name: 'Raw Lobster', model: '/assets/models/Food/LobsterRaw.glb' },
  { itemId: 560, name: 'Raw Sardine', model: '/assets/models/Food/SardineRaw.glb' },
  { itemId: 562, name: 'Raw Octopus', model: '/assets/models/Food/OctopusRaw.glb' },
] as const;

const REMOVED_LEGACY_FISH_IDS = [
  500, 502, 503, 504, 505, 506, 507, 508, 509, 511, 512, 513, 514, 515, 516, 517, 518, 519, 520, 521, 522, 524,
  525, 527, 528, 529, 530, 531, 532, 533, 534, 536, 537, 538, 539, 540, 541, 542, 543, 544, 545, 546, 547, 549,
] as const;

function loadItems(): ItemDef[] {
  return JSON.parse(readFileSync(join(DATA_DIR, 'items.json'), 'utf8')) as ItemDef[];
}

function loadObjects(): WorldObjectDef[] {
  return JSON.parse(readFileSync(join(DATA_DIR, 'objects.json'), 'utf8')) as WorldObjectDef[];
}

function optionNames(spot: WorldObjectDef, itemsById: Map<number, ItemDef>): string[] {
  return (spot.harvestOptions ?? []).map(option => itemsById.get(option.harvestItemId)?.name ?? `item ${option.harvestItemId}`);
}

function makeHarvestWorld(itemsById: Map<number, ItemDef>): { world: any; messages: string[] } {
  const messages: string[] = [];
  const world = Object.create(World.prototype) as any;
  world.data = { getItem: (id: number) => itemsById.get(id) };
  world.skillingActions = new Map();
  world.setPlayerAnimation = () => {};
  world.sendToPlayer = () => {};
  world.sendChatSystem = (_player: Player, message: string) => messages.push(message);
  return { world, messages };
}

describe('fishing spot data', () => {
  test('only modeled seafood catches remain as active fish item definitions', () => {
    const itemsById = new Map(loadItems().map(item => [item.id, item]));

    for (const catchDef of SEAFOOD_CATCHES) {
      expect(itemsById.get(catchDef.itemId)).toMatchObject({
        name: catchDef.name,
        stackable: false,
        equippable: false,
        model: catchDef.model,
      });
    }

    for (const removedId of REMOVED_LEGACY_FISH_IDS) {
      expect(itemsById.has(removedId), `removed fish item ${removedId}`).toBe(false);
    }

    expect(itemsById.get(564)).toMatchObject({
      name: 'Fishing Bait',
      stackable: true,
      equippable: false,
      icon: '/items/Fishing_Bait_380.png',
    });
  });

  test('fishingspot definitions group catches into placeable spot types', () => {
    const itemsById = new Map(loadItems().map(item => [item.id, item]));
    const spots = loadObjects().filter(object => object.category === 'fishingspot');
    const spotsByName = new Map(spots.map(spot => [spot.name, spot]));

    expect(optionNames(spotsByName.get('Shallow Fishing Spot')!, itemsById)).toEqual(['Raw Shrimp']);
    expect(optionNames(spotsByName.get('River Fishing Spot')!, itemsById)).toEqual(['Raw Sardine']);
    expect(optionNames(spotsByName.get('Lake Fishing Spot')!, itemsById)).toEqual(['Raw Tuna']);
    expect(optionNames(spotsByName.get('Coastal Fishing Spot')!, itemsById)).toEqual(['Raw Octopus']);
    expect(optionNames(spotsByName.get('Deep Sea Fishing Spot')!, itemsById)).toEqual(['Raw Octopus']);
    expect(optionNames(spotsByName.get('Shark Fishing Spot')!, itemsById)).toEqual(['Raw Octopus']);
    expect(optionNames(spotsByName.get('Rare Ocean Fishing Spot')!, itemsById)).toEqual(['Raw Octopus']);
    expect(optionNames(spotsByName.get('Low Level Crab Pot Fishing Spot')!, itemsById)).toEqual(['Raw Crayfish']);
    expect(optionNames(spotsByName.get('Superior Crab Pot Fishing Spot')!, itemsById)).toEqual(['Raw Lobster']);
    expect(optionNames(spotsByName.get('Deep Fishing Spot')!, itemsById)).toEqual(['Raw Oarfish']);

    const covered = new Set(spots.flatMap(spot => (spot.harvestOptions ?? []).map(option => option.harvestItemId)));
    expect([...covered].sort((a, b) => a - b)).toEqual(SEAFOOD_CATCHES.map(catchDef => catchDef.itemId).sort((a, b) => a - b));
  });

  test('fishingspot definitions require their related fishing tool items', () => {
    const itemsById = new Map(loadItems().map(item => [item.id, item]));
    const spotsByName = new Map(loadObjects().filter(object => object.category === 'fishingspot').map(spot => [spot.name, spot]));

    const expectedTools = new Map<string, ItemToolType>([
      ['Shallow Fishing Spot', 'fishing_net'],
      ['River Fishing Spot', 'fishing_rod'],
      ['Lake Fishing Spot', 'fishing_rod'],
      ['Deep Fishing Spot', 'fishing_rod'],
      ['Coastal Fishing Spot', 'harpoon'],
      ['Deep Sea Fishing Spot', 'harpoon'],
      ['Shark Fishing Spot', 'harpoon'],
      ['Rare Ocean Fishing Spot', 'harpoon'],
      ['Low Level Crab Pot Fishing Spot', 'fishing_pot'],
      ['Superior Crab Pot Fishing Spot', 'fishing_pot'],
    ]);

    for (const [spotName, toolType] of expectedTools) {
      const spot = spotsByName.get(spotName);
      const tool = spot?.visualToolItemId ? itemsById.get(spot.visualToolItemId) : undefined;
      expect(tool?.toolType, spotName).toBe(toolType);
    }
  });

  test('rod fishing spots require and consume fishing bait', () => {
    const itemsById = new Map(loadItems().map(item => [item.id, item]));
    const riverSpot = loadObjects().find(object => object.name === 'River Fishing Spot')!;
    const player = new Player('bait_test', 10.5, 10.5, fakeWs, 1);
    player.skills.fishing.level = 40;
    player.skills.fishing.currentLevel = 40;
    player.inventory[0] = { itemId: 553, quantity: 1 };
    const obj = new WorldObject(riverSpot, 10.5, 11.5, 'kcmap');

    const missingBait = makeHarvestWorld(itemsById);
    missingBait.world.handleHarvestInteraction(player.id, player, obj, 'Fish');
    expect(missingBait.world.skillingActions.has(player.id)).toBe(false);
    expect(missingBait.messages).toContain('You need fishing bait to fish.');

    player.inventory[1] = { itemId: 564, quantity: 2 };
    const withBait = makeHarvestWorld(itemsById);
    withBait.world.handleHarvestInteraction(player.id, player, obj, 'Fish');
    expect(withBait.messages).toEqual([]);
    expect(withBait.world.skillingActions.get(player.id)).toMatchObject({
      objectId: obj.id,
      action: 'Fish',
      toolItemId: 553,
    });

    expect(withBait.world.consumeHarvestRequiredItem(player, riverSpot)).toBe('consumed');
    expect(player.inventory[1]).toEqual({ itemId: 564, quantity: 1 });
  });

  test('server blocks crab pot fishing until the player has a crab pot', () => {
    const itemsById = new Map(loadItems().map(item => [item.id, item]));
    const crabPotSpot = loadObjects().find(object => object.name === 'Low Level Crab Pot Fishing Spot')!;
    const player = new Player('shellfish_test', 10.5, 10.5, fakeWs, 1);
    player.skills.fishing.level = 40;
    player.skills.fishing.currentLevel = 40;
    const obj = new WorldObject(crabPotSpot, 10.5, 11.5, 'kcmap');

    const missing = makeHarvestWorld(itemsById);
    missing.world.handleHarvestInteraction(player.id, player, obj, 'Fish');
    expect(missing.world.skillingActions.has(player.id)).toBe(false);
    expect(missing.messages).toContain('You need a crab pot to fish.');

    const withTool = makeHarvestWorld(itemsById);
    player.inventory[0] = { itemId: 557, quantity: 1 };
    withTool.world.handleHarvestInteraction(player.id, player, obj, 'Fish');
    expect(withTool.messages).toEqual([]);
    expect(withTool.world.skillingActions.get(player.id)).toMatchObject({
      objectId: obj.id,
      action: 'Fish',
      toolItemId: 557,
    });
  });

  test('server harvest resolver only rolls unlocked spot options', () => {
    const world = Object.create(World.prototype) as any;
    const objectsByName = new Map(loadObjects().map(object => [object.name, object]));

    const shallow = objectsByName.get('Shallow Fishing Spot')!;
    expect(world.resolveHarvestYield(shallow, 4, () => 0)).toBeNull();
    expect(world.resolveHarvestYield(shallow, 5, () => 0)).toMatchObject({ itemId: 27, xpReward: 20 });

    const river = objectsByName.get('River Fishing Spot')!;
    expect(world.resolveHarvestYield(river, 14, () => 0)).toBeNull();
    expect(world.resolveHarvestYield(river, 15, () => 0)).toMatchObject({ itemId: 560, xpReward: 30 });

    const lake = objectsByName.get('Lake Fishing Spot')!;
    expect(world.resolveHarvestYield(lake, 34, () => 0)).toBeNull();
    expect(world.resolveHarvestYield(lake, 35, () => 0)).toMatchObject({ itemId: 510, xpReward: 195 });

    const harpoon = objectsByName.get('Deep Sea Fishing Spot')!;
    expect(world.resolveHarvestYield(harpoon, 77, () => 0)).toBeNull();
    expect(world.resolveHarvestYield(harpoon, 78, () => 0)).toMatchObject({ itemId: 562, xpReward: 150 });

    const crabPot = objectsByName.get('Low Level Crab Pot Fishing Spot')!;
    expect(world.resolveHarvestYield(crabPot, 1, () => 0)).toMatchObject({ itemId: 501, xpReward: 30 });

    const superiorCrabPot = objectsByName.get('Superior Crab Pot Fishing Spot')!;
    expect(world.resolveHarvestYield(superiorCrabPot, 49, () => 0)).toBeNull();
    expect(world.resolveHarvestYield(superiorCrabPot, 50, () => 0)).toMatchObject({ itemId: 558, xpReward: 150 });

    const deep = objectsByName.get('Deep Fishing Spot')!;
    expect(world.resolveHarvestYield(deep, 86, () => 0)).toBeNull();
    expect(world.resolveHarvestYield(deep, 87, () => 0)).toMatchObject({ itemId: 523, xpReward: 650 });
  });
});
