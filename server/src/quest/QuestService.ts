import {
  ALL_SKILLS,
  MAX_STACK,
  QUEST_STAGE_COMPLETED,
  ServerOpcode,
  type DialogueOption,
  type QuestTrigger,
  type SkillId,
} from '@projectrs/shared';
import { addXp } from '@projectrs/shared';
import { encodeStringPacket } from '@projectrs/shared';
import type { DataLoader } from '../data/DataLoader';
import type { Player } from '../entity/Player';

export type QuestEventDescriptor =
  | { type: 'itemPickup'; itemId: number; quantity: number }
  | { type: 'npcKill'; npcDefId: number }
  | { type: 'chestOpen'; chestDefId: number };

interface QuestServiceSenders {
  sendToPlayer(player: Player, opcode: ServerOpcode, ...values: number[]): void;
  sendChatSystem(player: Player, message: string): void;
  sendInventory(player: Player): void;
  sendSingleSkill(player: Player, skillIndex: number): void;
}

export class QuestService {
  constructor(
    private readonly data: DataLoader,
    private readonly senders: QuestServiceSenders,
  ) {}

  dialogueOptionVisible(player: Player, opt: DialogueOption): boolean {
    const req = opt.requires;
    if (!req) return true;
    const state = player.quests[req.questId];
    if (req.notStarted) return !state || state.stage === QUEST_STAGE_COMPLETED;
    if (!state) return false;
    if (state.stage === QUEST_STAGE_COMPLETED) return false;
    if (req.minStage !== undefined && state.stage < req.minStage) return false;
    if (req.maxStage !== undefined && state.stage > req.maxStage) return false;
    return true;
  }

  setPlayerQuestStage(player: Player, questId: string, stage: number): void {
    const def = this.data.getQuest(questId);
    if (!def) return;
    if (!Number.isInteger(stage)) return;
    if (stage === QUEST_STAGE_COMPLETED) return;
    if (stage < 0 || stage >= def.stages.length) {
      console.warn(`[quest] Ignoring invalid stage ${stage} for quest "${questId}" on player "${player.name}"`);
      return;
    }
    const current = player.quests[questId];
    if (current && current.stage === stage) return;
    player.quests[questId] = { stage, triggerProgress: 0 };
    this.sendQuestDelta(player, questId);
  }

  completePlayerQuest(player: Player, questId: string): void {
    const def = this.data.getQuest(questId);
    if (!def) return;
    const current = player.quests[questId];
    if (current && current.stage === QUEST_STAGE_COMPLETED && !def.repeatable) return;

    const itemRewards = def.rewards?.items?.filter(drop =>
      Number.isInteger(drop.itemId) && Number.isInteger(drop.quantity) && drop.quantity > 0
    ) ?? [];
    if (itemRewards.length > 0 && !this.canFitItemRewards(player, itemRewards)) {
      this.senders.sendChatSystem(player, 'You need more inventory space before completing this quest.');
      return;
    }

    if (def.rewards) {
      if (def.rewards.xp) {
        for (const [skillKey, amount] of Object.entries(def.rewards.xp)) {
          if (typeof amount !== 'number' || amount <= 0) continue;
          const skillIdx = ALL_SKILLS.indexOf(skillKey as SkillId);
          if (skillIdx < 0) continue;
          const result = addXp(player.skills, skillKey as SkillId, amount);
          this.senders.sendToPlayer(player, ServerOpcode.XP_GAIN, skillIdx, amount);
          if (result.leveled) {
            this.senders.sendToPlayer(player, ServerOpcode.LEVEL_UP, skillIdx, result.newLevel);
          }
          this.senders.sendSingleSkill(player, skillIdx);
        }
      }
      if (itemRewards.length > 0) {
        let mutated = false;
        for (const drop of itemRewards) {
          const got = player.addItem(drop.itemId, drop.quantity, this.data.itemDefs);
          if (got.completed !== drop.quantity) {
            if (got.completed > 0) player.revertAdd(got);
            this.senders.sendChatSystem(player, 'You need more inventory space before completing this quest.');
            return;
          }
          mutated = true;
        }
        if (mutated) this.senders.sendInventory(player);
      }
    }

    player.quests[questId] = { stage: def.repeatable ? 0 : QUEST_STAGE_COMPLETED, triggerProgress: 0 };
    this.sendQuestDelta(player, questId);
    this.senders.sendChatSystem(player, `Quest complete: ${def.name}.`);
  }

