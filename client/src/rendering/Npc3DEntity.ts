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

export interface Npc3DEntityOptions {
  label?: string;
  materialColors?: Record<string, [number, number, number]>;
  tileSize?: number;
  originMode?: 'authored' | 'boundsCenter';
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

/**
 * 3D NPC entity — loads a GLB with embedded animations.
 * Exposes the same public interface as SpriteEntity so it can be used interchangeably.
 */
export class Npc3DEntity {
  private scene: Scene;
  private root: TransformNode | null = null;
  private meshes: AbstractMesh[] = [];
  private _position: Vector3 = Vector3.Zero();
  private _rotationY: number = 0;
  private targetRotationY: number = 0;
  private modelScale: number = 1;
  private originMode: Npc3DEntityOptions['originMode'] = 'authored';
  /** SW-anchor → geometric-center offset for the NPC's NxN footprint.
   *  0 for size 1 / 3 / 5..., 0.5 for size 2 / 4..., applied to both X and Z.
   *  Server positions arrive as SW anchors; we render at the footprint center
   *  so the mesh sits visually centered instead of leaning into +X+Z. */
  private renderOffset: number = 0;

  // Animations keyed by role (idle, walk, attack, death)
  private animGroups: Map<string, AnimationGroup> = new Map();
  private currentAnim: string = '';
  private currentAnimLoop: boolean = true;
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
    this.modelScale = scale;
    this.originMode = options.originMode ?? 'authored';
    const tileSize = options.tileSize ?? 1;
    this.renderOffset = (Math.max(1, Math.round(tileSize)) % 2 === 0) ? 0.5 : 0;
    this.load(file, animMap, options.label, options.materialColors);
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

      // Map animations by role
      for (const group of result.animationGroups) {
        group.stop();
        if (group.name === animMap.idle) this.animGroups.set('idle', group);
        if (group.name === animMap.walk) this.animGroups.set('walk', group);
        if (group.name === animMap.attack) this.animGroups.set('attack', group);
        if (group.name === animMap.death) this.animGroups.set('death', group);
      }

      for (const [role, group] of this.animGroups) {
        quantizeAnimationGroup(group, `npc_${role}`);
      }

      if (this._walking && this.animGroups.has('walk')) this.playAnim('walk', true);
      else this.playAnim('idle', true);
      this.root.position.set(this._position.x + this.renderOffset, this._position.y, this._position.z + this.renderOffset);
      this._ready = true;
      // Force enable all meshes
      for (const mesh of this.meshes) {
        mesh.isVisible = true;
        mesh.setEnabled(true);
      }
    } catch (e) {
      console.warn(`[Npc3DEntity] Failed to load ${file}:`, e);
    }
  }

  private playAnim(name: string, loop: boolean): void {
    if (name === this.currentAnim && loop) return;
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
    if (this.animationEnabled) {
      group.start(loop, 1.0, group.from, group.to, false);
    }
  }

  setAnimationEnabled(enabled: boolean): void {
    if (this.animationEnabled === enabled) return;
    if (!enabled && !this.currentAnimLoop) return;
    this.animationEnabled = enabled;
    const group = this.currentAnim ? this.animGroups.get(this.currentAnim) : null;
    if (!group) return;
    if (enabled) {
      group.start(this.currentAnimLoop, 1.0, group.from, group.to, false);
    } else {
      group.stop();
    }
  }

  isAnimationEnabled(): boolean {
    return this.animationEnabled;
  }

  // --- Public API matching SpriteEntity ---

  setPositionXYZ(x: number, y: number, z: number): void {
    this._position.set(x, y, z);
    if (this.root) this.root.position.set(x + this.renderOffset, y, z + this.renderOffset);
  }

  get position(): Vector3 { return this._position; }
  set position(pos: Vector3) {
    this._position = pos;
    if (this.root) this.root.position.set(pos.x + this.renderOffset, pos.y, pos.z + this.renderOffset);
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

  updateAnimation(dt: number): void {
    if (!this.root) return;
    const newYaw = rs2Rotation(this._rotationY, this.targetRotationY, dt);
    if (newYaw !== this._rotationY) {
      this._rotationY = newYaw;
      this.root.rotation.y = newYaw;
    }
  }

  updateMovementDirection(dx: number, dz: number, _cameraPos?: Vector3): void {
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
    this.targetRotationY = Math.atan2(dx, dz);
  }

  /** Server-driven yaw target — fed by NPC_FACING so 3D NPCs (rat, cow,
   *  spider, camel) turn to face the player on talk/attack just like
   *  CharacterEntity NPCs do. updateAnimation handles the lerp. */
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
      this.healthBarEl.style.cssText = `position:fixed;pointer-events:none;z-index:150;width:48px;height:8px;background:#400;border:1px solid #000;transform:translate(-50%,-50%);border-radius:1px;overflow:hidden`;
      this.healthBarFillEl = document.createElement('div');
      this.healthBarFillEl.style.cssText = `height:100%;transition:width 0.15s,background 0.15s`;
      this.healthBarEl.appendChild(this.healthBarFillEl);
      this.healthBarTextEl = document.createElement('div');
      this.healthBarTextEl.style.cssText = `position:absolute;top:-1px;left:0;right:0;text-align:center;font-family: Arial, Helvetica, sans-serif;font-size:8px;font-weight:bold;color:#fff;text-shadow:1px 1px 0 #000,-1px -1px 0 #000;line-height:10px;pointer-events:none`;
      this.healthBarEl.appendChild(this.healthBarTextEl);
      document.body.appendChild(this.healthBarEl);
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

  showChatBubble(message: string, duration: number = 5000, variant: 'chat' | 'dialogue' = 'chat'): void {
    this.hideChatBubble();
    const text = message.length > 80 ? message.substring(0, 77) + '...' : message;
    const el = document.createElement('div');
    el.className = variant === 'dialogue' ? 'chat-bubble-overlay dialogue-bubble-overlay' : 'chat-bubble-overlay';
    el.textContent = text;
    const palette = variant === 'dialogue'
      ? `
        background: rgba(43, 10, 8, 0.92); color: #f4ded5;
        border: 1px solid #9a332b;
        box-shadow: 0 2px 8px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,190,150,0.08);
      `
      : `
        background: rgba(0, 0, 0, 0.8); color: #fff;
        border: 1px solid #5a4a35;
      `;
    el.style.cssText = `
      position: fixed; pointer-events: none; z-index: 200;
      ${palette}
      font-family: Arial, Helvetica, sans-serif; font-size: 13px;
      padding: 4px 10px; border-radius: 6px;
      white-space: nowrap;
      transform: translate(-50%, -100%);
      text-shadow: 1px 1px 1px rgba(0,0,0,0.5);
    `;
    document.body.appendChild(el);
    this.chatBubbleEl = el;
    this.chatBubbleTimer = window.setTimeout(() => this.hideChatBubble(), duration);
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
  getMesh(): any { return this.meshes[0] ?? null; }

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
