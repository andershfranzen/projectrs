# Contributing to EvilQuest

Welcome — this is a quick-start that points you at the right places. The deeper architecture lives in [CLAUDE.md](../CLAUDE.md), and animation specifics live in [animation-guide.md](animation-guide.md).

## First-time setup

See [README.md](../README.md) for installing Bun, Git, and the editor symlinks. Once `bun install` succeeds:

```bash
# In three terminals
bun run dev:server   # game server  (HTTP + ws on :4000)
bun run dev:client   # client       (vite hmr on :5173, proxies to :4000)
bun run dev:editor   # map editor   (vite hmr on :5174, proxies to :4000)
```

Open http://localhost:5173, sign up, log in. The editor lives at http://localhost:5174.

If the Vite client dies after a server restart, restart `dev:client` — it sometimes loses its proxy connection.

## How the project is laid out

| Folder | What it is |
|---|---|
| `shared/` | TypeScript types + binary protocol shared between client and server. Edit here when adding network packets, items, NPCs, or appearance fields. |
| `server/src/` | Bun game server. Tick loop in `World.ts`. Player/NPC/object entities in `entity/`. Network handlers in `network/`. |
| `server/data/` | Static game data. `items.json`, `npcs.json`, `objects.json`, plus `maps/` directories. |
| `client/src/` | Browser client. `managers/` (`GameManager`, `NetworkManager`, `InputManager`) drive the game loop. `rendering/` builds Babylon scenes. `ui/` holds DOM overlays. |
| `client/public/` | Static assets — character GLBs, animations, gear, sprites, tile textures. Vite serves these directly. |
| `editor/` | Standalone Vite app for map authoring. Talks to the dev server's `/api/maps` endpoint. |
| `tools/` | One-off CLI scripts (untracked). Map generation, GLB splitting, asset pipeline. |
| `docs/` | This folder. |

## Common tasks

### Adding a new item

1. Append to `server/data/items.json` with a fresh `id`. Set `equippable`, `equipSlot`, `stab/slash/crush/rangedDefence`, `value`, etc. — see existing items for the schema.
2. **If it's 3D gear** (visible on the character), drop `<itemId>.glb` into `client/public/assets/equipment/<equipSlot>/`. The runtime auto-resolves the path.
3. **If it's a sprite-only inventory item**, add a `sprite` field pointing at a PNG in `client/public/sprites/`.
4. Restart the server (data files aren't watched by `bun --watch`).

### Adding a new animation

See [animation-guide.md](animation-guide.md) for the OSRS-style timing pipeline. Quick version:

1. Author or download a Mixamo animation as FBX.
2. In Blender: import → rename the action to a clean name like `'idle'` or `'walk'` → export as GLB.
3. Drop the GLB in `client/public/Character models/new animations/`.
4. Reference it in `GameManager.createLocalCharacterEntity`'s `additionalAnimations` array. The `name` is the local key (matches what `getAnimNamesForState` looks for); `animName` is the matching action name inside the GLB.

If the animation needs a constant pose tweak (shoulders pulled back, etc.) without re-authoring the source, add to `BONE_ROTATION_OFFSETS` in `CharacterEntity.ts`.

### Adjusting character appearance

`shared/appearance.ts` is the source of truth. To add a new color slot or palette:

1. Add to `PlayerAppearance` interface, `DEFAULT_APPEARANCE`, `isValidAppearance`, `normalizeAppearance`.
2. If it's a color: add a `*_COLORS` palette array, register in `AppearanceColorSlot`, `APPEARANCE_MATERIAL_MAP` (which GLB material names get recolored), and `getPalette()`.
3. Wire the network protocol: `SET_APPEARANCE` decode in `server/src/network/GameSocket.ts`, encode in `client/src/managers/GameManager.openCharacterCreator`. Same for the two `PLAYER_SYNC` sites in `server/src/World.ts` and the decode in `GameManager.setupEntitySyncHandlers`.
4. Add a picker row in `client/src/ui/CharacterCreator.ts`.

The protocol is index-based, so adding a field shifts all subsequent indices — server and client must change together.

### Editing the world

Run `bun run dev:editor` and open http://localhost:5174. Pick a map, edit, save. Saves go through `/api/maps/<id>` to disk; the dev server has anti-corruption guards (snapshots in `backups/`, refuses to overwrite chunked tile files with empty payloads). For destructive flat-the-map operations, delete the relevant `tiles/` or `heights/` directory manually.

### Authoring NPCs

NPC authoring has two layers:

1. `server/data/npcs.json` defines reusable NPC types: name, stats, default look, default gear, drops, shop, and dialogue.
2. `server/data/maps/<map>/spawns.json` places those types in the world and can override only that spawn's name, position, floor, appearance, equipment, shop, dialogue, aggression, or stats.

In the editor, use **Create new NPC type** before changing shared stats, drops, shop, or dialogue for a new mob. Use **Clone spawn** when you only want another placement of the same type. The NPC panel's preflight box is authoritative for save readiness: red errors block save, yellow warnings are allowed but should be intentional. The server runs the same validation, so bad NPC IDs, duplicate spawn ids, out-of-map positions, invalid ranges/floors, malformed equipment, and unsafe bank-enabled spawns cannot be persisted by accident.

### Debugging

- Browser console first — most issues log there. Particularly `[CharacterEntity]`, `[Gear]`, `[ChunkManager]`, `[SkinnedArmor]`.
- Server logs go to wherever you ran `bun run dev:server`.
- `/give <itemId> [qty]` and `/spawn` chat commands exist on admin accounts. See `server/src/network/ChatSocket.ts` for the full list.
- Browser DevTools → Network → search for `.glb` to verify asset loads.

## Style and conventions

- **TypeScript strict** — both client and server.
- **No comments unless the why is non-obvious.** Identifier naming should carry meaning. Don't write `// loop through items` over a `for` loop.
- **Server is authoritative.** Client sends intent; server validates. Don't try to optimize by trusting client state.
- **Coordinate convention quirk:** `position.x` = world X, `position.y` = world Z (the protocol is 2D-named even though the game is 3D).
- **Don't bypass tooling for shortcuts:** if a Vite build fails, fix the underlying issue rather than skipping it.

## What to read next

- [CLAUDE.md](../CLAUDE.md) — full architecture, asset pipeline, gotchas.
- [animation-guide.md](animation-guide.md) — OSRS-style animation timing, retargeting offsets.
- [blender-gear-guide.md](blender-gear-guide.md) — authoring rigid gear (weapons, helmets, shields) in Blender, RS2 style.
- `git log --oneline` — recent context. The repo moves fast; commit messages tend to be detailed.
