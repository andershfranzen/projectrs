# Pre-alpha smoke checklist

Quick-pass to catch regressions before pushing a build to alpha. Run after server
restarts or sweeping changes (combat, inventory, movement, gear, rendering).
Golden path takes ~5 min; full pass ~15 min.

## Golden path — single client

- [ ] **Login** with an existing account → loading screen → spawn (no T-pose flash)
- [ ] **Walk** click 8+ tiles away → smooth pathfinding, no rubber-banding, no console errors
- [ ] **Attack an NPC** (e.g. cow, rat) → hitsplats appear, NPC HP drops, kill awards XP + drops
- [ ] **Pick up the drop** → appears in inventory
- [ ] **Equip / unequip** the dropped item → 3D model appears/disappears on character; pants/sleeves hide for body/legs
- [ ] **Drop an item** from inventory → ground item visible to self
- [ ] **Open a door** → door rotates open, you walk through; closes itself after ~2 min (or skip if short on time)
- [ ] **Map transition** (underground stair / cave entrance) → loads new map, character repositions, no entity stuck
- [ ] **Multi-floor stairs** (kcmap → climb to upper floor) → camera height adjusts, walls/floors render correctly
- [ ] **Logout** cleanly via UI → returns to login screen

## Skilling sanity (5 min)

- [ ] **Woodcut** a tree → log appears, tree depletes with respawn timer
- [ ] **Mine** a copper + tin rock → ores → **smelt** at furnace → bronze bar → **smith** at anvil → bronze item
- [ ] **Fish** at a spot, **cook** raw fish at range — cooked output matches expected XP

## Multiplayer (2 clients)

> Use **different browser profiles or one regular + one incognito** — same browser shares cookies and will kick the other tab. See `feedback_multi_client_testing.md`.

- [ ] Both players see each other walking (smooth, not teleporting between tiles)
- [ ] Equip a body item on client A → client B sees the gear within ~1 tick
- [ ] Drop an item on client A → client B sees it on the ground
- [ ] Attack NPC together → both see hitsplats, kill credit goes to the right player

## Security spot-checks

> Most of these are hard to manually trigger races — just confirm the visible-effect items.

- [ ] **Auth rate limit:** wrong-password 6 times in a row → 6th should be refused with 429-style message
- [ ] **2H + shield swap with full inventory:** equip a shield, fill remaining slots, try to equip a 2H weapon → refuses with "You need a free inventory slot..." chat line (does NOT duplicate the shield)
- [ ] **Logout during combat:** start hitting an NPC, close the browser tab → reconnect within ~30s → not auto-kicked, can resume
- [ ] **Wall-walk** (manual): try to click a tile beyond a wall → server clips path at the wall, doesn't teleport you across

## Render / asset

- [ ] **No console errors** at startup or first scene load (warnings are ok; reds aren't)
- [ ] **Bronze Plate Mail Legs (id 70)** equips, pants hide, mesh skinned to character — recent regression
- [ ] **Run `bun tools/audit-equipment-glb.ts`** — should report 0 broken before any alpha build
- [ ] **Door auto-close** at the original spawn area still works (regression-prone — see commit 975f592)

## After-test artifact check

- [ ] `server/data/` — any backup directories under `maps/*/backups/` that look unintentional?
- [ ] `git status` — no spurious file changes from the test (e.g. accidental commits via admin tools)
