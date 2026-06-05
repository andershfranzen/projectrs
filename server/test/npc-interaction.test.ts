import { describe, expect, test } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { Npc } from '../src/entity/Npc';
import { isPointInNpcMagicAttackRange, processNpcCombat, processPlayerCombat, processPlayerRangedCombat } from '../src/combat/Combat';
import { ServerOpcode, decodePacket, getObjectFootprintBounds, type DialogueTree, type ItemDef, type NpcDef } from '@projectrs/shared';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function withMockedRandom<T>(value: number | number[], fn: () => T): T {
  const originalRandom = Math.random;
  const values = Array.isArray(value) ? [...value] : [value];
  Math.random = () => values.shift() ?? values[values.length - 1] ?? (Array.isArray(value) ? 0 : value);
  try {
    return fn();
  } finally {
    Math.random = originalRandom;
  }
}

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

const bowItemDef: ItemDef = {
  id: 1000,
  name: 'Test bow',
  description: '',
  value: 0,
  stackable: false,
  equippable: true,
  equipSlot: 'weapon',
  weaponStyle: 'bow',
  ammoType: 'arrow',
  attackSpeed: 4,
};

const arrowItemDef: ItemDef = {
  id: 1001,
  name: 'Test arrow',
  description: '',
  value: 0,
  stackable: true,
  equippable: true,
  equipSlot: 'ammo',
  isAmmo: true,
  ammoType: 'arrow',
  rangedStrength: 0,
};

