# evilMUD

A multiplayer browser MMORPG inspired by RuneScape Classic. Built with Bun, TypeScript, and Babylon.js.

## Features

- **3D World:** Chunk-streamed terrain with heightmap elevation, vertex-colored tiles, variable-height walls, roofs, floors, stairs, and linear fog
- **Building System:** Edge-based thin walls, elevated floor platforms, 4-step stair ramps, flat and peaked roofs — all configurable per tile
- **Multiplayer:** Server-authoritative with dual WebSocket protocol (binary game + JSON chat)
- **Persistence:** SQLite saves player position, inventory, skills, and map level
- **Map Editor:** Full-featured visual editor with tools for tiles, heights, walls, floors, stairs, roofs, NPC/object placement, undo/redo, copy/paste, export/import

## Tech Stack

- **Server:** Bun + TypeScript
- **Client:** Vite + Babylon.js 7 (WebGL)
- **Editor:** Vite + TypeScript (2D canvas-based map editor)
- **3D Style:** Low-poly terrain with 2D billboard sprites + 3D models (GLB)
- **Protocol:** Binary WebSocket (opcode + int16 values)
- **Maps:** Two formats coexist — PNG-based (legacy `underground`) and chunked JSON (KC editor — `kcmap`, `the_sultans_mine`)

## Windows Setup

### 1. Install Bun

Open PowerShell and run:

```powershell
irm bun.sh/install.ps1 | iex
```

Close and reopen your terminal, then verify:

```powershell
bun --version
```

If `bun` is not recognized, add it to your PATH manually:
- Press `Win + R`, type `sysdm.cpl`, go to **Advanced > Environment Variables**
- Under **User variables**, edit `Path` and add `%USERPROFILE%\.bun\bin`
- Restart your terminal

### 2. Install Git

Download from https://git-scm.com/download/win and install with default settings.

### 3. Clone and Install

```powershell
git clone git@github.com:Project-KC/Project-KC-EvilQuest.git
cd Project-KC-EvilQuest
bun install
```

### 4. Editor Symlinks (Windows only)

The editor shares assets with the client via symlinks. On Windows you need **Developer Mode** enabled:

1. Open **Settings > Update & Security > For developers**
2. Enable **Developer Mode**
3. Re-run `bun install` or manually create the symlink:

```powershell
mklink /D editor\public\data client\public\assets
```

## Quick Start

```bash
# Build client
cd client && bunx vite build && cd ..

# Start server (serves built client on :4000)
bun server/src/main.ts

# Open http://localhost:4000
```

### Development (hot reload)

Open three separate terminals in the project root:

```bash
# Terminal 1: Server
bun run dev:server

# Terminal 2: Client (vite dev server on :5173, proxies /ws and /api to :4000)
bun run dev:client

# Terminal 3: Editor (vite dev server on :5174)
bun run dev:editor
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `bun: command not found` | Add `%USERPROFILE%\.bun\bin` to your PATH, restart terminal |
| Blank screen after server restart | Refresh the browser or restart `bun run dev:client` |
| Port 4000 already in use | `netstat -ano \| findstr :4000` then `taskkill /PID <pid> /F` |
| SQLite errors | Make sure only one server instance is running |

## Building System

Buildings are defined in `walls.json` per map using an edge-based wall system:

- **Walls:** 4-bit bitmask per tile (N/E/S/W edges) with configurable height per tile
- **Floors:** Elevated walkable platforms at any Y height, rendered with edge faces
- **Stairs:** 4-step ramps connecting height levels, with configurable direction (N/E/S/W)
- **Roofs:** Flat or peaked (N-S or E-W ridge), rendered at configurable height

Player height automatically follows floors and interpolates along stairs via `getEffectiveHeight()`.

## Project Structure

```
evilMUD/
├── shared/          # Types, opcodes, protocol, skills, constants
├── server/          # Bun game server
│   ├── src/         # World, GameMap, entities, combat, networking
│   └── data/        # items.json, npcs.json, objects.json, maps/
├── client/          # Babylon.js browser client
│   └── src/         # Managers, rendering (ChunkManager), UI
├── editor/          # Map editor (2D canvas)
│   └── src/         # Tools, canvas renderers, state management
└── tools/           # Map generation script
```

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation, [docs/contributing.md](docs/contributing.md) for a contributor onboarding guide, [docs/animation-guide.md](docs/animation-guide.md) for the OSRS-style animation pipeline, and [docs/blender-gear-guide.md](docs/blender-gear-guide.md) for authoring RS2-style gear in Blender.
