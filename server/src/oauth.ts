import { createHash } from 'crypto';

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
}

export interface OAuthAuthorizeParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state: string;
  scope: string;
}

export interface OAuthAuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes: string[];
  scopeText: string;
}

export const DEFAULT_OAUTH_CLIENTS: OAuthClient[] = [
  {
    id: 'evillite',
    name: 'EvilLite',
    redirectUris: [
      'http://127.0.0.1/cb',
      'http://localhost/cb',
    ],
    scopes: ['game'],
  },
  {
    id: 'evillite-dev',
    name: 'EvilLite Dev',
    redirectUris: [
      'http://127.0.0.1/cb',
      'http://localhost/cb',
    ],
    scopes: ['game'],
  },
];

const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!PKCE_VERIFIER_RE.test(codeVerifier) || !PKCE_CHALLENGE_RE.test(codeChallenge)) return false;
  const digest = createHash('sha256').update(codeVerifier).digest();
  return base64Url(digest) === codeChallenge;
}

export function isRedirectUriAllowed(client: OAuthClient, redirectUri: string): boolean {
  let requested: URL;
  try {
    requested = new URL(redirectUri);
  } catch {
    return false;
  }
  if (requested.protocol !== 'http:' && requested.protocol !== 'https:') return false;
  for (const rawAllowed of client.redirectUris) {
    let allowed: URL;
    try {
      allowed = new URL(rawAllowed);
    } catch {
      continue;
    }
    const sameShape = requested.protocol === allowed.protocol
      && requested.hostname === allowed.hostname
      && requested.pathname === allowed.pathname
      && requested.search === allowed.search
      && requested.hash === '';
    if (!sameShape) continue;
    if (requested.href === allowed.href) return true;
    if (isLoopbackHost(allowed.hostname) && isLoopbackHost(requested.hostname) && allowed.port === '') {
      const port = requested.port ? Number(requested.port) : 0;
      return Number.isInteger(port) && port >= 1 && port <= 65535;
    }
  }
  return false;
}

export function parseOAuthClients(raw: string | undefined | null): Map<string, OAuthClient> {
  const clients = new Map<string, OAuthClient>();
  let source: unknown = DEFAULT_OAUTH_CLIENTS;
  if (raw && raw.trim()) {
    try {
      source = JSON.parse(raw);
    } catch {
      source = DEFAULT_OAUTH_CLIENTS;
    }
  }
  const rows = Array.isArray(source) ? source : DEFAULT_OAUTH_CLIENTS;
  for (const entry of rows) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id;
    const redirectUris = Array.isArray(row.redirectUris) ? row.redirectUris.filter((value): value is string => typeof value === 'string') : [];
    const scopes = Array.isArray(row.scopes) ? row.scopes.filter((value): value is string => typeof value === 'string') : [];
    if (!id || redirectUris.length === 0 || scopes.length === 0) continue;
    clients.set(id, { id, name, redirectUris, scopes });
  }
  if (clients.size === 0) {
    for (const client of DEFAULT_OAUTH_CLIENTS) clients.set(client.id, client);
  }
  return clients;
}

function parseScopeList(scope: string, client: OAuthClient): string[] | null {
  const requested = scope.trim() ? scope.trim().split(/\s+/) : client.scopes.slice(0, 1);
  const unique = [...new Set(requested)];
  if (unique.some((value) => !client.scopes.includes(value))) return null;
  return unique;
}

export function validateOAuthAuthorizeParams(
  params: OAuthAuthorizeParams,
  clients: Map<string, OAuthClient>,
): { ok: true; request: OAuthAuthorizeRequest } | { ok: false; error: string; description: string } {
  if (params.responseType !== 'code') {
    return { ok: false, error: 'unsupported_response_type', description: 'Only response_type=code is supported.' };
  }
  const client = clients.get(params.clientId);
  if (!client) {
    return { ok: false, error: 'unauthorized_client', description: 'Unknown OAuth client.' };
  }
  if (!isRedirectUriAllowed(client, params.redirectUri)) {
    return { ok: false, error: 'invalid_request', description: 'Redirect URI is not registered for this client.' };
  }
  if (params.codeChallengeMethod !== 'S256') {
    return { ok: false, error: 'invalid_request', description: 'PKCE code_challenge_method must be S256.' };
  }
  if (!PKCE_CHALLENGE_RE.test(params.codeChallenge)) {
    return { ok: false, error: 'invalid_request', description: 'PKCE code_challenge is missing or invalid.' };
  }
  if (!params.state || params.state.length > 512) {
    return { ok: false, error: 'invalid_request', description: 'A state parameter is required.' };
  }
  const scopes = parseScopeList(params.scope, client);
  if (!scopes) {
    return { ok: false, error: 'invalid_scope', description: 'Requested scope is not allowed for this client.' };
  }
  return {
    ok: true,
    request: {
      client,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes,
      scopeText: scopes.join(' '),
    },
  };
}
