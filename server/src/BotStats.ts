import type { BotStatsRow, GameDatabase } from './Database';
import { audit } from './Audit';
import { ClientActivityKind, TICK_RATE } from '@projectrs/shared';
import type { SkillId } from '@projectrs/shared';

/**
 * Per-player bot-detection telemetry. Lives on each connected Player,
 * accumulates signal in memory, persists periodically to the bot_stats
 * SQLite table via checkpoint(), and emits a session-summary JSONL line to
 * the audit log on logout (finalize()).
 *
 * Design notes:
 *
 * - **Flag-only, not auto-action.** A real bot will trip multiple flags
 *   over a single session; a steady human grinder might trip one. The
 *   review CLI surfaces accounts to inspect, never bans anyone.
 *
 * - **Memory-first, periodic flush.** Stats live on the Player object
 *   for fast accumulation. checkpoint() syncs to DB every 5 min; logout
 *   does a final flush. If the server crashes mid-session we lose the
 *   in-progress window — fine because real bots play many sessions.
 *
 * - **Capped sample arrays.** tick-align and reaction samples are rolling
 *   windows of N most recent. Path destinations are capped at 100 unique
 *   tiles (evicts the least-visited if full). Bounds memory regardless of
 *   session length.
 *
 * - **No client-observable side effects.** Hooks bump counters and that's
 *   it. Zero packets sent, zero new ticks. Mobile-budget safe.
 */

const MAX_TICK_ALIGN_SAMPLES = 100;
const MAX_REACTION_SAMPLES = 50;
const MAX_PING_INTERVAL_SAMPLES = 100;
const MAX_ACTIVITY_INTERVAL_SAMPLES = 100;
const MAX_GAMEPLAY_COMMAND_INTERVAL_SAMPLES = 120;
const MAX_GAMEPLAY_COMMAND_PATTERN_EVENTS = 160;
const MAX_PATH_DESTINATIONS = 100;
const MAX_ACTION_SIGNATURES = 100;
const MAX_COMMAND_TIMING_SIGNATURES = 80;
const MAX_CURSOR_CELLS = 64;
const MAX_INPUT_TICKET_TARGET_CELLS = 64;
const MAX_INPUT_TICKET_TARGET_SIGNATURES_PER_CELL = 24;
const MAX_SUSPICIOUS_REASONS = 80;
const MAX_SESSION_HISTORY = 12;
const ACTION_ROUTE_MEMORY_MS = 10_000;
const HEARTBEAT_ACTIVITY_COUPLING_MS = 350;
const MIN_RAPID_COMMAND_TIMING_INTERVAL_MS = 50;
const MIN_COMMAND_TIMING_INTERVAL_MS = 250;
const MAX_COMMAND_TIMING_INTERVAL_MS = 60_000;
const COMMAND_INTERVAL_PATTERN_BIN_MS = 100;
const MIN_RAPID_COMMAND_INTERVAL_SAMPLES = 16;
const MIN_MEANINGFUL_SESSION_MINUTES = 5;
const MIN_ROUTE_ACTION_LOOP_SIGNATURES = 20;
const MIN_XP_VELOCITY_SESSION_MINUTES = 5;
const MIN_XP_VELOCITY_ACTIVE_EVENTS = 20;
const IDLE_BREAK_MIN_MS = 5 * 60_000;
const MIN_NO_IDLE_SESSION_MINUTES = 240;
const MIN_NO_IDLE_ACTIVE_EVENTS = 400;
const MIN_MARATHON_NO_IDLE_SESSION_MINUTES = 360;
const MIN_MARATHON_NO_IDLE_ACTIVE_EVENTS = 800;
const MIN_POST_DEATH_ROUTE_MOVES = 3;
const MAX_MAP_DATA_FILES = 256;
const MAP_DATA_SCAN_WINDOW_MS = 60_000;
const MAP_DATA_SCAN_UNIQUE_THRESHOLD = 180;
const MAP_DATA_SCAN_REQUEST_THRESHOLD = 260;
const LEGACY_RESERVED_ACTION_PREFIX = String.fromCharCode(104, 111, 110, 101, 121, 112, 111, 116);
const LEGACY_RESERVED_ACTION_REASON = `${LEGACY_RESERVED_ACTION_PREFIX}-action-capability`;
const LEGACY_RESERVED_ACTION_FLAG = `${LEGACY_RESERVED_ACTION_PREFIX}ActionCapability`;
const ADMIN_OPCODE_ABUSE_REASONS = new Set(['admin-delete-not-admin', 'bank-delete-not-admin']);
const MAP_DATA_OUT_OF_SCOPE_REASON = 'map-data-out-of-scope';
const RESERVED_MAP_DATA_REASON = 'reserved-map-data-path';
const INPUT_SHAPE_TOUCH = 4;

interface InputShapeRecord {
  flags: number;
  buttons: number;
  dwellMs: number;
  moveCount: number;
  coalescedCount: number;
  pathPx: number;
  directPx: number;
}

export interface MapDataScanBurst {
  requests: number;
  uniqueFiles: number;
  sampleFiles: string[];
}

type SuspiciousPacketClass = 'protocol' | 'rateLimit' | 'automation' | 'reserved' | 'state' | 'stale';

interface SuspiciousPacketClassCounts {
  protocol: number;
  rateLimit: number;
  automation: number;
  reserved: number;
  state: number;
  stale: number;
}

/** Realistic max XP/hour per skill. Anything above flags. Calibrated for
 *  EvilQuest's tick rate + drop rates — adjust as content lands. These are
 *  ceilings (faster than a human could plausibly grind), not "expected"
 *  rates. */
const XP_PER_HOUR_CEILING: Record<SkillId, number> = {
  weaponry: 120000,
  strength: 120000,
  defence: 120000,
  hitpoints: 40000,
  archery: 120000,
  goodmagic: 100000,
  evilmagic: 100000,
  woodcutting: 80000,
  fishing: 80000,
  cooking: 100000,
  mining: 80000,
  smithing: 100000,
  crafting: 100000,
  roguery: 80000,
  survival: 80000,
};

export interface SessionSummary {
  sessionMinutes: number;
  sessionSkillingActions: number;
  sessionCombatSwings: number;
  sessionMovements: number;
  sessionMoveCommands: number;
  sessionMoveRedirects: number;
  sessionMaxPathMoveCommands: number;
  sessionPathTruncations: number;
  sessionPlayerDeaths: number;
  sessionPostDeathMoves: number;
  sessionMapDataRequests: number;
  sessionUniqueMapDataFiles: number;
  sessionMapDataScanBursts: number;
  sessionChats: number;
  sessionActivityEvents: number;
  sessionDetailedActivityEvents: number;
  sessionPointerActivityEvents: number;
  sessionKeyboardActivityEvents: number;
  sessionTouchActivityEvents: number;
  sessionLegacyActivityEvents: number;
  sessionCursorEvents: number;
  sessionInputlessCommands: number;
  sessionGameplayCommands: number;
  sessionCommandsWithoutRecentInput: number;
  sessionCommandsWithoutRecentActivity: number;
  sessionActiveIdleBreaks: number;
  longestActiveGapMinutes: number | null;
  sessionSuspiciousPackets: number;
  totalSuspiciousPackets: number;
  sessionSuspiciousPacketReasons: Record<string, number>;
  totalSuspiciousPacketReasons: Record<string, number>;
  sessionSuspiciousPacketClasses: SuspiciousPacketClassCounts;
  totalSuspiciousPacketClasses: SuspiciousPacketClassCounts;
  tickAlignStdDevMs: number | null;
  reactionMedianMs: number | null;
  pingIntervalStdDevMs: number | null;
  pingIntervalMedianMs: number | null;
  activityIntervalStdDevMs: number | null;
  activityIntervalMedianMs: number | null;
  gameplayCommandIntervalSamples: number;
  gameplayCommandIntervalStdDevMs: number | null;
  gameplayCommandIntervalMedianMs: number | null;
  rapidCommandIntervalSamples: number;
  rapidCommandIntervalMedianMs: number | null;
  /** Coefficient of variation (stddev/mean) of command intervals; low-but-nonzero = mechanical jitter. */
  commandIntervalCv: number | null;
  /** p90/median of command intervals; ~1 = no human heavy tail. */
  commandIntervalTailRatio: number | null;
  /** Touch-dominant client: cursor-absence signals are exempted to avoid mobile false positives. */
  isLikelyMobile: boolean;
  sameCommandIntervalSamples: number;
  sameCommandIntervalStdDevMs: number | null;
  sameCommandIntervalMedianMs: number | null;
  gameplayCommandPatternEvents: number;
  gameplayCommandIntervalPatternEvents: number;
  gameplayCommandSequencePatternRatio: number | null;
  gameplayCommandIntervalPatternRatio: number | null;
  activitySeqResets: number;
  heartbeatActivityCouplingRatio: number | null;
  inputlessCommandRatio: number | null;
  activitylessCommandRatio: number | null;
  moveRedirectRatio: number | null;
  maxPathCommandRatio: number | null;
  pathTruncationRatio: number | null;
  topPostDeathDestinationRepetition: number | null;
  topPathRepetition: number | null;
  topActionLoopRepetition: number | null;
  topLifetimePathRepetition: number | null;
  topLifetimeActionLoopRepetition: number | null;
  topCursorCellRepetition: number | null;
  cursorUniqueCells: number;
  sessionInputShapeSamples: number;
  sessionPointerShapeSamples: number;
  pointerNoApproachRatio: number | null;
  sessionInputTicketTargetCommands: number;
  inputTicketTargetUniqueCells: number;
  topInputTicketTargetCellRepetition: number | null;
  topInputTicketTargetCellDistinctTargets: number;
  deviceIdsSeen: number;
  deviceReuseRatio: number | null;
  lifetimeActiveActions: number;
  chatRatePerHour: number | null;
  actionsPerHour: number | null;
  actionsPerChat: number | null;
  longSessionCount: number;
  xpPerHour: Record<string, number>;
  evidenceFlags: string[];
  contextFlags: string[];
  diagnosticFlags: string[];
  flags: string[];
  riskScore: number;
  riskLevel: BotRiskLevel;
  riskReasons: string[];
  /** Structured per-signal breakdown for the admin panel (ranked by points). */
  riskSignals: BotSignalDetail[];
  /** Whether the score includes a hard-evidence signal (else it is capped). */
  riskHardEvidence: boolean;
}

export type BotRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** One scored signal that contributed to a player's bot-risk score. This is
 *  the structured form the admin panel renders so a reviewer can see exactly
 *  what tripped, the value it measured, the threshold it had to beat, and how
 *  many points it added. */
export interface BotSignalDetail {
  /** Stable signal id (matches the flag), e.g. `gameplayCommandCadenceRegular`. */
  flag: string;
  /** Human-readable name shown to admins. */
  label: string;
  /** Plain-language description of the behaviour this signal catches. */
  description: string;
  /** The threshold a player must cross for this signal to fire. */
  threshold: string;
  /** The measured value for this player (already formatted), e.g. `14ms stddev`. */
  measured: string;
  /** Points this signal added to the score. */
  points: number;
  /** hard = strong standalone evidence; soft = supporting; context = combo bonus. */
  tier: 'hard' | 'soft' | 'context';
}

export interface BotRiskProfile {
  score: number;
  level: BotRiskLevel;
  reasons: string[];
  /** Structured per-signal breakdown, ranked by points. Powers the admin
   *  panel's "why flagged" view. `reasons` is the legacy flat-string form. */
  signals: BotSignalDetail[];
  /** True when the score reflects at least one hard-evidence signal. When
   *  false the score is capped (see computeBotRiskProfile). */
  hardEvidence: boolean;
}

export interface SessionHistoryEntry extends SessionSummary {
  finalizedAt: number;
  tick: number;
  meaningful: boolean;
}

export class BotStats {
  // Lifetime counters (accumulate across sessions, persisted)
  totalSkillingActions: number = 0;
  totalCombatSwings: number = 0;
  totalMovements: number = 0;
  totalChatMessages: number = 0;
  totalSessionMinutes: number = 0;
  totalFlagEvents: number = 0;
  /** Lifetime sessions that ended with hard bot evidence (persisted). */
  totalHardFlagEvents: number = 0;
  totalSuspiciousPackets: number = 0;
  lastChatTs: number | null = null;
  lastActionTs: number | null = null;
  lastLoginTs: number | null = null;
  riskScore: number = 0;
  riskLevel: BotRiskLevel = 'low';
  riskReasons: string[] = [];

  // Rolling samples (persisted, capped)
  tickAlignSamples: number[] = [];
  reactionSamples: number[] = [];
  pingIntervalSamples: number[] = [];
  activityIntervalSamples: number[] = [];
  gameplayCommandIntervalSamples: number[] = [];
  rapidCommandIntervalSamples: number[] = [];
  private rapidCommandIntervalRun: number = 0;
  private longestRapidCommandIntervalRun: number = 0;
  sameCommandIntervalSamples: number[] = [];
  gameplayCommandPatternSignatures: string[] = [];
  gameplayCommandIntervalBins: number[] = [];
  pathDestinations: Map<string, number> = new Map();
  actionSignatures: Map<string, number> = new Map();
  deviceIds: Map<string, number> = new Map();
  suspiciousPacketReasons: Map<string, number> = new Map();
  sessionHistory: SessionHistoryEntry[] = [];
  lastSessionSummary: SessionSummary | null = null;

  // Per-skill XP at session start (used to compute session XP/hour rate)
  xpBaseline: Map<string, number> = new Map();

