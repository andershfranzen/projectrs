import { ClientOpcode, ServerOpcode } from './opcodes.js';

export const OPCODE_MAPPING_VERSION = 1;

export interface OpcodeMappingPayload {
  version: number;
  client: Record<string, number>;
  server: Record<string, number>;
}

export interface OpcodeMappingTables {
  clientLogicalToWire: Map<number, number>;
  clientWireToLogical: Map<number, number>;
  serverLogicalToWire: Map<number, number>;
  serverWireToLogical: Map<number, number>;
}

const RESERVED_WIRE_OPCODES = new Set([
  0,
  ClientOpcode.CRYPTO_RESPONSE,
  ServerOpcode.CRYPTO_CHALLENGE,
  ServerOpcode.OPCODE_MAPPING,
  254,
  255,
]);

const FIXED_CLIENT_OPCODES = new Set<number>([
  ClientOpcode.LOGIN,
  ClientOpcode.CRYPTO_RESPONSE,
]);

const FIXED_SERVER_OPCODES = new Set<number>([
  ServerOpcode.CRYPTO_CHALLENGE,
  ServerOpcode.OPCODE_MAPPING,
]);

function enumNumericValues(value: Record<string, string | number>): number[] {
  return [...new Set(Object.values(value).filter((v): v is number => typeof v === 'number'))]
    .sort((a, b) => a - b);
}

export const ROTATABLE_CLIENT_OPCODE_VALUES = enumNumericValues(ClientOpcode)
  .filter((opcode) => !FIXED_CLIENT_OPCODES.has(opcode));

export const ROTATABLE_SERVER_OPCODE_VALUES = enumNumericValues(ServerOpcode)
  .filter((opcode) => !FIXED_SERVER_OPCODES.has(opcode));

function randomIndex(maxExclusive: number): number {
  if (maxExclusive <= 0) throw new RangeError('empty shuffle range');
  const bytes = new Uint32Array(1);
  globalThis.crypto.getRandomValues(bytes);
  return bytes[0] % maxExclusive;
}

function shuffledWirePool(): number[] {
  const pool: number[] = [];
  for (let opcode = 1; opcode <= 253; opcode++) {
    if (!RESERVED_WIRE_OPCODES.has(opcode)) pool.push(opcode);
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

function makeDirectionalMap(logicalValues: number[]): Map<number, number> {
  const pool = shuffledWirePool();
  if (pool.length < logicalValues.length) throw new Error('not enough wire opcodes for mapping');
  const chosen = pool.slice(0, logicalValues.length);

  for (let i = 0; i < logicalValues.length; i++) {
    if (chosen[i] !== logicalValues[i]) continue;
    const swapIdx = chosen.findIndex((wire, j) =>
      j !== i && wire !== logicalValues[i] && chosen[i] !== logicalValues[j]
    );
    if (swapIdx < 0) throw new Error('failed to derange opcode mapping');
    [chosen[i], chosen[swapIdx]] = [chosen[swapIdx], chosen[i]];
  }

  return new Map(logicalValues.map((logical, i) => [logical, chosen[i]]));
}

function invert(map: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const [logical, wire] of map) {
    if (out.has(wire)) throw new Error(`duplicate wire opcode ${wire}`);
    out.set(wire, logical);
  }
  return out;
}

export function createOpcodeMapping(): OpcodeMappingTables {
  const clientLogicalToWire = makeDirectionalMap(ROTATABLE_CLIENT_OPCODE_VALUES);
  const serverLogicalToWire = makeDirectionalMap(ROTATABLE_SERVER_OPCODE_VALUES);
  return {
    clientLogicalToWire,
    clientWireToLogical: invert(clientLogicalToWire),
    serverLogicalToWire,
    serverWireToLogical: invert(serverLogicalToWire),
  };
}

function recordFromMap(map: Map<number, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [logical, wire] of [...map.entries()].sort((a, b) => a[0] - b[0])) {
    out[String(logical)] = wire;
  }
  return out;
}

export function opcodeMappingToPayload(mapping: OpcodeMappingTables): OpcodeMappingPayload {
  return {
    version: OPCODE_MAPPING_VERSION,
    client: recordFromMap(mapping.clientLogicalToWire),
    server: recordFromMap(mapping.serverLogicalToWire),
  };
}

function mapFromRecord(record: Record<string, unknown>, expectedLogicalValues: number[]): Map<number, number> {
  const out = new Map<number, number>();
  const seenWire = new Set<number>();
  for (const logical of expectedLogicalValues) {
    const raw = record[String(logical)];
    if (!Number.isInteger(raw) || (raw as number) < 1 || (raw as number) > 253) {
      throw new Error(`missing opcode mapping for ${logical}`);
    }
    const wire = raw as number;
    if (RESERVED_WIRE_OPCODES.has(wire)) throw new Error(`reserved wire opcode ${wire}`);
    if (wire === logical) throw new Error(`unrotated opcode ${logical}`);
    if (seenWire.has(wire)) throw new Error(`duplicate wire opcode ${wire}`);
    seenWire.add(wire);
    out.set(logical, wire);
  }
  return out;
}

export function parseOpcodeMappingPayload(raw: unknown): OpcodeMappingTables {
  if (!raw || typeof raw !== 'object') throw new Error('invalid opcode mapping payload');
  const payload = raw as { version?: unknown; client?: unknown; server?: unknown };
  if (payload.version !== OPCODE_MAPPING_VERSION) throw new Error('unsupported opcode mapping version');
  if (!payload.client || typeof payload.client !== 'object') throw new Error('missing client opcode mapping');
  if (!payload.server || typeof payload.server !== 'object') throw new Error('missing server opcode mapping');
  const clientLogicalToWire = mapFromRecord(payload.client as Record<string, unknown>, ROTATABLE_CLIENT_OPCODE_VALUES);
  const serverLogicalToWire = mapFromRecord(payload.server as Record<string, unknown>, ROTATABLE_SERVER_OPCODE_VALUES);
  return {
    clientLogicalToWire,
    clientWireToLogical: invert(clientLogicalToWire),
    serverLogicalToWire,
    serverWireToLogical: invert(serverLogicalToWire),
  };
}

export function rewritePacketOpcode(packet: Uint8Array, opcodeMap: Map<number, number>, strict = false): Uint8Array {
  if (packet.byteLength === 0) return packet;
  const current = packet[0];
  const next = opcodeMap.get(current);
  if (next === undefined) {
    if (strict) throw new Error(`unmapped opcode ${current}`);
    return packet;
  }
  const out = packet.slice();
  out[0] = next;
  return out;
}

export function rewriteArrayBufferOpcode(packet: ArrayBuffer, opcodeMap: Map<number, number>, strict = false): ArrayBuffer {
  const input = new Uint8Array(packet);
  const rewritten = rewritePacketOpcode(input, opcodeMap, strict);
  if (rewritten === input) return packet;
  const out = new Uint8Array(rewritten.byteLength);
  out.set(rewritten);
  return out.buffer;
}
