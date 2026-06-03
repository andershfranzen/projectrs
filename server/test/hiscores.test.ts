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
  test('maps legacy accuracy saves and hiscore categories to weaponry', () => {
    const db = new GameDatabase(':memory:');
    try {
      const account = db.loginFallbackAccount('LegacyFighter');
      const legacyXp = xpForLevel(20);
      (db as any).db.query('UPDATE player_state SET skills = ? WHERE account_id = ?')
        .run(JSON.stringify({
          accuracy: { level: 20, currentLevel: 19, xp: legacyXp },
        }), account.accountId);

      const state = db.loadPlayerState(account.accountId);
      expect(state?.skills.weaponry.level).toBe(20);
      expect(state?.skills.weaponry.currentLevel).toBe(19);
      expect(state?.skills.weaponry.xp).toBe(legacyXp);

      const hiscores = db.getHiscores('accuracy');
      expect(hiscores.category.id).toBe('weaponry');
      expect(hiscores.category.name).toBe('Weaponry');
      expect(hiscores.rows[0]?.username).toBe('legacyfighter');
    } finally {
      db.close();
    }
  });

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

  test('omits admins from public rankings but keeps direct profiles visible', () => {
    const db = new GameDatabase(':memory:');
    try {
      const admin = db.loginFallbackAccount('AdminMiner');
      const visible = db.loginFallbackAccount('VisibleMiner');
      (db as any).db.query('UPDATE accounts SET is_admin = 1 WHERE id = ?').run(admin.accountId);
      db.savePlayerState(admin.accountId, playerWithSkills(miningSkills(90)), 0);
      db.savePlayerState(visible.accountId, playerWithSkills(miningSkills(30)), 0);
      for (let i = 0; i < 9; i++) db.recordMobKill(admin.accountId, 100);
      for (let i = 0; i < 2; i++) db.recordMobKill(visible.accountId, 100);

      const mining = db.getHiscores('mining');
      expect(mining.rows.map((row) => row.username.toLowerCase())).not.toContain('adminminer');
      expect(mining.rows[0]?.username).toBe('visibleminer');

      const search = db.getHiscores('overall', 25, 1, 'AdminMiner');
      expect(search.rows).toHaveLength(0);

      const kills = db.getMobKillHiscores(100, 25, 1, '', [{ id: 100, name: 'Vampire' }]);
      expect(kills.rows.map((row) => row.username.toLowerCase())).not.toContain('adminminer');
      expect(kills.rows.map((row) => [row.rank, row.username, row.kills])).toEqual([[1, 'visibleminer', 2]]);

      const profile = db.getHiscoreProfile('AdminMiner', [{ id: 100, name: 'Vampire' }]);
      expect(profile?.username).toBe('adminminer');
      const miningProfile = profile?.rows.find((row) => row.category.id === 'mining');
      expect(miningProfile?.rank).toBe(0);
      expect(miningProfile?.level).toBe(90);
      expect(profile?.monsterKills.find((row) => row.npcDefId === 100)).toMatchObject({ rank: 0, kills: 9 });
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

describe('hiscores sorting', () => {
  test('sorts skill rankings before slicing paginated results', () => {
    const db = new GameDatabase(':memory:');
    try {
      const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Zulu'];
      names.forEach((name, index) => {
        const account = db.loginFallbackAccount(name);
        db.savePlayerState(account.accountId, playerWithSkills(miningSkills(10 + index)), 0);
      });

      const pageOne = db.getHiscores('mining', 5, 1, '', 'username', 'desc');
      const pageTwo = db.getHiscores('mining', 5, 2, '', 'username', 'desc');

      expect(pageOne.rows.map((row) => row.username)).toEqual(['zulu', 'foxtrot', 'echo', 'delta', 'charlie']);
      expect(pageTwo.rows.map((row) => row.username)).toEqual(['bravo', 'alpha']);
    } finally {
      db.close();
    }
  });

  test('sorts monster kill rankings before slicing paginated results', () => {
    const db = new GameDatabase(':memory:');
    try {
      const names = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Zulu'];
      names.forEach((name, index) => {
        const account = db.loginFallbackAccount(name);
        for (let i = 0; i <= index; i++) db.recordMobKill(account.accountId, 100);
      });

      const pageOne = db.getMobKillHiscores(100, 5, 1, '', [{ id: 100, name: 'Vampire' }], 'username', 'desc');
      const pageTwo = db.getMobKillHiscores(100, 5, 2, '', [{ id: 100, name: 'Vampire' }], 'username', 'desc');

      expect(pageOne.rows.map((row) => row.username)).toEqual(['zulu', 'foxtrot', 'echo', 'delta', 'charlie']);
      expect(pageTwo.rows.map((row) => row.username)).toEqual(['bravo', 'alpha']);
    } finally {
      db.close();
    }
  });
});

describe('mob kill hiscores', () => {
  const MOBS = [
    { id: 1, name: 'Chicken' },
    { id: 100, name: 'Vampire' },
  ];

  test('ranks players by kills of the selected mob, ignoring other mobs', () => {
    const db = new GameDatabase(':memory:');
    try {
      const alice = db.loginFallbackAccount('Alice');
      const bob = db.loginFallbackAccount('Bob');

      // Alice: 5 vampires, 1 chicken. Bob: 3 vampires, 9 chickens.
      for (let i = 0; i < 5; i++) db.recordMobKill(alice.accountId, 100);
      db.recordMobKill(alice.accountId, 1);
      for (let i = 0; i < 3; i++) db.recordMobKill(bob.accountId, 100);
      for (let i = 0; i < 9; i++) db.recordMobKill(bob.accountId, 1);

      const vampire = db.getMobKillHiscores(100, 25, 1, '', MOBS);
      expect(vampire.mobName).toBe('Vampire');
      expect(vampire.rows.map((r) => [r.rank, r.username, r.kills])).toEqual([
        [1, 'alice', 5],
        [2, 'bob', 3],
      ]);

      const chicken = db.getMobKillHiscores(1, 25, 1, '', MOBS);
      expect(chicken.rows.map((r) => [r.rank, r.username, r.kills])).toEqual([
        [1, 'bob', 9],
        [2, 'alice', 1],
      ]);
    } finally {
      db.close();
    }
  });

  test('defaults to the first mob (name-sorted) when none/invalid is requested', () => {
    const db = new GameDatabase(':memory:');
    try {
      const alice = db.loginFallbackAccount('Alice');
      db.recordMobKill(alice.accountId, 1);
      // MOBS sorted by name -> Chicken (id 1) first.
      expect(db.getMobKillHiscores(null, 25, 1, '', MOBS).npcDefId).toBe(1);
      expect(db.getMobKillHiscores(999, 25, 1, '', MOBS).npcDefId).toBe(1);
    } finally {
      db.close();
    }
  });

  test('excludes banned and anti-bot test accounts from the kill leaderboard', () => {
    const db = new GameDatabase(':memory:');
    try {
      const tester = db.loginFallbackAccount('Blackberry');
      const banned = db.loginFallbackAccount('BannedHunter');
      const visible = db.loginFallbackAccount('VisibleHunter');
      for (let i = 0; i < 50; i++) db.recordMobKill(tester.accountId, 100);
      for (let i = 0; i < 40; i++) db.recordMobKill(banned.accountId, 100);
      for (let i = 0; i < 2; i++) db.recordMobKill(visible.accountId, 100);
      db.banAccount(banned.accountId, 'botting', 'test-admin', Math.floor(Date.now() / 1000) + 3600);

      const vampire = db.getMobKillHiscores(100, 25, 1, '', MOBS);
      const names = vampire.rows.map((r) => r.username.toLowerCase());
      expect(names).not.toContain('blackberry');
      expect(names).not.toContain('bannedhunter');
      expect(vampire.rows.map((r) => [r.rank, r.username, r.kills])).toEqual([[1, 'visiblehunter', 2]]);
    } finally {
      db.close();
    }
  });
});
