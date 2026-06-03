import { Scene } from '@babylonjs/core/scene';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { ItemDef } from '../../../shared/types';
import { resolveEquipmentModelPath } from '../../../shared/gear';
import { EQUIP_SLOT_BONES, TOOL_TIER_METAL_COLOR, resolveGearOverrideForBodyType, type GearOverride } from '../data/EquipmentConfig';
import { CharacterEntity, type GearDef, type GearTemplate } from './CharacterEntity';
import '@babylonjs/loaders/glTF';

const GEAR_CACHE_BUST_TOKEN: string = (import.meta as any).env?.DEV ? `?v=${Date.now()}` : '';
export const PER_TARGET_GEAR_SLOTS: ReadonlySet<string> = new Set(['body', 'legs', 'hands', 'feet']);
const SKINNED_SLOTS: ReadonlySet<string> = new Set(['body', 'legs', 'hands', 'feet']);

function devCacheBustGearFile(file: string): string {
  return GEAR_CACHE_BUST_TOKEN ? `${file}${GEAR_CACHE_BUST_TOKEN}` : file;
}

export function resolveCharacterGearModelFile(
  itemDef: ItemDef | undefined,
  rawOverride: GearOverride | undefined,
  bodyType: number,
  slotName: string,
): string | null {
  const bodyOverrideFile = bodyType > 0
    ? rawOverride?.bodyTypeOverrides?.[String(bodyType)]?.file
    : undefined;
  if (bodyOverrideFile) return bodyOverrideFile;

  if (bodyType > 0 && itemDef?.bodyTypeModels?.[String(bodyType)]) {
    return resolveEquipmentModelPath(itemDef, bodyType, slotName);
  }

  if (rawOverride?.file) return rawOverride.file;
  return resolveEquipmentModelPath(itemDef, bodyType, slotName);
}

export function buildCharacterGearDef(
  itemId: number,
  slotName: string,
  itemDef: ItemDef | undefined,
  rawOverride: GearOverride | undefined,
  bodyType: number,
): { def: GearDef; override: GearOverride | null } | null {
  const boneConfig = EQUIP_SLOT_BONES[slotName];
  if (!boneConfig) return null;
  const override = resolveGearOverrideForBodyType(rawOverride, bodyType);
  const gearFile = resolveCharacterGearModelFile(itemDef, rawOverride, bodyType, slotName);
  if (!gearFile) return null;
  return {
    def: {
      itemId,
      file: gearFile,
      boneName: override?.boneName ?? boneConfig.boneName,
      localPosition: override?.localPosition ?? boneConfig.localPosition,
      localRotation: override?.localRotation ?? boneConfig.localRotation,
      scale: override?.scale ?? boneConfig.scale,
      centerOrigin: override?.centerOrigin ?? false,
      metalColor: TOOL_TIER_METAL_COLOR[itemId],
      headRenderMode: itemDef?.headRenderMode,
    },
    override,
  };
}

export function disposeImportedGearResult(result: {
  meshes?: { dispose: () => void }[];
  skeletons?: { dispose: () => void }[];
  animationGroups?: { dispose: () => void }[];
}): void {
  for (const group of result.animationGroups ?? []) group.dispose();
  for (const skeleton of result.skeletons ?? []) skeleton.dispose();
  for (const mesh of result.meshes ?? []) mesh.dispose();
}

function flattenGearMaterials(scene: Scene, meshes: AbstractMesh[], metalColor?: [number, number, number]): void {
  for (const mesh of meshes) {
    const pbr = mesh.material as any;
    if (!pbr || !pbr.getClassName || pbr.getClassName() !== 'PBRMaterial') continue;
    const flat = new StandardMaterial(`${pbr.name}_flat`, scene);
    const hasTexture = !!pbr.albedoTexture;
    const isPolysplitGear = pbr.name && pbr.name.startsWith('genericRGBMat_Objects');
    if (hasTexture) {
      flat.diffuseTexture = pbr.albedoTexture;
      pbr.albedoTexture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
    }
    if (pbr.albedoColor && !hasTexture) {
      const b = 1.3;
      flat.diffuseColor = new Color3(
        Math.min(1, pbr.albedoColor.r * b),
        Math.min(1, pbr.albedoColor.g * b),
        Math.min(1, pbr.albedoColor.b * b),
      );
    } else if (isPolysplitGear) {
      flat.diffuseColor = new Color3(0.55, 0.55, 0.55);
    }
    flat.specularColor = Color3.Black();
    if (!hasTexture) {
      const dc = flat.diffuseColor;
      flat.emissiveColor = new Color3(dc.r * 0.55, dc.g * 0.55, dc.b * 0.55);
    }
    flat.backFaceCulling = pbr.backFaceCulling ?? true;
    mesh.material = flat;
  }

  if (!metalColor) return;
  const tint = new Color3(...metalColor);
  const recolored = new Set<string>();
  for (const mesh of meshes) {
    const mat = mesh.material as any;
    if (!mat || !mat.name || !mat.name.includes('Material.002')) continue;
    const clonedName = `${mat.name}_tint`;
    let cloned: any;
    if (recolored.has(clonedName)) {
      cloned = scene.getMaterialByName(clonedName);
    } else {
      cloned = mat.clone(clonedName);
      if (cloned) {
        if ('albedoColor' in cloned) cloned.albedoColor = tint;
        if ('diffuseColor' in cloned) cloned.diffuseColor = tint;
        recolored.add(clonedName);
      }
    }
    if (cloned) mesh.material = cloned;
  }
}

