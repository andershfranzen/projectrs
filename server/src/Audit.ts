import { appendFile, appendFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';

/**
 * Append-only JSONL forensic log. Each call writes one line so partial writes
 * never corrupt previous events. The log isn't on the hot path — only
 * trade commits, deaths, rollback events, and large-quantity flows hit it.
 *
 * Why JSONL not SQLite: the audit log is grep-friendly, never queried at
 * runtime, and resilient to schema drift (fields can be added without
 * migration). If post-launch volume becomes a problem, rotate by day.
 *
 * Write buffering: events are queued in memory and flushed every FLUSH_INTERVAL
 * (or immediately when the queue reaches FLUSH_THRESHOLD entries). The first
 * implementation used `appendFileSync` per event, which blocked the event loop
 * when many simultaneous logouts hit `BotStats.finalize` at once. Buffered
 * async writes keep the tick loop responsive at the cost of losing at most
 * FLUSH_INTERVAL ms of events on hard crash. SIGINT/SIGTERM shutdown calls
 * `flushAuditSync()` so graceful exits never lose anything.
 */

const AUDIT_PATH = resolve(import.meta.dir, '../data/audit.log');
const FLUSH_INTERVAL_MS = 1000;
const FLUSH_THRESHOLD = 100;
let inited = false;
let pending: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureInit(): void {
  if (inited) return;
  try { mkdirSync(dirname(AUDIT_PATH), { recursive: true }); } catch { /* exists */ }
  // Start the periodic flush. unref() so this timer alone doesn't keep the
  // event loop alive — graceful shutdown still clears it explicitly.
  flushTimer = setInterval(flushAudit, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
  inited = true;
}

export interface AuditEvent {
  /** Short type tag. Examples: 'trade.commit', 'player.death', 'inventory.revert',
   *  'bank.large_deposit', 'xp.large_gain'. Use dot-prefix for filtering. */
  type: string;
  /** Server tick at which the event fired. */
  tick: number;
  /** Account ID of the primary actor (or 0 for system events). */
  accountId?: number;
  /** Free-form payload — keep keys stable for grep-ability. */
  details?: Record<string, unknown>;
}

/** Append one event to the audit log. Failure is logged but never throws —
 *  the audit log MUST NOT take down gameplay if disk is full or perms wrong. */
export function audit(event: AuditEvent): void {
  ensureInit();
  pending.push(JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
  if (pending.length >= FLUSH_THRESHOLD) flushAudit();
}

/** Async flush. Concatenates pending lines into a single appendFile call so
 *  N events become 1 syscall regardless of N. Errors → stderr; the queue is
 *  always cleared so a transient failure doesn't pin memory forever. */
function flushAudit(): void {
  if (pending.length === 0) return;
  const batch = pending.join('');
  pending = [];
  appendFile(AUDIT_PATH, batch, 'utf-8', (err) => {
    if (err) console.error('[audit] async write failed:', err.message);
  });
}

/** Synchronous flush — call from SIGINT/SIGTERM shutdown so the last second
 *  of events doesn't get lost. Safe to call from any context. */
export function flushAuditSync(): void {
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (pending.length === 0) return;
  const batch = pending.join('');
  pending = [];
  try {
    appendFileSync(AUDIT_PATH, batch, 'utf-8');
  } catch (e) {
    console.error('[audit] sync flush failed:', e instanceof Error ? e.message : e);
  }
}
