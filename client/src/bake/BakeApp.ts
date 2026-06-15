/**
 * Item-thumbnail baker. Run by visiting `?bake=1` in the browser while the
 * server is running locally (admin = loopback). Iterates every item with a
 * GLB `model`, runs ThumbnailRenderer (with tier tint for tool tiers), and
 * POSTs each PNG to `/api/dev/item-thumb`. On completion, POSTs the final
 * pose-aware manifest to `/api/dev/item-thumbs/manifest`. PNGs land in
 * `client/public/items/3d/` and ship as static assets.
 *
 * Re-run any time items.json or TOOL_TIER_METAL_COLOR changes for items
 * that already have baked thumbs. New items work via the runtime fallback
 * automatically — baking is the perf optimisation, not a correctness step.
 */

import type { ItemDef } from '@projectrs/shared';
import { getThumbnail, getThumbnailPoseKey, THUMBNAIL_RENDERER_VERSION } from '../rendering/ThumbnailRenderer';
import { resolveItemModelPath, buildThumbnailOptionsForItem, setThumbnailItemCatalog, stackModelScaleForItem } from '../rendering/ItemIcon';

interface BakeTarget {
  id: number;
  name: string;
  def: ItemDef;
  modelPath: string;
  quantity: number;
  file: string;
  hasStackVariants: boolean;
}

function stackBakeQuantities(def: ItemDef): number[] {
  if (def.thumbnailModel) return [1];
  const quantities = new Set<number>([1]);
  for (const variant of def.stackModels ?? []) {
    const quantity = Number(variant?.minQuantity);
    if (Number.isInteger(quantity) && quantity > 0) quantities.add(quantity);
  }
  return [...quantities].sort((a, b) => a - b);
}

function buildTargets(defs: ItemDef[]): BakeTarget[] {
  const targets: BakeTarget[] = [];
  for (const def of defs) {
    const quantities = stackBakeQuantities(def);
    const hasStackVariants = quantities.length > 1;
    for (const quantity of quantities) {
      const modelPath = resolveItemModelPath(def, quantity);
      if (!modelPath) continue;
      targets.push({
        id: def.id,
        name: quantity === 1 ? def.name : `${def.name} x${quantity}`,
        def,
        modelPath,
        quantity,
        file: quantity === 1 ? `/items/3d/${def.id}.png` : `/items/3d/${def.id}-${quantity}.png`,
        hasStackVariants,
      });
    }
  }
  targets.sort((a, b) => a.id - b.id || a.quantity - b.quantity);
  return targets;
}

interface BakeUI {
  setStatus: (status: string) => void;
  setProgress: (done: number, total: number) => void;
  appendLog: (line: string, color?: string) => void;
}

function mountBakeUI(): BakeUI {
  document.body.style.cssText = `
    margin: 0; padding: 24px; background: #1a1410; color: #ddd;
    font-family: Arial, Helvetica, sans-serif; font-size: 13px; min-height: 100vh;
  `;
  document.body.innerHTML = `
    <h1 style="color: #d8372b; margin: 0 0 12px;">Item Thumbnail Baker</h1>
    <div id="bake-status" style="color: #aaa; margin-bottom: 8px;">Loading items...</div>
    <div id="bake-progress" style="margin-bottom: 12px;">
      <div style="background: #333; border: 1px solid #555; width: 100%; max-width: 600px; height: 18px;">
        <div id="bake-bar" style="background: #d8372b; height: 100%; width: 0%; transition: width 0.2s;"></div>
      </div>
      <div id="bake-count" style="color: #888; font-size: 11px; margin-top: 4px;">0 / 0</div>
    </div>
    <pre id="bake-log" style="background: #111; border: 1px solid #333; padding: 12px; max-width: 800px; max-height: 60vh; overflow-y: auto; font-size: 11px; line-height: 1.4; color: #aaa; white-space: pre-wrap; margin: 0;"></pre>
  `;

  const statusEl = document.getElementById('bake-status')!;
  const barEl = document.getElementById('bake-bar')!;
  const countEl = document.getElementById('bake-count')!;
  const logEl = document.getElementById('bake-log')!;

  return {
    setStatus: (s) => { statusEl.textContent = s; },
    setProgress: (done, total) => {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      (barEl as HTMLElement).style.width = `${pct}%`;
      countEl.textContent = `${done} / ${total}`;
    },
    appendLog: (line, color) => {
      const span = document.createElement('span');
      if (color) span.style.color = color;
      span.textContent = line + '\n';
      logEl.appendChild(span);
      logEl.scrollTop = logEl.scrollHeight;
    },
  };
}

