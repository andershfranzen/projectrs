import { TICK_RATE, CHUNK_SIZE, CHUNK_LOAD_RADIUS, MAX_STACK, NPC_INTERACTION_RANGE, PROTOCOL_VERSION, ServerOpcode, PlayerAnimationKind, PlayerSkillAnimationVariant, ALL_SKILLS, SKILL_NAMES, ASSET_TO_OBJECT_DEF, BLOCKING_DECOR_ASSETS, WallEdge, doorEdgeFromPlacement, doorClosedEdgeFromRotY, DOOR_EDGE_NEIGHBOR, getObjectFootprintTiles, getObjectInteractionTiles, isTileAdjacentToObject, localSidesToWorldSides, type SkillId, type ItemDef, type PlayerAppearance, type WorldObjectDef, isValidAppearance } from '@projectrs/shared';
import { audit } from './Audit';
import { BotStats } from './BotStats';
import { encodePacket, encodeStringPacket } from '@projectrs/shared';
import { addXp, levelFromXp, statRandom, npcCombatLevel, magicMaxHit, rollHit, ACC_BASE, spellSchoolSkill } from '@projectrs/shared';
import { GameMap } from './GameMap';
import { Player, type EquipSlot } from './entity/Player';
import { Npc } from './entity/Npc';
import { WorldObject } from './entity/WorldObject';
import { DataLoader } from './data/DataLoader';
import { GameDatabase } from './Database';
import { processPlayerCombat, processPlayerRangedCombat, processNpcCombat, rollLoot, RANGED_ATTACK_DISTANCE } from './combat/Combat';
import { broadcastPlayerInfo, sendSystemMessageToUser } from './network/ChatSocket';
import { ServerChunkManager } from './ChunkManager';
import { QuestService } from './quest/QuestService';
import { readdirSync } from 'fs';
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
/** Encode map+tile into a single number. Supports tiles up to 65535x65535 with up to ~2000 maps. */
function blockedKey(mapIdx: number, tileX: number, tileZ: number): number {
  return mapIdx * 4294967296 + tileX * 65536 + tileZ;
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
/** Despawn timer (ticks) applied to most ground items — NPC kill loot and
 *  player-dropped items. ~2 minutes at 600ms/tick. */
const GROUND_ITEM_DESPAWN_TICKS = 200;
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

/** Canonical ordering of equipment slots used for binary opcode encoding.
 *  Must stay in sync with the client-side decoder in GameManager. */
const EQUIPMENT_SLOT_NAMES: EquipSlot[] = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];

export interface GroundItem {
  id: number;
  itemId: number;
  quantity: number;
  x: number;
  z: number;
  mapLevel: string;
  despawnTimer: number;
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

let nextGroundItemId = 1;

/** Max distance in tiles a player can cast a spell from. Generous for testing — refine in Phase 5. */
const SPELL_CAST_DISTANCE = 10;

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
  /** Tiles blocked by non-depleted world objects, encoded as numeric key */
  private blockedObjectTiles: Set<number> = new Set();

  private currentTick: number = 0;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private saveTimer: ReturnType<typeof setInterval> | null = null;

  // Player combat targets (playerId -> npcId)
  private playerCombatTargets: Map<number, number> = new Map();
  // Reverse lookup: npcId -> set of playerIds targeting it (kept in sync with playerCombatTargets)
  private npcTargetedBy: Map<number, Set<number>> = new Map();

  /** Ground items with active despawn timers (avoids iterating all permanent items) */
  private despawningItemIds: Set<number> = new Set();

  /** World objects currently depleted and awaiting respawn */
  private depletedObjectIds: Set<number> = new Set();

  /** Reusable set for health regen — avoids allocation every 10 ticks */
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
   *  (mapLevel, defId, tileX, tileZ) — stable across editor saves and
   *  reboots — so we scan worldObjects for the matching live entity instead
   *  of looking up by runtime entity id. */
  private restorePersistedObjectState(): void {
    // One-time pass: build a (map|defId|tx|tz) → WorldObject index so the
    // O(rows × worldObjects) restore work collapses to O(rows + worldObjects).
    const stableIndex = new Map<string, WorldObject>();
    const stableKey = (mapLevel: string, defId: number, tileX: number, tileZ: number) =>
      `${mapLevel}|${defId}|${tileX}|${tileZ}`;
    for (const [, obj] of this.worldObjects) {
      stableIndex.set(stableKey(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z)), obj);
    }

