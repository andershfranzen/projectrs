import type { ItemDef } from '@projectrs/shared'
import {
  getThumbnail as getRuntimeThumbnail,
  getThumbnailPoseKey as getRuntimeThumbnailPoseKey,
  renderThumbnailPreview as renderRuntimeThumbnailPreview,
} from '@client/rendering/ThumbnailRenderer'
import {
  buildThumbnailOptionsFromOverride,
  invalidateThumbnailOverrides,
  itemThumbnailFamilyKey,
  itemThumbnailTier,
  itemThumbnailTierIndex,
  parseBakedThumbnailManifest,
  resolveBakedThumbnailUrl,
  type ParsedBakedThumbnailManifest,
} from '@client/rendering/ItemIcon'
import { getItemOverride, invalidateOverridesCache, type AssetThumbnailOverride } from './ThumbnailRenderer'
import { openThumbnailPoseEditor } from './ThumbnailRotationEditor'

export interface ItemThumbnailBrowserOptions {
  loadItems: () => Promise<ItemDef[]>
  resolveModelPath: (def: ItemDef) => string | null
}

let itemThumbManifestPromise: Promise<ParsedBakedThumbnailManifest> | null = null

interface ItemThumbnailOverrideStore {
  items: Record<string, AssetThumbnailOverride>
  families: Record<string, AssetThumbnailOverride>
}

const POSE_FIELDS = ['alpha', 'beta', 'distanceMult', 'rotationX', 'rotationY', 'rotationZ', 'iconScale'] as const

function normalizeOverride(value: unknown): AssetThumbnailOverride | null {
  if (!value || typeof value !== 'object') return null
  const source = value as AssetThumbnailOverride
  const out: AssetThumbnailOverride = {}
  if (typeof source.alpha === 'number' && Number.isFinite(source.alpha)) out.alpha = source.alpha
  if (typeof source.beta === 'number' && Number.isFinite(source.beta)) out.beta = source.beta
  if (typeof source.distanceMult === 'number' && Number.isFinite(source.distanceMult) && source.distanceMult > 0) out.distanceMult = source.distanceMult
  if (typeof source.rotationX === 'number' && Number.isFinite(source.rotationX)) out.rotationX = source.rotationX
  if (typeof source.rotationY === 'number' && Number.isFinite(source.rotationY)) out.rotationY = source.rotationY
  if (typeof source.rotationZ === 'number' && Number.isFinite(source.rotationZ)) out.rotationZ = source.rotationZ
  if (typeof source.iconScale === 'number' && Number.isFinite(source.iconScale) && source.iconScale > 0) out.iconScale = source.iconScale
  return Object.keys(out).length ? out : null
}

async function loadItemThumbnailOverrides(): Promise<ItemThumbnailOverrideStore> {
  try {
    const res = await fetch('/data/thumbnail-overrides.json', { cache: 'no-store' })
    if (!res.ok) return { items: {}, families: {} }
    const data = await res.json()
    if (!data || typeof data !== 'object') return { items: {}, families: {} }
    const items: Record<string, AssetThumbnailOverride> = {}
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('_')) continue
      const ov = normalizeOverride(value)
      if (ov) items[key] = ov
    }
    const families: Record<string, AssetThumbnailOverride> = {}
    const rawFamilies = (data as { _item_families?: unknown })._item_families
    if (rawFamilies && typeof rawFamilies === 'object') {
      for (const [key, value] of Object.entries(rawFamilies)) {
        const ov = normalizeOverride(value)
        if (ov) families[key] = ov
      }
    }
    return { items, families }
  } catch {
    return { items: {}, families: {} }
  }
}

function buildOverrideMap(overrides: Record<string, AssetThumbnailOverride>): Record<number, AssetThumbnailOverride> {
  const out: Record<number, AssetThumbnailOverride> = {}
  for (const [key, value] of Object.entries(overrides)) {
    const itemId = Number(key)
    if (Number.isFinite(itemId)) out[itemId] = value
  }
  return out
}

