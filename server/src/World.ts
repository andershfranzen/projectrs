import { TICK_RATE, CHUNK_SIZE, MAX_STACK, RANGED_PROJECTILE_SOURCE_HEIGHT, RANGED_PROJECTILE_TARGET_HEIGHT, PROTOCOL_VERSION, WELL_OBJECT_DEF_ID, COOKING_RANGE_OBJECT_DEF_ID, POTTERY_WHEEL_OBJECT_DEF_ID, KILN_OBJECT_DEF_ID, SPINNING_WHEEL_OBJECT_DEF_ID, BATCH_OBJECT_RECIPE_DEF_IDS, CLAY_ITEM_ID, SOFT_CLAY_ITEM_ID, POT_ITEM_ID, POT_OF_WATER_ITEM_ID, BUCKET_ITEM_ID, BUCKET_OF_WATER_ITEM_ID, KNIFE_ITEM_ID, FEATHER_ITEM_ID, LOGS_ITEM_ID, LOW_QUALITY_SINEW_ITEM_ID, BOWSTRING_ITEM_ID, ARROW_SHAFTS_ITEM_ID, HEADLESS_ARROWS_ITEM_ID, LOG_CRAFT_ARROW_SHAFT_RECIPES, LOG_CRAFT_SHORTBOW_RECIPES, ARROWHEAD_FLETCHING_RECIPES, ServerOpcode, EntityDeathKind, PlayerAnimationKind, PlayerSkillAnimationVariant, ALL_SKILLS, SKILL_NAMES, ASSET_TO_OBJECT_DEF, BLOCKING_DECOR_ASSETS, RELIC_ITEM_IDS, WallEdge, doorEdgeFromPlacement, doorClosedEdgeFromRotY, DOOR_EDGE_NEIGHBOR, TRADE_OFFER_SIZE, TRADE_REQUEST_RANGE, TRADE_REQUEST_TTL_MS, DUEL_STAKE_SIZE, getObjectFootprintMinTile, getObjectFootprintTiles, getObjectInteractionTiles, isTileAdjacentToObject, localSidesToWorldSides, usesCornerInteractionTiles, usesMapAuthoredObjectCollision, CUSTOM_COLOR_SLOTS, DEFAULT_APPEARANCE, normalizeAppearance, relicTierDef, bankAccessSpawnViolation, isAutocastableSpell, rangedProjectileTravelMsForDistance, rangedProjectileArcHeightForDistance, combatRangeIncludesOffset, STANCE_KEYS, encodeNpcVisualScale, objectDefIdForPlacedAsset, sceneryExamineMetaForAsset, type SkillId, type ItemDef, type NpcDef, type ObjectRecipe, type PlayerAppearance, type WorldObjectDef, type SpawnEntry, type ShopDef, type ShopItem, type SpellEffectDef, type MagicStance, type PlacedObjectVerticalLink, type PlacedObjectVerticalLinkEndpoint, isValidAppearance } from '@projectrs/shared';
import { audit } from './Audit';
import { BotStats } from './BotStats';
import { encodePacket, encodePacketBatch, encodeStringPacket } from '@projectrs/shared';
import { addXp, statRandom, spellSchoolSkill, xpForLevel } from '@projectrs/shared';
import { GameMap } from './GameMap';
import { Player, type EquipSlot, type PlayerAmmo } from './entity/Player';
import { Npc, type NpcOptions } from './entity/Npc';
import { WorldObject } from './entity/WorldObject';
import { DataLoader } from './data/DataLoader';
import { ASSET_TO_GROUND_ITEM_SPAWN } from './data/AssetGroundItemSpawns';
import { GameDatabase, type GameEventLogInput } from './Database';
import { applyPlayerMagicImpactToNpc, armNpcRetaliation, isPointInNpcMagicAttackRange, isPointInNpcRangedAttackRange as isNpcInRangedAttackRange, processPlayerCombat, processPlayerRangedCombat, processNpcCombat, rollLoot, rollPlayerMagicDamageAgainstNpc, rollPlayerMagicDamageAgainstPlayer, rollPlayerMeleeDamageAgainstPlayer, rollPlayerRangedDamageAgainstPlayer, shouldConsumeAmmoOnShot, MAGIC_ATTACK_COOLDOWN_TICKS, MAGIC_ATTACK_DISTANCE, MAGIC_ATTACK_RANGE_MODE, RANGED_ATTACK_DISTANCE, type PlayerNpcCombatResult } from './combat/Combat';
import { CombatSystem, type CombatActorRef, type CombatContext, type CombatMode, type ImpactQueueEntry, type RetaliationRequest } from './combat/CombatSystem';
import { finalizeNpcDeath as finalizeNpcDeathCombat } from './combat/NpcDeath';
import { broadcastLocalMessage, broadcastPlayerInfo, sendSystemMessageToUser } from './network/ChatSocket';
import { ServerChunkManager } from './ChunkManager';
import { QuestService } from './quest/QuestService';
import { consumeSpellCosts } from './magic/SpellCosts';
import { DEFAULT_MAX_SEARCH_TILES, canTravel, expandAndValidateWaypointPath, findPathToAnyTile, findPathToRectInteraction, findPathToTile, isRectInteractionTileReachable, type PathingCollision } from './pathing/Pathing';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { ServerWebSocket } from 'bun';

/** Map string IDs to small integers for blockedObjectTiles encoding */
const mapIdRegistry: Map<string, number> = new Map();

const USE_NO_RECIPE_REPLY = 'Nothing interesting happens.';
const MAGIC_DEBUG_ENABLED = process.env.EQ_MAGIC_DEBUG === '1';
const DEFAULT_HQ_XP_MULTIPLIER = 3.25;
const BOW_STRINGING_HQ_CHANCE = 1 / 256;
type ItemQuantity = { itemId: number; quantity: number };
type PlayerMovementLayerState = { floor: number; y: number; lastFloorChangeTile: number };
type ItemOnItemRecipe = {
  inputItemIds: readonly [number, number];
  consume: readonly ItemQuantity[];
  outputs: readonly ItemQuantity[];
  skill?: SkillId;
  levelRequired?: number;
  xpReward?: number;
  intervalTicks?: number;
  message?: string;
  repeatable?: boolean;
  startMessage?: string;
  stopMessage?: string;
  hqOutputs?: readonly ItemQuantity[];
  hqChance?: number;
  hqXpMultiplier?: number;
};
type ItemOnObjectRecipe = {
  inputItemId: number;
  outputItemId: number;
  objectDefIds: readonly number[];
  message: string;
};
type ItemProductionAction =
  | { kind: 'itemOnItem'; recipe: ItemOnItemRecipe; remaining: number | null; nextTick: number; intervalTicks: number }
  | { kind: 'itemOnObject'; recipe: ItemOnObjectRecipe; objectEntityId: number; remaining: number | null; nextTick: number }
  | { kind: 'waterSource'; objectEntityId: number; nextTick: number }
  | { kind: 'objectRecipe'; objectEntityId: number; recipeIndex: number; remaining: number | null; nextTick: number; intervalTicks: number };
type PendingSpellImpact = {
  impactTick: number;
  attackerId: number;
  targetId: number;
  damage: number;
  spellId: string;
  xpSkill: SkillId;
  magicStance?: MagicStance;
  mapLevel: string;
  floor: number;
};
type PendingSpellImpactPayload = Omit<PendingSpellImpact, 'impactTick' | 'attackerId' | 'targetId' | 'mapLevel' | 'floor'> & {
  kind: 'spell';
};
type PendingSpellImpactEntry = ImpactQueueEntry<PendingSpellImpactPayload>;
const LOG_CRAFT_INTERVAL_TICKS = 3;
function indefiniteArticle(noun: string): 'a' | 'an' {
  return /^[aeiou]/i.test(noun.trim()) ? 'an' : 'a';
}

function createArrowShaftRecipe(logItemId: number, shaftQuantity: number, logLabel: string): ItemOnItemRecipe {
  return {
    inputItemIds: [KNIFE_ITEM_ID, logItemId],
    consume: [{ itemId: logItemId, quantity: 1 }],
    outputs: [{ itemId: ARROW_SHAFTS_ITEM_ID, quantity: shaftQuantity }],
    skill: 'crafting',
    levelRequired: 1,
    xpReward: 5,
    intervalTicks: LOG_CRAFT_INTERVAL_TICKS,
    message: `You carve the ${logLabel} into ${shaftQuantity} arrow shafts.`,
    repeatable: true,
    startMessage: 'You start carving arrow shafts.',
    stopMessage: 'You run out of logs.',
  };
}

function createShortbowCarvingRecipe(recipe: typeof LOG_CRAFT_SHORTBOW_RECIPES[number]): ItemOnItemRecipe {
  const outputLabel = `unstrung ${recipe.bowLabel}`;
  return {
    inputItemIds: [KNIFE_ITEM_ID, recipe.logItemId],
    consume: [{ itemId: recipe.logItemId, quantity: 1 }],
    outputs: [{ itemId: recipe.unstrungItemId, quantity: 1 }],
    skill: 'crafting',
    levelRequired: recipe.levelRequired,
    xpReward: recipe.carveXpReward,
    intervalTicks: LOG_CRAFT_INTERVAL_TICKS,
    message: `You carve the ${recipe.logLabel} into ${indefiniteArticle(outputLabel)} ${outputLabel}.`,
    repeatable: true,
    startMessage: `You start carving ${outputLabel}s.`,
    stopMessage: 'You run out of logs.',
  };
}

function createShortbowStringingRecipe(recipe: typeof LOG_CRAFT_SHORTBOW_RECIPES[number]): ItemOnItemRecipe {
  return {
    inputItemIds: [BOWSTRING_ITEM_ID, recipe.unstrungItemId],
    consume: [{ itemId: BOWSTRING_ITEM_ID, quantity: 1 }, { itemId: recipe.unstrungItemId, quantity: 1 }],
    outputs: [{ itemId: recipe.strungItemId, quantity: 1 }],
    hqOutputs: [{ itemId: recipe.hqStrungItemId, quantity: 1 }],
    hqChance: BOW_STRINGING_HQ_CHANCE,
    hqXpMultiplier: DEFAULT_HQ_XP_MULTIPLIER,
    skill: 'crafting',
    levelRequired: recipe.levelRequired,
    xpReward: recipe.stringXpReward,
    message: `You string the ${recipe.bowLabel}.`,
  };
}

function createArrowFletchingRecipe(recipe: typeof ARROWHEAD_FLETCHING_RECIPES[number]): ItemOnItemRecipe {
  const arrowName = `${recipe.arrowLabel} arrow`;
  return {
    inputItemIds: [HEADLESS_ARROWS_ITEM_ID, recipe.arrowheadItemId],
    consume: [{ itemId: HEADLESS_ARROWS_ITEM_ID, quantity: 1 }, { itemId: recipe.arrowheadItemId, quantity: 1 }],
    outputs: [{ itemId: recipe.arrowItemId, quantity: 1 }],
    skill: 'crafting',
    levelRequired: recipe.levelRequired,
    xpReward: recipe.xpReward,
    message: `You make ${indefiniteArticle(arrowName)} ${arrowName}.`,
    repeatable: true,
    startMessage: `You start making ${recipe.arrowLabel} arrows.`,
    stopMessage: 'You run out of headless arrows or arrowheads.',
  };
}
const ITEM_ON_ITEM_RECIPES: readonly ItemOnItemRecipe[] = [
  {
    inputItemIds: [CLAY_ITEM_ID, POT_OF_WATER_ITEM_ID], // Clay + Pot of Water
    consume: [{ itemId: CLAY_ITEM_ID, quantity: 1 }, { itemId: POT_OF_WATER_ITEM_ID, quantity: 1 }],
    outputs: [{ itemId: SOFT_CLAY_ITEM_ID, quantity: 1 }, { itemId: POT_ITEM_ID, quantity: 1 }],
    message: 'You soften the clay.',
    repeatable: true,
    startMessage: 'You start softening the clay.',
    stopMessage: 'You run out of clay or water.',
  },
  {
    inputItemIds: [CLAY_ITEM_ID, BUCKET_OF_WATER_ITEM_ID], // Clay + Bucket of Water
    consume: [{ itemId: CLAY_ITEM_ID, quantity: 1 }, { itemId: BUCKET_OF_WATER_ITEM_ID, quantity: 1 }],
    outputs: [{ itemId: SOFT_CLAY_ITEM_ID, quantity: 1 }, { itemId: BUCKET_ITEM_ID, quantity: 1 }],
    message: 'You soften the clay.',
    repeatable: true,
    startMessage: 'You start softening the clay.',
    stopMessage: 'You run out of clay or water.',
  },
  {
    inputItemIds: [FEATHER_ITEM_ID, ARROW_SHAFTS_ITEM_ID],
    consume: [{ itemId: FEATHER_ITEM_ID, quantity: 1 }, { itemId: ARROW_SHAFTS_ITEM_ID, quantity: 1 }],
    outputs: [{ itemId: HEADLESS_ARROWS_ITEM_ID, quantity: 1 }],
    skill: 'crafting',
    levelRequired: 1,
    xpReward: 1,
    message: 'You attach a feather to the arrow shaft.',
    repeatable: true,
    startMessage: 'You start making headless arrows.',
    stopMessage: 'You run out of feathers or arrow shafts.',
  },
  ...ARROWHEAD_FLETCHING_RECIPES.map(createArrowFletchingRecipe),
  {
    inputItemIds: [KNIFE_ITEM_ID, LOGS_ITEM_ID],
    consume: [{ itemId: LOGS_ITEM_ID, quantity: 2 }],
    outputs: [{ itemId: BUCKET_ITEM_ID, quantity: 1 }],
    skill: 'crafting',
    levelRequired: 1,
    xpReward: 4,
    intervalTicks: LOG_CRAFT_INTERVAL_TICKS * 2,
    message: 'You carve the logs into a bucket.',
    repeatable: true,
    startMessage: 'You start carving buckets.',
    stopMessage: 'You run out of logs.',
  },
  ...LOG_CRAFT_SHORTBOW_RECIPES.map(createShortbowCarvingRecipe),
  ...LOG_CRAFT_SHORTBOW_RECIPES.map(createShortbowStringingRecipe),
  ...LOG_CRAFT_ARROW_SHAFT_RECIPES.map(({ logItemId, shaftQuantity, logLabel }) => createArrowShaftRecipe(logItemId, shaftQuantity, logLabel)),
];
const ITEM_ON_OBJECT_RECIPES: readonly ItemOnObjectRecipe[] = [
  {
    inputItemId: BUCKET_ITEM_ID,
    outputItemId: BUCKET_OF_WATER_ITEM_ID,
    objectDefIds: [WELL_OBJECT_DEF_ID],
    message: 'You fill the bucket with water.',
  },
  {
    inputItemId: POT_ITEM_ID,
    outputItemId: POT_OF_WATER_ITEM_ID,
    objectDefIds: [WELL_OBJECT_DEF_ID],
    message: 'You fill the pot with water.',
  },
];
let nextMapIdx = 0;
function getMapIdx(mapId: string): number {
  let idx = mapIdRegistry.get(mapId);
  if (idx === undefined) { idx = nextMapIdx++; mapIdRegistry.set(mapId, idx); }
  return idx;
}
/** Encode map+floor+tile into a stable object-blocker key. */
function blockedKey(mapIdx: number, floor: number, tileX: number, tileZ: number): string {
  return `${mapIdx}|${Math.floor(floor)}|${Math.floor(tileX)}|${Math.floor(tileZ)}`;
}
const FULL_TILE_WALL_MASK = WallEdge.N | WallEdge.E | WallEdge.S | WallEdge.W;
const HITPOINTS_SKILL_INDEX = ALL_SKILLS.indexOf('hitpoints' as SkillId);

// ---------------------------------------------------------------------------
// Wire-format / timing constants
// ---------------------------------------------------------------------------

/** World coordinates are quantized to 0.1-tile units for int16 packet fields. */
const POSITION_SCALE = 10;
/** Quantize a world coordinate to the int16 wire format (1 unit = 0.1 tile). */
function qPos(coord: number): number { return Math.round(coord * POSITION_SCALE); }
const NPC_FACING_NONE = -32768;
function qFacing(angle: number | null | undefined): number {
  return angle == null || !Number.isFinite(angle) ? NPC_FACING_NONE : Math.round(angle * 1000);
}

/** Default respawn time (ticks) for world objects whose def omits `respawnTime`.
 *  At 600ms/tick this is ~2 minutes. */
const DEFAULT_OBJECT_RESPAWN_TICKS = 200;
const COOKING_RECIPE_TICKS = 4;
const SPINNING_WHEEL_RECIPE_TICKS = 3;
/** Despawn timer (ticks) applied to player-dropped items.
 *  ~2 minutes at 600ms/tick. */
const GROUND_ITEM_DESPAWN_TICKS = 200;
/** NPC loot is private to the top damager for ~1 minute, then visible to
 *  everyone nearby before despawning around the classic 3-minute mark. */
const NPC_LOOT_PRIVATE_TICKS = 100;
const NPC_LOOT_DESPAWN_TICKS = 300;
/** Longer despawn for items dropped on player death so a corpse run actually
 *  reaches the pile. ~3 minutes at 600ms/tick. */
const DEATH_DROP_DESPAWN_TICKS = 300;
/** Despawn timer (ticks) for items spilled at the player's feet when a
 *  refund (trade abort, bank close-out) doesn't fit in inventory. Shorter
 *  than the standard despawn since the item is dropped in the player's
 *  immediate vicinity and they can pick it back up right away. ~1 minute. */
const REFUND_SPILL_DESPAWN_TICKS = 100;
/** How long to keep a dropped socket's player in-world for client reconnect.
 *  38 ticks at 600ms is just under 23s, matching the client's retry window. */
const RECONNECT_GRACE_TICKS = 38;
/** OSRS-inspired x-log safety cap: force-close disconnected combat logouts
 *  after 60s even if NPC combat keeps re-arming the 10s combat timer. */
const DISCONNECTED_COMBAT_LOGOUT_TICKS = Math.ceil(60_000 / TICK_RATE);
const IDLE_WARNING_TICKS = Math.ceil(4 * 60_000 / TICK_RATE);
const IDLE_LOGOUT_TICKS = Math.ceil(5 * 60_000 / TICK_RATE);
const BANKER_ACKNOWLEDGE_LINE = 'Certainly.';
const BANKER_BANK_OPEN_DELAY_TICKS = 4;
const DIALOGUE_SESSION_MAX = 0x7fff;
const PLAYER_NPC_INTERACTION_PATH_SEARCH_STEPS = DEFAULT_MAX_SEARCH_TILES;
const PLAYER_FOLLOW_PATH_SEARCH_STEPS = DEFAULT_MAX_SEARCH_TILES;
const MITHRIL_ROCK_OBJECT_DEF_ID = 16;
const MITHRIL_PICKAXE_ITEM_ID = 55;
const MITHRIL_PICKAXE_FIND_CHANCE = 1 / 2048;
const RARE_DROP_LOG_CHANCE_THRESHOLD = 1 / 32;
const RARE_DROP_TABLE_CHAT_MESSAGE = "All of a sudden you're feeling very lucky...";
const LOW_VALUE_NPC_DROP_LOG_SUPPRESSION_ITEM_IDS = new Set([
  1,   // Bones
  20,  // Big Bones
  297, // Bear Hide
  300, // Camel Hide
  301, // Human Skin
]);

/** Canonical ordering of equipment slots used for binary opcode encoding.
 *  Must stay in sync with the client-side decoder in GameManager. */
const EQUIPMENT_SLOT_NAMES: EquipSlot[] = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape', 'ammo'];
const MAPS_DIR = resolve(import.meta.dir, '../data/maps');

export interface GroundItem {
  id: number;
  itemId: number;
  quantity: number;
  x: number;
  z: number;
  floor: number;
  mapLevel: string;
  despawnTimer: number;
  ownerPlayerId?: number;
  privateTicks?: number;
  spawnKey?: string;
}

interface GroundItemRespawnSource {
  itemId: number;
  quantity: number;
  x: number;
  z: number;
  floor: number;
  mapLevel: string;
  respawnTime: number;
  respawnTimer: number;
}

interface RuntimeObjectSpawn {
  objectId: number;
  assetId?: string;
  x: number;
  z: number;
  y?: number;
  floor?: number;
  rotY?: number;
  name?: string;
  examineText?: string;
  interactions?: WorldObject['interactions'];
  defaultOpen?: boolean;
  openDirection?: -1 | 1;
  locked?: boolean;
  keyItemId?: number;
  consumeKey?: boolean;
  lockedMessage?: string;
  altarTier?: number;
  trigger?: WorldObject['trigger'];
  verticalLinks?: WorldObject['verticalLinks'];
  interactionTiles?: WorldObject['interactionTiles'];
  interactionSides?: number;
}

interface RuntimeGroundItemSpawn {
  itemId: number;
  quantity?: number;
  x: number;
  z: number;
  y?: number;
  floor?: number;
}

type SyncPacket = {
  data: Uint8Array;
  opcode?: ServerOpcode;
  values?: number[];
};

type QueuedPositionCheckpoint = {
  accountId: number;
  player: Player;
  effectiveY: number;
};

type QueuedObjectRespawnWrite =
  | {
      type: 'save';
      mapLevel: string;
      defId: number;
      tileX: number;
      tileZ: number;
      floor: number;
      respawnAtUnixMs: number;
    }
  | {
      type: 'clear';
      mapLevel: string;
      defId: number;
      tileX: number;
      tileZ: number;
      floor: number;
    };

type LadderAction = 'Climb-up' | 'Climb-down';

interface ResolvedVerticalEndpoint {
  mapId: string;
  x: number;
  z: number;
  floor: number;
  y?: number;
}

interface DirectedVerticalLink {
  linkId: string;
  action: LadderAction;
  from: ResolvedVerticalEndpoint;
  to: ResolvedVerticalEndpoint;
}

type MutableNpcSpawn = SpawnEntry & { id?: number };

export interface NpcGearPersistResult {
  ok: boolean;
  message: string;
}

type DialogueScheduledStep =
  | {
      type: 'openShop';
      runAtTick: number;
      playerId: number;
      npcEntityId: number;
      sessionId: number;
    }
  | {
      type: 'openBank';
      runAtTick: number;
      playerId: number;
      npcEntityId: number;
      sessionId: number;
    };

interface ObjectSayScheduledLine {
  runAtTick: number;
  playerId: number;
  accountId: number;
  isAdmin: boolean;
  isModerator: boolean;
  playerName: string;
  message: string;
}

/** One side of a trade session — owner's id, current offer (28 slots), and
 *  current accept stage. Stages: 0 = editing, 1 = locked, 2 = final-accept. */
interface TradeSide {
  id: number;
  offer: ({ itemId: number; quantity: number } | null)[];
  stage: 0 | 1 | 2;
}
interface TradeSession {
  a: TradeSide;
  b: TradeSide;
}

type StakeSlot = { itemId: number; quantity: number } | null;

interface DuelStakeSide {
  id: number;
  stake: StakeSlot[];
  stage: 0 | 1 | 2;
}
interface DuelStakeSession {
  a: DuelStakeSide;
  b: DuelStakeSide;
}
interface ActiveDuelSide {
  id: number;
  stake: StakeSlot[];
  startHealth: number;
}
interface ActiveDuel {
  a: ActiveDuelSide;
  b: ActiveDuelSide;
  mapLevel: string;
  floor: number;
  startedTick: number;
}

type MagicCastPreparation = {
  def: SpellEffectDef;
  xpSkill: SkillId;
  magicLevel: number;
  spellIndex: number;
};

const GROUND_ITEM_ENTITY_ID_MIN = 20000;
const GROUND_ITEM_ENTITY_ID_MAX = 32760;
const DEFAULT_SHOP_RESTOCK_TICKS = 100;
let nextGroundItemId = GROUND_ITEM_ENTITY_ID_MIN;

export type WorldOptions = {
  onPlayerAvatarDirty?: (accountId: number, username: string) => void;
};

export class World {
  readonly maps: Map<string, GameMap> = new Map();
  readonly chunkManagers: Map<string, ServerChunkManager> = new Map();
  readonly data: DataLoader;
  readonly db: GameDatabase;
  private readonly options: WorldOptions;
  private readonly quests: QuestService;
  readonly players: Map<number, Player> = new Map();

  /** True if there's an active session from `deviceId` belonging to a
   *  DIFFERENT account than `excludeAccountId`. Used by /api/login to enforce
   *  the one-account-per-browser rule. Per-browser, not per-IP — friends
   *  sharing a household / dorm / cafe each have their own localStorage.
   *  Disconnected players (within the reconnect grace window) don't count —
   *  the user has clearly moved on if they're logging in with a different
   *  account from the same browser, and the grace period exists for the
   *  same account to reconnect, not to block other accounts. */
  hasOtherActiveAccountFromDevice(deviceId: string, excludeAccountId: number): boolean {
    if (!deviceId) return false;
    for (const [, p] of this.players) {
      if (p.disconnected || p.requestIdleLogout) continue;
      if (p.deviceId === deviceId && p.accountId !== excludeAccountId) return true;
    }
    return false;
  }

  getActivePlayerByAccountId(accountId: number): Player | undefined {
    for (const [, player] of this.players) {
      if (player.accountId === accountId && !player.disconnected && !player.requestIdleLogout) {
        return player;
      }
    }
    return undefined;
  }

  setActiveAccountModerator(accountId: number, isModerator: boolean): boolean {
    const player = this.getActivePlayerByAccountId(accountId);
    if (!player) return false;
    player.isModerator = isModerator;
    player.syncDirty = true;
    broadcastPlayerInfo(player.id, player.name, player.isAdmin, player.isModerator);
    return true;
  }

  getOnlinePlayerCount(): number {
    let count = 0;
    for (const [, player] of this.players) {
      if (!player.disconnected && !player.requestIdleLogout) count++;
    }
    return count;
  }

  /** Fire-and-forget PTR lookup. Writes back to login_history.reverse_dns
   *  when the lookup resolves; silently ignores failures. Bounded by Node's
   *  DNS resolver — won't block the tick loop. */
  private lookupReverseDns(ip: string, loginRowId: number): void {
    void import('dns').then((dns) => {
      dns.reverse(ip, (err, hostnames) => {
        if (err || !hostnames || hostnames.length === 0) return;
        try { this.db.setLoginReverseDns(loginRowId, hostnames[0]); } catch { /* swallow */ }
      });
    }).catch(() => { /* dns module unavailable; skip */ });
  }

  readonly npcs: Map<number, Npc> = new Map();
  readonly groundItems: Map<number, GroundItem> = new Map();
  readonly worldObjects: Map<number, WorldObject> = new Map();
  private doorObjectsByMap: Map<string, Set<WorldObject>> = new Map();
  /** Tiles blocked by non-depleted world objects, keyed by map+floor+tile. */
  private blockedObjectTiles: Set<string> = new Set();
  // Tile occupancy for entities (players + NPC footprints), rebuilt at the
  // top of each tick. NPC chase/wander checks this so NPCs do not stack with
  // entities, but player movement intentionally ignores player occupancy:
  // players are allowed to walk through and stand on the same tile.
  private entityTileOccupants: Set<number> = new Set();
  private playerTileOccupants: Set<number> = new Set();
  private entityTileOccupantsDirty: boolean = true;

  private currentTick: number = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private nextDialogueSessionId: number = 1;
  private dialogueScheduledSteps: DialogueScheduledStep[] = [];
  private objectSayScheduledLines: ObjectSayScheduledLine[] = [];
  private pendingPositionCheckpoints: Map<number, QueuedPositionCheckpoint> = new Map();
  private pendingObjectRespawnWrites: Map<string, QueuedObjectRespawnWrite> = new Map();

  // Player combat targets (playerId -> npcId)
  private playerCombatTargets: Map<number, number> = new Map();
  // Reverse lookup: npcId -> set of playerIds targeting it (kept in sync with playerCombatTargets)
  private npcTargetedBy: Map<number, Set<number>> = new Map();
  private combatSystem: CombatSystem = new CombatSystem();

  /** Ground items with active despawn timers (avoids iterating all permanent items) */
  private despawningItemIds: Set<number> = new Set();
  /** Editor-authored ground item sources keyed by stable map/asset/position data. */
  private groundItemRespawnSources: Map<string, GroundItemRespawnSource> = new Map();
  /** Ground item source keys currently waiting to respawn. */
  private activeGroundItemRespawnKeys: Set<string> = new Set();

  /** World objects currently depleted and awaiting respawn */
  private depletedObjectIds: Set<number> = new Set();

  /** Reusable set for health regen — avoids allocation every regen tick */
  private _playersUnderNpcAttack: Set<number> = new Set();

  // Skilling: player -> { objectId, action, cycleTime, toolItemId, toolBonus }
  // cycleTime = inter-roll period in ticks (computed once at interaction start).
  // Per-player roll tick lives on Player.actionDelay (RS2 %action_delay varp).
  private skillingActions: Map<number, { objectId: number; action: string; cycleTime: number; toolItemId?: number; toolBonus?: number }> = new Map();
  private itemProductionActions: Map<number, ItemProductionAction> = new Map();

  private static readonly DEFAULT_MINING_RATE = 7;
  private static readonly MINING_TOOL_SPEED_REDUCTION_BY_BONUS: Record<number, number> = {
    0: 0, // Bronze: 7 ticks
    1: 1, // Iron: 6 ticks
    2: 2, // Steel: 5 ticks
    3: 2, // Black Bronze: 5 ticks
    4: 3, // Mithril: 4 ticks; leave 3/2 ticks for future tiers.
  };

  private static readonly PVM_COMBAT_LOCK_TICKS = 8;

  /**
   * Compatibility view for older tests and admin harnesses. Spell impacts are
   * owned by CombatSystem's central impact queue; this accessor translates the
   * legacy shape at the World boundary.
   */
  private get pendingSpellImpacts(): PendingSpellImpact[] {
    return this.listPendingSpellImpacts();
  }

  private set pendingSpellImpacts(impacts: PendingSpellImpact[]) {
    this.replacePendingSpellImpacts(impacts);
  }

  constructor(db: GameDatabase, options: WorldOptions = {}) {
    this.db = db;
    this.options = options;
    this.data = new DataLoader();
    this.quests = new QuestService(this.data, {
      sendToPlayer: (player, opcode, ...values) => this.sendToPlayer(player, opcode, ...values),
      sendLevelUp: (player, skillIndex, newLevel) => this.sendLevelUp(player, skillIndex, newLevel),
      sendChatSystem: (player, message) => this.sendChatSystem(player, message),
      sendInventory: (player) => this.sendInventory(player),
      sendSingleSkill: (player, skillIndex) => this.sendSingleSkill(player, skillIndex),
    });

    // Auto-discover maps from server/data/maps/
    this.discoverAndLoadMaps();

    // Spawn NPCs and objects from data files
    this.spawnNpcs();
    this.spawnWorldObjects();

    // Re-apply persisted door + respawn state captured before the last
    // shutdown. Doors that were open stay open, depleted skilling objects
    // resume their countdown from the saved wall-clock target. Anything
    // whose wall-clock has already elapsed during downtime is dropped and
    // respawns immediately on next tick.
    this.restorePersistedObjectState();
  }

  private getDb(): GameDatabase {
    if (!this.db) throw new Error('World database is not initialized');
    return this.db;
  }

  /** Re-apply persisted door / respawn state on boot. Called once at the
   *  end of construction, after spawnWorldObjects has populated worldObjects
   *  with their default (closed / not-depleted) state. Rows are keyed by
   *  (mapLevel, defId, tileX, tileZ, floor) — stable across editor saves and
   *  reboots — so we scan worldObjects for the matching live entity instead
   *  of looking up by runtime entity id. */
  private restorePersistedObjectState(): void {
    // One-time pass: build a (map|defId|tx|tz|floor) → WorldObject index so the
    // O(rows × worldObjects) restore work collapses to O(rows + worldObjects).
    const stableIndex = new Map<string, WorldObject>();
    const stableKey = (mapLevel: string, defId: number, tileX: number, tileZ: number, floor: number) =>
      `${mapLevel}|${defId}|${tileX}|${tileZ}|${Math.floor(floor)}`;
    for (const [, obj] of this.worldObjects) {
      stableIndex.set(stableKey(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z), obj.floor), obj);
    }

    try {
      const doorRows = this.db.loadAllDoorStates();
      let restored = 0;
      for (const row of doorRows) {
        const obj = stableIndex.get(stableKey(row.mapLevel, row.defId, row.tileX, row.tileZ, row.floor));
        if (!obj || obj.def.category !== 'door') {
          // Object was deleted from the map or its def changed — drop the
          // stale row. With stable identity this only happens on real
          // edits, not on routine spawn-order reshuffles.
          this.db.clearDoorState(row.mapLevel, row.defId, row.tileX, row.tileZ, row.floor);
          continue;
        }
        if (row.isOpen && !obj.doorOpen) {
          const map = this.maps.get(obj.mapLevel);
          if (!map) continue;
          this.clearDoorWallEdges(obj, map);
          obj.doorOpen = true;
          obj.depleted = true;
          // Re-arm a fresh auto-reset timer. The persisted auto_close_at_tick
          // is informational only — we don't try to map it back through the
          // pre-restart tick clock, just give the door its full timeout again.
          obj.respawnTimer = obj.def.respawnTime ?? DEFAULT_OBJECT_RESPAWN_TICKS;
          this.depletedObjectIds.add(obj.id);
          restored++;
        } else if (!row.isOpen && obj.doorDefaultOpen && obj.doorOpen) {
          const map = this.maps.get(obj.mapLevel);
          if (!map) continue;
          this.restoreDoorWallEdges(obj, map);
          obj.doorOpen = false;
          obj.depleted = false;
          obj.respawnTimer = obj.def.respawnTime ?? DEFAULT_OBJECT_RESPAWN_TICKS;
          this.depletedObjectIds.add(obj.id);
          restored++;
        } else if (row.isOpen === obj.doorDefaultOpen) {
          this.db.clearDoorState(row.mapLevel, row.defId, row.tileX, row.tileZ, row.floor);
        }
      }
      if (restored > 0) console.log(`Restored ${restored} persisted door state(s)`);
    } catch (e) {
      console.error('restorePersistedObjectState (doors) failed:', e);
    }

    try {
      const respawnRows = this.db.loadAllObjectRespawns();
      const now = Date.now();
      let restored = 0;
      for (const row of respawnRows) {
        const obj = stableIndex.get(stableKey(row.mapLevel, row.defId, row.tileX, row.tileZ, row.floor));
        if (!obj) {
          this.db.clearObjectRespawn(row.mapLevel, row.defId, row.tileX, row.tileZ, row.floor);
          continue;
        }
        // Doors handled by door_state above; skip here.
        if (obj.def.category === 'door') continue;
        const msRemaining = row.respawnAtUnixMs - now;
        if (msRemaining <= 0) {
          // Already due — drop the row, leave the live spawn alone.
          this.db.clearObjectRespawn(row.mapLevel, row.defId, row.tileX, row.tileZ, row.floor);
          continue;
        }
        const maxRespawnTicks = Math.max(1, obj.def.respawnTime ?? DEFAULT_OBJECT_RESPAWN_TICKS);
        const ticksRemaining = Math.min(maxRespawnTicks, Math.max(1, Math.ceil(msRemaining / TICK_RATE)));
        obj.depleted = true;
        obj.respawnTimer = ticksRemaining;
        this.depletedObjectIds.add(obj.id);
        // Tiles stay blocked — depleted ores/stumps still physically occupy
        // their tile. Mirrors the depletion-site policy below.
        restored++;
      }
      if (restored > 0) console.log(`Restored ${restored} persisted object respawn timer(s)`);
    } catch (e) {
      console.error('restorePersistedObjectState (respawns) failed:', e);
    }
  }

  private discoverAndLoadMaps(): void {
    const mapsDir = `${import.meta.dir}/../data/maps`;
    try {
      const entries = readdirSync(mapsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          try {
            this.loadMap(entry.name);
          } catch (e) {
            console.warn(`Failed to load map '${entry.name}':`, e);
          }
        }
      }
    } catch (e) {
      console.error('Failed to discover maps:', e);
    }
    console.log(`Loaded ${this.maps.size} maps: ${[...this.maps.keys()].join(', ')}`);
  }

  private loadMap(mapId: string): void {
    const gameMap = new GameMap(mapId);
    this.maps.set(mapId, gameMap);
    this.chunkManagers.set(mapId, new ServerChunkManager(gameMap.width, gameMap.height));
  }

  reloadMap(mapId: string): void {
    console.log(`Hot-reloading map '${mapId}'...`);
    const gameMap = new GameMap(mapId);
    this.maps.set(mapId, gameMap);
    const cm = new ServerChunkManager(gameMap.width, gameMap.height);
    this.chunkManagers.set(mapId, cm);
    this.doorObjectsByMap.delete(mapId);

    // Remove old NPCs and world objects for this map
    for (const [id, npc] of this.npcs) {
      if (npc.currentMapLevel === mapId) this.npcs.delete(id);
    }
    for (const [id, obj] of this.worldObjects) {
      if (obj.mapLevel === mapId) {
        this.setObjectTilesBlocked(mapId, obj.x, obj.z, obj.def, false, obj.floor, obj.interactionTiles, obj.rotationY);
        this.worldObjects.delete(id);
      }
    }

    // Re-spawn NPCs and world objects
    const spawns = this.data.loadSpawns(mapId);
    for (const spawn of spawns.npcs ?? []) {
      const npcDef = this.data.getNpc(spawn.npcId);
      if (!npcDef) continue;
      const bankAccessViolation = bankAccessSpawnViolation(mapId, spawn, npcDef);
      if (bankAccessViolation) {
        console.error(`[spawn guard] Skipping ${bankAccessViolation}`);
        continue;
      }
      const npc = new Npc(npcDef, spawn.x, spawn.z, this.npcOptionsFromSpawn(spawn, npcDef));
      npc.currentMapLevel = mapId;
      npc.currentFloor = this.resolveAuthoredFloor(gameMap, spawn.x, spawn.z, spawn.y, spawn.floor).floor;
      this.npcs.set(npc.id, npc);
      cm.addEntity(npc.id, spawn.x, spawn.z, 'npc');
    }
    const objectSpawns = this.collectObjectSpawns(mapId, gameMap, spawns.objects ?? []);
    for (const spawn of objectSpawns) {
      const objDef = this.data.getObject(spawn.objectId);
      if (!objDef) continue;
      const obj = this.createWorldObject(objDef, spawn, mapId);
      this.worldObjects.set(obj.id, obj);
      this.setObjectTilesBlocked(mapId, obj.x, obj.z, obj.def, true, obj.floor, obj.interactionTiles, obj.rotationY);
      if (objDef.category === 'door') {
        this.initializeDoorObject(obj, gameMap);
      }
      cm.addEntity(obj.id, spawn.x, spawn.z, 'object');
    }

    // Re-spawn ground items for this map
    for (const [id, item] of this.groundItems) {
      if (item.mapLevel !== mapId) continue;
      this.groundItems.delete(id);
      this.despawningItemIds.delete(id);
      cm.removeEntity(id);
      for (const [, player] of this.players) {
        player.visibleEntityIds.delete(id);
      }
    }
    this.clearGroundItemRespawnSourcesForMap(mapId);
    this.spawnStaticGroundItems(mapId, gameMap, spawns.items ?? []);
    this.spawnPlacedGroundItems(mapId, gameMap);

    // Re-register players on this map
    for (const [id, player] of this.players) {
      if (player.currentMapLevel === mapId) {
        cm.addEntity(id, player.position.x, player.position.y, 'player');
        cm.registerPlayer(id);
      }
    }
    this.markEntityTileOccupantsDirty();
    // Send MAP_CHANGE to all players — entity data will be sent when client responds with MAP_READY
    for (const [, player] of this.players) {
      if (player.currentMapLevel === mapId) {
        this.sendMapChange(player, mapId);
      }
    }
    console.log(`Map '${mapId}' reloaded: ${gameMap.width}x${gameMap.height}`);
  }

  /** Client finished loading the map — send all entity data now */
  handleMapReady(playerId: number): void {
    const player = this.players.get(playerId);
    if (!player || player.disconnected) return;
    const mapId = player.currentMapLevel;
    const cm = this.chunkManagers.get(mapId);
    if (!cm) return;

    // Use chunk manager to get all nearby entities (players, NPCs, world objects, ground items)
    const nearbyIds = cm.getEntitiesNear(player.position.x, player.position.y);
    for (const eid of nearbyIds) {
      if (eid === player.id) continue;
      const other = this.players.get(eid);
      if (other && other.currentFloor === player.currentFloor) { this.sendPlayerPresence(player, other); continue; }
      const npc = this.npcs.get(eid);
      if (npc && this.canPlayerSyncNpc(player, npc)) {
        // Static data first — the client uses cached appearance to decide
        // whether to render as sprite or CharacterEntity on NPC_SYNC.
        this.sendNpcStaticData(player, npc);
        this.sendNpcUpdate(player, npc);
        continue;
      }
      const obj = this.worldObjects.get(eid);
      if (obj && this.canPlayerTargetObject(player, obj)) { this.sendWorldObjectUpdate(player, obj); continue; }
      const item = this.groundItems.get(eid);
      if (item && this.canPlayerTargetGroundItem(player, item)) { this.sendGroundItemUpdate(player, item); continue; }
    }
    this.sendSkills(player);
    this.sendInventory(player);
    this.sendEquipment(player);
  }

  getMap(mapId: string): GameMap {
    const m = this.maps.get(mapId);
    if (!m) throw new Error(`Unknown map: ${mapId}`);
    return m;
  }

  /** Get the map the player is currently on */
  getPlayerMap(player: Player): GameMap {
    return this.getMap(player.currentMapLevel);
  }

  private resolveAuthoredFloor(
    map: GameMap,
    x: number,
    z: number,
    authoredY?: number,
    authoredFloor?: number,
  ): { floor: number; y: number } {
    if (Number.isFinite(authoredFloor)) {
      const floor = Math.floor(authoredFloor!);
      const y = Number.isFinite(authoredY)
        ? authoredY!
        : map.getEffectiveHeightOnFloor(x, z, floor, floor > 0 ? Number.POSITIVE_INFINITY : undefined);
      return { floor, y };
    }

    if (Number.isFinite(authoredY)) {
      const targets = map.getWalkableFloorTargetsAt(x, z);
      if (targets.length > 0) {
        let best = targets[0];
        let bestDist = Math.abs(best.y - authoredY!);
        for (let i = 1; i < targets.length; i++) {
          const dist = Math.abs(targets[i].y - authoredY!);
          if (dist < bestDist) {
            best = targets[i];
            bestDist = dist;
          }
        }
        return { floor: best.floor, y: authoredY! };
      }
      return { floor: 0, y: authoredY! };
    }

    return { floor: 0, y: map.getEffectiveHeightOnFloor(x, z, 0) };
  }

  private floorWorldY(mapId: string, x: number, z: number, floor: number, currentY?: number): number {
    const map = this.maps.get(mapId);
    if (!map) return 0;
    const heightGateY = currentY ?? (floor > 0 ? Number.POSITIVE_INFINITY : undefined);
    return map.getEffectiveHeightOnFloor(x, z, floor, heightGateY);
  }

  private npcWorldY(npc: Npc): number {
    return this.floorWorldY(npc.currentMapLevel, npc.position.x, npc.position.y, npc.currentFloor);
  }

  canPlayerTargetNpc(player: Player, npc: Npc): boolean {
    return !npc.dead
      && npc.currentMapLevel === player.currentMapLevel
      && (npc.currentFloor ?? 0) === player.currentFloor
      && this.canPlayerSeeNpc(player, npc);
  }

  private canPlayerSyncNpc(player: Player, npc: Npc): boolean {
    return !npc.dead
      && npc.currentMapLevel === player.currentMapLevel
      && this.canPlayerSeeNpc(player, npc);
  }

  private canPlayerSeeNpc(player: Player, npc: Npc): boolean {
    return !npc.visibilityCondition || this.quests.questConditionMet(player, npc.visibilityCondition);
  }

  canPlayerTargetObject(player: Player, obj: WorldObject): boolean {
    if (obj.mapLevel !== player.currentMapLevel) return false;
    // Keep ladders synced/pickable across nearby floors; ladderActionMask gates
    // which climb actions are actually available to this player.
    if (obj.def.category === 'ladder') return true;
    if ((obj.floor ?? 0) === player.currentFloor) return true;
    return false;
  }

  canPlayerTargetGroundItem(player: Player, item: GroundItem): boolean {
    return item.mapLevel === player.currentMapLevel
      && (item.floor ?? 0) === player.currentFloor
      && this.isGroundItemVisibleTo(player, item);
  }

  private canPlayerReachGroundItemFromCurrentTile(player: Player, item: GroundItem, map: GameMap = this.getPlayerMap(player)): boolean {
    if (!this.canPlayerTargetGroundItem(player, item)) return false;
    const fromTileX = Math.floor(player.position.x);
    const fromTileZ = Math.floor(player.position.y);
    const itemTileX = Math.floor(item.x);
    const itemTileZ = Math.floor(item.z);
    const dx = itemTileX - fromTileX;
    const dz = itemTileZ - fromTileZ;
    if (dx === 0 && dz === 0) return true;
    if (Math.abs(dx) > 1 || Math.abs(dz) > 1) return false;
    return canTravel(this.playerPathCollision(player, map), fromTileX, fromTileZ, dx, dz);
  }

  private canPlayerReachPlayer(player: Player, target: Player, maxRange: number): boolean {
    if (player.id === target.id) return false;
    if (player.currentMapLevel !== target.currentMapLevel || player.currentFloor !== target.currentFloor) return false;
    if (this.tileChebyshev(player, target) > maxRange) return false;
    const fromTileX = Math.floor(player.position.x);
    const fromTileZ = Math.floor(player.position.y);
    const targetTileX = Math.floor(target.position.x);
    const targetTileZ = Math.floor(target.position.y);
    const dx = targetTileX - fromTileX;
    const dz = targetTileZ - fromTileZ;
    if (dx === 0 && dz === 0) return true;
    const map = this.getPlayerMap(player);
    const collision = this.playerPathCollision(player, map);
    if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) {
      return canTravel(collision, fromTileX, fromTileZ, dx, dz);
    }
    const path = findPathToTile({
      startX: player.position.x,
      startZ: player.position.y,
      goalX: targetTileX + 0.5,
      goalZ: targetTileZ + 0.5,
      collision,
      maxSearchTiles: Math.max(1, (maxRange * 2 + 1) * (maxRange * 2 + 1)),
    });
    return path.length > 0 && path.length <= maxRange;
  }

  private canPlayerUseLadderOnCurrentFloor(player: Player, obj: WorldObject): boolean {
    return this.ladderActionMaskForPlayer(player, obj) !== 0;
  }

  private canPlayerUseLadderActionOnCurrentFloor(player: Player, obj: WorldObject, action: LadderAction): boolean {
    const mask = this.ladderActionMaskForPlayer(player, obj);
    if (action === 'Climb-down') return (mask & 1) !== 0;
    if (action === 'Climb-up') return (mask & 2) !== 0;
    return false;
  }

  private resolveVerticalEndpoint(obj: WorldObject, endpoint: PlacedObjectVerticalLinkEndpoint | undefined): ResolvedVerticalEndpoint | null {
    if (!endpoint) return null;
    if (!Number.isFinite(endpoint.x) || !Number.isFinite(endpoint.z) || !Number.isFinite(endpoint.floor)) return null;
    const mapId = typeof endpoint.mapId === 'string' && endpoint.mapId.trim()
      ? endpoint.mapId.trim()
      : obj.mapLevel;
    return {
      mapId,
      x: endpoint.x,
      z: endpoint.z,
      floor: Math.floor(endpoint.floor),
      y: Number.isFinite(endpoint.y) ? endpoint.y : undefined,
    };
  }

  private defaultVerticalAction(from: ResolvedVerticalEndpoint, to: ResolvedVerticalEndpoint): LadderAction {
    if (to.floor !== from.floor) return to.floor > from.floor ? 'Climb-up' : 'Climb-down';
    if (to.y !== undefined && from.y !== undefined && Math.abs(to.y - from.y) > 0.1) {
      return to.y > from.y ? 'Climb-up' : 'Climb-down';
    }
    return 'Climb-up';
  }

  private directedVerticalLinksForObject(obj: WorldObject): DirectedVerticalLink[] {
    if (obj.def.category !== 'ladder' || !obj.verticalLinks?.length) return [];
    const out: DirectedVerticalLink[] = [];
    for (let i = 0; i < obj.verticalLinks.length; i++) {
      const link = obj.verticalLinks[i];
      const from = this.resolveVerticalEndpoint(obj, link.from);
      const to = this.resolveVerticalEndpoint(obj, link.to);
      if (!from || !to) continue;
      out.push({
        linkId: link.id ?? String(i),
        action: link.fromAction ?? this.defaultVerticalAction(from, to),
        from,
        to,
      });
      if (link.bidirectional === true) {
        out.push({
          linkId: `${link.id ?? String(i)}:return`,
          action: link.toAction ?? this.defaultVerticalAction(to, from),
          from: to,
          to: from,
        });
      }
    }
    return out;
  }

  private directedVerticalLinksFromPlayerFloor(player: Player, obj: WorldObject): DirectedVerticalLink[] {
    return this.directedVerticalLinksForObject(obj)
      .filter(link => link.from.mapId === player.currentMapLevel && link.from.floor === player.currentFloor);
  }

  private ladderActionMaskForPlayer(player: Player, obj: WorldObject): number {
    let mask = 0;
    for (const link of this.directedVerticalLinksFromPlayerFloor(player, obj)) {
      if (!this.isVerticalEndpointWalkable(link.from) || !this.isVerticalEndpointWalkable(link.to)) continue;
      if (link.action === 'Climb-down') mask |= 1;
      else if (link.action === 'Climb-up') mask |= 2;
    }
    return mask;
  }

  private ladderInteractionTilesForPlayer(player: Player, obj: WorldObject): { x: number; z: number }[] {
    const seen = new Set<string>();
    const out: { x: number; z: number }[] = [];
    for (const link of this.directedVerticalLinksFromPlayerFloor(player, obj)) {
      if (!this.isVerticalEndpointWalkable(link.from) || !this.isVerticalEndpointWalkable(link.to)) continue;
      const tile = { x: Math.floor(link.from.x), z: Math.floor(link.from.z) };
      const key = `${tile.x},${tile.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tile);
    }
    return out;
  }

  private isVerticalEndpointWalkable(endpoint: ResolvedVerticalEndpoint): boolean {
    const map = this.maps.get(endpoint.mapId);
    if (!map) return false;
    if (!Number.isFinite(endpoint.x) || !Number.isFinite(endpoint.z)) return false;
    if (endpoint.x < 0 || endpoint.x >= map.width || endpoint.z < 0 || endpoint.z >= map.height) return false;
    const tx = Math.floor(endpoint.x);
    const tz = Math.floor(endpoint.z);
    if (map.isTileBlockedOnFloor(tx, tz, endpoint.floor)) return false;
    return !this.blockedObjectTiles.has(this.blockedKeyFor(endpoint.mapId, tx, tz, endpoint.floor));
  }

  private resolveLadderLinkForPlayerAction(player: Player, obj: WorldObject, action: LadderAction): DirectedVerticalLink | null {
    const ptx = Math.floor(player.position.x);
    const ptz = Math.floor(player.position.y);
    for (const link of this.directedVerticalLinksFromPlayerFloor(player, obj)) {
      if (link.action !== action) continue;
      if (Math.floor(link.from.x) !== ptx || Math.floor(link.from.z) !== ptz) continue;
      if (!this.isVerticalEndpointWalkable(link.from) || !this.isVerticalEndpointWalkable(link.to)) continue;
      return link;
    }
    return null;
  }

  private playerPathCollision(player: Player, map: GameMap = this.getPlayerMap(player), floor: number = player.currentFloor): PathingCollision {
    const maybeMap = map as Partial<GameMap>;
    const wallBlocked = floor === 0
      ? (typeof maybeMap.isWallBlocked === 'function'
          ? (fx: number, fz: number, tx: number, tz: number) => maybeMap.isWallBlocked!(fx, fz, tx, tz, player.effectiveY)
          : undefined)
      : (typeof maybeMap.isWallBlockedOnFloor === 'function'
          ? (fx: number, fz: number, tx: number, tz: number) => maybeMap.isWallBlockedOnFloor!(fx, fz, tx, tz, floor)
          : undefined);
    return {
      width: map.width,
      height: map.height,
      isTileBlocked: (tileX, tileZ) => this.isPlayerMovementTileBlocked(player, map, tileX, tileZ, floor),
      isWallBlocked: wallBlocked,
    };
  }

  private findPlayerPathToTile(
    player: Player,
    tileX: number,
    tileZ: number,
    maxSearchTiles: number = DEFAULT_MAX_SEARCH_TILES,
  ): { x: number; z: number }[] {
    const map = this.getPlayerMap(player);
    return findPathToTile({
      startX: player.position.x,
      startZ: player.position.y,
      goalX: tileX + 0.5,
      goalZ: tileZ + 0.5,
      collision: this.playerPathCollision(player, map),
      maxSearchTiles,
    });
  }

  /** Path from the player to the NPC's interaction surface. Targets the
   *  closest reachable cardinal-adjacent interaction tile directly, avoiding
   *  post-path trimming that breaks compressed corner paths. */
  private findPlayerPathToNpc(player: Player, npc: Npc): { x: number; z: number }[] {
    const map = this.getPlayerMap(player);
    return findPathToRectInteraction({
      startX: player.position.x,
      startZ: player.position.y,
      targetX: npc.position.x,
      targetZ: npc.position.y,
      targetSize: npc.size,
      collision: this.playerPathCollision(player, map),
      maxSearchTiles: PLAYER_NPC_INTERACTION_PATH_SEARCH_STEPS,
    });
  }

  private isPlayerNpcInteractionReachable(player: Player, npc: Npc): boolean {
    if (!this.canPlayerTargetNpc(player, npc)) return false;
    const map = this.getPlayerMap(player);
    const ptx = Math.floor(player.position.x);
    const ptz = Math.floor(player.position.y);
    if (this.isBankerReachableAcrossBooth(player, npc, ptx, ptz)) return true;
    return isRectInteractionTileReachable(this.playerPathCollision(player, map), ptx, ptz, npc.position.x, npc.position.y, npc.size);
  }

  private isNpcMeleeReachableToPlayer(npc: Npc, player: Player): boolean {
    if (!this.canPlayerTargetNpc(player, npc)) return false;
    const ptx = Math.floor(player.position.x);
    const ptz = Math.floor(player.position.y);
    const map = this.getPlayerMap(player);
    return isRectInteractionTileReachable(this.playerPathCollision(player, map), ptx, ptz, npc.position.x, npc.position.y, npc.size);
  }

  private findBankBoothAt(player: Player, tileX: number, tileZ: number): WorldObject | null {
    for (const obj of this.worldObjects.values()) {
      if (obj.def.category !== 'bank') continue;
      if (obj.mapLevel !== player.currentMapLevel || (obj.floor ?? 0) !== player.currentFloor) continue;
      if (Math.floor(obj.x) === tileX && Math.floor(obj.z) === tileZ) return obj;
    }
    return null;
  }

  private getBankerBoothUseTile(player: Player, npc: Npc, booth: WorldObject): { x: number; z: number } | null {
    if (!npc.hasBank || !this.canPlayerTargetNpc(player, npc)) return null;
    const ntx = Math.floor(npc.position.x);
    const ntz = Math.floor(npc.position.y);
    const bx = Math.floor(booth.x);
    const bz = Math.floor(booth.z);
    const dx = ntx - bx;
    const dz = ntz - bz;
    if (Math.abs(dx) + Math.abs(dz) !== 1) return null;
    return { x: bx - dx, z: bz - dz };
  }

  private isBankerReachableAcrossBooth(player: Player, npc: Npc, ptx = Math.floor(player.position.x), ptz = Math.floor(player.position.y)): boolean {
    if (!npc.hasBank || !this.canPlayerTargetNpc(player, npc)) return false;
    const ntx = Math.floor(npc.position.x);
    const ntz = Math.floor(npc.position.y);
    const dx = ntx - ptx;
    const dz = ntz - ptz;
    if (Math.abs(dx) + Math.abs(dz) !== 2) return false;
    if (Math.abs(dx) === 1 && Math.abs(dz) === 1) return false;
    return this.findBankBoothAt(player, ptx + Math.sign(dx), ptz + Math.sign(dz)) !== null;
  }

  private queuePlayerPathToNpcInteraction(player: Player, npc: Npc): boolean {
    if (!this.canPlayerTargetNpc(player, npc)) return false;
    const boothPath = this.findPlayerPathToBankerBooth(player, npc);
    if (boothPath) {
      player.setMoveQueue(boothPath);
      return true;
    }
    const path = this.findPlayerPathToNpc(player, npc);
    if (path.length === 0) return false;
    player.setMoveQueue(path);
    return true;
  }

  private findPlayerPathToBankerBooth(player: Player, npc: Npc): { x: number; z: number }[] | null {
    if (!npc.hasBank || !this.canPlayerTargetNpc(player, npc)) return null;
    const map = this.getPlayerMap(player);
    const candidates: { booth: WorldObject; useTile: { x: number; z: number } }[] = [];
    for (const obj of this.worldObjects.values()) {
      if (obj.def.category !== 'bank') continue;
      if (obj.mapLevel !== player.currentMapLevel || (obj.floor ?? 0) !== player.currentFloor) continue;
      const useTile = this.getBankerBoothUseTile(player, npc, obj);
      if (!useTile) continue;
      if (this.isTileBlockedForPlayer(player, map, useTile.x, useTile.z)) continue;
      candidates.push({ booth: obj, useTile });
    }
    candidates.sort((a, b) =>
      (Math.abs(player.position.x - (a.useTile.x + 0.5)) + Math.abs(player.position.y - (a.useTile.z + 0.5)))
      - (Math.abs(player.position.x - (b.useTile.x + 0.5)) + Math.abs(player.position.y - (b.useTile.z + 0.5))));
    const collision = this.playerPathCollision(player, map);
    for (const candidate of candidates) {
      if (Math.floor(player.position.x) === candidate.useTile.x && Math.floor(player.position.y) === candidate.useTile.z) return [];
      const path = findPathToTile({
        startX: player.position.x,
        startZ: player.position.y,
        goalX: candidate.useTile.x + 0.5,
        goalZ: candidate.useTile.z + 0.5,
        collision,
        maxSearchTiles: PLAYER_NPC_INTERACTION_PATH_SEARCH_STEPS,
      });
      if (path.length > 0) return path;
    }
    return null;
  }

  private findBankerAcrossBoothFromTile(player: Player, booth: WorldObject, ptx: number, ptz: number): Npc | null {
    const bx = Math.floor(booth.x);
    const bz = Math.floor(booth.z);
    const dx = bx - ptx;
    const dz = bz - ptz;
    if (Math.abs(dx) + Math.abs(dz) !== 1) return null;
    const bankerX = bx + dx;
    const bankerZ = bz + dz;
    for (const npc of this.npcs.values()) {
      if (!npc.hasBank || npc.dead) continue;
      if (npc.currentMapLevel !== player.currentMapLevel || npc.currentFloor !== player.currentFloor) continue;
      if (Math.floor(npc.position.x) === bankerX && Math.floor(npc.position.y) === bankerZ) return npc;
    }
    return null;
  }

  private findBankerAcrossBooth(player: Player, booth: WorldObject): Npc | null {
    return this.findBankerAcrossBoothFromTile(
      player,
      booth,
      Math.floor(player.position.x),
      Math.floor(player.position.y),
    );
  }

  private isPointInNpcFootprintRange(npc: Npc, x: number, z: number, range: number, mode: 'euclidean' | 'chebyshev'): boolean {
    const fp = npc.distToFootprint(x, z);
    return combatRangeIncludesOffset(fp.dx, fp.dz, range, mode);
  }

  private hasRangedLineOfSightFrom(player: Player, npc: Npc, fromX: number, fromZ: number): boolean {
    if (!this.canPlayerTargetNpc(player, npc)) return false;
    const map = this.getPlayerMap(player);
    const sameTile = Math.floor(fromX) === Math.floor(player.position.x)
      && Math.floor(fromZ) === Math.floor(player.position.y);
    const sourceBaseY = sameTile
      ? player.effectiveY
      : map.getEffectiveHeightOnFloor(fromX, fromZ, player.currentFloor, player.effectiveY);
    const sourceY = sourceBaseY + RANGED_PROJECTILE_SOURCE_HEIGHT;
    const targetY = this.npcWorldY(npc) + RANGED_PROJECTILE_TARGET_HEIGHT;
    const size = npc.size;
    if (size <= 1) {
      return map.hasProjectileLineOfSight(
        fromX,
        fromZ,
        npc.position.x,
        npc.position.y,
        player.currentFloor,
        sourceY,
        targetY,
      );
    }
    const minTileX = getObjectFootprintMinTile(npc.position.x, size);
    const minTileZ = getObjectFootprintMinTile(npc.position.y, size);
    for (let dz = 0; dz < size; dz++) {
      for (let dx = 0; dx < size; dx++) {
        if (map.hasProjectileLineOfSight(
          fromX,
          fromZ,
          minTileX + dx + 0.5,
          minTileZ + dz + 0.5,
          player.currentFloor,
          sourceY,
          targetY,
        )) {
          return true;
        }
      }
    }
    return false;
  }

  private isPointInNpcRangedAttackRange(player: Player, npc: Npc, x: number, z: number, range: number = RANGED_ATTACK_DISTANCE): boolean {
    return isNpcInRangedAttackRange(npc, x, z, range)
      && this.hasRangedLineOfSightFrom(player, npc, x, z);
  }

  private isPointInNpcAttackRangeFrom(
    player: Player,
    npc: Npc,
    x: number,
    z: number,
    range: number,
    mode: 'euclidean' | 'chebyshev',
    requireRangedLineOfSight: boolean,
  ): boolean {
    if (requireRangedLineOfSight) return this.isPointInNpcRangedAttackRange(player, npc, x, z, range);
    return this.isPointInNpcFootprintRange(npc, x, z, range, mode);
  }

  private queuePlayerPathToNpcRange(
    player: Player,
    npc: Npc,
    range: number,
    mode: 'euclidean' | 'chebyshev' = 'euclidean',
    requireRangedLineOfSight: boolean = false,
  ): boolean {
    const path = this.findPlayerPathToNpc(player, npc);
    if (path.length === 0) return false;

    let cutIdx = path.length;
    for (let i = 0; i < path.length; i++) {
      if (this.isPointInNpcAttackRangeFrom(
        player,
        npc,
        path[i].x,
        path[i].z,
        range,
        mode,
        requireRangedLineOfSight,
      )) {
        cutIdx = i + 1;
        break;
      }
    }

    const queue = path.slice(0, cutIdx);
    if (queue.length === 0) return false;
    player.setMoveQueue(queue);
    return true;
  }

  private trimPlayerPathToNpcRange(
    player: Player,
    npc: Npc,
    range: number,
    mode: 'euclidean' | 'chebyshev',
    requireRangedLineOfSight: boolean = false,
  ): boolean {
    return player.trimMoveQueueToFirst(step => this.isPointInNpcAttackRangeFrom(
      player,
      npc,
      step.x,
      step.z,
      range,
      mode,
      requireRangedLineOfSight,
    ));
  }

  private notifyClientIfMoveDestinationChanged(player: Player, before: { x: number; z: number } | null): void {
    if (!before) return;
    const after = player.getMoveDestination();
    if (!after) return;
    if (Math.floor(before.x) === Math.floor(after.x) && Math.floor(before.z) === Math.floor(after.z)) return;
    this.sendToPlayer(player, ServerOpcode.PATH_TRUNCATED, qPos(after.x), qPos(after.z));
  }

  private isPlayerInNpcAttackRange(player: Player, npc: Npc, mode: 'melee' | 'ranged' | 'magic', rangedRange: number = RANGED_ATTACK_DISTANCE): boolean {
    if (mode === 'melee') return this.isPlayerNpcInteractionReachable(player, npc);
    if (mode === 'ranged') return this.isPointInNpcRangedAttackRange(player, npc, player.position.x, player.position.y, rangedRange);
    return isPointInNpcMagicAttackRange(npc, player.position.x, player.position.y);
  }

  private setObjectTilesBlocked(
    mapId: string,
    x: number,
    z: number,
    def: WorldObjectDef,
    blocked: boolean,
    floor: number = 0,
    interactionTiles?: ReadonlyArray<{ x: number; z: number }>,
    rotY: number = 0,
  ): void {
    if (!def.blocking || def.category === 'door' || usesMapAuthoredObjectCollision(def)) return;
    let interactionTileKeys: Set<string> | null = null;
    if (interactionTiles?.length) {
      interactionTileKeys = new Set();
      for (const tile of this.explicitObjectInteractionTilesForPlacement(x, z, rotY, interactionTiles)) {
        interactionTileKeys.add(this.blockedKeyFor(mapId, tile.x, tile.z, floor));
      }
    }
    for (const tile of getObjectFootprintTiles(x, z, def)) {
      const key = this.blockedKeyFor(mapId, tile.x, tile.z, floor);
      if (interactionTileKeys?.has(key)) continue;
      if (blocked) this.blockedObjectTiles.add(key);
      else this.blockedObjectTiles.delete(key);
    }
  }

  private mapTileBlockedOnFloor(map: GameMap, tileX: number, tileZ: number, floor: number): boolean {
    const maybeMap = map as Partial<GameMap>;
    if (floor === 0 && typeof maybeMap.isBlocked === 'function') return maybeMap.isBlocked(tileX, tileZ);
    if (typeof maybeMap.isTileBlockedOnFloor === 'function') return maybeMap.isTileBlockedOnFloor(tileX, tileZ, floor);
    if (typeof maybeMap.isBlocked === 'function') return maybeMap.isBlocked(tileX, tileZ);
    return false;
  }

  private isTileBlockedForPlayer(player: Player, map: GameMap, tileX: number, tileZ: number): boolean {
    return this.mapTileBlockedOnFloor(map, tileX, tileZ, player.currentFloor)
      || (this.blockedObjectTiles?.has(this.blockedKeyFor(player.currentMapLevel, tileX, tileZ, player.currentFloor)) ?? false);
  }

  private isPlayerMovementTileBlocked(
    player: Player,
    map: GameMap,
    tileX: number,
    tileZ: number,
    floor: number = player.currentFloor,
  ): boolean {
    const tileKey = this.blockedKeyFor(player.currentMapLevel, tileX, tileZ, floor);
    const staticBlocked = this.mapTileBlockedOnFloor(map, tileX, tileZ, floor) || (this.blockedObjectTiles?.has(tileKey) ?? false);
    return staticBlocked;
  }

  private usesCornerObjectInteraction(obj: WorldObject): boolean {
    return usesCornerInteractionTiles(obj.def, !!obj.interactionSides || !!obj.interactionTiles?.length);
  }

  private rotateLocalInteractionTile(tile: { x: number; z: number }, rotY: number): { x: number; z: number } {
    const q = (((Math.round(rotY / (Math.PI / 2)) % 4) + 4) % 4);
    if (q === 1) return { x: tile.z, z: -tile.x };
    if (q === 2) return { x: -tile.x, z: -tile.z };
    if (q === 3) return { x: -tile.z, z: tile.x };
    return { x: tile.x, z: tile.z };
  }

  private explicitObjectInteractionTilesForPlacement(
    x: number,
    z: number,
    rotY: number,
    interactionTiles?: ReadonlyArray<{ x: number; z: number }>,
  ): { x: number; z: number }[] {
    if (!interactionTiles?.length) return [];
    const baseX = Math.floor(x);
    const baseZ = Math.floor(z);
    const seen = new Set<string>();
    const out: { x: number; z: number }[] = [];
    for (const local of interactionTiles) {
      if (!Number.isFinite(local.x) || !Number.isFinite(local.z)) continue;
      const rotated = this.rotateLocalInteractionTile({ x: Math.round(local.x), z: Math.round(local.z) }, rotY);
      const tile = { x: baseX + rotated.x, z: baseZ + rotated.z };
      const key = `${tile.x},${tile.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tile);
    }
    return out;
  }

  private explicitObjectInteractionTiles(obj: WorldObject): { x: number; z: number }[] {
    return this.explicitObjectInteractionTilesForPlacement(obj.x, obj.z, obj.rotationY, obj.interactionTiles);
  }

  private objectInteractionTiles(obj: WorldObject): { x: number; z: number }[] {
    const explicit = this.explicitObjectInteractionTiles(obj);
    if (explicit.length > 0) return explicit;
    const allowedWorldSides = obj.interactionSides
      ? localSidesToWorldSides(obj.interactionSides, obj.rotationY, obj.def.width)
      : undefined;
    return getObjectInteractionTiles(obj.x, obj.z, obj.def, {
      allowedWorldSides,
      includeCorners: this.usesCornerObjectInteraction(obj),
    });
  }

  private requiresClearObjectInteractionEdge(obj: WorldObject): boolean {
    return obj.def.category !== 'door' && obj.def.category !== 'ladder';
  }

  private sourceEdgeToward(fromTileX: number, fromTileZ: number, toTileX: number, toTileZ: number): number | null {
    const dx = toTileX - fromTileX;
    const dz = toTileZ - fromTileZ;
    if (dx === 0 && dz === -1) return WallEdge.N;
    if (dx === 1 && dz === 0) return WallEdge.E;
    if (dx === 0 && dz === 1) return WallEdge.S;
    if (dx === -1 && dz === 0) return WallEdge.W;
    return null;
  }

  private canInteractThroughObjectFootprintWall(
    player: Player,
    obj: WorldObject,
    tileX: number,
    tileZ: number,
    footprintTile: { x: number; z: number },
    map: GameMap,
  ): boolean {
    const hasOwnFootprintCollision = obj.def.blocking
      || (obj.assetId !== undefined && objectDefIdForPlacedAsset(obj.assetId) === obj.defId);
    if (!hasOwnFootprintCollision || obj.def.category === 'bank') return false;
    const edge = this.sourceEdgeToward(tileX, tileZ, footprintTile.x, footprintTile.z);
    if (edge === null) return false;
    const getWallOnFloor = (map as Partial<GameMap>).getWallOnFloor;
    if (typeof getWallOnFloor !== 'function') return false;
    if ((getWallOnFloor.call(map, tileX, tileZ, player.currentFloor) & edge) !== 0) return false;
    return (getWallOnFloor.call(map, footprintTile.x, footprintTile.z, player.currentFloor) & FULL_TILE_WALL_MASK) === FULL_TILE_WALL_MASK;
  }

  private hasClearObjectInteractionEdge(
    player: Player,
    obj: WorldObject,
    tileX: number,
    tileZ: number,
    map?: GameMap,
    allowAuthoredNonAdjacentTile: boolean = false,
  ): boolean {
    if (obj.def.category === 'bank' && this.findBankerAcrossBoothFromTile(player, obj, tileX, tileZ)) return true;
    if (allowAuthoredNonAdjacentTile && usesMapAuthoredObjectCollision(obj.def)) return true;
    if (!this.requiresClearObjectInteractionEdge(obj)) return true;
    const gameMap = map ?? this.getPlayerMap(player);
    let hasAdjacentFootprintTile = false;
    for (const footprintTile of getObjectFootprintTiles(obj.x, obj.z, obj.def)) {
      const dx = footprintTile.x - tileX;
      const dz = footprintTile.z - tileZ;
      if (Math.abs(dx) + Math.abs(dz) !== 1) continue;
      hasAdjacentFootprintTile = true;
      const blocked = player.currentFloor === 0
        ? gameMap.isWallBlocked(tileX, tileZ, footprintTile.x, footprintTile.z, player.effectiveY)
        : gameMap.isWallBlockedOnFloor(tileX, tileZ, footprintTile.x, footprintTile.z, player.currentFloor);
      if (!blocked) return true;
      if (this.canInteractThroughObjectFootprintWall(player, obj, tileX, tileZ, footprintTile, gameMap)) return true;
    }
    if (!hasAdjacentFootprintTile && allowAuthoredNonAdjacentTile) return true;
    return false;
  }

  private canUseObjectFromTile(player: Player, obj: WorldObject, tileX: number, tileZ: number, map?: GameMap): boolean {
    if (!this.canPlayerTargetObject(player, obj)) return false;
    if (obj.def.category === 'door') {
      const otx = Math.floor(obj.x);
      const otz = Math.floor(obj.z);
      return (tileX === otx && tileZ === otz) || (Math.abs(tileX - otx) + Math.abs(tileZ - otz) === 1);
    }
    if (obj.def.category === 'ladder' && obj.verticalLinks?.length) {
      return this.ladderInteractionTilesForPlayer(player, obj)
        .some(tile => tile.x === tileX && tile.z === tileZ);
    }
    const explicit = this.explicitObjectInteractionTiles(obj);
    const adjacent = explicit.length > 0
      ? explicit.some(tile => tile.x === tileX && tile.z === tileZ)
      : isTileAdjacentToObject(tileX, tileZ, obj.x, obj.z, obj.def, {
          allowedWorldSides: obj.interactionSides
            ? localSidesToWorldSides(obj.interactionSides, obj.rotationY, obj.def.width)
            : undefined,
          includeCorners: this.usesCornerObjectInteraction(obj),
        });
    return adjacent && this.hasClearObjectInteractionEdge(player, obj, tileX, tileZ, map, explicit.length > 0);
  }

  private findPathToObjectInteraction(player: Player, obj: WorldObject): { x: number; z: number }[] {
    const map = this.getPlayerMap(player);
    const interactionTiles = obj.def.category === 'ladder' && obj.verticalLinks?.length
      ? this.ladderInteractionTilesForPlayer(player, obj)
      : this.objectInteractionTiles(obj);
    const candidates = interactionTiles
      .filter(tile => !this.isTileBlockedForPlayer(player, map, tile.x, tile.z))
      .filter(tile => this.canUseObjectFromTile(player, obj, tile.x, tile.z, map));
    return findPathToAnyTile({
      startX: player.position.x,
      startZ: player.position.y,
      goals: candidates,
      collision: this.playerPathCollision(player, map),
      maxSearchTiles: DEFAULT_MAX_SEARCH_TILES,
    });
  }

  private npcOptionsFromSpawn(spawn: SpawnEntry, npcDef: NpcDef): NpcOptions {
    return {
      wanderRange: spawn.wanderRange,
      appearance: spawn.appearance ?? null,
      equipment: spawn.equipment ?? null,
      aggressive: spawn.aggressive ?? null,
      // Per-spawn shop/dialogue fully replace the def's (no field-merge).
      // Falls through: spawn override -> def -> legacy shops.json (shop only).
      effectiveShop: spawn.shop ?? this.data.getShop(spawn.npcId) ?? null,
      effectiveDialogue: spawn.dialogue ?? npcDef.dialogue ?? null,
      nameOverride: spawn.name ?? null,
      statsOverride: spawn.stats ?? null,
      customColors: spawn.customColors ?? null,
      attackAnimOverride: spawn.attackAnim ?? null,
      facing: spawn.facing ?? null,
      maxRange: spawn.maxRange ?? null,
      huntRange: spawn.huntRange ?? null,
      attackRange: spawn.attackRange ?? null,
      retreatHealth: spawn.retreatHealth ?? null,
      visibilityCondition: spawn.visibilityCondition ?? null,
      visualScale: spawn.scale ?? null,
    };
  }

  private spawnNpcs(): void {
    for (const [mapId, gameMap] of this.maps) {
      const spawns = this.data.loadSpawns(mapId);
      for (const spawn of spawns.npcs) {
        const npcDef = this.data.getNpc(spawn.npcId);
        if (!npcDef) {
          console.warn(`Unknown NPC id ${spawn.npcId} in ${mapId}/spawns.json`);
          continue;
        }
        const bankAccessViolation = bankAccessSpawnViolation(mapId, spawn, npcDef);
        if (bankAccessViolation) {
          console.error(`[spawn guard] Skipping ${bankAccessViolation}`);
          continue;
        }
        const npc = new Npc(
          npcDef,
          spawn.x,
          spawn.z,
          this.npcOptionsFromSpawn(spawn, npcDef),
        );
        npc.currentMapLevel = mapId;
        npc.currentFloor = this.resolveAuthoredFloor(gameMap, spawn.x, spawn.z, spawn.y, spawn.floor).floor;
        this.npcs.set(npc.id, npc);

        // Sized NPCs need an unblocked NxN footprint at their anchor or
        // they spawn stuck (wander finds no goal, chase can't step). Spawns
        // were authored as single-tile coords before the size system existed,
        // so flag them here for the map author to fix.
        if (npc.size > 1 && gameMap.isNpcBlocked(spawn.x, spawn.z, npc.size)) {
          console.warn(`NPC ${spawn.npcId} (${npcDef.name}, size ${npc.size}) at ${mapId} (${spawn.x}, ${spawn.z}): footprint lands on a blocked tile — adjust spawn coords.`);
        }

        // Register with chunk manager
        const cm = this.chunkManagers.get(mapId)!;
        cm.addEntity(npc.id, spawn.x, spawn.z, 'npc');
      }
      console.log(`Spawned NPCs for map '${mapId}'`);
    }
    console.log(`Total NPCs: ${this.npcs.size}`);
  }

  private spawnWorldObjects(): void {
    for (const [mapId] of this.maps) {
      const spawns = this.data.loadSpawns(mapId);
      const gameMap = this.maps.get(mapId)!;
      const objectSpawns = this.collectObjectSpawns(mapId, gameMap, spawns.objects ?? []);

      for (const spawn of objectSpawns) {
        const objDef = this.data.getObject(spawn.objectId);
        if (!objDef) {
          console.warn(`Unknown object id ${spawn.objectId} in ${mapId}/spawns.json`);
          continue;
        }
        const obj = this.createWorldObject(objDef, spawn, mapId);
        this.worldObjects.set(obj.id, obj);
        this.setObjectTilesBlocked(mapId, obj.x, obj.z, obj.def, true, obj.floor, obj.interactionTiles, obj.rotationY);
        if (objDef.category === 'door') {
          this.initializeDoorObject(obj, gameMap);
        }
        const cm = this.chunkManagers.get(mapId);
        if (cm) cm.addEntity(obj.id, spawn.x, spawn.z, 'object');
      }
      console.log(`Spawned objects for map '${mapId}'`);
    }
    console.log(`Total world objects: ${this.worldObjects.size}`);

    // Spawn ground items from spawns.json
    let itemCount = 0;
    for (const [mapId] of this.maps) {
      const spawns = this.data.loadSpawns(mapId);
      const gameMap = this.maps.get(mapId)!;
      itemCount += this.spawnStaticGroundItems(mapId, gameMap, spawns.items ?? []);
      itemCount += this.spawnPlacedGroundItems(mapId, gameMap);
    }
    if (itemCount > 0) console.log(`Spawned ${itemCount} ground items`);
  }

  private spawnStaticGroundItems(mapId: string, gameMap: GameMap, itemSpawns: ReadonlyArray<RuntimeGroundItemSpawn>): number {
    let count = 0;
    const cm = this.chunkManagers.get(mapId);
    for (const item of itemSpawns) {
      const id = this.allocateGroundItemId();
      if (id === null) continue;
      const quantity = Math.max(1, Math.floor(item.quantity ?? 1));
      const groundItem: GroundItem = {
        id,
        itemId: item.itemId,
        quantity,
        x: item.x,
        z: item.z,
        floor: this.resolveAuthoredFloor(gameMap, item.x, item.z, item.y, item.floor).floor,
        mapLevel: mapId,
        despawnTimer: -1, // permanent spawn
      };
      this.groundItems.set(groundItem.id, groundItem);
      if (cm) cm.addEntity(groundItem.id, groundItem.x, groundItem.z, 'groundItem');
      count++;
    }
    return count;
  }

  private spawnPlacedGroundItems(mapId: string, gameMap: GameMap): number {
    let count = 0;
    const placedObjects = gameMap.placedObjects ?? [];
    for (let i = 0; i < placedObjects.length; i++) {
      const placed = placedObjects[i];
      const spawnDef = ASSET_TO_GROUND_ITEM_SPAWN[placed.assetId];
      if (!spawnDef) continue;
      if (!this.data.getItem(spawnDef.itemId)) {
        console.warn(`Unknown item id ${spawnDef.itemId} for placed asset '${placed.assetId}' in ${mapId}`);
        continue;
      }
      const resolved = this.resolveAuthoredFloor(gameMap, placed.position.x, placed.position.z, placed.position.y);
      const source: GroundItemRespawnSource = {
        itemId: spawnDef.itemId,
        quantity: Math.max(1, Math.floor(spawnDef.quantity ?? 1)),
        x: placed.position.x,
        z: placed.position.z,
        floor: resolved.floor,
        mapLevel: mapId,
        respawnTime: Math.max(1, Math.floor(spawnDef.respawnTime ?? GROUND_ITEM_DESPAWN_TICKS)),
        respawnTimer: -1,
      };
      const spawnKey = this.placedGroundItemSpawnKey(mapId, placed.assetId, i, source.x, source.z, source.floor);
      this.groundItemRespawnSources.set(spawnKey, source);
      if (this.spawnRespawningGroundItem(spawnKey, source, false)) count++;
    }
    return count;
  }

  private placedGroundItemSpawnKey(mapId: string, assetId: string, index: number, x: number, z: number, floor: number): string {
    return `${mapId}|${assetId}|${index}|${Math.floor(floor)}|${qPos(x)}|${qPos(z)}`;
  }

  private spawnRespawningGroundItem(spawnKey: string, source: GroundItemRespawnSource, broadcast: boolean): GroundItem | null {
    const id = this.allocateGroundItemId();
    if (id === null) return null;
    const groundItem: GroundItem = {
      id,
      itemId: source.itemId,
      quantity: source.quantity,
      x: source.x,
      z: source.z,
      floor: source.floor,
      mapLevel: source.mapLevel,
      despawnTimer: -1,
      spawnKey,
    };
    this.groundItems.set(groundItem.id, groundItem);
    const cm = this.chunkManagers.get(source.mapLevel);
    if (cm) cm.addEntity(groundItem.id, groundItem.x, groundItem.z, 'groundItem');
    source.respawnTimer = -1;
    this.activeGroundItemRespawnKeys.delete(spawnKey);
    if (broadcast) {
      this.forEachPlayerNearOnFloor(groundItem.mapLevel, groundItem.floor, groundItem.x, groundItem.z, p =>
        this.sendGroundItemUpdate(p, groundItem));
    }
    return groundItem;
  }

  private clearGroundItemRespawnSourcesForMap(mapId: string): void {
    for (const [key, source] of this.groundItemRespawnSources) {
      if (source.mapLevel === mapId) {
        this.groundItemRespawnSources.delete(key);
        this.activeGroundItemRespawnKeys.delete(key);
      }
    }
  }

  private collectObjectSpawns(
    mapId: string,
    gameMap: GameMap,
    fallbackObjects: ReadonlyArray<{ objectId: number; x: number; z: number; y?: number; floor?: number; rotY?: number }>,
  ): RuntimeObjectSpawn[] {
    const objectSpawns: RuntimeObjectSpawn[] = [];
    for (const placed of gameMap.placedObjects ?? []) {
      if (ASSET_TO_GROUND_ITEM_SPAWN[placed.assetId]) continue;
      const defId = objectDefIdForPlacedAsset(placed.assetId);
      if (defId != null) {
        const sceneryMeta = sceneryExamineMetaForAsset(placed.assetId);
        if (BLOCKING_DECOR_ASSETS.has(placed.assetId)) {
          const tx = Math.floor(placed.position.x);
          const tz = Math.floor(placed.position.z);
          const { floor } = this.resolveAuthoredFloor(gameMap, placed.position.x, placed.position.z, placed.position.y);
          this.blockedObjectTiles.add(this.blockedKeyFor(mapId, tx, tz, floor));
        }
        objectSpawns.push({
          objectId: defId,
          assetId: placed.assetId,
          x: placed.position.x,
          z: placed.position.z,
          y: placed.position.y,
          rotY: placed.rotation?.y,
          name: placed.name || sceneryMeta?.name,
          examineText: placed.examineText || sceneryMeta?.examineText,
          interactions: placed.interactions,
          defaultOpen: placed.defaultOpen === true,
          openDirection: placed.openDirection === 1 ? 1 : -1,
          locked: placed.locked === true,
          keyItemId: Number.isInteger(placed.keyItemId) ? placed.keyItemId : undefined,
          consumeKey: placed.consumeKey === true,
          lockedMessage: placed.lockedMessage,
          altarTier: Number.isInteger(placed.altarTier) ? placed.altarTier : undefined,
          trigger: placed.trigger,
          verticalLinks: placed.verticalLinks,
          interactionTiles: placed.interactionTiles,
          interactionSides: placed.interactionSides,
        });
        continue;
      }
      // Thin-instanced decor stays a tile blocker only — no WorldObject entity.
      if (BLOCKING_DECOR_ASSETS.has(placed.assetId)) {
        const tx = Math.floor(placed.position.x);
        const tz = Math.floor(placed.position.z);
        const { floor } = this.resolveAuthoredFloor(gameMap, placed.position.x, placed.position.z, placed.position.y);
        this.blockedObjectTiles.add(this.blockedKeyFor(mapId, tx, tz, floor));
      }
    }
    for (const obj of fallbackObjects) objectSpawns.push(obj);
    return objectSpawns;
  }

  private createWorldObject(objDef: WorldObjectDef, spawn: RuntimeObjectSpawn, mapId: string): WorldObject {
    const map = this.maps.get(mapId);
    const resolved = map
      ? this.resolveAuthoredFloor(map, spawn.x, spawn.z, spawn.y, spawn.floor)
      : { floor: Math.floor(spawn.floor ?? 0), y: spawn.y ?? 0 };
    const obj = new WorldObject(objDef, spawn.x, spawn.z, mapId, resolved.floor, resolved.y);
    if (spawn.assetId) obj.assetId = spawn.assetId;
    if (spawn.rotY != null) obj.rotationY = spawn.rotY;
    if (spawn.name) obj.name = spawn.name;
    if (spawn.examineText) obj.examineText = spawn.examineText;
    obj.setInteractions(spawn.interactions);
    if (spawn.defaultOpen) obj.doorDefaultOpen = true;
    if (spawn.openDirection === 1) obj.doorOpenDirection = 1;
    if (spawn.locked) obj.doorLocked = true;
    if (Number.isInteger(spawn.keyItemId) && spawn.keyItemId! > 0) obj.doorKeyItemId = spawn.keyItemId!;
    if (spawn.consumeKey) obj.doorConsumeKey = true;
    if (spawn.lockedMessage) obj.doorLockedMessage = spawn.lockedMessage;
    if (Number.isInteger(spawn.altarTier) && spawn.altarTier! > 0) obj.altarTier = Math.max(1, Math.floor(spawn.altarTier!));
    if (spawn.trigger) obj.trigger = spawn.trigger;
    if (spawn.verticalLinks?.length) obj.verticalLinks = spawn.verticalLinks;
    if (spawn.interactionTiles?.length) obj.interactionTiles = spawn.interactionTiles;
    if (spawn.interactionSides) obj.interactionSides = spawn.interactionSides;
    return obj;
  }

  private registerDoorObject(obj: WorldObject): void {
    let doors = this.doorObjectsByMap.get(obj.mapLevel);
    if (!doors) {
      doors = new Set();
      this.doorObjectsByMap.set(obj.mapLevel, doors);
    }
    doors.add(obj);
  }

  private initializeDoorObject(obj: WorldObject, map: GameMap): void {
    this.initDoorEdge(obj);
    this.setDoorWallEdges(obj, map);
    if (obj.doorDefaultOpen) {
      this.clearDoorWallEdges(obj, map);
      obj.doorOpen = true;
      obj.depleted = true;
    }
    this.registerDoorObject(obj);
  }

  start(): void {
    console.log(`World starting — tick rate: ${TICK_RATE}ms`);
    this.tickTimer = setInterval(() => this.tick(), TICK_RATE);
    // Auto-save all players every 15 seconds — short enough that an
    // ungraceful kill loses at most a few seconds of progress.
    this.saveTimer = setInterval(() => this.saveAllPlayers(), 15_000);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = null;
    }
    this.abortAllDuelCustody(2);
    this.saveAllPlayers();
  }

  private saveAllPlayers(): void {
    const saves: Array<{ accountId: number; player: Player; effectiveY: number }> = [];
    for (const [, player] of this.players) {
      if (this.hasCustodiedItems(player.id)) continue;
      saves.push({
        accountId: player.accountId,
        player,
        effectiveY: this.computeEffectiveY(player),
      });
    }
    this.db.savePlayersBatch(saves);
  }

  /** Effective walking Y at the player's current (x, z, floor). Server is
   *  authoritative for gameplay saves: use the server's own last resolved
   *  elevation as the roof/elevated-floor gate. */
  private computeEffectiveY(player: Player): number {
    const map = this.getPlayerMap(player);
    return map.getEffectiveHeightOnFloor(
      player.position.x, player.position.y, player.currentFloor,
      player.effectiveY,
    );
  }

  /** Re-derive the player's server-authoritative walking elevation after a
   *  tile change. The prior effectiveY feeds getEffectiveHeightOnFloor's
   *  roof-tile gate, so the player only "sticks" to an elevated surface after
   *  an explicit vertical transition has moved them near that height. Mirrors
   *  the client's per-frame
   *  getEffectiveHeight(currentY) feedback loop — keeping the two in lock-step
   *  is what stops wall-edge checks from disagreeing across the wire. */
  private refreshPlayerEffectiveY(player: Player): void {
    const map = this.getPlayerMap(player);
    player.effectiveY = map.getEffectiveHeightOnFloor(
      player.position.x, player.position.y, player.currentFloor, player.effectiveY,
    );
  }

  /** Server-side floor inference from the server's own walking Y. This fills
   *  the gap left by removing client floor hints: KC maps often model an
   *  upstairs walkway as an elevated texture plane, so the player can climb
   *  to Y=2.7 while still technically on floor 0 unless we reconcile the
   *  floor index from the authored walkable targets at that tile. */
  private inferFloorFromEffectiveY(map: GameMap, x: number, z: number, effectiveY: number, currentFloor: number): number {
    const targets = map.getWalkableFloorTargetsAt(x, z);
    if (targets.length === 0) return currentFloor;

    let best = targets[0];
    let bestDist = Math.abs(best.y - effectiveY);
    for (let i = 1; i < targets.length; i++) {
      const candidate = targets[i];
      const dist = Math.abs(candidate.y - effectiveY);
      const tied = Math.abs(dist - bestDist) < 0.05;
      if (dist < bestDist - 0.05 || (tied && candidate.floor === currentFloor)) {
        best = candidate;
        bestDist = dist;
      }
    }

    return bestDist <= 0.75 ? best.floor : currentFloor;
  }

  private resolvePlayerMovementLayerAt(
    map: GameMap,
    x: number,
    z: number,
    state: PlayerMovementLayerState,
    refreshY: boolean = true,
  ): PlayerMovementLayerState {
    let floor = state.floor;
    let y = refreshY ? map.getEffectiveHeightOnFloor(x, z, floor, state.y) : state.y;
    let lastFloorChangeTile = state.lastFloorChangeTile;
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    const tileIdx = tz * map.width + tx;

    if (lastFloorChangeTile !== -1 && lastFloorChangeTile !== tileIdx) {
      lastFloorChangeTile = -1;
    }

    const oldFloor = floor;
    const onPlacedGroundStair = !!map.getStairOnFloor(tx, tz, 0);
    const stairCurrent = map.getStairOnFloor(tx, tz, floor);
    if (stairCurrent && lastFloorChangeTile !== tileIdx) {
      const stairAbove = map.getStairOnFloor(tx, tz, floor + 1);
      const stairBelow = map.getStairOnFloor(tx, tz, floor - 1);
      if (stairAbove) {
        floor += 1;
        lastFloorChangeTile = tileIdx;
      } else if (stairBelow) {
        floor -= 1;
        lastFloorChangeTile = tileIdx;
      }
    }

    if (floor === oldFloor && !onPlacedGroundStair) {
      floor = this.inferFloorFromEffectiveY(map, x, z, y, floor);
    }

    if (floor !== oldFloor) {
      y = map.getEffectiveHeightOnFloor(x, z, floor, y);
    }

    return { floor, y, lastFloorChangeTile };
  }

  private applyPlayerMovementLayer(player: Player, state: PlayerMovementLayerState): boolean {
    const oldFloor = player.currentFloor;
    player.currentFloor = state.floor;
    player.effectiveY = state.y;
    player.lastFloorChangeTile = state.lastFloorChangeTile;
    if (player.currentFloor === oldFloor) return false;

    this.clearCombatReferencesTo(player.id);
    this.clearQueuedPlayerActions(player);
    this.closeNpcUiContext(player);
    player.syncDirty = true;
    this.markEntityTileOccupantsDirty();
    this.sendFloorChange(player);
    this.sendNearbyVerticalObjectUpdates(player);
    return true;
  }

  private sendFloorChange(player: Player): void {
    this.sendToPlayer(player, ServerOpcode.FLOOR_CHANGE, player.currentFloor, qPos(player.effectiveY));
  }

  private checkpointPlayerPosition(player: Player): void {
    if (!this.pendingPositionCheckpoints) this.pendingPositionCheckpoints = new Map();
    this.pendingPositionCheckpoints.set(player.accountId, {
      accountId: player.accountId,
      player,
      effectiveY: this.computeEffectiveY(player),
    });
    player.lastPositionPersistTick = this.currentTick;
  }

  private savePlayerState(player: Player): void {
    if (this.hasCustodiedItems(player.id)) return;
    this.pendingPositionCheckpoints?.delete(player.accountId);
    this.getDb().savePlayerState(player.accountId, player, this.computeEffectiveY(player));
  }

  private flushPendingPositionCheckpoints(): void {
    if (!this.pendingPositionCheckpoints || this.pendingPositionCheckpoints.size === 0) return;
    const saves = [...this.pendingPositionCheckpoints.values()];
    this.pendingPositionCheckpoints.clear();
    this.getDb().savePlayerPositionsBatch(saves);
  }

  private objectRespawnWriteKey(mapLevel: string, defId: number, tileX: number, tileZ: number, floor: number): string {
    return `${mapLevel}|${defId}|${tileX}|${tileZ}|${Math.floor(floor)}`;
  }

  private queueObjectRespawnSave(obj: WorldObject, respawnAtUnixMs: number): void {
    if (!this.pendingObjectRespawnWrites) this.pendingObjectRespawnWrites = new Map();
    const tileX = Math.floor(obj.x);
    const tileZ = Math.floor(obj.z);
    const floor = Math.floor(obj.floor);
    this.pendingObjectRespawnWrites.set(this.objectRespawnWriteKey(obj.mapLevel, obj.defId, tileX, tileZ, floor), {
      type: 'save',
      mapLevel: obj.mapLevel,
      defId: obj.defId,
      tileX,
      tileZ,
      floor,
      respawnAtUnixMs,
    });
  }

  private queueObjectRespawnClear(obj: WorldObject): void {
    if (!this.pendingObjectRespawnWrites) this.pendingObjectRespawnWrites = new Map();
    const tileX = Math.floor(obj.x);
    const tileZ = Math.floor(obj.z);
    const floor = Math.floor(obj.floor);
    this.pendingObjectRespawnWrites.set(this.objectRespawnWriteKey(obj.mapLevel, obj.defId, tileX, tileZ, floor), {
      type: 'clear',
      mapLevel: obj.mapLevel,
      defId: obj.defId,
      tileX,
      tileZ,
      floor,
    });
  }

  private flushPendingObjectRespawnWrites(): void {
    if (!this.pendingObjectRespawnWrites || this.pendingObjectRespawnWrites.size === 0) return;
    const writes = [...this.pendingObjectRespawnWrites.values()];
    this.pendingObjectRespawnWrites.clear();
    this.getDb().applyObjectRespawnWritesBatch(writes);
  }

  getTickForHeartbeat(): number {
    return this.currentTick & 0x7fff;
  }

  getCurrentTick(): number {
    return this.currentTick;
  }

  recordPlayerActivity(playerId: number): void {
    const player = this.players.get(playerId);
    if (!player || player.disconnected || player.requestIdleLogout) return;
    player.lastActivityTick = this.currentTick;
    player.idleWarningSent = false;
  }

  private closePlayerLogoutState(player: Player, closeReason: string): void {
    const id = player.id;
    // Refund any items staged in an active trade/duel BEFORE saving so they
    // come back to inventory and get persisted. removePlayer() also calls
    // cleanup helpers, but that runs AFTER the save below.
    if (this.tradeSessions.has(id)) this.abortTrade(id, 2);
    if (this.duelStakeSessions?.has(id)) this.abortDuelStake(id, 2);
    if (this.activeDuels?.has(id)) this.finishDuelByForfeit(id);
    if (player.openInterface === 'trade') this.abortTrade(id, 2);
    if (player.openInterface === 'duel') this.abortDuelStake(id, 2);
    if (player.openInterface === 'bank') player.openInterface = null;
    this.closeShopForPlayer(player);
    player.requestIdleLogout = false;
    player.disconnected = false;
    player.reconnectDeadlineTick = 0;
    player.logoutDeadlineTick = 0;
    this.closeDialogueForPlayer(player, false);
    this.finalizePlayerLogoutSession(player);

    this.savePlayerState(player);
    this.options?.onPlayerAvatarDirty?.(player.accountId, player.name);
    try {
      player.ws.close(1000, closeReason);
    } catch { /* ignore */ }
    this.removePlayer(id);
  }

  private isPlayerLogoutCombatLocked(player: Player): boolean {
    if (this.activeDuels?.has(player.id)) return false; // active duels forfeit instead of blocking logout
    return player.isLogoutBlocked(this.currentTick)
      || this.playerCombatTargets.has(player.id)
      || this.isPlayerUnderNpcAttack(player.id)
      || this.hasPendingSpellImpact(player.id);
  }

  private sendLogoutBlockedMessage(player: Player): void {
    this.sendChatSystem(player, 'You cannot log out until 10 seconds after combat.');
  }

  requestAccountLogout(accountId: number): boolean {
    for (const [, player] of this.players) {
      if (player.accountId !== accountId) continue;
      if (this.isPlayerLogoutCombatLocked(player)) {
        this.sendLogoutBlockedMessage(player);
        return false;
      }
      this.closePlayerLogoutState(player, 'Logged out');
      return true;
    }
    return true;
  }

  kickAccountIfOnline(accountId: number): void {
    for (const player of this.players.values()) {
      if (player.accountId === accountId) {
        this.closePlayerLogoutState(player, 'Logged in from another session');
        break;
      }
    }
  }

  kickPlayersFromIp(ip: string): number {
    if (!ip) return 0;
    const accountIds = new Set<number>();
    for (const [, player] of this.players) {
      if (player.ip === ip) accountIds.add(player.accountId);
    }
    for (const accountId of accountIds) this.kickAccountIfOnline(accountId);
    return accountIds.size;
  }

  reconnectPlayer(
    accountId: number,
    ws: ServerWebSocket<{ type: string; playerId?: number; ip?: string; deviceId?: string }>
  ): Player | null {
    for (const [, player] of this.players) {
      if (player.accountId !== accountId) continue;
      if (!player.disconnected || player.requestIdleLogout) return null;
      if (this.currentTick >= player.reconnectDeadlineTick) return null;

      player.ws = ws as unknown as Player['ws'];
      ws.data.playerId = player.id;
      player.disconnected = false;
      player.reconnectDeadlineTick = 0;
      player.logoutDeadlineTick = 0;
      player.requestIdleLogout = false;
      player.ip = ws.data.ip ?? player.ip;
      player.deviceId = ws.data.deviceId ?? player.deviceId;
      this.recordPlayerActivity(player.id);
      player.lastBroadcastChunkX = -9999;
      player.lastBroadcastChunkZ = -9999;
      player.visibleEntityIds.clear();
      player.currentChunkX = Math.floor(player.position.x / CHUNK_SIZE);
      player.currentChunkZ = Math.floor(player.position.y / CHUNK_SIZE);

      const cm = this.chunkManagers.get(player.currentMapLevel);
      if (cm) {
        cm.addEntity(player.id, player.position.x, player.position.y, 'player');
        cm.registerPlayer(player.id);
      }
      this.markEntityTileOccupantsDirty();

      audit({
        type: 'account.reconnect',
        tick: this.currentTick,
        accountId: player.accountId,
        details: { name: player.name, ip: player.ip, deviceId: player.deviceId, loginRowId: player.loginRowId },
      });

      this.sendLoginBootstrap(player);
      broadcastPlayerInfo(player.id, player.name, player.isAdmin, player.isModerator);
      for (const [, other] of this.players) {
        if (other.id !== player.id) broadcastPlayerInfo(other.id, other.name, other.isAdmin, other.isModerator);
      }
      this.broadcastRemoteEquipment(player);
      this.sendRemoteStance(player, player);
      this.broadcastRemoteStance(player);
      this.sendRemoteAnimation(player, player);
      console.log(`Player "${player.name}" reconnected`);
      return player;
    }
    return null;
  }

  addPlayer(player: Player): void {
    this.players.set(player.id, player);
    player.lastActivityTick = this.currentTick;
    player.idleWarningSent = false;
    console.log(`Player "${player.name}" (id=${player.id}) joined on ${player.currentMapLevel}`);

    // Bot-detection telemetry: load lifetime row from DB (or start fresh)
    // and capture XP baseline for this session's rate calc.
    const row = this.db.loadBotStats(player.accountId);
    player.botStats = row ? BotStats.fromRow(row) : BotStats.empty();
    const xpBaseline: Record<string, number> = {};
    for (const skill of ALL_SKILLS) xpBaseline[skill] = player.skills[skill].xp;
    player.botStats.onLogin(xpBaseline, player.deviceId);

    // Record this session in login_history (used by bot-review for IP
    // correlation). The IP was captured at WS upgrade and stamped onto
    // Player just before addPlayer was called. Also emit an audit event
    // so account.login lines sit alongside other actions in audit.log.
    if (player.ip) {
      player.loginRowId = this.db.recordLogin(player.accountId, player.ip, player.deviceId);
      audit({
        type: 'account.login',
        tick: this.currentTick,
        accountId: player.accountId,
        details: { name: player.name, ip: player.ip, deviceId: player.deviceId, loginRowId: player.loginRowId },
      });
      // Best-effort PTR lookup, async, fire-and-forget. Failures are normal
      // for residential CGNAT and most consumer IPs — null is the expected
      // common outcome. When the PTR DOES resolve (datacenter, VPN, mobile
      // carrier), the bot-review CLI uses substring matching to flag it.
      this.lookupReverseDns(player.ip, player.loginRowId);
    }

    // Register with chunk manager
    const cm = this.chunkManagers.get(player.currentMapLevel)!;
    cm.addEntity(player.id, player.position.x, player.position.y, 'player');
    cm.registerPlayer(player.id);
    this.markEntityTileOccupantsDirty();
    player.currentChunkX = Math.floor(player.position.x / CHUNK_SIZE);
    player.currentChunkZ = Math.floor(player.position.y / CHUNK_SIZE);

    this.sendLoginBootstrap(player);

    // Broadcast player name to all chat sockets
    broadcastPlayerInfo(player.id, player.name, player.isAdmin, player.isModerator);
    for (const [, other] of this.players) {
      if (other.id !== player.id) {
        broadcastPlayerInfo(other.id, other.name, other.isAdmin, other.isModerator);
      }
    }

    // Tell nearby players about the joiner's equipment. Position-driven
    // PLAYER_SYNC will follow on the next tick; clients cache equipment until
    // the entity is created.
    this.broadcastRemoteEquipment(player);
    this.sendRemoteStance(player, player);
    this.broadcastRemoteStance(player);
  }

  private sendLoginBootstrap(player: Player): void {
    player.disconnected = false;
    player.reconnectDeadlineTick = 0;
    // Force the next broadcastSync to emit a PLAYER_SYNC for this player —
    // without this, a reconnect (or initial sign-in after a grace-period
    // reconnect path) keeps `lastSyncX/Z` from the previous WS, so
    // phase 1 sees `sx === lastSyncX` and never builds a packet. The client
    // then sits with no appearance/health/position broadcast until the
    // player moves a tile. Forcing syncDirty here makes the very next tick
    // hand the full local-player state (including appearance) to the new
    // socket.
    player.syncDirty = true;

    // Send login confirmation — entity data will be sent when client responds with MAP_READY
    // The 4th value is the effective walking Y so the client can spawn at
    // the right elevation (e.g. on top of a texture-plane bridge interior).
    const playerMap = this.getPlayerMap(player);
    // Login seeds from persisted player_state.y so old/bad rows saved on an
    // upper walking plane can recover correctly. After this bootstrap,
    // gameplay and persistence keep using server-derived player.effectiveY.
    let spawnY = playerMap.getEffectiveHeightOnFloor(
      player.position.x,
      player.position.y,
      player.currentFloor,
      player.effectiveY,
    );
    const spawnFloor = this.inferFloorFromEffectiveY(
      playerMap,
      player.position.x,
      player.position.y,
      spawnY,
      player.currentFloor,
    );
    if (spawnFloor !== player.currentFloor) {
      player.currentFloor = spawnFloor;
      spawnY = playerMap.getEffectiveHeightOnFloor(
        player.position.x,
        player.position.y,
        player.currentFloor,
        spawnY,
      );
    }
    // Do not auto-snap low saved Y up to an elevated texture plane. Multi-story
    // buildings can have a valid floor-0 walkable tile directly under an upper
    // floor, so the persisted Y seed is the only reliable signal for which plane
    // the player logged out on. If the player actually logged out upstairs,
    // the saved Y seed is already high enough for getEffectiveHeightOnFloor's
    // gate to return the elevated surface.
    // Seed the server-authoritative collision elevation from the resolved
    // spawn height so the first move after (re)login gates wall edges on the
    // correct Y. Covers both fresh login and grace-period reconnect — both
    // routes call sendLoginBootstrap.
    player.effectiveY = spawnY;
    // LOGIN_OK layout: [playerId, x*10, z*10, spawnY*10, protocolVersion].
    // Version added at the end so older client builds (which read only the
    // first 4 values) still parse without error — they just don't see the
    // mismatch warning. New clients read v[4] and disconnect on mismatch.
    this.sendToPlayer(player, ServerOpcode.LOGIN_OK, player.id,
      qPos(player.position.x),
      qPos(player.position.y),
      qPos(spawnY),
      PROTOCOL_VERSION,
    );

    if (player.isAdmin) this.sendToPlayer(player, ServerOpcode.ADMIN_FLAGS, 1);

    // Send MAP_CHANGE so client loads the correct map (handles underground, dungeons, etc.)
    this.sendMapChange(player, player.currentMapLevel);

    if (player.currentFloor !== 0) {
      this.sendFloorChange(player);
    }
    this.sendMagicState(player);
    this.sendAutoRetaliateState(player);

    if (!player.appearance) {
      this.openCharacterCreatorFor(player);
    }

    // Quest snapshot — sent unconditionally; the client renders an empty
    // log when the record is {}. Subsequent stage advances arrive as
    // QUEST_STAGE_ADVANCED deltas.
    this.quests.sendQuestStateSync(player);
    this.sendToPlayer(player, ServerOpcode.RENOWN_SYNC, player.renown);
  }

  private stanceIndex(stance: MagicStance): number {
    const idx = STANCE_KEYS.indexOf(stance);
    return idx >= 0 ? idx : 0;
  }

  private stanceFromIndex(index: number): MagicStance | null {
    return STANCE_KEYS[index] ?? null;
  }

  private sendMagicState(player: Player): void {
    this.sendToPlayer(player, ServerOpcode.PLAYER_MAGIC_STATE, player.autocastSpellIndex, this.stanceIndex(player.magicStance));
  }

  private sendAutoRetaliateState(player: Player): void {
    this.sendToPlayer(player, ServerOpcode.PLAYER_AUTO_RETALIATE, player.autoRetaliate ? 1 : 0);
  }

  private magicDebug(player: Player | undefined, event: string, details: Record<string, unknown> = {}): void {
    if (!MAGIC_DEBUG_ENABLED) return;
    const actor = player ? `${player.name}#${player.id}` : 'unknown';
    console.log(`[magic-debug] tick=${this.currentTick} ${event} player=${actor} ${JSON.stringify(details)}`);
  }

  private persistMagicCombatState(player: Player): void {
    const db = (this as { db?: GameDatabase }).db;
    db?.saveMagicCombatState?.(player.accountId, player.autocastSpellIndex, player.magicStance);
  }

  private persistAutoRetaliate(player: Player): void {
    const db = (this as { db?: GameDatabase }).db;
    db?.saveAutoRetaliate?.(player.accountId, player.autoRetaliate);
  }

  private clearAutocastSelection(player: Player, reason: string, persist: boolean = true): boolean {
    if (player.autocastSpellIndex < 0) return false;
    const previousSpellIndex = player.autocastSpellIndex;
    player.autocastSpellIndex = -1;
    if (persist) this.persistMagicCombatState(player);
    this.sendMagicState(player);
    this.magicDebug(player, 'autocast-cleared', { reason, previousSpellIndex });
    this.syncPlayerActiveCombatIntent(player);
    return true;
  }

  isAutocastableSpellIndex(spellIndex: number): boolean {
    const def = this.data.getSpellByIndex(spellIndex);
    return !!def && isAutocastableSpell(def);
  }

  private cancelSkilling(playerId: number): void {
    if (this.skillingActions.has(playerId)) {
      const player = this.players.get(playerId);
      if (player) {
        this.stopPlayerSkilling(playerId, player);
      } else {
        this.skillingActions.delete(playerId);
      }
    }
  }

  private cancelItemProduction(playerId: number): void {
    this.itemProductionActions?.delete(playerId);
  }

  private bumpActionRevision(player: Player): void {
    player.actionRevision = (player.actionRevision + 1) & 0x7fffffff;
    player.pendingActionRevision = -1;
  }

  private markQueuedAction(player: Player): void {
    player.pendingActionRevision = player.actionRevision;
  }

  private isQueuedActionCurrent(player: Player, actionRevision: number = player.pendingActionRevision): boolean {
    return actionRevision === player.actionRevision;
  }

  private clearQueuedPlayerActions(player: Player): void {
    this.clearPendingObjectIntents(player);
    player.pendingPickup = -1;
    player.pendingSpellCast = null;
    player.pendingTalkNpcId = -1;
    player.pendingTalkRepathTicks = 0;
    player.pendingActionRevision = -1;
  }

  /** Interrupt the player's active or queued world action before another
   *  deliberate action mutates state. Movement has its own path because it is
   *  itself the cancel signal; this covers inventory/equipment/item actions
   *  that can happen while standing still or while walking toward an object. */
  private interruptPlayerAction(playerId: number, player: Player, keepNpcUiContext: boolean = false): void {
    this.bumpActionRevision(player);
    this.clearQueuedPlayerActions(player);
    player.followTargetPlayerId = -1;
    player.actionDelay = 0;
    if (!keepNpcUiContext) {
      this.closeNpcUiContext(player);
    }
    this.cancelSkilling(playerId);
    this.cancelItemProduction(playerId);
  }

  private clearPendingObjectIntents(player: Player): void {
    player.pendingInteraction = null;
    player.pendingUseItemOnObject = null;
    player.pendingUseItemOnNpc = null;
  }

  private closeNpcUiContext(player: Player): void {
    this.closeShopForPlayer(player);
    if (player.openDialogueState) this.sendDialogueClose(player);
  }

  private releasePrivateGroundItemsForPlayer(playerId: number): void {
    for (const [, item] of this.groundItems) {
      if (item.ownerPlayerId !== playerId) continue;
      item.ownerPlayerId = undefined;
      item.privateTicks = 0;
      this.forEachPlayerNearOnFloor(item.mapLevel, item.floor, item.x, item.z, p => this.sendGroundItemUpdate(p, item));
    }
  }

  removePlayer(playerId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;

    // Clear every cross-entity reference BEFORE deleting the player entity so
    // the helper can still look up the player. Wipes player→NPC combat target,
    // NPC→player combat target (and the queued chase path), pending trade
    // requests, and any active trade session. Without this, kickAccountIfOnline
    // (which bypasses handlePlayerDisconnect's abortTrade call) would leave
    // orphan trade sessions, and NPCs mid-chase would keep a stale combatTarget
    // ref for at least one more AI tick.
    this.clearCombatReferencesTo(playerId);

    // Remove from chunk manager
    const cm = this.chunkManagers.get(player.currentMapLevel);
    if (cm) {
      cm.unregisterPlayer(player.id);
      cm.removeEntity(player.id);
    }

    this.pendingPositionCheckpoints?.delete(player.accountId);
    this.players.delete(playerId);
    this.markEntityTileOccupantsDirty();
    this.skillingActions.delete(playerId);
    this.itemProductionActions?.delete(playerId);
    this.releasePrivateGroundItemsForPlayer(playerId);
    // Defensive sweep: catch any trade sessions whose other side already left.
    this.sweepOrphanTradeSessions();
    this.sweepOrphanDuelSessions();
    console.log(`Player "${player.name}" left`);

    // Notify nearby players
    this.broadcastNearbyOnFloor(player.currentMapLevel, player.currentFloor, player.position.x, player.position.y, ServerOpcode.ENTITY_DEATH, playerId);
  }

  /** Called from the WS close handler. The Player entity is frozen in-world
   *  for a short grace window so the browser can reconnect. If no reconnect
   *  arrives, the normal logout path runs, including the combat logout block. */
  handlePlayerDisconnect(
    playerId: number,
    ws?: ServerWebSocket<{ type: string; playerId?: number }>
  ): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (ws && player.ws !== ws) return;
    if (player.disconnected) return;
    const combatLogout = this.isPlayerLogoutCombatLocked(player);
    if (combatLogout) player.markInCombat(this.currentTick);
    // Trade-during-disconnect dupe guard: if we leave the session live, the
    // partner could still accept and trigger commits against an offline player
    // whose inventory might mutate (e.g. on save round-trip). Abort cleanly.
    if (player.openInterface === 'trade') this.abortTrade(playerId, /*reason*/ 2);
    if (player.openInterface === 'duel' && this.duelStakeSessions?.has(playerId)) this.abortDuelStake(playerId, /*reason*/ 2);
    if (this.activeDuels?.has(playerId)) this.finishDuelByForfeit(playerId);
    // Bank just gets closed — its contents are already in player.bank and
    // will be saved by the call below.
    if (player.openInterface === 'bank') player.openInterface = null;
    this.closeShopForPlayer(player);
    this.closeDialogueForPlayer(player, false);
    player.clearMoveQueue();
    this.clearQueuedPlayerActions(player);
    player.clearDelay();
    this.cancelSkilling(playerId);
    this.cancelItemProduction(playerId);
    this.clearCombatTarget(playerId);
    this.setPlayerAnimation(player, PlayerAnimationKind.Idle, PlayerSkillAnimationVariant.None, 0);
    player.disconnected = true;
    if (combatLogout) {
      player.reconnectDeadlineTick = this.currentTick + DISCONNECTED_COMBAT_LOGOUT_TICKS;
      player.logoutDeadlineTick = player.reconnectDeadlineTick;
    } else {
      player.reconnectDeadlineTick = this.currentTick + RECONNECT_GRACE_TICKS;
      player.logoutDeadlineTick = 0;
    }
    this.savePlayerState(player);
    console.log(`Player "${player.name}" disconnected — holding session for ${combatLogout ? 'combat logout' : 'reconnect'}`);
  }

  private finalizePlayerLogoutSession(player: Player): void {
    // Bot-detection: finalize the session — compute flags, write summary to
    // audit.log, update lifetime aggregates in bot_stats table. Done BEFORE
    // savePlayerState so a crash between the two doesn't lose the session
    // summary (the player state save is the more recoverable side).
    let sessionMinutes = 0;
    if (player.botStats) {
      const xpNow: Record<string, number> = {};
      for (const skill of ALL_SKILLS) xpNow[skill] = player.skills[skill].xp;
      const summary = player.botStats.finalize(this.db, player.accountId, xpNow, this.currentTick);
      sessionMinutes = summary.sessionMinutes;
      player.botStats = null;
    }
    // Finalize login_history row regardless of botStats (the IP-correlation
    // index is what matters for gold-farmer detection, even if botStats was
    // missing for some reason).
    if (player.loginRowId > 0) {
      this.db.recordLogout(player.loginRowId, sessionMinutes);
      audit({
        type: 'account.logout',
        tick: this.currentTick,
        accountId: player.accountId,
        details: { name: player.name, ip: player.ip, deviceId: player.deviceId, sessionMinutes, loginRowId: player.loginRowId },
      });
      player.loginRowId = -1;
    }
  }

  private finishDisconnectedLogout(player: Player): void {
    const deadline = player.logoutDeadlineTick;
    if (player.isLogoutBlocked(this.currentTick) && (deadline <= 0 || this.currentTick < deadline)) {
      player.requestIdleLogout = true;
      player.logoutDeadlineTick = deadline > 0 ? deadline : this.currentTick + DISCONNECTED_COMBAT_LOGOUT_TICKS;
      console.log(`Player "${player.name}" logged out under attack — deferring removal`);
      return;
    }

    this.closePlayerLogoutState(player, 'Disconnected');
  }

  /** Process players whose ws closed during a combat lockout. Once the lockout
   *  expires (or the deadline hits), save and remove. */
  private tickDeferredLogouts(): void {
    let toRemove: number[] | null = null;
    let expiredReconnects: Player[] | null = null;
    for (const [, player] of this.players) {
      if (player.disconnected && !player.requestIdleLogout) {
        const combatDeadline = player.logoutDeadlineTick > 0;
        const expired = combatDeadline
          ? (!player.isLogoutBlocked(this.currentTick) || this.currentTick >= player.logoutDeadlineTick)
          : this.currentTick >= player.reconnectDeadlineTick;
        if (expired) {
          if (!expiredReconnects) expiredReconnects = [];
          expiredReconnects.push(player);
        }
        continue;
      }
      if (!player.requestIdleLogout) continue;
      const expired = !player.isLogoutBlocked(this.currentTick) || this.currentTick >= player.logoutDeadlineTick;
      if (expired) {
        if (!toRemove) toRemove = [];
        toRemove.push(player.id);
      }
    }
    if (expiredReconnects) {
      for (const player of expiredReconnects) {
        if (this.players.has(player.id)) this.finishDisconnectedLogout(player);
      }
    }
    if (!toRemove) return;
    for (const id of toRemove) {
      const player = this.players.get(id);
      if (player) this.closePlayerLogoutState(player, 'Logged out');
    }
  }

  private beginIdleLogout(player: Player): void {
    this.sendChatSystem(player, 'You have been signed out for inactivity.');
    if (!this.isPlayerLogoutCombatLocked(player)) {
      this.closePlayerLogoutState(player, 'Idle timeout');
      return;
    }

    player.markInCombat(this.currentTick);
    player.clearMoveQueue();
    this.clearQueuedPlayerActions(player);
    player.clearDelay();
    this.cancelSkilling(player.id);
    this.cancelItemProduction(player.id);
    this.clearCombatTarget(player.id);
    this.setPlayerAnimation(player, PlayerAnimationKind.Idle, PlayerSkillAnimationVariant.None, 0);
    player.disconnected = true;
    player.requestIdleLogout = true;
    player.reconnectDeadlineTick = 0;
    player.logoutDeadlineTick = this.currentTick + DISCONNECTED_COMBAT_LOGOUT_TICKS;
    this.savePlayerState(player);
    try {
      player.ws.close(1000, 'Idle timeout');
    } catch { /* ignore */ }
  }

  private tickIdleLogouts(): void {
    let toLogout: Player[] | null = null;
    for (const [, player] of this.players) {
      if (player.disconnected || player.requestIdleLogout) continue;
      const idleTicks = this.currentTick - player.lastActivityTick;
      if (idleTicks >= IDLE_LOGOUT_TICKS) {
        if (!toLogout) toLogout = [];
        toLogout.push(player);
        continue;
      }
      if (!player.idleWarningSent && idleTicks >= IDLE_WARNING_TICKS) {
        player.idleWarningSent = true;
        this.sendChatSystem(player, 'You have been inactive for 4 minutes and will be signed out in 1 minute.');
      }
    }
    if (!toLogout) return;
    for (const player of toLogout) {
      if (this.players.has(player.id)) this.beginIdleLogout(player);
    }
  }

  /** Check if a world position is within chunk load radius of a player */
  /** Find the best tool of a given type that the player can use (checks equipped weapon + inventory) */

  private initDoorEdge(obj: WorldObject): void {
    obj.closedEdge = doorClosedEdgeFromRotY(obj.rotationY);
  }

  private doorTile(obj: WorldObject): [number, number] {
    return [Math.floor(obj.x), Math.floor(obj.z)];
  }

  /** Compute the actual wall edge from the door's authored placement.
   *  Delegates to shared/doorEdge so server + client agree on every door. */
  private doorWallEdge(obj: WorldObject): number {
    return doorEdgeFromPlacement(obj.x, obj.z, obj.rotationY).edge;
  }

  private setDoorWallEdges(obj: WorldObject, map: GameMap): void {
    const [tx, tz] = this.doorTile(obj);
    const edge = this.doorWallEdge(obj);
    map.setWallOnFloor(tx, tz, obj.floor, map.getWallOnFloor(tx, tz, obj.floor) | edge);
    const nb = DOOR_EDGE_NEIGHBOR[edge];
    if (nb) {
      const nx = tx + nb.dx, nz = tz + nb.dz;
      if (nx >= 0 && nz >= 0 && nx < map.width && nz < map.height) {
        map.setWallOnFloor(nx, nz, obj.floor, map.getWallOnFloor(nx, nz, obj.floor) | nb.opposite);
      }
    }
  }

  /** Open the door: leave the wall mask SET, only flag openDoorEdges. The
   *  block-check honors the bypass if the player is at the door's elevation
   *  (see GameMap.wallBlocksAtHeight) — clearing the mask would let players
   *  at the WRONG elevation (e.g. basement under an upper-floor door) skip
   *  through, because the wall would have nothing left to block on. */
  private clearDoorWallEdges(obj: WorldObject, map: GameMap): void {
    const [tx, tz] = this.doorTile(obj);
    const edge = this.doorWallEdge(obj);
    map.setOpenDoorEdges(tx, tz, edge, true, obj.floor);
    const nb = DOOR_EDGE_NEIGHBOR[edge];
    if (nb) {
      const nx = tx + nb.dx, nz = tz + nb.dz;
      if (nx >= 0 && nz >= 0 && nx < map.width && nz < map.height) {
        map.setOpenDoorEdges(nx, nz, nb.opposite, true, obj.floor);
      }
    }
  }

  /** Close the door: clear openDoorEdges. Wall mask was never disturbed. */
  private restoreDoorWallEdges(obj: WorldObject, map: GameMap): void {
    const [tx, tz] = this.doorTile(obj);
    const edge = this.doorWallEdge(obj);
    map.setOpenDoorEdges(tx, tz, edge, false, obj.floor);
    const nb = DOOR_EDGE_NEIGHBOR[edge];
    if (nb) {
      const nx = tx + nb.dx, nz = tz + nb.dz;
      if (nx >= 0 && nz >= 0 && nx < map.width && nz < map.height) {
        map.setOpenDoorEdges(nx, nz, nb.opposite, false, obj.floor);
      }
    }
  }

  private computeSwingSign(player: Player, obj: WorldObject): number {
    const [tx, tz] = this.doorTile(obj);
    const px = player.position.x, pz = player.position.y;
    const edge = obj.closedEdge;
    if (edge === WallEdge.N) return pz < tz + 0.5 ? -1 : 1;
    if (edge === WallEdge.S) return pz > tz + 0.5 ? -1 : 1;
    if (edge === WallEdge.E) return px > tx + 0.5 ? -1 : 1;
    if (edge === WallEdge.W) return px < tx + 0.5 ? -1 : 1;
    return 0;
  }

  private playerHasItem(player: Player, itemId: number, quantity: number = 1): boolean {
    if (!Number.isInteger(itemId) || itemId <= 0 || quantity <= 0) return false;
    let count = 0;
    for (const slot of player.inventory) {
      if (!slot || slot.itemId !== itemId) continue;
      count += slot.quantity;
      if (count >= quantity) return true;
    }
    return false;
  }

  private canOpenLockedDoor(player: Player, obj: WorldObject): boolean {
    if (!obj.doorLocked) return true;
    if (obj.doorKeyItemId <= 0) {
      this.sendChatSystem(player, obj.doorLockedMessage || 'The door is locked.');
      return false;
    }
    if (!this.playerHasItem(player, obj.doorKeyItemId, 1)) {
      const keyDef = this.data.getItem(obj.doorKeyItemId);
      const keyName = keyDef?.name ? keyDef.name.toLowerCase() : 'key';
      this.sendChatSystem(player, obj.doorLockedMessage || `The door is locked. You need a ${keyName}.`);
      return false;
    }
    if (obj.doorConsumeKey) {
      const removed = player.removeItemById(obj.doorKeyItemId, 1);
      if (removed.completed < 1) {
        this.sendChatSystem(player, obj.doorLockedMessage || 'The door is locked.');
        return false;
      }
      this.sendInventory(player);
    }
    return true;
  }

  private toggleDoor(obj: WorldObject, swingSign: number = 0): void {
    const map = this.maps.get(obj.mapLevel);
    if (!map) return;

    if (obj.doorOpen) {
      this.restoreDoorWallEdges(obj, map);
      obj.doorOpen = false;
      obj.depleted = false;
      swingSign = 0;
      if (obj.doorDefaultOpen) {
        obj.respawnTimer = obj.def.respawnTime ?? DEFAULT_OBJECT_RESPAWN_TICKS;
        this.depletedObjectIds.add(obj.id);
        this.db.saveDoorState(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z), obj.floor, false, this.currentTick + obj.respawnTimer);
      } else {
        this.depletedObjectIds.delete(obj.id);
        // Closed is the default state — drop the persisted row so a fresh
        // server boot doesn't waste cycles processing a no-op.
        this.db.clearDoorState(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z), obj.floor);
      }
    } else {
      this.clearDoorWallEdges(obj, map);
      obj.doorOpen = true;
      obj.depleted = true;
      if (obj.doorDefaultOpen) {
        this.depletedObjectIds.delete(obj.id);
        this.db.clearDoorState(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z), obj.floor);
      } else {
        obj.respawnTimer = obj.def.respawnTime ?? DEFAULT_OBJECT_RESPAWN_TICKS;
        this.depletedObjectIds.add(obj.id);
        this.db.saveDoorState(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z), obj.floor, true, this.currentTick + obj.respawnTimer);
      }
    }

    this.broadcastWorldObjectStateChange(obj, swingSign);
  }

  private findBestTool(player: Player, toolType: string, playerSkillLevel: number): ItemDef | null {
    let best: ItemDef | null = null;
    const check = (itemId: number) => {
      const def = this.data.getItem(itemId);
      if (!def || def.toolType !== toolType) return;
      const toolLvl = def.toolLevel ?? 1;
      if (toolLvl > playerSkillLevel) return;
      const bonus = def.toolBonus ?? 0;
      if (!best || bonus > (best.toolBonus ?? 0)) best = def;
    };
    // Check equipped weapon
    const weaponId = player.equipment.get('weapon');
    if (weaponId) check(weaponId);
    // Check inventory
    for (const slot of player.inventory) {
      if (slot) check(slot.itemId);
    }
    return best;
  }

  private findLowestOwnedToolRequirement(player: Player, toolType: string): number | null {
    let lowest: number | null = null;
    const check = (itemId: number) => {
      const def = this.data.getItem(itemId);
      if (!def || def.toolType !== toolType) return;
      const toolLevel = def.toolLevel ?? 1;
      if (lowest === null || toolLevel < lowest) lowest = toolLevel;
    };
    const weaponId = player.equipment.get('weapon');
    if (weaponId) check(weaponId);
    for (const slot of player.inventory) {
      if (slot) check(slot.itemId);
    }
    return lowest;
  }

  /** Send an opcode to all players near a world position on a given map (zero-allocation) */
  private broadcastNearby(mapId: string, worldX: number, worldZ: number, opcode: ServerOpcode, ...values: number[]): void {
    const cm = this.chunkManagers.get(mapId);
    if (!cm) return;
    const packet = encodePacket(opcode, ...values);
    cm.forEachPlayerNear(worldX, worldZ, (pid) => {
      const p = this.players.get(pid);
      if (p && !p.disconnected) {
        try { p.ws.sendBinary(packet); } catch { /* connection closed */ }
      }
    });
  }

  private broadcastNearbyOnFloor(mapId: string, floor: number, worldX: number, worldZ: number, opcode: ServerOpcode, ...values: number[]): void {
    if (!this.chunkManagers) {
      this.broadcastNearby(mapId, worldX, worldZ, opcode, ...values);
      return;
    }
    const cm = this.chunkManagers.get(mapId);
    if (!cm) return;
    const packet = encodePacket(opcode, ...values);
    cm.forEachPlayerNear(worldX, worldZ, (pid) => {
      const p = this.players.get(pid);
      if (p && !p.disconnected && p.currentMapLevel === mapId && p.currentFloor === floor) {
        try { p.ws.sendBinary(packet); } catch { /* connection closed */ }
      }
    });
  }

  private broadcastWorldObjectStateChange(obj: WorldObject, swingSign: number = 0): void {
    const cm = this.chunkManagers.get(obj.mapLevel);
    if (!cm) return;
    const eventPacket = encodePacket(ServerOpcode.WORLD_OBJECT_DEPLETED, obj.id, obj.depleted ? 1 : 0, swingSign);
    // The WORLD_OBJECT_SYNC update is viewer-specific ONLY for ladders (their
    // interaction tiles + action mask depend on the viewer's floor/links).
    // Every other object encodes identically for all viewers, so encode once
    // and reuse instead of re-allocating per nearby player.
    const isLadder = obj.def.category === 'ladder' && !!obj.verticalLinks?.length;
    const sharedUpdate = isLadder ? null : this.encodeWorldObjectUpdate(obj);
    cm.forEachPlayerNear(obj.x, obj.z, (pid) => {
      const player = this.players.get(pid);
      if (!player || player.disconnected || player.currentMapLevel !== obj.mapLevel || player.currentFloor !== obj.floor) return;
      try {
        player.ws.sendBinary(eventPacket);
        player.ws.sendBinary(sharedUpdate ?? this.encodeWorldObjectUpdate(obj, player));
      } catch { /* connection closed */ }
    });
  }

  private sendNearbyDoorUpdates(player: Player, radius: number = 8): void {
    const px = Math.floor(player.position.x);
    const pz = Math.floor(player.position.y);
    const doors = this.doorObjectsByMap.get(player.currentMapLevel);
    if (!doors) return;
    for (const obj of doors) {
      if (obj.floor !== player.currentFloor) continue;
      if (Math.max(Math.abs(Math.floor(obj.x) - px), Math.abs(Math.floor(obj.z) - pz)) > radius) continue;
      this.sendWorldObjectUpdate(player, obj);
    }
  }

  private rejectStaleDoorInteraction(player: Player, obj: WorldObject, expectedDoorOpen: boolean | null): boolean {
    if (obj.def.category !== 'door' || expectedDoorOpen === null || obj.doorOpen === expectedDoorOpen) return false;
    this.sendWorldObjectUpdate(player, obj);
    this.sendNearbyDoorUpdates(player);
    return true;
  }

  /** True when any player currently has a dialogue or shop open with this
   *  NPC. Used by tickNpcAI to freeze wandering — without this, walk-anim
   *  movement on the client overrides the NPC_FACING rotation we set on
   *  talk-to, so the NPC visibly looks away mid-conversation. Combat-only
   *  NPCs are excluded by the caller's pre-check on hasDialogue/hasShop. */
  private npcHasInteractionAudience(npc: Npc): boolean {
    for (const [, player] of this.players) {
      if (player.openDialogueState?.npcEntityId === npc.id && player.currentMapLevel === npc.currentMapLevel && player.currentFloor === npc.currentFloor) return true;
      if (player.openShopNpcEntityId === npc.id && player.currentMapLevel === npc.currentMapLevel && player.currentFloor === npc.currentFloor) return true;
    }
    return false;
  }

  /** Broadcast NPC_FACING to every nearby viewer so they see the NPC turn.
   *  dx/dz is the direction the NPC should face (from NPC toward target).
   *  Quantizes to 3 decimals of radians (multiply by 1000) so atan2's
   *  ±π fits comfortably in an int16. No-op when the direction is zero
   *  (same tile, undefined yaw). */
  private broadcastNpcFacing(npc: Npc, dx: number, dz: number): void {
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
    const angle = Math.atan2(dx, dz);
    npc.facingAngle = angle;
    const q = Math.round(angle * 1000);
    this.broadcastNearbyOnFloor(npc.currentMapLevel, npc.currentFloor, npc.position.x, npc.position.y, ServerOpcode.NPC_FACING, npc.id, q);
  }

  private broadcastNpcFacingPlayer(npc: Npc, player: Player): void {
    this.broadcastNpcFacing(npc, player.position.x - npc.position.x, player.position.y - npc.position.y);
  }

  /** Call fn for each player near a world position on a given map (zero-allocation) */
  private forEachPlayerNear(mapId: string, worldX: number, worldZ: number, fn: (p: Player) => void): void {
    const cm = this.chunkManagers.get(mapId);
    if (!cm) return;
    cm.forEachPlayerNear(worldX, worldZ, (pid) => {
      const p = this.players.get(pid);
      if (p && !p.disconnected) fn(p);
    });
  }

  private forEachPlayerNearOnFloor(mapId: string, floor: number, worldX: number, worldZ: number, fn: (p: Player) => void): void {
    this.forEachPlayerNear(mapId, worldX, worldZ, (p) => {
      if (p.currentMapLevel === mapId && p.currentFloor === floor) fn(p);
    });
  }

  private setCombatTarget(playerId: number, npcId: number): void {
    this.clearCombatTarget(playerId);
    this.playerCombatTargets.set(playerId, npcId);
    let set = this.npcTargetedBy.get(npcId);
    if (!set) { set = new Set(); this.npcTargetedBy.set(npcId, set); }
    set.add(playerId);
    const player = this.players.get(playerId);
    const npc = this.npcs.get(npcId);
    if (player && npc) this.syncPlayerCombatIntent(player, npc);
    if (player) {
      this.magicDebug(player, 'setCombatTarget', { npcId, autocast: player.autocastSpellIndex, cooldown: player.attackCooldown });
      this.setPlayerAnimation(player, PlayerAnimationKind.Idle, PlayerSkillAnimationVariant.None, npcId);
    }
  }

  private clearCombatTarget(playerId: number): void {
    const oldNpc = this.playerCombatTargets.get(playerId);
    if (oldNpc !== undefined) {
      const set = this.npcTargetedBy.get(oldNpc);
      if (set) {
        set.delete(playerId);
        if (set.size === 0) this.npcTargetedBy.delete(oldNpc);
      }
      this.playerCombatTargets.delete(playerId);
      const player = this.players.get(playerId);
      if (player) {
        this.magicDebug(player, 'clearCombatTarget', { npcId: oldNpc, autocast: player.autocastSpellIndex, cooldown: player.attackCooldown });
        this.setPlayerAnimation(player, PlayerAnimationKind.Idle, PlayerSkillAnimationVariant.None, 0);
      }
    }
    const actor = this.playerCombatRef(playerId);
    const combat = this.getCombatSystem();
    combat.clearIntent(actor);
    combat.clearRetaliationForActor(actor);
    combat.clearLock(actor);
  }

  private clearPlayerCombatTargetForNpc(playerId: number, npcId: number): void {
    if (this.playerCombatTargets.get(playerId) === npcId) this.clearCombatTarget(playerId);
  }

  private playerCombatMode(player: Player): CombatMode {
    if (player.autocastSpellIndex >= 0) return 'magic';
    if (player.isRangedWeapon(this.data.itemDefs)) return 'ranged';
    return 'melee';
  }

  private syncPlayerCombatIntent(player: Player, npc: Npc): void {
    const actor = this.playerCombatRef(player.id);
    const existing = this.getCombatSystem().getIntent(actor);
    const mode = this.playerCombatMode(player);
    const ammo = mode === 'ranged' ? player.findAmmo(this.data.itemDefs) : null;
    this.getCombatSystem().setIntent({
      actor,
      target: this.npcCombatRef(npc.id),
      mode,
      createdTick: existing?.createdTick ?? this.currentTick,
      spellIndex: mode === 'magic' ? player.autocastSpellIndex : undefined,
      ammoItemId: ammo?.itemDef.id,
    });
  }

  private syncPlayerActiveCombatIntent(player: Player): void {
    const npcId = this.playerCombatTargets?.get(player.id);
    if (npcId === undefined) return;
    const npc = this.npcs.get(npcId);
    if (!npc || npc.dead) return;
    this.syncPlayerCombatIntent(player, npc);
  }

  private enqueuePlayerAutoRetaliation(player: Player, npc: Npc): void {
    this.getCombatSystem().enqueueRetaliation({
      actor: this.playerCombatRef(player.id),
      target: this.npcCombatRef(npc.id),
      earliestTick: this.currentTick,
      reason: 'auto-retaliate',
    });
  }

  private enqueueNpcRetaliation(npc: Npc, player: Player, delayTicks: number = 0): void {
    this.getCombatSystem().enqueueRetaliation({
      actor: this.npcCombatRef(npc.id),
      target: this.playerCombatRef(player.id),
      earliestTick: this.currentTick + delayTicks,
      reason: 'npc-retaliate',
    });
  }

  private startPlayerAutoRetaliation(player: Player, npc: Npc): void {
    if (!player.autoRetaliate || !player.alive || player.disconnected) return;
    if (player.isInterfaceOpen() || this.activeDuels?.has(player.id)) return;
    if (player.hasMoveQueue() || this.playerCombatTargets.has(player.id)) return;
    if (npc.dead || npc.hasDialogue || npc.hasShop || npc.hasBank) return;
    if (!this.canPlayerTargetNpc(player, npc)) return;

    this.interruptPlayerAction(player.id, player);
    player.attackTarget = npc;
    this.setCombatTarget(player.id, npc.id);
  }

  private processCombatRetaliation(request: RetaliationRequest): void {
    if (request.actor.kind === 'player' && request.target.kind === 'npc') {
      const player = this.players.get(request.actor.id);
      const npc = this.npcs.get(request.target.id);
      if (!player || !npc) return;
      this.startPlayerAutoRetaliation(player, npc);
      return;
    }

    if (request.actor.kind === 'npc' && request.target.kind === 'player') {
      const npc = this.npcs.get(request.actor.id);
      const player = this.players.get(request.target.id);
      if (!npc || !player || npc.dead || !player.alive) return;
      if (this.activeDuels?.has(player.id) || player.openInterface === 'duel') return;
      if (!this.canPlayerTargetNpc(player, npc)) return;
      armNpcRetaliation(npc, player);
      this.syncNpcAttackCooldownFromSchedule(npc);
    }
  }

  private finishCombatTick(): void {
    for (const request of this.getCombatSystem().takeDueRetaliation(this.currentTick)) {
      this.processCombatRetaliation(request);
    }
  }

  private disengageLeashedNpcCombat(player: Player, npc: Npc): void {
    this.clearPlayerCombatTargetForNpc(player.id, npc.id);
    npc.disengageAndReturnHome();
  }

  private finalizeNpcDeath(npc: Npc, killer: Player | null): void {
    this.getCombatSystem().clearActor(this.npcCombatRef(npc.id));
    finalizeNpcDeathCombat({
      getTargeters: (npcId) => this.npcTargetedBy.get(npcId),
      clearCombatTarget: (playerId) => this.clearCombatTarget(playerId),
      broadcastDeath: (deadNpc) => {
        this.broadcastNearbyOnFloor(deadNpc.currentMapLevel, deadNpc.currentFloor, deadNpc.position.x, deadNpc.position.y, ServerOpcode.ENTITY_DEATH, deadNpc.id, EntityDeathKind.Death);
      },
      removeChunkEntity: (deadNpc) => {
        const cm = this.chunkManagers.get(deadNpc.currentMapLevel);
        if (cm) cm.removeEntity(deadNpc.id);
      },
      markOccupantsDirty: () => this.markEntityTileOccupantsDirty(),
      forgetVisibleNpc: (npcId) => {
        for (const [, player] of this.players) {
          player.visibleEntityIds.delete(npcId);
        }
      },
      notifyQuestKill: (questKiller, deadNpc) => {
        this.quests.notifyQuestEvent(questKiller, { type: 'npcKill', npcDefId: deadNpc.def.id });
      },
      creditMobKill: (deadNpc) => this.creditMobKill(deadNpc),
      spawnLoot: (deadNpc, ownerPlayerId) => this.spawnNpcLoot(deadNpc, ownerPlayerId),
    }, npc, killer);
  }

  private handleNpcRespawn(npc: Npc): void {
    const cm = this.chunkManagers.get(npc.currentMapLevel);
    if (cm) cm.addEntity(npc.id, npc.position.x, npc.position.y, 'npc');
    this.markEntityTileOccupantsDirty();
    npc.lastSyncX = -9999;
    npc.lastSyncZ = -9999;
    npc.lastSyncHealth = -1;
    npc.syncDirty = true;
    for (const [, player] of this.players) {
      player.visibleEntityIds.delete(npc.id);
    }
  }

  /** Clear every server-side reference to this player from other entities'
   *  combat / interaction state. Called from removePlayer AND on map transition
   *  so stale targets don't survive across either event. */
  private clearCombatReferencesTo(playerId: number): void {
    const player = this.players.get(playerId);
    this.clearCombatTarget(playerId);
    if (player) {
      player.attackTarget = null;
      this.clearQueuedPlayerActions(player);
      player.followTargetPlayerId = -1;
    }
    for (const [, npc] of this.npcs) {
      if (npc.combatTarget?.id === playerId) {
        npc.setCombatTarget(null);
        npc.pathQueue.length = 0;
      }
      npc.clearRetreatTarget(playerId);
    }
    for (const [npcId, set] of this.npcTargetedBy) {
      if (set.delete(playerId) && set.size === 0) {
        this.npcTargetedBy.delete(npcId);
      }
    }
    this.pendingTradeRequests.delete(playerId);
    for (const [requester, target] of this.pendingTradeRequests) {
      if (target === playerId) this.pendingTradeRequests.delete(requester);
    }
    this.pendingDuelRequests?.delete(playerId);
    for (const [requester, target] of this.pendingDuelRequests ?? []) {
      if (target === playerId) this.pendingDuelRequests?.delete(requester);
    }
    for (const [, other] of this.players) {
      if (other.followTargetPlayerId === playerId) {
        other.followTargetPlayerId = -1;
        other.clearMoveQueue();
      }
    }
    if (this.tradeSessions.has(playerId)) {
      this.abortTrade(playerId, 2);
    }
    if (this.duelStakeSessions?.has(playerId)) {
      this.abortDuelStake(playerId, 2);
    }
    if (this.activeDuels?.has(playerId)) {
      this.finishDuelByForfeit(playerId);
    }
  }

  /** Sweep orphan trade sessions where either side has left this.players. */
  private sweepOrphanTradeSessions(): void {
    const seen = new Set<TradeSession>();
    for (const [, session] of this.tradeSessions) {
      if (seen.has(session)) continue;
      seen.add(session);
      const aGone = !this.players.has(session.a.id);
      const bGone = !this.players.has(session.b.id);
      if (aGone || bGone) {
        const surviving = aGone ? session.b.id : session.a.id;
        this.abortTrade(surviving, 2);
      }
    }
  }

  private blockedKeyFor(mapId: string, x: number, z: number, floor: number = 0): string {
    return blockedKey(getMapIdx(mapId), floor, Math.floor(x), Math.floor(z));
  }

  private entityTileKeyFor(mapId: string, x: number, z: number, floor: number = 0): number {
    const mapIdx = getMapIdx(mapId);
    const floorKey = Math.floor(floor) + 128;
    const tileX = Math.floor(x) + 32768;
    const tileZ = Math.floor(z) + 32768;
    return (((mapIdx * 256 + floorKey) * 131072 + tileX) * 131072) + tileZ;
  }

  private markEntityTileOccupantsDirty(): void {
    this.entityTileOccupantsDirty = true;
  }

  private allocateGroundItemId(): number | null {
    const poolSize = GROUND_ITEM_ENTITY_ID_MAX - GROUND_ITEM_ENTITY_ID_MIN + 1;
    for (let attempts = 0; attempts < poolSize; attempts++) {
      const id = nextGroundItemId;
      nextGroundItemId++;
      if (nextGroundItemId > GROUND_ITEM_ENTITY_ID_MAX) {
        nextGroundItemId = GROUND_ITEM_ENTITY_ID_MIN;
      }
      if (
        !this.groundItems.has(id) &&
        !this.players.has(id) &&
        !this.npcs.has(id) &&
        !this.worldObjects.has(id)
      ) {
        return id;
      }
    }
    console.error('[world] Ground item entity-id pool exhausted');
    return null;
  }

  /** Rebuild entityTileOccupants from current player + NPC positions. NPC
   *  footprints span size×size tiles. */
  private rebuildEntityTileOccupants(): void {
    if (this.entityTileOccupantsDirty === false && this.entityTileOccupants) return;
    if (!this.entityTileOccupants) this.entityTileOccupants = new Set();
    this.entityTileOccupants.clear();
    this.playerTileOccupants.clear();
    for (const [, player] of this.players) {
      if (player.disconnected) continue;
      const key = this.entityTileKeyFor(player.currentMapLevel, player.position.x, player.position.y, player.currentFloor);
      this.entityTileOccupants.add(key);
      this.playerTileOccupants.add(key);
    }
    for (const [, npc] of this.npcs) {
      if (npc.dead) continue;
      const size = Math.max(1, npc.size | 0);
      if (size === 1) {
        this.entityTileOccupants.add(
          this.entityTileKeyFor(npc.currentMapLevel, npc.position.x, npc.position.y, npc.currentFloor),
        );
        continue;
      }
      const minX = getObjectFootprintMinTile(npc.position.x, size);
      const minZ = getObjectFootprintMinTile(npc.position.y, size);
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
          this.entityTileOccupants.add(
            this.entityTileKeyFor(npc.currentMapLevel, minX + i, minZ + j, npc.currentFloor),
          );
        }
      }
    }
    this.entityTileOccupantsDirty = false;
  }

  /** Check if player is on a valid interaction tile for the object. */
  private isAdjacentToObject(player: Player, obj: WorldObject): boolean {
    const ptx = Math.floor(player.position.x);
    const ptz = Math.floor(player.position.y);
    return this.canUseObjectFromTile(player, obj, ptx, ptz);
  }

  handlePlayerMove(playerId: number, path: { x: number; z: number }[]): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (this.activeDuels?.has(playerId)) {
      player.clearMoveQueue();
      player.followTargetPlayerId = -1;
      return;
    }
    if (path.length === 0) {
      this.bumpActionRevision(player);
      this.clearCombatTarget(playerId);
      player.attackTarget = null;
      player.clearMoveQueue();
      player.followTargetPlayerId = -1;
      this.clearQueuedPlayerActions(player);
      this.cancelItemProduction(playerId);
      return;
    }

    this.bumpActionRevision(player);
    this.clearCombatTarget(playerId);
    player.attackTarget = null;
    this.clearQueuedPlayerActions(player);
    player.followTargetPlayerId = -1;
    this.cancelSkilling(playerId);
    this.cancelItemProduction(playerId);
    // Walking auto-closes any open modal interface (bank/trade) — mirrors
    // RS2 behavior where moving aborts the current dialog.
    if (player.isInterfaceOpen()) this.closeOpenInterface(player, /*declineTrade*/ true);
    // Shops aren't a modal interface but they're context-tied to standing at
    // the shopkeeper. Walking away invalidates the scope.
    this.closeShopForPlayer(player);
    if (player.openDialogueState) this.sendDialogueClose(player);

    const map = this.getPlayerMap(player);
    // Cap path length. Client's sendMove caps at 50 corner waypoints — anything
    // larger is a malicious client. The previous 200-cap × 256 unit-tiles per
    // segment let a single packet queue ~50K tiles into moveQueue.
    if (path.length > 50) path.length = 50;
    // The client compresses paths to corner waypoints — only the tiles where
    // the step direction changes are kept. We expand each segment into unit
    // tiles and validate every intermediate tile, otherwise a crafted packet
    // with two walkable endpoints separated by a wall would walk through it
    // (isWallBlocked only handles dx,dz ∈ {-1,0,1}). The unit-tile expansion
    // also becomes the moveQueue so processMovement consumes one tile/tick,
    // which matches the client's 1.67 t/s visual interpolation exactly.
    // Per-segment cap: legitimate compressed corners can be far apart on a
    // long straight, but never longer than the map's diagonal. 256 covers
    // any practical map while bounding worst-case work per packet.
    const MAX_SEGMENT_TILES = 64;
    const MAX_REQUESTED_TILES = 200;
    // Work in tile-index space (integers) for blocking/wall checks but emit
    // tile-CENTER coordinates (.5 offsets) into validPath so the server's
    // authoritative positions match what the client predicts. Without the
    // .5 reconciliation, the server stores integer positions while the
    // client interpolates between .5-centered waypoints — every walk leaves
    // the two views half a tile apart, and on the next walk the server's
    // delta calc (floor(step.x) - floor(prevX)) starts from the wrong tile,
    // which can compound into multi-tile drift.
    const validated = expandAndValidateWaypointPath({
      startX: player.position.x,
      startZ: player.position.y,
      waypoints: path,
      initialState: {
        floor: player.currentFloor,
        y: player.effectiveY,
        lastFloorChangeTile: player.lastFloorChangeTile,
      },
      maxSegmentTiles: MAX_SEGMENT_TILES,
      maxRequestedTiles: MAX_REQUESTED_TILES,
      canStep: ({ state, fromTileX, fromTileZ, toTileX, toTileZ }) => {
        const tileBlocked = this.isPlayerMovementTileBlocked(player, map, toTileX, toTileZ, state.floor);
        const wallBlocked = state.floor === 0
          ? map.isWallBlocked(fromTileX, fromTileZ, toTileX, toTileZ, state.y)
          : map.isWallBlockedOnFloor(fromTileX, fromTileZ, toTileX, toTileZ, state.floor);
        return !tileBlocked && !wallBlocked;
      },
      afterStep: ({ state, toTileX, toTileZ }) => this.resolvePlayerMovementLayerAt(
        map,
        toTileX + 0.5,
        toTileZ + 0.5,
        state,
      ),
    });
    player.setMoveQueue(validated.path);
    // If we actually dropped tiles vs. what the client asked for, notify it
    // so it can trim its local walk to match. Skip when nothing was
    // requested (zero-distance / empty input) or when the validation
    // produced exactly what was asked. Fire-and-forget — no server state.
    if (validated.truncated && validated.path.length < validated.requestedTileCount && validated.requestedTileCount > 0) {
      const last = validated.path.length > 0 ? validated.path[validated.path.length - 1] : { x: player.position.x, z: player.position.y };
      player.botStats?.recordPathTruncation();
      this.sendToPlayer(player, ServerOpcode.PATH_TRUNCATED, qPos(last.x), qPos(last.z));
      this.sendNearbyDoorUpdates(player);
    }
  }

  handlePlayerFollow(playerId: number, targetPlayerId: number): void {
    const player = this.players.get(playerId);
    const target = this.players.get(targetPlayerId);
    if (!player || !target) return;
    if (this.activeDuels?.has(playerId)) {
      player.clearMoveQueue();
      player.followTargetPlayerId = -1;
      return;
    }
    if (player.id === target.id) return;
    if (player.disconnected || target.disconnected) return;
    if (player.currentMapLevel !== target.currentMapLevel || player.currentFloor !== target.currentFloor) return;

    this.interruptPlayerAction(playerId, player);
    this.clearCombatTarget(playerId);
    player.clearMoveQueue();
    player.attackTarget = null;
    player.followTargetPlayerId = target.id;
    player.nextFollowRepathTick = 0;
    if (player.isInterfaceOpen()) this.closeOpenInterface(player, /*declineTrade*/ true);
    this.closeShopForPlayer(player);
    if (player.openDialogueState) this.sendDialogueClose(player);
    this.updatePlayerFollow(player, target);
  }

  private buildPlayerFollowCandidates(target: Player): { x: number; z: number }[] {
    const candidates: { x: number; z: number }[] = [];
    const targetTileX = Math.floor(target.position.x);
    const targetTileZ = Math.floor(target.position.y);
    const push = (x: number, z: number): void => {
      const tileX = Math.floor(x);
      const tileZ = Math.floor(z);
      if (tileX === targetTileX && tileZ === targetTileZ) return;
      if (candidates.some(c => Math.floor(c.x) === tileX && Math.floor(c.z) === tileZ)) return;
      candidates.push({ x: tileX + 0.5, z: tileZ + 0.5 });
    };

    if (Number.isFinite(target.followAnchorX) && Number.isFinite(target.followAnchorZ)) {
      push(target.followAnchorX, target.followAnchorZ);
    }

    push(targetTileX - 1 + 0.5, targetTileZ + 0.5);
    push(targetTileX + 1 + 0.5, targetTileZ + 0.5);
    push(targetTileX + 0.5, targetTileZ - 1 + 0.5);
    push(targetTileX + 0.5, targetTileZ + 1 + 0.5);
    return candidates;
  }

  private findPlayerFollowPath(player: Player, target: Player): { x: number; z: number }[] | null {
    const map = this.getPlayerMap(player);
    const floor = player.currentFloor;
    const collision = this.playerPathCollision(player, map, floor);

    for (const goal of this.buildPlayerFollowCandidates(target)) {
      const goalTileX = Math.floor(goal.x);
      const goalTileZ = Math.floor(goal.z);
      if (collision.isTileBlocked(goalTileX, goalTileZ)) continue;
      if (Math.floor(player.position.x) === goalTileX && Math.floor(player.position.y) === goalTileZ) {
        return [];
      }
      const path = findPathToTile({
        startX: player.position.x,
        startZ: player.position.y,
        goalX: goal.x,
        goalZ: goal.z,
        collision,
        maxSearchTiles: PLAYER_FOLLOW_PATH_SEARCH_STEPS,
      });
      if (path.length > 0) return path;
    }

    return null;
  }

  private updatePlayerFollow(player: Player, target: Player): void {
    if (player.id === target.id || target.disconnected || player.currentMapLevel !== target.currentMapLevel || player.currentFloor !== target.currentFloor) {
      player.followTargetPlayerId = -1;
      player.clearMoveQueue();
      return;
    }

    if (player.hasMoveQueue()) return;
    if (this.currentTick < player.nextFollowRepathTick) return;

    const path = this.findPlayerFollowPath(player, target);
    if (path === null) {
      player.nextFollowRepathTick = this.currentTick + 2;
      return;
    }
    if (path.length === 0) {
      player.clearMoveQueue();
      return;
    }
    player.setMoveQueue(path);
    player.nextFollowRepathTick = this.currentTick + 1;
  }

  handlePlayerAttackNpc(playerId: number, npcId: number): void {
    const player = this.players.get(playerId);
    const npc = this.npcs.get(npcId);
    if (!player || !npc || npc.dead) return;
    if (player.isInterfaceOpen()) return;
    // Prevent attacking shopkeepers, dialogue NPCs, and bankers — anything
    // with a non-combat interaction surface. Mirrors the priority used by
    // handlePlayerTalkNpc: dialogue > shop > bank.
    if (npc.hasDialogue || npc.hasShop || npc.hasBank) return;
    if (!this.canPlayerTargetNpc(player, npc)) return;
    if (!this.canPlayerEngageNpcCombat(player, npc)) return;
    if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(npcId)) return;
    this.interruptPlayerAction(playerId, player);
    player.botStats?.recordActionSignature('attackNpc', npc.npcId, player.position.x, player.position.y);

    // Distance to the NPC's nearest footprint tile (size-1 falls through to
    // a plain target-anchor distance) — sized mobs are "in range" when the
    // player is adjacent to their body, not just their placed coordinate.
    const fp = npc.distToFootprint(player.position.x, player.position.y);
    const dist = Math.sqrt(fp.dx * fp.dx + fp.dz * fp.dz);
    const isRanged = player.isRangedWeapon(this.data.itemDefs);
    const isMagicAutocast = player.autocastSpellIndex >= 0;
    const rangedAttackDist = isRanged ? player.getRangedAttackRange(this.data.itemDefs) : RANGED_ATTACK_DISTANCE;
    const attackDist = isMagicAutocast ? MAGIC_ATTACK_DISTANCE : (isRanged ? rangedAttackDist : 1.5);
    const attackMode = isMagicAutocast ? 'magic' : (isRanged ? 'ranged' : 'melee');
    const inAttackRange = this.isPlayerInNpcAttackRange(player, npc, attackMode, rangedAttackDist);
    if (dist > Math.max(attackDist, 24)) return;

    player.attackTarget = npc;
    this.setCombatTarget(playerId, npcId);

    if (!inAttackRange) {
      // Prefer the client-sent path. The client sends sendMove(path) right
      // before PLAYER_ATTACK_NPC; that path lands in moveQueue via
      // handlePlayerMove. Overwriting it with an independently-pathfound
      // route would diverge from the client's visual and trip the >1.5-tile
      // snap-on-divergence (visible as a mid-walk teleport). If moveQueue
      // is empty — e.g. the client didn't send a path, or it got rejected
      // for wall validation — fall back to server-side pathfinding so the
      // chase still happens. tickPlayerCombat only re-pathfinds after the
      // current queue is consumed, keeping client prediction stable mid-walk.
      if (isMagicAutocast && player.hasMoveQueue()) {
        const beforeDest = player.getMoveDestination();
        if (this.trimPlayerPathToNpcRange(player, npc, MAGIC_ATTACK_DISTANCE, MAGIC_ATTACK_RANGE_MODE)) {
          this.notifyClientIfMoveDestinationChanged(player, beforeDest);
        }
      } else if (isRanged && player.hasMoveQueue()) {
        const beforeDest = player.getMoveDestination();
        if (this.trimPlayerPathToNpcRange(player, npc, attackDist, 'chebyshev', true)) {
          this.notifyClientIfMoveDestinationChanged(player, beforeDest);
        }
      } else if (!player.hasMoveQueue()) {
        if (isMagicAutocast) {
          this.queuePlayerPathToNpcRange(player, npc, MAGIC_ATTACK_DISTANCE, MAGIC_ATTACK_RANGE_MODE);
        } else if (!isRanged) {
          const path = this.findPlayerPathToNpc(player, npc);
          player.setMoveQueue(path);
        } else {
          this.queuePlayerPathToNpcRange(player, npc, attackDist, 'chebyshev', true);
        }
      }
    } else {
      if (!player.hasMoveQueue()) player.clearMoveQueue();
    }
  }

  handlePlayerExamineNpc(playerId: number, npcEntityId: number): void {
    const player = this.players.get(playerId);
    const npc = this.npcs.get(npcEntityId);
    if (!player || !npc || npc.dead) return;
    if (player.isInterfaceOpen()) return;
    if (!this.canPlayerTargetNpc(player, npc)) return;
    if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(npcEntityId)) return;

    if (!this.isPlayerNpcInteractionReachable(player, npc)) {
      this.sendChatSystem(player, "I can't reach that.");
      return;
    }

    player.botStats?.recordActionSignature('examineNpc', npc.npcId, player.position.x, player.position.y);
    this.sendChatSystem(player, this.npcExamineTextFor(npc));
  }

  handlePlayerTalkNpc(playerId: number, npcEntityId: number): void {
    const player = this.players.get(playerId);
    const npc = this.npcs.get(npcEntityId);
    if (!player || !npc || npc.dead) return;
    if (player.isInterfaceOpen()) return;
    if (!this.canPlayerTargetNpc(player, npc)) return;
    if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(npcEntityId)) return;
    this.interruptPlayerAction(playerId, player);

    // Chebyshev (max-of-axes) matches the rest of the interaction surface —
    // pickup, combat, harvest are all Chebyshev. Euclidean here would let a
    // diagonal NPC at (2,2) be talkable (dist 2.83) while the same NPC at
    // (3,0) cardinal would be rejected (dist 3.001) — subtle inconsistency.
    // Sized NPCs measure to nearest footprint tile so a player adjacent to
    // a 2x2 camel's east face still passes the range check.
    const dx = npc.position.x - player.position.x;
    const dz = npc.position.y - player.position.y;
    // RS2: dialogue requires the player to be adjacent. Out-of-range clicks
    // queue pendingTalkNpcId; the player tick loop fires it once the player
    // reaches a valid interaction tile.
    if (!this.isPlayerNpcInteractionReachable(player, npc)) {
      player.pendingTalkNpcId = npcEntityId;
      player.pendingTalkRepathTicks = 8;
      this.markQueuedAction(player);
      if (!player.hasMoveQueue() && !this.queuePlayerPathToNpcInteraction(player, npc)) {
        this.sendChatSystem(player, "I can't reach that.");
        player.pendingTalkNpcId = -1;
        player.pendingTalkRepathTicks = 0;
        player.pendingActionRevision = -1;
      }
      return;
    }
    player.pendingTalkNpcId = -1;
    player.pendingTalkRepathTicks = 0;
    player.botStats?.recordActionSignature('talkNpc', npc.npcId, player.position.x, player.position.y);

    // Turn the NPC to face the player on interaction (2004scape NPC.faceEntity
    // semantics). Direction goes from NPC → player so atan2 produces the yaw
    // the NPC needs to look the player's way.
    this.broadcastNpcFacing(npc, -dx, -dz);

    // NPCs introduce themselves in chat instead of carrying a head label.
    // Only for dialogue-less NPCs — when there's a dialogue, the panel
    // itself shows the speaker name on every line, so a chat intro would
    // be redundant. Same for the shop title (already shows the name).
    if (!npc.hasDialogue && !npc.hasShop) {
      this.sendChatSystem(player, `${npc.displayName}: Greetings, traveler.`);
    }

    // Priority: dialogue > shop > bank. A dialogue tree can itself open the
    // shop or bank via DialogueAction, so authoring a dialogue-wrapped
    // shopkeeper is the supported way to combine the two.
    if (npc.hasDialogue) {
      this.openDialogueAt(player, npc, this.dialogueRootFor(player, npc.effectiveDialogue!), true);
      return;
    }

    if (npc.hasShop) {
      this.openShopFor(player, npc);
      return;
    }

    if (npc.hasBank) {
      this.openBankFor(player);
      return;
    }
  }

  private shopItemCurrentStock(npc: Npc, item: ShopItem): number {
    const stock = npc.shopStock.get(item.itemId);
    return Math.max(0, Math.min(item.stock, Math.floor(stock ?? item.stock)));
  }

  private shopItemPrice(item: ShopItem, currentStock: number): number {
    const basePrice = Math.max(0, Math.floor(item.price));
    const baseStock = Math.max(0, Math.floor(item.stock));
    if (basePrice <= 0 || baseStock <= 0) return basePrice;
    const missingStock = Math.max(0, Math.min(baseStock, baseStock - currentStock));
    return Math.ceil((basePrice * (baseStock * 2 + missingStock)) / (baseStock * 2));
  }

  private shopPurchaseCost(item: ShopItem, currentStock: number, quantity: number): number {
    let total = 0;
    for (let i = 0; i < quantity; i++) {
      total += this.shopItemPrice(item, currentStock - i);
    }
    return total;
  }

  private shopRestockTicks(shop: ShopDef): number {
    const value = Math.floor(shop.restockTicks ?? DEFAULT_SHOP_RESTOCK_TICKS);
    return Math.max(0, value);
  }

  private sendShopOpen(player: Player, npc: Npc): void {
    const shop = npc.effectiveShop;
    if (!shop) return;
    const values: number[] = [npc.id, shop.items.length];
    for (const si of shop.items) {
      const currentStock = this.shopItemCurrentStock(npc, si);
      values.push(si.itemId, this.shopItemPrice(si, currentStock), currentStock);
    }
    this.sendToPlayer(player, ServerOpcode.SHOP_OPEN, ...values);
  }

  /** Open the shop UI for this player against this NPC. Extracted so the
   *  dialogue `openShop` action can reuse it. */
  private openShopFor(player: Player, npc: Npc): void {
    if (!npc.effectiveShop) return;
    player.openShopNpcId = npc.npcId;
    player.openShopNpcEntityId = npc.id;
    this.sendShopOpen(player, npc);
  }

  private findOpenShopNpc(player: Player): Npc | null {
    if (player.openShopNpcEntityId !== null) {
      const npc = this.npcs.get(player.openShopNpcEntityId);
      if (npc?.effectiveShop && !npc.dead) return npc;
    }
    if (player.openShopNpcId === null) return null;
    for (const [, npc] of this.npcs) {
      if (npc.npcId === player.openShopNpcId && npc.effectiveShop && !npc.dead) return npc;
    }
    return null;
  }

  private playerStillNearShop(player: Player): boolean {
    const npc = this.findOpenShopNpc(player);
    return !!npc
      && this.canPlayerTargetNpc(player, npc)
      && this.isPlayerNpcInteractionReachable(player, npc);
  }

  private closeShopForPlayer(player: Player): void {
    player.openShopNpcId = null;
    player.openShopNpcEntityId = null;
  }

  private refreshShopViewers(npc: Npc): void {
    for (const [, player] of this.players) {
      if (player.openShopNpcEntityId !== npc.id) continue;
      if (
        player.disconnected
        || player.currentMapLevel !== npc.currentMapLevel
        || player.currentFloor !== npc.currentFloor
        || !this.isPlayerNpcInteractionReachable(player, npc)
      ) {
        this.closeShopForPlayer(player);
        continue;
      }
      this.sendShopOpen(player, npc);
    }
  }

  private scheduleShopRestock(npc: Npc, item: ShopItem): void {
    const shop = npc.effectiveShop;
    if (!shop) return;
    const restockTicks = this.shopRestockTicks(shop);
    if (restockTicks <= 0) {
      npc.shopNextRestockTick.delete(item.itemId);
      return;
    }
    const currentStock = this.shopItemCurrentStock(npc, item);
    if (currentStock >= item.stock) {
      npc.shopNextRestockTick.delete(item.itemId);
      return;
    }
    if (!npc.shopNextRestockTick.has(item.itemId)) {
      npc.shopNextRestockTick.set(item.itemId, this.currentTick + restockTicks);
    }
  }

  private allocateDialogueSessionId(): number {
    const id = this.nextDialogueSessionId;
    this.nextDialogueSessionId = this.nextDialogueSessionId >= DIALOGUE_SESSION_MAX ? 1 : this.nextDialogueSessionId + 1;
    return id;
  }

  private setDialogueState(
    player: Player,
    npcEntityId: number,
    nodeId: string,
    visibleOptionIndices: number[],
    sessionId: number = player.openDialogueState?.sessionId ?? this.allocateDialogueSessionId(),
  ): number {
    player.openDialogueState = { sessionId, npcEntityId, nodeId, visibleOptionIndices };
    return sessionId;
  }

  closeDialogueForPlayer(player: Player, notifyClient: boolean = true): void {
    const sessionId = player.openDialogueState?.sessionId ?? 0;
    if (player.openDialogueState === null) return;
    player.openDialogueState = null;
    this.dialogueScheduledSteps = this.dialogueScheduledSteps.filter(step => step.playerId !== player.id || step.sessionId !== sessionId);
    if (notifyClient) this.sendToPlayer(player, ServerOpcode.DIALOGUE_CLOSE, sessionId);
  }

  /** Push the current dialogue node to the client and update server-side
   *  state. Sends DIALOGUE_OPEN with a JSON-encoded node payload (lines,
   *  speaker, options) so the client doesn't need to know the whole tree. */
  private dialogueRootFor(player: Player, tree: import('@projectrs/shared').DialogueTree): string {
    for (const route of tree.rootConditions ?? []) {
      if (this.quests.questConditionMet(player, route.condition) && tree.nodes[route.node]) return route.node;
    }
    return tree.root;
  }

  private openDialogueAt(player: Player, npc: Npc, nodeId: string, newSession: boolean = false): void {
    const tree = npc.effectiveDialogue;
    if (!tree) return;
    const node = tree.nodes[nodeId];
    if (!node) {
      // Author error — node referenced doesn't exist. Close gracefully so we
      // don't trap the client in a dead conversation.
      this.closeDialogueForPlayer(player);
      return;
    }
    // Strip layout (editor-only metadata) from the wire payload.
    const { layout, ...wireNode } = node;
    void layout;
    const visibleIndices: number[] = [];
    const visibleOptions: import('@projectrs/shared').DialogueOption[] = [];
    for (let i = 0; i < wireNode.options.length; i++) {
      if (this.dialogueOptionVisible(player, wireNode.options[i])) {
        visibleIndices.push(i);
        visibleOptions.push(wireNode.options[i]);
      }
    }
    const sessionId = this.setDialogueState(
      player,
      npc.id,
      nodeId,
      visibleIndices,
      newSession ? this.allocateDialogueSessionId() : undefined,
    );
    const payload = JSON.stringify({
      sessionId,
      speaker: wireNode.speaker ?? npc.displayName,
      lines: wireNode.lines,
      options: visibleOptions.map(o => ({ label: o.label })),
    });
    const packet = encodeStringPacket(ServerOpcode.DIALOGUE_OPEN, payload, npc.id, sessionId);
    try { player.ws.sendBinary(packet); } catch { /* connection closed */ }
  }

  private sendDialogueClose(player: Player): void {
    this.closeDialogueForPlayer(player);
  }

  handleDialogueChoose(playerId: number, npcEntityId: number, sessionId: number, optionIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const state = player.openDialogueState;
    if (!state || state.npcEntityId !== npcEntityId) return;
    if (sessionId !== -1 && state.sessionId !== sessionId) return;
    const npc = this.npcs.get(npcEntityId);
    if (!npc || npc.dead || !this.canPlayerTargetNpc(player, npc)) { this.sendDialogueClose(player); return; }
    const tree = npc.effectiveDialogue;
    if (!tree) { this.sendDialogueClose(player); return; }
    const node = tree.nodes[state.nodeId];
    if (!node) { this.sendDialogueClose(player); return; }
    // Index is into the filtered option list the client saw, NOT the raw
    // node options. Use the snapshot captured in openDialogueAt — re-running
    // the filter here would race the player's quest state advancing between
    // open and choose (option shifts under their finger).
    if (optionIndex < 0 || optionIndex >= state.visibleOptionIndices.length) return;
    const rawIndex = state.visibleOptionIndices[optionIndex];
    if (rawIndex < 0 || rawIndex >= node.options.length) return;
    const option = node.options[rawIndex];
    this.quests.notifyQuestEvent(player, {
      type: 'dialogue',
      npcDefId: npc.def.id,
      npcEntityId: npc.id,
      npcName: npc.displayName,
      nodeId: node.id,
      optionLabel: option.label,
    });

    // Run the action FIRST so an `openShop` action can replace the dialogue
    // panel with the shop — the order here is the visible UX order.
    const actions = [
      ...(option.action ? [option.action] : []),
      ...(option.actions ?? []),
    ];
    if (actions.length > 0) {
      if (!this.runDialogueActions(player, npc, actions)) return;
      const afterActionState = player.openDialogueState;
      if (
        !afterActionState ||
        afterActionState.sessionId !== state.sessionId ||
        afterActionState.npcEntityId !== state.npcEntityId ||
        afterActionState.nodeId !== state.nodeId
      ) {
        return;
      }
    }
    // If the action was openShop/openBank, those took ownership of the UI;
    // sendDialogueClose already fired inside runDialogueAction. Otherwise
    // advance to the next node, or close if the option ends the conversation.
    if (player.openDialogueState && option.next) {
      this.openDialogueAt(player, npc, option.next);
    } else if (player.openDialogueState && !option.next) {
      this.sendDialogueClose(player);
    }
  }

  handleDialogueClose(playerId: number, npcEntityId: number, sessionId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const state = player.openDialogueState;
    if (!state || state.npcEntityId !== npcEntityId || state.sessionId !== sessionId) return;
    this.closeDialogueForPlayer(player);
  }

  private runDialogueActions(
    player: Player,
    npc: Npc,
    actions: import('@projectrs/shared').DialogueAction[],
  ): boolean {
    const initialState = player.openDialogueState;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (this.isQuestDialogueAction(action)) {
        const batch = [action];
        while (true) {
          const next = actions[i + 1];
          if (!next || !this.isQuestDialogueAction(next)) break;
          batch.push(next);
          i++;
        }
        if (!this.quests.runQuestActions(player, batch, 'dialogue')) return false;
      } else {
        this.runDialogueAction(player, npc, action);
      }
      const state = player.openDialogueState;
      if (
        !initialState ||
        !state ||
        state.sessionId !== initialState.sessionId ||
        state.npcEntityId !== initialState.npcEntityId ||
        state.nodeId !== initialState.nodeId
      ) {
        return true;
      }
    }
    return true;
  }

  private isQuestDialogueAction(action: import('@projectrs/shared').DialogueAction): boolean {
    return action.type === 'giveItem'
      || action.type === 'takeItem'
      || action.type === 'grantXp'
      || action.type === 'setQuestStage'
      || action.type === 'setQuestVar'
      || action.type === 'completeQuest';
  }

  private runDialogueAction(
    player: Player,
    npc: Npc,
    action: import('@projectrs/shared').DialogueAction,
  ): void {
    switch (action.type) {
      case 'closeDialogue':
        this.sendDialogueClose(player);
        return;
      case 'openShop':
        if (npc.hasShop) this.openShopWithAcknowledgement(player, npc);
        else this.sendDialogueClose(player);
        return;
      case 'openBank':
        if (npc.hasBank) this.openBankWithAcknowledgement(player, npc);
        else this.sendDialogueClose(player);
        return;
      case 'openAppearance':
        this.sendDialogueClose(player);
        this.openCharacterCreatorFor(player);
        return;
      case 'startNpcCombat':
        this.sendDialogueClose(player);
        if (npc.dead || !this.canPlayerTargetNpc(player, npc)) return;
        if (!this.canPlayerEngageNpcCombat(player, npc)) {
          this.sendChatSystem(player, "You can't attack that right now.");
          return;
        }
        player.attackTarget = npc;
        this.setCombatTarget(player.id, npc.id);
        this.broadcastNpcFacingPlayer(npc, player);
        return;
    }
  }

  /** Predicate for the `requires` gate on a single dialogue option. Used by
   *  openDialogueAt to build the visible-options snapshot. Per-option (not
   *  per-list) so the caller can also record the original index. */
  private dialogueOptionVisible(player: Player, opt: import('@projectrs/shared').DialogueOption): boolean {
    return this.quests.dialogueOptionVisible(player, opt);
  }

  private openBankWithAcknowledgement(player: Player, npc: Npc): void {
    const sessionId = this.setDialogueState(player, npc.id, '__bank_ack__', []);
    const payload = JSON.stringify({
      sessionId,
      speaker: npc.displayName,
      lines: [BANKER_ACKNOWLEDGE_LINE],
      options: [],
      autoClose: true,
    });
    const packet = encodeStringPacket(ServerOpcode.DIALOGUE_OPEN, payload, npc.id, sessionId);
    try { player.ws.sendBinary(packet); } catch { return; }

    this.dialogueScheduledSteps.push({
      type: 'openBank',
      runAtTick: this.currentTick + BANKER_BANK_OPEN_DELAY_TICKS,
      playerId: player.id,
      npcEntityId: npc.id,
      sessionId,
    });
  }

  private openShopWithAcknowledgement(player: Player, npc: Npc): void {
    const sessionId = this.setDialogueState(player, npc.id, '__shop_ack__', []);
    const payload = JSON.stringify({
      sessionId,
      speaker: npc.displayName,
      lines: [BANKER_ACKNOWLEDGE_LINE],
      options: [],
      autoClose: true,
    });
    const packet = encodeStringPacket(ServerOpcode.DIALOGUE_OPEN, payload, npc.id, sessionId);
    try { player.ws.sendBinary(packet); } catch { return; }

    this.dialogueScheduledSteps.push({
      type: 'openShop',
      runAtTick: this.currentTick + BANKER_BANK_OPEN_DELAY_TICKS,
      playerId: player.id,
      npcEntityId: npc.id,
      sessionId,
    });
  }

  handlePlayerBuyItem(playerId: number, itemId: number, quantity: number): void {
    const player = this.players.get(playerId);
    if (!player || quantity < 1) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.isInterfaceOpen()) return;

    // Must be talking to a specific shop. Closes the "send PLAYER_BUY_ITEM
    // without ever clicking a shopkeeper" exploit and the "buy items from
    // shop B while only shop A's panel is open" exploit.
    const npc = this.findOpenShopNpc(player);
    const shop = npc?.effectiveShop ?? null;
    if (!npc || !shop) {
      this.closeShopForPlayer(player);
      return;
    }
    if (!this.playerStillNearShop(player)) {
      this.closeShopForPlayer(player);
      return;
    }
    const shopItem = shop.items.find(s => s.itemId === itemId);
    if (!shopItem) return; // this shop doesn't sell this item

    const itemDef = this.data.getItem(itemId);
    if (!itemDef) return;
    const currentStock = this.shopItemCurrentStock(npc, shopItem);
    if (currentStock <= 0 || quantity > currentStock) return;
    const totalCost = this.shopPurchaseCost(shopItem, currentStock, quantity);

    // Check coin balance against current inventory.
    const coinSlot = player.inventory.findIndex(s => s?.itemId === 10);
    const coinCount = coinSlot >= 0 ? player.inventory[coinSlot]!.quantity : 0;
    if (coinCount < totalCost) return;

    // Pre-flight: can the player fit the purchased items? Without this check
    // we'd take coins, fail addItem, and leave the player short. canFit treats
    // stackables (need a slot OR an existing stack) and non-stackables (need
    // N empty slots) correctly.
    if (!player.canFit(itemId, quantity, this.data.itemDefs)) return;

    // Atomic: remove coins, add items. addItem clamps to MAX_STACK and
    // returns completed < quantity if it can't fully fit — defense in depth
    // beyond canFit, since canFit doesn't know about MAX_STACK overflow on
    // an existing 2.1B-coin stack. On any partial failure, revert coins.
    const coinRemoved = player.removeItem(coinSlot, totalCost);
    if (coinRemoved.completed !== totalCost) {
      player.revertRemove(coinRemoved);
      return;
    }
    const added = player.addItem(itemId, quantity, this.data.itemDefs);
    if (added.completed !== quantity) {
      player.revertAdd(added);
      player.revertRemove(coinRemoved);
      this.sendChatSystem(player, 'You can\'t carry any more of those.');
      return;
    }

    npc.shopStock.set(itemId, currentStock - quantity);
    this.scheduleShopRestock(npc, shopItem);
    this.interruptPlayerAction(playerId, player, true);
    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
    this.refreshShopViewers(npc);
  }

  handlePlayerSellItem(playerId: number, slot: number, quantity: number, expectedItemId: number): void {
    const player = this.players.get(playerId);
    if (!player || quantity < 1) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.isInterfaceOpen()) return;
    if (slot < 0 || slot >= player.inventory.length) return;

    // Must be at an open shop. Without this anyone could send PLAYER_SELL_ITEM
    // anywhere and get coins for items at half-value. Open-shop scoping also
    // makes the "you must travel to find a vendor" loop matter for authenticity.
    const npc = this.findOpenShopNpc(player);
    const shop = npc?.effectiveShop ?? null;
    if (!npc || !shop) {
      this.closeShopForPlayer(player);
      return;
    }
    if (!this.playerStillNearShop(player)) {
      this.closeShopForPlayer(player);
      return;
    }

    const invItem = player.inventory[slot];
    if (!invItem) return;
    if (invItem.itemId !== expectedItemId) return;

    const itemDef = this.data.getItem(invItem.itemId);
    if (!itemDef) return;

    // Sell price = half of value (floor)
    const sellPrice = Math.max(1, Math.floor((itemDef.value || 1) / 2));
    const actualQty = Math.min(quantity, invItem.quantity);
    const totalGold = sellPrice * actualQty;

    // Atomic: remove sold items first, then add coins. If the coin add can't
    // fully fit (no slot OR existing 2.1B stack overflow), revert the remove
    // so the player isn't left with items destroyed and no coins.
    const removed = player.removeItem(slot, actualQty);
    if (removed.completed !== actualQty) {
      player.revertRemove(removed);
      return;
    }
    const added = player.addItem(10, totalGold, this.data.itemDefs);
    if (added.completed !== totalGold) {
      player.revertAdd(added);
      player.revertRemove(removed);
      this.sendChatSystem(player, 'You can\'t carry any more coins.');
      return;
    }

    this.interruptPlayerAction(playerId, player, true);
    const shopItem = shop.items.find(s => s.itemId === invItem.itemId);
    if (shopItem) {
      const currentStock = this.shopItemCurrentStock(npc, shopItem);
      const nextStock = Math.min(shopItem.stock, currentStock + actualQty);
      if (nextStock !== currentStock) {
        npc.shopStock.set(invItem.itemId, nextStock);
        this.scheduleShopRestock(npc, shopItem);
      }
    }
    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
    this.refreshShopViewers(npc);
  }

  handlePlayerPickup(playerId: number, groundItemId: number): void {
    const player = this.players.get(playerId);
    const item = this.groundItems.get(groundItemId);
    if (!player || !item) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.isInterfaceOpen()) return;
    if (!this.canPlayerTargetGroundItem(player, item)) return;
    if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(groundItemId)) return;
    this.interruptPlayerAction(playerId, player);

    // Walk to item if not in range or if an adjacent wall/fence blocks direct pickup.
    const dx = Math.abs(player.position.x - item.x);
    const dz = Math.abs(player.position.y - item.z);
    if (dx > 1.5 || dz > 1.5 || !this.canPlayerReachGroundItemFromCurrentTile(player, item)) {
      // The client normally sends PLAYER_MOVE immediately before PICKUP.
      // Preserve that queue instead of replacing it with a separately
      // pathfound server route from an earlier authoritative tile; otherwise
      // running redirects can rubber-band when the two routes differ.
      if (!player.hasMoveQueue()) {
        const path = this.findPlayerPathToTile(player, Math.floor(item.x), Math.floor(item.z));
        if (path.length > 0) player.setMoveQueue(path);
      }
      if (player.hasMoveQueue()) {
        player.pendingPickup = groundItemId;
        this.markQueuedAction(player);
      }
      return;
    }
    player.botStats?.recordActionSignature('pickup', item.itemId, player.position.x, player.position.y);

    const added = player.addItem(item.itemId, item.quantity, this.data.itemDefs);
    if (added.completed > 0) {
      const respawnSource = item.spawnKey ? this.groundItemRespawnSources.get(item.spawnKey) : undefined;
      if (respawnSource && item.spawnKey) {
        respawnSource.respawnTimer = respawnSource.respawnTime;
        this.activeGroundItemRespawnKeys.add(item.spawnKey);
      }
      this.groundItems.delete(groundItemId);
      this.despawningItemIds.delete(groundItemId);
      const itemCm = this.chunkManagers.get(item.mapLevel);
      if (itemCm) itemCm.removeEntity(groundItemId);
      // Map-wide broadcast: a viewer who saw the drop, walked OOR, and stays
      // away when someone else grabs it would otherwise keep the stale sprite.
      const packet = encodePacket(ServerOpcode.GROUND_ITEM_SYNC, groundItemId, 0, 0, 0, 0, item.floor, qPos(this.floorWorldY(item.mapLevel, item.x, item.z, item.floor)));
      for (const [, p] of this.players) {
        if (p.currentMapLevel !== item.mapLevel || p.currentFloor !== item.floor) continue;
        try { p.ws.sendBinary(packet); } catch { /* connection closed */ }
      }
      this.sendInventory(player);
      this.quests.notifyQuestEvent(player, {
        type: 'itemPickup',
        itemId: item.itemId,
        quantity: added.completed,
        source: 'ground',
      });
      const itemName = this.itemEventName(item.itemId);
      this.recordGameEvent({
        type: 'item_pickup',
        message: `${player.name} picked up ${added.completed} x ${itemName}`,
        actorAccountId: player.accountId,
        actorName: player.name,
        itemId: item.itemId,
        itemName,
        quantity: added.completed,
        mapLevel: item.mapLevel,
        floor: item.floor,
        x: item.x,
        z: item.z,
        details: {
          groundItemId,
          requestedQuantity: item.quantity,
          completedQuantity: added.completed,
        },
      });
    }
  }

  handlePlayerDrop(playerId: number, slotIndex: number, expectedItemId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.isBusyExceptDelayReason(this.currentTick, 'eat')) return;
    if (player.isInterfaceOpen()) return;
    // Explicit bounds. The expectedItemId guard below already rejects OOB
    // indices (inventory[-1]?.itemId is undefined, ≠ any int16), but make the
    // bound check explicit so future refactors can't accidentally remove it.
    if (slotIndex < 0 || slotIndex >= player.inventory.length) return;
    // Stale-click guard: reject if the slot doesn't currently hold the item the
    // client thought it was clicking. Mirrors 2004scape OpHeldHandler.ts:36.
    if (player.inventory[slotIndex]?.itemId !== expectedItemId) return;

    const slot = player.inventory[slotIndex];
    if (!slot) return;
    const groundItemId = this.allocateGroundItemId();
    if (groundItemId === null) {
      this.sendChatSystem(player, 'The ground is too cluttered here.');
      return;
    }

    const removed = player.removeItem(slotIndex, slot.quantity);
    if (removed.completed === 0) return;
    this.interruptPlayerAction(playerId, player);

    const groundItem: GroundItem = {
      id: groundItemId,
      itemId: removed.itemId,
      quantity: removed.completed,
      x: player.position.x,
      z: player.position.y,
      floor: player.currentFloor,
      mapLevel: player.currentMapLevel,
      despawnTimer: GROUND_ITEM_DESPAWN_TICKS,
    };
    this.groundItems.set(groundItem.id, groundItem);
    this.despawningItemIds.add(groundItem.id);
    const dropCm = this.chunkManagers.get(groundItem.mapLevel);
    if (dropCm) dropCm.addEntity(groundItem.id, groundItem.x, groundItem.z, 'groundItem');

    this.forEachPlayerNearOnFloor(groundItem.mapLevel, groundItem.floor, groundItem.x, groundItem.z, p => this.sendGroundItemUpdate(p, groundItem));
    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
  }

  handleAdminDeleteInventoryItem(playerId: number, slotIndex: number, expectedItemId: number): void {
    const player = this.players.get(playerId);
    if (!player || !player.isAdmin) return;
    if (player.isBusyExceptDelayReason(this.currentTick, 'eat')) return;
    if (player.openInterface !== null && player.openInterface !== 'bank') return;
    if (slotIndex < 0 || slotIndex >= player.inventory.length) return;
    const slot = player.inventory[slotIndex];
    if (!slot || slot.itemId !== expectedItemId) return;

    const removed = player.removeItem(slotIndex, slot.quantity);
    if (removed.completed === 0) return;
    const itemName = this.itemEventName(removed.itemId);

    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
    this.recordGameEvent({
      type: 'admin',
      severity: 'warning',
      message: `${player.name} deleted ${removed.completed} x ${itemName} from inventory`,
      actorAccountId: player.accountId,
      actorName: player.name,
      itemId: removed.itemId,
      itemName,
      quantity: removed.completed,
      mapLevel: player.currentMapLevel,
      floor: player.currentFloor,
      x: player.position.x,
      z: player.position.y,
      details: {
        action: 'delete_item',
        container: 'inventory',
        slot: slotIndex,
        expectedItemId,
      },
    });
  }

  /** Drag-and-drop reorder of two inventory slots. Pure swap — no merge for
   *  stackables (drag-merge is a separate UX gesture and matches RS2 behavior).
   *  Atomic by construction: a single `[a, b] = [b, a]` mutation, no add/remove
   *  dance, so there is no failure path that could dupe or destroy items. */
  handlePlayerMoveInvItem(playerId: number, fromSlot: number, toSlot: number, expectedItemId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.isInterfaceOpen()) return;
    if (fromSlot === toSlot) return;
    if (fromSlot < 0 || fromSlot >= player.inventory.length) return;
    if (toSlot < 0 || toSlot >= player.inventory.length) return;
    // Stale-click guard: source slot must still hold the item the client
    // thought it was dragging. Without this, a click leaking from a previous
    // tick (e.g. quick eat → drag) could swap the wrong slot.
    if (player.inventory[fromSlot]?.itemId !== expectedItemId) return;

    const a = player.inventory[fromSlot];
    const b = player.inventory[toSlot];
    player.inventory[fromSlot] = b;
    player.inventory[toSlot] = a;

    this.sendInventory(player);
    // No setDelay — reordering is a UI affordance, not a tick-consuming action.
  }

  handlePlayerInteractObject(
    playerId: number,
    objectEntityId: number,
    actionIndex: number,
    recipeIndex: number = -1,
    expectedDoorOpen: boolean | null = null,
    recipeQuantity: number = 1,
  ): void {
    const player = this.players.get(playerId);
    const obj = this.worldObjects.get(objectEntityId);
    if (!player || !obj) return;
    if (!this.canPlayerTargetObject(player, obj)) return;
    if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(objectEntityId)) return;
    if (obj.def.category !== 'door') expectedDoorOpen = null;
    if (this.rejectStaleDoorInteraction(player, obj, expectedDoorOpen)) return;
    const action = obj.def.category === 'ladder'
      ? obj.def.actions[actionIndex]
      : obj.currentActions[actionIndex];
    if (!action) return;
    // Doors can be interacted with when open (to close) — other objects can't when depleted
    if (obj.depleted && obj.def.category !== 'door') {
      this.sendWorldObjectUpdate(player, obj);
      // Chests give explicit feedback so the player knows the click was
      // received but the chest is still on cooldown; trees/rocks etc. stay
      // silent (their depleted variant is visually obvious).
      if (obj.def.category === 'chest') {
        this.sendChatSystem(player, `The ${obj.def.name.toLowerCase()} hasn't been restocked yet.`);
      }
      return;
    }
    this.bumpActionRevision(player);
    this.clearQueuedPlayerActions(player);
    this.cancelItemProduction(playerId);

    if (player.isBusy(this.currentTick)) {
      const isQueuedObjectAction = obj.def.category === 'door' || obj.def.category === 'ladder' || (obj.def.harvestItemId && (obj.def.skill || obj.def.category === 'crop'));
      if (isQueuedObjectAction) {
        player.pendingInteraction = { objectEntityId, actionIndex, swingSign: 0, expectedDoorOpen, recipeQuantity };
        this.markQueuedAction(player);
      }
      return;
    }
    // While a modal interface (bank/trade) is open, refuse object interactions
    // outright — no door deferral. Closing the interface is a deliberate user
    // action; we won't queue clicks behind it.
    if (player.isInterfaceOpen()) return;
    this.closeNpcUiContext(player);

    // Check adjacency — player must be on a tile next to the object
    if (obj.def.category === 'ladder' && (action === 'Climb-up' || action === 'Climb-down') && !this.canPlayerUseLadderActionOnCurrentFloor(player, obj, action)) {
      this.sendWorldObjectUpdate(player, obj);
      this.sendChatSystem(player, action === 'Climb-down' ? "I can't climb down there." : "I can't climb up there.");
      return;
    }

    if (!this.isAdjacentToObject(player, obj)) {
      if (action === 'Examine') {
        this.sendChatSystem(player, "I can't reach that.");
        return;
      }
      if (obj.def.category === 'door') {
        const swingSign = obj.doorOpen ? 0 : this.computeSwingSign(player, obj);
        const map = this.getPlayerMap(player);
        const [dtx, dtz] = this.doorTile(obj);

        let path: { x: number; z: number }[];
        if (obj.doorOpen) {
          const px = player.position.x, pz = player.position.y;
          const candidates: [number, number][] = [
            [dtx + 0.5, dtz - 0.5],
            [dtx + 0.5, dtz + 1.5],
            [dtx + 1.5, dtz + 0.5],
            [dtx - 0.5, dtz + 0.5],
            [dtx + 0.5, dtz + 0.5],
          ];
          candidates.sort((a, b) =>
            (Math.abs(a[0] - px) + Math.abs(a[1] - pz)) - (Math.abs(b[0] - px) + Math.abs(b[1] - pz)));
          path = [];
          for (const [cx, cz] of candidates) {
            path = findPathToTile({
              startX: px,
              startZ: pz,
              goalX: cx,
              goalZ: cz,
              collision: this.playerPathCollision(player, map),
              maxSearchTiles: DEFAULT_MAX_SEARCH_TILES,
            });
            if (path.length > 0) break;
          }
        } else {
          const edge = this.doorWallEdge(obj);
          const nb = DOOR_EDGE_NEIGHBOR[edge];
          let tx = dtx, tz = dtz;
          const px = player.position.x, pz = player.position.y;
          if (edge === WallEdge.N && pz < dtz + 0.5 && nb) { tx = dtx + nb.dx; tz = dtz + nb.dz; }
          else if (edge === WallEdge.S && pz > dtz + 0.5 && nb) { tx = dtx + nb.dx; tz = dtz + nb.dz; }
          else if (edge === WallEdge.E && px > dtx + 0.5 && nb) { tx = dtx + nb.dx; tz = dtz + nb.dz; }
          else if (edge === WallEdge.W && px < dtx + 0.5 && nb) { tx = dtx + nb.dx; tz = dtz + nb.dz; }
          path = findPathToTile({
            startX: px,
            startZ: pz,
            goalX: tx + 0.5,
            goalZ: tz + 0.5,
            collision: this.playerPathCollision(player, map),
            maxSearchTiles: DEFAULT_MAX_SEARCH_TILES,
          });
        }

        if (!player.hasMoveQueue() && path.length > 0) {
          player.setMoveQueue(path);
        }
        if (player.hasMoveQueue()) {
          player.pendingInteraction = { objectEntityId, actionIndex, swingSign, expectedDoorOpen, recipeQuantity };
          this.markQueuedAction(player);
        }
        // Empty path = unreachable (closed door is the only gap in the wall
        // and player is on the wrong side, OR maxSteps exhausted). Drop the
        // click — there is no useful action we can queue for them.
        return;
      }
      const opensRecipePicker = this.shouldOpenRecipePicker(obj);
      // Specific recipe craft packets demand strict adjacency. The initial
      // picker-open intent may walk, then the server opens the UI on arrival.
      if (opensRecipePicker && recipeIndex >= 0) {
        this.sendChatSystem(player, `I need to stand next to the ${obj.def.name.toLowerCase()}.`);
        return;
      }
      const path = this.findPathToObjectInteraction(player, obj);
      if (!player.hasMoveQueue() && path.length > 0) {
        player.setMoveQueue(path);
      }
      if (player.hasMoveQueue()) {
        player.pendingInteraction = { objectEntityId, actionIndex, recipeIndex, recipeQuantity };
        this.markQueuedAction(player);
      } else {
        this.sendChatSystem(player, "I can't reach that.");
      }
      return;
    }

    // Stop movement
    player.clearMoveQueue();
    player.attackTarget = null;
    this.clearCombatTarget(playerId);

    player.botStats?.recordActionSignature('object', obj.defId, player.position.x, player.position.y, action);

    if (action !== 'Examine' && recipeIndex < 0 && this.shouldOpenRecipePicker(obj)) {
      this.sendToPlayer(player, ServerOpcode.SMITHING_OPEN, obj.id);
      return;
    }

    this.runObjectInteractionEffects(player, obj, action);
    this.quests.notifyQuestEvent(player, {
      type: 'objectInteract',
      objectDefId: obj.defId,
      objectEntityId,
      objectName: obj.displayName,
      action,
    });

    if (action === 'Examine') {
      this.sendChatSystem(player, this.objectExamineTextFor(player, obj));
      return;
    }

    if (action === 'Fill' && this.isWaterSourceObject(obj)) {
      this.handleWaterSourceInteraction(playerId, player, obj);
      return;
    }

    if (action === 'Enter') {
      this.handleTeleportInteraction(player, obj);
      return;
    }

    if (obj.def.category === 'bank' && action === 'Talk-to') {
      const banker = this.findBankerAcrossBooth(player, obj);
      if (!banker) {
        this.sendChatSystem(player, "I can't reach that.");
        return;
      }
      this.handlePlayerTalkNpc(player.id, banker.id);
      return;
    }

    if (obj.def.category === 'bank' && (action === 'Bank' || action === 'Use-quickly')) {
      this.openBankFor(player);
      return;
    }

    if (obj.def.category === 'ladder' && (action === 'Climb-up' || action === 'Climb-down')) {
      this.handleLadderInteraction(player, obj, action);
      return;
    }

    if (obj.def.category === 'door' && (action === 'Open' || action === 'Unlock' || action === 'Close')) {
      if ((action === 'Open' || action === 'Unlock') && !this.canOpenLockedDoor(player, obj)) return;
      this.toggleDoor(obj, this.computeSwingSign(player, obj));
      return;
    }

    if (obj.def.harvestItemId && (obj.def.skill || obj.def.category === 'crop')) {
      this.handleHarvestInteraction(playerId, player, obj, action);
      return;
    }

    if (obj.def.category === 'obelisk' && obj.def.recipes && obj.def.recipes.length > 0) {
      this.handleObeliskOffer(playerId, player, obj);
      return;
    }

    if (obj.def.category === 'altar' && action === 'Offer-relic') {
      this.handleAltarRelicOffer(player, obj);
      return;
    }

    if (obj.def.recipes && obj.def.recipes.length > 0) {
      if (
        recipeIndex >= 0
        && this.supportsObjectRecipeProduction(obj)
        && (
          recipeQuantity !== 1
          || obj.def.category === 'cookingrange'
          || obj.defId === SPINNING_WHEEL_OBJECT_DEF_ID
        )
      ) {
        this.startObjectRecipeProduction(playerId, player, obj, recipeIndex, recipeQuantity);
      } else {
        this.handleCraftingInteraction(playerId, player, obj, recipeIndex);
      }
      return;
    }
  }

  private isWaterSourceObject(obj: WorldObject): boolean {
    return obj.defId === WELL_OBJECT_DEF_ID;
  }

  private supportsObjectRecipeProduction(obj: WorldObject): boolean {
    return BATCH_OBJECT_RECIPE_DEF_IDS.includes(obj.defId);
  }

  private objectRecipeProductionTicks(obj: WorldObject): number {
    if (obj.defId === COOKING_RANGE_OBJECT_DEF_ID) return COOKING_RECIPE_TICKS;
    if (obj.defId === SPINNING_WHEEL_OBJECT_DEF_ID) return SPINNING_WHEEL_RECIPE_TICKS;
    return 1;
  }

  private shouldOpenRecipePicker(obj: WorldObject): boolean {
    const recipes = obj.def.recipes ?? [];
    if (recipes.length === 0) return false;
    if (obj.defId === SPINNING_WHEEL_OBJECT_DEF_ID) return true;
    if (recipes[0]?.requiresTool) return true;
    return recipes.length > 1;
  }

  private runObjectInteractionEffects(player: Player, obj: WorldObject, action: string): void {
    const effect = obj.interactions?.find(candidate =>
      candidate.action === action && this.objectInteractionEffectMatches(player, candidate)
    );
    if (!effect) return;

    if (Array.isArray(effect.saySequence) && effect.saySequence.length > 0) {
      this.queueObjectSaySequence(player, effect.saySequence);
    } else if (typeof effect.say === 'string') {
      const say = effect.say.trim();
      if (say) broadcastLocalMessage(player.name, say.slice(0, 1000), player.accountId, player.isAdmin, player.isModerator);
    }
    const message = typeof effect.message === 'string' ? effect.message.trim() : '';
    if (message) this.sendChatSystem(player, message.slice(0, 300));
    const actionsSucceeded = this.quests.runQuestActions(player, effect.effects || [], 'object');
    if (effect.depleteObject && actionsSucceeded) {
      this.depleteObjectFromInteractionEffect(obj, effect.depleteRespawnTicks);
    }
  }

  private objectInteractionEffectMatches(
    player: Player,
    effect: NonNullable<WorldObject['interactions']>[number],
  ): boolean {
    if (effect.condition && !this.quests.questConditionMet(player, effect.condition)) return false;
    if (effect.conditions?.some(condition => !this.quests.questConditionMet(player, condition))) return false;
    return true;
  }

  private objectExamineTextFor(player: Player, obj: WorldObject): string {
    if (obj.def.category === 'altar') {
      const hasRelic = player.inventory.some(slot => slot !== null && RELIC_ITEM_IDS.has(slot.itemId));
      return hasRelic
        ? 'I should sacrifice some relics for good luck!'
        : 'i wish i had something worth sacrificing';
    }
    return obj.examineText || obj.def.examineText || `It's ${obj.displayName}.`;
  }

  private npcExamineTextFor(npc: Npc): string {
    return npc.def.examineText || `It's ${npc.displayName}.`;
  }

  private depleteObjectFromInteractionEffect(obj: WorldObject, respawnTicks?: number): void {
    if (obj.depleted || obj.def.category === 'door') return;
    obj.depleted = true;
    obj.respawnTimer = Math.max(0, Math.floor(respawnTicks ?? obj.def.respawnTime ?? 0));
    if (obj.respawnTimer > 0) {
      this.depletedObjectIds.add(obj.id);
      this.queueObjectRespawnSave(obj, Date.now() + obj.respawnTimer * TICK_RATE);
    }
    this.broadcastWorldObjectStateChange(obj);
  }

  private queueObjectSaySequence(player: Player, sequence: NonNullable<WorldObject['interactions']>[number]['saySequence']): void {
    if (!sequence) return;
    for (const line of sequence) {
      if (!line || typeof line.text !== 'string') continue;
      const message = line.text.trim().slice(0, 1000);
      if (!message) continue;
      const delaySeconds = typeof line.delaySeconds === 'number' && Number.isFinite(line.delaySeconds)
        ? Math.max(0, Math.min(30, line.delaySeconds))
        : 0;
      const delayTicks = Math.round((delaySeconds * 1000) / TICK_RATE);
      if (delayTicks <= 0) {
        broadcastLocalMessage(player.name, message, player.accountId, player.isAdmin, player.isModerator);
        continue;
      }
      this.objectSayScheduledLines.push({
        runAtTick: this.currentTick + delayTicks,
        playerId: player.id,
        accountId: player.accountId,
        isAdmin: player.isAdmin,
        isModerator: player.isModerator,
        playerName: player.name,
        message,
      });
    }
  }

  private handleTeleportInteraction(player: Player, obj: WorldObject): void {
    this.interruptPlayerAction(player.id, player);
    if (this.isDungeonExitObject(obj)) {
      const returnTransition = this.consumeDungeonReturnTarget(player);
      if (returnTransition) {
        this.handleMapTransition(player, returnTransition);
        return;
      }
    }
    if (obj.trigger?.type === 'teleport' && obj.trigger.destChunk) {
      const targetX = Number.isFinite(obj.trigger.entryX) ? obj.trigger.entryX : 32.5;
      const targetZ = Number.isFinite(obj.trigger.entryZ) ? obj.trigger.entryZ : 32.5;
      if (this.shouldRememberDungeonReturnTarget(player, obj, obj.trigger.destChunk)) {
        this.rememberDungeonReturnTarget(player, obj.trigger.destChunk);
      }
      this.handleMapTransition(player, {
        targetMap: obj.trigger.destChunk,
        targetX,
        targetZ,
        targetY: Number.isFinite(obj.trigger.entryY) ? obj.trigger.entryY : undefined,
      });
      return;
    }
    if (obj.def.transition) {
      this.handleMapTransition(player, {
        targetMap: obj.def.transition.targetMap,
        targetX: obj.def.transition.targetX,
        targetZ: obj.def.transition.targetZ,
      });
    }
  }

  private isDungeonExitObject(obj: WorldObject): boolean {
    const assetId = obj.assetId?.toLowerCase();
    return assetId === 'cavernexit1' || (assetId === 'cavedoor' && this.isDungeonMap(obj.mapLevel));
  }

  private shouldRememberDungeonReturnTarget(player: Player, obj: WorldObject, targetMapId: string): boolean {
    if (targetMapId === player.currentMapLevel) return false;
    if (this.isDungeonExitObject(obj)) return false;
    return this.isDungeonMap(targetMapId);
  }

  private isDungeonMap(mapId: string): boolean {
    const map = this.maps.get(mapId);
    return map?.meta.mapType === 'dungeon' || map?.meta.dungeon === true;
  }

  private rememberDungeonReturnTarget(player: Player, dungeonMap: string): void {
    player.dungeonReturnTargets.set(dungeonMap, {
      mapId: player.currentMapLevel,
      x: player.position.x,
      z: player.position.y,
      y: player.effectiveY,
      floor: player.currentFloor,
    });
  }

  private consumeDungeonReturnTarget(player: Player): { targetMap: string; targetX: number; targetZ: number; targetFloor?: number; targetY?: number } | null {
    const target = player.dungeonReturnTargets.get(player.currentMapLevel);
    if (!target) return null;
    player.dungeonReturnTargets.delete(player.currentMapLevel);
    return {
      targetMap: target.mapId,
      targetX: target.x,
      targetZ: target.z,
      targetFloor: target.floor,
      targetY: target.y,
    };
  }

  private handleLadderInteraction(player: Player, obj: WorldObject, action: 'Climb-up' | 'Climb-down'): void {
    const link = this.resolveLadderLinkForPlayerAction(player, obj, action);
    if (!link) {
      this.sendChatSystem(player, action === 'Climb-down' ? "I can't climb down there." : "I can't climb up there.");
      return;
    }

    this.interruptPlayerAction(player.id, player);
    if (link.to.mapId !== player.currentMapLevel) {
      this.handleMapTransition(player, {
        targetMap: link.to.mapId,
        targetX: link.to.x,
        targetZ: link.to.z,
        targetFloor: link.to.floor,
        targetY: link.to.y,
      });
      return;
    }
    this.teleportPlayer(player, link.to.x, link.to.z, link.to.y, link.to.floor);
    const map = this.getPlayerMap(player);
    player.lastFloorChangeTile = Math.floor(link.to.z) * map.width + Math.floor(link.to.x);
    this.savePlayerState(player);
  }

  private handleHarvestInteraction(playerId: number, player: Player, obj: WorldObject, action: string): void {
    // Crops are one-shot picks: no animation, no skilling tick, single roll
    // with a 1-tick cooldown so each click yields at most one item.
    if (obj.def.category === 'crop') {
      const itemId = obj.def.harvestItemId!;
      const qty = obj.def.harvestQuantity ?? 1;
      const { added, dropped } = this.awardHarvestItem(player, itemId, qty);
      if (added > 0) {
        this.sendInventory(player);
        this.quests.notifyQuestEvent(player, { type: 'itemPickup', itemId, quantity: added, source: 'harvest' });
      }
      if (dropped > 0) this.sendChatSystem(player, "Your inventory is full, so the harvest falls to the ground.");
      if (obj.def.depletionChance && Math.random() < obj.def.depletionChance) {
        this.persistAndBroadcastDepletion(obj);
      }
      // Idle + targetId orients remote viewers toward the crop without
      // playing an animation.
      this.setPlayerAnimation(player, PlayerAnimationKind.Idle, PlayerSkillAnimationVariant.None, obj.id);
      player.setDelay(this.currentTick, 1);
      return;
    }

    const skillId = obj.def.skill as SkillId;
    const playerLevel = player.skills[skillId]?.level ?? 1;
    const levelRequired = obj.def.levelRequired ?? 1;
    if (playerLevel < levelRequired) {
      this.sendChatSystem(player, `You need level ${levelRequired} ${SKILL_NAMES[skillId] ?? 'skill'} to do that.`);
      return;
    }

    const requiredTool = obj.def.category === 'tree' ? 'axe' : obj.def.category === 'rock' ? 'pickaxe' : null;
    let toolItemId: number | undefined;
    let toolBonus = 0;
    if (requiredTool) {
      const bestTool = this.findBestTool(player, requiredTool, playerLevel);
      if (!bestTool) {
        const lowestOwnedRequirement = this.findLowestOwnedToolRequirement(player, requiredTool);
        if (lowestOwnedRequirement !== null && lowestOwnedRequirement > playerLevel) {
          this.sendChatSystem(player, `You need level ${lowestOwnedRequirement} ${SKILL_NAMES[skillId] ?? 'skill'} to use that ${requiredTool}.`);
        } else {
          this.sendChatSystem(player, `You need ${requiredTool === 'axe' ? 'an axe' : 'a pickaxe'} to ${action.toLowerCase()}.`);
        }
        return;
      }
      toolItemId = bestTool.id;
      toolBonus = bestTool.toolBonus ?? 0;
    }

    // Better pickaxes shorten the mining cycle. Current tiers intentionally
    // stop at 4 ticks; 3/2 ticks are reserved for future high-end pickaxes.
    // Other harvestables still use the raw tool bonus to shorten the cycle.
    let cycleTime: number;
    if (obj.def.category === 'rock') {
      const baseTime = obj.def.harvestTime ?? World.DEFAULT_MINING_RATE;
      const speedReduction = World.MINING_TOOL_SPEED_REDUCTION_BY_BONUS[toolBonus] ?? Math.max(0, Math.min(3, toolBonus - 1));
      cycleTime = Math.max(4, baseTime - speedReduction);
    } else {
      const baseTime = obj.def.harvestTime ?? 4;
      cycleTime = Math.max(2, baseTime - toolBonus);
    }

    this.skillingActions.set(playerId, {
      objectId: obj.id,
      action,
      cycleTime,
      toolItemId,
      toolBonus,
    });
    if (obj.def.category !== 'rock') player.actionDelay = 0;
    const variant = obj.def.category === 'tree'
      ? PlayerSkillAnimationVariant.Chop
      : obj.def.category === 'rock'
        ? PlayerSkillAnimationVariant.Mine
        : PlayerSkillAnimationVariant.None;
    this.setPlayerAnimation(player, PlayerAnimationKind.Skill, variant, obj.id, false, toolItemId ?? 0);
    this.sendToPlayer(player, ServerOpcode.SKILLING_START, obj.id, toolItemId ?? 0);
  }

  private handleCraftingInteraction(
    playerId: number,
    player: Player,
    obj: WorldObject,
    recipeIndex: number,
    opts: { interrupt?: boolean; explainFailure?: boolean } = {},
  ): boolean {
    const recipes = obj.def.recipes!;
    const recipesToTry = (recipeIndex >= 0 && recipeIndex < recipes.length)
      ? [recipes[recipeIndex]]
      : recipes;
    const shouldExplainFailure = (opts.explainFailure ?? true) && recipesToTry.length === 1;

    for (const recipe of recipesToTry) {
      const skillId = recipe.skill as SkillId;
      const playerLevel = player.skills[skillId]?.level ?? 1;
      if (playerLevel < recipe.levelRequired) {
        if (shouldExplainFailure) {
          this.sendChatSystem(player, `You need level ${recipe.levelRequired} ${SKILL_NAMES[skillId] ?? 'skill'} to do that.`);
        }
        continue;
      }

      if (recipe.requiresTool) {
        const hasTool = player.inventory.some(slot =>
          slot !== null && this.data.getItem(slot.itemId)?.toolType === recipe.requiresTool
        );
        if (!hasTool) {
          if (shouldExplainFailure) this.sendChatSystem(player, `You need a ${recipe.requiresTool} to do that.`);
          continue;
        }
      }
      if (opts.interrupt ?? true) this.interruptPlayerAction(playerId, player);

      // removeItemById aggregates across slots, so unstackable multi-unit
      // inputs (e.g. 3 bars in 3 slots) consume correctly.
      const inputRemoval = player.removeItemById(recipe.inputItemId, recipe.inputQuantity);
      if (inputRemoval.completed === 0) {
        if (shouldExplainFailure) {
          this.sendChatSystem(player, `You need ${this.itemRequirementLabel(recipe.inputItemId, recipe.inputQuantity)} to do that.`);
        }
        continue;
      }

      let secondRemoval: ReturnType<typeof player.removeItemById> | null = null;
      if (recipe.secondInputItemId !== undefined) {
        const needed = recipe.secondInputQuantity ?? 1;
        secondRemoval = player.removeItemById(recipe.secondInputItemId, needed);
        if (secondRemoval.completed === 0) {
          player.revertRemove(inputRemoval);
          if (shouldExplainFailure) {
            this.sendChatSystem(player, `You need ${this.itemRequirementLabel(recipe.secondInputItemId, needed)} to do that.`);
          }
          continue;
        }
      }

      if (recipe.successChance !== undefined && Math.random() > recipe.successChance) {
        // Recipe rolled fail — inputs are consumed, no output. Matches RS2 behavior.
        this.sendInventory(player);
        return false;
      }

      const craftingOutput = this.resolveCraftingOutput(recipe);
      const addResult = player.addItem(craftingOutput.itemId, craftingOutput.quantity, this.data.itemDefs);
      if (addResult.completed === 0) {
        if (secondRemoval) player.revertRemove(secondRemoval);
        player.revertRemove(inputRemoval);
        this.sendInventory(player);
        return false;
      }

      const result = addXp(player.skills, skillId, craftingOutput.xpReward);
      const skillIdx = ALL_SKILLS.indexOf(skillId);
      if (skillIdx >= 0) {
        this.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, craftingOutput.xpReward);
        if (result.leveled) {
          this.sendLevelUp(player, skillIdx, result.newLevel);
        }
      }
      if (craftingOutput.highQuality) {
        const itemName = this.data.getItem(craftingOutput.itemId)?.name ?? 'High Quality item';
        this.sendChatSystem(player, `High quality result: ${itemName}.`);
        this.recordGameEvent({
          type: 'crafting_hq',
          severity: 'rare',
          message: `${player.name} rolled high quality ${craftingOutput.quantity} x ${itemName} while ${skillId === 'smithing' ? 'smithing' : 'crafting'} at ${obj.def.name}`,
          actorAccountId: player.accountId,
          actorName: player.name,
          itemId: craftingOutput.itemId,
          itemName,
          quantity: craftingOutput.quantity,
          mapLevel: player.currentMapLevel,
          floor: player.currentFloor,
          x: player.position.x,
          z: player.position.y,
          details: {
            skill: skillId,
            stationObjectId: obj.id,
            stationDefId: obj.defId,
            stationName: obj.def.name,
            baseOutputItemId: recipe.outputItemId,
            hqOutputItemId: recipe.hqOutputItemId,
            hqChance: recipe.hqChance ?? 0,
            xpReward: craftingOutput.xpReward,
          },
        });
      }

      if (
        obj.defId === SPINNING_WHEEL_OBJECT_DEF_ID
        && recipe.inputItemId === LOW_QUALITY_SINEW_ITEM_ID
        && recipe.outputItemId === BOWSTRING_ITEM_ID
      ) {
        this.broadcastWorldObjectAnimation(obj);
      }

      this.sendInventory(player);
      if (skillIdx >= 0) this.sendSingleSkill(player, skillIdx);
      return true;
    }
    return false;
  }

  private resolveCraftingOutput(recipe: ObjectRecipe): {
    itemId: number;
    quantity: number;
    xpReward: number;
    highQuality: boolean;
  } {
    const hqChance = recipe.hqChance ?? 0;
    if (
      recipe.hqOutputItemId !== undefined
      && hqChance > 0
      && Math.random() < hqChance
    ) {
      return {
        itemId: recipe.hqOutputItemId,
        quantity: recipe.outputQuantity,
        xpReward: Math.floor(recipe.xpReward * (recipe.hqXpMultiplier ?? DEFAULT_HQ_XP_MULTIPLIER)),
        highQuality: true,
      };
    }
    return {
      itemId: recipe.outputItemId,
      quantity: recipe.outputQuantity,
      xpReward: recipe.xpReward,
      highQuality: false,
    };
  }

  private itemRequirementLabel(itemId: number, quantity: number): string {
    const name = this.data.getItem(itemId)?.name ?? `item ${itemId}`;
    return quantity > 1 ? `${quantity} ${name}` : name;
  }

  private handleObeliskOffer(playerId: number, player: Player, obj: WorldObject): void {
    // Reuse the recipe pipeline for inventory + xp; only fire animation + tick
    // delay on a successful offering so a player without bones (or with a full
    // inventory) doesn't get locked into a useless 1-tick lockout.
    const success = this.handleCraftingInteraction(playerId, player, obj, -1);
    if (!success) return;
    // Broadcast-only (mirrors attack handling) so the player's persistent
    // animation state stays Idle — late-joiners shouldn't see the offering
    // animation replay when they stream into chunk range.
    this.broadcastPlayerAnimationEvent(player, PlayerAnimationKind.Skill, PlayerSkillAnimationVariant.Magic, obj.id, true);
    player.setDelay(this.currentTick, 1);
  }

  private handleAltarRelicOffer(player: Player, obj: WorldObject): void {
    const tier = Math.max(1, Math.floor(obj.altarTier || 1));
    const sacrifice = relicTierDef(tier);
    if (!sacrifice) {
      this.sendChatSystem(player, 'This altar is dormant.');
      return;
    }

    let relicItemId = 0;
    for (const itemId of sacrifice.itemIds) {
      if (this.playerHasItem(player, itemId, 1)) {
        relicItemId = itemId;
        break;
      }
    }
    if (relicItemId <= 0) {
      this.sendChatSystem(player, `You need a tier-${tier} relic to sacrifice here.`);
      return;
    }

    this.interruptPlayerAction(player.id, player);
    const removal = player.removeItemById(relicItemId, 1);
    if (removal.completed < 1) return;

    const xp = sacrifice.goodMagicXp;
    const result = addXp(player.skills, 'goodmagic', xp);
    const skillIdx = ALL_SKILLS.indexOf('goodmagic');
    if (skillIdx >= 0) {
      this.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, xp);
      if (result.leveled) this.sendLevelUp(player, skillIdx, result.newLevel);
      this.sendSingleSkill(player, skillIdx);
    }
    this.sendInventory(player);
    this.broadcastPlayerAnimationEvent(player, PlayerAnimationKind.Skill, PlayerSkillAnimationVariant.Magic, obj.id, true);
    player.setDelay(this.currentTick, 1);
  }

  handlePlayerEquip(playerId: number, slotIndex: number, expectedItemId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.isInterfaceOpen()) return;
    if (slotIndex < 0 || slotIndex >= player.inventory.length) return;
    if (player.inventory[slotIndex]?.itemId !== expectedItemId) return;

    const slot = player.inventory[slotIndex];
    if (!slot) return;

    const itemDef = this.data.getItem(slot.itemId);
    if (!itemDef || !itemDef.equippable || !itemDef.equipSlot) return;

    const equipSlot = itemDef.equipSlot as EquipSlot;
    const requiredLevel = itemDef.levelRequired ?? 1;
    const requiredSkill = itemDef.equipSkill ?? (equipSlot === 'weapon' ? 'weaponry' : equipSlot === 'ammo' ? undefined : 'defence');
    if (requiredSkill && requiredLevel > 1 && (player.skills[requiredSkill]?.level ?? 1) < requiredLevel) {
      this.sendChatSystem(player, `You need level ${requiredLevel} ${SKILL_NAMES[requiredSkill] ?? 'skill'} to equip ${itemDef.name}.`);
      return;
    }

    const currentEquipped = player.equipment.get(equipSlot);

    if (equipSlot === 'ammo') {
      if (!itemDef.isAmmo) return;
      const sourceQuantity = Math.min(MAX_STACK, Math.max(1, Math.floor(slot.quantity)));
      this.interruptPlayerAction(playerId, player);

      if (currentEquipped === slot.itemId) {
        const currentQuantity = player.getEquipmentQuantity('ammo');
        const room = MAX_STACK - currentQuantity;
        if (room <= 0) {
          this.sendChatSystem(player, 'Your ammo slot is full.');
          return;
        }
        const movedQuantity = Math.min(sourceQuantity, room);
        player.setEquipment('ammo', slot.itemId, currentQuantity + movedQuantity);
        if (movedQuantity >= slot.quantity) {
          player.inventory[slotIndex] = null;
        } else {
          slot.quantity -= movedQuantity;
        }
      } else {
        const currentQuantity = player.getEquipmentQuantity('ammo');
        if (currentEquipped !== undefined) {
          player.inventory[slotIndex] = { itemId: currentEquipped, quantity: currentQuantity };
        } else {
          player.inventory[slotIndex] = null;
        }
        player.setEquipment('ammo', slot.itemId, sourceQuantity);
      }

      this.syncPlayerActiveCombatIntent(player);
      player.setDelay(this.currentTick, 1);
      this.sendInventory(player);
      this.sendEquipment(player);
      this.broadcastRemoteEquipment(player);
      this.savePlayerState(player);
      return;
    }

    // Pre-flight: figure out if any side-unequips (2H↔shield) will displace
    // an item into the inventory, and reject the swap if there's no room.
    // Without this check, the displaced item silently vanishes — leaving both
    // pieces equipped (e.g. 2H weapon + shield).
    let sideUnequipId: number | undefined;
    if (equipSlot === 'weapon' && itemDef.twoHanded) {
      sideUnequipId = player.equipment.get('shield');
    } else if (equipSlot === 'shield') {
      const weaponId = player.equipment.get('weapon');
      if (weaponId !== undefined) {
        const weaponDef = this.data.getItem(weaponId);
        if (weaponDef?.twoHanded) sideUnequipId = weaponId;
      }
    }

    if (sideUnequipId !== undefined) {
      // After the source-slot swap, the source slot is filled iff there's a
      // current equipped item to displace into it. So free slots available for
      // the side-unequip are: current free slots, plus 1 if source becomes empty.
      let freeSlots = 0;
      for (const s of player.inventory) if (s === null) freeSlots++;
      const freeAfterSwap = freeSlots + (currentEquipped === undefined ? 1 : 0);
      if (freeAfterSwap < 1) {
        // Not enough room — refuse the equip entirely. Better than leaving
        // the player in an invalid two-mainhand state.
        this.sendChatSystem(player, 'You need a free inventory slot to do that.');
        return;
      }
    }

    const weaponBefore = player.equipment.get('weapon');
    this.interruptPlayerAction(playerId, player);

    // Source slot: receives displaced equipment if any, else cleared.
    if (currentEquipped !== undefined) {
      player.inventory[slotIndex] = { itemId: currentEquipped, quantity: player.getEquipmentQuantity(equipSlot) };
    } else {
      player.removeItem(slotIndex);
    }

    player.setEquipment(equipSlot, slot.itemId);

    if (sideUnequipId !== undefined) {
      // Pre-flight guarantees this fits, but use the transaction return to
      // catch any future drift in canFit logic.
      const addResult = player.addItem(sideUnequipId, 1, this.data.itemDefs);
      if (addResult.completed > 0) {
        player.deleteEquipment(equipSlot === 'weapon' ? 'shield' : 'weapon');
      }
    }

    const weaponChanged = weaponBefore !== player.equipment.get('weapon');
    if (weaponChanged) {
      this.clearAutocastSelection(player, 'weapon-equipment-changed', false);
    }
    if (weaponChanged) {
      this.syncPlayerActiveCombatIntent(player);
    }
    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
    this.sendEquipment(player);
    this.broadcastRemoteEquipment(player);
    this.savePlayerState(player);
  }

  handlePlayerUnequip(playerId: number, equipSlotIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.isInterfaceOpen()) return;

    const slotName = EQUIPMENT_SLOT_NAMES[equipSlotIndex];
    if (!slotName) return;

    const itemId = player.equipment.get(slotName);
    if (itemId === undefined) return;
    const quantity = player.getEquipmentQuantity(slotName);

    if (player.addItem(itemId, quantity, this.data.itemDefs).completed === quantity) {
      this.interruptPlayerAction(playerId, player);
      player.deleteEquipment(slotName);
      if (slotName === 'weapon') {
        this.clearAutocastSelection(player, 'weapon-unequipped', false);
        this.syncPlayerActiveCombatIntent(player);
      } else if (slotName === 'ammo') {
        this.syncPlayerActiveCombatIntent(player);
      }
      player.setDelay(this.currentTick, 1);
      this.sendInventory(player);
      this.sendEquipment(player);
      this.broadcastRemoteEquipment(player);
      this.savePlayerState(player);
    }
  }

  handlePlayerEat(playerId: number, slotIndex: number, expectedItemId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.isInterfaceOpen()) return;
    // Explicit bounds — see handlePlayerDrop for rationale.
    if (slotIndex < 0 || slotIndex >= player.inventory.length) return;
    if (player.inventory[slotIndex]?.itemId !== expectedItemId) return;

    const slot = player.inventory[slotIndex];
    if (!slot) return;

    const itemDef = this.data.getItem(slot.itemId);
    if (!itemDef || !itemDef.healAmount) return;

    this.interruptPlayerAction(playerId, player);

    player.heal(itemDef.healAmount);
    player.skills.hitpoints.currentLevel = player.health;
    player.removeItem(slotIndex, 1);
    // Food has a 3-tick cooldown, but dropping items is allowed through it.
    player.setDelay(this.currentTick, 3, 'eat');

    this.sendInventory(player);
    this.sendToPlayer(player, ServerOpcode.PLAYER_STATS,
      player.health, player.maxHealth
    );
  }

  /** Validate a player exists and is in a non-modal state with the expected
   *  item in `slot`. Returns the player on success, null to drop the packet. */
  private validateInvUse(playerId: number, slot: number, expectedItemId: number): Player | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    if (player.isBusy(this.currentTick)) {
      this.cancelItemProduction(playerId);
      return null;
    }
    if (player.isInterfaceOpen()) return null;
    if (slot < 0 || slot >= player.inventory.length) return null;
    if (player.inventory[slot]?.itemId !== expectedItemId) return null;
    return player;
  }

  handlePlayerUseItemOnItem(
    playerId: number,
    fromSlot: number,
    fromItemId: number,
    toSlot: number,
    toItemId: number,
    quantity: number = 1,
    recipeIndex: number = 0,
  ): void {
    if (fromSlot === toSlot) return;
    const player = this.validateInvUse(playerId, fromSlot, fromItemId);
    if (!player) return;
    if (toSlot < 0 || toSlot >= player.inventory.length) return;
    if (player.inventory[toSlot]?.itemId !== toItemId) return;
    this.interruptPlayerAction(playerId, player);
    const recipe = this.findItemOnItemRecipe(fromItemId, toItemId, recipeIndex);
    if (recipe) {
      if (recipe.repeatable && (quantity !== 1 || (recipe.intervalTicks ?? 1) > 1)) {
        this.startItemProduction(playerId, player, recipe, quantity);
      } else {
        this.handleItemOnItemRecipe(player, recipe);
      }
      return;
    }

    this.sendChatSystem(player, USE_NO_RECIPE_REPLY);
  }

  private findItemOnItemRecipes(fromItemId: number, toItemId: number): ItemOnItemRecipe[] {
    return ITEM_ON_ITEM_RECIPES.filter(recipe => {
      const [a, b] = recipe.inputItemIds;
      return (a === fromItemId && b === toItemId) || (a === toItemId && b === fromItemId);
    });
  }

  private findItemOnItemRecipe(fromItemId: number, toItemId: number, recipeIndex: number = 0): ItemOnItemRecipe | null {
    const recipes = this.findItemOnItemRecipes(fromItemId, toItemId);
    const index = Number.isFinite(recipeIndex) ? Math.max(0, Math.trunc(recipeIndex)) : 0;
    return recipes[index] ?? null;
  }

  private handleItemOnItemRecipe(
    player: Player,
    recipe: ItemOnItemRecipe,
    opts: { sendMessage?: boolean } = {},
  ): boolean {
    const removals: ReturnType<Player['removeItemById']>[] = [];
    const adds: ReturnType<Player['addItem']>[] = [];
    const sendMessage = opts.sendMessage ?? true;

    const skillId = recipe.skill;
    if (skillId) {
      const levelRequired = recipe.levelRequired ?? 1;
      const playerLevel = player.skills[skillId]?.level ?? 1;
      if (playerLevel < levelRequired) {
        this.sendChatSystem(player, `You need level ${levelRequired} ${SKILL_NAMES[skillId] ?? 'skill'} to do that.`);
        return false;
      }
    }

    for (const input of recipe.consume) {
      const removed = player.removeItemById(input.itemId, input.quantity);
      if (removed.completed === 0) {
        for (let i = removals.length - 1; i >= 0; i--) player.revertRemove(removals[i]);
        this.sendInventory(player);
        return false;
      }
      removals.push(removed);
    }

    const craftingOutput = this.resolveItemOnItemOutput(recipe);
    for (const output of craftingOutput.outputs) {
      const added = player.addItem(output.itemId, output.quantity, this.data.itemDefs);
      if (added.completed === 0) {
        for (let i = adds.length - 1; i >= 0; i--) player.revertAdd(adds[i]);
        for (let i = removals.length - 1; i >= 0; i--) player.revertRemove(removals[i]);
        this.sendInventory(player);
        this.sendChatSystem(player, 'You need more inventory space.');
        return false;
      }
      adds.push(added);
    }

    if (skillId && craftingOutput.xpReward > 0) {
      this.grantXp(player, skillId, craftingOutput.xpReward);
    }
    this.sendInventory(player);
    if (sendMessage && recipe.message) this.sendChatSystem(player, recipe.message);
    if (craftingOutput.highQuality) {
      this.recordItemOnItemHighQualityResult(player, recipe, craftingOutput.outputs, craftingOutput.xpReward);
    }
    return true;
  }

  private resolveItemOnItemOutput(recipe: ItemOnItemRecipe): {
    outputs: readonly ItemQuantity[];
    xpReward: number;
    highQuality: boolean;
  } {
    const hqChance = recipe.hqChance ?? 0;
    if (
      recipe.hqOutputs?.length
      && hqChance > 0
      && Math.random() < hqChance
    ) {
      return {
        outputs: recipe.hqOutputs,
        xpReward: Math.floor((recipe.xpReward ?? 0) * (recipe.hqXpMultiplier ?? DEFAULT_HQ_XP_MULTIPLIER)),
        highQuality: true,
      };
    }
    return {
      outputs: recipe.outputs,
      xpReward: recipe.xpReward ?? 0,
      highQuality: false,
    };
  }

  private recordItemOnItemHighQualityResult(
    player: Player,
    recipe: ItemOnItemRecipe,
    outputs: readonly ItemQuantity[],
    xpReward: number,
  ): void {
    const primary = outputs[0];
    if (!primary) return;
    const itemName = this.data.getItem(primary.itemId)?.name ?? 'High Quality item';
    const baseOutputItemId = recipe.outputs[0]?.itemId;
    const baseItemName = baseOutputItemId ? this.data.getItem(baseOutputItemId)?.name : null;
    const actionLabel = recipe.inputItemIds.includes(BOWSTRING_ITEM_ID)
      ? `while stringing ${baseItemName ?? 'a bow'}`
      : 'while crafting';
    this.sendChatSystem(player, `High quality result: ${itemName}.`);
    this.recordGameEvent({
      type: 'crafting_hq',
      severity: 'rare',
      message: `${player.name} rolled high quality ${primary.quantity} x ${itemName} ${actionLabel}`,
      actorAccountId: player.accountId,
      actorName: player.name,
      itemId: primary.itemId,
      itemName,
      quantity: primary.quantity,
      mapLevel: player.currentMapLevel,
      floor: player.currentFloor,
      x: player.position.x,
      z: player.position.y,
      details: {
        skill: recipe.skill ?? 'crafting',
        source: 'item_on_item',
        baseOutputItemId,
        hqOutputItemId: primary.itemId,
        hqChance: recipe.hqChance ?? 0,
        xpReward,
      },
    });
  }

  private startItemProduction(
    playerId: number,
    player: Player,
    recipe: ItemOnItemRecipe,
    quantity: number,
  ): void {
    if (!recipe.repeatable) {
      this.handleItemOnItemRecipe(player, recipe);
      return;
    }
    const remaining = quantity < 0 ? null : Math.max(1, Math.floor(quantity));
    const intervalTicks = Math.max(1, Math.trunc(recipe.intervalTicks ?? 1));
    this.itemProductionActions.set(playerId, {
      kind: 'itemOnItem',
      recipe,
      remaining,
      intervalTicks,
      nextTick: this.currentTick + intervalTicks,
    });
    player.setDelay(this.currentTick, intervalTicks);
    if (recipe.startMessage) this.sendChatSystem(player, recipe.startMessage);
  }

  private startObjectRecipeProduction(
    playerId: number,
    player: Player,
    obj: WorldObject,
    recipeIndex: number,
    quantity: number,
  ): void {
    if (!this.supportsObjectRecipeProduction(obj)) {
      this.handleCraftingInteraction(playerId, player, obj, recipeIndex);
      return;
    }
    const recipes = obj.def.recipes ?? [];
    if (recipeIndex < 0 || recipeIndex >= recipes.length) {
      this.handleCraftingInteraction(playerId, player, obj, recipeIndex);
      return;
    }
    const remaining = quantity < 0 ? null : Math.max(1, Math.floor(quantity));
    const intervalTicks = this.objectRecipeProductionTicks(obj);
    this.itemProductionActions.set(playerId, {
      kind: 'objectRecipe',
      objectEntityId: obj.id,
      recipeIndex,
      remaining,
      nextTick: this.currentTick + intervalTicks,
      intervalTicks,
    });
    player.setDelay(this.currentTick, intervalTicks);
    this.sendChatSystem(player, this.itemProductionStartMessage(obj));
  }

  private itemProductionStartMessage(obj: WorldObject): string {
    if (obj.def.category === 'cookingrange') return 'You start cooking.';
    if (obj.defId === SPINNING_WHEEL_OBJECT_DEF_ID) return 'You start spinning.';
    return 'You start crafting.';
  }

  private findItemOnObjectRecipe(itemId: number, obj: WorldObject): ItemOnObjectRecipe | null {
    return ITEM_ON_OBJECT_RECIPES.find(recipe =>
      recipe.inputItemId === itemId && recipe.objectDefIds.includes(obj.defId)
    ) ?? null;
  }

  private findKilnRecipeIndex(itemId: number, obj: WorldObject): number {
    if (obj.defId !== KILN_OBJECT_DEF_ID) return -1;
    return obj.def.recipes?.findIndex(recipe => recipe.inputItemId === itemId) ?? -1;
  }

  private findSpinningWheelRecipeIndex(itemId: number, obj: WorldObject): number {
    if (obj.defId !== SPINNING_WHEEL_OBJECT_DEF_ID) return -1;
    return obj.def.recipes?.findIndex(recipe => recipe.inputItemId === itemId) ?? -1;
  }

  private handleItemOnObjectRecipe(
    player: Player,
    invSlot: number,
    recipe: ItemOnObjectRecipe,
    opts: { sendMessage?: boolean } = {},
  ): boolean {
    const slot = player.inventory[invSlot];
    if (!slot || slot.itemId !== recipe.inputItemId) return false;
    const sendMessage = opts.sendMessage ?? true;

    if (slot.quantity > 1) {
      slot.quantity -= 1;
      const addResult = player.addItem(recipe.outputItemId, 1, this.data.itemDefs);
      if (addResult.completed === 0) {
        slot.quantity += 1;
        this.sendInventory(player);
        this.sendChatSystem(player, 'You need more inventory space.');
        return false;
      }
    } else {
      player.inventory[invSlot] = { itemId: recipe.outputItemId, quantity: 1 };
    }

    this.sendInventory(player);
    if (sendMessage) this.sendChatSystem(player, recipe.message);
    return true;
  }

  private handleWaterSourceInteraction(playerId: number, player: Player, obj: WorldObject): void {
    this.interruptPlayerAction(playerId, player);
    if (this.playerHasFillableContainer(player)) {
      this.itemProductionActions.set(playerId, {
        kind: 'waterSource',
        objectEntityId: obj.id,
        nextTick: this.currentTick + 1,
      });
      player.setDelay(this.currentTick, 1);
      this.sendChatSystem(player, 'You start filling containers.');
      return;
    }

    this.sendChatSystem(player, 'You need an empty bucket or pot to fill.');
  }

  private playerHasFillableContainer(player: Player): boolean {
    return ITEM_ON_OBJECT_RECIPES.some(recipe =>
      player.inventory.some(slot => slot?.itemId === recipe.inputItemId)
    );
  }

  private countInventoryItem(player: Player, itemId: number): number {
    return player.inventory.reduce((total, slot) => total + (slot?.itemId === itemId ? slot.quantity : 0), 0);
  }

  handlePlayerUseItemOnObject(
    playerId: number,
    invSlot: number,
    itemId: number,
    objectEntityId: number,
  ): void {
    const obj = this.worldObjects.get(objectEntityId);
    if (!obj) return;
    const player = this.validateInvUse(playerId, invSlot, itemId);
    if (!player) return;
    if (!this.canPlayerTargetObject(player, obj)) return;
    if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(objectEntityId)) return;
    this.interruptPlayerAction(playerId, player);
    if (!this.isAdjacentToObject(player, obj)) {
      const path = this.findPathToObjectInteraction(player, obj);
      if (!player.hasMoveQueue() && path.length > 0) {
        player.setMoveQueue(path);
      }
      if (player.hasMoveQueue()) {
        player.pendingUseItemOnObject = { invSlot, itemId, objectEntityId };
        this.markQueuedAction(player);
      } else {
        this.sendChatSystem(player, "I can't reach that.");
      }
      return;
    }
    player.botStats?.recordActionSignature('useItemObject', obj.defId, player.position.x, player.position.y, itemId);
    if (obj.def.category === 'door' && obj.doorLocked && !obj.doorOpen && itemId === obj.doorKeyItemId) {
      if (!this.canOpenLockedDoor(player, obj)) return;
      this.toggleDoor(obj, this.computeSwingSign(player, obj));
      return;
    }
    const recipe = this.findItemOnObjectRecipe(itemId, obj);
    if (recipe) {
      const fillableCount = this.countInventoryItem(player, recipe.inputItemId);
      if (fillableCount > 1) {
        this.itemProductionActions.set(playerId, {
          kind: 'itemOnObject',
          recipe,
          objectEntityId,
          remaining: null,
          nextTick: this.currentTick + 1,
        });
        player.setDelay(this.currentTick, 1);
        this.sendChatSystem(player, 'You start filling containers.');
      } else {
        this.handleItemOnObjectRecipe(player, invSlot, recipe);
      }
      return;
    }
    const kilnRecipeIndex = this.findKilnRecipeIndex(itemId, obj);
    if (kilnRecipeIndex >= 0) {
      const inputCount = this.countInventoryItem(player, itemId);
      if (inputCount > 1) {
        this.startObjectRecipeProduction(playerId, player, obj, kilnRecipeIndex, -1);
      } else {
        this.handleCraftingInteraction(playerId, player, obj, kilnRecipeIndex);
      }
      return;
    }
    const spinningWheelRecipeIndex = this.findSpinningWheelRecipeIndex(itemId, obj);
    if (spinningWheelRecipeIndex >= 0) {
      const inputCount = this.countInventoryItem(player, itemId);
      if (inputCount > 1) {
        this.sendToPlayer(player, ServerOpcode.SMITHING_OPEN, obj.id);
      } else {
        this.startObjectRecipeProduction(playerId, player, obj, spinningWheelRecipeIndex, 1);
      }
      return;
    }
    this.sendChatSystem(player, USE_NO_RECIPE_REPLY);
  }

  handlePlayerUseItemOnNpc(
    playerId: number,
    invSlot: number,
    itemId: number,
    npcEntityId: number,
  ): void {
    const npc = this.npcs.get(npcEntityId);
    if (!npc) return;
    const player = this.validateInvUse(playerId, invSlot, itemId);
    if (!player) return;
    if (!this.canPlayerTargetNpc(player, npc)) return;
    if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(npcEntityId)) return;
    this.interruptPlayerAction(playerId, player);
    if (!this.isPlayerNpcInteractionReachable(player, npc)) {
      if (!player.hasMoveQueue() && !this.queuePlayerPathToNpcInteraction(player, npc)) return;
      if (player.hasMoveQueue()) {
        player.pendingUseItemOnNpc = { invSlot, itemId, npcEntityId };
        this.markQueuedAction(player);
      }
      return;
    }
    player.botStats?.recordActionSignature('useItemNpc', npc.npcId, player.position.x, player.position.y, itemId);
    this.sendChatSystem(player, USE_NO_RECIPE_REPLY);
  }

  handlePlayerSetStance(playerId: number, stanceIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    // Modal interfaces lock stance — keep the gate but echo the current
    // server stance back so the client doesn't desync visually.
    // The previous `isBusy` gate also dropped packets while any unrelated
    // 1-tick delay (inventory/equip/etc.) was active; the optimistic UI
    // would then show the new stance while combat kept reading the old
    // one — surfacing as XP going to the wrong skill. The post-flip
    // setDelay below still prevents rapid stance flip-flopping.
    if (player.isInterfaceOpen() || stanceIndex < 0 || stanceIndex >= STANCE_KEYS.length) {
      this.sendRemoteStance(player, player);
      return;
    }
    player.stance = STANCE_KEYS[stanceIndex];
    this.db.saveStance(player.accountId, player.stance);
    player.setDelay(this.currentTick, 1);
    // Self-echo lets the client correct its optimistic UI if anything ever
    // diverges; broadcast to neighbours so they pick the right swing anim.
    this.sendRemoteStance(player, player);
    this.broadcastRemoteStance(player);
  }

  handlePlayerSetMagicStance(playerId: number, stanceIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const stance = this.stanceFromIndex(stanceIndex);
    if (player.isInterfaceOpen() || !stance) {
      this.sendMagicState(player);
      return;
    }
    player.magicStance = stance;
    this.persistMagicCombatState(player);
    player.setDelay(this.currentTick, 1);
    this.sendMagicState(player);
  }

  handlePlayerSetAutocast(playerId: number, spellIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.isInterfaceOpen()) {
      this.magicDebug(player, 'setAutocast-reject-interface', { spellIndex, openInterface: player.openInterface });
      this.sendMagicState(player);
      return;
    }
    if (spellIndex < 0) {
      this.clearAutocastSelection(player, 'manual-disable');
      this.magicDebug(player, 'setAutocast-disabled', { spellIndex });
      return;
    }
    if (!this.isAutocastableSpellIndex(spellIndex)) {
      this.magicDebug(player, 'setAutocast-reject-invalid', { spellIndex });
      this.sendMagicState(player);
      return;
    }
    player.autocastSpellIndex = spellIndex;
    this.persistMagicCombatState(player);
    this.sendMagicState(player);
    this.syncPlayerActiveCombatIntent(player);
    this.magicDebug(player, 'setAutocast-enabled', { spellIndex, spell: this.data.getSpellByIndex(spellIndex)?.name });
  }

  handlePlayerSetAutoRetaliate(playerId: number, enabled: boolean): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.isInterfaceOpen()) {
      this.sendAutoRetaliateState(player);
      return;
    }
    player.autoRetaliate = enabled;
    this.persistAutoRetaliate(player);
    this.sendAutoRetaliateState(player);
  }

  private throttleFailedAutocast(player: Player, spellIndex: number, keepCombatTarget: boolean): void {
    if (!keepCombatTarget || player.autocastSpellIndex !== spellIndex) return;
    this.armPlayerAttackCooldown(player, Math.max(player.attackCooldown, 4));
  }

  private clearInvalidAutocast(player: Player, spellIndex: number): void {
    if (player.autocastSpellIndex !== spellIndex) return;
    this.clearAutocastSelection(player, 'invalid-selected-spell');
  }

  private continueAutocastCombat(player: Player, npc: Npc, castDef: SpellEffectDef): void {
    if (castDef.continueByAutocast === false || player.autocastSpellIndex < 0) {
      this.magicDebug(player, 'continueAutocast-skip', {
        npcId: npc.id,
        autocast: player.autocastSpellIndex,
        continueByAutocast: castDef.continueByAutocast,
      });
      return;
    }
    const autocastDef = this.data.getSpellByIndex(player.autocastSpellIndex);
    if (!autocastDef || !isAutocastableSpell(autocastDef)) {
      this.magicDebug(player, 'continueAutocast-invalid-selected-spell', { npcId: npc.id, autocast: player.autocastSpellIndex });
      this.clearInvalidAutocast(player, player.autocastSpellIndex);
      return;
    }
    player.attackTarget = npc;
    if (this.playerCombatTargets.get(player.id) !== npc.id) this.setCombatTarget(player.id, npc.id);
    this.magicDebug(player, 'continueAutocast-armed', { npcId: npc.id, autocast: player.autocastSpellIndex });
  }

  private prepareMagicCast(player: Player, spellIndex: number, keepCombatTarget: boolean): MagicCastPreparation | null {
    const def = this.data.getSpellByIndex(spellIndex);
    if (!def) {
      this.clearInvalidAutocast(player, spellIndex);
      return null;
    }
    if (keepCombatTarget && !isAutocastableSpell(def)) {
      this.clearInvalidAutocast(player, spellIndex);
      return null;
    }

    const xpSkill: SkillId = spellSchoolSkill(def);
    const requiredLevel = def.levelRequired ?? 1;
    if (player.skills[xpSkill].level < requiredLevel) {
      this.magicDebug(player, 'prepareMagic-level-failed', {
        spellIndex,
        spell: def.name,
        skill: xpSkill,
        level: player.skills[xpSkill].level,
        currentLevel: player.skills[xpSkill].currentLevel,
        xp: player.skills[xpSkill].xp,
        requiredLevel,
        keepCombatTarget,
      });
      this.sendChatSystem(player, `You need level ${requiredLevel} ${SKILL_NAMES[xpSkill] ?? 'magic'} to cast ${def.name}.`);
      this.throttleFailedAutocast(player, spellIndex, keepCombatTarget);
      return null;
    }

    const costResult = consumeSpellCosts(player, def, this.data.itemDefs);
    if (!costResult.ok) {
      this.magicDebug(player, 'prepareMagic-cost-failed', {
        spellIndex,
        spell: def.name,
        message: costResult.message,
        keepCombatTarget,
      });
      if (costResult.message) this.sendChatSystem(player, costResult.message);
      this.throttleFailedAutocast(player, spellIndex, keepCombatTarget);
      return null;
    }
    if (costResult.inventoryChanged) this.sendInventory(player);

    return {
      def,
      xpSkill,
      magicLevel: player.skills[xpSkill].currentLevel,
      spellIndex,
    };
  }

  /**
   * Cast a spell at an NPC. Damage rolls now, applies on the impact tick
   * (cast duration + projectile travel time) so the hit splat lands when the
   * visual does. The cast is broadcast immediately so all nearby clients can
   * start playing the animation + effect.
   *
   * PvP is intentionally off — only NPC targets accepted for now.
   * Combat formula is a placeholder; Phase 5 will swap in magic level + tier.
   */
  handlePlayerCastSpell(playerId: number, spellIndex: number, targetEntityId: number, keepCombatTarget: boolean = false): void {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    if (player.isInterfaceOpen()) {
      this.magicDebug(player, 'castSpell-reject-interface', { spellIndex, targetEntityId, keepCombatTarget, openInterface: player.openInterface });
      return;
    }
    if (!keepCombatTarget && player.isBusy(this.currentTick)) {
      this.magicDebug(player, 'castSpell-reject-busy', { spellIndex, targetEntityId, keepCombatTarget });
      return;
    }

    const def = this.data.getSpellByIndex(spellIndex);
    if (!def) {
      this.magicDebug(player, 'castSpell-reject-missing-def', { spellIndex, targetEntityId, keepCombatTarget });
      return;
    }

    const npc = this.npcs.get(targetEntityId);
    if (!npc || npc.dead) {
      this.magicDebug(player, 'castSpell-reject-missing-npc', { spellIndex, targetEntityId, keepCombatTarget, dead: npc?.dead });
      return;
    }
    if (this.data.getShop(npc.npcId)) {
      this.magicDebug(player, 'castSpell-reject-shop', { spellIndex, targetEntityId, keepCombatTarget, npcDefId: npc.npcId });
      return;
    }
    if (!this.canPlayerTargetNpc(player, npc)) {
      this.magicDebug(player, 'castSpell-reject-target-gate', {
        spellIndex,
        targetEntityId,
        keepCombatTarget,
        playerMap: player.currentMapLevel,
        npcMap: npc.currentMapLevel,
        playerFloor: player.currentFloor,
        npcFloor: npc.currentFloor,
      });
      return;
    }
    if (!this.canPlayerEngageNpcCombat(player, npc)) {
      this.magicDebug(player, 'castSpell-reject-combat-lock', { spellIndex, targetEntityId, keepCombatTarget });
      if (keepCombatTarget) this.clearCombatTarget(playerId);
      return;
    }
    if (!keepCombatTarget && player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(targetEntityId)) {
      this.magicDebug(player, 'castSpell-reject-unseen', { spellIndex, targetEntityId, keepCombatTarget, visibleCount: player.visibleEntityIds.size });
      return;
    }

    if (!keepCombatTarget) this.interruptPlayerAction(playerId, player);
    player.clearMoveQueue();
    player.followTargetPlayerId = -1;
    if (player.attackCooldown > 0) {
      this.magicDebug(player, 'castSpell-defer-cooldown', { spellIndex, targetEntityId, keepCombatTarget, cooldown: player.attackCooldown });
      if (!keepCombatTarget && this.playerCombatTargets.has(playerId)) {
        player.pendingSpellCast = { spellIndex, targetEntityId, actionRevision: player.actionRevision };
        this.markQueuedAction(player);
        this.clearCombatTarget(playerId);
      }
      return;
    }

    const fp = npc.distToFootprint(player.position.x, player.position.y);
    const dist = Math.sqrt(fp.dx * fp.dx + fp.dz * fp.dz);
    const rangeDist = Math.max(Math.abs(fp.dx), Math.abs(fp.dz));
    if (!isPointInNpcMagicAttackRange(npc, player.position.x, player.position.y)) {
      this.magicDebug(player, 'castSpell-defer-range', { spellIndex, targetEntityId, keepCombatTarget, dist: rangeDist, max: MAGIC_ATTACK_DISTANCE });
      if (!player.hasMoveQueue()) this.queuePlayerPathToNpcRange(player, npc, MAGIC_ATTACK_DISTANCE, MAGIC_ATTACK_RANGE_MODE);
      if (player.hasMoveQueue()) {
        player.pendingSpellCast = { spellIndex, targetEntityId, actionRevision: player.actionRevision };
        this.markQueuedAction(player);
      }
      return;
    }

    this.cancelSkilling(playerId);
    this.cancelItemProduction(playerId);
    if (!keepCombatTarget) this.clearCombatTarget(playerId);   // single-cast cancels auto-attack

    const cast = this.prepareMagicCast(player, spellIndex, keepCombatTarget);
    if (!cast) {
      this.magicDebug(player, 'castSpell-prepare-failed', { spellIndex, targetEntityId, keepCombatTarget });
      return;
    }
    const damage = rollPlayerMagicDamageAgainstNpc(player, npc, this.data.itemDefs, cast.magicLevel, cast.def.tier, player.magicStance, () => this.combatRng());

    // Total wall time before damage applies — matches client visual length.
    const travelMs = cast.def.trajectory.speed > 0 ? (dist / cast.def.trajectory.speed) * 1000 : 600;
    const totalDelayMs = cast.def.cast.durationMs + travelMs;
    const totalDelayTicks = Math.max(1, Math.round(totalDelayMs / TICK_RATE));

    // Lock other actions for the cast window; block recasts until impact.
    // Recast cooldown is fixed (not distance-scaled) so pacing stays
    // consistent regardless of how far the target is.
    const castTicks = Math.max(1, Math.ceil(cast.def.cast.durationMs / TICK_RATE));

    player.setDelay(this.currentTick, castTicks + 1);
    this.armPlayerAttackCooldown(player, MAGIC_ATTACK_COOLDOWN_TICKS);
    this.refreshPlayerNpcCombatLock(player, npc);
    this.magicDebug(player, 'castSpell-fired', {
      spellIndex,
      spell: cast.def.name,
      targetEntityId,
      keepCombatTarget,
      damage,
      dist,
      cooldown: player.attackCooldown,
      level: player.skills[cast.xpSkill].level,
      currentLevel: player.skills[cast.xpSkill].currentLevel,
      xp: player.skills[cast.xpSkill].xp,
    });

    // SPELL_CAST carries the projectile/effect definition. Also send the
    // generic animation event so character cast animation survives cases where
    // the client cannot resolve the spell catalogue or target in time.
    this.broadcastPlayerAnimationEvent(
      player,
      PlayerAnimationKind.Skill,
      PlayerSkillAnimationVariant.Magic,
      npc.id,
      true,
    );

    this.broadcastNearbyOnFloor(
      player.currentMapLevel, player.currentFloor, player.position.x, player.position.y,
      ServerOpcode.SPELL_CAST, player.id, npc.id, spellIndex,
    );

    this.enqueuePendingSpellImpact({
      impactTick: this.currentTick + totalDelayTicks,
      attackerId: player.id,
      targetId: npc.id,
      damage,
      spellId: cast.def.id,
      xpSkill: cast.xpSkill,
      magicStance: player.magicStance,
      mapLevel: player.currentMapLevel,
      floor: player.currentFloor,
    });

    this.continueAutocastCombat(player, npc, cast.def);
  }

  handleSetAppearance(playerId: number, appearance: PlayerAppearance): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (!player.appearanceEditorOpen && player.appearance !== null) return;
    if (!isValidAppearance(appearance)) return;

    player.appearance = appearance;
    player.appearanceEditorOpen = false;
    this.db.saveAppearance(player.accountId, appearance);
    console.log(`[World] Player "${player.name}" set appearance: shirt=${appearance.shirtColor} pants=${appearance.pantsColor} shoes=${appearance.shoesColor} hair=${appearance.hairColor}`);

    // Mark dirty so the updated appearance broadcasts to nearby players
    player.syncDirty = true;
  }

  handleAppearanceClose(playerId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (!player.appearanceEditorOpen) return;
    // First-login character creation is mandatory; only in-game edits can be
    // dismissed without saving a new appearance.
    if (player.appearance === null) return;
    player.appearanceEditorOpen = false;
  }

  // ==========================================================================
  // BANK
  // ==========================================================================
  // The bank is a 200-slot per-account container. Every slot stacks (a slot
  // can hold any quantity of one itemId). Two operations are atomic:
  //   - Deposit: remove from inventory → add to bank, rolls back on failure.
  //   - Withdraw: remove from bank → add to inventory, rolls back on failure.
  // Quantity = -1 → "all" (whole inventory stack on deposit, whole bank stack
  // on withdraw). For non-stackable items in inventory, deposit collapses
  // every matching slot into the same bank stack.
  //
  // The interface lock (player.openInterface = 'bank') gates every
  // state-mutating handler, so a click leaking from the inventory panel can't
  // dupe via deposit-while-trading or similar.

  /** Emit fake XP_GAIN packets for client-side popup testing without mutating skills. */
  simulateBigXpDrop(player: Player): number {
    const simulatedDrops: Array<{ skillId: SkillId; amount: number }> = [
      { skillId: 'strength', amount: 80 },
      { skillId: 'hitpoints', amount: 44 },
    ];
    let total = 0;
    for (const drop of simulatedDrops) {
      const skillIdx = ALL_SKILLS.indexOf(drop.skillId);
      if (skillIdx < 0) continue;
      this.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, drop.amount);
      total += drop.amount;
    }
    return total;
  }

  /**
   * Award XP to a single skill on a player. Handles the full payload the
   * combat / skilling paths emit: XP_GAIN packet, optional LEVEL_UP, full
   * skill resync, plus the auto-HP-level-up for combat skills (addXp routes
   * 1/3 of combat XP to hitpoints, so HP can level up too).
   *
   * Used by admin chat commands (`/xp`) and any future scripted reward path.
   */
  grantXp(player: Player, skillId: SkillId, amount: number): void {
    if (amount <= 0) return;
    const oldHpLevel = player.skills.hitpoints.level;
    const r = addXp(player.skills, skillId, amount);
    const skillIdx = ALL_SKILLS.indexOf(skillId);
    if (skillIdx >= 0) {
      this.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, Math.floor(amount));
      if (r.leveled) this.sendLevelUp(player, skillIdx, r.newLevel);
      this.sendSingleSkill(player, skillIdx);
    }
    const hpIdx = ALL_SKILLS.indexOf('hitpoints');
    if (hpIdx >= 0 && player.skills.hitpoints.level > oldHpLevel) {
      this.sendLevelUp(player, hpIdx, player.skills.hitpoints.level);
      this.sendSingleSkill(player, hpIdx);
      player.syncHealthFromSkills();
    }
  }

  maxPlayerStats(player: Player): void {
    const maxXp = xpForLevel(99);
    for (const skillId of ALL_SKILLS) {
      const skill = player.skills[skillId];
      skill.xp = maxXp;
      skill.level = 99;
      skill.currentLevel = 99;
    }
    player.syncHealthFromSkills();
    player.syncDirty = true;
    this.sendSkills(player);
    this.savePlayerState(player);
  }

  private sendLevelUp(player: Player, skillIndex: number, newLevel: number): void {
    if (skillIndex < 0 || skillIndex >= ALL_SKILLS.length) return;
    this.sendToPlayer(player, ServerOpcode.LEVEL_UP, skillIndex, newLevel);
    this.broadcastLevelUpEffect(player, skillIndex, newLevel);
  }

  triggerLevelUpEffect(player: Player): void {
    const skillIndex = Math.max(0, ALL_SKILLS.indexOf('hitpoints'));
    const skillId = ALL_SKILLS[skillIndex];
    const newLevel = skillId ? player.skills[skillId].level : 1;
    this.broadcastLevelUpEffect(player, skillIndex, newLevel);
  }

  private broadcastLevelUpEffect(player: Player, skillIndex: number, newLevel: number): void {
    if (skillIndex < 0 || skillIndex >= ALL_SKILLS.length) return;
    this.broadcastNearbyOnFloor(
      player.currentMapLevel,
      player.currentFloor,
      player.position.x,
      player.position.y,
      ServerOpcode.LEVEL_UP_EFFECT,
      player.id,
      skillIndex,
      newLevel,
    );
  }

  private sendCombatXp(player: Player, result: Pick<PlayerNpcCombatResult, 'xpDrops' | 'levelUps'>): void {
    for (const xp of result.xpDrops) {
      const skillIdx = ALL_SKILLS.indexOf(xp.skill);
      if (skillIdx >= 0) {
        this.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, xp.amount);
      }
    }

    for (const lu of result.levelUps) {
      const skillIdx = ALL_SKILLS.indexOf(lu.skill);
      if (skillIdx >= 0) {
        this.sendLevelUp(player, skillIdx, lu.level);
      }
    }

    const synced = new Set<SkillId>();
    for (const xp of result.xpDrops) {
      if (synced.has(xp.skill)) continue;
      synced.add(xp.skill);
      const skillIdx = ALL_SKILLS.indexOf(xp.skill);
      if (skillIdx >= 0) this.sendSingleSkill(player, skillIdx);
    }
  }

  startQuestForAdmin(player: Player, questId: string): boolean {
    return this.quests.setPlayerQuestStage(player, questId, 0);
  }

  resetQuestForAdmin(player: Player, questId: string): boolean {
    return this.quests.resetPlayerQuest(player, questId);
  }

  /** Server-side entry point: open the character creator for a player. Called
   *  from the login path (no appearance set yet), the openAppearance dialogue
   *  action, and the /appearance admin chat command. */
  openCharacterCreatorFor(player: Player): void {
    player.appearanceEditorOpen = true;
    this.sendToPlayer(player, ServerOpcode.SHOW_CHARACTER_CREATOR, player.appearance ? 1 : 0);
  }

  /** Server-side entry point: open the bank for a player. Called from the
   *  banker NPC interaction path AND from the /bank admin chat command. */
  openBankFor(player: Player): void {
    if (player.isInterfaceOpen()) return;
    player.openInterface = 'bank';
    this.sendBankFull(player);
  }

  /** Admin-only client UI preview. This deliberately does not set
   *  openInterface or create a TradeSession, so it cannot move items. */
  openTestTradeFor(player: Player): void {
    this.sendToPlayer(player, ServerOpcode.TRADE_TEST_OPEN, 0);
  }

  handleBankOpenRequest(playerId: number): void {
    // Currently unused — the client doesn't open the bank unilaterally; either
    // the banker NPC or /bank admin command opens it server-side. Kept for
    // future "use bank chest" object interactions which would call openBankFor.
    const player = this.players.get(playerId);
    if (!player) return;
    // No-op for now; no action without an explicit server-side trigger.
  }

  handleBankClose(playerId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.openInterface !== 'bank') return;
    player.openInterface = null;
    this.sendToPlayer(player, ServerOpcode.BANK_CLOSE, 0);
  }

  /** Send the full bank state to the client. Sparse — only filled slots. */
  private sendBankFull(player: Player): void {
    const filled: Array<{ slot: number; itemId: number; quantity: number }> = [];
    for (let i = 0; i < player.bank.length; i++) {
      const s = player.bank[i];
      if (s) filled.push({ slot: i, itemId: s.itemId, quantity: s.quantity });
    }
    // Layout: [count, slot1, itemId1, qtyHigh1, qtyLow1, ...]
    const values: number[] = [filled.length];
    for (const f of filled) {
      values.push(f.slot, f.itemId, (f.quantity >>> 16) & 0xFFFF, f.quantity & 0xFFFF);
    }
    this.sendToPlayer(player, ServerOpcode.BANK_OPEN, ...values);
  }

  /** Push a single slot update to the client (after deposit/withdraw). */
  private sendBankSlot(player: Player, slot: number): void {
    const s = player.bank[slot];
    const itemId = s?.itemId ?? 0;
    const qty = s?.quantity ?? 0;
    this.sendToPlayer(
      player,
      ServerOpcode.BANK_UPDATE_SLOT,
      slot, itemId, (qty >>> 16) & 0xFFFF, qty & 0xFFFF,
    );
  }

  /** Find the bank slot holding `itemId`, or the first empty slot. Returns -1 if
   *  full and no existing stack. Bank is fully stackable so identical items
   *  always merge. */
  private findBankSlot(player: Player, itemId: number): number {
    let firstEmpty = -1;
    for (let i = 0; i < player.bank.length; i++) {
      const s = player.bank[i];
      if (s && s.itemId === itemId) return i;
      if (firstEmpty < 0 && s === null) firstEmpty = i;
    }
    return firstEmpty;
  }

  handleBankDeposit(playerId: number, slotIndex: number, expectedItemId: number, quantity: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.openInterface !== 'bank') return;
    if (slotIndex < 0 || slotIndex >= player.inventory.length) return;
    const invSlot = player.inventory[slotIndex];
    if (!invSlot || invSlot.itemId !== expectedItemId) return;

    // Resolve "all": for stackables, the whole slot. For non-stackables,
    // deposit every matching slot into one bank stack.
    const itemId = invSlot.itemId;
    const itemDef = this.data.getItem(itemId);
    if (!itemDef) return;
    const isStackable = itemDef.stackable === true;

    const wantAll = quantity === -1;
    let toDeposit: number;
    if (isStackable) {
      toDeposit = wantAll ? invSlot.quantity : Math.min(quantity, invSlot.quantity);
    } else {
      // For non-stackable items, "all" sweeps every matching slot. Otherwise
      // we cap at the requested count or however many of the item exist.
      let total = 0;
      for (const s of player.inventory) if (s?.itemId === itemId) total += 1;
      toDeposit = wantAll ? total : Math.min(quantity, total);
    }
    if (toDeposit <= 0) return;

    const bankSlot = this.findBankSlot(player, itemId);
    if (bankSlot < 0) {
      this.sendChatSystem(player, 'Your bank is full.');
      return;
    }

    // Capacity check on the bank slot — int32 cap (matches our int32-encoded
    // BANK_OPEN packet). In practice we'll never hit this for non-coin items.
    const existingQty = player.bank[bankSlot]?.quantity ?? 0;
    if (existingQty + toDeposit > 0x7FFFFFFF) {
      this.sendChatSystem(player, 'Bank slot would overflow.');
      return;
    }

    // Atomic per-op: remove from inventory first; if bank-add fails, roll back.
    if (isStackable) {
      const removed = player.removeItem(slotIndex, toDeposit);
      if (removed.completed !== toDeposit) { player.revertRemove(removed); return; }
      this.bankAdd(player, bankSlot, itemId, toDeposit);
    } else {
      // Non-stackable sweep — remove from each matching slot until quota met.
      let remaining = toDeposit;
      const reverts: { slot: number; itemId: number; quantity: number; emptied: boolean }[] = [];
      for (let i = 0; i < player.inventory.length && remaining > 0; i++) {
        const s = player.inventory[i];
        if (!s || s.itemId !== itemId) continue;
        const r = player.removeItem(i, 1);
        if (r.completed !== 1) {
          // Roll back any partial removes
          for (const rev of reverts) player.inventory[rev.slot] = { itemId: rev.itemId, quantity: rev.quantity };
          return;
        }
        reverts.push(r.removed[0]);
        remaining--;
      }
      this.bankAdd(player, bankSlot, itemId, toDeposit);
    }

    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
    this.sendBankSlot(player, bankSlot);
  }

  /** Helper: increment bank slot quantity, creating it if empty. */
  private bankAdd(player: Player, bankSlot: number, itemId: number, qty: number): void {
    const existing = player.bank[bankSlot];
    if (existing) {
      existing.quantity += qty;
    } else {
      player.bank[bankSlot] = { itemId, quantity: qty };
    }
  }

  handleBankWithdraw(playerId: number, bankSlot: number, expectedItemId: number, quantity: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.openInterface !== 'bank') return;
    if (bankSlot < 0 || bankSlot >= player.bank.length) return;
    const slot = player.bank[bankSlot];
    if (!slot || slot.itemId !== expectedItemId) return;

    const itemId = slot.itemId;
    const itemDef = this.data.getItem(itemId);
    if (!itemDef) return;
    const isStackable = itemDef.stackable === true;

    const wantAll = quantity === -1;
    let toWithdraw = wantAll ? slot.quantity : Math.min(quantity, slot.quantity);
    if (toWithdraw <= 0) return;

    // Inventory capacity: stackable needs 0 or 1 slot; non-stackable needs N.
    if (isStackable) {
      if (!player.canFit(itemId, toWithdraw, this.data.itemDefs)) {
        this.sendChatSystem(player, 'Not enough inventory space.');
        return;
      }
    } else {
      // Cap by free slots — partial-fill on withdraw is allowed (RS2 behavior).
      let freeSlots = 0;
      for (const s of player.inventory) if (s === null) freeSlots++;
      toWithdraw = Math.min(toWithdraw, freeSlots);
      if (toWithdraw <= 0) {
        this.sendChatSystem(player, 'Not enough inventory space.');
        return;
      }
    }

    // Atomic: decrement bank slot, then add to inventory. Roll back on failure.
    slot.quantity -= toWithdraw;
    if (slot.quantity <= 0) player.bank[bankSlot] = null;

    const addResult = player.addItem(itemId, toWithdraw, this.data.itemDefs, { assureFullInsertion: !!isStackable });
    if (addResult.completed !== toWithdraw) {
      // Add what wasn't placed back in the bank.
      const shortfall = toWithdraw - addResult.completed;
      if (shortfall > 0) {
        if (player.bank[bankSlot]) {
          player.bank[bankSlot]!.quantity += shortfall;
        } else {
          player.bank[bankSlot] = { itemId, quantity: shortfall };
        }
      }
    }

    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
    this.sendBankSlot(player, bankSlot);
  }

  /** Drag-and-drop reorder of two bank slots. Pure swap; stack merging remains
   *  deposit-only so layout edits cannot accidentally combine bank stacks. */
  handleBankMoveItem(playerId: number, fromSlot: number, toSlot: number, expectedItemId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.openInterface !== 'bank') return;
    if (fromSlot === toSlot) return;
    if (fromSlot < 0 || fromSlot >= player.bank.length) return;
    if (toSlot < 0 || toSlot >= player.bank.length) return;
    if (player.bank[fromSlot]?.itemId !== expectedItemId) return;

    const a = player.bank[fromSlot];
    const b = player.bank[toSlot];
    player.bank[fromSlot] = b;
    player.bank[toSlot] = a;

    this.sendBankSlot(player, fromSlot);
    this.sendBankSlot(player, toSlot);
  }

  handleAdminDeleteBankItem(playerId: number, bankSlot: number, expectedItemId: number): void {
    const player = this.players.get(playerId);
    if (!player || !player.isAdmin) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.openInterface !== 'bank') return;
    if (bankSlot < 0 || bankSlot >= player.bank.length) return;
    const slot = player.bank[bankSlot];
    if (!slot || slot.itemId !== expectedItemId) return;

    player.bank[bankSlot] = null;
    player.setDelay(this.currentTick, 1);
    this.sendBankSlot(player, bankSlot);
    const itemName = this.itemEventName(slot.itemId);
    this.recordGameEvent({
      type: 'admin',
      severity: 'warning',
      message: `${player.name} deleted ${slot.quantity} x ${itemName} from bank`,
      actorAccountId: player.accountId,
      actorName: player.name,
      itemId: slot.itemId,
      itemName,
      quantity: slot.quantity,
      mapLevel: player.currentMapLevel,
      floor: player.currentFloor,
      x: player.position.x,
      z: player.position.y,
      details: {
        action: 'delete_item',
        container: 'bank',
        slot: bankSlot,
        expectedItemId,
      },
    });
  }

  // ==========================================================================
  // TRADE
  // ==========================================================================
  // Two-stage confirm FSM (mirrors 2004scape):
  //   stage 0 — open / editing offers
  //   stage 1 — both pressed Accept once → offers locked, "are you sure?" view
  //   stage 2 — both pressed Accept again → atomic commit
  // Any modification (offer/remove) by either side resets BOTH sides' stage
  // back to 0. This is the entire defense against the "switcheroo" dupe.
  // Disconnect, movement, attack, or any other interface-open event aborts.

  private tradeSessions: Map<number, TradeSession> = new Map();

  private isTradeablePlayer(player: Player): boolean {
    return player.alive && !player.disconnected && !player.requestIdleLogout;
  }

  private canPlayersTrade(a: Player, b: Player, reporter?: Player): boolean {
    if (a.id === b.id) return false;
    if (!this.isTradeablePlayer(a) || !this.isTradeablePlayer(b)) {
      if (reporter === a) this.sendChatSystem(a, 'That player is not available to trade.');
      return false;
    }
    if (a.currentMapLevel !== b.currentMapLevel) {
      if (reporter === a) this.sendChatSystem(a, 'That player is too far away to trade.');
      return false;
    }
    // Floor check is required even with same x,z map check — multi-floor
    // buildings let two players overlap in 2D while being on different planes,
    // and a through-floor trade lets gear teleport up/down a building.
    if (a.currentFloor !== b.currentFloor) {
      if (reporter === a) this.sendChatSystem(a, 'You need to be on the same floor to trade.');
      return false;
    }
    if (this.tileChebyshev(a, b) > TRADE_REQUEST_RANGE) {
      if (reporter === a) this.sendChatSystem(a, 'That player is too far away to trade.');
      return false;
    }
    if (!this.canPlayerReachPlayer(a, b, TRADE_REQUEST_RANGE)) {
      if (reporter === a) this.sendChatSystem(a, 'That player is too far away to trade.');
      return false;
    }
    return true;
  }

  private clearTradeRequestsFor(playerId: number): void {
    this.pendingTradeRequests.delete(playerId);
    for (const [requester, target] of this.pendingTradeRequests) {
      if (target === playerId) this.pendingTradeRequests.delete(requester);
    }
  }

  private validateTradeSession(session: TradeSession): { aPlayer: Player; bPlayer: Player } | null {
    const aPlayer = this.players.get(session.a.id);
    const bPlayer = this.players.get(session.b.id);
    if (
      !aPlayer || !bPlayer
      || aPlayer.openInterface !== 'trade'
      || bPlayer.openInterface !== 'trade'
      || !this.canPlayersTrade(aPlayer, bPlayer)
    ) {
      this.abortTrade(session.a.id, 2);
      return null;
    }
    return { aPlayer, bPlayer };
  }

  private normalizeTradeQuantity(quantity: number, available: number): number | null {
    if (!Number.isSafeInteger(available) || available <= 0) return null;
    if (quantity === -1) return Math.min(available, MAX_STACK);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) return null;
    return Math.min(quantity, available, MAX_STACK);
  }

  handleTradeRequest(playerId: number, targetEntityId: number): void {
    const player = this.players.get(playerId);
    const target = this.players.get(targetEntityId);
    if (!player || !target || player.id === target.id) return;
    if (player.isInterfaceOpen()) return;
    if (target.isInterfaceOpen()) {
      this.sendChatSystem(player, 'That player is busy.');
      return;
    }
    if (!this.canPlayersTrade(player, target, player)) return;
    player.botStats?.recordActionSignature('tradeRequest', 'player', player.position.x, player.position.y);

    // If the target has already requested us, opening from either side commits
    // the session (same-tick mutual request).
    const reverse = this.pendingTradeRequests.get(target.id);
    if (reverse === player.id) {
      this.openTradeSession(player, target);
      return;
    }
    this.pendingTradeRequests.set(player.id, target.id);
    // Short request lifetime so stale requests don't pile up.
    setTimeout(() => {
      if (this.pendingTradeRequests.get(player.id) === target.id) {
        this.pendingTradeRequests.delete(player.id);
      }
    }, TRADE_REQUEST_TTL_MS);
    // Notify the target so their client can show the popup.
    this.sendToPlayer(target, ServerOpcode.TRADE_REQUEST_RECEIVED, player.id);
    this.sendChatSystem(player, `Sending trade request to ${target.name}...`);
  }

  /** Map of pending one-sided trade requests: requester → target. */
  private pendingTradeRequests: Map<number, number> = new Map();

  handleTradeAcceptRequest(playerId: number, requesterEntityId: number): void {
    const player = this.players.get(playerId);
    const requester = this.players.get(requesterEntityId);
    if (!player || !requester) return;
    if (player.isInterfaceOpen()) return;
    if (requester.isInterfaceOpen()) {
      this.sendChatSystem(player, 'That player is busy.');
      this.clearTradeRequestsFor(requester.id);
      return;
    }
    if (this.pendingTradeRequests.get(requester.id) !== player.id) {
      this.sendChatSystem(player, 'That trade request has expired.');
      return;
    }
    if (!this.canPlayersTrade(player, requester, player)) return;
    this.openTradeSession(requester, player);
  }

  private openTradeSession(a: Player, b: Player): void {
    if (!this.canPlayersTrade(a, b)) return;
    this.clearTradeRequestsFor(a.id);
    this.clearTradeRequestsFor(b.id);
    const session: TradeSession = {
      a: { id: a.id, offer: new Array(TRADE_OFFER_SIZE).fill(null), stage: 0 },
      b: { id: b.id, offer: new Array(TRADE_OFFER_SIZE).fill(null), stage: 0 },
    };
    this.tradeSessions.set(a.id, session);
    this.tradeSessions.set(b.id, session);
    a.openInterface = 'trade';
    b.openInterface = 'trade';
    // Shops are non-modal but conceptually exclusive with trade — clear any
    // open shop scope so a player can't trade-confirm and shop-sell on the
    // same tick. Shop close UI on the client is incidental; the server-side
    // openShopNpcId/openShopNpcEntityId are what gate buy/sell handlers.
    this.closeShopForPlayer(a);
    this.closeShopForPlayer(b);
    if (a.openDialogueState) this.sendDialogueClose(a);
    if (b.openDialogueState) this.sendDialogueClose(b);
    this.sendToPlayer(a, ServerOpcode.TRADE_OPEN, b.id);
    this.sendToPlayer(b, ServerOpcode.TRADE_OPEN, a.id);
    this.sendTradeAcceptState(session);
  }

  /** Look up "this player's side" of a session. Returns null if not in trade. */
  private mySide(session: TradeSession, playerId: number): TradeSide | null {
    if (session.a.id === playerId) return session.a;
    if (session.b.id === playerId) return session.b;
    return null;
  }
  private otherSide(session: TradeSession, playerId: number): TradeSide | null {
    if (session.a.id === playerId) return session.b;
    if (session.b.id === playerId) return session.a;
    return null;
  }

  /** Reset both sides' accept stage back to 0. Called on every offer mutation. */
  private resetTradeStages(session: TradeSession): void {
    session.a.stage = 0;
    session.b.stage = 0;
    this.sendTradeAcceptState(session);
  }

  private sendTradeAcceptState(session: TradeSession): void {
    const a = this.players.get(session.a.id);
    const b = this.players.get(session.b.id);
    if (a) this.sendToPlayer(a, ServerOpcode.TRADE_ACCEPT_STATE, session.a.stage, session.b.stage);
    if (b) this.sendToPlayer(b, ServerOpcode.TRADE_ACCEPT_STATE, session.b.stage, session.a.stage);
  }

  private sendTradeOfferUpdate(session: TradeSession, mutatedSide: 'a' | 'b', slot: number): void {
    const side = mutatedSide === 'a' ? session.a : session.b;
    const s = side.offer[slot];
    const itemId = s?.itemId ?? 0;
    const qty = s?.quantity ?? 0;
    const a = this.players.get(session.a.id);
    const b = this.players.get(session.b.id);
    // From each player's perspective, "side" is 0 if it's their own offer, 1 if the partner's.
    if (a) {
      const sideFlag = mutatedSide === 'a' ? 0 : 1;
      this.sendToPlayer(a, ServerOpcode.TRADE_OFFER_UPDATE, sideFlag, slot, itemId, (qty >>> 16) & 0xFFFF, qty & 0xFFFF);
    }
    if (b) {
      const sideFlag = mutatedSide === 'b' ? 0 : 1;
      this.sendToPlayer(b, ServerOpcode.TRADE_OFFER_UPDATE, sideFlag, slot, itemId, (qty >>> 16) & 0xFFFF, qty & 0xFFFF);
    }
  }

  handleTradeDecline(playerId: number): void {
    this.clearTradeRequestsFor(playerId);
    this.abortTrade(playerId, /*reason*/ 1);
  }

  /** Abort a trade session. Items in offers go back to the owner's inventory.
   *  reason: 0=success, 1=declined, 2=aborted (disconnect/move). */
  abortTrade(playerId: number, reason: number = 2): void {
    const session = this.tradeSessions.get(playerId);
    if (!session) return;
    this.tradeSessions.delete(session.a.id);
    this.tradeSessions.delete(session.b.id);
    this.clearTradeRequestsFor(session.a.id);
    this.clearTradeRequestsFor(session.b.id);

    // Return offered items to each side.
    for (const side of [session.a, session.b] as TradeSide[]) {
      const owner = this.players.get(side.id);
      if (!owner) continue;
      for (const off of side.offer) {
        if (!off) continue;
        // Offered items were taken out of inventory. Put them back. Bank-style
        // overflow protection: if inventory is full (e.g. they equipped/dropped
        // mid-trade — which shouldn't happen with the lock, but defense in
        // depth), we drop excess to the ground at the player's tile.
        const result = owner.addItem(off.itemId, off.quantity, this.data.itemDefs, { assureFullInsertion: false });
        const placed = result.completed;
        if (placed < off.quantity) {
          this.spawnGroundItem(owner, off.itemId, off.quantity - placed);
        }
      }
      owner.openInterface = null;
      this.sendInventory(owner);
      this.sendToPlayer(owner, ServerOpcode.TRADE_CLOSE, reason);
    }
  }

  /** Move items from inventory → my offer. */
  handleTradeOfferItem(playerId: number, slotIndex: number, expectedItemId: number, quantity: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const session = this.tradeSessions.get(playerId);
    if (!session) return;
    if (!this.validateTradeSession(session)) return;
    const me = this.mySide(session, playerId);
    if (!me) return;
    // Offer edits are allowed after either accept stage, but every successful
    // edit resets both sides back to stage 0 before another confirm can happen.
    if (slotIndex < 0 || slotIndex >= player.inventory.length) return;
    const invSlot = player.inventory[slotIndex];
    if (!invSlot || invSlot.itemId !== expectedItemId) return;

    const itemId = invSlot.itemId;
    const itemDef = this.data.getItem(itemId);
    if (!itemDef) return;
    const isStackable = itemDef.stackable === true;

    const available = isStackable
      ? invSlot.quantity
      : player.inventory.reduce((total, s) => total + (s?.itemId === itemId ? 1 : 0), 0);
    const toOffer = this.normalizeTradeQuantity(quantity, available);
    if (toOffer === null) return;

    // Find or create an offer slot for this item (collapsed by itemId — same
    // model as bank slots).
    let offerSlot = me.offer.findIndex(o => o?.itemId === itemId);
    if (offerSlot < 0) offerSlot = me.offer.findIndex(o => o === null);
    if (offerSlot < 0) {
      this.sendChatSystem(player, 'Trade offer is full.');
      return;
    }
    const existing = me.offer[offerSlot];
    if (existing && existing.quantity > MAX_STACK - toOffer) {
      this.sendChatSystem(player, 'You cannot offer that many of one item.');
      return;
    }

    if (isStackable) {
      const removed = player.removeItem(slotIndex, toOffer);
      if (removed.completed !== toOffer) { player.revertRemove(removed); return; }
    } else {
      const removed = player.removeItemById(itemId, toOffer);
      if (removed.completed !== toOffer) { player.revertRemove(removed); return; }
    }

    if (existing) existing.quantity += toOffer;
    else me.offer[offerSlot] = { itemId, quantity: toOffer };

    this.sendInventory(player);
    this.sendTradeOfferUpdate(session, session.a.id === playerId ? 'a' : 'b', offerSlot);
    this.resetTradeStages(session);
  }

  /** Move items from my offer → inventory. */
  handleTradeRemoveOffered(playerId: number, offerSlot: number, expectedItemId: number, quantity: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const session = this.tradeSessions.get(playerId);
    if (!session) return;
    if (!this.validateTradeSession(session)) return;
    const me = this.mySide(session, playerId);
    if (!me) return;
    // Removing from an accepted offer is safe because offered items are already
    // server-custodied and the successful mutation resets both accept stages.
    if (offerSlot < 0 || offerSlot >= me.offer.length) return;
    const off = me.offer[offerSlot];
    if (!off || off.itemId !== expectedItemId) return;

    const toReturn = this.normalizeTradeQuantity(quantity, off.quantity);
    if (toReturn === null) return;

    // Capacity: returning to inventory must fit. If not, refuse — RS2 behavior.
    if (!player.canFit(off.itemId, toReturn, this.data.itemDefs)) {
      this.sendChatSystem(player, 'Not enough inventory space.');
      return;
    }

    const result = player.addItem(off.itemId, toReturn, this.data.itemDefs);
    if (result.completed !== toReturn) {
      player.revertAdd(result);
      return;
    }

    off.quantity -= toReturn;
    if (off.quantity <= 0) me.offer[offerSlot] = null;

    this.sendInventory(player);
    this.sendTradeOfferUpdate(session, session.a.id === playerId ? 'a' : 'b', offerSlot);
    this.resetTradeStages(session);
  }

  handleTradeAccept(playerId: number): void {
    const session = this.tradeSessions.get(playerId);
    if (!session) return;
    if (!this.validateTradeSession(session)) return;
    const me = this.mySide(session, playerId);
    const them = this.otherSide(session, playerId);
    if (!me || !them) return;

    if (me.stage === 0) {
      me.stage = 1;
    } else if (me.stage === 1 && them.stage >= 1) {
      me.stage = 2;
    } else {
      return;
    }
    this.sendTradeAcceptState(session);

    // Both sides at stage 2 → commit.
    if (me.stage === 2 && them.stage === 2) {
      this.commitTrade(session);
    }
  }

  /** Atomic commit. Each side's offered items go to the OTHER side's inventory.
   *  If either side can't fit the incoming items, the trade aborts and items
   *  are returned to the original owners (handled by abortTrade). */
  private commitTrade(session: TradeSession): void {
    const participants = this.validateTradeSession(session);
    if (!participants) return;
    const { aPlayer, bPlayer } = participants;

    // Pre-flight: can A fit B's offer AND can B fit A's offer?
    const aCanFitB = this.canFitOffer(aPlayer, session.b.offer);
    const bCanFitA = this.canFitOffer(bPlayer, session.a.offer);
    if (!aCanFitB || !bCanFitA) {
      this.sendChatSystem(aPlayer, 'Not enough inventory space to complete trade.');
      this.sendChatSystem(bPlayer, 'Not enough inventory space to complete trade.');
      this.abortTrade(session.a.id, 2);
      return;
    }

    // Execute. We track add results so we can roll back if anything goes wrong
    // mid-commit (shouldn't, since pre-flight passed — but defense in depth).
    const aRollbacks: import('./entity/Player').InventoryAddResult[] = [];
    const bRollbacks: import('./entity/Player').InventoryAddResult[] = [];
    for (const off of session.b.offer) {
      if (!off) continue;
      const r = aPlayer.addItem(off.itemId, off.quantity, this.data.itemDefs);
      if (r.completed !== off.quantity) {
        for (const rb of aRollbacks) aPlayer.revertAdd(rb);
        for (const rb of bRollbacks) bPlayer.revertAdd(rb);
        // Pre-flight (canFitOffer) said this would fit but addItem disagreed
        // — almost always a MAX_STACK overflow on an existing 2.1B stack.
        // This is exactly the dupe surface to surveil for.
        audit({
          type: 'trade.commit_failed',
          tick: this.currentTick,
          accountId: aPlayer.accountId,
          details: {
            reason: 'addItem_partial_a',
            requested: off.quantity, completed: r.completed,
            itemId: off.itemId,
            a: aPlayer.name, b: bPlayer.name,
          },
        });
        this.abortTrade(session.a.id, 2);
        return;
      }
      aRollbacks.push(r);
    }
    for (const off of session.a.offer) {
      if (!off) continue;
      const r = bPlayer.addItem(off.itemId, off.quantity, this.data.itemDefs);
      if (r.completed !== off.quantity) {
        for (const rb of aRollbacks) aPlayer.revertAdd(rb);
        for (const rb of bRollbacks) bPlayer.revertAdd(rb);
        audit({
          type: 'trade.commit_failed',
          tick: this.currentTick,
          accountId: bPlayer.accountId,
          details: {
            reason: 'addItem_partial_b',
            requested: off.quantity, completed: r.completed,
            itemId: off.itemId,
            a: aPlayer.name, b: bPlayer.name,
          },
        });
        this.abortTrade(session.a.id, 2);
        return;
      }
      bRollbacks.push(r);
    }

    // Items already removed from sender inventories at offer time. Commit done.
    this.tradeSessions.delete(session.a.id);
    this.tradeSessions.delete(session.b.id);
    this.clearTradeRequestsFor(session.a.id);
    this.clearTradeRequestsFor(session.b.id);
    aPlayer.openInterface = null;
    bPlayer.openInterface = null;
    this.sendInventory(aPlayer);
    this.sendInventory(bPlayer);
    this.sendToPlayer(aPlayer, ServerOpcode.TRADE_CLOSE, 0);
    this.sendToPlayer(bPlayer, ServerOpcode.TRADE_CLOSE, 0);
    const aOffered = this.itemEventStacks(session.a.offer);
    const bOffered = this.itemEventStacks(session.b.offer);
    this.recordGameEvent({
      type: 'trade',
      severity: 'notable',
      message: `${aPlayer.name} traded with ${bPlayer.name}: ${aPlayer.name} gave ${this.itemEventSummary(aOffered)}; ${bPlayer.name} gave ${this.itemEventSummary(bOffered)}`,
      actorAccountId: aPlayer.accountId,
      actorName: aPlayer.name,
      targetAccountId: bPlayer.accountId,
      targetName: bPlayer.name,
      mapLevel: aPlayer.currentMapLevel,
      floor: aPlayer.currentFloor,
      x: aPlayer.position.x,
      z: aPlayer.position.y,
      details: {
        a: { accountId: aPlayer.accountId, name: aPlayer.name, offered: aOffered },
        b: { accountId: bPlayer.accountId, name: bPlayer.name, offered: bOffered },
      },
    });
    // Forensic record. If a dupe is ever reported, this is the trail. Include
    // both sides' offers verbatim so the exact transfer can be reconstructed.
    audit({
      type: 'trade.commit',
      tick: this.currentTick,
      accountId: aPlayer.accountId,
      details: {
        a: { accountId: aPlayer.accountId, name: aPlayer.name, offered: session.a.offer.filter(o => o !== null) },
        b: { accountId: bPlayer.accountId, name: bPlayer.name, offered: session.b.offer.filter(o => o !== null) },
      },
    });
    console.log(`[trade] ${aPlayer.name} ↔ ${bPlayer.name} committed`);
  }

  /** Can `player` fit every item in `offer` into their inventory (after their
   *  own offer's items have already been removed at offer-time)?
   *  Pre-flight must also reject MAX_STACK overflow: if A has 2.0B coins and
   *  B offers 500M, the merge would clamp at 2.147B and silently drop the rest.
   *  Without this guard, the commit-time rollback at line ~2124 fires every
   *  time, which works but is the wrong layer to catch a predictable failure. */
  private canFitOffer(player: Player, offer: ({ itemId: number; quantity: number } | null)[]): boolean {
    // Simulate sequentially using a clone of free-slot count. Cheap because
    // canFit only inspects existing items + free count.
    const used: Map<number, number> = new Map();
    let freeSlots = 0;
    for (const s of player.inventory) if (s === null) freeSlots++;
    for (const off of offer) {
      if (!off) continue;
      if (!Number.isSafeInteger(off.quantity) || off.quantity <= 0 || off.quantity > MAX_STACK) return false;
      const def = this.data.getItem(off.itemId);
      if (!def) return false;
      if (def.stackable) {
        const existing = player.inventory.find(s => s?.itemId === off.itemId)?.quantity ?? 0;
        const alreadySimulated = used.get(off.itemId) ?? 0;
        const projected = existing + alreadySimulated + off.quantity;
        if (projected > MAX_STACK) return false;
        const hasStack = existing > 0 || used.has(off.itemId);
        if (hasStack) {
          used.set(off.itemId, alreadySimulated + off.quantity);
          continue;
        }
        if (freeSlots < 1) return false;
        freeSlots--;
        used.set(off.itemId, off.quantity);
      } else {
        if (freeSlots < off.quantity) return false;
        freeSlots -= off.quantity;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Duel system
  // ---------------------------------------------------------------------------

  private duelStakeSessions: Map<number, DuelStakeSession> = new Map();
  private activeDuels: Map<number, ActiveDuel> = new Map();
  /** Pending one-sided duel requests: requester -> target. */
  private pendingDuelRequests: Map<number, number> = new Map();
  private static readonly DUEL_REQUEST_TTL_MS = 10_000;
  private static readonly DUEL_TIMEOUT_TICKS = 500;

  private hasCustodiedItems(playerId: number): boolean {
    return (this.tradeSessions?.has(playerId) ?? false)
      || (this.duelStakeSessions?.has(playerId) ?? false)
      || (this.activeDuels?.has(playerId) ?? false);
  }

  private clearDuelRequestsFor(playerId: number): void {
    this.pendingDuelRequests?.delete(playerId);
    for (const [requester, target] of this.pendingDuelRequests ?? []) {
      if (target === playerId) this.pendingDuelRequests?.delete(requester);
    }
  }

  private isDuelablePlayer(player: Player): boolean {
    return player.alive && !player.disconnected && !player.requestIdleLogout;
  }

  private isPlayerUnderNpcAttack(playerId: number): boolean {
    for (const [, npc] of this.npcs) {
      if (npc.combatTarget?.id === playerId) return true;
    }
    return false;
  }

  private hasPendingSpellImpact(playerId: number): boolean {
    return this.getCombatSystem().listImpacts().some(impact =>
      this.isPendingSpellImpactEntry(impact)
      && impact.source.kind === 'player'
      && impact.source.id === playerId
    );
  }

  private clearPendingSpellImpactsFor(playerId: number): void {
    this.getCombatSystem().removeImpactsWhere(impact =>
      this.isPendingSpellImpactEntry(impact)
      && impact.source.kind === 'player'
      && impact.source.id === playerId
    );
  }

  private isPlayerInCombatForDuel(player: Player): boolean {
    return (this.activeDuels?.has(player.id) ?? false)
      || this.playerCombatTargets.has(player.id)
      || this.isPlayerUnderNpcAttack(player.id)
      || player.isLogoutBlocked(this.currentTick)
      || player.isBusy(this.currentTick)
      || this.hasPendingSpellImpact(player.id);
  }

  private canPlayersDuelRequest(a: Player, b: Player, reporter?: Player): boolean {
    if (a.id === b.id) return false;
    if (!this.isDuelablePlayer(a) || !this.isDuelablePlayer(b)) return false;
    if (a.openInterface !== null || b.openInterface !== null) {
      if (reporter === a) this.sendChatSystem(a, 'That player is busy.');
      return false;
    }
    if (a.currentMapLevel !== b.currentMapLevel || a.currentFloor !== b.currentFloor) {
      if (reporter === a) this.sendChatSystem(a, 'You need to stand next to them to duel.');
      return false;
    }
    if (a.visibleEntityIds.size > 0 && !a.visibleEntityIds.has(b.id)) return false;
    if (b.visibleEntityIds.size > 0 && !b.visibleEntityIds.has(a.id)) return false;
    if (this.tileChebyshev(a, b) > 1) {
      if (reporter === a) this.sendChatSystem(a, 'You need to stand next to them to duel.');
      return false;
    }
    if (!this.canPlayerReachPlayer(a, b, 1)) {
      if (reporter === a) this.sendChatSystem(a, 'You need to stand next to them to duel.');
      return false;
    }
    if (this.isPlayerInCombatForDuel(a)) {
      if (reporter === a) this.sendChatSystem(a, 'You are already in combat.');
      return false;
    }
    if (this.isPlayerInCombatForDuel(b)) {
      if (reporter === a) this.sendChatSystem(a, 'They are already in combat');
      return false;
    }
    return true;
  }

  private canPlayersStartDuel(a: Player, b: Player): boolean {
    if (a.id === b.id) return false;
    if (!this.isDuelablePlayer(a) || !this.isDuelablePlayer(b)) return false;
    if (a.openInterface !== 'duel' || b.openInterface !== 'duel') return false;
    if (this.activeDuels?.has(a.id) || this.activeDuels?.has(b.id)) return false;
    if (a.currentMapLevel !== b.currentMapLevel || a.currentFloor !== b.currentFloor) return false;
    if (this.tileChebyshev(a, b) > 1) return false;
    if (!this.canPlayerReachPlayer(a, b, 1)) return false;
    if (this.playerCombatTargets.has(a.id) || this.playerCombatTargets.has(b.id)) return false;
    if (this.isPlayerUnderNpcAttack(a.id) || this.isPlayerUnderNpcAttack(b.id)) return false;
    if (a.isLogoutBlocked(this.currentTick) || b.isLogoutBlocked(this.currentTick)) return false;
    return true;
  }

  handleDuelRequest(playerId: number, targetEntityId: number): void {
    const player = this.players.get(playerId);
    const target = this.players.get(targetEntityId);
    if (!player || !target || player.id === target.id) return;
    if (!this.canPlayersDuelRequest(player, target, player)) return;
    player.botStats?.recordActionSignature('duelRequest', 'player', player.position.x, player.position.y);

    const pendingDuelRequests = this.pendingDuelRequests ?? (this.pendingDuelRequests = new Map());
    const reverse = pendingDuelRequests.get(target.id);
    if (reverse === player.id) {
      this.openDuelStakeSession(player, target);
      return;
    }

    pendingDuelRequests.set(player.id, target.id);
    setTimeout(() => {
      if (this.pendingDuelRequests?.get(player.id) === target.id) {
        this.pendingDuelRequests.delete(player.id);
      }
    }, World.DUEL_REQUEST_TTL_MS);
    this.sendToPlayer(target, ServerOpcode.DUEL_REQUEST_RECEIVED, player.id);
    this.sendChatSystem(player, `Sending duel request to ${target.name}...`);
  }

  handleDuelAcceptRequest(playerId: number, requesterEntityId: number): void {
    const player = this.players.get(playerId);
    const requester = this.players.get(requesterEntityId);
    if (!player || !requester) return;
    if (this.pendingDuelRequests?.get(requester.id) !== player.id) return;
    if (!this.canPlayersDuelRequest(requester, player, player)) return;
    this.openDuelStakeSession(requester, player);
  }

  private openDuelStakeSession(a: Player, b: Player): void {
    if (!this.canPlayersDuelRequest(a, b)) return;
    this.clearDuelRequestsFor(a.id);
    this.clearDuelRequestsFor(b.id);
    this.clearTradeRequestsFor(a.id);
    this.clearTradeRequestsFor(b.id);
    this.clearDuelSetupState(a);
    this.clearDuelSetupState(b);
    const session: DuelStakeSession = {
      a: { id: a.id, stake: new Array(DUEL_STAKE_SIZE).fill(null), stage: 0 },
      b: { id: b.id, stake: new Array(DUEL_STAKE_SIZE).fill(null), stage: 0 },
    };
    this.duelStakeSessions.set(a.id, session);
    this.duelStakeSessions.set(b.id, session);
    a.openInterface = 'duel';
    b.openInterface = 'duel';
    this.closeShopForPlayer(a);
    this.closeShopForPlayer(b);
    if (a.openDialogueState) this.sendDialogueClose(a);
    if (b.openDialogueState) this.sendDialogueClose(b);
    this.sendToPlayer(a, ServerOpcode.DUEL_OPEN, b.id);
    this.sendToPlayer(b, ServerOpcode.DUEL_OPEN, a.id);
    this.sendDuelAcceptState(session);
  }

  private myDuelStakeSide(session: DuelStakeSession, playerId: number): DuelStakeSide | null {
    if (session.a.id === playerId) return session.a;
    if (session.b.id === playerId) return session.b;
    return null;
  }

  private otherDuelStakeSide(session: DuelStakeSession, playerId: number): DuelStakeSide | null {
    if (session.a.id === playerId) return session.b;
    if (session.b.id === playerId) return session.a;
    return null;
  }

  private validateDuelStakeSession(session: DuelStakeSession): { aPlayer: Player; bPlayer: Player } | null {
    const aPlayer = this.players.get(session.a.id);
    const bPlayer = this.players.get(session.b.id);
    if (!aPlayer || !bPlayer || !this.canPlayersStartDuel(aPlayer, bPlayer)) {
      this.abortDuelStake(session.a.id, 2);
      return null;
    }
    return { aPlayer, bPlayer };
  }

  private resetDuelStages(session: DuelStakeSession): void {
    session.a.stage = 0;
    session.b.stage = 0;
    this.sendDuelAcceptState(session);
  }

  private sendDuelAcceptState(session: DuelStakeSession): void {
    const a = this.players.get(session.a.id);
    const b = this.players.get(session.b.id);
    if (a) this.sendToPlayer(a, ServerOpcode.DUEL_ACCEPT_STATE, session.a.stage, session.b.stage);
    if (b) this.sendToPlayer(b, ServerOpcode.DUEL_ACCEPT_STATE, session.b.stage, session.a.stage);
  }

  private sendDuelStakeUpdate(session: DuelStakeSession, mutatedSide: 'a' | 'b', slot: number): void {
    const side = mutatedSide === 'a' ? session.a : session.b;
    const s = side.stake[slot];
    const itemId = s?.itemId ?? 0;
    const qty = s?.quantity ?? 0;
    const a = this.players.get(session.a.id);
    const b = this.players.get(session.b.id);
    if (a) {
      const sideFlag = mutatedSide === 'a' ? 0 : 1;
      this.sendToPlayer(a, ServerOpcode.DUEL_STAKE_UPDATE, sideFlag, slot, itemId, (qty >>> 16) & 0xFFFF, qty & 0xFFFF);
    }
    if (b) {
      const sideFlag = mutatedSide === 'b' ? 0 : 1;
      this.sendToPlayer(b, ServerOpcode.DUEL_STAKE_UPDATE, sideFlag, slot, itemId, (qty >>> 16) & 0xFFFF, qty & 0xFFFF);
    }
  }

  handleDuelDecline(playerId: number): void {
    this.clearDuelRequestsFor(playerId);
    this.abortDuelStake(playerId, 1);
  }

  abortDuelStake(playerId: number, reason: number = 2): void {
    const session = this.duelStakeSessions.get(playerId);
    if (!session) return;
    this.duelStakeSessions.delete(session.a.id);
    this.duelStakeSessions.delete(session.b.id);
    this.clearDuelRequestsFor(session.a.id);
    this.clearDuelRequestsFor(session.b.id);

    for (const side of [session.a, session.b] as DuelStakeSide[]) {
      const owner = this.players.get(side.id);
      if (!owner) continue;
      this.returnStakeToOwner(owner, side.stake);
      owner.openInterface = null;
      this.sendInventory(owner);
      this.sendToPlayer(owner, ServerOpcode.DUEL_CLOSE, reason);
      this.db.savePlayerState(owner.accountId, owner, this.computeEffectiveY(owner));
    }
    audit({
      type: 'duel.stake_abort',
      tick: this.currentTick,
      accountId: this.players.get(playerId)?.accountId ?? 0,
      details: { reason, a: session.a.id, b: session.b.id },
    });
  }

  private returnStakeToOwner(owner: Player, stake: StakeSlot[]): void {
    for (const off of stake) {
      if (!off) continue;
      const result = owner.addItem(off.itemId, off.quantity, this.data.itemDefs, { assureFullInsertion: false });
      if (result.completed < off.quantity) {
        this.spawnGroundItem(owner, off.itemId, off.quantity - result.completed, REFUND_SPILL_DESPAWN_TICKS);
      }
    }
  }

  handleDuelStakeItem(playerId: number, slotIndex: number, expectedItemId: number, quantity: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const session = this.duelStakeSessions.get(playerId);
    if (!session) return;
    if (!this.validateDuelStakeSession(session)) return;
    const me = this.myDuelStakeSide(session, playerId);
    if (!me) return;
    if (slotIndex < 0 || slotIndex >= player.inventory.length) return;
    const invSlot = player.inventory[slotIndex];
    if (!invSlot || invSlot.itemId !== expectedItemId) return;

    const itemId = invSlot.itemId;
    const itemDef = this.data.getItem(itemId);
    if (!itemDef) return;
    const isStackable = itemDef.stackable === true;
    const available = isStackable
      ? invSlot.quantity
      : player.inventory.reduce((total, s) => total + (s?.itemId === itemId ? 1 : 0), 0);
    const toStake = this.normalizeTradeQuantity(quantity, available);
    if (toStake === null) return;

    let stakeSlot = me.stake.findIndex(o => o?.itemId === itemId);
    if (stakeSlot < 0) stakeSlot = me.stake.findIndex(o => o === null);
    if (stakeSlot < 0) {
      this.sendChatSystem(player, 'Duel stake is full.');
      return;
    }
    const existing = me.stake[stakeSlot];
    if (existing && existing.quantity > MAX_STACK - toStake) {
      this.sendChatSystem(player, 'You cannot stake that many of one item.');
      return;
    }

    if (isStackable) {
      const removed = player.removeItem(slotIndex, toStake);
      if (removed.completed !== toStake) { player.revertRemove(removed); return; }
    } else {
      const removed = player.removeItemById(itemId, toStake);
      if (removed.completed !== toStake) { player.revertRemove(removed); return; }
    }

    if (existing) existing.quantity += toStake;
    else me.stake[stakeSlot] = { itemId, quantity: toStake };

    this.sendInventory(player);
    this.sendDuelStakeUpdate(session, session.a.id === playerId ? 'a' : 'b', stakeSlot);
    this.resetDuelStages(session);
  }

  handleDuelRemoveStake(playerId: number, stakeSlot: number, expectedItemId: number, quantity: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const session = this.duelStakeSessions.get(playerId);
    if (!session) return;
    if (!this.validateDuelStakeSession(session)) return;
    const me = this.myDuelStakeSide(session, playerId);
    if (!me) return;
    if (stakeSlot < 0 || stakeSlot >= me.stake.length) return;
    const off = me.stake[stakeSlot];
    if (!off || off.itemId !== expectedItemId) return;
    const toReturn = this.normalizeTradeQuantity(quantity, off.quantity);
    if (toReturn === null) return;
    if (!player.canFit(off.itemId, toReturn, this.data.itemDefs)) {
      this.sendChatSystem(player, 'Not enough inventory space.');
      return;
    }
    const result = player.addItem(off.itemId, toReturn, this.data.itemDefs);
    if (result.completed !== toReturn) {
      player.revertAdd(result);
      return;
    }
    off.quantity -= toReturn;
    if (off.quantity <= 0) me.stake[stakeSlot] = null;
    this.sendInventory(player);
    this.sendDuelStakeUpdate(session, session.a.id === playerId ? 'a' : 'b', stakeSlot);
    this.resetDuelStages(session);
  }

  handleDuelAccept(playerId: number): void {
    const session = this.duelStakeSessions.get(playerId);
    if (!session) return;
    if (!this.validateDuelStakeSession(session)) return;
    const me = this.myDuelStakeSide(session, playerId);
    const them = this.otherDuelStakeSide(session, playerId);
    if (!me || !them) return;

    if (me.stage === 0) {
      me.stage = 1;
    } else if (me.stage === 1 && them.stage >= 1) {
      me.stage = 2;
    } else {
      return;
    }
    this.sendDuelAcceptState(session);

    if (me.stage === 2 && them.stage === 2) {
      this.startDuelCombat(session);
    }
  }

  private startDuelCombat(session: DuelStakeSession): void {
    const participants = this.validateDuelStakeSession(session);
    if (!participants) return;
    const { aPlayer, bPlayer } = participants;
    const pot = [...session.a.stake, ...session.b.stake];
    if (!this.canFitOffer(aPlayer, pot) || !this.canFitOffer(bPlayer, pot)) {
      this.sendChatSystem(aPlayer, 'Not enough inventory space to start the duel.');
      this.sendChatSystem(bPlayer, 'Not enough inventory space to start the duel.');
      this.abortDuelStake(session.a.id, 2);
      return;
    }

    this.duelStakeSessions.delete(session.a.id);
    this.duelStakeSessions.delete(session.b.id);
    this.clearDuelRequestsFor(session.a.id);
    this.clearDuelRequestsFor(session.b.id);
    this.clearDuelSetupState(aPlayer);
    this.clearDuelSetupState(bPlayer);
    aPlayer.openInterface = null;
    bPlayer.openInterface = null;
    this.armPlayerAttackCooldown(aPlayer, 0);
    this.armPlayerAttackCooldown(bPlayer, 0);

    const duel: ActiveDuel = {
      a: { id: session.a.id, stake: session.a.stake, startHealth: aPlayer.health },
      b: { id: session.b.id, stake: session.b.stake, startHealth: bPlayer.health },
      mapLevel: aPlayer.currentMapLevel,
      floor: aPlayer.currentFloor,
      startedTick: this.currentTick,
    };
    this.activeDuels.set(session.a.id, duel);
    this.activeDuels.set(session.b.id, duel);

    this.faceDuelOpponents(aPlayer, bPlayer);
    this.sendToPlayer(aPlayer, ServerOpcode.DUEL_START, bPlayer.id);
    this.sendToPlayer(bPlayer, ServerOpcode.DUEL_START, aPlayer.id);
    this.sendChatSystem(aPlayer, `Duel with ${bPlayer.name} started.`);
    this.sendChatSystem(bPlayer, `Duel with ${aPlayer.name} started.`);
    const aStake = this.itemEventStacks(session.a.stake);
    const bStake = this.itemEventStacks(session.b.stake);
    this.recordGameEvent({
      type: 'duel',
      severity: 'notable',
      message: `${aPlayer.name} started a duel with ${bPlayer.name}`,
      actorAccountId: aPlayer.accountId,
      actorName: aPlayer.name,
      targetAccountId: bPlayer.accountId,
      targetName: bPlayer.name,
      mapLevel: aPlayer.currentMapLevel,
      floor: aPlayer.currentFloor,
      x: aPlayer.position.x,
      z: aPlayer.position.y,
      details: {
        phase: 'start',
        a: { accountId: aPlayer.accountId, name: aPlayer.name, stake: aStake },
        b: { accountId: bPlayer.accountId, name: bPlayer.name, stake: bStake },
      },
    });
    audit({
      type: 'duel.start',
      tick: this.currentTick,
      accountId: aPlayer.accountId,
      details: {
        a: { accountId: aPlayer.accountId, name: aPlayer.name, stake: session.a.stake.filter(o => o !== null) },
        b: { accountId: bPlayer.accountId, name: bPlayer.name, stake: session.b.stake.filter(o => o !== null) },
      },
    });
  }

  private faceDuelOpponents(a: Player, b: Player): void {
    this.setPlayerAnimation(a, PlayerAnimationKind.Idle, PlayerSkillAnimationVariant.None, b.id, true);
    this.setPlayerAnimation(b, PlayerAnimationKind.Idle, PlayerSkillAnimationVariant.None, a.id, true);
  }

  private clearDuelSetupState(player: Player): void {
    this.clearCombatTarget(player.id);
    this.clearPendingSpellImpactsFor(player.id);
    for (const [, npc] of this.npcs) {
      if (npc.combatTarget?.id === player.id) {
        npc.setCombatTarget(null);
        npc.pathQueue.length = 0;
      }
      npc.clearRetreatTarget(player.id);
    }
    player.attackTarget = null;
    player.clearMoveQueue();
    player.followTargetPlayerId = -1;
    this.clearQueuedPlayerActions(player);
    this.cancelSkilling(player.id);
    this.cancelItemProduction(player.id);
    this.closeShopForPlayer(player);
    this.closeDialogueForPlayer(player);
  }

  private otherActiveDuelSide(duel: ActiveDuel, playerId: number): ActiveDuelSide | null {
    if (duel.a.id === playerId) return duel.b;
    if (duel.b.id === playerId) return duel.a;
    return null;
  }

  private tickActiveDuels(): void {
    const seen = new Set<ActiveDuel>();
    for (const [, duel] of this.activeDuels) {
      if (seen.has(duel)) continue;
      seen.add(duel);
      const aPlayer = this.players.get(duel.a.id);
      const bPlayer = this.players.get(duel.b.id);
      if (!aPlayer || !bPlayer) {
        const survivor = aPlayer ?? bPlayer;
        if (survivor) this.finishDuelByForfeit(survivor.id === duel.a.id ? duel.b.id : duel.a.id);
        else this.finishDuel(duel, null, null, 2);
        continue;
      }
      if (aPlayer.disconnected || aPlayer.requestIdleLogout) { this.finishDuelByForfeit(aPlayer.id); continue; }
      if (bPlayer.disconnected || bPlayer.requestIdleLogout) { this.finishDuelByForfeit(bPlayer.id); continue; }
      if (this.currentTick - duel.startedTick >= World.DUEL_TIMEOUT_TICKS) {
        this.finishDuel(duel, null, null, 2);
        continue;
      }
      if (!this.isActiveDuelPositionValid(duel, aPlayer, bPlayer)) {
        this.finishDuel(duel, null, null, 2);
        continue;
      }

      this.processDuelAttack(duel, aPlayer, bPlayer);
      if (!bPlayer.alive) { this.finishDuel(duel, aPlayer.id, bPlayer.id, 0); continue; }
      this.processDuelAttack(duel, bPlayer, aPlayer);
      if (!aPlayer.alive) { this.finishDuel(duel, bPlayer.id, aPlayer.id, 0); continue; }
    }
  }

  private isActiveDuelPositionValid(duel: ActiveDuel, a: Player, b: Player): boolean {
    if (a.currentMapLevel !== duel.mapLevel || b.currentMapLevel !== duel.mapLevel) return false;
    if (a.currentFloor !== duel.floor || b.currentFloor !== duel.floor) return false;
    return this.canPlayerReachPlayer(a, b, 1);
  }

  private playerRangedAmmoFailureMessage(player: Player): string {
    const itemDefs = this.data.itemDefs;
    const weaponId = player.equipment.get('weapon');
    const weaponDef = weaponId ? itemDefs.get(weaponId) : undefined;
    const ammoType = weaponDef?.ammoType ?? 'arrow';
    const ammoName = ammoType === 'arrow' ? 'arrows' : 'ammunition';
    const equippedAmmoId = player.equipment.get('ammo');
    if (equippedAmmoId === undefined || player.getEquipmentQuantity('ammo') <= 0) {
      return `You don't have any ${ammoName} equipped.`;
    }
    const ammoDef = itemDefs.get(equippedAmmoId);
    if (!ammoDef?.isAmmo || ammoDef.ammoType !== ammoType) {
      return `You don't have any ${ammoName} equipped.`;
    }
    if (!player.canFireAmmo(itemDefs, ammoDef)) {
      return `Your bow can't fire those ${ammoName}.`;
    }
    return `You don't have any ${ammoName} equipped.`;
  }

  private consumePlayerAmmo(player: Player, ammo: PlayerAmmo): void {
    if (!shouldConsumeAmmoOnShot(ammo, () => this.combatRng())) return;
    const beforeItemId = player.equipment.get(ammo.equipSlot);
    player.decrementEquipment(ammo.equipSlot, 1);
    this.sendEquipment(player);
    if (beforeItemId !== player.equipment.get(ammo.equipSlot)) this.broadcastRemoteEquipment(player);
  }

  private projectileTypeForAmmo(ammo: PlayerAmmo): number {
    return ammo.itemDef.ammoType === 'bolt' ? 2 : 1;
  }

  private processDuelAttack(duel: ActiveDuel, attacker: Player, defender: Player): void {
    this.syncPlayerAttackCooldownFromSchedule(attacker);
    if (!attacker.alive || !defender.alive || attacker.attackCooldown > 0) return;
    if (attacker.autocastSpellIndex >= 0) {
      const hit = this.processDuelMagicAttack(attacker, defender);
      if (hit !== null) this.applyDuelHit(duel, attacker, defender, hit, true);
      return;
    }
    if (attacker.isRangedWeapon(this.data.itemDefs)) {
      const ammo = attacker.findAmmo(this.data.itemDefs);
      if (!ammo) {
        this.armPlayerAttackCooldown(attacker, Math.max(1, attacker.getAttackSpeed(this.data.itemDefs)));
        this.sendChatSystem(attacker, this.playerRangedAmmoFailureMessage(attacker));
        return;
      }
      const hit = rollPlayerRangedDamageAgainstPlayer(attacker, defender, this.data.itemDefs, () => this.combatRng());
      this.armPlayerAttackCooldown(attacker, attacker.getAttackSpeed(this.data.itemDefs));
      this.consumePlayerAmmo(attacker, ammo);
      this.broadcastProjectile(attacker, defender, this.projectileTypeForAmmo(ammo), attacker.currentMapLevel, duel.floor);
      this.applyDuelHit(duel, attacker, defender, hit, false);
      return;
    }
    const hit = rollPlayerMeleeDamageAgainstPlayer(attacker, defender, this.data.itemDefs, () => this.combatRng());
    this.armPlayerAttackCooldown(attacker, attacker.getAttackSpeed(this.data.itemDefs));
    this.applyDuelHit(duel, attacker, defender, hit, false);
  }

  private processDuelMagicAttack(attacker: Player, defender: Player): number | null {
    const spellIndex = attacker.autocastSpellIndex;
    const cast = this.prepareMagicCast(attacker, spellIndex, true);
    if (!cast) return null;
    const hit = rollPlayerMagicDamageAgainstPlayer(attacker, defender, this.data.itemDefs, cast.magicLevel, cast.def.tier, attacker.magicStance, () => this.combatRng());
    this.armPlayerAttackCooldown(attacker, MAGIC_ATTACK_COOLDOWN_TICKS);
    this.broadcastPlayerAnimationEvent(
      attacker,
      PlayerAnimationKind.Skill,
      PlayerSkillAnimationVariant.Magic,
      defender.id,
      true,
    );
    this.broadcastNearbyOnFloor(
      attacker.currentMapLevel, attacker.currentFloor, attacker.position.x, attacker.position.y,
      ServerOpcode.SPELL_CAST, attacker.id, defender.id, spellIndex,
    );
    return hit;
  }

  private applyDuelHit(duel: ActiveDuel, attacker: Player, defender: Player, damage: number, magic: boolean): void {
    const actual = defender.takeDamage(damage);
    defender.skills.hitpoints.currentLevel = defender.health;
    attacker.markInCombat(this.currentTick);
    defender.markInCombat(this.currentTick);
    if (!magic) {
      this.setPlayerAnimation(attacker, PlayerAnimationKind.Attack, PlayerSkillAnimationVariant.None, defender.id, true);
    }
    attacker.botStats?.recordCombatSwing(this.currentTickStartMs, performance.now());
    this.broadcastCombatHit(attacker.id, defender.id, actual, defender.health, defender.maxHealth, duel.mapLevel, duel.floor, defender.position.x, defender.position.y);
    this.sendToPlayer(defender, ServerOpcode.PLAYER_STATS, defender.health, defender.maxHealth);
    this.sendSingleSkill(defender, HITPOINTS_SKILL_INDEX);
  }

  private finishDuelByForfeit(loserId: number): void {
    const duel = this.activeDuels.get(loserId);
    if (!duel) return;
    const winner = this.otherActiveDuelSide(duel, loserId);
    if (!winner) {
      this.finishDuel(duel, null, null, 2);
      return;
    }
    this.finishDuel(duel, winner.id, loserId, 1);
  }

  private finishDuel(duel: ActiveDuel, winnerId: number | null, loserId: number | null, reason: number): void {
    this.activeDuels.delete(duel.a.id);
    this.activeDuels.delete(duel.b.id);
    const aPlayer = this.players.get(duel.a.id);
    const bPlayer = this.players.get(duel.b.id);
    const winner = winnerId != null ? this.players.get(winnerId) : null;
    let awardOk = true;
    if (winner) {
      awardOk = this.awardDuelPot(winner, [...duel.a.stake, ...duel.b.stake], duel);
    }
    if (!winner || !awardOk) {
      if (!awardOk) {
        audit({
          type: 'duel.award_failed',
          tick: this.currentTick,
          accountId: winner?.accountId ?? 0,
          details: { winnerId, loserId, reason },
        });
      }
      if (aPlayer) this.returnStakeToOwner(aPlayer, duel.a.stake);
      if (bPlayer) this.returnStakeToOwner(bPlayer, duel.b.stake);
    }
    const finalWinnerId = awardOk ? winnerId : null;
    const finalLoserId = awardOk ? loserId : null;

    for (const side of [duel.a, duel.b] as ActiveDuelSide[]) {
      const player = this.players.get(side.id);
      if (!player) continue;
      this.restoreDuelPlayer(player, side.startHealth);
      this.sendInventory(player);
      this.sendToPlayer(player, ServerOpcode.DUEL_FINISH, finalWinnerId ?? 0, finalLoserId ?? 0, reason);
      this.savePlayerState(player);
    }

    const aName = aPlayer?.name ?? String(duel.a.id);
    const bName = bPlayer?.name ?? String(duel.b.id);
    if (winner && awardOk) {
      const loser = loserId != null ? this.players.get(loserId) : null;
      this.sendChatSystem(winner, 'You won the duel.');
      if (loser) this.sendChatSystem(loser, 'You lost the duel.');
    } else {
      if (aPlayer) this.sendChatSystem(aPlayer, 'Duel ended with no winner. Stakes returned.');
      if (bPlayer) this.sendChatSystem(bPlayer, 'Duel ended with no winner. Stakes returned.');
    }
    audit({
      type: 'duel.finish',
      tick: this.currentTick,
      accountId: winner?.accountId ?? aPlayer?.accountId ?? bPlayer?.accountId ?? 0,
      details: { winnerId: finalWinnerId, loserId: finalLoserId, reason, awardOk, a: aName, b: bName },
    });
    const aStake = this.itemEventStacks(duel.a.stake);
    const bStake = this.itemEventStacks(duel.b.stake);
    const pot = this.itemEventStacks([...duel.a.stake, ...duel.b.stake]);
    const loser = finalLoserId != null ? this.players.get(finalLoserId) : null;
    this.recordGameEvent({
      type: 'duel',
      severity: winner && awardOk ? 'notable' : 'warning',
      message: winner && awardOk
        ? `${winner.name} won a duel against ${loser?.name ?? 'unknown'} and won ${this.itemEventSummary(pot)}`
        : `Duel between ${aName} and ${bName} ended with no winner`,
      actorAccountId: winner?.accountId ?? aPlayer?.accountId ?? null,
      actorName: winner?.name ?? aName,
      targetAccountId: loser?.accountId ?? bPlayer?.accountId ?? null,
      targetName: loser?.name ?? bName,
      mapLevel: duel.mapLevel,
      floor: duel.floor,
      x: winner?.position.x ?? aPlayer?.position.x ?? bPlayer?.position.x ?? null,
      z: winner?.position.y ?? aPlayer?.position.y ?? bPlayer?.position.y ?? null,
      details: {
        phase: 'finish',
        winnerId: finalWinnerId,
        loserId: finalLoserId,
        reason,
        awardOk,
        a: { playerId: duel.a.id, name: aName, stake: aStake },
        b: { playerId: duel.b.id, name: bName, stake: bStake },
        pot,
      },
    });
  }

  private awardDuelPot(winner: Player, pot: StakeSlot[], duel: ActiveDuel): boolean {
    if (!this.canFitOffer(winner, pot)) return false;
    const rollbacks: import('./entity/Player').InventoryAddResult[] = [];
    for (const off of pot) {
      if (!off) continue;
      const r = winner.addItem(off.itemId, off.quantity, this.data.itemDefs);
      if (r.completed !== off.quantity) {
        for (const rb of rollbacks) winner.revertAdd(rb);
        return false;
      }
      rollbacks.push(r);
    }
    audit({
      type: 'duel.award',
      tick: this.currentTick,
      accountId: winner.accountId,
      details: {
        winner: { accountId: winner.accountId, name: winner.name },
        aStake: duel.a.stake.filter(o => o !== null),
        bStake: duel.b.stake.filter(o => o !== null),
      },
    });
    return true;
  }

  private restoreDuelPlayer(player: Player, startHealth: number): void {
    player.openInterface = null;
    player.clearMoveQueue();
    player.followTargetPlayerId = -1;
    player.attackTarget = null;
    this.clearCombatTarget(player.id);
    this.clearQueuedPlayerActions(player);
    player.clearDelay();
    player.logoutBlockedUntilTick = 0;
    player.actionDelay = 0;
    this.armPlayerAttackCooldown(player, 0);
    this.closeShopForPlayer(player);
    const restored = Math.max(1, Math.min(player.maxHealth, Math.floor(startHealth)));
    player.health = restored;
    player.skills.hitpoints.currentLevel = restored;
    player.syncDirty = true;
    this.setPlayerAnimation(player, PlayerAnimationKind.Idle, PlayerSkillAnimationVariant.None, 0);
    this.sendToPlayer(player, ServerOpcode.PLAYER_STATS, player.health, player.maxHealth);
    this.sendSingleSkill(player, HITPOINTS_SKILL_INDEX);
  }

  private abortAllDuelCustody(reason: number): void {
    const stakeSessions = new Set(this.duelStakeSessions.values());
    for (const session of stakeSessions) this.abortDuelStake(session.a.id, reason);
    const duels = new Set(this.activeDuels.values());
    for (const duel of duels) this.finishDuel(duel, null, null, reason);
  }

  private sweepOrphanDuelSessions(): void {
    const stakeSeen = new Set<DuelStakeSession>();
    for (const [, session] of this.duelStakeSessions) {
      if (stakeSeen.has(session)) continue;
      stakeSeen.add(session);
      const aGone = !this.players.has(session.a.id);
      const bGone = !this.players.has(session.b.id);
      if (aGone || bGone) {
        const surviving = aGone ? session.b.id : session.a.id;
        this.abortDuelStake(surviving, 2);
      }
    }
    const duelSeen = new Set<ActiveDuel>();
    for (const [, duel] of this.activeDuels) {
      if (duelSeen.has(duel)) continue;
      duelSeen.add(duel);
      const aGone = !this.players.has(duel.a.id);
      const bGone = !this.players.has(duel.b.id);
      if (aGone || bGone) {
        if (aGone && bGone) this.finishDuel(duel, null, null, 2);
        else {
          const loserId = aGone ? duel.a.id : duel.b.id;
          this.finishDuelByForfeit(loserId);
        }
      }
    }
  }

  /** Close whichever modal interface is open. For trade, decline (with item
   *  return). For bank, just clear the flag and notify. */
  private closeOpenInterface(player: Player, declineTrade: boolean): void {
    if (player.openInterface === 'bank') {
      player.openInterface = null;
      this.sendToPlayer(player, ServerOpcode.BANK_CLOSE, 0);
    } else if (player.openInterface === 'trade' && declineTrade) {
      this.abortTrade(player.id, 2);
    } else if (player.openInterface === 'duel') {
      if (this.duelStakeSessions?.has(player.id)) this.abortDuelStake(player.id, 2);
      else if (this.activeDuels?.has(player.id)) this.finishDuelByForfeit(player.id);
      else player.openInterface = null;
    }
  }

  private itemEventName(itemId: number): string {
    return this.data.itemDefs.get(itemId)?.name ?? `item ${itemId}`;
  }

  private itemEventStacks(stacks: readonly ({ itemId: number; quantity: number } | null)[]): Array<{ itemId: number; itemName: string; quantity: number }> {
    return stacks
      .filter((stack): stack is { itemId: number; quantity: number } => !!stack && stack.quantity > 0)
      .map(stack => ({
        itemId: stack.itemId,
        itemName: this.itemEventName(stack.itemId),
        quantity: stack.quantity,
      }));
  }

  private itemEventSummary(items: readonly { itemName: string; quantity: number }[]): string {
    if (items.length === 0) return 'nothing';
    const parts = items.slice(0, 3).map(item => item.quantity > 1 ? `${item.quantity} x ${item.itemName}` : item.itemName);
    if (items.length > 3) parts.push(`${items.length - 3} more`);
    return parts.join(', ');
  }

  private recordGameEvent(input: GameEventLogInput): void {
    const recorder = (this.db as { recordGameEvent?: (event: GameEventLogInput) => unknown } | undefined)?.recordGameEvent;
    if (typeof recorder === 'function') recorder.call(this.db, input);
  }

  /** Spawn a ground item under a player (used when rewards/refunds can't fit). */
  private spawnGroundItem(
    player: Player,
    itemId: number,
    quantity: number,
    despawnTimer: number = REFUND_SPILL_DESPAWN_TICKS,
  ): void {
    if (quantity <= 0) return;
    const id = this.allocateGroundItemId();
    if (id === null) return;
    const groundItem: GroundItem = {
      id,
      itemId,
      quantity,
      x: player.position.x,
      z: player.position.y,
      floor: player.currentFloor,
      mapLevel: player.currentMapLevel,
      despawnTimer,
    };
    this.groundItems.set(groundItem.id, groundItem);
    this.despawningItemIds.add(groundItem.id);
    const cm = this.chunkManagers.get(player.currentMapLevel);
    if (cm) cm.addEntity(groundItem.id, groundItem.x, groundItem.z, 'groundItem');
    // Broadcast to nearby players so the dropped item appears immediately
    // (without this, clients only see it after re-entering the chunk).
    this.forEachPlayerNearOnFloor(groundItem.mapLevel, groundItem.floor, groundItem.x, groundItem.z, p =>
      this.sendGroundItemUpdate(p, groundItem));
  }

  private spawnNpcLoot(npc: Npc, ownerPlayerId: number | null): void {
    const loot = rollLoot(npc, { rareDropTables: this.data.rareDropTableDefs });
    if (loot.length === 0) return;
    const owner = ownerPlayerId != null ? this.players.get(ownerPlayerId) : null;
    const effectiveOwnerId = owner && owner.currentMapLevel === npc.currentMapLevel && owner.currentFloor === npc.currentFloor ? owner.id : null;
    const deathX = npc.position.x;
    const deathZ = npc.position.y;
    for (const drop of loot) {
      const id = this.allocateGroundItemId();
      if (id === null) continue;
      const itemName = this.itemEventName(drop.itemId);
      const groundItem: GroundItem = {
        id,
        itemId: drop.itemId,
        quantity: drop.quantity,
        x: deathX,
        z: deathZ,
        floor: npc.currentFloor,
        mapLevel: npc.currentMapLevel,
        despawnTimer: NPC_LOOT_DESPAWN_TICKS,
        ownerPlayerId: effectiveOwnerId ?? undefined,
        privateTicks: effectiveOwnerId != null ? NPC_LOOT_PRIVATE_TICKS : 0,
      };
      this.groundItems.set(groundItem.id, groundItem);
      this.despawningItemIds.add(groundItem.id);
      const lootCm = this.chunkManagers.get(groundItem.mapLevel);
      if (lootCm) lootCm.addEntity(groundItem.id, groundItem.x, groundItem.z, 'groundItem');

      if (effectiveOwnerId != null && owner) {
        this.sendGroundItemUpdate(owner, groundItem);
      } else {
        this.forEachPlayerNearOnFloor(groundItem.mapLevel, groundItem.floor, groundItem.x, groundItem.z, p =>
          this.sendGroundItemUpdate(p, groundItem));
      }
      if (drop.source === 'rare_drop_table' && effectiveOwnerId != null && owner) {
        this.sendChatSystem(owner, RARE_DROP_TABLE_CHAT_MESSAGE);
      }
      const lootTableChance = typeof drop.dropChance === 'number' && Number.isFinite(drop.dropChance)
        ? drop.dropChance
        : null;
      const rareFromNormalLootTable = lootTableChance !== null && lootTableChance < RARE_DROP_LOG_CHANCE_THRESHOLD;
      const rare = drop.rare === true || drop.source === 'rare_drop_table' || rareFromNormalLootTable;
      if (!rare && LOW_VALUE_NPC_DROP_LOG_SUPPRESSION_ITEM_IDS.has(drop.itemId)) continue;
      this.recordGameEvent({
        type: rare ? 'rare_drop' : 'npc_drop',
        severity: rare ? 'rare' : 'info',
        message: rare
          ? `${owner?.name ?? 'No owner'} rolled rare drop ${drop.quantity} x ${itemName} from ${npc.def.name}`
          : `${npc.def.name} dropped ${drop.quantity} x ${itemName}${owner ? ` for ${owner.name}` : ''}`,
        actorAccountId: owner?.accountId ?? null,
        actorName: owner?.name ?? null,
        npcDefId: npc.def.id,
        npcName: npc.def.name,
        itemId: drop.itemId,
        itemName,
        quantity: drop.quantity,
        mapLevel: npc.currentMapLevel,
        floor: npc.currentFloor,
        x: deathX,
        z: deathZ,
        details: {
          groundItemId: id,
          ownerPlayerId: effectiveOwnerId,
          lootTableChance,
          rareChanceThreshold: rareFromNormalLootTable ? RARE_DROP_LOG_CHANCE_THRESHOLD : undefined,
          rareReason: rareFromNormalLootTable ? 'loot_table_chance' : undefined,
          rareTableId: drop.rareTableId,
          rareAccessTableId: drop.rareAccessTableId,
        },
      });
    }
  }

  private awardHarvestItem(player: Player, itemId: number, quantity: number): { added: number; dropped: number } {
    const added = player.addItem(itemId, quantity, this.data.itemDefs, { assureFullInsertion: false }).completed;
    const dropped = quantity - added;
    if (dropped > 0) this.spawnGroundItem(player, itemId, dropped, GROUND_ITEM_DESPAWN_TICKS);
    return { added, dropped };
  }

  /** Chebyshev distance in tiles between two players. */
  private tileChebyshev(a: Player, b: Player): number {
    return Math.max(
      Math.abs(Math.floor(a.position.x) - Math.floor(b.position.x)),
      Math.abs(Math.floor(a.position.y) - Math.floor(b.position.y)),
    );
  }

  // Tick performance monitoring
  private tickOverrunCount: number = 0;
  private lastTickWarnTime: number = 0;
  /** Wallclock time at the start of the current tick. Read by BotStats hooks
   *  to compute tick-alignment deltas — bot actions cluster near zero, human
   *  actions spread to 150-500ms. Captured at the top of tick(). */
  private currentTickStartMs: number = 0;
  /** Tick at which we last ran the bot-stats checkpoint. Every 5 minutes
   *  (= 500 ticks at 600ms) we flush in-memory stats to DB so a server
   *  crash doesn't lose the whole session. */
  private lastBotStatsCheckpointTick: number = 0;

  private tick(): void {
    const tickStart = performance.now();
    this.currentTickStartMs = tickStart;
    this.currentTick++;

    this.rebuildEntityTileOccupants();
    this.tickPlayerMovement();
    this.flushPendingPositionCheckpoints();
    this.rebuildEntityTileOccupants();
    this.tickNpcAI();
    this.rebuildEntityTileOccupants();
    this.tickActiveDuels();
    this.getCombatSystem().tick(this.createCombatContext());
    if (this.currentTick % 40 === 0) this.tickHealthRegen();
    this.tickItemProductionActions();
    this.tickSkillingActions();
    this.tickObjectRespawns();
    this.flushPendingObjectRespawnWrites();
    this.tickShopRestocks();
    this.tickItemDespawns();
    this.tickGroundItemRespawns();
    this.tickDialogueScheduledSteps();
    this.tickObjectSayScheduledLines();
    this.tickTransitions();
    this.tickIdleLogouts();
    this.tickDeferredLogouts();
    this.rebuildEntityTileOccupants();
    this.broadcastSync();

    // Bot-stats checkpoint every 500 ticks (~5 min). Flushes each connected
    // player's accumulated stats to SQLite without emitting a session_summary
    // — that only fires on logout. Survives mid-session server crashes.
    if (this.currentTick - this.lastBotStatsCheckpointTick >= 500) {
      this.lastBotStatsCheckpointTick = this.currentTick;
      for (const [, player] of this.players) {
        if (player.disconnected) continue;
        if (player.botStats) {
          const xpNow: Record<string, number> = {};
          for (const skill of ALL_SKILLS) xpNow[skill] = player.skills[skill].xp;
          player.botStats.checkpoint(this.db, player.accountId, xpNow);
        }
      }
    }

    const tickDuration = performance.now() - tickStart;
    if (tickDuration > TICK_RATE * 0.8) {
      this.tickOverrunCount++;
      const now = Date.now();
      if (now - this.lastTickWarnTime > 10_000) {
        this.lastTickWarnTime = now;
        console.warn(`[perf] Tick ${this.currentTick} took ${tickDuration.toFixed(1)}ms (budget: ${TICK_RATE}ms), ` +
          `${this.tickOverrunCount} slow ticks, ${this.players.size} players, ${this.npcs.size} NPCs`);
        this.tickOverrunCount = 0;
      }
    }
  }

  private tickPlayerMovement(): void {
    for (const [playerId, player] of this.players) {
      if (this.activeDuels?.has(playerId)) {
        player.clearMoveQueue();
        player.followTargetPlayerId = -1;
        this.updateEntityChunk(player);
        continue;
      }
      if (player.followTargetPlayerId >= 0) {
        const target = this.players.get(player.followTargetPlayerId);
        if (!target) {
          player.followTargetPlayerId = -1;
          player.clearMoveQueue();
        } else {
          this.updatePlayerFollow(player, target);
        }
      }

      if (player.hasMoveQueue()) player.movementCredit += 1;

      while (player.hasMoveQueue() && player.movementCredit >= 1) {
        const next = player.peekNextMove();
        if (!next) break;
        const map = this.getPlayerMap(player);
        const pFloor = player.currentFloor;
        // Gate the wall-edge check on the player's authoritative walking
        // elevation so a wall below an elevated walkable tile doesn't
        // spuriously truncate the queue — and so an open upper-floor door is
        // passable. effectiveY is kept current by refreshPlayerEffectiveY
        // below; mirrors the elevation gating in handlePlayerMove.
        const wallBlocked = pFloor === 0
          ? map.isWallBlocked(player.position.x, player.position.y, next.x, next.z, player.effectiveY)
          : map.isWallBlockedOnFloor(player.position.x, player.position.y, next.x, next.z, pFloor);
        if (wallBlocked) {
          player.botStats?.recordPathTruncation();
          this.sendToPlayer(player, ServerOpcode.PATH_TRUNCATED, qPos(player.position.x), qPos(player.position.y));
          this.sendNearbyDoorUpdates(player);
          player.clearMoveQueue();
          this.clearQueuedPlayerActions(player);
          player.movementCredit = 0;
          break;
        }
        if (!player.processMovement(this.currentTick)) break;
        // Tile changed — re-derive the authoritative walking elevation and
        // floor immediately so the next queued step gates walls/tiles against
        // the layer the player actually reached.
        this.applyPlayerMovementLayer(player, this.resolvePlayerMovementLayerAt(
          map,
          player.position.x,
          player.position.y,
          {
            floor: player.currentFloor,
            y: player.effectiveY,
            lastFloorChangeTile: player.lastFloorChangeTile,
          },
        ));
      }
      this.updateEntityChunk(player);

      // Defer adjacency-triggered actions one tick if the player just consumed
      // a waypoint this tick — server's authoritative tile updates instantly
      // when a step finishes, but the client interpolates the visual character
      // smoothly, so firing immediately makes interactions register while the
      // character is still visually mid-step (looks like you're chopping a tree
      // a tile away from where you're standing). Holding the action for the
      // next tick (~600ms) lets the client catch up.
      const justArrived = player.lastMovedTick === this.currentTick && !player.hasMoveQueue();

      // Bot-detection: record the final destination tile when a movement
      // completes (path drained). Bots concentrate visits to a few tiles
      // (e.g. rock → bank → rock loop) — the top-destination ratio jumps
      // above 0.5 for a fishing bot within ~50 movements.
      if (justArrived) {
        player.botStats?.recordMovement(player.position.x, player.position.y);
      }

      const movedThisTick = player.lastMovedTick === this.currentTick;
      if (movedThisTick) this.markEntityTileOccupantsDirty();
      if (movedThisTick && (justArrived || this.currentTick - player.lastPositionPersistTick >= 2)) {
        this.checkpointPlayerPosition(player);
      }

      if (!player.hasMoveQueue() && player.pendingActionRevision >= 0 && !this.isQueuedActionCurrent(player)) {
        this.clearQueuedPlayerActions(player);
        continue;
      }

      if (player.pendingPickup >= 0 && !player.hasMoveQueue() && !justArrived) {
        const pickupId = player.pendingPickup;
        player.pendingPickup = -1;
        player.pendingActionRevision = -1;
        this.handlePlayerPickup(playerId, pickupId);
      }
      if (player.pendingInteraction && !player.hasMoveQueue()) {
        const { objectEntityId, actionIndex, swingSign, recipeIndex, recipeQuantity, expectedDoorOpen } = player.pendingInteraction;
        const obj = this.worldObjects.get(objectEntityId);
        // Doors fire instantly on arrival — toggling is visually
        // self-evident (the door swings) and the client already
        // interpolates the character's arrival visually. Other
        // interactions (skilling, crafting) keep the !justArrived guard so
        // animations don't register while the character is mid-step.
        const isDoorInteraction = obj?.def.category === 'door';
        if (!isDoorInteraction && justArrived) continue;
        this.clearQueuedPlayerActions(player);
        if (obj && this.canPlayerTargetObject(player, obj)) {
          if (this.isAdjacentToObject(player, obj)) {
            player.clearMoveQueue();
            player.attackTarget = null;
            this.clearCombatTarget(playerId);
            if (this.rejectStaleDoorInteraction(player, obj, expectedDoorOpen ?? null)) continue;
            const action = obj.def.category === 'ladder' ? obj.def.actions[actionIndex] : obj.currentActions[actionIndex];
            if (action && obj.def.category === 'door' && (action === 'Open' || action === 'Close')) {
              this.toggleDoor(obj, swingSign ?? 0);
            } else if (action) {
              // Forward the stashed recipeIndex so a deferred furnace craft
              // honours the player's picker choice instead of auto-picking
              // (which would fire the first matching recipe — iron, not steel).
              this.handlePlayerInteractObject(playerId, objectEntityId, actionIndex, recipeIndex ?? -1, null, recipeQuantity ?? 1);
            }
          }
        }
      }
      if (player.pendingUseItemOnObject && !player.hasMoveQueue()) {
        if (justArrived) continue;
        const { invSlot, itemId, objectEntityId } = player.pendingUseItemOnObject;
        player.pendingUseItemOnObject = null;
        player.pendingActionRevision = -1;
        this.handlePlayerUseItemOnObject(playerId, invSlot, itemId, objectEntityId);
      }
      if (player.pendingUseItemOnNpc && !player.hasMoveQueue()) {
        if (justArrived) continue;
        const { invSlot, itemId, npcEntityId } = player.pendingUseItemOnNpc;
        player.pendingUseItemOnNpc = null;
        player.pendingActionRevision = -1;
        this.handlePlayerUseItemOnNpc(playerId, invSlot, itemId, npcEntityId);
      }
      // Deferred Talk-to fires once the walk has drained. Mid-walk firing
      // would open the dialogue while the character is still striding;
      // waiting matches RS2. If the NPC wandered just before arrival, allow
      // a small bounded repath before dropping the intent.
      if (player.pendingTalkNpcId >= 0 && !player.hasMoveQueue()) {
        const id = player.pendingTalkNpcId;
        const targetNpc = this.npcs.get(id);
        const inRange = targetNpc && !targetNpc.dead
          && this.canPlayerTargetNpc(player, targetNpc)
          && this.isPlayerNpcInteractionReachable(player, targetNpc);
        if (inRange) {
          player.pendingTalkNpcId = -1;
          player.pendingTalkRepathTicks = 0;
          player.pendingActionRevision = -1;
          this.handlePlayerTalkNpc(playerId, id);
        } else if (
          targetNpc
          && !targetNpc.dead
          && this.canPlayerTargetNpc(player, targetNpc)
          && player.pendingTalkRepathTicks > 0
          && this.queuePlayerPathToNpcInteraction(player, targetNpc)
        ) {
          player.pendingTalkRepathTicks--;
        } else {
          player.pendingTalkNpcId = -1;
          player.pendingTalkRepathTicks = 0;
          player.pendingActionRevision = -1;
        }
      }
    }
  }

  private tickNpcAI(): void {
    for (const [, npc] of this.npcs) {
      if (npc.dead) {
        if (npc.tickRespawn()) {
          this.handleNpcRespawn(npc);
        }
        continue;
      }

      const map = this.getMap(npc.currentMapLevel);
      const oldNpcMap = npc.currentMapLevel;
      const oldNpcFloor = npc.currentFloor;
      const oldNpcX = npc.position.x;
      const oldNpcZ = npc.position.y;

      if (npc.aggressive && !npc.combatTarget && !npc.retreatTarget) {
        const cm = this.chunkManagers.get(npc.currentMapLevel);
        if (cm) {
          // 2004Scape separates current-position acquisition (`huntRange`)
          // from the spawn-anchored combat leash (`maxRange`).
          const huntRange = npc.effectiveAggroRange;
          cm.forEachPlayerNear(npc.position.x, npc.position.y, (pid) => {
            if (npc.combatTarget) return;
            const player = this.players.get(pid);
            if (!player) return;
            if (player.currentMapLevel !== npc.currentMapLevel || player.currentFloor !== npc.currentFloor) return;
            if (player.openInterface !== null || this.activeDuels?.has(player.id)) return;
            if (!npc.isTargetWithinAggroRange(player.position.x, player.position.y)) return;
            const fp = npc.distToFootprint(player.position.x, player.position.y);
            if (Math.max(Math.abs(fp.dx), Math.abs(fp.dz)) <= huntRange) {
              npc.setCombatTarget(player);
            }
          });
        }
      }

      // Freeze AI while a player has a dialogue / shop open against this NPC
      // — wander movement re-fires updateMovementDirection on the client and
      // overrides the NPC_FACING rotation. Cheap O(1) gate via the def flags
      // before the O(players) audience scan; combat-only NPCs skip both.
      const canHaveAudience = npc.hasDialogue || npc.hasShop || npc.hasBank;
      const hadCombatTarget = npc.combatTarget != null;
      const previousCombatTargetId = npc.combatTarget?.id;
      if (canHaveAudience && this.npcHasInteractionAudience(npc)) {
        npc.pathQueue.length = 0;
      } else {
        const mapId = npc.currentMapLevel;
        const size = npc.size;
        const npcFloor = npc.currentFloor;
        // Self-footprint exclusion: an NPC must not block its own movement
        // via the entity-tile-occupants set. Size-1 NPCs use a single key;
        // larger footprints build a set for O(1) membership checks.
        const selfAx = Math.floor(npc.position.x);
        const selfAz = Math.floor(npc.position.y);
        const selfMinX = getObjectFootprintMinTile(npc.position.x, size);
        const selfMinZ = getObjectFootprintMinTile(npc.position.y, size);
        const selfEntityKey = this.entityTileKeyFor(mapId, selfAx, selfAz, npcFloor);
        let selfFootprintKeys: Set<number> | null = null;
        if (size > 1) {
          selfFootprintKeys = new Set<number>();
          for (let i = 0; i < size; i++) {
            for (let j = 0; j < size; j++) {
              selfFootprintKeys.add(this.entityTileKeyFor(mapId, selfMinX + i, selfMinZ + j, npcFloor));
            }
          }
        }
        // Raw per-tile collision. The shared pathing validator expands these
        // facts over the moving NPC's footprint and leading wall edges.
        const rawNpcTileBlocked = (x: number, z: number): boolean => {
          const tileX = Math.floor(x);
          const tileZ = Math.floor(z);
          const objectKey = this.blockedKeyFor(mapId, tileX, tileZ, npcFloor);
          const entityKey = this.entityTileKeyFor(mapId, tileX, tileZ, npcFloor);
          if (map.isTileBlockedOnFloor(tileX, tileZ, npcFloor)) return true;
          if (this.blockedObjectTiles.has(objectKey)) return true;
          const combatMotion = npc.combatTarget != null || npc.retreatTarget != null;
          const selfOccupied = size <= 1 ? entityKey === selfEntityKey : (selfFootprintKeys?.has(entityKey) ?? false);
          if ((this.entityTileOccupants?.has(entityKey) ?? false) && !selfOccupied) {
            if (!combatMotion || this.playerTileOccupants.has(entityKey)) return true;
          }
          return false;
        };
        const rawNpcWallBlocked = (fx: number, fz: number, tx: number, tz: number): boolean =>
          map.isWallBlockedOnFloor(fx, fz, tx, tz, npc.currentFloor);
        const npcCollision: PathingCollision = {
          width: map.width,
          height: map.height,
          isTileBlocked: rawNpcTileBlocked,
          isWallBlocked: rawNpcWallBlocked,
        };
        const npcFindPath = (sx: number, sz: number, gx: number, gz: number) =>
          findPathToTile({
            startX: sx,
            startZ: sz,
            goalX: gx,
            goalZ: gz,
            collision: npcCollision,
            actorSize: size,
            maxSearchTiles: 512,
          });
        npc.processAI(rawNpcTileBlocked, rawNpcWallBlocked, npcFindPath);
      }
      if (hadCombatTarget && npc.combatTarget == null) {
        if (previousCombatTargetId !== undefined) {
          this.clearPlayerCombatTargetForNpc(previousCombatTargetId, npc.id);
        }
        this.broadcastNearbyOnFloor(npc.currentMapLevel, npc.currentFloor, npc.position.x, npc.position.y,
          ServerOpcode.COMBAT_HIT, npc.id, -1, 0, npc.health, npc.maxHealth);
      }

      const cm = this.chunkManagers.get(npc.currentMapLevel);
      if (
        oldNpcX !== npc.position.x
        || oldNpcZ !== npc.position.y
        || oldNpcFloor !== npc.currentFloor
        || oldNpcMap !== npc.currentMapLevel
      ) {
        this.markEntityTileOccupantsDirty();
      }
      if (cm) cm.updateEntity(npc.id, npc.position.x, npc.position.y);
    }
  }

  /** Advance attack schedules once per tick globally. RS2 semantics: attack
   *  timers tick regardless of whether the actor is currently adjacent to a
   *  target — so walking to a mob doesn't reset your timer. Entity cooldown
   *  fields are compatibility projections of CombatSystem schedules. */
  private tickCombatSchedules(): void {
    this.tickPlayerCooldowns();
    this.tickNpcCooldowns();
    this.getCombatSystem().clearExpiredLocks(this.currentTick, World.PVM_COMBAT_LOCK_TICKS);
  }

  private tickPlayerCooldowns(): void {
    for (const [, player] of this.players) {
      this.syncPlayerAttackCooldownFromSchedule(player);
    }
  }

  private armPlayerAttackCooldown(player: Player, cooldownTicks: number): void {
    player.attackCooldown = this.getCombatSystem().armSchedule(
      this.playerCombatRef(player.id),
      this.currentTick,
      cooldownTicks,
    );
  }

  private syncPlayerAttackCooldownFromSchedule(player: Player): void {
    const actor = this.playerCombatRef(player.id);
    const combat = this.getCombatSystem();
    if (player.attackCooldown > 0 && !combat.getSchedule(actor)) {
      player.attackCooldown = combat.adoptScheduleFromCooldown(actor, this.currentTick, player.attackCooldown);
      return;
    }
    player.attackCooldown = combat.advanceSchedule(actor, this.currentTick);
  }

  private tickNpcCooldowns(): void {
    for (const [, npc] of this.npcs) {
      this.syncNpcAttackCooldownFromSchedule(npc);
    }
  }

  private armNpcAttackCooldown(npc: Npc, cooldownTicks: number): void {
    npc.attackCooldown = this.getCombatSystem().armSchedule(
      this.npcCombatRef(npc.id),
      this.currentTick,
      cooldownTicks,
    );
  }

  private syncNpcAttackCooldownFromSchedule(npc: Npc): void {
    const actor = this.npcCombatRef(npc.id);
    const combat = this.getCombatSystem();
    if (npc.attackCooldown > 0 && !combat.getSchedule(actor)) {
      npc.attackCooldown = combat.adoptScheduleFromCooldown(actor, this.currentTick, npc.attackCooldown);
      return;
    }
    npc.attackCooldown = combat.advanceSchedule(actor, this.currentTick);
  }

  private getCombatSystem(): CombatSystem {
    this.combatSystem ??= new CombatSystem();
    return this.combatSystem;
  }

  private combatRng(): number {
    return Math.random();
  }

  private playerCombatRef(playerId: number) {
    return { kind: 'player' as const, id: playerId };
  }

  private npcCombatRef(npcId: number) {
    return { kind: 'npc' as const, id: npcId };
  }

  private canEngagePvmTarget(actor: CombatActorRef, target: CombatActorRef): boolean {
    return this.getCombatSystem().canAttack(
      actor,
      target,
      this.currentTick,
      World.PVM_COMBAT_LOCK_TICKS,
      'pvm',
    );
  }

  private canPlayerEngageNpcCombat(player: Player, npc: Npc): boolean {
    return this.canEngagePvmTarget(this.playerCombatRef(player.id), this.npcCombatRef(npc.id));
  }

  private refreshPlayerNpcCombatLock(player: Player, npc: Npc): void {
    this.getCombatSystem().refreshLock(this.playerCombatRef(player.id), this.npcCombatRef(npc.id), this.currentTick, 'pvm');
    npc.lastCombatTick = this.currentTick;
    npc.lastAttackerId = player.id;
  }

  private isPendingSpellImpactEntry(impact: ImpactQueueEntry): impact is PendingSpellImpactEntry {
    return impact.mode === 'magic'
      && typeof impact.payload === 'object'
      && impact.payload !== null
      && (impact.payload as { kind?: unknown }).kind === 'spell';
  }

  private listPendingSpellImpacts(): PendingSpellImpact[] {
    return this.getCombatSystem()
      .listImpacts()
      .filter((impact): impact is PendingSpellImpactEntry => this.isPendingSpellImpactEntry(impact))
      .map(impact => ({
        impactTick: impact.impactTick,
        attackerId: impact.source.id,
        targetId: impact.target.id,
        damage: impact.payload.damage,
        spellId: impact.payload.spellId,
        xpSkill: impact.payload.xpSkill,
        magicStance: impact.payload.magicStance,
        mapLevel: impact.mapLevel,
        floor: impact.floor,
      }));
  }

  private enqueuePendingSpellImpact(impact: PendingSpellImpact): void {
    this.getCombatSystem().enqueueImpact<PendingSpellImpactPayload>({
      source: this.playerCombatRef(impact.attackerId),
      target: this.npcCombatRef(impact.targetId),
      mode: 'magic',
      launchTick: this.currentTick,
      impactTick: impact.impactTick,
      mapLevel: impact.mapLevel,
      floor: impact.floor ?? 0,
      payload: {
        kind: 'spell',
        damage: impact.damage,
        spellId: impact.spellId,
        xpSkill: impact.xpSkill,
        magicStance: impact.magicStance,
      },
      invalidationPolicy: 'target-only',
    });
  }

  private replacePendingSpellImpacts(impacts: PendingSpellImpact[]): void {
    const combat = this.getCombatSystem();
    combat.removeImpactsWhere(impact => this.isPendingSpellImpactEntry(impact));
    for (const impact of impacts) this.enqueuePendingSpellImpact({ ...impact, floor: impact.floor ?? 0 });
  }

  private createCombatContext(): CombatContext {
    return {
      currentTick: this.currentTick,
      rng: () => this.combatRng(),
      advanceSchedules: () => this.tickCombatSchedules(),
      resumeQueuedCasts: () => this.tickQueuedSpellCasts(),
      startPlayerIntents: () => this.tickPlayerCombat(),
      startNpcIntents: () => this.tickNpcCombat(),
      resolveImpacts: () => this.tickPendingSpells(),
      finishTick: () => this.finishCombatTick(),
    };
  }

  private tickQueuedSpellCasts(): void {
    for (const [playerId, player] of this.players) {
      if (!player.pendingSpellCast || player.attackCooldown > 0) continue;
      if (player.hasMoveQueue()) continue;
      const { spellIndex, targetEntityId, actionRevision } = player.pendingSpellCast;
      player.pendingSpellCast = null;
      if (!this.isQueuedActionCurrent(player, actionRevision)) continue;
      this.handlePlayerCastSpell(playerId, spellIndex, targetEntityId);
    }
  }

  private tickPlayerCombat(): void {
    const itemDefs = this.data.itemDefs;

    for (const [playerId, npcId] of this.playerCombatTargets) {
      const player = this.players.get(playerId);
      const npc = this.npcs.get(npcId);
      if (this.activeDuels?.has(playerId) || player?.openInterface === 'duel') {
        this.magicDebug(player, 'tickCombat-clear-duel', { npcId });
        this.clearCombatTarget(playerId);
        continue;
      }
      if (!player || !npc || npc.dead || !this.canPlayerTargetNpc(player, npc)) {
        this.magicDebug(player, 'tickCombat-clear-invalid', {
          npcId,
          hasPlayer: !!player,
          hasNpc: !!npc,
          npcDead: npc?.dead,
          playerMap: player?.currentMapLevel,
          npcMap: npc?.currentMapLevel,
          playerFloor: player?.currentFloor,
          npcFloor: npc?.currentFloor,
        });
        this.clearCombatTarget(playerId);
        continue;
      }
      if (!this.canPlayerEngageNpcCombat(player, npc)) {
        this.magicDebug(player, 'tickCombat-clear-combat-lock', { npcId });
        this.clearCombatTarget(playerId);
        continue;
      }
      this.syncPlayerCombatIntent(player, npc);

      if (player.autocastSpellIndex >= 0) {
        const def = this.data.getSpellByIndex(player.autocastSpellIndex);
        if (!def || !isAutocastableSpell(def)) {
          this.magicDebug(player, 'tickCombat-autocast-invalid-spell', { npcId, autocast: player.autocastSpellIndex });
          this.clearInvalidAutocast(player, player.autocastSpellIndex);
          continue;
        }
        const fp = npc.distToFootprint(player.position.x, player.position.y);
        const dist = Math.max(Math.abs(fp.dx), Math.abs(fp.dz));
        if (!isPointInNpcMagicAttackRange(npc, player.position.x, player.position.y)) {
          this.magicDebug(player, 'tickCombat-autocast-out-of-range', {
            npcId,
            autocast: player.autocastSpellIndex,
            dist,
            max: MAGIC_ATTACK_DISTANCE,
            hasMoveQueue: player.hasMoveQueue(),
          });
          if (!player.hasMoveQueue()) this.queuePlayerPathToNpcRange(player, npc, MAGIC_ATTACK_DISTANCE, MAGIC_ATTACK_RANGE_MODE);
          continue;
        }
        if (player.attackCooldown <= 0) {
          this.magicDebug(player, 'tickCombat-autocast-ready', {
            npcId,
            autocast: player.autocastSpellIndex,
            dist,
            cooldown: player.attackCooldown,
          });
          this.handlePlayerCastSpell(playerId, player.autocastSpellIndex, npcId, true);
        } else {
          this.magicDebug(player, 'tickCombat-autocast-cooldown', {
            npcId,
            autocast: player.autocastSpellIndex,
            dist,
            cooldown: player.attackCooldown,
          });
        }
        continue;
      }

      const isRanged = player.isRangedWeapon(itemDefs);
      const rangedAttackDist = isRanged ? player.getRangedAttackRange(itemDefs) : RANGED_ATTACK_DISTANCE;
      const inAttackRange = this.isPlayerInNpcAttackRange(player, npc, isRanged ? 'ranged' : 'melee', rangedAttackDist);
      if (!inAttackRange) {
        // Out of range — only re-pathfind when the existing queue has been
        // fully consumed (player arrived at the previous target tile but the
        // NPC has since moved). Re-pathing every tick used to trample the
        // active moveQueue: the client visual was walking the path it
        // computed locally, but the server kept overwriting moveQueue with
        // its own server path result. The two paths diverged from tick
        // one onward, and the >1.5-tile snap guard (GameManager.ts:1229)
        // teleported the local visual onto the server position. Leaving the
        // queue alone while it's being walked keeps client + server in sync;
        // the chase resumes when the queue runs dry.
        if (!player.hasMoveQueue()) {
          if (!isRanged) {
            const path = this.findPlayerPathToNpc(player, npc);
            if (path.length > 0) {
              player.setMoveQueue(path);
            }
          } else {
            this.queuePlayerPathToNpcRange(player, npc, rangedAttackDist, 'chebyshev', true);
          }
        }
        // Out of range this tick — defer the swing. Cooldown still ticks
        // globally so the next adjacency-tick can fire immediately if ready.
        continue;
      }
      let result: any = null;
      if (isRanged) {
        const ammo = player.findAmmo(itemDefs);
        if (ammo) {
          result = processPlayerRangedCombat(player, npc, itemDefs, { rng: () => this.combatRng(), queueNpcRetaliation: true });
          if (result) {
            this.consumePlayerAmmo(player, ammo);
            this.broadcastProjectile(player, npc, this.projectileTypeForAmmo(ammo), player.currentMapLevel, player.currentFloor);
          }
        } else {
          this.clearCombatTarget(playerId);
          this.sendChatSystem(player, this.playerRangedAmmoFailureMessage(player));
          continue;
        }
      } else {
        result = processPlayerCombat(player, npc, itemDefs, { rng: () => this.combatRng(), queueNpcRetaliation: true });
      }
      if (result) {
        this.armPlayerAttackCooldown(player, player.attackCooldown);
        this.refreshPlayerNpcCombatLock(player, npc);
        this.setPlayerAnimation(player, PlayerAnimationKind.Attack, PlayerSkillAnimationVariant.None, npc.id, true);
        if (result.npcReaction === 'retaliate') {
          this.broadcastNpcFacingPlayer(npc, player);
          this.enqueueNpcRetaliation(npc, player);
        }
        // Arm post-combat logout block — player can't safely log off mid-fight.
        player.markInCombat(this.currentTick);
        player.botStats?.recordCombatSwing(this.currentTickStartMs, performance.now());
        this.broadcastCombatHit(result.hit.attackerId, result.hit.targetId, result.hit.damage, result.hit.targetHealth, result.hit.targetMaxHealth, player.currentMapLevel, player.currentFloor, npc.position.x, npc.position.y);

        this.sendCombatXp(player, result);

        if (!npc.alive) {
          // Bot-detection: mark the kill timestamp so the next attack swing
          // gets a reaction-time delta. Bots re-engage within 50ms; humans
          // 300-800ms.
          player.botStats?.recordNpcDeath(performance.now());
          this.finalizeNpcDeath(npc, player);
        }
      }
    }
  }

  /** Credit one kill of this mob to the player who dealt the most cumulative
   *  damage — matching loot ownership (spawnNpcLoot also uses getTopDamager).
   *  Called by the centralized NPC death finalizer. Persists immediately via an atomic UPSERT
   *  (GameDatabase.recordMobKill); banned/excluded accounts are filtered out at
   *  read time, so no gating is needed here. getTopDamager() returns an entity
   *  id (players + NPCs share the id space), so resolve it to a Player first. */
  private creditMobKill(npc: Npc): void {
    const killerId = npc.getTopDamager();
    if (killerId == null) return;
    const killer = this.players.get(killerId);
    if (!killer) return;
    try {
      this.db.recordMobKill(killer.accountId, npc.def.id);
    } catch (e) {
      // Hiscore bookkeeping must NEVER crash the combat tick. Before per-mob
      // kill tracking the combat death path did no DB writes, so a transient
      // "database is locked" (SQLITE_BUSY under write contention) here would
      // otherwise abort tickPlayerCombat / tickPendingSpells mid-kill and skip
      // the rest of that tick (incl. broadcastSync) — read as broken combat.
      console.warn(`[mobkill] recordMobKill failed acct=${killer.accountId} npc=${npc.def.id}:`, e instanceof Error ? e.message : e);
    }
    this.recordGameEvent({
      type: 'npc_kill',
      message: `${killer.name} killed ${npc.def.name}`,
      actorAccountId: killer.accountId,
      actorName: killer.name,
      npcDefId: npc.def.id,
      npcName: npc.def.name,
      mapLevel: npc.currentMapLevel,
      floor: npc.currentFloor,
      x: npc.position.x,
      z: npc.position.y,
      details: {
        npcEntityId: npc.id,
        killerPlayerId: killer.id,
      },
    });
  }

  /**
   * Apply queued spell damage that has reached its impact tick. Damage was
   * already rolled at cast time, so this just delivers the result. Target may
   * have died, moved maps, or the caster may have disconnected — all skipped.
   */
  private tickPendingSpells(): void {
    const due = this.getCombatSystem().takeDueImpactsWhere(
      this.currentTick,
      impact => this.isPendingSpellImpactEntry(impact),
    ) as PendingSpellImpactEntry[];
    if (due.length === 0) return;

    for (const imp of due) {
      const player = this.players.get(imp.source.id);
      const npc = this.npcs.get(imp.target.id);
      if (!player || !npc || npc.dead) continue;
      if (player.openInterface === 'duel' || this.activeDuels?.has(player.id)) continue;
      if (npc.currentMapLevel !== imp.mapLevel || npc.currentFloor !== imp.floor) continue;
      if (player.currentMapLevel !== imp.mapLevel || player.currentFloor !== imp.floor) continue;

      const result = applyPlayerMagicImpactToNpc(
        player,
        npc,
        imp.payload.damage,
        imp.payload.xpSkill,
        imp.payload.magicStance ?? 'accurate',
        { queueNpcRetaliation: true },
      );
      if (result.npcReaction === 'retaliate') {
        this.broadcastNpcFacingPlayer(npc, player);
        this.enqueueNpcRetaliation(npc, player, 1);
      }
      this.broadcastCombatHit(result.hit.attackerId, result.hit.targetId, result.hit.damage, result.hit.targetHealth, result.hit.targetMaxHealth, npc.currentMapLevel, npc.currentFloor, npc.position.x, npc.position.y);
      this.sendCombatXp(player, result);

      if (!npc.alive) {
        this.finalizeNpcDeath(npc, player);
      }
    }
  }

  private tickNpcCombat(): void {
    const itemDefs = this.data.itemDefs;

    for (const [, npc] of this.npcs) {
      this.syncNpcAttackCooldownFromSchedule(npc);
      if (npc.dead || !npc.combatTarget) continue;
      const target = npc.combatTarget as Player;
      if (!target.alive || !this.players.has(target.id) || target.currentMapLevel !== npc.currentMapLevel || target.currentFloor !== npc.currentFloor) {
        npc.setCombatTarget(null);
        continue;
      }
      if (this.activeDuels?.has(target.id) || target.openInterface === 'duel') {
        npc.setCombatTarget(null);
        npc.pathQueue.length = 0;
        continue;
      }
      if (!this.isNpcMeleeReachableToPlayer(npc, target)) {
        continue;
      }

      const hit = processNpcCombat(npc, target, itemDefs, { tickCooldown: false, rng: () => this.combatRng() });
      if (hit) {
        this.armNpcAttackCooldown(npc, npc.attackCooldown);
        // Player took (or dodged) a hit — arm post-combat logout block.
        target.markInCombat(this.currentTick);
        this.broadcastNpcFacingPlayer(npc, target);
        this.broadcastCombatHit(hit.attackerId, hit.targetId, hit.damage, hit.targetHealth, hit.targetMaxHealth, npc.currentMapLevel, npc.currentFloor, target.position.x, target.position.y);

        this.sendToPlayer(target, ServerOpcode.PLAYER_STATS,
          target.health, target.maxHealth
        );
        this.sendSingleSkill(target, HITPOINTS_SKILL_INDEX);

        if (target.alive) {
          this.enqueuePlayerAutoRetaliation(target, npc);
        }

        if (!target.alive) {
          npc.setCombatTarget(null);
          this.handlePlayerDeath(target);
        }
      }
    }
  }

  private tickHealthRegen(): void {
    for (const [, npc] of this.npcs) {
      if (npc.dead || npc.health >= npc.maxHealth) continue;
      if (npc.combatTarget) continue;
      if (this.npcTargetedBy.has(npc.id)) continue;
      npc.heal(1);
    }

    this._playersUnderNpcAttack.clear();
    for (const [, npc] of this.npcs) {
      if (!npc.dead && npc.combatTarget) {
        this._playersUnderNpcAttack.add((npc.combatTarget as Player).id);
      }
    }
    for (const [playerId, player] of this.players) {
      if (!player.alive || player.health >= player.maxHealth) continue;
      if (player.openInterface === 'duel' || this.activeDuels?.has(playerId)) continue;
      if (this.playerCombatTargets.has(playerId)) continue;
      if (this._playersUnderNpcAttack.has(playerId)) continue;
      player.heal(1);
      player.skills.hitpoints.currentLevel = player.health;
      this.sendToPlayer(player, ServerOpcode.PLAYER_STATS, player.health, player.maxHealth);
      this.sendSingleSkill(player, HITPOINTS_SKILL_INDEX);
    }
  }

  private tickItemProductionActions(): void {
    const actions = this.itemProductionActions;
    if (!actions) return;

    for (const [playerId, action] of actions) {
      const player = this.players.get(playerId);
      if (!player || player.disconnected || player.requestIdleLogout || !player.alive) {
        actions.delete(playerId);
        continue;
      }
      if (player.isInterfaceOpen() || player.hasMoveQueue()) {
        actions.delete(playerId);
        continue;
      }
      if (this.currentTick < action.nextTick) continue;

      const produced = this.runItemProductionTick(playerId, player, action);
      if (!produced) {
        actions.delete(playerId);
        this.sendChatSystem(player, this.itemProductionStopMessage(action));
        continue;
      }

      if ('remaining' in action && action.remaining !== null) {
        action.remaining--;
        if (action.remaining <= 0) {
          actions.delete(playerId);
          continue;
        }
      }

      const intervalTicks = 'intervalTicks' in action ? action.intervalTicks : 1;
      action.nextTick = this.currentTick + intervalTicks;
      player.setDelay(this.currentTick, intervalTicks);
    }
  }

  private runItemProductionTick(playerId: number, player: Player, action: ItemProductionAction): boolean {
    if (action.kind === 'itemOnItem') {
      return this.handleItemOnItemRecipe(player, action.recipe, { sendMessage: false });
    }

    const obj = this.worldObjects.get(action.objectEntityId);
    if (!obj || !this.canPlayerTargetObject(player, obj) || !this.isAdjacentToObject(player, obj)) return false;

    if (action.kind === 'objectRecipe') {
      return this.handleCraftingInteraction(playerId, player, obj, action.recipeIndex, {
        interrupt: false,
        explainFailure: false,
      });
    }

    if (action.kind === 'itemOnObject') {
      const invSlot = player.inventory.findIndex(slot => slot?.itemId === action.recipe.inputItemId);
      if (invSlot < 0) return false;
      return this.handleItemOnObjectRecipe(player, invSlot, action.recipe, { sendMessage: false });
    }

    if (action.kind === 'waterSource') {
      if (!this.isWaterSourceObject(obj)) return false;
      for (const recipe of ITEM_ON_OBJECT_RECIPES) {
        const invSlot = player.inventory.findIndex(slot => slot?.itemId === recipe.inputItemId);
        if (invSlot >= 0) return this.handleItemOnObjectRecipe(player, invSlot, recipe, { sendMessage: false });
      }
      return false;
    }

    return false;
  }

  private itemProductionStopMessage(action: ItemProductionAction): string {
    if (action.kind === 'itemOnItem') return action.recipe.stopMessage ?? 'You stop producing items.';
    if (action.kind === 'objectRecipe') {
      const obj = this.worldObjects.get(action.objectEntityId);
      if (obj?.def.category === 'cookingrange') return 'You stop cooking.';
      if (obj?.defId === SPINNING_WHEEL_OBJECT_DEF_ID) return 'You stop spinning.';
      return 'You stop crafting.';
    }
    return 'You stop filling containers.';
  }

  private tickSkillingActions(): void {
    for (const [playerId, action] of this.skillingActions) {
      const player = this.players.get(playerId);
      if (!player) {
        this.skillingActions.delete(playerId);
        continue;
      }

      const obj = this.worldObjects.get(action.objectId);
      if (!obj || obj.depleted || !this.canPlayerTargetObject(player, obj)) {
        this.stopPlayerSkilling(playerId, player);
        continue;
      }

      if (!this.isAdjacentToObject(player, obj)) {
        this.stopPlayerSkilling(playerId, player);
        continue;
      }

      // RS2 three-way branch on player.actionDelay (the %action_delay varp).
      // - actionDelay > currentTick: waiting; swing already playing, no roll.
      // - actionDelay < currentTick (or 0): stale; bootstrap a fresh cycle.
      // - actionDelay == currentTick: ROLL NOW. This branch is what enables
      //   tick-perfect 3-tick mining — if the player clicks a new rock and
      //   arrives on the same tick their pending roll was due, the roll fires
      //   on the first tick of arrival.
      if (this.currentTick < player.actionDelay) continue;
      if (this.currentTick > player.actionDelay || player.actionDelay === 0) {
        player.actionDelay = this.currentTick + action.cycleTime;
        continue;
      }

      // actionDelay === currentTick — roll this tick.
      {
        // Bot-detection signal: a roll fired this tick. Records tick-align
        // delta + bumps session/lifetime counters. Cheap (O(1) field updates).
        player.botStats?.recordSkillingRoll(this.currentTickStartMs, performance.now());
        const skillId = obj.def.skill as SkillId;

        if (obj.def.successChances) {
          const chances = action.toolItemId != null ? obj.def.successChances[String(action.toolItemId)] : null;
          if (!chances) {
            this.sendChatSystem(player, "You can't use that tool here.");
            this.stopPlayerSkilling(playerId, player);
            continue;
          }
          const playerLevel = player.skills[skillId]?.level ?? 1;
          if (!statRandom(playerLevel, chances[0], chances[1])) {
            // Miss — schedule next roll one cycle out.
            player.actionDelay = this.currentTick + action.cycleTime;
            continue;
          }
        }

        const itemId = obj.def.harvestItemId!;
        const qty = obj.def.harvestQuantity ?? 1;
        const xpReward = obj.def.xpReward ?? 0;

        const isChest = obj.def.category === 'chest';
        const foundForChest: Array<{ itemId: number; quantity: number }> = [];
        let inventoryChanged = false;

        const primary = isChest
          ? { added: player.addItem(itemId, qty, this.data.itemDefs).completed, dropped: 0 }
          : this.awardHarvestItem(player, itemId, qty);
        const addedToInv = primary.added > 0;
        const harvestedAnything = primary.added + primary.dropped > 0;
        if (!harvestedAnything) {
          this.sendChatSystem(player, "You can't carry any more.");
          this.stopPlayerSkilling(playerId, player);
          continue;
        }
        if (isChest && addedToInv) foundForChest.push({ itemId, quantity: primary.added });
        if (addedToInv) {
          inventoryChanged = true;
          this.quests.notifyQuestEvent(player, { type: 'itemPickup', itemId, quantity: primary.added, source: isChest ? 'chest' : 'harvest' });
        }
        if (primary.dropped > 0) this.sendChatSystem(player, "Your inventory is full, so the harvest falls to the ground.");
        const primaryItemName = this.itemEventName(itemId);
        this.recordGameEvent({
          type: isChest ? 'chest_loot' : 'harvest',
          severity: isChest ? 'notable' : 'info',
          message: isChest
            ? `${player.name} looted ${primary.added + primary.dropped} x ${primaryItemName} from ${obj.def.name}`
            : `${player.name} harvested ${primary.added + primary.dropped} x ${primaryItemName} from ${obj.def.name}`,
          actorAccountId: player.accountId,
          actorName: player.name,
          itemId,
          itemName: primaryItemName,
          quantity: primary.added + primary.dropped,
          mapLevel: obj.mapLevel,
          floor: obj.floor,
          x: obj.x,
          z: obj.z,
          details: {
            objectEntityId: obj.id,
            objectDefId: obj.defId,
            objectName: obj.def.name,
            skillId,
            added: primary.added,
            dropped: primary.dropped,
            xpReward,
          },
        });

        if (obj.defId === MITHRIL_ROCK_OBJECT_DEF_ID && Math.random() < MITHRIL_PICKAXE_FIND_CHANCE) {
          const rare = this.awardHarvestItem(player, MITHRIL_PICKAXE_ITEM_ID, 1);
          this.sendChatSystem(player, 'You find a beautiful blue pickaxe left among the rocks...');
          if (rare.added > 0) {
            inventoryChanged = true;
            this.quests.notifyQuestEvent(player, {
              type: 'itemPickup',
              itemId: MITHRIL_PICKAXE_ITEM_ID,
              quantity: rare.added,
              source: 'harvest',
            });
          }
          if (rare.dropped > 0) {
            this.sendChatSystem(player, 'You do not have space for it in your inventory, so you throw it to the ground.');
          }
          const rareQuantity = rare.added + rare.dropped;
          if (rareQuantity > 0) {
            const rareItemName = this.itemEventName(MITHRIL_PICKAXE_ITEM_ID);
            this.recordGameEvent({
              type: 'rare_drop',
              severity: 'rare',
              message: `${player.name} found ${rareQuantity} x ${rareItemName} while mining ${obj.def.name}`,
              actorAccountId: player.accountId,
              actorName: player.name,
              itemId: MITHRIL_PICKAXE_ITEM_ID,
              itemName: rareItemName,
              quantity: rareQuantity,
              mapLevel: obj.mapLevel,
              floor: obj.floor,
              x: obj.x,
              z: obj.z,
              details: {
                source: 'mithril_pickaxe_find',
                objectEntityId: obj.id,
                objectDefId: obj.defId,
                objectName: obj.def.name,
                chance: MITHRIL_PICKAXE_FIND_CHANCE,
                added: rare.added,
                dropped: rare.dropped,
              },
            });
          }
        }

        // Bonus loot — chests use this for relic rolls on top of the
        // primary coin payout. Each entry is independent; misses drop
        // nothing. Skips rolls silently when the inventory is full so a
        // jackpot relic doesn't get lost in chat noise. For chests we
        // suppress per-item chat lines and send a single combined
        // "Congratulations!" message at depletion below.
        if (obj.def.extraLoot) {
          for (const drop of obj.def.extraLoot) {
            if (Math.random() >= drop.chance) continue;
            const got = isChest
              ? { added: player.addItem(drop.itemId, drop.quantity, this.data.itemDefs).completed, dropped: 0 }
              : this.awardHarvestItem(player, drop.itemId, drop.quantity);
            const gotQuantity = got.added + got.dropped;
            if (gotQuantity > 0) {
              inventoryChanged = true;
              const itemDef = this.data.itemDefs.get(drop.itemId);
              const name = itemDef?.name ?? `item ${drop.itemId}`;
              if (isChest) {
                if (got.added > 0) foundForChest.push({ itemId: drop.itemId, quantity: got.added });
              } else if (got.added > 0) {
                this.sendChatSystem(player, `You find a ${name}!`);
              }
              if (got.added > 0) {
                this.quests.notifyQuestEvent(player, { type: 'itemPickup', itemId: drop.itemId, quantity: got.added, source: isChest ? 'chest' : 'harvest' });
              }
              const rareFromExtraLootChance = Number.isFinite(drop.chance) && drop.chance < RARE_DROP_LOG_CHANCE_THRESHOLD;
              this.recordGameEvent({
                type: rareFromExtraLootChance ? 'rare_drop' : (isChest ? 'chest_loot' : 'bonus_loot'),
                severity: rareFromExtraLootChance ? 'rare' : 'notable',
                message: rareFromExtraLootChance
                  ? `${player.name} rolled rare drop ${gotQuantity} x ${name} from ${obj.def.name}`
                  : `${player.name} found ${gotQuantity} x ${name} from ${obj.def.name}`,
                actorAccountId: player.accountId,
                actorName: player.name,
                itemId: drop.itemId,
                itemName: name,
                quantity: gotQuantity,
                mapLevel: obj.mapLevel,
                floor: obj.floor,
                x: obj.x,
                z: obj.z,
                details: {
                  source: isChest ? 'chest_extra_loot' : 'harvest_extra_loot',
                  objectEntityId: obj.id,
                  objectDefId: obj.defId,
                  objectName: obj.def.name,
                  chance: drop.chance,
                  rareChanceThreshold: rareFromExtraLootChance ? RARE_DROP_LOG_CHANCE_THRESHOLD : undefined,
                  rareReason: rareFromExtraLootChance ? 'drop_chance' : undefined,
                  added: got.added,
                  dropped: got.dropped,
                },
              });
            }
          }
        }

        if (xpReward > 0) {
          const result = addXp(player.skills, skillId, xpReward);
          const skillIdx = ALL_SKILLS.indexOf(skillId);
          if (skillIdx >= 0) {
            this.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, xpReward);
            if (result.leveled) {
              this.sendLevelUp(player, skillIdx, result.newLevel);
            }
          }
        }

        if (inventoryChanged) this.sendInventory(player);
        const harvestSkillIdx = ALL_SKILLS.indexOf(skillId);
        if (harvestSkillIdx >= 0) this.sendSingleSkill(player, harvestSkillIdx);

        if (obj.def.depletionChance && Math.random() < obj.def.depletionChance) {
          this.persistAndBroadcastDepletion(obj);
          // Combined chest reward message, built from items the roll
          // actually added (never overstates the inventory).
          if (isChest && foundForChest.length > 0) {
            const parts = foundForChest.map(f => {
              const itemDef = this.data.itemDefs.get(f.itemId);
              const name = itemDef?.name ?? `item ${f.itemId}`;
              return f.quantity > 1 ? `${f.quantity} ${name}` : `a ${name}`;
            });
            const joined = parts.length === 1
              ? parts[0]
              : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
            this.sendChatSystem(player, `You open the chest and find: ${joined}.`);
          }
          if (isChest) {
            this.quests.notifyQuestEvent(player, { type: 'chestOpen', chestDefId: obj.defId });
          }
          this.stopPlayerSkilling(playerId, player);
        } else {
          // Successful non-depleting roll — schedule next swing.
          player.actionDelay = this.currentTick + action.cycleTime;
        }
      }
    }
  }

  /** True if any player is on the door's tile or one of the four orthogonal
   *  neighbors. Used to defer auto-close while the doorway is in use. */
  private isAnyPlayerNearDoor(obj: WorldObject): boolean {
    const dtx = Math.floor(obj.x);
    const dtz = Math.floor(obj.z);
    const cm = this.chunkManagers.get(obj.mapLevel);
    if (!cm) return false;
    let near = false;
    cm.forEachPlayerNear(obj.x, obj.z, (pid) => {
      if (near) return;
      const p = this.players.get(pid);
      if (!p || p.currentMapLevel !== obj.mapLevel || p.currentFloor !== obj.floor) return;
      const ptx = Math.floor(p.position.x);
      const ptz = Math.floor(p.position.y);
      if ((ptx === dtx && ptz === dtz) ||
          (Math.abs(ptx - dtx) + Math.abs(ptz - dtz) === 1)) {
        near = true;
      }
    });
    return near;
  }

  private tickObjectRespawns(): void {
    for (const objId of this.depletedObjectIds) {
      const obj = this.worldObjects.get(objId);
      if (!obj) { this.depletedObjectIds.delete(objId); continue; }
      if (obj.def.category === 'door') {
        if (obj.doorOpen === obj.doorDefaultOpen) {
          this.depletedObjectIds.delete(objId);
          continue;
        }
        // Doors: keep the reset timer pinned at full while any player is
        // in the doorway. The countdown only runs once everyone has left, so
        // the reset never changes collision under someone walking through.
        // The base timer is generous (200 ticks ≈ 2 min) — doors are meant
        // to stay in their temporary state for a while after use.
        if (this.isAnyPlayerNearDoor(obj)) {
          obj.respawnTimer = obj.def.respawnTime ?? DEFAULT_OBJECT_RESPAWN_TICKS;
          continue;
        }
        obj.respawnTimer--;
        if (obj.respawnTimer > 0) continue;

        const map = this.maps.get(obj.mapLevel);
        if (map) {
          if (obj.doorDefaultOpen) this.clearDoorWallEdges(obj, map);
          else this.restoreDoorWallEdges(obj, map);
        }
        obj.doorOpen = obj.doorDefaultOpen;
        obj.depleted = obj.doorOpen;
        this.depletedObjectIds.delete(objId);
        this.db.clearDoorState(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z), obj.floor);
        this.broadcastWorldObjectStateChange(obj);
        continue;
      }
      if (obj.tickRespawn()) {
        this.depletedObjectIds.delete(objId);
        // Doors: never re-block the tile on respawn — only the wall edge
        // matters. Mirrors the spawn paths above which exclude doors from
        // blockedObjectTiles. Without this, the door tile becomes pathing-
        // blocked after the first auto-close and silently breaks every
        // subsequent click.
        this.setObjectTilesBlocked(obj.mapLevel, obj.x, obj.z, obj.def, true, obj.floor, obj.interactionTiles, obj.rotationY);
        // Skilling object respawned — drop the persisted target.
        this.queueObjectRespawnClear(obj);
        // Pass swingSign=0 to match the toggle path's packet shape — auto-
        // close doesn't need a direction (the close animation ignores it).
        this.broadcastWorldObjectStateChange(obj);
      }
    }
  }

  private tickShopRestocks(): void {
    for (const [, npc] of this.npcs) {
      const shop = npc.effectiveShop;
      if (!shop) continue;
      const restockTicks = this.shopRestockTicks(shop);
      if (restockTicks <= 0) continue;

      let changed = false;
      for (const item of shop.items) {
        const baseStock = Math.max(0, Math.floor(item.stock));
        if (baseStock <= 0) continue;
        const currentStock = this.shopItemCurrentStock(npc, item);
        if (currentStock >= baseStock) {
          npc.shopNextRestockTick.delete(item.itemId);
          continue;
        }

        const nextTick = npc.shopNextRestockTick.get(item.itemId);
        if (nextTick === undefined) {
          npc.shopNextRestockTick.set(item.itemId, this.currentTick + restockTicks);
          continue;
        }
        if (this.currentTick < nextTick) continue;

        const nextStock = currentStock + 1;
        npc.shopStock.set(item.itemId, nextStock);
        if (nextStock >= baseStock) {
          npc.shopNextRestockTick.delete(item.itemId);
        } else {
          npc.shopNextRestockTick.set(item.itemId, this.currentTick + restockTicks);
        }
        changed = true;
      }
      if (changed) this.refreshShopViewers(npc);
    }
  }

  private tickItemDespawns(): void {
    for (const id of this.despawningItemIds) {
      const item = this.groundItems.get(id);
      if (!item) { this.despawningItemIds.delete(id); continue; }
      item.despawnTimer--;
      if (item.privateTicks && item.privateTicks > 0) {
        item.privateTicks--;
        if (item.privateTicks <= 0) {
          item.ownerPlayerId = undefined;
          item.privateTicks = 0;
          this.forEachPlayerNearOnFloor(item.mapLevel, item.floor, item.x, item.z, p => this.sendGroundItemUpdate(p, item));
        }
      }
      if (item.despawnTimer <= 0) {
        this.despawningItemIds.delete(id);
        this.groundItems.delete(id);
        const despawnCm = this.chunkManagers.get(item.mapLevel);
        if (despawnCm) despawnCm.removeEntity(id);
        // Despawns must reach EVERY player on the map, not just nearby ones.
        // A player who saw the drop and then walked OOR keeps a stale local
        // sprite if the despawn is filtered by chunk proximity. Cost is
        // negligible — items despawn at ~200-tick intervals.
        const packet = encodePacket(ServerOpcode.GROUND_ITEM_SYNC, id, 0, 0, 0, 0, item.floor, qPos(this.floorWorldY(item.mapLevel, item.x, item.z, item.floor)));
        for (const [, p] of this.players) {
          if (p.currentMapLevel !== item.mapLevel || p.currentFloor !== item.floor) continue;
          try { p.ws.sendBinary(packet); } catch { /* connection closed */ }
        }
      }
    }
  }

  private tickGroundItemRespawns(): void {
    const activeKeys = this.activeGroundItemRespawnKeys;
    const sources = this.groundItemRespawnSources;
    if (!activeKeys || !sources) return;

    for (const spawnKey of activeKeys) {
      const source = sources.get(spawnKey);
      if (!source) {
        activeKeys.delete(spawnKey);
        continue;
      }
      source.respawnTimer--;
      if (source.respawnTimer > 0) continue;
      if (!this.spawnRespawningGroundItem(spawnKey, source, true)) {
        source.respawnTimer = 1;
      }
    }
  }

  private tickDialogueScheduledSteps(): void {
    if (this.dialogueScheduledSteps.length === 0) return;
    const remaining: DialogueScheduledStep[] = [];
    for (const step of this.dialogueScheduledSteps) {
      if (step.runAtTick > this.currentTick) {
        remaining.push(step);
        continue;
      }

      const player = this.players.get(step.playerId);
      if (!player) continue;
      const state = player.openDialogueState;
      const expectedNodeId = step.type === 'openBank' ? '__bank_ack__' : '__shop_ack__';
      if (!state || state.sessionId !== step.sessionId || state.npcEntityId !== step.npcEntityId || state.nodeId !== expectedNodeId) continue;
      const npc = this.npcs.get(step.npcEntityId);
      this.closeDialogueForPlayer(player);
      if (!npc || npc.dead) continue;
      if (npc.currentMapLevel !== player.currentMapLevel || !this.isPlayerNpcInteractionReachable(player, npc)) continue;
      if (step.type === 'openBank') {
        if (npc.hasBank) this.openBankFor(player);
      } else if (npc.hasShop) {
        this.openShopFor(player, npc);
      }
    }
    this.dialogueScheduledSteps = remaining;
  }

  private tickObjectSayScheduledLines(): void {
    if (this.objectSayScheduledLines.length === 0) return;
    const remaining: ObjectSayScheduledLine[] = [];
    for (const line of this.objectSayScheduledLines) {
      if (line.runAtTick > this.currentTick) {
        remaining.push(line);
        continue;
      }
      const player = this.players.get(line.playerId);
      if (!player || player.disconnected || player.requestIdleLogout) continue;
      broadcastLocalMessage(line.playerName, line.message, line.accountId, line.isAdmin, line.isModerator);
    }
    this.objectSayScheduledLines = remaining;
  }

  private tickTransitions(): void {
    for (const [, player] of this.players) {
      const map = this.getPlayerMap(player);
      const transition = map.getTransitionAt(player.position.x, player.position.y);
      if (transition) {
        this.handleMapTransition(player, transition);
        continue;
      }

      this.applyPlayerMovementLayer(player, this.resolvePlayerMovementLayerAt(
        map,
        player.position.x,
        player.position.y,
        {
          floor: player.currentFloor,
          y: player.effectiveY,
          lastFloorChangeTile: player.lastFloorChangeTile,
        },
        false,
      ));
    }
  }

  /** Player died — fully reset state, respawn at the map's spawn point,
   *  and notify all observers. Called from any path that brings the player
   *  to 0 HP (NPC combat today; future: environmental damage, PvP).
   *
   *  Anti-exploit notes:
   *  - Any open interface (bank/trade) is aborted BEFORE the position swap.
   *    Trade refunds items to both sides; without this you could die mid-
   *    trade and have the session land in an inconsistent state.
   *  - All transient flags reset: combat lockout, attack cooldown, busy
   *    delay, pending interactions, skilling action. Otherwise the player
   *    could respawn still "busy" or "logout-blocked" from a fight they
   *    just lost.
   *  - ENTITY_DEATH broadcast to everyone who could see the player so
   *    their client clears its remote-player entity. Without it, observers
   *    would see a stuck-at-spawn ghost until the chunk cycles. */
  handlePlayerDeath(player: Player): void {
    const oldMapId = player.currentMapLevel;
    const oldX = player.position.x;
    const oldZ = player.position.y;
    const oldFloor = player.currentFloor;
    player.botStats?.recordPlayerDeath();

    // Tell observers the player died at their current tile. Mirrors the
    // NPC death broadcast — clients use this to clear the remote entity.
    this.broadcastNearbyOnFloor(oldMapId, oldFloor, oldX, oldZ, ServerOpcode.ENTITY_DEATH, player.id, EntityDeathKind.Death);

    // Abort any modal interface BEFORE position changes. Trade abort returns
    // items to both sides; bank close just clears the flag (contents are
    // already safe in player.bank).
    if (player.isInterfaceOpen()) this.closeOpenInterface(player, /*declineTrade*/ true);

    // Drop all transient combat / action state.
    this.clearCombatTarget(player.id);
    this.getCombatSystem().clearActor(this.playerCombatRef(player.id));
    this.cancelSkilling(player.id);
    this.cancelItemProduction(player.id);
    player.clearMoveQueue();
    player.attackTarget = null;
    this.clearQueuedPlayerActions(player);
    this.armPlayerAttackCooldown(player, 0);
    player.clearDelay();
    player.logoutBlockedUntilTick = 0;
    player.actionDelay = 0;
    this.closeShopForPlayer(player);
    this.closeDialogueForPlayer(player);

    // OSRS-style death drop: keep the 3 most valuable items (sorted by
    // per-unit value × quantity), drop everything else as ground items at
    // the death tile. Equipment counts as items — armor unequips into the
    // sort pool. Stackables (coins) drop as a single stack of N regardless
    // of quantity; they take one "kept slot" if among the top 3.
    const itemDefs = this.data.itemDefs;
    type DropEntry = { itemId: number; quantity: number; totalValue: number };
    const pool: DropEntry[] = [];
    for (const s of player.inventory) {
      if (!s) continue;
      const def = itemDefs.get(s.itemId);
      const v = (def?.value ?? 0) * s.quantity;
      pool.push({ itemId: s.itemId, quantity: s.quantity, totalValue: v });
    }
    for (const [slot, itemId] of player.equipment) {
      const quantity = player.getEquipmentQuantity(slot);
      const def = itemDefs.get(itemId);
      const v = (def?.value ?? 0) * quantity;
      pool.push({ itemId, quantity, totalValue: v });
    }
    pool.sort((a, b) => b.totalValue - a.totalValue);
    const kept = pool.slice(0, 3);
    const dropped = pool.slice(3);

    // Wipe inventory + equipment completely. We rebuild inventory from `kept`.
    // Skipping addItem for the rebuild keeps stackable merging trivial — the
    // pool already collapsed identical itemIds via the inventory's existing
    // per-itemId stacking. We're just placing each kept entry into the first
    // empty slot, no merge math needed.
    for (let i = 0; i < player.inventory.length; i++) player.inventory[i] = null;
    player.clearEquipment();
    for (let i = 0; i < kept.length; i++) {
      player.inventory[i] = { itemId: kept[i].itemId, quantity: kept[i].quantity };
    }

    // Drop the rest as ground items at the death tile. Inline the
    // spawnGroundItem logic because that helper uses player.position which
    // we're about to teleport away from.
    for (const d of dropped) {
      const id = this.allocateGroundItemId();
      if (id === null) continue;
      const groundItem: GroundItem = {
        id,
        itemId: d.itemId,
        quantity: d.quantity,
        x: oldX,
        z: oldZ,
        floor: oldFloor,
        mapLevel: oldMapId,
        despawnTimer: DEATH_DROP_DESPAWN_TICKS,
      };
      this.groundItems.set(groundItem.id, groundItem);
      this.despawningItemIds.add(groundItem.id);
      const cm = this.chunkManagers.get(oldMapId);
      if (cm) cm.addEntity(groundItem.id, groundItem.x, groundItem.z, 'groundItem');
      this.forEachPlayerNearOnFloor(oldMapId, oldFloor, oldX, oldZ, p => this.sendGroundItemUpdate(p, groundItem));
    }

    // Equipment changed — broadcast empty equipment to nearby viewers so
    // remote-rendered character entities de-gear immediately.
    this.broadcastRemoteEquipment(player);

    // Restore HP. Skills.hitpoints.currentLevel mirrors player.health for
    // the client's stat sync; without this the skill panel would show 0 HP.
    player.health = player.maxHealth;
    player.skills.hitpoints.currentLevel = player.maxHealth;

    // Respawn destination. For now everyone respawns at the spawn point of
    // their current map. Future: per-account home tile (set via altar, etc.).
    const map = this.getMap(oldMapId);
    const spawn = map.findSpawnPoint();
    this.teleportPlayer(player, spawn.x, spawn.z, undefined, 0);

    // Push the restored HP + skill panel + cleared inventory/equipment to
    // the player. teleportPlayer sends PLAYER_TELEPORT (position/floor) but not
    // stats. The client otherwise wouldn't know its inventory just lost
    // most of its contents.
    this.sendToPlayer(player, ServerOpcode.PLAYER_STATS, player.health, player.maxHealth);
    this.sendSkills(player);
    this.sendInventory(player);
    this.sendEquipment(player);
    this.savePlayerState(player);
    const droppedCount = dropped.length;
    if (droppedCount > 0) {
      this.sendChatSystem(player, `Oh dear, you are dead. You dropped ${droppedCount} item${droppedCount === 1 ? '' : 's'}.`);
    } else {
      this.sendChatSystem(player, 'Oh dear, you are dead.');
    }
    this.recordGameEvent({
      type: 'player_death',
      severity: droppedCount > 0 ? 'warning' : 'notable',
      message: droppedCount > 0
        ? `${player.name} died and dropped ${droppedCount} item${droppedCount === 1 ? '' : 's'}`
        : `${player.name} died`,
      actorAccountId: player.accountId,
      actorName: player.name,
      mapLevel: oldMapId,
      floor: oldFloor,
      x: oldX,
      z: oldZ,
      details: {
        kept: kept.map(k => ({ itemId: k.itemId, itemName: this.itemEventName(k.itemId), quantity: k.quantity })),
        dropped: dropped.map(d => ({ itemId: d.itemId, itemName: this.itemEventName(d.itemId), quantity: d.quantity })),
      },
    });
    audit({
      type: 'player.death',
      tick: this.currentTick,
      accountId: player.accountId,
      details: {
        name: player.name,
        mapAtDeath: oldMapId,
        posAtDeath: { x: oldX, z: oldZ },
        kept: kept.map(k => ({ itemId: k.itemId, quantity: k.quantity })),
        dropped: dropped.map(d => ({ itemId: d.itemId, quantity: d.quantity })),
      },
    });
  }

  /** Same-map teleport — moves the player and sends a lightweight
   *  PLAYER_TELEPORT packet so the client snaps position without reloading
   *  the map / chunks / entities. Only used for in-map jumps; cross-map
   *  transitions still go through MAP_CHANGE (handleMapTransition). */
  teleportPlayer(player: Player, x: number, z: number, forcedY?: number, forcedFloor?: number): void {
    const mapId = player.currentMapLevel;
    const map = this.getPlayerMap(player);
    let targetX = x;
    let targetZ = z;
    let targetFloor = forcedFloor !== undefined ? Math.floor(forcedFloor) : player.currentFloor;
    let forceFloorChange = forcedFloor !== undefined;
    const tx = Math.floor(targetX);
    const tz = Math.floor(targetZ);
    const destinationValid = Number.isFinite(targetX)
      && Number.isFinite(targetZ)
      && Number.isFinite(targetFloor)
      && targetX >= 0
      && targetX < map.width
      && targetZ >= 0
      && targetZ < map.height
      && !map.isTileBlockedOnFloor(tx, tz, targetFloor);
    if (!destinationValid) {
      const fallback = map.findSpawnPoint();
      console.warn(`[teleportPlayer] invalid target (${x},${z}, floor=${forcedFloor ?? player.currentFloor}) on ${mapId}; using spawn (${fallback.x},${fallback.z})`);
      targetX = fallback.x;
      targetZ = fallback.z;
      targetFloor = 0;
      forceFloorChange = true;
      forcedY = undefined;
    }

    const cm = this.chunkManagers.get(mapId);
    if (cm) cm.removeEntity(player.id);
    if (forceFloorChange) {
      player.currentFloor = targetFloor;
      player.lastFloorChangeTile = -1;
    }
    player.teleportTo(targetX, targetZ);
    player.clearMoveQueue();
    player.attackTarget = null;
    this.clearQueuedPlayerActions(player);
    player.followTargetPlayerId = -1;
    player.actionDelay = 0;
    this.cancelSkilling(player.id);
    this.cancelItemProduction(player.id);
    this.clearCombatTarget(player.id);
    player.currentChunkX = Math.floor(targetX / CHUNK_SIZE);
    player.currentChunkZ = Math.floor(targetZ / CHUNK_SIZE);
    if (cm) cm.addEntity(player.id, targetX, targetZ, 'player');
    this.markEntityTileOccupantsDirty();
    // Compute server-authoritative Y at the destination. Forced floor changes
    // deliberately bypass the elevated-plane auto-snap so commands like
    // /spawn can put a player back on the ground under a two-story building.
    let teleportY = forcedY;
    if (teleportY == null) {
      const heightGateY = forceFloorChange && player.currentFloor === 0 ? undefined : player.effectiveY;
      teleportY = map.getEffectiveHeightOnFloor(targetX, targetZ, player.currentFloor, heightGateY);
      const elevAtTile = !forceFloorChange ? map.getElevatedFloorHeight(targetX, targetZ) : undefined;
      if (typeof elevAtTile === 'number' && elevAtTile > 1.0 && teleportY < elevAtTile - 1.0) {
        teleportY = elevAtTile;
      }
    }
    player.effectiveY = teleportY;
    const packet = encodePacket(
      ServerOpcode.PLAYER_TELEPORT,
      qPos(targetX),
      qPos(targetZ),
      qPos(teleportY),
      player.currentFloor,
    );
    try { player.ws.sendBinary(packet); } catch {}
    this.sendNearbyVerticalObjectUpdates(player);
  }

  private sendNearbyVerticalObjectUpdates(player: Player): void {
    const cm = this.chunkManagers?.get(player.currentMapLevel);
    if (!cm) return;
    for (const eid of cm.getEntitiesNear(player.position.x, player.position.y)) {
      const obj = this.worldObjects.get(eid);
      if (!obj || obj.def.category !== 'ladder' || !obj.verticalLinks?.length) continue;
      if (this.canPlayerTargetObject(player, obj)) {
        this.sendWorldObjectUpdate(player, obj);
      } else if (player.visibleEntityIds.has(eid)) {
        this.sendToPlayer(player, ServerOpcode.ENTITY_DEATH, eid);
        player.visibleEntityIds.delete(eid);
      }
    }
  }

  handleMapTransition(player: Player, transition: { targetMap: string; targetX: number; targetZ: number; targetFloor?: number; targetY?: number }): void {
    const oldMap = player.currentMapLevel;
    const newMap = transition.targetMap;

    if (!this.maps.has(newMap)) return;

    // Validate destination coordinates against the target map's bounds. Teleport
    // destinations originate from editor-authored PlacedObject triggers and
    // ItemDef.transition data — a typo or malicious map edit could carry NaN,
    // a negative value, or a coordinate past the map edge, which would put the
    // player on an unloadable tile. Fall back to the map's spawn point if so.
    const targetMapObj = this.maps.get(newMap)!;
    const targetX = transition.targetX;
    const targetZ = transition.targetZ;
    const requestedFloor = Number.isFinite(transition.targetFloor)
      ? Math.floor(transition.targetFloor!)
      : 0;
    const tileX = Math.floor(targetX);
    const tileZ = Math.floor(targetZ);
    const targetValid = typeof targetX === 'number'
      && isFinite(targetX)
      && typeof targetZ === 'number'
      && isFinite(targetZ)
      && targetX >= 0
      && targetX < targetMapObj.width
      && targetZ >= 0
      && targetZ < targetMapObj.height
      && !targetMapObj.isTileBlockedOnFloor(tileX, tileZ, requestedFloor);
    if (!targetValid) {
      const fallback = targetMapObj.findSpawnPoint();
      console.warn(`[handleMapTransition] invalid target (${targetX},${targetZ}, floor=${requestedFloor}) on ${newMap}; using spawn (${fallback.x},${fallback.z})`);
      transition = { targetMap: newMap, targetX: fallback.x, targetZ: fallback.z, targetFloor: 0 };
    }
    const targetFloor = Number.isFinite(transition.targetFloor) ? Math.floor(transition.targetFloor!) : 0;

    // Defense in depth: any modal interface (bank/trade) must close BEFORE
    // we save + transition. Movement also auto-closes via handlePlayerMove,
    // but transitions can fire from admin teleport (PLAYER_TELEPORT path)
    // which doesn't go through handlePlayerMove — without this, a player
    // could be admin-teleported with bank state still flagged open, then
    // pick it back up on the other map and double-deposit.
    if (player.isInterfaceOpen()) this.closeOpenInterface(player, /*declineTrade*/ true);
    this.closeShopForPlayer(player);
    this.closeDialogueForPlayer(player);

    // Clear all cross-entity combat / trade references BEFORE we mutate the
    // player's map. The helper looks up the player by id, so call it while the
    // entity still exists in this.players — but it doesn't need the old map
    // string itself, only the player.id, so the precise ordering vs. the
    // chunk-manager swap below is irrelevant for correctness. Doing it here
    // (before the chunk-manager removal + save) means any in-flight NPC chase
    // is dropped before the new MAP_CHANGE packet ships. Without this an NPC
    // on `kcmap` with combatTarget pointing at this player would keep
    // pathfinding toward the player's new (sultans_mine) coordinates on its
    // own map for a tick or two before tickNpcCombat noticed the mismatch.
    this.clearCombatReferencesTo(player.id);

    // Save player state
    this.savePlayerState(player);

    // Get nearby entities before removing from chunk manager (for cleanup)
    const oldCm = this.chunkManagers.get(oldMap);
    let oldNearbyIds: Set<number> | undefined;
    if (oldCm) {
      oldNearbyIds = oldCm.getEntitiesNear(player.position.x, player.position.y);
      oldCm.unregisterPlayer(player.id);
      oldCm.removeEntity(player.id);
    }

    // Send ENTITY_DEATH for all entities the player was seeing (clean slate)
    if (oldNearbyIds) {
      for (const eid of oldNearbyIds) {
        if (eid === player.id) continue;
        this.sendToPlayer(player, ServerOpcode.ENTITY_DEATH, eid);
        // Also tell the other player this player disappeared
        const other = this.players.get(eid);
        if (other) {
          this.sendToPlayer(other, ServerOpcode.ENTITY_DEATH, player.id);
        }
      }
    }

    // Update player state
    player.visibleEntityIds.clear();
    player.currentMapLevel = newMap;
    player.teleportTo(transition.targetX, transition.targetZ);
    player.currentFloor = targetFloor;
    player.lastFloorChangeTile = -1;
    // Re-derive the authoritative collision elevation for the new map — the
    // old map's effectiveY is meaningless here. Explicit vertical links can
    // carry a signed destination floor/Y; legacy map transitions default to 0.
    player.effectiveY = Number.isFinite(transition.targetY)
      ? transition.targetY!
      : targetMapObj.getEffectiveHeightOnFloor(
        player.position.x, player.position.y, player.currentFloor,
        player.currentFloor > 0 ? Number.POSITIVE_INFINITY : undefined);
    player.clearMoveQueue();
    player.attackTarget = null;
    this.clearCombatTarget(player.id);

    // Update chunk position
    player.currentChunkX = Math.floor(player.position.x / CHUNK_SIZE);
    player.currentChunkZ = Math.floor(player.position.y / CHUNK_SIZE);

    // Add to new map's chunk manager
    const newCm = this.chunkManagers.get(newMap);
    if (newCm) {
      newCm.addEntity(player.id, player.position.x, player.position.y, 'player');
      newCm.registerPlayer(player.id);
    }
    this.markEntityTileOccupantsDirty();

    // Send MAP_CHANGE packet
    this.sendMapChange(player, newMap);
    this.sendFloorChange(player);
    player.syncDirty = true;

    console.log(`Player "${player.name}" transitioned from ${oldMap} to ${newMap}`);
  }

  private updateEntityChunk(player: Player): void {
    const newCX = Math.floor(player.position.x / CHUNK_SIZE);
    const newCZ = Math.floor(player.position.y / CHUNK_SIZE);

    if (newCX !== player.currentChunkX || newCZ !== player.currentChunkZ) {
      player.currentChunkX = newCX;
      player.currentChunkZ = newCZ;

      const cm = this.chunkManagers.get(player.currentMapLevel);
      if (cm) cm.updateEntity(player.id, player.position.x, player.position.y);
    }
  }

  private readonly _dirtyPlayerPackets: Map<number, Uint8Array> = new Map();
  private readonly _dirtyNpcPackets: Map<number, Uint8Array> = new Map();

  private queueSyncPacket(out: SyncPacket[], opcode: ServerOpcode, ...values: number[]): void {
    out.push({ opcode, values, data: encodePacket(opcode, ...values) });
  }

  private queueEncodedSyncPacket(out: SyncPacket[], data: Uint8Array): void {
    out.push({ data });
  }

  private canBatchSyncPackets(player: Player): boolean {
    const wsData = (player.ws as unknown as { data?: { crypto?: { encryptEnabled?: boolean; handshakeComplete?: boolean; opcodeMappingEnabled?: boolean } } }).data;
    const crypto = wsData?.crypto;
    return !!crypto?.encryptEnabled && !!crypto.handshakeComplete && !!crypto.opcodeMappingEnabled;
  }

  private flushSyncPackets(player: Player, packets: SyncPacket[]): void {
    if (player.disconnected || packets.length === 0) return;
    try {
      if (packets.length > 1 && this.canBatchSyncPackets(player)) {
        player.ws.sendBinary(encodePacketBatch(ServerOpcode.PACKET_BATCH, packets.map(packet => packet.data)));
        return;
      }
      const sendToPlayerOverridden = this.sendToPlayer !== World.prototype.sendToPlayer;
      for (const packet of packets) {
        if (sendToPlayerOverridden && packet.opcode !== undefined && packet.values) {
          this.sendToPlayer(player, packet.opcode, ...packet.values);
        } else {
          player.ws.sendBinary(packet.data);
        }
      }
    } catch { /* connection closed */ }
  }

  private broadcastSync(): void {
    const dirtyPlayerPackets = this._dirtyPlayerPackets;
    const dirtyNpcPackets = this._dirtyNpcPackets;
    dirtyPlayerPackets.clear();
    dirtyNpcPackets.clear();

    // Phase 1: Dirty-check and pre-build packets for changed entities
    for (const [, player] of this.players) {
      const sx = qPos(player.position.x);
      const sz = qPos(player.position.y);
      if (player.syncDirty || sx !== player.lastSyncX || sz !== player.lastSyncZ || player.health !== player.lastSyncHealth) {
        player.lastSyncX = sx;
        player.lastSyncZ = sz;
        player.lastSyncHealth = player.health;
        player.syncDirty = true;
        const a = player.appearance;
        dirtyPlayerPackets.set(player.id, encodePacket(ServerOpcode.PLAYER_SYNC,
          player.id, sx, sz,
          player.health, player.maxHealth,
          a ? a.shirtColor : -1, a ? a.pantsColor : -1, a ? a.shoesColor : -1,
          a ? a.hairColor  : -1, a ? a.beltColor  : -1, a ? a.skinColor  : -1,
          a ? a.hairStyle  : -1,
          a ? a.bodyType : -1,
          player.combatLevel,
          player.currentFloor,
          qPos(player.effectiveY),
          (player.isAdmin ? 1 : 0) | (player.isModerator ? 2 : 0),
        ));
      }
    }
    for (const [, npc] of this.npcs) {
      if (npc.dead) continue;
      const sx = qPos(npc.position.x);
      const sz = qPos(npc.position.y);
      if (npc.syncDirty || sx !== npc.lastSyncX || sz !== npc.lastSyncZ || npc.health !== npc.lastSyncHealth) {
        npc.lastSyncX = sx;
        npc.lastSyncZ = sz;
        npc.lastSyncHealth = npc.health;
        npc.syncDirty = true;
        dirtyNpcPackets.set(npc.id, encodePacket(ServerOpcode.NPC_SYNC,
          npc.id, npc.npcId, sx, sz, npc.health, npc.maxHealth,
          npc.currentFloor,
          qPos(this.npcWorldY(npc)),
          this.npcWillContinueWalking(npc) ? 1 : 0,
          qFacing(npc.facingAngle),
          this.npcFaceTargetId(npc),
          npc.combatLevel,
          encodeNpcVisualScale(npc.visualScale),
        ));
      }
    }

    // Phase 2: Viewer-first iteration — all sends to each viewer are consecutive
    for (const [, viewer] of this.players) {
      if (viewer.disconnected) continue;
      const a = viewer.appearance;
      const syncPackets: SyncPacket[] = [];
      this.queueSyncPacket(
        syncPackets,
        ServerOpcode.PLAYER_SELF_SYNC,
        qPos(viewer.position.x),
        qPos(viewer.position.y),
        viewer.health,
        viewer.maxHealth,
        this.currentTick & 0x7fff,
        viewer.hasMoveQueue() ? 1 : 0,
        a ? a.shirtColor : -1,
        a ? a.pantsColor : -1,
        a ? a.shoesColor : -1,
        a ? a.hairColor  : -1,
        a ? a.beltColor  : -1,
        a ? a.skinColor  : -1,
        a ? a.hairStyle  : -1,
        a ? a.bodyType   : -1,
      );
      const cm = this.chunkManagers.get(viewer.currentMapLevel);
      if (!cm) {
        this.flushSyncPackets(viewer, syncPackets);
        continue;
      }

      try {
        const previousVisible = viewer.visibleEntityIds;
        const nextVisible = viewer.nextVisibleEntityIds;
        nextVisible.clear();
        const visitNearbyEntity = (eid: number, kind: string) => {
          if (eid === viewer.id) return;
          if (kind === 'player') {
            const subject = this.players.get(eid);
            if (!subject || subject.currentFloor !== viewer.currentFloor) return;
          } else if (kind === 'npc') {
            const npc = this.npcs.get(eid);
            if (!npc || !this.canPlayerSyncNpc(viewer, npc)) return;
          } else if (kind === 'object') {
            const obj = this.worldObjects.get(eid);
            if (!obj || !this.canPlayerTargetObject(viewer, obj)) return;
          } else if (kind === 'groundItem') {
            const item = this.groundItems.get(eid);
            if (!item || !this.canPlayerTargetGroundItem(viewer, item)) return;
          } else {
            const subject = this.players.get(eid);
            if (subject && subject.currentFloor !== viewer.currentFloor) return;
            const npc = this.npcs.get(eid);
            if (npc && !this.canPlayerSyncNpc(viewer, npc)) return;
            const obj = this.worldObjects.get(eid);
            if (obj && !this.canPlayerTargetObject(viewer, obj)) return;
            const item = this.groundItems.get(eid);
            if (item && !this.canPlayerTargetGroundItem(viewer, item)) return;
          }
          nextVisible.add(eid);
        };
        const forEachEntityKindNearChunk = (cm as unknown as {
          forEachEntityKindNearChunk?: (cx: number, cz: number, fn: (entityId: number, kind: string) => void) => void;
        }).forEachEntityKindNearChunk;
        if (typeof forEachEntityKindNearChunk === 'function') {
          forEachEntityKindNearChunk.call(cm, viewer.currentChunkX, viewer.currentChunkZ, visitNearbyEntity);
        } else {
          (cm as unknown as { forEachEntityNearChunk: (cx: number, cz: number, fn: (entityId: number) => void) => void })
            .forEachEntityNearChunk(viewer.currentChunkX, viewer.currentChunkZ, (eid: number) => visitNearbyEntity(eid, 'entity'));
        }

        for (const eid of previousVisible) {
          if (!nextVisible.has(eid)) {
            this.queueSyncPacket(syncPackets, ServerOpcode.ENTITY_DEATH, eid);
          }
        }

        nextVisible.forEach((eid) => {
          const wasVisible = previousVisible.has(eid);
          if (wasVisible) {
            const pkt = dirtyPlayerPackets.get(eid);
            if (pkt) { this.queueEncodedSyncPacket(syncPackets, pkt); return; }
            const npkt = dirtyNpcPackets.get(eid);
            if (npkt) { this.queueEncodedSyncPacket(syncPackets, npkt); return; }
            return;
          }

          const subject = this.players.get(eid);
          if (subject && subject.currentFloor === viewer.currentFloor) {
            this.queuePlayerPresence(syncPackets, viewer, subject);
            return;
          }
          const npc = this.npcs.get(eid);
          if (npc && this.canPlayerSyncNpc(viewer, npc)) {
            this.queueNpcStaticData(syncPackets, npc);
            this.queueNpcUpdate(syncPackets, viewer, npc);
            return;
          }
          // Re-sync world objects on chunk transitions. Without this, a player
          // who walks into range of a door that was opened (or a tree that was
          // chopped, etc.) while they were too far away to receive the
          // WORLD_OBJECT_DEPLETED broadcast keeps a stale local state and
          // can't interact correctly until they re-login.
          const obj = this.worldObjects.get(eid);
          if (obj && this.canPlayerTargetObject(viewer, obj)) { this.queueWorldObjectUpdate(syncPackets, viewer, obj); return; }
          // Re-sync ground items too — a player who saw a drop, walked OOR,
          // and walked back would otherwise keep the stale local sprite for
          // an item the server has already despawned (or vice versa).
          const item = this.groundItems.get(eid);
          if (item && this.canPlayerTargetGroundItem(viewer, item)) {
            this.queueGroundItemUpdate(syncPackets, viewer, item);
          }
        });

        viewer.visibleEntityIds = nextVisible;
        viewer.nextVisibleEntityIds = previousVisible;
        viewer.lastBroadcastChunkX = viewer.currentChunkX;
        viewer.lastBroadcastChunkZ = viewer.currentChunkZ;
        this.flushSyncPackets(viewer, syncPackets);
      } catch { /* connection closed */ }
    }

    // Phase 3: Clear dirty flags
    for (const [, player] of this.players) player.syncDirty = false;
    for (const [, npc] of this.npcs) npc.syncDirty = false;
  }

  private broadcastCombatHit(attackerId: number, targetId: number, damage: number, targetHp: number, targetMaxHp: number, mapLevel: string, floor: number, worldX: number, worldZ: number): void {
    this.broadcastNearbyOnFloor(mapLevel, floor, worldX, worldZ, ServerOpcode.COMBAT_HIT, attackerId, targetId, damage, targetHp, targetMaxHp);
  }

  private broadcastProjectile(attacker: Player, target: Player | Npc, projectileType: number, mapLevel: string, floor: number): void {
    const sourceX = attacker.position.x;
    const sourceZ = attacker.position.y;
    const targetX = target.position.x;
    const targetZ = target.position.y;
    const sourceY = attacker.effectiveY + RANGED_PROJECTILE_SOURCE_HEIGHT;
    const targetY = target instanceof Npc
      ? this.npcWorldY(target) + RANGED_PROJECTILE_TARGET_HEIGHT
      : target.effectiveY + RANGED_PROJECTILE_TARGET_HEIGHT;
    const horizontalDistance = Math.hypot(targetX - sourceX, targetZ - sourceZ);
    const travelMs = Math.round(rangedProjectileTravelMsForDistance(horizontalDistance));
    const arcHeight = rangedProjectileArcHeightForDistance(horizontalDistance);
    this.broadcastNearbyOnFloor(
      mapLevel,
      floor,
      sourceX,
      sourceZ,
      ServerOpcode.COMBAT_PROJECTILE,
      attacker.id,
      target.id,
      projectileType,
      qPos(sourceX),
      qPos(sourceZ),
      qPos(targetX),
      qPos(targetZ),
      qPos(sourceY),
      qPos(targetY),
      travelMs,
      qPos(arcHeight),
    );
  }

  private broadcastWorldObjectAnimation(obj: WorldObject): void {
    this.broadcastNearbyOnFloor(obj.mapLevel, obj.floor ?? 0, obj.x, obj.z, ServerOpcode.WORLD_OBJECT_ANIMATION, obj.id);
  }

  private sendChatSystem(player: Player, message: string): void {
    // System messages travel over the JSON chat socket, looked up by username.
    // The binary CHAT_SYSTEM opcode is reserved for future use (e.g. ping the
    // game socket) and currently carries no string payload.
    sendSystemMessageToUser(player.name, message);
  }

  private sendMapChange(player: Player, mapId: string): void {
    if (player.disconnected) return;
    const packet = encodeStringPacket(
      ServerOpcode.MAP_CHANGE,
      mapId,
      qPos(player.position.x),
      qPos(player.position.y)
    );
    try {
      player.ws.sendBinary(packet);
    } catch { /* connection closed */ }
  }

  private encodePlayerUpdate(subject: Player): Uint8Array {
    const a = subject.appearance;
    return encodePacket(ServerOpcode.PLAYER_SYNC,
      subject.id,
      qPos(subject.position.x),
      qPos(subject.position.y),
      subject.health,
      subject.maxHealth,
      a ? a.shirtColor : -1,
      a ? a.pantsColor : -1,
      a ? a.shoesColor : -1,
      a ? a.hairColor  : -1,
      a ? a.beltColor  : -1,
      a ? a.skinColor  : -1,
      a ? a.hairStyle  : -1,
      a ? a.bodyType : -1,
      subject.combatLevel,
      subject.currentFloor,
      qPos(subject.effectiveY),
      (subject.isAdmin ? 1 : 0) | (subject.isModerator ? 2 : 0),
    );
  }

  private sendPlayerUpdate(viewer: Player, subject: Player): void {
    if (viewer.currentMapLevel !== subject.currentMapLevel || viewer.currentFloor !== subject.currentFloor) return;
    try { viewer.ws.sendBinary(this.encodePlayerUpdate(subject)); } catch { /* connection closed */ }
  }

  private queuePlayerPresence(out: SyncPacket[], viewer: Player, subject: Player): void {
    if (viewer.currentMapLevel !== subject.currentMapLevel || viewer.currentFloor !== subject.currentFloor) return;
    this.queueEncodedSyncPacket(out, this.encodePlayerUpdate(subject));
    this.queueEncodedSyncPacket(out, this.encodeRemoteEquipment(subject));
    this.queueEncodedSyncPacket(out, this.encodeRemoteStance(subject));
    this.queueEncodedSyncPacket(out, this.encodePlayerAnimation(subject));
  }

  private sendPlayerPresence(viewer: Player, subject: Player): void {
    this.sendPlayerUpdate(viewer, subject);
    // Equipment/stance/animation are intentionally separate from PLAYER_SYNC
    // so ordinary movement packets stay small. On map-ready and chunk-entry
    // we need the full bundle, otherwise a late-joining client can spawn a
    // player who is already chopping/mining but miss the active animation
    // until the next start/stop event.
    this.sendRemoteEquipment(viewer, subject);
    this.sendRemoteStance(viewer, subject);
    this.sendRemoteAnimation(viewer, subject);
  }

  private npcWillContinueWalking(npc: Npc): boolean {
    if (npc.pathQueue.length > 0) return true;
    if (npc.retreatTarget) return true;
    if (!npc.combatTarget) return false;
    if (npc.combatTarget instanceof Player) {
      const nextTargetStep = npc.combatTarget.peekNextMove();
      if (nextTargetStep && !npc.isInteractionTile(Math.floor(nextTargetStep.x), Math.floor(nextTargetStep.z))) {
        return true;
      }
    }
    const fp = npc.distToFootprint(npc.combatTarget.position.x, npc.combatTarget.position.y);
    return Math.max(Math.abs(fp.dx), Math.abs(fp.dz)) > Npc.MELEE_RANGE;
  }

  private npcFaceTargetId(npc: Npc): number {
    // Combat chase and retreat both use RS2-style face-lock on the client:
    // chase sidesteps around the target, retreat backpedals away from it.
    const target = npc.combatTarget ?? npc.retreatTarget;
    return target?.alive ? target.id : 0;
  }

  private encodeNpcUpdate(npc: Npc): Uint8Array {
    return encodePacket(ServerOpcode.NPC_SYNC,
      npc.id,
      npc.npcId,
      qPos(npc.position.x),
      qPos(npc.position.y),
      npc.health,
      npc.maxHealth,
      npc.currentFloor,
      qPos(this.npcWorldY(npc)),
      this.npcWillContinueWalking(npc) ? 1 : 0,
      qFacing(npc.facingAngle),
      this.npcFaceTargetId(npc),
      npc.combatLevel,
      encodeNpcVisualScale(npc.visualScale),
    );
  }

  private sendNpcUpdate(viewer: Player, npc: Npc): void {
    if (!this.canPlayerSyncNpc(viewer, npc)) return;
    try { viewer.ws.sendBinary(this.encodeNpcUpdate(npc)); } catch { /* connection closed */ }
  }

  private queueNpcUpdate(out: SyncPacket[], viewer: Player, npc: Npc): void {
    if (!this.canPlayerSyncNpc(viewer, npc)) return;
    this.queueEncodedSyncPacket(out, this.encodeNpcUpdate(npc));
  }

  /** Push the NPC's per-spawn appearance + equipment to a viewer who is
   *  about to see this NPC for the first time (map load, chunk entry, or
   *  respawn). No-op when the NPC has no customization — sprite/built-in
   *  3D NPCs (rat, cow, chicken, …) skip this entirely. */
  /** Encode the (static) per-NPC packets ONCE. encodePacket/encodeStringPacket
   *  each return an independent buffer, so the returned array is safe to reuse
   *  across many viewers — a broadcast no longer re-encodes (and re-allocates,
   *  esp. the UTF-8 name/attack-anim string packets) per viewer. */
  private buildNpcStaticPackets(npc: Npc): Uint8Array[] {
    const packets: Uint8Array[] = [];
    const a = npc.appearance;
    if (a) {
      packets.push(encodePacket(ServerOpcode.NPC_APPEARANCE,
        npc.id,
        a.shirtColor, a.pantsColor, a.shoesColor,
        a.hairColor, a.beltColor, a.skinColor,
        a.hairStyle, a.bodyType,
      ));
    }
    const eq = npc.equipment;
    if (eq && eq.length >= 10) {
      const values = [npc.id];
      for (let i = 0; i < EQUIPMENT_SLOT_NAMES.length; i++) values.push(eq[i] ?? 0);
      packets.push(encodePacket(ServerOpcode.NPC_EQUIPMENT, ...values));
    }
    const cc = npc.customColors;
    if (cc && CUSTOM_COLOR_SLOTS.some(s => cc[s])) {
      // Quantize each component to int16 (×1000). A slot with no override
      // writes -1 in its R channel; client decoder treats that as "use palette".
      const payload: number[] = [npc.id];
      for (const slot of CUSTOM_COLOR_SLOTS) {
        const c = cc[slot];
        if (c) {
          payload.push(
            Math.max(0, Math.min(1000, Math.round(c[0] * 1000))),
            Math.max(0, Math.min(1000, Math.round(c[1] * 1000))),
            Math.max(0, Math.min(1000, Math.round(c[2] * 1000))),
          );
        } else {
          payload.push(-1, 0, 0);
        }
      }
      packets.push(encodePacket(ServerOpcode.NPC_CUSTOM_COLORS, ...payload));
    }
    // Tell the client which non-combat actions this NPC supports, so its
    // right-click menu can offer Talk-to / Trade / Bank without the client
    // needing to mirror npcs.json. Skip when there are none — the bit field
    // would be 0 and the client's default (attackable mob) is correct.
    const flags = npc.interactionFlags();
    if (flags !== 0) {
      packets.push(encodePacket(ServerOpcode.NPC_INTERACTIONS, npc.id, flags));
    }
    // Custom per-spawn display name. Most NPCs don't have one — skip the
    // packet so we're not spamming the wire with default names.
    if (npc.nameOverride) {
      packets.push(encodeStringPacket(ServerOpcode.NPC_NAME, npc.nameOverride, npc.id));
    }
    // Forced-swing animation override. Same string-packet shape as NPC_NAME.
    if (npc.attackAnimOverride) {
      packets.push(encodeStringPacket(ServerOpcode.NPC_ATTACK_ANIM, npc.attackAnimOverride, npc.id));
    }
    return packets;
  }

  private sendEncodedPackets(viewer: Player, packets: readonly Uint8Array[]): void {
    if (viewer.disconnected) return;
    for (const packet of packets) {
      try { viewer.ws.sendBinary(packet); } catch { /* connection closed */ }
    }
  }

  private sendNpcStaticData(viewer: Player, npc: Npc): void {
    this.sendEncodedPackets(viewer, this.buildNpcStaticPackets(npc));
  }

  private queueNpcStaticData(out: SyncPacket[], npc: Npc): void {
    const a = npc.appearance;
    if (a) {
      this.queueSyncPacket(out, ServerOpcode.NPC_APPEARANCE,
        npc.id,
        a.shirtColor, a.pantsColor, a.shoesColor,
        a.hairColor, a.beltColor, a.skinColor,
        a.hairStyle, a.bodyType,
      );
    }
    const eq = npc.equipment;
    if (eq && eq.length >= 10) {
      const values = [npc.id];
      for (let i = 0; i < EQUIPMENT_SLOT_NAMES.length; i++) values.push(eq[i] ?? 0);
      this.queueSyncPacket(out, ServerOpcode.NPC_EQUIPMENT, ...values);
    }
    const cc = npc.customColors;
    if (cc && CUSTOM_COLOR_SLOTS.some(s => cc[s])) {
      const payload: number[] = [npc.id];
      for (const slot of CUSTOM_COLOR_SLOTS) {
        const c = cc[slot];
        if (c) {
          payload.push(
            Math.max(0, Math.min(1000, Math.round(c[0] * 1000))),
            Math.max(0, Math.min(1000, Math.round(c[1] * 1000))),
            Math.max(0, Math.min(1000, Math.round(c[2] * 1000))),
          );
        } else {
          payload.push(-1, 0, 0);
        }
      }
      this.queueSyncPacket(out, ServerOpcode.NPC_CUSTOM_COLORS, ...payload);
    }
    const flags = npc.interactionFlags();
    if (flags !== 0) this.queueSyncPacket(out, ServerOpcode.NPC_INTERACTIONS, npc.id, flags);
    if (npc.nameOverride) this.queueEncodedSyncPacket(out, encodeStringPacket(ServerOpcode.NPC_NAME, npc.nameOverride, npc.id));
    if (npc.attackAnimOverride) this.queueEncodedSyncPacket(out, encodeStringPacket(ServerOpcode.NPC_ATTACK_ANIM, npc.attackAnimOverride, npc.id));
  }

  private sendWorldObjectUpdate(viewer: Player, obj: WorldObject): void {
    if (!this.canPlayerTargetObject(viewer, obj)) return;
    const packet = this.encodeWorldObjectUpdate(obj, viewer);
    try { viewer.ws.sendBinary(packet); } catch { /* connection closed */ }
  }

  private queueWorldObjectUpdate(out: SyncPacket[], viewer: Player, obj: WorldObject): void {
    if (!this.canPlayerTargetObject(viewer, obj)) return;
    this.queueEncodedSyncPacket(out, this.encodeWorldObjectUpdate(obj, viewer));
  }

  private encodeWorldObjectUpdate(obj: WorldObject, viewer?: Player): Uint8Array {
    const explicitTiles = viewer && obj.def.category === 'ladder' && obj.verticalLinks?.length
      ? this.ladderInteractionTilesForPlayer(viewer, obj).slice(0, 16)
      : this.explicitObjectInteractionTiles(obj).slice(0, 16);
    const tileValues = explicitTiles.flatMap(tile => [tile.x, tile.z]);
    const ladderActionMask = viewer && obj.def.category === 'ladder'
      ? this.ladderActionMaskForPlayer(viewer, obj)
      : 0;
    // [objectEntityId, objectDefId, x*10, z*10, depleted(0/1), interactionMask, rotY*1000, floor, y*10, explicitTileCount, ...tileX,tileZ, doorOpenDirection, doorLocked, ladderActionMask]
    return encodePacket(ServerOpcode.WORLD_OBJECT_SYNC,
      obj.id,
      obj.defId,
      qPos(obj.x),
      qPos(obj.z),
      obj.depleted ? 1 : 0,
      obj.interactionSides ?? 0,
      Math.round(obj.rotationY * 1000),
      obj.floor,
      qPos(obj.worldY),
      explicitTiles.length,
      ...tileValues,
      obj.doorOpenDirection,
      obj.doorLocked ? 1 : 0,
      ladderActionMask,
    );
  }

  private isGroundItemVisibleTo(viewer: Player, item: GroundItem): boolean {
    return item.mapLevel === viewer.currentMapLevel
      && (item.floor ?? 0) === viewer.currentFloor
      && (!item.ownerPlayerId || item.ownerPlayerId === viewer.id || (item.privateTicks ?? 0) <= 0);
  }

  private sendGroundItemUpdate(viewer: Player, item: GroundItem): void {
    if (!this.isGroundItemVisibleTo(viewer, item)) return;
    viewer.visibleEntityIds.add(item.id);
    this.sendToPlayer(viewer, ServerOpcode.GROUND_ITEM_SYNC,
      item.id,
      item.itemId,
      item.quantity,
      qPos(item.x),
      qPos(item.z),
      item.floor,
      qPos(this.floorWorldY(item.mapLevel, item.x, item.z, item.floor)),
    );
  }

  private queueGroundItemUpdate(out: SyncPacket[], viewer: Player, item: GroundItem): void {
    if (!this.isGroundItemVisibleTo(viewer, item)) return;
    viewer.visibleEntityIds.add(item.id);
    this.queueSyncPacket(out, ServerOpcode.GROUND_ITEM_SYNC,
      item.id,
      item.itemId,
      item.quantity,
      qPos(item.x),
      qPos(item.z),
      item.floor,
      qPos(this.floorWorldY(item.mapLevel, item.x, item.z, item.floor)),
    );
  }

  sendInventory(player: Player): void {
    // Batch: [slot0_itemId, slot0_qty, slot1_itemId, slot1_qty, ...] — 1 packet instead of 28
    const values: number[] = [];
    for (let i = 0; i < player.inventory.length; i++) {
      const slot = player.inventory[i];
      values.push(slot ? slot.itemId : 0, slot ? slot.quantity : 0);
    }
    this.sendToPlayer(player, ServerOpcode.PLAYER_INVENTORY_BATCH, ...values);
  }

  sendSkills(player: Player): void {
    // Batch: [skill0_level, skill0_currentLevel, skill0_xpHigh, skill0_xpLow, ...] — 1 packet instead of 13
    const values: number[] = [];
    for (let i = 0; i < ALL_SKILLS.length; i++) {
      const skill = player.skills[ALL_SKILLS[i]];
      values.push(skill.level, skill.currentLevel, (skill.xp >> 16) & 0xFFFF, skill.xp & 0xFFFF);
    }
    this.sendToPlayer(player, ServerOpcode.PLAYER_SKILLS_BATCH, ...values);
  }

  /** Send a single skill update (used for XP gains during gameplay) */
  private sendSingleSkill(player: Player, skillIndex: number): void {
    const skill = player.skills[ALL_SKILLS[skillIndex]];
    const xpHigh = (skill.xp >> 16) & 0xFFFF;
    const xpLow = skill.xp & 0xFFFF;
    this.sendToPlayer(player, ServerOpcode.PLAYER_SKILLS,
      skillIndex, skill.level, skill.currentLevel, xpHigh, xpLow
    );
  }

  sendEquipment(player: Player): void {
    // Batch: [slot0_itemId, slot1_itemId, ..., ammoQtyHigh, ammoQtyLow].
    const values: number[] = [];
    for (let i = 0; i < EQUIPMENT_SLOT_NAMES.length; i++) {
      values.push(player.equipment.get(EQUIPMENT_SLOT_NAMES[i]) ?? 0);
    }
    const ammoQuantity = player.getEquipmentQuantity('ammo');
    values.push((ammoQuantity >>> 16) & 0xFFFF, ammoQuantity & 0xFFFF);
    this.sendToPlayer(player, ServerOpcode.PLAYER_EQUIPMENT_BATCH, ...values);
  }

  /** Build PLAYER_REMOTE_EQUIPMENT packet for a subject player. Layout:
   *  [entityId, weapon, shield, head, body, legs, neck, ring, hands, feet, cape, ammo] */
  private encodeRemoteEquipment(subject: Player): Uint8Array {
    const values: number[] = [subject.id];
    for (let i = 0; i < EQUIPMENT_SLOT_NAMES.length; i++) {
      values.push(subject.equipment.get(EQUIPMENT_SLOT_NAMES[i]) ?? 0);
    }
    return encodePacket(ServerOpcode.PLAYER_REMOTE_EQUIPMENT, ...values);
  }

  /** Send a subject player's equipment to one viewer (for chunk-entry resync). */
  private sendRemoteEquipment(viewer: Player, subject: Player): void {
    if (viewer.disconnected) return;
    if (viewer.currentMapLevel !== subject.currentMapLevel || viewer.currentFloor !== subject.currentFloor) return;
    try { viewer.ws.sendBinary(this.encodeRemoteEquipment(subject)); } catch { /* connection closed */ }
  }

  /** Broadcast a subject player's equipment to every viewer near them on the
   *  same map. Called on equip/unequip so other clients see gear changes. */
  private broadcastRemoteEquipment(subject: Player): void {
    const cm = this.chunkManagers.get(subject.currentMapLevel);
    if (!cm) return;
    const packet = this.encodeRemoteEquipment(subject);
    cm.forEachPlayerNear(subject.position.x, subject.position.y, (pid) => {
      if (pid === subject.id) return;
      const viewer = this.players.get(pid);
      if (!viewer || viewer.disconnected || viewer.currentMapLevel !== subject.currentMapLevel || viewer.currentFloor !== subject.currentFloor) return;
      try { viewer.ws.sendBinary(packet); } catch { /* connection closed */ }
    });
  }

  /** Build PLAYER_REMOTE_STANCE packet. Layout: [entityId, stanceIdx]. */
  private encodeRemoteStance(subject: Player): Uint8Array {
    const idx = Math.max(0, STANCE_KEYS.indexOf(subject.stance));
    return encodePacket(ServerOpcode.PLAYER_REMOTE_STANCE, subject.id, idx);
  }

  /** Send a subject player's stance to one viewer (for chunk-entry resync). */
  private sendRemoteStance(viewer: Player, subject: Player): void {
    if (viewer.disconnected) return;
    if (viewer.currentMapLevel !== subject.currentMapLevel || viewer.currentFloor !== subject.currentFloor) return;
    try { viewer.ws.sendBinary(this.encodeRemoteStance(subject)); } catch { /* connection closed */ }
  }

  /** Broadcast a subject player's stance to every viewer near them on the same
   *  map. Called on stance change so other clients can pick the right attack
   *  animation (e.g. 2H + aggressive → smash). */
  private broadcastRemoteStance(subject: Player): void {
    const cm = this.chunkManagers.get(subject.currentMapLevel);
    if (!cm) return;
    const packet = this.encodeRemoteStance(subject);
    cm.forEachPlayerNear(subject.position.x, subject.position.y, (pid) => {
      if (pid === subject.id) return;
      const viewer = this.players.get(pid);
      if (!viewer || viewer.disconnected || viewer.currentMapLevel !== subject.currentMapLevel || viewer.currentFloor !== subject.currentFloor) return;
      try { viewer.ws.sendBinary(packet); } catch { /* connection closed */ }
    });
  }

  private encodePlayerAnimation(subject: Player): Uint8Array {
    return encodePacket(
      ServerOpcode.PLAYER_ANIMATION,
      subject.id,
      subject.animationKind,
      subject.animationVariant,
      subject.animationTargetId,
      subject.animationToolItemId,
    );
  }

  private sendRemoteAnimation(viewer: Player, subject: Player): void {
    if (viewer.disconnected) return;
    if (viewer.currentMapLevel !== subject.currentMapLevel || viewer.currentFloor !== subject.currentFloor) return;
    try { viewer.ws.sendBinary(this.encodePlayerAnimation(subject)); } catch { /* connection closed */ }
  }

  private setPlayerAnimation(
    subject: Player,
    kind: PlayerAnimationKind,
    variant: PlayerSkillAnimationVariant = PlayerSkillAnimationVariant.None,
    targetId: number = 0,
    includeSelf: boolean = false,
    toolItemId: number = 0,
  ): void {
    subject.animationKind = kind;
    subject.animationVariant = variant;
    subject.animationTargetId = targetId;
    subject.animationToolItemId = toolItemId;
    this.broadcastPlayerAnimationEvent(subject, kind, variant, targetId, includeSelf, toolItemId);
  }

  private broadcastPlayerAnimationEvent(
    subject: Player,
    kind: PlayerAnimationKind,
    variant: PlayerSkillAnimationVariant = PlayerSkillAnimationVariant.None,
    targetId: number = 0,
    includeSelf: boolean = false,
    toolItemId: number = 0,
  ): void {
    const cm = this.chunkManagers.get(subject.currentMapLevel);
    if (!cm) return;
    const packet = encodePacket(ServerOpcode.PLAYER_ANIMATION, subject.id, kind, variant, targetId, toolItemId);
    cm.forEachPlayerNear(subject.position.x, subject.position.y, (pid) => {
      if (!includeSelf && pid === subject.id) return;
      const viewer = this.players.get(pid);
      if (!viewer || viewer.disconnected || viewer.currentMapLevel !== subject.currentMapLevel || viewer.currentFloor !== subject.currentFloor) return;
      try { viewer.ws.sendBinary(packet); } catch { /* connection closed */ }
    });
  }

  private stopPlayerSkilling(playerId: number, player: Player): void {
    this.skillingActions.delete(playerId);
    this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
    this.setPlayerAnimation(player, PlayerAnimationKind.Idle, PlayerSkillAnimationVariant.None, 0);
  }

  /** Mark a world object as depleted, persist its respawn target, and tell
   *  nearby clients to swap to the depleted visual. Depleted rocks + tree
   *  stumps stay blocking — walking through a stump looks broken. */
  private persistAndBroadcastDepletion(obj: WorldObject): void {
    if (obj.depleted) return;
    obj.deplete();
    if (obj.respawnTimer > 0) {
      this.depletedObjectIds.add(obj.id);
      this.queueObjectRespawnSave(obj, Date.now() + obj.respawnTimer * TICK_RATE);
    } else {
      this.queueObjectRespawnClear(obj);
    }
    this.broadcastWorldObjectStateChange(obj);
  }

  private sendToPlayer(player: Player, opcode: ServerOpcode, ...values: number[]): void {
    if (player.disconnected) return;
    try {
      player.ws.sendBinary(encodePacket(opcode, ...values));
    } catch { /* connection closed */ }
  }

  getPlayer(id: number): Player | undefined {
    return this.players.get(id);
  }

  copyPlayerGearToNearestNpcSpawn(player: Player, maxDistance: number = 8): NpcGearPersistResult {
    const equipment = EQUIPMENT_SLOT_NAMES.map((slot) => player.equipment.get(slot) ?? 0);
    if (!equipment.some((itemId) => itemId > 0)) {
      return { ok: false, message: 'You have no equipped gear to copy.' };
    }

    let nearest: Npc | null = null;
    let nearestDistSq = Infinity;
    for (const [, npc] of this.npcs) {
      if (npc.currentMapLevel !== player.currentMapLevel) continue;
      const dx = npc.position.x - player.position.x;
      const dz = npc.position.y - player.position.y;
      const distSq = dx * dx + dz * dz;
      if (distSq < nearestDistSq) {
        nearest = npc;
        nearestDistSq = distSq;
      }
    }

    if (!nearest || nearestDistSq > maxDistance * maxDistance) {
      return { ok: false, message: `No NPC found within ${maxDistance} tiles.` };
    }

    const spawnsPath = resolve(MAPS_DIR, player.currentMapLevel, 'spawns.json');
    let spawnsFile: { npcs?: MutableNpcSpawn[]; objects?: unknown[]; items?: unknown[] };
    try {
      spawnsFile = JSON.parse(readFileSync(spawnsPath, 'utf-8')) as typeof spawnsFile;
    } catch (e) {
      return { ok: false, message: `Could not read ${player.currentMapLevel}/spawns.json: ${e instanceof Error ? e.message : e}` };
    }

    const spawns = spawnsFile.npcs ?? [];
    const spawn = this.findSpawnForRuntimeNpc(spawns, nearest);
    if (!spawn) {
      return { ok: false, message: `Could not match ${nearest.name} at ${nearest.spawnX.toFixed(1)}, ${nearest.spawnZ.toFixed(1)} to a saved spawn.` };
    }

    const playerAppearance = normalizeAppearance(player.appearance ?? DEFAULT_APPEARANCE);
    const appearance = isValidAppearance(playerAppearance)
      ? { ...playerAppearance }
      : { ...DEFAULT_APPEARANCE };

    const spawnAppearance = spawn.appearance ? normalizeAppearance(spawn.appearance) : null;
    spawn.appearance = spawnAppearance && isValidAppearance(spawnAppearance)
      ? spawnAppearance
      : appearance;
    spawn.equipment = equipment;

    nearest.appearance = spawn.appearance;
    nearest.equipment = equipment;

    try {
      const backupDir = resolve(MAPS_DIR, player.currentMapLevel, 'backups', 'npc-gear');
      mkdirSync(backupDir, { recursive: true });
      copyFileSync(spawnsPath, resolve(backupDir, `spawns.${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
      writeFileSync(spawnsPath, `${JSON.stringify(spawnsFile, null, 2)}\n`, 'utf-8');
    } catch (e) {
      return { ok: false, message: `Could not write ${player.currentMapLevel}/spawns.json: ${e instanceof Error ? e.message : e}` };
    }

    this.broadcastNpcStaticData(nearest);
    const spawnLabel = spawn.id != null ? `spawn ${spawn.id}` : `${nearest.spawnX.toFixed(1)}, ${nearest.spawnZ.toFixed(1)}`;
    return {
      ok: true,
      message: `Saved ${equipment.filter((itemId) => itemId > 0).length} equipped item(s) to ${nearest.name} (${spawnLabel}) in ${player.currentMapLevel}.`,
    };
  }

  private findSpawnForRuntimeNpc(spawns: MutableNpcSpawn[], npc: Npc): MutableNpcSpawn | null {
    let best: MutableNpcSpawn | null = null;
    let bestScore = Infinity;
    for (const spawn of spawns) {
      if (spawn.npcId !== npc.npcId) continue;
      const dx = spawn.x - npc.spawnX;
      const dz = spawn.z - npc.spawnZ;
      const score = dx * dx + dz * dz;
      if (score < bestScore) {
        best = spawn;
        bestScore = score;
      }
    }
    return bestScore <= 0.05 * 0.05 ? best : null;
  }

  private broadcastNpcStaticData(npc: Npc): void {
    const cm = this.chunkManagers.get(npc.currentMapLevel);
    if (!cm) return;
    // Encode once, reuse the buffers for every nearby viewer.
    const packets = this.buildNpcStaticPackets(npc);
    if (packets.length === 0) return;
    cm.forEachPlayerNear(npc.position.x, npc.position.y, (pid) => {
      const viewer = this.players.get(pid);
      if (!viewer || viewer.disconnected || viewer.currentMapLevel !== npc.currentMapLevel) return;
      this.sendEncodedPackets(viewer, packets);
    });
  }

  /** Convenience: get the default ('kcmap') map. Used by legacy callers
   *  that pre-date the multi-map system. */
  get map(): GameMap {
    return this.getMap('kcmap');
  }
}
