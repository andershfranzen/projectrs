import {
  NPC_VISUAL_SCALE_MAX,
  NPC_VISUAL_SCALE_MIN,
  type NpcDef,
  type SpawnEntry,
} from './types';

type BankAccessSpawnRef = Pick<SpawnEntry, 'npcId' | 'x' | 'z' | 'name'> & { id?: number };
type BankAccessNpcDefRef = Pick<NpcDef, 'id' | 'name' | 'bankAccess'>;

export const BANKER_NPC_ID = 16;
export const BANK_ACCESS_SPAWN_NAME = 'Banker';

/** Bank-enabled NPCs are gameplay-critical. Require an explicit Banker spawn
 *  name so accidental unnamed npcId=16 drops do not open bank access, while
 *  allowing authored bankers to be duplicated or moved freely. */
export function isAllowedBankAccessSpawn(_mapId: string, spawn: BankAccessSpawnRef): boolean {
  return spawn.npcId === BANKER_NPC_ID && spawn.name === BANK_ACCESS_SPAWN_NAME;
}

export function bankAccessSpawnViolation(
  mapId: string,
  spawn: BankAccessSpawnRef,
  npcDef: BankAccessNpcDefRef | undefined,
): string | null {
  if (!npcDef?.bankAccess) return null;
  if (isAllowedBankAccessSpawn(mapId, spawn)) return null;

  const spawnLabel = spawn.id == null ? 'spawn' : `spawn ${spawn.id}`;
  const nameLabel = spawn.name ? `"${spawn.name}"` : 'unnamed';
  return `${mapId} ${spawnLabel} at (${spawn.x}, ${spawn.z}) is ${nameLabel} but uses bank-access NPC ${npcDef.name} (${spawn.npcId}). Bank-enabled spawns must be explicitly named "${BANK_ACCESS_SPAWN_NAME}".`;
}

export function validateBankAccessSpawns(
  mapId: string,
  spawns: readonly BankAccessSpawnRef[],
  resolveNpcDef: (npcId: number) => BankAccessNpcDefRef | undefined,
): string[] {
  const errors: string[] = [];
  for (const spawn of spawns) {
    const violation = bankAccessSpawnViolation(mapId, spawn, resolveNpcDef(spawn.npcId));
    if (violation) errors.push(violation);
  }
  return errors;
}

export type NpcAuthoringIssueSeverity = 'error' | 'warning';

export interface NpcAuthoringIssue {
  severity: NpcAuthoringIssueSeverity;
  code: string;
  message: string;
  field?: string;
  npcId?: number;
  spawnId?: number;
  spawnIndex?: number;
}

type NpcAuthoringRecord = Record<string, unknown>;
type NpcAuthoringSpawnDefRef = Pick<NpcDef, 'id' | 'name'> & Partial<Pick<NpcDef, 'bankAccess' | 'size' | 'stationary' | 'wanderRange'>>;

export interface ValidateNpcSpawnsForAuthoringOptions {
  mapId: string;
  width?: number;
  height?: number;
  spawns: readonly unknown[];
  resolveNpcDef: (npcId: number) => NpcAuthoringSpawnDefRef | undefined;
}

function isRecord(value: unknown): value is NpcAuthoringRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function nonNegativeFiniteNumber(value: unknown): value is number {
  return finiteNumber(value) && value >= 0;
}

function spawnIssue(
  severity: NpcAuthoringIssueSeverity,
  code: string,
  message: string,
  spawn: NpcAuthoringRecord | null,
  spawnIndex: number,
  field?: string,
): NpcAuthoringIssue {
  const spawnId = spawn && positiveInteger(spawn.id) ? spawn.id : undefined;
  const npcId = spawn && positiveInteger(spawn.npcId) ? spawn.npcId : undefined;
  return {
    severity,
    code,
    message,
    ...(field ? { field } : {}),
    ...(npcId !== undefined ? { npcId } : {}),
    ...(spawnId !== undefined ? { spawnId } : {}),
    spawnIndex,
  };
}

