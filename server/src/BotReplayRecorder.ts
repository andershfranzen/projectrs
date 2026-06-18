import { Buffer } from 'buffer';
import { decodePacket, decodePacketBatch, decodeStringPacket, ServerOpcode } from '@projectrs/shared';
import type { GameDatabase, BotReplayEventInput } from './Database';
import type { Player } from './entity/Player';

const DEFAULT_MAX_EVENTS = 4000;
const DEFAULT_MIN_PERSIST_INTERVAL_MS = 60_000;
const MAX_PACKET_BASE64_CHARS = 96_000;

export type BotReplayEventKind = 'session' | 'snapshot' | 'client' | 'server' | 'flag';

export interface BotReplayClientCommandDetails {
  opcode: number;
  values: number[];
  proof: {
    inputSeq: number;
    capabilityId: number;
    hasCapability: boolean;
  } | null;
  requiresInputProof: boolean;
  hasValidInputTicket: boolean;
  inputTicket: {
    kind: number;
    x: number;
    y: number;
    shape?: Record<string, unknown>;
  } | null;
  actionCapability: {
    kind: number;
    targetEntityId: number;
    actionIndex: number;
  } | null;
}

interface BotReplaySessionBuffer {
  accountId: number;
  username: string;
  playerId: number;
  loginRowId: number | null;
  startedAt: number;
  events: BotReplayEventInput[];
  lastPersistAtMs: number;
}

interface BotReplayRecorderOptions {
  maxEvents?: number;
  minPersistIntervalMs?: number;
}

function envInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = Bun.env[name];
  const value = raw == null || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function unixSeconds(ms: number = Date.now()): number {
  return Math.floor(ms / 1000);
}

function packetBytes(data: Bun.BufferSource): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new Uint8Array(data as unknown as ArrayBuffer);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function packetBase64(bytes: Uint8Array): string | null {
  const raw = Buffer.from(bytes).toString('base64');
  return raw.length <= MAX_PACKET_BASE64_CHARS ? raw : null;
}

function serverPacketDescription(bytes: Uint8Array): {
  opcode: number | null;
  values: number[];
  details: Record<string, unknown>;
} {
  if (bytes.byteLength === 0) return { opcode: null, values: [], details: { malformed: 'empty-packet' } };
  const opcode = bytes[0];
  const buffer = exactArrayBuffer(bytes);
  if (opcode === ServerOpcode.PACKET_BATCH) {
    try {
      const packets = decodePacketBatch(buffer);
      const opcodes = packets.slice(0, 24).map((packet) => new Uint8Array(packet)[0] ?? -1);
      return { opcode, values: [], details: { batchCount: packets.length, opcodes } };
    } catch (err) {
      return { opcode, values: [], details: { malformed: err instanceof Error ? err.message : 'bad-batch' } };
    }
  }
  try {
    const decoded = decodePacket(buffer);
    return {
      opcode,
      values: decoded.values.slice(0, 96),
      details: decoded.values.length > 96 ? { valuesTruncated: decoded.values.length } : {},
    };
  } catch {
    try {
      const decoded = decodeStringPacket(buffer);
      const details: Record<string, unknown> = {
        stringLength: decoded.str.length,
        extraValues: decoded.values.slice(0, 32),
      };
      if (opcode !== ServerOpcode.ACTION_CAPABILITIES) details.stringPreview = decoded.str.slice(0, 120);
      if (decoded.values.length > 32) details.extraValuesTruncated = decoded.values.length;
      return { opcode, values: [], details };
    } catch (err) {
      return { opcode, values: [], details: { malformed: err instanceof Error ? err.message : 'bad-packet' } };
    }
  }
}

function playerEventBase(player: Player): Pick<BotReplayEventInput, 'mapLevel' | 'floor' | 'x' | 'z'> {
  return {
    mapLevel: player.currentMapLevel,
    floor: player.currentFloor,
    x: player.position.x,
    z: player.position.y,
  };
}

export class BotReplayRecorder {
  private readonly maxEvents: number;
  private readonly minPersistIntervalMs: number;
  private readonly sessions = new Map<number, BotReplaySessionBuffer>();

  constructor(private readonly db: GameDatabase, options: BotReplayRecorderOptions = {}) {
    this.maxEvents = options.maxEvents ?? envInteger('BOT_REPLAY_BUFFER_EVENTS', DEFAULT_MAX_EVENTS, 100, 50_000);
    this.minPersistIntervalMs = options.minPersistIntervalMs ?? envInteger(
      'BOT_REPLAY_MIN_PERSIST_INTERVAL_MS',
      DEFAULT_MIN_PERSIST_INTERVAL_MS,
      0,
      10 * 60_000,
    );
  }

