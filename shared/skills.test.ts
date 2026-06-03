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

test('hitpoints level-up adds gained max hp without full healing', () => {
  const skills = initSkills();
  skills.hitpoints.currentLevel = 4;
  skills.hitpoints.xp = xpForLevel(11) - 1;

  const result = addXp(skills, 'hitpoints', 1);

  expect(result).toEqual({ leveled: true, newLevel: 11 });
  expect(skills.hitpoints.level).toBe(11);
  expect(skills.hitpoints.currentLevel).toBe(5);
  expect(skills.hitpoints.xp).toBe(xpForLevel(11));
});

test('combat auto hitpoints level-up does not full heal', () => {
  const skills = initSkills();
  skills.hitpoints.currentLevel = 4;
  skills.hitpoints.xp = xpForLevel(11) - 1;

  addXp(skills, 'strength', 3);

  expect(skills.hitpoints.level).toBe(11);
  expect(skills.hitpoints.currentLevel).toBe(5);
  expect(skills.hitpoints.xp).toBe(xpForLevel(11));
});
