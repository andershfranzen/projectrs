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

/** Side bitmask. World frame uses absolute (dx,dz); local frame is relative to
 *  the object's forward (+Z at rotY=0). Bit layout for both:
 *    +Z = 1, +X = 2, -Z = 4, -X = 8
 *  In local frame this reads as FRONT/RIGHT/BACK/LEFT. */
export const SIDE_PLUS_Z = 1;
export const SIDE_PLUS_X = 2;
export const SIDE_MINUS_Z = 4;
export const SIDE_MINUS_X = 8;
export const SIDE_ALL = 0xF;
export const SIDE_FRONT = SIDE_PLUS_Z;
export const SIDE_RIGHT = SIDE_PLUS_X;
export const SIDE_BACK = SIDE_MINUS_Z;
export const SIDE_LEFT = SIDE_MINUS_X;

/** Rotate a local-frame side bitmask into world frame using the object's Y rotation.
 *  rotY is snapped to the nearest 90° step before rotating. A local FRONT (+Z)
 *  at rotY=π/2 maps to world +X. */
export function localSidesToWorldSides(localSides: number, rotY: number): number {
  if (!localSides) return 0;
  const q = (((Math.round(rotY / (Math.PI / 2)) % 4) + 4) % 4);
  const m = localSides & 0xF;
  return ((m << q) | (m >>> (4 - q))) & 0xF;
}

function sideBitFromOffset(dx: number, dz: number): number {
  if (dx === 0 && dz === 1) return SIDE_PLUS_Z;
  if (dx === 1 && dz === 0) return SIDE_PLUS_X;
  if (dx === 0 && dz === -1) return SIDE_MINUS_Z;
  if (dx === -1 && dz === 0) return SIDE_MINUS_X;
  return 0;
}

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

export interface InteractionTileOptions {
  /** World-frame side bitmask. 0 / undefined = all sides allowed. Use
   *  localSidesToWorldSides() to convert a local-frame mask first. */
  allowedWorldSides?: number;
}

export function getObjectInteractionTiles(
  x: number,
  z: number,
  def: ObjectFootprintDef,
  opts?: InteractionTileOptions,
): TileCoord[] {
  const footprint = getObjectFootprintTiles(x, z, def);
  const footprintKeys = new Set(footprint.map(tileKey));
  const seen = new Set<string>();
  const tiles: TileCoord[] = [];
  const allowed = opts?.allowedWorldSides;

  for (const tile of footprint) {
    for (const dir of CARDINAL_DIRS) {
      if (allowed) {
        const bit = sideBitFromOffset(dir.x, dir.z);
        if ((allowed & bit) === 0) continue;
      }
      const candidate = { x: tile.x + dir.x, z: tile.z + dir.z };
      const key = tileKey(candidate);
      if (footprintKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      tiles.push(candidate);
    }
  }

  return tiles;
}

export function isTileAdjacentToObject(
  tileX: number,
  tileZ: number,
  objX: number,
  objZ: number,
  def: ObjectFootprintDef,
  opts?: InteractionTileOptions,
): boolean {
  // Allocation-free: derive footprint bounds, classify (tileX,tileZ) against them.
  // Called every tick per active skiller (World.tickPlayerSkilling), so the
  // previous Set/Array enumeration was wasted work.
  const centerTileX = Math.floor(objX);
  const centerTileZ = Math.floor(objZ);
  const span = Math.max(1, Math.round(def.width ?? 1));
  const minX = centerTileX - Math.floor((span - 1) / 2);
  const maxX = minX + span - 1;
  const minZ = centerTileZ - Math.floor((span - 1) / 2);
  const maxZ = minZ + span - 1;

  // Inside footprint → not adjacent.
  if (tileX >= minX && tileX <= maxX && tileZ >= minZ && tileZ <= maxZ) return false;

  const inXBand = tileX >= minX && tileX <= maxX;
  const inZBand = tileZ >= minZ && tileZ <= maxZ;
  let sideBit = 0;
  if (inXBand && tileZ === minZ - 1) sideBit = SIDE_MINUS_Z;
  else if (inXBand && tileZ === maxZ + 1) sideBit = SIDE_PLUS_Z;
  else if (inZBand && tileX === minX - 1) sideBit = SIDE_MINUS_X;
  else if (inZBand && tileX === maxX + 1) sideBit = SIDE_PLUS_X;
  else return false; // diagonal or further — not cardinal-adjacent

  const allowed = opts?.allowedWorldSides;
  return !allowed || (allowed & sideBit) !== 0;
}

function tileKey(tile: TileCoord): string {
  return `${tile.x},${tile.z}`;
}
