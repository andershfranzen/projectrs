export const TICK_RATE = 600; // ms per game tick
export const CHUNK_SIZE = 32; // tiles per chunk side
export const CHUNK_LOAD_RADIUS = 2; // loads (2r+1)^2 = 25 chunks around player
export const TILE_SIZE = 1; // world units per tile
export const INVENTORY_SIZE = 30;
export const BANK_SIZE = 200;
export const TRADE_OFFER_SIZE = 28;
export const DUEL_STAKE_SIZE = TRADE_OFFER_SIZE;
/** Chebyshev range (in tiles) for initiating and maintaining a trade. Kept a
 *  little wider than direct NPC/object interactions because player positions
 *  drift during walk ticks and trade is a social action, not melee contact. */
export const TRADE_REQUEST_RANGE = 8;
export const TRADE_REQUEST_TTL_MS = 10000;

/** Hard ceiling on any single stack's quantity. Int31 — matches the wire
 *  encoding `(qtyHigh << 16) | (qtyLow & 0xFFFF)` so over-the-wire values
 *  never truncate. Server-side: any `quantity += N` site must clamp to
 *  this and refuse the excess (chat-warn the player). Closes the entire
 *  arithmetic-overflow exploit class. */
export const MAX_STACK = 0x7FFFFFFF;

/** Wire protocol version. Bumped whenever opcode layouts change in an
 *  incompatible way (field added/removed/reordered, encoding swapped).
 *  Server sends this in LOGIN_OK; client compares to its bundled value and
 *  disconnects on mismatch with a "please refresh" prompt. Without this
 *  guard, a tab from yesterday's build silently misinterprets new opcodes
 *  and corrupts state — exactly what dupe surfaces are made of. */
export const PROTOCOL_VERSION = 23;
export const SERVER_PORT = 4000;
export const GAME_WS_PATH = '/ws/game';
export const CHAT_WS_PATH = '/ws/chat';
export const EDITOR_CHUNK_SIZE = 64;

