import { describe, expect, test } from 'bun:test';
import { KILN_OBJECT_DEF_ID } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function makeHarness(itemId: number, quantity: number = 1): { crafted: number[]; started: Array<{ recipeIndex: number; quantity: number }> } {
  const player = new Player('kiln_test', 10.5, 10.5, fakeWs, 1);
  player.inventory[0] = { itemId, quantity };
  const obj = {
    id: 10039,
    defId: KILN_OBJECT_DEF_ID,
    mapLevel: 'kcmap',
    x: 10.5,
    z: 10.5,
    depleted: false,
    doorOpen: false,
    def: {
      id: KILN_OBJECT_DEF_ID,
      name: 'Kiln',
      category: 'scenery',
      width: 1,
      height: 1,
      recipes: [
        { inputItemId: 244, outputItemId: 245 },
        { inputItemId: 252, outputItemId: 249 },
        { inputItemId: 253, outputItemId: 250 },
      ],
    },
  } as any;

  const crafted: number[] = [];
  const started: Array<{ recipeIndex: number; quantity: number }> = [];
  const world = Object.create(World.prototype) as any;
  world.worldObjects = new Map([[obj.id, obj]]);
  world.validateInvUse = () => player;
  world.canPlayerTargetObject = () => true;
  world.clearPendingObjectIntents = () => {};
  world.isAdjacentToObject = () => true;
  world.interruptPlayerAction = () => {};
  world.handleCraftingInteraction = (_playerId: number, _player: Player, _obj: unknown, recipeIndex: number) => {
    crafted.push(recipeIndex);
  };
  world.startObjectRecipeProduction = (_playerId: number, _player: Player, _obj: unknown, recipeIndex: number, requestedQuantity: number) => {
    started.push({ recipeIndex, quantity: requestedQuantity });
  };
  world.sendChatSystem = () => {};

  world.handlePlayerUseItemOnObject(player.id, 0, itemId, obj.id);
  return { crafted, started };
}

describe('kiln crafting', () => {
  test('using one unfired clay item on a kiln fires the matching recipe', () => {
    expect(makeHarness(244).crafted).toEqual([0]);
    expect(makeHarness(252).crafted).toEqual([1]);
    expect(makeHarness(253).crafted).toEqual([2]);
  });

  test('using stacked unfired clay items on a kiln starts repeat production', () => {
    expect(makeHarness(244, 2).started).toEqual([{ recipeIndex: 0, quantity: -1 }]);
  });
});
