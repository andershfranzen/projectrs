import { TICK_RATE, CHUNK_SIZE, CHUNK_LOAD_RADIUS, MAX_STACK, PROTOCOL_VERSION, ServerOpcode, ALL_SKILLS, ASSET_TO_OBJECT_DEF, WallEdge, doorEdgeFromPlacement, doorClosedEdgeFromRotY, DOOR_EDGE_NEIGHBOR, type SkillId, type ItemDef, type PlayerAppearance, isValidAppearance } from '@projectrs/shared';
import { audit } from './Audit';
import { BotStats } from './BotStats';
import { encodePacket, encodeStringPacket } from '@projectrs/shared';
import { addXp, levelFromXp, statRandom, npcCombatLevel } from '@projectrs/shared';
import { GameMap } from './GameMap';
import { Player, type EquipSlot } from './entity/Player';
import { Npc } from './entity/Npc';
import { WorldObject } from './entity/WorldObject';
import { DataLoader } from './data/DataLoader';
import { GameDatabase } from './Database';
import { processPlayerCombat, processPlayerRangedCombat, processNpcCombat, rollLoot, RANGED_ATTACK_DISTANCE } from './combat/Combat';
import { broadcastPlayerInfo, sendSystemMessageToUser } from './network/ChatSocket';
import { ServerChunkManager } from './ChunkManager';
import { readdirSync } from 'fs';

/** Map string IDs to small integers for blockedObjectTiles encoding */
const mapIdRegistry: Map<string, number> = new Map();
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

export class World {
  readonly maps: Map<string, GameMap> = new Map();
  readonly chunkManagers: Map<string, ServerChunkManager> = new Map();
  readonly data: DataLoader;
  readonly db: GameDatabase;
  readonly players: Map<number, Player> = new Map();

  /** True if there's an active session from `deviceId` belonging to a
   *  DIFFERENT account than `excludeAccountId`. Used by /api/login to enforce
   *  the one-account-per-browser rule. Per-browser, not per-IP — friends
   *  sharing a household / dorm / cafe each have their own localStorage. */
  hasOtherActiveAccountFromDevice(deviceId: string, excludeAccountId: number): boolean {
    if (!deviceId) return false;
    for (const [, p] of this.players) {
      if (p.deviceId === deviceId && p.accountId !== excludeAccountId) return true;
    }
    return false;
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

  // Skilling: player -> { objectId, action, cycleTime, toolItemId }
  // cycleTime = inter-roll period in ticks (computed once at interaction start).
  // Per-player roll tick lives on Player.actionDelay (RS2 %action_delay varp).
  private skillingActions: Map<number, { objectId: number; action: string; cycleTime: number; toolItemId?: number }> = new Map();

  /** RS2 mining rates by pickaxe item id (inter-roll period in game ticks).
   *  Lower = faster. Per LostCityRS `pickaxes.obj`. */
  private static readonly MINING_RATES: Record<number, number> = {
    33: 7,  // Bronze
    53: 6,  // Iron
    54: 5,  // Steel
    55: 4,  // Mithril
    57: 3,  // Runite (RS2 adamant slot)
    56: 2,  // Black Bronze (highest tier in this game, RS2 rune slot)
  };
  private static readonly DEFAULT_MINING_RATE = 7;

  constructor(db: GameDatabase) {
    this.db = db;
    this.data = new DataLoader();

    // Auto-discover maps from server/data/maps/
    this.discoverAndLoadMaps();

    // Spawn NPCs and objects from data files
    this.spawnNpcs();
    this.spawnWorldObjects();
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
        this.blockedObjectTiles.delete(this.blockedKeyFor(mapId, obj.x, obj.z));
        this.worldObjects.delete(id);
      }
    }

