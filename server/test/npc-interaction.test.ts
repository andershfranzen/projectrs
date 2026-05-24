import { describe, expect, test } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { Npc } from '../src/entity/Npc';
import { processNpcCombat, processPlayerCombat } from '../src/combat/Combat';
import { ServerOpcode, type NpcDef } from '@projectrs/shared';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

const npcDef: NpcDef = {
  id: 1,
  name: 'Guide',
  health: 10,
  attack: 1,
  defence: 1,
  strength: 1,
  attackSpeed: 4,
  respawnTime: 10,
  aggressive: false,
  wanderRange: 0,
  lootTable: [],
};

function makeWorld(): any {
  const world = Object.create(World.prototype) as any;
  world.maps = new Map([[
    'kcmap',
    {
      isWallBlocked: () => false,
      isWallBlockedOnFloor: () => false,
      findPathOnFloor: (_sx: number, _sz: number, gx: number, gz: number) => [{ x: gx, z: gz }],
    },
  ]]);
  world.getPlayerMap = (player: Player) => world.maps.get(player.currentMapLevel);
  return world;
}

function makeCombatWorld(player: Player, npc: Npc): { world: any; broadcasts: Array<{ opcode: ServerOpcode; values: number[] }> } {
  const world = makeWorld();
  const broadcasts: Array<{ opcode: ServerOpcode; values: number[] }> = [];
  world.players = new Map([[player.id, player]]);
  world.npcs = new Map([[npc.id, npc]]);
  world.playerCombatTargets = new Map();
  world.npcTargetedBy = new Map();
  world.activeDuels = new Map();
  world.chunkManagers = new Map();
  world.blockedObjectTiles = new Set();
  world.entityTileOccupants = new Set();
  world.currentTick = 1;
  world.currentTickStartMs = 0;
  world.data = {
    itemDefs: new Map(),
    getSpellByIndex: () => null,
  };
  world.cancelSkilling = () => {};
  world.closeNpcUiContext = () => {};
  world.sendChatSystem = () => {};
  world.sendInventory = () => {};
  world.sendToPlayer = () => {};
  world.sendSingleSkill = () => {};
  world.setPlayerAnimation = () => {};
  world.broadcastPlayerAnimationEvent = () => {};
  world.broadcastCombatHit = () => {};
  world.broadcastProjectile = () => {};
  world.broadcastNearby = (_map: string, _x: number, _z: number, opcode: ServerOpcode, ...values: number[]) => {
    broadcasts.push({ opcode, values });
  };
  world.broadcastNearbyOnFloor = (_map: string, _floor: number, _x: number, _z: number, opcode: ServerOpcode, ...values: number[]) => {
    broadcasts.push({ opcode, values });
  };
  world.getMap = () => ({
    isTileBlockedOnFloor: () => false,
    isWallBlockedOnFloor: () => false,
    findPathForNpc: (_sx: number, _sz: number, gx: number, gz: number) => [{ x: gx, z: gz }],
  });
  world.blockedKeyFor = (_mapId: string, x: number, z: number, floor: number) => `${_mapId}:${Math.floor(x)}:${Math.floor(z)}:${floor}`;
  return { world, broadcasts };
}

