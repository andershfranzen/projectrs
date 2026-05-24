import { resolveEquipmentModelPath, type ItemDef } from '@projectrs/shared';
import { METAL_TIER_THUMBNAIL_COLOR, TOOL_TIER_METAL_COLOR } from '../data/EquipmentConfig';
import { getThumbnail, type ThumbnailCamera, type ThumbnailOptions } from './ThumbnailRenderer';

/**
 * Central icon resolver for items. Precedence:
 *   1. Pre-baked PNG at `/items/3d/{id}.png` (zero runtime cost).
 *   2. Runtime 3D render of `def.model` (IDB-cached across reloads).
 *   3. `def.sprite` (legacy 2D, only for items without a 3D model).
 *   4. `def.icon` (legacy 2D, only for items without a 3D model).
 *   5. null (caller renders a placeholder).
 *
 * The baked-PNG manifest is fetched once on first call.
 */

let _manifestPromise: Promise<Set<number>> | null = null;
let _itemCatalog: ItemDef[] = [];
let _itemFamilyIndex = new Map<string, ItemDef[]>();

export const ITEM_THUMBNAIL_TIERS = ['Bronze', 'Iron', 'Steel', 'Mithril', 'Black Bronze'];

const ITEM_THUMBNAIL_FAMILY_SUFFIXES: Array<{ label: string; aliases: string[] }> = [
  { label: '2-handed Sword', aliases: ['2-handed sword', '2 handed sword', '2h sword'] },
  { label: 'Amulet of Power', aliases: ['amulet of power'] },
  { label: 'Armet Helmet (F)', aliases: ['armet helmet (f)', 'armet helmet f'] },
  { label: 'Armet Helmet', aliases: ['armet helmet'] },
  { label: 'Battle Axe', aliases: ['battle axe', 'battleaxe'] },
  { label: 'Beret', aliases: ['beret'] },
  { label: 'Bishop Hat', aliases: ['bishop hat'] },
  { label: 'Bycocket Hat', aliases: ['bycocket hat'] },
  { label: 'Camel Cape', aliases: ['camel cape'] },
  { label: 'Chain Mail Body', aliases: ['chain mail body', 'chainmail body', 'chainbody'] },
  { label: 'Chainmail', aliases: ['chainmail', 'chain mail'] },
  { label: 'Circlet (F)', aliases: ['circlet (f)', 'circlet f'] },
  { label: 'Circlet', aliases: ['circlet'] },
  { label: 'Crystal Staff', aliases: ['crystal staff'] },
  { label: 'Cuirass', aliases: ['cuirass'] },
  { label: 'Eyepatch (Left)', aliases: ['eyepatch (left)', 'left eyepatch', 'eyepatch left'] },
  { label: 'Eyepatch (Right)', aliases: ['eyepatch (right)', 'right eyepatch', 'eyepatch right'] },
  { label: 'Face Mask (F)', aliases: ['face mask (f)', 'face mask f'] },
  { label: 'Face Mask', aliases: ['face mask', 'facemask'] },
  { label: 'Felted Hat', aliases: ['felted hat'] },
  { label: 'Full Helmet', aliases: ['full helmet', 'full helm'] },
  { label: 'Great Helm', aliases: ['great helm', 'great helmet'] },
  { label: 'Headband', aliases: ['headband'] },
  { label: 'Hood', aliases: ['hood'] },
  { label: 'Kettle Hat (F)', aliases: ['kettle hat (f)', 'kettle hat f'] },
  { label: 'Kettle Hat', aliases: ['kettle hat'] },
  { label: 'Kite Shield', aliases: ['kite shield'] },
  { label: 'Leather Body', aliases: ['leather body'] },
  { label: 'Leather Coif (F)', aliases: ['leather coif (f)', 'leather coif f'] },
  { label: 'Leather Coif', aliases: ['leather coif'] },
  { label: 'Long Sword', aliases: ['long sword', 'longsword'] },
  { label: 'Medium Helmet', aliases: ['medium helmet', 'med helm', 'medium helm'] },
  { label: 'Plate Mail Body', aliases: ['plate mail body', 'platemail body', 'platebody'] },
  { label: 'Plate Mail Legs', aliases: ['plate mail legs', 'platemail legs', 'platelegs'] },
  { label: 'Plated Skirt', aliases: ['plated skirt', 'plateskirt'] },
  { label: 'Pointed Mage Hat', aliases: ['pointed mage hat'] },
  { label: 'Short Sword', aliases: ['short sword', 'shortsword'] },
  { label: 'Skullcap', aliases: ['skullcap', 'skull cap'] },
  { label: 'Square Shield', aliases: ['square shield'] },
  { label: 'Staff', aliases: ['staff'] },
  { label: 'Pickaxe', aliases: ['pickaxe', 'pick axe'] },
  { label: 'Scimitar', aliases: ['scimitar'] },
  { label: 'Dagger', aliases: ['dagger'] },
  { label: 'Spear', aliases: ['spear'] },
  { label: 'Arrows', aliases: ['arrows', 'arrow'] },
  { label: 'Throwing Dart', aliases: ['throwing dart', 'dart'] },
  { label: 'Throwing Knife', aliases: ['throwing knife'] },
  { label: 'Tyrolean Hat', aliases: ['tyrolean hat'] },
  { label: 'Wide Mage Hat', aliases: ['wide mage hat'] },
  { label: 'Witch Hat', aliases: ['witch hat'] },
  { label: 'Sword', aliases: ['sword'] },
  { label: 'Mace', aliases: ['mace'] },
  { label: 'Axe', aliases: ['axe'] },
];

