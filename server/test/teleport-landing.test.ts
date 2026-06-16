import { describe, expect, test } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function makeMap() {
  return {
    width: 32,
    height: 32,
    isTileBlockedOnFloor: () => false,
    getEffectiveHeightOnFloor: () => 0,
    getElevatedFloorHeight: () => undefined,
    findSpawnPoint: () => ({ x: 1.5, z: 1.5 }),
  };
}

function makeWorldHarness(): { world: any; player: Player } {
  const player = new Player('teleport-test', 3.5, 3.5, fakeWs, 1);
  player.currentMapLevel = 'underground';
  player.currentFloor = 0;
  player.effectiveY = 0;

  const world = Object.create(World.prototype) as any;
  const oldMap = makeMap();
  const targetMap = makeMap();
  world.maps = new Map([
    ['underground', oldMap],
    ['kcmap', targetMap],
  ]);
  world.chunkManagers = new Map();
  world.worldObjects = new Map();
  world.blockedObjectTiles = new Set();
  world.closedCenteredDoorTileCounts = new Map();
  world.closedCenteredDoorTileKeysByObjectId = new Map();
  world.getPlayerMap = (p: Player) => world.maps.get(p.currentMapLevel);
  world.closeOpenInterface = () => {};
  world.closeShopForPlayer = () => {};
  world.closeDialogueForPlayer = () => {};
  world.clearCombatReferencesTo = () => {};
  world.savePlayerState = () => {};
  world.clearQueuedPlayerActions = () => {};
  world.cancelSkilling = () => {};
  world.cancelItemProduction = () => {};
  world.clearCombatTarget = () => {};
  world.markEntityTileOccupantsDirty = () => {};
  world.sendMapChange = () => {};
  world.sendFloorChange = () => {};
  world.sendNearbyVerticalObjectUpdates = () => {};
  world.sendToPlayer = () => {};
  return { world, player };
}

describe('teleport landing validation', () => {
  test('map transitions nudge object-blocked landing tiles to the nearest clear tile', () => {
    const { world, player } = makeWorldHarness();
    world.blockedObjectTiles.add(world.blockedKeyFor('kcmap', 10, 10, 0));

    world.handleMapTransition(player, {
      targetMap: 'kcmap',
      targetX: 10.5,
      targetZ: 10.5,
      targetY: 42,
    });

    expect(player.currentMapLevel).toBe('kcmap');
    expect(player.position.x).toBe(10.5);
    expect(player.position.y).toBe(9.5);
    expect(player.effectiveY).toBe(0);
  });

  test('same-map teleports nudge object-blocked landing tiles and recompute height', () => {
    const { world, player } = makeWorldHarness();
    player.currentMapLevel = 'kcmap';
    world.blockedObjectTiles.add(world.blockedKeyFor('kcmap', 10, 10, 0));

    world.teleportPlayer(player, 10.5, 10.5, 42, 0);

    expect(player.position.x).toBe(10.5);
    expect(player.position.y).toBe(9.5);
    expect(player.effectiveY).toBe(0);
  });
});
