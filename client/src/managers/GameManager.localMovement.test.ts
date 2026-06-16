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
  clearFaceLock: () => void;
  isSkillAnimPlaying: () => boolean;
  resetTransientAnimation: () => void;
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
    clearFaceLock: () => {},
    isSkillAnimPlaying: () => false,
    resetTransientAnimation: () => {},
  };
  return player;
}

function makeManager(
  path: { x: number; z: number }[],
  predictedSteps: number,
): { manager: any; player: LocalPlayerStub; floorUpdates: number[]; sentMoves: Array<{ path: { x: number; z: number }[]; mode: string }> } {
  const manager = Object.create(GameManager.prototype) as any;
  const player = makeLocalPlayer();
  const floorUpdates: number[] = [];
  const sentMoves: Array<{ path: { x: number; z: number }[]; mode: string }> = [];

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
  manager.recentPredictedArrivalUntil = 0;
  manager.recentPredictedArrivalDestination = null;
  manager.recentPredictedArrivalRouteTiles = new Set();
  manager.lastLocalMoveCommandAt = 0;
  manager.localAuthoritativeTileHeights = new Map();
  manager.pendingSelfMoveStepsByTick = [];
  manager.selfAuthorityRouteTargetSteps = 0;
  manager.selfAuthorityRedirectGraceUntil = 0;
  manager.selfAuthorityRedirectStaleRouteTiles = new Set();
  manager.currentFloor = 0;
  manager.isSkilling = false;
  manager.localCombatWalkUntilMs = 0;
  manager.pendingFaceTargetEntityId = -1;
  manager.entities = { npcTargets: new Map() };
  manager.destMarker = null;
  manager.minimap = null;
  manager.localPlayer = player;
  manager.network = {
    sendMove: (movePath: { x: number; z: number }[], mode: string) => {
      sentMoves.push({ path: movePath, mode });
      return true;
    },
  };
  manager.inputManager = { setPlayerY: () => {} };
  manager.chunkManager = {
    setCurrentFloor: (floor: number) => { floorUpdates.push(floor); },
    getMapWidth: () => 128,
    getMapHeight: () => 128,
    getEffectiveHeight: () => 0,
  };
  manager.getHeight = () => 0;
  manager.isTileBlocked = () => false;
  manager.isWallBlockedForPath = () => false;
  manager.refreshHoverHiddenRoofs = () => {};
  manager.shouldKeepLocalCombatWalkLoopAlive = () => false;
  manager.refreshLocalCombatFacing = () => {};

  return { manager, player, floorUpdates, sentMoves };
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

  test('keeps travel facing updated while skilling is queued during movement', () => {
    const { manager, player } = makeManager([
      { x: 1.5, z: 0.5 },
      { x: 1.5, z: 1.5 },
    ], 2);
    manager.isSkilling = true;

    advanceLocalMovement(manager, 0.31, {} as any);

    expect(manager.pathIndex).toBe(1);
    expect(player.directions.at(-1)).toEqual({
      dx: 0,
      dz: 1.5 - manager.playerZ,
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

  test('lands on a unit tile for a rendered frame before continuing through a turn', () => {
    const { manager } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.tileProgress = 0.095;
    manager.playerX = 1.45;

    manager.updateLocalPlayerMovement(0.1, null);

    expect(manager.pathIndex).toBe(0);
    expect(manager.tileProgress).toBeCloseTo(0.1, 6);
    expect(manager.playerX).toBeCloseTo(1.5, 6);
    expect(manager.playerZ).toBeCloseTo(0.5, 6);
  });

  test('route replacement while mid-step preserves the current unit tile before turning', () => {
    const { manager, player } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.tileProgress = 0.05;
    manager.playerX = 1.0;
    manager.playerZ = 0.5;

    manager.startLocalPredictedPath([
      { x: 2.5, z: 1.5 },
      { x: 2.5, z: 8.5 },
    ], true, true);

    expect(manager.path[0]).toEqual({ x: 1.5, z: 0.5 });
    expect(manager.path[1]).toEqual({ x: 2.5, z: 1.5 });
    expect(manager.tileFrom).toEqual({ x: 0.5, z: 0.5 });
    expect(manager.tileProgress).toBe(0.5);
    expect(manager.playerX).toBe(1.0);
    expect(player.directions.at(-1)).toEqual({
      dx: 1.5 - manager.playerX,
      dz: 0,
    });

    manager.updateLocalPlayerMovement(0.01, {} as any);

    expect(player.directions.at(-1)).toEqual({
      dx: 1.5 - manager.playerX,
      dz: 0,
    });
  });

  test('duplicate active destination clicks do not resend or rewrite local movement', () => {
    const { manager, sentMoves } = makeManager([
      { x: 1.5, z: 0.5 },
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.predictedPathDestination = { x: 10.5, z: 0.5 };
    manager.tileProgress = 0.25;
    manager.playerX = 0.75;

    const started = manager.startPredictedPath([
      { x: 1.5, z: 0.5 },
      { x: 10.5, z: 0.5 },
    ], true);

    expect(started).toBe(false);
    expect(sentMoves).toEqual([]);
    expect(manager.path).toEqual([
      { x: 1.5, z: 0.5 },
      { x: 10.5, z: 0.5 },
    ]);
    expect(manager.tileProgress).toBe(0.25);
    expect(manager.playerX).toBe(0.75);
  });

  test('active interaction redirects can replace a route with the same destination tile', () => {
    const { manager, sentMoves } = makeManager([
      { x: 1.5, z: 0.5 },
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.predictedPathDestination = { x: 10.5, z: 0.5 };
    manager.tileProgress = 0.25;
    manager.playerX = 0.75;

    const started = manager.startPredictedPath([
      { x: 1.5, z: 1.5 },
      { x: 10.5, z: 0.5 },
    ], true, { coalesceDuplicateDestination: false });

    expect(started).toBe(true);
    expect(sentMoves).toEqual([{
      path: [
        { x: 1.5, z: 1.5 },
        { x: 10.5, z: 0.5 },
      ],
      mode: 'run',
    }]);
    expect(manager.path).toEqual([
      { x: 1.5, z: 0.5 },
      { x: 1.5, z: 1.5 },
      { x: 10.5, z: 0.5 },
    ]);
  });

  test('repeated duplicate destination clicks leave the active run route untouched', () => {
    const { manager, sentMoves } = makeManager([
      { x: 1.5, z: 0.5 },
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.predictedPathDestination = { x: 10.5, z: 0.5 };
    manager.tileProgress = 0.25;
    manager.playerX = 0.75;

    for (let i = 0; i < 12; i++) {
      const started = manager.startPredictedPath([
        { x: 1.5, z: 0.5 },
        { x: 10.5, z: 0.5 },
      ], true);
      expect(started).toBe(false);
    }

    expect(sentMoves).toEqual([]);
    expect(manager.path).toEqual([
      { x: 1.5, z: 0.5 },
      { x: 10.5, z: 0.5 },
    ]);
    expect(manager.tileProgress).toBe(0.25);
    expect(manager.playerX).toBe(0.75);
    expect(manager.selfAuthorityRedirectGraceUntil).toBe(0);
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

  test('local authoritative move steps do not rewind an active on-route prediction', () => {
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
    expect(manager.tileProgress).toBe(0.575);
    expect(manager.tileFrom).toEqual({ x: 0.5, z: 0.5 });
    expect(manager.playerX).toBe(6.25);
    expect(manager.playerZ).toBe(0.5);
    expect(manager.predictedPathUnitSteps).toBe(10);
    expect(player.modes.at(-1)).toBe('run');
    expect(player.walking).toBe(true);
    expect(player.positions).toEqual([]);
  });

  test('local authoritative move steps catch up smoothly when the server is ahead on the same route', () => {
    const { manager, player } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 5.5, z: 0.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(manager.playerX).toBe(0.5);
    expect(manager.pathIndex).toBe(0);
    expect(manager.selfAuthorityRouteTargetSteps).toBe(5);
    expect(player.positions).toEqual([]);

    advanceLocalMovement(manager, 0.3);

    expect(manager.playerX).toBeGreaterThan(1.5);
    expect(manager.playerX).toBeLessThan(5.5);
    expect(manager.pathIndex).toBe(0);
  });

  test('local authoritative move steps ignore stale off-route packets after a running redirect', () => {
    const { manager, player } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.tileProgress = 0.05;
    manager.playerX = 1.0;
    manager.playerZ = 0.5;

    manager.startLocalPredictedPath([
      { x: 1.5, z: 0.5 },
      { x: 1.5, z: 8.5 },
    ], true, true);

    expect(manager.selfAuthorityRedirectGraceUntil).toBeGreaterThan(performance.now());

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 4.5, z: 0.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(manager.path).toEqual([
      { x: 1.5, z: 0.5 },
      { x: 1.5, z: 8.5 },
    ]);
    expect(manager.pathIndex).toBe(0);
    expect(manager.tileFrom).toEqual({ x: 0.5, z: 0.5 });
    expect(manager.tileProgress).toBe(0.5);
    expect(manager.playerX).toBe(1.0);
    expect(manager.playerZ).toBe(0.5);
    expect(player.positions).toEqual([]);

    manager.selfAuthorityRedirectGraceUntil = performance.now() - 1;

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 4.5, z: 0.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(manager.path.length).toBeGreaterThan(0);
    expect(manager.path.at(-1)).toEqual({ x: 1.5, z: 8.5 });
    expect(manager.playerX).toBe(1.0);
    expect(manager.playerZ).toBe(0.5);
    expect(player.positions).toEqual([]);
  });

  test('redirect stale authority guard only ignores tiles outside the new route', () => {
    const { manager } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.tileProgress = 0.05;
    manager.playerX = 1.0;
    manager.playerZ = 0.5;

    manager.startLocalPredictedPath([
      { x: 1.5, z: 0.5 },
      { x: 1.5, z: 8.5 },
    ], true, true);

    expect(manager.shouldIgnoreRedirectStaleLocalAuthority(4.5, 0.5)).toBe(true);
    expect(manager.shouldIgnoreRedirectStaleLocalAuthority(1.5, 5.5)).toBe(false);
    expect(manager.shouldIgnoreRedirectStaleLocalAuthority(4.5, 4.5)).toBe(false);
  });

  test('recent click redirect retargets nearby off-route authority instead of deferring into a later snap', () => {
    const { manager, player } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.tileProgress = 0.05;
    manager.playerX = 1.0;
    manager.playerZ = 0.5;

    manager.startLocalPredictedPath([
      { x: 1.5, z: 0.5 },
      { x: 1.5, z: 8.5 },
    ], true, true);
    manager.lastLocalMoveCommandAt = performance.now();

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 2.5, z: 1.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(manager.path[0]).toEqual({ x: 1.5, z: 0.5 });
    expect(manager.path[1]).toEqual({ x: 2.5, z: 1.5 });
    expect(manager.path.at(-1)).toEqual({ x: 1.5, z: 8.5 });
    expect(manager.pathIndex).toBe(0);
    expect(manager.playerX).toBe(1.0);
    expect(manager.playerZ).toBe(0.5);
    expect(player.positions).toEqual([]);
  });

  test('nearby authoritative recovery turns retarget the local route without teleporting', () => {
    const { manager, player } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.tileProgress = 0.05;
    manager.playerX = 1.0;
    manager.playerZ = 0.5;

    manager.startLocalPredictedPath([
      { x: 1.5, z: 0.5 },
      { x: 1.5, z: 8.5 },
    ], true, true);

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 2.5, z: 1.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(player.positions).toEqual([]);
    expect(manager.playerX).toBe(1.0);
    expect(manager.playerZ).toBe(0.5);
    expect(manager.pathIndex).toBe(0);
    expect(manager.path[0]).toEqual({ x: 1.5, z: 0.5 });
    expect(manager.path[1]).toEqual({ x: 2.5, z: 1.5 });
    expect(manager.path.at(-1)).toEqual({ x: 1.5, z: 8.5 });
    expect(manager.selfAuthorityRouteTargetSteps).toBeGreaterThan(0);
  });

  test('local authoritative move steps queue catch-up when visually idle and behind', () => {
    const { manager, player } = makeManager([], 0);

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 5.5, z: 0.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(player.positions).toEqual([]);
    expect(player.walking).toBe(true);
    expect(manager.playerX).toBe(0.5);
    expect(manager.playerZ).toBe(0.5);
    expect(manager.path.length).toBeGreaterThan(0);
    expect(manager.path.at(-1)).toEqual({ x: 5.5, z: 0.5 });
    expect(manager.selfAuthorityRouteTargetSteps).toBeGreaterThan(0);
  });

  test('moving self-sync authority queues catch-up instead of hard resetting idle visuals', () => {
    const { manager, player } = makeManager([], 0);

    const queued = manager.retargetPredictedPathThroughAuthority([
      { x: 5.5, z: 0.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(queued).toBe(true);
    expect(player.positions).toEqual([]);
    expect(player.walking).toBe(true);
    expect(manager.playerX).toBe(0.5);
    expect(manager.path.at(-1)).toEqual({ x: 5.5, z: 0.5 });
  });

  test('same-route self-sync authority catches up without rebuilding the route', () => {
    const { manager, player } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.playerX = 1.25;
    manager.playerZ = 0.5;
    manager.tileProgress = 0.075;

    const queued = manager.retargetPredictedPathThroughAuthority([
      { x: 5.5, z: 0.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(queued).toBe(false);
    expect(player.positions).toEqual([]);
    expect(manager.playerX).toBe(1.25);
    expect(manager.path).toEqual([{ x: 10.5, z: 0.5 }]);
    expect(manager.selfAuthorityRouteTargetSteps).toBeGreaterThan(0);

    advanceLocalMovement(manager, 0.3);

    expect(manager.playerX).toBeGreaterThan(1.5);
    expect(player.positions.at(-1)?.x).toBe(manager.playerX);
  });

  test('stopped authority at the predicted destination catches up instead of snapping', () => {
    const { manager, player } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.playerX = 1.25;
    manager.playerZ = 0.5;
    manager.tileProgress = 0.075;

    const queued = manager.retargetPredictedPathThroughAuthority([
      { x: 10.5, z: 0.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(queued).toBe(false);
    expect(manager.shouldIgnoreVisibleLocalAuthority(10.5, 0.5, false)).toBe(false);
    expect(player.positions).toEqual([]);
    expect(manager.playerX).toBe(1.25);
    expect(manager.path).toEqual([{ x: 10.5, z: 0.5 }]);
    expect(manager.selfAuthorityRouteTargetSteps).toBe(10);

    advanceLocalMovement(manager, 0.3);

    expect(manager.playerX).toBeGreaterThan(1.5);
    expect(manager.playerX).toBeLessThan(10.5);
    expect(player.positions.at(-1)?.x).toBe(manager.playerX);
  });

  test('same-tile authority jitter does not create a catch-up route', () => {
    const { manager } = makeManager([], 0);

    const queued = manager.retargetPredictedPathThroughAuthority([
      { x: 0.55, z: 0.5, floor: 0, y: 0, mode: 'walk' },
    ]);

    expect(queued).toBe(false);
    expect(manager.path).toEqual([]);
  });

  test('far authoritative mismatches still hard reset active prediction', () => {
    const { manager, player } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);

    manager.startLocalPredictedPath([
      { x: 10.5, z: 0.5 },
    ], true, true);

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 30.5, z: 30.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(manager.path).toEqual([]);
    expect(manager.playerX).toBe(30.5);
    expect(manager.playerZ).toBe(30.5);
    expect(player.positions.at(-1)).toEqual({ x: 30.5, y: 0, z: 30.5 });
  });

  test('nearby off-route authority retargets instead of resetting an active prediction', () => {
    const { manager, player } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.playerX = 2.25;
    manager.playerZ = 0.5;

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 1.5, z: 1.5, floor: 0, y: 0, mode: 'walk' },
    ]);

    expect(manager.path.length).toBeGreaterThan(0);
    expect(manager.pathIndex).toBe(0);
    expect(manager.playerX).toBe(2.25);
    expect(manager.playerZ).toBe(0.5);
    expect(player.positions).toEqual([]);
  });

  test('local authoritative move corrections apply server floor but render client floor height', () => {
    const { manager, player, floorUpdates } = makeManager([], 0);
    manager.chunkManager.getEffectiveHeight = (_x: number, _z: number, floor?: number) => floor === 2 ? 4.25 : 0;

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 1.5, z: 0.5, floor: 2, y: 9.5, mode: 'walk' },
    ]);

    expect(manager.playerX).toBe(1.5);
    expect(manager.playerZ).toBe(0.5);
    expect(manager.currentFloor).toBe(2);
    expect(floorUpdates).toEqual([2]);
    expect(player.positions.at(-1)).toEqual({ x: 1.5, y: 4.25, z: 0.5 });
  });

  test('queued local authoritative move steps wait for their matching self-sync tick', () => {
    const { manager, player } = makeManager([], 0);

    manager.queuePendingSelfMoveSteps(12, [
      { x: 1.5, z: 0.5, floor: 0, y: 0, mode: 'walk' },
    ]);
    manager.applyPendingSelfMoveStepsForTick(11);

    expect(manager.playerX).toBe(0.5);
    expect(player.positions).toEqual([]);

    manager.applyPendingSelfMoveStepsForTick(12);

    expect(manager.playerX).toBe(0.5);
    expect(manager.tileFrom).toEqual({ x: 0.5, z: 0.5 });
    expect(manager.path.at(-1)).toEqual({ x: 1.5, z: 0.5 });
    expect(player.positions).toEqual([]);
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

  test('ignores a stale stopped self-sync from an earlier route tile after predicted arrival', () => {
    const { manager, player } = makeManager([
      { x: 7.5, z: 0.5 },
    ], 7);

    advanceLocalMovement(manager, 2.5);

    expect(manager.pathIndex).toBe(1);
    expect(manager.playerX).toBeCloseTo(7.5, 5);
    expect(manager.shouldIgnoreVisibleLocalAuthority(0.5, 0.5, false)).toBe(true);
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
    expect(manager.shouldIgnoreVisibleLocalAuthority(0.5, 0.5, false)).toBe(true);
  });

  test('duplicate destination clicks after predicted arrival do not resend while authority catches up', () => {
    const { manager, sentMoves } = makeManager([
      { x: 7.5, z: 0.5 },
    ], 7);

    advanceLocalMovement(manager, 2.5);

    const started = manager.startPredictedPath([
      { x: 7.5, z: 0.5 },
    ]);

    expect(started).toBe(false);
    expect(sentMoves).toEqual([]);
    expect(manager.pathIndex).toBe(1);
    expect(manager.playerX).toBeCloseTo(7.5, 5);
    expect(manager.recentPredictedArrivalUntil).toBeGreaterThan(performance.now());
  });

  test('delayed self move steps on a recently completed route do not retarget backward', () => {
    const { manager, player } = makeManager([
      { x: 7.5, z: 0.5 },
    ], 7);

    advanceLocalMovement(manager, 2.5);
    manager.latestSelfSync = { x: 7.5, z: 0.5, moving: false };

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 3.5, z: 0.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(manager.pathIndex).toBe(1);
    expect(manager.playerX).toBeCloseTo(7.5, 5);
    expect(manager.playerZ).toBeCloseTo(0.5, 5);
    expect(manager.recentPredictedArrivalUntil).toBeGreaterThan(performance.now());
    expect(manager.latestSelfSync).toEqual({ x: 7.5, z: 0.5, moving: false });
    expect(player.positions.at(-1)).toEqual({ x: 7.5, y: 0, z: 0.5 });
  });

  test('far old self move steps after a recent click route do not snap idle visuals backward', () => {
    const { manager, player } = makeManager([], 0);
    manager.playerX = 20.5;
    manager.playerZ = 20.5;
    manager.setTileFrom(20.5, 20.5);
    manager.lastLocalMoveCommandAt = performance.now();
    manager.recentPredictedArrivalUntil = performance.now() + 1000;
    manager.recentPredictedArrivalDestination = { x: 20.5, z: 20.5 };
    manager.recentPredictedArrivalRouteTiles = new Set(['20,20']);

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 10.5, z: 10.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(manager.playerX).toBe(20.5);
    expect(manager.playerZ).toBe(20.5);
    expect(manager.path).toEqual([]);
    expect(manager.localAuthoritativeTileHeights.size).toBe(0);
    expect(player.positions).toEqual([]);
  });

  test('new path after predicted arrival keeps old route protected from stale authority', () => {
    const { manager, player } = makeManager([
      { x: 7.5, z: 0.5 },
    ], 7);

    advanceLocalMovement(manager, 2.5);
    manager.startLocalPredictedPath([
      { x: 8.5, z: 1.5 },
    ], true, true);

    expect(manager.selfAuthorityRedirectGraceUntil).toBeGreaterThan(performance.now());

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 3.5, z: 0.5, floor: 0, y: 0, mode: 'run' },
    ]);

    expect(manager.path).toEqual([
      { x: 8.5, z: 1.5 },
    ]);
    expect(manager.pathIndex).toBe(0);
    expect(manager.playerX).toBeCloseTo(7.5, 5);
    expect(manager.playerZ).toBeCloseTo(0.5, 5);
    expect(player.positions.at(-1)).toEqual({ x: 7.5, y: 0, z: 0.5 });
  });

  test('recent local move commands defer stale stopped authority while prediction is active', () => {
    const { manager, player } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.lastLocalMoveCommandAt = performance.now();
    manager.playerX = 3.5;
    manager.playerZ = 0.5;
    manager.tileProgress = 0.3;

    expect(manager.shouldDeferStoppedLocalAuthority(0.5, 2.5, false)).toBe(true);
    expect(manager.shouldDeferStoppedLocalAuthority(0.5, 2.5, true)).toBe(false);

    if (!manager.shouldDeferStoppedLocalAuthority(0.5, 2.5, false)) {
      manager.reconcileLocalPlayerToServer(0.5, 2.5, false, false);
    }

    expect(manager.path).toEqual([{ x: 10.5, z: 0.5 }]);
    expect(manager.playerX).toBe(3.5);
    expect(player.positions).toEqual([]);
  });

  test('expired local move command grace allows real stopped authority correction', () => {
    const { manager, player } = makeManager([
      { x: 10.5, z: 0.5 },
    ], 10);
    manager.lastLocalMoveCommandAt = performance.now() - 10_000;
    manager.playerX = 3.5;
    manager.playerZ = 0.5;

    expect(manager.shouldDeferStoppedLocalAuthority(0.5, 2.5, false)).toBe(false);
    manager.reconcileLocalPlayerToServer(0.5, 2.5, false, false);

    expect(manager.path).toEqual([]);
    expect(manager.playerX).toBe(0.5);
    expect(manager.playerZ).toBe(2.5);
    expect(player.positions.at(-1)).toEqual({ x: 0.5, y: 0, z: 2.5 });
  });

  test('server-confirmed movement floor is applied before arrival terrain height is sampled', () => {
    const { manager, player, floorUpdates } = makeManager([
      { x: 1.5, z: 0.5 },
    ], 1);
    manager.chunkManager.getEffectiveHeight = (_x: number, _z: number, floor?: number) => floor === 1 ? 4.2 : 0;

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 1.5, z: 0.5, floor: 1, y: 4.2, mode: 'walk' },
    ]);

    advanceLocalMovement(manager, 0.7);

    expect(manager.playerX).toBeCloseTo(1.5, 5);
    expect(manager.currentFloor).toBe(1);
    expect(floorUpdates.at(-1)).toBe(1);
    expect(player.positions.at(-1)).toEqual({ x: 1.5, y: 4.2, z: 0.5 });
  });

  test('path arrival does not snap visual height to cached server tile height', () => {
    const { manager, player } = makeManager([
      { x: 1.5, z: 0.5 },
    ], 1);
    manager.chunkManager.getEffectiveHeight = (x: number, z: number) => x + z;

    manager.applyLocalAuthoritativeMoveSteps([
      { x: 1.5, z: 0.5, floor: 0, y: 5.25, mode: 'walk' },
    ]);

    advanceLocalMovement(manager, 0.7);

    expect(manager.playerX).toBeCloseTo(1.5, 5);
    expect(player.positions.at(-1)).toEqual({ x: 1.5, y: 2, z: 0.5 });
  });

  test('ordinary path clears keep server floor without forcing server height visually', () => {
    const { manager, floorUpdates } = makeManager([
      { x: 3.5, z: 4.5 },
    ], 1);
    manager.playerX = 3.5;
    manager.playerZ = 4.5;
    manager.chunkManager.getEffectiveHeight = (_x: number, _z: number, floor?: number) => floor === 1 ? 2.25 : 1.25;
    manager.noteLocalAuthoritativeTileHeight(3.5, 4.5, 1, 5.25);

    manager.clearPredictedPath();
    manager.applyLocalAuthoritativeFloorForCurrentTile();

    expect(manager.getLocalPlayerRenderHeight()).toBe(2.25);
    expect(manager.getLocalPlayerRenderHeight(performance.now(), true)).toBe(5.25);
    expect(manager.currentFloor).toBe(1);
    expect(floorUpdates.at(-1)).toBe(1);
  });

  test('active local movement uses smooth terrain height instead of cached tile authority', () => {
    const { manager, player } = makeManager([
      { x: 1.5, z: 0.5 },
    ], 1);
    manager.chunkManager.getEffectiveHeight = (x: number, z: number) => x + z;
    manager.noteLocalAuthoritativeTileHeight(0.5, 0.5, 0, 5.25);

    advanceLocalMovement(manager, 0.1);

    const rendered = player.positions.at(-1);
    expect(rendered).toBeDefined();
    expect(rendered!.y).toBeCloseTo(rendered!.x + rendered!.z, 5);
    expect(rendered!.y).not.toBe(5.25);
  });

  test('can preserve recent-arrival route protection through arrival-side cleanup', () => {
    const { manager } = makeManager([
      { x: 7.5, z: 0.5 },
    ], 7);

    advanceLocalMovement(manager, 2.5);
    manager.clearPredictedPath(false, false);

    expect(manager.shouldIgnoreVisibleLocalAuthority(7.5, 0.5, false)).toBe(true);
    expect(manager.shouldIgnoreVisibleLocalAuthority(0.5, 0.5, false)).toBe(true);
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