    try {
      const doorRows = this.db.loadAllDoorStates();
      let restored = 0;
      for (const row of doorRows) {
        const obj = stableIndex.get(stableKey(row.mapLevel, row.defId, row.tileX, row.tileZ));
        if (!obj || obj.def.category !== 'door') {
          // Object was deleted from the map or its def changed — drop the
          // stale row. With stable identity this only happens on real
          // edits, not on routine spawn-order reshuffles.
          this.db.clearDoorState(row.mapLevel, row.defId, row.tileX, row.tileZ);
          continue;
        }
        if (row.isOpen && !obj.doorOpen) {
          const map = this.maps.get(obj.mapLevel);
          if (!map) continue;
          this.clearDoorWallEdges(obj, map);
          obj.doorOpen = true;
          obj.depleted = true;
          // Re-arm a fresh auto-close timer. The persisted auto_close_at_tick
          // is informational only — we don't try to map it back through the
          // pre-restart tick clock, just give the door its full timeout again.
          obj.respawnTimer = obj.def.respawnTime ?? DEFAULT_OBJECT_RESPAWN_TICKS;
          this.depletedObjectIds.add(obj.id);
          restored++;
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
        const obj = stableIndex.get(stableKey(row.mapLevel, row.defId, row.tileX, row.tileZ));
        if (!obj) {
          this.db.clearObjectRespawn(row.mapLevel, row.defId, row.tileX, row.tileZ);
          continue;
        }
        // Doors handled by door_state above; skip here.
        if (obj.def.category === 'door') continue;
        const msRemaining = row.respawnAtUnixMs - now;
        if (msRemaining <= 0) {
          // Already due — drop the row, leave the live spawn alone.
          this.db.clearObjectRespawn(row.mapLevel, row.defId, row.tileX, row.tileZ);
          continue;
        }
        const ticksRemaining = Math.max(1, Math.ceil(msRemaining / TICK_RATE));
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

    // Remove old NPCs and world objects for this map
    for (const [id, npc] of this.npcs) {
      if (npc.currentMapLevel === mapId) this.npcs.delete(id);
    }
    for (const [id, obj] of this.worldObjects) {
      if (obj.mapLevel === mapId) {
        this.setObjectTilesBlocked(mapId, obj.x, obj.z, obj.def, false);
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
        effShop, effDialogue, spawn.name ?? null);
      npc.currentMapLevel = mapId;
      this.npcs.set(npc.id, npc);
      cm.addEntity(npc.id, spawn.x, spawn.z);
    }
    // Derive world objects from placed objects in map.json (single source of truth)
    const objectSpawns: { objectId: number; x: number; z: number; rotY?: number; trigger?: any; interactionSides?: number }[] = [];
    for (const placed of gameMap.placedObjects) {
      const defId = ASSET_TO_OBJECT_DEF[placed.assetId];
      if (defId != null) {
        objectSpawns.push({ objectId: defId, x: placed.position.x, z: placed.position.z, rotY: placed.rotation?.y, trigger: placed.trigger, interactionSides: placed.interactionSides });
        continue;
      }
      // Thin-instanced decor stays a tile blocker only — no WorldObject entity.
      if (BLOCKING_DECOR_ASSETS.has(placed.assetId)) {
        const tx = Math.floor(placed.position.x);
        const tz = Math.floor(placed.position.z);
        this.blockedObjectTiles.add(this.blockedKeyFor(mapId, tx, tz));
      }
    }
    // Fallback: sprite-only objects from spawns.json
    for (const obj of spawns.objects ?? []) {
      objectSpawns.push(obj);
    }
    for (const spawn of objectSpawns) {
      const objDef = this.data.getObject(spawn.objectId);
      if (!objDef) continue;
      const obj = new WorldObject(objDef, spawn.x, spawn.z, mapId);
      if (spawn.rotY != null) obj.rotationY = spawn.rotY;
      if (spawn.trigger) obj.trigger = spawn.trigger;
      if (spawn.interactionSides) obj.interactionSides = spawn.interactionSides;
      this.worldObjects.set(obj.id, obj);
      this.setObjectTilesBlocked(mapId, spawn.x, spawn.z, objDef, true);
      if (objDef.category === 'door') {
        this.initDoorEdge(obj);
        this.setDoorWallEdges(obj, gameMap);
      }
      cm.addEntity(obj.id, spawn.x, spawn.z);
    }

    // Re-spawn ground items for this map
    for (const [id, item] of this.groundItems) {
      if (item.mapLevel === mapId) this.groundItems.delete(id);
    }
    for (const item of spawns.items ?? []) {
      const groundItem: GroundItem = {
        id: nextGroundItemId++,
        itemId: item.itemId,
        quantity: item.quantity ?? 1,
        x: item.x,
        z: item.z,
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
      if (other) { this.sendPlayerUpdate(player, other); continue; }
      const npc = this.npcs.get(eid);
      if (npc && !npc.dead) {
        // Static data first — the client uses cached appearance to decide
        // whether to render as sprite or CharacterEntity on NPC_SYNC.
        this.sendNpcStaticData(player, npc);
        this.sendNpcUpdate(player, npc);
        continue;
      }
      const obj = this.worldObjects.get(eid);
      if (obj) { this.sendWorldObjectUpdate(player, obj); continue; }
      const item = this.groundItems.get(eid);
      if (item) { this.sendGroundItemUpdate(player, item); continue; }
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

  /** Path from the player to the NPC's interaction surface.
   *  - Size-1: path to the anchor tile; melee callers strip the trailing tile.
   *  - Size-N: target the cardinal-adjacent tile closest to the player and
   *    pathfind there directly. The returned queue stops adjacent to the
   *    footprint, so melee callers do NOT slice(0, -1) in this case. */
  private findPlayerPathToNpc(player: Player, npc: Npc): { x: number; z: number }[] {
    const map = this.getPlayerMap(player);
    const ps = player.position;
    if (npc.size <= 1) {
      return map.findPathOnFloor(ps.x, ps.y, npc.position.x, npc.position.y, player.currentFloor);
    }
    const candidates = npc.interactionTiles();
    // Sort in place by Chebyshev to the player so the closest candidate is
    // tried first — for the common case (player already standing next to the
    // mob) this returns after a single findPathOnFloor call.
    candidates.sort((a, b) => {
      const da = Math.max(Math.abs((a.x + 0.5) - ps.x), Math.abs((a.z + 0.5) - ps.y));
      const db = Math.max(Math.abs((b.x + 0.5) - ps.x), Math.abs((b.z + 0.5) - ps.y));
      return da - db;
    });
    for (const t of candidates) {
      if (Math.floor(ps.x) === t.x && Math.floor(ps.y) === t.z) return [];
      const path = map.findPathOnFloor(ps.x, ps.y, t.x + 0.5, t.z + 0.5, player.currentFloor);
      if (path.length > 0) return path;
    }
    return [];
  }

  private setObjectTilesBlocked(mapId: string, x: number, z: number, def: WorldObjectDef, blocked: boolean): void {
    if (!def.blocking || def.category === 'door') return;
    for (const tile of getObjectFootprintTiles(x, z, def)) {
      const key = this.blockedKeyFor(mapId, tile.x, tile.z);
      if (blocked) this.blockedObjectTiles.add(key);
      else this.blockedObjectTiles.delete(key);
    }
  }

  private isTileBlockedForPlayer(player: Player, map: GameMap, tileX: number, tileZ: number): boolean {
    if (player.currentFloor !== 0) return map.isTileBlockedOnFloor(tileX, tileZ, player.currentFloor);
    return map.isBlocked(tileX, tileZ) || this.blockedObjectTiles.has(this.blockedKeyFor(player.currentMapLevel, tileX, tileZ));
  }

  private findPathToObjectInteraction(player: Player, obj: WorldObject): { x: number; z: number }[] {
    const map = this.getPlayerMap(player);
    const allowedWorldSides = obj.interactionSides
      ? localSidesToWorldSides(obj.interactionSides, obj.rotationY, obj.def.width)
      : undefined;
    const candidates = getObjectInteractionTiles(obj.x, obj.z, obj.def, { allowedWorldSides })
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
            (x, z) => map.isBlocked(x, z) || this.blockedObjectTiles.has(this.blockedKeyFor(player.currentMapLevel, x, z)),
            800,
          )
        : map.findPathOnFloor(player.position.x, player.position.y, goalX, goalZ, player.currentFloor);
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
        );
        npc.currentMapLevel = mapId;
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

      // Derive world objects from placed objects in map.json (single source of truth)
      const gameMap = this.maps.get(mapId)!;
      const objectSpawns: { objectId: number; x: number; z: number; rotY?: number }[] = [];
      for (const placed of gameMap.placedObjects ?? []) {
        const defId = ASSET_TO_OBJECT_DEF[placed.assetId];
        if (defId != null) {
          objectSpawns.push({ objectId: defId, x: placed.position.x, z: placed.position.z, rotY: placed.rotation?.y });
        }
      }

      // Fallback: sprite-only objects from spawns.json (fishing spots, altars, etc. without GLBs)
      for (const obj of spawns.objects ?? []) {
        objectSpawns.push(obj);
      }

      for (const spawn of objectSpawns) {
        const objDef = this.data.getObject(spawn.objectId);
        if (!objDef) {
          console.warn(`Unknown object id ${spawn.objectId} in ${mapId}/spawns.json`);
          continue;
        }
        const obj = new WorldObject(objDef, spawn.x, spawn.z, mapId);
        if (spawn.rotY != null) obj.rotationY = spawn.rotY;
        this.worldObjects.set(obj.id, obj);
        this.setObjectTilesBlocked(mapId, spawn.x, spawn.z, objDef, true);
        if (objDef.category === 'door') {
          this.initDoorEdge(obj);
          this.setDoorWallEdges(obj, gameMap);
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
        const groundItem: GroundItem = {
          id: nextGroundItemId++,
          itemId: item.itemId,
          quantity: item.quantity ?? 1,
          x: item.x,
          z: item.z,
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
    this.saveAllPlayers();
  }

  private saveAllPlayers(): void {
    const saves: Array<{ accountId: number; player: Player; effectiveY: number }> = [];
    for (const [, player] of this.players) {
      saves.push({
        accountId: player.accountId,
        player,
        effectiveY: this.computeEffectiveY(player),
      });
    }
    this.db.savePlayersBatch(saves);
  }

  /** Effective walking Y at the player's current (x, z, floor). Server is
   *  now authoritative — both server and client run the same shared
   *  derivation (deriveElevatedFloorTiles), so getEffectiveHeightOnFloor
   *  here returns the same Y the client renders. We pass the player's last
   *  known Y (reportedY for now, will become player.y in Step 2) as the
   *  gate input so roof tiles reveal correctly. */
  private computeEffectiveY(player: Player): number {
    const map = this.getPlayerMap(player);
    return map.getEffectiveHeightOnFloor(
      player.position.x, player.position.y, player.currentFloor,
      player.reportedY,
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

  private checkpointPlayerPosition(player: Player): void {
    this.db.savePlayerPosition(player.accountId, player, this.computeEffectiveY(player));
    player.lastPositionPersistTick = this.currentTick;
  }

  kickAccountIfOnline(accountId: number): void {
    for (const [id, player] of this.players) {
      if (player.accountId === accountId) {
        // Refund any items staged in an active trade BEFORE saving so they
        // come back to inventory and get persisted. removePlayer() also
        // calls abortTrade via clearCombatReferencesTo, but that runs
        // AFTER the save below — without this pre-emptive abort, kicking
        // a player mid-trade silently destroys their offered items on
        // next login. Reaches via /api/logout and second-tab login on the
        // same account.
        if (this.tradeSessions.has(id)) this.abortTrade(id, 2);
        if (player.openInterface === 'trade') this.abortTrade(id, 2);
        if (player.openInterface === 'bank') player.openInterface = null;
        player.openShopNpcId = null;
        player.openDialogueState = null;
        this.finalizePlayerLogoutSession(player);

        // Save BEFORE removing — otherwise a refresh races the WS-close
        // handler, the new session's kick runs first, removePlayer drops
        // the entity, and the close handler's save no-ops because the
        // player is already gone. Result: any state since the last
        // auto-save (60s) is lost — including the latest reportedY.
        this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));
        try {
          player.ws.close(1000, 'Logged in from another session');
        } catch { /* ignore */ }
        this.removePlayer(id);
        break;
      }
    }
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
      player.ip = ws.data.ip ?? player.ip;
      player.deviceId = ws.data.deviceId ?? player.deviceId;
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
      this.broadcastRemoteStance(player);
      this.sendRemoteAnimation(player, player);
      console.log(`Player "${player.name}" reconnected`);
      return player;
    }
    return null;
  }

  addPlayer(player: Player): void {
    this.players.set(player.id, player);
    console.log(`Player "${player.name}" (id=${player.id}) joined on ${player.currentMapLevel}`);

    // Bot-detection telemetry: load lifetime row from DB (or start fresh)
    // and capture XP baseline for this session's rate calc.
    const row = this.db.loadBotStats(player.accountId);
    player.botStats = row ? BotStats.fromRow(row) : BotStats.empty();
    const xpBaseline: Record<string, number> = {};
    for (const skill of ALL_SKILLS) xpBaseline[skill] = player.skills[skill].xp;
    player.botStats.onLogin(xpBaseline);

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
    let spawnY = this.computeEffectiveY(player);
    // Auto-correct: if the saved Y is suspiciously low AND the saved tile
    // has elevation data, snap up to the elevation. Players occasionally
    // walk off the upper floor edge between auto-saves and get persisted
    // at terrain; without this, they'd respawn stuck at the wrong height
    // forever (the height-gate in getEffectiveHeight needs currentY to be
    // high to reveal elevation, creating a feedback loop).
    const map = this.getPlayerMap(player);
    const elevAtTile = map.getElevatedFloorHeight?.(player.position.x, player.position.y);
    if (typeof elevAtTile === 'number' && elevAtTile > 1.0 && spawnY < elevAtTile - 1.0) {
      spawnY = elevAtTile;
      player.reportedY = elevAtTile; // re-anchor so the next save persists the correct value
    }
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

    this.sendToPlayer(player, ServerOpcode.ADMIN_FLAGS, player.isAdmin ? 1 : 0);

    // Send MAP_CHANGE so client loads the correct map (handles underground, dungeons, etc.)
    this.sendMapChange(player, player.currentMapLevel);

    if (player.currentFloor !== 0) {
      this.sendToPlayer(player, ServerOpcode.FLOOR_CHANGE, player.currentFloor);
    }

    if (!player.appearance) {
      this.openCharacterCreatorFor(player);
    }

    // Quest snapshot — sent unconditionally; the client renders an empty
    // log when the record is {}. Subsequent stage advances arrive as
    // QUEST_STAGE_ADVANCED deltas.
    this.quests.sendQuestStateSync(player);
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
  private interruptPlayerAction(playerId: number, player: Player): void {
    player.pendingInteraction = null;
    player.pendingPickup = -1;
    player.actionDelay = 0;
    this.cancelSkilling(playerId);
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
    if (cm) cm.removeEntity(player.id);

    this.players.delete(playerId);
    this.skillingActions.delete(playerId);
    // Defensive sweep: catch any trade sessions whose other side already left.
    this.sweepOrphanTradeSessions();
    console.log(`Player "${player.name}" left`);

    // Notify nearby players
    this.broadcastNearby(player.currentMapLevel, player.position.x, player.position.y, ServerOpcode.ENTITY_DEATH, playerId);
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
    // Trade-during-disconnect dupe guard: if we leave the session live, the
    // partner could still accept and trigger commits against an offline player
    // whose inventory might mutate (e.g. on save round-trip). Abort cleanly.
    if (player.openInterface === 'trade') this.abortTrade(playerId, /*reason*/ 2);
    // Bank just gets closed — its contents are already in player.bank and
    // will be saved by the call below.
    if (player.openInterface === 'bank') player.openInterface = null;
    player.openShopNpcId = null;
    player.openDialogueState = null;
    player.clearMoveQueue();
    player.pendingPickup = -1;
    player.pendingInteraction = null;
    player.delayedUntilTick = 0;
    this.cancelSkilling(playerId);
    this.clearCombatTarget(playerId);
    this.setPlayerAnimation(player, PlayerAnimationKind.Idle, PlayerSkillAnimationVariant.None, 0);
    player.disconnected = true;
    player.reconnectDeadlineTick = this.currentTick + RECONNECT_GRACE_TICKS;
    this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));
    console.log(`Player "${player.name}" disconnected — holding session for reconnect`);
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
    this.finalizePlayerLogoutSession(player);
    this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));
    if (player.isLogoutBlocked(this.currentTick)) {
      player.requestIdleLogout = true;
      player.logoutDeadlineTick = this.currentTick + 50; // ~30s safety cap
      console.log(`Player "${player.name}" logged out under attack — deferring removal`);
      return;
    }

    this.removePlayer(player.id);
  }

  /** Process players whose ws closed during a combat lockout. Once the lockout
   *  expires (or the deadline hits), save and remove. */
  private tickDeferredLogouts(): void {
    let toRemove: number[] | null = null;
    let expiredReconnects: Player[] | null = null;
    for (const [, player] of this.players) {
      if (player.disconnected && !player.requestIdleLogout && this.currentTick >= player.reconnectDeadlineTick) {
        if (!expiredReconnects) expiredReconnects = [];
        expiredReconnects.push(player);
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
      if (player) this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));
      this.removePlayer(id);
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
    map.setWall(tx, tz, map.getWall(tx, tz) | edge);
    const nb = DOOR_EDGE_NEIGHBOR[edge];
    if (nb) {
      const nx = tx + nb.dx, nz = tz + nb.dz;
      if (nx >= 0 && nz >= 0 && nx < map.width && nz < map.height) {
        map.setWall(nx, nz, map.getWall(nx, nz) | nb.opposite);
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
    map.setOpenDoorEdges(tx, tz, edge, true);
    const nb = DOOR_EDGE_NEIGHBOR[edge];
    if (nb) {
      const nx = tx + nb.dx, nz = tz + nb.dz;
      if (nx >= 0 && nz >= 0 && nx < map.width && nz < map.height) {
        map.setOpenDoorEdges(nx, nz, nb.opposite, true);
      }
    }
  }

  /** Close the door: clear openDoorEdges. Wall mask was never disturbed. */
  private restoreDoorWallEdges(obj: WorldObject, map: GameMap): void {
    const [tx, tz] = this.doorTile(obj);
    const edge = this.doorWallEdge(obj);
    map.setOpenDoorEdges(tx, tz, edge, false);
    const nb = DOOR_EDGE_NEIGHBOR[edge];
    if (nb) {
      const nx = tx + nb.dx, nz = tz + nb.dz;
      if (nx >= 0 && nz >= 0 && nx < map.width && nz < map.height) {
        map.setOpenDoorEdges(nx, nz, nb.opposite, false);
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

  private toggleDoor(obj: WorldObject, swingSign: number = 0): void {
    const map = this.maps.get(obj.mapLevel);
    if (!map) return;

    if (obj.doorOpen) {
      this.restoreDoorWallEdges(obj, map);
      obj.doorOpen = false;
      obj.depleted = false;
      this.depletedObjectIds.delete(obj.id);
      swingSign = 0;
      // Closed is the default state — drop the persisted row so a fresh
      // server boot doesn't waste cycles processing a no-op.
      this.db.clearDoorState(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z));
    } else {
      this.clearDoorWallEdges(obj, map);
      obj.doorOpen = true;
      obj.depleted = true;
      obj.respawnTimer = obj.def.respawnTime ?? DEFAULT_OBJECT_RESPAWN_TICKS;
      this.depletedObjectIds.add(obj.id);
      this.db.saveDoorState(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z), true, this.currentTick + obj.respawnTimer);
    }

    this.broadcastNearby(obj.mapLevel, obj.x, obj.z, ServerOpcode.WORLD_OBJECT_DEPLETED, obj.id, obj.depleted ? 1 : 0, swingSign);
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

  private isNearby(player: Player, worldX: number, worldZ: number): boolean {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    return Math.abs(cx - player.currentChunkX) <= CHUNK_LOAD_RADIUS &&
           Math.abs(cz - player.currentChunkZ) <= CHUNK_LOAD_RADIUS;
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

  /** True when any player currently has a dialogue or shop open with this
   *  NPC. Used by tickNpcAI to freeze wandering — without this, walk-anim
   *  movement on the client overrides the NPC_FACING rotation we set on
   *  talk-to, so the NPC visibly looks away mid-conversation. Combat-only
   *  NPCs are excluded by the caller's pre-check on hasDialogue/hasShop. */
  private npcHasInteractionAudience(npc: Npc): boolean {
    for (const [, player] of this.players) {
      if (player.openDialogueState?.npcEntityId === npc.id) return true;
      // openShopNpcId is keyed by def id, not entity id — two NPCs of the
      // same def in the same area would both freeze when one is shopped at,
      // which is acceptable (rare, and the wrong-direction facing risk is
      // worse than the standing-still cost).
      if (player.openShopNpcId === npc.npcId && player.currentMapLevel === npc.currentMapLevel) return true;
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
    this.broadcastNearby(npc.currentMapLevel, npc.position.x, npc.position.y, ServerOpcode.NPC_FACING, npc.id, q);
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

  private setCombatTarget(playerId: number, npcId: number): void {
    this.clearCombatTarget(playerId);
    this.playerCombatTargets.set(playerId, npcId);
    let set = this.npcTargetedBy.get(npcId);
    if (!set) { set = new Set(); this.npcTargetedBy.set(npcId, set); }
    set.add(playerId);
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
      player.pendingInteraction = null;
      player.pendingTalkNpcId = -1;
    }
    for (const [, npc] of this.npcs) {
      if (npc.combatTarget && (npc.combatTarget as any).id === playerId) {
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
    if (this.tradeSessions.has(playerId)) {
      this.abortTrade(playerId, 2);
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

  private blockedKeyFor(mapId: string, x: number, z: number): number {
    return blockedKey(getMapIdx(mapId), Math.floor(x), Math.floor(z));
  }

  /** Check if player is on a tile adjacent to the object (orthogonal only for harvestable). */
  private isAdjacentToObject(player: Player, obj: WorldObject): boolean {
    const ptx = Math.floor(player.position.x);
    const ptz = Math.floor(player.position.y);
    const otx = Math.floor(obj.x);
    const otz = Math.floor(obj.z);
    // Doors: player must be on the door tile or the tile the door faces into
    if (obj.def.category === 'door') {
      return (ptx === otx && ptz === otz) || (Math.abs(ptx - otx) + Math.abs(ptz - otz) === 1);
    }
    const allowedWorldSides = obj.interactionSides
      ? localSidesToWorldSides(obj.interactionSides, obj.rotationY, obj.def.width)
      : undefined;
    return isTileAdjacentToObject(ptx, ptz, obj.x, obj.z, obj.def, { allowedWorldSides });
  }

  handlePlayerMove(playerId: number, path: { x: number; z: number }[]): void {
    const player = this.players.get(playerId);
    if (!player) return;

    this.clearCombatTarget(playerId);
    player.attackTarget = null;
    player.pendingInteraction = null;
    player.pendingSpellCast = null;
    player.pendingTalkNpcId = -1;
    this.cancelSkilling(playerId);
    // Walking auto-closes any open modal interface (bank/trade) — mirrors
    // RS2 behavior where moving aborts the current dialog.
    if (player.isInterfaceOpen()) this.closeOpenInterface(player, /*declineTrade*/ true);
    // Shops aren't a modal interface but they're context-tied to standing at
    // the shopkeeper. Walking away invalidates the scope.
    player.openShopNpcId = null;
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
    const validPath: { x: number; z: number }[] = [];
    let prevX = player.position.x;
    let prevZ = player.position.y;
    const mapId = player.currentMapLevel;
    const pFloor = player.currentFloor;
    // Total unit-tile count the client requested (sum of per-segment max
    // axial distances). Used after the validation loop to detect whether
    // we dropped any tiles relative to what was asked for.
    let requestedTileCount = 0;
    let truncated = false;
    // Per-segment cap: legitimate compressed corners can be far apart on a
    // long straight, but never longer than the map's diagonal. 256 covers
    // any practical map while bounding worst-case work per packet.
    const MAX_SEGMENT_TILES = 256;
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
      let curTileX = startTileX;
      let curTileZ = startTileZ;
      for (let i = 0; i < distance; i++) {
        const nextTileX = curTileX + stepDX;
        const nextTileZ = curTileZ + stepDZ;
        const tileBlocked = pFloor === 0
          ? (map.isBlocked(nextTileX, nextTileZ) || this.blockedObjectTiles.has(this.blockedKeyFor(mapId, nextTileX, nextTileZ)))
          : map.isTileBlockedOnFloor(nextTileX, nextTileZ, pFloor);
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
      this.sendToPlayer(player, ServerOpcode.PATH_TRUNCATED, qPos(last.x), qPos(last.z));
    }
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
    if (npc.currentMapLevel !== player.currentMapLevel) return;

    player.attackTarget = npc;
    this.setCombatTarget(playerId, npcId);

    const dx = npc.position.x - player.position.x;
    const dz = npc.position.y - player.position.y;
    // Face the attacker — 2004scape NPC.faceEntity. The combat loop
    // continues to update this naturally if the player moves, since the
    // hit broadcast carries the attacker's tile.
    this.broadcastNpcFacing(npc, -dx, -dz);
    // Distance to the NPC's nearest footprint tile (size-1 falls through to
    // a plain target-anchor distance) — sized mobs are "in range" when the
    // player is adjacent to their body, not just their SW anchor.
    const fp = npc.distToFootprint(player.position.x, player.position.y);
    const dist = Math.sqrt(fp.dx * fp.dx + fp.dz * fp.dz);
    const isRanged = player.isRangedWeapon(this.data.itemDefs);
    const attackDist = isRanged ? RANGED_ATTACK_DISTANCE : 1.5;

    if (dist > attackDist) {
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
        const path = this.findPlayerPathToNpc(player, npc);
        if (!isRanged) {
          // Size-1: the path ends on the NPC's anchor (blocking) — strip it
          // so a single-step path doesn't queue a walk onto the mob.
          // Sized NPCs: findPlayerPathToNpc already lands adjacent.
          const queue = (npc.size <= 1 && path.length > 0) ? path.slice(0, -1) : path;
          player.setMoveQueue(queue);
        } else {
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
      player.clearMoveQueue();
    }
  }

  handlePlayerTalkNpc(playerId: number, npcEntityId: number): void {
    const player = this.players.get(playerId);
    const npc = this.npcs.get(npcEntityId);
    if (!player || !npc || npc.dead) return;
    if (player.isInterfaceOpen()) return;
    if (npc.currentMapLevel !== player.currentMapLevel) return;

    // Chebyshev (max-of-axes) matches the rest of the interaction surface —
    // pickup, combat, harvest are all Chebyshev. Euclidean here would let a
    // diagonal NPC at (2,2) be talkable (dist 2.83) while the same NPC at
    // (3,0) cardinal would be rejected (dist 3.001) — subtle inconsistency.
    // Sized NPCs measure to nearest footprint tile so a player adjacent to
    // a 2x2 camel's east face still passes the range check.
    const fp = npc.distToFootprint(player.position.x, player.position.y);
    const dx = npc.position.x - player.position.x;
    const dz = npc.position.y - player.position.y;
    // RS2: dialogue requires the player to be adjacent. Out-of-range clicks
    // queue pendingTalkNpcId; the player tick loop fires it once the player
    // walks within NPC_INTERACTION_RANGE.
    if (Math.max(Math.abs(fp.dx), Math.abs(fp.dz)) > NPC_INTERACTION_RANGE) {
      player.pendingTalkNpcId = npcEntityId;
      return;
    }
    player.pendingTalkNpcId = -1;

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
      this.openDialogueAt(player, npc, npc.effectiveDialogue!.root);
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

  /** Push the current dialogue node to the client and update server-side
   *  state. Sends DIALOGUE_OPEN with a JSON-encoded node payload (lines,
   *  speaker, options) so the client doesn't need to know the whole tree. */
  private openDialogueAt(player: Player, npc: Npc, nodeId: string): void {
    const tree = npc.effectiveDialogue;
    if (!tree) return;
    const node = tree.nodes[nodeId];
    if (!node) {
      // Author error — node referenced doesn't exist. Close gracefully so we
      // don't trap the client in a dead conversation.
      this.sendDialogueClose(player);
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
    player.openDialogueState = { npcEntityId: npc.id, nodeId, visibleOptionIndices: visibleIndices };
    const payload = JSON.stringify({
      speaker: wireNode.speaker ?? npc.displayName,
      lines: wireNode.lines,
      options: visibleOptions.map(o => ({ label: o.label })),
    });
    const packet = encodeStringPacket(ServerOpcode.DIALOGUE_OPEN, payload, npc.id);
    try { player.ws.sendBinary(packet); } catch { /* connection closed */ }
  }

  private sendDialogueClose(player: Player): void {
    if (player.openDialogueState === null) return;
    player.openDialogueState = null;
    this.sendToPlayer(player, ServerOpcode.DIALOGUE_CLOSE);
  }

  handleDialogueChoose(playerId: number, npcEntityId: number, optionIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    const state = player.openDialogueState;
    if (!state || state.npcEntityId !== npcEntityId) return;
    const npc = this.npcs.get(npcEntityId);
    if (!npc || npc.dead) { this.sendDialogueClose(player); return; }
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
    // Run the action FIRST so an `openShop` action can replace the dialogue
    // panel with the shop — the order here is the visible UX order.
    if (option.action) {
      this.runDialogueAction(player, npc, option.action);
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
        this.sendDialogueClose(player);
        if (npc.hasShop) this.openShopFor(player, npc);
        return;
      case 'openBank':
        this.sendDialogueClose(player);
        if (npc.hasBank) this.openBankFor(player);
        return;
      case 'openAppearance':
        this.sendDialogueClose(player);
        this.openCharacterCreatorFor(player);
        return;
      case 'giveItem': {
        // Best-effort: silently no-op if inventory is full. Authors can chain a
        // "you don't have room" branch with a hasInventoryRoom check in future.
        if (action.itemId > 0 && action.qty > 0) {
          const result = player.addItem(action.itemId, action.qty, this.data.itemDefs);
          if (result.completed > 0) this.sendInventory(player);
        }
        return;
      }
      case 'takeItem': {
        if (action.itemId > 0 && action.qty > 0) {
          let remaining = action.qty;
          let mutated = false;
          for (let i = 0; i < player.inventory.length && remaining > 0; i++) {
            const slot = player.inventory[i];
            if (!slot || slot.itemId !== action.itemId) continue;
            const removed = player.removeItem(i, remaining);
            remaining -= removed.completed;
            if (removed.completed > 0) mutated = true;
          }
          if (mutated) this.sendInventory(player);
        }
        return;
      }
      case 'setQuestStage':
        this.quests.setPlayerQuestStage(player, action.questId, action.stage);
        return;
      case 'completeQuest':
        this.quests.completePlayerQuest(player, action.questId);
        return;
    }
  }

  /** Predicate for the `requires` gate on a single dialogue option. Used by
   *  openDialogueAt to build the visible-options snapshot. Per-option (not
   *  per-list) so the caller can also record the original index. */
  private dialogueOptionVisible(player: Player, opt: import('@projectrs/shared').DialogueOption): boolean {
    return this.quests.dialogueOptionVisible(player, opt);
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

    this.interruptPlayerAction(playerId, player);
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

    this.interruptPlayerAction(playerId, player);
    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
  }

  handlePlayerPickup(playerId: number, groundItemId: number): void {
    const player = this.players.get(playerId);
    const item = this.groundItems.get(groundItemId);
    if (!player || !item) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.isInterfaceOpen()) return;
    if (item.mapLevel !== player.currentMapLevel) return;

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

    if (player.addItem(item.itemId, item.quantity, this.data.itemDefs).completed > 0) {
      this.interruptPlayerAction(playerId, player);
      this.groundItems.delete(groundItemId);
      this.despawningItemIds.delete(groundItemId);
      const itemCm = this.chunkManagers.get(item.mapLevel);
      if (itemCm) itemCm.removeEntity(groundItemId);
      // Map-wide broadcast: a viewer who saw the drop, walked OOR, and stays
      // away when someone else grabs it would otherwise keep the stale sprite.
      const packet = encodePacket(ServerOpcode.GROUND_ITEM_SYNC, groundItemId, 0, 0, 0, 0);
      for (const [, p] of this.players) {
        if (p.currentMapLevel !== item.mapLevel) continue;
        try { p.ws.sendBinary(packet); } catch { /* connection closed */ }
      }
      this.sendInventory(player);
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

    const removed = player.removeItem(slotIndex, slot.quantity);
    if (removed.completed === 0) return;
    this.interruptPlayerAction(playerId, player);

    const groundItem: GroundItem = {
      id: nextGroundItemId++,
      itemId: removed.itemId,
      quantity: removed.completed,
      x: player.position.x,
      z: player.position.y,
      mapLevel: player.currentMapLevel,
      despawnTimer: GROUND_ITEM_DESPAWN_TICKS,
    };
    this.groundItems.set(groundItem.id, groundItem);
    this.despawningItemIds.add(groundItem.id);
    const dropCm = this.chunkManagers.get(groundItem.mapLevel);
    if (dropCm) dropCm.addEntity(groundItem.id, groundItem.x, groundItem.z);

    this.forEachPlayerNear(groundItem.mapLevel, groundItem.x, groundItem.z, p => this.sendGroundItemUpdate(p, groundItem));
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

  handlePlayerInteractObject(playerId: number, objectEntityId: number, actionIndex: number, recipeIndex: number = -1): void {
    const player = this.players.get(playerId);
    const obj = this.worldObjects.get(objectEntityId);
    if (!player || !obj) return;
    if (obj.mapLevel !== player.currentMapLevel) return;
    // Doors can be interacted with when open (to close) — other objects can't when depleted
    if (obj.depleted && obj.def.category !== 'door') {
      // Chests give explicit feedback so the player knows the click was
      // received but the chest is still on cooldown; trees/rocks etc. stay
      // silent (their depleted variant is visually obvious).
      if (obj.def.category === 'chest') {
        this.sendChatSystem(player, `The ${obj.def.name.toLowerCase()} hasn't been restocked yet.`);
      }
      return;
    }

    if (player.isBusy(this.currentTick)) {
      const isQueuedObjectAction = obj.def.category === 'door' || obj.def.category === 'ladder' || (obj.def.harvestItemId && (obj.def.skill || obj.def.category === 'crop'));
      if (isQueuedObjectAction) {
        player.pendingInteraction = { objectEntityId, actionIndex, swingSign: 0 };
      }
      return;
    }
    // While a modal interface (bank/trade) is open, refuse object interactions
    // outright — no door deferral. Closing the interface is a deliberate user
    // action; we won't queue clicks behind it.
    if (player.isInterfaceOpen()) return;

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
          player.pendingInteraction = { objectEntityId, actionIndex, swingSign };
        }
        // Empty path = unreachable (closed door is the only gap in the wall
        // and player is on the wrong side, OR maxSteps exhausted). Drop the
        // click — there is no useful action we can queue for them.
        return;
      }
      // Anvil-style stations (recipes requiring a held tool) demand strict
      // adjacency. The client walks the player to the anvil before opening
      // the recipe picker; auto-walking on a craft packet here would let a
      // stale/open SmithingPanel craft from anywhere. Harvest/door stay on
      // the walk-then-act path.
      if (obj.def.recipes?.[0]?.requiresTool) {
        this.sendChatSystem(player, `I need to stand next to the ${obj.def.name.toLowerCase()}.`);
        return;
      }
      const path = this.findPathToObjectInteraction(player, obj);
      if (!player.hasMoveQueue() && path.length > 0) {
        player.setMoveQueue(path);
      }
      if (player.hasMoveQueue()) {
        player.pendingInteraction = { objectEntityId, actionIndex };
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

    if (action === 'Examine') {
      // Just send a chat message
      this.sendToPlayer(player, ServerOpcode.CHAT_SYSTEM, 0); // Will use chat socket instead
      return;
    }

    if (action === 'Enter') {
      this.handleTeleportInteraction(player, obj);
      return;
    }

    if (obj.def.category === 'ladder' && (action === 'Climb-up' || action === 'Climb-down')) {
      this.handleLadderInteraction(player, obj, action);
      return;
    }

    if (obj.def.category === 'door' && (action === 'Open' || action === 'Close')) {
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

    if (obj.def.recipes && obj.def.recipes.length > 0) {
      this.handleCraftingInteraction(playerId, player, obj, recipeIndex);
      return;
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
    player.currentFloor = 0;
    player.lastFloorChangeTile = -1;
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
  ): { up?: { x: number; z: number; y: number }; down?: { x: number; z: number; y: number } } {
    const map = this.getPlayerMap(player);
    const playerY = Math.max(player.effectiveY, player.reportedY);
    const allowedWorldSides = obj.interactionSides
      ? localSidesToWorldSides(obj.interactionSides, obj.rotationY, obj.def.width)
      : undefined;
    const positions = [
      { x: Math.floor(obj.x) + 0.5, z: Math.floor(obj.z) + 0.5 },
      ...getObjectInteractionTiles(obj.x, obj.z, obj.def, { allowedWorldSides })
        .map(tile => ({ x: tile.x + 0.5, z: tile.z + 0.5 })),
    ];
    const candidates: { x: number; z: number; y: number }[] = [];
    const add = (candidate: { x: number; z: number; y: number }): void => {
      if (!Number.isFinite(candidate.y)) return;
      if (!candidates.some(existing =>
        Math.abs(existing.x - candidate.x) < 0.01
        && Math.abs(existing.z - candidate.z) < 0.01
        && Math.abs(existing.y - candidate.y) < 0.1)) {
        candidates.push(candidate);
      }
    };

    for (const pos of positions) {
      for (const y of map.getWalkableHeightsAt(pos.x, pos.z)) {
        add({ ...pos, y });
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
        this.quests.notifyQuestEvent(player, { type: 'itemPickup', itemId, quantity: added });
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

  handlePlayerEquip(playerId: number, slotIndex: number, expectedItemId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.isInterfaceOpen()) return;
    if (player.inventory[slotIndex]?.itemId !== expectedItemId) return;

    const slot = player.inventory[slotIndex];
    if (!slot) return;

    const itemDef = this.data.getItem(slot.itemId);
    if (!itemDef || !itemDef.equippable || !itemDef.equipSlot) return;

    const equipSlot = itemDef.equipSlot as EquipSlot;
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
    if (obj.mapLevel !== player.currentMapLevel) return;
    if (!this.isAdjacentToObject(player, obj)) {
      this.sendChatSystem(player, "I can't reach that.");
      return;
    }
    this.interruptPlayerAction(playerId, player);
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
    if (npc.currentMapLevel !== player.currentMapLevel) return;
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
    player.setDelay(this.currentTick, 1);
    // Self-echo lets the client correct its optimistic UI if anything ever
    // diverges; broadcast to neighbours so they pick the right swing anim.
    this.sendRemoteStance(player, player);
    this.broadcastRemoteStance(player);
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
  handlePlayerCastSpell(playerId: number, spellIndex: number, targetEntityId: number): void {
    const player = this.players.get(playerId);
    if (!player || !player.alive) return;
    if (player.isBusy(this.currentTick)) return;
    if (player.attackCooldown > 0) {
      if (this.playerCombatTargets.has(playerId)) {
        player.pendingSpellCast = { spellIndex, targetEntityId };
        this.clearCombatTarget(playerId);
      }
      return;
    }

    const def = this.data.getSpellByIndex(spellIndex);
    if (!def) return;

    const npc = this.npcs.get(targetEntityId);
    if (!npc || npc.dead) return;
    if (this.data.getShop(npc.npcId)) return;                 // shopkeepers immune
    if (npc.currentMapLevel !== player.currentMapLevel) return;

    const fp = npc.distToFootprint(player.position.x, player.position.y);
    const dist = Math.sqrt(fp.dx * fp.dx + fp.dz * fp.dz);
    if (dist > SPELL_CAST_DISTANCE) return;

    this.cancelSkilling(playerId);
    this.clearCombatTarget(playerId);                          // cancel auto-attack

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
    const defRoll = (npc.def.defence + 8) * ACC_BASE;
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
    player.setDelay(this.currentTick, castTicks + 1);
    player.attackCooldown = 7;
    player.markInCombat(this.currentTick);

    this.broadcastNearby(
      player.currentMapLevel, player.position.x, player.position.y,
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
    });
  }

  handleSetAppearance(playerId: number, appearance: PlayerAppearance): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (!isValidAppearance(appearance)) return;

    player.appearance = appearance;
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

  /** Server-side entry point: open the character creator for a player. Called
   *  from the login path (no appearance set yet), the openAppearance dialogue
   *  action, and the /appearance admin chat command. */
  openCharacterCreatorFor(player: Player): void {
    this.sendToPlayer(player, ServerOpcode.SHOW_CHARACTER_CREATOR, 0);
  }

  /** Server-side entry point: open the bank for a player. Called from the
   *  banker NPC interaction path AND from the /bank admin chat command. */
  openBankFor(player: Player): void {
    if (player.isInterfaceOpen()) return;
    player.openInterface = 'bank';
    this.sendBankFull(player);
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
    const beforeQty = slot.quantity;
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

  /** Distance within which a trade request is allowed. Both players must remain
   *  in this range; anyone walking out aborts the trade. */
  private static readonly TRADE_REQUEST_RANGE = 4;

  handleTradeRequest(playerId: number, targetEntityId: number): void {
    const player = this.players.get(playerId);
    const target = this.players.get(targetEntityId);
    if (!player || !target || player.id === target.id) return;
    if (player.isInterfaceOpen() || target.isInterfaceOpen()) return;
    if (player.currentMapLevel !== target.currentMapLevel) return;
    // Floor check is required even with same x,z map check — multi-floor
    // buildings let two players overlap in 2D while being on different planes,
    // and a through-floor trade lets gear teleport up/down a building.
    if (player.currentFloor !== target.currentFloor) return;
    if (this.tileChebyshev(player, target) > World.TRADE_REQUEST_RANGE) return;

    // If the target has already requested us, opening from either side commits
    // the session (same-tick mutual request).
    const reverse = this.pendingTradeRequests.get(target.id);
    if (reverse === player.id) {
      this.pendingTradeRequests.delete(target.id);
      this.openTradeSession(player, target);
      return;
    }
    this.pendingTradeRequests.set(player.id, target.id);
    // 5-tick (~3s) request lifetime so stale requests don't pile up.
    setTimeout(() => {
      if (this.pendingTradeRequests.get(player.id) === target.id) {
        this.pendingTradeRequests.delete(player.id);
      }
    }, 3000);
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
    if (player.isInterfaceOpen() || requester.isInterfaceOpen()) return;
    if (this.pendingTradeRequests.get(requester.id) !== player.id) return;
    if (player.currentMapLevel !== requester.currentMapLevel) return;
    if (player.currentFloor !== requester.currentFloor) return;
    if (this.tileChebyshev(player, requester) > World.TRADE_REQUEST_RANGE) return;
    this.pendingTradeRequests.delete(requester.id);
    this.openTradeSession(requester, player);
  }

  private openTradeSession(a: Player, b: Player): void {
    const session: TradeSession = {
      a: { id: a.id, offer: new Array(28).fill(null), stage: 0 },
      b: { id: b.id, offer: new Array(28).fill(null), stage: 0 },
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
    this.pendingTradeRequests.delete(playerId);
    this.abortTrade(playerId, /*reason*/ 1);
  }

  /** Abort a trade session. Items in offers go back to the owner's inventory.
   *  reason: 0=success, 1=declined, 2=aborted (disconnect/move). */
  abortTrade(playerId: number, reason: number = 2): void {
    const session = this.tradeSessions.get(playerId);
    if (!session) return;
    this.tradeSessions.delete(session.a.id);
    this.tradeSessions.delete(session.b.id);

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
    const me = this.mySide(session, playerId);
    if (!me) return;
    // No mutating offers after stage 1 — re-enter editing mode by removing/adding.
    if (me.stage > 0) return;
    if (slotIndex < 0 || slotIndex >= player.inventory.length) return;
    const invSlot = player.inventory[slotIndex];
    if (!invSlot || invSlot.itemId !== expectedItemId) return;

    const itemId = invSlot.itemId;
    const itemDef = this.data.getItem(itemId);
    if (!itemDef) return;
    const isStackable = itemDef.stackable === true;

    const wantAll = quantity === -1;
    let toOffer: number;
    if (isStackable) {
      toOffer = wantAll ? invSlot.quantity : Math.min(quantity, invSlot.quantity);
    } else {
      let total = 0;
      for (const s of player.inventory) if (s?.itemId === itemId) total += 1;
      toOffer = wantAll ? total : Math.min(quantity, total);
    }
    if (toOffer <= 0) return;

    // Find or create an offer slot for this item (collapsed by itemId — same
    // model as bank slots).
    let offerSlot = me.offer.findIndex(o => o?.itemId === itemId);
    if (offerSlot < 0) offerSlot = me.offer.findIndex(o => o === null);
    if (offerSlot < 0) {
      this.sendChatSystem(player, 'Trade offer is full.');
      return;
    }

    if (isStackable) {
      const removed = player.removeItem(slotIndex, toOffer);
      if (removed.completed !== toOffer) { player.revertRemove(removed); return; }
    } else {
      let remaining = toOffer;
      for (let i = 0; i < player.inventory.length && remaining > 0; i++) {
        const s = player.inventory[i];
        if (!s || s.itemId !== itemId) continue;
        const r = player.removeItem(i, 1);
        if (r.completed !== 1) return;
        remaining--;
      }
    }

    const existing = me.offer[offerSlot];
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
    const me = this.mySide(session, playerId);
    if (!me) return;
    if (me.stage > 0) return;
    if (offerSlot < 0 || offerSlot >= me.offer.length) return;
    const off = me.offer[offerSlot];
    if (!off || off.itemId !== expectedItemId) return;

    const wantAll = quantity === -1;
    const toReturn = wantAll ? off.quantity : Math.min(quantity, off.quantity);
    if (toReturn <= 0) return;

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
    const me = this.mySide(session, playerId);
    const them = this.otherSide(session, playerId);
    if (!me || !them) return;
    if (me.stage >= 2) return;
    me.stage = (me.stage + 1) as 1 | 2;
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
    const aPlayer = this.players.get(session.a.id);
    const bPlayer = this.players.get(session.b.id);
    if (!aPlayer || !bPlayer) {
      this.abortTrade(session.a.id, 2);
      return;
    }

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
    const MAX_STACK = 0x7FFFFFFF;
    // Simulate sequentially using a clone of free-slot count. Cheap because
    // canFit only inspects existing items + free count.
    const used: Map<number, number> = new Map();
    let freeSlots = 0;
    for (const s of player.inventory) if (s === null) freeSlots++;
    for (const off of offer) {
      if (!off) continue;
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

  /** Close whichever modal interface is open. For trade, decline (with item
   *  return). For bank, just clear the flag and notify. */
  private closeOpenInterface(player: Player, declineTrade: boolean): void {
    if (player.openInterface === 'bank') {
      player.openInterface = null;
      this.sendToPlayer(player, ServerOpcode.BANK_CLOSE, 0);
    } else if (player.openInterface === 'trade' && declineTrade) {
      this.abortTrade(player.id, 2);
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
    const groundItem: GroundItem = {
      id: nextGroundItemId++,
      itemId,
      quantity,
      x: player.position.x,
      z: player.position.y,
      mapLevel: player.currentMapLevel,
      despawnTimer,
    };
    this.groundItems.set(groundItem.id, groundItem);
    this.despawningItemIds.add(groundItem.id);
    const cm = this.chunkManagers.get(player.currentMapLevel);
    if (cm) cm.addEntity(groundItem.id, groundItem.x, groundItem.z);
    // Broadcast to nearby players so the dropped item appears immediately
    // (without this, clients only see it after re-entering the chunk).
    this.forEachPlayerNear(groundItem.mapLevel, groundItem.x, groundItem.z, p =>
      this.sendGroundItemUpdate(p, groundItem));
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

    this.tickPlayerMovement();
    this.tickNpcAI();
    this.tickPlayerCooldowns();
    this.tickQueuedSpellCasts();
    this.tickPlayerCombat();
    this.tickNpcCombat();
    this.tickPendingSpells();
    if (this.currentTick % 10 === 0) this.tickHealthRegen();
    this.tickSkillingActions();
    this.tickObjectRespawns();
    this.tickItemDespawns();
    this.tickTransitions();
    this.tickDeferredLogouts();
    this.broadcastSync();

    // Bot-stats checkpoint every 500 ticks (~5 min). Flushes each connected
    // player's accumulated stats to SQLite without emitting a session_summary
    // — that only fires on logout. Survives mid-session server crashes.
    if (this.currentTick - this.lastBotStatsCheckpointTick >= 500) {
      this.lastBotStatsCheckpointTick = this.currentTick;
      for (const [, player] of this.players) {
        if (player.disconnected) continue;
        player.botStats?.checkpoint(this.db, player.accountId);
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
          this.sendToPlayer(player, ServerOpcode.PATH_TRUNCATED, qPos(player.position.x), qPos(player.position.y));
          player.clearMoveQueue();
          player.pendingInteraction = null;
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
        const { objectEntityId, actionIndex, swingSign } = player.pendingInteraction;
        const obj = this.worldObjects.get(objectEntityId);
        // Doors fire instantly on arrival — toggling is visually
        // self-evident (the door swings) and the client already
        // interpolates the character's arrival visually. Other
        // interactions (skilling, crafting) keep the !justArrived guard so
        // animations don't register while the character is mid-step.
        const isDoorInteraction = obj?.def.category === 'door';
        if (!isDoorInteraction && justArrived) continue;
        player.pendingInteraction = null;
        if (obj && obj.mapLevel === player.currentMapLevel) {
          if (this.isAdjacentToObject(player, obj)) {
            player.clearMoveQueue();
            player.attackTarget = null;
            this.clearCombatTarget(playerId);
            const action = obj.currentActions[actionIndex];
            if (action && obj.def.category === 'door' && (action === 'Open' || action === 'Close')) {
              this.toggleDoor(obj, swingSign ?? 0);
            } else if (action) {
              this.handlePlayerInteractObject(playerId, objectEntityId, actionIndex);
            }
          }
        }
      }
      // Deferred Talk-to fires once the walk has drained. Mid-walk firing
      // would open the dialogue while the character is still striding;
      // waiting matches RS2. If the path drained without reaching range
      // (blocked, NPC wandered), drop the intent — user re-clicks.
      if (player.pendingTalkNpcId >= 0 && !player.hasMoveQueue()) {
        const id = player.pendingTalkNpcId;
        player.pendingTalkNpcId = -1;
        const targetNpc = this.npcs.get(id);
        const inRange = targetNpc && !targetNpc.dead
          && targetNpc.currentMapLevel === player.currentMapLevel
          && Math.max(Math.abs(targetNpc.position.x - player.position.x), Math.abs(targetNpc.position.y - player.position.y)) <= NPC_INTERACTION_RANGE;
        if (inRange) this.handlePlayerTalkNpc(playerId, id);
      }
    }
  }

  private tickNpcAI(): void {
    for (const [, npc] of this.npcs) {
      if (npc.dead) {
        if (npc.tickRespawn()) {
          this.forEachPlayerNear(npc.currentMapLevel, npc.position.x, npc.position.y, p => {
            this.sendNpcStaticData(p, npc);
            this.sendNpcUpdate(p, npc);
          });
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
        // For size-1 NPCs the callbacks reduce to the original single-tile
        // checks. For larger NPCs the wrappers test every footprint tile
        // against terrain (map.isNpcBlocked) AND world-object blockers, and
        // require the move's leading wall edges to be open. Both wrappers
        // are allocation-free in the hot path (no footprint array per call).
        const npcBlocked = size <= 1
          ? (x: number, z: number) =>
              map.isBlocked(x, z) || this.blockedObjectTiles.has(this.blockedKeyFor(mapId, x, z))
          : (x: number, z: number) => {
              if (map.isNpcBlocked(x, z, size)) return true;
              const minX = Math.floor(x) - Math.floor((size - 1) / 2);
              const minZ = Math.floor(z) - Math.floor((size - 1) / 2);
              for (let i = 0; i < size; i++) {
                for (let j = 0; j < size; j++) {
                  if (this.blockedObjectTiles.has(this.blockedKeyFor(mapId, minX + i, minZ + j))) return true;
                }
              }
              return false;
            };
        const npcWallBlocked = size <= 1
          ? map.isWallBlockedCb
          : (fx: number, fz: number, tx: number, tz: number) => map.isNpcWallBlocked(fx, fz, tx, tz, size);
        const npcFindPath = (sx: number, sz: number, gx: number, gz: number) =>
          map.findPathForNpc(sx, sz, gx, gz, npcBlocked, 100, npcWallBlocked);
        npc.processAI(npcBlocked, npcWallBlocked, npcFindPath);
      }
      if (hadCombatTarget && npc.combatTarget == null) {
        this.broadcastNearby(npc.currentMapLevel, npc.position.x, npc.position.y,
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
      if (!player || !npc || npc.dead || npc.currentMapLevel !== player.currentMapLevel) {
        this.clearCombatTarget(playerId);
        continue;
      }

      const map = this.getPlayerMap(player);

      const isRanged = player.isRangedWeapon(itemDefs);
      const attackDist = isRanged ? RANGED_ATTACK_DISTANCE : 1.5;
      const cfp = npc.distToFootprint(player.position.x, player.position.y);
      const combatDist = Math.sqrt(cfp.dx * cfp.dx + cfp.dz * cfp.dz);
      if (combatDist > attackDist) {
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
              // Size-1: strip the trailing anchor tile so the player stops
              // adjacent. Sized NPCs: findPlayerPathToNpc already lands
              // adjacent, so the queue is used as-is.
              const queue = (npc.size <= 1 && path.length > 1) ? path.slice(0, -1) : path;
              player.setMoveQueue(queue);
            } else {
              // Ranged: walk only as far as needed to be in attack distance.
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
            this.broadcastProjectile(player.id, npc.id, 1, player.currentMapLevel, player.position.x, player.position.y);
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
        this.broadcastPlayerAnimationEvent(player, PlayerAnimationKind.Attack, PlayerSkillAnimationVariant.None, npc.id, true);
        // Arm post-combat logout block — player can't safely log off mid-fight.
        player.markInCombat(this.currentTick);
        player.botStats?.recordCombatSwing(this.currentTickStartMs, performance.now());
        this.broadcastCombatHit(result.hit.attackerId, result.hit.targetId, result.hit.damage, result.hit.targetHealth, result.hit.targetMaxHealth, player.currentMapLevel, npc.position.x, npc.position.y);

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

          this.broadcastNearby(npc.currentMapLevel, npc.position.x, npc.position.y, ServerOpcode.ENTITY_DEATH, npc.id);

          const loot = rollLoot(npc);
          // Drop where the NPC actually died, not at its spawn tile —
          // aggressive mobs that chase players multiple tiles before dying
          // were dumping loot back at the spawn point, far from the player.
          // Historical naming: position.y is world Z.
          const deathX = npc.position.x;
          const deathZ = npc.position.y;
          for (const drop of loot) {
            const groundItem: GroundItem = {
              id: nextGroundItemId++,
              itemId: drop.itemId,
              quantity: drop.quantity,
              x: deathX,
              z: deathZ,
              mapLevel: npc.currentMapLevel,
              despawnTimer: GROUND_ITEM_DESPAWN_TICKS,
            };
            this.groundItems.set(groundItem.id, groundItem);
            this.despawningItemIds.add(groundItem.id);
            const lootCm = this.chunkManagers.get(groundItem.mapLevel);
            if (lootCm) lootCm.addEntity(groundItem.id, groundItem.x, groundItem.z);
            this.forEachPlayerNear(groundItem.mapLevel, groundItem.x, groundItem.z, p => this.sendGroundItemUpdate(p, groundItem));
          }
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
      if (npc.currentMapLevel !== imp.mapLevel) continue;

      const actual = npc.takeDamage(imp.damage);

      if (npc.alive) {
        const wasInCombat = npc.combatTarget != null;
        npc.combatTarget = player;
        if (!wasInCombat) {
          npc.attackCooldown = Math.floor(npc.def.attackSpeed / 2);
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

      this.broadcastCombatHit(player.id, npc.id, actual, npc.health, npc.maxHealth, npc.currentMapLevel, npc.position.x, npc.position.y);

      if (!npc.alive) {
        npc.die();
        this.clearCombatTarget(imp.attackerId);
        this.broadcastNearby(npc.currentMapLevel, npc.position.x, npc.position.y, ServerOpcode.ENTITY_DEATH, npc.id);

        const loot = rollLoot(npc);
        const deathX = npc.position.x;
        const deathZ = npc.position.y;
        for (const drop of loot) {
          const groundItem: GroundItem = {
            id: nextGroundItemId++,
            itemId: drop.itemId,
            quantity: drop.quantity,
            x: deathX,
            z: deathZ,
            mapLevel: npc.currentMapLevel,
            despawnTimer: GROUND_ITEM_DESPAWN_TICKS,
          };
          this.groundItems.set(groundItem.id, groundItem);
          this.despawningItemIds.add(groundItem.id);
          const lootCm = this.chunkManagers.get(groundItem.mapLevel);
          if (lootCm) lootCm.addEntity(groundItem.id, groundItem.x, groundItem.z);
          this.forEachPlayerNear(groundItem.mapLevel, groundItem.x, groundItem.z, p => this.sendGroundItemUpdate(p, groundItem));
        }
      }
    }
    this.pendingSpellImpacts = remaining;
  }

  private tickNpcCombat(): void {
    const itemDefs = this.data.itemDefs;

    for (const [, npc] of this.npcs) {
      if (npc.dead || !npc.combatTarget) continue;
      const target = npc.combatTarget as Player;
      if (!target.alive || !this.players.has(target.id) || target.currentMapLevel !== npc.currentMapLevel) {
        npc.combatTarget = null;
        continue;
      }

      const hit = processNpcCombat(npc, target, itemDefs);
      if (hit) {
        // Player took (or dodged) a hit — arm post-combat logout block.
        target.markInCombat(this.currentTick);
        this.broadcastCombatHit(hit.attackerId, hit.targetId, hit.damage, hit.targetHealth, hit.targetMaxHealth, npc.currentMapLevel, target.position.x, target.position.y);

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
      if (!obj || obj.depleted || obj.mapLevel !== player.currentMapLevel) {
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
          this.quests.notifyQuestEvent(player, { type: 'itemPickup', itemId, quantity: primary.added });
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
              this.quests.notifyQuestEvent(player, { type: 'itemPickup', itemId: drop.itemId, quantity: got.completed });
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
      if (!p || p.currentMapLevel !== obj.mapLevel) return;
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
      // Doors: keep the respawn timer pinned at full while any player is
      // in the doorway. The countdown only runs once everyone has left, so
      // the auto-close never slams shut on top of someone walking through.
      // The base timer is generous (200 ticks ≈ 2 min) — doors are meant
      // to stay open for a while after use.
      if (obj.def.category === 'door' && obj.doorOpen && this.isAnyPlayerNearDoor(obj)) {
        obj.respawnTimer = obj.def.respawnTime ?? DEFAULT_OBJECT_RESPAWN_TICKS;
        continue;
      }
      if (obj.tickRespawn()) {
        this.depletedObjectIds.delete(objId);
        // Doors: never re-block the tile on respawn — only the wall edge
        // matters. Mirrors the spawn paths above which exclude doors from
        // blockedObjectTiles. Without this, the door tile becomes pathing-
        // blocked after the first auto-close and silently breaks every
        // subsequent click.
        this.setObjectTilesBlocked(obj.mapLevel, obj.x, obj.z, obj.def, true);
        if (obj.def.category === 'door') {
          const map = this.maps.get(obj.mapLevel);
          if (map) this.restoreDoorWallEdges(obj, map);
          obj.doorOpen = false;
          this.db.clearDoorState(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z));
        } else {
          // Skilling object respawned — drop the persisted target.
          this.db.clearObjectRespawn(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z));
        }
        // Pass swingSign=0 to match the toggle path's packet shape — auto-
        // close doesn't need a direction (the close animation ignores it).
        this.broadcastNearby(obj.mapLevel, obj.x, obj.z, ServerOpcode.WORLD_OBJECT_DEPLETED, obj.id, 0, 0);
      }
    }
  }

  private tickItemDespawns(): void {
    for (const id of this.despawningItemIds) {
      const item = this.groundItems.get(id);
      if (!item) { this.despawningItemIds.delete(id); continue; }
      item.despawnTimer--;
      if (item.despawnTimer <= 0) {
        this.despawningItemIds.delete(id);
        this.groundItems.delete(id);
        const despawnCm = this.chunkManagers.get(item.mapLevel);
        if (despawnCm) despawnCm.removeEntity(id);
        // Despawns must reach EVERY player on the map, not just nearby ones.
        // A player who saw the drop and then walked OOR keeps a stale local
        // sprite if the despawn is filtered by chunk proximity. Cost is
        // negligible — items despawn at ~200-tick intervals.
        const packet = encodePacket(ServerOpcode.GROUND_ITEM_SYNC, id, 0, 0, 0, 0);
        for (const [, p] of this.players) {
          if (p.currentMapLevel !== item.mapLevel) continue;
          try { p.ws.sendBinary(packet); } catch { /* connection closed */ }
        }
      }
    }
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

      if (player.currentFloor !== oldFloor) {
        // The floor index just changed — re-resolve the walking elevation
        // against the new floor's layer before the next move validates.
        this.refreshPlayerEffectiveY(player);
        this.sendToPlayer(player, ServerOpcode.FLOOR_CHANGE, player.currentFloor);
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

    // Tell observers the player died at their current tile. Mirrors the
    // NPC death broadcast — clients use this to clear the remote entity.
    this.broadcastNearby(oldMapId, oldX, oldZ, ServerOpcode.ENTITY_DEATH, player.id);

    // Abort any modal interface BEFORE position changes. Trade abort returns
    // items to both sides; bank close just clears the flag (contents are
    // already safe in player.bank).
    if (player.isInterfaceOpen()) this.closeOpenInterface(player, /*declineTrade*/ true);

    // Drop all transient combat / action state.
    this.clearCombatTarget(player.id);
    this.cancelSkilling(player.id);
    player.clearMoveQueue();
    player.attackTarget = null;
    player.pendingInteraction = null;
    player.pendingSpellCast = null;
    player.pendingTalkNpcId = -1;
    player.pendingPickup = -1;
    player.attackCooldown = 0;
    player.delayedUntilTick = 0;
    player.logoutBlockedUntilTick = 0;
    player.actionDelay = 0;
    player.openShopNpcId = null;
    player.openDialogueState = null;

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
      const groundItem: GroundItem = {
        id: nextGroundItemId++,
        itemId: d.itemId,
        quantity: d.quantity,
        x: oldX,
        z: oldZ,
        mapLevel: oldMapId,
        despawnTimer: DEATH_DROP_DESPAWN_TICKS,
      };
      this.groundItems.set(groundItem.id, groundItem);
      this.despawningItemIds.add(groundItem.id);
      const cm = this.chunkManagers.get(oldMapId);
      if (cm) cm.addEntity(groundItem.id, groundItem.x, groundItem.z);
      this.forEachPlayerNear(oldMapId, oldX, oldZ, p => this.sendGroundItemUpdate(p, groundItem));
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
    this.teleportPlayer(player, spawn.x, spawn.z);

    // Push the restored HP + skill panel + cleared inventory/equipment to
    // the player. teleportPlayer sends PLAYER_TELEPORT (position) but not
    // stats. The client otherwise wouldn't know its inventory just lost
    // most of its contents.
    this.sendToPlayer(player, ServerOpcode.PLAYER_STATS, player.health, player.maxHealth);
    this.sendSkills(player);
    this.sendInventory(player);
    this.sendEquipment(player);
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
  teleportPlayer(player: Player, x: number, z: number, forcedY?: number): void {
    const mapId = player.currentMapLevel;
    console.log(`[TP] teleportPlayer: ${player.name} on map="${mapId}" to (${x.toFixed(1)}, ${z.toFixed(1)})`);
    const cm = this.chunkManagers.get(mapId);
    if (cm) cm.removeEntity(player.id);
    player.position.x = x;
    player.position.y = z;
    player.clearMoveQueue();
    player.attackTarget = null;
    this.clearCombatTarget(player.id);
    player.currentChunkX = Math.floor(x / CHUNK_SIZE);
    player.currentChunkZ = Math.floor(z / CHUNK_SIZE);
    if (cm) cm.addEntity(player.id, x, z);
    // Compute server-authoritative Y at the destination + apply the same
    // login auto-correct (snap up to elevated floor when the gate would
    // otherwise return terrain). Reset reportedY so the next save persists
    // the new height.
    const map = this.getPlayerMap(player);
    let teleportY = forcedY;
    if (teleportY == null) {
      teleportY = map.getEffectiveHeightOnFloor(x, z, player.currentFloor, player.reportedY);
      const elevAtTile = map.getElevatedFloorHeight(x, z);
      if (typeof elevAtTile === 'number' && elevAtTile > 1.0 && teleportY < elevAtTile - 1.0) {
        teleportY = elevAtTile;
      }
    }
    player.reportedY = teleportY;
    player.effectiveY = teleportY;
    const packet = encodePacket(
      ServerOpcode.PLAYER_TELEPORT,
      qPos(x),
      qPos(z),
      qPos(teleportY),
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
    const tx = transition.targetX;
    const tz = transition.targetZ;
    const txValid = typeof tx === 'number' && isFinite(tx) && tx >= 0 && tx < targetMapObj.width;
    const tzValid = typeof tz === 'number' && isFinite(tz) && tz >= 0 && tz < targetMapObj.height;
    if (!txValid || !tzValid) {
      const fallback = targetMapObj.findSpawnPoint();
      console.warn(`[handleMapTransition] invalid target (${tx},${tz}) on ${newMap}; using spawn (${fallback.x},${fallback.z})`);
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
    player.openDialogueState = null;

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
    // Re-derive the authoritative collision elevation for the new map — the
    // old map's effectiveY is meaningless here. Transition destinations are
    // editor-authored ground spawn tiles, so an ungated resolve is correct;
    // the per-tile refresh self-heals once the player walks.
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

    // Send nearby entities on new map using chunk manager (all entity types registered)
    if (newCm) {
      const nearbyIds = newCm.getEntitiesNear(player.position.x, player.position.y);
      for (const eid of nearbyIds) {
        if (eid === player.id) continue;
        const other = this.players.get(eid);
        if (other) {
          this.sendPlayerUpdate(player, other);
          this.sendPlayerUpdate(other, player);
          continue;
        }
        const npc = this.npcs.get(eid);
        if (npc && !npc.dead) {
          this.sendNpcStaticData(player, npc);
          this.sendNpcUpdate(player, npc);
          continue;
        }
        const obj = this.worldObjects.get(eid);
        if (obj) { this.sendWorldObjectUpdate(player, obj); continue; }
        const item = this.groundItems.get(eid);
        if (item) { this.sendGroundItemUpdate(player, item); continue; }
      }
    }

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
        ));
      }
    }

    // Phase 2: Viewer-first iteration — all sends to each viewer are consecutive
    for (const [, viewer] of this.players) {
      if (viewer.disconnected) continue;
      const cm = this.chunkManagers.get(viewer.currentMapLevel);
      if (!cm) continue;

      try {
        const nextVisible = new Set<number>();
        cm.forEachEntityNearChunk(viewer.currentChunkX, viewer.currentChunkZ, (eid) => {
          if (eid !== viewer.id) nextVisible.add(eid);
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
          if (subject) {
            this.sendPlayerUpdate(viewer, subject);
            // Equipment isn't part of PLAYER_SYNC (it'd bloat every position
            // tick), so push it as a separate packet on chunk entry. Matches
            // what we do for world-object state — full sync on chunk change.
            this.sendRemoteEquipment(viewer, subject);
            this.sendRemoteStance(viewer, subject);
            this.sendRemoteAnimation(viewer, subject);
            return;
          }
          const npc = this.npcs.get(eid);
          if (npc && !npc.dead) {
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
          if (obj) { this.sendWorldObjectUpdate(viewer, obj); return; }
          // Re-sync ground items too — a player who saw a drop, walked OOR,
          // and walked back would otherwise keep the stale local sprite for
          // an item the server has already despawned (or vice versa).
          const item = this.groundItems.get(eid);
          if (item && item.mapLevel === viewer.currentMapLevel) {
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

  private broadcastCombatHit(attackerId: number, targetId: number, damage: number, targetHp: number, targetMaxHp: number, mapLevel: string, worldX: number, worldZ: number): void {
    this.broadcastNearby(mapLevel, worldX, worldZ, ServerOpcode.COMBAT_HIT, attackerId, targetId, damage, targetHp, targetMaxHp);
  }

  private broadcastProjectile(attackerId: number, targetId: number, projectileType: number, mapLevel: string, worldX: number, worldZ: number): void {
    this.broadcastNearby(mapLevel, worldX, worldZ, ServerOpcode.COMBAT_PROJECTILE, attackerId, targetId, projectileType);
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
    );
  }

  private sendNpcUpdate(viewer: Player, npc: Npc): void {
    this.sendToPlayer(viewer, ServerOpcode.NPC_SYNC,
      npc.id,
      npc.npcId,
      qPos(npc.position.x),
      qPos(npc.position.y),
      npc.health,
      npc.maxHealth
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
  }

  private sendWorldObjectUpdate(viewer: Player, obj: WorldObject): void {
    // [objectEntityId, objectDefId, x*10, z*10, depleted(0/1)]
    this.sendToPlayer(viewer, ServerOpcode.WORLD_OBJECT_SYNC,
      obj.id,
      obj.defId,
      qPos(obj.x),
      qPos(obj.z),
      obj.depleted ? 1 : 0
    );
  }

  private sendGroundItemUpdate(viewer: Player, item: GroundItem): void {
    this.sendToPlayer(viewer, ServerOpcode.GROUND_ITEM_SYNC,
      item.id,
      item.itemId,
      item.quantity,
      qPos(item.x),
      qPos(item.z)
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
      if (!viewer || viewer.disconnected || viewer.currentMapLevel !== subject.currentMapLevel) return;
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
      if (!viewer || viewer.disconnected || viewer.currentMapLevel !== subject.currentMapLevel) return;
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
      if (!viewer || viewer.disconnected || viewer.currentMapLevel !== subject.currentMapLevel) return;
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
    obj.deplete();
    this.depletedObjectIds.add(obj.id);
    this.db.saveObjectRespawn(obj.mapLevel, obj.defId, Math.floor(obj.x), Math.floor(obj.z), Date.now() + obj.respawnTimer * TICK_RATE);
    this.broadcastNearby(obj.mapLevel, obj.x, obj.z, ServerOpcode.WORLD_OBJECT_DEPLETED, obj.id, 1);
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

  /** Convenience: get the default ('kcmap') map. Used by legacy callers
   *  that pre-date the multi-map system. */
  get map(): GameMap {
    return this.getMap('kcmap');
  }
}
