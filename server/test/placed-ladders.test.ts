import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { basename, resolve } from 'path';
import { ASSET_TO_OBJECT_DEF, type WorldObjectDef } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { WorldObject } from '../src/entity/WorldObject';
import { GameMap } from '../src/GameMap';

const MAPS_DIR = resolve(import.meta.dir, '../data/maps');
const OBJECTS_PATH = resolve(import.meta.dir, '../data/objects.json');
const LADDER_DEF_ID = ASSET_TO_OBJECT_DEF.Ladder;
const DECORATIVE_LADDER_KEYS = [
  'kcmap:69.525,50.500',
];

type PlacedLadder = {
  mapId: string;
  file: string;
  index: number;
  position: { x: number; y: number; z: number };
  rotation?: { x?: number; y?: number; z?: number };
  interactionTiles?: { x: number; z: number }[];
  verticalLinks?: Array<{
    from: { mapId?: string; x: number; z: number; floor: number; y?: number };
    to: { mapId?: string; x: number; z: number; floor: number; y?: number };
    fromAction?: 'Climb-up' | 'Climb-down';
    toAction?: 'Climb-up' | 'Climb-down';
    bidirectional?: boolean;
  }>;
};

const fakeWs = {
  sendBinary() {},
  send() {},
  close() {},
} as any;

const noopDb = {
  savePlayerState() {},
  savePlayerPositionsBatch() {},
  applyObjectRespawnWritesBatch() {},
};

function ladderKey(ladder: Pick<PlacedLadder, 'mapId' | 'position'>): string {
  return `${ladder.mapId}:${ladder.position.x.toFixed(3)},${ladder.position.z.toFixed(3)}`;
}