async function postPng(id: number, file: string, dataUrl: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/dev/item-thumb', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, file, dataUrl }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  return { ok: true };
}

interface BakedManifestLeaf {
  file: string;
  poseKey: string;
  rendererVersion: number;
}

type BakedManifestEntry = BakedManifestLeaf | { variants: BakedManifestLeaf[] };

interface BakedManifest {
  ids: number[];
  entries: Record<string, BakedManifestEntry>;
}

function normalizeManifestLeaf(raw: unknown): BakedManifestLeaf | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<BakedManifestLeaf>;
  if (typeof entry.file !== 'string' || typeof entry.poseKey !== 'string') return null;
  return {
    file: entry.file,
    poseKey: entry.poseKey,
    rendererVersion: typeof entry.rendererVersion === 'number' ? entry.rendererVersion : THUMBNAIL_RENDERER_VERSION,
  };
}

function normalizeManifestEntry(raw: unknown): BakedManifestEntry | null {
  const direct = normalizeManifestLeaf(raw);
  if (raw && typeof raw === 'object') {
    const variants = (raw as { variants?: unknown }).variants;
    if (Array.isArray(variants)) {
      const normalized = variants.map(normalizeManifestLeaf).filter((entry): entry is BakedManifestLeaf => !!entry);
      if (direct) normalized.unshift(direct);
      if (normalized.length) return { variants: normalized };
    }
  }
  return direct;
}

async function loadExistingManifest(): Promise<BakedManifest> {
  try {
    const res = await fetch('/items/3d/manifest.json', { cache: 'no-store' });
    if (!res.ok) return { ids: [], entries: {} };
    const data = await res.json();
    if (Array.isArray(data)) {
      return {
        ids: data.filter((id): id is number => Number.isInteger(id) && id > 0),
        entries: {},
      };
    }
    if (!data || typeof data !== 'object') return { ids: [], entries: {} };
    const entries: Record<string, BakedManifestEntry> = {};
    const rawEntries = (data as { entries?: unknown }).entries;
    if (rawEntries && typeof rawEntries === 'object') {
      for (const [key, raw] of Object.entries(rawEntries)) {
        const entry = normalizeManifestEntry(raw);
        if (entry) entries[key] = entry;
      }
    }
    const rawIds = (data as { ids?: unknown }).ids;
    const ids = Array.isArray(rawIds)
      ? rawIds.filter((id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0)
      : Object.keys(entries).map(Number).filter((id) => Number.isInteger(id) && id > 0);
    return { ids, entries };
  } catch {
    return { ids: [], entries: {} };
  }
}

async function postManifest(
  ids: number[],
  entries: Record<string, BakedManifestEntry>,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/dev/item-thumbs/manifest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, entries }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
  return { ok: true };
}

