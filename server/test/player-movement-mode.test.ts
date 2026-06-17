import { describe, expect, test } from 'bun:test';
import {
  RUN_ENERGY_MAX,
  RUN_ENERGY_MIN_TO_RUN,
  TICK_RATE,
  movementTilesPerTick,
  runEnergyDrainPerRunTick,
  runEnergyRecoverPerTick,
} from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function makePlayer(): Player {
  return new Player('runner', 0.5, 0.5, fakeWs, 1);
}

function processMovementTick(player: Player, tick: number): number {
  player.movementCredit += player.movementCreditPerTick();
  let moved = 0;
  while (player.hasMoveQueue() && player.movementCredit >= 1) {
    if (!player.processMovement(tick)) break;
    moved++;
  }
  return moved;
}

function makeMovementModeWorld(player: Player) {
  const packets: Array<{ kind: 'mode' | 'energy' | 'broadcast'; value?: number | string }> = [];
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[player.id, player]]);
  world.sendMovementMode = (_viewer: Player, subject: Player) => {
    packets.push({ kind: 'mode', value: subject.movementMode });
  };
  world.sendRunEnergy = (subject: Player) => {
    packets.push({ kind: 'energy', value: subject.runEnergyPercent() });
  };
  world.broadcastMovementMode = (subject: Player) => {
    packets.push({ kind: 'broadcast', value: subject.movementMode });
  };
  return { world, packets };
}

function makeMoveRequestWorld(player: Player) {
  const result = makeMovementModeWorld(player);
  Object.assign(result.world, {
    activeDuels: new Map(),
    sultansMineDoorTransitFor: () => null,
    bumpActionRevision: () => {},
    clearCombatTarget: () => {},
    clearQueuedPlayerActions: () => {},
    cancelSkilling: () => {},
    cancelItemProduction: () => {},
    closeShopForPlayer: () => {},
    sendDialogueClose: () => {},
    isPlayerMovementTileBlocked: () => false,
    sendNearbyDoorUpdates: () => {},
    getPlayerMap: () => ({
      width: 128,
      height: 128,
      isWallBlocked: () => false,
      isWallBlockedOnFloor: () => false,
      getStairOnFloor: () => null,
      getWalkableFloorTargetsAt: () => [],
      getEffectiveHeightOnFloor: () => 0,
    }),
  });
  return result;
}