  // Current session state (in-memory only — reset on login)
  sessionStartedAt: number = Date.now();
  sessionSkillingActions: number = 0;
  sessionCombatSwings: number = 0;
  sessionMovements: number = 0;
  sessionMoveCommands: number = 0;
  sessionMoveRedirects: number = 0;
  sessionMaxPathMoveCommands: number = 0;
  sessionPathTruncations: number = 0;
  sessionPlayerDeaths: number = 0;
  sessionPostDeathMoves: number = 0;
  sessionMapDataRequests: number = 0;
  sessionMapDataScanBursts: number = 0;
  sessionChats: number = 0;
  sessionActivityEvents: number = 0;
  sessionDetailedActivityEvents: number = 0;
  sessionPointerActivityEvents: number = 0;
  sessionKeyboardActivityEvents: number = 0;
  sessionTouchActivityEvents: number = 0;
  sessionLegacyActivityEvents: number = 0;
  sessionCursorEvents: number = 0;
  sessionInputlessCommands: number = 0;
  sessionGameplayCommands: number = 0;
  sessionCommandsWithoutRecentInput: number = 0;
  sessionCommandsWithoutRecentActivity: number = 0;
  sessionActiveIdleBreaks: number = 0;
  sessionLongestActiveGapMs: number | null = null;
  sessionSuspiciousPackets: number = 0;
  sessionPathDestinations: Map<string, number> = new Map();
  sessionPostDeathDestinations: Map<string, number> = new Map();
  sessionMapDataFiles: Map<string, number> = new Map();
  sessionActionSignatures: Map<string, number> = new Map();
  sessionSuspiciousPacketReasons: Map<string, number> = new Map();
  cursorCells: Map<string, number> = new Map();
  sessionInputShapeSamples: number = 0;
  sessionPointerShapeSamples: number = 0;
  sessionPointerNoApproachSamples: number = 0;
  sessionInputTicketTargetCommands: number = 0;
  inputTicketTargetCells: Map<string, number> = new Map();
  inputTicketTargetSignaturesByCell: Map<string, Set<string>> = new Map();
  private lastMovementDestinationKey: string | null = null;
  private lastMovementTs: number | null = null;
  private lastPingAt: number | null = null;
  private lastPingSeq: number | null = null;
  private pingSeqResets: number = 0;
  private lastActivityAt: number | null = null;
  private lastActivitySeq: number | null = null;
  private activitySeqResets: number = 0;
  private lastCursorAt: number | null = null;
  private lastGameplayCommandAt: number | null = null;
  private commandTimingSignatures: Map<string, number> = new Map();
  private lastCoupledActivityAt: number | null = null;
  private lastActiveGameplayAt: number | null = null;
  private awaitingPostDeathMovement: boolean = false;
  private mapDataWindowStartedAt: number = Date.now();
  private mapDataWindowRequests: number = 0;
  private mapDataWindowFiles: Set<string> = new Set();
  private mapDataWindowBurstRecorded: boolean = false;
  private activityHeartbeatCoupledEvents: number = 0;
  private sessionLatchedEvidenceFlags: Set<string> = new Set();
  /** When the last NPC died near this player — feeds the next attack's
   *  reaction time delta if it lands within 5 seconds. */
  pendingReactionStart: number | null = null;

  /** Build a fresh stats object for a brand-new account (no DB row). */
  static empty(): BotStats {
    return new BotStats();
  }

  /** Rehydrate from a persisted DB row. JSON-blob columns are parsed here. */
  static fromRow(row: BotStatsRow): BotStats {
    const s = new BotStats();
    s.totalSkillingActions = row.total_skilling_actions;
    s.totalCombatSwings = row.total_combat_swings;
    s.totalMovements = row.total_movements;
    s.totalChatMessages = row.total_chat_messages;
    s.totalSessionMinutes = row.total_session_minutes;
    s.totalFlagEvents = row.total_flag_events;
    s.totalHardFlagEvents = row.total_hard_flag_events ?? 0;
    s.totalSuspiciousPackets = row.total_suspicious_packets ?? 0;
    s.lastChatTs = row.last_chat_ts;
    s.lastActionTs = row.last_action_ts;
    s.lastLoginTs = row.last_login_ts;
    s.riskScore = row.risk_score ?? 0;
    s.riskLevel = normalizeRiskLevel(row.risk_level);
    try { s.riskReasons = JSON.parse(row.risk_reasons ?? '[]'); } catch { s.riskReasons = []; }
    try { s.tickAlignSamples = JSON.parse(row.tick_align_samples); } catch { s.tickAlignSamples = []; }
    try { s.reactionSamples = JSON.parse(row.reaction_samples); } catch { s.reactionSamples = []; }
    try { s.pingIntervalSamples = JSON.parse(row.ping_interval_samples ?? '[]'); } catch { s.pingIntervalSamples = []; }
    try {
      const obj: Record<string, number> = JSON.parse(row.path_destinations);
      for (const [k, v] of Object.entries(obj)) s.pathDestinations.set(k, v);
    } catch { /* empty */ }
    try {
      const obj: Record<string, number> = JSON.parse(row.action_signatures ?? '{}');
      for (const [k, v] of Object.entries(obj)) s.actionSignatures.set(k, v);
    } catch { /* empty */ }
    try {
      const obj: Record<string, number> = JSON.parse(row.device_ids ?? '{}');
      for (const [k, v] of Object.entries(obj)) s.deviceIds.set(k, v);
    } catch { /* empty */ }
    try {
      const obj: Record<string, number> = JSON.parse(row.suspicious_packet_reasons ?? '{}');
      for (const [k, v] of Object.entries(obj)) s.suspiciousPacketReasons.set(k, v);
    } catch { /* empty */ }
    try {
      const obj: Record<string, number> = JSON.parse(row.xp_baseline);
      for (const [k, v] of Object.entries(obj)) s.xpBaseline.set(k, v);
    } catch { /* empty */ }
    s.lastSessionSummary = parseSessionSummary(row.last_session_summary);
    s.sessionHistory = parseSessionHistory(row.session_history);
    return s;
  }

  /** Serialize to a DB row. Called by checkpoint() + finalize(). */
  toRow(lastSummary: SessionSummary | null = null): BotStatsRow {
    const pathObj: Record<string, number> = {};
    for (const [k, v] of this.pathDestinations) pathObj[k] = v;
    const actionObj: Record<string, number> = {};
    for (const [k, v] of this.actionSignatures) actionObj[k] = v;
    const xpObj: Record<string, number> = {};
    for (const [k, v] of this.xpBaseline) xpObj[k] = v;
    const summary = lastSummary ?? this.lastSessionSummary;
    return {
      total_skilling_actions: this.totalSkillingActions,
      total_combat_swings: this.totalCombatSwings,
      total_movements: this.totalMovements,
      total_chat_messages: this.totalChatMessages,
      total_session_minutes: this.totalSessionMinutes,
      total_flag_events: this.totalFlagEvents,
      total_hard_flag_events: this.totalHardFlagEvents,
      total_suspicious_packets: this.totalSuspiciousPackets,
      last_chat_ts: this.lastChatTs,
      last_action_ts: this.lastActionTs,
      last_login_ts: this.lastLoginTs,
      risk_score: this.riskScore,
      risk_level: this.riskLevel,
      risk_reasons: JSON.stringify(this.riskReasons),
      tick_align_samples: JSON.stringify(this.tickAlignSamples),
      reaction_samples: JSON.stringify(this.reactionSamples),
      ping_interval_samples: JSON.stringify(this.pingIntervalSamples),
      path_destinations: JSON.stringify(pathObj),
      action_signatures: JSON.stringify(actionObj),
      device_ids: JSON.stringify(Object.fromEntries(this.deviceIds)),
      suspicious_packet_reasons: JSON.stringify(Object.fromEntries(this.suspiciousPacketReasons)),
      xp_baseline: JSON.stringify(xpObj),
      last_session_summary: summary ? JSON.stringify(summary) : null,
      session_history: JSON.stringify(this.sessionHistory.slice(-MAX_SESSION_HISTORY)),
    };
  }

  /** Mark login: reset session counters, capture current XP per skill as
   *  the baseline so XP-rate is computed against play (not lifetime). */
  onLogin(currentXp: Record<string, number>, deviceId: string = ''): void {
    const now = Date.now();
    this.sessionStartedAt = now;
    this.sessionSkillingActions = 0;
    this.sessionCombatSwings = 0;
    this.sessionMovements = 0;
    this.sessionMoveCommands = 0;
    this.sessionMoveRedirects = 0;
    this.sessionMaxPathMoveCommands = 0;
    this.sessionPathTruncations = 0;
    this.sessionPlayerDeaths = 0;
    this.sessionPostDeathMoves = 0;
    this.sessionMapDataRequests = 0;
    this.sessionMapDataScanBursts = 0;
    this.sessionChats = 0;
    this.sessionActivityEvents = 0;
    this.sessionDetailedActivityEvents = 0;
    this.sessionPointerActivityEvents = 0;
    this.sessionKeyboardActivityEvents = 0;
    this.sessionTouchActivityEvents = 0;
    this.sessionLegacyActivityEvents = 0;
    this.sessionCursorEvents = 0;
    this.sessionInputlessCommands = 0;
    this.sessionGameplayCommands = 0;
    this.sessionCommandsWithoutRecentInput = 0;
    this.sessionCommandsWithoutRecentActivity = 0;
    this.sessionActiveIdleBreaks = 0;
    this.sessionLongestActiveGapMs = null;
    this.sessionSuspiciousPackets = 0;
    this.sessionPathDestinations.clear();
    this.sessionPostDeathDestinations.clear();
    this.sessionMapDataFiles.clear();
    this.sessionActionSignatures.clear();
    this.sessionSuspiciousPacketReasons.clear();
    this.cursorCells.clear();
    this.sessionInputShapeSamples = 0;
    this.sessionPointerShapeSamples = 0;
    this.sessionPointerNoApproachSamples = 0;
    this.sessionInputTicketTargetCommands = 0;
    this.inputTicketTargetCells.clear();
    this.inputTicketTargetSignaturesByCell.clear();
    this.activityIntervalSamples = [];
    this.lastMovementDestinationKey = null;
    this.lastMovementTs = null;
    this.lastPingAt = null;
    this.lastPingSeq = null;
    this.pingSeqResets = 0;
    this.lastActivityAt = null;
    this.lastActivitySeq = null;
    this.activitySeqResets = 0;
    this.lastCursorAt = null;
    this.lastGameplayCommandAt = null;
    this.commandTimingSignatures.clear();
    this.gameplayCommandIntervalSamples = [];
    this.rapidCommandIntervalSamples = [];
    this.rapidCommandIntervalRun = 0;
    this.longestRapidCommandIntervalRun = 0;
    this.sameCommandIntervalSamples = [];
    this.gameplayCommandPatternSignatures = [];
    this.gameplayCommandIntervalBins = [];
    this.sessionLatchedEvidenceFlags.clear();
    this.lastCoupledActivityAt = null;
    this.lastActiveGameplayAt = null;
    this.awaitingPostDeathMovement = false;
    this.mapDataWindowStartedAt = now;
    this.mapDataWindowRequests = 0;
    this.mapDataWindowFiles.clear();
    this.mapDataWindowBurstRecorded = false;
    this.activityHeartbeatCoupledEvents = 0;
    this.pendingReactionStart = null;
    this.xpBaseline.clear();
    for (const [skill, xp] of Object.entries(currentXp)) {
      this.xpBaseline.set(skill, xp);
    }
    if (deviceId) {
      this.deviceIds.set(deviceId, (this.deviceIds.get(deviceId) ?? 0) + 1);
    }
    this.lastLoginTs = Math.floor(now / 1000);
  }

  /** Record a skilling roll (mining tick, fishing tick, etc.). The tick
   *  alignment delta is now treated as diagnostic only: this hook fires from
   *  server tick processing, not raw user input, so it cannot convict alone. */
  recordSkillingRoll(tickStartWallclock: number, performanceNow: number, eventWallclockMs: number = Date.now()): void {
    this.totalSkillingActions++;
    this.sessionSkillingActions++;
    this.recordActiveGameplayEvent(eventWallclockMs);
    const delta = (performanceNow - tickStartWallclock) % TICK_RATE;
    this.pushSample(this.tickAlignSamples, delta, MAX_TICK_ALIGN_SAMPLES);
  }

  /** Record a combat swing. Also closes a pending reaction window if this
   *  swing landed within 5s of an NPC death — that's the canonical
   *  reaction-time signal (re-engage on next mob). */
  recordCombatSwing(tickStartWallclock: number, performanceNow: number, eventWallclockMs: number = Date.now()): void {
    this.totalCombatSwings++;
    this.sessionCombatSwings++;
    this.recordActiveGameplayEvent(eventWallclockMs);
    const delta = (performanceNow - tickStartWallclock) % TICK_RATE;
    this.pushSample(this.tickAlignSamples, delta, MAX_TICK_ALIGN_SAMPLES);
    if (this.pendingReactionStart !== null) {
      const reactionMs = performanceNow - this.pendingReactionStart;
      // 5s cap — past that, this swing isn't a reaction to the death.
      if (reactionMs >= 0 && reactionMs < 5000) {
        this.pushSample(this.reactionSamples, reactionMs, MAX_REACTION_SAMPLES);
      }
      this.pendingReactionStart = null;
    }
  }

  /** Called when an NPC near the player dies. Sets the reaction-time
   *  baseline so the next combat swing's delta gets sampled. */
  recordNpcDeath(performanceNow: number): void {
    this.pendingReactionStart = performanceNow;
  }

  /** Record a completed movement (final destination tile). Bumps the
   *  destination's visit count; evicts the least-visited if at cap. */
  recordMovement(destX: number, destZ: number, eventWallclockMs: number = Date.now()): void {
    this.totalMovements++;
    this.sessionMovements++;
    this.recordActiveGameplayEvent(eventWallclockMs);
    const key = `${Math.floor(destX)},${Math.floor(destZ)}`;
    this.lastMovementDestinationKey = key;
    this.lastMovementTs = Date.now();
    this.bumpCappedMap(this.sessionPathDestinations, key, MAX_PATH_DESTINATIONS);
    this.bumpCappedMap(this.pathDestinations, key, MAX_PATH_DESTINATIONS);
    if (this.awaitingPostDeathMovement) {
      this.sessionPostDeathMoves++;
      this.bumpCappedMap(this.sessionPostDeathDestinations, key, MAX_PATH_DESTINATIONS);
      this.awaitingPostDeathMovement = false;
    }
  }

  recordMoveCommand(pathLength: number, hadQueuedMovement: boolean): void {
    if (pathLength <= 0) return;
    this.sessionMoveCommands++;
    if (hadQueuedMovement) this.sessionMoveRedirects++;
    if (pathLength >= 50) this.sessionMaxPathMoveCommands++;
  }

  recordPathTruncation(): void {
    this.sessionPathTruncations++;
  }

  recordPlayerDeath(): void {
    this.sessionPlayerDeaths++;
    this.awaitingPostDeathMovement = true;
  }

  recordMapDataFetch(mapPath: string, nowMs: number = Date.now()): MapDataScanBurst | null {
    const key = sanitizeSignaturePart(mapPath, 96);
    this.sessionMapDataRequests++;
    this.bumpCappedMap(this.sessionMapDataFiles, key, MAX_MAP_DATA_FILES);

    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (now - this.mapDataWindowStartedAt > MAP_DATA_SCAN_WINDOW_MS) {
      this.mapDataWindowStartedAt = now;
      this.mapDataWindowRequests = 0;
      this.mapDataWindowFiles.clear();
      this.mapDataWindowBurstRecorded = false;
    }
    this.mapDataWindowRequests++;
    this.mapDataWindowFiles.add(key);

    if (
      !this.mapDataWindowBurstRecorded
      && (
        this.mapDataWindowFiles.size >= MAP_DATA_SCAN_UNIQUE_THRESHOLD
        || this.mapDataWindowRequests >= MAP_DATA_SCAN_REQUEST_THRESHOLD
      )
    ) {
      this.mapDataWindowBurstRecorded = true;
      this.sessionMapDataScanBursts++;
      return {
        requests: this.mapDataWindowRequests,
        uniqueFiles: this.mapDataWindowFiles.size,
        sampleFiles: [...this.mapDataWindowFiles].slice(0, 12),
      };
    }
    return null;
  }

