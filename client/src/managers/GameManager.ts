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
import { SpellEffectPlayer } from '../rendering/SpellEffectPlayer';
import type { Targetable } from '../rendering/Targetable';
import { WorldObjectModels } from '../rendering/WorldObjectModels';
import { EntityManager, type GroundItemData } from './EntityManager';
import { InputManager } from './InputManager';
import { NetworkManager } from './NetworkManager';
import { findPath } from '../rendering/Pathfinding';
import { SidePanel } from '../ui/SidePanel';
import { ChatPanel } from '../ui/ChatPanel';
import { GearDebugPanel } from '../ui/GearDebugPanel';
import { BoneDebugPanel } from '../ui/BoneDebugPanel';
import { Minimap } from '../ui/Minimap';
// StatsPanel removed — HP now shown in side panel
import { ShopPanel, type ShopItem } from '../ui/ShopPanel';
import { DialoguePanel, type DialogueNodePayload } from '../ui/DialoguePanel';
import { BankPanel } from '../ui/BankPanel';
import { TradePanel } from '../ui/TradePanel';
import { CharacterCreator } from '../ui/CharacterCreator';
import { SmithingPanel } from '../ui/SmithingPanel';
import { SpellbookPanel } from '../ui/SpellbookPanel';
import { closeActiveContextMenu, createContextMenu } from '../ui/popupStyle';
import { NPC_NAMES } from '../data/NpcConfig';
import { EQUIP_SLOT_BONES, EQUIP_SLOT_NAMES, TOOL_TIER_METAL_COLOR, type GearOverride } from '../data/EquipmentConfig';
import { ServerOpcode, ClientOpcode, PlayerAnimationKind, PlayerSkillAnimationVariant, encodePacket, ALL_SKILLS, SKILL_NAMES, ASSET_TO_OBJECT_DEF, WallEdge, doorEdgeFromPlacement, doorClosedEdgeFromRotY, DOOR_EDGE_NEIGHBOR, decodeStringPacket, BIOME_CELL_SIZE, appearanceEquals, isValidAppearance, PROTOCOL_VERSION, npcCombatLevel, CHARACTER_MODEL_PATH, CHARACTER_TARGET_HEIGHT, PLAYER_ANIMATIONS, getObjectFootprintTiles, getObjectInteractionTiles, isTileAdjacentToObject, QUEST_STAGE_COMPLETED, type WorldObjectDef, type ItemDef, type NpcDef, type InventorySlot, type PlayerAppearance, type BiomesFile, type BiomeDef, type QuestDef, type SpellEffectDef } from '@projectrs/shared';

// Door action labels — mirror server WorldObject.currentActions so right-click
// menu labels reflect the door's current state. Both ends pass actionIndex 0
// for the toggle, so the mismatch was previously a UX bug only.
const DOOR_ACTIONS_CLOSED_CLIENT: readonly string[] = ['Open', 'Examine'];
const DOOR_ACTIONS_OPEN_CLIENT: readonly string[] = ['Close', 'Examine'];
const MAX_FRAME_DT_SECONDS = 0.1;

type InteractionOption = {
  label: string;
  action: () => void;
};

type LoadingProgressCallback = (pct: number, status: string) => void;

export class GameManager {
  private engine: Engine;
  private scene: Scene;
  private camera: GameCamera;
  private chunkManager: ChunkManager;
  private inputManager: InputManager;
  private network: NetworkManager;
  private readonly onFatalDisconnect?: () => void;
  private destroyed: boolean = false;

  private connectionFrozen: boolean = false;
  private reconnecting: boolean = false;
  private reconnectOverlay: HTMLDivElement | null = null;
  private reconnectStartedAt: number = 0;
  private reconnectAttempt: number = 0;
  private reconnectSleepTimer: number | null = null;
  private static readonly RECONNECT_MAX_MS = 22_000;
  private static readonly RECONNECT_DELAY_MS = 1_600;
  private static readonly RECONNECT_LOGIN_TIMEOUT_MS = 4_500;

  // Auth
  private token: string;
  private username: string;

  // Resize handling — CSS grid reflows (eg. DevTools open/close) don't always fire window.resize
  private resizeObserver: ResizeObserver | null = null;
  private onWindowResize: (() => void) | null = null;

  // Local player
  private localPlayer: CharacterEntity | null = null;
  private localPlayerId: number = -1;
  /** Settles when WorldObjectModels finishes its initial bulk load. */
  private _objectModelsReady: Promise<void> = Promise.resolve();
  /** Settles when objectDefs / itemDefs / npcDefs / etc. finish loading. We
   *  gate MAP_READY on this so the server never pushes WORLD_OBJECT_SYNC
   *  before the client can recognize door-vs-non-door entities — without
   *  defs, linkPlacedNodeToEntity falls into the non-door branch and
   *  doors get stuck at their authored closed pose with no pivot. */
  private _defsReady: Promise<void> = Promise.resolve();
  /** Resolves once the post-auth world is genuinely playable: LOGIN_OK has
   *  placed the player, the initial MAP_CHANGE has settled, saved-spawn
   *  chunks are loaded, and the server bootstrap inventory/skills/equipment
   *  packets have been applied. */
  private _loginOkResolver: (() => void) | null = null;
  private _loginProgress: LoadingProgressCallback | null = null;
  private _loginMapReady: Promise<void> = Promise.resolve();
  private _resolveLoginMapReady: (() => void) | null = null;
  private _loginBootstrapPending: Set<'skills' | 'inventory' | 'equipment'> | null = null;
  private _pendingLoginGearLoads: Promise<void>[] = [];
  private _loginReadySeq: number = 0;
  private _loginSettled: boolean = true;
  private _initialMapReadySent: boolean = false;
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
  private pendingSkill: { objectId: number; variant?: string; stationary?: boolean } | null = null; // deferred skilling until walk finishes
  private pendingSmithing: { objectEntityId: number; def: WorldObjectDef } | null = null; // open smithing panel once walk to anvil finishes
  private pendingObjectInteraction: { objectEntityId: number; actionIndex: number; seq: number } | null = null;
  private pendingObjectInteractionSeq: number = 0;
  private pendingObjectInteractionTimer: number | null = null;
  /** NPC entityId to face when the current path completes. 2004scape
   *  Player.faceEntity equivalent — set by talkToNpc/attackNpc, cleared
   *  on arrival or any new ground click. */
  private pendingFaceTargetEntityId: number = -1;
  /** Talk-to deferred while mid-tile. Re-pathing from a fractional
   *  playerX/Z would desync from the server's tile-aligned position. */
  private pendingTalkEntityId: number = -1;
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
  private static readonly MINIMAP_UPDATE_INTERVAL_MS = 50;
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
  private _lastMinimapUpdateMs: number = 0;
  // NOTE: do NOT reuse a single Vector3 for entity positions — the setter stores the reference
  private _overlayVp = new Viewport(0, 0, 1, 1);
  private _overlayTransform = Matrix.Identity();
  private _overlayTransformReady = false;
  private _overlayWorldPos = new Vector3();
  private _overlayScreenPos = new Vector3();

  // Local player equipment tracking (slot index → item ID)
  private localEquipment: Map<number, number> = new Map();
  private remoteAnimationStates: Map<number, { kind: PlayerAnimationKind; variant: PlayerSkillAnimationVariant; targetId: number; toolItemId: number }> = new Map();

  // Set of entityIds currently holding a server-broadcast skilling tool in
  // place of their real weapon. Restored via localEquipment / remoteEquipment
  // (authoritative source) when the skill animation ends — reading from
  // those maps avoids a race where getGearItemId() returns -1 during the
  // async gear-attach window and we'd "restore" the player to unarmed.
  private toolSwappedEntities: Set<number> = new Set();

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
  private autoCastSpellIndex: number = -1;
  private pendingSingleCastSpell: number = -1;
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
  /** Shared geometry for crop pick proxies — cloned per crop so the ~hundreds
   *  of rice plants share a single VBO. */
  private cropProxyTemplate: Mesh | null = null;
  private doorPivots: Map<number, { pivot: TransformNode; targetAngle: number; currentAngle: number; closedRotY: number }> = new Map();
  private doorTiles: Map<number, [number, number]> = new Map();
  /** Tiles blocked by non-depleted world objects (key = `${tileX},${tileZ}`) */
  private blockedObjectTiles: Set<string> = new Set();
  private objectDefsCache: Map<number, WorldObjectDef> = new Map();
  private itemDefsCache: Map<number, ItemDef> = new Map();
  private npcDefsCache: Map<number, NpcDef> = new Map();
  private questDefsCache: Map<string, QuestDef> = new Map();
  /** Per-player quest state, populated on QUEST_STATE_SYNC at login and
   *  patched per QUEST_STAGE_ADVANCED delta. Mirrored into SidePanel's
   *  Quest Journal tab for rendering, and drives per-stage chat notifications. */
  private questState: Record<string, { stage: number; triggerProgress: number }> = {};
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
  private shopPanel: ShopPanel | null = null;
  private dialoguePanel: DialoguePanel | null = null;
  private smithingPanel: SmithingPanel | null = null;
  private bankPanel: BankPanel | null = null;
  private tradePanel: TradePanel | null = null;

  // Spell effect runtime. Catalogue is lazy-loaded from /api/spells on first /spell command.
  // spellsByIndex mirrors the server's alphabetical order so binary protocol
  // indices line up — DataLoader sorts by id at boot, /api/spells returns that
  // exact list, and we never reorder client-side.
  private spellEffectPlayer: SpellEffectPlayer | null = null;
  private spellsById: Map<string, SpellEffectDef> | null = null;
  private spellsByIndex: SpellEffectDef[] = [];
  private spellbookPanel: SpellbookPanel | null = null;
  private castingUntil = 0;

  // Combat hit splats (HTML overlay)
  private hitSplats: { worldPos: Vector3; el: HTMLDivElement; timer: number; startY: number }[] = [];

  // WASD camera
  private keysDown: Set<string> = new Set();

