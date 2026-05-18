import { World } from '../World';
import { ALL_SKILLS, type SkillId } from '@projectrs/shared';
import type { ServerWebSocket } from 'bun';

export type ChatSocketData = { type: 'chat'; playerId?: number; accountId: number; username: string; isAdmin: boolean };

function sendSystem(ws: ServerWebSocket<ChatSocketData>, message: string): void {
  ws.send(JSON.stringify({ type: 'system', message }));
}

/** Reject a command from a non-admin and notify them. Returns true if blocked.
 *  Admin status is bound at WS upgrade time from the DB (accounts.is_admin),
 *  so this is just a flag check — no per-message DB hit. */
function denyIfNotAdmin(ws: ServerWebSocket<ChatSocketData>, _from: string): boolean {
  if (ws.data.isAdmin) return false;
  sendSystem(ws, 'You do not have permission to use this command.');
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
const COMMAND_COOLDOWN_MS = 1000;
const UNSTUCK_COOLDOWN_MS = 10 * 60 * 1000;
const commandCooldowns = new Map<string, number>();
const unstuckCooldowns = new Map<number, number>();

setInterval(() => {
  const now = Date.now();
  for (const [key, last] of commandCooldowns) {
    if (now - last > COMMAND_COOLDOWN_MS * 10) commandCooldowns.delete(key);
  }
  for (const [accountId, last] of unstuckCooldowns) {
    if (now - last > UNSTUCK_COOLDOWN_MS * 2) unstuckCooldowns.delete(accountId);
  }
}, 5 * 60_000);

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

export function broadcastLocalMessage(from: string, message: string): void {
  const msg = message.substring(0, 200);
  if (!from || msg.length === 0) return;
  const payload = JSON.stringify({ type: 'local', from, message: msg });
  for (const sock of chatSockets) {
    try {
      sock.send(payload);
    } catch { /* ignore closed */ }
  }
}

export function handleChatSocketOpen(
  ws: ServerWebSocket<ChatSocketData>,
  world: World
): void {
  chatSockets.add(ws);
  // Backfill: the game socket and chat socket race at login, so addPlayer's
  // broadcastPlayerInfo loop can fire before this socket is in chatSockets.
  // Without this catch-up, the joiner shows existing remotes as "Player"
  // forever (player_info never re-sends for already-online players).
  for (const [, p] of world.players) {
    try {
      ws.send(JSON.stringify({ type: 'player_info', entityId: p.id, name: p.name }));
    } catch { /* ignore */ }
  }
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

      broadcastLocalMessage(from, msg);
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
  if (!checkCommandCooldown(ws, cmd)) return;

  switch (cmd) {
    case '/players': {
      const count = world.players.size;
      const names = Array.from(world.players.values()).map(p => p.name).join(', ');
      sendSystem(ws, `${count} player(s) online: ${names}`);
      break;
    }

    case '/msg': {
      const targetName = parts[1];
      const msg = parts.slice(2).join(' ');
      if (!targetName || !msg) {
        sendSystem(ws, 'Usage: /msg <player> <message>');
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
        sendSystem(ws, `Player "${targetName}" not found.`);
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
        sendSystem(ws, 'Usage: /tp <x> <z>');
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
        sendSystem(ws, 'Usage: /tpmap <mapId>');
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (player) {
        const targetMap = world.getMap(mapId);
        if (!targetMap) {
          sendSystem(ws, `Map "${mapId}" not found`);
          return;
        }
        world.handleMapTransition(player, {
          targetMap: mapId,
          targetX: targetMap.meta.spawnPoint.x,
          targetZ: targetMap.meta.spawnPoint.z,
        });
        sendSystem(ws, `Teleported to map "${mapId}"`);
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
          sendSystem(ws, 'Teleported to spawn');
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
        sendSystem(ws, 'Usage: /give <itemId> [quantity]');
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (player) {
        if (player.addItem(itemId, quantity, world.data.itemDefs).completed > 0) {
          world.sendInventory(player);
          sendSystem(ws, `Gave ${quantity}x item ${itemId}`);
        } else {
          sendSystem(ws, 'Inventory full');
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
        sendSystem(ws, 'Inventory cleared');
      }
      break;
    }

    case '/xp': {
      if (denyIfNotAdmin(ws, from)) return;
      const skillName = (parts[1] ?? '').toLowerCase();
      const amount = parseInt(parts[2]);
      if (!ALL_SKILLS.includes(skillName as SkillId) || !isFinite(amount) || amount <= 0) {
        sendSystem(ws, `Usage: /xp <skill> <amount>. Skills: ${ALL_SKILLS.join(', ')}`);
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (player) {
        world.grantXp(player, skillName as SkillId, amount);
        sendSystem(ws, `Granted ${amount} ${skillName} XP`);
      }
      break;
    }

    case '/appearance': {
      if (denyIfNotAdmin(ws, from)) return;
      const player = findPlayerByUsername(from, world);
      if (player) {
        world.openCharacterCreatorFor(player);
        sendSystem(ws, 'Opening character editor...');
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
        sendSystem(ws, 'Bank opened.');
      }
      break;
    }

    case '/unstuck': {
      // Open to everyone during alpha — re-gate to admin (or add a cooldown)
      // once death drops / PvP zones make a free escape exploitable.
      const targetName = (ws.data.isAdmin ? parts[1] : null) ?? from;
      const player = findPlayerByUsername(targetName, world);
      if (!player) {
        sendSystem(ws, `Player "${targetName}" not online.`);
        return;
      }
      if (!ws.data.isAdmin) {
        const combatTicksLeft = Math.max(0, player.logoutBlockedUntilTick - world.getCurrentTick());
        if (combatTicksLeft > 0) {
          ws.send(JSON.stringify({ type: 'system', message: 'You cannot use /unstuck during or immediately after combat.' }));
          return;
        }
        const last = unstuckCooldowns.get(player.accountId) ?? 0;
        const now = Date.now();
        const remaining = UNSTUCK_COOLDOWN_MS - (now - last);
        if (remaining > 0) {
          ws.send(JSON.stringify({ type: 'system', message: `You can use /unstuck again in ${formatCooldown(remaining)}.` }));
          return;
        }
        unstuckCooldowns.set(player.accountId, now);
      }
      // Abort trade first so staged items refund into inventory before any
      // teleport — matches the kickAccountIfOnline ordering.
      if (player.openInterface === 'trade') world.abortTrade(player.id, 2);
      player.openInterface = null;
      player.openShopNpcId = null;
      world.closeDialogueForPlayer(player);
      player.pendingInteraction = null;
      // teleportPlayer clears moveQueue + attackTarget + combat target.
      const map = world.getMap(player.currentMapLevel);
      world.teleportPlayer(player, map.meta.spawnPoint.x, map.meta.spawnPoint.z);
      sendSystem(ws, `Unstuck ${player.name}.`);
      if (player.name.toLowerCase() !== from.toLowerCase()) {
        sendSystemMessageToUser(player.name, 'An admin has unstuck you.');
      }
      break;
    }

    case '/kick': {
      if (denyIfNotAdmin(ws, from)) return;
      const targetName = parts[1];
      if (!targetName) {
        sendSystem(ws, 'Usage: /kick <player>');
        return;
      }
      const target = findPlayerByUsername(targetName, world);
      if (!target) {
        sendSystem(ws, `Player "${targetName}" not online.`);
        return;
      }
      world.kickAccountIfOnline(target.accountId);
      sendSystem(ws, `Kicked ${target.name}.`);
      break;
    }

    case '/ban': {
      if (denyIfNotAdmin(ws, from)) return;
      const targetName = parts[1];
      if (!targetName) {
        sendSystem(ws, 'Usage: /ban <player> [reason]');
        return;
      }
      const reason = parts.slice(2).join(' ').slice(0, 200);
      // Resolve via DB rather than the online player list so we can ban
      // offline accounts too.
      const accountId = world.db.getAccountIdByUsername(targetName);
      if (accountId == null) {
        sendSystem(ws, `Account "${targetName}" not found.`);
        return;
      }
      world.db.banAccount(accountId, reason, from);
      // Kick if currently online so the ban takes effect immediately.
      world.kickAccountIfOnline(accountId);
      sendSystem(ws, `Banned ${targetName}${reason ? ` — ${reason}` : ''}.`);
      break;
    }

    case '/unban': {
      if (denyIfNotAdmin(ws, from)) return;
      const targetName = parts[1];
      if (!targetName) {
        sendSystem(ws, 'Usage: /unban <player>');
        return;
      }
      const accountId = world.db.getAccountIdByUsername(targetName);
      if (accountId == null) {
        sendSystem(ws, `Account "${targetName}" not found.`);
        return;
      }
      const removed = world.db.unbanAccount(accountId);
      sendSystem(ws, removed ? `Unbanned ${targetName}.` : `${targetName} was not banned.`);
      break;
    }

    case '/ipban': {
      if (denyIfNotAdmin(ws, from)) return;
      const arg = parts[1];
      if (!arg) {
        sendSystem(ws, 'Usage: /ipban <player|ip> [reason]');
        return;
      }
      const reason = parts.slice(2).join(' ').slice(0, 200);
      // IP-shaped: hex/digits with a dot (v4) or colon (v6). Permissive so
      // it matches whatever the WS-upgrade check sees (zone IDs, mapped v6).
      let ip: string | null = null;
      let label = arg;
      if (/^[0-9a-fA-F:.]+$/.test(arg) && (arg.includes('.') || arg.includes(':'))) {
        ip = arg;
      } else {
        const accountId = world.db.getAccountIdByUsername(arg);
        if (accountId == null) {
          sendSystem(ws, `Account "${arg}" not found and "${arg}" is not a valid IP.`);
          return;
        }
        ip = world.db.getLatestIpForAccount(accountId);
        if (!ip) {
          sendSystem(ws, `No login history for "${arg}" — nothing to ban.`);
          return;
        }
        label = `${arg} (${ip})`;
        // ipban alone doesn't disconnect them (they're past the upgrade check).
        world.kickAccountIfOnline(accountId);
      }
      world.db.banIp(ip, reason, from);
      sendSystem(ws, `IP-banned ${label}${reason ? ` — ${reason}` : ''}.`);
      break;
    }

    case '/unipban': {
      if (denyIfNotAdmin(ws, from)) return;
      const ip = parts[1];
      if (!ip) {
        sendSystem(ws, 'Usage: /unipban <ip>');
        return;
      }
      const removed = world.db.unbanIp(ip);
      sendSystem(ws, removed ? `IP ${ip} unbanned.` : `${ip} was not banned.`);
      break;
    }

    case '/banlist': {
      if (denyIfNotAdmin(ws, from)) return;
      const MAX = 50;
      const accountBans = world.db.listAccountBans();
      const ipBans = world.db.listIpBans();
      const lines: string[] = [];
      lines.push(`Account bans (${accountBans.length}):`);
      for (const b of accountBans.slice(0, MAX)) {
        lines.push(`  ${b.username} — ${b.reason || '(no reason)'} [by ${b.bannedBy || '?'}]`);
      }
      if (accountBans.length > MAX) lines.push(`  ... and ${accountBans.length - MAX} more`);
      lines.push(`IP bans (${ipBans.length}):`);
      for (const b of ipBans.slice(0, MAX)) {
        lines.push(`  ${b.ip} — ${b.reason || '(no reason)'} [by ${b.bannedBy || '?'}]`);
      }
      if (ipBans.length > MAX) lines.push(`  ... and ${ipBans.length - MAX} more`);
      sendSystem(ws, lines.join('\n'));
      break;
    }

    case '/trade': {
      // Available to all players: send a trade request by username while we
      // don't yet have a right-click-on-player UI. Server still enforces
      // adjacency, interface-locks, and all the trade FSM rules.
      const targetName = parts[1];
      if (!targetName) {
        sendSystem(ws, 'Usage: /trade <player>');
        return;
      }
      const requester = findPlayerByUsername(from, world);
      const target = findPlayerByUsername(targetName, world);
      if (!requester) return;
      if (!target) {
        sendSystem(ws, `Player "${targetName}" not online.`);
        return;
      }
      world.handleTradeRequest(requester.id, target.id);
      break;
    }

    default: {
      sendSystem(ws, `Unknown command: ${cmd}`);
    }
  }
}

function checkCommandCooldown(ws: ServerWebSocket<ChatSocketData>, cmd: string): boolean {
  if (ws.data.isAdmin) return true;
  const now = Date.now();
  const key = `${ws.data.accountId}:${cmd}`;
  const last = commandCooldowns.get(key) ?? 0;
  const remaining = COMMAND_COOLDOWN_MS - (now - last);
  if (remaining > 0) {
    ws.send(JSON.stringify({ type: 'system', message: `Slow down. Try again in ${Math.ceil(remaining / 1000)}s.` }));
    return false;
  }
  commandCooldowns.set(key, now);
  return true;
}

function formatCooldown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
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
