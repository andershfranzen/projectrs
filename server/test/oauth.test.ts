import { createHash } from 'crypto';
import { describe, expect, test } from 'bun:test';
import { GameDatabase } from '../src/Database';
import { isRedirectUriAllowed, parseOAuthClients, verifyPkceS256 } from '../src/oauth';

function pkceChallenge(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

describe('OAuth PKCE support', () => {
  test('allows registered loopback redirect URI with a random port only', () => {
    const clients = parseOAuthClients(null);
    const client = clients.get('evillite');
    expect(client).toBeTruthy();

    expect(isRedirectUriAllowed(client!, 'http://127.0.0.1:49152/cb')).toBe(true);
    expect(isRedirectUriAllowed(client!, 'http://localhost:49152/cb')).toBe(true);
    expect(isRedirectUriAllowed(client!, 'http://127.0.0.1:49152/other')).toBe(false);
    expect(isRedirectUriAllowed(client!, 'https://127.0.0.1:49152/cb')).toBe(false);
  });

  test('stores authorization codes as one-time PKCE grants', () => {
    const db = new GameDatabase(':memory:');
    try {
      const account = db.loginFallbackAccount('Alice', '11111111-1111-4111-8111-111111111111');
      const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
      const challenge = pkceChallenge(verifier);
      const { code } = db.createOAuthAuthorizationCode({
        accountId: account.accountId,
        clientId: 'evillite',
        redirectUri: 'http://127.0.0.1:49152/cb',
        scopes: ['game'],
        codeChallenge: challenge,
      });

      const grant = db.consumeOAuthAuthorizationCode(code, 'evillite', 'http://127.0.0.1:49152/cb');
      expect(grant?.accountId).toBe(account.accountId);
      expect(grant?.scopes).toEqual(['game']);
      expect(verifyPkceS256(verifier, grant!.codeChallenge)).toBe(true);
      expect(verifyPkceS256(`${verifier}x`, grant!.codeChallenge)).toBe(false);
      expect(db.consumeOAuthAuthorizationCode(code, 'evillite', 'http://127.0.0.1:49152/cb')).toBeNull();
    } finally {
      db.close();
    }
  });

  test('tags OAuth sessions and rotates refresh tokens', () => {
    const db = new GameDatabase(':memory:');
    try {
      const deviceId = '11111111-1111-4111-8111-111111111111';
      const account = db.loginFallbackAccount('Alice', deviceId);
      const first = db.createOAuthSession(account.accountId, 'evillite', ['game'], deviceId);
      expect(first).toBeTruthy();
      expect(first!.expiresIn).toBe(3600);

      const firstSession = db.getSession(first!.token);
      expect(firstSession?.oauthClientId).toBe('evillite');
      expect(firstSession?.oauthScopes).toEqual(['game']);

      const refreshInfo = db.getOAuthRefreshTokenInfo(first!.refreshToken, 'evillite');
      expect(refreshInfo?.accountId).toBe(account.accountId);

      const second = db.refreshOAuthSession(first!.refreshToken, 'evillite', deviceId);
      expect(second).toBeTruthy();
      expect(second!.refreshToken).not.toBe(first!.refreshToken);
      expect(db.getOAuthRefreshTokenInfo(first!.refreshToken, 'evillite')).toBeNull();
      expect(db.getSession(first!.token)).toBeNull();
      expect(db.getSession(second!.token)?.oauthClientId).toBe('evillite');

      db.revokeOAuthToken(second!.refreshToken);
      expect(db.getOAuthRefreshTokenInfo(second!.refreshToken, 'evillite')).toBeNull();
      db.revokeOAuthToken(second!.token);
      expect(db.getSession(second!.token)).toBeNull();
    } finally {
      db.close();
    }
  });

  test('game-scoped OAuth sessions do not inherit staff privileges', async () => {
    const db = new GameDatabase(':memory:');
    try {
      const deviceId = '11111111-1111-4111-8111-111111111111';
      const created = await db.createAccount('mogn', 'password123', deviceId);
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(db.getSession(created.token)?.isAdmin).toBe(true);

      const oauth = db.createOAuthSession(created.accountId, 'evillite', ['game'], deviceId);
      expect(oauth).toBeTruthy();
      const session = db.getSession(oauth!.token);
      expect(session?.oauthClientId).toBe('evillite');
      expect(session?.oauthScopes).toEqual(['game']);
      expect(session?.isAdmin).toBe(false);
      expect(session?.isModerator).toBe(false);
    } finally {
      db.close();
    }
  });
});