  constructor(
    canvas: HTMLCanvasElement,
    token: string,
    username: string,
    onDisconnect?: () => void,
  ) {
    (window as any).gm = this;
    this.onFatalDisconnect = onDisconnect;
    this.gearOverridesReady = new Promise<void>((resolve) => { this.resolveGearOverridesReady = resolve; });
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

    // Disable unused Babylon subsystems to skip per-frame checks.
    // particlesEnabled stays on — SpellEffectPlayer uses them for cast/trail/impact effects.
    this.scene.lensFlaresEnabled = false;
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

      if (!this.inputManager.isEnabled() || e.shiftKey) return;
      const options = this.getWorldInteractionOptionsAt(e.clientX, e.clientY);
      if (options.length > 0) {
        this.runInteractionOption(options[0], e.clientX, e.clientY);
        // Suppress InputManager's object/ground handling for this event. The
        // first context option is the whole action, including its own walk-to
        // prediction when needed.
        e.stopImmediatePropagation();
        e.preventDefault();
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
    this.network.onDisconnect((event) => this.handleConnectionLost(event));
    if (token) {
      this.network.connect(token);
    }

    // HUD
    this.createHUD();
    this.sidePanel = new SidePanel(this.network, this.token);
    this.sidePanel.setSpellCastCallback((spellIndex) => this.sidePanel!.setTargetingSpell(spellIndex));
    // Eager-load the spell catalogue so the spellbook tabs render locked
    // icons (and the question marks) immediately — without this, the tabs
    // stay empty until the player happens to fire /spell or /cast.
    void this.ensureSpellsLoaded().then(() => this.sidePanel?.setSpellCatalogue(this.spellsByIndex));
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
    // Quest journal is rendered inside SidePanel's existing Quests tab.
    // Push whatever defs already loaded; subsequent loads (and state deltas)
    // push from the raw-message dispatcher below.
    if (this.questDefsCache.size > 0) this.sidePanel?.setQuestDefs(this.questDefsCache);
    this.sidePanel?.setQuestState(this.questState);
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

    // Load the default map during pre-auth as a hidden warm start. This does
    // not send MAP_READY: the server's authoritative placement arrives after
    // LOGIN_OK via MAP_CHANGE, and only that final placement should trigger
    // entity bootstrap packets.
    this.chunkManager.loadMap('kcmap').then(async () => {
      await this.loadBiomes('kcmap');
      this.applyFog();
      await this._defsReady;
      this.repositionWorldObjects();
    });
    this._defsReady = this.loadObjectDefs();
    this.objectModels = new WorldObjectModels(this.scene, (x, z) => this.getHeight(x, z), this.objectDefsCache);
    this._objectModelsReady = this.objectModels.loadAll();
    this.entities = new EntityManager(this.scene, (x, z, cy) => this.getHeightAt(x, z, cy), this.itemDefsCache);
    // Dev-only console hook for triage (NPC name overrides, entity sprites).
    // Tree-shaken Babylon imports remove the global namespace, so without
    // this the only way to inspect runtime entity state is to hack imports.
    if (import.meta.env.DEV) (window as any)._gameEntities = this.entities;

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
      const dt = Math.min((now - lastTime) / 1000, MAX_FRAME_DT_SECONDS);
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

  private noteLoginBootstrapPacket(kind: 'skills' | 'inventory' | 'equipment'): void {
    const pending = this._loginBootstrapPending;
    if (!pending) return;
    pending.delete(kind);
    const done = 3 - pending.size;
    this._loginProgress?.(0.82 + done * 0.04, `Loading character state (${done}/3)`);
    if (pending.size === 0) void this.tryResolveLoginReady(this._loginReadySeq);
  }

  private async waitForLoginBootstrapPackets(seq: number, timeoutMs: number = 5000): Promise<void> {
    const start = performance.now();
    while (this._loginBootstrapPending && this._loginBootstrapPending.size > 0) {
      if (seq !== this._loginReadySeq || this.destroyed) return;
      if (performance.now() - start > timeoutMs) {
        console.warn(`[loading] Timed out waiting for bootstrap packets: ${Array.from(this._loginBootstrapPending).join(', ')}`);
        return;
      }
      await new Promise(r => setTimeout(r, 50));
    }
  }

  private async tryResolveLoginReady(seq: number): Promise<void> {
    if (this._loginSettled || seq !== this._loginReadySeq || !this._loginOkResolver) return;
    this._loginProgress?.(0.6, 'Loading world');
    await this._loginMapReady;
    if (this._loginSettled || seq !== this._loginReadySeq || !this._loginOkResolver) return;

    this._loginProgress?.(0.72, 'Loading character');
    if (this.localPlayer) await this.localPlayer.whenReady();
    if (this.localAppearance && this.localPlayer) this.localPlayer.applyAppearance(this.localAppearance);

    this._loginProgress?.(0.78, 'Loading saved location');
    await this.chunkManager.whenSpawnChunksReady(this.playerX, this.playerZ);
    if (this.localPlayer) {
      const groundY = this.getHeight(this.playerX, this.playerZ);
      this.localPlayer.setPositionXYZ(this.playerX, groundY, this.playerZ);
      this.inputManager.setPlayerY(groundY);
    }

    this._loginProgress?.(0.86, 'Loading character state');
    await this.waitForLoginBootstrapPackets(seq);
    if (this._loginSettled || seq !== this._loginReadySeq || !this._loginOkResolver) return;

    if (this._pendingLoginGearLoads.length > 0) {
      this._loginProgress?.(0.94, 'Loading equipped gear');
      const gearLoads = this._pendingLoginGearLoads.splice(0);
      await Promise.allSettled(gearLoads);
    }
    if (this._loginSettled || seq !== this._loginReadySeq || !this._loginOkResolver) return;
    if (this.localAppearance && this.localPlayer) this.localPlayer.applyAppearance(this.localAppearance);

    // Let Babylon commit any meshes/materials applied by packet handlers
    // before the canvas is revealed.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (this._loginSettled || seq !== this._loginReadySeq || !this._loginOkResolver) return;

    this._loginProgress?.(1, 'Entering world');
    this.inputManager.setEnabled(true);
    this._loginSettled = true;
    this._loginBootstrapPending = null;
    const resolver = this._loginOkResolver;
    this._loginOkResolver = null;
    this._loginProgress = null;
    resolver();
  }

  private appearanceStorageKey(username: string = this.username): string {
    return `projectrs_appearance_${username.toLowerCase()}`;
  }

  private cacheLocalAppearance(appearance: PlayerAppearance): void {
    this.localAppearance = appearance;
    try {
      localStorage.setItem(this.appearanceStorageKey(), JSON.stringify(appearance));
    } catch { /* storage unavailable */ }
  }

  private loadCachedAppearance(username: string = this.username): PlayerAppearance | null {
    try {
      const raw = localStorage.getItem(this.appearanceStorageKey(username));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PlayerAppearance;
      return isValidAppearance(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private resendCachedAppearance(): boolean {
    const appearance = this.localAppearance ?? this.loadCachedAppearance();
    if (!appearance) return false;
    this.cacheLocalAppearance(appearance);
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
    if (this.localPlayer) this.localPlayer.applyAppearance(appearance);
    return true;
  }

  /** Open the WebSocket and wait for the first LOGIN_OK to finish processing
   *  (real spawn position applied, saved appearance applied, input enabled).
   *  Use this after `whenPreloaded()` for a clean "click Login → world is
   *  immediately playable" handoff. */
  connectAndAuth(token: string, username: string, onProgress?: LoadingProgressCallback): Promise<void> {
    this.token = token;
    this.username = username;
    this.localAppearance = this.loadCachedAppearance(username);
    return new Promise<void>((resolve) => {
      this._loginOkResolver = resolve;
      this._loginProgress = onProgress ?? null;
      this._loginBootstrapPending = new Set(['skills', 'inventory', 'equipment']);
      this._pendingLoginGearLoads = [];
      this._loginMapReady = new Promise<void>((mapResolve) => { this._resolveLoginMapReady = mapResolve; });
      this._loginSettled = false;
      this._initialMapReadySent = false;
      this._loginReadySeq++;
      onProgress?.(0.02, 'Connecting to server');
      this.network.connect(token);
    });
  }

  private handleConnectionLost(event: CloseEvent): void {
    if (this.destroyed || this.reconnecting) return;
    console.warn(`[net] Connection lost (code=${event.code}, clean=${event.wasClean})`);
    void this.reconnectOrLogout();
  }

  private setConnectionFrozen(frozen: boolean): void {
    this.connectionFrozen = frozen;
    this.inputManager.setEnabled(!frozen);
    if (frozen) {
      closeActiveContextMenu();
      this.hideContextMenu();
      this.clearPredictedPath();
      this.pendingSkill = null;
      this.pendingSmithing = null;
      this.combatTargetId = -1; this.autoCastSpellIndex = -1; this.pendingSingleCastSpell = -1;
      this.isSkilling = false;
      this.skillingObjectId = -1;
      this.localPlayer?.stopWalking();
      this.localPlayer?.stopSkillAnimation();
      this.minimap?.clearDestination();
    }
  }

  private showReconnectOverlay(status: string): void {
    if (!this.reconnectOverlay) {
      const overlay = document.createElement('div');
      overlay.id = 'connection-lost-overlay';
      overlay.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:10000',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'background:rgba(0,0,0,0.42)',
        'pointer-events:auto',
        'font-family:Arial, Helvetica, sans-serif',
      ].join(';');
      overlay.innerHTML = `
        <div style="
          min-width:260px;
          max-width:min(420px, calc(100vw - 32px));
          border:2px solid #2a1b12;
          outline:1px solid #7a3d24;
          background:#140d0a;
          box-shadow:0 8px 24px rgba(0,0,0,0.75), inset 0 0 0 1px rgba(255,210,120,0.12);
          padding:18px 22px;
          text-align:center;
          color:#cfc2a1;
        ">
          <div style="font-size:20px;font-weight:700;color:#b3261e;text-shadow:1px 1px 0 #000;margin-bottom:8px;">Connection lost</div>
          <div data-status style="font-size:14px;line-height:1.4;color:#d7caa9;"></div>
        </div>
      `;
      document.body.appendChild(overlay);
      this.reconnectOverlay = overlay;
    }
    const statusEl = this.reconnectOverlay.querySelector<HTMLElement>('[data-status]');
    if (statusEl) statusEl.textContent = status;
  }

  private hideReconnectOverlay(): void {
    this.reconnectOverlay?.remove();
    this.reconnectOverlay = null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.reconnectSleepTimer = window.setTimeout(() => {
        this.reconnectSleepTimer = null;
        resolve();
      }, ms);
    });
  }

  private reconnectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let onLoginOk: () => void = () => {};
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        if (this._loginOkResolver === onLoginOk) this._loginOkResolver = null;
        reject(new Error('Timed out waiting for login confirmation'));
      }, GameManager.RECONNECT_LOGIN_TIMEOUT_MS);

