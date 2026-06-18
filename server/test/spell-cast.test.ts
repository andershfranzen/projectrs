import { describe, expect, test } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { Npc } from '../src/entity/Npc';
import { ServerOpcode, type DialogueTree, type ItemDef, type NpcDef, type SpellEffectDef } from '@projectrs/shared';

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

const tokenItemDef: ItemDef = {
  id: 234,
  name: 'Evil token (tier 1)',
  description: 'A token imbued with faint evil energy.',
  stackable: true,
  equippable: false,
  value: 1,
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

const costedSpellDef: SpellEffectDef = {
  ...spellDef,
  reagents: [{ itemId: 234, quantity: 1, name: 'Evil token (tier 1)' }],
};

const levelGatedSpellDef: SpellEffectDef = {
  ...spellDef,
  levelRequired: 10,
};

const nonContinuingSpellDef: SpellEffectDef = {
  ...spellDef,
  continueByAutocast: false,
};

const nonAutocastableSpellDef: SpellEffectDef = {
  ...spellDef,
  autocastable: false,
};

const combatDialogue: DialogueTree = {
  root: 'root',
  nodes: {
    root: {
      id: 'root',
      lines: ['Fight me.'],
      options: [
        {
          label: 'Fight.',
          actions: [{ type: 'startNpcCombat' }],
        },
      ],
    },
  },
};

function makeWorld(player: Player, npc: Npc, spell: SpellEffectDef | undefined): any {
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[player.id, player]]);
  world.npcs = new Map([[npc.id, npc]]);
  world.playerCombatTargets = new Map();
  world.npcTargetedBy = new Map();
  world.chunkManagers = new Map();
  world.pendingSpellImpacts = [];
  world.currentTick = 0;
  world.data = {
    itemDefs: new Map([[tokenItemDef.id, tokenItemDef]]),
    getSpellByIndex: () => spell,
    getShop: () => null,
  };
  world.db = {
    saveStance() {},
    saveMagicCombatState() {},
  };
  world.queuePlayerPathToNpcRange = (p: Player) => {
    p.setMoveQueue([{ x: 10.5, z: 10.5 }]);
    return true;
  };
  world.hasRangedLineOfSightFrom = () => true;
  world.cancelSkilling = () => {};
  world.cancelItemProduction = () => {};
  world.closeShopForPlayer = () => {};
  world.sendDialogueClose = () => {};
  world.broadcastPlayerAnimationEvent = () => {};
  world.broadcastNearby = () => {};
  world.broadcastCombatHit = () => {};
  world.sendChatSystem = () => {};
  world.sendInventory = () => {};
  world.sendToPlayer = () => {};
  world.sendSingleSkill = () => {};
  return world;
}

function countItem(player: Player, itemId: number): number {
  return player.inventory.reduce((total, slot) => total + (slot?.itemId === itemId ? slot.quantity : 0), 0);
}

