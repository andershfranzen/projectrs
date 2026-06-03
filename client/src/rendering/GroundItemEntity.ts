import {
  LOGS_ITEM_ID,
  MAGIC_LOGS_ITEM_ID,
  MAPLE_LOGS_ITEM_ID,
  OAK_LOGS_ITEM_ID,
  WILLOW_LOGS_ITEM_ID,
  YEW_LOGS_ITEM_ID,
  type ItemDef,
} from '@projectrs/shared';
import { Scene } from '@babylonjs/core/scene';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { buildThumbnailOptionsForItem, resolveItemModelPath, stackModelScaleForItem } from './ItemIcon';
import type { ThumbnailOptions } from './ThumbnailRenderer';
import '@babylonjs/loaders/glTF';

export interface GroundItemStackEntry {
  id: number;
  itemId: number;
  quantity: number;
  x: number;
  z: number;
  floor: number;
  y: number;
  def: ItemDef;
}

interface GroundItemTemplate {
  root: TransformNode;
  baseScale: number;
  baseYaw: number;
}

const MAX_MODELS_PER_TILE = 3;
const DEFAULT_TARGET_MODEL_SIZE = 0.34;
const LOG_GROUND_ITEM_VISUAL_SCALE = 1.6;
const TEMPLATE_CACHE_BY_SCENE = new WeakMap<Scene, Map<string, Promise<GroundItemTemplate | null>>>();

const LOG_GROUND_ITEM_IDS = new Set<number>([
  LOGS_ITEM_ID,
  OAK_LOGS_ITEM_ID,
  WILLOW_LOGS_ITEM_ID,
  MAPLE_LOGS_ITEM_ID,
  YEW_LOGS_ITEM_ID,
  MAGIC_LOGS_ITEM_ID,
]);

const SLOT_TARGET_MODEL_SIZE: Partial<Record<NonNullable<ItemDef['equipSlot']>, number>> = {
  weapon: 0.46,
  shield: 0.42,
  head: 0.28,
  body: 0.52,
  legs: 0.44,
  hands: 0.24,
  feet: 0.24,
  cape: 0.46,
  neck: 0.18,
  ring: 0.14,
};

const STACK_OFFSETS = [
  new Vector3(0.06, 0.045, -0.05),
  new Vector3(-0.07, 0.025, 0.06),
  new Vector3(0, 0, 0),
];

function templateCacheKey(path: string, options: ThumbnailOptions, targetSize: number): string {
  const parts = [path, `size:${targetSize.toFixed(3)}`];
  if (options.tint) {
    const [r, g, b] = options.tint;
    parts.push(`t:${r.toFixed(3)},${g.toFixed(3)},${b.toFixed(3)}`);
    if (options.tintAllMaterials) parts.push('all');
    if (options.tintMaterialMatch) parts.push(`m:${options.tintMaterialMatch}`);
    if (options.tintBaseColorMatch) {
      const [mr, mg, mb] = options.tintBaseColorMatch;
      parts.push(`base:${mr.toFixed(3)},${mg.toFixed(3)},${mb.toFixed(3)}`);
      parts.push(`tol:${(options.tintBaseColorTolerance ?? 0.015).toFixed(3)}`);
    }
  }
  if (options.rotationY) parts.push(`roty:${options.rotationY.toFixed(3)}`);
  return parts.join('|');
}

function convertPbrToFlat(mesh: AbstractMesh, scene: Scene): void {
  const pbr = mesh.material as any;
  if (!pbr || !pbr.getClassName || pbr.getClassName() !== 'PBRMaterial') return;

  if (mesh.isVerticesDataPresent(VertexBuffer.ColorKind)) {
    mesh.useVertexColors = true;
  }

  const flat = new StandardMaterial(`${pbr.name}_groundFlat`, scene);
  const hasTexture = !!pbr.albedoTexture;
  if (hasTexture) {
    flat.diffuseTexture = pbr.albedoTexture;
    pbr.albedoTexture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
  }
  if (pbr.albedoColor && !hasTexture) {
    const boost = 1.2;
    flat.diffuseColor = new Color3(
      Math.min(1, pbr.albedoColor.r * boost),
      Math.min(1, pbr.albedoColor.g * boost),
      Math.min(1, pbr.albedoColor.b * boost),
    );
  }
  flat.specularColor = Color3.Black();
  if (!hasTexture) {
    const dc = flat.diffuseColor;
    flat.emissiveColor = new Color3(dc.r * 0.35, dc.g * 0.35, dc.b * 0.35);
  }
  flat.backFaceCulling = pbr.backFaceCulling ?? true;
  mesh.material = flat;
}

