import { Database as SQLiteDB } from 'bun:sqlite';
import { createHash, randomBytes } from 'crypto';
import type { Player } from './entity/Player';
import type { SkillBlock, SkillId, MeleeStance, MagicStance, PlayerAppearance, QuestState } from '@projectrs/shared';
import { ALL_SKILLS, SKILL_NAMES, BANK_SIZE, INVENTORY_SIZE, RELIC_ITEM_IDS, STANCE_KEYS, DEFAULT_APPEARANCE, combatLevel, initSkills, isValidAppearance, normalizeAppearance, normalizeSkillId, validateDeviceId, validatePassword, validateUsername } from '@projectrs/shared';
import type { EquipSlot } from './entity/Player';

const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const OAUTH_ACCESS_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const OAUTH_AUTH_CODE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const OAUTH_REFRESH_TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ACCOUNT_CREATION_CLOSED_MESSAGE = 'We have decided to close for new accounts until the Alpha launch. Join our Discord for more info.';
const PUBLIC_SIGNUPS_ENABLED = Bun.env.PUBLIC_SIGNUPS_ENABLED !== '0';
const RESET_BOBS_BURIAL_MIGRATION_ID = 'reset_bobs_burial_2026_05_18';
const MOVE_STACKED_RELICS_TO_BANK_MIGRATION_ID = 'move_stacked_relics_to_bank_2026_05_24';
const RESET_BOT_METRICS_MIGRATION_ID = 'reset_bot_metrics_2026_05_24_calibration';
const REMOVE_RETIRED_RESOURCE_ITEMS_MIGRATION_ID = 'remove_retired_resource_items_2026_05_24';
const GAME_EVENT_LOG_FLUSH_INTERVAL_MS = envBoundedInteger('GAME_EVENT_LOG_FLUSH_INTERVAL_MS', 1_000, 100, 30_000);
const GAME_EVENT_LOG_BATCH_SIZE = envBoundedInteger('GAME_EVENT_LOG_BATCH_SIZE', 250, 1, 2_000);
const GAME_EVENT_LOG_MAX_QUEUE_SIZE = envBoundedInteger('GAME_EVENT_LOG_MAX_QUEUE_SIZE', 5_000, 100, 100_000);
const GAME_EVENT_LOG_RETENTION_DAYS = envBoundedInteger('GAME_EVENT_LOG_RETENTION_DAYS', 90, 0, 3_650);
const GAME_EVENT_LOG_PRUNE_INTERVAL_MS = 10 * 60 * 1000;
const BOBS_BURIAL_QUEST_ID = "Bob's Burial";
const SUSPECT_SKETCH_ITEM_ID = 236;
const RETIRED_RESOURCE_ITEM_IDS = [46, 47, 57] as const;
const RETIRED_RESOURCE_OBJECT_IDS = [17, 18] as const;
const HISCORE_EXCLUDED_USERNAMES = new Set(['blackberry']);
const VALID_STANCES = new Set<string>(STANCE_KEYS);
const STARTER_INVENTORY = [
  { itemId: 31, quantity: 1 },  // Bronze Axe
  { itemId: 33, quantity: 1 },  // Bronze Pickaxe
  { itemId: 67, quantity: 1 },  // Bronze Square Shield
  { itemId: 58, quantity: 1 },  // Bronze Dagger
  { itemId: 231, quantity: 1 }, // Cooked Rice
  { itemId: 231, quantity: 1 }, // Cooked Rice
  { itemId: 231, quantity: 1 }, // Cooked Rice
  { itemId: 550, quantity: 1 }, // Tinderbox
  { itemId: 10, quantity: 30 }, // Coins
] as const;
const FORUM_DEFAULT_CATEGORIES = [
  { slug: 'announcements', name: 'Announcements', description: 'Official EvilQuest news and notices.', staffOnly: 1 },
  { slug: 'general', name: 'General', description: 'Talk about EvilQuest and the wider community.', staffOnly: 0 },
  { slug: 'help', name: 'Help', description: 'Ask questions and help other adventurers.', staffOnly: 0 },
  { slug: 'suggestions', name: 'Suggestions', description: 'Share ideas for future updates.', staffOnly: 0 },
  { slug: 'bug-reports', name: 'Bug Reports', description: 'Report issues with the game or website.', staffOnly: 0 },
  { slug: 'marketplace', name: 'Marketplace', description: 'Buy, sell, and trade with other players.', staffOnly: 0 },
  { slug: 'off-topic', name: 'Off Topic', description: 'Relaxed discussion that does not fit elsewhere.', staffOnly: 0 },
] as const;

function envBoundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = Bun.env[name];
  const value = raw == null || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function starterInventoryJson(): string {
  return JSON.stringify(STARTER_INVENTORY);
}

function parseStoredStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function hashOAuthToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// A post is auto-hidden (pending staff review) once this many distinct accounts
// report it. Stops a single spam post from staying live for hours before a
// moderator sees it; still reversible via moderateForumPost('restore').
const FORUM_AUTO_HIDE_DISTINCT_REPORTS = 3;
const FORUM_AVATAR_BAKE_VERSION = 12;
const FORUM_PROFILE_BIO_LIMIT = 500;
const FORUM_PROFILE_SIGNATURE_LIMIT = 240;
const FORUM_AVATAR_VISIBLE_EQUIPMENT_SLOTS = {
  head: 2,
  body: 3,
  cape: 9,
} as const;

function forumSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function clampForumPage(value: number, fallback = 1): number {
  return Math.max(1, Math.floor(Number.isFinite(value) ? value : fallback));
}

function parseSavedAppearance(raw: string | null | undefined): PlayerAppearance | null {
  if (!raw) return null;
  try {
    const appearance = normalizeAppearance(JSON.parse(raw) as Partial<PlayerAppearance>);
    return isValidAppearance(appearance) ? appearance : null;
  } catch {
    return null;
  }
}

function parseSavedEquipmentItemId(raw: string | null | undefined, slot: keyof typeof FORUM_AVATAR_VISIBLE_EQUIPMENT_SLOTS): number | null {
  if (!raw) return null;
  try {
    const equipment = JSON.parse(raw) as Record<string, unknown> | unknown[];
    const legacyIndex = FORUM_AVATAR_VISIBLE_EQUIPMENT_SLOTS[slot];
    const value = Array.isArray(equipment) ? equipment[legacyIndex] : (equipment[slot] ?? equipment[String(legacyIndex)]);
    const itemId = typeof value === 'number'
      ? value
      : value && typeof value === 'object' && typeof (value as { itemId?: unknown }).itemId === 'number'
        ? (value as { itemId: number }).itemId
        : 0;
    return Number.isInteger(itemId) && itemId > 0 ? itemId : null;
  } catch {
    return null;
  }
}

function forumAvatarTarget(accountId: number, username: string, rawAppearance: string | null | undefined, rawEquipment: string | null | undefined): ForumAvatarBakeTarget | null {
  const appearance = parseSavedAppearance(rawAppearance) ?? DEFAULT_APPEARANCE;
  const equipment = {
    head: parseSavedEquipmentItemId(rawEquipment, 'head'),
    body: parseSavedEquipmentItemId(rawEquipment, 'body'),
    cape: parseSavedEquipmentItemId(rawEquipment, 'cape'),
  };
  const hash = createHash('sha1')
    .update(JSON.stringify({ appearance, equipment, bakeVersion: FORUM_AVATAR_BAKE_VERSION }))
    .digest('hex')
    .slice(0, 16);
  return {
    accountId,
    username,
    appearance,
    headItemId: equipment.head,
    bodyItemId: equipment.body,
    capeItemId: equipment.cape,
    equipment,
    hash,
    url: `/forum-avatars/${accountId}-${hash}.webp`,
  };
}

export interface SessionInfo {
  accountId: number;
  username: string;
  isAdmin: boolean;
  isModerator: boolean;
  /** Browser device ID captured at login. Plumbed through the WS upgrade to
   *  the Player so login_history can record it for cross-account device
   *  correlation. Empty string when the client didn't supply one. */
  deviceId: string;
  /** HttpOnly cookie binding created with the session. WebSocket upgrades must
   *  present this alongside the JS-visible token, so a copied token alone
   *  cannot open raw game/chat sockets. */
  wsSecret: string;
  oauthClientId: string | null;
  oauthScopes: string[];
}

export interface CreatedSession {
  token: string;
  wsSecret: string;
}

export interface AccountAuthInfo {
  accountId: number;
  username: string;
  isAdmin: boolean;
  isModerator: boolean;
}

export interface OAuthAuthorizationCodeRecord {
  code: string;
  accountId: number;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  expiresAt: number;
}

export interface OAuthSessionResult extends AccountAuthInfo {
  token: string;
  wsSecret: string;
  refreshToken: string;
  expiresIn: number;
  clientId: string;
  scopes: string[];
}

export interface OAuthRefreshTokenInfo {
  accountId: number;
  clientId: string;
  scopes: string[];
  expiresAt: number;
}

/** Persisted row in the bot_stats table. Strings are JSON-encoded blobs
 *  (the BotStats class parses/serializes them). Counters are aggregates
 *  that survive across sessions, samples are rolling windows. */
export interface BotStatsRow {
  total_skilling_actions: number;
  total_combat_swings: number;
  total_movements: number;
  total_chat_messages: number;
  total_session_minutes: number;
  total_flag_events: number;
  total_suspicious_packets: number;
  last_chat_ts: number | null;
  last_action_ts: number | null;
  last_login_ts: number | null;
  /** Persisted manual-review priority derived from the latest session summary. */
  risk_score: number;
  risk_level: string;
  risk_reasons: string;
  /** JSON array of recent tick-align deltas (ms past tick boundary). Capped at 100. */
  tick_align_samples: string;
  /** JSON array of recent reaction times (ms after NPC death → next attack). Capped at 50. */
  reaction_samples: string;
  /** JSON array of recent client heartbeat intervals in ms. Capped at 100. */
  ping_interval_samples: string;
  /** JSON map of "x,z" tile → visit count. Capped at 100 entries. */
  path_destinations: string;
  /** JSON map of route/action signatures → count. Capped at 100 entries. */
  action_signatures?: string;
  /** JSON map of deviceId → login count. Used to catch fresh-ID-per-login bots. */
  device_ids: string;
  /** JSON map of invalid packet reason → count. */
  suspicious_packet_reasons?: string;
  /** JSON map of skill → xp at session start. Used to compute session-rate. */
  xp_baseline: string;
  /** JSON blob of the last computed session summary (flags + stats). */
  last_session_summary: string | null;
  /** JSON array of recent finalized summaries. */
  session_history?: string;
}

export interface AdminBotPacketReason {
  reason: string;
  count: number;
}

export interface AdminBotPathDestination {
  tile: string;
  count: number;
}

export interface AdminSharedDeviceAlt {
  accountId: number;
  username: string;
  devices: number;
  logins: number;
  lastSeenTs: number | null;
}

export interface AdminBotReviewAccount {
  accountId: number;
  username: string;
  isAdmin: boolean;
  isModerator: boolean;
  riskScore: number;
  riskLevel: string;
  riskReasons: string[];
  totalSkillingActions: number;
  totalCombatSwings: number;
  totalMovements: number;
  totalChatMessages: number;
  totalSessionMinutes: number;
  totalFlagEvents: number;
  totalSuspiciousPackets: number;
  lastChatTs: number | null;
  lastActionTs: number | null;
  lastLoginTs: number | null;
  lastIp: string | null;
  lastReverseDns: string | null;
  lastDeviceId: string | null;
  lastSessionMinutes: number | null;
  botStatsUpdatedAt: number | null;
  tickAlignSampleCount: number;
  reactionSampleCount: number;
  pingIntervalSampleCount: number;
  pathDestinationCount: number;
  topPathRepetition: number | null;
  topPathDestinations: AdminBotPathDestination[];
  deviceIdsSeen: number;
  suspiciousPacketReasons: AdminBotPacketReason[];
  sessionHistory: Array<Record<string, unknown>>;
  chatRatePerHour: number | null;
  actionsPerHour: number | null;
  actionsPerChat: number | null;
  sharedDeviceAlts: AdminSharedDeviceAlt[];
  lastSessionSummary: Record<string, unknown> | null;
  accountBan: AccountBanRecord | null;
  ipBan: IpBanRecord | null;
  accountMute: AccountMuteRecord | null;
}

export type GameEventLogType =
  | 'npc_kill'
  | 'npc_drop'
  | 'rare_drop'
  | 'item_pickup'
  | 'harvest'
  | 'bonus_loot'
  | 'chest_loot'
  | 'crafting_hq'
  | 'chat'
  | 'private_chat'
  | 'chat_command'
  | 'trade'
  | 'player_death'
  | 'duel'
  | 'admin'
  | 'system';

export type GameEventLogSeverity = 'info' | 'notable' | 'rare' | 'warning';

export interface GameEventLogInput {
  type: GameEventLogType | string;
  severity?: GameEventLogSeverity | string;
  message: string;
  actorAccountId?: number | null;
  actorName?: string | null;
  targetAccountId?: number | null;
  targetName?: string | null;
  npcDefId?: number | null;
  npcName?: string | null;
  itemId?: number | null;
  itemName?: string | null;
  quantity?: number | null;
  mapLevel?: string | null;
  floor?: number | null;
  x?: number | null;
  z?: number | null;
  details?: Record<string, unknown> | null;
}

export interface GameEventLogEntry {
  id: number;
  createdAt: number;
  type: string;
  severity: string;
  message: string;
  actorAccountId: number | null;
  actorName: string | null;
  targetAccountId: number | null;
  targetName: string | null;
  npcDefId: number | null;
  npcName: string | null;
  itemId: number | null;
  itemName: string | null;
  quantity: number | null;
  mapLevel: string | null;
  floor: number | null;
  x: number | null;
  z: number | null;
  details: Record<string, unknown>;
}

export interface GameEventLogSnapshot {
  latestId: number;
  events: GameEventLogEntry[];
}

export interface GameEventLogListOptions {
  afterId?: number;
  limit?: number;
  excludeTypes?: string[];
  user?: string | null;
  query?: string | null;
}

interface PendingGameEventLogEntry extends Omit<GameEventLogEntry, 'id'> {
  detailsJson: string;
}

/** Bump this constant to force every existing account to spawn at the map's
 *  default spawnPoint on their next login (one-time per bump). Saved skills,
 *  inventory, bank, etc. are preserved — only position is reset. On respawn
 *  the player_state row's respawn_version is updated to this value, so
 *  subsequent logins use the saved position normally. */
export const WORLD_RESPAWN_VERSION = 4;

export interface SavedPlayerState {
  x: number;
  z: number;
  /** Effective walking Y at save time, captured server-side via
   *  GameMap.getEffectiveHeightOnFloor. Persisted so a player who logged out
   *  on an elevated tile (texture-plane bridge, e.g. building interiors at
   *  y≈2.73) respawns at the right elevation — without this, the client's
   *  getEffectiveHeight gates elevation reveal on the player's current Y,
   *  which is 0 at spawn time, dropping them through the floor. */
  y: number;
  floor: number;
  mapLevel: string;
  skills: SkillBlock;
  inventory: ({ itemId: number; quantity: number } | null)[];
  equipment: Map<EquipSlot, number>;
  equipmentQuantities: Map<EquipSlot, number>;
  stance: MeleeStance;
  magicStance: MagicStance;
  autocastSpellIndex: number;
  autoRetaliate: boolean;
  appearance: PlayerAppearance | null;
  bank: ({ itemId: number; quantity: number } | null)[];
  respawnVersion: number;
  quests: Record<string, QuestState>;
  renown: number;
}

export interface HiscoreCategory {
  id: string;
  name: string;
  hasXp: boolean;
}

export interface HiscoreRow {
  rank: number;
  username: string;
  isRoleModerator: boolean;
  level: number;
  xp: number;
  dailyXp: number;
  rankChange: number | null;
}

export type HiscoreSortKey = 'rank' | 'username' | 'level' | 'xp' | 'dailyXp';
export type MobKillSortKey = 'rank' | 'username' | 'kills';
export type HiscoreSortDirection = 'asc' | 'desc';

export interface HiscoreResponse {
  category: HiscoreCategory;
  categories: HiscoreCategory[];
  rows: HiscoreRow[];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
}

export interface HiscoreProfileRow {
  category: HiscoreCategory;
  rank: number;
  level: number;
  xp: number;
  dailyXp: number;
  rankChange: number | null;
}

export interface HiscoreProfileResponse {
  username: string;
  isRoleModerator: boolean;
  avatarUrl: string;
  rows: HiscoreProfileRow[];
  monsterKills: HiscoreProfileMonsterKillRow[];
}

export interface HiscoreProfileMonsterKillRow {
  npcDefId: number;
  name: string;
  rank: number;
  kills: number;
  dailyKills: number;
}

export type SocialListKind = 'friends' | 'ignore';

export interface SocialEntry {
  accountId: number;
  username: string;
}

export interface ForumCategory {
  id: number;
  slug: string;
  name: string;
  description: string;
  sortOrder: number;
  isHidden: boolean;
  isLocked: boolean;
  staffOnlyWrite: boolean;
  threadCount: number;
  postCount: number;
  latestThread: ForumThreadSummary | null;
}

export interface ForumThreadSummary {
  id: number;
  categoryId: number;
  categorySlug: string;
  categoryName: string;
  slug: string;
  title: string;
  author: { accountId: number; username: string };
  createdAt: number;
  updatedAt: number;
  lastPostAt: number;
  lastPostBy: string;
  replyCount: number;
  viewCount: number;
  isPinned: boolean;
  isLocked: boolean;
  isHidden: boolean;
  isDeleted: boolean;
}

export interface ForumPost {
  id: number;
  threadId: number;
  author: { accountId: number; username: string; avatarUrl: string; combatLevel: number | null; isAdmin: boolean; isRoleModerator: boolean; signature: string };
  replyTo: { id: number; author: { accountId: number; username: string }; body: string; createdAt: number } | null;
  body: string;
  createdAt: number;
  updatedAt: number;
  editedAt: number | null;
  isHidden: boolean;
  isDeleted: boolean;
  hiddenReason: string;
  reactions: Record<string, number>;
  reactionUsers: Record<string, ForumReactionUsers>;
  myReaction: string | null;
}

export interface ForumReactionUsers {
  names: string[];
  others: number;
}

export interface ForumThreadDetail {
  thread: ForumThreadSummary;
  category: ForumCategory;
  posts: ForumPost[];
  page: number;
  pageSize: number;
  totalPosts: number;
  totalPages: number;
}

export interface ForumListResponse {
  categories: ForumCategory[];
  threads: ForumThreadSummary[];
  page: number;
  pageSize: number;
  totalThreads: number;
  totalPages: number;
}

export interface ForumProfile {
  accountId: number;
  username: string;
  createdAt: number;
  avatarUrl: string;
  bio: string;
  title: string;
  signature: string;
  postCount: number;
  threadCount: number;
  isModerator: boolean;
  isRoleModerator: boolean;
  isAdmin: boolean;
  combatLevel: number | null;
  topSkills: Array<{ id: string; name: string; level: number; xp: number }>;
  recentThreads: ForumThreadSummary[];
  recentPosts: Array<{ id: number; threadId: number; threadTitle: string; threadSlug: string; createdAt: number }>;
}

export interface ForumOnlineUser {
  accountId: number;
  username: string;
  avatarUrl: string;
  combatLevel: number | null;
  isAdmin: boolean;
  isRoleModerator: boolean;
  lastSeenAt: number;
}

export interface ForumReport {
  id: number;
  postId: number;
  threadId: number;
  threadTitle: string;
  reason: string;
  status: string;
  reporter: { accountId: number; username: string };
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
}

export interface ForumNotification {
  id: number;
  type: string;
  createdAt: number;
  readAt: number | null;
  actor: { accountId: number; username: string };
  thread: { id: number; categorySlug: string; slug: string; title: string };
  postId: number;
  postPage: number;
  sourcePostId: number | null;
}

export interface ForumDiscordEmoji {
  id: string;
  guildId: string;
  name: string;
  animated: boolean;
  available: boolean;
  url: string;
  updatedAt: number;
}

export interface ForumMediaRecord {
  id: number;
  accountId: number;
  url: string;
  kind: string;
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  createdAt: number;
}

export interface ForumAvatarBakeTarget {
  accountId: number;
  username: string;
  appearance: PlayerAppearance;
  headItemId: number | null;
  bodyItemId: number | null;
  capeItemId: number | null;
  equipment: {
    head: number | null;
    body: number | null;
    cape: number | null;
  };
  hash: string;
  url: string;
}

export interface SocialLists {
  friends: SocialEntry[];
  ignore: SocialEntry[];
}

/** A mob the player can be ranked by kills of. id is the canonical NpcDef.id;
 *  name is display-only. Supplied by the caller (from NPC defs) so the DB layer
 *  stays decoupled from DataLoader. */
export interface MobKillVisual {
  appearance?: import('@projectrs/shared').PlayerAppearance;
  equipment?: number[];
  customColors?: import('@projectrs/shared').CustomColors;
}

export interface MobKillMob {
  id: number;
  name: string;
  visual?: MobKillVisual;
}

export interface MobKillRow {
  rank: number;
  username: string;
  isRoleModerator: boolean;
  kills: number;
}

export interface MobKillResponse {
  npcDefId: number;
  mobName: string;
  visual?: MobKillVisual;
  mobs: MobKillMob[];
  rows: MobKillRow[];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
}

interface RankedHiscoreRow extends HiscoreRow {
  accountId: number;
}

interface HiscorePlayerRecord {
  accountId: number;
  username: string;
  isAdmin: boolean;
  isRoleModerator: boolean;
  skills: SkillBlock;
}

function isHiscoreExcludedUsername(username: string): boolean {
  return HISCORE_EXCLUDED_USERNAMES.has(username.trim().toLowerCase());
}

const HISCORE_SORT_KEYS = new Set<HiscoreSortKey>(['rank', 'username', 'level', 'xp', 'dailyXp']);
const MOB_KILL_SORT_KEYS = new Set<MobKillSortKey>(['rank', 'username', 'kills']);

function normalizeHiscoreSortDirection(direction: string): HiscoreSortDirection {
  return direction === 'desc' ? 'desc' : 'asc';
}

function compareHiscoreUsername(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

function sortHiscoreRows(
  rows: RankedHiscoreRow[],
  sortKey: string,
  sortDirection: string,
): RankedHiscoreRow[] {
  const key = HISCORE_SORT_KEYS.has(sortKey as HiscoreSortKey) ? sortKey as HiscoreSortKey : 'rank';
  const direction = normalizeHiscoreSortDirection(sortDirection);
  return [...rows].sort((a, b) => {
    const primary = key === 'username'
      ? compareHiscoreUsername(a.username, b.username)
      : a[key] - b[key];
    const directed = direction === 'asc' ? primary : -primary;
    return directed || a.rank - b.rank || compareHiscoreUsername(a.username, b.username);
  });
}

function sortMobKillRows(
  rows: MobKillRow[],
  sortKey: string,
  sortDirection: string,
): MobKillRow[] {
  const key = MOB_KILL_SORT_KEYS.has(sortKey as MobKillSortKey) ? sortKey as MobKillSortKey : 'rank';
  const direction = normalizeHiscoreSortDirection(sortDirection);
  return [...rows].sort((a, b) => {
    const primary = key === 'username'
      ? compareHiscoreUsername(a.username, b.username)
      : a[key] - b[key];
    const directed = direction === 'asc' ? primary : -primary;
    return directed || a.rank - b.rank || compareHiscoreUsername(a.username, b.username);
  });
}

export interface BanInfo {
  reason: string;
  bannedAt: number;
  expiresAt: number | null;
}
export interface AccountBanRecord extends BanInfo {
  accountId: number;
  username: string;
  bannedBy: string;
}
export interface IpBanRecord extends BanInfo {
  ip: string;
  bannedBy: string;
}
export interface MuteInfo {
  reason: string;
  mutedAt: number;
  expiresAt: number | null;
}
export interface AccountMuteRecord extends MuteInfo {
  accountId: number;
  username: string;
  mutedBy: string;
}

function removeQuestFromSavedState(rawJson: string | null, questId: string): { json: string; changed: boolean } {
  try {
    const parsed = rawJson ? JSON.parse(rawJson) as Record<string, unknown> : {};
    if (!parsed || typeof parsed !== 'object' || !Object.prototype.hasOwnProperty.call(parsed, questId)) {
      return { json: rawJson || '{}', changed: false };
    }
    delete parsed[questId];
    return { json: JSON.stringify(parsed), changed: true };
  } catch {
    return { json: rawJson || '{}', changed: false };
  }
}

type SavedSlot = { itemId: number; quantity: number };

function removeItemFromSavedSlots(rawJson: string | null, fallbackSize: number, itemId: number): { json: string; changed: boolean } {
  try {
    const parsed = rawJson ? JSON.parse(rawJson) as unknown : [];
    const slots = Array.isArray(parsed) ? parsed : new Array(fallbackSize).fill(null);
    let changed = false;
    const cleaned = slots.map(slot => {
      if (!slot || typeof slot !== 'object') return slot;
      const maybeSlot = slot as { itemId?: unknown };
      if (maybeSlot.itemId !== itemId) return slot;
      changed = true;
      return null;
    });
    return { json: changed ? JSON.stringify(cleaned) : (rawJson || JSON.stringify(slots)), changed };
  } catch {
    return { json: rawJson || JSON.stringify(new Array(fallbackSize).fill(null)), changed: false };
  }
}

function removeItemsFromSavedEquipment(rawJson: string | null, itemIds: readonly number[]): { json: string; changed: boolean } {
  try {
    const parsed = rawJson ? JSON.parse(rawJson) as unknown : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { json: rawJson || '{}', changed: false };
    }
    const retired = new Set<number>(itemIds);
    const equipment = parsed as Record<string, unknown>;
    let changed = false;
    for (const [slot, value] of Object.entries(equipment)) {
      const itemId = typeof value === 'number'
        ? value
        : value && typeof value === 'object' && typeof (value as { itemId?: unknown }).itemId === 'number'
          ? (value as { itemId: number }).itemId
          : null;
      if (itemId === null || !retired.has(itemId)) continue;
      delete equipment[slot];
      changed = true;
    }
    return { json: changed ? JSON.stringify(equipment) : (rawJson || '{}'), changed };
  } catch {
    return { json: rawJson || '{}', changed: false };
  }
}

