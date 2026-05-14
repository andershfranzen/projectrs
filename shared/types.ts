import type { PlayerAppearance } from './appearance.js';

export interface Position {
  x: number;
  y: number;
}

export interface EntityState {
  id: number;
  type: 'player' | 'npc';
  position: Position;
  name: string;
  health: number;
  maxHealth: number;
}

export interface PlayerState extends EntityState {
  type: 'player';
  combatLevel: number;
}

export interface NpcState extends EntityState {
  type: 'npc';
  npcId: number;
}

export interface ItemDef {
  id: number;
  name: string;
  description: string;
  stackable: boolean;
  equippable: boolean;
  equipSlot?: 'weapon' | 'head' | 'body' | 'legs' | 'shield' | 'neck' | 'ring' | 'hands' | 'feet' | 'cape';
  attackSpeed?: number;
  weaponStyle?: 'stab' | 'slash' | 'crush' | 'bow' | 'crossbow';
  twoHanded?: boolean;
  ammoType?: 'arrow' | 'bolt';
  isAmmo?: boolean;
  // Attack bonuses
  stabAttack?: number;
  slashAttack?: number;
  crushAttack?: number;
  // Defence bonuses
  stabDefence?: number;
  slashDefence?: number;
  crushDefence?: number;
  // Strength
  meleeStrength?: number;
  // Ranged
  rangedAccuracy?: number;
  rangedStrength?: number;
  rangedDefence?: number;
  // Magic
  magicAccuracy?: number;
  magicDefence?: number;
  // Food
  healAmount?: number;
  // Tool properties (axes, pickaxes)
  toolType?: 'axe' | 'pickaxe';
  toolLevel?: number;
  toolBonus?: number;
  // Visual
  sprite?: string;
  icon?: string;
  /**
   * Equipment GLB filename or path. Resolved by the gear loader as:
   *   - starts with '/' → used as-is (absolute path under client/public)
   *   - otherwise → resolved relative to /assets/equipment/{equipSlot}/
   * If unset, the loader falls back to `/assets/equipment/{slot}/{id}.glb`.
   * gear-overrides.json `file` still wins if present (legacy/per-instance).
   */
  model?: string;
  value: number;
}

export interface NpcDef {
  id: number;
  name: string;
  health: number;
  attack: number;
  defence: number;
  strength: number;
  attackSpeed: number; // ticks between attacks
  respawnTime: number; // ticks
  aggressive: boolean;
  wanderRange: number; // tiles from spawn
  lootTable: LootDrop[];
  /** This NPC offers banking when talked to (right-click → Bank). */
  bankAccess?: boolean;
  /** NPC never moves. Client opts into a static-idle render (no per-frame
   *  animation evaluation) and skips loading walk anims — major mobile win
   *  for shopkeepers/smiths/bankers. */
  stationary?: boolean;
  /** Inline shop. New authoring surface — replaces the legacy shops.json
   *  keyed by NPC id. The DataLoader still reads shops.json as a fallback
   *  for entries not yet migrated. */
  shop?: ShopDef;
  /** Inline dialogue tree. When present, right-clicking the NPC offers a
   *  "Talk-to" option that opens the DialoguePanel with the root node. */
  dialogue?: DialogueTree;
}

export interface ShopItem {
  itemId: number;
  price: number;
  stock: number;
}

export interface ShopDef {
  name: string;
  items: ShopItem[];
}

/** Action triggered when a dialogue option is chosen. Runs server-side
 *  before advancing to `option.next`. Use `closeDialogue` to end the
 *  conversation; omit `next` on the option to also end. */
export type DialogueAction =
  | { type: 'openShop' }
  | { type: 'openBank' }
  | { type: 'giveItem'; itemId: number; qty: number }
  | { type: 'takeItem'; itemId: number; qty: number }
  | { type: 'closeDialogue' };

export interface DialogueOption {
  label: string;
  /** ID of the next node, or omitted to end dialogue. */
  next?: string;
  /** Server-side effect to run when this option is chosen. */
  action?: DialogueAction;
}

export interface DialogueNode {
  id: string;
  /** Override speaker name. Defaults to the NPC's name. */
  speaker?: string;
  /** Lines shown in order; player advances by clicking. */
  lines: string[];
  options: DialogueOption[];
  /** Editor layout — pixel position in the node graph canvas. Persisted
   *  so the graph reopens with the same layout. */
  layout?: { x: number; y: number };
}

