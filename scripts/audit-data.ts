import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ALL_SKILLS } from '../shared/index';

interface AuditIssue {
  file: string;
  message: string;
}

interface ItemDefLike {
  id?: unknown;
  name?: unknown;
  icon?: unknown;
  sprite?: unknown;
  model?: unknown;
  equipSlot?: unknown;
}

interface NpcDefLike {
  id?: unknown;
  name?: unknown;
  dialogue?: unknown;
  shop?: unknown;
  bankAccess?: unknown;
}

interface NpcSpawnLike {
  npcId?: unknown;
  name?: unknown;
  x?: unknown;
  z?: unknown;
}

const rootDir = join(import.meta.dir, '..');
const dataDir = join(rootDir, 'server/data');
const mapsDir = join(dataDir, 'maps');
const publicDir = join(rootDir, 'client/public');

const issues: AuditIssue[] = [];
const warnings: AuditIssue[] = [];
const skillIds = new Set<string>(ALL_SKILLS);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function rel(path: string): string {
  return relative(rootDir, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function addIssue(file: string, message: string): void {
  issues.push({ file: rel(file), message });
}

function addWarning(file: string, message: string): void {
  warnings.push({ file: rel(file), message });
}

function walkFiles(dir: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'backups') continue;
      out.push(...walkFiles(path, predicate));
    } else if (entry.isFile() && predicate(path)) {
      out.push(path);
    }
  }
  return out;
}

function jsonFiles(dir: string): string[] {
  return walkFiles(dir, (path) => path.endsWith('.json'));
}

function ensureUniqueId<T extends string | number>(file: string, label: string, entries: unknown[], ids: Set<T>): void {
  const seen = new Set<string | number>();
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) {
      addIssue(file, `${label} at index ${index} is not an object`);
      continue;
    }
    const id = entry.id;
    if (typeof id !== 'number' && typeof id !== 'string') {
      addIssue(file, `${label} at index ${index} is missing a numeric/string id`);
      continue;
    }
    if (seen.has(id)) addIssue(file, `duplicate ${label} id "${id}"`);
    seen.add(id);
    ids.add(id as T);
  }
}

function assertItemRef(file: string, context: string, itemIds: Set<number>, id: unknown): void {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    addIssue(file, `${context} has invalid item id ${JSON.stringify(id)}`);
  } else if (!itemIds.has(id)) {
    addIssue(file, `${context} references missing item id ${id}`);
  }
}

function assertNpcRef(file: string, context: string, npcIds: Set<number>, id: unknown): void {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    addIssue(file, `${context} has invalid NPC id ${JSON.stringify(id)}`);
  } else if (!npcIds.has(id)) {
    addIssue(file, `${context} references missing NPC id ${id}`);
  }
}

function assertObjectRef(file: string, context: string, objectIds: Set<number>, id: unknown): void {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    addIssue(file, `${context} has invalid object id ${JSON.stringify(id)}`);
  } else if (!objectIds.has(id)) {
    addIssue(file, `${context} references missing object id ${id}`);
  }
}

function assertQuestRef(file: string, context: string, questIds: Set<string>, id: unknown): void {
  if (typeof id !== 'string' || id.length === 0) {
    addIssue(file, `${context} has invalid quest id ${JSON.stringify(id)}`);
  } else if (!questIds.has(id)) {
    addIssue(file, `${context} references missing quest id "${id}"`);
  }
}

function assertSkillRef(file: string, context: string, skill: unknown): void {
  if (typeof skill !== 'string' || !skillIds.has(skill)) {
    addIssue(file, `${context} references missing skill "${String(skill)}"`);
  }
}

function validatePath(file: string, context: string, publicPath: string): void {
  const normalized = publicPath.replace(/^\/+/, '');
  const diskPath = join(publicDir, normalized);
  if (!existsSync(diskPath) || !statSync(diskPath).isFile()) {
    addIssue(file, `${context} points at missing file /${normalized}`);
  }
}

function itemModelPublicPath(item: ItemDefLike): string | null {
  if (typeof item.model !== 'string' || !item.model) return null;
  if (item.model.startsWith('/')) return item.model;
  if (typeof item.equipSlot !== 'string' || !item.equipSlot) return null;
  return `/assets/equipment/${item.equipSlot}/${item.model}`;
}

function auditItemAssets(file: string, items: ItemDefLike[]): void {
  for (const item of items) {
    const id = typeof item.id === 'number' ? item.id : '?';
    const context = `item ${id}`;
    if (typeof item.icon === 'string') validatePath(file, `${context} icon`, `/items/${item.icon}`);
    if (typeof item.sprite === 'string') validatePath(file, `${context} sprite`, `/sprites/items/${item.sprite}`);

    const modelPath = itemModelPublicPath(item);
    if (modelPath) validatePath(file, `${context} model`, modelPath);
    if (typeof item.model === 'string' && !modelPath) {
      addWarning(file, `${context} has a relative model path without equipSlot: ${item.model}`);
    }
  }
}

