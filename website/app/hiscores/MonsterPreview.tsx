'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CHARACTER_IDLE_ANIM,
  CHARACTER_TARGET_HEIGHT,
  getCharacterModelPath,
} from '../../../shared/character';
import { DEFAULT_APPEARANCE, type PlayerAppearance } from '../../../shared/appearance';
import {
  resolveEquipmentModelPath,
} from '../../../shared/gear';
import type {
  CustomColors,
  ItemDef,
} from '../../../shared/types';
import { NPC_CUSTOMIZABLE_PROFILE } from '../../../client/src/data/NpcConfig';
import { CharacterEntity, type GearDef, type GearTemplate } from '../../../client/src/rendering/CharacterEntity';
import { EQUIP_SLOT_BONES, EQUIP_SLOT_NAMES, resolveGearOverrideForBodyType, TOOL_TIER_METAL_COLOR, type GearOverride } from '../../../client/src/data/EquipmentConfig';

type MonsterPreviewConfig = {
  file: string;
  scale?: number;
  cameraYaw?: number;
  modelYaw?: number;
  pitch?: number;
  radius?: number;
  targetY?: number;
  materialColors?: Record<string, [number, number, number]>;
};

const MONSTER_PREVIEWS: Record<number, MonsterPreviewConfig> = {
  1: { file: '/models/npcs/chicken_v2.glb', scale: 1.2 },
  23: { file: '/models/npcs/rooster_v1.glb', scale: 1.2 },
  2: { file: '/models/npcs/rat.glb', scale: 0.2 },
  4: { file: '/models/npcs/wolf.glb', scale: 0.4 },
  6: { file: '/models/npcs/spider.glb', scale: 0.2 },
  10: { file: '/models/npcs/cow.glb', scale: 0.2 },
  24: { file: '/models/npcs/bull.glb', scale: 0.2 },
  15: { file: '/models/npcs/Camel.glb', scale: 1.0 },
  18: { file: '/models/npcs/rat_small.glb', scale: 0.45 },
  22: { file: '/models/npcs/spider_v2.glb', scale: 0.75 },
  17: {
    file: '/models/npcs/wolf.glb',
    scale: 0.4,
    materialColors: {
      Main: [0.88, 0.9, 0.95],
      Main_Light: [0.97, 0.98, 1.0],
    },
  },
};

export type NpcVisualProfile = {
  appearance?: PlayerAppearance;
  equipment?: number[];
  customColors?: CustomColors;
};

const DEFAULT_HUMANOID_VISUAL: NpcVisualProfile = {};

type GearResources = {
  items: Map<number, ItemDef>;
  overrides: Map<number, GearOverride>;
};

let gearResourcesPromise: Promise<GearResources> | null = null;

async function loadGearResources(): Promise<GearResources> {
  if (!gearResourcesPromise) {
    gearResourcesPromise = Promise.all([
      fetch('/data/items.json').then((res) => res.ok ? res.json() : []),
      fetch('/data/gear-overrides.json').then((res) => res.ok ? res.json() : {}).catch(() => ({})),
    ]).then(([itemsRaw, overridesRaw]) => ({
      items: new Map((Array.isArray(itemsRaw) ? itemsRaw : []).map((item: ItemDef) => [item.id, item])),
      overrides: new Map(
        Object.entries((overridesRaw && typeof overridesRaw === 'object') ? overridesRaw as Record<string, GearOverride> : {})
          .map(([id, override]) => [Number(id), override]),
      ),
    }));
  }
  return gearResourcesPromise;
}

function isCanvasBlank(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] > 12) return false;
  }
  return true;
}

function createFallbackMonsterSilhouette(
  core: typeof import('@babylonjs/core'),
  scene: import('@babylonjs/core').Scene,
  modelYaw: number,
): void {
  const material = new core.StandardMaterial('monster-preview-fallback-material', scene);
  material.diffuseColor = new core.Color3(0.55, 0.18, 0.15);
  material.emissiveColor = new core.Color3(0.22, 0.04, 0.035);
  material.specularColor = new core.Color3(0, 0, 0);

  const body = core.MeshBuilder.CreateSphere('monster-preview-fallback-body', {
    diameterX: 0.72,
    diameterY: 0.48,
    diameterZ: 0.42,
    segments: 16,
  }, scene);
  body.material = material;
  body.rotation.y = modelYaw;

  const head = core.MeshBuilder.CreateSphere('monster-preview-fallback-head', {
    diameterX: 0.3,
    diameterY: 0.26,
    diameterZ: 0.28,
    segments: 12,
  }, scene);
  head.material = material;
  head.position.set(0.32, 0.16, -0.05);
  head.rotation.y = modelYaw;

  const tail = core.MeshBuilder.CreateCylinder('monster-preview-fallback-tail', {
    height: 0.5,
    diameter: 0.08,
    tessellation: 8,
  }, scene);
  tail.material = material;
  tail.position.set(-0.38, 0.02, 0.05);
  tail.rotation.z = Math.PI / 2.8;
  tail.rotation.y = modelYaw;
}