function normalizeSlotArray(raw: unknown, fallbackSize: number): (SavedSlot | null)[] {
  const slots = Array.isArray(raw) ? raw : new Array(fallbackSize).fill(null);
  return slots.map(slot => {
    if (!slot || typeof slot !== 'object') return null;
    const maybeSlot = slot as { itemId?: unknown; quantity?: unknown };
    if (typeof maybeSlot.itemId !== 'number' || !Number.isInteger(maybeSlot.itemId) || maybeSlot.itemId <= 0) return null;
    if (typeof maybeSlot.quantity !== 'number' || !Number.isInteger(maybeSlot.quantity) || maybeSlot.quantity <= 0) return null;
    return { itemId: maybeSlot.itemId, quantity: maybeSlot.quantity };
  });
}

function addToBankSlots(bank: (SavedSlot | null)[], itemId: number, quantity: number): boolean {
  for (let i = 0; i < BANK_SIZE; i++) {
    const slot = bank[i];
    if (slot?.itemId !== itemId) continue;
    slot.quantity += quantity;
    return true;
  }
  for (let i = 0; i < BANK_SIZE; i++) {
    if (bank[i] !== null && bank[i] !== undefined) continue;
    bank[i] = { itemId, quantity };
    return true;
  }
  return false;
}

function moveStackedRelicsToBankSlots(
  inventory: (SavedSlot | null)[],
  bank: (SavedSlot | null)[],
): { inventory: (SavedSlot | null)[]; bank: (SavedSlot | null)[]; changed: boolean; blocked: number } {
  let normalizedBank = bank;
  let changed = false;
  let blocked = 0;
  for (let i = 0; i < inventory.length; i++) {
    const slot = inventory[i];
    if (!slot || !RELIC_ITEM_IDS.has(slot.itemId) || slot.quantity <= 1) continue;
    if (normalizedBank === bank) {
      normalizedBank = bank.slice(0, Math.max(BANK_SIZE, bank.length));
      while (normalizedBank.length < BANK_SIZE) normalizedBank.push(null);
    }
    const overflow = slot.quantity - 1;
    if (!addToBankSlots(normalizedBank, slot.itemId, overflow)) {
      blocked += overflow;
      continue;
    }
    inventory[i] = { itemId: slot.itemId, quantity: 1 };
    changed = true;
  }

  return { inventory, bank: normalizedBank, changed, blocked };
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonNumberArray(raw: string | null | undefined): number[] {
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)) : [];
  } catch {
    return [];
  }
}

