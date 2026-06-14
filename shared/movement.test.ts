import { describe, expect, test } from 'bun:test';
import {
  isMovementMode,
  RUN_ENERGY_MAX,
  RUN_ENERGY_MIN_TO_RUN,
  canRunWithEnergy,
  clampRunEnergy,
  effectiveMovementMode,
  effectiveMovementModeForPath,
  effectiveMovementTilesPerTick,
  effectiveMovementTilesPerSecondForPath,
  movementModeFromIndex,
  movementModeIndex,
  movementTilesPerSecond,
  movementTilesPerTick,
  runEnergyDrainPerRunTick,
  runEnergyPercent,
  runEnergyRecoverPerTick,
} from './movement';

describe('movement modes', () => {
  test('maps wire indices to movement modes', () => {
    expect(movementModeFromIndex(0)).toBe('walk');
    expect(movementModeFromIndex(1)).toBe('run');
    expect(movementModeFromIndex(99)).toBe('walk');
    expect(movementModeIndex('walk')).toBe(0);
    expect(movementModeIndex('run')).toBe(1);
  });

  test('defines run as two unit tiles per server tick', () => {
    expect(movementTilesPerTick('walk')).toBe(1);
    expect(movementTilesPerTick('run')).toBe(2);
    expect(movementTilesPerSecond('run')).toBe(movementTilesPerSecond('walk') * 2);
  });

  test('downgrades one-tile run movement to walk pace', () => {
    expect(effectiveMovementMode('run', 1)).toBe('walk');
    expect(effectiveMovementMode('run', 2)).toBe('run');
    expect(effectiveMovementMode('walk', 2)).toBe('walk');
    expect(effectiveMovementTilesPerTick('run', 1)).toBe(movementTilesPerTick('walk'));
    expect(effectiveMovementTilesPerTick('run', 2)).toBe(movementTilesPerTick('run'));
  });

  test('keeps even-length run paths at run pace through the final tile', () => {
    expect(effectiveMovementModeForPath('run', 2, 2)).toBe('run');
    expect(effectiveMovementModeForPath('run', 2, 1)).toBe('run');
    expect(effectiveMovementModeForPath('run', 4, 1)).toBe('run');
    expect(effectiveMovementTilesPerSecondForPath('run', 2, 1)).toBe(movementTilesPerSecond('run'));
  });

  test('walks only single-tile run paths and odd final leftovers', () => {
    expect(effectiveMovementModeForPath('run', 1, 1)).toBe('walk');
    expect(effectiveMovementModeForPath('run', 3, 2)).toBe('run');
    expect(effectiveMovementModeForPath('run', 3, 1)).toBe('walk');
    expect(effectiveMovementModeForPath('walk', 3, 1)).toBe('walk');
    expect(effectiveMovementTilesPerSecondForPath('run', 3, 1)).toBe(movementTilesPerSecond('walk'));
  });

  test('validates movement mode strings', () => {
    expect(isMovementMode('walk')).toBe(true);
    expect(isMovementMode('run')).toBe(true);
    expect(isMovementMode('sprint')).toBe(false);
  });

  test('matches 2004scape-scaled level 1 run energy math', () => {
    expect(RUN_ENERGY_MAX).toBe(10000);
    expect(RUN_ENERGY_MIN_TO_RUN).toBe(100);
    expect(runEnergyRecoverPerTick(1)).toBe(8);
    expect(runEnergyDrainPerRunTick(0)).toBe(67);
    expect(runEnergyPercent(9999)).toBe(99);
    expect(runEnergyPercent(10000)).toBe(100);
    expect(canRunWithEnergy(99)).toBe(false);
    expect(canRunWithEnergy(100)).toBe(true);
  });

  test('clamps run energy to the internal 0..10000 range', () => {
    expect(clampRunEnergy(-1)).toBe(0);
    expect(clampRunEnergy(10001)).toBe(10000);
    expect(clampRunEnergy(Number.NaN)).toBe(10000);
  });
});
