import { readFileSync, statSync } from 'node:fs';

const PUBLIC_DATA_FILES = new Set([
  'gear-overrides.json',
  'items.json',
  'npcs.json',
  'objects.json',
  'quests.json',
  'thumbnail-overrides.json',
]);

export function isPublicDataFile(filename: string): boolean {
  return PUBLIC_DATA_FILES.has(filename);
}

interface PublicDataCacheEntry {
  mtimeMs: number;
  size: number;
  content: string;
}

const publicDataCache = new Map<string, PublicDataCacheEntry>();

export function invalidatePublicDataCache(filename?: string): void {
  if (!filename) {
    publicDataCache.clear();
    return;
  }
  for (const key of publicDataCache.keys()) {
    if (key.endsWith(`/${filename}`) || key.endsWith(`\\${filename}`) || key === filename) {
      publicDataCache.delete(key);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeObjectRecipe(recipe: unknown): unknown {
  if (!isRecord(recipe)) return recipe;
  const {
    inputItemId,
    inputQuantity,
    secondInputItemId,
    secondInputQuantity,
    outputItemId,
    outputQuantity,
    skill,
    levelRequired,
    requiresTool,
  } = recipe;
  return {
    inputItemId,
    inputQuantity,
    ...(secondInputItemId !== undefined ? { secondInputItemId } : {}),
    ...(secondInputQuantity !== undefined ? { secondInputQuantity } : {}),
    outputItemId,
    outputQuantity,
    skill,
    levelRequired,
    ...(requiresTool !== undefined ? { requiresTool } : {}),
  };
}

function sanitizeQuestStage(stage: unknown): unknown {
  if (!isRecord(stage)) return stage;
  const out: Record<string, unknown> = {
    id: stage.id,
    description: stage.description,
  };
  if (isRecord(stage.descriptionByVar)) out.descriptionByVar = stage.descriptionByVar;
  if (isRecord(stage.trigger)) {
    const { type, count, quantity } = stage.trigger;
    out.trigger = {
      type,
      ...(count !== undefined ? { count } : {}),
      ...(quantity !== undefined ? { quantity } : {}),
    };
  }
  return out;
}

export function sanitizePublicData(filename: string, data: unknown): unknown {
  if (filename === 'npcs.json' && Array.isArray(data)) {
    return data.map((npc) => {
      if (!isRecord(npc)) return npc;
      const {
        id,
        name,
        modelNpcId,
        defaultAppearance,
        defaultEquipment,
        defaultCustomColors,
        defaultAttackAnim,
        health,
        attack,
        defence,
        strength,
        combatLevel,
        attackBonus,
        strengthBonus,
        stabDefence,
        slashDefence,
        crushDefence,
        rangedDefence,
        magicDefence,
        attackStyle,
        attackSpeed,
        size,
        stationary,
      } = npc;
      return {
        id,
        name,
        ...(modelNpcId !== undefined ? { modelNpcId } : {}),
        ...(defaultAppearance !== undefined ? { defaultAppearance } : {}),
        ...(defaultEquipment !== undefined ? { defaultEquipment } : {}),
        ...(defaultCustomColors !== undefined ? { defaultCustomColors } : {}),
        ...(defaultAttackAnim !== undefined ? { defaultAttackAnim } : {}),
        health,
        attack,
        defence,
        strength,
        ...(combatLevel !== undefined ? { combatLevel } : {}),
        ...(attackBonus !== undefined ? { attackBonus } : {}),
        ...(strengthBonus !== undefined ? { strengthBonus } : {}),
        ...(stabDefence !== undefined ? { stabDefence } : {}),
        ...(slashDefence !== undefined ? { slashDefence } : {}),
        ...(crushDefence !== undefined ? { crushDefence } : {}),
        ...(rangedDefence !== undefined ? { rangedDefence } : {}),
        ...(magicDefence !== undefined ? { magicDefence } : {}),
        ...(attackStyle !== undefined ? { attackStyle } : {}),
        attackSpeed,
        ...(size !== undefined ? { size } : {}),
        ...(stationary !== undefined ? { stationary } : {}),
      };
    });
  }
  if (filename === 'objects.json' && Array.isArray(data)) {
    return data.map((object) => {
      if (!isRecord(object)) return object;
      const {
        id,
        name,
        category,
        actions,
        blocking,
        width,
        height,
        color,
        depletedAssetId,
        recipes,
      } = object;
      return {
        id,
        name,
        category,
        actions,
        blocking,
        width,
        height,
        color,
        ...(depletedAssetId !== undefined ? { depletedAssetId } : {}),
        ...(Array.isArray(recipes) ? { recipes: recipes.map(sanitizeObjectRecipe) } : {}),
      };
    });
  }
  if (filename === 'quests.json' && Array.isArray(data)) {
    return data.map((quest) => {
      if (!isRecord(quest)) return quest;
      return {
        id: quest.id,
        name: quest.name,
        ...(quest.blurb !== undefined ? { blurb: quest.blurb } : {}),
        stages: Array.isArray(quest.stages) ? quest.stages.map(sanitizeQuestStage) : [],
      };
    });
  }
  return data;
}

export function readPublicDataContent(filename: string, filePath: string, sanitize: boolean): string {
  if (!sanitize) return readFileSync(filePath, 'utf-8');
  const stat = statSync(filePath);
  const cached = publicDataCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.content;
  }

  const raw = readFileSync(filePath, 'utf-8');
  const content = JSON.stringify(sanitizePublicData(filename, JSON.parse(raw)));
  publicDataCache.set(filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    content,
  });
  return content;
}