export async function runBake(): Promise<void> {
  const ui = mountBakeUI();
  ui.appendLog('Loading items.json...');
  const itemParam = new URLSearchParams(window.location.search).get('item');
  const targetItemId = itemParam ? Number(itemParam) : null;

  let defs: ItemDef[];
  try {
    const token = localStorage.getItem('evilquest_token') || '';
    const res = await fetch('/data/items.json', {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      credentials: 'same-origin',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    defs = await res.json();
  } catch (e) {
    ui.setStatus('Failed to load items.json');
    ui.appendLog(`Error: ${e instanceof Error ? e.message : String(e)}`, '#f55');
    return;
  }

  setThumbnailItemCatalog(defs);
  let targets = buildTargets(defs);
  if (targetItemId !== null) {
    if (!Number.isInteger(targetItemId) || targetItemId <= 0) {
      ui.setStatus('Invalid item id.');
      ui.appendLog(`Invalid item id: ${itemParam}`, '#f55');
      return;
    }
    targets = targets.filter((target) => target.id === targetItemId);
  }
  if (targets.length === 0) {
    ui.setStatus(targetItemId !== null ? `No GLB thumbnail target for item ${targetItemId}.` : 'No items with GLB models. Nothing to bake.');
    return;
  }

  ui.appendLog(targetItemId !== null
    ? `Baking item ${targetItemId}.`
    : `Found ${targets.length} items with GLB models.`);
  ui.setStatus(targetItemId !== null
    ? `Rendering item ${targetItemId}...`
    : `Rendering ${targets.length} thumbnails (serial)...`);
  ui.setProgress(0, targets.length);

  const baked: number[] = [];
  const manifestEntries: Record<string, BakedManifestEntry> = {};
  let done = 0;
  let failed = 0;

  for (const target of targets) {
    const label = `#${target.id} ${target.name}`;
    try {
      const opts = await buildThumbnailOptionsForItem(target.def);
      const stackScale = stackModelScaleForItem(target.def, target.quantity);
      if (stackScale !== 1) opts.iconScale = (opts.iconScale ?? 1) * stackScale;
      const dataUrl = await getThumbnail(target.modelPath, opts);
      if (!dataUrl) {
        ui.appendLog(`  ${label}: renderer returned null`, '#f55');
        failed++;
      } else {
        const post = await postPng(target.id, target.file, dataUrl);
        if (post.ok) {
          baked.push(target.id);
          const entry: BakedManifestLeaf = {
            file: target.file,
            poseKey: getThumbnailPoseKey(target.modelPath, opts),
            rendererVersion: THUMBNAIL_RENDERER_VERSION,
          };
          if (target.hasStackVariants) {
            const existing = manifestEntries[String(target.id)];
            const variants = existing && 'variants' in existing ? existing.variants : [];
            manifestEntries[String(target.id)] = { variants: [...variants, entry] };
          } else {
            manifestEntries[String(target.id)] = entry;
          }
          ui.appendLog(`  ${label}: OK`, '#7c7');
        } else {
          ui.appendLog(`  ${label}: POST failed — ${post.error}`, '#f55');
          failed++;
        }
      }
    } catch (e) {
      ui.appendLog(`  ${label}: ${e instanceof Error ? e.message : String(e)}`, '#f55');
      failed++;
    }
    done++;
    ui.setProgress(done, targets.length);
  }

  ui.setStatus('Writing manifest...');
  let manifestIds = Array.from(new Set(baked)).sort((a, b) => a - b);
  let finalManifestEntries = manifestEntries;
  if (targetItemId !== null) {
    const existing = await loadExistingManifest();
    finalManifestEntries = { ...existing.entries, ...manifestEntries };
    manifestIds = Array.from(new Set([...existing.ids, ...baked])).sort((a, b) => a - b);
  }
  const m = await postManifest(manifestIds, finalManifestEntries);
  if (!m.ok) {
    ui.appendLog(`Manifest POST failed: ${m.error}`, '#f55');
    ui.setStatus('Done (manifest failed)');
    return;
  }
  ui.appendLog(targetItemId !== null
    ? `Manifest updated for item ${targetItemId}.`
    : `Manifest written with ${baked.length} ids.`, '#7c7');
  ui.setStatus(
    failed === 0
      ? `Done. Baked ${baked.length}/${targets.length} thumbnails.`
      : `Done with ${failed} failure(s). Baked ${baked.length}/${targets.length}.`,
  );
}
