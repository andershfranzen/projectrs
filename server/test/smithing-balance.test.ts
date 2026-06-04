import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { levelFromXp, xpForLevel } from '../../shared/skills';

type TestObjectDef = {
  name: string;
  category?: string;
  xpReward?: number;
  recipes?: TestRecipe[];
};

type TestRecipe = {
  inputItemId: number;
  inputQuantity: number;
  outputItemId: number;
  skill: string;
  levelRequired: number;
  xpReward: number;
  secondInputItemId?: number;
  successChance?: number;
};

const OBJECTS_PATH = resolve(import.meta.dir, '../data/objects.json');
const objects = JSON.parse(readFileSync(OBJECTS_PATH, 'utf8')) as TestObjectDef[];

function objectNamed(name: string): TestObjectDef {
  const obj = objects.find(candidate => candidate.name === name);
  expect(obj, `${name} object exists`).toBeDefined();
  return obj!;
}

function furnaceRecipe(inputItemId: number, outputItemId: number, opts: { withoutSecondInput?: boolean } = {}): TestRecipe {
  const furnace = objectNamed('Furnace');
  const recipe = furnace.recipes?.find(candidate =>
    candidate.inputItemId === inputItemId
    && candidate.outputItemId === outputItemId
    && (!opts.withoutSecondInput || candidate.secondInputItemId === undefined)
  );
  expect(recipe, `furnace recipe ${inputItemId}->${outputItemId}`).toBeDefined();
  return recipe!;
}

function anvilXpPerBar(barItemId: number): number {
  const anvil = objectNamed('Anvil');
  const matching = anvil.recipes?.filter(recipe => recipe.inputItemId === barItemId) ?? [];
  expect(matching.length, `anvil recipes for bar ${barItemId}`).toBeGreaterThan(0);

  const rates = new Set(matching.map(recipe => recipe.xpReward / recipe.inputQuantity));
  expect(rates.size, `anvil XP per bar for item ${barItemId} is consistent`).toBe(1);
  return [...rates][0];
}

describe('smithing balance data', () => {
  test('anvil XP scales consistently by bar tier', () => {
    expect(anvilXpPerBar(29)).toBe(13); // Bronze Bar
    expect(anvilXpPerBar(30)).toBe(25); // Iron Bar
    expect(anvilXpPerBar(48)).toBe(38); // Steel Bar
    expect(anvilXpPerBar(49)).toBe(50); // Mithril Bar
    expect(anvilXpPerBar(50)).toBe(63); // Black Bronze Bar
  });

  test('processing ores mined to level 30 reaches steel smithing entry', () => {
    const copperRock = objectNamed('Copper Rock');
    const tinRock = objectNamed('Tin Rock');
    const ironRock = objectNamed('Iron Rock');
    const bronzeSmelt = furnaceRecipe(25, 29);
    const ironNoCoalSmelt = furnaceRecipe(26, 30, { withoutSecondInput: true });
    const steelSmelt = furnaceRecipe(26, 48);

    const bronzeMiningXpPerBar = (copperRock.xpReward ?? 0) + (tinRock.xpReward ?? 0);
    const bronzeBarsToIron = Math.ceil(xpForLevel(15) / bronzeMiningXpPerBar);
    const remainingMiningXpToCoal = xpForLevel(30) - (bronzeBarsToIron * bronzeMiningXpPerBar);
    const ironOreToCoal = Math.ceil(remainingMiningXpToCoal / (ironRock.xpReward ?? 1));

    // Expected, not lucky, no-coal iron success. This is the path that used
    // to leave a level-30 miner around Smithing 19.
    const expectedIronBars = Math.floor(ironOreToCoal * (ironNoCoalSmelt.successChance ?? 1));
    const smithingXp =
      bronzeBarsToIron * (bronzeSmelt.xpReward + anvilXpPerBar(29))
      + expectedIronBars * (ironNoCoalSmelt.xpReward + anvilXpPerBar(30));

    expect(levelFromXp(smithingXp)).toBeGreaterThanOrEqual(steelSmelt.levelRequired);
  });
});
