import { describe, expect, test, afterEach } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { Npc } from '../src/entity/Npc';
import type { NpcDef } from '@projectrs/shared';

const fakeWs = { sendBinary() {}, send() {} } as any;

const cowDef: NpcDef = {
  id: 10,
  name: 'Cow',
  health: 5,
  attack: 1,
  defence: 0,
  strength: 1,
  attackSpeed: 4,
  respawnTime: 10,
  aggressive: false,
  wanderRange: 0,
  lootTable: [],
};

// Build a World instance with only the collaborators tickPlayerCombat's
// melee death path touches; creditMobKill + getTopDamager run for real, and
// db.recordMobKill is spied so we can count how many times one kill credits.
function makeMeleeWorld(player: Player, npc: Npc): { world: any; killCalls: Array<[number, number]> } {
  const killCalls: Array<[number, number]> = [];
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[player.id, player]]);
  world.npcs = new Map([[npc.id, npc]]);
  world.playerCombatTargets = new Map([[player.id, npc.id]]);
  world.npcTargetedBy = new Map();
  world.pendingSpellImpacts = [];
  world.currentTick = 0;
  world.currentTickStartMs = 0;
  world.data = { itemDefs: new Map() };
  world.db = { recordMobKill: (accountId: number, npcDefId: number) => { killCalls.push([accountId, npcDefId]); } };
  // Stubs for the broadcast/animation/quest/loot collaborators that are not
  // part of the kill-credit logic under test.
  world.canPlayerTargetNpc = () => true;
  world.isPlayerInNpcAttackRange = () => true;
  world.setPlayerAnimation = () => {};
  world.broadcastCombatHit = () => {};
  world.broadcastNpcFacingPlayer = () => {};
  world.sendToPlayer = () => {};
  world.sendSingleSkill = () => {};
  world.handleNpcDeath = () => {};
  world.spawnNpcLoot = () => {};
  world.clearCombatTarget = (playerId: number) => { world.playerCombatTargets.delete(playerId); };
  world.quests = { notifyQuestEvent: () => {} };
  return { world, killCalls };
}

describe('mob kill credit (real combat tick)', () => {
  const realRandom = Math.random;
  afterEach(() => { Math.random = realRandom; });

  test('a single melee kill credits exactly once', () => {
    // 0.99 → hit lands and deals positive damage every swing (deterministic).
    Math.random = () => 0.99;

    const player = new Player('hunter', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(cowDef, 10.5, 10.5); // cardinally adjacent → interaction tile
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.autocastSpellIndex = -1;

    const { world, killCalls } = makeMeleeWorld(player, npc);

    // Swing until the cow is dead, mirroring real play (cooldown reset each tick).
    for (let i = 0; i < 50 && !npc.dead; i++) {
      player.attackCooldown = 0;
      world.currentTick = i;
      world.tickPlayerCombat();
    }

    expect(npc.dead).toBe(true);
    expect(killCalls).toEqual([[1, 10]]); // exactly one credit: account 1, cow def 10
  });

  test('ticking after death does not re-credit', () => {
    Math.random = () => 0.99;
    const player = new Player('hunter', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(cowDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.autocastSpellIndex = -1;

    const { world, killCalls } = makeMeleeWorld(player, npc);
    // Re-add the target after death to simulate a stale/duplicate target entry.
    for (let i = 0; i < 60; i++) {
      player.attackCooldown = 0;
      world.currentTick = i;
      world.playerCombatTargets.set(player.id, npc.id);
      world.tickPlayerCombat();
    }

    expect(npc.dead).toBe(true);
    expect(killCalls.length).toBe(1);
  });
});

// Magic kills run through a SEPARATE death block in tickPendingSpells. Drive it
// directly by pushing impacts (bypasses rune costs) so we can verify the
// credit count, including two impacts landing the same tick.
function makeMagicWorld(player: Player, npc: Npc): { world: any; killCalls: Array<[number, number]> } {
  const killCalls: Array<[number, number]> = [];
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[player.id, player]]);
  world.npcs = new Map([[npc.id, npc]]);
  world.pendingSpellImpacts = [];
  world.currentTick = 0;
  world.db = { recordMobKill: (a: number, n: number) => { killCalls.push([a, n]); } };
  world.broadcastNpcFacingPlayer = () => {};
  world.broadcastCombatHit = () => {};
  world.sendToPlayer = () => {};
  world.sendSingleSkill = () => {};
  world.handleNpcDeath = () => {};
  world.spawnNpcLoot = () => {};
  world.clearCombatTarget = () => {};
  return { world, killCalls };
}

function impact(player: Player, npc: Npc, damage: number) {
  return {
    impactTick: 0,
    attackerId: player.id,
    targetId: npc.id,
    damage,
    spellId: 'test',
    xpSkill: 'evilmagic',
    mapLevel: player.currentMapLevel,
    floor: player.currentFloor,
  };
}

describe('mob kill credit — magic (tickPendingSpells)', () => {
  test('a single lethal spell impact credits exactly once', () => {
    const player = new Player('mage', 9.5, 10.5, fakeWs, 2);
    const npc = new Npc(cowDef, 10.5, 10.5);
    player.currentMapLevel = npc.currentMapLevel = 'kcmap';
    const { world, killCalls } = makeMagicWorld(player, npc);
    world.pendingSpellImpacts = [impact(player, npc, 5)];

    world.tickPendingSpells();

    expect(npc.dead).toBe(true);
    expect(killCalls).toEqual([[2, 10]]);
  });

  test('two impacts landing the same tick credit only once (dead-guard)', () => {
    const player = new Player('mage', 9.5, 10.5, fakeWs, 2);
    const npc = new Npc(cowDef, 10.5, 10.5);
    player.currentMapLevel = npc.currentMapLevel = 'kcmap';
    const { world, killCalls } = makeMagicWorld(player, npc);
    // Both queued before impact (e.g. a fast autocast); first one is lethal.
    world.pendingSpellImpacts = [impact(player, npc, 5), impact(player, npc, 5)];

    world.tickPendingSpells();

    expect(npc.dead).toBe(true);
    expect(killCalls.length).toBe(1);
  });
});
