import { mergeObjectActionLabels, type PlacedObjectInteraction, type PlacedObjectStallLootEntry, type PlacedObjectVerticalLink, type WorldObjectDef } from '@projectrs/shared';

// World-object entity IDs are sent as int16 on the wire, so they must stay in
// [10000, 19999]: above the player/NPC low range, below the ground-item range
// (20000+), and within the positive int16 ceiling. Runtime objects (e.g.
// firemaking fires) are created and destroyed constantly, so without recycling
// a free counter would eventually cross 32767 and wrap negative. A live-id set
// lets freed slots be reused; releaseObjectEntityId() must be called whenever an
// object is removed from the world.
const WORLD_OBJECT_ID_MIN = 10000;
const WORLD_OBJECT_ID_MAX = 19999;
const liveObjectIds = new Set<number>();
let nextObjectEntityId = WORLD_OBJECT_ID_MIN;

function allocateObjectEntityId(): number {
  const poolSize = WORLD_OBJECT_ID_MAX - WORLD_OBJECT_ID_MIN + 1;
  for (let attempts = 0; attempts < poolSize; attempts++) {
    const id = nextObjectEntityId++;
    if (nextObjectEntityId > WORLD_OBJECT_ID_MAX) nextObjectEntityId = WORLD_OBJECT_ID_MIN;
    if (!liveObjectIds.has(id)) {
      liveObjectIds.add(id);
      return id;
    }
  }
  // Pool exhausted (~10k simultaneously-live objects) — extremely unlikely.
  // Reuse the current slot rather than crash; IDs stay in-range so the wire is safe.
  liveObjectIds.add(nextObjectEntityId);
  return nextObjectEntityId;
}

/** Reclaim a world-object entity id once the object is removed from the world. */
export function releaseObjectEntityId(id: number): void {
  liveObjectIds.delete(id);
}

const DOOR_ACTIONS_CLOSED: readonly string[] = ['Open', 'Examine'];
const DOOR_ACTIONS_LOCKED: readonly string[] = ['Unlock', 'Examine'];
const DOOR_ACTIONS_OPEN: readonly string[] = ['Close', 'Examine'];

export class WorldObject {
  readonly id: number;
  readonly defId: number;
  readonly def: WorldObjectDef;
  readonly x: number;
  readonly z: number;
  readonly floor: number;
  readonly worldY: number;
  readonly mapLevel: string;

  depleted: boolean = false;
  respawnTimer: number = 0;
  rotationY: number = 0;
  doorOpen: boolean = false;
  doorDefaultOpen: boolean = false;
  doorOpenDirection: -1 | 1 = -1;
  doorLocked: boolean = false;
  doorKeyItemId: number = 0;
  doorConsumeKey: boolean = false;
  doorLockedMessage?: string;
  altarTier: number = 1;
  closedEdge: number = 0;
  /** Optional per-instance name from an editor placed object. */
  name?: string;
  /** Source editor asset id, when this object came from a placed GLB. */
  assetId?: string;
  /** Optional per-instance examine text from an editor placed object. */
  examineText?: string;
  /** Optional per-action effects from an editor placed object. */
  interactions?: PlacedObjectInteraction[];
  private interactionActionLabels: readonly string[] = [];
  private mergedActionCache: Map<readonly string[], readonly string[]> = new Map();
  /** Per-instance market stall reward table from the editor. */
  stallLoot?: PlacedObjectStallLootEntry[];
  /** Per-instance transition override from editor trigger data */
  trigger?: { type: string; destChunk: string; entryX: number; entryY: number; entryZ: number };
  /** Explicit vertical movement endpoints for ladder-like objects. */
  verticalLinks?: PlacedObjectVerticalLink[];
  /** Exact local tile offsets valid for using this object. Overrides side mask. */
  interactionTiles?: { x: number; z: number }[];
  /** Local-frame perimeter bitmask of valid interaction tiles.
   *  0 / undefined = any adjacent interaction tile. */
  interactionSides?: number;

  constructor(def: WorldObjectDef, x: number, z: number, mapLevel: string, floor: number = 0, worldY: number = 0) {
    this.id = allocateObjectEntityId();
    this.defId = def.id;
    this.def = def;
    this.x = x;
    this.z = z;
    this.floor = floor;
    this.worldY = worldY;
    this.mapLevel = mapLevel;
  }

  setInteractions(interactions: PlacedObjectInteraction[] | undefined): void {
    this.interactions = interactions && interactions.length > 0 ? interactions : undefined;
    this.mergedActionCache.clear();

    if (!this.interactions) {
      this.interactionActionLabels = [];
      return;
    }

    const labels: string[] = [];
    for (const interaction of this.interactions) {
      const action = interaction.action.trim();
      if (!action || labels.includes(action)) continue;
      labels.push(action);
    }
    this.interactionActionLabels = labels;
  }

  private actionsWithInteractionLabels(baseActions: readonly string[]): readonly string[] {
    if (this.interactionActionLabels.length === 0) return baseActions;
    let cached = this.mergedActionCache.get(baseActions);
    if (!cached) {
      cached = mergeObjectActionLabels(baseActions, this.interactionActionLabels);
      this.mergedActionCache.set(baseActions, cached);
    }
    return cached;
  }

  /** Action labels that apply right now — doors flip Open/Close based on
   *  doorOpen, and placed-object interactions can add per-instance actions.
   *  The label drives the dispatcher in handlePlayerInteractObject; replacing
   *  it via this getter avoids the per-toggle def allocation that previous
   *  code did. */
  get currentActions(): readonly string[] {
    let actions: readonly string[];
    if (this.def.category === 'door') {
      if (!this.doorOpen && this.doorLocked) actions = DOOR_ACTIONS_LOCKED;
      else actions = this.doorOpen ? DOOR_ACTIONS_OPEN : DOOR_ACTIONS_CLOSED;
    } else {
      actions = this.def.actions;
    }
    return this.actionsWithInteractionLabels(actions);
  }

  get displayName(): string {
    return this.name || this.def.name;
  }

  /** Tick respawn. Returns true when object respawns. */
  tickRespawn(): boolean {
    if (!this.depleted) return false;
    this.respawnTimer--;
    if (this.respawnTimer <= 0) {
      this.depleted = false;
      return true;
    }
    return false;
  }

  /** Deplete the object (e.g. tree chopped down). */
  deplete(): void {
    this.depleted = true;
    this.respawnTimer = this.def.respawnTime ?? 15;
  }
}
