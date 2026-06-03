import { describe, expect, test } from 'bun:test';
import {
  CombatSystem,
  NO_COMBAT_EFFECT_HOOKS,
  type CombatActorRef,
  type CombatContext,
  type CombatIntent,
  type ImpactQueueEntry,
} from '../src/combat/CombatSystem';

const player = (id: number): CombatActorRef => ({ kind: 'player', id });
const npc = (id: number): CombatActorRef => ({ kind: 'npc', id });

function fakeContext(calls: string[] = []): CombatContext {
  return {
    currentTick: 10,
    rng: () => 0.125,
    advanceSchedules: () => calls.push('advanceSchedules'),
    resumeQueuedCasts: () => calls.push('resumeQueuedCasts'),
    startPlayerIntents: () => calls.push('startPlayerIntents'),
    startNpcIntents: () => calls.push('startNpcIntents'),
    resolveImpacts: () => calls.push('resolveImpacts'),
    finishTick: () => calls.push('finishTick'),
  };
}

function intent(actor: CombatActorRef, target: CombatActorRef, createdTick = 1): CombatIntent {
  return {
    actor,
    target,
    mode: 'melee',
    createdTick,
  };
}

function impact(label: string, source: CombatActorRef, target: CombatActorRef, impactTick: number): ImpactQueueEntry<{ label: string }> {
  return {
    source,
    target,
    mode: 'magic',
    launchTick: impactTick - 2,
    impactTick,
    mapLevel: 'kcmap',
    floor: 0,
    payload: { label },
    invalidationPolicy: 'target-only',
  };
}

