import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Observer } from '@babylonjs/core/Misc/observable';
import type { Scene } from '@babylonjs/core/scene';
import { rangedProjectileArcHeightForDistance, rangedProjectileTravelMsForDistance } from '@projectrs/shared';
import type { Targetable } from './Targetable';

type ProjectileSource = Targetable & {
  getCastOrigin?: () => Vector3;
};

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function arrowProjectileTravelMs(from: Vector3, to: Vector3): number {
  const horizontalDistance = Math.hypot(to.x - from.x, to.z - from.z);
  return rangedProjectileTravelMsForDistance(horizontalDistance);
}

function arrowArcHeight(from: Vector3, to: Vector3): number {
  const horizontalDistance = Math.hypot(to.x - from.x, to.z - from.z);
  return rangedProjectileArcHeightForDistance(horizontalDistance);
}

export interface ArrowProjectileOptions {
  from?: Vector3;
  to?: Vector3;
  travelMs?: number;
  arcHeight?: number;
  projectileType?: number;
}

function resolveLaunchPoint(source: ProjectileSource): Vector3 {
  if (typeof source.getCastOrigin === 'function') return source.getCastOrigin();
  const anchor = source.getTargetAnchor();
  return new Vector3(anchor.x, anchor.y + 0.15, anchor.z);
}

function trajectoryPointToRef(t: number, from: Vector3, to: Vector3, arcHeight: number, out: Vector3): void {
  Vector3.LerpToRef(from, to, t, out);
  out.y += Math.sin(Math.PI * t) * arcHeight;
}

function trajectoryTangentToRef(t: number, from: Vector3, to: Vector3, arcHeight: number, out: Vector3): void {
  out.copyFrom(to);
  out.subtractInPlace(from);
  out.y += Math.PI * arcHeight * Math.cos(Math.PI * t);
  if (out.lengthSquared() < 0.000001) out.set(0, 0, 1);
  else out.normalize();
}

export class ArrowProjectileManager {
  private shaftMat: StandardMaterial | null = null;
  private headMat: StandardMaterial | null = null;
  private featherMat: StandardMaterial | null = null;
  private disposed = false;
  private launchTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  private active: Set<{ root: TransformNode; observer: Observer<Scene> }> = new Set();
  private readonly orientForward = new Vector3();

  constructor(private readonly scene: Scene) {}

