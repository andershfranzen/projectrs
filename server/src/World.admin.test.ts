import { describe, expect, test } from 'bun:test';
import { ALL_SKILLS, MAX_SKILL_LEVEL, MAX_SKILL_XP, xpForLevel } from '@projectrs/shared';
import { World } from './World';
import { Player } from './entity/Player';

function makePlayer(name: string): Player {
  return new Player(name, 5.5, 5.5, {} as any, 1);
}

describe('admin stat helpers', () => {
  test('maxPlayerStats sets every skill to the highest reachable level and XP cap', () => {
    const player = makePlayer('admin');
    let skillSyncs = 0;
    let saves = 0;
    const world: any = Object.create(World.prototype);
    world.sendSkills = (target: Player) => {
      expect(target).toBe(player);
      skillSyncs++;
    };
    world.savePlayerState = (target: Player) => {
      expect(target).toBe(player);
      saves++;
    };

    world.maxPlayerStats(player);

    for (const skillId of ALL_SKILLS) {
      expect(player.skills[skillId]).toEqual({ xp: MAX_SKILL_XP, level: MAX_SKILL_LEVEL, currentLevel: MAX_SKILL_LEVEL });
    }
    expect(player.health).toBe(MAX_SKILL_LEVEL);
    expect(player.maxHealth).toBe(MAX_SKILL_LEVEL);
    expect(player.syncDirty).toBe(true);
    expect(skillSyncs).toBe(1);
    expect(saves).toBe(1);
  });

  test('setPlayerSkillLevel lowers a maxed skill to the requested level floor', () => {
    const player = makePlayer('admin');
    player.skills.roguery = { xp: MAX_SKILL_XP, level: MAX_SKILL_LEVEL, currentLevel: MAX_SKILL_LEVEL };
    let skillSyncs = 0;
    let saves = 0;
    const world: any = Object.create(World.prototype);
    world.sendSkills = (target: Player) => {
      expect(target).toBe(player);
      skillSyncs++;
    };
    world.savePlayerState = (target: Player) => {
      expect(target).toBe(player);
      saves++;
    };

    const result = world.setPlayerSkillLevel(player, 'roguery', 42);

    expect(result).toEqual({ level: 42, xp: xpForLevel(42) });
    expect(player.skills.roguery).toEqual({ xp: xpForLevel(42), level: 42, currentLevel: 42 });
    expect(player.syncDirty).toBe(true);
    expect(skillSyncs).toBe(1);
    expect(saves).toBe(1);
  });

  test('setPlayerSkillXp derives level from XP and syncs lowered hitpoints', () => {
    const player = makePlayer('admin');
    player.skills.hitpoints = { xp: MAX_SKILL_XP, level: MAX_SKILL_LEVEL, currentLevel: MAX_SKILL_LEVEL };
    player.syncHealthFromSkills();
    let skillSyncs = 0;
    let saves = 0;
    const world: any = Object.create(World.prototype);
    world.sendSkills = (target: Player) => {
      expect(target).toBe(player);
      skillSyncs++;
    };
    world.savePlayerState = (target: Player) => {
      expect(target).toBe(player);
      saves++;
    };

    const result = world.setPlayerSkillXp(player, 'hitpoints', xpForLevel(7));

    expect(result).toEqual({ level: 7, xp: xpForLevel(7) });
    expect(player.skills.hitpoints).toEqual({ xp: xpForLevel(7), level: 7, currentLevel: 7 });
    expect(player.maxHealth).toBe(7);
    expect(player.health).toBe(7);
    expect(player.syncDirty).toBe(true);
    expect(skillSyncs).toBe(1);
    expect(saves).toBe(1);
  });
});
