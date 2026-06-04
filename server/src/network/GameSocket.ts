import {
  BANK_SIZE,
  ClientActivityKind,
  ClientOpcode,
  HAIR_STYLE_COUNT,
  INVENTORY_SIZE,
  ServerOpcode,
  TRADE_OFFER_SIZE,
  DUEL_STAKE_SIZE,
  PROTOCOL_VERSION,
  decodePacket,
  decodeQuantityValues,
  encodePacket,
  decodeStringPacket,
  encodeStringPacket,
  ENCRYPTED_GAME_FRAME_V2,
  GAME_CRYPTO_VERSION,
  buildGameHandshakeTranscript,
  bytesToBase64Url,
  deriveGameCipherKeysV2,
  decryptGamePacketV2,
  encryptGamePacketV2,
  exportGamePublicKey,
  generateGameEcdhKeyPair,
  importGameEcdhPublicKey,
  verifyGameHandshakeTranscript,
  isValidAppearance,
  APPEARANCE_WIRE_FIELD_COUNT,
  appearanceFromWireValues,
  createOpcodeMapping,
  opcodeMappingToPayload,
  rotateServerOpcodeMapping,
  rewriteArrayBufferOpcode,
  rewritePacketOpcode,
  type GameCipherKeysV2,
  type GameCryptoChallenge,
  type GameCryptoResponse,
  type OpcodeMappingTables,
} from '@projectrs/shared';
import { World } from '../World';
import { Player } from '../entity/Player';
import { WORLD_RESPAWN_VERSION } from '../Database';
import { audit } from '../Audit';
import { randomBytes } from 'crypto';
import type { ServerWebSocket } from 'bun';

const MAGIC_DEBUG_ENABLED = process.env.EQ_MAGIC_DEBUG === '1';

interface GameSocketCryptoState {
  version: 2;
  token: string;
  connectionId: string;
  accountId: number;
  deviceId: string;
  serverNonce: string;
  serverKeyPair: CryptoKeyPair;
  serverPublicKey: JsonWebKey;
  keys?: GameCipherKeysV2;
  handshakeComplete: boolean;
  opcodeMapping: OpcodeMappingTables;
  opcodeMappingEnabled: boolean;
  encryptEnabled: boolean;
  sendCounter: number;
  lastRecvCounter: number;
  sendQueue: Promise<void>;
  recvQueue: Promise<void>;
  opcodeMappingRotationTimer?: ReturnType<typeof setInterval>;
  originalSendBinary?: (data: Bun.BufferSource) => number;
}

export type GameSocketData = {
  type: 'game';
  playerId?: number;
  accountId: number;
  username: string;
  isAdmin: boolean;
  ip: string;
  deviceId: string;
  token: string;
  crypto?: GameSocketCryptoState;
};

export interface OpcodeRateRule {
  bucket: string;
  maxMessages: number;
  windowMs: number;
}

interface PacketValidationResult {
  ok: boolean;
  reason?: string;
}

const EQUIP_SLOT_COUNT = 11;
const INVALID_PACKET_CLOSE_THRESHOLD = 50;
const INVALID_PACKET_AUDIT_COUNTS = new Set([1, 5, 10, 25, INVALID_PACKET_CLOSE_THRESHOLD]);
const BROWSER_INPUT_MAX_AGE_MS = 15_000;
const OPCODE_MAPPING_ROTATE_MS = 60_000;
// Bot telemetry is review-only by default. Set this explicitly for a hardened
// test shard; the live game should not reject normal play because browser input
// telemetry was delayed, throttled, or unavailable.
const BLOCK_INPUTLESS_GAMEPLAY = process.env.BLOCK_INPUTLESS_GAMEPLAY === '1';

function savedFloorMatchesHeightSeed(
  map: { getWalkableFloorTargetsAt?: (x: number, z: number) => Array<{ floor: number; y: number }> },
  x: number,
  z: number,
  floor: number,
  heightSeedY: number,
): boolean {
  if (!Number.isFinite(heightSeedY) || !map.getWalkableFloorTargetsAt) return false;
  const targets = map.getWalkableFloorTargetsAt(x, z);
  if (targets.length === 0) return false;
  const current = targets.filter(target => target.floor === floor)
    .sort((a, b) => Math.abs(a.y - heightSeedY) - Math.abs(b.y - heightSeedY))[0];
  if (!current) return false;
  const currentDist = Math.abs(current.y - heightSeedY);
  const bestDist = Math.min(...targets.map(target => Math.abs(target.y - heightSeedY)));
  return currentDist <= 0.75 && currentDist <= bestDist + 0.05;
}

const OK_PACKET: PacketValidationResult = { ok: true };

function toPacketBytes(data: Bun.BufferSource): Uint8Array {
  return data instanceof Uint8Array
    ? data
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as unknown as ArrayBuffer);
}

export async function installGameSocketEncryption(ws: ServerWebSocket<GameSocketData>): Promise<void> {
  if (ws.data.crypto) return;
  const serverKeyPair = await generateGameEcdhKeyPair();
  const serverPublicKey = await exportGamePublicKey(serverKeyPair.publicKey);
  const connectionId = bytesToBase64Url(new Uint8Array(randomBytes(16)));
  const serverNonce = bytesToBase64Url(new Uint8Array(randomBytes(16)));
  const cryptoState: GameSocketCryptoState = {
    version: 2,
    token: ws.data.token,
    connectionId,
    accountId: ws.data.accountId,
    deviceId: ws.data.deviceId,
    serverNonce,
    serverKeyPair,
    serverPublicKey,
    handshakeComplete: false,
    opcodeMapping: createOpcodeMapping({ includeAdminServerOpcodes: ws.data.isAdmin }),
    opcodeMappingEnabled: false,
    encryptEnabled: false,
    sendCounter: 0,
    lastRecvCounter: -1,
    sendQueue: Promise.resolve(),
    recvQueue: Promise.resolve(),
  };
  const originalSendBinary = ws.sendBinary.bind(ws);
  cryptoState.originalSendBinary = originalSendBinary;
  ws.data.crypto = cryptoState;
  ws.sendBinary = ((data: Bun.BufferSource) => {
    const packet = toPacketBytes(data);
    const shouldEncrypt = cryptoState.encryptEnabled && !!cryptoState.keys;
    const serverOpcodeMap = cryptoState.opcodeMappingEnabled
      ? cryptoState.opcodeMapping.serverLogicalToWire
      : null;
    const fixedServerOpcode = packet[0] === ServerOpcode.CRYPTO_CHALLENGE
      || packet[0] === ServerOpcode.OPCODE_MAPPING;
    cryptoState.sendQueue = cryptoState.sendQueue.then(async () => {
      const wirePacket = serverOpcodeMap && !fixedServerOpcode
        ? rewritePacketOpcode(packet, serverOpcodeMap, true)
        : packet;
      if (!shouldEncrypt || !cryptoState.keys) {
        originalSendBinary(wirePacket);
        return;
      }
      const frame = await encryptGamePacketV2(
        cryptoState.keys,
        'server-to-client',
        cryptoState.sendCounter++,
        wirePacket,
      );
      originalSendBinary(frame);
    }).catch((e) => {
      console.warn('[ws] encryption send failed:', e instanceof Error ? e.message : e);
      try { ws.close(1011, 'encryption failed'); } catch {}
    });
    return 0;
  }) as typeof ws.sendBinary;

  const challenge: GameCryptoChallenge = {
    version: GAME_CRYPTO_VERSION,
    connectionId,
    accountId: ws.data.accountId,
    deviceId: ws.data.deviceId,
    serverNonce,
    serverPublicKey,
  };
  originalSendBinary(encodeStringPacket(ServerOpcode.CRYPTO_CHALLENGE, JSON.stringify(challenge)));
}

async function decryptGameSocketMessage(ws: ServerWebSocket<GameSocketData>, message: ArrayBuffer): Promise<ArrayBuffer> {
  const view = new DataView(message);
  const cryptoState = ws.data.crypto;
  if (view.byteLength === 0) throw new RangeError('empty game frame');
  if (view.getUint8(0) !== ENCRYPTED_GAME_FRAME_V2) {
    if (cryptoState?.handshakeComplete) throw new Error('plaintext packet after encryption enabled');
    return message;
  }
  if (!cryptoState?.keys || !cryptoState.handshakeComplete) throw new Error('encrypted frame before handshake complete');
  const decrypted = await decryptGamePacketV2(cryptoState.keys, 'client-to-server', message);
  if (decrypted.counter <= cryptoState.lastRecvCounter) throw new Error('replayed encrypted frame');
  cryptoState.lastRecvCounter = decrypted.counter;
  return decrypted.plaintext;
}

