import type { Player } from '../entity/Player';
import type { Npc } from '../entity/Npc';

export interface NpcDeathHooks {
  getTargeters(npcId: number): Iterable<number> | undefined;
  clearCombatTarget(playerId: number): void;
  broadcastDeath(npc: Npc): void;
  removeChunkEntity(npc: Npc): void;
  markOccupantsDirty(): void;
  forgetVisibleNpc(npcId: number): void;
  notifyQuestKill(killer: Player, npc: Npc): void;
  creditMobKill(npc: Npc): void;
  spawnLoot(npc: Npc, ownerPlayerId: number | null): void;
}

export function finalizeNpcDeath(hooks: NpcDeathHooks, npc: Npc, killer: Player | null): void {
  npc.die();

  const targeters = hooks.getTargeters(npc.id);
  if (targeters) {
    for (const playerId of [...targeters]) hooks.clearCombatTarget(playerId);
  }

  if (killer) hooks.notifyQuestKill(killer, npc);
  hooks.broadcastDeath(npc);
  hooks.removeChunkEntity(npc);
  hooks.markOccupantsDirty();
  hooks.forgetVisibleNpc(npc.id);
  hooks.creditMobKill(npc);
  hooks.spawnLoot(npc, npc.getTopDamager());
}