function normalizeFamilyText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b2h\b/g, '2 handed')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

const FAMILY_SUFFIX_ALIASES = ITEM_THUMBNAIL_FAMILY_SUFFIXES
  .flatMap((family) => family.aliases.map((alias) => ({
    label: family.label,
    normalized: normalizeFamilyText(alias),
  })))
  .sort((a, b) => b.normalized.length - a.normalized.length);

export function itemThumbnailTier(item: ItemDef): string {
  return ITEM_THUMBNAIL_TIERS.find((tier) => item.name === tier || item.name?.startsWith(`${tier} `)) || '';
}

export function itemThumbnailFamily(item: ItemDef): string {
  const tier = itemThumbnailTier(item);
  const name = item.name || '';
  if (tier) return name.slice(tier.length).trim();
  const normalizedName = normalizeFamilyText(name);
  const suffix = FAMILY_SUFFIX_ALIASES.find((entry) => normalizedName.endsWith(entry.normalized));
  return suffix?.label ?? name;
}

export function itemThumbnailFamilyKey(item: ItemDef): string | null {
  const slot = item.equipSlot?.trim().toLowerCase();
  const family = normalizeFamilyText(itemThumbnailFamily(item));
  return slot && family ? `${slot}:${family}` : null;
}

export function itemThumbnailTierIndex(item: ItemDef): number {
  const tier = itemThumbnailTier(item);
  return tier ? ITEM_THUMBNAIL_TIERS.indexOf(tier) : Number.MAX_SAFE_INTEGER;
}

function findBronzeFamilyItem(candidates: readonly ItemDef[]): ItemDef | undefined {
  return candidates.find((item) => itemThumbnailTier(item) === 'Bronze');
}

export function setThumbnailItemCatalog(defs: Iterable<ItemDef>): void {
  _itemCatalog = Array.from(defs);
  _itemFamilyIndex = new Map<string, ItemDef[]>();
  for (const item of _itemCatalog) {
    const key = itemThumbnailFamilyKey(item);
    if (!key) continue;
    const arr = _itemFamilyIndex.get(key);
    if (arr) arr.push(item);
    else _itemFamilyIndex.set(key, [item]);
  }
  for (const arr of _itemFamilyIndex.values()) {
    arr.sort((a, b) => itemThumbnailTierIndex(a) - itemThumbnailTierIndex(b) || a.id - b.id);
  }
}

