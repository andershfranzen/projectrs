import type { Scene } from '@babylonjs/core/scene';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';

type MeshInternals = AbstractMesh & { _isWorldMatrixFrozen?: boolean };
type AnimationGroupInternals = {
  name: string;
  isPlaying: boolean;
  targetedAnimations: unknown[];
  _animatables?: unknown[];
};

export function bucketName(name: string | undefined): string {
  const value = name || '<unnamed>';
  const placed = /^(placed)_-?\d+,-?\d+_\d+_(.+)$/.exec(value);
  if (placed) return `${placed[1]}_*_${placed[2]}`.slice(0, 56);
  const thin = /^(thin)_-?\d+,-?\d+_(.+)$/.exec(value);
  if (thin) return `${thin[1]}_*_${thin[2]}`.slice(0, 56);
  const npc = /^(npc3dsrc)_(.+)_\d+_(.+)$/.exec(value);
  if (npc) return `${npc[1]}_${npc[2]}_*_${npc[3]}`.slice(0, 56);
  return value
    .replace(/_[0-9]+_[0-9]+.*/, '_*')
    .replace(/_[0-9]+$/, '_*')
    .slice(0, 56);
}

function grouped(meshes: readonly AbstractMesh[], limit = 30): Array<{ name: string; count: number; vertices: number; indices: number }> {
  const counts = new Map<string, { count: number; vertices: number; indices: number }>();
  for (const mesh of meshes) {
    const key = bucketName(mesh.name);
    const prev = counts.get(key) ?? { count: 0, vertices: 0, indices: 0 };
    prev.count++;
    prev.vertices += mesh.getTotalVertices?.() ?? 0;
    prev.indices += mesh.getTotalIndices?.() ?? 0;
    counts.set(key, prev);
  }
  return Array.from(counts, ([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.vertices - a.vertices || b.indices - a.indices || b.count - a.count)
    .slice(0, limit);
}

function groupedPlacedChunks(meshes: readonly AbstractMesh[], limit = 30): Array<{ chunk: string; count: number }> {
  const counts = new Map<string, number>();
  for (const mesh of meshes) {
    const match = /^(?:placed|thin)_(-?\d+,-?\d+)_/.exec(mesh.name);
    if (!match) continue;
    const chunk = match[1];
    counts.set(chunk, (counts.get(chunk) ?? 0) + 1);
  }
  return Array.from(counts, ([chunk, count]) => ({ chunk, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function buildSceneBudget(scene: Scene) {
  const meshes = scene.meshes;
  const activeMeshes = scene.getActiveMeshes().data.filter(Boolean) as AbstractMesh[];
  const enabledMeshes = meshes.filter(mesh => mesh.isEnabled());
  const disabledMeshes = meshes.filter(mesh => !mesh.isEnabled());
  const pickableMeshes = meshes.filter(mesh => mesh.isPickable);
  const activePickableMeshes = activeMeshes.filter(mesh => mesh.isPickable);

  return {
    summary: {
      meshes: meshes.length,
      activeMeshes: activeMeshes.length,
      enabledMeshes: enabledMeshes.length,
      pickableMeshes: pickableMeshes.length,
      activePickableMeshes: activePickableMeshes.length,
      frozenWorldMatrices: meshes.filter(mesh => (mesh as MeshInternals)._isWorldMatrixFrozen).length,
      doNotSyncBoundingInfo: meshes.filter(mesh => mesh.doNotSyncBoundingInfo).length,
      transformNodes: scene.transformNodes.length,
      materials: scene.materials.length,
      textures: scene.textures.length,
      skeletons: scene.skeletons.length,
      animationGroups: scene.animationGroups.length,
      activeAnimatables: scene._activeAnimatables?.length ?? 0,
      playingAnimationGroups: scene.animationGroups.filter(group => group.isPlaying).length,
      particleSystems: scene.particleSystems.length,
    },
    activeByName: grouped(activeMeshes),
    enabledByName: grouped(enabledMeshes),
    disabledByName: grouped(disabledMeshes),
    enabledNotFrozenByName: grouped(enabledMeshes.filter(mesh => !(mesh as MeshInternals)._isWorldMatrixFrozen)),
    enabledPlacedByChunk: groupedPlacedChunks(enabledMeshes),
    activePlacedByChunk: groupedPlacedChunks(activeMeshes),
    pickableByName: grouped(pickableMeshes),
    activePickableByName: grouped(activePickableMeshes),
    playingAnimationGroups: scene.animationGroups
      .filter(group => group.isPlaying)
      .map(group => {
        const g = group as unknown as AnimationGroupInternals;
        return {
          name: g.name,
          targetedAnimations: g.targetedAnimations.length,
          animatables: g._animatables?.length ?? 0,
        };
      })
      .sort((a, b) => b.animatables - a.animatables || b.targetedAnimations - a.targetedAnimations)
      .slice(0, 30),
  };
}

export function logSceneBudget(scene: Scene): void {
  const budget = buildSceneBudget(scene);
  console.groupCollapsed('[SceneBudget]', budget.summary);
  console.table(budget.enabledByName);
  console.table(budget.enabledPlacedByChunk);
  console.table(budget.activeByName);
  console.table(budget.activePlacedByChunk);
  console.table(budget.enabledNotFrozenByName);
  console.table(budget.pickableByName);
  console.table(budget.playingAnimationGroups);
  console.groupEnd();
}
