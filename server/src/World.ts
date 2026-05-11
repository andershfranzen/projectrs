import { TICK_RATE, CHUNK_SIZE, CHUNK_LOAD_RADIUS, ServerOpcode, ALL_SKILLS, ASSET_TO_OBJECT_DEF, WallEdge, doorEdgeFromPlacement, doorClosedEdgeFromRotY, DOOR_EDGE_NEIGHBOR, type SkillId, type ItemDef, type PlayerAppearance, isValidAppearance } from '@projectrs/shared';
import { encodePacket, encodeStringPacket } from '@projectrs/shared';
import { addXp, levelFromXp, statRandom } from '@projectrs/shared';
import { GameMap } from './GameMap';
import { Player, type EquipSlot } from './entity/Player';
import { Npc } from './entity/Npc';
import { WorldObject } from './entity/WorldObject';
import { DataLoader } from './data/DataLoader';
import { GameDatabase } from './Database';
import { processPlayerCombat, processPlayerRangedCombat, processNpcCombat, rollLoot, RANGED_ATTACK_DISTANCE } from './combat/Combat';
import { broadcastPlayerInfo } from './network/ChatSocket';
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

let nextGroundItemId = 1;

export class World {
  readonly maps: Map<string, GameMap> = new Map();
  readonly chunkManagers: Map<string, ServerChunkManager> = new Map();
  readonly data: DataLoader;
  readonly db: GameDatabase;
  readonly players: Map<number, Player> = new Map();
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
      const npc = new Npc(npcDef, spawn.x, spawn.z, spawn.wanderRange);
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
      if (npc && !npc.dead) { this.sendNpcUpdate(player, npc); continue; }
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
        const npc = new Npc(npcDef, spawn.x, spawn.z, spawn.wanderRange);
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
    this.sendToPlayer(player, ServerOpcode.LOGIN_OK, player.id,
      Math.round(player.position.x * 10),
      Math.round(player.position.y * 10),
      Math.round(spawnY * 10),
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

    const map = this.getPlayerMap(player);
    // Cap path length to prevent DoS from malicious clients
    if (path.length > 200) path.length = 200;
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
      const map = this.getPlayerMap(player);
      const path = map.findPathOnFloor(player.position.x, player.position.y, npc.position.x, npc.position.y, player.currentFloor);
      if (!isRanged && path.length > 1) {
        player.moveQueue = path.slice(0, -1); // melee: walk to adjacent
      } else if (isRanged) {
        // Ranged: walk until within range, then stop
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
    } else {
      player.moveQueue = [];
    }
  }

  handlePlayerTalkNpc(playerId: number, npcEntityId: number): void {
    const player = this.players.get(playerId);
    const npc = this.npcs.get(npcEntityId);
    if (!player || !npc || npc.dead) return;
    if (npc.currentMapLevel !== player.currentMapLevel) return;

    // Check distance
    const dx = npc.position.x - player.position.x;
    const dz = npc.position.y - player.position.y;
    if (Math.sqrt(dx * dx + dz * dz) > 3) return;

    const shop = this.data.getShop(npc.npcId);
    if (!shop) return;

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

    // Find the item price from pre-indexed shop data
    const price = this.data.getShopPrice(itemId);
    if (price === undefined) return;

    const totalCost = price * quantity;

    // Check player has enough coins (itemId 10)
    let coinSlot = -1;
    let coinCount = 0;
    for (let i = 0; i < player.inventory.length; i++) {
      if (player.inventory[i]?.itemId === 10) {
        coinSlot = i;
        coinCount = player.inventory[i]!.quantity;
        break;
      }
    }
    if (coinCount < totalCost) return;

    // Check inventory space
    const itemDef = this.data.getItem(itemId);
    if (!itemDef) return;

    let freeSlots = 0;
    let existingSlot = -1;
    for (let i = 0; i < player.inventory.length; i++) {
      if (!player.inventory[i]) freeSlots++;
      if (itemDef.stackable && player.inventory[i]?.itemId === itemId) existingSlot = i;
    }
    if (!itemDef.stackable && freeSlots < quantity) return;
    if (itemDef.stackable && existingSlot < 0 && freeSlots < 1) return;

    // Deduct coins
    player.inventory[coinSlot]!.quantity -= totalCost;
    if (player.inventory[coinSlot]!.quantity <= 0) {
      player.inventory[coinSlot] = null;
    }

    // Add items (batch — avoid per-item findIndex)
    if (itemDef.stackable) {
      if (existingSlot >= 0) {
        player.inventory[existingSlot]!.quantity += quantity;
      } else {
        const slot = player.inventory.findIndex(s => s === null);
        if (slot >= 0) {
          player.inventory[slot] = { itemId, quantity };
        }
      }
    } else {
      let added = 0;
      for (let i = 0; i < player.inventory.length && added < quantity; i++) {
        if (!player.inventory[i]) {
          player.inventory[i] = { itemId, quantity: 1 };
          added++;
        }
      }
    }

    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
  }

