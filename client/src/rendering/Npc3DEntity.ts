import { Scene } from '@babylonjs/core/scene';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import '@babylonjs/loaders/glTF';
import { quantizeAnimationGroup, rs2Rotation } from './AnimationQuantizer';
import { chatBubbleDuration, createChatBubbleElement, type ChatBubbleVariant } from './chatBubble';
import { mountWorldOverlayElement } from './worldOverlay';

export interface Npc3DEntityOptions {
  label?: string;
  materialColors?: Record<string, [number, number, number]>;
  tileSize?: number;
  originMode?: 'authored' | 'boundsCenter';
  /** World-space visual Y lift without changing gameplay/server position. */
  groundOffset?: number;
  /** Visual yaw offset for models whose authored forward axis differs from the game forward axis. */
  facingOffsetY?: number;
  animSpeedRatio?: Partial<Record<'idle' | 'walk' | 'attack' | 'death', number>>;
  preserveAnimationRoles?: Array<'idle' | 'walk' | 'attack' | 'death'>;
}

async function importMeshWithTimeout(
  scene: Scene,
  dir: string,
  file: string,
  timeoutMs: number = 20_000,
): Promise<Awaited<ReturnType<typeof SceneLoader.ImportMeshAsync>>> {
  let timer: number | null = null;
  try {
    return await Promise.race([
      SceneLoader.ImportMeshAsync('', dir, file, scene),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error(`GLB import timed out after ${timeoutMs}ms: ${dir}${file}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

type ImportedMeshResult = Awaited<ReturnType<typeof SceneLoader.ImportMeshAsync>>;

function disposeImportedMeshResult(result: ImportedMeshResult): void {
  for (const group of result.animationGroups) group.dispose();
  for (const mesh of result.meshes) mesh.dispose();
  for (const node of result.transformNodes) {
    if (!node.isDisposed()) node.dispose();
  }
  for (const skeleton of result.skeletons) skeleton.dispose();
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

/**
 * 3D NPC entity — loads a GLB with embedded animations.
 * Exposes the same public interface as SpriteEntity so it can be used interchangeably.
 */
export class Npc3DEntity {
  private scene: Scene;
  private root: TransformNode | null = null;
  private meshes: AbstractMesh[] = [];
  private disposed: boolean = false;
  private _position: Vector3 = Vector3.Zero();
  private _rotationY: number = 0;
  private targetRotationY: number = 0;
  private modelScale: number = 1;
  private originMode: Npc3DEntityOptions['originMode'] = 'authored';
  private groundOffset: number = 0;
  private facingOffsetY: number = 0;
  private renderEnabled: boolean = true;
  /** Server positions are already centered on the NPC footprint. Kept as a
   *  field so existing position/facing code can share one render anchor. */
  private renderOffset: number = 0;

  // Animations keyed by role (idle, walk, attack, death)
  private animGroups: Map<string, AnimationGroup> = new Map();
  private currentAnim: string = '';
  private currentAnimLoop: boolean = true;
  private animSpeedRatio: Partial<Record<'idle' | 'walk' | 'attack' | 'death', number>> = {};
  private preserveAnimationRoles = new Set<'idle' | 'walk' | 'attack' | 'death'>();
  private animationEnabled: boolean = true;
  private missingAnimationWarnings = new Set<string>();
  private _walking: boolean = false;

  // Health bar (HTML overlay — same as SpriteEntity)
  private healthBarEl: HTMLDivElement | null = null;
  private healthBarFillEl: HTMLDivElement | null = null;
  private healthBarTextEl: HTMLDivElement | null = null;
  private healthBarVisible: boolean = false;
  private yOffset: number = 0.5;
  private chatBubbleEl: HTMLDivElement | null = null;
  private chatBubbleTimer: number | null = null;

  private _ready = false;
  private _readyPromise: Promise<void>;
  private _resolveReady!: () => void;
  /** Entity ID stamped on every loaded mesh's metadata. Set via
   *  setEntityIdMetadata so picking can resolve the clicked instance even
   *  when multiple NPCs share the same source GLB (e.g. multiple cows). */
  private pendingEntityId: number | null = null;

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
    this.modelScale = scale;
    this.originMode = options.originMode ?? 'authored';
    this.groundOffset = options.groundOffset ?? 0;
    this.facingOffsetY = options.facingOffsetY ?? 0;
    this.animSpeedRatio = options.animSpeedRatio ?? {};
    this.preserveAnimationRoles = new Set(options.preserveAnimationRoles ?? []);
    this.renderOffset = 0;
    this.load(file, animMap, options.label, options.materialColors);
  }

  private visualY(y: number): number {
    return y + this.groundOffset;
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
      const fname = file.substring(lastSlash + 1);
      const result = await importMeshWithTimeout(this.scene, dir, fname);
      if (this.disposed || this.scene.isDisposed) {
        disposeImportedMeshResult(result);
        this._resolveReady();
        return;
      }

      // Clone every material before touching it — Babylon's glTF loader
      // shares material instances across multiple ImportMeshAsync() of the
      // same file, so unguarded mutation cross-contaminates every NPC sharing
      // the GLB (Snow Wolf would whiten regular wolves too).
      const cloned = new Map<any, any>();
      for (const mesh of result.meshes) {
        const original = mesh.material as any;
        if (!original) continue;
        let mat = cloned.get(original);
        if (!mat) {
          mat = original.clone(`${original.name}_${label ?? 'npc'}`);
          cloned.set(original, mat);
        }
        mesh.material = mat;
        if (mat.diffuseTexture) mat.diffuseTexture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
        if (mat.albedoTexture) mat.albedoTexture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
        if (mat.getClassName?.() === 'PBRMaterial') {
          mat.roughness = 1.0;
          mat.metallic = 0.0;
          mat.environmentIntensity = 0;
          mat.specularIntensity = 0;
        }
        const override = materialColors?.[original.name];
        if (override) {
          const [r, g, b] = override;
          if ('albedoColor' in mat) mat.albedoColor = new Color3(r, g, b);
          else if ('diffuseColor' in mat) mat.diffuseColor = new Color3(r, g, b);
        }
      }

      // Same pattern as ChunkManager.loadGLBModel — proven to work
      const glbRoot = result.meshes[0]; // __root__ node with coordinate transforms
      this.root = new TransformNode(`npc3d_${label ?? ''}`, this.scene);
      glbRoot.parent = this.root;
      this.applyRootRotation();

      this.meshes = result.meshes.filter(m => m.getTotalVertices() > 0);

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
      if (this.originMode === 'boundsCenter') {
        glbRoot.position.x -= (minX + maxX) / 2;
        glbRoot.position.z -= (minZ + maxZ) / 2;
      }
      glbRoot.position.y -= minY;

      this.root.scaling.set(this.modelScale, this.modelScale, this.modelScale);

      // If setEntityIdMetadata was called before the GLB finished loading,
      // apply the queued id now that meshes exist.
      if (this.pendingEntityId !== null) {
        this.setEntityIdMetadata(this.pendingEntityId);
      }
      this.yOffset = (maxY - minY) * this.modelScale / 2;

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

      for (const [role, group] of this.animGroups) {
        if (!this.preserveAnimationRoles.has(role as 'idle' | 'walk' | 'attack' | 'death')) {
          quantizeAnimationGroup(group, `npc_${role}`);
        }
      }

      if (this._walking && this.animGroups.has('walk')) this.playAnim('walk', true);
      else this.playAnim('idle', true);
      this.root.position.set(this._position.x + this.renderOffset, this.visualY(this._position.y), this._position.z + this.renderOffset);
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

  private playAnim(name: string, loop: boolean): void {
    if (name === this.currentAnim && loop) {
      const currentGroup = this.animGroups.get(name);
      if (!this.renderEnabled || currentGroup?.isPlaying) return;
    }
    if (this.currentAnim) {
      const cur = this.animGroups.get(this.currentAnim);
      cur?.stop();
    }
    const group = this.animGroups.get(name);
    if (!group) {
      if (!this.missingAnimationWarnings.has(name)) {
        this.missingAnimationWarnings.add(name);
        console.warn(`[Npc3DEntity] Missing animation '${name}'`);
      }
      return;
    }
    this.currentAnim = name;
    this.currentAnimLoop = loop;
    if (this.animationEnabled && this.renderEnabled) {
      group.start(loop, this.getAnimSpeedRatio(name), group.from, group.to, false);
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
    return ((group.to - group.from) / fps) * 1000 / this.getAnimSpeedRatio(role);
  }

  setAnimationEnabled(enabled: boolean): void {
    if (this.animationEnabled === enabled) return;
    if (!enabled && !this.currentAnimLoop) return;
    this.animationEnabled = enabled;
    const group = this.currentAnim ? this.animGroups.get(this.currentAnim) : null;
    if (!group) return;
    if (enabled && this.renderEnabled) {
      group.start(this.currentAnimLoop, this.getAnimSpeedRatio(this.currentAnim), group.from, group.to, false);
    } else {
      group.stop();
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
      for (const [, anim] of this.animGroups) anim.stop();
      if (this.healthBarEl) {
        this.healthBarEl.style.left = '-9999px';
        this.healthBarEl.style.top = '-9999px';
      }
      if (this.chatBubbleEl) {
        this.chatBubbleEl.style.left = '-9999px';
        this.chatBubbleEl.style.top = '-9999px';
      }
    } else if (group && this.animationEnabled) {
      group.start(this.currentAnimLoop, this.getAnimSpeedRatio(this.currentAnim), group.from, group.to, false);
    }
  }

  isRenderEnabled(): boolean {
    return this.renderEnabled;
  }

  // --- Public API matching SpriteEntity ---

  setPositionXYZ(x: number, y: number, z: number): void {
    this._position.set(x, y, z);
    if (this.root) this.root.position.set(x + this.renderOffset, this.visualY(y), z + this.renderOffset);
  }

  get position(): Vector3 { return this._position; }
  set position(pos: Vector3) {
    this._position = pos;
    if (this.root) this.root.position.set(pos.x + this.renderOffset, this.visualY(pos.y), pos.z + this.renderOffset);
  }

  /** World-space point projectiles aim at: roughly chest-height above the NPC's base. */
  getTargetAnchor(): Vector3 {
    return new Vector3(this._position.x + this.renderOffset, this._position.y + 0.7, this._position.z + this.renderOffset);
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
        if (this._walking) this.playAnim('walk', true);
        else this.playAnim('idle', true);
      });
    }
  }

  playDeathAnimation(onDone?: () => void): boolean {
    const group = this.animGroups.get('death');
    if (!group || !this.animationEnabled || !this.renderEnabled) return false;
    if (this.currentAnim !== 'death') this.playAnim('death', false);
    group.onAnimationGroupEndObservable.addOnce(() => onDone?.());
    return true;
  }

  updateAnimation(dt: number): void {
    if (!this.root) return;
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
    const dx = target.x - (this._position.x + this.renderOffset);
    const dz = target.z - (this._position.z + this.renderOffset);
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
    v.set(this._position.x + this.renderOffset, this._position.y + this.yOffset * 2 + 0.3, this._position.z + this.renderOffset);
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
    v.set(this._position.x + this.renderOffset, this._position.y + this.yOffset * 2 + 0.6, this._position.z + this.renderOffset);
    return v;
  }

  updateChatBubbleScreenPos(x: number, y: number): void {
    if (this.chatBubbleEl) {
      this.chatBubbleEl.style.left = `${x}px`;
      this.chatBubbleEl.style.top = `${y}px`;
    }
  }

  hasChatBubble(): boolean { return this.chatBubbleEl !== null; }

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
    for (const mesh of this.meshes) {
      mesh.metadata = { ...(mesh.metadata ?? {}), entityId, kind: 'npc' };
    }
  }
  isAnimating(): boolean { return this.currentAnim === 'attack'; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.hideChatBubble();
    this.hideHealthBar();
    for (const [, group] of this.animGroups) { group.stop(); group.dispose(); }
    this.animGroups.clear();
    for (const mesh of this.meshes) mesh.dispose();
    if (this.root) this.root.dispose();
    this.root = null;
    this.meshes = [];
  }
}
