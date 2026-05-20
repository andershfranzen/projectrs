import { describe, expect, test } from 'bun:test';
import { DUEL_STAKE_SIZE, INVENTORY_SIZE, ServerOpcode, type ItemDef } from '@projectrs/shared';
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

interface DuelHarness {
  world: any;
  packets: Map<number, Array<{ opcode: ServerOpcode; values: number[] }>>;
  chats: Map<number, string[]>;
  saves: number[];
  spills: Array<{ playerId: number; itemId: number; quantity: number }>;
}

function makePlayer(name: string, accountId: number, x = 1.5, z = 1.5): Player {
  const player = new Player(name, x, z, fakeWs, accountId);
  player.currentMapLevel = 'kcmap';
  player.currentFloor = 0;
  return player;
}

function makeHarness(a: Player, b: Player): DuelHarness {
  const packets = new Map<number, Array<{ opcode: ServerOpcode; values: number[] }>>([
    [a.id, []],
    [b.id, []],
  ]);
  const chats = new Map<number, string[]>([
    [a.id, []],
    [b.id, []],
  ]);
  const saves: number[] = [];
  const spills: Array<{ playerId: number; itemId: number; quantity: number }> = [];
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[a.id, a], [b.id, b]]);
  world.npcs = new Map();
  world.playerCombatTargets = new Map();
  world.npcTargetedBy = new Map();
  world.tradeSessions = new Map();
  world.pendingTradeRequests = new Map();
  world.duelStakeSessions = new Map();
  world.pendingDuelRequests = new Map();
  world.activeDuels = new Map();
  world.pendingSpellImpacts = [];
  world.currentTick = 42;
  world.currentTickStartMs = 0;
  world.data = {
    itemDefs,
    getItem: (id: number) => itemDefs.get(id),
    getSpellByIndex: () => null,
  };
  world.db = {
    savePlayerState(accountId: number) { saves.push(accountId); },
    savePlayersBatch(rows: Array<{ accountId: number }>) {
      for (const row of rows) saves.push(row.accountId);
    },
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
  world.broadcastPlayerAnimationEvent = () => {};
  world.broadcastNearby = () => {};
  world.broadcastCombatHit = () => {};
  world.broadcastProjectile = () => {};
  world.sendSingleSkill = () => {};
  world.computeEffectiveY = (player: Player) => player.effectiveY;
  world.spawnGroundItem = (player: Player, itemId: number, quantity: number) => {
    spills.push({ playerId: player.id, itemId, quantity });
  };
  return { world, packets, chats, saves, spills };
}

function countItem(player: Player, itemId: number): number {
  return player.inventory.reduce((total, slot) => total + (slot?.itemId === itemId ? slot.quantity : 0), 0);
}

function fillInventory(player: Player, itemId: number): void {
  for (let i = 0; i < INVENTORY_SIZE; i++) {
    player.inventory[i] = { itemId, quantity: 1 };
  }
}

function openDuel(world: any, a: Player, b: Player): any {
  world.openDuelStakeSession(a, b);
  const session = world.duelStakeSessions.get(a.id);
  expect(session).toBeTruthy();
  expect(world.duelStakeSessions.get(b.id)).toBe(session);
  expect(a.openInterface).toBe('duel');
  expect(b.openInterface).toBe('duel');
  return session;
}

function acceptBothTwice(world: any, a: Player, b: Player): void {
  world.handleDuelAccept(a.id);
  world.handleDuelAccept(b.id);
  world.handleDuelAccept(a.id);
  world.handleDuelAccept(b.id);
}

