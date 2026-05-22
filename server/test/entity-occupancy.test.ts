import { describe, expect, test } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { Npc } from '../src/entity/Npc';
import type { NpcDef } from '@projectrs/shared';

const fakeWs = {
  sendBinary() {},
  send() {},
  close() {},
} as any;

const npcDef: NpcDef = {
  id: 1,
  name: 'Rat',
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

function makeWorldHarness(): any {
  const world = Object.create(World.prototype) as any;
  world.players = new Map();
  world.npcs = new Map();
  world.groundItems = new Map();
  world.worldObjects = new Map();
  world.blockedObjectTiles = new Set();
  world.entityTileOccupants = new Set();
  world.currentTick = 0;
  world.currentTickStartMs = 0;
  world.lastBotStatsCheckpointTick = 0;
  world.tickOverrunCount = 0;
  world.lastTickWarnTime = 0;
  return world;
}

describe('entity occupancy', () => {
  test('dead NPCs do not reserve collision tiles', () => {
    const world = makeWorldHarness();
    const npc = new Npc(npcDef, 10.5, 10.5);
    npc.dead = true;
    world.npcs.set(npc.id, npc);

    world.rebuildEntityTileOccupants();

    expect(world.entityTileOccupants.size).toBe(0);
  });

  test('tick refreshes occupancy after player and NPC movement phases', () => {
    const world = makeWorldHarness();
    const calls: string[] = [];
    world.rebuildEntityTileOccupants = () => calls.push('rebuild');
    world.tickPlayerMovement = () => calls.push('players');
    world.tickNpcAI = () => calls.push('npcs');
    world.tickPlayerCooldowns = () => {};
    world.tickQueuedSpellCasts = () => {};
    world.tickActiveDuels = () => {};
    world.tickPlayerCombat = () => {};
    world.tickNpcCombat = () => {};
    world.tickPendingSpells = () => {};
    world.tickSkillingActions = () => {};
    world.tickObjectRespawns = () => {};
    world.tickItemDespawns = () => {};
    world.tickDialogueScheduledSteps = () => {};
    world.tickObjectSayScheduledLines = () => {};
    world.tickTransitions = () => {};
    world.tickIdleLogouts = () => {};
    world.tickDeferredLogouts = () => calls.push('deferred');
    world.broadcastSync = () => calls.push('broadcast');

    world.tick();

    expect(calls.slice(0, 5)).toEqual(['rebuild', 'players', 'rebuild', 'npcs', 'rebuild']);
    expect(calls.slice(-3)).toEqual(['deferred', 'rebuild', 'broadcast']);
  });

  test('player-to-NPC interaction paths keep the full player path search budget', () => {
    const world = makeWorldHarness();
    const player = new Player('alice', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    let seenBudget = 0;
    const map = {
      isBlocked: () => false,
      isTileBlockedOnFloor: () => false,
      isWallBlocked: () => false,
      isWallBlockedOnFloor: () => false,
      findPathForNpc: (_sx: number, _sz: number, gx: number, gz: number, _blocked: unknown, maxSteps: number) => {
        seenBudget = maxSteps;
        return [{ x: gx, z: gz }];
      },
      findPathOnFloor: () => [],
    };
    world.getPlayerMap = () => map;

    const path = world.findPlayerPathToNpc(player, npc);

    expect(path.length).toBe(1);
    expect(seenBudget).toBe(800);
  });
});
