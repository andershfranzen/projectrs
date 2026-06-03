import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { MapMeta, WorldObjectDef } from '@projectrs/shared';
import { GameMap } from '../src/GameMap';

const MAPS_DIR = resolve(import.meta.dir, '../data/maps');
const OBJECTS_PATH = resolve(import.meta.dir, '../data/objects.json');

type PlacedTeleport = {
  mapId: string;
  file: string;
  index: number;
  assetId: string;
  trigger: { type: string; destChunk: string; entryX: number; entryY: number; entryZ: number };
};

function loadMapMetas(): Map<string, MapMeta> {
  const metas = new Map<string, MapMeta>();
  for (const entry of readdirSync(MAPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = resolve(MAPS_DIR, entry.name, 'meta.json');
    if (!existsSync(metaPath)) continue;
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as MapMeta;
    metas.set(entry.name, meta);
  }
  return metas;
}

function placedTeleports(): PlacedTeleport[] {
  const out: PlacedTeleport[] = [];
  for (const entry of readdirSync(MAPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const mapId = entry.name;
    const objectsDir = resolve(MAPS_DIR, mapId, 'objects');
    if (!existsSync(objectsDir)) continue;
    for (const file of readdirSync(objectsDir).sort()) {
      if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
      const placed = JSON.parse(readFileSync(resolve(objectsDir, file), 'utf-8')) as Array<{
        assetId?: string;
        trigger?: PlacedTeleport['trigger'];
      }>;
      placed.forEach((obj, index) => {
        if (obj.assetId && obj.trigger?.type === 'teleport') {
          out.push({
            mapId,
            file: `${mapId}/objects/${file}`,
            index,
            assetId: obj.assetId,
            trigger: obj.trigger,
          });
        }
      });
    }
  }
  return out;
}

function mapCache(): (mapId: string) => GameMap {
  const maps = new Map<string, GameMap>();
  return (mapId: string) => {
    let map = maps.get(mapId);
    if (!map) {
      map = new GameMap(mapId);
      maps.set(mapId, map);
    }
    return map;
  };
}

function expectLandingIsValid(map: GameMap, x: number, z: number, label: string): void {
  expect(Number.isFinite(x), `${label} x must be finite`).toBe(true);
  expect(Number.isFinite(z), `${label} z must be finite`).toBe(true);
  expect(x, `${label} x must be in bounds`).toBeGreaterThanOrEqual(0);
  expect(z, `${label} z must be in bounds`).toBeGreaterThanOrEqual(0);
  expect(x, `${label} x must be in bounds`).toBeLessThan(map.width);
  expect(z, `${label} z must be in bounds`).toBeLessThan(map.height);
  expect(map.isTileBlockedOnFloor(Math.floor(x), Math.floor(z), 0), `${label} landing tile must be walkable`).toBe(false);
}

describe('teleport data audit', () => {
  test('placed object teleports point at exact map ids and walkable landing tiles', () => {
    const metas = loadMapMetas();
    const getMap = mapCache();
    for (const entry of placedTeleports()) {
      const label = `${entry.file}[${entry.index}] ${entry.assetId} -> ${entry.trigger.destChunk}`;
      expect(metas.has(entry.trigger.destChunk), `${label} target map must exist`).toBe(true);
      expectLandingIsValid(getMap(entry.trigger.destChunk), entry.trigger.entryX, entry.trigger.entryZ, label);
    }
  });

  test('static object and map transitions point at exact map ids and walkable landing tiles', () => {
    const metas = loadMapMetas();
    const getMap = mapCache();
    const objectDefs = JSON.parse(readFileSync(OBJECTS_PATH, 'utf-8')) as WorldObjectDef[];
    for (const def of objectDefs) {
      if (!def.transition) continue;
      const label = `objects.json def ${def.id} ${def.name} -> ${def.transition.targetMap}`;
      expect(metas.has(def.transition.targetMap), `${label} target map must exist`).toBe(true);
      expectLandingIsValid(getMap(def.transition.targetMap), def.transition.targetX, def.transition.targetZ, label);
    }

    for (const [mapId, meta] of metas) {
      for (const [index, transition] of (meta.transitions ?? []).entries()) {
        const label = `${mapId}/meta.json transitions[${index}] -> ${transition.targetMap}`;
        expect(metas.has(transition.targetMap), `${label} target map must exist`).toBe(true);
        expectLandingIsValid(getMap(transition.targetMap), transition.targetX, transition.targetZ, label);
      }
    }
  });
});
