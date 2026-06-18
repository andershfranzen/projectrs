import { BROTHER_MONK_CHEST_OBJECT_DEF_ID, GENERIC_SCENERY_OBJECT_DEF_ID, POTATO_PLANT_OBJECT_DEF_ID, RICE_PLANT_OBJECT_DEF_ID, SIGN_OBJECT_DEF_ID, STAIRS_OBJECT_DEF_ID, TRAPDOOR_OBJECT_DEF_ID } from './constants';

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
  // Fishing spots.
  'FishingSpotBubbles': 5,
  'FishingSpotBubblesNet': 5,
  'FishingSpotBubblesRod': 46,
  'FishingSpotBubblesHarpoon': 48,
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
  'TrapdoorClosed': TRAPDOOR_OBJECT_DEF_ID,
  'TrapdoorOpenFinal': TRAPDOOR_OBJECT_DEF_ID,
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
  // Readable signs. Per-instance text lives on PlacedObject.signText and is
  // converted into the standard placed-object Read interaction at runtime.
  'sign': SIGN_OBJECT_DEF_ID,
  'sign post': SIGN_OBJECT_DEF_ID,
};

export const READABLE_SIGN_ASSET_IDS: ReadonlySet<string> = new Set([
  'sign',
  'sign post',
]);

export function isReadableSignAssetId(assetId: string): boolean {
  return READABLE_SIGN_ASSET_IDS.has(assetId);
}

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
  'Knife',
  'knife',
  'Knife.glb',
  'knife.glb',
  '/assets/models/Knife.glb',
  'assets/models/Knife.glb',
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

export interface PlacedObjectStorageSurfaceProfile {
  /** Model-space height from the placed object's origin to the usable top surface. */
  surfaceHeight: number;
}

export const PLACED_OBJECT_STORAGE_SURFACE_PROFILES: Readonly<Record<string, PlacedObjectStorageSurfaceProfile>> = {
  // Values are model-space and multiplied by the placed object's Y scale.
  // table1 is commonly placed at scaleY ~= 0.55, giving a tabletop Y ~= 0.8.
  'table1': { surfaceHeight: 1.45 },
  'Theodosian_Table_1': { surfaceHeight: 2.2 },
};

export function storageSurfaceProfileForPlacedAsset(assetId: string): PlacedObjectStorageSurfaceProfile | undefined {
  return PLACED_OBJECT_STORAGE_SURFACE_PROFILES[assetId];
}

