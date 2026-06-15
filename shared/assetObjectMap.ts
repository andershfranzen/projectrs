import { BROTHER_MONK_CHEST_OBJECT_DEF_ID, GENERIC_SCENERY_OBJECT_DEF_ID, POTATO_PLANT_OBJECT_DEF_ID, RICE_PLANT_OBJECT_DEF_ID, STAIRS_OBJECT_DEF_ID } from './constants';

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
  'dying tree': 10,
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
  'SulphurRock': 44,
  'SilverRock2': 25,
  'SilverRock3': 25,
  'ClayRock2': 33,
  'ClayRock3': 33,
  // Fishing spots. The three editor aliases use the same bubble GLB but map
  // to level-1 test object defs with different animation variants.
  'FishingSpotBubbles': 5,
  'FishingSpotBubblesNet': 61,
  'FishingSpotBubblesRod': 62,
  'FishingSpotBubblesHarpoon': 63,
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
  // Doors (standalone panels only — modular "door" assets are decorative door frames)
  'castleTruedoor': 13,
  'basicTruedoor': 13,
  'IronDoor1': 13,
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
  'Theodosian_WIPStair1': STAIRS_OBJECT_DEF_ID,
  'Byzantine_WIPStair1': STAIRS_OBJECT_DEF_ID,
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
  'brother monk chest': BROTHER_MONK_CHEST_OBJECT_DEF_ID,
  // Market stalls (roguery)
  'food stall': 52,
  'crafting stall': 53,
  'hides stall': 54,
  'Ranging stall': 55,
  'ranging stall': 55,
  'low level smithing stall': 56,
  'high level smithing stall': 57,
  'relic stall': 58,
  'Gem stall': 59,
  'gem stall': 59,
  // Crops
  'rice': RICE_PLANT_OBJECT_DEF_ID, // Rice Plant
  'PotatoPlant': POTATO_PLANT_OBJECT_DEF_ID, // Potato Plant
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
  'desert fountain': 27,
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

export const CROP_OBJECT_DEF_IDS: ReadonlySet<number> = new Set([
  RICE_PLANT_OBJECT_DEF_ID,
  POTATO_PLANT_OBJECT_DEF_ID,
  29, // Cauliflower Plant
  30, // Wheat Plant
]);

export function isCropPlacedAssetId(assetId: string): boolean {
  const objectDefId = ASSET_TO_OBJECT_DEF[assetId];
  return objectDefId !== undefined && CROP_OBJECT_DEF_IDS.has(objectDefId);
}

export interface SceneryExamineMeta {
  name: string;
  examineText: string;
}

