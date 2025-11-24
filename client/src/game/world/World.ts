import { Scene, Vector3, TransformNode } from '@babylonjs/core';
import { Socket } from 'socket.io-client';
import { Chunk } from './Chunk';
import worldData from './worldData.json';
import { TileType } from './TileType';

export class World {
  private chunks: Map<string, Chunk>;
  private scene: Scene;
  private socket: Socket;
  private localPlayerId: string;
  private chunkSize: number;
  private renderDistance: number;
  private parent?: TransformNode;
  private worldSize: number;

  constructor(
    scene: Scene,
    socket: Socket,
    localPlayerId: string,
    chunkSize: number = 16,
    renderDistance: number = 3,
    parent?: TransformNode
  ) {
    this.chunks = new Map();
    this.scene = scene;
    this.socket = socket;
    this.localPlayerId = localPlayerId;
    this.chunkSize = chunkSize;
    this.renderDistance = renderDistance;
    this.parent = parent;
    this.worldSize = (worldData as any).worldSize || 128;
  }

  public initialize(): void {
    // Load initial chunks around origin
    this.loadChunks(new Vector3(0, 0, 0));
  }

  public updateWorld(playerPosition: Vector3): void {
    this.loadChunks(playerPosition);
  }

  private loadChunks(centerPosition: Vector3): void {
    const centerChunkX = Math.floor(centerPosition.x / this.chunkSize);
    const centerChunkZ = Math.floor(centerPosition.z / this.chunkSize);

    // Calculate which chunks should be loaded
    const chunksToLoad = new Set<string>();
    for (let x = -this.renderDistance; x <= this.renderDistance; x++) {
      for (let z = -this.renderDistance; z <= this.renderDistance; z++) {
        const chunkX = centerChunkX + x;
        const chunkZ = centerChunkZ + z;
        const chunkKey = `${chunkX},${chunkZ}`;
        chunksToLoad.add(chunkKey);
      }
    }

    // Remove chunks that are too far away
    for (const [key, chunk] of this.chunks.entries()) {
      if (!chunksToLoad.has(key)) {
        chunk.dispose();
        this.chunks.delete(key);
      }
    }

    // Load new chunks from persistent world data
    for (const chunkKey of chunksToLoad) {
      if (!this.chunks.has(chunkKey)) {
        const [x, z] = chunkKey.split(',').map(Number);
        const chunkData = (worldData.chunks as any)[chunkKey];
        
        if (chunkData && chunkData.tiles) {
          // Convert string tile types to TileType enum
          const tiles: TileType[][] = chunkData.tiles.map((row: string[]) =>
            row.map((tile: string) => tile as TileType)
          );
          
          const chunk = new Chunk(
            this.scene,
            new Vector3(x * this.chunkSize, 0, z * this.chunkSize),
            this.chunkSize,
            tiles,
            this.parent
          );
          this.chunks.set(chunkKey, chunk);
        } else {
          // Chunk doesn't exist in world data - fill with water (out of bounds)
          const tiles: TileType[][] = Array.from({ length: this.chunkSize }, () =>
            Array(this.chunkSize).fill(TileType.WATER)
          );
          
          const chunk = new Chunk(
            this.scene,
            new Vector3(x * this.chunkSize, 0, z * this.chunkSize),
            this.chunkSize,
            tiles,
            this.parent
          );
          this.chunks.set(chunkKey, chunk);
        }
      }
    }
  }

  public getWorldSize(): number {
    return this.worldSize;
  }

  public getWorldBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const halfSize = this.worldSize / 2;
    return {
      minX: -halfSize,
      maxX: halfSize,
      minZ: -halfSize,
      maxZ: halfSize
    };
  }

  public dispose(): void {
    for (const chunk of this.chunks.values()) {
      chunk.dispose();
    }
    this.chunks.clear();
  }
} 