function makeWorld(): any {
  const world = Object.create(World.prototype) as any;
  world.maps = new Map([[
    'kcmap',
    {
      isWallBlocked: () => false,
      isWallBlockedOnFloor: () => false,
      findPathOnFloor: (_sx: number, _sz: number, gx: number, gz: number) => [{ x: gx, z: gz }],
      getEffectiveHeightOnFloor: () => 0,
      hasProjectileLineOfSight: () => true,
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
  world.playerTileOccupants = new Set();
  world.entityTileOccupantsDirty = true;
  world.currentTick = 1;
  world.currentTickStartMs = 0;
  world.data = {
    itemDefs: new Map(),
    getItem: (itemId: number) => world.data.itemDefs.get(itemId),
    getSpellByIndex: () => null,
  };
  world.cancelSkilling = () => {};
  world.cancelItemProduction = () => {};
  world.clearPendingObjectIntents = () => {};
  world.closeNpcUiContext = () => {};
  world.quests = { notifyQuestEvent() {} };
  world.creditMobKill = () => {};
  world.spawnNpcLoot = () => {};
  world.markEntityTileOccupantsDirty = () => {};
  world.sendChatSystem = () => {};
  world.sendInventory = () => {};
  world.sendEquipment = () => {};
  world.sendToPlayer = () => {};
  world.sendSingleSkill = () => {};
  world.setPlayerAnimation = () => {};
  world.broadcastPlayerAnimationEvent = () => {};
  world.broadcastRemoteEquipment = () => {};
  world.broadcastCombatHit = () => {};
  world.broadcastProjectile = (attackerId: number, targetId: number, projectileType: number) => {
    broadcasts.push({ opcode: ServerOpcode.COMBAT_PROJECTILE, values: [attackerId, targetId, projectileType] });
  };
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
  world.savePlayerState = () => {};
  return { world, broadcasts };
}

describe('NPC interaction reachability', () => {
  test('stylist dialogue action opens the character creator for existing players', () => {
    const packets: Array<{ opcode: number; values: number[] }> = [];
    const ws = {
      sendBinary(packet: Uint8Array) {
        const exact = packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer;
        packets.push(decodePacket(exact));
      },
      send() {},
    } as any;
    const dialogue: DialogueTree = {
      root: 'greet',
      nodes: {
        greet: {
          id: 'greet',
          lines: ["Hello there! I'm the local stylist."],
          options: [
            {
              label: 'Yes, please change my appearance.',
              action: { type: 'openAppearance' },
            },
          ],
        },
      },
    };
    const player = new Player('tester', 9.5, 10.5, ws, 1);
    const npc = new Npc({ ...npcDef, id: 21, name: 'Bill the Stylist' }, 10.5, 10.5, 0, null, null, null, null, dialogue);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.openDialogueState = {
      sessionId: 123,
      npcEntityId: npc.id,
      nodeId: 'greet',
      visibleOptionIndices: [0],
    };
    const world = makeWorld();
    world.players = new Map([[player.id, player]]);
    world.npcs = new Map([[npc.id, npc]]);
    world.dialogueScheduledSteps = [];
    world.quests = {
      notifyQuestEvent() {},
      dialogueOptionVisible: () => true,
    };

    world.handleDialogueChoose(player.id, npc.id, 123, 0);

    expect(player.openDialogueState).toBeNull();
    expect(player.appearanceEditorOpen).toBe(true);
    expect(packets.map(packet => packet.opcode)).toContain(ServerOpcode.DIALOGUE_CLOSE);
    expect(packets.map(packet => packet.opcode)).toContain(ServerOpcode.SHOW_CHARACTER_CREATOR);
  });

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

  test('mirrored combat intent tracks public weapon and autocast changes', () => {
    const player = new Player('tester', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(player, npc);
    world.data.itemDefs.set(bowItemDef.id, bowItemDef);
    world.data.itemDefs.set(arrowItemDef.id, arrowItemDef);
    const spell = { id: 'test', name: 'Test', tier: 1, autocastable: true };
    world.data.getSpellByIndex = (spellIndex: number) => spellIndex === 3 ? spell : null;

    world.handlePlayerAttackNpc(player.id, npc.id);
    const actor = { kind: 'player', id: player.id };
    expect(world.combatSystem.getIntent(actor)?.mode).toBe('melee');

    player.inventory[0] = { itemId: bowItemDef.id, quantity: 1 };
    world.handlePlayerEquip(player.id, 0, bowItemDef.id);
    expect(world.combatSystem.getIntent(actor)?.mode).toBe('ranged');
    expect(world.combatSystem.getIntent(actor)?.ammoItemId).toBeUndefined();

    player.clearDelay();
    player.inventory[0] = { itemId: arrowItemDef.id, quantity: 10 };
    world.handlePlayerEquip(player.id, 0, arrowItemDef.id);
    expect(world.combatSystem.getIntent(actor)?.ammoItemId).toBe(arrowItemDef.id);

    player.clearDelay();
    world.handlePlayerSetAutocast(player.id, 3);
    expect(world.combatSystem.getIntent(actor)?.mode).toBe('magic');
    expect(world.combatSystem.getIntent(actor)?.spellIndex).toBe(3);
  });

  test('player attack cooldown projects from the combat schedule', () => {
    const player = new Player('tester', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(player, npc);
    const actor = { kind: 'player', id: player.id };

    world.currentTick = 10;
    player.attackCooldown = 4;
    world.tickPlayerCooldowns();
    expect(player.attackCooldown).toBe(3);
    expect(world.combatSystem.getSchedule(actor)).toEqual({ actor, nextAttackTick: 13 });

    player.attackCooldown = 0;
    world.currentTick = 11;
    world.tickPlayerCooldowns();
    expect(player.attackCooldown).toBe(2);
    expect(world.combatSystem.getSchedule(actor)).toEqual({ actor, nextAttackTick: 13 });
  });

  test('NPC attack cooldown projects from the combat schedule', () => {
    const player = new Player('tester', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(player, npc);
    const actor = { kind: 'npc', id: npc.id };

    world.currentTick = 10;
    npc.attackCooldown = 4;
    world.tickNpcCooldowns();
    expect(npc.attackCooldown).toBe(3);
    expect(world.combatSystem.getSchedule(actor)).toEqual({ actor, nextAttackTick: 13 });

    npc.attackCooldown = 0;
    world.currentTick = 11;
    world.tickNpcCooldowns();
    expect(npc.attackCooldown).toBe(2);
    expect(world.combatSystem.getSchedule(actor)).toEqual({ actor, nextAttackTick: 13 });
  });

  test('NPC death clears target-owned queued spell impacts immediately', () => {
    const player = new Player('tester', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(player, npc);

    world.pendingSpellImpacts = [{
      impactTick: world.currentTick + 5,
      attackerId: player.id,
      targetId: npc.id,
      damage: 1,
      spellId: 'test',
      xpSkill: 'evilmagic',
      mapLevel: player.currentMapLevel,
      floor: player.currentFloor,
    }];

    expect(world.pendingSpellImpacts).toHaveLength(1);

    world.finalizeNpcDeath(npc, player);

    expect(npc.dead).toBe(true);
    expect(world.pendingSpellImpacts).toHaveLength(0);
    expect(world.combatSystem.listImpacts()).toHaveLength(0);
  });

  test('PVM combat lock blocks third-party NPC attacks until expiry', () => {
    const first = new Player('first', 9.5, 10.5, fakeWs, 1);
    const second = new Player('second', 9.5, 11.5, fakeWs, 2);
    const npc = new Npc(npcDef, 10.5, 10.5);
    first.currentMapLevel = second.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(first, npc);
    world.players.set(second.id, second);

    world.handlePlayerAttackNpc(first.id, npc.id);
    withMockedRandom(0, () => world.tickPlayerCombat());

    world.handlePlayerAttackNpc(second.id, npc.id);
    expect(world.playerCombatTargets.get(first.id)).toBe(npc.id);
    expect(world.playerCombatTargets.has(second.id)).toBe(false);

    world.currentTick += 8;
    world.tickCombatSchedules();
    world.handlePlayerAttackNpc(second.id, npc.id);

    expect(world.playerCombatTargets.get(second.id)).toBe(npc.id);
  });

  test('NPC melee does not arm player combat when auto retaliate is off', () => {
    const player = new Player('tester', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    npc.setCombatTarget(player);
    const { world } = makeCombatWorld(player, npc);

    withMockedRandom(0, () => world.tickNpcCombat());

    expect(world.playerCombatTargets.has(player.id)).toBe(false);
  });

  test('NPC melee arms player combat when auto retaliate is on', () => {
    const player = new Player('tester', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.autoRetaliate = true;
    npc.setCombatTarget(player);
    const { world } = makeCombatWorld(player, npc);

    withMockedRandom(0, () => world.tickNpcCombat());

    expect(world.combatSystem.listRetaliationRequests()).toHaveLength(1);
    world.finishCombatTick();

    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(player.attackTarget).toBe(npc);
    expect(world.combatSystem.listRetaliationRequests()).toHaveLength(0);
  });

  test('ranged attack trims an existing client path to the first in-range tile', () => {
    const player = new Player('archer', 1.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.setEquipment('weapon', bowItemDef.id);
    player.setMoveQueue([
      { x: 2.5, z: 10.5 },
      { x: 3.5, z: 10.5 },
      { x: 4.5, z: 10.5 },
      { x: 9.5, z: 10.5 },
    ]);
    const { world } = makeCombatWorld(player, npc);
    world.data.itemDefs.set(bowItemDef.id, bowItemDef);

    world.handlePlayerAttackNpc(player.id, npc.id);

    expect(player.getMoveDestination()).toEqual({ x: 3.5, z: 10.5 });
  });

  test('ranged attack keeps walking when the first in-range tile has no clear shot', () => {
    const player = new Player('archer', 1.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.setEquipment('weapon', bowItemDef.id);
    player.setMoveQueue([
      { x: 2.5, z: 10.5 },
      { x: 3.5, z: 10.5 },
      { x: 4.5, z: 10.5 },
      { x: 9.5, z: 10.5 },
    ]);
    const { world } = makeCombatWorld(player, npc);
    world.data.itemDefs.set(bowItemDef.id, bowItemDef);
    world.maps.get('kcmap').hasProjectileLineOfSight = (fromX: number) => fromX >= 9;

    world.handlePlayerAttackNpc(player.id, npc.id);

    expect(player.getMoveDestination()).toEqual({ x: 9.5, z: 10.5 });
  });

  test('active ranged combat queue is not trimmed every combat tick', () => {
    const player = new Player('archer', 1.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.setEquipment('weapon', bowItemDef.id);
    player.setMoveQueue([
      { x: 2.5, z: 10.5 },
      { x: 3.5, z: 10.5 },
      { x: 9.5, z: 10.5 },
    ]);
    const { world } = makeCombatWorld(player, npc);
    world.data.itemDefs.set(bowItemDef.id, bowItemDef);
    world.playerCombatTargets.set(player.id, npc.id);
    world.npcTargetedBy.set(npc.id, new Set([player.id]));
    world.maps.get('kcmap').hasProjectileLineOfSight = (fromX: number) => fromX >= 3;

    world.tickPlayerCombat();

    expect(player.getMoveDestination()).toEqual({ x: 9.5, z: 10.5 });
  });

  test('ranged combat does not consume ammo or fire through blocked line of sight', () => {
    const player = new Player('archer', 10.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 12.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.setEquipment('weapon', bowItemDef.id);
    player.setEquipment('ammo', arrowItemDef.id, 5);
    const { world, broadcasts } = makeCombatWorld(player, npc);
    world.data.itemDefs.set(bowItemDef.id, bowItemDef);
    world.data.itemDefs.set(arrowItemDef.id, arrowItemDef);
    world.playerCombatTargets.set(player.id, npc.id);
    world.npcTargetedBy.set(npc.id, new Set([player.id]));
    world.maps.get('kcmap').hasProjectileLineOfSight = () => false;

    world.tickPlayerCombat();

    expect(broadcasts.some(b => b.opcode === ServerOpcode.COMBAT_PROJECTILE)).toBe(false);
    expect(player.getEquipmentQuantity('ammo')).toBe(5);
    expect(npc.health).toBe(npc.maxHealth);
  });

  test('empty movement packet cancels active NPC combat', () => {
    const player = new Player('tester', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(player, npc);

    world.handlePlayerAttackNpc(player.id, npc.id);
    expect(player.attackTarget).toBe(npc);
    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);

    world.handlePlayerMove(player.id, []);

    expect(player.attackTarget).toBeNull();
    expect(world.playerCombatTargets.has(player.id)).toBe(false);
    expect(world.npcTargetedBy.has(npc.id)).toBe(false);
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

  test('aggressive NPCs use wander plus two as their default hunt and max range', () => {
    const player = new Player('tester', 17.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, aggressive: true, wanderRange: 5, health: 50, attack: 50, defence: 50, strength: 50 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.skills.weaponry.level = 99;
    player.skills.strength.level = 99;
    player.skills.defence.level = 99;
    player.skills.hitpoints.level = 99;
    const { world } = makeCombatWorld(player, npc);
    world.chunkManagers.set('kcmap', {
      forEachPlayerNear: (_x: number, _z: number, fn: (playerId: number) => void) => fn(player.id),
      updateEntity() {},
    });

    world.tickNpcAI();

    expect(npc.maxRange).toBe(7);
    expect(npc.aggroRange).toBe(7);
    expect(npc.combatTarget).toBe(player);
  });

  test('aggressive NPCs keep returning instead of reacquiring players outside max range', () => {
    const player = new Player('tester', 19.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, aggressive: true, wanderRange: 5 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    npc.position.x = 16.5;
    npc.returning = true;
    const { world } = makeCombatWorld(player, npc);
    world.chunkManagers.set('kcmap', {
      forEachPlayerNear: (_x: number, _z: number, fn: (playerId: number) => void) => fn(player.id),
      updateEntity() {},
    });

    world.tickNpcAI();

    expect(npc.combatTarget).toBeNull();
    expect(npc.returning).toBe(true);
    expect(npc.position.x).toBeLessThan(16.5);
  });

  test('NPCs return when their combat target leaves max range', () => {
    const player = new Player('tester', 17.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, aggressive: true, wanderRange: 5 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    npc.combatTarget = player;
    const { world } = makeCombatWorld(player, npc);

    player.position.x = 19.5;
    world.tickNpcAI();

    expect(npc.combatTarget).toBeNull();
    expect(npc.returning).toBe(true);
  });

  test('aggressive NPCs ignore players outside default hunt range', () => {
    const player = new Player('tester', 18.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, aggressive: true, wanderRange: 5, health: 50, attack: 50, defence: 50, strength: 50 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(player, npc);
    world.chunkManagers.set('kcmap', {
      forEachPlayerNear: (_x: number, _z: number, fn: (playerId: number) => void) => fn(player.id),
      updateEntity() {},
    });

    world.tickNpcAI();

    expect(npc.aggroRange).toBe(7);
    expect(npc.combatTarget).toBeNull();
  });

  test('NPC combat chase can step beyond idle wander range', () => {
    const player = new Player('tester', 17.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, wanderRange: 5 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    npc.combatTarget = player;
    const { world } = makeCombatWorld(player, npc);
    world.playerCombatTargets.set(player.id, npc.id);
    world.npcTargetedBy.set(npc.id, new Set([player.id]));

    for (let i = 0; i < 6; i++) world.tickNpcAI();

    expect(Math.abs(npc.position.x - npc.spawnX)).toBeGreaterThan(npc.wanderRange);
    expect(Math.abs(npc.position.x - npc.spawnX)).toBeLessThanOrEqual(npc.combatFollowRange);
    expect(npc.combatTarget).toBe(player);
    expect(npc.returning).toBe(false);
  });

  test('NPC combat chase keeps moving until it reaches a cardinal interaction tile', () => {
    const player = new Player('tester', 9.5, 9.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, wanderRange: 5 }, 10.5, 10.5);
    npc.combatTarget = player;

    npc.processAI((x, z) => Math.floor(x) === 9 && Math.floor(z) === 9);

    expect(npc.isInteractionTile(Math.floor(player.position.x), Math.floor(player.position.y))).toBe(true);
    expect(npc.position.x === 9.5 || npc.position.y === 9.5).toBe(true);
  });

  test('large NPC combat chase steps out when the target is inside its footprint', () => {
    const player = new Player('tester', 10.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, size: 2, wanderRange: 5 }, 10.5, 10.5);
    npc.combatTarget = player;

    npc.processAI(() => false);

    expect(npc.position.x).toBe(10.5);
    expect(npc.position.y).toBe(10.5);
    expect(npc.isFootprintTile(10, 10)).toBe(true);

    npc.processAI(() => false);

    expect(npc.position.x).toBe(10.5);
    expect(npc.position.y).toBe(10.5);
    expect(npc.isFootprintTile(10, 10)).toBe(true);

    npc.processAI(() => false);

    expect(npc.position.x === 9.5 || npc.position.y === 9.5).toBe(true);
    expect(npc.isInteractionTile(Math.floor(player.position.x), Math.floor(player.position.y))).toBe(true);
  });

  test('larger NPCs keep stepping out until an overlapped target reaches the melee perimeter', () => {
    const player = new Player('tester', 10.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, size: 5, wanderRange: 8 }, 10.5, 10.5);
    npc.combatTarget = player;

    for (let i = 0; i < 5 && !npc.isInteractionTile(10, 10); i++) {
      npc.processAI(() => false);
    }

    expect(npc.isFootprintTile(10, 10)).toBe(false);
    expect(npc.isInteractionTile(10, 10)).toBe(true);
  });

  test('large NPC overlap escape tries another side when the closest exit is blocked', () => {
    const player = new Player('tester', 10.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, size: 2, wanderRange: 5 }, 10.5, 10.5);
    npc.combatTarget = player;

    npc.processAI((x, z) => x === 9.5 && z === 10.5);
    expect(npc.position.x).toBe(10.5);
    expect(npc.position.y).toBe(10.5);

    npc.processAI((x, z) => x === 9.5 && z === 10.5);
    expect(npc.position.x).toBe(10.5);
    expect(npc.position.y).toBe(10.5);

    npc.processAI((x, z) => x === 9.5 && z === 10.5);

    expect(npc.position.x).toBe(10.5);
    expect(npc.position.y).toBe(9.5);
    expect(npc.isInteractionTile(10, 10)).toBe(true);
  });

  test('size-one NPC combat chase steps off an overlapped player when an adjacent tile is available', () => {
    const player = new Player('tester', 10.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, wanderRange: 5 }, 10.5, 10.5);
    npc.combatTarget = player;

    npc.processAI(() => false);

    expect(npc.position.x).toBe(11.5);
    expect(npc.position.y).toBe(10.5);
    expect(npc.isInteractionTile(10, 10)).toBe(true);
  });

  test('size-one NPC overlap escape only stalls when every adjacent tile is blocked', () => {
    const player = new Player('tester', 10.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, wanderRange: 5 }, 10.5, 10.5);
    npc.combatTarget = player;

    npc.processAI((x, z) => Math.max(Math.abs(x - 10.5), Math.abs(z - 10.5)) === 1);

    expect(npc.position.x).toBe(10.5);
    expect(npc.position.y).toBe(10.5);
    expect(npc.isFootprintTile(10, 10)).toBe(true);
    expect(npc.isInteractionTile(10, 10)).toBe(false);
  });

  test('world NPC movement can escape a player standing inside its current footprint', () => {
    const player = new Player('tester', 10.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, size: 2, wanderRange: 5 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    npc.combatTarget = player;
    const { world } = makeCombatWorld(player, npc);

    world.rebuildEntityTileOccupants();
    world.tickNpcAI();

    expect(npc.position.x).toBe(10.5);
    expect(npc.position.y).toBe(10.5);
    expect(npc.isFootprintTile(10, 10)).toBe(true);

    world.tickNpcAI();

    expect(npc.position.x).toBe(10.5);
    expect(npc.position.y).toBe(10.5);
    expect(npc.isFootprintTile(10, 10)).toBe(true);

    world.tickNpcAI();

    expect(npc.isInteractionTile(10, 10)).toBe(true);
    expect(npc.position.x === 9.5 || npc.position.y === 9.5).toBe(true);
  });

  test('world NPC movement can escape a same-tile player for ordinary mobs', () => {
    const player = new Player('tester', 10.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, wanderRange: 5 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    npc.combatTarget = player;
    const { world } = makeCombatWorld(player, npc);

    world.rebuildEntityTileOccupants();
    world.tickNpcAI();

    expect(npc.isInteractionTile(10, 10)).toBe(true);
    expect(npc.position.x).not.toBe(10.5);
    expect(npc.position.y).toBe(10.5);
  });

  test('melee combat requires a cardinal NPC interaction tile', () => {
    const diagonal = new Player('diagonal', 9.5, 9.5, fakeWs, 1);
    const cardinal = new Player('cardinal', 9.5, 10.5, fakeWs, 2);
    const npc = new Npc(npcDef, 10.5, 10.5);

    expect(processPlayerCombat(diagonal, npc, new Map())).toBeNull();
    expect(processPlayerCombat(cardinal, npc, new Map())).not.toBeNull();
  });

  test('NPC melee combat requires a cardinal NPC interaction tile', () => {
    const diagonal = new Player('diagonal', 9.5, 9.5, fakeWs, 1);
    const cardinal = new Player('cardinal', 9.5, 10.5, fakeWs, 2);

    expect(processNpcCombat(new Npc(npcDef, 10.5, 10.5), diagonal, new Map())).toBeNull();
    expect(processNpcCombat(new Npc(npcDef, 10.5, 10.5), cardinal, new Map())).not.toBeNull();
  });

  test('NPC melee combat cannot hit through a wall edge', () => {
    const player = new Player('tester', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    npc.setCombatTarget(player);
    npc.attackCooldown = 0;
    const { world, broadcasts } = makeCombatWorld(player, npc);
    world.maps.get('kcmap').isWallBlocked = () => true;
    world.broadcastCombatHit = (attackerId: number, targetId: number, damage: number) => {
      broadcasts.push({ opcode: ServerOpcode.COMBAT_HIT, values: [attackerId, targetId, damage] });
    };

    world.tickNpcCombat();

    expect(broadcasts.some(b => b.opcode === ServerOpcode.COMBAT_HIT)).toBe(false);
    expect(npc.attackCooldown).toBe(0);
  });

  test('ranged combat uses Chebyshev distance to the NPC footprint', () => {
    const player = new Player('archer', 17.5, 17.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    const world = makeWorld();

    expect(world.isPlayerInNpcAttackRange(player, npc, 'ranged')).toBe(true);
    expect(processPlayerRangedCombat(player, npc, new Map())).not.toBeNull();
  });

  test('ranged and magic combat cannot attack from inside an NPC footprint', () => {
    const player = new Player('archer', 10.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    const world = makeWorld();
    player.setEquipment('weapon', bowItemDef.id);
    const itemDefs = new Map<number, ItemDef>([[bowItemDef.id, bowItemDef]]);

    expect(npc.isFootprintTile(Math.floor(player.position.x), Math.floor(player.position.y))).toBe(true);
    expect(world.isPlayerInNpcAttackRange(player, npc, 'ranged')).toBe(false);
    expect(isPointInNpcMagicAttackRange(npc, player.position.x, player.position.y)).toBe(false);
    expect(processPlayerRangedCombat(player, npc, itemDefs)).toBeNull();
    expect(player.attackCooldown).toBe(0);
  });

  test('server ranged combat does not fire while the player overlaps the NPC', () => {
    const player = new Player('archer', 10.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.setEquipment('weapon', bowItemDef.id);
    player.setEquipment('ammo', arrowItemDef.id, 5);
    const { world, broadcasts } = makeCombatWorld(player, npc);
    world.data.itemDefs.set(bowItemDef.id, bowItemDef);
    world.data.itemDefs.set(arrowItemDef.id, arrowItemDef);
    world.playerCombatTargets.set(player.id, npc.id);
    world.npcTargetedBy.set(npc.id, new Set([player.id]));

    world.tickPlayerCombat();

    expect(broadcasts.some(b => b.opcode === ServerOpcode.COMBAT_PROJECTILE)).toBe(false);
    expect(player.attackCooldown).toBe(0);
    expect(player.getEquipmentQuantity('ammo')).toBe(5);
    expect(npc.health).toBe(npc.maxHealth);
  });

  test('ranged combat respects weapon attackRange metadata', () => {
    const defaultRangePlayer = new Player('archer', 20.5, 10.5, fakeWs, 1);
    const defaultRangeNpc = new Npc(npcDef, 10.5, 10.5);
    defaultRangePlayer.setEquipment('weapon', bowItemDef.id);
    const defaultRangeDefs = new Map<number, ItemDef>([[bowItemDef.id, bowItemDef]]);

    expect(processPlayerRangedCombat(defaultRangePlayer, defaultRangeNpc, defaultRangeDefs)).toBeNull();

    const longRangePlayer = new Player('archer', 20.5, 10.5, fakeWs, 1);
    const longRangeNpc = new Npc(npcDef, 10.5, 10.5);
    longRangePlayer.setEquipment('weapon', bowItemDef.id);
    const longRangeDefs = new Map<number, ItemDef>([[bowItemDef.id, { ...bowItemDef, attackRange: 10 }]]);

    expect(processPlayerRangedCombat(longRangePlayer, longRangeNpc, longRangeDefs)).not.toBeNull();
  });

  test('ranged projectile broadcasts include source target and timing metadata', () => {
    const player = new Player('archer', 12.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.effectiveY = 0;
    const world = makeWorld();
    const packet: { current: { opcode: ServerOpcode; values: number[] } | null } = { current: null };
    world.broadcastNearbyOnFloor = (_map: string, _floor: number, _x: number, _z: number, opcode: ServerOpcode, ...values: number[]) => {
      packet.current = { opcode, values };
    };

    world.broadcastProjectile(player, npc, 1, 'kcmap', 0);

    const sent = packet.current;
    expect(sent).not.toBeNull();
    if (!sent) throw new Error('expected projectile packet');
    expect(sent.opcode).toBe(ServerOpcode.COMBAT_PROJECTILE);
    expect(sent.values.length).toBe(11);
    expect(sent.values.slice(0, 7)).toEqual([player.id, npc.id, 1, 125, 105, 105, 105]);
    expect(sent.values[7]).toBe(14);
    expect(sent.values[8]).toBe(10);
    expect(sent.values[9]).toBeGreaterThan(0);
    expect(sent.values[10]).toBeGreaterThan(0);
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

  test('NPC leash disengages even when the target is currently adjacent', () => {
    const player = new Player('tester', 20.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    npc.position.x = 19.5;
    npc.position.y = 10.5;
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

  test('ranged attacks outside wander range but inside maxrange edge can make the NPC retaliate', () => {
    const player = new Player('archer', 16.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, wanderRange: 3 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.setEquipment('weapon', bowItemDef.id);
    player.setEquipment('ammo', arrowItemDef.id, 5);
    const { world, broadcasts } = makeCombatWorld(player, npc);
    world.data.itemDefs.set(bowItemDef.id, bowItemDef);
    world.data.itemDefs.set(arrowItemDef.id, arrowItemDef);
    world.playerCombatTargets.set(player.id, npc.id);
    world.npcTargetedBy.set(npc.id, new Set([player.id]));

    withMockedRandom([0.99, 0, 0, 0.199], () => world.tickPlayerCombat());
    world.finishCombatTick();

    expect(player.attackCooldown).toBe(4);
    expect(player.getEquipmentQuantity('ammo')).toBe(4);
    expect(npc.combatTarget).toBe(player);
    expect(npc.returning).toBe(false);
    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(broadcasts.some(b => b.opcode === ServerOpcode.COMBAT_PROJECTILE)).toBe(true);
    expect(broadcasts.some(b => b.opcode === ServerOpcode.NPC_FACING)).toBe(true);
  });

  test('ranged retaliation chase moves beyond idle wander range', () => {
    const player = new Player('archer', 16.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, wanderRange: 3 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.setEquipment('weapon', bowItemDef.id);
    player.setEquipment('ammo', arrowItemDef.id, 5);
    const { world } = makeCombatWorld(player, npc);
    world.data.itemDefs.set(bowItemDef.id, bowItemDef);
    world.data.itemDefs.set(arrowItemDef.id, arrowItemDef);
    world.playerCombatTargets.set(player.id, npc.id);
    world.npcTargetedBy.set(npc.id, new Set([player.id]));

    world.tickPlayerCombat();
    world.finishCombatTick();
    for (let i = 0; i < 5; i++) world.tickNpcAI();

    expect(Math.abs(npc.position.x - npc.spawnX)).toBeGreaterThan(npc.wanderRange);
    expect(Math.abs(npc.position.x - npc.spawnX)).toBeLessThanOrEqual(npc.combatFollowRange);
    expect(npc.combatTarget).toBe(player);
    expect(npc.retreatTarget).toBeNull();
  });

  test('NPC combat chase is not pinned by another NPC on the next step', () => {
    const player = new Player('archer', 16.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, wanderRange: 3 }, 10.5, 10.5);
    const blocker = new Npc({ ...npcDef, wanderRange: 0 }, 14.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    blocker.currentMapLevel = 'kcmap';
    npc.combatTarget = player;
    const { world } = makeCombatWorld(player, npc);
    world.npcs.set(blocker.id, blocker);
    world.entityTileOccupants = new Set([
      world.entityTileKeyFor('kcmap', blocker.position.x, blocker.position.y, blocker.currentFloor),
    ]);
    world.playerTileOccupants = new Set();

    for (let i = 0; i < 4; i++) world.tickNpcAI();

    expect(npc.position.x).toBe(14.5);
    expect(Math.abs(npc.position.x - npc.spawnX)).toBeGreaterThan(npc.wanderRange);
    expect(npc.combatTarget).toBe(player);
  });

  test('ranged attacks outside maxrange edge can hit and make the NPC retreat for a long time', () => {
    const player = new Player('archer', 17.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, wanderRange: 2 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.setEquipment('weapon', bowItemDef.id);
    player.setEquipment('ammo', arrowItemDef.id, 5);
    const { world, broadcasts } = makeCombatWorld(player, npc);
    world.data.itemDefs.set(bowItemDef.id, bowItemDef);
    world.data.itemDefs.set(arrowItemDef.id, arrowItemDef);
    world.playerCombatTargets.set(player.id, npc.id);
    world.npcTargetedBy.set(npc.id, new Set([player.id]));

    withMockedRandom(0.199, () => world.tickPlayerCombat());

    expect(player.attackCooldown).toBe(4);
    expect(player.getEquipmentQuantity('ammo')).toBe(4);
    expect(npc.combatTarget).toBeNull();
    expect(npc.retreatTarget).toBe(player);
    expect(npc.returning).toBe(false);
    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(broadcasts.some(b => b.opcode === ServerOpcode.COMBAT_PROJECTILE)).toBe(true);
    expect(broadcasts.some(b => b.opcode === ServerOpcode.NPC_FACING)).toBe(false);

    for (let i = 0; i < 8; i++) world.tickNpcAI();

    expect(npc.position.x).toBeLessThan(npc.spawnX);
    expect(npc.retreatTarget).toBe(player);
    expect(npc.returning).toBe(false);
  });

  test('NPC sync exposes retreat target so clients can render backpedal facing', () => {
    const player = new Player('archer', 17.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, wanderRange: 2 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    npc.startRetreatFromTarget(player);
    const { world } = makeCombatWorld(player, npc);
    world.npcWorldY = () => 0;

    const packet = world.encodeNpcUpdate(npc);
    const decoded = decodePacket(packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer);

    expect(decoded.opcode).toBe(ServerOpcode.NPC_SYNC);
    expect(decoded.values[10]).toBe(player.id);
  });

  test('NPC sync combat level uses effective spawn stat overrides', () => {
    const player = new Player('fighter', 17.5, 10.5, fakeWs, 1);
    const npc = new Npc(
      { ...npcDef, wanderRange: 2 },
      10.5,
      10.5,
      { statsOverride: { health: 40, attack: 20, defence: 10, strength: 30 } },
    );
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(player, npc);
    world.npcWorldY = () => 0;

    const packet = world.encodeNpcUpdate(npc);
    const decoded = decodePacket(packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer);

    expect(decoded.opcode).toBe(ServerOpcode.NPC_SYNC);
    expect(decoded.values[11]).toBe(npc.combatLevel);
    expect(decoded.values[11]).toBe(28);
  });

  test('NPC sync includes per-spawn visual scale', () => {
    const player = new Player('scout', 17.5, 10.5, fakeWs, 1);
    const npc = new Npc(
      npcDef,
      10.5,
      10.5,
      { visualScale: 2.75 },
    );
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(player, npc);
    world.npcWorldY = () => 0;

    const packet = world.encodeNpcUpdate(npc);
    const decoded = decodePacket(packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer);

    expect(decoded.opcode).toBe(ServerOpcode.NPC_SYNC);
    expect(decoded.values[12]).toBe(275);
  });

  test('NPC sync keeps walk hint while adjacent combat target is still moving away', () => {
    const player = new Player('runner', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, wanderRange: 2 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    npc.setCombatTarget(player);
    player.setMoveQueue([{ x: 8.5, z: 10.5 }]);
    const { world } = makeCombatWorld(player, npc);
    world.npcWorldY = () => 0;

    const packet = world.encodeNpcUpdate(npc);
    const decoded = decodePacket(packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer);
    expect(decoded.values[8]).toBe(1);

    player.clearMoveQueue();
    const stoppedPacket = world.encodeNpcUpdate(npc);
    const stoppedDecoded = decodePacket(stoppedPacket.buffer.slice(stoppedPacket.byteOffset, stoppedPacket.byteOffset + stoppedPacket.byteLength) as ArrayBuffer);
    expect(stoppedDecoded.values[8]).toBe(0);
  });

  test('ranged attacks inside maxrange interrupt retreat and make the NPC retaliate', () => {
    const player = new Player('archer', 17.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, wanderRange: 2 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.setEquipment('weapon', bowItemDef.id);
    player.setEquipment('ammo', arrowItemDef.id, 5);
    const { world } = makeCombatWorld(player, npc);
    world.data.itemDefs.set(bowItemDef.id, bowItemDef);
    world.data.itemDefs.set(arrowItemDef.id, arrowItemDef);
    world.playerCombatTargets.set(player.id, npc.id);
    world.npcTargetedBy.set(npc.id, new Set([player.id]));

    withMockedRandom([0.99, 0, 0, 0.199], () => world.tickPlayerCombat());
    world.finishCombatTick();
    player.attackCooldown = 0;
    player.position.x = 14.5;

    world.tickPlayerCombat();
    world.finishCombatTick();

    expect(npc.retreatTarget).toBeNull();
    expect(npc.combatTarget).toBe(player);
  });

  test('low-health NPCs use playerescape retreat instead of retaliating', () => {
    const player = new Player('archer', 16.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, wanderRange: 3, health: 10, retreatHealth: 10 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.setEquipment('weapon', bowItemDef.id);
    player.setEquipment('ammo', arrowItemDef.id, 5);
    const { world, broadcasts } = makeCombatWorld(player, npc);
    world.data.itemDefs.set(bowItemDef.id, bowItemDef);
    world.data.itemDefs.set(arrowItemDef.id, arrowItemDef);
    world.playerCombatTargets.set(player.id, npc.id);
    world.npcTargetedBy.set(npc.id, new Set([player.id]));

    world.tickPlayerCombat();

    expect(npc.combatTarget).toBeNull();
    expect(npc.retreatTarget).toBe(player);
    expect(npc.returning).toBe(false);
    expect(broadcasts.some(b => b.opcode === ServerOpcode.NPC_FACING)).toBe(false);

    world.tickNpcAI();

    expect(npc.position.x).toBeLessThan(npc.spawnX);
    expect(npc.position.y).toBeLessThan(npc.spawnZ);
  });

  test('NPC melee retaliation uses the full NPC footprint for larger mobs', () => {
    for (const size of [2, 3, 4, 5]) {
      const largeNpcDef: NpcDef = { ...npcDef, size };
      const interactionTiles = new Npc(largeNpcDef, 10.5, 10.5).interactionTiles();

      for (const tile of interactionTiles) {
        const player = new Player(`cardinal-${size}-${tile.x}-${tile.z}`, tile.x + 0.5, tile.z + 0.5, fakeWs, 1);
        expect(processNpcCombat(new Npc(largeNpcDef, 10.5, 10.5), player, new Map())).not.toBeNull();
      }

      const { minX, minZ } = getObjectFootprintBounds(10.5, 10.5, size);
      const corner = new Player(`corner-${size}`, minX - 0.5, minZ - 0.5, fakeWs, 2);
      expect(processNpcCombat(new Npc(largeNpcDef, 10.5, 10.5), corner, new Map())).toBeNull();
    }
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
