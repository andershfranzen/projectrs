import { describe, expect, test } from 'bun:test';
import { COOKING_RANGE_OBJECT_DEF_ID, DOOR_EDGE_NEIGHBOR, GENERIC_SCENERY_OBJECT_DEF_ID, KILN_OBJECT_DEF_ID, POTTERY_WHEEL_OBJECT_DEF_ID, ServerOpcode, WallEdge, type WorldObjectDef } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { WorldObject } from '../src/entity/WorldObject';
import { GameMap } from '../src/GameMap';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;
const FULL_TILE_WALL_MASK = WallEdge.N | WallEdge.E | WallEdge.S | WallEdge.W;

const largeBlockingDef: WorldObjectDef = {
  id: 900,
  name: 'Large Chest',
  category: 'chest',
  actions: ['Open', 'Examine'],
  blocking: true,
  width: 2,
  height: 1,
  color: [1, 1, 1],
};

const stationRangeDef: WorldObjectDef = {
  id: COOKING_RANGE_OBJECT_DEF_ID,
  name: 'Cooking Range',
  category: 'cookingrange',
  actions: ['Cook', 'Examine'],
  blocking: true,
  width: 2,
  height: 1,
  color: [1, 1, 1],
};

const sultansMineDoorDef: WorldObjectDef = {
  id: 13,
  name: 'Door',
  category: 'door',
  actions: ['Open', 'Examine'],
  blocking: true,
  width: 1,
  height: 1.8,
  color: [120, 80, 40],
  respawnTime: 200,
};

function makePlayer(): Player {
  return new Player('wall_test', 10.5, 9.5, fakeWs, 1);
}

function makeObject(defId: number, name: string, category: string = 'scenery'): any {
  return {
    id: 10000 + defId,
    defId,
    mapLevel: 'kcmap',
    floor: 0,
    x: 10.5,
    z: 10.5,
    rotationY: 0,
    interactionSides: undefined,
    interactionTiles: undefined,
    def: {
      id: defId,
      name,
      category,
      blocking: true,
      width: 1,
      height: 1,
    },
  };
}

function canUseWithWallBlocked(defId: number, name: string, wallBlocked: boolean, category?: string): boolean {
  const world = Object.create(World.prototype) as any;
  const player = makePlayer();
  const obj = makeObject(defId, name, category);
  const map = {
    isWallBlocked: () => wallBlocked,
    isWallBlockedOnFloor: () => wallBlocked,
  };
  return world.canUseObjectFromTile(player, obj, 10, 9, map);
}

function canUseFromNorthWithAuthoredWalls(defId: number, name: string, category: string, sourceMask: number, footprintMask: number): boolean {
  const world = Object.create(World.prototype) as any;
  world.npcs = new Map();
  const player = makePlayer();
  const obj = makeObject(defId, name, category);
  const map = {
    isWallBlocked: () => (sourceMask | footprintMask) !== 0,
    isWallBlockedOnFloor: () => (sourceMask | footprintMask) !== 0,
    getWallOnFloor: (x: number, z: number) => {
      if (x === 10 && z === 9) return sourceMask;
      if (x === 10 && z === 10) return footprintMask;
      return 0;
    },
  };
  return world.canUseObjectFromTile(player, obj, 10, 9, map);
}

function canUseGenericPlacedSceneryFromNorth(assetId: string, sourceMask: number, footprintMask: number): boolean {
  const world = Object.create(World.prototype) as any;
  world.npcs = new Map();
  const player = makePlayer();
  const obj = makeObject(GENERIC_SCENERY_OBJECT_DEF_ID, 'Scenery', 'scenery');
  obj.assetId = assetId;
  obj.def.blocking = false;
  const map = {
    isWallBlocked: () => (sourceMask | footprintMask) !== 0,
    isWallBlockedOnFloor: () => (sourceMask | footprintMask) !== 0,
    getWallOnFloor: (x: number, z: number) => {
      if (x === 10 && z === 9) return sourceMask;
      if (x === 10 && z === 10) return footprintMask;
      return 0;
    },
  };
  return world.canUseObjectFromTile(player, obj, 10, 9, map);
}

