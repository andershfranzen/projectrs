import { describe, expect, test } from 'bun:test';
import { ServerOpcode, SPINNING_WHEEL_OBJECT_DEF_ID } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function makeOpenMap(): any {
  return {
    width: 64,
    height: 64,
    isBlocked: () => false,
    isTileBlockedOnFloor: () => false,
    isWallBlocked: () => false,
    isWallBlockedOnFloor: () => false,
  };
}

function makeSmithingHarness(playerX: number = 9.5, playerZ: number = 10.5) {
  const player = new Player('smith_test', playerX, playerZ, fakeWs, 1);
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
  const messages: string[] = [];
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[player.id, player]]);
  world.worldObjects = new Map([[obj.id, obj]]);
  world.itemProductionActions = new Map();
  world.blockedObjectTiles = new Set();
  world.maps = new Map([['kcmap', makeOpenMap()]]);
  world.getPlayerMap = (p: Player) => world.maps.get(p.currentMapLevel);
  world.clearCombatTarget = () => {};
  world.closeNpcUiContext = () => {};
  world.runObjectInteractionEffects = () => {};
  world.quests = { notifyQuestEvent() {} };
  world.sendChatSystem = (_player: Player, message: string) => {
    messages.push(message);
  };
  world.sendToPlayer = (_p: Player, opcode: ServerOpcode, ...values: number[]) => {
    if (opcode === ServerOpcode.SMITHING_OPEN) opened.push(values[0]);
  };
  world.handleCraftingInteraction = (_playerId: number, _player: Player, _obj: unknown, idx: number) => {
    crafted.push(idx);
  };
  return { world, player, obj, opened, crafted, messages };
}

function makeHarness(recipeIndex: number = -1): { opened: number[]; crafted: number[] } {
  const { world, player, obj, opened, crafted } = makeSmithingHarness();
  world.handlePlayerInteractObject(player.id, obj.id, 0, recipeIndex);
  return { opened, crafted };
}

