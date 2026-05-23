export interface ObjectFootprintDef {
  category?: string;
  width?: number;
}

export interface TileCoord {
  x: number;
  z: number;
}

export interface ObjectFootprintBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  width: number;
}

/** Per-tile interaction bitmask. For an object of width W, the mask is
 *  `4*W` bits long and enumerates cardinal-adjacent tiles in canonical
 *  clockwise order, starting from the front-left tile of the +Z side:
 *
 *    bits [0 .. W)       — +Z (front), left → right
 *    bits [W .. 2W)      — +X (right), front → back
 *    bits [2W .. 3W)     — -Z (back),  right → left
 *    bits [3W .. 4W)     — -X (left),  back → front
 *
 *  CW order means rotating the object 90° CW (rotY += π/2) shifts the bitmask
 *  left by exactly W bits, so the same local-frame mask describes the same
 *  visual relationship to the model at any rotation.
 *
 *  For W=1 this collapses to the legacy 4-bit F/R/B/L layout:
 *    bit 0 = SIDE_PLUS_Z = FRONT
 *    bit 1 = SIDE_PLUS_X = RIGHT
 *    bit 2 = SIDE_MINUS_Z = BACK
 *    bit 3 = SIDE_MINUS_X = LEFT */

export const SIDE_PLUS_Z = 1;
export const SIDE_PLUS_X = 2;
export const SIDE_MINUS_Z = 4;
export const SIDE_MINUS_X = 8;
export const SIDE_ALL = 0xF;
export const SIDE_FRONT = SIDE_PLUS_Z;
export const SIDE_RIGHT = SIDE_PLUS_X;
export const SIDE_BACK = SIDE_MINUS_Z;
export const SIDE_LEFT = SIDE_MINUS_X;

function normalizeWidth(w: number | undefined): number {
  return Math.max(1, Math.round(w ?? 1));
}

export function getObjectFootprintMinTile(coord: number, width?: number): number {
  const W = normalizeWidth(width);
  return W % 2 === 0 ? Math.floor(coord - W / 2) : Math.floor(coord) - Math.floor((W - 1) / 2);
}

function footprintMinTile(coord: number, normalizedWidth: number): number {
  const W = normalizedWidth;
  return W % 2 === 0 ? Math.floor(coord - W / 2) : Math.floor(coord) - Math.floor((W - 1) / 2);
}

export function getObjectFootprintBounds(x: number, z: number, width?: number): ObjectFootprintBounds {
  const W = normalizeWidth(width);
  const minX = footprintMinTile(x, W);
  const minZ = footprintMinTile(z, W);
  return {
    minX,
    maxX: minX + W - 1,
    minZ,
    maxZ: minZ + W - 1,
    width: W,
  };
}

/** Rotate a local-frame per-tile interaction bitmask into world frame. The
 *  bitmask layout is `4*width` bits in canonical CW order (see file header);
 *  a 90° CW rotation shifts each side block forward by `width` bits.
 *
 *  Width defaults to 1 for backward compat with the legacy 4-bit F/R/B/L
 *  mask — at width=1 the shift-by-W reduces to the previous shift-by-1.   */
export function localSidesToWorldSides(localSides: number, rotY: number, width: number = 1): number {
  if (!localSides) return 0;
  const W = normalizeWidth(width);
  const totalBits = 4 * W;
  const full = totalBits === 32 ? 0xFFFFFFFF : ((1 << totalBits) - 1);
  const q = (((Math.round(rotY / (Math.PI / 2)) % 4) + 4) % 4);
  const shift = q * W;
  const m = localSides & full;
  if (shift === 0) return m;
  return ((m << shift) | (m >>> (totalBits - shift))) & full;
}

/** Cardinal-adjacent tiles of a width-W footprint in canonical local order
 *  (same enumeration the per-tile interaction bitmask indexes). Anchor is
 *  the object's local origin; offsets are in tile units. */
export function localAdjacentTilesOrdered(width: number): TileCoord[] {
  const W = normalizeWidth(width);
  const startOff = W % 2 === 0 ? -W / 2 : -Math.floor((W - 1) / 2);
  const minTile = startOff;
  const maxTile = startOff + W - 1;
  const out: TileCoord[] = [];
  for (let i = 0; i < W; i++) out.push({ x: minTile + i, z: maxTile + 1 }); // +Z front, L→R
  for (let i = 0; i < W; i++) out.push({ x: maxTile + 1, z: maxTile - i }); // +X right, F→B
  for (let i = 0; i < W; i++) out.push({ x: maxTile - i, z: minTile - 1 }); // -Z back,  R→L
  for (let i = 0; i < W; i++) out.push({ x: minTile - 1, z: minTile + i }); // -X left,  B→F
  return out;
}

