#!/usr/bin/env python3
"""
World Builder - Creates an intentionally designed persistent world map.
Design: A central island with a lake, rivers, forests, mountains, and beaches.
"""

import json

# World dimensions: 128x128 tiles = 8x8 chunks (each chunk is 16x16)
WORLD_SIZE = 128
CHUNK_SIZE = 16
NUM_CHUNKS = WORLD_SIZE // CHUNK_SIZE

# Tile types
WATER = "WATER"
SAND = "SAND"
GRASS = "GRASS"
FOREST = "FOREST"
MOUNTAIN = "MOUNTAIN"
ROCK = "ROCK"
LAKE = "LAKE"
RIVER = "RIVER"

def create_world_map():
    """Create a 2D array representing the world."""
    world = [[WATER for _ in range(WORLD_SIZE)] for _ in range(WORLD_SIZE)]
    
    # Define the center of the world
    center_x, center_z = WORLD_SIZE // 2, WORLD_SIZE // 2
    
    # Create main island (elliptical shape)
    island_radius_x = 45
    island_radius_z = 40
    
    for x in range(WORLD_SIZE):
        for z in range(WORLD_SIZE):
            # Calculate distance from center
            dx = (x - center_x) / island_radius_x
            dz = (z - center_z) / island_radius_z
            dist_sq = dx * dx + dz * dz
            
            # Create island with smooth edges
            if dist_sq < 1.0:
                # Inside island
                if dist_sq < 0.85:
                    world[x][z] = GRASS
                else:
                    # Beach around edges
                    world[x][z] = SAND
            elif dist_sq < 1.1:
                # Transition zone - beach
                world[x][z] = SAND
    
    # Create central lake (circular)
    lake_center_x, lake_center_z = center_x, center_z - 5
    lake_radius = 12
    
    for x in range(WORLD_SIZE):
        for z in range(WORLD_SIZE):
            dx = x - lake_center_x
            dz = z - lake_center_z
            dist_sq = dx * dx + dz * dz
            if dist_sq < lake_radius * lake_radius:
                world[x][z] = LAKE
    
    # Create river flowing from lake to ocean (south)
    river_start_x, river_start_z = lake_center_x, lake_center_z + lake_radius
    river_end_z = WORLD_SIZE - 10
    
    # Sinuous river path
    for z in range(int(river_start_z), river_end_z):
        # Create winding path
        offset = int(3 * (z % 8 - 4) / 4)  # Creates winding effect
        x = river_start_x + offset
        
        # River width of 2-3 tiles
        for dx in range(-1, 2):
            if 0 <= x + dx < WORLD_SIZE:
                if world[x + dx][z] != LAKE:
                    world[x + dx][z] = RIVER
    
    # Create second river flowing east
    river2_start_x, river2_start_z = lake_center_x + lake_radius, lake_center_z
    river2_end_x = WORLD_SIZE - 10
    
    for x in range(int(river2_start_x), river2_end_x):
        offset = int(2 * (x % 6 - 3) / 3)
        z = river2_start_z + offset
        
        for dz in range(-1, 2):
            if 0 <= z + dz < WORLD_SIZE:
                if world[x][z + dz] != LAKE:
                    world[x][z + dz] = RIVER
    
    # Create northern mountain range
    mountain_start_z = 15
    mountain_end_z = 35
    mountain_center_x = center_x
    
    for z in range(mountain_start_z, mountain_end_z):
        # Mountain range width varies
        width = 8 + int(3 * abs(z - (mountain_start_z + mountain_end_z) / 2) / 10)
        for x in range(mountain_center_x - width, mountain_center_x + width):
            if 0 <= x < WORLD_SIZE and world[x][z] != WATER:
                # Check if it's not lake or river
                if world[x][z] not in [LAKE, RIVER]:
                    world[x][z] = MOUNTAIN
    
    # Add some rocky areas near mountains
    for z in range(mountain_end_z, mountain_end_z + 8):
        for x in range(mountain_center_x - 6, mountain_center_x + 6):
            if 0 <= x < WORLD_SIZE and world[x][z] == GRASS:
                if (x + z) % 3 == 0:
                    world[x][z] = ROCK
    
    # Create eastern forest
    forest_east_start_x = center_x + 20
    forest_east_end_x = WORLD_SIZE - 15
    forest_east_start_z = center_z - 15
    forest_east_end_z = center_z + 15
    
    for x in range(forest_east_start_x, forest_east_end_x):
        for z in range(forest_east_start_z, forest_east_end_z):
            if world[x][z] == GRASS:
                # Create forest with some variation
                if (x + z) % 3 != 0:  # Not every tile
                    world[x][z] = FOREST
    
    # Create western forest (smaller)
    forest_west_start_x = 15
    forest_west_end_x = center_x - 15
    forest_west_start_z = center_z - 10
    forest_west_end_z = center_z + 20
    
    for x in range(forest_west_start_x, forest_west_end_x):
        for z in range(forest_west_start_z, forest_west_end_z):
            if world[x][z] == GRASS:
                if (x + z) % 4 != 0:
                    world[x][z] = FOREST
    
    # Create southern forest near river
    forest_south_start_x = center_x - 20
    forest_south_end_x = center_x + 20
    forest_south_start_z = center_z + 25
    forest_south_end_z = WORLD_SIZE - 15
    
    for x in range(forest_south_start_x, forest_south_end_x):
        for z in range(forest_south_start_z, forest_south_end_z):
            if world[x][z] == GRASS:
                if (x + z) % 3 != 0:
                    world[x][z] = FOREST
    
    # Add some small lakes scattered around
    small_lakes = [
        (center_x - 25, center_z + 15, 5),
        (center_x + 30, center_z - 20, 4),
        (center_x - 15, center_z - 25, 6),
    ]
    
    for lx, lz, radius in small_lakes:
        for x in range(max(0, lx - radius), min(WORLD_SIZE, lx + radius)):
            for z in range(max(0, lz - radius), min(WORLD_SIZE, lz + radius)):
                dx = x - lx
                dz = z - lz
                if dx * dx + dz * dz < radius * radius:
                    if world[x][z] == GRASS or world[x][z] == FOREST:
                        world[x][z] = LAKE
    
    return world