function posesMatch(a: AssetThumbnailOverride | null | undefined, b: AssetThumbnailOverride | null | undefined): boolean {
  const left = normalizeOverride(a)
  const right = normalizeOverride(b)
  if (!left || !right) return left === right
  for (const key of POSE_FIELDS) {
    const av = left[key]
    const bv = right[key]
    if (av === undefined && bv === undefined) continue
    if (typeof av !== 'number' || typeof bv !== 'number') return false
    if (Math.abs(av - bv) > 1e-9) return false
  }
  return true
}

function loadItemThumbManifest(): Promise<ParsedBakedThumbnailManifest> {
  if (itemThumbManifestPromise) return itemThumbManifestPromise
  itemThumbManifestPromise = (async () => {
    try {
      const res = await fetch('/items/3d/manifest.json', { cache: 'no-store' })
      if (!res.ok) return parseBakedThumbnailManifest(null)
      const data = await res.json()
      return parseBakedThumbnailManifest(data)
    } catch {
      return parseBakedThumbnailManifest(null)
    }
  })()
  return itemThumbManifestPromise
}

function manifestHasItem(manifest: ParsedBakedThumbnailManifest, itemId: number): boolean {
  return manifest.entries.has(itemId) || manifest.legacyIds.has(itemId)
}

function getBakedRuntimeThumb(
  manifest: ParsedBakedThumbnailManifest,
  def: ItemDef,
  modelPath: string,
  override: AssetThumbnailOverride,
): string | null {
  const opts = buildThumbnailOptionsFromOverride(def, override)
  return resolveBakedThumbnailUrl(manifest, def.id, getRuntimeThumbnailPoseKey(modelPath, opts))
}

async function renderRuntimeItemThumb(
  manifest: ParsedBakedThumbnailManifest,
  def: ItemDef,
  modelPath: string,
  override: AssetThumbnailOverride,
): Promise<string | null> {
  const opts = buildThumbnailOptionsFromOverride(def, override)
  return getBakedRuntimeThumb(manifest, def, modelPath, override) ?? await getRuntimeThumbnail(modelPath, opts)
}

function runtimePoseKey(def: ItemDef, modelPath: string, override: AssetThumbnailOverride): string {
  return getRuntimeThumbnailPoseKey(modelPath, buildThumbnailOptionsFromOverride(def, override))
}

