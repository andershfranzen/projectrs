import { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import {
  GROUND_ITEM_PICKBOX_CENTER_Y,
  GROUND_ITEM_PICKBOX_DEPTH,
  GROUND_ITEM_PICKBOX_HEIGHT,
  GROUND_ITEM_PICKBOX_WIDTH,
} from './pickingConstants';

export function positionGroundItemPickProxy(proxy: Mesh, x: number, y: number, z: number): void {
  proxy.unfreezeWorldMatrix();
  proxy.position.set(x, y + GROUND_ITEM_PICKBOX_CENTER_Y, z);
  proxy.freezeWorldMatrix();
}

export function createGroundItemPickProxy(
  scene: Scene,
  name: string,
  x: number,
  y: number,
  z: number,
  groundItemId: number,
): Mesh {
  const proxy = MeshBuilder.CreateBox(name, {
    width: GROUND_ITEM_PICKBOX_WIDTH,
    depth: GROUND_ITEM_PICKBOX_DEPTH,
    height: GROUND_ITEM_PICKBOX_HEIGHT,
  }, scene);

  proxy.isVisible = true;
  proxy.visibility = 0;
  proxy.isPickable = true;
  proxy.alwaysSelectAsActiveMesh = true;
  proxy.layerMask = 0;
  proxy.metadata = { kind: 'groundItem', groundItemId };
  positionGroundItemPickProxy(proxy, x, y, z);
  return proxy;
}