function defIssue(
  severity: NpcAuthoringIssueSeverity,
  code: string,
  message: string,
  def: NpcAuthoringRecord | null,
  field?: string,
): NpcAuthoringIssue {
  const npcId = def && positiveInteger(def.id) ? def.id : undefined;
  return {
    severity,
    code,
    message,
    ...(field ? { field } : {}),
    ...(npcId !== undefined ? { npcId } : {}),
  };
}

function isTileCentered(value: number): boolean {
  return Math.abs(value - (Math.floor(value) + 0.5)) < 0.001;
}

function formatSpawnRef(spawn: NpcAuthoringRecord, spawnIndex: number): string {
  const id = positiveInteger(spawn.id) ? `spawn ${spawn.id}` : `spawn row ${spawnIndex + 1}`;
  const npc = positiveInteger(spawn.npcId) ? `NPC ${spawn.npcId}` : 'unknown NPC';
  return `${id} (${npc})`;
}

function validateOptionalNonNegativeNumber(
  issues: NpcAuthoringIssue[],
  spawn: NpcAuthoringRecord,
  spawnIndex: number,
  field: string,
): void {
  if (spawn[field] === undefined) return;
  if (!nonNegativeFiniteNumber(spawn[field])) {
    issues.push(spawnIssue('error', 'spawn.invalidNumber', `${formatSpawnRef(spawn, spawnIndex)} has invalid ${field}; use a non-negative number.`, spawn, spawnIndex, field));
  }
}

function validateEquipmentArray(
  issues: NpcAuthoringIssue[],
  owner: NpcAuthoringRecord,
  field: string,
  messagePrefix: string,
  issueFactory: (severity: NpcAuthoringIssueSeverity, code: string, message: string, field?: string) => NpcAuthoringIssue,
): void {
  const value = owner[field];
  if (value === undefined) return;
  if (!Array.isArray(value) || (value.length !== 10 && value.length !== 11)) {
    issues.push(issueFactory('error', 'npc.invalidEquipment', `${messagePrefix} has invalid ${field}; expected a 10- or 11-slot equipment array.`, field));
    return;
  }
  for (let i = 0; i < value.length; i++) {
    if (!Number.isInteger(value[i]) || (value[i] as number) < 0) {
      issues.push(issueFactory('error', 'npc.invalidEquipmentItem', `${messagePrefix} has invalid ${field}[${i}]; item ids must be non-negative integers.`, field));
      return;
    }
  }
}

function validateStatsObject(
  issues: NpcAuthoringIssue[],
  spawn: NpcAuthoringRecord,
  spawnIndex: number,
): void {
  const value = spawn.stats;
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push(spawnIssue('error', 'spawn.invalidStats', `${formatSpawnRef(spawn, spawnIndex)} has invalid stats; expected an object.`, spawn, spawnIndex, 'stats'));
    return;
  }
  const numericFields = [
    'health', 'attack', 'defence', 'strength', 'combatLevel', 'attackBonus', 'strengthBonus',
    'stabDefence', 'slashDefence', 'crushDefence', 'rangedDefence', 'magicDefence',
    'attackSpeed', 'respawnTime',
  ];
  for (const field of numericFields) {
    if (value[field] !== undefined && !finiteNumber(value[field])) {
      issues.push(spawnIssue('error', 'spawn.invalidStatsNumber', `${formatSpawnRef(spawn, spawnIndex)} has invalid stats.${field}; expected a finite number.`, spawn, spawnIndex, `stats.${field}`));
    }
  }
  if (value.health !== undefined && finiteNumber(value.health) && value.health <= 0) {
    issues.push(spawnIssue('error', 'spawn.invalidHealth', `${formatSpawnRef(spawn, spawnIndex)} has health <= 0.`, spawn, spawnIndex, 'stats.health'));
  }
  for (const field of ['attackSpeed', 'respawnTime']) {
    if (value[field] !== undefined && finiteNumber(value[field]) && value[field] < 0) {
      issues.push(spawnIssue('error', 'spawn.invalidStatsNumber', `${formatSpawnRef(spawn, spawnIndex)} has negative stats.${field}.`, spawn, spawnIndex, `stats.${field}`));
    }
  }
  if (value.attackStyle !== undefined && !['stab', 'slash', 'crush'].includes(String(value.attackStyle))) {
    issues.push(spawnIssue('error', 'spawn.invalidAttackStyle', `${formatSpawnRef(spawn, spawnIndex)} has invalid stats.attackStyle "${String(value.attackStyle)}".`, spawn, spawnIndex, 'stats.attackStyle'));
  }
}

