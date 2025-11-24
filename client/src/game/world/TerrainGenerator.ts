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
    // Multiple noise scales for different terrain features
    const baseScale = 0.015;
    const detailScale = 0.08;
    const mountainScale = 0.04;
    const lakeScale = 0.008;
    const riverScale = 0.03;
    const rockScale = 0.2;

    // Generate different noise layers
    const baseNoise = this.noise2D(x * baseScale, z * baseScale);
    const detailNoise = this.noise2D(x * detailScale, z * detailScale) * 0.4;
    const mountainNoise = this.noise2D(x * mountainScale, z * mountainScale);
    const lakeNoise = this.noise2D(x * lakeScale, z * lakeScale);
    const riverNoise = this.noise2D(x * riverScale, z * riverScale);
    const rockNoise = this.noise2D(x * rockScale, z * rockScale);

    // Combine noise layers for terrain height/elevation
    const combinedNoise = baseNoise + detailNoise;

    // Calculate distance from center for ocean
    const centerX = 0;
    const centerZ = 0;
    const distanceFromCenter = Math.sqrt(
      Math.pow(x - centerX, 2) + Math.pow(z - centerZ, 2)
    );
    const oceanThreshold = 12 + Math.sin(distanceFromCenter * 0.08) * 4;

    // Generate lakes (circular depressions)
    const lakeValue = lakeNoise;
    const lakeThreshold = -0.3; // Lower values create lakes
    const isLake = lakeValue < lakeThreshold && distanceFromCenter > oceanThreshold + 3;

    // Generate rivers (flowing patterns)
    // Create sinuous river patterns using noise
    const riverPattern = Math.abs(riverNoise);
    const riverThreshold = 0.15; // Narrow threshold for rivers
    const isRiver = riverPattern < riverThreshold && 
                    distanceFromCenter > oceanThreshold + 2 &&
                    !isLake &&
                    mountainNoise < 0.3; // Rivers don't flow through mountains

    // Determine tile type based on noise values
    if (distanceFromCenter < oceanThreshold) {
      return TileType.WATER; // Ocean
    } else if (isLake) {
      return TileType.LAKE;
    } else if (isRiver) {
      return TileType.RIVER;
    } else if (distanceFromCenter < oceanThreshold + 2) {
      return TileType.SAND; // Beach
    } else if (mountainNoise > 0.6) {
      return TileType.MOUNTAIN;
    } else if (mountainNoise > 0.4 && rockNoise > 0.3) {
      return TileType.ROCK; // Rocky areas
    } else if (combinedNoise > 0.15 && mountainNoise < 0.4) {
      return TileType.FOREST; // Forests in moderate elevation
    } else {
      return TileType.GRASS; // Plains
    }
  }
} 