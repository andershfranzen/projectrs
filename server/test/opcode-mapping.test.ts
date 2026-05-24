import { describe, expect, test } from 'bun:test';
import {
  ClientOpcode,
  ServerOpcode,
  createOpcodeMapping,
  opcodeMappingToPayload,
  parseOpcodeMappingPayload,
  rewritePacketOpcode,
  ROTATABLE_CLIENT_OPCODE_VALUES,
  ROTATABLE_SERVER_OPCODE_VALUES,
} from '@projectrs/shared';

describe('per-session opcode mapping', () => {
  test('shuffles every gameplay opcode away from its enum value', () => {
    const mapping = createOpcodeMapping();

    for (const logical of ROTATABLE_CLIENT_OPCODE_VALUES) {
      const wire = mapping.clientLogicalToWire.get(logical);
      expect(wire).toBeNumber();
      expect(wire).not.toBe(logical);
      expect(mapping.clientWireToLogical.get(wire!)).toBe(logical);
    }

    for (const logical of ROTATABLE_SERVER_OPCODE_VALUES.filter((opcode) => opcode !== ServerOpcode.ADMIN_FLAGS)) {
      const wire = mapping.serverLogicalToWire.get(logical);
      expect(wire).toBeNumber();
      expect(wire).not.toBe(logical);
      expect(mapping.serverWireToLogical.get(wire!)).toBe(logical);
    }

    expect(mapping.clientLogicalToWire.has(ClientOpcode.CRYPTO_RESPONSE)).toBe(false);
    expect(mapping.serverLogicalToWire.has(ServerOpcode.CRYPTO_CHALLENGE)).toBe(false);
    expect(mapping.serverLogicalToWire.has(ServerOpcode.OPCODE_MAPPING)).toBe(false);
    expect(mapping.serverLogicalToWire.has(ServerOpcode.ADMIN_FLAGS)).toBe(false);
  });

  test('round-trips payloads and rewrites packet opcode byte only', () => {
    const mapping = createOpcodeMapping();
    const parsed = parseOpcodeMappingPayload(opcodeMappingToPayload(mapping));
    const packet = new Uint8Array([ClientOpcode.PLAYER_MOVE, 3, 0, 10, 0, 20]);
    const wirePacket = rewritePacketOpcode(packet, parsed.clientLogicalToWire, true);
    const moveWire = parsed.clientLogicalToWire.get(ClientOpcode.PLAYER_MOVE);

    expect(moveWire).toBeNumber();
    expect(wirePacket[0]).toBe(moveWire!);
    expect([...wirePacket.slice(1)]).toEqual([...packet.slice(1)]);

    const logicalPacket = rewritePacketOpcode(wirePacket, parsed.clientWireToLogical, true);
    expect([...logicalPacket]).toEqual([...packet]);
  });

  test('keeps admin-only server opcodes out of non-admin mappings', () => {
    const mapping = createOpcodeMapping();
    const parsed = parseOpcodeMappingPayload(opcodeMappingToPayload(mapping));

    expect(parsed.serverLogicalToWire.has(ServerOpcode.ADMIN_FLAGS)).toBe(false);
    expect([...parsed.serverWireToLogical.values()]).not.toContain(ServerOpcode.ADMIN_FLAGS);
  });

  test('includes admin-only server opcodes for admin sessions', () => {
    const mapping = createOpcodeMapping({ includeAdminServerOpcodes: true });
    const parsed = parseOpcodeMappingPayload(opcodeMappingToPayload(mapping));
    const wire = parsed.serverLogicalToWire.get(ServerOpcode.ADMIN_FLAGS);

    expect(wire).toBeNumber();
    expect(wire).not.toBe(ServerOpcode.ADMIN_FLAGS);
    expect(parsed.serverWireToLogical.get(wire!)).toBe(ServerOpcode.ADMIN_FLAGS);
  });
});
