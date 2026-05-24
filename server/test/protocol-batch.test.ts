import { describe, expect, test } from 'bun:test';
import {
  ServerOpcode,
  createOpcodeMapping,
  decodePacket,
  decodePacketBatch,
  encodePacket,
  encodePacketBatch,
  rewriteArrayBufferOpcode,
  rewritePacketOpcode,
} from '@projectrs/shared';

function exact(packet: Uint8Array): ArrayBuffer {
  return packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer;
}

describe('packet batch protocol', () => {
  test('round-trips ordinary server packets', () => {
    const first = encodePacket(ServerOpcode.PLAYER_SELF_SYNC, 10, 20, 3);
    const second = encodePacket(ServerOpcode.ENTITY_DEATH, 99);
    const batch = encodePacketBatch(ServerOpcode.PACKET_BATCH, [first, second]);

    const packets = decodePacketBatch(exact(batch));
    expect(packets.map((packet) => decodePacket(packet))).toEqual([
      { opcode: ServerOpcode.PLAYER_SELF_SYNC, values: [10, 20, 3] },
      { opcode: ServerOpcode.ENTITY_DEATH, values: [99] },
    ]);
  });

  test('opcode mapping only rewrites the batch wrapper', () => {
    const mapping = createOpcodeMapping();
    const inner = encodePacket(ServerOpcode.ENTITY_DEATH, 123);
    const batch = encodePacketBatch(ServerOpcode.PACKET_BATCH, [inner]);
    const wire = rewritePacketOpcode(batch, mapping.serverLogicalToWire, true);

    expect(wire[0]).not.toBe(ServerOpcode.PACKET_BATCH);
    const logical = rewriteArrayBufferOpcode(exact(wire), mapping.serverWireToLogical, true);
    expect(new Uint8Array(logical)[0]).toBe(ServerOpcode.PACKET_BATCH);

    const [decodedInner] = decodePacketBatch(logical);
    expect(decodePacket(decodedInner)).toEqual({ opcode: ServerOpcode.ENTITY_DEATH, values: [123] });
  });
});
