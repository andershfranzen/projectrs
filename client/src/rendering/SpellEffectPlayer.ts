import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import { Particle } from '@babylonjs/core/Particles/particle';
import { FresnelParameters } from '@babylonjs/core/Materials/fresnelParameters';
import { Observer } from '@babylonjs/core/Misc/observable';
import type { SpellEffectDef, Color3Def, ProjectileShape, CastParticle, ImpactDecal } from '@projectrs/shared';

// Side-effect imports for mesh builders (Babylon tree-shaking requires these).
import '@babylonjs/core/Meshes/Builders/sphereBuilder';
import '@babylonjs/core/Meshes/Builders/boxBuilder';
import '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import '@babylonjs/core/Meshes/Builders/torusBuilder';
import '@babylonjs/core/Meshes/Builders/discBuilder';
import '@babylonjs/core/Meshes/Builders/linesBuilder';

// ────────────────────────────────────────────────────────────────────────────
// Particle texture cache (one set per scene)
// ────────────────────────────────────────────────────────────────────────────

type TexKind = 'ember' | 'spark' | 'skull' | 'star' | 'rune' | 'smoke' | 'snowflake' | 'leaf';

const sceneTextureCaches = new WeakMap<Scene, Map<TexKind, DynamicTexture>>();

function getTextureCache(scene: Scene): Map<TexKind, DynamicTexture> {
  let c = sceneTextureCaches.get(scene);
  if (!c) {
    c = new Map();
    sceneTextureCaches.set(scene, c);
  }
  return c;
}

function makeDynTex(scene: Scene, size: number): { dt: DynamicTexture; ctx: CanvasRenderingContext2D; size: number } {
  const dt = new DynamicTexture(`particle_${Math.random().toString(36).slice(2, 8)}`, size, scene, false);
  return { dt, ctx: dt.getContext() as CanvasRenderingContext2D, size };
}

function createEmberTex(scene: Scene): DynamicTexture {
  const { dt, ctx, size } = makeDynTex(scene, 64);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,200,0.9)');
  g.addColorStop(0.5, 'rgba(255,200,100,0.5)');
  g.addColorStop(0.8, 'rgba(255,100,50,0.15)');
  g.addColorStop(1, 'rgba(200,50,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  dt.update();
  return dt;
}

function createSparkTex(scene: Scene): DynamicTexture {
  const { dt, ctx, size } = makeDynTex(scene, 64);
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 2) {
    const lg = ctx.createLinearGradient(c + Math.cos(a) * size * 0.45, c + Math.sin(a) * size * 0.45, c, c);
    lg.addColorStop(0, 'rgba(255,255,255,0)');
    lg.addColorStop(0.5, 'rgba(255,255,220,0.6)');
    lg.addColorStop(1, 'rgba(255,255,255,1)');
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.cos(a - 0.15) * size * 0.48, c + Math.sin(a - 0.15) * size * 0.48);
    ctx.lineTo(c + Math.cos(a + 0.15) * size * 0.48, c + Math.sin(a + 0.15) * size * 0.48);
    ctx.fill();
  }
  const rg = ctx.createRadialGradient(c, c, 0, c, c, size * 0.15);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, size, size);
  dt.update();
  return dt;
}

function createSmokeTex(scene: Scene): DynamicTexture {
  const { dt, ctx, size } = makeDynTex(scene, 64);
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 6; i++) {
    const ox = size / 2 + (Math.random() - 0.5) * size * 0.3;
    const oy = size / 2 + (Math.random() - 0.5) * size * 0.3;
    const r = size * (0.15 + Math.random() * 0.2);
    const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, r);
    g.addColorStop(0, 'rgba(200,200,200,0.3)');
    g.addColorStop(1, 'rgba(100,100,100,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  dt.update();
  return dt;
}

function createSnowflakeTex(scene: Scene): DynamicTexture {
  const { dt, ctx, size } = makeDynTex(scene, 64);
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(200,230,255,0.9)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.cos(a) * size * 0.4, c + Math.sin(a) * size * 0.4);
    ctx.stroke();
    for (let b = 0.3; b <= 0.6; b += 0.3) {
      const bx = c + Math.cos(a) * size * b;
      const by = c + Math.sin(a) * size * b;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + Math.cos(a + 0.6) * size * 0.12, by + Math.sin(a + 0.6) * size * 0.12);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + Math.cos(a - 0.6) * size * 0.12, by + Math.sin(a - 0.6) * size * 0.12);
      ctx.stroke();
    }
  }
  const fg = ctx.createRadialGradient(c, c, size * 0.15, c, c, size * 0.48);
  fg.addColorStop(0, 'rgba(0,0,0,0)');
  fg.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = fg;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = 'source-over';
  dt.update();
  return dt;
}

