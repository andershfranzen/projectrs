import { Position } from '@projectrs/shared';

let nextEntityId = 1;

export abstract class Entity {
  readonly id: number;
  position: Position;
  /** Tile center this entity last stepped away from. Follow/chase code paths to
   *  this anchor instead of the live occupied tile so followers trail rather
   *  than stack. */
  followAnchorX: number;
  followAnchorZ: number;
  name: string;
  health: number;
  maxHealth: number;
  currentMapLevel: string = 'kcmap';
  currentFloor: number = 0;

  /** Last broadcast position/health — used by broadcastSync dirty checking */
  lastSyncX: number = -9999;
  lastSyncZ: number = -9999;
  lastSyncHealth: number = -1;
  syncDirty: boolean = true;

  constructor(name: string, x: number, z: number, maxHealth: number) {
    this.id = nextEntityId++;
    this.name = name;
    this.position = { x, y: z }; // y in Position = z in world
    this.followAnchorX = x - 1;
    this.followAnchorZ = z;
    this.health = maxHealth;
    this.maxHealth = maxHealth;
  }

  moveTo(x: number, z: number): boolean {
    const moved = Math.floor(x) !== Math.floor(this.position.x) || Math.floor(z) !== Math.floor(this.position.y);
    if (moved) {
      this.followAnchorX = this.position.x;
      this.followAnchorZ = this.position.y;
    }
    this.position.x = x;
    this.position.y = z;
    return moved;
  }

  teleportTo(x: number, z: number): void {
    this.position.x = x;
    this.position.y = z;
    this.followAnchorX = x - 1;
    this.followAnchorZ = z;
  }

  get alive(): boolean {
    return this.health > 0;
  }

  takeDamage(amount: number): number {
    const actual = Math.min(amount, this.health);
    this.health -= actual;
    return actual;
  }

  heal(amount: number): void {
    this.health = Math.min(this.health + amount, this.maxHealth);
  }
}
