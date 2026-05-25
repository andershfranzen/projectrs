import type { FloorLayerData, WallsFile } from '@projectrs/shared';

export interface PreserveFloorLayerTilesOptions {
  /** The editor currently sends empty tile records when it cannot author them.
   *  Keep treating that as "missing" for save protection. */
  preserveEmptyTileRecords?: boolean;
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function hasRecordEntries(record: Record<string, unknown> | undefined): boolean {
  return !!record && Object.keys(record).length > 0;
}

function shouldPreserveTiles(
  incomingHasTiles: boolean,
  incomingTiles: Record<string, unknown> | undefined,
  existingTiles: Record<string, unknown> | undefined,
  preserveEmptyTileRecords: boolean,
): boolean {
  if (!hasRecordEntries(existingTiles)) return false;
  if (!incomingHasTiles) return true;
  return preserveEmptyTileRecords && !hasRecordEntries(incomingTiles);
}

export function preserveExistingFloorLayerTiles(
  incoming: WallsFile,
  existing: WallsFile | null,
  options: PreserveFloorLayerTilesOptions = {},
): WallsFile {
  if (!existing) return incoming;

  const preserveEmptyTileRecords = options.preserveEmptyTileRecords ?? true;
  let changed = false;
  const next: WallsFile = { ...incoming };
  if (shouldPreserveTiles(hasOwn(next, 'tiles'), next.tiles, existing.tiles, preserveEmptyTileRecords)) {
    next.tiles = existing.tiles;
    changed = true;
  }

  const existingLayers = existing.floorLayers ?? {};
  if (!hasRecordEntries(existingLayers as Record<string, unknown>)) {
    return changed ? next : incoming;
  }

  const nextLayers: Record<string, FloorLayerData> = { ...((next.floorLayers ?? {}) as Record<string, FloorLayerData>) };
  for (const [floor, existingLayer] of Object.entries(existingLayers) as [string, FloorLayerData][]) {
    const incomingLayer = nextLayers[floor];
    if (!incomingLayer) {
      if (hasRecordEntries(existingLayer.tiles)) {
        nextLayers[floor] = { walls: {}, tiles: existingLayer.tiles };
        changed = true;
      }
      continue;
    }
    if (shouldPreserveTiles(hasOwn(incomingLayer, 'tiles'), incomingLayer.tiles, existingLayer.tiles, preserveEmptyTileRecords)) {
      nextLayers[floor] = { ...incomingLayer, tiles: existingLayer.tiles };
      changed = true;
    }
  }

  if (changed) next.floorLayers = nextLayers as unknown as Record<number, FloorLayerData>;
  return changed ? next : incoming;
}
