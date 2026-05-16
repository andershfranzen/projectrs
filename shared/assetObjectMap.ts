/**
 * Maps editor-placed asset IDs (GLB model names) to game object definition IDs (objects.json).
 * This is the single source of truth for which placed objects are interactable game objects.
 *
 * To add a new interactable object:
 * 1. Add GLB to editor assets + assets.json
 * 2. Add entry to server/data/objects.json
 * 3. Add mapping here: 'assetId': objectDefId
 * 4. Place in editor, save to server — done
 */
export const ASSET_TO_OBJECT_DEF: Record<string, number> = {
  // Trees -> objectId 1 (Tree)
  'sTree 1': 1,
  'sTree 2': 1,
  'stree 3': 1,
  'sTree4': 1,
  'stree autumn': 1,
  'dying tree': 1,
  // Oak -> objectId 2 (Oak Tree)
  'oaktree2': 2,
  // Willow -> objectId 9 (Willow Tree)
  'willow tree': 9,
  // Dead -> objectId 10 (Dead Tree)
  'DeadTreeLam': 10,
  // Rocks
  'CopperRock': 3,  // Copper Rock
  'IronRock': 4,    // Iron Rock
  'TinRock': 11,    // Tin Rock
  'CoalRock': 12,   // Coal Rock
  // Crafting stations
  'forge': 6,        // Furnace
  'cookingrange': 7, // Cooking Range
  'anvil': 19,       // Anvil (smithing)
  // Doors (only Truedoor assets — other "door" assets are decorative door frames)
  'castleTruedoor': 13,
  'basicTruedoor': 13,
  // Cave entrances
  'cavedoor': 15,  // Cave Entrance -> map transition
  // Floor transitions
  'Ladder': 23,
  // Chests (roguery / lockpicking). Closed asset is interactable; the open
  // variant is the depleted-state visual loaded by WorldObjectModels and
  // never needs its own mapping. Add a new entry per chest tier when a
  // distinct closed GLB ships.
  'closed chest': 20, // Wooden Chest
  // Crops
  'rice': 22, // Rice Plant
};

/**
 * Decoration assets that should block their tile but aren't interactable —
 * no right-click menu, no harvest, no WorldObject entity. Kept thin-instanced
 * on the client (see `canThinInstance`) so adding many is cheap. Server stamps
 * the tile into `blockedObjectTiles` at map load; client stamps into
 * `ChunkManager.decorBlockedTiles` as chunks stream in.
 */
export const BLOCKING_DECOR_ASSETS: Set<string> = new Set([
  'bush1',
  'bush2',
  'bush3',
]);

/**
 * Stair asset config: defines which placed GLB assets are walkable ramps.
 * - heightGain: height gained per tile at scale 1.0 (Y units)
 * - baseDirection: which way "up the stairs" goes at rotY=0
 *   'N' means at rotY=0, walking north goes up. Y rotation shifts the direction.
 */
export interface StairAssetConfig {
  tilesLong: number;
  heightGain: number;
  baseDirection: 'N' | 'S' | 'E' | 'W';
}

export const STAIR_ASSET_CONFIG: Record<string, StairAssetConfig> = {
  'stone stairs':            { tilesLong: 3, heightGain: 3.0, baseDirection: 'N' },
  'stone stairs small':      { tilesLong: 2, heightGain: 1.0, baseDirection: 'N' },
  'stone small stairs':      { tilesLong: 2, heightGain: 1.0, baseDirection: 'N' },
  'limestone stairs':        { tilesLong: 3, heightGain: 3.0, baseDirection: 'N' },
};

/** Rotate a direction by a Y rotation angle (radians) */
export function rotateStairDirection(baseDir: 'N' | 'S' | 'E' | 'W', rotY: number): 'N' | 'S' | 'E' | 'W' {
  const dirs: ('N' | 'E' | 'S' | 'W')[] = ['N', 'E', 'S', 'W'];
  const baseIdx = dirs.indexOf(baseDir);
  // Each 90° clockwise rotates the direction one step
  const steps = Math.round((rotY * 180 / Math.PI) / 90) % 4;
  return dirs[(baseIdx + steps + 4) % 4];
}
