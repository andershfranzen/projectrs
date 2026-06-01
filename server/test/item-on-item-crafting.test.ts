import { describe, expect, test } from 'bun:test';
import {
  BUCKET_ITEM_ID,
  BOWSTRING_ITEM_ID,
  BRONZE_ARROWHEADS_ITEM_ID,
  BRONZE_ARROWS_ITEM_ID,
  KNIFE_ITEM_ID,
  LOGS_ITEM_ID,
  IRON_ARROWHEADS_ITEM_ID,
  IRON_ARROWS_ITEM_ID,
  STEEL_ARROWHEADS_ITEM_ID,
  STEEL_ARROWS_ITEM_ID,
  MITHRIL_ARROWHEADS_ITEM_ID,
  MITHRIL_ARROWS_ITEM_ID,
  BLACK_BRONZE_ARROWHEADS_ITEM_ID,
  BLACK_BRONZE_ARROWS_ITEM_ID,
  HEADLESS_ARROWS_ITEM_ID,
  OAK_LOGS_ITEM_ID,
  OAK_SHORTBOW_ITEM_ID,
  OAK_SHORTBOW_UNSTRUNG_ITEM_ID,
  ARROW_SHAFTS_ITEM_ID,
  SHORTBOW_ITEM_ID,
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

function makeHarness(logQuantity: number, logItemId: number = LOGS_ITEM_ID): {
  world: any;
  player: Player;
  xp: Array<{ skill: string; amount: number }>;
  messages: string[];
} {
  const player = new Player('item_on_item_test', 10.5, 10.5, fakeWs, 1);
  player.skills.crafting.level = 99;
  player.skills.crafting.currentLevel = 99;
  player.inventory[0] = { itemId: KNIFE_ITEM_ID, quantity: 1 };
  player.inventory[1] = { itemId: logItemId, quantity: logQuantity };

  const xp: Array<{ skill: string; amount: number }> = [];
  const messages: string[] = [];
  const world = Object.create(World.prototype) as any;
  world.currentTick = 0;
  world.players = new Map([[player.id, player]]);
  world.data = {
    itemDefs: new Map([
      [BOWSTRING_ITEM_ID, itemDef(BOWSTRING_ITEM_ID, 'Bowstring')],
      [BRONZE_ARROWHEADS_ITEM_ID, itemDef(BRONZE_ARROWHEADS_ITEM_ID, 'Bronze Arrowheads')],
      [BRONZE_ARROWS_ITEM_ID, itemDef(BRONZE_ARROWS_ITEM_ID, 'Bronze Arrows')],
      [BUCKET_ITEM_ID, itemDef(BUCKET_ITEM_ID, 'Bucket')],
      [IRON_ARROWHEADS_ITEM_ID, itemDef(IRON_ARROWHEADS_ITEM_ID, 'Iron Arrowheads')],
      [IRON_ARROWS_ITEM_ID, itemDef(IRON_ARROWS_ITEM_ID, 'Iron Arrows')],
      [STEEL_ARROWHEADS_ITEM_ID, itemDef(STEEL_ARROWHEADS_ITEM_ID, 'Steel Arrowheads')],
      [STEEL_ARROWS_ITEM_ID, itemDef(STEEL_ARROWS_ITEM_ID, 'Steel Arrows')],
      [MITHRIL_ARROWHEADS_ITEM_ID, itemDef(MITHRIL_ARROWHEADS_ITEM_ID, 'Mithril Arrowheads')],
      [MITHRIL_ARROWS_ITEM_ID, itemDef(MITHRIL_ARROWS_ITEM_ID, 'Mithril Arrows')],
      [BLACK_BRONZE_ARROWHEADS_ITEM_ID, itemDef(BLACK_BRONZE_ARROWHEADS_ITEM_ID, 'Black Bronze Arrowheads')],
      [BLACK_BRONZE_ARROWS_ITEM_ID, itemDef(BLACK_BRONZE_ARROWS_ITEM_ID, 'Black Bronze Arrows')],
      [KNIFE_ITEM_ID, itemDef(KNIFE_ITEM_ID, 'Knife')],
      [LOGS_ITEM_ID, itemDef(LOGS_ITEM_ID, 'Log')],
      [OAK_LOGS_ITEM_ID, itemDef(OAK_LOGS_ITEM_ID, 'Oak Log')],
      [HEADLESS_ARROWS_ITEM_ID, itemDef(HEADLESS_ARROWS_ITEM_ID, 'Headless Arrows')],
      [ARROW_SHAFTS_ITEM_ID, itemDef(ARROW_SHAFTS_ITEM_ID, 'Arrow Shafts')],
      [OAK_SHORTBOW_ITEM_ID, itemDef(OAK_SHORTBOW_ITEM_ID, 'Oak Shortbow')],
      [OAK_SHORTBOW_UNSTRUNG_ITEM_ID, itemDef(OAK_SHORTBOW_UNSTRUNG_ITEM_ID, 'Unstrung Oak Shortbow')],
      [SHORTBOW_ITEM_ID, itemDef(SHORTBOW_ITEM_ID, 'Shortbow')],
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

    const action = world.itemProductionActions.get(player.id);
    expect(action).toMatchObject({
      kind: 'itemOnItem',
      remaining: 1,
      nextTick: 6,
    });
    expect(action?.kind === 'itemOnItem' ? action.recipe.outputs : []).toEqual([
      { itemId: BUCKET_ITEM_ID, quantity: 1 },
    ]);
    expect(player.inventory[1]).toEqual({ itemId: LOGS_ITEM_ID, quantity: 3 });
    expect(xp).toEqual([]);
    expect(messages).toEqual(['You start carving buckets.']);
  });

  test('knife plus logs can select the unstrung shortbow recipe', () => {
    const { world, player, xp, messages } = makeHarness(1);

    world.handlePlayerUseItemOnItem(player.id, 0, KNIFE_ITEM_ID, 1, LOGS_ITEM_ID, 1, 1);

    const action = world.itemProductionActions.get(player.id);
    expect(action).toMatchObject({
      kind: 'itemOnItem',
      remaining: 1,
      nextTick: 3,
    });
    expect(action?.kind === 'itemOnItem' ? action.recipe.outputs : []).toEqual([
      { itemId: SHORTBOW_UNSTRUNG_ITEM_ID, quantity: 1 },
    ]);
    expect(action?.kind === 'itemOnItem' ? action.recipe.xpReward : undefined).toBe(6);
    expect(player.inventory[1]).toEqual({ itemId: LOGS_ITEM_ID, quantity: 1 });
    expect(xp).toEqual([]);
    expect(messages).toEqual(['You start carving unstrung shortbows.']);
  });

  test('batch carving keeps the selected recipe', () => {
    const { world, player, messages } = makeHarness(10);

    world.handlePlayerUseItemOnItem(player.id, 0, KNIFE_ITEM_ID, 1, LOGS_ITEM_ID, -1, 1);

    const action = world.itemProductionActions.get(player.id);
    expect(action).toMatchObject({
      kind: 'itemOnItem',
      remaining: null,
      nextTick: 3,
    });
    expect(action?.kind === 'itemOnItem' ? action.recipe.outputs : []).toEqual([
      { itemId: SHORTBOW_UNSTRUNG_ITEM_ID, quantity: 1 },
    ]);
    expect(messages).toEqual(['You start carving unstrung shortbows.']);
  });

  test('tiered logs can select unstrung shortbow or arrow shaft recipes', () => {
    const { world, player, messages } = makeHarness(5, OAK_LOGS_ITEM_ID);

    world.handlePlayerUseItemOnItem(player.id, 0, KNIFE_ITEM_ID, 1, OAK_LOGS_ITEM_ID, -1, 0);
    const action = world.itemProductionActions.get(player.id);
    expect(action).toMatchObject({
      kind: 'itemOnItem',
      remaining: null,
      nextTick: 3,
    });
    expect(action?.kind === 'itemOnItem' ? action.recipe.outputs : []).toEqual([
      { itemId: OAK_SHORTBOW_UNSTRUNG_ITEM_ID, quantity: 1 },
    ]);
    expect(messages).toEqual(['You start carving unstrung oak shortbows.']);
  });

  test('tiered log arrow shafts use the second recipe index', () => {
    const { world, player, messages } = makeHarness(5, OAK_LOGS_ITEM_ID);

    world.handlePlayerUseItemOnItem(player.id, 0, KNIFE_ITEM_ID, 1, OAK_LOGS_ITEM_ID, -1, 1);
    const action = world.itemProductionActions.get(player.id);
    expect(action?.kind === 'itemOnItem' ? action.recipe.outputs : []).toEqual([
      { itemId: ARROW_SHAFTS_ITEM_ID, quantity: 15 },
    ]);
    expect(messages).toEqual(['You start carving arrow shafts.']);
  });

  test('bowstring plus unstrung shortbow creates a strung shortbow', () => {
    const { world, player, xp, messages } = makeHarness(0);
    player.inventory[0] = { itemId: BOWSTRING_ITEM_ID, quantity: 1 };
    player.inventory[1] = { itemId: SHORTBOW_UNSTRUNG_ITEM_ID, quantity: 1 };

    world.handlePlayerUseItemOnItem(player.id, 0, BOWSTRING_ITEM_ID, 1, SHORTBOW_UNSTRUNG_ITEM_ID, 1);

    expect(player.inventory[0]).toEqual({ itemId: SHORTBOW_ITEM_ID, quantity: 1 });
    expect(player.inventory[1]).toBeNull();
    expect(xp).toEqual([{ skill: 'crafting', amount: 7 }]);
    expect(messages).toEqual(['You string the shortbow.']);
  });

  test('bowstring plus tiered unstrung shortbow creates the matching strung bow', () => {
    const { world, player, xp, messages } = makeHarness(0);
    player.inventory[0] = { itemId: BOWSTRING_ITEM_ID, quantity: 1 };
    player.inventory[1] = { itemId: OAK_SHORTBOW_UNSTRUNG_ITEM_ID, quantity: 1 };

    world.handlePlayerUseItemOnItem(player.id, 0, BOWSTRING_ITEM_ID, 1, OAK_SHORTBOW_UNSTRUNG_ITEM_ID, 1);

    expect(player.inventory[0]).toEqual({ itemId: OAK_SHORTBOW_ITEM_ID, quantity: 1 });
    expect(player.inventory[1]).toBeNull();
    expect(xp).toEqual([{ skill: 'crafting', amount: 9 }]);
    expect(messages).toEqual(['You string the oak shortbow.']);
  });

  test('headless arrows plus bronze arrowheads creates bronze arrows', () => {
    const { world, player, xp, messages } = makeHarness(0);
    player.inventory[0] = { itemId: HEADLESS_ARROWS_ITEM_ID, quantity: 1 };
    player.inventory[1] = { itemId: BRONZE_ARROWHEADS_ITEM_ID, quantity: 1 };

    world.handlePlayerUseItemOnItem(player.id, 0, HEADLESS_ARROWS_ITEM_ID, 1, BRONZE_ARROWHEADS_ITEM_ID, 1);

    expect(player.inventory[0]).toEqual({ itemId: BRONZE_ARROWS_ITEM_ID, quantity: 1 });
    expect(player.inventory[1]).toBeNull();
    expect(xp).toEqual([{ skill: 'crafting', amount: 1 }]);
    expect(messages).toEqual(['You make a bronze arrow.']);
  });

  test('headless arrows plus iron arrowheads can be batched', () => {
    const { world, player, messages } = makeHarness(0);
    player.skills.crafting.level = 15;
    player.skills.crafting.currentLevel = 15;
    player.inventory[0] = { itemId: HEADLESS_ARROWS_ITEM_ID, quantity: 5 };
    player.inventory[1] = { itemId: IRON_ARROWHEADS_ITEM_ID, quantity: 5 };

    world.handlePlayerUseItemOnItem(player.id, 0, HEADLESS_ARROWS_ITEM_ID, 1, IRON_ARROWHEADS_ITEM_ID, -1);

    const action = world.itemProductionActions.get(player.id);
    expect(action).toMatchObject({
      kind: 'itemOnItem',
      remaining: null,
      nextTick: 1,
    });
    expect(action?.kind === 'itemOnItem' ? action.recipe.outputs : []).toEqual([
      { itemId: IRON_ARROWS_ITEM_ID, quantity: 1 },
    ]);
    expect(messages).toEqual(['You start making iron arrows.']);
  });

  test('headless arrows plus higher-tier arrowheads creates matching arrows', () => {
    const cases = [
      {
        arrowheadId: STEEL_ARROWHEADS_ITEM_ID,
        arrowId: STEEL_ARROWS_ITEM_ID,
        label: 'steel',
        xp: 4,
      },
      {
        arrowheadId: MITHRIL_ARROWHEADS_ITEM_ID,
        arrowId: MITHRIL_ARROWS_ITEM_ID,
        label: 'mithril',
        xp: 8,
      },
      {
        arrowheadId: BLACK_BRONZE_ARROWHEADS_ITEM_ID,
        arrowId: BLACK_BRONZE_ARROWS_ITEM_ID,
        label: 'black bronze',
        xp: 16,
      },
    ];

    for (const { arrowheadId, arrowId, label, xp: expectedXp } of cases) {
      const { world, player, xp, messages } = makeHarness(0);
      player.inventory[0] = { itemId: HEADLESS_ARROWS_ITEM_ID, quantity: 1 };
      player.inventory[1] = { itemId: arrowheadId, quantity: 1 };

      world.handlePlayerUseItemOnItem(player.id, 0, HEADLESS_ARROWS_ITEM_ID, 1, arrowheadId, 1);

      expect(player.inventory[0]).toEqual({ itemId: arrowId, quantity: 1 });
      expect(player.inventory[1]).toBeNull();
      expect(xp).toEqual([{ skill: 'crafting', amount: expectedXp }]);
      expect(messages).toEqual([`You make a ${label} arrow.`]);
    }
  });

  test('higher-tier arrowhead recipes enforce crafting levels', () => {
    const { world, player, xp, messages } = makeHarness(0);
    player.skills.crafting.level = 44;
    player.skills.crafting.currentLevel = 44;
    player.inventory[0] = { itemId: HEADLESS_ARROWS_ITEM_ID, quantity: 1 };
    player.inventory[1] = { itemId: MITHRIL_ARROWHEADS_ITEM_ID, quantity: 1 };

    world.handlePlayerUseItemOnItem(player.id, 0, HEADLESS_ARROWS_ITEM_ID, 1, MITHRIL_ARROWHEADS_ITEM_ID, 1);

    expect(player.inventory[0]).toEqual({ itemId: HEADLESS_ARROWS_ITEM_ID, quantity: 1 });
    expect(player.inventory[1]).toEqual({ itemId: MITHRIL_ARROWHEADS_ITEM_ID, quantity: 1 });
    expect(xp).toEqual([]);
    expect(messages).toEqual(['You need level 45 Crafting to do that.']);
  });
});