function applyTint(meshes: AbstractMesh[], options: ThumbnailOptions): void {
  if (!options.tint) return;

  const match = options.tintMaterialMatch ?? 'Material.002';
  const baseMatch = options.tintBaseColorMatch;
  const baseTolerance = options.tintBaseColorTolerance ?? 0.015;
  const [r, g, b] = options.tint;
  const tint = new Color3(r, g, b);

  for (const mesh of meshes) {
    const mat = mesh.material as any;
    if (!mat) continue;
    let shouldTint = options.tintAllMaterials === true;
    if (!shouldTint && baseMatch) {
      const base = mat.albedoColor ?? mat.diffuseColor;
      shouldTint = !!base
        && Math.abs(base.r - baseMatch[0]) <= baseTolerance
        && Math.abs(base.g - baseMatch[1]) <= baseTolerance
        && Math.abs(base.b - baseMatch[2]) <= baseTolerance;
    }
    if (!shouldTint && mat.name && mat.name.includes(match)) shouldTint = true;
    if (!shouldTint) continue;
    const hasTexture = (mat.albedoTexture && mat.albedoTexture !== null) || (mat.diffuseTexture && mat.diffuseTexture !== null);
    if (hasTexture) continue;
    if ('albedoColor' in mat) mat.albedoColor = tint;
    if ('diffuseColor' in mat) mat.diffuseColor = tint;
    if ('emissiveColor' in mat) mat.emissiveColor = new Color3(tint.r * 0.35, tint.g * 0.35, tint.b * 0.35);
  }
}

function clampGroundItemVisualScale(scale: number | undefined): number {
  return typeof scale === 'number' && Number.isFinite(scale) ? Math.max(0.05, Math.min(2, scale)) : 1;
}

export function groundItemVisualScaleFromOptions(options: Pick<ThumbnailOptions, 'iconScale'>): number {
  return clampGroundItemVisualScale(options.iconScale);
}

function groundItemTypeScaleForItem(def: ItemDef): number {
  return LOG_GROUND_ITEM_IDS.has(def.id) ? LOG_GROUND_ITEM_VISUAL_SCALE : 1;
}

export function groundItemTargetModelSizeForItem(def: ItemDef, quantity: number = 1, visualScale: number = 1): number {
  const baseSize = def.equipSlot ? (SLOT_TARGET_MODEL_SIZE[def.equipSlot] ?? DEFAULT_TARGET_MODEL_SIZE) : DEFAULT_TARGET_MODEL_SIZE;
  return baseSize * stackModelScaleForItem(def, quantity) * clampGroundItemVisualScale(visualScale) * groundItemTypeScaleForItem(def);
}

function normalizeTemplate(root: TransformNode, targetSize: number): number {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const mesh of root.getChildMeshes(false)) {
    if (!mesh.getTotalVertices || mesh.getTotalVertices() === 0) continue;
    mesh.computeWorldMatrix(true);
    const bb = mesh.getBoundingInfo().boundingBox;
    minX = Math.min(minX, bb.minimumWorld.x);
    maxX = Math.max(maxX, bb.maximumWorld.x);
    minY = Math.min(minY, bb.minimumWorld.y);
    maxY = Math.max(maxY, bb.maximumWorld.y);
    minZ = Math.min(minZ, bb.minimumWorld.z);
    maxZ = Math.max(maxZ, bb.maximumWorld.z);
  }

  if (!Number.isFinite(minX)) return 1;

  const centerX = (minX + maxX) / 2;
  const centerZ = (minZ + maxZ) / 2;
  for (const child of root.getChildren()) {
    const node = child as TransformNode;
    node.position.x -= centerX;
    node.position.y -= minY;
    node.position.z -= centerZ;
  }

  const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
  return targetSize / size;
}

