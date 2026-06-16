import { describe, expect, test } from 'bun:test';
import { ClientActivityKind, ClientOpcode, decodePacket, encodePacket, stripCommandProof } from '@projectrs/shared';
import { NetworkManager } from './NetworkManager';

function makeManager(): any {
  const manager = Object.create(NetworkManager.prototype) as any;
  manager.pendingInputTicketSeq = 7;
  manager.inputTicketBurst = {
    kind: ClientActivityKind.Pointer,
    x: 500,
    y: 500,
    remaining: 1,
    expiresAt: performance.now() + 1_000,
  };
  manager.actionCapabilityResolver = null;
  manager.sendInputTicket = () => 8;
  return manager;
}

function proofSeq(packet: Uint8Array): number | null {
  const { values } = decodePacket(packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer);
  return stripCommandProof(values).proof?.inputSeq ?? null;
}

describe('NetworkManager command proof protection', () => {
  test('trusted input bursts can fund chained move plus action packets once', () => {
    const manager = makeManager();

    expect(proofSeq(manager.protectOutgoingPacket(encodePacket(ClientOpcode.PLAYER_MOVE, 0)))).toBe(7);
    expect(proofSeq(manager.protectOutgoingPacket(encodePacket(ClientOpcode.PLAYER_PICKUP_ITEM, 123)))).toBe(8);
    expect(proofSeq(manager.protectOutgoingPacket(encodePacket(ClientOpcode.PLAYER_PICKUP_ITEM, 124)))).toBe(null);
  });
});
