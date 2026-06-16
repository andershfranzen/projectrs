import type { PlayerAppearance } from './appearance';
import type { EquipSlot } from './equipment';
import type { MinimapMarker } from './minimapIcons';
import type { NpcEquipmentFitOverrides } from './npcEquipmentFit';
import type { SkillId } from './skills';

// Keep this in sync with tileCut.ts DEFAULT_CUT_ANGLE. Avoid importing it here
// because this base type module is pulled into broad client and website bundles.
const DEFAULT_TEXTURE_CUT_ANGLE = (3 * Math.PI) / 4;

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

export const NPC_VISUAL_SCALE_DEFAULT = 1;
export const NPC_VISUAL_SCALE_MIN = 0.1;
export const NPC_VISUAL_SCALE_MAX = 8;
export const NPC_VISUAL_SCALE_WIRE_MULTIPLIER = 100;

export function normalizeNpcVisualScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return NPC_VISUAL_SCALE_DEFAULT;
  return Math.max(NPC_VISUAL_SCALE_MIN, Math.min(NPC_VISUAL_SCALE_MAX, value));
}

export function shouldPersistNpcVisualScale(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && Math.abs(normalizeNpcVisualScale(value) - NPC_VISUAL_SCALE_DEFAULT) > 0.0001;
}

export function encodeNpcVisualScale(scale: number): number {
  return Math.round(normalizeNpcVisualScale(scale) * NPC_VISUAL_SCALE_WIRE_MULTIPLIER);
}

export function decodeNpcVisualScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NPC_VISUAL_SCALE_DEFAULT;
  return normalizeNpcVisualScale(value / NPC_VISUAL_SCALE_WIRE_MULTIPLIER);
}

export const HEAD_RENDER_MODES = ['helmet', 'hat', 'hairTuck', 'hairFit'] as const;
export type HeadRenderMode = typeof HEAD_RENDER_MODES[number];
export type ItemToolType = 'axe' | 'pickaxe' | 'hammer' | 'fishing_net' | 'fishing_rod' | 'harpoon';

export interface ItemDef {
  id: number;
  name: string;
  description: string;
  /** Quest-only items cannot be sold, traded, staked, or dropped to other players. */
  questItem?: boolean;
  stackable: boolean;
  /** OSRS-style banking: unnoted item can withdraw as a stackable paper note. */
  noteable?: boolean;
  /** Item id of the generated/specified noted variant for this unnoted item. */
  noteId?: number;
  /** Item id of the canonical item this noted variant represents. */
  unnotedId?: number;
  equippable: boolean;
  equipSlot?: EquipSlot;
  /**
   * Equipment slots this item occupies while worn. Defaults to `[equipSlot]`.
   * `twoHanded` weapons still imply `['weapon', 'shield']` for legacy items.
   */
  occupiesSlots?: EquipSlot[];
  /**
   * For `equipSlot === 'body'` items only — how much of the character's bare
   * skin to hide while equipped.
   *   - 'plate' (default): hide the bare-chest geometry AND arm triangles on
   *     the skin mesh. Matches plate/full body armor that has its own sleeves.
   *   - 'chain': hide only the bare-chest geometry. Arms, shoulders, and lower
   *     neck stay visible (RuneScape-style chainbody/sleeveless aesthetic).
   */
  bodyHideStyle?: 'plate' | 'chain';
  /**
   * For `equipSlot === 'head'` items only — how the character head/hair should
   * render while the gear is equipped.
   *   - 'helmet' (default): hide head and hair; used by closed helmets.
   *   - 'hat': keep the normal head and hair visible; used by open hats that
   *     rest on top of the hairstyle.
   *   - 'hairTuck': keep the face visible but tuck hair into a compact shape.
   *   - 'hairFit': keep the face and hair visible; per-item gear override data
   *     controls how the hairstyle is compressed to fit under the headgear.
   */
  headRenderMode?: HeadRenderMode;
  attackSpeed?: number;
  attackRange?: number;
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
  // Equipment requirements
  equipSkill?: SkillId;
  levelRequired?: number;
  // Tool properties (axes, pickaxes, hammers, fishing tools)
  toolType?: ItemToolType;
  toolLevel?: number;
  toolBonus?: number;
  // Visual
  sprite?: string;
  icon?: string;
  /**
   * Equipment/ground-item GLB filename or path. Resolved by the gear loader as:
   *   - starts with '/' → used as-is (absolute path under client/public)
   *   - otherwise → resolved relative to /assets/equipment/{equipSlot}/
   * If unset, the item is rendered in world space with its 2D icon/sprite only.
   * gear-overrides.json `file` still wins if present (legacy/per-instance).
   */
  model?: string;
  /**
   * Inventory-thumbnail-only GLB path. Use this when the icon needs a 3D
   * render but the item should not use that model as a ground/world object.
   */
  thumbnailModel?: string;
  /**
   * Optional visual-only model variants for stackable items. The highest
   * minQuantity not greater than the stack quantity is used for inventory
   * thumbnails and ground-item models.
   */
  stackModels?: Array<{
    minQuantity: number;
    model: string;
    scale?: number;
  }>;
  /**
   * Optional visual-only equipment model variants by character body type.
   * The item id, stats, inventory icon, and server behavior stay unchanged;
   * only the equipped 3D model path changes. Key "1" is the female body.
   */
  bodyTypeModels?: Record<string, string>;
  value: number;
}

