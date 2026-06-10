import {
  COOKING_RANGE_OBJECT_DEF_ID,
  KILN_OBJECT_DEF_ID,
  POTTERY_WHEEL_OBJECT_DEF_ID,
  SPINNING_WHEEL_OBJECT_DEF_ID,
} from './constants';

export interface ObjectFootprintDef {
  id?: number;
  category?: string;
  width?: number;
  /** Tile footprint depth in local Z. Defaults to width for legacy square objects. */
  depth?: number;
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
  depth: number;
}

/** Per-tile interaction bitmask. For an object of width W and depth D, the
 *  mask is `2*W + 2*D` bits long and enumerates cardinal-adjacent tiles in
 *  clockwise order, starting from the front-left tile of the +Z side:
 *
 *    bits [0 .. W)       — +Z (front), left → right
 *    next D bits         — +X (right), front → back
 *    next W bits         — -Z (back),  right → left
 *    next D bits         — -X (left),  back → front
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

function normalizeDepth(d: number | undefined, fallbackWidth: number): number {
  return Math.max(1, Math.round(d ?? fallbackWidth));
}

function footprintDimensions(source?: number | ObjectFootprintDef, explicitDepth?: number): { width: number; depth: number } {
  if (typeof source === 'number') {
    const width = normalizeWidth(source);
    return { width, depth: normalizeDepth(explicitDepth, width) };
  }
  const width = normalizeWidth(source?.width);
  return { width, depth: normalizeDepth(source?.depth ?? explicitDepth, width) };
}

function quarterTurns(rotY: number = 0): number {
  return (((Math.round(rotY / (Math.PI / 2)) % 4) + 4) % 4);
}

function worldFootprintDimensions(source?: number | ObjectFootprintDef, rotY: number = 0): { width: number; depth: number } {
  const dims = footprintDimensions(source);
  return quarterTurns(rotY) % 2 === 0
    ? dims
    : { width: dims.depth, depth: dims.width };
}

export function getObjectFootprintMinTile(coord: number, width?: number): number {
  const W = normalizeWidth(width);
  return W % 2 === 0 ? Math.floor(coord - W / 2) : Math.floor(coord) - Math.floor((W - 1) / 2);
}

function footprintMinTile(coord: number, normalizedWidth: number): number {
  const W = normalizedWidth;
  return W % 2 === 0 ? Math.floor(coord - W / 2) : Math.floor(coord) - Math.floor((W - 1) / 2);
}

export function getObjectFootprintCenterCoord(coord: number, width?: number): number {
  const W = normalizeWidth(width);
  return footprintMinTile(coord, W) + W / 2;
}

/** Continuous render/aim center for an entity whose logical anchor can move
 *  between tile centers. The discrete footprint-center helper floors to tile
 *  bounds and is correct for tile logic, but render interpolation must keep
 *  sub-tile movement smooth. */
export function getObjectFootprintContinuousCenterCoord(coord: number, width?: number): number {
  const W = normalizeWidth(width);
  return coord + (W % 2 === 0 ? -0.5 : 0);
}

export function getObjectFootprintBounds(
  x: number,
  z: number,
  defOrWidth?: number | ObjectFootprintDef,
  rotY: number = 0,
): ObjectFootprintBounds {
  const { width, depth } = worldFootprintDimensions(defOrWidth, rotY);
  const minX = footprintMinTile(x, width);
  const minZ = footprintMinTile(z, depth);
  return {
    minX,
    maxX: minX + width - 1,
    minZ,
    maxZ: minZ + depth - 1,
    width,
    depth,
  };
}

export function getObjectFootprintCenter(x: number, z: number, def: ObjectFootprintDef, rotY: number = 0): TileCoord {
  const { minX, minZ, width: W, depth: D } = getObjectFootprintBounds(x, z, def, rotY);
  return {
    x: minX + W / 2,
    z: minZ + D / 2,
  };
}

