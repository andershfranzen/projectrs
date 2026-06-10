import { describe, expect, test } from 'bun:test';
import type { ItemDef, NpcDef, WorldObjectDef } from '@projectrs/shared';
import { ServerChunkManager } from '../src/ChunkManager';
import { CombatSystem } from '../src/combat/CombatSystem';
import { Npc } from '../src/entity/Npc';
import { COMBAT_LOGOUT_BLOCK_TICKS, POST_COMBAT_STEAL_BLOCK_TICKS, Player } from '../src/entity/Player';
import { WorldObject } from '../src/entity/WorldObject';
import { World } from '../src/World';
import { hasTileLineOfSight } from '../src/visibility/LineOfSight';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

const coinsItem: ItemDef = {
  id: 10,
  name: 'Coins',
  description: '',
  value: 1,
  stackable: true,
  equippable: false,
};

function makeNpcDef(id: number, name: string, wanderRange = 0): NpcDef {
  return {
    id,
    name,
    examineText: name.includes('Guard') ? 'A market guard.' : '',
    health: 20,
    attack: name.includes('Guard') ? 10 : 1,
    defence: 10,
    strength: name.includes('Guard') ? 10 : 1,
    attackSpeed: 4,
    respawnTime: 30,
    aggressive: false,
    wanderRange,
    lootTable: [],
    stationary: wanderRange === 0,
  };
}

function makeStallDef(merchantNpcId = 114): WorldObjectDef {
  return {
    id: 52,
    name: 'Food Stall',
    category: 'stall',
    actions: ['Steal-from', 'Examine'],
    blocking: true,
    width: 2,
    depth: 1,
    height: 1,
    color: [120, 80, 40],
    skill: 'roguery',
    levelRequired: 1,
    xpReward: 0,
    harvestItemId: 10,
    harvestQuantity: 1,
    respawnTime: 15,
    depletedAssetId: 'depleted stall',
    stallMerchantNpcId: merchantNpcId,
  };
}

function makeWorldHarness(): {
  world: any;
  messages: string[];
  overheads: Array<{ npcId: number; message: string }>;
  depletions: WorldObject[];
} {
  const world = Object.create(World.prototype) as any;
  const messages: string[] = [];
  const overheads: Array<{ npcId: number; message: string }> = [];
  const depletions: WorldObject[] = [];
  world.currentTick = 10;
  world.maps = new Map([['kcmap', { hasWallLineOfSight: () => true }]]);
  world.npcs = new Map<number, Npc>();
  world.players = new Map<number, Player>();
  world.activeDuels = new Map();
  world.blockedObjectTiles = new Set<string>();
  world.closedCenteredDoorTileCounts = new Map();
  world.closedCenteredDoorTileKeysByObjectId = new Map();
  world.combatSystem = new CombatSystem();
  world.data = { itemDefs: new Map([[coinsItem.id, coinsItem]]) };
  world.quests = { notifyQuestEvent() {} };
  world.canPlayerTargetNpc = () => true;
  world.broadcastNpcFacingPlayer = () => {};
  world.broadcastNpcOverheadMessage = (npc: Npc, message: string) => overheads.push({ npcId: npc.id, message });
  world.sendChatSystem = (_player: Player, message: string) => messages.push(message);
  world.sendInventory = () => {};
  world.sendToPlayer = () => {};
  world.sendLevelUp = () => {};
  world.sendSingleSkill = () => {};
  world.setPlayerAnimation = () => {};
  world.persistAndBroadcastDepletion = (obj: WorldObject) => depletions.push(obj);
  world.recordGameEvent = () => {};
  return { world, messages, overheads, depletions };
}

