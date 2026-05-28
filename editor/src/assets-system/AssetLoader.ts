import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import type { Scene } from '@babylonjs/core/scene'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup'
import type { ISceneLoaderAsyncResult } from '@babylonjs/core/Loading/sceneLoader'
import '@babylonjs/loaders/glTF'

interface CacheEntry {
  template: TransformNode
  animGroups: AnimationGroup[]
}

interface BoundsMetadata {
  bounds: { width: number; height: number; depth: number }
}

interface CloneAssetOptions {
  doNotInstantiate?: boolean
}

const cache = new Map<string, CacheEntry>()

let _scene: Scene | null = null

/** Must be called once with the Babylon.js scene before loading any assets */
export function initAssetLoader(scene: Scene): void {
  _scene = scene
}

async function buildCenteredPivotTemplate(meshes: AbstractMesh[], root: AbstractMesh): Promise<TransformNode> {
  // Compute world-space bounding box of all meshes
  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  let minZ = Infinity, maxZ = -Infinity
  for (const mesh of meshes) {
    if (mesh.getTotalVertices && mesh.getTotalVertices() === 0) continue
    mesh.computeWorldMatrix(true)
    const bb = mesh.getBoundingInfo().boundingBox
    if (bb.minimumWorld.x < minX) minX = bb.minimumWorld.x
    if (bb.maximumWorld.x > maxX) maxX = bb.maximumWorld.x
    if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y
    if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y
    if (bb.minimumWorld.z < minZ) minZ = bb.minimumWorld.z
    if (bb.maximumWorld.z > maxZ) maxZ = bb.maximumWorld.z
  }

  const centerX = (minX + maxX) / 2
  const centerZ = (minZ + maxZ) / 2
  const sizeX = maxX - minX
  const sizeY = maxY - minY
  const sizeZ = maxZ - minZ

  // Create pivot TransformNode at bottom-center
  const pivot = new TransformNode('asset-pivot', _scene!)

  // Offset root so model's bottom-center aligns with pivot's origin
  root.parent = pivot
  root.position.x -= centerX
  root.position.y -= minY
  root.position.z -= centerZ

  pivot.metadata = {
    bounds: { width: sizeX, height: sizeY, depth: sizeZ }
  } as BoundsMetadata

  return pivot
}

export async function loadAssetModel(path: string, options: CloneAssetOptions = {}): Promise<TransformNode | null> {
  if (!_scene) throw new Error('AssetLoader not initialized — call initAssetLoader(scene) first')

  if (!cache.has(path)) {
    const encodedPath = path.split('/').map(s => encodeURIComponent(s)).join('/')
    const lastSlash = encodedPath.lastIndexOf('/')
    const dir = encodedPath.substring(0, lastSlash + 1)
    const file = encodedPath.substring(lastSlash + 1)

    const result: ISceneLoaderAsyncResult = await SceneLoader.ImportMeshAsync('', dir, file, _scene)
    const root = result.meshes[0]
    const template = await buildCenteredPivotTemplate(result.meshes, root)

    // Stop auto-played animations on template (they'll be cloned per instance)
    const animGroups = result.animationGroups || []
    for (const ag of animGroups) ag.stop()

    template.setEnabled(false)
    cache.set(path, { template, animGroups })
  }

  return cloneFromCache(path, options)
}

/** Synchronous clone — only valid when the path is already cached (e.g. after warmAssetCache). */
export function cloneAssetModelSync(path: string, options: CloneAssetOptions = {}): TransformNode | null {
  if (!cache.has(path)) throw new Error(`cloneAssetModelSync: "${path}" not in cache`)
  return cloneFromCache(path, options)
}

function cloneFromCache(path: string, options: CloneAssetOptions = {}): TransformNode | null {
  const { template } = cache.get(path)!
  const instantiateOptions = options.doNotInstantiate ? { doNotInstantiate: true } : undefined
  const instance = template.instantiateHierarchy(null, instantiateOptions, (source, cloned) => {
    cloned.name = `placed_${source.name}`
  })
  if (instance) {
    instance.setEnabled(true)
    for (const child of instance.getChildMeshes()) {
      child.setEnabled(true)
    }
    // Copy bounds metadata and initialize userData for compatibility
    instance.metadata = { ...(template.metadata || {}) }
    ;(instance as any).userData = { bounds: instance.metadata?.bounds || null }

    // Add .scale alias for .scaling (Three.js compat for scene.js code)
    if (!(instance as any).scale && instance.scaling) {
      Object.defineProperty(instance, 'scale', {
        get() { return this.scaling },
        set(v: any) { if (v && v.x !== undefined) this.scaling.copyFrom(v) }
      })
    }
  }

  return instance
}

function nextFrame(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })
}

/** Pre-warm the cache for a set of paths. After this, cloneAssetModelSync is safe. */
export async function warmAssetCache(paths: string[], concurrency = 2): Promise<void> {
  const uniquePaths = [...new Set(paths)].filter(Boolean)
  let next = 0

  async function worker(): Promise<void> {
    while (next < uniquePaths.length) {
      const path = uniquePaths[next++]
      const inst = await loadAssetModel(path).catch(() => null)
      if (inst) inst.dispose()
      await nextFrame()
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, uniquePaths.length))
  await Promise.all(Array.from({ length: workerCount }, worker))
}

export function isAssetCached(path: string): boolean {
  return cache.has(path)
}

export function getAssetAnimations(path: string): AnimationGroup[] {
  const entry = cache.get(path)
  return entry ? entry.animGroups : []
}

export function makeGhostMaterial(sourceModel: TransformNode): TransformNode | null {
  if (!_scene) return null

  const ghost = sourceModel.instantiateHierarchy(null, { doNotInstantiate: true }, (source, cloned) => {
    cloned.name = `ghost_${source.name}`
  })

  if (!ghost) return null

  ghost.setEnabled(true)
  ;(ghost as any).userData = {}
  if (!(ghost as any).scale && ghost.scaling) {
    Object.defineProperty(ghost, 'scale', {
      get() { return this.scaling },
      set(v: any) { if (v && v.x !== undefined) this.scaling.copyFrom(v) }
    })
  }
  const ghostMat = new StandardMaterial('ghost-material', _scene)
  ghostMat.diffuseColor = new Color3(1, 1, 1)
  ghostMat.specularColor = new Color3(0, 0, 0)
  ghostMat.alpha = 0.55

  for (const mesh of ghost.getChildMeshes()) {
    mesh.setEnabled(true)
    mesh.material = ghostMat
  }

  return ghost
}
