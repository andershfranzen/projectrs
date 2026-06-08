import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { Observer } from '@babylonjs/core/Misc/observable';
import type { Targetable } from './Targetable';

import '@babylonjs/core/Meshes/Builders/discBuilder';
import '@babylonjs/core/Meshes/Builders/torusBuilder';
import '@babylonjs/core/Meshes/Builders/cylinderBuilder';

type DeathEffectTarget = Targetable & {
  dispose?: () => void;
  hideHealthBar?: () => void;
  hideChatBubble?: () => void;
  setLabel?: (text: string) => void;
  stopWalking?: () => void;
  getRoot?: () => TransformNode | null;
  getMesh?: () => Mesh | AbstractMesh | null;
};

interface DeathPortalEffectOpts {
  durationMs?: number;
  onDone?: () => void;
}

const DEFAULT_DURATION_MS = 1250;
const RIM_SPIKE_COUNT = 12;
const particleTextureCache = new WeakMap<Scene, DynamicTexture>();

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - clamp01(t), 3);
}

function easeInCubic(t: number): number {
  const x = clamp01(t);
  return x * x * x;
}

function makeParticleTexture(scene: Scene): DynamicTexture {
  const cached = particleTextureCache.get(scene);
  if (cached && cached.getInternalTexture()) return cached;

  const size = 64;
  const tex = new DynamicTexture('death_portal_ember_particle', size, scene, false);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  const glow = ctx.createRadialGradient(c, c, 0, c, c, size / 2);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.16, 'rgba(255,213,89,0.95)');
  glow.addColorStop(0.42, 'rgba(255,75,22,0.72)');
  glow.addColorStop(0.72, 'rgba(90,0,0,0.28)');
  glow.addColorStop(1, 'rgba(10,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  tex.update();
  particleTextureCache.set(scene, tex);
  return tex;
}

function makeMaterial(scene: Scene, name: string, color: Color3, alpha: number): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = color.scale(0.35);
  mat.emissiveColor = color;
  mat.specularColor = Color3.Black();
  mat.disableLighting = true;
  mat.alpha = alpha;
  mat.backFaceCulling = false;
  return mat;
}

function getTargetNode(target: DeathEffectTarget): TransformNode | AbstractMesh | null {
  return target.getRoot?.() ?? target.getMesh?.() ?? null;
}

export function resolveDeathPortalFoot(target: Targetable, node: TransformNode | AbstractMesh | null = null): Vector3 {
  const foot = target.position.clone();
  if (!node || node.isDisposed()) return foot;

  node.computeWorldMatrix(true);
  const renderOrigin = node.getAbsolutePosition();
  foot.x = renderOrigin.x;
  foot.z = renderOrigin.z;
  return foot;
}

export class DeathPortalEffect {
  static play(scene: Scene, target: DeathEffectTarget, opts: DeathPortalEffectOpts = {}): void {
    const node = getTargetNode(target);
    const foot = resolveDeathPortalFoot(target, node);
    target.stopWalking?.();
    target.hideChatBubble?.();
    target.setLabel?.('');
    new ActiveDeathPortal(scene, foot, node, opts);
  }

  static playAt(scene: Scene, foot: Vector3, opts: DeathPortalEffectOpts = {}): void {
    new ActiveDeathPortal(scene, foot.clone(), null, opts);
  }
}

class ActiveDeathPortal {
  private root: TransformNode;
  private scorch: Mesh;
  private core: Mesh;
  private ringA: Mesh;
  private ringB: Mesh;
  private rimSpikes: Mesh[] = [];
  private spikeBaseScales: Vector3[] = [];
  private spikePhases: number[] = [];
  private scorchMat: StandardMaterial;
  private coreMat: StandardMaterial;
  private ringMat: StandardMaterial;
  private sparkMat: StandardMaterial;
  private spikeMat: StandardMaterial;
  private smokeParticles: ParticleSystem;
  private sparkParticles: ParticleSystem;
  private observer: Observer<Scene> | null = null;
  private startMs = performance.now();
  private lastMs = this.startMs;
  private baseScale: Vector3 | null = null;
  private basePosition: Vector3 | null = null;
  private done = false;

