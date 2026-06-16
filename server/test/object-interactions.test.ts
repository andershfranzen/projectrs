import { describe, expect, test } from 'bun:test';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';
import { WorldObject } from '../src/entity/WorldObject';
import {
  BUCKET_ITEM_ID,
  BUCKET_OF_WATER_ITEM_ID,
  QUEST_STAGE_COMPLETED,
  type QuestCondition,
  type WorldObjectDef,
} from '@projectrs/shared';

const SKETCH_ITEM_ID = 236;
const BOBS_BURIAL_QUEST_ID = "Bob's Burial";

const wellDef: WorldObjectDef = {
  id: 27,
  name: 'Well',
  category: 'scenery',
  actions: ['Examine'],
  blocking: true,
  width: 1,
  height: 1,
  color: [80, 80, 90],
};

const chestDef: WorldObjectDef = {
  id: 20,
  name: 'Wooden Chest',
  category: 'chest',
  actions: ['Lockpick', 'Examine'],
  blocking: true,
  width: 1,
  height: 1,
  color: [120, 80, 40],
  depletedAssetId: 'open tier 1 chest',
  examineText: 'A simple wooden chest with a stubborn lock.',
};

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function playerHasItem(player: Player, itemId: number): boolean {
  return player.inventory.some(slot => slot?.itemId === itemId && slot.quantity > 0);
}

function conditionMet(player: Player, condition: QuestCondition): boolean {
  if (condition.type === 'all') return condition.conditions.every(child => conditionMet(player, child));
  if (condition.type === 'hasItem') return playerHasItem(player, condition.itemId);
  if (condition.type === 'questStage') {
    const state = player.quests[condition.questId];
    if (!state || state.stage === QUEST_STAGE_COMPLETED) return false;
    if (condition.minStage !== undefined && state.stage < condition.minStage) return false;
    if (condition.maxStage !== undefined && state.stage > condition.maxStage) return false;
    return true;
  }
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

  test('well sketch action is visible only at Bob quest disposal step with sketch', () => {
    const player = new Player('quester', 10.5, 10.5, fakeWs, 1);
    const obj = new WorldObject(wellDef, 10.5, 11.5, 'kcmap');
    obj.setInteractions([
      {
        action: 'Throw sketch',
        condition: {
          type: 'all',
          conditions: [
            { type: 'questStage', questId: BOBS_BURIAL_QUEST_ID, minStage: 2, maxStage: 2 },
            { type: 'hasItem', itemId: SKETCH_ITEM_ID, quantity: 1 },
          ],
        },
      },
    ]);

    const world = Object.create(World.prototype) as any;
    world.quests = { questConditionMet: conditionMet };

    expect(world.currentObjectActionsForPlayer(player, obj)).toEqual(['Examine']);

    player.quests[BOBS_BURIAL_QUEST_ID] = { stage: 1, triggerProgress: 0 };
    player.inventory[0] = { itemId: SKETCH_ITEM_ID, quantity: 1 };
    expect(world.currentObjectActionsForPlayer(player, obj)).toEqual(['Examine']);

    player.quests[BOBS_BURIAL_QUEST_ID] = { stage: 2, triggerProgress: 0 };
    expect(world.currentObjectActionsForPlayer(player, obj)).toEqual(['Throw sketch', 'Examine']);

    player.inventory[0] = null;
    expect(world.currentObjectActionsForPlayer(player, obj)).toEqual(['Examine']);
  });

  test('depleted chests keep Examine but hide Lockpick until restocked', () => {
    const player = new Player('chest_checker', 10.5, 10.5, fakeWs, 1);
    const obj = new WorldObject(chestDef, 10.5, 11.5, 'kcmap');
    obj.depleted = true;

    const world = Object.create(World.prototype) as any;

    expect(world.currentObjectActionsForPlayer(player, obj)).toEqual(['Examine']);
  });

  test('depleted chest examine text uses the open chest visual', () => {
    const player = new Player('chest_reader', 10.5, 10.5, fakeWs, 1);
    const obj = new WorldObject(chestDef, 10.5, 11.5, 'kcmap');
    obj.depleted = true;

    const world = Object.create(World.prototype) as any;

    expect(world.objectExamineTextFor(player, obj)).toBe('An open wooden chest. Someone has already helped themselves.');
  });

  test('using a bucket on a well fills it without a well Fill action', () => {
    const player = new Player('water_carrier', 10.5, 10.5, fakeWs, 1);
    player.inventory[0] = { itemId: BUCKET_ITEM_ID, quantity: 1 };
    const obj = new WorldObject(wellDef, 10.5, 11.5, 'kcmap');
    const messages: string[] = [];
    let inventorySends = 0;

    const world = Object.create(World.prototype) as any;
    world.worldObjects = new Map([[obj.id, obj]]);
    world.validateInvUse = () => player;
    world.canPlayerTargetObject = () => true;
    world.isAdjacentToObject = () => true;
    world.interruptPlayerAction = () => {};
    world.sendInventory = () => { inventorySends++; };
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);

    expect(wellDef.actions).toEqual(['Examine']);

    world.handlePlayerUseItemOnObject(player.id, 0, BUCKET_ITEM_ID, obj.id);

    expect(player.inventory[0]).toEqual({ itemId: BUCKET_OF_WATER_ITEM_ID, quantity: 1 });
    expect(messages).toEqual(['You fill the bucket with water.']);
    expect(inventorySends).toBe(1);
  });

  test('using a bucket on a distant well queues movement then fills on arrival', () => {
    const player = new Player('walking_water_carrier', 10.5, 9.5, fakeWs, 1);
    player.inventory[0] = { itemId: BUCKET_ITEM_ID, quantity: 1 };
    const obj = new WorldObject(wellDef, 10.5, 11.5, 'kcmap');
    const messages: string[] = [];
    let inventorySends = 0;
    let adjacent = false;

    const world = Object.create(World.prototype) as any;
    world.worldObjects = new Map([[obj.id, obj]]);
    world.validateInvUse = () => player;
    world.canPlayerTargetObject = () => true;
    world.isAdjacentToObject = () => adjacent;
    world.findPathToObjectInteraction = () => [{ x: 10.5, z: 10.5 }];
    world.interruptPlayerAction = () => {};
    world.sendInventory = () => { inventorySends++; };
    world.sendChatSystem = (_player: Player, message: string) => messages.push(message);

    world.handlePlayerUseItemOnObject(player.id, 0, BUCKET_ITEM_ID, obj.id);

    expect(player.inventory[0]).toEqual({ itemId: BUCKET_ITEM_ID, quantity: 1 });
    expect(player.pendingUseItemOnObject).toEqual({ invSlot: 0, itemId: BUCKET_ITEM_ID, objectEntityId: obj.id });
    expect(player.hasMoveQueue()).toBe(true);
    expect(messages).toEqual([]);

    player.movementCredit = 1;
    expect(player.processMovement(1)).toBe(true);
    adjacent = true;
    const pending = player.pendingUseItemOnObject!;
    player.pendingUseItemOnObject = null;
    player.pendingActionRevision = -1;

    world.handlePlayerUseItemOnObject(player.id, pending.invSlot, pending.itemId, pending.objectEntityId);

    expect(player.inventory[0]).toEqual({ itemId: BUCKET_OF_WATER_ITEM_ID, quantity: 1 });
    expect(messages).toEqual(['You fill the bucket with water.']);
    expect(inventorySends).toBe(1);
  });
});
