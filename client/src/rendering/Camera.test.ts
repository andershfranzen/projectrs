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

  test('smooths the locked follow target instead of pinning directly to the player', () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const gameCamera = new GameCamera(scene, createTestCanvas());
    const camera = gameCamera.getCamera();

    const initial = gameCamera.followTarget(new Vector3(0, 0, 0), 0.02);
    const result = gameCamera.followTarget(new Vector3(1, 0, 0), 0.02);

    expect(initial.reason).toBe('initial');
    expect(result.snapped).toBe(false);
    expect(camera.target.x).toBeCloseTo(1 / 16, 5);
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
