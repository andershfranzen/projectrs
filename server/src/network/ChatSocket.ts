import { World } from '../World';
import { ALL_SKILLS, MAX_SKILL_LEVEL, MAX_SKILL_XP, SKILL_NAMES, normalizeSkillId, type QuestDef, type SkillId } from '@projectrs/shared';
import type { ServerWebSocket } from 'bun';
import type { GameEventLogInput, SocialEntry, SocialListKind, SocialLists } from '../Database';
import type { Player } from '../entity/Player';

export type ChatSocketData = { type: 'chat'; playerId?: number; accountId: number; username: string; isAdmin: boolean; isModerator: boolean };

function sendSystem(ws: ServerWebSocket<ChatSocketData>, message: string): void {
  ws.send(JSON.stringify({ type: 'system', message }));
}

function recordGameEvent(world: World, input: GameEventLogInput): void {
  const db = (world as { db?: { recordGameEvent?: (event: GameEventLogInput) => unknown } }).db;
  const recorder = db?.recordGameEvent;
  if (typeof recorder === 'function') recorder.call(db, input);
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
const chatSocketsByUsername: Map<string, ServerWebSocket<ChatSocketData>> = new Map();
const chatSocketsByAccountId: Map<number, ServerWebSocket<ChatSocketData>> = new Map();
const ignoredAccountIdsByAccountId: Map<number, Set<number>> = new Map();
const playerInfoStaffByEntityId: Map<number, boolean> = new Map();

// A chat socket buffering more than this much undrained data is effectively dead;
// closing it stops Bun's outbound buffer from growing unbounded (OOM guard).
const MAX_CHAT_BACKPRESSURE_BYTES = 2 * (1 << 20); // 2 MiB

/** Send to a chat socket, dropping+closing it if its outbound buffer is backed up. */
function chatSend(sock: ServerWebSocket<ChatSocketData>, payload: string): void {
  try {
    if (sock.getBufferedAmount() > MAX_CHAT_BACKPRESSURE_BYTES) {
      sock.close(1011, 'backpressure');
      return;
    }
    sock.send(payload);
  } catch { /* ignore closed */ }
}

function parseSkillId(raw: string): SkillId | null {
  const normalized = raw.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized === 'ranging') return 'archery';
  const legacy = normalizeSkillId(normalized);
  if (legacy) return legacy;
  for (const skill of ALL_SKILLS) {
    if (skill.toLowerCase() === raw.toLowerCase() || SKILL_NAMES[skill].toLowerCase().replace(/[\s_-]+/g, '') === normalized) {
      return skill;
    }
  }
  return null;
}

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
const UNSTUCK_TARGET_MAP = 'kcmap';
const DEFAULT_MUTE_DURATION_SECONDS = 60 * 60;
const MAX_MUTE_DURATION_SECONDS = 366 * 24 * 60 * 60;
const AUTO_SCRAMBLE_CHAT_PATTERN = /(?:^|[^a-z0-9])(?:niggers?|faggots?|trann(?:y|ies))(?=$|[^a-z0-9])/i;
const MUTED_CHAT_ADJECTIVES = [
  'wobbly', 'sparkly', 'dramatic', 'tiny', 'soggy', 'polite', 'mysterious', 'crunchy',
  'fancy', 'sleepy', 'suspicious', 'velvet', 'baffled', 'shiny', 'leftover', 'heroic',
  'mithril', 'banknote', 'altar-blessed', 'muddy', 'questy', 'rune-polished', 'sultan-approved',
];
const MUTED_CHAT_NOUNS = [
  'spoon', 'pancake', 'mailbox', 'teapot', 'pickle', 'sock', 'noodle', 'button',
  'waffle', 'cactus', 'turnip', 'doorknob', 'cupcake', 'lampshade', 'muffin', 'biscuit',
];
const MUTED_CHAT_GAME_NOUNS = [
  'goblin', 'banker', 'monk', 'relic', 'pickaxe', 'anvil', 'carpet', 'lobster',
  'rune', 'skeleton', 'cow', 'tree', 'ore', 'chest', 'ladder', 'fishing spot',
];
const MUTED_CHAT_VERBS = [
  'juggles', 'audits', 'tickles', 'polishes', 'misplaces', 'summons', 'folds', 'questions',
  'balances', 'launches', 'befriends', 'reboots', 'measures', 'argues', 'decorates', 'reheats',
  'banks', 'smiths', 'mines', 'fishes', 'chops', 'teleports', 'prays', 'examines',
  'high-alchs', 'respawns', 'pathfinds', 'auto-closes',
];
const MUTED_CHAT_ADVERBS = [
  'boldly', 'quietly', 'sideways', 'politely', 'wildly', 'almost', 'briefly', 'probably',
  'northwest', 'underground', 'aggressively', 'defensively', 'suspiciously',
];
const MUTED_CHAT_OBJECTS = [
  'moon cheese', 'pocket thunder', 'invisible soup', 'accordion dust', 'bubble paperwork',
  'waffle logic', 'velvet confetti', 'pickle math', 'noodle weather', 'emergency glitter',
];
const MUTED_CHAT_GAME_OBJECTS = [
  'tier 3 relic', 'black bronze spoon', 'mithril pancake', 'Brother Monk key',
  'bank booth receipt', 'Sultan mine dust', 'goodmagic paperwork', 'evilmagic noodles',
  'walk-here carpet', 'knife on a table', 'fishing bubble soup', 'door edge logic',
];
const MUTED_CHAT_PLACES = [
  'the bank', 'Aldous', 'the Sultan mine', 'the altar', 'the cooking range',
  'the anvil', 'the fishing bubbles', 'the ladder tile', 'the carpet room',
];
const MUTED_CHAT_GAME_SENTINELS = [
  ...MUTED_CHAT_GAME_NOUNS,
  ...MUTED_CHAT_GAME_OBJECTS,
  ...MUTED_CHAT_PLACES,
];
const MUTED_CHAT_ALL_NOUNS = [...MUTED_CHAT_NOUNS, ...MUTED_CHAT_GAME_NOUNS];
const MUTED_CHAT_ALL_OBJECTS = [...MUTED_CHAT_OBJECTS, ...MUTED_CHAT_GAME_OBJECTS];
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

