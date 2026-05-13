#!/usr/bin/env bun
/**
 * Bot detection review CLI.
 *
 * Reads `server/data/audit.log` (JSONL) for player.session_summary entries,
 * groups them by accountId, and prints accounts that have raised flags worth
 * a manual look. Cross-references the `login_history` SQLite table to
 * surface IP correlations — shared IPs across accounts, gold-farmer-style
 * trades from alt accounts, etc. Also reads `bot_stats` for lifetime context.
 *
 * Usage:
 *   bun tools/bot-review.ts                    # default: ≥2 flag types in last 7 days
 *   bun tools/bot-review.ts --min-flags 3      # ≥3 distinct flag types
 *   bun tools/bot-review.ts --days 30          # window
 *   bun tools/bot-review.ts --account 42       # full history for one account
 *   bun tools/bot-review.ts --ip 1.2.3.4       # all accounts ever seen on this IP
 *   bun tools/bot-review.ts --shared-ip-only   # only show accounts sharing IP w/ others
 *   bun tools/bot-review.ts --raw              # print raw JSONL of flagged sessions
 *
 * This tool does not modify any state. You decide what to do with the
 * results — chat with the player, watch them in-world, ban manually.
 */

import { readFileSync, existsSync } from 'fs';
import { Database as SQLiteDB } from 'bun:sqlite';
import { resolve } from 'path';

interface SessionSummary {
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

interface AuditLine {
  ts: string;
  type: string;
  tick: number;
  accountId?: number;
  details?: Record<string, unknown> & Partial<SessionSummary>;
}

interface AccountBucket {
  accountId: number;
  sessions: AuditLine[];
  uniqueFlags: Set<string>;
  totalFlagFires: number;
  totalMinutes: number;
}

interface LoginRow {
  id: number;
  account_id: number;
  ip_address: string;
  login_ts: number;
  logout_ts: number | null;
  session_minutes: number | null;
}

interface AccountInfo {
  username: string;
  totalSessionMinutes: number;
  totalFlagEvents: number;
  lastLoginTs: number | null;
}

const AUDIT_PATH = resolve(import.meta.dir, '../server/data/audit.log');
const DB_PATH = resolve(import.meta.dir, '../projectrs.db');

function parseArgs(): {
  minFlags: number;
  days: number;
  account: number | null;
  ip: string | null;
  sharedIpOnly: boolean;
  raw: boolean;
} {
  const args = process.argv.slice(2);
  let minFlags = 2;
  let days = 7;
  let account: number | null = null;
  let ip: string | null = null;
  let sharedIpOnly = false;
  let raw = false;
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--min-flags': minFlags = parseInt(args[++i], 10); break;
      case '--days': days = parseInt(args[++i], 10); break;
      case '--account': account = parseInt(args[++i], 10); break;
      case '--ip': ip = args[++i]; break;
      case '--shared-ip-only': sharedIpOnly = true; break;
      case '--raw': raw = true; break;
      case '--help':
      case '-h':
        console.log(`bot-review.ts — surface accounts with suspicious bot signal

Options:
  --min-flags N       only show accounts with ≥N distinct flag types (default 2)
  --days N            restrict to sessions in the last N days (default 7)
  --account ID        full history for one account
  --ip ADDR           list all accounts ever seen on this IP
  --shared-ip-only    only show accounts that share an IP with another account
  --raw               print raw JSONL of flagged sessions instead of summary
  -h, --help          this message`);
        process.exit(0);
    }
  }
  return { minFlags, days, account, ip, sharedIpOnly, raw };
}

function loadAuditLog(): AuditLine[] {
  if (!existsSync(AUDIT_PATH)) {
    console.error(`No audit log at ${AUDIT_PATH} yet. Start the server and play first.`);
    process.exit(1);
  }
  const text = readFileSync(AUDIT_PATH, 'utf-8');
  const lines: AuditLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try { lines.push(JSON.parse(raw)); } catch { console.error('[bot-review] skipped malformed audit line'); }
  }
  return lines;
}

