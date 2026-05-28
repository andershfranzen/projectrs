import { describe, expect, test } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import type { QuestCondition } from '@projectrs/shared';

const SKETCH_ITEM_ID = 236;

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function playerHasItem(player: Player, itemId: number): boolean {
  return player.inventory.some(slot => slot?.itemId === itemId && slot.quantity > 0);
}

function conditionMet(player: Player, condition: QuestCondition): boolean {
  if (condition.type === 'hasItem') return playerHasItem(player, condition.itemId);
  if (condition.type === 'not') return !conditionMet(player, condition.condition);
  return false;
}

describe('placed object interactions', () => {
  test('same-label interaction variants run only the first matching branch', () => {
    const player = new Player('quester', 10.5, 10.5, fakeWs, 1);
    player.inventory[0] = { itemId: SKETCH_ITEM_ID, quantity: 1 };

    const obj = {
      interactions: [
        {
          action: 'Throw sketch',
          condition: { type: 'hasItem', itemId: SKETCH_ITEM_ID, quantity: 1 },
          message: 'You throw the suspect sketch into the well.',
          effects: [{ type: 'takeItem', itemId: SKETCH_ITEM_ID, qty: 1 }],
        },
        {
          action: 'Throw sketch',
          condition: { type: 'not', condition: { type: 'hasItem', itemId: SKETCH_ITEM_ID, quantity: 1 } },
          message: 'You have nothing suspicious to throw into the well.',
        },
      ],
    };
    const messages: string[] = [];
    const world = Object.create(World.prototype) as any;
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);
    world.quests = {
      questConditionMet: conditionMet,
      runQuestActions(_player: Player, actions: Array<{ type: string; itemId?: number; qty?: number }>) {
        for (const action of actions) {
          if (action.type === 'takeItem' && action.itemId === SKETCH_ITEM_ID) player.inventory[0] = null;
        }
        return true;
      },
    };

    world.runObjectInteractionEffects(player, obj, 'Throw sketch');

    expect(messages).toEqual(['You throw the suspect sketch into the well.']);
    expect(playerHasItem(player, SKETCH_ITEM_ID)).toBe(false);
  });
});
