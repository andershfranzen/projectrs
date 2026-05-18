import type { ItemDef } from '@projectrs/shared'
import { TOOL_TIER_METAL_COLOR } from '@client/data/EquipmentConfig'
import { getThumbnail as getRuntimeThumbnail, type ThumbnailOptions } from '@client/rendering/ThumbnailRenderer'
import { SLOT_THUMBNAIL_CAMERAS } from '@client/rendering/ItemIcon'
import { getItemOverride, type AssetThumbnailOverride } from './ThumbnailRenderer'
import { openThumbnailPoseEditor } from './ThumbnailRotationEditor'

export interface ItemThumbnailBrowserOptions {
  loadItems: () => Promise<ItemDef[]>
  resolveModelPath: (def: ItemDef) => string | null
}

let itemThumbManifestPromise: Promise<Set<number>> | null = null

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

function buildRuntimeOptions(def: ItemDef, override: AssetThumbnailOverride): ThumbnailOptions {
  const opts: ThumbnailOptions = {}
  const tint = TOOL_TIER_METAL_COLOR[def.id]
  if (tint) opts.tint = tint
  const slotCam = def.equipSlot ? SLOT_THUMBNAIL_CAMERAS[def.equipSlot] : undefined
  const { rotationY, ...itemCam } = override
  if (slotCam || Object.keys(itemCam).length > 0) {
    opts.camera = { ...slotCam, ...itemCam }
  }
  if (rotationY) opts.rotationY = rotationY
  return opts
}

async function renderRuntimeItemThumb(def: ItemDef, modelPath: string): Promise<string | null> {
  const override = await getItemOverride(def.id)
  return getRuntimeThumbnail(modelPath, buildRuntimeOptions(def, override))
}

export async function openItemThumbnailBrowser(options: ItemThumbnailBrowserOptions): Promise<void> {
  const itemDefs = await options.loadItems()
  const manifest = await loadItemThumbManifest()
  const items = itemDefs
    .map((def) => ({ def, modelPath: options.resolveModelPath(def) }))
    .filter((entry): entry is { def: ItemDef; modelPath: string } => !!entry.modelPath)

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

  const grid = document.createElement('div')
  grid.className = 'item-thumb-grid'
  panel.appendChild(grid)

  document.body.appendChild(backdrop)

  let observer: IntersectionObserver | null = null
  let closed = false
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
    if (observer) observer.disconnect()
    observer = new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        obs.unobserve(entry.target)
        const img = entry.target as HTMLImageElement
        const id = Number(img.dataset.itemId)
        const match = items.find((item) => item.def.id === id)
        if (!match) continue
        renderRuntimeItemThumb(match.def, match.modelPath)
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
          onSaved: async () => {
            const url = await renderRuntimeItemThumb(def, modelPath)
            if (url) img.src = url
          },
        })
      })

      card.appendChild(img)
      card.appendChild(meta)
      card.appendChild(editBtn)
      grid.appendChild(card)
      observer.observe(img)
    }
  }

  search.addEventListener('input', renderList)
  renderList()
  search.focus()
}