/** Rotate a local-frame per-tile interaction bitmask into world frame. The
 *  bitmask layout is `4*width` bits in canonical CW order (see file header);
 *  a 90° CW rotation shifts each side block forward by `width` bits.
 *
 *  Width defaults to 1 for backward compat with the legacy 4-bit F/R/B/L
 *  mask — at width=1 the shift-by-W reduces to the previous shift-by-1.   */
export function localSidesToWorldSides(
  localSides: number,
  rotY: number,
  defOrWidth: number | ObjectFootprintDef = 1,
  depth?: number,
): number {
  if (!localSides) return 0;
  const local = footprintDimensions(defOrWidth, depth);
  const world = quarterTurns(rotY) % 2 === 0
    ? local
    : { width: local.depth, depth: local.width };
  const localSideLengths = [local.width, local.depth, local.width, local.depth];
  const worldSideLengths = [world.width, world.depth, world.width, world.depth];
  const totalBits = localSideLengths.reduce((sum, len) => sum + len, 0);
  const full = totalBits === 32 ? 0xFFFFFFFF : ((1 << totalBits) - 1);
  const q = quarterTurns(rotY);
  const m = localSides & full;
  if (!m) return 0;

  let out = 0;
  const localOffsets = [0];
  const worldOffsets = [0];
  for (let i = 0; i < 3; i++) {
    localOffsets.push(localOffsets[i] + localSideLengths[i]);
    worldOffsets.push(worldOffsets[i] + worldSideLengths[i]);
  }

  for (let side = 0; side < 4; side++) {
    const worldSide = (side + q) % 4;
    const len = localSideLengths[side];
    for (let i = 0; i < len; i++) {
      if ((m & (1 << (localOffsets[side] + i))) !== 0) {
        out |= 1 << (worldOffsets[worldSide] + i);
      }
    }
  }
  return out & full;
}

/** Cardinal-adjacent tiles of a width-W footprint in canonical local order
 *  (same enumeration the per-tile interaction bitmask indexes). Anchor is
 *  the object's local origin; offsets are in tile units. */
export function localAdjacentTilesOrdered(width: number, depth?: number): TileCoord[] {
  const W = normalizeWidth(width);
  const D = normalizeDepth(depth, W);
  const minX = W % 2 === 0 ? -W / 2 : -Math.floor((W - 1) / 2);
  const minZ = D % 2 === 0 ? -D / 2 : -Math.floor((D - 1) / 2);
  const maxX = minX + W - 1;
  const maxZ = minZ + D - 1;
  const out: TileCoord[] = [];
  for (let i = 0; i < W; i++) out.push({ x: minX + i, z: maxZ + 1 }); // +Z front, L→R
  for (let i = 0; i < D; i++) out.push({ x: maxX + 1, z: maxZ - i }); // +X right, F→B
  for (let i = 0; i < W; i++) out.push({ x: maxX - i, z: minZ - 1 }); // -Z back,  R→L
  for (let i = 0; i < D; i++) out.push({ x: minX - 1, z: minZ + i }); // -X left,  B→F
  return out;
}

export function getObjectFootprintTiles(x: number, z: number, def: ObjectFootprintDef, rotY: number = 0): TileCoord[] {
  const { minX, minZ, width, depth } = getObjectFootprintBounds(x, z, def, rotY);
  const tiles: TileCoord[] = [];

  for (let dx = 0; dx < width; dx++) {
    for (let dz = 0; dz < depth; dz++) {
      tiles.push({ x: minX + dx, z: minZ + dz });
    }
  }

  return tiles;
}

export function isTileInsideObjectFootprint(
  tileX: number,
  tileZ: number,
  objX: number,
  objZ: number,
  def: ObjectFootprintDef,
  rotY: number = 0,
): boolean {
  const { minX, maxX, minZ, maxZ } = getObjectFootprintBounds(objX, objZ, def, rotY);
  return tileX >= minX && tileX <= maxX && tileZ >= minZ && tileZ <= maxZ;
}

