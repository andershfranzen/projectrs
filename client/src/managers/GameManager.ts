import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3, Color3, Color4, Matrix, Quaternion } from '@babylonjs/core/Maths/math';
import { Viewport } from '@babylonjs/core/Maths/math.viewport';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import '@babylonjs/loaders/glTF';
import { ChunkManager } from '../rendering/ChunkManager';
import { GameCamera } from '../rendering/Camera';
import { SpriteEntity } from '../rendering/SpriteEntity';
import { CharacterEntity, loadGearTemplate, type GearDef, type GearTemplate } from '../rendering/CharacterEntity';
import { Npc3DEntity } from '../rendering/Npc3DEntity';
import { WorldObjectModels } from '../rendering/WorldObjectModels';
import { EntityManager, type GroundItemData } from './EntityManager';
import { InputManager } from './InputManager';
import { NetworkManager } from './NetworkManager';
import { findPath } from '../rendering/Pathfinding';
import { SidePanel } from '../ui/SidePanel';
import { ChatPanel } from '../ui/ChatPanel';
import { GearDebugPanel } from '../ui/GearDebugPanel';
import { BoneDebugPanel } from '../ui/BoneDebugPanel';
import { ArmorBrowserPanel } from '../ui/ArmorBrowserPanel';
import { Minimap } from '../ui/Minimap';
// StatsPanel removed — HP now shown in side panel
import { ShopPanel, type ShopItem } from '../ui/ShopPanel';
import { CharacterCreator } from '../ui/CharacterCreator';
import { LoadingScreen } from '../ui/LoadingScreen';
import { SmithingPanel } from '../ui/SmithingPanel';
import { NPC_NAMES } from '../data/NpcConfig';
import { EQUIP_SLOT_BONES, EQUIP_SLOT_NAMES, TOOL_TIER_METAL_COLOR, type GearOverride } from '../data/EquipmentConfig';
import { ServerOpcode, ClientOpcode, encodePacket, ALL_SKILLS, SKILL_NAMES, ASSET_TO_OBJECT_DEF, WallEdge, decodeStringPacket, BIOME_CELL_SIZE, type WorldObjectDef, type ItemDef, type InventorySlot, type PlayerAppearance, type BiomesFile, type BiomeDef } from '@projectrs/shared';

export class GameManager {
  private engine: Engine;
  private scene: Scene;
  private camera: GameCamera;
  private chunkManager: ChunkManager;
  private inputManager: InputManager;
  private network: NetworkManager;

  // Auth
  private token: string;
  private username: string;

  // Resize handling — CSS grid reflows (eg. DevTools open/close) don't always fire window.resize
  private resizeObserver: ResizeObserver | null = null;
  private onWindowResize: (() => void) | null = null;

  // Local player
  private localPlayer: CharacterEntity | null = null;
  private localPlayerId: number = -1;
  private loadingScreen: LoadingScreen | null = null;
  private currentFloor: number = 0;
  private playerX: number = 512;
  private playerZ: number = 512;
  private playerHealth: number = 10;
  private playerMaxHealth: number = 10;

  // Movement — tick-aligned tile stepping (RS-style)
  private path: { x: number; z: number }[] = [];
  private pathIndex: number = 0;
  private moveSpeed: number = 1.67; // RS2 walk speed: 1 tile per 600ms tick
  private pendingPath: { x: number; z: number }[] | null = null; // queued path from click-while-moving
  private pendingSkill: { objectId: number; variant?: string } | null = null; // deferred skilling until walk finishes
  private skillCancelTime: number = 0; // timestamp when skilling was last cancelled
  private skillingFacingAngle: number = 0; // locked facing angle while skilling
  private tileProgress: number = 0; // 0→1 progress through current tile step
  private tileFrom: { x: number; z: number } = { x: 0, z: 0 }; // where we started this tile step
  private _tempVec: Vector3 = new Vector3(); // reusable temp vector to avoid per-frame allocations
  private _minimapRemotes: { x: number; z: number }[] = [];
  private _minimapNpcs: { x: number; z: number }[] = [];
  private _minimapObjects: { x: number; z: number; category: string }[] = [];
  private _minimapWallFence: { x: number; z: number }[] = [];
  // NOTE: do NOT reuse a single Vector3 for entity positions — the setter stores the reference
  private _overlayVp = new Viewport(0, 0, 1, 1);
  private _overlayTransform = Matrix.Identity();
  private _overlayTransformReady = false;
  private _overlayWorldPos = new Vector3();
  private _overlayScreenPos = new Vector3();

  // Local player equipment tracking (slot index → item ID)
  private localEquipment: Map<number, number> = new Map();

  // Gear — cached templates so the same GLB isn't loaded twice
  private gearTemplateCache: Map<string, GearTemplate> = new Map();
  private gearLoadingPromises: Map<string, Promise<GearTemplate | null>> = new Map();
  private gearOverrides: Map<number, GearOverride> = new Map();

  // Combat follow (local player follows melee target)
  private combatTargetId: number = -1;
  private _combatPathTimer: number = 0;

  // While a COMBAT_HIT splat is delayed to its impact moment, hold off any
  // health-bar updates for the same entity so the bar drops in sync with the
  // splat instead of leading it. Maps entityId → pending timeout handle.
  private pendingHealthApply: Map<number, ReturnType<typeof setTimeout>> = new Map();

  // Character creator
  private characterCreator: CharacterCreator | null = null;
  private localAppearance: PlayerAppearance | null = null;

  // Entity management (remote players, NPCs, ground items, sprites)
  private entities!: EntityManager;

  // World objects
  private worldObjectSprites: Map<number, SpriteEntity> = new Map();
  private worldObjectModels: Map<number, TransformNode> = new Map();
  private worldObjectDefs: Map<number, { defId: number; x: number; z: number; depleted: boolean }> = new Map();
  private doorPivots: Map<number, { pivot: TransformNode; targetAngle: number; currentAngle: number; closedRotY: number }> = new Map();
  private doorTiles: Map<number, [number, number]> = new Map();
  /** Tiles blocked by non-depleted world objects (key = `${tileX},${tileZ}`) */
  private blockedObjectTiles: Set<string> = new Set();
  private objectDefsCache: Map<number, WorldObjectDef> = new Map();
  private itemDefsCache: Map<number, ItemDef> = new Map();
  // Biome fog overrides — loaded per map. Fog lerps toward the biome under the player.
  private biomesFile: BiomesFile | null = null;
  private biomeById: Map<number, BiomeDef> = new Map();
  private fogTargetColor: Color3 = new Color3(0, 0, 0);
  private fogTargetStart = 0;
  private fogTargetEnd = 100;
  private fogCurrentColor: Color3 = new Color3(0, 0, 0);
  private fogCurrentStart = 0;
  private fogCurrentEnd = 100;
  private objectModels!: WorldObjectModels;
  private isSkilling: boolean = false;
  private isIndoors: boolean = false;
  private hiddenRoofNodes: TransformNode[] = [];
  private _lastIndoorTileX: number = -9999;
  private _lastIndoorTileZ: number = -9999;
  private _outdoorFrameCount: number = 0;
  private _lastBiomeCX: number = -9999;
  private _lastBiomeCZ: number = -9999;
  private _lastBiomeDef: BiomeDef | undefined = undefined;
  private _roofDedup: Set<TransformNode> = new Set();
  private skillingObjectId: number = -1;

  // UI
  private destMarker: Mesh | null = null;
  private interactMarker: Mesh | null = null;
  private lastClickX: number = 0;
  private lastClickY: number = 0;
  // Single active cursor-click burst element; new clicks cancel the previous one
  // so there's never more than one on screen at a time.
  private activeClickEffect: { el: HTMLElement; anim: Animation } | null = null;
  private contextMenu: HTMLDivElement | null = null;
  private sidePanel: SidePanel | null = null;
  private chatPanel: ChatPanel | null = null;
  private minimap: Minimap | null = null;
  private gearDebugPanel: GearDebugPanel | null = null;
  private boneDebugPanel: BoneDebugPanel | null = null;
  private armorBrowser: ArmorBrowserPanel | null = null;
  private armorPreviewNodes: Map<string, TransformNode> = new Map();
  private shopPanel: ShopPanel | null = null;
  private smithingPanel: SmithingPanel | null = null;

  // Combat hit splats (HTML overlay)
  private hitSplats: { worldPos: Vector3; el: HTMLDivElement; timer: number; startY: number }[] = [];

  // WASD camera
  private keysDown: Set<string> = new Set();