export interface DialogueTree {
  /** ID of the starting node. */
  root: string;
  nodes: Record<string, DialogueNode>;
}

export interface LootDrop {
  itemId: number;
  quantity: number;
  chance: number; // 0-1
}

export interface InventorySlot {
  itemId: number;
  quantity: number;
}

export interface TileDef {
  type: TileType;
  elevation?: number;
}

export enum TileType {
  GRASS = 0,
  DIRT = 1,
  STONE = 2,
  WATER = 3, // blocking
  WALL = 4,  // blocking
  SAND = 5,
  WOOD = 6,  // floor
  MUD = 7,   // walkable; distinct from WATER so the minimap can tint it brown
}

export const BLOCKING_TILES = new Set([TileType.WATER, TileType.WALL]);

// --- Edge-based wall system ---

/** Bitmask for wall edges on a tile. Multiple edges can be combined with |. */
export const WallEdge = { N: 1, E: 2, S: 4, W: 8 } as const;
export type WallEdgeMask = number; // 0-15 bitmask

/** Default wall height when not overridden */
export const DEFAULT_WALL_HEIGHT = 1.8;

/** Roof styles */
export type RoofStyle = 'flat' | 'peaked_ns' | 'peaked_ew';

/** Stair direction — the direction you walk to go UP */
export type StairDirection = 'N' | 'E' | 'S' | 'W';

export interface StairData {
  direction: StairDirection;
  baseHeight: number;   // floor height at bottom of stairs
  topHeight: number;    // floor height at top of stairs
}

export interface RoofData {
  height: number;       // Y level of roof plane
  style: RoofStyle;
  peakHeight?: number;  // extra height for peaked roofs (above height)
}

/** Data for a single floor layer (used in multi-floor system) */
export interface FloorLayerData {
  walls: Record<string, number>;              // "x,z" -> edge bitmask
  wallHeights?: Record<string, number>;       // "x,z" -> wall top height (default 1.8 above floor)
  roofs?: Record<string, RoofData>;           // "x,z" -> roof data
  floors?: Record<string, number>;            // "x,z" -> elevated floor height
  stairs?: Record<string, StairData>;         // "x,z" -> stair data
  tiles?: Record<string, number>;             // "x,z" -> tile type override (upper floors only)
  holes?: Record<string, boolean>;            // "x,z" -> terrain hole (ground removed, cave ceiling rendered)
}

/** On-disk format for walls.json — sparse, only tiles with walls/roofs/floors/stairs */
export interface WallsFile extends FloorLayerData {
  /** Additional floor layers (1, 2, ...). Floor 0 is the root level data. */
  floorLayers?: Record<number, FloorLayerData>;
}

// --- World object definition ---

export interface WorldObjectDef {
  id: number;
  name: string;
  category: 'tree' | 'rock' | 'fishingspot' | 'furnace' | 'cookingrange' | 'anvil' | 'altar' | 'door' | 'chest' | 'scenery';
  actions: string[]; // e.g. ["Chop", "Examine"]
  blocking: boolean;
  width: number;
  height: number;
  color: [number, number, number]; // RGB 0-255 for client sprite

  // Harvesting (trees, rocks, fishing)
  skill?: string; // SkillId
  levelRequired?: number;
  xpReward?: number;
  harvestItemId?: number;
  harvestQuantity?: number;
  harvestTime?: number; // ticks per attempt cycle (default 4)
  depletionChance?: number; // 0-1, chance per success
  respawnTime?: number; // ticks after depletion

  // Probability-based harvesting (RS-style): keyed by item ID → [low, high]
  // Each attempt rolls statRandom(level, low, high) against 256
  successChances?: Record<string, [number, number]>;

  // Bonus loot rolled on top of the primary harvest. Each entry rolls
  // independently; misses drop nothing. Items must be stackable (or have
  // inventory room) — the roll is skipped silently if the player is full.
  extraLoot?: Array<{ itemId: number; quantity: number; chance: number }>;

  // Asset id (from the editor asset registry) to display when this object
  // is in its depleted state. Used by chests (closed → open swap) and any
  // other category that wants a visual variant instead of just hiding.
  depletedAssetId?: string;