export function enableGameSocketEncryption(ws: ServerWebSocket<GameSocketData>): void {
  if (ws.data.crypto?.keys) {
    ws.data.crypto.handshakeComplete = true;
    ws.data.crypto.encryptEnabled = true;
  }
}

function hasValues(values: number[], count: number): boolean {
  if (values.length < count) return false;
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(values[i])) return false;
  }
  return true;
}

function validateClientActivityValues(values: number[]): PacketValidationResult {
  if (values.length === 0) return OK_PACKET;
  if (values.length !== 4 || !hasValues(values, 4)) return invalid('bad-client-activity-shape');
  const [kind, seq, x, y] = values;
  if (
    kind !== ClientActivityKind.Pointer
    && kind !== ClientActivityKind.Keyboard
    && kind !== ClientActivityKind.Touch
  ) return invalid('bad-client-activity-kind');
  if (!Number.isInteger(seq) || seq < 0 || seq > 0x7fff) return invalid('bad-client-activity-seq');
  if (kind === ClientActivityKind.Keyboard) {
    if (x !== -1 || y !== -1) return invalid('bad-client-activity-coords');
    return OK_PACKET;
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > 1000 || y < 0 || y > 1000) {
    return invalid('bad-client-activity-coords');
  }
  return OK_PACKET;
}

function isSlot(slot: number, size: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot < size;
}

function invalid(reason: string): PacketValidationResult {
  return { ok: false, reason };
}

function opcodeCountsAsActivity(opcode: number): boolean {
  return opcode !== ClientOpcode.CLIENT_PING
    && opcode !== ClientOpcode.CLIENT_POSITION_Y
    && opcode !== ClientOpcode.CURSOR_POSITION
    && opcode !== ClientOpcode.MAP_READY;
}

function magicOpcodeDebug(player: Player, opcode: ClientOpcode, values: number[], phase: string, details: Record<string, unknown> = {}): void {
  if (!MAGIC_DEBUG_ENABLED) return;
  let name: string | null = null;
  if (opcode === ClientOpcode.PLAYER_ATTACK_NPC) name = 'PLAYER_ATTACK_NPC';
  else if (opcode === ClientOpcode.PLAYER_CAST_SPELL) name = 'PLAYER_CAST_SPELL';
  else if (opcode === ClientOpcode.PLAYER_SET_AUTOCAST) name = 'PLAYER_SET_AUTOCAST';
  else if (opcode === ClientOpcode.PLAYER_SET_MAGIC_STANCE) name = 'PLAYER_SET_MAGIC_STANCE';
  else if (opcode === ClientOpcode.PLAYER_SET_AUTO_RETALIATE) name = 'PLAYER_SET_AUTO_RETALIATE';
  else if (opcode === ClientOpcode.PLAYER_MOVE) name = 'PLAYER_MOVE';
  if (!name) return;
  console.log(`[magic-debug] packet ${phase} player=${player.name}#${player.id} opcode=${name} values=${JSON.stringify(values)} ${JSON.stringify(details)}`);
}

export function opcodeRequiresBrowserInputTelemetry(opcode: number, values: number[] = [], player?: Player): boolean {
  switch (opcode) {
    case ClientOpcode.PLAYER_MOVE:
      return true;
    case ClientOpcode.PLAYER_ATTACK_NPC:
      return !hasValues(values, 1) || player?.attackTarget?.id !== values[0];
    case ClientOpcode.PLAYER_TALK_NPC:
    case ClientOpcode.PLAYER_FOLLOW:
    case ClientOpcode.PLAYER_PICKUP_ITEM:
    case ClientOpcode.PLAYER_DROP_ITEM:
    case ClientOpcode.PLAYER_EQUIP_ITEM:
    case ClientOpcode.PLAYER_UNEQUIP_ITEM:
    case ClientOpcode.PLAYER_EAT_ITEM:
    case ClientOpcode.PLAYER_SET_STANCE:
    case ClientOpcode.PLAYER_SET_MAGIC_STANCE:
    case ClientOpcode.PLAYER_SET_AUTO_RETALIATE:
    case ClientOpcode.PLAYER_BUY_ITEM:
    case ClientOpcode.PLAYER_SELL_ITEM:
    case ClientOpcode.PLAYER_MOVE_INV_ITEM:
    case ClientOpcode.DIALOGUE_CHOOSE:
    case ClientOpcode.DIALOGUE_CLOSE:
    case ClientOpcode.PLAYER_INTERACT_OBJECT:
    case ClientOpcode.PLAYER_USE_ITEM_ON_ITEM:
    case ClientOpcode.PLAYER_USE_ITEM_ON_OBJECT:
    case ClientOpcode.PLAYER_USE_ITEM_ON_NPC:
    case ClientOpcode.PLAYER_CAST_SPELL:
    case ClientOpcode.PLAYER_SET_AUTOCAST:
    case ClientOpcode.BANK_REQUEST_OPEN:
    case ClientOpcode.BANK_DEPOSIT:
    case ClientOpcode.BANK_WITHDRAW:
    case ClientOpcode.BANK_CLOSE:
    case ClientOpcode.APPEARANCE_CLOSE:
    case ClientOpcode.TRADE_REQUEST:
    case ClientOpcode.TRADE_ACCEPT_REQUEST:
    case ClientOpcode.TRADE_DECLINE:
    case ClientOpcode.TRADE_OFFER_ITEM:
    case ClientOpcode.TRADE_REMOVE_OFFERED:
    case ClientOpcode.TRADE_ACCEPT:
    case ClientOpcode.DUEL_REQUEST:
    case ClientOpcode.DUEL_ACCEPT_REQUEST:
    case ClientOpcode.DUEL_DECLINE:
    case ClientOpcode.DUEL_STAKE_ITEM:
    case ClientOpcode.DUEL_REMOVE_STAKE:
    case ClientOpcode.DUEL_ACCEPT:
      return true;
    default:
      return false;
  }
}

export function getOpcodeRateRule(opcode: number): OpcodeRateRule {
  switch (opcode) {
    case ClientOpcode.PLAYER_MOVE:
      return { bucket: 'movement', maxMessages: 8, windowMs: 1000 };
    case ClientOpcode.PLAYER_ATTACK_NPC:
    case ClientOpcode.PLAYER_CAST_SPELL:
    case ClientOpcode.PLAYER_SET_AUTOCAST:
    case ClientOpcode.PLAYER_SET_MAGIC_STANCE:
    case ClientOpcode.PLAYER_SET_AUTO_RETALIATE:
      return { bucket: 'combat', maxMessages: 8, windowMs: 1000 };
    case ClientOpcode.PLAYER_FOLLOW:
    case ClientOpcode.PLAYER_PICKUP_ITEM:
    case ClientOpcode.PLAYER_INTERACT_OBJECT:
    case ClientOpcode.PLAYER_USE_ITEM_ON_OBJECT:
    case ClientOpcode.PLAYER_USE_ITEM_ON_NPC:
    case ClientOpcode.PLAYER_TALK_NPC:
      return { bucket: 'world-action', maxMessages: 6, windowMs: 1000 };
    case ClientOpcode.PLAYER_DROP_ITEM:
    case ClientOpcode.PLAYER_EQUIP_ITEM:
    case ClientOpcode.PLAYER_UNEQUIP_ITEM:
    case ClientOpcode.PLAYER_EAT_ITEM:
    case ClientOpcode.PLAYER_USE_ITEM_ON_ITEM:
    case ClientOpcode.PLAYER_BUY_ITEM:
    case ClientOpcode.PLAYER_SELL_ITEM:
    case ClientOpcode.PLAYER_MOVE_INV_ITEM:
    case ClientOpcode.BANK_REQUEST_OPEN:
    case ClientOpcode.BANK_DEPOSIT:
    case ClientOpcode.BANK_WITHDRAW:
    case ClientOpcode.BANK_CLOSE:
    case ClientOpcode.APPEARANCE_CLOSE:
    case ClientOpcode.TRADE_REQUEST:
    case ClientOpcode.TRADE_ACCEPT_REQUEST:
    case ClientOpcode.TRADE_DECLINE:
    case ClientOpcode.TRADE_OFFER_ITEM:
    case ClientOpcode.TRADE_REMOVE_OFFERED:
    case ClientOpcode.TRADE_ACCEPT:
    case ClientOpcode.DUEL_REQUEST:
    case ClientOpcode.DUEL_ACCEPT_REQUEST:
    case ClientOpcode.DUEL_DECLINE:
    case ClientOpcode.DUEL_STAKE_ITEM:
    case ClientOpcode.DUEL_REMOVE_STAKE:
    case ClientOpcode.DUEL_ACCEPT:
      return { bucket: 'inventory-ui', maxMessages: 12, windowMs: 1000 };
    case ClientOpcode.CLIENT_PING:
      return { bucket: 'heartbeat', maxMessages: 4, windowMs: 10_000 };
    case ClientOpcode.CLIENT_ACTIVITY:
      return { bucket: 'activity', maxMessages: 12, windowMs: 60_000 };
    case ClientOpcode.CURSOR_POSITION:
      return { bucket: 'cursor', maxMessages: 8, windowMs: 10_000 };
    case ClientOpcode.CLIENT_POSITION_Y:
      return { bucket: 'metadata', maxMessages: 8, windowMs: 1000 };
    default:
      return { bucket: 'misc', maxMessages: 10, windowMs: 1000 };
  }
}