export function isHighQualityItem(def: Pick<ItemDef, 'name'> | null | undefined): boolean {
  return typeof def?.name === 'string' && def.name.endsWith(' (HQ)');
}

export interface NpcDef {
  id: number;
  name: string;
  examineText?: string;
  /** Optional render/profile alias. Lets authored variants reuse the 3D model
   *  or humanoid profile registered for another NPC id without adding code. */
  modelNpcId?: number;
  /** Default humanoid appearance copied onto newly authored spawns and used
   *  server-side when a spawn has no per-spawn appearance override. */
  defaultAppearance?: PlayerAppearance;
  /** Default equipment in PLAYER_REMOTE_EQUIPMENT layout:
   *  [weapon, shield, head, body, legs, neck, ring, hands, feet, cape, ammo].
   *  Humanoid NPCs use the CharacterEntity gear pipeline. Purpose-built 3D
   *  NPCs only render slots that have a client-side NPC gear attachment config.
   *  Per-spawn `equipment` still wins when present. */
  defaultEquipment?: number[];
  /** Default raw color overrides for CharacterEntity-rendered NPCs. */
  defaultCustomColors?: CustomColors;
  /** Default swing animation override for CharacterEntity-rendered NPCs. */
  defaultAttackAnim?: string;
  health: number;
  attack: number;
  defence: number;
  strength: number;
  /** Optional authored combat level for display, relic tiering, and aggro checks.
   *  When omitted, the level is derived from health/attack/defence/strength. */
  combatLevel?: number;
  /** OSRS-style combat bonuses. All default to 0 so legacy flat stat NPCs keep
   *  their current behavior. Negative values are valid for weak NPCs. */
  attackBonus?: number;
  strengthBonus?: number;
  stabDefence?: number;
  slashDefence?: number;
  crushDefence?: number;
  rangedDefence?: number;
  magicDefence?: number;
  /** Melee style this NPC uses when attacking players. Omitted defs keep
   *  legacy average-defence targeting in server combat. */
  attackStyle?: 'stab' | 'slash' | 'crush';
  attackSpeed: number; // ticks between attacks
  respawnTime: number; // ticks
  aggressive: boolean;
  wanderRange: number; // tiles from spawn
  /** Spawn-anchored combat leash. Defaults to wanderRange + 2, matching the
   *  common 2004Scape data pattern. */
  maxRange?: number;
  /** Proactive acquisition radius around the NPC. Defaults to maxRange. */
  huntRange?: number;
  /** NPC attack approach range for AP-style ranged/magic modes. Melee NPCs
   *  leave this at 0 and use maxRange + 1 for leash validation. */
  attackRange?: number;
  /** Low-HP flee threshold. When > 0 and current HP is at/below this value,
   *  retaliation switches to PLAYERESCAPE-style fleeing. */
  retreatHealth?: number;
  lootTable: LootDrop[];
  /** Optional OSRS-style shared rare-table access rolls. Each entry gates
   *  access to a server-side weighted table; normal lootTable drops still
   *  roll independently. */
  rareDropTables?: NpcRareDropTableRoll[];
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
  /** Public-data hint used when shop contents are stripped from /data/npcs.json. */
  hasShop?: boolean;
  /** Inline dialogue tree. When present, right-clicking the NPC offers a
   *  "Talk-to" option that opens the DialoguePanel with the root node. */
  dialogue?: DialogueTree;
  /** OSRS-style NxN tile footprint. Default 1. Even sizes are centered around
   *  the placed coordinate, and odd sizes center on the containing tile
   *  (matches `getObjectFootprintTiles` in objectFootprint.ts).
   *  Pathfinding, blocking, and wall checks all consider the full footprint. */
  size?: number;
}

export interface ShopItem {
  itemId: number;
  price: number;
  stock: number;
}

export interface ShopDef {
  name: string;
  /** Ticks between restoring one missing stock unit. Defaults server-side
   *  when omitted; 0 disables automatic restock. */
  restockTicks?: number;
  items: ShopItem[];
}

/** Action triggered when a dialogue option is chosen. Runs server-side
 *  before advancing to `option.next`. Use `closeDialogue` to end the
 *  conversation; omit `next` on the option to also end. */
export type DialogueAction =
  | { type: 'openShop' }
  | { type: 'openBank' }
  | { type: 'openAppearance' }
  | { type: 'giveItem'; itemId: number; qty: number }
  | { type: 'takeItem'; itemId: number; qty: number }
  | { type: 'grantXp'; skill: SkillId; amount: number }
  | { type: 'bankInventoryItemsForCoins'; itemIds: number[]; coinCost: number; itemLabel?: string; coinCostByItemId?: Record<string, number> }
  | {
      type: 'buyQuestItem';
      itemId: number;
      coinCost: number;
      qty?: number;
      questId?: string;
      minStage?: number;
      maxStage?: number;
      unique?: boolean;
      successMessage?: string;
      notEnoughCoinsMessage?: string;
      alreadyHasMessage?: string;
      wrongStageMessage?: string;
      noRoomMessage?: string;
    }
  | { type: 'closeDialogue' }
  | { type: 'setQuestStage'; questId: string; stage: number }
  | { type: 'setQuestVar'; questId: string; key: string; value: number }
  | { type: 'completeQuest'; questId: string }
  | { type: 'startNpcCombat' };

