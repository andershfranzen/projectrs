import { describe, expect, test } from 'bun:test';
import { GameDatabase } from '../src/Database';
import { isTrustedProxyIp, requestClientIp } from '../src/network/clientIp';

describe('session WebSocket binding', () => {
  test('stores a per-session cookie secret alongside the auth token', () => {
    const db = new GameDatabase(':memory:');
    try {
      const first = db.loginFallbackAccount('Alice', '11111111-1111-4111-8111-111111111111');

      expect(first.token).toHaveLength(64);
      expect(first.wsSecret).toHaveLength(64);
      expect(first.wsSecret).not.toBe(first.token);

      const session = db.getSession(first.token);
      expect(session?.accountId).toBe(first.accountId);
      expect(session?.deviceId).toBe('11111111-1111-4111-8111-111111111111');
      expect(session?.wsSecret).toBe(first.wsSecret);
      expect(db.getSessionByWsSecret(first.wsSecret)?.accountId).toBe(first.accountId);
      expect(db.ensureSessionWsSecret(first.token)).toBe(first.wsSecret);

      const second = db.loginFallbackAccount('Alice', '11111111-1111-4111-8111-111111111111');
      expect(db.getSession(first.token)).toBeNull();
      expect(db.getSessionByWsSecret(first.wsSecret)).toBeNull();
      expect(second.wsSecret).toHaveLength(64);
      expect(second.wsSecret).not.toBe(first.wsSecret);
    } finally {
      db.close();
    }
  });

	  test('stores device public keys by account and browser device', async () => {
    const db = new GameDatabase(':memory:');
    try {
      const deviceId = '11111111-1111-4111-8111-111111111111';
      const session = db.loginFallbackAccount('Alice', deviceId);
      const keyPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify'],
      ) as CryptoKeyPair;
      const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

      db.saveDeviceKey(session.accountId, deviceId, publicJwk);
      expect(db.loadDeviceKey(session.accountId, deviceId)).toEqual(publicJwk);
      expect(db.loadDeviceKey(session.accountId, '22222222-2222-4222-8222-222222222222')).toBeNull();
    } finally {
      db.close();
    }
	  });

  test('trusts forwarded client IPs only from local or private reverse proxies', () => {
    const fromDockerBridge = new Request('https://evilquest.net/ws/game', {
      headers: { 'x-forwarded-for': '198.51.100.42, 172.18.0.1' },
    });
    const fromPublicPeer = new Request('https://evilquest.net/ws/game', {
      headers: { 'x-forwarded-for': '198.51.100.99' },
    });

    expect(isTrustedProxyIp('::ffff:172.18.0.1')).toBe(true);
    expect(requestClientIp(fromDockerBridge, { requestIP: () => ({ address: '::ffff:172.18.0.1' }) })).toBe('198.51.100.42');
    expect(requestClientIp(fromPublicPeer, { requestIP: () => ({ address: '203.0.113.9' }) })).toBe('203.0.113.9');
  });
});
