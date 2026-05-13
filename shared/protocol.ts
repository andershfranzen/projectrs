// Binary protocol helpers for game socket
// All game packets: [opcode (1 byte), ...payload]

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

export function encodePacket(opcode: number, ...values: number[]): Uint8Array {
  const len = 1 + values.length * 2;
  ensureEncodeCapacity(len);
  _encView.setUint8(0, opcode);
  for (let i = 0; i < values.length; i++) {
    _encView.setInt16(1 + i * 2, values[i]);
  }
  return _encU8.slice(0, len);
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

// String packet: [opcode, stringLength (2 bytes), ...utf8 bytes, ...extra int16 values]
export function encodeStringPacket(opcode: number, str: string, ...values: number[]): Uint8Array {
  const encoder = new TextEncoder();
  const strBytes = encoder.encode(str);
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
  const decoder = new TextDecoder();
  const str = decoder.decode(new Uint8Array(data, 3, strLen));
  const values: number[] = [];
  for (let i = 3 + strLen; i + 1 < view.byteLength; i += 2) {
    values.push(view.getInt16(i));
  }
  return { opcode, str, values };
}