export function rateLimitOverflowIsSuspicious(opcode: number): boolean {
  switch (opcode) {
    case ClientOpcode.CLIENT_ACTIVITY:
    case ClientOpcode.CURSOR_POSITION:
    case ClientOpcode.CLIENT_POSITION_Y:
      return false;
    default:
      return true;
  }
}

export function suspiciousPacketCloseEligible(reason: string): boolean {
  if (reason.startsWith('rate-limit:')) return true;
  if (
    reason === 'malformed-frame'
    || reason === 'unknown-opcode'
    || reason === 'bad-move-path-length'
    || reason === 'truncated-move-path'
    || reason === 'bad-cursor-x'
    || reason === 'bad-cursor-y'
  ) return true;
  if (
    reason.startsWith('bad-')
    || reason.startsWith('missing-')
    || reason === 'self-use-item'
    || reason === 'self-move-inventory'
  ) return true;
  return false;
}

function checkOpcodeRateLimit(
  player: Player,
  opcode: number,
  ws: ServerWebSocket<GameSocketData>,
  world: World,
): boolean {
  const rule = getOpcodeRateRule(opcode);
  const allowed = player.checkActionRateLimit(rule.bucket, rule.maxMessages, rule.windowMs);
  if (allowed) return true;
  if (rateLimitOverflowIsSuspicious(opcode)) {
    reportSuspiciousPacket(player, opcode, `rate-limit:${rule.bucket}`, [], ws, world);
  }
  return false;
}

