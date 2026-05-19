import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

interface AssetRegistry {
  assets?: Array<{
    id?: string;
    path?: string;
  }>;
}

interface AuditIssue {
  file: string;
  message: string;
}

const rootDir = join(import.meta.dir, '..');
const publicDir = join(rootDir, 'client/public');
const registryPath = join(publicDir, 'assets/assets.json');
const mapsDir = join(rootDir, 'server/data/maps');
const issues: AuditIssue[] = [];
const warnings: AuditIssue[] = [];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function addIssue(file: string, message: string): void {
  issues.push({ file: relative(rootDir, file), message });
}

function addWarning(file: string, message: string): void {
  warnings.push({ file: relative(rootDir, file), message });
}

function walkJsonFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'backups') continue;
      files.push(...walkJsonFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(path);
    }
  }
  return files;
}

function auditRegistry(): Set<string> {
  const registry = readJson<AssetRegistry>(registryPath);
  const assets = Array.isArray(registry.assets) ? registry.assets : [];
  const ids = new Set<string>();

  for (const [index, asset] of assets.entries()) {
    if (!asset.id) {
      addIssue(registryPath, `asset at index ${index} is missing id`);
      continue;
    }
    if (ids.has(asset.id)) addWarning(registryPath, `duplicate asset id "${asset.id}"`);
    ids.add(asset.id);

    if (!asset.path) {
      addIssue(registryPath, `asset "${asset.id}" is missing path`);
      continue;
    }

    const normalizedPath = asset.path.replace(/^\/+/, '');
    const diskPath = join(publicDir, normalizedPath);
    if (!existsSync(diskPath)) {
      addIssue(registryPath, `asset "${asset.id}" points at missing file ${asset.path}`);
    }
  }

  return ids;
}

function auditPlacedObjects(assetIds: Set<string>): void {
  const objectFiles = walkJsonFiles(mapsDir).filter((file) => {
    const parts = relative(mapsDir, file).split(/[\\/]/);
    return parts.includes('objects');
  });

  for (const file of objectFiles) {
    const placedObjects = readJson<unknown>(file);
    if (!Array.isArray(placedObjects)) continue;

    placedObjects.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return;
      const assetId = (entry as { assetId?: unknown }).assetId;
      if (typeof assetId !== 'string' || !assetId) return;
      if (!assetIds.has(assetId)) {
        addIssue(file, `placed object ${index} references missing asset id "${assetId}"`);
      }
    });
  }
}

const assetIds = auditRegistry();
auditPlacedObjects(assetIds);

if (issues.length > 0) {
  console.error(`Asset audit failed with ${issues.length} issue(s):`);
  for (const issue of issues) {
    console.error(`- ${issue.file}: ${issue.message}`);
  }
  if (warnings.length > 0) {
    console.error(`Warnings (${warnings.length}):`);
    for (const warning of warnings) {
      console.error(`- ${warning.file}: ${warning.message}`);
    }
  }
  process.exit(1);
}

if (warnings.length > 0) {
  console.log(`Asset audit warnings (${warnings.length}):`);
  for (const warning of warnings) {
    console.log(`- ${warning.file}: ${warning.message}`);
  }
}

console.log(`Asset audit passed (${assetIds.size} registered assets checked).`);