export type QuestCondition =
  | { type: 'all'; conditions: QuestCondition[] }
  | { type: 'any'; conditions: QuestCondition[] }
  | { type: 'not'; condition: QuestCondition }
  | { type: 'questStage'; questId: string; minStage?: number; maxStage?: number }
  | { type: 'questStarted'; questId: string }
  | { type: 'questNotStarted'; questId: string }
  | { type: 'questCompleted'; questId: string }
  | { type: 'questVar'; questId: string; key: string; value?: number; min?: number; max?: number }
  | { type: 'hasItem'; itemId: number; quantity?: number }
  | { type: 'hasEquippedItem'; itemId: number }
  | { type: 'skillLevel'; skill: SkillId; level: number }
  | { type: 'combatLevel'; level: number };

/** Gating condition on a dialogue option. When `requires` is set, the
 *  server only emits the option to the client if the player satisfies it.
 *  `minStage` defaults to the smallest stage; `maxStage` defaults to one
 *  less than the quest's stage count (i.e. before completion). `notStarted`
 *  shows the option only when the player has no progress on this quest. */
export interface DialogueOptionRequires {
  questId: string;
  minStage?: number;
  maxStage?: number;
  notStarted?: boolean;
}

export interface DialogueOption {
  label: string;
  /** ID of the next node, or omitted to end dialogue. */
  next?: string;
  /** When following `next`, show only the target node's filtered choices.
   *  Options labelled "Back" or "Back." do this automatically server-side;
   *  this flag is for non-Back navigation options that need the same UX. */
  nextChoicesOnly?: boolean;
  /** Do not show this option label as an overhead player reply. "Back" and
   *  "Back." options with `next` are silent automatically server-side. */
  silent?: boolean;
  /** Server-side effect to run when this option is chosen. Legacy shorthand
   *  for one entry in `actions`; both can be present and run in order. */
  action?: DialogueAction;
  /** Server-side effects to run when this option is chosen. */
  actions?: DialogueAction[];
  /** Hide this option unless the player's quest state matches. */
  requires?: DialogueOptionRequires;
  /** Generic authoring predicates. `conditions` is an implicit all(). */
  condition?: QuestCondition;
  conditions?: QuestCondition[];
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
  /** Optional first-match routing for stage-specific greetings. */
  rootConditions?: Array<{ condition: QuestCondition; node: string }>;
  nodes: Record<string, DialogueNode>;
}

export interface LootDrop {
  itemId: number;
  quantity: number;
  chance: number; // 0-1
}

export interface NpcRareDropTableRoll {
  tableId: string;
  chance: number; // 0-1 chance to access this table per kill
  rolls?: number;
}

export interface RareDropTableDef {
  id: string;
  name?: string;
  entries: RareDropTableEntry[];
}

export type RareDropTableEntry =
  | RareDropItemEntry
  | RareDropNothingEntry
  | RareDropSubtableEntry;

export interface RareDropWeightedEntry {
  weight: number;
}

export interface RareDropItemEntry extends RareDropWeightedEntry {
  type: 'item';
  itemId: number;
  /** Fixed quantity. Defaults to 1 when omitted. */
  quantity?: number;
  /** Inclusive range. Used only when quantity is omitted. */
  minQuantity?: number;
  maxQuantity?: number;
}

export interface RareDropNothingEntry extends RareDropWeightedEntry {
  type: 'nothing';
}

export interface RareDropSubtableEntry extends RareDropWeightedEntry {
  type: 'table';
  tableId: string;
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
  /** Additional non-zero floor layers. Floor 0 is the root level data. */
  floorLayers?: Record<number, FloorLayerData>;
}

// --- World object definition ---

export interface WorldObjectDef {
  id: number;
  name: string;
  category: 'tree' | 'rock' | 'fishingspot' | 'furnace' | 'cookingrange' | 'anvil' | 'altar' | 'obelisk' | 'door' | 'ladder' | 'chest' | 'crop' | 'bank' | 'stall' | 'sign' | 'scenery';
  actions: string[]; // e.g. ["Chop", "Examine"]
  blocking: boolean;
  /** Tile footprint width in local X. */
  width: number;
  /** Optional tile footprint depth in local Z. Defaults to width for square objects. */
  depth?: number;
  /** Visual height in world units. */
  height: number;
  color: [number, number, number]; // RGB 0-255 for client sprite
  examineText?: string;
  /** Editor asset id used for runtime-spawned object visuals. */
  modelAssetId?: string;

  // Harvesting (trees, rocks, fishing)
  skill?: string; // SkillId
  levelRequired?: number;
  xpReward?: number;
  harvestItemId?: number;
  harvestQuantity?: number;
  harvestTime?: number; // ticks per attempt cycle (default 4)
  /** Client animation name to play for harvest testing/specialized skill loops. */
  skillAnimation?: 'chop' | 'mine' | 'fish_net' | 'fish_rod' | 'fish_harpoon' | string;
  /** Item model to temporarily show in-hand while this harvest action runs. */
  visualToolItemId?: number;
  depletionChance?: number; // 0-1, chance per success
  respawnTime?: number; // ticks after depletion
  harvestOptions?: Array<{
    levelRequired: number;
    xpReward: number;
    harvestItemId: number;
    harvestQuantity?: number;
    weight?: number;
  }>;

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

