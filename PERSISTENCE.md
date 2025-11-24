# World Persistence - How It Works

## ✅ The World is Persistent

The world **does NOT regenerate** when you run the game. It loads from a static data file.

## How Persistence Works

### 1. **World Data File** (`client/src/game/world/worldData.json`)
   - **327KB file** containing the complete 128x128 tile world
   - **18,693 lines** of JSON data
   - Contains all 64 chunks (8x8 grid)
   - **This file is loaded once** when the game starts

### 2. **Loading Process**
   ```
   Game Starts
   ↓
   World.ts imports worldData.json (static import)
   ↓
   Chunks load from JSON file
   ↓
   Same world every time ✅
   ```

### 3. **No Runtime Generation**
   - ❌ World is NOT procedurally generated
   - ❌ World does NOT change between sessions
   - ❌ No Python script runs automatically
   - ✅ World loads from static JSON file

## When Does the World Change?

The world **only changes** when you **manually** run:

```bash
python3 scripts/build_world.py
```

This will:
1. Generate a new world design
2. Overwrite `worldData.json`
3. Next time you run the game, you'll see the new world

## File Roles

| File | Purpose | When It Runs |
|------|---------|--------------|
| `worldData.json` | **Persistent world data** | Loaded every game start |
| `World.ts` | Loads from worldData.json | Every game start |
| `scripts/build_world.py` | Generates worldData.json | **Only when you run it manually** |
| `TerrainGenerator.ts` | Not used anymore | Never |

## Verification

To verify the world is persistent:
1. Note the location of a tree or feature
2. Close and restart the game
3. The same tree/feature will be in the same place ✅

## Making Changes

If you want to redesign the world:
1. Edit `scripts/build_world.py` (change lake size, add features, etc.)
2. Run `python3 scripts/build_world.py`
3. Commit the new `worldData.json` to git
4. All players will see the new world

## Summary

- ✅ **Persistent**: World data stored in `worldData.json`
- ✅ **Static**: Same world every game session
- ✅ **Intentional**: Designed world, not random
- ✅ **Bounded**: 128x128 tiles, finite world
- ❌ **NOT infinite**: Fixed size
- ❌ **NOT procedural**: Loads from file

The world is **persistent by design** - the `worldData.json` file IS the persistent data storage!