export function validateNpcSpawnsForAuthoring(options: ValidateNpcSpawnsForAuthoringOptions): NpcAuthoringIssue[] {
  const issues: NpcAuthoringIssue[] = [];
  const { mapId, width, height, spawns, resolveNpcDef } = options;
  const hasBounds = finiteNumber(width) && width > 0 && finiteNumber(height) && height > 0;
  const seenSpawnIds = new Map<number, number>();

  if (!Array.isArray(spawns)) {
    return [{
      severity: 'error',
      code: 'spawns.notArray',
      message: 'NPC spawns must be an array.',
    }];
  }

  for (let i = 0; i < spawns.length; i++) {
    const raw = spawns[i];
    if (!isRecord(raw)) {
      issues.push(spawnIssue('error', 'spawn.notObject', `NPC spawn row ${i + 1} is not an object.`, null, i));
      continue;
    }
    const spawn = raw;
    const ref = formatSpawnRef(spawn, i);

    if (spawn.id !== undefined) {
      if (!positiveInteger(spawn.id)) {
        issues.push(spawnIssue('error', 'spawn.invalidId', `${ref} has invalid id; ids must be positive integers.`, spawn, i, 'id'));
      } else {
        const previousIndex = seenSpawnIds.get(spawn.id);
        if (previousIndex !== undefined) {
          issues.push(spawnIssue('error', 'spawn.duplicateId', `${ref} reuses id ${spawn.id} from spawn row ${previousIndex + 1}.`, spawn, i, 'id'));
        } else {
          seenSpawnIds.set(spawn.id, i);
        }
      }
    }

    if (!positiveInteger(spawn.npcId)) {
      issues.push(spawnIssue('error', 'spawn.invalidNpcId', `${ref} has invalid npcId; choose a valid NPC type.`, spawn, i, 'npcId'));
    }
    const npcId = positiveInteger(spawn.npcId) ? spawn.npcId : null;
    const def = npcId ? resolveNpcDef(npcId) : undefined;
    if (npcId && !def) {
      issues.push(spawnIssue('error', 'spawn.unknownNpcId', `${ref} references NPC ${npcId}, which does not exist in npcs.json.`, spawn, i, 'npcId'));
    }

    const rawX = spawn.x;
    const rawZ = spawn.z;
    const xOk = finiteNumber(rawX);
    const zOk = finiteNumber(rawZ);
    if (!xOk) issues.push(spawnIssue('error', 'spawn.invalidX', `${ref} has invalid x; expected a finite number.`, spawn, i, 'x'));
    if (!zOk) issues.push(spawnIssue('error', 'spawn.invalidZ', `${ref} has invalid z; expected a finite number.`, spawn, i, 'z'));
    const effectiveWanderRange = nonNegativeFiniteNumber(spawn.wanderRange)
      ? spawn.wanderRange
      : nonNegativeFiniteNumber(def?.wanderRange)
        ? def.wanderRange
        : 0;
    const canWander = def?.stationary !== true && effectiveWanderRange > 0;
    if (xOk && zOk && hasBounds && (rawX < 0 || rawZ < 0 || rawX >= width || rawZ >= height)) {
      issues.push(spawnIssue('error', 'spawn.outOfBounds', `${ref} is outside ${mapId} bounds (${width}x${height}) at (${rawX}, ${rawZ}).`, spawn, i, 'position'));
    } else if (xOk && zOk && canWander && (!isTileCentered(rawX) || !isTileCentered(rawZ))) {
      issues.push(spawnIssue('warning', 'spawn.offCenter', `${ref} can wander but is not centered on a tile; click-placement uses .5 coordinates and avoids pathing surprises.`, spawn, i, 'position'));
    }

    for (const field of ['wanderRange', 'maxRange', 'huntRange', 'attackRange', 'retreatHealth']) {
      validateOptionalNonNegativeNumber(issues, spawn, i, field);
    }

    if (spawn.floor !== undefined && (!Number.isInteger(spawn.floor) || (spawn.floor as number) < 0)) {
      issues.push(spawnIssue('error', 'spawn.invalidFloor', `${ref} has invalid floor; use 0 for ground or a positive integer upper floor.`, spawn, i, 'floor'));
    }
    if (spawn.facing !== undefined && !finiteNumber(spawn.facing)) {
      issues.push(spawnIssue('error', 'spawn.invalidFacing', `${ref} has invalid facing; expected radians as a finite number.`, spawn, i, 'facing'));
    }
    const rawScale = spawn.scale;
    if (rawScale !== undefined) {
      if (!finiteNumber(rawScale) || rawScale <= 0) {
        issues.push(spawnIssue('error', 'spawn.invalidScale', `${ref} has invalid visual scale; expected a positive number.`, spawn, i, 'scale'));
      } else if (rawScale < NPC_VISUAL_SCALE_MIN || rawScale > NPC_VISUAL_SCALE_MAX) {
        issues.push(spawnIssue('warning', 'spawn.scaleClamped', `${ref} visual scale ${rawScale} will be clamped to ${NPC_VISUAL_SCALE_MIN}-${NPC_VISUAL_SCALE_MAX}.`, spawn, i, 'scale'));
      }
    }
    if (spawn.aggressive !== undefined && spawn.aggressive !== null && typeof spawn.aggressive !== 'boolean') {
      issues.push(spawnIssue('error', 'spawn.invalidAggressive', `${ref} has invalid aggressive override; expected true, false, or omitted.`, spawn, i, 'aggressive'));
    }

    validateEquipmentArray(issues, spawn, 'equipment', ref, (severity, code, message, field) => spawnIssue(severity, code, message, spawn, i, field));
    validateStatsObject(issues, spawn, i);

    if (def && npcId && xOk && zOk) {
      const violation = bankAccessSpawnViolation(mapId, {
        id: positiveInteger(spawn.id) ? spawn.id : undefined,
        npcId,
        x: rawX,
        z: rawZ,
        name: typeof spawn.name === 'string' ? spawn.name : undefined,
      }, def);
      if (violation) {
        issues.push(spawnIssue('error', 'spawn.bankAccessName', violation, spawn, i, 'name'));
      }
    }

    if (def?.size !== undefined && (!Number.isInteger(def.size) || def.size < 1)) {
      issues.push(spawnIssue('error', 'spawn.invalidNpcSize', `${ref} uses NPC ${def.id}, which has invalid size ${String(def.size)}.`, spawn, i, 'npcId'));
    }
  }

  return issues;
}

