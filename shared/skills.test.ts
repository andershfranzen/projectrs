import { expect, test } from 'bun:test';
import { addXp, initSkills, xpForLevel } from './skills';

test('addXp preserves admin-granted levels when saved XP is below the level floor', () => {
  const skills = initSkills();
  skills.evilmagic.level = 15;
  skills.evilmagic.currentLevel = 15;
  skills.evilmagic.xp = 0;

  const result = addXp(skills, 'evilmagic', 4);

  expect(result).toEqual({ leveled: false, newLevel: 15 });
  expect(skills.evilmagic.level).toBe(15);
  expect(skills.evilmagic.currentLevel).toBe(15);
  expect(skills.evilmagic.xp).toBe(xpForLevel(15) + 4);
});

test('addXp still levels normally from coherent XP state', () => {
  const skills = initSkills();
  skills.mining.xp = xpForLevel(2) - 1;

  const result = addXp(skills, 'mining', 1);

  expect(result).toEqual({ leveled: true, newLevel: 2 });
  expect(skills.mining.level).toBe(2);
  expect(skills.mining.currentLevel).toBe(2);
  expect(skills.mining.xp).toBe(xpForLevel(2));
});
