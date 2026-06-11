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
import { Vector3, Color3, Color4, Matrix, Quaternion, TmpVectors } from '@babylonjs/core/Maths/math';
import { Viewport } from '@babylonjs/core/Maths/math.viewport';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import '@babylonjs/loaders/glTF';
import { ChunkManager, assertOptionalMapResourceResponse } from '../rendering/ChunkManager';
import { GameCamera } from '../rendering/Camera';
import { CharacterEntity, loadGearTemplate, type GearDef, type GearTemplate } from '../rendering/CharacterEntity';
import { PER_TARGET_GEAR_SLOTS, buildCharacterGearDef, disposeImportedGearResult, loadCharacterGearSmart, loadStaticGearTemplate, resolveCharacterGearModelFile } from '../rendering/CharacterGearLoader';
import { applyNpcGearFitToNode, createNpcGearTemplateWithFit } from '../rendering/NpcGearAttachment';
import { Npc3DEntity } from '../rendering/Npc3DEntity';
import { ArrowProjectileManager, arrowProjectileTravelMs } from '../rendering/ArrowProjectile';
import { SpellEffectPlayer } from '../rendering/SpellEffectPlayer';
import { DeathPortalEffect } from '../rendering/DeathPortalEffect';
import { LevelUpFireworkEffect } from '../rendering/LevelUpFireworkEffect';
import { DEFAULT_DUNGEON_SKYBOX_CONFIG, DEFAULT_SKYBOX_CONFIG, GameSkybox } from '../rendering/GameSkybox';
import type { Targetable } from '../rendering/Targetable';
import { WorldObjectModels } from '../rendering/WorldObjectModels';
import { mountWorldOverlayElement } from '../rendering/worldOverlay';
import { EntityManager, type GroundItemData } from './EntityManager';
import { InputManager } from './InputManager';
import { NetworkManager } from './NetworkManager';
import { findPath } from '../rendering/Pathfinding';
import { SidePanel } from '../ui/SidePanel';
import { ChatPanel } from '../ui/ChatPanel';
import { GearDebugPanel } from '../ui/GearDebugPanel';
import { BoneDebugPanel } from '../ui/BoneDebugPanel';
import { RotateDebugPanel } from '../ui/RotateDebugPanel';
import { mergeNpcGearSlotFit, resolveNpcGearSlotConfig, type NpcGearSlotConfig } from '../data/NpcGearConfig';
import { Minimap } from '../ui/Minimap';
// StatsPanel removed — HP now shown in side panel
import { ShopPanel, type ShopItem } from '../ui/ShopPanel';
import { DialoguePanel, type DialogueNodePayload } from '../ui/DialoguePanel';
import { BankPanel } from '../ui/BankPanel';
import { TradePanel } from '../ui/TradePanel';
import { DuelPanel } from '../ui/DuelPanel';
import { QuantityInputPanel, type QuantityInputRequest } from '../ui/QuantityInputPanel';
import { AdminPanel } from '../ui/AdminPanel';
import { CharacterCreator } from '../ui/CharacterCreator';
import { SmithingPanel } from '../ui/SmithingPanel';
import { SpellbookPanel } from '../ui/SpellbookPanel';
import { closeActiveContextMenu, createContextMenu, suppressNextContextMenuClick } from '../ui/popupStyle';
import { buildSceneBudget, logSceneBudget } from '../debug/SceneBudget';
import { NPC_NAMES, resolveNpcModelSourceId, resolveNpcVisualConfig } from '../data/NpcConfig';
import { EQUIP_SLOT_BONES, EQUIP_SLOT_NAMES, mergeGearOverrideForBodyType, resolveGearOverrideForBodyType, type GearOverride } from '../data/EquipmentConfig';
import { resolveItemModelPath, setThumbnailItemCatalog } from '../rendering/ItemIcon';
import { ServerOpcode, ClientOpcode, ClientActivityKind, EntityDeathKind, PlayerAnimationKind, PlayerSkillAnimationVariant, NPC_INTERACTION_HAS_DIALOGUE, NPC_INTERACTION_HAS_SHOP, NPC_INTERACTION_HAS_BANK, NPC_INTERACTION_STARTS_COMBAT, encodePacket, decodeQuantityValues, ALL_SKILLS, SKILL_NAMES, WallEdge, doorEdgeFromPlacement, DOOR_EDGE_NEIGHBOR, centeredDoorTileFromPlacement, decodeStringPacket, BIOME_CELL_SIZE, SPELL_CAST_DISTANCE, DEFAULT_RANGED_ATTACK_DISTANCE, normalizeRangedAttackDistance, decodeNpcVisualScale, RANGED_PROJECTILE_SOURCE_HEIGHT, RANGED_PROJECTILE_TARGET_HEIGHT, TICK_RATE, STANCE_KEYS, CHUNK_SIZE, RICE_PLANT_OBJECT_DEF_ID, POTATO_PLANT_OBJECT_DEF_ID, POTTERY_WHEEL_OBJECT_DEF_ID, KILN_OBJECT_DEF_ID, SPINNING_WHEEL_OBJECT_DEF_ID, GENERIC_SCENERY_OBJECT_DEF_ID, FIRE_OBJECT_DEF_ID, BATCH_OBJECT_RECIPE_DEF_IDS, appearanceEquals, isValidAppearance, normalizeAppearance, APPEARANCE_WIRE_FIELD_COUNT, appearanceFromWireValues, appearanceToWireValues, PROTOCOL_VERSION, COMBAT_BONUS_WIRE_KEYS, npcCombatLevel, combatLevelFromLevels, combatRangeIncludesOffset, getCharacterModelPath, CHARACTER_MODEL_PATHS, CHARACTER_TARGET_HEIGHT, CHARACTER_ANIM_DIR, PLAYER_ANIMATIONS, NPC_3D_LOD_DISTANCE, getObjectFootprintMinTile, getObjectFootprintCenterCoord, getObjectFootprintBounds, getObjectFootprintTiles, getObjectInteractionTiles, isTileAdjacentToObject, localSidesToWorldSides, usesCornerInteractionTiles, usesMapAuthoredObjectCollision, compressedPathTileSteps, findPathToReach, QUEST_STAGE_COMPLETED, gearFitFamilyForName, resolveEquipmentModelPath, resolveGearFitSourceItemId, mergeObjectActionLabels, isHighQualityItem, objectDefIdForPlacedAsset, sceneryExamineMetaForAsset, withGeneratedBankNotes, BANK_NOTE_TEMPLATE_ITEM_ID, normalizeNpcEquipmentFits, zeroBonuses, type WorldObjectDef, type ItemDef, type NpcDef, type InventorySlot, type PlayerAppearance, type CustomColors, CUSTOM_COLOR_SLOTS, type BiomesFile, type BiomeDef, type QuestDef, type QuestState, type QuestCondition, type PlacedObjectInteraction, type SkyboxConfig, type SpellEffectDef, type SkillId, type CombatBonuses, type MinimapMarker } from '@projectrs/shared';

// Door action labels — mirror server WorldObject.currentActions so right-click
// menu labels reflect the door's current state. Both ends pass actionIndex 0
// for the toggle, so the mismatch was previously a UX bug only.
const DOOR_ACTIONS_CLOSED_CLIENT: readonly string[] = ['Open', 'Examine'];
const DOOR_ACTIONS_LOCKED_CLIENT: readonly string[] = ['Unlock', 'Examine'];
const DOOR_ACTIONS_OPEN_CLIENT: readonly string[] = ['Close', 'Examine'];
const MAX_FRAME_DT_SECONDS = 0.1;
const ADMIN_NAME_COLOR = '#b96cff';
const MODERATOR_NAME_COLOR = '#62a8ff';
const GEAR_DEBUG_CACHE_BUST_TOKEN: string = import.meta.env.DEV ? `?v=${Date.now()}` : '';
const NPC_MATERIALIZATION_RETRY_MS = 500;
const NPC_LOD_HYSTERESIS_TILES = 4;
const NPC_TARGET_PATH_MAX_SEARCH_TILES = 4096;
const NPC_TARGET_PATH_MAX_WAYPOINTS = 50;
const ENTITY_RENDER_PADDING_TILES = 8;
const ENTITY_RENDER_HYSTERESIS_TILES = 8;
const LOW_QUALITY_HARDWARE_SCALE = 2.0;
const EMERGENCY_LOW_QUALITY_HARDWARE_SCALE = 3.0;
const LOW_FPS_DIAGNOSTIC_WARMUP_MS = 5000;
const LOW_FPS_DIAGNOSTIC_SAMPLE_MS = 3000;
const LOW_FPS_DIAGNOSTIC_THRESHOLD = 50;
const LOW_FPS_EXTRA_SCALE_THRESHOLD = 45;
const MANUAL_LOW_QUALITY_STORAGE_KEY = 'projectrs_low_quality';
const AUTO_LOW_QUALITY_STORAGE_KEY = 'projectrs_auto_low_quality';
const SOFTWARE_RENDERER_PATTERNS = [
  'swiftshader',
  'llvmpipe',
  'software rasterizer',
  'software renderer',
  'microsoft basic render',
  'basic render driver',
  'warp',
  'mesa offscreen',
] as const;
const GROUND_ITEM_TOOLTIP_MAX_LINES = 8;
const ROOF_HOVER_REFRESH_MS = 75;
const ROOF_HOVER_CLEAR_GRACE_MS = 120;
const ROOF_HOVER_STICKY_RADIUS_TILES = 1;
const ROOF_HOVER_WALL_TRIGGER_RADIUS_TILES = 1;
const ROOF_HOVER_RAY_SEARCH_RADIUS_TILES = 4;

interface FrameRateSample {
  frames: number;
  durationMs: number;
  fps: number;
}
const ROOF_HOVER_STRUCTURAL_SAMPLE_HEIGHT_OFFSETS = [1.1, 1.8, 2.5] as const;
const NPC_FACING_NONE = -32768;
const TERMINAL_CLOSE_REASONS = new Set([
  'Idle timeout',
  'Logged out',
  'Logged in from another session',
  'Account is still in combat',
]);
const RECIPE_INPUT_NOUN_BY_CATEGORY: Readonly<Record<string, string>> = {
  furnace: 'ore',
  cookingrange: 'food',
};
const NO_INTERACTION_ACTIONS: readonly string[] = [];

function isCookingStationDef(def: WorldObjectDef): boolean {
  return def.category === 'cookingrange' || def.id === FIRE_OBJECT_DEF_ID;
}

function devCacheBustGearFile(file: string): string {
  return GEAR_DEBUG_CACHE_BUST_TOKEN ? `${file}${GEAR_DEBUG_CACHE_BUST_TOKEN}` : file;
}

function recipePanelSkillFor(def: WorldObjectDef): SkillId {
  const skill = def.recipes?.[0]?.skill;
  return typeof skill === 'string' && (ALL_SKILLS as readonly string[]).includes(skill)
    ? skill as SkillId
    : 'smithing';
}

function recipePanelInputNounFor(def: WorldObjectDef): string {
  if (isCookingStationDef(def)) return 'food';
  if (def.id === POTTERY_WHEEL_OBJECT_DEF_ID) return 'soft clay';
  if (def.id === KILN_OBJECT_DEF_ID) return 'unfired clay';
  if (def.id === SPINNING_WHEEL_OBJECT_DEF_ID) return 'sinew';
  return RECIPE_INPUT_NOUN_BY_CATEGORY[def.category] ?? 'bars';
}

function supportsBatchObjectRecipe(def: WorldObjectDef): boolean {
  return BATCH_OBJECT_RECIPE_DEF_IDS.includes(def.id);
}

function isHarvestObjectDef(def: WorldObjectDef): boolean {
  return def.category === 'tree'
    || def.category === 'rock'
    || def.category === 'fishingspot'
    || def.category === 'stall';
}

function isSoftwareWebGlRenderer(webgl: Record<string, unknown>): boolean {
  const rendererText = [
    webgl.unmaskedRenderer,
    webgl.renderer,
    webgl.unmaskedVendor,
    webgl.vendor,
  ].map(value => String(value ?? '').toLowerCase()).join(' ');
  return SOFTWARE_RENDERER_PATTERNS.some(pattern => rendererText.includes(pattern));
}

type InteractionOption = {
  label: string;
  labelParts?: { text: string; color?: string }[];
  labelColor?: string;
  action: () => void;
  /** False means right-click/touch-menu only, not primary left-click. */
  primary?: boolean;
};

type MinimapEntityPoint = { x: number; z: number };

type DoorPickProxyBounds = {
  center: Vector3;
  width: number;
  depth: number;
  height: number;
};

type CropPickProxyConfig = {
  width: number;
  depth: number;
  height: number;
  y: number;
};

type CropPickProxyBatch = {
  mesh: Mesh;
  config: CropPickProxyConfig;
  objectEntityIds: Array<number | null>;
  refsByObjectId: Map<number, CropPickProxyRef>;
  freeIndices: number[];
};

type CropPickProxyRef = {
  batchKey: string;
  index: number;
  placedNode: TransformNode;
  config: CropPickProxyConfig;
};

type WorldObjectPickProxyBatch = {
  mesh: Mesh;
  objectEntityIds: Array<number | null>;
  refsByObjectId: Map<number, WorldObjectPickProxyRef>;
  freeIndices: number[];
};

type WorldObjectPickProxyRef = {
  index: number;
  bounds: DoorPickProxyBounds;
};

const DEFAULT_CROP_PICK_PROXY: CropPickProxyConfig = { width: 1.2, depth: 1.2, height: 1.2, y: 0.6 };
const RICE_CROP_PICK_PROXY: CropPickProxyConfig = { width: 0.6, depth: 0.6, height: 0.6, y: 0.3 };
const POTATO_CROP_PICK_PROXY: CropPickProxyConfig = { width: 0.5, depth: 0.5, height: 0.5, y: 0.25 };

type DoorPivotEntry = {
  pivot: TransformNode;
  targetAngle: number;
  currentAngle: number;
  closedRotY: number;
  openDirection: -1 | 1;
};

type MobilePanelMode = 'game' | 'map' | 'panel' | 'chat';

type PendingTouchInteraction = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  clientX: number;
  clientY: number;
  options: InteractionOption[];
  longPressTimer: number;
  contextShown: boolean;
  rotating: boolean;
};

type ActiveTouchPoint = {
  clientX: number;
  clientY: number;
};

type HealthBarHost = {
  showHealthBar: (current: number, max: number) => void;
  hideHealthBar: () => void;
};

type HitSplatOverlay = {
  worldPos: Vector3;
  el: HTMLDivElement;
  timer: number;
};

type XpDropOverlay = {
  worldPos: Vector3;
  el: HTMLDivElement;
  timer: number;
  lifetime: number;
  screenOffsetX: number;
  driftX: number;
  riseSpeed: number;
  popScale: number;
  glowStrength: number;
};

type XpDropImpact = {
  fontSize: number;
  lifetime: number;
  riseSpeed: number;
  popScale: number;
  glowStrength: number;
};

type AttackAnimationHost = Targetable & {
  playAttackAnimation?: (variant?: string) => void;
  getAnimationDurationMs?: (name: string) => number;
};

declare global {
  interface Window {
    gm?: GameManager;
    _gameEntities?: EntityManager;
  }
}

function asAttackAnimationHost(entity: Targetable | null | undefined): AttackAnimationHost | null {
  if (!entity) return null;
  const candidate = entity as AttackAnimationHost;
  return typeof candidate.playAttackAnimation === 'function' || typeof candidate.getAnimationDurationMs === 'function'
    ? candidate
    : null;
}

function asHealthBarHost(entity: Targetable | null | undefined): HealthBarHost | null {
  if (!entity) return null;
  const candidate = entity as Targetable & Partial<HealthBarHost>;
  return typeof candidate.showHealthBar === 'function' && typeof candidate.hideHealthBar === 'function'
    ? candidate as HealthBarHost
    : null;
}

type PinchZoomState = {
  pointerIds: [number, number];
  lastDistance: number;
};

type LoadingProgressCallback = (pct: number, status: string) => void;
type GearApplyGuard = () => boolean;
type GroundItemPickRef = {
  groundItemId: number | null;
  tileKey: string | null;
};

export class GameManager {
  private engine: Engine;
  private scene: Scene;
  private camera: GameCamera;
  private chunkManager: ChunkManager;
  private skybox: GameSkybox;
  private arrowProjectiles: ArrowProjectileManager;
  private inputManager: InputManager;
  private network: NetworkManager;
  private readonly onFatalDisconnect?: () => void;
  private destroyed: boolean = false;
  private baseHardwareScalingLevel: number;
  private renderHardwareScalingLevel: number = 1;

  private connectionFrozen: boolean = false;
  private reconnecting: boolean = false;
  private reconnectOverlay: HTMLDivElement | null = null;
  private reconnectStartedAt: number = 0;
  private reconnectAttempt: number = 0;
  private reconnectSleepTimer: number | null = null;
  private static readonly RECONNECT_MAX_MS = 22_000;
  private static readonly RECONNECT_DELAY_MS = 1_600;
  private static readonly RECONNECT_LOGIN_TIMEOUT_MS = 8_000;
  private static readonly AUTHORITY_STALE_MS = 12_000;
  private static readonly SELF_SYNC_RECONCILE_DIST = 1.25;
  private static readonly STOPPED_SELF_SYNC_RECONCILE_DIST = 0.35;
  private static readonly FRESH_PREDICTION_RECONCILE_DIST = 2.25;
  private static readonly FRESH_PREDICTION_RECONCILE_GRACE_MS = TICK_RATE + 150;
  private static readonly AUTHORITY_REANCHOR_MAX_SEARCH_TILES = 500;
  private static readonly AUTHORITY_REANCHOR_MAX_ATTEMPTS = 3;
  private static readonly HIDDEN_CATCHUP_ARM_MS = 3_000;
  private static readonly HIDDEN_RECONNECT_AFTER_MS = 15_000;
  private static readonly PRELOAD_STEP_TIMEOUT_MS = 20_000;
  private static readonly LOGIN_READY_TIMEOUT_MS = 10_000;
  private static readonly AUTHORITY_LOGIN_GRACE_MS = 5_000;
  private static readonly RANGED_ATTACK_DISTANCE = DEFAULT_RANGED_ATTACK_DISTANCE;
  private static readonly MOBILE_LANDSCAPE_CAMERA_QUERY =
    '(max-height: 520px) and (max-width: 900px) and (orientation: landscape)';
  private static readonly DESKTOP_CAMERA_ASPECT_CAP = 980 / 500;

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
  private nextMapChangeSeq: number = 0;
  private activeMapChangeSeq: number = 0;
  private floorChangeDuringMapLoad: { seq: number; floor: number; worldY?: number } | null = null;
  private localTeleportHeightOverride: { tileX: number; tileZ: number; floor: number; y: number; expiresAt: number } | null = null;
  private playerX: number = 512;
  private playerZ: number = 512;
  private playerHealth: number = 10;
  private playerMaxHealth: number = 10;

  // Movement — tick-aligned tile stepping (RS-style)
  private path: { x: number; z: number }[] = [];
  private pathIndex: number = 0;
  private moveSpeed: number = 1.67; // RS2 walk speed: 1 tile per 600ms tick
  private pendingPath: { x: number; z: number }[] | null = null; // queued path from click-while-moving
  private predictedPathStartedAt: number = 0;
  private predictedPathDestination: { x: number; z: number } | null = null;
  private predictedPathAuthorityReanchorAttempts: number = 0;
  /** NPC entityId to face when the current path completes. 2004scape
   *  Player.faceEntity equivalent — set by talkToNpc/attackNpc, cleared
   *  on arrival or any new ground click. */
  private pendingFaceTargetEntityId: number = -1;
  private followTargetPlayerId: number = -1;
  private followPathTimer: number = 0;
  private skillCancelTime: number = 0; // timestamp when skilling was last cancelled
  private tileProgress: number = 0; // 0→1 progress through current tile step
  private tileFrom: { x: number; z: number } = { x: 0, z: 0 }; // where we started this tile step
  private controlledMoveUntilMs: number = 0;

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
  private static readonly MINIMAP_LIST_REFRESH_INTERVAL_MS = 50;
  private static readonly MINIMAP_ENTITY_TILES_PER_SEC = 1000 / TICK_RATE;
  private static readonly MINIMAP_ENTITY_SNAP_DISTANCE_TILES = 3;
  private static readonly XP_DROP_AGGREGATE_MS = 90;
  private static readonly XP_DROP_RECENT_HISTORY_SIZE = 10;
  private static readonly XP_DROP_SIDE_SPREAD_PX = 26;
  // Hidden-tab catch-up state. While hidden, RAF can stop while the server
  // keeps ticking; after resume we briefly trust authoritative sync over
  // stale local prediction, then disarm for normal visible play.
  private _hiddenSinceMs: number = 0;
  private _hiddenCatchupUntilMs: number = 0;
  private _hiddenCatchupTimer: number | null = null;
  private _visibilityHandler: (() => void) | null = null;
  private _activityHandler: (() => void) | null = null;
  private _cursorTelemetryHandler: ((event: PointerEvent) => void) | null = null;
  private _npcTooltipHandler: ((event: PointerEvent) => void) | null = null;
  private _roofHoverLeaveHandler: ((event: PointerEvent) => void) | null = null;
  private _tempVec: Vector3 = new Vector3(); // reusable temp vector to avoid per-frame allocations
  private _minimapRemotes: { x: number; z: number }[] = [];
  private _minimapNpcs: { x: number; z: number }[] = [];
  private _minimapRemotePositions: Map<number, MinimapEntityPoint> = new Map();
  private _minimapNpcPositions: Map<number, MinimapEntityPoint> = new Map();
  private _minimapObjects: { x: number; z: number; category: string }[] = [];
  private _minimapDrops: { x: number; z: number }[] = [];
  private _minimapMarkers: MinimapMarker[] = [];
  private _lastMinimapListRefreshMs: number = 0;
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
  private gearApplySeq: WeakMap<CharacterEntity | Npc3DEntity, Map<string, number>> = new WeakMap();
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
  private magicTargetId: number = -1;
  private autoCastSpellIndex: number = -1;
  private pendingSingleCastSpell: number = -1;
  private _combatPathTimer: number = 0;
  private localCombatWalkUntilMs: number = 0;

  // While a COMBAT_HIT splat is delayed to its impact moment, hold off any
  // health-bar updates for the same entity so the bar drops in sync with the
  // splat instead of leading it. Maps entityId → pending timeout handle.
  private pendingHealthApply: Map<number, ReturnType<typeof setTimeout>> = new Map();
  private lastSelfAuthorityAt: number = 0;
  private lastSelfAuthorityWarnAt: number = 0;
  private selfAuthorityGraceUntil: number = 0;
  private latestSelfSync: { x: number; z: number; moving: boolean } | null = null;
  private lastSelfSyncTickLow: number | null = null;
  private lastSelfSyncReceivedAt: number = 0;
  private bufferedSelfSyncReplayCount: number = 0;
  private lastNpcMaterializationRetryMs: number = 0;

  // Character creator
  private characterCreator: CharacterCreator | null = null;
  private characterCreatorOpenPending: boolean = false;
  private characterCreatorCanCancel: boolean = false;
  private localAppearance: PlayerAppearance | null = null;
  /** The server sends MAP_CHANGE as part of login/session placement. That
   *  first map load is not player-facing travel, so don't spam chat with
   *  "Entered Kcmap." on sign-in. Later transitions only announce dungeon
   *  exits back to the overworld. */
  private hasHandledInitialMapChange: boolean = false;
  private suppressNextMapEntryMessage: boolean = false;

  // Entity management (remote players, NPCs, ground items, sprites)
  private entities!: EntityManager;

  // World objects
  private worldObjectModels: Map<number, TransformNode> = new Map();
  private worldObjectIdByNode: WeakMap<TransformNode, number> = new WeakMap();
  private worldObjectPickState: WeakMap<TransformNode, { entityId: number; interactive: boolean }> = new WeakMap();
  private worldObjectDefs: Map<number, { defId: number; x: number; z: number; floor: number; y: number; depleted: boolean; interactionSides?: number; rotY?: number; openDirection?: -1 | 1; locked?: boolean; interactionTiles?: { x: number; z: number }[]; ladderActionMask?: number }> = new Map();
  private cropPickProxyBatches: Map<string, CropPickProxyBatch> = new Map();
  private cropPickProxyRefs: Map<number, CropPickProxyRef> = new Map();
  private worldObjectPickProxyBatch: WorldObjectPickProxyBatch | null = null;
  private worldObjectPickProxyRefs: Map<number, WorldObjectPickProxyRef> = new Map();
  private doorPivots: Map<number, DoorPivotEntry> = new Map();
  private doorPickProxies: Map<number, Mesh> = new Map();
  private doorTiles: Map<number, [number, number]> = new Map();
  /** Tiles blocked by non-depleted world objects (key = `${floor},${tileX},${tileZ}`) */
  private blockedObjectTiles: Set<string> = new Set();
  private closedCenteredDoorTileCounts: Map<string, number> = new Map();
  private closedCenteredDoorTileKeysByObjectId: Map<number, string> = new Map();
  private objectDefsCache: Map<number, WorldObjectDef> = new Map();
  private itemDefsCache: Map<number, ItemDef> = new Map();
  private npcDefsCache: Map<number, NpcDef> = new Map();
  private questDefsCache: Map<string, QuestDef> = new Map();
  /** Per-player quest state, populated on QUEST_STATE_SYNC at login and
   *  patched per QUEST_STAGE_ADVANCED delta. Mirrored into SidePanel's
   *  Quest Journal tab for rendering, and drives per-stage chat notifications. */
  private questState: Record<string, QuestState> = {};
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
  private hiddenRoofNodeSet: Set<TransformNode> = new Set();
  private hoverHiddenRoofNodes: TransformNode[] = [];
  private hoverHiddenRoofNodeSet: Set<TransformNode> = new Set();
  private _lastHoverRoofTileX: number = -9999;
  private _lastHoverRoofTileZ: number = -9999;
  private _lastHoverRevealTileX: number = -9999;
  private _lastHoverRevealTileZ: number = -9999;
  private _hoverRoofRevealGraceUntil: number = 0;
  private _lastRoofHoverClientX: number | null = null;
  private _lastRoofHoverClientY: number | null = null;
  private _lastRoofHoverRefreshAt: number = 0;
  private _lastIndoorTileX: number = -9999;
  private _lastIndoorTileZ: number = -9999;
  private _outdoorFrameCount: number = 0;
  private _lastBiomeCX: number = -9999;
  private _lastBiomeCZ: number = -9999;
  private _lastBiomeDef: BiomeDef | undefined = undefined;
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
  private mobileControlsEl: HTMLDivElement | null = null;
  private mobileStatusEl: HTMLDivElement | null = null;
  private mobileLogoutButton: HTMLButtonElement | null = null;
  private mobileAdminButton: HTMLButtonElement | null = null;
  private mobilePanelButtons: Partial<Record<MobilePanelMode, HTMLButtonElement>> = {};
  private pendingTouchInteraction: PendingTouchInteraction | null = null;
  private activeTouchPointers: Map<number, ActiveTouchPoint> = new Map();
  private pinchZoom: PinchZoomState | null = null;
  private isAdmin: boolean = false;
  private isModerator: boolean = false;
  private static readonly TOUCH_LONG_PRESS_MS = 450;
  private static readonly TOUCH_MOVE_CANCEL_PX = 12;
  private static readonly TOUCH_CAMERA_YAW_PER_PX = 0.008;
  private static readonly TOUCH_CAMERA_PITCH_PER_PX = 0.004;
  private static readonly TOUCH_PINCH_MIN_DISTANCE_PX = 24;
  private static readonly TOUCH_PINCH_MAX_STEP_FACTOR = 1.18;
  private static readonly WORLD_CONTEXT_MENU_DEDUPE_MS = 120;
  private static readonly WORLD_CONTEXT_MENU_DEDUPE_RADIUS_PX = 3;
  private static readonly BROWSER_PAGE_ZOOM_EPSILON = 0.01;
  private static readonly HEALTH_BAR_VISIBLE_MS = 4500;
  private static readonly LOCAL_DAMAGE_SYNC_GRACE_MS = 250;
  private static readonly HIT_SPLAT_ASSET_URLS = [
    '/sprites/effects/evil-hit-splash.svg',
    '/sprites/effects/evil-no-hit-splash.svg',
  ];
  private static hitSplatAssetsPreloaded = false;
  private mobileGoodMagicCurrent: number = 1;
  private mobileGoodMagicMax: number = 1;
  private mobileEvilMagicCurrent: number = 1;
  private mobileEvilMagicMax: number = 1;
  private gearDebugPanel: GearDebugPanel | null = null;
  private gearDebugTargetMode: 'player' | 'npc' = 'player';
  private gearDebugNpcTargetId: number = -1;
  private boneDebugPanel: BoneDebugPanel | null = null;
  private rotateDebugPanel: RotateDebugPanel | null = null;
  private shopPanel: ShopPanel | null = null;
  private dialoguePanel: DialoguePanel | null = null;
  private quantityInputPanel: QuantityInputPanel | null = null;
  private smithingPanel: SmithingPanel | null = null;
  private bankPanel: BankPanel | null = null;
  private tradePanel: TradePanel | null = null;
  private currentTradePartnerName: string = '';
  private duelPanel: DuelPanel | null = null;
  private currentDuelPartnerName: string = '';
  private currentDuelOpponentEntityId: number = -1;
  private duelActive = false;
  private adminPanel: AdminPanel | null = null;

  // Spell effect runtime. Catalogue is lazy-loaded from /api/spells on first /spell command.
  // spellsByIndex mirrors the server's alphabetical order so binary protocol
  // indices line up — DataLoader sorts by id at boot, /api/spells returns that
  // exact list, and we never reorder client-side.
  private spellEffectPlayer: SpellEffectPlayer | null = null;
  private spellsById: Map<string, SpellEffectDef> | null = null;
  private spellsByIndex: SpellEffectDef[] = [];
  private spellbookPanel: SpellbookPanel | null = null;
  private castingUntil = 0;
  private spellMovementLockedUntil = 0;
  private spellMovementUnlockOnSelfSync = false;

  // Combat hit splats (HTML overlay)
  private hitSplats: HitSplatOverlay[] = [];
  private xpDrops: XpDropOverlay[] = [];
  private xpDropRecentAmounts: number[] = [];
  private pendingXpDropAmount: number = 0;
  private pendingXpDropTimer: number | null = null;
  private transientHealthBars: Map<number, number> = new Map();
  private pendingLocalHealthSync: { health: number; maxHealth: number; timer: number } | null = null;
  private fpsCounterEl: HTMLDivElement | null = null;
  private fpsFrameCount: number = 0;
  private fpsLastSampleAt: number = 0;
  private fpsCounterUserToggled: boolean = false;
  private lowFpsDiagnosticWarmupUntil: number = 0;
  private lowFpsDiagnosticSampleStartedAt: number = 0;
  private lowFpsDiagnosticFrames: number = 0;
  private lowFpsDiagnosticSent: boolean = false;
  private lowFpsRendererWarningSent: boolean = false;
  private nativeContextMenuBlocker: ((event: MouseEvent) => void) | null = null;
  private lastWorldContextMenuEventAt: number = 0;
  private lastWorldContextMenuEventX: number = -9999;
  private lastWorldContextMenuEventY: number = -9999;

  // WASD camera
  private keysDown: Set<string> = new Set();

  private static preloadHitSplatAssets(): void {
    if (GameManager.hitSplatAssetsPreloaded) return;
    GameManager.hitSplatAssetsPreloaded = true;
    for (const url of GameManager.HIT_SPLAT_ASSET_URLS) {
      const img = new Image();
      img.src = url;
    }
  }

  constructor(
    canvas: HTMLCanvasElement,
    token: string,
    username: string,
    onDisconnect?: () => void,
  ) {
    window.gm = this;
    this.onFatalDisconnect = onDisconnect;
    this.gearOverridesReady = new Promise<void>((resolve) => { this.resolveGearOverridesReady = resolve; });
    this.token = token;
    this.username = username;
    this.engine = new Engine(canvas, false, { antialias: false, adaptToDeviceRatio: false });
    // RS-style chunky pixels: keep the CSS size stable but allow an explicit
    // low-quality framebuffer for players who need the fill-rate savings.
    this.baseHardwareScalingLevel = this.detectBaseHardwareScalingLevel();
    this.setRenderHardwareScalingLevel(this.baseHardwareScalingLevel, canvas);
    canvas.style.imageRendering = 'pixelated';
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true; // Match Three.js coordinate system (KC editor)
    this.scene.clearColor = new Color4(0, 0, 0, 1);
    this.arrowProjectiles = new ArrowProjectileManager(this.scene);
    GameManager.preloadHitSplatAssets();
    // Groups 1 (water) and 2 (texture planes) must NOT clear depth — they need terrain depth from group 0
    this.scene.setRenderingAutoClearDepthStencil(1, false, false, false);
    this.scene.setRenderingAutoClearDepthStencil(2, false, false, false);
    // Pointer-move hover uses explicit throttled picks; Babylon's automatic
    // pointer-move picking just adds a scene traversal on high-Hz mice.
    this.scene.skipPointerMovePicking = true;

    // Disable unused Babylon subsystems to skip per-frame checks.
    // particlesEnabled stays on — SpellEffectPlayer uses them for cast/trail/impact effects.
    this.scene.lensFlaresEnabled = false;
    this.scene.spritesEnabled = false;
    this.scene.proceduralTexturesEnabled = false;
    this.scene.physicsEnabled = false;
    this.scene.postProcessesEnabled = false;
    this.scene.probesEnabled = false;
    this.scene.audioEnabled = false;

    this.skybox = new GameSkybox(this.scene);

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
      if (e.button === 2 && !this.isTouchPointer(e)) {
        this.handleWorldContextMenuEvent(canvas, e, true);
        return;
      }
      if (e.button !== 0) return;
      this.lastClickX = e.clientX;
      this.lastClickY = e.clientY;

      if (this.isTouchPointer(e)) {
        this.trackTouchPointer(e);
        if (this.activeTouchPointers.size >= 2) {
          this.cancelPendingTouchInteraction();
          const pageZoomed = this.isBrowserPageZoomed();
          if (this.isAdmin && !pageZoomed) this.beginPinchZoom(canvas);
          e.stopImmediatePropagation();
          if (!pageZoomed) e.preventDefault();
          return;
        }

        this.cancelPendingTouchInteraction();
        if (!this.inputManager.isEnabled() || e.shiftKey) return;
        const options = this.getWorldInteractionOptionsAt(e.clientX, e.clientY);
        this.beginTouchInteraction(canvas, e, options);
        // Touch is resolved on pointerup so a finger drag can rotate the
        // camera without also issuing a move/interact command on touch down.
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
      }

      this.cancelPendingTouchInteraction();

      if (!this.inputManager.isEnabled() || e.shiftKey) return;
      const options = this.getWorldInteractionOptionsAt(e.clientX, e.clientY);
      const primaryOption = options.find(option => option.primary !== false);
      if (primaryOption) {
        this.runInteractionOption(primaryOption, e.clientX, e.clientY);
        // Suppress InputManager's object/ground handling for this event. The
        // first context option is the whole action, including its own walk-to
        // prediction when needed.
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);
    canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 2) return;
      this.handleWorldContextMenuEvent(canvas, e, true);
    }, true);
    canvas.addEventListener('pointermove', (e) => this.handlePendingTouchMove(e), true);
    canvas.addEventListener('pointerup', (e) => this.finishPendingTouchInteraction(e), true);
    canvas.addEventListener('pointercancel', (e) => this.cancelTouchPointer(e), true);
    canvas.addEventListener('lostpointercapture', (e) => this.cancelTouchPointer(e), true);

    // Hover tooltip — shows "Name (level-N)" when the cursor is over an NPC.
    this.setupNpcTooltip(canvas);

    // Right-click context menu for NPCs/items
    this.setupNativeContextMenuBlocker();
    this.setupContextMenu(canvas);

    // WASD keyboard controls
    this.setupKeyboard();

    // Visibility-change tracking for divergence-snap gating
    this.setupVisibilityHandler();
    this.setupActivityTracking();

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
    this.sidePanel.setAdminItemDeletionEnabled(this.isAdmin);
    this.sidePanel.setSpellCastCallback((spellIndex) => this.sidePanel!.setTargetingSpell(spellIndex));
    this.sidePanel.setAutocastChangeCallback((spellIndex) => this.handleAutocastChange(spellIndex));
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
    this.chatPanel.setPrivateSendHandler((to, msg) => {
      this.network.sendPrivateMessage(to, msg);
    });
    this.sidePanel.setPrivateMessageTargetCallback((username) => {
      this.chatPanel?.setPrivateTarget(username);
      this.setMobilePanelMode('chat');
    });
    this.quantityInputPanel = new QuantityInputPanel();
    const requestQuantity = (request: QuantityInputRequest) => this.quantityInputPanel?.show(request);
    this.sidePanel.setQuantityInputRequester(requestQuantity);
    this.shopPanel = new ShopPanel(this.network, this.itemDefsCache);
    this.shopPanel.setOnClose(() => {
      this.sidePanel?.setSellCallback(null);
    });
    this.dialoguePanel = new DialoguePanel(this.network, {
      showNpcBubble: (npcEntityId, message) => this.showNpcDialogueBubble(npcEntityId, message),
      hideNpcBubble: (npcEntityId) => this.hideNpcDialogueBubble(npcEntityId),
      showPlayerBubble: (message) => this.showLocalDialogueBubble(message),
    });
    this.smithingPanel = new SmithingPanel();
    this.bankPanel = new BankPanel(this.network, { requestQuantity });
    this.bankPanel.setAdminItemDeletionEnabled(this.isAdmin);
    this.tradePanel = new TradePanel(this.network, {
      onClose: () => this.sidePanel?.setTradeOfferCallback(null),
      requestQuantity,
    });
    this.duelPanel = new DuelPanel(this.network, {
      onClose: () => this.sidePanel?.setTradeOfferCallback(null),
    });
    // Quest journal is rendered inside SidePanel's existing Quests tab.
    // Push whatever defs already loaded; subsequent loads (and state deltas)
    // push from the raw-message dispatcher below.
    if (this.questDefsCache.size > 0) this.sidePanel?.setQuestDefs(this.questDefsCache);
    this.sidePanel?.setQuestState(this.questState);
    this.chatPanel.addSystemMessage(`Welcome to EvilQuest!`);
    this.chatPanel.addSystemMessage(`You last logged in from: ${window.location.hostname}`);
    this.setupMobileControls();

    // Chat message handler
    this.network.onChat((data) => {
      switch (data.type) {
        case 'player_info': {
          const entityId = data.entityId;
          const name = data.name;
          if (typeof entityId !== 'number' || typeof name !== 'string' || name.length === 0) break;
          this.entities.playerNames.set(entityId, name);
          this.entities.nameToEntityId.set(name.toLowerCase(), entityId);
          if (typeof data.isAdmin === 'boolean') {
            this.setRemotePlayerRole(entityId, data.isAdmin, data.isModerator === true);
          } else if (typeof data.isModerator === 'boolean') {
            this.setRemotePlayerRole(entityId, false, data.isModerator);
          }
          // If the remote 3D character was created with a fallback name
          // (chat 'player_info' arrived after PLAYER_SYNC), update its
          // label in place — re-creating the CharacterEntity to swap the
          // label is far too expensive.
          const existing = this.entities.remotePlayers.get(entityId);
          if (existing) existing.setLabel(name);
          break;
        }
        case 'local': {
          const from = typeof data.from === 'string' ? data.from : '';
          const message = typeof data.message === 'string' ? data.message : '';
          if (message.length === 0) break;
          if (this.chatPanel) {
            this.chatPanel.addMessage(from || '???', message, this.nameColorForMessage(from, data.isAdmin === true, data.isModerator === true));
          }
          this.showPlayerChatBubble(from, message);
          break;
        }
        case 'private':
          if (this.chatPanel && typeof data.from === 'string' && typeof data.message === 'string') {
            this.chatPanel.addPrivateMessage(`From ${data.from}`, data.message, data.from);
          }
          break;
        case 'private_sent':
          if (this.chatPanel && typeof data.to === 'string' && typeof data.message === 'string') {
            this.chatPanel.addPrivateMessage(`To ${data.to}`, data.message, data.to);
          }
          break;
        case 'social_list':
          if (Array.isArray(data.friends) && Array.isArray(data.ignore)) {
            this.sidePanel?.setSocialLists(data.friends, data.ignore);
          }
          break;
        case 'social_presence':
          if (typeof data.accountId === 'number' && typeof data.username === 'string' && typeof data.online === 'boolean') {
            this.sidePanel?.setSocialPresence(data.accountId, data.username, data.online);
          }
          break;
        case 'system': {
          const color = data.message.startsWith('Quest complete:') ? '#4aa3ff' : '#ff0';
          if (this.chatPanel) this.chatPanel.addSystemMessage(data.message, color);
          break;
        }
      }
    });

    // When a chunk's placed objects finish loading, link them to world entities.
    // Also force a re-eval of indoor state: if a roof / upper-floor chunk
    // streamed in *after* the player arrived at their current tile, the new
    // mesh wasn't in hiddenRoofNodes and renders un-hidden until the player
    // walks to a new tile. Resetting the indoor tile cursor makes the next
    // frame recompute the hidden set.
    this.chunkManager.setOnChunkObjectsLoaded((chunkKey) => {
      this.cleanupDisposedWorldObjects();
      this.linkPlacedObjectsToWorldObjectsForChunk(chunkKey);
      // Force the next frame to recompute hiddenRoofNodes — covers a roof's
      // chunk loading after the player has already settled on a tile.
      this._lastIndoorTileX = -9999;
      this._lastIndoorTileZ = -9999;
      // …and apply the hide synchronously RIGHT NOW so the streamed mesh
      // never renders even for a frame. Otherwise we'd see a brief flash of
      // the upper-floor surface before updateIndoorDetection runs next tick.
      if (this.isIndoors) this.recomputeHiddenRoofs();
      this.refreshHoverHiddenRoofs(true);
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
    const warmStartToken = this.token || localStorage.getItem('evilquest_token') || '';
    if (warmStartToken) {
      this.chunkManager.loadMap('kcmap').then(async () => {
        await this.loadBiomes('kcmap');
        this.applyFog();
        await this._defsReady;
        this.repositionWorldObjects();
      });
    }
    this._defsReady = this.loadObjectDefs();
    this.objectModels = new WorldObjectModels(this.scene, (x, z) => this.getHeight(x, z), this.objectDefsCache);
    this._objectModelsReady = this.objectModels.loadAll();
    this.entities = new EntityManager(
      this.scene,
      (x, z, floor = 0, cy) => this.getHeightAtFloor(x, z, floor, cy),
      this.itemDefsCache,
      this.npcDefsCache,
    );
    // Dev-only console hook for triage (NPC name overrides, entity sprites).
    // Tree-shaken Babylon imports remove the global namespace, so without
    // this the only way to inspect runtime entity state is to hack imports.
    if (import.meta.env.DEV) window._gameEntities = this.entities;

    // Pre-create the local player character at the kcmap default spawn so
    // the GLB + 10 animation GLBs start parsing during the loading screen,
    // not after LOGIN_OK. LOGIN_OK later snaps the position to the real
    // saved spawn (usually a few tiles away — chunks around the default
    // already cover it) and applies the saved appearance.
    this.playerX = 224.5;
    this.playerZ = 170.5;
    this.localPlayer = this.createLocalCharacterEntity();
    this.localPlayer.setPickable(false);
    this.localPlayer.setPositionXYZ(this.playerX, 0, this.playerZ);
    this.inputManager.setEnabled(false);

    // Remove a stale debug overlay from HMR/reconnect. It is opt-in via /fps.
    document.getElementById('fps-counter')?.remove();
    this.fpsLastSampleAt = performance.now();

    // Game loop
    let lastTime = performance.now();
    this.engine.runRenderLoop(() => {
      const now = performance.now();

      // Belt-and-suspenders resize: if the canvas CSS size drifted from the render
      // buffer size (e.g. ResizeObserver was throttled or the container reflowed
      // mid-frame), fix it here before rendering.
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const scale = Math.max(1, this.renderHardwareScalingLevel);
      const expectedW = Math.max(1, Math.round((canvas.clientWidth * dpr) / scale));
      const expectedH = Math.max(1, Math.round((canvas.clientHeight * dpr) / scale));
      if (canvas.width !== expectedW || canvas.height !== expectedH) {
        this.handleViewportResize();
      }

      const dt = Math.min((now - lastTime) / 1000, MAX_FRAME_DT_SECONDS);
      lastTime = now;
      this.update(dt);
      this.scene.render();

      this.updateFpsCounter(now);
      this.updateLowFpsDiagnostic(now);
    });

    // Resize on window changes AND on canvas-element changes (catches CSS grid reflows
    // like opening DevTools or panel toggles that don't fire a window.resize event).
    this.onWindowResize = () => this.handleViewportResize();
    window.addEventListener('resize', this.onWindowResize);
    window.addEventListener('evilquest:viewportchange', this.onWindowResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleViewportResize());
      this.resizeObserver.observe(canvas);
    }
    this.updateResponsiveCameraZoom();
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
    const objectsReady = this.waitWithTimeout(
      this._objectModelsReady,
      GameManager.PRELOAD_STEP_TIMEOUT_MS,
      'scenery preload',
    ).then(() => step('Loaded scenery models'));
    const chunksReady = this.waitWithTimeout(
      this.chunkManager.whenSpawnChunksReady(this.playerX, this.playerZ),
      GameManager.PRELOAD_STEP_TIMEOUT_MS,
      'map preload',
    ).then(() => step('Loaded map area'));

    return Promise.all([characterReady, objectsReady, chunksReady]).then(() => {});
  }

  private async waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T | undefined> {
    let timer: number | null = null;
    try {
      return await Promise.race<T | undefined>([
        promise,
        new Promise<undefined>((resolve) => {
          timer = window.setTimeout(() => {
            console.warn(`[loading] ${label} timed out after ${timeoutMs}ms; continuing`);
            resolve(undefined);
          }, timeoutMs);
        }),
      ]);
    } catch (err) {
      console.warn(`[loading] ${label} failed; continuing`, err);
      return undefined;
    } finally {
      if (timer !== null) window.clearTimeout(timer);
    }
  }

  private async waitForCurrentLocalPlayerReady(seq?: number): Promise<void> {
    while (!this.destroyed) {
      if (seq !== undefined && seq !== this._loginReadySeq) return;
      const player = this.localPlayer;
      if (!player) return;
      await player.whenReady();
      if (this.localPlayer === player) return;
    }
  }

  private noteLoginBootstrapPacket(kind: 'skills' | 'inventory' | 'equipment'): void {
    const pending = this._loginBootstrapPending;
    if (!pending) return;
    pending.delete(kind);
    const total = 3;
    const done = total - pending.size;
    this._loginProgress?.(0.82 + done * 0.04, `Loading character state (${done}/${total})`);
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
    await this.waitForCurrentLocalPlayerReady(seq);
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
      await this.waitWithTimeout(Promise.allSettled(gearLoads).then(() => {}), GameManager.LOGIN_READY_TIMEOUT_MS, 'login gear ready');
    }
    if (this._loginSettled || seq !== this._loginReadySeq || !this._loginOkResolver) return;
    if (this.localAppearance && this.localPlayer) this.localPlayer.applyAppearance(this.localAppearance);
    await this.waitForCurrentLocalPlayerReady(seq);

    // Let Babylon commit any meshes/materials applied by packet handlers
    // before the canvas is revealed.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (this._loginSettled || seq !== this._loginReadySeq || !this._loginOkResolver) return;

    this._loginProgress?.(1, 'Entering world');
    this.setRenderHardwareScalingLevel(this.baseHardwareScalingLevel);
    this.inputManager.setEnabled(true);
    this._loginSettled = true;
    this.lastSelfAuthorityAt = performance.now();
    this.lastSelfAuthorityWarnAt = 0;
    this.selfAuthorityGraceUntil = this.lastSelfAuthorityAt + GameManager.AUTHORITY_LOGIN_GRACE_MS;
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
      const parsed = normalizeAppearance(JSON.parse(raw) as Partial<PlayerAppearance>);
      return isValidAppearance(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Open the WebSocket and wait for the first LOGIN_OK to finish processing
   *  (real spawn position applied, saved appearance applied, input enabled).
   *  Use this after `whenPreloaded()` for a clean "click Login → world is
   *  immediately playable" handoff. */
  connectAndAuth(token: string, username: string, onProgress?: LoadingProgressCallback): Promise<void> {
    this.token = token;
    this.username = username;
    this.localAppearance = this.loadCachedAppearance(username);
    if (this.localAppearance) this.ensureLocalCharacterModel(this.localAppearance);
    return new Promise<void>((resolve) => {
      this._loginOkResolver = resolve;
      this._loginProgress = onProgress ?? null;
      this._loginBootstrapPending = new Set(['skills', 'inventory', 'equipment']);
      this._pendingLoginGearLoads = [];
      this._loginMapReady = new Promise<void>((mapResolve) => { this._resolveLoginMapReady = mapResolve; });
      this._loginSettled = false;
      this.lowFpsDiagnosticSent = false;
      this.lowFpsRendererWarningSent = false;
      this.resetLowFpsDiagnosticWindow();
      this._initialMapReadySent = false;
      this.suppressNextMapEntryMessage = false;
      this.lastSelfAuthorityAt = 0;
      this.lastSelfAuthorityWarnAt = 0;
      this.selfAuthorityGraceUntil = 0;
      this.latestSelfSync = null;
      this.lastSelfSyncTickLow = null;
      this.lastSelfSyncReceivedAt = 0;
      this.bufferedSelfSyncReplayCount = 0;
      this._loginReadySeq++;
      onProgress?.(0.02, 'Connecting to server');
      this.network.connect(token);
    });
  }

  private handleConnectionLost(event: CloseEvent): void {
    if (this.destroyed || this.reconnecting) return;
    console.warn(`[net] Connection lost (code=${event.code}, clean=${event.wasClean}, reason=${event.reason || 'none'})`);
    this.reportClientLog('game_connection_lost', {
      code: event.code,
      clean: event.wasClean,
      reason: event.reason || '',
      loginSettled: this._loginSettled,
      hasAuthority: this.lastSelfAuthorityAt !== 0,
      sinceAuthorityMs: this.lastSelfAuthorityAt === 0 ? -1 : Math.round(performance.now() - this.lastSelfAuthorityAt),
      connected: this.network.isConnected(),
    });
    if (this.isTerminalSessionClose(event)) {
      this.finishReconnectFailure();
      return;
    }
    void this.reconnectOrLogout();
  }

  private isTerminalSessionClose(event: CloseEvent): boolean {
    if (TERMINAL_CLOSE_REASONS.has(event.reason)) return true;
    return event.code === 4009;
  }

  private reportClientLog(event: string, details: Record<string, unknown>): void {
    try {
      const payload = JSON.stringify({
        event,
        username: this.username,
        details,
        at: Date.now(),
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/client-log', new Blob([payload], { type: 'application/json' }));
        return;
      }
      void fetch('/api/client-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
      });
    } catch { /* best-effort diagnostics only */ }
  }

  private getWebGlDiagnostics(): Record<string, unknown> {
    const canvas = this.engine.getRenderingCanvas();
    if (!canvas) return {};

    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return { context: 'unavailable' };

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const info: Record<string, unknown> = {
      context: gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl',
      contextAttributes: gl.getContextAttributes(),
      version: gl.getParameter(gl.VERSION),
      shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      vendor: gl.getParameter(gl.VENDOR),
      renderer: gl.getParameter(gl.RENDERER),
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
    };
    if (debugInfo) {
      info.unmaskedVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
      info.unmaskedRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
    }
    return info;
  }

  private getBrowserDiagnostics(): Record<string, unknown> {
    const nav = window.navigator as Navigator & {
      brave?: unknown;
      deviceMemory?: number;
      userAgentData?: {
        brands?: Array<{ brand: string; version: string }>;
        platform?: string;
        mobile?: boolean;
      };
    };
    return {
      userAgent: nav.userAgent,
      platform: nav.platform,
      userAgentData: nav.userAgentData ? {
        brands: nav.userAgentData.brands,
        platform: nav.userAgentData.platform,
        mobile: nav.userAgentData.mobile,
      } : null,
      brave: !!nav.brave,
      hardwareConcurrency: nav.hardwareConcurrency,
      deviceMemory: nav.deviceMemory ?? null,
      language: nav.language,
      languages: nav.languages,
      visibilityState: document.visibilityState,
      devicePixelRatio: window.devicePixelRatio,
      crossOriginIsolated: window.crossOriginIsolated,
      window: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
      },
      screen: window.screen ? {
        width: window.screen.width,
        height: window.screen.height,
        availWidth: window.screen.availWidth,
        availHeight: window.screen.availHeight,
        colorDepth: window.screen.colorDepth,
        pixelDepth: window.screen.pixelDepth,
      } : null,
    };
  }

  private getPerformanceDiagnosticFlags(
    webgl: Record<string, unknown>,
    browser: Record<string, unknown>,
    canvas: HTMLCanvasElement | null,
    measuredFps: number | null = null,
  ): string[] {
    const flags: string[] = [];
    const context = String(webgl.context ?? '');
    if (!context || context === 'unavailable') flags.push('webgl-unavailable');
    if (context === 'webgl') flags.push('webgl1-context');
    if (browser.brave === true) flags.push('brave-browser');
    if (!webgl.unmaskedRenderer) flags.push('renderer-info-masked');

    const softwareRenderer = isSoftwareWebGlRenderer(webgl);
    if (softwareRenderer) {
      flags.push('software-renderer-likely');
    }

    const dpr = window.devicePixelRatio || 1;
    if (canvas && dpr >= 1.5 && this.renderHardwareScalingLevel <= 1) {
      const renderPixels = canvas.width * canvas.height;
      const clientPixels = canvas.clientWidth * canvas.clientHeight;
      if (renderPixels > clientPixels * 1.4) flags.push('high-dpr-render-target');
    }

    if (measuredFps !== null && Number.isFinite(measuredFps) && measuredFps < LOW_FPS_DIAGNOSTIC_THRESHOLD) {
      flags.push('low-fps-measured');
      if (browser.brave === true) flags.push('brave-low-fps');
      if (!softwareRenderer && context && context !== 'unavailable') flags.push('low-fps-with-hardware-renderer');
      if (this.renderHardwareScalingLevel >= LOW_QUALITY_HARDWARE_SCALE - 0.01) flags.push('low-fps-after-render-scale');
      if (this.renderHardwareScalingLevel >= EMERGENCY_LOW_QUALITY_HARDWARE_SCALE - 0.01) flags.push('emergency-render-scale');
    }

    return flags;
  }

  private sampleRafFps(durationMs: number = 3000): Promise<FrameRateSample> {
    return new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        frames++;
        const now = performance.now();
        const elapsed = now - start;
        if (elapsed >= durationMs) {
          resolve({
            frames,
            durationMs: Math.round(elapsed),
            fps: frames / Math.max(0.001, elapsed / 1000),
          });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  private collectPerformanceSnapshot(sample?: FrameRateSample): Record<string, unknown> {
    const canvas = this.engine.getRenderingCanvas();
    const meshes = this.scene.meshes;
    const activeMeshes = this.scene.getActiveMeshes();
    const drawCalls = (this.engine as unknown as { _drawCalls?: { current?: number } })._drawCalls?.current ?? null;
    const vertexCount = meshes.reduce((sum, mesh) => sum + mesh.getTotalVertices(), 0);
    const indexCount = meshes.reduce((sum, mesh) => sum + mesh.getTotalIndices(), 0);
    const groundMeshes = meshes.filter(mesh => /^chunk_-?\d+_-?\d+$/.test(mesh.name));
    const grassMeshes = meshes.filter(mesh => /^chunk_grass_/.test(mesh.name) || mesh.name === 'terrain_grass_blades');
    const rockMeshes = meshes.filter(mesh => /^chunk_rocks_/.test(mesh.name));
    const detailMeshes = [...grassMeshes, ...rockMeshes];
    const countVertices = (items: typeof meshes): number => items.reduce((sum, mesh) => sum + mesh.getTotalVertices(), 0);
    const countIndices = (items: typeof meshes): number => items.reduce((sum, mesh) => sum + mesh.getTotalIndices(), 0);
    const thinInstanceCount = (mesh: (typeof meshes)[number]): number =>
      mesh instanceof Mesh ? Math.max(0, mesh.thinInstanceCount || 0) : 0;
    const effectiveInstanceMultiplier = (mesh: (typeof meshes)[number]): number => {
      const instances = thinInstanceCount(mesh);
      return instances > 0 ? instances : 1;
    };
    const countEffectiveVertices = (items: typeof meshes): number =>
      items.reduce((sum, mesh) => sum + mesh.getTotalVertices() * effectiveInstanceMultiplier(mesh), 0);
    const countEffectiveIndices = (items: typeof meshes): number =>
      items.reduce((sum, mesh) => sum + mesh.getTotalIndices() * effectiveInstanceMultiplier(mesh), 0);
    const countThinInstances = (items: typeof meshes): number =>
      items.reduce((sum, mesh) => sum + thinInstanceCount(mesh), 0);
    const browser = this.getBrowserDiagnostics();
    const webgl = this.getWebGlDiagnostics();
    const sceneBudget = buildSceneBudget(this.scene);

    return {
      measuredFps: sample ? Math.round(sample.fps * 10) / 10 : null,
      measuredFrames: sample?.frames ?? null,
      measuredDurationMs: sample?.durationMs ?? null,
      engineFps: Math.round(this.engine.getFps() * 10) / 10,
      drawCalls,
      activeMeshes: activeMeshes.length,
      totalMeshes: meshes.length,
      totalVertices: vertexCount,
      totalIndices: indexCount,
      proceduralTerrainDetail: true,
      renderScale: this.renderHardwareScalingLevel,
      baseRenderScale: this.baseHardwareScalingLevel,
      currentMap: this.chunkManager.getMapId(),
      currentFloor: this.currentFloor,
      player: {
        x: Math.round(this.playerX * 10) / 10,
        z: Math.round(this.playerZ * 10) / 10,
      },
      canvas: canvas ? {
        width: canvas.width,
        height: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        devicePixelRatio: window.devicePixelRatio,
        renderScale: canvas.dataset.renderScale,
      } : null,
      chunkMeshes: {
        ground: groundMeshes.length,
        detail: detailMeshes.length,
        grass: grassMeshes.length,
        rocks: rockMeshes.length,
        groundDetailAttributes: groundMeshes.filter(mesh => !!mesh.getVerticesData('groundDetail')).length,
        detailVertices: countEffectiveVertices(detailMeshes),
        detailIndices: countEffectiveIndices(detailMeshes),
        detailGeometryVertices: countVertices(detailMeshes),
        detailGeometryIndices: countIndices(detailMeshes),
        grassVertices: countEffectiveVertices(grassMeshes),
        grassIndices: countEffectiveIndices(grassMeshes),
        grassGeometryVertices: countVertices(grassMeshes),
        grassGeometryIndices: countIndices(grassMeshes),
        grassInstances: countThinInstances(grassMeshes),
        rockVertices: countVertices(rockMeshes),
        rockIndices: countIndices(rockMeshes),
      },
      sceneBudget,
      diagnosticFlags: this.getPerformanceDiagnosticFlags(webgl, browser, canvas, sample?.fps ?? null),
      browser,
      webgl,
    };
  }

  private setConnectionFrozen(frozen: boolean): void {
    this.connectionFrozen = frozen;
    this.inputManager.setEnabled(!frozen);
    if (frozen) {
      closeActiveContextMenu();
      this.hideContextMenu();
      this.clearPredictedPath();
      this.clearLocalNpcCombatState();
      this.clearDuelFaceTarget();
      this.duelActive = false;
      this.currentDuelOpponentEntityId = -1;
      this.isSkilling = false;
      this.skillingObjectId = -1;
      this.localPlayer?.stopWalking();
      this.localPlayer?.stopSkillAnimation();
      this.minimap?.clearDestination();
    }
  }

  private handleViewportResize(): void {
    this.engine.resize();
    this.updateResponsiveCameraZoom();
  }

  private detectBaseHardwareScalingLevel(): number {
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
    const quality = params.get('quality')?.toLowerCase();
    if (quality === 'high') return 1;
    if (quality === 'low') return LOW_QUALITY_HARDWARE_SCALE;

    try {
      if (localStorage.getItem(MANUAL_LOW_QUALITY_STORAGE_KEY) === '1') return LOW_QUALITY_HARDWARE_SCALE;
      if (localStorage.getItem(AUTO_LOW_QUALITY_STORAGE_KEY) === '1') return LOW_QUALITY_HARDWARE_SCALE;
    } catch {
      // Storage can be blocked in privacy modes; default to full quality.
    }
    if (isSoftwareWebGlRenderer(this.getWebGlDiagnostics())) return LOW_QUALITY_HARDWARE_SCALE;
    return 1;
  }

  private setRenderHardwareScalingLevel(level: number, canvas?: HTMLCanvasElement): void {
    const next = Math.max(1, level);
    if (Math.abs(next - this.renderHardwareScalingLevel) < 0.01) return;
    this.renderHardwareScalingLevel = next;
    this.engine.setHardwareScalingLevel(next);
    this.engine.resize();

    const targetCanvas = canvas ?? this.engine.getRenderingCanvas();
    if (targetCanvas) {
      targetCanvas.dataset.renderScale = next.toFixed(2);
    }
  }

  private setLowQualityPreference(enabled: boolean): void {
    try {
      if (enabled) {
        localStorage.setItem(MANUAL_LOW_QUALITY_STORAGE_KEY, '1');
        localStorage.removeItem(AUTO_LOW_QUALITY_STORAGE_KEY);
      } else {
        localStorage.removeItem(MANUAL_LOW_QUALITY_STORAGE_KEY);
        localStorage.removeItem(AUTO_LOW_QUALITY_STORAGE_KEY);
      }
    } catch {
      // Storage can be blocked in privacy modes; the current session still changes.
    }
  }

  private hasExplicitRenderQualityOverride(): boolean {
    try {
      return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('quality');
    } catch {
      return false;
    }
  }

  private rememberAdaptiveLowQualityPreference(): void {
    if (this.hasExplicitRenderQualityOverride()) return;
    try {
      if (localStorage.getItem(MANUAL_LOW_QUALITY_STORAGE_KEY) !== '1') {
        localStorage.setItem(AUTO_LOW_QUALITY_STORAGE_KEY, '1');
      }
    } catch {
      // Best effort only; current-session scaling was already applied.
    }
  }

  private reportRenderQualityChange(requestedQuality: string): void {
    const canvas = this.engine.getRenderingCanvas();
    const browser = this.getBrowserDiagnostics();
    const webgl = this.getWebGlDiagnostics();
    this.reportClientLog('client_quality_change', {
      requestedQuality,
      renderScale: this.renderHardwareScalingLevel,
      baseRenderScale: this.baseHardwareScalingLevel,
      canvas: canvas ? {
        width: canvas.width,
        height: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        devicePixelRatio: window.devicePixelRatio,
        renderScale: canvas.dataset.renderScale,
      } : null,
      diagnosticFlags: this.getPerformanceDiagnosticFlags(webgl, browser, canvas),
      browser,
      webgl,
    });
  }

  private handleQualityCommand(msg: string): void {
    const parts = msg.trim().split(/\s+/);
    const requestedQuality = parts[1]?.toLowerCase();
    if (parts.length !== 2 || !requestedQuality || !['low', 'high', 'auto'].includes(requestedQuality)) {
      this.chatPanel?.addSystemMessage(`Render quality: scale ${this.renderHardwareScalingLevel.toFixed(1)}. Usage: /quality low, /quality high, or /quality auto.`);
      return;
    }

    let nextScale = 1;
    if (requestedQuality === 'low') {
      this.setLowQualityPreference(true);
      nextScale = LOW_QUALITY_HARDWARE_SCALE;
    } else if (requestedQuality === 'high') {
      this.setLowQualityPreference(false);
      nextScale = 1;
    } else {
      this.setLowQualityPreference(false);
      nextScale = this.detectBaseHardwareScalingLevel();
    }

    this.baseHardwareScalingLevel = nextScale;
    this.setRenderHardwareScalingLevel(nextScale);
    this.chatPanel?.addSystemMessage(`Render quality set to ${requestedQuality} (scale ${this.renderHardwareScalingLevel.toFixed(1)}).`);
    this.reportRenderQualityChange(requestedQuality);
  }

  private maybeApplyLowFpsRenderScale(fps: number): number | null {
    let nextScale: number | null = null;
    let message = 'Low FPS detected; lowering render resolution.';
    if (this.renderHardwareScalingLevel < LOW_QUALITY_HARDWARE_SCALE - 0.01) {
      nextScale = LOW_QUALITY_HARDWARE_SCALE;
    } else if (
      fps < LOW_FPS_EXTRA_SCALE_THRESHOLD &&
      this.renderHardwareScalingLevel < EMERGENCY_LOW_QUALITY_HARDWARE_SCALE - 0.01
    ) {
      nextScale = EMERGENCY_LOW_QUALITY_HARDWARE_SCALE;
      message = 'FPS still low; lowering render resolution further.';
    }
    if (nextScale === null) return null;

    this.setRenderHardwareScalingLevel(nextScale);
    if (nextScale >= LOW_QUALITY_HARDWARE_SCALE - 0.01) this.rememberAdaptiveLowQualityPreference();
    this.chatPanel?.addSystemMessage(message, '#ffb347');
    return this.renderHardwareScalingLevel;
  }

  private setFpsCounterVisible(visible: boolean, announce: boolean = false): void {
    if (!visible) {
      if (!this.fpsCounterEl) return;
      this.fpsCounterEl.remove();
      this.fpsCounterEl = null;
      this.fpsFrameCount = 0;
      this.fpsLastSampleAt = performance.now();
      if (announce) this.chatPanel?.addSystemMessage('FPS counter disabled.');
      return;
    }

    if (this.fpsCounterEl) return;

    document.getElementById('fps-counter')?.remove();
    const el = document.createElement('div');
    el.id = 'fps-counter';
    el.style.cssText = 'position:absolute;top:6px;right:calc(var(--right-rail-width, 300px) + 10px);color:#0f0;font:bold 14px Arial, Helvetica, sans-serif;z-index:9999;text-shadow:1px 1px 0 #000;pointer-events:none;text-align:right';
    el.textContent = 'FPS';
    (document.getElementById('game-frame') ?? document.body).appendChild(el);
    this.fpsCounterEl = el;
    this.fpsFrameCount = 0;
    this.fpsLastSampleAt = performance.now();
    if (announce) this.chatPanel?.addSystemMessage('FPS counter enabled.');
  }

  private toggleFpsCounter(): void {
    this.fpsCounterUserToggled = true;
    this.setFpsCounterVisible(!this.fpsCounterEl, true);
  }

  private isGameFrameVisible(): boolean {
    const frame = document.getElementById('game-frame') as HTMLElement | null;
    return !!frame && frame.style.display !== 'none' && frame.style.visibility !== 'hidden';
  }

  private resetLowFpsDiagnosticWindow(): void {
    this.lowFpsDiagnosticWarmupUntil = 0;
    this.lowFpsDiagnosticSampleStartedAt = 0;
    this.lowFpsDiagnosticFrames = 0;
  }

  private shouldCapturePerformanceDiagnostic(): boolean {
    return !this.destroyed
      && document.visibilityState === 'visible'
      && this._loginSettled
      && this.localPlayerId > 0
      && this.network.isConnected()
      && !this.reconnecting
      && !this.connectionFrozen
      && this.isGameFrameVisible();
  }

  private shouldRunLowFpsDiagnostic(): boolean {
    return !this.lowFpsDiagnosticSent
      && this.shouldCapturePerformanceDiagnostic();
  }

  private rendererWarningForDiagnosticFlags(diagnosticFlags: readonly string[]): string | null {
    if (diagnosticFlags.includes('software-renderer-likely')) {
      return 'Renderer warning: WebGL is using software rendering (SwiftShader/CPU). Enable browser hardware acceleration and check GPU blocklist settings.';
    }
    if (diagnosticFlags.includes('brave-low-fps')) {
      return 'Brave warning: FPS is low on a hardware renderer. Check Brave hardware acceleration, ANGLE/GPU settings, or compare Chrome.';
    }
    if (diagnosticFlags.includes('low-fps-with-hardware-renderer')) {
      return 'Renderer warning: FPS is low on an apparently hardware-backed renderer. Try /quality low and send the perf snapshot.';
    }
    return null;
  }

  private maybeShowLowFpsRendererWarning(snapshot: Record<string, unknown>): void {
    if (this.lowFpsRendererWarningSent) return;
    const diagnosticFlags = Array.isArray(snapshot.diagnosticFlags) ? snapshot.diagnosticFlags.map(String) : [];
    const warning = this.rendererWarningForDiagnosticFlags(diagnosticFlags);
    if (!warning) return;
    this.lowFpsRendererWarningSent = true;
    this.chatPanel?.addSystemMessage(warning, '#ffb347');
  }

  private schedulePostScaleLowFpsSnapshot(): void {
    window.setTimeout(async () => {
      if (!this.shouldCapturePerformanceDiagnostic()) return;
      const sample = await this.sampleRafFps(3000);
      const snapshot = this.collectPerformanceSnapshot(sample);
      snapshot.lowFpsAction = 'post-lowered-render-resolution';
      this.maybeShowLowFpsRendererWarning(snapshot);
      const appliedRenderScale = this.maybeApplyLowFpsRenderScale(sample.fps);
      if (appliedRenderScale !== null) {
        snapshot.lowFpsAction = 'post-lowered-render-resolution-again';
        snapshot.appliedRenderScale = appliedRenderScale;
        this.schedulePostScaleLowFpsSnapshot();
      }
      this.reportClientLog('client_low_fps_post_scale_snapshot', snapshot);
    }, 1000);
  }

  private updateLowFpsDiagnostic(now: number): void {
    if (!this.shouldRunLowFpsDiagnostic()) {
      this.resetLowFpsDiagnosticWindow();
      return;
    }

    if (this.lowFpsDiagnosticWarmupUntil === 0) {
      this.lowFpsDiagnosticWarmupUntil = now + LOW_FPS_DIAGNOSTIC_WARMUP_MS;
      return;
    }
    if (now < this.lowFpsDiagnosticWarmupUntil) return;

    if (this.lowFpsDiagnosticSampleStartedAt === 0) {
      this.lowFpsDiagnosticSampleStartedAt = now;
      this.lowFpsDiagnosticFrames = 0;
      return;
    }

    this.lowFpsDiagnosticFrames++;
    const elapsed = now - this.lowFpsDiagnosticSampleStartedAt;
    if (elapsed < LOW_FPS_DIAGNOSTIC_SAMPLE_MS) return;

    const fps = this.lowFpsDiagnosticFrames / Math.max(0.001, elapsed / 1000);
    if (fps < LOW_FPS_DIAGNOSTIC_THRESHOLD && this.scene.getActiveMeshes().length > 100) {
      this.lowFpsDiagnosticSent = true;
      const snapshot = this.collectPerformanceSnapshot({
        frames: this.lowFpsDiagnosticFrames,
        durationMs: Math.round(elapsed),
        fps,
      });
      this.maybeShowLowFpsRendererWarning(snapshot);
      const appliedRenderScale = this.maybeApplyLowFpsRenderScale(fps);
      if (appliedRenderScale !== null) {
        snapshot.lowFpsAction = 'lowered-render-resolution';
        snapshot.appliedRenderScale = appliedRenderScale;
        this.schedulePostScaleLowFpsSnapshot();
      }
      this.reportClientLog('client_low_fps_snapshot', snapshot);
      return;
    }

    this.lowFpsDiagnosticSampleStartedAt = now;
    this.lowFpsDiagnosticFrames = 0;
  }

  private updateFpsCounter(now: number): void {
    if (!this.fpsCounterEl) return;
    this.fpsFrameCount++;
    if (now - this.fpsLastSampleAt < 1000) return;
    const fps = Math.round(this.engine.getFps());
    const scale = this.renderHardwareScalingLevel.toFixed(1);
    this.fpsCounterEl.textContent = `${this.fpsFrameCount} FPS (${fps}) | ${this.scene.getActiveMeshes().length} meshes | scale ${scale}`;
    this.fpsFrameCount = 0;
    this.fpsLastSampleAt = now;
  }

  private async handlePerfCommand(): Promise<void> {
    this.chatPanel?.addSystemMessage('Measuring client performance for 3 seconds...');
    const sample = await this.sampleRafFps(3000);
    const snapshot = this.collectPerformanceSnapshot(sample);
    this.reportClientLog('client_perf_snapshot', snapshot);

    const webgl = snapshot.webgl as Record<string, unknown> | undefined;
    const renderer = String(webgl?.unmaskedRenderer ?? webgl?.renderer ?? 'unknown');
    const clippedRenderer = renderer.length > 80 ? `${renderer.slice(0, 77)}...` : renderer;
    const meshes = Number(snapshot.activeMeshes ?? 0);
    const vertices = Number(snapshot.totalVertices ?? 0);
    const diagnosticFlags = Array.isArray(snapshot.diagnosticFlags) ? snapshot.diagnosticFlags.map(String) : [];
    const renderScale = Number(snapshot.renderScale ?? 1);
    const canvas = snapshot.canvas as { width?: unknown; height?: unknown; clientWidth?: unknown; clientHeight?: unknown } | null | undefined;
    const canvasText = canvas
      ? `${Number(canvas.width ?? 0)}x${Number(canvas.height ?? 0)}/${Number(canvas.clientWidth ?? 0)}x${Number(canvas.clientHeight ?? 0)}`
      : 'unknown';
    this.chatPanel?.addSystemMessage(
      `Perf: ${sample.fps.toFixed(1)} FPS, scale ${renderScale.toFixed(1)}, ${meshes} active meshes, ${Math.round(vertices / 1000)}k vertices, canvas ${canvasText}. Renderer: ${clippedRenderer}`,
    );
    if (diagnosticFlags.length > 0) {
      this.chatPanel?.addSystemMessage(`Perf flags: ${diagnosticFlags.join(', ')}`);
    }
    const rendererWarning = this.rendererWarningForDiagnosticFlags(diagnosticFlags);
    if (rendererWarning) this.chatPanel?.addSystemMessage(rendererWarning, '#ffb347');
    this.chatPanel?.addSystemMessage('Perf snapshot sent to the server log.');

    try {
      await navigator.clipboard?.writeText(JSON.stringify(snapshot, null, 2));
      this.chatPanel?.addSystemMessage('Perf snapshot copied to clipboard.');
    } catch {
      // Clipboard write requires focus/permission in some browsers; server log is enough.
    }
  }

  private updateResponsiveCameraZoom(): void {
    const canvas = this.engine.getRenderingCanvas();
    const isMobileLandscape = window.matchMedia?.(GameManager.MOBILE_LANDSCAPE_CAMERA_QUERY).matches ?? false;
    let radiusScale = 1;

    if (isMobileLandscape && canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      const aspect = canvas.clientWidth / canvas.clientHeight;
      if (aspect > GameManager.DESKTOP_CAMERA_ASPECT_CAP) {
        radiusScale = GameManager.DESKTOP_CAMERA_ASPECT_CAP / aspect;
      }
    }

    this.camera.setLockedRadiusScale(radiusScale);
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
      this.lowFpsDiagnosticSent = false;
      this.lowFpsRendererWarningSent = false;
      this.resetLowFpsDiagnosticWindow();
      this._initialMapReadySent = false;
      this.suppressNextMapEntryMessage = true;
      this.lastSelfAuthorityAt = 0;
      this.lastSelfAuthorityWarnAt = 0;
      this.selfAuthorityGraceUntil = 0;
      this.latestSelfSync = null;
      this.lastSelfSyncTickLow = null;
      this.lastSelfSyncReceivedAt = 0;
      this.bufferedSelfSyncReplayCount = 0;
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

    const token = this.token || localStorage.getItem('evilquest_token') || '';
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
    this.fpsCounterEl?.remove();
    this.fpsCounterEl = null;
    this.network.close();
    this.onFatalDisconnect?.();
  }

  /** Height query for the local player. Uses local player Y as gate input. */
  private getHeight(x: number, z: number): number {
    const computed = this.chunkManager.getEffectiveHeight(x, z, undefined, this.localPlayer?.position.y);
    const override = this.localTeleportHeightOverride;
    if (!override) return computed;

    const tileX = Math.floor(x);
    const tileZ = Math.floor(z);
    if (tileX !== override.tileX || tileZ !== override.tileZ || performance.now() > override.expiresAt) {
      this.localTeleportHeightOverride = null;
      return computed;
    }

    if (Math.abs(computed - override.y) <= 0.75) {
      this.localTeleportHeightOverride = null;
      return computed;
    }
    return override.y;
  }

  private getHeightAtFloor(x: number, z: number, floor: number, currentY?: number): number {
    return this.chunkManager.getEffectiveHeight(x, z, floor, currentY);
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
    this.skybox.setConfig(this.skyboxConfigFor(meta));
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
    let res: Response;
    try {
      const token = this.token || localStorage.getItem('evilquest_token') || '';
      res = await fetch(`/maps/${mapId}/biomes.json`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        credentials: 'same-origin',
      });
    } catch {
      // No biomes.json → use map meta fog only
      return;
    }
    assertOptionalMapResourceResponse(res, `${mapId}/biomes.json`);
    if (!res.ok) return;
    try {
      const file: BiomesFile = await res.json();
      this.biomesFile = file;
      for (const def of file.defs) this.biomeById.set(def.id, def);
    } catch {
      // Malformed biomes.json → use map meta fog only
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
    this.skybox.setConfig(this.skyboxConfigFor(meta, this._lastBiomeDef));
  }

  private skyboxConfigFor(meta: { skybox?: SkyboxConfig; mapType?: string; dungeon?: boolean }, biome?: BiomeDef): SkyboxConfig {
    if (biome?.skybox) return biome.skybox;
    if (meta.skybox) return meta.skybox;
    return meta.mapType === 'dungeon' || meta.dungeon ? DEFAULT_DUNGEON_SKYBOX_CONFIG : DEFAULT_SKYBOX_CONFIG;
  }

  private async loadObjectDefs(): Promise<void> {
    // All four def files are independent — fetch them in parallel.
    // Previously these were four serial awaits, which on a cold start added
    // up to ~200–400ms of dead time over the lifetime of the constructor.
    const authHeaders = this.authHeaders();
    const dataFetchOptions: RequestInit = {
      headers: authHeaders,
      credentials: 'same-origin',
      cache: 'reload',
    };
    const [objectsRes, itemsRes, npcsRes, gearRes, questsRes] = await Promise.all([
      fetch('/data/objects.json', dataFetchOptions).catch((e) => { console.warn('Failed to load object definitions:', e); return null; }),
      fetch('/data/items.json', dataFetchOptions).catch((e) => { console.warn('Failed to load item definitions:', e); return null; }),
      fetch('/data/npcs.json', dataFetchOptions).catch((e) => { console.warn('Failed to load NPC definitions:', e); return null; }),
      fetch('/data/gear-overrides.json', dataFetchOptions).catch((e) => { console.warn('Failed to load gear overrides:', e); return null; }),
      fetch('/data/quests.json', dataFetchOptions).catch(() => null),
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
        const defs: ItemDef[] = withGeneratedBankNotes(await itemsRes.json());
        for (const def of defs) this.itemDefsCache.set(def.id, def);
        setThumbnailItemCatalog(defs);
        if (this.sidePanel) this.sidePanel.setItemDefs(this.itemDefsCache);
        if (this.bankPanel) this.bankPanel.setItemDefs(this.itemDefsCache);
        if (this.tradePanel) this.tradePanel.setItemDefs(this.itemDefsCache);
        if (this.duelPanel) this.duelPanel.setItemDefs(this.itemDefsCache);
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
        if (import.meta.env.DEV) console.log(`[Gear] Loaded ${this.gearOverrides.size} gear overrides`);
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
    this.closedCenteredDoorTileCounts.clear();
    this.closedCenteredDoorTileKeysByObjectId.clear();
    for (const [objectEntityId, data] of this.worldObjectDefs) {
      const def = this.objectDefsCache.get(data.defId);
      // Depleted ores/stumps stay blocking — they still physically occupy
      // the tile. setObjectTilesBlocked is a no-op for doors.
      if (def?.category === 'door') {
        this.setCenteredDoorTileBlocked(objectEntityId, data, def, !data.depleted);
      } else if (def?.blocking) {
        this.setObjectTilesBlocked(data.x, data.z, def, true, data.floor, data.interactionTiles, data.rotY);
      }
    }
  }

  private blockedObjectKey(floor: number, tileX: number, tileZ: number): string {
    return `${Math.floor(floor)},${Math.floor(tileX)},${Math.floor(tileZ)}`;
  }

  private setObjectTilesBlocked(
    x: number,
    z: number,
    def: WorldObjectDef,
    blocked: boolean,
    floor: number = 0,
    interactionTiles?: ReadonlyArray<{ x: number; z: number }>,
    rotY: number = 0,
  ): void {
    if (!def.blocking || def.category === 'door' || usesMapAuthoredObjectCollision(def)) return;
    let interactionTileKeys: Set<string> | null = null;
    if (interactionTiles?.length) {
      interactionTileKeys = new Set();
      for (const tile of interactionTiles) {
        interactionTileKeys.add(this.blockedObjectKey(floor, tile.x, tile.z));
      }
    }
    for (const tile of getObjectFootprintTiles(x, z, def, rotY)) {
      const key = this.blockedObjectKey(floor, tile.x, tile.z);
      if (interactionTileKeys?.has(key)) continue;
      if (blocked) this.blockedObjectTiles.add(key);
      else this.blockedObjectTiles.delete(key);
    }
  }

  private centeredDoorTileKeyForObject(
    data: { x: number; z: number; floor: number; rotY?: number },
    def: WorldObjectDef,
  ): string | null {
    if (def.category !== 'door') return null;
    const tile = centeredDoorTileFromPlacement(data.x, data.z, data.rotY ?? 0);
    if (!tile) return null;
    return this.blockedObjectKey(data.floor ?? 0, tile[0], tile[1]);
  }

  private isCenteredDoorTileBlockedKey(key: string): boolean {
    return (this.closedCenteredDoorTileCounts.get(key) ?? 0) > 0;
  }

  private removeCenteredDoorTileBlockForObject(objectEntityId: number): void {
    const key = this.closedCenteredDoorTileKeysByObjectId.get(objectEntityId);
    if (!key) return;
    const nextCount = (this.closedCenteredDoorTileCounts.get(key) ?? 0) - 1;
    if (nextCount > 0) this.closedCenteredDoorTileCounts.set(key, nextCount);
    else this.closedCenteredDoorTileCounts.delete(key);
    this.closedCenteredDoorTileKeysByObjectId.delete(objectEntityId);
  }

  private setCenteredDoorTileBlocked(
    objectEntityId: number,
    data: { x: number; z: number; floor: number; rotY?: number },
    def: WorldObjectDef,
    blocked: boolean,
  ): void {
    const nextKey = blocked ? this.centeredDoorTileKeyForObject(data, def) : null;
    const currentKey = this.closedCenteredDoorTileKeysByObjectId.get(objectEntityId);
    if (currentKey && currentKey !== nextKey) this.removeCenteredDoorTileBlockForObject(objectEntityId);
    if (!nextKey || currentKey === nextKey) return;
    this.closedCenteredDoorTileCounts.set(nextKey, (this.closedCenteredDoorTileCounts.get(nextKey) ?? 0) + 1);
    this.closedCenteredDoorTileKeysByObjectId.set(objectEntityId, nextKey);
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
  private static readonly RANGED_PROJECTILE_RELEASE_FRACTION = 0.42;

  private static readonly TWO_HANDED_WEAPON_RE = /\b(?:2h|2-handed|two-handed)\b/i;

  private getWeaponAnimationFamily(weaponDef: ItemDef | undefined): 'ranged' | 'twoHanded' | 'scimitar' | 'sword' | 'dagger' | 'other' {
    const style = weaponDef?.weaponStyle;
    if (style === 'bow' || style === 'crossbow') return 'ranged';
    const name = weaponDef?.name ?? '';
    if (weaponDef?.twoHanded || GameManager.TWO_HANDED_WEAPON_RE.test(name)) return 'twoHanded';
    if (/scimitar/i.test(name)) return 'scimitar';
    if (/dagger/i.test(name)) return 'dagger';
    if (/sword/i.test(name)) return 'sword';
    return 'other';
  }

  /**
   * Choose the correct attack animation name based on stance and weapon.
   * - Scimitar (any stance)        → 'attack_1h_slash'
   * - 2H weapon                    → stance-specific 2H slash/smash
   * - Sword + aggressive           → 'attack_1h_slash'
   * - Sword + other stance         → 'stab'
   * - Dagger (any stance)          → 'stab'
   * - Other 1H weapon              → 'attack_slash'
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
    } else if (this.entities.npcSprites.get(attackerId) instanceof CharacterEntity) {
      // Forced per-spawn anim wins over the weapon picker — editor lets map
      // authors give a Custom Humanoid a specific swing regardless of gear.
      const forced = this.entities.npcAttackAnimOverrides.get(attackerId);
      if (forced) return forced;
      // Customizable NPC rendered as CharacterEntity. Slot 0 = weapon, same
      // layout as PLAYER_REMOTE_EQUIPMENT. NPCs don't carry a stance, so the
      // weapon-style picker runs against the default 'accurate' branch.
      const eq = this.entities.npcEquipment.get(attackerId);
      weaponId = eq?.[0] ?? 0;
    } else {
      // Sprite/3D-mob NPC or unknown attacker — sprite NPCs play their own
      // attack track via Npc3DEntity.playAttackAnimation. The string we
      // return here is only consumed by CharacterEntity, so the value for
      // these branches is moot — keep the unarmed punch default.
      return 'attack_punch';
    }
    if (weaponId > 0) {
      const weaponDef = this.itemDefsCache.get(weaponId);
      switch (this.getWeaponAnimationFamily(weaponDef)) {
        case 'ranged': return 'bow_attack';
        case 'twoHanded': return stance === 'aggressive' ? 'attack_2h_smash' : 'attack_2h_slash';
        case 'scimitar': return 'attack_1h_slash';
        case 'sword': return stance === 'aggressive' ? 'attack_1h_slash' : 'stab';
        case 'dagger': return 'stab';
        case 'other': return 'attack_slash';
      }
    }
    if (stance === 'aggressive') return 'kick';
    return 'attack_punch';
  }

  private getAttackAnimationDurationMs(attacker: Targetable | null | undefined, animName: string): number {
    const liveDuration = asAttackAnimationHost(attacker)?.getAnimationDurationMs?.(animName) ?? 0;
    return liveDuration > 0 ? liveDuration : 1200;
  }

  private getAttackFaceLockDurationMs(attacker: Targetable | null | undefined, animName: string): number {
    const durationMs = this.getAttackAnimationDurationMs(attacker, animName);
    const fraction = animName === 'bow_attack'
      ? GameManager.RANGED_PROJECTILE_RELEASE_FRACTION + 0.03
      : 0.45;
    return Math.max(260, Math.min(540, durationMs * fraction));
  }

  private lockCharacterAttackFacing(attacker: CharacterEntity | null | undefined, targetId: number, animName: string): void {
    if (!attacker || targetId <= 0) return;
    const target = this.resolveTargetableIncludingLocal(targetId);
    if (!target) return;
    const anchor = target.getTargetAnchor();
    attacker.lockAttackFaceTowardXZ(
      anchor.x,
      anchor.z,
      this.getAttackFaceLockDurationMs(attacker, animName),
    );
  }

  private getRangedProjectileReleaseMs(attacker: Targetable | null | undefined): number {
    return this.getAttackAnimationDurationMs(attacker, 'bow_attack') * GameManager.RANGED_PROJECTILE_RELEASE_FRACTION;
  }

  private getProjectileLaunchPreview(attacker: Targetable): Vector3 {
    const withOrigin = attacker as Targetable & { getCastOrigin?: () => Vector3 };
    if (typeof withOrigin.getCastOrigin === 'function') return withOrigin.getCastOrigin();
    const anchor = attacker.getTargetAnchor();
    return new Vector3(anchor.x, anchor.y + 0.15, anchor.z);
  }

  private getRangedProjectileImpactMs(attacker: Targetable, target: Targetable): number {
    const from = this.getProjectileLaunchPreview(attacker);
    const to = target.getTargetAnchor();
    return this.getRangedProjectileReleaseMs(attacker) + arrowProjectileTravelMs(from, to);
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
      this.restoreSkillingTool(entityId, remote);
      // Idle + targetId is the "face this object without animating" primitive,
      // used for crops which pick instantly with no skill cycle.
      if (targetId > 0) {
        const objectData = this.worldObjectDefs.get(targetId);
        if (objectData) {
          this.entities.remoteCombatTargets.delete(entityId);
          remote.faceTowardXZ(objectData.x, objectData.z);
        } else {
          const target = this.resolveTargetableIncludingLocal(targetId);
          if (target) remote.faceToward(target.getTargetAnchor());
          this.entities.remoteCombatTargets.set(entityId, targetId);
        }
      } else {
        this.entities.remoteCombatTargets.delete(entityId);
        remote.clearFaceLock();
      }
      return;
    }

    if (kind === PlayerAnimationKind.Skill) {
      const objectData = this.worldObjectDefs.get(targetId);
      if (objectData) {
        remote.faceToward(new Vector3(objectData.x, 0, objectData.z));
      } else if (targetId > 0) {
        const target = this.resolveTargetableIncludingLocal(targetId);
        if (target) remote.faceToward(target.getTargetAnchor());
      }
      // Magic is a one-shot cast (single-tick obelisk offering); other skill
      // variants loop until the server sends Idle.
      if (variant === PlayerSkillAnimationVariant.Magic) {
        remote.playNamedOneShot('spell_cast_2h', { layerWhenWalking: true });
        return;
      }
      const anim =
        variant === PlayerSkillAnimationVariant.Chop ? 'chop' :
        variant === PlayerSkillAnimationVariant.Mine ? 'mine' :
        undefined;
      void (async () => {
        if (toolItemId > 0) await this.applySkillingTool(entityId, remote, toolItemId);
        if (this.entities.remotePlayers.get(entityId) !== remote) return;
        const latest = this.remoteAnimationStates.get(entityId);
        if (!latest
          || latest.kind !== kind
          || latest.variant !== variant
          || latest.targetId !== targetId
          || latest.toolItemId !== toolItemId
        ) return;
        remote.startSkillAnimation(anim);
      })();
      return;
    }

    if (kind === PlayerAnimationKind.Attack) {
      const animName = this.getPlayerAttackAnimName(entityId);
      this.lockCharacterAttackFacing(remote, targetId, animName);
      remote.playAttackAnimation(animName);
      if (targetId > 0) {
        this.entities.remoteCombatTargets.set(entityId, targetId);
      }
    }
  }

  private resolveTargetableIncludingLocal(entityId: number): Targetable | null {
    if (entityId === this.localPlayerId) return this.localPlayer;
    return this.entities.resolveTargetable(entityId);
  }

  /** Reposition all world objects/models after heightmap loads (fixes race condition) */
  private repositionWorldObjects(): void {
    for (const [objectEntityId, data] of this.worldObjectDefs) {
      const h = data.y ?? this.getHeightAtFloor(data.x, data.z, data.floor, 0);
      const doorEntry = this.doorPivots.get(objectEntityId);
      if (doorEntry) {
        // Doors keep the Y they were authored with — upper-floor doors live
        // above floor-0 terrain and would be invisible if snapped down.
        // setupDoorPivot already set the pivot Y from the model's absolute
        // position, which respects the placement file's y value.
      } else {
        const model = this.worldObjectModels.get(objectEntityId);
        if (model) {
          if (this.chunkManager.isPlacedObjectNode(model)) {
            this.restorePlacedWorldObjectAuthoredTransform(model);
          } else {
            model.position.y = h;
          }
        }
      }
    }
    this.entities.repositionEntities(this.playerX, this.playerZ, this.localPlayer);
  }

  private restorePlacedWorldObjectAuthoredTransform(model: TransformNode): void {
    const authored = this.chunkManager.getPlacedObjectAuthoredPosition(model);
    const rootWasFrozen = model.isWorldMatrixFrozen;
    if (rootWasFrozen) model.unfreezeWorldMatrix();
    model.position.set(authored.x, authored.y, authored.z);
    model.computeWorldMatrix(true);
    if (rootWasFrozen) model.freezeWorldMatrix();

    const refreshFrozenNode = (node: TransformNode): void => {
      const wasFrozen = node.isWorldMatrixFrozen;
      if (wasFrozen) node.unfreezeWorldMatrix();
      node.computeWorldMatrix(true);
      if (wasFrozen) node.freezeWorldMatrix();
    };
    for (const child of model.getChildTransformNodes(false)) refreshFrozenNode(child);
    for (const child of model.getChildMeshes(false)) refreshFrozenNode(child);
  }

  /** Clean up world object references to disposed placed nodes (after chunk unload) */
  private cleanupDisposedWorldObjects(): void {
    for (const [entityId, node] of this.worldObjectModels) {
      if (node.isDisposed()) {
        this.deleteWorldObjectModel(entityId);
        this.objectModels.deleteStump(entityId);
      }
    }
  }

  /** Link placed GLB objects to server world objects after map finishes loading */
  private linkPlacedObjectsToWorldObjects(): void {
    this.linkPlacedObjectsToWorldObjectsInBounds(-Infinity, Infinity, -Infinity, Infinity);
  }

  private linkPlacedObjectsToWorldObjectsForChunk(chunkKey: string): void {
    const comma = chunkKey.indexOf(',');
    const chunkX = Number(chunkKey.slice(0, comma));
    const chunkZ = Number(chunkKey.slice(comma + 1));
    if (!Number.isFinite(chunkX) || !Number.isFinite(chunkZ)) {
      this.linkPlacedObjectsToWorldObjects();
      return;
    }
    const margin = 2;
    this.linkPlacedObjectsToWorldObjectsInBounds(
      chunkX * CHUNK_SIZE - margin,
      (chunkX + 1) * CHUNK_SIZE + margin,
      chunkZ * CHUNK_SIZE - margin,
      (chunkZ + 1) * CHUNK_SIZE + margin,
    );
  }

  private linkPlacedObjectsToWorldObjectsInBounds(minX: number, maxX: number, minZ: number, maxZ: number): void {
    for (const [objectEntityId, data] of this.worldObjectDefs) {
      if (this.worldObjectModels.has(objectEntityId)) continue;
      if (data.x < minX || data.x > maxX || data.z < minZ || data.z > maxZ) continue;
      const placedNode = this.chunkManager.findPlacedObjectNear(
        data.x,
        data.z,
        1.5,
        data.defId,
        data.y,
        node => this.canLinkPlacedNodeToWorldObject(objectEntityId, node),
      );
      if (placedNode) {
        this.linkPlacedNodeToEntity(objectEntityId, data, placedNode);
      }
    }
  }

  private worldObjectIdForNode(node: TransformNode): number | null {
    return this.worldObjectIdByNode.get(node) ?? null;
  }

  private canLinkPlacedNodeToWorldObject(objectEntityId: number, node: TransformNode): boolean {
    const linkedEntityId = this.worldObjectIdByNode.get(node);
    return linkedEntityId == null || linkedEntityId === objectEntityId;
  }

  private disposeDoorVisualState(objectEntityId: number): void {
    const proxy = this.doorPickProxies.get(objectEntityId);
    if (proxy) {
      proxy.dispose();
      this.doorPickProxies.delete(objectEntityId);
    }

    const entry = this.doorPivots.get(objectEntityId);
    if (entry) {
      const model = this.worldObjectModels.get(objectEntityId);
      if (model && !model.isDisposed() && model.parent === entry.pivot) {
        entry.pivot.rotation.y = 0;
        entry.pivot.computeWorldMatrix(true);
        model.computeWorldMatrix(true);
        model.setParent(entry.pivot.parent);
        model.rotationQuaternion = null;
        model.rotation.set(0, entry.closedRotY, 0);
      }
      entry.pivot.dispose(true);
      this.doorPivots.delete(objectEntityId);
    }

    this.doorTiles.delete(objectEntityId);
  }

  private setWorldObjectModel(objectEntityId: number, node: TransformNode): void {
    const previous = this.worldObjectModels.get(objectEntityId);
    if (previous === node) {
      this.worldObjectIdByNode.set(node, objectEntityId);
      return;
    }
    if (previous) {
      this.worldObjectIdByNode.delete(previous);
      this.worldObjectPickState.delete(previous);
      this.disposeDoorVisualState(objectEntityId);
      this.disposeCropPickProxy(objectEntityId);
      this.disposeWorldObjectPickProxy(objectEntityId);
    }
    const currentEntityId = this.worldObjectIdByNode.get(node);
    if (currentEntityId != null && currentEntityId !== objectEntityId) {
      this.disposeDoorVisualState(currentEntityId);
      this.disposeCropPickProxy(currentEntityId);
      this.disposeWorldObjectPickProxy(currentEntityId);
      this.worldObjectModels.delete(currentEntityId);
      this.worldObjectPickState.delete(node);
    }
    this.worldObjectModels.set(objectEntityId, node);
    this.worldObjectIdByNode.set(node, objectEntityId);
  }

  private deleteWorldObjectModel(objectEntityId: number): void {
    this.disposeDoorVisualState(objectEntityId);
    this.disposeCropPickProxy(objectEntityId);
    this.disposeWorldObjectPickProxy(objectEntityId);
    this.objectModels.deleteActiveModelAnimations(objectEntityId);
    const node = this.worldObjectModels.get(objectEntityId);
    if (node) {
      this.worldObjectIdByNode.delete(node);
      this.worldObjectPickState.delete(node);
      if (!this.chunkManager.isPlacedObjectNode(node) && !node.isDisposed()) {
        node.dispose(false, false);
      }
    }
    this.worldObjectModels.delete(objectEntityId);
  }

  private shouldPlacedWorldObjectBeEnabled(objectEntityId: number): boolean {
    const data = this.worldObjectDefs.get(objectEntityId);
    if (!data) return true;
    const def = this.objectDefsCache.get(data.defId);
    // Floor isolation is an interaction rule, not a scenery-visibility rule.
    // Placed models are part of the map and may be visible from another floor
    // or after a transient floor-sync/HMR state; keep the mesh rendered while
    // action builders decide what is usable for the current floor.
    return !data.depleted || def?.category === 'door';
  }

  private isWorldObjectOnCurrentInteractionFloor(
    data: { defId: number; x: number; z: number; floor: number; ladderActionMask?: number },
    def: WorldObjectDef | undefined | null = this.objectDefsCache.get(data.defId),
  ): boolean {
    if (data.floor === this.currentFloor) return true;
    if (def?.category !== 'ladder') return false;
    return true;
  }

  private isRoofNodeHidden(node: TransformNode): boolean {
    return this.hiddenRoofNodeSet.has(node) || this.hoverHiddenRoofNodeSet.has(node);
  }

  private setPlacedWorldObjectEnabled(node: TransformNode, enabled: boolean): void {
    if (!enabled) {
      this.chunkManager.setPlacedObjectVisualEnabled(node, false);
      if (node.isEnabled(false)) node.setEnabled(false);
      return;
    }
    const roofDefaultEnabled = this.chunkManager.roofNodeDefaultEnabled(node);
    if (roofDefaultEnabled === false) {
      this.chunkManager.setPlacedObjectVisualEnabled(node, false);
      if (node.isEnabled(false)) node.setEnabled(false);
      return;
    }
    const objectEntityId = this.worldObjectIdForNode(node);
    if (objectEntityId !== null && !this.shouldPlacedWorldObjectBeEnabled(objectEntityId)) {
      this.chunkManager.setPlacedObjectVisualEnabled(node, false);
      if (node.isEnabled(false)) node.setEnabled(false);
      return;
    }
    if (this.isRoofNodeHidden(node)) {
      this.chunkManager.setPlacedObjectVisualEnabled(node, false);
      if (node.isEnabled(false)) node.setEnabled(false);
      return;
    }
    this.chunkManager.setPlacedObjectVisualEnabled(node, true);
    if (!node.isEnabled(false)) node.setEnabled(true);
  }

  private reapplyWorldObjectVisualStates(): void {
    for (const [objectEntityId, model] of this.worldObjectModels) {
      const data = this.worldObjectDefs.get(objectEntityId);
      if (!data) {
        this.setPlacedWorldObjectEnabled(model, this.shouldPlacedWorldObjectBeEnabled(objectEntityId));
        continue;
      }
      const def = this.objectDefsCache.get(data.defId);
      const hasDepleteModel = this.objectDefHasDepletedModel(def);
      if (hasDepleteModel) {
        let depleted = this.objectModels.getStump(objectEntityId);
        if (!depleted && data.depleted) {
          depleted = this.objectModels.createDepletedModel(objectEntityId, data.defId, model);
        }
        if (depleted) {
          this.objectModels.syncDepletedModelTransform(objectEntityId, model);
          depleted.setEnabled(data.depleted);
          this.setWorldObjectPickTarget(objectEntityId, false, depleted);
        }
      }
      this.setPlacedWorldObjectEnabled(model, this.shouldPlacedWorldObjectBeEnabled(objectEntityId));
    }
  }

  private objectDefHasDepletedModel(def: WorldObjectDef | null | undefined): boolean {
    return !!def && (def.category === 'tree' || def.category === 'rock' || !!def.depletedAssetId);
  }

  private refreshWorldAfterSameMapTeleport(): void {
    if (this.chunkManager.forceRefreshPlayerPosition(this.playerX, this.playerZ)) {
      this.cleanupDisposedWorldObjects();
      this.linkPlacedObjectsToWorldObjects();
      this.reapplyWorldObjectVisualStates();
    }
    this.recomputeHiddenRoofs();
  }

  /** Link a placed GLB node to a world object entity, tagging for picking and handling depletion */
  private linkPlacedNodeToEntity(
    objectEntityId: number,
    data: { defId: number; x: number; z: number; floor?: number; y?: number; depleted: boolean; openDirection?: -1 | 1; locked?: boolean },
    placedNode: TransformNode,
  ): void {
    this.setWorldObjectModel(objectEntityId, placedNode);

    const def = this.objectDefsCache.get(data.defId);
    this.setWorldObjectPickTarget(objectEntityId, false, placedNode);
    if (def?.category === 'door') {
      this.setWorldObjectPickTarget(objectEntityId, false, placedNode);
      this.disposeWorldObjectPickProxy(objectEntityId);
      const modelRotY = this.modelRotY(placedNode);
      const pickBounds = this.computeDoorPickProxyBounds(placedNode, data.x, data.z, modelRotY, placedNode.getAbsolutePosition().y);
      const { tile: [tx, tz], edge: wallEdge } = doorEdgeFromPlacement(data.x, data.z, modelRotY);
      const floor = data.floor ?? 0;
      this.doorTiles.set(objectEntityId, [tx, tz]);
      const nb = DOOR_EDGE_NEIGHBOR[wallEdge];
      // Wall mask for the door tile is set up by the chunk's wall data —
      // we just need to flip openDoorEdges to match the current state.
      // Keeping the wall mask permanent ensures the elevation gate in
      // wallEdgeBlocksAtHeight can block wrong-elevation passage.
      this.chunkManager.setWallOnFloor(tx, tz, floor, this.chunkManager.getWallOnFloorPublic(tx, tz, floor) | wallEdge);
      if (nb) {
        const nx = tx + nb.dx, nz = tz + nb.dz;
        this.chunkManager.setWallOnFloor(nx, nz, floor, this.chunkManager.getWallOnFloorPublic(nx, nz, floor) | nb.opposite);
      }
      this.chunkManager.setOpenDoorEdges(tx, tz, wallEdge, data.depleted, floor);
      if (nb) this.chunkManager.setOpenDoorEdges(tx + nb.dx, tz + nb.dz, nb.opposite, data.depleted, floor);
      this.setupDoorPivot(objectEntityId);
      this.createDoorPickProxy(objectEntityId, data.x, data.z, modelRotY, placedNode.getAbsolutePosition().y, pickBounds);
      // Doors stay visible regardless of depleted state
    } else {
      if (data.depleted) {
        const depleted = this.objectModels.createDepletedModel(objectEntityId, data.defId, placedNode);
        if (depleted) this.setWorldObjectPickTarget(objectEntityId, false, depleted);
        placedNode.setEnabled(false);
      }
    }

    if (def?.category === 'crop') {
      this.disposeWorldObjectPickProxy(objectEntityId);
      this.createCropPickProxy(objectEntityId, placedNode, def, data.depleted);
      this.setCropPickTarget(objectEntityId, def, data.depleted, placedNode);
    } else if (def && def.category !== 'door') {
      this.setGenericWorldObjectPickTarget(
        objectEntityId,
        data,
        def,
        this.isWorldObjectInteractable(def, data.depleted),
        placedNode,
      );
    }
  }

  private cropPickProxyConfig(def: WorldObjectDef): CropPickProxyConfig {
    if (def.id === RICE_PLANT_OBJECT_DEF_ID) return RICE_CROP_PICK_PROXY;
    return def.id === POTATO_PLANT_OBJECT_DEF_ID ? POTATO_CROP_PICK_PROXY : DEFAULT_CROP_PICK_PROXY;
  }

  private cropPickProxyBatchKey(config: CropPickProxyConfig): string {
    return `${config.width},${config.depth},${config.height},${config.y}`;
  }

  private cropPickProxyMatrix(placedNode: TransformNode, config: CropPickProxyConfig): Matrix {
    placedNode.computeWorldMatrix(true);
    return Matrix.Translation(0, config.y, 0).multiply(placedNode.getWorldMatrix());
  }

  private cropPickProxyBatchFor(config: CropPickProxyConfig): CropPickProxyBatch {
    const key = this.cropPickProxyBatchKey(config);
    let batch = this.cropPickProxyBatches.get(key);
    if (!batch) {
      const mesh = MeshBuilder.CreateBox(`crop_pickProxy_batch_${this.cropPickProxyBatches.size}`, {
        width: config.width,
        depth: config.depth,
        height: config.height,
      }, this.scene);
      mesh.isVisible = true;
      mesh.visibility = 0;
      mesh.isPickable = true;
      mesh.layerMask = 0;
      mesh.doNotSyncBoundingInfo = true;
      mesh.thinInstanceEnablePicking = true;
      mesh.metadata = {
        kind: 'cropPickProxyBatch',
        objectEntityIdsByThinInstance: [],
      };
      mesh.freezeWorldMatrix();
      batch = {
        mesh,
        config,
        objectEntityIds: mesh.metadata.objectEntityIdsByThinInstance,
        refsByObjectId: new Map(),
        freeIndices: [],
      };
      this.cropPickProxyBatches.set(key, batch);
    }
    return batch;
  }

  private refreshCropPickProxyBatchBounds(batch: CropPickProxyBatch): void {
    batch.mesh.thinInstanceRefreshBoundingInfo(true);
  }

  private createCropPickProxy(
    objectEntityId: number,
    placedNode: TransformNode,
    def: WorldObjectDef,
    depleted: boolean,
  ): void {
    this.disposeCropPickProxy(objectEntityId);
    const config = this.cropPickProxyConfig(def);
    const batchKey = this.cropPickProxyBatchKey(config);
    const batch = this.cropPickProxyBatchFor(config);
    const index = batch.freeIndices.pop() ?? batch.objectEntityIds.length;
    const matrix = this.cropPickProxyMatrix(placedNode, config);

    if (index >= batch.objectEntityIds.length) {
      batch.mesh.thinInstanceAdd(matrix, false);
    } else {
      batch.mesh.thinInstanceSetMatrixAt(index, matrix);
    }
    batch.objectEntityIds[index] = depleted ? null : objectEntityId;
    batch.mesh.thinInstanceBufferUpdated('matrix');

    const ref = { batchKey, index, placedNode, config };
    batch.refsByObjectId.set(objectEntityId, ref);
    this.cropPickProxyRefs.set(objectEntityId, ref);
    this.refreshCropPickProxyBatchBounds(batch);
  }

  private disposeCropPickProxy(objectEntityId: number): void {
    const ref = this.cropPickProxyRefs.get(objectEntityId);
    if (ref) {
      const batch = this.cropPickProxyBatches.get(ref.batchKey);
      if (batch) {
        batch.objectEntityIds[ref.index] = null;
        batch.refsByObjectId.delete(objectEntityId);
        batch.freeIndices.push(ref.index);
        batch.mesh.thinInstanceBufferUpdated('matrix');
        this.refreshCropPickProxyBatchBounds(batch);
      }
      this.cropPickProxyRefs.delete(objectEntityId);
    }
  }

  private setCropPickProxyEnabled(objectEntityId: number, enabled: boolean): void {
    const ref = this.cropPickProxyRefs.get(objectEntityId);
    if (!ref) return;
    const batch = this.cropPickProxyBatches.get(ref.batchKey);
    if (!batch) return;
    batch.objectEntityIds[ref.index] = enabled ? objectEntityId : null;
    if (enabled) batch.mesh.thinInstanceSetMatrixAt(ref.index, this.cropPickProxyMatrix(ref.placedNode, ref.config));
    batch.mesh.thinInstanceBufferUpdated('matrix');
    this.refreshCropPickProxyBatchBounds(batch);
  }

  private disposeAllCropPickProxyBatches(): void {
    for (const batch of this.cropPickProxyBatches.values()) batch.mesh.dispose();
    this.cropPickProxyBatches.clear();
    this.cropPickProxyRefs.clear();
  }

  private fallbackWorldObjectPickProxyBounds(
    data: { x: number; z: number; y?: number; rotY?: number },
    def: WorldObjectDef,
  ): DoorPickProxyBounds {
    const bounds = getObjectFootprintBounds(data.x, data.z, def, data.rotY ?? 0);
    const margin = 0.16;
    const baseY = Number.isFinite(data.y) ? (data.y ?? 0) : 0;
    return {
      center: new Vector3(
        bounds.minX + bounds.width / 2,
        baseY + 1.1,
        bounds.minZ + bounds.depth / 2,
      ),
      width: Math.max(0.8, bounds.width + margin),
      depth: Math.max(0.8, bounds.depth + margin),
      height: 2.2,
    };
  }

  private computeWorldObjectPickProxyBounds(
    model: TransformNode,
    data: { x: number; z: number; y?: number; rotY?: number },
    def: WorldObjectDef,
  ): DoorPickProxyBounds {
    const fallback = this.fallbackWorldObjectPickProxyBounds(data, def);
    model.computeWorldMatrix(true);
    let bounds: ReturnType<TransformNode['getHierarchyBoundingVectors']>;
    try {
      bounds = model.getHierarchyBoundingVectors(true);
    } catch {
      return fallback;
    }

    const width = bounds.max.x - bounds.min.x;
    const depth = bounds.max.z - bounds.min.z;
    const height = bounds.max.y - bounds.min.y;
    if (!Number.isFinite(width) || !Number.isFinite(depth) || !Number.isFinite(height) || width <= 0 || depth <= 0 || height <= 0) {
      return fallback;
    }

    const margin = 0.18;
    return {
      center: new Vector3(
        (bounds.min.x + bounds.max.x) / 2,
        (bounds.min.y + bounds.max.y) / 2,
        (bounds.min.z + bounds.max.z) / 2,
      ),
      width: Math.max(fallback.width, Math.min(width + margin, 6)),
      depth: Math.max(fallback.depth, Math.min(depth + margin, 6)),
      height: Math.max(fallback.height, Math.min(height + margin, 8)),
    };
  }

  private worldObjectPickProxyMatrix(bounds: DoorPickProxyBounds): Matrix {
    return Matrix.Compose(
      TmpVectors.Vector3[0].set(bounds.width, bounds.height, bounds.depth),
      Quaternion.Identity(),
      bounds.center,
    );
  }

  private worldObjectPickProxyBatchFor(): WorldObjectPickProxyBatch {
    if (!this.worldObjectPickProxyBatch) {
      const mesh = MeshBuilder.CreateBox('worldObject_pickProxy_batch', { size: 1 }, this.scene);
      mesh.isVisible = true;
      mesh.visibility = 0;
      mesh.isPickable = true;
      mesh.layerMask = 0;
      mesh.doNotSyncBoundingInfo = true;
      mesh.thinInstanceEnablePicking = true;
      mesh.metadata = {
        kind: 'worldObjectPickProxyBatch',
        objectEntityIdsByThinInstance: [],
      };
      mesh.freezeWorldMatrix();
      this.worldObjectPickProxyBatch = {
        mesh,
        objectEntityIds: mesh.metadata.objectEntityIdsByThinInstance,
        refsByObjectId: new Map(),
        freeIndices: [],
      };
    }
    return this.worldObjectPickProxyBatch;
  }

  private refreshWorldObjectPickProxyBatchBounds(batch: WorldObjectPickProxyBatch): void {
    batch.mesh.thinInstanceRefreshBoundingInfo(true);
  }

  private createWorldObjectPickProxy(
    objectEntityId: number,
    data: { x: number; z: number; y?: number; rotY?: number },
    def: WorldObjectDef,
    model: TransformNode,
  ): void {
    this.disposeWorldObjectPickProxy(objectEntityId);
    const bounds = this.computeWorldObjectPickProxyBounds(model, data, def);
    const batch = this.worldObjectPickProxyBatchFor();
    const index = batch.freeIndices.pop() ?? batch.objectEntityIds.length;
    const matrix = this.worldObjectPickProxyMatrix(bounds);

    if (index >= batch.objectEntityIds.length) {
      batch.mesh.thinInstanceAdd(matrix, false);
    } else {
      batch.mesh.thinInstanceSetMatrixAt(index, matrix);
    }
    batch.objectEntityIds[index] = objectEntityId;
    batch.mesh.thinInstanceBufferUpdated('matrix');

    const ref = { index, bounds };
    batch.refsByObjectId.set(objectEntityId, ref);
    this.worldObjectPickProxyRefs.set(objectEntityId, ref);
    this.refreshWorldObjectPickProxyBatchBounds(batch);
  }

  private disposeWorldObjectPickProxy(objectEntityId: number): void {
    const ref = this.worldObjectPickProxyRefs.get(objectEntityId);
    const batch = this.worldObjectPickProxyBatch;
    if (ref && batch) {
      batch.objectEntityIds[ref.index] = null;
      batch.refsByObjectId.delete(objectEntityId);
      batch.freeIndices.push(ref.index);
      batch.mesh.thinInstanceBufferUpdated('matrix');
      this.refreshWorldObjectPickProxyBatchBounds(batch);
    }
    this.worldObjectPickProxyRefs.delete(objectEntityId);
  }

  private setWorldObjectPickProxyEnabled(objectEntityId: number, enabled: boolean): void {
    const ref = this.worldObjectPickProxyRefs.get(objectEntityId);
    const batch = this.worldObjectPickProxyBatch;
    if (!ref || !batch) return;
    batch.objectEntityIds[ref.index] = enabled ? objectEntityId : null;
    if (enabled) batch.mesh.thinInstanceSetMatrixAt(ref.index, this.worldObjectPickProxyMatrix(ref.bounds));
    batch.mesh.thinInstanceBufferUpdated('matrix');
    this.refreshWorldObjectPickProxyBatchBounds(batch);
  }

  private disposeWorldObjectPickProxyBatch(): void {
    this.worldObjectPickProxyBatch?.mesh.dispose();
    this.worldObjectPickProxyBatch = null;
    this.worldObjectPickProxyRefs.clear();
  }

  private setGenericWorldObjectPickTarget(
    objectEntityId: number,
    data: { x: number; z: number; y?: number; rotY?: number },
    def: WorldObjectDef,
    interactive: boolean,
    model: TransformNode,
  ): void {
    this.setWorldObjectPickTarget(objectEntityId, false, model);
    if (interactive && !this.worldObjectPickProxyRefs.has(objectEntityId)) {
      this.createWorldObjectPickProxy(objectEntityId, data, def, model);
    }
    this.setWorldObjectPickProxyEnabled(objectEntityId, interactive);
  }

  private setCropPickTarget(
    objectEntityId: number,
    def: WorldObjectDef,
    depleted: boolean,
    model: TransformNode,
  ): void {
    this.setWorldObjectPickTarget(objectEntityId, false, model);
    if (!this.cropPickProxyRefs.has(objectEntityId)) {
      this.createCropPickProxy(objectEntityId, model, def, depleted);
    }
    const interactive = this.isWorldObjectInteractable(def, depleted);
    this.setCropPickProxyEnabled(objectEntityId, interactive);
  }

  /** Create a depleted model (stump/depleted rock) at the placed node's position */
  private setupKeyboard(): void {
    // Stored on `this` so destroy() can remove them — inline arrows would leak
    // the entire GameManager (closure captures `this`) across logout/re-login.
    this._keydownHandler = (e) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
      if (e.key === 'Escape' && this.bankPanel?.isVisible()) {
        this.keysDown.delete('escape');
        e.preventDefault();
        return;
      }
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
    };
    this._keyupHandler = (e) => {
      this.keysDown.delete(e.key.toLowerCase());
    };
    window.addEventListener('keydown', this._keydownHandler);
    window.addEventListener('keyup', this._keyupHandler);
  }

  private _keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private _keyupHandler: ((e: KeyboardEvent) => void) | null = null;

  /** Apply an equipment-slot array (matches PLAYER_REMOTE_EQUIPMENT layout)
   *  to a CharacterEntity. Each slot is loaded asynchronously; ordering
   *  doesn't matter since slots don't depend on each other. */
  private applyRemoteEquipmentArray(target: CharacterEntity, slots: number[], entityId?: number): void {
    for (let i = 0; i < EQUIP_SLOT_NAMES.length; i++) {
      const slotName = EQUIP_SLOT_NAMES[i];
      const itemId = slots[i] ?? 0;
      // Fire-and-forget — failures are logged inside loadGearSmart.
      void this.applyGearToCharacter(target, slotName, itemId, /* isLocal */ false, entityId);
    }
  }

  private applyNpcModelEquipmentArray(target: Npc3DEntity, slots: number[], entityId: number): void {
    const npcDefId = this.entities.npcDefs.get(entityId);
    if (npcDefId == null) return;
    for (let i = 0; i < EQUIP_SLOT_NAMES.length; i++) {
      const slotName = EQUIP_SLOT_NAMES[i];
      if (!resolveNpcGearSlotConfig(npcDefId, this.npcDefsCache.get(npcDefId), slotName)) continue;
      const itemId = slots[i] ?? 0;
      void this.applyGearToNpcModel(target, npcDefId, slotName, itemId, entityId);
    }
  }

  private resolveNpcModelGearSlotFit(npcDefId: number, slotName: string, entityId: number): NpcGearSlotConfig | null {
    const base = resolveNpcGearSlotConfig(npcDefId, this.npcDefsCache.get(npcDefId), slotName);
    if (!base) return null;
    return mergeNpcGearSlotFit(base, this.entities.npcEquipmentFits.get(entityId)?.[slotName]);
  }

  private applyNpcModelGearFitTransform(target: Npc3DEntity, slotName: string, attachment: NpcGearSlotConfig): void {
    applyNpcGearFitToNode(target.getGearNode(slotName), attachment);
  }

  private recreateRemotePlayer(entityId: number, appearance: PlayerAppearance): void {
    const current = this.entities.remotePlayers.get(entityId);
    const target = this.entities.remoteTargets.get(entityId);
    const pos = current?.position.clone();
    const x = target?.x ?? pos?.x ?? 0;
    const z = target?.z ?? pos?.z ?? 0;
    const floor = target?.floor ?? 0;
    const y = target?.y ?? pos?.y;
    const name = this.entities.playerNames.get(entityId) || 'Player';

    current?.dispose();
    const replacement = this.entities.createRemotePlayer(entityId, x, z, name, floor, y, appearance);
    replacement.whenReady().then(() => {
      if (this.entities.remotePlayers.get(entityId) !== replacement) return;
      replacement.applyAppearance(appearance);
      const equipment = this.entities.remoteEquipment.get(entityId);
      if (equipment) this.applyRemoteEquipmentArray(replacement, equipment, entityId);
      const anim = this.remoteAnimationStates.get(entityId);
      if (anim) this.applyRemotePlayerAnimation(entityId, anim.kind, anim.variant, anim.targetId, anim.toolItemId);
    });
  }

  /**
   * Equip or unequip a 3D gear piece on the local player.
   * Loads explicitly configured 3D gear models on demand, caches the template.
   * itemId = 0 or -1 means unequip.
   */
  private async equipGear(slotIndex: number, itemId: number): Promise<void> {
    if (!this.localPlayer) return;
    const slotName = EQUIP_SLOT_NAMES[slotIndex];
    if (!slotName) return;
    await this.applyGearToCharacter(this.localPlayer, slotName, itemId, /* isLocal */ true, this.localPlayerId);
  }

  private getCharacterBodyType(character?: CharacterEntity | null): number {
    if (!character) return 0;
    if (character === this.localPlayer && this.localAppearance) return this.localAppearance.bodyType;
    const index = CHARACTER_MODEL_PATHS.indexOf(character.getModelPath());
    return index >= 0 ? index : 0;
  }

  private getGearOverrideForCharacter(itemId: number, character?: CharacterEntity | null): GearOverride | null {
    return resolveGearOverrideForBodyType(
      this.gearOverrides.get(this.getGearFitSourceItemId(itemId)),
      this.getCharacterBodyType(character),
    );
  }

  private getGearModelFileForCharacter(itemId: number, slotName: string, character?: CharacterEntity | null): string | null {
    const itemDef = this.itemDefsCache.get(itemId);
    const rawOverride = this.gearOverrides.get(this.getGearFitSourceItemId(itemId));
    const bodyType = this.getCharacterBodyType(character);
    return resolveCharacterGearModelFile(itemDef, rawOverride, bodyType, slotName);
  }

  private getGearFitSourceItemId(itemId: number): number {
    return resolveGearFitSourceItemId(itemId, this.itemDefsCache.values());
  }

  private async saveGearOverridesToServer(): Promise<void> {
    const all: Record<string, GearOverride> = {};
    for (const [id, ov] of this.gearOverrides) all[String(id)] = ov;
    const token = this.token || localStorage.getItem('evilquest_token') || '';
    const res = await fetch('/api/dev/gear-overrides', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(all),
    });
    if (!res.ok) throw new Error('Server returned ' + res.status);
  }

  private applyGearOverrideTransform(character: CharacterEntity, slotName: string, itemId: number): void {
    if (character.getGearItemId(slotName) !== itemId) return;
    const override = this.getGearOverrideForCharacter(itemId, character);
    if (!override) return;
    if (character.getSkinnedArmorMeshes(slotName)) {
      character.applySkinnedArmorTransform(slotName, override);
      return;
    }

    const node = character.getGearNode(slotName);
    if (!node) return;
    node.rotationQuaternion = null;
    if (override.localPosition) {
      node.position.set(override.localPosition.x, override.localPosition.y, override.localPosition.z);
    }
    if (override.localRotation) {
      node.rotation.set(override.localRotation.x, override.localRotation.y, override.localRotation.z);
    }
    if (override.scale != null) {
      node.scaling.set(override.scale, override.scale, override.scale);
    }
    if (slotName === 'head') {
      character.setHeadHairFitForCurrentHead(override.headHair ?? null);
    }
  }

  private refreshEquippedGearOverride(itemId: number): void {
    const itemDef = this.itemDefsCache.get(itemId);
    const slotName = itemDef?.equipSlot;
    if (!slotName) return;

    const refresh = (character: CharacterEntity): void => {
      const equippedItemId = character.getGearItemId(slotName);
      if (equippedItemId !== itemId && this.getGearFitSourceItemId(equippedItemId) !== itemId) return;
      this.applyGearOverrideTransform(character, slotName, equippedItemId);
    };

    if (this.localPlayer) {
      refresh(this.localPlayer);
    }
    for (const character of this.entities.remotePlayers.values()) {
      refresh(character);
    }
    for (const npc of this.entities.npcSprites.values()) {
      if (npc instanceof CharacterEntity) {
        refresh(npc);
      }
    }
  }

  private deleteGearTemplateCacheForItem(slotName: string, itemId: number): void {
    const oldKey = `${slotName}/${itemId}`;
    const suffix = `/${oldKey}`;
    for (const key of this.gearTemplateCache.keys()) {
      if (key === oldKey || key.endsWith(suffix)) this.gearTemplateCache.delete(key);
    }
    for (const key of this.gearLoadingPromises.keys()) {
      if (key === oldKey || key.endsWith(suffix)) this.gearLoadingPromises.delete(key);
    }
  }

  private nextGearApplyGuard(target: CharacterEntity | Npc3DEntity, slotName: string, entityId?: number): GearApplyGuard {
    let perTarget = this.gearApplySeq.get(target);
    if (!perTarget) {
      perTarget = new Map();
      this.gearApplySeq.set(target, perTarget);
    }
    const seq = (perTarget.get(slotName) ?? 0) + 1;
    perTarget.set(slotName, seq);
    return () => {
      if (perTarget!.get(slotName) !== seq) return false;
      if (entityId === undefined) return true;
      if (this.localPlayer === target) return entityId === this.localPlayerId;
      return this.entities.remotePlayers.get(entityId) === target
        || this.entities.npcSprites.get(entityId) === target;
    };
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
    entityId?: number,
  ): Promise<void> {
    const isCurrentApply = this.nextGearApplyGuard(target, slotName, entityId);

    // Unequip
    if (itemId <= 0) {
      target.detachGear(slotName);
      target.detachSkinnedArmor(slotName);
      return;
    }

    // Already wearing this item?
    if (target.getGearItemId(slotName) === itemId) {
      target.setHighQualityGearEffect(slotName, isHighQualityItem(this.itemDefsCache.get(itemId)));
      return;
    }

    const boneConfig = EQUIP_SLOT_BONES[slotName];
    if (!boneConfig) return;

    // Wait for gear-overrides.json to finish loading before reading from it.
    // PLAYER_EQUIPMENT_BATCH from the server can land before that fetch
    // completes; without this gate we'd silently use EQUIP_SLOT_BONES
    // defaults and cache the resulting (wrong) template.
    await this.gearOverridesReady;

    const buildDef = (): GearDef | null => {
      // gearOverrides is a shared rigging file; body type 0 uses the root fit,
      // while other body types can override only the fields they need.
      const itemDef = this.itemDefsCache.get(itemId);
      return buildCharacterGearDef(
        itemId,
        slotName,
        itemDef,
        this.gearOverrides.get(this.getGearFitSourceItemId(itemId)),
        this.getCharacterBodyType(target),
      )?.def ?? null;
    };

    // Slot names whose loaded GLB binds to a specific skeleton — these CAN'T
    // share cached templates, so we always reload per target. Note: 'head'
    // is NOT in this set even though its loadGearSmart path is special;
    // the head path returns a sharable template (mesh offsets are computed
    // against the armor GLB's own bones, not the character's), so it routes
    // through the cache below like any other bone-attached slot.
    if (PER_TARGET_GEAR_SLOTS.has(slotName)) {
      const def = buildDef();
      if (def) {
        await this.loadGearSmart(slotName, itemId, def, target, isCurrentApply);
        if (isCurrentApply() && target.getGearItemId(slotName) === itemId) {
          target.setHighQualityGearEffect(slotName, isHighQualityItem(this.itemDefsCache.get(itemId)));
        }
      }
      return;
    }

    // Cache-shareable bone-attached gear (weapon, shield, neck, ring).
    const cacheKey = `${this.getCharacterBodyType(target)}/${slotName}/${itemId}`;
    if (isLocal) {
      this.gearTemplateCache.delete(cacheKey);
      this.gearLoadingPromises.delete(cacheKey);
    }
    let template = this.gearTemplateCache.get(cacheKey);
    if (!template) {
      let promise = this.gearLoadingPromises.get(cacheKey);
      if (!promise) {
        promise = (async () => {
          const def = buildDef();
          const tmpl = def ? await this.loadGearSmart(slotName, itemId, def, target) : null;
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
    if (template && isCurrentApply()) {
      target.attachGear(slotName, itemId, template);
      target.setHighQualityGearEffect(slotName, isHighQualityItem(this.itemDefsCache.get(itemId)));
    }
  }

  private async applyGearToNpcModel(
    target: Npc3DEntity,
    npcDefId: number,
    slotName: string,
    itemId: number,
    entityId: number,
  ): Promise<void> {
    const isCurrentApply = this.nextGearApplyGuard(target, slotName, entityId);
    const baseAttachment = resolveNpcGearSlotConfig(npcDefId, this.npcDefsCache.get(npcDefId), slotName);
    if (!baseAttachment) return;
    const attachment = this.resolveNpcModelGearSlotFit(npcDefId, slotName, entityId) ?? baseAttachment;

    if (itemId <= 0) {
      target.detachGear(slotName);
      return;
    }

    if (target.getGearItemId(slotName) === itemId) {
      this.applyNpcModelGearFitTransform(target, slotName, attachment);
      return;
    }

    const itemDef = this.itemDefsCache.get(itemId);
    if (itemDef?.equipSlot !== slotName) {
      target.detachGear(slotName);
      return;
    }

    const gearFile = resolveEquipmentModelPath(itemDef, 0, slotName);
    if (!gearFile) {
      target.detachGear(slotName);
      return;
    }

    const gearDef: GearDef = {
      itemId,
      file: gearFile,
      boneName: baseAttachment.boneName,
      localPosition: baseAttachment.localPosition,
      localRotation: baseAttachment.localRotation,
      scale: baseAttachment.scale,
      centerOrigin: baseAttachment.centerOrigin,
      headRenderMode: itemDef.headRenderMode,
    };

    const sourceNpcId = resolveNpcModelSourceId(npcDefId, this.npcDefsCache.get(npcDefId));
    const cacheKey = `npc:${sourceNpcId}/${slotName}/${itemId}`;
    let template = this.gearTemplateCache.get(cacheKey);
    if (!template) {
      let promise = this.gearLoadingPromises.get(cacheKey);
      if (!promise) {
        promise = (async () => {
          const tmpl = await loadStaticGearTemplate(
            this.scene,
            itemId,
            gearDef,
            baseAttachment.sourceBoneName,
          );
          if (tmpl) {
            if (baseAttachment.axisCorrection) {
              tmpl.axisCorrection = new Quaternion(
                baseAttachment.axisCorrection.x,
                baseAttachment.axisCorrection.y,
                baseAttachment.axisCorrection.z,
                baseAttachment.axisCorrection.w,
              );
            }
            this.gearTemplateCache.set(cacheKey, tmpl);
          }
          this.gearLoadingPromises.delete(cacheKey);
          return tmpl;
        })();
        this.gearLoadingPromises.set(cacheKey, promise);
      }
      template = (await promise) ?? undefined;
    }

    if (template && isCurrentApply()) {
      target.attachGear(slotName, itemId, createNpcGearTemplateWithFit(template, attachment));
    }
  }

  /** Swap the weapon slot to the server-picked skilling tool. Passes
   *  isLocal=false so the gear-template cache is reused across repeated
   *  chops instead of reloading the GLB on each swap. */
  private async applySkillingTool(
    entityId: number,
    character: CharacterEntity,
    toolItemId: number,
  ): Promise<void> {
    if (toolItemId <= 0 || this.toolSwappedEntities.has(entityId)) return;
    if (character.getGearItemId('weapon') === toolItemId) return;
    this.toolSwappedEntities.add(entityId);
    await this.applyGearToCharacter(character, 'weapon', toolItemId, /* isLocal */ false, entityId);
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
    void this.applyGearToCharacter(character, 'weapon', realWeapon, /* isLocal */ false, entityId);
  }

  /**
   * Load a gear GLB. If it has a skeleton, set it up as skinned armor
   * (bone-sync per frame) on `target` and return null. Otherwise return a
   * GearTemplate for bone-parenting (which the caller is free to share
   * across multiple characters via attachGear).
   */
  private disposeImportedGearResult(result: {
    meshes?: { dispose: () => void }[];
    skeletons?: { dispose: () => void }[];
    animationGroups?: { dispose: () => void }[];
  }): void {
    disposeImportedGearResult(result);
  }

  private async loadGearSmart(
    slotName: string,
    itemId: number,
    def: GearDef,
    target?: CharacterEntity | null,
    isCurrentApply?: GearApplyGuard,
  ): Promise<GearTemplate | null> {
    const character = target ?? this.localPlayer;
    return loadCharacterGearSmart(
      this.scene,
      character,
      slotName,
      itemId,
      def,
      this.itemDefsCache.get(itemId),
      this.getGearOverrideForCharacter(itemId, character),
      isCurrentApply,
    );
  }

  private createLocalCharacterEntity(): CharacterEntity {
    return new CharacterEntity(this.scene, {
      name: 'localPlayer',
      modelPath: getCharacterModelPath(this.localAppearance),
      targetHeight: CHARACTER_TARGET_HEIGHT,
      groundShadow: true,
      // No label on the local player — matches pre-3D-remote-players behavior.
      // Other players see the local player's name through PLAYER_SYNC + the
      // chat 'player_info' broadcast.
      // Each GLB should hold a single action; the runtime picks it automatically
      // so re-exports don't require renaming the action in Blender first.
      additionalAnimations: [...PLAYER_ANIMATIONS],
    });
  }

  private ensureLocalCharacterModel(appearance: PlayerAppearance): void {
    const desiredModelPath = getCharacterModelPath(appearance);
    if (this.localPlayer?.getModelPath() === desiredModelPath) {
      this.localPlayer.applyAppearance(appearance);
      return;
    }

    const previous = this.localPlayer;
    const position = previous?.position.clone()
      ?? new Vector3(this.playerX, this.getHeightAtFloor(this.playerX, this.playerZ, this.currentFloor, 0), this.playerZ);
    previous?.dispose();

    const next = this.createLocalCharacterEntity();
    next.setPickable(false);
    next.setPositionXYZ(position.x, position.y, position.z);
    this.localPlayer = next;
    void next.whenReady().then(() => {
      if (this.localPlayer !== next) return;
      next.applyAppearance(appearance);
      for (const [slotIndex, itemId] of this.localEquipment) {
        void this.equipGear(slotIndex, itemId);
      }
    });
  }

  private sendAppearance(appearance: PlayerAppearance): void {
    this.network.sendRaw(encodePacket(
      ClientOpcode.SET_APPEARANCE,
      ...appearanceToWireValues(appearance),
    ));
  }

  private applyLocalAppearance(appearance: PlayerAppearance): void {
    this.cacheLocalAppearance(appearance);
    this.ensureLocalCharacterModel(appearance);
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
      if (import.meta.env.DEV) console.log(`Logged in at (${this.playerX}, ${spawnY}, ${this.playerZ})`);
      void this.tryResolveLoginReady(loginSeq);
    });

    this.network.on(ServerOpcode.SHOW_CHARACTER_CREATOR, (_op, v) => {
      this.openCharacterCreatorWhenReady((v[0] ?? 0) === 1);
    });

    this.network.on(ServerOpcode.ADMIN_FLAGS, (_op, v) => {
      const isAdmin = (v[0] & 1) === 1;
      this.isAdmin = isAdmin;
      if (!isAdmin) this.pinchZoom = null;
      this.camera.setLockedMode(!isAdmin);
      this.updateAdminSurfaces();
      if (isAdmin && !this.fpsCounterUserToggled) {
        this.setFpsCounterVisible(true);
      }
    });
  }

  private setupEntitySyncHandlers(): void {
    this.network.on(ServerOpcode.PLAYER_SYNC, (_op, v) => {
      const [entityId, x10, z10, health, maxHealth] = v;
      const x = x10 / 10;
      const z = z10 / 10;

      const hasAppearance = v.length >= 12 && v[5] >= 0;
      const hasBodyType = v.length >= 16;
      const syncCombatLevel = hasBodyType ? Math.max(0, v[13] ?? 0) : v.length >= 13 ? Math.max(0, v[12] ?? 0) : 0;
      const floor = hasBodyType ? Math.floor(v[14] ?? 0) : v.length >= 14 ? Math.floor(v[13] ?? 0) : 0;
      const y = hasBodyType ? (v[15] ?? 0) / 10 : v.length >= 15 ? (v[14] ?? 0) / 10 : this.getHeightAtFloor(x, z, floor, 0);
      const hasRoleFlags = v.length >= 17;
      const syncRoleFlags = hasRoleFlags ? (v[16] ?? 0) : 0;
      const syncIsAdmin = (syncRoleFlags & 1) === 1;
      const syncIsModerator = (syncRoleFlags & 2) === 2;
      const syncAppearance: PlayerAppearance | null = hasAppearance
        ? hasBodyType
          ? appearanceFromWireValues(v, 5)
          : { ...appearanceFromWireValues(v, 5), bodyType: 0 }
        : null;

      if (entityId === this.localPlayerId) {
        if (hasRoleFlags) {
          const wasAdmin = this.isAdmin;
          this.isAdmin = syncIsAdmin;
          this.isModerator = syncIsModerator;
          if (this.isAdmin !== wasAdmin) this.updateAdminSurfaces();
        }
        // While a COMBAT_HIT splat is pending for the local player, defer
        // applying the new HP so the bar/HUD drop in sync with the splat.
        this.applyLocalHealthFromServer(health, maxHealth, { clearPendingImpact: health >= maxHealth && health > this.playerHealth });
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
        const hiddenCatchup = this.isHiddenCatchupActive();
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
          this.applyLocalAppearance(syncAppearance);
        }
        return;
      }

      const isNew = !this.entities.remotePlayers.has(entityId);
      if (isNew) {
        const playerName = this.entities.playerNames.get(entityId) || 'Player';
        const remote = this.entities.createRemotePlayer(entityId, x, z, playerName, floor, y, syncAppearance);
        const cachedIsAdmin = hasRoleFlags ? syncIsAdmin : this.entities.remoteAdminFlags.get(entityId) === true;
        const cachedIsModerator = hasRoleFlags ? syncIsModerator : this.entities.remoteModeratorFlags.get(entityId) === true;
        if (hasRoleFlags) this.cacheRemotePlayerRole(entityId, cachedIsAdmin, cachedIsModerator);
        remote.setLabelColor(this.playerNameColor(cachedIsAdmin, cachedIsModerator));
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
          if (eq) this.applyRemoteEquipmentArray(remote, eq, entityId);
          const anim = this.remoteAnimationStates.get(entityId);
          if (anim) this.applyRemotePlayerAnimation(entityId, anim.kind, anim.variant, anim.targetId, anim.toolItemId);
        });
      }
      if (hasRoleFlags) this.setRemotePlayerRole(entityId, syncIsAdmin, syncIsModerator);
      if (syncCombatLevel > 0) this.entities.remoteCombatLevels.set(entityId, syncCombatLevel);
      if (syncAppearance) {
        const prev = this.entities.remoteAppearances.get(entityId);
        if (!appearanceEquals(prev ?? null, syncAppearance)) {
          this.entities.remoteAppearances.set(entityId, syncAppearance);
          const remote = this.entities.remotePlayers.get(entityId);
          if (remote && !isNew) {
            if (remote.getModelPath() !== getCharacterModelPath(syncAppearance)) {
              this.recreateRemotePlayer(entityId, syncAppearance);
            } else {
              // Only apply post-load — the new-entity path schedules it via
              // whenReady. Calling applyAppearance before load is a no-op.
              remote.applyAppearance(syncAppearance);
            }
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
      const moved = !prev || Math.abs(prev.x - x) > 0.001 || Math.abs(prev.z - z) > 0.001;
      if (moved) {
        // Grace = 1.5 server ticks. Long enough to bridge a normal 600 ms
        // tick gap plus jitter, short enough to drop to idle quickly when
        // the player actually stops walking.
        this.entities.remoteWalkUntil.set(entityId, performance.now() + 900);
      }
      this.entities.remoteTargets.set(entityId, {
        x,
        z,
        floor,
        y,
        prevX: prev ? (moved ? prev.x : prev.prevX) : x - 1,
        prevZ: prev ? (moved ? prev.z : prev.prevZ) : z,
      });
      const character = this.entities.remotePlayers.get(entityId)!;
      // Skip bar update if a COMBAT_HIT splat is pending — splat closure
      // applies the bar at impact time so they stay in sync.
      if (!this.pendingHealthApply.has(entityId)) {
        this.updateTransientHealthBar(entityId, character, health, maxHealth);
      }
    });

    this.network.on(ServerOpcode.PLAYER_SELF_SYNC, (_op, v) => {
      const serverX = (v[0] ?? 0) / 10;
      const serverZ = (v[1] ?? 0) / 10;
      const health = v[2] ?? this.playerHealth;
      const maxHealth = v[3] ?? this.playerMaxHealth;
      const tickLow = v[4] ?? 0;
      const serverMoving = (v[5] ?? 0) === 1;
      const hasAppearance = v.length >= 13 && v[6] >= 0;
      const syncAppearance: PlayerAppearance | null = hasAppearance
        ? v.length >= 6 + APPEARANCE_WIRE_FIELD_COUNT
          ? appearanceFromWireValues(v, 6)
          : { ...appearanceFromWireValues(v, 6), bodyType: 0 }
        : null;

      const now = performance.now();
      if (this.detectBufferedSelfSyncReplay(tickLow, now)) return;
      this.lastSelfAuthorityAt = now;
      this.lastSelfAuthorityWarnAt = 0;
      this.selfAuthorityGraceUntil = 0;
      this.latestSelfSync = { x: serverX, z: serverZ, moving: serverMoving };
      this.clearSpellMovementLockOnSelfSync();
      this.applyLocalHealthFromServer(health, maxHealth, { clearPendingImpact: health >= maxHealth && health > this.playerHealth });
      if (syncAppearance && !appearanceEquals(this.localAppearance, syncAppearance)) {
        this.applyLocalAppearance(syncAppearance);
      }

      const hiddenCatchup = this.isHiddenCatchupActive();
      if (hiddenCatchup && (document.visibilityState === 'hidden' || this.pathIndex >= this.path.length)) {
        // Catch-up reconciles onto the predicted path (fast-forward + keep
        // predicting) when the server is on it, and hard-snaps only on a real
        // divergence — never the per-tick slide that caused back-and-forth
        // jitter on tab return.
        this.reconcileLocalPlayerToServer(serverX, serverZ, true, serverMoving);
        return;
      }

      const dx = serverX - this.playerX;
      const dz = serverZ - this.playerZ;
      const maxAxisDelta = Math.max(Math.abs(dx), Math.abs(dz));
      const serverTileOnActiveStep = this.isTileOnActivePredictedStep(Math.floor(serverX), Math.floor(serverZ));
      // The first self-sync after a click can still be the old stopped tile.
      // Give a just-started prediction one tick before reanchoring into a slide.
      const freshPrediction = this.isFreshPredictedPath(now);
      const reconcileDist = serverMoving || serverTileOnActiveStep
        ? GameManager.SELF_SYNC_RECONCILE_DIST
        : freshPrediction
          ? GameManager.FRESH_PREDICTION_RECONCILE_DIST
          : GameManager.STOPPED_SELF_SYNC_RECONCILE_DIST;
      if (maxAxisDelta <= reconcileDist) return;

      if (!hiddenCatchup && this.tryReanchorPredictedPathToAuthority(serverX, serverZ)) return;

      this.reconcileLocalPlayerToServer(serverX, serverZ, false, serverMoving);
    });

    this.network.on(ServerOpcode.PLAYER_REMOTE_EQUIPMENT, (_op, v) => {
      // Layout: [entityId, weapon, shield, head, body, legs, neck, ring, hands, feet, cape, ammo]
      const entityId = v[0];
      const slots = v.slice(1, 1 + EQUIP_SLOT_NAMES.length);
      // Cache so the apply re-runs if/when the entity is (re)created.
      this.entities.remoteEquipment.set(entityId, slots);
      const remote = this.entities.remotePlayers.get(entityId);
      if (remote && remote.isReady) {
        this.applyRemoteEquipmentArray(remote, slots, entityId);
      }
    });

    this.network.on(ServerOpcode.PLAYER_REMOTE_STANCE, (_op, v) => {
      // Layout: [entityId, stanceIdx]. Index matches the server's stance order.
      const entityId = v[0];
      const idx = v[1] ?? 0;
      const stance = STANCE_KEYS[idx] ?? 'accurate';
      this.entities.remoteStances.set(entityId, stance);
      // Self-echo from the server — reconcile the sidePanel's optimistic
      // UI if the request was rejected or applied differently than expected.
      if (entityId === this.localPlayerId) this.sidePanel?.applyStanceFromServer(stance);
    });

    this.network.on(ServerOpcode.PLAYER_MAGIC_STATE, (_op, v) => {
      const spellIndex = Number.isInteger(v[0]) ? v[0] : -1;
      const idx = v[1] ?? 0;
      const magicStance = STANCE_KEYS[idx] ?? 'accurate';
      this.autoCastSpellIndex = spellIndex;
      this.sidePanel?.applyMagicStateFromServer(spellIndex, magicStance);
    });

    this.network.on(ServerOpcode.PLAYER_AUTO_RETALIATE, (_op, v) => {
      this.sidePanel?.applyAutoRetaliateFromServer((v[0] ?? 0) === 1);
    });

    this.network.on(ServerOpcode.PLAYER_ANIMATION, (_op, v) => {
      const entityId = v[0];
      const kind = (v[1] ?? PlayerAnimationKind.Idle) as PlayerAnimationKind;
      const variant = (v[2] ?? PlayerSkillAnimationVariant.None) as PlayerSkillAnimationVariant;
      const targetId = v[3] ?? 0;
      const toolItemId = v[4] ?? 0;

      if (entityId === this.localPlayerId) {
        if (kind === PlayerAnimationKind.Attack && this.localPlayer) {
          const animName = this.getPlayerAttackAnimName(entityId);
          this.adoptLocalNpcCombatTargetFromServer(targetId);
          this.lockCharacterAttackFacing(this.localPlayer, targetId, animName);
          this.localPlayer.playAttackAnimation(animName, true);
        } else if (kind === PlayerAnimationKind.Skill && variant === PlayerSkillAnimationVariant.Magic && this.localPlayer) {
          if (this.pendingSingleCastSpell < 0 || this.autoCastSpellIndex >= 0) {
            this.adoptLocalNpcCombatTargetFromServer(targetId);
          }
          if (targetId > 0) this.faceLocalPlayerTowardTarget(targetId);
          this.localPlayer.playNamedOneShot('spell_cast_2h', { layerWhenWalking: true });
        } else if (kind === PlayerAnimationKind.Idle && this.localPlayer) {
          this.adoptLocalNpcCombatTargetFromServer(targetId);
          if (targetId > 0) this.faceLocalPlayerTowardTarget(targetId);
          if (!this.localPlayer.isAttackAnimationPlaying()) this.localPlayer.resetTransientAnimation();
        } else if (targetId > 0) {
          this.faceLocalPlayerTowardTarget(targetId);
        }
        return;
      }

      this.remoteAnimationStates.set(entityId, { kind, variant, targetId, toolItemId });
      this.applyRemotePlayerAnimation(entityId, kind, variant, targetId, toolItemId);
    });

    this.network.on(ServerOpcode.NPC_SYNC, (_op, v) => {
      const [entityId, npcDefId, x10, z10, health, maxHealth] = v;
      if (this.entities.isDeathEffectActive(entityId)) return;

      const x = x10 / 10;
      const z = z10 / 10;
      const floor = v.length >= 7 ? Math.floor(v[6] ?? 0) : 0;
      const y = v.length >= 8 ? (v[7] ?? 0) / 10 : this.getHeightAtFloor(x, z, floor, 0);
      const facingQ = v.length >= 10 ? v[9] : NPC_FACING_NONE;
      const faceTargetId = v.length >= 11 ? (v[10] ?? 0) : 0;
      const combatLevel = v.length >= 12 ? (v[11] ?? 0) : 0;
      const visualScale = v.length >= 13 ? decodeNpcVisualScale(v[12]) : decodeNpcVisualScale(undefined);

      this.entities.npcDefs.set(entityId, npcDefId);
      if (combatLevel > 0) this.entities.npcCombatLevels.set(entityId, combatLevel);
      else this.entities.npcCombatLevels.delete(entityId);
      this.entities.npcVisualScales.set(entityId, visualScale);
      if (v.length >= 11) {
        if (faceTargetId > 0) this.entities.npcCombatTargets.set(entityId, faceTargetId);
        else this.entities.npcCombatTargets.delete(entityId);
      }
      if (Number.isFinite(facingQ) && facingQ !== NPC_FACING_NONE) {
        this.entities.npcFacingAngles.set(entityId, facingQ / 1000);
      }

      const newlyMaterialized = !this.entities.npcSprites.has(entityId);
      if (newlyMaterialized) {
        this.tryMaterializeNpc(entityId, npcDefId, x, z, floor, y);
      }

      const prev = this.entities.npcTargets.get(entityId);
      const npcTargetState = {
        x, z, floor, y,
        prevX: prev ? prev.x : x,
        prevZ: prev ? prev.z : z,
        t: performance.now(),
        continueWalking: (v[8] ?? 0) === 1,
      };
      this.entities.npcTargets.set(entityId, npcTargetState);

      const sprite = this.entities.npcSprites.get(entityId);
      sprite?.setVisualScale?.(visualScale);
      if (sprite && Number.isFinite(facingQ) && facingQ !== NPC_FACING_NONE && !sprite.isWalking()) {
        this.entities.applyCachedNpcFacing(entityId, sprite, newlyMaterialized);
      }
      this.refreshLocalCombatFacing(entityId, npcTargetState);
      if (sprite && !this.pendingHealthApply.has(entityId)) {
        this.updateTransientHealthBar(entityId, sprite, health, maxHealth);
      }
    });

    this.network.on(ServerOpcode.NPC_APPEARANCE, (_op, v) => {
      const entityId = v[0];
      const appearance = appearanceFromWireValues(v, 1);
      this.entities.npcAppearances.set(entityId, appearance);
      // Live-apply for an already-rendered customizable NPC (admin /npcedit).
      const sprite = this.entities.npcSprites.get(entityId);
      if (sprite instanceof CharacterEntity && sprite.isReady) {
        const npcDefId = this.entities.npcDefs.get(entityId);
        const expectedModelPath = resolveNpcVisualConfig(
          npcDefId ?? 0,
          npcDefId != null ? this.npcDefsCache.get(npcDefId) : null,
          appearance,
        ).characterModelPath;
        if (sprite.getModelPath() !== expectedModelPath) {
          const target = this.entities.npcTargets.get(entityId);
          this.entities.disposeNpcSprite(entityId);
          if (npcDefId != null && target) this.tryMaterializeNpc(entityId, npcDefId, target.x, target.z, target.floor, target.y);
        } else {
          const custom = this.entities.npcCustomColors.get(entityId);
          sprite.applyAppearance(appearance, custom ?? null);
        }
      }
    });

    this.network.on(ServerOpcode.NPC_CUSTOM_COLORS, (_op, v) => {
      // Wire layout = [entityId, ...3 ints per slot] in CUSTOM_COLOR_SLOTS
      // order. R = -1 means "no override for this slot" (use the palette pick
      // from NPC_APPEARANCE). Each R/G/B is quantized 0..1000.
      const entityId = v[0];
      const custom: CustomColors = {};
      for (let i = 0; i < CUSTOM_COLOR_SLOTS.length; i++) {
        const base = 1 + i * 3;
        const r = v[base];
        if (r < 0) continue;
        custom[CUSTOM_COLOR_SLOTS[i]] = [r / 1000, v[base + 1] / 1000, v[base + 2] / 1000];
      }
      this.entities.npcCustomColors.set(entityId, custom);
      const sprite = this.entities.npcSprites.get(entityId);
      if (sprite instanceof CharacterEntity && sprite.isReady) {
        const appearance = this.entities.npcAppearances.get(entityId);
        if (appearance) sprite.applyAppearance(appearance, custom);
      }
    });

    this.network.on(ServerOpcode.NPC_EQUIPMENT, (_op, v) => {
      // Layout: [entityId, weapon, shield, head, body, legs, neck, ring, hands, feet, cape, ammo]
      const entityId = v[0];
      const slots = v.slice(1, 1 + EQUIP_SLOT_NAMES.length);
      this.entities.npcEquipment.set(entityId, slots);
      const sprite = this.entities.npcSprites.get(entityId);
      if (sprite instanceof CharacterEntity && sprite.isReady) {
        this.applyRemoteEquipmentArray(sprite, slots, entityId);
      } else if (sprite instanceof Npc3DEntity && sprite.isReady) {
        this.applyNpcModelEquipmentArray(sprite, slots, entityId);
      }
    });

    this.network.on(ServerOpcode.NPC_INTERACTIONS, (_op, v) => {
      // [entityId, flagBits]. Cached so the right-click menu can offer
      // Talk-to / Trade / Bank without round-tripping every click.
      // Bit 3 marks dialogue that can transition into NPC combat.
      this.entities.npcInteractions.set(v[0], v[1]);
    });

    this.network.on(ServerOpcode.NPC_FACING, (_op, v) => {
      // [entityId, angleQ1000] — 2004scape NPC.faceEntity. Both sprite
      // classes expose setTargetFacing; the per-frame yaw lerp handles
      // the smooth turn.
      const [entityId, angleQ] = v;
      const angle = angleQ / 1000;
      this.entities.npcFacingAngles.set(entityId, angle);
      this.entities.npcSprites.get(entityId)?.setTargetFacing(angle);
    });

    this.network.on(ServerOpcode.GROUND_ITEM_SYNC, (_op, v) => {
      // Layout: [groundItemId, itemId, qtyHigh, qtyLow, x10, z10, floor, y10]
      const [groundItemId, itemId, qtyHi, qtyLo] = v;
      if (itemId === 0) {
        this.entities.removeGroundItem(groundItemId);
        return;
      }

      const quantity = (qtyHi & 0xFFFF) * 0x10000 + (qtyLo & 0xFFFF);
      const x = (v[4] ?? 0) / 10;
      const z = (v[5] ?? 0) / 10;
      const floor = v.length >= 7 ? Math.floor(v[6] ?? 0) : 0;
      const y = v.length >= 8 ? (v[7] ?? 0) / 10 : this.getHeightAtFloor(x, z, floor, 0);
      this.entities.createGroundItem(groundItemId, itemId, quantity, x, z, floor, y);
    });

    this.network.on(ServerOpcode.ENTITY_DEATH, (_op, v) => {
      const entityId = v[0];
      const deathKind = (v[1] ?? EntityDeathKind.Despawn) as EntityDeathKind;
      const isTrueDeath = deathKind === EntityDeathKind.Death;

      const wasLocalCombatTarget = entityId === this.combatTargetId || entityId === this.magicTargetId;
      if (wasLocalCombatTarget) {
        this.clearLocalNpcCombatState();
        this.pendingFaceTargetEntityId = -1;
        this._combatPathTimer = 0;
        // The server clears combat target with an Idle packet that excludes
        // the attacker. Clear the local bow/melee face-lock here so its timer
        // cannot expire back to an old travel yaw after the target is gone.
        this.localPlayer?.clearFaceLock(true);
      }

      this.entities.cleanupCombatTargetsFor(entityId);
      this.remoteAnimationStates.delete(entityId);
      this.toolSwappedEntities.delete(entityId);
      const deathEffectStarted = isTrueDeath && entityId !== this.localPlayerId
        ? this.entities.startEntityDeathEffect(entityId)
        : false;
      if (isTrueDeath && entityId === this.localPlayerId) {
        this.hideAllTransientHealthBars();
      } else if (!isTrueDeath || !deathEffectStarted) {
        this.hideTransientHealthBar(entityId);
      }
      if (isTrueDeath && entityId === this.localPlayerId && this.localPlayer) {
        this.playLocalPlayerDeathEffect();
      }
      if (!deathEffectStarted) {
        this.entities.removeRemotePlayer(entityId);
        this.entities.removeNpc(entityId);
      }
      this.entities.removeGroundItem(entityId);
      const objectData = this.worldObjectDefs.get(entityId);
      if (objectData) {
        const def = this.objectDefsCache.get(objectData.defId);
        if (def) this.setObjectTilesBlocked(objectData.x, objectData.z, def, false, objectData.floor, objectData.interactionTiles, objectData.rotY);
        if (def?.category === 'door') this.setCenteredDoorTileBlocked(entityId, objectData, def, false);
        const model = this.worldObjectModels.get(entityId);
        if (model) this.setWorldObjectPickTarget(entityId, false, model);
        this.objectModels.deleteStump(entityId);
        this.disposeDoorVisualState(entityId);
        this.disposeWorldObjectPickProxy(entityId);
        if (model && this.chunkManager.isPlacedObjectNode(model) && !model.isDisposed()) {
          // Keep the placed-node association across floor/range visibility
          // churn. Re-entering a dense ground floor can resync hundreds of
          // object entities in one packet batch; avoiding the spatial relink
          // pass keeps ladder-down floor swaps from hitching.
          this.setWorldObjectModel(entityId, model);
        } else {
          this.deleteWorldObjectModel(entityId);
        }
        this.worldObjectDefs.delete(entityId);
      }
    });
  }

  private setupCombatHandlers(): void {
    this.network.on(ServerOpcode.COMBAT_HIT, (_op, v) => {
      const [attackerId, targetId, damage, targetHp, targetMaxHp] = v;

      if (targetId === -1) {
        this.entities.npcCombatTargets.delete(attackerId);
        const sprite = this.entities.npcSprites.get(attackerId);
        if (targetHp > 0 && !this.entities.isDeathEffectActive(attackerId)) {
          this.hideTransientHealthBar(attackerId, sprite ?? null);
        }
        if (sprite instanceof CharacterEntity) sprite.clearFaceLock();
        return;
      }

      const targetEntity = this.resolveTargetableIncludingLocal(targetId);
      const targetHealthBarHost = asHealthBarHost(targetEntity);

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
      // CharacterEntity-rendered NPCs share the player rig + animation set,
      // so weapon-driven attack-anim picking (1H slash, 2H smash, stab, etc.)
      // applies to them too. Sprite/3D-mob NPCs go through their own
      // playAttackAnimation() with no variant.
      const npcAsCharacter = !isPlayerAttacker && attackerEntity instanceof CharacterEntity;
      const animName = isPlayerAttacker || npcAsCharacter
        ? this.getPlayerAttackAnimName(attackerId)
        : 'attack_punch';

      // NPCs still animate from COMBAT_HIT. Player attacks are now driven by
      // PLAYER_ANIMATION so swings broadcast even when there is no visible
      // damage packet in a given viewer's area.
      if (!isPlayerAttacker && attackerEntity) {
        if (npcAsCharacter) {
          (attackerEntity as CharacterEntity).playAttackAnimation(animName);
        } else {
          asAttackAnimationHost(attackerEntity)?.playAttackAnimation?.();
        }
      }

      // Schedule the hitsplat at the impact moment of the attacker's animation
      const fraction = GameManager.ATTACK_IMPACT_FRACTION[animName] ?? 0.5;
      // Prefer the actual loaded anim duration (local player has a CharacterEntity).
      // Fall back to a fixed estimate for sprites/NPCs that don't expose durations.
      const liveDuration = asAttackAnimationHost(attackerEntity)?.getAnimationDurationMs?.(animName) ?? 0;
      const impactMs = animName === 'bow_attack' && attackerEntity && targetEntity
        ? this.getRangedProjectileImpactMs(attackerEntity, targetEntity)
        : (liveDuration > 0 ? liveDuration : 800) * fraction;
      if (targetId === this.localPlayerId) this.clearPendingLocalHealthSync();
      const splatAtTarget = () => {
        if (this.destroyed) {
          this.pendingHealthApply.delete(targetId);
          return;
        }
        if (targetId !== this.localPlayerId && targetEntity) {
          this.showHitSplat(this.hitSplatBasePositionFor(targetEntity), damage);
          if (targetHealthBarHost) this.showTransientHealthBar(targetId, targetHealthBarHost, targetHp, targetMaxHp);
        }
        if (targetId === this.localPlayerId && this.localPlayer) {
          this.showHitSplat(this.hitSplatBasePositionFor(this.localPlayer), damage);
          this.playerHealth = targetHp;
          this.playerMaxHealth = targetMaxHp;
          this.updateHUD();
          this.showTransientHealthBar(this.localPlayerId, this.localPlayer, targetHp, targetMaxHp);
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
      const [attackerId, targetId, projectileType] = v;
      const attacker = this.resolveTargetableIncludingLocal(attackerId);
      const target = this.resolveTargetableIncludingLocal(targetId);
      if (!attacker || !target) return;
      const projectileOptions = v.length >= 11 && v.slice(3, 11).every(Number.isFinite)
        ? {
            from: new Vector3(v[3] / 10, v[7] / 10, v[4] / 10),
            to: new Vector3(v[5] / 10, v[8] / 10, v[6] / 10),
            travelMs: Math.max(1, v[9]),
            arcHeight: Math.max(0, v[10] / 10),
            projectileType,
          }
        : undefined;
      this.arrowProjectiles.spawn(attacker, target, this.getRangedProjectileReleaseMs(attacker), projectileOptions);
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
    const isLocalCaster = casterId === this.localPlayerId;
    const caster = isLocalCaster
      ? this.localPlayer
      : (this.entities.remotePlayers.get(casterId) ?? null);
    const target = this.entities.resolveTargetable(targetId);
    if (!caster || !target) {
      if (isLocalCaster) this.finishPendingSingleSpellCast(targetId);
      return;  // caster/target out of our chunk window
    }
    this.playSpellEffect(caster, target, def);

    if (isLocalCaster) this.finishPendingSingleSpellCast(targetId);
  }

  private playLevelUpFirework(entityId: number | undefined): void {
    if (typeof entityId !== 'number' || !Number.isFinite(entityId)) return;
    const target = this.resolveTargetableIncludingLocal(entityId);
    if (!target) return;
    LevelUpFireworkEffect.play(this.scene, target.getTargetAnchor().add(new Vector3(0, 1.15, 0)));
  }

  private finishPendingSingleSpellCast(targetId: number): void {
    if (this.pendingSingleCastSpell < 0) return;
    this.pendingSingleCastSpell = -1;
    if (this.autoCastSpellIndex >= 0) {
      this.combatTargetId = -1;
      this.magicTargetId = targetId;
      this._combatPathTimer = 0;
      return;
    }
    this.magicTargetId = -1;
  }

  private setupWorldObjectHandlers(): void {
    this.network.on(ServerOpcode.SHOP_OPEN, (_op, v) => {
      const npcEntityId = v[0];
      const itemCount = v[1];
      const items: ShopItem[] = [];
      for (let i = 0; i < itemCount; i++) {
        const base = 2 + i * 4;
        items.push({
          itemId: v[base],
          price: (v[base + 1] & 0xFFFF) * 0x10000 + (v[base + 2] & 0xFFFF),
          stock: v[base + 3],
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

    this.network.on(ServerOpcode.SHOP_CLOSE, () => {
      this.shopPanel?.hide();
    });

    this.network.on(ServerOpcode.WORLD_OBJECT_SYNC, (_op, v) => {
      const [objectEntityId, objectDefId, x10, z10, depleted, interactionSides = 0, rotY1000 = 0] = v;
      const x = x10 / 10;
      const z = z10 / 10;
      const isDepleted = depleted === 1;
      const floor = v.length >= 10 ? Math.floor(v[7] ?? 0) : 0;
      const y = v.length >= 10 ? (v[8] ?? 0) / 10 : this.getHeightAtFloor(x, z, floor, 0);
      const explicitTileCount = v.length >= 10 ? v[9] ?? 0 : v[7] ?? 0;
      const explicitStart = v.length >= 10 ? 10 : 8;
      const interactionTiles: { x: number; z: number }[] = [];
      const count = Math.max(0, Math.min(16, explicitTileCount | 0));
      for (let i = 0; i < count; i++) {
        const ix = v[explicitStart + i * 2];
        const iz = v[explicitStart + i * 2 + 1];
        if (Number.isFinite(ix) && Number.isFinite(iz)) interactionTiles.push({ x: ix, z: iz });
      }
      const doorOpenDirectionRaw = v[explicitStart + count * 2];
      const openDirection: -1 | 1 = doorOpenDirectionRaw === 1 ? 1 : -1;
      const locked = v[explicitStart + count * 2 + 1] === 1;
      const ladderActionMask = v[explicitStart + count * 2 + 2];

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

      if (prev) {
        const prevDef = this.objectDefsCache.get(prev.defId);
        if (prevDef?.category === 'door') this.setCenteredDoorTileBlocked(objectEntityId, prev, prevDef, false);
      }

      const objectData = {
        defId: objectDefId,
        x,
        z,
        floor,
        y,
        depleted: isDepleted,
        interactionSides: interactionSides || undefined,
        rotY: rotY1000 / 1000,
        openDirection,
        locked,
        interactionTiles: interactionTiles.length ? interactionTiles : undefined,
        ladderActionMask: Number.isFinite(ladderActionMask) ? ladderActionMask : undefined,
      };
      this.worldObjectDefs.set(objectEntityId, objectData);

      const def = this.objectDefsCache.get(objectDefId);

      if (stateChangedForDoor) {
        const doorEntry = this.doorPivots.get(objectEntityId);
        if (doorEntry) doorEntry.openDirection = openDirection;
        const rotY = doorEntry ? doorEntry.closedRotY : 0;
        const { tile: [tx, tz], edge } = doorEdgeFromPlacement(x, z, rotY);
        this.chunkManager.setOpenDoorEdges(tx, tz, edge, isDepleted, floor);
        const nb = DOOR_EDGE_NEIGHBOR[edge];
        if (nb) {
          this.chunkManager.setOpenDoorEdges(tx + nb.dx, tz + nb.dz, nb.opposite, isDepleted, floor);
        }
        // animateDoor only runs if the pivot exists; if it doesn't yet (chunk
        // still loading), linkPlacedNodeToEntity will pick the correct pose
        // when it sets the pivot up.
        this.animateDoor(objectEntityId, isDepleted, 0);
      }

      if (def?.category === 'door') {
        this.setCenteredDoorTileBlocked(objectEntityId, objectData, def, !isDepleted);
        // Edge detection deferred until model is linked — handled in linkPlacedNodeToEntity / onChunkObjectsLoaded
      } else if (def) {
        // Depleted state intentionally ignored — depleted ores/stumps still
        // occupy their tile (matches server policy at the depletion site).
        this.setObjectTilesBlocked(x, z, def, true, floor, interactionTiles.length ? interactionTiles : undefined, objectData.rotY);
      }

      // Try to link to an editor-placed GLB model. Cached placed-node links are
      // kept across floor/range visibility churn, but doors still need their
      // pivot and wall-edge bookkeeping rebuilt after ENTITY_DEATH removed it.
      let model = this.worldObjectModels.get(objectEntityId);
      if (!model) {
        const placedNode = this.chunkManager.findPlacedObjectNear(
          x,
          z,
          1.5,
          objectDefId,
          y,
          node => this.canLinkPlacedNodeToWorldObject(objectEntityId, node),
        );
        if (placedNode) {
          this.linkPlacedNodeToEntity(objectEntityId, { defId: objectDefId, x, z, floor, y, depleted: isDepleted, openDirection, locked }, placedNode);
          model = placedNode;
        }
        if (!model && def?.modelAssetId) {
          const activeModel = this.objectModels.createActiveModel(
            objectEntityId,
            def,
            x,
            z,
            y,
            rotY1000 / 1000,
            isDepleted,
          );
          if (activeModel) {
            this.setWorldObjectModel(objectEntityId, activeModel);
            this.setWorldObjectPickTarget(objectEntityId, false, activeModel);
            if (def.category !== 'crop' && def.category !== 'door') {
              this.setGenericWorldObjectPickTarget(
                objectEntityId,
                objectData,
                def,
                this.isWorldObjectInteractable(def, isDepleted),
                activeModel,
              );
            }
            model = activeModel;
          }
        }
        // If no placed GLB exists, runtime-spawned object defs can provide a
        // modelAssetId fallback (fires, temporary skill objects, etc.).
      } else if (def?.category === 'door' && !this.doorPivots.has(objectEntityId)) {
        this.linkPlacedNodeToEntity(objectEntityId, { defId: objectDefId, x, z, floor, y, depleted: isDepleted, openDirection, locked }, model);
      }

      // Update depletion visuals
      if (model) {
        if (def?.category === 'door') {
          // Doors stay visible — animate rotation instead
          model.setEnabled(true);
          this.setWorldObjectPickTarget(objectEntityId, false, model);
          this.disposeWorldObjectPickProxy(objectEntityId);
          if (!this.doorPickProxies.has(objectEntityId)) {
            const rotY = this.doorPivots.get(objectEntityId)?.closedRotY ?? (rotY1000 / 1000);
            this.createDoorPickProxy(objectEntityId, x, z, rotY, model.getAbsolutePosition().y);
          }
        }
        const hasDepleteModel = this.objectDefHasDepletedModel(def);
        let depletedModel = this.objectModels.getStump(objectEntityId);
        if (!depletedModel && hasDepleteModel && isDepleted) {
          depletedModel = this.objectModels.createDepletedModel(objectEntityId, objectDefId, model);
        }
        if (depletedModel) {
          this.objectModels.syncDepletedModelTransform(objectEntityId, model);
          depletedModel.setEnabled(isDepleted);
          this.setWorldObjectPickTarget(objectEntityId, false, depletedModel);
        }
        if (def && def.category !== 'door') {
          this.setPlacedWorldObjectEnabled(model, !isDepleted);
          if (def?.category === 'crop') {
            this.disposeWorldObjectPickProxy(objectEntityId);
            this.setCropPickTarget(objectEntityId, def, isDepleted, model);
          } else {
            this.setGenericWorldObjectPickTarget(
              objectEntityId,
              objectData,
              def,
              this.isWorldObjectInteractable(def, isDepleted),
              model,
            );
          }
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
          const floor = data.floor ?? 0;

          const opened = isDepleted === 1;
          // Leave the wall mask alone — only toggle openDoorEdges. The
          // wall-block check uses elevation-gated openDoorEdges as the
          // bypass mechanism (see ChunkManager.wallEdgeBlocksAtHeight), so
          // clearing the mask would let players at the wrong elevation
          // skip through.
          this.chunkManager.setOpenDoorEdges(tx, tz, edge, opened, floor);
          const nb = DOOR_EDGE_NEIGHBOR[edge];
          if (nb) {
            const nx = tx + nb.dx, nz = tz + nb.dz;
            this.chunkManager.setOpenDoorEdges(nx, nz, nb.opposite, opened, floor);
          }

          this.setCenteredDoorTileBlocked(objectEntityId, data, def2, !opened);
          this.animateDoor(objectEntityId, opened, swingSign || 0);
          // Depleted ores/stumps keep their blocking tile — see chunk-entry
          // case in WORLD_OBJECT_SYNC above. Doors animate + toggle edges;
          // everything else: no-op on depletion.
        }
      }

      const def = data ? this.objectDefsCache.get(data.defId) : null;
      const hasDepleteModel = this.objectDefHasDepletedModel(def);

      if (def?.category === 'door') {
        // Doors stay visible — animation is handled above
      } else {
        const model = this.worldObjectModels.get(objectEntityId);
        if (def && hasDepleteModel && data) {
          const placedNode = model ?? this.chunkManager.findPlacedObjectNear(
            data.x,
            data.z,
            1.5,
            data.defId,
            data.y,
            node => this.canLinkPlacedNodeToWorldObject(objectEntityId, node),
          );
          if (placedNode) {
            if (!model) this.setWorldObjectModel(objectEntityId, placedNode);
            let depleted = this.objectModels.getStump(objectEntityId);
            if (!depleted && isDepleted === 1) {
              depleted = this.objectModels.createDepletedModel(objectEntityId, data.defId, placedNode);
            }
            if (depleted) {
              this.objectModels.syncDepletedModelTransform(objectEntityId, placedNode);
              depleted.setEnabled(isDepleted === 1);
              this.setWorldObjectPickTarget(objectEntityId, false, depleted);
            }
            this.setPlacedWorldObjectEnabled(placedNode, isDepleted === 0);
            if (def?.category === 'crop') {
              this.disposeWorldObjectPickProxy(objectEntityId);
              this.setCropPickTarget(objectEntityId, def, isDepleted === 1, placedNode);
            } else {
              this.setGenericWorldObjectPickTarget(objectEntityId, data, def, isDepleted === 0, placedNode);
            }
          }
        } else if (model && def && data) {
          this.setPlacedWorldObjectEnabled(model, isDepleted === 0);
          if (def?.category === 'crop') {
            this.disposeWorldObjectPickProxy(objectEntityId);
            this.setCropPickTarget(objectEntityId, def, isDepleted === 1, model);
          } else {
            this.setGenericWorldObjectPickTarget(
              objectEntityId,
              data,
              def,
              this.isWorldObjectInteractable(def, isDepleted === 1),
              model,
            );
          }
        } else if (model) {
          this.setWorldObjectPickTarget(objectEntityId, false, model);
          this.disposeWorldObjectPickProxy(objectEntityId);
        }
      }
    });

    this.network.on(ServerOpcode.WORLD_OBJECT_ANIMATION, (_op, v) => {
      const objectEntityId = v[0] ?? -1;
      this.playWorldObjectAnimation(objectEntityId);
    });

    this.network.on(ServerOpcode.SKILLING_START, (_op, v) => {
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
        this.chatPanel.addSystemMessage(message, '#8cf', { foldConsecutive: true });
      }
      // Chests have no skilling animation — the player stands still while
      // the lockpick cycle ticks on the server. All other harvestables get
      // a category-specific looping anim (chop/mine).
      const variant = objDef?.category === 'tree' ? 'chop'
        : objDef?.category === 'rock' ? 'mine'
        : undefined;
      const skipAnim = objDef?.category === 'chest';

      const objectId = v[0];
      void (async () => {
        const player = this.localPlayer;
        if (player && toolItemId > 0) {
          await this.applySkillingTool(this.localPlayerId, player, toolItemId);
        }
        if (!this.isSkilling || this.skillingObjectId !== objectId) return;
        if (player && this.localPlayer !== player) return;
        if (skipAnim) {
          this.startSkillingStationary(objectId);
        } else {
          this.startSkillingVisual(objectId, variant);
        }
      })();
    });

    this.network.on(ServerOpcode.SKILLING_STOP, (_op, _v) => {
      this.endLocalSkilling();
    });

    this.network.on(ServerOpcode.SMITHING_OPEN, (_op, v) => {
      const objectEntityId = v[0];
      const data = this.worldObjectDefs.get(objectEntityId);
      const def = data ? this.objectDefsCache.get(data.defId) : null;
      if (!def?.recipes || def.recipes.length === 0) return;
      this.showSmithingUI(objectEntityId, def);
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
      this.applyLocalHealthFromServer(v[0], v[1], { clearPendingImpact: v[0] >= v[1] && v[0] > this.playerHealth });
    });

    this.network.on(ServerOpcode.RENOWN_SYNC, (_op, v) => {
      this.sidePanel?.setRenown(v[0] ?? 0);
    });

    // Batch inventory: [slot0_itemId, slot0_qtyHigh, slot0_qtyLow, ...] — quantity
    // is split into high/low words so stacks past int16 don't wrap (see sendInventory).
    this.network.on(ServerOpcode.PLAYER_INVENTORY_BATCH, (_op, v) => {
      for (let i = 0; i + 3 <= v.length; i += 3) {
        const slot = i / 3;
        const itemId = v[i];
        const qty = (v[i + 1] & 0xFFFF) * 0x10000 + (v[i + 2] & 0xFFFF);
        if (this.sidePanel) this.sidePanel.updateInvSlot(slot, itemId, qty);
        if (this.bankPanel) this.bankPanel.updateInventorySlot(slot, itemId, qty);
        if (this.tradePanel) this.tradePanel.updateInventorySlot(slot, itemId, qty);
        if (this.duelPanel) this.duelPanel.updateInventorySlot(slot, itemId, qty);
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
        const qty = (v[base + 2] & 0xFFFF) * 0x10000 + (v[base + 3] & 0xFFFF);
        filled.push({ slot: v[base], itemId: v[base + 1], quantity: qty });
      }
      this.bankPanel?.openWithContents(filled);
    });
    this.network.on(ServerOpcode.BANK_UPDATE_SLOT, (_op, v) => {
      const [slot, itemId, qtyHi, qtyLo] = v;
      const qty = (qtyHi & 0xFFFF) * 0x10000 + (qtyLo & 0xFFFF);
      this.bankPanel?.updateBankSlot(slot, itemId, qty);
    });
    this.network.on(ServerOpcode.BANK_CLOSE, () => {
      this.bankPanel?.hide(/*notifyServer*/ false);
    });

    // --- Trade ---
    this.network.on(ServerOpcode.TRADE_REQUEST_RECEIVED, (_op, v) => {
      const requesterEntityId = v[0];
      const name = this.entities.playerNames.get(requesterEntityId) ?? `Player ${requesterEntityId}`;
      this.chatPanel?.addTradeRequestMessage(
        name,
        () => this.acceptTradeRequest(requesterEntityId, name),
        () => this.requestTrade(requesterEntityId),
      );
    });
    this.network.on(ServerOpcode.TRADE_OPEN, (_op, v) => {
      const otherEntityId = v[0];
      const name = this.entities.playerNames.get(otherEntityId) ?? `Player ${otherEntityId}`;
      this.currentTradePartnerName = name;
      this.tradePanel?.openSession(otherEntityId, name);
      this.enableTradeInventoryOffers();
      this.chatPanel?.addSystemMessage(`Trade accepted. Trading with ${name}.`, '#ff0');
    });
    this.network.on(ServerOpcode.TRADE_OFFER_UPDATE, (_op, v) => {
      const [side, slot, itemId, qtyHi, qtyLo] = v;
      const qty = (qtyHi & 0xFFFF) * 0x10000 + (qtyLo & 0xFFFF);
      this.tradePanel?.updateOffer(side, slot, itemId, qty);
    });
    this.network.on(ServerOpcode.TRADE_ACCEPT_STATE, (_op, v) => {
      this.tradePanel?.updateAcceptState(v[0] ?? 0, v[1] ?? 0);
    });
    this.network.on(ServerOpcode.TRADE_CLOSE, (_op, v) => {
      const reason = v[0] ?? 2;
      const partnerName = this.currentTradePartnerName || 'player';
      this.tradePanel?.close(reason);
      this.sidePanel?.setTradeOfferCallback(null);
      if (reason === 0) this.chatPanel?.addSystemMessage('Trade completed.', '#ff0');
      else if (reason === 1) this.chatPanel?.addSystemMessage(`Trade with ${partnerName} declined.`, '#ff0');
      else this.chatPanel?.addSystemMessage(`Trade with ${partnerName} ended.`, '#ff0');
      this.currentTradePartnerName = '';
    });
    this.network.on(ServerOpcode.TRADE_TEST_OPEN, () => {
      this.tradePanel?.openPreview('no-one');
      this.enableTradeInventoryOffers();
    });

    // --- Duel ---
    this.network.on(ServerOpcode.DUEL_REQUEST_RECEIVED, (_op, v) => {
      const requesterEntityId = v[0];
      const name = this.entities.playerNames.get(requesterEntityId) ?? `Player ${requesterEntityId}`;
      this.chatPanel?.addDuelRequestMessage(
        name,
        () => this.acceptDuelRequest(requesterEntityId, name),
        () => this.requestDuel(requesterEntityId),
      );
    });
    this.network.on(ServerOpcode.DUEL_OPEN, (_op, v) => {
      const otherEntityId = v[0];
      const name = this.entities.playerNames.get(otherEntityId) ?? `Player ${otherEntityId}`;
      this.currentDuelPartnerName = name;
      this.currentDuelOpponentEntityId = otherEntityId;
      this.duelActive = false;
      this.duelPanel?.openSession(otherEntityId, name);
      this.enableDuelInventoryStakes();
      this.chatPanel?.addSystemMessage(`Duel accepted. Staking with ${name}.`, '#ff0');
    });
    this.network.on(ServerOpcode.DUEL_STAKE_UPDATE, (_op, v) => {
      const [side, slot, itemId, qtyHi, qtyLo] = v;
      const qty = (qtyHi & 0xFFFF) * 0x10000 + (qtyLo & 0xFFFF);
      this.duelPanel?.updateStake(side, slot, itemId, qty);
    });
    this.network.on(ServerOpcode.DUEL_ACCEPT_STATE, (_op, v) => {
      this.duelPanel?.updateAcceptState(v[0] ?? 0, v[1] ?? 0);
    });
    this.network.on(ServerOpcode.DUEL_CLOSE, (_op, v) => {
      const reason = v[0] ?? 2;
      const partnerName = this.currentDuelPartnerName || 'player';
      this.duelPanel?.close(reason);
      this.sidePanel?.setTradeOfferCallback(null);
      if (reason === 1) this.chatPanel?.addSystemMessage(`Duel with ${partnerName} declined.`, '#ff0');
      else this.chatPanel?.addSystemMessage(`Duel with ${partnerName} ended.`, '#ff0');
      this.currentDuelPartnerName = '';
      this.clearDuelFaceTarget();
      this.currentDuelOpponentEntityId = -1;
      this.duelActive = false;
    });
    this.network.on(ServerOpcode.DUEL_START, (_op, v) => {
      const otherEntityId = v[0];
      const name = this.entities.playerNames.get(otherEntityId) ?? (this.currentDuelPartnerName || `Player ${otherEntityId}`);
      this.currentDuelPartnerName = name;
      this.currentDuelOpponentEntityId = otherEntityId;
      this.duelPanel?.close(0);
      this.sidePanel?.setTradeOfferCallback(null);
      this.duelActive = true;
      this.clearPredictedPath(true);
      this.localPlayer?.stopWalking();
      this.faceLocalPlayerTowardTarget(otherEntityId);
      this.refreshDuelFacing();
      this.minimap?.clearDestination();
      this.chatPanel?.addSystemMessage(`Duel started with ${name}.`, '#ff0');
    });
    this.network.on(ServerOpcode.DUEL_FINISH, (_op, v) => {
      const [winnerId, loserId, reason] = v;
      this.duelActive = false;
      this.clearDuelFaceTarget();
      const partnerName = this.currentDuelPartnerName || 'player';
      if (winnerId === this.localPlayerId) {
        this.chatPanel?.addSystemMessage(`You defeated ${partnerName}.`, '#ff0');
      } else if (loserId === this.localPlayerId) {
        this.chatPanel?.addSystemMessage(`You lost the duel with ${partnerName}.`, '#ff0');
      } else if (reason === 2) {
        this.chatPanel?.addSystemMessage('Duel ended with no winner.', '#ff0');
      } else {
        this.chatPanel?.addSystemMessage(`Duel with ${partnerName} ended.`, '#ff0');
      }
      this.currentDuelPartnerName = '';
      this.currentDuelOpponentEntityId = -1;
    });

    this.network.on(ServerOpcode.PLAYER_SKILLS, (_op, v) => {
      const [skillIndex, level, currentLevel, xpHigh, xpLow] = v;
      const xp = (xpHigh & 0xFFFF) * 0x10000 + (xpLow & 0xFFFF);
      if (this.sidePanel) {
        this.sidePanel.updateSkill(skillIndex, level, currentLevel, xp);
      }
      this.updateMobileMagicStatus(skillIndex, level, currentLevel);
      if (skillIndex === ALL_SKILLS.indexOf('hitpoints')) {
        this.applyLocalHealthFromServer(currentLevel, level, { clearPendingImpact: currentLevel >= level && currentLevel > this.playerHealth });
      }
    });

    // Batch skills: [skill0_level, skill0_currentLevel, skill0_xpHigh, skill0_xpLow, ...]
    this.network.on(ServerOpcode.PLAYER_SKILLS_BATCH, (_op, v) => {
      for (let i = 0; i < v.length; i += 4) {
        const skillIndex = i / 4;
        const level = v[i], currentLevel = v[i + 1];
        const xp = (v[i + 2] & 0xFFFF) * 0x10000 + (v[i + 3] & 0xFFFF);
        this.sidePanel?.updateSkill(skillIndex, level, currentLevel, xp);
        this.updateMobileMagicStatus(skillIndex, level, currentLevel);
        if (skillIndex === ALL_SKILLS.indexOf('hitpoints')) {
          this.applyLocalHealthFromServer(currentLevel, level, { clearPendingImpact: currentLevel >= level && currentLevel > this.playerHealth });
        }
      }
      this.noteLoginBootstrapPacket('skills');
    });

    this.network.on(ServerOpcode.PLAYER_EQUIPMENT, (_op, v) => {
      if (this.isSkilling) this.endLocalSkilling();
      const [slotIndex, itemId] = v;
      const quantity = decodeQuantityValues(v, 2, itemId ? 1 : 0);
      this.localEquipment.set(slotIndex, itemId);
      if (this.sidePanel) {
        this.sidePanel.updateEquipSlot(slotIndex, itemId, quantity);
      }
      // Attach/detach 3D gear on local player
      const gearLoad = this.equipGear(slotIndex, itemId);
      if (this._loginBootstrapPending) this._pendingLoginGearLoads.push(gearLoad);
    });

    // Batch equipment: [slot0_itemId, slot1_itemId, ..., ammoQtyHigh, ammoQtyLow]
    this.network.on(ServerOpcode.PLAYER_EQUIPMENT_BATCH, (_op, v) => {
      const slotCount = EQUIP_SLOT_NAMES.length;
      const ammoSlotIndex = EQUIP_SLOT_NAMES.indexOf('ammo');
      const ammoItemId = ammoSlotIndex >= 0 ? (v[ammoSlotIndex] ?? 0) : 0;
      const ammoQuantity = ammoSlotIndex >= 0
        ? decodeQuantityValues(v, slotCount, ammoItemId ? 1 : 0)
        : 0;
      if (this.sidePanel) {
        for (let i = 0; i < slotCount; i++) {
          const itemId = v[i] ?? 0;
          const quantity = i === ammoSlotIndex ? ammoQuantity : (itemId ? 1 : 0);
          this.sidePanel.updateEquipSlot(i, itemId, quantity);
          this.localEquipment.set(i, itemId);
        }
      }
      // Attach/detach 3D gear on local player
      for (let i = 0; i < slotCount; i++) {
        const gearLoad = this.equipGear(i, v[i] ?? 0);
        if (this._loginBootstrapPending) this._pendingLoginGearLoads.push(gearLoad);
      }
      this.noteLoginBootstrapPacket('equipment');
    });

    this.network.on(ServerOpcode.PLAYER_EQUIPMENT_BONUSES, (_op, v) => {
      const bonuses: CombatBonuses = zeroBonuses();
      for (let i = 0; i < COMBAT_BONUS_WIRE_KEYS.length; i++) {
        const value = v[i] ?? 0;
        bonuses[COMBAT_BONUS_WIRE_KEYS[i]] = Number.isFinite(value) ? Math.trunc(value) : 0;
      }
      this.sidePanel?.setEquipmentBonuses(bonuses);
    });

    this.network.on(ServerOpcode.XP_GAIN, (_op, v) => {
      const amount = Math.floor(decodeQuantityValues(v, 1, 0));
      if (amount > 0) this.queueXpDrop(amount);
    });

    this.network.on(ServerOpcode.LEVEL_UP, (_op, v) => {
      const [skillIndex, newLevel] = v;
      if (skillIndex >= 0 && skillIndex < ALL_SKILLS.length && this.chatPanel) {
        const skillName = SKILL_NAMES[ALL_SKILLS[skillIndex]];
        this.chatPanel.addSystemMessage(`Congratulations! You just advanced a ${skillName} level.`, '#ff0');
        this.chatPanel.addSystemMessage(`Your ${skillName} level is now ${newLevel}.`, '#ff0');
      }
    });

    this.network.on(ServerOpcode.LEVEL_UP_EFFECT, (_op, v) => {
      this.playLevelUpFirework(v[0]);
    });
  }

  private setupMapHandlers(): void {
    this.network.on(ServerOpcode.PLAYER_TELEPORT, (_op, values) => {
      // Lightweight same-map teleport: snap position + reset path, no
      // chunk/entity reload.
      const newX = (values[0] ?? 0) / 10;
      const newZ = (values[1] ?? 0) / 10;
      const newY = (values[2] ?? 0) / 10;
      const newFloor = values[3];
      this.playerX = newX;
      this.playerZ = newZ;
      this.clearPredictedPath();
      this.setTileFrom(newX, newZ);
      this.clearLocalNpcCombatState();
      this.isSkilling = false;
      this.skillingObjectId = -1;
      if (this.localPlayer) {
        this.localPlayer.resetTransientAnimation();
        this.localPlayer.stopWalking();
      }
      this.applyAuthoritativeFloor(newFloor ?? this.currentFloor, newY, {
        heightOverrideMs: 3000,
        refreshWorld: false,
      });
      if (this.destMarker) this.destMarker.isVisible = false;
      if (this.interactMarker) this.interactMarker.isVisible = false;
      this.minimap?.clearDestination();
      this.refreshWorldAfterSameMapTeleport();
      // Camera will follow naturally via its target on the next tick.
    });

    this.network.on(ServerOpcode.PATH_TRUNCATED, (_op, v) => {
      this.clearControlledMoveLock();
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
        this.refreshPredictedDestinationFromPath();
      } else if (cutIdx < 0) {
        const segmentIdx = this.findPathSegmentContainingTile(tx, tz);
        if (segmentIdx >= 0) {
          this.path = [
            ...this.path.slice(0, segmentIdx),
            { x: lastX, z: lastZ },
          ];
          this.refreshPredictedDestinationFromPath();
        } else {
          this.reconcileLocalPlayerToServer(lastX, lastZ, false);
        }
      }
    });

    this.network.on(ServerOpcode.PLAYER_CONTROLLED_MOVE, (_op, v) => {
      const path: { x: number; z: number }[] = [];
      for (let i = 0; i + 1 < v.length; i += 2) {
        path.push({ x: v[i] / 10, z: v[i + 1] / 10 });
      }
      this.armControlledMoveLock(path);
      this.startLocalPredictedPath(path);
    });

    this.network.on(ServerOpcode.FLOOR_CHANGE, (_op, values) => {
      const newFloor = values[0];
      const authoritativeY = values[1];
      const worldY = authoritativeY !== undefined && Number.isFinite(authoritativeY)
        ? authoritativeY / 10
        : undefined;
      const mapLoadSeq = this.activeMapChangeSeq;
      this.applyAuthoritativeFloor(newFloor, worldY, { refreshWorld: mapLoadSeq === 0 });
      if (mapLoadSeq !== 0) {
        this.floorChangeDuringMapLoad = { seq: mapLoadSeq, floor: newFloor, worldY };
      }
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
          void mapReady
            .catch((err) => {
              console.warn('[map] initial map change failed during login', err);
            })
            .then(() => {
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
          if (typeof node.sessionId !== 'number') node.sessionId = values[1] ?? 0;
          // Mid-conversation node transitions just call show() again with the
          // new node; DialoguePanel.show resets the line index so a multi-line
          // node restarts from line 0.
          this.dialoguePanel?.show(npcEntityId, node);
          this.setMobilePanelMode('chat');
        } catch (e) {
          console.warn('[dialogue] failed to parse node payload', e);
        }
      } else if (opcode === ServerOpcode.DIALOGUE_CLOSE) {
        const sessionId = data.byteLength >= 3 ? view.getInt16(1) : 0;
        this.dialoguePanel?.closeSession(sessionId);
      } else if (opcode === ServerOpcode.NPC_OVERHEAD_MESSAGE) {
        const { str, values } = decodeStringPacket(data);
        const entityId = values[0];
        if (entityId !== undefined && str.length > 0) {
          this.showNpcDialogueBubble(entityId, str, values[1] === 1);
        }
      } else if (opcode === ServerOpcode.NPC_NAME) {
        // [npcEntityId] follows the string payload. Override is cached for
        // the right-click menu, hover tooltip, and shop title — no floating
        // head label, per UX direction.
        const { str, values } = decodeStringPacket(data);
        const entityId = values[0];
        if (str.length > 0) this.entities.npcOverrideNames.set(entityId, str);
        else this.entities.npcOverrideNames.delete(entityId);
      } else if (opcode === ServerOpcode.NPC_ATTACK_ANIM) {
        // [npcEntityId] follows the anim-name string. Consulted first by
        // getPlayerAttackAnimName; empty string clears the override.
        const { str, values } = decodeStringPacket(data);
        const entityId = values[0];
        if (str.length > 0) this.entities.npcAttackAnimOverrides.set(entityId, str);
        else this.entities.npcAttackAnimOverrides.delete(entityId);
      } else if (opcode === ServerOpcode.NPC_EQUIPMENT_FIT) {
        const { str, values } = decodeStringPacket(data);
        const entityId = values[0];
        try {
          const fits = normalizeNpcEquipmentFits(str.length > 0 ? JSON.parse(str) : null);
          if (fits) this.entities.npcEquipmentFits.set(entityId, fits);
          else this.entities.npcEquipmentFits.delete(entityId);
          const sprite = this.entities.npcSprites.get(entityId);
          const equipment = this.entities.npcEquipment.get(entityId);
          if (sprite instanceof Npc3DEntity && sprite.isReady && equipment) {
            this.applyNpcModelEquipmentArray(sprite, equipment, entityId);
          }
        } catch (e) {
          console.warn('[npc-gear] failed to parse equipment fit payload', e);
        }
      } else if (opcode === ServerOpcode.QUEST_STATE_SYNC) {
        // Full snapshot on login. JSON record {questId: {stage, triggerProgress}}.
        const { str } = decodeStringPacket(data);
        try {
          this.questState = JSON.parse(str) as Record<string, QuestState>;
          this.sidePanel?.setQuestState(this.questState);
        } catch (e) { console.warn('[quest] sync parse failed', e); }
      } else if (opcode === ServerOpcode.QUEST_STAGE_ADVANCED) {
        // Single delta: questId string + [stage, triggerProgress].
        const { str: questId, values } = decodeStringPacket(data);
        const stage = values[0];
        const triggerProgress = values[1] ?? 0;
        const prev = this.questState[questId];
        this.questState[questId] = { ...(this.questState[questId] ?? {}), stage, triggerProgress };
        this.sidePanel?.updateQuestState(questId, stage, triggerProgress);
        // Chat notification on stage change (not on triggerProgress ticks
        // — those are just intermediate kill/item counters).
        if (!prev || prev.stage !== stage) {
          const def = this.questDefsCache.get(questId);
          if (def) {
            if (stage === QUEST_STAGE_COMPLETED) {
              // Server sends the reward-rich completion line via chat.
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

  /** Display name for an NPC entity: per-spawn override wins, then loaded
   *  npc defs, then the legacy NPC_NAMES table, else 'NPC'. Used by
   *  right-click, tooltip, and shop title. */
  private npcDisplayName(entityId: number, defId: number | undefined): string {
    const override = this.entities.npcOverrideNames.get(entityId);
    if (override) return override;
    if (defId !== undefined) return this.npcDefsCache.get(defId)?.name || NPC_NAMES[defId] || 'NPC';
    return 'NPC';
  }

  private async handleMapChange(mapId: string, newX: number, newZ: number): Promise<void> {
    if (import.meta.env.DEV) console.log(`Map change to '${mapId}' at (${newX}, ${newZ})`);

    const mapChangeSeq = ++this.nextMapChangeSeq;
    this.activeMapChangeSeq = mapChangeSeq;
    this.floorChangeDuringMapLoad = null;
    try {
      const isInitialPlacement = !this.hasHandledInitialMapChange;
      const mapAlreadyLoaded = this.chunkManager.isLoaded() && this.chunkManager.getMapId() === mapId;
      const previousMapId = this.chunkManager.getMapId();
      const previousMapMeta = this.chunkManager.getMeta();
      const wasDungeon = this.isDungeonMap(previousMapId, previousMapMeta);

      this.playerX = newX;
      this.playerZ = newZ;
      this.clearPredictedPath();
      this.clearHoverHiddenRoofs();
      this.currentFloor = 0;
      this.chunkManager.setCurrentFloor(0);
      if (this.localPlayer) this.localPlayer.stopWalking();
      this.clearLocalNpcCombatState();
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
        for (const [objectEntityId, model] of this.worldObjectModels) {
          if (!this.chunkManager.isPlacedObjectNode(model)) {
            this.objectModels.deleteActiveModelAnimations(objectEntityId);
            model.dispose(false, false);
          }
        }
        this.worldObjectModels.clear();
        this.worldObjectIdByNode = new WeakMap();
        this.worldObjectPickState = new WeakMap();
        this.objectModels.disposeStumps();
        this.worldObjectDefs.clear();
        this.blockedObjectTiles.clear();
        this.closedCenteredDoorTileCounts.clear();
        this.closedCenteredDoorTileKeysByObjectId.clear();
        this.disposeAllCropPickProxyBatches();
        this.disposeWorldObjectPickProxyBatch();
        for (const [, proxy] of this.doorPickProxies) proxy.dispose();
        this.doorPickProxies.clear();
        for (const [, entry] of this.doorPivots) entry.pivot.dispose();
        this.doorPivots.clear();

        await this.chunkManager.loadMap(mapId);
        await this.loadBiomes(mapId);
        this.applyFog();
        this.minimap?.invalidateTileCache();
        this._lastMinimapListRefreshMs = 0;
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
      // the follow-up FLOOR_CHANGE packet carries the authoritative Y.
      this.replayFloorChangeDuringMapLoad(mapChangeSeq);

      if (!this.hasHandledInitialMapChange) {
        this.hasHandledInitialMapChange = true;
        this.suppressNextMapEntryMessage = false;
      } else if (this.suppressNextMapEntryMessage) {
        this.suppressNextMapEntryMessage = false;
      } else if (wasDungeon && this.isOverworldMap(mapId, this.chunkManager.getMeta())) {
        this.chatPanel?.addSystemMessage('Entered overworld', '#0f0');
      }
    } catch (err) {
      this.clearMapChangeFloorReplay(mapChangeSeq);
      throw err;
    }
  }

  private replayFloorChangeDuringMapLoad(mapChangeSeq: number): void {
    const pendingFloor = this.activeMapChangeSeq === mapChangeSeq
      && this.floorChangeDuringMapLoad?.seq === mapChangeSeq
      ? this.floorChangeDuringMapLoad
      : null;
    this.clearMapChangeFloorReplay(mapChangeSeq);
    if (pendingFloor) {
      this.applyAuthoritativeFloor(pendingFloor.floor, pendingFloor.worldY);
    }
  }

  private clearMapChangeFloorReplay(mapChangeSeq: number): void {
    if (this.activeMapChangeSeq !== mapChangeSeq) return;
    this.activeMapChangeSeq = 0;
    this.floorChangeDuringMapLoad = null;
  }

  private applyAuthoritativeFloor(
    newFloor: number,
    worldY?: number,
    opts: { heightOverrideMs?: number; refreshWorld?: boolean } = {},
  ): void {
    if (!Number.isFinite(newFloor)) return;
    const floor = Math.trunc(newFloor);
    const floorChanged = this.currentFloor !== floor;
    this.currentFloor = floor;
    if (this.localTeleportHeightOverride?.floor !== floor) this.localTeleportHeightOverride = null;
    if (floorChanged && import.meta.env.DEV) console.log(`Floor changed to ${floor}`);
    this.chunkManager.setCurrentFloor(floor);
    if (worldY !== undefined && Number.isFinite(worldY)) {
      this.localTeleportHeightOverride = {
        tileX: Math.floor(this.playerX),
        tileZ: Math.floor(this.playerZ),
        floor,
        y: worldY,
        expiresAt: performance.now() + (opts.heightOverrideMs ?? 2000),
      };
      if (this.localPlayer) this.localPlayer.setPositionXYZ(this.playerX, worldY, this.playerZ);
      this.inputManager.setPlayerY(worldY);
    }
    this.refreshHoverHiddenRoofs(true, !floorChanged);
    if (opts.refreshWorld !== false) this.refreshWorldAfterSameMapTeleport();
  }

  private isDungeonMap(mapId: string, meta: { id?: string; mapType?: string; dungeon?: boolean } | null): boolean {
    return meta?.dungeon === true
      || meta?.mapType === 'dungeon'
      || /\bdungeon\b/i.test(mapId)
      || mapId === 'underground';
  }

  private isOverworldMap(mapId: string, meta: { id?: string; mapType?: string; dungeon?: boolean } | null): boolean {
    if (meta?.dungeon === true || meta?.mapType === 'dungeon') return false;
    return meta?.mapType === 'overworld' || mapId === 'kcmap';
  }

  private setupContextMenu(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('contextmenu', (e) => {
      this.handleWorldContextMenuEvent(canvas, e, false);
    });
  }

  private handleWorldContextMenuEvent(
    canvas: HTMLCanvasElement,
    event: MouseEvent | PointerEvent,
    suppressNativeFollowup: boolean,
  ): void {
    if (typeof PointerEvent !== 'undefined' && event instanceof PointerEvent && this.isTouchPointer(event)) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const now = performance.now();
    const isDuplicate = now - this.lastWorldContextMenuEventAt <= GameManager.WORLD_CONTEXT_MENU_DEDUPE_MS
      && Math.hypot(
        event.clientX - this.lastWorldContextMenuEventX,
        event.clientY - this.lastWorldContextMenuEventY,
      ) <= GameManager.WORLD_CONTEXT_MENU_DEDUPE_RADIUS_PX;

    if (suppressNativeFollowup) suppressNextContextMenuClick(canvas, event.clientX, event.clientY);
    // Pointerdown/mousedown/contextmenu can all fire for one right-click. If a
    // document-level capture listener already closed the pointerdown menu, the
    // native contextmenu fallback must be allowed to recreate it.
    if (isDuplicate && this.contextMenu) return;

    this.lastWorldContextMenuEventAt = now;
    this.lastWorldContextMenuEventX = event.clientX;
    this.lastWorldContextMenuEventY = event.clientY;
    this.hideContextMenu();
    this.openWorldContextMenuAt(event.clientX, event.clientY);
  }

  private openWorldContextMenuAt(clientX: number, clientY: number): void {
    // Same gate as left-click: don't surface interaction options against a
    // half-streamed world.
    if (!this.inputManager.isEnabled()) return;

    const options = this.getWorldInteractionOptionsAt(clientX, clientY);
    if (options.length > 0) {
      this.showContextMenu(clientX, clientY, options);
    }
  }

  private setupNativeContextMenuBlocker(): void {
    if (this.nativeContextMenuBlocker) return;
    this.nativeContextMenuBlocker = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('#game-frame')) return;
      event.preventDefault();
    };
    document.addEventListener('contextmenu', this.nativeContextMenuBlocker, true);
  }

  private setupMobileControls(): void {
    const frame = document.getElementById('game-frame');
    if (!frame) return;

    this.mobileControlsEl?.remove();
    this.mobilePanelButtons = {};

    const bar = document.createElement('div');
    bar.id = 'mobile-control-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Mobile game controls');

    const makeButton = (
      label: string,
      title: string,
      onClick?: () => void,
    ): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mobile-nav-button';
      button.textContent = label;
      button.title = title;
      if (onClick) {
        button.addEventListener('click', (event) => {
          event.preventDefault();
          onClick();
        });
      }
      return button;
    };

    const mapButton = makeButton('Map', 'Open minimap', () => {
      this.setMobilePanelMode(frame.classList.contains('mobile-map-open') ? 'game' : 'map');
    });
    const panelButton = makeButton('Panel', 'Open inventory and stats', () => {
      this.setMobilePanelMode(frame.classList.contains('mobile-panel-open') ? 'game' : 'panel');
    });
    const chatButton = makeButton('Chat', 'Open chat', () => {
      this.setMobilePanelMode(frame.classList.contains('mobile-chat-open') ? 'game' : 'chat');
    });

    this.mobilePanelButtons.map = mapButton;
    this.mobilePanelButtons.panel = panelButton;
    this.mobilePanelButtons.chat = chatButton;

    bar.append(mapButton, panelButton, chatButton);
    frame.appendChild(bar);
    this.mobileControlsEl = bar;
    this.setupMobileStatusHud(frame);
    this.mobileLogoutButton?.remove();
    this.mobileLogoutButton = null;
    this.updateAdminSurfaces();
    this.setMobilePanelMode('game');
  }

  private setMobilePanelMode(mode: MobilePanelMode): void {
    const frame = document.getElementById('game-frame');
    if (!frame) return;

    const mapOpen = mode === 'map';
    const panelOpen = mode === 'panel';
    const chatOpen = mode === 'chat';
    frame.classList.toggle('mobile-map-open', mapOpen);
    frame.classList.toggle('mobile-panel-open', panelOpen);
    frame.classList.toggle('mobile-chat-open', chatOpen);
    if (chatOpen) frame.classList.remove('mobile-chat-collapsed');

    this.mobilePanelButtons.map?.classList.toggle('active', mapOpen);
    this.mobilePanelButtons.panel?.classList.toggle('active', panelOpen);
    this.mobilePanelButtons.chat?.classList.toggle('active', chatOpen);
    this.mobilePanelButtons.map?.setAttribute('aria-pressed', String(mapOpen));
    this.mobilePanelButtons.panel?.setAttribute('aria-pressed', String(panelOpen));
    this.mobilePanelButtons.chat?.setAttribute('aria-pressed', String(chatOpen));

    window.setTimeout(() => {
      if (!this.destroyed && !this.engine.isDisposed) this.handleViewportResize();
    }, 0);
  }

  private setupMobileStatusHud(frame: HTMLElement): void {
    this.mobileStatusEl?.remove();

    const hud = document.createElement('div');
    hud.id = 'mobile-status-hud';
    hud.append(
      this.createMobileStatusItem('hp', 'HP', 'hp'),
      this.createMobileStatusItem('evil', 'Evil', 'evil'),
      this.createMobileStatusItem('good', 'Good', 'good'),
    );
    frame.appendChild(hud);
    this.mobileStatusEl = hud;
    this.syncMobileStatusHud();
  }

  private setupMobileLogoutButton(frame: HTMLElement): void {
    this.mobileLogoutButton?.remove();

    const button = document.createElement('button');
    button.id = 'mobile-logout-button';
    button.type = 'button';
    button.textContent = 'Logout';
    button.title = 'Logout';
    button.addEventListener('click', async () => {
      let ok = false;
      try {
        const res = await fetch('/api/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ token: this.token }),
        });
        ok = res.ok;
      } catch {
        // Fall through to the temporary blocked state.
      }
      if (!ok) {
        button.textContent = 'Blocked';
        window.setTimeout(() => { button.textContent = 'Logout'; }, 1800);
        return;
      }
      localStorage.removeItem('evilquest_token');
      localStorage.removeItem('evilquest_username');
      location.reload();
    });

    frame.appendChild(button);
    this.mobileLogoutButton = button;
  }

  private setupMobileAdminButton(frame: HTMLElement): void {
    this.mobileAdminButton?.remove();
    if (!this.isAdmin) {
      this.mobileAdminButton = null;
      return;
    }

    const button = document.createElement('button');
    button.id = 'mobile-admin-button';
    button.type = 'button';
    button.textContent = 'Admin';
    button.title = 'Admin';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      this.openAdminPanel();
    });

    frame.appendChild(button);
    this.mobileAdminButton = button;
  }

  private updateAdminSurfaces(): void {
    if (this.isAdmin) {
      this.inputManager.setTeleportClickHandler((worldX, worldZ) => {
        this.network.sendChat(`/tp ${worldX.toFixed(1)} ${worldZ.toFixed(1)}`);
      });
      this.sidePanel?.setAdminControls(false, () => {});
      this.sidePanel?.setAdminItemDeletionEnabled(true);
      this.bankPanel?.setAdminItemDeletionEnabled(true);
      this.chatPanel?.setAdminControls(true, () => this.openAdminPanel());
      this.mobileAdminButton?.remove();
      this.mobileAdminButton = null;
      return;
    }

    this.inputManager.setTeleportClickHandler(null);
    this.sidePanel?.setAdminControls(false, () => {});
    this.sidePanel?.setAdminItemDeletionEnabled(false);
    this.bankPanel?.setAdminItemDeletionEnabled(false);
    this.chatPanel?.setAdminControls(false, () => {});
    this.mobileAdminButton?.remove();
    this.mobileAdminButton = null;
    this.adminPanel?.hide();
  }

  private openAdminPanel(): void {
    if (!this.isAdmin) return;
    if (!this.adminPanel) this.adminPanel = new AdminPanel(this.token);
    this.adminPanel.show();
  }

  private createMobileStatusItem(key: 'hp' | 'good' | 'evil', label: string, colorClass: string): HTMLDivElement {
    const item = document.createElement('div');
    item.className = 'mobile-status-item';

    const labelEl = document.createElement('div');
    labelEl.className = 'mobile-status-label';
    labelEl.textContent = label;
    item.appendChild(labelEl);

    const track = document.createElement('div');
    track.className = 'mobile-status-track';

    const fill = document.createElement('div');
    fill.id = `mobile-${key}-fill`;
    fill.className = `mobile-status-fill ${colorClass}`;
    track.appendChild(fill);

    const text = document.createElement('div');
    text.id = `mobile-${key}-text`;
    text.className = 'mobile-status-text';
    track.appendChild(text);

    item.appendChild(track);
    return item;
  }

  private syncMobileStatusHud(): void {
    this.updateMobileStatusBar('hp', this.playerHealth, this.playerMaxHealth);
    this.updateMobileStatusBar('good', this.mobileGoodMagicCurrent, this.mobileGoodMagicMax);
    this.updateMobileStatusBar('evil', this.mobileEvilMagicCurrent, this.mobileEvilMagicMax);
  }

  private updateMobileMagicStatus(skillIndex: number, level: number, currentLevel: number): void {
    const id = ALL_SKILLS[skillIndex];
    if (id === 'goodmagic') {
      this.mobileGoodMagicCurrent = currentLevel;
      this.mobileGoodMagicMax = level;
      this.updateMobileStatusBar('good', currentLevel, level);
    } else if (id === 'evilmagic') {
      this.mobileEvilMagicCurrent = currentLevel;
      this.mobileEvilMagicMax = level;
      this.updateMobileStatusBar('evil', currentLevel, level);
    }
  }

  private updateMobileStatusBar(key: 'hp' | 'good' | 'evil', current: number, max: number): void {
    const fill = document.getElementById(`mobile-${key}-fill`) as HTMLDivElement | null;
    const text = document.getElementById(`mobile-${key}-text`) as HTMLDivElement | null;
    const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
    if (fill) fill.style.width = `${ratio * 100}%`;
    if (text) text.textContent = `${current}/${max}`;
    if (key === 'hp' && fill) {
      if (ratio > 0.5) {
        fill.style.background = 'linear-gradient(180deg, #1a8a1a 0%, #0a6a0a 100%)';
      } else if (ratio > 0.25) {
        fill.style.background = 'linear-gradient(180deg, #8a8a1a 0%, #6a6a0a 100%)';
      } else {
        fill.style.background = 'linear-gradient(180deg, #8a1a1a 0%, #6a0a0a 100%)';
      }
    }
  }

  private isTouchPointer(event: PointerEvent): boolean {
    return event.pointerType === 'touch' || event.pointerType === 'pen';
  }

  private isBrowserPageZoomed(): boolean {
    const scale = window.visualViewport?.scale ?? 1;
    return Number.isFinite(scale) && scale > 1 + GameManager.BROWSER_PAGE_ZOOM_EPSILON;
  }

  private trackTouchPointer(event: PointerEvent): void {
    if (!this.isTouchPointer(event)) return;
    this.activeTouchPointers.set(event.pointerId, {
      clientX: event.clientX,
      clientY: event.clientY,
    });
  }

  private beginPinchZoom(canvas: HTMLCanvasElement): void {
    const pointerIds = Array.from(this.activeTouchPointers.keys()).slice(0, 2);
    if (pointerIds.length < 2) return;
    const distance = this.touchPointerDistance(pointerIds[0], pointerIds[1]);
    if (distance < GameManager.TOUCH_PINCH_MIN_DISTANCE_PX) return;

    this.pinchZoom = {
      pointerIds: [pointerIds[0], pointerIds[1]],
      lastDistance: distance,
    };

    for (const pointerId of pointerIds) {
      try {
        if (!canvas.hasPointerCapture(pointerId)) canvas.setPointerCapture(pointerId);
      } catch {
        // Some mobile browsers decline capture for the first touch once the
        // second finger lands. The active pointer map still gives us enough
        // state to finish the gesture cleanly.
      }
    }
  }

  private touchPointerDistance(aId: number, bId: number): number {
    const a = this.activeTouchPointers.get(aId);
    const b = this.activeTouchPointers.get(bId);
    if (!a || !b) return 0;
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  private handlePinchZoomMove(event: PointerEvent): boolean {
    const pinch = this.pinchZoom;
    if (!pinch || !pinch.pointerIds.includes(event.pointerId)) return false;

    if (this.isBrowserPageZoomed()) {
      for (const pointerId of pinch.pointerIds) this.releaseTouchPointerCapture(pointerId);
      this.pinchZoom = null;
      return false;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    if (!this.isAdmin) return true;

    const distance = this.touchPointerDistance(pinch.pointerIds[0], pinch.pointerIds[1]);
    if (
      distance >= GameManager.TOUCH_PINCH_MIN_DISTANCE_PX
      && pinch.lastDistance >= GameManager.TOUCH_PINCH_MIN_DISTANCE_PX
    ) {
      const rawFactor = pinch.lastDistance / distance;
      const maxStep = GameManager.TOUCH_PINCH_MAX_STEP_FACTOR;
      const factor = Math.min(Math.max(rawFactor, 1 / maxStep), maxStep);
      this.camera.zoomByFactor(factor);
    }
    pinch.lastDistance = distance;
    return true;
  }

  private finishPinchTouch(event: PointerEvent): boolean {
    const isPinchPointer = this.pinchZoom?.pointerIds.includes(event.pointerId) ?? false;
    if (!isPinchPointer) return false;

    if (!this.isBrowserPageZoomed()) event.preventDefault();
    event.stopImmediatePropagation();
    this.pinchZoom = null;
    this.activeTouchPointers.delete(event.pointerId);
    this.releaseTouchPointerCapture(event.pointerId);
    return true;
  }

  private releaseTouchPointerCapture(pointerId: number): void {
    const canvas = this.engine.getRenderingCanvas();
    if (!canvas) return;
    try {
      if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    } catch {
      // Capture may already be gone after pointercancel/lostpointercapture.
    }
  }

  private cancelTouchPointer(event: PointerEvent): void {
    if (this.isTouchPointer(event)) {
      this.activeTouchPointers.delete(event.pointerId);
      if (this.pinchZoom?.pointerIds.includes(event.pointerId)) this.pinchZoom = null;
    }
    this.cancelPendingTouchInteraction(event);
    this.releaseTouchPointerCapture(event.pointerId);
  }

  private beginTouchInteraction(
    canvas: HTMLCanvasElement,
    event: PointerEvent,
    options: InteractionOption[],
  ): void {
    const pending: PendingTouchInteraction = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      clientX: event.clientX,
      clientY: event.clientY,
      options,
      longPressTimer: 0,
      contextShown: false,
      rotating: false,
    };

    pending.longPressTimer = window.setTimeout(() => {
      if (this.pendingTouchInteraction !== pending || this.destroyed) return;
      if (pending.options.length === 0) return;
      pending.contextShown = true;
      this.showContextMenu(pending.clientX, pending.clientY, pending.options);
    }, GameManager.TOUCH_LONG_PRESS_MS);

    this.pendingTouchInteraction = pending;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Some mobile browsers decline capture on canvas; the event stream still
      // usually stays on the same target during a stationary tap.
    }
  }

  private handlePendingTouchMove(event: PointerEvent): void {
    if (this.isTouchPointer(event)) {
      this.trackTouchPointer(event);
      if (this.handlePinchZoomMove(event)) return;
      if (this.activeTouchPointers.size >= 2) {
        event.stopImmediatePropagation();
        if (!this.isBrowserPageZoomed()) event.preventDefault();
        return;
      }
    }

    const pending = this.pendingTouchInteraction;
    if (!pending || pending.pointerId !== event.pointerId) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const moved = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
    if (!pending.contextShown && (pending.rotating || moved > GameManager.TOUCH_MOVE_CANCEL_PX)) {
      if (!pending.rotating) {
        pending.rotating = true;
        window.clearTimeout(pending.longPressTimer);
      }

      const dx = event.clientX - pending.lastX;
      const dy = event.clientY - pending.lastY;
      this.camera.rotate(
        dx * GameManager.TOUCH_CAMERA_YAW_PER_PX,
        -dy * GameManager.TOUCH_CAMERA_PITCH_PER_PX,
      );
    }

    pending.lastX = event.clientX;
    pending.lastY = event.clientY;
    pending.clientX = event.clientX;
    pending.clientY = event.clientY;
  }

  private finishPendingTouchInteraction(event: PointerEvent): void {
    if (this.isTouchPointer(event) && this.finishPinchTouch(event)) return;

    const pending = this.pendingTouchInteraction;
    if (!pending || pending.pointerId !== event.pointerId) {
      if (this.isTouchPointer(event)) {
        this.activeTouchPointers.delete(event.pointerId);
        this.releaseTouchPointerCapture(event.pointerId);
      }
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    const option = pending.options.find(candidate => candidate.primary !== false);
    const shouldRunTap = !pending.contextShown && !pending.rotating;
    this.cancelPendingTouchInteraction(event);
    if (shouldRunTap && option) {
      this.runInteractionOption(option, event.clientX, event.clientY);
    } else if (shouldRunTap) {
      this.lastClickX = event.clientX;
      this.lastClickY = event.clientY;
      this.inputManager.handlePrimaryActionAt(event.clientX, event.clientY, event.shiftKey);
    }
    if (this.isTouchPointer(event)) this.activeTouchPointers.delete(event.pointerId);
  }

  private cancelPendingTouchInteraction(event?: PointerEvent): void {
    const pending = this.pendingTouchInteraction;
    if (!pending) return;

    window.clearTimeout(pending.longPressTimer);
    this.pendingTouchInteraction = null;
    if (!event || event.pointerId === pending.pointerId) this.releaseTouchPointerCapture(pending.pointerId);
  }

  private getWorldInteractionOptionsAt(clientX: number, clientY: number): InteractionOption[] {
    const point = this.canvasPointFromClient(clientX, clientY);
    if (!point) return [];
    const pickResult = this.scene.pick(point.x, point.y);
    const groundPoint = this.inputManager.pickGround(point.x, point.y);
    if ((!pickResult?.hit || !pickResult.pickedMesh) && !groundPoint) return [];

    const meshName = pickResult?.pickedMesh?.name ?? '';
    const options: InteractionOption[] = [];
    const addedGroundItemIds = new Set<number>();

    const pickedPlayerEntityId = this.pickPlayerAtPoint(point.x, point.y);
    if (pickedPlayerEntityId != null) {
      options.push(...this.getPlayerInteractionOptions(pickedPlayerEntityId));
    }
    if (this.duelActive) return options;

    // Identify the picked NPC. 3D-modeled NPCs (e.g. cows) all share mesh
    // names from their source GLB, so name matching is ambiguous — every
    // cow click would route to whichever cow happened to be first in the
    // npcSprites map. Check metadata.entityId (stamped by Npc3DEntity.
    // setEntityIdMetadata and CharacterEntity.setEntityIdMetadata) by
    // walking up the picked node's parents. pickNpcAtPoint falls through
    // placed scenery to find an NPC along the ray, so clicking through a
    // fence/anvil at an NPC's lower body still surfaces the Talk-to / Attack
    // option.
    const npcPick = this.pickNpcAtPoint(point.x, point.y);
    const pickedNpcEntityId = npcPick.entityId;
    if (pickedNpcEntityId != null) {
      options.push(...this.getNpcInteractionOptions(pickedNpcEntityId));
    }

    if (npcPick.groundItem) {
      options.push(...this.getGroundItemInteractionOptions(npcPick.groundItem, addedGroundItemIds));
    }

    if (pickResult?.pickedMesh) {
      const pickedGroundItem = this.findGroundItemFromPick(pickResult.pickedMesh as unknown as TransformNode, meshName);
      if (pickedGroundItem) {
        options.push(...this.getGroundItemInteractionOptions(pickedGroundItem, addedGroundItemIds));
      }
    }

    if (pickResult?.pickedMesh) {
      const pickedObjectEntityId = this.findWorldObjectIdFromPick(
        pickResult.pickedMesh as unknown as TransformNode,
        pickResult.thinInstanceIndex ?? -1,
      );
      if (pickedObjectEntityId != null) {
        options.push(...this.getWorldObjectInteractionOptions(pickedObjectEntityId));
      }
    }

    const entityTilePoints = this.getPickedEntityGroundTilePoints(pickedPlayerEntityId, pickedNpcEntityId, groundPoint);
    if (entityTilePoints.length > 0) {
      for (const tilePoint of entityTilePoints) {
        options.push(...this.getGroundItemInteractionOptionsAtTile(tilePoint.x, tilePoint.z, addedGroundItemIds));
      }
      options.push(this.getWalkHereInteractionOption(entityTilePoints[0].x, entityTilePoints[0].z));
    }

    if (options.length === 0 && groundPoint) {
      options.push(this.getWalkHereInteractionOption(groundPoint.x, groundPoint.z));
    }

    return options;
  }

  private getWalkHereInteractionOption(x: number, z: number): InteractionOption {
    return {
      label: 'Walk here',
      primary: false,
      action: () => this.handleGroundClick(x, z),
    };
  }

  private getPickedEntityGroundTilePoints(
    playerEntityId: number | null,
    npcEntityId: number | null,
    fallbackGroundPoint: { x: number; z: number } | null,
  ): { x: number; z: number }[] {
    if (playerEntityId == null && npcEntityId == null) return [];
    const points: { x: number; z: number }[] = [];
    const seen = new Set<string>();
    const addTile = (x: number, z: number): void => {
      const tx = Math.floor(x);
      const tz = Math.floor(z);
      const key = `${tx},${tz}`;
      if (seen.has(key)) return;
      seen.add(key);
      points.push({ x: tx + 0.5, z: tz + 0.5 });
    };

    if (playerEntityId != null) {
      const target = this.entities.remoteTargets.get(playerEntityId);
      if (target && target.floor === this.currentFloor) addTile(target.x, target.z);
    }

    if (npcEntityId != null) {
      const target = this.entities.npcTargets.get(npcEntityId);
      if (target && target.floor === this.currentFloor) {
        const size = this.getNpcTileSize(npcEntityId);
        for (const tile of getObjectFootprintTiles(target.x, target.z, { width: size })) {
          addTile(tile.x, tile.z);
        }
      }
    }

    if (fallbackGroundPoint) addTile(fallbackGroundPoint.x, fallbackGroundPoint.z);
    return points;
  }

  private getPlayerInteractionOptions(entityId: number): InteractionOption[] {
    const target = this.entities.remoteTargets.get(entityId);
    if (target && target.floor !== this.currentFloor) return [];
    const name = this.entities.playerNames.get(entityId) ?? 'Player';
    const lvl = this.entities.remoteCombatLevels.get(entityId) ?? 0;
    const labelLevel = lvl > 0 ? ` (level-${lvl})` : '';
    const nameColor = this.playerNameColor(
      this.entities.remoteAdminFlags.get(entityId) === true,
      this.entities.remoteModeratorFlags.get(entityId) === true,
    );
    const playerOption = (prefix: string, suffix: string, action: () => void): InteractionOption => ({
      label: `${prefix}${name}${suffix}`,
      labelParts: [{ text: prefix }, { text: name, color: nameColor }, { text: suffix }],
      action,
    });
    if (this.duelActive) {
      if (entityId !== this.currentDuelOpponentEntityId) return [];
      return [
        playerOption('Attack ', labelLevel, () => this.attackDuelPlayer(entityId)),
      ];
    }
    return [
      playerOption('Follow ', labelLevel, () => this.followPlayer(entityId)),
      playerOption('Trade with ', '', () => this.requestTrade(entityId)),
      playerOption('Duel with ', '', () => this.requestDuel(entityId)),
    ];
  }

  private playerNameColor(isAdmin: boolean, isModerator: boolean, fallback: string = '#ffffff'): string {
    if (isAdmin) return ADMIN_NAME_COLOR;
    if (isModerator) return MODERATOR_NAME_COLOR;
    return fallback;
  }

  private cacheRemotePlayerRole(entityId: number, isAdmin: boolean, isModerator: boolean): void {
    this.entities.remoteAdminFlags.set(entityId, isAdmin);
    this.entities.remoteModeratorFlags.set(entityId, isModerator);
  }

  private setRemotePlayerRole(entityId: number, isAdmin: boolean, isModerator: boolean): void {
    this.cacheRemotePlayerRole(entityId, isAdmin, isModerator);
    const remote = this.entities.remotePlayers.get(entityId);
    if (remote) remote.setLabelColor(this.playerNameColor(isAdmin, isModerator));
  }

  private nameColorForMessage(name: string, isAdmin: boolean, isModerator: boolean, fallback: string = '#fff'): string {
    if (isAdmin) return ADMIN_NAME_COLOR;
    if (isModerator) return MODERATOR_NAME_COLOR;
    if (!name) return fallback;
    const normalized = name.toLowerCase();
    if (this.username && normalized === this.username.toLowerCase()) {
      return this.playerNameColor(this.isAdmin, this.isModerator, fallback);
    }
    const entityId = this.entities.nameToEntityId.get(normalized);
    if (entityId === undefined) return fallback;
    return this.playerNameColor(
      this.entities.remoteAdminFlags.get(entityId) === true,
      this.entities.remoteModeratorFlags.get(entityId) === true,
      fallback,
    );
  }

  private canvasPointFromClient(clientX: number, clientY: number): { x: number; y: number } | null {
    const canvas = this.engine.getRenderingCanvas();
    if (!canvas || this.engine.isDisposed || this.scene.isDisposed) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = this.engine.getRenderWidth() / Math.max(1, rect.width);
    const scaleY = this.engine.getRenderHeight() / Math.max(1, rect.height);
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  private getNpcInteractionOptions(entityId: number): InteractionOption[] {
    const target = this.entities.npcTargets.get(entityId);
    if (target && target.floor !== this.currentFloor) return [];
    const npcDefId = this.entities.npcDefs.get(entityId);
    const name = this.npcDisplayName(entityId, npcDefId);
    // Prefer the server-sent interaction flags (NPC_INTERACTIONS) over the
    // hardcoded isNonAttackableNpc allow-list — that list pre-dates the
    // server telling us, and would mislabel any new editor-authored NPC.
    // Flags: bit 0 = dialogue, bit 1 = shop, bit 2 = bank, bit 3 = dialogue can start combat.
    const flags = this.entities.npcInteractions.get(entityId) ?? 0;
    if (this.isNonCombatNpc(entityId, npcDefId)) {
      // Talk-to handles all three (dialogue → priority on server, else
      // falls through to shop, then bank). One label keeps the menu tidy.
      const verb = (flags & NPC_INTERACTION_HAS_DIALOGUE) !== 0 ? 'Talk-to' : 'Trade';
      return [
        { label: `${verb} ${name}`, action: () => this.talkToNpc(entityId) },
        { label: `Examine ${name}`, action: () => this.examineNpc(entityId), primary: false },
      ];
    }

    const lvl = this.npcLevelFor(entityId, npcDefId);
    const labelLevel = lvl > 0 ? ` (level-${lvl})` : '';
    const attackOption: InteractionOption = { label: `Attack ${name}${labelLevel}`, action: () => this.attackNpc(entityId) };
    if ((flags & NPC_INTERACTION_HAS_DIALOGUE) !== 0) {
      const engaged = this.isLocalNpcCombatTarget(entityId);
      const talkOption: InteractionOption = {
        label: `Talk-to ${name}`,
        action: () => this.talkToNpc(entityId),
        primary: engaged ? false : undefined,
      };
      return engaged
        ? [
            attackOption,
            talkOption,
            { label: `Examine ${name}`, action: () => this.examineNpc(entityId), primary: false },
          ]
        : [
            talkOption,
            { label: `Examine ${name}`, action: () => this.examineNpc(entityId), primary: false },
          ];
    }
    return [
      attackOption,
      { label: `Examine ${name}`, action: () => this.examineNpc(entityId), primary: false },
    ];
  }

  private findGroundItemFromPick(pickedMesh: TransformNode, meshName: string): GroundItemPickRef | null {
    let walk: TransformNode | null = pickedMesh;
    while (walk) {
      const metadata = walk.metadata;
      if (metadata?.kind === 'groundItem' || metadata?.kind === 'groundItemVisual') {
        const groundItemId = typeof metadata.groundItemId === 'number' ? metadata.groundItemId : null;
        const tileKey = typeof metadata.groundItemTileKey === 'string' ? metadata.groundItemTileKey : null;
        if (groundItemId != null || tileKey != null) return { groundItemId, tileKey };
      }
      walk = walk.parent as TransformNode | null;
    }

    for (const [groundItemId, sprite] of this.entities.groundItemSprites) {
      if (sprite.getMesh()?.name === meshName) return { groundItemId, tileKey: null };
    }
    return null;
  }

  /** All ground items sharing the picked tile, value-prioritized.
   *  The ground renderer collapses each tile into one 2004scape-style stack and
   *  shows the highest-value item on top, so menus/tooltips use the same order. */
  private groundItemStackForPick(pick: GroundItemPickRef): GroundItemData[] {
    if (pick.tileKey) return this.entities.getGroundItemStackForTileKey(pick.tileKey);
    if (pick.groundItemId != null) return this.entities.getGroundItemStackForItem(pick.groundItemId);
    return [];
  }

  private groundItemTooltipLines(stack: GroundItemData[]): string[] {
    const visible = stack.slice(0, GROUND_ITEM_TOOLTIP_MAX_LINES);
    const lines = visible.map((gi) => {
      const iName = this.itemDefsCache.get(gi.itemId)?.name ?? 'item';
      return gi.quantity > 1 ? `${iName} (${gi.quantity})` : iName;
    });
    const hiddenCount = stack.length - visible.length;
    if (hiddenCount > 0) lines.push(`+${hiddenCount} more`);
    return lines;
  }

  private getGroundItemInteractionOptions(
    pick: GroundItemPickRef,
    addedGroundItemIds: Set<number> = new Set<number>(),
  ): InteractionOption[] {
    return this.getGroundItemInteractionOptionsForStack(this.groundItemStackForPick(pick), addedGroundItemIds);
  }

  private getGroundItemInteractionOptionsAtTile(
    x: number,
    z: number,
    addedGroundItemIds: Set<number> = new Set<number>(),
  ): InteractionOption[] {
    return this.getGroundItemInteractionOptionsForStack(
      this.entities.getGroundItemStackAtTile(x, z, this.currentFloor),
      addedGroundItemIds,
    );
  }

  private getGroundItemInteractionOptionsForStack(
    stack: GroundItemData[],
    addedGroundItemIds: Set<number>,
  ): InteractionOption[] {
    return stack.map((gi) => {
      if (gi.floor !== this.currentFloor) return null;
      if (addedGroundItemIds.has(gi.id)) return null;
      addedGroundItemIds.add(gi.id);
      const iDef = this.itemDefsCache.get(gi.itemId);
      const iName = iDef?.name ?? 'item';
      const qtyLabel = gi.quantity > 1 ? ` (${gi.quantity})` : '';
      const giId = gi.id;
      return {
        label: `Pick up ${iName}${qtyLabel}`,
        action: () => this.pickupItem(giId),
      };
    }).filter((opt): opt is InteractionOption => opt !== null);
  }

  private findWorldObjectIdFromPick(pickedMesh: TransformNode, thinInstanceIndex: number = -1): number | null {
    if (
      (pickedMesh.metadata?.kind === 'cropPickProxyBatch' || pickedMesh.metadata?.kind === 'worldObjectPickProxyBatch')
      && thinInstanceIndex >= 0
      && Array.isArray(pickedMesh.metadata.objectEntityIdsByThinInstance)
    ) {
      const id = pickedMesh.metadata.objectEntityIdsByThinInstance[thinInstanceIndex];
      if (typeof id === 'number') {
        const data = this.worldObjectDefs.get(id);
        return data && this.isWorldObjectOnCurrentInteractionFloor(data) ? id : null;
      }
    }

    // Check 3D models (trees, rocks, placed objects) by walking up the parent
    // chain looking for objectEntityId metadata.
    let walkMesh: TransformNode | null = pickedMesh;
    while (walkMesh) {
      if (typeof walkMesh.metadata?.objectEntityId === 'number') {
        const id = walkMesh.metadata.objectEntityId;
        const data = this.worldObjectDefs.get(id);
        return data && this.isWorldObjectOnCurrentInteractionFloor(data) ? id : null;
      }
      if (walkMesh.metadata?.kind === 'worldObject' && typeof walkMesh.metadata?.objectEntityId === 'number') {
        const id = walkMesh.metadata.objectEntityId;
        const data = this.worldObjectDefs.get(id);
        return data && this.isWorldObjectOnCurrentInteractionFloor(data) ? id : null;
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
    if (!rootAssetId) return null;

    const expectedDefId = objectDefIdForPlacedAsset(rootAssetId);
    if (expectedDefId == null) return null;
    const placed = this.chunkManager.getPlacedObjectAuthoredPosition(rootNode);
    const px = placed.x;
    const pz = placed.z;
    let bestEid = -1;
    let bestDist = 3.0;
    for (const [eid, data] of this.worldObjectDefs) {
      if (data.defId !== expectedDefId) continue;
      if (!this.isWorldObjectOnCurrentInteractionFloor(data)) continue;
      const dist = Math.hypot(data.x - px, data.z - pz);
      if (dist < bestDist) {
        bestDist = dist;
        bestEid = eid;
      }
    }

    if (bestEid < 0) return null;
    this.setWorldObjectModel(bestEid, rootNode);
    return bestEid;
  }

  private getWorldObjectInteractionOptions(objectEntityId: number): InteractionOption[] {
    const data = this.worldObjectDefs.get(objectEntityId);
    if (!data) return [];
    const def = this.objectDefsCache.get(data.defId);
    if (!this.isWorldObjectOnCurrentInteractionFloor(data, def)) return [];
    if (!def || (data.depleted && def.category !== 'door')) return [];

    if (def.category === 'ladder') return this.getLadderInteractionOptions(objectEntityId, def, data);

    const displayName = this.worldObjectDisplayName(objectEntityId, def);
    return this.actionsForInstance(def, data.depleted, data, this.worldObjectInteractionActions(objectEntityId)).map((actionName, actionIdx) => ({
      label: `${actionName} ${displayName}`,
      primary: actionName === 'Use-quickly' ? false : undefined,
      action: () => this.interactObject(objectEntityId, actionIdx),
    }));
  }

  private worldObjectInteractionActions(objectEntityId: number): readonly string[] {
    const model = this.worldObjectModels.get(objectEntityId);
    const interactions = model?.metadata?.interactions;
    if (Array.isArray(interactions)) return this.availablePlacedInteractionActions(interactions);

    const actions = model?.metadata?.interactionActions;
    return Array.isArray(actions) && actions.every(action => typeof action === 'string')
      ? actions
      : NO_INTERACTION_ACTIONS;
  }

  private availablePlacedInteractionActions(interactions: readonly PlacedObjectInteraction[]): readonly string[] {
    const actions: string[] = [];
    for (const interaction of interactions) {
      if (!this.placedInteractionConditionMet(interaction)) continue;
      const action = interaction.action?.trim();
      if (!action || actions.includes(action)) continue;
      actions.push(action);
    }
    return actions.length > 0 ? actions : NO_INTERACTION_ACTIONS;
  }

  private placedInteractionConditionMet(interaction: PlacedObjectInteraction): boolean {
    if (interaction.condition && !this.clientQuestConditionMet(interaction.condition)) return false;
    if (interaction.conditions?.some(condition => !this.clientQuestConditionMet(condition))) return false;
    return true;
  }

  private clientQuestConditionMet(condition: QuestCondition): boolean {
    switch (condition.type) {
      case 'all':
        return Array.isArray(condition.conditions)
          && condition.conditions.every(child => this.clientQuestConditionMet(child));
      case 'any':
        return Array.isArray(condition.conditions)
          && condition.conditions.some(child => this.clientQuestConditionMet(child));
      case 'not':
        return this.clientQuestConditionMet(condition.condition) === false;
      case 'questStage': {
        const state = this.questState[condition.questId];
        if (!state || state.stage === QUEST_STAGE_COMPLETED) return false;
        if (condition.minStage !== undefined && state.stage < condition.minStage) return false;
        if (condition.maxStage !== undefined && state.stage > condition.maxStage) return false;
        return true;
      }
      case 'questStarted': {
        const state = this.questState[condition.questId];
        return !!state && state.stage !== QUEST_STAGE_COMPLETED;
      }
      case 'questNotStarted': {
        const state = this.questState[condition.questId];
        return !state || state.stage === QUEST_STAGE_COMPLETED;
      }
      case 'questCompleted':
        return this.questState[condition.questId]?.stage === QUEST_STAGE_COMPLETED;
      case 'questVar': {
        const value = this.questState[condition.questId]?.vars?.[condition.key];
        if (typeof value !== 'number') return false;
        if (condition.value !== undefined && value !== condition.value) return false;
        if (condition.min !== undefined && value < condition.min) return false;
        if (condition.max !== undefined && value > condition.max) return false;
        return true;
      }
      case 'hasItem':
        return this.countLocalInventoryItem(condition.itemId) >= (condition.quantity ?? 1);
      case 'hasEquippedItem':
        return this.localHasEquippedItem(condition.itemId);
      case 'skillLevel':
        return (this.sidePanel?.getSkillLevel(condition.skill) ?? 1) >= condition.level;
      case 'combatLevel':
        return this.localCombatLevel() >= condition.level;
    }
  }

  private countLocalInventoryItem(itemId: number): number {
    return this.sidePanel?.getInventory().reduce((total, slot) =>
      total + (slot?.itemId === itemId ? slot.quantity : 0), 0) ?? 0;
  }

  private localHasEquippedItem(itemId: number): boolean {
    if (!this.sidePanel) return false;
    for (let slot = 0; slot < EQUIP_SLOT_NAMES.length; slot++) {
      if (this.sidePanel.getEquipItem(slot) === itemId) return true;
    }
    return false;
  }

  private localCombatLevel(): number {
    if (!this.sidePanel) return 0;
    return combatLevelFromLevels({
      hitpoints: this.sidePanel.getSkillLevel('hitpoints'),
      defence: this.sidePanel.getSkillLevel('defence'),
      weaponry: this.sidePanel.getSkillLevel('weaponry'),
      strength: this.sidePanel.getSkillLevel('strength'),
      archery: this.sidePanel.getSkillLevel('archery'),
      goodmagic: this.sidePanel.getSkillLevel('goodmagic'),
      evilmagic: this.sidePanel.getSkillLevel('evilmagic'),
    });
  }

  private worldObjectDisplayName(objectEntityId: number, def: WorldObjectDef): string {
    const model = this.worldObjectModels.get(objectEntityId);
    const placedName = model?.metadata?.placedName;
    if (typeof placedName === 'string' && placedName.trim()) return placedName.trim();
    const assetId = model?.metadata?.assetId;
    if (def.id === GENERIC_SCENERY_OBJECT_DEF_ID && typeof assetId === 'string') {
      return sceneryExamineMetaForAsset(assetId)?.name ?? def.name;
    }
    return def.name;
  }

  private getLadderInteractionOptions(
    objectEntityId: number,
    def: WorldObjectDef,
    data: { ladderActionMask?: number },
  ): InteractionOption[] {
    const mask = data.ladderActionMask ?? 0;
    const options: InteractionOption[] = [];
    def.actions.forEach((actionName, actionIdx) => {
      const available =
        actionName === 'Examine'
        || (actionName === 'Climb-down' && (mask & 1) !== 0)
        || (actionName === 'Climb-up' && (mask & 2) !== 0);
      if (!available) return;
      options.push({
        label: `${actionName} ${def.name}`,
        primary: actionName === 'Examine' ? false : undefined,
        action: () => this.interactObject(objectEntityId, actionIdx),
      });
    });
    return options;
  }

  private primaryLadderActionIndex(def: WorldObjectDef, data: { ladderActionMask?: number }): number {
    const mask = data.ladderActionMask ?? 0;
    const upIdx = def.actions.indexOf('Climb-up');
    const downIdx = def.actions.indexOf('Climb-down');
    if ((mask & 2) !== 0 && upIdx >= 0) return upIdx;
    if ((mask & 1) !== 0 && downIdx >= 0) return downIdx;
    return -1;
  }

  private runInteractionOption(option: InteractionOption, clientX: number, clientY: number): void {
    this.lastClickX = clientX;
    this.lastClickY = clientY;
    option.action();
  }

  private showContextMenu(x: number, y: number, options: InteractionOption[]): void {
    this.hideContextMenu();
    const coarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;

    let menu: HTMLDivElement;
    menu = createContextMenu(options.map((opt) => ({
      label: opt.label,
      labelParts: opt.labelParts,
      labelColor: opt.labelColor,
      action: (ev) => {
        this.runInteractionOption(opt, ev.clientX, ev.clientY);
      },
    })), {
      x,
      y,
      fontSizePx: coarsePointer ? 15 : 13,
      itemPadding: coarsePointer ? '9px 14px' : undefined,
      minWidthPx: coarsePointer ? 160 : 120,
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
    return npcDefId === 8
      || npcDefId === 11
      || npcDefId === 12
      || npcDefId === 13
      || npcDefId === 14
      || npcDefId === 16
      || npcDefId === 109;
  }

  private isLocalNpcCombatTarget(entityId: number): boolean {
    if (entityId === this.combatTargetId || entityId === this.magicTargetId) return true;
    return this.localPlayerId > 0 && this.entities.npcCombatTargets.get(entityId) === this.localPlayerId;
  }

  private isNonCombatNpc(entityId: number, npcDefId: number | undefined = this.entities.npcDefs.get(entityId)): boolean {
    const name = this.entities.npcOverrideNames.get(entityId) || (npcDefId !== undefined ? this.npcDefsCache.get(npcDefId)?.name : undefined);
    const flags = this.entities.npcInteractions.get(entityId) ?? 0;
    const hasDialogue = (flags & NPC_INTERACTION_HAS_DIALOGUE) !== 0;
    const hasProtectedUi = (flags & (NPC_INTERACTION_HAS_SHOP | NPC_INTERACTION_HAS_BANK)) !== 0;
    const dialogueBlocksCombat = hasDialogue
      && (flags & NPC_INTERACTION_STARTS_COMBAT) === 0
      && !this.isLocalNpcCombatTarget(entityId);
    return hasProtectedUi
      || dialogueBlocksCombat
      || this.isNonAttackableNpc(npcDefId)
      || name === 'Ali the Oasis-Born';
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

  private findPlayerEntityIdFromPick(pickedMesh: TransformNode): number | null {
    let walk: TransformNode | null = pickedMesh;
    while (walk) {
      if (walk.metadata?.kind === 'player' && typeof walk.metadata?.entityId === 'number') {
        const entityId = walk.metadata.entityId;
        return entityId === this.localPlayerId ? null : entityId;
      }
      walk = walk.parent as TransformNode | null;
    }
    return null;
  }

  /** Rotate the local player's facing toward a world (x, z). 2004scape
   *  Player.faceEntity primitive — used by talkToNpc / attackNpc so the
   *  player isn't standing sideways during the interaction. Uses the
   *  CharacterEntity's smooth-yaw state machine (faceTowardXZ) so it lerps
   *  rather than snapping. */
  private faceLocalPlayerToward(x: number, z: number): void {
    const lp = this.localPlayer;
    if (!lp) return;
    lp.faceTowardXZ(x, z);
  }

  private faceLocalPlayerTowardTarget(targetId: number): void {
    const objectData = this.worldObjectDefs.get(targetId);
    if (objectData) {
      this.faceLocalPlayerToward(objectData.x, objectData.z);
      return;
    }
    const target = this.resolveTargetableIncludingLocal(targetId);
    if (target) {
      const anchor = target.getTargetAnchor();
      this.faceLocalPlayerToward(anchor.x, anchor.z);
    }
  }

  private adoptLocalNpcCombatTargetFromServer(targetId: number): void {
    if (targetId <= 0) return;
    if (!this.entities.npcTargets.has(targetId) && !this.entities.npcSprites.has(targetId)) return;
    this.followTargetPlayerId = -1;
    this.followPathTimer = 0;
    if (this.autoCastSpellIndex >= 0) {
      this.combatTargetId = -1;
      this.magicTargetId = targetId;
      this.refreshLocalCombatFacing(targetId);
      return;
    }
    this.magicTargetId = -1;
    this.combatTargetId = targetId;
    this.refreshLocalCombatFacing(targetId);
  }

  private getLocalCombatFaceTargetId(): number {
    return this.magicTargetId >= 0 ? this.magicTargetId : this.combatTargetId;
  }

  private lockLocalPlayerFaceTowardNpc(npcEntityId: number, target?: { x: number; z: number; floor?: number }): void {
    const lp = this.localPlayer;
    if (!lp) return;
    const npcTarget = target ?? this.entities.npcTargets.get(npcEntityId);
    if (npcTarget && npcTarget.floor !== this.currentFloor) return;
    const sprite = this.entities.npcSprites.get(npcEntityId);
    if (sprite) {
      const anchor = sprite.getTargetAnchor();
      lp.lockFaceTowardXZ(anchor.x, anchor.z);
      return;
    }
    if (!npcTarget) return;
    const size = this.getNpcTileSize(npcEntityId);
    lp.lockFaceTowardXZ(
      getObjectFootprintCenterCoord(npcTarget.x, size),
      getObjectFootprintCenterCoord(npcTarget.z, size),
    );
  }

  private refreshLocalCombatFacing(npcEntityId?: number, target?: { x: number; z: number; floor?: number }): void {
    if (!this.localPlayer || this.pathIndex < this.path.length) return;
    const targetId = this.getLocalCombatFaceTargetId();
    if (targetId < 0) return;
    if (npcEntityId !== undefined && npcEntityId !== targetId) return;
    this.lockLocalPlayerFaceTowardNpc(targetId, target);
  }

  private clearDuelFaceTarget(): void {
    if (this.currentDuelOpponentEntityId >= 0) {
      this.entities.remoteCombatTargets.delete(this.currentDuelOpponentEntityId);
    }
  }

  private refreshDuelFacing(): void {
    if (!this.duelActive || this.currentDuelOpponentEntityId < 0) return;
    const local = this.localPlayer;
    if (!local) return;
    const opponentId = this.currentDuelOpponentEntityId;
    const targetState = this.entities.remoteTargets.get(opponentId);
    if (targetState && targetState.floor !== this.currentFloor) return;
    const opponent = this.entities.remotePlayers.get(opponentId);
    if (!opponent) return;

    const opponentAnchor = opponent.getTargetAnchor();
    local.lockFaceTowardXZ(opponentAnchor.x, opponentAnchor.z);

    const localAnchor = local.getTargetAnchor();
    opponent.lockFaceTowardXZ(localAnchor.x, localAnchor.z);
    this.entities.remoteCombatTargets.set(opponentId, this.localPlayerId);
  }

  private getNpcVisualCenter(npcEntityId: number, target?: { x: number; z: number }): { x: number; z: number } | null {
    const sprite = this.entities.npcSprites.get(npcEntityId);
    if (sprite) {
      const anchor = sprite.getTargetAnchor();
      return { x: anchor.x, z: anchor.z };
    }
    const npcTarget = target ?? this.entities.npcTargets.get(npcEntityId);
    if (!npcTarget) return null;
    const size = this.getNpcTileSize(npcEntityId);
    return {
      x: getObjectFootprintCenterCoord(npcTarget.x, size),
      z: getObjectFootprintCenterCoord(npcTarget.z, size),
    };
  }

  private faceLocalPlayerTowardNpc(npcEntityId: number, target?: { x: number; z: number }): void {
    const center = this.getNpcVisualCenter(npcEntityId, target);
    if (center) this.faceLocalPlayerToward(center.x, center.z);
  }

  private clearLocalNpcCombatState(): void {
    this.combatTargetId = -1;
    this.magicTargetId = -1;
    this.pendingSingleCastSpell = -1;
    this.localCombatWalkUntilMs = 0;
  }

  /** scene.pick returns the closest hit; that lets placed scenery (anvils,
   *  walls, planes) intercept clicks aimed at an NPC behind them. RuneScape-
   *  style left-click sees through occluders to NPCs in the same ray, so we
   *  multiPick and walk hits sorted by distance, returning the FIRST hit
   *  that resolves to an NPC entity. Falls back to the closest mesh so the
   *  caller can still pick ground / placed objects / ground-items normally
   *  when there's no NPC in the ray. */
  private pickAtCursor(): { entityId: number | null; groundItem: GroundItemPickRef | null; closestMesh: import('@babylonjs/core/Meshes/abstractMesh').AbstractMesh | null } {
    return this.pickNpcAtPoint(this.scene.pointerX, this.scene.pointerY);
  }

  private pickNpcAtPoint(x: number, y: number): { entityId: number | null; groundItem: GroundItemPickRef | null; closestMesh: import('@babylonjs/core/Meshes/abstractMesh').AbstractMesh | null } {
    if (this.destroyed || this.scene.isDisposed) return { entityId: null, groundItem: null, closestMesh: null };
    const hits = this.scene.multiPick(x, y);
    if (!hits || hits.length === 0) return { entityId: null, groundItem: null, closestMesh: null };
    // multiPick returns hits unsorted; sort by distance ascending.
    hits.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    const closest = hits[0].pickedMesh ?? null;
    // Walk every hit, not just the closest: an NPC's legs or a ground-item
    // sprite is often occluded by nearer scenery. Take the first match of
    // each kind so a hover resolves to whatever is actually under the cursor.
    let entityId: number | null = null;
    let groundItem: GroundItemPickRef | null = null;
    for (const h of hits) {
      const m = h.pickedMesh;
      if (!m) continue;
      if (entityId == null) {
        entityId = this.findNpcEntityIdFromPick(m as unknown as TransformNode, m.name);
      }
      if (groundItem == null) {
        groundItem = this.findGroundItemFromPick(m as unknown as TransformNode, m.name);
      }
      if (entityId != null && groundItem != null) break;
    }
    return { entityId, groundItem, closestMesh: closest };
  }

  private pickPlayerAtPoint(x: number, y: number): number | null {
    if (this.destroyed || this.scene.isDisposed) return null;
    const hits = this.scene.multiPick(x, y);
    if (!hits || hits.length === 0) return null;
    hits.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
    for (const hit of hits) {
      const mesh = hit.pickedMesh;
      if (!mesh) continue;
      const entityId = this.findPlayerEntityIdFromPick(mesh as unknown as TransformNode);
      if (entityId != null && this.entities.remotePlayers.has(entityId)) return entityId;
    }
    return null;
  }

  /** Combat level for an NPC, preferring the server-sent effective spawn stats. */
  private npcLevelFor(entityId: number | undefined, npcDefId: number | undefined): number {
    if (entityId != null) {
      const effective = this.entities.npcCombatLevels.get(entityId);
      if (effective != null && effective > 0) return effective;
    }
    if (npcDefId == null) return 0;
    const def = this.npcDefsCache.get(npcDefId);
    if (!def) return 0;
    return def.combatLevel ?? npcCombatLevel(def);
  }

  private setupNpcTooltip(canvas: HTMLCanvasElement): void {
    const el = document.createElement('div');
    el.className = 'npc-tooltip-overlay';
    el.style.cssText = [
      'position: fixed', 'pointer-events: none', 'z-index: 999',
      'background: #1a1410ee', 'border: 1px solid #5a4a35',
      'color: #d8372b', 'font: 12px Arial, Helvetica, sans-serif',
      'padding: 3px 7px', 'display: none', 'white-space: nowrap',
    ].join('; ');
    document.body.appendChild(el);

    let lastPickAt = 0;
    this._npcTooltipHandler = (e) => {
      this._lastRoofHoverClientX = e.clientX;
      this._lastRoofHoverClientY = e.clientY;
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
      this.updateHoverRoofReveal(e.clientX, e.clientY);
      this._lastRoofHoverRefreshAt = now;
      const playerEntityId = this.pickPlayerAtPoint(this.scene.pointerX, this.scene.pointerY);
      const { entityId, groundItem } = this.pickAtCursor();
      let playerLabel: string | null = null;
      let playerIsAdmin = false;
      let playerIsModerator = false;
      if (playerEntityId != null) {
        const name = this.entities.playerNames.get(playerEntityId) ?? 'Player';
        const lvl = this.entities.remoteCombatLevels.get(playerEntityId) ?? 0;
        playerIsAdmin = this.entities.remoteAdminFlags.get(playerEntityId) === true;
        playerIsModerator = this.entities.remoteModeratorFlags.get(playerEntityId) === true;
        playerLabel = lvl > 0 ? `${name} (level-${lvl})` : name;
      }
      let npcLabel: string | null = null;
      if (playerLabel == null && entityId != null) {
        const npcDefId = this.entities.npcDefs.get(entityId);
        const name = this.npcDisplayName(entityId, npcDefId);
        if (this.isNonCombatNpc(entityId, npcDefId)) {
          npcLabel = name;
        } else {
          const lvl = this.npcLevelFor(entityId, npcDefId);
          npcLabel = lvl > 0 ? `${name} (level-${lvl})` : name;
        }
      }
      // Ground items: only when the cursor isn't already over an NPC — NPC
      // wins, mirroring the click priority. Show the tile pile in display
      // order, capped so a large drop stack doesn't rebuild a huge tooltip.
      let itemLines: string[] = [];
      if (playerLabel == null && npcLabel == null && groundItem) {
        itemLines = this.groundItemTooltipLines(this.groundItemStackForPick(groundItem).filter(gi => gi.floor === this.currentFloor));
      }
      if (playerLabel != null) {
        el.style.color = this.playerNameColor(playerIsAdmin, playerIsModerator);
        el.textContent = playerLabel;
      } else if (npcLabel != null) {
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
      if (playerLabel != null || npcLabel != null || itemLines.length > 0) {
        el.style.left = `${e.clientX + 14}px`;
        el.style.top = `${e.clientY + 14}px`;
        el.style.display = 'block';
      } else if (el.style.display !== 'none') {
        el.style.display = 'none';
      }
    };
    this._roofHoverLeaveHandler = () => this.clearHoverRoofPointer();
    canvas.addEventListener('pointermove', this._npcTooltipHandler);
    canvas.addEventListener('pointerleave', this._roofHoverLeaveHandler);
  }

  /** Redirect an NPC/object click to a use-on-target packet if the inventory
   *  has a Use slot armed. Returns true if the click was consumed. Object
   *  use is sent once; the server owns any walk-then-use deferral. */
  private tryUseInventoryItemOn(kind: 'npc' | 'object', entityId: number): boolean {
    const using = this.sidePanel?.getUsing();
    if (!using) return false;
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ffd060');
    this.sidePanel!.clearUsingInvItem();

    if (kind === 'npc') {
      const target = this.entities.npcTargets.get(entityId);
      if (target && target.floor !== this.currentFloor) return true;
      if (target) {
        const shouldPredictWalk = this.pathIndex < this.path.length
          || !this.isPlayerOnNpcInteractionTile(entityId, target);
        if (shouldPredictWalk) {
          const pathResult = this.findPathToNpcInteraction(entityId, target);
          if (pathResult.path.length > 0) {
            this.startPredictedPath(pathResult.path, pathResult.preserveCurrentStep);
            if (this.destMarker) this.destMarker.isVisible = false;
            this.minimap?.clearDestination();
          } else {
            this.keepCurrentPredictedStepForInteraction();
          }
        }
      }
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_USE_ITEM_ON_NPC, using.slot, using.itemId, entityId));
      return true;
    }

    const data = this.worldObjectDefs.get(entityId);
    const def = data ? this.objectDefsCache.get(data.defId) : null;
    if (data && !this.isWorldObjectOnCurrentInteractionFloor(data, def)) return true;
    if (!data || !def) {
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_USE_ITEM_ON_OBJECT, using.slot, using.itemId, entityId));
      return true;
    }

    const ptx = Math.floor(this.playerX);
    const ptz = Math.floor(this.playerZ);
    const alreadyAdj = this.isOnObjectInteractionTile(ptx, ptz, data, def);
    if (alreadyAdj) {
      if (!this.stopLocalWalkForImmediateObjectInteraction(data, def)) return true;
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_USE_ITEM_ON_OBJECT, using.slot, using.itemId, entityId));
      return true;
    }

    if (this.walkToAdjacentTileOf(data, def)) {
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_USE_ITEM_ON_OBJECT, using.slot, using.itemId, entityId));
      return true;
    }

    // No reachable adjacent tile — let the server send the reach error.
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_USE_ITEM_ON_OBJECT, using.slot, using.itemId, entityId));
    return true;
  }

  private attackNpc(npcEntityId: number): void {
    if (performance.now() < this.castingUntil) return;
    const floorTarget = this.entities.npcTargets.get(npcEntityId);
    if (floorTarget && floorTarget.floor !== this.currentFloor) return;
    if (this.tryUseInventoryItemOn('npc', npcEntityId)) return;
    if (this.isNonCombatNpc(npcEntityId)) {
      this.talkToNpc(npcEntityId);
      return;
    }

    const targetingSpell = this.sidePanel?.getTargetingSpell() ?? -1;
    if (targetingSpell >= 0) {
      this.pendingSingleCastSpell = targetingSpell;
      this.combatTargetId = -1;
      this.magicTargetId = npcEntityId;
      this.predictSpellCastMovementToNpc(npcEntityId);
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_CAST_SPELL, targetingSpell, npcEntityId));
      this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#a040ff');
      this.sidePanel!.clearTargetingSpell();
      return;
    }

    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    this.combatTargetId = npcEntityId;
    this.autoCastSpellIndex = this.sidePanel?.getAutocastSpell() ?? -1;
    this.pendingFaceTargetEntityId = npcEntityId;
    const target = this.entities.npcTargets.get(npcEntityId);
    this._combatPathTimer = 0.6;

    if (this.autoCastSpellIndex >= 0) {
      this.combatTargetId = -1;
      this.magicTargetId = npcEntityId;
      this.predictSpellCastMovementToNpc(npcEntityId);
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_ATTACK_NPC, npcEntityId));
      return;
    }

    if (target) {
      const attackRange = this.getLocalNpcAttackRange();
      const rangeMode = this.getLocalNpcAttackRangeMode();
      const requireRangedLineOfSight = this.isLocalRangedWeapon();
      const walkingToTile = this.pathIndex < this.path.length;
      if (this.isPointInNpcInteractionRange(npcEntityId, target, this.playerX, this.playerZ, attackRange, rangeMode, requireRangedLineOfSight)) {
        if (walkingToTile) {
          const pathResult = this.findPathToNpcInteraction(npcEntityId, target, attackRange, rangeMode, requireRangedLineOfSight);
          if (pathResult.path.length > 0) {
            this.startPredictedPath(pathResult.path, pathResult.preserveCurrentStep);
            if (this.destMarker) this.destMarker.isVisible = false;
            this.minimap?.clearDestination();
          } else {
            this.keepCurrentPredictedStepForInteraction();
          }
        } else {
          this.clearPredictedPath(true);
          if (this.localPlayer?.isWalking()) this.localPlayer.stopWalking();
          this.faceLocalPlayerTowardNpc(npcEntityId, target);
        }
      } else {
        const pathResult = this.findPathToNpcInteraction(npcEntityId, target, attackRange, rangeMode, requireRangedLineOfSight);
        const path = pathResult.path;
        if (path.length > 0) {
          this.startPredictedPath(path, pathResult.preserveCurrentStep);
          if (this.destMarker) this.destMarker.isVisible = false;
          this.minimap?.clearDestination();
        } else {
          this.faceLocalPlayerTowardNpc(npcEntityId, target);
        }
      }
    }
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_ATTACK_NPC, npcEntityId));
  }

  private handleAutocastChange(spellIndex: number): void {
    this.autoCastSpellIndex = spellIndex;
    const targetId = this.magicTargetId >= 0 ? this.magicTargetId : this.combatTargetId;
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_SET_AUTOCAST, spellIndex));
    if (targetId < 0) return;
    if (this.isNonCombatNpc(targetId)) {
      this.clearLocalNpcCombatState();
      return;
    }

    this._combatPathTimer = 0;
    if (spellIndex >= 0) {
      this.combatTargetId = -1;
      this.magicTargetId = targetId;
      this.predictSpellCastMovementToNpc(targetId);
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_ATTACK_NPC, targetId));
      return;
    }

    this.magicTargetId = -1;
    this.combatTargetId = targetId;
    if (performance.now() >= this.castingUntil) {
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_ATTACK_NPC, targetId));
    }
  }

  private predictSpellCastMovementToNpc(npcEntityId: number): void {
    const target = this.entities.npcTargets.get(npcEntityId);
    if (target) {
      const shouldPredictWalk = this.pathIndex < this.path.length
        || !this.isPlayerInNpcInteractionRange(npcEntityId, target, SPELL_CAST_DISTANCE);
      if (shouldPredictWalk) {
        const pathResult = this.findPathToNpcInteraction(npcEntityId, target, SPELL_CAST_DISTANCE, 'chebyshev');
        if (pathResult.path.length > 0) {
          this.startPredictedPath(pathResult.path, pathResult.preserveCurrentStep);
          if (this.destMarker) this.destMarker.isVisible = false;
          this.minimap?.clearDestination();
          return;
        }
        if (this.keepCurrentPredictedStepForInteraction()) return;
      }
    }
    if (this.keepCurrentPredictedStepForInteraction()) return;
    this.rootLocalPlayerForSpellCast();
  }

  private followPlayer(playerEntityId: number): void {
    const targetState = this.entities.remoteTargets.get(playerEntityId);
    if (targetState && targetState.floor !== this.currentFloor) return;
    const target = this.entities.remotePlayers.get(playerEntityId);
    if (target) {
      const anchor = target.getTargetAnchor();
      this.faceLocalPlayerToward(anchor.x, anchor.z);
    }
    this.combatTargetId = -1;
    this.magicTargetId = -1;
    this.pendingSingleCastSpell = -1;
    this._combatPathTimer = 0;
    this.followTargetPlayerId = playerEntityId;
    this.followPathTimer = 0;
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_FOLLOW, playerEntityId));
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ffffff');
  }

  private enableTradeInventoryOffers(): void {
    this.sidePanel?.switchTab('inventory');
    this.sidePanel?.setTradeOfferCallback((slot, _itemId, quantity) => {
      this.tradePanel?.offerInventorySlot(slot, quantity);
    });
  }

  private enableDuelInventoryStakes(): void {
    this.sidePanel?.switchTab('inventory');
    this.sidePanel?.setTradeOfferCallback((slot, _itemId, quantity) => {
      this.duelPanel?.offerInventorySlot(slot, quantity);
    });
  }

  private acceptTradeRequest(requesterEntityId: number, name: string): void {
    this.network.sendRaw(encodePacket(ClientOpcode.TRADE_ACCEPT_REQUEST, requesterEntityId));
    this.chatPanel?.addSystemMessage(`Accepting trade request from ${name}...`, '#ff0');
  }

  private requestTrade(playerEntityId: number): void {
    const targetState = this.entities.remoteTargets.get(playerEntityId);
    if (targetState && targetState.floor !== this.currentFloor) return;
    const target = this.entities.remotePlayers.get(playerEntityId);
    if (target) {
      const anchor = target.getTargetAnchor();
      this.faceLocalPlayerToward(anchor.x, anchor.z);
    }
    this.combatTargetId = -1;
    this.magicTargetId = -1;
    this.pendingSingleCastSpell = -1;
    this._combatPathTimer = 0;
    this.followTargetPlayerId = -1;
    this.followPathTimer = 0;
    this.network.sendRaw(encodePacket(ClientOpcode.TRADE_REQUEST, playerEntityId));
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#d8b45a');
  }

  private attackDuelPlayer(playerEntityId: number): void {
    if (!this.duelActive || playerEntityId !== this.currentDuelOpponentEntityId) return;
    const targetState = this.entities.remoteTargets.get(playerEntityId);
    if (targetState && targetState.floor !== this.currentFloor) return;
    this.clearLocalNpcCombatState();
    this._combatPathTimer = 0;
    this.followTargetPlayerId = -1;
    this.followPathTimer = 0;
    this.clearPredictedPath(true);
    this.localPlayer?.stopWalking();
    this.refreshDuelFacing();
    this.minimap?.clearDestination();
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
  }

  private acceptDuelRequest(requesterEntityId: number, name: string): void {
    this.network.sendRaw(encodePacket(ClientOpcode.DUEL_ACCEPT_REQUEST, requesterEntityId));
    this.chatPanel?.addSystemMessage(`Accepting duel request from ${name}...`, '#ff0');
  }

  private requestDuel(playerEntityId: number): void {
    const targetState = this.entities.remoteTargets.get(playerEntityId);
    if (targetState && targetState.floor !== this.currentFloor) return;
    const target = this.entities.remotePlayers.get(playerEntityId);
    if (target) {
      const anchor = target.getTargetAnchor();
      this.faceLocalPlayerToward(anchor.x, anchor.z);
    }
    this.combatTargetId = -1;
    this.magicTargetId = -1;
    this.pendingSingleCastSpell = -1;
    this._combatPathTimer = 0;
    this.followTargetPlayerId = -1;
    this.followPathTimer = 0;
    this.network.sendRaw(encodePacket(ClientOpcode.DUEL_REQUEST, playerEntityId));
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#d8372b');
  }

  private talkToNpc(npcEntityId: number): void {
    if (performance.now() < this.castingUntil) return;
    const target = this.entities.npcTargets.get(npcEntityId);
    if (target && target.floor !== this.currentFloor) return;
    if (this.tryUseInventoryItemOn('npc', npcEntityId)) return;
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    this.resumeTalkToNpc(npcEntityId);
  }

  private examineNpc(npcEntityId: number): void {
    const target = this.entities.npcTargets.get(npcEntityId);
    if (!target || target.floor !== this.currentFloor) return;
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_EXAMINE_NPC, npcEntityId));
  }

  private resumeTalkToNpc(npcEntityId: number): void {
    const target = this.entities.npcTargets.get(npcEntityId);
    if (!target) return;
    if (target.floor !== this.currentFloor) return;
    this.pendingFaceTargetEntityId = npcEntityId;

    // sendMove BEFORE TALK_NPC so the server walks the same tiles.
    const bankerBoothPath = this.findPathToBankerBooth(npcEntityId, target);
    if (bankerBoothPath && bankerBoothPath.path.length === 0) {
      this.clearPredictedPath();
      if (this.localPlayer?.isWalking()) this.localPlayer.stopWalking();
      this.faceLocalPlayerTowardNpc(npcEntityId, target);
      this.pendingFaceTargetEntityId = -1;
    } else if (bankerBoothPath) {
      this.startPredictedPath(bankerBoothPath.path, bankerBoothPath.preserveCurrentStep);
      if (this.destMarker) this.destMarker.isVisible = false;
      this.minimap?.clearDestination();
    } else if (!this.isPlayerOnNpcInteractionTile(npcEntityId, target)) {
      const pathResult = this.findPathToNpcInteraction(npcEntityId, target);
      const path = pathResult.path;
      if (path.length > 0) {
        this.startPredictedPath(path, pathResult.preserveCurrentStep);
        if (this.destMarker) this.destMarker.isVisible = false;
        this.minimap?.clearDestination();
      }
    } else {
      // Already adjacent while idle can face immediately. If we are mid-step,
      // re-evaluate from the movement anchor so rapid redirects keep walking
      // instead of cutting the path and waiting for a server correction.
      if (this.pathIndex < this.path.length) {
        const pathResult = this.findPathToNpcInteraction(npcEntityId, target);
        if (pathResult.path.length > 0) {
          this.startPredictedPath(pathResult.path, pathResult.preserveCurrentStep);
          if (this.destMarker) this.destMarker.isVisible = false;
          this.minimap?.clearDestination();
        } else {
          this.keepCurrentPredictedStepForInteraction();
        }
      } else {
        this.clearPredictedPath();
        if (this.localPlayer?.isWalking()) this.localPlayer.stopWalking();
        this.faceLocalPlayerTowardNpc(npcEntityId, target);
        this.pendingFaceTargetEntityId = -1;
      }
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

  private isTileOnActivePredictedStep(tx: number, tz: number): boolean {
    if (this.pathIndex >= this.path.length) return false;
    if (Math.floor(this.tileFrom.x) === tx && Math.floor(this.tileFrom.z) === tz) return false;
    return this.tileOnCompressedSegment(this.tileFrom, this.path[this.pathIndex], tx, tz);
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
    this.predictedPathStartedAt = 0;
    this.predictedPathDestination = null;
    this.predictedPathAuthorityReanchorAttempts = 0;
    this.localCombatWalkUntilMs = 0;
    if (resetAnchor) this.setTileFrom(this.playerX, this.playerZ);
  }

  private isFreshPredictedPath(now: number = performance.now()): boolean {
    return this.predictedPathStartedAt > 0
      && this.pathIndex < this.path.length
      && now - this.predictedPathStartedAt <= GameManager.FRESH_PREDICTION_RECONCILE_GRACE_MS;
  }

  private refreshPredictedDestinationFromPath(): void {
    if (!this.predictedPathDestination) return;
    const dest = this.path[this.path.length - 1];
    this.predictedPathDestination = dest ? { x: dest.x, z: dest.z } : null;
    this.predictedPathAuthorityReanchorAttempts = 0;
  }

  private armControlledMoveLock(path: { x: number; z: number }[]): void {
    this.controlledMoveUntilMs = performance.now() + Math.max(TICK_RATE, path.length * TICK_RATE + 600);
  }

  private clearControlledMoveLock(): void {
    this.controlledMoveUntilMs = 0;
  }

  private isControlledMoveActive(now: number = performance.now()): boolean {
    if (this.controlledMoveUntilMs <= 0) return false;
    if (now <= this.controlledMoveUntilMs && this.pathIndex < this.path.length) return true;
    this.clearControlledMoveLock();
    return false;
  }

  private trimPredictedPathToCurrentTileStep(
    notifyServer: boolean = true,
    allowAuthorityReanchor: boolean = notifyServer,
  ): boolean {
    if (this.pathIndex >= this.path.length) return false;
    const activeStep = this.getActiveUnitStep();
    const currentTarget = activeStep?.target ?? this.path[this.pathIndex];
    const alreadyTrimmed = this.path.length === 1
      && this.pathIndex === 0
      && this.pendingPath === null
      && this.sameTile(this.path[0], currentTarget);
    if (alreadyTrimmed) {
      if (allowAuthorityReanchor && !this.predictedPathDestination) {
        this.predictedPathDestination = { x: currentTarget.x, z: currentTarget.z };
        this.predictedPathAuthorityReanchorAttempts = 0;
      } else if (!allowAuthorityReanchor) {
        this.predictedPathDestination = null;
        this.predictedPathAuthorityReanchorAttempts = 0;
      }
      return false;
    }

    this.path = [currentTarget];
    this.pathIndex = 0;
    this.pendingPath = null;
    this.predictedPathDestination = allowAuthorityReanchor ? { x: currentTarget.x, z: currentTarget.z } : null;
    this.predictedPathAuthorityReanchorAttempts = 0;
    if (activeStep) {
      this.tileProgress = activeStep.progress;
      this.setTileFrom(activeStep.from.x, activeStep.from.z);
    }
    if (this.destMarker) this.destMarker.isVisible = false;
    this.minimap?.clearDestination();

    if (notifyServer) this.network.sendMove([currentTarget]);
    return true;
  }

  private keepCurrentPredictedStepForInteraction(): boolean {
    if (this.pathIndex >= this.path.length) return false;
    this.trimPredictedPathToCurrentTileStep();
    return true;
  }

  private redirectActiveWalkToObjectInteraction(
    data: { x: number; z: number; interactionSides?: number; rotY?: number; interactionTiles?: { x: number; z: number }[] },
    def: WorldObjectDef,
  ): boolean {
    if (this.pathIndex >= this.path.length) return false;
    if (this.walkToAdjacentTileOf(data, def)) {
      if (this.destMarker) this.destMarker.isVisible = false;
      this.minimap?.clearDestination();
      return true;
    }
    return false;
  }

  private stopLocalWalkForImmediateObjectInteraction(
    data: { x: number; z: number; interactionSides?: number; rotY?: number; interactionTiles?: { x: number; z: number }[] },
    def?: WorldObjectDef,
  ): boolean {
    if (def && this.pathIndex < this.path.length) return this.redirectActiveWalkToObjectInteraction(data, def);
    if (!def && this.keepCurrentPredictedStepForInteraction()) return true;
    this.clearPredictedPath(true);
    this.minimap?.clearDestination();
    this.localPlayer?.stopWalking();
    this.faceLocalPlayerToward(data.x, data.z);
    return true;
  }

  private rootLocalPlayerForSpellCast(notifyServer: boolean = true): void {
    this.clearPredictedPath(true);
    this.slideOffsetX = 0;
    this.slideOffsetZ = 0;
    this.slideStartMs = 0;
    this.localPlayer?.stopWalking();
    if (this.localPlayer) {
      this.localPlayer.setPositionXYZ(this.playerX, this.getHeight(this.playerX, this.playerZ), this.playerZ);
    }
    if (notifyServer) this.network.sendMove([]);
  }

  private armSpellMovementLock(now: number): void {
    this.spellMovementUnlockOnSelfSync = true;
    this.spellMovementLockedUntil = now + TICK_RATE;
  }

  private clearSpellMovementLockOnSelfSync(): void {
    if (!this.spellMovementUnlockOnSelfSync) return;
    this.spellMovementUnlockOnSelfSync = false;
    this.spellMovementLockedUntil = 0;
  }

  private isSpellMovementLocked(now: number = performance.now()): boolean {
    if (this.spellMovementLockedUntil <= 0) return false;
    if (now < this.spellMovementLockedUntil) return true;
    this.spellMovementUnlockOnSelfSync = false;
    this.spellMovementLockedUntil = 0;
    return false;
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

  private pathReachesGoal(path: { x: number; z: number }[], goalX: number, goalZ: number): boolean {
    const last = path[path.length - 1];
    return !!last && Math.floor(last.x) === Math.floor(goalX) && Math.floor(last.z) === Math.floor(goalZ);
  }

  private getNpcTileSize(npcEntityId: number): number {
    const defId = this.entities.npcDefs.get(npcEntityId);
    return Math.max(1, Math.round(this.npcDefsCache.get(defId ?? -1)?.size ?? 1));
  }

  private distToNpcFootprint(npcEntityId: number, target: { x: number; z: number }, x: number, z: number): { dx: number; dz: number } {
    const size = this.getNpcTileSize(npcEntityId);
    if (size <= 1) return { dx: x - target.x, dz: z - target.z };
    const minTileX = getObjectFootprintMinTile(target.x, size);
    const minTileZ = getObjectFootprintMinTile(target.z, size);
    const minX = minTileX + 0.5;
    const maxX = minTileX + size - 0.5;
    const minZ = minTileZ + 0.5;
    const maxZ = minTileZ + size - 0.5;
    const nearestX = x < minX ? minX : (x > maxX ? maxX : x);
    const nearestZ = z < minZ ? minZ : (z > maxZ ? maxZ : z);
    return { dx: x - nearestX, dz: z - nearestZ };
  }

  private hasRangedLineOfSightToNpc(
    npcEntityId: number,
    target: { x: number; z: number; floor: number; y: number },
    fromX: number,
    fromZ: number,
  ): boolean {
    const sameTile = Math.floor(fromX) === Math.floor(this.playerX)
      && Math.floor(fromZ) === Math.floor(this.playerZ);
    const currentY = this.localPlayer?.position.y ?? this.getHeightAtFloor(this.playerX, this.playerZ, this.currentFloor);
    const sourceBaseY = sameTile
      ? currentY
      : this.getHeightAtFloor(fromX, fromZ, this.currentFloor, currentY);
    const sourceY = sourceBaseY + RANGED_PROJECTILE_SOURCE_HEIGHT;
    const targetY = target.y + RANGED_PROJECTILE_TARGET_HEIGHT;
    const size = this.getNpcTileSize(npcEntityId);
    if (size <= 1) {
      return this.chunkManager.hasProjectileLineOfSight(
        fromX,
        fromZ,
        target.x,
        target.z,
        this.currentFloor,
        sourceY,
        targetY,
      );
    }
    const minTileX = getObjectFootprintMinTile(target.x, size);
    const minTileZ = getObjectFootprintMinTile(target.z, size);
    for (let dz = 0; dz < size; dz++) {
      for (let dx = 0; dx < size; dx++) {
        if (this.chunkManager.hasProjectileLineOfSight(
          fromX,
          fromZ,
          minTileX + dx + 0.5,
          minTileZ + dz + 0.5,
          this.currentFloor,
          sourceY,
          targetY,
        )) {
          return true;
        }
      }
    }
    return false;
  }

  private isPlayerInNpcInteractionRange(npcEntityId: number, target: { x: number; z: number }, range: number): boolean {
    const fp = this.distToNpcFootprint(npcEntityId, target, this.playerX, this.playerZ);
    if (Math.max(Math.abs(fp.dx), Math.abs(fp.dz)) > range) return false;

    const ptx = Math.floor(this.playerX);
    const ptz = Math.floor(this.playerZ);
    for (const tile of this.getNpcInteractionTilesWithLineOfWalk(npcEntityId, target)) {
      if (ptx === tile.x && ptz === tile.z) return true;
      const { path } = this.findPathFromMovementAnchor(tile.x + 0.5, tile.z + 0.5, 500);
      if (path.length > 0 && path.length <= range) return true;
    }
    return false;
  }

  private isPlayerOnNpcInteractionTile(npcEntityId: number, target: { x: number; z: number }): boolean {
    return this.isPointOnNpcInteractionTile(npcEntityId, target, this.playerX, this.playerZ);
  }

  private isPointOnNpcInteractionTile(npcEntityId: number, target: { x: number; z: number }, x: number, z: number): boolean {
    const ptx = Math.floor(x);
    const ptz = Math.floor(z);
    return this.getNpcInteractionTilesWithLineOfWalk(npcEntityId, target)
      .some(tile => ptx === tile.x && ptz === tile.z);
  }

  private isBankerNpc(npcEntityId: number): boolean {
    return ((this.entities.npcInteractions.get(npcEntityId) ?? 0) & 4) !== 0;
  }

  private getBankerBoothUseTiles(npcEntityId: number, target: { x: number; z: number }): { x: number; z: number }[] {
    if (!this.isBankerNpc(npcEntityId)) return [];
    const ntx = Math.floor(target.x);
    const ntz = Math.floor(target.z);
    const tiles: { x: number; z: number; dist: number }[] = [];
    for (const data of this.worldObjectDefs.values()) {
      if (data.floor !== this.currentFloor) continue;
      const def = this.objectDefsCache.get(data.defId);
      if (def?.category !== 'bank') continue;
      const bx = Math.floor(data.x);
      const bz = Math.floor(data.z);
      const dx = ntx - bx;
      const dz = ntz - bz;
      if (Math.abs(dx) + Math.abs(dz) !== 1) continue;
      const useTile = { x: bx - dx, z: bz - dz };
      if (this.isTileBlocked(useTile.x, useTile.z)) continue;
      tiles.push({
        ...useTile,
        dist: Math.max(Math.abs((useTile.x + 0.5) - this.playerX), Math.abs((useTile.z + 0.5) - this.playerZ)),
      });
    }
    tiles.sort((a, b) => a.dist - b.dist);
    return tiles.map(({ x, z }) => ({ x, z }));
  }

  private findPathToBankerBooth(
    npcEntityId: number,
    target: { x: number; z: number },
  ): { path: { x: number; z: number }[]; preserveCurrentStep: boolean } | null {
    for (const tile of this.getBankerBoothUseTiles(npcEntityId, target)) {
      if (this.pathIndex >= this.path.length && Math.floor(this.playerX) === tile.x && Math.floor(this.playerZ) === tile.z) {
        return { path: [], preserveCurrentStep: false };
      }
      const result = this.findPathFromMovementAnchor(tile.x + 0.5, tile.z + 0.5, 500);
      if (this.pathReachesGoal(result.path, tile.x + 0.5, tile.z + 0.5)) return result;
    }
    return null;
  }

  private getNpcInteractionTilesWithLineOfWalk(npcEntityId: number, target: { x: number; z: number }): { x: number; z: number }[] {
    const size = this.getNpcTileSize(npcEntityId);
    const footprint = getObjectFootprintTiles(target.x, target.z, { width: size });
    const hasLineOfWalk = (tileX: number, tileZ: number) => {
      for (const foot of footprint) {
        if (Math.abs(foot.x - tileX) + Math.abs(foot.z - tileZ) !== 1) continue;
        if (!this.isWallBlockedForPath(tileX, tileZ, foot.x, foot.z)) return true;
      }
      return false;
    };
    return getObjectInteractionTiles(target.x, target.z, { width: size })
      .filter(tile => !this.isTileBlocked(tile.x, tile.z) && hasLineOfWalk(tile.x, tile.z));
  }

  private isPointInNpcInteractionRange(
    npcEntityId: number,
    target: { x: number; z: number; floor: number; y: number },
    x: number,
    z: number,
    range: number,
    mode: 'euclidean' | 'chebyshev' | 'cardinal' = 'euclidean',
    requireRangedLineOfSight: boolean = false,
  ): boolean {
    if (mode === 'cardinal') {
      return this.isPointOnNpcInteractionTile(npcEntityId, target, x, z);
    }
    const fp = this.distToNpcFootprint(npcEntityId, target, x, z);
    const inRange = combatRangeIncludesOffset(fp.dx, fp.dz, range, mode);
    if (!inRange) return false;
    return !requireRangedLineOfSight || this.hasRangedLineOfSightToNpc(npcEntityId, target, x, z);
  }

  private findPathToNpcInteraction(
    npcEntityId: number,
    target: { x: number; z: number; floor: number; y: number },
    requiredRange: number = 1,
    rangeMode: 'euclidean' | 'chebyshev' | 'cardinal' = 'cardinal',
    requireRangedLineOfSight: boolean = false,
  ): { path: { x: number; z: number }[]; preserveCurrentStep: boolean } {
    const reached = (x: number, z: number): boolean =>
      this.isPointInNpcInteractionRange(npcEntityId, target, x, z, requiredRange, rangeMode, requireRangedLineOfSight);

    const activeStep = this.tileProgress > 0 ? this.getActiveUnitStep() : null;
    const start = activeStep?.target ?? { x: this.playerX, z: this.playerZ };
    if (!activeStep && reached(this.playerX, this.playerZ)) {
      return { path: [], preserveCurrentStep: false };
    }

    const targetSize = this.getNpcTileSize(npcEntityId);
    const targetMinX = getObjectFootprintMinTile(target.x, targetSize);
    const targetMinZ = getObjectFootprintMinTile(target.z, targetSize);
    const isTargetFootprintTile = (tileX: number, tileZ: number): boolean =>
      tileX >= targetMinX && tileX < targetMinX + targetSize
      && tileZ >= targetMinZ && tileZ < targetMinZ + targetSize;

    const path = findPathToReach({
      startX: start.x,
      startZ: start.z,
      collision: {
        width: this.chunkManager.getMapWidth(),
        height: this.chunkManager.getMapHeight(),
        isTileBlocked: (tileX, tileZ) => isTargetFootprintTile(tileX, tileZ) || this.isTileBlocked(tileX, tileZ),
        isWallBlocked: this.isWallBlockedForPath,
      },
      maxSearchTiles: NPC_TARGET_PATH_MAX_SEARCH_TILES,
      maxWaypoints: NPC_TARGET_PATH_MAX_WAYPOINTS,
      compress: true,
      reached: (tileX, tileZ) => !isTargetFootprintTile(tileX, tileZ) && reached(tileX + 0.5, tileZ + 0.5),
    });

    if (!activeStep) return { path, preserveCurrentStep: false };
    if (reached(activeStep.target.x, activeStep.target.z) || path.length === 0) {
      return { path: [activeStep.target], preserveCurrentStep: true };
    }
    return { path: [activeStep.target, ...path], preserveCurrentStep: true };
  }

  private getLocalWeaponDef(): ItemDef | undefined {
    const weaponId = this.sidePanel?.getEquipItem(0) ?? 0;
    return this.itemDefsCache.get(weaponId);
  }

  private isLocalRangedWeapon(): boolean {
    const weaponDef = this.getLocalWeaponDef();
    const style = weaponDef?.weaponStyle;
    return style === 'bow' || style === 'crossbow';
  }

  private getLocalRangedAttackRange(): number {
    const attackRange = this.getLocalWeaponDef()?.attackRange;
    return attackRange === undefined ? GameManager.RANGED_ATTACK_DISTANCE : normalizeRangedAttackDistance(attackRange);
  }

  private getLocalNpcAttackRange(): number {
    return this.isLocalRangedWeapon() ? this.getLocalRangedAttackRange() : 1.5;
  }

  private getLocalNpcAttackRangeMode(): 'euclidean' | 'chebyshev' | 'cardinal' {
    return this.isLocalRangedWeapon() ? 'chebyshev' : 'cardinal';
  }

  private startPredictedPath(path: { x: number; z: number }[], preserveCurrentStep: boolean = false): void {
    if (path.length === 0) return;
    if (this.isControlledMoveActive()) return;
    this.followTargetPlayerId = -1;
    if (!this.network.sendMove(path)) return;
    this.startLocalPredictedPath(path, preserveCurrentStep, true);
  }

  private startLocalPredictedPath(
    path: { x: number; z: number }[],
    preserveCurrentStep: boolean = false,
    allowAuthorityReanchor: boolean = false,
  ): void {
    if (path.length === 0) return;
    const activeStep = this.getActiveUnitStep();
    this.localPlayer?.clearFaceLock(true);
    if (this.localPlayer?.isSkillAnimPlaying()) this.localPlayer.resetTransientAnimation();
    this.path = path;
    this.pathIndex = 0;
    this.localCombatWalkUntilMs = 0;
    this.predictedPathStartedAt = performance.now();
    const dest = path[path.length - 1];
    this.predictedPathDestination = allowAuthorityReanchor && dest ? { x: dest.x, z: dest.z } : null;
    this.predictedPathAuthorityReanchorAttempts = 0;
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
    if (!this.localPlayer?.isWalking()) this.localPlayer?.startWalking();
  }

  private tryReanchorPredictedPathToAuthority(serverX: number, serverZ: number): boolean {
    const dest = this.predictedPathDestination;
    if (!dest) return false;
    if (this.pathIndex >= this.path.length) return false;
    if (this.predictedPathAuthorityReanchorAttempts >= GameManager.AUTHORITY_REANCHOR_MAX_ATTEMPTS) return false;

    const path = findPath(
      serverX,
      serverZ,
      dest.x,
      dest.z,
      this.isTileBlocked,
      this.chunkManager.getMapWidth(),
      this.chunkManager.getMapHeight(),
      GameManager.AUTHORITY_REANCHOR_MAX_SEARCH_TILES,
      this.isWallBlockedForPath,
    );
    if (!this.pathReachesGoal(path, dest.x, dest.z)) return false;

    const prevLogicalX = this.playerX;
    const prevLogicalZ = this.playerZ;
    this.playerX = serverX;
    this.playerZ = serverZ;
    this.path = path;
    this.pathIndex = 0;
    this.tileProgress = 0;
    this.pendingPath = null;
    this.setTileFrom(serverX, serverZ);
    this.predictedPathStartedAt = 0;
    this.predictedPathAuthorityReanchorAttempts++;

    const dragDist = Math.hypot(prevLogicalX - serverX, prevLogicalZ - serverZ);
    const slideMs = Math.min(
      Math.max((dragDist / Math.max(this.moveSpeed, 0.1)) * 1000 * 1.25, TICK_RATE),
      2400,
    );
    this.beginVisualSlide(prevLogicalX, prevLogicalZ, slideMs);
    if (!this.localPlayer?.isWalking()) this.localPlayer?.startWalking();
    return true;
  }

  private usesCornerObjectInteraction(def: WorldObjectDef, hasInteractionMask: boolean = false): boolean {
    return usesCornerInteractionTiles(def, hasInteractionMask);
  }

  private objectInteractionTileOptions(
    data: { interactionSides?: number; rotY?: number },
    def: WorldObjectDef,
  ): { allowedWorldSides?: number; rotationY: number; includeCorners: boolean } {
    const allowedWorldSides = data.interactionSides
      ? localSidesToWorldSides(data.interactionSides, data.rotY ?? 0, def)
      : undefined;
    return {
      allowedWorldSides,
      rotationY: data.rotY ?? 0,
      includeCorners: this.usesCornerObjectInteraction(def, !!allowedWorldSides),
    };
  }

  private objectInteractionTiles(
    data: { x: number; z: number; interactionSides?: number; rotY?: number; interactionTiles?: { x: number; z: number }[] },
    def: WorldObjectDef,
  ): { x: number; z: number }[] {
    if (data.interactionTiles?.length) return data.interactionTiles;
    return getObjectInteractionTiles(data.x, data.z, def, this.objectInteractionTileOptions(data, def));
  }

  private requiresClearObjectInteractionEdge(def: WorldObjectDef): boolean {
    return def.category === 'chest'
      || def.category === 'cookingrange'
      || def.id === FIRE_OBJECT_DEF_ID
      || def.id === POTTERY_WHEEL_OBJECT_DEF_ID
      || def.id === KILN_OBJECT_DEF_ID;
  }

  private hasClearObjectInteractionEdge(
    data: { x: number; z: number; rotY?: number },
    def: WorldObjectDef,
    tileX: number,
    tileZ: number,
    allowAuthoredNonAdjacentTile: boolean = false,
  ): boolean {
    if (!this.requiresClearObjectInteractionEdge(def)) return true;
    let hasAdjacentFootprintTile = false;
    for (const footprintTile of getObjectFootprintTiles(data.x, data.z, def, data.rotY ?? 0)) {
      if (Math.abs(footprintTile.x - tileX) + Math.abs(footprintTile.z - tileZ) !== 1) continue;
      hasAdjacentFootprintTile = true;
      if (!this.isWallBlockedForPath(tileX, tileZ, footprintTile.x, footprintTile.z)) return true;
    }
    if (!hasAdjacentFootprintTile && allowAuthoredNonAdjacentTile) return true;
    return false;
  }

  private isOnObjectInteractionTile(
    ptx: number,
    ptz: number,
    data: { x: number; z: number; interactionSides?: number; rotY?: number; interactionTiles?: { x: number; z: number }[] },
    def: WorldObjectDef,
  ): boolean {
    const adjacent = data.interactionTiles?.length
      ? data.interactionTiles.some(tile => tile.x === ptx && tile.z === ptz)
      : isTileAdjacentToObject(ptx, ptz, data.x, data.z, def, this.objectInteractionTileOptions(data, def));
    return adjacent && this.hasClearObjectInteractionEdge(data, def, ptx, ptz, !!data.interactionTiles?.length);
  }

  /** Find the closest reachable adjacent tile of an object and start the
   *  predicted walk toward it. Returns true if a walk was started, false
   *  if no reachable adjacent tile exists. */
  private walkToAdjacentTileOf(data: { x: number; z: number; interactionSides?: number; rotY?: number; interactionTiles?: { x: number; z: number }[] }, def: WorldObjectDef): boolean {
    const hasAuthoredTiles = !!data.interactionTiles?.length;
    const start = this.getActiveUnitStep()?.from ?? { x: this.playerX, z: this.playerZ };
    const candidates = this.objectInteractionTiles(data, def)
      .filter(tile => !this.isTileBlocked(tile.x, tile.z))
      .filter(tile => this.hasClearObjectInteractionEdge(data, def, tile.x, tile.z, hasAuthoredTiles))
      .map(tile => ({
        ax: tile.x,
        az: tile.z,
        dist: Math.hypot(this.playerX - (tile.x + 0.5), this.playerZ - (tile.z + 0.5)),
      }));

    let best: { path: { x: number; z: number }[]; preserveCurrentStep: boolean; steps: number; dist: number } | null = null;
    for (const { ax, az, dist } of candidates) {
      const { path, preserveCurrentStep } = this.findPathFromMovementAnchor(ax + 0.5, az + 0.5, 500);
      if (this.pathReachesGoal(path, ax + 0.5, az + 0.5)) {
        const steps = compressedPathTileSteps(start, path);
        if (!best || steps < best.steps || (steps === best.steps && dist < best.dist)) {
          best = { path, preserveCurrentStep, steps, dist };
        }
      }
    }
    if (best) {
      this.startPredictedPath(best.path, best.preserveCurrentStep);
      return true;
    }
    return false;
  }

  private pickupItem(groundItemId: number): void {
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    const item = this.entities.groundItems.get(groundItemId);
    if (item) {
      if (item.floor !== this.currentFloor) return;
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
    if (!this.isWorldObjectOnCurrentInteractionFloor(data, def)) return;
    // Doors can always be clicked (open/close toggle). Other objects can't when depleted.
    if (!this.isWorldObjectInteractable(def, data.depleted)) return;
    if (this.tryUseInventoryItemOn('object', objectEntityId)) return;
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');
    // Auto-interact with harvestable objects (trees, rocks), doors, ladders,
    // and crafting stations (furnace, anvil, range).
    if (isHarvestObjectDef(def) || def.category === 'crop' || def.category === 'door' || def.category === 'ladder' || def.category === 'bank' || (def.recipes && def.recipes.length > 0)) {
      const actionIndex = def.category === 'ladder'
        ? this.primaryLadderActionIndex(def, data)
        : 0;
      if (def.category === 'ladder' && actionIndex < 0) {
        this.handleGroundClick(data.x, data.z);
        return;
      }

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
        if (this.isOnObjectInteractionTile(ptx, ptz, data, def)) {
          this.faceLocalPlayerToward(data.x, data.z);
        } else {
          // Server owns deferred object execution; no local arrival cache.
        }
      }

      if (actionIndex >= 0) this.interactObject(objectEntityId, actionIndex);
    }
  }

  private showSmithingUI(objectEntityId: number, def: WorldObjectDef): void {
    if (!this.smithingPanel || !this.sidePanel) return;
    const inventory = this.sidePanel.getInventory();
    const stationSkill = recipePanelSkillFor(def);
    const skillLevel = this.sidePanel.getSkillLevel(stationSkill);
    const itemDefs = this.sidePanel.getItemDefs();
    // requiresTool comes from the first recipe; furnaces have no tool req,
    // anvils have 'hammer'. hasTool is moot when requiresTool is undefined,
    // so default to true to skip the cosmetic hammer warning in that case.
    const toolType = def.recipes?.[0]?.requiresTool;
    const requiresTool = !!toolType;
    const hasTool = !requiresTool
      || inventory.some((slot: InventorySlot | null) => slot && itemDefs.get(slot.itemId)?.toolType === toolType);
    // Vocabulary differs per station: anvils smith bars into weapons, furnaces
    // smelt ore into bars. Title + empty-state + back-button copy all read off
    // these strings.
    // WorldObjectDef.name is always populated; `?? 'Smithing'` only guards
    // against future shapes where it might be optional. inputNoun shapes the
    // back-button + empty-state copy in SmithingPanel.
    const stationLabel = def.name ?? 'Smithing';
    const inputNoun = recipePanelInputNounFor(def);
    const supportsBatch = supportsBatchObjectRecipe(def);
    const usesInlineQuantities = isCookingStationDef(def)
      || def.id === SPINNING_WHEEL_OBJECT_DEF_ID;
    const actionVerb = def.id === SPINNING_WHEEL_OBJECT_DEF_ID
      ? 'Spin'
      : usesInlineQuantities ? 'Cook' : 'Make';

    this.smithingPanel.show(def.recipes ?? [], inventory, skillLevel, hasTool, itemDefs, (recipeIndex, quantity = 1) => {
      const recipe = def.recipes?.[recipeIndex];
      const maxQuantity = recipe ? this.maxObjectRecipeQuantity(recipe, inventory) : 0;
      if (usesInlineQuantities && supportsBatch && recipe) {
        if (maxQuantity <= 0) return;
        const data = this.worldObjectDefs.get(objectEntityId);
        if (data) {
          const ptx = Math.floor(this.playerX);
          const ptz = Math.floor(this.playerZ);
          if (!this.isOnObjectInteractionTile(ptx, ptz, data, def)) {
            this.walkToAdjacentTileOf(data, def);
            return;
          }
          if (!this.stopLocalWalkForImmediateObjectInteraction(data, def)) return;
        }
        const requested = quantity < 0 ? -1 : Math.max(1, Math.min(quantity, maxQuantity));
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, 0, recipeIndex, 0, requested));
        return;
      }
      if (supportsBatch && recipe && maxQuantity > 1 && this.quantityInputPanel) {
        const inputName = itemDefs.get(recipe.inputItemId)?.name ?? 'item';
        const outputName = itemDefs.get(recipe.outputItemId)?.name ?? 'item';
        const outputQuantityPerAction = Math.max(1, Math.floor(recipe.outputQuantity ?? 1));
        const maxOutputQuantity = maxQuantity * outputQuantityPerAction;
        this.quantityInputPanel.show({
          title: `Make ${outputName}`,
          prompt: outputQuantityPerAction > 1
            ? `Use how many ${inputName}?`
            : `Make how many ${outputName}?`,
          details: outputQuantityPerAction > 1
            ? [
                `Produces ${outputQuantityPerAction} ${outputName.toLowerCase()} each.`,
                `You can make ${maxOutputQuantity} ${outputName.toLowerCase()}.`,
              ]
            : undefined,
          max: maxQuantity,
          defaultValue: maxQuantity,
          submitLabel: 'Make',
          onSubmit: (quantity) => {
            const currentMax = this.maxObjectRecipeQuantity(recipe, this.sidePanel?.getInventory() ?? []);
            if (currentMax <= 0) return;
            const requested = quantity >= currentMax ? -1 : Math.max(1, Math.min(quantity, currentMax));
            this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, 0, recipeIndex, 0, requested));
          },
        });
        return;
      }

      // Walk to the station and send the crafting request with the specific recipe index.
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, 0, recipeIndex));
    }, {
      stationLabel,
      inputNoun,
      requiresTool,
      layout: usesInlineQuantities ? 'flat' : 'grouped',
      actionVerb,
      actionButtons: usesInlineQuantities
        ? [
            { label: '1', value: 1 },
            { label: '5', value: 5 },
            { label: '10', value: 10 },
            { label: 'All', value: 'all' },
          ]
        : undefined,
      primaryRecipePerInput: isCookingStationDef(def),
    });
  }

  private maxObjectRecipeQuantity(
    recipe: NonNullable<WorldObjectDef['recipes']>[number],
    inventory: (InventorySlot | null)[],
  ): number {
    const itemCounts = new Map<number, number>();
    for (const slot of inventory) {
      if (slot) itemCounts.set(slot.itemId, (itemCounts.get(slot.itemId) ?? 0) + slot.quantity);
    }

    const primary = Math.floor((itemCounts.get(recipe.inputItemId) ?? 0) / Math.max(1, recipe.inputQuantity));
    if (recipe.secondInputItemId === undefined) return primary;
    const secondary = Math.floor(
      (itemCounts.get(recipe.secondInputItemId) ?? 0) / Math.max(1, recipe.secondInputQuantity ?? 1),
    );
    return Math.min(primary, secondary);
  }

  private interactObject(objectEntityId: number, actionIndex: number): void {
    if (this.isControlledMoveActive()) return;
    this.combatTargetId = -1;
    this.magicTargetId = -1;
    this.pendingSingleCastSpell = -1;
    const data = this.worldObjectDefs.get(objectEntityId);
    if (!data) return;
    const def = this.objectDefsCache.get(data.defId);
    if (!this.isWorldObjectOnCurrentInteractionFloor(data, def)) return;
    if (!def || !this.isWorldObjectInteractable(def, data.depleted)) return;
    if (this.tryUseInventoryItemOn('object', objectEntityId)) return;
    this.spawnCursorClickEffect(this.lastClickX, this.lastClickY, '#ff3030');

    const actionName = this.actionsForInstance(def, data.depleted, data, this.worldObjectInteractionActions(objectEntityId))[actionIndex];
    if (actionName === 'Examine') {
      const ptx = Math.floor(this.playerX);
      const ptz = Math.floor(this.playerZ);
      if (this.isOnObjectInteractionTile(ptx, ptz, data, def)) {
        if (!this.stopLocalWalkForImmediateObjectInteraction(data, def)) return;
      }
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, actionIndex));
      return;
    }

    // Smithing/crafting pickers are opened by the server after adjacency
    // validation. The client only predicts the walk for responsiveness.
    const objData = this.worldObjectDefs.get(objectEntityId);
    if (objData) {
      const objDef = this.objectDefsCache.get(objData.defId);
      if (objDef?.recipes && objDef.recipes.length > 0 && objDef.recipes[0].requiresTool) {
        const ptx = Math.floor(this.playerX);
        const ptz = Math.floor(this.playerZ);
        const alreadyAdj = this.isOnObjectInteractionTile(ptx, ptz, objData, objDef);
        if (!alreadyAdj) this.walkToAdjacentTileOf(objData, objDef);
        else if (!this.stopLocalWalkForImmediateObjectInteraction(objData, objDef)) return;
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, actionIndex));
        return;
      }
    }

    // Cancel current skilling if clicking a different object
    if (this.isSkilling && this.skillingObjectId !== objectEntityId) {
      this.isSkilling = false;
      this.skillingObjectId = -1;
      this.localPlayer?.stopSkillAnimation();
    }

    const dx = data.x - this.playerX;
    const dz = data.z - this.playerZ;
    const dist = Math.hypot(dx, dz);

    // Find a reachable adjacent tile and walk there
    if (def?.category === 'door') {
      const doorEntry = this.doorPivots.get(objectEntityId);
      const rotY = doorEntry ? doorEntry.closedRotY : 0;
      const { tile: [dotx, dotz], edge } = doorEdgeFromPlacement(data.x, data.z, rotY);
      const ptx = Math.floor(this.playerX);
      const ptz = Math.floor(this.playerZ);
      const alreadyAdj = (ptx === dotx && ptz === dotz) || (Math.abs(ptx - dotx) + Math.abs(ptz - dotz) === 1);
      let shouldSendInteraction = true;

      if (!alreadyAdj || this.pathIndex < this.path.length) {
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
        } else if (alreadyAdj) {
          shouldSendInteraction = this.pathIndex >= this.path.length;
        }
      } else {
        this.clearPredictedPath();
        this.localPlayer?.stopWalking();
      }
      if (!shouldSendInteraction) return;
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, actionIndex, -1, data.depleted ? 1 : 0));
      return;
    }

    // Furnace: path to authored interaction tiles when present. This lets large
    // stations force a specific use tile instead of accepting any adjacent tile.
    if (def?.category === 'furnace') {
      const ptx = Math.floor(this.playerX);
      const ptz = Math.floor(this.playerZ);
      const alreadyAtUseTile = this.isOnObjectInteractionTile(ptx, ptz, data, def);
      if (!alreadyAtUseTile) this.walkToAdjacentTileOf(data, def);
      else if (this.pathIndex < this.path.length && !this.stopLocalWalkForImmediateObjectInteraction(data, def)) return;
      // Multi-recipe furnaces (bronze, iron±coal, steel, black bronze/mithril, ...) used
      // to auto-pick the first matching recipe — which meant steel was
      // unreachable while carrying iron ore + coal because iron+coal matches
      // first. Now we open the SmithingPanel for any furnace with > 1 recipe
      // so the player can pick. Single-recipe furnaces (if any future ones
      // exist) keep the auto-fire path.
      const recipes = def.recipes ?? [];
      if (recipes.length > 1) {
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, actionIndex));
        return;
      }
      this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, actionIndex));
      return;
    }

    // Check if already on a valid adjacent tile
    const ptx = Math.floor(this.playerX);
    const ptz = Math.floor(this.playerZ);
    const alreadyAdj = def ? this.isOnObjectInteractionTile(ptx, ptz, data, def) : dist <= 1.5;

    if (!alreadyAdj && def) {
      this.walkToAdjacentTileOf(data, def);
    } else if (!alreadyAdj) {
      // Let the server reject unreachable stale/malformed object packets.
    } else {
      if (!this.stopLocalWalkForImmediateObjectInteraction(data, def)) return;
    }

    // Send interaction request — server validates distance
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, objectEntityId, actionIndex));
  }

  private resolveRotateDebugItem(query: string): ItemDef | null {
    const trimmed = query.trim();
    if (!trimmed) return this.itemDefsCache.get(BANK_NOTE_TEMPLATE_ITEM_ID) ?? null;

    const numericId = Number(trimmed);
    if (Number.isInteger(numericId)) return this.itemDefsCache.get(numericId) ?? null;

    const needle = trimmed.toLowerCase();
    for (const def of this.itemDefsCache.values()) {
      if (def.name.toLowerCase() === needle) return def;
    }
    for (const def of this.itemDefsCache.values()) {
      if (def.name.toLowerCase().includes(needle)) return def;
    }
    return null;
  }

  private async handleRotateDebugCommand(msg: string): Promise<void> {
    if (!this.isAdmin) {
      this.chatPanel?.addSystemMessage('/rotatedebug is admin only.');
      return;
    }

    const query = msg.replace(/^\/rotatedebug\b/i, '').trim();
    const def = this.resolveRotateDebugItem(query);
    if (!def) {
      this.chatPanel?.addSystemMessage('Usage: /rotatedebug [item id or name]. Default edits the bank note.');
      return;
    }

    const modelPath = resolveItemModelPath(def);
    if (!modelPath) {
      this.chatPanel?.addSystemMessage(`${def.name} has no 3D model thumbnail to rotate.`);
      return;
    }

    if (!this.rotateDebugPanel) {
      this.rotateDebugPanel = new RotateDebugPanel();
      this.rotateDebugPanel.setAuthTokenGetter(() => this.token || localStorage.getItem('evilquest_token') || '');
      this.rotateDebugPanel.setMessageCallback((message) => this.chatPanel?.addSystemMessage(message));
    }
    await this.rotateDebugPanel.show({ def, modelPath });
    this.chatPanel?.addSystemMessage(`Rotate debug: ${def.name} (${def.id}).`);
  }

  private handleChatCommand(msg: string): boolean {
    const trimmed = msg.trim();
    const lower = trimmed.toLowerCase();

    if (lower === '/fps') {
      this.toggleFpsCounter();
      return true;
    }

    if (lower === '/perf') {
      void this.handlePerfCommand();
      return true;
    }

    if (lower === '/quality' || lower.startsWith('/quality ')) {
      this.handleQualityCommand(trimmed);
      return true;
    }

    if (msg === '/spellbook') {
      this.toggleSpellbook();
      return true;
    }

    if (lower.startsWith('/rotatedebug')) {
      void this.handleRotateDebugCommand(trimmed);
      return true;
    }

    if (import.meta.env.DEV) {
      if (msg === '/deathfx') {
        this.playDeathPortalDebugPreview();
        return true;
      }
      if (msg === '/hitsplat' || msg === '/hitsplats') {
        this.playHitSplatDebugPreview();
        return true;
      }
      if (msg === '/geardebug' || msg === '/geardebug player' || msg === '/geardebug npc') {
        this.gearDebugTargetMode = msg === '/geardebug npc' ? 'npc' : 'player';
        if (this.gearDebugTargetMode === 'npc') {
          const target = this.getNearestHumanoidNpcEntryForGearDebug();
          if (!target) {
            this.gearDebugNpcTargetId = -1;
            this.chatPanel?.addSystemMessage('No loaded humanoid NPC nearby for /geardebug npc.');
            return true;
          }
          this.gearDebugNpcTargetId = target.entityId;
        } else {
          this.gearDebugNpcTargetId = -1;
        }
        if (!this.gearDebugPanel) {
          this.gearDebugPanel = new GearDebugPanel();
          this.gearDebugPanel.setSlotGetter((slot) => this.getGearDebugCharacter()?.getGearNode?.(slot) ?? null);
          this.gearDebugPanel.setSlotBoneGetter((slot) => EQUIP_SLOT_BONES[slot]?.boneName ?? '');
          this.gearDebugPanel.setItemInfoGetter((slot) => {
            const itemId = this.getGearDebugCharacter()?.getGearItemId(slot) ?? -1;
            if (itemId < 0) return null;
            const def = this.itemDefsCache.get(itemId);
            return {
              id: itemId,
              name: def?.name ?? `item ${itemId}`,
              toolType: def?.toolType,
              modelPath: this.getGearModelFileForCharacter(itemId, slot, this.getGearDebugCharacter()) ?? undefined,
              headRenderMode: def?.headRenderMode,
            };
          });
          this.gearDebugPanel.setOverrideGetter((itemId) => this.getGearOverrideForCharacter(itemId, this.getGearDebugCharacter()));
          this.gearDebugPanel.setSkinnedChecker((slot) => this.getGearDebugCharacter()?.getSkinnedArmorMeshes?.(slot) != null);
          this.gearDebugPanel.setAuthTokenGetter(() => this.token || localStorage.getItem('evilquest_token') || '');
          this.gearDebugPanel.setBodyTypeGetter(() => this.getCharacterBodyType(this.getGearDebugCharacter()));
          this.gearDebugPanel.setHeadHairPreviewCallback((fit) => {
            this.getGearDebugCharacter()?.setHeadHairFitForCurrentHead(fit);
          });
          this.gearDebugPanel.setSaveCallback(async (itemId, override) => {
            const target = this.getGearDebugCharacter();
            const bodyType = this.getCharacterBodyType(target);
            const changedItemIds = new Set<number>([itemId]);
            this.gearOverrides.set(itemId, mergeGearOverrideForBodyType(this.gearOverrides.get(itemId), bodyType, override));
            const slotName = EQUIP_SLOT_NAMES.find(s => target?.getGearItemId(s) === itemId);
            const sourceDef = this.itemDefsCache.get(itemId);
            if (slotName && sourceDef?.toolType) {
              const toolPose = {
                boneName: override.boneName,
                localPosition: override.localPosition,
                localRotation: override.localRotation,
                scale: override.scale,
                centerOrigin: override.centerOrigin,
              };
              for (const def of this.itemDefsCache.values()) {
                if (def.id === itemId) continue;
                if (def.equipSlot !== slotName || def.toolType !== sourceDef.toolType) continue;
                if (!this.getGearModelFileForCharacter(def.id, slotName, target)) continue;
                this.gearOverrides.set(def.id, mergeGearOverrideForBodyType(this.gearOverrides.get(def.id), bodyType, toolPose));
                this.deleteGearTemplateCacheForItem(slotName, def.id);
                changedItemIds.add(def.id);
              }
            }
            await this.saveGearOverridesToServer();
            if (slotName) this.deleteGearTemplateCacheForItem(slotName, itemId);
            for (const changedItemId of changedItemIds) {
              this.refreshEquippedGearOverride(changedItemId);
            }
          });
          this.gearDebugPanel.setBulkSaveCallback(async (sourceItemId, slot, override) => {
            const target = this.getGearDebugCharacter();
            const bodyType = this.getCharacterBodyType(target);
            const sourceDef = this.itemDefsCache.get(sourceItemId);
            const sourceFamily = gearFitFamilyForName(sourceDef?.name);
            const targets = [...this.itemDefsCache.values()]
              .filter((def) => (
                def.equipSlot === slot
                && (!sourceFamily || gearFitFamilyForName(def.name) === sourceFamily)
                && this.getGearModelFileForCharacter(def.id, slot, target)
              ));
            if (!targets.some((def) => def.id === sourceItemId)) {
              if (sourceDef?.equipSlot === slot) targets.push(sourceDef);
            }

            for (const def of targets) {
              const patch: GearOverride = {
                boneName: override.boneName,
                localPosition: override.localPosition,
                localRotation: override.localRotation,
                scale: override.scale,
              };
              if (slot === 'head' && override.headHair) patch.headHair = override.headHair;
              this.gearOverrides.set(def.id, mergeGearOverrideForBodyType(this.gearOverrides.get(def.id), bodyType, patch));
              this.deleteGearTemplateCacheForItem(slot, def.id);
            }

            await this.saveGearOverridesToServer();
            for (const def of targets) {
              this.refreshEquippedGearOverride(def.id);
            }
            return targets.length;
          });
          this.gearDebugPanel.setLoadGlbCallback(async (slot, path, itemId) => {
            const target = this.getGearDebugCharacter();
            if (!target) throw new Error(this.gearDebugTargetMode === 'npc' ? 'No humanoid NPC target' : 'No local player');
            const boneConfig = EQUIP_SLOT_BONES[slot];
            if (!boneConfig) throw new Error('Unknown slot: ' + slot);

            const def = itemId != null && itemId > 0 ? this.itemDefsCache.get(itemId) : null;
            if (def?.equipSlot === slot) {
              await this.applyGearToCharacter(target, slot, itemId!, false);
              return;
            }

            const lastSlash = path.lastIndexOf('/');
            const dir = path.substring(0, lastSlash + 1);
            const file = devCacheBustGearFile(path.substring(lastSlash + 1));
            const result = await SceneLoader.ImportMeshAsync('', dir, file, this.scene);
            const hasSkeleton = result.skeletons.length > 0;

            if (hasSkeleton) {
              target.detachGear(slot);

              target.attachSkinnedArmor(slot, result.meshes, result.skeletons[0]);
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
              target.attachGear(slot, -999, tmpl);
            }
          });
          this.gearDebugPanel.setUnequipCallback((slot) => {
            const target = this.getGearDebugCharacter();
            if (!target) return;
            target.detachGear(slot);
            target.detachSkinnedArmor(slot);
          });
          this.gearDebugPanel.setAnimCallback((anim) => {
            const target = this.getGearDebugCharacter();
            if (!target) return;
            if (anim === 'idle') {
              target.stopWalking();
              target.stopSkillAnimation();
            } else if (anim === 'walk') {
              target.startWalking();
            } else if (anim === 'attack') {
              target.playAttackAnimation();
            } else if (anim === 'chop') {
              target.startSkillAnimation('chop');
            } else if (anim === 'mine') {
              target.startSkillAnimation('mine');
            }
          });
        }
        this.gearDebugPanel.toggle();
        if (this.gearDebugPanel.isVisible) {
          this.camera.enterDebugZoom();
          this.chatPanel?.addSystemMessage(`Gear debug target: ${this.gearDebugTargetMode === 'npc' ? 'nearest humanoid NPC' : 'player'}.`);
        } else {
          this.camera.exitDebugZoom();
        }
        return true;
      }
      if (msg === '/copygearfitnpc') {
        this.copyLocalGearFitToNearestNpc();
        return true;
      }
      if (msg === '/copyplayergeartonpc') {
        void this.copyLocalGearToNearestNpc();
        return true;
      }
      if (msg === '/scenebudget') {
        logSceneBudget(this.scene);
        this.chatPanel?.addMessage('System', 'Scene budget written to the browser console.');
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
        // The server must open the editor so SET_APPEARANCE is accepted.
        return false;
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
      // /spell and /cast require a space (or exact match) for the same reason —
      // a bare `startsWith('/spell')` swallows any /spell* command.
      if (msg === '/spell' || msg === '/spell ?' || msg.startsWith('/spell ')) {
        this.runSpellCommand(msg.slice(6).trim());
        return true;
      }
      if (msg === '/cast' || msg === '/cast ?' || msg.startsWith('/cast ')) {
        this.runCastCommand(msg.slice(5).trim());
        return true;
      }
    }
    return false;
  }

  private playLocalPlayerDeathEffect(): void {
    if (!this.localPlayer) return;
    const foot = this.localPlayer.position.clone();
    this.spawnDeathPortalCharacterPreview(foot, {
      faceX: this.playerX,
      faceZ: this.playerZ,
    });
  }

  private playDeathPortalDebugPreview(): void {
    if (!this.localPlayer) {
      this.chatPanel?.addSystemMessage('No local player yet.');
      return;
    }

    const x = this.playerX + 1.25;
    const z = this.playerZ;
    const y = this.getHeightAtFloor(x, z, this.currentFloor, this.localPlayer.position.y);
    this.spawnDeathPortalCharacterPreview(new Vector3(x, y, z), {
      label: 'Death FX',
      labelColor: '#9eeaff',
      faceX: this.playerX,
      faceZ: this.playerZ,
      systemMessage: 'Death portal preview spawned.',
    });
  }

  private spawnDeathPortalCharacterPreview(
    foot: Vector3,
    opts: {
      label?: string;
      labelColor?: string;
      faceX?: number;
      faceZ?: number;
      systemMessage?: string;
    } = {},
  ): void {
    const preview = new CharacterEntity(this.scene, {
      name: `deathfx_preview_${Date.now()}`,
      modelPath: getCharacterModelPath(this.localAppearance),
      targetHeight: CHARACTER_TARGET_HEIGHT,
      label: opts.label,
      labelColor: opts.labelColor,
      additionalAnimations: [
        { name: 'idle', path: `${CHARACTER_ANIM_DIR}/idle.glb` },
      ],
    });
    preview.setPositionXYZ(foot.x, foot.y, foot.z);
    if (opts.faceX !== undefined && opts.faceZ !== undefined) {
      preview.lockFaceTowardXZ(opts.faceX, opts.faceZ);
    }
    if (opts.systemMessage) this.chatPanel?.addSystemMessage(opts.systemMessage);

    void preview.whenReady().then(() => {
      if (this.destroyed) {
        preview.dispose();
        return;
      }
      if (this.localAppearance) preview.applyAppearance(this.localAppearance);
      DeathPortalEffect.play(this.scene, preview, { onDone: () => preview.dispose() });
    });
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
    if (nearest && this.entities.npcTargets.get(nearest.entityId)?.floor !== this.currentFloor) return;
    if (!nearest) {
      this.chatPanel?.addSystemMessage(`${def.name}: no target in sight.`);
      return;
    }
    if (this.isNonCombatNpc(nearest.entityId)) {
      this.chatPanel?.addSystemMessage(`${def.name}: no attackable target in sight.`);
      return;
    }
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_CAST_SPELL, spellIndex, nearest.entityId));
  }

  private openCharacterCreatorWhenReady(canCancel: boolean = false): void {
    this.characterCreatorCanCancel = canCancel;
    if (this.characterCreator || this.characterCreatorOpenPending) return;
    if (!this.localPlayer) {
      this.characterCreatorOpenPending = true;
      requestAnimationFrame(() => {
        this.characterCreatorOpenPending = false;
        this.openCharacterCreatorWhenReady(this.characterCreatorCanCancel);
      });
      return;
    }
    this.characterCreatorOpenPending = true;
    void this.localPlayer.whenReady().then(() => {
      this.characterCreatorOpenPending = false;
      if (!this.characterCreator) this.openCharacterCreator(this.characterCreatorCanCancel);
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

  private getNearestHumanoidNpcForGearDebug(): CharacterEntity | null {
    return this.getNearestHumanoidNpcEntryForGearDebug()?.npc ?? null;
  }

  private getNearestHumanoidNpcEntryForGearDebug(): { entityId: number; npc: CharacterEntity } | null {
    if (!this.localPlayer) return null;
    let best: CharacterEntity | null = null;
    let bestId = -1;
    let bestDist = Infinity;
    for (const [entityId, sprite] of this.entities.npcSprites) {
      if (!(sprite instanceof CharacterEntity)) continue;
      const dist = Vector3.DistanceSquared(this.localPlayer.position, sprite.position);
      if (dist < bestDist) {
        bestDist = dist;
        bestId = entityId;
        best = sprite;
      }
    }
    return best ? { entityId: bestId, npc: best } : null;
  }

  private getGearDebugCharacter(): CharacterEntity | null {
    if (this.gearDebugTargetMode !== 'npc') return this.localPlayer;
    const cached = this.entities.npcSprites.get(this.gearDebugNpcTargetId);
    if (cached instanceof CharacterEntity) return cached;
    const nearest = this.getNearestHumanoidNpcEntryForGearDebug();
    this.gearDebugNpcTargetId = nearest?.entityId ?? -1;
    return nearest?.npc ?? null;
  }

  private copyLocalGearFitToNearestNpc(): void {
    if (!this.localPlayer) {
      this.chatPanel?.addSystemMessage('No local player yet.');
      return;
    }
    const npc = this.getNearestHumanoidNpcForGearDebug();
    if (!npc) {
      this.chatPanel?.addSystemMessage('No loaded humanoid NPC nearby.');
      return;
    }

    let copied = 0;
    for (const slot of EQUIP_SLOT_NAMES) {
      const playerItemId = this.localPlayer.getGearItemId(slot);
      const npcItemId = npc.getGearItemId(slot);
      if (playerItemId <= 0 || playerItemId !== npcItemId) continue;

      const source = this.localPlayer.getGearNode(slot);
      const target = npc.getGearNode(slot);
      if (!source || !target) continue;

      target.position.copyFrom(source.position);
      target.rotationQuaternion = null;
      target.rotation.copyFrom(source.rotation);
      target.scaling.copyFrom(source.scaling);
      copied++;
    }

    this.chatPanel?.addSystemMessage(copied > 0
      ? `Copied ${copied} matching player gear fit(s) to nearest humanoid NPC.`
      : 'No matching equipped gear between player and nearest humanoid NPC.');
  }

  private async copyLocalGearToNearestNpc(): Promise<void> {
    if (!this.localPlayer) {
      this.chatPanel?.addSystemMessage('No local player yet.');
      return;
    }
    const target = this.getNearestHumanoidNpcEntryForGearDebug();
    if (!target) {
      this.chatPanel?.addSystemMessage('No loaded humanoid NPC nearby.');
      return;
    }

    const slots = EQUIP_SLOT_NAMES.map((slot) => {
      const itemId = this.localPlayer!.getGearItemId(slot);
      return itemId > 0 ? itemId : 0;
    });
    if (!slots.some(itemId => itemId > 0)) {
      this.chatPanel?.addSystemMessage('Player has no visible gear to copy.');
      return;
    }

    this.entities.npcEquipment.set(target.entityId, slots);
    this.applyRemoteEquipmentArray(target.npc, slots, target.entityId);
    this.chatPanel?.addSystemMessage('Copied player equipment ids to nearest humanoid NPC locally.');

    const copyFit = () => this.copyLocalGearFitToNearestNpc();
    window.setTimeout(copyFit, 400);
    window.setTimeout(copyFit, 1200);
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
    caster.faceToward(target.getTargetAnchor());
    caster.playNamedOneShot('spell_cast_2h', { layerWhenWalking: true });
    if (caster === this.localPlayer) {
      const now = performance.now();
      this.castingUntil = now + def.cast.durationMs;
      this.armSpellMovementLock(now);
      this.rootLocalPlayerForSpellCast(false);
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
      if (nearest && this.entities.npcTargets.get(nearest.entityId)?.floor !== this.currentFloor) return;
      if (!nearest) {
        this.chatPanel?.addSystemMessage('No target — cast failed.');
        return;
      }
      targetId = nearest.entityId;
    }
    if (this.isNonCombatNpc(targetId)) {
      this.chatPanel?.addSystemMessage('That target does not want to fight.');
      return;
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
      const res = await fetch('/api/spells', { headers: this.authHeaders(), credentials: 'same-origin' });
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

  private authHeaders(): HeadersInit | undefined {
    const token = this.token || localStorage.getItem('evilquest_token') || '';
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  }

  private openCharacterCreator(canCancel: boolean = false): void {
    if (this.characterCreator) return;
    // Pass the player's current appearance as the starting state so /appearance
    // re-edits open on the current values rather than the global default.
    // For brand-new characters with no appearance set yet, localAppearance is
    // null and the creator falls back to DEFAULT_APPEARANCE.
    const closeCreator = (): void => {
      const creator = this.characterCreator;
      if (!creator) return;
      creator.destroy();
      this.characterCreator = null;
      this.characterCreatorCanCancel = false;
    };
    this.characterCreator = new CharacterCreator(this.scene, (appearance) => {
      closeCreator();
      this.sendAppearance(appearance);
      this.applyLocalAppearance(appearance);
    }, {
      initial: this.localAppearance ?? undefined,
      onCancel: canCancel ? () => {
        closeCreator();
        this.network.sendRaw(encodePacket(ClientOpcode.APPEARANCE_CLOSE));
      } : undefined,
      // Pass the local player so the creator hides them while open and spawns
      // the preview character at their world position (so the preview canvas
      // shows them in their actual environment instead of on a flat backdrop).
      localPlayer: this.localPlayer,
    });
  }

  private showPlayerChatBubble(fromName: unknown, message: unknown): void {
    if (typeof fromName !== 'string' || typeof message !== 'string') return;
    if (!fromName || typeof this.username !== 'string' || this.username.length === 0) return;

    const normalizedFromName = fromName.toLowerCase();
    const normalizedUsername = this.username.toLowerCase();
    if (normalizedFromName === normalizedUsername) {
      if (this.localPlayer) {
        this.localPlayer.showChatBubble(message);
      }
      return;
    }

    const entityId = this.entities.nameToEntityId.get(normalizedFromName);
    if (entityId !== undefined) {
      const sprite = this.entities.remotePlayers.get(entityId);
      if (sprite) {
        sprite.showChatBubble(message);
      }
    }
  }

  private showNpcDialogueBubble(npcEntityId: number, message: string, alert: boolean = false): void {
    const npc = this.entities.npcSprites.get(npcEntityId);
    if (npc) {
      npc.showChatBubble(message, alert ? 1800 : 6000, 'dialogue');
    }
    if (alert) return;
    const npcName = this.npcDisplayName(npcEntityId, this.entities.npcDefs.get(npcEntityId));
    this.chatPanel?.addMessage(npcName, message, '#f4ded5');
  }

  private hideNpcDialogueBubble(npcEntityId: number): void {
    const npc = this.entities.npcSprites.get(npcEntityId);
    if (npc) {
      npc.hideChatBubble();
    }
  }

  private showLocalDialogueBubble(message: string): void {
    if (this.localPlayer) {
      this.localPlayer.showChatBubble(message, 4500, 'dialogue');
    }
    this.chatPanel?.addMessage(this.username || 'You', message, this.playerNameColor(this.isAdmin, this.isModerator, '#f4ded5'));
  }

  private hitSplatBasePositionFor(target: Targetable): Vector3 {
    const anchor = target.getTargetAnchor();
    return new Vector3(anchor.x, target.position.y, anchor.z);
  }

  private showHitSplat(pos: Vector3, damage: number): void {
    const didDamage = damage > 0;
    const worldPos = new Vector3(
      pos.x + (Math.random() - 0.5) * 0.3,
      pos.y + 1.5,
      pos.z
    );
    const el = document.createElement('div');
    el.style.cssText = `
      position: absolute; pointer-events: none; z-index: 250;
      width: 34px; height: 34px;
      transform: translate(-50%, -50%);
      display: flex; align-items: center; justify-content: center;
      opacity: 0;
      filter: drop-shadow(1px 2px 0 rgba(0, 0, 0, 0.7));
    `;

    const img = document.createElement('img');
    img.src = didDamage ? GameManager.HIT_SPLAT_ASSET_URLS[0] : GameManager.HIT_SPLAT_ASSET_URLS[1];
    img.style.cssText = `
      position: absolute; top: 0; left: 0; width: 100%; height: 100%;
      pointer-events: none;
    `;
    el.appendChild(img);

    const numEl = document.createElement('span');
    numEl.textContent = damage.toString();
    numEl.style.cssText = `
      position: relative; z-index: 1;
      color: ${didDamage ? '#fff1b8' : '#dbe2e8'};
      font-family: Verdana, Arial, Helvetica, sans-serif;
      font-size: ${didDamage && damage >= 10 ? '12px' : '13px'};
      font-weight: 800;
      line-height: 1;
      text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;
    `;
    el.appendChild(numEl);

    mountWorldOverlayElement(el);

    const splat: HitSplatOverlay = {
      worldPos,
      el,
      timer: 1.2,
    };
    this.positionHitSplat(splat);
    this.hitSplats.push(splat);
  }

  private positionHitSplat(splat: HitSplatOverlay): void {
    if (!this.ensureOverlayTransform()) return;
    const cam = this.scene.activeCamera;
    if (!cam) return;
    const sp = this._overlayScreenPos;
    Vector3.ProjectToRef(splat.worldPos, GameManager.IDENTITY, this._overlayTransform, this._overlayVp, sp);
    const fogOpacity = this.overlayFogOpacity(splat.worldPos, cam.position);
    const lifetimeOpacity = splat.timer < 0.3 ? splat.timer / 0.3 : 1;
    const visible = sp.z > 0 && sp.z < 1 && fogOpacity > 0.01;

    splat.el.style.opacity = visible ? (lifetimeOpacity * fogOpacity).toString() : '0';
    splat.el.style.left = visible ? `${sp.x}px` : '-9999px';
    splat.el.style.top = visible ? `${sp.y}px` : '-9999px';
  }

  private queueXpDrop(amount: number): void {
    this.pendingXpDropAmount += amount;
    if (this.pendingXpDropTimer !== null) {
      window.clearTimeout(this.pendingXpDropTimer);
    }
    this.pendingXpDropTimer = window.setTimeout(() => {
      this.pendingXpDropTimer = null;
      this.flushPendingXpDrop();
    }, GameManager.XP_DROP_AGGREGATE_MS);
  }

  private flushPendingXpDrop(): void {
    const amount = this.pendingXpDropAmount;
    this.pendingXpDropAmount = 0;
    if (amount > 0) this.showXpDrop(amount);
  }

  private recentXpDropAverage(): number | null {
    if (this.xpDropRecentAmounts.length === 0) return null;
    let total = 0;
    for (const amount of this.xpDropRecentAmounts) total += amount;
    return total / this.xpDropRecentAmounts.length;
  }

  private rememberXpDropAmount(amount: number): void {
    this.xpDropRecentAmounts.push(amount);
    while (this.xpDropRecentAmounts.length > GameManager.XP_DROP_RECENT_HISTORY_SIZE) {
      this.xpDropRecentAmounts.shift();
    }
  }

  private getXpDropImpact(amount: number): XpDropImpact {
    const recentAverage = this.recentXpDropAverage();
    const relativeLift = recentAverage === null ? 0.45 : (amount - recentAverage) / Math.max(recentAverage, 1);
    const boost = Math.min(Math.max(relativeLift / 1.5, 0), 1);
    return {
      fontSize: 11 + boost,
      lifetime: 1.15 + boost * 0.2,
      riseSpeed: 0.42 + boost * 0.06,
      popScale: 1.1 + boost * 0.14,
      glowStrength: 0.24 + boost * 0.36,
    };
  }

  private showXpDrop(amount: number): void {
    if (!this.localPlayer) return;
    const base = this.localPlayer.position;
    const impact = this.getXpDropImpact(amount);
    this.rememberXpDropAmount(amount);
    const worldPos = new Vector3(
      base.x + (Math.random() - 0.5) * 0.22,
      base.y + 2.35,
      base.z + (Math.random() - 0.5) * 0.14,
    );
    const el = document.createElement('div');
    el.textContent = `+${amount}xp`;
    el.style.cssText = `
      position: absolute; pointer-events: none; z-index: 260;
      transform: translate(-50%, -100%) scale(0.85);
      transform-origin: 50% 100%;
      color: #fff;
      font-family: Verdana, Arial, Helvetica, sans-serif;
      font-size: ${impact.fontSize}px;
      font-weight: 800;
      line-height: 1;
      white-space: nowrap;
      opacity: 0;
      will-change: transform, opacity, text-shadow;
      text-shadow: 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;
    `;
    mountWorldOverlayElement(el);

    const drop: XpDropOverlay = {
      worldPos,
      el,
      timer: impact.lifetime,
      lifetime: impact.lifetime,
      screenOffsetX: (Math.random() - 0.5) * GameManager.XP_DROP_SIDE_SPREAD_PX,
      driftX: (Math.random() - 0.5) * 10,
      riseSpeed: impact.riseSpeed,
      popScale: impact.popScale,
      glowStrength: impact.glowStrength,
    };
    this.positionXpDrop(drop);
    this.xpDrops.push(drop);
  }

  private xpDropScale(progress: number, drop: XpDropOverlay): number {
    const startScale = 0.85;
    if (progress < 0.16) {
      const t = 1 - Math.pow(1 - progress / 0.16, 3);
      return startScale + (drop.popScale - startScale) * t;
    }
    if (progress < 0.36) {
      const t = 1 - Math.pow(1 - (progress - 0.16) / 0.2, 3);
      return drop.popScale + (1 - drop.popScale) * t;
    }
    return 1;
  }

  private positionXpDrop(drop: XpDropOverlay): void {
    if (!this.ensureOverlayTransform()) return;
    const cam = this.scene.activeCamera;
    if (!cam) return;
    const sp = this._overlayScreenPos;
    Vector3.ProjectToRef(drop.worldPos, GameManager.IDENTITY, this._overlayTransform, this._overlayVp, sp);
    const fogOpacity = this.overlayFogOpacity(drop.worldPos, cam.position);
    const progress = 1 - drop.timer / drop.lifetime;
    const fadeIn = Math.min(progress / 0.12, 1);
    const fadeOut = Math.min(drop.timer / 0.32, 1);
    const visible = sp.z > 0 && sp.z < 1 && fogOpacity > 0.01;
    const scale = this.xpDropScale(progress, drop);
    const primaryGlow = Math.max(0, 1 - progress / 0.28) * drop.glowStrength;
    const glow = Math.min(primaryGlow, 1.1);
    const baseShadow = '1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000';

    drop.el.style.opacity = visible ? (fadeIn * fadeOut * fogOpacity).toString() : '0';
    drop.el.style.left = visible ? `${sp.x + drop.screenOffsetX + drop.driftX * progress}px` : '-9999px';
    drop.el.style.top = visible ? `${sp.y}px` : '-9999px';
    drop.el.style.transform = `translate(-50%, -100%) scale(${scale.toFixed(3)})`;
    drop.el.style.textShadow = glow > 0.01
      ? `${baseShadow}, 0 0 ${(3 + glow * 5).toFixed(1)}px rgba(255,255,255,${(0.16 + glow * 0.28).toFixed(2)})`
      : baseShadow;
  }

  private playHitSplatDebugPreview(): void {
    if (!this.localPlayer) {
      this.chatPanel?.addSystemMessage('No local player yet.');
      return;
    }
    const base = this.localPlayer.position;
    this.showHitSplat(new Vector3(base.x - 0.35, base.y, base.z), 7);
    window.setTimeout(() => {
      if (!this.destroyed) this.showHitSplat(new Vector3(base.x + 0.35, base.y, base.z), 0);
    }, 160);
    this.chatPanel?.addSystemMessage('Hit splat preview spawned.');
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
      const key = this.blockedObjectKey(0, x, z);
      return this.chunkManager.isBlocked(x, z) || this.blockedObjectTiles.has(key) || this.isCenteredDoorTileBlockedKey(key);
    }
    const key = this.blockedObjectKey(this.currentFloor, x, z);
    return this.chunkManager.isBlockedOnFloor(x, z, this.currentFloor)
      || this.blockedObjectTiles.has(key)
      || this.isCenteredDoorTileBlockedKey(key);
  };

  private isGroundTileBlocked = (x: number, z: number): boolean => {
    const key = this.blockedObjectKey(0, x, z);
    return this.chunkManager.isBlocked(x, z) || this.blockedObjectTiles.has(key) || this.isCenteredDoorTileBlockedKey(key);
  };

  private isWallBlockedForPath = (fx: number, fz: number, tx: number, tz: number): boolean => {
    if (this.currentFloor !== 0) {
      return this.chunkManager.isWallBlockedOnFloor(fx, fz, tx, tz, this.currentFloor);
    }
    // Pass player height so walls below the player don't block
    const playerY = this.localPlayer?.position.y ?? this.getHeight(this.playerX, this.playerZ);
    return this.chunkManager.isWallBlocked(fx, fz, tx, tz, playerY);
  };

  private isGroundWallBlockedForPath = (fx: number, fz: number, tx: number, tz: number): boolean => {
    const playerY = this.localPlayer?.position.y ?? this.getHeight(this.playerX, this.playerZ);
    return this.chunkManager.isWallBlocked(fx, fz, tx, tz, playerY);
  };

  /** Stop any in-flight path and face the given object. Shared setup for
   *  animated and stationary skilling starts. Do not round/snap the local
   *  player here: the server already delayed non-door object execution until
   *  after arrival, and any remaining visual correction should come through
   *  normal PLAYER_SYNC reconciliation. */
  private prepareSkillingAtObject(objectId: number): void {
    this.clearPredictedPath();
    this.setTileFrom(this.playerX, this.playerZ);
    if (!this.localPlayer) return;
    this.localPlayer.stopWalking();
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
    this.clearControlledMoveLock();
    this.tileProgress = 0;
    this.predictedPathStartedAt = 0;
    this.predictedPathDestination = null;
    this.predictedPathAuthorityReanchorAttempts = 0;
    if (this.destMarker) this.destMarker.isVisible = false;
    this.minimap?.clearDestination();
    if (this.shouldKeepLocalCombatWalkLoopAlive()) {
      this.localCombatWalkUntilMs = performance.now() + TICK_RATE + 150;
    } else {
      this.localCombatWalkUntilMs = 0;
      this.localPlayer?.stopWalking();
    }
    // Face the NPC we were walking up to talk to / attack. Lookup uses
    // npcTargets, which tracks the latest server-broadcast position even if
    // the NPC wandered while we walked.
    if (this.pendingFaceTargetEntityId >= 0) {
      const npcTarget = this.entities.npcTargets.get(this.pendingFaceTargetEntityId);
      if (npcTarget) this.faceLocalPlayerTowardNpc(this.pendingFaceTargetEntityId, npcTarget);
      this.pendingFaceTargetEntityId = -1;
    }
    this.refreshLocalCombatFacing();
  }

  private handleGroundClick(
    worldX: number,
    worldZ: number,
    markerTarget: { worldX: number; worldZ: number } | null = null,
  ): void {
    if (this.duelActive) return;
    if (this.isSpellMovementLocked()) return;
    if (this.isControlledMoveActive()) return;
    if ((this.sidePanel?.getTargetingSpell() ?? -1) >= 0) this.sidePanel!.clearTargetingSpell();
    const tx = Math.floor(worldX), tz = Math.floor(worldZ);
    const clickedOwnTile = tx === Math.floor(this.playerX) && tz === Math.floor(this.playerZ);
    this.clearLocalNpcCombatState();
    // Walking elsewhere cancels the queued face-NPC — we'd look weird
    // turning toward a Shopkeeper after the player has already moved on.
    this.pendingFaceTargetEntityId = -1;
    // Release any face-lock so the body re-aims along the new travel
    // direction rather than continuing to strafe toward the previous target.
    this.localPlayer?.clearFaceLock(true, clickedOwnTile);
    if (this.isSkilling) {
      this.isSkilling = false;
      this.skillingObjectId = -1;
      // Clicking on own tile — delay the cancel so you can't spam restart
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

    // Clicking your own tile while walking should halt on that tile.
    // findPath returns an empty path when start tile == end tile, which the
    // length-check below silently ignored — so the previous walk kept going.
    // Treat the click as a stop: end the path at the current tile center,
    // tell the server to halt too.
    if (clickedOwnTile) {
      this.pendingPath = null;
      this.minimap?.clearDestination();
      if (this.pathIndex < this.path.length) {
        // Keep the current unit progress so interpolation continues seamlessly.
        // Send the same one-tile path to the server so its moveQueue ends
        // on the same tile we're walking to.
        this.keepCurrentPredictedStepForInteraction();
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
      this.minimap?.setDestination(markerTarget?.worldX ?? dest.x, markerTarget?.worldZ ?? dest.z);
    }
  }

  private createHUD(): void {
    this.minimap = new Minimap(260);
    this.minimap.setClickMoveHandler((worldX, worldZ, markerWorldX, markerWorldZ) => {
      this.handleGroundClick(worldX, worldZ, { worldX: markerWorldX, worldZ: markerWorldZ });
    });
    this.minimap.setCompassClickHandler(() => this.camera.rotateNorth());
    this.chunkManager.setOnMinimapDataChanged(() => this.minimap?.invalidateTileCache());
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectSleepTimer !== null) {
      window.clearTimeout(this.reconnectSleepTimer);
      this.reconnectSleepTimer = null;
    }
    this.cancelPendingTouchInteraction();
    this.clearAllPendingHealthApply();
    this.activeTouchPointers.clear();
    this.pinchZoom = null;
    this.mobileControlsEl?.remove();
    this.mobileControlsEl = null;
    this.mobileStatusEl?.remove();
    this.mobileStatusEl = null;
    this.mobileLogoutButton?.remove();
    this.mobileLogoutButton = null;
    this.mobileAdminButton?.remove();
    this.mobileAdminButton = null;
    this.adminPanel?.destroy();
    this.adminPanel = null;
    this.rotateDebugPanel?.destroy();
    this.rotateDebugPanel = null;
    this.mobilePanelButtons = {};
    this.chatPanel?.destroy();
    this.chatPanel = null;
    document.getElementById('game-frame')?.classList.remove('mobile-map-open', 'mobile-panel-open', 'mobile-chat-open', 'mobile-chat-collapsed');
    this.hideReconnectOverlay();
    this.fpsCounterEl?.remove();
    this.fpsCounterEl = null;
    this.network.close();
    if (this.minimap) { this.minimap.dispose(); this.minimap = null; }
    if (this.characterCreator) { this.characterCreator.destroy(); this.characterCreator = null; }
    this.entities?.disposeAllEntities();
    if (this.localPlayer) {
      this.localPlayer.dispose();
      this.localPlayer = null;
    }
    if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }
    if (this.onWindowResize) {
      window.removeEventListener('resize', this.onWindowResize);
      window.removeEventListener('evilquest:viewportchange', this.onWindowResize);
      this.onWindowResize = null;
    }
    this.clearHiddenCatchupTimer();
    if (this._keydownHandler) { window.removeEventListener('keydown', this._keydownHandler); this._keydownHandler = null; }
    if (this._keyupHandler) { window.removeEventListener('keyup', this._keyupHandler); this._keyupHandler = null; }
    if (this._visibilityHandler) { document.removeEventListener('visibilitychange', this._visibilityHandler); this._visibilityHandler = null; }
    if (this.nativeContextMenuBlocker) {
      document.removeEventListener('contextmenu', this.nativeContextMenuBlocker, true);
      this.nativeContextMenuBlocker = null;
    }
    if (this._activityHandler) {
      window.removeEventListener('pointerdown', this._activityHandler, true);
      window.removeEventListener('keydown', this._activityHandler, true);
      window.removeEventListener('touchstart', this._activityHandler, true);
      this._activityHandler = null;
    }
    if (this._cursorTelemetryHandler) {
      window.removeEventListener('pointermove', this._cursorTelemetryHandler, true);
      window.removeEventListener('pointerdown', this._cursorTelemetryHandler, true);
      this._cursorTelemetryHandler = null;
    }
    if (this._npcTooltipHandler) {
      this.engine.getRenderingCanvas()?.removeEventListener('pointermove', this._npcTooltipHandler);
      this._npcTooltipHandler = null;
    }
    if (this._roofHoverLeaveHandler) {
      this.engine.getRenderingCanvas()?.removeEventListener('pointerleave', this._roofHoverLeaveHandler);
      this._roofHoverLeaveHandler = null;
    }
    this.clearHoverRoofPointer();
    this.camera.dispose();
    this.arrowProjectiles.dispose();
    this.skybox.dispose();
    this.engine.stopRenderLoop();
    this.engine.dispose();
    this.chunkManager.disposeAll();
    for (const [, model] of this.worldObjectModels) model.dispose(false, false);
    this.worldObjectModels.clear();
    this.worldObjectIdByNode = new WeakMap();
    this.worldObjectPickState = new WeakMap();
    this.disposeAllCropPickProxyBatches();
    this.disposeWorldObjectPickProxyBatch();
    for (const [, proxy] of this.doorPickProxies) proxy.dispose();
    this.doorPickProxies.clear();
    for (const [, entry] of this.doorPivots) entry.pivot.dispose();
    this.doorPivots.clear();
    this.objectModels.dispose();
    document.getElementById('chat-panel')?.remove();
    document.getElementById('side-panel')?.remove();
    for (const splat of this.hitSplats) splat.el.remove();
    this.hitSplats = [];
    if (this.pendingXpDropTimer !== null) {
      window.clearTimeout(this.pendingXpDropTimer);
      this.pendingXpDropTimer = null;
    }
    this.pendingXpDropAmount = 0;
    for (const drop of this.xpDrops) drop.el.remove();
    this.xpDrops = [];
    this.xpDropRecentAmounts = [];
    this.transientHealthBars.clear();
    document.querySelectorAll('.chat-bubble-overlay').forEach(el => el.remove());
    document.querySelectorAll('.entity-health-bar').forEach(el => el.remove());
    document.querySelectorAll('.character-name-overlay').forEach(el => el.remove());
    document.querySelectorAll('.npc-tooltip-overlay').forEach(el => el.remove());
  }

  private applyCachedNpcRigState(entityId: number, sprite: CharacterEntity | Npc3DEntity): void {
    const apply = () => {
      if (this.entities.npcSprites.get(entityId) !== sprite) return;
      if (sprite instanceof CharacterEntity) {
        const appearance = this.entities.npcAppearances.get(entityId);
        if (appearance) {
          const custom = this.entities.npcCustomColors.get(entityId);
          sprite.applyAppearance(appearance, custom ?? null);
        }
      }
      const eq = this.entities.npcEquipment.get(entityId);
      if (eq) {
        if (sprite instanceof CharacterEntity) this.applyRemoteEquipmentArray(sprite, eq, entityId);
        else this.applyNpcModelEquipmentArray(sprite, eq, entityId);
      }
    };

    if (sprite.isReady) apply();
    else void sprite.whenReady().then(apply);
  }

  private tryMaterializeNpc(entityId: number, npcDefId: number, x: number, z: number, floor: number = 0, y?: number): void {
    if (this.entities.npcSprites.has(entityId)) return;
    const render3D = this.entities.shouldRender3DNpc(entityId, x, z, this.playerX, this.playerZ);
    const npcDef = this.npcDefsCache.get(npcDefId);
    const created = this.entities.createNpc(entityId, npcDefId, x, z, {
      render3D,
      tileSize: npcDef?.size ?? 1,
      floor,
      y,
      stationary: npcDef?.stationary === true,
      visualScale: this.entities.npcVisualScales.get(entityId),
    });
    if ((created instanceof CharacterEntity || created instanceof Npc3DEntity) && floor !== this.currentFloor) {
      created.setRenderEnabled(false);
    }
    if (created instanceof CharacterEntity || created instanceof Npc3DEntity) {
      this.applyCachedNpcRigState(entityId, created);
    }
  }

  private maintainNpcMaterialization(now = performance.now()): void {
    if (now - this.lastNpcMaterializationRetryMs < NPC_MATERIALIZATION_RETRY_MS) return;
    this.lastNpcMaterializationRetryMs = now;

    const dematerializeDistance = NPC_3D_LOD_DISTANCE + NPC_LOD_HYSTERESIS_TILES;
    for (const [entityId, sprite] of this.entities.npcSprites) {
      if (!(sprite instanceof CharacterEntity)) continue;
      const target = this.entities.npcTargets.get(entityId);
      if (!target) continue;
      const dx = target.x - this.playerX;
      const dz = target.z - this.playerZ;
      if (Math.max(Math.abs(dx), Math.abs(dz)) > dematerializeDistance) {
        this.entities.disposeNpcSprite(entityId);
      }
    }

    for (const [entityId, target] of this.entities.npcTargets) {
      if (this.entities.npcSprites.has(entityId)) continue;
      const npcDefId = this.entities.npcDefs.get(entityId);
      if (npcDefId === undefined) continue;
      this.tryMaterializeNpc(entityId, npcDefId, target.x, target.z, target.floor, target.y);
    }
  }

  private getEntityRenderDistanceTiles(): number {
    const metaFogEnd = this.chunkManager.getMeta()?.fogEnd ?? 50;
    const fogEnd = Number.isFinite(this.scene.fogEnd) && this.scene.fogEnd > 0
      ? this.scene.fogEnd
      : metaFogEnd;
    const cameraMaxZ = this.scene.activeCamera?.maxZ ?? Number.POSITIVE_INFINITY;
    const limitingDistance = Math.min(fogEnd, cameraMaxZ);
    const baseDistance = Number.isFinite(limitingDistance) ? limitingDistance : fogEnd;
    return Math.max(NPC_3D_LOD_DISTANCE + NPC_LOD_HYSTERESIS_TILES, baseDistance + ENTITY_RENDER_PADDING_TILES);
  }

  private updateEntityRenderVisibility(): void {
    const enableDist = this.getEntityRenderDistanceTiles();
    const disableDist = enableDist + ENTITY_RENDER_HYSTERESIS_TILES;

    for (const [entityId, sprite] of this.entities.remotePlayers) {
      const target = this.entities.remoteTargets.get(entityId);
      const x = target?.x ?? sprite.position.x;
      const z = target?.z ?? sprite.position.z;
      const dist = Math.max(Math.abs(x - this.playerX), Math.abs(z - this.playerZ));
      const threshold = sprite.isRenderEnabled() ? disableDist : enableDist;
      sprite.setRenderEnabled(dist <= threshold);
    }

    for (const [entityId, sprite] of this.entities.npcSprites) {
      const target = this.entities.npcTargets.get(entityId);
      const x = target?.x ?? sprite.position.x;
      const z = target?.z ?? sprite.position.z;
      const dist = Math.max(Math.abs(x - this.playerX), Math.abs(z - this.playerZ));
      const enabled =
        sprite instanceof CharacterEntity
          ? sprite.isRenderEnabled()
          : sprite instanceof Npc3DEntity
            ? sprite.isRenderEnabled()
            : true;
      const threshold = enabled ? disableDist : enableDist;
      const sameFloor = target ? target.floor === this.currentFloor : true;
      const shouldRender = sameFloor && dist <= threshold;
      if (sprite instanceof CharacterEntity) sprite.setRenderEnabled(shouldRender);
      else if (sprite instanceof Npc3DEntity) sprite.setRenderEnabled(shouldRender);
    }
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

    for (const [, sprite] of this.entities.deathEffectEntities) {
      if (!sprite.hasHealthBar()) continue;
      const got = sprite.getHealthBarWorldPos(wp);
      if (!got) continue;
      Vector3.ProjectToRef(got, identity, transform, vp, screenPos);
      if (screenPos.z > 0 && screenPos.z < 1) sprite.updateHealthBarScreenPos(screenPos.x, screenPos.y);
      else sprite.updateHealthBarScreenPos(offscreenX, offscreenY);
    }
  }

  private updateHUD(): void {
    this.sidePanel?.updateHP(this.playerHealth, this.playerMaxHealth);
    this.updateMobileStatusBar('hp', this.playerHealth, this.playerMaxHealth);
  }

  private clearPendingHealthApply(entityId: number): void {
    const pending = this.pendingHealthApply.get(entityId);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.pendingHealthApply.delete(entityId);
    }
  }

  private clearAllPendingHealthApply(): void {
    for (const pending of this.pendingHealthApply.values()) {
      clearTimeout(pending);
    }
    this.pendingHealthApply.clear();
    this.clearPendingLocalHealthSync();
  }

  private clearPendingLocalHealthSync(): void {
    if (!this.pendingLocalHealthSync) return;
    clearTimeout(this.pendingLocalHealthSync.timer);
    this.pendingLocalHealthSync = null;
  }

  private getHealthBarHost(entityId: number): HealthBarHost | null {
    if (entityId === this.localPlayerId) return this.localPlayer;
    return this.entities.remotePlayers.get(entityId) ?? this.entities.npcSprites.get(entityId) ?? this.entities.deathEffectEntities.get(entityId) ?? null;
  }

  private showTransientHealthBar(entityId: number, host: HealthBarHost, health: number, maxHealth: number): void {
    if (health >= maxHealth) {
      this.hideTransientHealthBar(entityId, host);
      return;
    }
    host.showHealthBar(health, maxHealth);
    const expiresAt = this.entities.isDeathEffectActive(entityId)
      ? Number.POSITIVE_INFINITY
      : performance.now() + GameManager.HEALTH_BAR_VISIBLE_MS;
    this.transientHealthBars.set(entityId, expiresAt);
  }

  private updateTransientHealthBar(entityId: number, host: HealthBarHost, health: number, maxHealth: number): void {
    if (health >= maxHealth) {
      this.hideTransientHealthBar(entityId, host);
      return;
    }
    const expiresAt = this.transientHealthBars.get(entityId);
    if (expiresAt === undefined) return;
    if (performance.now() >= expiresAt) {
      this.hideTransientHealthBar(entityId, host);
      return;
    }
    host.showHealthBar(health, maxHealth);
  }

  private hideTransientHealthBar(entityId: number, host: HealthBarHost | null = this.getHealthBarHost(entityId)): void {
    this.transientHealthBars.delete(entityId);
    host?.hideHealthBar();
  }

  private hideAllTransientHealthBars(): void {
    for (const entityId of this.transientHealthBars.keys()) {
      this.getHealthBarHost(entityId)?.hideHealthBar();
    }
    this.transientHealthBars.clear();
  }

  private updateTransientHealthBars(): void {
    if (this.transientHealthBars.size === 0) return;
    const now = performance.now();
    for (const [entityId, expiresAt] of this.transientHealthBars) {
      if (this.entities.isDeathEffectActive(entityId)) continue;
      if (!Number.isFinite(expiresAt)) {
        this.hideTransientHealthBar(entityId);
        continue;
      }
      if (now < expiresAt) continue;
      this.hideTransientHealthBar(entityId);
    }
  }

  private applyLocalHealth(
    health: number,
    maxHealth: number,
    opts: { clearPendingImpact?: boolean } = {},
  ): void {
    this.clearPendingLocalHealthSync();
    if (opts.clearPendingImpact) this.clearPendingHealthApply(this.localPlayerId);
    this.playerHealth = health;
    this.playerMaxHealth = maxHealth;
    this.updateHUD();
    if (!this.localPlayer) return;
    this.updateTransientHealthBar(this.localPlayerId, this.localPlayer, health, maxHealth);
  }

  private applyLocalHealthFromServer(
    health: number,
    maxHealth: number,
    opts: { clearPendingImpact?: boolean } = {},
  ): void {
    const currentHealth = this.playerHealth;
    const isDamageDrop = health < currentHealth;
    const isHealingOrFull = health >= currentHealth || health >= maxHealth;

    if (opts.clearPendingImpact || isHealingOrFull) {
      this.applyLocalHealth(health, maxHealth, opts);
      return;
    }

    if (this.pendingHealthApply.has(this.localPlayerId)) {
      this.clearPendingLocalHealthSync();
      return;
    }

    if (!isDamageDrop) {
      this.applyLocalHealth(health, maxHealth, opts);
      return;
    }

    this.clearPendingLocalHealthSync();
    const timer = window.setTimeout(() => {
      const pending = this.pendingLocalHealthSync;
      this.pendingLocalHealthSync = null;
      if (!pending || this.pendingHealthApply.has(this.localPlayerId)) return;
      this.applyLocalHealth(pending.health, pending.maxHealth);
    }, GameManager.LOCAL_DAMAGE_SYNC_GRACE_MS);
    this.pendingLocalHealthSync = { health, maxHealth, timer };
  }

  private detectBufferedSelfSyncReplay(tickLow: number, now: number): boolean {
    if (this.lastSelfSyncTickLow !== null && this.lastSelfSyncReceivedAt !== 0) {
      const tickDelta = (tickLow - this.lastSelfSyncTickLow + 0x8000) & 0x7fff;
      const wallDelta = now - this.lastSelfSyncReceivedAt;
      const looksBuffered = this.isHiddenCatchupActive(now)
        && tickDelta > 0
        && tickDelta < 100
        && wallDelta >= 0
        && wallDelta < Math.min(150, TICK_RATE * 0.25);
      this.bufferedSelfSyncReplayCount = looksBuffered
        ? this.bufferedSelfSyncReplayCount + 1
        : 0;
    }

    this.lastSelfSyncTickLow = tickLow;
    this.lastSelfSyncReceivedAt = now;

    // 3 consecutive buffered-looking syncs (each <150ms apart while the
    // catch-up window is armed — normal syncs are 600ms apart) is a genuine
    // hidden-tab replay burst, not jitter. Reconnect early to discard the
    // backlog before it can rewind position via out-of-order tiles.
    if (this.bufferedSelfSyncReplayCount < 3 || this.reconnecting || !this._loginSettled || !this.network.isConnected()) {
      return false;
    }

    console.warn('[net] Buffered hidden-tab sync replay detected; reconnecting for a fresh snapshot');
    this.bufferedSelfSyncReplayCount = 0;
    this._hiddenSinceMs = 0;
    this._hiddenCatchupUntilMs = 0;
    this.clearHiddenCatchupTimer();
    void this.reconnectOrLogout();
    return true;
  }

  private checkSelfAuthorityFreshness(): void {
    if (this.destroyed || this.reconnecting || this.connectionFrozen || !this._loginSettled) return;
    if (this.lastSelfAuthorityAt === 0) return;
    if (this.selfAuthorityGraceUntil !== 0 && performance.now() < this.selfAuthorityGraceUntil) return;
    const now = performance.now();
    if (now - this.lastSelfAuthorityAt <= GameManager.AUTHORITY_STALE_MS) return;
    if (now - this.lastSelfAuthorityWarnAt <= GameManager.AUTHORITY_STALE_MS) return;
    console.warn('[net] Local authority stream stale; waiting for socket heartbeat before reconnecting');
    this.lastSelfAuthorityWarnAt = now;
  }

  private update(dt: number): void {
    if (this.connectionFrozen) return;
    this.checkSelfAuthorityFreshness();
    if (this.connectionFrozen) return;

    this.updateCameraKeys(dt);

    this.refreshDuelFacing();
    if (this.localPlayer) this.localPlayer.updateAnimation(dt);
    this.updateEntityRenderVisibility();
    this.entities.updateAnimations(dt);

    const camPos = this.scene.activeCamera?.position ?? null;

    if (this.chunkManager.updatePlayerPosition(this.playerX, this.playerZ)) {
      const objectsChanged = this.chunkManager.didLastUpdateChangeObjects();
      if (objectsChanged) {
        this.cleanupDisposedWorldObjects();
        this.linkPlacedObjectsToWorldObjects();
        this.reapplyWorldObjectVisualStates();
      }
      // Chunk visibility flips can re-enable placed nodes; re-hide only on
      // those events instead of walking the hidden roof list every frame.
      if (objectsChanged || this.chunkManager.didLastUpdateChangeTerrain()) {
        this.reapplyHiddenRoofStates();
        this.refreshHoverHiddenRoofs(true);
      }
    }
    this.chunkManager.updateAnimations();
    this.updateFog(dt);

    this.expireFinishedSlide();
    this.updatePlayerFollowPrediction(dt);
    this.updateCombatFollow(dt);
    this.updateLocalPlayerMovement(dt, camPos);
    // If a slide is in flight but there's no active path, updateLocalPlayerMovement
    // early-returns without touching the render position — drive the decay
    // ourselves so the visual catches up to the snapped logical position.
    if (this.slideStartMs !== 0 && this.pathIndex >= this.path.length) {
      this.renderLocalPlayerWithSlide();
    }
    this.updateLocalCombatWalkGrace();

    this.entities.interpolateRemotePlayers(
      dt,
      camPos,
      (entityId) => this.remoteAnimationStates.get(entityId)?.kind === PlayerAnimationKind.Skill,
      (entityId) => this.resolveTargetableIncludingLocal(entityId),
    );
    this.refreshDuelFacing();
    this.maintainNpcMaterialization();
    this.entities.interpolateNpcs(dt, camPos, this.localPlayerId, this.localPlayer?.position ?? null);
    // Remote actors get per-frame combat face locks in EntityManager. The
    // local player owns its own movement prediction, so keep its NPC combat
    // facing alive here without enabling strafe-lock while pathing.
    this.refreshLocalCombatFacing();

    this.updateIndoorDetection();
    this.updateDoorAnimations(dt);

    if (this.localPlayer) {
      this._tempVec.set(this.localPlayer.position.x, this.localPlayer.position.y, this.localPlayer.position.z);
      this.camera.followTarget(this._tempVec);
    }
    this.refreshHoverRoofForStoredPointer(performance.now());

    this._overlayTransformReady = false;
    this.updateTransientHealthBars();
    this.updateOverlayPositions();
    this.updateHitSplats(dt);
    this.updateXpDrops(dt);
    this.updateMinimap(dt);
  }

  private updateCameraKeys(dt: number): void {
    const camSpeed = 2.0 * dt;
    const cam = this.camera.getCamera();
    let yawDelta = 0;
    if (this.keysDown.has('a') || this.keysDown.has('arrowleft')) yawDelta += camSpeed;
    if (this.keysDown.has('d') || this.keysDown.has('arrowright')) yawDelta -= camSpeed;
    if (yawDelta !== 0) this.camera.rotate(yawDelta);
    if (this.keysDown.has('w') || this.keysDown.has('arrowup')) cam.beta = Math.max(0.2, cam.beta - camSpeed);
    if (this.keysDown.has('s') || this.keysDown.has('arrowdown')) cam.beta = Math.min(Math.PI / 2.2, cam.beta + camSpeed);
  }

  private updateCombatFollow(dt: number): void {
    this._combatPathTimer -= dt;
    if (!this.localPlayer) return;
    if (this.autoCastSpellIndex >= 0 && this.magicTargetId >= 0) {
      if (this.isNonCombatNpc(this.magicTargetId)) {
        this.clearLocalNpcCombatState();
        return;
      }
      const npcTarget = this.entities.npcTargets.get(this.magicTargetId);
      if (!npcTarget) return;
      if (this._combatPathTimer > 0 || performance.now() < this.castingUntil) return;
      const fp = this.distToNpcFootprint(this.magicTargetId, npcTarget, this.playerX, this.playerZ);
      if (Math.max(Math.abs(fp.dx), Math.abs(fp.dz)) <= SPELL_CAST_DISTANCE) return;
      this._combatPathTimer = 0.6;
      const pathResult = this.findPathToNpcInteraction(this.magicTargetId, npcTarget, SPELL_CAST_DISTANCE, 'chebyshev');
      if (pathResult.path.length > 0) {
        this.startPredictedPath(pathResult.path, pathResult.preserveCurrentStep);
        if (this.destMarker) this.destMarker.isVisible = false;
        this.minimap?.clearDestination();
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_ATTACK_NPC, this.magicTargetId));
      }
      return;
    }

    if (this.combatTargetId < 0) return;
    if (this.isNonCombatNpc(this.combatTargetId)) {
      this.clearLocalNpcCombatState();
      return;
    }
    const npcTarget = this.entities.npcTargets.get(this.combatTargetId);
    if (!npcTarget) return;
    const attackRange = this.getLocalNpcAttackRange();
    const rangeMode = this.getLocalNpcAttackRangeMode();
    const requireRangedLineOfSight = this.isLocalRangedWeapon();
    const inRange = this.isPointInNpcInteractionRange(this.combatTargetId, npcTarget, this.playerX, this.playerZ, attackRange, rangeMode, requireRangedLineOfSight);
    if (inRange) {
      if (this.trimPredictedPathToCurrentTileStep()) {
        this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_ATTACK_NPC, this.combatTargetId));
      }
      return;
    }
    if (this.pathIndex < this.path.length) return;
    if (this._combatPathTimer > 0) return;
    this._combatPathTimer = 0.6;
    const pathResult = this.findPathToNpcInteraction(this.combatTargetId, npcTarget, attackRange, rangeMode, requireRangedLineOfSight);
    const newPath = pathResult.path;
    if (newPath.length > 0) {
      this.startPredictedPath(newPath, pathResult.preserveCurrentStep);
      if (this.destMarker) this.destMarker.isVisible = false;
      this.minimap?.clearDestination();
    }
    this.network.sendRaw(encodePacket(ClientOpcode.PLAYER_ATTACK_NPC, this.combatTargetId));
  }

  private shouldKeepLocalCombatWalkLoopAlive(now: number = performance.now()): boolean {
    if (this.combatTargetId < 0) return false;
    const target = this.entities.npcTargets.get(this.combatTargetId);
    if (!target || target.floor !== this.currentFloor) return false;
    const movedRecently = (Math.abs(target.x - target.prevX) > 0.01 || Math.abs(target.z - target.prevZ) > 0.01)
      && now - target.t < TICK_RATE * 2;
    return target.continueWalking || movedRecently;
  }

  private updateLocalCombatWalkGrace(now: number = performance.now()): void {
    if (this.localCombatWalkUntilMs <= 0) return;
    if (this.pathIndex < this.path.length) return;
    if (now < this.localCombatWalkUntilMs) return;
    this.localCombatWalkUntilMs = 0;
    if (this.localPlayer?.isWalking()) {
      this.localPlayer.stopWalking();
      this.refreshLocalCombatFacing();
    }
  }

  private updatePlayerFollowPrediction(dt: number): void {
    if (this.followTargetPlayerId < 0 || !this.localPlayer) return;
    const targetState = this.entities.remoteTargets.get(this.followTargetPlayerId);
    const target = this.entities.remotePlayers.get(this.followTargetPlayerId);
    if (!target || !targetState || targetState.floor !== this.currentFloor) {
      this.followTargetPlayerId = -1;
      return;
    }

    this.followPathTimer = Math.max(0, this.followPathTimer - dt);
    const targetTileX = Math.floor(targetState.x);
    const targetTileZ = Math.floor(targetState.z);
    const followCandidates = [
      { x: targetState.prevX, z: targetState.prevZ },
      { x: targetTileX - 1 + 0.5, z: targetTileZ + 0.5 },
      { x: targetTileX + 1 + 0.5, z: targetTileZ + 0.5 },
      { x: targetTileX + 0.5, z: targetTileZ - 1 + 0.5 },
      { x: targetTileX + 0.5, z: targetTileZ + 1 + 0.5 },
    ].filter((candidate, index, all) => {
      const tileX = Math.floor(candidate.x);
      const tileZ = Math.floor(candidate.z);
      return (tileX !== targetTileX || tileZ !== targetTileZ)
        && all.findIndex(other => Math.floor(other.x) === tileX && Math.floor(other.z) === tileZ) === index;
    });
    const currentTileX = Math.floor(this.playerX);
    const currentTileZ = Math.floor(this.playerZ);
    const currentGoal = followCandidates.find(candidate => currentTileX === Math.floor(candidate.x) && currentTileZ === Math.floor(candidate.z));
    if (currentGoal) {
      if (this.pathIndex < this.path.length) {
        const pathResult = this.findPathFromMovementAnchor(currentGoal.x, currentGoal.z);
        if (pathResult.path.length > 0) {
          this.startLocalPredictedPath(pathResult.path, pathResult.preserveCurrentStep);
        } else {
          this.trimPredictedPathToCurrentTileStep(false, false);
        }
      }
      const anchor = target.getTargetAnchor();
      this.localPlayer.lockFaceTowardXZ(anchor.x, anchor.z);
      return;
    }
    if (this.pathIndex < this.path.length) return;
    if (this.followPathTimer > 0) return;
    this.followPathTimer = 0.6;

    for (const candidate of followCandidates) {
      const goalTileX = Math.floor(candidate.x);
      const goalTileZ = Math.floor(candidate.z);
      if (this.isTileBlocked(goalTileX, goalTileZ)) continue;
      const pathResult = this.findPathFromMovementAnchor(goalTileX + 0.5, goalTileZ + 0.5);
      if (pathResult.path.length > 0) {
        this.startLocalPredictedPath(pathResult.path, pathResult.preserveCurrentStep);
        break;
      }
    }
    if (this.destMarker) this.destMarker.isVisible = false;
    this.minimap?.clearDestination();
  }

  /** Current slide-offset effect on the rendered local-player position.
   *  Linearly decays from the initial offset to (0, 0) over slideDurationMs.
   *  PURE: no side effects — it can be called multiple times per frame (and
   *  mid-frame from packet handlers) without mutating slide state, which
   *  previously let an expiry-zeroing side effect leak between same-frame
   *  reads and produce sub-frame position discontinuities. Expiry cleanup is
   *  done once per frame in `expireFinishedSlide()`. */
  private getSlideOffset(): { x: number; z: number } {
    if (this.slideStartMs === 0) return { x: 0, z: 0 };
    const age = performance.now() - this.slideStartMs;
    if (age >= this.slideDurationMs) return { x: 0, z: 0 };
    const factor = 1 - age / this.slideDurationMs;
    return { x: this.slideOffsetX * factor, z: this.slideOffsetZ * factor };
  }

  /** Deterministic once-per-frame slide expiry. Replaces the old read-time
   *  side effect in getSlideOffset so reads stay pure. */
  private expireFinishedSlide(): void {
    if (this.slideStartMs === 0) return;
    if (performance.now() - this.slideStartMs >= this.slideDurationMs) {
      this.slideStartMs = 0;
      this.slideOffsetX = 0;
      this.slideOffsetZ = 0;
    }
  }

  private isHiddenCatchupActive(now: number = performance.now()): boolean {
    return this._hiddenSinceMs !== 0 || now < this._hiddenCatchupUntilMs;
  }

  private clearHiddenCatchupTimer(): void {
    if (this._hiddenCatchupTimer === null) return;
    window.clearTimeout(this._hiddenCatchupTimer);
    this._hiddenCatchupTimer = null;
  }

  private scheduleHiddenCatchupDisarm(): void {
    this.clearHiddenCatchupTimer();
    const delay = Math.max(0, this._hiddenCatchupUntilMs - performance.now()) + 50;
    this._hiddenCatchupTimer = window.setTimeout(() => {
      this._hiddenCatchupTimer = null;
      if (document.visibilityState !== 'visible') return;
      if (performance.now() < this._hiddenCatchupUntilMs) {
        this.scheduleHiddenCatchupDisarm();
        return;
      }
      this._hiddenSinceMs = 0;
      this._hiddenCatchupUntilMs = 0;
    }, delay);
  }

  private catchUpAfterHiddenTab(hiddenForMs: number): void {
    const now = performance.now();
    const authorityStale = this.lastSelfAuthorityAt !== 0
      && now - this.lastSelfAuthorityAt > GameManager.AUTHORITY_STALE_MS;
    if (
      hiddenForMs >= GameManager.HIDDEN_RECONNECT_AFTER_MS
      && authorityStale
      && this._loginSettled
      && this.network.isConnected()
    ) {
      console.warn('[net] Authority stream stale after hidden tab; reconnecting to discard buffered snapshots');
      this._hiddenSinceMs = 0;
      this._hiddenCatchupUntilMs = 0;
      this.clearHiddenCatchupTimer();
      void this.reconnectOrLogout();
      return;
    }

    this._hiddenCatchupUntilMs = now + GameManager.HIDDEN_CATCHUP_ARM_MS;
    this.scheduleHiddenCatchupDisarm();
    this.entities.snapDynamicEntitiesToTargets();
    if (this.latestSelfSync) {
      // Reconcile onto the still-valid predicted path instead of clearing it.
      // If the server is on our path (the common case — we predicted the same
      // route the server walks), this fast-forwards pathIndex and prediction
      // resumes smooth forward-animated movement. Only a genuine divergence
      // hard-snaps. Previously we cleared the path and slid to authority on
      // every sync, which lurched backward each tick (visible jitter).
      this.reconcileLocalPlayerToServer(this.latestSelfSync.x, this.latestSelfSync.z, true, this.latestSelfSync.moving);
    }
    if (this._loginSettled && this.network.isConnected()) {
      this.network.sendRaw(encodePacket(ClientOpcode.MAP_READY));
    }
  }

  /** Wire `document.visibilitychange` so hidden-tab throttling cannot leave
   *  visuals replaying stale prediction. Hidden tabs throttle RAF and may
   *  freeze JS entirely while the server keeps ticking every 600ms. On return,
   *  snap visuals to the latest processed authoritative targets; if authority
   *  stopped arriving while hidden, reconnect to discard any buffered packet
   *  backlog and bootstrap from a fresh server snapshot. */
  private setupVisibilityHandler(): void {
    const handler = () => {
      if (document.visibilityState === 'hidden') {
        this.clearHiddenCatchupTimer();
        this._hiddenSinceMs = performance.now();
        this._hiddenCatchupUntilMs = 0;
      } else {
        const hiddenForMs = this._hiddenSinceMs === 0 ? 0 : performance.now() - this._hiddenSinceMs;
        this.catchUpAfterHiddenTab(hiddenForMs);
      }
    };
    document.addEventListener('visibilitychange', handler);
    this._visibilityHandler = handler;
    if (document.visibilityState === 'hidden') handler();
  }

  private setupActivityTracking(): void {
    const handler = (event?: Event) => {
      if (event instanceof PointerEvent) {
        this.network.sendActivity(ClientActivityKind.Pointer, event.clientX, event.clientY);
        // CLIENT_ACTIVITY records the click itself; cursor telemetry stays
        // low-rate so rapid UI clicking cannot trip server packet guardrails.
        this.network.sendCursorPosition(event.clientX, event.clientY);
      } else if (event instanceof KeyboardEvent) {
        this.network.sendActivity(ClientActivityKind.Keyboard);
      } else if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
        const touch = event.changedTouches[0] ?? event.touches[0];
        this.network.sendActivity(
          ClientActivityKind.Touch,
          touch?.clientX,
          touch?.clientY,
        );
      } else {
        this.network.sendActivity();
      }
    };
    const cursorHandler = (event: PointerEvent) => {
      this.network.sendCursorPosition(event.clientX, event.clientY);
    };
    window.addEventListener('pointerdown', handler, true);
    window.addEventListener('keydown', handler, true);
    window.addEventListener('touchstart', handler, true);
    window.addEventListener('pointermove', cursorHandler, true);
    window.addEventListener('pointerdown', cursorHandler, true);
    this._activityHandler = handler;
    this._cursorTelemetryHandler = cursorHandler;
  }

  private reconcileLocalPlayerToServer(serverX: number, serverZ: number, hiddenCatchup: boolean, serverMoving: boolean = false): void {
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
    // visual onto it. After a hidden-tab return, hard-reset only the stale
    // client visual; do not send an empty move that would cancel the server's
    // still-authoritative queue.
    this.clearPredictedPath();
    this.setTileFrom(serverX, serverZ);
    if (this.destMarker) this.destMarker.isVisible = false;
    this.minimap?.clearDestination();

    if (hiddenCatchup) {
      this.slideOffsetX = 0;
      this.slideOffsetZ = 0;
      this.slideStartMs = 0;
      if (this.localPlayer) {
        this.localPlayer.setPositionXYZ(serverX, this.getHeight(serverX, serverZ), serverZ);
        this.localPlayer.stopWalking();
      }
      this.inputManager.setPlayerY(this.getHeight(serverX, serverZ));
    } else {
      const dragDist = Math.hypot(prevLogicalX - serverX, prevLogicalZ - serverZ);
      const slideMs = Math.min(Math.max(dragDist / 3.0 * 1000, 200), 800);
      this.beginVisualSlide(prevLogicalX, prevLogicalZ, slideMs);
      if (serverMoving) {
        if (!this.localPlayer?.isWalking()) this.localPlayer?.startWalking();
      } else {
        this.localPlayer?.stopWalking();
      }
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

      // Do not face-lock to NPCs while pathing. Keeping the body aimed at a
      // far target makes the walk animation turn into strafing/backpedaling,
      // which reads as sliding. Arrival handling faces the NPC once movement
      // has actually finished.
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

    let writeIdx = 0;
    for (let i = 0; i < this.hitSplats.length; i++) {
      const splat = this.hitSplats[i];
      splat.timer -= dt;
      splat.worldPos.y += dt * 0.5;
      if (splat.timer <= 0) {
        splat.el.remove();
      } else {
        this.positionHitSplat(splat);
        this.hitSplats[writeIdx++] = splat;
      }
    }
    this.hitSplats.length = writeIdx;
  }

  private updateXpDrops(dt: number): void {
    if (this.xpDrops.length === 0) return;

    let writeIdx = 0;
    for (let i = 0; i < this.xpDrops.length; i++) {
      const drop = this.xpDrops[i];
      drop.timer -= dt;
      drop.worldPos.y += dt * drop.riseSpeed;
      if (drop.timer <= 0) {
        drop.el.remove();
      } else {
        this.positionXpDrop(drop);
        this.xpDrops[writeIdx++] = drop;
      }
    }
    this.xpDrops.length = writeIdx;
  }

  private updateIndoorDetection(): void {
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
        this.hiddenRoofNodeSet.clear();
        for (const node of this.hiddenRoofNodes) this.setPlacedWorldObjectEnabled(node, true);
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
      }
    }
  }

  private clearHoverRoofPointer(): void {
    this._lastRoofHoverClientX = null;
    this._lastRoofHoverClientY = null;
    this._lastRoofHoverRefreshAt = 0;
    this.clearHoverHiddenRoofs();
  }

  private refreshHoverRoofForStoredPointer(now: number): void {
    if (this._lastRoofHoverClientX === null || this._lastRoofHoverClientY === null) return;
    if (now - this._lastRoofHoverRefreshAt < ROOF_HOVER_REFRESH_MS) return;
    this._lastRoofHoverRefreshAt = now;
    const hasHiddenHoverRoofs = this.hoverHiddenRoofNodes.length > 0 || this.hoverHiddenRoofNodeSet.size > 0;
    const shouldCheckExpiredReveal = hasHiddenHoverRoofs && now >= this._hoverRoofRevealGraceUntil;
    this.updateHoverRoofReveal(this._lastRoofHoverClientX, this._lastRoofHoverClientY, shouldCheckExpiredReveal);
  }

  private hoverRoofTileAt(clientX: number, clientY: number): { x: number; z: number; y: number } | null {
    if (!this.scene.activeCamera) return null;
    const point = this.canvasPointFromClient(clientX, clientY);
    if (!point) return null;
    const ray = this.scene.createPickingRay(point.x, point.y, null, this.scene.activeCamera);
    if (Math.abs(ray.direction.y) < 0.0001) return null;
    const y = this.localPlayer?.position.y ?? this.getHeightAtFloor(this.playerX, this.playerZ, this.currentFloor);
    const t = (y - ray.origin.y) / ray.direction.y;
    if (t <= 0) return null;
    const floorX = ray.origin.x + ray.direction.x * t;
    const floorZ = ray.origin.z + ray.direction.z * t;
    const structuralSampleYs = ROOF_HOVER_STRUCTURAL_SAMPLE_HEIGHT_OFFSETS.map(offset => y + offset);
    const revealHit = this.chunkManager.findRoofRevealPointFromRay(
      ray.origin,
      ray.direction,
      y + 0.5,
      floorX,
      floorZ,
      ROOF_HOVER_RAY_SEARCH_RADIUS_TILES,
      ROOF_HOVER_WALL_TRIGGER_RADIUS_TILES,
      structuralSampleYs,
    );
    if (revealHit) return { x: revealHit.x, z: revealHit.z, y };
    return {
      x: floorX,
      z: floorZ,
      y,
    };
  }

  private updateHoverRoofReveal(clientX: number, clientY: number, force: boolean = false): void {
    const now = performance.now();
    if (this.destroyed || this.connectionFrozen) {
      this.clearHoverHiddenRoofs();
      return;
    }

    const hover = this.hoverRoofTileAt(clientX, clientY);
    if (!hover) {
      if (this.retainHoverHiddenRoofs(now)) return;
      this.clearHoverHiddenRoofs();
      return;
    }

    const tileX = Math.floor(hover.x);
    const tileZ = Math.floor(hover.z);
    if (!force && tileX === this._lastHoverRoofTileX && tileZ === this._lastHoverRoofTileZ) return;
    this._lastHoverRoofTileX = tileX;
    this._lastHoverRoofTileZ = tileZ;

    const minY = hover.y + 0.5;
    this.applyCollectedHoverRoofSet(tileX, tileZ, minY, hover.y + 1.2, force, true, now);
  }

  private refreshHoverHiddenRoofs(force: boolean = false, allowStickyRetention: boolean = true): void {
    if (this._lastHoverRoofTileX === -9999 || this._lastHoverRoofTileZ === -9999) return;
    const y = this.localPlayer?.position.y ?? this.getHeightAtFloor(this.playerX, this.playerZ, this.currentFloor);
    const minY = y + 0.5;
    this.applyCollectedHoverRoofSet(
      this._lastHoverRoofTileX,
      this._lastHoverRoofTileZ,
      minY,
      y + 1.2,
      force,
      allowStickyRetention,
    );
  }

  private applyCollectedHoverRoofSet(
    tileX: number,
    tileZ: number,
    minY: number,
    minRevealY: number,
    force: boolean,
    allowStickyRetention: boolean,
    now: number = performance.now(),
  ): void {
    const newSet = this.collectHoverRoofSet(tileX, tileZ, minY, minRevealY);
    if (newSet.size === 0) {
      if (allowStickyRetention && this.retainHoverHiddenRoofs(now, tileX, tileZ)) return;
      this.clearHoverRevealForCurrentTile(force);
      return;
    }

    this._lastHoverRevealTileX = tileX;
    this._lastHoverRevealTileZ = tileZ;
    this._hoverRoofRevealGraceUntil = now + ROOF_HOVER_CLEAR_GRACE_MS;
    this.applyHoverHiddenRoofSet(newSet, force);
  }

  private collectHoverRoofSet(tileX: number, tileZ: number, minY: number, minRevealY: number): Set<TransformNode> {
    const newSet = new Set<TransformNode>();
    const x = tileX + 0.5;
    const z = tileZ + 0.5;
    for (const node of this.chunkManager.getConnectedRoofRevealNodesAt(x, z, minY, minRevealY, ROOF_HOVER_WALL_TRIGGER_RADIUS_TILES)) {
      if (!node.isDisposed()) newSet.add(node);
    }
    return newSet;
  }

  private isNearLastHoverRevealTile(tileX: number, tileZ: number): boolean {
    if (this._lastHoverRevealTileX === -9999 || this._lastHoverRevealTileZ === -9999) return false;
    return Math.abs(tileX - this._lastHoverRevealTileX) <= ROOF_HOVER_STICKY_RADIUS_TILES
      && Math.abs(tileZ - this._lastHoverRevealTileZ) <= ROOF_HOVER_STICKY_RADIUS_TILES;
  }

  private retainHoverHiddenRoofs(now: number, tileX: number | null = null, tileZ: number | null = null): boolean {
    if (this.hoverHiddenRoofNodes.length === 0 && this.hoverHiddenRoofNodeSet.size === 0) return false;
    if (tileX !== null && tileZ !== null && !this.isNearLastHoverRevealTile(tileX, tileZ)) return false;
    if (now >= this._hoverRoofRevealGraceUntil) return false;

    let retainedCount = 0;
    const next: TransformNode[] = [];
    const nextSet = new Set<TransformNode>();
    for (const node of this.hoverHiddenRoofNodes) {
      if (node.isDisposed()) continue;
      if (node.isEnabled(false)) node.setEnabled(false);
      next.push(node);
      nextSet.add(node);
      retainedCount++;
    }
    if (retainedCount === 0) {
      this.hoverHiddenRoofNodes = [];
      this.hoverHiddenRoofNodeSet.clear();
      return false;
    }
    if (next.length !== this.hoverHiddenRoofNodes.length || nextSet.size !== this.hoverHiddenRoofNodeSet.size) {
      this.hoverHiddenRoofNodes = next;
      this.hoverHiddenRoofNodeSet = nextSet;
    }
    return true;
  }

  private hoverRoofSetMatchesCurrent(newSet: Set<TransformNode>): boolean {
    if (newSet.size !== this.hoverHiddenRoofNodeSet.size) return false;
    for (const node of newSet) {
      if (!this.hoverHiddenRoofNodeSet.has(node)) return false;
    }
    return true;
  }

  private applyHoverHiddenRoofSet(newSet: Set<TransformNode>, reapplyExisting: boolean = false): void {
    if (!reapplyExisting && this.hoverRoofSetMatchesCurrent(newSet)) return;

    const oldSet = this.hoverHiddenRoofNodeSet;
    this.hoverHiddenRoofNodeSet = newSet;

    for (const node of this.hoverHiddenRoofNodes) {
      if (!newSet.has(node) && !node.isDisposed()) this.setPlacedWorldObjectEnabled(node, true);
    }

    const next: TransformNode[] = [];
    for (const node of newSet) {
      if (node.isDisposed()) continue;
      if ((reapplyExisting || !oldSet.has(node)) && node.isEnabled(false)) node.setEnabled(false);
      next.push(node);
    }
    this.hoverHiddenRoofNodes = next;
  }

  private clearHoverRevealForCurrentTile(reapplyExisting: boolean = false): void {
    this._lastHoverRevealTileX = -9999;
    this._lastHoverRevealTileZ = -9999;
    this._hoverRoofRevealGraceUntil = 0;
    this.applyHoverHiddenRoofSet(new Set<TransformNode>(), reapplyExisting);
  }

  private clearHoverHiddenRoofs(): void {
    this._lastHoverRevealTileX = -9999;
    this._lastHoverRevealTileZ = -9999;
    this._hoverRoofRevealGraceUntil = 0;
    if (this.hoverHiddenRoofNodes.length === 0 && this.hoverHiddenRoofNodeSet.size === 0) {
      this._lastHoverRoofTileX = -9999;
      this._lastHoverRoofTileZ = -9999;
      return;
    }

    const oldNodes = this.hoverHiddenRoofNodes;
    this.hoverHiddenRoofNodes = [];
    this.hoverHiddenRoofNodeSet.clear();
    this._lastHoverRoofTileX = -9999;
    this._lastHoverRoofTileZ = -9999;
    for (const node of oldNodes) {
      if (!node.isDisposed()) this.setPlacedWorldObjectEnabled(node, true);
    }
  }

  private reapplyHiddenRoofStates(): void {
    const seen = new Set<TransformNode>();
    for (const list of [this.hiddenRoofNodes, this.hoverHiddenRoofNodes]) {
      for (const node of list) {
        if (node.isDisposed() || seen.has(node)) continue;
        seen.add(node);
        if (node.isEnabled(false)) node.setEnabled(false);
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
    // Never hide nodes within head-clearance of the player — without the
    // `py + 1.5` floor, the upper-floor plane the player is climbing toward
    // stays culled until they're literally on it, because the plane itself
    // IS the lowest ceiling and (ceilingY - 0.1) lands just below it.
    const headClearY = py + 1.5;
    const hideAboveY = ceilingY < Infinity ? Math.max(ceilingY - 0.1, headClearY) : headClearY;

    const newSet = new Set<TransformNode>();
    for (const n of this.chunkManager.getRoofNodesNear(this.playerX, this.playerZ, 8, headClearY, floor)) newSet.add(n);
    for (const n of this.chunkManager.getNodesAboveHeight(this.playerX, this.playerZ, 8, hideAboveY)) newSet.add(n);

    const oldSet = this.hiddenRoofNodeSet;
    this.hiddenRoofNodeSet = newSet;

    // Re-enable nodes that LEFT the hidden set.
    for (const node of this.hiddenRoofNodes) {
      if (!newSet.has(node)) this.setPlacedWorldObjectEnabled(node, true);
    }
    // Disable nodes that ENTERED the hidden set (don't touch ones already in).
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
   *  state, and placed-object interactions can add authored actions. Mirrors
   *  WorldObject.currentActions on the server so right-click labels stay
   *  truthful as the door toggles. */
  private actionsForInstance(
    def: WorldObjectDef,
    depleted: boolean,
    data?: { x: number; z: number; locked?: boolean },
    interactionActions?: readonly string[],
  ): readonly string[] {
    let actions: readonly string[];
    if (def.category === 'door') {
      if (!depleted && data?.locked) return DOOR_ACTIONS_LOCKED_CLIENT;
      actions = depleted ? DOOR_ACTIONS_OPEN_CLIENT : DOOR_ACTIONS_CLOSED_CLIENT;
    } else if (def.category === 'ladder') {
      actions = def.actions;
    } else if (depleted) {
      return [];
    } else {
      actions = def.actions;
    }
    return mergeObjectActionLabels(actions, interactionActions);
  }

  private isWorldObjectInteractable(def: WorldObjectDef | undefined | null, depleted: boolean): boolean {
    if (!def) return false;
    return !depleted || def.category === 'door';
  }

  private setWorldObjectPickTarget(objectEntityId: number, interactive: boolean, root?: TransformNode | null): void {
    const target = root ?? this.worldObjectModels.get(objectEntityId);
    if (!target) return;
    const previous = this.worldObjectPickState.get(target);
    if (previous?.entityId === objectEntityId && previous.interactive === interactive) return;

    const apply = (node: TransformNode): void => {
      if ('isPickable' in node) {
        (node as TransformNode & { isPickable: boolean }).isPickable = interactive;
      }
      if (interactive) {
        node.metadata = { ...node.metadata, objectEntityId };
      } else if (node.metadata && node.metadata.objectEntityId === objectEntityId) {
        delete node.metadata.objectEntityId;
      }
    };

    apply(target);
    for (const child of target.getChildMeshes(false)) apply(child);
    for (const child of target.getChildTransformNodes(false)) apply(child);
    this.worldObjectPickState.set(target, { entityId: objectEntityId, interactive });
  }

  private playWorldObjectAnimation(objectEntityId: number): void {
    let model = this.worldObjectModels.get(objectEntityId);
    if (!model) {
      const data = this.worldObjectDefs.get(objectEntityId);
      if (data) {
        const placedNode = this.chunkManager.findPlacedObjectNear(
          data.x,
          data.z,
          1.5,
          data.defId,
          data.y,
          node => this.canLinkPlacedNodeToWorldObject(objectEntityId, node),
        );
        if (placedNode) {
          this.linkPlacedNodeToEntity(objectEntityId, data, placedNode);
          model = placedNode;
        }
      }
    }
    if (model) this.chunkManager.playPlacedObjectAnimation(model);
  }

  private fallbackDoorPickProxyBounds(x: number, z: number, rotY: number, baseY: number): DoorPickProxyBounds {
    const { tile: [tx, tz], edge, axis } = doorEdgeFromPlacement(x, z, rotY);
    const center = new Vector3(tx + 0.5, baseY + 0.9, tz + 0.5);
    if (edge === WallEdge.N) center.z = tz + 0.08;
    else if (edge === WallEdge.S) center.z = tz + 0.92;
    else if (edge === WallEdge.E) center.x = tx + 0.92;
    else if (edge === WallEdge.W) center.x = tx + 0.08;

    return {
      center,
      width: axis === 'NS' ? 1.05 : 0.42,
      depth: axis === 'NS' ? 0.42 : 1.05,
      height: 2.15,
    };
  }

  private computeDoorPickProxyBounds(
    model: TransformNode,
    x: number,
    z: number,
    rotY: number,
    baseY: number,
  ): DoorPickProxyBounds {
    const fallback = this.fallbackDoorPickProxyBounds(x, z, rotY, baseY);
    model.computeWorldMatrix(true);
    let bounds: ReturnType<TransformNode['getHierarchyBoundingVectors']>;
    try {
      bounds = model.getHierarchyBoundingVectors(true);
    } catch {
      return fallback;
    }

    const width = bounds.max.x - bounds.min.x;
    const depth = bounds.max.z - bounds.min.z;
    const height = bounds.max.y - bounds.min.y;
    if (!Number.isFinite(width) || !Number.isFinite(depth) || !Number.isFinite(height) || width <= 0 || depth <= 0 || height <= 0) {
      return fallback;
    }

    // Use the closed mesh bounds when available so the invisible click target
    // follows oversized/scaled door panels instead of the legacy one-tile box.
    // Keep a small minimum thickness so very flat door planes remain easy to hit.
    const margin = 0.12;
    return {
      center: new Vector3(
        (bounds.min.x + bounds.max.x) / 2,
        (bounds.min.y + bounds.max.y) / 2,
        (bounds.min.z + bounds.max.z) / 2,
      ),
      width: Math.max(fallback.width, Math.min(width + margin, 3.5)),
      depth: Math.max(fallback.depth, Math.min(depth + margin, 3.5)),
      height: Math.max(1.2, Math.min(height + margin, 4.5)),
    };
  }

  private createDoorPickProxy(
    objectEntityId: number,
    x: number,
    z: number,
    rotY: number,
    baseY: number,
    bounds?: DoorPickProxyBounds,
  ): void {
    this.doorPickProxies.get(objectEntityId)?.dispose();
    const proxyBounds = bounds ?? this.fallbackDoorPickProxyBounds(x, z, rotY, baseY);
    if (!this.doorPivots.has(objectEntityId)) this.setupDoorPivot(objectEntityId);
    const doorEntry = this.doorPivots.get(objectEntityId) ?? null;
    const proxy = MeshBuilder.CreateBox(`door_pickProxy_${objectEntityId}`, {
      width: proxyBounds.width,
      depth: proxyBounds.depth,
      height: proxyBounds.height,
    }, this.scene);

    // The preferred bounds are sampled from the closed panel, then converted
    // into pivot-local space. Parenting the proxy to the same pivot as the door
    // panel makes the invisible click box follow default-open and newly opened
    // doors without per-frame proxy work.
    proxy.rotationQuaternion = null;
    proxy.rotation.set(0, 0, 0);
    if (doorEntry) {
      proxy.parent = doorEntry.pivot;
      proxy.position = this.closedDoorProxyLocalCenter(doorEntry, proxyBounds.center);
    } else {
      proxy.position = proxyBounds.center;
    }
    proxy.isVisible = true;
    proxy.visibility = 0;
    proxy.isPickable = true;
    proxy.layerMask = 0;
    proxy.metadata = { kind: 'worldObject', objectEntityId };
    proxy.computeWorldMatrix(true);

    this.doorPickProxies.set(objectEntityId, proxy);
  }

  private closedDoorProxyLocalCenter(entry: DoorPivotEntry, closedWorldCenter: Vector3): Vector3 {
    const pivot = entry.pivot;
    const restoreAngle = pivot.rotation.y;
    pivot.rotation.y = 0;
    pivot.computeWorldMatrix(true);
    const invWorld = new Matrix();
    pivot.getWorldMatrix().invertToRef(invWorld);
    const localCenter = Vector3.TransformCoordinates(closedWorldCenter, invWorld);
    pivot.rotation.y = restoreAngle;
    pivot.computeWorldMatrix(true);
    return localCenter;
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

    const openDirection = data?.openDirection === 1 ? 1 : -1;
    const startAngle = (data && data.depleted) ? openDirection * Math.PI / 2 : 0;

    this.doorPivots.set(objectEntityId, {
      pivot,
      targetAngle: startAngle,
      currentAngle: startAngle,
      closedRotY,
      openDirection,
    });

    pivot.rotation.y = startAngle;
  }

  private animateDoor(objectEntityId: number, opening: boolean, swingSign: number = 0): void {
    const entry = this.doorPivots.get(objectEntityId);
    if (!entry) return;
    if (opening) {
      const dir = swingSign === 0 ? entry.openDirection : (swingSign >= 0 ? -1 : 1);
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

  private pruneMinimapEntityPositions(
    positions: Map<number, MinimapEntityPoint>,
    liveTargets: Map<number, unknown>,
  ): void {
    for (const entityId of positions.keys()) {
      if (!liveTargets.has(entityId)) positions.delete(entityId);
    }
  }

  private updateMinimapEntityPoint(
    positions: Map<number, MinimapEntityPoint>,
    entityId: number,
    targetX: number,
    targetZ: number,
    dt: number,
    visualPosition: MinimapEntityPoint | null,
  ): MinimapEntityPoint {
    let point = positions.get(entityId);
    if (!point) {
      point = {
        x: visualPosition?.x ?? targetX,
        z: visualPosition?.z ?? targetZ,
      };
      positions.set(entityId, point);
      return point;
    }

    if (visualPosition) {
      point.x = visualPosition.x;
      point.z = visualPosition.z;
      return point;
    }

    const dx = targetX - point.x;
    const dz = targetZ - point.z;
    const distance = Math.max(Math.abs(dx), Math.abs(dz));
    if (
      distance <= 0.001
      || distance > GameManager.MINIMAP_ENTITY_SNAP_DISTANCE_TILES
    ) {
      point.x = targetX;
      point.z = targetZ;
      return point;
    }

    const step = GameManager.MINIMAP_ENTITY_TILES_PER_SEC * Math.min(dt, MAX_FRAME_DT_SECONDS);
    const ratio = Math.min(step / distance, 1);
    point.x += dx * ratio;
    point.z += dz * ratio;
    return point;
  }

  private collectMinimapDynamicEntities(dt: number): void {
    this._minimapRemotes.length = 0;
    this.pruneMinimapEntityPositions(this._minimapRemotePositions, this.entities.remoteTargets);
    for (const [entityId, target] of this.entities.remoteTargets) {
      const remote = this.entities.remotePlayers.get(entityId);
      const visualPosition = remote && remote.isRenderEnabled() ? remote.position : null;
      this._minimapRemotes.push(this.updateMinimapEntityPoint(
        this._minimapRemotePositions,
        entityId,
        target.x,
        target.z,
        dt,
        visualPosition,
      ));
    }

    this._minimapNpcs.length = 0;
    this.pruneMinimapEntityPositions(this._minimapNpcPositions, this.entities.npcTargets);
    for (const [entityId, target] of this.entities.npcTargets) {
      const sprite = this.entities.npcSprites.get(entityId);
      const visualPosition = sprite?.isRenderEnabled() ? sprite.position : null;
      this._minimapNpcs.push(this.updateMinimapEntityPoint(
        this._minimapNpcPositions,
        entityId,
        target.x,
        target.z,
        dt,
        visualPosition,
      ));
    }
  }

  private updateMinimap(dt: number): void {
    if (!this.minimap || !this.chunkManager.isLoaded()) return;
    const now = performance.now();
    const shouldRefreshLists = this._lastMinimapListRefreshMs === 0
      || now - this._lastMinimapListRefreshMs >= GameManager.MINIMAP_LIST_REFRESH_INTERVAL_MS;
    this.collectMinimapDynamicEntities(dt);
    if (shouldRefreshLists) {
      this._lastMinimapListRefreshMs = now;

      this._minimapObjects.length = 0;
      for (const [, data] of this.worldObjectDefs) {
        if (data.depleted) continue;
        const def = this.objectDefsCache.get(data.defId);
        if (!def) continue;
        this._minimapObjects.push({ x: data.x, z: data.z, category: def.category });
      }
      this._minimapDrops.length = 0;
      for (const [, item] of this.entities.groundItems) {
        if (item.floor !== this.currentFloor) continue;
        this._minimapDrops.push({ x: item.x, z: item.z });
      }
      this._minimapMarkers.length = 0;
      for (const marker of this.chunkManager.getMinimapMarkers()) {
        if (marker.floor !== undefined && marker.floor !== this.currentFloor) continue;
        this._minimapMarkers.push(marker);
      }
    }
    const camAlpha = this.camera.getCamera().alpha;
    this.minimap.update(
      this.playerX, this.playerZ,
      this._minimapRemotes, this._minimapNpcs,
      this.chunkManager,
      camAlpha,
      this._minimapObjects,
      this._minimapDrops,
      this._minimapMarkers,
      dt,
      this.localPlayer?.getFacingAngle() ?? null,
    );
  }
}
