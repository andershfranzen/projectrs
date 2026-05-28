import { mergeObjectActionLabels, type PlacedObjectInteraction, type PlacedObjectVerticalLink, type WorldObjectDef } from '@projectrs/shared';

let nextObjectEntityId = 10000; // Start high to avoid collision with NPC/player entity IDs

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
  /** Optional per-instance examine text from an editor placed object. */
  examineText?: string;
  /** Optional per-action effects from an editor placed object. */
  interactions?: PlacedObjectInteraction[];
  private interactionActionLabels: readonly string[] = [];
  private mergedActionCache: Map<readonly string[], readonly string[]> = new Map();
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
    this.id = nextObjectEntityId++;
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
