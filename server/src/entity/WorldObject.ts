import type { WorldObjectDef } from '@projectrs/shared';

let nextObjectEntityId = 10000; // Start high to avoid collision with NPC/player entity IDs

const DOOR_ACTIONS_CLOSED: readonly string[] = ['Open', 'Examine'];
const DOOR_ACTIONS_OPEN: readonly string[] = ['Close', 'Examine'];
const LADDER_ACTIONS_SURFACE: readonly string[] = ['Climb-down', 'Examine'];
const LADDER_ACTIONS_MINE: readonly string[] = ['Climb-up', 'Examine'];

export class WorldObject {
  readonly id: number;
  readonly defId: number;
  readonly def: WorldObjectDef;
  readonly x: number;
  readonly z: number;
  readonly mapLevel: string;

  depleted: boolean = false;
  respawnTimer: number = 0;
  rotationY: number = 0;
  doorOpen: boolean = false;
  closedEdge: number = 0;
  /** Per-instance transition override from editor trigger data */
  trigger?: { type: string; destChunk: string; entryX: number; entryY: number; entryZ: number };

  constructor(def: WorldObjectDef, x: number, z: number, mapLevel: string) {
    this.id = nextObjectEntityId++;
    this.defId = def.id;
    this.def = def;
    this.x = x;
    this.z = z;
    this.mapLevel = mapLevel;
  }

  /** Action labels that apply right now — doors flip Open/Close based on
   *  doorOpen, everything else returns the def's static actions. The label
   *  drives the dispatcher in handlePlayerInteractObject; replacing it via
   *  this getter avoids the per-toggle def allocation that previous code did. */
  get currentActions(): readonly string[] {
    if (this.def.category === 'door') {
      return this.doorOpen ? DOOR_ACTIONS_OPEN : DOOR_ACTIONS_CLOSED;
    }
    if (this.def.category === 'ladder') {
      return this.mapLevel === 'the_sultans_mine' ? LADDER_ACTIONS_MINE : LADDER_ACTIONS_SURFACE;
    }
    return this.def.actions;
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
