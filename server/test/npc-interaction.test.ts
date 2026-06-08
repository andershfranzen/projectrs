import { describe, expect, test } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { Npc } from '../src/entity/Npc';
import { isPointInNpcMagicAttackRange, processNpcCombat, processPlayerCombat, processPlayerRangedCombat } from '../src/combat/Combat';
import { ServerOpcode, TICK_RATE, decodePacket, getObjectFootprintBounds, type DialogueAction, type DialogueTree, type ItemDef, type NpcDef } from '@projectrs/shared';

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
const AGGRO_TOLERANCE_TEST_TICKS = Math.ceil(10 * 60_000 / TICK_RATE);
const strongAggroNpcDef: NpcDef = {
  ...npcDef,
  aggressive: true,
  wanderRange: 5,
  health: 50,
  attack: 50,
  defence: 50,
  strength: 50,
};
const ROYAL_GUARD_ORE_BANK_ACTION: Extract<DialogueAction, { type: 'bankInventoryItemsForCoins' }> = {
  type: 'bankInventoryItemsForCoins',
  itemIds: [25, 26, 34, 35, 44, 45, 142, 407, 408],
  coinCost: 10,
  coinCostByItemId: { 25: 1, 34: 1, 26: 2, 35: 3, 44: 4, 142: 4, 45: 6, 407: 8, 408: 8 },
  itemLabel: 'ore',
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
  world.dialogueScheduledSteps = [];
  world.playerCombatTargets = new Map();
  world.npcTargetedBy = new Map();
  world.playerAggroTolerance = new Map();
  world.activeDuels = new Map();
  world.chunkManagers = new Map();
  world.blockedObjectTiles = new Set();
  world.entityTileOccupants = new Set();
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
  test('royal guard dialogue banks inventory ore after charging coins', () => {
    const dialogue: DialogueTree = {
      root: 'greet',
      nodes: {
        greet: {
          id: 'greet',
          lines: ['The Sultan wants every vein of ore accounted for.'],
          options: [
            {
              label: 'Export my ore by royal minecart.',
              action: ROYAL_GUARD_ORE_BANK_ACTION,
            },
          ],
        },
      },
    };
    const player = new Player('miner', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, id: 108, name: "Sultan's Royal Guard" }, 10.5, 10.5, {
      effectiveDialogue: dialogue,
      nameOverride: "Sultan's Royal Guard",
    });
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.inventory[0] = { itemId: 10, quantity: 25 };
    player.inventory[1] = { itemId: 25, quantity: 1 };
    player.inventory[2] = { itemId: 26, quantity: 2 };
    player.inventory[3] = { itemId: 35, quantity: 3 };
    player.inventory[4] = { itemId: 23, quantity: 1 };
    player.openDialogueState = {
      sessionId: 123,
      npcEntityId: npc.id,
      nodeId: 'greet',
      visibleOptionIndices: [0],
    };
    const { world } = makeCombatWorld(player, npc);
    const messages: string[] = [];
    let inventorySends = 0;
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);
    world.sendInventory = () => { inventorySends++; };

    world.handleDialogueChoose(player.id, npc.id, 123, 0);

    expect(player.openDialogueState).toBeNull();
    expect(player.inventory[0]).toEqual({ itemId: 10, quantity: 11 });
    expect(player.inventory[1]).toBeNull();
    expect(player.inventory[2]).toBeNull();
    expect(player.inventory[3]).toBeNull();
    expect(player.inventory[4]).toEqual({ itemId: 23, quantity: 1 });
    expect(player.bank.find(slot => slot?.itemId === 25)?.quantity).toBe(1);
    expect(player.bank.find(slot => slot?.itemId === 26)?.quantity).toBe(2);
    expect(player.bank.find(slot => slot?.itemId === 35)?.quantity).toBe(3);
    expect(messages).toEqual(['The royal guard exports 6 ore to your bank through the royal minecart system for 14 coins.']);
    expect(inventorySends).toBe(1);
  });

  test('royal guard ore banking uses tiered fees and does not charge when coins are short', () => {
    const player = new Player('miner_short_coins', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, id: 108, name: "Sultan's Royal Guard" }, 10.5, 10.5);
    const { world } = makeCombatWorld(player, npc);
    const messages: string[] = [];
    let inventorySends = 0;
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);
    world.sendInventory = () => { inventorySends++; };
    player.inventory[0] = { itemId: 10, quantity: 13 };
    player.inventory[1] = { itemId: 25, quantity: 1 };
    player.inventory[2] = { itemId: 26, quantity: 2 };
    player.inventory[3] = { itemId: 35, quantity: 3 };

    world.bankInventoryItemsForCoins(player, ROYAL_GUARD_ORE_BANK_ACTION);

    expect(player.inventory[0]).toEqual({ itemId: 10, quantity: 13 });
    expect(player.inventory[1]).toEqual({ itemId: 25, quantity: 1 });
    expect(player.inventory[2]).toEqual({ itemId: 26, quantity: 2 });
    expect(player.inventory[3]).toEqual({ itemId: 35, quantity: 3 });
    expect(player.bank.some(slot => [25, 26, 35].includes(slot?.itemId ?? -1))).toBe(false);
    expect(messages).toEqual(['You need 14 coins to export that ore through the royal minecart system.']);
    expect(inventorySends).toBe(0);
  });

  test('ore banking keeps fixed-fee behavior when no tier prices are configured', () => {
    const player = new Player('miner_fixed_fee', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, id: 108, name: "Sultan's Royal Guard" }, 10.5, 10.5);
    const { world } = makeCombatWorld(player, npc);
    const messages: string[] = [];
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);
    player.inventory[0] = { itemId: 10, quantity: 25 };
    player.inventory[1] = { itemId: 25, quantity: 1 };
    player.inventory[2] = { itemId: 26, quantity: 2 };

    world.bankInventoryItemsForCoins(player, {
      type: 'bankInventoryItemsForCoins',
      itemIds: [25, 26],
      coinCost: 10,
      itemLabel: 'ore',
    });

    expect(player.inventory[0]).toEqual({ itemId: 10, quantity: 15 });
    expect(player.inventory[1]).toBeNull();
    expect(player.inventory[2]).toBeNull();
    expect(player.bank.find(slot => slot?.itemId === 25)?.quantity).toBe(1);
    expect(player.bank.find(slot => slot?.itemId === 26)?.quantity).toBe(2);
    expect(messages).toEqual(['The royal guard exports 3 ore to your bank through the royal minecart system for 10 coins.']);
  });

  test('royal guard ore banking does not charge when the bank is full', () => {
    const player = new Player('miner_full_bank', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, id: 108, name: "Sultan's Royal Guard" }, 10.5, 10.5);
    const { world } = makeCombatWorld(player, npc);
    const messages: string[] = [];
    let inventorySends = 0;
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);
    world.sendInventory = () => { inventorySends++; };
    player.inventory[0] = { itemId: 10, quantity: 25 };
    player.inventory[1] = { itemId: 25, quantity: 1 };
    for (let i = 0; i < player.bank.length; i++) {
      player.bank[i] = { itemId: 10_000 + i, quantity: 1 };
    }

    world.bankInventoryItemsForCoins(player, ROYAL_GUARD_ORE_BANK_ACTION);

    expect(player.inventory[0]).toEqual({ itemId: 10, quantity: 25 });
    expect(player.inventory[1]).toEqual({ itemId: 25, quantity: 1 });
    expect(player.bank.some(slot => slot?.itemId === 25)).toBe(false);
    expect(messages).toEqual(['Your bank does not have room for that ore.']);
    expect(inventorySends).toBe(0);
  });

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

  test('NPC examine requires current adjacency without queueing movement', () => {
    const player = new Player('tester', 8.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, examineText: 'A guide who knows more than he says.' }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(player, npc);
    const messages: string[] = [];
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);

    world.handlePlayerExamineNpc(player.id, npc.id);

    expect(messages).toEqual(["I can't reach that."]);
    expect(player.hasMoveQueue()).toBe(false);

    player.moveTo(9.5, 10.5);
    messages.length = 0;

    world.handlePlayerExamineNpc(player.id, npc.id);

    expect(messages).toEqual(['A guide who knows more than he says.']);
    expect(player.hasMoveQueue()).toBe(false);
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

  test('dialogue early-start does not use a long route around nearby blockers', () => {
    const blocked = new Set(['9,10']);
    const world = makeWorld();
    world.maps.set('kcmap', {
      width: 32,
      height: 32,
      isBlocked: (x: number, z: number) => blocked.has(`${x},${z}`),
      isTileBlockedOnFloor: (x: number, z: number) => blocked.has(`${x},${z}`),
      isWallBlocked: () => false,
      isWallBlockedOnFloor: () => false,
      getEffectiveHeightOnFloor: () => 0,
      hasProjectileLineOfSight: () => true,
    });
    world.blockedObjectTiles = new Set();

    const player = new Player('tester', 8.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';

    expect(world.findPlayerPathToNpc(player, npc).length).toBeGreaterThan(2);
    expect(world.findPlayerPathToNpcDialogueStart(player, npc)).toBeNull();
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
    expect(world.combatSystem.listRetaliationRequests()[0].earliestTick).toBe(world.currentTick + 1);
    world.finishCombatTick();

    expect(world.playerCombatTargets.has(player.id)).toBe(false);
    expect(player.attackTarget).toBeNull();
    expect(world.combatSystem.listRetaliationRequests()).toHaveLength(1);

    world.currentTick += 1;
    world.finishCombatTick();

    expect(world.playerCombatTargets.get(player.id)).toBe(npc.id);
    expect(player.attackTarget).toBe(npc);
    expect(world.combatSystem.listRetaliationRequests()).toHaveLength(0);
  });

  test('NPC melee auto retaliate does not steal the current walking queue before the delayed hit response', () => {
    const player = new Player('tester', 9.5, 10.5, fakeWs, 1);
    const npc = new Npc(npcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    player.autoRetaliate = true;
    player.setMoveQueue([
      { x: 9.5, z: 11.5 },
      { x: 9.5, z: 12.5 },
    ]);
    npc.setCombatTarget(player);
    const { world } = makeCombatWorld(player, npc);

    withMockedRandom(0, () => world.tickNpcCombat());

    world.finishCombatTick();
    expect(world.playerCombatTargets.has(player.id)).toBe(false);
    expect(player.getMoveDestination()).toEqual({ x: 9.5, z: 12.5 });

    world.currentTick += 1;
    world.finishCombatTick();

    expect(world.playerCombatTargets.has(player.id)).toBe(false);
    expect(player.attackTarget).toBeNull();
    expect(player.getMoveDestination()).toEqual({ x: 9.5, z: 12.5 });
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

  test('aggressive NPCs do not stack multiple proactive chasers on one player', () => {
    const player = new Player('tester', 11.5, 10.5, fakeWs, 1);
    const firstNpc = new Npc(strongAggroNpcDef, 10.5, 10.5);
    const secondNpc = new Npc(strongAggroNpcDef, 12.5, 10.5);
    player.currentMapLevel = 'kcmap';
    firstNpc.currentMapLevel = 'kcmap';
    secondNpc.currentMapLevel = 'kcmap';
    secondNpc.wanderCooldown = 999;
    const { world, broadcasts } = makeCombatWorld(player, firstNpc);
    world.npcs.set(secondNpc.id, secondNpc);
    world.chunkManagers.set('kcmap', {
      forEachPlayerNear: (_x: number, _z: number, fn: (playerId: number) => void) => fn(player.id),
      updateEntity() {},
    });

    world.tickNpcAI();

    expect(firstNpc.combatTarget).toBe(player);
    expect(secondNpc.combatTarget).toBeNull();
  });

  test('closest aggressive NPC wins proactive targeting while losers keep wandering', () => {
    const player = new Player('tester', 11.5, 10.5, fakeWs, 1);
    const fartherNpc = new Npc(strongAggroNpcDef, 16.5, 10.5);
    const closerNpc = new Npc(strongAggroNpcDef, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    fartherNpc.currentMapLevel = 'kcmap';
    closerNpc.currentMapLevel = 'kcmap';
    fartherNpc.pathQueue = [{ x: 15.5, z: 10.5 }];
    const { world } = makeCombatWorld(player, fartherNpc);
    world.npcs.set(closerNpc.id, closerNpc);
    world.chunkManagers.set('kcmap', {
      forEachPlayerNear: (_x: number, _z: number, fn: (playerId: number) => void) => fn(player.id),
      updateEntity() {},
    });

    world.tickNpcAI();

    expect(closerNpc.combatTarget).toBe(player);
    expect(fartherNpc.combatTarget).toBeNull();
    expect(fartherNpc.position.x).toBe(15.5);
    expect(fartherNpc.pathQueue).toEqual([]);
  });

  test('proactive aggro assigns one NPC to one player when several players are nearby', () => {
    const firstPlayer = new Player('first', 11.5, 10.5, fakeWs, 1);
    const secondPlayer = new Player('second', 12.5, 10.5, fakeWs, 1);
    const closestNpc = new Npc(strongAggroNpcDef, 11.5, 10.5);
    const fallbackNpc = new Npc(strongAggroNpcDef, 16.5, 10.5);
    firstPlayer.currentMapLevel = 'kcmap';
    secondPlayer.currentMapLevel = 'kcmap';
    closestNpc.currentMapLevel = 'kcmap';
    fallbackNpc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(firstPlayer, closestNpc);
    world.players.set(secondPlayer.id, secondPlayer);
    world.npcs.set(fallbackNpc.id, fallbackNpc);
    world.chunkManagers.set('kcmap', {
      forEachPlayerNear: (_x: number, _z: number, fn: (playerId: number) => void) => {
        fn(firstPlayer.id);
        fn(secondPlayer.id);
      },
      updateEntity() {},
    });

    world.tickNpcAI();

    expect(closestNpc.combatTarget).toBe(firstPlayer);
    expect(fallbackNpc.combatTarget).toBe(secondPlayer);
  });

  test('duplicate NPC chasers release the same player instead of forming a line', () => {
    const player = new Player('tester', 11.5, 10.5, fakeWs, 1);
    const firstNpc = new Npc(strongAggroNpcDef, 10.5, 10.5);
    const secondNpc = new Npc(strongAggroNpcDef, 13.5, 10.5);
    player.currentMapLevel = 'kcmap';
    firstNpc.currentMapLevel = 'kcmap';
    secondNpc.currentMapLevel = 'kcmap';
    secondNpc.position.x = 20.5;
    firstNpc.setCombatTarget(player);
    secondNpc.setCombatTarget(player);
    const { world, broadcasts } = makeCombatWorld(player, firstNpc);
    world.npcs.set(secondNpc.id, secondNpc);
    world.chunkManagers.set('kcmap', {
      forEachPlayerNear: (_x: number, _z: number, fn: (playerId: number) => void) => fn(player.id),
      updateEntity() {},
    });

    world.tickNpcAI();

    expect(firstNpc.combatTarget).toBe(player);
    expect(secondNpc.combatTarget).toBeNull();
    expect(secondNpc.returning).toBe(true);
    expect(secondNpc.position.x).toBeLessThan(20.5);
    expect(broadcasts.some(b => b.opcode === ServerOpcode.COMBAT_HIT && b.values[0] === secondNpc.id && b.values[1] === -1)).toBe(true);
  });

  test('player active combat target wins the NPC chase slot', () => {
    const player = new Player('tester', 11.5, 10.5, fakeWs, 1);
    const strayNpc = new Npc(strongAggroNpcDef, 10.5, 10.5);
    const activeNpc = new Npc(strongAggroNpcDef, 12.5, 10.5);
    player.currentMapLevel = 'kcmap';
    strayNpc.currentMapLevel = 'kcmap';
    activeNpc.currentMapLevel = 'kcmap';
    strayNpc.setCombatTarget(player);
    activeNpc.setCombatTarget(player);
    const { world } = makeCombatWorld(player, strayNpc);
    world.npcs.set(activeNpc.id, activeNpc);
    world.playerCombatTargets.set(player.id, activeNpc.id);
    world.npcTargetedBy.set(activeNpc.id, new Set([player.id]));
    world.chunkManagers.set('kcmap', {
      forEachPlayerNear: (_x: number, _z: number, fn: (playerId: number) => void) => fn(player.id),
      updateEntity() {},
    });

    world.tickNpcAI();

    expect(strayNpc.combatTarget).toBeNull();
    expect(activeNpc.combatTarget).toBe(player);
    expect(world.playerCombatTargets.get(player.id)).toBe(activeNpc.id);
  });

  test('player active combat target reserves the chase slot before NPC retaliation starts', () => {
    const player = new Player('tester', 11.5, 10.5, fakeWs, 1);
    const strayNpc = new Npc(strongAggroNpcDef, 10.5, 10.5);
    const activeNpc = new Npc(strongAggroNpcDef, 12.5, 10.5);
    player.currentMapLevel = 'kcmap';
    strayNpc.currentMapLevel = 'kcmap';
    activeNpc.currentMapLevel = 'kcmap';
    strayNpc.setCombatTarget(player);
    const { world } = makeCombatWorld(player, strayNpc);
    world.npcs.set(activeNpc.id, activeNpc);
    world.playerCombatTargets.set(player.id, activeNpc.id);
    world.npcTargetedBy.set(activeNpc.id, new Set([player.id]));
    world.chunkManagers.set('kcmap', {
      forEachPlayerNear: (_x: number, _z: number, fn: (playerId: number) => void) => fn(player.id),
      updateEntity() {},
    });

    world.tickNpcAI();

    expect(strayNpc.combatTarget).toBeNull();
    expect(activeNpc.combatTarget).toBe(player);
    expect(world.playerCombatTargets.get(player.id)).toBe(activeNpc.id);
  });

  test('player active combat target does not switch to a closer bystander before retaliation', () => {
    const player = new Player('tester', 12.5, 10.5, fakeWs, 1);
    const bystander = new Player('bystander', 11.5, 10.5, fakeWs, 2);
    const activeNpc = new Npc(strongAggroNpcDef, 11.5, 10.5);
    player.currentMapLevel = 'kcmap';
    bystander.currentMapLevel = 'kcmap';
    activeNpc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(player, activeNpc);
    world.players.set(bystander.id, bystander);
    world.playerCombatTargets.set(player.id, activeNpc.id);
    world.npcTargetedBy.set(activeNpc.id, new Set([player.id]));
    world.chunkManagers.set('kcmap', {
      forEachPlayerNear: (_x: number, _z: number, fn: (playerId: number) => void) => {
        fn(bystander.id);
        fn(player.id);
      },
      updateEntity() {},
    });

    world.tickNpcAI();

    expect(activeNpc.combatTarget).toBe(player);
    expect(world.playerCombatTargets.get(player.id)).toBe(activeNpc.id);
  });

  test('aggressive NPCs stop first-strike targeting after 10 minutes in the same area', () => {
    const player = new Player('tester', 11.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, aggressive: true, wanderRange: 5 }, 10.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(player, npc);
    world.currentTick = AGGRO_TOLERANCE_TEST_TICKS + 1;
    world.playerAggroTolerance.set(player.id, {
      mapLevel: player.currentMapLevel,
      floor: player.currentFloor,
      anchorX: Math.floor(player.position.x),
      anchorZ: Math.floor(player.position.y),
      enteredTick: 1,
    });
    world.chunkManagers.set('kcmap', {
      forEachPlayerNear: (_x: number, _z: number, fn: (playerId: number) => void) => fn(player.id),
      updateEntity() {},
    });

    world.tickNpcAI();

    expect(npc.combatTarget).toBeNull();
  });

  test('moving away resets aggressive NPC first-strike tolerance', () => {
    const player = new Player('tester', 45.5, 10.5, fakeWs, 1);
    const npc = new Npc({ ...npcDef, aggressive: true, wanderRange: 5 }, 44.5, 10.5);
    player.currentMapLevel = 'kcmap';
    npc.currentMapLevel = 'kcmap';
    const { world } = makeCombatWorld(player, npc);
    world.currentTick = AGGRO_TOLERANCE_TEST_TICKS + 1;
    world.playerAggroTolerance.set(player.id, {
      mapLevel: player.currentMapLevel,
      floor: player.currentFloor,
      anchorX: 10,
      anchorZ: 10,
      enteredTick: 1,
    });
    world.chunkManagers.set('kcmap', {
      forEachPlayerNear: (_x: number, _z: number, fn: (playerId: number) => void) => fn(player.id),
      updateEntity() {},
    });

    world.tickNpcAI();

    expect(npc.combatTarget).toBe(player);
    expect(world.playerAggroTolerance.get(player.id)).toMatchObject({
      anchorX: 45,
      anchorZ: 10,
      enteredTick: world.currentTick,
    });
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

  test('NPC combat chase stalls behind another NPC and continues when it clears', () => {
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

    for (let i = 0; i < 4; i++) world.tickNpcAI();

    expect(npc.position.x).toBe(13.5);
    expect(npc.combatTarget).toBe(player);

    blocker.moveTo(20.5, 10.5);
    world.entityTileOccupantsDirty = true;
    world.tickNpcAI();

    expect(npc.position.x).toBe(14.5);
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
