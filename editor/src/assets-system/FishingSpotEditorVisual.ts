import type { Scene } from '@babylonjs/core/scene'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import {
  type FishingSpotEffectResources,
  createFishingSpotEffectPlane,
  createFishingSpotEffectResources,
  updateFishingSpotEffectTexture,
} from '@client/rendering/FishingSpotEffect'

const FISHING_SPOT_BUBBLES_PATH = '/assets/models/fishingspotbubbles.glb'
const FISHING_SPOT_THUMB_TIME_SECONDS = 2.2

export interface FishingSpotEditorVisual {
  root: TransformNode
  resources: FishingSpotEffectResources
}

export function isFishingSpotPlaceholderPath(path: string): boolean {
  return String(path || '').toLowerCase() === FISHING_SPOT_BUBBLES_PATH
}

export function isFishingSpotPlaceholderAssetId(assetId: unknown): boolean {
  return String(assetId || '').startsWith('FishingSpotBubbles')
}

export function createFishingSpotEditorVisual(
  scene: Scene,
  name: string,
  options: { pickable?: boolean } = {},
): FishingSpotEditorVisual {
  const root = new TransformNode(name, scene)
  const resources = createFishingSpotEffectResources(scene, `${name}_resources`)
  updateFishingSpotEffectTexture(resources, FISHING_SPOT_THUMB_TIME_SECONDS)

  const effect = createFishingSpotEffectPlane(scene, `${name}_effectPlane`, resources.material)
  effect.parent = root
  effect.isPickable = options.pickable === true
  effect.doNotSerialize = true

  root.metadata = {
    bounds: { width: 1, height: 0.24, depth: 1 }
  }
  return { root, resources }
}

export function disposeFishingSpotEditorResources(resources: FishingSpotEffectResources): void {
  resources.material.dispose()
  resources.waterMaterial.dispose()
  resources.baseTexture.dispose()
  resources.mistTexture.dispose()
}
