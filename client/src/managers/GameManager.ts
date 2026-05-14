import { Engine } from '@babylonjs/core/Engines/engine';
// Aliased so it doesn't collide with the DOM's global `Animation`
// (Web Animations API) — used in private fields below for HTML element
// animations.
import { Animation as BabylonAnimation } from '@babylonjs/core/Animations/animation';
import { Scene } from '@babylonjs/core/scene';

// RS2-style stepped skeletal animation: skip matrix interpolation between
// keyframes so the already-quantized 8-keyframe anims play discrete instead
// of lerping smoothly between poses. Set at module load — applies globally
// to Babylon. Was previously in main.ts but moved here so main.ts can stay
// Babylon-free and load via dynamic import.
BabylonAnimation.AllowMatricesInterpolation = false;
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
import { DialoguePanel, type DialogueNodePayload } from '../ui/DialoguePanel';
import { BankPanel } from '../ui/BankPanel';
import { TradePanel } from '../ui/TradePanel';
import { CharacterCreator } from '../ui/CharacterCreator';
import { LoadingScreen } from '../ui/LoadingScreen';
import { SmithingPanel } from '../ui/SmithingPanel';
import { closeActiveContextMenu, createContextMenu } from '../ui/popupStyle';
import { NPC_NAMES } from '../data/NpcConfig';
import { EQUIP_SLOT_BONES, EQUIP_SLOT_NAMES, TOOL_TIER_METAL_COLOR, type GearOverride } from '../data/EquipmentConfig';
import { ServerOpcode, ClientOpcode, encodePacket, ALL_SKILLS, SKILL_NAMES, ASSET_TO_OBJECT_DEF, WallEdge, doorEdgeFromPlacement, doorClosedEdgeFromRotY, DOOR_EDGE_NEIGHBOR, decodeStringPacket, BIOME_CELL_SIZE, appearanceEquals, PROTOCOL_VERSION, npcCombatLevel, CHARACTER_MODEL_PATH, CHARACTER_TARGET_HEIGHT, CHARACTER_ANIM_DIR, type WorldObjectDef, type ItemDef, type NpcDef, type InventorySlot, type PlayerAppearance, type BiomesFile, type BiomeDef } from '@projectrs/shared';

