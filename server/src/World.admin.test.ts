import { describe, expect, test } from 'bun:test';
import { ALL_SKILLS, MAX_SKILL_LEVEL, MAX_SKILL_XP } from '@projectrs/shared';
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
});