  constructor(
    private scene: Scene,
    foot: Vector3,
    private targetNode: TransformNode | AbstractMesh | null,
    private opts: DeathPortalEffectOpts,
  ) {
    this.root = new TransformNode('death_portal_root', scene);
    this.root.position.set(foot.x, foot.y + 0.035, foot.z);

    this.scorchMat = makeMaterial(scene, 'death_portal_scorch_mat', new Color3(0.12, 0.005, 0), 0.38);
    this.coreMat = makeMaterial(scene, 'death_portal_core_mat', new Color3(0.005, 0, 0), 0.92);
    this.ringMat = makeMaterial(scene, 'death_portal_ring_mat', new Color3(0.9, 0.035, 0), 0.94);
    this.sparkMat = makeMaterial(scene, 'death_portal_ember_mat', new Color3(1, 0.34, 0.025), 0.9);
    this.spikeMat = makeMaterial(scene, 'death_portal_rim_spike_mat', new Color3(0.58, 0.01, 0), 0.96);

    this.scorch = MeshBuilder.CreateDisc('death_portal_scorch', { radius: 0.48, tessellation: 48 }, scene);
    this.scorch.parent = this.root;
    this.scorch.position.y = -0.002;
    this.scorch.rotation.x = Math.PI / 2;
    this.scorch.isPickable = false;
    this.scorch.material = this.scorchMat;

    this.core = MeshBuilder.CreateDisc('death_portal_core', { radius: 0.39, tessellation: 48 }, scene);
    this.core.parent = this.root;
    this.core.position.y = 0.002;
    this.core.rotation.x = Math.PI / 2;
    this.core.isPickable = false;
    this.core.material = this.coreMat;

    this.ringA = MeshBuilder.CreateTorus('death_portal_ring_a', { diameter: 0.84, thickness: 0.042, tessellation: 56 }, scene);
    this.ringA.parent = this.root;
    this.ringA.position.y = 0.012;
    this.ringA.rotation.x = Math.PI / 2;
    this.ringA.isPickable = false;
    this.ringA.material = this.ringMat;

    this.ringB = MeshBuilder.CreateTorus('death_portal_ring_b', { diameter: 0.58, thickness: 0.026, tessellation: 48 }, scene);
    this.ringB.parent = this.root;
    this.ringB.position.y = 0.022;
    this.ringB.rotation.x = Math.PI / 2;
    this.ringB.isPickable = false;
    this.ringB.material = this.sparkMat;

    for (let i = 0; i < RIM_SPIKE_COUNT; i++) {
      const spike = MeshBuilder.CreateCylinder(`death_portal_rim_spike_${i}`, {
        height: 0.13 + (i % 3) * 0.025,
        diameterTop: 0.009,
        diameterBottom: 0.06 + (i % 2) * 0.02,
        tessellation: 3,
      }, scene);
      const angle = (i / RIM_SPIKE_COUNT) * Math.PI * 2 + (i % 2) * 0.07;
      const radius = 0.41 + (i % 3) * 0.018;
      const baseScale = new Vector3(0.8 + (i % 2) * 0.18, 0.78 + (i % 4) * 0.08, 0.8);
      spike.parent = this.root;
      spike.position.set(Math.cos(angle) * radius, 0.07, Math.sin(angle) * radius);
      spike.rotation.y = -angle;
      spike.scaling.copyFrom(baseScale);
      spike.isPickable = false;
      spike.material = this.spikeMat;
      this.rimSpikes.push(spike);
      this.spikeBaseScales.push(baseScale);
      this.spikePhases.push(i * 0.81);
    }

    this.root.scaling.setAll(0.02);

    if (targetNode) {
      this.baseScale = targetNode.scaling.clone();
      this.basePosition = targetNode.position.clone();
    }

    this.smokeParticles = this.createSmokeParticles();
    this.sparkParticles = this.createSparkParticles();
    this.smokeParticles.start();
    this.sparkParticles.start();

    this.observer = scene.onBeforeRenderObservable.add(() => this.tick());
  }

