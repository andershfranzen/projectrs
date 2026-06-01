import { Entity } from './Entity';
import { effectiveNpcCombatStats, getObjectFootprintBounds, getObjectFootprintMinTile, getObjectInteractionTiles, isTileAdjacentToObject, isTileInsideObjectFootprint, normalizeAppearance, npcCombatLevel } from '@projectrs/shared';
import type { NpcDef, PlayerAppearance, ShopDef, DialogueTree, TileCoord, NpcStatOverrides, CustomColors } from '@projectrs/shared';

function normalizeFacingAngle(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function normalizeOptionalRange(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.floor(value));
}

export class Npc extends Entity {
  readonly npcId: number; // Definition ID
  readonly def: NpcDef;
  readonly spawnX: number;
  readonly spawnZ: number;
  readonly spawnFacingAngle: number | null;
  facingAngle: number | null;

  /** Per-spawn customization. When non-null, this NPC is eligible for 3D
   *  CharacterEntity rendering (subject to mobile LOD on the client). Static
   *  — set at spawn time, mutated only by the admin /npcedit flow. */
  appearance: PlayerAppearance | null = null;
  /** 11-slot equipment array, PLAYER_REMOTE_EQUIPMENT layout. Only consulted
   *  when `appearance` is also set (gear pipeline runs on CharacterEntity only). */
  equipment: number[] | null = null;
  /** Raw per-slot RGB overrides. Sent to the client via NPC_CUSTOM_COLORS so
   *  CharacterEntity.applyAppearance picks the raw value instead of the palette
   *  index. Only meaningful when `appearance` is also set. */
  customColors: CustomColors | null = null;
  /** Per-spawn stat overrides. Any field set wins over def. Read via the
   *  attack/defence/strength/attackSpeed/respawnTime getters below. */
  readonly statsOverride: NpcStatOverrides | null;
  /** Effective combat level derived from the runtime stat block. */
  readonly combatLevel: number;
  /** Animation name to play on swing (e.g. `attack_2h_smash`). When null,
   *  the client falls back to the weapon-driven picker in
   *  GameManager.getPlayerAttackAnimName. */
  readonly attackAnimOverride: string | null;

  // AI — initial cooldown randomized so NPCs don't all move in lockstep
  wanderCooldown: number = Math.floor(Math.random() * 15);
  combatTarget: Entity | null = null;
  retreatTarget: Entity | null = null;
  attackCooldown: number = 0;
  returning: boolean = false;
  private overlapEscapeDelayTargetId: number = -1;
  private overlapEscapeDelayTicks: number = 0;

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

  static readonly NPC_MAX_PATH_LENGTH = 20;
  static readonly MELEE_RANGE = 1.5;
  private static readonly OVERLAP_ESCAPE_DELAY_TICKS = 2;
  private static readonly WANDER_PATH_MAX = 8;
  private static readonly RETREAT_INTERACTION_EXTRA = 11;

  readonly wanderRangeOverride: number | null;
  readonly maxRangeOverride: number | null;
  readonly huntRangeOverride: number | null;
  readonly attackRangeOverride: number | null;
  readonly retreatHealthOverride: number | null;

  /** Per-spawn aggression flag. When set on the spawn it overrides
   *  NpcDef.aggressive; null means "fall through to the def default". */
  readonly aggressiveOverride: boolean | null;

