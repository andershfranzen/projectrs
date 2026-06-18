import { Scene } from '@babylonjs/core/scene';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Material } from '@babylonjs/core/Materials/material';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import type { Observer } from '@babylonjs/core/Misc/observable';
import type { WorldObjectDef } from '@projectrs/shared';
import { worldAABB } from './MeshBounds';
import {
  type FishingSpotEffectResources,
  createFishingSpotEffectPlane,
  createFishingSpotEffectResources,
  createFishingSpotWaterDarkeningPlane,
  isFishingSpotEffectAssetId,
  updateFishingSpotEffectTexture,
} from './FishingSpotEffect';

interface ModelTemplate {
  template: TransformNode;
  scale: number;
  alphaBlend?: boolean;
  animationGroups?: AnimationGroup[];
}

const TREE_MODEL_CONFIG: { defId: number; files: string[]; targetHeight: number; stumpFile: string }[] = [
  { defId: 1, files: ['sTree_1.glb', 'sTree_2.glb', 'stree_3.glb', 'sTree4.glb', 'stree_autumn.glb'], targetHeight: 3.45, stumpFile: 'stump1.glb' },
  { defId: 2, files: ['/assets/models/oaktree.glb', 'oaktree2.glb'], targetHeight: 4.3, stumpFile: 'oakstump.glb' },
  { defId: 9, files: ['willow_tree.glb'], targetHeight: 4.6, stumpFile: 'willowstump.glb' },
  { defId: 10, files: ['DeadTreeLam.glb'], targetHeight: 2.875, stumpFile: 'stump2.glb' },
  { defId: 14, files: ['/assets/models/maple tree.glb'], targetHeight: 4.6, stumpFile: 'maplestump.glb' },
  { defId: 38, files: ['/assets/models/yew tree.glb'], targetHeight: 4.6, stumpFile: 'maplestump.glb' },
];

export class WorldObjectModels {
  private scene: Scene;
  private getHeight: (x: number, z: number) => number;
  private objectDefsCache: Map<number, WorldObjectDef>;

  private treeModels: Map<number, ModelTemplate> = new Map();
  private treeModelVariants: Map<number, ModelTemplate[]> = new Map();
  private stumpModels: Map<number, ModelTemplate> = new Map();
  private stumpModelsByName: Map<string, ModelTemplate> = new Map();
  private depletedRockModel: ModelTemplate | null = null;
  private depletedRockModelsByFile: Map<string, ModelTemplate> = new Map();
  private depletedRockModelsByAsset: Map<string, ModelTemplate> = new Map();
  private activeAssetModels: Map<string, ModelTemplate> = new Map();
  private activeAnimationGroupsByObjectId: Map<number, AnimationGroup[]> = new Map();
  private activeMaterialClonesByObjectId: Map<number, Material[]> = new Map();
  /** Pre-loaded depleted-state templates keyed by depletedAssetId from the
   *  object def. Multiple object defs can share one depleted GLB. */
  private depletedAssetModels: Map<string, ModelTemplate> = new Map();

  private stumps: Map<number, TransformNode> = new Map();
  private fishingSpotEffectRoots: Map<number, TransformNode> = new Map();
  private fishingSpotEffectResources: FishingSpotEffectResources | null = null;
  private fishingSpotEffectObserver: Observer<Scene> | null = null;

  constructor(scene: Scene, getHeight: (x: number, z: number) => number, objectDefsCache: Map<number, WorldObjectDef>) {
    this.scene = scene;
    this.getHeight = getHeight;
    this.objectDefsCache = objectDefsCache;
  }

  hasTreeModel(defId: number): boolean {
    return this.treeModels.has(defId);
  }

  getStump(objectEntityId: number): TransformNode | undefined {
    return this.stumps.get(objectEntityId);
  }

  hasStump(objectEntityId: number): boolean {
    return this.stumps.has(objectEntityId);
  }

  deleteStump(objectEntityId: number): void {
    const stump = this.stumps.get(objectEntityId);
    if (stump) {
      stump.dispose();
      this.stumps.delete(objectEntityId);
    }
  }

  async loadAll(): Promise<void> {
    await Promise.all([
      this.loadTreeModels(),
      this.loadDepletedRockModel(),
      this.loadDepletedAssetModels(),
      this.loadActiveAssetModels(),
    ]);
  }

