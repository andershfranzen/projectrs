import {
  LOGS_ITEM_ID,
  OAK_LOGS_ITEM_ID,
  WILLOW_LOGS_ITEM_ID,
  MAPLE_LOGS_ITEM_ID,
  YEW_LOGS_ITEM_ID,
  MAGIC_LOGS_ITEM_ID,
} from './constants';

export const FIREMAKING_LOG_COST = 3;
export const FIREMAKING_ATTEMPT_TICKS = 4;
export const FIREMAKING_ROLL_LOW = 64;
export const FIREMAKING_ROLL_HIGH = 512;
export const FIRE_MIN_DURATION_TICKS = 100;
export const FIRE_RANDOM_DURATION_TICKS = 100;
export const FIRE_ASHES_DESPAWN_TICKS = 100;

export interface SurvivalFiremakingRecipe {
  logItemId: number;
  logLabel: string;
  levelRequired: number;
  xpReward: number;
}

export const SURVIVAL_FIREMAKING_RECIPES: readonly SurvivalFiremakingRecipe[] = [
  { logItemId: LOGS_ITEM_ID, logLabel: 'logs', levelRequired: 1, xpReward: 40 },
  { logItemId: OAK_LOGS_ITEM_ID, logLabel: 'oak logs', levelRequired: 15, xpReward: 60 },
  { logItemId: WILLOW_LOGS_ITEM_ID, logLabel: 'willow logs', levelRequired: 30, xpReward: 90 },
  { logItemId: MAPLE_LOGS_ITEM_ID, logLabel: 'maple logs', levelRequired: 45, xpReward: 135 },
  { logItemId: YEW_LOGS_ITEM_ID, logLabel: 'yew logs', levelRequired: 60, xpReward: 203 },
  { logItemId: MAGIC_LOGS_ITEM_ID, logLabel: 'mystic logs', levelRequired: 75, xpReward: 304 },
];

export const SURVIVAL_FIREMAKING_LOG_ITEM_IDS: ReadonlySet<number> = new Set(
  SURVIVAL_FIREMAKING_RECIPES.map(recipe => recipe.logItemId),
);

export function firemakingRecipeForLog(itemId: number): SurvivalFiremakingRecipe | null {
  return SURVIVAL_FIREMAKING_RECIPES.find(recipe => recipe.logItemId === itemId) ?? null;
}
