export type CombatActorKind = 'player' | 'npc';
export type CombatMode = 'melee' | 'ranged' | 'magic';
export type CombatLockMode = 'pvm' | 'pvp' | 'duel';
export type ImpactInvalidationPolicy = 'target-only' | 'source-and-target';
export type RetaliationReason = 'auto-retaliate' | 'npc-retaliate' | 'scripted';

export interface CombatActorRef {
  kind: CombatActorKind;
  id: number;
}

export interface CombatIntent {
  actor: CombatActorRef;
  target: CombatActorRef;
  mode: CombatMode;
  createdTick: number;
  spellIndex?: number;
  ammoItemId?: number;
  actionRevision?: number;
}

export interface ActionSchedule {
  actor: CombatActorRef;
  nextAttackTick: number;
}

export interface ImpactQueueEntry<TPayload = unknown> {
  source: CombatActorRef;
  target: CombatActorRef;
  mode: CombatMode;
  launchTick: number;
  impactTick: number;
  mapLevel: string;
  floor: number;
  payload: TPayload;
  invalidationPolicy: ImpactInvalidationPolicy;
}

export interface RetaliationRequest {
  actor: CombatActorRef;
  target: CombatActorRef;
  earliestTick: number;
  reason: RetaliationReason;
}

export interface CombatLockState {
  actor: CombatActorRef;
  target: CombatActorRef;
  lastCombatTick: number;
  mode: CombatLockMode;
}

export interface CombatLaunch<TPayload = unknown> {
  intent: CombatIntent;
  launchTick: number;
  impacts: ImpactQueueEntry<TPayload>[];
}

export interface CombatEffectHooks<
  TLaunch extends CombatLaunch = CombatLaunch,
  TImpact extends ImpactQueueEntry = ImpactQueueEntry,
> {
  onLaunch(launch: TLaunch, context: CombatContext): void;
  onImpact(impact: TImpact, context: CombatContext): void;
  onExpire(impact: TImpact, context: CombatContext): void;
}

export const NO_COMBAT_EFFECT_HOOKS: CombatEffectHooks = Object.freeze({
  onLaunch: () => {},
  onImpact: () => {},
  onExpire: () => {},
});

export interface CombatModeHandler<
  TIntent extends CombatIntent = CombatIntent,
  TLaunch extends CombatLaunch = CombatLaunch,
  TImpact extends ImpactQueueEntry = ImpactQueueEntry,
> {
  readonly effects?: CombatEffectHooks<TLaunch, TImpact>;
  canStart(intent: TIntent, context: CombatContext): boolean;
  startAttack(intent: TIntent, context: CombatContext): TLaunch | null;
  buildImpacts(launch: TLaunch, context: CombatContext): TImpact[];
  onImpact(impact: TImpact, context: CombatContext): void;
}

export interface CombatTickPhases {
  advanceSchedules(): void;
  resumeQueuedCasts(): void;
  startPlayerIntents(): void;
  startNpcIntents(): void;
  resolveImpacts(): void;
  finishTick(): void;
}

export interface CombatContext extends CombatTickPhases {
  readonly currentTick: number;
  readonly rng: () => number;
}

export class CombatSystem {
  private readonly intents = new Map<string, CombatIntent>();
  private readonly schedules = new Map<string, ActionSchedule>();
  private impactQueue: ImpactQueueEntry[] = [];
  private retaliationQueue: RetaliationRequest[] = [];
  private readonly locks = new Map<string, CombatLockState>();

  tick(context: CombatContext): void {
    context.advanceSchedules();
    context.resumeQueuedCasts();
    context.startPlayerIntents();
    context.startNpcIntents();
    context.resolveImpacts();
    context.finishTick();
  }

  getIntent(actor: CombatActorRef): CombatIntent | undefined {
    return this.intents.get(this.actorKey(actor));
  }

  listIntents(): CombatIntent[] {
    return [...this.intents.values()];
  }

  setIntent(intent: CombatIntent): void {
    this.intents.set(this.actorKey(intent.actor), intent);
  }

  clearIntent(actor: CombatActorRef): boolean {
    return this.intents.delete(this.actorKey(actor));
  }

  clearIntentPair(actor: CombatActorRef, target: CombatActorRef): boolean {
    const key = this.actorKey(actor);
    const intent = this.intents.get(key);
    if (!intent || !this.sameActor(intent.target, target)) return false;
    return this.intents.delete(key);
  }

  setSchedule(schedule: ActionSchedule): void {
    this.schedules.set(this.actorKey(schedule.actor), schedule);
  }

  armSchedule(actor: CombatActorRef, currentTick: number, cooldownTicks: number): number {
    const ticks = Math.max(0, Math.floor(cooldownTicks));
    if (ticks <= 0) {
      this.clearSchedule(actor);
      return 0;
    }
    this.setSchedule({ actor, nextAttackTick: currentTick + ticks });
    return ticks;
  }

  adoptScheduleFromCooldown(actor: CombatActorRef, currentTick: number, cooldownTicks: number): number {
    const existing = this.getSchedule(actor);
    if (existing) return this.cooldownRemaining(actor, currentTick);

    const ticks = Math.max(0, Math.floor(cooldownTicks));
    const remainingAfterThisTick = ticks - 1;
    if (remainingAfterThisTick <= 0) {
      this.clearSchedule(actor);
      return 0;
    }
    this.setSchedule({ actor, nextAttackTick: currentTick + remainingAfterThisTick });
    return this.cooldownRemaining(actor, currentTick);
  }

