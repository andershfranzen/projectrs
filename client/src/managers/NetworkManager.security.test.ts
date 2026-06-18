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

function commandProof(packet: Uint8Array) {
  const { values } = decodePacket(packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer);
  return stripCommandProof(values).proof;
}

describe('NetworkManager command proof protection', () => {
  test('trusted input bursts can fund chained move plus action packets once', () => {
    const manager = makeManager();

    expect(proofSeq(manager.protectOutgoingPacket(encodePacket(ClientOpcode.PLAYER_MOVE, 0)))).toBe(7);
    expect(proofSeq(manager.protectOutgoingPacket(encodePacket(ClientOpcode.PLAYER_PICKUP_ITEM, 123)))).toBe(8);
    expect(proofSeq(manager.protectOutgoingPacket(encodePacket(ClientOpcode.PLAYER_PICKUP_ITEM, 124)))).toBe(null);
  });

  test('action capabilities can protect repeated clicks on the same visible target', () => {
    const manager = makeManager();
    manager.pendingInputTicketSeq = null;
    manager.inputTicketBurst.remaining = 2;
    manager.actionCapabilityResolver = (opcode: ClientOpcode, values: number[]) => {
      if (opcode === ClientOpcode.PLAYER_INTERACT_OBJECT && values[0] === 10042 && values[1] === 0) {
        return { id: 123, code: 456 };
      }
      return null;
    };

    const first = commandProof(manager.protectOutgoingPacket(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, 10042, 0)));
    const second = commandProof(manager.protectOutgoingPacket(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, 10042, 0)));

    expect(first).toMatchObject({ capabilityId: 123, capabilityCode: 456 });
    expect(second).toMatchObject({ capabilityId: 123, capabilityCode: 456 });
  });

  test('move packets fail instead of silently truncating overlong paths', () => {
    const manager = makeManager();
    let sent = false;
    manager.connected = true;
    manager.gameSocket = { readyState: WebSocket.OPEN, bufferedAmount: 0 };
    manager.sendRaw = () => {
      sent = true;
      return true;
    };
    manager.failGameSocket = () => {};
    const path = Array.from({ length: 51 }, (_, index) => ({ x: index + 0.5, z: 0.5 }));

    expect(manager.sendMove(path)).toBe(false);
    expect(sent).toBe(false);
  });

  test('movement sends are locally capped below the server movement bucket', () => {
    const manager = makeManager();
    let sent = 0;
    manager.connected = true;
    manager.gameSocket = { readyState: WebSocket.OPEN, bufferedAmount: 0 };
    manager.recentMoveSendTimes = [];
    manager.sendRaw = () => {
      sent++;
      return true;
    };
    manager.failGameSocket = () => {};

    for (let i = 0; i < 7; i++) {
      expect(manager.sendMove([{ x: i + 0.5, z: 0.5 }])).toBe(true);
    }
    expect(manager.sendMove([{ x: 9.5, z: 0.5 }])).toBe(false);
    expect(sent).toBe(7);

    expect(manager.sendMove([])).toBe(true);
    expect(sent).toBe(8);

    manager.recentMoveSendTimes = manager.recentMoveSendTimes.map((sentAt: number) => sentAt - 1_001);

    expect(manager.sendMove([{ x: 10.5, z: 0.5 }])).toBe(true);
    expect(sent).toBe(9);
  });
});
