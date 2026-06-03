import { describe, expect, test } from 'bun:test';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { EntityManager } from './EntityManager';

function makeFakeNpcSprite(x: number, z: number): any {
  return {
    position: new Vector3(x, 0, z),
    walking: false,
    isWalking() { return this.walking; },
    startWalking() { this.walking = true; },
    stopWalking() { this.walking = false; },
    updateMovementDirection() {},
    setPositionXYZ(nx: number, ny: number, nz: number) {
      this.position.set(nx, ny, nz);
    },
  };
}

describe('EntityManager NPC interpolation', () => {
  test('fresh final NPC steps use normal one-tile-per-tick speed', () => {
    const manager = Object.create(EntityManager.prototype) as EntityManager;
    const sprite = makeFakeNpcSprite(10.5, 10.5);
    (manager as any).getHeight = () => 0;
    (manager as any).npcSprites = new Map([[1, sprite]]);
    (manager as any).npcTargets = new Map([[
      1,
      {
        x: 11.5,
        z: 10.5,
        floor: 0,
        y: 0,
        prevX: 10.5,
        prevZ: 10.5,
        t: performance.now(),
        continueWalking: false,
      },
    ]]);
    (manager as any).npcCombatTargets = new Map();
    (manager as any).remotePlayers = new Map();

    manager.interpolateNpcs(0.3, null, -1, null);

    expect(sprite.position.x).toBeCloseTo(11.0, 5);
    expect(sprite.position.z).toBe(10.5);
    expect(sprite.isWalking()).toBe(true);
  });
});
