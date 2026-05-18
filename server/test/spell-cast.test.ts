import { describe, expect, test } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { Npc } from '../src/entity/Npc';
import type { NpcDef, SpellEffectDef } from '@projectrs/shared';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

const npcDef: NpcDef = {
  id: 1,
  name: 'Target',
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

const spellDef: SpellEffectDef = {
  id: 'test_spell',
  name: 'Test Spell',
  element: 'dark',
  tier: 1,
  projectile: {
    shape: 'blast',
    size: 1,
    primaryColor: { r: 1, g: 1, b: 1 },
    secondaryColor: { r: 1, g: 1, b: 1 },
    glowIntensity: 1,
    rotationSpeed: 0,
    texture: 'none',
  },
  trajectory: { type: 'straight', speed: 10, arcHeight: 0, homingCurve: 0 },
  trail: {
    particleType: 'spark',
    density: 0,
    width: 0,
    color: { r: 1, g: 1, b: 1 },
    fadeTime: 0,
    motion: 'straight',
  },
  cast: {
    durationMs: 600,
    burstParticle: 'spark',
    burstCount: 0,
    burstColor: { r: 1, g: 1, b: 1 },
    burstSpread: 0,
    handGlow: false,
    handGlowColor: { r: 1, g: 1, b: 1 },
    handGlowIntensity: 0,
  },
  impact: {
    splashParticle: 'spark',
    splashCount: 0,
    splashSpread: 0,
    splashColor: { r: 1, g: 1, b: 1 },
    groundDecal: 'none',
    lightning: {
      arcCount: 0,
      flickerSpeed: 0,
      jaggedness: 0,
      spread: 0,
      thickness: 0,
      color: { r: 1, g: 1, b: 1 },
      coverage: 0,
      glow: 0,
    },
    lingerEnabled: false,
    lingerDurationMs: 0,
    lingerEmitRate: 0,
    lingerColor: { r: 1, g: 1, b: 1 },
  },
  aoe: false,
  aoeTargetCount: 1,
};

function makeWorld(player: Player, npc: Npc, spell: SpellEffectDef | undefined): any {
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[player.id, player]]);
  world.npcs = new Map([[npc.id, npc]]);
  world.playerCombatTargets = new Map();
  world.npcTargetedBy = new Map();
  world.pendingSpellImpacts = [];
  world.currentTick = 0;
  world.data = {
    itemDefs: new Map(),
    getSpellByIndex: () => spell,
    getShop: () => null,
  };
  world.queuePlayerPathToNpcRange = (p: Player) => {
    p.setMoveQueue([{ x: 10.5, z: 10.5 }]);
    return true;
  };
  world.cancelSkilling = () => {};
  world.broadcastPlayerAnimationEvent = () => {};
  world.broadcastNearby = () => {};
  world.sendInventory = () => {};
  return world;
}

describe('server-authoritative spell casting', () => {
  test('stale spell packets do not cancel server movement', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 20.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.setMoveQueue([{ x: 2.5, z: 1.5 }]);
    const world = makeWorld(player, npc, undefined);

    world.handlePlayerCastSpell(player.id, 999, npc.id);

    expect(player.hasMoveQueue()).toBe(true);
    expect(player.pendingSpellCast).toBeNull();
  });

  test('out-of-range valid casts queue movement and keep the server cast intent', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 20.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, spellDef);

    world.handlePlayerCastSpell(player.id, 0, npc.id);

    expect(player.hasMoveQueue()).toBe(true);
    expect(player.pendingSpellCast).toEqual({ spellIndex: 0, targetEntityId: npc.id });
  });

  test('active autocast is executed by the server combat tick and keeps the target', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, spellDef);

    world.handlePlayerSetAutocast(player.id, 0);
    world.playerCombatTargets.set(player.id, npc.id);
    world.tickPlayerCombat();

    expect(player.autocastSpellIndex).toBe(0);
    expect(player.attackCooldown).toBe(7);
    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(world.pendingSpellImpacts).toHaveLength(1);
  });
});
