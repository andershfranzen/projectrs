# EvilQuest — Browser-Based MMORPG

A multiplayer browser MMORPG inspired by RuneScape Classic and HighSpell. Built with Bun, TypeScript, and Babylon.js. (Project history: ProjectRS → evilMUD → EvilQuest; root npm package is still named `projectrs`.)

## Tech Stack

- **Runtime:** Bun (server), Browser (client + editor)
- **Language:** TypeScript (strict mode, shared types between client/server)
- **3D Engine:** Babylon.js 7 (WebGL)
- **Visual Style:** Low-poly 3D terrain with mixed sprite + 3D character/object rendering
- **Networking:** Dual WebSocket — binary game protocol + JSON chat protocol
- **Persistence:** SQLite via Bun's built-in driver
- **Build:** Vite (client + editor), `bun --watch` (server)
- **Monorepo:** Bun workspaces — `shared/`, `server/`, `client/`, `editor/`, `tools/` (untracked)

## Project Structure

```
EvilQuest/
├── package.json              # Workspace root
├── shared/                   # Shared types, constants, protocol
│   ├── opcodes.ts            # Client/Server opcode enums
│   ├── constants.ts          # TICK_RATE, CHUNK_SIZE, ports
│   ├── types.ts              # ItemDef, NpcDef, MapMeta, KCMapFile, PlacedObject, etc.
│   ├── protocol.ts           # Binary packet encode/decode
│   ├── skills.ts             # XP/combat formulas, SkillId union
│   ├── appearance.ts         # Character creator config (skin/hair/outfit)
│   ├── assetObjectMap.ts     # GLB asset → ObjectDef mapping
│   └── terrain.ts            # Tile type constants
├── server/                   # Game server (Bun)
│   ├── src/
│   │   ├── main.ts           # HTTP + WS upgrade + editor API + map data endpoints
│   │   ├── World.ts          # Multi-map game loop, ticks, NPC AI, combat, transitions, doors
│   │   ├── GameMap.ts        # Tile/height storage, A* pathfinding, wall edge collision
│   │   ├── ChunkManager.ts   # Server spatial index for chunk-filtered broadcasts
│   │   ├── Database.ts       # SQLite: accounts, sessions, player_state
│   │   ├── entity/           # Entity, Player, Npc, WorldObject
│   │   ├── combat/Combat.ts  # OSRS-style hit/max/XP formulas
│   │   ├── network/          # GameSocket (binary), ChatSocket (JSON)
│   │   └── data/DataLoader.ts
│   └── data/
│       ├── items.json        # ~126 items
│       ├── npcs.json         # ~15 NPC types
│       ├── objects.json      # ~19 world object types (incl. doors, teleports, crafting)
│       └── maps/             # See "Map Storage" below
├── client/                   # Browser client (Vite + Babylon.js)
│   ├── public/
│   │   ├── Character models/ # Skinned GLBs + UAL animations
│   │   ├── assets/           # Bought packs, asset registry
│   │   ├── gear/             # Equipment GLBs
│   │   └── sprites/          # 2D sprites for NPCs/items
│   └── src/
│       ├── main.ts
│       ├── managers/         # GameManager, NetworkManager, InputManager
│       ├── rendering/        # ChunkManager (mesh build), Camera, SpriteEntity,
│       │                     # CharacterEntity (skinned + gear), Npc3DEntity, Pathfinding
│       └── ui/               # SidePanel, ChatPanel, LoginScreen, CharacterCreator,
│                             # SmithingPanel, ShopPanel, Minimap, etc.
├── editor/                   # Map editor (KC-derived, Vite, separate app on :5174)
│   ├── src/
│   │   ├── main.js, scene.js
│   │   ├── editor/Tools.js
│   │   ├── map/{MapData.js, TerrainMesh.js}
│   │   └── assets-system/    # AssetRegistry, ThumbnailRenderer, TextureRegistry
│   └── public/data           # Mirrors client assets via symlink
└── tools/                    # Untracked CLI scripts
    ├── generate-maps.ts          # Procedural underground PNG maps
    ├── import-kc-map.ts          # KC editor world → server map dir
    ├── split-glb.ts              # Split multi-asset GLB packs (refuses skinned meshes)
    ├── texture-sylora-grass-pack.ts
    ├── extract-animation.ts
    └── generate-smithing-data.ts
```