function loadManifest(): Promise<Set<number>> {
  if (_manifestPromise) return _manifestPromise;
  _manifestPromise = (async () => {
    try {
      const res = await fetch('/items/3d/manifest.json');
      if (!res.ok) return new Set<number>();
      const data = await res.json();
      const arr = Array.isArray(data) ? data : Array.isArray(data?.ids) ? data.ids : [];
      return new Set<number>(arr.filter((x: unknown) => typeof x === 'number'));
    } catch {
      return new Set<number>();
    }
  })();
  return _manifestPromise;
}

/** Per-item override: camera axes + optional model rotation. Loaded once from
 *  `/data/thumbnail-overrides.json`. Override merges over the slot default. */
export interface ThumbnailOverride extends ThumbnailCamera {
  rotationX?: number;
  rotationY?: number;
  rotationZ?: number;
  iconScale?: number;
}

export interface ThumbnailOverrideStore {
  items: Record<number, ThumbnailOverride>;
  families: Record<string, ThumbnailOverride>;
}

type ThumbnailOverrideInput = Record<number, ThumbnailOverride> | Partial<ThumbnailOverrideStore>;

/** Per-slot defaults — the average best framing for a slot. Tune here once
 *  rather than per-item where possible. Items override individually via
 *  `thumbnail-overrides.json` when the slot default doesn't fit. */
export const SLOT_THUMBNAIL_CAMERAS: Record<string, ThumbnailCamera> = {
  // Front-of-helmet view, slight downward tilt so the brim/face is visible.
  head:   { alpha: -Math.PI / 2 - Math.PI / 8, beta: Math.PI / 2 - 0.15, distanceMult: 0.85 },
  // 3/4 angle showing the blade, more zoom-out so long weapons aren't cropped.
  weapon: { alpha: -Math.PI / 4, beta: Math.PI / 2.4, distanceMult: 1.0 },
  // Shield face-on with a slight angle so the curvature reads.
  shield: { alpha: -Math.PI / 2 + Math.PI / 12, beta: Math.PI / 2, distanceMult: 0.85 },
  // Body/legs are skinned — best we can do without a skeleton is a side-front
  // tilt; the user can refine bad ones via the overrides JSON.
  body:   { alpha: -Math.PI / 4, beta: Math.PI / 2.3, distanceMult: 1.1 },
  legs:   { alpha: -Math.PI / 4, beta: Math.PI / 2.3, distanceMult: 1.1 },
  feet:   { alpha: -Math.PI / 4, beta: Math.PI / 2.2, distanceMult: 1.0 },
  hands:  { alpha: -Math.PI / 4, beta: Math.PI / 2.4, distanceMult: 0.9 },
  cape:   { alpha: -Math.PI / 4, beta: Math.PI / 2.4, distanceMult: 1.0 },
};

let _overridesPromise: Promise<ThumbnailOverrideStore> | null = null;

const SHIELD_THUMBNAIL_TINT: Record<number, [number, number, number]> = {
  // Square shields
  67: METAL_TIER_THUMBNAIL_COLOR.bronze,
  81: METAL_TIER_THUMBNAIL_COLOR.iron,
  95: METAL_TIER_THUMBNAIL_COLOR.steel,
  109: METAL_TIER_THUMBNAIL_COLOR.mithril,
  123: METAL_TIER_THUMBNAIL_COLOR.blackBronze,
  // Kite shields
  69: METAL_TIER_THUMBNAIL_COLOR.bronze,
  83: METAL_TIER_THUMBNAIL_COLOR.iron,
  97: METAL_TIER_THUMBNAIL_COLOR.steel,
  111: METAL_TIER_THUMBNAIL_COLOR.mithril,
  125: METAL_TIER_THUMBNAIL_COLOR.blackBronze,
};

const SHIELD_DOMINANT_BROWN: [number, number, number] = [0.119, 0.044, 0.007];