  /** Runtime-spawned objects, keyed by WorldObjectDef.modelAssetId. */
  private static readonly ACTIVE_ASSET_FILES: Record<string, { rootUrl: string; file: string; alphaBlend?: boolean }> = {
    fire: { rootUrl: '/assets/models/', file: 'fire.glb', alphaBlend: true },
    CrabPot: { rootUrl: '/assets/models/', file: 'CrabPot.glb' },
    CrabPotFishingSpot: { rootUrl: '/assets/models/', file: 'CrabPot.glb' },
    SuperiorCrabPotFishingSpot: { rootUrl: '/assets/models/', file: 'CrabPot.glb' },
  };

  /** Map a `depletedAssetId` (e.g. "open tier 1 chest") to a GLB file to
   *  pre-load. Add entries here for any object that swaps to a model while
   *  depleted. */
  private static readonly DEPLETED_ASSET_FILES: Record<string, { rootUrl: string; file: string }> = {
    'open tier 1 chest': { rootUrl: '/models/', file: 'OpenChest.glb' },
    'open tier 2 chest': { rootUrl: '/models/', file: 'OpenTier2Chest.glb' },
    'open tier 3 chest': { rootUrl: '/models/', file: 'OpenTier3Chest.glb' },
    'open tier 4 chest': { rootUrl: '/models/', file: 'OpenTier4Chest.glb' },
    'open tier 5 chest': { rootUrl: '/models/', file: 'OpenTier5Chest.glb' },
    'open tier 6 chest': { rootUrl: '/models/', file: 'OpenTier6Chest.glb' },
    'depleted stall': { rootUrl: '/assets/models/', file: 'depleted stall.glb' },
  };

  private static readonly DEPLETED_ROCK_ASSET_FILES: Record<string, string> = {
    CopperRock: 'depleted_rock.glb',
    IronRock: 'depleted_rock.glb',
    TinRock: 'depleted_rock.glb',
    CoalRock: 'depleted_rock.glb',
    MithrilRock: 'depleted_rock.glb',
    SilverRock: 'depleted_rock.glb',
    CopperRock2: 'DepletedRock2.glb',
    IronRock2: 'DepletedRock2.glb',
    TinRock2: 'DepletedRock2.glb',
    CoalRock2: 'DepletedRock2.glb',
    MithrilRock2: 'DepletedRock2.glb',
    SilverRock2: 'DepletedRock2.glb',
    ClayRock2: 'DepletedRock2.glb',
    SulphurRock: 'SulphurRockDepleted.glb',
    CopperRock3: 'DepletedRock3.glb',
    IronRock3: 'DepletedRock3.glb',
    TinRock3: 'DepletedRock3.glb',
    CoalRock3: 'DepletedRock3.glb',
    MithrilRock3: 'DepletedRock3.glb',
    SilverRock3: 'DepletedRock3.glb',
    ClayRock3: 'DepletedRock3.glb',
  };

  private static prepareMaterial(mat: unknown, alphaBlend: boolean): void {
    if (!mat || typeof mat !== 'object') return;
    const material = mat as Material & { needDepthPrePass?: boolean };
    material.backFaceCulling = false;
    if (alphaBlend) {
      if (WorldObjectModels.materialUsesAlpha(material)) {
        if (material.transparencyMode !== undefined) material.transparencyMode = Material.MATERIAL_ALPHABLEND;
        if (material.needDepthPrePass !== undefined) material.needDepthPrePass = false;
      } else {
        if (material.transparencyMode !== undefined) material.transparencyMode = Material.MATERIAL_OPAQUE;
        material.alpha = 1;
        if (material.needDepthPrePass !== undefined) material.needDepthPrePass = false;
      }
    } else if (material.transparencyMode !== undefined) {
      material.transparencyMode = Material.MATERIAL_ALPHATEST;
      material.alpha = 1;
    }
  }

  private static materialUsesAlpha(material: Material): boolean {
    const source = material as Material & {
      needAlphaBlending?: () => boolean;
      albedoTexture?: { hasAlpha?: boolean };
      diffuseTexture?: { hasAlpha?: boolean };
      opacityTexture?: { hasAlpha?: boolean };
    };
    if (typeof source.needAlphaBlending === 'function' && source.needAlphaBlending()) return true;
    if (typeof source.alpha === 'number' && source.alpha < 0.999) return true;
    return source.albedoTexture?.hasAlpha === true
      || source.diffuseTexture?.hasAlpha === true
      || source.opacityTexture?.hasAlpha === true;
  }