## Running

```bash
# Build client (must be run from client/)
cd client && bunx vite build

# Start server — serves built client on :4000
bun server/src/main.ts

# Dev (three terminals)
bun run dev:server   # bun --watch on server/src/main.ts
bun run dev:client   # vite :5173, proxies /ws and /api to :4000
bun run dev:editor   # vite :5174, proxies to :4000
```

Vite client often dies when the server restarts — verify both after server changes.

## Architecture

### Server-authoritative

All game state lives on the server. Client sends intentions, server validates and broadcasts. Tick rate: 600ms.

### Multi-map system

Each map is a directory under `server/data/maps/`. Two storage formats coexist:

**PNG-based** (legacy — `underground`):
- `meta.json`, `heightmap.png`, `tilemap.png`, `spawns.json`, `walls.json`

**Chunked JSON** (KC editor — `kcmap`, `the_sultans_mine`):
- `meta.json`, `map.json` (texturePlanes + structural fields, no tile/height arrays)
- `tiles/chunk_X_Z.json`, `heights/chunk_X_Z.json` — 64×64-tile chunks, default values stripped
- `objects/chunk_X_Z.json` — placed 3D models (per-chunk for streaming)
- `spawns.json`, `walls.json`, `biomes.json`
- `backups/<ISO-timestamp>/` — automatic snapshots on every save (keep last 20)

The chunked format supports **sparse maps** — chunks can be added/removed individually so non-rectangular shapes are possible.

### Chunk system

`CHUNK_SIZE=32` for runtime streaming. The editor uses a separate `EDITOR_CHUNK_SIZE=64` for tile/height storage chunks.

- **Server `ChunkManager`** — pure spatial index of entities → chunk coordinates. Filters broadcasts so each player only receives entities in their loaded chunks.
- **Client `ChunkManager`** — fetches map data via HTTP, builds Babylon meshes per chunk (ground, water, wall, floor, stair, roof). Loads/disposes dynamically as the player moves.

Client rendering must mirror the editor's `TerrainMesh.js` exactly — they share the ground rendering algorithm.

### Movement

- **Client:** A* pathfinding on click (binary heap, max 200 steps). Smooth interpolation at 1.67 tiles/sec (1 tile per 600 ms tick). Visual position is trusted; no server correction is applied to the local player.
- **Server:** Validates client paths against collision (including wall edges + door state), processes 1 unit-tile waypoint/tick (1.67 tiles/sec) — matches the client's visual cadence so adjacency-gated checks (NPC aggro, combat range) don't fire while the visual character is mid-step. Path validation expands client-compressed corner waypoints into unit tiles, so wall edges, door state, and elevation are checked at every intermediate cell.

All `findPath()` calls must pass `isWallBlocked`. Without it, the client predicts paths through thin walls — the server truncates, but the client visually walks through.

### Building system (edge walls, floors, stairs, roofs, doors)

Walls are **edge-based** (N=1, E=2, S=4, W=8 bitmask per tile), not full tile blocks. Floors are elevated platforms at arbitrary Y. Stairs are 4-step ramps with direction + base/top heights. Roofs are flat or peaked.

