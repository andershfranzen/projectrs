import { describe, expect, test } from 'bun:test';
import { TICK_RATE } from '@projectrs/shared';
import { World } from '../src/World';
import { COMBAT_LOGOUT_BLOCK_TICKS, Player } from '../src/entity/Player';

const fakeWs = {
  closed: false,
  close() { this.closed = true; },
  sendBinary() {},
  send() {},
} as any;

function makePlayer(name = 'alice', accountId = 1): Player {
  const player = new Player(name, 1.5, 1.5, fakeWs, accountId);
  player.currentMapLevel = 'kcmap';
  player.currentFloor = 0;
  return player;
}

function makeHarness(player: Player): { world: any; chats: string[]; saves: number[]; removed: number[] } {
  const chats: string[] = [];
  const saves: number[] = [];
  const removed: number[] = [];
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[player.id, player]]);
  world.npcs = new Map();
  world.playerCombatTargets = new Map();
  world.npcTargetedBy = new Map();
  world.pendingTradeRequests = new Map();
  world.tradeSessions = new Map();
  world.duelStakeSessions = new Map();
  world.activeDuels = new Map();
  world.pendingDuelRequests = new Map();
  world.pendingSpellImpacts = [];
  world.skillingActions = new Map();
  world.currentTick = 100;
  world.db = {
    savePlayerState(accountId: number) { saves.push(accountId); },
    recordLogout() {},
  };
  world.computeEffectiveY = (p: Player) => p.effectiveY;
  world.closeDialogueForPlayer = () => {};
  world.clearPendingObjectIntents = () => {};
  world.cancelSkilling = () => {};
  world.setPlayerAnimation = () => {};
  world.sendChatSystem = (_p: Player, message: string) => { chats.push(message); };
  world.removePlayer = (id: number) => {
    removed.push(id);
    world.players.delete(id);
  };
  return { world, chats, saves, removed };
}

describe('logout protection and idle timeout', () => {
  test('manual logout is blocked until at least 10 seconds after combat', () => {
    const player = makePlayer();
    const { world, chats, removed } = makeHarness(player);
    player.markInCombat(world.currentTick);

    expect(player.logoutBlockedUntilTick - world.currentTick).toBe(COMBAT_LOGOUT_BLOCK_TICKS);
    expect((player.logoutBlockedUntilTick - world.currentTick) * TICK_RATE).toBeGreaterThanOrEqual(10_000);
    expect(world.requestAccountLogout(player.accountId)).toBe(false);
    expect(world.players.has(player.id)).toBe(true);
    expect(chats[0]).toContain('You cannot log out');

    world.currentTick = player.logoutBlockedUntilTick;
    expect(world.requestAccountLogout(player.accountId)).toBe(true);
    expect(removed).toEqual([player.id]);
  });

  test('closing the window during combat leaves the player until the combat timer clears', () => {
    const player = makePlayer();
    const { world, removed } = makeHarness(player);
    player.markInCombat(world.currentTick);

    world.handlePlayerDisconnect(player.id);

    expect(player.disconnected).toBe(true);
    expect(world.players.has(player.id)).toBe(true);
    world.currentTick = player.logoutBlockedUntilTick - 1;
    world.tickDeferredLogouts();
    expect(world.players.has(player.id)).toBe(true);

    world.currentTick = player.logoutBlockedUntilTick;
    world.tickDeferredLogouts();
    expect(removed).toEqual([player.id]);
  });

  test('combat x-log has a 60 second hard cap if combat keeps rearming', () => {
    const player = makePlayer();
    const { world, removed } = makeHarness(player);
    player.markInCombat(world.currentTick);

    world.handlePlayerDisconnect(player.id);
    const deadline = player.logoutDeadlineTick;

    world.currentTick = deadline - 1;
    player.markInCombat(world.currentTick);
    world.tickDeferredLogouts();
    expect(world.players.has(player.id)).toBe(true);

    world.currentTick = deadline;
    player.markInCombat(world.currentTick);
    world.tickDeferredLogouts();
    expect(removed).toEqual([player.id]);
  });

  test('idle warning fires at 4 minutes and activity resets the timer', () => {
    const player = makePlayer();
    const { world, chats } = makeHarness(player);
    player.lastActivityTick = 0;
    world.currentTick = Math.ceil(4 * 60_000 / TICK_RATE);

    world.tickIdleLogouts();

    expect(chats).toContain('You have been inactive for 4 minutes and will be signed out in 1 minute.');
    expect(player.idleWarningSent).toBe(true);

    world.recordPlayerActivity(player.id);
    expect(player.lastActivityTick).toBe(world.currentTick);
    expect(player.idleWarningSent).toBe(false);
  });

  test('idle logout removes inactive players at 5 minutes', () => {
    const player = makePlayer();
    const { world, removed } = makeHarness(player);
    player.lastActivityTick = 0;
    world.currentTick = Math.ceil(5 * 60_000 / TICK_RATE);

    world.tickIdleLogouts();

    expect(removed).toEqual([player.id]);
  });

  test('idle logout during combat defers removal until combat logout is legal', () => {
    const player = makePlayer();
    const { world, removed } = makeHarness(player);
    player.lastActivityTick = 0;
    world.currentTick = Math.ceil(5 * 60_000 / TICK_RATE);
    player.markInCombat(world.currentTick);

    world.tickIdleLogouts();

    expect(player.disconnected).toBe(true);
    expect(player.requestIdleLogout).toBe(true);
    expect(world.players.has(player.id)).toBe(true);

    world.currentTick = player.logoutBlockedUntilTick;
    world.tickDeferredLogouts();

    expect(removed).toEqual([player.id]);
  });
});
