import { expect, test } from 'bun:test';
import {
  FIREMAKING_LOG_COST,
  SURVIVAL_FIREMAKING_RECIPES,
  firemakingRecipeForLog,
} from './firemaking';
import {
  LOGS_ITEM_ID,
  MAGIC_LOGS_ITEM_ID,
  YEW_LOGS_ITEM_ID,
} from './constants';

test('survival firemaking uses three logs per fire', () => {
  expect(FIREMAKING_LOG_COST).toBe(3);
});

test('survival firemaking recipes map classic tiers to Survival XP', () => {
  expect(SURVIVAL_FIREMAKING_RECIPES.map(recipe => recipe.levelRequired)).toEqual([1, 15, 30, 45, 60, 75]);
  expect(SURVIVAL_FIREMAKING_RECIPES.map(recipe => recipe.xpReward)).toEqual([40, 60, 90, 135, 203, 304]);
});

test('survival firemaking resolves regular and mystic logs', () => {
  expect(firemakingRecipeForLog(LOGS_ITEM_ID)?.logLabel).toBe('logs');
  expect(firemakingRecipeForLog(YEW_LOGS_ITEM_ID)?.levelRequired).toBe(60);
  expect(firemakingRecipeForLog(MAGIC_LOGS_ITEM_ID)?.logLabel).toBe('mystic logs');
});