function isSocialListKind(value: unknown): value is SocialListKind {
  return value === 'friends' || value === 'ignore';
}

function isStaffData(data: Pick<ChatSocketData, 'isAdmin' | 'isModerator'>): boolean {
  return data.isAdmin === true || data.isModerator === true;
}

function isStaffPlayer(player: Pick<Player, 'isAdmin' | 'isModerator'>): boolean {
  return player.isAdmin === true || player.isModerator === true;
}

function canReceiveStaffPresence(sock: ServerWebSocket<ChatSocketData>, subjectIsStaff: boolean): boolean {
  return !subjectIsStaff || isStaffData(sock.data);
}

function rememberPlayerInfoRole(entityId: number, subjectIsStaff: boolean): void {
  playerInfoStaffByEntityId.set(entityId, subjectIsStaff);
}

function knownPlayerInfoStaffStatus(entityId: number, name: string): boolean | undefined {
  const cached = playerInfoStaffByEntityId.get(entityId);
  if (cached !== undefined) return cached;

  const namedSock = chatSocketsByUsername.get(name.toLowerCase());
  if (namedSock) {
    const subjectIsStaff = isStaffData(namedSock.data);
    rememberPlayerInfoRole(entityId, subjectIsStaff);
    return subjectIsStaff;
  }

  return undefined;
}

function entryWithPresenceFor(
  ws: ServerWebSocket<ChatSocketData>,
  entry: SocialEntry,
): SocialEntry & { online: boolean } {
  const targetSocket = chatSocketsByAccountId.get(entry.accountId);
  return {
    ...entry,
    online: !!targetSocket && canReceiveStaffPresence(ws, isStaffData(targetSocket.data)),
  };
}

function refreshSocialCache(accountId: number, world: World): SocialLists {
  const lists = world.db.listSocialRelations(accountId);
  ignoredAccountIdsByAccountId.set(accountId, new Set(lists.ignore.map(entry => entry.accountId)));
  return lists;
}

function sendSocialList(ws: ServerWebSocket<ChatSocketData>, world: World): void {
  const lists = refreshSocialCache(ws.data.accountId, world);
  ws.send(JSON.stringify({
    type: 'social_list',
    friends: lists.friends.map(entry => entryWithPresenceFor(ws, entry)),
    ignore: lists.ignore.map(entry => entryWithPresenceFor(ws, entry)),
  }));
}

function preparePlayerForAdminTeleport(player: Player, world: World): void {
  if (player.openInterface === 'trade') world.abortTrade(player.id, 2);
  player.openInterface = null;
  player.openShopNpcId = null;
  player.openShopNpcEntityId = null;
  world.closeDialogueForPlayer(player);
  player.pendingInteraction = null;
}

export function adminTeleportPlayerToPlayer(world: World, traveler: Player, destination: Player): void {
  preparePlayerForAdminTeleport(traveler, world);
  if (traveler.currentMapLevel === destination.currentMapLevel) {
    world.teleportPlayer(
      traveler,
      destination.position.x,
      destination.position.y,
      destination.effectiveY,
      destination.currentFloor,
    );
    return;
  }

  world.handleMapTransition(traveler, {
    targetMap: destination.currentMapLevel,
    targetX: destination.position.x,
    targetZ: destination.position.y,
    targetFloor: destination.currentFloor,
    targetY: destination.effectiveY,
  });
}

function sendSocialPresence(accountId: number, username: string, online: boolean, subjectIsStaff: boolean = false): void {
  const payload = JSON.stringify({ type: 'social_presence', accountId, username, online });
  for (const sock of chatSockets) {
    if (!canReceiveStaffPresence(sock, subjectIsStaff)) continue;
    chatSend(sock, payload);
  }
}