  // Crafting station recipes (furnace, cooking range)
  recipes?: ObjectRecipe[];

  // Map transition (cave doors, ladders, portals)
  transition?: {
    targetMap: string;
    targetX: number;
    targetZ: number;
  };
}

export interface ObjectRecipe {
  inputItemId: number;
  inputQuantity: number;
  secondInputItemId?: number;   // e.g. tin ore for bronze bars, coal for steel bars
  secondInputQuantity?: number;
  outputItemId: number;
  outputQuantity: number;
  skill: string; // SkillId
  levelRequired: number;
  xpReward: number;
  requiresTool?: string; // e.g. "hammer" — must be in inventory but not consumed
  /** 0..1 chance the recipe yields output. Inputs are consumed regardless. Default 1. */
  successChance?: number;
}

// --- Map metadata types ---

export interface MapTransition {
  tileX: number;
  tileZ: number;
  targetMap: string;
  targetX: number;
  targetZ: number;
}

export interface MapMeta {
  id: string;
  name: string;
  width: number;
  height: number;
  waterLevel: number;
  spawnPoint: { x: number; z: number };
  fogColor: [number, number, number];
  fogStart: number;
  fogEnd: number;
  transitions: MapTransition[];
}

export interface SpawnEntry {
  npcId: number;
  x: number;
  z: number;
  wanderRange?: number;
  /** Per-spawn display name override. When set, the editor + in-world UI
   *  use this instead of the NpcDef's name — so a single "Guard" def can
   *  spawn as "Captain Smith", "Sergeant Vex", etc. */
  name?: string;
  /** Per-spawn aggression override. When omitted, the NpcDef's `aggressive`
   *  flag is used. When set on the spawn, it overrides the def — so a single
   *  map can have a "hostile" Goblin in one biome and a "tame" Goblin in
   *  another from the same NpcDef. Aggressive NPCs auto-target any player
   *  within 3 tiles whose combat level isn't more than 1.2× the NPC's. */
  aggressive?: boolean;
  /** Per-spawn appearance override. When set, this NPC renders as a 3D
   *  CharacterEntity (subject to LOD + concurrent caps) using these colors,
   *  hair, and skin. Two NPCs of the same npcId can look different. */
  appearance?: PlayerAppearance;
  /** Per-spawn equipment. 10-slot array matching PLAYER_REMOTE_EQUIPMENT
   *  layout: [weapon, shield, head, body, legs, neck, ring, hands, feet, cape].
   *  0 = empty slot. Only meaningful when `appearance` is also set (the GLB
   *  gear pipeline only runs on CharacterEntity-rendered NPCs). */
  equipment?: number[];
  /** Per-spawn shop override. When set, fully replaces NpcDef.shop for
   *  this spawn (no field-merge). Lets two spawns of the same NpcDef sell
   *  different inventory. */
  shop?: ShopDef;
  /** Per-spawn dialogue override. When set, fully replaces NpcDef.dialogue. */
  dialogue?: DialogueTree;
}

export interface ObjectSpawnEntry {
  objectId: number;
  x: number;
  z: number;
}

export interface SpawnedItem {
  itemId: number;
  quantity?: number;
  x: number;
  z: number;
}

export interface SpawnsFile {
  npcs: SpawnEntry[];
  objects?: ObjectSpawnEntry[];
  items?: SpawnedItem[];
}

// --- Biomes ---

/** Biome cells are painted in 8x8 tile blocks. */
export const BIOME_CELL_SIZE = 1;

export interface BiomeDef {
  id: number;
  name: string;
  fogColor: [number, number, number]; // RGB 0-1
  fogStart: number;
  fogEnd: number;
}

/** On-disk format for biomes.json — per-map biome defs + sparse cell grid. */
export interface BiomesFile {
  defs: BiomeDef[];
  /** "cellX,cellZ" -> biome id. Missing cells fall back to map meta fog. */
  cells: Record<string, number>;
}

// --- KC Map Editor format types ---

export type GroundType = 'grass' | 'dirt' | 'sand' | 'path' | 'road' | 'water' | 'desert' | 'sandstone' | 'rock' | 'drysand' | 'dungeon-floor' | 'dungeon-rock';
export type SplitDirection = 'forward' | 'back';

