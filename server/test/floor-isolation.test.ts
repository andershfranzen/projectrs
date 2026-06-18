import { describe, expect, test } from 'bun:test';
import { ServerOpcode, WallEdge, type ItemDef, type NpcDef, type WorldObjectDef } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { Npc } from '../src/entity/Npc';
import { WorldObject } from '../src/entity/WorldObject';
import { GameMap } from '../src/GameMap';

const fakeWs = {
  sendBinary() {},
  send() {},
  close() {},
} as any;

const itemDef: ItemDef = {
  id: 10,
  name: 'Coin',
  description: 'Coin',
  stackable: true,
  equippable: false,
  value: 1,
};

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

const objectDef: WorldObjectDef = {
  id: 50,
  name: 'Crate',
  actions: ['Search'],
  width: 1,
  height: 1,
  blocking: true,
  category: 'chest',
  color: [1, 1, 1],
};

const tableDef: WorldObjectDef = {
  id: 45,
  name: 'Table',
  actions: ['Examine'],
  width: 1,
  height: 1,
  blocking: false,
  category: 'scenery',
  color: [1, 1, 1],
};

const ladderDef: WorldObjectDef = {
  id: 51,
  name: 'Ladder',
  actions: ['Climb-up', 'Climb-down', 'Examine'],
  width: 1,
  height: 2,
  blocking: false,
  category: 'ladder',
  color: [1, 1, 1],
};

const doorDef: WorldObjectDef = {
  id: 52,
  name: 'Door',
  actions: ['Open', 'Examine'],
  width: 1,
  height: 2,
  blocking: false,
  category: 'door',
  color: [1, 1, 1],
};

const noopDb = {
  savePlayerState() {},
  savePlayerPositionsBatch() {},
  applyObjectRespawnWritesBatch() {},
};

function makePlayer(name: string, accountId: number, floor = 0): Player {
  const player = new Player(name, 5.5, 5.5, fakeWs, accountId);
  player.currentMapLevel = 'kcmap';
  player.currentFloor = floor;
  return player;
}

function makeGroundItem(id: number, x: number, z: number, floor = 0): any {
  return {
    id,
    itemId: itemDef.id,
    quantity: 7,
    x,
    z,
    floor,
    mapLevel: 'kcmap',
    despawnTimer: -1,
  };
}

function makeWorld(): any {
  const packets = new Map<number, Array<{ opcode: ServerOpcode; values: number[] }>>();
  const world = Object.create(World.prototype) as any;
  world.db = noopDb;
  world.players = new Map();
  world.npcs = new Map();
  world.groundItems = new Map();
  world.despawningItemIds = new Set();
  world.worldObjects = new Map();
  world.chunkManagers = new Map();
  world.playerCombatTargets = new Map();
  world.npcTargetedBy = new Map();
  world.pendingTradeRequests = new Map();
  world.pendingDuelRequests = new Map();
  world.tradeSessions = new Map();
  world.duelStakeSessions = new Map();
  world.activeDuels = new Map();
  world.currentTick = 1;
  world.currentTickStartMs = 0;
  world.data = {
    itemDefs: new Map([[itemDef.id, itemDef]]),
    getItem: (id: number) => id === itemDef.id ? itemDef : undefined,
    getSpellByIndex: () => null,
  };
  world.quests = {
    sendQuestStateSync() {},
    notifyQuestEvent() {},
    questConditionMet: () => true,
    runQuestActions: () => true,
  };
  world.maps = new Map([[
    'kcmap',
    {
      width: 64,
      height: 64,
      isBlocked: () => false,
      isTileBlockedOnFloor: () => false,
      isWallBlocked: () => false,
      isWallBlockedOnFloor: () => false,
      getTransitionAt: () => null,
      getStairOnFloor: () => null,
      getWalkableFloorTargetsAt: () => [{ floor: 0, y: 0 }],
      findPathOnFloor: (_sx: number, _sz: number, gx: number, gz: number) => [{ x: gx, z: gz }],
      findPathForNpc: (_sx: number, _sz: number, gx: number, gz: number) => [{ x: gx, z: gz }],
      getEffectiveHeightOnFloor: () => 0,
    },
  ]]);
  world.getPlayerMap = (player: Player) => world.maps.get(player.currentMapLevel);
  world.getMap = (mapId: string) => world.maps.get(mapId);
  world.cancelSkilling = () => {};
  world.closeNpcUiContext = () => {};
  world.clearPendingObjectIntents = () => {};
  world.forEachPlayerNearOnFloor = () => {};
  world.interruptPlayerAction = () => {};
  world.teleportPlayer = (player: Player, x: number, z: number, y: number, forcedFloor?: number) => {
    player.position.x = x;
    player.position.y = z;
    if (forcedFloor !== undefined) player.currentFloor = forcedFloor;
    player.effectiveY = y;
  };
  world.sendInventory = () => {};
  world.sendSingleSkill = () => {};
  world.sendChatSystem = () => {};
  world.setPlayerAnimation = () => {};
  world.broadcastPlayerAnimationEvent = () => {};
  world.broadcastNpcFacingPlayer = () => {};
  world.broadcastCombatHit = () => {};
  world.broadcastProjectile = () => {};
  world.sendToPlayer = (player: Player, opcode: ServerOpcode, ...values: number[]) => {
    let list = packets.get(player.id);
    if (!list) {
      list = [];
      packets.set(player.id, list);
    }
    list.push({ opcode, values });
  };
  world._dirtyPlayerPackets = new Map();
  world._dirtyNpcPackets = new Map();
  world.blockedObjectTiles = new Set();
  return { world, packets };
}

