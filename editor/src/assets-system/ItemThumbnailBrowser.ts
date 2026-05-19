import type { ItemDef } from '@projectrs/shared'
import {
  getThumbnail as getRuntimeThumbnail,
  invalidateThumbnail as invalidateRuntimeThumbnail,
  renderThumbnailPreview as renderRuntimeThumbnailPreview,
} from '@client/rendering/ThumbnailRenderer'
import {
  buildThumbnailOptionsFromOverride,
  invalidateThumbnailOverrides,
  itemThumbnailFamily,
  itemThumbnailTierIndex,
} from '@client/rendering/ItemIcon'
import { getItemOverride, invalidateOverridesCache, type AssetThumbnailOverride } from './ThumbnailRenderer'
import { openThumbnailPoseEditor } from './ThumbnailRotationEditor'

export interface ItemThumbnailBrowserOptions {
  loadItems: () => Promise<ItemDef[]>
  resolveModelPath: (def: ItemDef) => string | null
}

let itemThumbManifestPromise: Promise<Set<number>> | null = null

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

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

async function loadItemThumbnailOverrides(): Promise<Record<string, AssetThumbnailOverride>> {
  try {
    const res = await fetch('/data/thumbnail-overrides.json', { cache: 'no-store' })
    if (!res.ok) return {}
    const data = await res.json()
    if (!data || typeof data !== 'object') return {}
    const out: Record<string, AssetThumbnailOverride> = {}
    for (const [key, value] of Object.entries(data)) {
      if (key === '_thumbnail_assets') continue
      const ov = normalizeOverride(value)
      if (ov) out[key] = ov
    }
    return out
  } catch {
    return {}
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

function loadItemThumbManifest(): Promise<Set<number>> {
  if (itemThumbManifestPromise) return itemThumbManifestPromise
  itemThumbManifestPromise = (async () => {
    try {
      const res = await fetch('/items/3d/manifest.json')
      if (!res.ok) return new Set<number>()
      const data = await res.json()
      const ids = Array.isArray(data) ? data : Array.isArray(data?.ids) ? data.ids : []
      return new Set(ids.filter((id: unknown) => typeof id === 'number'))
    } catch {
      return new Set<number>()
    }
  })()
  return itemThumbManifestPromise
}

async function renderRuntimeItemThumb(def: ItemDef, modelPath: string, override: AssetThumbnailOverride): Promise<string | null> {
  return getRuntimeThumbnail(modelPath, buildThumbnailOptionsFromOverride(def, override))
}

async function refreshRuntimeItemThumb(def: ItemDef, modelPath: string, override: AssetThumbnailOverride): Promise<string | null> {
  const opts = buildThumbnailOptionsFromOverride(def, override)
  await invalidateRuntimeThumbnail(modelPath, opts)
  return getRuntimeThumbnail(modelPath, opts)
}

export async function openItemThumbnailBrowser(options: ItemThumbnailBrowserOptions): Promise<void> {
  const itemDefs = await options.loadItems()
  const manifest = await loadItemThumbManifest()
  let thumbnailOverrides = await loadItemThumbnailOverrides()
  const items = itemDefs
    .map((def) => ({ def, modelPath: options.resolveModelPath(def) }))
    .filter((entry): entry is { def: ItemDef; modelPath: string } => !!entry.modelPath)
  const itemById = new Map(items.map((entry) => [entry.def.id, entry]))
  const itemDefsForInheritance = items.map((entry) => entry.def)
  let numericOverrides = buildOverrideMap(thumbnailOverrides)
  let indexedPoseLookup = buildPoseLookup()

  function buildPoseLookup(): Map<string, ItemDef[]> {
    const out = new Map<string, ItemDef[]>()
    for (const def of itemDefsForInheritance) {
      if (!def.equipSlot || !numericOverrides[def.id]) continue
      const family = itemThumbnailFamily(def)
      if (!family) continue
      const key = `${def.equipSlot}\0${family}`
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
    numericOverrides = buildOverrideMap(thumbnailOverrides)
    indexedPoseLookup = buildPoseLookup()
  }

  const getEffectivePose = (def: ItemDef): AssetThumbnailOverride => {
    const direct = numericOverrides[def.id]
    if (direct) return direct
    if (!def.equipSlot) return {}
    const family = itemThumbnailFamily(def)
    if (!family) return {}
    const candidates = indexedPoseLookup.get(`${def.equipSlot}\0${family}`) ?? []
    if (!candidates.length) return {}
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
  const renderedImages = new Map<number, HTMLImageElement>()
  const close = (): void => {
    if (closed) return
    closed = true
    if (observer) observer.disconnect()
    document.removeEventListener('keydown', onKeyDown)
    try { document.body.removeChild(backdrop) } catch { /* ignore */ }
  }
  const onKeyDown = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKeyDown)
  closeBtn.addEventListener('click', close)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })

  const getSavedPose = (itemId: number): AssetThumbnailOverride | null => {
    return normalizeOverride(thumbnailOverrides[String(itemId)])
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

  const sameFamilyTargets = (source: ItemDef): typeof items => {
    const family = itemThumbnailFamily(source)
    return items.filter((entry) =>
      entry.def.id !== source.id &&
      entry.def.equipSlot === source.equipSlot &&
      itemThumbnailFamily(entry.def) === family
    )
  }

  const sameSlotTargets = (source: ItemDef): typeof items => {
    return items.filter((entry) =>
      entry.def.id !== source.id &&
      !!source.equipSlot &&
      entry.def.equipSlot === source.equipSlot
    )
  }

  const saveItemThumbnailPoseBatch = async (targets: typeof items, pose: AssetThumbnailOverride): Promise<void> => {
    const res = await fetch('/api/dev/thumbnail-overrides/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries: targets.map((target) => ({
          key: target.def.id,
          alpha: pose.alpha,
          beta: pose.beta,
          distanceMult: pose.distanceMult,
          rotationX: pose.rotationX,
          rotationY: pose.rotationY,
          rotationZ: pose.rotationZ,
          iconScale: pose.iconScale,
        })),
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `HTTP ${res.status}`)
    }
  }

  const refreshVisibleThumb = async (def: ItemDef): Promise<void> => {
    const entry = itemById.get(def.id)
    const img = renderedImages.get(def.id)
    if (!entry || !img || img.dataset.itemId !== String(def.id)) return
    const url = await refreshRuntimeItemThumb(def, entry.modelPath, getEffectivePose(def))
    if (url && !closed && img.dataset.itemId === String(def.id)) img.src = url
  }

  const copyPoseTo = async (source: ItemDef, targets: typeof items, label: string): Promise<void> => {
    const pose = getSavedPose(source.id)
    if (!pose) {
      setCopyStatus(`Save a thumbnail pose for ${source.name} first.`)
      return
    }
    if (!targets.length) {
      setCopyStatus(`No ${label} targets for ${source.name}.`)
      return
    }
    if (!confirm(`Copy ${source.name}'s saved thumbnail pose to ${targets.length} ${label} item(s)?`)) return

    try {
      setCopyStatus(`Saving thumbnail pose to ${targets.length} item(s)...`)
      await saveItemThumbnailPoseBatch(targets, pose)
      for (const target of targets) thumbnailOverrides[String(target.def.id)] = clone(pose)
      invalidateOverridesCache()
      invalidateThumbnailOverrides()
      rebuildOverrideIndexes()
      await Promise.all(targets.map((target) => refreshVisibleThumb(target.def)))
      renderList()
      setCopyStatus(`Copied thumbnail pose to ${targets.length} item(s).`)
      setTimeout(() => setCopyStatus(), 2500)
    } catch (err) {
      setCopyStatus(`Copy failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const renderList = (): void => {
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
        const match = items.find((item) => item.def.id === id)
        if (!match) continue
        renderRuntimeItemThumb(match.def, match.modelPath, getEffectivePose(match.def))
          .then((url) => {
            if (url && !closed && img.dataset.itemId === String(id)) img.src = url
          })
          .catch(() => {})
      }
    }, { root: grid, rootMargin: '180px', threshold: 0.01 })

    if (!filtered.length) {
      grid.innerHTML = '<div class="asset-grid-empty">No 3D item thumbnails found</div>'
      return
    }

    for (const { def, modelPath } of filtered) {
      const card = document.createElement('div')
      card.className = 'item-thumb-card'

      const img = document.createElement('img')
      img.className = 'item-thumb-img'
      img.alt = def.name
      img.dataset.itemId = String(def.id)

      const meta = document.createElement('div')
      meta.className = 'item-thumb-meta'
      const name = document.createElement('div')
      name.className = 'item-thumb-name'
      name.textContent = def.name || `Item ${def.id}`
      const detail = document.createElement('div')
      detail.className = 'item-thumb-detail'
      detail.textContent = `#${def.id}${def.equipSlot ? ` · ${def.equipSlot}` : ''}${manifest.has(def.id) ? ' · baked' : ''}`
      meta.appendChild(name)
      meta.appendChild(detail)

      const editBtn = document.createElement('button')
      editBtn.className = 'asset-rotate-modal-btn'
      editBtn.textContent = 'Edit'
      editBtn.addEventListener('click', () => {
        openThumbnailPoseEditor({
          targetType: 'item',
          key: def.id,
          modelPath,
          title: `${def.name || 'Item'} (#${def.id})`,
          subtitle: modelPath,
          bakedWarning: manifest.has(def.id)
            ? 'This item has a baked PNG. Rebuild item thumbnails before the saved pose appears in-game.'
            : undefined,
          initialOverride: getEffectivePose(def),
          renderOutputPreview: async (entry) => {
            const opts = buildThumbnailOptionsFromOverride(def, entry)
            return renderRuntimeThumbnailPreview(modelPath, opts)
          },
          onSaved: async () => {
            const saved = await getItemOverride(def.id)
            const normalized = normalizeOverride(saved)
            if (normalized) thumbnailOverrides[String(def.id)] = normalized
            else delete thumbnailOverrides[String(def.id)]
            invalidateThumbnailOverrides()
            rebuildOverrideIndexes()
            const url = await refreshRuntimeItemThumb(def, modelPath, getEffectivePose(def))
            if (url) img.src = url
            sourceItemId = def.id
            renderList()
          },
        })
      })

      const pose = getSavedPose(def.id)
      const sourceBtn = document.createElement('button')
      sourceBtn.className = 'asset-rotate-modal-btn secondary'
      sourceBtn.textContent = 'Source'
      sourceBtn.disabled = !pose
      sourceBtn.title = pose ? 'Use this saved thumbnail pose as the copy source' : 'Save this thumbnail pose first'
      sourceBtn.addEventListener('click', () => {
        sourceItemId = def.id
        renderList()
      })

      const applyBtn = document.createElement('button')
      applyBtn.className = 'asset-rotate-modal-btn secondary'
      applyBtn.textContent = 'Apply'
      applyBtn.disabled = !sourceItemId || sourceItemId === def.id
      applyBtn.title = 'Apply the selected source pose to this item'
      applyBtn.addEventListener('click', () => {
        const source = sourceItemId ? itemById.get(sourceItemId)?.def : null
        if (source) copyPoseTo(source, [{ def, modelPath }], 'selected')
      })

      const familyBtn = document.createElement('button')
      familyBtn.className = 'asset-rotate-modal-btn secondary'
      familyBtn.textContent = 'Family'
      familyBtn.disabled = !pose || !def.equipSlot || sameFamilyTargets(def).length === 0
      familyBtn.title = 'Copy this item thumbnail pose to same family and slot'
      familyBtn.addEventListener('click', () => copyPoseTo(def, sameFamilyTargets(def), 'same-family'))

      const slotBtn = document.createElement('button')
      slotBtn.className = 'asset-rotate-modal-btn secondary'
      slotBtn.textContent = 'Slot'
      slotBtn.disabled = !pose || !def.equipSlot || sameSlotTargets(def).length === 0
      slotBtn.title = 'Copy this item thumbnail pose to every modeled item in this equipment slot'
      slotBtn.addEventListener('click', () => copyPoseTo(def, sameSlotTargets(def), 'same-slot'))

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
      grid.appendChild(card)
      renderedImages.set(def.id, img)
      observer.observe(img)
    }
  }

  search.addEventListener('input', renderList)
  renderList()
  search.focus()
}