Doors are world objects with `category: 'door'`. Open doors clear the wall edges via `setOpenDoorEdges()`; on auto-close (~200 ticks) edges restore. Door pathfinding must bypass wall blocking when the destination IS the door (otherwise you can't path TO a closed door to interact with it).

### Biome system

8×8 tile cells with per-biome fog color + distance + ambient. Editor has a paint tool; client lerps fog toward the biome under the player each frame.

### Network protocol

- **Game socket** (`/ws/game`) — binary `Uint8Array`: `[opcode (1 byte), ...int16 values]`
- **Chat socket** (`/ws/chat`) — JSON

Opcodes in `shared/opcodes.ts`. XP values exceed int16, so skills are sent as `[skillIdx, level, currentLevel, xpHigh, xpLow]` and reconstructed as `(xpHigh << 16) | (xpLow & 0xFFFF)`.

`MAP_CHANGE` (opcode 60) is a string packet (uses `decodeStringPacket`), unlike other binary opcodes.

### Skills

12 skills total. `shared/skills.ts` is canonical:
- Combat: `accuracy`, `strength`, `defence`, `goodmagic`, `evilmagic`, `archery`, `hitpoints`
- Gathering/crafting: `forestry`, `fishing`, `cooking`, `mining`, `smithing`, `crafting`

EvilQuest splits magic into `goodmagic` and `evilmagic`. Use **canonical keys** (`goodmagic`, not `good_magic`) — the latter silently lookup-fails and returns level 1.

### Combat

OSRS formulas in `shared/skills.ts`:
- Hit chance: piecewise, attack roll vs defence roll
- Max hit: `floor(1.3 + effStr/10 + bStr/80 + effStr*bStr/640)`
- 4 stances: accurate, aggressive, defensive, controlled
- 4 XP per damage dealt; combat skills auto-award 1/3 to hitpoints

### World objects & skilling

Defined in `server/data/objects.json` (~19 types). Categories: tree, rock, fishing spot, furnace, cooking range, altar, door, teleport.

- **Harvesting:** right-click → walk adjacent → timed action → award item + XP → roll depletion → respawn timer.
- **Crafting:** interact with furnace/range → first matching recipe applied. `successChance` field (optional) gates output (e.g. iron without coal = 50%).
- **Doors:** action labels swap on toggle (`Open`/`Close`). The `WorldObject.def` field is mutable so a fresh def copy can be assigned per-instance.
- **Teleports:** PlacedObject `trigger` field overrides `def.transition` for per-instance entry coords.

### Smithing tiers

`server/data/items.json` smithing recipes are tiered:
- Bronze 1–10 → Iron 11–20 → Steel 21–30 → Mithril 31–38 → Black bronze 39–46

Generated by `tools/generate-smithing-data.ts`.

### Persistence

SQLite tables: `accounts` (Bun.password argon2id), `sessions` (24h tokens), `player_state` (position, inventory, equipment, skills, map_level). Auto-save every 15s + on map transitions.

Auth: `POST /api/signup`, `/api/login`, `/api/logout`. WebSocket upgrade requires `?token=` query param. Passwords 8–64 chars (existing accounts unaffected; only new signups validated).

## Asset pipeline

### Character / skinned GLBs

`client/public/Character models/main character.glb` — **57-joint `mixamorig:*` rig**. Originally a Polytope (Low Poly Medieval Fantasy Heroes) modular character, with bones renamed to Mixamo convention and 8 thumb bones removed. Animations are stock Mixamo FBX→GLB at `Character models/new animations/` (active folder — `Character models/animations/` is the older/dead set referenced only by `DEFAULT_PROFILE.additionalAnimations` which is bypassed at runtime).

The 32 base Mixamo bones drive animations directly. The 25 extra finger bones (Index/Middle/Ring/Pinky × 4 each side) idle in rest pose since vanilla Mixamo anims don't keyframe fingers — that's expected.

**Never run `tools/split-glb.ts` on a skinned GLB.** It refuses with an error since `prune()` strips skin bindings and turns characters into scattered vertex planes. If a future GLB script touches multiple files, exclude `Character models/` or check `doc.getRoot().listSkins().length > 0` first.

Don't script-modify Rigify rigs — control bones override deformation bone keyframes.

### Character pipeline

End-to-end customization is in `shared/appearance.ts`:

- **`PlayerAppearance`** carries 9 indices: `shirtColor`, `pantsColor`, `shoesColor`, `hairColor`, `beltColor`, `skinColor`, `shirtStyle` (currently dead — predates Polysplit), `hairStyle`, `gearColor`. Synced in PLAYER_SYNC and SET_APPEARANCE binary opcodes. `normalizeAppearance` fills missing fields so older saved JSON still loads.
- **Color recoloring** — `APPEARANCE_MATERIAL_MAP` lists which GLB material names get overridden per appearance slot. Names match case-insensitive with `.001` suffixes stripped. `Hair_1`, `Skin`, `Shirt`, `pants`, `socks`, `belt`, `mat_4550`, `shirt openings`. Handled in `CharacterEntity.applyAppearance` — only fires for non-textured materials (`if albedoColor && !hasTexture`).
- **Hair selection** — `CharacterEntity` auto-indexes any mesh prefixed `M_hair_` and disables them on load. `applyAppearance` re-enables `M_hair_${hairStyle}`. 15 hair styles (`HAIR_STYLE_COUNT = 15`); `M_hair_15` is the renamed-and-rebound original `Hair` mesh from main character.glb. Hair suppression: when a head gear is equipped, `applyAppearance` skips enabling hair so it doesn't poke through the helmet.
- **Gear color (`genericRGBMat_Objects`)** — Polytope-derived equipment uses a UV-palette texture system. The character creator picker maps `gearColor` (0–13) to one of 14 small palette PNGs in `client/public/Character models/gear-colors/`. At load time, `CharacterEntity` collects materials starting with `genericRGBMat_Objects` into `objectMaterials` and swaps their `diffuseTexture` on appearance change. Note: this currently only applies to materials on the *main character GLB* — separately-loaded gear pieces would need extra wiring.

### Animation retargeting

`CharacterEntity.loadAdditionalAnimations` re-targets each loaded animation track onto the character's skeleton by **bone name**, with two offset systems:

- **Rest-pose correction** — automatic. If a source bone's rest rotation differs from our skeleton's rest rotation, every keyframe gets transformed so the animation plays correctly on our rest. Skipped if the profile sets `skipAnimRestCorrection: true`.
- **`BONE_ROTATION_OFFSETS`** — manual constant offsets layered on top, structured as `Record<animName, Record<boneName, {x,y,z}>>` (Euler radians). Use `'*'` as anim name to apply globally. Use this to pull shoulders back, bend elbows, etc. without re-authoring the source GLB.

Animation `animName` lookup: each `additionalAnimations` entry's `animName` field is matched against animation group names *inside* the GLB. If the GLB has multiple actions, only the named one is picked up. Single-action GLBs can omit `animName`. When converting Mixamo FBX, rename the action to a clean name (e.g. `'idle'`) before exporting — Blender otherwise names it `'Armature|mixamo.com|Layer0'` which won't match the lookup.

### Loading screen

`client/src/ui/LoadingScreen.ts` covers the gap between `LOGIN_OK` and `whenReady()` so refreshes don't show the T-pose flash. Wired in `GameManager.setupAuthHandlers`. Hides automatically when the character + all 7 animation GLBs are loaded and idle starts.

### Equipment / gear

Gear lives at `client/public/assets/equipment/{slot}/{itemId}.glb`. `equipSlot` values: `weapon`, `shield`, `head`, `body`, `legs`, `feet`, `hands`, `neck`, `ring`, `cape` (`EQUIP_SLOT_NAMES` in `EquipmentConfig.ts`). Two render paths in `loadGearSmart`:

- **Skinned armor** (GLB has a skeleton): retargeted to the character's skeleton via `attachSkinnedArmor` — bone indices must match in order, and the armor's IBMs must be computed against a skeleton that has the same bone tree as the character's. The `Armature` lookup matches `Armature` or `Armature.NNN` (Blender's auto-rename suffix).
- **Bone-attached** (no skeleton): static mesh parented to a single bone with `localPosition`/`localRotation`/`scale` from `EQUIP_SLOT_BONES`. Used for helmets, weapons, shields. Supports per-item overrides in `gearOverrides` for fine-tuning fit.