function createLeafTex(scene: Scene): DynamicTexture {
  const { dt, ctx, size } = makeDynTex(scene, 64);
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(120,200,80,0.9)';
  ctx.beginPath();
  ctx.moveTo(c, size * 0.1);
  ctx.bezierCurveTo(c + size * 0.35, size * 0.3, c + size * 0.3, size * 0.7, c, size * 0.9);
  ctx.bezierCurveTo(c - size * 0.3, size * 0.7, c - size * 0.35, size * 0.3, c, size * 0.1);
  ctx.fill();
  dt.update();
  return dt;
}

function createSkullTex(scene: Scene): DynamicTexture {
  const { dt, ctx, size } = makeDynTex(scene, 64);
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.save();
  ctx.translate(c, c * 0.9);
  ctx.scale(1, 1.19);
  ctx.beginPath();
  ctx.arc(0, 0, size * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = 'rgba(0,0,0,0.9)';
  ctx.beginPath();
  ctx.arc(c - size * 0.12, c * 0.82, size * 0.09, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(c + size * 0.12, c * 0.82, size * 0.09, 0, Math.PI * 2);
  ctx.fill();
  dt.update();
  return dt;
}

function createStarTex(scene: Scene): DynamicTexture {
  const { dt, ctx, size } = makeDynTex(scene, 64);
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const outerA = -Math.PI / 2 + (i * Math.PI * 2) / 5;
    const innerA = outerA + Math.PI / 5;
    ctx.lineTo(c + Math.cos(outerA) * size * 0.44, c + Math.sin(outerA) * size * 0.44);
    ctx.lineTo(c + Math.cos(innerA) * size * 0.18, c + Math.sin(innerA) * size * 0.18);
  }
  ctx.closePath();
  ctx.fill();
  dt.update();
  return dt;
}

function createRuneTex(scene: Scene): DynamicTexture {
  // Rune is procedural per-call in the editor (each particle gets a fresh draw).
  // Single cached version is fine — particle systems pick varied colors anyway.
  const { dt, ctx, size } = makeDynTex(scene, 64);
  const c = size / 2;
  ctx.clearRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(c - size * 0.2, size * 0.2);
  ctx.lineTo(c - size * 0.2, size * 0.8);
  ctx.moveTo(c - size * 0.2, c);
  ctx.lineTo(c + size * 0.2, size * 0.3);
  ctx.moveTo(c - size * 0.2, c);
  ctx.lineTo(c + size * 0.2, size * 0.7);
  ctx.stroke();
  dt.update();
  return dt;
}

function getParticleTex(scene: Scene, kind: TexKind): DynamicTexture {
  const cache = getTextureCache(scene);
  let t = cache.get(kind);
  if (t) return t;
  const creators: Record<TexKind, (s: Scene) => DynamicTexture> = {
    ember: createEmberTex,
    spark: createSparkTex,
    skull: createSkullTex,
    star: createStarTex,
    rune: createRuneTex,
    smoke: createSmokeTex,
    snowflake: createSnowflakeTex,
    leaf: createLeafTex,
  };
  t = creators[kind](scene);
  cache.set(kind, t);
  return t;
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function color3(c: Color3Def): Color3 {
  return new Color3(c.r, c.g, c.b);
}
function color4(c: Color3Def, a: number): Color4 {
  return new Color4(c.r, c.g, c.b, a);
}

/** Quadratic bezier point on a homing arc. */
function homingPoint(t: number, from: Vector3, to: Vector3, curve: number): Vector3 {
  const mid = Vector3.Center(from, to);
  const cp = mid.add(new Vector3(0, curve * 0.5, curve));
  const it = 1 - t;
  return new Vector3(
    it * it * from.x + 2 * it * t * cp.x + t * t * to.x,
    it * it * from.y + 2 * it * t * cp.y + t * t * to.y,
    it * it * from.z + 2 * it * t * cp.z + t * t * to.z,
  );
}

function trajectoryPoint(t: number, from: Vector3, to: Vector3, def: SpellEffectDef): Vector3 {
  const pos = Vector3.Lerp(from, to, t);
  const traj = def.trajectory;
  if (traj.type === 'arc') {
    pos.y += traj.arcHeight * 4 * t * (1 - t);
  } else if (traj.type === 'homing') {
    return homingPoint(t, from, to, traj.homingCurve);
  }
  return pos;
}

// ────────────────────────────────────────────────────────────────────────────
// SpellEffectPlayer — runs a single spell cast→travel→impact→linger sequence
// ────────────────────────────────────────────────────────────────────────────

export interface SpellPlayOptions {
  def: SpellEffectDef;
  /** Snapshot world position of caster's hand (origin of cast burst + projectile start). */
  from: Vector3;
  /** Snapshot world position of target chest (impact location). */
  to: Vector3;
  /**
   * World Y where the impact decal disc should sit. If omitted, the disc sits
   * at `to.y` — which works for ground-level impacts but looks wrong for chest-
   * height hits unless the caller knows the terrain height under the target.
   * For an NPC standing on flat ground, pass `target.position.y + tinyOffset`.
   */
  groundY?: number;
  /** Fires the moment the projectile reaches the target. Use for damage application / hit number. */
  onImpact?: () => void;
}

type Phase = 'cast' | 'travel' | 'impact' | 'linger' | 'done';

/**
 * Plays a complete spell effect from caster to target. Each call creates its
 * own meshes / materials / particle systems and disposes them when the
 * sequence finishes, so concurrent casts don't share color state.
 *
 * Visual code is ported from spell-editor.html — keep that file as the
 * authoring/preview environment; this is the runtime player.
 */
export class SpellEffectPlayer {
  constructor(private scene: Scene) {}

  play(opts: SpellPlayOptions): Promise<void> {
    return new Promise((resolve) => {
      new ActiveCast(this.scene, opts, resolve);
    });
  }
}

class ActiveCast {
  private phase: Phase = 'cast';
  private phaseStart = performance.now();
  private observer: Observer<Scene> | null = null;
  private impactFired = false;

  // Owned resources
  private projRoot: TransformNode | null = null;
  private projCore: Mesh | null = null;
  private projShell: Mesh | null = null;
  private projParts: Mesh[] = [];
  private projAura: ParticleSystem | null = null;
  private projCoreMat: StandardMaterial | null = null;
  private projShellMat: StandardMaterial | null = null;
  private trailEmitPos = Vector3.Zero();
  private trailPS: ParticleSystem | null = null;
  private castPS: ParticleSystem | null = null;
  private impactPS: ParticleSystem | null = null;
  private lingerPS: ParticleSystem | null = null;
  private impactDecal: Mesh | null = null;
  private impactDecalMat: StandardMaterial | null = null;
  private handGlow: Mesh | null = null;
  private handGlowMat: StandardMaterial | null = null;
  private arcs: LinesMesh[] = [];
  private arcMats: StandardMaterial[] = [];
  private arcRegenCounter = 0;
  private disposed = false;

  constructor(
    private scene: Scene,
    private opts: SpellPlayOptions,
    private resolve: () => void,
  ) {
    this.startCast();
    this.observer = scene.onBeforeRenderObservable.add(() => this.tick());
  }

  // ─── Phase: cast ──────────────────────────────────────────────────────────
  private startCast(): void {
    const def = this.opts.def;
    const cast = def.cast;
    this.castPS = new ParticleSystem('spell_castBurst', 250, this.scene);
    this.castPS.particleTexture = getParticleTex(this.scene, cast.burstParticle as TexKind);
    this.castPS.emitter = this.opts.from.clone();
    this.castPS.createSphereEmitter(Math.max(0.05, cast.burstSpread));
    this.castPS.minSize = 0.03;
    this.castPS.maxSize = 0.1;
    this.castPS.minLifeTime = 0.3;
    this.castPS.maxLifeTime = 0.8;
    this.castPS.emitRate = 0;
    this.castPS.manualEmitCount = Math.round(cast.burstCount);
    this.castPS.blendMode = cast.burstParticle === 'smoke'
      ? ParticleSystem.BLENDMODE_STANDARD
      : ParticleSystem.BLENDMODE_ADD;
    this.castPS.color1 = color4(cast.burstColor, 1);
    this.castPS.color2 = new Color4(cast.burstColor.r * 0.7, cast.burstColor.g * 0.7, cast.burstColor.b * 0.7, 0.8);
    this.castPS.colorDead = new Color4(cast.burstColor.r * 0.2, cast.burstColor.g * 0.1, cast.burstColor.b * 0.1, 0);
    this.castPS.gravity = new Vector3(0, 0.5, 0);
    this.castPS.minEmitPower = cast.burstSpread * 0.8;
    this.castPS.maxEmitPower = cast.burstSpread * 2.5;
    this.castPS.targetStopDuration = 0.5;
    this.castPS.start();

    // Optional hand glow: a small emissive sphere at the cast origin that fades
    // in over the cast duration, simulating the editor's left/right hand spheres
    // with a single mesh at the midpoint.
    if (cast.handGlow) {
      this.handGlow = MeshBuilder.CreateSphere('spell_handGlow', { diameter: 0.18, segments: 8 }, this.scene);
      this.handGlow.position.copyFrom(this.opts.from);
      this.handGlow.isPickable = false;
      const m = new StandardMaterial('spell_handGlowMat', this.scene);
      m.disableLighting = true;
      const intensity = cast.handGlowIntensity ?? 1;
      m.emissiveColor = new Color3(
        Math.min(1, cast.handGlowColor.r * intensity),
        Math.min(1, cast.handGlowColor.g * intensity),
        Math.min(1, cast.handGlowColor.b * intensity),
      );
      m.alpha = 0;
      this.handGlow.material = m;
      this.handGlowMat = m;
    }
  }

  // ─── Phase: travel ────────────────────────────────────────────────────────
  private startTravel(): void {
    this.phase = 'travel';
    this.phaseStart = performance.now();
    const def = this.opts.def;

    this.buildProjectile(def.projectile.shape);
    if (this.projRoot) {
      this.projRoot.scaling.setAll(def.projectile.size);
      this.projRoot.position.copyFrom(this.opts.from);
      const aheadInit = trajectoryPoint(0.01, this.opts.from, this.opts.to, def);
      this.projRoot.lookAt(aheadInit);
      this.projRoot.setEnabled(true);
    }
    this.trailEmitPos.copyFrom(this.opts.from);
    if (this.projAura) this.projAura.start();

    // Trail
    const trail = def.trail;
    this.trailPS = new ParticleSystem('spell_trail', 500, this.scene);
    this.trailPS.particleTexture = getParticleTex(this.scene, trail.particleType as TexKind);
    this.trailPS.createSphereEmitter(Math.max(0.05, trail.width));
    this.trailPS.emitter = this.trailEmitPos;
    this.trailPS.emitRate = trail.density;
    this.trailPS.minLifeTime = trail.fadeTime * 0.5;
    this.trailPS.maxLifeTime = trail.fadeTime;
    const pSz = def.projectile.size;
    this.trailPS.minSize = pSz * 0.06;
    this.trailPS.maxSize = pSz * 0.18;
    this.trailPS.color1 = color4(trail.color, 1);
    this.trailPS.color2 = new Color4(trail.color.r * 0.7, trail.color.g * 0.5, trail.color.b * 0.3, 0.8);
    this.trailPS.colorDead = new Color4(trail.color.r * 0.15, trail.color.g * 0.1, trail.color.b * 0.05, 0);
    this.trailPS.gravity = new Vector3(0, -0.3, 0);
    this.trailPS.minEmitPower = 0.05;
    this.trailPS.maxEmitPower = 0.2;
    this.trailPS.blendMode = trail.particleType === 'smoke'
      ? ParticleSystem.BLENDMODE_STANDARD
      : ParticleSystem.BLENDMODE_ADD;
    if (trail.motion === 'wavy' || trail.motion === 'spiral') {
      this.applyTrailMotion(this.trailPS, trail.motion);
    }
    this.trailPS.start();

    // Hand glow disappears once the projectile launches.
    if (this.handGlow) this.handGlow.setEnabled(false);
  }

  /**
   * Replaces the trail's default updateFunction with a wavy or spiral motion.
   * Each particle gets a random phase the first time it's touched, so its
   * lateral movement doesn't sync with neighbours. Lifted from spell-editor.html.
   */
  private applyTrailMotion(ps: ParticleSystem, motion: 'wavy' | 'spiral'): void {
    ps.updateFunction = function (particles: Particle[]) {
      const self = this as any;
      const dt = self._scaledUpdateSpeed as number;
      const t = performance.now() / 1000;
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i] as Particle & { _phase?: number };
        p.age += dt;
        if (p.age >= p.lifeTime) { self.recycleParticle(p); i--; continue; }
        const ratio = p.age / p.lifeTime;
        if (p._phase === undefined) p._phase = Math.random() * Math.PI * 20;
        if (motion === 'wavy') {
          p.position.x += Math.sin(t * 5 + p._phase) * 0.01;
          p.position.z += Math.cos(t * 5 + p._phase) * 0.01;
          p.position.y += p.direction.y * dt;
        } else {
          const ang = t * 6 + p._phase + ratio * 10;
          const r = 0.05 + Math.sin(ratio * Math.PI) * 0.12;
          p.position.x += Math.cos(ang) * r * dt;
          p.position.z += Math.sin(ang) * r * dt;
          p.position.y += p.direction.y * dt * 0.5;
        }
        p.color.a = 1 - ratio;
      }
    };
  }

  // ─── Phase: impact ────────────────────────────────────────────────────────
  private startImpact(): void {
    this.phase = 'impact';
    this.phaseStart = performance.now();
    if (this.projRoot) this.projRoot.setEnabled(false);
    if (this.projAura) this.projAura.stop();
    if (this.trailPS) this.trailPS.stop();

    if (!this.impactFired) {
      this.impactFired = true;
      try { this.opts.onImpact?.(); } catch (e) { console.error('[SpellEffectPlayer] onImpact threw:', e); }
    }

    const def = this.opts.def;
    const imp = def.impact;

    // Splash particles
    this.impactPS = new ParticleSystem('spell_impact', 400, this.scene);
    this.impactPS.particleTexture = getParticleTex(this.scene, imp.splashParticle as TexKind);
    this.impactPS.emitter = this.opts.to.clone();
    this.impactPS.createSphereEmitter(imp.splashSpread);
    this.impactPS.minSize = 0.03;
    this.impactPS.maxSize = 0.12;
    this.impactPS.minLifeTime = 0.3;
    this.impactPS.maxLifeTime = 0.8;
    this.impactPS.emitRate = 0;
    this.impactPS.manualEmitCount = imp.splashCount;
    this.impactPS.minEmitPower = imp.splashSpread;
    this.impactPS.maxEmitPower = imp.splashSpread * 2.5;
    this.impactPS.color1 = color4(imp.splashColor, 1);
    this.impactPS.color2 = new Color4(imp.splashColor.r * 0.6, imp.splashColor.g * 0.6, imp.splashColor.b * 0.6, 0.8);
    this.impactPS.colorDead = new Color4(imp.splashColor.r * 0.15, imp.splashColor.g * 0.1, imp.splashColor.b * 0.05, 0);
    this.impactPS.gravity = new Vector3(0, -1, 0);
    this.impactPS.blendMode = imp.splashParticle === 'smoke'
      ? ParticleSystem.BLENDMODE_STANDARD
      : ParticleSystem.BLENDMODE_ADD;
    this.impactPS.targetStopDuration = 0.3;
    this.impactPS.start();

    // Ground decal
    if (imp.groundDecal !== 'none') this.buildDecal(imp.groundDecal);

    // Lightning arcs (initial)
    if (imp.lightning.arcCount > 0) this.regenerateArcs();

    // Linger setup (started when impact phase ends)
    if (imp.lingerEnabled) {
      this.lingerPS = new ParticleSystem('spell_linger', 200, this.scene);
      this.lingerPS.particleTexture = getParticleTex(this.scene, 'smoke');
      this.lingerPS.emitter = this.opts.to.clone();
      this.lingerPS.createSphereEmitter(0.5);
      this.lingerPS.minSize = 0.05;
      this.lingerPS.maxSize = 0.15;
      this.lingerPS.minLifeTime = 1;
      this.lingerPS.maxLifeTime = 2.5;
      this.lingerPS.emitRate = imp.lingerEmitRate;
      this.lingerPS.color1 = color4(imp.lingerColor, 0.6);
      this.lingerPS.colorDead = new Color4(imp.lingerColor.r * 0.2, imp.lingerColor.g * 0.1, imp.lingerColor.b * 0.1, 0);
      this.lingerPS.gravity = new Vector3(0, 0.2, 0);
      this.lingerPS.minEmitPower = 0.05;
      this.lingerPS.maxEmitPower = 0.15;
      this.lingerPS.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    }
  }

  // ─── Per-frame tick ───────────────────────────────────────────────────────
  private tick(): void {
    if (this.disposed) return;
    const now = performance.now();
    const def = this.opts.def;

    if (this.phase === 'cast') {
      const elapsed = now - this.phaseStart;
      if (this.handGlowMat) {
        const t = Math.min(1, elapsed / def.cast.durationMs);
        this.handGlowMat.alpha = Math.min(0.9, t * 2);
      }
      if (elapsed >= def.cast.durationMs) this.startTravel();
      return;
    }

    if (this.phase === 'travel') {
      const elapsed = now - this.phaseStart;
      const travel = def.trajectory.travelTimeMs;
      const t = Math.min(1, elapsed / travel);
      const pos = trajectoryPoint(t, this.opts.from, this.opts.to, def);
      this.projRoot?.position.copyFrom(pos);
      this.trailEmitPos.copyFrom(pos);

      // Orient toward direction of travel
      const tNext = Math.min(1, t + 0.01);
      const ahead = trajectoryPoint(tNext, this.opts.from, this.opts.to, def);
      const dir = ahead.subtract(pos);
      if (dir.lengthSquared() > 0.0001 && this.projRoot) {
        this.projRoot.lookAt(pos.add(dir));
      }

      // Subtle projectile pulse for blast shape
      if (def.projectile.shape === 'blast' && this.projCore && this.projShell) {
        const time = now / 1000;
        this.projCore.scaling.setAll(1 + 0.08 * Math.sin(time * 6));
        this.projShell.scaling.setAll(1 + 0.05 * Math.sin(time * 6 + 0.5));
      }
      // projAura.emitter already references projRoot.position (set once in
      // buildProjectile). Mutating root.position via copyFrom above is what
      // moves the aura — no per-frame reassignment needed.

      if (t >= 1) this.startImpact();
      return;
    }

    if (this.phase === 'impact') {
      const elapsed = now - this.phaseStart;
      // Decal fade
      if (this.impactDecal && this.impactDecalMat && this.impactDecal.isEnabled()) {
        const f = Math.max(0, 1 - elapsed / 3000);
        this.impactDecalMat.alpha = 0.7 * f;
      }
      // Lightning regeneration (flicker for first 500 ms)
      const lit = def.impact.lightning;
      if (lit.arcCount > 0 && elapsed < 500) {
        this.arcRegenCounter++;
        const interval = Math.max(1, Math.round(60 / lit.flickerSpeed));
        if (this.arcRegenCounter % interval === 0) this.regenerateArcs();
      } else if (elapsed >= 500) {
        for (const a of this.arcs) a.isVisible = false;
      }
      if (elapsed > 500) {
        if (def.impact.lingerEnabled && this.lingerPS) {
          this.lingerPS.start();
          this.phase = 'linger';
          this.phaseStart = now;
        } else {
          this.phase = 'done';
          this.phaseStart = now;
        }
      }
      return;
    }

    if (this.phase === 'linger') {
      const elapsed = now - this.phaseStart;
      if (this.impactDecal && this.impactDecalMat && this.impactDecal.isEnabled()) {
        const f = Math.max(0, 1 - (elapsed + 500) / 3000);
        this.impactDecalMat.alpha = 0.7 * f;
      }
      if (elapsed >= def.impact.lingerDurationMs) {
        this.lingerPS?.stop();
        this.phase = 'done';
        this.phaseStart = now;
      }
      return;
    }

    if (this.phase === 'done') {
      const elapsed = now - this.phaseStart;
      // Wait for trailing particles to fade naturally before disposing
      if (elapsed > 1500) this.dispose();
    }
  }

  // ─── Projectile mesh factory ──────────────────────────────────────────────
  private buildProjectile(shape: ProjectileShape): void {
    const proj = this.opts.def.projectile;
    const root = new TransformNode('spell_projRoot', this.scene);
    this.projRoot = root;

    // Materials owned per-cast.
    const coreMat = new StandardMaterial('spell_projCoreMat', this.scene);
    coreMat.disableLighting = true;
    // Lift core color so it reads as the "hot center" of the projectile.
    coreMat.emissiveColor = new Color3(
      Math.min(1, proj.primaryColor.r * 1.3 + 0.2),
      Math.min(1, proj.primaryColor.g * 1.3 + 0.15),
      Math.min(1, proj.primaryColor.b * 1.3 + 0.1),
    );
    coreMat.alpha = 1;
    this.projCoreMat = coreMat;

    const shellMat = new StandardMaterial('spell_projShellMat', this.scene);
    shellMat.disableLighting = true;
    shellMat.emissiveColor = color3(proj.primaryColor);
    shellMat.alpha = 0.35;
    shellMat.backFaceCulling = false;
    shellMat.emissiveFresnelParameters = new FresnelParameters();
    shellMat.emissiveFresnelParameters.bias = 0.2;
    shellMat.emissiveFresnelParameters.power = 2;
    shellMat.emissiveFresnelParameters.leftColor = new Color3(
      Math.min(1, proj.primaryColor.r + 0.3),
      Math.min(1, proj.primaryColor.g + 0.2),
      Math.min(1, proj.primaryColor.b + 0.1),
    );
    shellMat.emissiveFresnelParameters.rightColor = color3(proj.secondaryColor);
    shellMat.opacityFresnelParameters = new FresnelParameters();
    shellMat.opacityFresnelParameters.bias = 0.1;
    shellMat.opacityFresnelParameters.power = 1.5;
    this.projShellMat = shellMat;

    let core: Mesh;
    let shell: Mesh;
    const extras: Mesh[] = [];

    if (shape === 'blast') {
      core = MeshBuilder.CreateSphere('projCore', { diameter: 0.2, segments: 10 }, this.scene);
      shell = MeshBuilder.CreateSphere('projShell', { diameter: 0.32, segments: 10 }, this.scene);
      const tailSegs = [
        { z: -0.18, h: 0.20, dT: 0.22, dB: 0.14, a: 0.30 },
        { z: -0.34, h: 0.18, dT: 0.14, dB: 0.07, a: 0.15 },
        { z: -0.47, h: 0.14, dT: 0.07, dB: 0.00, a: 0.06 },
      ];
      for (let i = 0; i < tailSegs.length; i++) {
        const s = tailSegs[i];
        const seg = MeshBuilder.CreateCylinder(`tail${i}`, {
          height: s.h, diameterTop: s.dT, diameterBottom: s.dB, tessellation: 10,
        }, this.scene);
        seg.rotation.x = Math.PI / 2;
        seg.position.z = s.z;
        const m = new StandardMaterial(`spell_tailMat${i}`, this.scene);
        m.disableLighting = true;
        m.emissiveColor = shellMat.emissiveColor.clone();
        m.alpha = s.a;
        m.backFaceCulling = false;
        seg.material = m;
        seg.isPickable = false;
        seg.parent = root;
        extras.push(seg);
      }
    } else if (shape === 'skull') {
      core = MeshBuilder.CreateSphere('projCore', { diameter: 0.22, segments: 8 }, this.scene);
      core.scaling.set(0.9, 1.1, 0.95);
      shell = MeshBuilder.CreateSphere('projShell', { diameter: 0.01, segments: 3 }, this.scene);
      shell.isVisible = false;
      const eyeSocket = new StandardMaterial('spell_eyeSocket', this.scene);
      eyeSocket.disableLighting = true;
      eyeSocket.emissiveColor = new Color3(0, 0, 0);
      const eyeL = MeshBuilder.CreateSphere('eyeL', { diameter: 0.05, segments: 6 }, this.scene);
      eyeL.position.set(-0.04, 0.02, 0.1);
      eyeL.material = eyeSocket;
      eyeL.parent = root;
      const eyeR = MeshBuilder.CreateSphere('eyeR', { diameter: 0.05, segments: 6 }, this.scene);
      eyeR.position.set(0.04, 0.02, 0.1);
      eyeR.material = eyeSocket;
      eyeR.parent = root;
      const jaw = MeshBuilder.CreateBox('jaw', { width: 0.11, height: 0.025, depth: 0.05 }, this.scene);
      jaw.position.set(0, -0.09, 0.07);
      jaw.material = coreMat;
      jaw.parent = root;
      extras.push(eyeL, eyeR, jaw);
    } else if (shape === 'ankh') {
      const t = 0.03;
      const shaft = MeshBuilder.CreateBox('shaft', { width: t, height: 0.22, depth: t }, this.scene);
      shaft.position.y = -0.05;
      shaft.material = coreMat;
      shaft.parent = root;
      const crossbar = MeshBuilder.CreateBox('crossbar', { width: 0.14, height: t, depth: t }, this.scene);
      crossbar.position.y = 0.04;
      crossbar.material = coreMat;
      crossbar.parent = root;
      const loop = MeshBuilder.CreateTorus('loop', { diameter: 0.1, thickness: t, tessellation: 20 }, this.scene);
      loop.position.y = 0.12;
      loop.rotation.x = Math.PI / 2;
      loop.material = coreMat;
      loop.parent = root;
      core = MeshBuilder.CreateSphere('projCore', { diameter: 0.01, segments: 3 }, this.scene);
      core.isVisible = false;
      shell = MeshBuilder.CreateSphere('projShell', { diameter: 0.01, segments: 3 }, this.scene);
      shell.isVisible = false;
      extras.push(shaft, crossbar, loop);
    } else {
      core = MeshBuilder.CreateSphere('projCore', { diameter: 0.22, segments: 8 }, this.scene);
      shell = MeshBuilder.CreateSphere('projShell', { diameter: 0.36, segments: 8 }, this.scene);
    }

    core.material = coreMat;
    core.isPickable = false;
    core.parent = root;
    shell.material = shellMat;
    shell.isPickable = false;
    shell.parent = root;

    this.projCore = core;
    this.projShell = shell;
    this.projParts = [core, shell, ...extras];

    // Aura wisps
    this.projAura = new ParticleSystem('spell_projAura', 60, this.scene);
    this.projAura.particleTexture = getParticleTex(this.scene, 'ember');
    this.projAura.createSphereEmitter(0.15);
    this.projAura.emitter = root.position;
    this.projAura.minSize = 0.02;
    this.projAura.maxSize = 0.06;
    this.projAura.minLifeTime = 0.15;
    this.projAura.maxLifeTime = 0.35;
    this.projAura.emitRate = 40;
    this.projAura.blendMode = ParticleSystem.BLENDMODE_ADD;
    this.projAura.color1 = new Color4(
      Math.min(1, proj.primaryColor.r + 0.2),
      Math.min(1, proj.primaryColor.g + 0.1),
      proj.primaryColor.b,
      0.8,
    );
    this.projAura.colorDead = new Color4(
      proj.secondaryColor.r * 0.5,
      proj.secondaryColor.g * 0.3,
      proj.secondaryColor.b * 0.2,
      0,
    );
    this.projAura.minEmitPower = 0.02;
    this.projAura.maxEmitPower = 0.08;
    this.projAura.gravity = Vector3.Zero();

    root.setEnabled(false);
  }

  // ─── Ground decal ─────────────────────────────────────────────────────────
  private buildDecal(kind: ImpactDecal): void {
    if (kind === 'none') return;
    const disc = MeshBuilder.CreateDisc('spell_impactDecal', { radius: 1, tessellation: 32 }, this.scene);
    disc.rotation.x = Math.PI / 2;
    // Float the decal just above the supplied ground height (or the impact
    // point if the caller didn't say) so it doesn't z-fight with terrain.
    const groundY = this.opts.groundY ?? this.opts.to.y;
    disc.position.set(this.opts.to.x, groundY + 0.03, this.opts.to.z);
    disc.isPickable = false;
    const mat = new StandardMaterial('spell_impactDecalMat', this.scene);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.alpha = 0.7;
    const dt = new DynamicTexture('spell_decalTex', 128, this.scene, false);
    const ctx = dt.getContext() as CanvasRenderingContext2D;
    const S = 128;
    const c = S / 2;
    ctx.clearRect(0, 0, S, S);
    if (kind === 'scorch') {
      const g = ctx.createRadialGradient(c, c, 0, c, c, S * 0.45);
      g.addColorStop(0, 'rgba(40,20,10,0.8)');
      g.addColorStop(0.5, 'rgba(80,40,15,0.5)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
    } else if (kind === 'ice') {
      const g = ctx.createRadialGradient(c, c, 0, c, c, S * 0.45);
      g.addColorStop(0, 'rgba(150,200,255,0.6)');
      g.addColorStop(0.5, 'rgba(100,160,220,0.3)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
    } else {
      const g = ctx.createRadialGradient(c, c, 0, c, c, S * 0.45);
      g.addColorStop(0, 'rgba(180,180,180,0.5)');
      g.addColorStop(0.5, 'rgba(100,100,100,0.3)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
    }
    dt.update();
    mat.emissiveTexture = dt;
    disc.material = mat;
    this.impactDecal = disc;
    this.impactDecalMat = mat;
  }

  // ─── Lightning arcs ───────────────────────────────────────────────────────
  private regenerateArcs(): void {
    const lit = this.opts.def.impact.lightning;
    const center = this.opts.to;
    // Dispose previous frame's lines
    for (const a of this.arcs) a.dispose();
    this.arcs = [];
    for (let i = 0; i < lit.arcCount; i++) {
      const a1 = Math.random() * Math.PI * 2;
      const a2 = Math.random() * Math.PI * 2;
      const r = 0.3 + Math.random() * 0.5;
      const start = center.add(new Vector3(Math.cos(a1) * 0.1, 0.2 + Math.random() * 1.2, Math.sin(a1) * 0.1));
      const end = center.add(new Vector3(Math.cos(a2) * r, Math.random() * 0.5, Math.sin(a2) * r));
      const pts = this.genArcPoints(start, end, lit.jaggedness, lit.spread * 0.3);
      const line = MeshBuilder.CreateLines(`spell_arc${i}`, { points: pts }, this.scene);
      const mat = this.arcMats[i] ?? new StandardMaterial(`spell_arcMat${i}`, this.scene);
      if (!this.arcMats[i]) {
        mat.disableLighting = true;
        mat.diffuseColor = Color3.Black();
        mat.specularColor = Color3.Black();
        this.arcMats[i] = mat;
      }
      const g = Math.max(1, lit.glow);
      mat.emissiveColor = new Color3(lit.color.r * g, lit.color.g * g, lit.color.b * g);
      line.material = mat;
      line.color = color3(lit.color);
      line.alpha = 0.7 + Math.random() * 0.3;
      line.isPickable = false;
      this.arcs.push(line);
    }
  }

  private genArcPoints(start: Vector3, end: Vector3, segments: number, jitter: number): Vector3[] {
    const pts: Vector3[] = [start.clone()];
    for (let i = 1; i < segments; i++) {
      const t = i / segments;
      const base = Vector3.Lerp(start, end, t);
      base.x += (Math.random() - 0.5) * 2 * jitter;
      base.y += (Math.random() - 0.5) * jitter * 0.5;
      base.z += (Math.random() - 0.5) * 2 * jitter;
      pts.push(base);
    }
    pts.push(end.clone());
    return pts;
  }

  // ─── Cleanup ──────────────────────────────────────────────────────────────
  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.observer) this.scene.onBeforeRenderObservable.remove(this.observer);
    this.observer = null;

    this.castPS?.dispose();
    this.trailPS?.dispose();
    this.impactPS?.dispose();
    this.lingerPS?.dispose();
    this.projAura?.dispose();
    for (const p of this.projParts) p.dispose();
    this.projParts = [];
    this.projRoot?.dispose();
    this.projRoot = null;
    this.projCoreMat?.dispose();
    this.projShellMat?.dispose();
    for (const m of this.arcMats) m.dispose();
    for (const a of this.arcs) a.dispose();
    this.impactDecal?.dispose();
    this.impactDecalMat?.dispose();
    this.handGlow?.dispose();
    this.handGlowMat?.dispose();

    this.resolve();
  }
}