function loadOverrides(): Promise<ThumbnailOverrideStore> {
  if (_overridesPromise) return _overridesPromise;
  _overridesPromise = (async () => {
    try {
      const token = localStorage.getItem('projectrs_token') || '';
      const res = await fetch('/data/thumbnail-overrides.json', {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: 'same-origin',
      });
      if (!res.ok) return { items: {}, families: {} };
      const data = await res.json();
      if (!data || typeof data !== 'object') return { items: {}, families: {} };
      const items: Record<number, ThumbnailOverride> = {};
      for (const [k, v] of Object.entries(data)) {
        const id = Number(k);
        if (Number.isFinite(id) && v && typeof v === 'object') items[id] = v as ThumbnailOverride;
      }
      const families: Record<string, ThumbnailOverride> = {};
      const rawFamilies = (data as { _item_families?: unknown })._item_families;
      if (rawFamilies && typeof rawFamilies === 'object') {
        for (const [key, value] of Object.entries(rawFamilies)) {
          if (value && typeof value === 'object') families[key] = value as ThumbnailOverride;
        }
      }
      return { items, families };
    } catch {
      return { items: {}, families: {} };
    }
  })();
  return _overridesPromise;
}

export function invalidateThumbnailOverrides(): void {
  _overridesPromise = null;
}

function asOverrideStore(overrides: ThumbnailOverrideInput): ThumbnailOverrideStore {
  const maybeStore = overrides as Partial<ThumbnailOverrideStore>;
  if (maybeStore.items || maybeStore.families) {
    return {
      items: maybeStore.items ?? {},
      families: maybeStore.families ?? {},
    };
  }
  return { items: overrides as Record<number, ThumbnailOverride>, families: {} };
}

export function findThumbnailOverrideForItem(
  def: ItemDef,
  overrides: ThumbnailOverrideInput,
  itemDefs: readonly ItemDef[] = _itemCatalog,
): ThumbnailOverride | undefined {
  const store = asOverrideStore(overrides);
  const direct = store.items[def.id];
  if (!def.equipSlot) return direct;

  const familyKey = itemThumbnailFamilyKey(def);
  if (!familyKey) return direct;

  const familyOverride = store.families[familyKey];
  if (familyOverride) return familyOverride;
  if (itemDefs.length === 0) return direct;

  const targetTierIndex = itemThumbnailTierIndex(def);
  const indexed = itemDefs === _itemCatalog ? _itemFamilyIndex.get(familyKey) : undefined;
  const candidates = indexed ?? itemDefs.filter((item) =>
    itemThumbnailFamilyKey(item) === familyKey
  );

  const bronze = findBronzeFamilyItem(candidates);
  if (bronze && bronze.id !== def.id && store.items[bronze.id]) return store.items[bronze.id];
  if (direct) return direct;

  let best: ItemDef | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const item of candidates) {
    if (item.id === def.id || !store.items[item.id]) continue;
    const delta = Math.abs(itemThumbnailTierIndex(item) - targetTierIndex);
    if (!best || delta < bestDelta || (delta === bestDelta && item.id < best.id)) {
      best = item;
      bestDelta = delta;
    }
  }

  return best ? store.items[best.id] : undefined;
}

/** Build thumbnail options for a specific item and override. Used by both the
 *  game client and editor previews so saved editor poses match runtime icons. */
export function buildThumbnailOptionsFromOverride(def: ItemDef, itemOverride?: ThumbnailOverride): ThumbnailOptions {
  const opts: ThumbnailOptions = { cacheIdentity: `item:${def.id}` };
  const tint = TOOL_TIER_METAL_COLOR[def.id];
  if (tint) opts.tint = tint;
  const shieldTint = SHIELD_THUMBNAIL_TINT[def.id];
  if (shieldTint) {
    opts.tint = shieldTint;
    opts.tintBaseColorMatch = SHIELD_DOMINANT_BROWN;
  }
  const slotCam = def.equipSlot ? SLOT_THUMBNAIL_CAMERAS[def.equipSlot] : undefined;
  if (slotCam || itemOverride) {
    const { rotationX, rotationY, rotationZ, iconScale, ...itemCam } = itemOverride ?? {};
    opts.camera = { ...slotCam, ...itemCam };
    if (rotationX) opts.rotationX = rotationX;
    if (rotationY) opts.rotationY = rotationY;
    if (rotationZ) opts.rotationZ = rotationZ;
    if (typeof iconScale === 'number' && Number.isFinite(iconScale) && iconScale > 0) opts.iconScale = iconScale;
  }
  if (def.equipSlot === 'body' && def.bodyHideStyle !== 'chain') opts.skinnedPose = 'idle';
  return opts;
}

