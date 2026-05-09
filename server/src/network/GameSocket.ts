import { ClientOpcode, ServerOpcode, decodePacket, encodePacket, isValidAppearance, type PlayerAppearance } from '@projectrs/shared';
import { World } from '../World';
import { Player } from '../entity/Player';
import type { ServerWebSocket } from 'bun';

export type GameSocketData = { type: 'game'; playerId?: number; accountId: number; username: string };

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
  const spawnX = saved ? saved.x : defaultSpawn.x;
  const spawnZ = saved ? saved.z : defaultSpawn.z;
  console.log(`[GameSocket] Player "${username}" acct=${accountId} saved=${!!saved} savedPos=(${saved?.x}, ${saved?.z}) defaultSpawn=(${defaultSpawn.x}, ${defaultSpawn.z}) final=(${spawnX}, ${spawnZ})`);

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
    player.currentMapLevel = mapLevel; // use validated mapLevel, not raw saved value
    player.currentFloor = saved.floor;
    player.syncHealthFromSkills();
  }

  ws.data.playerId = player.id;
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

  const { opcode, values } = decodePacket(message);
  const playerId = ws.data.playerId;
  if (!playerId) return;

  // Rate limit: drop excessive messages to prevent spam/abuse
  const player = world.getPlayer(playerId);
  if (player && !player.checkRateLimit()) return;

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
        gearColor:  values[7] ?? 0,
      };
      world.handleSetAppearance(playerId, appearance);
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