/** Object and item IDs used by inventory/object crafting flows. */
export const WELL_OBJECT_DEF_ID = 27;
export const COOKING_RANGE_OBJECT_DEF_ID = 7;
export const POTATO_PLANT_OBJECT_DEF_ID = 28;
export const POTTERY_WHEEL_OBJECT_DEF_ID = 32;
export const KILN_OBJECT_DEF_ID = 39;
export const SPINNING_WHEEL_OBJECT_DEF_ID = 40;
export const STAIRS_OBJECT_DEF_ID = 43;
export const GENERIC_SCENERY_OBJECT_DEF_ID = 45;
export const BATCH_OBJECT_RECIPE_DEF_IDS: readonly number[] = [
  COOKING_RANGE_OBJECT_DEF_ID,
  POTTERY_WHEEL_OBJECT_DEF_ID,
  KILN_OBJECT_DEF_ID,
  SPINNING_WHEEL_OBJECT_DEF_ID,
];
export const CLAY_ITEM_ID = 242;
export const SOFT_CLAY_ITEM_ID = 243;
export const POT_ITEM_ID = 245;
export const POT_OF_WATER_ITEM_ID = 246;
export const BUCKET_ITEM_ID = 247;
export const BUCKET_OF_WATER_ITEM_ID = 248;
export const KNIFE_ITEM_ID = 251;
export const FEATHER_ITEM_ID = 19;
export const LOGS_ITEM_ID = 23;
export const OAK_LOGS_ITEM_ID = 24;
export const MAPLE_LOGS_ITEM_ID = 39;
export const YEW_LOGS_ITEM_ID = 40;
export const BRONZE_ARROWS_ITEM_ID = 42;
export const IRON_ARROWS_ITEM_ID = 43;
export const STEEL_ARROWS_ITEM_ID = 285;
export const MITHRIL_ARROWS_ITEM_ID = 286;
export const BLACK_BRONZE_ARROWS_ITEM_ID = 287;
export const WILLOW_LOGS_ITEM_ID = 235;
export const SHORTBOW_UNSTRUNG_ITEM_ID = 262;
export const BRONZE_ARROWHEADS_ITEM_ID = 264;
export const IRON_ARROWHEADS_ITEM_ID = 265;
export const STEEL_ARROWHEADS_ITEM_ID = 266;
export const MITHRIL_ARROWHEADS_ITEM_ID = 267;
export const BLACK_BRONZE_ARROWHEADS_ITEM_ID = 268;
export const LOW_QUALITY_SINEW_ITEM_ID = 269;
export const ARROW_SHAFTS_ITEM_ID = 270;
export const MAGIC_LOGS_ITEM_ID = 271;
export const HEADLESS_ARROWS_ITEM_ID = 272;
export const BOWSTRING_ITEM_ID = 273;
export const SHORTBOW_ITEM_ID = 274;
export const OAK_SHORTBOW_UNSTRUNG_ITEM_ID = 275;
export const WILLOW_SHORTBOW_UNSTRUNG_ITEM_ID = 276;
export const MAPLE_SHORTBOW_UNSTRUNG_ITEM_ID = 277;
export const YEW_SHORTBOW_UNSTRUNG_ITEM_ID = 278;
export const MAGIC_SHORTBOW_UNSTRUNG_ITEM_ID = 279;
export const OAK_SHORTBOW_ITEM_ID = 280;
export const WILLOW_SHORTBOW_ITEM_ID = 281;
export const MAPLE_SHORTBOW_ITEM_ID = 282;
export const YEW_SHORTBOW_ITEM_ID = 283;
export const MAGIC_SHORTBOW_ITEM_ID = 284;
export const SHORTBOW_HQ_ITEM_ID = 453;
export const OAK_SHORTBOW_HQ_ITEM_ID = 454;
export const WILLOW_SHORTBOW_HQ_ITEM_ID = 455;
export const MAPLE_SHORTBOW_HQ_ITEM_ID = 456;
export const YEW_SHORTBOW_HQ_ITEM_ID = 457;
export const MAGIC_SHORTBOW_HQ_ITEM_ID = 458;
export const COW_HIDE_ITEM_ID = 296;
export const BEAR_HIDE_ITEM_ID = 297;
export const WOLF_HIDE_ITEM_ID = 298;
export const DEER_HIDE_ITEM_ID = 299;
export const CAMEL_HIDE_ITEM_ID = 300;
export const HUMAN_HIDE_ITEM_ID = 301;
export const TANNED_COW_HIDE_ITEM_ID = 302;
export const TANNED_BEAR_HIDE_ITEM_ID = 303;
export const TANNED_WOLF_HIDE_ITEM_ID = 304;
export const TANNED_DEER_HIDE_ITEM_ID = 305;
export const TANNED_CAMEL_HIDE_ITEM_ID = 306;
export const TANNED_HUMAN_HIDE_ITEM_ID = 307;
export const RAW_HIDE_ITEM_IDS: readonly number[] = [
  COW_HIDE_ITEM_ID,
  BEAR_HIDE_ITEM_ID,
  WOLF_HIDE_ITEM_ID,
  DEER_HIDE_ITEM_ID,
  CAMEL_HIDE_ITEM_ID,
  HUMAN_HIDE_ITEM_ID,
];
export const TANNED_HIDE_ITEM_IDS: readonly number[] = [
  TANNED_COW_HIDE_ITEM_ID,
  TANNED_BEAR_HIDE_ITEM_ID,
  TANNED_WOLF_HIDE_ITEM_ID,
  TANNED_DEER_HIDE_ITEM_ID,
  TANNED_CAMEL_HIDE_ITEM_ID,
  TANNED_HUMAN_HIDE_ITEM_ID,
];
export const TANNED_HIDE_BY_RAW_HIDE_ITEM_ID: Readonly<Record<number, number>> = Object.freeze({
  [COW_HIDE_ITEM_ID]: TANNED_COW_HIDE_ITEM_ID,
  [BEAR_HIDE_ITEM_ID]: TANNED_BEAR_HIDE_ITEM_ID,
  [WOLF_HIDE_ITEM_ID]: TANNED_WOLF_HIDE_ITEM_ID,
  [DEER_HIDE_ITEM_ID]: TANNED_DEER_HIDE_ITEM_ID,
  [CAMEL_HIDE_ITEM_ID]: TANNED_CAMEL_HIDE_ITEM_ID,
  [HUMAN_HIDE_ITEM_ID]: TANNED_HUMAN_HIDE_ITEM_ID,
});
export const SOFT_CLAY_WATER_CONTAINER_ITEM_IDS: readonly number[] = [
  POT_OF_WATER_ITEM_ID,
  BUCKET_OF_WATER_ITEM_ID,
];