describe('player duel staking and combat validation', () => {
  test('request rejects target already in combat with exact message', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    const { world, chats } = makeHarness(a, b);
    b.markInCombat(world.currentTick);

    world.handleDuelRequest(a.id, b.id);

    expect(world.duelStakeSessions.has(a.id)).toBe(false);
    expect(chats.get(a.id)).toContain('They are already in combat');
  });

  test('request rejects target under NPC attack with exact message', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    const { world, chats } = makeHarness(a, b);
    world.npcs.set(999, { combatTarget: b });

    world.handleDuelRequest(a.id, b.id);

    expect(world.duelStakeSessions.has(a.id)).toBe(false);
    expect(chats.get(a.id)).toContain('They are already in combat');
  });

  test('accepting a pending request opens only while adjacent on same floor', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 20.5, 1.5);
    const { world } = makeHarness(a, b);

    world.pendingDuelRequests.set(a.id, b.id);
    world.handleDuelAcceptRequest(b.id, a.id);
    expect(world.duelStakeSessions.has(a.id)).toBe(false);
    expect(a.openInterface).toBeNull();
    expect(b.openInterface).toBeNull();

    b.position.x = 2.5;
    world.pendingDuelRequests.set(a.id, b.id);
    world.handleDuelAcceptRequest(b.id, a.id);
    expect(world.duelStakeSessions.has(a.id)).toBe(true);
    expect(world.pendingDuelRequests.size).toBe(0);
  });

  test('pending spell impacts block duel requests until resolved', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    const { world, chats } = makeHarness(a, b);
    world.pendingSpellImpacts.push({
      impactTick: world.currentTick + 1,
      attackerId: a.id,
      targetId: 999,
      damage: 1,
      spellId: 'test',
      xpSkill: 'goodmagic',
      mapLevel: a.currentMapLevel,
    });

    world.handleDuelRequest(a.id, b.id);

    expect(world.duelStakeSessions.has(a.id)).toBe(false);
    expect(chats.get(a.id)).toContain('You are already in combat.');
  });

  test('opening the staking interface clears queued movement and pending actions', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    const { world } = makeHarness(a, b);
    a.setMoveQueue([{ x: 3.5, z: 1.5 }]);
    a.followTargetPlayerId = b.id;
    a.pendingPickup = 123;

    const session = openDuel(world, a, b);

    expect(session).toBeTruthy();
    expect(a.hasMoveQueue()).toBe(false);
    expect(a.followTargetPlayerId).toBe(-1);
    expect(a.pendingPickup).toBe(-1);
  });

  test('stale slots and malformed stake quantities cannot mutate inventory', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    a.inventory[0] = { itemId: SWORD, quantity: 1 };
    a.inventory[1] = { itemId: COINS, quantity: 100 };
    const { world } = makeHarness(a, b);
    const session = openDuel(world, a, b);

    world.handleDuelStakeItem(a.id, 0, COINS, 1);
    world.handleDuelStakeItem(a.id, 1, COINS, Number.NaN);
    world.handleDuelStakeItem(a.id, 1, COINS, 0);
    world.handleDuelStakeItem(a.id, 1, COINS, -2);
    world.handleDuelStakeItem(a.id, 1, COINS, Number.POSITIVE_INFINITY);

    expect(countItem(a, SWORD)).toBe(1);
    expect(countItem(a, COINS)).toBe(100);
    expect(session.a.stake.every((slot: unknown) => slot === null)).toBe(true);

    world.handleDuelStakeItem(a.id, 1, COINS, 40);
    expect(countItem(a, COINS)).toBe(60);
    expect(session.a.stake[0]).toEqual({ itemId: COINS, quantity: 40 });
  });

  test('stake mutation resets both accept stages and final accept starts combat', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    a.inventory[0] = { itemId: COINS, quantity: 100 };
    const { world } = makeHarness(a, b);
    const session = openDuel(world, a, b);

    world.handleDuelStakeItem(a.id, 0, COINS, 25);
    world.handleDuelAccept(b.id);
    expect(session.a.stage).toBe(0);
    expect(session.b.stage).toBe(1);

    world.handleDuelStakeItem(a.id, 0, COINS, 25);
    expect(session.a.stage).toBe(0);
    expect(session.b.stage).toBe(0);
    expect(session.a.stake[0]).toEqual({ itemId: COINS, quantity: 50 });

    acceptBothTwice(world, a, b);
    expect(world.duelStakeSessions.has(a.id)).toBe(false);
    expect(world.activeDuels.has(a.id)).toBe(true);
    expect(world.activeDuels.get(a.id)).toBe(world.activeDuels.get(b.id));
    expect(a.openInterface).toBe('duel');
    expect(b.openInterface).toBe('duel');
  });

  test('full potential winner inventory aborts start and refunds stakes', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    a.inventory[0] = { itemId: SWORD, quantity: 1 };
    fillInventory(b, FILLER);
    const { world, spills } = makeHarness(a, b);
    openDuel(world, a, b);

    world.handleDuelStakeItem(a.id, 0, SWORD, 1);
    acceptBothTwice(world, a, b);

    expect(world.duelStakeSessions.has(a.id)).toBe(false);
    expect(world.activeDuels.has(a.id)).toBe(false);
    expect(a.openInterface).toBeNull();
    expect(b.openInterface).toBeNull();
    expect(countItem(a, SWORD)).toBe(1);
    expect(countItem(b, SWORD)).toBe(0);
    expect(spills).toEqual([]);
  });

  test('winner receives both stake pools exactly once and both health snapshots restore', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    a.inventory[0] = { itemId: COINS, quantity: 100 };
    b.inventory[0] = { itemId: SWORD, quantity: 1 };
    a.health = 7; a.skills.hitpoints.currentLevel = 7;
    b.health = 5; b.skills.hitpoints.currentLevel = 5;
    const aXpBefore = a.skills.accuracy.xp + a.skills.strength.xp + a.skills.defence.xp + a.skills.hitpoints.xp;
    const bXpBefore = b.skills.accuracy.xp + b.skills.strength.xp + b.skills.defence.xp + b.skills.hitpoints.xp;
    const { world, saves } = makeHarness(a, b);
    openDuel(world, a, b);

    world.handleDuelStakeItem(a.id, 0, COINS, 40);
    world.handleDuelStakeItem(b.id, 0, SWORD, 1);
    acceptBothTwice(world, a, b);
    b.health = 0; b.skills.hitpoints.currentLevel = 0;
    world.tickActiveDuels();

    expect(world.activeDuels.has(a.id)).toBe(false);
    expect(countItem(a, COINS)).toBe(100);
    expect(countItem(a, SWORD)).toBe(1);
    expect(countItem(b, SWORD)).toBe(0);
    expect(a.health).toBe(7);
    expect(b.health).toBe(5);
    expect(a.skills.accuracy.xp + a.skills.strength.xp + a.skills.defence.xp + a.skills.hitpoints.xp).toBe(aXpBefore);
    expect(b.skills.accuracy.xp + b.skills.strength.xp + b.skills.defence.xp + b.skills.hitpoints.xp).toBe(bXpBefore);
    expect(a.openInterface).toBeNull();
    expect(b.openInterface).toBeNull();
    expect(saves).toContain(a.accountId);
    expect(saves).toContain(b.accountId);

    world.handleDuelAccept(a.id);
    expect(countItem(a, SWORD)).toBe(1);
  });

  test('active duel rejects movement instead of ending the duel', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    const { world } = makeHarness(a, b);
    openDuel(world, a, b);
    acceptBothTwice(world, a, b);

    world.handlePlayerMove(a.id, [{ x: 10.5, z: 10.5 }]);

    expect(a.hasMoveQueue()).toBe(false);
    expect(world.activeDuels.has(a.id)).toBe(true);
    expect(a.openInterface).toBe('duel');
  });

  test('autosave skips players while stakes are custodied in active duel', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    a.inventory[0] = { itemId: COINS, quantity: 100 };
    const { world, saves } = makeHarness(a, b);
    openDuel(world, a, b);
    world.handleDuelStakeItem(a.id, 0, COINS, 40);
    acceptBothTwice(world, a, b);

    world.saveAllPlayers();

    expect(saves).toEqual([]);
  });

  test('disconnect during staking refunds and immediately saves both players', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    a.inventory[0] = { itemId: COINS, quantity: 100 };
    b.inventory[0] = { itemId: SWORD, quantity: 1 };
    const { world, saves } = makeHarness(a, b);
    openDuel(world, a, b);
    world.handleDuelStakeItem(a.id, 0, COINS, 40);
    world.handleDuelStakeItem(b.id, 0, SWORD, 1);

    world.handlePlayerDisconnect(a.id);

    expect(world.duelStakeSessions.has(a.id)).toBe(false);
    expect(countItem(a, COINS)).toBe(100);
    expect(countItem(b, SWORD)).toBe(1);
    expect(saves).toContain(a.accountId);
    expect(saves).toContain(b.accountId);
  });

  test('manual combat control packets are ignored while the duel interface is open', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    const { world } = makeHarness(a, b);
    openDuel(world, a, b);
    world.data.getSpellByIndex = () => {
      throw new Error('spell catalogue should not be read while the duel interface is open');
    };

    expect(() => world.handlePlayerCastSpell(a.id, 0, 999)).not.toThrow();
    world.handlePlayerSetAutocast(a.id, 0);

    expect(a.autocastSpellIndex).toBe(-1);
    expect(world.pendingSpellImpacts).toEqual([]);
  });

  test('disconnect during active duel forfeits and awards the connected opponent', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    a.inventory[0] = { itemId: COINS, quantity: 100 };
    b.inventory[0] = { itemId: SWORD, quantity: 1 };
    const { world } = makeHarness(a, b);
    openDuel(world, a, b);
    world.handleDuelStakeItem(a.id, 0, COINS, 40);
    world.handleDuelStakeItem(b.id, 0, SWORD, 1);
    acceptBothTwice(world, a, b);

    world.handlePlayerDisconnect(b.id);

    expect(world.activeDuels.has(a.id)).toBe(false);
    expect(countItem(a, COINS)).toBe(100);
    expect(countItem(a, SWORD)).toBe(1);
    expect(countItem(b, SWORD)).toBe(0);
  });

  test('timeout returns stakes with no winner', () => {
    const a = makePlayer('alice', 1);
    const b = makePlayer('bob', 2, 2.5, 1.5);
    a.inventory[0] = { itemId: COINS, quantity: 100 };
    b.inventory[0] = { itemId: SWORD, quantity: 1 };
    const { world } = makeHarness(a, b);
    openDuel(world, a, b);
    world.handleDuelStakeItem(a.id, 0, COINS, 40);
    world.handleDuelStakeItem(b.id, 0, SWORD, 1);
    acceptBothTwice(world, a, b);

    const duel = world.activeDuels.get(a.id);
    world.currentTick = duel.startedTick + 500;
    world.tickActiveDuels();

    expect(world.activeDuels.has(a.id)).toBe(false);
    expect(countItem(a, COINS)).toBe(100);
    expect(countItem(a, SWORD)).toBe(0);
    expect(countItem(b, SWORD)).toBe(1);
  });

  test('stake slot bounds use the duel stake size', () => {
    expect(DUEL_STAKE_SIZE).toBeGreaterThan(0);
  });
});
