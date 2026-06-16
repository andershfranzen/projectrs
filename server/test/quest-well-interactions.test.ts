import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const BOBS_BURIAL_QUEST_ID = "Bob's Burial";
const SUSPECT_SKETCH_ITEM_ID = 236;

type QuestConditionLike = {
  type?: unknown;
  questId?: unknown;
  minStage?: unknown;
  maxStage?: unknown;
  itemId?: unknown;
  quantity?: unknown;
  condition?: QuestConditionLike;
  conditions?: QuestConditionLike[];
};

type PlacedObjectLike = {
  assetId?: unknown;
  name?: unknown;
  interactions?: Array<{
    action?: unknown;
    message?: unknown;
    condition?: QuestConditionLike;
    conditions?: QuestConditionLike[];
  }>;
};

function conditionRequiresSuspectSketch(condition: QuestConditionLike | undefined): boolean {
  if (!condition) return false;
  if (condition.type === 'hasItem') {
    return condition.itemId === SUSPECT_SKETCH_ITEM_ID && (condition.quantity ?? 1) === 1;
  }
  if (condition.type === 'all' && Array.isArray(condition.conditions)) {
    return condition.conditions.some(conditionRequiresSuspectSketch);
  }
  return false;
}

function conditionRequiresBobStageTwo(condition: QuestConditionLike | undefined): boolean {
  if (!condition) return false;
  if (condition.type === 'questStage') {
    return condition.questId === BOBS_BURIAL_QUEST_ID && condition.minStage === 2 && condition.maxStage === 2;
  }
  if (condition.type === 'all' && Array.isArray(condition.conditions)) {
    return condition.conditions.some(conditionRequiresBobStageTwo);
  }
  return false;
}

function loadKcmapPlacedObjects(): Array<{ path: string; index: number; object: PlacedObjectLike }> {
  const objectsDir = 'server/data/maps/kcmap/objects';
  const entries: Array<{ path: string; index: number; object: PlacedObjectLike }> = [];
  for (const file of readdirSync(objectsDir).sort()) {
    if (!file.startsWith('chunk_') || !file.endsWith('.json')) continue;
    const path = join(objectsDir, file);
    const objects = JSON.parse(readFileSync(path, 'utf8')) as PlacedObjectLike[];
    objects.forEach((object, index) => entries.push({ path, index, object }));
  }
  return entries;
}

function isWellObject(object: PlacedObjectLike): boolean {
  return [object.assetId, object.name].some(value =>
    typeof value === 'string' && value.toLowerCase().includes('well'),
  );
}

describe('quest well interactions', () => {
  test('Throw sketch well actions are visible only when carrying the suspect sketch', () => {
    const throwSketchInteractions = loadKcmapPlacedObjects().flatMap(({ path, index, object }) =>
      (object.interactions ?? [])
        .filter(interaction => isWellObject(object) && interaction.action === 'Throw sketch')
        .map(interaction => ({ path, index, object, interaction })),
    );

    expect(throwSketchInteractions.length).toBeGreaterThan(0);
    for (const { path, index, object, interaction } of throwSketchInteractions) {
      const label = `${path}[${index}] ${String(object.name ?? object.assetId ?? 'placed object')}`;
      expect(interaction.message, label).not.toBe('You have nothing suspicious to throw into the well.');
      expect(conditionRequiresBobStageTwo(interaction.condition), label).toBe(true);
      expect(conditionRequiresSuspectSketch(interaction.condition), label).toBe(true);
      expect(interaction.conditions ?? [], label).toEqual([]);
    }
  });
});
