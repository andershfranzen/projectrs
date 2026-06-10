import { expect, test } from 'bun:test';
import {
  ASHES_ITEM_ID,
  FIREMAKING_ATTEMPT_TICKS,
  FIREMAKING_LOG_COST,
  FIRE_OBJECT_DEF_ID,
  LOGS_ITEM_ID,
  MATCHBOX_ITEM_ID,
  YEW_LOGS_ITEM_ID,
  type ItemDef,
  type WorldObjectDef,
} from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { WorldObject } from '../src/entity/WorldObject';

const sentPackets: Uint8Array[] = [];
const fakeWs = {
  sendBinary(packet: Uint8Array) { sentPackets.push(packet); },
  send() {},
} as any;

function itemDef(id: number, name: string): ItemDef {
  return {
    id,
    name,
    description: name,
    stackable: false,
    equippable: false,
    value: 1,
  };
}

const fireDef: WorldObjectDef = {
  id: FIRE_OBJECT_DEF_ID,
  name: 'Fire',
  category: 'scenery',
  actions: ['Examine'],
  blocking: true,
  width: 1,
  depth: 1,
  height: 1,
  color: [255, 132, 32],
  modelAssetId: 'fire',
};

function makeHarness(): { world: any; player: Player; messages: string[] } {
  sentPackets.length = 0;
  const player = new Player('firemaking_test', 10.5, 10.5, fakeWs, 1);
  player.inventory[0] = { itemId: MATCHBOX_ITEM_ID, quantity: 1 };
  player.inventory[1] = { itemId: LOGS_ITEM_ID, quantity: 3 };

  const messages: string[] = [];
  const itemDefs = new Map([
    [MATCHBOX_ITEM_ID, itemDef(MATCHBOX_ITEM_ID, 'Matchbox')],
    [LOGS_ITEM_ID, itemDef(LOGS_ITEM_ID, 'Log')],
    [YEW_LOGS_ITEM_ID, itemDef(YEW_LOGS_ITEM_ID, 'Yew logs')],
    [ASHES_ITEM_ID, itemDef(ASHES_ITEM_ID, 'Ashes')],
  ]);
  const map = {
    width: 64,
    height: 64,
    isBlocked: () => false,
    isTileBlockedOnFloor: () => false,
    isWallBlocked: () => false,
    isWallBlockedOnFloor: () => false,
    getEffectiveHeightOnFloor: () => 0,
  };
  const chunkManager = {
    addEntity() {},
    removeEntity() {},
    forEachPlayerNear(_x: number, _z: number, fn: (playerId: number) => void) {
      fn(player.id);
    },
  };
  const world = Object.create(World.prototype) as any;
  world.currentTick = 0;
  world.players = new Map([[player.id, player]]);
  world.npcs = new Map();
  world.maps = new Map([['kcmap', map]]);
  world.chunkManagers = new Map([['kcmap', chunkManager]]);
  world.worldObjects = new Map();
  world.groundItems = new Map();
  world.despawningItemIds = new Set();
  world.blockedObjectTiles = new Set();
  world.closedCenteredDoorTileCounts = new Map();
  world.runtimeFireObjectIds = new Set();
  world.itemProductionActions = new Map();
  world.skillingActions = new Map();
  world.data = {
    itemDefs,
    getItem(itemId: number) {
      return itemDefs.get(itemId) ?? null;
    },
    getObject(objectId: number) {
      return objectId === FIRE_OBJECT_DEF_ID ? fireDef : undefined;
    },
  };
  world.db = { recordGameEvent() {} };
  world.interruptPlayerAction = () => {};
  world.sendInventory = () => {};
  world.sendChatSystem = (_player: Player, message: string) => messages.push(message);
  return { world, player, messages };
}

function sceneryDef(id: number, category: WorldObjectDef['category'] = 'scenery'): WorldObjectDef {
  return {
    id,
    name: category === 'bank' ? 'Bank booth' : 'Crate',
    category,
    actions: ['Examine'],
    blocking: false,
    width: 1,
    depth: 1,
    height: 1,
    color: [120, 120, 120],
  };
}

