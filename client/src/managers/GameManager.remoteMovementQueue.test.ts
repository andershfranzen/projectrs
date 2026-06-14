import { afterEach, describe, expect, test } from 'bun:test';
import { GameManager } from './GameManager';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function installTimerWindow(): { clearCalls: number[] } {
  const clearCalls: number[] = [];
  let nextTimerId = 1;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout: () => nextTimerId++,
      clearTimeout: (timerId: number) => { clearCalls.push(timerId); },
    },
  });
  return { clearCalls };
}

function restoreWindow(): void {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
}

function makeManager(): any {
  const manager = Object.create(GameManager.prototype) as any;
  manager.entities = { remoteMovementStepQueues: new Map() };
  manager.remoteMovementStepStash = new Map();
  manager.remoteMovementStepStashTimers = new Map();
  return manager;
}

function step(x: number, z: number) {
  return { x, z, floor: 0, y: 0, mode: 'run' as const };
}

afterEach(() => {
  restoreWindow();
});

describe('GameManager remote movement step queues', () => {
  test('stashes a current queue so paired step packets can append without dropping tail steps', () => {
    const { clearCalls } = installTimerWindow();
    const manager = makeManager();
    manager.entities.remoteMovementStepQueues.set(7, [step(10.5, 10.5)]);

    manager.stashRemoteMovementStepQueue(7);

    expect(manager.entities.remoteMovementStepQueues.has(7)).toBe(false);
    expect(manager.remoteMovementStepStash.get(7)).toEqual([step(10.5, 10.5)]);

    const queuedCount = manager.queueRemoteMovementSteps(7, [step(11.5, 10.5)]);

    expect(queuedCount).toBe(2);
    expect(manager.entities.remoteMovementStepQueues.get(7)).toEqual([
      step(10.5, 10.5),
      step(11.5, 10.5),
    ]);
    expect(manager.remoteMovementStepStash.has(7)).toBe(false);
    expect(manager.remoteMovementStepStashTimers.has(7)).toBe(false);
    expect(clearCalls).toEqual([1]);
  });

  test('drops a stashed queue when the next authoritative step batch is not contiguous', () => {
    installTimerWindow();
    const manager = makeManager();
    manager.entities.remoteMovementStepQueues.set(7, [step(10.5, 10.5)]);

    manager.stashRemoteMovementStepQueue(7);
    const queuedCount = manager.queueRemoteMovementSteps(7, [step(14.5, 10.5)]);

    expect(queuedCount).toBe(1);
    expect(manager.entities.remoteMovementStepQueues.get(7)).toEqual([step(14.5, 10.5)]);
    expect(manager.remoteMovementStepStash.has(7)).toBe(false);
  });
});