function makeBankerBehindBooth(): any {
  return {
    id: 777,
    hasBank: true,
    dead: false,
    currentMapLevel: 'kcmap',
    currentFloor: 0,
    position: { x: 10.5, y: 11.5 },
  };
}

function canUseBankWithWallBlocked(wallBlocked: boolean, hasBanker: boolean): boolean {
  const world = Object.create(World.prototype) as any;
  const player = makePlayer();
  const obj = makeObject(31, 'Bank booth', 'bank');
  const map = {
    isWallBlocked: () => wallBlocked,
    isWallBlockedOnFloor: () => wallBlocked,
  };
  world.npcs = hasBanker ? new Map([[777, makeBankerBehindBooth()]]) : new Map();
  return world.canUseObjectFromTile(player, obj, 10, 9, map);
}

function makeBankBoothHarness(): { world: any; player: Player; obj: any; opened: () => number; talked: () => number } {
  const world = Object.create(World.prototype) as any;
  const player = makePlayer();
  const obj = makeObject(31, 'Bank booth', 'bank');
  obj.depleted = false;
  obj.doorOpen = false;
  obj.displayName = 'Bank booth';
  obj.examineText = 'A bank booth.';
  obj.currentActions = ['Talk-to', 'Use-quickly', 'Examine'];
  obj.interactions = [];

  let opened = 0;
  let talked = 0;
  const map = {
    isBlocked: () => false,
    isTileBlockedOnFloor: () => false,
    isWallBlocked: () => true,
    isWallBlockedOnFloor: () => true,
  };
  world.players = new Map([[player.id, player]]);
  world.worldObjects = new Map([[obj.id, obj]]);
  world.blockedObjectTiles = new Set();
  world.maps = new Map([['kcmap', map]]);
  world.getPlayerMap = (p: Player) => world.maps.get(p.currentMapLevel);
  world.clearCombatTarget = () => {};
  world.closeNpcUiContext = () => {};
  world.runObjectInteractionEffects = () => {};
  world.quests = { notifyQuestEvent() {} };
  world.npcs = new Map([[777, makeBankerBehindBooth()]]);
  world.handlePlayerTalkNpc = () => { talked += 1; };
  world.openBankFor = () => { opened += 1; };
  return { world, player, obj, opened: () => opened, talked: () => talked };
}