export function buildCharacterGearTemplateFromResult(
  scene: Scene,
  result: { meshes: AbstractMesh[] },
  def: GearDef,
): GearTemplate {
  const root = new TransformNode(`gearTemplate_${def.itemId}`, scene);
  for (const mesh of result.meshes) {
    if (!mesh.parent || mesh.parent.name === '__root__') mesh.parent = root;
  }

  flattenGearMaterials(scene, result.meshes, def.metalColor);

  if (!def.centerOrigin) {
    let minY = Infinity;
    for (const mesh of result.meshes) {
      if (mesh.getTotalVertices() === 0) continue;
      mesh.computeWorldMatrix(true);
      const bb = mesh.getBoundingInfo().boundingBox;
      if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
    }
    for (const child of root.getChildren()) {
      (child as TransformNode).position.y -= Number.isFinite(minY) ? minY : 0;
    }
  }

  root.setEnabled(false);
  return {
    template: root,
    boneName: def.boneName,
    localPosition: def.localPosition
      ? new Vector3(def.localPosition.x, def.localPosition.y, def.localPosition.z)
      : Vector3.Zero(),
    localRotation: def.localRotation
      ? new Vector3(def.localRotation.x, def.localRotation.y, def.localRotation.z)
      : Vector3.Zero(),
    scale: def.scale ?? 1,
    headRenderMode: def.headRenderMode,
  };
}

export async function loadCharacterGearSmart(
  scene: Scene,
  character: CharacterEntity | null | undefined,
  slotName: string,
  itemId: number,
  def: GearDef,
  itemDef: ItemDef | undefined,
  override: GearOverride | null,
  isCurrentApply?: () => boolean,
): Promise<GearTemplate | null> {
  try {
    const lastSlash = def.file.lastIndexOf('/');
    const dir = def.file.substring(0, lastSlash + 1);
    const file = devCacheBustGearFile(def.file.substring(lastSlash + 1));
    const result = await SceneLoader.ImportMeshAsync('', dir, file, scene);
    if (isCurrentApply && !isCurrentApply()) {
      disposeImportedGearResult(result);
      return null;
    }

    const bodyHideStyle: 'plate' | 'chain' = itemDef?.bodyHideStyle === 'chain' ? 'chain' : 'plate';
    if (result.skeletons.length === 0 && SKINNED_SLOTS.has(slotName) && character) {
      const ok = await character.attachManualSkinnedArmor(slotName, def.file, result.meshes, itemId, bodyHideStyle, isCurrentApply);
      if (isCurrentApply && !isCurrentApply()) {
        disposeImportedGearResult(result);
        return null;
      }
      if (ok) {
        const loaderRoot = result.meshes.find(mesh => mesh.name === '__root__');
        if (loaderRoot) loaderRoot.dispose();
        if (override) character.applySkinnedArmorTransform(slotName, override);
        return null;
      }
    }

    if (result.skeletons.length > 0 && character) {
      if (isCurrentApply && !isCurrentApply()) {
        disposeImportedGearResult(result);
        return null;
      }
      flattenGearMaterials(scene, result.meshes, def.metalColor);

      if (slotName === 'head') {
        const armorSkel = result.skeletons[0];
        const headBone = armorSkel.bones.find(bone => bone.name === 'mixamorig:Head');
        let headBindY = 0;
        const node = headBone?.getTransformNode();
        if (node) {
          node.computeWorldMatrix(true);
          headBindY = node.absolutePosition.y;
        }
        for (const skeleton of result.skeletons) skeleton.dispose();
        for (const mesh of result.meshes) mesh.skeleton = null;
        const template = buildCharacterGearTemplateFromResult(scene, result, {
          ...def,
          boneName: 'mixamorig:Head',
          centerOrigin: true,
        });
        if (isCurrentApply && !isCurrentApply()) {
          template.template.dispose();
          return null;
        }
        for (const child of template.template.getChildren()) {
          (child as TransformNode).position.y -= headBindY;
        }
        return template;
      }

      character.detachGear(slotName);
      if (isCurrentApply && !isCurrentApply()) {
        disposeImportedGearResult(result);
        return null;
      }
      character.attachSkinnedArmor(slotName, result.meshes, result.skeletons[0], itemId, bodyHideStyle);
      const loaderRoot = result.meshes.find(mesh => mesh.name === '__root__');
      if (loaderRoot) loaderRoot.dispose();
      if (override) character.applySkinnedArmorTransform(slotName, override);
      return null;
    }

    const template = buildCharacterGearTemplateFromResult(scene, result, def);
    if (isCurrentApply && !isCurrentApply()) {
      template.template.dispose();
      return null;
    }
    return template;
  } catch (error) {
    console.warn(`[Gear] Failed to load '${def.file}':`, error);
    return null;
  }
}
