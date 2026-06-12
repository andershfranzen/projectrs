// Binary protocol helpers for game socket
// All game packets: [opcode (1 byte), ...payload]

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// Reusable encode buffer — grows as needed to avoid per-call allocation.
let _encBuf = new ArrayBuffer(256);
let _encView = new DataView(_encBuf);
let _encU8 = new Uint8Array(_encBuf);

function ensureEncodeCapacity(needed: number): void {
  if (_encBuf.byteLength >= needed) return;
  const size = Math.max(needed, _encBuf.byteLength * 2);
  _encBuf = new ArrayBuffer(size);
  _encView = new DataView(_encBuf);
  _encU8 = new Uint8Array(_encBuf);
}

// Dev-only guard: a value passed to setInt16 only round-trips if it fits 16
// bits as a signed value [-32768, 32767] OR an already-masked unsigned value
// [0, 65535] (the high/low split fields deliberately use the unsigned half).
// Anything outside [-32768, 65535] silently loses data on the wire. Off in the
// browser (no `process`) and in production — this is a development trip-wire.
// Accessed via globalThis so this typechecks in browser/editor builds that
// don't pull in Node's `process` typings.
const _proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
const DEV_ENCODE_ASSERT = _proc !== undefined && _proc.env?.NODE_ENV !== 'production';

export function encodePacket(opcode: number, ...values: number[]): Uint8Array {
  const len = 1 + values.length * 2;
  ensureEncodeCapacity(len);
  _encView.setUint8(0, opcode);
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (DEV_ENCODE_ASSERT && (!Number.isInteger(value) || value < -32768 || value > 0xFFFF)) {
      throw new RangeError(
        `encodePacket: value ${value} at index ${i} (opcode ${opcode}) does not fit a 16-bit field — split large numbers into high/low words`,
      );
    }
    _encView.setInt16(1 + i * 2, value);
  }
  return _encU8.slice(0, len);
}

export function encodeQuantityPacket(opcode: number, slot: number, expectedItemId: number, quantity: number): Uint8Array {
  if (quantity === -1 || (quantity >= -32768 && quantity <= 32767)) {
    return encodePacket(opcode, slot, expectedItemId, quantity);
  }
  const normalized = Math.min(Math.max(Math.floor(quantity), 1), 0x7FFFFFFF);
  return encodePacket(
    opcode,
    slot,
    expectedItemId,
    (normalized >>> 16) & 0xFFFF,
    normalized & 0xFFFF,
  );
}

export function decodeQuantityValues(values: number[], index: number = 2, fallback: number = 1): number {
  if (values.length <= index) return fallback;
  const first = values[index] ?? fallback;
  if (first === -1) return -1;
  if (values.length > index + 1) {
    const high = first & 0xFFFF;
    const low = values[index + 1] & 0xFFFF;
    return Math.min((high * 0x10000) + low, 0x7FFFFFFF);
  }
  return first;
}

export function decodePacket(data: ArrayBuffer): { opcode: number; values: number[] } {
  if (data.byteLength < 1) throw new RangeError('packet too short');
  const view = new DataView(data);
  const opcode = view.getUint8(0);
  const values: number[] = [];
  // Each value is int16 (2 bytes). The payload must be an even number of bytes;
  // a trailing half-byte indicates a malformed/truncated packet.
  if ((view.byteLength - 1) % 2 !== 0) throw new RangeError('packet payload misaligned');
  for (let i = 1; i + 1 < view.byteLength; i += 2) {
    values.push(view.getInt16(i));
  }
  return { opcode, values };
}

// Packet batch: [opcode, count:u16, repeated [packetLength:u32, packetBytes]]
export function encodePacketBatch(opcode: number, packets: readonly Uint8Array[]): Uint8Array {
  if (packets.length > 0xffff) throw new RangeError('too many packets in batch');
  let len = 3;
  for (const packet of packets) {
    if (packet.byteLength === 0) throw new RangeError('empty packet in batch');
    len += 4 + packet.byteLength;
  }
  const out = new Uint8Array(len);
  const view = new DataView(out.buffer);
  view.setUint8(0, opcode);
  view.setUint16(1, packets.length);
  let offset = 3;
  for (const packet of packets) {
    view.setUint32(offset, packet.byteLength);
    offset += 4;
    out.set(packet, offset);
    offset += packet.byteLength;
  }
  return out;
}

export function decodePacketBatch(data: ArrayBuffer): ArrayBuffer[] {
  if (data.byteLength < 3) throw new RangeError('packet batch too short');
  const view = new DataView(data);
  const count = view.getUint16(1);
  const packets: ArrayBuffer[] = [];
  let offset = 3;
  for (let i = 0; i < count; i++) {
    if (offset + 4 > data.byteLength) throw new RangeError('packet batch length truncated');
    const len = view.getUint32(offset);
    offset += 4;
    if (len < 1 || offset + len > data.byteLength) throw new RangeError('packet batch payload truncated');
    packets.push(data.slice(offset, offset + len));
    offset += len;
  }
  if (offset !== data.byteLength) throw new RangeError('packet batch trailing bytes');
  return packets;
}

// String packet: [opcode, stringLength (2 bytes), ...utf8 bytes, ...extra int16 values]
export function encodeStringPacket(opcode: number, str: string, ...values: number[]): Uint8Array {
  const strBytes = textEncoder.encode(str);
  const buf = new Uint8Array(1 + 2 + strBytes.length + values.length * 2);
  const view = new DataView(buf.buffer);
  view.setUint8(0, opcode);
  view.setUint16(1, strBytes.length);
  buf.set(strBytes, 3);
  for (let i = 0; i < values.length; i++) {
    view.setInt16(3 + strBytes.length + i * 2, values[i]);
  }
  return buf;
}

export function decodeStringPacket(data: ArrayBuffer): { opcode: number; str: string; values: number[] } {
  if (data.byteLength < 3) throw new RangeError('string packet too short');
  const view = new DataView(data);
  const opcode = view.getUint8(0);
  const strLen = view.getUint16(1);
  // Bounds-check the declared string length against the actual buffer so a
  // hostile client can't claim a 64K string in a 4-byte packet (which would
  // either OOB-read on TextDecoder or read uninitialized buffer memory).
  if (3 + strLen > view.byteLength) throw new RangeError('string packet length exceeds buffer');
  const str = textDecoder.decode(new Uint8Array(data, 3, strLen));
  const values: number[] = [];
  for (let i = 3 + strLen; i + 1 < view.byteLength; i += 2) {
    values.push(view.getInt16(i));
  }
  return { opcode, str, values };
}