  // For roguery stalls, the reusable NPC definition that owns the matching
  // merchant shop. Editor-only metadata; runtime interaction still uses the
  // placed object's stall loot table.
  stallMerchantNpcId?: number;

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
  /** Optional rare high-quality output. When rolled, replaces outputItemId and multiplies XP. */
  hqOutputItemId?: number;
  /** 0..1 chance to yield hqOutputItemId instead of outputItemId. */
  hqChance?: number;
  /** XP multiplier applied only when hqOutputItemId rolls. */
  hqXpMultiplier?: number;
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
  mapType?: 'overworld' | 'dungeon';
  dungeon?: boolean;
  width: number;
  height: number;
  waterLevel: number;
  spawnPoint: { x: number; z: number };
  fogColor: [number, number, number];
  fogStart: number;
  fogEnd: number;
  skybox?: SkyboxConfig;
  transitions: MapTransition[];
}

export interface SpawnEntry {
  npcId: number;
  x: number;
  z: number;
  /** Authoritative floor for this spawn. Omitted legacy spawns are floor 0. */
  floor?: number;
  /** Optional authored world Y, used to infer floor when floor is omitted. */
  y?: number;
  wanderRange?: number;
  maxRange?: number;
  huntRange?: number;
  attackRange?: number;
  retreatHealth?: number;
  /** Initial yaw in radians. 0 faces +Z, π/2 faces +X. Mainly used for
   *  stationary NPCs; walking/combat can override it at runtime. */
  facing?: number;
  /** Per-spawn display name override. When set, the editor + in-world UI
   *  use this instead of the NpcDef's name — so a single "Guard" def can
   *  spawn as "Captain Smith", "Sergeant Vex", etc. */
  name?: string;
  /** Per-spawn aggression override. When omitted, the NpcDef's `aggressive`
   *  flag is used. When set on the spawn, it overrides the def — so a single
   *  map can have a "hostile" Goblin in one biome and a "tame" Goblin in
   *  another from the same NpcDef. Aggressive NPCs hunt within `huntRange`
   *  and stay leashed by spawn-anchored `maxRange`; unset ranges use the
   *  2004Scape-style defaults from the NPC definition. */
  aggressive?: boolean;
  /** Per-spawn appearance override. When set, this NPC renders as a 3D
   *  CharacterEntity (subject to LOD + concurrent caps) using these colors,
   *  hair, and skin. Two NPCs of the same npcId can look different. */
  appearance?: PlayerAppearance;
  /** Per-spawn equipment. 11-slot array matching PLAYER_REMOTE_EQUIPMENT
   *  layout: [weapon, shield, head, body, legs, neck, ring, hands, feet, cape, ammo].
   *  0 = empty slot. Humanoid NPCs use the CharacterEntity gear pipeline.
   *  Purpose-built 3D NPCs only render slots that have a client-side NPC gear
   *  attachment config. */
  equipment?: number[];
  /** Per-spawn visual fit overrides for purpose-built 3D NPC equipment.
   *  Keys are equip slot names. These merge over the client-side model gear
   *  config and only affect rendering, not combat/pathing/equipment state. */
  equipmentFits?: NpcEquipmentFitOverrides;
  /** Per-spawn shop override. When set, fully replaces NpcDef.shop for
   *  this spawn (no field-merge). Lets two spawns of the same NpcDef sell
   *  different inventory. */
  shop?: ShopDef;
  /** Per-spawn dialogue override. When set, fully replaces NpcDef.dialogue. */
  dialogue?: DialogueTree;
  /** Allows Attack to appear and resolve directly even when this spawn also
   *  has dialogue. Use for hostile NPCs that can talk, not protected quest NPCs
   *  whose dialogue action must advance state before combat. */
  directAttack?: boolean;
  /** Optional per-player visibility gate for quest-only NPCs. */
  visibilityCondition?: QuestCondition;
  /** Per-spawn combat stat overrides. Any field set here wins over the
   *  NpcDef's value (HP, attack, defence, strength, attackSpeed, respawnTime).
   *  Missing fields fall through to the def. Lets a single "Guard" def spawn
   *  as a weak militia in one place and an elite captain in another. */
  stats?: NpcStatOverrides;
  /** Per-spawn raw RGB color overrides. Each slot, when set, replaces the
   *  palette-index lookup in CharacterEntity.applyAppearance. Only consulted
   *  when `appearance` is set (gear/colors only apply to CharacterEntity-rendered
   *  NPCs). Values are linear 0..1 RGB triplets. */
  customColors?: CustomColors;
  /** Per-spawn attack animation override. When set, this NPC's swing uses
   *  this animation name (e.g. `attack_2h_smash`, `kick`, `stab`) regardless
   *  of the weapon equipped. Useful for unarmed bruisers, scripted bosses,
   *  or any NPC whose visual flair shouldn't be derived from inventory.
   *  Must match a name loaded by EntityManager — the NPC_COMBAT_ANIMATIONS
   *  list in shared/character.ts. CharacterEntity-rendered NPCs only. */
  attackAnim?: string;
  /** Visual-only scale multiplier for this spawn. Does not change the NPC's
   *  gameplay footprint; use NpcDef.size for pathing/combat size. */
  scale?: number;
}