function tickCombatWorld(world: any): void {
  world.currentTick++;
  world.tickPlayerCooldowns();
  world.tickQueuedSpellCasts();
  world.tickPlayerCombat();
  world.tickPendingSpells();
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
    expect(player.pendingSpellCast).toMatchObject({ spellIndex: 0, targetEntityId: npc.id });
    expect(player.pendingSpellCast?.actionRevision).toBe(player.actionRevision);
  });

  test('out-of-range valid casts preserve a client-sent move queue', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 20.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.setMoveQueue([{ x: 2.5, z: 1.5 }, { x: 3.5, z: 1.5 }]);
    const world = makeWorld(player, npc, spellDef);

    world.handlePlayerCastSpell(player.id, 0, npc.id);

    expect(player.getMoveDestination()).toEqual({ x: 3.5, z: 1.5 });
    expect(player.pendingSpellCast).toMatchObject({ spellIndex: 0, targetEntityId: npc.id });
  });

  test('blocked magic line of sight does not cast or queue an unreachable spell', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, spellDef);
    let pathQueued = false;
    world.hasRangedLineOfSightFrom = () => false;
    world.queuePlayerPathToNpcRange = () => {
      pathQueued = true;
      return false;
    };

    world.handlePlayerCastSpell(player.id, 0, npc.id);

    expect(pathQueued).toBe(true);
    expect(player.pendingSpellCast).toBeNull();
    expect(player.attackCooldown).toBe(0);
    expect(world.pendingSpellImpacts).toHaveLength(0);
  });

  test('stale queued spell casts are dropped after another action revision', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 20.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, spellDef);

    world.handlePlayerCastSpell(player.id, 0, npc.id);
    expect(player.pendingSpellCast).not.toBeNull();

    player.clearMoveQueue();
    player.actionRevision++;
    world.tickQueuedSpellCasts();

    expect(player.pendingSpellCast).toBeNull();
    expect(world.pendingSpellImpacts).toHaveLength(0);
  });

  test('autocast selection rejects non-autocastable spells', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, nonAutocastableSpellDef);

    world.handlePlayerSetAutocast(player.id, 0);

    expect(player.autocastSpellIndex).toBe(-1);
  });

  test('magic stance is stored independently from melee stance', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, spellDef);

    world.handlePlayerSetStance(player.id, 1);
    world.handlePlayerSetMagicStance(player.id, 2);

    expect(player.stance).toBe('aggressive');
    expect(player.magicStance).toBe('defensive');
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
    expect(player.attackCooldown).toBe(5);
    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(world.pendingSpellImpacts).toHaveLength(1);
  });

  test('active autocast walks for magic line of sight instead of casting through blockers', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, spellDef);
    let pathQueued = false;
    world.hasRangedLineOfSightFrom = () => false;
    world.queuePlayerPathToNpcRange = (p: Player) => {
      pathQueued = true;
      p.setMoveQueue([{ x: 2.5, z: 1.5 }]);
      return true;
    };

    world.handlePlayerSetAutocast(player.id, 0);
    world.playerCombatTargets.set(player.id, npc.id);
    world.tickPlayerCombat();

    expect(pathQueued).toBe(true);
    expect(player.hasMoveQueue()).toBe(true);
    expect(player.attackCooldown).toBe(0);
    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(world.pendingSpellImpacts).toHaveLength(0);
  });

  test('active autocast repeats after cooldown while the target remains engaged', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, spellDef);

    world.handlePlayerSetAutocast(player.id, 0);
    world.playerCombatTargets.set(player.id, npc.id);
    world.tickPlayerCombat();

    expect(world.pendingSpellImpacts).toHaveLength(1);

    for (let tick = 1; tick <= 5; tick++) {
      world.currentTick = tick;
      world.tickPlayerCooldowns();
      world.tickPlayerCombat();
    }

    expect(player.autocastSpellIndex).toBe(0);
    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(world.pendingSpellImpacts).toHaveLength(2);
  });

  test('active autocast is not blocked by an unrelated action delay', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, spellDef);

    world.handlePlayerSetAutocast(player.id, 0);
    world.playerCombatTargets.set(player.id, npc.id);
    player.setDelay(world.currentTick, 20);
    world.tickPlayerCombat();

    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(player.attackCooldown).toBe(5);
    expect(world.pendingSpellImpacts).toHaveLength(1);
  });

  test('active autocast keeps casting against an already-engaged visible-set miss', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.visibleEntityIds.add(9999);
    const world = makeWorld(player, npc, spellDef);

    world.handlePlayerSetAutocast(player.id, 0);
    world.playerCombatTargets.set(player.id, npc.id);
    world.tickPlayerCombat();

    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(player.attackCooldown).toBe(5);
    expect(world.pendingSpellImpacts).toHaveLength(1);
  });

  test('manual combat spell casts still respect action delay and visibility', () => {
    const busyPlayer = new Player('busy-caster', 1.5, 1.5, fakeWs, 1);
    const busyNpc = new Npc(npcDef, 3.5, 1.5);
    busyPlayer.currentMapLevel = 'kcmap';
    busyNpc.currentMapLevel = 'kcmap';
    const busyWorld = makeWorld(busyPlayer, busyNpc, spellDef);

    busyPlayer.setDelay(busyWorld.currentTick, 20);
    busyWorld.handlePlayerCastSpell(busyPlayer.id, 0, busyNpc.id);

    expect(busyWorld.pendingSpellImpacts).toHaveLength(0);

    const hiddenPlayer = new Player('hidden-caster', 1.5, 1.5, fakeWs, 1);
    const hiddenNpc = new Npc(npcDef, 3.5, 1.5);
    hiddenPlayer.currentMapLevel = 'kcmap';
    hiddenNpc.currentMapLevel = 'kcmap';
    hiddenPlayer.visibleEntityIds.add(9999);
    const hiddenWorld = makeWorld(hiddenPlayer, hiddenNpc, spellDef);

    hiddenWorld.handlePlayerCastSpell(hiddenPlayer.id, 0, hiddenNpc.id);

    expect(hiddenWorld.pendingSpellImpacts).toHaveLength(0);
  });

  test('attacking an NPC with autocast selected starts repeating spell combat', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, spellDef);

    world.handlePlayerSetAutocast(player.id, 0);
    world.handlePlayerAttackNpc(player.id, npc.id);
    world.tickPlayerCombat();

    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(world.pendingSpellImpacts).toHaveLength(1);

    for (let tick = 1; tick <= 5; tick++) {
      world.currentTick = tick;
      world.tickPlayerCooldowns();
      world.tickPlayerCombat();
    }

    expect(player.autocastSpellIndex).toBe(0);
    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(world.pendingSpellImpacts).toHaveLength(2);
  });

  test('dialogue-started NPC combat can continue with autocast', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5, { effectiveDialogue: combatDialogue });
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, spellDef);

    world.handlePlayerSetAutocast(player.id, 0);
    world.runDialogueAction(player, npc, { type: 'startNpcCombat' });
    world.tickPlayerCombat();

    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(world.pendingSpellImpacts).toHaveLength(1);
  });

  test('combat-start dialogue NPC magic remains blocked until dialogue starts combat without directAttack', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5, { effectiveDialogue: combatDialogue });
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, spellDef);

    world.handlePlayerCastSpell(player.id, 0, npc.id);

    expect(world.pendingSpellImpacts).toHaveLength(0);
    expect(world.playerCombatTargets.has(player.id)).toBe(false);
  });

  test('autocast repeats through the live cooldown and pending-impact tick path', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, health: 100 }, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.skills.evilmagic.level = 10;
    player.skills.evilmagic.currentLevel = 10;
    player.addItem(tokenItemDef.id, 2, new Map([[tokenItemDef.id, tokenItemDef]]));
    const world = makeWorld(player, npc, costedSpellDef);
    const spellCasts: number[] = [];
    world.broadcastNearbyOnFloor = (
      _mapId: string,
      _floor: number,
      _x: number,
      _z: number,
      opcode: ServerOpcode,
      ...values: number[]
    ) => {
      if (opcode === ServerOpcode.SPELL_CAST) spellCasts.push(values[2]);
    };

    world.handlePlayerSetAutocast(player.id, 0);
    world.handlePlayerAttackNpc(player.id, npc.id);
    world.tickPlayerCombat();

    expect(spellCasts).toEqual([0]);
    expect(countItem(player, tokenItemDef.id)).toBe(1);

    for (let i = 0; i < 5; i++) tickCombatWorld(world);

    expect(spellCasts).toEqual([0, 0]);
    expect(countItem(player, tokenItemDef.id)).toBe(0);
    expect(player.autocastSpellIndex).toBe(0);
    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
  });

  test('manual combat spell cast re-arms autocast combat server-side', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, spellDef);

    world.handlePlayerSetAutocast(player.id, 0);
    world.handlePlayerCastSpell(player.id, 0, npc.id);

    expect(player.autocastSpellIndex).toBe(0);
    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(world.pendingSpellImpacts).toHaveLength(1);

    for (let tick = 1; tick <= 5; tick++) {
      world.currentTick = tick;
      world.tickPlayerCooldowns();
      world.tickPlayerCombat();
    }

    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(world.pendingSpellImpacts).toHaveLength(2);
  });

  test('spells can opt out of continuing autocast combat', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, nonContinuingSpellDef);

    world.handlePlayerSetAutocast(player.id, 0);
    world.handlePlayerCastSpell(player.id, 0, npc.id);

    expect(player.autocastSpellIndex).toBe(0);
    expect(world.playerCombatTargets.has(player.id)).toBe(false);
    expect(world.pendingSpellImpacts).toHaveLength(1);
  });

  test('autocast missing reagents throttles retries instead of spamming every combat tick', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, costedSpellDef);
    const messages: string[] = [];
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);

    world.handlePlayerSetAutocast(player.id, 0);
    world.playerCombatTargets.set(player.id, npc.id);
    world.tickPlayerCombat();
    world.tickPlayerCombat();

    expect(player.autocastSpellIndex).toBe(0);
    expect(player.attackCooldown).toBe(4);
    expect(world.pendingSpellImpacts).toHaveLength(0);
    expect(messages).toEqual(['You need 1 Evil token (tier 1) to cast this spell.']);
  });

  test('autocast below the spell level reports the gate and throttles retries', () => {
    const player = new Player('caster', 1.5, 1.5, fakeWs, 1);
    const npc = new Npc(npcDef, 3.5, 1.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const world = makeWorld(player, npc, levelGatedSpellDef);
    const messages: string[] = [];
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);

    world.handlePlayerSetAutocast(player.id, 0);
    world.playerCombatTargets.set(player.id, npc.id);
    world.tickPlayerCombat();
    world.tickPlayerCombat();

    expect(player.autocastSpellIndex).toBe(0);
    expect(player.attackCooldown).toBe(4);
    expect(world.pendingSpellImpacts).toHaveLength(0);
    expect(messages).toEqual(['You need level 10 Evil Magic to cast Test Spell.']);
  });
});