export interface KCTile {
  ground: GroundType;
  groundB: GroundType | null;
  split: SplitDirection;
  textureId: string | null;
  textureRotation: number;
  textureScale: number;
  textureWorldUV: boolean;
  textureHalfMode: boolean;
  textureIdB: string | null;
  textureRotationB: number;
  textureScaleB: number;
  waterPainted: boolean;
  waterSurface: boolean;
}

export interface TexturePlane {
  id: string;
  textureId: string;
  width: number;
  height: number;
  vertical: boolean;
  doubleSided: boolean;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  uvRepeat: number;
  texRotation: number;
  tintColor?: { r: number; g: number; b: number }; // RGB 0-1, default white
  noRoof?: boolean; // If true, never treated as a roof/ceiling for indoor detection
}

export interface PlacedObject {
  assetId: string;
  layerId: string;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  /** Per-instance trigger override (e.g. teleport doors authored in the editor) */
  trigger?: { type: string; destChunk: string; entryX: number; entryY: number; entryZ: number };
}

export interface EditorLayer {
  id: string;
  name: string;
  visible: boolean;
}

/** The KC map data stored in map.json */
export interface KCMapData {
  width: number;
  height: number;
  waterLevel: number;
  chunkWaterLevels: Record<string, number>;
  texturePlanes: TexturePlane[];
  tiles: KCTile[][];       // [z][x]
  heights: number[][];     // [z][x] vertex heights, (height+1) x (width+1)
  activeChunks?: string[];
}

/** Full map.json file format (KC editor save) */
export interface KCMapFile {
  map: KCMapData;
  placedObjects: PlacedObject[];
  layers: EditorLayer[];
  activeLayerId: string;
}

/** Default KC tile */
export function defaultKCTile(ground: GroundType = 'grass'): KCTile {
  return {
    ground,
    groundB: null,
    split: 'forward',
    textureId: null,
    textureRotation: 0,
    textureScale: 1,
    textureWorldUV: false,
    textureHalfMode: false,
    textureIdB: null,
    textureRotationB: 0,
    textureScaleB: 1,
    waterPainted: false,
    waterSurface: false,
  };
}

/** Map KC ground type to game TileType (for collision/pathfinding) */
export function groundTypeToTileType(ground: GroundType): TileType {
  switch (ground) {
    case 'grass': return TileType.GRASS;
    case 'dirt':  return TileType.DIRT;
    case 'sand':  return TileType.SAND;
    case 'path':  return TileType.DIRT;
    case 'road':      return TileType.STONE;
    // The editor exposes 'water' GroundType as the "Mud" swatch — actual water
    // surfaces use waterPainted / waterSurface / heightmap-below-waterLevel
    // and get TileType.WATER via shouldTileRenderWater() before this fallback.
    case 'water':     return TileType.MUD;
    case 'desert':    return TileType.SAND;
    case 'sandstone': return TileType.STONE;
    case 'rock':      return TileType.STONE;
    case 'drysand':   return TileType.SAND;
    default:          return TileType.GRASS;
  }
}

/**
 * Classify a KC tile into a game-side TileType (used for collision + minimap).
 *
 * The editor's overworld "Mud" swatch sets `waterPainted = true` while leaving
 * `ground` unchanged, so we must NOT treat every `waterPainted` tile as real
 * water. Only heightmap-submerged tiles (terrain ≤ waterLevel) are real water;
 * everything else painted as water is mud.
 */
export function classifyTileType(
  tile: KCTile,
  cornerHeights: { tl: number; tr: number; bl: number; br: number },
  waterLevel: number,
): TileType {
  const minH = Math.min(cornerHeights.tl, cornerHeights.tr, cornerHeights.bl, cornerHeights.br);
  if (minH <= waterLevel) return TileType.WATER;
  if (tile.waterPainted) return TileType.MUD;
  return groundTypeToTileType(tile.ground);
}

/** Check if a KC tile should render water (height-based or painted) */
export function shouldTileRenderWater(
  tile: KCTile,
  cornerHeights: { tl: number; tr: number; bl: number; br: number },
  waterLevel: number,
): boolean {
  if (tile.waterPainted) return true;
  const minH = Math.min(cornerHeights.tl, cornerHeights.tr, cornerHeights.bl, cornerHeights.br);
  return minH <= waterLevel;
}
