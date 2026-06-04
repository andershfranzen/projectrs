import { Scene } from '@babylonjs/core/scene';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { MeshParticleEmitter } from '@babylonjs/core/Particles/EmitterTypes/meshParticleEmitter';
import type { Observer } from '@babylonjs/core/Misc/observable';

const MESH_SHIMMER_SLOTS = new Set(['weapon', 'head']);
const ANCHORED_SHIMMER_SLOTS = new Set(['shield', 'body', 'legs']);

type AnchoredShimmer = {
  offset: Vector3;
  position: Vector3;
  particles: ParticleSystem;
};

type AnchorProvider = () => Vector3 | null;

const particleTextureCache = new WeakMap<Scene, DynamicTexture>();

function makeParticleTexture(scene: Scene): DynamicTexture {
  const cached = particleTextureCache.get(scene);
  if (cached && cached.getInternalTexture()) return cached;

  const size = 16;
  const tex = new DynamicTexture('hq_gear_sparkle_particle', size, scene, false, Texture.NEAREST_SAMPLINGMODE);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fillRect(7, 2, 2, 12);
  ctx.fillRect(2, 7, 12, 2);
  ctx.fillStyle = 'rgba(255,232,132,0.92)';
  ctx.fillRect(6, 6, 4, 4);
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fillRect(7, 7, 2, 2);
  tex.update();
  tex.hasAlpha = true;
  tex.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
  particleTextureCache.set(scene, tex);
  return tex;
}

function particleMeshes(meshes: AbstractMesh[]): AbstractMesh[] {
  return [...meshes]
    .filter(mesh => !mesh.isDisposed() && mesh.getTotalVertices() > 0)
    .sort((a, b) => b.getTotalVertices() - a.getTotalVertices())
    .slice(0, 3);
}

function createMeshParticles(scene: Scene, meshes: AbstractMesh[], slot: string): ParticleSystem[] {
  const selected = particleMeshes(meshes);
  const systems: ParticleSystem[] = [];
  for (let i = 0; i < selected.length; i++) {
    const mesh = selected[i];
    const ps = new ParticleSystem(`hq_${slot}_mesh_shimmer_${i}`, 36, scene);
    const emitter = new MeshParticleEmitter(mesh);
    emitter.useMeshNormalsForDirection = false;
    emitter.direction1 = new Vector3(-0.006, -0.006, -0.006);
    emitter.direction2 = new Vector3(0.006, 0.006, 0.006);
    ps.particleEmitterType = emitter;
    ps.emitter = mesh;
    ps.particleTexture = makeParticleTexture(scene);
    ps.isLocal = true;
    ps.color1 = new Color4(1, 0.92, 0.36, 0.68);
    ps.color2 = new Color4(0.72, 0.96, 1, 0.42);
    ps.colorDead = new Color4(1, 0.78, 0.24, 0);
    ps.minSize = 0.016;
    ps.maxSize = 0.040;
    ps.minLifeTime = 0.22;
    ps.maxLifeTime = 0.50;
    ps.emitRate = Math.max(2.4, 7.2 / selected.length);
    ps.minEmitPower = 0;
    ps.maxEmitPower = 0.002;
    ps.gravity = Vector3.Zero();
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.updateSpeed = 0.016;
    ps.start();
    systems.push(ps);
  }
  return systems;
}

function anchoredShimmerHalfExtents(slot: string): Vector3 {
  if (slot === 'shield') return new Vector3(0.12, 0.12, 0.10);
  if (slot === 'legs') return new Vector3(0.11, 0.16, 0.09);
  return new Vector3(0.13, 0.15, 0.10);
}