function makePendingArrivalHarness(
  category: 'furnace' | 'rock',
  pendingKind: 'interaction' | 'useItemOnObject' = 'interaction',
): { world: any; player: Player; replays: number[] } {
  const player = new Player('arrival_test', 9.5, 10.5, fakeWs, 1);
  player.currentMapLevel = 'kcmap';
  player.currentFloor = 0;
  player.setMoveQueue([{ x: 10.5, z: 10.5 }]);
  if (pendingKind === 'useItemOnObject') {
    player.inventory[0] = { itemId: 25, quantity: 1 };
  }

  const obj = {
    id: 10050,
    defId: category === 'furnace' ? 999 : 3,
    mapLevel: 'kcmap',
    floor: 0,
    x: 11.5,
    z: 10.5,
    depleted: false,
    doorOpen: false,
    displayName: category === 'furnace' ? 'Furnace' : 'Copper Rock',
    examineText: '',
    currentActions: [category === 'furnace' ? 'Smelt' : 'Mine', 'Examine'],
    interactions: [],
    def: {
      id: category === 'furnace' ? 999 : 3,
      name: category === 'furnace' ? 'Furnace' : 'Copper Rock',
      category,
      actions: [category === 'furnace' ? 'Smelt' : 'Mine', 'Examine'],
      width: 1,
      height: 1,
      ...(category === 'furnace'
        ? {
            recipes: [
              {
                inputItemId: 25,
                inputQuantity: 1,
                outputItemId: 29,
                outputQuantity: 1,
                skill: 'smithing',
                levelRequired: 1,
                xpReward: 6,
              },
              {
                inputItemId: 26,
                inputQuantity: 1,
                outputItemId: 30,
                outputQuantity: 1,
                skill: 'smithing',
                levelRequired: 1,
                xpReward: 6,
              },
            ],
          }
        : { skill: 'mining' }),
    },
  } as any;
  if (pendingKind === 'interaction') {
    player.pendingInteraction = { objectEntityId: obj.id, actionIndex: 0, recipeIndex: -1, recipeQuantity: 1 };
  } else {
    player.pendingUseItemOnObject = { invSlot: 0, itemId: 25, objectEntityId: obj.id };
  }

  const replays: number[] = [];
  const map = {
    isWallBlocked: () => false,
    isWallBlockedOnFloor: () => false,
  };
  const world = Object.create(World.prototype) as any;
  world.currentTick = 25;
  world.players = new Map([[player.id, player]]);
  world.worldObjects = new Map([[obj.id, obj]]);
  world.npcs = new Map();
  world.activeDuels = new Map();
  world.accruePlayerMovementCredit = () => { player.movementCredit = 1; };
  world.getPlayerMap = () => map;
  world.isPlayerMovementTileBlocked = () => false;
  world.sultansMineExportDoorCrossedByStep = () => null;
  world.playerHasRoyalMineOre = () => false;
  world.markSultansMineDoorTransitMoved = () => {};
  world.resolvePlayerMovementLayerAt = () => ({ floor: 0, y: 0, lastFloorChangeTile: null });
  world.applyPlayerMovementLayer = () => {};
  world.repairOrCompleteSultansMineDoorTransit = () => {};
  world.updatePlayerRunEnergy = () => {};
  world.updateEntityChunk = () => {};
  world.markEntityTileOccupantsDirty = () => {};
  world.checkpointPlayerPosition = () => {};
  world.isQueuedActionCurrent = () => true;
  world.clearQueuedPlayerActions = (p: Player) => {
    p.pendingInteraction = null;
    p.pendingActionRevision = -1;
  };
  world.canPlayerTargetObject = () => true;
  world.isAdjacentToObject = () => true;
  world.clearCombatTarget = () => {};
  world.rejectStaleDoorInteraction = () => false;
  world.currentObjectActionsForPlayer = () => obj.currentActions;
  world.handlePlayerInteractObject = (_playerId: number, objectEntityId: number) => {
    replays.push(objectEntityId);
  };
  world.handlePlayerUseItemOnObject = (_playerId: number, _invSlot: number, _itemId: number, objectEntityId: number) => {
    replays.push(objectEntityId);
  };
  return { world, player, replays };
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

  test('specific recipe packets queue movement when they arrive before adjacency settles', () => {
    const { world, player, obj, opened, crafted, messages } = makeSmithingHarness(8.5, 10.5);

    world.handlePlayerInteractObject(player.id, obj.id, 0, 1);

    expect(player.hasMoveQueue()).toBe(true);
    expect(player.pendingInteraction).toMatchObject({
      objectEntityId: obj.id,
      actionIndex: 0,
      recipeIndex: 1,
      recipeQuantity: 1,
    });
    expect(opened).toEqual([]);
    expect(crafted).toEqual([]);
    expect(messages).toEqual([]);
  });

  test('deferred furnace interaction replays on the arrival tick', () => {
    const { world, player, replays } = makePendingArrivalHarness('furnace');

    world.tickPlayerMovement();

    expect(player.lastMovedTick).toBe(world.currentTick);
    expect(player.hasMoveQueue()).toBe(false);
    expect(replays).toEqual([10050]);
  });

  test('deferred resource interaction still waits one tick after arrival', () => {
    const { world, player, replays } = makePendingArrivalHarness('rock');

    world.tickPlayerMovement();

    expect(player.lastMovedTick).toBe(world.currentTick);
    expect(player.hasMoveQueue()).toBe(false);
    expect(replays).toEqual([]);
    expect(player.pendingInteraction).toMatchObject({ objectEntityId: 10050 });
  });

  test('deferred use-item-on-furnace interaction replays on the arrival tick', () => {
    const { world, player, replays } = makePendingArrivalHarness('furnace', 'useItemOnObject');

    world.tickPlayerMovement();

    expect(player.lastMovedTick).toBe(world.currentTick);
    expect(player.hasMoveQueue()).toBe(false);
    expect(replays).toEqual([10050]);
  });

  test('deferred inert use-item-on-object interaction still waits one tick after arrival', () => {
    const { world, player, replays } = makePendingArrivalHarness('rock', 'useItemOnObject');

    world.tickPlayerMovement();

    expect(player.lastMovedTick).toBe(world.currentTick);
    expect(player.hasMoveQueue()).toBe(false);
    expect(replays).toEqual([]);
    expect(player.pendingUseItemOnObject).toMatchObject({ objectEntityId: 10050 });
  });

  test('recipe station clicks while busy queue without canceling active production', () => {
    const { world, player, obj, opened, crafted } = makeSmithingHarness();
    world.currentTick = 10;
    player.setDelay(10, 2);
    world.itemProductionActions.set(player.id, {
      kind: 'objectRecipe',
      objectEntityId: obj.id,
      recipeIndex: 0,
      remaining: null,
      nextTick: 11,
      intervalTicks: 1,
    });
    let cancelCount = 0;
    world.cancelItemProduction = (playerId: number) => {
      cancelCount++;
      world.itemProductionActions.delete(playerId);
    };

    world.handlePlayerInteractObject(player.id, obj.id, 0, 1);

    expect(cancelCount).toBe(0);
    expect(world.itemProductionActions.has(player.id)).toBe(true);
    expect(player.pendingInteraction).toMatchObject({
      objectEntityId: obj.id,
      actionIndex: 0,
      recipeIndex: 1,
      recipeQuantity: 1,
    });
    expect(opened).toEqual([]);
    expect(crafted).toEqual([]);
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
    world.blockedObjectTiles = new Set();
    world.maps = new Map([['kcmap', makeOpenMap()]]);
    world.getPlayerMap = (p: Player) => world.maps.get(p.currentMapLevel);
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