export interface NpcStatOverrides {
  health?: number;
  attack?: number;
  defence?: number;
  strength?: number;
  combatLevel?: number;
  attackBonus?: number;
  strengthBonus?: number;
  stabDefence?: number;
  slashDefence?: number;
  crushDefence?: number;
  rangedDefence?: number;
  magicDefence?: number;
  attackStyle?: 'stab' | 'slash' | 'crush';
  attackSpeed?: number;
  respawnTime?: number;
}

/** Per-slot raw RGB. Keys mirror `AppearanceColorSlot` so callers can index
 *  directly with the same slot string used everywhere else (`appearance[slot]`,
 *  `APPEARANCE_MATERIAL_MAP[slot]`, …) — no mapping function needed. */
export interface CustomColors {
  skinColor?:  [number, number, number];
  shirtColor?: [number, number, number];
  pantsColor?: [number, number, number];
  shoesColor?: [number, number, number];
  beltColor?:  [number, number, number];
  hairColor?:  [number, number, number];
}

/** Canonical wire order for `NPC_CUSTOM_COLORS`. Single source of truth shared
 *  by the server encoder and the client decoder, so adding a new slot is one
 *  edit instead of three. */
export const CUSTOM_COLOR_SLOTS: readonly (keyof CustomColors)[] = [
  'skinColor', 'shirtColor', 'pantsColor', 'shoesColor', 'beltColor', 'hairColor',
] as const;

export interface ObjectSpawnEntry {
  objectId: number;
  x: number;
  z: number;
  floor?: number;
  y?: number;
  rotY?: number;
}

export interface SpawnedItem {
  /** Stable editor-authored source id. Older maps may omit this. */
  id?: number;
  itemId: number;
  quantity?: number;
  /** Optional respawn delay in ticks after pickup. Omitted/0 means no timed respawn. */
  respawnTime?: number;
  x: number;
  z: number;
  floor?: number;
  y?: number;
}

export interface SpawnsFile {
  npcs: SpawnEntry[];
  objects?: ObjectSpawnEntry[];
  items?: SpawnedItem[];
}

// --- Biomes ---

/** Biome cells are painted in 8x8 tile blocks. */
export const BIOME_CELL_SIZE = 1;

export interface SkyboxConfig {
  /** Solid sky dome color, RGB 0-1. Sun position is fixed at world east. */
  color: [number, number, number];
  /** Whether to render the fixed east sun. Defaults to true for legacy data. */
  showSun?: boolean;
}

export interface BiomeDef {
  id: number;
  name: string;
  fogColor: [number, number, number]; // RGB 0-1
  fogStart: number;
  fogEnd: number;
  skybox?: SkyboxConfig;
}

/** On-disk format for biomes.json — per-map biome defs + sparse cell grid. */
export interface BiomesFile {
  defs: BiomeDef[];
  /** "cellX,cellZ" -> biome id. Missing cells fall back to map meta fog. */
  cells: Record<string, number>;
}

// --- KC Map Editor format types ---

export type GroundType =
  | 'grass' | 'dirt' | 'sand' | 'path' | 'road' | 'water'
  | 'desert' | 'sandstone' | 'rock' | 'drysand'
  | 'dungeon-floor' | 'dungeon-stone' | 'dungeon-slate' | 'dungeon-rubble' | 'dungeon-basalt' | 'dungeon-moss' | 'dungeon-torchlight'
  | 'dungeon-rock' | 'dungeon-grey-rock' | 'dungeon-dark-rock'
  | 'void';
export type SplitDirection = 'forward' | 'back';

/** Apparent world-space direction for animated water. X is east/west, Z is
 *  south/north. The default preserves the legacy texture-scroll direction. */
export interface WaterFlow {
  x: number;
  z: number;
}

export const DEFAULT_WATER_FLOW: WaterFlow = Object.freeze({ x: -1, z: -0.5 });

export function normalizeWaterFlow(flow: Partial<WaterFlow> | null | undefined): WaterFlow {
  const x = typeof flow?.x === 'number' && Number.isFinite(flow.x) ? flow.x : DEFAULT_WATER_FLOW.x;
  const z = typeof flow?.z === 'number' && Number.isFinite(flow.z) ? flow.z : DEFAULT_WATER_FLOW.z;
  const len = Math.hypot(x, z);
  if (len < 0.0001) return { ...DEFAULT_WATER_FLOW };
  return { x: x / len, z: z / len };
}

export interface WaterFlowUvTransform {
  c: number;
  s: number;
  invScale: number;
}

export type WaterFlowQuadUvOrder = 'tl-tr-br-bl' | 'tl-tr-bl-br';

/** Precompute the rotation used to make the shared animated water texture
 *  appear to flow in a world-space direction. Build this once per flow/chunk. */
export function waterFlowUvTransform(flow: Partial<WaterFlow> | null | undefined, scale: number = 5): WaterFlowUvTransform {
  const desired = normalizeWaterFlow(flow);
  const base = normalizeWaterFlow(DEFAULT_WATER_FLOW);
  const theta = Math.atan2(desired.z, desired.x) - Math.atan2(base.z, base.x);
  return { c: Math.cos(theta), s: Math.sin(theta), invScale: 1 / scale };
}

/** Rotate world-space UVs using a precomputed water flow transform. */
export function waterFlowUvFromTransform(worldX: number, worldZ: number, transform: WaterFlowUvTransform): [number, number] {
  const { c, s, invScale } = transform;
  return [
    (c * worldX + s * worldZ) * invScale,
    (-s * worldX + c * worldZ) * invScale,
  ];
}