type MonsterPreviewProps = {
  npcId: number | null;
  name: string;
  visual?: NpcVisualProfile | null;
};

function bodyTypeOf(character: CharacterEntity, appearance: PlayerAppearance): number {
  return appearance.bodyType ?? 0;
}

function getSceneBounds(
  core: typeof import('@babylonjs/core'),
  scene: import('@babylonjs/core').Scene,
): { center: import('@babylonjs/core').Vector3; size: import('@babylonjs/core').Vector3 } | null {
  const min = new core.Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const max = new core.Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
  let found = false;
  for (const mesh of scene.meshes) {
    if (!mesh.isEnabled() || mesh.getTotalVertices() <= 0 || mesh.visibility === 0) continue;
    mesh.computeWorldMatrix(true);
    const bounds = mesh.getHierarchyBoundingVectors(true);
    min.minimizeInPlace(bounds.min);
    max.maximizeInPlace(bounds.max);
    found = true;
  }
  if (!found) return null;
  return { center: min.add(max).scale(0.5), size: max.subtract(min) };
}

async function renderSettledFrames(scene: import('@babylonjs/core').Scene, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    scene.render();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function isSafeEquipmentPreviewPath(file: string, slotName: string): boolean {
  if (!file.startsWith(`/assets/equipment/${slotName}/`)) return false;
  if (!/\.(glb|gltf)$/i.test(file)) return false;
  if (file.includes('..') || file.includes('\\') || /[\u0000-\u001f]/.test(file)) return false;
  return true;
}

async function applyExactEquipment(
  core: typeof import('@babylonjs/core'),
  scene: import('@babylonjs/core').Scene,
  character: CharacterEntity,
  appearance: PlayerAppearance,
  slots: number[] | undefined,
): Promise<void> {
  if (!slots?.some((itemId) => itemId > 0)) return;
  const { items, overrides } = await loadGearResources();
  const bodyType = bodyTypeOf(character, appearance);

  for (let i = 0; i < EQUIP_SLOT_NAMES.length; i++) {
    const slotName = EQUIP_SLOT_NAMES[i];
    const itemId = slots[i] ?? 0;
    if (itemId <= 0 || slotName === 'ammo') continue;
    if (slotName === 'weapon' || slotName === 'shield') continue;
    const itemDef = items.get(itemId);
    const boneConfig = EQUIP_SLOT_BONES[slotName];
    if (!itemDef || !boneConfig) continue;

    const rawOverride = overrides.get(itemId);
    const override = resolveGearOverrideForBodyType(rawOverride, bodyType);
    const file = override?.file ?? resolveEquipmentModelPath(itemDef, bodyType, slotName);
    if (!file) continue;
    if (!isSafeEquipmentPreviewPath(file, slotName)) continue;

    const def: GearDef = {
      itemId,
      file,
      boneName: override?.boneName ?? boneConfig.boneName,
      localPosition: override?.localPosition ?? boneConfig.localPosition,
      localRotation: override?.localRotation ?? boneConfig.localRotation,
      scale: override?.scale ?? boneConfig.scale,
      centerOrigin: override?.centerOrigin ?? false,
      metalColor: TOOL_TIER_METAL_COLOR[itemId],
      headRenderMode: itemDef.headRenderMode,
    };
    const template = await loadPreviewGearSmart(core, scene, character, slotName, itemId, def, itemDef.bodyHideStyle === 'chain' ? 'chain' : 'plate');
    if (template) character.attachGear(slotName, itemId, template);
    if (!template && override) character.applySkinnedArmorTransform(slotName, override);
  }
}

async function loadPreviewGearSmart(
  core: typeof import('@babylonjs/core'),
  scene: import('@babylonjs/core').Scene,
  character: CharacterEntity,
  slotName: string,
  itemId: number,
  def: GearDef,
  bodyHideStyle: 'plate' | 'chain',
): Promise<GearTemplate | null> {
  const slash = def.file.lastIndexOf('/');
  const result = await core.SceneLoader.ImportMeshAsync('', def.file.slice(0, slash + 1), def.file.slice(slash + 1), scene);
  const skinnedSlot = slotName === 'body' || slotName === 'legs' || slotName === 'hands' || slotName === 'feet';

  if (result.skeletons.length === 0 && skinnedSlot) {
    const ok = await character.attachManualSkinnedArmor(slotName, def.file, result.meshes, itemId, bodyHideStyle);
    if (ok) {
      result.meshes.find((mesh) => mesh.name === '__root__')?.dispose();
      return null;
    }
  }

  if (result.skeletons.length > 0) {
    for (const mesh of result.meshes) {
      convertPbrToFlat(core, scene, mesh);
    }

    if (slotName === 'head') {
      const armorSkel = result.skeletons[0];
      const headBone = armorSkel.bones.find((bone) => bone.name === 'mixamorig:Head');
      let headBindY = 0;
      const headNode = headBone?.getTransformNode();
      if (headNode) {
        headNode.computeWorldMatrix(true);
        headBindY = headNode.absolutePosition.y;
      }
      for (const skeleton of result.skeletons) skeleton.dispose();
      for (const mesh of result.meshes) mesh.skeleton = null;
      const template = buildPreviewGearTemplateFromResult(core, scene, result, {
        ...def,
        boneName: 'mixamorig:Head',
        centerOrigin: true,
      });
      for (const child of template.template.getChildren()) {
        (child as import('@babylonjs/core').TransformNode).position.y -= headBindY;
      }
      return template;
    }

    character.detachGear(slotName);
    character.attachSkinnedArmor(slotName, result.meshes, result.skeletons[0], itemId, bodyHideStyle);
    result.meshes.find((mesh) => mesh.name === '__root__')?.dispose();
    return null;
  }

  return buildPreviewGearTemplateFromResult(core, scene, result, def);
}

function convertPbrToFlat(
  core: typeof import('@babylonjs/core'),
  scene: import('@babylonjs/core').Scene,
  mesh: import('@babylonjs/core').AbstractMesh,
): void {
  const pbr = mesh.material as any;
  if (!pbr || pbr.getClassName?.() !== 'PBRMaterial') return;
  const flat = new core.StandardMaterial(`${pbr.name}_flat`, scene);
  const hasTexture = !!pbr.albedoTexture;
  if (hasTexture) {
    flat.diffuseTexture = pbr.albedoTexture;
    pbr.albedoTexture.updateSamplingMode(core.Texture.NEAREST_SAMPLINGMODE);
  }
  if (pbr.albedoColor && !hasTexture) {
    const b = 1.3;
    flat.diffuseColor = new core.Color3(
      Math.min(1, pbr.albedoColor.r * b),
      Math.min(1, pbr.albedoColor.g * b),
      Math.min(1, pbr.albedoColor.b * b),
    );
  }
  flat.specularColor = core.Color3.Black();
  if (!hasTexture) {
    const dc = flat.diffuseColor;
    flat.emissiveColor = new core.Color3(dc.r * 0.55, dc.g * 0.55, dc.b * 0.55);
  }
  flat.backFaceCulling = pbr.backFaceCulling ?? true;
  mesh.material = flat;
}

function buildPreviewGearTemplateFromResult(
  core: typeof import('@babylonjs/core'),
  scene: import('@babylonjs/core').Scene,
  result: { meshes: import('@babylonjs/core').AbstractMesh[] },
  def: GearDef,
): GearTemplate {
  const root = new core.TransformNode(`gearTemplate_${def.itemId}`, scene);
  for (const mesh of result.meshes) {
    if (!mesh.parent || mesh.parent.name === '__root__') mesh.parent = root;
    convertPbrToFlat(core, scene, mesh);
  }

  if (def.metalColor) {
    const [r, g, b] = def.metalColor;
    const tint = new core.Color3(r, g, b);
    for (const mesh of result.meshes) {
      const mat = mesh.material as any;
      if (!mat?.name?.includes('Material.002')) continue;
      const cloned = mat.clone(`${mat.name}_tint_${def.itemId}`);
      if (!cloned) continue;
      if ('albedoColor' in cloned) cloned.albedoColor = tint;
      if ('diffuseColor' in cloned) cloned.diffuseColor = tint;
      mesh.material = cloned;
    }
  }

  if (!def.centerOrigin) {
    let minY = Infinity;
    for (const mesh of result.meshes) {
      if (mesh.getTotalVertices() === 0) continue;
      mesh.computeWorldMatrix(true);
      minY = Math.min(minY, mesh.getBoundingInfo().boundingBox.minimumWorld.y);
    }
    for (const child of root.getChildren()) {
      (child as import('@babylonjs/core').TransformNode).position.y -= minY;
    }
  }

  root.setEnabled(false);
  return {
    template: root,
    boneName: def.boneName,
    localPosition: def.localPosition ? new core.Vector3(def.localPosition.x, def.localPosition.y, def.localPosition.z) : core.Vector3.Zero(),
    localRotation: def.localRotation ? new core.Vector3(def.localRotation.x, def.localRotation.y, def.localRotation.z) : core.Vector3.Zero(),
    scale: def.scale ?? 1,
    headRenderMode: def.headRenderMode,
  };
}

export function MonsterPreview({ npcId, name, visual }: MonsterPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const config = npcId == null ? null : MONSTER_PREVIEWS[npcId] ?? null;
  const humanoidVisual = visual?.appearance
    ? visual
    : npcId != null && NPC_CUSTOMIZABLE_PROFILE[npcId]
      ? DEFAULT_HUMANOID_VISUAL
      : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || (!config && !humanoidVisual)) {
      setImageUrl('');
      return;
    }
    const targetCanvas = canvas;
    const previewConfig = config;
    const previewVisual = humanoidVisual;

    let cancelled = false;

    async function renderPreview() {
      const core = await import('@babylonjs/core');
      await import('@babylonjs/loaders/glTF');
      if (cancelled) return;

      const engine = new core.Engine(targetCanvas, true, {
        antialias: true,
        preserveDrawingBuffer: true,
        stencil: false,
      });
      targetCanvas.width = 260;
      targetCanvas.height = 260;
      engine.setHardwareScalingLevel(1);
      engine.resize();
      const scene = new core.Scene(engine);
      scene.clearColor = new core.Color4(0, 0, 0, 0);

      const camera = new core.ArcRotateCamera(
        'monster-preview-camera',
        previewConfig?.cameraYaw ?? -Math.PI / 4,
        previewConfig?.pitch ?? Math.PI / 2.65,
        previewConfig?.radius ?? 2.7,
        new core.Vector3(0, previewConfig?.targetY ?? 0.35, 0),
        scene,
      );
      camera.inputs.clear();

      const hemi = new core.HemisphericLight('monster-preview-hemi', new core.Vector3(-0.4, 1, 0.35), scene);
      hemi.intensity = 1.25;
      const fill = new core.DirectionalLight('monster-preview-fill', new core.Vector3(0.65, -1, -0.45), scene);
      fill.intensity = 0.55;

      try {
        if (previewVisual) {
          const authoredAppearance = previewVisual.appearance ?? null;
          const appearance = authoredAppearance ?? DEFAULT_APPEARANCE;
          const character = new CharacterEntity(scene, {
            name,
            modelPath: getCharacterModelPath(appearance),
            targetHeight: CHARACTER_TARGET_HEIGHT,
            additionalAnimations: [{ name: 'idle', path: CHARACTER_IDLE_ANIM }],
          });
          await character.whenReady();
          if (cancelled) {
            scene.dispose();
            engine.dispose();
            return;
          }
          if (authoredAppearance) character.applyAppearance(authoredAppearance, previewVisual.customColors);
          await applyExactEquipment(core, scene, character, appearance, previewVisual.equipment);
          const characterRoot = character.getRoot();
          if (characterRoot) {
            characterRoot.rotation.y = Math.PI * 0.58;
            characterRoot.computeWorldMatrix(true);
          }
          await scene.whenReadyAsync();
          await renderSettledFrames(scene, 18);
          const bounds = getSceneBounds(core, scene);
          if (bounds) {
            camera.target = bounds.center.clone();
            camera.target.y -= bounds.size.y * 0.06;
            camera.radius = Math.max(1.45, bounds.size.y * 1.12, bounds.size.x * 2.05, bounds.size.z * 2.05);
          } else {
            camera.target = new core.Vector3(0, 0.76, 0);
            camera.radius = 1.9;
          }
          camera.beta = Math.PI / 2.55;
          await renderSettledFrames(scene, 4);
          if (!cancelled) setImageUrl(targetCanvas.toDataURL('image/png'));
          character.dispose();
          return;
        }
        if (!previewConfig) return;
        const staticConfig = previewConfig;
        const slash = staticConfig.file.lastIndexOf('/');
        const rootUrl = staticConfig.file.slice(0, slash + 1);
        const fileName = staticConfig.file.slice(slash + 1);
        const result = await core.SceneLoader.ImportMeshAsync('', rootUrl, fileName, scene);
        if (cancelled) {
          scene.dispose();
          engine.dispose();
          return;
        }

        const cloned = new Map<unknown, unknown>();
        for (const mesh of result.meshes) {
          const material = mesh.material as any;
          if (!material) continue;
          let nextMaterial = cloned.get(material) as any;
          if (!nextMaterial) {
            nextMaterial = material.clone(`${material.name}_preview`);
            cloned.set(material, nextMaterial);
          }
          mesh.material = nextMaterial;
          if (nextMaterial.getClassName?.() === 'PBRMaterial') {
            nextMaterial.roughness = 1;
            nextMaterial.metallic = 0;
            nextMaterial.environmentIntensity = 0;
            nextMaterial.specularIntensity = 0;
          }
          const override = staticConfig.materialColors?.[material.name] ?? staticConfig.materialColors?.[material.name.replace(/\.\d+$/, '')];
          if (override) {
            const [r, g, b] = override;
            if ('albedoColor' in nextMaterial) nextMaterial.albedoColor = new core.Color3(r, g, b);
            else if ('diffuseColor' in nextMaterial) nextMaterial.diffuseColor = new core.Color3(r, g, b);
          }
        }

        const glbRoot = result.meshes[0] ?? null;
        const previewRoot = new core.TransformNode('monster-preview-root', scene);
        if (glbRoot) glbRoot.parent = previewRoot;

        const meshes = result.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
        const min = new core.Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
        const max = new core.Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
        for (const mesh of meshes) {
          mesh.computeWorldMatrix(true);
          const bounds = mesh.getHierarchyBoundingVectors(true);
          min.minimizeInPlace(bounds.min);
          max.maximizeInPlace(bounds.max);
        }
        const center = min.add(max).scale(0.5);
        const size = max.subtract(min);
        if (glbRoot) {
          glbRoot.position.subtractInPlace(center);
        } else {
          for (const mesh of result.meshes) mesh.position.subtractInPlace(center);
        }
        previewRoot.rotation.y = staticConfig.modelYaw ?? Math.PI * 0.58;
        previewRoot.scaling.setAll(staticConfig.scale ?? 1);
        previewRoot.computeWorldMatrix(true);

        const maxSize = Math.max(size.x, size.y, size.z, 0.001) * (staticConfig.scale ?? 1);
        camera.radius = Math.max(0.9, maxSize * 1.35);
        camera.target = new core.Vector3(0, 0, 0);
        await scene.whenReadyAsync();
        for (let i = 0; i < 4; i++) scene.render();
        if (isCanvasBlank(targetCanvas)) {
          createFallbackMonsterSilhouette(core, scene, staticConfig.modelYaw ?? Math.PI * 0.58);
          for (const mesh of result.meshes) mesh.setEnabled(false);
          scene.render();
        }
        if (!cancelled) setImageUrl(targetCanvas.toDataURL('image/png'));
      } catch (error) {
        console.warn('[hiscores] monster preview failed to render', error);
        if (!cancelled) setImageUrl('');
      } finally {
        scene.dispose();
        engine.dispose();
      }
    }

    void renderPreview();

    return () => {
      cancelled = true;
    };
  }, [config, humanoidVisual, name]);

  if (!config && !humanoidVisual) {
    return (
      <div className="monster-preview unavailable" aria-hidden="true">
        <span>Preview unavailable</span>
      </div>
    );
  }

  return (
    <div className="monster-preview">
      <canvas ref={canvasRef} className="monster-preview-canvas" aria-hidden="true" />
      {imageUrl ? <img className="monster-preview-image" src={imageUrl} alt={`${name} preview`} /> : null}
    </div>
  );
}
