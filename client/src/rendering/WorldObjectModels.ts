import { Scene } from '@babylonjs/core/scene';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { WorldObjectDef } from '@projectrs/shared';
import { worldAABB } from './MeshBounds';

interface ModelTemplate { template: TransformNode; scale: number; }

const TREE_MODEL_CONFIG: { defId: number; files: string[]; targetHeight: number; stumpFile: string }[] = [
  { defId: 1, files: ['sTree_1.glb', 'sTree_2.glb', 'stree_3.glb', 'sTree4.glb', 'stree_autumn.glb'], targetHeight: 3.45, stumpFile: 'stump1.glb' },
  { defId: 2, files: ['oaktree2.glb'], targetHeight: 4.3, stumpFile: 'oakstump.glb' },
  { defId: 9, files: ['willow_tree.glb'], targetHeight: 4.6, stumpFile: 'willowstump.glb' },
  { defId: 10, files: ['DeadTreeLam.glb'], targetHeight: 2.875, stumpFile: 'stump2.glb' },
  { defId: 14, files: ['/assets/models/maple tree.glb'], targetHeight: 4.6, stumpFile: 'maplestump.glb' },
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
  /** Pre-loaded depleted-state templates for chests, keyed by depletedAssetId
   *  from the object def. Multiple chest tiers can share the same open-chest
   *  asset without re-importing. */
  private chestDepletedModels: Map<string, ModelTemplate> = new Map();

  private stumps: Map<number, TransformNode> = new Map();

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
      this.loadChestDepletedModels(),
    ]);
  }

  /** Map an `depletedAssetId` (e.g. "open tier 1 chest") to the GLB file under
   *  /models/ to import. Add entries here when a new chest tier introduces
   *  a different open variant. */
  private static readonly DEPLETED_ASSET_FILES: Record<string, string> = {
    'open tier 1 chest': 'OpenChest.glb',
    'open tier 2 chest': 'OpenTier2Chest.glb',
    'open tier 3 chest': 'OpenTier3Chest.glb',
    'open tier 4 chest': 'OpenTier4Chest.glb',
    'open tier 5 chest': 'OpenTier5Chest.glb',
    'open tier 6 chest': 'OpenTier6Chest.glb',
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
    CopperRock3: 'DepletedRock3.glb',
    IronRock3: 'DepletedRock3.glb',
    TinRock3: 'DepletedRock3.glb',
    CoalRock3: 'DepletedRock3.glb',
    MithrilRock3: 'DepletedRock3.glb',
    SilverRock3: 'DepletedRock3.glb',
    ClayRock3: 'DepletedRock3.glb',
  };

  private async loadModelTemplate(rootUrl: string, file: string, templateName: string): Promise<ModelTemplate> {
    const result = await SceneLoader.ImportMeshAsync('', rootUrl, file, this.scene);
    const bb = worldAABB(result.meshes);
    const centerX = (bb.minX + bb.maxX) / 2;
    const centerZ = (bb.minZ + bb.maxZ) / 2;
    const root = new TransformNode(templateName, this.scene);
    for (const mesh of result.meshes) {
      if (!mesh.parent) mesh.parent = root;
    }
    for (const child of root.getChildren()) {
      const c = child as TransformNode;
      c.position.x -= centerX;
      c.position.y -= bb.minY;
      c.position.z -= centerZ;
    }
    root.setEnabled(false);
    return { template: root, scale: 1 };
  }

  private async loadChestDepletedModels(): Promise<void> {
    // Iterate the static asset→file map rather than objectDefsCache: loadAll()
    // is called from the GameManager constructor before /data/objects.json
    // is fetched, so the defs cache is empty at this point. Every entry
    // here gets pre-loaded; chest defs reference them via depletedAssetId.
    await Promise.all(Object.entries(WorldObjectModels.DEPLETED_ASSET_FILES).map(async ([assetId, file]) => {
      try {
        this.chestDepletedModels.set(assetId, await this.loadModelTemplate('/models/', file, `chestDepletedTemplate_${assetId}`));
      } catch (e) {
        console.warn(`[WorldObjectModels] Failed to load chest depleted model '${file}':`, e);
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

  createDepletedModel(objectEntityId: number, defId: number, placedNode: TransformNode): TransformNode | undefined {
    if (this.stumps.has(objectEntityId)) return this.stumps.get(objectEntityId)!;
    const def = this.objectDefsCache.get(defId);
    let depletedModel: ModelTemplate | null = null;
    if (def?.category === 'tree') {
      depletedModel = this.stumpModels.get(defId) ?? null;
    } else if (def?.category === 'rock') {
      const assetId = typeof placedNode.metadata?.assetId === 'string' ? placedNode.metadata.assetId : undefined;
      depletedModel = (assetId ? this.depletedRockModelsByAsset.get(assetId) : null) ?? this.depletedRockModel;
    } else if (def?.category === 'chest' && def.depletedAssetId) {
      depletedModel = this.chestDepletedModels.get(def.depletedAssetId) ?? null;
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
    depleted.scaling.copyFrom(placedNode.scaling);
    depleted.position.set(placedNode.position.x, placedNode.position.y, placedNode.position.z);
    if (placedNode.rotationQuaternion) {
      depleted.rotationQuaternion = placedNode.rotationQuaternion.clone();
      depleted.rotation.set(0, 0, 0);
    } else {
      depleted.rotationQuaternion = null;
      depleted.rotation.copyFrom(placedNode.rotation);
    }
    this.stumps.set(objectEntityId, depleted);
    return depleted;
  }

  disposeStumps(): void {
    for (const [, stump] of this.stumps) stump.dispose();
    this.stumps.clear();
  }

  dispose(): void {
    for (const [, m] of this.treeModels) m.template.dispose();
    this.treeModels.clear();
    this.treeModelVariants.clear();
    for (const [, m] of this.stumpModels) m.template.dispose();
    this.stumpModels.clear();
    this.stumpModelsByName.clear();
    for (const [, m] of this.depletedRockModelsByFile) m.template.dispose();
    this.depletedRockModelsByFile.clear();
    this.depletedRockModelsByAsset.clear();
    this.depletedRockModel = null;
    for (const [, m] of this.chestDepletedModels) m.template.dispose();
    this.chestDepletedModels.clear();
    this.disposeStumps();
  }
}
