import { ClientOpcode, ServerOpcode, decodePacket, encodePacket, isValidAppearance, type PlayerAppearance } from '@projectrs/shared';
import { World } from '../World';
import { Player } from '../entity/Player';
import { WORLD_RESPAWN_VERSION } from '../Database';
import type { ServerWebSocket } from 'bun';

export type GameSocketData = { type: 'game'; playerId?: number; accountId: number; username: string; isAdmin: boolean; ip: string; deviceId: string };

export function handleGameSocketOpen(
  ws: ServerWebSocket<GameSocketData>,
  world: World
): void {
  const { accountId, username } = ws.data;

  // Kick existing session for same account (prevent duplicate logins)
  world.kickAccountIfOnline(accountId);

  // Load saved state or use defaults
  const saved = world.db.loadPlayerState(accountId);

  // Use saved position, or map spawn point for new players
  let mapLevel = saved?.mapLevel ?? 'kcmap';
  // Fallback to kcmap if saved map no longer exists
  try { world.getMap(mapLevel); } catch { mapLevel = 'kcmap'; }
  const map = world.getMap(mapLevel);
  const defaultSpawn = map.findSpawnPoint();
  // One-time forced respawn: any saved row stamped with an older respawn
  // version gets relocated to the current map spawn on this login. After
  // relocation, we bump the row's version so subsequent logins keep their
  // (newly saved) position. Skills/inventory/bank are preserved.
  const needsForcedRespawn = !!saved && (saved.respawnVersion ?? 0) < WORLD_RESPAWN_VERSION;
  // Sanitize saved coordinates: a corrupted DB row (or malicious migration) can
  // hold any number, including NaN, negative values, or values past the map
  // bounds. Without validation, such a row would respawn the player far off-map
  // where chunk loaders silently fail.
  const savedX = saved?.x;
  const savedZ = saved?.z;
  const savedXValid = typeof savedX === 'number' && isFinite(savedX) && savedX >= 0 && savedX < map.width;
  const savedZValid = typeof savedZ === 'number' && isFinite(savedZ) && savedZ >= 0 && savedZ < map.height;
  const useSavedPos = saved && savedXValid && savedZValid && !needsForcedRespawn;
  const spawnX = useSavedPos ? savedX! : defaultSpawn.x;
  const spawnZ = useSavedPos ? savedZ! : defaultSpawn.z;
  if (needsForcedRespawn) {
    world.db.markRespawnVersion(accountId, WORLD_RESPAWN_VERSION);
  }
  console.log(`[GameSocket] Player "${username}" acct=${accountId} saved=${!!saved} savedPos=(${saved?.x}, ${saved?.z}) defaultSpawn=(${defaultSpawn.x}, ${defaultSpawn.z}) final=(${spawnX}, ${spawnZ})${needsForcedRespawn ? ' [respawn-version migration]' : ''}`);

  const player = new Player(username, spawnX, spawnZ, ws, accountId);

  // Apply saved state
  if (saved) {
    player.skills = saved.skills;
    // Pad saved inventory to 28 slots
    const inv = saved.inventory;
    while (inv.length < 30) inv.push(null);
    player.inventory = inv;
    player.equipment = saved.equipment;
    player.stance = saved.stance;
    player.appearance = saved.appearance;
    // Pad bank to BANK_SIZE — older saves may have a shorter or empty array
    const bank = saved.bank;
    while (bank.length < player.bank.length) bank.push(null);
    player.bank = bank.slice(0, player.bank.length);
    player.currentMapLevel = mapLevel; // use validated mapLevel, not raw saved value
    // Clamp floor to the supported range. A corrupted DB row could carry a
    // floor of 99 or NaN — both would defeat the floor recovery loop below
    // (which only iterates 0..3) and leave the player suspended above ground.
    const savedFloor = saved.floor;
    player.currentFloor = (typeof savedFloor === 'number' && isFinite(savedFloor))
      ? Math.max(0, Math.min(3, Math.floor(savedFloor)))
      : 0;
    player.reportedY = saved.y; // restore visual height for spawn
    player.syncHealthFromSkills();
    // Forced-respawn migration: drop floor + reportedY so the player lands
    // cleanly on ground at the new spawn. Without this, a player saved on
    // an upper floor of a building gets relocated to the new spawn tile
    // but stays on the old floor index / Y, which the recovery loop below
    // only patches up if the old floor happens to be blocked there.
    if (needsForcedRespawn) {
      player.currentFloor = 0;
      player.reportedY = 0;
    }

    // Unstick recovery. Two cases:
    //   1) Saved floor is BLOCKED at the saved tile — try other floors,
    //      fall back to default spawn if none work. Triggered by old bugs
    //      that corrupted player.currentFloor.
    //   2) Saved floor > 0 but floor 0 is also walkable at the saved tile.
    //      Downgrade to floor 0 — this catches players whose floor was
    //      corrupted to 1+ by the (now-removed) stair-mirror bug while
    //      they were on an elevated-floor-0 building tile. Genuine
    //      upper-floor maps have walls/blocks on floor 0 below, so the
    //      downgrade only triggers in the corrupt-state case.
    const tx = Math.floor(player.position.x);
    const tz = Math.floor(player.position.y);
    if (map.isTileBlockedOnFloor(tx, tz, player.currentFloor)) {
      let recovered = false;
      for (const f of [0, 1, 2, 3]) {
        if (f !== player.currentFloor && !map.isTileBlockedOnFloor(tx, tz, f)) {
          console.log(`[GameSocket] Recovering "${username}": saved floor ${player.currentFloor} blocked at (${tx},${tz}), switching to floor ${f}`);
          player.currentFloor = f;
          recovered = true;
          break;
        }
      }
      if (!recovered) {
        console.log(`[GameSocket] Recovering "${username}": saved tile (${tx},${tz}) blocked on all floors, respawning at default`);
        player.position.x = defaultSpawn.x;
        player.position.y = defaultSpawn.z;
        player.currentFloor = 0;
      }
    } else if (player.currentFloor > 0 && !map.isTileBlockedOnFloor(tx, tz, 0)) {
      console.log(`[GameSocket] Downgrading "${username}" from floor ${player.currentFloor} → 0 (floor 0 walkable at saved tile, corrupted upper-floor state)`);
      player.currentFloor = 0;
    }
  }

  ws.data.playerId = player.id;
  player.ip = ws.data.ip;
  player.deviceId = ws.data.deviceId;
  world.addPlayer(player);

  // If the saved floor isn't ground level, tell the client so it positions
  // the local player on the right floor instead of dangling above ground 0.
  if (player.currentFloor !== 0) {
    try {
      player.ws.sendBinary(encodePacket(ServerOpcode.FLOOR_CHANGE, player.currentFloor));
    } catch { /* closed */ }
  }

  // If no appearance set, tell client to show character creator
  if (!player.appearance) {
    try {
      player.ws.sendBinary(encodePacket(ServerOpcode.SHOW_CHARACTER_CREATOR, 0));
    } catch { /* closed */ }
  }
}

