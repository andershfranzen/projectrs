import { describe, expect, test } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { Npc } from '../src/entity/Npc';
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
});