describe('floor isolation', () => {
  test('upper-floor door wall edges are registered and opened only on the authored floor', () => {
    const map = new GameMap('underground');
    const world = Object.create(World.prototype) as any;
    const door = new WorldObject(doorDef, 20.2, 20.9, 'underground', 1, 2.7);
    door.rotationY = 0;

    world.initDoorEdge(door);
    world.setDoorWallEdges(door, map);

    expect(map.isWallBlockedOnFloor(20.5, 20.5, 20.5, 21.5, 1)).toBe(true);

    map.setOpenDoorEdges(20, 20, WallEdge.S, true, 0);
    map.setOpenDoorEdges(20, 21, WallEdge.N, true, 0);
    expect(map.isWallBlockedOnFloor(20.5, 20.5, 20.5, 21.5, 1)).toBe(true);

    world.clearDoorWallEdges(door, map);
    expect(map.isWallBlockedOnFloor(20.5, 20.5, 20.5, 21.5, 1)).toBe(false);

    world.restoreDoorWallEdges(door, map);
    expect(map.isWallBlockedOnFloor(20.5, 20.5, 20.5, 21.5, 1)).toBe(true);
  });

  test('default floor-0 NPC spawns under upper planes render on terrain, not the floor above', () => {
    const map = new GameMap('kcmap');
    const world = Object.create(World.prototype) as any;
    world.maps = new Map([['kcmap', map]]);

    const resolved = world.resolveAuthoredFloor(map, 162.5, 164.5, undefined, undefined);
    expect(resolved.floor).toBe(0);
    expect(resolved.y).toBeLessThan(0.5);

    const npc = new Npc(npcDef, 162.5, 164.5);
    npc.currentMapLevel = 'kcmap';
    npc.currentFloor = 0;
    expect(world.npcWorldY(npc)).toBeLessThan(0.5);
  });

  test('central target gates reject same-tile entities on other floors', () => {
    const { world } = makeWorld();
    const player = makePlayer('player', 1, 1);
    const npc = new Npc(npcDef, player.position.x, player.position.y);
    npc.currentMapLevel = 'kcmap';
    npc.currentFloor = 0;
    const obj = new WorldObject(objectDef, player.position.x, player.position.y, 'kcmap', 0, 0);
    const item = {
      id: 9000,
      itemId: itemDef.id,
      quantity: 1,
      x: player.position.x,
      z: player.position.y,
      floor: 0,
      mapLevel: 'kcmap',
      despawnTimer: -1,
    };

    expect(world.canPlayerTargetNpc(player, npc)).toBe(false);
    expect(world.canPlayerTargetObject(player, obj)).toBe(false);
    expect(world.canPlayerTargetGroundItem(player, item)).toBe(false);

    npc.currentFloor = 1;
    const sameFloorObj = new WorldObject(objectDef, player.position.x, player.position.y, 'kcmap', 1, 3);
    item.floor = 1;

    expect(world.canPlayerTargetNpc(player, npc)).toBe(true);
    expect(world.canPlayerTargetObject(player, sameFloorObj)).toBe(true);
    expect(world.canPlayerTargetGroundItem(player, item)).toBe(true);
  });

  test('reversible ladder objects are targetable from connected upper floors', () => {
    const { world } = makeWorld();
    const player = makePlayer('player', 1, 1);
    const ladder = new WorldObject(ladderDef, player.position.x, player.position.y, 'kcmap', 0, 0);
    ladder.verticalLinks = [{
      from: { x: 5.5, z: 5.5, floor: 0, y: 0 },
      to: { x: 5.5, z: 5.5, floor: 1, y: 2.7 },
      bidirectional: true,
    }];
    const crate = new WorldObject(objectDef, player.position.x, player.position.y, 'kcmap', 0, 0);
    world.maps.set('kcmap', {
      ...world.maps.get('kcmap'),
      getWalkableFloorTargetsAt: () => [
        { floor: 0, y: 0 },
        { floor: 1, y: 2.7 },
      ],
    });

    expect(world.canPlayerTargetObject(player, crate)).toBe(false);
    expect(world.canPlayerTargetObject(player, ladder)).toBe(true);
  });

  test('cross-floor NPC attack is ignored even when the NPC id is visible', () => {
    const { world } = makeWorld();
    const player = makePlayer('player', 1, 1);
    const npc = new Npc(npcDef, 6.5, 5.5);
    npc.currentMapLevel = 'kcmap';
    npc.currentFloor = 0;
    player.visibleEntityIds.add(npc.id);
    world.players.set(player.id, player);
    world.npcs.set(npc.id, npc);

    world.handlePlayerAttackNpc(player.id, npc.id);

    expect(world.playerCombatTargets.has(player.id)).toBe(false);
    expect(player.attackTarget).toBeNull();
  });

  test('cross-floor pickup is ignored without moving inventory or despawning the item', () => {
    const { world } = makeWorld();
    const player = makePlayer('player', 1, 1);
    const groundItem = makeGroundItem(9001, player.position.x, player.position.y, 0);
    player.visibleEntityIds.add(groundItem.id);
    world.players.set(player.id, player);
    world.groundItems.set(groundItem.id, groundItem);

    world.handlePlayerPickup(player.id, groundItem.id);

    expect(world.groundItems.has(groundItem.id)).toBe(true);
    expect(player.inventory.every((slot: unknown) => slot === null)).toBe(true);
  });

  test('adjacent pickup succeeds when the item tile is directly reachable', () => {
    const { world } = makeWorld();
    const player = makePlayer('player', 1);
    const groundItem = makeGroundItem(9002, 6.5, 5.5);
    player.visibleEntityIds.add(groundItem.id);
    world.players.set(player.id, player);
    world.groundItems.set(groundItem.id, groundItem);

    world.handlePlayerPickup(player.id, groundItem.id);

    expect(world.groundItems.has(groundItem.id)).toBe(false);
    expect(player.inventory.some(slot => slot?.itemId === itemDef.id && slot.quantity === groundItem.quantity)).toBe(true);
  });

  test('adjacent pickup succeeds for an item sitting on a blocked table tile', () => {
    const { world } = makeWorld();
    const player = makePlayer('player', 1);
    const groundItem = makeGroundItem(9005, 6.5, 5.5);
    player.visibleEntityIds.add(groundItem.id);
    world.blockedObjectTiles.add(world.blockedKeyFor('kcmap', 6, 5, 0));
    world.players.set(player.id, player);
    world.groundItems.set(groundItem.id, groundItem);

    world.handlePlayerPickup(player.id, groundItem.id);

    expect(world.groundItems.has(groundItem.id)).toBe(false);
    expect(player.inventory.some(slot => slot?.itemId === itemDef.id && slot.quantity === groundItem.quantity)).toBe(true);
  });

  test('blocked table item can be picked up from a cardinal edge tile', () => {
    const { world } = makeWorld();
    const player = makePlayer('player', 1);
    const groundItem = makeGroundItem(9006, 6.5, 5.5);
    player.visibleEntityIds.add(groundItem.id);
    world.blockedObjectTiles.add(world.blockedKeyFor('kcmap', 6, 5, 0));
    world.players.set(player.id, player);
    world.groundItems.set(groundItem.id, groundItem);

    world.handlePlayerPickup(player.id, groundItem.id);

    expect(world.groundItems.has(groundItem.id)).toBe(false);
    expect(player.inventory.some(slot => slot?.itemId === itemDef.id && slot.quantity === groundItem.quantity)).toBe(true);
  });

  test('using an item on a table stores the stack on the tabletop', () => {
    const { world } = makeWorld();
    const player = makePlayer('player', 1);
    player.inventory[0] = { itemId: itemDef.id, quantity: 7 };
    const table = new WorldObject(tableDef, 6.5, 5.5, 'kcmap', 0, 0);
    table.assetId = 'table1';
    table.scale = { x: 0.5, y: 0.55, z: 0.55 };
    world.allocateGroundItemId = () => 9010;
    world.players.set(player.id, player);
    world.worldObjects.set(table.id, table);

    world.handlePlayerUseItemOnObject(player.id, 0, itemDef.id, table.id);

    const stored = world.groundItems.get(9010);
    expect(player.inventory[0]).toBeNull();
    expect(stored?.itemId).toBe(itemDef.id);
    expect(stored?.quantity).toBe(7);
    expect(stored?.x).toBe(table.x);
    expect(stored?.z).toBe(table.z);
    expect(stored?.floor).toBe(table.floor);
    expect(stored?.y).toBeCloseTo(0.7975, 5);
    expect(world.despawningItemIds.has(9010)).toBe(true);
    expect(player.isBusy(world.currentTick)).toBe(true);
    expect(player.isBusy(world.currentTick + 1)).toBe(false);
  });

  test('blocked table item pickup from reach distance cannot cross a wall edge', () => {
    const { world } = makeWorld();
    const player = makePlayer('player', 1);
    const groundItem = makeGroundItem(9007, 6.5, 5.5);
    player.visibleEntityIds.add(groundItem.id);
    world.blockedObjectTiles.add(world.blockedKeyFor('kcmap', 6, 5, 0));
    world.maps.set('kcmap', {
      ...world.maps.get('kcmap'),
      isWallBlocked: (_fx: number, _fz: number, tx: number, tz: number) => tx === 6 && tz === 5,
      isWallBlockedOnFloor: (_fx: number, _fz: number, tx: number, tz: number) => tx === 6 && tz === 5,
    });
    world.players.set(player.id, player);
    world.groundItems.set(groundItem.id, groundItem);

    world.handlePlayerPickup(player.id, groundItem.id);

    expect(world.groundItems.has(groundItem.id)).toBe(true);
    expect(player.inventory.every((slot: unknown) => slot === null)).toBe(true);
  });

  test('blocked table item cannot be picked up from a non-cardinal tile', () => {
    const { world } = makeWorld();
    const player = makePlayer('player', 1);
    const groundItem = makeGroundItem(9009, 7.5, 5.5);
    player.visibleEntityIds.add(groundItem.id);
    world.blockedObjectTiles.add(world.blockedKeyFor('kcmap', 7, 5, 0));
    world.players.set(player.id, player);
    world.groundItems.set(groundItem.id, groundItem);

    world.handlePlayerPickup(player.id, groundItem.id);

    expect(world.groundItems.has(groundItem.id)).toBe(true);
    expect(player.inventory.every((slot: unknown) => slot === null)).toBe(true);
  });

  test('elevated table item can be picked up across its final collision edge', () => {
    const { world } = makeWorld();
    const player = makePlayer('player', 1);
    const groundItem = makeGroundItem(9008, 6.5, 5.5);
    groundItem.y = 0.8;
    player.visibleEntityIds.add(groundItem.id);
    world.maps.set('kcmap', {
      ...world.maps.get('kcmap'),
      isWallBlocked: (_fx: number, _fz: number, tx: number, tz: number) => tx === 6 && tz === 5,
      isWallBlockedOnFloor: (_fx: number, _fz: number, tx: number, tz: number) => tx === 6 && tz === 5,
    });
    world.players.set(player.id, player);
    world.groundItems.set(groundItem.id, groundItem);

    world.handlePlayerPickup(player.id, groundItem.id);

    expect(world.groundItems.has(groundItem.id)).toBe(false);
    expect(player.inventory.some(slot => slot?.itemId === itemDef.id && slot.quantity === groundItem.quantity)).toBe(true);
  });

  test('adjacent pickup cannot cross a wall edge', () => {
    const { world } = makeWorld();
    const player = makePlayer('player', 1);
    const groundItem = makeGroundItem(9003, 6.5, 5.5);
    player.visibleEntityIds.add(groundItem.id);
    world.maps.set('kcmap', {
      ...world.maps.get('kcmap'),
      isWallBlocked: (fx: number, fz: number, tx: number, tz: number) => fx === 5 && fz === 5 && tx === 6 && tz === 5,
      isWallBlockedOnFloor: (fx: number, fz: number, tx: number, tz: number) => fx === 5 && fz === 5 && tx === 6 && tz === 5,
    });
    world.players.set(player.id, player);
    world.groundItems.set(groundItem.id, groundItem);

    world.handlePlayerPickup(player.id, groundItem.id);

    expect(world.groundItems.has(groundItem.id)).toBe(true);
    expect(player.inventory.every((slot: unknown) => slot === null)).toBe(true);
  });

  test('diagonal pickup cannot squeeze through blocked corner walls', () => {
    const { world } = makeWorld();
    const player = makePlayer('player', 1);
    const groundItem = makeGroundItem(9004, 6.5, 6.5);
    player.visibleEntityIds.add(groundItem.id);
    world.maps.set('kcmap', {
      ...world.maps.get('kcmap'),
      isWallBlocked: (fx: number, fz: number, tx: number, tz: number) =>
        (fx === 5 && fz === 5 && tx === 6 && tz === 5)
        || (fx === 5 && fz === 5 && tx === 5 && tz === 6),
      isWallBlockedOnFloor: (fx: number, fz: number, tx: number, tz: number) =>
        (fx === 5 && fz === 5 && tx === 6 && tz === 5)
        || (fx === 5 && fz === 5 && tx === 5 && tz === 6),
    });
    world.players.set(player.id, player);
    world.groundItems.set(groundItem.id, groundItem);

    world.handlePlayerPickup(player.id, groundItem.id);

    expect(world.groundItems.has(groundItem.id)).toBe(true);
    expect(player.inventory.every((slot: unknown) => slot === null)).toBe(true);
  });

  test('object blockers are keyed by floor', () => {
    const { world } = makeWorld();
    world.blockedObjectTiles = new Set();
    const ground = makePlayer('ground', 1, 0);
    const upper = makePlayer('upper', 2, 1);
    const map = world.getMap('kcmap');

    world.setObjectTilesBlocked('kcmap', 5.5, 5.5, objectDef, true, 1);

    expect(world.isTileBlockedForPlayer(ground, map, 5, 5)).toBe(false);
    expect(world.isTileBlockedForPlayer(upper, map, 5, 5)).toBe(true);
  });

  test('broadcast sync despawns nearby NPCs on other floors', () => {
    const { world, packets } = makeWorld();
    const viewer = makePlayer('viewer', 1, 0);
    const npc = new Npc(npcDef, 5.5, 5.5);
    npc.currentMapLevel = 'kcmap';
    npc.currentFloor = 1;
    viewer.visibleEntityIds.add(npc.id);
    world.players.set(viewer.id, viewer);
    world.npcs.set(npc.id, npc);
    world.chunkManagers = new Map([[
      'kcmap',
      {
        forEachEntityNearChunk(_cx: number, _cz: number, fn: (id: number) => void) {
          fn(npc.id);
        },
      },
    ]]);

    world.broadcastSync();

    expect(packets.get(viewer.id)?.some((p: { opcode: ServerOpcode; values: number[] }) => p.opcode === ServerOpcode.ENTITY_DEATH && p.values[0] === npc.id)).toBe(true);
    expect(viewer.visibleEntityIds.has(npc.id)).toBe(false);
  });

  test('broadcast sync keeps ladders visible from connected upper floors', () => {
    const { world } = makeWorld();
    const viewer = makePlayer('viewer', 1, 1);
    const ladder = new WorldObject(ladderDef, 5.5, 5.5, 'kcmap', 0, 0);
    ladder.verticalLinks = [{
      from: { x: 5.5, z: 5.5, floor: 0, y: 0 },
      to: { x: 5.5, z: 5.5, floor: 1, y: 2.7 },
      bidirectional: true,
    }];
    world.players.set(viewer.id, viewer);
    world.worldObjects.set(ladder.id, ladder);
    world.maps.set('kcmap', {
      ...world.maps.get('kcmap'),
      getWalkableFloorTargetsAt: () => [
        { floor: 0, y: 0 },
        { floor: 1, y: 2.7 },
      ],
    });
    world.chunkManagers = new Map([[
      'kcmap',
      {
        forEachEntityNearChunk(_cx: number, _cz: number, fn: (id: number) => void) {
          fn(ladder.id);
        },
      },
    ]]);

    world.broadcastSync();

    expect(viewer.visibleEntityIds.has(ladder.id)).toBe(true);
  });

  test('upper-floor ladder interaction can climb down to the connected lower target', () => {
    const { world } = makeWorld();
    const player = makePlayer('viewer', 1, 1);
    player.position.x = 160.5;
    player.position.y = 158.5;
    player.effectiveY = 2.73;
    const ladder = new WorldObject(ladderDef, 160.5, 157.5, 'kcmap', 0, 0);
    ladder.verticalLinks = [{
      from: { x: 160.5, z: 158.5, floor: 1, y: 2.73 },
      to: { x: 160.5, z: 156.5, floor: 0, y: 0.57 },
      fromAction: 'Climb-down',
    }];
    player.visibleEntityIds.add(ladder.id);
    world.players.set(player.id, player);
    world.worldObjects.set(ladder.id, ladder);
    world.maps.set('kcmap', {
      ...world.maps.get('kcmap'),
      width: 256,
      height: 256,
      getWalkableFloorTargetsAt: (x: number, z: number) => {
        if (Math.floor(x) === 160 && Math.floor(z) === 156) return [{ floor: 0, y: 0.57 }];
        return [
          { floor: 0, y: 0.52 },
          { floor: 1, y: 2.73 },
        ];
      },
    });

    world.handlePlayerInteractObject(player.id, ladder.id, 1);

    expect(player.currentFloor).toBe(0);
    expect(player.effectiveY).toBe(0.57);
  });

  test('explicit ladder link climbs only to its authored destination floor', () => {
    const { world } = makeWorld();
    const player = makePlayer('viewer', 1, 0);
    player.position.x = 10.5;
    player.position.y = 11.5;
    player.effectiveY = 0;
    const ladder = new WorldObject(ladderDef, 10.5, 10.5, 'kcmap', 0, 0);
    ladder.verticalLinks = [{
      from: { x: 10.5, z: 11.5, floor: 0, y: 0 },
      to: { x: 10.5, z: 11.5, floor: 1, y: 2.7 },
    }];
    player.visibleEntityIds.add(ladder.id);
    world.players.set(player.id, player);
    world.worldObjects.set(ladder.id, ladder);
    world.maps.set('kcmap', {
      ...world.maps.get('kcmap'),
      getWalkableFloorTargetsAt: () => [
        { floor: 0, y: 0 },
        { floor: 1, y: 2.7 },
        { floor: 2, y: 5.4 },
      ],
    });

    world.handlePlayerInteractObject(player.id, ladder.id, 0);

    expect(player.currentFloor).toBe(1);
    expect(player.position.x).toBe(10.5);
    expect(player.position.y).toBe(11.5);
    expect(player.effectiveY).toBe(2.7);
  });

  test('bidirectional ladder uses stable climb-down action index on the return trip', () => {
    const { world } = makeWorld();
    const player = makePlayer('viewer', 1, 1);
    player.position.x = 12.5;
    player.position.y = 13.5;
    player.effectiveY = 2.7;
    const ladder = new WorldObject(ladderDef, 12.5, 12.5, 'kcmap', 0, 0);
    ladder.verticalLinks = [{
      from: { x: 12.5, z: 13.5, floor: 0, y: 0 },
      to: { x: 12.5, z: 13.5, floor: 1, y: 2.7 },
      bidirectional: true,
    }];
    player.visibleEntityIds.add(ladder.id);
    world.players.set(player.id, player);
    world.worldObjects.set(ladder.id, ladder);

    world.handlePlayerInteractObject(player.id, ladder.id, 1);

    expect(player.currentFloor).toBe(0);
    expect(player.effectiveY).toBe(0);
  });

  test('stale ladder action index is rejected on the wrong side of a link', () => {
    const { world } = makeWorld();
    const player = makePlayer('viewer', 1, 1);
    player.position.x = 14.5;
    player.position.y = 15.5;
    player.effectiveY = 2.7;
    const ladder = new WorldObject(ladderDef, 14.5, 14.5, 'kcmap', 0, 0);
    ladder.verticalLinks = [{
      from: { x: 14.5, z: 15.5, floor: 0, y: 0 },
      to: { x: 14.5, z: 15.5, floor: 1, y: 2.7 },
    }];
    player.visibleEntityIds.add(ladder.id);
    world.players.set(player.id, player);
    world.worldObjects.set(ladder.id, ladder);

    world.handlePlayerInteractObject(player.id, ladder.id, 0);

    expect(player.currentFloor).toBe(1);
    expect(player.effectiveY).toBe(2.7);
  });

  test('ladder clicks from off the interaction tile queue movement before climbing', () => {
    const { world } = makeWorld();
    const messages: string[] = [];
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);
    const player = makePlayer('viewer', 1, 0);
    player.position.x = 10.5;
    player.position.y = 10.5;
    player.effectiveY = 0;
    const ladder = new WorldObject(ladderDef, 12.5, 12.5, 'kcmap', 0, 0);
    ladder.verticalLinks = [{
      from: { x: 12.5, z: 13.5, floor: 0, y: 0 },
      to: { x: 12.5, z: 13.5, floor: 1, y: 2.7 },
      fromAction: 'Climb-up',
    }];
    player.visibleEntityIds.add(ladder.id);
    world.players.set(player.id, player);
    world.worldObjects.set(ladder.id, ladder);

    world.handlePlayerInteractObject(player.id, ladder.id, 0);

    expect(messages).not.toContain("I can't climb up there.");
    expect(player.currentFloor).toBe(0);
    expect(player.pendingInteraction?.objectEntityId).toBe(ladder.id);
    expect(player.pendingInteraction?.actionIndex).toBe(0);
    expect(player.hasMoveQueue()).toBe(true);
  });

  test('one-way vertical refresh keeps ladder synced without stale climb actions', () => {
    const { world, packets } = makeWorld();
    const player = makePlayer('viewer', 1, 1);
    player.position.x = 10.5;
    player.position.y = 11.5;
    player.effectiveY = 2.7;
    const ladder = new WorldObject(ladderDef, 10.5, 10.5, 'kcmap', 0, 0);
    ladder.verticalLinks = [{
      from: { x: 10.5, z: 11.5, floor: 0, y: 0 },
      to: { x: 10.5, z: 11.5, floor: 1, y: 2.7 },
      fromAction: 'Climb-up',
    }];
    player.visibleEntityIds.add(ladder.id);
    world.players.set(player.id, player);
    world.worldObjects.set(ladder.id, ladder);
    world.chunkManagers = new Map([[
      'kcmap',
      {
        getEntitiesNear() {
          return new Set([ladder.id]);
        },
      },
    ]]);

    world.sendNearbyVerticalObjectUpdates(player);

    expect((packets.get(player.id) ?? []).some((p: { opcode: ServerOpcode; values: number[] }) => p.opcode === ServerOpcode.ENTITY_DEATH && p.values[0] === ladder.id)).toBe(false);
    expect(player.visibleEntityIds.has(ladder.id)).toBe(true);
    expect(world.canPlayerTargetObject(player, ladder)).toBe(true);
    expect(world.ladderActionMaskForPlayer(player, ladder)).toBe(0);
  });

  test('same-map floor changes immediately despawn stale non-ladder entities', () => {
    const { world, packets } = makeWorld();
    const player = makePlayer('viewer', 1, 1);
    player.effectiveY = 2.7;
    world.sendWorldObjectUpdate = (target: Player, obj: WorldObject) => {
      world.sendToPlayer(target, ServerOpcode.WORLD_OBJECT_SYNC, obj.id);
    };
    const remote = makePlayer('remote', 2, 1);
    const npc = new Npc(npcDef, 5.5, 5.5);
    npc.currentMapLevel = 'kcmap';
    npc.currentFloor = 1;
    const crate = new WorldObject(objectDef, 5.5, 5.5, 'kcmap', 1, 2.7);
    const groundItem = makeGroundItem(9011, 5.5, 5.5, 1);
    const ladder = new WorldObject(ladderDef, 5.5, 5.5, 'kcmap', 0, 0);
    ladder.verticalLinks = [{
      from: { x: 5.5, z: 5.5, floor: 0, y: 0 },
      to: { x: 5.5, z: 5.5, floor: 1, y: 2.7 },
      bidirectional: true,
    }];
    for (const id of [remote.id, npc.id, crate.id, groundItem.id, ladder.id]) player.visibleEntityIds.add(id);
    world.players.set(player.id, player);
    world.players.set(remote.id, remote);
    world.npcs.set(npc.id, npc);
    world.worldObjects.set(crate.id, crate);
    world.worldObjects.set(ladder.id, ladder);
    world.groundItems.set(groundItem.id, groundItem);
    world.chunkManagers = new Map([[
      'kcmap',
      {
        getEntitiesNear() {
          return new Set([ladder.id]);
        },
      },
    ]]);

    world.applyPlayerMovementLayer(player, { floor: 0, y: 0, lastFloorChangeTile: -1 });

    const sent = packets.get(player.id) ?? [];
    for (const id of [remote.id, npc.id, crate.id, groundItem.id]) {
      expect(sent.some((p: { opcode: ServerOpcode; values: number[] }) => p.opcode === ServerOpcode.ENTITY_DEATH && p.values[0] === id)).toBe(true);
      expect(player.visibleEntityIds.has(id)).toBe(false);
    }
    expect(player.visibleEntityIds.has(ladder.id)).toBe(true);
    expect(sent.some((p: { opcode: ServerOpcode; values: number[] }) => p.opcode === ServerOpcode.WORLD_OBJECT_SYNC && p.values[0] === ladder.id)).toBe(true);
  });

  test('visibility despawns are retried after a backpressured sync tick', () => {
    const { world, packets } = makeWorld();
    const viewer = makePlayer('viewer', 1, 0);
    const crate = new WorldObject(objectDef, 5.5, 5.5, 'kcmap', 1, 2.7);
    viewer.visibleEntityIds.add(crate.id);
    let buffered = Number.POSITIVE_INFINITY;
    viewer.ws = {
      sendBinary() {},
      send() {},
      close() {},
      getBufferedAmount: () => buffered,
    } as any;
    world.players.set(viewer.id, viewer);
    world.worldObjects.set(crate.id, crate);
    world.chunkManagers = new Map([[
      'kcmap',
      {
        forEachEntityNearChunk() {},
      },
    ]]);

    world.broadcastSync();

    expect(packets.get(viewer.id)?.some((p: { opcode: ServerOpcode; values: number[] }) => p.opcode === ServerOpcode.ENTITY_DEATH && p.values[0] === crate.id) ?? false).toBe(false);
    expect(viewer.visibleEntityIds.has(crate.id)).toBe(true);

    buffered = 0;
    world.broadcastSync();

    expect(packets.get(viewer.id)?.some((p: { opcode: ServerOpcode; values: number[] }) => p.opcode === ServerOpcode.ENTITY_DEATH && p.values[0] === crate.id)).toBe(true);
    expect(viewer.visibleEntityIds.has(crate.id)).toBe(false);
  });

  test('ladder links support signed negative destination floors', () => {
    const { world } = makeWorld();
    const player = makePlayer('viewer', 1, 0);
    player.position.x = 16.5;
    player.position.y = 17.5;
    player.effectiveY = 0;
    const ladder = new WorldObject(ladderDef, 16.5, 16.5, 'kcmap', 0, 0);
    ladder.verticalLinks = [{
      from: { x: 16.5, z: 17.5, floor: 0, y: 0 },
      to: { x: 16.5, z: 17.5, floor: -1, y: -3 },
    }];
    player.visibleEntityIds.add(ladder.id);
    world.players.set(player.id, player);
    world.worldObjects.set(ladder.id, ladder);

    world.handlePlayerInteractObject(player.id, ladder.id, 1);

    expect(player.currentFloor).toBe(-1);
    expect(player.effectiveY).toBe(-3);
  });

  test('ladder link rejects blocked destination floors', () => {
    const { world } = makeWorld();
    const player = makePlayer('viewer', 1, 0);
    player.position.x = 18.5;
    player.position.y = 19.5;
    player.effectiveY = 0;
    const ladder = new WorldObject(ladderDef, 18.5, 18.5, 'kcmap', 0, 0);
    ladder.verticalLinks = [{
      from: { x: 18.5, z: 19.5, floor: 0, y: 0 },
      to: { x: 18.5, z: 19.5, floor: 1, y: 2.7 },
    }];
    player.visibleEntityIds.add(ladder.id);
    world.players.set(player.id, player);
    world.worldObjects.set(ladder.id, ladder);
    world.maps.set('kcmap', {
      ...world.maps.get('kcmap'),
      isTileBlockedOnFloor: (x: number, z: number, floor: number) => floor === 1 && x === 18 && z === 19,
    });

    world.handlePlayerInteractObject(player.id, ladder.id, 0);

    expect(player.currentFloor).toBe(0);
    expect(player.effectiveY).toBe(0);
  });

  test('blocked ladder landing hides cross-floor ladder targetability', () => {
    const { world } = makeWorld();
    const player = makePlayer('viewer', 1, 1);
    player.position.x = 20.5;
    player.position.y = 21.5;
    player.effectiveY = 2.7;
    const ladder = new WorldObject(ladderDef, 20.5, 20.5, 'kcmap', 0, 0);
    ladder.verticalLinks = [{
      from: { x: 20.5, z: 21.5, floor: 0, y: 0 },
      to: { x: 20.5, z: 21.5, floor: 1, y: 2.7 },
      bidirectional: true,
    }];
    world.maps.set('kcmap', {
      ...world.maps.get('kcmap'),
      isTileBlockedOnFloor: (x: number, z: number, floor: number) => floor === 0 && x === 20 && z === 21,
    });

    expect(world.canPlayerTargetObject(player, ladder)).toBe(true);
    expect(world.ladderActionMaskForPlayer(player, ladder)).toBe(0);
  });

  test('tick transitions promote a player whose server-authored height reaches an upper texture-plane floor', () => {
    const { world, packets } = makeWorld();
    const player = makePlayer('upper', 1, 0);
    player.position.x = 158.5;
    player.position.y = 156.5;
    player.effectiveY = 2.73;
    world.players.set(player.id, player);
    world.maps.set('kcmap', {
      width: 64,
      getTransitionAt: () => null,
      getStairOnFloor: () => null,
      getWalkableFloorTargetsAt: () => [
        { floor: 0, y: 0.52 },
        { floor: 1, y: 2.73 },
      ],
      getEffectiveHeightOnFloor: (_x: number, _z: number, floor: number) => floor === 1 ? 2.73 : 0.52,
    });

    world.tickTransitions();

    expect(player.currentFloor).toBe(1);
    expect(player.effectiveY).toBe(2.73);
    expect(packets.get(player.id)?.some((p: { opcode: ServerOpcode; values: number[] }) => p.opcode === ServerOpcode.FLOOR_CHANGE && p.values[0] === 1)).toBe(true);
  });

  test('height-based floor changes refresh nearby ladder action masks', () => {
    const { world } = makeWorld();
    const player = makePlayer('upper', 1, 0);
    player.position.x = 158.5;
    player.position.y = 156.5;
    player.effectiveY = 2.73;
    world.players.set(player.id, player);
    world.maps.set('kcmap', {
      width: 64,
      getTransitionAt: () => null,
      getStairOnFloor: () => null,
      getWalkableFloorTargetsAt: () => [
        { floor: 0, y: 0.52 },
        { floor: 1, y: 2.73 },
      ],
      getEffectiveHeightOnFloor: (_x: number, _z: number, floor: number) => floor === 1 ? 2.73 : 0.52,
    });
    let refreshed = false;
    world.sendNearbyVerticalObjectUpdates = (target: Player) => {
      if (target.id === player.id) refreshed = true;
    };

    world.tickTransitions();

    expect(player.currentFloor).toBe(1);
    expect(refreshed).toBe(true);
  });

  test('login bootstrap recovers a floor-0 save whose persisted height matches an upper walking plane', () => {
    const { world, packets } = makeWorld();
    const player = makePlayer('upper_save', 1, 0);
    player.position.x = 158.5;
    player.position.y = 156.5;
    player.effectiveY = 2.73;
    player.appearance = {} as any;
    world.players.set(player.id, player);
    world.maps.set('kcmap', {
      width: 64,
      getWalkableFloorTargetsAt: () => [
        { floor: 0, y: 0.52 },
        { floor: 1, y: 2.73 },
      ],
      getEffectiveHeightOnFloor: (_x: number, _z: number, floor: number, currentY?: number) => {
        if (floor === 1) return 2.73;
        return currentY !== undefined && currentY > 1.23 ? 2.73 : 0.52;
      },
    });

    world.sendLoginBootstrap(player);

    expect(player.currentFloor).toBe(1);
    expect(player.effectiveY).toBe(2.73);
    expect(packets.get(player.id)?.some((p: { opcode: ServerOpcode; values: number[] }) => p.opcode === ServerOpcode.FLOOR_CHANGE && p.values[0] === 1)).toBe(true);
  });

  test('position persistence uses server effective height as the elevated-floor gate', () => {
    const { world } = makeWorld();
    const player = makePlayer('spoof_y', 1, 0);
    player.position.x = 158.5;
    player.position.y = 156.5;
    player.effectiveY = 0.52;
    world.maps.set('kcmap', {
      width: 64,
      getEffectiveHeightOnFloor: (_x: number, _z: number, floor: number, currentY?: number) => {
        if (floor === 1) return 2.73;
        return currentY !== undefined && currentY > 1.23 ? 2.73 : 0.52;
      },
    });

    expect(world.computeEffectiveY(player)).toBe(0.52);
  });

  test('height-based floor inference keeps floor 0 when a bridge target ties the upper-floor height', () => {
    const { world, packets } = makeWorld();
    const player = makePlayer('bridge', 1, 0);
    player.effectiveY = 2.73;
    world.players.set(player.id, player);
    world.maps.set('kcmap', {
      width: 64,
      getTransitionAt: () => null,
      getStairOnFloor: () => null,
      getWalkableFloorTargetsAt: () => [
        { floor: 0, y: 2.73 },
        { floor: 1, y: 2.73 },
      ],
      getEffectiveHeightOnFloor: () => 2.73,
    });

    world.tickTransitions();

    expect(player.currentFloor).toBe(0);
    expect(packets.get(player.id)?.some((p: { opcode: ServerOpcode; values: number[] }) => p.opcode === ServerOpcode.FLOOR_CHANGE) ?? false).toBe(false);
  });
});
