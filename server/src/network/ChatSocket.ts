import { World } from '../World';
import { ServerOpcode, encodePacket } from '@projectrs/shared';
import type { ServerWebSocket } from 'bun';

export type ChatSocketData = { type: 'chat'; playerId?: number; accountId: number; username: string };

// Admin usernames (case-insensitive)
const ADMIN_USERS = new Set(['mogn']);

function isAdmin(username: string): boolean {
  return ADMIN_USERS.has(username.toLowerCase());
}

// Keep track of all chat sockets for broadcasting
const chatSockets: Set<ServerWebSocket<ChatSocketData>> = new Set();

export function handleChatSocketOpen(
  ws: ServerWebSocket<ChatSocketData>,
  world: World
): void {
  chatSockets.add(ws);
}

export function handleChatSocketMessage(
  ws: ServerWebSocket<ChatSocketData>,
  message: string | ArrayBuffer,
  world: World
): void {
  if (typeof message !== 'string') return;

  try {
    const data = JSON.parse(message);

    switch (data.type) {
      case 'identify': {
        ws.data.playerId = data.playerId;
        break;
      }

      case 'local': {
        const from = ws.data.username || 'Unknown';
        const msg = (data.message as string).substring(0, 200); // Cap length

        // Handle commands
        if (msg.startsWith('/')) {
          handleCommand(ws, from, msg, world);
          return;
        }

        // Broadcast to all connected chat sockets
        const payload = JSON.stringify({
          type: 'local',
          from,
          message: msg,
        });

        for (const sock of chatSockets) {
          try {
            sock.send(payload);
          } catch { /* ignore closed */ }
        }
        break;
      }
    }
  } catch {
    // Invalid JSON
  }
}

function handleCommand(
  ws: ServerWebSocket<ChatSocketData>,
  from: string,
  command: string,
  world: World
): void {
  const parts = command.split(' ');
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '/players': {
      const count = world.players.size;
      const names = Array.from(world.players.values()).map(p => p.name).join(', ');
      ws.send(JSON.stringify({
        type: 'system',
        message: `${count} player(s) online: ${names}`,
      }));
      break;
    }

    case '/msg': {
      const targetName = parts[1];
      const msg = parts.slice(2).join(' ');
      if (!targetName || !msg) {
        ws.send(JSON.stringify({ type: 'system', message: 'Usage: /msg <player> <message>' }));
        return;
      }

      // Find target player's chat socket
      let targetPlayer = null;
      for (const [, p] of world.players) {
        if (p.name.toLowerCase() === targetName.toLowerCase()) {
          targetPlayer = p;
          break;
        }
      }

      if (!targetPlayer) {
        ws.send(JSON.stringify({ type: 'system', message: `Player "${targetName}" not found.` }));
        return;
      }

      // Find their chat socket by username
      for (const sock of chatSockets) {
        if (sock.data.username.toLowerCase() === targetPlayer.name.toLowerCase()) {
          sock.send(JSON.stringify({ type: 'private', from, message: msg }));
          break;
        }
      }

      // Confirm to sender
      ws.send(JSON.stringify({ type: 'private_sent', to: targetPlayer.name, message: msg }));
      break;
    }

    case '/tp': {
      const x = parseFloat(parts[1]);
      const z = parseFloat(parts[2]);
      if (!isFinite(x) || !isFinite(z)) {
        ws.send(JSON.stringify({ type: 'system', message: 'Usage: /tp <x> <z>' }));
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (player) {
        world.teleportPlayer(player, x, z);
      }
      break;
    }

    case '/tpmap': {
      const mapId = parts[1];
      if (!mapId) {
        ws.send(JSON.stringify({ type: 'system', message: 'Usage: /tpmap <mapId>' }));
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (player) {
        const targetMap = world.getMap(mapId);
        if (!targetMap) {
          ws.send(JSON.stringify({ type: 'system', message: `Map "${mapId}" not found` }));
          return;
        }
        world.handleMapTransition(player, {
          targetMap: mapId,
          targetX: targetMap.meta.spawnPoint.x,
          targetZ: targetMap.meta.spawnPoint.z,
        });
        ws.send(JSON.stringify({ type: 'system', message: `Teleported to map "${mapId}"` }));
      }
      break;
    }

    case '/spawn': {
      const player = findPlayerByUsername(from, world);
      if (player) {
        const map = world.getMap(player.currentMapLevel);
        if (map) {
          world.teleportPlayer(player, map.meta.spawnPoint.x, map.meta.spawnPoint.z);
          ws.send(JSON.stringify({ type: 'system', message: 'Teleported to spawn' }));
        }
      }
      break;
    }

    case '/give': {
      const itemId = parseInt(parts[1]);
      const quantity = parseInt(parts[2]) || 1;
      if (!isFinite(itemId)) {
        ws.send(JSON.stringify({ type: 'system', message: 'Usage: /give <itemId> [quantity]' }));
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (player) {
        if (player.addItem(itemId, quantity, world.data.itemDefs).completed > 0) {
          world.sendInventory(player);
          ws.send(JSON.stringify({ type: 'system', message: `Gave ${quantity}x item ${itemId}` }));
        } else {
          ws.send(JSON.stringify({ type: 'system', message: 'Inventory full' }));
        }
      }
      break;
    }

    case '/clearinv': {
      const player = findPlayerByUsername(from, world);
      if (player) {
        for (let i = 0; i < player.inventory.length; i++) {
          player.inventory[i] = null;
        }
        world.sendInventory(player);
        ws.send(JSON.stringify({ type: 'system', message: 'Inventory cleared' }));
      }
      break;
    }

    case '/appearance': {
      if (!isAdmin(from)) {
        ws.send(JSON.stringify({ type: 'system', message: 'You do not have permission to use this command.' }));
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (player) {
        try {
          player.ws.sendBinary(encodePacket(ServerOpcode.SHOW_CHARACTER_CREATOR, 0));
          ws.send(JSON.stringify({ type: 'system', message: 'Opening character editor...' }));
        } catch { /* closed */ }
      }
      break;
    }

    default: {
      ws.send(JSON.stringify({ type: 'system', message: `Unknown command: ${cmd}` }));
    }
  }
}

function findPlayerByUsername(username: string, world: World) {
  for (const [, p] of world.players) {
    if (p.name.toLowerCase() === username.toLowerCase()) return p;
  }
  return null;
}

export function handleChatSocketClose(
  ws: ServerWebSocket<ChatSocketData>,
  world: World
): void {
  chatSockets.delete(ws);
}

/** Broadcast player info to all chat sockets so clients can map entityId → name */
export function broadcastPlayerInfo(entityId: number, name: string): void {
  const payload = JSON.stringify({ type: 'player_info', entityId, name });
  for (const sock of chatSockets) {
    try {
      sock.send(payload);
    } catch { /* ignore */ }
  }
}
