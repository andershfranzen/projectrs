import { describe, expect, test } from 'bun:test';
import { ALL_SKILLS, xpForLevel } from '@projectrs/shared';
import { World } from './World';
import { Player } from './entity/Player';

function makePlayer(name: string): Player {
  return new Player(name, 5.5, 5.5, {} as any, 1);
}

describe('admin stat helpers', () => {
  test('maxPlayerStats sets every skill to exact level-99 XP and persists', () => {
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

    const maxXp = xpForLevel(99);
    for (const skillId of ALL_SKILLS) {
      expect(player.skills[skillId]).toEqual({ xp: maxXp, level: 99, currentLevel: 99 });
    }
    expect(player.health).toBe(99);
    expect(player.maxHealth).toBe(99);
    expect(player.syncDirty).toBe(true);
    expect(skillSyncs).toBe(1);
    expect(saves).toBe(1);
  });
});
