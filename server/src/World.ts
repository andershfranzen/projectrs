import { TICK_RATE, CHUNK_SIZE, MAX_STACK, STAIR_DESCENT_SEARCH_RADIUS, SPELL_CAST_DISTANCE, PROTOCOL_VERSION, ServerOpcode, EntityDeathKind, PlayerAnimationKind, PlayerSkillAnimationVariant, ALL_SKILLS, SKILL_NAMES, ASSET_TO_OBJECT_DEF, BLOCKING_DECOR_ASSETS, RELIC_ITEM_IDS, WallEdge, doorEdgeFromPlacement, doorClosedEdgeFromRotY, DOOR_EDGE_NEIGHBOR, TRADE_OFFER_SIZE, TRADE_REQUEST_RANGE, TRADE_REQUEST_TTL_MS, DUEL_STAKE_SIZE, getObjectFootprintTiles, getObjectInteractionTiles, isTileAdjacentToObject, localSidesToWorldSides, usesCornerInteractionTiles, CUSTOM_COLOR_SLOTS, DEFAULT_APPEARANCE, relicTierDef, type SkillId, type ItemDef, type PlayerAppearance, type WorldObjectDef, type SpawnEntry, isValidAppearance } from '@projectrs/shared';
import { audit } from './Audit';
import { BotStats } from './BotStats';
import { encodePacket, encodeStringPacket } from '@projectrs/shared';
import { addXp, statRandom, npcCombatLevel, magicMaxHit, osrsMeleeMaxHit, rollHit, ACC_BASE, STANCE_BONUSES, spellSchoolSkill } from '@projectrs/shared';
import { GameMap } from './GameMap';
import { Player, type EquipSlot } from './entity/Player';
import { Npc } from './entity/Npc';
import { WorldObject } from './entity/WorldObject';
import { DataLoader } from './data/DataLoader';
import { GameDatabase } from './Database';
import { processPlayerCombat, processPlayerRangedCombat, processNpcCombat, rollLoot, RANGED_ATTACK_DISTANCE } from './combat/Combat';
import { broadcastLocalMessage, broadcastPlayerInfo, sendSystemMessageToUser } from './network/ChatSocket';
import { ServerChunkManager } from './ChunkManager';
import { QuestService } from './quest/QuestService';
import { consumeSpellCosts } from './magic/SpellCosts';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { ServerWebSocket } from 'bun';

/** Map string IDs to small integers for blockedObjectTiles encoding */
const mapIdRegistry: Map<string, number> = new Map();

const USE_NO_RECIPE_REPLY = 'Nothing interesting happens.';
let nextMapIdx = 0;
function getMapIdx(mapId: string): number {
  let idx = mapIdRegistry.get(mapId);
  if (idx === undefined) { idx = nextMapIdx++; mapIdRegistry.set(mapId, idx); }
  return idx;
}
/** Encode map+floor+tile into a stable object-blocker key. */
function blockedKey(mapIdx: number, floor: number, tileX: number, tileZ: number): string {
  return `${mapIdx}|${Math.max(0, Math.floor(floor))}|${Math.floor(tileX)}|${Math.floor(tileZ)}`;
}
const HITPOINTS_SKILL_INDEX = ALL_SKILLS.indexOf('hitpoints' as SkillId);

// ---------------------------------------------------------------------------
// Wire-format / timing constants
// ---------------------------------------------------------------------------

/** World coordinates are quantized to 0.1-tile units for int16 packet fields. */
const POSITION_SCALE = 10;
/** Quantize a world coordinate to the int16 wire format (1 unit = 0.1 tile). */
function qPos(coord: number): number { return Math.round(coord * POSITION_SCALE); }

/** Default respawn time (ticks) for world objects whose def omits `respawnTime`.
 *  At 600ms/tick this is ~2 minutes. */
const DEFAULT_OBJECT_RESPAWN_TICKS = 200;
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
const PLAYER_NPC_INTERACTION_PATH_SEARCH_STEPS = 800;
const PLAYER_FOLLOW_PATH_SEARCH_STEPS = 800;

/** Canonical ordering of equipment slots used for binary opcode encoding.
 *  Must stay in sync with the client-side decoder in GameManager. */
const EQUIPMENT_SLOT_NAMES: EquipSlot[] = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];
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
}

interface RuntimeObjectSpawn {
  objectId: number;
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
  interactionTiles?: WorldObject['interactionTiles'];
  interactionSides?: number;
}

type NpcPathCapableMap = GameMap & {
  findPathForNpc?: (
    startX: number,
    startZ: number,
    goalX: number,
    goalZ: number,
    tileBlocked: (x: number, z: number) => boolean,
    maxSearchSteps?: number,
    wallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean,
  ) => { x: number; z: number }[];
};

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

const GROUND_ITEM_ENTITY_ID_MIN = 20000;
const GROUND_ITEM_ENTITY_ID_MAX = 32760;
let nextGroundItemId = GROUND_ITEM_ENTITY_ID_MIN;

export class World {
  readonly maps: Map<string, GameMap> = new Map();
  readonly chunkManagers: Map<string, ServerChunkManager> = new Map();
  readonly data: DataLoader;
  readonly db: GameDatabase;
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
  private entityTileOccupants: Set<string> = new Set();

  private currentTick: number = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;
  private nextDialogueSessionId: number = 1;
  private dialogueScheduledSteps: DialogueScheduledStep[] = [];
  private objectSayScheduledLines: ObjectSayScheduledLine[] = [];

  // Player combat targets (playerId -> npcId)
  private playerCombatTargets: Map<number, number> = new Map();
  // Reverse lookup: npcId -> set of playerIds targeting it (kept in sync with playerCombatTargets)
  private npcTargetedBy: Map<number, Set<number>> = new Map();

  /** Ground items with active despawn timers (avoids iterating all permanent items) */
  private despawningItemIds: Set<number> = new Set();

  /** World objects currently depleted and awaiting respawn */
  private depletedObjectIds: Set<number> = new Set();

  /** Reusable set for health regen — avoids allocation every regen tick */
  private _playersUnderNpcAttack: Set<number> = new Set();

  // Skilling: player -> { objectId, action, cycleTime, toolItemId, toolBonus }
  // cycleTime = inter-roll period in ticks (computed once at interaction start).
  // Per-player roll tick lives on Player.actionDelay (RS2 %action_delay varp).
  private skillingActions: Map<number, { objectId: number; action: string; cycleTime: number; toolItemId?: number; toolBonus?: number }> = new Map();

  private static readonly DEFAULT_MINING_RATE = 7;
  private static readonly MINING_TOOL_ACCURACY_BONUS = 8;

  /**
   * Damage queued by a spell cast, fired on the tick the projectile visually
   * arrives. We roll damage at cast time (so the result is settled even if the
   * target moves) but defer application so the hit splat matches the visual.
   */
  private pendingSpellImpacts: {
    impactTick: number;
    attackerId: number;
    targetId: number;
    damage: number;
    spellId: string;
    /** Skill to credit XP to on hit. Captured at cast time so a mid-flight
     *  spell def reload couldn't reroute XP to a different school. */
    xpSkill: SkillId;
    mapLevel: string;
    floor: number;
  }[] = [];