async function loadTemplate(scene: Scene, def: ItemDef, quantity: number): Promise<GroundItemTemplate | null> {
  const path = resolveItemModelPath(def, quantity);
  if (!path) return null;

  const options = await buildThumbnailOptionsForItem(def);
  const targetSize = groundItemTargetModelSizeForItem(def, quantity, groundItemVisualScaleFromOptions(options));
  const key = templateCacheKey(path, options, targetSize);
  let sceneCache = TEMPLATE_CACHE_BY_SCENE.get(scene);
  if (!sceneCache) {
    sceneCache = new Map<string, Promise<GroundItemTemplate | null>>();
    TEMPLATE_CACHE_BY_SCENE.set(scene, sceneCache);
  }

  let promise = sceneCache.get(key);
  if (!promise) {
    promise = (async () => {
      try {
        const lastSlash = path.lastIndexOf('/');
        const dir = path.substring(0, lastSlash + 1);
        const file = path.substring(lastSlash + 1);
        const result = await SceneLoader.ImportMeshAsync('', dir, file, scene);
        for (const group of result.animationGroups || []) group.dispose();

        const root = new TransformNode(`groundItemTemplate_${def.id}`, scene);
        for (const mesh of result.meshes) {
          if (!mesh.parent || mesh.parent.name === '__root__') mesh.parent = root;
          mesh.isPickable = false;
          convertPbrToFlat(mesh, scene);
        }
        applyTint(result.meshes, options);

        const baseScale = normalizeTemplate(root, targetSize);
        const baseYaw = options.rotationY ?? 0;
        root.setEnabled(false);
        for (const child of root.getChildMeshes(false)) child.setEnabled(false);
        return { root, baseScale, baseYaw };
      } catch (e) {
        console.warn(`[GroundItemEntity] Failed to load '${path}':`, e);
        return null;
      }
    })();
    sceneCache.set(key, promise);
  }
  return promise;
}

export class GroundItemEntity {
  private readonly root: TransformNode;
  private readonly nodes: TransformNode[] = [];

  private constructor(scene: Scene, name: string, x: number, y: number, z: number, groundItemId: number) {
    this.root = new TransformNode(name, scene);
    this.root.position.set(x, y, z);
    this.root.metadata = { kind: 'groundItem', groundItemId };
    this.root.setEnabled(false);
  }

  static async create(
    scene: Scene,
    tileKey: string,
    stack: GroundItemStackEntry[],
    y: number,
  ): Promise<GroundItemEntity | null> {
    const entries = stack.slice(0, MAX_MODELS_PER_TILE);
    const primary = entries[0];
    if (!primary) return null;

    const entity = new GroundItemEntity(scene, `groundItemStack_${tileKey}`, primary.x, y, primary.z, primary.id);
    const primaryTemplate = await loadTemplate(scene, primary.def, primary.quantity);
    if (!primaryTemplate) {
      entity.dispose();
      return null;
    }
    let attached = 0;

    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const template = i === 0 ? primaryTemplate : await loadTemplate(scene, entry.def, entry.quantity);
      if (!template) continue;

      const clone = template.root.instantiateHierarchy(null, undefined, (source, cloned) => {
        cloned.name = `${source.name}_drop_${tileKey}_${entry.itemId}_${i}`;
      });
      if (!clone) continue;

      clone.parent = entity.root;
      clone.setEnabled(true);
      for (const child of clone.getChildMeshes(false)) {
        child.setEnabled(true);
        child.isPickable = false;
        child.metadata = { kind: 'groundItemVisual', groundItemId: primary.id };
      }

      const offset = STACK_OFFSETS[Math.min(i, STACK_OFFSETS.length - 1)];
      clone.position.copyFrom(offset);
      clone.rotationQuaternion = null;
      const stackYaw = i === 0 ? 0 : ((entry.itemId * 37) % 360) * Math.PI / 180;
      clone.rotation.set(0, template.baseYaw + stackYaw, 0);
      const scale = template.baseScale * (i === 0 ? 1.06 : 0.92);
      clone.scaling.set(scale, scale, scale);
      entity.nodes.push(clone);
      attached++;
    }

    if (attached === 0) {
      entity.dispose();
      return null;
    }

    entity.root.setEnabled(true);
    return entity;
  }

  setPosition(x: number, y: number, z: number): void {
    this.root.position.set(x, y, z);
  }

  dispose(): void {
    for (const node of this.nodes) node.dispose();
    this.nodes.length = 0;
    this.root.dispose();
  }
}
