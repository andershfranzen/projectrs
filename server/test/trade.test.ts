import { describe, expect, test } from 'bun:test';
import { INVENTORY_SIZE, MAX_STACK, ServerOpcode, type ItemDef } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

const COINS = 10;
const SWORD = 100;
const FILLER = 101;

const fakeWs = {
  sendBinary() {},
  send() {},
  close() {},
} as any;

function itemDef(id: number, name: string, stackable: boolean): ItemDef {
  return {
    id,
    name,
    description: name,
    stackable,
    equippable: false,
    value: 1,
  };
}

const itemDefs = new Map<number, ItemDef>([
  [COINS, itemDef(COINS, 'Coins', true)],
  [SWORD, itemDef(SWORD, 'Sword', false)],
  [FILLER, itemDef(FILLER, 'Filler', false)],
]);

interface TradeHarness {
  world: any;
  packets: Map<number, Array<{ opcode: ServerOpcode; values: number[] }>>;
  chats: Map<number, string[]>;
  spills: Array<{ playerId: number; itemId: number; quantity: number }>;
}

function makePlayer(name: string, accountId: number, x = 1.5, z = 1.5): Player {
  const player = new Player(name, x, z, fakeWs, accountId);
  player.currentMapLevel = 'kcmap';
  player.currentFloor = 0;
  return player;
}

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

function makeHarness(a: Player, b: Player): TradeHarness {
  const packets = new Map<number, Array<{ opcode: ServerOpcode; values: number[] }>>([
    [a.id, []],
    [b.id, []],
  ]);
  const chats = new Map<number, string[]>([
    [a.id, []],
    [b.id, []],
  ]);
  const spills: Array<{ playerId: number; itemId: number; quantity: number }> = [];
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[a.id, a], [b.id, b]]);
  world.npcs = new Map();
  world.playerCombatTargets = new Map();
  world.npcTargetedBy = new Map();
  world.tradeSessions = new Map();
  world.pendingTradeRequests = new Map();
  world.blockedObjectTiles = new Set();
  world.maps = new Map([['kcmap', makeOpenMap()]]);
  world.getPlayerMap = (player: Player) => world.maps.get(player.currentMapLevel);
  world.currentTick = 42;
  world.db = {
    savePlayerState() {},
  };
  world.data = {
    itemDefs,
    getItem: (id: number) => itemDefs.get(id),
  };
  world.sendToPlayer = (player: Player, opcode: ServerOpcode, ...values: number[]) => {
    packets.get(player.id)?.push({ opcode, values });
  };
  world.sendInventory = () => {};
  world.sendChatSystem = (player: Player, message: string) => {
    chats.get(player.id)?.push(message);
  };
  world.sendDialogueClose = () => {};
  world.closeDialogueForPlayer = () => {};
  world.clearPendingObjectIntents = () => {};
  world.cancelSkilling = () => {};
  world.setPlayerAnimation = () => {};
  world.computeEffectiveY = (player: Player) => player.effectiveY;
  world.spawnGroundItem = (player: Player, itemId: number, quantity: number) => {
    spills.push({ playerId: player.id, itemId, quantity });
  };
  return { world, packets, chats, spills };
}

function openTrade(world: any, a: Player, b: Player): any {
  world.openTradeSession(a, b);
  const session = world.tradeSessions.get(a.id);
  expect(session).toBeTruthy();
  expect(world.tradeSessions.get(b.id)).toBe(session);
  expect(a.openInterface).toBe('trade');
  expect(b.openInterface).toBe('trade');
  return session;
}

function countItem(player: Player, itemId: number): number {
  return player.inventory.reduce((total, slot) => total + (slot?.itemId === itemId ? slot.quantity : 0), 0);
}

function fillInventory(player: Player, itemId: number): void {
  for (let i = 0; i < INVENTORY_SIZE; i++) {
    player.inventory[i] = { itemId, quantity: 1 };
  }
}

function acceptBothTwice(world: any, a: Player, b: Player): void {
  world.handleTradeAccept(a.id);
  world.handleTradeAccept(b.id);
  world.handleTradeAccept(a.id);
  world.handleTradeAccept(b.id);
}

