import { STAIRS_OBJECT_DEF_ID } from './constants';

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
  'oaktree': 2,
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
  'CrimsoniteRock': 41,
  'CrimsoniteRock2': 41,
  'CrimsoniteRock3': 41,
  'MalachiteRock': 42,
  'MalachiteRock2': 42,
  'MalachiteRock3': 42,
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
  'Kiln': 39,         // Kiln — fire unfired clay items
  'Spinning Wheel': 40, // Spinning Wheel — spin sinew into bowstring
  'Spinning wheel': 40,
  'SpinningWheel': 40,
  'spinning wheel': 40,
  // Doors (only Truedoor assets — other "door" assets are decorative door frames)
  'castleTruedoor': 13,
  'basicTruedoor': 13,
  // Cave entrances
  'cavedoor': 15,  // Cave Entrance -> map transition
  'CavernEntrance1': 15,
  'CavernExit1': 15,
  // Floor transitions
  'Ladder': 23,
  'stone stairs': STAIRS_OBJECT_DEF_ID,
  'stone stairs small': STAIRS_OBJECT_DEF_ID,
  'stone small stairs': STAIRS_OBJECT_DEF_ID,
  'limestone stairs': STAIRS_OBJECT_DEF_ID,
  'WIPStair1': STAIRS_OBJECT_DEF_ID,
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

/**
 * Editor-placed assets that are represented in-game as ground items instead of
 * static scenery. This shared set intentionally contains only render-filtering
 * asset names; item ids and respawn timers live server-side.
 */
export const GROUND_ITEM_SPAWN_ASSET_IDS: ReadonlySet<string> = new Set([
  'Bones',
  'Bone',
  'bones',
  'bone',
  'Bones.glb',
  'bone.glb',
  'Sapphire',
  'Emerald',
  'Ruby',
  'Diamond',
  'Amethyst',
  'Topaz',
  'Opal',
  'Onyx',
]);

export function isGroundItemSpawnAssetId(assetId: string): boolean {
  return GROUND_ITEM_SPAWN_ASSET_IDS.has(assetId);
}

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
