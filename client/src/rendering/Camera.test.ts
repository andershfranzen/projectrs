import { describe, expect, test } from 'bun:test';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { GameCamera } from './Camera';

type ListenerCall = {
  type: string;
  listener: EventListenerOrEventListenerObject;
};

function createTestCanvas(): HTMLCanvasElement & { added: ListenerCall[]; removed: ListenerCall[] } {
  const canvas = {
    added: [] as ListenerCall[],
    removed: [] as ListenerCall[],
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      this.added.push({ type, listener });
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      this.removed.push({ type, listener });
    },
    ownerDocument: {
      addEventListener() {},
      removeEventListener() {},
    },
  };
  return canvas as unknown as HTMLCanvasElement & { added: ListenerCall[]; removed: ListenerCall[] };
}

describe('GameCamera locked zoom', () => {
  test('keeps max zoom-out when returning to the same pitch angle', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const gameCamera = new GameCamera(scene, createTestCanvas());
    const camera = gameCamera.getCamera();
    const target = new Vector3(0, 0, 0);

    gameCamera.zoomByFactor(10);
    const maxZoomRadius = camera.radius;
    const startingBeta = camera.beta;

    gameCamera.rotate(0, -10);
    gameCamera.followTarget(target);
    expect(camera.beta).toBeLessThan(startingBeta);

    gameCamera.rotate(0, 10);
    gameCamera.followTarget(target);

    expect(camera.beta).toBeCloseTo(startingBeta, 5);
    expect(camera.radius).toBeCloseTo(maxZoomRadius, 5);

    scene.dispose();
    engine.dispose();
  });

  test('keeps responsive Babylon camera input settings', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const gameCamera = new GameCamera(scene, createTestCanvas());
    const camera = gameCamera.getCamera();

    expect(camera.inertia).toBe(0.6);
    expect(camera.panningInertia).toBe(0);
    expect(camera.wheelPrecision).toBe(8);
    expect(camera.angularSensibilityX).toBe(565);
    expect(camera.angularSensibilityY).toBe(565);
    expect((camera.inputs.attached.pointers as any).buttons).toEqual([1]);

    scene.dispose();
    engine.dispose();
  });

  test('uses a responsive custom follow instead of pinning directly to the player', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const gameCamera = new GameCamera(scene, createTestCanvas());
    const camera = gameCamera.getCamera();

    const initial = gameCamera.followTarget(new Vector3(0, 0, 0), 0.02);
    const result = gameCamera.followTarget(new Vector3(1, 0, 0), 0.02);

    expect(initial.reason).toBe('initial');
    expect(result.snapped).toBe(false);
    expect(camera.target.x).toBeGreaterThan(0.5);
    expect(camera.target.x).toBeLessThan(0.6);
    expect(camera.target.z).toBeCloseTo(0, 5);

    scene.dispose();
    engine.dispose();
  });

  test('keeps custom follow frame-rate independent', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const singleStep = new GameCamera(scene, createTestCanvas());
    const splitStep = new GameCamera(scene, createTestCanvas());

    singleStep.followTarget(new Vector3(0, 0, 0), 0.02);
    singleStep.followTarget(new Vector3(0.3, 0, 0), 1 / 30);

    splitStep.followTarget(new Vector3(0, 0, 0), 0.02);
    splitStep.followTarget(new Vector3(0.3, 0, 0), 1 / 60);
    splitStep.followTarget(new Vector3(0.3, 0, 0), 1 / 60);

    expect(splitStep.getCamera().target.x).toBeCloseTo(singleStep.getCamera().target.x, 5);
    expect(splitStep.getCamera().target.z).toBeCloseTo(singleStep.getCamera().target.z, 5);

    scene.dispose();
    engine.dispose();
  });

  test('keeps tiny locked follow drift inside the dead zone', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const gameCamera = new GameCamera(scene, createTestCanvas());
    const camera = gameCamera.getCamera();

    gameCamera.followTarget(new Vector3(0, 0, 0), 0.02);
    const result = gameCamera.followTarget(new Vector3(0.02, 0, 0.02), 0.02);

    expect(result.snapped).toBe(false);
    expect(camera.target.x).toBeCloseTo(0, 5);
    expect(camera.target.z).toBeCloseTo(0, 5);

    scene.dispose();
    engine.dispose();
  });

  test('moves smoothly for meaningful sub-tile locked follow drift', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const gameCamera = new GameCamera(scene, createTestCanvas());
    const camera = gameCamera.getCamera();

    gameCamera.followTarget(new Vector3(0, 0, 0), 0.02);
    gameCamera.followTarget(new Vector3(0.3, 0, 0.3), 0.02);

    expect(camera.target.x).toBeGreaterThan(0.06);
    expect(camera.target.x).toBeLessThan(0.12);
    expect(camera.target.z).toBeCloseTo(camera.target.x, 5);

    scene.dispose();
    engine.dispose();
  });

  test('keeps a small bounded lag during sustained EvilQuest run cadence', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const gameCamera = new GameCamera(scene, createTestCanvas());
    const camera = gameCamera.getCamera();

    gameCamera.followTarget(new Vector3(0, 0, 0), 0.02);
    const runTilesPerSecond = 2 / 0.6;
    for (let frame = 1; frame <= 100; frame++) {
      const result = gameCamera.followTarget(new Vector3(runTilesPerSecond * 0.02 * frame, 0, 0), 0.02);
      expect(result.snapped).toBe(false);
    }

    const playerX = runTilesPerSecond * 2;
    expect(playerX - camera.target.x).toBeGreaterThan(0.05);
    expect(playerX - camera.target.x).toBeLessThan(0.45);

    scene.dispose();
    engine.dispose();
  });

  test('responds to diagonal run redirects without exceeding max lag', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const gameCamera = new GameCamera(scene, createTestCanvas());
    const camera = gameCamera.getCamera();

    gameCamera.followTarget(new Vector3(0, 0, 0), 0.02);
    const runTilesPerSecond = 2 / 0.6;
    let playerX = 0;
    let playerZ = 0;
    for (let frame = 1; frame <= 100; frame++) {
      playerX = runTilesPerSecond * 0.02 * frame;
      playerZ = playerX;
      gameCamera.followTarget(new Vector3(playerX, 0, playerZ), 0.02);
    }

    const beforeX = camera.target.x;
    const beforeZ = camera.target.z;
    for (let frame = 1; frame <= 10; frame++) {
      playerX -= runTilesPerSecond * 0.02;
      playerZ -= runTilesPerSecond * 0.02;
      gameCamera.followTarget(new Vector3(playerX, 0, playerZ), 0.02);
    }

    expect(camera.target.x).toBeLessThan(beforeX);
    expect(camera.target.z).toBeLessThan(beforeZ);
    expect(Math.hypot(playerX - camera.target.x, playerZ - camera.target.z)).toBeLessThan(0.45);

    scene.dispose();
    engine.dispose();
  });

  test('keeps custom follow smoothing when camera limits are unlocked for admins', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const gameCamera = new GameCamera(scene, createTestCanvas());
    const camera = gameCamera.getCamera();

    gameCamera.setLockedMode(false);
    const initial = gameCamera.followTarget(new Vector3(0, 0, 0), 0.02);
    const result = gameCamera.followTarget(new Vector3(1, 0, 0), 0.02);

    expect(initial.reason).toBe('initial');
    expect(result.locked).toBe(false);
    expect(result.snapped).toBe(false);
    expect(camera.target.x).toBeGreaterThan(0.5);
    expect(camera.target.x).toBeLessThan(0.6);
    expect(camera.target.y).toBeCloseTo(0, 5);
    expect(camera.target.z).toBeCloseTo(0, 5);

    scene.dispose();
    engine.dispose();
  });

  test('snaps the locked follow target on large position corrections', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const gameCamera = new GameCamera(scene, createTestCanvas());
    const camera = gameCamera.getCamera();

    gameCamera.followTarget(new Vector3(0, 0, 0), 0.02);
    const result = gameCamera.followTarget(new Vector3(5, 0, 0), 0.02);

    expect(result.reason).toBe('large-delta');
    expect(camera.target.x).toBeCloseTo(5, 5);
    expect(camera.target.z).toBeCloseTo(0, 5);

    scene.dispose();
    engine.dispose();
  });

  test('snaps the locked follow target when smoothing is disabled', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const gameCamera = new GameCamera(scene, createTestCanvas());
    const camera = gameCamera.getCamera();

    gameCamera.followTarget(new Vector3(0, 0, 0), 0.02);
    const result = gameCamera.followTarget(new Vector3(1, 0, 0), 0.02, false);

    expect(result.reason).toBe('smoothing-disabled');
    expect(camera.target.x).toBeCloseTo(1, 5);
    expect(camera.target.z).toBeCloseTo(0, 5);

    scene.dispose();
    engine.dispose();
  });

  test('removes its wheel listener on dispose', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const canvas = createTestCanvas();
    const gameCamera = new GameCamera(scene, canvas);

    gameCamera.dispose();

    const wheelListener = canvas.added.find(call => call.type === 'wheel')?.listener;
    expect(wheelListener).toBeDefined();
    if (!wheelListener) throw new Error('Expected GameCamera to register a wheel listener');
    expect(canvas.removed).toContainEqual({ type: 'wheel', listener: wheelListener });

    scene.dispose();
    engine.dispose();
  });
});
