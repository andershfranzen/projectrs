import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { ASSET_TO_OBJECT_DEF, STAIRS_OBJECT_DEF_ID, type PlacedObjectVerticalLink, type WorldObjectDef } from '@projectrs/shared';
import { GameMap } from '../src/GameMap';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { WorldObject } from '../src/entity/WorldObject';

const OBJECTS_PATH = resolve(import.meta.dir, '../data/objects.json');
const MAPS_PATH = resolve(import.meta.dir, '../data/maps');
const STAIR_ASSET_IDS = [
  'stone stairs',
  'stone stairs small',
  'stone small stairs',
  'limestone stairs',
  'WIPStair1',
] as const;

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

interface PlacedObjectJson {
  assetId?: string;
  position?: { x?: number; y?: number; z?: number };
  rotation?: { y?: number };
  verticalLinks?: PlacedObjectVerticalLink[];
}

function stairsDef(): WorldObjectDef {
  const def = (JSON.parse(readFileSync(OBJECTS_PATH, 'utf-8')) as WorldObjectDef[])
    .find(candidate => candidate.id === STAIRS_OBJECT_DEF_ID);
  if (!def) throw new Error(`Missing stairs object definition ${STAIRS_OBJECT_DEF_ID}`);
  return def;
}

function makeWorld(map: GameMap): any {
  const world = Object.create(World.prototype) as any;
  world.db = noopDb;
  world.maps = new Map([[map.id, map]]);
  world.blockedObjectTiles = new Set();
  world.interruptPlayerAction = () => {};
  world.sendChatSystem = () => {};
  world.getPlayerMap = () => map;
  world.teleportPlayer = (player: Player, x: number, z: number, y: number, forcedFloor?: number) => {
    player.position.x = x;
    player.position.y = z;
    if (forcedFloor !== undefined) player.currentFloor = forcedFloor;
    player.effectiveY = y;
  };
  return world;
}

function placedWipStairs(): { mapId: string; object: PlacedObjectJson }[] {
  const placements: { mapId: string; object: PlacedObjectJson }[] = [];
  for (const mapId of readdirSync(MAPS_PATH)) {
    const objectsDir = join(MAPS_PATH, mapId, 'objects');
    let chunks: string[];
    try {
      chunks = readdirSync(objectsDir).filter(name => name.endsWith('.json'));
    } catch {
      continue;
    }
    for (const chunk of chunks) {
      const objects = JSON.parse(readFileSync(join(objectsDir, chunk), 'utf-8')) as PlacedObjectJson[];
      for (const object of objects) {
        if (object.assetId === 'WIPStair1') placements.push({ mapId, object });
      }
    }
  }
  return placements;
}

function linkAction(link: PlacedObjectVerticalLink, reverse: boolean = false): 'Climb-up' | 'Climb-down' {
  const from = reverse ? link.to : link.from;
  const to = reverse ? link.from : link.to;
  const explicit = reverse ? link.toAction : link.fromAction;
  if (explicit === 'Climb-up' || explicit === 'Climb-down') return explicit;
  if (to.floor !== from.floor) return to.floor > from.floor ? 'Climb-up' : 'Climb-down';
  return (to.y ?? 0) > (from.y ?? 0) ? 'Climb-up' : 'Climb-down';
}

describe('placed stair vertical links', () => {
  test('stair GLB assets use the ladder-style object system', () => {
    for (const assetId of STAIR_ASSET_IDS) {
      expect(ASSET_TO_OBJECT_DEF[assetId]).toBe(STAIRS_OBJECT_DEF_ID);
    }

    const def = stairsDef();
    expect(def.name).toBe('Stairs');
    expect(def.category).toBe('ladder');
    expect(def.actions).toEqual(['Climb-up', 'Climb-down', 'Examine']);
    expect(def.blocking).toBe(false);
  });

  test('placed stair GLBs no longer register terrain ramp stairs', () => {
    const map = new GameMap('kcmap');

    expect(map.getStair(219, 156)).toBeNull();
    expect(map.getStair(220, 156)).toBeNull();
    expect(map.getStair(221, 156)).toBeNull();
  });

  test('stair objects climb through explicit verticalLinks', () => {
    const map = new GameMap('kcmap');
    const def = stairsDef();
    const obj = new WorldObject(def, 221.5, 156.5, map.id, 0, 0);
    obj.verticalLinks = [{
      from: { x: 222.5, z: 157.5, floor: 0, y: 0.1701481300406158 },
      to: { x: 222.5, z: 157.5, floor: 1, y: 2.7285314812295938 },
      bidirectional: true,
    }];

    const player = new Player('stair_link_test', 222.5, 157.5, fakeWs, 1);
    player.currentMapLevel = map.id;
    player.currentFloor = 0;
    player.effectiveY = 0;

    const world = makeWorld(map);
    expect(world.ladderActionMaskForPlayer(player, obj) & 2).not.toBe(0);

    world.handleLadderInteraction(player, obj, 'Climb-up');
    expect(player.currentFloor).toBe(1);
    expect(player.effectiveY).toBe(2.7285314812295938);
    expect(player.position.x).toBe(222.5);
    expect(player.position.y).toBe(157.5);
  });

  test('placed WIPStair1 instances are wired as ladder-style links', () => {
    const placements = placedWipStairs();
    expect(placements.length).toBeGreaterThan(0);
    const def = stairsDef();

    for (const { mapId, object } of placements) {
      expect(object.verticalLinks?.length ?? 0).toBeGreaterThan(0);
      expect(object.position?.x).toBeNumber();
      expect(object.position?.z).toBeNumber();

      const map = new GameMap(mapId);
      const world = makeWorld(map);
      const runtimeObject = new WorldObject(
        def,
        object.position!.x!,
        object.position!.z!,
        map.id,
        object.rotation?.y ?? 0,
        object.position?.y ?? 0,
      );
      runtimeObject.verticalLinks = object.verticalLinks;

      for (const link of object.verticalLinks ?? []) {
        for (const reverse of [false, true]) {
          if (reverse && link.bidirectional !== true) continue;
          const from = reverse ? link.to : link.from;
          const to = reverse ? link.from : link.to;
          const action = linkAction(link, reverse);
          const player = new Player(`wip_stair_${mapId}_${from.floor}_${action}`, from.x, from.z, fakeWs, 1);
          player.currentMapLevel = map.id;
          player.currentFloor = from.floor;
          player.effectiveY = from.y ?? 0;

          const mask = world.ladderActionMaskForPlayer(player, runtimeObject);
          expect(mask & (action === 'Climb-up' ? 2 : 1)).not.toBe(0);

          world.handleLadderInteraction(player, runtimeObject, action);
          expect(player.currentFloor).toBe(to.floor);
          expect(player.position.x).toBe(to.x);
          expect(player.position.y).toBe(to.z);
          if (to.y !== undefined) expect(player.effectiveY).toBe(to.y);
        }
      }
    }
  });
});
