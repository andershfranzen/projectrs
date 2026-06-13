import { Scene } from '@babylonjs/core/scene';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import type { Material } from '@babylonjs/core/Materials/material';
import type { AssetContainer, InstantiatedEntries } from '@babylonjs/core/assetContainer';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import '@babylonjs/loaders/glTF';
import { getObjectFootprintContinuousCenterCoord } from '../../../shared/objectFootprint';
import { normalizeNpcVisualScale } from '../../../shared/types';
import { quantizeAnimationGroup, rs2Rotation } from './AnimationQuantizer';
import { chatBubbleDuration, createChatBubbleElement, type ChatBubbleVariant } from './chatBubble';
import { mountWorldOverlayElement } from './worldOverlay';
import { createMobGroundShadow } from './MobGroundShadow';
import type { GearTemplate } from './CharacterEntity';

export interface Npc3DEntityOptions {
  label?: string;
  materialColors?: Record<string, [number, number, number]>;
  tileSize?: number;
  /** Visual-only scale multiplier layered on top of the model config scale. */
  visualScale?: number;
  originMode?: 'authored' | 'boundsCenter';
  /** World-space visual Y lift without changing gameplay/server position. */
  groundOffset?: number;
  /** Visual yaw offset for models whose authored forward axis differs from the game forward axis. */
  facingOffsetY?: number;
  /** Model-local X/Z origin trim in world units at visualScale=1, applied after
   *  bounds-centering and before the root scale/rotation. */
  originOffset?: { x?: number; z?: number };
  animSpeedRatio?: Partial<Record<'idle' | 'walk' | 'attack' | 'death', number>>;
  preserveAnimationRoles?: Array<'idle' | 'walk' | 'attack' | 'death'>;
}

type NpcAnimationRole = 'idle' | 'walk' | 'attack' | 'death';
type NpcAnimMap = { idle: string; walk?: string; attack?: string; death?: string };

interface NpcModelTemplate {
  container: AssetContainer;
}

interface NpcModelInstance {
  entries: InstantiatedEntries;
  rootNodes: TransformNode[];
  meshes: AbstractMesh[];
  skeletons: Skeleton[];
  animationGroups: AnimationGroup[];
}

const CACHE_BUST_TOKEN: string = (import.meta as any).env?.DEV ? `?v=${Date.now()}` : '';
const sceneNpcModelTemplates = new WeakMap<Scene, Map<string, Promise<NpcModelTemplate>>>();
const scenesWithNpcModelCacheCleanup = new WeakSet<Scene>();
let npcModelInstanceId = 0;

function devCacheBust(file: string): string {
  return CACHE_BUST_TOKEN ? `${file}${CACHE_BUST_TOKEN}` : file;
}