export const EXAMINABLE_SCENERY_META: Readonly<Record<string, SceneryExamineMeta>> = {
  '2PersonBed1': {
    name: 'Bed',
    examineText: 'A larger bed with room for someone who sleeps like they are guarding territory.',
  },
  'Barrel': {
    name: 'Barrel',
    examineText: 'A sturdy barrel for storing supplies.',
  },
  'Bench_1': {
    name: 'Bench',
    examineText: 'A sturdy wooden bench for weary travellers.',
  },
  'Bench1': {
    name: 'Bench',
    examineText: 'A sturdy wooden bench for weary travellers.',
  },
  'bookcase2': {
    name: 'Bookcase',
    examineText: 'Someone alphabetised this by confidence.',
  },
  'Bucket2': {
    name: 'Bucket',
    examineText: 'An empty bucket. It has seen plenty of chores.',
  },
  'bush1': {
    name: 'Bush',
    examineText: 'A thick bush with tangled branches and dark leaves. Something could easily hide in it.',
  },
  'bush2': {
    name: 'Bush',
    examineText: 'A scruffy roadside bush, dusty at the roots and stubbornly alive.',
  },
  'bush3': {
    name: 'Bush',
    examineText: 'George W.',
  },
  'Cage_2': {
    name: 'Cage',
    examineText: 'A stout cage made from iron bars.',
  },
  'Carpet1x4': {
    name: 'Carpet',
    examineText: 'A long worn carpet, faded by many footsteps.',
  },
  'Carpet2x3': {
    name: 'Carpet',
    examineText: 'A worn carpet that makes the room feel lived in.',
  },
  'Chains_1003': {
    name: 'Chains',
    examineText: 'Heavy chains, cold and unpleasant to touch.',
  },
  'chair': {
    name: 'Chair',
    examineText: 'A simple wooden chair.',
  },
  'Coffin': {
    name: 'Coffin',
    examineText: 'A grim wooden coffin.',
  },
  'Coffin_2': {
    name: 'Coffin',
    examineText: 'A grim wooden coffin. Best left undisturbed.',
  },
  'Coffin_Door': {
    name: 'Coffin lid',
    examineText: 'The lid of a coffin. It looks heavy.',
  },
  'Coffin-Closed': {
    name: 'Closed coffin',
    examineText: 'A closed coffin. Whatever is inside can stay there.',
  },
  'Crate1': {
    name: 'Crate',
    examineText: 'A wooden crate. It is probably full of supplies.',
  },
  'Cross': {
    name: 'Cross',
    examineText: 'A weathered cross, placed with solemn purpose.',
  },
  'Fountain_2': {
    name: 'Fountain',
    examineText: 'The water reflects someone who should probably get back to work.',
  },
  'helm shop sign': {
    name: 'Helmet shop sign',
    examineText: 'A sign advertising helmets and headgear.',
  },
  'Lamp': {
    name: 'Lamp',
    examineText: 'A lamp that keeps the gloom at bay.',
  },
  'Notice_Board': {
    name: 'Notice board',
    examineText: 'A board for notices, warnings, and local news.',
  },
  'OnePersonBed1': {
    name: 'Bed',
    examineText: "A bed with the exact shape of a bad night's sleep.",
  },
  'ranged shop sign': {
    name: 'Ranged shop sign',
    examineText: 'A sign advertising bows, arrows, and ranged supplies.',
  },
  'RiceMill': {
    name: 'Rice mill',
    examineText: 'A small mill used for processing rice.',
  },
  'Sack1': {
    name: 'Sack',
    examineText: 'A bulging sack of ordinary supplies.',
  },
  'Sack2': {
    name: 'Sack',
    examineText: 'A tied sack. Something dry rustles inside.',
  },
  'table1': {
    name: 'Table',
    examineText: 'A plain wooden table.',
  },
  'Tent': {
    name: 'Tent',
    examineText: 'A canvas tent pitched for a short stay.',
  },
  'Walltorch': {
    name: 'Wall torch',
    examineText: 'A wall-mounted torch, blackened from use.',
  },
  'Waterwheel': {
    name: 'Waterwheel',
    examineText: 'A wooden waterwheel built to turn with the current.',
  },
};

export const EXAMINABLE_SCENERY_ASSETS: ReadonlySet<string> = new Set(Object.keys(EXAMINABLE_SCENERY_META));

export const WALK_HERE_PRIMARY_SCENERY_ASSETS: ReadonlySet<string> = new Set([
  'Carpet1x2',
  'Carpet1x3',
  'Carpet1x4',
  'Carpet2x3',
  'Carpet2x4',
]);

export function sceneryExamineMetaForAsset(assetId: string): SceneryExamineMeta | undefined {
  return EXAMINABLE_SCENERY_META[assetId];
}

export function isWalkHerePrimarySceneryAssetId(assetId: string): boolean {
  return WALK_HERE_PRIMARY_SCENERY_ASSETS.has(assetId);
}

export function objectDefIdForPlacedAsset(assetId: string): number | undefined {
  if (isGroundItemSpawnAssetId(assetId)) return undefined;
  return ASSET_TO_OBJECT_DEF[assetId] ?? (EXAMINABLE_SCENERY_ASSETS.has(assetId) ? GENERIC_SCENERY_OBJECT_DEF_ID : undefined);
}

/**
 * Decoration assets that still stamp a tile blocker even when they use the
 * generic scenery object definition for right-click Examine.
 */
export const BLOCKING_DECOR_ASSETS: Set<string> = new Set([
  'bush1',
  'bush2',
  'bush3',
  'Tanning Rack',
]);