function makeSultansMineDoorHarness(withOre = false): {
  world: any;
  player: Player;
  door: WorldObject;
  messages: string[];
  overheadMessages: Array<{ npcId: number; message: string }>;
  packets: Array<{ opcode: ServerOpcode; values: number[] }>;
  crossingTarget: { x: number; z: number };
  southExitTarget: { x: number; z: number };
} {
  const world = Object.create(World.prototype) as any;
  const map = new GameMap('the_sultans_mine');
  const doorY = map.getEffectiveHeightOnFloor(116.5, 157.5, 0);
  const player = new Player('miner', 116.5, 158.5, fakeWs, 1);
  player.currentMapLevel = 'the_sultans_mine';
  player.currentFloor = 0;
  player.effectiveY = map.getEffectiveHeightOnFloor(player.position.x, player.position.y, 0);
  if (withOre) player.inventory[0] = { itemId: 25, quantity: 1 };

  const door = new WorldObject(sultansMineDoorDef, 116.5, 157.5, 'the_sultans_mine', 0, doorY);
  door.rotationY = 0;
  world.initDoorEdge(door);
  world.setDoorWallEdges(door, map);
  const nb = DOOR_EDGE_NEIGHBOR[world.doorWallEdge(door)];
  if (!nb) throw new Error('test door has no edge neighbor');
  const crossingTarget = {
    x: Math.floor(door.x) + nb.dx + 0.5,
    z: Math.floor(door.z) + nb.dz + 0.5,
  };
  const southExitTarget = {
    x: Math.floor(door.x) - nb.dx + 0.5,
    z: Math.floor(door.z) - nb.dz + 0.5,
  };

  const messages: string[] = [];
  const overheadMessages: Array<{ npcId: number; message: string }> = [];
  const packets: Array<{ opcode: ServerOpcode; values: number[] }> = [];
  const guard = {
    id: 777,
    npcId: 108,
    dead: false,
    currentMapLevel: 'the_sultans_mine',
    currentFloor: 0,
    position: { x: 115.5, y: 156.5 },
  };
  world.currentTick = 1;
  world.players = new Map([[player.id, player]]);
  world.npcs = new Map([[guard.id, guard]]);
  world.worldObjects = new Map([[door.id, door]]);
  world.maps = new Map([['the_sultans_mine', map]]);
  world.chunkManagers = new Map();
  world.depletedObjectIds = new Set();
  world.blockedObjectTiles = new Set();
  world.closedCenteredDoorTileCounts = new Map();
  world.closedCenteredDoorTileKeysByObjectId = new Map();
  world.doorObjectsByMap = new Map([['the_sultans_mine', new Set([door])]]);
  world.skillingActions = new Map();
  world.itemProductionActions = new Map();
  world.activeDuels = new Map();
  world.db = { saveDoorState() {}, clearDoorState() {} };
  world.getPlayerMap = () => map;
  world.getMap = () => map;
  world.sendChatSystem = (_player: Player, message: string) => { messages.push(message); };
  world.sendToPlayer = (_player: Player, opcode: ServerOpcode, ...values: number[]) => {
    packets.push({ opcode, values });
  };
  world.sendNpcOverheadMessage = (_player: Player, npc: any, message: string) => {
    overheadMessages.push({ npcId: npc.id, message });
  };
  world.broadcastNpcFacingPlayer = () => {};
  world.bumpActionRevision = () => {};
  world.markQueuedAction = () => {};
  world.clearQueuedPlayerActions = (p: Player) => {
    p.pendingInteraction = null;
    p.pendingActionRevision = -1;
  };
  world.cancelItemProduction = () => {};
  world.closeNpcUiContext = () => {};
  world.clearCombatTarget = () => {};
  world.runObjectInteractionEffects = () => {};
  world.quests = { notifyQuestEvent() {} };
  world.updateEntityChunk = () => {};
  world.markEntityTileOccupantsDirty = () => {};
  world.checkpointPlayerPosition = () => {};
  world.setCenteredDoorTileBlocked(door, !door.doorOpen);
  return { world, player, door, messages, overheadMessages, packets, crossingTarget, southExitTarget };
}

