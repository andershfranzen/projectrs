import type { NpcDef, SpawnEntry } from './types.js';

type BankAccessSpawnRef = Pick<SpawnEntry, 'npcId' | 'x' | 'z' | 'name'> & { id?: number };
type BankAccessNpcDefRef = Pick<NpcDef, 'id' | 'name' | 'bankAccess'>;

const COORD_EPSILON = 0.001;

export const BANKER_NPC_ID = 16;
export const BANK_ACCESS_SPAWN_NAME = 'Banker';

/** Bank-enabled NPCs are gameplay-critical. Keep them allowlisted so a stray
 *  banker type cannot be dropped into the world and open the bank anywhere. */
export const BANK_ACCESS_SPAWN_ALLOWLIST: readonly {
  readonly mapId: string;
  readonly npcId: number;
  readonly name: string;
  readonly x: number;
  readonly z: number;
}[] = [
  { mapId: 'kcmap', npcId: BANKER_NPC_ID, name: BANK_ACCESS_SPAWN_NAME, x: 71.5, z: 25.5 },
  { mapId: 'kcmap', npcId: BANKER_NPC_ID, name: BANK_ACCESS_SPAWN_NAME, x: 72.5, z: 25.5 },
];

export function isAllowedBankAccessSpawn(mapId: string, spawn: BankAccessSpawnRef): boolean {
  return BANK_ACCESS_SPAWN_ALLOWLIST.some(allowed =>
    allowed.mapId === mapId
    && allowed.npcId === spawn.npcId
    && allowed.name === spawn.name
    && Math.abs(allowed.x - spawn.x) <= COORD_EPSILON
    && Math.abs(allowed.z - spawn.z) <= COORD_EPSILON
  );
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
  return `${mapId} ${spawnLabel} at (${spawn.x}, ${spawn.z}) is ${nameLabel} but uses bank-access NPC ${npcDef.name} (${spawn.npcId}). Bank-enabled spawns must be explicit entries in BANK_ACCESS_SPAWN_ALLOWLIST.`;
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
