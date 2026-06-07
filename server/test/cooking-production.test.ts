import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BOWSTRING_ITEM_ID,
  COOKING_RANGE_OBJECT_DEF_ID,
  LOW_QUALITY_SINEW_ITEM_ID,
  ServerOpcode,
  SPINNING_WHEEL_OBJECT_DEF_ID,
} from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

const FISH_TIERS = [
  { level: 1, rawItemId: 500, name: 'Minnow', xp: 20, healAmount: 3 },
  { level: 5, rawItemId: 501, name: 'Crayfish', xp: 30, healAmount: 3 },
  { level: 10, rawItemId: 502, name: 'Bluegill', xp: 45, healAmount: 4 },
  { level: 15, rawItemId: 503, name: 'Perch', xp: 60, healAmount: 5 },
  { level: 20, rawItemId: 504, name: 'Roach', xp: 75, healAmount: 6 },
  { level: 25, rawItemId: 505, name: 'Trout', xp: 90, healAmount: 7 },
  { level: 30, rawItemId: 506, name: 'Carp', xp: 110, healAmount: 8 },
  { level: 35, rawItemId: 507, name: 'Salmon', xp: 130, healAmount: 9 },
  { level: 40, rawItemId: 508, name: 'Bass', xp: 150, healAmount: 10 },
  { level: 45, rawItemId: 509, name: 'Mackerel', xp: 170, healAmount: 11 },
  { level: 50, rawItemId: 510, name: 'Tuna', xp: 195, healAmount: 12 },
  { level: 55, rawItemId: 511, name: 'King Crab', xp: 220, healAmount: 13 },
  { level: 60, rawItemId: 512, name: 'Catfish', xp: 245, healAmount: 14 },
  { level: 65, rawItemId: 513, name: 'Snapper', xp: 275, healAmount: 15 },
  { level: 70, rawItemId: 514, name: 'Sturgeon', xp: 305, healAmount: 16 },
  { level: 75, rawItemId: 515, name: 'Swordfish', xp: 335, healAmount: 17 },
  { level: 80, rawItemId: 516, name: 'Reef Shark', xp: 370, healAmount: 18 },
  { level: 85, rawItemId: 517, name: 'Halibut', xp: 405, healAmount: 19 },
  { level: 90, rawItemId: 518, name: 'Hammerhead Shark', xp: 440, healAmount: 20 },
  { level: 95, rawItemId: 519, name: 'Marlin', xp: 480, healAmount: 21 },
  { level: 100, rawItemId: 520, name: 'Thresher Shark', xp: 520, healAmount: 22 },
  { level: 105, rawItemId: 521, name: 'Mako Shark', xp: 560, healAmount: 23 },
  { level: 110, rawItemId: 522, name: 'Tiger Shark', xp: 605, healAmount: 24 },
  { level: 115, rawItemId: 523, name: 'Oarfish', xp: 650, healAmount: 25 },
  { level: 120, rawItemId: 524, name: 'Great White Shark', xp: 700, healAmount: 26 },
] as const;

function makePlayer(): Player {
  return new Player('cook_test', 9.5, 10.5, fakeWs, 1);
}

function makeCookingRange(): any {
  return {
    id: 10007,
    defId: COOKING_RANGE_OBJECT_DEF_ID,
    mapLevel: 'kcmap',
    x: 10.5,
    z: 10.5,
    depleted: false,
    doorOpen: false,
    displayName: 'Cooking Range',
    examineText: 'A cooking range.',
    currentActions: ['Cook', 'Examine'],
    interactions: [],
    def: {
      id: COOKING_RANGE_OBJECT_DEF_ID,
      name: 'Cooking Range',
      category: 'cookingrange',
      width: 1,
      height: 1,
      recipes: [{
        inputItemId: 11,
        inputQuantity: 1,
        outputItemId: 12,
        outputQuantity: 1,
        skill: 'cooking',
        levelRequired: 1,
        xpReward: 30,
      }],
    },
  };
}

