import { Entity } from './Entity';
import type { NpcDef, PlayerAppearance, ShopDef, DialogueTree } from '@projectrs/shared';

export class Npc extends Entity {
  readonly npcId: number; // Definition ID
  readonly def: NpcDef;
  readonly spawnX: number;
  readonly spawnZ: number;

  /** Per-spawn customization. When non-null, this NPC is eligible for 3D
   *  CharacterEntity rendering (subject to mobile LOD on the client). Static
   *  — set at spawn time, mutated only by the admin /npcedit flow. */
  appearance: PlayerAppearance | null = null;
  /** 10-slot equipment array, PLAYER_REMOTE_EQUIPMENT layout. Only consulted
   *  when `appearance` is also set (gear pipeline runs on CharacterEntity only). */
  equipment: number[] | null = null;

  // AI — initial cooldown randomized so NPCs don't all move in lockstep
  wanderCooldown: number = Math.floor(Math.random() * 15);
  combatTarget: Entity | null = null;
  attackCooldown: number = 0;
  returning: boolean = false;

  // A* path following
  pathQueue: { x: number; z: number }[] = [];
  private pathTargetX: number = 0;
  private pathTargetZ: number = 0;
  private pathAge: number = 0;
  private pathFailCount: number = 0;

  // Death / respawn
  dead: boolean = false;
  respawnTimer: number = 0;

  // Hero points: tracks damage per attacker for kill credit
  private heroPoints: Map<number, number> = new Map();

  // Single-combat timer: tick when last attacked (8-tick lockout)
  lastCombatTick: number = 0;
  lastAttackerId: number = -1;

  static readonly RETREAT_MAX_RANGE = 7;
  static readonly RETREAT_INTERACTION_RANGE = 18;
  static readonly NPC_MAX_PATH_LENGTH = 20;
  private static readonly PATH_RECOMPUTE_THRESHOLD = 3;
  private static readonly PATH_STALE_TICKS = 5;
  private static readonly CHASE_GIVE_UP_FAILURES = 5;
  private static readonly WANDER_PATH_MAX = 8;

  readonly wanderRangeOverride?: number;

  /** Per-spawn aggression flag. When set on the spawn it overrides
   *  NpcDef.aggressive; null means "fall through to the def default". */
  readonly aggressiveOverride: boolean | null;

  /** Resolved at spawn time as `spawn.shop ?? def.shop ?? legacyShopsJson`.
   *  Cached so right-click handlers don't re-resolve every interaction. */
  readonly effectiveShop: ShopDef | null;
  /** Resolved at spawn time as `spawn.dialogue ?? def.dialogue`. */
  readonly effectiveDialogue: DialogueTree | null;
  /** Per-spawn name override (`spawn.name`). When null the runtime falls
   *  back to def.name (already set on Entity by the super constructor). */
  readonly nameOverride: string | null;

  constructor(
    def: NpcDef,
    x: number,
    z: number,
    wanderRange?: number,
    appearance?: PlayerAppearance | null,
    equipment?: number[] | null,
    aggressive?: boolean | null,
    effectiveShop?: ShopDef | null,
    effectiveDialogue?: DialogueTree | null,
    nameOverride?: string | null,
  ) {
    super(nameOverride || def.name, x, z, def.health);
    this.npcId = def.id;
    this.nameOverride = nameOverride && nameOverride.length > 0 ? nameOverride : null;
    this.def = def;
    this.spawnX = x;
    this.spawnZ = z;
    this.wanderRangeOverride = wanderRange;
    this.appearance = appearance ?? null;
    this.equipment = equipment ?? null;
    this.aggressiveOverride = aggressive ?? null;
    this.effectiveShop = effectiveShop ?? null;
    this.effectiveDialogue = effectiveDialogue ?? null;
  }

  /** Per-spawn name override if set, otherwise the def's name. */
  get displayName(): string {
    return this.nameOverride ?? this.def.name;
  }

  get hasDialogue(): boolean {
    return this.effectiveDialogue !== null;
  }
  get hasShop(): boolean {
    return this.effectiveShop !== null;
  }
  get hasBank(): boolean {
    return this.def.bankAccess === true;
  }
  /** Bitfield matching NPC_INTERACTIONS opcode encoding. */
  interactionFlags(): number {
    return (this.hasDialogue ? 1 : 0) | (this.hasShop ? 2 : 0) | (this.hasBank ? 4 : 0);
  }

  /** Effective aggression: spawn-level flag wins if set, otherwise NpcDef. */
  get aggressive(): boolean {
    return this.aggressiveOverride !== null ? this.aggressiveOverride : this.def.aggressive;
  }

  get wanderRange(): number {
    return this.wanderRangeOverride ?? this.def.wanderRange;
  }

