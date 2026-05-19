import { describe, expect, test } from 'bun:test';
import { extractWsToken, isAllowedWsOrigin, parseAllowedOrigins } from '../src/network/WsSecurity';

describe('WebSocket security helpers', () => {
  test('allows only configured browser origins', () => {
    const allowed = parseAllowedOrigins('https://evilquest.net, https://www.evilquest.net');
    const req = new Request('https://evilquest.net/ws/game', {
      headers: { origin: 'https://evilquest.net' },
    });
    const hostile = new Request('https://evilquest.net/ws/game', {
      headers: { origin: 'https://bot.example' },
    });

    expect(isAllowedWsOrigin(req, { allowedOrigins: allowed, nodeEnv: 'production' })).toBe(true);
    expect(isAllowedWsOrigin(hostile, { allowedOrigins: allowed, nodeEnv: 'production' })).toBe(false);
  });

  test('rejects missing Origin in production but allows it in dev', () => {
    const req = new Request('http://localhost:4000/ws/game');

    expect(isAllowedWsOrigin(req, { nodeEnv: 'production' })).toBe(false);
    expect(isAllowedWsOrigin(req, { nodeEnv: 'development' })).toBe(true);
  });

  test('extracts subprotocol auth token and rejects query token by default', () => {
    const url = new URL('http://localhost:4000/ws/game?token=query-token');
    const req = new Request(url, {
      headers: { 'sec-websocket-protocol': 'chat, auth.header-token' },
    });
    const queryOnly = new Request(url);

    expect(extractWsToken(req, url)).toBe('header-token');
    expect(extractWsToken(queryOnly, url)).toBe(null);
    expect(extractWsToken(queryOnly, url, { allowQueryToken: true })).toBe('query-token');
  });
});
