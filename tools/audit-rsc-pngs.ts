#!/usr/bin/env bun
/**
 * Audits old item PNG assets against server/data/items.json.
 *
 * The rule is intentionally conservative: any filename currently referenced by
 * an item icon is kept, because original replacement art may have reused an old
 * RS Classic filename.
 *
 * Usage:
 *   bun tools/audit-rsc-pngs.ts
 *   bun tools/audit-rsc-pngs.ts --json
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, normalize, relative } from 'path';

type ItemDef = {
  id: number;
  name: string;
  icon?: string;
  sprite?: string;
  model?: string;
};

type ItemRef = {
  id: number;
  name: string;
  path: string;
  hasModel: boolean;
};

const ROOT = process.cwd();
const ITEMS_JSON = join(ROOT, 'server/data/items.json');
const ITEM_PNG_DIR = join(ROOT, 'client/public/items');
const SPRITE_ITEM_DIR = join(ROOT, 'client/public/sprites/items');

const args = new Set(process.argv.slice(2));
const jsonOutput = args.has('--json');

function readItems(): ItemDef[] {
  return JSON.parse(readFileSync(ITEMS_JSON, 'utf8'));
}

function walkFiles(dir: string, predicate: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];

  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...walkFiles(path, predicate));
    } else if (predicate(path)) {
      out.push(path);
    }
  }
  return out;
}

function relPublic(path: string): string {
  return relative(join(ROOT, 'client/public'), path).replaceAll('\\', '/');
}

function normalizeItemIconPath(icon: string): string {
  const clean = icon.replace(/^\/+/, '');
  if (clean.startsWith('items/')) return normalize(clean).replaceAll('\\', '/');
  return normalize(`items/${clean}`).replaceAll('\\', '/');
}

function normalizeSpritePath(sprite: string): string {
  const clean = sprite.replace(/^\/+/, '');
  if (clean.startsWith('sprites/items/')) return normalize(clean).replaceAll('\\', '/');
  return normalize(`sprites/items/${clean}`).replaceAll('\\', '/');
}

function byPathThenName(a: ItemRef, b: ItemRef): number {
  return a.path.localeCompare(b.path) || a.name.localeCompare(b.name) || a.id - b.id;
}

const items = readItems();
const itemPngs = walkFiles(ITEM_PNG_DIR, (file) => file.toLowerCase().endsWith('.png'))
  .map(relPublic)
  .sort((a, b) => a.localeCompare(b));
const spritePngs = walkFiles(SPRITE_ITEM_DIR, (file) => file.toLowerCase().endsWith('.png'))
  .map(relPublic)
  .sort((a, b) => a.localeCompare(b));

const iconRefs: ItemRef[] = [];
const spriteRefs: ItemRef[] = [];

for (const item of items) {
  const hasModel = Boolean(item.model);
  if (item.icon) {
    iconRefs.push({
      id: item.id,
      name: item.name,
      path: normalizeItemIconPath(item.icon),
      hasModel,
    });
  }
  if (item.sprite) {
    spriteRefs.push({
      id: item.id,
      name: item.name,
      path: normalizeSpritePath(item.sprite),
      hasModel,
    });
  }
}

const iconRefPaths = new Set(iconRefs.map((ref) => ref.path));
const spriteRefPaths = new Set(spriteRefs.map((ref) => ref.path));
const all2dRefPaths = new Set([...iconRefPaths, ...spriteRefPaths]);
const itemPngSet = new Set(itemPngs);
const spritePngSet = new Set(spritePngs);

const unreferencedItemPngs = itemPngs.filter((path) => !iconRefPaths.has(path) && !path.startsWith('items/3d/'));
const baked3dPngs = itemPngs.filter((path) => path.startsWith('items/3d/'));
const missingIconRefs = iconRefs.filter((ref) => !itemPngSet.has(ref.path)).sort(byPathThenName);
const missingSpriteRefs = spriteRefs.filter((ref) => !spritePngSet.has(ref.path)).sort(byPathThenName);
const modeledItemsWith2dRefs = [...iconRefs, ...spriteRefs]
  .filter((ref) => ref.hasModel)
  .sort(byPathThenName);
const noModel2dOnlyItems = items
  .filter((item) => !item.model && (item.icon || item.sprite))
  .map((item) => ({
    id: item.id,
    name: item.name,
    path: item.icon ? normalizeItemIconPath(item.icon) : normalizeSpritePath(item.sprite!),
  }))
  .sort((a, b) => a.id - b.id);
const noArtItems = items
  .filter((item) => !item.model && !item.icon && !item.sprite)
  .map((item) => ({ id: item.id, name: item.name }))
  .sort((a, b) => a.id - b.id);

const report = {
  counts: {
    items: items.length,
    itemPngs: itemPngs.length,
    spriteItemPngs: spritePngs.length,
    referencedItemPngs: itemPngs.filter((path) => all2dRefPaths.has(path)).length,
    baked3dPngs: baked3dPngs.length,
    safeToDeleteUnreferencedItemPngs: unreferencedItemPngs.length,
    missingIconRefs: missingIconRefs.length,
    missingSpriteRefs: missingSpriteRefs.length,
    modeledItemsWith2dRefs: modeledItemsWith2dRefs.length,
    noModel2dOnlyItems: noModel2dOnlyItems.length,
    noArtItems: noArtItems.length,
  },
  safeToDeleteUnreferencedItemPngs: unreferencedItemPngs,
  keepReferencedItemPngs: itemPngs.filter((path) => iconRefPaths.has(path)),
  keepBaked3dPngs: baked3dPngs,
  keepReferencedSpritePngs: spritePngs.filter((path) => spriteRefPaths.has(path)),
  missingIconRefs,
  missingSpriteRefs,
  modeledItemsWith2dRefs,
  noModel2dOnlyItems,
  noArtItems,
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('RS Classic item PNG audit');
  console.log('---');
  for (const [key, value] of Object.entries(report.counts)) {
    console.log(`${key}: ${value}`);
  }

  console.log('\nSafe delete candidates:');
  for (const path of unreferencedItemPngs.slice(0, 40)) console.log(`  ${path}`);
  if (unreferencedItemPngs.length > 40) {
    console.log(`  ...${unreferencedItemPngs.length - 40} more; run with --json for the full list`);
  }

  if (missingIconRefs.length || missingSpriteRefs.length) {
    console.log('\nMissing referenced 2D assets:');
    for (const ref of [...missingIconRefs, ...missingSpriteRefs].slice(0, 40)) {
      console.log(`  #${ref.id} ${ref.name}: ${ref.path}${ref.hasModel ? ' (has model)' : ''}`);
    }
  }

  console.log('\n2D-only items to keep until replaced:');
  for (const item of noModel2dOnlyItems.slice(0, 40)) {
    console.log(`  #${item.id} ${item.name}: ${item.path}`);
  }
  if (noModel2dOnlyItems.length > 40) {
    console.log(`  ...${noModel2dOnlyItems.length - 40} more; run with --json for the full list`);
  }
}
