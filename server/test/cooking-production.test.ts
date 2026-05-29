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