export const LOG_CRAFT_ARROW_SHAFT_RECIPES: readonly {
  logItemId: number;
  shaftQuantity: number;
  logLabel: string;
}[] = [
  { logItemId: LOGS_ITEM_ID, shaftQuantity: 10, logLabel: 'log' },
  { logItemId: OAK_LOGS_ITEM_ID, shaftQuantity: 15, logLabel: 'oak log' },
  { logItemId: WILLOW_LOGS_ITEM_ID, shaftQuantity: 20, logLabel: 'willow log' },
  { logItemId: MAPLE_LOGS_ITEM_ID, shaftQuantity: 25, logLabel: 'maple log' },
  { logItemId: YEW_LOGS_ITEM_ID, shaftQuantity: 30, logLabel: 'yew log' },
  { logItemId: MAGIC_LOGS_ITEM_ID, shaftQuantity: 50, logLabel: 'mystic log' },
];

export const LOG_CRAFT_SHORTBOW_RECIPES: readonly {
  logItemId: number;
  unstrungItemId: number;
  strungItemId: number;
  hqStrungItemId: number;
  logLabel: string;
  bowLabel: string;
  levelRequired: number;
  carveXpReward: number;
  stringXpReward: number;
}[] = [
  { logItemId: LOGS_ITEM_ID, unstrungItemId: SHORTBOW_UNSTRUNG_ITEM_ID, strungItemId: SHORTBOW_ITEM_ID, hqStrungItemId: SHORTBOW_HQ_ITEM_ID, logLabel: 'log', bowLabel: 'shortbow', levelRequired: 1, carveXpReward: 6, stringXpReward: 7 },
  { logItemId: OAK_LOGS_ITEM_ID, unstrungItemId: OAK_SHORTBOW_UNSTRUNG_ITEM_ID, strungItemId: OAK_SHORTBOW_ITEM_ID, hqStrungItemId: OAK_SHORTBOW_HQ_ITEM_ID, logLabel: 'oak log', bowLabel: 'oak shortbow', levelRequired: 5, carveXpReward: 8, stringXpReward: 9 },
  { logItemId: WILLOW_LOGS_ITEM_ID, unstrungItemId: WILLOW_SHORTBOW_UNSTRUNG_ITEM_ID, strungItemId: WILLOW_SHORTBOW_ITEM_ID, hqStrungItemId: WILLOW_SHORTBOW_HQ_ITEM_ID, logLabel: 'willow log', bowLabel: 'willow shortbow', levelRequired: 18, carveXpReward: 16, stringXpReward: 17 },
  { logItemId: MAPLE_LOGS_ITEM_ID, unstrungItemId: MAPLE_SHORTBOW_UNSTRUNG_ITEM_ID, strungItemId: MAPLE_SHORTBOW_ITEM_ID, hqStrungItemId: MAPLE_SHORTBOW_HQ_ITEM_ID, logLabel: 'maple log', bowLabel: 'maple shortbow', levelRequired: 32, carveXpReward: 25, stringXpReward: 25 },
  { logItemId: YEW_LOGS_ITEM_ID, unstrungItemId: YEW_SHORTBOW_UNSTRUNG_ITEM_ID, strungItemId: YEW_SHORTBOW_ITEM_ID, hqStrungItemId: YEW_SHORTBOW_HQ_ITEM_ID, logLabel: 'yew log', bowLabel: 'yew shortbow', levelRequired: 46, carveXpReward: 34, stringXpReward: 34 },
  { logItemId: MAGIC_LOGS_ITEM_ID, unstrungItemId: MAGIC_SHORTBOW_UNSTRUNG_ITEM_ID, strungItemId: MAGIC_SHORTBOW_ITEM_ID, hqStrungItemId: MAGIC_SHORTBOW_HQ_ITEM_ID, logLabel: 'mystic log', bowLabel: 'mystic shortbow', levelRequired: 60, carveXpReward: 41, stringXpReward: 42 },
];