/** Build the camera + rotation options for an item. Merges slot default with
 *  per-item override. Exposed so the bake script can use the same settings. */
export async function buildThumbnailOptionsForItem(def: ItemDef): Promise<ThumbnailOptions> {
  const overrides = await loadOverrides();
  return buildThumbnailOptionsFromOverride(def, findThumbnailOverrideForItem(def, overrides));
}

/** Resolve the GLB path from an ItemDef. Mirrors `loadGearSmart`'s fallback
 *  chain (see GameManager `buildDef`) for items that actually have a known
 *  model. Items without a known model return null so they can still use
 *  legacy 2D art. */
export function resolveItemModelPath(def: ItemDef): string | null {
  return resolveEquipmentModelPath(def, 0);
}

function uses3DIcon(def: ItemDef): boolean {
  return resolveItemModelPath(def) !== null;
}

/** Best-effort async lookup. Returns the highest-quality icon URL available. */
export async function getItemIconUrl(def: ItemDef): Promise<string | null> {
  const manifest = await loadManifest();
  if (manifest.has(def.id)) return `/items/3d/${def.id}.png`;

  const modelPath = resolveItemModelPath(def);
  if (modelPath) {
    const opts = await buildThumbnailOptionsForItem(def);
    const dataUrl = await getThumbnail(modelPath, opts);
    if (dataUrl) return dataUrl;
    return null;
  }

  if (def.sprite) return `/sprites/items/${def.sprite}`;
  if (def.icon) return `/items/${def.icon}`;
  return null;
}

/** Synchronous URL — never triggers a render. Used as the immediate placeholder
 *  while `getItemIconUrl` resolves. Returns null for modeled items so legacy
 *  2D art never flashes before the 3D thumbnail lands. */
export function getItemIconSyncUrl(def: ItemDef): string | null {
  if (uses3DIcon(def)) return null;
  if (def.sprite) return `/sprites/items/${def.sprite}`;
  if (def.icon) return `/items/${def.icon}`;
  return null;
}

export interface IconStyleOpts {
  size?: number;
  pixelated?: boolean;
  draggable?: boolean;
  extraStyle?: string;
}

/** 3D thumbnails are smooth-shaded continuous renders — pixelated scaling
 *  produces ugly aliasing when the 128×128 image downscales to a ~34 px slot.
 *  Legacy 2D icons are authored as low-res pixel art so they still want
 *  pixelated. Detect by URL shape: data: URLs and `/items/3d/` are smooth,
 *  everything else (sprite atlases, RS-classic icons) is pixelated. */
function isSmoothUrl(url: string): boolean {
  return url.startsWith('data:') || url.startsWith('/items/3d/');
}

function buildImgStyle(opts: IconStyleOpts, smooth?: boolean): string {
  const size = opts.size ?? 28;
  const wantPixelated = opts.pixelated ?? true;
  const effectivePixelated = smooth ? false : wantPixelated;
  return `width:${size}px;height:${size}px;${effectivePixelated ? 'image-rendering:pixelated;' : ''}object-fit:contain;${opts.extraStyle ?? ''}`;
}

function buildPlaceholderHtml(size: number): string {
  const s = Math.round(size * 0.85);
  return `<div style="width:${s}px;height:${s}px;background:#aaa;border-radius:3px;"></div>`;
}