function validateClientPacket(player: Player, opcode: number, values: number[], world: World): PacketValidationResult {
  switch (opcode) {
    case ClientOpcode.PLAYER_MOVE: {
      const pathLength = values[0];
      if (!Number.isInteger(pathLength) || pathLength < 0 || pathLength > 50) return invalid('bad-move-path-length');
      if (values.length < 1 + pathLength * 2) return invalid('truncated-move-path');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_ATTACK_NPC: {
      if (!hasValues(values, 1)) return invalid('missing-npc-target');
      const npc = world.npcs.get(values[0]);
      if (!npc || npc.dead) return invalid('stale-npc-target');
      if (!world.canPlayerTargetNpc(player, npc)) return invalid('unreachable-npc-target');
      if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(values[0])) return invalid('unseen-npc-target');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_FOLLOW: {
      if (!hasValues(values, 1)) return invalid('missing-follow-target');
      const target = world.getPlayer(values[0]);
      if (!target || target.id === player.id || target.disconnected) return invalid('bad-follow-target');
      if (target.currentMapLevel !== player.currentMapLevel || target.currentFloor !== player.currentFloor) return invalid('unreachable-follow-target');
      if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(values[0])) return invalid('unseen-follow-target');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_PICKUP_ITEM: {
      if (!hasValues(values, 1)) return invalid('missing-ground-item');
      const item = world.groundItems.get(values[0]);
      if (!item) return invalid('stale-ground-item');
      if (item.ownerPlayerId && item.ownerPlayerId !== player.id && (item.privateTicks ?? 0) > 0) return invalid('private-ground-item');
      if (!world.canPlayerTargetGroundItem(player, item)) return invalid('unreachable-ground-item');
      if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(values[0])) return invalid('unseen-ground-item');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_DROP_ITEM:
    case ClientOpcode.PLAYER_EQUIP_ITEM:
    case ClientOpcode.PLAYER_EAT_ITEM: {
      if (!hasValues(values, 2)) return invalid('missing-inventory-slot-item');
      const slot = values[0];
      const expectedItemId = values[1];
      if (!isSlot(slot, INVENTORY_SIZE)) return invalid('bad-inventory-slot');
      if (player.inventory[slot]?.itemId !== expectedItemId) return invalid('stale-inventory-slot');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_UNEQUIP_ITEM: {
      if (!hasValues(values, 1)) return invalid('missing-equip-slot');
      if (!isSlot(values[0], EQUIP_SLOT_COUNT)) return invalid('bad-equip-slot');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_SET_STANCE: {
      if (!hasValues(values, 1)) return invalid('missing-stance');
      if (!isSlot(values[0], 4)) return invalid('bad-stance');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_SET_MAGIC_STANCE: {
      if (!hasValues(values, 1)) return invalid('missing-magic-stance');
      if (!isSlot(values[0], 4)) return invalid('bad-magic-stance');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_SET_AUTO_RETALIATE: {
      if (!hasValues(values, 1)) return invalid('missing-auto-retaliate');
      if (values[0] !== 0 && values[0] !== 1) return invalid('bad-auto-retaliate');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_CAST_SPELL: {
      if (!hasValues(values, 2)) return invalid('missing-spell-target');
      if (!Number.isInteger(values[0]) || values[0] < 0 || !world.data.getSpellByIndex(values[0])) return invalid('bad-spell-index');
      const target = world.npcs.get(values[1]);
      if (!target || target.dead) return invalid('stale-spell-target');
      if (!world.canPlayerTargetNpc(player, target)) return invalid('unreachable-spell-target');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_SET_AUTOCAST: {
      if (!hasValues(values, 1)) return invalid('missing-autocast-spell');
      if (!Number.isInteger(values[0]) || values[0] < -1 || (values[0] >= 0 && !world.isAutocastableSpellIndex(values[0]))) return invalid('bad-autocast-spell');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_INTERACT_OBJECT: {
      if (!hasValues(values, 1)) return invalid('missing-object-target');
      const obj = world.worldObjects.get(values[0]);
      if (!obj) return invalid('stale-object-target');
      if (!world.canPlayerTargetObject(player, obj)) return invalid('unreachable-object-target');
      if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(values[0])) return invalid('unseen-object-target');
      const actionIndex = values[1] ?? 0;
      if (!Number.isInteger(actionIndex) || actionIndex < 0 || actionIndex > 20) return invalid('bad-object-action-index');
      const recipeIndex = values[2] ?? -1;
      if (!Number.isInteger(recipeIndex) || recipeIndex < -1 || recipeIndex > 1000) return invalid('bad-object-recipe-index');
      const expectedDoorOpen = values[3];
      if (expectedDoorOpen !== undefined && expectedDoorOpen !== 0 && expectedDoorOpen !== 1) return invalid('bad-door-state');
      const recipeQuantity = values[4] ?? 1;
      if (!Number.isInteger(recipeQuantity) || recipeQuantity === 0 || recipeQuantity < -1 || recipeQuantity > 1000) {
        return invalid('bad-object-recipe-quantity');
      }
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_USE_ITEM_ON_ITEM: {
      if (!hasValues(values, 4)) return invalid('missing-use-item-on-item-values');
      const fromSlot = values[0];
      const toSlot = values[2];
      if (fromSlot === toSlot) return invalid('self-use-item');
      if (!isSlot(fromSlot, INVENTORY_SIZE) || !isSlot(toSlot, INVENTORY_SIZE)) return invalid('bad-use-item-slot');
      if (player.inventory[fromSlot]?.itemId !== values[1]) return invalid('stale-use-source-slot');
      if (player.inventory[toSlot]?.itemId !== values[3]) return invalid('stale-use-target-slot');
      const quantity = values[4] ?? 1;
      if (!Number.isInteger(quantity) || quantity === 0 || quantity < -1 || quantity > 1000) {
        return invalid('bad-use-item-quantity');
      }
      const recipeIndex = values[5] ?? 0;
      if (!Number.isInteger(recipeIndex) || recipeIndex < 0 || recipeIndex > 1000) {
        return invalid('bad-use-item-recipe-index');
      }
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_USE_ITEM_ON_OBJECT: {
      if (!hasValues(values, 3)) return invalid('missing-use-item-object-values');
      if (!isSlot(values[0], INVENTORY_SIZE)) return invalid('bad-use-item-slot');
      if (player.inventory[values[0]]?.itemId !== values[1]) return invalid('stale-use-item-slot');
      const obj = world.worldObjects.get(values[2]);
      if (!obj) return invalid('stale-use-object-target');
      if (!world.canPlayerTargetObject(player, obj)) return invalid('unreachable-use-object');
      if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(values[2])) return invalid('unseen-use-object-target');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_USE_ITEM_ON_NPC: {
      if (!hasValues(values, 3)) return invalid('missing-use-item-npc-values');
      if (!isSlot(values[0], INVENTORY_SIZE)) return invalid('bad-use-item-slot');
      if (player.inventory[values[0]]?.itemId !== values[1]) return invalid('stale-use-item-slot');
      const npc = world.npcs.get(values[2]);
      if (!npc || npc.dead) return invalid('stale-use-npc-target');
      if (!world.canPlayerTargetNpc(player, npc)) return invalid('unreachable-use-npc');
      if (player.visibleEntityIds.size > 0 && !player.visibleEntityIds.has(values[2])) return invalid('unseen-use-npc-target');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_TALK_NPC: {
      if (!hasValues(values, 1)) return invalid('missing-talk-npc');
      const npc = world.npcs.get(values[0]);
      if (!npc || npc.dead) return invalid('stale-talk-npc');
      if (!world.canPlayerTargetNpc(player, npc)) return invalid('unreachable-talk-npc');
      return OK_PACKET;
    }

    case ClientOpcode.DIALOGUE_CHOOSE: {
      if (!hasValues(values, 2)) return invalid('missing-dialogue-choice');
      const npcEntityId = values[0];
      const sessionId = values.length >= 3 ? values[1] : -1;
      const optionIndex = values.length >= 3 ? values[2] : values[1];
      const state = player.openDialogueState;
      if (!state || state.npcEntityId !== npcEntityId) return invalid('dialogue-not-open');
      if (sessionId !== state.sessionId) return invalid('stale-dialogue-session');
      const npc = world.npcs.get(npcEntityId);
      if (!npc || !world.canPlayerTargetNpc(player, npc)) return invalid('unreachable-dialogue-npc');
      if (!isSlot(optionIndex, state.visibleOptionIndices.length)) return invalid('bad-dialogue-option');
      return OK_PACKET;
    }

    case ClientOpcode.DIALOGUE_CLOSE: {
      if (!hasValues(values, 2)) return invalid('missing-dialogue-close');
      if (!Number.isInteger(values[0]) || !Number.isInteger(values[1])) return invalid('bad-dialogue-close-values');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_BUY_ITEM: {
      if (!hasValues(values, 1)) return invalid('missing-buy-item');
      if (player.openShopNpcId === null) return invalid('shop-not-open');
      const shopNpc = player.openShopNpcEntityId !== null ? world.npcs.get(player.openShopNpcEntityId) : undefined;
      const shop = shopNpc?.effectiveShop ?? world.data.getShop(player.openShopNpcId);
      if (!shop) return invalid('shop-not-found');
      if (!shop.items.some((item) => item.itemId === values[0])) return invalid('shop-does-not-sell-item');
      const quantity = values[1] ?? 1;
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 1000) return invalid('bad-buy-quantity');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_SELL_ITEM: {
      if (!hasValues(values, 3)) return invalid('missing-sell-values');
      if (player.openShopNpcId === null) return invalid('shop-not-open');
      const shopNpc = player.openShopNpcEntityId !== null ? world.npcs.get(player.openShopNpcEntityId) : undefined;
      if (!(shopNpc?.effectiveShop ?? world.data.getShop(player.openShopNpcId))) return invalid('shop-not-found');
      if (!isSlot(values[0], INVENTORY_SIZE)) return invalid('bad-sell-slot');
      if (!Number.isInteger(values[1]) || values[1] <= 0 || values[1] > 1000) return invalid('bad-sell-quantity');
      if (player.inventory[values[0]]?.itemId !== values[2]) return invalid('stale-sell-slot');
      return OK_PACKET;
    }

    case ClientOpcode.PLAYER_MOVE_INV_ITEM: {
      if (!hasValues(values, 3)) return invalid('missing-move-inventory-values');
      if (values[0] === values[1]) return invalid('self-move-inventory');
      if (!isSlot(values[0], INVENTORY_SIZE) || !isSlot(values[1], INVENTORY_SIZE)) return invalid('bad-move-inventory-slot');
      if (player.inventory[values[0]]?.itemId !== values[2]) return invalid('stale-move-inventory-slot');
      return OK_PACKET;
    }

    case ClientOpcode.CLIENT_POSITION_Y:
      return OK_PACKET;

    case ClientOpcode.CURSOR_POSITION:
      if (!hasValues(values, 2)) return invalid('missing-cursor-position');
      if (!Number.isInteger(values[0]) || values[0] < 0 || values[0] > 1000) return invalid('bad-cursor-x');
      if (!Number.isInteger(values[1]) || values[1] < 0 || values[1] > 1000) return invalid('bad-cursor-y');
      return OK_PACKET;

    case ClientOpcode.SET_APPEARANCE: {
      if (!hasValues(values, APPEARANCE_WIRE_FIELD_COUNT)) return invalid('missing-appearance-values');
      if (!player.appearanceEditorOpen && player.appearance !== null) return invalid('appearance-editor-not-open');
      const appearance = appearanceFromWireValues(values);
      if (!isValidAppearance(appearance)) return invalid('bad-appearance');
      if (appearance.hairStyle > HAIR_STYLE_COUNT) return invalid('bad-hair-style');
      return OK_PACKET;
    }

    case ClientOpcode.APPEARANCE_CLOSE:
      if (!player.appearanceEditorOpen) return invalid('appearance-editor-not-open');
      if (player.appearance === null) return invalid('appearance-required');
      return OK_PACKET;

    case ClientOpcode.BANK_REQUEST_OPEN:
      return OK_PACKET;

    case ClientOpcode.BANK_DEPOSIT: {
      if (!hasValues(values, 2)) return invalid('missing-bank-deposit-values');
      if (player.openInterface !== 'bank') return invalid('bank-not-open');
      if (!isSlot(values[0], INVENTORY_SIZE)) return invalid('bad-bank-deposit-slot');
      if (player.inventory[values[0]]?.itemId !== values[1]) return invalid('stale-bank-deposit-slot');
      return OK_PACKET;
    }

    case ClientOpcode.BANK_WITHDRAW: {
      if (!hasValues(values, 2)) return invalid('missing-bank-withdraw-values');
      if (player.openInterface !== 'bank') return invalid('bank-not-open');
      if (!isSlot(values[0], BANK_SIZE)) return invalid('bad-bank-withdraw-slot');
      if (player.bank[values[0]]?.itemId !== values[1]) return invalid('stale-bank-withdraw-slot');
      return OK_PACKET;
    }

    case ClientOpcode.BANK_CLOSE:
      return OK_PACKET;

    case ClientOpcode.TRADE_REQUEST: {
      if (!hasValues(values, 1)) return invalid('missing-trade-target');
      const target = world.getPlayer(values[0]);
      if (!target || target.id === player.id || target.disconnected || target.requestIdleLogout) return invalid('bad-trade-target');
      return OK_PACKET;
    }

    case ClientOpcode.TRADE_ACCEPT_REQUEST:
      if (!hasValues(values, 1)) return invalid('missing-trade-requester');
      if (!world.getPlayer(values[0])) return invalid('stale-trade-requester');
      return OK_PACKET;

    case ClientOpcode.TRADE_DECLINE:
    case ClientOpcode.TRADE_ACCEPT:
      return OK_PACKET;

    case ClientOpcode.TRADE_OFFER_ITEM: {
      if (!hasValues(values, 2)) return invalid('missing-trade-offer-values');
      if (player.openInterface !== 'trade') return invalid('trade-not-open');
      if (!isSlot(values[0], INVENTORY_SIZE)) return invalid('bad-trade-offer-slot');
      if (player.inventory[values[0]]?.itemId !== values[1]) return invalid('stale-trade-offer-slot');
      return OK_PACKET;
    }

    case ClientOpcode.TRADE_REMOVE_OFFERED: {
      if (!hasValues(values, 2)) return invalid('missing-trade-remove-values');
      if (player.openInterface !== 'trade') return invalid('trade-not-open');
      if (!isSlot(values[0], TRADE_OFFER_SIZE)) return invalid('bad-trade-offer-slot');
      return OK_PACKET;
    }

    case ClientOpcode.DUEL_REQUEST: {
      if (!hasValues(values, 1)) return invalid('missing-duel-target');
      const target = world.getPlayer(values[0]);
      if (!target || target.id === player.id || target.disconnected || target.requestIdleLogout) return invalid('bad-duel-target');
      if (target.currentMapLevel !== player.currentMapLevel || target.currentFloor !== player.currentFloor) return invalid('unreachable-duel-target');
      return OK_PACKET;
    }

    case ClientOpcode.DUEL_ACCEPT_REQUEST:
      if (!hasValues(values, 1)) return invalid('missing-duel-requester');
      if (!world.getPlayer(values[0])) return invalid('stale-duel-requester');
      return OK_PACKET;

    case ClientOpcode.DUEL_DECLINE:
    case ClientOpcode.DUEL_ACCEPT:
      return OK_PACKET;

    case ClientOpcode.DUEL_STAKE_ITEM: {
      if (!hasValues(values, 2)) return invalid('missing-duel-stake-values');
      if (player.openInterface !== 'duel') return invalid('duel-not-open');
      if (!isSlot(values[0], INVENTORY_SIZE)) return invalid('bad-duel-stake-slot');
      if (player.inventory[values[0]]?.itemId !== values[1]) return invalid('stale-duel-stake-slot');
      return OK_PACKET;
    }

    case ClientOpcode.DUEL_REMOVE_STAKE: {
      if (!hasValues(values, 2)) return invalid('missing-duel-remove-values');
      if (player.openInterface !== 'duel') return invalid('duel-not-open');
      if (!isSlot(values[0], DUEL_STAKE_SIZE)) return invalid('bad-duel-stake-slot');
      return OK_PACKET;
    }

    case ClientOpcode.CLIENT_PING:
    case ClientOpcode.CURSOR_POSITION:
    case ClientOpcode.MAP_READY:
      return OK_PACKET;

    case ClientOpcode.CLIENT_ACTIVITY:
      return validateClientActivityValues(values);

    default:
      return invalid('unknown-opcode');
  }
}

function reportSuspiciousPacket(
  player: Player,
  opcode: number,
  reason: string,
  values: number[],
  ws: ServerWebSocket<GameSocketData>,
  world: World,
): void {
  player.botStats?.recordSuspiciousPacket(reason);
  if (!suspiciousPacketCloseEligible(reason)) return;

  const count = player.recordSuspiciousPacket();
  if (INVALID_PACKET_AUDIT_COUNTS.has(count)) {
    audit({
      type: 'player.suspicious_packet',
      tick: world.getCurrentTick(),
      accountId: player.accountId,
      details: {
        playerId: player.id,
        opcode,
        reason,
        count,
        values: values.slice(0, 8),
      },
    });
  }
  if (count >= INVALID_PACKET_CLOSE_THRESHOLD) {
    try { ws.close(1008, 'too many invalid packets'); } catch { /* connection closed */ }
  }
}

function isCryptoResponse(value: unknown): value is GameCryptoResponse {
  if (!value || typeof value !== 'object') return false;
  const res = value as Record<string, unknown>;
  return res.version === GAME_CRYPTO_VERSION
    && typeof res.clientNonce === 'string'
    && typeof res.signature === 'string'
    && !!res.clientPublicKey
    && typeof res.clientPublicKey === 'object';
}

async function completeGameSocketHandshake(
  ws: ServerWebSocket<GameSocketData>,
  message: ArrayBuffer,
  world: World,
): Promise<void> {
  const cryptoState = ws.data.crypto;
  if (!cryptoState) throw new Error('missing crypto state');
  const { opcode, str } = decodeStringPacket(message);
  if (opcode !== ClientOpcode.CRYPTO_RESPONSE) throw new Error('expected crypto response');
  const parsed = JSON.parse(str) as unknown;
  if (!isCryptoResponse(parsed)) throw new Error('invalid crypto response');

  const devicePublicKey = world.db.loadDeviceKey(ws.data.accountId, ws.data.deviceId);
  if (!devicePublicKey) throw new Error('missing registered device key');

  const clientPublicKey = await importGameEcdhPublicKey(parsed.clientPublicKey);
  const transcript = buildGameHandshakeTranscript({
    protocolVersion: PROTOCOL_VERSION,
    accountId: ws.data.accountId,
    deviceId: ws.data.deviceId,
    connectionId: cryptoState.connectionId,
    serverNonce: cryptoState.serverNonce,
    clientNonce: parsed.clientNonce,
    serverPublicKey: cryptoState.serverPublicKey,
    clientPublicKey: parsed.clientPublicKey,
  });

  const verified = await verifyGameHandshakeTranscript(devicePublicKey, transcript, parsed.signature);
  if (!verified) throw new Error('bad device-key signature');

  cryptoState.keys = await deriveGameCipherKeysV2({
    privateKey: cryptoState.serverKeyPair.privateKey,
    peerPublicKey: clientPublicKey,
    authToken: cryptoState.token,
    transcript,
    serverNonce: cryptoState.serverNonce,
    clientNonce: parsed.clientNonce,
    connectionId: cryptoState.connectionId,
    accountId: ws.data.accountId,
  });
  cryptoState.handshakeComplete = true;
  cryptoState.encryptEnabled = true;
  cryptoState.sendCounter = 0;
  cryptoState.lastRecvCounter = -1;

  ws.sendBinary(encodeStringPacket(
    ServerOpcode.OPCODE_MAPPING,
    JSON.stringify(opcodeMappingToPayload(cryptoState.opcodeMapping)),
  ));
  cryptoState.opcodeMappingEnabled = true;
  scheduleOpcodeMappingRotation(ws);

  completeGameSocketLogin(ws, world);
}

function scheduleOpcodeMappingRotation(ws: ServerWebSocket<GameSocketData>): void {
  const cryptoState = ws.data.crypto;
  if (!cryptoState || cryptoState.opcodeMappingRotationTimer) return;
  cryptoState.opcodeMappingRotationTimer = setInterval(() => {
    const state = ws.data.crypto;
    if (!state?.handshakeComplete || !state.opcodeMappingEnabled) return;
    state.opcodeMapping = rotateServerOpcodeMapping(state.opcodeMapping, {
      includeAdminServerOpcodes: ws.data.isAdmin,
    });
    ws.sendBinary(encodeStringPacket(
      ServerOpcode.OPCODE_MAPPING,
      JSON.stringify(opcodeMappingToPayload(state.opcodeMapping)),
    ));
  }, OPCODE_MAPPING_ROTATE_MS);
}

function clearOpcodeMappingRotation(ws: ServerWebSocket<GameSocketData>): void {
  const timer = ws.data.crypto?.opcodeMappingRotationTimer;
  if (timer) clearInterval(timer);
  if (ws.data.crypto) ws.data.crypto.opcodeMappingRotationTimer = undefined;
}

export async function handleGameSocketOpen(
  ws: ServerWebSocket<GameSocketData>,
  _world: World
): Promise<void> {
  await installGameSocketEncryption(ws);
}

function completeGameSocketLogin(
  ws: ServerWebSocket<GameSocketData>,
  world: World
): void {
  const { accountId, username } = ws.data;

  const reconnected = world.reconnectPlayer(accountId, ws);
  if (reconnected) return;

  // Replace an existing session for this account only when it is actually
  // allowed to log out. Otherwise a second tab would become a combat-logout
  // bypass.
  if (!world.requestAccountLogout(accountId)) {
    try { ws.close(4009, 'Account is still in combat'); } catch {}
    return;
  }

  // Load saved state or use defaults
  const saved = world.db.loadPlayerState(accountId);

  // Use saved position, or map spawn point for new players
  let mapLevel = saved?.mapLevel ?? 'kcmap';
  // Fallback to kcmap if saved map no longer exists
  try { world.getMap(mapLevel); } catch { mapLevel = 'kcmap'; }
  const map = world.getMap(mapLevel);
  const defaultSpawn = map.findSpawnPoint();
  // One-time forced respawn: any saved row stamped with an older respawn
  // version gets relocated to the current map spawn on this login. After
  // relocation, we bump the row's version so subsequent logins keep their
  // (newly saved) position. Skills/inventory/bank are preserved.
  const needsForcedRespawn = !!saved && (saved.respawnVersion ?? 0) < WORLD_RESPAWN_VERSION;
  // Sanitize saved coordinates: a corrupted DB row (or malicious migration) can
  // hold any number, including NaN, negative values, or values past the map
  // bounds. Without validation, such a row would respawn the player far off-map
  // where chunk loaders silently fail.
  const savedX = saved?.x;
  const savedZ = saved?.z;
  const savedXValid = typeof savedX === 'number' && isFinite(savedX) && savedX >= 0 && savedX < map.width;
  const savedZValid = typeof savedZ === 'number' && isFinite(savedZ) && savedZ >= 0 && savedZ < map.height;
  const useSavedPos = saved && savedXValid && savedZValid && !needsForcedRespawn;
  const spawnX = useSavedPos ? savedX! : defaultSpawn.x;
  const spawnZ = useSavedPos ? savedZ! : defaultSpawn.z;
  console.log(`[GameSocket] Player "${username}" acct=${accountId} saved=${!!saved} savedPos=(${saved?.x}, ${saved?.z}) defaultSpawn=(${defaultSpawn.x}, ${defaultSpawn.z}) final=(${spawnX}, ${spawnZ})${needsForcedRespawn ? ' [respawn-version migration]' : ''}`);

  const player = new Player(username, spawnX, spawnZ, ws, accountId);
  player.isAdmin = ws.data.isAdmin;

  // Apply saved state
  if (saved) {
    player.skills = saved.skills;
    // Pad saved inventory to 28 slots
    const inv = saved.inventory;
    while (inv.length < 30) inv.push(null);
    player.inventory = inv;
    player.equipment = saved.equipment;
    player.equipmentQuantities = saved.equipmentQuantities;
    player.stance = saved.stance;
    player.magicStance = saved.magicStance;
    player.autocastSpellIndex = world.isAutocastableSpellIndex(saved.autocastSpellIndex)
      ? saved.autocastSpellIndex
      : -1;
    player.autoRetaliate = saved.autoRetaliate;
    player.appearance = saved.appearance;
    // Pad bank to BANK_SIZE — older saves may have a shorter or empty array
    const bank = saved.bank;
    while (bank.length < player.bank.length) bank.push(null);
    player.bank = bank.slice(0, player.bank.length);
    player.quests = saved.quests;
    player.renown = saved.renown;
    player.currentMapLevel = mapLevel; // use validated mapLevel, not raw saved value
    // Clamp floor to a sane signed range. Floors are signed: negative floors
    // are valid for basements/caves, 0 is ground, positive floors are upstairs.
    const savedFloor = saved.floor;
    player.currentFloor = (typeof savedFloor === 'number' && isFinite(savedFloor))
      ? Math.max(-10, Math.min(10, Math.floor(savedFloor)))
      : 0;
    player.effectiveY = saved.y; // persisted server-resolved height seed for spawn
    player.syncHealthFromSkills();
    // Forced-respawn migration: drop floor + effectiveY so the player lands
    // cleanly on ground at the new spawn. Without this, a player saved on
    // an upper floor of a building gets relocated to the new spawn tile
    // but stays on the old floor index / Y, which the recovery loop below
    // only patches up if the old floor happens to be blocked there.
    if (needsForcedRespawn) {
      player.currentFloor = 0;
      player.effectiveY = 0;
    }

    // Unstick recovery. If the saved floor is blocked at the saved tile, try
    // other floors and fall back to spawn if none work. If the saved floor is
    // upper but floor 0 is also walkable underneath, only downgrade when the
    // saved visual Y does not actually match that upper floor. Multi-storey
    // KC buildings intentionally have walkable floor 0 below real upper
    // floors, so "floor 0 walkable" alone is not corruption.
    const tx = Math.floor(player.position.x);
    const tz = Math.floor(player.position.y);
    if (map.isTileBlockedOnFloor(tx, tz, player.currentFloor)) {
      let recovered = false;
      const knownFloors = typeof map.getKnownFloors === 'function'
        ? map.getKnownFloors()
        : [0, -1, 1, -2, 2, -3, 3];
      const floorsToTry = [...new Set([0, ...knownFloors, -1, 1, -2, 2, -3, 3])];
      for (const f of floorsToTry) {
        if (f !== player.currentFloor && !map.isTileBlockedOnFloor(tx, tz, f)) {
          console.log(`[GameSocket] Recovering "${username}": saved floor ${player.currentFloor} blocked at (${tx},${tz}), switching to floor ${f}`);
          player.currentFloor = f;
          recovered = true;
          break;
        }
      }
      if (!recovered) {
        console.log(`[GameSocket] Recovering "${username}": saved tile (${tx},${tz}) blocked on all floors, respawning at default`);
        player.teleportTo(defaultSpawn.x, defaultSpawn.z);
        player.currentFloor = 0;
      }
    } else if (
      player.currentFloor !== 0
      && !map.isTileBlockedOnFloor(tx, tz, 0)
      && !savedFloorMatchesHeightSeed(map, player.position.x, player.position.y, player.currentFloor, player.effectiveY)
    ) {
      console.log(`[GameSocket] Downgrading "${username}" from floor ${player.currentFloor} → 0 (saved Y does not match upper floor at saved tile)`);
      player.currentFloor = 0;
    }

    if (needsForcedRespawn) {
      const effectiveY = map.getEffectiveHeightOnFloor(
        player.position.x,
        player.position.y,
        player.currentFloor,
        player.effectiveY,
      );
      world.db.saveRespawnMigration(accountId, player, effectiveY, WORLD_RESPAWN_VERSION);
    }
  }

  ws.data.playerId = player.id;
  player.ip = ws.data.ip;
  player.deviceId = ws.data.deviceId;
  world.addPlayer(player);
}

/** Hard ceiling on a single inbound game frame. Anything larger is hostile —
 *  reject before spending CPU on decryption. */
const MAX_GAME_FRAME_BYTES = 4096;

function applyClientOpcodeMapping(
  ws: ServerWebSocket<GameSocketData>,
  message: ArrayBuffer,
): ArrayBuffer {
  const cryptoState = ws.data.crypto;
  if (!cryptoState?.opcodeMappingEnabled) return message;
  return rewriteArrayBufferOpcode(message, cryptoState.opcodeMapping.clientWireToLogical, true);
}

export function handleGameSocketMessage(
  ws: ServerWebSocket<GameSocketData>,
  message: ArrayBuffer | string,
  world: World
): void {
  if (typeof message === 'string') return;
  // Drop oversized frames BEFORE the (expensive) decrypt queue / handshake
  // decode. Legitimate frames are tiny — PLAYER_MOVE (the largest) is ~240B
  // encrypted; 4 KB is a generous ceiling that still bounds a decrypt-CPU flood.
  if (message.byteLength > MAX_GAME_FRAME_BYTES) {
    console.warn(`[ws] oversized game frame ${message.byteLength}B account=${ws.data.accountId}`);
    try { ws.close(1009, 'frame too large'); } catch {}
    return;
  }
  const cryptoState = ws.data.crypto;
  if (cryptoState) {
    cryptoState.recvQueue = cryptoState.recvQueue
      .then(async () => {
        if (!cryptoState.handshakeComplete) {
          await completeGameSocketHandshake(ws, message, world);
          return;
        }
        const decrypted = await decryptGameSocketMessage(ws, message);
        handleDecryptedGameSocketMessage(ws, applyClientOpcodeMapping(ws, decrypted), world);
      })
      .catch((e) => {
        console.warn(`[ws] encrypted packet failed account=${ws.data.accountId}:`, e instanceof Error ? e.message : e);
        try { ws.close(1008, 'bad encrypted packet'); } catch {}
      });
    return;
  }
  handleDecryptedGameSocketMessage(ws, message, world);
}

function handleDecryptedGameSocketMessage(
  ws: ServerWebSocket<GameSocketData>,
  message: ArrayBuffer,
  world: World
): void {

  // Rate limit BEFORE parsing so a malformed-packet flood costs the attacker
  // their rate budget. Without this, garbage frames are caught by the try/catch
  // below without consuming any budget, letting an attacker burn CPU on decode.
  const playerId = ws.data.playerId;
  if (!playerId) return;
  const player = world.getPlayer(playerId);
  if (!player || player.ws !== ws || player.disconnected) return;
  if (player && !player.checkRateLimit()) return;

  // Empty / malformed frames blow up decodePacket (view.getUint8(0) RangeError
  // on a 0-byte buffer). Bun's WS layer usually rejects empty frames but a
  // hostile client can still ship junk. Catch + close instead of crashing the
  // entire message handler. Logs at warn so we notice if it's a regular thing.
  let opcode: number;
  let values: number[];
  try {
    ({ opcode, values } = decodePacket(message));
  } catch (e) {
    console.warn(`[ws] malformed packet from playerId=${ws.data.playerId ?? '?'}: ${e instanceof Error ? e.message : e}`);
    reportSuspiciousPacket(player, -1, 'malformed-frame', [], ws, world);
    try { ws.close(1003, 'malformed packet'); } catch {}
    return;
  }

  if (!checkOpcodeRateLimit(player, opcode, ws, world)) return;
  magicOpcodeDebug(player, opcode, values, 'received');
  const validation = validateClientPacket(player, opcode, values, world);
  if (!validation.ok) {
    magicOpcodeDebug(player, opcode, values, 'validation-failed', { reason: validation.reason });
    reportSuspiciousPacket(player, opcode, validation.reason ?? 'invalid-packet', values, ws, world);
    return;
  }
  if (opcodeRequiresBrowserInputTelemetry(opcode, values, player) && player.botStats) {
    const now = performance.now();
    const hasRecentInput = player.botStats.hasRecentBrowserInput(now, BROWSER_INPUT_MAX_AGE_MS);
    const hasRecentActivity = player.botStats.hasRecentClientActivity(now, BROWSER_INPUT_MAX_AGE_MS);
    player.botStats.recordGameplayCommandInputCheck(hasRecentInput, hasRecentActivity);
    if (!hasRecentInput && BLOCK_INPUTLESS_GAMEPLAY) {
      magicOpcodeDebug(player, opcode, values, 'input-telemetry-failed');
      reportSuspiciousPacket(player, opcode, 'missing-input-telemetry', values, ws, world);
      return;
    }
  }
  if (opcodeCountsAsActivity(opcode)) world.recordPlayerActivity(playerId);

  switch (opcode) {
    case ClientOpcode.PLAYER_MOVE: {
      const pathLength = values[0];
      if (!Number.isInteger(pathLength) || pathLength < 0 || pathLength > 50) return;
      if (values.length < 1 + pathLength * 2) return;
      player.botStats?.recordMoveCommand(pathLength, player.hasMoveQueue());
      const path: { x: number; z: number }[] = [];
      for (let i = 0; i < pathLength && (1 + i * 2 + 1) < values.length; i++) {
        path.push({
          x: values[1 + i * 2] / 10,
          z: values[1 + i * 2 + 1] / 10,
        });
      }
      world.handlePlayerMove(playerId, path);
      break;
    }

    case ClientOpcode.PLAYER_ATTACK_NPC: {
      if (!hasValues(values, 1)) return;
      const npcEntityId = values[0];
      world.handlePlayerAttackNpc(playerId, npcEntityId);
      break;
    }

    case ClientOpcode.PLAYER_FOLLOW: {
      if (!hasValues(values, 1)) return;
      world.handlePlayerFollow(playerId, values[0]);
      break;
    }

    case ClientOpcode.PLAYER_PICKUP_ITEM: {
      if (!hasValues(values, 1)) return;
      const groundItemId = values[0];
      world.handlePlayerPickup(playerId, groundItemId);
      break;
    }

    case ClientOpcode.PLAYER_DROP_ITEM: {
      if (!hasValues(values, 2)) return;
      const slot = values[0];
      const expectedItemId = values[1];
      world.handlePlayerDrop(playerId, slot, expectedItemId);
      break;
    }

    case ClientOpcode.PLAYER_EQUIP_ITEM: {
      if (!hasValues(values, 2)) return;
      const slot = values[0];
      const expectedItemId = values[1];
      world.handlePlayerEquip(playerId, slot, expectedItemId);
      break;
    }

    case ClientOpcode.PLAYER_UNEQUIP_ITEM: {
      if (!hasValues(values, 1)) return;
      const equipSlot = values[0];
      world.handlePlayerUnequip(playerId, equipSlot);
      break;
    }

    case ClientOpcode.PLAYER_EAT_ITEM: {
      if (!hasValues(values, 2)) return;
      const slot = values[0];
      const expectedItemId = values[1];
      world.handlePlayerEat(playerId, slot, expectedItemId);
      break;
    }

    case ClientOpcode.PLAYER_SET_STANCE: {
      if (!hasValues(values, 1)) return;
      const stanceIdx = values[0];
      world.handlePlayerSetStance(playerId, stanceIdx);
      break;
    }

    case ClientOpcode.PLAYER_SET_MAGIC_STANCE: {
      if (!hasValues(values, 1)) return;
      world.handlePlayerSetMagicStance(playerId, values[0]);
      break;
    }

    case ClientOpcode.PLAYER_CAST_SPELL: {
      if (!hasValues(values, 2)) return;
      const spellIndex = values[0];
      const targetEntityId = values[1];
      world.handlePlayerCastSpell(playerId, spellIndex, targetEntityId);
      break;
    }

    case ClientOpcode.PLAYER_SET_AUTOCAST: {
      if (!hasValues(values, 1)) return;
      world.handlePlayerSetAutocast(playerId, values[0]);
      break;
    }

    case ClientOpcode.PLAYER_SET_AUTO_RETALIATE: {
      if (!hasValues(values, 1)) return;
      world.handlePlayerSetAutoRetaliate(playerId, values[0] === 1);
      break;
    }

    case ClientOpcode.PLAYER_INTERACT_OBJECT: {
      if (!hasValues(values, 1)) return;
      const objectEntityId = values[0];
      const actionIndex = values[1] ?? 0;
      const recipeIndex = values[2] ?? -1;
      const expectedDoorOpen = values[3] === 0 || values[3] === 1 ? values[3] === 1 : null;
      const recipeQuantity = values[4] ?? 1;
      world.handlePlayerInteractObject(playerId, objectEntityId, actionIndex, recipeIndex, expectedDoorOpen, recipeQuantity);
      break;
    }

    case ClientOpcode.PLAYER_USE_ITEM_ON_ITEM: {
      if (!hasValues(values, 4)) return;
      const fromSlot = values[0];
      const fromItemId = values[1];
      const toSlot = values[2];
      const toItemId = values[3];
      const quantity = values[4] ?? 1;
      const recipeIndex = values[5] ?? 0;
      world.handlePlayerUseItemOnItem(playerId, fromSlot, fromItemId, toSlot, toItemId, quantity, recipeIndex);
      break;
    }

    case ClientOpcode.PLAYER_USE_ITEM_ON_OBJECT: {
      if (!hasValues(values, 3)) return;
      const invSlot = values[0];
      const itemId = values[1];
      const objectEntityId = values[2];
      world.handlePlayerUseItemOnObject(playerId, invSlot, itemId, objectEntityId);
      break;
    }

    case ClientOpcode.PLAYER_USE_ITEM_ON_NPC: {
      if (!hasValues(values, 3)) return;
      const invSlot = values[0];
      const itemId = values[1];
      const npcEntityId = values[2];
      world.handlePlayerUseItemOnNpc(playerId, invSlot, itemId, npcEntityId);
      break;
    }

    case ClientOpcode.PLAYER_TALK_NPC: {
      if (!hasValues(values, 1)) return;
      const npcEntityId = values[0];
      world.handlePlayerTalkNpc(playerId, npcEntityId);
      break;
    }

    case ClientOpcode.DIALOGUE_CHOOSE: {
      if (!hasValues(values, 2)) return;
      const npcEntityId = values[0];
      const sessionId = values.length >= 3 ? values[1] : -1;
      const optionIndex = values.length >= 3 ? values[2] : values[1];
      world.handleDialogueChoose(playerId, npcEntityId, sessionId, optionIndex);
      break;
    }

    case ClientOpcode.DIALOGUE_CLOSE: {
      if (!hasValues(values, 2)) return;
      const npcEntityId = values[0];
      const sessionId = values[1];
      world.handleDialogueClose(playerId, npcEntityId, sessionId);
      break;
    }

    case ClientOpcode.PLAYER_BUY_ITEM: {
      if (!hasValues(values, 1)) return;
      const itemId = values[0];
      const quantity = values[1] ?? 1;
      world.handlePlayerBuyItem(playerId, itemId, quantity);
      break;
    }

    case ClientOpcode.PLAYER_SELL_ITEM: {
      if (!hasValues(values, 2)) return;
      const slot = values[0];
      const quantity = values[1] ?? 1;
      const expectedItemId = values[2];
      world.handlePlayerSellItem(playerId, slot, quantity, expectedItemId);
      break;
    }

    case ClientOpcode.PLAYER_MOVE_INV_ITEM: {
      if (!hasValues(values, 3)) return;
      const fromSlot = values[0];
      const toSlot = values[1];
      const expectedItemId = values[2];
      world.handlePlayerMoveInvItem(playerId, fromSlot, toSlot, expectedItemId);
      break;
    }

    // CLIENT_FLOOR_HINT removed — was a security hole. A malicious client
    // could spoof any floor at any tile that happened to be walkable on
    // multiple floors, bypassing legitimate stair gating. Floor changes are
    // now server-authoritative (see World.tickTransitions) — they fire only
    // when the player walks onto a placed stair GLB whose registration
    // (GameMap.ts) mirrors the top tile across both connecting floors.

    case ClientOpcode.CLIENT_POSITION_Y: {
      // Deprecated compatibility no-op. Older clients reported visual Y here;
      // persistence now uses server-derived player.effectiveY only.
      break;
    }

    case ClientOpcode.MAP_READY: {
      world.handleMapReady(playerId);
      break;
    }

    case ClientOpcode.SET_APPEARANCE: {
      if (!hasValues(values, APPEARANCE_WIRE_FIELD_COUNT)) return;
      const appearance = appearanceFromWireValues(values);
      world.handleSetAppearance(playerId, appearance);
      break;
    }

    case ClientOpcode.APPEARANCE_CLOSE: {
      world.handleAppearanceClose(playerId);
      break;
    }

    case ClientOpcode.BANK_REQUEST_OPEN: {
      world.handleBankOpenRequest(playerId);
      break;
    }
    case ClientOpcode.BANK_DEPOSIT: {
      if (!hasValues(values, 2)) return;
      const slot = values[0];
      const expectedItemId = values[1];
      const quantity = decodeQuantityValues(values, 2, 1);
      world.handleBankDeposit(playerId, slot, expectedItemId, quantity);
      break;
    }
    case ClientOpcode.BANK_WITHDRAW: {
      if (!hasValues(values, 2)) return;
      const bankSlot = values[0];
      const expectedItemId = values[1];
      const quantity = decodeQuantityValues(values, 2, 1);
      world.handleBankWithdraw(playerId, bankSlot, expectedItemId, quantity);
      break;
    }
    case ClientOpcode.BANK_CLOSE: {
      world.handleBankClose(playerId);
      break;
    }

    case ClientOpcode.TRADE_REQUEST: {
      if (!hasValues(values, 1)) return;
      const targetEntityId = values[0];
      world.handleTradeRequest(playerId, targetEntityId);
      break;
    }
    case ClientOpcode.TRADE_ACCEPT_REQUEST: {
      if (!hasValues(values, 1)) return;
      const requesterEntityId = values[0];
      world.handleTradeAcceptRequest(playerId, requesterEntityId);
      break;
    }
    case ClientOpcode.TRADE_DECLINE: {
      world.handleTradeDecline(playerId);
      break;
    }
    case ClientOpcode.TRADE_OFFER_ITEM: {
      if (!hasValues(values, 2)) return;
      const slot = values[0];
      const expectedItemId = values[1];
      const quantity = decodeQuantityValues(values, 2, 1);
      world.handleTradeOfferItem(playerId, slot, expectedItemId, quantity);
      break;
    }
    case ClientOpcode.TRADE_REMOVE_OFFERED: {
      if (!hasValues(values, 2)) return;
      const offerSlot = values[0];
      const expectedItemId = values[1];
      const quantity = decodeQuantityValues(values, 2, 1);
      world.handleTradeRemoveOffered(playerId, offerSlot, expectedItemId, quantity);
      break;
    }
    case ClientOpcode.TRADE_ACCEPT: {
      world.handleTradeAccept(playerId);
      break;
    }

    case ClientOpcode.DUEL_REQUEST: {
      if (!hasValues(values, 1)) return;
      world.handleDuelRequest(playerId, values[0]);
      break;
    }
    case ClientOpcode.DUEL_ACCEPT_REQUEST: {
      if (!hasValues(values, 1)) return;
      world.handleDuelAcceptRequest(playerId, values[0]);
      break;
    }
    case ClientOpcode.DUEL_DECLINE: {
      world.handleDuelDecline(playerId);
      break;
    }
    case ClientOpcode.DUEL_STAKE_ITEM: {
      if (!hasValues(values, 2)) return;
      const slot = values[0];
      const expectedItemId = values[1];
      const quantity = decodeQuantityValues(values, 2, 1);
      world.handleDuelStakeItem(playerId, slot, expectedItemId, quantity);
      break;
    }
    case ClientOpcode.DUEL_REMOVE_STAKE: {
      if (!hasValues(values, 2)) return;
      const stakeSlot = values[0];
      const expectedItemId = values[1];
      const quantity = decodeQuantityValues(values, 2, 1);
      world.handleDuelRemoveStake(playerId, stakeSlot, expectedItemId, quantity);
      break;
    }
    case ClientOpcode.DUEL_ACCEPT: {
      world.handleDuelAccept(playerId);
      break;
    }

    case ClientOpcode.CLIENT_PING: {
      player.botStats?.recordHeartbeat(values[0] ?? 0);
      try {
        ws.sendBinary(encodePacket(ServerOpcode.SERVER_PONG, values[0] ?? 0, world.getTickForHeartbeat()));
      } catch { /* connection closed */ }
      break;
    }

    case ClientOpcode.CLIENT_ACTIVITY: {
      if (values.length === 0) {
        player.botStats?.recordClientActivity();
      } else {
        player.botStats?.recordClientActivity(values[0] as ClientActivityKind, values[1], values[2], values[3]);
      }
      break;
    }

    case ClientOpcode.CURSOR_POSITION: {
      if (!hasValues(values, 2)) return;
      player.botStats?.recordCursorPosition(values[0], values[1]);
      break;
    }

    default:
      console.log(`Unknown game opcode: ${opcode}`);
  }
}

export function handleGameSocketClose(
  ws: ServerWebSocket<GameSocketData>,
  world: World
): void {
  clearOpcodeMappingRotation(ws);
  const playerId = ws.data.playerId;
  console.log(`[GameSocket] close account=${ws.data.accountId} player=${playerId ?? 'none'}`);
  if (playerId) {
    // Saves + removes, OR defers removal if the player is in a post-combat
    // logout block. See World.handlePlayerDisconnect.
    world.handlePlayerDisconnect(playerId, ws);
  }
}