/** Open the DB read-only. Returns null if the file doesn't exist yet. */
function openDb(): SQLiteDB | null {
  if (!existsSync(DB_PATH)) return null;
  try { return new SQLiteDB(DB_PATH, { readonly: true }); }
  catch (e) { console.error('[bot-review] DB open failed:', e instanceof Error ? e.message : e); return null; }
}

function loadAccountInfo(db: SQLiteDB, accountIds: Set<number>): Map<number, AccountInfo> {
  const map = new Map<number, AccountInfo>();
  const ids = [...accountIds];
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.query(`
    SELECT a.id, a.username, b.total_session_minutes, b.total_flag_events, b.last_login_ts
    FROM accounts a
    LEFT JOIN bot_stats b ON b.account_id = a.id
    WHERE a.id IN (${placeholders})
  `).all(...ids) as Array<{ id: number; username: string; total_session_minutes: number | null; total_flag_events: number | null; last_login_ts: number | null }>;
  for (const r of rows) {
    map.set(r.id, {
      username: r.username,
      totalSessionMinutes: r.total_session_minutes ?? 0,
      totalFlagEvents: r.total_flag_events ?? 0,
      lastLoginTs: r.last_login_ts,
    });
  }
  return map;
}

/** Collapse an IP to its /24 (IPv4) or /64 (IPv6) network prefix. Used so
 *  shared-IP correlation survives commodity IP rotation within an ISP block
 *  or a residential CGNAT pool. Exact-IP matching misses farmers who get a
 *  new lease every few hours but stay within the same /24. */
function ipNetwork(ip: string): string {
  if (ip.includes(':')) {
    // IPv6 — take the first 4 groups (/64). Pad short forms (e.g. "::1") to
    // a full 8-group expansion before slicing so the prefix is canonical.
    const groups = ip.split('::');
    let parts: string[];
    if (groups.length === 2) {
      const left = groups[0] ? groups[0].split(':') : [];
      const right = groups[1] ? groups[1].split(':') : [];
      const missing = 8 - left.length - right.length;
      parts = [...left, ...Array(missing).fill('0'), ...right];
    } else {
      parts = ip.split(':');
    }
    return parts.slice(0, 4).join(':') + '::/64';
  }
  // IPv4 — first three octets, ".0/24" suffix
  const oct = ip.split('.');
  if (oct.length !== 4) return ip;
  return `${oct[0]}.${oct[1]}.${oct[2]}.0/24`;
}

/** Heuristic VPN/proxy/datacenter sniff from PTR string. Catches commodity
 *  VPNs and obvious datacenter ASNs; clean-PTR VPNs slip through. Maintenance
 *  burden the user accepted — extend as new patterns surface. */
function vpnHint(ptr: string | null | undefined): string | null {
  if (!ptr) return null;
  const p = ptr.toLowerCase();
  const patterns = [
    'vpn', 'proxy', 'tor', 'tunnel',
    // Hosting providers commonly used for bots:
    'amazonaws', 'compute.amazon', 'googleusercontent', 'azure',
    'digitalocean', 'linode', 'vultr', 'ovh.', 'hetzner', 'contabo',
    'choopa', 'leaseweb', 'datacamp', 'mullvad', 'nordvpn', 'expressvpn',
  ];
  for (const pat of patterns) if (p.includes(pat)) return pat;
  return null;
}

/** All device IDs an account has ever used, with login counts. */
function loadAccountDevices(db: SQLiteDB, accountId: number): Map<string, number> {
  const rows = db.query(`
    SELECT device_id, COUNT(*) as n FROM login_history
    WHERE account_id = ? AND device_id != ''
    GROUP BY device_id ORDER BY n DESC
  `).all(accountId) as Array<{ device_id: string; n: number }>;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.device_id, r.n);
  return m;
}

/** Alt accounts that share at least one device_id with `accountId`. Distinct
 *  from shared-IP alts: device-correlation survives IP changes, IP-correlation
 *  survives device clearing. Both axes are surfaced separately because they
 *  catch different evader profiles. */
