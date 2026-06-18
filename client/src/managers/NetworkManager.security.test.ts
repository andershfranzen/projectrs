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

  test('action capabilities can protect repeated clicks with fresh target proofs', () => {
    const manager = makeManager();
    manager.pendingInputTicketSeq = null;
    manager.inputTicketBurst.remaining = 2;
    const caps = [{ id: 123, code: 456 }, { id: 789, code: 987 }];
    manager.actionCapabilityResolver = (opcode: ClientOpcode, values: number[]) => {
      if (opcode === ClientOpcode.PLAYER_INTERACT_OBJECT && values[0] === 10042 && values[1] === 0) {
        return caps.shift() ?? null;
      }
      return null;
    };

    const first = commandProof(manager.protectOutgoingPacket(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, 10042, 0)));
    const second = commandProof(manager.protectOutgoingPacket(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, 10042, 0)));

    expect(first).toMatchObject({ capabilityId: 123, capabilityCode: 456 });
    expect(second).toMatchObject({ capabilityId: 789, capabilityCode: 987 });
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

  test('input shape keeps normalized pointer trail points', () => {
    const oldWindow = (globalThis as any).window;
    const oldDocument = (globalThis as any).document;
    (globalThis as any).window = { innerWidth: 1000, innerHeight: 500 };
    (globalThis as any).document = { visibilityState: 'visible', documentElement: {} };
    try {
      const manager = makeManager();
      manager.pointerInputSamples = [
        { t: 10, x: 100, y: 50, c: 0 },
        { t: 20, x: 500, y: 250, c: 0 },
      ];
      manager.trimPointerInputSamples = () => {};
      manager.lastPointerFlags = 3;
      manager.lastPointerButtons = 1;
      manager.lastPointerDwellMs = 12;

      expect(manager.inputShapeStats(ClientActivityKind.Pointer).trail).toEqual([100, 100, 500, 500]);
    } finally {
      (globalThis as any).window = oldWindow;
      (globalThis as any).document = oldDocument;
    }
  });

  test('cursor trace flush sends raw viewport samples', () => {
    const oldWindow = (globalThis as any).window;
    const oldDocument = (globalThis as any).document;
    (globalThis as any).window = { innerWidth: 800, innerHeight: 600 };
    (globalThis as any).document = { documentElement: {} };
    try {
      const manager = makeManager();
      const now = performance.now();
      const sent: Uint8Array[] = [];
      manager.connected = true;
      manager.gameSocket = { readyState: WebSocket.OPEN, bufferedAmount: 0 };
      manager.cursorTraceSamples = [{ t: now - 25, x: 12.4, y: 34.6, buttons: 1, flags: 73 }];
      manager.sendRawUnprotected = (packet: Uint8Array) => {
        sent.push(packet);
        return true;
      };

      manager.flushCursorTrace(true);

      expect(sent).toHaveLength(1);
      const decoded = decodePacket(sent[0].buffer.slice(sent[0].byteOffset, sent[0].byteOffset + sent[0].byteLength) as ArrayBuffer);
      expect(decoded.opcode).toBe(ClientOpcode.CURSOR_TRACE);
      expect(decoded.values.slice(0, 3)).toEqual([800, 600, 1]);
      expect(decoded.values.slice(4)).toEqual([12, 35, 1, 73]);
      expect(manager.cursorTraceSamples).toHaveLength(0);
    } finally {
      (globalThis as any).window = oldWindow;
      (globalThis as any).document = oldDocument;
    }
  });

  test('pointer input records coalesced cursor trace samples', () => {
    const oldWindow = (globalThis as any).window;
    const oldDocument = (globalThis as any).document;
    (globalThis as any).window = { innerWidth: 1000, innerHeight: 500 };
    (globalThis as any).document = { visibilityState: 'visible', documentElement: {} };
    const manager = makeManager();
    manager.cursorTraceSamples = [];
    manager.pointerInputSamples = [];
    manager.lastPointerDownAt = null;
    manager.lastPointerDwellMs = 0;
    manager.lastPointerFlags = 0;
    manager.lastPointerButtons = 0;
    manager.lastCursorTraceSentAt = -Infinity;
    manager.scheduleCursorTraceFlush = () => {};
    manager.trimPointerInputSamples = () => {};

    try {
      manager.recordPointerInput({
        type: 'pointermove',
        pointerType: 'mouse',
        isTrusted: true,
        buttons: 1,
        clientX: 10,
        clientY: 20,
        timeStamp: 100,
        getCoalescedEvents: () => [
          { clientX: 11, clientY: 21, buttons: 1, timeStamp: 101 },
          { clientX: 12, clientY: 22, buttons: 1, timeStamp: 102 },
        ],
      } as any);

      expect(manager.cursorTraceSamples.map((sample: any) => [sample.t, sample.x, sample.y, sample.buttons, sample.flags])).toEqual([
        [101, 11, 21, 1, 73],
        [102, 12, 22, 1, 73],
      ]);
      expect(manager.inputShapeStats(ClientActivityKind.Pointer).coalescedCount).toBe(2);
    } finally {
      (globalThis as any).window = oldWindow;
      (globalThis as any).document = oldDocument;
    }
  });
});
