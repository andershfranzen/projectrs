export interface RequestIpResolver {
  requestIP(req: Request): { address: string } | null;
}

const TRUSTED_LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function requestClientIp(req: Request, srv: RequestIpResolver): string {
  const directIp = srv.requestIP(req)?.address ?? '';
  if (isTrustedProxyIp(directIp)) {
    const forwarded = forwardedClientIp(req);
    if (forwarded) return forwarded;
  }
  return directIp || 'unknown';
}

function forwardedClientIp(req: Request): string | null {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // Walk the XFF chain from the right (closest hop our proxy appended) and
    // pick the first entry that is NOT itself a trusted proxy. The attacker
    // controls the left-most entries, so trusting them allows IP spoofing.
    const hops = forwardedFor.split(',').map((s) => s.trim()).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i]!;
      if (!isTrustedProxyIp(hop)) {
        return isValidIp(hop) ? hop : null;
      }
    }
    // Whole chain is trusted proxies — fall back to the rightmost entry.
    const last = hops[hops.length - 1];
    if (last && isValidIp(last)) return last;
  }
  const realIp = req.headers.get('x-real-ip')?.trim();
  if (realIp && isValidIp(realIp)) return realIp;
  const cfIp = req.headers.get('cf-connecting-ip')?.trim();
  if (cfIp && isValidIp(cfIp)) return cfIp;
  return null;
}

// Basic syntactic IPv4/IPv6 shape check. Not a full validator — just enough to
// reject obviously malformed header values before they reach ban/rate-limit keys.
function isValidIp(ip: string): boolean {
  const value = normalizeIpForTrust(ip);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (v4) {
    return v4.slice(1).every((octet) => Number(octet) <= 255);
  }
  // IPv6: hex groups separated by ':', optional '::' compression.
  return /^[0-9a-fA-F:]+$/.test(value) && value.includes(':');
}

// Explicit trusted-proxy allowlist from TRUSTED_PROXY_IPS (comma-separated
// IPs/CIDRs). When set, ONLY these peers are trusted as proxies; the private-
// range fallback is disabled so production can be locked down.
let trustedProxyEntriesCache: { raw: string | undefined; entries: TrustedProxyEntry[] } | null = null;

interface TrustedProxyEntry {
  ip: string;
  prefix: number | null;
}

function trustedProxyEntries(): TrustedProxyEntry[] | null {
  const raw = process.env.TRUSTED_PROXY_IPS;
  if (!raw || !raw.trim()) return null;
  if (trustedProxyEntriesCache && trustedProxyEntriesCache.raw === raw) {
    return trustedProxyEntriesCache.entries;
  }
  const entries: TrustedProxyEntry[] = [];
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const [ip, bits] = token.split('/');
    const prefix = bits !== undefined ? Number(bits) : null;
    entries.push({ ip: normalizeIpForTrust(ip!.trim()), prefix: Number.isFinite(prefix) ? prefix : null });
  }
  trustedProxyEntriesCache = { raw, entries };
  return entries;
}

function ipMatchesAllowlistEntry(ip: string, entry: TrustedProxyEntry): boolean {
  if (entry.prefix === null) return ip === entry.ip;
  // CIDR match for IPv4 only; IPv6 CIDRs fall back to exact match.
  const ipParts = ip.split('.');
  const entryParts = entry.ip.split('.');
  if (ipParts.length !== 4 || entryParts.length !== 4) return ip === entry.ip;
  const ipNum = ipParts.reduce((acc, octet) => (acc << 8) | (Number(octet) & 0xff), 0) >>> 0;
  const entryNum = entryParts.reduce((acc, octet) => (acc << 8) | (Number(octet) & 0xff), 0) >>> 0;
  const mask = entry.prefix === 0 ? 0 : (0xffffffff << (32 - entry.prefix)) >>> 0;
  return (ipNum & mask) === (entryNum & mask);
}

function normalizeIpForTrust(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

export function isTrustedProxyIp(ip: string): boolean {
  const normalized = normalizeIpForTrust(ip);
  // When an explicit allowlist is configured, trust ONLY those peers. This
  // disables the private-range fallback so production deployments can lock down
  // which hops are allowed to set X-Forwarded-For.
  const allowlist = trustedProxyEntries();
  if (allowlist) {
    return allowlist.some((entry) => ipMatchesAllowlistEntry(normalized, entry));
  }
  // Dev default (no allowlist set): trust loopback + RFC1918 private ranges.
  if (TRUSTED_LOOPBACK_IPS.has(ip)) return true;
  if (normalized === 'localhost') return true;
  if (normalized.startsWith('10.')) return true;
  if (normalized.startsWith('192.168.')) return true;
  const match = /^172\.(\d+)\./.exec(normalized);
  return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
}