/** Rotate world-space UVs so the shared water texture animation appears to
 *  move in the selected world direction while keeping one animated texture. */
export function waterFlowUv(worldX: number, worldZ: number, flow: Partial<WaterFlow> | null | undefined, scale: number = 5): [number, number] {
  return waterFlowUvFromTransform(worldX, worldZ, waterFlowUvTransform(flow, scale));
}

/** Append UVs for one tile in the caller's vertex order. This avoids repeated
 *  trig and temporary tuple allocation in water mesh builders. */
export function pushWaterFlowQuadUvs(
  out: number[],
  worldX: number,
  worldZ: number,
  transform: WaterFlowUvTransform,
  order: WaterFlowQuadUvOrder = 'tl-tr-br-bl',
): void {
  const { c, s, invScale } = transform;
  const x0 = worldX;
  const x1 = worldX + 1;
  const z0 = worldZ;
  const z1 = worldZ + 1;

  const tlU = (c * x0 + s * z0) * invScale;
  const tlV = (-s * x0 + c * z0) * invScale;
  const trU = (c * x1 + s * z0) * invScale;
  const trV = (-s * x1 + c * z0) * invScale;
  const brU = (c * x1 + s * z1) * invScale;
  const brV = (-s * x1 + c * z1) * invScale;
  const blU = (c * x0 + s * z1) * invScale;
  const blV = (-s * x0 + c * z1) * invScale;

  if (order === 'tl-tr-bl-br') {
    out.push(tlU, tlV, trU, trV, blU, blV, brU, brV);
  } else {
    out.push(tlU, tlV, trU, trV, brU, brV, blU, blV);
  }
}

/** Numeric IDs for GroundType — used to pack ground type into a Uint8Array
 *  for the minimap snapshot. Order is stable; insert new types at the end. */
export const GROUND_TYPES_BY_ID: readonly GroundType[] = [
  'grass', 'dirt', 'sand', 'path', 'road', 'water',
  'desert', 'sandstone', 'rock', 'drysand', 'dungeon-floor', 'dungeon-rock', 'void',
  'dungeon-stone', 'dungeon-slate', 'dungeon-rubble', 'dungeon-basalt', 'dungeon-moss',
  'dungeon-grey-rock', 'dungeon-dark-rock', 'dungeon-torchlight',
];
export const GROUND_TYPE_ID: Record<GroundType, number> = Object.freeze(
  Object.fromEntries(GROUND_TYPES_BY_ID.map((g, i) => [g, i])) as Record<GroundType, number>,
);
/** Sentinel for "no ground data" (e.g. tile outside the map or in an
 *  unloaded chunk). Minimap callers treat this as "fall through to tileType". */
export const GROUND_TYPE_NONE = 0xff;

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
  /**
   * Angle of the cut LINE (radians, in [0, π) — the line is undirected) used
   * to split this tile's texture overlay into two halves when textureHalfMode
   * is true. 0 = horizontal cut, π/4 = TL-BR diagonal, π/2 = vertical cut,
   * 3π/4 = BL-TR diagonal. Independent of tile.split (which only affects
   * terrain triangulation).
   */
  textureCutAngle: number;
  /** Signed half-paint cut offset in tile UV units. Positive makes half A larger. */
  textureCutOffset: number;
  waterPainted: boolean;
  waterSurface: boolean;
  waterSurfaceB: boolean;
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
  textureHalfMode?: boolean;
  textureCutAngle?: number;
  tintColor?: { r: number; g: number; b: number }; // RGB 0-1, default white
  noRoof?: boolean; // If true, never treated as a roof/ceiling for indoor detection
  bridge?: boolean; // If true, snap as a floor-0 bridge regardless of terrain classification
}

export interface PlacedObjectStallLootEntry {
  itemId: number;
  quantity?: number;
  /** Absolute chance from 0-1. Totals over 1 are normalized as weights. */
  chance: number;
  /** Optional per-entry XP override. Falls back to the stall object's xpReward. */
  xpReward?: number;
}

export interface PlacedObject {
  assetId: string;
  layerId: string;
  /** Optional per-instance name used by quest authoring/triggers. */
  name?: string;
  /** Optional per-instance examine text. Falls back to object definition text. */
  examineText?: string;
  /** Optional per-instance text read aloud by the player when using a sign. */
  signText?: string;
  /** Optional per-action effects for this specific placed object. */
  interactions?: PlacedObjectInteraction[];
  /** Door instances with this enabled start open and auto-reset back open after being closed. */
  defaultOpen?: boolean;
  /** Door open pose direction. -1 preserves the legacy swing, 1 opens the opposite way. */
  openDirection?: -1 | 1;
  /** Door instances with this enabled refuse normal Open unless the player has the required key item. */
  locked?: boolean;
  /** Optional item id required to open a locked door. If omitted, the door cannot be opened by normal interaction. */
  keyItemId?: number;
  /** If true, consumes one key item when the door is opened. */
  consumeKey?: boolean;
  /** Optional private message shown when a player tries to open the door without the key. */
  lockedMessage?: string;
  /** If true, this roof-like placed object never triggers indoor / roof-culling behavior. */
  noRoof?: boolean;
  /** Good-magic altar tier. Determines which relic tier can be sacrificed here. */
  altarTier?: number;
  /** Per-instance stall reward table. Chance is 0-1; totals below 1 leave a no-loot chance. */
  stallLoot?: PlacedObjectStallLootEntry[];
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  /** Per-instance trigger override (e.g. teleport doors authored in the editor) */
  trigger?: { type: string; destChunk: string; entryX: number; entryY: number; entryZ: number };
  /** Explicit server-authoritative vertical links for ladders/stairs/etc.
   *  These replace runtime inference from nearby texture planes. */
  verticalLinks?: PlacedObjectVerticalLink[];
  /** Exact local tile offsets the player may stand on to use this object.
   *  When present, these override interactionSides and normal adjacency. */
  interactionTiles?: { x: number; z: number }[];
  /** Bitmask of allowed interaction tiles in OBJECT-LOCAL frame.
   *  For width W and depth D this is a 2*W+2*D-bit perimeter mask around the
   *  footprint; bit 0 starts at local +Z/front-left. 0 / undefined = any adjacent tile. */
  interactionSides?: number;
}