export function validateNpcDefsForAuthoring(input: unknown): NpcAuthoringIssue[] {
  const issues: NpcAuthoringIssue[] = [];
  if (!Array.isArray(input)) {
    return [{
      severity: 'error',
      code: 'npcDefs.notArray',
      message: 'NPC definitions must be an array.',
    }];
  }

  const ids = new Set<number>();

  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!isRecord(raw)) {
      issues.push(defIssue('error', 'npcDef.notObject', `NPC definition row ${i + 1} is not an object.`, null));
      continue;
    }
    const def = raw;
    const label = positiveInteger(def.id) ? `NPC ${def.id}` : `NPC definition row ${i + 1}`;

    if (!positiveInteger(def.id)) {
      issues.push(defIssue('error', 'npcDef.invalidId', `${label} has invalid id; ids must be positive integers.`, def, 'id'));
    } else if (ids.has(def.id)) {
      issues.push(defIssue('error', 'npcDef.duplicateId', `${label} duplicates another NPC definition id.`, def, 'id'));
    } else {
      ids.add(def.id);
    }

    const name = typeof def.name === 'string' ? def.name.trim() : '';
    if (!name) {
      issues.push(defIssue('error', 'npcDef.missingName', `${label} is missing a name.`, def, 'name'));
    }

    for (const field of ['health', 'attack', 'defence', 'strength', 'attackSpeed', 'respawnTime', 'wanderRange']) {
      if (!finiteNumber(def[field])) {
        issues.push(defIssue('error', 'npcDef.invalidNumber', `${label} has invalid ${field}; expected a finite number.`, def, field));
      }
    }
    if (finiteNumber(def.health) && def.health <= 0) {
      issues.push(defIssue('error', 'npcDef.invalidHealth', `${label} has health <= 0.`, def, 'health'));
    }
    for (const field of ['attackSpeed', 'respawnTime', 'wanderRange']) {
      if (finiteNumber(def[field]) && def[field] < 0) {
        issues.push(defIssue('error', 'npcDef.invalidNumber', `${label} has negative ${field}.`, def, field));
      }
    }
    if (def.aggressive !== undefined && typeof def.aggressive !== 'boolean') {
      issues.push(defIssue('error', 'npcDef.invalidAggressive', `${label} has invalid aggressive; expected a boolean.`, def, 'aggressive'));
    }
    if (def.lootTable !== undefined && !Array.isArray(def.lootTable)) {
      issues.push(defIssue('error', 'npcDef.invalidLootTable', `${label} has invalid lootTable; expected an array.`, def, 'lootTable'));
    }
    if (def.modelNpcId !== undefined && !positiveInteger(def.modelNpcId)) {
      issues.push(defIssue('error', 'npcDef.invalidModelNpcId', `${label} has invalid modelNpcId; expected a positive NPC id.`, def, 'modelNpcId'));
    }
    if (def.size !== undefined && (!Number.isInteger(def.size) || (def.size as number) < 1)) {
      issues.push(defIssue('error', 'npcDef.invalidSize', `${label} has invalid size; expected a positive integer footprint.`, def, 'size'));
    }
    if (def.attackStyle !== undefined && !['stab', 'slash', 'crush'].includes(String(def.attackStyle))) {
      issues.push(defIssue('error', 'npcDef.invalidAttackStyle', `${label} has invalid attackStyle "${String(def.attackStyle)}".`, def, 'attackStyle'));
    }
    validateEquipmentArray(issues, def, 'defaultEquipment', label, (severity, code, message, field) => defIssue(severity, code, message, def, field));
  }

  for (const raw of input) {
    if (!isRecord(raw) || raw.modelNpcId === undefined || !positiveInteger(raw.modelNpcId)) continue;
    if (!ids.has(raw.modelNpcId)) {
      issues.push(defIssue('error', 'npcDef.unknownModelNpcId', `NPC ${raw.id} references missing modelNpcId ${raw.modelNpcId}.`, raw, 'modelNpcId'));
    }
  }

  return issues;
}

export function formatNpcAuthoringIssues(issues: readonly NpcAuthoringIssue[], maxItems = 8): string {
  const errors = issues.filter(issue => issue.severity === 'error');
  const warnings = issues.filter(issue => issue.severity === 'warning');
  const parts = [
    errors.length > 0 ? `${errors.length} error${errors.length === 1 ? '' : 's'}` : '',
    warnings.length > 0 ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  const header = parts.length > 0 ? parts.join(', ') : 'No NPC authoring issues';
  const lines = issues.slice(0, maxItems).map(issue => `- ${issue.message}`);
  const remaining = issues.length - lines.length;
  if (remaining > 0) lines.push(`- ...and ${remaining} more`);
  return lines.length > 0 ? `${header}\n${lines.join('\n')}` : header;
}