function parseJsonNumberRecord(raw: string | null | undefined): Record<string, number> {
  try {
    const parsed = JSON.parse(raw ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw ?? 'null') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function nullableFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nullableInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : null;
}

function trimmedText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

function sqlLikePattern(value: string): string {
  return `%${value.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function parseJsonObjectArray(raw: string | null | undefined): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(raw ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is Record<string, unknown> => (
      !!value && typeof value === 'object' && !Array.isArray(value)
    ));
  } catch {
    return [];
  }
}

function topNumberRecordEntries(record: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(record)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function topRecordRatio(record: Record<string, number>): number | null {
  let total = 0;
  let max = 0;
  for (const value of Object.values(record)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    total += value;
    if (value > max) max = value;
  }
  return total > 0 ? max / total : null;
}

function riskLevelForScore(score: number): string {
  if (score >= 85) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function hasLegacyBotRiskReasons(reasons: string[]): boolean {
  return reasons.some((reason) => (
    reason.includes('tick-aligned action timing')
    || reason.includes('invalid/stale gameplay packets')
    || reason.includes('heavy packet fuzzing pattern')
    || reason.includes('lifetime invalid packet volume')
  ));
}

function hardInvalidPacketCount(reasons: Record<string, number>): number {
  let total = 0;
  for (const [reason, count] of Object.entries(reasons)) {
    if (reason.startsWith('rate-limit:')
      || reason === 'malformed-frame'
      || reason === 'unknown-opcode'
      || reason === 'bad-move-path-length'
      || reason === 'truncated-move-path'
      || reason === 'bad-cursor-x'
      || reason === 'bad-cursor-y') {
      total += count;
    }
  }
  return total;
}

function calibratedLegacyBotRisk(input: {
  storedReasons: string[];
  totalSessionMinutes: number;
  totalSkillingActions: number;
  totalCombatSwings: number;
  totalMovements: number;
  totalChatMessages: number;
  totalFlagEvents: number;
  totalSuspiciousPackets: number;
  pathDestinations: Record<string, number>;
  suspiciousReasons: Record<string, number>;
}): { score: number; level: string; reasons: string[] } | null {
  if (!hasLegacyBotRiskReasons(input.storedReasons)) return null;
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    if (points <= 0) return;
    score += points;
    reasons.push(`${reason} (+${points})`);
  };
  const activeActions = input.totalSkillingActions + input.totalCombatSwings + input.totalMovements;
  const hours = input.totalSessionMinutes > 0 ? input.totalSessionMinutes / 60 : null;
  const chatRate = hours ? input.totalChatMessages / hours : null;
  const pathRatio = topRecordRatio(input.pathDestinations);
  const hardInvalid = hardInvalidPacketCount(input.suspiciousReasons);

  if (input.totalSessionMinutes >= 1200 && activeActions >= 25000 && chatRate !== null && chatRate < 1) {
    add(22, `extreme low-social high-activity lifetime (${chatRate.toFixed(2)} chats/hr, ${activeActions} actions)`);
  } else if (input.totalSessionMinutes >= 600 && activeActions >= 10000 && chatRate !== null && chatRate < 2) {
    add(12, `low-social high-activity lifetime (${chatRate.toFixed(2)} chats/hr, ${activeActions} actions)`);
  }
  if (input.totalMovements >= 5000 && pathRatio !== null && pathRatio >= 0.12) {
    add(pathRatio >= 0.2 ? 14 : 8, `lifetime path concentration (${pathRatio.toFixed(2)})`);
  }
  if (hardInvalid >= 25) add(hardInvalid >= 100 ? 22 : 14, `lifetime hard invalid packets (${hardInvalid})`);
  if (input.totalFlagEvents >= 25) add(8, `lifetime flag history (${input.totalFlagEvents} prior fires)`);
  else if (input.totalFlagEvents >= 10) add(4, `lifetime flag history (${input.totalFlagEvents} prior fires)`);
  else if (input.totalFlagEvents >= 5) add(2, `lifetime flag history (${input.totalFlagEvents} prior fires)`);
  if (input.totalSuspiciousPackets >= 500) add(4, `lifetime stale/noisy invalid packet volume (${input.totalSuspiciousPackets})`);
  else if (input.totalSuspiciousPackets >= 100) add(2, `lifetime stale/noisy invalid packet volume (${input.totalSuspiciousPackets})`);

  if (hardInvalid < 25) {
    score = Math.min(score, 29);
  }

  const capped = Math.min(100, Math.round(score));
  return {
    score: capped,
    level: riskLevelForScore(capped),
    reasons: reasons.slice(0, 12),
  };
}

export class GameDatabase {
  private db: SQLiteDB;
  private lastHiscoreSnapshotPruneAt = 0;
  private readonly lastHiscoreSnapshotKeys = new Map<number, string>();
  private gameEventFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private gameEventDroppedSinceFlush = 0;
  private lastGameEventLogPruneAt = 0;
  private readonly gameEventQueue: PendingGameEventLogEntry[] = [];

  constructor(dbPath: string = 'projectrs.db') {
    this.db = new SQLiteDB(dbPath);
    // Set busy_timeout FIRST so every subsequent statement — including the WAL
    // switch below and all hot-path writes (kill counts, batched player saves,
    // hiscore snapshots) — waits for a contended lock (up to 5s) instead of
    // immediately throwing "database is locked" (SQLITE_BUSY) into the caller
    // (e.g. the combat tick, or a --watch restart racing the old instance).
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_moderator INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        created_at INTEGER DEFAULT (unixepoch()),
        expires_at INTEGER NOT NULL,
        device_id TEXT NOT NULL DEFAULT '',
        ws_secret TEXT NOT NULL DEFAULT '',
        oauth_client_id TEXT,
        oauth_scopes TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
        code TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        client_id TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        code_challenge TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
        token TEXT PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        client_id TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER DEFAULT (unixepoch()),
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS player_state (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
        x REAL DEFAULT 96.5,
        z REAL DEFAULT 96.5,
        map_level TEXT DEFAULT 'kcmap',
        skills TEXT DEFAULT '{}',
        inventory TEXT DEFAULT '[]',
        equipment TEXT DEFAULT '{}',
        stance TEXT DEFAULT 'accurate',
        auto_retaliate INTEGER NOT NULL DEFAULT 0,
        appearance TEXT DEFAULT NULL,
        renown INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER DEFAULT (unixepoch())
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS server_migrations (
        id TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);

    // Migration: add appearance column if missing (existing databases)
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN appearance TEXT DEFAULT NULL`);
    } catch { /* column already exists */ }
    // Migration: add floor column so multi-floor positions persist across logout
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN floor INTEGER DEFAULT 0`);
    } catch { /* column already exists */ }
    // Migration: add y column so elevated-tile spawns restore at correct height
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN y REAL DEFAULT 0`);
    } catch { /* column already exists */ }
    // Migration: add is_admin column so admin authorization is DB-driven instead
    // of hardcoded in source. Backfill the legacy hardcoded admin so existing
    // deployments keep working.
    try {
      this.db.exec(`ALTER TABLE accounts ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE accounts ADD COLUMN is_moderator INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    this.db.query(`UPDATE accounts SET is_admin = 1 WHERE username = 'mogn' AND is_admin = 0`).run();
    // Migration: per-account bank container. JSON blob keeps the schema simple
    // and matches inventory/equipment storage.
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN bank TEXT DEFAULT '[]'`);
    } catch { /* column already exists */ }
    // Migration: respawn_version. Default 0 so every existing row trips the
    // < WORLD_RESPAWN_VERSION check in the login flow and gets relocated to
    // the current map spawn one time. After that, normal save flow writes
    // the new version and the row stops tripping.
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN respawn_version INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    // Migration: quests JSON column. {questId: {stage, triggerProgress}}.
    // stage: -1 = completed. Missing entries = not started.
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN quests TEXT NOT NULL DEFAULT '{}'`);
    } catch { /* column already exists */ }
    // Migration: player renown earned from quest completions.
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN renown INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    // Migration: persistent magic combat selection. Autocast is validated again
    // at login against the currently loaded spell catalogue, so stale indices
    // from deleted spells safely fall back to disabled.
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN autocast_spell_index INTEGER NOT NULL DEFAULT -1`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN magic_stance TEXT NOT NULL DEFAULT 'accurate'`);
    } catch { /* column already exists */ }
    // Migration: persistent auto-retaliation toggle. Default off preserves
    // pre-feature behavior for existing accounts.
    try {
      this.db.exec(`ALTER TABLE player_state ADD COLUMN auto_retaliate INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    this.runOneTimeDataMigrations();

    // Bot detection telemetry. One row per account, updated on session flush
    // (every 5 min during play + at logout). Survives restarts so an account
    // that bot-grinds across multiple sessions accumulates signal over time.
    // JSON-blob columns hold sample arrays (capped) and per-skill maps —
    // simpler than a normalized schema and grep-friendly when debugging.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_stats (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
        total_skilling_actions INTEGER NOT NULL DEFAULT 0,
        total_combat_swings INTEGER NOT NULL DEFAULT 0,
        total_movements INTEGER NOT NULL DEFAULT 0,
        total_chat_messages INTEGER NOT NULL DEFAULT 0,
        total_session_minutes INTEGER NOT NULL DEFAULT 0,
        total_flag_events INTEGER NOT NULL DEFAULT 0,
        total_suspicious_packets INTEGER NOT NULL DEFAULT 0,
        last_chat_ts INTEGER,
        last_action_ts INTEGER,
        last_login_ts INTEGER,
        risk_score INTEGER NOT NULL DEFAULT 0,
        risk_level TEXT NOT NULL DEFAULT 'low',
        risk_reasons TEXT NOT NULL DEFAULT '[]',
        tick_align_samples TEXT NOT NULL DEFAULT '[]',
        reaction_samples TEXT NOT NULL DEFAULT '[]',
        ping_interval_samples TEXT NOT NULL DEFAULT '[]',
        path_destinations TEXT NOT NULL DEFAULT '{}',
        action_signatures TEXT NOT NULL DEFAULT '{}',
        device_ids TEXT NOT NULL DEFAULT '{}',
        suspicious_packet_reasons TEXT NOT NULL DEFAULT '{}',
        xp_baseline TEXT NOT NULL DEFAULT '{}',
        last_session_summary TEXT,
        session_history TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN ping_interval_samples TEXT NOT NULL DEFAULT '[]'`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN device_ids TEXT NOT NULL DEFAULT '{}'`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN total_suspicious_packets INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN risk_score INTEGER NOT NULL DEFAULT 0`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'low'`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN risk_reasons TEXT NOT NULL DEFAULT '[]'`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN action_signatures TEXT NOT NULL DEFAULT '{}'`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN suspicious_packet_reasons TEXT NOT NULL DEFAULT '{}'`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE bot_stats ADD COLUMN session_history TEXT NOT NULL DEFAULT '[]'`);
    } catch { /* column already exists */ }
    this.runOneTimeBotStatsMigrations();

    // Login history: one row per session. IP is captured at WS upgrade time.
    // Indexed by ip + account_id + login_ts so the bot-review CLI can cheaply
    // find "what other accounts used this IP" and "what IPs has this account
    // ever used." Critical for catching gold-farmer rings — they routinely
    // run 5-20 accounts behind one IP and trade items between them.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS login_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        ip_address TEXT NOT NULL,
        login_ts INTEGER NOT NULL,
        logout_ts INTEGER,
        session_minutes INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_login_history_ip ON login_history(ip_address);
      CREATE INDEX IF NOT EXISTS idx_login_history_account ON login_history(account_id);
      CREATE INDEX IF NOT EXISTS idx_login_history_login_ts ON login_history(login_ts);
    `);
    // Migration: reverse_dns column. Populated async after login by a single
    // PTR lookup (best-effort — DNS failures are normal for residential IPs).
    // Pattern-match later in the review CLI to flag known-VPN / known-datacenter
    // PTR strings. Commodity VPNs almost always have telltale PTRs ("vpn",
    // "proxy", datacenter hostnames); sophisticated VPNs use clean ones and
    // slip through — that's the maintenance burden the user accepted.
    try {
      this.db.exec(`ALTER TABLE login_history ADD COLUMN reverse_dns TEXT`);
    } catch { /* column already exists */ }
    // Migration: device_id on sessions + login_history. Browser-scoped UUID
    // generated client-side and persisted in localStorage. Enforces the
    // one-account-per-browser rule (gentler than per-IP, doesn't break
    // shared-household play) and gives bot-review a second alt-detection axis.
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN device_id TEXT NOT NULL DEFAULT ''`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN ws_secret TEXT NOT NULL DEFAULT ''`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN oauth_client_id TEXT`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN oauth_scopes TEXT NOT NULL DEFAULT '[]'`);
    } catch { /* column already exists */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_codes_account ON oauth_authorization_codes(account_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_refresh_account ON oauth_refresh_tokens(account_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_oauth_refresh_client ON oauth_refresh_tokens(client_id)`);
    try {
      this.db.exec(`ALTER TABLE login_history ADD COLUMN device_id TEXT NOT NULL DEFAULT ''`);
    } catch { /* column already exists */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_login_history_device ON login_history(device_id)`);

    // Browser-held device signing keys. The private key stays in IndexedDB on
    // the client; the server stores only the public JWK and requires it to sign
    // each game-channel ECDH transcript before a player is spawned.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_device_keys (
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        device_id TEXT NOT NULL,
        public_jwk TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, device_id)
      );
    `);

    // Account + IP bans. Two tables instead of a single unified `bans` table so
    // each enforcement point (login API, WS upgrade) hits exactly one indexed
    // PK lookup. `banned_by` is a free-text admin username rather than a FK
    // because the admin who issued a ban may be deleted later and we don't
    // want to lose audit info.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_bans (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
        reason TEXT NOT NULL DEFAULT '',
        banned_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER,
        banned_by TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS ip_bans (
        ip_address TEXT PRIMARY KEY,
        reason TEXT NOT NULL DEFAULT '',
        banned_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER,
        banned_by TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS account_mutes (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
        reason TEXT NOT NULL DEFAULT '',
        muted_at INTEGER NOT NULL DEFAULT (unixepoch()),
        expires_at INTEGER,
        muted_by TEXT NOT NULL DEFAULT ''
      );
    `);
    try {
      this.db.exec(`ALTER TABLE account_bans ADD COLUMN expires_at INTEGER`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE ip_bans ADD COLUMN expires_at INTEGER`);
    } catch { /* column already exists */ }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS account_social (
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        target_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        list_type TEXT NOT NULL CHECK (list_type IN ('friends', 'ignore')),
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, target_account_id),
        CHECK (account_id <> target_account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_account_social_target
        ON account_social(target_account_id, list_type);
    `);

    // Door state persistence. One row per open (or otherwise non-default) door
    // — closed doors don't need a row (the in-memory default is closed). On
    // restart, World re-applies these to keep building interiors continuous
    // across server reboots. auto_close_at_tick is informational only.
    //
    // Keyed by (map, defId, tileX, tileZ) — stable across editor saves and
    // reboots. WorldObject runtime entity IDs come from a process-lifetime
    // counter assigned in spawn order; any editor change that adds, removes,
    // or reorders objects in placedObjects shifts every subsequent ID, so an
    // entity-ID-keyed row would silently latch onto the wrong door (with its
    // wall edges cleared) after a routine map edit.
    //
    // One-time migration: if a stale entity-id-keyed schema exists from a
    // pre-fix dev build, drop it. Production hasn't shipped this table yet
    // so the drop is safe.
    try {
      const cols = this.db.query("PRAGMA table_info(door_state)").all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some(c => c.name === 'tile_x')) {
        this.db.exec('DROP TABLE door_state');
      } else if (cols.length > 0 && !cols.some(c => c.name === 'floor')) {
        this.db.exec('ALTER TABLE door_state RENAME TO door_state_legacy_floor');
        this.db.exec(`
          CREATE TABLE door_state (
            map_level TEXT NOT NULL,
            def_id INTEGER NOT NULL,
            tile_x INTEGER NOT NULL,
            tile_z INTEGER NOT NULL,
            floor INTEGER NOT NULL DEFAULT 0,
            is_open INTEGER NOT NULL,
            auto_close_at_tick INTEGER,
            PRIMARY KEY (map_level, def_id, tile_x, tile_z, floor)
          );
        `);
        this.db.exec(`
          INSERT INTO door_state (map_level, def_id, tile_x, tile_z, floor, is_open, auto_close_at_tick)
          SELECT map_level, def_id, tile_x, tile_z, 0, is_open, auto_close_at_tick
          FROM door_state_legacy_floor
        `);
        this.db.exec('DROP TABLE door_state_legacy_floor');
      }
    } catch { /* table absent */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS door_state (
        map_level TEXT NOT NULL,
        def_id INTEGER NOT NULL,
        tile_x INTEGER NOT NULL,
        tile_z INTEGER NOT NULL,
        floor INTEGER NOT NULL DEFAULT 0,
        is_open INTEGER NOT NULL,
        auto_close_at_tick INTEGER,
        PRIMARY KEY (map_level, def_id, tile_x, tile_z, floor)
      );
    `);

    // World object respawn persistence. One row per currently-depleted
    // skilling object (trees, rocks, fishing spots). Stored as wall-clock
    // unix ms rather than ticks so a long downtime doesn't leave every node
    // depleted until the tick counter catches up — on boot, anything in the
    // past is dropped (respawns immediately) and anything in the future has
    // its remaining timer reconstructed. Keyed by stable identity for the
    // same reasons door_state is.
    try {
      const cols = this.db.query("PRAGMA table_info(world_object_respawn)").all() as Array<{ name: string }>;
      if (cols.length > 0 && !cols.some(c => c.name === 'tile_x')) {
        this.db.exec('DROP TABLE world_object_respawn');
      } else if (cols.length > 0 && !cols.some(c => c.name === 'floor')) {
        this.db.exec('ALTER TABLE world_object_respawn RENAME TO world_object_respawn_legacy_floor');
        this.db.exec(`
          CREATE TABLE world_object_respawn (
            map_level TEXT NOT NULL,
            def_id INTEGER NOT NULL,
            tile_x INTEGER NOT NULL,
            tile_z INTEGER NOT NULL,
            floor INTEGER NOT NULL DEFAULT 0,
            respawn_at_unix_ms INTEGER NOT NULL,
            PRIMARY KEY (map_level, def_id, tile_x, tile_z, floor)
          );
        `);
        this.db.exec(`
          INSERT INTO world_object_respawn (map_level, def_id, tile_x, tile_z, floor, respawn_at_unix_ms)
          SELECT map_level, def_id, tile_x, tile_z, 0, respawn_at_unix_ms
          FROM world_object_respawn_legacy_floor
        `);
        this.db.exec('DROP TABLE world_object_respawn_legacy_floor');
      }
    } catch { /* table absent */ }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS world_object_respawn (
        map_level TEXT NOT NULL,
        def_id INTEGER NOT NULL,
        tile_x INTEGER NOT NULL,
        tile_z INTEGER NOT NULL,
        floor INTEGER NOT NULL DEFAULT 0,
        respawn_at_unix_ms INTEGER NOT NULL,
        PRIMARY KEY (map_level, def_id, tile_x, tile_z, floor)
      );
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hiscore_snapshots (
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        category TEXT NOT NULL,
        bucket_start INTEGER NOT NULL,
        level INTEGER NOT NULL,
        xp INTEGER NOT NULL,
        PRIMARY KEY (account_id, category, bucket_start)
      );
      CREATE INDEX IF NOT EXISTS idx_hiscore_snapshots_category_bucket
        ON hiscore_snapshots(category, bucket_start);
    `);
    this.db.exec(`
      INSERT INTO hiscore_snapshots (account_id, category, bucket_start, level, xp)
      SELECT account_id, 'woodcutting', bucket_start, level, xp
      FROM hiscore_snapshots
      WHERE category = 'woodcut'
      ON CONFLICT(account_id, category, bucket_start) DO UPDATE SET
        level = MAX(hiscore_snapshots.level, excluded.level),
        xp = MAX(hiscore_snapshots.xp, excluded.xp);
      DELETE FROM hiscore_snapshots WHERE category = 'woodcut';
    `);

    // Per-player, per-mob kill tally. One row per (account, npc def id),
    // incremented by a single atomic UPSERT on the NPC-death hot path
    // (recordMobKill) — deliberately NOT a JSON column on player_state so it
    // never races the batched 15s save and persists immediately on each kill.
    // The (npc_def_id, kills DESC) index backs the per-mob leaderboard query.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mob_kills (
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        npc_def_id INTEGER NOT NULL,
        kills INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, npc_def_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mob_kills_npc
        ON mob_kills(npc_def_id, kills DESC);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mob_kill_snapshots (
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        npc_def_id INTEGER NOT NULL,
        bucket_start INTEGER NOT NULL,
        kills INTEGER NOT NULL,
        PRIMARY KEY (account_id, npc_def_id, bucket_start)
      );
      CREATE INDEX IF NOT EXISTS idx_mob_kill_snapshots_npc_bucket
        ON mob_kill_snapshots(npc_def_id, bucket_start);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS game_event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        actor_account_id INTEGER,
        actor_name TEXT,
        target_account_id INTEGER,
        target_name TEXT,
        npc_def_id INTEGER,
        npc_name TEXT,
        item_id INTEGER,
        item_name TEXT,
        quantity INTEGER,
        map_level TEXT,
        floor INTEGER,
        x REAL,
        z REAL,
        details TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_game_event_log_created_id
        ON game_event_log(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_game_event_log_type_id
        ON game_event_log(type, id DESC);
      CREATE INDEX IF NOT EXISTS idx_game_event_log_actor_id
        ON game_event_log(actor_account_id, id DESC);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS forum_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_hidden INTEGER NOT NULL DEFAULT 0,
        is_locked INTEGER NOT NULL DEFAULT 0,
        staff_only_write INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS forum_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER NOT NULL REFERENCES forum_categories(id),
        author_account_id INTEGER NOT NULL REFERENCES accounts(id),
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_post_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_post_account_id INTEGER NOT NULL REFERENCES accounts(id),
        reply_count INTEGER NOT NULL DEFAULT 0,
        view_count INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_locked INTEGER NOT NULL DEFAULT 0,
        is_hidden INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        UNIQUE(category_id, slug)
      );

      CREATE TABLE IF NOT EXISTS forum_posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL REFERENCES forum_threads(id),
        author_account_id INTEGER NOT NULL REFERENCES accounts(id),
        reply_to_post_id INTEGER REFERENCES forum_posts(id),
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        edited_at INTEGER,
        is_hidden INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        hidden_reason TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS forum_reactions (
        post_id INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
        account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        reaction TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (post_id, account_id)
      );

      CREATE TABLE IF NOT EXISTS forum_profiles (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        avatar_media_id INTEGER REFERENCES forum_media(id),
        banner_media_id INTEGER REFERENCES forum_media(id),
        bio TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        signature TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS forum_media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        storage_path TEXT NOT NULL,
        url TEXT NOT NULL,
        kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        original_name TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS forum_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL REFERENCES forum_posts(id),
        reporter_account_id INTEGER NOT NULL REFERENCES accounts(id),
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        resolved_at INTEGER,
        resolved_by_account_id INTEGER REFERENCES accounts(id)
      );

      CREATE TABLE IF NOT EXISTS forum_moderators (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        granted_by_account_id INTEGER REFERENCES accounts(id),
        granted_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS forum_post_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
        editor_account_id INTEGER NOT NULL REFERENCES accounts(id),
        old_body TEXT NOT NULL,
        new_body TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS forum_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        actor_account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        thread_id INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
        post_id INTEGER NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
        source_post_id INTEGER REFERENCES forum_posts(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        read_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS forum_presence (
        account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
        last_seen_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS forum_discord_emojis (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL,
        animated INTEGER NOT NULL DEFAULT 0,
        available INTEGER NOT NULL DEFAULT 1,
        url TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_forum_threads_category_last
        ON forum_threads(category_id, is_deleted, is_hidden, is_pinned DESC, last_post_at DESC);
      CREATE INDEX IF NOT EXISTS idx_forum_threads_last
        ON forum_threads(is_deleted, is_hidden, last_post_at DESC);
      CREATE INDEX IF NOT EXISTS idx_forum_posts_thread
        ON forum_posts(thread_id, is_deleted, is_hidden, created_at);
      CREATE INDEX IF NOT EXISTS idx_forum_reports_status
        ON forum_reports(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_forum_media_account_created
        ON forum_media(account_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_forum_notifications_recipient
        ON forum_notifications(recipient_account_id, read_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_forum_presence_last_seen
        ON forum_presence(last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_forum_discord_emojis_guild_name
        ON forum_discord_emojis(guild_id, name);
    `);
    try {
      this.db.exec(`ALTER TABLE forum_profiles ADD COLUMN signature TEXT NOT NULL DEFAULT ''`);
    } catch { /* column already exists */ }
    try {
      this.db.exec(`ALTER TABLE forum_posts ADD COLUMN reply_to_post_id INTEGER REFERENCES forum_posts(id)`);
    } catch {}
    this.seedForumCategories();
  }

  private runOneTimeDataMigrations(): void {
    const runOnce = (id: string, fn: () => number): void => {
      const alreadyRun = this.db.query('SELECT 1 FROM server_migrations WHERE id = ?').get(id);
      if (alreadyRun) return;
      const changed = fn();
      this.db.query('INSERT INTO server_migrations (id) VALUES (?)').run(id);
      console.log(`[migration] ${id}: updated ${changed} saved player(s).`);
    };

    runOnce(RESET_BOBS_BURIAL_MIGRATION_ID, () => this.resetBobBurialSavedState());
    runOnce(MOVE_STACKED_RELICS_TO_BANK_MIGRATION_ID, () => this.moveStackedRelicsToBankSavedState());
    runOnce(REMOVE_RETIRED_RESOURCE_ITEMS_MIGRATION_ID, () => this.removeRetiredResourceSavedState());
  }

  private runOneTimeBotStatsMigrations(): void {
    const alreadyRun = this.db.query('SELECT 1 FROM server_migrations WHERE id = ?').get(RESET_BOT_METRICS_MIGRATION_ID);
    if (alreadyRun) return;
    const changed = this.db.query('DELETE FROM bot_stats').run().changes;
    this.db.query('INSERT INTO server_migrations (id) VALUES (?)').run(RESET_BOT_METRICS_MIGRATION_ID);
    console.log(`[migration] ${RESET_BOT_METRICS_MIGRATION_ID}: cleared ${changed} polluted bot metric row(s).`);
  }

  private resetBobBurialSavedState(): number {
    const rows = this.db.query('SELECT account_id, inventory, bank, quests FROM player_state')
      .all() as Array<{ account_id: number; inventory: string | null; bank: string | null; quests: string | null }>;
    const updates: Array<{ accountId: number; inventory: string; bank: string; quests: string }> = [];

    for (const row of rows) {
      const inventory = removeItemFromSavedSlots(row.inventory, 28, SUSPECT_SKETCH_ITEM_ID);
      const bank = removeItemFromSavedSlots(row.bank, 0, SUSPECT_SKETCH_ITEM_ID);
      const quests = removeQuestFromSavedState(row.quests, BOBS_BURIAL_QUEST_ID);
      if (!inventory.changed && !bank.changed && !quests.changed) continue;
      updates.push({
        accountId: row.account_id,
        inventory: inventory.json,
        bank: bank.json,
        quests: quests.json,
      });
    }

    if (updates.length === 0) return 0;
    const tx = this.db.transaction((rowsToUpdate: typeof updates) => {
      const stmt = this.db.query('UPDATE player_state SET inventory = ?, bank = ?, quests = ?, updated_at = unixepoch() WHERE account_id = ?');
      for (const update of rowsToUpdate) {
        stmt.run(update.inventory, update.bank, update.quests, update.accountId);
      }
    });
    tx(updates);
    return updates.length;
  }

  private moveStackedRelicsToBankSavedState(): number {
    const rows = this.db.query('SELECT account_id, inventory, bank FROM player_state')
      .all() as Array<{ account_id: number; inventory: string | null; bank: string | null }>;
    const updates: Array<{ accountId: number; inventory: string; bank: string }> = [];
    let blockedRelics = 0;

    for (const row of rows) {
      let inventory: (SavedSlot | null)[];
      let bank: (SavedSlot | null)[];
      try {
        inventory = normalizeSlotArray(row.inventory ? JSON.parse(row.inventory) : [], INVENTORY_SIZE);
      } catch {
        inventory = new Array(INVENTORY_SIZE).fill(null);
      }
      try {
        bank = normalizeSlotArray(row.bank ? JSON.parse(row.bank) : [], BANK_SIZE);
      } catch {
        bank = new Array(BANK_SIZE).fill(null);
      }

      const normalized = moveStackedRelicsToBankSlots(inventory, bank);
      blockedRelics += normalized.blocked;
      if (!normalized.changed) continue;
      updates.push({
        accountId: row.account_id,
        inventory: JSON.stringify(normalized.inventory),
        bank: JSON.stringify(normalized.bank),
      });
    }

    if (updates.length > 0) {
      const tx = this.db.transaction((rowsToUpdate: typeof updates) => {
        const stmt = this.db.query('UPDATE player_state SET inventory = ?, bank = ?, updated_at = unixepoch() WHERE account_id = ?');
        for (const update of rowsToUpdate) stmt.run(update.inventory, update.bank, update.accountId);
      });
      tx(updates);
    }
    if (blockedRelics > 0) {
      console.warn(`[migration] ${MOVE_STACKED_RELICS_TO_BANK_MIGRATION_ID}: ${blockedRelics} relic(s) could not move because banks were full; original inventory stacks were left intact.`);
    }
    return updates.length;
  }

  private removeRetiredResourceSavedState(): number {
    const rows = this.db.query('SELECT account_id, inventory, bank, equipment FROM player_state')
      .all() as Array<{ account_id: number; inventory: string | null; bank: string | null; equipment: string | null }>;
    const updates: Array<{ accountId: number; inventory: string; bank: string; equipment: string }> = [];

    for (const row of rows) {
      let inventoryJson = row.inventory;
      let bankJson = row.bank;
      let inventoryChanged = false;
      let bankChanged = false;

      for (const itemId of RETIRED_RESOURCE_ITEM_IDS) {
        const inventory = removeItemFromSavedSlots(inventoryJson, INVENTORY_SIZE, itemId);
        inventoryJson = inventory.json;
        inventoryChanged ||= inventory.changed;

        const bank = removeItemFromSavedSlots(bankJson, BANK_SIZE, itemId);
        bankJson = bank.json;
        bankChanged ||= bank.changed;
      }

      const equipment = removeItemsFromSavedEquipment(row.equipment, RETIRED_RESOURCE_ITEM_IDS);
      if (!inventoryChanged && !bankChanged && !equipment.changed) continue;
      updates.push({
        accountId: row.account_id,
        inventory: inventoryJson || JSON.stringify(new Array(INVENTORY_SIZE).fill(null)),
        bank: bankJson || JSON.stringify(new Array(BANK_SIZE).fill(null)),
        equipment: equipment.json,
      });
    }

    try {
      for (const defId of RETIRED_RESOURCE_OBJECT_IDS) {
        this.db.query('DELETE FROM world_object_respawn WHERE def_id = ?').run(defId);
      }
    } catch {
      // Fresh databases create world_object_respawn after one-time data migrations.
      // Existing production databases already have it, so stale retired-rock state is purged there.
    }
    if (updates.length === 0) return 0;
    const tx = this.db.transaction((rowsToUpdate: typeof updates) => {
      const stmt = this.db.query('UPDATE player_state SET inventory = ?, bank = ?, equipment = ?, updated_at = unixepoch() WHERE account_id = ?');
      for (const update of rowsToUpdate) {
        stmt.run(update.inventory, update.bank, update.equipment, update.accountId);
      }
    });
    tx(updates);
    return updates.length;
  }

  // -- Door state -----------------------------------------------------------

  saveDoorState(mapLevel: string, defId: number, tileX: number, tileZ: number, floor: number, isOpen: boolean, autoCloseAtTick: number | null): void {
    try {
      this.db.query(`
        INSERT INTO door_state (map_level, def_id, tile_x, tile_z, floor, is_open, auto_close_at_tick)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(map_level, def_id, tile_x, tile_z, floor) DO UPDATE SET
          is_open = excluded.is_open,
          auto_close_at_tick = excluded.auto_close_at_tick
      `).run(mapLevel, defId, tileX, tileZ, Math.floor(floor), isOpen ? 1 : 0, autoCloseAtTick);
    } catch (e) {
      console.error('saveDoorState failed:', e);
    }
  }

  loadAllDoorStates(): Array<{ mapLevel: string; defId: number; tileX: number; tileZ: number; floor: number; isOpen: boolean; autoCloseAtTick: number | null }> {
    try {
      const rows = this.db.query(`
        SELECT map_level, def_id, tile_x, tile_z, floor, is_open, auto_close_at_tick FROM door_state
      `).all() as Array<{ map_level: string; def_id: number; tile_x: number; tile_z: number; floor: number; is_open: number; auto_close_at_tick: number | null }>;
      return rows.map(r => ({
        mapLevel: r.map_level,
        defId: r.def_id,
        tileX: r.tile_x,
        tileZ: r.tile_z,
        floor: r.floor ?? 0,
        isOpen: r.is_open === 1,
        autoCloseAtTick: r.auto_close_at_tick,
      }));
    } catch (e) {
      console.error('loadAllDoorStates failed:', e);
      return [];
    }
  }

  clearDoorState(mapLevel: string, defId: number, tileX: number, tileZ: number, floor: number = 0): void {
    try {
      this.db.query('DELETE FROM door_state WHERE map_level = ? AND def_id = ? AND tile_x = ? AND tile_z = ? AND floor = ?')
        .run(mapLevel, defId, tileX, tileZ, Math.floor(floor));
    } catch (e) {
      console.error('clearDoorState failed:', e);
    }
  }

  // -- World object respawn -------------------------------------------------

  saveObjectRespawn(mapLevel: string, defId: number, tileX: number, tileZ: number, floor: number, respawnAtUnixMs: number): void {
    try {
      this.db.query(`
        INSERT INTO world_object_respawn (map_level, def_id, tile_x, tile_z, floor, respawn_at_unix_ms)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(map_level, def_id, tile_x, tile_z, floor) DO UPDATE SET
          respawn_at_unix_ms = excluded.respawn_at_unix_ms
      `).run(mapLevel, defId, tileX, tileZ, Math.floor(floor), respawnAtUnixMs);
    } catch (e) {
      console.error('saveObjectRespawn failed:', e);
    }
  }

  loadAllObjectRespawns(): Array<{ mapLevel: string; defId: number; tileX: number; tileZ: number; floor: number; respawnAtUnixMs: number }> {
    try {
      const rows = this.db.query(`
        SELECT map_level, def_id, tile_x, tile_z, floor, respawn_at_unix_ms FROM world_object_respawn
      `).all() as Array<{ map_level: string; def_id: number; tile_x: number; tile_z: number; floor: number; respawn_at_unix_ms: number }>;
      return rows.map(r => ({
        mapLevel: r.map_level,
        defId: r.def_id,
        tileX: r.tile_x,
        tileZ: r.tile_z,
        floor: r.floor ?? 0,
        respawnAtUnixMs: r.respawn_at_unix_ms,
      }));
    } catch (e) {
      console.error('loadAllObjectRespawns failed:', e);
      return [];
    }
  }

  clearObjectRespawn(mapLevel: string, defId: number, tileX: number, tileZ: number, floor: number = 0): void {
    try {
      this.db.query('DELETE FROM world_object_respawn WHERE map_level = ? AND def_id = ? AND tile_x = ? AND tile_z = ? AND floor = ?')
        .run(mapLevel, defId, tileX, tileZ, Math.floor(floor));
    } catch (e) {
      console.error('clearObjectRespawn failed:', e);
    }
  }

  applyObjectRespawnWritesBatch(writes: Array<
    | { type: 'save'; mapLevel: string; defId: number; tileX: number; tileZ: number; floor: number; respawnAtUnixMs: number }
    | { type: 'clear'; mapLevel: string; defId: number; tileX: number; tileZ: number; floor: number }
  >): void {
    if (writes.length === 0) return;
    const saveStmt = this.db.query(`
      INSERT INTO world_object_respawn (map_level, def_id, tile_x, tile_z, floor, respawn_at_unix_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(map_level, def_id, tile_x, tile_z, floor) DO UPDATE SET
        respawn_at_unix_ms = excluded.respawn_at_unix_ms
    `);
    const clearStmt = this.db.query('DELETE FROM world_object_respawn WHERE map_level = ? AND def_id = ? AND tile_x = ? AND tile_z = ? AND floor = ?');
    const tx = this.db.transaction((rows: typeof writes) => {
      for (const row of rows) {
        if (row.type === 'save') {
          saveStmt.run(row.mapLevel, row.defId, row.tileX, row.tileZ, Math.floor(row.floor), row.respawnAtUnixMs);
        } else {
          clearStmt.run(row.mapLevel, row.defId, row.tileX, row.tileZ, Math.floor(row.floor));
        }
      }
    });
    try {
      tx(writes);
    } catch (e) {
      console.error('applyObjectRespawnWritesBatch failed; falling back to per-row writes:', e);
      for (const row of writes) {
        if (row.type === 'save') this.saveObjectRespawn(row.mapLevel, row.defId, row.tileX, row.tileZ, row.floor, row.respawnAtUnixMs);
        else this.clearObjectRespawn(row.mapLevel, row.defId, row.tileX, row.tileZ, row.floor);
      }
    }
  }

  async createAccount(username: string, password: string, deviceId: string = ''): Promise<{ ok: true; token: string; wsSecret: string; accountId: number; isAdmin: boolean; isModerator: boolean } | { ok: false; error: string }> {
    if (!PUBLIC_SIGNUPS_ENABLED) return { ok: false, error: ACCOUNT_CREATION_CLOSED_MESSAGE };

    const usernameError = validateUsername(username);
    if (usernameError) return { ok: false, error: usernameError };
    const passwordError = validatePassword(password);
    if (passwordError) return { ok: false, error: passwordError };
    const deviceError = validateDeviceId(deviceId);
    if (deviceError) return { ok: false, error: deviceError };

    // Check if username exists
    const existing = this.db.query('SELECT id FROM accounts WHERE username = ?').get(username);
    if (existing) {
      return { ok: false, error: 'Username already taken' };
    }

    const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' });

    // Bootstrap admin: if no admin exists yet, the first 'mogn' signup gets
    // is_admin=1. Once any admin exists, new signups always get is_admin=0.
    // Keeps the historical "mogn is the dev admin" behavior working without
    // hardcoding the username outside this one bootstrap path.
    //
    // Race-safe: the count+insert pair runs inside a single IMMEDIATE
    // transaction so two concurrent "mogn" signups can't both see zero admins
    // and both get is_admin=1. SQLite serializes IMMEDIATE writes.
    const starterInventory = starterInventoryJson();
    const wantsAdmin = username.toLowerCase() === 'mogn';
    let accountId = 0;
    let isAdmin = 0;
    this.db.transaction(() => {
      const adminCount = (this.db.query('SELECT COUNT(*) as n FROM accounts WHERE is_admin = 1').get() as { n: number }).n;
      isAdmin = (adminCount === 0 && wantsAdmin) ? 1 : 0;
      const result = this.db.query('INSERT INTO accounts (username, password_hash, is_admin) VALUES (?, ?, ?)').run(username, passwordHash, isAdmin);
      accountId = Number(result.lastInsertRowid);
      this.db.query('INSERT INTO player_state (account_id, inventory) VALUES (?, ?)').run(accountId, starterInventory);
    }).immediate();

    // Create session
    const session = this.createSession(accountId, deviceId);
    return { ok: true, token: session.token, wsSecret: session.wsSecret, accountId, isAdmin: isAdmin === 1, isModerator: false };
  }

  async login(username: string, password: string, deviceId: string = ''): Promise<{ ok: true; token: string; wsSecret: string; username: string; accountId: number; isAdmin: boolean; isModerator: boolean } | { ok: false; error: string }> {
    const row = this.db.query('SELECT id, username, password_hash, is_admin, is_moderator FROM accounts WHERE username = ?').get(username) as { id: number; username: string; password_hash: string; is_admin: number; is_moderator: number } | null;
    if (!row) {
      return { ok: false, error: 'Invalid username or password' };
    }

    const valid = await Bun.password.verify(password, row.password_hash);
    if (!valid) {
      return { ok: false, error: 'Invalid username or password' };
    }

    const session = this.createSession(row.id, deviceId);
    return { ok: true, token: session.token, wsSecret: session.wsSecret, username: row.username, accountId: row.id, isAdmin: row.is_admin === 1, isModerator: row.is_moderator === 1 };
  }

  async verifyAccountPassword(username: string, password: string): Promise<AccountAuthInfo | null> {
    const row = this.db.query('SELECT id, username, password_hash, is_admin, is_moderator FROM accounts WHERE username = ?')
      .get(username) as { id: number; username: string; password_hash: string; is_admin: number; is_moderator: number } | null;
    if (!row) return null;
    const valid = await Bun.password.verify(password, row.password_hash);
    if (!valid) return null;
    return {
      accountId: row.id,
      username: row.username,
      isAdmin: row.is_admin === 1,
      isModerator: row.is_moderator === 1,
    };
  }

  getAccountAuthInfo(accountId: number): AccountAuthInfo | null {
    const row = this.db.query('SELECT id, username, is_admin, is_moderator FROM accounts WHERE id = ?')
      .get(accountId) as { id: number; username: string; is_admin: number; is_moderator: number } | null;
    if (!row) return null;
    return {
      accountId: row.id,
      username: row.username,
      isAdmin: row.is_admin === 1,
      isModerator: row.is_moderator === 1,
    };
  }

  loginFallbackAccount(username: string, deviceId: string = ''): { ok: true; token: string; wsSecret: string; username: string; accountId: number; isAdmin: boolean; isModerator: boolean } {
    const starterInventory = starterInventoryJson();
    let accountId = 0;
    let normalizedUsername = username.toLowerCase();
    let isAdmin = 0;
    let isModerator = 0;

    this.db.transaction(() => {
      let row = this.db.query('SELECT id, username, is_admin, is_moderator FROM accounts WHERE username = ?').get(normalizedUsername) as { id: number; username: string; is_admin: number; is_moderator: number } | null;
      if (!row) {
        const result = this.db.query('INSERT INTO accounts (username, password_hash, is_admin) VALUES (?, ?, 0)').run(normalizedUsername, 'fallback-login');
        accountId = Number(result.lastInsertRowid);
        this.db.query('INSERT OR IGNORE INTO player_state (account_id, inventory) VALUES (?, ?)').run(accountId, starterInventory);
        return;
      }
      accountId = row.id;
      normalizedUsername = row.username;
      isAdmin = row.is_admin;
      isModerator = row.is_moderator;
      this.db.query('INSERT OR IGNORE INTO player_state (account_id, inventory) VALUES (?, ?)').run(accountId, starterInventory);
    }).immediate();

    const session = this.createSession(accountId, deviceId);
    return { ok: true, token: session.token, wsSecret: session.wsSecret, username: normalizedUsername, accountId, isAdmin: isAdmin === 1, isModerator: isModerator === 1 };
  }

  createSession(
    accountId: number,
    deviceId: string = '',
    options: { expiresInMs?: number; oauthClientId?: string | null; oauthScopes?: string[] } = {},
  ): CreatedSession {
    const token = randomBytes(32).toString('hex');
    const wsSecret = randomBytes(32).toString('hex');
    const expiresAt = Math.floor((Date.now() + (options.expiresInMs ?? SESSION_EXPIRY_MS)) / 1000);
    const oauthClientId = options.oauthClientId ?? null;
    const oauthScopes = JSON.stringify(options.oauthScopes ?? []);
    // Drop any prior sessions for this account before inserting the new one.
    // Matches the "single active session" model already enforced in-game by
    // World.kickAccountIfOnline and prevents the sessions table from growing
    // unbounded per device-login.
    this.db.query('DELETE FROM sessions WHERE account_id = ?').run(accountId);
    this.db.query('INSERT INTO sessions (token, account_id, expires_at, device_id, ws_secret, oauth_client_id, oauth_scopes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(token, accountId, expiresAt, deviceId, wsSecret, oauthClientId, oauthScopes);
    return { token, wsSecret };
  }

  getSession(token: string): SessionInfo | null {
    if (!token) return null;
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.query(`
      SELECT s.account_id, a.username, a.is_admin, a.is_moderator, s.device_id, s.ws_secret, s.oauth_client_id, s.oauth_scopes
      FROM sessions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.token = ? AND s.expires_at > ?
    `).get(token, now) as { account_id: number; username: string; is_admin: number; is_moderator: number; device_id: string | null; ws_secret: string | null; oauth_client_id: string | null; oauth_scopes: string | null } | null;

    if (!row) return null;
    const oauthScopes = parseStoredStringArray(row.oauth_scopes);
    const isOAuthSession = !!row.oauth_client_id;
    return {
      accountId: row.account_id,
      username: row.username,
      isAdmin: row.is_admin === 1 && (!isOAuthSession || oauthScopes.includes('admin')),
      isModerator: row.is_moderator === 1 && (!isOAuthSession || oauthScopes.includes('moderator') || oauthScopes.includes('admin')),
      deviceId: row.device_id ?? '',
      wsSecret: row.ws_secret ?? '',
      oauthClientId: row.oauth_client_id ?? null,
      oauthScopes,
    };
  }

  ensureSessionWsSecret(token: string): string | null {
    if (!token) return null;
    const now = Math.floor(Date.now() / 1000);
    const row = this.db.query('SELECT ws_secret FROM sessions WHERE token = ? AND expires_at > ?')
      .get(token, now) as { ws_secret: string | null } | null;
    if (!row) return null;
    if (row.ws_secret) return row.ws_secret;
    const wsSecret = randomBytes(32).toString('hex');
    this.db.query('UPDATE sessions SET ws_secret = ? WHERE token = ?').run(wsSecret, token);
    return wsSecret;
  }

  createOAuthAuthorizationCode(input: {
    accountId: number;
    clientId: string;
    redirectUri: string;
    scopes: string[];
    codeChallenge: string;
  }): { code: string; expiresAt: number } {
    const code = randomBytes(32).toString('hex');
    const expiresAt = Math.floor((Date.now() + OAUTH_AUTH_CODE_EXPIRY_MS) / 1000);
    this.db.query(`
      INSERT INTO oauth_authorization_codes (code, account_id, client_id, redirect_uri, scopes, code_challenge, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(code, input.accountId, input.clientId, input.redirectUri, JSON.stringify(input.scopes), input.codeChallenge, expiresAt);
    return { code, expiresAt };
  }

  consumeOAuthAuthorizationCode(code: string, clientId: string, redirectUri: string): OAuthAuthorizationCodeRecord | null {
    const now = Math.floor(Date.now() / 1000);
    let record: OAuthAuthorizationCodeRecord | null = null;
    this.db.transaction(() => {
      const row = this.db.query(`
        SELECT code, account_id, client_id, redirect_uri, scopes, code_challenge, expires_at
        FROM oauth_authorization_codes
        WHERE code = ?
      `).get(code) as {
        code: string;
        account_id: number;
        client_id: string;
        redirect_uri: string;
        scopes: string;
        code_challenge: string;
        expires_at: number;
      } | null;
      if (!row) return;
      this.db.query('DELETE FROM oauth_authorization_codes WHERE code = ?').run(code);
      if (row.expires_at <= now || row.client_id !== clientId || row.redirect_uri !== redirectUri) return;
      record = {
        code: row.code,
        accountId: row.account_id,
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        scopes: parseStoredStringArray(row.scopes),
        codeChallenge: row.code_challenge,
        expiresAt: row.expires_at,
      };
    }).immediate();
    return record;
  }

  createOAuthSession(accountId: number, clientId: string, scopes: string[], deviceId: string = ''): OAuthSessionResult | null {
    const account = this.getAccountAuthInfo(accountId);
    if (!account) return null;
    const session = this.createSession(accountId, deviceId, {
      expiresInMs: OAUTH_ACCESS_TOKEN_EXPIRY_MS,
      oauthClientId: clientId,
      oauthScopes: scopes,
    });
    const refreshToken = randomBytes(32).toString('hex');
    const refreshTokenHash = hashOAuthToken(refreshToken);
    const now = Math.floor(Date.now() / 1000);
    const refreshExpiresAt = now + Math.floor(OAUTH_REFRESH_TOKEN_EXPIRY_MS / 1000);
    this.db.query('UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE account_id = ? AND client_id = ? AND revoked_at IS NULL')
      .run(now, accountId, clientId);
    this.db.query(`
      INSERT INTO oauth_refresh_tokens (token, account_id, client_id, scopes, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(refreshTokenHash, accountId, clientId, JSON.stringify(scopes), refreshExpiresAt);
    return {
      ...account,
      token: session.token,
      wsSecret: session.wsSecret,
      refreshToken,
      expiresIn: Math.floor(OAUTH_ACCESS_TOKEN_EXPIRY_MS / 1000),
      clientId,
      scopes,
    };
  }

  getOAuthRefreshTokenInfo(refreshToken: string, clientId: string): OAuthRefreshTokenInfo | null {
    const now = Math.floor(Date.now() / 1000);
    const refreshTokenHash = hashOAuthToken(refreshToken);
    const row = this.db.query(`
      SELECT account_id, client_id, scopes, expires_at
      FROM oauth_refresh_tokens
      WHERE token = ? AND client_id = ? AND revoked_at IS NULL AND expires_at > ?
    `).get(refreshTokenHash, clientId, now) as { account_id: number; client_id: string; scopes: string; expires_at: number } | null;
    if (!row) return null;
    return {
      accountId: row.account_id,
      clientId: row.client_id,
      scopes: parseStoredStringArray(row.scopes),
      expiresAt: row.expires_at,
    };
  }

  refreshOAuthSession(refreshToken: string, clientId: string, deviceId: string = ''): OAuthSessionResult | null {
    const now = Math.floor(Date.now() / 1000);
    const refreshTokenHash = hashOAuthToken(refreshToken);
    let result: OAuthSessionResult | null = null;
    this.db.transaction(() => {
      const row = this.db.query(`
        SELECT account_id, client_id, scopes, expires_at
        FROM oauth_refresh_tokens
        WHERE token = ? AND client_id = ? AND revoked_at IS NULL
      `).get(refreshTokenHash, clientId) as { account_id: number; client_id: string; scopes: string; expires_at: number } | null;
      if (!row || row.expires_at <= now) return;
      this.db.query('UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE token = ?').run(now, refreshTokenHash);
      result = this.createOAuthSession(row.account_id, row.client_id, parseStoredStringArray(row.scopes), deviceId);
    }).immediate();
    return result;
  }

  revokeOAuthToken(token: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.query('UPDATE oauth_refresh_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token = ?').run(now, hashOAuthToken(token));
    this.db.query('DELETE FROM sessions WHERE token = ?').run(token);
  }

  saveDeviceKey(accountId: number, deviceId: string, publicJwk: JsonWebKey): void {
    if (!accountId || !deviceId) throw new Error('missing account or device id');
    this.db.query(`
      INSERT INTO account_device_keys (account_id, device_id, public_jwk, updated_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(account_id, device_id) DO UPDATE SET
        public_jwk = excluded.public_jwk,
        updated_at = excluded.updated_at
    `).run(accountId, deviceId, JSON.stringify(publicJwk));
  }

  loadDeviceKey(accountId: number, deviceId: string): JsonWebKey | null {
    if (!accountId || !deviceId) return null;
    const row = this.db.query(`
      SELECT public_jwk FROM account_device_keys
      WHERE account_id = ? AND device_id = ?
    `).get(accountId, deviceId) as { public_jwk: string } | null;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.public_jwk) as JsonWebKey;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Lookup admin status by username. Used by chat socket where the username is
   *  bound at WS upgrade time and the account_id isn't kept on the socket. */
  isAdminUsername(username: string): boolean {
    const row = this.db.query('SELECT is_admin FROM accounts WHERE username = ?').get(username) as { is_admin: number } | null;
    return row?.is_admin === 1;
  }

  logout(token: string): void {
    this.db.query('DELETE FROM sessions WHERE token = ?').run(token);
  }

  /** Run a single player_state UPDATE. Shared body between the single-row
   *  savePlayerState() and the batched savePlayersBatch() — keeps the column
   *  list and serialization logic in one place. Does NOT wrap in a transaction
   *  itself; callers wrap as appropriate (batch transaction vs implicit per-
   *  call autocommit). */
  private savePlayerRow(accountId: number, player: Player, effectiveY: number): void {
    const skills: Record<string, { xp: number; level: number; currentLevel: number }> = {};
    for (const id of ALL_SKILLS) {
      skills[id] = {
        xp: player.skills[id].xp,
        level: player.skills[id].level,
        currentLevel: player.skills[id].currentLevel,
      };
    }

    const equipment: Record<string, number | { itemId: number; quantity: number }> = {};
    for (const [slot, itemId] of player.equipment) {
      const quantity = player.getEquipmentQuantity(slot);
      equipment[slot] = slot === 'ammo' || quantity !== 1
        ? { itemId, quantity }
        : itemId;
    }

    this.db.query(`
      UPDATE player_state SET
        x = ?, z = ?, y = ?, floor = ?,
        map_level = ?,
        skills = ?, inventory = ?, equipment = ?,
        stance = ?, magic_stance = ?, autocast_spell_index = ?, auto_retaliate = ?,
        appearance = COALESCE(?, appearance), bank = ?, quests = ?, renown = ?, updated_at = unixepoch()
      WHERE account_id = ?
    `).run(
      player.position.x, player.position.y, effectiveY, player.currentFloor,
      player.currentMapLevel,
      JSON.stringify(skills),
      JSON.stringify(player.inventory),
      JSON.stringify(equipment),
      player.stance,
      player.magicStance ?? 'accurate',
      Number.isInteger(player.autocastSpellIndex) ? Math.max(-1, player.autocastSpellIndex) : -1,
      player.autoRetaliate ? 1 : 0,
      player.appearance ? JSON.stringify(player.appearance) : null,
      JSON.stringify(player.bank),
      JSON.stringify(player.quests),
      Math.max(0, Math.floor(player.renown || 0)),
      accountId,
    );
    this.saveHiscoreSnapshots(accountId, player.skills);
  }

  savePlayerState(accountId: number, player: Player, effectiveY: number): void {
    this.savePlayerRow(accountId, player, effectiveY);
  }

  /** Cheap position-only checkpoint used by movement. Full state persistence
   *  still happens through savePlayerState/savePlayersBatch; this narrows the
   *  rollback window for relog/restart without serializing inventory, skills,
   *  bank, and quest JSON every walking tick. */
  savePlayerPosition(accountId: number, player: Player, effectiveY: number): void {
    this.db.query(`
      UPDATE player_state SET
        x = ?, z = ?, y = ?, floor = ?, map_level = ?, updated_at = unixepoch()
      WHERE account_id = ?
    `).run(
      player.position.x,
      player.position.y,
      effectiveY,
      player.currentFloor,
      player.currentMapLevel,
      accountId,
    );
  }

  savePlayerPositionsBatch(saves: Array<{ accountId: number; player: Player; effectiveY: number }>): void {
    if (saves.length === 0) return;
    const stmt = this.db.query(`
      UPDATE player_state SET
        x = ?, z = ?, y = ?, floor = ?, map_level = ?, updated_at = unixepoch()
      WHERE account_id = ?
    `);
    const tx = this.db.transaction((rows: Array<{ accountId: number; player: Player; effectiveY: number }>) => {
      for (const row of rows) {
        stmt.run(
          row.player.position.x,
          row.player.position.y,
          row.effectiveY,
          row.player.currentFloor,
          row.player.currentMapLevel,
          row.accountId,
        );
      }
    });
    try {
      tx(saves);
    } catch (e) {
      console.error('savePlayerPositionsBatch failed; falling back to per-row position saves:', e);
      for (const row of saves) {
        try {
          this.savePlayerPosition(row.accountId, row.player, row.effectiveY);
        } catch (rowErr) {
          console.error(`per-row position save failed for accountId=${row.accountId}:`, rowErr);
        }
      }
    }
  }

  /** Batched save: wraps every per-row UPDATE in a single SQLite transaction
   *  so 100+ players flush in one fsync instead of N. Called by the 15s
   *  auto-save loop in World.saveAllPlayers.
   *
   *  Failure mode: if any row throws (transient SQLITE_BUSY, structurally
   *  bad in-memory player field that JSON.stringify can't handle), the
   *  whole transaction rolls back — losing saves for every player in the
   *  batch. We fall back to per-row autocommits in that case so a single
   *  bad row only loses its own state, matching the pre-batch behavior. */
  savePlayersBatch(saves: Array<{ accountId: number; player: Player; effectiveY: number }>): void {
    if (saves.length === 0) return;
    const tx = this.db.transaction((rows: Array<{ accountId: number; player: Player; effectiveY: number }>) => {
      for (const r of rows) {
        this.savePlayerRow(r.accountId, r.player, r.effectiveY);
      }
    });
    try {
      tx(saves);
    } catch (e) {
      console.error('savePlayersBatch failed; falling back to per-row saves:', e);
      for (const r of saves) {
        try {
          this.savePlayerRow(r.accountId, r.player, r.effectiveY);
        } catch (rowErr) {
          console.error(`per-row save failed for accountId=${r.accountId}:`, rowErr);
        }
      }
    }
  }

  loadPlayerState(accountId: number): SavedPlayerState | null {
    const row = this.db.query('SELECT x, z, y, floor, map_level, skills, inventory, equipment, stance, magic_stance, autocast_spell_index, auto_retaliate, appearance, bank, respawn_version, quests, renown FROM player_state WHERE account_id = ?')
      .get(accountId) as { x: number; z: number; y: number | null; floor: number | null; map_level: string; skills: string; inventory: string; equipment: string; stance: string; magic_stance: string | null; autocast_spell_index: number | null; auto_retaliate: number | null; appearance: string | null; bank: string | null; respawn_version: number | null; quests: string | null; renown: number | null } | null;

    if (!row) return null;

    // Parse skills
    let skills: SkillBlock;
    try {
      const saved = JSON.parse(row.skills) as Record<string, { xp: number; level: number; currentLevel: number }>;
      skills = initSkills(); // Start with defaults
      for (const [rawId, skill] of Object.entries(saved)) {
        const id = normalizeSkillId(rawId);
        if (!id || !skill) continue;
        skills[id].xp = skill.xp;
        skills[id].level = skill.level;
        skills[id].currentLevel = skill.currentLevel;
      }
    } catch {
      skills = initSkills();
    }

    // Parse inventory. Post-load validation: a corrupted DB row (or hostile
    // migration) could carry negative quantities, non-integer item IDs, or
    // quantities past MAX_STACK. Drop bad entries — silently clamping a 4B
    // coin stack to 2.1B is the kinder behavior, but inviting an attacker to
    // craft a save row that imports as a 2.1B stack is worse. Same shape for
    // equipment/bank below.
    const MAX_STACK = 0x7FFFFFFF;
    const sanitizeSlot = (s: unknown): { itemId: number; quantity: number } | null => {
      if (!s || typeof s !== 'object') return null;
      const o = s as { itemId?: unknown; quantity?: unknown };
      const id = o.itemId;
      const q = o.quantity;
      if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) return null;
      if (typeof q !== 'number' || !Number.isInteger(q) || q <= 0 || q > MAX_STACK) return null;
      return { itemId: id, quantity: q };
    };
    let inventory: ({ itemId: number; quantity: number } | null)[];
    try {
      const raw = JSON.parse(row.inventory) as unknown[];
      inventory = Array.isArray(raw) ? raw.map(sanitizeSlot) : new Array(28).fill(null);
    } catch {
      inventory = new Array(28).fill(null);
    }

    // Parse equipment — same validation
    let equipment: Map<EquipSlot, number>;
    let equipmentQuantities: Map<EquipSlot, number>;
    try {
      const saved = JSON.parse(row.equipment) as Record<string, unknown>;
      equipment = new Map();
      equipmentQuantities = new Map();
      const validSlots: Set<string> = new Set(['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape', 'ammo']);
      for (const [slot, value] of Object.entries(saved)) {
        if (!validSlots.has(slot)) continue;
        let itemId: unknown = value;
        let quantity: unknown = 1;
        if (value && typeof value === 'object') {
          const entry = value as { itemId?: unknown; quantity?: unknown };
          itemId = entry.itemId;
          quantity = entry.quantity ?? 1;
        }
        if (typeof itemId !== 'number' || !Number.isInteger(itemId) || itemId <= 0) continue;
        if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_STACK) continue;
        equipment.set(slot as EquipSlot, itemId);
        if (slot === 'ammo' || quantity !== 1) equipmentQuantities.set(slot as EquipSlot, quantity);
      }
    } catch {
      equipment = new Map();
      equipmentQuantities = new Map();
    }

    // Parse stance
    const stance = VALID_STANCES.has(row.stance) ? row.stance as MeleeStance : 'accurate';
    const magicStance = VALID_STANCES.has(row.magic_stance ?? '') ? row.magic_stance as MagicStance : 'accurate';
    const autocastSpellIndex = typeof row.autocast_spell_index === 'number' && Number.isInteger(row.autocast_spell_index)
      ? Math.max(-1, row.autocast_spell_index)
      : -1;

    // Parse appearance (normalizeAppearance fills in missing fields from older saves)
    let appearance: PlayerAppearance | null = null;
    if (row.appearance) {
      try { appearance = normalizeAppearance(JSON.parse(row.appearance)); } catch { /* null */ }
    }

    // Parse bank — JSON array of slots, possibly null. Older accounts may
    // have no bank row yet (column was added by migration); fall back to empty.
    // Same sanitization as inventory.
    let bank: ({ itemId: number; quantity: number } | null)[];
    try {
      const raw = row.bank ? JSON.parse(row.bank) as unknown[] : [];
      bank = Array.isArray(raw) ? raw.map(sanitizeSlot) : [];
    } catch {
      bank = [];
    }
    const normalizedRelics = moveStackedRelicsToBankSlots(inventory, bank);
    if (normalizedRelics.changed) {
      inventory = normalizedRelics.inventory;
      bank = normalizedRelics.bank;
    }

    // Parse quests. Sanitize: only accept entries with numeric stage +
    // triggerProgress. A corrupted row falls back to an empty record so
    // quests can re-acquire normally.
    let quests: Record<string, QuestState> = {};
    try {
      const raw = row.quests ? JSON.parse(row.quests) as Record<string, unknown> : {};
      for (const [k, v] of Object.entries(raw)) {
        if (!v || typeof v !== 'object') continue;
        const o = v as { stage?: unknown; triggerProgress?: unknown; vars?: unknown };
        if (typeof o.stage !== 'number' || !Number.isInteger(o.stage)) continue;
        const prog = typeof o.triggerProgress === 'number' && Number.isInteger(o.triggerProgress) && o.triggerProgress >= 0
          ? o.triggerProgress : 0;
        const vars: Record<string, number> = {};
        if (o.vars && typeof o.vars === 'object') {
          for (const [varKey, varValue] of Object.entries(o.vars as Record<string, unknown>)) {
            if (typeof varValue === 'number' && Number.isInteger(varValue)) vars[varKey] = varValue;
          }
        }
        quests[k] = {
          stage: o.stage,
          triggerProgress: prog,
          ...(Object.keys(vars).length > 0 ? { vars } : {}),
        };
      }
    } catch {
      quests = {};
    }

    return {
      x: row.x,
      z: row.z,
      y: row.y ?? 0,
      floor: row.floor ?? 0,
      mapLevel: row.map_level || 'kcmap',
      skills,
      inventory,
      equipment,
      equipmentQuantities,
      stance,
      magicStance,
      autocastSpellIndex,
      autoRetaliate: row.auto_retaliate === 1,
      appearance,
      bank,
      respawnVersion: row.respawn_version ?? 0,
      quests,
      renown: Math.max(0, Math.floor(row.renown ?? 0)),
    };
  }

  /** Persist a forced-respawn migration atomically with the version bump. This
   *  closes the window where a restart/drop could leave the row stamped as
   *  migrated while still carrying the old position. */
  saveRespawnMigration(accountId: number, player: Player, effectiveY: number, version: number): void {
    this.db.query(`
      UPDATE player_state SET
        x = ?, z = ?, y = ?, floor = ?, map_level = ?,
        respawn_version = ?, updated_at = unixepoch()
      WHERE account_id = ?
    `).run(
      player.position.x,
      player.position.y,
      effectiveY,
      player.currentFloor,
      player.currentMapLevel,
      version,
      accountId,
    );
  }

  saveAppearance(accountId: number, appearance: PlayerAppearance): void {
    this.db.query('UPDATE player_state SET appearance = ? WHERE account_id = ?')
      .run(JSON.stringify(appearance), accountId);
  }

  saveStance(accountId: number, stance: MeleeStance): void {
    this.db.query('UPDATE player_state SET stance = ?, updated_at = unixepoch() WHERE account_id = ?')
      .run(stance, accountId);
  }

  saveMagicCombatState(accountId: number, autocastSpellIndex: number, magicStance: MagicStance): void {
    this.db.query('UPDATE player_state SET autocast_spell_index = ?, magic_stance = ?, updated_at = unixepoch() WHERE account_id = ?')
      .run(autocastSpellIndex, magicStance, accountId);
  }

  saveAutoRetaliate(accountId: number, enabled: boolean): void {
    this.db.query('UPDATE player_state SET auto_retaliate = ?, updated_at = unixepoch() WHERE account_id = ?')
      .run(enabled ? 1 : 0, accountId);
  }

  private hiscoreCategoryValue(categoryId: string, skills: SkillBlock): { level: number; xp: number } {
    if (categoryId === 'combat') {
      return {
        level: combatLevel(skills),
        xp: ALL_SKILLS.reduce((sum, id) => sum + skills[id].xp, 0),
      };
    }
    if (categoryId === 'overall') {
      return {
        level: ALL_SKILLS.reduce((sum, id) => sum + skills[id].level, 0),
        xp: ALL_SKILLS.reduce((sum, id) => sum + skills[id].xp, 0),
      };
    }
    const skillId = categoryId as SkillId;
    return {
      level: skills[skillId].level,
      xp: skills[skillId].xp,
    };
  }

  private saveHiscoreSnapshots(accountId: number, skills: SkillBlock): void {
    const now = Math.floor(Date.now() / 1000);
    const bucketStart = Math.floor(now / 3600) * 3600;
    const categories = ['overall', 'combat', ...ALL_SKILLS];
    const snapshotKey = `${bucketStart}|${categories.map((categoryId) => {
      const value = this.hiscoreCategoryValue(categoryId, skills);
      return `${categoryId}:${value.level}:${value.xp}`;
    }).join('|')}`;
    if (this.lastHiscoreSnapshotKeys.get(accountId) === snapshotKey) {
      if (now - this.lastHiscoreSnapshotPruneAt > 6 * 3600) {
        this.lastHiscoreSnapshotPruneAt = now;
        this.db.query('DELETE FROM hiscore_snapshots WHERE bucket_start < ?').run(now - 8 * 24 * 3600);
      }
      return;
    }
    this.lastHiscoreSnapshotKeys.set(accountId, snapshotKey);
    const stmt = this.db.query(`
      INSERT INTO hiscore_snapshots (account_id, category, bucket_start, level, xp)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, category, bucket_start) DO UPDATE SET
        level = excluded.level,
        xp = excluded.xp
    `);
    for (const categoryId of categories) {
      const value = this.hiscoreCategoryValue(categoryId, skills);
      stmt.run(accountId, categoryId, bucketStart, value.level, value.xp);
    }

    // Keep roughly eight days of hourly history. This is enough for daily
    // gains plus a little deploy/restart slack without letting the table grow
    // forever during a playtest.
    if (now - this.lastHiscoreSnapshotPruneAt > 6 * 3600) {
      this.lastHiscoreSnapshotPruneAt = now;
      this.db.query('DELETE FROM hiscore_snapshots WHERE bucket_start < ?').run(now - 8 * 24 * 3600);
    }
  }

  private hiscoreCategories(players: HiscorePlayerRecord[] = []): HiscoreCategory[] {
    const startingSkills = initSkills();
    const hasEarnedSkillXp = (skillId: SkillId): boolean => {
      return players.some((player) => player.skills[skillId].xp > startingSkills[skillId].xp);
    };

    return [
      { id: 'overall', name: 'Overall', hasXp: true },
      { id: 'combat', name: 'Combat', hasXp: true },
      ...ALL_SKILLS.map((id) => ({ id, name: SKILL_NAMES[id], hasXp: hasEarnedSkillXp(id) })),
    ];
  }

  private parseHiscoreSkills(rawSkills: string): SkillBlock {
    const skills = initSkills();
    try {
      const saved = JSON.parse(rawSkills) as Record<string, Partial<SkillBlock[SkillId]>>;
      for (const [rawId, skill] of Object.entries(saved)) {
        const id = normalizeSkillId(rawId);
        if (!id || !skill) continue;
        const xp = typeof skill.xp === 'number' && Number.isFinite(skill.xp) ? Math.max(0, Math.floor(skill.xp)) : skills[id].xp;
        const level = typeof skill.level === 'number' && Number.isFinite(skill.level) ? Math.max(1, Math.floor(skill.level)) : skills[id].level;
        const currentLevel = typeof skill.currentLevel === 'number' && Number.isFinite(skill.currentLevel)
          ? Math.max(0, Math.floor(skill.currentLevel))
          : level;
        skills[id] = { xp, level, currentLevel };
      }
    } catch {
      // Keep default level-1/10hp skills for corrupted or legacy rows.
    }
    return skills;
  }

  private normalizeHiscoreCategoryId(categoryId: string): string {
    if (categoryId === 'overall' || categoryId === 'combat') return categoryId;
    return normalizeSkillId(categoryId) ?? categoryId;
  }

  private loadHiscorePlayers(options: { includeAdmins?: boolean } = {}): HiscorePlayerRecord[] {
    const adminFilter = options.includeAdmins ? '' : 'AND a.is_admin = 0';
    const rows = this.db.query(`
      SELECT ps.account_id, a.username, a.is_admin, a.is_moderator, ps.skills
      FROM player_state ps
      JOIN accounts a ON a.id = ps.account_id
      LEFT JOIN account_bans ab
        ON ab.account_id = a.id
       AND (ab.expires_at IS NULL OR ab.expires_at > unixepoch())
      WHERE ab.account_id IS NULL
        ${adminFilter}
    `).all() as Array<{ account_id: number; username: string; is_admin: number; is_moderator: number; skills: string }>;

    return rows
      // Anti-bot test accounts can produce artificial XP; keep them out of public rankings.
      .filter((row) => !isHiscoreExcludedUsername(row.username))
      .map((row) => ({
        accountId: row.account_id,
        username: row.username,
        isAdmin: row.is_admin === 1,
        isRoleModerator: row.is_moderator === 1,
        skills: this.parseHiscoreSkills(row.skills),
      }));
  }

  private loadDailyHiscoreBaselines(categoryId: string, cutoff: number): Map<number, number> {
    const baselineRows = this.db.query(`
      SELECT hs.account_id, hs.xp
      FROM hiscore_snapshots hs
      JOIN (
        SELECT account_id, MAX(bucket_start) AS bucket_start
        FROM hiscore_snapshots
        WHERE category = ? AND bucket_start <= ?
        GROUP BY account_id
      ) latest
        ON latest.account_id = hs.account_id
       AND latest.bucket_start = hs.bucket_start
      WHERE hs.category = ?
    `).all(categoryId, cutoff, categoryId) as Array<{ account_id: number; xp: number }>;
    const dailyBaselineXp = new Map<number, number>();
    for (const row of baselineRows) dailyBaselineXp.set(row.account_id, row.xp);
    return dailyBaselineXp;
  }

  private loadPreviousHiscoreRanks(categoryId: string, cutoff: number): Map<number, number> {
    const rows = this.db.query(`
      SELECT hs.account_id, a.username, hs.level, hs.xp
      FROM hiscore_snapshots hs
      JOIN (
        SELECT account_id, MAX(bucket_start) AS bucket_start
        FROM hiscore_snapshots
        WHERE category = ? AND bucket_start <= ?
        GROUP BY account_id
      ) latest
        ON latest.account_id = hs.account_id
       AND latest.bucket_start = hs.bucket_start
      JOIN accounts a ON a.id = hs.account_id
      LEFT JOIN account_bans ab
        ON ab.account_id = a.id
       AND (ab.expires_at IS NULL OR ab.expires_at > unixepoch())
      WHERE hs.category = ? AND ab.account_id IS NULL AND a.is_admin = 0
    `).all(categoryId, cutoff, categoryId) as Array<{ account_id: number; username: string; level: number; xp: number }>;

    const ranks = new Map<number, number>();
    rows
      .filter((row) => !isHiscoreExcludedUsername(row.username))
      .sort((a, b) => b.level - a.level || b.xp - a.xp || a.username.localeCompare(b.username))
      .forEach((row, idx) => ranks.set(row.account_id, idx + 1));
    return ranks;
  }

  private loadDailyMobKillBaselines(accountId: number, cutoff: number): Map<number, number> {
    const rows = this.db.query(`
      SELECT mks.npc_def_id, mks.kills
      FROM mob_kill_snapshots mks
      JOIN (
        SELECT npc_def_id, MAX(bucket_start) AS bucket_start
        FROM mob_kill_snapshots
        WHERE account_id = ? AND bucket_start <= ?
        GROUP BY npc_def_id
      ) latest
        ON latest.npc_def_id = mks.npc_def_id
       AND latest.bucket_start = mks.bucket_start
      WHERE mks.account_id = ?
    `).all(accountId, cutoff, accountId) as Array<{ npc_def_id: number; kills: number }>;
    return new Map(rows.map((row) => [row.npc_def_id, row.kills]));
  }

  private mobKillRank(npcDefId: number, accountId: number): number {
    const rows = this.db.query(`
      SELECT mk.account_id, a.username, mk.kills
      FROM mob_kills mk
      JOIN accounts a ON a.id = mk.account_id
      LEFT JOIN account_bans ab
        ON ab.account_id = a.id
       AND (ab.expires_at IS NULL OR ab.expires_at > unixepoch())
      WHERE mk.npc_def_id = ? AND mk.kills > 0 AND ab.account_id IS NULL AND a.is_admin = 0
    `).all(npcDefId) as Array<{ account_id: number; username: string; kills: number }>;

    const rank = rows
      .filter((row) => !isHiscoreExcludedUsername(row.username))
      .sort((a, b) => b.kills - a.kills || a.username.localeCompare(b.username))
      .findIndex((row) => row.account_id === accountId);
    return rank >= 0 ? rank + 1 : 0;
  }

  private saveMobKillSnapshot(accountId: number, npcDefId: number, kills: number): void {
    const now = Math.floor(Date.now() / 1000);
    const bucketStart = Math.floor(now / 3600) * 3600;
    this.db.query(`
      INSERT INTO mob_kill_snapshots (account_id, npc_def_id, bucket_start, kills)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id, npc_def_id, bucket_start) DO UPDATE SET
        kills = excluded.kills
    `).run(accountId, npcDefId, bucketStart, kills);

    if (now - this.lastHiscoreSnapshotPruneAt > 6 * 3600) {
      this.lastHiscoreSnapshotPruneAt = now;
      this.db.query('DELETE FROM mob_kill_snapshots WHERE bucket_start < ?').run(now - 8 * 24 * 3600);
    }
  }

  private rankedHiscoreRows(category: HiscoreCategory, players: HiscorePlayerRecord[], cutoff: number): RankedHiscoreRow[] {
    const dailyBaselineXp = this.loadDailyHiscoreBaselines(category.id, cutoff);
    const previousRanks = this.loadPreviousHiscoreRanks(category.id, cutoff);
    return players
      .map((row) => {
        const value = this.hiscoreCategoryValue(category.id, row.skills);
        const baselineXp = dailyBaselineXp.get(row.accountId);
        return {
          accountId: row.accountId,
          username: row.username,
          isRoleModerator: row.isRoleModerator,
          level: value.level,
          xp: value.xp,
          dailyXp: baselineXp == null ? 0 : Math.max(0, value.xp - baselineXp),
          rankChange: null,
        };
      })
      .sort((a, b) => b.level - a.level || b.xp - a.xp || a.username.localeCompare(b.username))
      .map((row, idx) => {
        const rank = idx + 1;
        const previousRank = previousRanks.get(row.accountId);
        return {
          rank,
          ...row,
          rankChange: previousRank == null ? null : previousRank - rank,
        };
      });
  }

  getHiscores(
    categoryId: string = 'overall',
    limit: number = 25,
    page: number = 1,
    query: string = '',
    sortKey: string = 'rank',
    sortDirection: string = 'asc',
  ): HiscoreResponse {
    const players = this.loadHiscorePlayers();
    const categories = this.hiscoreCategories(players);
    const requestedCategoryId = this.normalizeHiscoreCategoryId(categoryId);
    const category = categories.find((c) => c.id === requestedCategoryId) ?? categories[0];
    const cappedLimit = Math.max(5, Math.min(100, Math.floor(limit) || 25));
    const currentPage = Math.max(1, Math.floor(page) || 1);
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
    const ranked = this.rankedHiscoreRows(category, players, cutoff);
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery
      ? ranked.filter((row) => row.username.toLowerCase().includes(normalizedQuery))
      : ranked;
    const sorted = sortHiscoreRows(filtered, sortKey, sortDirection);

    const totalRows = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / cappedLimit));
    const safePage = Math.min(currentPage, totalPages);
    const start = (safePage - 1) * cappedLimit;

    return {
      category,
      categories,
      rows: sorted.slice(start, start + cappedLimit).map(({ accountId: _accountId, ...row }) => row),
      page: safePage,
      pageSize: cappedLimit,
      totalRows,
      totalPages,
    };
  }

  getHiscoreProfile(username: string, mobs: MobKillMob[] = []): HiscoreProfileResponse | null {
    const normalizedUsername = username.trim().toLowerCase();
    if (!normalizedUsername) return null;

    const players = this.loadHiscorePlayers();
    const categories = this.hiscoreCategories(players);
    const target = this.loadHiscorePlayers({ includeAdmins: true }).find((player) => player.username.toLowerCase() === normalizedUsername);
    if (!target) return null;
    const avatarState = this.db.query(`
      SELECT ps.appearance, ps.equipment
      FROM player_state ps
      WHERE ps.account_id = ?
    `).get(target.accountId) as { appearance: string | null; equipment: string | null } | null;
    const avatarUrl = forumAvatarTarget(
      target.accountId,
      target.username,
      avatarState?.appearance ?? null,
      avatarState?.equipment ?? null,
    )?.url ?? '';

    const cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
    const rows = categories.map((category) => {
      if (target.isAdmin) {
        const value = this.hiscoreCategoryValue(category.id, target.skills);
        const dailyBaselineXp = this.loadDailyHiscoreBaselines(category.id, cutoff).get(target.accountId);
        return {
          category,
          rank: 0,
          level: value.level,
          xp: value.xp,
          dailyXp: dailyBaselineXp == null ? 0 : Math.max(0, value.xp - dailyBaselineXp),
          rankChange: null,
        };
      }
      const ranked = this.rankedHiscoreRows(category, players, cutoff);
      const row = ranked.find((entry) => entry.accountId === target.accountId);
      return {
        category,
        rank: row?.rank ?? 0,
        level: row?.level ?? 0,
        xp: row?.xp ?? 0,
        dailyXp: row?.dailyXp ?? 0,
        rankChange: row?.rankChange ?? null,
      };
    });
    const mobNames = new Map(mobs.map((mob) => [mob.id, mob.name]));
    const dailyMobBaselines = this.loadDailyMobKillBaselines(target.accountId, cutoff);
    const monsterKills = (this.db.query(`
      SELECT npc_def_id, kills
      FROM mob_kills
      WHERE account_id = ? AND kills > 0
      ORDER BY kills DESC, npc_def_id ASC
      LIMIT 10
    `).all(target.accountId) as Array<{ npc_def_id: number; kills: number }>)
      .map((row) => ({
        npcDefId: row.npc_def_id,
        name: mobNames.get(row.npc_def_id) ?? `NPC ${row.npc_def_id}`,
        rank: this.mobKillRank(row.npc_def_id, target.accountId),
        kills: row.kills,
        dailyKills: dailyMobBaselines.has(row.npc_def_id)
          ? Math.max(0, row.kills - (dailyMobBaselines.get(row.npc_def_id) ?? row.kills))
          : 0,
      }));

    return {
      username: target.username,
      isRoleModerator: target.isRoleModerator,
      avatarUrl,
      rows,
      monsterKills,
    };
  }

  /** Credit one kill of a given mob to an account. Called on the NPC-death hot
   *  path, so it's a single indexed UPSERT — no read-modify-write, no contention
   *  with the batched player_state save, and it persists immediately (crash-safe
   *  between saves). Banned/excluded accounts are filtered at read time, so we
   *  always record here and keep the hot path branch-free. */
  recordMobKill(accountId: number, npcDefId: number, delta: number = 1): void {
    this.db.query(`
      INSERT INTO mob_kills (account_id, npc_def_id, kills)
      VALUES (?, ?, ?)
      ON CONFLICT(account_id, npc_def_id) DO UPDATE SET
        kills = kills + excluded.kills,
        updated_at = unixepoch()
    `).run(accountId, npcDefId, delta);
    const row = this.db.query('SELECT kills FROM mob_kills WHERE account_id = ? AND npc_def_id = ?')
      .get(accountId, npcDefId) as { kills: number } | null;
    if (row) this.saveMobKillSnapshot(accountId, npcDefId, row.kills);
  }

  private normalizeGameEventInput(input: GameEventLogInput): PendingGameEventLogEntry | null {
    const createdAt = Math.floor(Date.now() / 1000);
    const type = trimmedText(input.type, 40) ?? 'system';
    const severity = trimmedText(input.severity, 20) ?? 'info';
    const message = trimmedText(input.message, 500);
    if (!message) return null;

    const details = input.details && typeof input.details === 'object' && !Array.isArray(input.details)
      ? input.details
      : {};
    let detailsJson = '{}';
    try {
      const rawDetailsJson = JSON.stringify(details);
      detailsJson = rawDetailsJson.length <= 12000
        ? rawDetailsJson
        : JSON.stringify({ truncated: true, originalLength: rawDetailsJson.length });
    } catch {
      detailsJson = '{}';
    }

    const entry = {
      createdAt,
      type,
      severity,
      message,
      actorAccountId: nullableInteger(input.actorAccountId),
      actorName: trimmedText(input.actorName, 80),
      targetAccountId: nullableInteger(input.targetAccountId),
      targetName: trimmedText(input.targetName, 80),
      npcDefId: nullableInteger(input.npcDefId),
      npcName: trimmedText(input.npcName, 80),
      itemId: nullableInteger(input.itemId),
      itemName: trimmedText(input.itemName, 120),
      quantity: nullableInteger(input.quantity),
      mapLevel: trimmedText(input.mapLevel, 80),
      floor: nullableInteger(input.floor),
      x: nullableFiniteNumber(input.x),
      z: nullableFiniteNumber(input.z),
      details,
      detailsJson,
    };
    return entry;
  }

  recordGameEvent(input: GameEventLogInput): GameEventLogEntry | null {
    const entry = this.normalizeGameEventInput(input);
    if (!entry) return null;

    if (this.gameEventQueue.length >= GAME_EVENT_LOG_MAX_QUEUE_SIZE) {
      this.gameEventQueue.shift();
      this.gameEventDroppedSinceFlush++;
    }
    this.gameEventQueue.push(entry);
    this.scheduleGameEventFlush(this.gameEventQueue.length >= GAME_EVENT_LOG_BATCH_SIZE ? 0 : GAME_EVENT_LOG_FLUSH_INTERVAL_MS);

    const { detailsJson: _detailsJson, ...publicEntry } = entry;
    return { id: 0, ...publicEntry };
  }

  private scheduleGameEventFlush(delayMs: number = GAME_EVENT_LOG_FLUSH_INTERVAL_MS): void {
    if (this.gameEventFlushTimer !== null) {
      if (delayMs > 0) return;
      clearTimeout(this.gameEventFlushTimer);
    }
    this.gameEventFlushTimer = setTimeout(() => {
      this.gameEventFlushTimer = null;
      this.flushGameEventLog();
    }, delayMs);
  }

  private insertGameEventBatch(batch: PendingGameEventLogEntry[]): void {
    if (batch.length === 0) return;
    const insert = this.db.query(`
        INSERT INTO game_event_log (
          created_at, type, severity, message,
          actor_account_id, actor_name, target_account_id, target_name,
          npc_def_id, npc_name, item_id, item_name, quantity,
          map_level, floor, x, z, details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    const tx = this.db.transaction((entries: PendingGameEventLogEntry[]) => {
      for (const entry of entries) {
        insert.run(
          entry.createdAt,
          entry.type,
          entry.severity,
          entry.message,
          entry.actorAccountId,
          entry.actorName,
          entry.targetAccountId,
          entry.targetName,
          entry.npcDefId,
          entry.npcName,
          entry.itemId,
          entry.itemName,
          entry.quantity,
          entry.mapLevel,
          entry.floor,
          entry.x,
          entry.z,
          entry.detailsJson,
        );
      }
    });
    tx(batch);
  }

  private pruneGameEventLog(nowMs: number = Date.now()): void {
    if (GAME_EVENT_LOG_RETENTION_DAYS <= 0) return;
    if (nowMs - this.lastGameEventLogPruneAt < GAME_EVENT_LOG_PRUNE_INTERVAL_MS) return;
    this.lastGameEventLogPruneAt = nowMs;
    const cutoff = Math.floor(nowMs / 1000) - GAME_EVENT_LOG_RETENTION_DAYS * 24 * 60 * 60;
    try {
      this.db.query('DELETE FROM game_event_log WHERE created_at < ?').run(cutoff);
    } catch (e) {
      console.warn('[game-event-log] prune failed:', e instanceof Error ? e.message : e);
    }
  }

  flushGameEventLog(): number {
    if (this.gameEventFlushTimer !== null) {
      clearTimeout(this.gameEventFlushTimer);
      this.gameEventFlushTimer = null;
    }

    let flushed = 0;
    while (this.gameEventQueue.length > 0) {
      const batch = this.gameEventQueue.splice(0, GAME_EVENT_LOG_BATCH_SIZE);
      try {
        this.insertGameEventBatch(batch);
        flushed += batch.length;
      } catch (e) {
        this.gameEventQueue.unshift(...batch);
        console.warn('[game-event-log] flush failed:', e instanceof Error ? e.message : e);
        this.scheduleGameEventFlush(GAME_EVENT_LOG_FLUSH_INTERVAL_MS);
        break;
      }
    }

    if (this.gameEventQueue.length === 0 && this.gameEventDroppedSinceFlush > 0) {
      const dropped = this.gameEventDroppedSinceFlush;
      this.gameEventDroppedSinceFlush = 0;
      const overflow = this.normalizeGameEventInput({
        type: 'system',
        severity: 'warning',
        message: `Dropped ${dropped} game event log entr${dropped === 1 ? 'y' : 'ies'} because the write queue was full`,
        details: {
          reason: 'game_event_queue_full',
          dropped,
          maxQueueSize: GAME_EVENT_LOG_MAX_QUEUE_SIZE,
        },
      });
      if (overflow) {
        try {
          this.insertGameEventBatch([overflow]);
          flushed++;
        } catch (e) {
          console.warn('[game-event-log] overflow marker insert failed:', e instanceof Error ? e.message : e);
        }
      }
    }

    this.pruneGameEventLog();
    return flushed;
  }

  getLatestGameEventLogId(): number {
    this.flushGameEventLog();
    const row = this.db.query('SELECT COALESCE(MAX(id), 0) AS latest_id FROM game_event_log').get() as { latest_id: number } | null;
    return row?.latest_id ?? 0;
  }

  getGameEventLogSnapshot(options: GameEventLogListOptions = {}): GameEventLogSnapshot {
    this.flushGameEventLog();
    const row = this.db.query('SELECT COALESCE(MAX(id), 0) AS latest_id FROM game_event_log').get() as { latest_id: number } | null;
    return {
      latestId: row?.latest_id ?? 0,
      events: this.readGameEventLogRows(options),
    };
  }

  listGameEventLog(options: GameEventLogListOptions = {}): GameEventLogEntry[] {
    this.flushGameEventLog();
    return this.readGameEventLogRows(options);
  }

  private readGameEventLogRows(options: GameEventLogListOptions = {}): GameEventLogEntry[] {
    const afterId = Math.max(0, Math.floor(Number(options.afterId) || 0));
    const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(options.limit) || 200)));
    const excludeTypes = [...new Set((options.excludeTypes ?? [])
      .map(type => trimmedText(type, 40))
      .filter((type): type is string => !!type))]
      .slice(0, 32);
    const whereParts = ['1 = 1'];
    const params: Array<string | number> = [];
    if (afterId > 0) {
      whereParts.push('id > ?');
      params.push(afterId);
    }
    if (excludeTypes.length > 0) {
      whereParts.push(`type NOT IN (${excludeTypes.map(() => '?').join(', ')})`);
      params.push(...excludeTypes);
    }
    const userFilter = trimmedText(options.user, 80);
    if (userFilter) {
      const pattern = sqlLikePattern(userFilter);
      whereParts.push(`(
        lower(COALESCE(actor_name, '')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(target_name, '')) LIKE ? ESCAPE '\\'
      )`);
      params.push(pattern, pattern);
    }
    const searchQuery = trimmedText(options.query, 160);
    if (searchQuery) {
      const pattern = sqlLikePattern(searchQuery);
      whereParts.push(`(
        lower(type) LIKE ? ESCAPE '\\'
        OR lower(severity) LIKE ? ESCAPE '\\'
        OR lower(message) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(actor_name, '')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(target_name, '')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(npc_name, '')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(item_name, '')) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(map_level, '')) LIKE ? ESCAPE '\\'
        OR lower(details) LIKE ? ESCAPE '\\'
      )`);
      params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern);
    }
    const sql = `
      SELECT id, created_at, type, severity, message,
             actor_account_id, actor_name, target_account_id, target_name,
             npc_def_id, npc_name, item_id, item_name, quantity,
             map_level, floor, x, z, details
      FROM game_event_log
      WHERE ${whereParts.join(' AND ')}
      ORDER BY id ${afterId > 0 ? 'ASC' : 'DESC'}
      LIMIT ?
    `;
    const rows = this.db.query(sql).all(...params, safeLimit) as Array<{
        id: number;
        created_at: number;
        type: string;
        severity: string;
        message: string;
        actor_account_id: number | null;
        actor_name: string | null;
        target_account_id: number | null;
        target_name: string | null;
        npc_def_id: number | null;
        npc_name: string | null;
        item_id: number | null;
        item_name: string | null;
        quantity: number | null;
        map_level: string | null;
        floor: number | null;
        x: number | null;
        z: number | null;
        details: string | null;
      }>;

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      type: row.type,
      severity: row.severity,
      message: row.message,
      actorAccountId: row.actor_account_id,
      actorName: row.actor_name,
      targetAccountId: row.target_account_id,
      targetName: row.target_name,
      npcDefId: row.npc_def_id,
      npcName: row.npc_name,
      itemId: row.item_id,
      itemName: row.item_name,
      quantity: row.quantity,
      mapLevel: row.map_level,
      floor: row.floor,
      x: row.x,
      z: row.z,
      details: parseJsonObject(row.details) ?? {},
    }));
  }

  /** Per-mob kill leaderboard. `mobs` is the selectable mob list (id+name)
   *  supplied by the caller from the NPC defs; the response echoes it so the
   *  client can build its mob picker from one request. When `npcDefId` is null
   *  or not a known mob, falls back to the first mob in the (name-sorted) list.
   *  Reuses the same ban + excluded-username filtering as the skill hiscores so
   *  test/banned accounts never leak into public rankings. */
  getMobKillHiscores(
    npcDefId: number | null,
    limit: number = 25,
    page: number = 1,
    query: string = '',
    mobs: MobKillMob[] = [],
    sortKey: string = 'rank',
    sortDirection: string = 'asc',
  ): MobKillResponse {
    const cappedLimit = Math.max(5, Math.min(100, Math.floor(limit) || 25));
    const currentPage = Math.max(1, Math.floor(page) || 1);
    const sortedMobs = [...mobs].sort((a, b) => a.name.localeCompare(b.name));
    const effectiveId =
      npcDefId != null && sortedMobs.some((m) => m.id === npcDefId)
        ? npcDefId
        : sortedMobs[0]?.id ?? npcDefId ?? 0;
    const selectedMob = sortedMobs.find((m) => m.id === effectiveId);
    const mobName = selectedMob?.name ?? `NPC ${effectiveId}`;

    const rows = this.db.query(`
      SELECT a.username, a.is_moderator, mk.kills
      FROM mob_kills mk
      JOIN accounts a ON a.id = mk.account_id
      LEFT JOIN account_bans ab
        ON ab.account_id = a.id
       AND (ab.expires_at IS NULL OR ab.expires_at > unixepoch())
      WHERE mk.npc_def_id = ? AND ab.account_id IS NULL AND a.is_admin = 0 AND mk.kills > 0
    `).all(effectiveId) as Array<{ username: string; is_moderator: number; kills: number }>;

    const ranked = rows
      // Same anti-bot/test-account exclusion the skill hiscores apply.
      .filter((row) => !isHiscoreExcludedUsername(row.username))
      .sort((a, b) => b.kills - a.kills || a.username.localeCompare(b.username))
      .map((row, idx) => ({ rank: idx + 1, username: row.username, isRoleModerator: row.is_moderator === 1, kills: row.kills }));

    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery
      ? ranked.filter((row) => row.username.toLowerCase().includes(normalizedQuery))
      : ranked;
    const sorted = sortMobKillRows(filtered, sortKey, sortDirection);

    const totalRows = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / cappedLimit));
    const safePage = Math.min(currentPage, totalPages);
    const start = (safePage - 1) * cappedLimit;

    return {
      npcDefId: effectiveId,
      mobName,
      visual: selectedMob?.visual,
      mobs: sortedMobs,
      rows: sorted.slice(start, start + cappedLimit),
      page: safePage,
      pageSize: cappedLimit,
      totalRows,
      totalPages,
    };
  }

  /** Load the bot-detection telemetry blob for an account. Returns a row
   *  the caller can rehydrate into a BotStats instance, or null if the
   *  account has never logged in (BotStats will start fresh). */
  loadBotStats(accountId: number): BotStatsRow | null {
    const row = this.db.query(`
	      SELECT total_skilling_actions, total_combat_swings, total_movements,
	             total_chat_messages, total_session_minutes, total_flag_events,
	             total_suspicious_packets,
	             last_chat_ts, last_action_ts, last_login_ts,
	             risk_score, risk_level, risk_reasons,
	             tick_align_samples, reaction_samples, path_destinations,
	             action_signatures, ping_interval_samples, device_ids,
	             suspicious_packet_reasons, xp_baseline, last_session_summary, session_history
	      FROM bot_stats WHERE account_id = ?
	    `).get(accountId) as BotStatsRow | null;
    return row;
  }

  /** Record a new login session. Returns the rowid so handlePlayerDisconnect
   *  can finalize it without re-querying. */
  recordLogin(accountId: number, ip: string, deviceId: string = ''): number {
    const result = this.db.query(
      `INSERT INTO login_history (account_id, ip_address, login_ts, device_id) VALUES (?, ?, unixepoch(), ?)`
    ).run(accountId, ip, deviceId);
    return Number(result.lastInsertRowid);
  }

  getLastLoginTs(accountId: number): number | null {
    const row = this.db.query(
      `SELECT login_ts FROM login_history WHERE account_id = ? ORDER BY login_ts DESC LIMIT 1`
    ).get(accountId) as { login_ts: number | null } | null;
    return row?.login_ts ?? null;
  }

  /** Finalize an in-progress session row. Called on disconnect. */
  recordLogout(loginRowId: number, sessionMinutes: number): void {
    this.db.query(
      `UPDATE login_history SET logout_ts = unixepoch(), session_minutes = ? WHERE id = ?`
    ).run(sessionMinutes, loginRowId);
  }

  /** Async-callable PTR update. Called after a successful login_history insert
   *  once the dns.reverse() lookup resolves (or fails — null is fine). */
  setLoginReverseDns(loginRowId: number, ptr: string | null): void {
    this.db.query(`UPDATE login_history SET reverse_dns = ? WHERE id = ?`).run(ptr, loginRowId);
  }

  /** Upsert the bot-stats row. Called every 5 min during play + at logout. */
  saveBotStats(accountId: number, row: BotStatsRow): void {
    const account = this.db.query('SELECT 1 FROM accounts WHERE id = ?').get(accountId);
    if (!account) return;

    this.db.query(`
	      INSERT INTO bot_stats (
	        account_id, total_skilling_actions, total_combat_swings, total_movements,
	        total_chat_messages, total_session_minutes, total_flag_events, total_suspicious_packets,
	        last_chat_ts, last_action_ts, last_login_ts, risk_score, risk_level, risk_reasons,
	        tick_align_samples, reaction_samples, path_destinations,
	        action_signatures, ping_interval_samples, device_ids, suspicious_packet_reasons,
	        xp_baseline, last_session_summary, session_history, updated_at
	      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(account_id) DO UPDATE SET
        total_skilling_actions = excluded.total_skilling_actions,
        total_combat_swings = excluded.total_combat_swings,
        total_movements = excluded.total_movements,
        total_chat_messages = excluded.total_chat_messages,
        total_session_minutes = excluded.total_session_minutes,
        total_flag_events = excluded.total_flag_events,
        total_suspicious_packets = excluded.total_suspicious_packets,
        last_chat_ts = excluded.last_chat_ts,
        last_action_ts = excluded.last_action_ts,
        last_login_ts = excluded.last_login_ts,
        risk_score = excluded.risk_score,
        risk_level = excluded.risk_level,
        risk_reasons = excluded.risk_reasons,
	        tick_align_samples = excluded.tick_align_samples,
	        reaction_samples = excluded.reaction_samples,
	        path_destinations = excluded.path_destinations,
	        action_signatures = excluded.action_signatures,
	        ping_interval_samples = excluded.ping_interval_samples,
	        device_ids = excluded.device_ids,
	        suspicious_packet_reasons = excluded.suspicious_packet_reasons,
	        xp_baseline = excluded.xp_baseline,
	        last_session_summary = COALESCE(excluded.last_session_summary, bot_stats.last_session_summary),
	        session_history = excluded.session_history,
	        updated_at = unixepoch()
    `).run(
      accountId,
      row.total_skilling_actions,
      row.total_combat_swings,
      row.total_movements,
      row.total_chat_messages,
      row.total_session_minutes,
      row.total_flag_events,
      row.total_suspicious_packets,
      row.last_chat_ts ?? null,
      row.last_action_ts ?? null,
      row.last_login_ts ?? null,
      row.risk_score,
      row.risk_level,
	      row.risk_reasons,
	      row.tick_align_samples,
	      row.reaction_samples,
	      row.path_destinations,
	      row.action_signatures ?? '{}',
	      row.ping_interval_samples,
	      row.device_ids,
	      row.suspicious_packet_reasons ?? '{}',
	      row.xp_baseline,
	      row.last_session_summary ?? null,
	      row.session_history ?? '[]',
	    );
  }

  listAdminBotReviewAccounts(limit: number = 200, query: string = ''): AdminBotReviewAccount[] {
    const safeLimit = Math.max(1, Math.min(500, Math.floor(Number.isFinite(limit) ? limit : 200)));
    const search = query.trim().slice(0, 64);
    const rows = this.db.query(`
      SELECT
        a.id,
        a.username,
        a.is_admin,
        a.is_moderator,
        b.total_skilling_actions,
        b.total_combat_swings,
        b.total_movements,
        b.total_chat_messages,
        b.total_session_minutes,
        b.total_flag_events,
        b.total_suspicious_packets,
        b.last_chat_ts,
        b.last_action_ts,
        b.last_login_ts AS bot_last_login_ts,
        b.risk_score,
        b.risk_level,
        b.risk_reasons,
        b.tick_align_samples,
        b.reaction_samples,
        b.path_destinations,
        b.action_signatures,
        b.ping_interval_samples,
        b.device_ids,
        b.suspicious_packet_reasons,
        b.last_session_summary,
        b.session_history,
        b.updated_at,
        (
          SELECT lh.login_ts FROM login_history lh
          WHERE lh.account_id = a.id
          ORDER BY lh.login_ts DESC, lh.id DESC
          LIMIT 1
        ) AS latest_login_ts,
        (
          SELECT lh.ip_address FROM login_history lh
          WHERE lh.account_id = a.id
          ORDER BY lh.login_ts DESC, lh.id DESC
          LIMIT 1
        ) AS latest_ip,
        (
          SELECT lh.reverse_dns FROM login_history lh
          WHERE lh.account_id = a.id
          ORDER BY lh.login_ts DESC, lh.id DESC
          LIMIT 1
        ) AS latest_reverse_dns,
        (
          SELECT lh.device_id FROM login_history lh
          WHERE lh.account_id = a.id
          ORDER BY lh.login_ts DESC, lh.id DESC
          LIMIT 1
        ) AS latest_device_id,
        (
          SELECT lh.session_minutes FROM login_history lh
          WHERE lh.account_id = a.id
          ORDER BY lh.login_ts DESC, lh.id DESC
          LIMIT 1
        ) AS latest_session_minutes
      FROM accounts a
      LEFT JOIN bot_stats b ON b.account_id = a.id
      WHERE (? = '' OR instr(lower(a.username), lower(?)) > 0)
      ORDER BY COALESCE(b.risk_score, 0) DESC,
               COALESCE(latest_login_ts, b.last_login_ts, 0) DESC,
               a.username COLLATE NOCASE ASC
      LIMIT ?
    `).all(search, search, safeLimit) as Array<{
      id: number;
      username: string;
      is_admin: number;
      is_moderator: number;
      total_skilling_actions: number | null;
      total_combat_swings: number | null;
      total_movements: number | null;
      total_chat_messages: number | null;
      total_session_minutes: number | null;
      total_flag_events: number | null;
      total_suspicious_packets: number | null;
      last_chat_ts: number | null;
      last_action_ts: number | null;
      bot_last_login_ts: number | null;
      risk_score: number | null;
	      risk_level: string | null;
	      risk_reasons: string | null;
	      tick_align_samples: string | null;
	      reaction_samples: string | null;
	      path_destinations: string | null;
	      action_signatures: string | null;
	      ping_interval_samples: string | null;
	      device_ids: string | null;
	      suspicious_packet_reasons: string | null;
	      last_session_summary: string | null;
	      session_history: string | null;
	      updated_at: number | null;
      latest_login_ts: number | null;
      latest_ip: string | null;
      latest_reverse_dns: string | null;
      latest_device_id: string | null;
      latest_session_minutes: number | null;
    }>;

	    const accounts = rows.map((row) => {
	      const pathDestinations = parseJsonNumberRecord(row.path_destinations);
	      const deviceIds = parseJsonNumberRecord(row.device_ids);
	      const suspiciousReasons = parseJsonNumberRecord(row.suspicious_packet_reasons);
	      const totalActions = (row.total_skilling_actions ?? 0) + (row.total_combat_swings ?? 0) + (row.total_movements ?? 0);
	      const totalMinutes = row.total_session_minutes ?? 0;
	      const totalHours = totalMinutes > 0 ? totalMinutes / 60 : null;
	      const totalChats = row.total_chat_messages ?? 0;
	      const storedRiskReasons = parseJsonStringArray(row.risk_reasons);
	      const calibratedRisk = calibratedLegacyBotRisk({
	        storedReasons: storedRiskReasons,
	        totalSessionMinutes: totalMinutes,
	        totalSkillingActions: row.total_skilling_actions ?? 0,
	        totalCombatSwings: row.total_combat_swings ?? 0,
	        totalMovements: row.total_movements ?? 0,
	        totalChatMessages: totalChats,
	        totalFlagEvents: row.total_flag_events ?? 0,
	        totalSuspiciousPackets: row.total_suspicious_packets ?? 0,
	        pathDestinations,
	        suspiciousReasons,
	      });
	      const lastIp = row.latest_ip ?? null;
	      return {
        accountId: row.id,
        username: row.username,
        isAdmin: row.is_admin === 1,
        isModerator: row.is_moderator === 1,
        riskScore: calibratedRisk?.score ?? row.risk_score ?? 0,
        riskLevel: calibratedRisk?.level ?? row.risk_level ?? 'low',
        riskReasons: calibratedRisk?.reasons ?? storedRiskReasons,
        totalSkillingActions: row.total_skilling_actions ?? 0,
        totalCombatSwings: row.total_combat_swings ?? 0,
        totalMovements: row.total_movements ?? 0,
        totalChatMessages: row.total_chat_messages ?? 0,
        totalSessionMinutes: row.total_session_minutes ?? 0,
        totalFlagEvents: row.total_flag_events ?? 0,
        totalSuspiciousPackets: row.total_suspicious_packets ?? 0,
        lastChatTs: row.last_chat_ts ?? null,
        lastActionTs: row.last_action_ts ?? null,
        lastLoginTs: row.latest_login_ts ?? row.bot_last_login_ts ?? null,
        lastIp,
        lastReverseDns: row.latest_reverse_dns ?? null,
        lastDeviceId: row.latest_device_id ?? null,
        lastSessionMinutes: row.latest_session_minutes ?? null,
        botStatsUpdatedAt: row.updated_at ?? null,
        tickAlignSampleCount: parseJsonNumberArray(row.tick_align_samples).length,
        reactionSampleCount: parseJsonNumberArray(row.reaction_samples).length,
        pingIntervalSampleCount: parseJsonNumberArray(row.ping_interval_samples).length,
        pathDestinationCount: Object.keys(pathDestinations).length,
        topPathRepetition: topRecordRatio(pathDestinations),
        topPathDestinations: topNumberRecordEntries(pathDestinations, 5).map(([tile, count]) => ({ tile, count })),
        deviceIdsSeen: Object.keys(deviceIds).length,
        suspiciousPacketReasons: topNumberRecordEntries(suspiciousReasons, 8).map(([reason, count]) => ({ reason, count })),
        sessionHistory: parseJsonObjectArray(row.session_history).slice(-8),
        chatRatePerHour: totalHours === null ? null : totalChats / totalHours,
        actionsPerHour: totalHours === null ? null : totalActions / totalHours,
        actionsPerChat: totalChats > 0 ? totalActions / totalChats : null,
        sharedDeviceAlts: this.getSharedDeviceAlts(row.id),
        lastSessionSummary: parseJsonObject(row.last_session_summary),
        accountBan: this.getAccountBanRecord(row.id),
        ipBan: lastIp ? this.getIpBanRecord(lastIp) : null,
        accountMute: this.getAccountMuteRecord(row.id),
      };
    });
    accounts.sort((a, b) =>
      b.riskScore - a.riskScore
      || (b.lastLoginTs ?? 0) - (a.lastLoginTs ?? 0)
      || a.username.localeCompare(b.username)
    );
    return accounts;
  }

  private getSharedDeviceAlts(accountId: number, limit: number = 8): AdminSharedDeviceAlt[] {
    const rows = this.db.query(`
      WITH my_devices AS (
        SELECT DISTINCT device_id
        FROM login_history
        WHERE account_id = ? AND device_id IS NOT NULL AND device_id <> ''
      )
      SELECT
        a.id AS account_id,
        a.username,
        COUNT(DISTINCT lh.device_id) AS devices,
        COUNT(*) AS logins,
        MAX(lh.login_ts) AS last_seen_ts
      FROM login_history lh
      JOIN my_devices md ON md.device_id = lh.device_id
      JOIN accounts a ON a.id = lh.account_id
      WHERE lh.account_id <> ?
      GROUP BY a.id, a.username
      ORDER BY devices DESC, logins DESC, last_seen_ts DESC
      LIMIT ?
    `).all(accountId, accountId, Math.max(1, Math.min(20, limit))) as Array<{
      account_id: number;
      username: string;
      devices: number;
      logins: number;
      last_seen_ts: number | null;
    }>;
    return rows.map((row) => ({
      accountId: row.account_id,
      username: row.username,
      devices: row.devices,
      logins: row.logins,
      lastSeenTs: row.last_seen_ts,
    }));
  }

  private seedForumCategories(): void {
    const stmt = this.db.query(`
      INSERT INTO forum_categories (slug, name, description, sort_order, staff_only_write)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO NOTHING
    `);
    FORUM_DEFAULT_CATEGORIES.forEach((category, index) => {
      stmt.run(category.slug, category.name, category.description, index + 1, category.staffOnly);
    });
  }

  private forumCategoryFromRow(row: {
    id: number; slug: string; name: string; description: string; sort_order: number;
    is_hidden: number; is_locked: number; staff_only_write: number;
    thread_count?: number | null; post_count?: number | null;
  }, latestThread: ForumThreadSummary | null = null): ForumCategory {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      sortOrder: row.sort_order,
      isHidden: row.is_hidden === 1,
      isLocked: row.is_locked === 1,
      staffOnlyWrite: row.staff_only_write === 1,
      threadCount: row.thread_count ?? 0,
      postCount: row.post_count ?? 0,
      latestThread,
    };
  }

  private forumThreadFromRow(row: {
    id: number; category_id: number; category_slug: string; category_name: string;
    author_account_id: number; author_username: string; last_post_username: string;
    slug: string; title: string; created_at: number; updated_at: number; last_post_at: number;
    reply_count: number; view_count: number; is_pinned: number; is_locked: number; is_hidden: number; is_deleted: number;
  }): ForumThreadSummary {
    return {
      id: row.id,
      categoryId: row.category_id,
      categorySlug: row.category_slug,
      categoryName: row.category_name,
      slug: row.slug,
      title: row.title,
      author: { accountId: row.author_account_id, username: row.author_username },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastPostAt: row.last_post_at,
      lastPostBy: row.last_post_username,
      replyCount: row.reply_count,
      viewCount: row.view_count,
      isPinned: row.is_pinned === 1,
      isLocked: row.is_locked === 1,
      isHidden: row.is_hidden === 1,
      isDeleted: row.is_deleted === 1,
    };
  }

  private forumThreadSelect(whereSql: string): string {
    return `
      SELECT
        t.id, t.category_id, c.slug AS category_slug, c.name AS category_name,
        t.author_account_id, a.username AS author_username,
        COALESCE(lp.username, a.username) AS last_post_username,
        t.slug, t.title, t.created_at, t.updated_at, t.last_post_at,
        t.reply_count, t.view_count, t.is_pinned, t.is_locked, t.is_hidden, t.is_deleted
      FROM forum_threads t
      JOIN forum_categories c ON c.id = t.category_id
      JOIN accounts a ON a.id = t.author_account_id
      LEFT JOIN accounts lp ON lp.id = t.last_post_account_id
      ${whereSql}
    `;
  }

  isForumModerator(accountId: number, isAdmin: boolean = false): boolean {
    if (isAdmin) return true;
    return !!this.db.query('SELECT 1 FROM forum_moderators WHERE account_id = ?').get(accountId);
  }

  listForumDiscordEmojis(): ForumDiscordEmoji[] {
    const rows = this.db.query(`
      SELECT id, guild_id, name, animated, available, url, updated_at
      FROM forum_discord_emojis
      WHERE available = 1
      ORDER BY lower(name) ASC
    `).all() as Array<{
      id: string; guild_id: string; name: string; animated: number; available: number; url: string; updated_at: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      guildId: row.guild_id,
      name: row.name,
      animated: row.animated === 1,
      available: row.available === 1,
      url: row.url,
      updatedAt: row.updated_at,
    }));
  }

  replaceForumDiscordEmojis(guildId: string, emojis: Array<{ id: string; name: string; animated: boolean; available: boolean; url: string }>): number {
    const insert = this.db.query(`
      INSERT INTO forum_discord_emojis (id, guild_id, name, animated, available, url, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `);
    this.db.transaction(() => {
      this.db.query('DELETE FROM forum_discord_emojis WHERE guild_id = ?').run(guildId);
      for (const emoji of emojis) {
        insert.run(emoji.id, guildId, emoji.name, emoji.animated ? 1 : 0, emoji.available ? 1 : 0, emoji.url);
      }
    }).immediate();
    return emojis.length;
  }

  listForumCategories(includeHidden: boolean = false): ForumCategory[] {
    const rows = this.db.query(`
      SELECT
        c.*,
        COUNT(DISTINCT CASE WHEN t.is_deleted = 0 AND t.is_hidden = 0 THEN t.id END) AS thread_count,
        COUNT(DISTINCT CASE WHEN p.is_deleted = 0 AND p.is_hidden = 0 THEN p.id END) AS post_count
      FROM forum_categories c
      LEFT JOIN forum_threads t ON t.category_id = c.id
      LEFT JOIN forum_posts p ON p.thread_id = t.id
      WHERE (? = 1 OR c.is_hidden = 0)
      GROUP BY c.id
      ORDER BY c.sort_order ASC, c.name ASC
    `).all(includeHidden ? 1 : 0) as Array<{
      id: number; slug: string; name: string; description: string; sort_order: number;
      is_hidden: number; is_locked: number; staff_only_write: number; thread_count: number; post_count: number;
    }>;
    return rows.map((row) => this.forumCategoryFromRow(row, this.getLatestThreadForCategory(row.id, includeHidden)));
  }

  private getLatestThreadForCategory(categoryId: number, includeHidden: boolean): ForumThreadSummary | null {
    const row = this.db.query(this.forumThreadSelect(`
      WHERE t.category_id = ? AND t.is_deleted = 0 AND (? = 1 OR t.is_hidden = 0)
      ORDER BY t.last_post_at DESC LIMIT 1
    `)).get(categoryId, includeHidden ? 1 : 0) as Parameters<typeof this.forumThreadFromRow>[0] | null;
    return row ? this.forumThreadFromRow(row) : null;
  }

  getForumCategory(slug: string, includeHidden: boolean = false): ForumCategory | null {
    return this.listForumCategories(includeHidden).find((category) => category.slug === slug) ?? null;
  }

  listForumThreads(opts: { categorySlug?: string; query?: string; sort?: string; page?: number; limit?: number; includeHidden?: boolean } = {}): ForumListResponse {
    const includeHidden = opts.includeHidden === true;
    const pageSize = Math.max(5, Math.min(50, Math.floor(opts.limit ?? 20) || 20));
    const page = clampForumPage(opts.page ?? 1);
    const query = (opts.query ?? '').trim().toLowerCase();
    const categorySlug = (opts.categorySlug ?? '').trim().toLowerCase();
    const sort = opts.sort === 'new' ? 'new' : opts.sort === 'top' ? 'top' : 'latest';
    const clauses = ['t.is_deleted = 0', '(? = 1 OR t.is_hidden = 0)', '(? = 1 OR c.is_hidden = 0)'];
    const params: Array<string | number> = [includeHidden ? 1 : 0, includeHidden ? 1 : 0];
    if (categorySlug) {
      clauses.push('c.slug = ?');
      params.push(categorySlug);
    }
    if (query) {
      clauses.push('(lower(t.title) LIKE ? OR EXISTS (SELECT 1 FROM forum_posts p WHERE p.thread_id = t.id AND p.is_deleted = 0 AND (? = 1 OR p.is_hidden = 0) AND lower(p.body) LIKE ?))');
      params.push(`%${query}%`, includeHidden ? 1 : 0, `%${query}%`);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const total = (this.db.query(`
      SELECT COUNT(*) AS n
      FROM forum_threads t JOIN forum_categories c ON c.id = t.category_id
      ${where}
    `).get(...params) as { n: number }).n;
    const orderBy = sort === 'new'
      ? 't.created_at DESC'
      : sort === 'top'
        ? 't.view_count DESC, t.reply_count DESC, t.last_post_at DESC'
        : 't.is_pinned DESC, t.last_post_at DESC';
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const rows = this.db.query(`${this.forumThreadSelect(where)} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (safePage - 1) * pageSize) as Array<Parameters<typeof this.forumThreadFromRow>[0]>;
    return {
      categories: this.listForumCategories(includeHidden),
      threads: rows.map((row) => this.forumThreadFromRow(row)),
      page: safePage,
      pageSize,
      totalThreads: total,
      totalPages,
    };
  }

  getForumThread(categorySlug: string, threadSlug: string, viewerAccountId: number | null = null, includeHidden: boolean = false, page: number = 1, limit: number = 20): ForumThreadDetail | null {
    const row = this.db.query(this.forumThreadSelect(`
      WHERE c.slug = ? AND t.slug = ? AND t.is_deleted = 0
        AND (? = 1 OR (t.is_hidden = 0 AND c.is_hidden = 0))
      LIMIT 1
    `)).get(categorySlug, threadSlug, includeHidden ? 1 : 0) as Parameters<typeof this.forumThreadFromRow>[0] | null;
    if (!row) return null;
    this.db.query('UPDATE forum_threads SET view_count = view_count + 1 WHERE id = ?').run(row.id);
    const thread = this.forumThreadFromRow({ ...row, view_count: row.view_count + 1 });
    const category = this.getForumCategory(categorySlug, includeHidden);
    if (!category) return null;
    const pageSize = Math.max(5, Math.min(50, Math.floor(limit) || 20));
    const totalPosts = (this.db.query('SELECT COUNT(*) AS n FROM forum_posts WHERE thread_id = ? AND is_deleted = 0 AND (? = 1 OR is_hidden = 0)')
      .get(thread.id, includeHidden ? 1 : 0) as { n: number }).n;
    const totalPages = Math.max(1, Math.ceil(totalPosts / pageSize));
    const safePage = Math.min(clampForumPage(page), totalPages);
    const posts = this.getForumPosts(thread.id, viewerAccountId, includeHidden, safePage, pageSize);
    return { thread, category, posts, page: safePage, pageSize, totalPosts, totalPages };
  }

  private getForumPosts(threadId: number, viewerAccountId: number | null, includeHidden: boolean, page: number = 1, limit: number = 20): ForumPost[] {
    const offset = (clampForumPage(page) - 1) * limit;
    const rows = this.db.query(`
      SELECT p.*, a.username, a.is_admin AS author_is_admin, a.is_moderator AS author_is_role_moderator,
        ps.skills AS author_skills, ps.appearance AS author_appearance, ps.equipment AS author_equipment,
        avatar.url AS author_avatar_url, fp.signature AS author_signature,
        rp.id AS reply_to_id, rp.author_account_id AS reply_to_author_account_id,
        ra.username AS reply_to_author_username, rp.body AS reply_to_body, rp.created_at AS reply_to_created_at
      FROM forum_posts p JOIN accounts a ON a.id = p.author_account_id
      LEFT JOIN player_state ps ON ps.account_id = p.author_account_id
      LEFT JOIN forum_profiles fp ON fp.account_id = p.author_account_id
      LEFT JOIN forum_media avatar ON avatar.id = fp.avatar_media_id
      LEFT JOIN forum_posts rp ON rp.id = p.reply_to_post_id AND rp.is_deleted = 0
      LEFT JOIN accounts ra ON ra.id = rp.author_account_id
      WHERE p.thread_id = ? AND p.is_deleted = 0 AND (? = 1 OR p.is_hidden = 0)
      ORDER BY p.created_at ASC, p.id ASC
      LIMIT ? OFFSET ?
    `).all(threadId, includeHidden ? 1 : 0, limit, offset) as Array<{
      id: number; thread_id: number; author_account_id: number; username: string; author_is_admin: number; author_is_role_moderator: number;
      author_skills: string | null; author_appearance: string | null; author_equipment: string | null; author_avatar_url: string | null; author_signature: string | null; body: string;
      created_at: number; updated_at: number; edited_at: number | null; is_hidden: number; is_deleted: number; hidden_reason: string;
      reply_to_id: number | null; reply_to_author_account_id: number | null; reply_to_author_username: string | null; reply_to_body: string | null; reply_to_created_at: number | null;
    }>;
    const postIds = rows.map((row) => row.id);
    const reactionCounts = new Map<number, Record<string, number>>();
    const reactionUsers = new Map<number, Record<string, ForumReactionUsers>>();
    const myReactions = new Map<number, string>();
    if (postIds.length > 0) {
      const placeholders = postIds.map(() => '?').join(',');
      const reactions = this.db.query(`
        SELECT post_id, reaction, COUNT(*) AS n
        FROM forum_reactions
        WHERE post_id IN (${placeholders})
        GROUP BY post_id, reaction
      `).all(...postIds) as Array<{ post_id: number; reaction: string; n: number }>;
      for (const row of reactions) {
        const counts = reactionCounts.get(row.post_id) ?? {};
        counts[row.reaction] = row.n;
        reactionCounts.set(row.post_id, counts);
      }
      const reactionPreviewRows = this.db.query(`
        WITH ranked_reactions AS (
          SELECT fr.post_id, fr.reaction, a.username, fr.created_at, fr.account_id,
            COUNT(*) OVER (PARTITION BY fr.post_id, fr.reaction) AS total,
            ROW_NUMBER() OVER (
              PARTITION BY fr.post_id, fr.reaction
              ORDER BY fr.created_at DESC, fr.account_id DESC
            ) AS position
          FROM forum_reactions fr
          JOIN accounts a ON a.id = fr.account_id
          WHERE fr.post_id IN (${placeholders})
        )
        SELECT post_id, reaction, username, total
        FROM ranked_reactions
        WHERE position <= 5
        ORDER BY post_id ASC, reaction ASC, position ASC
      `).all(...postIds) as Array<{ post_id: number; reaction: string; username: string; total: number }>;
      for (const row of reactionPreviewRows) {
        const byPost = reactionUsers.get(row.post_id) ?? {};
        const summary = byPost[row.reaction] ?? { names: [], others: 0 };
        if (summary.names.length < 5) summary.names.push(row.username);
        summary.others = Math.max(0, row.total - summary.names.length);
        byPost[row.reaction] = summary;
        reactionUsers.set(row.post_id, byPost);
      }
      if (viewerAccountId != null) {
        const mine = this.db.query(`SELECT post_id, reaction FROM forum_reactions WHERE account_id = ? AND post_id IN (${placeholders})`)
          .all(viewerAccountId, ...postIds) as Array<{ post_id: number; reaction: string }>;
        for (const row of mine) myReactions.set(row.post_id, row.reaction);
      }
    }
    return rows.map((row) => {
      let authorCombatLevel: number | null = null;
      if (row.author_skills) {
        try {
          authorCombatLevel = combatLevel(JSON.parse(row.author_skills));
        } catch {
          authorCombatLevel = null;
        }
      }
      const avatarTarget = forumAvatarTarget(row.author_account_id, row.username, row.author_appearance, row.author_equipment);
      return {
      id: row.id,
      threadId: row.thread_id,
      author: { accountId: row.author_account_id, username: row.username, avatarUrl: avatarTarget?.url ?? row.author_avatar_url ?? '', combatLevel: authorCombatLevel, isAdmin: row.author_is_admin === 1, isRoleModerator: row.author_is_role_moderator === 1, signature: row.author_signature ?? '' },
      replyTo: row.reply_to_id == null ? null : {
        id: row.reply_to_id,
        author: { accountId: row.reply_to_author_account_id ?? 0, username: row.reply_to_author_username ?? 'unknown' },
        body: (row.reply_to_body ?? '').slice(0, 500),
        createdAt: row.reply_to_created_at ?? 0,
      },
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      editedAt: row.edited_at,
      isHidden: row.is_hidden === 1,
      isDeleted: row.is_deleted === 1,
      hiddenReason: row.hidden_reason,
      reactions: reactionCounts.get(row.id) ?? {},
      reactionUsers: reactionUsers.get(row.id) ?? {},
      myReaction: myReactions.get(row.id) ?? null,
      };
    });
  }

  private getForumPostById(postId: number, viewerAccountId: number | null, includeHidden: boolean): ForumPost | null {
    const row = this.db.query('SELECT thread_id FROM forum_posts WHERE id = ?').get(postId) as { thread_id: number } | null;
    if (!row) return null;
    return this.getForumPosts(row.thread_id, viewerAccountId, includeHidden, 1, 1_000_000).find((post) => post.id === postId) ?? null;
  }

  private createForumNotification(recipientAccountId: number, actorAccountId: number, type: string, threadId: number, postId: number, sourcePostId: number | null): void {
    if (recipientAccountId === actorAccountId) return;
    this.db.query(`
      INSERT INTO forum_notifications (recipient_account_id, actor_account_id, type, thread_id, post_id, source_post_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(recipientAccountId, actorAccountId, type, threadId, postId, sourcePostId);
  }

  listForumNotifications(accountId: number, limit: number = 20): { notifications: ForumNotification[]; unreadCount: number } {
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 20));
    const rows = this.db.query(`
      SELECT n.id, n.type, n.created_at, n.read_at, n.post_id, n.source_post_id,
        actor.id AS actor_account_id, actor.username AS actor_username,
        t.id AS thread_id, t.slug AS thread_slug, t.title AS thread_title,
        c.slug AS category_slug,
        (
          SELECT COUNT(*) FROM forum_posts previous
          WHERE previous.thread_id = n.thread_id AND previous.is_deleted = 0
            AND previous.is_hidden = 0
            AND (previous.created_at < p.created_at OR (previous.created_at = p.created_at AND previous.id <= p.id))
        ) AS post_position
      FROM forum_notifications n
      JOIN forum_posts p ON p.id = n.post_id
      JOIN accounts actor ON actor.id = n.actor_account_id
      JOIN forum_threads t ON t.id = n.thread_id
      JOIN forum_categories c ON c.id = t.category_id
      WHERE n.recipient_account_id = ?
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ?
    `).all(accountId, safeLimit) as Array<{
      id: number; type: string; created_at: number; read_at: number | null; post_id: number; source_post_id: number | null;
      actor_account_id: number; actor_username: string; thread_id: number; thread_slug: string; thread_title: string; category_slug: string; post_position: number;
    }>;
    const unreadCount = (this.db.query('SELECT COUNT(*) AS n FROM forum_notifications WHERE recipient_account_id = ? AND read_at IS NULL')
      .get(accountId) as { n: number }).n;
    return {
      unreadCount,
      notifications: rows.map((row) => ({
        id: row.id,
        type: row.type,
        createdAt: row.created_at,
        readAt: row.read_at,
        actor: { accountId: row.actor_account_id, username: row.actor_username },
        thread: { id: row.thread_id, categorySlug: row.category_slug, slug: row.thread_slug, title: row.thread_title },
        postId: row.post_id,
        postPage: Math.max(1, Math.ceil(row.post_position / 20)),
        sourcePostId: row.source_post_id,
      })),
    };
  }

  markForumNotificationsRead(accountId: number, notificationId?: number): { ok: true } {
    if (notificationId) {
      this.db.query('UPDATE forum_notifications SET read_at = COALESCE(read_at, unixepoch()) WHERE id = ? AND recipient_account_id = ?')
        .run(notificationId, accountId);
    } else {
      this.db.query('UPDATE forum_notifications SET read_at = COALESCE(read_at, unixepoch()) WHERE recipient_account_id = ? AND read_at IS NULL')
        .run(accountId);
    }
    return { ok: true };
  }

  touchForumPresence(accountId: number, nowUnix: number = Math.floor(Date.now() / 1000)): { ok: true } {
    const safeNow = Math.max(0, Math.floor(nowUnix));
    this.db.query(`
      INSERT INTO forum_presence (account_id, last_seen_at)
      VALUES (?, ?)
      ON CONFLICT(account_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(accountId, safeNow);
    return { ok: true };
  }

  listForumOnlineUsers(nowUnix: number = Math.floor(Date.now() / 1000), windowSeconds: number = 180): ForumOnlineUser[] {
    const safeNow = Math.max(0, Math.floor(nowUnix));
    const safeWindow = Math.max(30, Math.min(15 * 60, Math.floor(windowSeconds) || 180));
    const rows = this.db.query(`
      SELECT p.account_id, p.last_seen_at, a.username, a.is_admin, a.is_moderator, ps.skills, avatar.url AS avatar_url
      FROM forum_presence p
      JOIN accounts a ON a.id = p.account_id
      LEFT JOIN player_state ps ON ps.account_id = p.account_id
      LEFT JOIN forum_profiles fp ON fp.account_id = p.account_id
      LEFT JOIN forum_media avatar ON avatar.id = fp.avatar_media_id
      WHERE p.last_seen_at >= ?
      ORDER BY p.last_seen_at DESC, lower(a.username) ASC
      LIMIT 100
    `).all(safeNow - safeWindow) as Array<{
      account_id: number; last_seen_at: number; username: string; is_admin: number; is_moderator: number; skills: string | null; avatar_url: string | null;
    }>;
    return rows.map((row) => {
      let level: number | null = null;
      if (row.skills) {
        try {
          level = combatLevel(JSON.parse(row.skills));
        } catch {
          level = null;
        }
      }
      return {
        accountId: row.account_id,
        username: row.username,
        avatarUrl: row.avatar_url ?? '',
        combatLevel: level,
        isAdmin: row.is_admin === 1,
        isRoleModerator: row.is_moderator === 1,
        lastSeenAt: row.last_seen_at,
      };
    });
  }

  createForumThread(accountId: number, categoryId: number, title: string, body: string): { ok: true; thread: ForumThreadSummary } | { ok: false; error: string } {
    const cleanTitle = title.trim().replace(/\s+/g, ' ').slice(0, 120);
    const cleanBody = body.trim().slice(0, 20_000);
    if (cleanTitle.length < 3 || !/[a-z0-9]/i.test(cleanTitle)) return { ok: false, error: 'Thread title must include at least one letter or number.' };
    if (cleanBody.length < 2) return { ok: false, error: 'Post body is too short.' };
    const category = this.db.query('SELECT id, slug, is_locked, staff_only_write, is_hidden FROM forum_categories WHERE id = ?')
      .get(categoryId) as { id: number; slug: string; is_locked: number; staff_only_write: number; is_hidden: number } | null;
    if (!category || category.is_hidden === 1) return { ok: false, error: 'Category not found.' };
    const account = this.getAccountModerationInfo(accountId);
    if (!account) return { ok: false, error: 'Account not found.' };
    const canModerate = this.isForumModerator(accountId, account.isAdmin);
    if (category.is_locked === 1 || (category.staff_only_write === 1 && !canModerate)) return { ok: false, error: 'Only staff can post in this category.' };
    const baseSlug = forumSlug(cleanTitle) || `thread-${Date.now()}`;
    let slug = baseSlug;
    for (let i = 2; i < 100; i++) {
      if (!this.db.query('SELECT 1 FROM forum_threads WHERE category_id = ? AND slug = ?').get(categoryId, slug)) break;
      slug = `${baseSlug}-${i}`;
    }
    let threadId = 0;
    this.db.transaction(() => {
      const result = this.db.query('INSERT INTO forum_threads (category_id, author_account_id, slug, title, last_post_account_id) VALUES (?, ?, ?, ?, ?)')
        .run(categoryId, accountId, slug, cleanTitle, accountId);
      threadId = Number(result.lastInsertRowid);
      this.db.query('INSERT INTO forum_posts (thread_id, author_account_id, body) VALUES (?, ?, ?)')
        .run(threadId, accountId, cleanBody);
    }).immediate();
    void threadId;
    const thread = this.getForumThread(category.slug, slug, accountId, true)?.thread;
    return thread ? { ok: true, thread } : { ok: false, error: 'Thread creation failed.' };
  }

  createForumReply(accountId: number, threadId: number, body: string, replyToPostId?: number): { ok: true; post: ForumPost } | { ok: false; error: string } {
    const cleanBody = body.trim().slice(0, 20_000);
    if (cleanBody.length < 2) return { ok: false, error: 'Reply is too short.' };
    const thread = this.db.query('SELECT id, author_account_id, title, is_locked, is_hidden, is_deleted FROM forum_threads WHERE id = ?')
      .get(threadId) as { id: number; author_account_id: number; title: string; is_locked: number; is_hidden: number; is_deleted: number } | null;
    if (!thread || thread.is_deleted === 1 || thread.is_hidden === 1) return { ok: false, error: 'Thread not found.' };
    if (thread.is_locked === 1) return { ok: false, error: 'Thread is locked.' };
    // Cheap flood guard: reject an exact repeat of this author's most recent
    // post in the thread (the common copy-paste spam pattern).
    const lastOwn = this.db.query('SELECT body FROM forum_posts WHERE thread_id = ? AND author_account_id = ? AND is_deleted = 0 ORDER BY id DESC LIMIT 1')
      .get(threadId, accountId) as { body: string } | null;
    if (lastOwn && lastOwn.body === cleanBody) return { ok: false, error: 'This looks like a duplicate of your last reply.' };
    let replyTo: { id: number; author_account_id: number } | null = null;
    if (replyToPostId && Number.isFinite(replyToPostId)) {
      replyTo = this.db.query('SELECT id, author_account_id FROM forum_posts WHERE id = ? AND thread_id = ? AND is_deleted = 0 AND is_hidden = 0')
        .get(replyToPostId, threadId) as { id: number; author_account_id: number } | null;
      if (!replyTo) return { ok: false, error: 'Quoted post not found.' };
    }
    let postId = 0;
    this.db.transaction(() => {
      const result = this.db.query('INSERT INTO forum_posts (thread_id, author_account_id, reply_to_post_id, body) VALUES (?, ?, ?, ?)')
        .run(threadId, accountId, replyTo?.id ?? null, cleanBody);
      postId = Number(result.lastInsertRowid);
      this.db.query('UPDATE forum_threads SET reply_count = reply_count + 1, last_post_at = unixepoch(), last_post_account_id = ?, updated_at = unixepoch() WHERE id = ?')
        .run(accountId, threadId);
      this.createForumNotification(thread.author_account_id, accountId, 'thread_reply', threadId, postId, null);
      if (replyTo) this.createForumNotification(replyTo.author_account_id, accountId, 'quote_reply', threadId, postId, replyTo.id);
    }).immediate();
    const post = this.getForumPostById(postId, accountId, true);
    return post ? { ok: true, post } : { ok: false, error: 'Reply creation failed.' };
  }

  editForumPost(accountId: number, postId: number, body: string, isModerator: boolean): { ok: true; post: ForumPost } | { ok: false; error: string } {
    const cleanBody = body.trim().slice(0, 20_000);
    if (cleanBody.length < 2) return { ok: false, error: 'Post body is too short.' };
    const row = this.db.query('SELECT p.id, p.thread_id, p.author_account_id, p.body, p.is_hidden, p.is_deleted, t.is_locked FROM forum_posts p JOIN forum_threads t ON t.id = p.thread_id WHERE p.id = ?')
      .get(postId) as { id: number; thread_id: number; author_account_id: number; body: string; is_hidden: number; is_deleted: number; is_locked: number } | null;
    if (!row || row.is_deleted === 1) return { ok: false, error: 'Post not found.' };
    if (!isModerator && (row.author_account_id !== accountId || row.is_locked === 1 || row.is_hidden === 1)) return { ok: false, error: 'You cannot edit this post.' };
    this.db.transaction(() => {
      this.db.query('INSERT INTO forum_post_revisions (post_id, editor_account_id, old_body, new_body) VALUES (?, ?, ?, ?)')
        .run(postId, accountId, row.body, cleanBody);
      this.db.query('UPDATE forum_posts SET body = ?, updated_at = unixepoch(), edited_at = unixepoch() WHERE id = ?').run(cleanBody, postId);
      this.db.query('UPDATE forum_threads SET updated_at = unixepoch() WHERE id = ?').run(row.thread_id);
    }).immediate();
    const post = this.getForumPostById(postId, accountId, true);
    return post ? { ok: true, post } : { ok: false, error: 'Post edit failed.' };
  }

  deleteForumPost(accountId: number, postId: number, isModerator: boolean): { ok: true } | { ok: false; error: string } {
    const row = this.db.query(`
      SELECT p.id, p.thread_id, p.author_account_id,
        (SELECT MIN(id) FROM forum_posts WHERE thread_id = p.thread_id AND is_deleted = 0) AS first_post_id
      FROM forum_posts p WHERE p.id = ?
    `).get(postId) as { id: number; thread_id: number; author_account_id: number; first_post_id: number } | null;
    if (!row) return { ok: false, error: 'Post not found.' };
    if (!isModerator && row.author_account_id !== accountId) return { ok: false, error: 'You cannot delete this post.' };
    if (!isModerator && row.first_post_id === postId) {
      const replies = (this.db.query('SELECT COUNT(*) AS n FROM forum_posts WHERE thread_id = ? AND id <> ? AND is_deleted = 0').get(row.thread_id, postId) as { n: number }).n;
      if (replies > 0) return { ok: false, error: 'Threads with replies can only be removed by staff.' };
    }
    this.db.transaction(() => {
      this.db.query('UPDATE forum_posts SET is_deleted = 1, updated_at = unixepoch() WHERE id = ?').run(postId);
      if (row.first_post_id === postId) this.db.query('UPDATE forum_threads SET is_deleted = 1, updated_at = unixepoch() WHERE id = ?').run(row.thread_id);
      else this.db.query('UPDATE forum_threads SET reply_count = max(0, reply_count - 1), updated_at = unixepoch() WHERE id = ?').run(row.thread_id);
    }).immediate();
    return { ok: true };
  }

  reactToForumPost(accountId: number, postId: number, reaction: string): { ok: true; reactions: Record<string, number>; myReaction: string | null } | { ok: false; error: string } {
    const allowed = new Set(['heart', 'smile', 'laughing', 'fire', 'skull', 'thumbs-up', 'thumbs-down', 'sword']);
    if (!allowed.has(reaction)) return { ok: false, error: 'Unsupported reaction.' };
    if (!this.db.query('SELECT id FROM forum_posts WHERE id = ? AND is_deleted = 0 AND is_hidden = 0').get(postId)) return { ok: false, error: 'Post not found.' };
    const existing = this.db.query('SELECT reaction FROM forum_reactions WHERE post_id = ? AND account_id = ?').get(postId, accountId) as { reaction: string } | null;
    if (existing?.reaction === reaction) this.db.query('DELETE FROM forum_reactions WHERE post_id = ? AND account_id = ?').run(postId, accountId);
    else this.db.query('INSERT INTO forum_reactions (post_id, account_id, reaction) VALUES (?, ?, ?) ON CONFLICT(post_id, account_id) DO UPDATE SET reaction = excluded.reaction, created_at = unixepoch()').run(postId, accountId, reaction);
    const counts: Record<string, number> = {};
    const rows = this.db.query('SELECT reaction, COUNT(*) AS n FROM forum_reactions WHERE post_id = ? GROUP BY reaction').all(postId) as Array<{ reaction: string; n: number }>;
    for (const row of rows) counts[row.reaction] = row.n;
    const mine = this.db.query('SELECT reaction FROM forum_reactions WHERE post_id = ? AND account_id = ?').get(postId, accountId) as { reaction: string } | null;
    return { ok: true, reactions: counts, myReaction: mine?.reaction ?? null };
  }

  reportForumPost(accountId: number, postId: number, reason: string): { ok: true } | { ok: false; error: string } {
    const cleanReason = reason.trim().slice(0, 500);
    if (cleanReason.length < 3) return { ok: false, error: 'Report reason is too short.' };
    if (!this.db.query('SELECT id FROM forum_posts WHERE id = ? AND is_deleted = 0').get(postId)) return { ok: false, error: 'Post not found.' };
    this.db.query('INSERT INTO forum_reports (post_id, reporter_account_id, reason) VALUES (?, ?, ?)').run(postId, accountId, cleanReason);
    // Auto-hide once enough distinct accounts flag the post, so obvious spam is
    // pulled before a moderator gets to it. Staff can restore via moderateForumPost.
    const distinctReporters = (this.db.query("SELECT COUNT(DISTINCT reporter_account_id) AS n FROM forum_reports WHERE post_id = ? AND status = 'open'").get(postId) as { n: number }).n;
    if (distinctReporters >= FORUM_AUTO_HIDE_DISTINCT_REPORTS) {
      this.db.query("UPDATE forum_posts SET is_hidden = 1, hidden_reason = ?, updated_at = unixepoch() WHERE id = ? AND is_hidden = 0")
        .run('Auto-hidden pending review (multiple reports).', postId);
    }
    return { ok: true };
  }

  moderateForumThread(threadId: number, action: string, categoryId?: number): { ok: true } | { ok: false; error: string } {
    if (!this.db.query('SELECT id FROM forum_threads WHERE id = ?').get(threadId)) return { ok: false, error: 'Thread not found.' };
    if (action === 'pin' || action === 'unpin') this.db.query('UPDATE forum_threads SET is_pinned = ?, updated_at = unixepoch() WHERE id = ?').run(action === 'pin' ? 1 : 0, threadId);
    else if (action === 'lock' || action === 'unlock') this.db.query('UPDATE forum_threads SET is_locked = ?, updated_at = unixepoch() WHERE id = ?').run(action === 'lock' ? 1 : 0, threadId);
    else if (action === 'hide' || action === 'restore') this.db.query('UPDATE forum_threads SET is_hidden = ?, updated_at = unixepoch() WHERE id = ?').run(action === 'hide' ? 1 : 0, threadId);
    else if (action === 'move') {
      if (!categoryId || !Number.isFinite(categoryId) || categoryId <= 0) return { ok: false, error: 'A target category is required.' };
      const target = this.db.query('SELECT id, is_hidden FROM forum_categories WHERE id = ?').get(categoryId) as { id: number; is_hidden: number } | null;
      if (!target) return { ok: false, error: 'Target category not found.' };
      if (target.is_hidden === 1) return { ok: false, error: 'Cannot move a thread into a hidden category.' };
      this.db.query('UPDATE forum_threads SET category_id = ?, updated_at = unixepoch() WHERE id = ?').run(categoryId, threadId);
    }
    else return { ok: false, error: 'Unsupported moderation action.' };
    return { ok: true };
  }

  moderateForumPost(postId: number, action: string, reason: string = ''): { ok: true } | { ok: false; error: string } {
    if (!this.db.query('SELECT id FROM forum_posts WHERE id = ?').get(postId)) return { ok: false, error: 'Post not found.' };
    if (action !== 'hide' && action !== 'restore') return { ok: false, error: 'Unsupported moderation action.' };
    this.db.query('UPDATE forum_posts SET is_hidden = ?, hidden_reason = ?, updated_at = unixepoch() WHERE id = ?')
      .run(action === 'hide' ? 1 : 0, action === 'hide' ? reason.trim().slice(0, 200) : '', postId);
    return { ok: true };
  }

  upsertForumCategory(input: { id?: number; name: string; description: string; sortOrder: number; isHidden: boolean; isLocked: boolean; staffOnlyWrite: boolean }): { ok: true; category: ForumCategory } | { ok: false; error: string } {
    const name = input.name.trim().slice(0, 60);
    if (name.length < 2) return { ok: false, error: 'Category name is too short.' };
    const description = input.description.trim().slice(0, 240);
    if (input.id) {
      this.db.query('UPDATE forum_categories SET name = ?, description = ?, sort_order = ?, is_hidden = ?, is_locked = ?, staff_only_write = ?, updated_at = unixepoch() WHERE id = ?')
        .run(name, description, Math.floor(input.sortOrder) || 0, input.isHidden ? 1 : 0, input.isLocked ? 1 : 0, input.staffOnlyWrite ? 1 : 0, input.id);
      const category = this.listForumCategories(true).find((entry) => entry.id === input.id);
      return category ? { ok: true, category } : { ok: false, error: 'Category not found.' };
    }
    const result = this.db.query('INSERT INTO forum_categories (slug, name, description, sort_order, is_hidden, is_locked, staff_only_write) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(forumSlug(name), name, description, Math.floor(input.sortOrder) || 0, input.isHidden ? 1 : 0, input.isLocked ? 1 : 0, input.staffOnlyWrite ? 1 : 0);
    const category = this.listForumCategories(true).find((entry) => entry.id === Number(result.lastInsertRowid));
    return category ? { ok: true, category } : { ok: false, error: 'Category creation failed.' };
  }

  listForumReports(): ForumReport[] {
    const rows = this.db.query(`
      SELECT r.id, r.post_id, p.thread_id, t.title AS thread_title, r.reason, r.status,
        r.reporter_account_id, reporter.username AS reporter_username,
        r.created_at, r.resolved_at, resolver.username AS resolved_by
      FROM forum_reports r
      JOIN forum_posts p ON p.id = r.post_id
      JOIN forum_threads t ON t.id = p.thread_id
      JOIN accounts reporter ON reporter.id = r.reporter_account_id
      LEFT JOIN accounts resolver ON resolver.id = r.resolved_by_account_id
      ORDER BY CASE r.status WHEN 'open' THEN 0 ELSE 1 END, r.created_at DESC
      LIMIT 200
    `).all() as Array<{ id: number; post_id: number; thread_id: number; thread_title: string; reason: string; status: string; reporter_account_id: number; reporter_username: string; created_at: number; resolved_at: number | null; resolved_by: string | null }>;
    return rows.map((row) => ({
      id: row.id,
      postId: row.post_id,
      threadId: row.thread_id,
      threadTitle: row.thread_title,
      reason: row.reason,
      status: row.status,
      reporter: { accountId: row.reporter_account_id, username: row.reporter_username },
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
      resolvedBy: row.resolved_by,
    }));
  }

  resolveForumReport(reportId: number, resolverAccountId: number): { ok: true } | { ok: false; error: string } {
    const changed = this.db.query('UPDATE forum_reports SET status = \'resolved\', resolved_at = unixepoch(), resolved_by_account_id = ? WHERE id = ?')
      .run(resolverAccountId, reportId).changes;
    return changed > 0 ? { ok: true } : { ok: false, error: 'Report not found.' };
  }

  saveForumMedia(accountId: number, storagePath: string, url: string, kind: string, mimeType: string, originalName: string, sizeBytes: number): ForumMediaRecord {
    const result = this.db.query('INSERT INTO forum_media (account_id, storage_path, url, kind, mime_type, original_name, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(accountId, storagePath, url, kind, mimeType, originalName.slice(0, 120), sizeBytes);
    return { id: Number(result.lastInsertRowid), accountId, url, kind, mimeType, originalName: originalName.slice(0, 120), sizeBytes, createdAt: Math.floor(Date.now() / 1000) };
  }

  countForumUploadsSince(accountId: number, sinceUnix: number): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM forum_media WHERE account_id = ? AND created_at >= ?').get(accountId, sinceUnix) as { n: number }).n;
  }

  sumForumMediaBytes(accountId: number): number {
    return (this.db.query('SELECT COALESCE(SUM(size_bytes), 0) AS n FROM forum_media WHERE account_id = ?').get(accountId) as { n: number }).n;
  }

  updateForumProfile(accountId: number, input: { bio?: string; title?: string; signature?: string; avatarMediaId?: number | null }): { ok: true } | { ok: false; error: string } {
    // IDOR guard: a profile may only reference media the account itself uploaded.
    // `!= null` skips both `undefined` (field unchanged) and `null` (clearing).
    for (const mediaId of [input.avatarMediaId]) {
      if (mediaId != null) {
        const owned = this.db.query('SELECT 1 FROM forum_media WHERE id = ? AND account_id = ?').get(mediaId, accountId);
        if (!owned) return { ok: false, error: 'That image is not in your uploads.' };
      }
    }
    const existing = this.db.query('SELECT bio, title, signature, avatar_media_id, banner_media_id FROM forum_profiles WHERE account_id = ?')
      .get(accountId) as { bio: string; title: string; signature: string; avatar_media_id: number | null; banner_media_id: number | null } | null;
    const requestedBio = input.bio === undefined ? undefined : input.bio.trim();
    const requestedSignature = input.signature === undefined ? undefined : input.signature.trim();
    if (requestedBio !== undefined && requestedBio.length > FORUM_PROFILE_BIO_LIMIT) return { ok: false, error: `Profile bio must be ${FORUM_PROFILE_BIO_LIMIT} characters or less.` };
    if (requestedSignature !== undefined && requestedSignature.length > FORUM_PROFILE_SIGNATURE_LIMIT) return { ok: false, error: `Signature must be ${FORUM_PROFILE_SIGNATURE_LIMIT} characters or less.` };
    const bio = requestedBio === undefined ? (existing?.bio ?? '') : requestedBio;
    const title = input.title === undefined ? (existing?.title ?? '') : input.title.trim().slice(0, 40);
    const signature = requestedSignature === undefined ? (existing?.signature ?? '') : requestedSignature;
    const avatarMediaId = input.avatarMediaId === undefined ? (existing?.avatar_media_id ?? null) : input.avatarMediaId;
    const bannerMediaId = existing?.banner_media_id ?? null;
    this.db.query(`
      INSERT INTO forum_profiles (account_id, bio, title, signature, avatar_media_id, banner_media_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(account_id) DO UPDATE SET
        bio = excluded.bio, title = excluded.title, signature = excluded.signature, avatar_media_id = excluded.avatar_media_id,
        banner_media_id = excluded.banner_media_id, updated_at = unixepoch()
    `).run(accountId, bio, title, signature, avatarMediaId, bannerMediaId);
    return { ok: true };
  }

  getForumProfile(username: string): ForumProfile | null {
    const account = this.db.query('SELECT id, username, is_admin, is_moderator, created_at FROM accounts WHERE username = ?').get(username.trim()) as { id: number; username: string; is_admin: number; is_moderator: number; created_at: number } | null;
    if (!account) return null;
    const profile = this.db.query(`
      SELECT fp.bio, fp.title, fp.signature, avatar.url AS avatar_url
      FROM forum_profiles fp
      LEFT JOIN forum_media avatar ON avatar.id = fp.avatar_media_id
      WHERE fp.account_id = ?
    `).get(account.id) as { bio: string; title: string; signature: string; avatar_url: string | null } | null;
    const postCount = (this.db.query('SELECT COUNT(*) AS n FROM forum_posts WHERE author_account_id = ? AND is_deleted = 0').get(account.id) as { n: number }).n;
    const threadCount = (this.db.query('SELECT COUNT(*) AS n FROM forum_threads WHERE author_account_id = ? AND is_deleted = 0').get(account.id) as { n: number }).n;
    const state = this.loadPlayerState(account.id);
    const skills = state?.skills ?? null;
    const avatarTarget = state?.appearance
      ? forumAvatarTarget(account.id, account.username, JSON.stringify(state.appearance), JSON.stringify(Object.fromEntries(state.equipment)))
      : null;
    const topSkills = skills ? ALL_SKILLS
      .map((id) => ({ id, name: SKILL_NAMES[id], level: skills[id].level, xp: skills[id].xp }))
      .sort((a, b) => b.xp - a.xp || b.level - a.level || a.name.localeCompare(b.name))
      .slice(0, 5) : [];
    const recentThreads = (this.db.query(this.forumThreadSelect('WHERE t.author_account_id = ? AND t.is_deleted = 0 AND t.is_hidden = 0 ORDER BY t.created_at DESC LIMIT 5'))
      .all(account.id) as Array<Parameters<typeof this.forumThreadFromRow>[0]>).map((row) => this.forumThreadFromRow(row));
    const recentPosts = this.db.query(`
      SELECT p.id, p.thread_id, t.title AS thread_title, t.slug AS thread_slug, p.created_at
      FROM forum_posts p JOIN forum_threads t ON t.id = p.thread_id
      WHERE p.author_account_id = ? AND p.is_deleted = 0 AND p.is_hidden = 0
      ORDER BY p.created_at DESC LIMIT 5
    `).all(account.id) as Array<{ id: number; thread_id: number; thread_title: string; thread_slug: string; created_at: number }>;
    return {
      accountId: account.id,
      username: account.username,
      createdAt: account.created_at,
      avatarUrl: avatarTarget?.url ?? profile?.avatar_url ?? '',
      bio: profile?.bio ?? '',
      title: profile?.title ?? '',
      signature: profile?.signature ?? '',
      postCount,
      threadCount,
      isModerator: this.isForumModerator(account.id, account.is_admin === 1),
      isRoleModerator: account.is_moderator === 1,
      isAdmin: account.is_admin === 1,
      combatLevel: skills ? combatLevel(skills) : null,
      topSkills,
      recentThreads,
      recentPosts: recentPosts.map((row) => ({ id: row.id, threadId: row.thread_id, threadTitle: row.thread_title, threadSlug: row.thread_slug, createdAt: row.created_at })),
    };
  }

  listForumAvatarBakeTargets(): ForumAvatarBakeTarget[] {
    const rows = this.db.query(`
      SELECT a.id AS account_id, a.username, ps.appearance, ps.equipment
      FROM accounts a
      JOIN player_state ps ON ps.account_id = a.id
      ORDER BY lower(a.username) ASC
    `).all() as Array<{ account_id: number; username: string; appearance: string | null; equipment: string | null }>;
    return rows
      .map((row) => forumAvatarTarget(row.account_id, row.username, row.appearance, row.equipment))
      .filter((target): target is ForumAvatarBakeTarget => target !== null);
  }

  grantForumModerator(targetUsername: string, grantedByAccountId: number): { ok: true } | { ok: false; error: string } {
    const accountId = this.getAccountIdByUsername(targetUsername);
    if (accountId == null) return { ok: false, error: 'Account not found.' };
    this.db.query('INSERT INTO forum_moderators (account_id, granted_by_account_id) VALUES (?, ?) ON CONFLICT(account_id) DO UPDATE SET granted_by_account_id = excluded.granted_by_account_id, granted_at = unixepoch()')
      .run(accountId, grantedByAccountId);
    return { ok: true };
  }

  revokeForumModerator(targetUsername: string): { ok: true } | { ok: false; error: string } {
    const accountId = this.getAccountIdByUsername(targetUsername);
    if (accountId == null) return { ok: false, error: 'Account not found.' };
    this.db.query('DELETE FROM forum_moderators WHERE account_id = ?').run(accountId);
    return { ok: true };
  }

  listForumModerators(): Array<{ accountId: number; username: string; grantedAt: number }> {
    const rows = this.db.query('SELECT fm.account_id, a.username, fm.granted_at FROM forum_moderators fm JOIN accounts a ON a.id = fm.account_id ORDER BY lower(a.username)')
      .all() as Array<{ account_id: number; username: string; granted_at: number }>;
    return rows.map((row) => ({ accountId: row.account_id, username: row.username, grantedAt: row.granted_at }));
  }

  cleanExpiredSessions(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.query('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.query('DELETE FROM oauth_authorization_codes WHERE expires_at <= ?').run(now);
    this.db.query('DELETE FROM oauth_refresh_tokens WHERE expires_at <= ?').run(now);
  }

  // -- Bans -----------------------------------------------------------------

  /** Look up an account id by username (case-insensitive — matches the
   *  accounts.username COLLATE NOCASE constraint). Returns null when no
   *  account exists with that name. */
  getAccountIdByUsername(username: string): number | null {
    const row = this.db.query('SELECT id FROM accounts WHERE username = ?').get(username) as { id: number } | null;
    return row?.id ?? null;
  }

  getUsernameByAccountId(accountId: number): string | null {
    const row = this.db.query('SELECT username FROM accounts WHERE id = ?').get(accountId) as { username: string } | null;
    return row?.username ?? null;
  }

  listSocialRelations(accountId: number): SocialLists {
    const readList = (listType: SocialListKind): SocialEntry[] => {
      const rows = this.db.query(`
        SELECT a.id, a.username
        FROM account_social s
        JOIN accounts a ON a.id = s.target_account_id
        WHERE s.account_id = ? AND s.list_type = ?
        ORDER BY lower(a.username) ASC
      `).all(accountId, listType) as Array<{ id: number; username: string }>;
      return rows.map(row => ({ accountId: row.id, username: row.username }));
    };

    return {
      friends: readList('friends'),
      ignore: readList('ignore'),
    };
  }

  addSocialRelation(
    accountId: number,
    targetUsername: string,
    listType: SocialListKind,
  ): { ok: true; entry: SocialEntry } | { ok: false; error: string } {
    const name = targetUsername.trim();
    if (!name) return { ok: false, error: 'Enter a username.' };
    const target = this.db.query('SELECT id, username FROM accounts WHERE username = ?')
      .get(name) as { id: number; username: string } | null;
    if (!target) return { ok: false, error: `No account named "${name}" found.` };
    if (target.id === accountId) {
      return {
        ok: false,
        error: listType === 'friends'
          ? 'You cannot add yourself as a friend.'
          : 'You cannot ignore yourself.',
      };
    }

    this.db.query(`
      INSERT INTO account_social (account_id, target_account_id, list_type, created_at)
      VALUES (?, ?, ?, unixepoch())
      ON CONFLICT(account_id, target_account_id) DO UPDATE SET
        list_type = excluded.list_type,
        created_at = excluded.created_at
    `).run(accountId, target.id, listType);
    return { ok: true, entry: { accountId: target.id, username: target.username } };
  }

  removeSocialRelation(accountId: number, targetUsername: string, listType: SocialListKind): { ok: true } | { ok: false; error: string } {
    const name = targetUsername.trim();
    if (!name) return { ok: false, error: 'Enter a username.' };
    const targetId = this.getAccountIdByUsername(name);
    if (targetId == null) return { ok: false, error: `No account named "${name}" found.` };
    this.db.query('DELETE FROM account_social WHERE account_id = ? AND target_account_id = ? AND list_type = ?')
      .run(accountId, targetId, listType);
    return { ok: true };
  }

  isIgnoring(accountId: number, targetAccountId: number): boolean {
    const row = this.db.query(`
      SELECT 1 FROM account_social
      WHERE account_id = ? AND target_account_id = ? AND list_type = 'ignore'
    `).get(accountId, targetAccountId);
    return !!row;
  }

  getAccountModerationInfo(accountId: number): { accountId: number; username: string; isAdmin: boolean; isModerator: boolean } | null {
    const row = this.db.query('SELECT id, username, is_admin, is_moderator FROM accounts WHERE id = ?')
      .get(accountId) as { id: number; username: string; is_admin: number; is_moderator: number } | null;
    return row ? { accountId: row.id, username: row.username, isAdmin: row.is_admin === 1, isModerator: row.is_moderator === 1 } : null;
  }

  setAccountModeratorRole(accountId: number, enabled: boolean): { accountId: number; username: string; isAdmin: boolean; isModerator: boolean } | null {
    const value = enabled ? 1 : 0;
    this.db.query('UPDATE accounts SET is_moderator = ? WHERE id = ?').run(value, accountId);
    return this.getAccountModerationInfo(accountId);
  }

  getAccountCreatedAt(accountId: number): number | null {
    const row = this.db.query('SELECT created_at FROM accounts WHERE id = ?').get(accountId) as { created_at: number | null } | null;
    return row && row.created_at != null ? row.created_at : null;
  }

  // Forum notification rows accumulate forever (only marked read). Prune read
  // ones past a retention cutoff to keep the table and DB file from bloating.
  cleanupOldForumNotifications(olderThanUnix: number): number {
    return this.db.query('DELETE FROM forum_notifications WHERE read_at IS NOT NULL AND created_at < ?').run(olderThanUnix).changes;
  }

  private pruneExpiredBans(): void {
    const now = Math.floor(Date.now() / 1000);
    this.db.query('DELETE FROM account_bans WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
    this.db.query('DELETE FROM ip_bans WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
    this.db.query('DELETE FROM account_mutes WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
  }

  /** Shared upsert for the two ban tables. Table/keyCol come from string
   *  literals at the call site (not user input) so the template-literal SQL
   *  is safe. */
  private upsertBan(
    table: 'account_bans' | 'ip_bans',
    keyCol: 'account_id' | 'ip_address',
    key: number | string,
    reason: string,
    bannedBy: string,
    expiresAt: number | null = null,
  ): void {
    this.db.query(`
      INSERT INTO ${table} (${keyCol}, reason, banned_by, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(${keyCol}) DO UPDATE SET
        reason = excluded.reason,
        banned_by = excluded.banned_by,
        expires_at = excluded.expires_at,
        banned_at = unixepoch()
    `).run(key, reason, bannedBy, expiresAt);
  }

  private readBan(table: 'account_bans' | 'ip_bans', keyCol: 'account_id' | 'ip_address', key: number | string): BanInfo | null {
    const row = this.db.query(`SELECT reason, banned_at, expires_at FROM ${table} WHERE ${keyCol} = ?`)
      .get(key) as { reason: string; banned_at: number; expires_at: number | null } | null;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Math.floor(Date.now() / 1000)) {
      this.db.query(`DELETE FROM ${table} WHERE ${keyCol} = ?`).run(key);
      return null;
    }
    return { reason: row.reason, bannedAt: row.banned_at, expiresAt: row.expires_at };
  }

  private upsertMute(accountId: number, reason: string, mutedBy: string, expiresAt: number | null = null): void {
    this.db.query(`
      INSERT INTO account_mutes (account_id, reason, muted_by, expires_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        reason = excluded.reason,
        muted_by = excluded.muted_by,
        expires_at = excluded.expires_at,
        muted_at = unixepoch()
    `).run(accountId, reason, mutedBy, expiresAt);
  }

  private readMute(accountId: number): MuteInfo | null {
    const row = this.db.query('SELECT reason, muted_at, expires_at FROM account_mutes WHERE account_id = ?')
      .get(accountId) as { reason: string; muted_at: number; expires_at: number | null } | null;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Math.floor(Date.now() / 1000)) {
      this.unmuteAccount(accountId);
      return null;
    }
    return { reason: row.reason, mutedAt: row.muted_at, expiresAt: row.expires_at };
  }

  banAccount(accountId: number, reason: string, bannedBy: string, expiresAt: number | null = null): void {
    this.upsertBan('account_bans', 'account_id', accountId, reason, bannedBy, expiresAt);
  }

  unbanAccount(accountId: number): boolean {
    return this.db.query('DELETE FROM account_bans WHERE account_id = ?').run(accountId).changes > 0;
  }

  isAccountBanned(accountId: number): BanInfo | null {
    return this.readBan('account_bans', 'account_id', accountId);
  }

  banIp(ip: string, reason: string, bannedBy: string, expiresAt: number | null = null): void {
    this.upsertBan('ip_bans', 'ip_address', ip, reason, bannedBy, expiresAt);
  }

  unbanIp(ip: string): boolean {
    return this.db.query('DELETE FROM ip_bans WHERE ip_address = ?').run(ip).changes > 0;
  }

  isIpBanned(ip: string): BanInfo | null {
    if (!ip) return null;
    return this.readBan('ip_bans', 'ip_address', ip);
  }

  muteAccount(accountId: number, reason: string, mutedBy: string, expiresAt: number | null = null): void {
    this.upsertMute(accountId, reason, mutedBy, expiresAt);
  }

  unmuteAccount(accountId: number): boolean {
    return this.db.query('DELETE FROM account_mutes WHERE account_id = ?').run(accountId).changes > 0;
  }

  isAccountMuted(accountId: number): MuteInfo | null {
    return this.readMute(accountId);
  }

  /** Most-recent IP recorded for an account in login_history. Used by /ipban
   *  to resolve a username → IP without forcing the admin to look it up. */
  getLatestIpForAccount(accountId: number): string | null {
    const row = this.db.query(
      'SELECT ip_address FROM login_history WHERE account_id = ? ORDER BY login_ts DESC LIMIT 1'
    ).get(accountId) as { ip_address: string } | null;
    return row?.ip_address ?? null;
  }

  getAccountBanRecord(accountId: number): AccountBanRecord | null {
    const row = this.db.query(`
      SELECT ab.account_id, a.username, ab.reason, ab.banned_at, ab.expires_at, ab.banned_by
      FROM account_bans ab
      JOIN accounts a ON a.id = ab.account_id
      WHERE ab.account_id = ?
    `).get(accountId) as { account_id: number; username: string; reason: string; banned_at: number; expires_at: number | null; banned_by: string } | null;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Math.floor(Date.now() / 1000)) {
      this.unbanAccount(accountId);
      return null;
    }
    return {
      accountId: row.account_id,
      username: row.username,
      reason: row.reason,
      bannedAt: row.banned_at,
      expiresAt: row.expires_at,
      bannedBy: row.banned_by,
    };
  }

  getIpBanRecord(ip: string): IpBanRecord | null {
    if (!ip) return null;
    const row = this.db.query('SELECT ip_address, reason, banned_at, expires_at, banned_by FROM ip_bans WHERE ip_address = ?')
      .get(ip) as { ip_address: string; reason: string; banned_at: number; expires_at: number | null; banned_by: string } | null;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Math.floor(Date.now() / 1000)) {
      this.unbanIp(ip);
      return null;
    }
    return {
      ip: row.ip_address,
      reason: row.reason,
      bannedAt: row.banned_at,
      expiresAt: row.expires_at,
      bannedBy: row.banned_by,
    };
  }

  getAccountMuteRecord(accountId: number): AccountMuteRecord | null {
    const row = this.db.query(`
      SELECT am.account_id, a.username, am.reason, am.muted_at, am.expires_at, am.muted_by
      FROM account_mutes am
      JOIN accounts a ON a.id = am.account_id
      WHERE am.account_id = ?
    `).get(accountId) as { account_id: number; username: string; reason: string; muted_at: number; expires_at: number | null; muted_by: string } | null;
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= Math.floor(Date.now() / 1000)) {
      this.unmuteAccount(accountId);
      return null;
    }
    return {
      accountId: row.account_id,
      username: row.username,
      reason: row.reason,
      mutedAt: row.muted_at,
      expiresAt: row.expires_at,
      mutedBy: row.muted_by,
    };
  }

  listAccountBans(): Array<AccountBanRecord> {
    this.pruneExpiredBans();
    return this.db.query(`
      SELECT ab.account_id, a.username, ab.reason, ab.banned_at, ab.expires_at, ab.banned_by
      FROM account_bans ab JOIN accounts a ON a.id = ab.account_id
      ORDER BY ab.banned_at DESC
    `).all().map((r) => {
      const row = r as { account_id: number; username: string; reason: string; banned_at: number; expires_at: number | null; banned_by: string };
      return { accountId: row.account_id, username: row.username, reason: row.reason, bannedAt: row.banned_at, expiresAt: row.expires_at, bannedBy: row.banned_by };
    });
  }

  listIpBans(): Array<IpBanRecord> {
    this.pruneExpiredBans();
    return this.db.query('SELECT ip_address, reason, banned_at, expires_at, banned_by FROM ip_bans ORDER BY banned_at DESC')
      .all().map((r) => {
        const row = r as { ip_address: string; reason: string; banned_at: number; expires_at: number | null; banned_by: string };
        return { ip: row.ip_address, reason: row.reason, bannedAt: row.banned_at, expiresAt: row.expires_at, bannedBy: row.banned_by };
      });
  }

  close(): void {
    this.flushGameEventLog();
    if (this.gameEventFlushTimer !== null) {
      clearTimeout(this.gameEventFlushTimer);
      this.gameEventFlushTimer = null;
    }
    this.db.close();
  }
}