function loadAltsByDevice(db: SQLiteDB, accountId: number): Array<{ deviceId: string; accountId: number; username: string; logins: number }> {
  const rows = db.query(`
    SELECT lh.device_id as deviceId, lh.account_id as accountId, a.username, COUNT(*) as logins
    FROM login_history lh
    JOIN accounts a ON a.id = lh.account_id
    WHERE lh.account_id != ?
      AND lh.device_id != ''
      AND lh.device_id IN (SELECT device_id FROM login_history WHERE account_id = ? AND device_id != '')
    GROUP BY lh.device_id, lh.account_id
    ORDER BY logins DESC
  `).all(accountId, accountId) as Array<{ deviceId: string; accountId: number; username: string; logins: number }>;
  return rows;
}

/** All IPs an account has ever logged in from, with login counts + last PTR. */
function loadAccountIps(db: SQLiteDB, accountId: number): Map<string, { logins: number; ptr: string | null }> {
  const rows = db.query(`
    SELECT ip_address, COUNT(*) as n,
           (SELECT reverse_dns FROM login_history h2
            WHERE h2.account_id = ? AND h2.ip_address = login_history.ip_address
            ORDER BY h2.login_ts DESC LIMIT 1) as ptr
    FROM login_history
    WHERE account_id = ?
    GROUP BY ip_address ORDER BY n DESC
  `).all(accountId, accountId) as Array<{ ip_address: string; n: number; ptr: string | null }>;
  const m = new Map<string, { logins: number; ptr: string | null }>();
  for (const r of rows) m.set(r.ip_address, { logins: r.n, ptr: r.ptr });
  return m;
}

/** All accounts ever seen on a given IP, with login counts. */
function loadIpAccounts(db: SQLiteDB, ip: string): Array<{ accountId: number; username: string; logins: number; lastSeenTs: number | null }> {
  const rows = db.query(`
    SELECT lh.account_id as accountId, a.username, COUNT(*) as logins, MAX(lh.login_ts) as lastSeenTs
    FROM login_history lh
    JOIN accounts a ON a.id = lh.account_id
    WHERE lh.ip_address = ?
    GROUP BY lh.account_id
    ORDER BY logins DESC
  `).all(ip) as Array<{ accountId: number; username: string; logins: number; lastSeenTs: number | null }>;
  return rows;
}

/** For an account, find all alt accounts that ever shared an IP at /24 (v4)
 *  or /64 (v6) network granularity. Catches farmers rotating within an ISP
 *  block. The query joins on a computed prefix — SQLite doesn't have CIDR
 *  ops natively so we pre-compute prefixes in JS and use them as IN-clauses. */
function loadAltsForAccount(db: SQLiteDB, accountId: number): Array<{ ip: string; network: string; accountId: number; username: string; logins: number }> {
  // First pass: get this account's IPs, derive their networks.
  const ownIps = db.query(`SELECT DISTINCT ip_address FROM login_history WHERE account_id = ?`).all(accountId) as Array<{ ip_address: string }>;
  if (ownIps.length === 0) return [];
  const ownNetworks = new Set<string>();
  for (const r of ownIps) ownNetworks.add(ipNetwork(r.ip_address));

  // Second pass: pull all logins for OTHER accounts, filter to matching networks.
  const others = db.query(`
    SELECT lh.ip_address as ip, lh.account_id as accountId, a.username, COUNT(*) as logins
    FROM login_history lh
    JOIN accounts a ON a.id = lh.account_id
    WHERE lh.account_id != ?
    GROUP BY lh.ip_address, lh.account_id
  `).all(accountId) as Array<{ ip: string; accountId: number; username: string; logins: number }>;

  const matches: Array<{ ip: string; network: string; accountId: number; username: string; logins: number }> = [];
  for (const o of others) {
    const net = ipNetwork(o.ip);
    if (ownNetworks.has(net)) matches.push({ ip: o.ip, network: net, accountId: o.accountId, username: o.username, logins: o.logins });
  }
  matches.sort((a, b) => b.logins - a.logins);
  return matches;
}

/** Find trade commits where the two parties share at least one historical
 *  IP network OR device_id. Either is a strong gold-farming signal, but they
 *  catch different profiles: device match = same browser (silly), network
 *  match = same ISP block (more sophisticated). Both surface in the report. */