  recordMapDataOutOfScope(): void {
    this.recordSuspiciousPacket(MAP_DATA_OUT_OF_SCOPE_REASON);
  }

  recordReservedMapDataPath(): void {
    this.recordSuspiciousPacket(RESERVED_MAP_DATA_REASON);
  }

  private recordActiveGameplayEvent(nowMs: number): void {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const previous = this.lastActiveGameplayAt ?? this.sessionStartedAt;
    const gapMs = now - previous;
    if (gapMs >= 0) {
      this.sessionLongestActiveGapMs = Math.max(this.sessionLongestActiveGapMs ?? 0, gapMs);
      if (gapMs >= IDLE_BREAK_MIN_MS) {
        this.sessionActiveIdleBreaks++;
      }
    }
    this.lastActiveGameplayAt = now;
    this.lastActionTs = Math.floor(now / 1000);
  }

  /** Record a movement+action signature such as "walk to tree tile → chop".
   *  Humans vary timing and targets; browser-command bots often replay the
   *  same route/action loop exactly for long stretches. Session-only to keep
   *  the persisted bot_stats row compact. */
  recordActionSignature(
    actionKind: string,
    targetKey: string | number,
    actorX?: number,
    actorZ?: number,
    actionDetail?: string | number,
  ): void {
    const now = Date.now();
    const fallbackRoute = Number.isFinite(actorX) && Number.isFinite(actorZ)
      ? `${Math.floor(actorX as number)},${Math.floor(actorZ as number)}`
      : 'no-route';
    const routeKey = this.lastMovementDestinationKey && this.lastMovementTs !== null && now - this.lastMovementTs <= ACTION_ROUTE_MEMORY_MS
      ? this.lastMovementDestinationKey
      : fallbackRoute;
    const kind = sanitizeSignaturePart(actionKind, 32);
    const target = sanitizeSignaturePart(String(targetKey), 40);
    const detail = actionDetail === undefined ? '' : `:${sanitizeSignaturePart(String(actionDetail), 24)}`;
    const signature = `${routeKey}>${kind}:${target}${detail}`;
    this.bumpCappedMap(this.sessionActionSignatures, signature, MAX_ACTION_SIGNATURES);
    this.bumpCappedMap(this.actionSignatures, signature, MAX_ACTION_SIGNATURES);
  }

  recordChat(): void {
    this.totalChatMessages++;
    this.sessionChats++;
    this.lastChatTs = Math.floor(Date.now() / 1000);
  }

  recordClientActivity(now?: number): void;
  recordClientActivity(
    kind: ClientActivityKind,
    seq: number | null,
    xPermille?: number | null,
    yPermille?: number | null,
    now?: number,
  ): void;
  recordClientActivity(
    kindOrNow: ClientActivityKind | number = ClientActivityKind.Legacy,
    seq: number | null = null,
    xPermille: number | null = null,
    yPermille: number | null = null,
    now: number = performance.now(),
  ): void {
    const legacyNowOnly = arguments.length <= 1
      && typeof kindOrNow === 'number'
      && kindOrNow > ClientActivityKind.Touch;
    const kind = legacyNowOnly ? ClientActivityKind.Legacy : kindOrNow as ClientActivityKind;
    if (legacyNowOnly) now = kindOrNow;
    this.sessionActivityEvents++;
    if (this.lastActivityAt !== null) {
      const interval = now - this.lastActivityAt;
      if (interval >= 250 && interval <= 60_000) {
        this.pushSample(this.activityIntervalSamples, interval, MAX_ACTIVITY_INTERVAL_SAMPLES);
      }
    }
    if (kind === ClientActivityKind.Pointer) this.sessionPointerActivityEvents++;
    else if (kind === ClientActivityKind.Keyboard) this.sessionKeyboardActivityEvents++;
    else if (kind === ClientActivityKind.Touch) this.sessionTouchActivityEvents++;
    else this.sessionLegacyActivityEvents++;
    if (kind !== ClientActivityKind.Legacy) {
      this.sessionDetailedActivityEvents++;
      if (seq !== null) {
        const normalizedSeq = seq & 0x7fff;
        if (this.lastActivitySeq !== null) {
          const expected = (this.lastActivitySeq + 1) & 0x7fff;
          if (normalizedSeq !== expected) this.activitySeqResets++;
        }
        this.lastActivitySeq = normalizedSeq;
      }
    }
    this.lastActionTs = Math.floor(Date.now() / 1000);
    this.lastActivityAt = now;
    if (this.lastPingAt !== null && Math.abs(now - this.lastPingAt) <= HEARTBEAT_ACTIVITY_COUPLING_MS) {
      this.recordActivityHeartbeatCoupling(now);
    }
  }

  recordCursorPosition(xPermille: number, yPermille: number, now: number = performance.now()): void {
    this.sessionCursorEvents++;
    this.lastCursorAt = now;
    const x = Math.max(0, Math.min(1000, Math.floor(xPermille)));
    const y = Math.max(0, Math.min(1000, Math.floor(yPermille)));
    this.bumpCappedMap(this.cursorCells, `${Math.floor(x / 100)},${Math.floor(y / 100)}`, MAX_CURSOR_CELLS);
  }

  recordInputlessCommand(): void {
    this.sessionInputlessCommands++;
  }

  hasRecentBrowserInput(now: number = performance.now(), maxAgeMs: number = 15_000): boolean {
    return this.hasRecentClientActivity(now, maxAgeMs)
      || (this.lastCursorAt !== null && now - this.lastCursorAt >= 0 && now - this.lastCursorAt <= maxAgeMs);
  }

  hasRecentClientActivity(now: number = performance.now(), maxAgeMs: number = 15_000): boolean {
    return this.lastActivityAt !== null && now - this.lastActivityAt >= 0 && now - this.lastActivityAt <= maxAgeMs;
  }

  recordGameplayCommandInputCheck(hadRecentInput: boolean, hadRecentActivity: boolean = hadRecentInput): void {
    this.sessionGameplayCommands++;
    if (!hadRecentInput) {
      this.sessionCommandsWithoutRecentInput++;
      this.recordInputlessCommand();
    }
    if (!hadRecentActivity) {
      this.sessionCommandsWithoutRecentActivity++;
    }
  }

  recordGameplayCommandInputTicketTarget(
    kind: ClientActivityKind,
    xPermille: number,
    yPermille: number,
    targetSignature: string,
  ): void {
    if (kind !== ClientActivityKind.Pointer && kind !== ClientActivityKind.Touch) return;
    if (!Number.isFinite(xPermille) || !Number.isFinite(yPermille) || xPermille < 0 || yPermille < 0) return;
    const x = Math.max(0, Math.min(1000, Math.floor(xPermille)));
    const y = Math.max(0, Math.min(1000, Math.floor(yPermille)));
    const cell = `${Math.floor(x / 100)},${Math.floor(y / 100)}`;
    this.sessionInputTicketTargetCommands++;
    this.bumpCappedMap(this.inputTicketTargetCells, cell, MAX_INPUT_TICKET_TARGET_CELLS);
    let signatures = this.inputTicketTargetSignaturesByCell.get(cell);
    if (!signatures) {
      signatures = new Set();
      this.inputTicketTargetSignaturesByCell.set(cell, signatures);
    }
    if (signatures.size < MAX_INPUT_TICKET_TARGET_SIGNATURES_PER_CELL) {
      signatures.add(sanitizeSignaturePart(targetSignature, 64));
    }
  }

  recordGameplayCommandInputShape(kind: ClientActivityKind, shape?: InputShapeRecord): void {
    if (!shape) return;
    this.sessionInputShapeSamples++;
    if (kind !== ClientActivityKind.Pointer && kind !== ClientActivityKind.Touch) return;
    this.sessionPointerShapeSamples++;
    const isTouch = kind === ClientActivityKind.Touch || (shape.flags & INPUT_SHAPE_TOUCH) !== 0;
    const hasApproach = shape.moveCount > 0 || shape.coalescedCount > 0 || shape.pathPx > 0 || shape.directPx > 0;
    if (!isTouch && !hasApproach) this.sessionPointerNoApproachSamples++;
  }

  /** Record timing for validated gameplay commands. This uses server receive
   *  time, not client-reported DOM timing, so a modified client cannot simply
   *  lie about click cadence. Short packet pairs from one click are ignored. */
  recordGameplayCommandTiming(signature: string, now: number = performance.now()): void {
    if (!Number.isFinite(now)) return;
    if (this.lastGameplayCommandAt !== null) {
      const interval = now - this.lastGameplayCommandAt;
      if (this.recordCommandInterval(this.gameplayCommandIntervalSamples, interval)) {
        this.rapidCommandIntervalRun = 0;
        this.pushCommandIntervalPatternBin(interval);
      } else if (interval >= MIN_RAPID_COMMAND_TIMING_INTERVAL_MS && interval < MIN_COMMAND_TIMING_INTERVAL_MS) {
        this.pushSample(this.rapidCommandIntervalSamples, interval, MAX_GAMEPLAY_COMMAND_INTERVAL_SAMPLES);
        this.rapidCommandIntervalRun++;
        this.longestRapidCommandIntervalRun = Math.max(this.longestRapidCommandIntervalRun, this.rapidCommandIntervalRun);
      } else if (interval >= MIN_COMMAND_TIMING_INTERVAL_MS) {
        this.rapidCommandIntervalRun = 0;
      }
    }
    this.lastGameplayCommandAt = now;

    const cleanSignature = sanitizeSignaturePart(signature, 96);
    this.gameplayCommandPatternSignatures.push(cleanSignature);
    if (this.gameplayCommandPatternSignatures.length > MAX_GAMEPLAY_COMMAND_PATTERN_EVENTS) {
      this.gameplayCommandPatternSignatures.shift();
    }
    const previousForSignature = this.commandTimingSignatures.get(cleanSignature);
    if (previousForSignature !== undefined) {
      this.recordCommandInterval(this.sameCommandIntervalSamples, now - previousForSignature);
    } else if (this.commandTimingSignatures.size >= MAX_COMMAND_TIMING_SIGNATURES) {
      const oldest = this.commandTimingSignatures.keys().next().value;
      if (oldest !== undefined) this.commandTimingSignatures.delete(oldest);
    }
    this.commandTimingSignatures.set(cleanSignature, now);
    this.latchTimingEvidence();
  }

  private latchTimingEvidence(): void {
    const gameplayStdDev = stdDev(this.gameplayCommandIntervalSamples);
    const sameStdDev = stdDev(this.sameCommandIntervalSamples);
    const intervalPatternRatio = maxLagMatchRatio(this.gameplayCommandIntervalBins, 2, 8);
    const mechanicalJitter = analyzeMechanicalJitter(this.gameplayCommandIntervalSamples);
    if (this.longestRapidCommandIntervalRun >= MIN_RAPID_COMMAND_INTERVAL_SAMPLES) this.sessionLatchedEvidenceFlags.add('rapidGameplayCommandCadence');
    if (this.gameplayCommandIntervalSamples.length >= 24 && gameplayStdDev !== null && gameplayStdDev < 65) this.sessionLatchedEvidenceFlags.add('gameplayCommandCadenceRegular');
    if (this.sameCommandIntervalSamples.length >= 12 && sameStdDev !== null && sameStdDev < 75) this.sessionLatchedEvidenceFlags.add('sameCommandCadenceRegular');
    if (this.gameplayCommandIntervalBins.length >= 24 && intervalPatternRatio !== null && intervalPatternRatio >= 0.85) this.sessionLatchedEvidenceFlags.add('gameplayCommandIntervalPattern');
    if (mechanicalJitter.isMechanical) this.sessionLatchedEvidenceFlags.add('mechanicalJitter');
  }

  private recordCommandInterval(samples: number[], interval: number): boolean {
    if (
      interval >= MIN_COMMAND_TIMING_INTERVAL_MS
      && interval <= MAX_COMMAND_TIMING_INTERVAL_MS
    ) {
      this.pushSample(samples, interval, MAX_GAMEPLAY_COMMAND_INTERVAL_SAMPLES);
      return true;
    }
    return false;
  }

  private pushCommandIntervalPatternBin(interval: number): void {
    const bin = Math.round(interval / COMMAND_INTERVAL_PATTERN_BIN_MS);
    this.gameplayCommandIntervalBins.push(bin);
    if (this.gameplayCommandIntervalBins.length > MAX_GAMEPLAY_COMMAND_PATTERN_EVENTS) {
      this.gameplayCommandIntervalBins.shift();
    }
  }

  recordSuspiciousPacket(reason: string = 'unknown'): void {
    this.totalSuspiciousPackets++;
    this.sessionSuspiciousPackets++;
    const cleanReason = sanitizeSuspiciousReason(reason);
    this.bumpCappedMap(this.sessionSuspiciousPacketReasons, cleanReason, MAX_SUSPICIOUS_REASONS);
    this.bumpCappedMap(this.suspiciousPacketReasons, cleanReason, MAX_SUSPICIOUS_REASONS);
    this.lastActionTs = Math.floor(Date.now() / 1000);
  }

  /** Browser heartbeat timing. The official client sends every 5s via
   *  setInterval, but real browsers/network stacks add jitter. A raw script
   *  tends to produce near-perfect intervals and sequence monotonicity. */
  recordHeartbeat(seq: number, now: number = performance.now()): void {
    if (this.lastPingAt !== null) {
      const interval = now - this.lastPingAt;
      if (interval >= 1000 && interval <= 30000) {
        this.pushSample(this.pingIntervalSamples, interval, MAX_PING_INTERVAL_SAMPLES);
      }
    }
    if (this.lastPingSeq !== null) {
      const expected = (this.lastPingSeq + 1) & 0x7fff;
      if (seq !== expected) this.pingSeqResets++;
    }
    if (this.lastActivityAt !== null && Math.abs(now - this.lastActivityAt) <= HEARTBEAT_ACTIVITY_COUPLING_MS) {
      this.recordActivityHeartbeatCoupling(this.lastActivityAt);
    }
    this.lastPingSeq = seq;
    this.lastPingAt = now;
  }