function placedLadders(): PlacedLadder[] {
  const out: PlacedLadder[] = [];
  for (const entry of readdirSync(MAPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mapId = entry.name;
    const objectsDir = resolve(MAPS_DIR, mapId, 'objects');
    if (!existsSync(objectsDir)) continue;
    for (const file of readdirSync(objectsDir).sort()) {
      if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
      const fullPath = resolve(objectsDir, file);
      const placed = JSON.parse(readFileSync(fullPath, 'utf-8')) as Array<Partial<PlacedLadder> & { assetId?: string }>;
      placed.forEach((obj, index) => {
        if (obj.assetId !== 'Ladder' || !obj.position) return;
        out.push({
          mapId,
          file: `${mapId}/objects/${file}`,
          index,
          position: obj.position,
          rotation: obj.rotation,
          interactionTiles: obj.interactionTiles,
          verticalLinks: obj.verticalLinks ?? [],
        });
      });
    }
  }
  return out.sort((a, b) => ladderKey(a).localeCompare(ladderKey(b)));
}

function makeWorld(maps: Map<string, GameMap>): any {
  const world = Object.create(World.prototype) as any;
  world.db = noopDb;
  world.maps = maps;
  world.blockedObjectTiles = new Set();
  world.interruptPlayerAction = () => {};
  world.getPlayerMap = (player: Player) => maps.get(player.currentMapLevel);
  world.teleportPlayer = (player: Player, x: number, z: number, y: number, forcedFloor?: number) => {
    player.position.x = x;
    player.position.y = z;
    if (forcedFloor !== undefined) player.currentFloor = forcedFloor;
    player.effectiveY = y;
  };
  return world;
}

function createRuntimeLadder(def: WorldObjectDef, placed: PlacedLadder): WorldObject {
  const obj = new WorldObject(def, placed.position.x, placed.position.z, placed.mapId, 0, placed.position.y);
  obj.rotationY = placed.rotation?.y ?? 0;
  obj.verticalLinks = placed.verticalLinks;
  obj.interactionTiles = placed.interactionTiles;
  return obj;
}

function inferredAction(
  from: { floor: number; y?: number },
  to: { floor: number; y?: number },
): 'Climb-up' | 'Climb-down' {
  if (to.floor !== from.floor) return to.floor > from.floor ? 'Climb-up' : 'Climb-down';
  return (to.y ?? 0) > (from.y ?? 0) ? 'Climb-up' : 'Climb-down';
}

function endpointIsWalkable(map: GameMap, endpoint: { x: number; z: number; floor: number; y?: number }): boolean {
  if (map.isTileBlockedOnFloor(Math.floor(endpoint.x), Math.floor(endpoint.z), Math.floor(endpoint.floor))) return false;
  if (endpoint.y === undefined) return true;
  return map.getWalkableFloorTargetsAt(endpoint.x, endpoint.z)
    .some(target => target.floor === Math.floor(endpoint.floor) && Math.abs(target.y - endpoint.y!) <= 0.75);
}

describe('placed ladder audit', () => {
  test('every placed Ladder is either linked or an intentional decorative placement', () => {
    const ladders = placedLadders();
    expect(ladders).toHaveLength(9);

    const decorative = ladders.filter(ladder => (ladder.verticalLinks ?? []).length === 0);
    expect(decorative.map(ladderKey).sort()).toEqual([...DECORATIVE_LADDER_KEYS].sort());
  });

  test('every authored placed ladder link exposes the intended action and lands on a walkable tile', () => {
    const ladderDef = (JSON.parse(readFileSync(OBJECTS_PATH, 'utf-8')) as WorldObjectDef[])
      .find(def => def.id === LADDER_DEF_ID);
    expect(ladderDef).toBeDefined();

    const ladders = placedLadders().filter(ladder => (ladder.verticalLinks ?? []).length > 0);
    const maps = new Map<string, GameMap>();
    for (const ladder of ladders) {
      if (!maps.has(ladder.mapId)) maps.set(ladder.mapId, new GameMap(ladder.mapId));
    }
    const world = makeWorld(maps);

    for (const ladder of ladders) {
      const obj = createRuntimeLadder(ladderDef!, ladder);
      for (const [linkIndex, link] of (ladder.verticalLinks ?? []).entries()) {
        const fromMapId = link.from.mapId ?? ladder.mapId;
        const toMapId = link.to.mapId ?? ladder.mapId;
        const fromMap = maps.get(fromMapId);
        const toMap = maps.get(toMapId);
        expect(fromMap, `${ladder.file} link ${linkIndex} from map missing`).toBeDefined();
        expect(toMap, `${ladder.file} link ${linkIndex} to map missing`).toBeDefined();
        expect(endpointIsWalkable(fromMap!, link.from), `${ladder.file} link ${linkIndex} source is not walkable`).toBe(true);
        expect(endpointIsWalkable(toMap!, link.to), `${ladder.file} link ${linkIndex} destination is not walkable`).toBe(true);
        expect(link.from.y, `${ladder.file} link ${linkIndex} source must pin its exact Y`).toBeNumber();
        expect(link.to.y, `${ladder.file} link ${linkIndex} destination must pin its exact Y`).toBeNumber();

        const action = link.fromAction ?? inferredAction(link.from, link.to);
        expect(action, `${ladder.file} link ${linkIndex} action must match destination direction`)
          .toBe(inferredAction(link.from, link.to));

        const player = new Player(`ladder-${basename(ladder.file)}-${linkIndex}`, link.from.x, link.from.z, fakeWs, linkIndex + 1);
        player.currentMapLevel = fromMapId;
        player.currentFloor = Math.floor(link.from.floor);
        player.effectiveY = link.from.y ?? fromMap!.getEffectiveHeightOnFloor(link.from.x, link.from.z, player.currentFloor, Number.POSITIVE_INFINITY);

        const expectedBit = action === 'Climb-up' ? 2 : 1;
        expect(world.ladderActionMaskForPlayer(player, obj) & expectedBit, `${ladder.file} link ${linkIndex} missing ${action} mask`).not.toBe(0);
        expect(world.ladderInteractionTilesForPlayer(player, obj), `${ladder.file} link ${linkIndex} interaction tile missing`)
          .toContainEqual({ x: Math.floor(link.from.x), z: Math.floor(link.from.z) });

        const resolved = world.resolveLadderLinkForPlayerAction(player, obj, action);
        expect(resolved, `${ladder.file} link ${linkIndex} does not resolve for ${action}`).not.toBeNull();
        expect(resolved.to.mapId).toBe(toMapId);
        expect(resolved.to.floor).toBe(Math.floor(link.to.floor));
        expect(Math.floor(resolved.to.x)).toBe(Math.floor(link.to.x));
        expect(Math.floor(resolved.to.z)).toBe(Math.floor(link.to.z));
        expect(world.isAdjacentToObject(player, obj), `${ladder.file} link ${linkIndex} would fail adjacency`).toBe(true);

        world.handleLadderInteraction(player, obj, action);
        expect(player.currentMapLevel).toBe(toMapId);
        expect(player.currentFloor).toBe(Math.floor(link.to.floor));
        expect(Math.floor(player.position.x)).toBe(Math.floor(link.to.x));
        expect(Math.floor(player.position.y)).toBe(Math.floor(link.to.z));
        if (link.to.y !== undefined) expect(player.effectiveY).toBe(link.to.y);
      }
    }
  });
});
