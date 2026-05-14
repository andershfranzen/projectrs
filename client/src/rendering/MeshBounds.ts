import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';

/** Axis-aligned bounding box of a set of meshes in world space. Empty meshes
 *  (zero vertices — common for GLB __root__ transform nodes) are skipped.
 *  Each mesh's world matrix is refreshed first so callers get accurate bounds
 *  for newly-loaded GLBs whose transforms haven't been evaluated yet. */
export interface WorldAABB {
  minX: number; maxX: number;
  minY: number; maxY: number;
  minZ: number; maxZ: number;
}

export function worldAABB(meshes: ReadonlyArray<AbstractMesh>): WorldAABB {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const mesh of meshes) {
    if (mesh.getTotalVertices() === 0) continue;
    mesh.computeWorldMatrix(true);
    const bb = mesh.getBoundingInfo().boundingBox;
    if (bb.minimumWorld.x < minX) minX = bb.minimumWorld.x;
    if (bb.maximumWorld.x > maxX) maxX = bb.maximumWorld.x;
    if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
    if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y;
    if (bb.minimumWorld.z < minZ) minZ = bb.minimumWorld.z;
    if (bb.maximumWorld.z > maxZ) maxZ = bb.maximumWorld.z;
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}
