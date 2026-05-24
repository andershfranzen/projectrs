import { describe, expect, test } from 'bun:test';
import { GameDatabase } from '../src/Database';

describe('friends and ignore persistence', () => {
  test('stores friends and ignore lists by account and keeps targets canonical', () => {
    const db = new GameDatabase(':memory:');
    try {
      const alice = db.loginFallbackAccount('Alice');
      const bob = db.loginFallbackAccount('Bob');
      db.loginFallbackAccount('Carol');

      const addFriend = db.addSocialRelation(alice.accountId, 'BOB', 'friends');
      expect(addFriend.ok).toBe(true);
      expect(db.listSocialRelations(alice.accountId).friends).toEqual([
        { accountId: bob.accountId, username: 'bob' },
      ]);
      expect(db.isIgnoring(alice.accountId, bob.accountId)).toBe(false);

      const addIgnore = db.addSocialRelation(alice.accountId, 'bob', 'ignore');
      expect(addIgnore.ok).toBe(true);
      expect(db.listSocialRelations(alice.accountId).friends).toEqual([]);
      expect(db.listSocialRelations(alice.accountId).ignore).toEqual([
        { accountId: bob.accountId, username: 'bob' },
      ]);
      expect(db.isIgnoring(alice.accountId, bob.accountId)).toBe(true);

      expect(db.removeSocialRelation(alice.accountId, 'bob', 'ignore').ok).toBe(true);
      expect(db.listSocialRelations(alice.accountId).ignore).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('rejects unknown targets and self-relations', () => {
    const db = new GameDatabase(':memory:');
    try {
      const alice = db.loginFallbackAccount('Alice');

      expect(db.addSocialRelation(alice.accountId, 'missing', 'friends').ok).toBe(false);
      expect(db.addSocialRelation(alice.accountId, 'alice', 'friends').ok).toBe(false);
      expect(db.addSocialRelation(alice.accountId, 'alice', 'ignore').ok).toBe(false);
    } finally {
      db.close();
    }
  });
});
