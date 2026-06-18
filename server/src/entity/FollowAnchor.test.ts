import { describe, expect, test } from 'bun:test';
import type { NpcDef } from '@projectrs/shared';
import { Npc } from './Npc';
import { Player } from './Player';

function makePlayer(x: number, z: number): Player {
  return new Player('tester', x, z, {} as any, 1);
}

function makeNpc(x: number, z: number, size = 1): Npc {
  const def: NpcDef = {
    id: 1,
    name: 'Rat',
    health: 5,
    attack: 1,
    defence: 1,
    strength: 1,
    attackSpeed: 4,
    respawnTime: 10,
    aggressive: false,
    wanderRange: 10,
    lootTable: [],
    size,
  };
  return new Npc(def, x, z);
}

describe('follow anchors', () => {
  test('player movement stores the previous occupied tile as follow anchor', () => {
    const player = makePlayer(10.5, 10.5);
    expect(player.followAnchorX).toBe(9.5);
    expect(player.followAnchorZ).toBe(10.5);

    player.setMoveQueue([{ x: 11.5, z: 10.5 }]);
    player.movementCredit = 1;
    expect(player.processMovement(1)).toBe(true);
    expect(player.position.x).toBe(11.5);
    expect(player.position.y).toBe(10.5);
    expect(player.followAnchorX).toBe(10.5);
    expect(player.followAnchorZ).toBe(10.5);

    expect(player.processMovement(2)).toBe(false);
    expect(player.followAnchorX).toBe(10.5);
    expect(player.followAnchorZ).toBe(10.5);
  });

  test('teleport resets follow anchor to an adjacent default tile', () => {
    const player = makePlayer(10.5, 10.5);
    player.moveTo(11.5, 10.5);
    player.teleportTo(20.5, 30.5);

    expect(player.position.x).toBe(20.5);
    expect(player.position.y).toBe(30.5);
    expect(player.followAnchorX).toBe(19.5);
    expect(player.followAnchorZ).toBe(30.5);
  });

  test('npc combat overlap is invalid and steps to a normal adjacent tile', () => {
    const npc = makeNpc(10.5, 10.5);
    const player = makePlayer(10.5, 10.5);
    npc.setCombatTarget(player);

    npc.processAI(() => false);

    expect(Math.floor(npc.position.x)).not.toBe(Math.floor(player.position.x));
    expect(Math.max(Math.abs(npc.position.x - player.position.x), Math.abs(npc.position.y - player.position.y))).toBe(1);
    expect(npc.followAnchorX).toBe(10.5);
    expect(npc.followAnchorZ).toBe(10.5);
  });

  test('npc queued paths clear on transient step blockers instead of jamming forever', () => {
    const npc = makeNpc(10.5, 10.5);
    npc.pathQueue = [{ x: 11.5, z: 10.5 }];
    const occupiedNextTile = (x: number, z: number) => Math.floor(x) === 11 && Math.floor(z) === 10;

    npc.processAI(() => false, undefined, undefined, occupiedNextTile);

    expect(npc.position.x).toBe(10.5);
    expect(npc.position.y).toBe(10.5);
    expect(npc.pathQueue).toEqual([]);
  });

  test('npc queued paths clear when static collision invalidates the next step', () => {
    const npc = makeNpc(10.5, 10.5);
    npc.pathQueue = [{ x: 11.5, z: 10.5 }];
    const staticBlocked = (x: number, z: number) => Math.floor(x) === 11 && Math.floor(z) === 10;

    npc.processAI(staticBlocked);

    expect(npc.position.x).toBe(10.5);
    expect(npc.position.y).toBe(10.5);
    expect(npc.pathQueue).toEqual([]);
  });

  test('npc combat chase routes around a blocked direct step', () => {
    const npc = makeNpc(10.5, 10.5);
    const player = makePlayer(12.5, 10.5);
    npc.setCombatTarget(player);
    const directStepBlocked = (x: number, z: number) => Math.floor(x) === 11 && Math.floor(z) === 10;

    for (let i = 0; i < 4 && !npc.isInteractionTile(Math.floor(player.position.x), Math.floor(player.position.y)); i++) {
      npc.processAI(directStepBlocked);
      expect(directStepBlocked(npc.position.x, npc.position.y)).toBe(false);
    }

    expect(npc.isInteractionTile(Math.floor(player.position.x), Math.floor(player.position.y))).toBe(true);
  });

  test('npc combat fallback route does not leave max range', () => {
    const def: NpcDef = {
      id: 2,
      name: 'Guard',
      health: 10,
      attack: 1,
      defence: 1,
      strength: 1,
      attackSpeed: 4,
      respawnTime: 10,
      aggressive: false,
      wanderRange: 0,
      maxRange: 3,
      lootTable: [],
    };
    const npc = new Npc(def, 10.5, 10.5);
    const player = makePlayer(14.5, 10.5);
    npc.setCombatTarget(player);
    const wall = (x: number, z: number) => {
      const tileX = Math.floor(x);
      const tileZ = Math.floor(z);
      return tileX >= 11 && tileX <= 13 && tileZ >= 8 && tileZ <= 12;
    };

    for (let i = 0; i < 10; i++) {
      npc.processAI(wall);
      const maxSpawnDistance = Math.max(Math.abs(npc.position.x - npc.spawnX), Math.abs(npc.position.y - npc.spawnZ));
      expect(maxSpawnDistance).toBeLessThanOrEqual(npc.maxRange);
    }
  });
});