  constructor(db: GameDatabase) {
    this.db = db;
    this.data = new DataLoader();
    this.quests = new QuestService(this.data, {
      sendToPlayer: (player, opcode, ...values) => this.sendToPlayer(player, opcode, ...values),
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
      `${mapLevel}|${defId}|${tileX}|${tileZ}|${Math.max(0, Math.floor(floor))}`;
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
        this.setObjectTilesBlocked(mapId, obj.x, obj.z, obj.def, false, obj.floor);
        this.worldObjects.delete(id);
      }
    }

    // Re-spawn NPCs and world objects
    const spawns = this.data.loadSpawns(mapId);
    for (const spawn of spawns.npcs ?? []) {
      const npcDef = this.data.getNpc(spawn.npcId);
      if (!npcDef) continue;
      // Per-spawn shop/dialogue fully replace the def's (no field-merge).
      // Falls through: spawn override → def → legacy shops.json (shop only).
      const effShop = spawn.shop ?? this.data.getShop(spawn.npcId) ?? null;
      const effDialogue = spawn.dialogue ?? npcDef.dialogue ?? null;
      const npc = new Npc(npcDef, spawn.x, spawn.z, spawn.wanderRange,
        spawn.appearance ?? null, spawn.equipment ?? null, spawn.aggressive ?? null,
        effShop, effDialogue, spawn.name ?? null,
        spawn.stats ?? null, spawn.customColors ?? null,
        spawn.attackAnim ?? null);
      npc.currentMapLevel = mapId;
      npc.currentFloor = this.resolveAuthoredFloor(gameMap, spawn.x, spawn.z, spawn.y, spawn.floor).floor;
      this.npcs.set(npc.id, npc);
      cm.addEntity(npc.id, spawn.x, spawn.z);
    }
    const objectSpawns = this.collectObjectSpawns(mapId, gameMap, spawns.objects ?? []);
    for (const spawn of objectSpawns) {
      const objDef = this.data.getObject(spawn.objectId);
      if (!objDef) continue;
      const obj = this.createWorldObject(objDef, spawn, mapId);
      this.worldObjects.set(obj.id, obj);
      this.setObjectTilesBlocked(mapId, spawn.x, spawn.z, objDef, true, obj.floor);
      if (objDef.category === 'door') {
        this.initializeDoorObject(obj, gameMap);
      }
      cm.addEntity(obj.id, spawn.x, spawn.z);
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
    for (const item of spawns.items ?? []) {
      const id = this.allocateGroundItemId();
      if (id === null) continue;
      const groundItem: GroundItem = {
        id,
        itemId: item.itemId,
        quantity: item.quantity ?? 1,
        x: item.x,
        z: item.z,
        floor: this.resolveAuthoredFloor(gameMap, item.x, item.z, item.y, item.floor).floor,
        mapLevel: mapId,
        despawnTimer: -1,
      };
      this.groundItems.set(groundItem.id, groundItem);
      cm.addEntity(groundItem.id, groundItem.x, groundItem.z);
    }

    // Re-register players on this map
    for (const [id, player] of this.players) {
      if (player.currentMapLevel === mapId) {
        cm.addEntity(id, player.position.x, player.position.y);
        cm.registerPlayer(id);
      }
    }
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
      if (npc && this.canPlayerTargetNpc(player, npc)) {
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
      const floor = Math.max(0, Math.floor(authoredFloor!));
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
      && (npc.currentFloor ?? 0) === player.currentFloor;
  }

  canPlayerTargetObject(player: Player, obj: WorldObject): boolean {
    if (obj.mapLevel !== player.currentMapLevel) return false;
    if ((obj.floor ?? 0) === player.currentFloor) return true;
    return obj.def.category === 'ladder' && this.canPlayerUseLadderOnCurrentFloor(player, obj);
  }

  canPlayerTargetGroundItem(player: Player, item: GroundItem): boolean {
    return item.mapLevel === player.currentMapLevel
      && (item.floor ?? 0) === player.currentFloor
      && this.isGroundItemVisibleTo(player, item);
  }

  private canPlayerUseLadderOnCurrentFloor(player: Player, obj: WorldObject): boolean {
    const map = this.maps.get(obj.mapLevel);
    if (!map) return false;
    const seen = new Set<string>();
    const positions: { x: number; z: number }[] = [];
    const add = (x: number, z: number): void => {
      const pos = { x: Math.floor(x) + 0.5, z: Math.floor(z) + 0.5 };
      const key = `${pos.x},${pos.z}`;
      if (seen.has(key)) return;
      seen.add(key);
      positions.push(pos);
    };
    add(obj.x, obj.z);
    for (const tile of this.objectInteractionTiles(obj)) add(tile.x, tile.z);
    return positions.some(pos =>
      map.getWalkableFloorTargetsAt(pos.x, pos.z).some(target => target.floor === player.currentFloor),
    );
  }

  /** Path from the player to the NPC's interaction surface. Targets the
   *  closest reachable cardinal-adjacent interaction tile directly, avoiding
   *  post-path trimming that breaks compressed corner paths. */
  private findPlayerPathToNpc(player: Player, npc: Npc): { x: number; z: number }[] {
    const map = this.getPlayerMap(player);
    const ps = player.position;
    const footprint = getObjectFootprintTiles(npc.position.x, npc.position.y, { width: npc.size });
    const candidates = npc.interactionTiles()
      .filter(tile => this.npcInteractionTileHasLineOfWalk(player, map, footprint, tile.x, tile.z));
    // Sort in place by Chebyshev to the player so the closest candidate is
    // tried first — for the common case (player already standing next to the
    // mob) this returns after a single findPathOnFloor call.
    candidates.sort((a, b) => {
      const da = Math.max(Math.abs((a.x + 0.5) - ps.x), Math.abs((a.z + 0.5) - ps.y));
      const db = Math.max(Math.abs((b.x + 0.5) - ps.x), Math.abs((b.z + 0.5) - ps.y));
      return da - db;
    });
    const floor = player.currentFloor;
    const playerTileBlocker = (x: number, z: number): boolean => {
      return this.isPlayerMovementTileBlocked(player, map, x, z, floor);
    };
    const playerWallBlocker = floor === 0
      ? (fx: number, fz: number, tx: number, tz: number) => map.isWallBlocked(fx, fz, tx, tz, player.effectiveY)
      : (fx: number, fz: number, tx: number, tz: number) => map.isWallBlockedOnFloor(fx, fz, tx, tz, floor);
    const pathMap = map as NpcPathCapableMap;
    const findPathForPlayer = typeof pathMap.findPathForNpc === 'function'
      ? (sx: number, sz: number, gx: number, gz: number) => pathMap.findPathForNpc!(
          sx,
          sz,
          gx,
          gz,
          playerTileBlocker,
          PLAYER_NPC_INTERACTION_PATH_SEARCH_STEPS,
          playerWallBlocker,
        )
      : (sx: number, sz: number, gx: number, gz: number) => map.findPathOnFloor(sx, sz, gx, gz, floor);
    for (const t of candidates) {
      if (Math.floor(ps.x) === t.x && Math.floor(ps.y) === t.z) return [];
      const path = findPathForPlayer(ps.x, ps.y, t.x + 0.5, t.z + 0.5);
      if (path.length > 0) return path;
    }
    return [];
  }

  private npcInteractionTileHasLineOfWalk(
    player: Player,
    map: GameMap,
    footprint: { x: number; z: number }[],
    tileX: number,
    tileZ: number,
  ): boolean {
    for (const foot of footprint) {
      if (Math.abs(foot.x - tileX) + Math.abs(foot.z - tileZ) !== 1) continue;
      const blocked = player.currentFloor === 0
        ? map.isWallBlocked(tileX, tileZ, foot.x, foot.z, player.effectiveY)
        : map.isWallBlockedOnFloor(tileX, tileZ, foot.x, foot.z, player.currentFloor);
      if (!blocked) return true;
    }
    return false;
  }

  private isPlayerNpcInteractionReachable(player: Player, npc: Npc): boolean {
    if (!this.canPlayerTargetNpc(player, npc)) return false;
    const map = this.getPlayerMap(player);
    const ptx = Math.floor(player.position.x);
    const ptz = Math.floor(player.position.y);
    if (this.isBankerReachableAcrossBooth(player, npc, ptx, ptz)) return true;
    if (!npc.isInteractionTile(ptx, ptz)) return false;
    const footprint = getObjectFootprintTiles(npc.position.x, npc.position.y, { width: npc.size });
    for (const tile of npc.interactionTiles()) {
      if (tile.x !== ptx || tile.z !== ptz) continue;
      if (!this.npcInteractionTileHasLineOfWalk(player, map, footprint, tile.x, tile.z)) continue;
      return true;
    }
    return false;
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
    for (const candidate of candidates) {
      if (Math.floor(player.position.x) === candidate.useTile.x && Math.floor(player.position.y) === candidate.useTile.z) return [];
      const path = player.currentFloor === 0
        ? map.findPathForNpc(
            player.position.x,
            player.position.y,
            candidate.useTile.x + 0.5,
            candidate.useTile.z + 0.5,
            (x, z) => this.isPlayerMovementTileBlocked(player, map, x, z, player.currentFloor),
            PLAYER_NPC_INTERACTION_PATH_SEARCH_STEPS,
            (fx, fz, tx, tz) => map.isWallBlocked(fx, fz, tx, tz, player.effectiveY),
          )
        : map.findPathForNpc(
            player.position.x,
            player.position.y,
            candidate.useTile.x + 0.5,
            candidate.useTile.z + 0.5,
            (x, z) => this.isPlayerMovementTileBlocked(player, map, x, z, player.currentFloor),
            PLAYER_NPC_INTERACTION_PATH_SEARCH_STEPS,
            (fx, fz, tx, tz) => map.isWallBlockedOnFloor(fx, fz, tx, tz, player.currentFloor),
          );
      if (path.length > 0) return path;
    }
    return null;
  }

  private findBankerAcrossBooth(player: Player, booth: WorldObject): Npc | null {
    const ptx = Math.floor(player.position.x);
    const ptz = Math.floor(player.position.y);
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

  private queuePlayerPathToNpcRange(player: Player, npc: Npc, range: number): boolean {
    const path = this.findPlayerPathToNpc(player, npc);
    if (path.length === 0) return false;

    let cutIdx = path.length;
    for (let i = 0; i < path.length; i++) {
      const fp = npc.distToFootprint(path[i].x, path[i].z);
      if (Math.hypot(fp.dx, fp.dz) <= range) {
        cutIdx = i + 1;
        break;
      }
    }

    const queue = path.slice(0, cutIdx);
    if (queue.length === 0) return false;
    player.setMoveQueue(queue);
    return true;
  }

  private isPlayerInNpcAttackRange(player: Player, npc: Npc, mode: 'melee' | 'ranged' | 'magic'): boolean {
    if (mode === 'melee') return this.isPlayerNpcInteractionReachable(player, npc);
    const fp = npc.distToFootprint(player.position.x, player.position.y);
    const dist = Math.sqrt(fp.dx * fp.dx + fp.dz * fp.dz);
    const range = mode === 'magic' ? SPELL_CAST_DISTANCE : RANGED_ATTACK_DISTANCE;
    return dist <= range;
  }

  private setObjectTilesBlocked(mapId: string, x: number, z: number, def: WorldObjectDef, blocked: boolean, floor: number = 0): void {
    if (!def.blocking || def.category === 'door') return;
    for (const tile of getObjectFootprintTiles(x, z, def)) {
      const key = this.blockedKeyFor(mapId, tile.x, tile.z, floor);
      if (blocked) this.blockedObjectTiles.add(key);
      else this.blockedObjectTiles.delete(key);
    }
  }

  private isTileBlockedForPlayer(player: Player, map: GameMap, tileX: number, tileZ: number): boolean {
    if (player.currentFloor !== 0) {
      return map.isTileBlockedOnFloor(tileX, tileZ, player.currentFloor)
        || this.blockedObjectTiles.has(this.blockedKeyFor(player.currentMapLevel, tileX, tileZ, player.currentFloor));
    }
    return map.isBlocked(tileX, tileZ) || this.blockedObjectTiles.has(this.blockedKeyFor(player.currentMapLevel, tileX, tileZ, player.currentFloor));
  }

  private isPlayerMovementTileBlocked(
    player: Player,
    map: GameMap,
    tileX: number,
    tileZ: number,
    floor: number = player.currentFloor,
  ): boolean {
    const tileKey = this.blockedKeyFor(player.currentMapLevel, tileX, tileZ, floor);
    const staticBlocked = floor === 0
      ? map.isBlocked(tileX, tileZ) || this.blockedObjectTiles.has(tileKey)
      : map.isTileBlockedOnFloor(tileX, tileZ, floor) || this.blockedObjectTiles.has(tileKey);
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

  private explicitObjectInteractionTiles(obj: WorldObject): { x: number; z: number }[] {
    if (!obj.interactionTiles?.length) return [];
    const baseX = Math.floor(obj.x);
    const baseZ = Math.floor(obj.z);
    const seen = new Set<string>();
    const out: { x: number; z: number }[] = [];
    for (const local of obj.interactionTiles) {
      if (!Number.isFinite(local.x) || !Number.isFinite(local.z)) continue;
      const rotated = this.rotateLocalInteractionTile({ x: Math.round(local.x), z: Math.round(local.z) }, obj.rotationY);
      const tile = { x: baseX + rotated.x, z: baseZ + rotated.z };
      const key = `${tile.x},${tile.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tile);
    }
    return out;
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

  private findPathToObjectInteraction(player: Player, obj: WorldObject): { x: number; z: number }[] {
    const map = this.getPlayerMap(player);
    const candidates = this.objectInteractionTiles(obj)
      .filter(tile => !this.isTileBlockedForPlayer(player, map, tile.x, tile.z))
      .sort((a, b) => {
        const ad = Math.abs(player.position.x - (a.x + 0.5)) + Math.abs(player.position.y - (a.z + 0.5));
        const bd = Math.abs(player.position.x - (b.x + 0.5)) + Math.abs(player.position.y - (b.z + 0.5));
        return ad - bd;
      });

    for (const tile of candidates) {
      const goalX = tile.x + 0.5;
      const goalZ = tile.z + 0.5;
      const path = player.currentFloor === 0
        ? map.findPathForNpc(
            player.position.x,
            player.position.y,
            goalX,
            goalZ,
            (x, z) => this.isPlayerMovementTileBlocked(player, map, x, z, player.currentFloor),
            800,
            (fx, fz, tx, tz) => map.isWallBlocked(fx, fz, tx, tz, player.effectiveY),
          )
        : map.findPathForNpc(
            player.position.x,
            player.position.y,
            goalX,
            goalZ,
            (x, z) => this.isPlayerMovementTileBlocked(player, map, x, z, player.currentFloor),
            800,
            (fx, fz, tx, tz) => map.isWallBlockedOnFloor(fx, fz, tx, tz, player.currentFloor),
          );
      if (path.length > 0) return path;
    }

    return [];
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
        // Resolve effective shop/dialogue once per spawn — Npc caches these
        // so right-click handlers + interactionFlags() don't re-traverse defs.
        const effShop = spawn.shop ?? this.data.getShop(spawn.npcId) ?? null;
        const effDialogue = spawn.dialogue ?? npcDef.dialogue ?? null;
        const npc = new Npc(
          npcDef,
          spawn.x,
          spawn.z,
          spawn.wanderRange,
          spawn.appearance ?? null,
          spawn.equipment ?? null,
          spawn.aggressive ?? null,
          effShop,
          effDialogue,
          spawn.name ?? null,
          spawn.stats ?? null,
          spawn.customColors ?? null,
          spawn.attackAnim ?? null,
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
        cm.addEntity(npc.id, spawn.x, spawn.z);
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
        this.setObjectTilesBlocked(mapId, spawn.x, spawn.z, objDef, true, obj.floor);
        if (objDef.category === 'door') {
          this.initializeDoorObject(obj, gameMap);
        }
        const cm = this.chunkManagers.get(mapId);
        if (cm) cm.addEntity(obj.id, spawn.x, spawn.z);
      }
      console.log(`Spawned objects for map '${mapId}'`);
    }
    console.log(`Total world objects: ${this.worldObjects.size}`);

    // Spawn ground items from spawns.json
    let itemCount = 0;
    for (const [mapId] of this.maps) {
      const spawns = this.data.loadSpawns(mapId);
      for (const item of spawns.items ?? []) {
        const id = this.allocateGroundItemId();
        if (id === null) continue;
        const groundItem: GroundItem = {
          id,
          itemId: item.itemId,
          quantity: item.quantity ?? 1,
          x: item.x,
          z: item.z,
          floor: this.resolveAuthoredFloor(this.maps.get(mapId)!, item.x, item.z, item.y, item.floor).floor,
          mapLevel: mapId,
          despawnTimer: -1, // permanent spawn
        };
        this.groundItems.set(groundItem.id, groundItem);
        const cm = this.chunkManagers.get(mapId);
        if (cm) cm.addEntity(groundItem.id, groundItem.x, groundItem.z);
        itemCount++;
      }
    }
    if (itemCount > 0) console.log(`Spawned ${itemCount} ground items from spawns`);
  }

  private collectObjectSpawns(
    mapId: string,
    gameMap: GameMap,
    fallbackObjects: ReadonlyArray<{ objectId: number; x: number; z: number; y?: number; floor?: number; rotY?: number }>,
  ): RuntimeObjectSpawn[] {
    const objectSpawns: RuntimeObjectSpawn[] = [];
    for (const placed of gameMap.placedObjects ?? []) {
      const defId = ASSET_TO_OBJECT_DEF[placed.assetId];
      if (defId != null) {
        objectSpawns.push({
          objectId: defId,
          x: placed.position.x,
          z: placed.position.z,
          y: placed.position.y,
          rotY: placed.rotation?.y,
          name: placed.name,
          examineText: placed.examineText,
          interactions: placed.interactions,
          defaultOpen: placed.defaultOpen === true,
          openDirection: placed.openDirection === 1 ? 1 : -1,
          locked: placed.locked === true,
          keyItemId: Number.isInteger(placed.keyItemId) ? placed.keyItemId : undefined,
          consumeKey: placed.consumeKey === true,
          lockedMessage: placed.lockedMessage,
          altarTier: Number.isInteger(placed.altarTier) ? placed.altarTier : undefined,
          trigger: placed.trigger,
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
      : { floor: Math.max(0, Math.floor(spawn.floor ?? 0)), y: spawn.y ?? 0 };
    const obj = new WorldObject(objDef, spawn.x, spawn.z, mapId, resolved.floor, resolved.y);
    if (spawn.rotY != null) obj.rotationY = spawn.rotY;
    if (spawn.name) obj.name = spawn.name;
    if (spawn.examineText) obj.examineText = spawn.examineText;
    if (spawn.interactions) obj.interactions = spawn.interactions;
    if (spawn.defaultOpen) obj.doorDefaultOpen = true;
    if (spawn.openDirection === 1) obj.doorOpenDirection = 1;
    if (spawn.locked) obj.doorLocked = true;
    if (Number.isInteger(spawn.keyItemId) && spawn.keyItemId! > 0) obj.doorKeyItemId = spawn.keyItemId!;
    if (spawn.consumeKey) obj.doorConsumeKey = true;
    if (spawn.lockedMessage) obj.doorLockedMessage = spawn.lockedMessage;
    if (Number.isInteger(spawn.altarTier) && spawn.altarTier! > 0) obj.altarTier = Math.max(1, Math.floor(spawn.altarTier!));
    if (spawn.trigger) obj.trigger = spawn.trigger;
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
   *  elevation as the roof/elevated-floor gate. The client's reported Y is
   *  only a login recovery hint for older rows that predate reliable floor
   *  persistence. */
  private computeEffectiveY(player: Player): number {
    const map = this.getPlayerMap(player);
    return map.getEffectiveHeightOnFloor(
      player.position.x, player.position.y, player.currentFloor,
      player.effectiveY,
    );
  }

  /** Re-derive the player's server-authoritative walking elevation after a
   *  tile change. The prior effectiveY feeds getEffectiveHeightOnFloor's
   *  roof-tile gate, so the player only "sticks" to an elevated surface once
   *  they have actually climbed onto it via stair ramp tiles (whose height
   *  is reported ungated). Mirrors the client's per-frame
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

  private sendFloorChange(player: Player): void {
    this.sendToPlayer(player, ServerOpcode.FLOOR_CHANGE, player.currentFloor, qPos(player.effectiveY));
  }

  private checkpointPlayerPosition(player: Player): void {
    this.db.savePlayerPosition(player.accountId, player, this.computeEffectiveY(player));
    player.lastPositionPersistTick = this.currentTick;
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
    player.openShopNpcId = null;
    player.requestIdleLogout = false;
    player.disconnected = false;
    player.reconnectDeadlineTick = 0;
    player.logoutDeadlineTick = 0;
    this.closeDialogueForPlayer(player, false);
    this.finalizePlayerLogoutSession(player);

    this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));
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
        cm.addEntity(player.id, player.position.x, player.position.y);
        cm.registerPlayer(player.id);
      }

      audit({
        type: 'account.reconnect',
        tick: this.currentTick,
        accountId: player.accountId,
        details: { name: player.name, ip: player.ip, deviceId: player.deviceId, loginRowId: player.loginRowId },
      });

      this.sendLoginBootstrap(player);
      broadcastPlayerInfo(player.id, player.name);
      for (const [, other] of this.players) {
        if (other.id !== player.id) broadcastPlayerInfo(other.id, other.name);
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
    cm.addEntity(player.id, player.position.x, player.position.y);
    cm.registerPlayer(player.id);
    player.currentChunkX = Math.floor(player.position.x / CHUNK_SIZE);
    player.currentChunkZ = Math.floor(player.position.y / CHUNK_SIZE);

    this.sendLoginBootstrap(player);

    // Broadcast player name to all chat sockets
    broadcastPlayerInfo(player.id, player.name);
    for (const [, other] of this.players) {
      if (other.id !== player.id) {
        broadcastPlayerInfo(other.id, other.name);
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
    // Login is the one place where the persisted visual Y is useful: it lets
    // us recover old/bad rows where the player was saved on an upper walking
    // plane with floor=0. After this bootstrap, gameplay and persistence use
    // player.effectiveY so CLIENT_POSITION_Y cannot spoof floor changes.
    let spawnY = playerMap.getEffectiveHeightOnFloor(
      player.position.x,
      player.position.y,
      player.currentFloor,
      player.reportedY,
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
    // floor, so the persisted Y is the only reliable signal for which plane
    // the player logged out on. If the player actually logged out upstairs,
    // saved/reportedY is already high enough for getEffectiveHeightOnFloor's
    // gate to return the elevated surface.
    // Seed the server-authoritative collision elevation from the resolved
    // spawn height so the first move after (re)login gates wall edges on the
    // correct Y. Covers both fresh login and grace-period reconnect — both
    // routes call sendLoginBootstrap.
    player.effectiveY = spawnY;
    player.reportedY = spawnY;
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

    if (!player.appearance) {
      this.openCharacterCreatorFor(player);
    }

    // Quest snapshot — sent unconditionally; the client renders an empty
    // log when the record is {}. Subsequent stage advances arrive as
    // QUEST_STAGE_ADVANCED deltas.
    this.quests.sendQuestStateSync(player);
    this.sendToPlayer(player, ServerOpcode.RENOWN_SYNC, player.renown);
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

  /** Interrupt the player's active or queued world action before another
   *  deliberate action mutates state. Movement has its own path because it is
   *  itself the cancel signal; this covers inventory/equipment/item actions
   *  that can happen while standing still or while walking toward an object. */
  private interruptPlayerAction(playerId: number, player: Player, keepNpcUiContext: boolean = false): void {
    this.clearPendingObjectIntents(player);
    player.pendingPickup = -1;
    player.followTargetPlayerId = -1;
    player.actionDelay = 0;
    if (!keepNpcUiContext) {
      this.closeNpcUiContext(player);
    }
    this.cancelSkilling(playerId);
  }

  private clearPendingObjectIntents(player: Player): void {
    player.pendingInteraction = null;
    player.pendingUseItemOnObject = null;
    player.pendingUseItemOnNpc = null;
  }

  private closeNpcUiContext(player: Player): void {
    player.openShopNpcId = null;
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

    this.players.delete(playerId);
    this.skillingActions.delete(playerId);
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
    player.openShopNpcId = null;
    this.closeDialogueForPlayer(player, false);
    player.clearMoveQueue();
    player.pendingPickup = -1;
    this.clearPendingObjectIntents(player);
    player.delayedUntilTick = 0;
    this.cancelSkilling(playerId);
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
    this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));
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
    player.pendingPickup = -1;
    this.clearPendingObjectIntents(player);
    player.delayedUntilTick = 0;
    this.cancelSkilling(player.id);
    this.clearCombatTarget(player.id);
    this.setPlayerAnimation(player, PlayerAnimationKind.Idle, PlayerSkillAnimationVariant.None, 0);
    player.disconnected = true;
    player.requestIdleLogout = true;
    player.reconnectDeadlineTick = 0;
    player.logoutDeadlineTick = this.currentTick + DISCONNECTED_COMBAT_LOGOUT_TICKS;
    this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));
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
    const syncPacket = this.encodeWorldObjectUpdate(obj);
    cm.forEachPlayerNear(obj.x, obj.z, (pid) => {
      const player = this.players.get(pid);
      if (!player || player.disconnected || player.currentMapLevel !== obj.mapLevel || player.currentFloor !== obj.floor) return;
      try {
        player.ws.sendBinary(eventPacket);
        player.ws.sendBinary(syncPacket);
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
      // openShopNpcId is keyed by def id, not entity id — two NPCs of the
      // same def in the same area would both freeze when one is shopped at,
      // which is acceptable (rare, and the wrong-direction facing risk is
      // worse than the standing-still cost).
      if (player.openShopNpcId === npc.npcId && player.currentMapLevel === npc.currentMapLevel && player.currentFloor === npc.currentFloor) return true;
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
    if (player) {
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
        this.setPlayerAnimation(player, PlayerAnimationKind.Idle, PlayerSkillAnimationVariant.None, 0);
      }
    }
  }

  private handleNpcDeath(npc: Npc): void {
    const targeters = this.npcTargetedBy.get(npc.id);
    if (targeters) {
      for (const playerId of [...targeters]) this.clearCombatTarget(playerId);
    }

      this.broadcastNearbyOnFloor(npc.currentMapLevel, npc.currentFloor, npc.position.x, npc.position.y, ServerOpcode.ENTITY_DEATH, npc.id, EntityDeathKind.Death);

    const cm = this.chunkManagers.get(npc.currentMapLevel);
    if (cm) cm.removeEntity(npc.id);
    for (const [, player] of this.players) {
      player.visibleEntityIds.delete(npc.id);
    }
  }

  private handleNpcRespawn(npc: Npc): void {
    const cm = this.chunkManagers.get(npc.currentMapLevel);
    if (cm) cm.addEntity(npc.id, npc.position.x, npc.position.y);
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
      this.clearPendingObjectIntents(player);
      player.pendingTalkNpcId = -1;
      player.pendingTalkRepathTicks = 0;
      player.followTargetPlayerId = -1;
    }
    for (const [, npc] of this.npcs) {
      if (npc.combatTarget?.id === playerId) {
        npc.combatTarget = null;
        npc.pathQueue.length = 0;
      }
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
    if (!this.entityTileOccupants) this.entityTileOccupants = new Set();
    this.entityTileOccupants.clear();
    for (const [, player] of this.players) {
      if (player.disconnected) continue;
      const key = this.blockedKeyFor(player.currentMapLevel, player.position.x, player.position.y, player.currentFloor);
      this.entityTileOccupants.add(key);
    }
    for (const [, npc] of this.npcs) {
      if (npc.dead) continue;
      const size = Math.max(1, npc.size | 0);
      if (size === 1) {
        this.entityTileOccupants.add(
          this.blockedKeyFor(npc.currentMapLevel, npc.position.x, npc.position.y, npc.currentFloor),
        );
        continue;
      }
      // Multi-tile NPCs: anchor + (size-1)/2 offset matches the chase blocker math.
      const ax = Math.floor(npc.position.x);
      const az = Math.floor(npc.position.y);
      const minX = ax - Math.floor((size - 1) / 2);
      const minZ = az - Math.floor((size - 1) / 2);
      for (let i = 0; i < size; i++) {
        for (let j = 0; j < size; j++) {
          this.entityTileOccupants.add(
            this.blockedKeyFor(npc.currentMapLevel, minX + i, minZ + j, npc.currentFloor),
          );
        }
      }
    }
  }

  /** Check if player is on a valid interaction tile for the object. */
  private isAdjacentToObject(player: Player, obj: WorldObject): boolean {
    if (!this.canPlayerTargetObject(player, obj)) return false;
    const ptx = Math.floor(player.position.x);
    const ptz = Math.floor(player.position.y);
    const otx = Math.floor(obj.x);
    const otz = Math.floor(obj.z);
    // Doors: player must be on the door tile or the tile the door faces into
    if (obj.def.category === 'door') {
      return (ptx === otx && ptz === otz) || (Math.abs(ptx - otx) + Math.abs(ptz - otz) === 1);
    }
    const explicit = this.explicitObjectInteractionTiles(obj);
    if (explicit.length > 0) return explicit.some(tile => tile.x === ptx && tile.z === ptz);
    return isTileAdjacentToObject(ptx, ptz, obj.x, obj.z, obj.def, {
      allowedWorldSides: obj.interactionSides
        ? localSidesToWorldSides(obj.interactionSides, obj.rotationY, obj.def.width)
        : undefined,
      includeCorners: this.usesCornerObjectInteraction(obj),
    });
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
      player.clearMoveQueue();
      player.followTargetPlayerId = -1;
      this.clearPendingObjectIntents(player);
      return;
    }

    this.clearCombatTarget(playerId);
    player.attackTarget = null;
    this.clearPendingObjectIntents(player);
    player.pendingSpellCast = null;
    player.pendingTalkNpcId = -1;
    player.pendingTalkRepathTicks = 0;
    player.followTargetPlayerId = -1;
    this.cancelSkilling(playerId);
    // Walking auto-closes any open modal interface (bank/trade) — mirrors
    // RS2 behavior where moving aborts the current dialog.
    if (player.isInterfaceOpen()) this.closeOpenInterface(player, /*declineTrade*/ true);
    // Shops aren't a modal interface but they're context-tied to standing at
    // the shopkeeper. Walking away invalidates the scope.
    player.openShopNpcId = null;
    if (player.openDialogueState) this.sendDialogueClose(player);

    const map = this.getPlayerMap(player);
    const requestedGoal = path[path.length - 1];
    const requestedGoalIsOnCurrentFloor = requestedGoal
      ? !map.isTileBlockedOnFloor(Math.floor(requestedGoal.x), Math.floor(requestedGoal.z), player.currentFloor)
      : true;
    if (
      player.currentFloor > 0
      && !requestedGoalIsOnCurrentFloor
      && this.isNearGroundStair(map, Math.floor(player.position.x), Math.floor(player.position.y))
    ) {
      player.currentFloor = 0;
      player.lastFloorChangeTile = -1;
      this.refreshPlayerEffectiveY(player);
      this.sendFloorChange(player);
    }
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
    const validPath: { x: number; z: number }[] = [];
    let prevX = player.position.x;
    let prevZ = player.position.y;
    const pFloor = player.currentFloor;
    // Total unit-tile count the client requested (sum of per-segment max
    // axial distances). Used after the validation loop to detect whether
    // we dropped any tiles relative to what was asked for.
    let requestedTileCount = 0;
    let truncated = false;
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
    outer: for (const step of path) {
      const targetTileX = Math.floor(step.x);
      const targetTileZ = Math.floor(step.z);
      const startTileX = Math.floor(prevX);
      const startTileZ = Math.floor(prevZ);
      const dxTotal = targetTileX - startTileX;
      const dzTotal = targetTileZ - startTileZ;
      const stepDX = Math.sign(dxTotal);
      const stepDZ = Math.sign(dzTotal);
      const distance = Math.max(Math.abs(dxTotal), Math.abs(dzTotal));
      if (distance === 0) continue;
      if (distance > MAX_SEGMENT_TILES) { truncated = true; break; }
      // Diagonal compressed steps must move equally on both axes — reject
      // anything that isn't pure cardinal or pure 45° diagonal.
      const isDiagonal = stepDX !== 0 && stepDZ !== 0;
      if (isDiagonal && Math.abs(dxTotal) !== Math.abs(dzTotal)) { truncated = true; break; }
      requestedTileCount += distance;
      if (requestedTileCount > MAX_REQUESTED_TILES) { truncated = true; break; }
      let curTileX = startTileX;
      let curTileZ = startTileZ;
      for (let i = 0; i < distance; i++) {
        const nextTileX = curTileX + stepDX;
        const nextTileZ = curTileZ + stepDZ;
        const tileBlocked = this.isPlayerMovementTileBlocked(player, map, nextTileX, nextTileZ, pFloor);
        // The player's authoritative walking elevation gates wall-edge
        // collision: a wall authored at an upper-floor Y must not block a
        // player standing at that elevation, and an open upper-floor door
        // must let them through. Held fixed for the whole validated path —
        // matches the client, which validates its predicted path against a
        // single localPlayer.position.y (GameManager.isWallBlockedForPath).
        const wallBlocked = pFloor === 0
          ? map.isWallBlocked(curTileX, curTileZ, nextTileX, nextTileZ, player.effectiveY)
          : map.isWallBlockedOnFloor(curTileX, curTileZ, nextTileX, nextTileZ, pFloor);
        if (tileBlocked || wallBlocked) { truncated = true; break outer; }
        // Push tile-CENTER coords to match client convention.
        validPath.push({ x: nextTileX + 0.5, z: nextTileZ + 0.5 });
        curTileX = nextTileX;
        curTileZ = nextTileZ;
      }
      // Advance prevX/Z to the *position* (tile center) we ended at, so the
      // next compressed segment's delta is computed from a consistent base.
      prevX = curTileX + 0.5;
      prevZ = curTileZ + 0.5;
    }
    player.setMoveQueue(validPath);
    // If we actually dropped tiles vs. what the client asked for, notify it
    // so it can trim its local walk to match. Skip when nothing was
    // requested (zero-distance / empty input) or when the validation
    // produced exactly what was asked. Fire-and-forget — no server state.
    if (truncated && validPath.length < requestedTileCount && requestedTileCount > 0) {
      const last = validPath.length > 0 ? validPath[validPath.length - 1] : { x: player.position.x, z: player.position.y };
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
    this.clearPendingObjectIntents(player);
    player.pendingSpellCast = null;
    player.pendingTalkNpcId = -1;
    player.pendingTalkRepathTicks = 0;
    player.followTargetPlayerId = target.id;
    player.nextFollowRepathTick = 0;
    if (player.isInterfaceOpen()) this.closeOpenInterface(player, /*declineTrade*/ true);
    player.openShopNpcId = null;
    if (player.openDialogueState) this.sendDialogueClose(player);
    target.followAnchorX = target.position.x;
    target.followAnchorZ = target.position.y;
    this.updatePlayerFollow(player, target);
  }

  private updatePlayerFollow(player: Player, target: Player): void {
    if (player.id === target.id || target.disconnected || player.currentMapLevel !== target.currentMapLevel || player.currentFloor !== target.currentFloor) {
      player.followTargetPlayerId = -1;
      player.clearMoveQueue();
      return;
    }

    const targetGoalX = Number.isFinite(target.followAnchorX) ? target.followAnchorX : target.position.x;
    const targetGoalZ = Number.isFinite(target.followAnchorZ) ? target.followAnchorZ : target.position.y;
    const dx = targetGoalX - player.position.x;
    const dz = targetGoalZ - player.position.y;
    if (Math.max(Math.abs(dx), Math.abs(dz)) <= 0.2) {
      player.clearMoveQueue();
      return;
    }

    if (player.hasMoveQueue()) {
      const queuedDest = player.getMoveDestination();
      const queuedDestStillUseful = queuedDest
        && Math.max(Math.abs(queuedDest.x - targetGoalX), Math.abs(queuedDest.z - targetGoalZ)) <= 0.2;
      if (queuedDestStillUseful) return;
      player.clearMoveQueue();
    }

    if (this.currentTick < player.nextFollowRepathTick) return;

    const map = this.getPlayerMap(player);
    const targetTileX = Math.floor(targetGoalX);
    const targetTileZ = Math.floor(targetGoalZ);
    const floor = player.currentFloor;
    if (this.isPlayerMovementTileBlocked(player, map, targetTileX, targetTileZ, floor)) {
      player.nextFollowRepathTick = this.currentTick + 2;
      return;
    }
    const tileBlocked = (x: number, z: number): boolean => {
      return this.isPlayerMovementTileBlocked(player, map, x, z, floor);
    };
    const wallBlocked = floor === 0
      ? (fx: number, fz: number, tx: number, tz: number) => map.isWallBlocked(fx, fz, tx, tz, player.effectiveY)
      : (fx: number, fz: number, tx: number, tz: number) => map.isWallBlockedOnFloor(fx, fz, tx, tz, floor);
    const path = map.findPathForNpc(
      player.position.x,
      player.position.y,
      targetTileX + 0.5,
      targetTileZ + 0.5,
      tileBlocked,
      PLAYER_FOLLOW_PATH_SEARCH_STEPS,
      wallBlocked,
    );
    if (path.length > 0) {
      player.setMoveQueue(path);
      player.nextFollowRepathTick = this.currentTick + 1;
      return;
    }
    player.nextFollowRepathTick = this.currentTick + 2;
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
    this.cancelSkilling(playerId);
    if (!this.canPlayerTargetNpc(player, npc)) return;
    if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(npcId)) return;
    this.closeNpcUiContext(player);
    player.botStats?.recordActionSignature('attackNpc', npc.npcId, player.position.x, player.position.y);

    // Distance to the NPC's nearest footprint tile (size-1 falls through to
    // a plain target-anchor distance) — sized mobs are "in range" when the
    // player is adjacent to their body, not just their placed coordinate.
    const fp = npc.distToFootprint(player.position.x, player.position.y);
    const dist = Math.sqrt(fp.dx * fp.dx + fp.dz * fp.dz);
    const isRanged = player.isRangedWeapon(this.data.itemDefs);
    const isMagicAutocast = player.autocastSpellIndex >= 0;
    const attackDist = isMagicAutocast ? SPELL_CAST_DISTANCE : (isRanged ? RANGED_ATTACK_DISTANCE : 1.5);
    const attackMode = isMagicAutocast ? 'magic' : (isRanged ? 'ranged' : 'melee');
    const inAttackRange = this.isPlayerInNpcAttackRange(player, npc, attackMode);
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
      // chase still happens. tickPlayerCombat re-pathfinds every tick once
      // engaged, so any subsequent NPC movement is handled there.
      if (!player.hasMoveQueue()) {
        if (isMagicAutocast) {
          this.queuePlayerPathToNpcRange(player, npc, SPELL_CAST_DISTANCE);
        } else if (!isRanged) {
          const path = this.findPlayerPathToNpc(player, npc);
          player.setMoveQueue(path);
        } else {
          const path = this.findPlayerPathToNpc(player, npc);
          // Ranged: walk until within range of the nearest footprint tile.
          let cutIdx = path.length;
          for (let i = 0; i < path.length; i++) {
            const pf = npc.distToFootprint(path[i].x, path[i].z);
            if (Math.abs(pf.dx) <= attackDist && Math.abs(pf.dz) <= attackDist) {
              cutIdx = i + 1;
              break;
            }
          }
          player.setMoveQueue(path.slice(0, cutIdx));
        }
      }
    } else {
      if (!player.hasMoveQueue()) player.clearMoveQueue();
    }
  }

  handlePlayerTalkNpc(playerId: number, npcEntityId: number): void {
    const player = this.players.get(playerId);
    const npc = this.npcs.get(npcEntityId);
    if (!player || !npc || npc.dead) return;
    if (player.isInterfaceOpen()) return;
    if (!this.canPlayerTargetNpc(player, npc)) return;
    if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(npcEntityId)) return;

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
      if (!player.hasMoveQueue() && !this.queuePlayerPathToNpcInteraction(player, npc)) {
        this.sendChatSystem(player, "I can't reach that.");
        player.pendingTalkNpcId = -1;
        player.pendingTalkRepathTicks = 0;
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
      this.openDialogueAt(player, npc, npc.effectiveDialogue!.root, true);
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

  /** Open the shop UI for this player against this NPC. Extracted so the
   *  dialogue `openShop` action can reuse it. */
  private openShopFor(player: Player, npc: Npc): void {
    const shop = npc.effectiveShop;
    if (!shop) return;
    player.openShopNpcId = npc.npcId;
    const values: number[] = [npc.id, shop.items.length];
    for (const si of shop.items) {
      values.push(si.itemId, si.price, si.stock);
    }
    this.sendToPlayer(player, ServerOpcode.SHOP_OPEN, ...values);
  }

  private playerStillNearShop(player: Player): boolean {
    const shopNpcId = player.openShopNpcId;
    if (shopNpcId === null) return false;
    for (const [, npc] of this.npcs) {
      if (npc.npcId !== shopNpcId || npc.dead) continue;
      if (!this.canPlayerTargetNpc(player, npc)) continue;
      if (this.isPlayerNpcInteractionReachable(player, npc)) return true;
    }
    return false;
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
      this.runDialogueActions(player, npc, actions);
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

  private runDialogueActions(
    player: Player,
    npc: Npc,
    actions: import('@projectrs/shared').DialogueAction[],
  ): void {
    const initialState = player.openDialogueState;
    for (const action of actions) {
      this.runDialogueAction(player, npc, action);
      const state = player.openDialogueState;
      if (
        !initialState ||
        !state ||
        state.sessionId !== initialState.sessionId ||
        state.npcEntityId !== initialState.npcEntityId ||
        state.nodeId !== initialState.nodeId
      ) {
        return;
      }
    }
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
      case 'giveItem':
      case 'takeItem':
      case 'setQuestStage':
      case 'completeQuest':
        this.quests.runQuestAction(player, action, 'dialogue');
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
    if (player.openShopNpcId === null) return;
    const shop = this.data.getShop(player.openShopNpcId);
    if (!shop) return;
    if (!this.playerStillNearShop(player)) {
      player.openShopNpcId = null;
      return;
    }
    const shopItem = shop.items.find(s => s.itemId === itemId);
    if (!shopItem) return; // this shop doesn't sell this item

    const itemDef = this.data.getItem(itemId);
    if (!itemDef) return;
    const price = shopItem.price;
    const totalCost = price * quantity;

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

    this.interruptPlayerAction(playerId, player, true);
    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
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
    if (player.openShopNpcId === null) return;
    if (!this.data.getShop(player.openShopNpcId)) return;
    if (!this.playerStillNearShop(player)) {
      player.openShopNpcId = null;
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
    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
  }

  handlePlayerPickup(playerId: number, groundItemId: number): void {
    const player = this.players.get(playerId);
    const item = this.groundItems.get(groundItemId);
    if (!player || !item) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.isInterfaceOpen()) return;
    if (!this.canPlayerTargetGroundItem(player, item)) return;
    if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(groundItemId)) return;
    this.closeNpcUiContext(player);

    // Walk to item if not in range
    const dx = Math.abs(player.position.x - item.x);
    const dz = Math.abs(player.position.y - item.z);
    if (dx > 1.5 || dz > 1.5) {
      // The client normally sends PLAYER_MOVE immediately before PICKUP.
      // Preserve that queue instead of replacing it with a separately
      // pathfound server route from an earlier authoritative tile; otherwise
      // running redirects can rubber-band when the two routes differ.
      if (!player.hasMoveQueue()) {
        const map = this.getPlayerMap(player);
        const path = map.findPathOnFloor(player.position.x, player.position.y, item.x, item.z, player.currentFloor);
        if (path.length > 0) player.setMoveQueue(path);
      }
      if (player.hasMoveQueue()) player.pendingPickup = groundItemId;
      return;
    }
    player.botStats?.recordActionSignature('pickup', item.itemId, player.position.x, player.position.y);

    const added = player.addItem(item.itemId, item.quantity, this.data.itemDefs);
    if (added.completed > 0) {
      this.interruptPlayerAction(playerId, player);
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
    }
  }

  handlePlayerDrop(playerId: number, slotIndex: number, expectedItemId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.isBusy(this.currentTick)) return;
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
    if (dropCm) dropCm.addEntity(groundItem.id, groundItem.x, groundItem.z);

    this.forEachPlayerNearOnFloor(groundItem.mapLevel, groundItem.floor, groundItem.x, groundItem.z, p => this.sendGroundItemUpdate(p, groundItem));
    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
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

  handlePlayerInteractObject(playerId: number, objectEntityId: number, actionIndex: number, recipeIndex: number = -1, expectedDoorOpen: boolean | null = null): void {
    const player = this.players.get(playerId);
    const obj = this.worldObjects.get(objectEntityId);
    if (!player || !obj) return;
    if (!this.canPlayerTargetObject(player, obj)) return;
    if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(objectEntityId)) return;
    if (obj.def.category !== 'door') expectedDoorOpen = null;
    if (this.rejectStaleDoorInteraction(player, obj, expectedDoorOpen)) return;
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
    this.clearPendingObjectIntents(player);

    if (player.isBusy(this.currentTick)) {
      const isQueuedObjectAction = obj.def.category === 'door' || obj.def.category === 'ladder' || (obj.def.harvestItemId && (obj.def.skill || obj.def.category === 'crop'));
      if (isQueuedObjectAction) {
        player.pendingInteraction = { objectEntityId, actionIndex, swingSign: 0, expectedDoorOpen };
      }
      return;
    }
    // While a modal interface (bank/trade) is open, refuse object interactions
    // outright — no door deferral. Closing the interface is a deliberate user
    // action; we won't queue clicks behind it.
    if (player.isInterfaceOpen()) return;
    this.closeNpcUiContext(player);

    // Check adjacency — player must be on a tile next to the object
    if (!this.isAdjacentToObject(player, obj)) {
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
            path = map.findPathOnFloor(px, pz, cx, cz, player.currentFloor);
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
          path = map.findPathOnFloor(px, pz, tx + 0.5, tz + 0.5, player.currentFloor);
        }

        if (!player.hasMoveQueue() && path.length > 0) {
          player.setMoveQueue(path);
        }
        if (player.hasMoveQueue()) {
          player.pendingInteraction = { objectEntityId, actionIndex, swingSign, expectedDoorOpen };
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
        player.pendingInteraction = { objectEntityId, actionIndex, recipeIndex };
      } else {
        this.sendChatSystem(player, "I can't reach that.");
      }
      return;
    }

    // Stop movement
    player.clearMoveQueue();
    player.attackTarget = null;
    this.clearCombatTarget(playerId);

    const action = obj.def.category === 'ladder'
      ? this.ladderActionsForPlayer(player, obj)[actionIndex]
      : obj.currentActions[actionIndex];
    if (!action) return;
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
      this.handleCraftingInteraction(playerId, player, obj, recipeIndex);
      return;
    }
  }

  private shouldOpenRecipePicker(obj: WorldObject): boolean {
    const recipes = obj.def.recipes ?? [];
    if (recipes.length === 0) return false;
    if (recipes[0]?.requiresTool) return true;
    return obj.def.category === 'furnace' && recipes.length > 1;
  }

  private runObjectInteractionEffects(player: Player, obj: WorldObject, action: string): void {
    const effects = obj.interactions?.filter(effect => effect.action === action) ?? [];
    for (const effect of effects) {
      if (effect.condition && !this.quests.questConditionMet(player, effect.condition)) continue;
      if (effect.conditions?.some(condition => !this.quests.questConditionMet(player, condition))) continue;
      if (Array.isArray(effect.saySequence) && effect.saySequence.length > 0) {
        this.queueObjectSaySequence(player, effect.saySequence);
      } else if (typeof effect.say === 'string') {
        const say = effect.say.trim();
        if (say) broadcastLocalMessage(player.name, say.slice(0, 1000));
      }
      const message = typeof effect.message === 'string' ? effect.message.trim() : '';
      if (message) this.sendChatSystem(player, message.slice(0, 300));
      const actionsSucceeded = this.quests.runQuestActions(player, effect.effects || [], 'object');
      if (effect.depleteObject && actionsSucceeded) {
        this.depleteObjectFromInteractionEffect(obj, effect.depleteRespawnTicks);
      }
    }
  }

  private objectExamineTextFor(player: Player, obj: WorldObject): string {
    if (obj.def.category === 'altar') {
      const hasRelic = player.inventory.some(slot => slot !== null && RELIC_ITEM_IDS.has(slot.itemId));
      return hasRelic
        ? 'I should sacrifice some relics for good luck!'
        : 'i wish i had something worth sacrificing';
    }
    return obj.examineText || `It's ${obj.displayName}.`;
  }

  private depleteObjectFromInteractionEffect(obj: WorldObject, respawnTicks?: number): void {
    if (obj.depleted || obj.def.category === 'door') return;
    obj.depleted = true;
    obj.respawnTimer = Math.max(0, Math.floor(respawnTicks ?? obj.def.respawnTime ?? 0));
    if (obj.respawnTimer > 0) {
      this.depletedObjectIds.add(obj.id);
      this.db.saveObjectRespawn(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z), obj.floor, Date.now() + obj.respawnTimer * TICK_RATE);
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
        broadcastLocalMessage(player.name, message);
        continue;
      }
      this.objectSayScheduledLines.push({
        runAtTick: this.currentTick + delayTicks,
        playerId: player.id,
        playerName: player.name,
        message,
      });
    }
  }

  private handleTeleportInteraction(player: Player, obj: WorldObject): void {
    this.interruptPlayerAction(player.id, player);
    if (obj.trigger?.type === 'teleport' && obj.trigger.destChunk) {
      this.handleMapTransition(player, {
        targetMap: obj.trigger.destChunk,
        targetX: obj.trigger.entryX || 32.5,
        targetZ: obj.trigger.entryZ || 32.5,
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

  private handleLadderInteraction(player: Player, obj: WorldObject, action: 'Climb-up' | 'Climb-down'): void {
    const step = this.getLadderStep(player, obj);
    const target = action === 'Climb-down' ? step.down : step.up;
    if (!target) {
      this.sendChatSystem(player, action === 'Climb-down' ? "I can't climb down there." : "I can't climb up there.");
      return;
    }

    this.interruptPlayerAction(player.id, player);
    player.currentFloor = target.floor;
    player.lastFloorChangeTile = Math.floor(target.z) * this.getPlayerMap(player).width + Math.floor(target.x);
    this.teleportPlayer(player, target.x, target.z, target.y);
  }

  private ladderActionsForPlayer(player: Player, obj: WorldObject): readonly string[] {
    const step = this.getLadderStep(player, obj);
    const actions: string[] = [];
    if (step.down) actions.push('Climb-down');
    if (step.up) actions.push('Climb-up');
    actions.push('Examine');
    return actions;
  }

  private getLadderStep(
    player: Player,
    obj: WorldObject,
  ): { up?: { x: number; z: number; y: number; floor: number }; down?: { x: number; z: number; y: number; floor: number } } {
    const map = this.getPlayerMap(player);
    const playerY = player.effectiveY;
    const seenPositions = new Set<string>();
    const addPosition = (x: number, z: number): { x: number; z: number } | null => {
      const pos = { x: Math.floor(x) + 0.5, z: Math.floor(z) + 0.5 };
      const key = `${pos.x},${pos.z}`;
      if (seenPositions.has(key)) return null;
      seenPositions.add(key);
      return pos;
    };
    const positions = [
      addPosition(player.position.x, player.position.y),
      ...this.objectInteractionTiles(obj).map(tile => addPosition(tile.x, tile.z)),
    ].filter((pos): pos is { x: number; z: number } => pos !== null);
    const candidates: { x: number; z: number; y: number; floor: number }[] = [];
    const add = (candidate: { x: number; z: number; y: number; floor: number }): void => {
      if (!Number.isFinite(candidate.y)) return;
      if (!candidates.some(existing =>
        Math.abs(existing.x - candidate.x) < 0.01
        && Math.abs(existing.z - candidate.z) < 0.01
        && existing.floor === candidate.floor
        && Math.abs(existing.y - candidate.y) < 0.1)) {
        candidates.push(candidate);
      }
    };

    for (const pos of positions) {
      for (const target of map.getWalkableFloorTargetsAt(pos.x, pos.z)) {
        add({ ...pos, y: target.y, floor: target.floor });
      }
    }

    const byDistance = (a: { x: number; z: number }, b: { x: number; z: number }): number =>
      (Math.abs(a.x - player.position.x) + Math.abs(a.z - player.position.y))
      - (Math.abs(b.x - player.position.x) + Math.abs(b.z - player.position.y));
    const up = candidates
      .filter(candidate => candidate.y > playerY + 0.8)
      .sort((a, b) => (a.y - b.y) || byDistance(a, b))[0];
    const down = candidates
      .filter(candidate => candidate.y < playerY - 0.8)
      .sort((a, b) => (b.y - a.y) || byDistance(a, b))[0];

    return { up, down };
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

    // Rocks all roll on the same cadence; better pickaxes affect success chance.
    // Other harvestables still use tool bonus to shorten the cycle.
    let cycleTime: number;
    if (obj.def.category === 'rock') {
      cycleTime = obj.def.harvestTime ?? World.DEFAULT_MINING_RATE;
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

  private handleCraftingInteraction(playerId: number, player: Player, obj: WorldObject, recipeIndex: number): boolean {
    const recipes = obj.def.recipes!;
    const recipesToTry = (recipeIndex >= 0 && recipeIndex < recipes.length)
      ? [recipes[recipeIndex]]
      : recipes;

    for (const recipe of recipesToTry) {
      const skillId = recipe.skill as SkillId;
      const playerLevel = player.skills[skillId]?.level ?? 1;
      if (playerLevel < recipe.levelRequired) continue;

      if (recipe.requiresTool) {
        const hasTool = player.inventory.some(slot =>
          slot !== null && this.data.getItem(slot.itemId)?.toolType === recipe.requiresTool
        );
        if (!hasTool) continue;
      }
      this.interruptPlayerAction(playerId, player);

      // removeItemById aggregates across slots, so unstackable multi-unit
      // inputs (e.g. 3 bars in 3 slots) consume correctly.
      const inputRemoval = player.removeItemById(recipe.inputItemId, recipe.inputQuantity);
      if (inputRemoval.completed === 0) continue;

      let secondRemoval: ReturnType<typeof player.removeItemById> | null = null;
      if (recipe.secondInputItemId !== undefined) {
        const needed = recipe.secondInputQuantity ?? 1;
        secondRemoval = player.removeItemById(recipe.secondInputItemId, needed);
        if (secondRemoval.completed === 0) {
          player.revertRemove(inputRemoval);
          continue;
        }
      }

      if (recipe.successChance !== undefined && Math.random() > recipe.successChance) {
        // Recipe rolled fail — inputs are consumed, no output. Matches RS2 behavior.
        this.sendInventory(player);
        return false;
      }

      const addResult = player.addItem(recipe.outputItemId, recipe.outputQuantity, this.data.itemDefs);
      if (addResult.completed === 0) {
        if (secondRemoval) player.revertRemove(secondRemoval);
        player.revertRemove(inputRemoval);
        this.sendInventory(player);
        return false;
      }

      const result = addXp(player.skills, skillId, recipe.xpReward);
      const skillIdx = ALL_SKILLS.indexOf(skillId);
      if (skillIdx >= 0) {
        this.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, recipe.xpReward);
        if (result.leveled) {
          this.sendToPlayer(player, ServerOpcode.LEVEL_UP, skillIdx, result.newLevel);
        }
      }

      this.sendInventory(player);
      if (skillIdx >= 0) this.sendSingleSkill(player, skillIdx);
      return true;
    }
    return false;
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
      if (result.leveled) this.sendToPlayer(player, ServerOpcode.LEVEL_UP, skillIdx, result.newLevel);
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
    const requiredSkill = itemDef.equipSkill ?? (equipSlot === 'weapon' ? 'accuracy' : 'defence');
    if (requiredLevel > 1 && (player.skills[requiredSkill]?.level ?? 1) < requiredLevel) {
      this.sendChatSystem(player, `You need level ${requiredLevel} ${SKILL_NAMES[requiredSkill] ?? 'skill'} to equip ${itemDef.name}.`);
      return;
    }

    const currentEquipped = player.equipment.get(equipSlot);

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

    this.interruptPlayerAction(playerId, player);

    // Source slot: receives displaced equipment if any, else cleared.
    if (currentEquipped !== undefined) {
      player.inventory[slotIndex] = { itemId: currentEquipped, quantity: 1 };
    } else {
      player.removeItem(slotIndex);
    }

    player.equipment.set(equipSlot, slot.itemId);

    if (sideUnequipId !== undefined) {
      // Pre-flight guarantees this fits, but use the transaction return to
      // catch any future drift in canFit logic.
      const addResult = player.addItem(sideUnequipId, 1, this.data.itemDefs);
      if (addResult.completed > 0) {
        player.equipment.delete(equipSlot === 'weapon' ? 'shield' : 'weapon');
      }
    }

    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
    this.sendEquipment(player);
    this.broadcastRemoteEquipment(player);
    this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));
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

    if (player.addItem(itemId, 1, this.data.itemDefs).completed > 0) {
      this.interruptPlayerAction(playerId, player);
      player.equipment.delete(slotName);
      player.setDelay(this.currentTick, 1);
      this.sendInventory(player);
      this.sendEquipment(player);
      this.broadcastRemoteEquipment(player);
      this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));
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
    // RS2: 3-tick eat delay prevents stacking multiple foods per tick
    player.setDelay(this.currentTick, 3);

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
    if (player.isBusy(this.currentTick)) return null;
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
  ): void {
    if (fromSlot === toSlot) return;
    const player = this.validateInvUse(playerId, fromSlot, fromItemId);
    if (!player) return;
    if (toSlot < 0 || toSlot >= player.inventory.length) return;
    if (player.inventory[toSlot]?.itemId !== toItemId) return;
    this.interruptPlayerAction(playerId, player);
    // No recipes wired yet — surface a generic reply so the protocol is exercised.
    this.sendChatSystem(player, USE_NO_RECIPE_REPLY);
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
    this.clearPendingObjectIntents(player);
    if (!this.isAdjacentToObject(player, obj)) {
      const path = this.findPathToObjectInteraction(player, obj);
      if (!player.hasMoveQueue() && path.length > 0) {
        player.setMoveQueue(path);
      }
      if (player.hasMoveQueue()) {
        player.pendingUseItemOnObject = { invSlot, itemId, objectEntityId };
      } else {
        this.sendChatSystem(player, "I can't reach that.");
      }
      return;
    }
    player.botStats?.recordActionSignature('useItemObject', obj.defId, player.position.x, player.position.y, itemId);
    this.interruptPlayerAction(playerId, player);
    if (obj.def.category === 'door' && obj.doorLocked && !obj.doorOpen && itemId === obj.doorKeyItemId) {
      if (!this.canOpenLockedDoor(player, obj)) return;
      this.toggleDoor(obj, this.computeSwingSign(player, obj));
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
    this.clearPendingObjectIntents(player);
    if (!this.isPlayerNpcInteractionReachable(player, npc)) {
      if (!player.hasMoveQueue() && !this.queuePlayerPathToNpcInteraction(player, npc)) return;
      if (player.hasMoveQueue()) {
        player.pendingUseItemOnNpc = { invSlot, itemId, npcEntityId };
      }
      return;
    }
    player.botStats?.recordActionSignature('useItemNpc', npc.npcId, player.position.x, player.position.y, itemId);
    this.interruptPlayerAction(playerId, player);
    this.sendChatSystem(player, USE_NO_RECIPE_REPLY);
  }

  handlePlayerSetStance(playerId: number, stanceIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const stances = ['accurate', 'aggressive', 'defensive', 'controlled'] as const;
    // Modal interfaces lock stance — keep the gate but echo the current
    // server stance back so the client doesn't desync visually.
    // The previous `isBusy` gate also dropped packets while any unrelated
    // 1-tick delay (inventory/equip/etc.) was active; the optimistic UI
    // would then show the new stance while combat kept reading the old
    // one — surfacing as XP going to the wrong skill. The post-flip
    // setDelay below still prevents rapid stance flip-flopping.
    if (player.isInterfaceOpen() || stanceIndex < 0 || stanceIndex >= stances.length) {
      this.sendRemoteStance(player, player);
      return;
    }
    player.stance = stances[stanceIndex];
    this.db.saveStance(player.accountId, player.stance);
    player.setDelay(this.currentTick, 1);
    // Self-echo lets the client correct its optimistic UI if anything ever
    // diverges; broadcast to neighbours so they pick the right swing anim.
    this.sendRemoteStance(player, player);
    this.broadcastRemoteStance(player);
  }

  handlePlayerSetAutocast(playerId: number, spellIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.isInterfaceOpen()) return;
    if (spellIndex < 0) {
      player.autocastSpellIndex = -1;
      return;
    }
    if (!this.data.getSpellByIndex(spellIndex)) return;
    player.autocastSpellIndex = spellIndex;
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
    if (player.isInterfaceOpen()) return;
    if (player.isBusy(this.currentTick)) return;

    const def = this.data.getSpellByIndex(spellIndex);
    if (!def) return;

    const npc = this.npcs.get(targetEntityId);
    if (!npc || npc.dead) return;
    if (this.data.getShop(npc.npcId)) return;                 // shopkeepers immune
    if (!this.canPlayerTargetNpc(player, npc)) return;
    if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(targetEntityId)) return;

    player.clearMoveQueue();
    player.followTargetPlayerId = -1;
    if (player.attackCooldown > 0) {
      if (!keepCombatTarget && this.playerCombatTargets.has(playerId)) {
        player.pendingSpellCast = { spellIndex, targetEntityId };
        this.clearCombatTarget(playerId);
      }
      return;
    }

    const fp = npc.distToFootprint(player.position.x, player.position.y);
    const dist = Math.sqrt(fp.dx * fp.dx + fp.dz * fp.dz);
    if (dist > SPELL_CAST_DISTANCE) {
      if (!player.hasMoveQueue()) this.queuePlayerPathToNpcRange(player, npc, SPELL_CAST_DISTANCE);
      if (player.hasMoveQueue()) player.pendingSpellCast = { spellIndex, targetEntityId };
      return;
    }

    this.cancelSkilling(playerId);
    if (!keepCombatTarget) this.clearCombatTarget(playerId);   // single-cast cancels auto-attack

    // Magic combat roll. Mirrors the OSRS pattern in processPlayerCombat /
    // processPlayerRangedCombat: dual roll (attacker vs defender), miss → 0
    // damage, hit → uniform [0..maxHit]. Equipment's magicAccuracy bonus feeds
    // the attack roll. NPC magic defence falls back to base defence — NpcDef
    // doesn't carry a magicDefence stat (yet).
    const xpSkill: SkillId = spellSchoolSkill(def);

    // Level gate. Server-authoritative — the UI hides locked spells but a
    // crafted packet could still try to cast them, so we re-check here.
    // `.level` (not `.currentLevel`) so temporary stat drains don't lock you out.
    const requiredLevel = def.levelRequired ?? 1;
    if (player.skills[xpSkill].level < requiredLevel) return;

    const magicLevel = player.skills[xpSkill].currentLevel;
    const effMagic = magicLevel + 8;
    const bonuses = player.computeBonuses(this.data.itemDefs);
    const attackRoll = effMagic * (bonuses.magicAccuracy + ACC_BASE);
    const defRoll = (npc.defence + 8) * ACC_BASE;
    const damage = rollHit(attackRoll, defRoll)
      ? Math.floor(Math.random() * (magicMaxHit(magicLevel, def.tier) + 1))
      : 0;

    // Total wall time before damage applies — matches client visual length.
    const travelMs = def.trajectory.speed > 0 ? (dist / def.trajectory.speed) * 1000 : 600;
    const totalDelayMs = def.cast.durationMs + travelMs;
    const totalDelayTicks = Math.max(1, Math.round(totalDelayMs / TICK_RATE));

    // Lock other actions for the cast window; block recasts until impact.
    // Recast cooldown is fixed (not distance-scaled) so pacing stays
    // consistent regardless of how far the target is.
    const castTicks = Math.max(1, Math.ceil(def.cast.durationMs / TICK_RATE));
    const costResult = consumeSpellCosts(player, def, this.data.itemDefs);
    if (!costResult.ok) {
      if (costResult.message) this.sendChatSystem(player, costResult.message);
      return;
    }
    if (costResult.inventoryChanged) this.sendInventory(player);

    player.setDelay(this.currentTick, castTicks + 1);
    player.attackCooldown = 7;

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

    this.pendingSpellImpacts.push({
      impactTick: this.currentTick + totalDelayTicks,
      attackerId: player.id,
      targetId: npc.id,
      damage,
      spellId: def.id,
      xpSkill,
      mapLevel: player.currentMapLevel,
      floor: player.currentFloor,
    });
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
      if (r.leveled) this.sendToPlayer(player, ServerOpcode.LEVEL_UP, skillIdx, r.newLevel);
      this.sendSingleSkill(player, skillIdx);
    }
    const hpIdx = ALL_SKILLS.indexOf('hitpoints');
    if (hpIdx >= 0 && player.skills.hitpoints.level > oldHpLevel) {
      this.sendToPlayer(player, ServerOpcode.LEVEL_UP, hpIdx, player.skills.hitpoints.level);
      this.sendSingleSkill(player, hpIdx);
      player.syncHealthFromSkills();
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
    this.sendToPlayer(player, ServerOpcode.SHOW_CHARACTER_CREATOR, 0);
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
    // openShopNpcId is what gates buy/sell handlers.
    a.openShopNpcId = null;
    b.openShopNpcId = null;
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
    return this.pendingSpellImpacts?.some(impact => impact.attackerId === playerId) ?? false;
  }

  private clearPendingSpellImpactsFor(playerId: number): void {
    if (!this.pendingSpellImpacts || this.pendingSpellImpacts.length === 0) return;
    this.pendingSpellImpacts = this.pendingSpellImpacts.filter(impact => impact.attackerId !== playerId);
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
    a.openShopNpcId = null;
    b.openShopNpcId = null;
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
    aPlayer.openInterface = 'duel';
    bPlayer.openInterface = 'duel';
    aPlayer.attackCooldown = 0;
    bPlayer.attackCooldown = 0;

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
        npc.combatTarget = null;
        npc.pathQueue.length = 0;
      }
    }
    player.attackTarget = null;
    player.clearMoveQueue();
    player.followTargetPlayerId = -1;
    player.pendingPickup = -1;
    player.pendingSpellCast = null;
    player.pendingTalkNpcId = -1;
    player.pendingTalkRepathTicks = 0;
    this.clearPendingObjectIntents(player);
    this.cancelSkilling(player.id);
    player.openShopNpcId = null;
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
    return this.tileChebyshev(a, b) <= 1;
  }

  private processDuelAttack(duel: ActiveDuel, attacker: Player, defender: Player): void {
    if (!attacker.alive || !defender.alive || attacker.attackCooldown > 0) return;
    if (attacker.autocastSpellIndex >= 0) {
      const hit = this.processDuelMagicAttack(attacker, defender);
      if (hit !== null) this.applyDuelHit(duel, attacker, defender, hit, true);
      return;
    }
    if (attacker.isRangedWeapon(this.data.itemDefs)) {
      const ammo = attacker.findAmmo(this.data.itemDefs);
      if (!ammo) {
        attacker.attackCooldown = Math.max(1, attacker.getAttackSpeed(this.data.itemDefs));
        this.sendChatSystem(attacker, 'You have no arrows left.');
        return;
      }
      const hit = this.rollDuelRangedHit(attacker, defender, ammo.itemDef.rangedStrength ?? 0);
      attacker.attackCooldown = attacker.getAttackSpeed(this.data.itemDefs);
      attacker.removeItemFromSlot(ammo.slotIndex, 1);
      this.sendInventory(attacker);
      this.broadcastProjectile(attacker.id, defender.id, 1, attacker.currentMapLevel, duel.floor, attacker.position.x, attacker.position.y);
      this.applyDuelHit(duel, attacker, defender, hit, false);
      return;
    }
    const hit = this.rollDuelMeleeHit(attacker, defender);
    attacker.attackCooldown = attacker.getAttackSpeed(this.data.itemDefs);
    this.applyDuelHit(duel, attacker, defender, hit, false);
  }

  private rollDuelMeleeHit(attacker: Player, defender: Player): number {
    const itemDefs = this.data.itemDefs;
    const attackBonuses = attacker.computeBonuses(itemDefs);
    const defenceBonuses = defender.computeBonuses(itemDefs);
    const attackStance = STANCE_BONUSES[attacker.stance];
    const defenceStance = STANCE_BONUSES[defender.stance];
    const effAcc = attacker.skills.accuracy.currentLevel + attackStance.accuracy + 8;
    const effStr = attacker.skills.strength.currentLevel + attackStance.strength + 8;
    const weaponStyle = attacker.getWeaponStyle(itemDefs);
    let attackBonus = attackBonuses.crushAttack;
    let defenceBonus = defenceBonuses.crushDefence;
    if (weaponStyle === 'stab') {
      attackBonus = attackBonuses.stabAttack;
      defenceBonus = defenceBonuses.stabDefence;
    } else if (weaponStyle === 'slash') {
      attackBonus = attackBonuses.slashAttack;
      defenceBonus = defenceBonuses.slashDefence;
    }
    const attackRoll = effAcc * (attackBonus + ACC_BASE);
    const defRoll = (defender.skills.defence.currentLevel + defenceStance.defence + 8) * (defenceBonus + ACC_BASE);
    const maxHit = osrsMeleeMaxHit(effStr, attackBonuses.meleeStrength);
    return rollHit(attackRoll, defRoll) ? Math.floor(Math.random() * (maxHit + 1)) : 0;
  }

  private rollDuelRangedHit(attacker: Player, defender: Player, arrowStrength: number): number {
    const itemDefs = this.data.itemDefs;
    const attackBonuses = attacker.computeBonuses(itemDefs);
    const defenceBonuses = defender.computeBonuses(itemDefs);
    const defenceStance = STANCE_BONUSES[defender.stance];
    const effRanged = attacker.skills.archery.currentLevel + 8;
    const attackRoll = effRanged * (attackBonuses.rangedAccuracy + ACC_BASE);
    const defRoll = (defender.skills.defence.currentLevel + defenceStance.defence + 8) * (defenceBonuses.rangedDefence + ACC_BASE);
    const maxHit = osrsMeleeMaxHit(effRanged, attackBonuses.rangedStrength + arrowStrength);
    return rollHit(attackRoll, defRoll) ? Math.floor(Math.random() * (maxHit + 1)) : 0;
  }

  private processDuelMagicAttack(attacker: Player, defender: Player): number | null {
    const spellIndex = attacker.autocastSpellIndex;
    const def = this.data.getSpellByIndex(spellIndex);
    if (!def) {
      attacker.autocastSpellIndex = -1;
      return null;
    }
    const xpSkill: SkillId = spellSchoolSkill(def);
    if (attacker.skills[xpSkill].level < (def.levelRequired ?? 1)) {
      attacker.autocastSpellIndex = -1;
      return null;
    }
    const costResult = consumeSpellCosts(attacker, def, this.data.itemDefs);
    if (!costResult.ok) {
      attacker.attackCooldown = 4;
      if (costResult.message) this.sendChatSystem(attacker, costResult.message);
      return null;
    }
    if (costResult.inventoryChanged) this.sendInventory(attacker);
    const magicLevel = attacker.skills[xpSkill].currentLevel;
    const attackBonuses = attacker.computeBonuses(this.data.itemDefs);
    const defenceBonuses = defender.computeBonuses(this.data.itemDefs);
    const attackRoll = (magicLevel + 8) * (attackBonuses.magicAccuracy + ACC_BASE);
    const defRoll = (defender.skills.defence.currentLevel + 8) * (defenceBonuses.magicDefence + ACC_BASE);
    const hit = rollHit(attackRoll, defRoll)
      ? Math.floor(Math.random() * (magicMaxHit(magicLevel, def.tier) + 1))
      : 0;
    attacker.attackCooldown = 7;
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
      this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));
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
    player.pendingSpellCast = null;
    player.pendingPickup = -1;
    this.clearPendingObjectIntents(player);
    player.delayedUntilTick = 0;
    player.logoutBlockedUntilTick = 0;
    player.actionDelay = 0;
    player.attackCooldown = 0;
    player.openShopNpcId = null;
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
    if (cm) cm.addEntity(groundItem.id, groundItem.x, groundItem.z);
    // Broadcast to nearby players so the dropped item appears immediately
    // (without this, clients only see it after re-entering the chunk).
    this.forEachPlayerNearOnFloor(groundItem.mapLevel, groundItem.floor, groundItem.x, groundItem.z, p =>
      this.sendGroundItemUpdate(p, groundItem));
  }