describe('player movement modes', () => {
  test('defaults to walk movement credit', () => {
    const player = makePlayer();
    expect(player.movementMode).toBe('walk');
    expect(player.moveSpeed).toBe(movementTilesPerTick('walk'));
  });

  test('run mode consumes two unit-tile steps in one server tick', () => {
    const player = makePlayer();
    player.setMovementMode('run');
    player.setMoveQueue([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
      { x: 3.5, z: 0.5 },
    ]);

    expect(player.moveSpeed).toBe(movementTilesPerTick('run'));
    expect(processMovementTick(player, 1)).toBe(2);
    expect(player.position.x).toBe(2.5);
    expect(player.position.y).toBe(0.5);
    expect(player.getMoveDestination()).toEqual({ x: 3.5, z: 0.5 });
  });

  test('run mode walks one-tile movement at walk pace', () => {
    const player = makePlayer();
    player.setMovementMode('run');
    player.setMoveQueue([{ x: 1.5, z: 0.5 }]);

    expect(player.moveSpeed).toBe(movementTilesPerTick('run'));
    expect(player.effectiveMovementModePerTick()).toBe('walk');
    expect(player.movementCreditPerTick()).toBe(movementTilesPerTick('walk'));
    expect(processMovementTick(player, 1)).toBe(1);
    expect(player.position.x).toBe(1.5);
    expect(player.position.y).toBe(0.5);
    expect(player.hasMoveQueue()).toBe(false);
  });

  test('replacing a walking active step keeps the first redirected step at walk pace', () => {
    const player = makePlayer();
    player.setMovementMode('run');
    player.setMoveQueue([{ x: 1.5, z: 0.5 }]);
    expect(player.effectiveMovementModePerTick()).toBe('walk');

    player.setMoveQueue([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
      { x: 3.5, z: 0.5 },
    ], {
      preserveMovementCredit: true,
      forceWalkFirstStep: player.effectiveMovementModePerTick() === 'walk',
    });

    expect(player.effectiveMovementModePerTick()).toBe('walk');
    expect(player.movementCreditPerTick()).toBe(movementTilesPerTick('walk'));
    expect(processMovementTick(player, 1)).toBe(1);
    expect(player.position.x).toBe(1.5);
    expect(player.effectiveMovementModePerTick()).toBe('run');
    expect(player.movementCreditPerTick()).toBe(movementTilesPerTick('run'));
  });

  test('run mode reports run for a two-step movement batch', () => {
    const player = makePlayer();
    player.setMovementMode('run');
    player.setMoveQueue([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
    ]);

    expect(player.effectiveMovementModePerTick()).toBe('run');
    expect(player.movementCreditPerTick()).toBe(movementTilesPerTick('run'));
  });

  test('run energy drains from two consumed unit steps', () => {
    const player = makePlayer();
    player.setMovementMode('run');
    player.setMoveQueue([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
    ]);

    const moved = processMovementTick(player, 1);
    const result = player.updateRunEnergy(moved);

    expect(moved).toBe(2);
    expect(player.runEnergy).toBe(RUN_ENERGY_MAX - runEnergyDrainPerRunTick(0));
    expect(result.percentChanged).toBe(true);
    expect(result.modeChanged).toBe(false);
  });

  test('one-tile run movement recovers energy at level 1 agility scale', () => {
    const player = makePlayer();
    player.setRunEnergy(5000);
    player.setMovementMode('run');
    player.setMoveQueue([{ x: 1.5, z: 0.5 }]);

    const moved = processMovementTick(player, 1);
    const result = player.updateRunEnergy(moved);

    expect(moved).toBe(1);
    expect(player.runEnergy).toBe(5000 + runEnergyRecoverPerTick(1));
    expect(player.movementMode).toBe('run');
    expect(result.modeChanged).toBe(false);
  });

  test('run cannot be enabled below the one-percent energy threshold', () => {
    const player = makePlayer();
    player.setRunEnergy(RUN_ENERGY_MIN_TO_RUN - 1);
    player.setMovementMode('run');

    expect(player.movementMode).toBe('walk');
    expect(player.movementCreditPerTick()).toBe(movementTilesPerTick('walk'));
  });

  test('run mode drops to walk when a run tick leaves less than one percent energy', () => {
    const player = makePlayer();
    player.setRunEnergy(RUN_ENERGY_MIN_TO_RUN);
    player.setMovementMode('run');

    const result = player.updateRunEnergy(2);

    expect(player.runEnergy).toBe(RUN_ENERGY_MIN_TO_RUN - runEnergyDrainPerRunTick(0));
    expect(player.movementMode).toBe('walk');
    expect(result.percentChanged).toBe(true);
    expect(result.modeChanged).toBe(true);
  });

  test('world rejects run toggle below stamina threshold and echoes walk state', () => {
    const player = makePlayer();
    player.setRunEnergy(0);
    const { world, packets } = makeMovementModeWorld(player);

    world.handlePlayerSetMovementMode(player.id, 1);

    expect(player.movementMode).toBe('walk');
    expect(packets).toContainEqual({ kind: 'mode', value: 'walk' });
    expect(packets).toContainEqual({ kind: 'energy', value: 0 });
  });

  test('world applies movement mode bundled with a non-empty move request', () => {
    const player = makePlayer();
    const { world, packets } = makeMoveRequestWorld(player);

    world.handlePlayerMove(player.id, [{ x: 1.5, z: 0.5 }, { x: 2.5, z: 0.5 }], 1);

    expect(player.movementMode).toBe('run');
    expect(player.getMoveDestination()).toEqual({ x: 2.5, z: 0.5 });
    expect(packets).toContainEqual({ kind: 'mode', value: 'run' });
    expect(packets).toContainEqual({ kind: 'broadcast', value: 'run' });
  });

  test('world rejects bundled run mode below stamina threshold but still validates the route', () => {
    const player = makePlayer();
    player.setRunEnergy(0);
    const { world, packets } = makeMoveRequestWorld(player);

    world.handlePlayerMove(player.id, [{ x: 1.5, z: 0.5 }], 1);

    expect(player.movementMode).toBe('walk');
    expect(player.getMoveDestination()).toEqual({ x: 1.5, z: 0.5 });
    expect(packets).toContainEqual({ kind: 'mode', value: 'walk' });
    expect(packets).toContainEqual({ kind: 'energy', value: 0 });
  });

  test('world prorates first movement credit from the route queue time', () => {
    const player = makePlayer();
    player.setMovementMode('run');
    player.setMoveQueue([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
    ]);
    const queuedAt = 10_000;
    player.movementCreditUpdatedAtMs = queuedAt;
    const world = Object.create(World.prototype) as any;

    world.currentTickStartMs = queuedAt + TICK_RATE * 0.1;
    world.accruePlayerMovementCredit(player);

    expect(player.movementCredit).toBeCloseTo(0.2, 5);
    expect(player.processMovement(1)).toBe(false);
    expect(player.position.x).toBe(0.5);

    world.currentTickStartMs = queuedAt + TICK_RATE;
    world.accruePlayerMovementCredit(player);

    expect(player.movementCredit).toBeCloseTo(2, 5);
    expect(player.processMovement(2)).toBe(true);
    expect(player.processMovement(2)).toBe(true);
    expect(player.position.x).toBe(2.5);
  });

  test('world broadcasts walk when stamina disables active run mode', () => {
    const player = makePlayer();
    player.setRunEnergy(RUN_ENERGY_MIN_TO_RUN);
    player.setMovementMode('run');
    const { world, packets } = makeMovementModeWorld(player);

    world.updatePlayerRunEnergy(player, 2);

    expect(player.movementMode).toBe('walk');
    expect(packets).toContainEqual({ kind: 'energy', value: 0 });
    expect(packets).toContainEqual({ kind: 'mode', value: 'walk' });
    expect(packets).toContainEqual({ kind: 'broadcast', value: 'walk' });
  });
});
