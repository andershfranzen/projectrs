# World Data - Persistent Storage

## How It Works

The world is **persistent** and loaded from `worldData.json`. This file contains the complete world map and is **NOT regenerated** when the game runs.

### Loading Process

1. **Game starts** → `World.ts` imports `worldData.json`
2. **Chunks load** → Data is read from the JSON file
3. **World renders** → Same world every time

### Regenerating the World

The world is only regenerated when you **manually run** the build script:

```bash
python3 scripts/build_world.py
```

This will overwrite `worldData.json` with a new design. **Do not run this unless you want to redesign the world.**

### File Structure

- `worldData.json` - **Persistent world data** (327KB, contains all 64 chunks)
- `World.ts` - Loads from worldData.json (does NOT generate)
- `TerrainGenerator.ts` - Not used anymore (kept for reference)
- `scripts/build_world.py` - Only run manually to redesign

### Persistence Guarantee

- ✅ World loads from static JSON file
- ✅ Same world every game session
- ✅ No procedural generation at runtime
- ✅ Changes persist until you regenerate

### Making Changes

To modify the world design:
1. Edit `scripts/build_world.py`
2. Run `python3 scripts/build_world.py`
3. Commit the new `worldData.json` to git
4. The new world will be used by all players
