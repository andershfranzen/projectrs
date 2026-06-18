import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader'
import type { ISceneLoaderAsyncResult } from '@babylonjs/core/Loading/sceneLoader'
import type { Material } from '@babylonjs/core/Materials/material'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import '@babylonjs/loaders/glTF'
import { getCachedThumb, putCachedThumb } from './ThumbnailCache'
import {
  createFishingSpotEditorVisual,
  disposeFishingSpotEditorResources,
  isFishingSpotPlaceholderPath,
} from './FishingSpotEditorVisual'

export const DEFAULT_THUMB_ALPHA = -Math.PI / 4
export const DEFAULT_THUMB_BETA = Math.PI / 2.6
export const DEFAULT_THUMB_DISTANCE_MULT = 0.75

/** Shared scene setup for any thumbnail-style render (grid renderer +
 *  rotation editor). Creates the same 3-light rig and clear color so both
 *  surfaces look identical. */
export function setupThumbnailLights(scene: Scene, namePrefix: string): void {
  const ambient = new HemisphericLight(`${namePrefix}-ambient`, new Vector3(0, 1, 0), scene)
  ambient.intensity = 0.9
  ambient.diffuse = new Color3(0.55, 0.55, 0.55)
  ambient.groundColor = new Color3(0.35, 0.33, 0.30)
  ambient.specular = new Color3(0, 0, 0)
  const sun = new DirectionalLight(`${namePrefix}-sun`, new Vector3(-0.5, -1, -0.3), scene)
  sun.intensity = 1.1
  sun.diffuse = new Color3(1.0, 0.84, 0.54)
  const fill = new DirectionalLight(`${namePrefix}-fill`, new Vector3(0.3, -0.6, 0.5), scene)
  fill.intensity = 0.65
  fill.diffuse = new Color3(0.67, 0.73, 0.80)
}

export function createThumbnailCamera(scene: Scene, name: string): ArcRotateCamera {
  const cam = new ArcRotateCamera(name, DEFAULT_THUMB_ALPHA, DEFAULT_THUMB_BETA, 10, Vector3.Zero(), scene)
  cam.minZ = 0.01
  cam.maxZ = 1000
  cam.fov = 0.8
  return cam
}

/** Split an unencoded GLB path into the {dir, file} pair SceneLoader wants,
 *  with per-segment URL encoding so paths with spaces / accents resolve. */
export function splitEncodedGlbUrl(path: string): { dir: string; file: string } {
  const encoded = path.split('/').map((s) => encodeURIComponent(s)).join('/')
  const slash = encoded.lastIndexOf('/')
  return { dir: encoded.substring(0, slash + 1), file: encoded.substring(slash + 1) }
}

/** Compute axis-aligned bounding-box center + the raw fit-radius for a Babylon
 *  ArcRotateCamera. Distance multipliers are applied by callers so the editor
 *  uses the same distance semantics as the runtime thumbnail renderer. Returns
 *  null for an empty/vertex-less import result. */
export function computeFitTargetForMeshes(
  meshes: AbstractMesh[],
  fov: number,
): { center: Vector3; fitRadius: number } | null {
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity
  for (const mesh of meshes) {
    if (!mesh.getTotalVertices || mesh.getTotalVertices() === 0) continue
    if (mesh.material) (mesh.material as any).backFaceCulling = false
    mesh.computeWorldMatrix(true)
    const bb = mesh.getBoundingInfo().boundingBox
    if (bb.minimumWorld.x < minX) minX = bb.minimumWorld.x
    if (bb.maximumWorld.x > maxX) maxX = bb.maximumWorld.x
    if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y
    if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y
    if (bb.minimumWorld.z < minZ) minZ = bb.minimumWorld.z
    if (bb.maximumWorld.z > maxZ) maxZ = bb.maximumWorld.z
  }
  if (!Number.isFinite(minX)) return null
  const center = new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)
  const sizeMax = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1
  const fitRadius = sizeMax / Math.tan(fov / 2)
  return { center, fitRadius }
}

export function computeFitTarget(
  result: ISceneLoaderAsyncResult,
  fov: number,
): { center: Vector3; fitRadius: number } | null {
  return computeFitTargetForMeshes(result.meshes, fov)
}

const THUMB_SIZE = 128
// Bump to invalidate every cached thumbnail across clients.
const THUMB_VERSION = 6
const RENDER_TIMEOUT_MS = 10000

export interface AssetThumbnailOverride {
  alpha?: number       // camera yaw (radians)
  beta?: number        // camera pitch (radians)
  distanceMult?: number // multiplier on auto-fit radius
  rotationX?: number    // model pitch (radians), before bbox fit
  rotationY?: number    // model yaw (radians), before bbox fit
  rotationZ?: number    // model roll (radians), before bbox fit
  iconScale?: number    // final post-trim runtime icon scale
}

