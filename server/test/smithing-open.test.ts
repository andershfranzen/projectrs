import { describe, expect, test } from 'bun:test';
import { ServerOpcode, SPINNING_WHEEL_OBJECT_DEF_ID } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function makeHarness(recipeIndex: number = -1): { opened: number[]; crafted: number[] } {
  const player = new Player('smith_test', 9.5, 10.5, fakeWs, 1);
  const obj = {
    id: 10001,
    defId: 999,
    mapLevel: 'kcmap',
    x: 10.5,
    z: 10.5,
    depleted: false,
    doorOpen: false,
    displayName: 'Furnace',
    examineText: 'A furnace.',
    currentActions: ['Use', 'Examine'],
    interactions: [],
    def: {
      id: 999,
      name: 'Furnace',
      category: 'furnace',
      width: 1,
      height: 1,
      recipes: [{ inputs: [] }, { inputs: [] }],
    },
  } as any;
  const opened: number[] = [];
  const crafted: number[] = [];
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[player.id, player]]);
  world.worldObjects = new Map([[obj.id, obj]]);
  world.clearCombatTarget = () => {};
  world.closeNpcUiContext = () => {};
  world.runObjectInteractionEffects = () => {};
  world.quests = { notifyQuestEvent() {} };
  world.sendToPlayer = (_p: Player, opcode: ServerOpcode, ...values: number[]) => {
    if (opcode === ServerOpcode.SMITHING_OPEN) opened.push(values[0]);
  };
  world.handleCraftingInteraction = (_playerId: number, _player: Player, _obj: unknown, idx: number) => {
    crafted.push(idx);
  };
  world.handlePlayerInteractObject(player.id, obj.id, 0, recipeIndex);
  return { opened, crafted };
}

describe('server-authoritative smithing picker', () => {
  test('opens multi-recipe station picker only after server adjacency validation', () => {
    const { opened, crafted } = makeHarness();
    expect(opened).toEqual([10001]);
    expect(crafted).toEqual([]);
  });

  test('specific recipe packets craft directly instead of reopening picker', () => {
    const { opened, crafted } = makeHarness(1);
    expect(opened).toEqual([]);
    expect(crafted).toEqual([1]);
  });

  test('opens spinning wheel picker even though it has one recipe', () => {
    const player = new Player('wheel_test', 9.5, 10.5, fakeWs, 1);
    const obj = {
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
        height: 1,
        recipes: [{ inputItemId: 269, inputQuantity: 1, outputItemId: 273, outputQuantity: 1, skill: 'crafting', levelRequired: 1, xpReward: 5 }],
      },
    } as any;
    const opened: number[] = [];
    const crafted: number[] = [];
    const world = Object.create(World.prototype) as any;
    world.players = new Map([[player.id, player]]);
    world.worldObjects = new Map([[obj.id, obj]]);
    world.clearCombatTarget = () => {};
    world.closeNpcUiContext = () => {};
    world.runObjectInteractionEffects = () => {};
    world.quests = { notifyQuestEvent() {} };
    world.sendToPlayer = (_p: Player, opcode: ServerOpcode, ...values: number[]) => {
      if (opcode === ServerOpcode.SMITHING_OPEN) opened.push(values[0]);
    };
    world.handleCraftingInteraction = (_playerId: number, _player: Player, _obj: unknown, idx: number) => {
      crafted.push(idx);
    };

    world.handlePlayerInteractObject(player.id, obj.id, 0);

    expect(opened).toEqual([obj.id]);
    expect(crafted).toEqual([]);
  });
});
