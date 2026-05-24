import type { BotStatsRow, GameDatabase } from './Database';
import { audit } from './Audit';
import { ClientActivityKind, TICK_RATE } from '@projectrs/shared';
import type { SkillId } from '@projectrs/shared';

/**
 * Per-player bot-detection telemetry. Lives on each connected Player,
 * accumulates signal in memory, persists periodically to the bot_stats
 * SQLite table, and emits a session-summary JSONL line to the audit log
 * on logout / 30-min checkpoint.
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
const MAX_PATH_DESTINATIONS = 100;
const MAX_ACTION_SIGNATURES = 100;
const MAX_CURSOR_CELLS = 64;
const MAX_SUSPICIOUS_REASONS = 80;
const MAX_SESSION_HISTORY = 12;
const ACTION_ROUTE_MEMORY_MS = 10_000;
const HEARTBEAT_ACTIVITY_COUPLING_MS = 350;
const MIN_MEANINGFUL_SESSION_MINUTES = 5;
const MIN_ROUTE_ACTION_LOOP_SIGNATURES = 20;
const MIN_XP_VELOCITY_SESSION_MINUTES = 5;
const MIN_XP_VELOCITY_ACTIVE_EVENTS = 20;

type SuspiciousPacketClass = 'protocol' | 'rateLimit' | 'automation' | 'state' | 'stale';

interface SuspiciousPacketClassCounts {
  protocol: number;
  rateLimit: number;
  automation: number;
  state: number;
  stale: number;
}

/** Realistic max XP/hour per skill. Anything above flags. Calibrated for
 *  EvilQuest's tick rate + drop rates — adjust as content lands. These are
 *  ceilings (faster than a human could plausibly grind), not "expected"
 *  rates. */
const XP_PER_HOUR_CEILING: Record<SkillId, number> = {
  accuracy: 120000,
  strength: 120000,
  defence: 120000,
  hitpoints: 40000,
  archery: 120000,
  goodmagic: 100000,
  evilmagic: 100000,
  woodcut: 80000,
  fishing: 80000,
  cooking: 100000,
  mining: 80000,
  smithing: 100000,
  crafting: 100000,
  roguery: 80000,
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
  activitySeqResets: number;
  heartbeatActivityCouplingRatio: number | null;
  inputlessCommandRatio: number | null;
  activitylessCommandRatio: number | null;
  moveRedirectRatio: number | null;
  maxPathCommandRatio: number | null;
  pathTruncationRatio: number | null;
  topPathRepetition: number | null;
  topActionLoopRepetition: number | null;
  topLifetimePathRepetition: number | null;
  topLifetimeActionLoopRepetition: number | null;
  topCursorCellRepetition: number | null;
  cursorUniqueCells: number;
  deviceIdsSeen: number;
  deviceReuseRatio: number | null;
  lifetimeActiveActions: number;
  chatRatePerHour: number | null;
  actionsPerHour: number | null;
  actionsPerChat: number | null;
  longSessionCount: number;
  xpPerHour: Record<string, number>;
  flags: string[];
  riskScore: number;
  riskLevel: BotRiskLevel;
  riskReasons: string[];
}