export interface InteractionTileOptions {
  /** World-frame per-tile bitmask (4*width bits). 0 / undefined = all tiles
   *  allowed. Use `localSidesToWorldSides(mask, rotY, def)` to convert a
   *  local-frame mask first. */
  allowedWorldSides?: number;
  /** World rotation of a rectangular footprint. Square footprints are unchanged. */
  rotationY?: number;
  /** Include the four diagonal corner tiles around the footprint. Ignored
   *  when allowedWorldSides is set because side masks have no corner bits. */
  includeCorners?: boolean;
}

export function usesCornerInteractionTiles(def: ObjectFootprintDef, hasInteractionSides: boolean = false): boolean {
  return !hasInteractionSides && def.category === 'tree' && normalizeWidth(def.width) <= 1;
}

/** Crafting stations rely on map-authored collision, not their interaction footprint. */
export function usesMapAuthoredObjectCollision(def: ObjectFootprintDef): boolean {
  return def.category === 'furnace'
    || def.category === 'cookingrange'
    || def.id === COOKING_RANGE_OBJECT_DEF_ID
    || def.id === POTTERY_WHEEL_OBJECT_DEF_ID
    || def.id === KILN_OBJECT_DEF_ID
    || def.id === SPINNING_WHEEL_OBJECT_DEF_ID;
}

/** Map a (dx, dz) cardinal offset from a footprint tile at (ftX, ftZ) to a
 *  bit index in the per-tile world-frame mask. Returns -1 if the offset
 *  doesn't actually leave the footprint (i.e. the candidate is inside).
 *  Width-aware via the precomputed footprint bounds passed in. */
function adjacentBitIndex(
  ftX: number, ftZ: number, dx: number, dz: number,
  minX: number, maxX: number, minZ: number, maxZ: number, W: number, D: number,
): number {
  const tx = ftX + dx;
  const tz = ftZ + dz;
  if (tz === maxZ + 1 && tx >= minX && tx <= maxX) return (tx - minX);            // +Z, L→R
  if (tx === maxX + 1 && tz >= minZ && tz <= maxZ) return W + (maxZ - tz);        // +X, F→B
  if (tz === minZ - 1 && tx >= minX && tx <= maxX) return W + D + (maxX - tx);    // -Z, R→L
  if (tx === minX - 1 && tz >= minZ && tz <= maxZ) return 2 * W + D + (tz - minZ); // -X, B→F
  return -1;
}

export function getObjectInteractionTiles(
  x: number,
  z: number,
  def: ObjectFootprintDef,
  opts?: InteractionTileOptions,
): TileCoord[] {
  const { minX, maxX, minZ, maxZ, width: W, depth: D } = getObjectFootprintBounds(x, z, def, opts?.rotationY);
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
  for (let i = 0; i < D; i++) {
    const bit = W + i;
    if (allowed === undefined || (allowed & (1 << bit)) !== 0) {
      tiles.push({ x: maxX + 1, z: maxZ - i });
    }
  }
  for (let i = 0; i < W; i++) {
    const bit = W + D + i;
    if (allowed === undefined || (allowed & (1 << bit)) !== 0) {
      tiles.push({ x: maxX - i, z: minZ - 1 });
    }
  }
  for (let i = 0; i < D; i++) {
    const bit = 2 * W + D + i;
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
  const { width: W, depth: D } = worldFootprintDimensions(def, opts?.rotationY);
  const minX = footprintMinTile(objX, W);
  const maxX = minX + W - 1;
  const minZ = footprintMinTile(objZ, D);
  const maxZ = minZ + D - 1;

  // Inside footprint → not adjacent.
  if (tileX >= minX && tileX <= maxX && tileZ >= minZ && tileZ <= maxZ) return false;

  // Classify cardinal side + per-side index, then check the matching bit.
  const bit = adjacentBitIndex(tileX, tileZ, 0, 0, minX, maxX, minZ, maxZ, W, D);
  const allowed = opts?.allowedWorldSides;
  if (bit >= 0) return allowed === undefined || (allowed & (1 << bit)) !== 0;

  if (allowed === undefined && opts?.includeCorners) {
    const cornerX = tileX === minX - 1 || tileX === maxX + 1;
    const cornerZ = tileZ === minZ - 1 || tileZ === maxZ + 1;
    return cornerX && cornerZ;
  }
  return false;
}
