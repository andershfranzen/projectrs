import '@babylonjs/core/Culling/ray';
import { describe, expect, test } from 'bun:test';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { createGroundItemPickProxy, positionGroundItemPickProxy } from './GroundItemPickProxy';
import {
  GROUND_ITEM_PICKBOX_CENTER_Y,
  GROUND_ITEM_PICKBOX_DEPTH,
  GROUND_ITEM_PICKBOX_HEIGHT,
  GROUND_ITEM_PICKBOX_WIDTH,
} from './pickingConstants';

describe('ground item pick proxy', () => {
  test('uses a fixed invisible pickable box', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const camera = new FreeCamera('camera', new Vector3(0, 2, -4), scene);
    camera.setTarget(new Vector3(0, GROUND_ITEM_PICKBOX_CENTER_Y, 0));
    scene.activeCamera = camera;

    const proxy = createGroundItemPickProxy(scene, 'ground_item_proxy', 0, 0, 0, 123);
    scene.render();

    const box = proxy.getBoundingInfo().boundingBox;
    expect(proxy.isVisible).toBe(true);
    expect(proxy.visibility).toBe(0);
    expect(proxy.isPickable).toBe(true);
    expect(proxy.metadata).toEqual({ kind: 'groundItem', groundItemId: 123 });
    expect(proxy.position.asArray()).toEqual([0, GROUND_ITEM_PICKBOX_CENTER_Y, 0]);
    expect(box.extendSize.x).toBeCloseTo(GROUND_ITEM_PICKBOX_WIDTH / 2, 5);
    expect(box.extendSize.y).toBeCloseTo(GROUND_ITEM_PICKBOX_HEIGHT / 2, 5);
    expect(box.extendSize.z).toBeCloseTo(GROUND_ITEM_PICKBOX_DEPTH / 2, 5);
    expect(scene.pick(engine.getRenderWidth() / 2, engine.getRenderHeight() / 2)?.pickedMesh).toBe(proxy);

    positionGroundItemPickProxy(proxy, 4.5, 1.25, -2.5);
    expect(proxy.position.asArray()).toEqual([4.5, 1.25 + GROUND_ITEM_PICKBOX_CENTER_Y, -2.5]);

    scene.dispose();
    engine.dispose();
  });
});