export interface PlacedObjectVerticalLinkEndpoint {
  /** Optional map override. Omitted means the placed object's map. */
  mapId?: string;
  x: number;
  z: number;
  /** Signed floor index. 0 is ground, positive is above ground, negative is below. */
  floor: number;
  /** Optional authoritative landing/standing Y. Omitted is resolved from map collision. */
  y?: number;
}

export interface PlacedObjectVerticalLink {
  id?: string;
  from: PlacedObjectVerticalLinkEndpoint;
  to: PlacedObjectVerticalLinkEndpoint;
  /** Defaults to false. When true, the reverse direction is available too. */
  bidirectional?: boolean;
  /** Optional explicit action labels for from->to and to->from. */
  fromAction?: 'Climb-up' | 'Climb-down';
  toAction?: 'Climb-up' | 'Climb-down';
}

export interface PlacedObjectInteraction {
  /** Existing object action label to hook, e.g. "Examine", "Open", "Search". */
  action: string;
  /** Optional gate. If false, this interaction entry is skipped. */
  condition?: QuestCondition;
  /** Optional gates. All must pass for this interaction entry to run. */
  conditions?: QuestCondition[];
  /** Server-side effects to run when the object action is used. */
  effects?: DialogueAction[];
  /** Legacy single local overhead bubble from the player. */
  say?: string;
  /** Timed local overhead bubble sequence from the player. */
  saySequence?: PlacedObjectSayLine[];
  /** Private system/chat-panel message to the interacting player. */
  message?: string;
  /** Hide/deplete the object after this interaction runs. */
  depleteObject?: boolean;
  /** Optional respawn delay for depleteObject. 0 means no respawn until server restart. */
  depleteRespawnTicks?: number;
}

export interface PlacedObjectSayLine {
  text: string;
  /** Delay after interaction in seconds. Defaults to 0. */
  delaySeconds?: number;
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
  mapType?: 'overworld' | 'dungeon';
  /** Ground used when sparse chunk tile data omits a tile. Dungeon maps default to void. */
  defaultGround?: GroundType;
  waterLevel: number;
  chunkWaterLevels: Record<string, number>;
  /** "chunkX,chunkZ" -> normalized water flow direction for 64x64 editor chunks. */
  chunkWaterFlows?: Record<string, WaterFlow>;
  texturePlanes: TexturePlane[];
  minimapMarkers?: MinimapMarker[];
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
    textureCutAngle: DEFAULT_TEXTURE_CUT_ANGLE,
    textureCutOffset: 0,
    waterPainted: false,
    waterSurface: false,
    waterSurfaceB: false,
  };
}

/** Default sparse-tile ground for a map. Overworld remains grass; dungeon/cave maps are void-first. */
export function defaultGroundForMap(map?: { mapType?: string | null; defaultGround?: GroundType | null } | null): GroundType {
  return map?.defaultGround ?? (map?.mapType === 'dungeon' ? 'void' : 'grass');
}

/** Map KC ground type to game TileType. Ground paint is visual-only for movement;
 *  authored wall/footprint collision should come from the collision tools. */
export function groundTypeToTileType(ground: GroundType): TileType {
  switch (ground) {
    case 'void':  return TileType.WALL;
    case 'grass': return TileType.GRASS;
    case 'dirt':  return TileType.DIRT;
    case 'sand':  return TileType.SAND;
    case 'path':  return TileType.DIRT;
    case 'road':      return TileType.STONE;
    // The editor exposes 'water' GroundType as the "Mud" swatch. It is walkable
    // mud unless the tile is explicitly marked as surface water or submerged.
    case 'water':     return TileType.MUD;
    case 'desert':    return TileType.SAND;
    case 'sandstone': return TileType.STONE;
    case 'rock':      return TileType.STONE;
    case 'drysand':   return TileType.SAND;
    case 'dungeon-floor': return TileType.STONE;
    case 'dungeon-stone': return TileType.STONE;
    case 'dungeon-slate': return TileType.STONE;
    case 'dungeon-rubble': return TileType.STONE;
    case 'dungeon-basalt': return TileType.STONE;
    case 'dungeon-moss': return TileType.STONE;
    case 'dungeon-torchlight': return TileType.STONE;
    case 'dungeon-rock':  return TileType.STONE;
    case 'dungeon-grey-rock': return TileType.STONE;
    case 'dungeon-dark-rock': return TileType.STONE;
    default:          return TileType.GRASS;
  }
}

