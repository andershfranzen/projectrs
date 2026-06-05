import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARROWHEAD_FLETCHING_RECIPES,
  BLACK_BRONZE_ARROWHEADS_ITEM_ID,
  MITHRIL_ARROWHEADS_ITEM_ID,
  type ItemDef,
  type ObjectRecipe,
  type WorldObjectDef,
} from '@projectrs/shared';

const DATA_DIR = join(import.meta.dir, '..', 'data');

function loadItems(): ItemDef[] {
  return JSON.parse(readFileSync(join(DATA_DIR, 'items.json'), 'utf8')) as ItemDef[];
}

function loadObjects(): WorldObjectDef[] {
  return JSON.parse(readFileSync(join(DATA_DIR, 'objects.json'), 'utf8')) as WorldObjectDef[];
}

function itemNamed(items: ItemDef[], name: string): ItemDef {
  const item = items.find((candidate) => candidate.name === name);
  expect(item, `Missing item: ${name}`).toBeDefined();
  return item!;
}

function objectNamed(objects: WorldObjectDef[], name: string): WorldObjectDef {
  const object = objects.find((candidate) => candidate.name === name);
  expect(object, `Missing object: ${name}`).toBeDefined();
  return object!;
}

function recipeFor(recipes: readonly ObjectRecipe[], inputItemId: number, outputItemId: number): ObjectRecipe {
  const recipe = recipes.find((candidate) => candidate.inputItemId === inputItemId && candidate.outputItemId === outputItemId);
  expect(recipe, `Missing recipe ${inputItemId}->${outputItemId}`).toBeDefined();
  return recipe!;
}

function anvilRecipesFor(objects: WorldObjectDef[], barItemId: number): ObjectRecipe[] {
  const recipes = objectNamed(objects, 'Anvil').recipes?.filter((recipe) => recipe.inputItemId === barItemId) ?? [];
  expect(recipes.length, `Missing anvil recipes for bar ${barItemId}`).toBeGreaterThan(0);
  return recipes;
}

function anvilXpPerBar(objects: WorldObjectDef[], barItemId: number): number {
  const rates = new Set(anvilRecipesFor(objects, barItemId).map((recipe) => recipe.xpReward / recipe.inputQuantity));
  expect(rates.size, `Mixed anvil XP rates for bar ${barItemId}`).toBe(1);
  return [...rates][0];
}

describe('Mithril and Black Bronze hierarchy', () => {
  test('gear, tools, bars, ammo, and HQ stats put Black Bronze below Mithril', () => {
    const items = loadItems();
    const pairs = [
      ['Black Bronze Axe', 'Mithril Axe', ['toolLevel', 'toolBonus', 'slashAttack', 'meleeStrength', 'value']],
      ['Black Bronze Pickaxe', 'Mithril Pickaxe', ['toolLevel', 'toolBonus', 'crushAttack', 'meleeStrength', 'value']],
      ['Black Bronze Bar', 'Mithril Bar', ['value']],
      ['Black Bronze Arrows', 'Mithril Arrows', ['rangedStrength', 'value']],
      ['Black Bronze Arrowheads', 'Mithril Arrowheads', ['value']],
      ['Black Bronze Sword', 'Mithril Sword', ['levelRequired', 'stabAttack', 'slashAttack', 'meleeStrength', 'value']],
      ['Black Bronze Plate Mail Body', 'Mithril Plate Mail Body', ['levelRequired', 'stabDefence', 'slashDefence', 'crushDefence', 'rangedDefence', 'value']],
      ['Black Bronze Sword (HQ)', 'Mithril Sword (HQ)', ['levelRequired', 'stabAttack', 'slashAttack', 'meleeStrength', 'value']],
      ['Black Bronze Plate Mail Body (HQ)', 'Mithril Plate Mail Body (HQ)', ['levelRequired', 'stabDefence', 'slashDefence', 'crushDefence', 'rangedDefence', 'value']],
    ] as const;

    for (const [lowerName, higherName, fields] of pairs) {
      const lower = itemNamed(items, lowerName);
      const higher = itemNamed(items, higherName);
      for (const field of fields) {
        const lowerValue = lower[field];
        const higherValue = higher[field];
        expect(typeof lowerValue, `${lowerName}.${String(field)} is numeric`).toBe('number');
        expect(typeof higherValue, `${higherName}.${String(field)} is numeric`).toBe('number');
        expect(lowerValue as number, `${lowerName}.${String(field)} should be below ${higherName}`).toBeLessThan(higherValue as number);
      }
    }
  });

  test('mining and smithing production gates put the full Black Bronze chain below Mithril', () => {
    const objects = loadObjects();
    const silverRock = objectNamed(objects, 'Silver Rock');
    const mithrilRock = objectNamed(objects, 'Mithril Rock');
    expect(silverRock.levelRequired).toBe(38);
    expect(silverRock.xpReward).toBe(58);
    expect(mithrilRock.levelRequired).toBe(45);
    expect(mithrilRock.xpReward).toBe(65);

    const furnaceRecipes = objectNamed(objects, 'Furnace').recipes ?? [];
    expect(recipeFor(furnaceRecipes, 142, 143)).toMatchObject({ levelRequired: 31, xpReward: 23 });
    expect(recipeFor(furnaceRecipes, 143, 50)).toMatchObject({ levelRequired: 31, xpReward: 23 });
    expect(recipeFor(furnaceRecipes, 45, 49)).toMatchObject({ levelRequired: 39, xpReward: 25 });

    const blackBronzeAnvilLevels = anvilRecipesFor(objects, 50).map((recipe) => recipe.levelRequired);
    const mithrilAnvilLevels = anvilRecipesFor(objects, 49).map((recipe) => recipe.levelRequired);
    expect(Math.min(...blackBronzeAnvilLevels)).toBe(31);
    expect(Math.max(...blackBronzeAnvilLevels)).toBe(38);
    expect(anvilXpPerBar(objects, 50)).toBe(50);
    expect(Math.min(...mithrilAnvilLevels)).toBe(39);
    expect(Math.max(...mithrilAnvilLevels)).toBe(46);
    expect(anvilXpPerBar(objects, 49)).toBe(63);
  });

  test('tiered chests already keep Black Bronze below Mithril', () => {
    const objects = loadObjects();
    const blackBronzeChest = objectNamed(objects, 'Black Bronze Chest');
    const mithrilChest = objectNamed(objects, 'Mithril Chest');
    expect(blackBronzeChest.levelRequired).toBeLessThan(mithrilChest.levelRequired ?? 0);
    expect(blackBronzeChest.xpReward).toBeLessThan(mithrilChest.xpReward ?? 0);
    expect(blackBronzeChest.respawnTime).toBeLessThan(mithrilChest.respawnTime ?? 0);
  });

  test('fletching progression puts Black Bronze arrows below Mithril arrows', () => {
    const blackBronzeRecipe = ARROWHEAD_FLETCHING_RECIPES.find((recipe) => recipe.arrowheadItemId === BLACK_BRONZE_ARROWHEADS_ITEM_ID);
    const mithrilRecipe = ARROWHEAD_FLETCHING_RECIPES.find((recipe) => recipe.arrowheadItemId === MITHRIL_ARROWHEADS_ITEM_ID);
    expect(blackBronzeRecipe).toMatchObject({ levelRequired: 45, xpReward: 8, arrowLabel: 'black bronze' });
    expect(mithrilRecipe).toMatchObject({ levelRequired: 60, xpReward: 16, arrowLabel: 'mithril' });
  });
});
