import { describe, expect, test } from 'bun:test';
import { GameDatabase } from '../src/Database';

const expectedStarterInventory = [
  { itemId: 31, quantity: 1 },
  { itemId: 33, quantity: 1 },
  { itemId: 67, quantity: 1 },
  { itemId: 58, quantity: 1 },
  { itemId: 231, quantity: 1 },
  { itemId: 231, quantity: 1 },
  { itemId: 231, quantity: 1 },
  { itemId: 10, quantity: 30 },
];

describe('starter inventory', () => {
  test('new accounts start with tools, basic combat gear, food, and coins', () => {
    const db = new GameDatabase(':memory:');
    try {
      const session = db.loginFallbackAccount('starter-kit-test');
      const state = db.loadPlayerState(session.accountId);

      expect(state?.inventory).toEqual(expectedStarterInventory);
    } finally {
      db.close();
    }
  });
});
