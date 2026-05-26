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
  // Maple -> objectId 14 (Maple Tree)
  'maple tree': 14,
  // Yew -> objectId 38 (Yew Tree)
  'yew tree': 38,
  // Dead -> objectId 10 (Dead Tree)
  'DeadTreeLam': 10,
  // Rocks
  'CopperRock': 3,  // Copper Rock
  'IronRock': 4,    // Iron Rock
  'TinRock': 11,    // Tin Rock
  'CoalRock': 12,   // Coal Rock
  'MithrilRock': 16, // Mithril Rock
  'SilverRock': 25, // Silver Rock
  'CopperRock2': 3,
  'CopperRock3': 3,
  'IronRock2': 4,
  'IronRock3': 4,
  'TinRock2': 11,
  'TinRock3': 11,
  'CoalRock2': 12,
  'CoalRock3': 12,
  'MithrilRock2': 16,
  'MithrilRock3': 16,
  'SilverRock2': 25,
  'SilverRock3': 25,
  'ClayRock2': 33,
  'ClayRock3': 33,
  // Crafting stations
  'forge': 6,        // Furnace
  'cookingrange': 7, // Cooking Range
  'anvil': 19,       // Anvil (smithing)
  'BankBooth': 31,   // Bank booth
  'Altar': 8,         // Good magic altar — offer relics for goodmagic xp
  'Pottery wheel': 32, // Pottery Wheel — shape soft clay
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
  'tier 1 chest': 20, // Wooden Chest
  'tier 2 chest': 21, // Iron Chest
  'tier 3 chest': 34, // Black Bronze Chest
  'tier 4 chest': 35, // Mithril Chest
  'tier 5 chest': 36, // Steel Chest
  'tier 6 chest': 37, // Royal Gold Chest
  // Crops
  'rice': 22, // Rice Plant
  'PotatoPlant': 28, // Potato Plant
  'CauliflowerPlant': 29, // Cauliflower Plant
  'wheat': 30, // Wheat Plant
  'wheat2': 30,
  'wheat2rotated1': 30,
  'wheat2rotated2': 30,
  'wheat2rotated3': 30,
  // Evil magic altar
  'Obelisk': 24, // Obelisk — offer bones for evilmagic xp + evil tokens
  // Quest/scenery interactions
  'Paper': 26,
  'well': 27,
  'desert well': 27,
};

export interface AssetGroundItemSpawnDef {
  itemId: number;
  quantity?: number;
  respawnTime?: number;
}

const BONES_GROUND_ITEM_SPAWN = { itemId: 1, quantity: 1, respawnTime: 40 } satisfies AssetGroundItemSpawnDef;

/**
 * Editor-placed assets that are represented in-game as ground items instead of
 * static scenery. The server owns pickup/respawn state; the client skips the
 * placed GLB and renders the spawned ground item entity.
 */
export const ASSET_TO_GROUND_ITEM_SPAWN: Record<string, AssetGroundItemSpawnDef> = {
  'Bones': BONES_GROUND_ITEM_SPAWN,
  'Bone': BONES_GROUND_ITEM_SPAWN,
  'bones': BONES_GROUND_ITEM_SPAWN,
  'bone': BONES_GROUND_ITEM_SPAWN,
  'Bones.glb': BONES_GROUND_ITEM_SPAWN,
  'bone.glb': BONES_GROUND_ITEM_SPAWN,
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
  'Tanning Rack',
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

export function oppositeStairDirection(dir: 'N' | 'S' | 'E' | 'W'): 'N' | 'S' | 'E' | 'W' {
  switch (dir) {
    case 'N': return 'S';
    case 'S': return 'N';
    case 'E': return 'W';
    case 'W': return 'E';
  }
}

export function stairDirectionVector(dir: 'N' | 'S' | 'E' | 'W'): { dx: number; dz: number } {
  switch (dir) {
    case 'N': return { dx: 0, dz: -1 };
    case 'S': return { dx: 0, dz: 1 };
    case 'E': return { dx: 1, dz: 0 };
    case 'W': return { dx: -1, dz: 0 };
  }
}
