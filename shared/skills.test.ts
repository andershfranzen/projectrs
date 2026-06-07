import { expect, test } from 'bun:test';
import { addXp, initSkills, levelFromXp, MAX_SKILL_LEVEL, MAX_SKILL_XP, normalizeSkillId, SKILL_NAMES, xpForLevel } from './skills';

test('woodcut legacy skill id resolves to Woodcutting', () => {
  expect(normalizeSkillId('woodcut')).toBe('woodcutting');
  expect(SKILL_NAMES.woodcutting).toBe('Woodcutting');
});

test('survival skill scaffold initializes and resolves by id', () => {
  const skills = initSkills();

  expect(normalizeSkillId('survival')).toBe('survival');
  expect(SKILL_NAMES.survival).toBe('Survival');
  expect(skills.survival).toEqual({ xp: 0, level: 1, currentLevel: 1 });
});

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

test('XP curve continues past 99 until the int31 cap makes level 150 the ceiling', () => {
  expect(xpForLevel(99)).toBe(13034431);
  expect(xpForLevel(100)).toBe(14391160);
  expect(xpForLevel(MAX_SKILL_LEVEL)).toBe(2033749558);
  expect(xpForLevel(MAX_SKILL_LEVEL + 1)).toBe(2245441392);
  expect(xpForLevel(MAX_SKILL_LEVEL + 1)).toBeGreaterThan(MAX_SKILL_XP);
  expect(levelFromXp(MAX_SKILL_XP)).toBe(MAX_SKILL_LEVEL);
});

test('addXp caps XP at int31 and level at the highest reachable level', () => {
  const skills = initSkills();
  skills.mining.level = MAX_SKILL_LEVEL - 1;
  skills.mining.currentLevel = MAX_SKILL_LEVEL - 1;
  skills.mining.xp = xpForLevel(MAX_SKILL_LEVEL) - 1;

  const result = addXp(skills, 'mining', MAX_SKILL_XP);

  expect(result).toEqual({ leveled: true, newLevel: MAX_SKILL_LEVEL });
  expect(skills.mining.level).toBe(MAX_SKILL_LEVEL);
  expect(skills.mining.currentLevel).toBe(MAX_SKILL_LEVEL);
  expect(skills.mining.xp).toBe(MAX_SKILL_XP);
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