describe('CombatSystem', () => {
  test('runs combat phases in the preserved World tick order', () => {
    const calls: string[] = [];
    const system = new CombatSystem();

    system.tick(fakeContext(calls));

    expect(calls).toEqual([
      'advanceSchedules',
      'resumeQueuedCasts',
      'startPlayerIntents',
      'startNpcIntents',
      'resolveImpacts',
      'finishTick',
    ]);
  });

  test('stores persistent intents separately from absolute attack schedules', () => {
    const system = new CombatSystem();
    const actor = player(1);
    const target = npc(100);
    const combatIntent = intent(actor, target, 7);

    system.setIntent(combatIntent);
    system.setSchedule({ actor, nextAttackTick: 12 });

    expect(system.getIntent(actor)).toEqual(combatIntent);
    expect(system.getSchedule(actor)).toEqual({ actor, nextAttackTick: 12 });
    expect(system.clearIntentPair(actor, npc(999))).toBe(false);
    expect(system.getIntent(actor)).toEqual(combatIntent);
    expect(system.clearIntentPair(actor, target)).toBe(true);
    expect(system.getSchedule(actor)).toEqual({ actor, nextAttackTick: 12 });
  });

  test('absolute schedules are the cooldown source of truth', () => {
    const system = new CombatSystem();
    const actor = player(1);

    expect(system.armSchedule(actor, 10, 4)).toBe(4);
    expect(system.getSchedule(actor)).toEqual({ actor, nextAttackTick: 14 });
    expect(system.advanceSchedule(actor, 11)).toBe(3);
    expect(system.advanceSchedule(actor, 13)).toBe(1);
    expect(system.advanceSchedule(actor, 14)).toBe(0);
    expect(system.getSchedule(actor)).toBeUndefined();
  });

  test('legacy cooldown adoption preserves the old first tick decrement', () => {
    const system = new CombatSystem();
    const actor = player(1);

    expect(system.adoptScheduleFromCooldown(actor, 11, 4)).toBe(3);
    expect(system.getSchedule(actor)).toEqual({ actor, nextAttackTick: 14 });
    expect(system.advanceSchedule(actor, 12)).toBe(2);
  });

  test('legacy cooldown adoption clears schedules that become ready immediately', () => {
    const system = new CombatSystem();
    const actor = player(1);

    expect(system.adoptScheduleFromCooldown(actor, 11, 1)).toBe(0);
    expect(system.getSchedule(actor)).toBeUndefined();
  });

  test('partitions due impacts without dropping future projectile or spell impacts', () => {
    const system = new CombatSystem();
    const due = impact('due', player(1), npc(100), 5);
    const future = impact('future', player(2), npc(101), 8);

    system.enqueueImpact(future);
    system.enqueueImpact(due);

    expect(system.takeDueImpacts(5)).toEqual([due]);
    expect(system.listImpacts()).toEqual([future]);
    expect(system.takeDueImpacts(7)).toEqual([]);
    expect(system.takeDueImpacts(8)).toEqual([future]);
  });

  test('impact and retaliation listings are snapshots, not mutable backing queues', () => {
    const system = new CombatSystem();
    const queuedImpact = impact('queued', player(1), npc(100), 5);
    const queuedRetaliation = { actor: player(1), target: npc(100), earliestTick: 5, reason: 'auto-retaliate' as const };

    system.enqueueImpact(queuedImpact);
    system.enqueueRetaliation(queuedRetaliation);

    (system.listImpacts() as ImpactQueueEntry[]).length = 0;
    (system.listRetaliationRequests() as typeof queuedRetaliation[]).length = 0;

    expect(system.takeDueImpacts(5)).toEqual([queuedImpact]);
    expect(system.takeDueRetaliation(5)).toEqual([queuedRetaliation]);
  });

  test('filtered impact draining leaves other due impact types queued', () => {
    const system = new CombatSystem();
    const spell = impact('spell', player(1), npc(100), 5);
    const projectile = { ...impact('projectile', player(2), npc(101), 5), mode: 'ranged' as const };

    system.enqueueImpact(spell);
    system.enqueueImpact(projectile);

    expect(system.takeDueImpactsWhere(5, queued => queued.mode === 'magic')).toEqual([spell]);
    expect(system.listImpacts()).toEqual([projectile]);
  });

  test('queues retaliation and stores combat locks without immediate recursion', () => {
    const system = new CombatSystem();
    const actor = player(1);
    const target = npc(100);
    const later = { actor, target, earliestTick: 11, reason: 'auto-retaliate' as const };
    const ready = { actor: target, target: actor, earliestTick: 10, reason: 'npc-retaliate' as const };

    system.enqueueRetaliation(later);
    system.enqueueRetaliation(ready);
    system.setLock({ actor, target, lastCombatTick: 10, mode: 'pvm' });

    expect(system.takeDueRetaliation(10)).toEqual([ready]);
    expect(system.listRetaliationRequests()).toEqual([later]);
    expect(system.getLock(actor)).toEqual({ actor, target, lastCombatTick: 10, mode: 'pvm' });
  });

  test('combat locks block third-party attacks until they expire', () => {
    const system = new CombatSystem();
    const first = player(1);
    const second = player(2);
    const target = npc(100);

    system.refreshLock(first, target, 10, 'pvm');

    expect(system.canAttack(first, target, 12, 8, 'pvm')).toBe(true);
    expect(system.canAttack(second, target, 12, 8, 'pvm')).toBe(false);
    expect(system.clearExpiredLocks(18, 8)).toBe(1);
    expect(system.canAttack(second, target, 18, 8, 'pvm')).toBe(true);
  });

  test('death cleanup can clear every combat-owned reference for an actor', () => {
    const system = new CombatSystem();
    const actor = player(1);
    const target = npc(100);

    system.setIntent(intent(actor, target));
    system.setSchedule({ actor, nextAttackTick: 12 });
    system.enqueueImpact(impact('owned-source', actor, target, 12));
    system.enqueueImpact(impact('owned-target', target, actor, 12));
    system.enqueueRetaliation({ actor, target, earliestTick: 12, reason: 'auto-retaliate' });
    system.enqueueRetaliation({ actor: target, target: actor, earliestTick: 12, reason: 'npc-retaliate' });
    system.setLock({ actor, target, lastCombatTick: 10, mode: 'pvm' });
    system.setLock({ actor: target, target: actor, lastCombatTick: 10, mode: 'pvm' });

    system.clearActor(actor);

    expect(system.getIntent(actor)).toBeUndefined();
    expect(system.getSchedule(actor)).toBeUndefined();
    expect(system.listImpacts()).toEqual([]);
    expect(system.listRetaliationRequests()).toEqual([]);
    expect(system.listLocks()).toEqual([]);
  });

  test('effect hooks default to no-ops for future magic schools', () => {
    const context = fakeContext();
    const combatIntent = intent(player(1), npc(100));
    const magicImpact = impact('spell', combatIntent.actor, combatIntent.target, 12);

    expect(() => {
      NO_COMBAT_EFFECT_HOOKS.onLaunch({ intent: combatIntent, launchTick: 10, impacts: [magicImpact] }, context);
      NO_COMBAT_EFFECT_HOOKS.onImpact(magicImpact, context);
      NO_COMBAT_EFFECT_HOOKS.onExpire(magicImpact, context);
    }).not.toThrow();
    expect(context.rng()).toBe(0.125);
  });
});