// Monotonic — used to ignore stale async upgrades when a slot is re-rendered.
let _iconTokenSeq = 0;

/**
 * Synchronous HTML for the icon. Wraps the immediate URL or placeholder in a
 * `<span class="item-icon" data-item-id data-icon-token>`. The token lets
 * `upgradeItemIcons` ignore stale fetches when the slot has been re-rendered.
 */
export function buildItemIconHtml(def: ItemDef, opts: IconStyleOpts = {}): string {
  const dragAttr = opts.draggable === false ? ' draggable="false"' : '';
  const syncUrl = getItemIconSyncUrl(def);
  const inner = syncUrl
    ? `<img src="${syncUrl}"${dragAttr} style="${buildImgStyle(opts, isSmoothUrl(syncUrl))}" />`
    : buildPlaceholderHtml(opts.size ?? 28);
  const token = `${def.id}-${++_iconTokenSeq}`;
  return `<span class="item-icon" data-item-id="${def.id}" data-icon-token="${token}">${inner}</span>`;
}

/**
 * Walk `root` for `.item-icon` wrappers, fetch the best icon URL for each,
 * and swap the inner `<img>` src. Skips wrappers whose `data-icon-token`
 * changed mid-fetch (slot got re-rendered with a different item).
 */
export function upgradeItemIcons(
  root: ParentNode,
  defs: Map<number, ItemDef>,
  opts: IconStyleOpts = {},
): void {
  const wrappers = root.querySelectorAll<HTMLElement>('.item-icon[data-item-id]');
  for (const wrapper of wrappers) {
    const itemId = Number(wrapper.dataset.itemId);
    const token = wrapper.dataset.iconToken;
    const def = defs.get(itemId);
    if (!def || !token) continue;

    getItemIconUrl(def).then((url) => {
      if (!url) return;
      if (wrapper.dataset.iconToken !== token) return;
      const existing = wrapper.querySelector('img');
      if (existing && existing.getAttribute('src') === url) return;
      const dragAttr = opts.draggable === false ? ' draggable="false"' : '';
      wrapper.innerHTML = `<img src="${url}"${dragAttr} style="${buildImgStyle(opts, isSmoothUrl(url))}" />`;
    });
  }
}

/**
 * One-call helper for the common slot-render pattern: writes the icon HTML
 * to `el` (with optional quantity badge), then kicks off the async upgrade.
 * Pass `quantity > 1` to render the OSRS-style top-left count.
 */
export interface RenderSlotOpts extends IconStyleOpts {
  /** Quantity badge — shown when > 1. */
  quantity?: number;
  /** Override the placeholder square size (defaults to ~85% of `size`). */
  placeholderSize?: number;
  /** Override the placeholder div's inline style (defaults to a neutral grey square). */
  placeholderStyle?: string;
  /** Override the quantity badge's inline style. */
  badgeStyle?: string;
}

const DEFAULT_BADGE_STYLE =
  'position:absolute;top:1px;left:3px;font-size:9px;font-weight:bold;color:#d8372b;text-shadow:1px 1px 0 #000;';

export function renderItemSlot(
  el: HTMLElement,
  def: ItemDef | null | undefined,
  defs: Map<number, ItemDef>,
  opts: RenderSlotOpts = {},
): void {
  if (!def) {
    const ps = opts.placeholderSize ?? Math.round((opts.size ?? 28) * 0.85);
    const phStyle = opts.placeholderStyle ?? `width:${ps}px;height:${ps}px;background:#555;border-radius:3px;`;
    el.innerHTML = `<div style="${phStyle}"></div>`;
    return;
  }
  const iconHtml = buildItemIconHtml(def, opts);
  const qtyHtml = (opts.quantity ?? 1) > 1
    ? `<div style="${opts.badgeStyle ?? DEFAULT_BADGE_STYLE}">${opts.quantity}</div>`
    : '';
  el.innerHTML = `${iconHtml}${qtyHtml}`;
  upgradeItemIcons(el, defs, opts);
}
