import { describe, expect, test } from 'bun:test';
import type { NpcDef } from '@projectrs/shared';
import { CombatSystem } from './combat/CombatSystem';
import { Npc } from './entity/Npc';
import { Player } from './entity/Player';
import { World } from './World';

function npcDef(id: number, name = 'Palace Guard'): NpcDef {
  return {
    id,
    name,
    examineText: '',
    health: 34,
    attack: 32,
    defence: 20,
    strength: 23,
    attackSpeed: 4,
    respawnTime: 30,
    aggressive: false,
    wanderRange: 3,
    lootTable: [],
  };
}

function makePlayer(name: string, x: number, z: number): Player {
  return new Player(name, x, z, {} as any, 1);
}

function makeWorldHarness() {
  const world: any = Object.create(World.prototype);
  const alerts: Array<{ npcId: number; message: string; alert: boolean }> = [];
  world.currentTick = 25;
  world.npcs = new Map<number, Npc>();
  world.maps = new Map([['kcmap', { hasWallLineOfSight: () => true }]]);
  world.activeDuels = new Map();
  world.combatSystem = new CombatSystem();
  world.canPlayerTargetNpc = () => true;
  world.broadcastNpcFacingPlayer = () => {};
  world.broadcastNpcOverheadMessage = (npc: Npc, message: string, alert: boolean = false) => alerts.push({ npcId: npc.id, message, alert });
  world.alerts = alerts;
  return world;
}

describe('palace guard assist', () => {
  test('nearby palace guards retaliate against a player who attacked a palace guard', () => {
    const world = makeWorldHarness();
    const attacker = makePlayer('attacker', 11.5, 10.5);
    const attacked = new Npc(npcDef(110), 10.5, 10.5);
    const helper = new Npc(npcDef(110), 13.5, 10.5);
    world.npcs.set(attacked.id, attacked);
    world.npcs.set(helper.id, helper);

    world.callPalaceGuardAssist(attacked, attacker);

    expect(world.combatSystem.listRetaliationRequests()).toEqual([
      {
        actor: { kind: 'npc', id: helper.id },
        target: { kind: 'player', id: attacker.id },
        earliestTick: 25,
        reason: 'npc-retaliate',
      },
    ]);
    expect(world.alerts).toContainEqual({ npcId: helper.id, message: '!', alert: true });
  });

  test('distant palace guards do not assist', () => {
    const world = makeWorldHarness();
    const attacker = makePlayer('attacker', 11.5, 10.5);
    const attacked = new Npc(npcDef(110), 10.5, 10.5);
    const helper = new Npc(npcDef(110), 18.5, 10.5);
    world.npcs.set(attacked.id, attacked);
    world.npcs.set(helper.id, helper);

    world.callPalaceGuardAssist(attacked, attacker);

    expect(world.combatSystem.listRetaliationRequests()).toEqual([]);
  });

  test('palace guards on the other side of a wall do not assist', () => {
    const world = makeWorldHarness();
    world.maps.set('kcmap', { hasWallLineOfSight: () => false });
    const attacker = makePlayer('attacker', 11.5, 10.5);
    const attacked = new Npc(npcDef(110), 10.5, 10.5);
    const helper = new Npc(npcDef(110), 11.5, 10.5);
    world.npcs.set(attacked.id, attacked);
    world.npcs.set(helper.id, helper);

    world.callPalaceGuardAssist(attacked, attacker);

    expect(world.combatSystem.listRetaliationRequests()).toEqual([]);
    expect(world.alerts).toEqual([]);
  });

  test('palace guards on another floor do not assist even when x/z are nearby', () => {
    const world = makeWorldHarness();
    const attacker = makePlayer('attacker', 11.5, 10.5);
    const attacked = new Npc(npcDef(110), 10.5, 10.5);
    const upstairsHelper = new Npc(npcDef(110), 11.5, 10.5);
    upstairsHelper.currentFloor = 1;
    world.npcs.set(attacked.id, attacked);
    world.npcs.set(upstairsHelper.id, upstairsHelper);

    world.callPalaceGuardAssist(attacked, attacker);

    expect(world.combatSystem.listRetaliationRequests()).toEqual([]);
  });

  test('palace guards do not assist an attacked guard on another floor', () => {
    const world = makeWorldHarness();
    const attacker = makePlayer('attacker', 11.5, 10.5);
    const upstairsAttacked = new Npc(npcDef(110), 10.5, 10.5);
    const helper = new Npc(npcDef(110), 11.5, 10.5);
    upstairsAttacked.currentFloor = 1;
    world.npcs.set(upstairsAttacked.id, upstairsAttacked);
    world.npcs.set(helper.id, helper);

    world.callPalaceGuardAssist(upstairsAttacked, attacker);

    expect(world.combatSystem.listRetaliationRequests()).toEqual([]);
  });

  test('non-palace guards and busy palace guards do not assist', () => {
    const world = makeWorldHarness();
    const attacker = makePlayer('attacker', 11.5, 10.5);
    const otherTarget = makePlayer('other', 12.5, 10.5);
    const attacked = new Npc(npcDef(110), 10.5, 10.5);
    const townGuard = new Npc(npcDef(5, 'Guard'), 12.5, 10.5);
    const busyPalaceGuard = new Npc(npcDef(110), 13.5, 10.5);
    busyPalaceGuard.setCombatTarget(otherTarget);
    world.npcs.set(attacked.id, attacked);
    world.npcs.set(townGuard.id, townGuard);
    world.npcs.set(busyPalaceGuard.id, busyPalaceGuard);

    world.callPalaceGuardAssist(attacked, attacker);

    expect(world.combatSystem.listRetaliationRequests()).toEqual([]);
  });

  test('palace guards can share a player target for AI reservation', () => {
    const world = makeWorldHarness();
    const target = makePlayer('target', 11.5, 10.5);
    const palaceGuard = new Npc(npcDef(110), 10.5, 10.5);
    const townGuard = new Npc(npcDef(5, 'Guard'), 10.5, 10.5);

    expect(world.canPalaceGuardShareNpcTarget(palaceGuard, target)).toBe(true);
    expect(world.canPalaceGuardShareNpcTarget(townGuard, target)).toBe(false);
    palaceGuard.currentFloor = 1;
    expect(world.canPalaceGuardShareNpcTarget(palaceGuard, target)).toBe(false);
  });
});
