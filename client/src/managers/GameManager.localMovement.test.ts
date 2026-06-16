import { describe, expect, test } from 'bun:test';
import { GameManager } from './GameManager';

type LocalPlayerStub = {
  modes: string[];
  positions: { x: number; y: number; z: number }[];
  directions: { dx: number; dz: number }[];
  walking: boolean;
  isWalking: () => boolean;
  startWalking: () => void;
  stopWalking: () => void;
  setMovementMode: (mode: string) => void;
  updateMovementDirection: (dx: number, dz: number) => void;
  setPositionXYZ: (x: number, y: number, z: number) => void;
};

function makeLocalPlayer(): LocalPlayerStub {
  const player: LocalPlayerStub = {
    modes: [],
    positions: [],
    directions: [],
    walking: false,
    isWalking: () => player.walking,
    startWalking: () => { player.walking = true; },
    stopWalking: () => { player.walking = false; },
    setMovementMode: (mode: string) => { player.modes.push(mode); },
    updateMovementDirection: (dx: number, dz: number) => {
      player.directions.push({ dx, dz });
    },
    setPositionXYZ: (x: number, y: number, z: number) => {
      player.positions.push({ x, y, z });
    },
  };
  return player;
}

function makeManager(path: { x: number; z: number }[], predictedSteps: number): { manager: any; player: LocalPlayerStub } {
  const manager = Object.create(GameManager.prototype) as any;
  const player = makeLocalPlayer();

  manager.movementMode = 'run';
  manager.path = path;
  manager.pathIndex = 0;
  manager.tileFrom = { x: 0.5, z: 0.5 };
  manager.tileProgress = 0;
  manager.playerX = 0.5;
  manager.playerZ = 0.5;
  manager.predictedPathUnitSteps = predictedSteps;
  manager.predictedPathStartedAt = 1;
  manager.predictedPathStart = { x: 0.5, z: 0.5 };
  manager.predictedPathDestination = null;
  manager.predictedPathAuthorityReanchorAttempts = 0;
  manager.recentPredictedArrivalUntil = 0;
  manager.recentPredictedArrivalStart = null;
  manager.recentPredictedArrivalPath = [];
  manager.recentPredictedArrivalDestination = null;
  manager.currentFloor = 0;
  manager.pendingPath = null;
  manager.isSkilling = false;
  manager.localCombatWalkUntilMs = 0;
  manager.pendingFaceTargetEntityId = -1;
  manager.entities = { npcTargets: new Map() };
  manager.destMarker = null;
  manager.minimap = null;
  manager.localPlayer = player;
  manager.inputManager = { setPlayerY: () => {} };
  manager.getHeight = () => 0;
  manager.shouldKeepLocalCombatWalkLoopAlive = () => false;
  manager.refreshLocalCombatFacing = () => {};

  return { manager, player };
}

function advanceLocalMovement(manager: any, seconds: number, camPos: any = null): void {
  let remaining = seconds;
  while (remaining > 0.000001) {
    const step = Math.min(0.1, remaining);
    manager.updateLocalPlayerMovement(step, camPos);
    remaining -= step;
  }
}

