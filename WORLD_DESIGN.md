# World Design Documentation

## Overview
This is a **persistent, intentionally designed world** - not procedurally generated. The world is fixed at **128x128 tiles** (8x8 chunks of 16x16 tiles each).

## World Layout

### Central Island
- **Shape**: Elliptical island in the center of the world
- **Size**: Approximately 90x80 tiles
- **Terrain**: Mainly grasslands with beaches around the edges

### Key Features

#### 1. Central Lake
- **Location**: Slightly north of island center
- **Size**: ~12 tile radius (circular)
- **Purpose**: Main water feature, source of rivers

#### 2. Rivers
- **South River**: Flows from central lake to southern ocean (winding path)
- **East River**: Flows from central lake to eastern ocean (winding path)
- **Width**: 2-3 tiles wide

#### 3. Northern Mountain Range
- **Location**: Northern part of island (z: 15-35)
- **Width**: Varies from 8-14 tiles
- **Height**: Elevated terrain blocks
- **Surrounding**: Rocky areas below mountains

#### 4. Forests
- **Eastern Forest**: Large forest on eastern side of island
- **Western Forest**: Smaller forest on western side
- **Southern Forest**: Forest near southern river
- **Density**: ~70% forest tiles, 30% grass (for natural variation)

#### 5. Small Lakes
- Three additional small lakes scattered across the island
- Sizes: 4-6 tile radius
- Located in various regions for visual interest

#### 6. Beaches
- **Location**: Transition zone between ocean and land
- **Width**: ~2-3 tiles
- **Material**: Sand tiles

## Terrain Distribution

- **Water (Ocean)**: 61.7% - Surrounds the island
- **Grass**: 16.3% - Main land terrain
- **Sand (Beaches)**: 8.0% - Coastal areas
- **Forest**: 7.0% - Three main forest areas
- **Lake**: 4.0% - Central lake + 3 small lakes
- **River**: 1.6% - Two main rivers
- **Mountain**: 1.3% - Northern range
- **Rock**: 0.2% - Rocky areas near mountains

## World Boundaries

- **World Size**: 128x128 tiles
- **Chunk Size**: 16x16 tiles
- **Total Chunks**: 64 chunks (8x8 grid)
- **Coordinate System**: 
  - Center: (0, 0)
  - Bounds: (-64, -64) to (64, 64)

## Modifying the World

To modify the world design, edit `scripts/build_world.py` and run:

```bash
python3 scripts/build_world.py
```

This will regenerate `client/src/game/world/worldData.json` with your changes.

## Design Philosophy

This world is designed to be:
- **Explorable**: Interesting features to discover
- **Balanced**: Good mix of terrain types
- **Cohesive**: Features flow naturally (rivers from lake, forests near water)
- **Persistent**: Same world every time you play
- **Intentional**: Every feature placed with purpose
