export const DEFAULT_ALLOWED_WS_ORIGINS = [
  'http://localhost:4000', 'http://127.0.0.1:4000',
  'http://localhost:5173', 'http://127.0.0.1:5173',
  'http://localhost:5174', 'http://127.0.0.1:5174',
] as const;

interface WsSecurityOptions {
  allowedOrigins?: Iterable<string>;
  clientOriginsEnv?: string | null;
  nodeEnv?: string | null;
  allowMissingOrigin?: boolean;
  allowQueryToken?: boolean;
}

export function parseAllowedOrigins(raw?: string | null, fallback: readonly string[] = DEFAULT_ALLOWED_WS_ORIGINS): Set<string> {
  const origins = raw?.split(',').map((s) => s.trim()).filter(Boolean);
  return new Set(origins && origins.length > 0 ? origins : fallback);
}

export function isProductionLike(nodeEnv: string | null | undefined = process.env.NODE_ENV): boolean {
  const env = (nodeEnv ?? '').trim().toLowerCase();
  return env === 'production' || env === 'prod';
}

export function isAllowedWsOrigin(req: Request, opts: WsSecurityOptions = {}): boolean {
  const origin = req.headers.get('origin');
  const allowedOrigins = new Set(opts.allowedOrigins ?? parseAllowedOrigins(opts.clientOriginsEnv ?? process.env.CLIENT_ORIGINS));
  if (!origin) {
    if (opts.allowMissingOrigin !== undefined) return opts.allowMissingOrigin;
    if (process.env.ALLOW_MISSING_WS_ORIGIN === '1') return true;
    return !isProductionLike(opts.nodeEnv);
  }
  return allowedOrigins.has(origin);
}

export function extractWsToken(req: Request, url: URL, opts: WsSecurityOptions = {}): string | null {
  const proto = req.headers.get('sec-websocket-protocol');
  if (proto) {
    for (const raw of proto.split(',')) {
      const v = raw.trim();
      if (v.startsWith('auth.')) return v.slice(5);
    }
  }
  if (opts.allowQueryToken || process.env.ALLOW_WS_QUERY_TOKEN === '1') {
    return url.searchParams.get('token');
  }
  return null;
}

export function wsAcceptHeaders(req: Request): Record<string, string> | undefined {
  const proto = req.headers.get('sec-websocket-protocol');
  if (!proto) return undefined;
  for (const raw of proto.split(',')) {
    const v = raw.trim();
    if (v.startsWith('auth.')) return { 'Sec-WebSocket-Protocol': v };
  }
  return undefined;
}

export function readCookie(req: Request, name: string): string {
  const cookie = req.headers.get('cookie') ?? '';
  for (const part of cookie.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (rawKey === name) {
      const value = rawValue.join('=') || '';
      try { return decodeURIComponent(value); } catch { return value; }
    }
  }
  return '';
}

export function hasMatchingCookie(req: Request, name: string, expectedValue: string): boolean {
  return expectedValue.length > 0 && readCookie(req, name) === expectedValue;
}
