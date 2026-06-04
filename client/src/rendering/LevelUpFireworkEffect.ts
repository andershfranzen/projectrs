import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';

const particleTextureCache = new WeakMap<Scene, DynamicTexture>();

function makeParticleTexture(scene: Scene): DynamicTexture {
  const cached = particleTextureCache.get(scene);
  if (cached && cached.getInternalTexture()) return cached;

  const size = 16;
  const tex = new DynamicTexture('level_up_firework_particle', size, scene, false, Texture.NEAREST_SAMPLINGMODE);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);

  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(4, 4, 8, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.48)';
  ctx.fillRect(2, 7, 12, 2);
  ctx.fillRect(7, 2, 2, 12);
  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  ctx.fillRect(6, 6, 4, 4);
  ctx.fillStyle = 'rgba(255,255,255,1)';
  ctx.fillRect(7, 7, 2, 2);

  tex.update();
  tex.hasAlpha = true;
  tex.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
  particleTextureCache.set(scene, tex);
  return tex;
}

function disposeLater(ps: ParticleSystem, delayMs: number): void {
  window.setTimeout(() => {
    try { ps.dispose(false); } catch { /* scene was already disposed */ }
  }, delayMs);
}

function startBurst(scene: Scene, origin: Vector3, color1: Color4, color2: Color4, count: number): void {
  if (scene.isDisposed) return;
  const ps = new ParticleSystem('level_up_firework_burst', 160, scene);
  ps.particleTexture = makeParticleTexture(scene);
  ps.emitter = origin;
  ps.minEmitBox = new Vector3(-0.03, -0.03, -0.03);
  ps.maxEmitBox = new Vector3(0.03, 0.03, 0.03);
  ps.color1 = color1;
  ps.color2 = color2;
  ps.colorDead = new Color4(color2.r * 0.25, color2.g * 0.25, color2.b * 0.25, 0);
  ps.minSize = 0.075;
  ps.maxSize = 0.16;
  ps.minLifeTime = 0.42;
  ps.maxLifeTime = 0.95;
  ps.emitRate = 900;
  ps.manualEmitCount = count;
  ps.minEmitPower = 1.1;
  ps.maxEmitPower = 2.8;
  ps.direction1 = new Vector3(-1.2, -0.25, -1.2);
  ps.direction2 = new Vector3(1.2, 1.35, 1.2);
  ps.gravity = new Vector3(0, -3.2, 0);
  ps.minAngularSpeed = -Math.PI * 2;
  ps.maxAngularSpeed = Math.PI * 2;
  ps.blendMode = ParticleSystem.BLENDMODE_ADD;
  ps.targetStopDuration = 0.06;
  ps.updateSpeed = 0.014;
  ps.start();
  window.setTimeout(() => ps.stop(), 80);
  disposeLater(ps, 1450);
}

function startFountain(scene: Scene, origin: Vector3): void {
  if (scene.isDisposed) return;
  const ps = new ParticleSystem('level_up_firework_fountain', 120, scene);
  ps.particleTexture = makeParticleTexture(scene);
  ps.emitter = origin;
  ps.minEmitBox = new Vector3(-0.12, -0.03, -0.12);
  ps.maxEmitBox = new Vector3(0.12, 0.03, 0.12);
  ps.color1 = new Color4(1, 0.93, 0.35, 1);
  ps.color2 = new Color4(0.45, 0.95, 1, 0.92);
  ps.colorDead = new Color4(1, 0.6, 0.15, 0);
  ps.minSize = 0.06;
  ps.maxSize = 0.12;
  ps.minLifeTime = 0.28;
  ps.maxLifeTime = 0.7;
  ps.emitRate = 260;
  ps.minEmitPower = 0.9;
  ps.maxEmitPower = 1.9;
  ps.direction1 = new Vector3(-0.42, 1.15, -0.42);
  ps.direction2 = new Vector3(0.42, 2.35, 0.42);
  ps.gravity = new Vector3(0, -2.4, 0);
  ps.blendMode = ParticleSystem.BLENDMODE_ADD;
  ps.targetStopDuration = 0.32;
  ps.updateSpeed = 0.012;
  ps.start();
  window.setTimeout(() => ps.stop(), 360);
  disposeLater(ps, 1250);
}

export class LevelUpFireworkEffect {
  static play(scene: Scene, position: Vector3): void {
    const base = position.clone();
    startFountain(scene, base.add(new Vector3(0, -0.55, 0)));
    startBurst(
      scene,
      base.add(new Vector3(-0.18, 0.08, 0.06)),
      new Color4(1, 0.95, 0.26, 1),
      new Color4(1, 0.42, 0.12, 0.95),
      42,
    );
    window.setTimeout(() => startBurst(
      scene,
      base.add(new Vector3(0.2, 0.22, -0.12)),
      new Color4(0.42, 0.95, 1, 1),
      new Color4(0.24, 0.45, 1, 0.95),
      34,
    ), 160);
    window.setTimeout(() => startBurst(
      scene,
      base.add(new Vector3(0.03, 0.38, 0.18)),
      new Color4(1, 0.55, 0.95, 1),
      new Color4(0.55, 0.36, 1, 0.92),
      30,
    ), 300);
  }
}