  private cloneActiveMaterial(
    material: Material | null,
    clones: Map<Material, Material>,
    objectEntityId: number,
    alphaBlend: boolean,
  ): Material | null {
    if (!material) return null;
    let cloned = clones.get(material);
    if (!cloned) {
      const newClone = material.clone(`${material.name || 'material'}_active_${objectEntityId}`);
      if (!newClone) {
        WorldObjectModels.prepareMaterial(material, alphaBlend);
        return material;
      }
      cloned = newClone;
      WorldObjectModels.prepareMaterial(cloned, alphaBlend);
      clones.set(material, cloned);
    }
    return cloned;
  }

  private async loadModelTemplate(rootUrl: string, file: string, templateName: string, alphaBlend: boolean = false): Promise<ModelTemplate> {
    const result = await SceneLoader.ImportMeshAsync('', rootUrl, file, this.scene);
    const bb = worldAABB(result.meshes);
    const centerX = (bb.minX + bb.maxX) / 2;
    const centerZ = (bb.minZ + bb.maxZ) / 2;
    const root = new TransformNode(templateName, this.scene);
    const animationGroups = result.animationGroups.length > 0 ? result.animationGroups : undefined;
    for (const mesh of result.meshes) {
      WorldObjectModels.prepareMaterial(mesh.material, alphaBlend);
    }
    if (animationGroups) {
      const offsetRoot = new TransformNode(`${templateName}_offset`, this.scene);
      offsetRoot.parent = root;
      offsetRoot.position.set(-centerX, -bb.minY, -centerZ);
      const topLevelNodes = new Set<TransformNode>();
      for (const mesh of result.meshes) {
        if (!mesh.parent) topLevelNodes.add(mesh);
      }
      for (const node of result.transformNodes) {
        if (!node.parent) topLevelNodes.add(node);
      }
      for (const node of topLevelNodes) node.parent = offsetRoot;
      for (const group of animationGroups) {
        group.stop();
        group.reset();
      }
    } else {
      for (const mesh of result.meshes) {
        if (!mesh.parent) mesh.parent = root;
      }
      for (const child of root.getChildren()) {
        const c = child as TransformNode;
        c.position.x -= centerX;
        c.position.y -= bb.minY;
        c.position.z -= centerZ;
      }
    }
    root.setEnabled(false);
    return { template: root, scale: 1, alphaBlend, animationGroups };
  }

  private async loadActiveAssetModels(): Promise<void> {
    const templatePromises = new Map<string, Promise<ModelTemplate>>();
    await Promise.all(Object.entries(WorldObjectModels.ACTIVE_ASSET_FILES).map(async ([assetId, cfg]) => {
      try {
        const key = `${cfg.rootUrl}\0${cfg.file}\0${cfg.alphaBlend === true ? 'alpha' : 'opaque'}`;
        let promise = templatePromises.get(key);
        if (!promise) {
          promise = this.loadModelTemplate(cfg.rootUrl, cfg.file, `activeTemplate_${assetId}`, cfg.alphaBlend === true);
          templatePromises.set(key, promise);
        }
        this.activeAssetModels.set(assetId, await promise);
      } catch (e) {
        console.warn(`[WorldObjectModels] Failed to load active model '${cfg.file}':`, e);
      }
    }));
  }

  private async loadDepletedAssetModels(): Promise<void> {
    // Iterate the static asset→file map rather than objectDefsCache: loadAll()
    // is called from the GameManager constructor before /data/objects.json
    // is fetched, so the defs cache is empty at this point. Every entry
    // here gets pre-loaded; object defs reference them via depletedAssetId.
    await Promise.all(Object.entries(WorldObjectModels.DEPLETED_ASSET_FILES).map(async ([assetId, cfg]) => {
      try {
        this.depletedAssetModels.set(assetId, await this.loadModelTemplate(cfg.rootUrl, cfg.file, `depletedTemplate_${assetId}`));
      } catch (e) {
        console.warn(`[WorldObjectModels] Failed to load depleted model '${cfg.file}':`, e);
      }
    }));
  }

