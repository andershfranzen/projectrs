import type { BotStatsRow, GameDatabase } from './Database';
import { audit } from './Audit';
import { TICK_RATE } from '@projectrs/shared';

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
const MAX_PATH_DESTINATIONS = 100;

/** Realistic max XP/hour per skill. Anything above flags. Calibrated for
 *  evilMUD's tick rate + drop rates — adjust as content lands. These are
 *  ceilings (faster than a human could plausibly grind), not "expected"
 *  rates. */
const XP_PER_HOUR_CEILING: Record<string, number> = {
  accuracy: 120000,
  strength: 120000,
  defence: 120000,
  hitpoints: 40000,
  archery: 120000,
  goodmagic: 100000,
  evilmagic: 100000,
  forestry: 80000,
  fishing: 80000,
  cooking: 100000,
  mining: 80000,
  smithing: 100000,
  crafting: 100000,
};

export interface SessionSummary {
  sessionMinutes: number;
  sessionSkillingActions: number;
  sessionCombatSwings: number;
  sessionMovements: number;
  sessionChats: number;
  tickAlignStdDevMs: number | null;
  reactionMedianMs: number | null;
  topPathRepetition: number | null;
  xpPerHour: Record<string, number>;
  flags: string[];
}

export class BotStats {
  // Lifetime counters (accumulate across sessions, persisted)
  totalSkillingActions: number = 0;
  totalCombatSwings: number = 0;
  totalMovements: number = 0;
  totalChatMessages: number = 0;
  totalSessionMinutes: number = 0;
  totalFlagEvents: number = 0;
  lastChatTs: number | null = null;
  lastActionTs: number | null = null;
  lastLoginTs: number | null = null;

  // Rolling samples (persisted, capped)
  tickAlignSamples: number[] = [];
  reactionSamples: number[] = [];
  pathDestinations: Map<string, number> = new Map();

  // Per-skill XP at session start (used to compute session XP/hour rate)
  xpBaseline: Map<string, number> = new Map();