    // Re-spawn NPCs and world objects
    const spawns = this.data.loadSpawns(mapId);
    for (const spawn of spawns.npcs ?? []) {
      const npcDef = this.data.getNpc(spawn.npcId);
      if (!npcDef) continue;
      const npc = new Npc(npcDef, spawn.x, spawn.z, spawn.wanderRange, spawn.appearance ?? null, spawn.equipment ?? null, spawn.aggressive ?? null);
      npc.currentMapLevel = mapId;
      this.npcs.set(npc.id, npc);
      cm.addEntity(npc.id, spawn.x, spawn.z);
    }
    // Derive world objects from placed objects in map.json (single source of truth)
    const objectSpawns: { objectId: number; x: number; z: number; rotY?: number; trigger?: any }[] = [];
    for (const placed of gameMap.placedObjects) {
      const defId = ASSET_TO_OBJECT_DEF[placed.assetId];
      if (defId != null) {
        objectSpawns.push({ objectId: defId, x: placed.position.x, z: placed.position.z, rotY: placed.rotation?.y, trigger: placed.trigger });
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
      this.worldObjects.set(obj.id, obj);
      if (objDef.blocking && objDef.category !== 'door') {
        if (objDef.category === 'tree') {
          const bx = Math.floor(spawn.x);
          const bz = Math.floor(spawn.z);
          for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
            this.blockedObjectTiles.add(this.blockedKeyFor(mapId, bx + dx, bz + dz));
          }
        } else {
          this.blockedObjectTiles.add(this.blockedKeyFor(mapId, spawn.x, spawn.z));
        }
      }
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
    if (!player) return;
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

  private spawnNpcs(): void {
    for (const [mapId, gameMap] of this.maps) {
      const spawns = this.data.loadSpawns(mapId);
      for (const spawn of spawns.npcs) {
        const npcDef = this.data.getNpc(spawn.npcId);
        if (!npcDef) {
          console.warn(`Unknown NPC id ${spawn.npcId} in ${mapId}/spawns.json`);
          continue;
        }
        const npc = new Npc(
          npcDef,
          spawn.x,
          spawn.z,
          spawn.wanderRange,
          spawn.appearance ?? null,
          spawn.equipment ?? null,
          spawn.aggressive ?? null,
        );
        npc.currentMapLevel = mapId;
        this.npcs.set(npc.id, npc);

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
        if (objDef.blocking && objDef.category !== 'door') {
          if (objDef.category === 'tree') {
            const bx = Math.floor(spawn.x);
            const bz = Math.floor(spawn.z);
            for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
              this.blockedObjectTiles.add(this.blockedKeyFor(mapId, bx + dx, bz + dz));
            }
          } else {
            this.blockedObjectTiles.add(this.blockedKeyFor(mapId, spawn.x, spawn.z));
          }
        }
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
    for (const [, player] of this.players) {
      this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));
    }
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

  kickAccountIfOnline(accountId: number): void {
    for (const [id, player] of this.players) {
      if (player.accountId === accountId) {
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
    // LOGIN_OK layout: [playerId, x*10, z*10, spawnY*10, protocolVersion].
    // Version added at the end so older client builds (which read only the
    // first 4 values) still parse without error — they just don't see the
    // mismatch warning. New clients read v[4] and disconnect on mismatch.
    this.sendToPlayer(player, ServerOpcode.LOGIN_OK, player.id,
      Math.round(player.position.x * 10),
      Math.round(player.position.y * 10),
      Math.round(spawnY * 10),
      PROTOCOL_VERSION,
    );

    // Send MAP_CHANGE so client loads the correct map (handles underground, dungeons, etc.)
    this.sendMapChange(player, player.currentMapLevel);

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

  private cancelSkilling(playerId: number): void {
    if (this.skillingActions.has(playerId)) {
      this.skillingActions.delete(playerId);
      const player = this.players.get(playerId);
      if (player) {
        this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
      }
    }
  }

  removePlayer(playerId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;

    // Remove from chunk manager
    const cm = this.chunkManagers.get(player.currentMapLevel);
    if (cm) cm.removeEntity(player.id);

    this.players.delete(playerId);
    this.clearCombatTarget(playerId);
    this.skillingActions.delete(playerId);
    console.log(`Player "${player.name}" left`);

    // Notify nearby players
    this.broadcastNearby(player.currentMapLevel, player.position.x, player.position.y, ServerOpcode.ENTITY_DEATH, playerId);
  }

  /** Called from the WS close handler. If the player is in a post-combat
   *  logout block, the Player entity is left in the world (still attackable)
   *  until the block expires or a hard 30s deadline passes. Otherwise the
   *  player is saved + removed immediately. */
  handlePlayerDisconnect(playerId: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    // Trade-during-disconnect dupe guard: if we leave the session live, the
    // partner could still accept and trigger commits against an offline player
    // whose inventory might mutate (e.g. on save round-trip). Abort cleanly.
    if (player.openInterface === 'trade') this.abortTrade(playerId, /*reason*/ 2);
    // Bank just gets closed — its contents are already in player.bank and
    // will be saved by the call below.
    if (player.openInterface === 'bank') player.openInterface = null;
    player.openShopNpcId = null;

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

    this.db.savePlayerState(player.accountId, player, this.computeEffectiveY(player));

    if (player.isLogoutBlocked(this.currentTick)) {
      player.requestIdleLogout = true;
      player.logoutDeadlineTick = this.currentTick + 50; // ~30s safety cap
      console.log(`Player "${player.name}" logged out under attack — deferring removal`);
      return;
    }

    this.removePlayer(playerId);
  }

  /** Process players whose ws closed during a combat lockout. Once the lockout
   *  expires (or the deadline hits), save and remove. */
  private tickDeferredLogouts(): void {
    let toRemove: number[] | null = null;
    for (const [, player] of this.players) {
      if (!player.requestIdleLogout) continue;
      const expired = !player.isLogoutBlocked(this.currentTick) || this.currentTick >= player.logoutDeadlineTick;
      if (expired) {
        if (!toRemove) toRemove = [];
        toRemove.push(player.id);
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
    } else {
      this.clearDoorWallEdges(obj, map);
      obj.doorOpen = true;
      obj.depleted = true;
      obj.respawnTimer = obj.def.respawnTime ?? 200;
      this.depletedObjectIds.add(obj.id);
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
      if (p) {
        try { p.ws.sendBinary(packet); } catch { /* connection closed */ }
      }
    });
  }

  /** Call fn for each player near a world position on a given map (zero-allocation) */
  private forEachPlayerNear(mapId: string, worldX: number, worldZ: number, fn: (p: Player) => void): void {
    const cm = this.chunkManagers.get(mapId);
    if (!cm) return;
    cm.forEachPlayerNear(worldX, worldZ, (pid) => {
      const p = this.players.get(pid);
      if (p) fn(p);
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

  private blockedKeyFor(mapId: string, x: number, z: number): number {
    return blockedKey(getMapIdx(mapId), Math.floor(x), Math.floor(z));
  }

  /** Check if player is on a tile adjacent to the object (orthogonal only for harvestable). */
  private isAdjacentToObject(player: Player, obj: { x: number; z: number; def: { category?: string; blocking?: boolean } }): boolean {
    const ptx = Math.floor(player.position.x);
    const ptz = Math.floor(player.position.y);
    const otx = Math.floor(obj.x);
    const otz = Math.floor(obj.z);
    // Trees use a 2x2 footprint
    const tiles = obj.def.category === 'tree'
      ? [[-1,-1],[0,-1],[-1,0],[0,0]].map(([dx,dz]) => [otx+dx, otz+dz])
      : [[otx, otz]];
    // Doors: player must be on the door tile or the tile the door faces into
    if (obj.def.category === 'door') {
      return (ptx === otx && ptz === otz) || (Math.abs(ptx - otx) + Math.abs(ptz - otz) === 1);
    }
    const isHarvestable = obj.def.category === 'rock' || obj.def.category === 'tree';
    return tiles.some(([tx, tz]) => {
      const ddx = Math.abs(ptx - tx);
      const ddz = Math.abs(ptz - tz);
      if (ddx === 0 && ddz === 0) return false;
      if (isHarvestable) return (ddx === 0 && ddz === 1) || (ddx === 1 && ddz === 0);
      return ddx <= 1 && ddz <= 1;
    });
  }

  handlePlayerMove(playerId: number, path: { x: number; z: number }[]): void {
    const player = this.players.get(playerId);
    if (!player) return;

    this.clearCombatTarget(playerId);
    player.attackTarget = null;
    player.pendingInteraction = null;
    this.cancelSkilling(playerId);
    // Walking auto-closes any open modal interface (bank/trade) — mirrors
    // RS2 behavior where moving aborts the current dialog.
    if (player.isInterfaceOpen()) this.closeOpenInterface(player, /*declineTrade*/ true);
    // Shops aren't a modal interface but they're context-tied to standing at
    // the shopkeeper. Walking away invalidates the scope.
    player.openShopNpcId = null;

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
      if (distance > MAX_SEGMENT_TILES) break;
      // Diagonal compressed steps must move equally on both axes — reject
      // anything that isn't pure cardinal or pure 45° diagonal.
      const isDiagonal = stepDX !== 0 && stepDZ !== 0;
      if (isDiagonal && Math.abs(dxTotal) !== Math.abs(dzTotal)) break;
      let curTileX = startTileX;
      let curTileZ = startTileZ;
      for (let i = 0; i < distance; i++) {
        const nextTileX = curTileX + stepDX;
        const nextTileZ = curTileZ + stepDZ;
        const tileBlocked = pFloor === 0
          ? (map.isBlocked(nextTileX, nextTileZ) || this.blockedObjectTiles.has(this.blockedKeyFor(mapId, nextTileX, nextTileZ)))
          : map.isTileBlockedOnFloor(nextTileX, nextTileZ, pFloor);
        const playerEffY = map.getEffectiveHeightOnFloor(curTileX + 0.5, curTileZ + 0.5, pFloor);
        const wallBlocked = pFloor === 0
          ? map.isWallBlocked(curTileX, curTileZ, nextTileX, nextTileZ, playerEffY)
          : map.isWallBlockedOnFloor(curTileX, curTileZ, nextTileX, nextTileZ, pFloor);
        if (tileBlocked || wallBlocked) break outer;
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
    player.moveQueue = validPath;
  }

  handlePlayerAttackNpc(playerId: number, npcId: number): void {
    const player = this.players.get(playerId);
    const npc = this.npcs.get(npcId);
    if (!player || !npc || npc.dead) return;
    if (player.isInterfaceOpen()) return;
    // Prevent attacking shopkeepers
    if (this.data.getShop(npc.npcId)) return;
    this.cancelSkilling(playerId);
    if (npc.currentMapLevel !== player.currentMapLevel) return;

    player.attackTarget = npc;
    this.setCombatTarget(playerId, npcId);

    const dx = npc.position.x - player.position.x;
    const dz = npc.position.y - player.position.y;
    const dist = Math.sqrt(dx * dx + dz * dz);
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
      if (player.moveQueue.length === 0) {
        const map = this.getPlayerMap(player);
        const path = map.findPathOnFloor(player.position.x, player.position.y, npc.position.x, npc.position.y, player.currentFloor);
        if (!isRanged) {
          // Melee: walk to adjacent. The path's last entry is the NPC's tile
          // (blocking) — strip it regardless of path length so a single-step
          // path doesn't queue a walk onto the mob.
          player.moveQueue = path.length > 0 ? path.slice(0, -1) : [];
        } else {
          // Ranged: walk until within range, then stop.
          let cutIdx = path.length;
          for (let i = 0; i < path.length; i++) {
            const pdx = Math.abs(path[i].x - npc.position.x);
            const pdz = Math.abs(path[i].z - npc.position.y);
            if (pdx <= attackDist && pdz <= attackDist) {
              cutIdx = i + 1;
              break;
            }
          }
          player.moveQueue = path.slice(0, cutIdx);
        }
      }
    } else {
      player.moveQueue = [];
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
    const dx = npc.position.x - player.position.x;
    const dz = npc.position.y - player.position.y;
    if (Math.max(Math.abs(dx), Math.abs(dz)) > 3) return;

    // Bankers take precedence — a single NpcDef with bankAccess shouldn't also
    // have a shop, but if one ever does, banking is the safer default action.
    if (npc.def.bankAccess) {
      this.openBankFor(player);
      return;
    }

    const shop = this.data.getShop(npc.npcId);
    if (!shop) return;

    // Track which shop is open so buy/sell can scope item validation. Cleared
    // on movement, map transition, death, disconnect — keeps the player from
    // trading across shops without walking between them.
    player.openShopNpcId = npc.npcId;

    // Send SHOP_OPEN: [npcEntityId, itemCount, itemId1, price1, stock1, itemId2, price2, stock2, ...]
    const values: number[] = [npcEntityId, shop.items.length];
    for (const si of shop.items) {
      values.push(si.itemId, si.price, si.stock);
    }
    this.sendToPlayer(player, ServerOpcode.SHOP_OPEN, ...values);
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
      const map = this.getPlayerMap(player);
      const path = map.findPathOnFloor(player.position.x, player.position.y, item.x, item.z, player.currentFloor);
      if (path.length > 0) {
        player.moveQueue = path;
        player.pendingPickup = groundItemId;
      }
      return;
    }

    if (player.addItem(item.itemId, item.quantity, this.data.itemDefs).completed > 0) {
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

    const removed = player.removeItem(slotIndex);
    if (removed.completed === 0) return;

    const groundItem: GroundItem = {
      id: nextGroundItemId++,
      itemId: removed.itemId,
      quantity: removed.completed,
      x: player.position.x,
      z: player.position.y,
      mapLevel: player.currentMapLevel,
      despawnTimer: 200,
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
    if (obj.depleted && obj.def.category !== 'door') return;

    // Doors: defer one tick instead of silently dropping when busy. Other
    // interactions (skilling, crafting) keep the early-return because they
    // rely on the action firing immediately.
    if (player.isBusy(this.currentTick)) {
      if (obj.def.category === 'door') {
        player.pendingInteraction = { objectEntityId, actionIndex, swingSign: 0 };
      }
      return;
    }
    // While a modal interface (bank/trade) is open, refuse object interactions
    // outright — no door deferral. Closing the interface is a deliberate user
    // action; we won't queue clicks behind it.
    if (player.isInterfaceOpen()) return;

    // Doors: cancel current movement so adjacency check uses where the player actually stopped
    if (obj.def.category === 'door') {
      player.moveQueue = [];
      player.pendingInteraction = null;
    }

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

        if (path.length > 0) {
          player.moveQueue = path;
          player.pendingInteraction = { objectEntityId, actionIndex, swingSign };
        }
        // Empty path = unreachable (closed door is the only gap in the wall
        // and player is on the wrong side, OR maxSteps exhausted). Drop the
        // click — there is no useful action we can queue for them.
        return;
      } else {
        player.pendingInteraction = { objectEntityId, actionIndex };
        return;
      }
    }

    // Stop movement
    player.moveQueue = [];
    player.attackTarget = null;
    this.clearCombatTarget(playerId);

    const action = obj.currentActions[actionIndex];
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

    if (obj.def.category === 'door' && (action === 'Open' || action === 'Close')) {
      this.toggleDoor(obj, this.computeSwingSign(player, obj));
      return;
    }

    if (obj.def.skill && obj.def.harvestItemId) {
      this.handleHarvestInteraction(playerId, player, obj, action);
      return;
    }

    if (obj.def.recipes && obj.def.recipes.length > 0) {
      this.handleCraftingInteraction(player, obj, recipeIndex);
      return;
    }
  }

  private handleTeleportInteraction(player: Player, obj: WorldObject): void {
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

  private handleHarvestInteraction(playerId: number, player: Player, obj: WorldObject, action: string): void {
    const skillId = obj.def.skill as SkillId;
    const playerLevel = player.skills[skillId]?.level ?? 1;
    if (playerLevel < (obj.def.levelRequired ?? 1)) return;

    const requiredTool = obj.def.category === 'tree' ? 'axe' : obj.def.category === 'rock' ? 'pickaxe' : null;
    let toolItemId: number | undefined;
    let toolBonus = 0;
    if (requiredTool) {
      const bestTool = this.findBestTool(player, requiredTool, playerLevel);
      if (!bestTool) return;
      toolItemId = bestTool.id;
      toolBonus = bestTool.toolBonus ?? 0;
    }

    // Cycle time: per-pickaxe rate for rocks (RS2 model), per-rock harvestTime
    // minus tool bonus for everything else.
    let cycleTime: number;
    if (obj.def.category === 'rock') {
      cycleTime = (toolItemId != null ? World.MINING_RATES[toolItemId] : undefined) ?? World.DEFAULT_MINING_RATE;
    } else {
      const baseTime = obj.def.harvestTime ?? 4;
      cycleTime = Math.max(2, baseTime - toolBonus);
    }

    this.skillingActions.set(playerId, {
      objectId: obj.id,
      action,
      cycleTime,
      toolItemId,
    });
    this.sendToPlayer(player, ServerOpcode.SKILLING_START, obj.id);
  }

  private handleCraftingInteraction(player: Player, obj: WorldObject, recipeIndex: number): void {
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

      let inputSlot = -1;
      for (let i = 0; i < player.inventory.length; i++) {
        const slot = player.inventory[i];
        if (slot && slot.itemId === recipe.inputItemId && slot.quantity >= recipe.inputQuantity) {
          inputSlot = i;
          break;
        }
      }
      if (inputSlot < 0) continue;

      let secondInputSlot = -1;
      if (recipe.secondInputItemId !== undefined) {
        const needed = recipe.secondInputQuantity ?? 1;
        for (let i = 0; i < player.inventory.length; i++) {
          if (i === inputSlot) continue;
          const slot = player.inventory[i];
          if (slot && slot.itemId === recipe.secondInputItemId && slot.quantity >= needed) {
            secondInputSlot = i;
            break;
          }
        }
        if (secondInputSlot < 0) continue;
      }

      // Transaction: remove inputs, then add output. If add fails (inventory
      // full), revert the input removals so materials aren't silently destroyed.
      const inputRemoval = player.removeItem(inputSlot, recipe.inputQuantity);
      if (inputRemoval.completed < recipe.inputQuantity) {
        player.revertRemove(inputRemoval);
        continue;
      }

      let secondRemoval: ReturnType<typeof player.removeItem> | null = null;
      if (secondInputSlot >= 0 && recipe.secondInputQuantity) {
        secondRemoval = player.removeItem(secondInputSlot, recipe.secondInputQuantity);
        if (secondRemoval.completed < recipe.secondInputQuantity) {
          player.revertRemove(secondRemoval);
          player.revertRemove(inputRemoval);
          continue;
        }
      }

      if (recipe.successChance !== undefined && Math.random() > recipe.successChance) {
        // Recipe rolled fail — inputs are consumed, no output. Matches RS2 behavior.
        this.sendInventory(player);
        return;
      }

      const addResult = player.addItem(recipe.outputItemId, recipe.outputQuantity, this.data.itemDefs);
      if (addResult.completed === 0) {
        if (secondRemoval) player.revertRemove(secondRemoval);
        player.revertRemove(inputRemoval);
        this.sendInventory(player);
        return;
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
      return;
    }
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

    const slotNames: EquipSlot[] = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];
    const slotName = slotNames[equipSlotIndex];
    if (!slotName) return;

    const itemId = player.equipment.get(slotName);
    if (itemId === undefined) return;

    if (player.addItem(itemId, 1, this.data.itemDefs).completed > 0) {
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

    if (player.health >= player.maxHealth) return;

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

  handlePlayerSetStance(playerId: number, stanceIndex: number): void {
    const player = this.players.get(playerId);
    if (!player) return;
    // Gate through busy + a 1-tick lockout so a scripted client can't flip
    // stance to maximize XP/damage on the same tick a swing lands.
    if (player.isBusy(this.currentTick)) return;
    if (player.isInterfaceOpen()) return;

    const stances = ['accurate', 'aggressive', 'defensive', 'controlled'] as const;
    if (stanceIndex >= 0 && stanceIndex < stances.length) {
      player.stance = stances[stanceIndex];
      player.setDelay(this.currentTick, 1);
      // Tell nearby clients so they render the correct attack animation
      // (e.g. 2H + aggressive → smash) when this player swings.
      this.broadcastRemoteStance(player);
    }
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

  /** Spawn a ground item under a player (used when refunds can't fit). */
  private spawnGroundItem(player: Player, itemId: number, quantity: number): void {
    const groundItem: GroundItem = {
      id: nextGroundItemId++,
      itemId,
      quantity,
      x: player.position.x,
      z: player.position.y,
      mapLevel: player.currentMapLevel,
      despawnTimer: 100,
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
    this.tickPlayerCombat();
    this.tickNpcCombat();
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
      if (player.moveQueue.length > 0) {
        const next = player.moveQueue[0];
        const map = this.getPlayerMap(player);
        const pFloor = player.currentFloor;
        // Pass effective height so a wall edge below an elevated walkable
        // tile doesn't spuriously truncate the queue. Mirrors the elevation
        // gating used during path validation in handlePlayerMove.
        const playerEffY = map.getEffectiveHeightOnFloor(player.position.x, player.position.y, pFloor);
        const wallBlocked = pFloor === 0
          ? map.isWallBlocked(player.position.x, player.position.y, next.x, next.z, playerEffY)
          : map.isWallBlockedOnFloor(player.position.x, player.position.y, next.x, next.z, pFloor);
        if (wallBlocked) {
          player.moveQueue = [];
          player.pendingInteraction = null;
        }
      }
      player.processMovement(this.currentTick);
      this.updateEntityChunk(player);

      // Defer adjacency-triggered actions one tick if the player just consumed
      // a waypoint this tick — server's authoritative tile updates instantly
      // when a step finishes, but the client interpolates the visual character
      // smoothly, so firing immediately makes interactions register while the
      // character is still visually mid-step (looks like you're chopping a tree
      // a tile away from where you're standing). Holding the action for the
      // next tick (~600ms) lets the client catch up.
      const justArrived = player.lastMovedTick === this.currentTick && player.moveQueue.length === 0;

      // Bot-detection: record the final destination tile when a movement
      // completes (path drained). Bots concentrate visits to a few tiles
      // (e.g. rock → bank → rock loop) — the top-destination ratio jumps
      // above 0.5 for a fishing bot within ~50 movements.
      if (justArrived) {
        player.botStats?.recordMovement(player.position.x, player.position.y);
      }

      if (player.pendingPickup >= 0 && player.moveQueue.length === 0 && !justArrived) {
        const pickupId = player.pendingPickup;
        player.pendingPickup = -1;
        this.handlePlayerPickup(playerId, pickupId);
      }
      if (player.pendingInteraction && player.moveQueue.length === 0) {
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
            player.moveQueue = [];
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
            const dx = Math.abs(npc.position.x - player.position.x);
            const dz = Math.abs(npc.position.y - player.position.y);
            if (dx <= 3 && dz <= 3) {
              npc.combatTarget = player;
            }
          });
        }
      }

      const mapId = npc.currentMapLevel;
      const npcBlocked = (x: number, z: number) =>
        map.isBlocked(x, z) || this.blockedObjectTiles.has(this.blockedKeyFor(mapId, x, z));
      const npcFindPath = (sx: number, sz: number, gx: number, gz: number) =>
        map.findPathForNpc(sx, sz, gx, gz, npcBlocked);
      npc.processAI(npcBlocked, map.isWallBlockedCb, npcFindPath);

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
      const cdx = npc.position.x - player.position.x;
      const cdz = npc.position.y - player.position.y;
      const combatDist = Math.sqrt(cdx * cdx + cdz * cdz);
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
        if (player.moveQueue.length === 0) {
          const path = map.findPathOnFloor(player.position.x, player.position.y, npc.position.x, npc.position.y, player.currentFloor);
          if (path.length > 0) {
            if (!isRanged && path.length > 1) {
              player.moveQueue = path.slice(0, -1); // melee: stop one tile short
            } else if (isRanged) {
              // Ranged: walk only as far as needed to be in attack distance
              let cutIdx = path.length;
              for (let i = 0; i < path.length; i++) {
                const pdx = Math.abs(path[i].x - npc.position.x);
                const pdz = Math.abs(path[i].z - npc.position.y);
                if (pdx <= attackDist && pdz <= attackDist) {
                  cutIdx = i + 1;
                  break;
                }
              }
              player.moveQueue = path.slice(0, cutIdx);
            } else {
              player.moveQueue = path;
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

          this.broadcastNearby(npc.currentMapLevel, npc.position.x, npc.position.y, ServerOpcode.ENTITY_DEATH, npc.id);

          const loot = rollLoot(npc);
          for (const drop of loot) {
            const groundItem: GroundItem = {
              id: nextGroundItemId++,
              itemId: drop.itemId,
              quantity: drop.quantity,
              x: npc.spawnX,
              z: npc.spawnZ,
              mapLevel: npc.currentMapLevel,
              despawnTimer: 200,
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
        this.skillingActions.delete(playerId);
        this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
        continue;
      }

      if (!this.isAdjacentToObject(player, obj)) {
        this.skillingActions.delete(playerId);
        this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
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
            this.skillingActions.delete(playerId);
            this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
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

        const addedToInv = player.addItem(itemId, qty, this.data.itemDefs).completed > 0;
        if (!addedToInv && obj.def.category === 'rock') {
          const groundItem: GroundItem = {
            id: nextGroundItemId++,
            itemId,
            quantity: qty,
            x: player.position.x,
            z: player.position.y,
            mapLevel: player.currentMapLevel,
            despawnTimer: 200,
          };
          this.groundItems.set(groundItem.id, groundItem);
          this.despawningItemIds.add(groundItem.id);
          const dropCm = this.chunkManagers.get(groundItem.mapLevel);
          if (dropCm) dropCm.addEntity(groundItem.id, groundItem.x, groundItem.z);
          this.forEachPlayerNear(groundItem.mapLevel, groundItem.x, groundItem.z, p => this.sendGroundItemUpdate(p, groundItem));
        } else if (!addedToInv) {
          this.skillingActions.delete(playerId);
          this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
          continue;
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

        if (addedToInv) this.sendInventory(player);
        const harvestSkillIdx = ALL_SKILLS.indexOf(skillId);
        if (harvestSkillIdx >= 0) this.sendSingleSkill(player, harvestSkillIdx);

        if (obj.def.depletionChance && Math.random() < obj.def.depletionChance) {
          obj.deplete();
          this.depletedObjectIds.add(obj.id);
          if (obj.def.blocking) {
            if (obj.def.category === 'tree') {
              const bx = Math.floor(obj.x), bz = Math.floor(obj.z);
              for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
                this.blockedObjectTiles.delete(this.blockedKeyFor(obj.mapLevel, bx + dx, bz + dz));
              }
            } else {
              this.blockedObjectTiles.delete(this.blockedKeyFor(obj.mapLevel, obj.x, obj.z));
            }
          }
          this.broadcastNearby(obj.mapLevel, obj.x, obj.z, ServerOpcode.WORLD_OBJECT_DEPLETED, obj.id, 1);
          this.skillingActions.delete(playerId);
          this.sendToPlayer(player, ServerOpcode.SKILLING_STOP, 0);
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
        obj.respawnTimer = obj.def.respawnTime ?? 200;
        continue;
      }
      if (obj.tickRespawn()) {
        this.depletedObjectIds.delete(objId);
        // Doors: never re-block the tile on respawn — only the wall edge
        // matters. Mirrors the spawn paths above which exclude doors from
        // blockedObjectTiles. Without this, the door tile becomes pathing-
        // blocked after the first auto-close and silently breaks every
        // subsequent click.
        if (obj.def.blocking && obj.def.category !== 'door') {
          if (obj.def.category === 'tree') {
            const bx = Math.floor(obj.x), bz = Math.floor(obj.z);
            for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
              this.blockedObjectTiles.add(this.blockedKeyFor(obj.mapLevel, bx + dx, bz + dz));
            }
          } else {
            this.blockedObjectTiles.add(this.blockedKeyFor(obj.mapLevel, obj.x, obj.z));
          }
        }
        if (obj.def.category === 'door') {
          const map = this.maps.get(obj.mapLevel);
          if (map) this.restoreDoorWallEdges(obj, map);
          obj.doorOpen = false;
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
    player.moveQueue = [];
    player.attackTarget = null;
    player.pendingInteraction = null;
    player.pendingPickup = -1;
    player.attackCooldown = 0;
    player.delayedUntilTick = 0;
    player.logoutBlockedUntilTick = 0;
    player.actionDelay = 0;
    player.openShopNpcId = null;

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
    // we're about to teleport away from. Use a 200-tick despawn (~2 min) —
    // long enough for the player to walk back and reclaim if they want to.
    for (const d of dropped) {
      const groundItem: GroundItem = {
        id: nextGroundItemId++,
        itemId: d.itemId,
        quantity: d.quantity,
        x: oldX,
        z: oldZ,
        mapLevel: oldMapId,
        despawnTimer: 200,
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
  teleportPlayer(player: Player, x: number, z: number): void {
    const mapId = player.currentMapLevel;
    console.log(`[TP] teleportPlayer: ${player.name} on map="${mapId}" to (${x.toFixed(1)}, ${z.toFixed(1)})`);
    const cm = this.chunkManagers.get(mapId);
    if (cm) cm.removeEntity(player.id);
    player.position.x = x;
    player.position.y = z;
    player.moveQueue = [];
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
    let teleportY = map.getEffectiveHeightOnFloor(x, z, player.currentFloor, player.reportedY);
    const elevAtTile = map.getElevatedFloorHeight(x, z);
    if (typeof elevAtTile === 'number' && elevAtTile > 1.0 && teleportY < elevAtTile - 1.0) {
      teleportY = elevAtTile;
    }
    player.reportedY = teleportY;
    const packet = encodePacket(
      ServerOpcode.PLAYER_TELEPORT,
      Math.round(x * 10),
      Math.round(z * 10),
      Math.round(teleportY * 10),
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
    player.currentMapLevel = newMap;
    player.position.x = transition.targetX;
    player.position.y = transition.targetZ;
    player.moveQueue = [];
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
      const sx = Math.round(player.position.x * 10);
      const sz = Math.round(player.position.y * 10);
      if (sx !== player.lastSyncX || sz !== player.lastSyncZ || player.health !== player.lastSyncHealth) {
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
          a ? a.hairStyle  : -1, a ? a.gearColor  : -1,
        ));
      }
    }
    for (const [, npc] of this.npcs) {
      if (npc.dead) continue;
      const sx = Math.round(npc.position.x * 10);
      const sz = Math.round(npc.position.y * 10);
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
      const cm = this.chunkManagers.get(viewer.currentMapLevel);
      if (!cm) continue;

      const chunkChanged = viewer.currentChunkX !== viewer.lastBroadcastChunkX ||
                            viewer.currentChunkZ !== viewer.lastBroadcastChunkZ;
      if (chunkChanged) {
        viewer.lastBroadcastChunkX = viewer.currentChunkX;
        viewer.lastBroadcastChunkZ = viewer.currentChunkZ;
      }

      try {
        cm.forEachEntityNearChunk(viewer.currentChunkX, viewer.currentChunkZ, (eid) => {
          const pkt = dirtyPlayerPackets.get(eid);
          if (pkt) { viewer.ws.sendBinary(pkt); return; }
          const npkt = dirtyNpcPackets.get(eid);
          if (npkt) { viewer.ws.sendBinary(npkt); return; }
          if (!chunkChanged || eid === viewer.id) return;
          const subject = this.players.get(eid);
          if (subject) {
            this.sendPlayerUpdate(viewer, subject);
            // Equipment isn't part of PLAYER_SYNC (it'd bloat every position
            // tick), so push it as a separate packet on chunk entry. Matches
            // what we do for world-object state — full sync on chunk change.
            this.sendRemoteEquipment(viewer, subject);
            this.sendRemoteStance(viewer, subject);
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
    const packet = encodeStringPacket(
      ServerOpcode.MAP_CHANGE,
      mapId,
      Math.round(player.position.x * 10),
      Math.round(player.position.y * 10)
    );
    try {
      player.ws.sendBinary(packet);
    } catch { /* connection closed */ }
  }

  private sendPlayerUpdate(viewer: Player, subject: Player): void {
    const a = subject.appearance;
    this.sendToPlayer(viewer, ServerOpcode.PLAYER_SYNC,
      subject.id,
      Math.round(subject.position.x * 10),
      Math.round(subject.position.y * 10),
      subject.health,
      subject.maxHealth,
      a ? a.shirtColor : -1,
      a ? a.pantsColor : -1,
      a ? a.shoesColor : -1,
      a ? a.hairColor  : -1,
      a ? a.beltColor  : -1,
      a ? a.skinColor  : -1,
      a ? a.hairStyle  : -1,
      a ? a.gearColor  : -1,
    );
  }

  private sendNpcUpdate(viewer: Player, npc: Npc): void {
    this.sendToPlayer(viewer, ServerOpcode.NPC_SYNC,
      npc.id,
      npc.npcId,
      Math.round(npc.position.x * 10),
      Math.round(npc.position.y * 10),
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
        a.hairStyle, a.gearColor,
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
  }

  private sendWorldObjectUpdate(viewer: Player, obj: WorldObject): void {
    // [objectEntityId, objectDefId, x*10, z*10, depleted(0/1)]
    this.sendToPlayer(viewer, ServerOpcode.WORLD_OBJECT_SYNC,
      obj.id,
      obj.defId,
      Math.round(obj.x * 10),
      Math.round(obj.z * 10),
      obj.depleted ? 1 : 0
    );
  }

  private sendGroundItemUpdate(viewer: Player, item: GroundItem): void {
    this.sendToPlayer(viewer, ServerOpcode.GROUND_ITEM_SYNC,
      item.id,
      item.itemId,
      item.quantity,
      Math.round(item.x * 10),
      Math.round(item.z * 10)
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
    const slotNames: EquipSlot[] = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];
    const values: number[] = [];
    for (let i = 0; i < slotNames.length; i++) {
      values.push(player.equipment.get(slotNames[i]) ?? 0);
    }
    this.sendToPlayer(player, ServerOpcode.PLAYER_EQUIPMENT_BATCH, ...values);
  }

  /** Build PLAYER_REMOTE_EQUIPMENT packet for a subject player. Layout:
   *  [entityId, weapon, shield, head, body, legs, neck, ring, hands, feet, cape] */
  private encodeRemoteEquipment(subject: Player): Uint8Array {
    const slotNames: EquipSlot[] = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];
    const values: number[] = [subject.id];
    for (let i = 0; i < slotNames.length; i++) {
      values.push(subject.equipment.get(slotNames[i]) ?? 0);
    }
    return encodePacket(ServerOpcode.PLAYER_REMOTE_EQUIPMENT, ...values);
  }

  /** Send a subject player's equipment to one viewer (for chunk-entry resync). */
  private sendRemoteEquipment(viewer: Player, subject: Player): void {
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
      if (!viewer || viewer.currentMapLevel !== subject.currentMapLevel) return;
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
      if (!viewer || viewer.currentMapLevel !== subject.currentMapLevel) return;
      try { viewer.ws.sendBinary(packet); } catch { /* connection closed */ }
    });
  }

  private sendToPlayer(player: Player, opcode: ServerOpcode, ...values: number[]): void {
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