  private async loadTreeModels(): Promise<void> {
    const loads = TREE_MODEL_CONFIG.map(async (cfg) => {
      const templates: ModelTemplate[] = [];
      for (const file of cfg.files) {
        try {
          const rootUrl = file.startsWith('/') ? '/' : '/models/';
          const sceneFilename = file.startsWith('/') ? file.slice(1) : file;
          const result = await SceneLoader.ImportMeshAsync('', rootUrl, sceneFilename, this.scene);
          const bb = worldAABB(result.meshes);
          const modelHeight = bb.maxY - bb.minY;
          const scale = modelHeight > 0 ? cfg.targetHeight / modelHeight : 1;
          const root = new TransformNode(`treeTemplate_${cfg.defId}_${file}`, this.scene);
          for (const mesh of result.meshes) {
            if (!mesh.parent) mesh.parent = root;
          }
          for (const child of root.getChildren()) {
            (child as TransformNode).position.y -= bb.minY;
          }
          root.setEnabled(false);
          templates.push({ template: root, scale });
        } catch (e) {
          console.warn(`Failed to load tree model '${file}':`, e);
        }
      }
      if (templates.length > 0) {
        this.treeModels.set(cfg.defId, templates[0]);
        this.treeModelVariants.set(cfg.defId, templates);
      }
    });

    await Promise.all(loads);

    const uniqueStumps = [...new Set(TREE_MODEL_CONFIG.map(c => c.stumpFile))];
    const stumpLoads = uniqueStumps.map(async (stumpFile) => {
      try {
        const result = await SceneLoader.ImportMeshAsync('', '/models/', stumpFile, this.scene);
        const bb = worldAABB(result.meshes);
        const root = new TransformNode(`stumpTemplate_${stumpFile}`, this.scene);
        for (const mesh of result.meshes) {
          if (!mesh.parent) mesh.parent = root;
        }
        for (const child of root.getChildren()) {
          (child as TransformNode).position.y -= bb.minY;
        }
        root.setEnabled(false);
        this.stumpModelsByName.set(stumpFile, { template: root, scale: 1 });
      } catch (e) {
        console.warn(`Failed to load stump model '${stumpFile}':`, e);
      }
    });
    await Promise.all(stumpLoads);

    for (const cfg of TREE_MODEL_CONFIG) {
      const stump = this.stumpModelsByName.get(cfg.stumpFile);
      if (stump) this.stumpModels.set(cfg.defId, stump);
    }
  }

  private async loadDepletedRockModel(): Promise<void> {
    const uniqueFiles = new Set(Object.values(WorldObjectModels.DEPLETED_ROCK_ASSET_FILES));
    await Promise.all([...uniqueFiles].map(async (file) => {
      try {
        const model = await this.loadModelTemplate('/assets/models/', file, `depletedRockTemplate_${file}`);
        this.depletedRockModelsByFile.set(file, model);
        if (file === 'depleted_rock.glb') this.depletedRockModel = model;
      } catch (e) {
        console.warn(`[WorldObjectModels] Failed to load depleted rock model '${file}':`, e);
      }
    }));

    for (const [assetId, file] of Object.entries(WorldObjectModels.DEPLETED_ROCK_ASSET_FILES)) {
      const model = this.depletedRockModelsByFile.get(file);
      if (model) this.depletedRockModelsByAsset.set(assetId, model);
    }
  }