describe('GameManager local movement prediction', () => {
  test('carries leftover run time across compressed diagonal segments as tile distance', () => {
    const { manager, player } = makeManager([
      { x: 1.5, z: 1.5 },
      { x: 10.5, z: 10.5 },
    ], 10);

    advanceLocalMovement(manager, 0.31);

    expect(manager.pathIndex).toBe(1);
    expect(manager.playerX).toBeCloseTo(1.533333, 5);
    expect(manager.playerZ).toBeCloseTo(1.533333, 5);
    expect(player.positions.at(-1)).toEqual({ x: manager.playerX, y: 0, z: manager.playerZ });
    expect(player.modes.every(mode => mode === 'run')).toBe(true);
  });

  test('downgrades an odd final run tile to walk pace inside a compressed diagonal segment', () => {
    const { manager, player } = makeManager([
      { x: 3.5, z: 3.5 },
    ], 3);

    advanceLocalMovement(manager, 0.75);

    expect(manager.pathIndex).toBe(0);
    expect(manager.playerX).toBeCloseTo(2.75, 5);
    expect(manager.playerZ).toBeCloseTo(2.75, 5);
    expect(player.modes).toContain('run');
    expect(player.modes.at(-1)).toBe('walk');
  });

  test('aims local movement direction at the current unit step, not the far compressed waypoint', () => {
    const { manager, player } = makeManager([
      { x: 5.5, z: 0.5 },
    ], 5);

    manager.updateLocalPlayerMovement(0.1, {} as any);

    expect(manager.playerX).toBeCloseTo(0.833333, 5);
    expect(player.directions.at(-1)).toEqual({
      dx: 1.5 - manager.playerX,
      dz: 0,
    });
  });

  test('does not repay a long frame as a burst of visual movement', () => {
    const { manager } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);

    manager.updateLocalPlayerMovement(1, null);

    expect(manager.pathIndex).toBe(0);
    expect(manager.playerX).toBeCloseTo(0.833333, 5);
    expect(manager.playerZ).toBeCloseTo(0.5, 5);
  });

  test('ignores visible self authority while a predicted path is still draining', () => {
    const { manager } = makeManager([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
      { x: 3.5, z: 0.5 },
    ], 3);

    expect(manager.shouldIgnoreVisibleLocalAuthority(2.5, 0.5, false)).toBe(true);
    expect(manager.pathIndex).toBe(0);
    expect(manager.playerX).toBe(0.5);
  });

  test('hard-resets visible self authority only after a large active-path divergence', () => {
    const { manager, player } = makeManager([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
    ], 2);

    expect(manager.shouldIgnoreVisibleLocalAuthority(5.25, 0.5, false)).toBe(false);
    manager.reconcileLocalPlayerToServer(5.25, 0.5, false, false);

    expect(manager.path).toEqual([]);
    expect(manager.pathIndex).toBe(0);
    expect(manager.playerX).toBe(5.25);
    expect(player.positions.at(-1)).toEqual({ x: 5.25, y: 0, z: 0.5 });
    expect(player.walking).toBe(false);
  });

  test('does not ignore a large moving authority mismatch just because it is on the same route', () => {
    const { manager } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.playerX = 6.25;
    manager.playerZ = 0.5;

    expect(manager.shouldIgnoreVisibleLocalAuthority(1.5, 0.5, true)).toBe(false);
    expect(manager.shouldIgnoreVisibleLocalAuthority(2.0, 0.5, true)).toBe(true);
    expect(manager.shouldIgnoreVisibleLocalAuthority(1.5, 0.5, false)).toBe(false);
    expect(manager.shouldIgnoreVisibleLocalAuthority(6.25, 6.0, true)).toBe(false);
  });

  test('local authoritative move steps rewind an ahead run prediction to the server accepted tile', () => {
    const { manager, player } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.playerX = 6.25;
    manager.playerZ = 0.5;
    manager.tileProgress = 0.575;

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 1.5, z: 0.5, floor: 0, y: 0, mode: 'run' },
      { x: 2.5, z: 0.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(manager.pathIndex).toBe(0);
    expect(manager.tileProgress).toBe(0);
    expect(manager.tileFrom).toEqual({ x: 2.5, z: 0.5 });
    expect(manager.playerX).toBe(2.5);
    expect(manager.playerZ).toBe(0.5);
    expect(manager.predictedPathUnitSteps).toBe(8);
    expect(player.modes.at(-1)).toBe('run');
    expect(player.walking).toBe(true);
    expect(player.positions.at(-1)).toEqual({ x: 2.5, y: 0, z: 0.5 });
  });

  test('local authoritative move steps advance to the next waypoint when the server reaches it', () => {
    const { manager } = makeManager([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
      { x: 3.5, z: 0.5 },
    ], 3);
    manager.playerX = 2.25;
    manager.playerZ = 0.5;
    manager.pathIndex = 1;

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 1.5, z: 0.5, floor: 0, y: 0, mode: 'walk' },
    ]);

    expect(manager.pathIndex).toBe(1);
    expect(manager.tileFrom).toEqual({ x: 1.5, z: 0.5 });
    expect(manager.predictedPathUnitSteps).toBe(2);
  });

  test('hidden catch-up fast-forwards onto the predicted path without clearing the route', () => {
    const { manager, player } = makeManager([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
      { x: 3.5, z: 0.5 },
    ], 4);

    manager.reconcileLocalPlayerToServer(2.5, 0.5, true, true);
    advanceLocalMovement(manager, 0.3);

    expect(manager.predictedPathUnitSteps).toBe(1);
    expect(manager.pathIndex).toBe(2);
    expect(manager.playerX).toBeCloseTo(3.0, 5);
    expect(player.modes.at(-1)).toBe('walk');
  });

  test('hidden catch-up finishing on the final path tile completes arrival', () => {
    const { manager, player } = makeManager([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
    ], 2);

    manager.reconcileLocalPlayerToServer(2.5, 0.5, true, false);

    expect(manager.pathIndex).toBe(2);
    expect(manager.predictedPathUnitSteps).toBe(0);
    expect(manager.playerX).toBe(2.5);
    expect(player.walking).toBe(false);
    expect(player.positions.at(-1)).toEqual({ x: 2.5, y: 0, z: 0.5 });
  });

  test('does not ignore a stopped self-sync from an earlier route tile after predicted arrival', () => {
    const { manager, player } = makeManager([
      { x: 7.5, z: 0.5 },
    ], 7);

    advanceLocalMovement(manager, 2.5);

    expect(manager.pathIndex).toBe(1);
    expect(manager.playerX).toBeCloseTo(7.5, 5);
    expect(manager.shouldIgnoreVisibleLocalAuthority(0.5, 0.5, false)).toBe(false);
    expect(manager.playerX).toBeCloseTo(7.5, 5);
    expect(player.positions.at(-1)).toEqual({ x: 7.5, y: 0, z: 0.5 });
  });

  test('expires recent-arrival stale-route protection', () => {
    const { manager } = makeManager([
      { x: 7.5, z: 0.5 },
    ], 7);

    advanceLocalMovement(manager, 2.5);
    manager.recentPredictedArrivalUntil = performance.now() - 1;

    expect(manager.shouldIgnoreVisibleLocalAuthority(0.5, 0.5, false)).toBe(false);
  });

  test('keeps recent-arrival protection after destination confirmation until the grace expires', () => {
    const { manager } = makeManager([
      { x: 7.5, z: 0.5 },
    ], 7);

    advanceLocalMovement(manager, 2.5);

    expect(manager.shouldIgnoreVisibleLocalAuthority(7.5, 0.5, false)).toBe(true);
    expect(manager.recentPredictedArrivalUntil).toBeGreaterThan(performance.now());
    expect(manager.shouldIgnoreVisibleLocalAuthority(0.5, 0.5, false)).toBe(false);
  });

  test('can preserve destination-only recent-arrival protection through arrival-side cleanup', () => {
    const { manager } = makeManager([
      { x: 7.5, z: 0.5 },
    ], 7);

    advanceLocalMovement(manager, 2.5);
    manager.clearPredictedPath(false, false);

    expect(manager.shouldIgnoreVisibleLocalAuthority(7.5, 0.5, false)).toBe(true);
    expect(manager.shouldIgnoreVisibleLocalAuthority(0.5, 0.5, false)).toBe(false);
  });

  test('default path clearing removes recent-arrival protection for explicit resets', () => {
    const { manager } = makeManager([
      { x: 7.5, z: 0.5 },
    ], 7);

    advanceLocalMovement(manager, 2.5);
    manager.clearPredictedPath();

    expect(manager.shouldIgnoreVisibleLocalAuthority(0.5, 0.5, false)).toBe(false);
  });

  test('idle stopped authority hard-resets a real mismatch', () => {
    const { manager, player } = makeManager([
      { x: 1.5, z: 0.5 },
    ], 1);
    manager.pathIndex = manager.path.length;
    manager.playerX = 1.5;
    manager.playerZ = 0.5;
    player.walking = true;

    expect(manager.shouldIgnoreVisibleLocalAuthority(2.0, 0.5, false)).toBe(false);
    manager.reconcileLocalPlayerToServer(2.0, 0.5, false, false);

    expect(manager.path).toEqual([]);
    expect(manager.pathIndex).toBe(0);
    expect(manager.playerX).toBe(2.0);
    expect(player.walking).toBe(false);
    expect(player.positions.at(-1)).toEqual({ x: 2.0, y: 0, z: 0.5 });
  });

  test('preserves combat walk grace when stopped authority hard-resets the local path', () => {
    const { manager, player } = makeManager([
      { x: 1.5, z: 0.5 },
    ], 1);
    manager.shouldKeepLocalCombatWalkLoopAlive = () => true;
    player.walking = true;

    manager.reconcileLocalPlayerToServer(1.5, 0.5, false, false);

    expect(manager.localCombatWalkUntilMs).toBeGreaterThan(performance.now());
    expect(player.walking).toBe(true);
  });

  test('ignores small idle jitter and moving authority inside the hard-reset window', () => {
    const { manager } = makeManager([
      { x: 1.5, z: 0.5 },
    ], 1);

    manager.pathIndex = manager.path.length;
    manager.playerX = 1.5;
    manager.playerZ = 0.5;

    expect(manager.shouldIgnoreVisibleLocalAuthority(1.75, 0.5, false)).toBe(true);
    expect(manager.shouldIgnoreVisibleLocalAuthority(4.5, 0.5, true)).toBe(true);
  });
});
