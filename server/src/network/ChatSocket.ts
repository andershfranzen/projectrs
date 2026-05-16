import { World } from '../World';
import { ServerOpcode, encodePacket, ALL_SKILLS, type SkillId } from '@projectrs/shared';
import type { ServerWebSocket } from 'bun';

export type ChatSocketData = { type: 'chat'; playerId?: number; accountId: number; username: string; isAdmin: boolean };

/** Reject a command from a non-admin and notify them. Returns true if blocked.
 *  Admin status is bound at WS upgrade time from the DB (accounts.is_admin),
 *  so this is just a flag check — no per-message DB hit. */
function denyIfNotAdmin(ws: ServerWebSocket<ChatSocketData>, _from: string): boolean {
  if (ws.data.isAdmin) return false;
  ws.send(JSON.stringify({ type: 'system', message: 'You do not have permission to use this command.' }));
  return true;
}

// Keep track of all chat sockets for broadcasting
const chatSockets: Set<ServerWebSocket<ChatSocketData>> = new Set();

// --- Per-socket rate limit ---
// Game socket has its own rate limit (Player.checkRateLimit, 30/sec). Chat
// gets a tighter cap because every message fans out to every connected client.
// Token-bucket style: 5 messages per 3-second window. Slow drip is fine,
// bursts are clamped.
const CHAT_RL_MAX = 5;
const CHAT_RL_WINDOW_MS = 3000;
const chatRateState = new WeakMap<ServerWebSocket<ChatSocketData>, { count: number; windowStart: number }>();

function checkChatRate(ws: ServerWebSocket<ChatSocketData>): boolean {
  const now = Date.now();
  let state = chatRateState.get(ws);
  if (!state || now - state.windowStart > CHAT_RL_WINDOW_MS) {
    state = { count: 0, windowStart: now };
    chatRateState.set(ws, state);
  }
  state.count++;
  return state.count <= CHAT_RL_MAX;
}

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
  // Hard length cap — reject garbage early before parsing.
  if (message.length > 4096) return;
  // Per-socket rate limit (5 msgs / 3s). Applies to ALL chat traffic
  // including identify/commands so a flooder can't burn CPU on JSON.parse.
  if (!checkChatRate(ws)) return;

  let data: unknown;
  try {
    data = JSON.parse(message);
  } catch { return; }
  if (typeof data !== 'object' || data === null) return;
  const d = data as { type?: unknown; message?: unknown };

  switch (d.type) {
    case 'identify': {
      // The username is bound to the auth token at WS upgrade time
      // (ws.data.username). The client-supplied playerId field used to be
      // trusted here — that was a footgun. We now resolve playerId
      // server-side from the username so a client can't claim someone
      // else's entity.
      const player = findPlayerByUsername(ws.data.username, world);
      if (player) ws.data.playerId = player.id;
      break;
    }

    case 'local': {
      if (typeof d.message !== 'string') return;
      const from = ws.data.username || 'Unknown';
      const msg = d.message.substring(0, 200); // Cap length
      if (msg.length === 0) return;

      // Handle commands
      if (msg.startsWith('/')) {
        handleCommand(ws, from, msg, world);
        return;
      }

      // Bot-detection signal: actual chat message (not commands). Bots almost
      // never chat; a session with zero messages over 2+ active hours is a
      // strong flag.
      const speaker = ws.data.playerId != null ? world.getPlayer(ws.data.playerId) : null;
      speaker?.botStats?.recordChat();

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
      if (denyIfNotAdmin(ws, from)) return;
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
      if (denyIfNotAdmin(ws, from)) return;
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
      if (denyIfNotAdmin(ws, from)) return;
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
      if (denyIfNotAdmin(ws, from)) return;
      const itemId = parseInt(parts[1]);
      const rawQty = parseInt(parts[2]);
      // Clamp to [1, MAX_STACK]. parseInt can return huge numbers (e.g.
      // `/give 1 9999999999`) which propagate into the inventory cap logic.
      // MAX_STACK matches the bank-protocol encoding (2^31-1).
      const MAX_STACK = 0x7FFFFFFF;
      const quantity = (!isFinite(rawQty) || rawQty < 1) ? 1 : Math.min(rawQty, MAX_STACK);
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
      if (denyIfNotAdmin(ws, from)) return;
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

    case '/xp': {
      if (denyIfNotAdmin(ws, from)) return;
      const skillName = (parts[1] ?? '').toLowerCase();
      const amount = parseInt(parts[2]);
      if (!ALL_SKILLS.includes(skillName as SkillId) || !isFinite(amount) || amount <= 0) {
        ws.send(JSON.stringify({
          type: 'system',
          message: `Usage: /xp <skill> <amount>. Skills: ${ALL_SKILLS.join(', ')}`,
        }));
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (player) {
        world.grantXp(player, skillName as SkillId, amount);
        ws.send(JSON.stringify({ type: 'system', message: `Granted ${amount} ${skillName} XP` }));
      }
      break;
    }

    case '/appearance': {
      if (denyIfNotAdmin(ws, from)) return;
      const player = findPlayerByUsername(from, world);
      if (player) {
        try {
          player.ws.sendBinary(encodePacket(ServerOpcode.SHOW_CHARACTER_CREATOR, 0));
          ws.send(JSON.stringify({ type: 'system', message: 'Opening character editor...' }));
        } catch { /* closed */ }
      }
      break;
    }

    case '/bank': {
      // Test hook for the bank UI until the banker NPC ships. Admin-only so
      // regular players can't bypass having to walk to a bank.
      if (denyIfNotAdmin(ws, from)) return;
      const player = findPlayerByUsername(from, world);
      if (player) {
        world.openBankFor(player);
        ws.send(JSON.stringify({ type: 'system', message: 'Bank opened.' }));
      }
      break;
    }

    case '/trade': {
      // Available to all players: send a trade request by username while we
      // don't yet have a right-click-on-player UI. Server still enforces
      // adjacency, interface-locks, and all the trade FSM rules.
      const targetName = parts[1];
      if (!targetName) {
        ws.send(JSON.stringify({ type: 'system', message: 'Usage: /trade <player>' }));
        return;
      }
      const requester = findPlayerByUsername(from, world);
      const target = findPlayerByUsername(targetName, world);
      if (!requester) return;
      if (!target) {
        ws.send(JSON.stringify({ type: 'system', message: `Player "${targetName}" not online.` }));
        return;
      }
      world.handleTradeRequest(requester.id, target.id);
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

/** Send a system message to a specific player by username, via their chat socket.
 *  Used by World.sendChatSystem so server-side errors (inventory full, trade
 *  range, etc.) actually reach the player's chat panel. Silently no-ops if the
 *  player isn't currently connected to the chat socket. */
export function sendSystemMessageToUser(username: string, message: string): void {
  const lc = username.toLowerCase();
  const payload = JSON.stringify({ type: 'system', message });
  for (const sock of chatSockets) {
    if (sock.data.username.toLowerCase() === lc) {
      try { sock.send(payload); } catch { /* ignore */ }
      return;
    }
  }
}
