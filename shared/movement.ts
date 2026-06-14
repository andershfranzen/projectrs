import { TICK_RATE } from './constants';

export const MOVEMENT_MODES = ['walk', 'run'] as const;
export type MovementMode = typeof MOVEMENT_MODES[number];

export const WALK_TILES_PER_TICK = 1;
export const RUN_TILES_PER_TICK = 2;
export const RUN_ENERGY_MAX = 10000;
export const RUN_ENERGY_MIN_TO_RUN = 100;
export const RUN_ENERGY_LEVEL_1_AGILITY = 1;

const MOVEMENT_MODE_SET: ReadonlySet<string> = new Set(MOVEMENT_MODES);
const MOVEMENT_STEP_EPSILON = 0.0001;

export function isMovementMode(value: unknown): value is MovementMode {
  return typeof value === 'string' && MOVEMENT_MODE_SET.has(value);
}

export function movementModeFromIndex(index: number): MovementMode {
  return index === 1 ? 'run' : 'walk';
}

export function movementModeIndex(mode: MovementMode): number {
  return mode === 'run' ? 1 : 0;
}

export function movementTilesPerTick(mode: MovementMode): number {
  return mode === 'run' ? RUN_TILES_PER_TICK : WALK_TILES_PER_TICK;
}

export function movementTilesPerSecond(mode: MovementMode): number {
  return movementTilesPerTick(mode) * (1000 / TICK_RATE);
}

export function clampRunEnergy(value: number): number {
  if (!Number.isFinite(value)) return RUN_ENERGY_MAX;
  return Math.max(0, Math.min(RUN_ENERGY_MAX, Math.floor(value)));
}

export function runEnergyPercent(energy: number): number {
  return Math.floor(clampRunEnergy(energy) / 100);
}

export function canRunWithEnergy(energy: number): boolean {
  return Number.isFinite(energy) && clampRunEnergy(energy) >= RUN_ENERGY_MIN_TO_RUN;
}

export function runEnergyRecoverPerTick(agilityLevel: number = RUN_ENERGY_LEVEL_1_AGILITY): number {
  const level = Number.isFinite(agilityLevel) ? Math.max(1, Math.floor(agilityLevel)) : RUN_ENERGY_LEVEL_1_AGILITY;
  return Math.floor(level / 9) + 8;
}

export function runEnergyDrainPerRunTick(runWeightGrams: number = 0): number {
  const weightKg = Number.isFinite(runWeightGrams) ? runWeightGrams / 1000 : 0;
  const clampedWeightKg = Math.max(0, Math.min(64, weightKg));
  return Math.floor(67 + (67 * clampedWeightKg) / 64);
}

export function effectiveMovementMode(mode: MovementMode, remainingUnitSteps: number): MovementMode {
  return mode === 'run' && remainingUnitSteps <= 1 ? 'walk' : mode;
}

export function effectiveMovementTilesPerTick(mode: MovementMode, remainingUnitSteps: number): number {
  return movementTilesPerTick(effectiveMovementMode(mode, remainingUnitSteps));
}

export function effectiveMovementTilesPerSecond(mode: MovementMode, remainingUnitSteps: number): number {
  return effectiveMovementTilesPerTick(mode, remainingUnitSteps) * (1000 / TICK_RATE);
}

export function effectiveMovementModeForPath(
  mode: MovementMode,
  pathUnitSteps: number,
  remainingUnitSteps: number,
): MovementMode {
  if (mode !== 'run') return mode;
  const totalSteps = Math.max(0, pathUnitSteps);
  const remainingSteps = Math.max(0, remainingUnitSteps);
  if (totalSteps <= 1 + MOVEMENT_STEP_EPSILON) return 'walk';
  if (
    remainingSteps <= 1 + MOVEMENT_STEP_EPSILON
    && Math.abs((totalSteps % RUN_TILES_PER_TICK) - 1) <= MOVEMENT_STEP_EPSILON
  ) return 'walk';
  return 'run';
}

export function effectiveMovementTilesPerSecondForPath(
  mode: MovementMode,
  pathUnitSteps: number,
  remainingUnitSteps: number,
): number {
  return movementTilesPerTick(effectiveMovementModeForPath(mode, pathUnitSteps, remainingUnitSteps)) * (1000 / TICK_RATE);
}
