import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import type { Material } from '@babylonjs/core/Materials/material';

/**
 * Rebind a set of skinned meshes from their source skeleton onto a target
 * skeleton by matching bone names. Used by:
 *   1. CharacterEntity.attachSkinnedArmor — equip a piece of skinned armor on
 *      the live player character.
 *   2. ThumbnailRenderer.bindToDonor — render an armor GLB against a hidden
 *      donor skeleton so the bind pose drives the mesh instead of collapsing.
 *
 * The shared work is: (a) build a name-based bone-index translation table,
 * (b) rewrite each mesh's `MatricesIndicesKind`/`MatricesIndicesExtraKind`
 * vertex buffer through that table, (c) swap `mesh.skeleton`, (d) reparent
 * under the target's armature with identity transform. Per-use-case bits
 * (visibility toggles, slot tracking, material recompile, bbox refresh) ride
 * on optional flags.
 */

export interface RebindOptions {
  /** Skip the rebind when fewer than this many source bones match by name. */
  minMatchedBones?: number;
  /** Skip the rebind when matched/total bone ratio is below this. */
  minMatchRatio?: number;
  /** After swap, force a shader recompile on each unique material so the
   *  `BonesPerMesh` shader define reflects the target's bone count. Required
   *  for the thumbnail donor binding — without it, indexing into the larger
   *  donor uniform overflows and the mesh renders invisible. */
  forceMaterialRecompile?: boolean;
  /** Refresh `mesh.boundingInfo` with `applySkeleton: true` so the bbox
   *  reflects the posed (skinned) silhouette, not the unskinned authoring
   *  positions. Needed by ThumbnailRenderer's bbox-based camera framing. */
  refreshBoundsWithSkeleton?: boolean;
  /** Dispose the source skeleton after rebinding (it has no remaining owners). */
  disposeSourceSkeleton?: boolean;
  /** Log a warning when one or more source bones have no name match in target. */
  warnOnUnmapped?: boolean;
}

export interface RebindResult {
  /** Meshes that were successfully rebound (zero-vertex meshes are filtered). */
  meshes: AbstractMesh[];
  /** Number of source bones that matched a target bone by name. */
  matched: number;
  total: number;
  /** Source bones with no match — their vertex indices were pinned to bone 0. */
  unmapped: number;
  /** False if the match thresholds blocked the rebind. `meshes` is empty. */
  applied: boolean;
}

export function remapSkinningToSkeleton(
  meshes: AbstractMesh[],
  sourceSkeleton: Skeleton,
  targetSkeleton: Skeleton,
  targetArmature: TransformNode,
  opts: RebindOptions = {},
): RebindResult {
  const total = sourceSkeleton.bones.length;
  let matched = 0;
  for (const b of sourceSkeleton.bones) {
    if (targetSkeleton.bones.some((db) => db.name === b.name)) matched++;
  }
  const minBones = opts.minMatchedBones ?? 0;
  const minRatio = opts.minMatchRatio ?? 0;
  if (matched < minBones || matched / Math.max(total, 1) < minRatio) {
    return { meshes: [], matched, total, unmapped: total - matched, applied: false };
  }

  const remap = new Int32Array(total);
  let unmapped = 0;
  for (let i = 0; i < total; i++) {
    const name = sourceSkeleton.bones[i].name;
    const idx = targetSkeleton.bones.findIndex((b) => b.name === name);
    if (idx < 0) { remap[i] = 0; unmapped++; }
    else remap[i] = idx;
  }
  if (opts.warnOnUnmapped && unmapped > 0) {
    console.warn(`[skinnedArmor] ${unmapped}/${total} source bone(s) had no match in target skeleton`);
  }

  const remapBuf = (data: Float32Array | number[]): Float32Array => {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const src = data[i] | 0;
      out[i] = src >= 0 && src < remap.length ? remap[src] : 0;
    }
    return out;
  };

  const kept: AbstractMesh[] = [];
  const materialsToRecompile = opts.forceMaterialRecompile ? new Set<Material>() : null;

  for (const mesh of meshes) {
    if (mesh.getTotalVertices() === 0) continue;

    const indices = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
    if (indices) mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, remapBuf(indices), true);
    const indicesExtra = mesh.getVerticesData(VertexBuffer.MatricesIndicesExtraKind);
    if (indicesExtra) mesh.setVerticesData(VertexBuffer.MatricesIndicesExtraKind, remapBuf(indicesExtra), true);

    if (mesh.skeleton === sourceSkeleton) mesh.skeleton = targetSkeleton;
    mesh.parent = targetArmature;
    mesh.rotationQuaternion = null;
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    mesh.scaling.set(1, 1, 1);

    if (materialsToRecompile && mesh.material) materialsToRecompile.add(mesh.material);
    if (opts.refreshBoundsWithSkeleton) {
      mesh.refreshBoundingInfo({ applySkeleton: true, applyMorph: false });
    }
    kept.push(mesh);
  }

  if (materialsToRecompile) {
    for (const mat of materialsToRecompile) mat.markAsDirty(0xFFFFFFFF);
  }
  if (opts.disposeSourceSkeleton) sourceSkeleton.dispose();

  return { meshes: kept, matched, total, unmapped, applied: true };
}
