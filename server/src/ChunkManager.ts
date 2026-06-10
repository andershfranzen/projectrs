import { CHUNK_SIZE, CHUNK_LOAD_RADIUS } from '@projectrs/shared';

export type ServerEntityKind = 'entity' | 'player' | 'npc' | 'object' | 'groundItem';

/**
 * Server-side spatial index for entities within a map.
 * Tracks which chunk each entity is in for efficient proximity queries.
 * Uses numeric keys for performance (no string allocation on hot paths).
 */
export class ServerChunkManager {
  private entityChunks: Map<number, number> = new Map(); // entityId -> chunkKey
  private chunkEntities: Map<number, Set<number>> = new Map(); // chunkKey -> set of entityIds
  private chunkPlayers: Map<number, Set<number>> = new Map(); // chunkKey -> set of player entityIds
  private entityKinds: Map<number, ServerEntityKind> = new Map(); // entityId -> kind

  /** Subset of entity IDs that are players (for broadcastNearby) */
  private playerIds: Set<number> = new Set();

  readonly chunksX: number;
  readonly chunksZ: number;

  constructor(mapWidth: number, mapHeight: number) {
    this.chunksX = Math.ceil(mapWidth / CHUNK_SIZE);
    this.chunksZ = Math.ceil(mapHeight / CHUNK_SIZE);
  }

  /** Encode chunk coords into a single number. Supports coords -1000..65535 via offset. */
  private chunkKey(cx: number, cz: number): number {
    return ((cx + 1000) * 100000) + (cz + 1000);
  }

