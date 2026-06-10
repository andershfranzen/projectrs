import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
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

export function worldAABBForMaterials(
  meshes: ReadonlyArray<AbstractMesh>,
  materialNames: ReadonlySet<string>,
): WorldAABB | null {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  const point = new Vector3();
  const include = (x: number, y: number, z: number): void => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };

  for (const mesh of meshes) {
    const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
    if (!positions) continue;
    const indices = mesh.getIndices();
    const world = mesh.computeWorldMatrix(true);
    for (const subMesh of mesh.subMeshes ?? []) {
      const materialName = subMesh.getMaterial()?.name?.toLowerCase();
      if (!materialName || !materialNames.has(materialName)) continue;
      if (indices && subMesh.indexCount > 0) {
        const end = subMesh.indexStart + subMesh.indexCount;
        for (let i = subMesh.indexStart; i < end; i++) {
          const vertex = indices[i] * 3;
          Vector3.TransformCoordinatesFromFloatsToRef(
            positions[vertex],
            positions[vertex + 1],
            positions[vertex + 2],
            world,
            point,
          );
          include(point.x, point.y, point.z);
        }
      } else {
        const end = subMesh.verticesStart + subMesh.verticesCount;
        for (let i = subMesh.verticesStart; i < end; i++) {
          const vertex = i * 3;
          Vector3.TransformCoordinatesFromFloatsToRef(
            positions[vertex],
            positions[vertex + 1],
            positions[vertex + 2],
            world,
            point,
          );
          include(point.x, point.y, point.z);
        }
      }
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)) return null;
  return { minX, maxX, minY, maxY, minZ, maxZ };
}