describe('NPC interaction reachability', () => {
  test('requires standing on a valid interaction tile, not just within two path steps', () => {
    const world = makeWorld();
    const npc = new Npc(npcDef, 10.5, 10.5);
    npc.currentMapLevel = 'kcmap';

    const twoTilesAway = new Player('tester', 8.5, 10.5, fakeWs, 1);
    twoTilesAway.currentMapLevel = 'kcmap';
    expect(world.isPlayerNpcInteractionReachable(twoTilesAway, npc)).toBe(false);

    const adjacent = new Player('tester', 9.5, 10.5, fakeWs, 1);
    adjacent.currentMapLevel = 'kcmap';
    expect(world.isPlayerNpcInteractionReachable(adjacent, npc)).toBe(true);
  });

  test('pending talk repaths when the NPC walks away just before arrival', () => {
    const world = makeWorld();
    const player = new Player('tester', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 12.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.pendingTalkNpcId = npc.id;
    player.pendingTalkRepathTicks = 2;

    const queued = world.queuePlayerPathToNpcInteraction(player, npc);

    expect(queued).toBe(true);
    expect(player.hasMoveQueue()).toBe(true);
  });

  test('attacking from far away does not turn the NPC before combat connects', () => {
    const player = new Player('tester', 1.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world, broadcasts } = makeCombatWorld(player, npc);

    world.handlePlayerAttackNpc(player.id, npc.id);

    expect(player.hasMoveQueue()).toBe(true);
    expect(broadcasts.some(b => b.opcode === ServerOpcode.NPC_FACING)).toBe(false);
  });

  test('NPC turns toward the player when the first combat hit resolves', () => {
    const player = new Player('tester', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world, broadcasts } = makeCombatWorld(player, npc);

    world.handlePlayerAttackNpc(player.id, npc.id);
    expect(broadcasts.some(b => b.opcode === ServerOpcode.NPC_FACING)).toBe(false);

    world.tickPlayerCombat();

    expect(broadcasts.some(b => b.opcode === ServerOpcode.NPC_FACING)).toBe(true);
  });

  test('melee combat requires a cardinal NPC interaction tile', () => {
    const diagonal = new Player('diagonal', 9.5, 9.5, fakeWs, 1);
    const cardinal = new Player('cardinal', 9.5, 10.5, fakeWs, 2);
    const npc = new Npc(npcDef, 10.5, 10.5);

    expect(processPlayerCombat(diagonal, npc, new Map())).toBeNull();
    expect(processPlayerCombat(cardinal, npc, new Map())).not.toBeNull();
  });

  test('NPC leash disengage also clears the player combat target', () => {
    const player = new Player('tester', 25.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    npc.position.x = 18.5;
    npc.combatTarget = player;
    const { world, broadcasts } = makeCombatWorld(player, npc);
    world.playerCombatTargets.set(player.id, npc.id);
    world.npcTargetedBy.set(npc.id, new Set([player.id]));

    world.tickNpcAI();

    expect(npc.combatTarget).toBeNull();
    expect(npc.returning).toBe(true);
    expect(world.playerCombatTargets.has(player.id)).toBe(false);
    expect(world.npcTargetedBy.has(npc.id)).toBe(false);
    expect(broadcasts.some(b => b.opcode === ServerOpcode.COMBAT_HIT && b.values[0] === npc.id && b.values[1] === -1)).toBe(true);
  });

  test('autocast cannot keep damaging an NPC that is outside its retaliation leash', () => {
    const player = new Player('caster', 25.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    npc.position.x = 18.5;
    player.autocastSpellIndex = 0;
    const { world } = makeCombatWorld(player, npc);
    world.data.getSpellByIndex = () => ({ id: 'test-spell' });
    world.playerCombatTargets.set(player.id, npc.id);
    world.npcTargetedBy.set(npc.id, new Set([player.id]));

    world.tickPlayerCombat();

    expect(npc.health).toBe(npc.maxHealth);
    expect(npc.combatTarget).toBeNull();
    expect(npc.returning).toBe(true);
    expect(world.playerCombatTargets.has(player.id)).toBe(false);
  });

  test('NPC melee retaliation uses the NPC footprint, not only its anchor tile', () => {
    const largeNpcDef: NpcDef = { ...npcDef, size: 2 };
    const player = new Player('tester', 8.5, 9.5, fakeWs, 1);
    const npc = new Npc(largeNpcDef, 10.5, 10.5);

    expect(processNpcCombat(npc, player, new Map())).not.toBeNull();
  });

  test('NPC first-retaliation cooldown keeps ticking while chasing', () => {
    const player = new Player('archer', 14.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    npc.combatTarget = player;
    npc.attackCooldown = Math.floor(npc.attackSpeed / 2);

    expect(processNpcCombat(npc, player, new Map())).toBeNull();
    expect(npc.attackCooldown).toBe(1);

    expect(processNpcCombat(npc, player, new Map())).toBeNull();
    expect(npc.attackCooldown).toBe(0);

    player.position.x = 9.5;
    const hit = processNpcCombat(npc, player, new Map());
    expect(hit?.attackerId).toBe(npc.id);
    expect(npc.attackCooldown).toBe(npc.attackSpeed);
  });
});
