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
    const first = forwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const cfIp = req.headers.get('cf-connecting-ip')?.trim();
  if (cfIp) return cfIp;
  return null;
}

function normalizeIpForTrust(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

export function isTrustedProxyIp(ip: string): boolean {
  if (TRUSTED_LOOPBACK_IPS.has(ip)) return true;
  const normalized = normalizeIpForTrust(ip);
  if (normalized === 'localhost') return true;
  if (normalized.startsWith('10.')) return true;
  if (normalized.startsWith('192.168.')) return true;
  const match = /^172\.(\d+)\./.exec(normalized);
  return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
}