def world_to_chunks(world):
    """Convert world map to chunk-based format."""
    chunks = {}
    
    for chunk_x in range(NUM_CHUNKS):
        for chunk_z in range(NUM_CHUNKS):
            chunk_key = f"{chunk_x - NUM_CHUNKS // 2},{chunk_z - NUM_CHUNKS // 2}"
            tiles = []
            
            start_x = chunk_x * CHUNK_SIZE
            start_z = chunk_z * CHUNK_SIZE
            
            for x in range(start_x, start_x + CHUNK_SIZE):
                row = []
                for z in range(start_z, start_z + CHUNK_SIZE):
                    if 0 <= x < WORLD_SIZE and 0 <= z < WORLD_SIZE:
                        row.append(world[x][z])
                    else:
                        row.append(WATER)  # Out of bounds = water
                tiles.append(row)
            
            chunks[chunk_key] = {"tiles": tiles}
    
    return chunks

def main():
    print("Building intentional world map...")
    world = create_world_map()
    print("Converting to chunks...")
    chunks = world_to_chunks(world)
    
    world_data = {
        "worldSize": WORLD_SIZE,
        "chunkSize": CHUNK_SIZE,
        "chunks": chunks
    }
    
    output_file = "client/src/game/world/worldData.json"
    print(f"Writing to {output_file}...")
    with open(output_file, 'w') as f:
        json.dump(world_data, f, indent=2)
    
    # Print statistics
    tile_counts = {}
    for row in world:
        for tile in row:
            tile_counts[tile] = tile_counts.get(tile, 0) + 1
    
    print("\nWorld Statistics:")
    print(f"Total tiles: {WORLD_SIZE * WORLD_SIZE}")
    for tile_type, count in sorted(tile_counts.items()):
        percentage = (count / (WORLD_SIZE * WORLD_SIZE)) * 100
        print(f"  {tile_type}: {count} tiles ({percentage:.1f}%)")
    
    print(f"\nWorld built successfully! Size: {WORLD_SIZE}x{WORLD_SIZE} tiles")
    print(f"Chunks: {NUM_CHUNKS}x{NUM_CHUNKS} = {NUM_CHUNKS * NUM_CHUNKS} chunks")

if __name__ == "__main__":
    main()