export function isPlacedObjectStorageSurfaceAssetId(assetId: string): boolean {
  return storageSurfaceProfileForPlacedAsset(assetId) !== undefined;
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
    name: 'Stone bench',
    examineText: 'A cold stone bench worn smooth by mourners and weather.',
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
  'Carpet2x4': {
    name: 'Carpet',
    examineText: 'A larger carpet, worn smooth where people keep pretending not to pace.',
  },
  'Cart': {
    name: 'Cart',
    examineText: 'A wooden cart built for carrying more than anyone wants to lift.',
  },
  'Cart_2': {
    name: 'Cart',
    examineText: 'A wooden cart built for carrying more than anyone wants to lift.',
  },
  'Cart_3': {
    name: 'Cart',
    examineText: 'A sturdy cart with room for cargo, excuses, or both.',
  },
  'Cart_4': {
    name: 'Cart',
    examineText: 'A sturdy cart with room for cargo, excuses, or both.',
  },
  'Chains_1003': {
    name: 'Chained stone coffin',
    examineText: 'A stone coffin bound shut with heavy chains.',
  },
  'chair': {
    name: 'Chair',
    examineText: 'A simple wooden chair.',
  },
  'Chair_1': {
    name: 'Chair',
    examineText: 'A plain chair polished by years of reluctant sitting.',
  },
  'Chair_2': {
    name: 'Chair',
    examineText: 'A plain chair polished by years of reluctant sitting.',
  },
  'Chair_3': {
    name: 'Chair',
    examineText: 'A plain chair polished by years of reluctant sitting.',
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
  'depleted_rock': {
    name: 'Depleted rock',
    examineText: 'A rock picked clean of anything worth swinging at.',
  },
  'Fountain_2': {
    name: 'Broken fountain',
    examineText: 'A dry, broken fountain. Whatever water once flowed here is long gone.',
  },
  'helm shop sign': {
    name: 'Helmet shop sign',
    examineText: 'A sign advertising helmets and headgear.',
  },
  'Lamp': {
    name: 'Lamp',
    examineText: 'A lamp that keeps the gloom at bay.',
  },
  'Minecart': {
    name: 'Mine cart',
    examineText: 'A mine cart with a useful shape and a suspicious number of dents.',
  },
  'MinecartTrackStraight': {
    name: 'Mine cart track',
    examineText: 'A length of track worn smooth by heavy mine carts.',
  },
  'MinecartTrackStop': {
    name: 'Mine cart buffer',
    examineText: 'A track stop for mine carts that are done negotiating.',
  },
  'MinecartTrackTurn': {
    name: 'Mine cart track',
    examineText: 'A curved length of track. Even mine carts need options.',
  },
  'Notice_Board': {
    name: 'Notice board',
    examineText: 'A board for notices, warnings, and local news.',
  },
  'OnePersonBed1': {
    name: 'Bed',
    examineText: "A bed with the exact shape of a bad night's sleep.",
  },
  'open tier 1 chest': {
    name: 'Open chest',
    examineText: 'An open wooden chest. Someone has already helped themselves.',
  },
  'open tier 2 chest': {
    name: 'Open chest',
    examineText: 'An open iron-bound chest. The good part is missing.',
  },
  'open tier 3 chest': {
    name: 'Open chest',
    examineText: 'An open black bronze chest. It looks recently disappointed.',
  },
  'open tier 4 chest': {
    name: 'Open chest',
    examineText: 'An open mithril chest. The lock won, then lost.',
  },
  'open tier 5 chest': {
    name: 'Open chest',
    examineText: 'An open steel chest. Nothing valuable is sitting politely inside.',
  },
  'open tier 6 chest': {
    name: 'Open chest',
    examineText: 'An open royal gold chest. It has the smug emptiness of expensive security.',
  },
  'PalmTree1': {
    name: 'Palm tree',
    examineText: 'A palm tree doing its best with sand, sun, and very little encouragement.',
  },
  'PalmTree': {
    name: 'Palm tree',
    examineText: 'A palm tree doing its best with sand, sun, and very little encouragement.',
  },
  'PalmTreeLowSwept': {
    name: 'Palm tree',
    examineText: 'A wind-swept palm tree, bent but still making a point.',
  },
  'PalmTreeWindHook': {
    name: 'Palm tree',
    examineText: 'A crooked palm tree shaped by desert wind.',
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
  'Shop_Sign_1': {
    name: 'Shop sign',
    examineText: 'A hanging shop sign, creaking softly over the doorway.',
  },
  'Shop_Sign_2': {
    name: 'Shop sign',
    examineText: 'A hanging shop sign, creaking softly over the doorway.',
  },
  'StallBase': {
    name: 'Stall base',
    examineText: 'The bare bones of a market stall, waiting for ambition and inventory.',
  },
  'table1': {
    name: 'Table',
    examineText: 'A plain wooden table.',
  },
  'Table_1': {
    name: 'Table',
    examineText: 'A pale table scrubbed clean enough to show every scratch.',
  },
  'Table_2': {
    name: 'Table',
    examineText: 'A pale table scrubbed clean enough to show every scratch.',
  },
  'Table_3': {
    name: 'Table',
    examineText: 'A pale table scrubbed clean enough to show every scratch.',
  },
  'Tanning Rack': {
    name: 'Tanning rack',
    examineText: 'A rack for stretching leather. The smell has settled in permanently.',
  },
  'Theodosian_Chair_1': {
    name: 'Chair',
    examineText: 'A palace chair with a better posture than most people.',
  },
  'Theodosian_Table_1': {
    name: 'Table',
    examineText: 'A sturdy table.',
  },
  'Byzantine_WIPStair1': {
    name: 'Wooden spiral staircase',
    examineText: 'A wooden spiral staircase leading between levels.',
  },
  'Tent': {
    name: 'Tent',
    examineText: 'A canvas tent pitched for a short stay.',
  },
  'Theodosian_WIPStair1': {
    name: 'Wooden spiral staircase',
    examineText: 'A wooden spiral staircase leading between levels.',
  },
  'Walltorch': {
    name: 'Wall torch',
    examineText: 'A wall-mounted torch, blackened from use.',
  },
  'Waterwheel': {
    name: 'Waterwheel',
    examineText: 'A wooden waterwheel built to turn with the current.',
  },
  'weapon shop sign': {
    name: 'Weapon shop sign',
    examineText: 'A sign advertising sharp solutions to common problems.',
  },
  'WIPStair1': {
    name: 'Wooden spiral staircase',
    examineText: 'A wooden spiral staircase leading between levels.',
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
  return ASSET_TO_OBJECT_DEF[assetId]
    ?? (EXAMINABLE_SCENERY_ASSETS.has(assetId) || isPlacedObjectStorageSurfaceAssetId(assetId)
      ? GENERIC_SCENERY_OBJECT_DEF_ID
      : undefined);
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