interface ThumbnailOverrideDocument {
  _thumbnail_assets?: Record<string, AssetThumbnailOverride>
  _item_families?: Record<string, AssetThumbnailOverride>
  [key: string]: unknown
}

let _overrideDocPromise: Promise<ThumbnailOverrideDocument> | null = null

async function loadOverrideDocument(): Promise<ThumbnailOverrideDocument> {
  if (_overrideDocPromise) return _overrideDocPromise
  _overrideDocPromise = (async () => {
    try {
      const res = await fetch('/data/thumbnail-overrides.json', { cache: 'no-store' })
      if (!res.ok) return {}
      const data = await res.json()
      return data && typeof data === 'object' ? data as ThumbnailOverrideDocument : {}
    } catch {
      return {}
    }
  })()
  return _overrideDocPromise
}

async function loadAssetOverrides(): Promise<Record<string, AssetThumbnailOverride>> {
  const data = await loadOverrideDocument()
  const map = data?._thumbnail_assets
  if (!map || typeof map !== 'object') return {}
  const out: Record<string, AssetThumbnailOverride> = {}
  for (const [k, v] of Object.entries(map)) {
    if (v && typeof v === 'object') out[k] = v as AssetThumbnailOverride
  }
  return out
}

/** Force a re-fetch of overrides on next thumbnail render. Call after the
 *  rotation editor saves so subsequent renders see the new values. */
export function invalidateOverridesCache(): void {
  _overrideDocPromise = null
}

/** Read the current override for a path (after the cache is warm). Used by
 *  the rotation editor to seed initial alpha/beta/distance. */
export async function getAssetOverride(path: string): Promise<AssetThumbnailOverride> {
  const all = await loadAssetOverrides()
  return all[path] ?? {}
}

export async function getItemOverride(itemId: number): Promise<AssetThumbnailOverride> {
  const data = await loadOverrideDocument()
  const value = data?.[String(itemId)]
  return value && typeof value === 'object' ? value as AssetThumbnailOverride : {}
}

export async function getItemFamilyOverride(familyKey: string): Promise<AssetThumbnailOverride> {
  const data = await loadOverrideDocument()
  const value = data?._item_families?.[familyKey]
  return value && typeof value === 'object' ? value as AssetThumbnailOverride : {}
}

let _engine: Engine | null = null
let _scene: Scene | null = null
let _camera: ArcRotateCamera | null = null
let _canvas: HTMLCanvasElement | null = null

function ensureEngine(): void {
  if (_engine) return
  _canvas = document.createElement('canvas')
  _canvas.width = THUMB_SIZE
  _canvas.height = THUMB_SIZE
  _engine = new Engine(_canvas, true, { preserveDrawingBuffer: true, antialias: true })
  _scene = new Scene(_engine)
  _scene.clearColor = new Color4(0, 0, 0, 0)
  setupThumbnailLights(_scene, 'thumb')
  _camera = createThumbnailCamera(_scene, 'thumb-cam')
}

interface QueueItem {
  path: string
  override?: AssetThumbnailOverride
  resolve: (value: string | null) => void
}

const queue: QueueItem[] = []
const pending = new Map<string, Promise<string | null>>()
let processing = false