export function handleGameSocketMessage(
  ws: ServerWebSocket<GameSocketData>,
  message: ArrayBuffer | string,
  world: World
): void {
  if (typeof message === 'string') return;

  // Rate limit BEFORE parsing so a malformed-packet flood costs the attacker
  // their rate budget. Without this, garbage frames are caught by the try/catch
  // below without consuming any budget, letting an attacker burn CPU on decode.
  const playerId = ws.data.playerId;
  if (!playerId) return;
  const player = world.getPlayer(playerId);
  if (player && !player.checkRateLimit()) return;

  // Empty / malformed frames blow up decodePacket (view.getUint8(0) RangeError
  // on a 0-byte buffer). Bun's WS layer usually rejects empty frames but a
  // hostile client can still ship junk. Catch + close instead of crashing the
  // entire message handler. Logs at warn so we notice if it's a regular thing.
  let opcode: number;
  let values: number[];
  try {
    ({ opcode, values } = decodePacket(message));
  } catch (e) {
    console.warn(`[ws] malformed packet from playerId=${ws.data.playerId ?? '?'}: ${e instanceof Error ? e.message : e}`);
    try { ws.close(1003, 'malformed packet'); } catch {}
    return;
  }

  switch (opcode) {
    case ClientOpcode.PLAYER_MOVE: {
      const pathLength = values[0];
      const path: { x: number; z: number }[] = [];
      for (let i = 0; i < pathLength && (1 + i * 2 + 1) < values.length; i++) {
        path.push({
          x: values[1 + i * 2] / 10,
          z: values[1 + i * 2 + 1] / 10,
        });
      }
      world.handlePlayerMove(playerId, path);
      break;
    }

    case ClientOpcode.PLAYER_ATTACK_NPC: {
      const npcEntityId = values[0];
      world.handlePlayerAttackNpc(playerId, npcEntityId);
      break;
    }

    case ClientOpcode.PLAYER_PICKUP_ITEM: {
      const groundItemId = values[0];
      world.handlePlayerPickup(playerId, groundItemId);
      break;
    }

    case ClientOpcode.PLAYER_DROP_ITEM: {
      const slot = values[0];
      const expectedItemId = values[1];
      world.handlePlayerDrop(playerId, slot, expectedItemId);
      break;
    }

    case ClientOpcode.PLAYER_EQUIP_ITEM: {
      const slot = values[0];
      const expectedItemId = values[1];
      world.handlePlayerEquip(playerId, slot, expectedItemId);
      break;
    }

    case ClientOpcode.PLAYER_UNEQUIP_ITEM: {
      const equipSlot = values[0];
      world.handlePlayerUnequip(playerId, equipSlot);
      break;
    }

    case ClientOpcode.PLAYER_EAT_ITEM: {
      const slot = values[0];
      const expectedItemId = values[1];
      world.handlePlayerEat(playerId, slot, expectedItemId);
      break;
    }

    case ClientOpcode.PLAYER_SET_STANCE: {
      const stanceIdx = values[0];
      world.handlePlayerSetStance(playerId, stanceIdx);
      break;
    }

    case ClientOpcode.PLAYER_INTERACT_OBJECT: {
      const objectEntityId = values[0];
      const actionIndex = values[1] ?? 0;
      const recipeIndex = values[2] ?? -1;
      world.handlePlayerInteractObject(playerId, objectEntityId, actionIndex, recipeIndex);
      break;
    }

    case ClientOpcode.PLAYER_TALK_NPC: {
      const npcEntityId = values[0];
      world.handlePlayerTalkNpc(playerId, npcEntityId);
      break;
    }

    case ClientOpcode.DIALOGUE_CHOOSE: {
      const npcEntityId = values[0];
      const optionIndex = values[1];
      world.handleDialogueChoose(playerId, npcEntityId, optionIndex);
      break;
    }

    case ClientOpcode.PLAYER_BUY_ITEM: {
      const itemId = values[0];
      const quantity = values[1] ?? 1;
      world.handlePlayerBuyItem(playerId, itemId, quantity);
      break;
    }

    case ClientOpcode.PLAYER_SELL_ITEM: {
      const slot = values[0];
      const quantity = values[1] ?? 1;
      const expectedItemId = values[2];
      world.handlePlayerSellItem(playerId, slot, quantity, expectedItemId);
      break;
    }

    case ClientOpcode.PLAYER_MOVE_INV_ITEM: {
      const fromSlot = values[0];
      const toSlot = values[1];
      const expectedItemId = values[2];
      world.handlePlayerMoveInvItem(playerId, fromSlot, toSlot, expectedItemId);
      break;
    }

    // CLIENT_FLOOR_HINT removed — was a security hole. A malicious client
    // could spoof any floor at any tile that happened to be walkable on
    // multiple floors, bypassing legitimate stair gating. Floor changes are
    // now server-authoritative (see World.tickTransitions) — they fire only
    // when the player walks onto a placed stair GLB whose registration
    // (GameMap.ts) mirrors the top tile across both connecting floors.

    case ClientOpcode.CLIENT_POSITION_Y: {
      // Pure metadata. Stored for persistence so an elevated-tile spawn
      // restores at the right height. Y has no game-logic effect, but clamp
      // to a plausible range so a malicious client can't stash absurd values
      // that propagate to logs/saves and bite some future feature that
      // assumes a sane Y range.
      const player = world.getPlayer(playerId);
      if (player) {
        const raw = (values[0] ?? 0) / 10;
        player.reportedY = Math.max(-2, Math.min(20, raw));
      }
      break;
    }

    case ClientOpcode.MAP_READY: {
      world.handleMapReady(playerId);
      break;
    }

    case ClientOpcode.SET_APPEARANCE: {
      const appearance: PlayerAppearance = {
        shirtColor: values[0] ?? 0,
        pantsColor: values[1] ?? 0,
        shoesColor: values[2] ?? 0,
        hairColor:  values[3] ?? 0,
        beltColor:  values[4] ?? 0,
        skinColor:  values[5] ?? 0,
        hairStyle:  values[6] ?? 1,
      };
      world.handleSetAppearance(playerId, appearance);
      break;
    }

    case ClientOpcode.BANK_REQUEST_OPEN: {
      world.handleBankOpenRequest(playerId);
      break;
    }
    case ClientOpcode.BANK_DEPOSIT: {
      const slot = values[0];
      const expectedItemId = values[1];
      const quantity = values[2] ?? 1;
      world.handleBankDeposit(playerId, slot, expectedItemId, quantity);
      break;
    }
    case ClientOpcode.BANK_WITHDRAW: {
      const bankSlot = values[0];
      const expectedItemId = values[1];
      const quantity = values[2] ?? 1;
      world.handleBankWithdraw(playerId, bankSlot, expectedItemId, quantity);
      break;
    }
    case ClientOpcode.BANK_CLOSE: {
      world.handleBankClose(playerId);
      break;
    }

    case ClientOpcode.TRADE_REQUEST: {
      const targetEntityId = values[0];
      world.handleTradeRequest(playerId, targetEntityId);
      break;
    }
    case ClientOpcode.TRADE_ACCEPT_REQUEST: {
      const requesterEntityId = values[0];
      world.handleTradeAcceptRequest(playerId, requesterEntityId);
      break;
    }
    case ClientOpcode.TRADE_DECLINE: {
      world.handleTradeDecline(playerId);
      break;
    }
    case ClientOpcode.TRADE_OFFER_ITEM: {
      const slot = values[0];
      const expectedItemId = values[1];
      const quantity = values[2] ?? 1;
      world.handleTradeOfferItem(playerId, slot, expectedItemId, quantity);
      break;
    }
    case ClientOpcode.TRADE_REMOVE_OFFERED: {
      const offerSlot = values[0];
      const expectedItemId = values[1];
      const quantity = values[2] ?? 1;
      world.handleTradeRemoveOffered(playerId, offerSlot, expectedItemId, quantity);
      break;
    }
    case ClientOpcode.TRADE_ACCEPT: {
      world.handleTradeAccept(playerId);
      break;
    }

    default:
      console.log(`Unknown game opcode: ${opcode}`);
  }
}

export function handleGameSocketClose(
  ws: ServerWebSocket<GameSocketData>,
  world: World
): void {
  const playerId = ws.data.playerId;
  if (playerId) {
    // Saves + removes, OR defers removal if the player is in a post-combat
    // logout block. See World.handlePlayerDisconnect.
    world.handlePlayerDisconnect(playerId);
  }
}