function findSuspiciousTrades(
  db: SQLiteDB,
  auditLines: AuditLine[],
  windowSinceMs: number,
): Array<{ trade: AuditLine; sharedNetworks: string[]; sharedDevices: string[] }> {
  const trades = auditLines.filter(l => l.type === 'trade.commit' && new Date(l.ts).getTime() >= windowSinceMs);
  const out: Array<{ trade: AuditLine; sharedNetworks: string[]; sharedDevices: string[] }> = [];
  // Cache per-account network + device sets so we don't re-query for the same
  // trader twice across multiple trades.
  const acctNetworks = new Map<number, Set<string>>();
  const acctDevices = new Map<number, Set<string>>();
  const networksFor = (id: number): Set<string> => {
    let cached = acctNetworks.get(id);
    if (cached) return cached;
    cached = new Set();
    const rows = db.query(`SELECT DISTINCT ip_address FROM login_history WHERE account_id = ?`).all(id) as Array<{ ip_address: string }>;
    for (const r of rows) cached.add(ipNetwork(r.ip_address));
    acctNetworks.set(id, cached);
    return cached;
  };
  const devicesFor = (id: number): Set<string> => {
    let cached = acctDevices.get(id);
    if (cached) return cached;
    cached = new Set();
    const rows = db.query(`SELECT DISTINCT device_id FROM login_history WHERE account_id = ? AND device_id != ''`).all(id) as Array<{ device_id: string }>;
    for (const r of rows) cached.add(r.device_id);
    acctDevices.set(id, cached);
    return cached;
  };
  for (const t of trades) {
    const d = t.details as { a?: { accountId?: number }; b?: { accountId?: number } } | undefined;
    const aId = d?.a?.accountId;
    const bId = d?.b?.accountId;
    if (aId == null || bId == null || aId === bId) continue;
    const aNets = networksFor(aId);
    const bNets = networksFor(bId);
    const aDevs = devicesFor(aId);
    const bDevs = devicesFor(bId);
    const sharedNetworks: string[] = [];
    const sharedDevices: string[] = [];
    for (const n of aNets) if (bNets.has(n)) sharedNetworks.push(n);
    for (const dv of aDevs) if (bDevs.has(dv)) sharedDevices.push(dv);
    if (sharedNetworks.length > 0 || sharedDevices.length > 0) {
      out.push({ trade: t, sharedNetworks, sharedDevices });
    }
  }
  return out;
}

function fmtTs(unixSec: number | null): string {
  return unixSec != null ? new Date(unixSec * 1000).toISOString().replace('T', ' ').slice(0, 16) : '?';
}

/** --ip path: list every account that's ever used the given IP. */
function showIpReport(db: SQLiteDB, ip: string): void {
  const accounts = loadIpAccounts(db, ip);
  if (accounts.length === 0) {
    console.log(`No login history for IP ${ip}.`);
    return;
  }
  console.log(`IP ${ip} — ${accounts.length} account(s) seen here\n`);
  for (const a of accounts) {
    console.log(`  ${a.username.padEnd(20)} (account ${a.accountId})  ${a.logins} logins  last seen ${fmtTs(a.lastSeenTs)}`);
  }
}

