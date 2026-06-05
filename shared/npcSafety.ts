import type { NpcDef, SpawnEntry } from './types';

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
