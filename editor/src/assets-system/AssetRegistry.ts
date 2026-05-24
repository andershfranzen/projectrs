interface RawAssetData {
  id?: string
  name?: string
  path?: string
  section?: string
  group?: string
  tags?: string[]
  defaultScale?: number
}

export interface AssetEntry {
  id: string
  name: string
  path: string
  section: string
  group: string
  folderPath: string
  tags: string[]
  defaultScale: number | null
}

function humanizeName(value: unknown): string {
  return String(value || '')
    .replace(/%20/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/\.(glb|gltf)$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase())
}

function deriveAssetMeta(path: unknown): { section: string; group: string; folderPath: string } {
  const normalized = decodeURIComponent(String(path || '').replace(/\\/g, '/'))
  const parts = normalized.split('/').filter(Boolean)

  const assetsIndex = parts.findIndex((p) => p.toLowerCase() === 'assets')
  const rel = assetsIndex >= 0 ? parts.slice(assetsIndex + 1) : parts

  let section = 'Other'
  let group = 'General'

  if (rel[0]?.toLowerCase() === 'models') {
    const modelGroup = rel[1] ? humanizeName(rel[1]) : 'Base Models'
    if (modelGroup.toLowerCase() === 'roofs') {
      section = 'Roofs'
      group = 'General'
    } else {
      section = 'Models'
      group = 'Base Models'
    }
  } else if (rel[0]?.toLowerCase() === 'modular assets') {
    section = 'Modular Assets'
    group = rel[1] ? humanizeName(rel[1]) : 'General'
  } else {
    section = rel[0] ? humanizeName(rel[0]) : 'Other'
    group = rel[1] ? humanizeName(rel[1]) : 'General'
  }

  return {
    section,
    group,
    folderPath: rel.slice(0, -1).map(humanizeName).join(' / ')
  }
}

export async function loadAssetRegistry(): Promise<AssetEntry[]> {
  const response = await fetch('/assets/assets.json')
  if (!response.ok) {
    throw new Error('Failed to load /assets/assets.json')
  }

  const data: RawAssetData[] | { assets: RawAssetData[] } = await response.json()

  let assets: RawAssetData[] = []

  if (Array.isArray(data)) {
    assets = data
  } else if (Array.isArray(data.assets)) {
    assets = data.assets
  }

  const seenIds = new Set<string>()

  return assets
    .filter((asset): asset is RawAssetData & { path: string } => {
      if (!asset.path) return false
      const lower = asset.path.toLowerCase()
      return lower.endsWith('.glb') || lower.endsWith('.gltf')
    })
    .filter((asset) => {
      const id = asset.id || asset.name || asset.path
      if (seenIds.has(id)) {
        console.warn(`[AssetRegistry] Duplicate asset id '${id}' ignored: ${asset.path}`)
        return false
      }
      seenIds.add(id)
      return true
    })
    .map((asset): AssetEntry => {
      const meta = deriveAssetMeta(asset.path)
      const fileName = asset.path.split('/').pop() || 'asset.glb'

      return {
        id: asset.id || asset.name || asset.path,
        name: asset.name || humanizeName(fileName),
        path: asset.path,
        section: asset.section || meta.section,
        group: asset.group || meta.group,
        folderPath: meta.folderPath,
        tags: Array.isArray(asset.tags) ? asset.tags : [],
        // Per-asset placement scale override; the editor reads this when the asset is selected
        defaultScale: typeof asset.defaultScale === 'number' ? asset.defaultScale : null
      }
    })
    .sort((a, b) => {
      if (a.section !== b.section) return a.section.localeCompare(b.section)
      if (a.group !== b.group) return a.group.localeCompare(b.group)
      return a.name.localeCompare(b.name)
    })
}