  cooldownRemaining(actor: CombatActorRef, currentTick: number): number {
    const schedule = this.getSchedule(actor);
    if (!schedule) return 0;
    return Math.max(0, schedule.nextAttackTick - currentTick);
  }

  advanceSchedule(actor: CombatActorRef, currentTick: number): number {
    const remaining = this.cooldownRemaining(actor, currentTick);
    if (remaining <= 0) this.clearSchedule(actor);
    return remaining;
  }

  getSchedule(actor: CombatActorRef): ActionSchedule | undefined {
    return this.schedules.get(this.actorKey(actor));
  }

  clearSchedule(actor: CombatActorRef): boolean {
    return this.schedules.delete(this.actorKey(actor));
  }

  listSchedules(): ActionSchedule[] {
    return [...this.schedules.values()];
  }

  enqueueImpact<TPayload>(impact: ImpactQueueEntry<TPayload>): void {
    this.impactQueue.push(impact);
  }

  listImpacts(): readonly ImpactQueueEntry[] {
    return [...this.impactQueue];
  }

  takeDueImpacts(currentTick: number): ImpactQueueEntry[] {
    return this.takeDueImpactsWhere(currentTick, () => true);
  }

  takeDueImpactsWhere(currentTick: number, predicate: (impact: ImpactQueueEntry) => boolean): ImpactQueueEntry[] {
    const due: ImpactQueueEntry[] = [];
    const remaining: ImpactQueueEntry[] = [];
    for (const impact of this.impactQueue) {
      if (impact.impactTick <= currentTick && predicate(impact)) due.push(impact);
      else remaining.push(impact);
    }
    this.impactQueue = remaining;
    return due;
  }

  removeImpactsWhere(predicate: (impact: ImpactQueueEntry) => boolean): number {
    const before = this.impactQueue.length;
    this.impactQueue = this.impactQueue.filter(impact => !predicate(impact));
    return before - this.impactQueue.length;
  }

  clearImpactsForActor(actor: CombatActorRef): number {
    const before = this.impactQueue.length;
    this.impactQueue = this.impactQueue.filter(impact =>
      !this.sameActor(impact.source, actor) && !this.sameActor(impact.target, actor)
    );
    return before - this.impactQueue.length;
  }

  clearTargetOwnedImpacts(target: CombatActorRef): number {
    const before = this.impactQueue.length;
    this.impactQueue = this.impactQueue.filter(impact => !this.sameActor(impact.target, target));
    return before - this.impactQueue.length;
  }

  enqueueRetaliation(request: RetaliationRequest): void {
    this.retaliationQueue.push(request);
  }

  listRetaliationRequests(): readonly RetaliationRequest[] {
    return [...this.retaliationQueue];
  }

  takeDueRetaliation(currentTick: number): RetaliationRequest[] {
    const due: RetaliationRequest[] = [];
    const future: RetaliationRequest[] = [];
    for (const request of this.retaliationQueue) {
      if (request.earliestTick <= currentTick) due.push(request);
      else future.push(request);
    }
    this.retaliationQueue = future;
    return due;
  }

  clearRetaliationForActor(actor: CombatActorRef): number {
    const before = this.retaliationQueue.length;
    this.retaliationQueue = this.retaliationQueue.filter(request =>
      !this.sameActor(request.actor, actor) && !this.sameActor(request.target, actor)
    );
    return before - this.retaliationQueue.length;
  }

  setLock(lock: CombatLockState): void {
    this.locks.set(this.actorKey(lock.actor), lock);
  }

  refreshLock(actor: CombatActorRef, target: CombatActorRef, currentTick: number, mode: CombatLockMode): void {
    this.setLock({ actor, target, lastCombatTick: currentTick, mode });
  }

  getLock(actor: CombatActorRef): CombatLockState | undefined {
    return this.locks.get(this.actorKey(actor));
  }

  clearLock(actor: CombatActorRef): boolean {
    return this.locks.delete(this.actorKey(actor));
  }

  clearLocksForActor(actor: CombatActorRef): number {
    let cleared = 0;
    for (const [key, lock] of this.locks) {
      if (this.sameActor(lock.actor, actor) || this.sameActor(lock.target, actor)) {
        this.locks.delete(key);
        cleared++;
      }
    }
    return cleared;
  }

  listLocks(): CombatLockState[] {
    return [...this.locks.values()];
  }

  clearExpiredLocks(currentTick: number, durationTicks: number): number {
    let cleared = 0;
    for (const [key, lock] of this.locks) {
      if (currentTick - lock.lastCombatTick >= durationTicks) {
        this.locks.delete(key);
        cleared++;
      }
    }
    return cleared;
  }

  canAttack(actor: CombatActorRef, target: CombatActorRef, currentTick: number, durationTicks: number, mode?: CombatLockMode): boolean {
    for (const lock of this.locks.values()) {
      if (mode && lock.mode !== mode) continue;
      if (!this.sameActor(lock.target, target)) continue;
      if (this.sameActor(lock.actor, actor)) continue;
      if (currentTick - lock.lastCombatTick < durationTicks) return false;
    }
    return true;
  }

  clearActor(actor: CombatActorRef): void {
    this.clearIntent(actor);
    this.clearSchedule(actor);
    this.clearImpactsForActor(actor);
    this.clearRetaliationForActor(actor);
    this.clearLocksForActor(actor);
  }

  private actorKey(actor: CombatActorRef): string {
    return `${actor.kind}:${actor.id}`;
  }

  private sameActor(a: CombatActorRef, b: CombatActorRef): boolean {
    return a.kind === b.kind && a.id === b.id;
  }
}