  createTreeModel(objectEntityId: number, objectDefId: number, x: number, z: number, isDepleted: boolean): TransformNode | null {
    const variants = this.treeModelVariants.get(objectDefId);
    const model = variants ? variants[objectEntityId % variants.length] : this.treeModels.get(objectDefId);
    if (!model) return null;

    const clone = model.template.instantiateHierarchy(null, undefined, (source, cloned) => {
      cloned.name = source.name + `_${objectEntityId}`;
    })!;
    clone.setEnabled(!isDepleted);
    for (const child of clone.getChildMeshes()) {
      child.setEnabled(true);
      child.metadata = { objectEntityId };
      const mat = child.material as any;
      if (mat) {
        if (mat.transparencyMode !== undefined) mat.transparencyMode = 1;
        mat.alpha = 1;
      }
    }
    const s = model.scale;
    clone.scaling.set(s, s, s);
    const cx = Math.floor(x) + 0.5;
    const cz = Math.floor(z) + 0.5;
    const terrainY = this.getHeight(cx, cz);
    clone.position.set(cx, terrainY, cz);

    const stumpModel = this.stumpModels.get(objectDefId);
    if (stumpModel) {
      const stump = stumpModel.template.instantiateHierarchy(null, undefined, (source, cloned) => {
        cloned.name = source.name + `_stump_${objectEntityId}`;
      })!;
      stump.setEnabled(isDepleted);
      for (const child of stump.getChildMeshes()) {
        child.setEnabled(true);
        const mat = child.material as any;
        if (mat) {
          if (mat.transparencyMode !== undefined) mat.transparencyMode = 1;
          mat.alpha = 1;
        }
      }
      const ss = stumpModel.scale;
      stump.scaling.set(ss, ss, ss);
      stump.position.set(cx, terrainY, cz);
      this.stumps.set(objectEntityId, stump);
    }

    return clone;
  }

  createActiveModel(
    objectEntityId: number,
    def: WorldObjectDef,
    x: number,
    z: number,
    y: number | undefined,
    rotY: number,
    isDepleted: boolean,
  ): TransformNode | null {
    const assetId = def.modelAssetId;
    if (!assetId) return null;
    if (isFishingSpotEffectAssetId(assetId)) {
      return this.createFishingSpotEffectModel(objectEntityId, assetId, x, z, y, rotY, isDepleted);
    }
    const model = this.activeAssetModels.get(assetId);
    if (!model) return null;
    this.deleteActiveModelAnimations(objectEntityId);
    const sourceToClone = new Map<unknown, unknown>();
    const materialClones = new Map<Material, Material>();
    const clone = model.template.instantiateHierarchy(null, undefined, (source, cloned) => {
      cloned.name = source.name + `_active_${objectEntityId}`;
      sourceToClone.set(source, cloned);
    });
    if (!clone) return null;
    clone.setEnabled(!isDepleted);
    clone.rotationQuaternion = null;
    clone.rotation.y = rotY;
    for (const child of clone.getChildMeshes()) {
      child.setEnabled(true);
      child.metadata = { ...(child.metadata ?? {}), objectEntityId };
      child.material = this.cloneActiveMaterial(child.material, materialClones, objectEntityId, model.alphaBlend === true);
    }
    for (const sourceMesh of model.template.getChildMeshes(false)) {
      const clonedMesh = sourceToClone.get(sourceMesh) as { skeleton?: { bones: any[] } } | undefined;
      if (!clonedMesh?.skeleton || !sourceMesh.skeleton) continue;
      sourceMesh.skeleton.bones.forEach((sourceBone, boneIndex) => {
        const clonedBone = clonedMesh.skeleton?.bones[boneIndex]
          ?? clonedMesh.skeleton?.bones.find((bone: any) => bone.name === sourceBone.name);
        if (!clonedBone) return;
        sourceToClone.set(sourceBone, clonedBone);
        const sourceNode = sourceBone.getTransformNode?.();
        const clonedNode = sourceNode ? sourceToClone.get(sourceNode) : undefined;
        if (clonedNode && typeof clonedBone.linkTransformNode === 'function') {
          clonedBone.linkTransformNode(clonedNode);
        }
      });
    }
    if (materialClones.size > 0) this.activeMaterialClonesByObjectId.set(objectEntityId, [...new Set(materialClones.values())]);
    const s = model.scale;
    clone.scaling.set(s, s, s);
    clone.position.set(x, y ?? this.getHeight(x, z), z);
    clone.metadata = { ...(clone.metadata ?? {}), objectEntityId, assetId, runtimeWorldObject: true };
    this.startActiveModelAnimations(objectEntityId, model, sourceToClone, !isDepleted);
    return clone;
  }

