import { Scene, Vector3, TransformNode } from '@babylonjs/core';
import { Socket } from 'socket.io-client';
import { Chunk } from './Chunk';
import { TerrainGenerator } from './TerrainGenerator';
import { TileType } from './TileType';

export class World {
  private chunks: Map<string, Chunk>;
  private scene: Scene;
  private socket: Socket;
  private localPlayerId: string;
  private chunkSize: number;
  private renderDistance: number;
  private parent?: TransformNode;
  private terrainGenerator: TerrainGenerator;

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
    // Initialize terrain generator with a fixed seed for consistency
    this.terrainGenerator = new TerrainGenerator(12345);
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

    // Load new chunks
    for (const chunkKey of chunksToLoad) {
      if (!this.chunks.has(chunkKey)) {
        const [x, z] = chunkKey.split(',').map(Number);
        
        // Generate terrain procedurally using TerrainGenerator
        const tiles = this.terrainGenerator.generateChunk(x, z, this.chunkSize);
        
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

  public dispose(): void {
    for (const chunk of this.chunks.values()) {
      chunk.dispose();
    }
    this.chunks.clear();
  }
} 