export const ARROWHEAD_FLETCHING_RECIPES: readonly {
  arrowheadItemId: number;
  arrowItemId: number;
  arrowLabel: string;
  levelRequired: number;
  xpReward: number;
}[] = [
  { arrowheadItemId: BRONZE_ARROWHEADS_ITEM_ID, arrowItemId: BRONZE_ARROWS_ITEM_ID, arrowLabel: 'bronze', levelRequired: 1, xpReward: 1 },
  { arrowheadItemId: IRON_ARROWHEADS_ITEM_ID, arrowItemId: IRON_ARROWS_ITEM_ID, arrowLabel: 'iron', levelRequired: 15, xpReward: 2 },
  { arrowheadItemId: STEEL_ARROWHEADS_ITEM_ID, arrowItemId: STEEL_ARROWS_ITEM_ID, arrowLabel: 'steel', levelRequired: 30, xpReward: 4 },
  { arrowheadItemId: BLACK_BRONZE_ARROWHEADS_ITEM_ID, arrowItemId: BLACK_BRONZE_ARROWS_ITEM_ID, arrowLabel: 'black bronze', levelRequired: 45, xpReward: 8 },
  { arrowheadItemId: MITHRIL_ARROWHEADS_ITEM_ID, arrowItemId: MITHRIL_ARROWS_ITEM_ID, arrowLabel: 'mithril', levelRequired: 60, xpReward: 16 },
];

/** Distance budget for materializing humanoid NPCs as skinned 3D characters. */
export const NPC_3D_LOD_DISTANCE = 15;

/** Chebyshev range (in tiles) at which a Talk-to / interaction packet fires.
 *  Set to 2 rather than 1 so a 1-tile client/server divergence (typical
 *  during a walk tick) doesn't cause "I'm clearly next to them" clicks to
 *  defer for an extra tick. The deferred-talk drain on the server uses the
 *  same range. */
export const NPC_INTERACTION_RANGE = 2;

/** Max distance in tiles a player can cast a targeted spell from. Shared so
 *  client prediction and server validation use the same range. */
export const SPELL_CAST_DISTANCE = 10;
/** Default Chebyshev range for player ranged attacks. Shortbows use this;
 *  longer weapon families can override it with ItemDef.attackRange. */
export const DEFAULT_RANGED_ATTACK_DISTANCE = 7;
export const MIN_RANGED_ATTACK_DISTANCE = 1;
export const MAX_RANGED_ATTACK_DISTANCE = 10;
export function normalizeRangedAttackDistance(range: number | null | undefined): number {
  if (typeof range !== 'number' || !Number.isFinite(range) || range <= 0) return DEFAULT_RANGED_ATTACK_DISTANCE;
  return Math.max(MIN_RANGED_ATTACK_DISTANCE, Math.min(MAX_RANGED_ATTACK_DISTANCE, range));
}
/** Projectile eye/target offsets used by ranged attacks. Shared so client
 *  path prediction and server combat validation test the same line segment. */
export const RANGED_PROJECTILE_SOURCE_HEIGHT = 1.35;
export const RANGED_PROJECTILE_TARGET_HEIGHT = 1.0;
/** Walls below this visual height do not block arrows unless explicitly
 *  authored as full-height projectile blockers. */
export const PROJECTILE_BLOCKING_WALL_HEIGHT = 1.5;
