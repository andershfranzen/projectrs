import { describe, expect, test } from 'bun:test';
import { ActionCapabilityKind, ClientActivityKind } from '@projectrs/shared';
import { Player } from './Player';

function makePlayer(): Player {
  return new Player('security-test', 0, 0, {} as Player['ws']);
}

describe('Player command proof security state', () => {
  test('input tickets are fresh and one-shot', () => {
    const player = makePlayer();
    player.registerInputTicket(ClientActivityKind.Pointer, 7, 500, 500, 1_000);

    expect(player.consumeInputTicket(7, 1_100, 5_000)?.kind).toBe(ClientActivityKind.Pointer);
    expect(player.consumeInputTicket(7, 1_200, 5_000)).toBeNull();

    player.registerInputTicket(ClientActivityKind.Pointer, 8, 500, 500, 1_000);
    expect(player.consumeInputTicket(8, 7_000, 5_000)).toBeNull();
  });

  test('input ticket seq zero is reserved for missing proof', () => {
    const player = makePlayer();
    player.registerInputTicket(ClientActivityKind.Pointer, 0, 500, 500, 1_000);
    expect(player.consumeInputTicket(0, 1_100, 5_000)).toBeNull();
  });

  test('input tickets preserve kind and coordinates', () => {
    const player = makePlayer();
    player.registerInputTicket(ClientActivityKind.Touch, 9, 100, 900, 1_000);
    expect(player.consumeInputTicket(9, 1_100, 5_000)).toEqual({
      kind: ClientActivityKind.Touch,
      seq: 9,
      x: 100,
      y: 900,
      issuedAt: 1_000,
    });
  });

  test('action capabilities are scoped to kind, target, and action', () => {
    const player = makePlayer();
    const cap = player.issueActionCapability(ActionCapabilityKind.WorldObject, 10042, 2, 15, false, 10);

    expect(player.consumeActionCapability(cap.id, cap.code, ActionCapabilityKind.WorldObject, 10042, 3, 11)).toBe('mismatch');
    expect(player.consumeActionCapability(cap.id, cap.code, ActionCapabilityKind.WorldObject, 10042, 2, 11)).toBe('missing');

    const okCap = player.issueActionCapability(ActionCapabilityKind.WorldObject, 10042, 2, 15, false, 11);
    expect(player.consumeActionCapability(okCap.id, okCap.code + 1, ActionCapabilityKind.WorldObject, 10042, 2, 12)).toBe('missing');
    expect(player.consumeActionCapability(okCap.id, okCap.code, ActionCapabilityKind.WorldObject, 10042, 2, 12)).toBe('ok');
    expect(player.consumeActionCapability(okCap.id, okCap.code, ActionCapabilityKind.WorldObject, 10042, 2, 12)).toBe('missing');

    const expiredCap = player.issueActionCapability(ActionCapabilityKind.WorldObject, 10042, 2, 15, false, 12);
    expect(player.consumeActionCapability(expiredCap.id, expiredCap.code, ActionCapabilityKind.WorldObject, 10042, 2, 16)).toBe('expired');
  });

  test('action capability snapshots rotate reusable target proofs', () => {
    const player = makePlayer();
    const first = player.issueActionCapability(ActionCapabilityKind.Npc, 1234, 0, 15, false, 10);
    const second = player.issueActionCapability(ActionCapabilityKind.Npc, 1234, 0, 18, false, 12);

    expect(second.id).not.toBe(first.id);
    expect(player.consumeActionCapability(second.id, second.code, ActionCapabilityKind.Npc, 1234, 0, 13)).toBe('ok');
    expect(player.consumeActionCapability(second.id, second.code, ActionCapabilityKind.Npc, 1234, 0, 13)).toBe('missing');
  });

  test('honeypot capabilities are distinguishable from stale or mismatched caps', () => {
    const player = makePlayer();
    const cap = player.issueActionCapability(ActionCapabilityKind.WorldObject, 32760, 13, 15, true, 10);

    expect(player.consumeHoneypotActionCapability(cap.id, cap.code, 11)).toBe(true);
    expect(player.consumeActionCapability(cap.id, cap.code, ActionCapabilityKind.WorldObject, 32760, 13, 11)).toBe('missing');
  });
});