function auditThumbnailOverrides(file: string, itemIds: Set<number>): void {
  const overrides = readJson<Record<string, unknown>>(file);
  if (!isRecord(overrides)) {
    addIssue(file, 'thumbnail overrides root is not an object');
    return;
  }
  for (const key of Object.keys(overrides)) {
    if (key.startsWith('_')) continue;
    const id = Number(key);
    if (!Number.isInteger(id) || !itemIds.has(id)) {
      addIssue(file, `thumbnail override references missing item id "${key}"`);
    }
  }
}

function auditShopKeys(file: string, npcIds: Set<number>): void {
  const shops = readJson<Record<string, unknown>>(file);
  for (const key of Object.keys(shops)) {
    const id = Number(key);
    if (!Number.isInteger(id) || !npcIds.has(id)) {
      addIssue(file, `shop key "${key}" does not match an NPC definition`);
    }
  }
}

function auditSuccessChanceKeys(file: string, context: string, itemIds: Set<number>, value: unknown): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    const id = Number(key);
    if (!Number.isInteger(id) || !itemIds.has(id)) {
      addIssue(file, `${context}.successChances references missing tool item id "${key}"`);
    }
  }
}

function auditQuestRewardSkills(file: string, context: string, value: unknown): void {
  if (!isRecord(value)) return;
  const rewards = value.rewards;
  if (!isRecord(rewards) || !isRecord(rewards.xp)) return;
  for (const key of Object.keys(rewards.xp)) {
    assertSkillRef(file, `${context}.rewards.xp`, key);
  }
}

function hasDialogueAction(value: unknown, actionType: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasDialogueAction(entry, actionType));
  if (!isRecord(value)) return false;

  const action = value.action;
  if (isRecord(action) && action.type === actionType) return true;
  const actions = value.actions;
  if (Array.isArray(actions) && actions.some((entry) => isRecord(entry) && entry.type === actionType)) return true;

  return Object.values(value).some((entry) => hasDialogueAction(entry, actionType));
}

function collectNpcSpawns(mapFiles: string[]): Map<number, Array<{ file: string; spawn: NpcSpawnLike }>> {
  const spawnsByNpcId = new Map<number, Array<{ file: string; spawn: NpcSpawnLike }>>();
  for (const file of mapFiles) {
    if (!file.endsWith('/spawns.json')) continue;
    const data = readJson<unknown>(file);
    if (!isRecord(data) || !Array.isArray(data.npcs)) continue;
    for (const spawn of data.npcs) {
      if (!isRecord(spawn) || typeof spawn.npcId !== 'number') continue;
      const entries = spawnsByNpcId.get(spawn.npcId) ?? [];
      entries.push({ file, spawn: spawn as NpcSpawnLike });
      spawnsByNpcId.set(spawn.npcId, entries);
    }
  }
  return spawnsByNpcId;
}

function auditNpcSpawnCoverage(npcsPath: string, npcs: NpcDefLike[], mapFiles: string[]): void {
  const spawnsByNpcId = collectNpcSpawns(mapFiles);
  for (const npc of npcs) {
    if (typeof npc.id !== 'number') continue;
    const name = typeof npc.name === 'string' ? npc.name : `NPC ${npc.id}`;
    const spawnCount = spawnsByNpcId.get(npc.id)?.length ?? 0;

    if (hasDialogueAction(npc.dialogue, 'openAppearance') && spawnCount === 0) {
      addIssue(npcsPath, `${name} (${npc.id}) has openAppearance dialogue but no live map spawn uses npcId ${npc.id}`);
    }

    if ((npc.dialogue || npc.shop || npc.bankAccess === true) && spawnCount === 0) {
      addWarning(npcsPath, `${name} (${npc.id}) is interactive but has no live map spawn`);
    }
  }

  for (const npc of npcs) {
    if (typeof npc.id !== 'number' || npc.bankAccess !== true) continue;
    for (const { file, spawn } of spawnsByNpcId.get(npc.id) ?? []) {
      if (typeof spawn.name === 'string' && spawn.name.trim()) continue;
      const x = typeof spawn.x === 'number' ? spawn.x : '?';
      const z = typeof spawn.z === 'number' ? spawn.z : '?';
      addWarning(file, `bank NPC spawn for npcId ${npc.id} at (${x},${z}) has no explicit name override`);
    }
  }
}