describe('stall thieving awareness', () => {
  test('tile line of sight is blocked by interior collision boxes only', () => {
    expect(hasTileLineOfSight(0.5, 0.5, 4.5, 0.5, (x, z) => x === 2 && z === 0)).toBe(false);
    expect(hasTileLineOfSight(0.5, 0.5, 4.5, 0.5, (x, z) => x === 0 && z === 0)).toBe(true);
    expect(hasTileLineOfSight(0.5, 0.5, 4.5, 0.5, (x, z) => x === 4 && z === 0)).toBe(true);
  });

  test('tile line of sight blocks exact corner peeking between collision boxes', () => {
    expect(hasTileLineOfSight(0.5, 0.5, 3.5, 3.5, (x, z) => x === 1 && z === 0)).toBe(false);
    expect(hasTileLineOfSight(0.5, 0.5, 3.5, 3.5, (x, z) => x === 0 && z === 1)).toBe(false);
  });

  test('world collision LOS combines wall edges and object boxes', () => {
    const { world } = makeWorldHarness();
    const blockerKey = world.blockedKeyFor('kcmap', 2, 0, 0);
    world.blockedObjectTiles.add(blockerKey);

    expect(world.hasCollisionLineOfSight('kcmap', 0, 0.5, 0.5, 4.5, 0.5)).toBe(false);

    world.blockedObjectTiles.clear();
    world.maps.set('kcmap', { hasWallLineOfSight: () => false });
    expect(world.hasCollisionLineOfSight('kcmap', 0, 0.5, 0.5, 4.5, 0.5)).toBe(false);
  });

  test('a visible guard attacks without blocking a successful stall steal', () => {
    const { world, messages, overheads, depletions } = makeWorldHarness();
    const player = new Player('thief', 11.5, 10.5, fakeWs, 1);
    const guard = new Npc(makeNpcDef(7, 'Guard', 3), 10.5, 10.5);
    const stall = new WorldObject(makeStallDef(0), 12.5, 10.5, 'kcmap', 0, 0);
    world.npcs.set(guard.id, guard);

    world.handleStallSteal(player, stall);

    expect(player.inventory.some(slot => slot?.itemId === 10 && slot.quantity === 1)).toBe(true);
    expect(messages).toContain('You steal a coins.');
    expect(overheads).toContainEqual({ npcId: guard.id, message: 'Hey! Get your hands off there!' });
    expect(world.combatSystem.listRetaliationRequests()).toContainEqual({
      actor: { kind: 'npc', id: guard.id },
      target: { kind: 'player', id: player.id },
      earliestTick: 10,
      reason: 'npc-retaliate',
    });
    expect(depletions).toEqual([stall]);
  });

  test('post-combat stall steal block expires after 8 ticks, before logout block', () => {
    const { world, messages, depletions } = makeWorldHarness();
    const player = new Player('thief', 11.5, 10.5, fakeWs, 1);
    const stall = new WorldObject(makeStallDef(0), 12.5, 10.5, 'kcmap', 0, 0);

    player.markInCombat(world.currentTick);
    expect(player.stallStealBlockedUntilTick - world.currentTick).toBe(POST_COMBAT_STEAL_BLOCK_TICKS);
    expect(player.logoutBlockedUntilTick - world.currentTick).toBe(COMBAT_LOGOUT_BLOCK_TICKS);

    world.currentTick += POST_COMBAT_STEAL_BLOCK_TICKS - 1;
    world.handleStallSteal(player, stall);
    expect(messages).toContain("You can't steal from the market stall during combat!");
    expect(player.inventory.every(slot => slot === null)).toBe(true);
    expect(depletions).toEqual([]);

    messages.length = 0;
    world.currentTick += 1;
    expect(player.isLogoutBlocked(world.currentTick)).toBe(true);
    world.handleStallSteal(player, stall);

    expect(messages).toContain('You steal a coins.');
    expect(player.inventory.some(slot => slot?.itemId === 10 && slot.quantity === 1)).toBe(true);
    expect(depletions).toEqual([stall]);
  });

  test('off-map guards are rejected before combat targetability work', () => {
    const { world } = makeWorldHarness();
    const player = new Player('thief', 11.5, 10.5, fakeWs, 1);
    const guard = new Npc(makeNpcDef(7, 'Guard', 3), 10.5, 10.5);
    guard.currentMapLevel = 'other-map';
    let targetabilityChecks = 0;
    world.canPlayerTargetNpc = () => {
      targetabilityChecks++;
      return true;
    };
    world.npcs.set(guard.id, guard);

    expect(world.findVisibleStallGuard(player)).toBeNull();
    expect(targetabilityChecks).toBe(0);
  });

  test('guard lookup uses the chunk index instead of scanning distant NPCs', () => {
    const { world } = makeWorldHarness();
    const player = new Player('thief', 11.5, 10.5, fakeWs, 1);
    const nearGuard = new Npc(makeNpcDef(7, 'Guard', 3), 10.5, 10.5);
    const distantGuard = new Npc(makeNpcDef(7, 'Guard', 3), 90.5, 90.5);
    const chunks = new ServerChunkManager(128, 128);
    chunks.addEntity(nearGuard.id, nearGuard.position.x, nearGuard.position.y, 'npc');
    world.chunkManagers = new Map([['kcmap', chunks]]);
    world.maxThievingGuardWanderRange = 6;
    world.npcs.set(nearGuard.id, nearGuard);
    world.npcs.set(distantGuard.id, distantGuard);
    let targetabilityChecks = 0;
    world.canPlayerTargetNpc = () => {
      targetabilityChecks++;
      return true;
    };

    expect(world.findVisibleStallGuard(player)).toBe(nearGuard);
    expect(targetabilityChecks).toBe(1);
  });

  test('combat NPCs are not stall guards just because examine text says guard', () => {
    const { world, overheads } = makeWorldHarness();
    const player = new Player('thief', 11.5, 10.5, fakeWs, 1);
    const skeletonDef = {
      ...makeNpcDef(100, 'Skeleton', 3),
      examineText: 'A skeleton standing guard over old orders.',
      attack: 10,
      strength: 10,
      stationary: false,
    };
    const skeleton = new Npc(skeletonDef, 10.5, 10.5);
    const stall = new WorldObject(makeStallDef(0), 12.5, 10.5, 'kcmap', 0, 0);
    world.npcs.set(skeleton.id, skeleton);

    world.handleStallSteal(player, stall);

    expect(overheads).toEqual([]);
    expect(world.combatSystem.listRetaliationRequests()).toEqual([]);
  });

  test('a visible merchant blocks the steal and calls a nearby visible guard', () => {
    const { world, messages, overheads, depletions } = makeWorldHarness();
    const player = new Player('thief', 11.5, 10.5, fakeWs, 1);
    const merchant = new Npc(makeNpcDef(114, 'Food Stall Merchant'), 10.5, 10.5);
    const guard = new Npc(makeNpcDef(7, 'Guard', 3), 12.5, 10.5);
    const stall = new WorldObject(makeStallDef(114), 10.5, 10.5, 'kcmap', 0, 0);
    world.npcs.set(merchant.id, merchant);
    world.npcs.set(guard.id, guard);

    world.handleStallSteal(player, stall);

    expect(player.inventory.every(slot => slot === null)).toBe(true);
    expect(messages).toContain('The merchant is watching you too closely.');
    expect(overheads).toContainEqual({ npcId: merchant.id, message: 'Hey! Get your hands off there!' });
    expect(overheads).toContainEqual({ npcId: merchant.id, message: 'Guards guards!' });
    expect(world.combatSystem.listRetaliationRequests()).toContainEqual({
      actor: { kind: 'npc', id: guard.id },
      target: { kind: 'player', id: player.id },
      earliestTick: 10,
      reason: 'npc-retaliate',
    });
    expect(depletions).toEqual([]);
  });

  test('a collision box between merchant and thief prevents merchant spotting', () => {
    const { world, messages } = makeWorldHarness();
    const player = new Player('thief', 13.5, 10.5, fakeWs, 1);
    const merchant = new Npc(makeNpcDef(114, 'Food Stall Merchant'), 10.5, 10.5);
    const stall = new WorldObject(makeStallDef(114), 12.5, 10.5, 'kcmap', 0, 0);
    world.npcs.set(merchant.id, merchant);
    world.blockedObjectTiles.add(world.blockedKeyFor('kcmap', 11, 10, 0));

    world.handleStallSteal(player, stall);

    expect(messages).toContain('You steal a coins.');
  });
});