function sendPrivateMessage(
  ws: ServerWebSocket<ChatSocketData>,
  targetName: string,
  rawMessage: string,
  world: World,
): void {
  const msg = rawMessage.trim().slice(0, 200);
  if (!msg) return;
  const mute = world.db.isAccountMuted(ws.data.accountId);
  if (mute) {
    sendMutedPrivateMessage(ws, targetName, msg, world);
    return;
  }
  const normalizedTarget = targetName.trim();
  if (!normalizedTarget) {
    sendSystem(ws, 'Choose a player to message.');
    return;
  }

  const targetAccountId = world.db.getAccountIdByUsername(normalizedTarget);
  if (targetAccountId == null) {
    sendSystem(ws, `No account named "${normalizedTarget}" found.`);
    return;
  }
  const targetUsername = world.db.getUsernameByAccountId(targetAccountId) ?? normalizedTarget;
  if (targetAccountId === ws.data.accountId) {
    sendSystem(ws, 'You cannot send a private message to yourself.');
    return;
  }
  if (world.db.isIgnoring(ws.data.accountId, targetAccountId)) {
    sendSystem(ws, `Remove ${targetUsername} from your ignore list before messaging them.`);
    return;
  }
  if (world.db.isIgnoring(targetAccountId, ws.data.accountId)) {
    sendSystem(ws, `${targetUsername} is not accepting private messages from you.`);
    return;
  }

  const targetSocket = chatSocketsByAccountId.get(targetAccountId);
  if (!targetSocket) {
    sendSystem(ws, `${targetUsername} is not online.`);
    return;
  }

  const autoScrambled = shouldAutoScrambleMessage(msg);
  const targetMessage = autoScrambled ? randomMutedMessage(msg, world) : msg;
  const speaker = ws.data.playerId != null ? world.getPlayer(ws.data.playerId) : null;
  speaker?.botStats?.recordChat();
  if (ws.data.playerId != null) world.recordPlayerActivity(ws.data.playerId);

  try {
    targetSocket.send(JSON.stringify({
      type: 'private',
      from: ws.data.username,
      fromAccountId: ws.data.accountId,
      message: targetMessage,
    }));
  } catch {
    sendSystem(ws, `${targetUsername} is not online.`);
    return;
  }
  try {
    ws.send(JSON.stringify({
      type: 'private_sent',
      to: targetUsername,
      toAccountId: targetAccountId,
      message: msg,
    }));
  } catch { /* sender socket is closing */ }
  recordGameEvent(world, {
    type: 'private_chat',
    message: `${ws.data.username} privately messaged ${targetUsername}: ${msg}`,
    actorAccountId: ws.data.accountId,
    actorName: ws.data.username,
    targetAccountId,
    targetName: targetUsername,
    mapLevel: speaker?.currentMapLevel ?? null,
    floor: speaker?.currentFloor ?? null,
    x: speaker?.position.x ?? null,
    z: speaker?.position.y ?? null,
    details: {
      channel: 'private',
      message: msg,
      fromPlayerId: speaker?.id ?? null,
      autoScrambled,
    },
  });
}

function localChatPayload(from: string, message: string, fromAccountId?: number): string {
  return JSON.stringify({ type: 'local', from, fromAccountId, message });
}

function sendLocalEchoToAccount(accountId: number, from: string, message: string): void {
  const payload = localChatPayload(from, message, accountId);
  for (const sock of chatSockets) {
    if (sock.data.accountId === accountId) {
      chatSend(sock, payload);
    }
  }
}

export function broadcastLocalMessage(from: string, message: string, fromAccountId?: number): void {
  const msg = message.substring(0, 1000);
  if (!from || msg.length === 0) return;
  const payload = localChatPayload(from, msg, fromAccountId);
  broadcastLocalPayload(payload, fromAccountId);
}

function broadcastLocalPayload(payload: string, fromAccountId?: number, excludeAccountId?: number): void {
  for (const sock of chatSockets) {
    if (excludeAccountId != null && sock.data.accountId === excludeAccountId) {
      continue;
    }
    if (fromAccountId != null && ignoredAccountIdsByAccountId.get(sock.data.accountId)?.has(fromAccountId)) {
      continue;
    }
    chatSend(sock, payload);
  }
}

function sendMutedLocalMessage(ws: ServerWebSocket<ChatSocketData>, from: string, message: string, world: World): void {
  const original = message.substring(0, 1000);
  const scrambled = randomMutedMessage(original, world);
  sendLocalEchoToAccount(ws.data.accountId, from, original);
  broadcastLocalPayload(
    localChatPayload(from, scrambled, ws.data.accountId),
    ws.data.accountId,
    ws.data.accountId,
  );
}

function sendMutedPrivateMessage(
  ws: ServerWebSocket<ChatSocketData>,
  targetName: string,
  message: string,
  world: World,
): void {
  const normalizedTarget = targetName.trim();
  if (!normalizedTarget) {
    sendSystem(ws, 'Choose a player to message.');
    return;
  }

  const targetAccountId = world.db.getAccountIdByUsername(normalizedTarget);
  const targetUsername = targetAccountId == null
    ? normalizedTarget
    : world.db.getUsernameByAccountId(targetAccountId) ?? normalizedTarget;

  try {
    ws.send(JSON.stringify({
      type: 'private_sent',
      to: targetUsername,
      toAccountId: targetAccountId ?? undefined,
      message,
    }));
  } catch { /* sender socket is closing */ }

  if (targetAccountId == null || targetAccountId === ws.data.accountId) return;
  if (world.db.isIgnoring(ws.data.accountId, targetAccountId)) return;
  if (world.db.isIgnoring(targetAccountId, ws.data.accountId)) return;

  const targetSocket = chatSocketsByAccountId.get(targetAccountId);
  if (!targetSocket) return;
  try {
    targetSocket.send(JSON.stringify({
      type: 'private',
      from: ws.data.username,
      fromAccountId: ws.data.accountId,
      message: randomMutedMessage(message, world),
    }));
  } catch { /* target socket is closing */ }
}

function shouldAutoScrambleMessage(message: string): boolean {
  return AUTO_SCRAMBLE_CHAT_PATTERN.test(message.normalize('NFKC'));
}