**Polytope armor extraction is hard.** We tried and parked it: their character pack was authored against their own RGBRecolor shader graph and slightly different rest pose, so the meshes don't fit cleanly when bound to our 57-bone rig — gauntlets in particular create visible deformation at the wrist when idle plays. See git log for our deleted attempt.

### gltf-transform splitter

`tools/split-glb.ts` splits multi-asset GLB packs into one `.gltf` per top-level scene node, with shared-texture deduplication. Quirks: run `prune()` twice for fixed-point convergence, `setImage(empty)` to force URI serialization, give each split a unique `.bin` URI, write JSON manually so `gltf-transform` doesn't clobber shared textures.

### Asset registry

`client/public/assets/assets.json` is the canonical asset list. The texture-grass script writes it atomically (tmp + rename) so a crash mid-write can't corrupt the manifest.

## Editor save protection

The save handler in `server/src/main.ts` defends against partial-payload wipes:
- `walls`, `biomes`, `texturePlanes` — preserve from disk if absent in payload
- `placedObjects` — preserve from chunked store if payload is empty
- `tiles`, `heights` — `saveChunkedTiles` / `saveChunkedHeights` skip the stale-chunk deletion loop entirely if zero non-default chunks were written (prevents an empty/uninitialized payload from wiping all chunk files)
- Pre-save and post-save snapshots into `backups/<ISO>/`, keep the most recent 20