  private spawnNpcLoot(npc: Npc, ownerPlayerId: number | null): void {
    const loot = rollLoot(npc);
    if (loot.length === 0) return;
    const owner = ownerPlayerId != null ? this.players.get(ownerPlayerId) : null;
    const effectiveOwnerId = owner && owner.currentMapLevel === npc.currentMapLevel && owner.currentFloor === npc.currentFloor ? owner.id : null;
    const deathX = npc.position.x;
    const deathZ = npc.position.y;
    for (const drop of loot) {
      const id = this.allocateGroundItemId();
      if (id === null) continue;
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
      if (lootCm) lootCm.addEntity(groundItem.id, groundItem.x, groundItem.z);

      if (effectiveOwnerId != null && owner) {
        this.sendGroundItemUpdate(owner, groundItem);
      } else {
        this.forEachPlayerNearOnFloor(groundItem.mapLevel, groundItem.floor, groundItem.x, groundItem.z, p =>
          this.sendGroundItemUpdate(p, groundItem));
      }
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
    this.rebuildEntityTileOccupants();
    this.tickNpcAI();
    this.rebuildEntityTileOccupants();
    this.tickPlayerCooldowns();
    this.tickQueuedSpellCasts();
    this.tickActiveDuels();
    this.tickPlayerCombat();
    this.tickNpcCombat();
    this.tickPendingSpells();
    if (this.currentTick % 40 === 0) this.tickHealthRegen();
    this.tickSkillingActions();
    this.tickObjectRespawns();
    this.tickItemDespawns();
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

  private isNearGroundStair(map: GameMap, tileX: number, tileZ: number): boolean {
    for (let dz = -STAIR_DESCENT_SEARCH_RADIUS; dz <= STAIR_DESCENT_SEARCH_RADIUS; dz++) {
      for (let dx = -STAIR_DESCENT_SEARCH_RADIUS; dx <= STAIR_DESCENT_SEARCH_RADIUS; dx++) {
        if (map.getStair(tileX + dx, tileZ + dz)) return true;
      }
    }
    return false;
  }

  private tickPlayerMovement(): void {
    this.snapshotPlayerFollowAnchors();
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
          this.clearPendingObjectIntents(player);
          player.movementCredit = 0;
          break;
        }
        if (!player.processMovement(this.currentTick)) break;
        // Tile changed — re-derive the authoritative walking elevation so the
        // next step's wall check (and the next CLIENT_MOVE validation) gate
        // on the right Y.
        this.refreshPlayerEffectiveY(player);
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
      if (movedThisTick && (justArrived || this.currentTick - player.lastPositionPersistTick >= 2)) {
        this.checkpointPlayerPosition(player);
      }

      if (player.pendingPickup >= 0 && !player.hasMoveQueue() && !justArrived) {
        const pickupId = player.pendingPickup;
        player.pendingPickup = -1;
        this.handlePlayerPickup(playerId, pickupId);
      }
      if (player.pendingInteraction && !player.hasMoveQueue()) {
        const { objectEntityId, actionIndex, swingSign, recipeIndex, expectedDoorOpen } = player.pendingInteraction;
        const obj = this.worldObjects.get(objectEntityId);
        // Doors fire instantly on arrival — toggling is visually
        // self-evident (the door swings) and the client already
        // interpolates the character's arrival visually. Other
        // interactions (skilling, crafting) keep the !justArrived guard so
        // animations don't register while the character is mid-step.
        const isDoorInteraction = obj?.def.category === 'door';
        if (!isDoorInteraction && justArrived) continue;
        this.clearPendingObjectIntents(player);
        if (obj && this.canPlayerTargetObject(player, obj)) {
          if (this.isAdjacentToObject(player, obj)) {
            player.clearMoveQueue();
            player.attackTarget = null;
            this.clearCombatTarget(playerId);
            if (this.rejectStaleDoorInteraction(player, obj, expectedDoorOpen ?? null)) continue;
            const action = obj.currentActions[actionIndex];
            if (action && obj.def.category === 'door' && (action === 'Open' || action === 'Close')) {
              this.toggleDoor(obj, swingSign ?? 0);
            } else if (action) {
              // Forward the stashed recipeIndex so a deferred furnace craft
              // honours the player's picker choice instead of auto-picking
              // (which would fire the first matching recipe — iron, not steel).
              this.handlePlayerInteractObject(playerId, objectEntityId, actionIndex, recipeIndex ?? -1);
            }
          }
        }
      }
      if (player.pendingUseItemOnObject && !player.hasMoveQueue()) {
        if (justArrived) continue;
        const { invSlot, itemId, objectEntityId } = player.pendingUseItemOnObject;
        player.pendingUseItemOnObject = null;
        this.handlePlayerUseItemOnObject(playerId, invSlot, itemId, objectEntityId);
      }
      if (player.pendingUseItemOnNpc && !player.hasMoveQueue()) {
        if (justArrived) continue;
        const { invSlot, itemId, npcEntityId } = player.pendingUseItemOnNpc;
        player.pendingUseItemOnNpc = null;
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
        }
      }
    }
  }

  private snapshotPlayerFollowAnchors(): void {
    for (const [, player] of this.players) {
      player.followAnchorX = player.position.x;
      player.followAnchorZ = player.position.y;
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

      if (npc.aggressive && !npc.combatTarget) {
        const cm = this.chunkManagers.get(npc.currentMapLevel);
        if (cm) {
          // Aggression radius is 3 tiles (Chebyshev). NPCs lose interest in
          // players more than 20% above their own combat level — that lets
          // the level scale work both ways: low-level players get hunted,
          // high-level players walk past without aggro. The level cap fires
          // *before* the proximity check so we don't waste a player lookup
          // on someone we wouldn't aggro anyway. NPC level is derived from
          // the def (health + flat combat stats) via npcCombatLevel; player
          // level uses the standard SkillBlock formula.
          const npcLvl = npcCombatLevel(npc.def);
          const dropoffLvl = npcLvl * 1.2;
          cm.forEachPlayerNear(npc.position.x, npc.position.y, (pid) => {
            if (npc.combatTarget) return;
            const player = this.players.get(pid);
            if (!player) return;
            if (player.currentMapLevel !== npc.currentMapLevel || player.currentFloor !== npc.currentFloor) return;
            if (player.openInterface !== null || this.activeDuels?.has(player.id)) return;
            if (player.combatLevel > dropoffLvl) return;
            const fp = npc.distToFootprint(player.position.x, player.position.y);
            if (Math.abs(fp.dx) <= 3 && Math.abs(fp.dz) <= 3) {
              npc.combatTarget = player;
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
      if (canHaveAudience && this.npcHasInteractionAudience(npc)) {
        npc.pathQueue.length = 0;
      } else {
        const mapId = npc.currentMapLevel;
        const size = npc.size;
        const npcFloor = npc.currentFloor;
        // Self-footprint exclusion: an NPC must not block its own movement
        // via the entity-tile-occupants set. Compute the current footprint
        // keys once so the hot blocker can check membership in O(1).
        const selfAx = Math.floor(npc.position.x);
        const selfAz = Math.floor(npc.position.y);
        const selfMinX = selfAx - Math.floor((size - 1) / 2);
        const selfMinZ = selfAz - Math.floor((size - 1) / 2);
        const selfFootprintKeys = new Set<string>();
        for (let i = 0; i < size; i++) {
          for (let j = 0; j < size; j++) {
            selfFootprintKeys.add(this.blockedKeyFor(mapId, selfMinX + i, selfMinZ + j, npcFloor));
          }
        }
        // For size-1 NPCs the callbacks reduce to the original single-tile
        // checks. For larger NPCs the wrappers test every footprint tile
        // against terrain (map.isNpcBlocked) AND world-object blockers, and
        // require the move's leading wall edges to be open. Both wrappers
        // are allocation-free in the hot path (no footprint array per call).
        const npcBlocked = size <= 1
          ? (x: number, z: number) => {
              const key = this.blockedKeyFor(mapId, x, z, npcFloor);
              if (map.isTileBlockedOnFloor(x, z, npcFloor)) return true;
              if (this.blockedObjectTiles.has(key)) return true;
              // Refuse to step onto another entity. Self-occupancy is
              // filtered so the NPC never blocks its own current tile.
              if ((this.entityTileOccupants?.has(key) ?? false) && !selfFootprintKeys.has(key)) return true;
              return false;
            }
          : (x: number, z: number) => {
              const minX = Math.floor(x) - Math.floor((size - 1) / 2);
              const minZ = Math.floor(z) - Math.floor((size - 1) / 2);
              for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                  if (map.isTileBlockedOnFloor(minX + i, minZ + j, npcFloor)) return true;
                }
              }
              for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                  const key = this.blockedKeyFor(mapId, minX + i, minZ + j, npcFloor);
                  if (this.blockedObjectTiles.has(key)) return true;
                  if ((this.entityTileOccupants?.has(key) ?? false) && !selfFootprintKeys.has(key)) return true;
                }
              }
              return false;
            };
        const npcWallBlocked = size <= 1
          ? (fx: number, fz: number, tx: number, tz: number) => map.isWallBlockedOnFloor(fx, fz, tx, tz, npc.currentFloor)
          : (fx: number, fz: number, tx: number, tz: number) => {
              const minFx = Math.floor(fx) - Math.floor((size - 1) / 2);
              const minFz = Math.floor(fz) - Math.floor((size - 1) / 2);
              const minTx = Math.floor(tx) - Math.floor((size - 1) / 2);
              const minTz = Math.floor(tz) - Math.floor((size - 1) / 2);
              for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                  if (map.isWallBlockedOnFloor(minFx + i, minFz + j, minTx + i, minTz + j, npc.currentFloor)) return true;
                }
              }
              return false;
            };
        const npcFindPath = (sx: number, sz: number, gx: number, gz: number) =>
          map.findPathForNpc(sx, sz, gx, gz, npcBlocked, 100, npcWallBlocked);
        npc.processAI(npcBlocked, npcWallBlocked, npcFindPath);
      }
      if (hadCombatTarget && npc.combatTarget == null) {
        this.broadcastNearbyOnFloor(npc.currentMapLevel, npc.currentFloor, npc.position.x, npc.position.y,
          ServerOpcode.COMBAT_HIT, npc.id, -1, 0, npc.health, npc.maxHealth);
      }

      const cm = this.chunkManagers.get(npc.currentMapLevel);
      if (cm) cm.updateEntity(npc.id, npc.position.x, npc.position.y);
    }
  }

  /** Decrement attack cooldowns once per tick globally. RS2 semantics: the
   *  attack timer ticks regardless of whether the player is currently in
   *  combat or adjacent to a target — so walking to a mob doesn't reset
   *  your timer. The reset (back to full attack speed) still happens inside
   *  processPlayerCombat / processPlayerRangedCombat after a successful swing. */
  private tickPlayerCooldowns(): void {
    for (const [, player] of this.players) {
      if (player.attackCooldown > 0) player.attackCooldown--;
    }
  }

  private tickQueuedSpellCasts(): void {
    for (const [playerId, player] of this.players) {
      if (!player.pendingSpellCast || player.attackCooldown > 0) continue;
      if (player.hasMoveQueue()) continue;
      const { spellIndex, targetEntityId } = player.pendingSpellCast;
      player.pendingSpellCast = null;
      this.handlePlayerCastSpell(playerId, spellIndex, targetEntityId);
    }
  }

  private tickPlayerCombat(): void {
    const itemDefs = this.data.itemDefs;

    for (const [playerId, npcId] of this.playerCombatTargets) {
      const player = this.players.get(playerId);
      const npc = this.npcs.get(npcId);
      if (this.activeDuels?.has(playerId) || player?.openInterface === 'duel') {
        this.clearCombatTarget(playerId);
        continue;
      }
      if (!player || !npc || npc.dead || !this.canPlayerTargetNpc(player, npc)) {
        this.clearCombatTarget(playerId);
        continue;
      }

      if (player.autocastSpellIndex >= 0) {
        const def = this.data.getSpellByIndex(player.autocastSpellIndex);
        if (!def) {
          player.autocastSpellIndex = -1;
          continue;
        }
        const fp = npc.distToFootprint(player.position.x, player.position.y);
        const dist = Math.hypot(fp.dx, fp.dz);
        if (dist > SPELL_CAST_DISTANCE) {
          if (!player.hasMoveQueue()) this.queuePlayerPathToNpcRange(player, npc, SPELL_CAST_DISTANCE);
          continue;
        }
        if (player.attackCooldown <= 0) {
          this.handlePlayerCastSpell(playerId, player.autocastSpellIndex, npcId, true);
        }
        continue;
      }

      const isRanged = player.isRangedWeapon(itemDefs);
      const inAttackRange = this.isPlayerInNpcAttackRange(player, npc, isRanged ? 'ranged' : 'melee');
      if (!inAttackRange) {
        // Out of range — only re-pathfind when the existing queue has been
        // fully consumed (player arrived at the previous target tile but the
        // NPC has since moved). Re-pathing every tick used to trample the
        // active moveQueue: the client visual was walking the path it
        // computed locally, but the server kept overwriting moveQueue with
        // its own findPathOnFloor result. The two paths diverged from tick
        // one onward, and the >1.5-tile snap guard (GameManager.ts:1229)
        // teleported the local visual onto the server position. Leaving the
        // queue alone while it's being walked keeps client + server in sync;
        // the chase resumes when the queue runs dry.
        if (!player.hasMoveQueue()) {
          const path = this.findPlayerPathToNpc(player, npc);
          if (path.length > 0) {
            if (!isRanged) {
              player.setMoveQueue(path);
            } else {
              // Ranged: walk only as far as needed to be in attack distance.
              let cutIdx = path.length;
              for (let i = 0; i < path.length; i++) {
                const pf = npc.distToFootprint(path[i].x, path[i].z);
                if (Math.abs(pf.dx) <= RANGED_ATTACK_DISTANCE && Math.abs(pf.dz) <= RANGED_ATTACK_DISTANCE) {
                  cutIdx = i + 1;
                  break;
                }
              }
              player.setMoveQueue(path.slice(0, cutIdx));
            }
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
          const arrowStr = ammo.itemDef.rangedStrength ?? 0;
          result = processPlayerRangedCombat(player, npc, itemDefs, arrowStr);
          if (result) {
            player.removeItemFromSlot(ammo.slotIndex, 1);
            this.sendInventory(player);
            this.broadcastProjectile(player.id, npc.id, 1, player.currentMapLevel, player.currentFloor, player.position.x, player.position.y);
          }
        } else {
          this.clearCombatTarget(playerId);
          this.sendChatSystem(player, 'You have no arrows left.');
          continue;
        }
      } else {
        result = processPlayerCombat(player, npc, itemDefs);
      }
      if (result) {
        this.setPlayerAnimation(player, PlayerAnimationKind.Attack, PlayerSkillAnimationVariant.None, npc.id, true);
        this.broadcastNpcFacingPlayer(npc, player);
        // Arm post-combat logout block — player can't safely log off mid-fight.
        player.markInCombat(this.currentTick);
        player.botStats?.recordCombatSwing(this.currentTickStartMs, performance.now());
        this.broadcastCombatHit(result.hit.attackerId, result.hit.targetId, result.hit.damage, result.hit.targetHealth, result.hit.targetMaxHealth, player.currentMapLevel, player.currentFloor, npc.position.x, npc.position.y);

        for (const xp of result.xpDrops) {
          const skillIdx = ALL_SKILLS.indexOf(xp.skill as SkillId);
          if (skillIdx >= 0) {
            this.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, xp.amount);
          }
        }

        for (const lu of result.levelUps) {
          const skillIdx = ALL_SKILLS.indexOf(lu.skill as SkillId);
          if (skillIdx >= 0) {
            this.sendToPlayer(player, ServerOpcode.LEVEL_UP, skillIdx, lu.level);
          }
        }

        for (const xp of result.xpDrops) {
          const skillIdx = ALL_SKILLS.indexOf(xp.skill as SkillId);
          if (skillIdx >= 0) this.sendSingleSkill(player, skillIdx);
        }

        if (!npc.alive) {
          npc.die();
          this.clearCombatTarget(playerId);
          // Bot-detection: mark the kill timestamp so the next attack swing
          // gets a reaction-time delta. Bots re-engage within 50ms; humans
          // 300-800ms.
          player.botStats?.recordNpcDeath(performance.now());

          // Quest hook — may start a quest (probability-gated, e.g. the
          // "1/20 on cow kill" starter trigger) AND/OR advance the current
          // stage of any active quest whose trigger matches this npc def.
          this.quests.notifyQuestEvent(player, { type: 'npcKill', npcDefId: npc.def.id });

          this.handleNpcDeath(npc);

          // Drop where the NPC actually died, not at its spawn tile. Loot is
          // private to the highest damager first, then becomes public.
          this.spawnNpcLoot(npc, npc.getTopDamager());
        }
      }
    }
  }

  /**
   * Apply queued spell damage that has reached its impact tick. Damage was
   * already rolled at cast time, so this just delivers the result. Target may
   * have died, moved maps, or the caster may have disconnected — all skipped.
   */
  private tickPendingSpells(): void {
    if (this.pendingSpellImpacts.length === 0) return;

    const remaining: typeof this.pendingSpellImpacts = [];
    for (const imp of this.pendingSpellImpacts) {
      if (imp.impactTick > this.currentTick) { remaining.push(imp); continue; }

      const player = this.players.get(imp.attackerId);
      const npc = this.npcs.get(imp.targetId);
      if (!player || !npc || npc.dead) continue;
      if (player.openInterface === 'duel' || this.activeDuels?.has(player.id)) continue;
      if (npc.currentMapLevel !== imp.mapLevel || npc.currentFloor !== imp.floor) continue;
      if (player.currentMapLevel !== imp.mapLevel || player.currentFloor !== imp.floor) continue;

      const actual = npc.takeDamage(imp.damage);

      if (npc.alive) {
        const wasInCombat = npc.combatTarget != null;
        npc.combatTarget = player;
        if (!wasInCombat) {
          npc.attackCooldown = Math.floor(npc.attackSpeed / 2);
        }
      }

      // XP: 4 per damage to the spell's school (locked in at cast time).
      // Same rate as melee/ranged so a magic-only player isn't penalised.
      if (actual > 0) {
        const oldHpLevel = player.skills.hitpoints.level;
        const amt = actual * 4;
        const r = addXp(player.skills, imp.xpSkill, amt);
        const skillIdx = ALL_SKILLS.indexOf(imp.xpSkill);
        if (skillIdx >= 0) {
          this.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, Math.floor(amt));
          if (r.leveled) this.sendToPlayer(player, ServerOpcode.LEVEL_UP, skillIdx, r.newLevel);
          this.sendSingleSkill(player, skillIdx);
        }
        const hpIdx = ALL_SKILLS.indexOf('hitpoints');
        if (hpIdx >= 0 && player.skills.hitpoints.level > oldHpLevel) {
          this.sendToPlayer(player, ServerOpcode.LEVEL_UP, hpIdx, player.skills.hitpoints.level);
        }
        npc.addHeroPoints(player.id, actual);
        player.syncHealthFromSkills();
      }

      this.broadcastNpcFacingPlayer(npc, player);
      this.broadcastCombatHit(player.id, npc.id, actual, npc.health, npc.maxHealth, npc.currentMapLevel, npc.currentFloor, npc.position.x, npc.position.y);

      if (!npc.alive) {
        npc.die();
        this.clearCombatTarget(imp.attackerId);
        this.handleNpcDeath(npc);

        this.spawnNpcLoot(npc, npc.getTopDamager());
      }
    }
    this.pendingSpellImpacts = remaining;
  }

  private tickNpcCombat(): void {
    const itemDefs = this.data.itemDefs;

    for (const [, npc] of this.npcs) {
      if (npc.dead || !npc.combatTarget) continue;
      const target = npc.combatTarget as Player;
      if (!target.alive || !this.players.has(target.id) || target.currentMapLevel !== npc.currentMapLevel || target.currentFloor !== npc.currentFloor) {
        npc.combatTarget = null;
        continue;
      }
      if (this.activeDuels?.has(target.id) || target.openInterface === 'duel') {
        npc.combatTarget = null;
        npc.pathQueue.length = 0;
        continue;
      }

      const hit = processNpcCombat(npc, target, itemDefs);
      if (hit) {
        // Player took (or dodged) a hit — arm post-combat logout block.
        target.markInCombat(this.currentTick);
        this.broadcastNpcFacingPlayer(npc, target);
        this.broadcastCombatHit(hit.attackerId, hit.targetId, hit.damage, hit.targetHealth, hit.targetMaxHealth, npc.currentMapLevel, npc.currentFloor, target.position.x, target.position.y);

        this.sendToPlayer(target, ServerOpcode.PLAYER_STATS,
          target.health, target.maxHealth
        );
        this.sendSingleSkill(target, HITPOINTS_SKILL_INDEX);

        if (!target.alive) {
          npc.combatTarget = null;
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
          const toolAccuracyBonus = obj.def.category === 'rock'
            ? (action.toolBonus ?? 0) * World.MINING_TOOL_ACCURACY_BONUS
            : 0;
          if (!statRandom(playerLevel, chances[0] + toolAccuracyBonus, chances[1] + toolAccuracyBonus)) {
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
              ? { completed: player.addItem(drop.itemId, drop.quantity, this.data.itemDefs).completed, dropped: 0 }
              : {
                  completed: this.awardHarvestItem(player, drop.itemId, drop.quantity).added,
                  dropped: 0,
                };
            if (got.completed > 0) {
              inventoryChanged = true;
              if (isChest) {
                foundForChest.push({ itemId: drop.itemId, quantity: got.completed });
              } else {
                const itemDef = this.data.itemDefs.get(drop.itemId);
                const name = itemDef?.name ?? `item ${drop.itemId}`;
                this.sendChatSystem(player, `You find a ${name}!`);
              }
              this.quests.notifyQuestEvent(player, { type: 'itemPickup', itemId: drop.itemId, quantity: got.completed, source: isChest ? 'chest' : 'harvest' });
            }
          }
        }

        if (xpReward > 0) {
          const result = addXp(player.skills, skillId, xpReward);
          const skillIdx = ALL_SKILLS.indexOf(skillId);
          if (skillIdx >= 0) {
            this.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, xpReward);
            if (result.leveled) {
              this.sendToPlayer(player, ServerOpcode.LEVEL_UP, skillIdx, result.newLevel);
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
        this.setObjectTilesBlocked(obj.mapLevel, obj.x, obj.z, obj.def, true, obj.floor);
        // Skilling object respawned — drop the persisted target.
        this.db.clearObjectRespawn(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z), obj.floor);
        // Pass swingSign=0 to match the toggle path's packet shape — auto-
        // close doesn't need a direction (the close animation ignores it).
        this.broadcastWorldObjectStateChange(obj);
      }
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
      broadcastLocalMessage(line.playerName, line.message);
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

      const tx = Math.floor(player.position.x);
      const tz = Math.floor(player.position.y);
      const oldFloor = player.currentFloor;
      const tileIdx = tz * map.width + tx;

      // Clear the per-tile lock once the player moves off the tile where they
      // last transitioned. Re-entering the same tile later (e.g. wandering
      // back to the top of a stair) is allowed.
      if (player.lastFloorChangeTile !== -1 && player.lastFloorChangeTile !== tileIdx) {
        player.lastFloorChangeTile = -1;
      }

      // Floor change fires on the tile where stair entries exist on BOTH the
      // current floor AND an adjacent floor (the top tile of a stair, after
      // GameMap's mirror). Bottom/middle tiles only have a stair on floor 0
      // so they're a no-op. The per-tile lock prevents oscillation: once we
      // transition AT a tile, we won't re-transition there until the player
      // walks elsewhere.
      const onPlacedGroundStair = !!map.getStairOnFloor(tx, tz, 0);
      const stairCurrent = map.getStairOnFloor(tx, tz, player.currentFloor);
      if (stairCurrent && player.lastFloorChangeTile !== tileIdx) {
        const stairAbove = map.getStairOnFloor(tx, tz, player.currentFloor + 1);
        const stairBelow = player.currentFloor > 0 ? map.getStairOnFloor(tx, tz, player.currentFloor - 1) : null;
        if (stairAbove) {
          player.currentFloor += 1;
          player.lastFloorChangeTile = tileIdx;
        } else if (stairBelow) {
          player.currentFloor -= 1;
          player.lastFloorChangeTile = tileIdx;
        }
      }
      if (player.currentFloor === oldFloor && !onPlacedGroundStair) {
        player.currentFloor = this.inferFloorFromEffectiveY(
          map,
          player.position.x,
          player.position.y,
          player.effectiveY,
          player.currentFloor,
        );
      }

      if (player.currentFloor !== oldFloor) {
        // The floor index just changed — re-resolve the walking elevation
        // against the new floor's layer before the next move validates.
        this.clearCombatReferencesTo(player.id);
        player.pendingPickup = -1;
        player.pendingSpellCast = null;
        this.closeNpcUiContext(player);
        this.refreshPlayerEffectiveY(player);
        player.syncDirty = true;
        this.sendFloorChange(player);
      }
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

    // Tell observers the player died at their current tile. Mirrors the
    // NPC death broadcast — clients use this to clear the remote entity.
    this.broadcastNearbyOnFloor(oldMapId, oldFloor, oldX, oldZ, ServerOpcode.ENTITY_DEATH, player.id, EntityDeathKind.Death);

    // Abort any modal interface BEFORE position changes. Trade abort returns
    // items to both sides; bank close just clears the flag (contents are
    // already safe in player.bank).
    if (player.isInterfaceOpen()) this.closeOpenInterface(player, /*declineTrade*/ true);

    // Drop all transient combat / action state.
    this.clearCombatTarget(player.id);
    this.cancelSkilling(player.id);
    player.clearMoveQueue();
    player.attackTarget = null;
    this.clearPendingObjectIntents(player);
    player.pendingSpellCast = null;
    player.pendingTalkNpcId = -1;
    player.pendingTalkRepathTicks = 0;
    player.pendingPickup = -1;
    player.attackCooldown = 0;
    player.delayedUntilTick = 0;
    player.logoutBlockedUntilTick = 0;
    player.actionDelay = 0;
    player.openShopNpcId = null;
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
    for (const [, itemId] of player.equipment) {
      const def = itemDefs.get(itemId);
      const v = def?.value ?? 0;
      pool.push({ itemId, quantity: 1, totalValue: v });
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
    player.equipment.clear();
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
      if (cm) cm.addEntity(groundItem.id, groundItem.x, groundItem.z);
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
    this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));
    const droppedCount = dropped.length;
    if (droppedCount > 0) {
      this.sendChatSystem(player, `Oh dear, you are dead. You dropped ${droppedCount} item${droppedCount === 1 ? '' : 's'}.`);
    } else {
      this.sendChatSystem(player, 'Oh dear, you are dead.');
    }
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
    let targetFloor = forcedFloor !== undefined ? Math.max(0, Math.floor(forcedFloor)) : player.currentFloor;
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
    player.position.x = targetX;
    player.position.y = targetZ;
    player.followAnchorX = targetX;
    player.followAnchorZ = targetZ;
    player.clearMoveQueue();
    player.attackTarget = null;
    this.clearPendingObjectIntents(player);
    player.pendingPickup = -1;
    player.pendingSpellCast = null;
    player.pendingTalkNpcId = -1;
    player.pendingTalkRepathTicks = 0;
    player.followTargetPlayerId = -1;
    player.actionDelay = 0;
    this.cancelSkilling(player.id);
    this.clearCombatTarget(player.id);
    player.currentChunkX = Math.floor(targetX / CHUNK_SIZE);
    player.currentChunkZ = Math.floor(targetZ / CHUNK_SIZE);
    if (cm) cm.addEntity(player.id, targetX, targetZ);
    // Compute server-authoritative Y at the destination. Forced floor changes
    // deliberately bypass the elevated-plane auto-snap so commands like
    // /spawn can put a player back on the ground under a two-story building.
    let teleportY = forcedY;
    if (teleportY == null) {
      const heightGateY = forceFloorChange && player.currentFloor === 0 ? undefined : player.reportedY;
      teleportY = map.getEffectiveHeightOnFloor(targetX, targetZ, player.currentFloor, heightGateY);
      const elevAtTile = !forceFloorChange ? map.getElevatedFloorHeight(targetX, targetZ) : undefined;
      if (typeof elevAtTile === 'number' && elevAtTile > 1.0 && teleportY < elevAtTile - 1.0) {
        teleportY = elevAtTile;
      }
    }
    player.reportedY = teleportY;
    player.effectiveY = teleportY;
    const packet = encodePacket(
      ServerOpcode.PLAYER_TELEPORT,
      qPos(targetX),
      qPos(targetZ),
      qPos(teleportY),
      player.currentFloor,
    );
    try { player.ws.sendBinary(packet); } catch {}
  }

  handleMapTransition(player: Player, transition: { targetMap: string; targetX: number; targetZ: number }): void {
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
      && !targetMapObj.isBlocked(tileX, tileZ);
    if (!targetValid) {
      const fallback = targetMapObj.findSpawnPoint();
      console.warn(`[handleMapTransition] invalid target (${targetX},${targetZ}) on ${newMap}; using spawn (${fallback.x},${fallback.z})`);
      transition = { targetMap: newMap, targetX: fallback.x, targetZ: fallback.z };
    }

    // Defense in depth: any modal interface (bank/trade) must close BEFORE
    // we save + transition. Movement also auto-closes via handlePlayerMove,
    // but transitions can fire from admin teleport (PLAYER_TELEPORT path)
    // which doesn't go through handlePlayerMove — without this, a player
    // could be admin-teleported with bank state still flagged open, then
    // pick it back up on the other map and double-deposit.
    if (player.isInterfaceOpen()) this.closeOpenInterface(player, /*declineTrade*/ true);
    player.openShopNpcId = null;
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
    this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));

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
    player.position.x = transition.targetX;
    player.position.y = transition.targetZ;
    player.followAnchorX = transition.targetX;
    player.followAnchorZ = transition.targetZ;
    player.currentFloor = 0;
    player.lastFloorChangeTile = -1;
    // Re-derive the authoritative collision elevation for the new map — the
    // old map's effectiveY is meaningless here. Cross-map transitions land
    // on floor 0 unless a future transition type explicitly carries floor.
    player.effectiveY = targetMapObj.getEffectiveHeightOnFloor(
      player.position.x, player.position.y, player.currentFloor);
    player.clearMoveQueue();
    player.attackTarget = null;
    this.clearCombatTarget(player.id);

    // Update chunk position
    player.currentChunkX = Math.floor(player.position.x / CHUNK_SIZE);
    player.currentChunkZ = Math.floor(player.position.y / CHUNK_SIZE);

    // Add to new map's chunk manager
    const newCm = this.chunkManagers.get(newMap);
    if (newCm) {
      newCm.addEntity(player.id, player.position.x, player.position.y);
      newCm.registerPlayer(player.id);
    }

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
          player.combatLevel,
          player.currentFloor,
          qPos(player.effectiveY),
        ));
      }
    }
    for (const [, npc] of this.npcs) {
      if (npc.dead) continue;
      const sx = qPos(npc.position.x);
      const sz = qPos(npc.position.y);
      if (sx !== npc.lastSyncX || sz !== npc.lastSyncZ || npc.health !== npc.lastSyncHealth) {
        npc.lastSyncX = sx;
        npc.lastSyncZ = sz;
        npc.lastSyncHealth = npc.health;
        npc.syncDirty = true;
        dirtyNpcPackets.set(npc.id, encodePacket(ServerOpcode.NPC_SYNC,
          npc.id, npc.npcId, sx, sz, npc.health, npc.maxHealth,
          npc.currentFloor,
          qPos(this.npcWorldY(npc)),
          this.npcWillContinueWalking(npc) ? 1 : 0,
        ));
      }
    }

    // Phase 2: Viewer-first iteration — all sends to each viewer are consecutive
    for (const [, viewer] of this.players) {
      if (viewer.disconnected) continue;
      const a = viewer.appearance;
      this.sendToPlayer(
        viewer,
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
      );
      const cm = this.chunkManagers.get(viewer.currentMapLevel);
      if (!cm) continue;

      try {
        const nextVisible = new Set<number>();
        cm.forEachEntityNearChunk(viewer.currentChunkX, viewer.currentChunkZ, (eid) => {
          if (eid === viewer.id) return;
          const subject = this.players.get(eid);
          if (subject && subject.currentFloor !== viewer.currentFloor) return;
          const npc = this.npcs.get(eid);
          if (npc && (npc.dead || npc.currentFloor !== viewer.currentFloor)) return;
          const obj = this.worldObjects.get(eid);
          if (obj && !this.canPlayerTargetObject(viewer, obj)) return;
          const item = this.groundItems.get(eid);
          if (item && !this.canPlayerTargetGroundItem(viewer, item)) return;
          nextVisible.add(eid);
        });

        for (const eid of viewer.visibleEntityIds) {
          if (!nextVisible.has(eid)) {
            this.sendToPlayer(viewer, ServerOpcode.ENTITY_DEATH, eid);
          }
        }

        nextVisible.forEach((eid) => {
          const wasVisible = viewer.visibleEntityIds.has(eid);
          if (wasVisible) {
            const pkt = dirtyPlayerPackets.get(eid);
            if (pkt) { viewer.ws.sendBinary(pkt); return; }
            const npkt = dirtyNpcPackets.get(eid);
            if (npkt) { viewer.ws.sendBinary(npkt); return; }
            return;
          }

          const subject = this.players.get(eid);
          if (subject && subject.currentFloor === viewer.currentFloor) {
            this.sendPlayerPresence(viewer, subject);
            return;
          }
          const npc = this.npcs.get(eid);
          if (npc && this.canPlayerTargetNpc(viewer, npc)) {
            this.sendNpcStaticData(viewer, npc);
            this.sendNpcUpdate(viewer, npc);
            return;
          }
          // Re-sync world objects on chunk transitions. Without this, a player
          // who walks into range of a door that was opened (or a tree that was
          // chopped, etc.) while they were too far away to receive the
          // WORLD_OBJECT_DEPLETED broadcast keeps a stale local state and
          // can't interact correctly until they re-login.
          const obj = this.worldObjects.get(eid);
          if (obj && this.canPlayerTargetObject(viewer, obj)) { this.sendWorldObjectUpdate(viewer, obj); return; }
          // Re-sync ground items too — a player who saw a drop, walked OOR,
          // and walked back would otherwise keep the stale local sprite for
          // an item the server has already despawned (or vice versa).
          const item = this.groundItems.get(eid);
          if (item && this.canPlayerTargetGroundItem(viewer, item)) {
            this.sendGroundItemUpdate(viewer, item);
          }
        });

        viewer.visibleEntityIds = nextVisible;
        viewer.lastBroadcastChunkX = viewer.currentChunkX;
        viewer.lastBroadcastChunkZ = viewer.currentChunkZ;
      } catch { /* connection closed */ }
    }

    // Phase 3: Clear dirty flags
    for (const [, player] of this.players) player.syncDirty = false;
    for (const [, npc] of this.npcs) npc.syncDirty = false;
  }

  private broadcastCombatHit(attackerId: number, targetId: number, damage: number, targetHp: number, targetMaxHp: number, mapLevel: string, floor: number, worldX: number, worldZ: number): void {
    this.broadcastNearbyOnFloor(mapLevel, floor, worldX, worldZ, ServerOpcode.COMBAT_HIT, attackerId, targetId, damage, targetHp, targetMaxHp);
  }

  private broadcastProjectile(attackerId: number, targetId: number, projectileType: number, mapLevel: string, floor: number, worldX: number, worldZ: number): void {
    this.broadcastNearbyOnFloor(mapLevel, floor, worldX, worldZ, ServerOpcode.COMBAT_PROJECTILE, attackerId, targetId, projectileType);
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

  private sendPlayerUpdate(viewer: Player, subject: Player): void {
    if (viewer.currentMapLevel !== subject.currentMapLevel || viewer.currentFloor !== subject.currentFloor) return;
    const a = subject.appearance;
    this.sendToPlayer(viewer, ServerOpcode.PLAYER_SYNC,
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
      subject.combatLevel,
      subject.currentFloor,
      qPos(subject.effectiveY),
    );
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
    if (!npc.combatTarget) return false;
    const fp = npc.distToFootprint(npc.combatTarget.position.x, npc.combatTarget.position.y);
    return Math.max(Math.abs(fp.dx), Math.abs(fp.dz)) > Npc.MELEE_RANGE;
  }

  private sendNpcUpdate(viewer: Player, npc: Npc): void {
    if (!this.canPlayerTargetNpc(viewer, npc)) return;
    this.sendToPlayer(viewer, ServerOpcode.NPC_SYNC,
      npc.id,
      npc.npcId,
      qPos(npc.position.x),
      qPos(npc.position.y),
      npc.health,
      npc.maxHealth,
      npc.currentFloor,
      qPos(this.npcWorldY(npc)),
      this.npcWillContinueWalking(npc) ? 1 : 0,
    );
  }

  /** Push the NPC's per-spawn appearance + equipment to a viewer who is
   *  about to see this NPC for the first time (map load, chunk entry, or
   *  respawn). No-op when the NPC has no customization — sprite/built-in
   *  3D NPCs (rat, cow, chicken, …) skip this entirely. */
  private sendNpcStaticData(viewer: Player, npc: Npc): void {
    const a = npc.appearance;
    if (a) {
      this.sendToPlayer(viewer, ServerOpcode.NPC_APPEARANCE,
        npc.id,
        a.shirtColor, a.pantsColor, a.shoesColor,
        a.hairColor, a.beltColor, a.skinColor,
        a.hairStyle,
      );
    }
    const eq = npc.equipment;
    if (eq && eq.length === 10) {
      this.sendToPlayer(viewer, ServerOpcode.NPC_EQUIPMENT,
        npc.id,
        eq[0], eq[1], eq[2], eq[3], eq[4],
        eq[5], eq[6], eq[7], eq[8], eq[9],
      );
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
      this.sendToPlayer(viewer, ServerOpcode.NPC_CUSTOM_COLORS, ...payload);
    }
    // Tell the client which non-combat actions this NPC supports, so its
    // right-click menu can offer Talk-to / Trade / Bank without the client
    // needing to mirror npcs.json. Skip when there are none — the bit field
    // would be 0 and the client's default (attackable mob) is correct.
    const flags = npc.interactionFlags();
    if (flags !== 0) {
      this.sendToPlayer(viewer, ServerOpcode.NPC_INTERACTIONS, npc.id, flags);
    }
    // Custom per-spawn display name. Most NPCs don't have one — skip the
    // packet so we're not spamming the wire with default names.
    if (npc.nameOverride) {
      const packet = encodeStringPacket(ServerOpcode.NPC_NAME, npc.nameOverride, npc.id);
      try { viewer.ws.sendBinary(packet); } catch { /* connection closed */ }
    }
    // Forced-swing animation override. Same string-packet shape as NPC_NAME.
    if (npc.attackAnimOverride) {
      const packet = encodeStringPacket(ServerOpcode.NPC_ATTACK_ANIM, npc.attackAnimOverride, npc.id);
      try { viewer.ws.sendBinary(packet); } catch { /* connection closed */ }
    }
  }

  private sendWorldObjectUpdate(viewer: Player, obj: WorldObject): void {
    if (!this.canPlayerTargetObject(viewer, obj)) return;
    const packet = this.encodeWorldObjectUpdate(obj);
    try { viewer.ws.sendBinary(packet); } catch { /* connection closed */ }
  }

  private encodeWorldObjectUpdate(obj: WorldObject): Uint8Array {
    const explicitTiles = this.explicitObjectInteractionTiles(obj).slice(0, 16);
    const tileValues = explicitTiles.flatMap(tile => [tile.x, tile.z]);
    // [objectEntityId, objectDefId, x*10, z*10, depleted(0/1), interactionMask, rotY*1000, floor, y*10, explicitTileCount, ...tileX,tileZ, doorOpenDirection, doorLocked]
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
    // Batch: [slot0_itemId, slot1_itemId, ...] — 1 packet instead of 10
    const values: number[] = [];
    for (let i = 0; i < EQUIPMENT_SLOT_NAMES.length; i++) {
      values.push(player.equipment.get(EQUIPMENT_SLOT_NAMES[i]) ?? 0);
    }
    this.sendToPlayer(player, ServerOpcode.PLAYER_EQUIPMENT_BATCH, ...values);
  }

  /** Build PLAYER_REMOTE_EQUIPMENT packet for a subject player. Layout:
   *  [entityId, weapon, shield, head, body, legs, neck, ring, hands, feet, cape] */
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
    const stances = ['accurate', 'aggressive', 'defensive', 'controlled'] as const;
    const idx = Math.max(0, stances.indexOf(subject.stance));
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
      this.db.saveObjectRespawn(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z), obj.floor, Date.now() + obj.respawnTimer * TICK_RATE);
    } else {
      this.db.clearObjectRespawn(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z), obj.floor);
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

    const appearance = isValidAppearance(player.appearance ?? DEFAULT_APPEARANCE)
      ? { ...(player.appearance ?? DEFAULT_APPEARANCE) }
      : { ...DEFAULT_APPEARANCE };

    spawn.appearance = spawn.appearance && isValidAppearance(spawn.appearance)
      ? spawn.appearance
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
    cm.forEachPlayerNear(npc.position.x, npc.position.y, (pid) => {
      const viewer = this.players.get(pid);
      if (!viewer || viewer.disconnected || viewer.currentMapLevel !== npc.currentMapLevel) return;
      this.sendNpcStaticData(viewer, npc);
    });
  }

  /** Convenience: get the default ('kcmap') map. Used by legacy callers
   *  that pre-date the multi-map system. */
  get map(): GameMap {
    return this.getMap('kcmap');
  }
}