  private createSmokeParticles(): ParticleSystem {
    const ps = new ParticleSystem('death_portal_ash_smoke', 220, this.scene);
    ps.particleTexture = makeParticleTexture(this.scene);
    ps.emitter = this.core;
    ps.minEmitBox = new Vector3(-0.27, 0.04, -0.27);
    ps.maxEmitBox = new Vector3(0.27, 0.04, 0.27);
    ps.color1 = new Color4(0.09, 0.015, 0.005, 0.58);
    ps.color2 = new Color4(0.28, 0.035, 0.005, 0.45);
    ps.colorDead = new Color4(0.005, 0, 0, 0);
    ps.minSize = 0.08;
    ps.maxSize = 0.19;
    ps.minLifeTime = 0.45;
    ps.maxLifeTime = 0.95;
    ps.emitRate = 95;
    ps.minEmitPower = 0.12;
    ps.maxEmitPower = 0.55;
    ps.direction1 = new Vector3(-0.16, 0.62, -0.16);
    ps.direction2 = new Vector3(0.16, 1.05, 0.16);
    ps.gravity = new Vector3(0, -0.28, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    ps.targetStopDuration = 1.0;
    return ps;
  }

  private createSparkParticles(): ParticleSystem {
    const ps = new ParticleSystem('death_portal_embers', 130, this.scene);
    ps.particleTexture = makeParticleTexture(this.scene);
    ps.emitter = this.core;
    ps.minEmitBox = new Vector3(-0.3, 0.05, -0.3);
    ps.maxEmitBox = new Vector3(0.3, 0.05, 0.3);
    ps.color1 = new Color4(1, 0.62, 0.08, 1);
    ps.color2 = new Color4(0.95, 0.04, 0.005, 0.95);
    ps.colorDead = new Color4(0.12, 0.005, 0, 0);
    ps.minSize = 0.045;
    ps.maxSize = 0.095;
    ps.minLifeTime = 0.18;
    ps.maxLifeTime = 0.62;
    ps.emitRate = 70;
    ps.minEmitPower = 0.5;
    ps.maxEmitPower = 1.25;
    ps.direction1 = new Vector3(-0.42, 0.35, -0.42);
    ps.direction2 = new Vector3(0.42, 1.2, 0.42);
    ps.gravity = new Vector3(0, -2.05, 0);
    ps.blendMode = ParticleSystem.BLENDMODE_ADD;
    ps.targetStopDuration = 0.75;
    return ps;
  }

  private tick(): void {
    if (this.done || this.scene.isDisposed) {
      this.dispose();
      return;
    }

    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastMs) / 1000);
    this.lastMs = now;
    const duration = this.opts.durationMs ?? DEFAULT_DURATION_MS;
    const t = clamp01((now - this.startMs) / duration);
    const open = easeOutCubic(t / 0.28);
    const sink = easeInCubic((t - 0.16) / 0.72);
    const fade = 1 - easeInCubic((t - 0.72) / 0.28);

    const pulse = 0.92 + Math.sin(now * 0.024) * 0.08;
    const portalScale = 0.08 + open * 0.92;
    this.root.scaling.set(portalScale, portalScale, portalScale);
    this.root.rotation.y += dt * (0.85 + sink * 2.2);
    this.ringA.rotation.z += dt * (1.8 + sink * 2.4);
    this.ringB.rotation.z -= dt * (3.0 + sink * 3.4);
    this.scorchMat.alpha = 0.38 * fade;
    this.coreMat.alpha = 0.92 * fade;
    this.ringMat.alpha = 0.94 * fade * pulse;
    this.sparkMat.alpha = 0.9 * fade * pulse;
    this.spikeMat.alpha = 0.96 * fade;

    for (let i = 0; i < this.rimSpikes.length; i++) {
      const spike = this.rimSpikes[i];
      const base = this.spikeBaseScales[i];
      const flicker = 0.72 + Math.sin(now * 0.018 + this.spikePhases[i]) * 0.18;
      const rise = open * flicker;
      spike.scaling.set(base.x, Math.max(0.08, base.y * rise), base.z);
      spike.position.y = 0.028 + 0.05 * rise;
    }

    if (this.targetNode && this.baseScale && this.basePosition) {
      const shrink = Math.max(0.035, 1 - sink * 0.965);
      this.targetNode.scaling.set(
        this.baseScale.x * shrink,
        this.baseScale.y * shrink,
        this.baseScale.z * shrink,
      );
      this.targetNode.position.set(
        this.basePosition.x,
        this.basePosition.y - sink * 1.05,
        this.basePosition.z,
      );
      this.targetNode.rotation.y += dt * sink * 3.2;
    }

    if (t >= 1) this.dispose();
  }

  private dispose(): void {
    if (this.done) return;
    this.done = true;
    if (this.observer) {
      this.scene.onBeforeRenderObservable.remove(this.observer);
      this.observer = null;
    }
    this.smokeParticles.stop();
    this.sparkParticles.stop();
    this.smokeParticles.dispose(false);
    this.sparkParticles.dispose(false);
    this.scorch.dispose();
    this.core.dispose();
    this.ringA.dispose();
    this.ringB.dispose();
    for (const spike of this.rimSpikes) spike.dispose();
    this.scorchMat.dispose();
    this.coreMat.dispose();
    this.ringMat.dispose();
    this.sparkMat.dispose();
    this.spikeMat.dispose();
    this.root.dispose();
    this.opts.onDone?.();
  }
}