  constructor(canvas: HTMLCanvasElement, token: string, username: string, onDisconnect?: () => void) {
    (window as any).gm = this;
    this.token = token;
    this.username = username;

    this.engine = new Engine(canvas, false, { antialias: false, adaptToDeviceRatio: false });
    // RS-style chunky pixels: render at half resolution and let the browser
    // upscale the framebuffer with nearest-neighbor (set on canvas via CSS).
    this.engine.setHardwareScalingLevel(1.0);
    canvas.style.imageRendering = 'pixelated';
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true; // Match Three.js coordinate system (KC editor)
    this.scene.clearColor = new Color4(0, 0, 0, 1);
    // Groups 1 (water) and 2 (texture planes) must NOT clear depth — they need terrain depth from group 0
    this.scene.setRenderingAutoClearDepthStencil(1, false, false, false);
    this.scene.setRenderingAutoClearDepthStencil(2, false, false, false);
    // skipPointerMovePicking disabled — InputManager relies on pointer events

    // Disable unused Babylon subsystems to skip per-frame checks
    this.scene.lensFlaresEnabled = false;
    this.scene.particlesEnabled = false;
    this.scene.spritesEnabled = false;
    this.scene.proceduralTexturesEnabled = false;
    this.scene.physicsEnabled = false;
    this.scene.postProcessesEnabled = false;
    this.scene.probesEnabled = false;
    this.scene.audioEnabled = false;

    // Lighting — matched to KC editor's Three.js scene for correct terrain colors
    const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), this.scene);
    ambient.intensity = 0.9;
    ambient.diffuse = new Color3(0.54, 0.54, 0.54);
    ambient.groundColor = new Color3(0.35, 0.33, 0.30);
    const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, -0.3), this.scene);
    sun.intensity = 1.1;
    sun.diffuse = new Color3(1.0, 0.84, 0.54);
    const fill = new DirectionalLight('fill', new Vector3(0.3, -0.6, 0.5), this.scene);
    fill.intensity = 0.65;
    fill.diffuse = new Color3(0.67, 0.73, 0.80);

    // Camera
    this.camera = new GameCamera(this.scene, canvas);

    // Chunk-based terrain
    this.chunkManager = new ChunkManager(this.scene);

    // Destination marker
    this.createDestinationMarker();

    // Input — left click for movement (picks against chunk ground meshes)
    this.inputManager = new InputManager(this.scene, this.chunkManager);
    this.inputManager.setGroundClickHandler((worldX, worldZ) => {
      this.handleGroundClick(worldX, worldZ);
    });
    this.inputManager.setTeleportClickHandler((worldX, worldZ) => {
      console.log(`[DEBUG] Shift+click teleport to ${worldX.toFixed(1)}, ${worldZ.toFixed(1)}`);
      this.network.sendChat(`/tp ${worldX.toFixed(1)} ${worldZ.toFixed(1)}`);
    });
    this.inputManager.setObjectClickHandler((objectEntityId) => {
      this.handleObjectClick(objectEntityId);
    });
    this.inputManager.setIndoorCheck(() => ({
      indoors: this.isIndoors,
      playerY: this.localPlayer?.position.y ?? this.getHeight(this.playerX, this.playerZ),
    }));

    // Track left-click position so per-handler bursts fire at the right pixel.
    // Capture phase ensures this runs before InputManager's pointerdown handler,
    // which would otherwise pick + dispatch using stale lastClickX/Y from the
    // previous click.
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.lastClickX = e.clientX;
      this.lastClickY = e.clientY;
    }, true);

    // Right-click context menu for NPCs/items
    this.setupContextMenu(canvas);

    // WASD keyboard controls
    this.setupKeyboard();

    // Network
    this.network = new NetworkManager();
    this.setupNetworkHandlers();
    this.network.connect(token);
    if (onDisconnect) {
      this.network.onDisconnect(onDisconnect);
    }

    // HUD
    this.createHUD();
    this.sidePanel = new SidePanel(this.network, this.token);
    this.chatPanel = new ChatPanel();
    this.chatPanel.setSendHandler((msg) => {
      if (!this.handleChatCommand(msg)) {
        this.network.sendChat(msg);
      }
    });
    this.shopPanel = new ShopPanel(this.network, this.itemDefsCache);
    this.shopPanel.setOnClose(() => {
      this.sidePanel?.setSellCallback(null);
    });
    this.smithingPanel = new SmithingPanel();
    this.chatPanel.addSystemMessage(`Welcome to evilMUD!`);
    this.chatPanel.addSystemMessage(`You last logged in from: ${window.location.hostname}`);

    // Chat message handler
    this.network.onChat((data) => {
      switch (data.type) {
        case 'player_info': {
          const entityId = data.entityId!;
          const name = data.name!;
          this.entities.playerNames.set(entityId, name);
          this.entities.nameToEntityId.set(name.toLowerCase(), entityId);
          const existing = this.entities.remotePlayers.get(entityId);
          if (existing) {
            const target = this.entities.remoteTargets.get(entityId);
            existing.dispose();
            const sprite = new SpriteEntity(this.scene, {
              name: `player_${entityId}`,
              color: new Color3(0.8, 0.2, 0.2),
              label: name,
              labelColor: '#ffffff',
            });
            if (target) {
              sprite.position = new Vector3(target.x, this.getHeight(target.x, target.z), target.z);
            }
            this.entities.remotePlayers.set(entityId, sprite);
          }
          break;
        }
        case 'local': {
          if (this.chatPanel) {
            this.chatPanel.addMessage(data.from || '???', data.message, '#fff');
          }
          this.showPlayerChatBubble(data.from || '', data.message);
          break;
        }
        case 'private':
          if (this.chatPanel) this.chatPanel.addMessage(`[PM] ${data.from}`, data.message, '#c0f');
          break;
        case 'private_sent':
          if (this.chatPanel) this.chatPanel.addMessage(`[PM] To ${data.to}`, data.message, '#c0f');
          break;
        case 'system':
          if (this.chatPanel) this.chatPanel.addSystemMessage(data.message, '#ff0');
          break;
      }
    });

    // When a chunk's placed objects finish loading, link them to world entities.
    // Also force a re-eval of indoor state: if a roof / upper-floor chunk
    // streamed in *after* the player arrived at their current tile, the new
    // mesh wasn't in hiddenRoofNodes and renders un-hidden until the player
    // walks to a new tile. Resetting the indoor tile cursor makes the next
    // frame recompute the hidden set.
    this.chunkManager.setOnChunkObjectsLoaded(() => {
      this.linkPlacedObjectsToWorldObjects();
      this.cleanupDisposedWorldObjects();
      // Force the next frame to recompute hiddenRoofNodes — covers a roof's
      // chunk loading after the player has already settled on a tile.
      this._lastIndoorTileX = -9999;
      this._lastIndoorTileZ = -9999;
      // …and apply the hide synchronously RIGHT NOW so the streamed mesh
      // never renders even for a frame. Otherwise we'd see a brief flash of
      // the upper-floor surface before updateIndoorDetection runs next tick.
      if (this.isIndoors) this.recomputeHiddenRoofs();
      // Spawn-Y comes from LOGIN_OK now — no client-side re-snap needed.
      // The previous re-snap loop dropped players: getHeight() returns the
      // elevated value only when `currentY > elevH - 1.5`, but during
      // handleMapChange's re-load cycle elevatedFloorHeights is briefly
      // empty, so getHeight returns terrain (0) and snapped the player
      // down — and once at Y=0 the gate stays failed permanently.
    });

    // Load map, then tell server we're ready for entity data
    this.chunkManager.loadMap('kcmap').then(async () => {
      await this.loadBiomes('kcmap');
      this.applyFog();
      this.network.sendRaw(encodePacket(ClientOpcode.MAP_READY));
      this.repositionWorldObjects();
    });
    this.loadObjectDefs();
    this.objectModels = new WorldObjectModels(this.scene, (x, z) => this.getHeight(x, z), this.objectDefsCache);
    this.objectModels.loadAll();
    this.entities = new EntityManager(this.scene, (x, z, cy) => this.getHeightAt(x, z, cy), this.itemDefsCache);
    this.entities.loadPlayerSprites();
    this.entities.loadNpcSprites();

    // FPS counter (remove stale element from HMR reload)
    document.getElementById('fps-counter')?.remove();
    const fpsEl = document.createElement('div');
    fpsEl.id = 'fps-counter';
    fpsEl.style.cssText = 'position:fixed;top:4px;left:50%;transform:translateX(-50%);color:#0f0;font:bold 14px monospace;z-index:9999;text-shadow:1px 1px 0 #000;pointer-events:none';
    document.body.appendChild(fpsEl);
    let fpsFrames = 0, fpsLast = performance.now();

    // Game loop
    let lastTime = performance.now();
    this.engine.runRenderLoop(() => {
      // Belt-and-suspenders resize: if the canvas CSS size drifted from the render
      // buffer size (e.g. ResizeObserver was throttled or the container reflowed
      // mid-frame), fix it here before rendering.
      const dpr = window.devicePixelRatio || 1;
      const expectedW = Math.round(canvas.clientWidth * dpr);
      const expectedH = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== expectedW || canvas.height !== expectedH) {
        this.engine.resize();
      }

      const now = performance.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;
      this.update(dt);
      this.scene.render();

      fpsFrames++;
      if (now - fpsLast >= 1000) {
        fpsEl.textContent = `${fpsFrames} FPS | ${this.scene.getActiveMeshes().length} meshes`;
        fpsFrames = 0;
        fpsLast = now;
      }
    });

    // Resize on window changes AND on canvas-element changes (catches CSS grid reflows
    // like opening DevTools or panel toggles that don't fire a window.resize event).
    this.onWindowResize = () => this.engine.resize();
    window.addEventListener('resize', this.onWindowResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.engine.resize());
      this.resizeObserver.observe(canvas);
    }
  }

  /** Height query for the local player. Uses local player Y as gate input. */
  private getHeight(x: number, z: number): number {
    return this.chunkManager.getEffectiveHeight(x, z, undefined, this.localPlayer?.position.y);
  }

  /** Height query for arbitrary entities (NPCs, remote players, ground items).
   *  Each caller passes its OWN current Y as the gate input — without this,
   *  the local-player Y leaks into other entities and a rat in the basement
   *  gets snapped up to the floor above when the player walks up there. */
  private getHeightAt(x: number, z: number, currentY?: number): number {
    return this.chunkManager.getEffectiveHeight(x, z, undefined, currentY);
  }

  private applyFog(): void {
    const meta = this.chunkManager.getMeta();
    if (!meta) return;

    const c = new Color3(meta.fogColor[0], meta.fogColor[1], meta.fogColor[2]);
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    // Apply darkening to BOTH fog and void so the fog→void transition is
    // seamless (same hue, same brightness).
    const voidDarken = 0.5;
    this.scene.fogColor = new Color3(c.r * voidDarken, c.g * voidDarken, c.b * voidDarken);
    this.scene.fogStart = meta.fogStart;
    this.scene.fogEnd = meta.fogEnd;
    this.scene.clearColor = new Color4(c.r * voidDarken, c.g * voidDarken, c.b * voidDarken, 1.0);
    // Seed fog state so updateFog has a starting point that matches the map default.
    this.fogTargetColor = c.clone();
    this.fogCurrentColor = c.clone();
    this.fogTargetStart = meta.fogStart;
    this.fogCurrentStart = meta.fogStart;
    this.fogTargetEnd = meta.fogEnd;
    this.fogCurrentEnd = meta.fogEnd;
  }

  private async loadBiomes(mapId: string): Promise<void> {
    this.biomesFile = null;
    this.biomeById.clear();
    this._lastBiomeCX = -9999;
    this._lastBiomeCZ = -9999;
    this._lastBiomeDef = undefined;
    try {
      const res = await fetch(`/maps/${mapId}/biomes.json`);
      if (!res.ok) return;
      const file: BiomesFile = await res.json();
      this.biomesFile = file;
      for (const def of file.defs) this.biomeById.set(def.id, def);
    } catch {
      // No biomes.json → use map meta fog only
    }
  }

  /** Lerp scene fog toward the biome under the player (or meta default). */
  private updateFog(dt: number): void {
    const meta = this.chunkManager.getMeta();
    if (!meta) return;

    // Pick target biome from cell under player
    let targetColor: [number, number, number] = meta.fogColor;
    let targetStart = meta.fogStart;
    let targetEnd = meta.fogEnd;
    if (this.biomesFile) {
      const cx = Math.floor(this.playerX / BIOME_CELL_SIZE);
      const cz = Math.floor(this.playerZ / BIOME_CELL_SIZE);
      if (cx !== this._lastBiomeCX || cz !== this._lastBiomeCZ) {
        this._lastBiomeCX = cx;
        this._lastBiomeCZ = cz;
        const id = this.biomesFile.cells[`${cx},${cz}`];
        this._lastBiomeDef = id != null ? this.biomeById.get(id) : undefined;
      }
      const biome = this._lastBiomeDef;
      if (biome) {
        targetColor = biome.fogColor;
        targetStart = biome.fogStart;
        targetEnd = biome.fogEnd;
      }
    }
    this.fogTargetColor.set(targetColor[0], targetColor[1], targetColor[2]);
    this.fogTargetStart = targetStart;
    this.fogTargetEnd = targetEnd;

    // Exponential approach. With per-tile biome cells the player crosses biome
    // boundaries frequently, so transitions are slowed to feel ambient instead
    // of snappy. k=1.5 reaches ~99% of target in ~3s.
    const k = 1.5;
    const t = 1 - Math.exp(-k * dt);
    this.fogCurrentColor.r += (this.fogTargetColor.r - this.fogCurrentColor.r) * t;
    this.fogCurrentColor.g += (this.fogTargetColor.g - this.fogCurrentColor.g) * t;
    this.fogCurrentColor.b += (this.fogTargetColor.b - this.fogCurrentColor.b) * t;
    this.fogCurrentStart += (this.fogTargetStart - this.fogCurrentStart) * t;
    this.fogCurrentEnd += (this.fogTargetEnd - this.fogCurrentEnd) * t;

    this.scene.fogStart = this.fogCurrentStart;
    this.scene.fogEnd = this.fogCurrentEnd;
    // Both fog and void use the same darkened biome color so the transition
    // is seamless and the world reads as twilight rather than two distinct zones.
    const voidDarken = 0.5;
    const r = this.fogCurrentColor.r * voidDarken;
    const g = this.fogCurrentColor.g * voidDarken;
    const b = this.fogCurrentColor.b * voidDarken;
    this.scene.fogColor.set(r, g, b);
    this.scene.clearColor.set(r, g, b, 1.0);
  }

  private async loadObjectDefs(): Promise<void> {
    try {
      const res = await fetch('/data/objects.json');
      const defs: WorldObjectDef[] = await res.json();
      for (const def of defs) {
        this.objectDefsCache.set(def.id, def);
      }
      this.rebuildBlockedObjectTiles();
    } catch (e) {
      console.warn('Failed to load object definitions:', e);
    }
    try {
      const res = await fetch('/data/items.json');
      const defs: ItemDef[] = await res.json();
      for (const def of defs) {
        this.itemDefsCache.set(def.id, def);
      }
      if (this.sidePanel) this.sidePanel.setItemDefs(this.itemDefsCache);
    } catch (e) {
      console.warn('Failed to load item definitions:', e);
    }
    try {
      const res = await fetch('/data/gear-overrides.json');
      const overrides: Record<string, GearOverride> = await res.json();
      this.gearOverrides.clear();
      for (const [id, override] of Object.entries(overrides)) {
        this.gearOverrides.set(Number(id), override);
      }
      console.log(`[Gear] Loaded ${this.gearOverrides.size} gear overrides`);
    } catch (e) {
      console.warn('Failed to load gear overrides:', e);
    }
  }

  /** Rebuild blockedObjectTiles from all known world objects. */
  private rebuildBlockedObjectTiles(): void {
    this.blockedObjectTiles.clear();
    for (const [, data] of this.worldObjectDefs) {
      const def = this.objectDefsCache.get(data.defId);
      if (def?.blocking && !data.depleted) {
        const bx = Math.floor(data.x);
        const bz = Math.floor(data.z);
        if (def.category === 'tree') {
          // Trees block a 2x2 area around their trunk
          for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
            this.blockedObjectTiles.add(`${bx + dx},${bz + dz}`);
          }
        } else {
          this.blockedObjectTiles.add(`${bx},${bz}`);
        }
      }
    }
  }

  // Fraction (0–1) of the attack animation duration where the hit visually lands.
  // Tune per anim by watching the GLB and noting when the weapon reaches its
  // forward extreme. Auto-scales with anim duration on re-export.
  private static readonly ATTACK_IMPACT_FRACTION: Record<string, number> = {
    attack_slash:            0.5,
    attack_slash_aggressive: 0.5,
    attack_2h_slash:         0.5,
    attack_punch:            0.4,
    kick:                    0.5,
    bow_attack:              0.6,
  };

  /**
   * Choose the correct attack animation name based on stance and weapon.
   * - Weapon + aggressive stance → 'attack_slash_aggressive' (hand-authored slash)
   * - Weapon + any other stance  → 'attack_slash' (default downward)
   * - No weapon + aggressive     → 'kick'
   * - No weapon + other stance   → 'attack_punch'
   * For remote players, always use 'attack_punch' (we don't know their stance/equip).
   */
  private getPlayerAttackAnimName(attackerId: number): string {
    if (attackerId === this.localPlayerId && this.sidePanel) {
      const weaponId = this.sidePanel.getEquipItem(0);
      const stance = this.sidePanel.getStance();
      if (weaponId > 0) {
        const weaponDef = this.itemDefsCache.get(weaponId);
        const style = weaponDef?.weaponStyle;
        if (style === 'bow' || style === 'crossbow') return 'bow_attack';
        if (weaponDef?.twoHanded) return 'attack_2h_slash';
        return stance === 'aggressive' ? 'attack_slash_aggressive' : 'attack_slash';
      }
      if (stance === 'aggressive') return 'kick';
      return 'attack_punch';
    }
    return 'attack_punch';
  }

  /** Reposition all world objects/models after heightmap loads (fixes race condition) */
  private repositionWorldObjects(): void {
    for (const [objectEntityId, data] of this.worldObjectDefs) {
      const h = this.getHeight(data.x, data.z);
      const doorEntry = this.doorPivots.get(objectEntityId);
      if (doorEntry) {
        doorEntry.pivot.position.y = h;
      } else {
        const model = this.worldObjectModels.get(objectEntityId);
        if (model) {
          model.position.y = h;
        }
      }
      const sprite = this.worldObjectSprites.get(objectEntityId);
      if (sprite) {
        sprite.position = new Vector3(data.x, h, data.z);
      }
    }
    this.entities.repositionEntities(this.playerX, this.playerZ, this.localPlayer);
  }

  /** Clean up world object references to disposed placed nodes (after chunk unload) */
  private cleanupDisposedWorldObjects(): void {
    for (const [entityId, node] of this.worldObjectModels) {
      if (node.isDisposed()) {
        this.worldObjectModels.delete(entityId);
        this.objectModels.deleteStump(entityId);
        const doorEntry = this.doorPivots.get(entityId);
        if (doorEntry) {
          doorEntry.pivot.dispose();
          this.doorPivots.delete(entityId);
        }
      }
    }
  }

  /** Link placed GLB objects to server world objects after map finishes loading */
  private linkPlacedObjectsToWorldObjects(): void {
    let linked = 0;
    for (const [objectEntityId, data] of this.worldObjectDefs) {
      if (this.worldObjectModels.has(objectEntityId)) continue;
      const placedNode = this.chunkManager.findPlacedObjectNear(data.x, data.z, 1.5, data.defId);
      if (placedNode) {
        this.linkPlacedNodeToEntity(objectEntityId, data, placedNode);
        linked++;
      }
    }
  }

  /** Link a placed GLB node to a world object entity, tagging for picking and handling depletion */
  private linkPlacedNodeToEntity(
    objectEntityId: number,
    data: { defId: number; x: number; z: number; depleted: boolean },
    placedNode: TransformNode,
  ): void {
    this.worldObjectModels.set(objectEntityId, placedNode);
    if (!placedNode.metadata) placedNode.metadata = {};
    placedNode.metadata.objectEntityId = objectEntityId;
    for (const child of placedNode.getChildMeshes(false)) {
      if (!child.metadata) child.metadata = {};
      child.metadata.objectEntityId = objectEntityId;
    }
    for (const child of placedNode.getChildTransformNodes(false)) {
      if (!child.metadata) child.metadata = {};
      child.metadata.objectEntityId = objectEntityId;
    }

    const def = this.objectDefsCache.get(data.defId);
    if (def?.category === 'door') {
      // Set up wall edges now that we have the model rotation
      const rotEdge = this.computeDoorEdgeFromModel(placedNode);
      const tx = Math.floor(data.x), tz = Math.floor(data.z);
      const fracX = data.x - tx, fracZ = data.z - tz;
      const wallEdge = (rotEdge === WallEdge.N || rotEdge === WallEdge.S)
        ? (fracZ > 0.5 ? WallEdge.S : WallEdge.N)
        : (fracX > 0.5 ? WallEdge.E : WallEdge.W);
      this.doorTiles.set(objectEntityId, [tx, tz]);
      const nbLookup: Record<number, { dx: number; dz: number; opposite: number }> = {
        [WallEdge.N]: { dx: 0, dz: -1, opposite: WallEdge.S },
        [WallEdge.S]: { dx: 0, dz: 1, opposite: WallEdge.N },
        [WallEdge.E]: { dx: 1, dz: 0, opposite: WallEdge.W },
        [WallEdge.W]: { dx: -1, dz: 0, opposite: WallEdge.E },
      };
      const nb = nbLookup[wallEdge];
      // Wall mask for the door tile is set up by the chunk's wall data —
      // we just need to flip openDoorEdges to match the current state.
      // Keeping the wall mask permanent ensures the elevation gate in
      // wallEdgeBlocksAtHeight can block wrong-elevation passage.
      this.chunkManager.setWall(tx, tz, this.chunkManager.getWallRawPublic(tx, tz) | wallEdge);
      if (nb) {
        const nx = tx + nb.dx, nz = tz + nb.dz;
        this.chunkManager.setWall(nx, nz, this.chunkManager.getWallRawPublic(nx, nz) | nb.opposite);
      }
      if (data.depleted) {
        this.chunkManager.setOpenDoorEdges(tx, tz, wallEdge, true);
        if (nb) this.chunkManager.setOpenDoorEdges(tx + nb.dx, tz + nb.dz, nb.opposite, true);
      }
      this.setupDoorPivot(objectEntityId);
      // Doors stay visible regardless of depleted state
    } else {
      if (data.depleted) placedNode.setEnabled(false);
      if (data.depleted) {
        this.objectModels.createDepletedModel(objectEntityId, data.defId, placedNode);
      }
    }

    const sprite = this.worldObjectSprites.get(objectEntityId);
    if (sprite) {
      sprite.dispose();
      this.worldObjectSprites.delete(objectEntityId);
    }
  }

  /** Create a depleted model (stump/depleted rock) at the placed node's position */
  private setupKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      this.keysDown.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => {
      this.keysDown.delete(e.key.toLowerCase());
    });
  }

  /**
   * Equip or unequip a 3D gear piece on the local player.
   * Loads /assets/equipment/{slotName}/{itemId}.glb on demand, caches the template.
   * itemId = 0 or -1 means unequip.
   */
  private async equipGear(slotIndex: number, itemId: number): Promise<void> {
    if (!this.localPlayer) return;
    const slotName = EQUIP_SLOT_NAMES[slotIndex];
    if (!slotName) return;

    // Unequip
    if (itemId <= 0) {
      this.localPlayer.detachGear(slotName);
      this.localPlayer.detachSkinnedArmor(slotName);
      this.disposeArmorSlot(slotName);
      return;
    }

    // Already wearing this item?
    if (this.localPlayer.getGearItemId(slotName) === itemId) return;

    const cacheKey = `${slotName}/${itemId}`;
    const boneConfig = EQUIP_SLOT_BONES[slotName];
    if (!boneConfig) return;

    // Clear cache for this item so rotation changes take effect immediately
    this.gearTemplateCache.delete(cacheKey);

    // Check cache first (only non-skinned gear is cached as templates)
    let template = this.gearTemplateCache.get(cacheKey);
    if (!template) {
      let promise = this.gearLoadingPromises.get(cacheKey);
      if (!promise) {
        promise = (async () => {
          const override = this.gearOverrides.get(itemId);
          const itemDef = this.itemDefsCache.get(itemId);
          // Resolution order:
          //  1. gear-overrides.json `file` (legacy/per-instance override)
          //  2. items.json `model` field — absolute path if it starts with '/',
          //     else resolved relative to /assets/equipment/{slot}/
          //  3. Fallback: /assets/equipment/{slot}/{itemId}.glb
          let gearFile: string;
          if (override?.file) {
            gearFile = override.file;
          } else if (itemDef?.model) {
            gearFile = itemDef.model.startsWith('/')
              ? itemDef.model
              : `/assets/equipment/${slotName}/${itemDef.model}`;
          } else {
            gearFile = `/assets/equipment/${slotName}/${itemId}.glb`;
          }
          const gearDef: GearDef = {
            itemId,
            file: gearFile,
            boneName: override?.boneName ?? boneConfig.boneName,
            localPosition: override?.localPosition ?? boneConfig.localPosition,
            localRotation: override?.localRotation ?? boneConfig.localRotation,
            scale: override?.scale ?? boneConfig.scale,
            centerOrigin: override?.centerOrigin ?? false,
            metalColor: TOOL_TIER_METAL_COLOR[itemId],
          };
          const tmpl = await this.loadGearSmart(slotName, itemId, gearDef);
          if (tmpl) {
            this.gearTemplateCache.set(cacheKey, tmpl);
            console.log(`[Gear] Loaded ${slotName} item ${itemId}`);
          }
          this.gearLoadingPromises.delete(cacheKey);
          return tmpl;
        })();
        this.gearLoadingPromises.set(cacheKey, promise);
      }
      template = (await promise) ?? undefined;
    }

    // null template means the skinned path was used (or load failed)
    if (template && this.localPlayer) {
      this.localPlayer.attachGear(slotName, itemId, template);
    }
  }

  /**
   * Load a gear GLB. If it has a skeleton, set it up as skinned armor
   * (bone-sync per frame) and return null. Otherwise return a GearTemplate
   * for bone-parenting.
   */
  private async loadGearSmart(slotName: string, itemId: number, def: GearDef): Promise<GearTemplate | null> {
    try {
      const lastSlash = def.file.lastIndexOf('/');
      const dir = def.file.substring(0, lastSlash + 1);
      const file = def.file.substring(lastSlash + 1);
      const result = await SceneLoader.ImportMeshAsync('', dir, file, this.scene);

      // Fallback: if Babylon's glTF loader didn't attach a skeleton (rare —
      // some Blender-exported GLBs trip the skin auto-detection), re-parse the
      // GLB ourselves and graft the JOINTS_0/WEIGHTS_0 attributes onto the
      // imported meshes for slots that need skinning. attachSkinnedArmor's
      // name-based bone remap then handles the bind to our character skeleton.
      const SKINNED_SLOTS: ReadonlySet<string> = new Set(['body', 'legs', 'hands', 'feet', 'cape']);
      if (
        result.skeletons.length === 0 &&
        SKINNED_SLOTS.has(slotName) &&
        this.localPlayer
      ) {
        const ok = await this.localPlayer.attachManualSkinnedArmor(slotName, def.file, result.meshes, itemId);
        if (ok) {
          const loaderRoot = result.meshes.find(m => m.name === '__root__');
          if (loaderRoot) loaderRoot.dispose();
          return null;
        }
      }

      if (result.skeletons.length > 0 && this.localPlayer) {
        // Convert PBR → flat for all skinned armor meshes
        for (const mesh of result.meshes) {
          const pbrMat = mesh.material as any;
          if (!pbrMat || !pbrMat.getClassName || pbrMat.getClassName() !== 'PBRMaterial') continue;
          const flat = new StandardMaterial(`${pbrMat.name}_flat`, this.scene);
          if (pbrMat.albedoTexture) flat.diffuseTexture = pbrMat.albedoTexture;
          if (pbrMat.albedoColor) {
            const b = 1.3;
            flat.diffuseColor = new Color3(
              Math.min(1, pbrMat.albedoColor.r * b),
              Math.min(1, pbrMat.albedoColor.g * b),
              Math.min(1, pbrMat.albedoColor.b * b),
            );
          }
          flat.specularColor = Color3.Black();
          const dc = flat.diffuseColor;
          flat.emissiveColor = new Color3(dc.r * 0.55, dc.g * 0.55, dc.b * 0.55);
          flat.backFaceCulling = pbrMat.backFaceCulling ?? true;
          mesh.material = flat;
        }

        // Head slot: bone-parent to Head bone instead of skinned attachment.
        // Helmets are rigid — skinned rendering causes drift vs the head mesh.
        if (slotName === 'head') {
          // Get the Head bone's bind-pose position from the armor skeleton's IBM
          // so we can offset the mesh vertices to bone-local space.
          const armorSkel = result.skeletons[0];
          const headBone = armorSkel.bones.find(b => b.name === 'mixamorig:Head');
          let headBindY = 0;
          if (headBone) {
            const tn = headBone.getTransformNode();
            if (tn) {
              tn.computeWorldMatrix(true);
              headBindY = tn.absolutePosition.y;
            }
          }
          for (const sk of result.skeletons) sk.dispose();
          for (const mesh of result.meshes) mesh.skeleton = null;
          def.boneName = 'mixamorig:Head';
          def.centerOrigin = true;
          // Shift mesh children so the head-height vertices sit at bone origin
          const tmpl = this.buildGearTemplateFromResult(result, def);
          for (const child of tmpl.template.getChildren()) {
            (child as TransformNode).position.y -= headBindY;
          }
          return tmpl;
        }

        this.localPlayer.detachGear(slotName);
        this.disposeArmorSlot(slotName);

        this.localPlayer.attachSkinnedArmor(slotName, result.meshes, result.skeletons[0], itemId);
        const loaderRoot = result.meshes.find(m => m.name === '__root__');
        if (loaderRoot) loaderRoot.dispose();

        // Apply saved override transforms for fine-tuning fit
        const override = this.gearOverrides.get(itemId);
        if (override) {
          this.localPlayer.applySkinnedArmorTransform(slotName, override);
        }

        console.log(`[Gear] Loaded skinned ${slotName} item ${itemId}`);
        return null;
      }

      // Non-skinned — build GearTemplate from the loaded result
      return this.buildGearTemplateFromResult(result, def);
    } catch (e) {
      console.warn(`[Gear] Failed to load '${def.file}':`, e);
      return null;
    }
  }

  private buildGearTemplateFromResult(
    result: { meshes: import('@babylonjs/core/Meshes/abstractMesh').AbstractMesh[] },
    def: GearDef,
  ): GearTemplate {
    const root = new TransformNode(`gearTemplate_${def.itemId}`, this.scene);
    for (const mesh of result.meshes) {
      if (!mesh.parent || mesh.parent.name === '__root__') mesh.parent = root;
    }

    // PBR → flat conversion (matches main character + skinned-armor paths so the
    // gear-color texture-swap system can apply uniformly). Polytope-derived
    // gear ships with `genericRGBMat_Objects` materials; we register those with
    // the local player so future gearColor changes update them.
    for (const mesh of result.meshes) {
      const pbr = mesh.material as any;
      if (!pbr || !pbr.getClassName || pbr.getClassName() !== 'PBRMaterial') continue;
      const flat = new StandardMaterial(`${pbr.name}_flat`, this.scene);
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
        // Polysplit palette textures sample much brighter than RS-style gear;
        // scale down so they sit at the same value range as the rest of the world.
        flat.diffuseColor = new Color3(0.55, 0.55, 0.55);
      }
      flat.specularColor = Color3.Black();
      if (!hasTexture) {
        const dc = flat.diffuseColor;
        flat.emissiveColor = new Color3(dc.r * 0.55, dc.g * 0.55, dc.b * 0.55);
      }
      flat.backFaceCulling = pbr.backFaceCulling ?? true;
      mesh.material = flat;
      if (isPolysplitGear) {
        this.localPlayer?.registerObjectMaterial(flat);
      }
    }

    if (def.metalColor) {
      const [r, g, b] = def.metalColor;
      const tint = new Color3(r, g, b);
      const recolored = new Set<string>();
      for (const mesh of result.meshes) {
        const mat = mesh.material as any;
        if (!mat || !mat.name) continue;
        if (!mat.name.includes('Material.002')) continue;
        const clonedName = `${mat.name}_tint_${def.itemId}`;
        let cloned: any;
        if (recolored.has(clonedName)) {
          cloned = this.scene.getMaterialByName(clonedName);
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

    if (!def.centerOrigin) {
      let minY = Infinity;
      for (const mesh of result.meshes) {
        if (mesh.getTotalVertices() === 0) continue;
        mesh.computeWorldMatrix(true);
        const bb = mesh.getBoundingInfo().boundingBox;
        if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
      }
      for (const child of root.getChildren()) {
        (child as TransformNode).position.y -= minY;
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
    };
  }

  private disposeArmorSlot(slot: string): void {
    const node = this.armorPreviewNodes.get(slot);
    if (node) { node.dispose(); this.armorPreviewNodes.delete(slot); }
  }

  private createLocalCharacterEntity(): CharacterEntity {
    return new CharacterEntity(this.scene, {
      name: 'localPlayer',
      modelPath: '/Character models/main character.glb',
      targetHeight: 1.53,
      label: this.username,
      labelColor: '#00ff00',
      // Each GLB should hold a single action; the runtime picks it automatically
      // so re-exports don't require renaming the action in Blender first.
      additionalAnimations: [
        { name: 'idle',                    path: '/Character models/new animations/idle.glb' },
        { name: 'walk',                    path: '/Character models/new animations/walk.glb' },
        // Armed attack — non-aggressive stances use the default downward slash;
        // aggressive stance uses the hand-authored OSRS-style slash.
        { name: 'attack_slash',            path: '/Character models/new animations/standing_melee_attack_downward.glb' },
        { name: 'attack_slash_aggressive', path: '/Character models/new animations/attack_slash.glb' },
        { name: 'attack_2h_slash',         path: '/Character models/new animations/2h slash.glb' },
        // Unarmed attack — getPlayerAttackAnimName returns 'attack_punch' when no weapon
        { name: 'attack_punch',            path: '/Character models/new animations/attack_punch.glb' },
        { name: 'chop',                    path: '/Character models/new animations/woodcutting.glb' },
        { name: 'mine',                    path: '/Character models/new animations/great_sword_slash.glb' },
      ],
    });
  }

  private setupNetworkHandlers(): void {
    this.setupAuthHandlers();
    this.setupEntitySyncHandlers();
    this.setupCombatHandlers();
    this.setupWorldObjectHandlers();
    this.setupPlayerStateHandlers();
    this.setupMapHandlers();
  }

  private setupAuthHandlers(): void {
    this.network.on(ServerOpcode.LOGIN_OK, (_op, v) => {
      this.localPlayerId = v[0];
      this.playerX = v[1] / 10;
      this.playerZ = v[2] / 10;
      // Server-authored spawn Y (effective walking height at our tile/floor).
      // Trust this over locally-computed getHeight: on initial spawn the
      // client's elevatedFloorHeights gates elevation reveal on currentY,
      // which is 0 — so a saved player on an elevated tile would otherwise
      // drop to the lower terrain.
      const spawnY = (v[3] ?? 0) / 10;
      this.network.setLocalPlayerId(this.localPlayerId);

      this.loadingScreen = new LoadingScreen();
      this.loadingScreen.show();
      this.loadingScreen.setStatus('Loading character…');

      this.localPlayer = this.createLocalCharacterEntity();
      this.localPlayer.setPositionXYZ(this.playerX, spawnY, this.playerZ);
      this.inputManager.setPlayerY(spawnY);
      console.log(`Logged in at (${this.playerX}, ${spawnY}, ${this.playerZ})`);

      this.localPlayer.whenReady().then(() => {
        if (this.localAppearance && this.localPlayer) {
          this.localPlayer.applyAppearance(this.localAppearance);
        }
        this.loadingScreen?.hide();
        this.loadingScreen = null;
      });
    });

    this.network.on(ServerOpcode.SHOW_CHARACTER_CREATOR, () => {
      this.openCharacterCreator();
    });
  }

  private setupEntitySyncHandlers(): void {
    this.network.on(ServerOpcode.PLAYER_SYNC, (_op, v) => {
      const [entityId, x10, z10, health, maxHealth] = v;
      const x = x10 / 10;
      const z = z10 / 10;

      const hasAppearance = v.length >= 13 && v[5] >= 0;
      const syncAppearance: PlayerAppearance | null = hasAppearance ? {
        shirtColor: v[5], pantsColor: v[6], shoesColor: v[7], hairColor: v[8], beltColor: v[9], skinColor: v[10],
        hairStyle: v[11], gearColor: v[12] ?? 0,
      } : null;

      if (entityId === this.localPlayerId) {
        // While a COMBAT_HIT splat is pending for the local player, defer
        // applying the new HP so the bar/HUD drop in sync with the splat.
        if (!this.pendingHealthApply.has(entityId)) {
          this.playerHealth = health;
          this.playerMaxHealth = maxHealth;
          this.updateHUD();
          if (this.localPlayer) {
            if (health < maxHealth) {
              this.localPlayer.showHealthBar(health, maxHealth);
            } else {
              this.localPlayer.hideHealthBar();
            }
          }
        }
        if (syncAppearance && !this.localAppearance) {
          this.localAppearance = syncAppearance;
          if (this.localPlayer) this.localPlayer.applyAppearance(syncAppearance);
        }
        return;
      }

      if (!this.entities.remotePlayers.has(entityId)) {
        const playerName = this.entities.playerNames.get(entityId) || 'Player';
        this.entities.createRemotePlayer(entityId, x, z, playerName);
      }
      if (syncAppearance) {
        this.entities.remoteAppearances.set(entityId, syncAppearance);
      }
      this.entities.remoteTargets.set(entityId, { x, z });
      const sprite = this.entities.remotePlayers.get(entityId)!;
      // Skip bar update if a COMBAT_HIT splat is pending — splat closure
      // applies the bar at impact time so they stay in sync.
      if (!this.pendingHealthApply.has(entityId)) {
        if (health < maxHealth) {
          sprite.showHealthBar(health, maxHealth);
        } else {
          sprite.hideHealthBar();
        }
      }
    });

    this.network.on(ServerOpcode.NPC_SYNC, (_op, v) => {
      const [entityId, npcDefId, x10, z10, health, maxHealth] = v;
      const x = x10 / 10;
      const z = z10 / 10;

      this.entities.npcDefs.set(entityId, npcDefId);

      if (!this.entities.npcSprites.has(entityId)) {
        this.entities.createNpc(entityId, npcDefId, x, z);
      }

      const prev = this.entities.npcTargets.get(entityId);
      this.entities.npcTargets.set(entityId, {
        x, z,
        prevX: prev ? prev.x : x,
        prevZ: prev ? prev.z : z,
        t: performance.now(),
      });

      const sprite = this.entities.npcSprites.get(entityId)!;
      if (!this.pendingHealthApply.has(entityId)) {
        if (health < maxHealth) {
          sprite.showHealthBar(health, maxHealth);
        } else {
          sprite.hideHealthBar();
        }
      }
    });

    this.network.on(ServerOpcode.GROUND_ITEM_SYNC, (_op, v) => {
      const [groundItemId, itemId, quantity, x10, z10] = v;
      if (itemId === 0) {
        this.entities.removeGroundItem(groundItemId);
        return;
      }

      const x = x10 / 10;
      const z = z10 / 10;
      this.entities.groundItems.set(groundItemId, { id: groundItemId, itemId, quantity, x, z });

      if (!this.entities.groundItemSprites.has(groundItemId)) {
        this.entities.createGroundItem(groundItemId, itemId, quantity, x, z);
      }
    });

    this.network.on(ServerOpcode.ENTITY_DEATH, (_op, v) => {
      const entityId = v[0];

      if (entityId === this.combatTargetId) {
        this.combatTargetId = -1;
      }

      this.entities.cleanupCombatTargetsFor(entityId);
      this.entities.removeRemotePlayer(entityId);
      this.entities.removeNpc(entityId);
    });
  }

  private setupCombatHandlers(): void {
    this.network.on(ServerOpcode.COMBAT_HIT, (_op, v) => {
      const [attackerId, targetId, damage, targetHp, targetMaxHp] = v;
      const targetSprite = this.entities.npcSprites.get(targetId) || this.entities.remotePlayers.get(targetId);

      if (this.entities.npcSprites.has(attackerId)) {
        this.entities.npcCombatTargets.set(attackerId, targetId);
      } else if (this.entities.remotePlayers.has(attackerId)) {
        this.entities.remoteCombatTargets.set(attackerId, targetId);
      }

      // Resolve attacker entity + animation so we can sync the splat to impact
      const isLocalAttacker = attackerId === this.localPlayerId;
      const isPlayerAttacker = isLocalAttacker || this.entities.remotePlayers.has(attackerId);
      const attackerEntity = isLocalAttacker
        ? this.localPlayer
        : (this.entities.remotePlayers.get(attackerId) ?? this.entities.npcSprites.get(attackerId));
      const animName = isPlayerAttacker
        ? this.getPlayerAttackAnimName(attackerId)
        : 'attack_punch';

      // Trigger the attack animation (must happen before duration lookup so the
      // anim group exists; CharacterEntity.getAnimationDurationMs reads loaded groups)
      if (isLocalAttacker && this.localPlayer) {
        this.localPlayer.playAttackAnimation(animName);
      } else if (attackerEntity) {
        if (isPlayerAttacker) {
          (attackerEntity as any).playAttackAnimation(animName);
        } else {
          (attackerEntity as any).playAttackAnimation();
        }
      }

      // Schedule the hitsplat at the impact moment of the attacker's animation
      const fraction = GameManager.ATTACK_IMPACT_FRACTION[animName] ?? 0.5;
      // Prefer the actual loaded anim duration (local player has a CharacterEntity).
      // Fall back to a fixed estimate for sprites/NPCs that don't expose durations.
      const liveDuration = (attackerEntity && (attackerEntity as any).getAnimationDurationMs)
        ? (attackerEntity as any).getAnimationDurationMs(animName) as number
        : 0;
      const impactMs = (liveDuration > 0 ? liveDuration : 800) * fraction;
      const splatAtTarget = () => {
        if (targetSprite) {
          this.showHitSplat(targetSprite.position, damage);
          if (targetHp < targetMaxHp) {
            targetSprite.showHealthBar(targetHp, targetMaxHp);
          } else {
            targetSprite.hideHealthBar();
          }
        }
        if (targetId === this.localPlayerId && this.localPlayer) {
          this.showHitSplat(this.localPlayer.position, damage);
          this.playerHealth = targetHp;
          this.playerMaxHealth = targetMaxHp;
          this.updateHUD();
          if (targetHp < targetMaxHp) {
            this.localPlayer.showHealthBar(targetHp, targetMaxHp);
          } else {
            this.localPlayer.hideHealthBar();
          }
        }
        this.pendingHealthApply.delete(targetId);
      };
      if (impactMs > 0) {
        const prev = this.pendingHealthApply.get(targetId);
        if (prev !== undefined) clearTimeout(prev);
        const handle = setTimeout(splatAtTarget, impactMs);
        this.pendingHealthApply.set(targetId, handle);
      } else {
        splatAtTarget();
      }
    });

    // Ranged projectile visual
    this.network.on(ServerOpcode.COMBAT_PROJECTILE, (_op, v) => {
      const [attackerId, targetId, _projectileType] = v;

      // Get attacker and target positions
      let fromPos: Vector3 | null = null;
      let toPos: Vector3 | null = null;

      if (attackerId === this.localPlayerId && this.localPlayer) {
        fromPos = this.localPlayer.position.clone();
      } else {
        const sprite = this.entities.remotePlayers.get(attackerId) || this.entities.npcSprites.get(attackerId);
        if (sprite) fromPos = sprite.position.clone();
      }

      const targetSprite = this.entities.npcSprites.get(targetId) || this.entities.remotePlayers.get(targetId);
      if (targetSprite) toPos = targetSprite.position.clone();
      if (targetId === this.localPlayerId && this.localPlayer) {
        toPos = this.localPlayer.position.clone();
      }

      if (fromPos && toPos) {
        this.spawnProjectile(fromPos, toPos);
      }
    });
  }

  private setupWorldObjectHandlers(): void {
    this.network.on(ServerOpcode.SHOP_OPEN, (_op, v) => {
      const npcEntityId = v[0];
      const itemCount = v[1];
      const items: ShopItem[] = [];
      for (let i = 0; i < itemCount; i++) {
        items.push({
          itemId: v[2 + i * 3],
          price: v[2 + i * 3 + 1],
          stock: v[2 + i * 3 + 2],
        });
      }
      if (this.shopPanel) {
        const npcDefId = this.entities.npcDefs.get(npcEntityId);
        const shopTitle = NPC_NAMES[npcDefId || 0] || 'Shop';
        this.shopPanel.show(npcEntityId, items, shopTitle);
        // Enable sell option in inventory context menu
        this.sidePanel?.setSellCallback((slot, itemId) => {
          this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_SELL_ITEM, slot, 1, itemId));
        });
      }
    });

    this.network.on(ServerOpcode.WORLD_OBJECT_SYNC, (_op, v) => {
      const [objectEntityId, objectDefId, x10, z10, depleted] = v;
      const x = x10 / 10;
      const z = z10 / 10;
      const isDepleted = depleted === 1;

      this.worldObjectDefs.set(objectEntityId, { defId: objectDefId, x, z, depleted: isDepleted });

      const def = this.objectDefsCache.get(objectDefId);

      // Track blocking tiles for pathfinding
      const tileKey = `${Math.floor(x)},${Math.floor(z)}`;
      if (def?.category === 'door') {
        // Edge detection deferred until model is linked — handled in linkPlacedNodeToEntity / onChunkObjectsLoaded
      } else if (def?.blocking && !isDepleted) {
        const bx = Math.floor(x), bz = Math.floor(z);
        if (def.category === 'tree') {
          for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
            this.blockedObjectTiles.add(`${bx + dx},${bz + dz}`);
          }
        } else {
          this.blockedObjectTiles.add(tileKey);
        }
      } else {
        if (def?.category === 'tree') {
          const bx = Math.floor(x), bz = Math.floor(z);
          for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
            this.blockedObjectTiles.delete(`${bx + dx},${bz + dz}`);
          }
        } else {
          this.blockedObjectTiles.delete(tileKey);
        }
      }

      // Try to link to an editor-placed GLB model
      if (!this.worldObjectModels.has(objectEntityId)) {
        const placedNode = this.chunkManager.findPlacedObjectNear(x, z, 1.5, objectDefId);
        if (placedNode) {
          this.linkPlacedNodeToEntity(objectEntityId, { defId: objectDefId, x, z, depleted: isDepleted }, placedNode);
        } else if (!this.chunkManager.isChunkObjectsLoaded(x, z)) {
          // Chunk is still loading — skip sprite, will link via onChunkObjectsLoaded callback
        } else if (!this.worldObjectSprites.has(objectEntityId)) {
          // Chunk loaded but no GLB — fall back to sprite (fishing spots, altars, etc.)
          const name = def?.name ?? `Object${objectDefId}`;
          const color = def?.color
            ? new Color3(def.color[0] / 255, def.color[1] / 255, def.color[2] / 255)
            : new Color3(0.5, 0.5, 0.5);
          const width = def?.width ?? 0.8;
          const height = def?.height ?? 1.0;

          const sprite = new SpriteEntity(this.scene, {
            name: `obj_${objectEntityId}`,
            color,
            label: name,
            labelColor: '#88ccff',
            width,
            height,
          });
          sprite.position = new Vector3(x, this.getHeight(x, z), z);
          // Stamp metadata so picking can resolve via metadata.objectEntityId
          // (uniform with 3D-modeled world objects).
          sprite.getMesh().metadata = { kind: 'worldObject', objectEntityId };
          this.worldObjectSprites.set(objectEntityId, sprite);
        }
      }

      // Update depletion visuals
      const model = this.worldObjectModels.get(objectEntityId);
      if (model) {
        if (def?.category === 'door') {
          // Doors stay visible — animate rotation instead
          model.setEnabled(true);
        } else if (def?.category !== 'tree') {
          model.setEnabled(!isDepleted);
        }
      } else {
        const sprite = this.worldObjectSprites.get(objectEntityId);
        if (sprite) sprite.getMesh().isVisible = !isDepleted;
      }
    });

    this.network.on(ServerOpcode.WORLD_OBJECT_DEPLETED, (_op, v) => {
      const [objectEntityId, isDepleted, swingSign] = v;
      const data = this.worldObjectDefs.get(objectEntityId);
      if (data) data.depleted = isDepleted === 1;

      // Update blocking tiles for pathfinding
      if (data) {
        const def2 = this.objectDefsCache.get(data.defId);
        const tileKey = `${Math.floor(data.x)},${Math.floor(data.z)}`;
        if (def2?.category === 'door') {
          const dt = this.doorTiles.get(objectEntityId);
          const tx = dt ? dt[0] : Math.floor(data.x), tz = dt ? dt[1] : Math.floor(data.z);
          const doorEntry = this.doorPivots.get(objectEntityId);
          const rotEdge = doorEntry ? this.computeDoorEdgeFromRotY(doorEntry.closedRotY) : WallEdge.N;
          const fracX = data.x - tx, fracZ = data.z - tz;
          const edge = (rotEdge === WallEdge.N || rotEdge === WallEdge.S)
            ? (fracZ > 0.5 ? WallEdge.S : WallEdge.N)
            : (fracX > 0.5 ? WallEdge.E : WallEdge.W);

          const opened = isDepleted === 1;
          // Leave the wall mask alone — only toggle openDoorEdges. The
          // wall-block check uses elevation-gated openDoorEdges as the
          // bypass mechanism (see ChunkManager.wallEdgeBlocksAtHeight), so
          // clearing the mask would let players at the wrong elevation
          // skip through.
          this.chunkManager.setOpenDoorEdges(tx, tz, edge, opened);
          const nbLookup: Record<number, { dx: number; dz: number; opposite: number }> = {
            [WallEdge.N]: { dx: 0, dz: -1, opposite: WallEdge.S },
            [WallEdge.S]: { dx: 0, dz: 1, opposite: WallEdge.N },
            [WallEdge.E]: { dx: 1, dz: 0, opposite: WallEdge.W },
            [WallEdge.W]: { dx: -1, dz: 0, opposite: WallEdge.E },
          };
          const nb = nbLookup[edge];
          if (nb) {
            const nx = tx + nb.dx, nz = tz + nb.dz;
            this.chunkManager.setOpenDoorEdges(nx, nz, nb.opposite, opened);
          }

          this.animateDoor(objectEntityId, opened, swingSign || 0);
        } else if (def2?.blocking && isDepleted === 0) {
          const bx = Math.floor(data.x), bz = Math.floor(data.z);
          if (def2.category === 'tree') {
            for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
              this.blockedObjectTiles.add(`${bx + dx},${bz + dz}`);
            }
          } else {
            this.blockedObjectTiles.add(tileKey);
          }
        } else {
          if (def2?.category === 'tree') {
            const bx = Math.floor(data.x), bz = Math.floor(data.z);
            for (const [dx, dz] of [[-1,-1],[0,-1],[-1,0],[0,0]]) {
              this.blockedObjectTiles.delete(`${bx + dx},${bz + dz}`);
            }
          } else {
            this.blockedObjectTiles.delete(tileKey);
          }
        }
      }

      const def = data ? this.objectDefsCache.get(data.defId) : null;
      const hasDepleteModel = def?.category === 'tree' || def?.category === 'rock';

      if (def?.category === 'door') {
        // Doors stay visible — animation is handled above
      } else {
        const model = this.worldObjectModels.get(objectEntityId);
        if (hasDepleteModel && data) {
          const placedNode = model ?? this.chunkManager.findPlacedObjectNear(data.x, data.z, 1.5, data.defId);
          if (placedNode) {
            if (!model) this.worldObjectModels.set(objectEntityId, placedNode);
            placedNode.setEnabled(isDepleted === 0);

            let depleted = this.objectModels.getStump(objectEntityId);
            if (!depleted && isDepleted === 1) {
              depleted = this.objectModels.createDepletedModel(objectEntityId, data.defId, placedNode);
            }
            if (depleted) depleted.setEnabled(isDepleted === 1);
          }
        } else if (model) {
          model.setEnabled(isDepleted === 0);
        } else {
          const sprite = this.worldObjectSprites.get(objectEntityId);
          if (sprite) sprite.getMesh().isVisible = isDepleted === 0;
        }
      }
    });

    this.network.on(ServerOpcode.SKILLING_START, (_op, v) => {
      this.isSkilling = true;
      this.skillingObjectId = v[0];
      if (this.interactMarker) this.interactMarker.isVisible = false;
      if (this.chatPanel) {
        const data = this.worldObjectDefs.get(v[0]);
        const def = data ? this.objectDefsCache.get(data.defId) : null;
        const actionName = def?.actions[0] ?? 'Working';
        this.chatPanel.addSystemMessage(`You begin to ${actionName.toLowerCase()}...`, '#8cf');
      }
      // Determine which animation to play
      const objData = this.worldObjectDefs.get(v[0]);
      const objDef = objData ? this.objectDefsCache.get(objData.defId) : null;
      const variant = objDef?.category === 'tree' ? 'chop' : objDef?.category === 'rock' ? 'mine' : undefined;

      // If still walking, defer the skill animation until path completes
      const stillWalking = this.pathIndex < this.path.length;
      if (stillWalking) {
        this.pendingSkill = { objectId: v[0], variant };
      } else {
        this.startSkillingVisual(v[0], variant);
      }
    });

    this.network.on(ServerOpcode.SKILLING_STOP, (_op, _v) => {
      this.isSkilling = false;
      this.skillingObjectId = -1;
      this.localPlayer?.stopSkillAnimation();
    });
  }

  private setupPlayerStateHandlers(): void {
    this.network.on(ServerOpcode.PLAYER_STATS, (_op, v) => {
      this.playerHealth = v[0];
      this.playerMaxHealth = v[1];
      this.updateHUD();
    });

    this.network.on(ServerOpcode.PLAYER_INVENTORY, (_op, v) => {
      const [slotIndex, itemId, quantity] = v;
      if (this.sidePanel) {
        this.sidePanel.updateInvSlot(slotIndex, itemId, quantity);
      }
    });

    // Batch inventory: [slot0_itemId, slot0_qty, slot1_itemId, slot1_qty, ...]
    this.network.on(ServerOpcode.PLAYER_INVENTORY_BATCH, (_op, v) => {
      if (this.sidePanel) {
        for (let i = 0; i < v.length; i += 2) {
          this.sidePanel.updateInvSlot(i / 2, v[i], v[i + 1]);
        }
      }
    });

    this.network.on(ServerOpcode.PLAYER_SKILLS, (_op, v) => {
      const [skillIndex, level, currentLevel, xpHigh, xpLow] = v;
      const xp = (xpHigh << 16) | (xpLow & 0xFFFF);
      if (this.sidePanel) {
        this.sidePanel.updateSkill(skillIndex, level, currentLevel, xp);
      }
      if (skillIndex === ALL_SKILLS.indexOf('hitpoints')) {
        this.playerHealth = currentLevel;
        this.playerMaxHealth = level;
        this.updateHUD();
      }
    });

    // Batch skills: [skill0_level, skill0_currentLevel, skill0_xpHigh, skill0_xpLow, ...]
    this.network.on(ServerOpcode.PLAYER_SKILLS_BATCH, (_op, v) => {
      if (this.sidePanel) {
        for (let i = 0; i < v.length; i += 4) {
          const skillIndex = i / 4;
          const level = v[i], currentLevel = v[i + 1];
          const xp = (v[i + 2] << 16) | (v[i + 3] & 0xFFFF);
          this.sidePanel.updateSkill(skillIndex, level, currentLevel, xp);
          if (skillIndex === ALL_SKILLS.indexOf('hitpoints')) {
            this.playerHealth = currentLevel;
            this.playerMaxHealth = level;
            this.updateHUD();
          }
        }
      }
    });

    this.network.on(ServerOpcode.PLAYER_EQUIPMENT, (_op, v) => {
      const [slotIndex, itemId] = v;
      this.localEquipment.set(slotIndex, itemId);
      if (this.sidePanel) {
        this.sidePanel.updateEquipSlot(slotIndex, itemId);
      }
      // Attach/detach 3D gear on local player
      this.equipGear(slotIndex, itemId);
    });

    // Batch equipment: [slot0_itemId, slot1_itemId, ...]
    this.network.on(ServerOpcode.PLAYER_EQUIPMENT_BATCH, (_op, v) => {
      if (this.sidePanel) {
        for (let i = 0; i < v.length; i++) {
          this.sidePanel.updateEquipSlot(i, v[i]);
          this.localEquipment.set(i, v[i]);
        }
      }
      // Attach/detach 3D gear on local player
      for (let i = 0; i < v.length; i++) {
        this.equipGear(i, v[i]);
      }
    });

    this.network.on(ServerOpcode.XP_GAIN, (_op, v) => {
      const [skillIndex, amount] = v;
      if (skillIndex >= 0 && skillIndex < ALL_SKILLS.length) {
        const skillName = SKILL_NAMES[ALL_SKILLS[skillIndex]];
        if (this.chatPanel && amount > 0) {
          this.chatPanel.addSystemMessage(`+${amount} ${skillName} XP`, '#8f8');
        }
      }
    });

    this.network.on(ServerOpcode.LEVEL_UP, (_op, v) => {
      const [skillIndex, newLevel] = v;
      if (skillIndex >= 0 && skillIndex < ALL_SKILLS.length) {
        const skillName = SKILL_NAMES[ALL_SKILLS[skillIndex]];
        if (this.chatPanel) {
          this.chatPanel.addSystemMessage(`Level up! ${skillName} is now level ${newLevel}!`, '#ff0');
        }
      }
    });
  }

  private setupMapHandlers(): void {
    this.network.on(ServerOpcode.FLOOR_CHANGE, (_op, values) => {
      const newFloor = values[0];
      this.currentFloor = newFloor;
      console.log(`Floor changed to ${newFloor}`);
      this.chunkManager.setCurrentFloor(newFloor);
      // No Y snap here either — LOGIN_OK provided the spawn Y, and
      // legitimate floor changes (placed stairs) walk the player through
      // the ramp tile-by-tile so getHeight is already correct via the
      // per-frame movement update. TODO: server should send new Y in
      // FLOOR_CHANGE for the rare case where the floor change isn't
      // accompanied by a stair walkthrough.
    });

    this.network.onRawMessage((data: ArrayBuffer) => {
      const view = new DataView(data);
      const opcode = view.getUint8(0);
      if (opcode === ServerOpcode.MAP_CHANGE) {
        const { str: mapId, values } = decodeStringPacket(data);
        const newX = values[0] / 10;
        const newZ = values[1] / 10;
        this.handleMapChange(mapId, newX, newZ);
      }
    });
  }

  private async handleMapChange(mapId: string, newX: number, newZ: number): Promise<void> {
    console.log(`Map change to '${mapId}' at (${newX}, ${newZ})`);

    this.entities.disposeAllEntities();

    for (const [, sprite] of this.worldObjectSprites) sprite.dispose();
    this.worldObjectSprites.clear();
    // Only dispose models that GameManager created, not linked placed objects from ChunkManager
    for (const [, model] of this.worldObjectModels) {
      if (!this.chunkManager.isPlacedObjectNode(model)) model.dispose();
    }
    this.worldObjectModels.clear();
    this.objectModels.disposeStumps();
    this.worldObjectDefs.clear();
    this.blockedObjectTiles.clear();
    for (const [, entry] of this.doorPivots) entry.pivot.dispose();
    this.doorPivots.clear();

    this.isSkilling = false;
    this.skillingObjectId = -1;

    // Load new map
    await this.chunkManager.loadMap(mapId);
    await this.loadBiomes(mapId);
    this.applyFog();
    this.minimap?.invalidateTileCache();
    // Tell server we're ready to receive entity data — SYNCs will link trees via the handler
    this.network.sendRaw(encodePacket(ClientOpcode.MAP_READY));

    // Update player position
    this.playerX = newX;
    this.playerZ = newZ;
    this.path = []; this.pathIndex = 0; this.tileProgress = 0; this.pendingPath = null;
    if (this.localPlayer) this.localPlayer.stopWalking();
    this.combatTargetId = -1;

    // No Y snap here. LOGIN_OK already set Y from the server. Re-snapping
    // via getHeight() can drop the player below an elevated tile because
    // getHeight gates roof reveal on currentY, and the gate fails the
    // moment chunk data is mid-rebuild. For inter-map transitions (portals)
    // the server should send the new Y alongside MAP_CHANGE — TODO Step 3.

    // Reposition any entities that arrived before map finished loading
    this.repositionWorldObjects();

    if (this.chatPanel) {
      this.chatPanel.addSystemMessage(`Entered ${this.chunkManager.getMeta()?.name || mapId}.`, '#0f0');
    }
  }

  private setupContextMenu(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.hideContextMenu();

      const pickResult = this.scene.pick(this.scene.pointerX, this.scene.pointerY);
      if (!pickResult?.hit || !pickResult.pickedMesh) return;

      const meshName = pickResult.pickedMesh.name;
      const options: { label: string; action: () => void }[] = [];

      // Identify the picked NPC. 3D-modeled NPCs (e.g. cows) all share mesh
      // names from their source GLB, so name matching is ambiguous — every
      // cow click would route to whichever cow happened to be first in the
      // npcSprites map. Check metadata.entityId (stamped by Npc3DEntity.
      // setEntityIdMetadata) by walking up the picked node's parents first;
      // fall back to mesh-name matching for sprite-based NPCs (which already
      // carry unique `npc_<entityId>` mesh names).
      let pickedNpcEntityId: number | null = null;
      {
        let walk: TransformNode | null = pickResult.pickedMesh;
        while (walk) {
          if (walk.metadata?.kind === 'npc' && typeof walk.metadata?.entityId === 'number') {
            pickedNpcEntityId = walk.metadata.entityId;
            break;
          }
          walk = walk.parent as TransformNode | null;
        }
      }
      if (pickedNpcEntityId == null) {
        for (const [entityId, sprite] of this.entities.npcSprites) {
          if (sprite.getMesh()?.name === meshName) {
            pickedNpcEntityId = entityId;
            break;
          }
        }
      }
      if (pickedNpcEntityId != null) {
        const entityId = pickedNpcEntityId;
        const npcDefId = this.entities.npcDefs.get(entityId);
        const name = NPC_NAMES[npcDefId || 0] || 'NPC';
        if (npcDefId === 8 || npcDefId === 11 || npcDefId === 12 || npcDefId === 13 || npcDefId === 14) {
          options.push({ label: `Trade ${name}`, action: () => this.talkToNpc(entityId) });
        } else {
          options.push({ label: `Attack ${name}`, action: () => this.attackNpc(entityId) });
        }
      }

      // Ground item: prefer metadata, fall back to name match.
      let pickedGroundItemId: number | null = null;
      {
        let walk: TransformNode | null = pickResult.pickedMesh;
        while (walk) {
          if (walk.metadata?.kind === 'groundItem' && typeof walk.metadata?.groundItemId === 'number') {
            pickedGroundItemId = walk.metadata.groundItemId;
            break;
          }
          walk = walk.parent as TransformNode | null;
        }
      }
      if (pickedGroundItemId == null) {
        for (const [groundItemId, sprite] of this.entities.groundItemSprites) {
          if (sprite.getMesh()?.name === meshName) {
            pickedGroundItemId = groundItemId;
            break;
          }
        }
      }
      if (pickedGroundItemId != null) {
        const groundItemId = pickedGroundItemId;
        const gItem = this.entities.groundItems.get(groundItemId);
        const iDef = gItem ? this.itemDefsCache.get(gItem.itemId) : null;
        const iName = iDef?.name ?? 'item';
        options.push({
          label: `Pick up ${iName}`,
          action: () => this.pickupItem(groundItemId),
        });
      }

      // Check 3D models (trees, rocks, placed objects) — walk up parent chain looking for objectEntityId metadata
      let pickedObjectEntityId: number | null = null;
      let walkMesh: TransformNode | null = pickResult.pickedMesh;
      while (walkMesh) {
        if (walkMesh.metadata?.objectEntityId != null) {
          pickedObjectEntityId = walkMesh.metadata.objectEntityId;
          break;
        }
        walkMesh = walkMesh.parent as TransformNode | null;
      }

      // If no objectEntityId found, check if this is a placed object near a world object
      if (pickedObjectEntityId == null && pickResult.pickedMesh) {
        // Walk up to root placed node
        let rootNode: TransformNode = pickResult.pickedMesh!;
        while (rootNode.parent) {
          if (this.chunkManager.isPlacedObjectNode(rootNode)) break;
          rootNode = rootNode.parent as TransformNode;
        }

        if (this.chunkManager.isPlacedObjectNode(rootNode)) {
          // Only match if this placed object is actually an interactable asset
          const rootAssetId = rootNode.metadata?.assetId;
          if (rootAssetId && rootAssetId in ASSET_TO_OBJECT_DEF) {
            const expectedDefId = ASSET_TO_OBJECT_DEF[rootAssetId];
            const px = rootNode.position.x;
            const pz = rootNode.position.z;
            let bestEid = -1, bestDist = 3.0;
            for (const [eid, data] of this.worldObjectDefs) {
              if (data.defId !== expectedDefId) continue;
              const dist = Math.hypot(data.x - px, data.z - pz);
              if (dist < bestDist) {
                bestDist = dist;
                bestEid = eid;
              }
            }
            if (bestEid >= 0) {
              pickedObjectEntityId = bestEid;
              this.worldObjectModels.set(bestEid, rootNode);
            }
          }
        }
      }

      if (pickedObjectEntityId != null) {
        const data = this.worldObjectDefs.get(pickedObjectEntityId);
        if (data) {
          const def = this.objectDefsCache.get(data.defId);
          if (def && (!data.depleted || def.category === 'door')) {
            for (let i = 0; i < def.actions.length; i++) {
              const actionName = def.actions[i];
              const eid = pickedObjectEntityId;
              const actionIdx = i;
              options.push({
                label: `${actionName} ${def.name}`,
                action: () => this.interactObject(eid, actionIdx),
              });
            }
          }
        }
      }

      // Check sprite-based world objects (metadata first, name match fallback).
      // The sprite's plane is stamped with { kind:'worldObject', objectEntityId }
      // when created, so picking resolves uniformly with the 3D-model path above.
      let pickedSpriteWorldObjectId: number | null = null;
      {
        let walk: TransformNode | null = pickResult.pickedMesh;
        while (walk) {
          if (walk.metadata?.kind === 'worldObject' && typeof walk.metadata?.objectEntityId === 'number') {
            pickedSpriteWorldObjectId = walk.metadata.objectEntityId;
            break;
          }
          walk = walk.parent as TransformNode | null;
        }
      }
      if (pickedSpriteWorldObjectId == null) {
        for (const [objectEntityId, sprite] of this.worldObjectSprites) {
          if (sprite.getMesh()?.name === meshName) {
            pickedSpriteWorldObjectId = objectEntityId;
            break;
          }
        }
      }
      if (pickedSpriteWorldObjectId != null && pickedObjectEntityId == null) {
        const objectEntityId = pickedSpriteWorldObjectId;
        const data = this.worldObjectDefs.get(objectEntityId);
        if (data) {
          const def = this.objectDefsCache.get(data.defId);
          if (def && (!data.depleted || def.category === 'door')) {
            for (let i = 0; i < def.actions.length; i++) {
              const actionName = def.actions[i];
              const actionIdx = i;
              options.push({
                label: `${actionName} ${def.name}`,
                action: () => this.interactObject(objectEntityId, actionIdx),
              });
            }
          }
        }
      }

      if (options.length > 0) {
        this.showContextMenu(e.clientX, e.clientY, options);
      }
    });
  }

  private showContextMenu(x: number, y: number, options: { label: string; action: () => void }[]): void {
    this.hideContextMenu();

    const menu = document.createElement('div');
    menu.style.cssText = `
      position: fixed; left: ${x}px; top: ${y}px;
      background: #3a3125; border: 2px solid #5a4a35;
      font-family: monospace; font-size: 13px; z-index: 1000;
      min-width: 120px; box-shadow: 2px 2px 8px rgba(0,0,0,0.5);
    `;

    for (const opt of options) {
      const item = document.createElement('div');
      item.textContent = opt.label;
      item.style.cssText = `padding: 4px 12px; color: #ffcc00; cursor: pointer;`;
      item.addEventListener('mouseenter', () => item.style.background = '#5a4a35');
      item.addEventListener('mouseleave', () => item.style.background = 'transparent');
      item.addEventListener('click', () => {
        opt.action();
        this.hideContextMenu();
      });
      menu.appendChild(item);
    }

    document.body.appendChild(menu);
    this.contextMenu = menu;

    const closeHandler = () => {
      this.hideContextMenu();
      document.removeEventListener('click', closeHandler);
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  }

  private hideContextMenu(): void {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  private attackNpc(npcEntityId: number): void {
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    this.combatTargetId = npcEntityId;
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_ATTACK_NPC, npcEntityId));

    const target = this.entities.npcTargets.get(npcEntityId);
    if (target) {
      const path = findPath(this.playerX, this.playerZ, target.x, target.z,
        this.isTileBlocked,
        this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
        this.isWallBlockedForPath);
      if (path.length > 1) {
        const last = path[path.length - 1];
        if (Math.floor(last.x) === Math.floor(target.x) && Math.floor(last.z) === Math.floor(target.z)) {
          path.pop();
        }
      }
      if (path.length > 0) {
        this.path = path; this.pathIndex = 0; this.tileProgress = 0; this.tileFrom = { x: this.playerX, z: this.playerZ };
        if (this.destMarker) this.destMarker.isVisible = false;
        this.minimap?.clearDestination();
      }
    }
  }

  private talkToNpc(npcEntityId: number): void {
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    const target = this.entities.npcTargets.get(npcEntityId);
    if (!target) return;

    // Walk to NPC first, then send talk opcode
    const path = findPath(this.playerX, this.playerZ, target.x, target.z,
      this.isTileBlocked,
      this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
      this.isWallBlockedForPath);
    if (path.length > 1) {
      const last = path[path.length - 1];
      if (Math.floor(last.x) === Math.floor(target.x) && Math.floor(last.z) === Math.floor(target.z)) {
        path.pop();
      }
    }
    if (path.length > 0) {
      this.path = path; this.pathIndex = 0; this.tileProgress = 0; this.tileFrom = { x: this.playerX, z: this.playerZ };
      if (this.destMarker) this.destMarker.isVisible = false;
      this.minimap?.clearDestination();
    }
    // Send talk opcode — server checks distance
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_TALK_NPC, npcEntityId));
  }

  private pickupItem(groundItemId: number): void {
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_PICKUP_ITEM, groundItemId));
  }

  private handleObjectClick(objectEntityId: number): void {
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    // Cooldown after cancelling a skill — prevent spam-restarting
    if (performance.now() - this.skillCancelTime < 600) return;
    const data = this.worldObjectDefs.get(objectEntityId);
    if (!data) return;
    const def = this.objectDefsCache.get(data.defId);
    if (!def) return;
    // Doors can always be clicked (open/close toggle). Other objects can't when depleted.
    if (data.depleted && def.category !== 'door') return;
    // Auto-interact with harvestable objects (trees, rocks), doors, and crafting stations (furnace, anvil, range)
    if ((def.skill && def.harvestItemId) || def.category === 'door' || (def.recipes && def.recipes.length > 0)) {
      // Skip the disc marker for doors — the door's world position sits on
      // a wall edge, so a flat disc there visually clips through the wall
      // mesh. The door's open/close animation is sufficient feedback.
      if (this.interactMarker && def.category !== 'door') {
        this.interactMarker.position.x = data.x;
        this.interactMarker.position.y = this.getHeight(data.x, data.z) + 0.02;
        this.interactMarker.position.z = data.z;
        this.alignMarkerToTerrain(data.x, data.z, this.interactMarker);
        this.interactMarker.isVisible = true;
        if (this.destMarker) this.destMarker.isVisible = false;
      }

      this.interactObject(objectEntityId, 0);
    }
  }

  private showSmithingUI(objectEntityId: number, def: WorldObjectDef): void {
    if (!this.smithingPanel || !this.sidePanel) return;
    const inventory = this.sidePanel.getInventory();
    const smithingLevel = this.sidePanel.getSkillLevel('smithing');
    const itemDefs = this.sidePanel.getItemDefs();
    const toolType = def.recipes?.[0]?.requiresTool;
    const hasTool = inventory.some((slot: InventorySlot | null) => slot && itemDefs.get(slot.itemId)?.toolType === toolType);

    this.smithingPanel.show(def.recipes ?? [], inventory, smithingLevel, hasTool, itemDefs, (recipeIndex) => {
      // Walk to the anvil and send the crafting request with the specific recipe index
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, 0, recipeIndex));
    });
  }

  private interactObject(objectEntityId: number, actionIndex: number): void {
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    this.combatTargetId = -1;

    // Intercept anvil/tool-based crafting: show recipe UI instead of auto-crafting
    const objData = this.worldObjectDefs.get(objectEntityId);
    if (objData) {
      const objDef = this.objectDefsCache.get(objData.defId);
      if (objDef?.recipes && objDef.recipes.length > 0 && objDef.recipes[0].requiresTool) {
        this.showSmithingUI(objectEntityId, objDef);
        return;
      }
    }

    // Cancel current skilling if clicking a different object
    if (this.isSkilling && this.skillingObjectId !== objectEntityId) {
      this.isSkilling = false;
      this.skillingObjectId = -1;
      this.pendingSkill = null;
      this.localPlayer?.stopSkillAnimation();
    }

    const data = this.worldObjectDefs.get(objectEntityId);
    if (!data) return;

    const dx = data.x - this.playerX;
    const dz = data.z - this.playerZ;
    const dist = Math.hypot(dx, dz);

    // Find a reachable adjacent tile and walk there
    const def = this.objectDefsCache.get(data.defId);

    if (def?.category === 'door') {
      const dt = this.doorTiles.get(objectEntityId);
      const dotx = dt ? dt[0] : Math.floor(data.x);
      const dotz = dt ? dt[1] : Math.floor(data.z);
      const ptx = Math.floor(this.playerX);
      const ptz = Math.floor(this.playerZ);
      const alreadyAdj = (ptx === dotx && ptz === dotz) || (Math.abs(ptx - dotx) + Math.abs(ptz - dotz) === 1);

      if (!alreadyAdj) {
        const doorEntry = this.doorPivots.get(objectEntityId);
        const rotEdge = doorEntry ? this.computeDoorEdgeFromRotY(doorEntry.closedRotY) : WallEdge.N;
        const fracX2 = data.x - dotx, fracZ2 = data.z - dotz;
        const edge = (rotEdge === WallEdge.N || rotEdge === WallEdge.S)
          ? (fracZ2 > 0.5 ? WallEdge.S : WallEdge.N)
          : (fracX2 > 0.5 ? WallEdge.E : WallEdge.W);
        let tx = dotx, tz = dotz;
        if (!data.depleted) {
          if (edge === WallEdge.N && this.playerZ < dotz + 0.5) tz = dotz - 1;
          else if (edge === WallEdge.S && this.playerZ > dotz + 0.5) tz = dotz + 1;
          else if (edge === WallEdge.E && this.playerX > dotx + 0.5) tx = dotx + 1;
          else if (edge === WallEdge.W && this.playerX < dotx + 0.5) tx = dotx - 1;
        }
        const path = findPath(this.playerX, this.playerZ, tx + 0.5, tz + 0.5,
          this.isTileBlocked,
          this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 500,
          this.isWallBlockedForPath);
        if (path.length > 0) {
          this.path = path; this.pathIndex = 0; this.tileProgress = 0;
          this.tileFrom = { x: this.playerX, z: this.playerZ };
        }
      } else {
        this.path = []; this.pathIndex = 0;
        this.localPlayer?.stopWalking();
      }
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, actionIndex));
      return;
    }

    // Furnace: path to the tile directly in front of the red opening, not any
    // arbitrary adjacent tile. Derive the "front" direction from the model's Y
    // rotation. Assumes the unrotated forge GLB faces -Z.
    if (def?.category === 'furnace') {
      const model = this.worldObjectModels.get(objectEntityId);
      // Extract Y rotation — world objects use rotationQuaternion (set by placeNode),
      // so reading `.rotation.y` directly gives 0. Derive from the quaternion when
      // present; fall back to euler otherwise.
      let rotY = 0;
      if (model?.rotationQuaternion) {
        const q = model.rotationQuaternion;
        // Y-axis angle from quaternion (atan2 form handles any orientation)
        rotY = Math.atan2(
          2 * (q.w * q.y + q.x * q.z),
          1 - 2 * (q.y * q.y + q.x * q.x),
        );
      } else if (model) {
        rotY = model.rotation.y;
      }
      // Snap to nearest cardinal: choose the dir closest to (+sinθ, +cosθ)
      // (the forge GLB's unrotated front faces +Z)
      const fx = Math.sin(rotY);
      const fz = Math.cos(rotY);
      let bestDir: [number, number] = [0, -1];
      let bestDot = -Infinity;
      for (const d of [[0, -1], [0, 1], [-1, 0], [1, 0]] as const) {
        const dot = d[0] * fx + d[1] * fz;
        if (dot > bestDot) { bestDot = dot; bestDir = [d[0], d[1]]; }
      }
      const otx = Math.floor(data.x);
      const otz = Math.floor(data.z);
      const frontX = otx + bestDir[0];
      const frontZ = otz + bestDir[1];

      // If we're not already on the front tile, pathfind there
      const ptx = Math.floor(this.playerX);
      const ptz = Math.floor(this.playerZ);
      if (ptx !== frontX || ptz !== frontZ) {
        if (!this.isTileBlocked(frontX, frontZ)) {
          const path = findPath(
            this.playerX, this.playerZ,
            frontX + 0.5, frontZ + 0.5,
            this.isTileBlocked,
            this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 500,
            this.isWallBlockedForPath,
          );
          if (path.length > 0) {
            this.path = path;
            this.pathIndex = 0;
            this.tileProgress = 0;
            this.tileFrom = { x: this.playerX, z: this.playerZ };
            this.network.sendMove(path);
          }
        }
      }
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, actionIndex));
      return;
    }

    const isHarvestable = def?.category === 'rock' || def?.category === 'tree';
    const otx = Math.floor(data.x);
    const otz = Math.floor(data.z);
    const objTiles = def?.category === 'tree'
      ? [[-1,-1],[0,-1],[-1,0],[0,0]].map(([ddx,ddz]) => [otx+ddx, otz+ddz])
      : [[otx, otz]];
    // Doors: only cardinal + same tile. Harvestable: cardinal only. Others: all 8.
    const dirs = isHarvestable ? [[0,-1],[0,1],[-1,0],[1,0]] : [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

    // Check if already on a valid adjacent tile
    const ptx = Math.floor(this.playerX);
    const ptz = Math.floor(this.playerZ);
    const alreadyAdj = objTiles.some(([tx, tz]) => {
      return dirs.some(([ddx, ddz]) => ptx === tx + ddx && ptz === tz + ddz);
    });

    if (!alreadyAdj) {
      const candidates: { ax: number; az: number; dist: number }[] = [];
      for (const [tx, tz] of objTiles) {
        for (const [ddx, ddz] of dirs) {
          const ax = tx + ddx, az = tz + ddz;
          if (objTiles.some(([ox, oz]) => ox === ax && oz === az)) continue;
          if (this.isTileBlocked(ax, az)) continue;
          const dist = Math.hypot(this.playerX - (ax + 0.5), this.playerZ - (az + 0.5));
          candidates.push({ ax, az, dist });
        }
      }
      candidates.sort((a, b) => a.dist - b.dist);

      let bestPath: { x: number; z: number }[] | null = null;
      for (const { ax, az } of candidates) {
        const path = findPath(this.playerX, this.playerZ, ax + 0.5, az + 0.5,
          this.isTileBlocked,
          this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 500,
          this.isWallBlockedForPath);
        if (path.length > 0) {
          bestPath = path;
          break;
        }
      }
      if (bestPath) {
        this.path = bestPath; this.pathIndex = 0; this.tileProgress = 0; this.tileFrom = { x: this.playerX, z: this.playerZ };
        this.network.sendMove(bestPath);
      }
    }

    // Send interaction request — server validates distance
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, actionIndex));
  }

  private handleChatCommand(msg: string): boolean {
    if (msg === '/geardebug') {
      if (!this.gearDebugPanel) {
        this.gearDebugPanel = new GearDebugPanel();
        this.gearDebugPanel.setSlotGetter((slot) => this.localPlayer?.getGearNode?.(slot) ?? this.armorPreviewNodes.get(slot) ?? null);
        this.gearDebugPanel.setSlotBoneGetter((slot) => EQUIP_SLOT_BONES[slot]?.boneName ?? '');
        this.gearDebugPanel.setItemInfoGetter((slot) => {
          const itemId = this.localPlayer?.getGearItemId(slot) ?? -1;
          if (itemId < 0) return null;
          const def = this.itemDefsCache.get(itemId);
          return { id: itemId, name: def?.name ?? `item ${itemId}`, toolType: def?.toolType };
        });
        this.gearDebugPanel.setOverrideGetter((itemId) => this.gearOverrides.get(itemId) ?? null);
        this.gearDebugPanel.setSkinnedChecker((slot) => this.localPlayer?.getSkinnedArmorMeshes?.(slot) != null);
        this.gearDebugPanel.setSaveCallback(async (itemId, override) => {
          this.gearOverrides.set(itemId, override);
          const all: Record<string, any> = {};
          for (const [id, ov] of this.gearOverrides) all[String(id)] = ov;
          const res = await fetch('/api/dev/gear-overrides', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(all),
          });
          if (!res.ok) throw new Error('Server returned ' + res.status);
          const slotName = EQUIP_SLOT_NAMES.find(s => this.localPlayer?.getGearItemId(s) === itemId);
          if (slotName) this.gearTemplateCache.delete(`${slotName}/${itemId}`);
        });
        this.gearDebugPanel.setLoadGlbCallback(async (slot, path) => {
          if (!this.localPlayer) throw new Error('No local player');
          const boneConfig = EQUIP_SLOT_BONES[slot];
          if (!boneConfig) throw new Error('Unknown slot: ' + slot);

          const lastSlash = path.lastIndexOf('/');
          const dir = path.substring(0, lastSlash + 1);
          const file = path.substring(lastSlash + 1);
          const result = await SceneLoader.ImportMeshAsync('', dir, file, this.scene);
          const hasSkeleton = result.skeletons.length > 0;

          if (hasSkeleton) {
            this.localPlayer.detachGear(slot);
            this.disposeArmorSlot(slot);

            this.localPlayer.attachSkinnedArmor(slot, result.meshes, result.skeletons[0]);
            const loaderRoot = result.meshes.find(m => m.name === '__root__');
            if (loaderRoot) loaderRoot.dispose();
          } else {
            const gearDef: GearDef = {
              itemId: -999,
              file: path,
              boneName: boneConfig.boneName,
              localPosition: boneConfig.localPosition,
              localRotation: boneConfig.localRotation,
              scale: boneConfig.scale,
              centerOrigin: false,
            };
            const tmpl = await loadGearTemplate(this.scene, gearDef);
            if (!tmpl) throw new Error('Failed to load ' + path);
            this.localPlayer.attachGear(slot, -999, tmpl);
          }
        });
        this.gearDebugPanel.setUnequipCallback((slot) => {
          if (!this.localPlayer) return;
          this.localPlayer.detachGear(slot);
          this.localPlayer.detachSkinnedArmor(slot);
          this.disposeArmorSlot(slot);
        });
        this.gearDebugPanel.setAnimCallback((anim) => {
          if (!this.localPlayer) return;
          if (anim === 'idle') {
            this.localPlayer.stopWalking();
            this.localPlayer.stopSkillAnimation();
          } else if (anim === 'walk') {
            this.localPlayer.startWalking();
          } else if (anim === 'attack') {
            this.localPlayer.playAttackAnimation();
          } else if (anim === 'chop') {
            this.localPlayer.startSkillAnimation('chop');
          } else if (anim === 'mine') {
            this.localPlayer.startSkillAnimation('mine');
          }
        });
      }
      this.gearDebugPanel.toggle();
      if (this.gearDebugPanel.isVisible) this.camera.enterDebugZoom();
      else this.camera.exitDebugZoom();
      return true;
    }
    if (msg === '/bonedebug') {
      if (!this.boneDebugPanel) {
        this.boneDebugPanel = new BoneDebugPanel();
        this.boneDebugPanel.setSkeletonGetter(() => this.localPlayer?.getSkeleton?.() ?? null);
      }
      this.boneDebugPanel.toggle();
      if (this.boneDebugPanel.isVisible) this.camera.enterDebugZoom();
      else this.camera.exitDebugZoom();
      return true;
    }
    if (msg === '/armor') {
      if (!this.armorBrowser) {
        this.armorBrowser = new ArmorBrowserPanel();
        this.armorBrowser.setScene(this.scene);
        this.armorBrowser.setEquipCallback((category, item, root, armorSkeleton) => {
          this.disposeArmorSlot(category);
          this.localPlayer?.detachSkinnedArmor?.(category);

          if (armorSkeleton && this.localPlayer) {
            const meshes = root.getChildMeshes();
            this.localPlayer.attachSkinnedArmor(category, meshes, armorSkeleton);
            root.dispose();
          } else {
            const charRoot = this.localPlayer?.getRoot?.();
            if (charRoot) {
              root.parent = charRoot;
              root.rotationQuaternion = null;
              root.position.set(0, this.localPlayer?.getChildYOffset?.() ?? 0, 0);
              root.rotation.set(0, 0, 0);
              root.scaling.set(1, 1, 1);
            }
            this.armorPreviewNodes.set(category, root);
          }
        });
        this.armorBrowser.setUnequipCallback((category) => {
          this.localPlayer?.detachSkinnedArmor?.(category);
          this.disposeArmorSlot(category);
        });
      }
      this.armorBrowser.toggle();
      if (this.armorBrowser.isVisible) this.camera.enterDebugZoom();
      else this.camera.exitDebugZoom();
      return true;
    }
    if (msg === '/appearance') {
      this.openCharacterCreator();
      return true;
    }
    return false;
  }

  private openCharacterCreator(): void {
    if (this.characterCreator) return;
    this.characterCreator = new CharacterCreator(this.scene, (appearance) => {
      this.network.sendRaw(encodePacket(
        ClientOpcode.SET_APPEARANCE,
        appearance.shirtColor,
        appearance.pantsColor,
        appearance.shoesColor,
        appearance.hairColor,
        appearance.beltColor,
        appearance.skinColor,
        appearance.hairStyle,
        appearance.gearColor,
      ));
      this.localAppearance = appearance;
      if (this.localPlayer) {
        this.localPlayer.applyAppearance(appearance);
      }
      this.characterCreator!.destroy();
      this.characterCreator = null;
    });
  }

  private showPlayerChatBubble(fromName: string, message: string): void {
    if (!fromName || !this.username) return;

    if (fromName.toLowerCase() === this.username.toLowerCase()) {
      if (this.localPlayer) {
        this.localPlayer.showChatBubble(message);
      }
      return;
    }

    const entityId = this.entities.nameToEntityId.get(fromName.toLowerCase());
    if (entityId !== undefined) {
      const sprite = this.entities.remotePlayers.get(entityId);
      if (sprite) {
        sprite.showChatBubble(message);
      }
    }
  }

  /** Spawn a simple arrow projectile that flies from→to over 300ms */
  private spawnProjectile(from: Vector3, to: Vector3): void {
    // Create a thin cylinder as the arrow
    const arrow = MeshBuilder.CreateCylinder('projectile', { height: 0.6, diameter: 0.04 }, this.scene);
    const mat = new StandardMaterial('projMat', this.scene);
    mat.diffuseColor = new Color3(0.4, 0.25, 0.1); // brown
    mat.emissiveColor = new Color3(0.2, 0.12, 0.05);
    arrow.material = mat;

    // Position at start, elevated slightly
    from.y += 1.0;
    to.y += 0.8;
    arrow.position = from.clone();

    // Orient toward target
    const dir = to.subtract(from).normalize();
    const up = Vector3.Up();
    const right = Vector3.Cross(up, dir).normalize();
    const correctedUp = Vector3.Cross(dir, right);
    arrow.rotationQuaternion = Quaternion.FromLookDirectionLH(dir, correctedUp);

    // Animate over 300ms
    const duration = 300;
    const startTime = performance.now();
    const obs = this.scene.onBeforeRenderObservable.add(() => {
      const t = Math.min(1, (performance.now() - startTime) / duration);
      arrow.position = Vector3.Lerp(from, to, t);
      if (t >= 1) {
        this.scene.onBeforeRenderObservable.remove(obs);
        arrow.dispose();
        mat.dispose();
      }
    });
  }

  private showHitSplat(pos: Vector3, damage: number): void {
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed; pointer-events: none; z-index: 250;
      width: 32px; height: 32px;
      transform: translate(-50%, -50%);
      display: flex; align-items: center; justify-content: center;
      image-rendering: pixelated;
      transition: opacity 0.3s ease-out;
    `;

    const img = document.createElement('img');
    img.src = damage > 0 ? '/sprites/effects/hitsplash.png' : '/sprites/effects/nohitsplash.png';
    img.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      image-rendering: pixelated; pointer-events: none;
    `;
    el.appendChild(img);

    const numEl = document.createElement('span');
    numEl.textContent = damage.toString();
    numEl.style.cssText = `
      position: relative; z-index: 1;
      color: #fff; font-family: monospace; font-size: 13px; font-weight: bold;
      text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;
    `;
    el.appendChild(numEl);

    document.body.appendChild(el);

    const worldPos = new Vector3(
      pos.x + (Math.random() - 0.5) * 0.3,
      pos.y + 1.5,
      pos.z
    );

    this.hitSplats.push({
      worldPos,
      el,
      timer: 1.2,
      startY: worldPos.y,
    });
  }

  private createDestinationMarker(): void {
    const marker = MeshBuilder.CreateDisc('destMarker', { radius: 0.3, tessellation: 6 }, this.scene);
    marker.isVisible = false;
    // Lay disc flat on ground (default disc normal is +Z, rotate to +Y)
    marker.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), -Math.PI / 2);
    const mat = new StandardMaterial('destMarkerMat', this.scene);
    mat.diffuseColor = new Color3(1, 1, 0);
    mat.emissiveColor = new Color3(0.5, 0.5, 0);
    mat.specularColor = Color3.Black();
    mat.backFaceCulling = false;
    marker.material = mat;
    this.destMarker = marker;

    // Red marker for object interactions
    const iMarker = MeshBuilder.CreateDisc('interactMarker', { radius: 0.3, tessellation: 6 }, this.scene);
    iMarker.isVisible = false;
    iMarker.rotationQuaternion = Quaternion.RotationAxis(Vector3.Right(), -Math.PI / 2);
    const iMat = new StandardMaterial('interactMarkerMat', this.scene);
    iMat.diffuseColor = new Color3(1, 0.2, 0.2);
    iMat.emissiveColor = new Color3(0.6, 0.1, 0.1);
    iMat.specularColor = Color3.Black();
    iMat.backFaceCulling = false;
    iMarker.material = iMat;
    this.interactMarker = iMarker;
  }

  /** Spawn a burst-lines click effect at the mouse pointer: 8 tick marks
   *  radiating outward from the click point, growing + fading. ~600ms total.
   *  Cancels any in-flight burst so only one is visible at a time. */
  private spawnCursorClickEffect(clientX: number, clientY: number, color: string = '#ffe040'): void {
    if (this.activeClickEffect) {
      this.activeClickEffect.anim.cancel();
      this.activeClickEffect.el.remove();
      this.activeClickEffect = null;
    }
    const size = 34;
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed;
      left: ${clientX - size / 2}px;
      top: ${clientY - size / 2}px;
      width: ${size}px;
      height: ${size}px;
      pointer-events: none;
      z-index: 9999;
      will-change: transform, opacity;
    `;
    // 8 tick marks at 45° intervals; each line runs from inner radius to outer radius.
    const cx = 14, cy = 14;
    const inner = 4, outer = 8;
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      const ang = (i * Math.PI) / 4;
      const x1 = cx + inner * Math.cos(ang);
      const y1 = cy + inner * Math.sin(ang);
      const x2 = cx + outer * Math.cos(ang);
      const y2 = cy + outer * Math.sin(ang);
      lines.push(`M${x1.toFixed(2)},${y1.toFixed(2)} L${x2.toFixed(2)},${y2.toFixed(2)}`);
    }
    el.innerHTML = `<svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:100%;">
      <path d="${lines.join(' ')}"
        stroke="${color}" stroke-width="2" stroke-linecap="round"
        fill="none"
        style="filter: drop-shadow(0 0 1.5px rgba(0,0,0,0.85));" />
    </svg>`;
    document.body.appendChild(el);
    // Scale outward 0.45 → 1.5 with cubic ease-out, fade 1 → 0.
    const anim = el.animate([
      { transform: 'scale(0.45)', opacity: 1 },
      { transform: 'scale(1.0)', opacity: 1, offset: 0.35 },
      { transform: 'scale(1.5)', opacity: 0 },
    ], { duration: 600, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
    const slot = { el, anim };
    this.activeClickEffect = slot;
    anim.onfinish = () => {
      el.remove();
      if (this.activeClickEffect === slot) this.activeClickEffect = null;
    };
  }

  /** Align a marker disc to the terrain normal at (x, z) */
  private alignMarkerToTerrain(x: number, z: number, marker?: TransformNode): void {
    const target = marker ?? this.destMarker;
    if (!target) return;
    const d = 0.25; // sample offset for gradient
    const hC = this.getHeight(x, z);
    const hR = this.getHeight(x + d, z);
    const hF = this.getHeight(x, z + d);
    // Terrain tangent vectors
    const tx = new Vector3(d, hR - hC, 0);
    const tz = new Vector3(0, hF - hC, d);
    // Normal = cross product (tz × tx gives upward-facing normal)
    const normal = Vector3.Cross(tz, tx).normalize();
    // Base rotation: lay disc flat (disc normal +Z → +Y)
    const baseRot = Quaternion.RotationAxis(Vector3.Right(), -Math.PI / 2);
    // Tilt from up to terrain normal
    const up = Vector3.Up();
    const angle = Math.acos(Math.min(1, Vector3.Dot(up, normal)));
    if (angle > 0.001) {
      const axis = Vector3.Cross(up, normal).normalize();
      const tilt = Quaternion.RotationAxis(axis, angle);
      target.rotationQuaternion = tilt.multiply(baseRot);
    } else {
      target.rotationQuaternion = baseRot;
    }
  }

  /** Tile blocked check that includes world objects (trees, rocks, etc.) */
  private isTileBlocked = (x: number, z: number): boolean => {
    if (this.currentFloor === 0) {
      return this.chunkManager.isBlocked(x, z) || this.blockedObjectTiles.has(`${x},${z}`);
    }
    return this.chunkManager.isBlockedOnFloor(x, z, this.currentFloor);
  };

  private isWallBlockedForPath = (fx: number, fz: number, tx: number, tz: number): boolean => {
    if (this.currentFloor !== 0) {
      return this.chunkManager.isWallBlockedOnFloor(fx, fz, tx, tz, this.currentFloor);
    }
    // Pass player height so walls below the player don't block
    const playerY = this.localPlayer?.position.y ?? this.getHeight(this.playerX, this.playerZ);
    return this.chunkManager.isWallBlocked(fx, fz, tx, tz, playerY);
  };

  private startSkillingVisual(objectId: number, variant?: string): void {
    this.path = []; this.pathIndex = 0; this.tileProgress = 0; this.pendingPath = null;
    // Snap player to tile center
    this.playerX = Math.round(this.playerX - 0.5) + 0.5;
    this.playerZ = Math.round(this.playerZ - 0.5) + 0.5;
    if (this.localPlayer) {
      this.localPlayer.stopWalking();
      const h = this.getHeight(this.playerX, this.playerZ);
      this.localPlayer.setPositionXYZ(this.playerX, h, this.playerZ);
      // Face toward the object
      const objData = this.worldObjectDefs.get(objectId);
      if (objData) {
        this.localPlayer.faceToward(new Vector3(objData.x, 0, objData.z));
      }
      this.localPlayer.startSkillAnimation(variant);
    }
  }

  private handleGroundClick(worldX: number, worldZ: number): void {
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ffe040');
    this.combatTargetId = -1;
    this.pendingSkill = null;
    if (this.isSkilling) {
      this.isSkilling = false;
      this.skillingObjectId = -1;
      // Clicking on own tile — delay the cancel so you can't spam restart
      const clickedOwnTile = Math.floor(worldX) === Math.floor(this.playerX) && Math.floor(worldZ) === Math.floor(this.playerZ);
      if (clickedOwnTile) {
        this.skillCancelTime = performance.now();
        setTimeout(() => {
          if (!this.isSkilling) this.localPlayer?.stopSkillAnimation();
        }, 600);
      } else {
        this.localPlayer?.stopSkillAnimation();
      }
    }
    if (this.interactMarker) this.interactMarker.isVisible = false;

    const tx = Math.floor(worldX), tz = Math.floor(worldZ);
    const blocked = this.isTileBlocked(tx, tz);

    const path = findPath(this.playerX, this.playerZ, worldX, worldZ,
      this.isTileBlocked,
      this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
      this.isWallBlockedForPath);
    if (path.length > 0) {
      this.path = path; this.pathIndex = 0;
      this.tileProgress = 0;
      this.tileFrom = { x: this.playerX, z: this.playerZ };
      this.pendingPath = null;
      const dest = path[path.length - 1];
      // Yellow ground destination disc removed in favor of the cursor burst.
      // Minimap arrow still indicates where you're heading.
      this.minimap?.setDestination(dest.x, dest.z);
      // Always send the full new path to the server
      this.network.sendMove(path);
    }
  }

  private createHUD(): void {
    this.minimap = new Minimap(340);
    this.minimap.setClickMoveHandler((worldX, worldZ) => {
      this.handleGroundClick(worldX, worldZ);
    });
  }

  destroy(): void {
    if (this.minimap) { this.minimap.dispose(); this.minimap = null; }
    if (this.characterCreator) { this.characterCreator.destroy(); this.characterCreator = null; }
    if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }
    if (this.onWindowResize) { window.removeEventListener('resize', this.onWindowResize); this.onWindowResize = null; }
    this.engine.stopRenderLoop();
    this.engine.dispose();
    this.chunkManager.disposeAll();
    for (const [, sprite] of this.worldObjectSprites) sprite.dispose();
    this.worldObjectSprites.clear();
    for (const [, model] of this.worldObjectModels) model.dispose();
    this.worldObjectModels.clear();
    this.objectModels.dispose();
    document.getElementById('chat-panel')?.remove();
    document.getElementById('side-panel')?.remove();
    for (const splat of this.hitSplats) splat.el.remove();
    this.hitSplats = [];
    document.querySelectorAll('.chat-bubble-overlay').forEach(el => el.remove());
    document.querySelectorAll('.entity-health-bar').forEach(el => el.remove());
  }

  private static readonly IDENTITY = Matrix.Identity();

  private static readonly MAX_OVERLAY_DIST_SQ = 45 * 45;

  private ensureOverlayTransform(): boolean {
    if (this._overlayTransformReady) return true;
    const cam = this.scene.activeCamera;
    if (!cam) return false;
    cam.getViewMatrix().multiplyToRef(cam.getProjectionMatrix(), this._overlayTransform);
    const w = this.engine.getRenderWidth();
    const h = this.engine.getRenderHeight();
    this._overlayVp.x = 0; this._overlayVp.y = 0;
    this._overlayVp.width = w; this._overlayVp.height = h;
    this._overlayTransformReady = true;
    return true;
  }

  private updateOverlayPositions(): void {
    if (!this.ensureOverlayTransform()) return;
    const cam = this.scene.activeCamera!;
    const transform = this._overlayTransform;
    const vp = this._overlayVp;
    const identity = GameManager.IDENTITY;
    const camPos = cam.position;
    const maxDistSq = GameManager.MAX_OVERLAY_DIST_SQ;
    const screenPos = this._overlayScreenPos;

    const projectOverlay = (
      worldPos: Vector3,
      updateScreenPos: (x: number, y: number) => void,
    ) => {
      Vector3.ProjectToRef(worldPos, identity, transform, vp, screenPos);
      if (screenPos.z > 0 && screenPos.z < 1) {
        updateScreenPos(screenPos.x, screenPos.y);
      } else {
        updateScreenPos(-9999, -9999);
      }
    };

    const projectSprite = (sprite: SpriteEntity | CharacterEntity | Npc3DEntity, skipDistCheck?: boolean) => {
      const hasBubble = sprite.hasChatBubble();
      const hasBar = sprite.hasHealthBar();
      if (!hasBubble && !hasBar) return;

      if (!skipDistCheck) {
        const pos = sprite.position;
        const dx = pos.x - camPos.x;
        const dy = pos.y - camPos.y;
        const dz = pos.z - camPos.z;
        if (dx * dx + dy * dy + dz * dz > maxDistSq) {
          if (hasBar) sprite.updateHealthBarScreenPos(-9999, -9999);
          if (hasBubble) sprite.updateChatBubbleScreenPos(-9999, -9999);
          return;
        }
      }

      if (hasBubble) {
        const wp = sprite.getChatBubbleWorldPos(this._overlayWorldPos);
        if (wp) projectOverlay(wp, (x, y) => sprite.updateChatBubbleScreenPos(x, y));
      }
      if (hasBar) {
        const wp = sprite.getHealthBarWorldPos(this._overlayWorldPos);
        if (wp) projectOverlay(wp, (x, y) => sprite.updateHealthBarScreenPos(x, y));
      }
    };

    if (this.localPlayer) projectSprite(this.localPlayer, true);
    for (const [, sprite] of this.entities.remotePlayers) projectSprite(sprite);
    for (const [, sprite] of this.entities.npcSprites) projectSprite(sprite);
  }

  private updateHUD(): void {
    this.sidePanel?.updateHP(this.playerHealth, this.playerMaxHealth);
  }

  private update(dt: number): void {
    this.updateCameraKeys(dt);

    if (this.localPlayer) this.localPlayer.updateAnimation(dt);
    this.entities.updateAnimations(dt);

    const camPos = this.scene.activeCamera?.position ?? null;

    this.chunkManager.updatePlayerPosition(this.playerX, this.playerZ);
    this.chunkManager.updateAnimations();
    this.updateFog(dt);

    this.updateCombatFollow(dt);
    this.updateLocalPlayerMovement(dt, camPos);

    if (this.localPlayer && this.pathIndex >= this.path.length && this.combatTargetId >= 0) {
      if (camPos) {
        const npcTarget = this.entities.npcTargets.get(this.combatTargetId);
        const npcSprite = this.entities.npcSprites.get(this.combatTargetId);
        if (npcTarget && npcSprite) {
          this.localPlayer.faceToward(npcSprite.position, camPos);
        }
      }
    }

    this.entities.interpolateRemotePlayers(dt, camPos);
    this.entities.interpolateNpcs(dt, camPos, this.localPlayerId, this.localPlayer?.position ?? null);

    this.updateIndoorDetection();
    this.updateDoorAnimations(dt);

    if (this.localPlayer) {
      this._tempVec.set(this.playerX, this.localPlayer.position.y, this.playerZ);
      this.camera.followTarget(this._tempVec);
    }

    this._overlayTransformReady = false;
    this.updateOverlayPositions();
    this.updateHitSplats(dt);
    this.updateMinimap();
  }

  private updateCameraKeys(dt: number): void {
    const camSpeed = 2.0 * dt;
    const cam = this.camera.getCamera();
    if (this.keysDown.has('a') || this.keysDown.has('arrowleft')) cam.alpha += camSpeed;
    if (this.keysDown.has('d') || this.keysDown.has('arrowright')) cam.alpha -= camSpeed;
    if (this.keysDown.has('w') || this.keysDown.has('arrowup')) cam.beta = Math.max(0.2, cam.beta - camSpeed);
    if (this.keysDown.has('s') || this.keysDown.has('arrowdown')) cam.beta = Math.min(Math.PI / 2.2, cam.beta + camSpeed);
    if (this.keysDown.has('escape')) {
      cam.alpha = -Math.PI / 4;
      cam.beta = Math.PI / 3.2;
      this.keysDown.delete('escape');
    }
  }

  private updateCombatFollow(dt: number): void {
    this._combatPathTimer -= dt;
    if (this.combatTargetId < 0 || !this.localPlayer) return;
    const npcTarget = this.entities.npcTargets.get(this.combatTargetId);
    if (!npcTarget) return;
    const dx = npcTarget.x - this.playerX;
    const dz = npcTarget.z - this.playerZ;
    const dist = Math.hypot(dx, dz);
    if (dist <= 1.5) return;
    if ((this.pathIndex < this.path.length && dist <= 3) || this._combatPathTimer > 0) return;
    this._combatPathTimer = 0.3;
    const newPath = findPath(this.playerX, this.playerZ, npcTarget.x, npcTarget.z,
      this.isTileBlocked,
      this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
      this.isWallBlockedForPath);
    if (newPath.length > 1) {
      const last = newPath[newPath.length - 1];
      if (Math.floor(last.x) === Math.floor(npcTarget.x) && Math.floor(last.z) === Math.floor(npcTarget.z)) {
        newPath.pop();
      }
    }
    if (newPath.length > 0) {
      this.path = newPath; this.pathIndex = 0;
      if (this.destMarker) this.destMarker.isVisible = false;
      this.minimap?.clearDestination();
    }
  }

  private updateLocalPlayerMovement(dt: number, camPos: Vector3 | null): void {
    if (this.pathIndex >= this.path.length || !this.localPlayer) return;
    if (!this.localPlayer.isWalking()) this.localPlayer.startWalking();

    if (this.combatTargetId >= 0) {
      const npcTarget = this.entities.npcTargets.get(this.combatTargetId);
      if (npcTarget) {
        const toDist = Math.hypot(npcTarget.x - this.playerX, npcTarget.z - this.playerZ);
        if (toDist <= 1.5) {
          // In melee range — halt the path. Don't snap to tile center: a
          // mid-tile fractional position is fine, and snapping is the visible
          // "teleport" players see when entering combat. Next path will use
          // (playerX, playerZ) as tileFrom so movement resumes seamlessly.
          this.pathIndex = this.path.length;
          this.localPlayer.stopWalking();
          this.localPlayer.setPositionXYZ(this.playerX, this.getHeight(this.playerX, this.playerZ), this.playerZ);
          return;
        }
      }
    }

    if (this.pathIndex >= this.path.length) return;
    const target = this.path[this.pathIndex];
    const dx = target.x - this.tileFrom.x;
    const dz = target.z - this.tileFrom.z;
    const tileDist = Math.hypot(dx, dz);

    // RS2-style catch-up scaffolding: when the path queue exceeds the
    // default cadence, accelerate to drain it. Authentic ratios (1.5×, 2×)
    // require swapping to a run animation at the higher speeds — the body
    // moves faster, the legs cycle faster. Re-enable once run is wired up.
    const remaining = this.path.length - this.pathIndex;
    const speedMult = remaining > 3 ? 1.0 : remaining > 2 ? 1.0 : 1.0;
    const effectiveSpeed = this.moveSpeed * speedMult;

    const stepRate = tileDist > 0 ? (effectiveSpeed * dt) / tileDist : 1;
    this.tileProgress += stepRate;

    if (this.tileProgress >= 1.0) {
      this.playerX = target.x;
      this.playerZ = target.z;
      this.tileProgress = 0;
      this.tileFrom = { x: target.x, z: target.z };
      this.pathIndex++;

      if (this.pendingPath) {
        this.path = this.pendingPath;
        this.pathIndex = 0;
        this.pendingPath = null;
      }

      if (this.pathIndex >= this.path.length) {
        if (this.destMarker) this.destMarker.isVisible = false;
        this.minimap?.clearDestination();
        this.localPlayer.stopWalking();
        if (this.pendingSkill) {
          const { objectId, variant } = this.pendingSkill;
          this.pendingSkill = null;
          this.startSkillingVisual(objectId, variant);
        }
      }
    } else {
      this.playerX = this.tileFrom.x + dx * this.tileProgress;
      this.playerZ = this.tileFrom.z + dz * this.tileProgress;
    }

    if (!this.isSkilling) {
      if (camPos && this.pathIndex < this.path.length) {
        const nextTarget = this.path[this.pathIndex];
        this.localPlayer.updateMovementDirection(nextTarget.x - this.playerX, nextTarget.z - this.playerZ, camPos);
      } else if (camPos && (dx !== 0 || dz !== 0)) {
        this.localPlayer.updateMovementDirection(dx, dz, camPos);
      }
    }

    const playerH = this.getHeight(this.playerX, this.playerZ);
    this.localPlayer.setPositionXYZ(this.playerX, playerH, this.playerZ);
    this.inputManager.setPlayerY(playerH);
  }

  private updateHitSplats(dt: number): void {
    if (this.hitSplats.length === 0) return;
    if (!this.ensureOverlayTransform()) return;
    const sp = this._overlayScreenPos;

    let writeIdx = 0;
    for (let i = 0; i < this.hitSplats.length; i++) {
      const splat = this.hitSplats[i];
      splat.timer -= dt;
      splat.worldPos.y += dt * 0.5;
      if (splat.timer <= 0) {
        splat.el.remove();
      } else {
        splat.el.style.opacity = (splat.timer < 0.3 ? splat.timer / 0.3 : 1).toString();
        Vector3.ProjectToRef(splat.worldPos, GameManager.IDENTITY, this._overlayTransform, this._overlayVp, sp);
        splat.el.style.left = `${sp.x}px`;
        splat.el.style.top = `${sp.y}px`;
        this.hitSplats[writeIdx++] = splat;
      }
    }
    this.hitSplats.length = writeIdx;
  }

  private _lastSentY: number = -9999;
  private _ySendCooldown: number = 0;
  private reportYToServer(): void {
    if (!this.localPlayer) return;
    this._ySendCooldown -= 1;
    if (this._ySendCooldown > 0) return;
    const y = this.localPlayer.position.y;
    if (Math.abs(y - this._lastSentY) < 0.05) return;
    this._lastSentY = y;
    this._ySendCooldown = 30; // ~30 frames between reports — coarse, server uses for save only
    this.network.sendRaw(encodePacket(ClientOpcode.CLIENT_POSITION_Y, Math.round(y * 10)));
  }

  private updateIndoorDetection(): void {
    this.reportYToServer();
    const playerY = this.localPlayer?.position.y ?? this.getHeight(this.playerX, this.playerZ);
    const floor = this.currentFloor;

    // Floor changes are server-authoritative — see server/src/World.ts
    // tickTransitions. The client no longer sends floor hints (was an
    // exploit surface and caused refresh-on-floor-1 corruption).

    const underRoof = this.chunkManager.isUnderRoof(this.playerX, this.playerZ, playerY, floor);
    if (underRoof) {
      this._outdoorFrameCount = 0;
      if (!this.isIndoors) {
        this.isIndoors = true;
        this._lastIndoorTileX = -9999;
        this._lastIndoorTileZ = -9999;
      }
    } else {
      this._outdoorFrameCount++;
      if (this._outdoorFrameCount >= 6 && this.isIndoors) {
        this.isIndoors = false;
        for (const node of this.hiddenRoofNodes) node.setEnabled(true);
        this.hiddenRoofNodes = [];
        this._lastIndoorTileX = -9999;
        this._lastIndoorTileZ = -9999;
      }
    }
    if (this.isIndoors) {
      const ptx = Math.floor(this.playerX);
      const ptz = Math.floor(this.playerZ);
      if (ptx !== this._lastIndoorTileX || ptz !== this._lastIndoorTileZ) {
        this._lastIndoorTileX = ptx;
        this._lastIndoorTileZ = ptz;
        this.recomputeHiddenRoofs();
      } else {
        // Even when the tile didn't change, something else may have re-enabled
        // a hidden roof: chunk-radius transitions in updatePlayerPosition
        // unconditionally call setEnabled(true) on every placed node in active
        // chunks (line 543 of ChunkManager) and async chunk loading lands new
        // meshes at default-enabled. Re-asserting setEnabled(false) on the
        // cached hidden set is a no-op when already disabled — Babylon just
        // sets a property — so this is cheap insurance against flicker.
        for (let i = 0; i < this.hiddenRoofNodes.length; i++) {
          const n = this.hiddenRoofNodes[i];
          if (n.isEnabled(false)) n.setEnabled(false);
        }
      }
    }
  }

  /** Compute the new hidden set and apply it as a diff against the current
   *  one — only flip nodes whose desired state actually changed. The previous
   *  "re-enable all old, then disable all new" pattern caused a 1-frame
   *  all-visible flash every time the player crossed a tile because nodes
   *  staying hidden got setEnabled(true) → setEnabled(false) within the same
   *  frame, and Babylon's active-mesh evaluation can pick up the intermediate
   *  state under some scheduling conditions. Diffing avoids that entirely. */
  private recomputeHiddenRoofs(): void {
    const floor = this.currentFloor;
    const py = this.localPlayer?.position.y ?? 0;
    const ceilingY = this.chunkManager.getCeilingHeight(this.playerX, this.playerZ, py);
    const hideAboveY = ceilingY < Infinity ? ceilingY - 0.1 : py + 1.5;

    const newSet = new Set<TransformNode>();
    for (const n of this.chunkManager.getRoofNodesNear(this.playerX, this.playerZ, 8, py + 0.5, floor)) newSet.add(n);
    for (const n of this.chunkManager.getNodesAboveHeight(this.playerX, this.playerZ, 8, hideAboveY)) newSet.add(n);

    // Re-enable nodes that LEFT the hidden set
    for (const node of this.hiddenRoofNodes) {
      if (!newSet.has(node)) node.setEnabled(true);
    }
    // Disable nodes that ENTERED the hidden set (don't touch ones already in)
    const oldSet = new Set(this.hiddenRoofNodes);
    const next: TransformNode[] = [];
    for (const node of newSet) {
      if (!oldSet.has(node)) node.setEnabled(false);
      next.push(node);
    }
    this.hiddenRoofNodes = next;
  }

  private computeDoorEdgeFromRotY(rotY: number): number {
    const deg = Math.round((rotY * 180 / Math.PI) % 360 + 360) % 360;
    if (deg === 0) return WallEdge.N;
    if (deg === 90) return WallEdge.E;
    if (deg === 180) return WallEdge.S;
    if (deg === 270) return WallEdge.W;
    return (deg < 45 || deg > 315) ? WallEdge.N
         : (deg < 135) ? WallEdge.E
         : (deg < 225) ? WallEdge.S
         : WallEdge.W;
  }

  private computeDoorEdgeFromModel(model: TransformNode): number {
    let rotY = 0;
    if (model.rotationQuaternion) {
      const q = model.rotationQuaternion;
      rotY = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
    } else {
      rotY = model.rotation.y;
    }
    return this.computeDoorEdgeFromRotY(rotY);
  }

  private setupDoorPivot(objectEntityId: number): void {
    const model = this.worldObjectModels.get(objectEntityId);
    if (!model || this.doorPivots.has(objectEntityId)) return;

    model.computeWorldMatrix(true);

    let closedRotY = 0;
    if (model.rotationQuaternion) {
      const q = model.rotationQuaternion;
      closedRotY = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
    } else {
      closedRotY = model.rotation.y;
    }

    // Find the door panel mesh (tallest child = the door, not the handle)
    // Its absolute position is the hinge point in world space because
    // the GLB origin was placed at the hinge corner in Blender.
    let hingeWorldPos = model.getAbsolutePosition().clone();
    const childMeshes = model.getChildMeshes();
    let bestHeight = 0;
    for (const m of childMeshes) {
      const bb = m.getBoundingInfo()?.boundingBox;
      if (!bb) continue;
      const h = bb.maximum.y - bb.minimum.y;
      if (h > bestHeight) {
        bestHeight = h;
        m.computeWorldMatrix(true);
        hingeWorldPos = m.getAbsolutePosition().clone();
      }
    }

    const modelWorldPos = model.getAbsolutePosition().clone();

    const pivot = new TransformNode("doorPivot_" + objectEntityId, this.scene);
    pivot.position = hingeWorldPos;
    pivot.rotationQuaternion = null;
    pivot.rotation.y = 0;

    model.rotationQuaternion = null;
    const savedParent = model.parent;
    model.parent = pivot;
    model.position = modelWorldPos.subtract(hingeWorldPos);
    model.rotation.set(0, closedRotY, 0);

    if (savedParent) {
      pivot.parent = savedParent;
    }

    const data = this.worldObjectDefs.get(objectEntityId);
    const startAngle = (data && data.depleted) ? -Math.PI / 2 : 0;

    this.doorPivots.set(objectEntityId, {
      pivot,
      targetAngle: startAngle,
      currentAngle: startAngle,
      closedRotY,
    });

    pivot.rotation.y = startAngle;
  }

  private animateDoor(objectEntityId: number, opening: boolean, swingSign: number = 0): void {
    const entry = this.doorPivots.get(objectEntityId);
    if (!entry) return;
    if (opening) {
      const dir = swingSign >= 0 ? -1 : 1;
      entry.targetAngle = dir * Math.PI / 2;
    } else {
      entry.targetAngle = 0;
    }
  }

  private updateDoorAnimations(_dt: number): void {
    for (const [, entry] of this.doorPivots) {
      entry.currentAngle = entry.targetAngle;
      entry.pivot.rotation.y = entry.targetAngle;
    }
  }

  private updateMinimap(): void {
    if (!this.minimap || !this.chunkManager.isLoaded()) return;
    this._minimapRemotes.length = 0;
    for (const [, target] of this.entities.remoteTargets) {
      this._minimapRemotes.push(target);
    }
    this._minimapNpcs.length = 0;
    for (const [, target] of this.entities.npcTargets) {
      this._minimapNpcs.push(target);
    }
    this._minimapObjects.length = 0;
    for (const [, data] of this.worldObjectDefs) {
      if (data.depleted) continue;
      const def = this.objectDefsCache.get(data.defId);
      if (!def) continue;
      this._minimapObjects.push({ x: data.x, z: data.z, category: def.category });
    }
    this._minimapWallFence = this.chunkManager.getWallFenceObjectsForMinimap(this.playerX, this.playerZ, 22);
    const camAlpha = this.camera.getCamera().alpha;
    this.minimap.update(
      this.playerX, this.playerZ,
      this._minimapRemotes, this._minimapNpcs,
      this.chunkManager,
      camAlpha,
      this._minimapObjects,
      this._minimapWallFence,
    );
  }
}