  private followPath(
    isBlocked: (x: number, z: number) => boolean,
    isWallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean,
  ): boolean {
    if (this.pathQueue.length === 0) return false;
    const next = this.pathQueue[0];
    const px = this.position.x;
    const pz = this.position.y;
    if (isBlocked(next.x, next.z)) { this.pathQueue.length = 0; return false; }
    if (isWallBlocked && isWallBlocked(px, pz, next.x, next.z)) { this.pathQueue.length = 0; return false; }
    this.position.x = next.x;
    this.position.y = next.z;
    this.pathQueue.shift();
    return true;
  }

  private findBestAdjacentTile(
    targetX: number, targetZ: number,
    isBlocked: (x: number, z: number) => boolean,
  ): { x: number; z: number } | null {
    const tx = Math.floor(targetX);
    const tz = Math.floor(targetZ);
    const px = this.position.x;
    const pz = this.position.y;
    let best: { x: number; z: number } | null = null;
    let bestDist = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        const ax = tx + dx + 0.5;
        const az = tz + dz + 0.5;
        if (isBlocked(ax, az)) continue;
        if (Math.abs(ax - this.spawnX) > Npc.RETREAT_MAX_RANGE) continue;
        if (Math.abs(az - this.spawnZ) > Npc.RETREAT_MAX_RANGE) continue;
        const dist = Math.max(Math.abs(ax - px), Math.abs(az - pz));
        if (dist < bestDist) { bestDist = dist; best = { x: ax, z: az }; }
      }
    }
    return best;
  }

  processAI(
    isBlocked: (x: number, z: number) => boolean,
    isWallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean,
    findPath?: (sx: number, sz: number, gx: number, gz: number) => { x: number; z: number }[],
  ): void {
    if (this.dead) return;

    // --- Returning to spawn ---
    if (this.returning) {
      const dx = this.spawnX - this.position.x;
      const dz = this.spawnZ - this.position.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dz) < 0.5) {
        this.position.x = this.spawnX;
        this.position.y = this.spawnZ;
        this.returning = false;
        this.pathQueue.length = 0;
        return;
      }
      if (this.pathQueue.length === 0 && findPath) {
        const path = findPath(this.position.x, this.position.y, this.spawnX, this.spawnZ);
        if (path.length > 0) {
          this.pathQueue = path.slice(0, Npc.NPC_MAX_PATH_LENGTH);
        } else {
          this.position.x = this.spawnX;
          this.position.y = this.spawnZ;
          this.returning = false;
          this.pathQueue.length = 0;
          return;
        }
      }
      this.followPath(isBlocked, isWallBlocked);
      return;
    }

    // --- Combat chase ---
    if (this.combatTarget) {
      this.position.x = Math.floor(this.position.x) + 0.5;
      this.position.y = Math.floor(this.position.y) + 0.5;
      const targetX = this.combatTarget.position.x;
      const targetZ = this.combatTarget.position.y;
      const dx = targetX - this.position.x;
      const dz = targetZ - this.position.y;
      const dist = Math.max(Math.abs(dx), Math.abs(dz));

      if (!this.aggressive) {
        if (dist > 1.5) {
          this.combatTarget = null;
          this.returning = true;
          this.pathQueue.length = 0;
        }
        return;
      }

      const dxSpawn = Math.abs(targetX - this.spawnX);
      const dzSpawn = Math.abs(targetZ - this.spawnZ);
      if (dxSpawn > Npc.RETREAT_INTERACTION_RANGE || dzSpawn > Npc.RETREAT_INTERACTION_RANGE) {
        this.combatTarget = null;
        this.returning = true;
        this.pathQueue.length = 0;
        return;
      }

      const npcDxSpawn = Math.abs(this.position.x - this.spawnX);
      const npcDzSpawn = Math.abs(this.position.y - this.spawnZ);
      if (npcDxSpawn > Npc.RETREAT_MAX_RANGE || npcDzSpawn > Npc.RETREAT_MAX_RANGE) {
        this.combatTarget = null;
        this.returning = true;
        this.pathQueue.length = 0;
        return;
      }

      if (dist <= 1.5) {
        this.pathQueue.length = 0;
        return;
      }

      // Recompute path if needed
      this.pathAge++;
      const targetMoved = Math.abs(targetX - this.pathTargetX) + Math.abs(targetZ - this.pathTargetZ) > Npc.PATH_RECOMPUTE_THRESHOLD;
      if (targetMoved || this.pathAge > Npc.PATH_STALE_TICKS || this.pathQueue.length === 0) {
        if (findPath) {
          const goal = this.findBestAdjacentTile(targetX, targetZ, isBlocked);
          if (goal) {
            const path = findPath(this.position.x, this.position.y, goal.x, goal.z);
            if (path.length > 0) {
              this.pathQueue = path.slice(0, Npc.NPC_MAX_PATH_LENGTH);
              this.pathTargetX = targetX;
              this.pathTargetZ = targetZ;
              this.pathAge = 0;
              this.pathFailCount = 0;
            } else {
              this.pathFailCount++;
            }
          } else {
            this.pathFailCount++;
          }
        }
        if (this.pathFailCount >= Npc.CHASE_GIVE_UP_FAILURES) {
          this.combatTarget = null;
          this.returning = true;
          this.pathQueue.length = 0;
          this.pathFailCount = 0;
          return;
        }
      }

      // Validate next step stays within leash
      if (this.pathQueue.length > 0) {
        const next = this.pathQueue[0];
        if (Math.abs(next.x - this.spawnX) > Npc.RETREAT_MAX_RANGE ||
            Math.abs(next.z - this.spawnZ) > Npc.RETREAT_MAX_RANGE) {
          this.combatTarget = null;
          this.returning = true;
          this.pathQueue.length = 0;
          return;
        }
        this.followPath(isBlocked, isWallBlocked);
      }
      return;
    }

    // --- Wander ---
    if (this.wanderRange > 0) {
      if (this.pathQueue.length > 0) {
        this.followPath(isBlocked, isWallBlocked);
        if (this.pathQueue.length === 0) {
          this.wanderCooldown = 5 + Math.floor(Math.random() * 15);
        }
        return;
      }

      this.wanderCooldown--;
      if (this.wanderCooldown <= 0 && findPath) {
        for (let attempt = 0; attempt < 4; attempt++) {
          // Pick a random direction and walk 2-wanderRange tiles that way
          const angle = Math.random() * Math.PI * 2;
          const dist = 2 + Math.floor(Math.random() * Math.max(1, this.wanderRange - 1));
          const tx = this.spawnX + Math.round(Math.cos(angle) * dist);
          const tz = this.spawnZ + Math.round(Math.sin(angle) * dist);
          const gx = Math.floor(tx) + 0.5;
          const gz = Math.floor(tz) + 0.5;
          if (Math.abs(gx - this.spawnX) > this.wanderRange + 0.5) continue;
          if (Math.abs(gz - this.spawnZ) > this.wanderRange + 0.5) continue;
          if (isBlocked(gx, gz)) continue;
          if (gx === this.position.x && gz === this.position.y) continue;
          const path = findPath(this.position.x, this.position.y, gx, gz);
          if (path.length === 0 || path.length > Npc.WANDER_PATH_MAX) continue;
          // Trim path to stay within wander range of spawn
          const trimmed: { x: number; z: number }[] = [];
          for (const wp of path) {
            if (Math.abs(wp.x - this.spawnX) > this.wanderRange + 0.5 ||
                Math.abs(wp.z - this.spawnZ) > this.wanderRange + 0.5) break;
            trimmed.push(wp);
          }
          if (trimmed.length > 0) {
            this.pathQueue = trimmed;
            break;
          }
        }
        if (this.pathQueue.length === 0) {
          this.wanderCooldown = 3 + Math.floor(Math.random() * 5);
        }
      }
    }
  }

  die(): void {
    this.dead = true;
    this.health = 0;
    this.combatTarget = null;
    this.respawnTimer = this.def.respawnTime;
  }

  respawn(): void {
    this.dead = false;
    this.health = this.maxHealth;
    this.position.x = this.spawnX;
    this.position.y = this.spawnZ;
    this.combatTarget = null;
    this.attackCooldown = 0;
    this.wanderCooldown = Math.floor(Math.random() * 15);
    this.returning = false;
    this.pathQueue.length = 0;
    this.pathAge = 0;
    this.pathFailCount = 0;
    this.heroPoints.clear();
    this.lastCombatTick = 0;
    this.lastAttackerId = -1;
  }

  tickRespawn(): boolean {
    if (!this.dead) return false;
    this.respawnTimer--;
    if (this.respawnTimer <= 0) {
      this.respawn();
      return true; // Respawned
    }
    return false;
  }

  /** Track damage dealt by each attacker for kill credit */
  addHeroPoints(attackerId: number, damage: number): void {
    this.heroPoints.set(attackerId, (this.heroPoints.get(attackerId) ?? 0) + damage);
  }

  /** Get the attacker who dealt the most total damage (kill credit) */
  getTopDamager(): number | null {
    let topId: number | null = null;
    let topDmg = 0;
    for (const [id, dmg] of this.heroPoints) {
      if (dmg > topDmg) { topId = id; topDmg = dmg; }
    }
    return topId;
  }
}