function anchoredShimmerOffsets(slot: string): Vector3[] {
  if (slot === 'shield') {
    return [
      new Vector3(0, 0, 0),
      new Vector3(0.04, 0.03, 0.02),
    ];
  }
  if (slot === 'legs') {
    return [
      new Vector3(-0.07, 0.05, 0),
      new Vector3(0.07, 0, 0),
      new Vector3(0, -0.07, 0.02),
    ];
  }
  return [
    new Vector3(-0.08, 0.07, 0),
    new Vector3(0.08, 0.02, 0.02),
    new Vector3(0, -0.06, -0.02),
  ];
}

function updateAnchoredShimmer(shimmer: AnchoredShimmer, slot: string, getAnchor: AnchorProvider | undefined): void {
  const anchor = getAnchor?.();
  if (!anchor) return;
  shimmer.position.copyFrom(anchor).addInPlace(shimmer.offset);
  const half = anchoredShimmerHalfExtents(slot);
  shimmer.particles.minEmitBox = half.scale(-1);
  shimmer.particles.maxEmitBox = half;
}

function createAnchoredShimmerParticles(
  scene: Scene,
  slot: string,
  getAnchor: AnchorProvider | undefined,
): AnchoredShimmer[] {
  const shimmers: AnchoredShimmer[] = [];
  const offsets = anchoredShimmerOffsets(slot);
  for (let i = 0; i < offsets.length; i++) {
    const position = Vector3.Zero();
    const ps = new ParticleSystem(`hq_${slot}_anchored_shimmer_${i}`, 36, scene);
    ps.emitter = position;
    ps.particleTexture = makeParticleTexture(scene);
    ps.color1 = new Color4(1, 0.92, 0.36, 0.68);
    ps.color2 = new Color4(0.72, 0.96, 1, 0.42);
    ps.colorDead = new Color4(1, 0.78, 0.24, 0);
    ps.minSize = 0.016;
    ps.maxSize = 0.040;
    ps.minLifeTime = 0.22;
    ps.maxLifeTime = 0.50;
    ps.emitRate = Math.max(2.4, 7.2 / offsets.length);
    ps.minEmitPower = 0;
    ps.maxEmitPower = 0.002;
    ps.direction1 = new Vector3(-0.006, -0.006, -0.006);
    ps.direction2 = new Vector3(0.006, 0.006, 0.006);
    ps.gravity = Vector3.Zero();
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.updateSpeed = 0.016;
    const shimmer = { offset: offsets[i], position, particles: ps };
    updateAnchoredShimmer(shimmer, slot, getAnchor);
    ps.start();
    shimmers.push(shimmer);
  }
  return shimmers;
}

export class HighQualityGearEffect {
  private readonly particles: ParticleSystem[];
  private readonly anchoredShimmers: AnchoredShimmer[];
  private readonly observer: Observer<Scene> | null;
  private readonly slot: string;
  private readonly getAnchor: AnchorProvider | undefined;

  constructor(
    scene: Scene,
    _root: unknown,
    meshes: AbstractMesh[],
    slot: string,
    itemId: number,
    getAnchor?: AnchorProvider,
  ) {
    void itemId;
    this.particles = MESH_SHIMMER_SLOTS.has(slot) ? createMeshParticles(scene, meshes, slot) : [];
    this.anchoredShimmers = ANCHORED_SHIMMER_SLOTS.has(slot) ? createAnchoredShimmerParticles(scene, slot, getAnchor) : [];
    this.slot = slot;
    this.getAnchor = getAnchor;
    this.observer = this.anchoredShimmers.length > 0 ? scene.onBeforeRenderObservable.add(() => this.update()) : null;
  }

  private update(): void {
    if (this.anchoredShimmers.length === 0) return;
    for (const shimmer of this.anchoredShimmers) {
      updateAnchoredShimmer(shimmer, this.slot, this.getAnchor);
    }
  }

  dispose(scene: Scene): void {
    if (this.observer) scene.onBeforeRenderObservable.remove(this.observer);
    for (const ps of this.particles) ps.dispose(false);
    for (const shimmer of this.anchoredShimmers) {
      shimmer.particles.dispose(false);
    }
  }
}