export function getObjectFootprintTiles(x: number, z: number, def: ObjectFootprintDef): TileCoord[] {
  const { minX, minZ, width: span } = getObjectFootprintBounds(x, z, def.width);
  const tiles: TileCoord[] = [];

  for (let dx = 0; dx < span; dx++) {
    for (let dz = 0; dz < span; dz++) {
      tiles.push({ x: minX + dx, z: minZ + dz });
    }
  }

  return tiles;
}

export interface InteractionTileOptions {
  /** World-frame per-tile bitmask (4*width bits). 0 / undefined = all tiles
   *  allowed. Use `localSidesToWorldSides(mask, rotY, width)` to convert a
   *  local-frame mask first. */
  allowedWorldSides?: number;
  /** Include the four diagonal corner tiles around the footprint. Ignored
   *  when allowedWorldSides is set because side masks have no corner bits. */
  includeCorners?: boolean;
}

export function usesCornerInteractionTiles(def: ObjectFootprintDef, hasInteractionSides: boolean = false): boolean {
  return !hasInteractionSides && def.category === 'tree' && normalizeWidth(def.width) <= 1;
}

/** Map a (dx, dz) cardinal offset from a footprint tile at (ftX, ftZ) to a
 *  bit index in the per-tile world-frame mask. Returns -1 if the offset
 *  doesn't actually leave the footprint (i.e. the candidate is inside).
 *  Width-aware via the precomputed footprint bounds passed in. */
function adjacentBitIndex(
  ftX: number, ftZ: number, dx: number, dz: number,
  minX: number, maxX: number, minZ: number, maxZ: number, W: number,
): number {
  const tx = ftX + dx;
  const tz = ftZ + dz;
  if (tz === maxZ + 1 && tx >= minX && tx <= maxX) return (tx - minX);            // +Z, L→R
  if (tx === maxX + 1 && tz >= minZ && tz <= maxZ) return W + (maxZ - tz);        // +X, F→B
  if (tz === minZ - 1 && tx >= minX && tx <= maxX) return 2 * W + (maxX - tx);    // -Z, R→L
  if (tx === minX - 1 && tz >= minZ && tz <= maxZ) return 3 * W + (tz - minZ);    // -X, B→F
  return -1;
}

export function getObjectInteractionTiles(
  x: number,
  z: number,
  def: ObjectFootprintDef,
  opts?: InteractionTileOptions,
): TileCoord[] {
  const { minX, maxX, minZ, maxZ, width: W } = getObjectFootprintBounds(x, z, def.width);
  const allowed = opts?.allowedWorldSides;
  const tiles: TileCoord[] = [];
  // Enumerate in the same canonical CW order the bitmask indexes — duplicates
  // can't arise (the 4 sides are disjoint outside the footprint), so no Set
  // dedup needed.
  for (let i = 0; i < W; i++) {
    const bit = i;
    if (allowed === undefined || (allowed & (1 << bit)) !== 0) {
      tiles.push({ x: minX + i, z: maxZ + 1 });
    }
  }
  for (let i = 0; i < W; i++) {
    const bit = W + i;
    if (allowed === undefined || (allowed & (1 << bit)) !== 0) {
      tiles.push({ x: maxX + 1, z: maxZ - i });
    }
  }
  for (let i = 0; i < W; i++) {
    const bit = 2 * W + i;
    if (allowed === undefined || (allowed & (1 << bit)) !== 0) {
      tiles.push({ x: maxX - i, z: minZ - 1 });
    }
  }
  for (let i = 0; i < W; i++) {
    const bit = 3 * W + i;
    if (allowed === undefined || (allowed & (1 << bit)) !== 0) {
      tiles.push({ x: minX - 1, z: minZ + i });
    }
  }
  if (allowed === undefined && opts?.includeCorners) {
    tiles.push({ x: minX - 1, z: maxZ + 1 });
    tiles.push({ x: maxX + 1, z: maxZ + 1 });
    tiles.push({ x: maxX + 1, z: minZ - 1 });
    tiles.push({ x: minX - 1, z: minZ - 1 });
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
  // Allocation-free fast path — World.tickPlayerSkilling calls this every
  // tick per active skiller.
  const W = normalizeWidth(def.width);
  const minX = footprintMinTile(objX, W);
  const maxX = minX + W - 1;
  const minZ = footprintMinTile(objZ, W);
  const maxZ = minZ + W - 1;

  // Inside footprint → not adjacent.
  if (tileX >= minX && tileX <= maxX && tileZ >= minZ && tileZ <= maxZ) return false;

  // Classify cardinal side + per-side index, then check the matching bit.
  const bit = adjacentBitIndex(tileX, tileZ, 0, 0, minX, maxX, minZ, maxZ, W);
  const allowed = opts?.allowedWorldSides;
  if (bit >= 0) return allowed === undefined || (allowed & (1 << bit)) !== 0;

  if (allowed === undefined && opts?.includeCorners) {
    const cornerX = tileX === minX - 1 || tileX === maxX + 1;
    const cornerZ = tileZ === minZ - 1 || tileZ === maxZ + 1;
    return cornerX && cornerZ;
  }
  return false;
}
