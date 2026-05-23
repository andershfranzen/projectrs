import { describe, expect, test } from 'bun:test';
import { initSkills, xpForLevel, type SkillBlock } from '@projectrs/shared';
import { GameDatabase } from '../src/Database';
import type { Player } from '../src/entity/Player';

function playerWithSkills(skills: SkillBlock): Player {
  return {
    position: { x: 96.5, y: 96.5 },
    currentFloor: 0,
    currentMapLevel: 'kcmap',
    skills,
    inventory: [],
    equipment: new Map(),
    stance: 'accurate',
    appearance: null,
    bank: [],
    quests: {},
    renown: 0,
  } as unknown as Player;
}

function miningSkills(level: number): SkillBlock {
  const skills = initSkills();
  skills.mining = {
    level,
    currentLevel: level,
    xp: xpForLevel(level),
  };
  return skills;
}

describe('hiscores exclusions', () => {
  test('omits the anti-bot testing account from public rankings and profiles', () => {
    const db = new GameDatabase(':memory:');
    try {
      const tester = db.loginFallbackAccount('Blackberry');
      db.loginFallbackAccount('Alice');
      db.savePlayerState(tester.accountId, playerWithSkills(miningSkills(50)), 0);

      const mining = db.getHiscores('mining');
      expect(mining.rows.map((row) => row.username.toLowerCase())).not.toContain('blackberry');
      expect(mining.rows[0]?.username).toBe('alice');
      expect(mining.categories.find((category) => category.id === 'mining')?.hasXp).toBe(false);

      const search = db.getHiscores('overall', 25, 1, 'blackberry');
      expect(search.rows).toHaveLength(0);
      expect(search.totalRows).toBe(0);

      expect(db.getHiscoreProfile('Blackberry')).toBeNull();
      expect(db.getHiscoreProfile('alice')?.username).toBe('alice');
    } finally {
      db.close();
    }
  });

  test('omits actively banned accounts from public rankings and profiles', () => {
    const db = new GameDatabase(':memory:');
    try {
      const banned = db.loginFallbackAccount('BannedMiner');
      const visible = db.loginFallbackAccount('VisibleMiner');
      db.savePlayerState(banned.accountId, playerWithSkills(miningSkills(80)), 0);
      db.savePlayerState(visible.accountId, playerWithSkills(miningSkills(20)), 0);
      db.banAccount(banned.accountId, 'botting', 'test-admin', Math.floor(Date.now() / 1000) + 3600);

      const mining = db.getHiscores('mining');
      expect(mining.rows.map((row) => row.username.toLowerCase())).not.toContain('bannedminer');
      expect(mining.rows[0]?.username).toBe('visibleminer');

      const search = db.getHiscores('overall', 25, 1, 'BannedMiner');
      expect(search.rows).toHaveLength(0);
      expect(db.getHiscoreProfile('BannedMiner')).toBeNull();
    } finally {
      db.close();
    }
  });

  test('expired account bans do not hide hiscores', () => {
    const db = new GameDatabase(':memory:');
    try {
      const player = db.loginFallbackAccount('ReturnedMiner');
      db.savePlayerState(player.accountId, playerWithSkills(miningSkills(30)), 0);
      db.banAccount(player.accountId, 'expired', 'test-admin', Math.floor(Date.now() / 1000) - 60);

      expect(db.isAccountBanned(player.accountId)).toBeNull();
      expect(db.getHiscores('mining').rows.map((row) => row.username)).toContain('returnedminer');
      expect(db.getHiscoreProfile('ReturnedMiner')?.username).toBe('returnedminer');
    } finally {
      db.close();
    }
  });
});
