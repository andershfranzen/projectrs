import { readFileSync, statSync } from 'node:fs';
import { COOKING_RANGE_OBJECT_DEF_ID, FIRE_OBJECT_DEF_ID, npcCombatLevel } from '@projectrs/shared';

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

function finiteNumber(value: unknown, fallback: number = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function sanitizeStackModel(model: unknown): unknown {
  if (!isRecord(model)) return model;
  const { minQuantity, model: modelPath, scale } = model;
  return {
    minQuantity,
    model: modelPath,
    ...(scale !== undefined ? { scale } : {}),
  };
}

function sanitizeBodyTypeModels(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, modelPath] of Object.entries(value)) {
    if (typeof modelPath === 'string') out[key] = modelPath;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeItemDef(item: Record<string, unknown>): Record<string, unknown> {
  const {
    id,
    name,
    description,
    stackable,
    noteable,
    noteId,
    unnotedId,
    equippable,
    equipSlot,
    bodyHideStyle,
    headRenderMode,
    attackRange,
    weaponStyle,
    twoHanded,
    healAmount,
    toolType,
    sprite,
    icon,
    model,
    thumbnailModel,
    stackModels,
    bodyTypeModels,
  } = item;
  const out: Record<string, unknown> = {
    id,
    name,
    description,
    stackable,
    equippable,
  };
  if (noteable !== undefined) out.noteable = noteable;
  if (noteId !== undefined) out.noteId = noteId;
  if (unnotedId !== undefined) out.unnotedId = unnotedId;
  if (equipSlot !== undefined) out.equipSlot = equipSlot;
  if (bodyHideStyle !== undefined) out.bodyHideStyle = bodyHideStyle;
  if (headRenderMode !== undefined) out.headRenderMode = headRenderMode;
  if (attackRange !== undefined) out.attackRange = attackRange;
  if (weaponStyle !== undefined) out.weaponStyle = weaponStyle;
  if (twoHanded !== undefined) out.twoHanded = twoHanded;
  if (healAmount !== undefined) out.healAmount = healAmount;
  if (toolType !== undefined) out.toolType = toolType;
  if (sprite !== undefined) out.sprite = sprite;
  if (icon !== undefined) out.icon = icon;
  if (model !== undefined) out.model = model;
  if (thumbnailModel !== undefined) out.thumbnailModel = thumbnailModel;
  if (Array.isArray(stackModels)) out.stackModels = stackModels.map(sanitizeStackModel);
  const sanitizedBodyModels = sanitizeBodyTypeModels(bodyTypeModels);
  if (sanitizedBodyModels !== undefined) out.bodyTypeModels = sanitizedBodyModels;
  return out;
}

function publicNpcCombatLevel(npc: Record<string, unknown>): number {
  const explicit = positiveInteger(npc.combatLevel);
  if (explicit !== undefined) return explicit;
  return npcCombatLevel({
    health: finiteNumber(npc.health, 1),
    attack: finiteNumber(npc.attack, 1),
    defence: finiteNumber(npc.defence, 1),
    strength: finiteNumber(npc.strength, 1),
  });
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

function objectRecipesForFire(data: readonly unknown[], sanitizeRecipes: boolean): unknown[] | undefined {
  const range = data.find((object) => isRecord(object) && object.id === COOKING_RANGE_OBJECT_DEF_ID);
  if (!isRecord(range) || !Array.isArray(range.recipes) || range.recipes.length === 0) return undefined;
  return range.recipes.map((recipe) => {
    if (sanitizeRecipes) return sanitizeObjectRecipe(recipe);
    if (isRecord(recipe)) return { ...recipe };
    return recipe;
  });
}

function normalizeFireObjectRecipeSurface(data: unknown, sanitizeRecipes: boolean): unknown {
  if (!Array.isArray(data)) return data;
  const fireRecipes = objectRecipesForFire(data, sanitizeRecipes);
  return data.map((object) => {
    if (!isRecord(object) || object.id !== FIRE_OBJECT_DEF_ID) return object;
    const actions = Array.isArray(object.actions)
      ? ['Cook', ...object.actions.filter(action => action !== 'Cook')]
      : object.actions;
    if (Array.isArray(object.recipes) && object.recipes.length > 0) return { ...object, actions };
    return fireRecipes ? { ...object, actions, recipes: fireRecipes } : { ...object, actions };
  });
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
  if (filename === 'items.json' && Array.isArray(data)) {
    return data.map((item) => isRecord(item) ? sanitizeItemDef(item) : item);
  }
  if (filename === 'npcs.json' && Array.isArray(data)) {
    return data.map((npc) => {
      if (!isRecord(npc)) return npc;
      const {
        id,
        name,
        examineText,
        modelNpcId,
        defaultAppearance,
        defaultEquipment,
        defaultCustomColors,
        defaultAttackAnim,
        size,
        stationary,
      } = npc;
      return {
        id,
        name,
        ...(examineText !== undefined ? { examineText } : {}),
        ...(modelNpcId !== undefined ? { modelNpcId } : {}),
        ...(defaultAppearance !== undefined ? { defaultAppearance } : {}),
        ...(defaultEquipment !== undefined ? { defaultEquipment } : {}),
        ...(defaultCustomColors !== undefined ? { defaultCustomColors } : {}),
        ...(defaultAttackAnim !== undefined ? { defaultAttackAnim } : {}),
        combatLevel: publicNpcCombatLevel(npc),
        ...(npc.shop !== undefined ? { hasShop: true } : {}),
        ...(size !== undefined ? { size } : {}),
        ...(stationary !== undefined ? { stationary } : {}),
      };
    });
  }
  if (filename === 'objects.json' && Array.isArray(data)) {
    return (normalizeFireObjectRecipeSurface(data, true) as unknown[]).map((object) => {
      if (!isRecord(object)) return object;
      const {
        id,
        name,
        category,
        actions,
        blocking,
        width,
        depth,
        height,
        color,
        modelAssetId,
        depletedAssetId,
        stallMerchantNpcId,
        recipes,
      } = object;
      return {
        id,
        name,
        category,
        actions,
        blocking,
        width,
        ...(depth !== undefined ? { depth } : {}),
        height,
        color,
        ...(modelAssetId !== undefined ? { modelAssetId } : {}),
        ...(depletedAssetId !== undefined ? { depletedAssetId } : {}),
        ...(stallMerchantNpcId !== undefined ? { stallMerchantNpcId } : {}),
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
  if (!sanitize) {
    const raw = readFileSync(filePath, 'utf-8');
    if (filename !== 'objects.json') return raw;
    return JSON.stringify(normalizeFireObjectRecipeSurface(JSON.parse(raw), false));
  }
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