  private createFishingSpotEffectModel(
    objectEntityId: number,
    assetId: string,
    x: number,
    z: number,
    y: number | undefined,
    rotY: number,
    isDepleted: boolean,
  ): TransformNode {
    this.deleteActiveModelAnimations(objectEntityId);
    const root = new TransformNode(`activeFishingSpotEffect_${objectEntityId}`, this.scene);
    root.setEnabled(!isDepleted);
    root.rotationQuaternion = null;
    root.rotation.y = rotY;
    root.position.set(x, y ?? this.getHeight(x, z), z);
    root.metadata = { objectEntityId, assetId, runtimeWorldObject: true };

    const { material, waterMaterial } = this.getFishingSpotEffectResources();
    const water = createFishingSpotWaterDarkeningPlane(this.scene, `activeFishingSpotWaterDarkening_${objectEntityId}`, waterMaterial);
    water.parent = root;
    water.metadata = { ...(water.metadata ?? {}), objectEntityId, assetId };
    const mesh = createFishingSpotEffectPlane(this.scene, `activeFishingSpotEffectPlane_${objectEntityId}`, material);
    mesh.parent = root;
    mesh.metadata = { ...(mesh.metadata ?? {}), objectEntityId, assetId };

    this.fishingSpotEffectRoots.set(objectEntityId, root);
    this.ensureFishingSpotEffectLoop();
    return root;
  }

  private getFishingSpotEffectResources(): FishingSpotEffectResources {
    if (!this.fishingSpotEffectResources) {
      this.fishingSpotEffectResources = createFishingSpotEffectResources(this.scene, 'activeFishingSpotEffect');
    }
    return this.fishingSpotEffectResources;
  }

  private ensureFishingSpotEffectLoop(): void {
    if (this.fishingSpotEffectObserver) return;
    this.fishingSpotEffectObserver = this.scene.onBeforeRenderObservable.add(() => {
      const resources = this.fishingSpotEffectResources;
      if (resources) updateFishingSpotEffectTexture(resources, performance.now() * 0.001);
      for (const [objectEntityId, root] of this.fishingSpotEffectRoots) {
        if (root.isDisposed()) this.fishingSpotEffectRoots.delete(objectEntityId);
      }
      this.stopFishingSpotEffectLoopIfIdle();
    });
  }

  private stopFishingSpotEffectLoopIfIdle(): void {
    if (this.fishingSpotEffectRoots.size > 0 || !this.fishingSpotEffectObserver) return;
    this.scene.onBeforeRenderObservable.remove(this.fishingSpotEffectObserver);
    this.fishingSpotEffectObserver = null;
  }

  private startActiveModelAnimations(
    objectEntityId: number,
    model: ModelTemplate,
    sourceToClone: Map<unknown, unknown>,
    enabled: boolean,
  ): void {
    const templateGroups = model.animationGroups;
    if (!templateGroups || templateGroups.length === 0) return;
    const groups: AnimationGroup[] = [];
    for (const srcGroup of templateGroups) {
      const clonedGroup = srcGroup.clone(
        `${srcGroup.name}_active_${objectEntityId}`,
        target => sourceToClone.get(target) ?? null,
      );
      if (clonedGroup.targetedAnimations.length === 0) {
        clonedGroup.dispose();
        continue;
      }
      clonedGroup.stop();
      if (enabled) clonedGroup.play(true);
      groups.push(clonedGroup);
    }
    if (groups.length > 0) this.activeAnimationGroupsByObjectId.set(objectEntityId, groups);
  }

  deleteActiveModelAnimations(objectEntityId: number): void {
    if (this.fishingSpotEffectRoots.delete(objectEntityId)) {
      this.stopFishingSpotEffectLoopIfIdle();
    }
    const groups = this.activeAnimationGroupsByObjectId.get(objectEntityId);
    if (groups) {
      for (const group of groups) group.dispose();
      this.activeAnimationGroupsByObjectId.delete(objectEntityId);
    }
    const materials = this.activeMaterialClonesByObjectId.get(objectEntityId);
    if (materials) {
      for (const material of materials) material.dispose(false, false);
      this.activeMaterialClonesByObjectId.delete(objectEntityId);
    }
  }

  private static disposeModelTemplate(model: ModelTemplate): void {
    for (const group of model.animationGroups ?? []) group.dispose();
    model.template.dispose();
  }