function normalizePositiveScale(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

async function loadAssetContainerWithSlowWarning(
  scene: Scene,
  dir: string,
  file: string,
  slowWarnMs: number = 20_000,
): Promise<AssetContainer> {
  let timer: number | null = null;
  try {
    const url = `${dir}${file}`;
    timer = window.setTimeout(() => {
      console.warn(`[loading] GLB asset container still loading after ${slowWarnMs}ms: ${url}`);
    }, slowWarnMs);
    return await SceneLoader.LoadAssetContainerAsync(dir, file, scene);
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

function npcModelTemplateCache(scene: Scene): Map<string, Promise<NpcModelTemplate>> {
  let cache = sceneNpcModelTemplates.get(scene);
  if (!cache) {
    cache = new Map();
    sceneNpcModelTemplates.set(scene, cache);
  }
  if (!scenesWithNpcModelCacheCleanup.has(scene)) {
    scenesWithNpcModelCacheCleanup.add(scene);
    scene.onDisposeObservable.addOnce(() => clearNpcModelTemplateCache(scene));
  }
  return cache;
}

function buildAnimationProfileKey(
  animMap: NpcAnimMap,
  preserveAnimationRoles: ReadonlySet<NpcAnimationRole>,
): string {
  const preserved = Array.from(preserveAnimationRoles).sort().join(',');
  return [
    animMap.idle,
    animMap.walk ?? '',
    animMap.attack ?? '',
    animMap.death ?? '',
    preserved,
  ].map((part) => part.trim()).join('|');
}

function prepareTemplateAnimationGroups(
  groups: AnimationGroup[],
  animMap: NpcAnimMap,
  preserveAnimationRoles: ReadonlySet<NpcAnimationRole>,
): void {
  for (const group of groups) group.stop();

  const roleGroups = new Map<NpcAnimationRole, AnimationGroup>();
  const idleGroup = resolveAnimationGroup(groups, animMap.idle, 'idle');
  const walkGroup = resolveAnimationGroup(groups, animMap.walk, 'walk');
  const attackGroup = resolveAnimationGroup(groups, animMap.attack, 'attack');
  const deathGroup = resolveAnimationGroup(groups, animMap.death, 'death');

  if (idleGroup) roleGroups.set('idle', idleGroup);
  if (walkGroup) roleGroups.set('walk', walkGroup);
  if (attackGroup) roleGroups.set('attack', attackGroup);
  if (deathGroup) roleGroups.set('death', deathGroup);
  if (!idleGroup) {
    const fallback = walkGroup ?? groups[0];
    if (fallback) roleGroups.set('idle', fallback);
  }

  const retainedGroups = new Set(roleGroups.values());
  for (const group of groups) {
    if (!retainedGroups.has(group)) {
      group.stop();
      group.dispose();
    }
  }
  groups.splice(0, groups.length, ...retainedGroups);

  const rolesByGroup = new Map<AnimationGroup, Set<NpcAnimationRole>>();
  for (const [role, group] of roleGroups) {
    let roles = rolesByGroup.get(group);
    if (!roles) {
      roles = new Set();
      rolesByGroup.set(group, roles);
    }
    roles.add(role);
  }

  const preferredRoles: NpcAnimationRole[] = ['walk', 'attack', 'death', 'idle'];
  for (const [group, roles] of rolesByGroup) {
    const shouldPreserve = Array.from(roles).some((role) => preserveAnimationRoles.has(role));
    if (shouldPreserve) continue;
    const quantizeRole = preferredRoles.find((role) => roles.has(role)) ?? 'idle';
    quantizeAnimationGroup(group, `npc_${quantizeRole}`);
  }
}

function applyNpcMaterialRuntimeDefaults(mat: any): void {
  if (mat.diffuseTexture) mat.diffuseTexture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
  if (mat.albedoTexture) mat.albedoTexture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
  if (mat.getClassName?.() === 'PBRMaterial') {
    mat.roughness = 1.0;
    mat.metallic = 0.0;
    mat.environmentIntensity = 0;
    mat.specularIntensity = 0;
  }
}

function prepareTemplateMaterials(container: AssetContainer): void {
  const materials = new Set<any>();
  for (const mesh of container.meshes) {
    const mat = mesh.material as any;
    if (mat) materials.add(mat);
  }
  for (const mat of materials) applyNpcMaterialRuntimeDefaults(mat);
}

function disposeNpcModelTemplate(template: NpcModelTemplate): void {
  for (const group of uniqueAnimationGroups(template.container.animationGroups)) {
    group.stop();
    group.dispose();
  }
  template.container.dispose();
}

export function clearNpcModelTemplateCache(scene: Scene, file?: string): void {
  const cache = sceneNpcModelTemplates.get(scene);
  if (!cache) return;

  let fileKey: string | null = null;
  if (file) {
    const lastSlash = file.lastIndexOf('/');
    const dir = file.substring(0, lastSlash + 1);
    const fname = devCacheBust(file.substring(lastSlash + 1));
    fileKey = `${dir}${fname}`;
  }

  for (const [key, promise] of Array.from(cache.entries())) {
    if (fileKey && !key.startsWith(`${fileKey}|`)) continue;
    cache.delete(key);
    promise.then(disposeNpcModelTemplate).catch(() => {});
  }
  if (!fileKey) sceneNpcModelTemplates.delete(scene);
}

function getNpcModelTemplate(
  scene: Scene,
  dir: string,
  file: string,
  animMap: NpcAnimMap,
  preserveAnimationRoles: ReadonlySet<NpcAnimationRole>,
): Promise<NpcModelTemplate> {
  const cache = npcModelTemplateCache(scene);
  const fileKey = `${dir}${file}`;
  const key = `${fileKey}|${buildAnimationProfileKey(animMap, preserveAnimationRoles)}`;
  let promise = cache.get(key);
  if (!promise) {
    promise = loadAssetContainerWithSlowWarning(scene, dir, file)
      .then((container) => {
        prepareTemplateMaterials(container);
        prepareTemplateAnimationGroups(container.animationGroups, animMap, preserveAnimationRoles);
        return { container };
      }, (err) => {
        if (cache.get(key) === promise) cache.delete(key);
        throw err;
      });
    cache.set(key, promise);
  }
  return promise;
}

function collectNpcModelInstance(entries: InstantiatedEntries): NpcModelInstance {
  const allNodes = new Set<any>();
  for (const root of entries.rootNodes) {
    allNodes.add(root);
    for (const child of (root as any).getDescendants?.(false) ?? []) {
      allNodes.add(child);
    }
  }
  const meshes = Array.from(allNodes).filter((node): node is AbstractMesh => node instanceof AbstractMesh);
  return {
    entries,
    rootNodes: entries.rootNodes.filter((node): node is TransformNode => node instanceof TransformNode),
    meshes,
    skeletons: entries.skeletons,
    animationGroups: entries.animationGroups,
  };
}

async function instantiateNpcModel(
  scene: Scene,
  dir: string,
  file: string,
  animMap: NpcAnimMap,
  preserveAnimationRoles: ReadonlySet<NpcAnimationRole>,
  label?: string,
): Promise<NpcModelInstance> {
  const template = await getNpcModelTemplate(scene, dir, file, animMap, preserveAnimationRoles);
  const instanceId = ++npcModelInstanceId;
  const prefix = `npc3dsrc_${label ?? 'npc'}_${instanceId}`;
  const entries = template.container.instantiateModelsToScene(
    (sourceName) => `${prefix}_${sourceName}`,
    false,
    { doNotInstantiate: true },
  );
  for (const group of entries.animationGroups) group.stop();
  return collectNpcModelInstance(entries);
}

function disposeNpcModelInstance(result: NpcModelInstance): void {
  result.entries.dispose();
}

function normalizeAnimationName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    // Babylon auto-renames imported animation groups when several copies of a
    // GLB are loaded into one scene. Keep config matching stable across that.
    .replace(/\.\d+$/, '');
}

function animationNameMatchesRole(name: string, role: 'idle' | 'walk' | 'attack' | 'death'): boolean {
  const normalized = normalizeAnimationName(name);
  if (normalized === role) return true;
  if (normalized.endsWith(`_${role}`) || normalized.endsWith(`|${role}`)) return true;
  if (role === 'walk') return normalized.includes('walk') || normalized.includes('run');
  if (role === 'death') return normalized.includes('death') || normalized.includes('die');
  return normalized.includes(role);
}

function resolveAnimationGroup(
  groups: AnimationGroup[],
  requested: string | undefined,
  role: 'idle' | 'walk' | 'attack' | 'death',
): AnimationGroup | undefined {
  if (requested) {
    const requestedKey = normalizeAnimationName(requested);
    const exact = groups.find((group) => normalizeAnimationName(group.name) === requestedKey);
    if (exact) return exact;
    const suffix = groups.find((group) => {
      const normalized = normalizeAnimationName(group.name);
      return normalized.endsWith(`|${requestedKey}`) || normalized.endsWith(`_${requestedKey}`);
    });
    if (suffix) return suffix;
  }

  return groups.find((group) => animationNameMatchesRole(group.name, role));
}

function uniqueAnimationGroups(groups: Iterable<AnimationGroup>): AnimationGroup[] {
  return Array.from(new Set(groups));
}

function normalizeMaterialName(name: string): string {
  return name.trim().toLowerCase().replace(/\.\d+$/, '');
}

function materialColorLookup(
  materialColors?: Record<string, [number, number, number]>,
): Map<string, [number, number, number]> | null {
  if (!materialColors || Object.keys(materialColors).length === 0) return null;
  const lookup = new Map<string, [number, number, number]>();
  for (const [name, color] of Object.entries(materialColors)) {
    lookup.set(normalizeMaterialName(name), color);
  }
  return lookup;
}

interface AnimationFade {
  group: AnimationGroup;
  from: number;
  to: number;
  startMs: number;
  durationMs: number;
  stopOnDone: boolean;
}

interface GearAttachment {
  itemId: number;
  node: TransformNode;
  rootNode: TransformNode;
}

/**
 * 3D NPC entity — loads a GLB with embedded animations.
 * Exposes the same public interface as SpriteEntity so it can be used interchangeably.
 */
export class Npc3DEntity {
  static clearModelCache(scene: Scene, file?: string): void {
    clearNpcModelTemplateCache(scene, file);
  }

  private scene: Scene;
  private root: TransformNode | null = null;
  private meshes: AbstractMesh[] = [];
  private skeletons: Skeleton[] = [];
  /** Per-instance materials cloned for color-variant mobs (line ~509). Uniquely
   *  owned by this NPC; plain mobs share cached template materials and add none. */
  private clonedVariantMaterials: Material[] = [];
  private disposed: boolean = false;
  private _position: Vector3 = Vector3.Zero();
  private _rotationY: number = 0;
  private targetRotationY: number = 0;
  private baseModelScale: number = 1;
  private visualScale: number = 1;
  private modelScale: number = 1;
  private modelBoundsHeight: number = 1;
  private originMode: Npc3DEntityOptions['originMode'] = 'authored';
  private groundOffset: number = 0;
  private facingOffsetY: number = 0;
  private originOffsetX: number = 0;
  private originOffsetZ: number = 0;
  private renderEnabled: boolean = true;
  private groundShadow: Mesh | null = null;
  private pickProxy: Mesh | null = null;
  /** Gameplay position is the authoritative footprint anchor. Render and aim
   *  from the footprint center so even-width mobs visually match melee tiles. */
  private footprintWidth: number = 1;

  // Animations keyed by role (idle, walk, attack, death)
  private animGroups: Map<string, AnimationGroup> = new Map();
  private currentAnim: string = '';
  private currentAnimLoop: boolean = true;
  private animSpeedRatio: Partial<Record<'idle' | 'walk' | 'attack' | 'death', number>> = {};
  private preserveAnimationRoles = new Set<'idle' | 'walk' | 'attack' | 'death'>();
  private animationEnabled: boolean = true;
  private missingAnimationWarnings = new Set<string>();
  private _walking: boolean = false;
  private animationFades: AnimationFade[] = [];
  private static readonly ANIMATION_BLEND_MS = 160;

  // Health bar (HTML overlay — same as SpriteEntity)
  private healthBarEl: HTMLDivElement | null = null;
  private healthBarFillEl: HTMLDivElement | null = null;
  private healthBarTextEl: HTMLDivElement | null = null;
  private healthBarVisible: boolean = false;
  private yOffset: number = 0.5;
  private chatBubbleEl: HTMLDivElement | null = null;
  private chatBubbleTimer: number | null = null;
  private labelEl: HTMLDivElement | null = null;
  private labelColor: string = '#f4ded5';

  private _ready = false;
  private _readyPromise: Promise<void>;
  private _resolveReady!: () => void;
  /** Entity ID stamped on every loaded mesh's metadata. Set via
   *  setEntityIdMetadata so picking can resolve the clicked instance even
   *  when multiple NPCs share the same source GLB (e.g. multiple cows). */
  private pendingEntityId: number | null = null;
  private gearAttachments: Map<string, GearAttachment> = new Map();

  constructor(
    scene: Scene,
    file: string,
    scale: number,
    animMap: { idle: string; walk?: string; attack?: string; death?: string },
    options: Npc3DEntityOptions = {},
  ) {
    this.scene = scene;
    this._readyPromise = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.baseModelScale = normalizePositiveScale(scale, 1);
    this.visualScale = normalizeNpcVisualScale(options.visualScale);
    this.updateModelScale();
    this.originMode = options.originMode ?? 'authored';
    this.groundOffset = options.groundOffset ?? 0;
    this.facingOffsetY = options.facingOffsetY ?? 0;
    this.originOffsetX = typeof options.originOffset?.x === 'number' && Number.isFinite(options.originOffset.x)
      ? options.originOffset.x
      : 0;
    this.originOffsetZ = typeof options.originOffset?.z === 'number' && Number.isFinite(options.originOffset.z)
      ? options.originOffset.z
      : 0;
    this.animSpeedRatio = options.animSpeedRatio ?? {};
    this.preserveAnimationRoles = new Set(options.preserveAnimationRoles ?? []);
    this.footprintWidth = Math.max(1, Math.round(options.tileSize ?? 1));
    this.load(file, animMap, options.label, options.materialColors);
  }

  private updateModelScale(): void {
    this.modelScale = this.baseModelScale * this.visualScale;
    if (this.root) {
      this.root.scaling.set(this.modelScale, this.modelScale, this.modelScale);
    }
    if (Number.isFinite(this.modelBoundsHeight) && this.modelBoundsHeight > 0) {
      this.yOffset = this.modelBoundsHeight * this.modelScale / 2;
    }
  }

  private createPickProxy(label: string | undefined, localWidth: number, localDepth: number): void {
    if (!this.root) return;
    this.pickProxy?.dispose();
    const minWorldSize = 0.75;
    const scale = Math.max(0.001, this.modelScale);
    const localHeight = Math.max(this.modelBoundsHeight, 1.1 / scale);
    const proxy = MeshBuilder.CreateBox(`npc3d_${label ?? 'npc'}_pickProxy`, {
      width: Math.max(localWidth, minWorldSize / scale),
      depth: Math.max(localDepth, minWorldSize / scale),
      height: localHeight,
    }, this.scene);
    proxy.parent = this.root;
    proxy.position.y = localHeight * 0.5;
    proxy.isVisible = true;
    proxy.visibility = 0;
    proxy.isPickable = true;
    proxy.layerMask = 0;
    proxy.doNotSyncBoundingInfo = true;
    if (this.pendingEntityId !== null) {
      proxy.metadata = { ...(proxy.metadata ?? {}), entityId: this.pendingEntityId, kind: 'npc' };
    }
    this.pickProxy = proxy;
  }

  setVisualScale(scale: number): void {
    const next = normalizeNpcVisualScale(scale);
    if (Math.abs(next - this.visualScale) < 0.0001) return;
    this.visualScale = next;
    this.updateModelScale();
  }

  private visualY(y: number): number {
    return y + this.groundOffset;
  }

  private visualX(x: number = this._position.x): number {
    return getObjectFootprintContinuousCenterCoord(x, this.footprintWidth);
  }

  private visualZ(z: number = this._position.z): number {
    return getObjectFootprintContinuousCenterCoord(z, this.footprintWidth);
  }

  private setRootPositionFromLogical(): void {
    if (!this.root) return;
    this.root.position.set(this.visualX(), this.visualY(this._position.y), this.visualZ());
  }

  private applyRootRotation(): void {
    if (this.root) this.root.rotation.y = this._rotationY + this.facingOffsetY;
  }

  private async load(
    file: string,
    animMap: { idle: string; walk?: string; attack?: string; death?: string },
    label?: string,
    materialColors?: Record<string, [number, number, number]>,
  ): Promise<void> {
    try {
      const lastSlash = file.lastIndexOf('/');
      const dir = file.substring(0, lastSlash + 1);
      const fname = devCacheBust(file.substring(lastSlash + 1));
      const result = await instantiateNpcModel(this.scene, dir, fname, animMap, this.preserveAnimationRoles, label);
      if (this.disposed || this.scene.isDisposed) {
        disposeNpcModelInstance(result);
        this._resolveReady();
        return;
      }

      // Only clone materials when a variant needs color overrides. Plain mobs
      // can share cached template materials across instances.
      const materialLookup = materialColorLookup(materialColors);
      const shouldCloneMaterials = materialLookup !== null;
      const cloned = new Map<any, any>();
      for (const mesh of result.meshes) {
        if (mesh.getTotalVertices() === 0) mesh.isVisible = false;
        const original = mesh.material as any;
        if (!original) continue;
        let mat = original;
        if (shouldCloneMaterials) {
          mat = cloned.get(original);
          if (!mat) {
            mat = original.clone(`${original.name}_${label ?? 'npc'}`);
            cloned.set(original, mat);
            this.clonedVariantMaterials.push(mat);
          }
          mesh.material = mat;
          applyNpcMaterialRuntimeDefaults(mat);
        }
        const override = materialLookup?.get(normalizeMaterialName(original.name));
        if (override) {
          const [r, g, b] = override;
          if ('albedoColor' in mat) mat.albedoColor = new Color3(r, g, b);
          else if ('diffuseColor' in mat) mat.diffuseColor = new Color3(r, g, b);
        }
      }

      // Same pattern as ChunkManager.loadGLBModel — proven to work
      this.root = new TransformNode(`npc3d_${label ?? ''}`, this.scene);
      for (const node of result.rootNodes) node.parent = this.root;
      for (const node of result.rootNodes) {
        if ('isPickable' in node) (node as TransformNode & { isPickable: boolean }).isPickable = false;
        for (const child of ((node as any).getDescendants?.(false) ?? [])) {
          if ('isPickable' in child) (child as { isPickable: boolean }).isPickable = false;
        }
      }
      this.applyRootRotation();

      this.meshes = result.meshes.filter(m => m.getTotalVertices() > 0);
      for (const mesh of result.meshes) mesh.isPickable = false;
      this.skeletons = result.skeletons;

      // Compute bounds and offset so feet are at Y=0. Some authored GLBs
      // also need X/Z recentering so their visual center lands on the NPC
      // render origin after the footprint offset is applied.
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
      for (const mesh of this.meshes) {
        mesh.computeWorldMatrix(true);
        const bb = mesh.getBoundingInfo().boundingBox;
        if (bb.minimumWorld.x < minX) minX = bb.minimumWorld.x;
        if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
        if (bb.minimumWorld.z < minZ) minZ = bb.minimumWorld.z;
        if (bb.maximumWorld.x > maxX) maxX = bb.maximumWorld.x;
        if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y;
        if (bb.maximumWorld.z > maxZ) maxZ = bb.maximumWorld.z;
      }
      const sourceOffsetX = this.originOffsetX / this.baseModelScale;
      const sourceOffsetZ = this.originOffsetZ / this.baseModelScale;
      if (this.originMode === 'boundsCenter' || sourceOffsetX !== 0 || sourceOffsetZ !== 0) {
        const centerX = this.originMode === 'boundsCenter' ? (minX + maxX) / 2 : 0;
        const centerZ = this.originMode === 'boundsCenter' ? (minZ + maxZ) / 2 : 0;
        for (const node of result.rootNodes) {
          node.position.x += sourceOffsetX - centerX;
          node.position.z += sourceOffsetZ - centerZ;
        }
      }
      for (const node of result.rootNodes) node.position.y -= minY;

      this.modelBoundsHeight = Number.isFinite(maxY - minY) && maxY > minY ? maxY - minY : 1;
      this.updateModelScale();
      this.createPickProxy(label, Math.max(0.1, maxX - minX), Math.max(0.1, maxZ - minZ));
      const boundsWidth = Number.isFinite(maxX - minX) ? (maxX - minX) * this.modelScale : 0;
      const boundsDepth = Number.isFinite(maxZ - minZ) ? (maxZ - minZ) * this.modelScale : 0;
      const footprintSize = this.footprintWidth * 0.72;
      this.groundShadow = createMobGroundShadow(
        this.scene,
        `npc3d_${label ?? 'npc'}_groundShadow`,
        this.root,
        Math.max(0.45, footprintSize * 1.08, boundsWidth * 1.12),
        Math.max(0.36, footprintSize * 0.90, boundsDepth * 1.04),
        this.modelScale,
        -this.groundOffset,
      );

      // If setEntityIdMetadata was called before the GLB finished loading,
      // apply the queued id now that meshes exist.
      if (this.pendingEntityId !== null) {
        this.setEntityIdMetadata(this.pendingEntityId);
      }
      this.yOffset = this.modelBoundsHeight * this.modelScale / 2;

      // Map animations by role. Babylon may suffix group names when the same
      // GLB is imported multiple times, so match by normalized name first and
      // then by role token.
      for (const group of result.animationGroups) group.stop();
      const idleGroup = resolveAnimationGroup(result.animationGroups, animMap.idle, 'idle');
      const walkGroup = resolveAnimationGroup(result.animationGroups, animMap.walk, 'walk');
      const attackGroup = resolveAnimationGroup(result.animationGroups, animMap.attack, 'attack');
      const deathGroup = resolveAnimationGroup(result.animationGroups, animMap.death, 'death');

      if (idleGroup) this.animGroups.set('idle', idleGroup);
      if (walkGroup) this.animGroups.set('walk', walkGroup);
      if (attackGroup) this.animGroups.set('attack', attackGroup);
      if (deathGroup) this.animGroups.set('death', deathGroup);

      if (!idleGroup) {
        const fallback = walkGroup ?? result.animationGroups[0];
        if (fallback) this.animGroups.set('idle', fallback);
      }

      if (this._walking && this.animGroups.has('walk')) this.playAnim('walk', true);
      else this.playAnim('idle', true);
      this.setRootPositionFromLogical();
      if (!this.renderEnabled) this.root.setEnabled(false);
      this._ready = true;
      // Force enable all meshes
      for (const mesh of this.meshes) {
        mesh.isVisible = true;
        mesh.setEnabled(true);
      }
      this._resolveReady();
    } catch (e) {
      if (!this.disposed) console.warn(`[Npc3DEntity] Failed to load ${file}:`, e);
      this._resolveReady();
    }
  }

  private animationBlendDurationMs(from: string, to: string): number {
    if (!from || from === to) return 0;
    if (from === 'death' || to === 'death') return 0;
    return Npc3DEntity.ANIMATION_BLEND_MS;
  }

  private currentAnimationWeight(group: AnimationGroup): number {
    const weight = group.weight;
    if (!Number.isFinite(weight) || weight < 0) return 1;
    return Math.max(0, Math.min(1, weight));
  }

  private setAnimationWeight(group: AnimationGroup, weight: number): void {
    const clamped = Math.max(0, Math.min(1, weight));
    group.weight = clamped;
    group.setWeightForAllAnimatables(clamped);
  }

  private removeAnimationFade(group: AnimationGroup): void {
    for (let i = this.animationFades.length - 1; i >= 0; i--) {
      if (this.animationFades[i].group === group) this.animationFades.splice(i, 1);
    }
  }

  private queueAnimationFade(
    group: AnimationGroup,
    from: number,
    to: number,
    durationMs: number,
    stopOnDone: boolean,
  ): void {
    this.removeAnimationFade(group);
    if (durationMs <= 0) {
      this.setAnimationWeight(group, to);
      if (stopOnDone) {
        group.stop(true);
        this.setAnimationWeight(group, 1);
      }
      return;
    }
    this.animationFades.push({
      group,
      from,
      to,
      startMs: performance.now(),
      durationMs,
      stopOnDone,
    });
  }

  private updateAnimationFades(now: number = performance.now()): void {
    for (let i = this.animationFades.length - 1; i >= 0; i--) {
      const fade = this.animationFades[i];
      const t = Math.min(1, Math.max(0, (now - fade.startMs) / fade.durationMs));
      this.setAnimationWeight(fade.group, fade.from + (fade.to - fade.from) * t);
      if (t < 1) continue;
      this.animationFades.splice(i, 1);
      if (fade.stopOnDone) {
        fade.group.stop(true);
        this.setAnimationWeight(fade.group, 1);
      } else {
        this.setAnimationWeight(fade.group, fade.to);
      }
    }
  }

  private stopAnimationFades(): void {
    if (this.animationFades.length === 0) return;
    for (const fade of this.animationFades) {
      if (fade.stopOnDone) fade.group.stop(true);
      this.setAnimationWeight(fade.group, 1);
    }
    this.animationFades = [];
  }

  private stopAllAnimationGroups(): void {
    this.stopAnimationFades();
    for (const anim of uniqueAnimationGroups(this.animGroups.values())) {
      anim.stop(true);
      this.setAnimationWeight(anim, 1);
    }
  }

  private playAnim(name: string, loop: boolean): void {
    if (name === this.currentAnim && loop) {
      const currentGroup = this.animGroups.get(name);
      if (!this.renderEnabled || currentGroup?.isPlaying) return;
    }
    const group = this.animGroups.get(name);
    if (!group) {
      if (!this.missingAnimationWarnings.has(name)) {
        this.missingAnimationWarnings.add(name);
        console.warn(`[Npc3DEntity] Missing animation '${name}'`);
      }
      return;
    }

    const oldName = this.currentAnim;
    const oldGroup = oldName ? this.animGroups.get(oldName) : null;
    const shouldAnimate = this.animationEnabled && this.renderEnabled;
    const shouldBlend = Boolean(
      shouldAnimate
      && oldGroup
      && oldGroup !== group
      && oldGroup.isPlaying,
    );
    const blendMs = shouldBlend ? this.animationBlendDurationMs(oldName, name) : 0;

    if (oldGroup && oldGroup !== group) {
      if (shouldBlend && blendMs > 0) {
        this.queueAnimationFade(oldGroup, this.currentAnimationWeight(oldGroup), 0, blendMs, true);
      } else {
        this.removeAnimationFade(oldGroup);
        oldGroup.stop(true);
        this.setAnimationWeight(oldGroup, 1);
      }
    }

    this.currentAnim = name;
    this.currentAnimLoop = loop;
    this.removeAnimationFade(group);
    if (shouldAnimate) {
      group.start(loop, this.getAnimSpeedRatio(name), group.from, group.to, false);
      if (shouldBlend && blendMs > 0) {
        this.setAnimationWeight(group, 0);
        this.queueAnimationFade(group, 0, 1, blendMs, false);
      } else {
        this.setAnimationWeight(group, 1);
      }
    }
  }

  private getAnimSpeedRatio(name: string): number {
    return this.animSpeedRatio[name as 'idle' | 'walk' | 'attack' | 'death'] ?? 1.0;
  }

  private resolveAnimRole(name: string): string {
    if (this.animGroups.has(name)) return name;
    const normalized = normalizeAnimationName(name);
    if (normalized.includes('attack')) return 'attack';
    if (normalized.includes('death') || normalized.includes('die')) return 'death';
    if (normalized.includes('walk') || normalized.includes('run')) return 'walk';
    if (normalized.includes('idle')) return 'idle';
    return name;
  }

  /** Wall-clock duration of a loaded role animation in milliseconds. */
  getAnimationDurationMs(name: string): number {
    const role = this.resolveAnimRole(name);
    const group = this.animGroups.get(role);
    if (!group) return 0;
    const fps = group.targetedAnimations[0]?.animation?.framePerSecond ?? 60;
    if (fps <= 0) return 0;
    // Clamp the speed ratio to a small positive floor so a configured
    // animSpeedRatio of 0 yields a finite duration instead of Infinity.
    const speedRatio = Math.max(this.getAnimSpeedRatio(role), 0.01);
    return ((group.to - group.from) / fps) * 1000 / speedRatio;
  }

  setAnimationEnabled(enabled: boolean): void {
    if (this.animationEnabled === enabled) return;
    if (!enabled && !this.currentAnimLoop) return;
    this.animationEnabled = enabled;
    const group = this.currentAnim ? this.animGroups.get(this.currentAnim) : null;
    if (!group) return;
    if (enabled && this.renderEnabled) {
      this.stopAnimationFades();
      group.start(this.currentAnimLoop, this.getAnimSpeedRatio(this.currentAnim), group.from, group.to, false);
      this.setAnimationWeight(group, 1);
    } else {
      this.stopAllAnimationGroups();
    }
  }

  isAnimationEnabled(): boolean {
    return this.animationEnabled;
  }

  setRenderEnabled(enabled: boolean): void {
    if (this.renderEnabled === enabled) return;
    this.renderEnabled = enabled;
    if (this.root) this.root.setEnabled(enabled);
    const group = this.currentAnim ? this.animGroups.get(this.currentAnim) : null;
    if (!enabled) {
      this.stopAllAnimationGroups();
      if (this.healthBarEl) {
        this.healthBarEl.style.left = '-9999px';
        this.healthBarEl.style.top = '-9999px';
      }
      if (this.chatBubbleEl) {
        this.chatBubbleEl.style.left = '-9999px';
        this.chatBubbleEl.style.top = '-9999px';
      }
    } else if (group && this.animationEnabled) {
      this.stopAnimationFades();
      group.start(this.currentAnimLoop, this.getAnimSpeedRatio(this.currentAnim), group.from, group.to, false);
      this.setAnimationWeight(group, 1);
    }
  }

  isRenderEnabled(): boolean {
    return this.renderEnabled;
  }

  // --- Public API matching SpriteEntity ---

  setPositionXYZ(x: number, y: number, z: number): void {
    this._position.set(x, y, z);
    this.setRootPositionFromLogical();
  }

  get position(): Vector3 { return this._position; }
  set position(pos: Vector3) {
    this._position = pos;
    this.setRootPositionFromLogical();
  }

  /** World-space point projectiles aim at: roughly chest-height above the NPC's base. */
  getTargetAnchor(): Vector3 {
    return new Vector3(this.visualX(), this._position.y + Math.max(0.35, this.yOffset), this.visualZ());
  }

  startWalking(): void {
    if (this._walking) return;
    this._walking = true;
    if (!this._ready) return;
    if (!this.animGroups.has('walk')) return;
    this.playAnim('walk', true);
  }

  stopWalking(): void {
    if (!this._walking) return;
    this._walking = false;
    this.playAnim('idle', true);
  }

  isWalking(): boolean { return this._walking; }

  playAttackAnimation(_variant?: string): void {
    if (!this.animGroups.has('attack')) return;
    if (this.currentAnim === 'attack') return;
    this.playAnim('attack', false);
    const group = this.animGroups.get('attack');
    if (group) {
      group.onAnimationGroupEndObservable.addOnce(() => {
        if (this.currentAnim !== 'attack') return;
        if (this._walking) this.playAnim('walk', true);
        else this.playAnim('idle', true);
      });
    }
  }

  playDeathAnimation(onDone?: () => void): boolean {
    const group = this.animGroups.get('death');
    if (!group || !this.animationEnabled || !this.renderEnabled) return false;
    this._walking = false;
    group.onAnimationGroupEndObservable.addOnce(() => {
      if (this.currentAnim !== 'death') return;
      onDone?.();
    });
    this.playAnim('death', false);
    return true;
  }

  updateAnimation(dt: number): void {
    if (!this.root) return;
    this.updateAnimationFades();
    const newYaw = rs2Rotation(this._rotationY, this.targetRotationY, dt);
    if (newYaw !== this._rotationY) {
      this._rotationY = newYaw;
      this.applyRootRotation();
    }
  }

  updateMovementDirection(dx: number, dz: number, _cameraPos?: Vector3): void {
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
    this.targetRotationY = Math.atan2(dx, dz);
  }

  /** Server-driven yaw target — fed by NPC_FACING so 3D NPCs (rat, cow,
   *  spider, camel) turn to face the player on talk/attack just like
   *  CharacterEntity NPCs do. updateAnimation handles the lerp. */
  setFacingAngle(radians: number): void {
    this._rotationY = radians;
    this.targetRotationY = radians;
    this.applyRootRotation();
  }

  setTargetFacing(radians: number): void {
    this.targetRotationY = radians;
  }

  faceToward(target: Vector3, _cameraPos?: Vector3): void {
    const dx = target.x - this.visualX();
    const dz = target.z - this.visualZ();
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
    this.targetRotationY = Math.atan2(dx, dz);
  }

  updateDirection(_cameraPos: Vector3): void { /* no-op for 3D */ }

  // Health bar
  showHealthBar(current: number, max: number): void {
    this.healthBarVisible = true;
    if (!this.healthBarEl) {
      this.healthBarEl = document.createElement('div');
      this.healthBarEl.className = 'entity-health-bar';
      this.healthBarEl.style.cssText = `position:absolute;pointer-events:none;z-index:150;width:48px;height:8px;background:#400;border:1px solid #000;transform:translate(-50%,-50%);border-radius:1px;overflow:hidden`;
      this.healthBarFillEl = document.createElement('div');
      this.healthBarFillEl.style.cssText = `height:100%;transition:width 0.15s,background 0.15s`;
      this.healthBarEl.appendChild(this.healthBarFillEl);
      this.healthBarTextEl = document.createElement('div');
      this.healthBarTextEl.style.cssText = `position:absolute;top:-1px;left:0;right:0;text-align:center;font-family: Arial, Helvetica, sans-serif;font-size:8px;font-weight:bold;color:#fff;text-shadow:1px 1px 0 #000,-1px -1px 0 #000;line-height:10px;pointer-events:none`;
      this.healthBarEl.appendChild(this.healthBarTextEl);
      mountWorldOverlayElement(this.healthBarEl);
    }
    const ratio = Math.max(0, current / max);
    this.healthBarFillEl!.style.width = `${ratio * 100}%`;
    this.healthBarFillEl!.style.background = ratio > 0.5 ? '#0b0' : ratio > 0.25 ? '#bb0' : '#b00';
    this.healthBarTextEl!.textContent = `${current}/${max}`;
  }

  hideHealthBar(): void {
    this.healthBarVisible = false;
    if (this.healthBarEl) { this.healthBarEl.remove(); this.healthBarEl = null; }
  }

  getHealthBarWorldPos(out?: Vector3): Vector3 | null {
    if (!this.healthBarVisible) return null;
    const v = out ?? new Vector3();
    v.set(this.visualX(), this._position.y + this.yOffset * 2 + 0.3, this.visualZ());
    return v;
  }

  updateHealthBarScreenPos(x: number, y: number): void {
    if (this.healthBarEl) { this.healthBarEl.style.left = `${x}px`; this.healthBarEl.style.top = `${y}px`; }
  }

  hasHealthBar(): boolean { return this.healthBarVisible && this.healthBarEl !== null; }

  showChatBubble(message: string, duration: number = 5000, variant: ChatBubbleVariant = 'chat'): void {
    this.hideChatBubble();
    const el = createChatBubbleElement(message, variant);
    mountWorldOverlayElement(el);
    this.chatBubbleEl = el;
    this.chatBubbleTimer = window.setTimeout(() => this.hideChatBubble(), chatBubbleDuration(message, duration));
  }

  hideChatBubble(): void {
    if (this.chatBubbleTimer !== null) {
      window.clearTimeout(this.chatBubbleTimer);
      this.chatBubbleTimer = null;
    }
    if (this.chatBubbleEl) {
      this.chatBubbleEl.remove();
      this.chatBubbleEl = null;
    }
  }

  getChatBubbleWorldPos(out?: Vector3): Vector3 | null {
    if (!this.chatBubbleEl) return null;
    const v = out ?? new Vector3();
    v.set(this.visualX(), this._position.y + this.yOffset * 2 + 0.6, this.visualZ());
    return v;
  }

  updateChatBubbleScreenPos(x: number, y: number): void {
    if (this.chatBubbleEl) {
      this.chatBubbleEl.style.left = `${x}px`;
      this.chatBubbleEl.style.top = `${y}px`;
    }
  }

  hasChatBubble(): boolean { return this.chatBubbleEl !== null; }

  setLabel(text: string): void {
    if (!text) {
      if (this.labelEl) {
        this.labelEl.remove();
        this.labelEl = null;
      }
      return;
    }
    if (!this.labelEl) {
      const el = document.createElement('div');
      el.className = 'character-name-overlay';
      el.style.cssText = `
        position: absolute; pointer-events: none; z-index: 150;
        font-family: Arial, Helvetica, sans-serif; font-size: 12px;
        color: ${this.labelColor};
        white-space: nowrap;
        transform: translate(-50%, -100%);
        text-shadow: 1px 1px 2px rgba(0,0,0,0.85);
        opacity: 0;
      `;
      mountWorldOverlayElement(el);
      this.labelEl = el;
    } else {
      this.labelEl.style.color = this.labelColor;
    }
    this.labelEl.textContent = text;
  }

  setLabelColor(color: string): void {
    this.labelColor = color;
    if (this.labelEl) this.labelEl.style.color = color;
  }

  getLabelWorldPos(out?: Vector3): Vector3 | null {
    if (!this.labelEl) return null;
    const v = out ?? new Vector3();
    v.set(this.visualX(), this._position.y + this.yOffset * 2 + 0.95, this.visualZ());
    return v;
  }

  updateLabelScreenPos(x: number, y: number, opacity: number = 1): void {
    if (this.labelEl) {
      this.labelEl.style.left = `${x}px`;
      this.labelEl.style.top = `${y}px`;
      this.labelEl.style.opacity = opacity.toString();
    }
  }

  // SpriteEntity compat stubs
  setAttackAnimation(_anim: any): void { }
  setWalkAnimation(_anim: any): void { }
  setDirectionalSprites(_sprites: any): void { }
  addAttackAnimation(_name: string, _anim: any): void { }
  /** Wait until the GLB has either loaded or failed. Mirrors CharacterEntity. */
  whenReady(): Promise<void> { return this._readyPromise; }
  get isReady(): boolean { return this._ready; }
  getRoot(): TransformNode | null { return this.root; }
  getMesh(): any { return this.meshes[0] ?? null; }
  /** Get all renderable meshes (for editor picking / metadata stamping). */
  getMeshes(): AbstractMesh[] { return this.meshes; }
  getBoneNames(): string[] { return this.skeletons.flatMap(skeleton => skeleton.bones.map(bone => bone.name)); }

  attachGear(slot: string, itemId: number, gearTemplate: GearTemplate): void {
    this.detachGear(slot);

    const bone = this.skeletons
      .flatMap(skeleton => skeleton.bones)
      .find(candidate => candidate.name === gearTemplate.boneName);
    if (!bone) {
      console.warn(`[Npc3DEntity] Bone '${gearTemplate.boneName}' not found for ${slot} gear. Available bones: ${this.getBoneNames().join(', ')}`);
      return;
    }

    const clone = gearTemplate.template.instantiateHierarchy(null, undefined, (source, cloned) => {
      cloned.name = `${source.name}_${slot}_${itemId}`;
    });
    if (!clone) {
      console.warn(`[Npc3DEntity] Failed to clone ${slot} gear template`);
      return;
    }

    clone.setEnabled(true);
    if (this.pendingEntityId !== null) {
      clone.metadata = { ...(clone.metadata ?? {}), entityId: this.pendingEntityId, kind: 'npc' };
    }
    if ('isPickable' in clone) clone.isPickable = false;
    for (const child of clone.getChildMeshes()) {
      child.setEnabled(true);
      child.isPickable = false;
      if (this.pendingEntityId !== null) {
        child.metadata = { ...(child.metadata ?? {}), entityId: this.pendingEntityId, kind: 'npc' };
      }
    }

    const boneTransform = bone.getTransformNode();
    let attachmentRoot = clone;
    if (boneTransform) {
      if (gearTemplate.axisCorrection) {
        const pivot = new TransformNode(`npcGearPivot_${slot}_${itemId}`, this.scene);
        pivot.parent = boneTransform;
        pivot.position.set(0, 0, 0);
        pivot.scaling.set(1, 1, 1);
        pivot.rotationQuaternion = gearTemplate.axisCorrection.clone().normalize();
        if (this.pendingEntityId !== null) {
          pivot.metadata = { ...(pivot.metadata ?? {}), entityId: this.pendingEntityId, kind: 'npc' };
        }
        clone.parent = pivot;
        attachmentRoot = pivot;
      } else {
        clone.parent = boneTransform;
      }
    } else if (this.root) {
      clone.attachToBone(bone, this.root);
    }

    clone.rotationQuaternion = null;
    clone.position.set(
      gearTemplate.localPosition.x,
      gearTemplate.localPosition.y,
      gearTemplate.localPosition.z,
    );
    clone.rotation.set(
      gearTemplate.localRotation.x,
      gearTemplate.localRotation.y,
      gearTemplate.localRotation.z,
    );
    clone.scaling.set(gearTemplate.scale, gearTemplate.scale, gearTemplate.scale);

    this.gearAttachments.set(slot, { itemId, node: clone, rootNode: attachmentRoot });
  }

  detachGear(slot: string): void {
    const existing = this.gearAttachments.get(slot);
    if (!existing) return;
    existing.rootNode.dispose();
    this.gearAttachments.delete(slot);
  }

  getGearItemId(slot: string): number {
    return this.gearAttachments.get(slot)?.itemId ?? -1;
  }

  getGearNode(slot: string): TransformNode | null {
    return this.gearAttachments.get(slot)?.node ?? null;
  }

  /**
   * Stamp the entityId onto every mesh's metadata so picking can identify
   * which 3D-modeled NPC was clicked. Without this, cows (and any other
   * shared-GLB NPCs) all carry the same mesh names from the source GLB,
   * which makes name-based picking-to-entity matching ambiguous and routes
   * every click to whichever NPC happens to be first in the lookup map.
   *
   * Safe to call before the GLB finishes loading — the id is queued and
   * applied as soon as meshes exist.
   */
  setEntityIdMetadata(entityId: number): void {
    this.pendingEntityId = entityId;
    if (this.root) {
      this.root.metadata = { ...(this.root.metadata ?? {}), entityId, kind: 'npc' };
    }
    if (this.pickProxy) {
      this.pickProxy.metadata = { ...(this.pickProxy.metadata ?? {}), entityId, kind: 'npc' };
    }
    for (const mesh of this.meshes) {
      mesh.metadata = { ...(mesh.metadata ?? {}), entityId, kind: 'npc' };
      mesh.isPickable = false;
    }
  }
  isAnimating(): boolean { return this.currentAnim === 'attack'; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hideChatBubble();
    this.hideHealthBar();
    this.setLabel('');
    this.stopAnimationFades();
    for (const attachment of this.gearAttachments.values()) attachment.node.dispose();
    this.gearAttachments.clear();
    for (const group of uniqueAnimationGroups(this.animGroups.values())) { group.stop(true); group.dispose(); }
    this.animGroups.clear();
    for (const skeleton of this.skeletons) skeleton.dispose();
    this.skeletons = [];
    // No-arg dispose: leave the shared cached template materials intact (other
    // NPC instances still reference them). Per-instance cloned variant materials
    // are uniquely owned, so free them (with their textures) explicitly.
    for (const mesh of this.meshes) mesh.dispose();
    for (const mat of this.clonedVariantMaterials) mat.dispose(false, true);
    this.clonedVariantMaterials = [];
    if (this.groundShadow) {
      this.groundShadow.dispose();
      this.groundShadow = null;
    }
    if (this.pickProxy) {
      this.pickProxy.dispose();
      this.pickProxy = null;
    }
    if (this.root) this.root.dispose();
    this.root = null;
    this.meshes = [];
  }
}