  private worldToChunk(x: number, z: number): [number, number] {
    return [Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)];
  }

  registerPlayer(entityId: number): void {
    this.playerIds.add(entityId);
    this.entityKinds.set(entityId, 'player');
    const key = this.entityChunks.get(entityId);
    if (key !== undefined) this.addPlayerToChunk(entityId, key);
  }

  unregisterPlayer(entityId: number): void {
    this.playerIds.delete(entityId);
    const key = this.entityChunks.get(entityId);
    if (key !== undefined) this.removePlayerFromChunk(entityId, key);
  }

  private addPlayerToChunk(entityId: number, key: number): void {
    let players = this.chunkPlayers.get(key);
    if (!players) {
      players = new Set();
      this.chunkPlayers.set(key, players);
    }
    players.add(entityId);
  }

  private removePlayerFromChunk(entityId: number, key: number): void {
    const players = this.chunkPlayers.get(key);
    if (!players) return;
    players.delete(entityId);
    if (players.size === 0) this.chunkPlayers.delete(key);
  }

  addEntity(entityId: number, worldX: number, worldZ: number, kind: ServerEntityKind = 'entity'): void {
    const [cx, cz] = this.worldToChunk(worldX, worldZ);
    const key = this.chunkKey(cx, cz);
    this.entityChunks.set(entityId, key);
    this.entityKinds.set(entityId, kind);
    let set = this.chunkEntities.get(key);
    if (!set) {
      set = new Set();
      this.chunkEntities.set(key, set);
    }
    set.add(entityId);
    if (this.playerIds.has(entityId)) this.addPlayerToChunk(entityId, key);
  }

  removeEntity(entityId: number): void {
    const key = this.entityChunks.get(entityId);
    if (key !== undefined) {
      const set = this.chunkEntities.get(key);
      if (set) {
        set.delete(entityId);
        if (set.size === 0) this.chunkEntities.delete(key);
      }
      if (this.playerIds.has(entityId)) this.removePlayerFromChunk(entityId, key);
      this.entityChunks.delete(entityId);
      this.entityKinds.delete(entityId);
    }
  }

  updateEntity(entityId: number, worldX: number, worldZ: number): void {
    const [cx, cz] = this.worldToChunk(worldX, worldZ);
    const newKey = this.chunkKey(cx, cz);
    const oldKey = this.entityChunks.get(entityId);
    if (oldKey === newKey) return;

    // Remove from old chunk
    if (oldKey !== undefined) {
      const set = this.chunkEntities.get(oldKey);
      if (set) {
        set.delete(entityId);
        if (set.size === 0) this.chunkEntities.delete(oldKey);
      }
      if (this.playerIds.has(entityId)) this.removePlayerFromChunk(entityId, oldKey);
    }

    // Add to new chunk
    this.entityChunks.set(entityId, newKey);
    let set = this.chunkEntities.get(newKey);
    if (!set) {
      set = new Set();
      this.chunkEntities.set(newKey, set);
    }
    set.add(entityId);
    if (this.playerIds.has(entityId)) this.addPlayerToChunk(entityId, newKey);
  }

  /** Get all entity IDs within CHUNK_LOAD_RADIUS of the given chunk coords */
  getEntitiesNearChunk(cx: number, cz: number): Set<number> {
    const result = new Set<number>();
    this.forEachEntityNearChunk(cx, cz, id => result.add(id));
    return result;
  }

  /** Get all entity IDs within CHUNK_LOAD_RADIUS of the given world position */
  getEntitiesNear(worldX: number, worldZ: number): Set<number> {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    return this.getEntitiesNearChunk(cx, cz);
  }

  /** Get only player IDs within CHUNK_LOAD_RADIUS of the given world position */
  getPlayersNear(worldX: number, worldZ: number): number[] {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    const result: number[] = [];
    this.forEachPlayerNearChunk(cx, cz, id => result.push(id));
    return result;
  }

  /** Zero-allocation: call fn for each entity within CHUNK_LOAD_RADIUS of chunk coords */
  forEachEntityNearChunk(cx: number, cz: number, fn: (entityId: number) => void): void {
    for (let dx = -CHUNK_LOAD_RADIUS; dx <= CHUNK_LOAD_RADIUS; dx++) {
      for (let dz = -CHUNK_LOAD_RADIUS; dz <= CHUNK_LOAD_RADIUS; dz++) {
        const key = this.chunkKey(cx + dx, cz + dz);
        const set = this.chunkEntities.get(key);
        if (set) {
          for (const id of set) fn(id);
        }
      }
    }
  }

  /** Zero-allocation: call fn for each player within CHUNK_LOAD_RADIUS of chunk coords */
  forEachPlayerNearChunk(cx: number, cz: number, fn: (playerId: number) => void): void {
    for (let dx = -CHUNK_LOAD_RADIUS; dx <= CHUNK_LOAD_RADIUS; dx++) {
      for (let dz = -CHUNK_LOAD_RADIUS; dz <= CHUNK_LOAD_RADIUS; dz++) {
        const key = this.chunkKey(cx + dx, cz + dz);
        const set = this.chunkPlayers.get(key);
        if (set) {
          for (const id of set) fn(id);
        }
      }
    }
  }

  /** Zero-allocation: call fn for each entity and its registered kind near chunk coords */
  forEachEntityKindNearChunk(cx: number, cz: number, fn: (entityId: number, kind: ServerEntityKind) => void): void {
    this.forEachEntityNearChunk(cx, cz, id => fn(id, this.entityKinds.get(id) ?? 'entity'));
  }

  /** Zero-allocation: call fn for each entity in chunks overlapped by a world
   *  position + tile radius. This is a coarse chunk query; callers that need
   *  exact distance should still apply their own range check. */
  forEachEntityKindNearRadius(worldX: number, worldZ: number, radiusTiles: number, fn: (entityId: number, kind: ServerEntityKind) => void): void {
    const radius = Number.isFinite(radiusTiles) && radiusTiles > 0 ? radiusTiles : 0;
    const minCx = Math.floor((worldX - radius) / CHUNK_SIZE);
    const maxCx = Math.floor((worldX + radius) / CHUNK_SIZE);
    const minCz = Math.floor((worldZ - radius) / CHUNK_SIZE);
    const maxCz = Math.floor((worldZ + radius) / CHUNK_SIZE);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const set = this.chunkEntities.get(this.chunkKey(cx, cz));
        if (!set) continue;
        for (const id of set) fn(id, this.entityKinds.get(id) ?? 'entity');
      }
    }
  }

  /** Zero-allocation: call fn for each player within CHUNK_LOAD_RADIUS of world position */
  forEachPlayerNear(worldX: number, worldZ: number, fn: (playerId: number) => void): void {
    const cx = Math.floor(worldX / CHUNK_SIZE);
    const cz = Math.floor(worldZ / CHUNK_SIZE);
    this.forEachPlayerNearChunk(cx, cz, fn);
  }

  getEntityChunk(entityId: number): [number, number] | null {
    const key = this.entityChunks.get(entityId);
    if (key === undefined) return null;
    const cx = Math.floor(key / 100000) - 1000;
    const cz = (key % 100000) - 1000;
    return [cx, cz];
  }
}