  createDepletedModel(objectEntityId: number, defId: number, placedNode: TransformNode): TransformNode | undefined {
    const existing = this.stumps.get(objectEntityId);
    if (existing) {
      this.syncDepletedModelTransform(objectEntityId, placedNode);
      return existing;
    }
    const def = this.objectDefsCache.get(defId);
    let depletedModel: ModelTemplate | null = null;
    if (def?.category === 'tree') {
      depletedModel = this.stumpModels.get(defId) ?? null;
    } else if (def?.category === 'rock') {
      const assetId = typeof placedNode.metadata?.assetId === 'string' ? placedNode.metadata.assetId : undefined;
      depletedModel = (assetId ? this.depletedRockModelsByAsset.get(assetId) : null) ?? this.depletedRockModel;
    } else if (def?.depletedAssetId) {
      depletedModel = this.depletedAssetModels.get(def.depletedAssetId) ?? null;
    }
    if (!depletedModel) return undefined;
    const depleted = depletedModel.template.instantiateHierarchy(null, undefined, (source, cloned) => {
      cloned.name = source.name + `_depleted_${objectEntityId}`;
    })!;
    depleted.setEnabled(true);
    for (const child of depleted.getChildMeshes()) {
      child.setEnabled(true);
      const mat = child.material as any;
      if (mat && mat.transparencyMode !== undefined) mat.transparencyMode = 1;
    }
    this.copyDepletedTransform(depleted, placedNode);
    this.stumps.set(objectEntityId, depleted);
    return depleted;
  }

  syncDepletedModelTransform(objectEntityId: number, placedNode: TransformNode): void {
    const depleted = this.stumps.get(objectEntityId);
    if (!depleted) return;
    this.copyDepletedTransform(depleted, placedNode);
  }

  private copyDepletedTransform(
    depleted: TransformNode,
    placedNode: TransformNode,
  ): void {
    WorldObjectModels.copyNodeTransform(depleted, placedNode);
  }

  private static copyNodeTransform(target: TransformNode, source: TransformNode): void {
    const scaling = new Vector3();
    const rotation = new Quaternion();
    const position = new Vector3();
    // Placed object roots may have frozen world matrices. Copy the rendered
    // matrix, not mutable transform fields that can drift after freeze.
    source.computeWorldMatrix(false);
    source.getWorldMatrix().decompose(scaling, rotation, position);
    target.scaling.copyFrom(scaling);
    target.position.copyFrom(position);
    if (target.rotationQuaternion) target.rotationQuaternion.copyFrom(rotation);
    else target.rotationQuaternion = rotation;
    target.rotation.set(0, 0, 0);
  }

  disposeStumps(): void {
    for (const [, stump] of this.stumps) stump.dispose();
    this.stumps.clear();
  }

  dispose(): void {
    for (const [, groups] of this.activeAnimationGroupsByObjectId) {
      for (const group of groups) group.dispose();
    }
    this.activeAnimationGroupsByObjectId.clear();
    for (const [, materials] of this.activeMaterialClonesByObjectId) {
      for (const material of materials) material.dispose(false, false);
    }
    this.activeMaterialClonesByObjectId.clear();
    this.fishingSpotEffectRoots.clear();
    if (this.fishingSpotEffectObserver) {
      this.scene.onBeforeRenderObservable.remove(this.fishingSpotEffectObserver);
      this.fishingSpotEffectObserver = null;
    }
    if (this.fishingSpotEffectResources) {
      this.fishingSpotEffectResources.material.dispose(false, false);
      this.fishingSpotEffectResources.waterMaterial.dispose(false, false);
      this.fishingSpotEffectResources.baseTexture.dispose();
      this.fishingSpotEffectResources.mistTexture.dispose();
      this.fishingSpotEffectResources = null;
    }
    for (const [, m] of this.treeModels) WorldObjectModels.disposeModelTemplate(m);
    this.treeModels.clear();
    this.treeModelVariants.clear();
    for (const [, m] of this.stumpModels) WorldObjectModels.disposeModelTemplate(m);
    this.stumpModels.clear();
    this.stumpModelsByName.clear();
    for (const [, m] of this.depletedRockModelsByFile) WorldObjectModels.disposeModelTemplate(m);
    this.depletedRockModelsByFile.clear();
    this.depletedRockModelsByAsset.clear();
    this.depletedRockModel = null;
    for (const [, m] of this.depletedAssetModels) WorldObjectModels.disposeModelTemplate(m);
    this.depletedAssetModels.clear();
    for (const [, m] of this.activeAssetModels) WorldObjectModels.disposeModelTemplate(m);
    this.activeAssetModels.clear();
    this.disposeStumps();
  }
}