function makeSpinningWheel(): any {
  return {
    id: 10040,
    defId: SPINNING_WHEEL_OBJECT_DEF_ID,
    mapLevel: 'kcmap',
    x: 10.5,
    z: 10.5,
    depleted: false,
    doorOpen: false,
    displayName: 'Spinning Wheel',
    examineText: 'A spinning wheel.',
    currentActions: ['Spin', 'Examine'],
    interactions: [],
    def: {
      id: SPINNING_WHEEL_OBJECT_DEF_ID,
      name: 'Spinning Wheel',
      category: 'scenery',
      width: 1,
      height: 1.2,
      recipes: [{
        inputItemId: LOW_QUALITY_SINEW_ITEM_ID,
        inputQuantity: 1,
        outputItemId: BOWSTRING_ITEM_ID,
        outputQuantity: 1,
        skill: 'crafting',
        levelRequired: 1,
        xpReward: 5,
      }],
    },
  };
}

describe('cooking range production', () => {
  test('actual cooking range data exposes beef sinew as a separate option', () => {
    const dataDir = join(import.meta.dir, '..', 'data');
    const items = JSON.parse(readFileSync(join(dataDir, 'items.json'), 'utf8')) as Array<{ id: number; name: string }>;
    const objects = JSON.parse(readFileSync(join(dataDir, 'objects.json'), 'utf8')) as Array<{
      id: number;
      recipes?: Array<{ inputItemId: number; outputItemId: number; xpReward: number }>;
    }>;

    const sinew = items.find((item) => item.id === 269);
    const range = objects.find((object) => object.id === COOKING_RANGE_OBJECT_DEF_ID);
    const beefRecipes = range?.recipes?.filter((recipe) => recipe.inputItemId === 263) ?? [];

    expect(sinew?.name).toBe('Low Quality Sinew');
    expect(beefRecipes.map((recipe) => recipe.outputItemId)).toEqual([15, 269]);
    expect(beefRecipes.map((recipe) => recipe.xpReward)).toEqual([30, 5]);
  });

  test('actual cooking range data can cook every fish tier', () => {
    const dataDir = join(import.meta.dir, '..', 'data');
    const items = JSON.parse(readFileSync(join(dataDir, 'items.json'), 'utf8')) as Array<{
      id: number;
      name: string;
      healAmount?: number;
      value: number;
    }>;
    const objects = JSON.parse(readFileSync(join(dataDir, 'objects.json'), 'utf8')) as Array<{
      id: number;
      recipes?: Array<{
        inputItemId: number;
        outputItemId: number;
        skill: string;
        levelRequired: number;
        xpReward: number;
      }>;
    }>;

    const itemsById = new Map(items.map(item => [item.id, item]));
    const range = objects.find((object) => object.id === COOKING_RANGE_OBJECT_DEF_ID);
    const recipesByInputId = new Map((range?.recipes ?? []).map(recipe => [recipe.inputItemId, recipe]));

    for (const tier of FISH_TIERS) {
      const cookedItemId = tier.rawItemId + 25;
      const raw = itemsById.get(tier.rawItemId);
      const cooked = itemsById.get(cookedItemId);
      const recipe = recipesByInputId.get(tier.rawItemId);

      expect(raw?.name).toBe(`Raw ${tier.name}`);
      expect(cooked).toMatchObject({
        name: tier.name,
        healAmount: tier.healAmount,
      });
      expect(cooked!.value).toBeGreaterThan(raw!.value);
      expect(recipe).toMatchObject({
        outputItemId: cookedItemId,
        skill: 'cooking',
        levelRequired: tier.level,
        xpReward: tier.xp,
      });
    }
  });

  test('actual spinning wheel data spins sinew into bowstring', () => {
    const dataDir = join(import.meta.dir, '..', 'data');
    const items = JSON.parse(readFileSync(join(dataDir, 'items.json'), 'utf8')) as Array<{ id: number; name: string; model?: string }>;
    const objects = JSON.parse(readFileSync(join(dataDir, 'objects.json'), 'utf8')) as Array<{
      id: number;
      recipes?: Array<{ inputItemId: number; outputItemId: number; skill: string; xpReward: number }>;
    }>;

    const bowstring = items.find((item) => item.id === BOWSTRING_ITEM_ID);
    const wheel = objects.find((object) => object.id === SPINNING_WHEEL_OBJECT_DEF_ID);

    expect(bowstring?.name).toBe('Bowstring');
    expect(bowstring?.model).toBe('/assets/models/Bowstring.glb');
    expect(wheel?.recipes?.some((recipe) =>
      recipe.inputItemId === LOW_QUALITY_SINEW_ITEM_ID
      && recipe.outputItemId === BOWSTRING_ITEM_ID
      && recipe.skill === 'crafting'
      && recipe.xpReward === 5
    )).toBe(true);
  });

  test('starts cooking with a 4-tick interval per item', () => {
    const world = Object.create(World.prototype) as any;
    const player = makePlayer();
    const obj = makeCookingRange();
    const messages: string[] = [];

    world.currentTick = 20;
    world.itemProductionActions = new Map();
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);

    world.startObjectRecipeProduction(player.id, player, obj, 0, 5);

    expect(world.itemProductionActions.get(player.id)).toEqual({
      kind: 'objectRecipe',
      objectEntityId: obj.id,
      recipeIndex: 0,
      remaining: 5,
      nextTick: 24,
      intervalTicks: 4,
    });
    expect((player as any).delayedUntilTick).toBe(24);
    expect(messages).toEqual(['You start cooking.']);
  });

  test('starts spinning with a 3-tick interval per bowstring', () => {
    const world = Object.create(World.prototype) as any;
    const player = makePlayer();
    const obj = makeSpinningWheel();
    const messages: string[] = [];

    world.currentTick = 20;
    world.itemProductionActions = new Map();
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);

    world.startObjectRecipeProduction(player.id, player, obj, 0, 3);

    expect(world.itemProductionActions.get(player.id)).toEqual({
      kind: 'objectRecipe',
      objectEntityId: obj.id,
      recipeIndex: 0,
      remaining: 3,
      nextTick: 23,
      intervalTicks: 3,
    });
    expect((player as any).delayedUntilTick).toBe(23);
    expect(messages).toEqual(['You start spinning.']);
  });

  test('make-1 cooking packets queue production instead of crafting instantly', () => {
    const world = Object.create(World.prototype) as any;
    const player = makePlayer();
    const obj = makeCookingRange();
    const started: Array<{ recipeIndex: number; quantity: number }> = [];
    const crafted: number[] = [];

    world.currentTick = 20;
    world.players = new Map([[player.id, player]]);
    world.worldObjects = new Map([[obj.id, obj]]);
    world.canPlayerTargetObject = () => true;
    world.rejectStaleDoorInteraction = () => false;
    world.clearPendingObjectIntents = () => {};
    world.cancelItemProduction = () => {};
    world.closeNpcUiContext = () => {};
    world.isAdjacentToObject = () => true;
    world.clearCombatTarget = () => {};
    world.runObjectInteractionEffects = () => {};
    world.quests = { notifyQuestEvent() {} };
    world.startObjectRecipeProduction = (_playerId: number, _player: Player, _obj: unknown, recipeIndex: number, quantity: number) => {
      started.push({ recipeIndex, quantity });
    };
    world.handleCraftingInteraction = (_playerId: number, _player: Player, _obj: unknown, recipeIndex: number) => {
      crafted.push(recipeIndex);
    };

    world.handlePlayerInteractObject(player.id, obj.id, 0, 0, null, 1);

    expect(started).toEqual([{ recipeIndex: 0, quantity: 1 }]);
    expect(crafted).toEqual([]);
  });

  test('make-1 spinning wheel packets queue production instead of crafting instantly', () => {
    const world = Object.create(World.prototype) as any;
    const player = makePlayer();
    const obj = makeSpinningWheel();
    const started: Array<{ recipeIndex: number; quantity: number }> = [];
    const crafted: number[] = [];

    world.currentTick = 20;
    world.players = new Map([[player.id, player]]);
    world.worldObjects = new Map([[obj.id, obj]]);
    world.canPlayerTargetObject = () => true;
    world.rejectStaleDoorInteraction = () => false;
    world.clearPendingObjectIntents = () => {};
    world.cancelItemProduction = () => {};
    world.closeNpcUiContext = () => {};
    world.isAdjacentToObject = () => true;
    world.clearCombatTarget = () => {};
    world.runObjectInteractionEffects = () => {};
    world.quests = { notifyQuestEvent() {} };
    world.startObjectRecipeProduction = (_playerId: number, _player: Player, _obj: unknown, recipeIndex: number, quantity: number) => {
      started.push({ recipeIndex, quantity });
    };
    world.handleCraftingInteraction = (_playerId: number, _player: Player, _obj: unknown, recipeIndex: number) => {
      crafted.push(recipeIndex);
    };

    world.handlePlayerInteractObject(player.id, obj.id, 0, 0, null, 1);

    expect(started).toEqual([{ recipeIndex: 0, quantity: 1 }]);
    expect(crafted).toEqual([]);
  });

  test('using stacked sinew on a spinning wheel opens the quantity picker', () => {
    const world = Object.create(World.prototype) as any;
    const player = makePlayer();
    const obj = makeSpinningWheel();
    const opened: number[] = [];
    const started: Array<{ recipeIndex: number; quantity: number }> = [];
    const crafted: number[] = [];

    player.inventory[0] = { itemId: LOW_QUALITY_SINEW_ITEM_ID, quantity: 3 };
    world.currentTick = 20;
    world.players = new Map([[player.id, player]]);
    world.worldObjects = new Map([[obj.id, obj]]);
    world.canPlayerTargetObject = () => true;
    world.clearPendingObjectIntents = () => {};
    world.isAdjacentToObject = () => true;
    world.interruptPlayerAction = () => {};
    world.sendToPlayer = (_player: Player, opcode: ServerOpcode, ...values: number[]) => {
      if (opcode === ServerOpcode.SMITHING_OPEN) opened.push(values[0]);
    };
    world.startObjectRecipeProduction = (_playerId: number, _player: Player, _obj: unknown, recipeIndex: number, quantity: number) => {
      started.push({ recipeIndex, quantity });
    };
    world.handleCraftingInteraction = (_playerId: number, _player: Player, _obj: unknown, recipeIndex: number) => {
      crafted.push(recipeIndex);
    };

    world.handlePlayerUseItemOnObject(player.id, 0, LOW_QUALITY_SINEW_ITEM_ID, obj.id);

    expect(opened).toEqual([obj.id]);
    expect(started).toEqual([]);
    expect(crafted).toEqual([]);
  });

  test('successful spinning wheel production broadcasts object animation', () => {
    const world = Object.create(World.prototype) as any;
    const player = makePlayer();
    const obj = makeSpinningWheel();
    const broadcasts: Array<{ opcode: ServerOpcode; values: number[] }> = [];

    player.inventory[0] = { itemId: LOW_QUALITY_SINEW_ITEM_ID, quantity: 1 };
    world.data = {
      itemDefs: new Map([[BOWSTRING_ITEM_ID, { id: BOWSTRING_ITEM_ID, name: 'Bowstring' }]]),
      getItem: () => ({ name: 'Low Quality Sinew' }),
    };
    world.sendToPlayer = () => {};
    world.sendInventory = () => {};
    world.sendSingleSkill = () => {};
    world.broadcastNearbyOnFloor = (_mapId: string, _floor: number, _x: number, _z: number, opcode: ServerOpcode, ...values: number[]) => {
      broadcasts.push({ opcode, values });
    };

    const crafted = world.handleCraftingInteraction(player.id, player, obj, 0, { interrupt: false });

    expect(crafted).toBe(true);
    expect(broadcasts).toContainEqual({
      opcode: ServerOpcode.WORLD_OBJECT_ANIMATION,
      values: [obj.id],
    });
  });
});