  startPlayer(player: Player, tick: number, reason: 'login' | 'reconnect' = 'login'): void {
    const nowMs = Date.now();
    const existing = this.sessions.get(player.id);
    if (existing) {
      existing.loginRowId = player.loginRowId > 0 ? player.loginRowId : existing.loginRowId;
      existing.username = player.name;
      this.push(player, {
        kind: 'session',
        t: nowMs,
        tick,
        result: reason,
        details: { loginRowId: existing.loginRowId },
      });
      this.recordSnapshot(player, tick, reason);
      return;
    }

    const session: BotReplaySessionBuffer = {
      accountId: player.accountId,
      username: player.name,
      playerId: player.id,
      loginRowId: player.loginRowId > 0 ? player.loginRowId : null,
      startedAt: unixSeconds(nowMs),
      events: [],
      lastPersistAtMs: 0,
    };
    this.sessions.set(player.id, session);
    this.push(player, {
      kind: 'session',
      t: nowMs,
      tick,
      result: reason,
      details: { loginRowId: session.loginRowId, ip: player.ip || null, deviceId: player.deviceId || null },
    });
    this.recordSnapshot(player, tick, reason);
  }

  endPlayer(player: Player, tick: number, reason: string): void {
    if (!this.sessions.has(player.id)) return;
    this.recordSnapshot(player, tick, reason);
    this.push(player, {
      kind: 'session',
      t: Date.now(),
      tick,
      result: reason,
      details: { loginRowId: player.loginRowId > 0 ? player.loginRowId : null },
    });
    this.sessions.delete(player.id);
  }

  recordSnapshot(player: Player, tick: number, reason: string): void {
    this.push(player, {
      kind: 'snapshot',
      t: Date.now(),
      tick,
      result: reason,
      details: {
        health: player.health,
        maxHealth: player.maxHealth,
        runEnergy: player.runEnergyPercent(),
        movementMode: player.movementMode,
        hasMoveQueue: player.hasMoveQueue(),
        openInterface: player.openInterface,
        combatLevel: player.combatLevel,
      },
    });
  }

  recordClientCommand(player: Player, tick: number, command: BotReplayClientCommandDetails): void {
    this.push(player, {
      kind: 'client',
      t: Date.now(),
      tick,
      opcode: command.opcode,
      values: command.values,
      result: 'accepted',
      details: {
        proof: command.proof,
        requiresInputProof: command.requiresInputProof,
        hasValidInputTicket: command.hasValidInputTicket,
        inputTicket: command.inputTicket,
        actionCapability: command.actionCapability,
      },
    });
  }

  recordServerPacket(player: Player, tick: number, data: Bun.BufferSource): void {
    const bytes = packetBytes(data);
    const description = serverPacketDescription(bytes);
    this.push(player, {
      kind: 'server',
      t: Date.now(),
      tick,
      opcode: description.opcode,
      values: description.values,
      rawBase64: packetBase64(bytes),
      byteLength: bytes.byteLength,
      details: description.details,
    });
  }

  recordFlag(player: Player, tick: number, opcode: number, reason: string, values: number[]): void {
    this.push(player, {
      kind: 'flag',
      t: Date.now(),
      tick,
      opcode,
      values,
      result: 'rejected',
      reason,
      details: {
        riskScore: player.botStats?.riskScore ?? 0,
        riskLevel: player.botStats?.riskLevel ?? 'low',
      },
    });
    this.recordSnapshot(player, tick, `flag:${reason}`);
  }

  persistPlayer(
    player: Player,
    tick: number,
    triggerReason: string,
    hardFlags: string[] = [triggerReason],
    riskScore: number = player.botStats?.riskScore ?? 0,
    force: boolean = false,
  ): number | null {
    const session = this.sessions.get(player.id);
    if (!session || session.events.length === 0) return null;
    const nowMs = Date.now();
    if (!force && this.minPersistIntervalMs > 0 && nowMs - session.lastPersistAtMs < this.minPersistIntervalMs) {
      return null;
    }
    session.lastPersistAtMs = nowMs;
    this.recordSnapshot(player, tick, `persist:${triggerReason}`);
    const replayId = this.db.saveBotReplayTrace({
      accountId: session.accountId,
      username: session.username,
      playerId: session.playerId,
      loginRowId: session.loginRowId,
      triggerReason,
      riskScore,
      hardFlags,
      startedAt: session.startedAt,
      endedAt: unixSeconds(nowMs),
      mapLevel: player.currentMapLevel,
      floor: player.currentFloor,
      startX: player.position.x,
      startZ: player.position.y,
      events: session.events,
    });
    return replayId;
  }

  private push(player: Player, event: Omit<BotReplayEventInput, 'mapLevel' | 'floor' | 'x' | 'z'>): void {
    const session = this.sessions.get(player.id);
    if (!session) return;
    session.events.push({
      ...event,
      ...playerEventBase(player),
    });
    while (session.events.length > this.maxEvents) session.events.shift();
  }
}