function randomMutedMessage(message: string, world?: World): string {
  const words = message.trim().split(/\s+/).filter(Boolean);
  const fallbackCount = Math.max(1, Math.ceil(message.trim().length / 8));
  const count = Math.max(3, Math.min(14, words.length || fallbackCount));
  const rng = seededMutedChatRng(`${message}:${Date.now()}:${Math.random()}`);
  const pick = (list: string[]): string => list[Math.floor(rng() * list.length)] ?? list[0] ?? 'waffle';
  const emojiTokens = mutedDiscordEmojiTokens(world);
  const maybeEmoji = (): string[] => emojiTokens.length > 0 && rng() < 0.28 ? [pick(emojiTokens)] : [];
  const patterns: Array<() => string[]> = [
    () => [pick(MUTED_CHAT_ADJECTIVES), pick(MUTED_CHAT_ALL_NOUNS), pick(MUTED_CHAT_VERBS), pick(MUTED_CHAT_ALL_OBJECTS), ...maybeEmoji()],
    () => [pick(MUTED_CHAT_ADVERBS), pick(MUTED_CHAT_ADJECTIVES), pick(MUTED_CHAT_ALL_NOUNS), pick(MUTED_CHAT_VERBS), pick(MUTED_CHAT_PLACES), ...maybeEmoji()],
    () => [pick(MUTED_CHAT_ALL_NOUNS), pick(MUTED_CHAT_VERBS), pick(MUTED_CHAT_ADJECTIVES), pick(MUTED_CHAT_ALL_OBJECTS), ...maybeEmoji()],
    () => [pick(MUTED_CHAT_ADJECTIVES), pick(MUTED_CHAT_ALL_NOUNS), 'with', pick(MUTED_CHAT_ADJECTIVES), pick(MUTED_CHAT_ALL_NOUNS), 'near', pick(MUTED_CHAT_PLACES)],
    () => ['absolutely', pick(MUTED_CHAT_ADVERBS), pick(MUTED_CHAT_VERBS), pick(MUTED_CHAT_ALL_OBJECTS), ...maybeEmoji()],
  ];

  const output: string[] = [];
  while (output.length < count) {
    output.push(...patterns[Math.floor(rng() * patterns.length)]());
  }
  const result = output.slice(0, count);
  if (!containsMutedGameTerm(result)) {
    result[Math.floor(rng() * result.length)] = pick(MUTED_CHAT_GAME_SENTINELS);
  }
  if (emojiTokens.length > 0 && !result.some(isDiscordEmojiToken)) {
    if (result.length >= 14) result[result.length - 1] = pick(emojiTokens);
    else result.push(pick(emojiTokens));
  }
  return result.join(' ');
}

function mutedDiscordEmojiTokens(world?: World): string[] {
  const db = world?.db as { listForumDiscordEmojis?: () => Array<{ name: string; available?: boolean }> } | undefined;
  const listEmojis = db?.listForumDiscordEmojis;
  if (typeof listEmojis !== 'function') return [];
  try {
    return listEmojis.call(db)
      .map((emoji) => discordEmojiTokenForName(emoji.available === false ? '' : emoji.name))
      .filter((token): token is string => token !== null)
      .slice(0, 80);
  } catch {
    return [];
  }
}

function discordEmojiTokenForName(name: string): string | null {
  const trimmed = name.trim();
  if (!/^[a-z0-9_-]{1,64}$/i.test(trimmed)) return null;
  return `:${trimmed}:`;
}

function isDiscordEmojiToken(value: string): boolean {
  return /^:[a-z0-9_-]{1,64}:$/i.test(value);
}

function containsMutedGameTerm(tokens: string[]): boolean {
  const lowered = tokens.join(' ').toLowerCase();
  return MUTED_CHAT_GAME_SENTINELS.some(term => lowered.includes(term.toLowerCase()));
}