  /** Compute session summary + flags. Pure read-only on stats. */
  computeSummary(currentXp: Record<string, number>): SessionSummary {
    const now = Date.now();
    const sessionMinutes = Math.floor((now - this.sessionStartedAt) / 60000);
    const tickAlignStdDevMs = stdDev(this.tickAlignSamples);
    const reactionMedianMs = median(this.reactionSamples);
    const pingIntervalStdDevMs = stdDev(this.pingIntervalSamples);
    const pingIntervalMedianMs = median(this.pingIntervalSamples);
    const activityIntervalStdDevMs = stdDev(this.activityIntervalSamples);
    const activityIntervalMedianMs = median(this.activityIntervalSamples);
    const gameplayCommandIntervalStdDevMs = stdDev(this.gameplayCommandIntervalSamples);
    const gameplayCommandIntervalMedianMs = median(this.gameplayCommandIntervalSamples);
    const rapidCommandIntervalMedianMs = median(this.rapidCommandIntervalSamples);
    const sameCommandIntervalStdDevMs = stdDev(this.sameCommandIntervalSamples);
    const sameCommandIntervalMedianMs = median(this.sameCommandIntervalSamples);
    const gameplayCommandSequencePatternRatio = maxLagMatchRatio(this.gameplayCommandPatternSignatures, 2, 8);
    const gameplayCommandIntervalPatternRatio = maxLagMatchRatio(this.gameplayCommandIntervalBins, 2, 8);
    const topPathRepetition = topRatio(this.sessionPathDestinations);
    const topPostDeathDestinationRepetition = topRatio(this.sessionPostDeathDestinations);
    const topActionLoopRepetition = topRatio(this.sessionActionSignatures);
    const sessionUniqueMapDataFiles = this.sessionMapDataFiles.size;
    const topLifetimePathRepetition = topRatio(this.pathDestinations);
    const topLifetimeActionLoopRepetition = topRatio(this.actionSignatures);
    const topCursorCellRepetition = topRatio(this.cursorCells);
    const pointerNoApproachRatio = this.sessionPointerShapeSamples > 0
      ? this.sessionPointerNoApproachSamples / this.sessionPointerShapeSamples
      : null;
    const topInputTicketTargetCell = topEntry(this.inputTicketTargetCells);
    const topInputTicketTargetCellRepetition = this.sessionInputTicketTargetCommands > 0 && topInputTicketTargetCell
      ? topInputTicketTargetCell[1] / this.sessionInputTicketTargetCommands
      : null;
    const topInputTicketTargetCellDistinctTargets = topInputTicketTargetCell
      ? this.inputTicketTargetSignaturesByCell.get(topInputTicketTargetCell[0])?.size ?? 0
      : 0;
    const sessionSuspiciousPacketReasons = mapToObject(this.sessionSuspiciousPacketReasons);
    const totalSuspiciousPacketReasons = mapToObject(this.suspiciousPacketReasons);
    const sessionSuspiciousPacketClasses = classifyReasonCounts(this.sessionSuspiciousPacketReasons);
    const totalSuspiciousPacketClasses = classifyReasonCounts(this.suspiciousPacketReasons);
    const heartbeatActivityCouplingRatio = this.sessionActivityEvents > 0
      ? this.activityHeartbeatCoupledEvents / this.sessionActivityEvents
      : null;
    const inputlessCommandRatio = this.sessionGameplayCommands > 0
      ? this.sessionCommandsWithoutRecentInput / this.sessionGameplayCommands
      : null;
    const activitylessCommandRatio = this.sessionGameplayCommands > 0
      ? this.sessionCommandsWithoutRecentActivity / this.sessionGameplayCommands
      : null;
    const moveRedirectRatio = this.sessionMoveCommands > 0
      ? this.sessionMoveRedirects / this.sessionMoveCommands
      : null;
    const maxPathCommandRatio = this.sessionMoveCommands > 0
      ? this.sessionMaxPathMoveCommands / this.sessionMoveCommands
      : null;
    const pathTruncationRatio = this.sessionMoveCommands > 0
      ? this.sessionPathTruncations / this.sessionMoveCommands
      : null;
    const longestActiveGapMinutes = this.sessionLongestActiveGapMs !== null
      ? this.sessionLongestActiveGapMs / 60000
      : null;
    const deviceIdsSeen = this.deviceIds.size;
    const deviceLogins = [...this.deviceIds.values()].reduce((a, b) => a + b, 0);
    const maxDeviceReuse = this.deviceIds.size > 0 ? Math.max(...this.deviceIds.values()) : 0;
    const deviceReuseRatio = deviceLogins > 0 ? maxDeviceReuse / deviceLogins : null;
    const effectiveTotalMinutes = this.totalSessionMinutes + sessionMinutes;
    const lifetimeActiveActions = this.totalSkillingActions + this.totalCombatSwings + this.totalMovements;
    const lifetimeHours = effectiveTotalMinutes > 0 ? effectiveTotalMinutes / 60 : null;
    const chatRatePerHour = lifetimeHours !== null ? this.totalChatMessages / lifetimeHours : null;
    const actionsPerHour = lifetimeHours !== null ? lifetimeActiveActions / lifetimeHours : null;
    const actionsPerChat = this.totalChatMessages > 0 ? lifetimeActiveActions / this.totalChatMessages : null;
    const longSessionCount = this.sessionHistory.filter((entry) => entry.sessionMinutes >= 240).length
      + (sessionMinutes >= 240 ? 1 : 0);

    // XP rate per skill = (current - baseline) / hours
    const hours = Math.max(1 / 60, sessionMinutes / 60);
    const xpPerHour: Record<string, number> = {};
    for (const [skill, current] of Object.entries(currentXp)) {
      const baseline = this.xpBaseline.get(skill) ?? current;
      const delta = current - baseline;
      if (delta > 0) xpPerHour[skill] = Math.round(delta / hours);
    }

    const flags: string[] = [];
    const activeEvents = this.sessionSkillingActions + this.sessionCombatSwings + this.sessionMovements;
    const directGameplayEvents = this.sessionSkillingActions + this.sessionCombatSwings;
    const sessionActionSignatureCount = mapTotal(this.sessionActionSignatures);

    // Touch-dominant activity = phone/tablet. Such clients legitimately emit
    // little/no cursor-move (pointermove) telemetry, so the cursor-ABSENCE
    // signals below would false-flag them. We suppress only those for mobile;
    // every positive automation detector still applies, and touch counts are
    // client-asserted so reporting "mobile" can never grant a bot immunity.
    const isLikelyMobile = isLikelyMobileSession(
      this.sessionTouchActivityEvents,
      this.sessionPointerActivityEvents,
      this.sessionKeyboardActivityEvents,
    );

    const mechanicalJitter = analyzeMechanicalJitter(this.gameplayCommandIntervalSamples);
    // tickAligned: stddev < 30ms over ≥30 samples → near-zero variance
    if (this.tickAlignSamples.length >= 30 && tickAlignStdDevMs !== null && tickAlignStdDevMs < 30) {
      flags.push('tickAligned');
    }
    if (this.pingIntervalSamples.length >= 12 && pingIntervalStdDevMs !== null && pingIntervalStdDevMs < 20) {
      flags.push('pingRegular');
    }
    if (this.pingSeqResets >= 2) {
      flags.push('pingSeqReset');
    }
    if (
      this.sessionActivityEvents >= 10
      && heartbeatActivityCouplingRatio !== null
      && heartbeatActivityCouplingRatio >= 0.8
    ) {
      flags.push('activityHeartbeatCoupled');
    }
    if (
      this.activityIntervalSamples.length >= 10
      && activityIntervalStdDevMs !== null
      && activityIntervalStdDevMs < 75
    ) {
      flags.push('activityRegular');
    }
    if (
      this.gameplayCommandIntervalSamples.length >= 24
      && gameplayCommandIntervalStdDevMs !== null
      && gameplayCommandIntervalMedianMs !== null
      && gameplayCommandIntervalStdDevMs < 65
    ) {
      flags.push('gameplayCommandCadenceRegular');
    }
    if (this.longestRapidCommandIntervalRun >= MIN_RAPID_COMMAND_INTERVAL_SAMPLES) {
      flags.push('rapidGameplayCommandCadence');
    }
    // Computer "humanized" jitter: nonzero variance (slips past the cadence gate)
    // but a tight, tail-less distribution no human sustains. Distinct from the
    // metronome case above.
    if (mechanicalJitter.isMechanical && !flags.includes('gameplayCommandCadenceRegular')) {
      flags.push('mechanicalJitter');
    }
    if (
      this.sameCommandIntervalSamples.length >= 12
      && sameCommandIntervalStdDevMs !== null
      && sameCommandIntervalMedianMs !== null
      && sameCommandIntervalStdDevMs < 75
    ) {
      flags.push('sameCommandCadenceRegular');
    }
    if (
      this.gameplayCommandPatternSignatures.length >= 30
      && gameplayCommandSequencePatternRatio !== null
      && gameplayCommandSequencePatternRatio >= 0.85
    ) {
      flags.push('gameplayCommandSequencePattern');
    }
    if (
      this.gameplayCommandIntervalBins.length >= 24
      && gameplayCommandIntervalPatternRatio !== null
      && gameplayCommandIntervalPatternRatio >= 0.85
    ) {
      flags.push('gameplayCommandIntervalPattern');
    }
    if (this.activitySeqResets >= 2) {
      flags.push('activitySeqReset');
    }
    if (
      sessionMinutes >= 5
      && (activeEvents >= 50 || directGameplayEvents >= 25)
      && this.sessionActivityEvents >= 10
      && this.sessionDetailedActivityEvents / this.sessionActivityEvents <= 0.2
    ) {
      flags.push('legacyActivityTelemetry');
    }
    if (sessionSuspiciousPacketClasses.protocol >= 3) {
      flags.push('protocolPackets');
    }
    if (sessionSuspiciousPacketClasses.rateLimit >= 3) {
      flags.push('rateLimitPackets');
    }
    if (sessionSuspiciousPacketClasses.automation >= 10) {
      flags.push('automationInvalidPackets');
    }
    if ((this.sessionSuspiciousPacketReasons.get(MAP_DATA_OUT_OF_SCOPE_REASON) ?? 0) >= 3) {
      flags.push('mapDataOutOfScope');
    }
    if ((this.sessionSuspiciousPacketReasons.get(RESERVED_MAP_DATA_REASON) ?? 0) > 0) {
      flags.push('reservedMapDataPath');
    }
    if (
      this.sessionPointerShapeSamples >= 20
      && pointerNoApproachRatio !== null
      && pointerNoApproachRatio >= 0.9
    ) {
      flags.push('pointerNoApproachShape');
    }
    if (
      this.sessionInputTicketTargetCommands >= 30
      && topInputTicketTargetCell
      && topInputTicketTargetCell[1] >= 20
      && topInputTicketTargetCellRepetition !== null
      && topInputTicketTargetCellRepetition >= 0.8
      && topInputTicketTargetCellDistinctTargets >= 10
    ) {
      flags.push('inputTicketTargetFanout');
    }
    if (
      (this.sessionSuspiciousPacketReasons.get('reserved-action-capability') ?? 0) > 0
      || (this.sessionSuspiciousPacketReasons.get(LEGACY_RESERVED_ACTION_REASON) ?? 0) > 0
    ) {
      flags.push('reservedActionCapability');
    }
    if ([...ADMIN_OPCODE_ABUSE_REASONS].some(reason => (this.sessionSuspiciousPacketReasons.get(reason) ?? 0) > 0)) {
      flags.push('adminOpcodeAbuse');
    }
    const lifetimeHardInvalidPackets = totalSuspiciousPacketClasses.protocol + totalSuspiciousPacketClasses.rateLimit;
    if (lifetimeHardInvalidPackets >= 25) {
      flags.push('lifetimeHardInvalidPackets');
    }
    if (deviceLogins >= 5 && deviceIdsSeen >= 5 && deviceReuseRatio !== null && deviceReuseRatio <= 0.25) {
      flags.push('deviceRotating');
    }
    // noChat: 0 chat over an active session of ≥2hr
    if (this.sessionChats === 0 && sessionMinutes >= 120 &&
        (this.sessionSkillingActions + this.sessionCombatSwings) >= 100) {
      flags.push('noChat');
    }
    // pathRepetitive: top destination > 50% of moves (very narrow loop)
    if (this.sessionMovements >= 50 && topPathRepetition !== null && topPathRepetition > 0.5) {
      flags.push('pathRepetitive');
    }
    if (
      this.sessionMoveCommands >= 25
      && this.sessionMovements >= 25
      && this.sessionMoveRedirects === 0
    ) {
      flags.push('noMoveRedirects');
    }
    if (
      this.sessionMoveCommands >= 20
      && maxPathCommandRatio !== null
      && maxPathCommandRatio >= 0.65
    ) {
      flags.push('maxPathCommandRatio');
    }
    if (
      this.sessionPathTruncations >= 5
      && pathTruncationRatio !== null
      && pathTruncationRatio >= 0.1
    ) {
      flags.push('pathTruncationPattern');
    }
    if (
      this.sessionPlayerDeaths >= MIN_POST_DEATH_ROUTE_MOVES
      && this.sessionPostDeathMoves >= MIN_POST_DEATH_ROUTE_MOVES
      && topPostDeathDestinationRepetition !== null
      && topPostDeathDestinationRepetition >= 0.8
    ) {
      flags.push('postDeathRouteLoop');
    }
    if (this.sessionMapDataScanBursts > 0) {
      flags.push('mapDataScrape');
    }
    if (
      sessionActionSignatureCount >= MIN_ROUTE_ACTION_LOOP_SIGNATURES
      && topActionLoopRepetition !== null
      && topActionLoopRepetition > 0.45
    ) {
      flags.push('routeActionLoop');
    }
    if (
      sessionMinutes >= MIN_NO_IDLE_SESSION_MINUTES
      && activeEvents >= MIN_NO_IDLE_ACTIVE_EVENTS
      && this.sessionActiveIdleBreaks === 0
    ) {
      flags.push('noIdleBreaks');
    }
    if (
      sessionMinutes >= MIN_MARATHON_NO_IDLE_SESSION_MINUTES
      && activeEvents >= MIN_MARATHON_NO_IDLE_ACTIVE_EVENTS
      && this.sessionActiveIdleBreaks === 0
    ) {
      flags.push('marathonNoIdleBreaks');
    }
    if (this.totalMovements >= 5000 && topLifetimePathRepetition !== null && topLifetimePathRepetition >= 0.12) {
      flags.push('lifetimePathConcentration');
    }
    if (mapTotal(this.actionSignatures) >= 200 && topLifetimeActionLoopRepetition !== null && topLifetimeActionLoopRepetition >= 0.18) {
      flags.push('lifetimeRouteActionLoop');
    }
    if (
      sessionMinutes >= 2
      && activeEvents >= 25
      && this.sessionActivityEvents === 0
      && this.sessionCursorEvents === 0
    ) {
      flags.push('browserlessActiveGameplay');
    }
    if (
      sessionMinutes >= 5
      && (activeEvents >= 50 || directGameplayEvents >= 25)
      && this.sessionActivityEvents === 0
    ) {
      flags.push('noClientActivityTelemetry');
    }
    if (
      !isLikelyMobile
      && sessionMinutes >= 5
      && (activeEvents >= 50 || directGameplayEvents >= 25)
      && this.sessionCursorEvents === 0
    ) {
      flags.push('noCursorTelemetry');
    }
    if (this.sessionInputlessCommands >= 5) {
      flags.push('inputlessCommandBurst');
    }
    if (this.sessionCommandsWithoutRecentInput >= 5) {
      flags.push('commandsWithoutRecentInput');
    }
    if (this.sessionCommandsWithoutRecentActivity >= 5) {
      flags.push('commandsWithoutRecentActivity');
    }
    if (
      this.sessionGameplayCommands >= 10
      && inputlessCommandRatio !== null
      && inputlessCommandRatio >= 0.5
    ) {
      flags.push('inputlessCommandRatio');
    }
    if (
      this.sessionGameplayCommands >= 10
      && activitylessCommandRatio !== null
      && activitylessCommandRatio >= 0.5
    ) {
      flags.push('activitylessCommandRatio');
    }
    if (!isLikelyMobile && this.sessionCursorEvents >= 20 && topCursorCellRepetition !== null && topCursorCellRepetition > 0.95) {
      flags.push('cursorStatic');
    }
    const moderateMechanicalJitter = analyzeModerateMechanicalJitter(this.gameplayCommandIntervalSamples);
    if (
      moderateMechanicalJitter.isMechanical
      && (
        flags.includes('routeActionLoop')
        || flags.includes('cursorStatic')
        || flags.includes('gameplayCommandSequencePattern')
      )
    ) {
      flags.push('moderateMechanicalJitter');
    }
    for (const flag of this.sessionLatchedEvidenceFlags) {
      if (!flags.includes(flag)) flags.push(flag);
    }
    // marathonSession: > 8hr session
    if (sessionMinutes >= 480) {
      flags.push('marathonSession');
    }
    if (effectiveTotalMinutes >= 600 && lifetimeActiveActions >= 10000 && chatRatePerHour !== null && chatRatePerHour < 2) {
      flags.push('lifetimeLowSocialHighActivity');
    }
    if (effectiveTotalMinutes >= 1200 && lifetimeActiveActions >= 25000 && chatRatePerHour !== null && chatRatePerHour < 1) {
      flags.push('lifetimeExtremeLowSocialHighActivity');
    }
    // fastReaction: median < 200ms over ≥10 samples
    if (this.reactionSamples.length >= 10 && reactionMedianMs !== null && reactionMedianMs < 200) {
      flags.push('fastReaction');
    }
    // xpVelocity is noisy for very short sessions and quest/reward bursts.
    // Treat it as reliable only after enough active play has been sampled.
    if (sessionMinutes >= MIN_XP_VELOCITY_SESSION_MINUTES && activeEvents >= MIN_XP_VELOCITY_ACTIVE_EVENTS) {
      for (const [skill, rate] of Object.entries(xpPerHour)) {
        const ceiling = XP_PER_HOUR_CEILING[skill as SkillId];
        if (ceiling !== undefined && rate > ceiling) {
          flags.push(`xpVelocity:${skill}`);
        }
      }
    }

    const signalFlags = flags;
    const { evidenceFlags, contextFlags, diagnosticFlags } = categorizeSignalFlags(signalFlags);

    const risk = computeBotRiskProfile({
      flags: signalFlags,
      evidenceFlags,
      sessionMinutes,
      sessionChats: this.sessionChats,
      sessionActivityEvents: this.sessionActivityEvents,
      sessionDetailedActivityEvents: this.sessionDetailedActivityEvents,
      sessionLegacyActivityEvents: this.sessionLegacyActivityEvents,
      sessionCursorEvents: this.sessionCursorEvents,
      sessionInputlessCommands: this.sessionInputlessCommands,
      sessionGameplayCommands: this.sessionGameplayCommands,
      sessionCommandsWithoutRecentInput: this.sessionCommandsWithoutRecentInput,
      sessionCommandsWithoutRecentActivity: this.sessionCommandsWithoutRecentActivity,
      sessionActiveIdleBreaks: this.sessionActiveIdleBreaks,
      longestActiveGapMinutes,
      sessionSkillingActions: this.sessionSkillingActions,
      sessionCombatSwings: this.sessionCombatSwings,
      sessionMovements: this.sessionMovements,
      sessionMoveCommands: this.sessionMoveCommands,
      sessionMoveRedirects: this.sessionMoveRedirects,
      sessionMaxPathMoveCommands: this.sessionMaxPathMoveCommands,
      sessionPathTruncations: this.sessionPathTruncations,
      sessionPlayerDeaths: this.sessionPlayerDeaths,
      sessionPostDeathMoves: this.sessionPostDeathMoves,
      sessionMapDataRequests: this.sessionMapDataRequests,
      sessionUniqueMapDataFiles,
      sessionMapDataScanBursts: this.sessionMapDataScanBursts,
      sessionSuspiciousPackets: this.sessionSuspiciousPackets,
      totalSuspiciousPackets: this.totalSuspiciousPackets,
      sessionSuspiciousPacketReasons,
      sessionSuspiciousPacketClasses,
      totalSuspiciousPacketClasses,
      totalFlagEvents: this.totalFlagEvents,
      totalHardFlagEvents: this.totalHardFlagEvents,
      tickAlignSamples: this.tickAlignSamples.length,
      tickAlignStdDevMs,
      pingIntervalSamples: this.pingIntervalSamples.length,
      pingIntervalStdDevMs,
      pingSeqResets: this.pingSeqResets,
      activityIntervalStdDevMs,
      gameplayCommandIntervalSamples: this.gameplayCommandIntervalSamples.length,
      gameplayCommandIntervalStdDevMs,
      rapidCommandIntervalSamples: this.rapidCommandIntervalSamples.length,
      rapidCommandIntervalMedianMs,
      commandIntervalCv: mechanicalJitter.coefficientOfVariation,
      commandIntervalTailRatio: mechanicalJitter.tailRatio,
      sameCommandIntervalSamples: this.sameCommandIntervalSamples.length,
      sameCommandIntervalStdDevMs,
      gameplayCommandPatternEvents: this.gameplayCommandPatternSignatures.length,
      gameplayCommandIntervalPatternEvents: this.gameplayCommandIntervalBins.length,
      gameplayCommandSequencePatternRatio,
      gameplayCommandIntervalPatternRatio,
      activitySeqResets: this.activitySeqResets,
      heartbeatActivityCouplingRatio,
      inputlessCommandRatio,
      activitylessCommandRatio,
      moveRedirectRatio,
      maxPathCommandRatio,
      pathTruncationRatio,
      topPostDeathDestinationRepetition,
      reactionSamples: this.reactionSamples.length,
      reactionMedianMs,
      topPathRepetition,
      topActionLoopRepetition,
      topLifetimePathRepetition,
      topLifetimeActionLoopRepetition,
      topCursorCellRepetition,
      cursorUniqueCells: this.cursorCells.size,
      sessionInputShapeSamples: this.sessionInputShapeSamples,
      sessionPointerShapeSamples: this.sessionPointerShapeSamples,
      pointerNoApproachRatio,
      sessionInputTicketTargetCommands: this.sessionInputTicketTargetCommands,
      inputTicketTargetUniqueCells: this.inputTicketTargetCells.size,
      topInputTicketTargetCellRepetition,
      topInputTicketTargetCellDistinctTargets,
      deviceIdsSeen,
      deviceReuseRatio,
      lifetimeActiveActions,
      effectiveTotalMinutes,
      chatRatePerHour,
      actionsPerHour,
      actionsPerChat,
      longSessionCount,
      xpPerHour,
    });

    return {
      sessionMinutes,
      sessionSkillingActions: this.sessionSkillingActions,
      sessionCombatSwings: this.sessionCombatSwings,
      sessionMovements: this.sessionMovements,
      sessionMoveCommands: this.sessionMoveCommands,
      sessionMoveRedirects: this.sessionMoveRedirects,
      sessionMaxPathMoveCommands: this.sessionMaxPathMoveCommands,
      sessionPathTruncations: this.sessionPathTruncations,
      sessionPlayerDeaths: this.sessionPlayerDeaths,
      sessionPostDeathMoves: this.sessionPostDeathMoves,
      sessionMapDataRequests: this.sessionMapDataRequests,
      sessionUniqueMapDataFiles,
      sessionMapDataScanBursts: this.sessionMapDataScanBursts,
      sessionChats: this.sessionChats,
      sessionActivityEvents: this.sessionActivityEvents,
      sessionDetailedActivityEvents: this.sessionDetailedActivityEvents,
      sessionPointerActivityEvents: this.sessionPointerActivityEvents,
      sessionKeyboardActivityEvents: this.sessionKeyboardActivityEvents,
      sessionTouchActivityEvents: this.sessionTouchActivityEvents,
      sessionLegacyActivityEvents: this.sessionLegacyActivityEvents,
      sessionCursorEvents: this.sessionCursorEvents,
      sessionInputlessCommands: this.sessionInputlessCommands,
      sessionGameplayCommands: this.sessionGameplayCommands,
      sessionCommandsWithoutRecentInput: this.sessionCommandsWithoutRecentInput,
      sessionCommandsWithoutRecentActivity: this.sessionCommandsWithoutRecentActivity,
      sessionActiveIdleBreaks: this.sessionActiveIdleBreaks,
      longestActiveGapMinutes,
      sessionSuspiciousPackets: this.sessionSuspiciousPackets,
      totalSuspiciousPackets: this.totalSuspiciousPackets,
      sessionSuspiciousPacketReasons,
      totalSuspiciousPacketReasons,
      sessionSuspiciousPacketClasses,
      totalSuspiciousPacketClasses,
      tickAlignStdDevMs,
      reactionMedianMs,
      pingIntervalStdDevMs,
      pingIntervalMedianMs,
      activityIntervalStdDevMs,
      activityIntervalMedianMs,
      gameplayCommandIntervalSamples: this.gameplayCommandIntervalSamples.length,
      gameplayCommandIntervalStdDevMs,
      gameplayCommandIntervalMedianMs,
      rapidCommandIntervalSamples: this.rapidCommandIntervalSamples.length,
      rapidCommandIntervalMedianMs,
      commandIntervalCv: mechanicalJitter.coefficientOfVariation,
      commandIntervalTailRatio: mechanicalJitter.tailRatio,
      isLikelyMobile,
      sameCommandIntervalSamples: this.sameCommandIntervalSamples.length,
      sameCommandIntervalStdDevMs,
      sameCommandIntervalMedianMs,
      gameplayCommandPatternEvents: this.gameplayCommandPatternSignatures.length,
      gameplayCommandIntervalPatternEvents: this.gameplayCommandIntervalBins.length,
      gameplayCommandSequencePatternRatio,
      gameplayCommandIntervalPatternRatio,
      activitySeqResets: this.activitySeqResets,
      heartbeatActivityCouplingRatio,
      inputlessCommandRatio,
      activitylessCommandRatio,
      moveRedirectRatio,
      maxPathCommandRatio,
      pathTruncationRatio,
      topPostDeathDestinationRepetition,
      topPathRepetition,
      topActionLoopRepetition,
      topLifetimePathRepetition,
      topLifetimeActionLoopRepetition,
      topCursorCellRepetition,
      cursorUniqueCells: this.cursorCells.size,
      sessionInputShapeSamples: this.sessionInputShapeSamples,
      sessionPointerShapeSamples: this.sessionPointerShapeSamples,
      pointerNoApproachRatio,
      sessionInputTicketTargetCommands: this.sessionInputTicketTargetCommands,
      inputTicketTargetUniqueCells: this.inputTicketTargetCells.size,
      topInputTicketTargetCellRepetition,
      topInputTicketTargetCellDistinctTargets,
      deviceIdsSeen,
      deviceReuseRatio,
      lifetimeActiveActions,
      chatRatePerHour,
      actionsPerHour,
      actionsPerChat,
      longSessionCount,
      xpPerHour,
      evidenceFlags,
      contextFlags,
      diagnosticFlags,
      flags: evidenceFlags,
      riskScore: risk.score,
      riskLevel: risk.level,
      riskReasons: risk.reasons,
      riskSignals: risk.signals,
      riskHardEvidence: risk.hardEvidence,
    };
  }