  spawn(attacker: ProjectileSource, target: Targetable, releaseDelayMs: number, options: ArrowProjectileOptions = {}): void {
    const delay = Math.max(0, releaseDelayMs);
    if (delay <= 0) {
      this.launch(attacker, target, options);
      return;
    }

    const timer = setTimeout(() => {
      this.launchTimers.delete(timer);
      this.launch(attacker, target, options);
    }, delay);
    this.launchTimers.add(timer);
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.launchTimers) clearTimeout(timer);
    this.launchTimers.clear();
    for (const entry of this.active) {
      this.scene.onBeforeRenderObservable.remove(entry.observer);
      entry.root.dispose(false, false);
    }
    this.active.clear();
    this.shaftMat?.dispose();
    this.headMat?.dispose();
    this.featherMat?.dispose();
    this.shaftMat = null;
    this.headMat = null;
    this.featherMat = null;
  }

  private launch(attacker: ProjectileSource, target: Targetable, options: ArrowProjectileOptions): void {
    if (this.disposed) return;
    const from = options.from?.clone() ?? resolveLaunchPoint(attacker);
    const to = options.to?.clone() ?? target.getTargetAnchor();
    const travelMs = typeof options.travelMs === 'number' && Number.isFinite(options.travelMs) && options.travelMs > 0
      ? options.travelMs
      : arrowProjectileTravelMs(from, to);
    const arcHeight = typeof options.arcHeight === 'number' && Number.isFinite(options.arcHeight) && options.arcHeight >= 0
      ? options.arcHeight
      : arrowArcHeight(from, to);
    const root = this.createArrowRoot();
    const pos = new Vector3();
    const tangent = new Vector3();

    trajectoryPointToRef(0, from, to, arcHeight, pos);
    root.position.copyFrom(pos);
    trajectoryTangentToRef(0, from, to, arcHeight, tangent);
    this.orientToTangent(root, tangent);

    const startMs = performance.now();
    const entry: { root: TransformNode; observer: Observer<Scene> } = {
      root,
      observer: null as unknown as Observer<Scene>,
    };
    entry.observer = this.scene.onBeforeRenderObservable.add(() => {
      const t = clamp((performance.now() - startMs) / travelMs, 0, 1);
      trajectoryPointToRef(t, from, to, arcHeight, pos);
      root.position.copyFrom(pos);
      trajectoryTangentToRef(t, from, to, arcHeight, tangent);
      this.orientToTangent(root, tangent);

      if (t >= 1) {
        this.scene.onBeforeRenderObservable.remove(entry.observer);
        this.active.delete(entry);
        root.dispose(false, false);
      }
    });
    this.active.add(entry);
  }

  private createArrowRoot(): TransformNode {
    const root = new TransformNode('arrow_projectile', this.scene);
    const shaft = MeshBuilder.CreateCylinder('arrow_projectile_shaft', {
      height: 0.54,
      diameter: 0.022,
      tessellation: 6,
    }, this.scene);
    shaft.parent = root;
    shaft.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), Math.PI / 2);
    shaft.material = this.getShaftMat();

    const head = MeshBuilder.CreateCylinder('arrow_projectile_head', {
      height: 0.14,
      diameterTop: 0,
      diameterBottom: 0.07,
      tessellation: 4,
    }, this.scene);
    head.parent = root;
    head.position.z = 0.34;
    head.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), Math.PI / 2);
    head.material = this.getHeadMat();

    const fletchA = MeshBuilder.CreateBox('arrow_projectile_fletch_a', {
      width: 0.11,
      height: 0.018,
      depth: 0.13,
    }, this.scene);
    fletchA.parent = root;
    fletchA.position.z = -0.25;
    fletchA.material = this.getFeatherMat();

    const fletchB = MeshBuilder.CreateBox('arrow_projectile_fletch_b', {
      width: 0.018,
      height: 0.11,
      depth: 0.13,
    }, this.scene);
    fletchB.parent = root;
    fletchB.position.z = -0.25;
    fletchB.material = this.getFeatherMat();

    root.scaling.setAll(0.464);
    return root;
  }

  private orientToTangent(root: TransformNode, tangent: Vector3): void {
    const up = Math.abs(Vector3.Dot(tangent, Vector3.Up())) > 0.96 ? Vector3.Right() : Vector3.Up();
    this.orientForward.copyFrom(tangent).scaleInPlace(-1);
    root.rotationQuaternion = Quaternion.FromLookDirectionLH(this.orientForward, up);
  }

  private getShaftMat(): StandardMaterial {
    if (!this.shaftMat) {
      this.shaftMat = new StandardMaterial('arrow_projectile_shaft_mat', this.scene);
      this.shaftMat.diffuseColor = new Color3(0.46, 0.28, 0.12);
      this.shaftMat.emissiveColor = new Color3(0.09, 0.055, 0.025);
      this.shaftMat.specularColor = Color3.Black();
    }
    return this.shaftMat;
  }

  private getHeadMat(): StandardMaterial {
    if (!this.headMat) {
      this.headMat = new StandardMaterial('arrow_projectile_head_mat', this.scene);
      this.headMat.diffuseColor = new Color3(0.44, 0.42, 0.38);
      this.headMat.emissiveColor = new Color3(0.08, 0.08, 0.07);
      this.headMat.specularColor = Color3.Black();
    }
    return this.headMat;
  }

  private getFeatherMat(): StandardMaterial {
    if (!this.featherMat) {
      this.featherMat = new StandardMaterial('arrow_projectile_feather_mat', this.scene);
      this.featherMat.diffuseColor = new Color3(0.78, 0.72, 0.58);
      this.featherMat.emissiveColor = new Color3(0.12, 0.11, 0.09);
      this.featherMat.specularColor = Color3.Black();
    }
    return this.featherMat;
  }
}