function waitForIdleSlot(): Promise<void> {
  return new Promise((resolve) => {
    const win = window as Window & {
      requestIdleCallback?: (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number
    }
    if (typeof win.requestIdleCallback === 'function') {
      win.requestIdleCallback(() => resolve(), { timeout: 750 })
      return
    }
    window.setTimeout(resolve, 32)
  })
}

function enqueue(path: string, override?: AssetThumbnailOverride): Promise<string | null> {
  const key = `${path}::${JSON.stringify(override || {})}`
  const existing = pending.get(key)
  if (existing) return existing

  const promise = new Promise<string | null>((resolve) => {
    queue.push({ path, override, resolve })
    if (!processing) processQueue()
  }).finally(() => {
    pending.delete(key)
  })

  pending.set(key, promise)
  return promise
}

async function processQueue(): Promise<void> {
  processing = true
  while (queue.length > 0) {
    const { path, override, resolve } = queue.shift()!
    try {
      await waitForIdleSlot()
      const url = await withTimeout(renderOne(path, override), RENDER_TIMEOUT_MS)
      resolve(url)
    } catch (err) {
      console.warn('[ThumbnailRenderer] render failed for', path, err)
      resolve(null)
    }
  }
  processing = false
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('thumbnail render timeout')), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } catch (err: unknown) {
    // Thumbnail rendering shares one Babylon scene. If a render times out,
    // drain that work before the next queued render starts so slow GLBs don't
    // stack multiple live imports and stall the editor.
    if ((err as Error)?.message === 'thumbnail render timeout') {
      try { return await promise } catch { /* ignore */ }
    }
    throw err
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function renderOne(path: string, explicitOverride?: AssetThumbnailOverride): Promise<string | null> {
  ensureEngine()
  if (isFishingSpotPlaceholderPath(path)) return renderFishingSpotThumbnail(path, explicitOverride)

  const { dir, file } = splitEncodedGlbUrl(path)
  const result: ISceneLoaderAsyncResult = await SceneLoader.ImportMeshAsync('', dir, file, _scene!)
  for (const ag of result.animationGroups || []) ag.stop()

  let dataUrl: string | null = null
  const overrides = explicitOverride ? null : await loadAssetOverrides()
  const ov = explicitOverride ?? overrides?.[path] ?? {}
  applyModelRotation(result, ov)
  const fit = computeFitTarget(result, _camera!.fov)
  if (fit) {
    _camera!.alpha = ov.alpha ?? DEFAULT_THUMB_ALPHA
    _camera!.beta = ov.beta ?? DEFAULT_THUMB_BETA
    _camera!.setTarget(fit.center)
    _camera!.radius = fit.fitRadius * (ov.distanceMult ?? DEFAULT_THUMB_DISTANCE_MULT)
    await _scene!.whenReadyAsync()
    // Two renders: first compiles shaders, second produces correct pixels.
    _scene!.render()
    _scene!.render()
    dataUrl = _canvas!.toDataURL('image/png')
  }
  disposeImportResult(result)
  return dataUrl
}

async function renderFishingSpotThumbnail(path: string, explicitOverride?: AssetThumbnailOverride): Promise<string | null> {
  const visual = createFishingSpotEditorVisual(_scene!, 'thumbFishingSpot')
  const overrides = explicitOverride ? null : await loadAssetOverrides()
  const ov = explicitOverride ?? overrides?.[path] ?? overrides?.['/assets/models/FishingSpotBubbles.glb'] ?? {}

  if (visual.root.rotationQuaternion) visual.root.rotationQuaternion = null
  visual.root.rotation.x += ov.rotationX ?? 0
  visual.root.rotation.y += ov.rotationY ?? 0
  visual.root.rotation.z += ov.rotationZ ?? 0
  visual.root.computeWorldMatrix(true)
  for (const mesh of visual.root.getChildMeshes()) mesh.computeWorldMatrix(true)

  let dataUrl: string | null = null
  const fit = computeFitTargetForMeshes(visual.root.getChildMeshes(), _camera!.fov)
  if (fit) {
    _camera!.alpha = ov.alpha ?? DEFAULT_THUMB_ALPHA
    _camera!.beta = ov.beta ?? DEFAULT_THUMB_BETA
    _camera!.setTarget(fit.center)
    _camera!.radius = fit.fitRadius * (ov.distanceMult ?? 1.15)
    await _scene!.whenReadyAsync()
    _scene!.render()
    _scene!.render()
    dataUrl = _canvas!.toDataURL('image/png')
  }

  visual.root.dispose()
  disposeFishingSpotEditorResources(visual.resources)
  return dataUrl
}

function applyModelRotation(result: ISceneLoaderAsyncResult, rotation?: AssetThumbnailOverride): void {
  if (!rotation?.rotationX && !rotation?.rotationY && !rotation?.rotationZ) return
  const root = result.meshes.find((m) => m.name === '__root__') ?? result.meshes.find((m) => !m.parent)
  if (!root) return
  if (root.rotationQuaternion) root.rotationQuaternion = null
  root.rotation.x += rotation.rotationX ?? 0
  root.rotation.y += rotation.rotationY ?? 0
  root.rotation.z += rotation.rotationZ ?? 0
  root.computeWorldMatrix(true)
  for (const mesh of result.meshes) mesh.computeWorldMatrix(true)
}

export async function renderThumbnailPreview(path: string, override: AssetThumbnailOverride): Promise<string | null> {
  return enqueue(path, override)
}

export function disposeImportResult(result: ISceneLoaderAsyncResult): void {
  const materialsSeen = new Set<Material>()
  for (const ag of result.animationGroups || []) {
    try { ag.dispose() } catch { /* ignore */ }
  }
  for (const skel of result.skeletons || []) {
    try { skel.dispose() } catch { /* ignore */ }
  }
  for (const mesh of result.meshes || []) {
    if (mesh.material) materialsSeen.add(mesh.material)
    try { mesh.dispose(false, false) } catch { /* ignore */ }
  }
  for (const tn of result.transformNodes || []) {
    try { tn.dispose(false, false) } catch { /* ignore */ }
  }
  for (const mat of materialsSeen) {
    try {
      const textures = mat.getActiveTextures ? mat.getActiveTextures() : []
      for (const tex of textures) {
        try { tex.dispose() } catch { /* ignore */ }
      }
      mat.dispose()
    } catch { /* ignore */ }
  }
}

export async function getThumbnail(path: string): Promise<string | null> {
  if (!path) return null
  const cached = await getCachedThumb(path, THUMB_VERSION)
  if (cached) return cached
  const rendered = await enqueue(path)
  if (rendered) putCachedThumb(path, rendered, THUMB_VERSION)
  return rendered
}