function main(): void {
  const opts = parseArgs();
  const db = openDb();
  if (!db) {
    console.error('No database — run the server at least once first.');
    process.exit(1);
  }

  // --ip path is a standalone query, doesn't need audit log.
  if (opts.ip) {
    showIpReport(db, opts.ip);
    db.close();
    return;
  }

  const lines = loadAuditLog();
  const cutoff = Date.now() - opts.days * 86400_000;

  const buckets: Map<number, AccountBucket> = new Map();
  for (const line of lines) {
    if (line.type !== 'player.session_summary') continue;
    if (line.accountId == null) continue;
    if (opts.account != null && line.accountId !== opts.account) continue;
    const ts = new Date(line.ts).getTime();
    if (ts < cutoff) continue;
    const details = line.details;
    const flags = (details?.flags as string[]) ?? [];
    if (flags.length === 0 && opts.account == null) continue;
    let b = buckets.get(line.accountId);
    if (!b) {
      b = { accountId: line.accountId, sessions: [], uniqueFlags: new Set(), totalFlagFires: 0, totalMinutes: 0 };
      buckets.set(line.accountId, b);
    }
    b.sessions.push(line);
    b.totalFlagFires += flags.length;
    b.totalMinutes += (details?.sessionMinutes as number) ?? 0;
    for (const f of flags) {
      const family = f.includes(':') ? f.split(':')[0] : f;
      b.uniqueFlags.add(family);
    }
  }

  let candidates: AccountBucket[] = [];
  for (const b of buckets.values()) {
    if (b.uniqueFlags.size >= opts.minFlags || opts.account != null) candidates.push(b);
  }
  candidates.sort((a, b) => b.uniqueFlags.size - a.uniqueFlags.size || b.totalFlagFires - a.totalFlagFires);

  // Apply --shared-ip-only filter: keep only candidates with ≥1 alt.
  if (opts.sharedIpOnly) {
    const filtered: AccountBucket[] = [];
    for (const c of candidates) {
      if (loadAltsForAccount(db, c.accountId).length > 0) filtered.push(c);
    }
    candidates = filtered;
  }

  if (opts.raw) {
    for (const c of candidates) for (const s of c.sessions) console.log(JSON.stringify(s));
    db.close();
    return;
  }

  if (candidates.length === 0) {
    console.log(`No accounts flagged at min-flags=${opts.minFlags} in the last ${opts.days} days${opts.sharedIpOnly ? ' (shared-IP-only)' : ''}.`);
    db.close();
    return;
  }

  const acctInfo = loadAccountInfo(db, new Set(candidates.map(c => c.accountId)));

  // Suspicious-trade detection runs once for the whole window (not per-account)
  // since the data set is small and SQL handles dedup cleanly.
  const suspiciousTrades = findSuspiciousTrades(db, lines, cutoff);

  console.log(`Bot review — ${candidates.length} account(s) flagged (window: last ${opts.days} days, min flag types: ${opts.minFlags}${opts.sharedIpOnly ? ', shared-IP-only' : ''})\n`);

  for (const c of candidates) {
    const ctx = acctInfo.get(c.accountId);
    const name = ctx?.username ?? `account#${c.accountId}`;
    console.log(`━━━ ${name} (account ${c.accountId}) ━━━`);
    if (ctx) {
      console.log(`  lifetime: ${ctx.totalSessionMinutes} min played, ${ctx.totalFlagEvents} total flag-fires`);
    }
    console.log(`  window:   ${c.sessions.length} session(s), ${c.totalMinutes} min, ${c.totalFlagFires} flag-fires, ${c.uniqueFlags.size} unique types`);
    console.log(`  flag types: ${[...c.uniqueFlags].join(', ')}`);

    // IP correlation block. Surfaces reverse-DNS hints (VPN/datacenter PTRs)
    // alongside each IP — clean residential PTRs print as-is, suspicious ones
    // get a [vpn?:foo] tag.
    const ips = loadAccountIps(db, c.accountId);
    if (ips.size > 0) {
      const top = [...ips.entries()].slice(0, 3).map(([ip, info]) => {
        const hint = vpnHint(info.ptr);
        return `${ip}(×${info.logins})${hint ? `[vpn?:${hint}]` : ''}`;
      }).join(', ');
      console.log(`  IPs:        ${top}${ips.size > 3 ? ` …+${ips.size - 3} more` : ''}`);
    }
    const alts = loadAltsForAccount(db, c.accountId);
    if (alts.length > 0) {
      // Group by alt account; each alt may have multiple shared networks.
      const altsByAcct = new Map<number, { username: string; networks: Set<string>; logins: number }>();
      for (const a of alts) {
        let row = altsByAcct.get(a.accountId);
        if (!row) {
          row = { username: a.username, networks: new Set(), logins: 0 };
          altsByAcct.set(a.accountId, row);
        }
        row.networks.add(a.network);
        row.logins += a.logins;
      }
      console.log(`  shared-network alts (${altsByAcct.size}):`);
      for (const [altId, row] of altsByAcct) {
        console.log(`    ${row.username.padEnd(20)} (account ${altId})  ${row.logins} logins  via [${[...row.networks].join(', ')}]`);
      }
    }

    // Device correlation. Independent axis from IP — different evader
    // profiles. A shared device almost always means "same physical browser"
    // (alt-tabbing, not clearing localStorage) which is the highest-signal
    // form of multi-accounting we can see.
    const devices = loadAccountDevices(db, c.accountId);
    if (devices.size > 0) {
      const top = [...devices.entries()].slice(0, 2).map(([d, n]) => `${d.slice(0, 8)}…(×${n})`).join(', ');
      console.log(`  devices:    ${top}${devices.size > 2 ? ` …+${devices.size - 2} more` : ''}`);
    }
    const deviceAlts = loadAltsByDevice(db, c.accountId);
    if (deviceAlts.length > 0) {
      const altsByAcct = new Map<number, { username: string; devices: Set<string>; logins: number }>();
      for (const a of deviceAlts) {
        let row = altsByAcct.get(a.accountId);
        if (!row) {
          row = { username: a.username, devices: new Set(), logins: 0 };
          altsByAcct.set(a.accountId, row);
        }
        row.devices.add(a.deviceId);
        row.logins += a.logins;
      }
      console.log(`  shared-device alts (${altsByAcct.size}):`);
      for (const [altId, row] of altsByAcct) {
        const devShort = [...row.devices].map(d => d.slice(0, 8) + '…').join(', ');
        console.log(`    ${row.username.padEnd(20)} (account ${altId})  ${row.logins} logins  via [${devShort}]`);
      }
    }

    const recent = c.sessions.slice(-3);
    for (const s of recent) {
      const d = s.details ?? {};
      const flags = (d.flags as string[]) ?? [];
      const tickStd = d.tickAlignStdDevMs;
      const react = d.reactionMedianMs;
      const path = d.topPathRepetition;
      const chats = d.sessionChats;
      const mins = d.sessionMinutes;
      console.log(`    ${s.ts}  ${mins}min  chats=${chats}  tickStdDev=${tickStd?.toFixed?.(0) ?? '-'}ms  reaction=${react?.toFixed?.(0) ?? '-'}ms  pathTop=${path?.toFixed?.(2) ?? '-'}  flags=[${flags.join(',')}]`);
    }
    console.log('');
  }

  // Suspicious trades section — surfaced separately because a transfer
  // implicates BOTH accounts even if only one is flagged on its own.
  if (suspiciousTrades.length > 0) {
    console.log(`━━━ Same-IP trade transfers (${suspiciousTrades.length}) ━━━`);
    console.log(`These are trades where both parties have authenticated from a shared IP.`);
    console.log(`Classic gold-farmer signature: one bot account funnels items to a main.\n`);
    for (const st of suspiciousTrades) {
      const d = st.trade.details as { a: { accountId: number; name: string; offered: Array<{ itemId: number; quantity: number }> }; b: { accountId: number; name: string; offered: Array<{ itemId: number; quantity: number }> } };
      const aOffer = d.a.offered.map(o => `${o.quantity}×i${o.itemId}`).join(', ') || '∅';
      const bOffer = d.b.offered.map(o => `${o.quantity}×i${o.itemId}`).join(', ') || '∅';
      console.log(`  ${st.trade.ts}`);
      console.log(`    ${d.a.name} (acc ${d.a.accountId})  →  ${aOffer}`);
      console.log(`    ${d.b.name} (acc ${d.b.accountId})  →  ${bOffer}`);
      if (st.sharedNetworks.length > 0) console.log(`    shared networks: ${st.sharedNetworks.join(', ')}`);
      if (st.sharedDevices.length > 0) console.log(`    shared devices:  ${st.sharedDevices.map(d => d.slice(0, 8) + '…').join(', ')}`);
      console.log('');
    }
  }

  console.log(`Tip: --ip <addr> to list everyone seen on an IP, --shared-ip-only to narrow.`);

  db.close();
}

main();