For a legitimate "wipe everything" (e.g. flatten a map), delete the `tiles/` or `heights/` directory manually.

## Known gotchas

- **Babylon tree-shaking:** Side-effect imports needed. `InputManager.ts` requires `import '@babylonjs/core/Culling/ray'` or `scene.pick()` breaks silently.
- **ArcRotateCamera input:** Built-in keyboard handling is removed (`removeByType('ArcRotateCameraKeyboardMoveInput')`) so it doesn't conflict with WASD. Pointer is middle-mouse only (`buttons = [1]`).
- **pngjs RGBA stride:** Even with `colorType: 2` (RGB), the buffer stride is `* 4`, alpha must be 255.
- **Bun WS binaryType:** Bun's WebSocket handler doesn't accept `binaryType` config. Messages arrive as `Buffer`; convert to `ArrayBuffer` via `.buffer.slice(0)`.
- **Vite build CWD:** `bunx vite build` must be run from `client/`, not the project root.
- **Position naming:** `position.x` = world X, `position.y` = world Z (historical naming in the protocol).
- **Entity IDs:** Players + NPCs share auto-incrementing IDs. World objects start at 10000.
- **Race on map load:** Server sends entity data before client finishes loading heightmap. `getHeight()` returns 0 when heights are null. Fix: `repositionWorldObjects()` after map load.
- **GLB `__root__` node:** Babylon's GLB loader creates a `__root__` Mesh (0 vertices) with coordinate transforms. Cloning via `instantiateHierarchy` properly copies them.
- **Transition shape divergence:** `shared/types.ts` has TWO transition types — `WorldObjectDef.transition` (no tileX/Z) and `MapTransition` (tile-anchored). Don't pass `tileX`/`tileZ` to `world.handleMapTransition()`.
- **Quaternion order:** Three.js → Babylon.js Euler conversion uses XYZ order for KC editor objects and texture planes. Null out `rotationQuaternion` to apply euler.
- **Editor rotation keys:** X/Y/Z keys map directly to X/Y/Z rotation; null out `rotationQuaternion` first.

## What's stable vs. in-flight

This section moves fast — `git log --oneline` is more authoritative. Recent areas: appearance system (skin/hair color pickers + protocol), Polysplit retirement (skeleton kept, body code removed), character animations (Mixamo native), idle pose tweaks via `BONE_ROTATION_OFFSETS`, loading screen.