  // Current session state (in-memory only — reset on login)
  sessionStartedAt: number = Date.now();
  sessionSkillingActions: number = 0;
  sessionCombatSwings: number = 0;
  sessionMovements: number = 0;
  sessionChats: number = 0;
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
    s.lastChatTs = row.last_chat_ts;
    s.lastActionTs = row.last_action_ts;
    s.lastLoginTs = row.last_login_ts;
    try { s.tickAlignSamples = JSON.parse(row.tick_align_samples); } catch { s.tickAlignSamples = []; }
    try { s.reactionSamples = JSON.parse(row.reaction_samples); } catch { s.reactionSamples = []; }
    try {
      const obj: Record<string, number> = JSON.parse(row.path_destinations);
      for (const [k, v] of Object.entries(obj)) s.pathDestinations.set(k, v);
    } catch { /* empty */ }
    try {
      const obj: Record<string, number> = JSON.parse(row.xp_baseline);
      for (const [k, v] of Object.entries(obj)) s.xpBaseline.set(k, v);
    } catch { /* empty */ }
    return s;
  }

  /** Serialize to a DB row. Called by checkpoint() + finalize(). */
  toRow(lastSummary: SessionSummary | null = null): BotStatsRow {
    const pathObj: Record<string, number> = {};
    for (const [k, v] of this.pathDestinations) pathObj[k] = v;
    const xpObj: Record<string, number> = {};
    for (const [k, v] of this.xpBaseline) xpObj[k] = v;
    return {
      total_skilling_actions: this.totalSkillingActions,
      total_combat_swings: this.totalCombatSwings,
      total_movements: this.totalMovements,
      total_chat_messages: this.totalChatMessages,
      total_session_minutes: this.totalSessionMinutes,
      total_flag_events: this.totalFlagEvents,
      last_chat_ts: this.lastChatTs,
      last_action_ts: this.lastActionTs,
      last_login_ts: this.lastLoginTs,
      tick_align_samples: JSON.stringify(this.tickAlignSamples),
      reaction_samples: JSON.stringify(this.reactionSamples),
      path_destinations: JSON.stringify(pathObj),
      xp_baseline: JSON.stringify(xpObj),
      last_session_summary: lastSummary ? JSON.stringify(lastSummary) : null,
    };
  }

  /** Mark login: reset session counters, capture current XP per skill as
   *  the baseline so XP-rate is computed against play (not lifetime). */
  onLogin(currentXp: Record<string, number>): void {
    const now = Date.now();
    this.sessionStartedAt = now;
    this.sessionSkillingActions = 0;
    this.sessionCombatSwings = 0;
    this.sessionMovements = 0;
    this.sessionChats = 0;
    this.pendingReactionStart = null;
    this.xpBaseline.clear();
    for (const [skill, xp] of Object.entries(currentXp)) {
      this.xpBaseline.set(skill, xp);
    }
    this.lastLoginTs = Math.floor(now / 1000);
  }

  /** Record a skilling roll (mining tick, fishing tick, etc.). The tick
   *  alignment delta is the ms between the roll's wallclock time and the
   *  most recent tick boundary — bots cluster near 0, humans spread to
   *  150-500ms. */
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
    const existing = this.pathDestinations.get(key);
    if (existing !== undefined) {
      this.pathDestinations.set(key, existing + 1);
      return;
    }
    if (this.pathDestinations.size >= MAX_PATH_DESTINATIONS) {
      // Evict the least-visited. Bots concentrate visits to a few tiles,
      // so eviction protects the high-signal entries.
      let minKey: string | null = null;
      let minCount = Infinity;
      for (const [k, v] of this.pathDestinations) {
        if (v < minCount) { minCount = v; minKey = k; }
      }
      if (minKey !== null) this.pathDestinations.delete(minKey);
    }
    this.pathDestinations.set(key, 1);
  }

  recordChat(): void {
    this.totalChatMessages++;
    this.sessionChats++;
    this.lastChatTs = Math.floor(Date.now() / 1000);
  }

  /** Compute session summary + flags. Pure read-only on stats. */
  computeSummary(currentXp: Record<string, number>): SessionSummary {
    const now = Date.now();
    const sessionMinutes = Math.floor((now - this.sessionStartedAt) / 60000);
    const tickAlignStdDevMs = stdDev(this.tickAlignSamples);
    const reactionMedianMs = median(this.reactionSamples);
    const topPathRepetition = topRatio(this.pathDestinations);

    // XP rate per skill = (current - baseline) / hours
    const hours = Math.max(1 / 60, sessionMinutes / 60);
    const xpPerHour: Record<string, number> = {};
    for (const [skill, current] of Object.entries(currentXp)) {
      const baseline = this.xpBaseline.get(skill) ?? current;
      const delta = current - baseline;
      if (delta > 0) xpPerHour[skill] = Math.round(delta / hours);
    }

    const flags: string[] = [];
    // tickAligned: stddev < 30ms over ≥30 samples → near-zero variance
    if (this.tickAlignSamples.length >= 30 && tickAlignStdDevMs !== null && tickAlignStdDevMs < 30) {
      flags.push('tickAligned');
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
    // marathonSession: > 8hr session
    if (sessionMinutes >= 480) {
      flags.push('marathonSession');
    }
    // fastReaction: median < 200ms over ≥10 samples
    if (this.reactionSamples.length >= 10 && reactionMedianMs !== null && reactionMedianMs < 200) {
      flags.push('fastReaction');
    }
    // xpVelocity: any skill exceeds realistic ceiling
    for (const [skill, rate] of Object.entries(xpPerHour)) {
      const ceiling = XP_PER_HOUR_CEILING[skill];
      if (ceiling !== undefined && rate > ceiling) {
        flags.push(`xpVelocity:${skill}`);
      }
    }

    return {
      sessionMinutes,
      sessionSkillingActions: this.sessionSkillingActions,
      sessionCombatSwings: this.sessionCombatSwings,
      sessionMovements: this.sessionMovements,
      sessionChats: this.sessionChats,
      tickAlignStdDevMs,
      reactionMedianMs,
      topPathRepetition,
      xpPerHour,
      flags,
    };
  }

  /** Periodic checkpoint: write current state to DB without ending the
   *  session. Lets us survive a server crash mid-grind. Does NOT emit
   *  audit log (that's only on finalize). */
  checkpoint(db: GameDatabase, accountId: number): void {
    db.saveBotStats(accountId, this.toRow());
  }

  /** Session end (logout, or 30-min auto-checkpoint with reset). Computes
   *  the summary, writes it both to DB (overwrites last_session_summary)
   *  and to audit.log (one JSONL line). Updates totalSessionMinutes and
   *  totalFlagEvents counters. */
  finalize(db: GameDatabase, accountId: number, currentXp: Record<string, number>, tick: number): SessionSummary {
    const summary = this.computeSummary(currentXp);
    this.totalSessionMinutes += summary.sessionMinutes;
    this.totalFlagEvents += summary.flags.length;
    db.saveBotStats(accountId, this.toRow(summary));
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