  /** Resolved at spawn time as `spawn.shop ?? def.shop ?? legacyShopsJson`.
   *  Cached so right-click handlers don't re-resolve every interaction. */
  readonly effectiveShop: ShopDef | null;
  /** Runtime stock for this spawned shop. Keyed by item id. */
  readonly shopStock: Map<number, number> = new Map();
  /** Next tick at which one missing stock unit should be restored. */
  readonly shopNextRestockTick: Map<number, number> = new Map();
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
    statsOverride?: NpcStatOverrides | null,
    customColors?: CustomColors | null,
    attackAnimOverride?: string | null,
    facing?: number | null,
    maxRange?: number | null,
    huntRange?: number | null,
    attackRange?: number | null,
    retreatHealth?: number | null,
  ) {
    // Health override applies at construction so the Entity's maxHealth picks
    // it up. Stats override is positive integers; ignore non-finite or ≤0.
    const overrideHealth = statsOverride?.health;
    const effHealth = (typeof overrideHealth === 'number' && overrideHealth > 0)
      ? Math.floor(overrideHealth)
      : def.health;
    super(nameOverride || def.name, x, z, effHealth);
    this.npcId = def.id;
    this.nameOverride = nameOverride && nameOverride.length > 0 ? nameOverride : null;
    this.def = def;
    this.spawnX = x;
    this.spawnZ = z;
    this.spawnFacingAngle = normalizeFacingAngle(facing);
    this.facingAngle = this.spawnFacingAngle;
    this.wanderRangeOverride = normalizeOptionalRange(wanderRange);
    this.maxRangeOverride = normalizeOptionalRange(maxRange);
    this.huntRangeOverride = normalizeOptionalRange(huntRange);
    this.attackRangeOverride = normalizeOptionalRange(attackRange);
    this.retreatHealthOverride = normalizeOptionalRange(retreatHealth);
    this.appearance = appearance ? normalizeAppearance(appearance) : null;
    this.equipment = equipment ?? null;
    this.customColors = customColors ?? null;
    this.aggressiveOverride = aggressive ?? null;
    this.effectiveShop = effectiveShop ?? null;
    if (this.effectiveShop) {
      for (const item of this.effectiveShop.items) {
        this.shopStock.set(item.itemId, Math.max(0, Math.floor(item.stock)));
      }
    }
    this.effectiveDialogue = effectiveDialogue ?? null;
    this.statsOverride = statsOverride ?? null;
    this.attackAnimOverride = (attackAnimOverride && attackAnimOverride.length > 0)
      ? attackAnimOverride
      : null;
    this.combatLevel = npcCombatLevel(effectiveNpcCombatStats(this.def, this.statsOverride));
  }

  /** Effective combat stats. Spawn override wins over NpcDef. Combat code
   *  reads these instead of `npc.def.<stat>` so per-spawn customization
   *  flows through transparently. */
  get attack(): number { return this.statsOverride?.attack ?? this.def.attack; }
  get defence(): number { return this.statsOverride?.defence ?? this.def.defence; }
  get strength(): number { return this.statsOverride?.strength ?? this.def.strength; }
  get attackSpeed(): number { return this.statsOverride?.attackSpeed ?? this.def.attackSpeed; }
  get respawnTime(): number { return this.statsOverride?.respawnTime ?? this.def.respawnTime; }

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

  get stationary(): boolean {
    return this.def.stationary === true;
  }

  get wanderRange(): number {
    if (this.stationary) return 0;
    return this.wanderRangeOverride ?? normalizeOptionalRange(this.def.wanderRange) ?? 0;
  }

  get maxRange(): number {
    if (this.stationary) return 0;
    const authored = this.maxRangeOverride ?? normalizeOptionalRange(this.def.maxRange);
    if (authored !== null) return authored;
    return this.wanderRange > 0 ? this.wanderRange + 2 : 0;
  }

  get huntRange(): number {
    const authored = this.huntRangeOverride ?? normalizeOptionalRange(this.def.huntRange);
    return authored ?? this.maxRange;
  }

  get attackRange(): number {
    const authored = this.attackRangeOverride ?? normalizeOptionalRange(this.def.attackRange);
    return authored ?? 0;
  }

  get retreatHealth(): number {
    const authored = this.retreatHealthOverride ?? normalizeOptionalRange(this.def.retreatHealth);
    return authored ?? 0;
  }

  get combatFollowRange(): number {
    return this.maxRange;
  }

  get aggroRange(): number {
    return this.huntRange;
  }

  get effectiveAggroRange(): number {
    return Math.max(0, this.huntRange);
  }

  isTargetWithinAggroRange(targetX: number, targetZ: number): boolean {
    return this.isTargetWithinCombatMaxRange(targetX, targetZ);
  }

  isTargetWithinCombatMaxRange(targetX: number, targetZ: number): boolean {
    const maxRange = this.maxRange;
    const dxSpawn = Math.abs(targetX - this.spawnX);
    const dzSpawn = Math.abs(targetZ - this.spawnZ);
    if (this.attackRange > 0) {
      return Math.max(dxSpawn, dzSpawn) <= maxRange + this.attackRange;
    }
    if (Math.max(dxSpawn, dzSpawn) > maxRange + 1) return false;
    return !(dxSpawn === maxRange + 1 && dzSpawn === maxRange + 1);
  }

  private isPositionWithinMaxRange(x: number, z: number, strict = false): boolean {
    const dist = Math.max(Math.abs(x - this.spawnX), Math.abs(z - this.spawnZ));
    return strict ? dist < this.maxRange : dist <= this.maxRange;
  }

  private isRetreatTargetWithinInteractionRange(targetX: number, targetZ: number): boolean {
    const dist = Math.max(Math.abs(targetX - this.spawnX), Math.abs(targetZ - this.spawnZ));
    return dist <= this.maxRange + Npc.RETREAT_INTERACTION_EXTRA;
  }

  /** NxN tile footprint side length, ≥1. Uses the same centered even-width
   *  footprint convention as world objects. All blocking/wall checks consider
   *  the full footprint when this is > 1. */
  get size(): number {
    return Math.max(1, Math.round(this.def.size ?? 1));
  }

  /** Signed delta from the nearest footprint tile center to (targetX, targetZ).
   *  For size 1 this is just `target - position`. For larger NPCs, range checks
   *  measure to the body instead of the placed coordinate. Reusable by chase AI,
   *  combat range, ranged attack distance, and any callsite that currently does
   *  `target - npc.position`. */
  distToFootprint(targetX: number, targetZ: number): { dx: number; dz: number } {
    const size = this.size;
    if (size <= 1) {
      return { dx: targetX - this.position.x, dz: targetZ - this.position.y };
    }
    const minTileX = getObjectFootprintMinTile(this.position.x, size);
    const minTileZ = getObjectFootprintMinTile(this.position.y, size);
    const minX = minTileX + 0.5;
    const maxX = minTileX + size - 0.5;
    const minZ = minTileZ + 0.5;
    const maxZ = minTileZ + size - 0.5;
    const nearestX = targetX < minX ? minX : (targetX > maxX ? maxX : targetX);
    const nearestZ = targetZ < minZ ? minZ : (targetZ > maxZ ? maxZ : targetZ);
    return { dx: targetX - nearestX, dz: targetZ - nearestZ };
  }

  /** Tiles cardinally adjacent to this NPC's footprint (OSRS interaction
   *  surface). Wraps getObjectInteractionTiles so callers don't need to
   *  remember to pass {width: size}. */
  interactionTiles(): TileCoord[] {
    return getObjectInteractionTiles(this.position.x, this.position.y, { width: this.size });
  }

  isInteractionTile(tileX: number, tileZ: number): boolean {
    return isTileAdjacentToObject(tileX, tileZ, this.position.x, this.position.y, { width: this.size });
  }

  isFootprintTile(tileX: number, tileZ: number): boolean {
    return isTileInsideObjectFootprint(tileX, tileZ, this.position.x, this.position.y, { width: this.size });
  }

  private resetOverlapEscapeDelay(): void {
    this.overlapEscapeDelayTargetId = -1;
    this.overlapEscapeDelayTicks = 0;
  }

  private shouldDelayOverlapEscape(targetId: number): boolean {
    if (this.overlapEscapeDelayTargetId !== targetId) {
      this.overlapEscapeDelayTargetId = targetId;
      this.overlapEscapeDelayTicks = 0;
    }
    if (this.overlapEscapeDelayTicks >= Npc.OVERLAP_ESCAPE_DELAY_TICKS) return false;
    this.overlapEscapeDelayTicks++;
    return true;
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

  private retreatStepAwayFrom(
    targetX: number, targetZ: number,
    isBlocked: (x: number, z: number) => boolean,
    isWallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean,
  ): 'moved' | 'stalled' | 'blocked' {
    const px = Math.floor(this.position.x);
    const pz = Math.floor(this.position.y);
    const fromX = px + 0.5;
    const fromZ = pz + 0.5;
    const awayX = targetX >= fromX ? -1 : 1;
    const awayZ = targetZ >= fromZ ? -1 : 1;

    const stepBlocked = (dx: number, dz: number): boolean => {
      const nx = px + dx + 0.5;
      const nz = pz + dz + 0.5;
      return isBlocked(nx, nz) || !!(isWallBlocked && isWallBlocked(fromX, fromZ, nx, nz));
    };

    const canStep = (dx: number, dz: number, strictMaxRange: boolean): boolean => {
      const nx = px + dx + 0.5;
      const nz = pz + dz + 0.5;
      return this.isPositionWithinMaxRange(nx, nz, strictMaxRange) && !stepBlocked(dx, dz);
    };

    const move = (dx: number, dz: number): 'moved' => {
      const nx = px + dx + 0.5;
      const nz = pz + dz + 0.5;
      this.position.x = nx;
      this.position.y = nz;
      return 'moved';
    };

    // 2004Scape's PLAYERESCAPE first tries a diagonal step directly away
    // from the player. A blocked diagonal ends the mode; the axis fallback
    // only applies when the diagonal would leave the NPC's maxrange box.
    if (stepBlocked(awayX, awayZ)) return 'blocked';
    if (this.isPositionWithinMaxRange(px + awayX + 0.5, pz + awayZ + 0.5, true)) {
      return move(awayX, awayZ);
    }

    const axisDx = targetZ < fromZ ? 0 : awayX;
    const axisDz = targetZ < fromZ ? awayZ : 0;
    if (!this.isPositionWithinMaxRange(px + axisDx + 0.5, pz + axisDz + 0.5, false)) return 'stalled';
    return canStep(axisDx, axisDz, false) ? move(axisDx, axisDz) : 'blocked';
  }

  /** If a player is inside a large NPC's own footprint, ordinary chase can
   *  stall because the target's tile is not an interaction tile and may share
   *  the NPC anchor tile. Step the footprint away from the closest edge until
   *  the player becomes cardinal-adjacent again. */
  private stepOutFromOverlappingTarget(
    targetTileX: number,
    targetTileZ: number,
    isBlocked: (x: number, z: number) => boolean,
    isWallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean,
  ): boolean {
    const size = this.size;
    if (size <= 1) return false;
    const bounds = getObjectFootprintBounds(this.position.x, this.position.y, size);
    if (targetTileX < bounds.minX || targetTileX > bounds.maxX || targetTileZ < bounds.minZ || targetTileZ > bounds.maxZ) {
      return false;
    }

    const px = Math.floor(this.position.x);
    const pz = Math.floor(this.position.y);
    const fromX = px + 0.5;
    const fromZ = pz + 0.5;
    const candidates = [
      { dx: 1, dz: 0, cost: targetTileX - bounds.minX },
      { dx: -1, dz: 0, cost: bounds.maxX - targetTileX },
      { dx: 0, dz: 1, cost: targetTileZ - bounds.minZ },
      { dx: 0, dz: -1, cost: bounds.maxZ - targetTileZ },
    ].sort((a, b) => a.cost - b.cost);

    for (const c of candidates) {
      const nx = px + c.dx + 0.5;
      const nz = pz + c.dz + 0.5;
      if (isBlocked(nx, nz)) continue;
      if (isWallBlocked && isWallBlocked(fromX, fromZ, nx, nz)) continue;
      this.position.x = nx;
      this.position.y = nz;
      return true;
    }
    return false;
  }

  shouldDisengageFromTarget(targetX: number, targetZ: number): boolean {
    return !this.isTargetWithinCombatMaxRange(targetX, targetZ);
  }

  shouldFleeFromCombat(): boolean {
    return this.retreatHealth > 0 && this.health <= this.retreatHealth;
  }

  setCombatTarget(target: Entity | null): void {
    if ((this.combatTarget?.id ?? 0) !== (target?.id ?? 0)) {
      this.syncDirty = true;
      this.resetOverlapEscapeDelay();
    }
    this.combatTarget = target;
  }

  disengageAndReturnHome(): void {
    this.setCombatTarget(null);
    this.retreatTarget = null;
    this.returning = true;
    this.pathQueue.length = 0;
  }

  startRetreatFromTarget(target: Entity): void {
    this.setCombatTarget(null);
    this.retreatTarget = target;
    this.syncDirty = true;
    this.returning = false;
    this.pathQueue.length = 0;
  }

  clearRetreat(): void {
    if (this.retreatTarget) this.syncDirty = true;
    this.retreatTarget = null;
  }

  clearRetreatTarget(targetId: number): void {
    if (this.retreatTarget?.id !== targetId) return;
    this.clearRetreat();
    if (!this.inWanderRange(this.position.x, this.position.y)) {
      this.returning = true;
    }
  }

  processAI(
    isBlocked: (x: number, z: number) => boolean,
    isWallBlocked?: (fx: number, fz: number, tx: number, tz: number) => boolean,
    findPath?: (sx: number, sz: number, gx: number, gz: number) => { x: number; z: number }[],
  ): void {
    if (this.dead) return;

    // --- PLAYERESCAPE-style low-HP retreat ---
    if (this.retreatTarget) {
      this.position.x = Math.floor(this.position.x) + 0.5;
      this.position.y = Math.floor(this.position.y) + 0.5;
      const target = this.retreatTarget;
      const targetX = target.position.x;
      const targetZ = target.position.y;

      if (!target.alive || target.currentMapLevel !== this.currentMapLevel || target.currentFloor !== this.currentFloor) {
        this.clearRetreatTarget(target.id);
        return;
      }

      const targetDist = Math.max(Math.abs(targetX - this.position.x), Math.abs(targetZ - this.position.y));
      if (targetDist > 25 || !this.isRetreatTargetWithinInteractionRange(targetX, targetZ)) {
        this.clearRetreatTarget(target.id);
        return;
      }

      const retreatResult = this.retreatStepAwayFrom(targetX, targetZ, isBlocked, isWallBlocked);
      if (retreatResult === 'blocked') {
        this.clearRetreatTarget(target.id);
      }
      return;
    }

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
      const targetTileX = Math.floor(targetX);
      const targetTileZ = Math.floor(targetZ);

      // 2004Scape checks the spawn-anchored maxrange before continuing an
      // NPC mode. That means a mob disengages even if it is currently
      // adjacent after being dragged outside its allowed area.
      if (this.shouldDisengageFromTarget(targetX, targetZ)) {
        this.disengageAndReturnHome();
        return;
      }

      // Steady state during a fight: adjacent and swinging.
      // Aggressive/non-aggressive both route through here — the def flag
      // gates proactive aggro acquisition (World.ts), not chase persistence
      // once engaged. A non-aggressive NPC that's been hit retaliates and
      // chases under the same spawn-anchored leash above.
      if (this.isInteractionTile(targetTileX, targetTileZ)) {
        this.pathQueue.length = 0;
        this.resetOverlapEscapeDelay();
        return;
      }

      this.pathQueue.length = 0;
      if (this.isFootprintTile(targetTileX, targetTileZ)) {
        if (this.shouldDelayOverlapEscape(this.combatTarget.id)) return;
        if (this.stepOutFromOverlappingTarget(targetTileX, targetTileZ, isBlocked, isWallBlocked)) return;
      } else {
        this.resetOverlapEscapeDelay();
      }
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
    this.setCombatTarget(null);
    this.retreatTarget = null;
    this.respawnTimer = this.respawnTime;
  }

  respawn(): void {
    this.dead = false;
    this.health = this.maxHealth;
    this.position.x = this.spawnX;
    this.position.y = this.spawnZ;
    this.setCombatTarget(null);
    this.retreatTarget = null;
    this.attackCooldown = 0;
    this.wanderCooldown = Math.floor(Math.random() * 15);
    this.returning = false;
    this.pathQueue.length = 0;
    this.facingAngle = this.spawnFacingAngle;
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