export async function openItemThumbnailBrowser(options: ItemThumbnailBrowserOptions): Promise<void> {
  const itemDefs = await options.loadItems()
  const manifest = await loadItemThumbManifest()
  let thumbnailOverrides = await loadItemThumbnailOverrides()
  const items = itemDefs
    .map((def) => ({ def, modelPath: options.resolveModelPath(def) }))
    .filter((entry): entry is { def: ItemDef; modelPath: string } => !!entry.modelPath)
  const itemById = new Map(items.map((entry) => [entry.def.id, entry]))
  const itemsBySlot = new Map<string, typeof items>()
  const itemsByFamilyKey = new Map<string, typeof items>()
  for (const entry of items) {
    if (entry.def.equipSlot) {
      const bySlot = itemsBySlot.get(entry.def.equipSlot)
      if (bySlot) bySlot.push(entry)
      else itemsBySlot.set(entry.def.equipSlot, [entry])
    }
    const familyKey = itemThumbnailFamilyKey(entry.def)
    if (familyKey && itemThumbnailTier(entry.def)) {
      const byFamily = itemsByFamilyKey.get(familyKey)
      if (byFamily) byFamily.push(entry)
      else itemsByFamilyKey.set(familyKey, [entry])
    }
  }
  const itemDefsForInheritance = items.map((entry) => entry.def)
  let numericOverrides = buildOverrideMap(thumbnailOverrides.items)
  let indexedPoseLookup = buildPoseLookup()

  function buildPoseLookup(): Map<string, ItemDef[]> {
    const out = new Map<string, ItemDef[]>()
    for (const def of itemDefsForInheritance) {
      if (!numericOverrides[def.id]) continue
      const key = itemThumbnailFamilyKey(def)
      if (!key) continue
      const arr = out.get(key)
      if (arr) arr.push(def)
      else out.set(key, [def])
    }
    for (const arr of out.values()) {
      arr.sort((a, b) => itemThumbnailTierIndex(a) - itemThumbnailTierIndex(b) || a.id - b.id)
    }
    return out
  }

  function rebuildOverrideIndexes(): void {
    numericOverrides = buildOverrideMap(thumbnailOverrides.items)
    indexedPoseLookup = buildPoseLookup()
  }

  const getEffectivePose = (def: ItemDef): AssetThumbnailOverride => {
    const direct = numericOverrides[def.id]
    const familyKey = itemThumbnailFamilyKey(def)
    if (direct) return direct
    if (familyKey && thumbnailOverrides.families[familyKey]) return thumbnailOverrides.families[familyKey]
    if (!familyKey) return {}
    const candidates = indexedPoseLookup.get(familyKey) ?? []
    if (!candidates.length) return {}
    const bronze = candidates.find((candidate) => itemThumbnailTier(candidate) === 'Bronze')
    if (bronze && bronze.id !== def.id) return numericOverrides[bronze.id] ?? {}
    const targetTier = itemThumbnailTierIndex(def)
    let best = candidates[0]
    let bestDelta = Math.abs(itemThumbnailTierIndex(best) - targetTier)
    for (let i = 1; i < candidates.length; i++) {
      const candidate = candidates[i]
      const delta = Math.abs(itemThumbnailTierIndex(candidate) - targetTier)
      if (delta < bestDelta || (delta === bestDelta && candidate.id < best.id)) {
        best = candidate
        bestDelta = delta
      }
    }
    return numericOverrides[best.id] ?? {}
  }

  const backdrop = document.createElement('div')
  backdrop.className = 'item-thumb-modal'
  const panel = document.createElement('div')
  panel.className = 'item-thumb-modal-inner'
  backdrop.appendChild(panel)

  const head = document.createElement('div')
  head.className = 'item-thumb-modal-head'
  const title = document.createElement('div')
  title.textContent = 'Inventory Thumbnails'
  title.className = 'item-thumb-modal-title'
  const closeBtn = document.createElement('button')
  closeBtn.textContent = 'Close'
  closeBtn.className = 'asset-rotate-modal-btn secondary'
  head.appendChild(title)
  head.appendChild(closeBtn)
  panel.appendChild(head)

  const search = document.createElement('input')
  search.type = 'text'
  search.placeholder = 'Search item name, ID, or slot'
  search.className = 'item-thumb-search'
  panel.appendChild(search)

  const copyStatus = document.createElement('div')
  copyStatus.className = 'item-thumb-copy-status'
  panel.appendChild(copyStatus)

  const grid = document.createElement('div')
  grid.className = 'item-thumb-grid'
  panel.appendChild(grid)

  document.body.appendChild(backdrop)

  let observer: IntersectionObserver | null = null
  let closed = false
  let sourceItemId: number | null = null
  let renderListTimer: number | null = null
  const renderedImages = new Map<number, HTMLImageElement>()
  const close = (): void => {
    if (closed) return
    closed = true
    if (renderListTimer !== null) window.clearTimeout(renderListTimer)
    if (observer) observer.disconnect()
    document.removeEventListener('keydown', onKeyDown)
    try { document.body.removeChild(backdrop) } catch { /* ignore */ }
  }
  const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKeyDown)
  closeBtn.addEventListener('click', close)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })

  const getDirectItemPose = (def: ItemDef): AssetThumbnailOverride | null => {
    return normalizeOverride(thumbnailOverrides.items[String(def.id)])
  }

  const getSavedPose = (def: ItemDef): AssetThumbnailOverride | null => {
    const directPose = getDirectItemPose(def)
    if (directPose) return directPose
    const familyKey = itemThumbnailFamilyKey(def)
    if (familyKey) {
      const familyPose = normalizeOverride(thumbnailOverrides.families[familyKey])
      if (familyPose) return familyPose
    }
    return null
  }

  const refreshDirectItemPoseFromServer = async (def: ItemDef): Promise<AssetThumbnailOverride | null> => {
    invalidateOverridesCache()
    const saved = await getItemOverride(def.id)
    const normalized = normalizeOverride(saved)
    if (normalized) thumbnailOverrides.items[String(def.id)] = normalized
    else delete thumbnailOverrides.items[String(def.id)]
    rebuildOverrideIndexes()
    return normalized
  }

  const setCopyStatus = (message?: string): void => {
    if (message) {
      copyStatus.textContent = message
      return
    }
    const source = sourceItemId ? itemById.get(sourceItemId)?.def : null
    copyStatus.textContent = source
      ? `Thumbnail pose source: ${source.name} (#${source.id})`
      : 'Thumbnail pose source: none'
  }

  const sameTierFamilyTargets = (source: ItemDef): typeof items => {
    const familyKey = itemThumbnailFamilyKey(source)
    if (!itemThumbnailTier(source)) return []
    return familyKey ? (itemsByFamilyKey.get(familyKey) ?? []).filter((entry) => entry.def.id !== source.id) : []
  }

  const sameSlotTargets = (source: ItemDef): typeof items => {
    return source.equipSlot ? (itemsBySlot.get(source.equipSlot) ?? []).filter((entry) => entry.def.id !== source.id) : []
  }

  const buildPoseEntryForTarget = (
    target: ItemDef,
    pose: AssetThumbnailOverride,
    targetType: 'item' | 'item-family',
  ): Record<string, unknown> => {
    const familyKey = itemThumbnailFamilyKey(target)
    const saveAsFamily = targetType === 'item-family' && !!familyKey
    return {
      type: saveAsFamily ? 'item-family' : 'item',
      key: saveAsFamily ? familyKey : target.id,
      alpha: pose.alpha,
      beta: pose.beta,
      distanceMult: pose.distanceMult,
      rotationX: pose.rotationX,
      rotationY: pose.rotationY,
      rotationZ: pose.rotationZ,
      iconScale: pose.iconScale,
    }
  }

  const saveItemThumbnailPoseBatch = async (
    targets: typeof items,
    pose: AssetThumbnailOverride,
    targetType: 'item' | 'item-family',
  ): Promise<number> => {
    const entriesByKey = new Map<string, Record<string, unknown>>()
    for (const target of targets) {
      const entry = buildPoseEntryForTarget(target.def, pose, targetType)
      entriesByKey.set(`${entry.type}:${entry.key}`, entry)
    }
    const res = await fetch('/api/dev/thumbnail-overrides/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries: Array.from(entriesByKey.values()),
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
    const body = await res.json().catch(() => ({})) as { saved?: unknown }
    const expected = entriesByKey.size
    if (typeof body.saved === 'number' && body.saved !== expected) {
      throw new Error(`Server saved ${body.saved} of ${expected} thumbnail pose(s)`)
    }
    return expected
  }

  const reloadAndVerifyBatch = async (
    targets: typeof items,
    pose: AssetThumbnailOverride,
    targetType: 'item' | 'item-family',
  ): Promise<string[]> => {
    invalidateOverridesCache()
    thumbnailOverrides = await loadItemThumbnailOverrides()
    rebuildOverrideIndexes()
    const missing: string[] = []
    for (const target of targets) {
      if (targetType === 'item-family') {
        const familyKey = itemThumbnailFamilyKey(target.def)
        const saved = familyKey ? thumbnailOverrides.families[familyKey] : null
        if (!posesMatch(saved, pose)) missing.push(target.def.name || `#${target.def.id}`)
      } else {
        const saved = thumbnailOverrides.items[String(target.def.id)]
        if (!posesMatch(saved, pose)) missing.push(target.def.name || `#${target.def.id}`)
      }
    }
    return missing
  }

  const copyPoseTo = async (
    source: ItemDef,
    targets: typeof items,
    label: string,
    targetType: 'item' | 'item-family' = 'item',
    sourceMode: 'direct-item' | 'saved' = 'direct-item',
  ): Promise<void> => {
    setCopyStatus(`Reading saved thumbnail pose for ${source.name}...`)
    const pose = sourceMode === 'direct-item'
      ? await refreshDirectItemPoseFromServer(source)
      : getSavedPose(source)
    if (!pose) {
      setCopyStatus(`No direct item pose saved for ${source.name}. Open Edit Item, save once, then copy again.`)
      return
    }
    if (!targets.length) {
      setCopyStatus(`No ${label} targets for ${source.name}.`)
      return
    }
    if (!confirm(`Copy ${source.name}'s saved thumbnail pose to ${targets.length} ${label} item(s)?`)) return

    try {
      setCopyStatus(`Saving thumbnail pose to ${targets.length} item(s)...`)
      const saved = await saveItemThumbnailPoseBatch(targets, pose, targetType)
      const missing = await reloadAndVerifyBatch(targets, pose, targetType)
      if (missing.length) {
        throw new Error(`Server did not persist ${missing.length} target(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '...' : ''}`)
      }
      invalidateOverridesCache()
      invalidateThumbnailOverrides()
      if (closed) return
      renderList()
      setCopyStatus(`Copied and verified thumbnail pose on ${saved} item(s).`)
      setTimeout(() => setCopyStatus(), 2500)
    } catch (err) {
      setCopyStatus(`Copy failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const renderList = (): void => {
    if (closed) return
    const q = search.value.trim().toLowerCase()
    const filtered = items.filter(({ def, modelPath }) => {
      if (!q) return true
      return [
        String(def.id),
        def.name,
        def.equipSlot || '',
        modelPath,
      ].join(' ').toLowerCase().includes(q)
    })

    grid.innerHTML = ''
    renderedImages.clear()
    setCopyStatus()
    if (observer) observer.disconnect()
    observer = new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        obs.unobserve(entry.target)
        const img = entry.target as HTMLImageElement
        const id = Number(img.dataset.itemId)
        const match = itemById.get(id)
        if (!match) continue
        const pose = getEffectivePose(match.def)
        const poseKey = runtimePoseKey(match.def, match.modelPath, pose)
        img.dataset.poseKey = poseKey
        renderRuntimeItemThumb(manifest, match.def, match.modelPath, pose)
          .then((url) => {
            if (url && !closed && img.isConnected && img.dataset.itemId === String(id) && img.dataset.poseKey === poseKey) img.src = url
          })
          .catch(() => {})
      }
    }, { root: grid, rootMargin: '100px', threshold: 0.01 })

    if (!filtered.length) {
      grid.innerHTML = '<div class="asset-grid-empty">No 3D item thumbnails found</div>'
      return
    }

    const fragment = document.createDocumentFragment()
    const imagesToObserve: HTMLImageElement[] = []
    for (const { def, modelPath } of filtered) {
      const card = document.createElement('div')
      card.className = 'item-thumb-card'

      const img = document.createElement('img')
      img.className = 'item-thumb-img'
      img.alt = def.name
      img.dataset.itemId = String(def.id)
      const effectivePose = getEffectivePose(def)
      img.dataset.poseKey = runtimePoseKey(def, modelPath, effectivePose)
      const bakedUrl = getBakedRuntimeThumb(manifest, def, modelPath, effectivePose)
      if (bakedUrl) img.src = bakedUrl

      const meta = document.createElement('div')
      meta.className = 'item-thumb-meta'
      const name = document.createElement('div')
      name.className = 'item-thumb-name'
      name.textContent = def.name || `Item ${def.id}`
      const detail = document.createElement('div')
      detail.className = 'item-thumb-detail'
      const familyKey = itemThumbnailFamilyKey(def)
      const familySaved = familyKey ? !!thumbnailOverrides.families[familyKey] : false
      const itemSaved = !!thumbnailOverrides.items[String(def.id)]
      detail.textContent = `#${def.id}${def.equipSlot ? ` · ${def.equipSlot}` : ''}${itemSaved ? ' · item pose' : familySaved ? ' · family pose' : ''}${manifestHasItem(manifest, def.id) ? ' · baked' : ''}`
      meta.appendChild(name)
      meta.appendChild(detail)

      const editBtn = document.createElement('button')
      editBtn.className = 'asset-rotate-modal-btn'
      editBtn.textContent = 'Edit Item'
      editBtn.addEventListener('click', () => {
        openThumbnailPoseEditor({
          targetType: 'item',
          key: def.id,
          modelPath,
          title: `${def.name || 'Item'} (#${def.id})`,
          subtitle: modelPath,
          bakedWarning: manifestHasItem(manifest, def.id)
            ? 'This item has a baked PNG. If its manifest pose is stale, players see the runtime thumbnail until you rebake.'
            : undefined,
          initialOverride: getEffectivePose(def),
          renderOutputPreview: async (entry) => {
            const opts = buildThumbnailOptionsFromOverride(def, entry)
            return renderRuntimeThumbnailPreview(modelPath, opts)
          },
          onSaved: async () => {
            const saved = await getItemOverride(def.id)
            const normalized = normalizeOverride(saved)
            if (normalized) {
              thumbnailOverrides.items[String(def.id)] = normalized
            } else {
              delete thumbnailOverrides.items[String(def.id)]
            }
            invalidateThumbnailOverrides()
            rebuildOverrideIndexes()
            sourceItemId = def.id
            renderList()
          },
        })
      })

      const directPose = getDirectItemPose(def)
      const sourceBtn = document.createElement('button')
      sourceBtn.className = 'asset-rotate-modal-btn secondary'
      sourceBtn.textContent = 'Source'
      sourceBtn.disabled = !directPose
      sourceBtn.title = directPose ? 'Use this direct item pose as the copy source' : 'Save this item pose first'
      sourceBtn.addEventListener('click', () => {
        sourceItemId = def.id
        renderList()
      })

      const familyTargets = sameTierFamilyTargets(def)
      const slotTargets = sameSlotTargets(def)
      const applyBtn = document.createElement('button')
      applyBtn.className = 'asset-rotate-modal-btn secondary'
      applyBtn.textContent = 'Apply'
      applyBtn.disabled = !sourceItemId || sourceItemId === def.id
      applyBtn.title = 'Apply the selected source pose to this item'
      applyBtn.addEventListener('click', () => {
        const source = sourceItemId ? itemById.get(sourceItemId)?.def : null
        if (source) copyPoseTo(source, [{ def, modelPath }], 'selected', 'item')
      })

      const familyBtn = document.createElement('button')
      familyBtn.className = 'asset-rotate-modal-btn secondary'
      familyBtn.textContent = 'Tiers'
      familyBtn.disabled = !directPose || !def.equipSlot || familyTargets.length === 0
      familyBtn.title = 'Copy this direct item pose to every other item tier in the same family and slot'
      familyBtn.addEventListener('click', () => copyPoseTo(def, familyTargets, 'same-family tier', 'item', 'direct-item'))

      const slotBtn = document.createElement('button')
      slotBtn.className = 'asset-rotate-modal-btn secondary'
      slotBtn.textContent = 'Slot'
      slotBtn.disabled = !directPose || !def.equipSlot || slotTargets.length === 0
      slotBtn.title = 'Copy this direct item pose to every modeled item in this equipment slot'
      slotBtn.addEventListener('click', () => copyPoseTo(def, slotTargets, 'same-slot', 'item', 'direct-item'))

      const actions = document.createElement('div')
      actions.className = 'item-thumb-actions'
      actions.appendChild(editBtn)
      actions.appendChild(sourceBtn)
      actions.appendChild(applyBtn)
      actions.appendChild(familyBtn)
      actions.appendChild(slotBtn)

      card.appendChild(img)
      card.appendChild(meta)
      card.appendChild(actions)
      fragment.appendChild(card)
      renderedImages.set(def.id, img)
      if (!bakedUrl) imagesToObserve.push(img)
    }
    grid.appendChild(fragment)
    for (const img of imagesToObserve) observer.observe(img)
  }

  const scheduleRenderList = (): void => {
    if (renderListTimer !== null) window.clearTimeout(renderListTimer)
    renderListTimer = window.setTimeout(() => {
      renderListTimer = null
      renderList()
    }, 100)
  }

  search.addEventListener('input', scheduleRenderList)
  renderList()
  search.focus()
}
