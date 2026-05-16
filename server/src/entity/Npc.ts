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

  // A* path following — used for wander + returning to spawn only. Chase
  // uses naiveChaseStep (2004scape-style direct stepping) so NPCs get
  // visibly stuck on walls / closed doors / placed objects instead of
  // routing around them.
  pathQueue: { x: number; z: number }[] = [];

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
  static readonly MELEE_RANGE = 1.5;
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

  /** True if (x, z) is within this NPC's wander box around spawn. The 0.5
   *  fudge covers half-integer tile centers — both spawnX and the queried
   *  point live at `floor(...)+0.5`, so abs differences are integers and the
   *  fudge just guards float comparisons. */
  private inWanderRange(x: number, z: number): boolean {
    const wr = this.wanderRange;
    return Math.abs(x - this.spawnX) <= wr + 0.5 &&
           Math.abs(z - this.spawnZ) <= wr + 0.5;
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

  /** One-tile direct step toward (targetX, targetZ). Tries diagonal first,
   *  then the cardinal that closes the larger axis. Returns false (no step)
   *  if every option is blocked — that's how NPCs end up stuck behind
   *  walls / closed doors / placed objects. Mirrors 2004scape's NAIVE
   *  move strategy (Engine-TS PathingEntity.naivePathToTarget). */
  private naiveChaseStep(
    targetX: number, targetZ: number,
    isBlocked: (x: number, z: number) => boolean,
    isWallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean,
  ): boolean {
    const px = Math.floor(this.position.x);
    const pz = Math.floor(this.position.y);
    const fromX = px + 0.5;
    const fromZ = pz + 0.5;
    const sx = Math.sign(Math.floor(targetX) - px);
    const sz = Math.sign(Math.floor(targetZ) - pz);
    if (sx === 0 && sz === 0) return false;

    const tryStep = (dx: number, dz: number): boolean => {
      if (dx === 0 && dz === 0) return false;
      const nx = px + dx + 0.5;
      const nz = pz + dz + 0.5;
      if (isBlocked(nx, nz)) return false;
      if (isWallBlocked && isWallBlocked(fromX, fromZ, nx, nz)) return false;
      this.position.x = nx;
      this.position.y = nz;
      return true;
    };

    // Prefer diagonal when both axes need to close; otherwise fall back to
    // the cardinal that still has distance to cover. If the diagonal is
    // blocked but a cardinal isn't, take the cardinal — that's what makes
    // NPCs slide along walls until they hit a real dead-end.
    if (sx !== 0 && sz !== 0 && tryStep(sx, sz)) return true;
    const adx = Math.abs(targetX - this.position.x);
    const adz = Math.abs(targetZ - this.position.y);
    if (adx >= adz) {
      if (sx !== 0 && tryStep(sx, 0)) return true;
      if (sz !== 0 && tryStep(0, sz)) return true;
    } else {
      if (sz !== 0 && tryStep(0, sz)) return true;
      if (sx !== 0 && tryStep(sx, 0)) return true;
    }
    return false;
  }

  private disengageAndReturnHome(): void {
    this.combatTarget = null;
    this.returning = true;
    this.pathQueue.length = 0;
  }

  processAI(
    isBlocked: (x: number, z: number) => boolean,
    isWallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean,
    findPath?: (sx: number, sz: number, gx: number, gz: number) => { x: number; z: number }[],
  ): void {
    if (this.dead) return;

    // --- Returning to spawn ---
    // Re-aggro mid-return: abandon the walk-home path and fall through to
    // chase. Without this the NPC marches all the way back to spawn before
    // it can react to the player re-entering range, which reads as the
    // NPC ignoring you for a full retreat path.
    if (this.returning && this.combatTarget) {
      this.returning = false;
      this.pathQueue.length = 0;
    }
    if (this.returning) {
      // Already inside the wander box — drop returning and let normal AI
      // (wander) take it from here so the NPC drifts naturally instead of
      // marching to the exact spawn tile. wanderRange 0 collapses the box
      // to the spawn point, so stationary NPCs still return precisely.
      if (this.inWanderRange(this.position.x, this.position.y)) {
        this.returning = false;
        this.pathQueue.length = 0;
        return;
      }
      if (this.pathQueue.length === 0 && findPath) {
        // Aim for the nearest tile inside the wander box. findPath floors
        // the goal, so unoffset bounds are correct for tile centers.
        const wr = this.wanderRange;
        const goalX = Math.max(this.spawnX - wr, Math.min(this.spawnX + wr, this.position.x));
        const goalZ = Math.max(this.spawnZ - wr, Math.min(this.spawnZ + wr, this.position.y));
        const path = findPath(this.position.x, this.position.y, goalX, goalZ);
        if (path.length > 0) {
          this.pathQueue = path.slice(0, Npc.NPC_MAX_PATH_LENGTH);
        } else {
          // Path blocked — drop the returning state so the NPC tries normal
          // wander next tick instead of teleporting. No silent snap-to-spawn.
          this.returning = false;
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

      // Steady state during a fight: adjacent and swinging. Check before
      // the leash math so the common case skips the abs/compare work.
      // Aggressive/non-aggressive both route through here — the def flag
      // gates proactive aggro acquisition (World.ts), not chase persistence
      // once engaged. A non-aggressive NPC that's been hit retaliates and
      // chases under the same spawn-anchored leash below.
      if (dist <= Npc.MELEE_RANGE) {
        this.pathQueue.length = 0;
        return;
      }

      // Hard leash on target: target fled past 2004scape's 25-tile cap
      // (measured from spawn). Soft leash on NPC: chase can't pull us
      // more than RETREAT_MAX_RANGE from spawn.
      const dxSpawn = Math.abs(targetX - this.spawnX);
      const dzSpawn = Math.abs(targetZ - this.spawnZ);
      if (dxSpawn > Npc.RETREAT_INTERACTION_RANGE || dzSpawn > Npc.RETREAT_INTERACTION_RANGE) {
        this.disengageAndReturnHome();
        return;
      }
      const npcDxSpawn = Math.abs(this.position.x - this.spawnX);
      const npcDzSpawn = Math.abs(this.position.y - this.spawnZ);
      if (npcDxSpawn > Npc.RETREAT_MAX_RANGE || npcDzSpawn > Npc.RETREAT_MAX_RANGE) {
        this.disengageAndReturnHome();
        return;
      }

      this.pathQueue.length = 0;
      this.naiveChaseStep(targetX, targetZ, isBlocked, isWallBlocked);
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
          if (!this.inWanderRange(gx, gz)) continue;
          if (isBlocked(gx, gz)) continue;
          if (gx === this.position.x && gz === this.position.y) continue;
          const path = findPath(this.position.x, this.position.y, gx, gz);
          if (path.length === 0 || path.length > Npc.WANDER_PATH_MAX) continue;
          // Trim path to stay within wander range of spawn
          const trimmed: { x: number; z: number }[] = [];
          for (const wp of path) {
            if (!this.inWanderRange(wp.x, wp.z)) break;
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
