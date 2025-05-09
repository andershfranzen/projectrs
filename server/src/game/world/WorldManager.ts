import { TerrainGenerator } from './TerrainGenerator';
import { TileType } from './TileType';
import { Server } from 'socket.io';
import { Player } from '../entities/Player';

export class WorldManager {
  private terrainGenerator: TerrainGenerator;
  private chunkSize: number;
  private activeChunks: Map<string, TileType[][]> = new Map();
  private players: Map<string, Player> = new Map();
  private io: Server;

  constructor(io: Server, chunkSize: number = 16) {
    this.io = io;
    this.chunkSize = chunkSize;
    this.terrainGenerator = new TerrainGenerator();
    this.setupSocketHandlers();
  }

  private setupSocketHandlers(): void {
    this.io.on('connection', (socket) => {
      // Handle player joining
      socket.on('player:join', (playerData: { id: string; position: { x: number; y: number; z: number } }) => {
        const player = new Player(playerData.id, playerData.position);
        this.players.set(playerData.id, player);
        
        // Send initial world state to the new player
        this.sendInitialWorldState(socket, playerData.position);
        
        // Broadcast new player to others
        socket.broadcast.emit('player:joined', playerData);
      });

      // Handle player movement
      socket.on('player:move', (data: { id: string; position: { x: number; y: number; z: number } }) => {
        const player = this.players.get(data.id);
        if (player) {
          player.updatePosition(data.position);
          // Broadcast movement to other players
          socket.broadcast.emit('player:moved', data);
        }
      });

      // Handle player disconnection
      socket.on('disconnect', () => {
        const playerId = Array.from(this.players.entries())
          .find(([_, player]) => player.socketId === socket.id)?.[0];
        
        if (playerId) {
          this.players.delete(playerId);
          this.io.emit('player:left', { id: playerId });
        }
      });
    });
  }

  private sendInitialWorldState(socket: any, position: { x: number; y: number; z: number }): void {
    const chunkX = Math.floor(position.x / this.chunkSize);
    const chunkZ = Math.floor(position.z / this.chunkSize);
    const renderDistance = 2;

    // Send chunks in render distance
    for (let x = -renderDistance; x <= renderDistance; x++) {
      for (let z = -renderDistance; z <= renderDistance; z++) {
        const currentChunkX = chunkX + x;
        const currentChunkZ = chunkZ + z;
        const chunkKey = `${currentChunkX},${currentChunkZ}`;

        if (!this.activeChunks.has(chunkKey)) {
          const chunk = this.terrainGenerator.generateChunk(
            currentChunkX,
            currentChunkZ,
            this.chunkSize
          );
          this.activeChunks.set(chunkKey, chunk);
        }

        socket.emit('chunk:data', {
          x: currentChunkX,
          z: currentChunkZ,
          data: this.activeChunks.get(chunkKey)
        });
      }
    }

    // Send current players in the area
    const nearbyPlayers = Array.from(this.players.values())
      .filter(player => {
        const dx = player.position.x - position.x;
        const dz = player.position.z - position.z;
        return Math.sqrt(dx * dx + dz * dz) <= this.chunkSize * renderDistance;
      })
      .map(player => ({
        id: player.id,
        position: player.position
      }));

    socket.emit('players:nearby', nearbyPlayers);
  }

  public getChunk(chunkX: number, chunkZ: number): TileType[][] {
    const chunkKey = `${chunkX},${chunkZ}`;
    
    if (!this.activeChunks.has(chunkKey)) {
      const chunk = this.terrainGenerator.generateChunk(
        chunkX,
        chunkZ,
        this.chunkSize
      );
      this.activeChunks.set(chunkKey, chunk);
    }

    return this.activeChunks.get(chunkKey)!;
  }
} 