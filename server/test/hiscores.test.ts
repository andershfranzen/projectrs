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
});