  handlePlayerSellItem(playerId: number, slot: number, quantity: number, expectedItemId: number): void {
    const player = this.players.get(playerId);
    if (!player || quantity < 1) return;
    if (player.isBusy(this.currentTick)) return;
    if (slot < 0 || slot >= player.inventory.length) return;

    const invItem = player.inventory[slot];
    if (!invItem) return;
    if (invItem.itemId !== expectedItemId) return;

    const itemDef = this.data.getItem(invItem.itemId);
    if (!itemDef) return;

    // Sell price = half of value (floor)
    const sellPrice = Math.max(1, Math.floor((itemDef.value || 1) / 2));
    const actualQty = Math.min(quantity, invItem.quantity);
    const totalGold = sellPrice * actualQty;

    // Remove sold items
    invItem.quantity -= actualQty;
    if (invItem.quantity <= 0) {
      player.inventory[slot] = null;
    }

    // Add coins
    let coinSlot = player.inventory.findIndex(s => s?.itemId === 10);
    if (coinSlot >= 0) {
      player.inventory[coinSlot]!.quantity += totalGold;
    } else {
      coinSlot = player.inventory.findIndex(s => s === null);
      if (coinSlot >= 0) {
        player.inventory[coinSlot] = { itemId: 10, quantity: totalGold };
      }
    }

    player.setDelay(this.currentTick, 1);
    this.sendInventory(player);
  }

  handlePlayerPickup(playerId: number, groundItemId: number): void {
    const player = this.players.get(playerId);
    const item = this.groundItems.get(groundItemId);
    if (!player || !item) return;
    if (player.isBusy(this.currentTick)) return;
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

    const stances = ['accurate', 'aggressive', 'defensive', 'controlled'] as const;
    if (stanceIndex >= 0 && stanceIndex < stances.length) {
      player.stance = stances[stanceIndex];
      player.setDelay(this.currentTick, 1);
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

  // Tick performance monitoring
  private tickOverrunCount: number = 0;
  private lastTickWarnTime: number = 0;

  private tick(): void {
    const tickStart = performance.now();
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
          this.forEachPlayerNear(npc.currentMapLevel, npc.position.x, npc.position.y, p => this.sendNpcUpdate(p, npc));
        }
        continue;
      }

      const map = this.getMap(npc.currentMapLevel);

      if (npc.def.aggressive && !npc.combatTarget) {
        const cm = this.chunkManagers.get(npc.currentMapLevel);
        if (cm) {
          cm.forEachPlayerNear(npc.position.x, npc.position.y, (pid) => {
            if (npc.combatTarget) return;
            const player = this.players.get(pid);
            if (!player) return;
            const dx = Math.abs(npc.position.x - player.position.x);
            const dz = Math.abs(npc.position.y - player.position.y);
            if (dx <= 5 && dz <= 5) {
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
        // Out of range — recompute path to the NPC and let tickPlayerMovement
        // walk us there smoothly. This replaces an older snap-to-tile-center
        // + manual 1-tile step that bypassed the move queue and looked like
        // teleporting, especially against moving mobs. We re-pathfind every
        // tick so the chase tracks NPC movement (cheap on a 256x256 map).
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
          const map = this.getMap(target.currentMapLevel);
          const spawn = map.findSpawnPoint();
          target.health = target.maxHealth;
          target.skills.hitpoints.currentLevel = target.maxHealth;
          target.position.x = spawn.x;
          target.position.y = spawn.z;
          target.moveQueue = [];
          target.attackTarget = null;
          npc.combatTarget = null;
          this.clearCombatTarget(target.id);

          this.sendToPlayer(target, ServerOpcode.PLAYER_STATS,
            target.health, target.maxHealth
          );
          this.sendSkills(target);
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
        if (npc && !npc.dead) { this.sendNpcUpdate(player, npc); continue; }
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
            return;
          }
          const npc = this.npcs.get(eid);
          if (npc && !npc.dead) { this.sendNpcUpdate(viewer, npc); return; }
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
    // Find the player's chat socket and send system message
    try {
      player.ws.sendBinary(encodePacket(ServerOpcode.CHAT_SYSTEM, 0));
    } catch { /* ignore */ }
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
