import { describe, expect, test } from 'bun:test';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { resolveDeathPortalFoot } from './DeathPortalEffect';

describe('death portal effect placement', () => {
  test('uses the render root X/Z while preserving the gameplay ground Y', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const root = new TransformNode('large_npc_root', scene);
    root.position.set(11.5, 2.8, 21.5);

    const target = {
      position: new Vector3(10.5, 0.25, 20.5),
      getTargetAnchor: () => new Vector3(11.5, 1.4, 21.5),
    };

    const foot = resolveDeathPortalFoot(target, root);

    expect(foot.x).toBe(11.5);
    expect(foot.y).toBe(0.25);
    expect(foot.z).toBe(21.5);

    scene.dispose();
    engine.dispose();
  });
});