export type BotRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface BotRiskProfile {
  score: number;
  level: BotRiskLevel;
  reasons: string[];
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
  sessionSuspiciousPackets: number = 0;
  sessionPathDestinations: Map<string, number> = new Map();
  sessionActionSignatures: Map<string, number> = new Map();
  sessionSuspiciousPacketReasons: Map<string, number> = new Map();
  cursorCells: Map<string, number> = new Map();
  private lastMovementDestinationKey: string | null = null;
  private lastMovementTs: number | null = null;
  private lastPingAt: number | null = null;
  private lastPingSeq: number | null = null;
  private pingSeqResets: number = 0;
  private lastActivityAt: number | null = null;
  private lastActivitySeq: number | null = null;
  private activitySeqResets: number = 0;
  private lastCursorAt: number | null = null;
  private lastCoupledActivityAt: number | null = null;
  private activityHeartbeatCoupledEvents: number = 0;
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
    this.sessionSuspiciousPackets = 0;
    this.sessionPathDestinations.clear();
    this.sessionActionSignatures.clear();
    this.sessionSuspiciousPacketReasons.clear();
    this.cursorCells.clear();
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
    this.lastCoupledActivityAt = null;
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
  recordSkillingRoll(tickStartWallclock: number, performanceNow: number): void {
    this.totalSkillingActions++;
    this.sessionSkillingActions++;
    this.lastActionTs = Math.floor(Date.now() / 1000);
    const delta = (performanceNow - tickStartWallclock) % TICK_RATE;
    this.pushSample(this.tickAlignSamples, delta, MAX_TICK_ALIGN_SAMPLES);
  }

  /** Record a combat swing. Also closes a pending reaction window if this
   *  swing landed within 5s of an NPC death — that's the canonical
   *  reaction-time signal (re-engage on next mob). */
  recordCombatSwing(tickStartWallclock: number, performanceNow: number): void {
    this.totalCombatSwings++;
    this.sessionCombatSwings++;
    this.lastActionTs = Math.floor(Date.now() / 1000);
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
  recordMovement(destX: number, destZ: number): void {
    this.totalMovements++;
    this.sessionMovements++;
    this.lastActionTs = Math.floor(Date.now() / 1000);
    const key = `${Math.floor(destX)},${Math.floor(destZ)}`;
    this.lastMovementDestinationKey = key;
    this.lastMovementTs = Date.now();
    this.bumpCappedMap(this.sessionPathDestinations, key, MAX_PATH_DESTINATIONS);
    this.bumpCappedMap(this.pathDestinations, key, MAX_PATH_DESTINATIONS);
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
    const topPathRepetition = topRatio(this.sessionPathDestinations);
    const topActionLoopRepetition = topRatio(this.sessionActionSignatures);
    const topLifetimePathRepetition = topRatio(this.pathDestinations);
    const topLifetimeActionLoopRepetition = topRatio(this.actionSignatures);
    const topCursorCellRepetition = topRatio(this.cursorCells);
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
      sessionActionSignatureCount >= MIN_ROUTE_ACTION_LOOP_SIGNATURES
      && topActionLoopRepetition !== null
      && topActionLoopRepetition > 0.45
    ) {
      flags.push('routeActionLoop');
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
      sessionMinutes >= 5
      && (activeEvents >= 50 || directGameplayEvents >= 25)
      && this.sessionCursorEvents === 0
    ) {
      flags.push('noCursorTelemetry');
    }
    if (this.sessionInputlessCommands >= 5) {
      flags.push('inputlessCommandBurst');
    }
    if (this.sessionCommandsWithoutRecentInput >= 3) {
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
    if (this.sessionCursorEvents >= 20 && topCursorCellRepetition !== null && topCursorCellRepetition > 0.95) {
      flags.push('cursorStatic');
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

    const risk = computeBotRiskProfile({
      flags,
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
      sessionSkillingActions: this.sessionSkillingActions,
      sessionCombatSwings: this.sessionCombatSwings,
      sessionMovements: this.sessionMovements,
      sessionMoveCommands: this.sessionMoveCommands,
      sessionMoveRedirects: this.sessionMoveRedirects,
      sessionMaxPathMoveCommands: this.sessionMaxPathMoveCommands,
      sessionPathTruncations: this.sessionPathTruncations,
      sessionSuspiciousPackets: this.sessionSuspiciousPackets,
      totalSuspiciousPackets: this.totalSuspiciousPackets,
      sessionSuspiciousPacketClasses,
      totalSuspiciousPacketClasses,
      totalFlagEvents: this.totalFlagEvents,
      tickAlignSamples: this.tickAlignSamples.length,
      tickAlignStdDevMs,
      pingIntervalSamples: this.pingIntervalSamples.length,
      pingIntervalStdDevMs,
      pingSeqResets: this.pingSeqResets,
      activityIntervalStdDevMs,
      activitySeqResets: this.activitySeqResets,
      heartbeatActivityCouplingRatio,
      inputlessCommandRatio,
      activitylessCommandRatio,
      moveRedirectRatio,
      maxPathCommandRatio,
      pathTruncationRatio,
      reactionSamples: this.reactionSamples.length,
      reactionMedianMs,
      topPathRepetition,
      topActionLoopRepetition,
      topLifetimePathRepetition,
      topLifetimeActionLoopRepetition,
      topCursorCellRepetition,
      cursorUniqueCells: this.cursorCells.size,
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
      activitySeqResets: this.activitySeqResets,
      heartbeatActivityCouplingRatio,
      inputlessCommandRatio,
      activitylessCommandRatio,
      moveRedirectRatio,
      maxPathCommandRatio,
      pathTruncationRatio,
      topPathRepetition,
      topActionLoopRepetition,
      topLifetimePathRepetition,
      topLifetimeActionLoopRepetition,
      topCursorCellRepetition,
      cursorUniqueCells: this.cursorCells.size,
      deviceIdsSeen,
      deviceReuseRatio,
      lifetimeActiveActions,
      chatRatePerHour,
      actionsPerHour,
      actionsPerChat,
      longSessionCount,
      xpPerHour,
      flags,
      riskScore: risk.score,
      riskLevel: risk.level,
      riskReasons: risk.reasons,
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

  /** Session end (logout, or 30-min auto-checkpoint with reset). Computes
   *  the summary, writes it both to DB (overwrites last_session_summary)
   *  and to audit.log (one JSONL line). Updates totalSessionMinutes and
   *  totalFlagEvents counters. */
  finalize(db: GameDatabase, accountId: number, currentXp: Record<string, number>, tick: number): SessionSummary {
    const summary = this.computeSummary(currentXp);
    this.totalSessionMinutes += summary.sessionMinutes;
    this.totalFlagEvents += summary.flags.length;
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

interface BotRiskInput {
  flags: string[];
  sessionMinutes: number;
  sessionChats: number;
  sessionSkillingActions: number;
  sessionCombatSwings: number;
  sessionMovements: number;
  sessionMoveCommands: number;
  sessionMoveRedirects: number;
  sessionMaxPathMoveCommands: number;
  sessionPathTruncations: number;
  sessionActivityEvents: number;
  sessionDetailedActivityEvents: number;
  sessionLegacyActivityEvents: number;
  sessionCursorEvents: number;
  sessionInputlessCommands: number;
  sessionGameplayCommands: number;
  sessionCommandsWithoutRecentInput: number;
  sessionCommandsWithoutRecentActivity: number;
  sessionSuspiciousPackets: number;
  totalSuspiciousPackets: number;
  sessionSuspiciousPacketClasses: SuspiciousPacketClassCounts;
  totalSuspiciousPacketClasses: SuspiciousPacketClassCounts;
  totalFlagEvents: number;
  tickAlignSamples: number;
  tickAlignStdDevMs: number | null;
  pingIntervalSamples: number;
  pingIntervalStdDevMs: number | null;
  pingSeqResets: number;
  activityIntervalStdDevMs: number | null;
  activitySeqResets: number;
  heartbeatActivityCouplingRatio: number | null;
  inputlessCommandRatio: number | null;
  activitylessCommandRatio: number | null;
  moveRedirectRatio: number | null;
  maxPathCommandRatio: number | null;
  pathTruncationRatio: number | null;
  reactionSamples: number;
  reactionMedianMs: number | null;
  topPathRepetition: number | null;
  topActionLoopRepetition: number | null;
  topLifetimePathRepetition: number | null;
  topLifetimeActionLoopRepetition: number | null;
  topCursorCellRepetition: number | null;
  cursorUniqueCells: number;
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

export function computeBotRiskProfile(input: BotRiskInput): BotRiskProfile {
  let score = 0;
  const reasons: string[] = [];
  const add = (points: number, reason: string) => {
    if (points <= 0) return;
    score += points;
    reasons.push(`${reason} (+${points})`);
  };
  const flagSet = new Set(input.flags.map((f) => f.includes(':') ? f.split(':')[0] : f));

  if (flagSet.has('tickAligned') && (flagSet.has('routeActionLoop') || flagSet.has('lifetimeRouteActionLoop') || flagSet.has('fastReaction'))) {
    add(6, `server-tick alignment paired with behavioral loop (${input.tickAlignStdDevMs?.toFixed(0) ?? '?'}ms stddev)`);
  }
  if (flagSet.has('pingRegular')) add(12, `script-regular heartbeat timing (${input.pingIntervalStdDevMs?.toFixed(0) ?? '?'}ms stddev)`);
  if (flagSet.has('pingSeqReset')) add(10, `heartbeat sequence resets (${input.pingSeqResets})`);
  if (flagSet.has('activityHeartbeatCoupled')) add(20, `activity packets coupled to heartbeat (${ratioLabel(input.heartbeatActivityCouplingRatio)})`);
  if (flagSet.has('activityRegular')) add(18, `script-regular activity timing (${input.activityIntervalStdDevMs?.toFixed(0) ?? '?'}ms stddev)`);
  if (flagSet.has('activitySeqReset')) add(8, `activity sequence resets (${input.activitySeqResets})`);
  if (flagSet.has('legacyActivityTelemetry')) add(
    10,
    `legacy/no-detail activity telemetry (${input.sessionDetailedActivityEvents}/${input.sessionActivityEvents} detailed)`,
  );
  if (flagSet.has('browserlessActiveGameplay')) add(
    46,
    `active gameplay without browser input telemetry (${input.sessionSkillingActions + input.sessionCombatSwings + input.sessionMovements} actions)`,
  );
  if (flagSet.has('inputlessCommandBurst')) add(28, `gameplay commands before browser input telemetry (${input.sessionInputlessCommands})`);
  if (flagSet.has('commandsWithoutRecentInput')) add(
    34,
    `gameplay commands without recent browser input (${input.sessionCommandsWithoutRecentInput}/${input.sessionGameplayCommands})`,
  );
  if (flagSet.has('commandsWithoutRecentActivity')) add(
    42,
    `gameplay commands without recent browser activity (${input.sessionCommandsWithoutRecentActivity}/${input.sessionGameplayCommands})`,
  );
  if (flagSet.has('inputlessCommandRatio')) add(
    18,
    `high no-input gameplay command ratio (${ratioLabel(input.inputlessCommandRatio)})`,
  );
  if (flagSet.has('activitylessCommandRatio')) add(
    22,
    `high no-activity gameplay command ratio (${ratioLabel(input.activitylessCommandRatio)})`,
  );
  if (flagSet.has('noClientActivityTelemetry')) add(12, 'active session without client activity telemetry');
  if (flagSet.has('deviceRotating')) add(24, `rotating browser device IDs (${input.deviceIdsSeen} seen)`);
  if (flagSet.has('noChat')) add(8, 'long active session with no chat');
  if (flagSet.has('pathRepetitive')) add(8, `repetitive movement destination (${ratioLabel(input.topPathRepetition)})`);
  if (flagSet.has('noMoveRedirects')) add(
    6,
    `no mid-path redirects (${input.sessionMoveRedirects}/${input.sessionMoveCommands} move commands)`,
  );
  if (flagSet.has('maxPathCommandRatio')) add(
    6,
    `high max-length path command ratio (${ratioLabel(input.maxPathCommandRatio)})`,
  );
  if (flagSet.has('pathTruncationPattern')) add(
    14,
    `repeated path truncations (${input.sessionPathTruncations}/${input.sessionMoveCommands} move commands)`,
  );
  if (flagSet.has('routeActionLoop')) add(10, `repeated route/action loop (${ratioLabel(input.topActionLoopRepetition)})`);
  if (flagSet.has('lifetimePathConcentration')) add(
    input.topLifetimePathRepetition !== null && input.topLifetimePathRepetition >= 0.2 ? 14 : 8,
    `lifetime path concentration (${ratioLabel(input.topLifetimePathRepetition)} over ${input.lifetimeActiveActions} actions)`,
  );
  if (flagSet.has('lifetimeRouteActionLoop')) add(10, `lifetime route/action loop (${ratioLabel(input.topLifetimeActionLoopRepetition)})`);
  if (flagSet.has('noCursorTelemetry')) add(4, 'active session without cursor telemetry');
  if (flagSet.has('cursorStatic')) add(10, `static cursor telemetry (${ratioLabel(input.topCursorCellRepetition)})`);
  if (flagSet.has('marathonSession')) add(10, `marathon session (${input.sessionMinutes} minutes)`);
  if (flagSet.has('fastReaction')) add(22, `fast NPC re-engage median (${input.reactionMedianMs?.toFixed(0) ?? '?'}ms)`);
  if (flagSet.has('protocolPackets')) add(18, `malformed/protocol packet abuse (${input.sessionSuspiciousPacketClasses.protocol} this session)`);
  if (flagSet.has('rateLimitPackets')) add(18, `rate-limit automation packets (${input.sessionSuspiciousPacketClasses.rateLimit} this session)`);
  if (flagSet.has('automationInvalidPackets')) add(10, `automation-shaped invalid packets (${input.sessionSuspiciousPacketClasses.automation} this session)`);
  if (flagSet.has('lifetimeHardInvalidPackets')) add(
    input.totalSuspiciousPacketClasses.protocol + input.totalSuspiciousPacketClasses.rateLimit >= 100 ? 22 : 14,
    `lifetime hard invalid packets (${input.totalSuspiciousPacketClasses.protocol + input.totalSuspiciousPacketClasses.rateLimit})`,
  );
  if (flagSet.has('lifetimeExtremeLowSocialHighActivity')) {
    add(22, `extreme low-social high-activity lifetime (${rateLabel(input.chatRatePerHour)} chats/hr, ${input.lifetimeActiveActions} actions)`);
  } else if (flagSet.has('lifetimeLowSocialHighActivity')) {
    add(12, `low-social high-activity lifetime (${rateLabel(input.chatRatePerHour)} chats/hr, ${input.lifetimeActiveActions} actions)`);
  }

  const xpVelocitySkills = input.flags.filter((flag) => flag.startsWith('xpVelocity:')).map((flag) => flag.split(':')[1]).filter(Boolean);
  if (xpVelocitySkills.length > 0) add(26 + Math.min(12, xpVelocitySkills.length * 3), `impossible XP velocity (${xpVelocitySkills.join(', ')})`);

  if (input.totalFlagEvents >= 25) add(8, `lifetime flag history (${input.totalFlagEvents} prior fires)`);
  else if (input.totalFlagEvents >= 10) add(4, `lifetime flag history (${input.totalFlagEvents} prior fires)`);
  else if (input.totalFlagEvents >= 5) add(2, `lifetime flag history (${input.totalFlagEvents} prior fires)`);

  if (input.totalSuspiciousPackets >= 500) add(4, `lifetime stale/noisy invalid packet volume (${input.totalSuspiciousPackets})`);
  else if (input.totalSuspiciousPackets >= 100) add(2, `lifetime stale/noisy invalid packet volume (${input.totalSuspiciousPackets})`);

  if (flagSet.has('activityHeartbeatCoupled') && flagSet.has('pingRegular')) add(8, 'heartbeat cadence controls activity cadence');
  if (flagSet.has('activityRegular') && flagSet.has('routeActionLoop')) add(8, 'regular activity cadence during repeated route/action loop');
  if (flagSet.has('legacyActivityTelemetry') && flagSet.has('commandsWithoutRecentActivity')) add(6, 'legacy activity telemetry still missing near gameplay commands');
  if (flagSet.has('noMoveRedirects') && flagSet.has('routeActionLoop')) add(6, 'uninterrupted movement during repeated route/action loop');
  if (flagSet.has('maxPathCommandRatio') && flagSet.has('routeActionLoop')) add(4, 'max-length pathing during repeated route/action loop');
  if (flagSet.has('pathTruncationPattern') && flagSet.has('routeActionLoop')) add(6, 'path truncation pattern during repeated route/action loop');
  if (flagSet.has('fastReaction') && flagSet.has('pathRepetitive')) add(6, 'fast reactions while following a repetitive route');
  if (flagSet.has('browserlessActiveGameplay') && flagSet.has('routeActionLoop')) add(10, 'browserless repeated route/action loop');
  if (flagSet.has('noCursorTelemetry') && flagSet.has('routeActionLoop')) add(4, 'repeated route/action loop without cursor input');
  if (flagSet.has('commandsWithoutRecentInput') && flagSet.has('browserlessActiveGameplay')) add(8, 'raw socket commands during browserless gameplay');
  if (flagSet.has('commandsWithoutRecentActivity') && flagSet.has('noClientActivityTelemetry')) add(8, 'gameplay commands without browser activity telemetry');
  if (xpVelocitySkills.length > 0 && flagSet.has('noChat')) add(6, 'high XP velocity with no social activity');

  if (input.sessionMinutes >= 240 && input.sessionChats === 0 && input.sessionMovements >= 100) {
    add(6, 'multi-hour silent movement-heavy session');
  }

  if (!hasHardBotEvidence(flagSet)) {
    score = Math.min(score, 29);
  }

  const capped = Math.min(100, Math.round(score));
  return {
    score: capped,
    level: riskLevelForScore(capped),
    reasons: reasons.slice(0, 12),
  };
}

function hasHardBotEvidence(flagSet: Set<string>): boolean {
  return flagSet.has('activityHeartbeatCoupled')
    || flagSet.has('activityRegular')
    || flagSet.has('browserlessActiveGameplay')
    || flagSet.has('commandsWithoutRecentInput')
    || flagSet.has('commandsWithoutRecentActivity')
    || flagSet.has('deviceRotating')
    || flagSet.has('inputlessCommandBurst')
    || flagSet.has('inputlessCommandRatio')
    || flagSet.has('activitylessCommandRatio')
    || flagSet.has('protocolPackets')
    || flagSet.has('rateLimitPackets')
    || flagSet.has('lifetimeHardInvalidPackets')
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

function sanitizeSignaturePart(value: string, maxLength: number): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, '?').slice(0, maxLength) || 'unknown';
}

function sanitizeSuspiciousReason(value: string): string {
  return sanitizeSignaturePart(value, 64);
}

function emptySuspiciousPacketClassCounts(): SuspiciousPacketClassCounts {
  return { protocol: 0, rateLimit: 0, automation: 0, state: 0, stale: 0 };
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
  if (
    reason === 'malformed-frame'
    || reason === 'unknown-opcode'
    || reason === 'bad-move-path-length'
    || reason === 'truncated-move-path'
    || reason === 'bad-cursor-x'
    || reason === 'bad-cursor-y'
  ) return 'protocol';
  if (
    reason.startsWith('bad-')
    || reason.startsWith('missing-')
    || reason === 'self-use-item'
    || reason === 'self-move-inventory'
    || reason === 'appearance-editor-not-open'
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
  return summary.sessionMinutes >= MIN_MEANINGFUL_SESSION_MINUTES
    || activeEvents >= 50
    || summary.sessionSuspiciousPackets >= 5
    || summary.sessionInputlessCommands >= 5
    || summary.flags.includes('browserlessActiveGameplay');
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
