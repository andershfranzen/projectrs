import { describe, expect, test } from 'bun:test';
import {
  appendCommandProof,
  decodePacket,
  decodeQuantityValues,
  decodeStringPacket,
  encodePacket,
  encodeQuantityPacket,
  encodeStringPacket,
  stripCommandProof,
} from './protocol';
import { ClientOpcode } from './opcodes';

const MAX_STACK = 0x7FFFFFFF;

describe('encodePacket / decodePacket round-trip', () => {
  test('round-trips signed int16 values', () => {
    const { opcode, values } = decodePacket(encodePacket(12, 1, -1, 32767, -32768, 0).buffer as ArrayBuffer);
    expect(opcode).toBe(12);
    expect(values).toEqual([1, -1, 32767, -32768, 0]);
  });

  test('throws when a value cannot fit a 16-bit field (data loss)', () => {
    // Outside [-32768, 65535] silently truncates on the wire — must be caught.
    expect(() => encodePacket(12, 70000)).toThrow(RangeError);
    expect(() => encodePacket(12, -40000)).toThrow(RangeError);
    expect(() => encodePacket(12, 1.5)).toThrow(RangeError);
  });

  test('accepts already-masked unsigned half-words (0..65535)', () => {
    // High/low split fields legitimately pass values up to 0xFFFF.
    expect(() => encodePacket(12, 0xFFFF, 40000, 60000)).not.toThrow();
  });
});

describe('quantity high/low split', () => {
  // The split is what protects inventory/ground/bank/shop/xp stacks past int16.
  for (const q of [0, 1, 32767, 32768, 65535, 100000, MAX_STACK]) {
    test(`round-trips quantity ${q}`, () => {
      const hi = (q >>> 16) & 0xFFFF;
      const lo = q & 0xFFFF;
      const decoded = (hi & 0xFFFF) * 0x10000 + (lo & 0xFFFF);
      expect(decoded).toBe(q);
    });
  }

  test('a raw int16 quantity past 32767 wraps — proving the split is required', () => {
    // This is the bug class the split fixes: 40000 sent as one int16 reads negative.
    const { values } = decodePacket(encodePacket(12, 40000 & 0xFFFF).buffer as ArrayBuffer);
    expect(values[0]).toBe(-25536);
  });

  test('encodeQuantityPacket / decodeQuantityValues handle -1 sentinel and large stacks', () => {
    expect(decodeQuantityValues(decodePacket(encodeQuantityPacket(99, 3, 10, -1).buffer as ArrayBuffer).values)).toBe(-1);
    for (const q of [1, 32768, MAX_STACK]) {
      const values = decodePacket(encodeQuantityPacket(99, 3, 10, q).buffer as ArrayBuffer).values;
      expect(decodeQuantityValues(values)).toBe(q);
    }
  });
});

describe('decodeStringPacket bounds', () => {
  test('round-trips a string with trailing int16 values', () => {
    const decoded = decodeStringPacket(encodeStringPacket(60, 'kcmap', 5, -2).buffer as ArrayBuffer);
    expect(decoded.str).toBe('kcmap');
    expect(decoded.values).toEqual([5, -2]);
  });

  test('rejects a declared length past the buffer', () => {
    // Hostile client claims a long string in a short packet.
    const buf = new Uint8Array([60, 0xFF, 0xFF, 0x41]); // declares 65535 bytes, has 1
    expect(() => decodeStringPacket(buf.buffer as ArrayBuffer)).toThrow(RangeError);
  });
});

describe('protected command proof trailer', () => {
  test('appends and strips one-shot input and action capability proof', () => {
    const packet = appendCommandProof(encodePacket(ClientOpcode.PLAYER_INTERACT_OBJECT, 10042, 2), {
      inputSeq: 17,
      capabilityId: 91,
      capabilityCode: 1234,
    });
    const decoded = decodePacket(packet.buffer as ArrayBuffer);
    expect(decoded.opcode).toBe(ClientOpcode.PLAYER_INTERACT_OBJECT);
    const stripped = stripCommandProof(decoded.values);
    expect(stripped.values).toEqual([10042, 2]);
    expect(stripped.proof).toEqual({ inputSeq: 17, capabilityId: 91, capabilityCode: 1234 });
  });

  test('leaves ordinary values untouched when no trailer marker exists', () => {
    const stripped = stripCommandProof([3, 10, 1, 2]);
    expect(stripped.values).toEqual([3, 10, 1, 2]);
    expect(stripped.proof).toBeNull();
  });

  test('rejects zero as a command input proof seq', () => {
    const packet = appendCommandProof(encodePacket(ClientOpcode.PLAYER_MOVE, 0), {
      inputSeq: 0,
      capabilityId: 0,
      capabilityCode: 0,
    });
    const decoded = decodePacket(packet.buffer as ArrayBuffer);
    const stripped = stripCommandProof(decoded.values);
    expect(stripped.values).toEqual([0]);
    expect(stripped.proof).toBeNull();
  });
});