describe('wall-gated station interaction', () => {
  test('ordinary resource objects cannot be used through a wall edge', () => {
    expect(canUseWithWallBlocked(3, 'Copper Rock', true, 'rock')).toBe(false);
    expect(canUseWithWallBlocked(3, 'Copper Rock', false, 'rock')).toBe(true);
  });

  test('blocking objects can be used across their own full-tile footprint blocker', () => {
    expect(canUseFromNorthWithAuthoredWalls(8, 'Altar', 'altar', 0, FULL_TILE_WALL_MASK)).toBe(true);
    expect(canUseFromNorthWithAuthoredWalls(3, 'Copper Rock', 'rock', 0, FULL_TILE_WALL_MASK)).toBe(true);
  });

  test('generic placed scenery can be examined across its own editor block tile', () => {
    expect(canUseGenericPlacedSceneryFromNorth('bush1', 0, FULL_TILE_WALL_MASK)).toBe(true);
    expect(canUseGenericPlacedSceneryFromNorth('table1', 0, FULL_TILE_WALL_MASK)).toBe(true);
    expect(canUseGenericPlacedSceneryFromNorth('chair', 0, FULL_TILE_WALL_MASK)).toBe(true);
  });

  test('generic placed scenery still cannot be examined through a source-side wall edge', () => {
    expect(canUseGenericPlacedSceneryFromNorth('table1', WallEdge.S, FULL_TILE_WALL_MASK)).toBe(false);
    expect(canUseGenericPlacedSceneryFromNorth('chair', WallEdge.S, FULL_TILE_WALL_MASK)).toBe(false);
  });

  test('non-adjacent examine does not queue movement around to the object', () => {
    const world = Object.create(World.prototype) as any;
    const player = new Player('examine_path_test', 10.5, 7.5, fakeWs, 1);
    player.currentMapLevel = 'kcmap';
    player.currentFloor = 0;
    const obj = makeObject(GENERIC_SCENERY_OBJECT_DEF_ID, 'Table', 'scenery');
    obj.assetId = 'table1';
    obj.def.blocking = false;
    obj.def.actions = ['Examine'];
    obj.currentActions = ['Examine'];
    obj.depleted = false;
    obj.displayName = 'Table';
    obj.examineText = 'A plain wooden table.';
    const messages: string[] = [];
    const map = {
      isBlocked: () => false,
      isTileBlockedOnFloor: () => false,
      isWallBlocked: () => false,
      isWallBlockedOnFloor: () => false,
      getWallOnFloor: () => 0,
    };
    world.currentTick = 0;
    world.players = new Map([[player.id, player]]);
    world.worldObjects = new Map([[obj.id, obj]]);
    world.blockedObjectTiles = new Set();
    world.maps = new Map([['kcmap', map]]);
    world.getPlayerMap = () => map;
    world.bumpActionRevision = () => {};
    world.clearQueuedPlayerActions = () => {};
    world.cancelItemProduction = () => {};
    world.closeNpcUiContext = () => {};
    world.sendChatSystem = (_player: Player, message: string) => { messages.push(message); };

    world.handlePlayerInteractObject(player.id, obj.id, 0);

    expect(player.hasMoveQueue()).toBe(false);
    expect(messages).toEqual(["I can't reach that."]);
  });

  test('blocking objects cannot be used through a source-side wall edge', () => {
    expect(canUseFromNorthWithAuthoredWalls(8, 'Altar', 'altar', WallEdge.S, FULL_TILE_WALL_MASK)).toBe(false);
    expect(canUseFromNorthWithAuthoredWalls(3, 'Copper Rock', 'rock', WallEdge.S, FULL_TILE_WALL_MASK)).toBe(false);
  });

  test('bank booths still require a banker across the counter edge', () => {
    expect(canUseFromNorthWithAuthoredWalls(31, 'Bank booth', 'bank', 0, FULL_TILE_WALL_MASK)).toBe(false);
  });

  test('bank booths can be used across a counter edge but not an arbitrary blocked edge', () => {
    expect(canUseBankWithWallBlocked(true, true)).toBe(true);
    expect(canUseBankWithWallBlocked(true, false)).toBe(false);
    expect(canUseBankWithWallBlocked(false, false)).toBe(true);
  });

  test('bank booth actions dispatch across their counter edge', () => {
    const talkHarness = makeBankBoothHarness();
    talkHarness.world.handlePlayerInteractObject(talkHarness.player.id, talkHarness.obj.id, 0);
    expect(talkHarness.talked()).toBe(1);
    expect(talkHarness.opened()).toBe(0);

    const bankHarness = makeBankBoothHarness();
    bankHarness.world.handlePlayerInteractObject(bankHarness.player.id, bankHarness.obj.id, 1);
    expect(bankHarness.talked()).toBe(0);
    expect(bankHarness.opened()).toBe(1);
  });

  test('sultan mine export door refuses to open while the player carries ore', () => {
    const { world, player, door, messages, overheadMessages } = makeSultansMineDoorHarness(true);

    world.handlePlayerInteractObject(player.id, door.id, 0);

    expect(door.doorOpen).toBe(false);
    expect(player.hasMoveQueue()).toBe(false);
    expect(messages).toEqual([]);
    expect(overheadMessages).toEqual([{ npcId: 777, message: "Halt. Pay for your ore's transportation before you leave the mine." }]);
  });

  test('sultan mine export door queues a far ore carrier without warning until arrival', () => {
    const { world, player, door, messages, overheadMessages } = makeSultansMineDoorHarness(true);
    player.moveTo(116.5, 159.5);
    player.effectiveY = world.getPlayerMap(player).getEffectiveHeightOnFloor(116.5, 159.5, 0);

    world.handlePlayerInteractObject(player.id, door.id, 0);

    expect(door.doorOpen).toBe(false);
    expect(player.hasMoveQueue()).toBe(true);
    expect(messages).toEqual([]);
    expect(overheadMessages).toEqual([]);
  });

  test('sultan mine export door blocks ore carriers even if another player opened it', () => {
    const { world, player, door, messages, overheadMessages, packets, crossingTarget } = makeSultansMineDoorHarness(true);
    world.toggleDoor(door, 0);
    expect(door.doorOpen).toBe(true);
    player.setMoveQueue([{ x: door.x, z: door.z }, crossingTarget]);

    world.tickPlayerMovement();

    expect(door.doorOpen).toBe(false);
    expect(player.position.x).toBe(116.5);
    expect(player.position.y).toBe(158.5);
    expect(player.hasMoveQueue()).toBe(false);
    expect(messages).toEqual([]);
    expect(overheadMessages).toEqual([{ npcId: 777, message: "Halt. Pay for your ore's transportation before you leave the mine." }]);
    expect(packets.some(packet => packet.opcode === ServerOpcode.PATH_TRUNCATED)).toBe(true);
  });

  test('sultan mine export door click queues one valid crossing and closes after it', () => {
    const { world, player, door, packets, crossingTarget } = makeSultansMineDoorHarness(false);

    world.handlePlayerInteractObject(player.id, door.id, 0);

    expect(door.doorOpen).toBe(true);
    expect(player.hasMoveQueue()).toBe(true);
    expect(packets.some(packet => packet.opcode === ServerOpcode.PLAYER_CONTROLLED_MOVE)).toBe(true);

    world.tickPlayerMovement();
    world.tickPlayerMovement();

    expect(player.position.x).toBe(crossingTarget.x);
    expect(player.position.y).toBe(crossingTarget.z);
    expect(door.doorOpen).toBe(false);
  });

  test('sultan mine export door walks north-side players fully onto the south tile', () => {
    const { world, player, door, packets, southExitTarget } = makeSultansMineDoorHarness(false);
    player.moveTo(116.5, 156.5);
    player.effectiveY = world.getPlayerMap(player).getEffectiveHeightOnFloor(116.5, 156.5, 0);

    world.handlePlayerInteractObject(player.id, door.id, 0);

    const controlledMove = packets.find(packet => packet.opcode === ServerOpcode.PLAYER_CONTROLLED_MOVE);
    expect(door.doorOpen).toBe(true);
    expect(controlledMove?.values).toHaveLength(4);

    world.tickPlayerMovement();
    expect(player.position.x).toBe(116.5);
    expect(player.position.y).toBe(157.5);
    expect(door.doorOpen).toBe(false);

    world.tickPlayerMovement();

    expect(player.position.x).toBe(southExitTarget.x);
    expect(player.position.y).toBe(southExitTarget.z);
    expect(door.doorOpen).toBe(false);
  });

  test('sultan mine export door ignores click-away movement during controlled transit', () => {
    const { world, player, door, southExitTarget } = makeSultansMineDoorHarness(false);
    player.moveTo(116.5, 156.5);
    player.effectiveY = world.getPlayerMap(player).getEffectiveHeightOnFloor(116.5, 156.5, 0);

    world.handlePlayerInteractObject(player.id, door.id, 0);
    world.handlePlayerMove(player.id, [{ x: 116.5, z: 154.5 }]);

    world.tickPlayerMovement();
    world.handlePlayerMove(player.id, [{ x: 116.5, z: 154.5 }]);
    world.tickPlayerMovement();

    expect(player.position.x).toBe(southExitTarget.x);
    expect(player.position.y).toBe(southExitTarget.z);
    expect(player.hasMoveQueue()).toBe(false);
    expect(door.doorOpen).toBe(false);
  });

  test('center-placed closed doors block their own tile while edge-placed doors do not', () => {
    const world = Object.create(World.prototype) as any;
    const player = makePlayer();
    player.currentMapLevel = 'kcmap';
    player.currentFloor = 0;
    const map = {
      isBlocked: () => false,
      isTileBlockedOnFloor: () => false,
    };
    const centerDoor = new WorldObject(sultansMineDoorDef, 10.5, 10.5, 'kcmap', 0, 0);
    centerDoor.rotationY = 0;
    const edgeDoor = new WorldObject(sultansMineDoorDef, 12.5, 12.0, 'kcmap', 0, 0);
    edgeDoor.rotationY = 0;
    world.worldObjects = new Map([[centerDoor.id, centerDoor], [edgeDoor.id, edgeDoor]]);
    world.closedCenteredDoorTileCounts = new Map();
    world.closedCenteredDoorTileKeysByObjectId = new Map();
    world.blockedObjectTiles = new Set();
    world.sultansMineDoorTransits = new Map();
    world.setCenteredDoorTileBlocked(centerDoor, true);
    world.setCenteredDoorTileBlocked(edgeDoor, true);

    expect(world.isPlayerMovementTileBlocked(player, map, 10, 10, 0)).toBe(true);
    expect(world.isPlayerMovementTileBlocked(player, map, 12, 12, 0)).toBe(false);

    centerDoor.doorOpen = true;
    world.setCenteredDoorTileBlocked(centerDoor, false);
    expect(world.isPlayerMovementTileBlocked(player, map, 10, 10, 0)).toBe(false);
  });

  test('overlapping center-placed doors keep the tile blocked until all are open', () => {
    const world = Object.create(World.prototype) as any;
    const player = makePlayer();
    player.currentMapLevel = 'kcmap';
    player.currentFloor = 0;
    const map = {
      isBlocked: () => false,
      isTileBlockedOnFloor: () => false,
    };
    const firstDoor = new WorldObject(sultansMineDoorDef, 10.5, 10.5, 'kcmap', 0, 0);
    const secondDoor = new WorldObject(sultansMineDoorDef, 10.5, 10.5, 'kcmap', 0, 0);
    firstDoor.rotationY = 0;
    secondDoor.rotationY = 0;
    world.closedCenteredDoorTileCounts = new Map();
    world.closedCenteredDoorTileKeysByObjectId = new Map();
    world.blockedObjectTiles = new Set();
    world.sultansMineDoorTransits = new Map();

    world.setCenteredDoorTileBlocked(firstDoor, true);
    world.setCenteredDoorTileBlocked(secondDoor, true);
    world.setCenteredDoorTileBlocked(firstDoor, false);

    expect(world.isPlayerMovementTileBlocked(player, map, 10, 10, 0)).toBe(true);

    world.setCenteredDoorTileBlocked(secondDoor, false);

    expect(world.isPlayerMovementTileBlocked(player, map, 10, 10, 0)).toBe(false);
  });

  test('closed center-placed sultan mine door rejects ordinary movement onto its tile', () => {
    const { world, player, door, packets } = makeSultansMineDoorHarness(false);

    world.handlePlayerMove(player.id, [{ x: door.x, z: door.z }]);

    expect(player.hasMoveQueue()).toBe(false);
    expect(player.position.x).toBe(116.5);
    expect(player.position.y).toBe(158.5);
    expect(packets.some(packet => packet.opcode === ServerOpcode.PATH_TRUNCATED)).toBe(true);
  });

  test('pottery wheels cannot be used through a wall edge', () => {
    expect(canUseWithWallBlocked(POTTERY_WHEEL_OBJECT_DEF_ID, 'Pottery Wheel', true)).toBe(false);
    expect(canUseWithWallBlocked(POTTERY_WHEEL_OBJECT_DEF_ID, 'Pottery Wheel', false)).toBe(true);
  });

  test('kilns cannot be used through a wall edge', () => {
    expect(canUseWithWallBlocked(KILN_OBJECT_DEF_ID, 'Kiln', true)).toBe(false);
    expect(canUseWithWallBlocked(KILN_OBJECT_DEF_ID, 'Kiln', false)).toBe(true);
  });

  test('cooking ranges cannot be used through a wall edge', () => {
    expect(canUseWithWallBlocked(COOKING_RANGE_OBJECT_DEF_ID, 'Cooking Range', true, 'cookingrange')).toBe(false);
    expect(canUseWithWallBlocked(COOKING_RANGE_OBJECT_DEF_ID, 'Cooking Range', false, 'cookingrange')).toBe(true);
  });

  test('authored interaction tiles override loose cooking range adjacency', () => {
    const world = Object.create(World.prototype) as any;
    const player = makePlayer();
    const obj = makeObject(COOKING_RANGE_OBJECT_DEF_ID, 'Cooking Range', 'cookingrange');
    obj.interactionTiles = [{ x: 0, z: -1 }];
    const map = {
      isWallBlocked: () => false,
      isWallBlockedOnFloor: () => false,
    };

    expect(world.canUseObjectFromTile(player, obj, 10, 9, map)).toBe(true);
    expect(world.canUseObjectFromTile(player, obj, 11, 10, map)).toBe(false);
  });

  test('authored crafting station tiles can use their station across a blocked footprint edge', () => {
    const world = Object.create(World.prototype) as any;
    const player = makePlayer();
    const obj = makeObject(6, 'Furnace', 'furnace');
    obj.def.width = 2;
    obj.interactionTiles = [{ x: 1, z: 0 }];
    const map = {
      isWallBlocked: () => true,
      isWallBlockedOnFloor: () => true,
    };

    expect(world.canUseObjectFromTile(player, obj, 11, 10, map)).toBe(true);
  });

  test('authored interaction tiles can be stood on when terrain is not blocked', () => {
    const world = Object.create(World.prototype) as any;
    world.blockedObjectTiles = new Set();
    const player = makePlayer();
    player.currentMapLevel = 'kcmap';
    player.currentFloor = 0;
    let terrainBlocked = false;
    const map = {
      isBlocked: (x: number, z: number) => terrainBlocked && x === 10 && z === 10,
      isTileBlockedOnFloor: () => false,
    };

    world.setObjectTilesBlocked('kcmap', 10, 10, largeBlockingDef, true, 0, [{ x: 0, z: 0 }], 0);

    expect(world.isTileBlockedForPlayer(player, map, 10, 10)).toBe(false);
    expect(world.isTileBlockedForPlayer(player, map, 9, 10)).toBe(true);

    terrainBlocked = true;
    expect(world.isTileBlockedForPlayer(player, map, 10, 10)).toBe(true);
  });

  test('crafting stations use authored map collision instead of footprint blockers', () => {
    const world = Object.create(World.prototype) as any;
    world.blockedObjectTiles = new Set();
    const player = makePlayer();
    player.currentMapLevel = 'kcmap';
    player.currentFloor = 0;
    let terrainBlocked = false;
    const map = {
      isBlocked: (x: number, z: number) => terrainBlocked && x === 10 && z === 10,
      isTileBlockedOnFloor: () => false,
    };

    world.setObjectTilesBlocked('kcmap', 10, 10, stationRangeDef, true, 0);

    expect(world.isTileBlockedForPlayer(player, map, 10, 10)).toBe(false);
    expect(world.isTileBlockedForPlayer(player, map, 9, 10)).toBe(false);

    terrainBlocked = true;
    expect(world.isTileBlockedForPlayer(player, map, 10, 10)).toBe(true);
  });

  test('object interaction pathing chooses the shortest reachable side', () => {
    const world = Object.create(World.prototype) as any;
    world.blockedObjectTiles = new Set();
    const player = new Player('rock_path_test', 10.5, 7.5, fakeWs, 1);
    player.currentMapLevel = 'kcmap';
    player.currentFloor = 0;
    const rockDef: WorldObjectDef = {
      id: 3,
      name: 'Copper Rock',
      category: 'rock',
      actions: ['Mine', 'Examine'],
      blocking: true,
      width: 1,
      height: 1,
      color: [140, 90, 50],
    };
    const rock = {
      id: 10003,
      defId: 3,
      mapLevel: 'kcmap',
      floor: 0,
      x: 10.5,
      z: 10.5,
      rotationY: 0,
      interactionSides: undefined,
      interactionTiles: undefined,
      def: rockDef,
    };
    const map = {
      isBlocked: () => false,
      isTileBlockedOnFloor: () => false,
      isWallBlocked: () => false,
      isWallBlockedOnFloor: () => false,
    };
    world.getPlayerMap = () => map;

    const path = world.findPathToObjectInteraction(player, rock);
    const last = path[path.length - 1]!;

    expect(Math.floor(last.x)).toBe(10);
    expect(Math.floor(last.z)).toBe(9);
  });
});