describe('player trading anti-dupe validation', () => {
  test('trade requests cannot cross wall or fence edges', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    const { world, chats } = makeHarness(a, b);
    const map = world.maps.get('kcmap');
    map.isWallBlocked = (fx: number, fz: number, tx: number, tz: number) =>
      fx === 1 && fz === 1 && tx === 2 && tz === 1;
    map.isWallBlockedOnFloor = map.isWallBlocked;

    world.handleTradeRequest(a.id, b.id);

    expect(world.pendingTradeRequests.size).toBe(0);
    expect(world.tradeSessions.has(a.id)).toBe(false);
    expect(chats.get(a.id)).toContain('That player is too far away to trade.');
  });

  test('accepting a pending request opens trade only while nearby on the same floor', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 20.5, 1.5);
    const { world } = makeHarness(a, b);

    world.pendingTradeRequests.set(a.id, b.id);
    world.handleTradeAcceptRequest(b.id, a.id);
    expect(world.tradeSessions.has(a.id)).toBe(false);
    expect(a.openInterface).toBeNull();
    expect(b.openInterface).toBeNull();

    b.position.x = 2.5;
    world.pendingTradeRequests.set(a.id, b.id);
    world.handleTradeAcceptRequest(b.id, a.id);
    expect(world.tradeSessions.has(a.id)).toBe(true);
    expect(world.pendingTradeRequests.size).toBe(0);
  });

  test('stale slots and malformed quantities cannot mutate inventory or offers', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2);
    a.inventory[0] = { itemId: SWORD, quantity: 1 };
    a.inventory[1] = { itemId: COINS, quantity: 100 };
    const { world } = makeHarness(a, b);
    const session = openTrade(world, a, b);

    world.handleTradeOfferItem(a.id, 0, COINS, 1);
    world.handleTradeOfferItem(a.id, 1, COINS, Number.NaN);
    world.handleTradeOfferItem(a.id, 1, COINS, 0);
    world.handleTradeOfferItem(a.id, 1, COINS, -2);
    world.handleTradeOfferItem(a.id, 1, COINS, Number.POSITIVE_INFINITY);

    expect(countItem(a, SWORD)).toBe(1);
    expect(countItem(a, COINS)).toBe(100);
    expect(session.a.offer.every((slot: unknown) => slot === null)).toBe(true);

    world.handleTradeOfferItem(a.id, 1, COINS, 40);
    expect(countItem(a, COINS)).toBe(60);
    expect(session.a.offer[0]).toEqual({ itemId: COINS, quantity: 40 });
  });

  test('the non-accepted side can mutate and reset both accept stages', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2);
    a.inventory[0] = { itemId: COINS, quantity: 100 };
    const { world } = makeHarness(a, b);
    const session = openTrade(world, a, b);

    world.handleTradeOfferItem(a.id, 0, COINS, 25);
    world.handleTradeAccept(b.id);
    expect(session.a.stage).toBe(0);
    expect(session.b.stage).toBe(1);

    world.handleTradeOfferItem(a.id, 0, COINS, 25);
    expect(session.a.stage).toBe(0);
    expect(session.b.stage).toBe(0);
    expect(session.a.offer[0]).toEqual({ itemId: COINS, quantity: 50 });
    expect(countItem(a, COINS)).toBe(50);
  });

  test('the accepted side can remove offered items and reset both accept stages', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2);
    a.inventory[0] = { itemId: COINS, quantity: 100 };
    const { world } = makeHarness(a, b);
    const session = openTrade(world, a, b);

    world.handleTradeOfferItem(a.id, 0, COINS, 40);
    world.handleTradeAccept(a.id);
    expect(session.a.stage).toBe(1);

    world.handleTradeRemoveOffered(a.id, 0, COINS, 10);
    expect(session.a.stage).toBe(0);
    expect(session.b.stage).toBe(0);
    expect(session.a.offer[0]).toEqual({ itemId: COINS, quantity: 30 });
    expect(countItem(a, COINS)).toBe(70);

    world.handleTradeAccept(a.id);
    world.handleTradeAccept(b.id);
    expect(session.a.stage).toBe(1);
    expect(session.b.stage).toBe(1);

    world.handleTradeRemoveOffered(a.id, 0, COINS, -1);
    expect(session.a.stage).toBe(0);
    expect(session.b.stage).toBe(0);
    expect(session.a.offer[0]).toBeNull();
    expect(countItem(a, COINS)).toBe(100);
  });

  test('one player cannot advance to final confirm before both players first-accept', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2);
    a.inventory[0] = { itemId: COINS, quantity: 100 };
    b.inventory[0] = { itemId: SWORD, quantity: 1 };
    const { world } = makeHarness(a, b);
    const session = openTrade(world, a, b);

    world.handleTradeOfferItem(a.id, 0, COINS, 40);
    world.handleTradeOfferItem(b.id, 0, SWORD, 1);
    world.handleTradeAccept(a.id);
    world.handleTradeAccept(a.id);
    expect(session.a.stage).toBe(1);
    expect(session.b.stage).toBe(0);
    expect(world.tradeSessions.has(a.id)).toBe(true);

    world.handleTradeAccept(b.id);
    world.handleTradeAccept(a.id);
    world.handleTradeAccept(b.id);
    expect(world.tradeSessions.has(a.id)).toBe(false);
    expect(countItem(a, COINS)).toBe(60);
    expect(countItem(a, SWORD)).toBe(1);
    expect(countItem(b, COINS)).toBe(40);
    expect(countItem(b, SWORD)).toBe(0);
  });

  test('successful commit transfers each offer exactly once', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2);
    a.inventory[0] = { itemId: COINS, quantity: 100 };
    b.inventory[0] = { itemId: SWORD, quantity: 1 };
    const { world } = makeHarness(a, b);
    openTrade(world, a, b);

    world.handleTradeOfferItem(a.id, 0, COINS, 40);
    world.handleTradeOfferItem(b.id, 0, SWORD, 1);
    acceptBothTwice(world, a, b);

    expect(a.openInterface).toBeNull();
    expect(b.openInterface).toBeNull();
    expect(countItem(a, COINS)).toBe(60);
    expect(countItem(a, SWORD)).toBe(1);
    expect(countItem(b, COINS)).toBe(40);
    expect(countItem(b, SWORD)).toBe(0);

    world.handleTradeAccept(a.id);
    world.handleTradeAccept(b.id);
    expect(countItem(a, COINS)).toBe(60);
    expect(countItem(a, SWORD)).toBe(1);
    expect(countItem(b, COINS)).toBe(40);
    expect(countItem(b, SWORD)).toBe(0);
  });

  test('full receiver inventory aborts commit and refunds custodied items', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2);
    a.inventory[0] = { itemId: SWORD, quantity: 1 };
    fillInventory(b, FILLER);
    const { world, spills } = makeHarness(a, b);
    openTrade(world, a, b);

    world.handleTradeOfferItem(a.id, 0, SWORD, 1);
    acceptBothTwice(world, a, b);

    expect(world.tradeSessions.has(a.id)).toBe(false);
    expect(a.openInterface).toBeNull();
    expect(b.openInterface).toBeNull();
    expect(countItem(a, SWORD)).toBe(1);
    expect(countItem(b, SWORD)).toBe(0);
    expect(spills).toEqual([]);
  });

  test('stack overflow on receiver aborts commit and refunds without clamping', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2);
    a.inventory[0] = { itemId: COINS, quantity: 100 };
    b.inventory[0] = { itemId: COINS, quantity: MAX_STACK - 50 };
    const { world } = makeHarness(a, b);
    openTrade(world, a, b);

    world.handleTradeOfferItem(a.id, 0, COINS, 100);
    acceptBothTwice(world, a, b);

    expect(world.tradeSessions.has(a.id)).toBe(false);
    expect(countItem(a, COINS)).toBe(100);
    expect(countItem(b, COINS)).toBe(MAX_STACK - 50);
  });

  test('disconnect abort refunds both sides before any save can persist missing items', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2);
    a.inventory[0] = { itemId: COINS, quantity: 100 };
    b.inventory[0] = { itemId: SWORD, quantity: 1 };
    const { world } = makeHarness(a, b);
    openTrade(world, a, b);

    world.handleTradeOfferItem(a.id, 0, COINS, 40);
    world.handleTradeOfferItem(b.id, 0, SWORD, 1);
    world.handlePlayerDisconnect(a.id);

    expect(world.tradeSessions.has(a.id)).toBe(false);
    expect(world.tradeSessions.has(b.id)).toBe(false);
    expect(a.openInterface).toBeNull();
    expect(b.openInterface).toBeNull();
    expect(countItem(a, COINS)).toBe(100);
    expect(countItem(b, SWORD)).toBe(1);
  });
});