function withMockedRandom<T>(value: number, fn: () => T): T {
  const original = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

test('matchbox and three logs create a temporary fire with Survival XP', () => {
  const { world, player, messages } = makeHarness();

  world.handlePlayerUseItemOnItem(player.id, 0, MATCHBOX_ITEM_ID, 1, LOGS_ITEM_ID);
  expect(world.itemProductionActions.get(player.id)).toMatchObject({
    kind: 'firemaking',
    tileX: 10,
    tileZ: 10,
    nextTick: FIREMAKING_ATTEMPT_TICKS,
  });
  expect(messages).toContain('You attempt to light the logs.');

  withMockedRandom(0, () => {
    world.currentTick = FIREMAKING_ATTEMPT_TICKS;
    world.tickItemProductionActions();
  });

  expect(world.itemProductionActions.has(player.id)).toBe(false);
  expect(player.inventory[1]).toBeNull();
  expect(player.skills.survival.xp).toBe(40);
  const fire = [...world.worldObjects.values()].find((obj: any) => obj.defId === FIRE_OBJECT_DEF_ID);
  expect(fire).toBeTruthy();
  expect(messages).toContain('The fire catches and the logs begin to burn.');
  expect(player.hasMoveQueue()).toBe(true);
});

test('firemaking remains queued on a failed roll without consuming logs', () => {
  const { world, player } = makeHarness();

  world.handlePlayerUseItemOnItem(player.id, 0, MATCHBOX_ITEM_ID, 1, LOGS_ITEM_ID);
  withMockedRandom(0.999, () => {
    world.currentTick = FIREMAKING_ATTEMPT_TICKS;
    world.tickItemProductionActions();
  });

  expect(world.itemProductionActions.has(player.id)).toBe(true);
  expect(world.itemProductionActions.get(player.id)?.nextTick).toBe(FIREMAKING_ATTEMPT_TICKS * 2);
  expect(player.inventory[1]).toEqual({ itemId: LOGS_ITEM_ID, quantity: FIREMAKING_LOG_COST });
  expect(player.skills.survival.xp).toBe(0);
  expect(world.worldObjects.size).toBe(0);
});

test('firemaking rejects missing logs before starting', () => {
  const { world, player, messages } = makeHarness();
  player.inventory[1] = { itemId: LOGS_ITEM_ID, quantity: FIREMAKING_LOG_COST - 1 };

  world.handlePlayerUseItemOnItem(player.id, 0, MATCHBOX_ITEM_ID, 1, LOGS_ITEM_ID);

  expect(world.itemProductionActions.has(player.id)).toBe(false);
  expect(messages).toContain(`You need ${FIREMAKING_LOG_COST} logs to light a fire.`);
});

test('firemaking uses Survival level requirements for higher tier logs', () => {
  const { world, player, messages } = makeHarness();
  player.inventory[1] = { itemId: YEW_LOGS_ITEM_ID, quantity: FIREMAKING_LOG_COST };

  world.handlePlayerUseItemOnItem(player.id, 0, MATCHBOX_ITEM_ID, 1, YEW_LOGS_ITEM_ID);
  expect(world.itemProductionActions.has(player.id)).toBe(false);
  expect(messages).toContain('You need level 60 Survival to light yew logs.');

  player.skills.survival.level = 60;
  player.skills.survival.currentLevel = 60;
  world.handlePlayerUseItemOnItem(player.id, 0, MATCHBOX_ITEM_ID, 1, YEW_LOGS_ITEM_ID);

  expect(world.itemProductionActions.get(player.id)).toMatchObject({
    kind: 'firemaking',
    recipe: expect.objectContaining({ logItemId: YEW_LOGS_ITEM_ID, levelRequired: 60 }),
  });
});

test('firemaking rejects occupied tiles and bank zones', () => {
  const occupied = makeHarness();
  occupied.world.worldObjects.set(1234, new WorldObject(sceneryDef(1234), 10.5, 10.5, 'kcmap', 0, 0));
  occupied.world.handlePlayerUseItemOnItem(occupied.player.id, 0, MATCHBOX_ITEM_ID, 1, LOGS_ITEM_ID);
  expect(occupied.world.itemProductionActions.has(occupied.player.id)).toBe(false);
  expect(occupied.messages).toContain("You can't light a fire here.");

  const nearBank = makeHarness();
  nearBank.world.worldObjects.set(1235, new WorldObject(sceneryDef(1235, 'bank'), 14.5, 10.5, 'kcmap', 0, 0));
  nearBank.world.handlePlayerUseItemOnItem(nearBank.player.id, 0, MATCHBOX_ITEM_ID, 1, LOGS_ITEM_ID);
  expect(nearBank.world.itemProductionActions.has(nearBank.player.id)).toBe(false);
  expect(nearBank.messages).toContain("You can't light a fire here.");
});

test('temporary fires burn down into ashes', () => {
  const { world, player } = makeHarness();

  world.handlePlayerUseItemOnItem(player.id, 0, MATCHBOX_ITEM_ID, 1, LOGS_ITEM_ID);
  withMockedRandom(0, () => {
    world.currentTick = FIREMAKING_ATTEMPT_TICKS;
    world.tickItemProductionActions();
  });

  for (let i = 0; i < 100; i++) world.tickRuntimeFires();

  expect(world.worldObjects.size).toBe(0);
  const ashes = [...world.groundItems.values()].find((item: any) => item.itemId === ASHES_ITEM_ID);
  expect(ashes).toMatchObject({ quantity: 1, x: 10.5, z: 10.5, floor: 0, mapLevel: 'kcmap' });
});
