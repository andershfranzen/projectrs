import { TileType } from './TileType';
import { createNoise2D } from 'simplex-noise';
import alea from 'alea';

export class TerrainGenerator {
  private noise2D: (x: number, y: number) => number;
  private seed: number;

  constructor(seed: number = Math.random()) {
    this.seed = seed;
    const prng = alea(seed.toString());
    this.noise2D = createNoise2D(prng);
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
    // Scale factors for different noise layers
    const baseScale = 0.02;
    const detailScale = 0.1;
    const mountainScale = 0.05;

    // Generate different noise layers
    const baseNoise = this.noise2D(x * baseScale, z * baseScale);
    const detailNoise = this.noise2D(x * detailScale, z * detailScale) * 0.3;
    const mountainNoise = this.noise2D(x * mountainScale, z * mountainScale);

    // Combine noise layers
    const combinedNoise = baseNoise + detailNoise;

    // Calculate distance from center for water bodies
    const centerX = 0;
    const centerZ = 0;
    const distanceFromCenter = Math.sqrt(
      Math.pow(x - centerX, 2) + Math.pow(z - centerZ, 2)
    );
    const waterThreshold = 10 + Math.sin(distanceFromCenter * 0.1) * 3;

    // Determine tile type based on noise values
    if (distanceFromCenter < waterThreshold) {
      return TileType.WATER;
    } else if (distanceFromCenter < waterThreshold + 2) {
      return TileType.SAND;
    } else if (mountainNoise > 0.5) {
      return TileType.MOUNTAIN;
    } else if (combinedNoise > 0.1) {
      return TileType.FOREST;
    } else {
      return TileType.GRASS;
    }
  }
} 