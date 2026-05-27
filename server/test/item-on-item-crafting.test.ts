import { describe, expect, test } from 'bun:test';
import {
  BUCKET_ITEM_ID,
  KNIFE_ITEM_ID,
  LOGS_ITEM_ID,
  SHORTBOW_UNSTRUNG_ITEM_ID,
  type ItemDef,
} from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function itemDef(id: number, name: string): ItemDef {
  return {
    id,
    name,
    description: name,
    stackable: false,
    equippable: false,
    value: 1,
  };
}

function makeHarness(logQuantity: number): {
  world: any;
  player: Player;
  xp: Array<{ skill: string; amount: number }>;
  messages: string[];
} {
  const player = new Player('item_on_item_test', 10.5, 10.5, fakeWs, 1);
  player.inventory[0] = { itemId: KNIFE_ITEM_ID, quantity: 1 };
  player.inventory[1] = { itemId: LOGS_ITEM_ID, quantity: logQuantity };

  const xp: Array<{ skill: string; amount: number }> = [];
  const messages: string[] = [];
  const world = Object.create(World.prototype) as any;
  world.currentTick = 0;
  world.players = new Map([[player.id, player]]);
  world.data = {
    itemDefs: new Map([
      [BUCKET_ITEM_ID, itemDef(BUCKET_ITEM_ID, 'Bucket')],
      [KNIFE_ITEM_ID, itemDef(KNIFE_ITEM_ID, 'Knife')],
      [LOGS_ITEM_ID, itemDef(LOGS_ITEM_ID, 'Logs')],
      [SHORTBOW_UNSTRUNG_ITEM_ID, itemDef(SHORTBOW_UNSTRUNG_ITEM_ID, 'Unstrung Shortbow')],
    ]),
  };
  world.itemProductionActions = new Map();
  world.interruptPlayerAction = () => {};
  world.sendInventory = () => {};
  world.sendChatSystem = (_player: Player, message: string) => messages.push(message);
  world.grantXp = (_player: Player, skill: any, amount: number) => xp.push({ skill, amount });
  return { world, player, xp, messages };
}

describe('item-on-item crafting recipes', () => {
  test('knife plus logs defaults to the existing bucket recipe', () => {
    const { world, player, xp, messages } = makeHarness(3);

    world.handlePlayerUseItemOnItem(player.id, 0, KNIFE_ITEM_ID, 1, LOGS_ITEM_ID, 1);

    expect(player.inventory[1]).toEqual({ itemId: LOGS_ITEM_ID, quantity: 1 });
    expect(player.inventory[2]).toEqual({ itemId: BUCKET_ITEM_ID, quantity: 1 });
    expect(xp).toEqual([{ skill: 'crafting', amount: 4 }]);
    expect(messages).toEqual(['You carve the logs into a bucket.']);
  });

  test('knife plus logs can select the unstrung shortbow recipe', () => {
    const { world, player, xp, messages } = makeHarness(1);

    world.handlePlayerUseItemOnItem(player.id, 0, KNIFE_ITEM_ID, 1, LOGS_ITEM_ID, 1, 1);

    expect(player.inventory[1]).toEqual({ itemId: SHORTBOW_UNSTRUNG_ITEM_ID, quantity: 1 });
    expect(xp).toEqual([{ skill: 'crafting', amount: 5 }]);
    expect(messages).toEqual(['You carve the logs into an unstrung shortbow.']);
  });

  test('batch carving keeps the selected recipe', () => {
    const { world, player, messages } = makeHarness(10);

    world.handlePlayerUseItemOnItem(player.id, 0, KNIFE_ITEM_ID, 1, LOGS_ITEM_ID, -1, 1);

    const action = world.itemProductionActions.get(player.id);
    expect(action).toMatchObject({
      kind: 'itemOnItem',
      remaining: null,
      nextTick: 1,
    });
    expect(action?.kind === 'itemOnItem' ? action.recipe.outputs : []).toEqual([
      { itemId: SHORTBOW_UNSTRUNG_ITEM_ID, quantity: 1 },
    ]);
    expect(messages).toEqual(['You start carving unstrung shortbows.']);
  });
});