function seededMutedChatRng(seedText: string): () => number {
  let seed = 0x811c9dc5;
  for (let i = 0; i < seedText.length; i++) {
    seed ^= seedText.charCodeAt(i);
    seed = Math.imul(seed, 0x01000193);
  }
  return () => {
    seed += 0x6d2b79f5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function handleChatSocketOpen(
  ws: ServerWebSocket<ChatSocketData>,
  world: World
): void {
  chatSockets.add(ws);
  chatSocketsByUsername.set(ws.data.username.toLowerCase(), ws);
  chatSocketsByAccountId.set(ws.data.accountId, ws);
  // Backfill: the game socket and chat socket race at login, so addPlayer's
  // broadcastPlayerInfo loop can fire before this socket is in chatSockets.
  // Without this catch-up, the joiner shows existing remotes as "Player"
  // forever (player_info never re-sends for already-online players).
  for (const [, p] of world.players) {
    try {
      const subjectIsStaff = isStaffPlayer(p);
      rememberPlayerInfoRole(p.id, subjectIsStaff);
      if (!canReceiveStaffPresence(ws, subjectIsStaff)) continue;
      ws.send(JSON.stringify({ type: 'player_info', entityId: p.id, name: p.name }));
    } catch { /* ignore */ }
  }
  sendSocialList(ws, world);
  sendSocialPresence(ws.data.accountId, ws.data.username, true, isStaffData(ws.data));
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
  const d = data as { type?: unknown; message?: unknown; to?: unknown; name?: unknown; list?: unknown };

  switch (d.type) {
    case 'identify': {
      // The username is bound to the auth token at WS upgrade time
      // (ws.data.username). The client-supplied playerId field used to be
      // trusted here — that was a footgun. We now resolve playerId
      // server-side from the username so a client can't claim someone
      // else's entity.
      const player = findPlayerByUsername(ws.data.username, world);
      if (player) {
        ws.data.playerId = player.id;
        const subjectIsStaff = isStaffData(ws.data) || isStaffPlayer(player);
        rememberPlayerInfoRole(player.id, subjectIsStaff);
        broadcastPlayerInfo(player.id, player.name);
      }
      break;
    }

    case 'local': {
      if (typeof d.message !== 'string') return;
      const from = ws.data.username || 'Unknown';
      const msg = d.message.substring(0, 200); // Cap length
      if (msg.length === 0) return;
      if (ws.data.playerId != null) world.recordPlayerActivity(ws.data.playerId);

      // Handle commands
      if (msg.startsWith('/')) {
        const player = ws.data.playerId != null ? world.getPlayer(ws.data.playerId) : null;
        recordGameEvent(world, {
          type: 'chat_command',
          severity: ws.data.isAdmin ? 'notable' : 'info',
          message: `${from} used command ${msg.split(/\s+/)[0]}`,
          actorAccountId: ws.data.accountId,
          actorName: from,
          mapLevel: player?.currentMapLevel ?? null,
          floor: player?.currentFloor ?? null,
          x: player?.position.x ?? null,
          z: player?.position.y ?? null,
          details: {
            command: msg,
            isAdmin: ws.data.isAdmin,
            isModerator: ws.data.isModerator,
          },
        });
        handleCommand(ws, from, msg, world);
        return;
      }

      const mute = world.db.isAccountMuted(ws.data.accountId);
      if (mute || shouldAutoScrambleMessage(msg)) {
        sendMutedLocalMessage(ws, from, msg, world);
        return;
      }

      // Bot-detection signal: actual chat message (not commands). Bots almost
      // never chat; a session with zero messages over 2+ active hours is a
      // strong flag.
      const speaker = ws.data.playerId != null ? world.getPlayer(ws.data.playerId) : null;
      speaker?.botStats?.recordChat();

      broadcastLocalMessage(from, msg, ws.data.accountId);
      recordGameEvent(world, {
        type: 'chat',
        message: `${from}: ${msg}`,
        actorAccountId: ws.data.accountId,
        actorName: from,
        mapLevel: speaker?.currentMapLevel ?? null,
        floor: speaker?.currentFloor ?? null,
        x: speaker?.position.x ?? null,
        z: speaker?.position.y ?? null,
        details: {
          channel: 'local',
          message: msg,
          playerId: speaker?.id ?? null,
          isAdmin: ws.data.isAdmin,
          isModerator: ws.data.isModerator,
        },
      });
      break;
    }

    case 'private': {
      if (typeof d.to !== 'string' || typeof d.message !== 'string') return;
      sendPrivateMessage(ws, d.to, d.message, world);
      break;
    }

    case 'social_add': {
      if (!isSocialListKind(d.list) || typeof d.name !== 'string') return;
      const result = world.db.addSocialRelation(ws.data.accountId, d.name, d.list);
      if (!result.ok) {
        sendSystem(ws, result.error);
        return;
      }
      sendSystem(ws, `${result.entry.username} added to your ${d.list === 'friends' ? 'friends' : 'ignore'} list.`);
      sendSocialList(ws, world);
      break;
    }

    case 'social_remove': {
      if (!isSocialListKind(d.list) || typeof d.name !== 'string') return;
      const result = world.db.removeSocialRelation(ws.data.accountId, d.name, d.list);
      if (!result.ok) {
        sendSystem(ws, result.error);
        return;
      }
      sendSocialList(ws, world);
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
      const visiblePlayers = Array.from(world.players.values())
        .filter(p => canReceiveStaffPresence(ws, isStaffPlayer(p)));
      const count = visiblePlayers.length;
      const names = visiblePlayers.map(p => p.name).join(', ');
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
      sendPrivateMessage(ws, targetName, msg, world);
      break;
    }

    case '/tp': {
      if (denyIfNotAdmin(ws, from)) return;
      const x = parseFloat(parts[1]);
      const z = parseFloat(parts[2]);
      if (!isFinite(x) || !isFinite(z)) {
        sendSystem(ws, 'Usage: /tp <x> <z> [floor]');
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (player) {
        const floor = parts[3] !== undefined ? parseInt(parts[3], 10) : 0;
        if (!Number.isFinite(floor) || floor < 0) {
          sendSystem(ws, 'Usage: /tp <x> <z> [floor]');
          return;
        }
        preparePlayerForAdminTeleport(player, world);
        world.teleportPlayer(player, x, z, undefined, floor);
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
        preparePlayerForAdminTeleport(player, world);
        world.handleMapTransition(player, {
          targetMap: mapId,
          targetX: targetMap.meta.spawnPoint.x,
          targetZ: targetMap.meta.spawnPoint.z,
        });
        sendSystem(ws, `Teleported to map "${mapId}"`);
      }
      break;
    }

    case '/tpto':
    case '/teleportto': {
      if (denyIfNotAdmin(ws, from)) return;
      const targetName = parts.slice(1).join(' ').trim();
      if (!targetName) {
        sendSystem(ws, 'Usage: /tpto <player>');
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (!player) {
        sendSystem(ws, 'You are not online.');
        return;
      }
      const target = findPlayerByUsername(targetName, world);
      if (!target) {
        sendSystem(ws, `Player "${targetName}" not online.`);
        return;
      }
      adminTeleportPlayerToPlayer(world, player, target);
      sendSystem(ws, `Teleported to ${target.name}.`);
      break;
    }

    case '/summon':
    case '/bring': {
      if (denyIfNotAdmin(ws, from)) return;
      const targetName = parts.slice(1).join(' ').trim();
      if (!targetName) {
        sendSystem(ws, 'Usage: /summon <player>');
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (!player) {
        sendSystem(ws, 'You are not online.');
        return;
      }
      const target = findPlayerByUsername(targetName, world);
      if (!target) {
        sendSystem(ws, `Player "${targetName}" not online.`);
        return;
      }
      if (target.id === player.id) {
        sendSystem(ws, 'You cannot summon yourself.');
        return;
      }
      adminTeleportPlayerToPlayer(world, target, player);
      sendSystem(ws, `Summoned ${target.name}.`);
      sendSystemMessageToUser(target.name, `Admin ${player.name} summoned you.`);
      break;
    }

    case '/spawn': {
      if (denyIfNotAdmin(ws, from)) return;
      const player = findPlayerByUsername(from, world);
      if (player) {
        const rawTarget = (parts[1] ?? '').trim();
        const targetMapId = rawTarget === 'here' || rawTarget === 'current'
          ? player.currentMapLevel
          : rawTarget || 'kcmap';
        const map = world.getMap(targetMapId);
        if (map) {
          preparePlayerForAdminTeleport(player, world);
          if (targetMapId === player.currentMapLevel) {
            world.teleportPlayer(player, map.meta.spawnPoint.x, map.meta.spawnPoint.z, undefined, 0);
          } else {
            world.handleMapTransition(player, {
              targetMap: targetMapId,
              targetX: map.meta.spawnPoint.x,
              targetZ: map.meta.spawnPoint.z,
              targetFloor: 0,
            });
          }
          sendSystem(ws, `Teleported to ${targetMapId} spawn`);
        } else {
          sendSystem(ws, `Map "${targetMapId}" not found`);
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
      const skillId = parseSkillId(parts[1] ?? '');
      const amount = parseInt(parts[2]);
      if (!skillId || !isFinite(amount) || amount <= 0) {
        sendSystem(ws, `Usage: /xp <skill> <amount>. Skills: ${ALL_SKILLS.map(id => SKILL_NAMES[id]).join(', ')}`);
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (player) {
        world.grantXp(player, skillId, amount);
        sendSystem(ws, `Granted ${amount} ${SKILL_NAMES[skillId]} XP`);
      }
      break;
    }

    case '/setlevel': {
      if (denyIfNotAdmin(ws, from)) return;
      const skillId = parseSkillId(parts[1] ?? '');
      const level = Number(parts[2]);
      if (!skillId || !Number.isInteger(level) || level < 1 || level > MAX_SKILL_LEVEL) {
        sendSystem(ws, `Usage: /setlevel <skill> <level 1-${MAX_SKILL_LEVEL}>. Skills: ${ALL_SKILLS.map(id => SKILL_NAMES[id]).join(', ')}`);
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (!player) {
        sendSystem(ws, 'You are not online.');
        return;
      }
      const result = world.setPlayerSkillLevel(player, skillId, level);
      sendSystem(ws, `Set ${SKILL_NAMES[skillId]} to level ${result.level} (${result.xp} XP).`);
      break;
    }

    case '/setxp': {
      if (denyIfNotAdmin(ws, from)) return;
      const skillId = parseSkillId(parts[1] ?? '');
      const xp = Number(parts[2]);
      if (!skillId || !Number.isInteger(xp) || xp < 0 || xp > MAX_SKILL_XP) {
        sendSystem(ws, `Usage: /setxp <skill> <xp 0-${MAX_SKILL_XP}>. Skills: ${ALL_SKILLS.map(id => SKILL_NAMES[id]).join(', ')}`);
        return;
      }
      const player = findPlayerByUsername(from, world);
      if (!player) {
        sendSystem(ws, 'You are not online.');
        return;
      }
      const result = world.setPlayerSkillXp(player, skillId, xp);
      sendSystem(ws, `Set ${SKILL_NAMES[skillId]} to ${result.xp} XP (level ${result.level}).`);
      break;
    }

    case '/max': {
      if (denyIfNotAdmin(ws, from)) return;
      const player = findPlayerByUsername(from, world);
      if (!player) {
        sendSystem(ws, 'You are not online.');
        return;
      }
      world.maxPlayerStats(player);
      sendSystem(ws, `All stats maxed to ${MAX_SKILL_LEVEL}.`);
      break;
    }

    case '/simulatebigdrop': {
      if (denyIfNotAdmin(ws, from)) return;
      const player = findPlayerByUsername(from, world);
      if (!player) {
        sendSystem(ws, 'You are not online.');
        return;
      }
      const total = world.simulateBigXpDrop(player);
      sendSystem(ws, `Simulated a ${total} XP popup without changing your skills.`);
      break;
    }

    case '/testlvlgfx': {
      if (denyIfNotAdmin(ws, from)) return;
      const player = findPlayerByUsername(from, world);
      if (!player) {
        sendSystem(ws, 'You are not online.');
        return;
      }
      world.triggerLevelUpEffect(player);
      sendSystem(ws, 'Triggered level-up gfx.');
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

    case '/copygeartonpc':
    case '/copyplayergeartonpc':
    case '/equipnpc': {
      if (denyIfNotAdmin(ws, from)) return;
      const player = findPlayerByUsername(from, world);
      if (!player) {
        sendSystem(ws, 'Player not online.');
        return;
      }
      const result = world.copyPlayerGearToNearestNpcSpawn(player);
      sendSystem(ws, result.message);
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

    case '/testtrade': {
      if (denyIfNotAdmin(ws, from)) return;
      const player = findPlayerByUsername(from, world);
      if (!player) {
        sendSystem(ws, 'You must be logged in to test trade.');
        return;
      }
      world.openTestTradeFor(player);
      sendSystem(ws, 'Test trade opened.');
      break;
    }

    case '/queststart':
    case '/qstart': {
      if (denyIfNotAdmin(ws, from)) return;
      const parsed = parseQuestAdminCommand(parts, from, world);
      if (!parsed) {
        sendSystem(ws, 'Usage: /queststart <quest id or name> [player]');
        return;
      }
      const target = findPlayerByUsername(parsed.targetName, world);
      if (!target) {
        sendSystem(ws, `Player "${parsed.targetName}" not online.`);
        return;
      }
      if (!world.startQuestForAdmin(target, parsed.quest.id)) {
        sendSystem(ws, `Could not start quest "${parsed.quest.name}".`);
        return;
      }
      sendSystem(ws, `Started "${parsed.quest.name}" for ${target.name}.`);
      sendSystemMessageToUser(target.name, `Admin started quest: ${parsed.quest.name}.`);
      break;
    }

    case '/questreset':
    case '/qreset': {
      if (denyIfNotAdmin(ws, from)) return;
      const parsed = parseQuestAdminCommand(parts, from, world);
      if (!parsed) {
        sendSystem(ws, 'Usage: /questreset <quest id or name> [player]');
        return;
      }
      const target = findPlayerByUsername(parsed.targetName, world);
      if (!target) {
        sendSystem(ws, `Player "${parsed.targetName}" not online.`);
        return;
      }
      if (!world.resetQuestForAdmin(target, parsed.quest.id)) {
        sendSystem(ws, `Could not reset quest "${parsed.quest.name}".`);
        return;
      }
      sendSystem(ws, `Reset "${parsed.quest.name}" for ${target.name}.`);
      sendSystemMessageToUser(target.name, `Admin reset quest: ${parsed.quest.name}.`);
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
      player.openShopNpcEntityId = null;
      world.closeDialogueForPlayer(player);
      player.pendingInteraction = null;
      // Cross-map unstucks must go through MAP_CHANGE so the client reloads chunks/entities.
      const map = world.getMap(UNSTUCK_TARGET_MAP);
      world.handleMapTransition(player, {
        targetMap: UNSTUCK_TARGET_MAP,
        targetX: map.meta.spawnPoint.x,
        targetZ: map.meta.spawnPoint.z,
        targetFloor: 0,
      });
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

    case '/mute': {
      if (denyIfNotAdmin(ws, from)) return;
      const targetName = parts[1];
      if (!targetName) {
        sendSystem(ws, 'Usage: /mute <player> [30m|1h|24h|7d|permanent] [reason]');
        return;
      }
      const accountId = world.db.getAccountIdByUsername(targetName);
      if (accountId == null) {
        sendSystem(ws, `Account "${targetName}" not found.`);
        return;
      }
      if (accountId === ws.data.accountId) {
        sendSystem(ws, 'You cannot mute your own account.');
        return;
      }
      const target = world.db.getAccountModerationInfo(accountId);
      if (!target) {
        sendSystem(ws, `Account "${targetName}" not found.`);
        return;
      }
      if (target.isAdmin) {
        sendSystem(ws, 'Admin accounts cannot be muted.');
        return;
      }
      const parsed = parseMuteCommandArgs(parts.slice(2));
      if (!parsed.ok) {
        sendSystem(ws, parsed.error);
        return;
      }
      world.db.muteAccount(accountId, parsed.reason, from, parsed.expiresAt);
      sendSystem(ws, `Muted ${target.username} (${moderationExpiryLabel(parsed.expiresAt)}).`);
      break;
    }

    case '/unmute': {
      if (denyIfNotAdmin(ws, from)) return;
      const targetName = parts[1];
      if (!targetName) {
        sendSystem(ws, 'Usage: /unmute <player>');
        return;
      }
      const accountId = world.db.getAccountIdByUsername(targetName);
      if (accountId == null) {
        sendSystem(ws, `Account "${targetName}" not found.`);
        return;
      }
      const targetUsername = world.db.getUsernameByAccountId(accountId) ?? targetName;
      const removed = world.db.unmuteAccount(accountId);
      sendSystem(ws, removed ? `Unmuted ${targetUsername}.` : `${targetUsername} was not muted.`);
      break;
    }

    case '/rename':
    case '/setname': {
      if (denyIfNotAdmin(ws, from)) return;
      const args = command.trim().split(/\s+/);
      const targetName = args[1];
      const newName = args[2];
      if (!targetName || !newName || args.length !== 3) {
        sendSystem(ws, 'Usage: /rename <player> <newName>');
        return;
      }
      const accountId = world.db.getAccountIdByUsername(targetName);
      if (accountId == null) {
        sendSystem(ws, `Account "${targetName}" not found.`);
        return;
      }
      const result = world.db.renameAccount(accountId, newName);
      if (!result.ok) {
        sendSystem(ws, result.error);
        return;
      }
      world.renameActiveAccount(result.accountId, result.username);
      renameChatAccount(result.accountId, result.username);
      broadcastSocialPresenceForAccount(result.accountId, result.username);
      recordGameEvent(world, {
        type: 'account_rename',
        severity: 'notable',
        message: `${from} renamed ${result.oldUsername} to ${result.username}`,
        actorAccountId: ws.data.accountId,
        actorName: from,
        targetAccountId: result.accountId,
        targetName: result.username,
        details: {
          oldUsername: result.oldUsername,
          newUsername: result.username,
        },
      });
      sendSystem(ws, `Renamed ${result.oldUsername} to ${result.username}.`);
      if (result.accountId !== ws.data.accountId) {
        sendSystemMessageToUser(result.username, `Your name has been changed to ${result.username}.`);
      }
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
      }
      world.db.banIp(ip, reason, from);
      const kicked = world.kickPlayersFromIp(ip);
      sendSystem(ws, `IP-banned ${label}; kicked ${kicked} online player${kicked === 1 ? '' : 's'} from that IP${reason ? ` — ${reason}` : ''}.`);
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

function parseMuteCommandArgs(args: string[]): { ok: true; expiresAt: number | null; reason: string } | { ok: false; error: string } {
  const first = args[0]?.trim();
  const parsedDuration = first ? parseMuteDurationToken(first) : null;
  if (parsedDuration && !parsedDuration.ok) return parsedDuration;

  const durationSeconds = parsedDuration?.durationSeconds ?? DEFAULT_MUTE_DURATION_SECONDS;
  const expiresAt = durationSeconds === null ? null : Math.floor(Date.now() / 1000) + durationSeconds;
  const reasonStart = parsedDuration ? 1 : 0;
  const reason = args.slice(reasonStart).join(' ').trim().slice(0, 200);
  return { ok: true, expiresAt, reason };
}

function parseMuteDurationToken(token: string): { ok: true; durationSeconds: number | null } | { ok: false; error: string } | null {
  const normalized = token.toLowerCase();
  if (normalized === 'permanent' || normalized === 'perm' || normalized === '0') {
    return { ok: true, durationSeconds: null };
  }

  const match = normalized.match(/^(\d+)([smhd])?$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const multiplier = unit === 'd' ? 24 * 60 * 60 : unit === 'h' ? 60 * 60 : unit === 'm' ? 60 : 1;
  const seconds = amount * multiplier;
  if (!Number.isFinite(seconds)) return { ok: false, error: 'Invalid mute duration.' };
  if (seconds < 60) return { ok: false, error: 'Temporary mutes must be at least 1 minute.' };
  if (seconds > MAX_MUTE_DURATION_SECONDS) return { ok: false, error: 'Temporary mutes cannot exceed 366 days.' };
  return { ok: true, durationSeconds: Math.floor(seconds) };
}

function moderationExpiryLabel(expiresAt: number | null): string {
  return expiresAt === null ? 'permanent' : `until ${new Date(expiresAt * 1000).toISOString()}`;
}

function parseQuestAdminCommand(
  parts: string[],
  defaultTargetName: string,
  world: World,
): { quest: QuestDef; targetName: string } | null {
  const args = parts.slice(1).filter(Boolean);
  if (args.length === 0) return null;
  const quests = world.data.getAllQuests();
  for (let len = args.length; len >= 1; len--) {
    const query = args.slice(0, len).join(' ').toLowerCase();
    const quest = quests.find(q => q.id.toLowerCase() === query || q.name.toLowerCase() === query);
    if (!quest) continue;
    const targetName = args.slice(len).join(' ') || defaultTargetName;
    return { quest, targetName };
  }
  return null;
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
  _world: World
): void {
  chatSockets.delete(ws);
  const lc = ws.data.username.toLowerCase();
  if (chatSocketsByUsername.get(lc) === ws) chatSocketsByUsername.delete(lc);
  if (chatSocketsByAccountId.get(ws.data.accountId) === ws) chatSocketsByAccountId.delete(ws.data.accountId);
  const stillOnline = chatSocketsByAccountId.has(ws.data.accountId);
  if (!stillOnline) ignoredAccountIdsByAccountId.delete(ws.data.accountId);
  sendSocialPresence(ws.data.accountId, ws.data.username, stillOnline, isStaffData(ws.data));
}

/** Broadcast player info to all chat sockets so clients can map entityId → name */
export function broadcastPlayerInfo(entityId: number, name: string): void {
  const payload = JSON.stringify({ type: 'player_info', entityId, name });
  const subjectIsStaff = knownPlayerInfoStaffStatus(entityId, name);
  for (const sock of chatSockets) {
    if (subjectIsStaff === undefined && !isStaffData(sock.data)) continue;
    if (subjectIsStaff !== undefined && !canReceiveStaffPresence(sock, subjectIsStaff)) continue;
    chatSend(sock, payload);
  }
}

/** Send a system message to a specific player by username, via their chat socket.
 *  Used by World.sendChatSystem so server-side errors (inventory full, trade
 *  range, etc.) actually reach the player's chat panel. Silently no-ops if the
 *  player isn't currently connected to the chat socket. */
export function sendSystemMessageToUser(username: string, message: string): void {
  const lc = username.toLowerCase();
  const payload = JSON.stringify({ type: 'system', message });
  const sock = chatSocketsByUsername.get(lc);
  if (sock) {
    try { sock.send(payload); } catch { /* ignore */ }
    return;
  }
  for (const sock of chatSockets) {
    if (sock.data.username.toLowerCase() === lc) {
      try { sock.send(payload); } catch { /* ignore */ }
      return;
    }
  }
}

export function renameChatAccount(accountId: number, username: string): boolean {
  const sock = chatSocketsByAccountId.get(accountId);
  if (!sock) return false;
  const oldLc = sock.data.username.toLowerCase();
  if (chatSocketsByUsername.get(oldLc) === sock) chatSocketsByUsername.delete(oldLc);
  sock.data.username = username;
  chatSocketsByUsername.set(username.toLowerCase(), sock);
  chatSend(sock, JSON.stringify({ type: 'account_renamed', username }));
  return true;
}

export function broadcastSocialPresenceForAccount(accountId: number, username: string): void {
  const sock = chatSocketsByAccountId.get(accountId);
  sendSocialPresence(accountId, username, !!sock, sock ? isStaffData(sock.data) : false);
}

export function setChatAccountModerator(accountId: number, isModerator: boolean): void {
  const sock = chatSocketsByAccountId.get(accountId);
  if (sock) {
    sock.data.isModerator = isModerator;
    if (sock.data.playerId != null) rememberPlayerInfoRole(sock.data.playerId, isStaffData(sock.data));
  }
}

export function setChatAccountAdmin(accountId: number, isAdmin: boolean): void {
  const sock = chatSocketsByAccountId.get(accountId);
  if (sock) {
    sock.data.isAdmin = isAdmin;
    if (sock.data.playerId != null) rememberPlayerInfoRole(sock.data.playerId, isStaffData(sock.data));
  }
}
