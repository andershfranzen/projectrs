import { TileType } from './TileType';
import { createNoise2D } from 'simplex-noise';

export class TerrainGenerator {
  private noise2D: (x: number, y: number) => number;

  constructor() {
    this.noise2D = createNoise2D();
  }

  public generateChunk(
    chunkX: number,
    chunkZ: number,
    chunkSize: number
  ): TileType[][] {
    const tiles: TileType[][] = [];

    for (let x = 0; x < chunkSize; x++) {
      tiles[x] = [];
      for (let z = 0; z < chunkSize; z++) {
        const worldX = chunkX * chunkSize + x;
        const worldZ = chunkZ * chunkSize + z;
        tiles[x][z] = this.getTileType(worldX, worldZ);
      }
    }

    return tiles;
  }

  private getTileType(x: number, z: number): TileType {
    // Create a more interesting terrain pattern
    const scale = 0.05; // Reduced scale for larger features
    const height = this.noise2D(x * scale, z * scale);
    
    // Add multiple layers of noise for more detail
    const detail = this.noise2D(x * scale * 2, z * scale * 2) * 0.3;
    const smallDetail = this.noise2D(x * scale * 4, z * scale * 4) * 0.15;
    const combinedHeight = height + detail + smallDetail;

    // Create a circular pattern for water
    const distanceFromCenter = Math.sqrt(x * x + z * z) * 0.01;
    const waterPattern = Math.sin(distanceFromCenter) * 0.5;

    // Combine height with water pattern
    const finalHeight = combinedHeight + waterPattern;

    // Determine tile type based on height
    if (finalHeight < -0.4) {
      return TileType.WATER;
    } else if (finalHeight < -0.2) {
      return TileType.SAND;
    } else if (finalHeight < 0.2) {
      // Add some random forest tiles in the grass areas
      const forestNoise = this.noise2D(x * scale * 3, z * scale * 3);
      return forestNoise > 0.6 ? TileType.FOREST : TileType.GRASS;
    } else {
      return TileType.MOUNTAIN;
    }
  }
} 