/**
 * Classify a KC tile into a game-side TileType (used for collision + minimap).
 *
 * The editor's overworld "Mud" swatch sets `waterPainted = true` while leaving
 * `ground` unchanged, so we must NOT treat every `waterPainted` tile as real
 * water. Blue surface-water paint is a visual terrain-following layer and
 * should not add collision. Only heightmap-submerged tiles are real water.
 */
export function classifyTileType(
  tile: KCTile,
  cornerHeights: { tl: number; tr: number; bl: number; br: number },
  waterLevel: number,
): TileType {
  if (tile.ground === 'void') return TileType.WALL;
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
  if (tile.ground === 'void') return false;
  if (tile.waterPainted) return true;
  const minH = Math.min(cornerHeights.tl, cornerHeights.tr, cornerHeights.bl, cornerHeights.br);
  return minH <= waterLevel;
}

// --- Quest system ---

/** Per-event trigger that either starts a quest (via QuestDef.startTrigger)
 *  or advances the current stage (via QuestStageDef.trigger).
 *
 *  - `dialogue`: fires when the player chooses dialogue on an NPC. Set
 *    `npcDefId` to require a specific NPC definition, and optionally
 *    `nodeId` / `optionLabel` to require a specific dialogue beat.
 *  - `itemPickup`: fires when the player's running tally of `itemId` reaches
 *    `quantity` (default 1). By default any server-granted item counts; set
 *    `source` to require a specific acquisition path.
 *  - `npcKill`: fires when the player kills `npcDefId` (the def id from
 *    npcs.json) `count` times (default 1). Counted in player.quests[id]
 *    .triggerProgress.
 *  - `chestOpen`: fires when the player loots a chest. If `chestDefId` is
 *    set, only that specific chest type counts. Counted similarly.
 *  - `objectInteract`: fires when the player uses an object. Set
 *    `objectDefId` for the object definition, optionally `objectName` for a
 *    named placed object instance, and optionally `action` for an exact action
 *    label such as "Search" or "Examine".
 *
 *  `chance` (0–1) gates the trigger probabilistically — useful for rare
 *  quest hand-outs like "5% chance to find a clue on a cow". */
export type QuestTrigger =
  | { type: 'dialogue'; npcDefId?: number; npcName?: string; nodeId?: string; optionLabel?: string; count?: number; chance?: number }
  | { type: 'itemPickup'; itemId: number; quantity?: number; source?: 'any' | 'ground' | 'harvest' | 'chest' | 'dialogue' | 'object'; chance?: number }
  | { type: 'npcKill'; npcDefId: number; count?: number; chance?: number }
  | { type: 'chestOpen'; chestDefId?: number; count?: number; chance?: number }
  | { type: 'objectInteract'; objectDefId?: number; objectName?: string; action?: string; count?: number; chance?: number };

export interface QuestStageDef {
  /** 0-indexed stage. Stage 0 is the initial state when the quest starts. */
  id: number;
  /** Shown in the player's quest log. Plain text; supports newlines. */
  description: string;
  /** Optional path-specific journal copy keyed by a numeric quest var. */
  descriptionByVar?: { key: string; values: Record<string, string> };
  /** What advances *from* this stage. Omit for terminal stages (use
   *  completeQuest dialogue action to finish). */
  trigger?: QuestTrigger;
}

export interface QuestReward {
  /** Skill → XP. Granted on completeQuest. */
  xp?: Partial<Record<string, number>>;
  /** Items added to inventory on completeQuest. Completion is refused if they cannot all fit. */
  items?: Array<{ itemId: number; quantity: number }>;
  /** Renown awarded on completeQuest. Editor-authored values are 1-10. */
  renown?: number;
}

export interface QuestDef {
  id: string;
  name: string;
  /** One-line tagline shown in the quest log header. */
  blurb?: string;
  /** Stages in order. The player's currentStage indexes into this array.
   *  Reaching stages.length (or running completeQuest) marks the quest done. */
  stages: QuestStageDef[];
  /** Auto-start condition. When omitted, the quest can only start via a
   *  dialogue `setQuestStage` action. */
  startTrigger?: QuestTrigger;
  /** Reserved for future quest loops. Completion rewards are currently one-time
   *  and completed quests do not auto-restart. */
  repeatable?: boolean;
  /** Rewards granted on completion. */
  rewards?: QuestReward;
}

/** Sentinel `stage` value indicating the quest has been completed (rewards
 *  granted, removed from the active log but kept in the saved record so
 *  non-repeatable quests don't re-start). Use this constant everywhere
 *  rather than a literal `-1` so the meaning is self-documenting. */
export const QUEST_STAGE_COMPLETED = -1;

/** Per-player quest state, persisted on player_state.quests JSON column.
 *  - `stage`: index into QuestDef.stages while active; QUEST_STAGE_COMPLETED
 *    once finished. Absent key = never started.
 *  - `triggerProgress`: count toward the current stage's trigger threshold
 *    (kills, items, chests opened). Resets to 0 when the stage advances. */
export interface QuestState {
  stage: number;
  triggerProgress: number;
  vars?: Record<string, number>;
}