  /** Periodic checkpoint: recompute review risk and write current state to DB
   *  without ending the session. Lets us surface active bots before logout
   *  while keeping audit/session-history writes reserved for finalize(). */
  checkpoint(db: GameDatabase, accountId: number, currentXp: Record<string, number> = {}): void {
    const summary = this.computeSummary(currentXp);
    this.riskScore = summary.riskScore;
    this.riskLevel = summary.riskLevel;
    this.riskReasons = summary.riskReasons;
    if (isMeaningfulSession(summary)) {
      this.lastSessionSummary = summary;
    }
    db.saveBotStats(accountId, this.toRow(this.lastSessionSummary));
  }

  /** Session end (logout). Computes the summary, writes it both to DB
   *  (overwrites last_session_summary) and to audit.log (one JSONL line).
   *  Updates totalSessionMinutes and totalFlagEvents counters. */
  finalize(db: GameDatabase, accountId: number, currentXp: Record<string, number>, tick: number): SessionSummary {
    const summary = this.computeSummary(currentXp);
    this.totalSessionMinutes += summary.sessionMinutes;
    this.totalFlagEvents += summary.evidenceFlags.length;
    // Persist the strongest tell across logouts: a session that ended with hard
    // evidence (or a behavioral cluster) increments the lifetime conviction so a
    // bot that reconnects often — never reaching per-session cadence thresholds —
    // still accrues hard evidence over time.
    if (summary.riskHardEvidence) this.totalHardFlagEvents += 1;
    const entry: SessionHistoryEntry = {
      ...summary,
      finalizedAt: Math.floor(Date.now() / 1000),
      tick,
      meaningful: isMeaningfulSession(summary),
    };
    this.sessionHistory.push(entry);
    if (this.sessionHistory.length > MAX_SESSION_HISTORY) {
      this.sessionHistory = this.sessionHistory.slice(-MAX_SESSION_HISTORY);
    }
    if (entry.meaningful || !this.lastSessionSummary) {
      this.lastSessionSummary = summary;
    }
    const reviewSummary = this.lastSessionSummary ?? summary;
    const chosenRisk = !entry.meaningful && reviewSummary.riskScore > summary.riskScore
      ? reviewSummary
      : summary;
    this.riskScore = chosenRisk.riskScore;
    this.riskLevel = chosenRisk.riskLevel;
    this.riskReasons = chosenRisk.riskReasons;
    db.saveBotStats(accountId, this.toRow(reviewSummary));
    audit({
      type: 'player.session_summary',
      tick,
      accountId,
      details: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }

  private pushSample(arr: number[], value: number, cap: number): void {
    arr.push(value);
    if (arr.length > cap) arr.shift();
  }

  private bumpCappedMap(map: Map<string, number>, key: string, cap: number): void {
    const existing = map.get(key);
    if (existing !== undefined) {
      map.set(key, existing + 1);
      return;
    }
    if (map.size >= cap) {
      let minKey: string | null = null;
      let minCount = Infinity;
      for (const [k, v] of map) {
        if (v < minCount) { minCount = v; minKey = k; }
      }
      if (minKey !== null) map.delete(minKey);
    }
    map.set(key, 1);
  }

  private recordActivityHeartbeatCoupling(activityAt: number): void {
    if (this.lastCoupledActivityAt === activityAt) return;
    this.lastCoupledActivityAt = activityAt;
    this.activityHeartbeatCoupledEvents++;
  }
}

function stdDev(samples: number[]): number | null {
  if (samples.length < 2) return null;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
  return Math.sqrt(variance);
}

function median(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Touch-dominant activity → playing on a phone/tablet. Such clients emit
 *  little/no cursor-move telemetry, so cursor-absence signals must be exempted
 *  to avoid false-flagging them. Requires a meaningful number of touch events
 *  AND touch outnumbering pointer events, so a desktop with a stray tap (or a
 *  bot emitting a few fake touch packets) does not read as mobile. */
export const MOBILE_MIN_TOUCH_EVENTS = 20;
export const MOBILE_MIN_TOUCH_RATIO = 0.6;
export function isLikelyMobileSession(touchEvents: number, pointerEvents: number, keyboardEvents: number): boolean {
  const total = touchEvents + pointerEvents + keyboardEvents;
  if (total <= 0) return false;
  return touchEvents >= MOBILE_MIN_TOUCH_EVENTS
    && touchEvents / total >= MOBILE_MIN_TOUCH_RATIO
    && pointerEvents < touchEvents;
}

function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

/** Markers of computer-generated "humanized" jitter in inter-action intervals.
 *  Human timing is heavy-tailed (occasional long pauses), positively skewed, and
 *  high-variance; a script adding uniform/gaussian ±X ms jitter around a fixed
 *  mean produces a *tight, tail-less* distribution that still has nonzero stddev
 *  (so it slips past the metronome/cadence gate). We flag the band between
 *  "perfectly regular" and "human": low-but-nonzero coefficient of variation with
 *  no heavy tail. Returns the metrics so the admin panel can show the evidence. */
export interface MechanicalJitterMetrics {
  coefficientOfVariation: number | null;
  tailRatio: number | null;
  isMechanical: boolean;
}
const MECHANICAL_JITTER_MIN_SAMPLES = 40;
const MECHANICAL_JITTER_MIN_CV = 0.02;
const MECHANICAL_JITTER_MAX_CV = 0.15;
const MECHANICAL_JITTER_MAX_TAIL_RATIO = 1.5;
const MODERATE_JITTER_MIN_SAMPLES = 50;
const MODERATE_JITTER_MAX_CV = 0.30;
const MODERATE_JITTER_MAX_TAIL_RATIO = 1.65;
export function analyzeMechanicalJitter(intervals: number[]): MechanicalJitterMetrics {
  if (intervals.length < MECHANICAL_JITTER_MIN_SAMPLES) {
    return { coefficientOfVariation: null, tailRatio: null, isMechanical: false };
  }
  const sd = stdDev(intervals);
  const med = median(intervals);
  const p90 = percentile(intervals, 0.9);
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const cv = sd !== null && mean > 0 ? sd / mean : null;
  const tailRatio = p90 !== null && med !== null && med > 0 ? p90 / med : null;
  const isMechanical = cv !== null && tailRatio !== null
    && cv >= MECHANICAL_JITTER_MIN_CV && cv <= MECHANICAL_JITTER_MAX_CV
    && tailRatio <= MECHANICAL_JITTER_MAX_TAIL_RATIO;
  return { coefficientOfVariation: cv, tailRatio, isMechanical };
}

function analyzeModerateMechanicalJitter(intervals: number[]): MechanicalJitterMetrics {
  if (intervals.length < MODERATE_JITTER_MIN_SAMPLES) {
    return { coefficientOfVariation: null, tailRatio: null, isMechanical: false };
  }
  const sd = stdDev(intervals);
  const med = median(intervals);
  const p90 = percentile(intervals, 0.9);
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  const cv = sd !== null && mean > 0 ? sd / mean : null;
  const tailRatio = p90 !== null && med !== null && med > 0 ? p90 / med : null;
  const isMechanical = cv !== null && tailRatio !== null
    && cv > MECHANICAL_JITTER_MAX_CV && cv <= MODERATE_JITTER_MAX_CV
    && tailRatio <= MODERATE_JITTER_MAX_TAIL_RATIO;
  return { coefficientOfVariation: cv, tailRatio, isMechanical };
}

function topRatio(destinations: Map<string, number>): number | null {
  if (destinations.size === 0) return null;
  let total = 0;
  let max = 0;
  for (const v of destinations.values()) {
    total += v;
    if (v > max) max = v;
  }
  return total > 0 ? max / total : null;
}

function topEntry(destinations: Map<string, number>): [string, number] | null {
  let best: [string, number] | null = null;
  for (const entry of destinations) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best;
}

function maxLagMatchRatio<T>(values: readonly T[], minLag: number, maxLag: number): number | null {
  const safeMinLag = Math.max(1, Math.floor(minLag));
  const safeMaxLag = Math.max(safeMinLag, Math.floor(maxLag));
  if (values.length < safeMinLag * 4) return null;

  let best: number | null = null;
  for (let lag = safeMinLag; lag <= safeMaxLag && lag < values.length; lag++) {
    const comparisons = values.length - lag;
    if (comparisons < lag * 3) continue;
    let matches = 0;
    for (let i = lag; i < values.length; i++) {
      if (values[i] === values[i - lag]) matches++;
    }
    const ratio = comparisons > 0 ? matches / comparisons : 0;
    best = best === null ? ratio : Math.max(best, ratio);
  }
  return best;
}

const EVIDENCE_SIGNAL_FLAGS = new Set([
  'protocolPackets',
  'rateLimitPackets',
  'automationInvalidPackets',
  'lifetimeHardInvalidPackets',
  'deviceRotating',
  'gameplayCommandCadenceRegular',
  'sameCommandCadenceRegular',
  'gameplayCommandIntervalPattern',
  'rapidGameplayCommandCadence',
  'mechanicalJitter',
  'moderateMechanicalJitter',
  'mapDataScrape',
  'mapDataOutOfScope',
  'reservedMapDataPath',
  'browserlessActiveGameplay',
  'commandsWithoutRecentInput',
  'commandsWithoutRecentActivity',
  'fastReaction',
  'reservedActionCapability',
  'adminOpcodeAbuse',
]);

const DIAGNOSTIC_SIGNAL_FLAGS = new Set([
  'tickAligned',
  'pingRegular',
  'pingSeqReset',
  'activityHeartbeatCoupled',
  'activityRegular',
  'activitySeqReset',
  'legacyActivityTelemetry',
  'noClientActivityTelemetry',
  'noCursorTelemetry',
  'cursorStatic',
]);

function normalizeSignalFlag(flag: string): string {
  const base = flag.includes(':') ? flag.split(':')[0] : flag;
  return base === LEGACY_RESERVED_ACTION_FLAG ? 'reservedActionCapability' : base;
}

function isEvidenceSignalFlag(flag: string): boolean {
  return flag.startsWith('xpVelocity:') || EVIDENCE_SIGNAL_FLAGS.has(normalizeSignalFlag(flag));
}

function categorizeSignalFlags(signalFlags: string[]): {
  evidenceFlags: string[];
  contextFlags: string[];
  diagnosticFlags: string[];
} {
  const evidenceFlags: string[] = [];
  const contextFlags: string[] = [];
  const diagnosticFlags: string[] = [];
  for (const flag of signalFlags) {
    const normalized = normalizeSignalFlag(flag);
    if (isEvidenceSignalFlag(flag)) evidenceFlags.push(flag);
    else if (DIAGNOSTIC_SIGNAL_FLAGS.has(normalized)) diagnosticFlags.push(flag);
    else contextFlags.push(flag);
  }
  return { evidenceFlags, contextFlags, diagnosticFlags };
}

interface BotRiskInput {
  flags: string[];
  evidenceFlags: string[];
  sessionMinutes: number;
  sessionChats: number;
  sessionSkillingActions: number;
  sessionCombatSwings: number;
  sessionMovements: number;
  sessionMoveCommands: number;
  sessionMoveRedirects: number;
  sessionMaxPathMoveCommands: number;
  sessionPathTruncations: number;
  sessionPlayerDeaths: number;
  sessionPostDeathMoves: number;
  sessionMapDataRequests: number;
  sessionUniqueMapDataFiles: number;
  sessionMapDataScanBursts: number;
  sessionActivityEvents: number;
  sessionDetailedActivityEvents: number;
  sessionLegacyActivityEvents: number;
  sessionCursorEvents: number;
  sessionInputlessCommands: number;
  sessionGameplayCommands: number;
  sessionCommandsWithoutRecentInput: number;
  sessionCommandsWithoutRecentActivity: number;
  sessionActiveIdleBreaks: number;
  longestActiveGapMinutes: number | null;
  sessionSuspiciousPackets: number;
  totalSuspiciousPackets: number;
  sessionSuspiciousPacketReasons: Record<string, number>;
  sessionSuspiciousPacketClasses: SuspiciousPacketClassCounts;
  totalSuspiciousPacketClasses: SuspiciousPacketClassCounts;
  totalFlagEvents: number;
  totalHardFlagEvents: number;
  tickAlignSamples: number;
  tickAlignStdDevMs: number | null;
  pingIntervalSamples: number;
  pingIntervalStdDevMs: number | null;
  pingSeqResets: number;
  activityIntervalStdDevMs: number | null;
  gameplayCommandIntervalSamples: number;
  gameplayCommandIntervalStdDevMs: number | null;
  rapidCommandIntervalSamples: number;
  rapidCommandIntervalMedianMs: number | null;
  commandIntervalCv: number | null;
  commandIntervalTailRatio: number | null;
  sameCommandIntervalSamples: number;
  sameCommandIntervalStdDevMs: number | null;
  gameplayCommandPatternEvents: number;
  gameplayCommandIntervalPatternEvents: number;
  gameplayCommandSequencePatternRatio: number | null;
  gameplayCommandIntervalPatternRatio: number | null;
  activitySeqResets: number;
  heartbeatActivityCouplingRatio: number | null;
  inputlessCommandRatio: number | null;
  activitylessCommandRatio: number | null;
  moveRedirectRatio: number | null;
  maxPathCommandRatio: number | null;
  pathTruncationRatio: number | null;
  topPostDeathDestinationRepetition: number | null;
  reactionSamples: number;
  reactionMedianMs: number | null;
  topPathRepetition: number | null;
  topActionLoopRepetition: number | null;
  topLifetimePathRepetition: number | null;
  topLifetimeActionLoopRepetition: number | null;
  topCursorCellRepetition: number | null;
  cursorUniqueCells: number;
  sessionInputShapeSamples: number;
  sessionPointerShapeSamples: number;
  pointerNoApproachRatio: number | null;
  sessionInputTicketTargetCommands: number;
  inputTicketTargetUniqueCells: number;
  topInputTicketTargetCellRepetition: number | null;
  topInputTicketTargetCellDistinctTargets: number;
  deviceIdsSeen: number;
  deviceReuseRatio: number | null;
  lifetimeActiveActions: number;
  effectiveTotalMinutes: number;
  chatRatePerHour: number | null;
  actionsPerHour: number | null;
  actionsPerChat: number | null;
  longSessionCount: number;
  xpPerHour: Record<string, number>;
}

/** Self-documenting registry for every scored bot signal: the human label, a
 *  plain-language description, and the exact threshold a player must cross. This
 *  is the single source of truth the admin panel renders so a reviewer can see
 *  *why* someone tripped — and the only place to look when tuning a signal.
 *  `tier` mirrors the evidence weighting (hard = strong standalone, soft =
 *  supporting). Combo bonuses are emitted as `context` signals at score time. */
interface BotSignalMeta { label: string; description: string; threshold: string; tier: 'hard' | 'soft'; }
const BOT_SIGNAL_META: Record<string, BotSignalMeta> = {
  pingRegular: { label: 'Robotic heartbeat timing', description: 'Client heartbeat fires on a near-perfect interval.', threshold: '≥12 pings, <20ms stddev', tier: 'soft' },
  activityHeartbeatCoupled: { label: 'Activity coupled to heartbeat', description: 'Activity packets fire in lockstep with the heartbeat — one timer drives both.', threshold: '≥10 events, ≥80% within ±350ms', tier: 'soft' },
  activityRegular: { label: 'Robotic activity timing', description: 'Client activity events fire on a near-perfect interval.', threshold: '≥10 events, <75ms stddev', tier: 'soft' },
  gameplayCommandCadenceRegular: { label: 'Robotic click cadence', description: 'Gameplay commands arrive on a near-perfect interval.', threshold: '≥24 commands, <65ms stddev', tier: 'hard' },
  sameCommandCadenceRegular: { label: 'Robotic repeated-click cadence', description: 'The same command repeats on a near-perfect interval.', threshold: '≥12 repeats, <75ms stddev', tier: 'hard' },
  gameplayCommandSequencePattern: { label: 'Repeated command order', description: 'Commands repeat in a fixed order (e.g. ABAB) regardless of timing.', threshold: '≥30 commands, ≥85% lag-match', tier: 'soft' },
  gameplayCommandIntervalPattern: { label: 'Repeated interval pattern', description: 'Command intervals repeat in a fixed pattern even with added jitter.', threshold: '≥24 intervals, ≥85% lag-match', tier: 'hard' },
  rapidGameplayCommandCadence: { label: 'Rapid click stream', description: 'Gameplay commands arrive in a sustained sub-human rapid stream.', threshold: '≥16 intervals between 50ms and 249ms', tier: 'hard' },
  mechanicalJitter: { label: 'Computer-generated timing jitter', description: 'Command timing has small randomization but a tight, tail-less spread no human sustains — the "humanize" setting of an auto-clicker. Catches jitter that slips past the regular-cadence gate.', threshold: '≥40 commands, CV 0.02–0.15, p90/median ≤1.5', tier: 'hard' },
  moderateMechanicalJitter: { label: 'Tail-less randomized clicking', description: 'Command timing uses wider randomization but still lacks human pauses, paired with another automation-shaped signal.', threshold: '≥50 commands, CV 0.15–0.30, p90/median ≤1.65 plus route/cursor/order context', tier: 'hard' },
  legacyActivityTelemetry: { label: 'Legacy-only activity telemetry', description: 'Client sends only old-format activity packets (no kind/seq) — common for spoofed telemetry.', threshold: '≥10 events, ≤20% detailed', tier: 'soft' },
  browserlessActiveGameplay: { label: 'No browser input telemetry', description: 'Active gameplay with zero activity and cursor packets — a headless/raw-socket client.', threshold: '≥2min, ≥25 actions, 0 activity + 0 cursor', tier: 'hard' },
  inputlessCommandBurst: { label: 'Commands before any input', description: 'Gameplay commands fired before the client reported any browser input.', threshold: '≥5 commands', tier: 'soft' },
  commandsWithoutRecentInput: { label: 'Commands without recent input', description: 'Gameplay commands with no browser input reported in the last 15s.', threshold: '≥5 commands', tier: 'hard' },
  commandsWithoutRecentActivity: { label: 'Commands without recent activity', description: 'Gameplay commands with no activity packet in the last 15s.', threshold: '≥5 commands', tier: 'hard' },
  inputlessCommandRatio: { label: 'High no-input command ratio', description: 'A large fraction of commands had no recent browser input.', threshold: '≥10 commands, ≥50%', tier: 'soft' },
  activitylessCommandRatio: { label: 'High no-activity command ratio', description: 'A large fraction of commands had no recent activity packet.', threshold: '≥10 commands, ≥50%', tier: 'soft' },
  noClientActivityTelemetry: { label: 'No activity telemetry', description: 'Active session with zero activity packets at all.', threshold: '≥5min, ≥50 actions, 0 activity', tier: 'soft' },
  noCursorTelemetry: { label: 'No cursor telemetry', description: 'Active session with zero cursor-position packets.', threshold: '≥5min, ≥50 actions, 0 cursor', tier: 'soft' },
  cursorStatic: { label: 'Static cursor', description: 'Cursor parked in a single grid cell while playing.', threshold: '≥20 cursor events, >95% one cell', tier: 'soft' },
  deviceRotating: { label: 'Rotating device IDs', description: 'Many distinct browser device IDs with little reuse — account/session cycling.', threshold: '≥5 logins, ≥5 device IDs, ≤25% reuse', tier: 'hard' },
  noChat: { label: 'Silent grinder', description: 'Long active session with no chat at all.', threshold: '≥120min, ≥100 actions, 0 chats', tier: 'soft' },
  pathRepetitive: { label: 'Repetitive destination', description: 'Most movement targets a single tile.', threshold: '≥50 moves, >50% one tile', tier: 'soft' },
  noMoveRedirects: { label: 'No mid-path redirects', description: 'Player never redirects mid-path; humans frequently do.', threshold: '≥25 moves, 0 redirects', tier: 'soft' },
  maxPathCommandRatio: { label: 'Max-length pathing', description: 'Most paths are max length — programmatic click-to-edge movement.', threshold: '≥20 moves, ≥65% max-length', tier: 'soft' },
  pathTruncationPattern: { label: 'Repeated path truncations', description: 'Client repeatedly paths through walls; the server truncates.', threshold: '≥5 truncations, ≥10% of moves', tier: 'soft' },
  postDeathRouteLoop: { label: 'Auto-return after death', description: 'Returns to the same destination after each death.', threshold: '≥3 deaths, ≥3 post-death moves, ≥80% one tile', tier: 'soft' },
  routeActionLoop: { label: 'Repeated route→action loop', description: 'The same walk-to-tile→action signature repeats.', threshold: '≥20 actions, >45% one signature', tier: 'soft' },
  lifetimePathConcentration: { label: 'Lifetime path concentration', description: 'Long-term movement concentrated on few tiles.', threshold: '≥5000 actions, ≥12% one tile', tier: 'soft' },
  lifetimeRouteActionLoop: { label: 'Lifetime route/action loop', description: 'Long-term route/action signature concentration.', threshold: '≥200 actions, ≥18% one signature', tier: 'soft' },
  marathonSession: { label: 'Marathon session', description: 'A single session running 8+ hours.', threshold: '≥480 minutes', tier: 'soft' },
  noIdleBreaks: { label: 'No idle breaks', description: 'Long active session with no 5-minute idle gaps.', threshold: '≥240min, ≥400 actions, 0 breaks', tier: 'soft' },
  marathonNoIdleBreaks: { label: 'Marathon with no idle breaks', description: 'A 6+ hour session with no idle gaps at all.', threshold: '≥360min, ≥800 actions, 0 breaks', tier: 'soft' },
  fastReaction: { label: 'Inhuman re-engage speed', description: 'Median time from an NPC death to the next combat swing is faster than a human reaction.', threshold: '≥10 samples, <200ms median', tier: 'hard' },
  mapDataScrape: { label: 'Bulk map-data scrape', description: 'Rapid bulk fetching of many map files.', threshold: '≥180 unique files or ≥260 requests in 60s', tier: 'hard' },
  mapDataOutOfScope: { label: 'Out-of-scope map data', description: 'Requested gameplay map files outside the character’s allowed streaming window.', threshold: '≥3 denied map-data requests', tier: 'hard' },
  reservedMapDataPath: { label: 'Invalid map-data endpoint', description: 'Requested a map-data endpoint that normal gameplay never uses.', threshold: '≥1 invalid map-data endpoint request', tier: 'hard' },
  protocolPackets: { label: 'Malformed protocol traffic', description: 'Repeated malformed or impossible game packets.', threshold: '≥3 this session', tier: 'hard' },
  rateLimitPackets: { label: 'Too-fast packet flood', description: 'Repeated packet rate-limit overflows.', threshold: '≥3 this session', tier: 'hard' },
  automationInvalidPackets: { label: 'Automation-shaped invalid traffic', description: 'Many invalid requests shaped like a script or modified client.', threshold: '≥10 this session', tier: 'hard' },
  reservedActionCapability: { label: 'Invalid action token replayed', description: 'Client sent an action token that was not valid for normal gameplay.', threshold: '≥1 invalid action token', tier: 'hard' },
  adminOpcodeAbuse: { label: 'Non-admin used admin command', description: 'A non-admin client attempted to send an admin-only game command.', threshold: '≥1 non-admin admin command', tier: 'hard' },
  lifetimeHardInvalidPackets: { label: 'Repeat hard invalid traffic', description: 'Large lifetime volume of malformed protocol or rate-limit events.', threshold: '≥25 lifetime', tier: 'hard' },
  lifetimeLowSocialHighActivity: { label: 'Low-social high-activity (lifetime)', description: 'Very high lifetime activity with almost no chat.', threshold: '≥600min, ≥10000 actions, <2 chats/hr', tier: 'soft' },
  lifetimeExtremeLowSocialHighActivity: { label: 'Extreme low-social high-activity (lifetime)', description: 'Extreme lifetime activity with virtually no chat.', threshold: '≥1200min, ≥25000 actions, <1 chat/hr', tier: 'soft' },
  xpVelocity: { label: 'Impossible XP rate', description: 'XP/hour exceeds the highest rate a human could plausibly grind for a skill.', threshold: 'over the per-skill XP/hr ceiling', tier: 'hard' },
  lifetimeHardEvidence: { label: 'Repeat hard-evidence offender', description: 'Multiple prior sessions ended with hard bot evidence — convicts bots that reconnect often to dodge per-session thresholds.', threshold: '≥3 prior hard-evidence sessions', tier: 'hard' },
};

/** Review-only context flags. This used to let several soft automation tells
 *  uncap the score as a cluster, but that made legitimate grinders too easy to
 *  convict. Keep the function/API for admin review and tests; hard evidence now
 *  comes only from EVIDENCE_SIGNAL_FLAGS. */
const BEHAVIORAL_EVIDENCE_FLAGS = new Set<string>();
/** Distinct behavioral signals that together count as hard evidence (lifting the
 *  soft-score cap). Conservative: 4 independent automation tells. */
export const BEHAVIORAL_EVIDENCE_THRESHOLD = 4;

/** Count of DISTINCT behavioral-evidence signals present in `flags`. Lifestyle/
 *  grinder signals don't count (see BEHAVIORAL_EVIDENCE_FLAGS). xpVelocity:* and
 *  other suffixed flags are normalized to their base id first. */
export function behavioralEvidenceFlagCount(flags: Iterable<string>): number {
  const seen = new Set<string>();
  for (const flag of flags) {
    const base = normalizeSignalFlag(flag);
    if (BEHAVIORAL_EVIDENCE_FLAGS.has(base)) seen.add(base);
  }
  return seen.size;
}

export function computeBotRiskProfile(input: BotRiskInput): BotRiskProfile {
  let score = 0;
  const reasons: string[] = [];
  const signals: BotSignalDetail[] = [];
  const flagSet = new Set(input.flags.map(normalizeSignalFlag));
  const evidenceFlagSet = new Set(input.evidenceFlags.map(normalizeSignalFlag));
  const canScoreSignal = (flag: string): boolean =>
    evidenceFlagSet.has(normalizeSignalFlag(flag))
    || flag === 'lifetimeHardEvidence';
  // Record a scored signal. `measured` is the player's formatted value for this
  // signal (e.g. "14ms stddev"); label/description/threshold come from the
  // registry so the admin panel can show exactly what tripped and by how much.
  const add = (flag: string, points: number, measured: string) => {
    if (points <= 0) return;
    if (!canScoreSignal(flag)) return;
    score += points;
    const meta = BOT_SIGNAL_META[flag];
    const label = meta?.label ?? flag;
    signals.push({
      flag,
      label,
      description: meta?.description ?? '',
      threshold: meta?.threshold ?? '',
      measured,
      points,
      tier: meta?.tier ?? 'soft',
    });
    reasons.push(`${label}${measured ? ` — ${measured}` : ''} (+${points})`);
  };
  // Combos are review context only. Direct hard signals stack naturally; soft
  // context must not add hidden points or turn lifestyle patterns into a ban.
  const addCombo = (points: number, label: string) => {
    if (points <= 0) return;
    void label;
  };

  // NOTE: `tickAligned` is intentionally not scored. Skilling/combat actions
  // always resolve on a server tick boundary, so the measured offset reflects
  // server scheduling, not the player — its stddev is near-zero for everyone.
  // It is kept as a diagnostic-only flag, never a score contributor.
  if (flagSet.has('pingRegular')) add('pingRegular', 12, `${input.pingIntervalStdDevMs?.toFixed(0) ?? '?'}ms stddev`);
  // Sequence resets are noisy around reconnects/page reloads. Keep them in
  // diagnostic flags, but do not score them directly.
  if (flagSet.has('activityHeartbeatCoupled')) add('activityHeartbeatCoupled', 20, `${ratioLabel(input.heartbeatActivityCouplingRatio)} coupled`);
  if (flagSet.has('activityRegular')) add('activityRegular', 18, `${input.activityIntervalStdDevMs?.toFixed(0) ?? '?'}ms stddev`);
  const timingSignals: Array<[string, number, string]> = [];
  if (flagSet.has('rapidGameplayCommandCadence')) timingSignals.push(['rapidGameplayCommandCadence', 60, `${input.rapidCommandIntervalSamples} rapid intervals, ${input.rapidCommandIntervalMedianMs?.toFixed(0) ?? '?'}ms median`]);
  if (flagSet.has('sameCommandCadenceRegular')) timingSignals.push(['sameCommandCadenceRegular', 60, `${input.sameCommandIntervalSamples} samples, ${input.sameCommandIntervalStdDevMs?.toFixed(0) ?? '?'}ms stddev`]);
  if (flagSet.has('gameplayCommandIntervalPattern')) timingSignals.push(['gameplayCommandIntervalPattern', 60, `${input.gameplayCommandIntervalPatternEvents} intervals, ${ratioLabel(input.gameplayCommandIntervalPatternRatio)} lag-match`]);
  if (flagSet.has('mechanicalJitter')) timingSignals.push(['mechanicalJitter', 60, `CV ${input.commandIntervalCv?.toFixed(2) ?? '?'}, tail ${input.commandIntervalTailRatio?.toFixed(2) ?? '?'}`]);
  if (flagSet.has('moderateMechanicalJitter')) timingSignals.push(['moderateMechanicalJitter', 60, `CV ${input.commandIntervalCv?.toFixed(2) ?? '?'}, tail ${input.commandIntervalTailRatio?.toFixed(2) ?? '?'}`]);
  if (flagSet.has('gameplayCommandCadenceRegular')) timingSignals.push(['gameplayCommandCadenceRegular', 45, `${input.gameplayCommandIntervalSamples} samples, ${input.gameplayCommandIntervalStdDevMs?.toFixed(0) ?? '?'}ms stddev`]);
  if (timingSignals.length > 0) {
    timingSignals.sort((a, b) => b[1] - a[1]);
    add(...timingSignals[0]);
  }
  if (flagSet.has('gameplayCommandSequencePattern')) add('gameplayCommandSequencePattern', 10, `${input.gameplayCommandPatternEvents} commands, ${ratioLabel(input.gameplayCommandSequencePatternRatio)} lag-match`);
  if (flagSet.has('legacyActivityTelemetry')) add('legacyActivityTelemetry', 10, `${input.sessionDetailedActivityEvents}/${input.sessionActivityEvents} detailed`);
  if (flagSet.has('browserlessActiveGameplay')) add('browserlessActiveGameplay', 46, `${input.sessionSkillingActions + input.sessionCombatSwings + input.sessionMovements} actions, 0 telemetry`);
  if (flagSet.has('inputlessCommandBurst') && !flagSet.has('commandsWithoutRecentInput')) {
    add('inputlessCommandBurst', 28, `${input.sessionInputlessCommands} commands`);
  }
  if (flagSet.has('commandsWithoutRecentInput')) add('commandsWithoutRecentInput', 28, `${input.sessionCommandsWithoutRecentInput}/${input.sessionGameplayCommands} commands`);
  if (flagSet.has('commandsWithoutRecentActivity')) add('commandsWithoutRecentActivity', 42, `${input.sessionCommandsWithoutRecentActivity}/${input.sessionGameplayCommands} commands`);
  if (flagSet.has('inputlessCommandRatio') && !flagSet.has('commandsWithoutRecentInput')) add('inputlessCommandRatio', 18, `${ratioLabel(input.inputlessCommandRatio)}`);
  if (flagSet.has('activitylessCommandRatio') && !flagSet.has('commandsWithoutRecentActivity')) add('activitylessCommandRatio', 22, `${ratioLabel(input.activitylessCommandRatio)}`);
  if (flagSet.has('noClientActivityTelemetry') && !flagSet.has('commandsWithoutRecentActivity')) {
    add('noClientActivityTelemetry', 12, '0 activity packets');
  }
  if (flagSet.has('deviceRotating')) add('deviceRotating', 24, `${input.deviceIdsSeen} device IDs`);
  if (flagSet.has('noChat')) add('noChat', 8, '0 chats');
  if (flagSet.has('pathRepetitive')) add('pathRepetitive', 8, `${ratioLabel(input.topPathRepetition)} one tile`);
  if (flagSet.has('noMoveRedirects')) add('noMoveRedirects', 6, `${input.sessionMoveRedirects}/${input.sessionMoveCommands} redirects`);
  if (flagSet.has('maxPathCommandRatio')) add('maxPathCommandRatio', 6, `${ratioLabel(input.maxPathCommandRatio)} max-length`);
  if (flagSet.has('pathTruncationPattern')) add('pathTruncationPattern', 14, `${input.sessionPathTruncations}/${input.sessionMoveCommands} truncated`);
  if (flagSet.has('postDeathRouteLoop')) add('postDeathRouteLoop', 12, `${input.sessionPostDeathMoves}/${input.sessionPlayerDeaths} deaths, ${ratioLabel(input.topPostDeathDestinationRepetition)} one tile`);
  if (flagSet.has('mapDataScrape')) add('mapDataScrape', 34, `${input.sessionUniqueMapDataFiles} files, ${input.sessionMapDataRequests} requests`);
  if (flagSet.has('mapDataOutOfScope')) add('mapDataOutOfScope', 34, `${input.sessionSuspiciousPacketReasons[MAP_DATA_OUT_OF_SCOPE_REASON] ?? 0} denied`);
  if (flagSet.has('reservedMapDataPath')) add('reservedMapDataPath', 46, `${input.sessionSuspiciousPacketReasons[RESERVED_MAP_DATA_REASON] ?? 0} request`);
  if (flagSet.has('routeActionLoop')) add('routeActionLoop', 10, `${ratioLabel(input.topActionLoopRepetition)} one signature`);
  if (flagSet.has('lifetimePathConcentration')) add(
    'lifetimePathConcentration',
    input.topLifetimePathRepetition !== null && input.topLifetimePathRepetition >= 0.2 ? 14 : 8,
    `${ratioLabel(input.topLifetimePathRepetition)} over ${input.lifetimeActiveActions} actions`,
  );
  if (flagSet.has('lifetimeRouteActionLoop')) add('lifetimeRouteActionLoop', 10, `${ratioLabel(input.topLifetimeActionLoopRepetition)} one signature`);
  if (flagSet.has('noCursorTelemetry') && !flagSet.has('browserlessActiveGameplay')) {
    add('noCursorTelemetry', 4, '0 cursor packets');
  }
  if (flagSet.has('cursorStatic')) add('cursorStatic', 10, `${ratioLabel(input.topCursorCellRepetition)} one cell`);
  if (flagSet.has('marathonSession')) add('marathonSession', 10, `${input.sessionMinutes} minutes`);
  if (flagSet.has('marathonNoIdleBreaks')) add('marathonNoIdleBreaks', 14, `${input.sessionActiveIdleBreaks} breaks, longest gap ${minutesLabel(input.longestActiveGapMinutes)}`);
  else if (flagSet.has('noIdleBreaks')) add('noIdleBreaks', 8, `${input.sessionActiveIdleBreaks} breaks, longest gap ${minutesLabel(input.longestActiveGapMinutes)}`);
  if (flagSet.has('fastReaction')) add('fastReaction', 22, `${input.reactionMedianMs?.toFixed(0) ?? '?'}ms median`);
  if (flagSet.has('protocolPackets')) add('protocolPackets', 18, `${input.sessionSuspiciousPacketClasses.protocol} this session`);
  if (flagSet.has('rateLimitPackets')) add('rateLimitPackets', 18, `${input.sessionSuspiciousPacketClasses.rateLimit} this session`);
  if (flagSet.has('automationInvalidPackets')) add('automationInvalidPackets', 10, `${input.sessionSuspiciousPacketClasses.automation} this session`);
  if (flagSet.has('reservedActionCapability')) add('reservedActionCapability', 70, 'replayed');
  if (flagSet.has('adminOpcodeAbuse')) add('adminOpcodeAbuse', 70, 'non-admin attempt');
  if (flagSet.has('lifetimeHardInvalidPackets')) add(
    'lifetimeHardInvalidPackets',
    input.totalSuspiciousPacketClasses.protocol + input.totalSuspiciousPacketClasses.rateLimit >= 100 ? 22 : 14,
    `${input.totalSuspiciousPacketClasses.protocol + input.totalSuspiciousPacketClasses.rateLimit} lifetime`,
  );
  if (flagSet.has('lifetimeExtremeLowSocialHighActivity')) {
    add('lifetimeExtremeLowSocialHighActivity', 22, `${rateLabel(input.chatRatePerHour)} chats/hr, ${input.lifetimeActiveActions} actions`);
  } else if (flagSet.has('lifetimeLowSocialHighActivity')) {
    add('lifetimeLowSocialHighActivity', 12, `${rateLabel(input.chatRatePerHour)} chats/hr, ${input.lifetimeActiveActions} actions`);
  }

  const xpVelocitySkills = input.flags.filter((flag) => flag.startsWith('xpVelocity:')).map((flag) => flag.split(':')[1]).filter(Boolean);
  if (xpVelocitySkills.length > 0) add('xpVelocity', 26 + Math.min(12, xpVelocitySkills.length * 3), `${xpVelocitySkills.join(', ')}`);

  if (input.totalHardFlagEvents >= 3) {
    add('lifetimeHardEvidence', 8 + Math.min(10, input.totalHardFlagEvents), `${input.totalHardFlagEvents} prior hard-evidence sessions`);
  }

  if (input.totalFlagEvents >= 25) addCombo(8, `Lifetime flag history (${input.totalFlagEvents} prior fires)`);
  else if (input.totalFlagEvents >= 10) addCombo(4, `Lifetime flag history (${input.totalFlagEvents} prior fires)`);
  else if (input.totalFlagEvents >= 5) addCombo(2, `Lifetime flag history (${input.totalFlagEvents} prior fires)`);

  if (input.totalSuspiciousPackets >= 500) addCombo(4, `Lifetime stale/noisy invalid packet volume (${input.totalSuspiciousPackets})`);
  else if (input.totalSuspiciousPackets >= 100) addCombo(2, `Lifetime stale/noisy invalid packet volume (${input.totalSuspiciousPackets})`);

  if (flagSet.has('activityHeartbeatCoupled') && flagSet.has('pingRegular')) addCombo(8, 'Heartbeat cadence controls activity cadence');
  if (flagSet.has('activityRegular') && flagSet.has('routeActionLoop')) addCombo(8, 'Regular activity cadence during repeated route/action loop');
  if (flagSet.has('sameCommandCadenceRegular') && flagSet.has('routeActionLoop')) addCombo(10, 'Regular click cadence during repeated route/action loop');
  if (flagSet.has('gameplayCommandCadenceRegular') && flagSet.has('activityRegular')) addCombo(6, 'Regular gameplay commands match regular activity telemetry');
  if (flagSet.has('gameplayCommandSequencePattern') && flagSet.has('gameplayCommandIntervalPattern')) addCombo(12, 'Repeated command sequence with repeated interval pattern');
  if (flagSet.has('gameplayCommandIntervalPattern') && flagSet.has('routeActionLoop')) addCombo(8, 'Repeated interval pattern during route/action loop');
  if (flagSet.has('noIdleBreaks') && flagSet.has('routeActionLoop')) addCombo(4, 'No idle breaks during repeated route/action loop');
  if (flagSet.has('marathonNoIdleBreaks') && flagSet.has('activityRegular')) addCombo(6, 'Script-regular activity over a no-break marathon');
  if (flagSet.has('legacyActivityTelemetry') && flagSet.has('commandsWithoutRecentActivity')) addCombo(6, 'Legacy activity telemetry still missing near gameplay commands');
  if (flagSet.has('noMoveRedirects') && flagSet.has('routeActionLoop')) addCombo(6, 'Uninterrupted movement during repeated route/action loop');
  if (flagSet.has('maxPathCommandRatio') && flagSet.has('routeActionLoop')) addCombo(4, 'Max-length pathing during repeated route/action loop');
  if (flagSet.has('pathTruncationPattern') && flagSet.has('routeActionLoop')) addCombo(6, 'Path truncation pattern during repeated route/action loop');
  if (flagSet.has('postDeathRouteLoop') && flagSet.has('routeActionLoop')) addCombo(6, 'Death recovery returns into repeated route/action loop');
  if (flagSet.has('fastReaction') && flagSet.has('pathRepetitive')) addCombo(6, 'Fast reactions while following a repetitive route');
  if (flagSet.has('browserlessActiveGameplay') && flagSet.has('routeActionLoop')) addCombo(10, 'Browserless repeated route/action loop');
  if (flagSet.has('noCursorTelemetry') && flagSet.has('routeActionLoop')) addCombo(4, 'Repeated route/action loop without cursor input');
  if (flagSet.has('commandsWithoutRecentInput') && flagSet.has('browserlessActiveGameplay')) addCombo(8, 'Raw socket commands during browserless gameplay');
  if (
    flagSet.has('commandsWithoutRecentActivity')
    && flagSet.has('noClientActivityTelemetry')
    && !flagSet.has('browserlessActiveGameplay')
  ) {
    addCombo(8, 'Gameplay commands without browser activity telemetry');
  }
  if (xpVelocitySkills.length > 0 && flagSet.has('noChat')) addCombo(6, 'High XP velocity with no social activity');

  if (input.sessionMinutes >= 240 && input.sessionChats === 0 && input.sessionMovements >= 100) {
    addCombo(6, 'Multi-hour silent movement-heavy session');
  }

  let hardEvidence = hasHardBotEvidence(evidenceFlagSet) || input.totalHardFlagEvents >= 3;
  if (!hardEvidence) {
    const behavioralCount = behavioralEvidenceFlagCount(flagSet);
    if (behavioralCount >= BEHAVIORAL_EVIDENCE_THRESHOLD) {
      hardEvidence = true;
      // Surface the reason the score wasn't capped, even though it adds no points.
      signals.push({
        flag: 'behavioralEvidenceCluster',
        label: `${behavioralCount} independent automation signals`,
        description: 'Several independent automation tells co-occur. Treated as hard evidence so the score is not capped, even without a single standalone hard flag.',
        threshold: `≥${BEHAVIORAL_EVIDENCE_THRESHOLD} automation signals`,
        measured: `${behavioralCount} signals`,
        points: 0,
        tier: 'context',
      });
    } else {
      score = Math.min(score, 29);
    }
  }
  if (hardEvidence) score = Math.max(score, 30);

  const capped = Math.min(100, Math.round(score));
  signals.sort((a, b) => b.points - a.points);
  return {
    score: capped,
    level: riskLevelForScore(capped),
    reasons: reasons.slice(0, 12),
    signals: signals.slice(0, 16),
    hardEvidence,
  };
}

function hasHardBotEvidence(flagSet: Set<string>): boolean {
  return flagSet.has('gameplayCommandCadenceRegular')
    || flagSet.has('sameCommandCadenceRegular')
    || flagSet.has('gameplayCommandIntervalPattern')
    || flagSet.has('rapidGameplayCommandCadence')
    || flagSet.has('mechanicalJitter')
    || flagSet.has('moderateMechanicalJitter')
    || flagSet.has('browserlessActiveGameplay')
    || flagSet.has('commandsWithoutRecentInput')
    || flagSet.has('commandsWithoutRecentActivity')
    || flagSet.has('reservedActionCapability')
    || flagSet.has('adminOpcodeAbuse')
    || flagSet.has('deviceRotating')
    || flagSet.has('protocolPackets')
    || flagSet.has('rateLimitPackets')
    || flagSet.has('automationInvalidPackets')
    || flagSet.has('lifetimeHardInvalidPackets')
    || flagSet.has('mapDataScrape')
    || flagSet.has('mapDataOutOfScope')
    || flagSet.has('reservedMapDataPath')
    || flagSet.has('xpVelocity');
}

function riskLevelForScore(score: number): BotRiskLevel {
  if (score >= 85) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function normalizeRiskLevel(value: unknown): BotRiskLevel {
  return value === 'critical' || value === 'high' || value === 'medium' || value === 'low'
    ? value
    : 'low';
}

function ratioLabel(value: number | null): string {
  return value === null ? '?' : value.toFixed(2);
}

function rateLabel(value: number | null): string {
  return value === null ? '?' : value.toFixed(2);
}

function minutesLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '?m';
  return `${value.toFixed(value >= 10 ? 0 : 1)}m`;
}

function sanitizeSignaturePart(value: string, maxLength: number): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '?').slice(0, maxLength) || 'unknown';
}

function sanitizeSuspiciousReason(value: string): string {
  return sanitizeSignaturePart(value, 64);
}

function emptySuspiciousPacketClassCounts(): SuspiciousPacketClassCounts {
  return { protocol: 0, rateLimit: 0, automation: 0, reserved: 0, state: 0, stale: 0 };
}

function classifyReasonCounts(reasons: Map<string, number>): SuspiciousPacketClassCounts {
  const counts = emptySuspiciousPacketClassCounts();
  for (const [reason, count] of reasons) {
    counts[classifySuspiciousReason(reason)] += count;
  }
  return counts;
}

function classifySuspiciousReason(reason: string): SuspiciousPacketClass {
  if (reason.startsWith('rate-limit:')) return 'rateLimit';
  if (reason === 'reserved-action-capability' || reason === LEGACY_RESERVED_ACTION_REASON || reason === RESERVED_MAP_DATA_REASON) return 'reserved';
  if (
    reason === 'missing-action-capability'
    || reason === 'stale-action-capability'
    || reason === 'bad-action-capability'
  ) return 'stale';
  if (
    reason === 'malformed-frame'
    || reason === 'unknown-opcode'
    || reason === 'bad-move-path-length'
    || reason === 'truncated-move-path'
    || reason === 'bad-cursor-x'
    || reason === 'bad-cursor-y'
  ) return 'protocol';
  if (
    reason === 'missing-input-ticket'
    || reason === 'stale-input-ticket'
    || reason === 'bad-input-ticket-kind'
    || reason === 'missing-input-telemetry'
    || reason.startsWith('bad-client-activity-')
    || reason.startsWith('bad-client-input-')
  ) return 'automation';
  if (
    reason.startsWith('stale-')
    || reason.startsWith('unreachable-')
    || reason.startsWith('unseen-')
    || reason.includes('-not-open')
    || reason === 'private-ground-item'
    || reason === 'dialogue-not-open'
    || reason === 'shop-not-found'
    || reason === 'shop-does-not-sell-item'
  ) return 'stale';
  return 'state';
}

function mapToObject(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(map);
}

function mapTotal(map: Map<string, number>): number {
  let total = 0;
  for (const count of map.values()) total += count;
  return total;
}

function isMeaningfulSession(summary: SessionSummary): boolean {
  const activeEvents = summary.sessionSkillingActions + summary.sessionCombatSwings + summary.sessionMovements;
  const evidenceFlags = summary.evidenceFlags ?? summary.flags;
  return summary.sessionMinutes >= MIN_MEANINGFUL_SESSION_MINUTES
    || activeEvents >= 50
    || summary.sessionSuspiciousPackets >= 5
    || summary.sessionInputlessCommands >= 5
    || summary.riskHardEvidence
    || evidenceFlags.length > 0;
}

function parseSessionSummary(raw: string | null | undefined): SessionSummary | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { riskScore?: unknown }).riskScore === 'number') {
      return parsed as SessionSummary;
    }
  } catch { /* empty */ }
  return null;
}

function parseSessionHistory(raw: string | null | undefined): SessionHistoryEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is SessionHistoryEntry => (
      !!entry
      && typeof entry === 'object'
      && typeof (entry as { finalizedAt?: unknown }).finalizedAt === 'number'
      && typeof (entry as { riskScore?: unknown }).riskScore === 'number'
    )).slice(-MAX_SESSION_HISTORY);
  } catch {
    return [];
  }
}