// Door action labels — mirror server WorldObject.currentActions so right-click
// menu labels reflect the door's current state. Both ends pass actionIndex 0
// for the toggle, so the mismatch was previously a UX bug only.
const DOOR_ACTIONS_CLOSED_CLIENT: readonly string[] = ['Open', 'Examine'];
const DOOR_ACTIONS_OPEN_CLIENT: readonly string[] = ['Close', 'Examine'];

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
  /** Set when the map data finished loading before the network socket was
   *  connected. connectAndAuth flushes MAP_READY as soon as the socket opens. */
  private _sendMapReadyOnConnect: boolean = false;
  /** Settles when WorldObjectModels finishes its initial bulk load. */
  private _objectModelsReady: Promise<void> = Promise.resolve();
  /** Resolves on the first LOGIN_OK packet so connectAndAuth can await full
   *  authentication completion (player position applied, spawn chunks
   *  guaranteed loaded, input enabled). */
  private _loginOkResolver: (() => void) | null = null;
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

  // --- Smooth catch-up slide ---
  // When the divergence-snap fires for a server position that's on the
  // client's current path, we update the logical playerX/Z to the server's
  // tile but render the local player at the OLD visual position briefly,
  // gliding toward the new logical position over slideDurationMs. The result
  // is a fast slide-forward instead of an instant teleport — game logic stays
  // server-authoritative, the visual just catches up smoothly.
  //
  // Independent of `speedMult` in updateLocalPlayerMovement: the catch-up
  // speed-multiplier infrastructure stays in place for a future run anim
  // (set speedMult > 1 when the queue is long, swap walk → run at that
  // speed). Smooth-slide handles intermittent micro-drifts; run anim will
  // handle sustained queue backlog. They compose cleanly.
  private slideOffsetX: number = 0;
  private slideOffsetZ: number = 0;
  private slideStartMs: number = 0;
  private slideDurationMs: number = 200;
  private static readonly SLIDE_DURATION_MS = 200;
  private static readonly HIDDEN_RECONCILE_DIST = 2.5;
  private static readonly VISIBLE_RECONCILE_DIST = 2.25;
  // Tracks when the tab last became hidden. Non-zero means we recently
  // returned to a visible tab and the divergence-snap is armed for ~2 ticks
  // to catch the throttled-prediction backlog. Reset to 0 otherwise so
  // steady-state play doesn't teleport on transient packet jitter.
  private _hiddenSinceMs: number = 0;
  private _visibilityHandler: (() => void) | null = null;
  private _tempVec: Vector3 = new Vector3(); // reusable temp vector to avoid per-frame allocations
  private _minimapRemotes: { x: number; z: number }[] = [];
  private _minimapNpcs: { x: number; z: number }[] = [];
  private _minimapObjects: { x: number; z: number; category: string }[] = [];
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
  /** Resolves when /data/gear-overrides.json has finished loading (or
   *  failed). All gear-attach paths await this before reading gearOverrides
   *  — without that, a PLAYER_EQUIPMENT_BATCH that arrives before the JSON
   *  fetch completes would build GearDef from EQUIP_SLOT_BONES defaults and
   *  cache that template, so saved geardebug rigging never gets applied. */
  private gearOverridesReady: Promise<void> = Promise.resolve();
  private resolveGearOverridesReady: () => void = () => {};

  // Combat follow (local player follows melee target)
  private combatTargetId: number = -1;
  private _combatPathTimer: number = 0;

  // While a COMBAT_HIT splat is delayed to its impact moment, hold off any
  // health-bar updates for the same entity so the bar drops in sync with the
  // splat instead of leading it. Maps entityId → pending timeout handle.
  private pendingHealthApply: Map<number, ReturnType<typeof setTimeout>> = new Map();

  // Character creator
  private characterCreator: CharacterCreator | null = null;
  private characterCreatorOpenPending: boolean = false;
  private localAppearance: PlayerAppearance | null = null;
  /** The server sends MAP_CHANGE as part of login/session placement. That
   *  first map load is not player-facing travel, so don't spam chat with
   *  "Entered Kcmap." on sign-in. Later transitions can still announce. */
  private hasHandledInitialMapChange: boolean = false;

  // Entity management (remote players, NPCs, ground items, sprites)
  private entities!: EntityManager;

  // World objects
  private worldObjectModels: Map<number, TransformNode> = new Map();
  private worldObjectDefs: Map<number, { defId: number; x: number; z: number; depleted: boolean }> = new Map();
  private doorPivots: Map<number, { pivot: TransformNode; targetAngle: number; currentAngle: number; closedRotY: number }> = new Map();
  private doorTiles: Map<number, [number, number]> = new Map();
  /** Tiles blocked by non-depleted world objects (key = `${tileX},${tileZ}`) */
  private blockedObjectTiles: Set<string> = new Set();
  private objectDefsCache: Map<number, WorldObjectDef> = new Map();
  private itemDefsCache: Map<number, ItemDef> = new Map();
  private npcDefsCache: Map<number, NpcDef> = new Map();
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
  private dialoguePanel: DialoguePanel | null = null;
  private smithingPanel: SmithingPanel | null = null;
  private bankPanel: BankPanel | null = null;
  private tradePanel: TradePanel | null = null;

  // Combat hit splats (HTML overlay)
  private hitSplats: { worldPos: Vector3; el: HTMLDivElement; timer: number; startY: number }[] = [];

  // WASD camera
  private keysDown: Set<string> = new Set();

  constructor(
    canvas: HTMLCanvasElement,
    token: string,
    username: string,
    onDisconnect?: () => void,
    preloadedLoadingScreen?: LoadingScreen,
  ) {
    (window as any).gm = this;
    this.gearOverridesReady = new Promise<void>((resolve) => { this.resolveGearOverridesReady = resolve; });
    this.token = token;
    this.username = username;
    // If main.ts already constructed a LoadingScreen (during pre-auth asset
    // preload), reuse it instead of flashing a fresh one on LOGIN_OK. The
    // pre-auth path hides nothing — the same overlay carries through from
    // page load to first playable frame.
    if (preloadedLoadingScreen) {
      this.loadingScreen = preloadedLoadingScreen;
      this.loadingScreen.setStatus('Connecting to world…');
    }

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
      // Cursor click effect only for world clicks — minimap clicks share
      // handleGroundClick but shouldn't spawn an effect at lastClickX/Y
      // (which is the previous world click, not the minimap point).
      this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ffe040');
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

      // OSRS-style left-click auto-attack: if the cursor is over an NPC and
      // the player is at least 10 combat levels above it, treat the click as
      // Attack instead of letting InputManager turn it into a walk-to-tile.
      // Lower-level players still need right-click → Attack so they don't
      // accidentally engage scary mobs while pathing past them. When the level
      // gate blocks the auto-attack we explicitly click *through* the NPC —
      // computing the ground tile via ray-plane projection at player Y —
      // because letting InputManager re-pick can latch onto the NPC mesh
      // itself (sprite-NPC Y sometimes passes its 0.6-tile tolerance and the
      // player walks under the mob instead of past it).
      const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY);
      if (pick?.hit && pick.pickedMesh) {
        const entityId = this.findNpcEntityIdFromPick(pick.pickedMesh, pick.pickedMesh.name);
        if (entityId != null) {
          const npcDefId = this.entities.npcDefs.get(entityId);
          // Treat any server-flagged non-combat NPC as non-attackable here too,
          // so editor-authored dialogue NPCs don't get auto-attacked by a
          // high-level player walking past.
          const interactFlags = this.entities.npcInteractions.get(entityId) ?? 0;
          const attackable = interactFlags === 0 && !this.isNonAttackableNpc(npcDefId);
          if (attackable) {
            const npcLvl = this.npcLevelFor(npcDefId);
            const myLvl = this.getLocalCombatLevel();
            if (npcLvl > 0 && myLvl >= npcLvl + 10) {
              this.attackNpc(entityId);
              // Suppress InputManager's ground-click handling for this event.
              // stopImmediatePropagation also stops same-phase listeners; we
              // use capture so it runs before Babylon's bubble-phase handler.
              e.stopImmediatePropagation();
              e.preventDefault();
              return;
            }
          }
          // Underleveled (or non-attackable) — click *through* the NPC to the
          // ground tile directly beneath the cursor at the player's plane.
          const ray = this.scene.createPickingRay(this.scene.pointerX, this.scene.pointerY, null, this.scene.activeCamera!);
          if (ray.direction.y !== 0) {
            const planeY = this.localPlayer?.position.y ?? 0;
            const t = (planeY - ray.origin.y) / ray.direction.y;
            if (t > 0) {
              const tx = Math.floor(ray.origin.x + ray.direction.x * t) + 0.5;
              const tz = Math.floor(ray.origin.z + ray.direction.z * t) + 0.5;
              this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ffe040');
              this.handleGroundClick(tx, tz);
              e.stopImmediatePropagation();
              e.preventDefault();
              return;
            }
          }
        }
      }
    }, true);

    // Hover tooltip — shows "Name (level-N)" when the cursor is over an NPC.
    this.setupNpcTooltip(canvas);

    // Right-click context menu for NPCs/items
    this.setupContextMenu(canvas);

    // WASD keyboard controls
    this.setupKeyboard();

    // Visibility-change tracking for divergence-snap gating
    this.setupVisibilityHandler();

    // Network. Construction + handler registration always run pre-auth so
    // the socket is ready to receive messages the moment we connect.
    // `connect(token)` is deferred until `connectAndAuth()` (or fires now
    // if a token was passed to the ctor — legacy path used by direct
    // boot-with-known-token tests).
    this.network = new NetworkManager();
    this.setupNetworkHandlers();
    if (token) {
      this.network.connect(token);
    }
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
    this.dialoguePanel = new DialoguePanel(this.network);
    this.smithingPanel = new SmithingPanel();
    this.bankPanel = new BankPanel(this.network);
    this.tradePanel = new TradePanel(this.network);
    this.chatPanel.addSystemMessage(`Welcome to EvilQuest!`);
    this.chatPanel.addSystemMessage(`You last logged in from: ${window.location.hostname}`);

    // Chat message handler
    this.network.onChat((data) => {
      switch (data.type) {
        case 'player_info': {
          const entityId = data.entityId!;
          const name = data.name!;
          this.entities.playerNames.set(entityId, name);
          this.entities.nameToEntityId.set(name.toLowerCase(), entityId);
          // If the remote 3D character was created with a fallback name
          // (chat 'player_info' arrived after PLAYER_SYNC), update its
          // label in place — re-creating the CharacterEntity to swap the
          // label is far too expensive.
          const existing = this.entities.remotePlayers.get(entityId);
          if (existing) existing.setLabel(name);
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

    // Load map. MAP_READY is only sent once we have an authenticated socket,
    // so during preload we just stage the chunk data and defer the packet
    // until connectAndAuth wires the socket up.
    this.chunkManager.loadMap('kcmap').then(async () => {
      await this.loadBiomes('kcmap');
      this.applyFog();
      if (this.network.isConnected()) {
        this.network.sendRaw(encodePacket(ClientOpcode.MAP_READY));
      } else {
        this._sendMapReadyOnConnect = true;
      }
      this.repositionWorldObjects();
    });
    this.loadObjectDefs();
    this.objectModels = new WorldObjectModels(this.scene, (x, z) => this.getHeight(x, z), this.objectDefsCache);
    this._objectModelsReady = this.objectModels.loadAll();
    this.entities = new EntityManager(this.scene, (x, z, cy) => this.getHeightAt(x, z, cy), this.itemDefsCache);

    // Pre-create the local player character at the kcmap default spawn so
    // the GLB + 10 animation GLBs start parsing during the loading screen,
    // not after LOGIN_OK. LOGIN_OK later snaps the position to the real
    // saved spawn (usually a few tiles away — chunks around the default
    // already cover it) and applies the saved appearance.
    this.playerX = 160.5;
    this.playerZ = 170.5;
    this.localPlayer = this.createLocalCharacterEntity();
    this.localPlayer.setPickable(false);
    this.localPlayer.setPositionXYZ(this.playerX, 0, this.playerZ);
    this.inputManager.setEnabled(false);

    // FPS counter (remove stale element from HMR reload)
    document.getElementById('fps-counter')?.remove();
    const fpsEl = document.createElement('div');
    fpsEl.id = 'fps-counter';
    fpsEl.style.cssText = 'position:fixed;top:4px;left:50%;transform:translateX(-50%);color:#0f0;font: bold 14px Arial, Helvetica, sans-serif;z-index:9999;text-shadow:1px 1px 0 #000;pointer-events:none';
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

  /** Resolves once every preload-phase artifact is in memory:
   *   - character GLB + 10 animation GLBs parsed onto the local skeleton
   *   - default kcmap spawn chunks built (terrain + placed objects)
   *   - world-object model templates (trees, stumps, rocks) loaded
   *
   *  Once this resolves the user is one network round-trip away from a
   *  playable world — there is no parse work left to do on the post-auth
   *  path. main.ts awaits this before hiding the LoadingScreen so the
   *  user only sees the login form when nothing else is loading behind
   *  the scenes.
   *
   *  `onProgress` fires when each of the three internal load steps
   *  settles. Three milestones at fixed percentages — coarse but
   *  honest (we don't claim 17% just because one anim of 10 loaded). */
  whenPreloaded(onProgress?: (pct: number, status: string) => void): Promise<void> {
    let completed = 0;
    const step = (status: string) => {
      completed++;
      onProgress?.(completed / 3, `${status} (${completed}/3)`);
    };

    const characterReady = (this.localPlayer?.whenReady() ?? Promise.resolve())
      .then(() => step('Loaded character models'));
    const objectsReady = this._objectModelsReady
      .then(() => step('Loaded scenery models'));
    const chunksReady = this.chunkManager.whenSpawnChunksReady(this.playerX, this.playerZ)
      .then(() => step('Loaded map area'));

    return Promise.all([characterReady, objectsReady, chunksReady]).then(() => {});
  }

  /** Open the WebSocket and wait for the first LOGIN_OK to finish processing
   *  (real spawn position applied, saved appearance applied, input enabled).
   *  Use this after `whenPreloaded()` for a clean "click Login → world is
   *  immediately playable" handoff. */
  connectAndAuth(token: string, username: string): Promise<void> {
    this.token = token;
    this.username = username;
    return new Promise<void>((resolve) => {
      this._loginOkResolver = resolve;
      this.network.connect(token);
      if (this._sendMapReadyOnConnect) {
        this._sendMapReadyOnConnect = false;
        // network.connect is async (WS open). Send once the socket is open.
        this.network.onOpen(() => {
          this.network.sendRaw(encodePacket(ClientOpcode.MAP_READY));
        });
      }
    });
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
    // All four def files are independent — fetch them in parallel.
    // Previously these were four serial awaits, which on a cold start added
    // up to ~200–400ms of dead time over the lifetime of the constructor.
    const [objectsRes, itemsRes, npcsRes, gearRes] = await Promise.all([
      fetch('/data/objects.json').catch((e) => { console.warn('Failed to load object definitions:', e); return null; }),
      fetch('/data/items.json').catch((e) => { console.warn('Failed to load item definitions:', e); return null; }),
      fetch('/data/npcs.json').catch((e) => { console.warn('Failed to load NPC definitions:', e); return null; }),
      fetch('/data/gear-overrides.json').catch((e) => { console.warn('Failed to load gear overrides:', e); return null; }),
    ]);

    if (objectsRes) {
      try {
        const defs: WorldObjectDef[] = await objectsRes.json();
        for (const def of defs) this.objectDefsCache.set(def.id, def);
        this.rebuildBlockedObjectTiles();
      } catch (e) {
        console.warn('Failed to parse object definitions:', e);
      }
    }
    if (itemsRes) {
      try {
        const defs: ItemDef[] = await itemsRes.json();
        for (const def of defs) this.itemDefsCache.set(def.id, def);
        if (this.sidePanel) this.sidePanel.setItemDefs(this.itemDefsCache);
        if (this.bankPanel) this.bankPanel.setItemDefs(this.itemDefsCache);
        if (this.tradePanel) this.tradePanel.setItemDefs(this.itemDefsCache);
      } catch (e) {
        console.warn('Failed to parse item definitions:', e);
      }
    }
    if (npcsRes) {
      try {
        const defs: NpcDef[] = await npcsRes.json();
        for (const def of defs) this.npcDefsCache.set(def.id, def);
      } catch (e) {
        console.warn('Failed to parse NPC definitions:', e);
      }
    }
    if (gearRes) {
      try {
        const overrides: Record<string, GearOverride> = await gearRes.json();
        this.gearOverrides.clear();
        for (const [id, override] of Object.entries(overrides)) {
          this.gearOverrides.set(Number(id), override);
        }
        console.log(`[Gear] Loaded ${this.gearOverrides.size} gear overrides`);
      } catch (e) {
        console.warn('Failed to parse gear overrides:', e);
      }
    }
    // Unblock any equip calls that came in before this fetch finished.
    // Without this gate, applyGearToCharacter would build a GearDef from
    // EQUIP_SLOT_BONES defaults (gearOverrides empty) and cache that template
    // — saved geardebug rigging would never make it into the visual.
    this.resolveGearOverridesReady();
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
    attack_2h_slash:         0.5,
    attack_2h_smash:         0.5,
    attack_punch:            0.4,
    kick:                    0.5,
    bow_attack:              0.6,
  };

  /**
   * Choose the correct attack animation name based on stance and weapon.
   * - 1H weapon (any stance)     → 'attack_slash' (hand-authored OSRS-style slash)
   * - 2H weapon + aggressive     → 'attack_2h_smash'
   * - 2H weapon + other stance   → 'attack_2h_slash'
   * - No weapon + aggressive     → 'kick'
   * - No weapon + other stance   → 'attack_punch'
   * Remote players' weapon + stance come from PLAYER_REMOTE_EQUIPMENT and
   * PLAYER_REMOTE_STANCE caches; missing cache entries fall back to unarmed.
   */
  private getPlayerAttackAnimName(attackerId: number): string {
    let weaponId = 0;
    let stance = 'accurate';
    if (attackerId === this.localPlayerId && this.sidePanel) {
      weaponId = this.sidePanel.getEquipItem(0);
      stance = this.sidePanel.getStance();
    } else if (this.entities.remotePlayers.has(attackerId)) {
      // Equipment slot 0 = weapon (see PLAYER_REMOTE_EQUIPMENT layout).
      const eq = this.entities.remoteEquipment.get(attackerId);
      weaponId = eq?.[0] ?? 0;
      stance = this.entities.remoteStances.get(attackerId) ?? 'accurate';
    } else {
      // NPC or unknown attacker — default unarmed punch.
      return 'attack_punch';
    }
    if (weaponId > 0) {
      const weaponDef = this.itemDefsCache.get(weaponId);
      const style = weaponDef?.weaponStyle;
      if (style === 'bow' || style === 'crossbow') return 'bow_attack';
      if (weaponDef?.twoHanded) return stance === 'aggressive' ? 'attack_2h_smash' : 'attack_2h_slash';
      return 'attack_slash';
    }
    if (stance === 'aggressive') return 'kick';
    return 'attack_punch';
  }

  /** Reposition all world objects/models after heightmap loads (fixes race condition) */
  private repositionWorldObjects(): void {
    for (const [objectEntityId, data] of this.worldObjectDefs) {
      const h = this.getHeight(data.x, data.z);
      const doorEntry = this.doorPivots.get(objectEntityId);
      if (doorEntry) {
        // Doors keep the Y they were authored with — upper-floor doors live
        // above floor-0 terrain and would be invisible if snapped down.
        // setupDoorPivot already set the pivot Y from the model's absolute
        // position, which respects the placement file's y value.
      } else {
        const model = this.worldObjectModels.get(objectEntityId);
        if (model) {
          model.position.y = h;
        }
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
      const modelRotY = this.modelRotY(placedNode);
      const { tile: [tx, tz], edge: wallEdge } = doorEdgeFromPlacement(data.x, data.z, modelRotY);
      this.doorTiles.set(objectEntityId, [tx, tz]);
      const nb = DOOR_EDGE_NEIGHBOR[wallEdge];
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

  /** Apply an equipment-slot array (matches PLAYER_REMOTE_EQUIPMENT layout)
   *  to a CharacterEntity. Each slot is loaded asynchronously; ordering
   *  doesn't matter since slots don't depend on each other. */
  private applyRemoteEquipmentArray(target: CharacterEntity, slots: number[]): void {
    // Order matches EQUIP_SLOT_NAMES on the server-side encoder.
    const SLOT_ORDER: string[] = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];
    for (let i = 0; i < SLOT_ORDER.length; i++) {
      const slotName = SLOT_ORDER[i];
      const itemId = slots[i] ?? 0;
      // Fire-and-forget — failures are logged inside loadGearSmart.
      void this.applyGearToCharacter(target, slotName, itemId, /* isLocal */ false);
    }
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
    await this.applyGearToCharacter(this.localPlayer, slotName, itemId, /* isLocal */ true);
  }

  /**
   * Shared gear apply path used by both the local player and remote
   * CharacterEntities. `isLocal` controls editor-only behaviors (preview node
   * disposal) that don't apply to remotes.
   *
   * Skinned and head slots can't share cached templates across characters
   * (they bind to specific skeletons / depend on per-character bone bind
   * poses), so they always re-enter loadGearSmart with the target. Other
   * slots use the shared template cache and `attachGear` clones the template
   * per character.
   */
  private async applyGearToCharacter(
    target: CharacterEntity,
    slotName: string,
    itemId: number,
    isLocal: boolean,
  ): Promise<void> {
    // Unequip
    if (itemId <= 0) {
      target.detachGear(slotName);
      target.detachSkinnedArmor(slotName);
      if (isLocal) this.disposeArmorSlot(slotName);
      return;
    }

    // Already wearing this item?
    if (target.getGearItemId(slotName) === itemId) return;

    const boneConfig = EQUIP_SLOT_BONES[slotName];
    if (!boneConfig) return;

    // Wait for gear-overrides.json to finish loading before reading from it.
    // PLAYER_EQUIPMENT_BATCH from the server can land before that fetch
    // completes; without this gate we'd silently use EQUIP_SLOT_BONES
    // defaults and cache the resulting (wrong) template.
    await this.gearOverridesReady;

    const buildDef = (): GearDef => {
      // gearOverrides is a global rigging file (server/data/gear-overrides.json)
      // — every client fetches the same data, so the override applies to BOTH
      // local and remote characters. Without this, remote viewers see your
      // rigged gear at the EQUIP_SLOT_BONES defaults (random bones).
      const override = this.gearOverrides.get(itemId);
      const itemDef = this.itemDefsCache.get(itemId);
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
      return {
        itemId,
        file: gearFile,
        boneName: override?.boneName ?? boneConfig.boneName,
        localPosition: override?.localPosition ?? boneConfig.localPosition,
        localRotation: override?.localRotation ?? boneConfig.localRotation,
        scale: override?.scale ?? boneConfig.scale,
        centerOrigin: override?.centerOrigin ?? false,
        metalColor: TOOL_TIER_METAL_COLOR[itemId],
      };
    };

    // Slot names whose loaded GLB binds to a specific skeleton — these CAN'T
    // share cached templates, so we always reload per target. Note: 'head'
    // is NOT in this set even though its loadGearSmart path is special;
    // the head path returns a sharable template (mesh offsets are computed
    // against the armor GLB's own bones, not the character's), so it routes
    // through the cache below like any other bone-attached slot.
    const PER_TARGET_SLOTS = new Set(['body', 'legs', 'hands', 'feet', 'cape']);
    if (PER_TARGET_SLOTS.has(slotName)) {
      await this.loadGearSmart(slotName, itemId, buildDef(), target);
      return;
    }

    // Cache-shareable bone-attached gear (weapon, shield, neck, ring).
    const cacheKey = `${slotName}/${itemId}`;
    if (isLocal) this.gearTemplateCache.delete(cacheKey);
    let template = this.gearTemplateCache.get(cacheKey);
    if (!template) {
      let promise = this.gearLoadingPromises.get(cacheKey);
      if (!promise) {
        promise = (async () => {
          const tmpl = await this.loadGearSmart(slotName, itemId, buildDef(), target);
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
    if (template) {
      target.attachGear(slotName, itemId, template);
    }
  }

  /**
   * Load a gear GLB. If it has a skeleton, set it up as skinned armor
   * (bone-sync per frame) on `target` and return null. Otherwise return a
   * GearTemplate for bone-parenting (which the caller is free to share
   * across multiple characters via attachGear).
   */
  private async loadGearSmart(slotName: string, itemId: number, def: GearDef, target?: CharacterEntity | null): Promise<GearTemplate | null> {
    const character = target ?? this.localPlayer;
    const isLocal = character === this.localPlayer;
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
        character
      ) {
        const ok = await character.attachManualSkinnedArmor(slotName, def.file, result.meshes, itemId);
        if (ok) {
          const loaderRoot = result.meshes.find(m => m.name === '__root__');
          if (loaderRoot) loaderRoot.dispose();
          return null;
        }
      }

      if (result.skeletons.length > 0 && character) {
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

        character.detachGear(slotName);
        if (isLocal) this.disposeArmorSlot(slotName);

        character.attachSkinnedArmor(slotName, result.meshes, result.skeletons[0], itemId);
        const loaderRoot = result.meshes.find(m => m.name === '__root__');
        if (loaderRoot) loaderRoot.dispose();

        // Apply saved override transforms for fine-tuning fit. gearOverrides
        // is a global rigging file shared across all clients, so it applies
        // to both local and remote characters — without this, remote viewers
        // see your rigged armor offset to wrong positions.
        const override = this.gearOverrides.get(itemId);
        if (override) {
          character.applySkinnedArmorTransform(slotName, override);
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

    // PBR → flat conversion (matches main character + skinned-armor paths).
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
      modelPath: CHARACTER_MODEL_PATH,
      targetHeight: CHARACTER_TARGET_HEIGHT,
      // No label on the local player — matches pre-3D-remote-players behavior.
      // Other players see the local player's name through PLAYER_SYNC + the
      // chat 'player_info' broadcast.
      // Each GLB should hold a single action; the runtime picks it automatically
      // so re-exports don't require renaming the action in Blender first.
      additionalAnimations: [
        { name: 'idle',                    path: `${CHARACTER_ANIM_DIR}/idle.glb` },
        { name: 'walk',                    path: `${CHARACTER_ANIM_DIR}/walk.glb` },
        // RS2 turn-on-the-spot. CharacterEntity swaps idle ↔ turn based on
        // yaw alignment in updateAnimation(); see comment there.
        { name: 'turn',                    path: `${CHARACTER_ANIM_DIR}/turn in place.glb` },
        // Armed attack — hand-authored OSRS-style slash for all stances.
        { name: 'attack_slash',            path: `${CHARACTER_ANIM_DIR}/attack_slash.glb` },
        { name: 'attack_2h_slash',         path: `${CHARACTER_ANIM_DIR}/2h slash.glb` },
        { name: 'attack_2h_smash',         path: `${CHARACTER_ANIM_DIR}/2h smash.glb` },
        { name: 'attack_punch',            path: `${CHARACTER_ANIM_DIR}/Punch.glb` },
        { name: 'kick',                    path: `${CHARACTER_ANIM_DIR}/kick.glb` },
        { name: 'chop',                    path: `${CHARACTER_ANIM_DIR}/woodcutting.glb` },
        { name: 'mine',                    path: `${CHARACTER_ANIM_DIR}/mining.glb` },
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
      // Protocol version handshake. Older server builds won't send v[4] —
      // treat undefined as "same version" so a fresh client doesn't refuse
      // to connect to an older server during a rolling deploy. New servers
      // always send it; a stale CACHED client tab from yesterday's build
      // would receive a version it doesn't know about and refuse.
      const serverProtoVersion = v[4];
      if (typeof serverProtoVersion === 'number' && serverProtoVersion !== PROTOCOL_VERSION) {
        console.error(`[proto] version mismatch: client=${PROTOCOL_VERSION} server=${serverProtoVersion}`);
        alert(`This client is out of date (protocol v${PROTOCOL_VERSION} vs server v${serverProtoVersion}). Please refresh the page to load the latest build.`);
        try { this.network.close(); } catch {}
        return;
      }

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

      // The local character was pre-created in the ctor at the kcmap default
      // spawn (so its GLB + 10 animation GLBs parsed during the loading
      // screen). Snap it to the real saved position, then apply any cached
      // appearance once the model finishes loading.
      if (this.localPlayer) {
        this.localPlayer.setPositionXYZ(this.playerX, spawnY, this.playerZ);
      }
      this.inputManager.setPlayerY(spawnY);
      console.log(`Logged in at (${this.playerX}, ${spawnY}, ${this.playerZ})`);

      // Wait for any chunks around the saved spawn that weren't part of the
      // preloaded default-spawn cluster (usually nothing — the saved spawn
      // is typically in the same chunk we already loaded). Apply appearance
      // and clear the loading screen once everything's in place.
      const characterReady = this.localPlayer?.whenReady().then(() => {
        if (this.localAppearance && this.localPlayer) {
          this.localPlayer.applyAppearance(this.localAppearance);
        }
      }) ?? Promise.resolve();
      const worldReady = this.chunkManager.whenSpawnChunksReady(this.playerX, this.playerZ);
      Promise.all([characterReady, worldReady]).then(() => {
        // Snap Y to client-computed ground height — see comment in the
        // pre-refactor version of this handler for why.
        if (this.localPlayer) {
          const groundY = this.getHeight(this.playerX, this.playerZ);
          this.localPlayer.setPositionXYZ(this.playerX, groundY, this.playerZ);
          this.inputManager.setPlayerY(groundY);
        }
        this.loadingScreen?.hide();
        this.loadingScreen = null;
        this.inputManager.setEnabled(true);

        // Settle the connectAndAuth() promise so main.ts can dismiss the
        // (already-min-display-clamped) LoadingScreen and reveal the world.
        if (this._loginOkResolver) {
          const resolver = this._loginOkResolver;
          this._loginOkResolver = null;
          resolver();
        }
      });
    });

    this.network.on(ServerOpcode.SHOW_CHARACTER_CREATOR, () => {
      this.openCharacterCreatorWhenReady();
    });
  }

  private setupEntitySyncHandlers(): void {
    this.network.on(ServerOpcode.PLAYER_SYNC, (_op, v) => {
      const [entityId, x10, z10, health, maxHealth] = v;
      const x = x10 / 10;
      const z = z10 / 10;

      const hasAppearance = v.length >= 12 && v[5] >= 0;
      const syncAppearance: PlayerAppearance | null = hasAppearance ? {
        shirtColor: v[5], pantsColor: v[6], shoesColor: v[7], hairColor: v[8], beltColor: v[9], skinColor: v[10],
        hairStyle: v[11],
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
        // Server-position reconciliation. The client still predicts normal
        // walking locally, but production desyncs showed several legitimate
        // server-side path changes can happen without the local path matching
        // exactly (pickup queues, wall closures, interaction stops). Keep the
        // threshold above ordinary tick jitter, then accept the server before
        // a small disagreement turns into a multi-tile split.
        const serverX = v[1] / 10;
        const serverZ = v[2] / 10;
        const dx = serverX - this.playerX;
        const dz = serverZ - this.playerZ;
        const hiddenCatchup = this._hiddenSinceMs !== 0;
        const reconcileDist = hiddenCatchup
          ? GameManager.HIDDEN_RECONCILE_DIST
          : GameManager.VISIBLE_RECONCILE_DIST;
        if (dx * dx + dz * dz > reconcileDist * reconcileDist) {
          this.reconcileLocalPlayerToServer(serverX, serverZ, hiddenCatchup);
        }
        if (syncAppearance && !appearanceEquals(this.localAppearance, syncAppearance)) {
          this.localAppearance = syncAppearance;
          if (this.localPlayer) this.localPlayer.applyAppearance(syncAppearance);
        }
        return;
      }

      const isNew = !this.entities.remotePlayers.has(entityId);
      if (isNew) {
        const playerName = this.entities.playerNames.get(entityId) || 'Player';
        const remote = this.entities.createRemotePlayer(entityId, x, z, playerName);
        // Apply cached appearance + equipment once the GLB + animations finish
        // loading. Both arrive over the network independently of the entity's
        // local-load timing, so we cache them in the EntityManager and flush
        // here when the model is actually ready to receive them.
        remote.whenReady().then(() => {
          // The entity may have been removed before the load completed.
          if (this.entities.remotePlayers.get(entityId) !== remote) return;
          const appearance = this.entities.remoteAppearances.get(entityId);
          if (appearance) remote.applyAppearance(appearance);
          const eq = this.entities.remoteEquipment.get(entityId);
          if (eq) this.applyRemoteEquipmentArray(remote, eq);
        });
      }
      if (syncAppearance) {
        const prev = this.entities.remoteAppearances.get(entityId);
        if (!appearanceEquals(prev ?? null, syncAppearance)) {
          this.entities.remoteAppearances.set(entityId, syncAppearance);
          const remote = this.entities.remotePlayers.get(entityId);
          if (remote && !isNew) {
            // Only apply post-load — the new-entity path schedules it via
            // whenReady. Calling applyAppearance before load is a no-op.
            remote.applyAppearance(syncAppearance);
          }
        }
      }
      // Detect server-driven movement: if the new target differs from the
      // last one, the entity is in motion and we should keep its walk
      // animation looping until the next sync would have arrived (~600 ms).
      // Without this, the visual-position interp finishes a tile-step,
      // momentarily satisfies dist≤0.05, and the renderer flips to idle for
      // a frame before the next PLAYER_SYNC bumps the target again.
      const prev = this.entities.remoteTargets.get(entityId);
      if (!prev || Math.abs(prev.x - x) > 0.001 || Math.abs(prev.z - z) > 0.001) {
        // Grace = 1.5 server ticks. Long enough to bridge a normal 600 ms
        // tick gap plus jitter, short enough to drop to idle quickly when
        // the player actually stops walking.
        this.entities.remoteWalkUntil.set(entityId, performance.now() + 900);
      }
      this.entities.remoteTargets.set(entityId, { x, z });
      const character = this.entities.remotePlayers.get(entityId)!;
      // Skip bar update if a COMBAT_HIT splat is pending — splat closure
      // applies the bar at impact time so they stay in sync.
      if (!this.pendingHealthApply.has(entityId)) {
        if (health < maxHealth) {
          character.showHealthBar(health, maxHealth);
        } else {
          character.hideHealthBar();
        }
      }
    });

    this.network.on(ServerOpcode.PLAYER_REMOTE_EQUIPMENT, (_op, v) => {
      // Layout: [entityId, weapon, shield, head, body, legs, neck, ring, hands, feet, cape]
      const entityId = v[0];
      const slots = v.slice(1, 11);
      // Cache so the apply re-runs if/when the entity is (re)created.
      this.entities.remoteEquipment.set(entityId, slots);
      const remote = this.entities.remotePlayers.get(entityId);
      if (remote && remote.isReady) {
        this.applyRemoteEquipmentArray(remote, slots);
      }
    });

    this.network.on(ServerOpcode.PLAYER_REMOTE_STANCE, (_op, v) => {
      // Layout: [entityId, stanceIdx]. Index matches the server's stance order.
      const entityId = v[0];
      const idx = v[1] ?? 0;
      const stances = ['accurate', 'aggressive', 'defensive', 'controlled'];
      const stance = stances[idx] ?? 'accurate';
      this.entities.remoteStances.set(entityId, stance);
    });

    this.network.on(ServerOpcode.NPC_SYNC, (_op, v) => {
      const [entityId, npcDefId, x10, z10, health, maxHealth] = v;
      const x = x10 / 10;
      const z = z10 / 10;

      this.entities.npcDefs.set(entityId, npcDefId);

      if (!this.entities.npcSprites.has(entityId)) {
        // NPCs without a dedicated NPC_3D_MODELS entry render as CharacterEntity
        // and are LOD/budget-gated — createNpc returns null when out of range,
        // and we retry on the next NPC_SYNC tick once the player gets closer.
        const render3D = this.entities.shouldRender3DNpc(entityId, x, z, this.playerX, this.playerZ);
        const created = this.entities.createNpc(entityId, npcDefId, x, z, render3D);
        if (created instanceof CharacterEntity) {
          const character = created;
          // Apply cached appearance + equipment once the GLB + animations
          // finish loading. Mirrors the remote-player whenReady flush above.
          void character.whenReady().then(() => {
            if (this.entities.npcSprites.get(entityId) !== character) return;
            const appearance = this.entities.npcAppearances.get(entityId);
            if (appearance) character.applyAppearance(appearance);
            const eq = this.entities.npcEquipment.get(entityId);
            if (eq) this.applyRemoteEquipmentArray(character, eq);
          });
        }
      }

      const prev = this.entities.npcTargets.get(entityId);
      this.entities.npcTargets.set(entityId, {
        x, z,
        prevX: prev ? prev.x : x,
        prevZ: prev ? prev.z : z,
        t: performance.now(),
      });

      const sprite = this.entities.npcSprites.get(entityId);
      if (sprite && !this.pendingHealthApply.has(entityId)) {
        if (health < maxHealth) {
          sprite.showHealthBar(health, maxHealth);
        } else {
          sprite.hideHealthBar();
        }
      }
    });

    this.network.on(ServerOpcode.NPC_APPEARANCE, (_op, v) => {
      const entityId = v[0];
      const appearance: PlayerAppearance = {
        shirtColor: v[1], pantsColor: v[2], shoesColor: v[3],
        hairColor:  v[4], beltColor:  v[5], skinColor:  v[6],
        hairStyle:  v[7],
      };
      this.entities.npcAppearances.set(entityId, appearance);
      // Live-apply for an already-rendered customizable NPC (admin /npcedit).
      const sprite = this.entities.npcSprites.get(entityId);
      if (sprite instanceof CharacterEntity && sprite.isReady) {
        sprite.applyAppearance(appearance);
      }
    });

    this.network.on(ServerOpcode.NPC_EQUIPMENT, (_op, v) => {
      // Layout: [entityId, weapon, shield, head, body, legs, neck, ring, hands, feet, cape]
      const entityId = v[0];
      const slots = v.slice(1, 11);
      this.entities.npcEquipment.set(entityId, slots);
      const sprite = this.entities.npcSprites.get(entityId);
      if (sprite instanceof CharacterEntity && sprite.isReady) {
        this.applyRemoteEquipmentArray(sprite, slots);
      }
    });

    this.network.on(ServerOpcode.NPC_INTERACTIONS, (_op, v) => {
      // [entityId, flagBits]. Cached so the right-click menu can offer
      // Talk-to / Trade / Bank without round-tripping every click.
      this.entities.npcInteractions.set(v[0], v[1]);
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

      // Detect a state transition on a door we already know about. This fires
      // on chunk re-entry: we left range, the door state changed (someone
      // else opened it, or it persisted open across our session), now we
      // walk back into broadcast range and the server re-syncs. Without
      // bridging this transition explicitly the door's pivot keeps its old
      // pose and openDoorEdges keeps its old bypass — so the wall reads
      // closed locally even though the server thinks it's open.
      const prev = this.worldObjectDefs.get(objectEntityId);
      const stateChangedForDoor =
        prev != null &&
        prev.depleted !== isDepleted &&
        this.objectDefsCache.get(objectDefId)?.category === 'door';

      this.worldObjectDefs.set(objectEntityId, { defId: objectDefId, x, z, depleted: isDepleted });

      const def = this.objectDefsCache.get(objectDefId);

      if (stateChangedForDoor) {
        const doorEntry = this.doorPivots.get(objectEntityId);
        const rotY = doorEntry ? doorEntry.closedRotY : 0;
        const { tile: [tx, tz], edge } = doorEdgeFromPlacement(x, z, rotY);
        this.chunkManager.setOpenDoorEdges(tx, tz, edge, isDepleted);
        const nb = DOOR_EDGE_NEIGHBOR[edge];
        if (nb) {
          this.chunkManager.setOpenDoorEdges(tx + nb.dx, tz + nb.dz, nb.opposite, isDepleted);
        }
        // animateDoor only runs if the pivot exists; if it doesn't yet (chunk
        // still loading), linkPlacedNodeToEntity will pick the correct pose
        // when it sets the pivot up.
        this.animateDoor(objectEntityId, isDepleted, 0);
      }

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
        }
        // If no placed GLB and the chunk has finished loading, the world
        // object simply isn't rendered. Pre-3D maps had a sprite fallback
        // here; with the editor pipeline every object should now have a GLB.
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
          const doorEntry = this.doorPivots.get(objectEntityId);
          const rotY = doorEntry ? doorEntry.closedRotY : 0;
          const { tile: [tx, tz], edge } = doorEdgeFromPlacement(data.x, data.z, rotY);

          const opened = isDepleted === 1;
          // Leave the wall mask alone — only toggle openDoorEdges. The
          // wall-block check uses elevation-gated openDoorEdges as the
          // bypass mechanism (see ChunkManager.wallEdgeBlocksAtHeight), so
          // clearing the mask would let players at the wrong elevation
          // skip through.
          this.chunkManager.setOpenDoorEdges(tx, tz, edge, opened);
          const nb = DOOR_EDGE_NEIGHBOR[edge];
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
      if (this.sidePanel) this.sidePanel.updateInvSlot(slotIndex, itemId, quantity);
      if (this.bankPanel) this.bankPanel.updateInventorySlot(slotIndex, itemId, quantity);
      if (this.tradePanel) this.tradePanel.updateInventorySlot(slotIndex, itemId, quantity);
    });

    // Batch inventory: [slot0_itemId, slot0_qty, slot1_itemId, slot1_qty, ...]
    this.network.on(ServerOpcode.PLAYER_INVENTORY_BATCH, (_op, v) => {
      for (let i = 0; i < v.length; i += 2) {
        const slot = i / 2;
        if (this.sidePanel) this.sidePanel.updateInvSlot(slot, v[i], v[i + 1]);
        if (this.bankPanel) this.bankPanel.updateInventorySlot(slot, v[i], v[i + 1]);
        if (this.tradePanel) this.tradePanel.updateInventorySlot(slot, v[i], v[i + 1]);
      }
    });

    // --- Bank ---
    this.network.on(ServerOpcode.BANK_OPEN, (_op, v) => {
      // Layout: [count, slot1, itemId1, qtyHigh1, qtyLow1, ...]
      const count = v[0] ?? 0;
      const filled: { slot: number; itemId: number; quantity: number }[] = [];
      for (let i = 0; i < count; i++) {
        const base = 1 + i * 4;
        if (base + 3 >= v.length) break;
        const qty = (v[base + 2] << 16) | (v[base + 3] & 0xFFFF);
        filled.push({ slot: v[base], itemId: v[base + 1], quantity: qty });
      }
      this.bankPanel?.openWithContents(filled);
    });
    this.network.on(ServerOpcode.BANK_UPDATE_SLOT, (_op, v) => {
      const [slot, itemId, qtyHi, qtyLo] = v;
      const qty = (qtyHi << 16) | (qtyLo & 0xFFFF);
      this.bankPanel?.updateBankSlot(slot, itemId, qty);
    });
    this.network.on(ServerOpcode.BANK_CLOSE, () => {
      this.bankPanel?.hide(/*notifyServer*/ false);
    });

    // --- Trade ---
    this.network.on(ServerOpcode.TRADE_REQUEST_RECEIVED, (_op, v) => {
      const requesterEntityId = v[0];
      const name = this.entities.playerNames.get(requesterEntityId) ?? `Player ${requesterEntityId}`;
      this.tradePanel?.showIncomingRequest(requesterEntityId, name);
    });
    this.network.on(ServerOpcode.TRADE_OPEN, (_op, v) => {
      const otherEntityId = v[0];
      const name = this.entities.playerNames.get(otherEntityId) ?? `Player ${otherEntityId}`;
      this.tradePanel?.openSession(otherEntityId, name);
    });
    this.network.on(ServerOpcode.TRADE_OFFER_UPDATE, (_op, v) => {
      const [side, slot, itemId, qtyHi, qtyLo] = v;
      const qty = (qtyHi << 16) | (qtyLo & 0xFFFF);
      this.tradePanel?.updateOffer(side, slot, itemId, qty);
    });
    this.network.on(ServerOpcode.TRADE_ACCEPT_STATE, (_op, v) => {
      this.tradePanel?.updateAcceptState(v[0] ?? 0, v[1] ?? 0);
    });
    this.network.on(ServerOpcode.TRADE_CLOSE, (_op, v) => {
      this.tradePanel?.close(v[0] ?? 2);
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
    this.network.on(ServerOpcode.PLAYER_TELEPORT, (_op, values) => {
      // Lightweight same-map teleport: snap position + reset path, no
      // chunk/entity reload.
      const newX = (values[0] ?? 0) / 10;
      const newZ = (values[1] ?? 0) / 10;
      const newY = (values[2] ?? 0) / 10;
      this.playerX = newX;
      this.playerZ = newZ;
      this.path = [];
      this.pathIndex = 0;
      this.tileProgress = 0;
      this.pendingPath = null;
      this.tileFrom = { x: newX, z: newZ };
      this.combatTargetId = -1;
      this.isSkilling = false;
      this.skillingObjectId = -1;
      this.pendingSkill = null;
      if (this.localPlayer) {
        this.localPlayer.stopWalking();
        this.localPlayer.setPositionXYZ(newX, newY, newZ);
      }
      this.inputManager.setPlayerY(newY);
      if (this.destMarker) this.destMarker.isVisible = false;
      if (this.interactMarker) this.interactMarker.isVisible = false;
      this.minimap?.clearDestination();
      // Camera will follow naturally via its target on the next tick.
    });

    this.network.on(ServerOpcode.PATH_TRUNCATED, (_op, v) => {
      // Server validated our requested path short — collision/wall edge
      // somewhere mid-path. Trim our local walk so it ends at the last
      // reachable tile center the server reports. Without this, the visual
      // keeps marching past the server's stop point and the >1.5-tile
      // divergence-snap in PLAYER_SYNC fires, producing a visible teleport.
      const lastX = (v[0] ?? 0) / 10;
      const lastZ = (v[1] ?? 0) / 10;
      const tx = Math.floor(lastX);
      const tz = Math.floor(lastZ);
      // Find the path waypoint matching the server's final reachable tile.
      // Cut everything *after* it. If the player's already past that tile,
      // leave the path alone and let divergence-snap handle the rest.
      let cutIdx = -1;
      for (let i = 0; i < this.path.length; i++) {
        const wp = this.path[i];
        if (Math.floor(wp.x) === tx && Math.floor(wp.z) === tz) {
          cutIdx = i + 1;
          break;
        }
      }
      if (cutIdx >= 0 && cutIdx < this.path.length) {
        this.path = this.path.slice(0, cutIdx);
      }
    });

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
      } else if (opcode === ServerOpcode.DIALOGUE_OPEN) {
        const { str, values } = decodeStringPacket(data);
        try {
          const node = JSON.parse(str) as DialogueNodePayload;
          const npcEntityId = values[0];
          // Mid-conversation node transitions just call show() again with the
          // new node; DialoguePanel.show resets the line index so a multi-line
          // node restarts from line 0.
          this.dialoguePanel?.show(npcEntityId, node);
        } catch (e) {
          console.warn('[dialogue] failed to parse node payload', e);
        }
      } else if (opcode === ServerOpcode.DIALOGUE_CLOSE) {
        this.dialoguePanel?.hide();
      }
    });
  }

  private async handleMapChange(mapId: string, newX: number, newZ: number): Promise<void> {
    console.log(`Map change to '${mapId}' at (${newX}, ${newZ})`);

    this.entities.disposeAllEntities();

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

    if (!this.hasHandledInitialMapChange) {
      this.hasHandledInitialMapChange = true;
    } else if (this.chatPanel) {
      this.chatPanel.addSystemMessage(`Entered ${this.chunkManager.getMeta()?.name || mapId}.`, '#0f0');
    }
  }

  private setupContextMenu(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.hideContextMenu();
      // Same gate as left-click: don't surface interaction options against a
      // half-streamed world.
      if (!this.inputManager.isEnabled()) return;

      const pickResult = this.scene.pick(this.scene.pointerX, this.scene.pointerY);
      if (!pickResult?.hit || !pickResult.pickedMesh) return;

      const meshName = pickResult.pickedMesh.name;
      const options: { label: string; action: () => void }[] = [];

      // Identify the picked NPC. 3D-modeled NPCs (e.g. cows) all share mesh
      // names from their source GLB, so name matching is ambiguous — every
      // cow click would route to whichever cow happened to be first in the
      // npcSprites map. Check metadata.entityId (stamped by Npc3DEntity.
      // setEntityIdMetadata and CharacterEntity.setEntityIdMetadata) by
      // walking up the picked node's parents.
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
      if (pickedNpcEntityId != null) {
        const entityId = pickedNpcEntityId;
        const npcDefId = this.entities.npcDefs.get(entityId);
        const name = NPC_NAMES[npcDefId || 0] || 'NPC';
        // Prefer the server-sent interaction flags (NPC_INTERACTIONS) over the
        // hardcoded isNonAttackableNpc allow-list — that list pre-dates the
        // server telling us, and would mislabel any new editor-authored NPC.
        // Flags: bit 0 = dialogue, bit 1 = shop, bit 2 = bank.
        const flags = this.entities.npcInteractions.get(entityId) ?? 0;
        const nonCombat = flags !== 0 || this.isNonAttackableNpc(npcDefId);
        if (nonCombat) {
          // Talk-to handles all three (dialogue → priority on server, else
          // falls through to shop, then bank). One label keeps the menu tidy.
          const verb = (flags & 1) !== 0 ? 'Talk-to' : 'Trade';
          options.push({ label: `${verb} ${name}`, action: () => this.talkToNpc(entityId) });
        } else {
          const lvl = this.npcLevelFor(npcDefId);
          const labelLevel = lvl > 0 ? ` (level-${lvl})` : '';
          options.push({ label: `Attack ${name}${labelLevel}`, action: () => this.attackNpc(entityId) });
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
        // List every ground item sharing this tile, not just the one the
        // cursor happened to land on. NPC loot tables can drop 3+ items per
        // kill (bones + coins + a rare); the picked sprite was hiding the
        // others under it. Newest-first matches the visible stacking order.
        const pickedItem = this.entities.groundItems.get(pickedGroundItemId);
        if (pickedItem) {
          const tx = Math.floor(pickedItem.x);
          const tz = Math.floor(pickedItem.z);
          const stack = [];
          for (const [, gi] of this.entities.groundItems) {
            if (Math.floor(gi.x) === tx && Math.floor(gi.z) === tz) stack.push(gi);
          }
          stack.sort((a, b) => b.id - a.id);
          for (const gi of stack) {
            const iDef = this.itemDefsCache.get(gi.itemId);
            const iName = iDef?.name ?? 'item';
            const qtyLabel = gi.quantity > 1 ? ` (${gi.quantity})` : '';
            const giId = gi.id;
            options.push({
              label: `Pick up ${iName}${qtyLabel}`,
              action: () => this.pickupItem(giId),
            });
          }
        }
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
            const actions = this.actionsForInstance(def, data.depleted);
            for (let i = 0; i < actions.length; i++) {
              const actionName = actions[i];
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
      if (pickedSpriteWorldObjectId != null && pickedObjectEntityId == null) {
        const objectEntityId = pickedSpriteWorldObjectId;
        const data = this.worldObjectDefs.get(objectEntityId);
        if (data) {
          const def = this.objectDefsCache.get(data.defId);
          if (def && (!data.depleted || def.category === 'door')) {
            const actions = this.actionsForInstance(def, data.depleted);
            for (let i = 0; i < actions.length; i++) {
              const actionName = actions[i];
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

    let menu: HTMLDivElement;
    menu = createContextMenu(options.map((opt) => ({
      label: opt.label,
      action: (ev) => {
        // Update the cached click position so the per-action cursor burst
        // (attackNpc, pickupItem, interactObject, etc.) spawns at the menu
        // item the user actually clicked — without this, the burst fires
        // at lastClickX/Y, which only updates on left-clicks on the canvas
        // and is stale (often the previous walk-click) after a right-click
        // context-menu interaction.
        this.lastClickX = ev.clientX;
        this.lastClickY = ev.clientY;
        opt.action();
      },
    })), {
      x,
      y,
      fontSizePx: 13,
      minWidthPx: 120,
      zIndex: 1000,
      onClose: () => {
        if (this.contextMenu === menu) this.contextMenu = null;
      },
    });
    this.contextMenu = menu;
  }

  private hideContextMenu(): void {
    if (this.contextMenu) {
      closeActiveContextMenu(this.contextMenu);
      this.contextMenu = null;
    }
  }

  /** Set of NpcDef IDs that aren't valid attack targets (shopkeepers, smiths,
   *  bankers). Trade option is shown instead. Banker (16) is included here
   *  even though the right-click context still falls through to "Attack" for
   *  it — that's a separate pre-existing bug; for our auto-attack gating we
   *  treat them all as non-combat. */
  private isNonAttackableNpc(npcDefId: number | undefined): boolean {
    return npcDefId === 8 || npcDefId === 11 || npcDefId === 12 || npcDefId === 13 || npcDefId === 14 || npcDefId === 16;
  }

  /** Walk picked-mesh parent chain looking for an NPC tag (set by Npc3DEntity
   *  and CharacterEntity metadata). Returns the entityId or null. */
  private findNpcEntityIdFromPick(pickedMesh: TransformNode, meshName: string): number | null {
    let walk: TransformNode | null = pickedMesh;
    while (walk) {
      if (walk.metadata?.kind === 'npc' && typeof walk.metadata?.entityId === 'number') {
        return walk.metadata.entityId;
      }
      walk = walk.parent as TransformNode | null;
    }
    for (const [entityId, sprite] of this.entities.npcSprites) {
      if (sprite instanceof CharacterEntity) continue;
      if (sprite.getMesh()?.name === meshName) return entityId;
    }
    return null;
  }

  /** Combat level for the local player. Reads skill levels from the side
   *  panel (canonical store) and runs the OSRS-style combat-level formula.
   *  Returns 0 if skills haven't synced yet. */
  private getLocalCombatLevel(): number {
    if (!this.sidePanel) return 0;
    const get = (id: string) => this.sidePanel!.getSkillLevel(id as any);
    const defence = get('defence');
    const hitpoints = get('hitpoints');
    const accuracy = get('accuracy');
    const strength = get('strength');
    const archery = get('archery');
    const goodmagic = get('goodmagic');
    const evilmagic = get('evilmagic');
    const base = 0.25 * (defence + hitpoints);
    const melee = 0.325 * (accuracy + strength);
    const range = 0.325 * (Math.floor(archery / 2) + archery);
    const magicLvl = Math.max(goodmagic, evilmagic);
    const mage = 0.325 * (Math.floor(magicLvl / 2) + magicLvl);
    return Math.floor(base + Math.max(melee, range, mage));
  }

  /** Combat level for an NPC by defId, or 0 if unknown. */
  private npcLevelFor(npcDefId: number | undefined): number {
    if (npcDefId == null) return 0;
    const def = this.npcDefsCache.get(npcDefId);
    if (!def) return 0;
    return npcCombatLevel(def);
  }

  private npcTooltipEl: HTMLDivElement | null = null;
  private setupNpcTooltip(canvas: HTMLCanvasElement): void {
    const el = document.createElement('div');
    el.style.cssText = [
      'position: fixed', 'pointer-events: none', 'z-index: 999',
      'background: #1a1410ee', 'border: 1px solid #5a4a35',
      'color: #d8372b', 'font: 12px Arial, Helvetica, sans-serif',
      'padding: 3px 7px', 'display: none', 'white-space: nowrap',
    ].join('; ');
    document.body.appendChild(el);
    this.npcTooltipEl = el;

    let lastPickAt = 0;
    canvas.addEventListener('pointermove', (e) => {
      // Throttle: scene.pick walks every pickable mesh; running it on every
      // raw pointermove (which can fire 100+ times/sec on a high-Hz mouse)
      // would chew frame budget. 30ms gap = ~33Hz, smooth enough for a
      // tooltip and harmless to skip a few frames in between.
      const now = performance.now();
      if (now - lastPickAt < 30) {
        el.style.left = `${e.clientX + 14}px`;
        el.style.top = `${e.clientY + 14}px`;
        return;
      }
      lastPickAt = now;
      const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY);
      let label: string | null = null;
      if (pick?.hit && pick.pickedMesh) {
        const entityId = this.findNpcEntityIdFromPick(pick.pickedMesh, pick.pickedMesh.name);
        if (entityId != null) {
          const npcDefId = this.entities.npcDefs.get(entityId);
          const name = NPC_NAMES[npcDefId ?? 0] || 'NPC';
          const flags = this.entities.npcInteractions.get(entityId) ?? 0;
          if (flags !== 0 || this.isNonAttackableNpc(npcDefId)) {
            label = name;
          } else {
            const lvl = this.npcLevelFor(npcDefId);
            label = lvl > 0 ? `${name} (level-${lvl})` : name;
          }
        }
      }
      if (label) {
        el.textContent = label;
        el.style.left = `${e.clientX + 14}px`;
        el.style.top = `${e.clientY + 14}px`;
        el.style.display = 'block';
      } else if (el.style.display !== 'none') {
        el.style.display = 'none';
      }
    });
  }

  private attackNpc(npcEntityId: number): void {
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    this.combatTargetId = npcEntityId;
    // Arm the chase-repath cooldown so updateCombatFollow doesn't re-pathfind
    // on the very next frame and re-send a near-identical sendMove(). The
    // 600 ms window matches the throttle elsewhere in updateCombatFollow —
    // one server tick instead of half, halving moveQueue churn during chase.
    this._combatPathTimer = 0.6;

    const target = this.entities.npcTargets.get(npcEntityId);
    if (target) {
      const path = findPath(this.playerX, this.playerZ, target.x, target.z,
        this.isTileBlocked,
        this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
        this.isWallBlockedForPath);
      // The NPC's own tile is blocking — drop it from the path so the player
      // stops on the adjacent tile. Without this, a single-step path (`length
      // === 1`) was sent verbatim with the NPC tile included; server rejects
      // the step onto blocked terrain and the player stands still.
      if (path.length > 0) {
        const last = path[path.length - 1];
        if (Math.floor(last.x) === Math.floor(target.x) && Math.floor(last.z) === Math.floor(target.z)) {
          path.pop();
        }
      }
      if (path.length > 0) {
        this.path = path; this.pathIndex = 0; this.tileProgress = 0; this.tileFrom = { x: this.playerX, z: this.playerZ };
        if (this.destMarker) this.destMarker.isVisible = false;
        this.minimap?.clearDestination();
        // Send the path BEFORE the attack packet so the server walks the same
        // tiles. Otherwise the server's handlePlayerAttackNpc independently
        // recomputes a path from its authoritative position — that path
        // diverges from this local one, the server tick advances on its own
        // queue, and the >1.5-tile divergence guard snaps the local visual
        // to the server position (visible as a teleport).
        this.network.sendMove(path);
      }
    }
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_ATTACK_NPC, npcEntityId));
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
      this.network.sendMove(path);
    }
    // Send talk opcode — server checks distance
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_TALK_NPC, npcEntityId));
  }

  private pickupItem(groundItemId: number): void {
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    const item = this.entities.groundItems.get(groundItemId);
    if (item) {
      const path = findPath(this.playerX, this.playerZ, item.x, item.z,
        this.isTileBlocked,
        this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
        this.isWallBlockedForPath);
      if (path.length > 0) {
        this.path = path; this.pathIndex = 0; this.tileProgress = 0; this.tileFrom = { x: this.playerX, z: this.playerZ };
        if (this.destMarker) this.destMarker.isVisible = false;
        this.minimap?.clearDestination();
        this.network.sendMove(path);
      }
    }
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
      if (this.interactMarker) {
        let mx = data.x;
        let mz = data.z;
        // Doors sit on a wall edge — pull the marker 0.4 tiles toward the
        // player's side of the wall so the disc doesn't z-fight the wall mesh.
        if (def.category === 'door') {
          const doorEntry = this.doorPivots.get(objectEntityId);
          const rotY = doorEntry ? doorEntry.closedRotY : 0;
          const { axis } = doorEdgeFromPlacement(data.x, data.z, rotY);
          if (axis === 'NS') {
            mz += this.playerZ < data.z ? -0.4 : 0.4;
          } else {
            mx += this.playerX < data.x ? -0.4 : 0.4;
          }
        }
        this.interactMarker.position.x = mx;
        this.interactMarker.position.y = this.getHeight(mx, mz) + 0.02;
        this.interactMarker.position.z = mz;
        this.alignMarkerToTerrain(mx, mz, this.interactMarker);
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
      const doorEntry = this.doorPivots.get(objectEntityId);
      const rotY = doorEntry ? doorEntry.closedRotY : 0;
      const { tile: [dotx, dotz], edge } = doorEdgeFromPlacement(data.x, data.z, rotY);
      const ptx = Math.floor(this.playerX);
      const ptz = Math.floor(this.playerZ);
      const alreadyAdj = (ptx === dotx && ptz === dotz) || (Math.abs(ptx - dotx) + Math.abs(ptz - dotz) === 1);

      if (!alreadyAdj) {
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
      this.openCharacterCreatorWhenReady();
      return true;
    }
    return false;
  }

  private openCharacterCreatorWhenReady(): void {
    if (this.characterCreator || this.characterCreatorOpenPending) return;
    if (!this.localPlayer) {
      this.characterCreatorOpenPending = true;
      requestAnimationFrame(() => {
        this.characterCreatorOpenPending = false;
        this.openCharacterCreatorWhenReady();
      });
      return;
    }
    this.characterCreatorOpenPending = true;
    void this.localPlayer.whenReady().then(() => {
      this.characterCreatorOpenPending = false;
      if (!this.characterCreator) this.openCharacterCreator();
    });
  }

  private openCharacterCreator(): void {
    if (this.characterCreator) return;
    // Pass the player's current appearance as the starting state so /appearance
    // re-edits open on the current values rather than the global default.
    // For brand-new characters with no appearance set yet, localAppearance is
    // null and the creator falls back to DEFAULT_APPEARANCE.
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
      ));
      this.localAppearance = appearance;
      if (this.localPlayer) {
        this.localPlayer.applyAppearance(appearance);
      }
      this.characterCreator!.destroy();
      this.characterCreator = null;
    }, {
      initial: this.localAppearance ?? undefined,
      // Pass the local player so the creator hides them while open and spawns
      // the preview character at their world position (so the preview canvas
      // shows them in their actual environment instead of on a flat backdrop).
      localPlayer: this.localPlayer,
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
      color: #fff; font-family: Arial, Helvetica, sans-serif; font-size: 13px; font-weight: bold;
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

    // Clicking your own tile while walking should halt on that tile.
    // findPath returns an empty path when start tile == end tile, which the
    // length-check below silently ignored — so the previous walk kept going.
    // Treat the click as a stop: end the path at the current tile center,
    // tell the server to halt too.
    const clickedOwnTile = tx === Math.floor(this.playerX) && tz === Math.floor(this.playerZ);
    if (clickedOwnTile) {
      this.pendingPath = null;
      this.minimap?.clearDestination();
      if (this.pathIndex < this.path.length) {
        // Mid-step: keep the current target tile so the animation completes
        // the in-progress step and the character lands cleanly on a tile
        // center rather than freezing between two tiles. The natural
        // path-finished branch in updateLocalPlayerMovement (~line 3282)
        // will call stopWalking() when pathIndex catches up.
        const currentTarget = this.path[this.pathIndex];
        this.path = [currentTarget];
        this.pathIndex = 0;
        // Keep tileProgress / tileFrom so interpolation continues seamlessly.
        // Send the same one-tile path to the server so its moveQueue ends
        // on the same tile we're walking to.
        this.network.sendMove([currentTarget]);
      } else {
        // Not walking — just make sure we're idle.
        this.path = [];
        this.pathIndex = 0;
        this.tileProgress = 0;
        this.tileFrom = { x: this.playerX, z: this.playerZ };
        this.localPlayer?.stopWalking();
        this.network.sendMove([]);
      }
      return;
    }

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
    if (this._visibilityHandler) { document.removeEventListener('visibilitychange', this._visibilityHandler); this._visibilityHandler = null; }
    this.engine.stopRenderLoop();
    this.engine.dispose();
    this.chunkManager.disposeAll();
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

    const projectSprite = (sprite: CharacterEntity | Npc3DEntity, skipDistCheck?: boolean) => {
      const hasBubble = sprite.hasChatBubble();
      const hasBar = sprite.hasHealthBar();
      // CharacterEntity is the only type with HTML name labels — Npc3DEntity
      // lacks the methods, so we duck-type via instanceof.
      const labelHost = sprite instanceof CharacterEntity ? sprite : null;
      const hasLabel = labelHost ? labelHost.getLabelWorldPos(this._overlayWorldPos) !== null : false;
      if (!hasBubble && !hasBar && !hasLabel) return;

      if (!skipDistCheck) {
        const pos = sprite.position;
        const dx = pos.x - camPos.x;
        const dy = pos.y - camPos.y;
        const dz = pos.z - camPos.z;
        if (dx * dx + dy * dy + dz * dz > maxDistSq) {
          if (hasBar) sprite.updateHealthBarScreenPos(-9999, -9999);
          if (hasBubble) sprite.updateChatBubbleScreenPos(-9999, -9999);
          if (hasLabel) labelHost!.updateLabelScreenPos(-9999, -9999);
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
      if (hasLabel && labelHost) {
        const wp = labelHost.getLabelWorldPos(this._overlayWorldPos);
        if (wp) projectOverlay(wp, (x, y) => labelHost.updateLabelScreenPos(x, y));
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
    // If a slide is in flight but there's no active path, updateLocalPlayerMovement
    // early-returns without touching the render position — drive the decay
    // ourselves so the visual catches up to the snapped logical position.
    if (this.slideStartMs !== 0 && this.pathIndex >= this.path.length) {
      this.renderLocalPlayerWithSlide();
    }

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
    this._combatPathTimer = 0.6;
    const newPath = findPath(this.playerX, this.playerZ, npcTarget.x, npcTarget.z,
      this.isTileBlocked,
      this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
      this.isWallBlockedForPath);
    // Drop the NPC's own tile (blocking) regardless of path length; a one-step
    // chase repath that lands on the mob's tile would otherwise ship a single
    // blocked tile to the server and stall.
    if (newPath.length > 0) {
      const last = newPath[newPath.length - 1];
      if (Math.floor(last.x) === Math.floor(npcTarget.x) && Math.floor(last.z) === Math.floor(npcTarget.z)) {
        newPath.pop();
      }
    }
    if (newPath.length > 0) {
      this.path = newPath; this.pathIndex = 0;
      this.tileProgress = 0;
      this.tileFrom = { x: this.playerX, z: this.playerZ };
      if (this.destMarker) this.destMarker.isVisible = false;
      this.minimap?.clearDestination();
      // Send the re-path to the server so its moveQueue adopts the same
      // tiles. Without this, the local visual switches to the new path
      // mid-walk while the server keeps walking the previous one — they
      // diverge by a tile within ~1s and the snap guard at line 1229 hauls
      // the visual onto the server position (the "teleport").
      this.network.sendMove(newPath);
      // handlePlayerMove on the server clears the combat target on every
      // PLAYER_MOVE packet (it's the canonical "I want to walk somewhere
      // else" signal). Re-arm combat immediately so the swing fires when
      // we arrive — otherwise the player walks to the mob and just stands
      // there because the server forgot we were attacking.
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_ATTACK_NPC, this.combatTargetId));
    }
  }

  /** Current slide-offset effect on the rendered local-player position.
   *  Linearly decays from the initial offset to (0, 0) over slideDurationMs.
   *  Side effect: zeroes the cached offset once expired so subsequent calls
   *  are a fast early-out. */
  private getSlideOffset(): { x: number; z: number } {
    if (this.slideStartMs === 0) return { x: 0, z: 0 };
    const age = performance.now() - this.slideStartMs;
    if (age >= this.slideDurationMs) {
      this.slideOffsetX = 0;
      this.slideOffsetZ = 0;
      this.slideStartMs = 0;
      return { x: 0, z: 0 };
    }
    const factor = 1 - age / this.slideDurationMs;
    return { x: this.slideOffsetX * factor, z: this.slideOffsetZ * factor };
  }

  /** Wire `document.visibilitychange` so we only treat large server/client
   *  divergence as a hidden-tab catch-up situation. When the tab goes
   *  hidden, Chrome throttles RAF + setInterval to ~1Hz while the server
   *  keeps ticking — local prediction freezes and the server position
   *  marches on. On returning to visible we stay armed for ~2 ticks
   *  (enough for the next PLAYER_SYNC + snap), then disarm so steady-state
   *  play doesn't snap on transient packet jitter. */
  private setupVisibilityHandler(): void {
    const handler = () => {
      if (document.visibilityState === 'hidden') {
        this._hiddenSinceMs = performance.now();
      } else {
        // Stay armed for ~2 ticks after returning to visible — enough for
        // the first PLAYER_SYNC to arrive and the snap logic to make a
        // corrective jump if needed, then disarm so steady-state play
        // doesn't snap.
        setTimeout(() => { this._hiddenSinceMs = 0; }, 1500);
      }
    };
    document.addEventListener('visibilitychange', handler);
    this._visibilityHandler = handler;
  }

  private reconcileLocalPlayerToServer(serverX: number, serverZ: number, hiddenCatchup: boolean): void {
    const sTx = Math.floor(serverX);
    const sTz = Math.floor(serverZ);
    let foundIndex = -1;
    for (let i = 0; i < this.path.length; i++) {
      const wp = this.path[i];
      if (Math.floor(wp.x) === sTx && Math.floor(wp.z) === sTz) {
        foundIndex = i;
        break;
      }
    }

    const prevLogicalX = this.playerX;
    const prevLogicalZ = this.playerZ;
    this.playerX = serverX;
    this.playerZ = serverZ;

    if (foundIndex >= 0) {
      // Server is on our path: skip ahead and keep walking the remainder.
      this.pathIndex = foundIndex + 1;
      this.tileProgress = 0;
      this.tileFrom = { x: serverX, z: serverZ };
      const dragDist = Math.hypot(prevLogicalX - serverX, prevLogicalZ - serverZ);
      const slideMs = Math.min(Math.max(dragDist / 3.0 * 1000, 200), 800);
      this.beginVisualSlide(prevLogicalX, prevLogicalZ, slideMs);
      return;
    }

    // Server is not on the path the client is currently predicting. During
    // visible play, keep the server queue authoritative and slide the local
    // visual onto it. After a hidden-tab return, preserve the older hard reset
    // behavior so stale background movement is cancelled instead of resumed.
    this.path = [];
    this.pathIndex = 0;
    this.tileProgress = 0;
    this.pendingPath = null;
    this.tileFrom = { x: serverX, z: serverZ };
    if (this.destMarker) this.destMarker.isVisible = false;
    this.minimap?.clearDestination();

    if (hiddenCatchup) {
      this.slideOffsetX = 0;
      this.slideOffsetZ = 0;
      this.slideStartMs = 0;
      if (this.localPlayer) {
        this.localPlayer.setPositionXYZ(serverX, this.getHeightAt(serverX, serverZ, this.localPlayer.position.y), serverZ);
        this.localPlayer.stopWalking();
      }
      this.network.sendMove([]);
    } else {
      const dragDist = Math.hypot(prevLogicalX - serverX, prevLogicalZ - serverZ);
      const slideMs = Math.min(Math.max(dragDist / 3.0 * 1000, 200), 800);
      this.beginVisualSlide(prevLogicalX, prevLogicalZ, slideMs);
      this.localPlayer?.stopWalking();
    }
  }

  /** Begin a smooth-slide visual catch-up. The logical playerX/Z should
   *  already be updated to the new (server) position by the caller. The
   *  rendered position will start at the OLD visual location and glide to
   *  the new logical position over durationMs. Stacking is safe: if another
   *  slide is in flight, the rendered position is held still and a fresh
   *  decay starts from there — never a visual hiccup, even on rapid snaps. */
  private beginVisualSlide(prevLogicalX: number, prevLogicalZ: number, durationMs: number = GameManager.SLIDE_DURATION_MS): void {
    const cur = this.getSlideOffset();
    const oldRenderedX = prevLogicalX + cur.x;
    const oldRenderedZ = prevLogicalZ + cur.z;
    this.slideOffsetX = oldRenderedX - this.playerX;
    this.slideOffsetZ = oldRenderedZ - this.playerZ;
    this.slideStartMs = performance.now();
    this.slideDurationMs = durationMs;
  }

  /** Apply the current slide offset to the local player's rendered position.
   *  Called every frame so the offset visibly decays even when the path is
   *  empty (e.g., snapped while standing still). When no slide is active
   *  this is a cheap pass-through — same coords the path code would set. */
  private renderLocalPlayerWithSlide(): void {
    if (!this.localPlayer) return;
    const off = this.getSlideOffset();
    const vx = this.playerX + off.x;
    const vz = this.playerZ + off.z;
    const vy = this.getHeight(vx, vz);
    this.localPlayer.setPositionXYZ(vx, vy, vz);
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
    // Chebyshev (max-of-axes), not Euclidean: server processes one unit-tile
    // per tick regardless of direction, so a diagonal step takes the same
    // 600 ms as a cardinal step. Using Euclidean distance here would slow
    // diagonals to ~0.85 sec/tile, drifting the local visual behind server
    // position — which is what mogn would see for testchar2 over time.
    const tileSteps = Math.max(Math.abs(dx), Math.abs(dz));

    // RS2-style catch-up scaffolding: when the path queue exceeds the
    // default cadence, accelerate to drain it. Authentic ratios (1.5×, 2×)
    // require swapping to a run animation at the higher speeds — the body
    // moves faster, the legs cycle faster. Re-enable once run is wired up.
    const remaining = this.path.length - this.pathIndex;
    const speedMult = remaining > 3 ? 1.0 : remaining > 2 ? 1.0 : 1.0;
    const effectiveSpeed = this.moveSpeed * speedMult;

    const stepRate = tileSteps > 0 ? (effectiveSpeed * dt) / tileSteps : 1;
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

    // Apply the visual slide offset (zero when no slide is active, so this
    // is a no-op on normal walking frames). InputManager.playerY uses the
    // logical height — interaction picks should resolve at the gameplay
    // position, not the briefly-offset visual one.
    this.renderLocalPlayerWithSlide();
    this.inputManager.setPlayerY(this.getHeight(this.playerX, this.playerZ));
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

  /** Y rotation of a placed model in radians, accounting for quaternion form. */
  private modelRotY(model: TransformNode): number {
    if (model.rotationQuaternion) {
      const q = model.rotationQuaternion;
      return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
    }
    return model.rotation.y;
  }

  /** Per-instance action labels — doors flip Open ⇄ Close based on depleted
   *  state, everything else uses the def's static actions. Mirrors
   *  WorldObject.currentActions on the server so right-click labels stay
   *  truthful as the door toggles. */
  private actionsForInstance(def: WorldObjectDef, depleted: boolean): readonly string[] {
    if (def.category === 'door') {
      return depleted ? DOOR_ACTIONS_OPEN_CLIENT : DOOR_ACTIONS_CLOSED_CLIENT;
    }
    return def.actions;
  }

  private setupDoorPivot(objectEntityId: number): void {
    const model = this.worldObjectModels.get(objectEntityId);
    if (!model || this.doorPivots.has(objectEntityId)) return;

    model.computeWorldMatrix(true);

    const closedRotY = this.modelRotY(model);

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

    // Use the model's authored Y as-is — upper-floor doors live at y≈3, and
    // any blanket "snap to terrain" call would bury them at ground level.
    // Chunk objects only spawn after the chunk's heights are loaded, so
    // ground-floor doors are also at the right Y here.
    const data = this.worldObjectDefs.get(objectEntityId);

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
    const camAlpha = this.camera.getCamera().alpha;
    this.minimap.update(
      this.playerX, this.playerZ,
      this._minimapRemotes, this._minimapNpcs,
      this.chunkManager,
      camAlpha,
      this._minimapObjects,
    );
  }
}
