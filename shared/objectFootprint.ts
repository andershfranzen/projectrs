export interface ObjectFootprintDef {
  category?: string;
  width?: number;
}

export interface TileCoord {
  x: number;
  z: number;
}

/** OSRS-style: interaction is allowed from the 4 cardinal neighbours of an
 *  object's footprint only. Diagonals are NOT adjacent — standing in the
 *  corner of a 2×2 around an object should require taking one more step. */
const CARDINAL_DIRS: readonly TileCoord[] = [
  { x: 0, z: -1 },
  { x: 0, z: 1 },
  { x: -1, z: 0 },
  { x: 1, z: 0 },
];

export function getObjectFootprintTiles(x: number, z: number, def: ObjectFootprintDef): TileCoord[] {
  const centerTileX = Math.floor(x);
  const centerTileZ = Math.floor(z);
  const span = Math.max(1, Math.round(def.width ?? 1));
  const startOffset = -Math.floor((span - 1) / 2);
  const tiles: TileCoord[] = [];

  for (let dx = 0; dx < span; dx++) {
    for (let dz = 0; dz < span; dz++) {
      tiles.push({ x: centerTileX + startOffset + dx, z: centerTileZ + startOffset + dz });
    }
  }

  return tiles;
}

export function getObjectInteractionTiles(x: number, z: number, def: ObjectFootprintDef): TileCoord[] {
  const footprint = getObjectFootprintTiles(x, z, def);
  const footprintKeys = new Set(footprint.map(tileKey));
  const seen = new Set<string>();
  const tiles: TileCoord[] = [];

  for (const tile of footprint) {
    for (const dir of CARDINAL_DIRS) {
      const candidate = { x: tile.x + dir.x, z: tile.z + dir.z };
      const key = tileKey(candidate);
      if (footprintKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      tiles.push(candidate);
    }
  }

  return tiles;
}

export function isTileAdjacentToObject(tileX: number, tileZ: number, objX: number, objZ: number, def: ObjectFootprintDef): boolean {
  return getObjectInteractionTiles(objX, objZ, def).some(tile => tile.x === tileX && tile.z === tileZ);
}

function tileKey(tile: TileCoord): string {
  return `${tile.x},${tile.z}`;
}