  sendQuestDelta(player: Player, questId: string): void {
    const state = player.quests[questId] ?? { stage: QUEST_STAGE_COMPLETED, triggerProgress: 0 };
    const packet = encodeStringPacket(ServerOpcode.QUEST_STAGE_ADVANCED, questId, state.stage, state.triggerProgress);
    try { player.ws.sendBinary(packet); } catch { /* connection closed */ }
  }

  sendQuestStateSync(player: Player): void {
    const payload = JSON.stringify(player.quests);
    const packet = encodeStringPacket(ServerOpcode.QUEST_STATE_SYNC, payload);
    try { player.ws.sendBinary(packet); } catch { /* connection closed */ }
  }

  notifyQuestEvent(player: Player, event: QuestEventDescriptor): void {
    // Snapshot active quests before start triggers so one event cannot both
    // start a quest and advance its first stage.
    const activeBeforeStarts = Object.entries(player.quests).filter(([, state]) =>
      state.stage !== QUEST_STAGE_COMPLETED
    );

    for (const def of this.data.getQuestsByStartTriggerType(event.type)) {
      if (!def.startTrigger) continue;
      const existing = player.quests[def.id];
      if (existing) {
        if (existing.stage === QUEST_STAGE_COMPLETED && !def.repeatable) continue;
        if (existing.stage !== QUEST_STAGE_COMPLETED) continue;
      }
      if (!this.triggerMatchesEvent(def.startTrigger, event)) continue;
      if (!this.rollTriggerChance(def.startTrigger)) continue;
      this.setPlayerQuestStage(player, def.id, 0);
      this.senders.sendChatSystem(player, `New quest started: ${def.name}.`);
    }

    for (const [questId, state] of activeBeforeStarts) {
      const def = this.data.getQuest(questId);
      if (!def) continue;
      const stageDef = def.stages[state.stage];
      if (!stageDef?.trigger) continue;
      if (!this.triggerMatchesEvent(stageDef.trigger, event)) continue;
      if (!this.rollTriggerChance(stageDef.trigger)) continue;
      const count = state.triggerProgress + 1;
      const threshold = this.triggerThreshold(stageDef.trigger);
      if (count >= threshold) {
        const nextStage = state.stage + 1;
        if (nextStage >= def.stages.length) {
          this.completePlayerQuest(player, questId);
        } else {
          this.setPlayerQuestStage(player, questId, nextStage);
        }
      } else {
        player.quests[questId] = { stage: state.stage, triggerProgress: count };
        this.sendQuestDelta(player, questId);
      }
    }
  }

  private canFitItemRewards(player: Player, rewards: Array<{ itemId: number; quantity: number }>): boolean {
    const stackTotals = new Map<number, number>();
    let freeSlots = 0;
    for (const slot of player.inventory) {
      if (!slot) {
        freeSlots++;
        continue;
      }
      const def = this.data.getItem(slot.itemId);
      if (def?.stackable) stackTotals.set(slot.itemId, slot.quantity);
    }

    for (const reward of rewards) {
      const def = this.data.getItem(reward.itemId);
      if (!def) return false;
      if (def.stackable) {
        const existing = stackTotals.get(reward.itemId);
        if (existing !== undefined) {
          const projected = existing + reward.quantity;
          if (projected > MAX_STACK) return false;
          stackTotals.set(reward.itemId, projected);
          continue;
        }
        if (reward.quantity > MAX_STACK || freeSlots < 1) return false;
        freeSlots--;
        stackTotals.set(reward.itemId, reward.quantity);
        continue;
      }
      if (freeSlots < reward.quantity) return false;
      freeSlots -= reward.quantity;
    }

    return true;
  }

  private triggerMatchesEvent(trigger: QuestTrigger, event: QuestEventDescriptor): boolean {
    if (trigger.type === 'dialogue') return false;
    if (trigger.type !== event.type) return false;
    if (trigger.type === 'itemPickup' && event.type === 'itemPickup') {
      return trigger.itemId === event.itemId;
    }
    if (trigger.type === 'npcKill' && event.type === 'npcKill') {
      return trigger.npcDefId === event.npcDefId;
    }
    if (trigger.type === 'chestOpen' && event.type === 'chestOpen') {
      return trigger.chestDefId === undefined || trigger.chestDefId === event.chestDefId;
    }
    return false;
  }

  private triggerThreshold(trigger: QuestTrigger): number {
    if (trigger.type === 'itemPickup') return trigger.quantity ?? 1;
    if (trigger.type === 'npcKill') return trigger.count ?? 1;
    if (trigger.type === 'chestOpen') return trigger.count ?? 1;
    return 1;
  }

  private rollTriggerChance(trigger: QuestTrigger): boolean {
    if (trigger.type === 'dialogue') return true;
    return trigger.chance === undefined || Math.random() < trigger.chance;
  }
}