      onLoginOk = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve();
      };

      this._loginOkResolver = onLoginOk;
      this._loginProgress = null;
      this._loginBootstrapPending = new Set(['skills', 'inventory', 'equipment']);
      this._pendingLoginGearLoads = [];
      this._loginMapReady = new Promise<void>((mapResolve) => { this._resolveLoginMapReady = mapResolve; });
      this._loginSettled = false;
      this._initialMapReadySent = false;
      this._loginReadySeq++;
      this.network.connect(this.token);
    });
  }

  private async reconnectOrLogout(): Promise<void> {
    if (this.reconnecting || this.destroyed) return;
    this.reconnecting = true;
    this.reconnectStartedAt = performance.now();
    this.reconnectAttempt = 0;
    this.setConnectionFrozen(true);

    const token = this.token || localStorage.getItem('projectrs_token') || '';
    if (!token) {
      this.finishReconnectFailure();
      return;
    }
    this.token = token;

    while (!this.destroyed && performance.now() - this.reconnectStartedAt < GameManager.RECONNECT_MAX_MS) {
      this.reconnectAttempt++;
      this.showReconnectOverlay(`Reconnecting... attempt ${this.reconnectAttempt}`);
      try {
        await this.reconnectOnce();
        if (this.destroyed) return;
        this.reconnecting = false;
        this.setConnectionFrozen(false);
        this.hideReconnectOverlay();
        this.chatPanel?.addSystemMessage('Reconnected.', '#b3261e');
        return;
      } catch (err) {
        if (this.destroyed) return;
        console.warn('[net] Reconnect attempt failed', err);
        this.showReconnectOverlay('Still trying to reconnect...');
        await this.sleep(GameManager.RECONNECT_DELAY_MS);
      }
    }

    this.finishReconnectFailure();
  }

  private finishReconnectFailure(): void {
    if (this.destroyed) return;
    this.reconnecting = false;
    this.setConnectionFrozen(false);
    this.hideReconnectOverlay();
    this.network.close();
    this.onFatalDisconnect?.();
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
    const [objectsRes, itemsRes, npcsRes, gearRes, questsRes] = await Promise.all([
      fetch('/data/objects.json').catch((e) => { console.warn('Failed to load object definitions:', e); return null; }),
      fetch('/data/items.json').catch((e) => { console.warn('Failed to load item definitions:', e); return null; }),
      fetch('/data/npcs.json').catch((e) => { console.warn('Failed to load NPC definitions:', e); return null; }),
      fetch('/data/gear-overrides.json').catch((e) => { console.warn('Failed to load gear overrides:', e); return null; }),
      fetch('/data/quests.json').catch(() => null),
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
    if (questsRes) {
      try {
        const defs: QuestDef[] = await questsRes.json();
        for (const def of defs) this.questDefsCache.set(def.id, def);
        this.sidePanel?.setQuestDefs(this.questDefsCache);
      } catch (e) {
        console.warn('Failed to parse quest definitions:', e);
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

  /** Rebuild blockedObjectTiles from all known world objects. Depleted
   *  ores/stumps stay blocking — they're still physically present at the
   *  tile and walking through one looks broken. Matches the server's
   *  blockedObjectTiles policy. */
  private rebuildBlockedObjectTiles(): void {
    this.blockedObjectTiles.clear();
    for (const [, data] of this.worldObjectDefs) {
      const def = this.objectDefsCache.get(data.defId);
      // Depleted ores/stumps stay blocking — they still physically occupy
      // the tile. setObjectTilesBlocked is a no-op for doors.
      if (def?.blocking) {
        this.setObjectTilesBlocked(data.x, data.z, def, true);
      }
    }
  }

  private setObjectTilesBlocked(x: number, z: number, def: WorldObjectDef, blocked: boolean): void {
    if (!def.blocking || def.category === 'door') return;
    for (const tile of getObjectFootprintTiles(x, z, def)) {
      const key = `${tile.x},${tile.z}`;
      if (blocked) this.blockedObjectTiles.add(key);
      else this.blockedObjectTiles.delete(key);
    }
  }

  // Fraction (0–1) of the attack animation duration where the hit visually lands.
  // Tune per anim by watching the GLB and noting when the weapon reaches its
  // forward extreme. Auto-scales with anim duration on re-export.
  private static readonly ATTACK_IMPACT_FRACTION: Record<string, number> = {
    attack_slash:            0.5,
    attack_1h_slash:         0.5,
    attack_2h_slash:         0.5,
    attack_2h_smash:         0.5,
    attack_punch:            0.4,
    kick:                    0.5,
    stab:                    0.5,
    bow_attack:              0.6,
  };

  /**
   * Choose the correct attack animation name based on stance and weapon.
   * - Scimitar (any stance)        → 'attack_1h_slash'
   * - Sword + aggressive           → 'attack_1h_slash'
   * - Sword + other stance         → 'stab'
   * - Dagger (any stance)          → 'stab'
   * - Other 1H weapon              → 'attack_slash'
   * - Other 2H + aggressive        → 'attack_2h_smash'
   * - Other 2H + other stance      → 'attack_2h_slash'
   * - No weapon + aggressive       → 'kick'
   * - No weapon + other stance     → 'attack_punch'
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
      const name = weaponDef?.name ?? '';
      // Scimitars always swing the 1H slash. Swords default to stab but
      // commit to a full 1H slash on aggressive stance. Daggers stay on stab
      // regardless of stance — short blade, fast jab fits all styles.
      if (/scimitar/i.test(name)) return 'attack_1h_slash';
      if (/sword/i.test(name)) return stance === 'aggressive' ? 'attack_1h_slash' : 'stab';
      if (/dagger/i.test(name)) return 'stab';
      if (weaponDef?.twoHanded) return stance === 'aggressive' ? 'attack_2h_smash' : 'attack_2h_slash';
      return 'attack_slash';
    }
    if (stance === 'aggressive') return 'kick';
    return 'attack_punch';
  }

  private applyRemotePlayerAnimation(
    entityId: number,
    kind: PlayerAnimationKind,
    variant: PlayerSkillAnimationVariant,
    targetId: number,
    toolItemId: number = 0,
  ): void {
    const remote = this.entities.remotePlayers.get(entityId);
    if (!remote || !remote.isReady) return;

    if (kind === PlayerAnimationKind.Idle) {
      remote.stopSkillAnimation();
      this.entities.remoteCombatTargets.delete(entityId);
      this.restoreSkillingTool(entityId, remote);
      // Idle + targetId is the "face this object without animating" primitive,
      // used for crops which pick instantly with no skill cycle.
      if (targetId > 0) {
        const objectData = this.worldObjectDefs.get(targetId);
        if (objectData) remote.faceTowardXZ(objectData.x, objectData.z);
      }
      return;
    }

    if (kind === PlayerAnimationKind.Skill) {
      const objectData = this.worldObjectDefs.get(targetId);
      if (objectData) {
        remote.faceToward(new Vector3(objectData.x, 0, objectData.z));
      }
      // Magic is a one-shot cast (single-tick obelisk offering); other skill
      // variants loop until the server sends Idle.
      if (variant === PlayerSkillAnimationVariant.Magic) {
        remote.playNamedOneShot('spell_cast_2h');
        return;
      }
      const anim =
        variant === PlayerSkillAnimationVariant.Chop ? 'chop' :
        variant === PlayerSkillAnimationVariant.Mine ? 'mine' :
        undefined;
      remote.startSkillAnimation(anim);
      if (toolItemId > 0) this.applySkillingTool(entityId, remote, toolItemId);
      return;
    }

    if (kind === PlayerAnimationKind.Attack) {
      remote.playAttackAnimation(this.getPlayerAttackAnimName(entityId));
      if (targetId > 0) {
        this.entities.remoteCombatTargets.set(entityId, targetId);
        const target = this.entities.npcSprites.get(targetId) ?? this.entities.remotePlayers.get(targetId);
        if (target) remote.faceToward(target.position);
      }
    }
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

    const def = this.objectDefsCache.get(data.defId);
    this.setWorldObjectPickTarget(objectEntityId, this.isWorldObjectInteractable(def, data.depleted), placedNode);
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
        const depleted = this.objectModels.createDepletedModel(objectEntityId, data.defId, placedNode);
        if (depleted) this.setWorldObjectPickTarget(objectEntityId, false, depleted);
      }
    }

    // Crops have tiny meshes (~0.6 tile) — give them a roomier invisible click
    // proxy. Cloned from a shared template so N rice plants share one VBO.
    if (def?.category === 'crop') {
      if (!this.cropProxyTemplate) {
        const tmpl = MeshBuilder.CreateBox('crop_pickProxy_tmpl', {
          width: 1.2, depth: 1.2, height: 1.2,
        }, this.scene);
        tmpl.isVisible = false;
        tmpl.isPickable = false;
        tmpl.setEnabled(false);
        this.cropProxyTemplate = tmpl;
      }
      const proxy = this.cropProxyTemplate.clone(`crop_pickProxy_${objectEntityId}`, placedNode)!;
      proxy.setEnabled(true);
      proxy.position.y = 0.6;
      proxy.isVisible = true;
      proxy.visibility = 0;
      proxy.isPickable = true;
      proxy.layerMask = 0;
      proxy.doNotSyncBoundingInfo = true;
      proxy.freezeWorldMatrix();
      proxy.metadata = { objectEntityId };
      this.setWorldObjectPickTarget(objectEntityId, this.isWorldObjectInteractable(def, data.depleted), proxy);
    }
  }

  /** Create a depleted model (stump/depleted rock) at the placed node's position */
  private setupKeyboard(): void {
    window.addEventListener('keydown', (e) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape' && this.sidePanel?.getUsing()) {
        this.sidePanel.clearUsingInvItem();
        e.preventDefault();
        return;
      }
      if (e.key === 'Escape' && (this.sidePanel?.getTargetingSpell() ?? -1) >= 0) {
        this.sidePanel!.clearTargetingSpell();
        e.preventDefault();
        return;
      }
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

  /** Swap the weapon slot to the server-picked skilling tool. Passes
   *  isLocal=false so the gear-template cache is reused across repeated
   *  chops instead of reloading the GLB on each swap. */
  private applySkillingTool(
    entityId: number,
    character: CharacterEntity,
    toolItemId: number,
  ): void {
    if (toolItemId <= 0 || this.toolSwappedEntities.has(entityId)) return;
    if (character.getGearItemId('weapon') === toolItemId) return;
    this.toolSwappedEntities.add(entityId);
    void this.applyGearToCharacter(character, 'weapon', toolItemId, /* isLocal */ false);
  }

  /** Restore the entity's real weapon after a skilling swap. Reads from
   *  localEquipment / remoteEquipment (authoritative, synchronously updated
   *  on packet receipt) — a snapshot taken at swap-time can be -1 inside
   *  the async gear-attach window for a freshly-spawned remote. */
  private restoreSkillingTool(entityId: number, character: CharacterEntity): void {
    if (!this.toolSwappedEntities.delete(entityId)) return;
    const realWeapon = entityId === this.localPlayerId
      ? (this.localEquipment.get(0) ?? 0)
      : (this.entities.remoteEquipment.get(entityId)?.[0] ?? 0);
    void this.applyGearToCharacter(character, 'weapon', realWeapon, /* isLocal */ false);
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
      const bodyHideStyle: 'plate' | 'chain' =
        this.itemDefsCache.get(itemId)?.bodyHideStyle === 'chain' ? 'chain' : 'plate';
      if (
        result.skeletons.length === 0 &&
        SKINNED_SLOTS.has(slotName) &&
        character
      ) {
        const ok = await character.attachManualSkinnedArmor(slotName, def.file, result.meshes, itemId, bodyHideStyle);
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

        character.attachSkinnedArmor(slotName, result.meshes, result.skeletons[0], itemId, bodyHideStyle);
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
      additionalAnimations: [...PLAYER_ANIMATIONS],
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
      const loginSeq = this._loginReadySeq;
      this._loginProgress?.(0.48, 'Loading saved character');
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
      void this.tryResolveLoginReady(loginSeq);
    });

    this.network.on(ServerOpcode.SHOW_CHARACTER_CREATOR, () => {
      if (this.resendCachedAppearance()) return;
      this.openCharacterCreatorWhenReady();
    });

    this.network.on(ServerOpcode.ADMIN_FLAGS, (_op, v) => {
      const isAdmin = (v[0] & 1) === 1;
      this.camera.setLockedMode(!isAdmin);
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
        // Movement is tile/Chebyshev based: a diagonal run step can advance
        // both axes at once. Compare the largest axis delta instead of
        // Euclidean distance so a legitimate two-tile diagonal run tick
        // doesn't look farther apart than a two-tile cardinal run tick.
        if (Math.max(Math.abs(dx), Math.abs(dz)) > reconcileDist) {
          this.reconcileLocalPlayerToServer(serverX, serverZ, hiddenCatchup);
        }
        if (syncAppearance && !appearanceEquals(this.localAppearance, syncAppearance)) {
          this.cacheLocalAppearance(syncAppearance);
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
          const anim = this.remoteAnimationStates.get(entityId);
          if (anim) this.applyRemotePlayerAnimation(entityId, anim.kind, anim.variant, anim.targetId, anim.toolItemId);
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
      const stances = ['accurate', 'aggressive', 'defensive', 'controlled'] as const;
      const stance = stances[idx] ?? 'accurate';
      this.entities.remoteStances.set(entityId, stance);
      // Self-echo from the server — reconcile the sidePanel's optimistic
      // UI if the request was rejected or applied differently than expected.
      if (entityId === this.localPlayerId) this.sidePanel?.applyStanceFromServer(stance);
    });

    this.network.on(ServerOpcode.PLAYER_ANIMATION, (_op, v) => {
      const entityId = v[0];
      const kind = (v[1] ?? PlayerAnimationKind.Idle) as PlayerAnimationKind;
      const variant = (v[2] ?? PlayerSkillAnimationVariant.None) as PlayerSkillAnimationVariant;
      const targetId = v[3] ?? 0;
      const toolItemId = v[4] ?? 0;

      if (entityId === this.localPlayerId) {
        if (kind === PlayerAnimationKind.Attack && this.localPlayer) {
          this.localPlayer.playAttackAnimation(this.getPlayerAttackAnimName(entityId));
        } else if (kind === PlayerAnimationKind.Skill && variant === PlayerSkillAnimationVariant.Magic && this.localPlayer) {
          this.localPlayer.playNamedOneShot('spell_cast_2h');
        }
        return;
      }

      this.remoteAnimationStates.set(entityId, { kind, variant, targetId, toolItemId });
      this.applyRemotePlayerAnimation(entityId, kind, variant, targetId, toolItemId);
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
        const tileSize = this.npcDefsCache.get(npcDefId)?.size ?? 1;
        const created = this.entities.createNpc(entityId, npcDefId, x, z, render3D, tileSize);
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

    this.network.on(ServerOpcode.NPC_FACING, (_op, v) => {
      // [entityId, angleQ1000] — 2004scape NPC.faceEntity. Both sprite
      // classes expose setTargetFacing; the per-frame yaw lerp handles
      // the smooth turn.
      const [entityId, angleQ] = v;
      this.entities.npcSprites.get(entityId)?.setTargetFacing(angleQ / 1000);
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
        this.combatTargetId = -1; this.autoCastSpellIndex = -1; this.pendingSingleCastSpell = -1;
      }

      this.entities.cleanupCombatTargetsFor(entityId);
      this.remoteAnimationStates.delete(entityId);
      this.toolSwappedEntities.delete(entityId);
      this.entities.removeRemotePlayer(entityId);
      this.entities.removeNpc(entityId);
    });
  }

  private setupCombatHandlers(): void {
    this.network.on(ServerOpcode.COMBAT_HIT, (_op, v) => {
      const [attackerId, targetId, damage, targetHp, targetMaxHp] = v;

      if (targetId === -1) {
        this.entities.npcCombatTargets.delete(attackerId);
        const sprite = this.entities.npcSprites.get(attackerId);
        if (sprite instanceof CharacterEntity) sprite.clearFaceLock();
        return;
      }

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

      // NPCs still animate from COMBAT_HIT. Player attacks are now driven by
      // PLAYER_ANIMATION so swings broadcast even when there is no visible
      // damage packet in a given viewer's area.
      if (!isPlayerAttacker && attackerEntity) {
        (attackerEntity as any).playAttackAnimation();
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

    // Spell cast — server broadcasts [casterId, targetId, spellIndex] when any
    // player casts. Receivers play the full visual sequence; damage arrives
    // independently via the deferred COMBAT_HIT scheduled at the impact tick.
    this.network.on(ServerOpcode.SPELL_CAST, (_op, v) => {
      const [casterId, targetId, spellIndex] = v;
      this.handleSpellCastBroadcast(casterId, targetId, spellIndex).catch(err => console.error('[spell-cast]', err));
    });
  }

  private async handleSpellCastBroadcast(casterId: number, targetId: number, spellIndex: number): Promise<void> {
    await this.ensureSpellsLoaded();
    const def = this.spellsByIndex[spellIndex];
    if (!def) {
      console.warn(`[spell-cast] unknown spell index ${spellIndex}`);
      return;
    }
    const caster = casterId === this.localPlayerId
      ? this.localPlayer
      : (this.entities.remotePlayers.get(casterId) ?? null);
    const target = this.entities.resolveTargetable(targetId);
    if (!caster || !target) return;  // caster/target out of our chunk window
    this.playSpellEffect(caster, target, def);

    if (casterId === this.localPlayerId && this.pendingSingleCastSpell >= 0) {
      this.pendingSingleCastSpell = -1;
      if (this.combatTargetId >= 0 && this.autoCastSpellIndex < 0) {
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_ATTACK_NPC, this.combatTargetId));
      }
    }
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
        const shopTitle = this.npcDisplayName(npcEntityId, npcDefId);
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

      if (def?.category === 'door') {
        // Edge detection deferred until model is linked — handled in linkPlacedNodeToEntity / onChunkObjectsLoaded
      } else if (def) {
        // Depleted state intentionally ignored — depleted ores/stumps still
        // occupy their tile (matches server policy at the depletion site).
        this.setObjectTilesBlocked(x, z, def, true);
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
        } else {
          model.setEnabled(!isDepleted);
        }
        this.setWorldObjectPickTarget(objectEntityId, this.isWorldObjectInteractable(def, isDepleted), model);
        const hasDepleteModel = def?.category === 'tree' || def?.category === 'rock' || def?.category === 'chest';
        let depletedModel = this.objectModels.getStump(objectEntityId);
        if (!depletedModel && hasDepleteModel && isDepleted) {
          depletedModel = this.objectModels.createDepletedModel(objectEntityId, objectDefId, model);
        }
        if (depletedModel) {
          depletedModel.setEnabled(isDepleted);
          this.setWorldObjectPickTarget(objectEntityId, false, depletedModel);
        }
      }
    });

    this.network.on(ServerOpcode.WORLD_OBJECT_DEPLETED, (_op, v) => {
      const [objectEntityId, isDepleted, swingSign] = v;
      const data = this.worldObjectDefs.get(objectEntityId);
      if (data) data.depleted = isDepleted === 1;

      // Doors animate + toggle their wall edges on depleted-state change.
      // For everything else, blocking is set once at chunk-entry / SYNC and
      // never cleared on depletion — depleted ores/stumps still block.
      if (data) {
        const def2 = this.objectDefsCache.get(data.defId);
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
          // Depleted ores/stumps keep their blocking tile — see chunk-entry
          // case in WORLD_OBJECT_SYNC above. Doors animate + toggle edges;
          // everything else: no-op on depletion.
        }
      }

      const def = data ? this.objectDefsCache.get(data.defId) : null;
      const hasDepleteModel = def?.category === 'tree' || def?.category === 'rock' || def?.category === 'chest';

      if (def?.category === 'door') {
        // Doors stay visible — animation is handled above
      } else {
        const model = this.worldObjectModels.get(objectEntityId);
        if (hasDepleteModel && data) {
          const placedNode = model ?? this.chunkManager.findPlacedObjectNear(data.x, data.z, 1.5, data.defId);
          if (placedNode) {
            if (!model) this.worldObjectModels.set(objectEntityId, placedNode);
            placedNode.setEnabled(isDepleted === 0);
            this.setWorldObjectPickTarget(objectEntityId, isDepleted === 0, placedNode);

            let depleted = this.objectModels.getStump(objectEntityId);
            if (!depleted && isDepleted === 1) {
              depleted = this.objectModels.createDepletedModel(objectEntityId, data.defId, placedNode);
            }
            if (depleted) {
              depleted.setEnabled(isDepleted === 1);
              this.setWorldObjectPickTarget(objectEntityId, false, depleted);
            }
          }
        } else if (model) {
          model.setEnabled(isDepleted === 0);
          this.setWorldObjectPickTarget(objectEntityId, this.isWorldObjectInteractable(def, isDepleted === 1), model);
        }
      }
    });

    this.network.on(ServerOpcode.SKILLING_START, (_op, v) => {
      this.clearPendingObjectInteractionRetry();
      this.isSkilling = true;
      this.skillingObjectId = v[0];
      const toolItemId = v[1] ?? 0;
      if (this.interactMarker) this.interactMarker.isVisible = false;
      const objData = this.worldObjectDefs.get(v[0]);
      const objDef = objData ? this.objectDefsCache.get(objData.defId) : null;
      if (this.chatPanel) {
        const message = objDef?.category === 'chest'
          ? `You attempt to lockpick the ${(objDef.name || 'chest').toLowerCase()}...`
          : `You begin to ${(objDef?.actions[0] ?? 'work').toLowerCase()}...`;
        this.chatPanel.addSystemMessage(message, '#8cf');
      }
      // Chests have no skilling animation — the player stands still while
      // the lockpick cycle ticks on the server. All other harvestables get
      // a category-specific looping anim (chop/mine).
      const variant = objDef?.category === 'tree' ? 'chop'
        : objDef?.category === 'rock' ? 'mine'
        : undefined;
      const skipAnim = objDef?.category === 'chest';

      if (this.localPlayer && toolItemId > 0) {
        this.applySkillingTool(this.localPlayerId, this.localPlayer, toolItemId);
      }

      const stillWalking = this.pathIndex < this.path.length;
      if (stillWalking) {
        this.pendingSkill = { objectId: v[0], variant, stationary: skipAnim };
      } else if (skipAnim) {
        this.startSkillingStationary(v[0]);
      } else {
        this.startSkillingVisual(v[0], variant);
      }
    });

    this.network.on(ServerOpcode.SKILLING_STOP, (_op, _v) => {
      this.endLocalSkilling();
    });
  }

  /** Tear down the local-player skilling state: clear the active-object
   *  tracking, stop the chop/mine loop, and restore the displaced weapon.
   *  Shared by SKILLING_STOP (server-triggered) and handleGroundClick
   *  (player-cancel). */
  private endLocalSkilling(): void {
    this.isSkilling = false;
    this.skillingObjectId = -1;
    this.localPlayer?.stopSkillAnimation();
    if (this.localPlayer) this.restoreSkillingTool(this.localPlayerId, this.localPlayer);
  }

  private setupPlayerStateHandlers(): void {
    this.network.on(ServerOpcode.PLAYER_STATS, (_op, v) => {
      this.playerHealth = v[0];
      this.playerMaxHealth = v[1];
      this.updateHUD();
    });

    // Batch inventory: [slot0_itemId, slot0_qty, slot1_itemId, slot1_qty, ...]
    this.network.on(ServerOpcode.PLAYER_INVENTORY_BATCH, (_op, v) => {
      // Inventory changed means the last interaction landed — cancel any
      // pending arrival retry so recipe-based stations (obelisk, furnace,
      // range) don't fire a second packet 700ms later and double-consume.
      this.clearPendingObjectInteractionRetry();
      for (let i = 0; i < v.length; i += 2) {
        const slot = i / 2;
        if (this.sidePanel) this.sidePanel.updateInvSlot(slot, v[i], v[i + 1]);
        if (this.bankPanel) this.bankPanel.updateInventorySlot(slot, v[i], v[i + 1]);
        if (this.tradePanel) this.tradePanel.updateInventorySlot(slot, v[i], v[i + 1]);
      }
      this.noteLoginBootstrapPacket('inventory');
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
      this.noteLoginBootstrapPacket('skills');
    });

    this.network.on(ServerOpcode.PLAYER_EQUIPMENT, (_op, v) => {
      this.clearPendingObjectInteractionRetry();
      if (this.isSkilling) this.endLocalSkilling();
      const [slotIndex, itemId] = v;
      this.localEquipment.set(slotIndex, itemId);
      if (this.sidePanel) {
        this.sidePanel.updateEquipSlot(slotIndex, itemId);
      }
      // Attach/detach 3D gear on local player
      const gearLoad = this.equipGear(slotIndex, itemId);
      if (this._loginBootstrapPending) this._pendingLoginGearLoads.push(gearLoad);
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
        const gearLoad = this.equipGear(i, v[i]);
        if (this._loginBootstrapPending) this._pendingLoginGearLoads.push(gearLoad);
      }
      this.noteLoginBootstrapPacket('equipment');
    });

    this.network.on(ServerOpcode.XP_GAIN, () => {});

    this.network.on(ServerOpcode.LEVEL_UP, (_op, v) => {
      const [skillIndex, newLevel] = v;
      if (skillIndex >= 0 && skillIndex < ALL_SKILLS.length && this.chatPanel) {
        const skillName = SKILL_NAMES[ALL_SKILLS[skillIndex]];
        this.chatPanel.addSystemMessage(`Congratulations! You just advanced a ${skillName} level.`, '#ff0');
        this.chatPanel.addSystemMessage(`Your ${skillName} level is now ${newLevel}.`, '#ff0');
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
      this.clearPredictedPath();
      this.setTileFrom(newX, newZ);
      this.combatTargetId = -1; this.autoCastSpellIndex = -1; this.pendingSingleCastSpell = -1;
      this.isSkilling = false;
      this.skillingObjectId = -1;
      this.pendingSkill = null;
      this.pendingSmithing = null;
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
      for (let i = this.pathIndex; i < this.path.length; i++) {
        const wp = this.path[i];
        if (Math.floor(wp.x) === tx && Math.floor(wp.z) === tz) {
          cutIdx = i + 1;
          break;
        }
      }
      if (cutIdx >= 0 && cutIdx < this.path.length) {
        this.path = this.path.slice(0, cutIdx);
      } else if (cutIdx < 0) {
        const segmentIdx = this.findPathSegmentContainingTile(tx, tz);
        if (segmentIdx >= 0) {
          this.path = [
            ...this.path.slice(0, segmentIdx),
            { x: lastX, z: lastZ },
          ];
        }
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
        const mapReady = this.handleMapChange(mapId, newX, newZ);
        if (!this._loginSettled) {
          this._loginMapReady = mapReady;
          void mapReady.then(() => {
            this._resolveLoginMapReady?.();
            this._resolveLoginMapReady = null;
            void this.tryResolveLoginReady(this._loginReadySeq);
          });
        }
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
      } else if (opcode === ServerOpcode.NPC_NAME) {
        // [npcEntityId] follows the string payload. Override is cached for
        // the right-click menu, hover tooltip, and shop title — no floating
        // head label, per UX direction.
        const { str, values } = decodeStringPacket(data);
        const entityId = values[0];
        if (str.length > 0) this.entities.npcOverrideNames.set(entityId, str);
        else this.entities.npcOverrideNames.delete(entityId);
      } else if (opcode === ServerOpcode.QUEST_STATE_SYNC) {
        // Full snapshot on login. JSON record {questId: {stage, triggerProgress}}.
        const { str } = decodeStringPacket(data);
        try {
          this.questState = JSON.parse(str) as Record<string, { stage: number; triggerProgress: number }>;
          this.sidePanel?.setQuestState(this.questState);
        } catch (e) { console.warn('[quest] sync parse failed', e); }
      } else if (opcode === ServerOpcode.QUEST_STAGE_ADVANCED) {
        // Single delta: questId string + [stage, triggerProgress].
        const { str: questId, values } = decodeStringPacket(data);
        const stage = values[0];
        const triggerProgress = values[1] ?? 0;
        const prev = this.questState[questId];
        this.questState[questId] = { stage, triggerProgress };
        this.sidePanel?.updateQuestState(questId, stage, triggerProgress);
        // Chat notification on stage change (not on triggerProgress ticks
        // — those are just intermediate kill/item counters).
        if (!prev || prev.stage !== stage) {
          const def = this.questDefsCache.get(questId);
          if (def) {
            if (stage === QUEST_STAGE_COMPLETED) {
              this.chatPanel?.addSystemMessage(`Quest complete: ${def.name}.`, '#ff0');
            } else if (!prev) {
              this.chatPanel?.addSystemMessage(`New quest: ${def.name}. ${def.stages[stage]?.description ?? ''}`, '#ff0');
            } else {
              this.chatPanel?.addSystemMessage(`Quest updated: ${def.name} — ${def.stages[stage]?.description ?? ''}`, '#ff0');
            }
          }
        }
      }
    });
  }

  /** Display name for an NPC entity: per-spawn override wins, else the
   *  hardcoded NPC_NAMES[defId] table, else 'NPC'. Used by right-click,
   *  tooltip, and shop title. */
  private npcDisplayName(entityId: number, defId: number | undefined): string {
    const override = this.entities.npcOverrideNames.get(entityId);
    if (override) return override;
    return NPC_NAMES[defId || 0] || 'NPC';
  }

  private async handleMapChange(mapId: string, newX: number, newZ: number): Promise<void> {
    console.log(`Map change to '${mapId}' at (${newX}, ${newZ})`);

    const isInitialPlacement = !this.hasHandledInitialMapChange;
    const mapAlreadyLoaded = this.chunkManager.isLoaded() && this.chunkManager.getMapId() === mapId;

    this.playerX = newX;
    this.playerZ = newZ;
    this.clearPredictedPath();
    if (this.localPlayer) this.localPlayer.stopWalking();
    this.combatTargetId = -1; this.autoCastSpellIndex = -1; this.pendingSingleCastSpell = -1;
    this.isSkilling = false;
    this.skillingObjectId = -1;

    if (!isInitialPlacement || !mapAlreadyLoaded) {
      this.entities.disposeAllEntities();
      this.remoteAnimationStates.clear();
      // Local player persists across map changes — restore any displaced
      // tool first, then clear the set so a teleport mid-chop doesn't leave
      // the next chop unable to re-swap.
      if (this.localPlayer && this.toolSwappedEntities.has(this.localPlayerId)) {
        this.restoreSkillingTool(this.localPlayerId, this.localPlayer);
      }
      this.toolSwappedEntities.clear();

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

      await this.chunkManager.loadMap(mapId);
      await this.loadBiomes(mapId);
      this.applyFog();
      this.minimap?.invalidateTileCache();
      this._lastMinimapUpdateMs = 0;
    } else {
      this._loginProgress?.(0.58, 'Using preloaded map');
    }

    // Ensure the actual saved spawn chunk is ready before asking the server
    // for entities. This keeps WORLD_OBJECT_SYNC linking against live placed
    // object nodes instead of racing chunk streaming after the overlay hides.
    await this.chunkManager.whenSpawnChunksReady(newX, newZ);
    this.repositionWorldObjects();

    await this._defsReady;
    if (!isInitialPlacement || !this._initialMapReadySent) {
      this.network.sendRaw(encodePacket(ClientOpcode.MAP_READY));
      if (isInitialPlacement) this._initialMapReadySent = true;
    }

    // No Y snap here. LOGIN_OK already set Y from the server. Re-snapping
    // via getHeight() can drop the player below an elevated tile because
    // getHeight gates roof reveal on currentY, and the gate fails the
    // moment chunk data is mid-rebuild. For inter-map transitions (portals)
    // the server should send the new Y alongside MAP_CHANGE — TODO Step 3.

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

      const options = this.getWorldInteractionOptionsAt(e.clientX, e.clientY);
      if (options.length > 0) {
        this.showContextMenu(e.clientX, e.clientY, options);
      }
    });
  }

  private getWorldInteractionOptionsAt(clientX: number, clientY: number): InteractionOption[] {
    const point = this.canvasPointFromClient(clientX, clientY);
    const pickResult = this.scene.pick(point.x, point.y);
    if (!pickResult?.hit || !pickResult.pickedMesh) return [];

    const meshName = pickResult.pickedMesh.name;
    const options: InteractionOption[] = [];

    // Identify the picked NPC. 3D-modeled NPCs (e.g. cows) all share mesh
    // names from their source GLB, so name matching is ambiguous — every
    // cow click would route to whichever cow happened to be first in the
    // npcSprites map. Check metadata.entityId (stamped by Npc3DEntity.
    // setEntityIdMetadata and CharacterEntity.setEntityIdMetadata) by
    // walking up the picked node's parents. pickNpcAtPoint falls through
    // placed scenery to find an NPC along the ray, so clicking through a
    // fence/anvil at an NPC's lower body still surfaces the Talk-to / Attack
    // option.
    const pickedNpcEntityId = this.pickNpcAtPoint(point.x, point.y).entityId;
    if (pickedNpcEntityId != null) {
      options.push(...this.getNpcInteractionOptions(pickedNpcEntityId));
    }

    const pickedGroundItemId = this.findGroundItemIdFromPick(pickResult.pickedMesh as unknown as TransformNode, meshName);
    if (pickedGroundItemId != null) {
      options.push(...this.getGroundItemInteractionOptions(pickedGroundItemId));
    }

    const pickedObjectEntityId = this.findWorldObjectIdFromPick(pickResult.pickedMesh as unknown as TransformNode);
    if (pickedObjectEntityId != null) {
      options.push(...this.getWorldObjectInteractionOptions(pickedObjectEntityId));
    }

    return options;
  }

  private canvasPointFromClient(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.engine.getRenderingCanvas()!.getBoundingClientRect();
    const scaleX = this.engine.getRenderWidth() / Math.max(1, rect.width);
    const scaleY = this.engine.getRenderHeight() / Math.max(1, rect.height);
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  private getNpcInteractionOptions(entityId: number): InteractionOption[] {
    const npcDefId = this.entities.npcDefs.get(entityId);
    const name = this.npcDisplayName(entityId, npcDefId);
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
      return [{ label: `${verb} ${name}`, action: () => this.talkToNpc(entityId) }];
    }

    const lvl = this.npcLevelFor(npcDefId);
    const labelLevel = lvl > 0 ? ` (level-${lvl})` : '';
    return [{ label: `Attack ${name}${labelLevel}`, action: () => this.attackNpc(entityId) }];
  }

  private findGroundItemIdFromPick(pickedMesh: TransformNode, meshName: string): number | null {
    let walk: TransformNode | null = pickedMesh;
    while (walk) {
      if (walk.metadata?.kind === 'groundItem' && typeof walk.metadata?.groundItemId === 'number') {
        return walk.metadata.groundItemId;
      }
      walk = walk.parent as TransformNode | null;
    }

    for (const [groundItemId, sprite] of this.entities.groundItemSprites) {
      if (sprite.getMesh()?.name === meshName) return groundItemId;
    }
    return null;
  }

  /** All ground items sharing the tile of `groundItemId`, newest-first.
   *  NPC loot tables drop 3+ items per kill (bones + coins + a rare) onto one
   *  tile and the picked sprite hides the others under it — callers that care
   *  about the whole pile (right-click menu, hover tooltip) gather the tile
   *  rather than the single picked sprite. Newest-first matches the visible
   *  stacking order and the left-click pickup target. */
  private groundItemStackForTile(groundItemId: number): GroundItemData[] {
    const pickedItem = this.entities.groundItems.get(groundItemId);
    if (!pickedItem) return [];
    const tx = Math.floor(pickedItem.x);
    const tz = Math.floor(pickedItem.z);
    const stack: GroundItemData[] = [];
    for (const [, gi] of this.entities.groundItems) {
      if (Math.floor(gi.x) === tx && Math.floor(gi.z) === tz) stack.push(gi);
    }
    stack.sort((a, b) => b.id - a.id);
    return stack;
  }

  private getGroundItemInteractionOptions(groundItemId: number): InteractionOption[] {
    return this.groundItemStackForTile(groundItemId).map((gi) => {
      const iDef = this.itemDefsCache.get(gi.itemId);
      const iName = iDef?.name ?? 'item';
      const qtyLabel = gi.quantity > 1 ? ` (${gi.quantity})` : '';
      const giId = gi.id;
      return {
        label: `Pick up ${iName}${qtyLabel}`,
        action: () => this.pickupItem(giId),
      };
    });
  }

  private findWorldObjectIdFromPick(pickedMesh: TransformNode): number | null {
    // Check 3D models (trees, rocks, placed objects) by walking up the parent
    // chain looking for objectEntityId metadata.
    let walkMesh: TransformNode | null = pickedMesh;
    while (walkMesh) {
      if (typeof walkMesh.metadata?.objectEntityId === 'number') {
        return walkMesh.metadata.objectEntityId;
      }
      if (walkMesh.metadata?.kind === 'worldObject' && typeof walkMesh.metadata?.objectEntityId === 'number') {
        return walkMesh.metadata.objectEntityId;
      }
      walkMesh = walkMesh.parent as TransformNode | null;
    }

    // If no objectEntityId found, check if this is a placed object near a
    // world object. The editor-authored model nodes are render-only; this
    // links the clicked asset back to the server-side object instance.
    let rootNode: TransformNode = pickedMesh;
    while (rootNode.parent) {
      if (this.chunkManager.isPlacedObjectNode(rootNode)) break;
      rootNode = rootNode.parent as TransformNode;
    }

    if (!this.chunkManager.isPlacedObjectNode(rootNode)) return null;

    const rootAssetId = rootNode.metadata?.assetId;
    if (!rootAssetId || !(rootAssetId in ASSET_TO_OBJECT_DEF)) return null;

    const expectedDefId = ASSET_TO_OBJECT_DEF[rootAssetId];
    const px = rootNode.position.x;
    const pz = rootNode.position.z;
    let bestEid = -1;
    let bestDist = 3.0;
    for (const [eid, data] of this.worldObjectDefs) {
      if (data.defId !== expectedDefId) continue;
      const dist = Math.hypot(data.x - px, data.z - pz);
      if (dist < bestDist) {
        bestDist = dist;
        bestEid = eid;
      }
    }

    if (bestEid < 0) return null;
    this.worldObjectModels.set(bestEid, rootNode);
    return bestEid;
  }

  private getWorldObjectInteractionOptions(objectEntityId: number): InteractionOption[] {
    const data = this.worldObjectDefs.get(objectEntityId);
    if (!data) return [];
    const def = this.objectDefsCache.get(data.defId);
    if (!def || (data.depleted && def.category !== 'door')) return [];

    return this.actionsForInstance(def, data.depleted, data).map((actionName, actionIdx) => ({
      label: `${actionName} ${def.name}`,
      action: () => this.interactObject(objectEntityId, actionIdx),
    }));
  }

  private runInteractionOption(option: InteractionOption, clientX: number, clientY: number): void {
    this.lastClickX = clientX;
    this.lastClickY = clientY;
    option.action();
  }

  private showContextMenu(x: number, y: number, options: InteractionOption[]): void {
    this.hideContextMenu();

    let menu: HTMLDivElement;
    menu = createContextMenu(options.map((opt) => ({
      label: opt.label,
      action: (ev) => {
        this.runInteractionOption(opt, ev.clientX, ev.clientY);
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

  /** Set of legacy NpcDef IDs that aren't valid attack targets (shopkeepers,
   *  smiths, bankers). Server-sent interaction flags are preferred when
   *  available, but this keeps older authored NPCs on the non-combat path. */
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

  /** Rotate the local player's facing toward a world (x, z). 2004scape
   *  Player.faceEntity primitive — used by talkToNpc / attackNpc so the
   *  player isn't standing sideways during the interaction. Uses the
   *  CharacterEntity's smooth-yaw state machine (faceToward) so it lerps
   *  rather than snapping. */
  private faceLocalPlayerToward(x: number, z: number): void {
    const lp = this.localPlayer;
    if (!lp) return;
    lp.faceToward(new Vector3(x, lp.position.y, z));
  }

  /** scene.pick returns the closest hit; that lets placed scenery (anvils,
   *  walls, planes) intercept clicks aimed at an NPC behind them. RuneScape-
   *  style left-click sees through occluders to NPCs in the same ray, so we
   *  multiPick and walk hits sorted by distance, returning the FIRST hit
   *  that resolves to an NPC entity. Falls back to the closest mesh so the
   *  caller can still pick ground / placed objects / ground-items normally
   *  when there's no NPC in the ray. */
  private pickAtCursor(): { entityId: number | null; groundItemId: number | null; closestMesh: import('@babylonjs/core/Meshes/abstractMesh').AbstractMesh | null } {
    return this.pickNpcAtPoint(this.scene.pointerX, this.scene.pointerY);
  }

  private pickNpcAtPoint(x: number, y: number): { entityId: number | null; groundItemId: number | null; closestMesh: import('@babylonjs/core/Meshes/abstractMesh').AbstractMesh | null } {
    const hits = this.scene.multiPick(x, y);
    if (!hits || hits.length === 0) return { entityId: null, groundItemId: null, closestMesh: null };
    // multiPick returns hits unsorted; sort by distance ascending.
    hits.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    const closest = hits[0].pickedMesh ?? null;
    // Walk every hit, not just the closest: an NPC's legs or a ground-item
    // sprite is often occluded by nearer scenery. Take the first match of
    // each kind so a hover resolves to whatever is actually under the cursor.
    let entityId: number | null = null;
    let groundItemId: number | null = null;
    for (const h of hits) {
      const m = h.pickedMesh;
      if (!m) continue;
      if (entityId == null) {
        entityId = this.findNpcEntityIdFromPick(m as unknown as TransformNode, m.name);
      }
      if (groundItemId == null) {
        groundItemId = this.findGroundItemIdFromPick(m as unknown as TransformNode, m.name);
      }
      if (entityId != null && groundItemId != null) break;
    }
    return { entityId, groundItemId, closestMesh: closest };
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
      // Same multiPick logic as the click handlers so the tooltip resolves
      // an NPC or a ground item even when scenery occludes it from the
      // closest-hit picker.
      const { entityId, groundItemId } = this.pickAtCursor();
      let npcLabel: string | null = null;
      if (entityId != null) {
        const npcDefId = this.entities.npcDefs.get(entityId);
        const name = this.npcDisplayName(entityId, npcDefId);
        const flags = this.entities.npcInteractions.get(entityId) ?? 0;
        if (flags !== 0 || this.isNonAttackableNpc(npcDefId)) {
          npcLabel = name;
        } else {
          const lvl = this.npcLevelFor(npcDefId);
          npcLabel = lvl > 0 ? `${name} (level-${lvl})` : name;
        }
      }
      // Ground items: only when the cursor isn't already over an NPC — NPC
      // wins, mirroring the click priority. Show the whole tile pile, not
      // just the picked sprite, since a kill drops several items per tile.
      let itemLines: string[] = [];
      if (npcLabel == null && groundItemId != null) {
        itemLines = this.groundItemStackForTile(groundItemId).map((gi) => {
          const iName = this.itemDefsCache.get(gi.itemId)?.name ?? 'item';
          return gi.quantity > 1 ? `${iName} (${gi.quantity})` : iName;
        });
      }
      if (npcLabel != null) {
        el.style.color = '#d8372b';
        el.textContent = npcLabel;
      } else if (itemLines.length > 0) {
        // Escape — item names are project data, but the tooltip writes them
        // as innerHTML to get one line per stacked item.
        const esc = (s: string) => s.replace(/[&<>]/g, (c) =>
          c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
        el.style.color = '#c8b88a';
        el.innerHTML = itemLines.map(esc).join('<br>');
      }
      if (npcLabel != null || itemLines.length > 0) {
        el.style.left = `${e.clientX + 14}px`;
        el.style.top = `${e.clientY + 14}px`;
        el.style.display = 'block';
      } else if (el.style.display !== 'none') {
        el.style.display = 'none';
      }
    });
  }

  /** Redirect an NPC/object click to a use-on-target packet if the inventory
   *  has a Use slot armed. Returns true if the click was consumed. */
  private tryUseInventoryItemOn(kind: 'npc' | 'object', entityId: number): boolean {
    const using = this.sidePanel?.getUsing();
    if (!using) return false;
    const opcode = kind === 'npc'
      ? ClientOpcode.PLAYER_USE_ITEM_ON_NPC
      : ClientOpcode.PLAYER_USE_ITEM_ON_OBJECT;
    this.network.sendRaw(encodePacket(opcode, using.slot, using.itemId, entityId));
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ffd060');
    this.sidePanel!.clearUsingInvItem();
    return true;
  }

  private attackNpc(npcEntityId: number): void {
    if (performance.now() < this.castingUntil) return;
    if (this.tryUseInventoryItemOn('npc', npcEntityId)) return;

    const targetingSpell = this.sidePanel?.getTargetingSpell() ?? -1;
    if (targetingSpell >= 0) {
      this.pendingSingleCastSpell = targetingSpell;
      this.combatTargetId = npcEntityId;
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_CAST_SPELL, targetingSpell, npcEntityId));
      this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#a040ff');
      this.sidePanel!.clearTargetingSpell();
      return;
    }

    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    this.combatTargetId = npcEntityId;
    this.autoCastSpellIndex = this.sidePanel?.getAutocastSpell() ?? -1;
    this.pendingFaceTargetEntityId = npcEntityId;
    const t = this.entities.npcTargets.get(npcEntityId);
    if (t) this.faceLocalPlayerToward(t.x, t.z);
    this._combatPathTimer = 0.6;

    const target = this.entities.npcTargets.get(npcEntityId);
    if (target) {
      const pathResult = this.findPathFromMovementAnchor(target.x, target.z);
      const path = pathResult.path;
      if (path.length > 0) {
        const last = path[path.length - 1];
        if (Math.floor(last.x) === Math.floor(target.x) && Math.floor(last.z) === Math.floor(target.z)) {
          path.pop();
        }
      }
      if (path.length > 0) {
        this.startPredictedPath(path, pathResult.preserveCurrentStep);
        if (this.destMarker) this.destMarker.isVisible = false;
        this.minimap?.clearDestination();
      }
    }
    if (this.autoCastSpellIndex >= 0) {
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_CAST_SPELL, this.autoCastSpellIndex, npcEntityId));
    } else {
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_ATTACK_NPC, npcEntityId));
    }
  }

  private talkToNpc(npcEntityId: number): void {
    if (performance.now() < this.castingUntil) return;
    if (this.tryUseInventoryItemOn('npc', npcEntityId)) return;
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    this.resumeTalkToNpc(npcEntityId);
  }

  /** Body of talkToNpc without the cursor ping. Called directly by the
   *  mid-tile drain so a deferred talk doesn't double-fire the visual
   *  effect at the original click position. */
  private resumeTalkToNpc(npcEntityId: number): void {
    const target = this.entities.npcTargets.get(npcEntityId);
    if (!target) return;
    // Mid-tile defer: re-pathing from a fractional playerX/Z desyncs from
    // the server (tile-aligned only). Truncate the active path to the
    // in-progress step so the player doesn't walk out the rest of the old
    // route before turning toward the NPC, then queue the talk for the
    // step-completion drain.
    if (this.tileProgress > 0 && this.pathIndex < this.path.length) {
      const activeStep = this.getActiveUnitStep();
      const currentTarget = activeStep?.target ?? this.path[this.pathIndex];
      this.path = [currentTarget];
      this.pathIndex = 0;
      if (activeStep) {
        this.tileProgress = activeStep.progress;
        this.setTileFrom(activeStep.from.x, activeStep.from.z);
      }
      this.network.sendMove([currentTarget]);
      if (this.destMarker) this.destMarker.isVisible = false;
      this.minimap?.clearDestination();
      this.pendingTalkEntityId = npcEntityId;
      return;
    }
    this.pendingFaceTargetEntityId = npcEntityId;

    // sendMove BEFORE TALK_NPC so the server walks the same tiles.
    if (!this.isPlayerAdjacentToTile(target.x, target.z)) {
      const path = this.findPathAdjacentToTarget(target.x, target.z);
      if (path.length > 0) {
        this.startPredictedPath(path);
        if (this.destMarker) this.destMarker.isVisible = false;
        this.minimap?.clearDestination();
      }
    } else {
      // Already adjacent — cancel any in-flight path and face the NPC now;
      // no path-complete event will fire to do it for us.
      this.clearPredictedPath();
      if (this.localPlayer?.isWalking()) this.localPlayer.stopWalking();
      this.faceLocalPlayerToward(target.x, target.z);
      this.pendingFaceTargetEntityId = -1;
    }
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_TALK_NPC, npcEntityId));
  }

  private sameTile(a: { x: number; z: number }, b: { x: number; z: number }): boolean {
    return Math.floor(a.x) === Math.floor(b.x) && Math.floor(a.z) === Math.floor(b.z);
  }

  private tileOnCompressedSegment(start: { x: number; z: number }, end: { x: number; z: number }, tx: number, tz: number): boolean {
    const sx = Math.floor(start.x);
    const sz = Math.floor(start.z);
    const ex = Math.floor(end.x);
    const ez = Math.floor(end.z);
    const dx = Math.sign(ex - sx);
    const dz = Math.sign(ez - sz);
    if (tx === sx && tz === sz) return true;
    if (dx === 0 && dz === 0) return tx === ex && tz === ez;
    if (dx === 0 && tx !== sx) return false;
    if (dz === 0 && tz !== sz) return false;
    if (dx !== 0 && Math.sign(tx - sx) !== dx) return false;
    if (dz !== 0 && Math.sign(tz - sz) !== dz) return false;
    if (dx !== 0 && dz !== 0 && Math.abs(tx - sx) !== Math.abs(tz - sz)) return false;
    return Math.abs(tx - sx) <= Math.abs(ex - sx) && Math.abs(tz - sz) <= Math.abs(ez - sz);
  }

  private findPathSegmentContainingTile(tx: number, tz: number): number {
    for (let i = this.pathIndex; i < this.path.length; i++) {
      const start = i === this.pathIndex ? this.tileFrom : this.path[i - 1];
      if (this.tileOnCompressedSegment(start, this.path[i], tx, tz)) return i;
    }
    return -1;
  }

  private setTileFrom(x: number, z: number): void {
    this.tileFrom.x = x;
    this.tileFrom.z = z;
  }

  private clearPredictedPath(resetAnchor: boolean = false): void {
    this.path = [];
    this.pathIndex = 0;
    this.tileProgress = 0;
    this.pendingPath = null;
    if (resetAnchor) this.setTileFrom(this.playerX, this.playerZ);
  }

  private getActiveUnitStep(): { from: { x: number; z: number }; target: { x: number; z: number }; progress: number } | null {
    if (this.pathIndex >= this.path.length) return null;
    const target = this.path[this.pathIndex];
    const dx = Math.sign(Math.floor(target.x) - Math.floor(this.tileFrom.x));
    const dz = Math.sign(Math.floor(target.z) - Math.floor(this.tileFrom.z));
    const tileSteps = Math.max(
      Math.abs(Math.floor(target.x) - Math.floor(this.tileFrom.x)),
      Math.abs(Math.floor(target.z) - Math.floor(this.tileFrom.z)),
    );
    if (tileSteps <= 1) {
      return {
        from: { x: this.tileFrom.x, z: this.tileFrom.z },
        target: { x: target.x, z: target.z },
        progress: this.tileProgress,
      };
    }

    const progressedTiles = Math.max(0, Math.min(tileSteps - 0.0001, this.tileProgress * tileSteps));
    const completedTiles = Math.floor(progressedTiles);
    const fromTileX = Math.floor(this.tileFrom.x) + dx * completedTiles;
    const fromTileZ = Math.floor(this.tileFrom.z) + dz * completedTiles;
    const targetTileX = fromTileX + dx;
    const targetTileZ = fromTileZ + dz;
    return {
      from: { x: fromTileX + 0.5, z: fromTileZ + 0.5 },
      target: { x: targetTileX + 0.5, z: targetTileZ + 0.5 },
      progress: progressedTiles - completedTiles,
    };
  }

  private findPathFromMovementAnchor(goalX: number, goalZ: number, maxSteps: number = 200): { path: { x: number; z: number }[]; preserveCurrentStep: boolean } {
    const activeStep = this.tileProgress > 0 ? this.getActiveUnitStep() : null;
    if (activeStep) {
      const tail = findPath(activeStep.target.x, activeStep.target.z, goalX, goalZ,
        this.isTileBlocked,
        this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), maxSteps,
        this.isWallBlockedForPath);
      if (tail.length === 0) {
        const currentTileIsGoal = Math.floor(activeStep.target.x) === Math.floor(goalX)
          && Math.floor(activeStep.target.z) === Math.floor(goalZ);
        return { path: currentTileIsGoal ? [activeStep.target] : [], preserveCurrentStep: currentTileIsGoal };
      }
      const startsAtCurrentTarget = this.sameTile(tail[0], activeStep.target);
      return {
        path: startsAtCurrentTarget ? tail : [activeStep.target, ...tail],
        preserveCurrentStep: true,
      };
    }
    return {
      path: findPath(this.playerX, this.playerZ, goalX, goalZ,
        this.isTileBlocked,
        this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), maxSteps,
        this.isWallBlockedForPath),
      preserveCurrentStep: false,
    };
  }

  /** Chebyshev-1 adjacency between the player's tile and (targetX, targetZ). */
  private isPlayerAdjacentToTile(targetX: number, targetZ: number): boolean {
    return Math.max(
      Math.abs(Math.floor(this.playerX) - Math.floor(targetX)),
      Math.abs(Math.floor(this.playerZ) - Math.floor(targetZ)),
    ) <= 1;
  }

  /** Pathfind so the path ends one unit-tile short of (targetX, targetZ).
   *  Pathfinding to the target and popping the last waypoint outright is
   *  broken under corner compression: a straight-line walk compresses to
   *  [firstStep, lastStep], and the pop leaves just [firstStep] — one tile
   *  from the player, far from the target. Instead we trim the last
   *  waypoint by stepping back one unit-tile along the final segment
   *  direction; the compressed segment between the second-last and the
   *  trimmed last is server-expanded into unit tiles unchanged, preserving
   *  the full walk distance. */
  private findPathAdjacentToTarget(targetX: number, targetZ: number): { x: number; z: number }[] {
    const path = findPath(this.playerX, this.playerZ, targetX, targetZ,
      this.isTileBlocked,
      this.chunkManager.getMapWidth(), this.chunkManager.getMapHeight(), 200,
      this.isWallBlockedForPath);
    if (path.length === 0) return path;

    const ntx = Math.floor(targetX);
    const ntz = Math.floor(targetZ);
    const last = path[path.length - 1];
    const lastTx = Math.floor(last.x);
    const lastTz = Math.floor(last.z);
    // findPath fell back to closest-approach (target unreachable) — the path
    // already ends on a non-target tile, so no trim needed.
    if (lastTx !== ntx || lastTz !== ntz) return path;

    const prev = path.length >= 2 ? path[path.length - 2] : { x: this.playerX, z: this.playerZ };
    const prevTx = Math.floor(prev.x);
    const prevTz = Math.floor(prev.z);
    const newTx = lastTx - Math.sign(lastTx - prevTx);
    const newTz = lastTz - Math.sign(lastTz - prevTz);
    if (path.length >= 2 && prevTx === newTx && prevTz === newTz) {
      path.pop();
    } else {
      path[path.length - 1] = { x: newTx + 0.5, z: newTz + 0.5 };
    }
    return path;
  }

  private startPredictedPath(path: { x: number; z: number }[], preserveCurrentStep: boolean = false): void {
    if (path.length === 0) return;
    const activeStep = this.getActiveUnitStep();
    this.path = path;
    this.pathIndex = 0;
    if (preserveCurrentStep && activeStep && this.sameTile(path[0], activeStep.target)) {
      this.tileProgress = activeStep.progress;
      this.setTileFrom(activeStep.from.x, activeStep.from.z);
    } else {
      // Walk from current visual position (often fractional mid-step) to
      // path[0]. Body rotation handles the visible turn — no snap.
      this.tileProgress = 0;
      this.setTileFrom(this.playerX, this.playerZ);
    }
    this.pendingPath = null;
    this.network.sendMove(path);
  }

  private clearPendingObjectInteractionRetry(): void {
    this.pendingObjectInteraction = null;
    if (this.pendingObjectInteractionTimer !== null) {
      window.clearTimeout(this.pendingObjectInteractionTimer);
      this.pendingObjectInteractionTimer = null;
    }
  }

  private trackObjectInteractionRetry(objectEntityId: number, actionIndex: number): void {
    if (this.pendingObjectInteractionTimer !== null) {
      window.clearTimeout(this.pendingObjectInteractionTimer);
      this.pendingObjectInteractionTimer = null;
    }
    this.pendingObjectInteraction = {
      objectEntityId,
      actionIndex,
      seq: ++this.pendingObjectInteractionSeq,
    };
  }

  private scheduleObjectInteractionArrivalRetry(): void {
    const pending = this.pendingObjectInteraction;
    if (!pending || this.isSkilling) return;
    if (this.pendingObjectInteractionTimer !== null) {
      window.clearTimeout(this.pendingObjectInteractionTimer);
    }

    this.pendingObjectInteractionTimer = window.setTimeout(() => {
      this.pendingObjectInteractionTimer = null;
      const current = this.pendingObjectInteraction;
      if (!current || current.seq !== pending.seq || this.isSkilling || this.pathIndex < this.path.length) return;

      const data = this.worldObjectDefs.get(current.objectEntityId);
      const def = data ? this.objectDefsCache.get(data.defId) : null;
      if (!data || !def || (data.depleted && def.category !== 'door')) {
        this.clearPendingObjectInteractionRetry();
        return;
      }

      const ptx = Math.floor(this.playerX);
      const ptz = Math.floor(this.playerZ);
      if (!isTileAdjacentToObject(ptx, ptz, data.x, data.z, def)) {
        this.clearPendingObjectInteractionRetry();
        return;
      }

      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, current.objectEntityId, current.actionIndex));
      this.clearPendingObjectInteractionRetry();
    }, 700);
  }

  private pickupItem(groundItemId: number): void {
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    const item = this.entities.groundItems.get(groundItemId);
    if (item) {
      const { path, preserveCurrentStep } = this.findPathFromMovementAnchor(item.x, item.z);
      if (path.length > 0) {
        this.startPredictedPath(path, preserveCurrentStep);
        if (this.destMarker) this.destMarker.isVisible = false;
        this.minimap?.clearDestination();
      }
    }
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_PICKUP_ITEM, groundItemId));
  }

  private handleObjectClick(objectEntityId: number): void {
    if (performance.now() < this.castingUntil) return;
    // Cooldown after cancelling a skill — prevent spam-restarting
    if (performance.now() - this.skillCancelTime < 600) return;
    const data = this.worldObjectDefs.get(objectEntityId);
    if (!data) return;
    const def = this.objectDefsCache.get(data.defId);
    if (!def) return;
    // Doors can always be clicked (open/close toggle). Other objects can't when depleted.
    if (!this.isWorldObjectInteractable(def, data.depleted)) return;
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    // Auto-interact with harvestable objects (trees, rocks), doors, ladders,
    // and crafting stations (furnace, anvil, range).
    if ((def.skill && def.harvestItemId) || def.category === 'crop' || def.category === 'door' || def.category === 'ladder' || (def.recipes && def.recipes.length > 0)) {
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

      if (def.category === 'crop') {
        const ptx = Math.floor(this.playerX);
        const ptz = Math.floor(this.playerZ);
        if (isTileAdjacentToObject(ptx, ptz, data.x, data.z, def)) {
          this.faceLocalPlayerToward(data.x, data.z);
        } else {
          // Reuse the stationary-skill arrival path — prepareSkillingAtObject
          // faces the target on arrival without triggering a skill animation
          // (server intentionally skips SKILLING_START for crops).
          this.pendingSkill = { objectId: objectEntityId, stationary: true };
        }
      }

      this.interactObject(objectEntityId, 0);
    }
  }

  private showSmithingUI(objectEntityId: number, def: WorldObjectDef): void {
    this.clearPendingObjectInteractionRetry();
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
    this.combatTargetId = -1; this.autoCastSpellIndex = -1;
    const data = this.worldObjectDefs.get(objectEntityId);
    if (!data) return;
    const def = this.objectDefsCache.get(data.defId);
    if (!this.isWorldObjectInteractable(def, data.depleted)) return;
    if (this.tryUseInventoryItemOn('object', objectEntityId)) return;
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');

    // Intercept anvil/tool-based crafting: show recipe UI instead of auto-crafting.
    // Walk to the anvil first if not adjacent — the panel only opens once we're
    // next to it. Server also refuses crafts when out of range as a backstop.
    const objData = this.worldObjectDefs.get(objectEntityId);
    if (objData) {
      const objDef = this.objectDefsCache.get(objData.defId);
      if (objDef?.recipes && objDef.recipes.length > 0 && objDef.recipes[0].requiresTool) {
        const ptx = Math.floor(this.playerX);
        const ptz = Math.floor(this.playerZ);
        const alreadyAdj = isTileAdjacentToObject(ptx, ptz, objData.x, objData.z, objDef);
        this.pendingSmithing = null;
        if (alreadyAdj) {
          this.showSmithingUI(objectEntityId, objDef);
        } else {
          const candidates = getObjectInteractionTiles(objData.x, objData.z, objDef)
            .filter(tile => !this.isTileBlocked(tile.x, tile.z))
            .map(tile => ({
              ax: tile.x,
              az: tile.z,
              dist: Math.hypot(this.playerX - (tile.x + 0.5), this.playerZ - (tile.z + 0.5)),
            }));
          candidates.sort((a, b) => a.dist - b.dist);

          let bestPath: { x: number; z: number }[] | null = null;
          let bestPreserveCurrentStep = false;
          for (const { ax, az } of candidates) {
            const { path, preserveCurrentStep } = this.findPathFromMovementAnchor(ax + 0.5, az + 0.5, 500);
            if (path.length > 0) {
              bestPath = path;
              bestPreserveCurrentStep = preserveCurrentStep;
              break;
            }
          }
          if (bestPath) {
            this.startPredictedPath(bestPath, bestPreserveCurrentStep);
            this.pendingSmithing = { objectEntityId, def: objDef };
          }
        }
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

    const dx = data.x - this.playerX;
    const dz = data.z - this.playerZ;
    const dist = Math.hypot(dx, dz);

    // Find a reachable adjacent tile and walk there
    const shouldRetryOnArrival = !!def && def.category !== 'door' && !!((def.skill && def.harvestItemId) || def.category === 'ladder' || (def.recipes && def.recipes.length > 0));

    if (def?.category === 'door') {
      this.clearPendingObjectInteractionRetry();
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
        const { path, preserveCurrentStep } = this.findPathFromMovementAnchor(tx + 0.5, tz + 0.5, 500);
        if (path.length > 0) {
          this.startPredictedPath(path, preserveCurrentStep);
        }
      } else {
        this.clearPredictedPath();
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
          const { path, preserveCurrentStep } = this.findPathFromMovementAnchor(frontX + 0.5, frontZ + 0.5, 500);
          if (path.length > 0) {
            this.startPredictedPath(path, preserveCurrentStep);
          }
        }
      }
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, actionIndex));
      return;
    }

    // Check if already on a valid adjacent tile
    const ptx = Math.floor(this.playerX);
    const ptz = Math.floor(this.playerZ);
    const alreadyAdj = def ? isTileAdjacentToObject(ptx, ptz, data.x, data.z, def) : dist <= 1.5;

    if (!alreadyAdj && def) {
      const candidates = getObjectInteractionTiles(data.x, data.z, def)
        .filter(tile => !this.isTileBlocked(tile.x, tile.z))
        .map(tile => ({
          ax: tile.x,
          az: tile.z,
          dist: Math.hypot(this.playerX - (tile.x + 0.5), this.playerZ - (tile.z + 0.5)),
        }));
      candidates.sort((a, b) => a.dist - b.dist);

      let bestPath: { x: number; z: number }[] | null = null;
      let bestPreserveCurrentStep = false;
      for (const { ax, az } of candidates) {
        const { path, preserveCurrentStep } = this.findPathFromMovementAnchor(ax + 0.5, az + 0.5, 500);
        if (path.length > 0) {
          bestPath = path;
          bestPreserveCurrentStep = preserveCurrentStep;
          break;
        }
      }
      if (bestPath) {
        if (shouldRetryOnArrival) this.trackObjectInteractionRetry(objectEntityId, actionIndex);
        this.startPredictedPath(bestPath, bestPreserveCurrentStep);
      } else {
        this.clearPendingObjectInteractionRetry();
      }
    } else if (!alreadyAdj) {
      this.clearPendingObjectInteractionRetry();
    } else if (shouldRetryOnArrival) {
      this.trackObjectInteractionRetry(objectEntityId, actionIndex);
      this.scheduleObjectInteractionArrivalRetry();
    } else {
      this.clearPendingObjectInteractionRetry();
    }

    // Send interaction request — server validates distance
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, actionIndex));
  }

  private handleChatCommand(msg: string): boolean {
    if (msg === '/geardebug') {
      if (!this.gearDebugPanel) {
        this.gearDebugPanel = new GearDebugPanel();
        this.gearDebugPanel.setSlotGetter((slot) => this.localPlayer?.getGearNode?.(slot) ?? null);
        this.gearDebugPanel.setSlotBoneGetter((slot) => EQUIP_SLOT_BONES[slot]?.boneName ?? '');
        this.gearDebugPanel.setItemInfoGetter((slot) => {
          const itemId = this.localPlayer?.getGearItemId(slot) ?? -1;
          if (itemId < 0) return null;
          const def = this.itemDefsCache.get(itemId);
          return { id: itemId, name: def?.name ?? `item ${itemId}`, toolType: def?.toolType };
        });
        this.gearDebugPanel.setOverrideGetter((itemId) => this.gearOverrides.get(itemId) ?? null);
        this.gearDebugPanel.setSkinnedChecker((slot) => this.localPlayer?.getSkinnedArmorMeshes?.(slot) != null);
        this.gearDebugPanel.setAuthTokenGetter(() => this.token || localStorage.getItem('projectrs_token') || '');
        this.gearDebugPanel.setSaveCallback(async (itemId, override) => {
          this.gearOverrides.set(itemId, override);
          const all: Record<string, any> = {};
          for (const [id, ov] of this.gearOverrides) all[String(id)] = ov;
          const token = this.token || localStorage.getItem('projectrs_token') || '';
          const res = await fetch('/api/dev/gear-overrides', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
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
    if (msg === '/appearance') {
      this.openCharacterCreatorWhenReady();
      return true;
    }
    if (msg.startsWith('/anim ')) {
      this.runAnimCommand(msg.slice(6).trim());
      return true;
    }
    if (msg === '/anim' || msg === '/anim ?') {
      const names = this.localPlayer?.getAnimationNames() ?? [];
      this.chatPanel?.addSystemMessage(`Animations: ${names.join(', ') || '(none loaded)'}`);
      return true;
    }
    // /spellbook must precede /spell so it doesn't get parsed as "/spell book".
    // /spell and /cast require a space (or exact match) for the same reason —
    // a bare `startsWith('/spell')` swallows any /spell* command.
    if (msg === '/spellbook') {
      this.toggleSpellbook();
      return true;
    }
    if (msg === '/spell' || msg === '/spell ?' || msg.startsWith('/spell ')) {
      this.runSpellCommand(msg.slice(6).trim());
      return true;
    }
    if (msg === '/cast' || msg === '/cast ?' || msg.startsWith('/cast ')) {
      this.runCastCommand(msg.slice(5).trim());
      return true;
    }
    return false;
  }

  /**
   * Open or close the spellbook. Lazy-creates the panel on first call and
   * refreshes its contents from /api/spells each time it opens so any spells
   * added since the last open show up.
   */
  private async toggleSpellbook(): Promise<void> {
    if (this.spellbookPanel?.isVisible) { this.spellbookPanel.hide(); return; }
    if (!this.spellbookPanel) {
      this.spellbookPanel = new SpellbookPanel();
      this.spellbookPanel.setCastCallback((spellIndex) => this.castSpellAtNearest(spellIndex));
    }
    await this.ensureSpellsLoaded();
    this.spellbookPanel.show(this.spellsByIndex);
  }

  /**
   * Fire PLAYER_CAST_SPELL targeting the nearest NPC. Used by the spellbook
   * button and could be reused by hotkeys / right-click "Cast" actions later.
   */
  private castSpellAtNearest(spellIndex: number): void {
    if (!this.localPlayer) return;
    const def = this.spellsByIndex[spellIndex];
    if (!def) return;
    const nearest = this.entities.findNearestNpc(this.localPlayer.position);
    if (!nearest) {
      this.chatPanel?.addSystemMessage(`${def.name}: no target in sight.`);
      return;
    }
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_CAST_SPELL, spellIndex, nearest.entityId));
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

  /** Play a named animation on the local player as a one-shot. Used by /anim debug. */
  private runAnimCommand(animName: string): void {
    if (!animName) return;
    if (!this.localPlayer) {
      this.chatPanel?.addSystemMessage('No local player yet.');
      return;
    }
    const ok = this.localPlayer.playNamedOneShot(animName);
    if (!ok) {
      const names = this.localPlayer.getAnimationNames();
      this.chatPanel?.addSystemMessage(`Unknown animation '${animName}'. Available: ${names.join(', ')}`);
    }
  }

  /**
   * Run a spell effect locally for testing. Syntax: `/spell <id> [targetEntityId]`.
   * - Empty / `?` → list known spells
   * - No target → picks the nearest NPC
   *
   * Pure client-side; no server interaction yet (Phase 4 hooks this up to CAST_SPELL).
   */
  private async runSpellCommand(args: string): Promise<void> {
    if (!this.localPlayer) {
      this.chatPanel?.addSystemMessage('No local player yet.');
      return;
    }
    await this.ensureSpellsLoaded();
    const known = this.spellsById!;
    if (!args || args === '?') {
      const ids = [...known.keys()];
      this.chatPanel?.addSystemMessage(`Spells: ${ids.join(', ') || '(none — drop a JSON in server/data/spells/)'}`);
      return;
    }
    const parts = args.split(/\s+/);
    const spellId = parts[0];
    const targetIdRaw = parts[1];
    const def = known.get(spellId);
    if (!def) {
      this.chatPanel?.addSystemMessage(`No spell '${spellId}'. Known: ${[...known.keys()].join(', ')}`);
      return;
    }

    const target = targetIdRaw
      ? this.entities.resolveTargetable(parseInt(targetIdRaw, 10))
      : this.entities.findNearestNpc(this.localPlayer.position)?.npc ?? null;
    if (!target) {
      this.chatPanel?.addSystemMessage('No target — cast failed.');
      return;
    }

    this.playSpellEffect(this.localPlayer, target, def, () => {
      this.chatPanel?.addSystemMessage(`Impact: ${def.name}`);
    });
  }

  /**
   * Run the full cast→travel→impact pipeline for one spell. Pure presentation:
   * plays the caster's cast animation and hands a snapshot of caster/target
   * positions to SpellEffectPlayer. Reused by Phase 4's SPELL_CAST broadcast
   * handler (caster may be a remote player, target may be the local player).
   *
   * No damage / no network — just visuals + the `onImpact` callback.
   */
  private playSpellEffect(
    caster: CharacterEntity,
    target: Targetable,
    def: SpellEffectDef,
    onImpact?: () => void,
  ): void {
    if (!this.spellEffectPlayer) this.spellEffectPlayer = new SpellEffectPlayer(this.scene);
    caster.faceToward(target.position);
    caster.playNamedOneShot('spell_cast_2h');
    if (caster === this.localPlayer) {
      this.castingUntil = performance.now() + def.cast.durationMs;
      this.clearPredictedPath();
      this.localPlayer.stopWalking();
      this.network.sendMove([]);
    }
    const from = caster.getCastOrigin();
    const to = target.getTargetAnchor();
    // Ground decals sit at the target's foot height; falling back to to.y
    // would float them at chest level.
    const groundY = target.position.y;
    this.spellEffectPlayer.play({ def, from, to, target, caster, groundY, onImpact })
      .catch(err => console.error('[spell]', err));
  }

  /**
   * Send a real cast packet to the server. Syntax: `/cast <id> [targetEntityId]`.
   * Server validates range / cooldown / target, broadcasts SPELL_CAST, queues
   * the damage for the impact tick. The visuals replay via the SPELL_CAST
   * broadcast handler, not from this method.
   */
  private async runCastCommand(args: string): Promise<void> {
    if (!this.localPlayer) {
      this.chatPanel?.addSystemMessage('No local player yet.');
      return;
    }
    await this.ensureSpellsLoaded();
    const known = this.spellsById!;
    if (!args || args === '?') {
      const ids = [...known.keys()];
      this.chatPanel?.addSystemMessage(`Cast: ${ids.join(', ') || '(no spells loaded)'}`);
      return;
    }
    const parts = args.split(/\s+/);
    const spellId = parts[0];
    const targetIdRaw = parts[1];

    const def = known.get(spellId);
    if (!def) {
      this.chatPanel?.addSystemMessage(`No spell '${spellId}'.`);
      return;
    }
    const spellIndex = this.spellsByIndex.indexOf(def);
    if (spellIndex < 0) return;

    let targetId = targetIdRaw ? parseInt(targetIdRaw, 10) : NaN;
    if (!Number.isFinite(targetId)) {
      const nearest = this.entities.findNearestNpc(this.localPlayer.position);
      if (!nearest) {
        this.chatPanel?.addSystemMessage('No target — cast failed.');
        return;
      }
      targetId = nearest.entityId;
    }

    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_CAST_SPELL, spellIndex, targetId));
  }

  /**
   * Fetch /api/spells once and cache. The server returns spells already sorted
   * by id; we preserve that order so the array index matches the server's
   * binary protocol index (PLAYER_CAST_SPELL / SPELL_CAST).
   */
  private async ensureSpellsLoaded(): Promise<void> {
    if (this.spellsById) return;
    try {
      const res = await fetch('/api/spells');
      const data = await res.json();
      const list = (data.spells as SpellEffectDef[]) ?? [];
      this.spellsByIndex = list;
      const map = new Map<string, SpellEffectDef>();
      for (const s of list) map.set(s.id, s);
      this.spellsById = map;
    } catch (e) {
      console.error('[spell] failed to load /api/spells:', e);
      this.spellsById = new Map();
      this.spellsByIndex = [];
    }
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
      this.cacheLocalAppearance(appearance);
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
      opacity: 0;
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

  /** Cancel any in-flight path, snap to the current tile's center, and face
   *  the given object. Shared setup for both animated and stationary
   *  skilling starts. */
  private prepareSkillingAtObject(objectId: number): void {
    this.clearPredictedPath();
    this.slideOffsetX = 0;
    this.slideOffsetZ = 0;
    this.slideStartMs = 0;
    this.playerX = Math.round(this.playerX - 0.5) + 0.5;
    this.playerZ = Math.round(this.playerZ - 0.5) + 0.5;
    this.setTileFrom(this.playerX, this.playerZ);
    if (!this.localPlayer) return;
    this.localPlayer.stopWalking();
    const h = this.getHeight(this.playerX, this.playerZ);
    this.localPlayer.setPositionXYZ(this.playerX, h, this.playerZ);
    const objData = this.worldObjectDefs.get(objectId);
    if (objData) {
      this.localPlayer.faceToward(new Vector3(objData.x, 0, objData.z));
    }
  }

  private startSkillingVisual(objectId: number, variant?: string): void {
    this.prepareSkillingAtObject(objectId);
    this.localPlayer?.startSkillAnimation(variant);
  }

  /** Like startSkillingVisual but with no looping skill animation — the
   *  character stays in idle (used for lockpicking chests). */
  private startSkillingStationary(objectId: number): void {
    this.prepareSkillingAtObject(objectId);
  }

  private finishPredictedPathArrival(): void {
    this.tileProgress = 0;
    if (this.destMarker) this.destMarker.isVisible = false;
    this.minimap?.clearDestination();
    this.localPlayer?.stopWalking();
    if (this.pendingSkill) {
      const { objectId, variant, stationary } = this.pendingSkill;
      this.pendingSkill = null;
      if (stationary) this.startSkillingStationary(objectId);
      else this.startSkillingVisual(objectId, variant);
    }
    if (this.pendingSmithing) {
      const { objectEntityId: smithObjId, def: smithDef } = this.pendingSmithing;
      this.pendingSmithing = null;
      this.showSmithingUI(smithObjId, smithDef);
    }
    // Face the NPC we were walking up to talk to / attack. Done after
    // stopWalking so the rotation isn't immediately overwritten by movement
    // direction logic. Lookup uses npcTargets, which tracks the latest
    // server-broadcast position even if the NPC wandered while we walked.
    if (this.pendingFaceTargetEntityId >= 0) {
      const npcTarget = this.entities.npcTargets.get(this.pendingFaceTargetEntityId);
      if (npcTarget) this.faceLocalPlayerToward(npcTarget.x, npcTarget.z);
      this.pendingFaceTargetEntityId = -1;
    }
    this.scheduleObjectInteractionArrivalRetry();
  }

  private handleGroundClick(worldX: number, worldZ: number): void {
    if (performance.now() < this.castingUntil) return;
    if ((this.sidePanel?.getTargetingSpell() ?? -1) >= 0) this.sidePanel!.clearTargetingSpell();
    this.combatTargetId = -1; this.autoCastSpellIndex = -1; this.pendingSingleCastSpell = -1;
    this.pendingSkill = null;
    this.pendingSmithing = null;
    this.clearPendingObjectInteractionRetry();
    // Walking elsewhere cancels the queued face-NPC — we'd look weird
    // turning toward a Shopkeeper after the player has already moved on.
    this.pendingFaceTargetEntityId = -1;
    this.pendingTalkEntityId = -1;
    // Release any face-lock so the body re-aims along the new travel
    // direction rather than continuing to strafe toward the previous target.
    this.localPlayer?.clearFaceLock();
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
      if (this.localPlayer) this.restoreSkillingTool(this.localPlayerId, this.localPlayer);
    }
    if (this.interactMarker) this.interactMarker.isVisible = false;

    const tx = Math.floor(worldX), tz = Math.floor(worldZ);

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
        // Mid-step: keep the current unit target so the animation completes
        // the in-progress step and the character lands cleanly on a tile
        // center rather than freezing between two tiles. The natural
        // path-finished branch in updateLocalPlayerMovement (~line 3282)
        // will call stopWalking() when pathIndex catches up.
        const activeStep = this.getActiveUnitStep();
        const currentTarget = activeStep?.target ?? this.path[this.pathIndex];
        this.path = [currentTarget];
        this.pathIndex = 0;
        if (activeStep) {
          this.tileProgress = activeStep.progress;
          this.setTileFrom(activeStep.from.x, activeStep.from.z);
        }
        // Keep the current unit progress so interpolation continues seamlessly.
        // Send the same one-tile path to the server so its moveQueue ends
        // on the same tile we're walking to.
        this.network.sendMove([currentTarget]);
      } else {
        // Not walking — just make sure we're idle.
        this.clearPredictedPath(true);
        this.localPlayer?.stopWalking();
        this.network.sendMove([]);
      }
      return;
    }

    const { path, preserveCurrentStep } = this.findPathFromMovementAnchor(worldX, worldZ);
    if (path.length > 0) {
      this.startPredictedPath(path, preserveCurrentStep);
      const dest = path[path.length - 1];
      // Yellow ground destination disc removed in favor of the cursor burst.
      // Minimap arrow still indicates where you're heading.
      this.minimap?.setDestination(dest.x, dest.z);
    }
  }

  private createHUD(): void {
    this.minimap = new Minimap(260);
    this.minimap.setClickMoveHandler((worldX, worldZ) => {
      this.handleGroundClick(worldX, worldZ);
    });
    this.chunkManager.setOnMinimapDataChanged(() => this.minimap?.invalidateTileCache());
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectSleepTimer !== null) {
      window.clearTimeout(this.reconnectSleepTimer);
      this.reconnectSleepTimer = null;
    }
    this.clearPendingObjectInteractionRetry();
    this.hideReconnectOverlay();
    this.network.close();
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

  private overlayFogOpacity(worldPos: Vector3, camPos: Vector3): number {
    const fogStart = this.scene.fogStart ?? Number.POSITIVE_INFINITY;
    const fogEnd = this.scene.fogEnd ?? Number.POSITIVE_INFINITY;
    if (fogEnd <= fogStart) return 1;
    const dx = worldPos.x - camPos.x;
    const dy = worldPos.y - camPos.y;
    const dz = worldPos.z - camPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist >= fogEnd) return 0;
    if (dist <= fogStart) return 1;
    return 1 - ((dist - fogStart) / (fogEnd - fogStart));
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
    const wp = this._overlayWorldPos;

    // Inline projection — previous version allocated three (x,y) arrow
    // closures per sprite per frame for the project callback. Hot path at
    // ~60 FPS × (1 + |remotePlayers| + |npcSprites|).
    const offscreenX = -9999;
    const offscreenY = -9999;

    if (this.localPlayer) {
      const sprite = this.localPlayer;
      if (sprite.hasChatBubble()) {
        const got = sprite.getChatBubbleWorldPos(wp);
        if (got) {
          Vector3.ProjectToRef(got, identity, transform, vp, screenPos);
          if (screenPos.z > 0 && screenPos.z < 1) sprite.updateChatBubbleScreenPos(screenPos.x, screenPos.y);
          else sprite.updateChatBubbleScreenPos(offscreenX, offscreenY);
        }
      }
      if (sprite.hasHealthBar()) {
        const got = sprite.getHealthBarWorldPos(wp);
        if (got) {
          Vector3.ProjectToRef(got, identity, transform, vp, screenPos);
          if (screenPos.z > 0 && screenPos.z < 1) sprite.updateHealthBarScreenPos(screenPos.x, screenPos.y);
          else sprite.updateHealthBarScreenPos(offscreenX, offscreenY);
        }
      }
      // Local player has no name label (we don't render our own over our head).
    }

    for (const [, sprite] of this.entities.remotePlayers) {
      const hasBubble = sprite.hasChatBubble();
      const hasBar = sprite.hasHealthBar();
      const hasLabel = sprite.getLabelWorldPos(wp) !== null;
      if (!hasBubble && !hasBar && !hasLabel) continue;

      const pos = sprite.position;
      const dx = pos.x - camPos.x;
      const dy = pos.y - camPos.y;
      const dz = pos.z - camPos.z;
      if (dx * dx + dy * dy + dz * dz > maxDistSq) {
        if (hasBar) sprite.updateHealthBarScreenPos(offscreenX, offscreenY);
        if (hasBubble) sprite.updateChatBubbleScreenPos(offscreenX, offscreenY);
        if (hasLabel) sprite.updateLabelScreenPos(offscreenX, offscreenY);
        continue;
      }

      if (hasBubble) {
        const got = sprite.getChatBubbleWorldPos(wp);
        if (got) {
          Vector3.ProjectToRef(got, identity, transform, vp, screenPos);
          if (screenPos.z > 0 && screenPos.z < 1) sprite.updateChatBubbleScreenPos(screenPos.x, screenPos.y);
          else sprite.updateChatBubbleScreenPos(offscreenX, offscreenY);
        }
      }
      if (hasBar) {
        const got = sprite.getHealthBarWorldPos(wp);
        if (got) {
          Vector3.ProjectToRef(got, identity, transform, vp, screenPos);
          if (screenPos.z > 0 && screenPos.z < 1) sprite.updateHealthBarScreenPos(screenPos.x, screenPos.y);
          else sprite.updateHealthBarScreenPos(offscreenX, offscreenY);
        }
      }
      if (hasLabel) {
        const got = sprite.getLabelWorldPos(wp);
        if (got) {
          Vector3.ProjectToRef(got, identity, transform, vp, screenPos);
          const fogOpacity = this.overlayFogOpacity(got, camPos);
          if (screenPos.z > 0 && screenPos.z < 1 && fogOpacity > 0.01) {
            sprite.updateLabelScreenPos(screenPos.x, screenPos.y, fogOpacity);
          }
          else sprite.updateLabelScreenPos(offscreenX, offscreenY);
        }
      }
    }

    for (const [, sprite] of this.entities.npcSprites) {
      const hasBubble = sprite.hasChatBubble();
      const hasBar = sprite.hasHealthBar();
      // Npc3DEntity has no getLabelWorldPos — check via the CharacterEntity
      // sibling type. instanceof on a hot path is fine (V8 inlines the check),
      // but cache the cast so we don't re-narrow on each subsequent call.
      const labelHost = sprite instanceof CharacterEntity ? sprite : null;
      const hasLabel = labelHost ? labelHost.getLabelWorldPos(wp) !== null : false;
      if (!hasBubble && !hasBar && !hasLabel) continue;

      const pos = sprite.position;
      const dx = pos.x - camPos.x;
      const dy = pos.y - camPos.y;
      const dz = pos.z - camPos.z;
      if (dx * dx + dy * dy + dz * dz > maxDistSq) {
        if (hasBar) sprite.updateHealthBarScreenPos(offscreenX, offscreenY);
        if (hasBubble) sprite.updateChatBubbleScreenPos(offscreenX, offscreenY);
        if (hasLabel && labelHost) labelHost.updateLabelScreenPos(offscreenX, offscreenY);
        continue;
      }

      if (hasBubble) {
        const got = sprite.getChatBubbleWorldPos(wp);
        if (got) {
          Vector3.ProjectToRef(got, identity, transform, vp, screenPos);
          if (screenPos.z > 0 && screenPos.z < 1) sprite.updateChatBubbleScreenPos(screenPos.x, screenPos.y);
          else sprite.updateChatBubbleScreenPos(offscreenX, offscreenY);
        }
      }
      if (hasBar) {
        const got = sprite.getHealthBarWorldPos(wp);
        if (got) {
          Vector3.ProjectToRef(got, identity, transform, vp, screenPos);
          if (screenPos.z > 0 && screenPos.z < 1) sprite.updateHealthBarScreenPos(screenPos.x, screenPos.y);
          else sprite.updateHealthBarScreenPos(offscreenX, offscreenY);
        }
      }
      if (hasLabel && labelHost) {
        const got = labelHost.getLabelWorldPos(wp);
        if (got) {
          Vector3.ProjectToRef(got, identity, transform, vp, screenPos);
          const fogOpacity = this.overlayFogOpacity(got, camPos);
          if (screenPos.z > 0 && screenPos.z < 1 && fogOpacity > 0.01) {
            labelHost.updateLabelScreenPos(screenPos.x, screenPos.y, fogOpacity);
          }
          else labelHost.updateLabelScreenPos(offscreenX, offscreenY);
        }
      }
    }
  }

  private updateHUD(): void {
    this.sidePanel?.updateHP(this.playerHealth, this.playerMaxHealth);
  }

  private update(dt: number): void {
    if (this.connectionFrozen) return;

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
          // Hold body yaw on the target across chase repaths.
          this.localPlayer.lockFaceTowardXZ(npcSprite.position.x, npcSprite.position.z);
        }
      }
    }

    this.entities.interpolateRemotePlayers(dt, camPos, (entityId) =>
      this.remoteAnimationStates.get(entityId)?.kind === PlayerAnimationKind.Skill);
    this.entities.interpolateNpcs(dt, camPos, this.localPlayerId, this.localPlayer?.position ?? null);

    this.updateIndoorDetection();
    this.updateDoorAnimations(dt);

    if (this.localPlayer) {
      this._tempVec.set(this.localPlayer.position.x, this.localPlayer.position.y, this.localPlayer.position.z);
      this.camera.followTarget(this._tempVec);
    }

    this._overlayTransformReady = false;
    this.updateOverlayPositions();
    this.updateHitSplats(dt);
    this.updateMinimap(dt);
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
    const isSpellCombat = this.autoCastSpellIndex >= 0;
    const inRange = isSpellCombat ? dist <= 9.5 : dist <= 1.5;
    if (inRange && !isSpellCombat) return;
    if (inRange && isSpellCombat) {
      if (this._combatPathTimer > 0 || performance.now() < this.castingUntil) return;
      this._combatPathTimer = 0.6;
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_CAST_SPELL, this.autoCastSpellIndex, this.combatTargetId));
      return;
    }
    const closeEnough = isSpellCombat ? dist <= 10 : dist <= 3;
    if ((this.pathIndex < this.path.length && closeEnough) || this._combatPathTimer > 0) return;
    this._combatPathTimer = 0.6;
    const pathResult = this.findPathFromMovementAnchor(npcTarget.x, npcTarget.z);
    const newPath = pathResult.path;
    if (newPath.length > 0) {
      const last = newPath[newPath.length - 1];
      if (Math.floor(last.x) === Math.floor(npcTarget.x) && Math.floor(last.z) === Math.floor(npcTarget.z)) {
        newPath.pop();
      }
    }
    if (newPath.length > 0) {
      this.startPredictedPath(newPath, pathResult.preserveCurrentStep);
      if (this.destMarker) this.destMarker.isVisible = false;
      this.minimap?.clearDestination();
    }
    if (isSpellCombat) {
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_CAST_SPELL, this.autoCastSpellIndex, this.combatTargetId));
    } else {
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
    for (let i = this.pathIndex; i < this.path.length; i++) {
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
      this.setTileFrom(serverX, serverZ);
      const dragDist = Math.hypot(prevLogicalX - serverX, prevLogicalZ - serverZ);
      const slideMs = Math.min(Math.max(dragDist / 3.0 * 1000, 200), 800);
      this.beginVisualSlide(prevLogicalX, prevLogicalZ, slideMs);
      if (this.pathIndex >= this.path.length) {
        this.finishPredictedPathArrival();
      }
      return;
    }

    const segmentIdx = this.findPathSegmentContainingTile(sTx, sTz);
    if (segmentIdx >= 0) {
      // The server can be on an intermediate unit tile inside one compressed
      // client segment. Keep the same waypoint target and re-anchor the
      // segment at the authoritative tile instead of treating this as a
      // wrong-path snap.
      this.pathIndex = segmentIdx;
      this.tileProgress = 0;
      this.setTileFrom(serverX, serverZ);
      const dragDist = Math.hypot(prevLogicalX - serverX, prevLogicalZ - serverZ);
      const slideMs = Math.min(Math.max(dragDist / 3.0 * 1000, 200), 800);
      this.beginVisualSlide(prevLogicalX, prevLogicalZ, slideMs);
      return;
    }

    // Server is not on the path the client is currently predicting. During
    // visible play, keep the server queue authoritative and slide the local
    // visual onto it. After a hidden-tab return, preserve the older hard reset
    // behavior so stale background movement is cancelled instead of resumed.
    this.clearPredictedPath();
    this.setTileFrom(serverX, serverZ);
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

    const effectiveSpeed = this.moveSpeed;

    const stepRate = tileSteps > 0 ? (effectiveSpeed * dt) / tileSteps : 1;
    this.tileProgress += stepRate;

    while (this.tileProgress >= 1.0 && this.pathIndex < this.path.length) {
      const stepTarget = this.path[this.pathIndex];
      this.tileProgress -= 1.0;
      this.playerX = stepTarget.x;
      this.playerZ = stepTarget.z;
      this.setTileFrom(stepTarget.x, stepTarget.z);
      this.pathIndex++;

      // Deferred talk-to fires now that playerX/Z are tile-aligned.
      if (this.pendingTalkEntityId >= 0) {
        const id = this.pendingTalkEntityId;
        this.pendingTalkEntityId = -1;
        this.resumeTalkToNpc(id);
      }

      if (this.pendingPath) {
        this.path = this.pendingPath;
        this.pathIndex = 0;
        this.pendingPath = null;
      }

      if (this.pathIndex >= this.path.length) {
        this.finishPredictedPathArrival();
        this.renderLocalPlayerWithSlide();
        this.inputManager.setPlayerY(this.getHeight(this.playerX, this.playerZ));
        return;
      }
    }

    if (this.pathIndex < this.path.length) {
      const activeTarget = this.path[this.pathIndex];
      const activeDx = activeTarget.x - this.tileFrom.x;
      const activeDz = activeTarget.z - this.tileFrom.z;
      this.playerX = this.tileFrom.x + activeDx * this.tileProgress;
      this.playerZ = this.tileFrom.z + activeDz * this.tileProgress;
    } else if (this.tileProgress < 1.0) {
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

      // Per-tick faceEntity refresh — combat takes precedence over a
      // pending talk-to. Both clear on a ground click.
      const lockId = this.combatTargetId >= 0 ? this.combatTargetId : this.pendingFaceTargetEntityId;
      if (lockId >= 0) {
        const npcTarget = this.entities.npcTargets.get(lockId);
        if (npcTarget) this.localPlayer.lockFaceTowardXZ(npcTarget.x, npcTarget.z);
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
    const cam = this.scene.activeCamera;
    if (!cam) return;
    const sp = this._overlayScreenPos;
    const camPos = cam.position;

    let writeIdx = 0;
    for (let i = 0; i < this.hitSplats.length; i++) {
      const splat = this.hitSplats[i];
      splat.timer -= dt;
      splat.worldPos.y += dt * 0.5;
      if (splat.timer <= 0) {
        splat.el.remove();
      } else {
        Vector3.ProjectToRef(splat.worldPos, GameManager.IDENTITY, this._overlayTransform, this._overlayVp, sp);
        const fogOpacity = this.overlayFogOpacity(splat.worldPos, camPos);
        const lifetimeOpacity = splat.timer < 0.3 ? splat.timer / 0.3 : 1;
        const visible = sp.z > 0 && sp.z < 1 && fogOpacity > 0.01;

        splat.el.style.opacity = visible ? (lifetimeOpacity * fogOpacity).toString() : '0';
        splat.el.style.left = visible ? `${sp.x}px` : '-9999px';
        splat.el.style.top = visible ? `${sp.y}px` : '-9999px';
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
  private actionsForInstance(
    def: WorldObjectDef,
    depleted: boolean,
    data?: { x: number; z: number },
  ): readonly string[] {
    if (def.category === 'door') {
      return depleted ? DOOR_ACTIONS_OPEN_CLIENT : DOOR_ACTIONS_CLOSED_CLIENT;
    }
    if (def.category === 'ladder') return this.ladderActionsForObject(data);
    if (depleted) return [];
    return def.actions;
  }

  private ladderActionsForObject(data?: { x: number; z: number }): readonly string[] {
    if (!data) return ['Examine'];
    const playerY = this.localPlayer?.position.y ?? this.getHeight(this.playerX, this.playerZ);
    const positions = [
      { x: Math.floor(data.x) + 0.5, z: Math.floor(data.z) + 0.5 },
      { x: Math.floor(data.x) + 0.5, z: Math.floor(data.z) - 0.5 },
      { x: Math.floor(data.x) + 0.5, z: Math.floor(data.z) + 1.5 },
      { x: Math.floor(data.x) - 0.5, z: Math.floor(data.z) + 0.5 },
      { x: Math.floor(data.x) + 1.5, z: Math.floor(data.z) + 0.5 },
    ];
    const heights: number[] = [];
    for (const pos of positions) {
      for (const height of this.chunkManager.getWalkableHeightsAt(pos.x, pos.z)) {
        if (!heights.some(existing => Math.abs(existing - height) < 0.1)) {
          heights.push(height);
        }
      }
    }
    const hasUp = heights.some(height => height > playerY + 0.8);
    const hasDown = heights.some(height => height < playerY - 0.8);
    const actions: string[] = [];
    if (hasDown) actions.push('Climb-down');
    if (hasUp) actions.push('Climb-up');
    actions.push('Examine');
    return actions;
  }

  private isWorldObjectInteractable(def: WorldObjectDef | undefined | null, depleted: boolean): boolean {
    if (!def) return false;
    return !depleted || def.category === 'door';
  }

  private setWorldObjectPickTarget(objectEntityId: number, interactive: boolean, root?: TransformNode | null): void {
    const target = root ?? this.worldObjectModels.get(objectEntityId);
    if (!target) return;

    const apply = (node: TransformNode): void => {
      if (interactive) {
        node.metadata = { ...node.metadata, objectEntityId };
      } else if (node.metadata && node.metadata.objectEntityId === objectEntityId) {
        delete node.metadata.objectEntityId;
      }
    };

    apply(target);
    for (const child of target.getChildMeshes(false)) apply(child);
    for (const child of target.getChildTransformNodes(false)) apply(child);
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

  private updateMinimap(_dt: number): void {
    if (!this.minimap || !this.chunkManager.isLoaded()) return;
    const now = performance.now();
    const elapsedMs = this._lastMinimapUpdateMs === 0
      ? GameManager.MINIMAP_UPDATE_INTERVAL_MS
      : now - this._lastMinimapUpdateMs;
    if (elapsedMs < GameManager.MINIMAP_UPDATE_INTERVAL_MS) return;
    this._lastMinimapUpdateMs = now;

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
      Math.min(elapsedMs / 1000, 0.25),
    );
  }
}