function auditGenericRefs(
  file: string,
  value: unknown,
  refs: {
    itemIds: Set<number>;
    npcIds: Set<number>;
    objectIds: Set<number>;
    questIds: Set<string>;
  },
  path: string = '$',
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => auditGenericRefs(file, entry, refs, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;

  auditSuccessChanceKeys(file, path, refs.itemIds, value.successChances);
  auditQuestRewardSkills(file, path, value);

  for (const [key, child] of Object.entries(value)) {
    switch (key) {
      case 'itemId':
      case 'inputItemId':
      case 'secondInputItemId':
      case 'outputItemId':
      case 'doorKeyItemId':
        assertItemRef(file, `${path}.${key}`, refs.itemIds, child);
        break;
      case 'itemIds':
        if (!Array.isArray(child)) {
          addIssue(file, `${path}.${key} is not an array`);
        } else {
          child.forEach((id, index) => assertItemRef(file, `${path}.${key}[${index}]`, refs.itemIds, id));
        }
        break;
      case 'npcId':
      case 'npcDefId':
        assertNpcRef(file, `${path}.${key}`, refs.npcIds, child);
        break;
      case 'objectId':
        assertObjectRef(file, `${path}.${key}`, refs.objectIds, child);
        break;
      case 'questId':
        assertQuestRef(file, `${path}.${key}`, refs.questIds, child);
        break;
      case 'skill':
      case 'equipSkill':
        assertSkillRef(file, `${path}.${key}`, child);
        break;
      default:
        break;
    }

    auditGenericRefs(file, child, refs, `${path}.${key}`);
  }
}

function auditStaticData(): void {
  const itemsPath = join(dataDir, 'items.json');
  const npcsPath = join(dataDir, 'npcs.json');
  const objectsPath = join(dataDir, 'objects.json');
  const questsPath = join(dataDir, 'quests.json');
  const shopsPath = join(dataDir, 'shops.json');
  const thumbnailOverridesPath = join(dataDir, 'thumbnail-overrides.json');

  const items = readJson<unknown[]>(itemsPath);
  const npcs = readJson<unknown[]>(npcsPath);
  const objects = readJson<unknown[]>(objectsPath);
  const quests = readJson<unknown[]>(questsPath);

  const itemIds = new Set<number>();
  const npcIds = new Set<number>();
  const objectIds = new Set<number>();
  const questIds = new Set<string>();

  ensureUniqueId(itemsPath, 'item', items, itemIds);
  ensureUniqueId(npcsPath, 'NPC', npcs, npcIds);
  ensureUniqueId(objectsPath, 'object', objects, objectIds);
  ensureUniqueId(questsPath, 'quest', quests, questIds);

  for (const id of itemIds) {
    if (typeof id !== 'number') addIssue(itemsPath, `item id "${id}" is not numeric`);
  }
  for (const id of npcIds) {
    if (typeof id !== 'number') addIssue(npcsPath, `NPC id "${id}" is not numeric`);
  }
  for (const id of objectIds) {
    if (typeof id !== 'number') addIssue(objectsPath, `object id "${id}" is not numeric`);
  }

  auditItemAssets(itemsPath, items.filter(isRecord) as ItemDefLike[]);
  auditShopKeys(shopsPath, npcIds);
  auditThumbnailOverrides(thumbnailOverridesPath, itemIds);

  const refs = { itemIds, npcIds, objectIds, questIds };
  for (const file of [npcsPath, objectsPath, questsPath, shopsPath]) {
    auditGenericRefs(file, readJson<unknown>(file), refs);
  }

  const mapFiles = jsonFiles(mapsDir);
  auditNpcSpawnCoverage(npcsPath, npcs.filter(isRecord) as NpcDefLike[], mapFiles);

  const spellFiles = jsonFiles(join(dataDir, 'spells'));
  const spellIds = new Set<string>();
  for (const file of spellFiles) {
    const spell = readJson<unknown>(file);
    if (!isRecord(spell) || typeof spell.id !== 'string' || !spell.id) {
      addIssue(file, 'spell definition is missing string id');
    } else if (spellIds.has(spell.id)) {
      addIssue(file, `duplicate spell id "${spell.id}"`);
    } else {
      spellIds.add(spell.id);
    }
    auditGenericRefs(file, spell, refs);
  }

  for (const file of mapFiles) {
    auditGenericRefs(file, readJson<unknown>(file), refs);
  }
}

auditStaticData();

if (issues.length > 0) {
  console.error(`Data audit failed with ${issues.length} issue(s):`);
  for (const issue of issues) console.error(`- ${issue.file}: ${issue.message}`);
  if (warnings.length > 0) {
    console.error(`Warnings (${warnings.length}):`);
    for (const warning of warnings) console.error(`- ${warning.file}: ${warning.message}`);
  }
  process.exit(1);
}

if (warnings.length > 0) {
  console.log(`Data audit warnings (${warnings.length}):`);
  for (const warning of warnings) console.log(`- ${warning.file}: ${warning.message}`);
}

console.log(`Data audit passed (${ALL_SKILLS.length} skills checked).`);
