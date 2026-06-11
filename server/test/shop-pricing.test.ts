import { describe, expect, test } from 'bun:test';
import { MAX_STACK, generatedBankNoteId, ServerOpcode, type ItemDef, type NpcDef, type ShopDef } from '@projectrs/shared';
import { Player } from '../src/entity/Player';
import { Npc } from '../src/entity/Npc';
import { World } from '../src/World';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function item(id: number, name: string, overrides: Partial<ItemDef> = {}): ItemDef {
  return {
    id,
    name,
    description: name,
    stackable: false,
    equippable: false,
    value: 1,
    ...overrides,
  };
}

function npcDef(shop: ShopDef): NpcDef {
  return {
    id: 100,
    name: 'Shopkeeper',
    health: 10,
    attack: 1,
    strength: 1,
    defence: 1,
    attackSpeed: 4,
    respawnTime: 10,
    wanderRange: 3,
    aggressive: false,
    lootTable: [],
    shop,
  };
}

function makeWorld(player: Player, npc: Npc, defs: Map<number, ItemDef>): any {
  const packets: Array<{ opcode: ServerOpcode; values: number[] }> = [];
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[player.id, player]]);
  world.npcs = new Map([[npc.id, npc]]);
  world.currentTick = 10;
  world.data = {
    itemDefs: defs,
    getItem: (id: number) => defs.get(id),
  };
  world.sendToPlayer = (_player: Player, opcode: ServerOpcode, ...values: number[]) => {
    packets.push({ opcode, values });
  };
  world.sendInventory = () => {};
  world.sendChatSystem = () => {};
  world.interruptPlayerAction = () => {};
  world.canPlayerTargetNpc = () => true;
  world.isPlayerNpcInteractionReachable = () => true;
  return { world, packets };
}

describe('shop stock pricing', () => {
  test('buy price scales gradually as stock falls and restocks one unit per timer', () => {
    const shop: ShopDef = {
      name: 'General Store',
      restockTicks: 2,
      items: [{ itemId: 1000, price: 100, stock: 10 }],
    };
    const def = npcDef(shop);
    const npc = new Npc(def, 10.5, 10.5, 3, null, null, null, shop);
    const player = new Player('shop_test', 10.5, 11.5, fakeWs, 1);
    player.openShopNpcId = npc.npcId;
    player.openShopNpcEntityId = npc.id;
    player.inventory[0] = { itemId: 10, quantity: 1000 };

    const defs = new Map<number, ItemDef>([
      [10, item(10, 'Coins', { stackable: true })],
      [1000, item(1000, 'Knife')],
    ]);
    const { world, packets } = makeWorld(player, npc, defs);
    const shopItem = shop.items[0];

    expect(world.shopItemPrice(shopItem, 10)).toBe(100);
    expect(world.shopItemPrice(shopItem, 5)).toBe(125);
    expect(world.shopItemPrice(shopItem, 0)).toBe(150);

    world.handlePlayerBuyItem(player.id, 1000, 5);

    expect(npc.shopStock.get(1000)).toBe(5);
    expect(player.inventory[0]?.quantity).toBe(450);
    expect(npc.shopNextRestockTick.get(1000)).toBe(12);
    expect(packets[packets.length - 1]).toMatchObject({
      // Per-item layout: [itemId, priceHigh, priceLow, stock] — price split for >int16.
      opcode: ServerOpcode.SHOP_OPEN,
      values: [npc.id, 1, 1000, 0, 125, 5],
    });

    world.currentTick = 11;
    world.tickShopRestocks();
    expect(npc.shopStock.get(1000)).toBe(5);

    world.currentTick = 12;
    world.tickShopRestocks();
    expect(npc.shopStock.get(1000)).toBe(6);
    expect(npc.shopNextRestockTick.get(1000)).toBe(14);
  });

  test('selling a noted item pays the unnoted item value', () => {
    const shop: ShopDef = {
      name: 'General Store',
      restockTicks: 2,
      items: [{ itemId: 1000, price: 100, stock: 10 }],
    };
    const def = npcDef(shop);
    const npc = new Npc(def, 10.5, 10.5, 3, null, null, null, shop);
    const player = new Player('shop_note_sell_test', 10.5, 11.5, fakeWs, 2);
    player.openShopNpcId = npc.npcId;
    player.openShopNpcEntityId = npc.id;
    const noteId = generatedBankNoteId(1000);
    player.inventory[0] = { itemId: noteId, quantity: 2 };

    const defs = new Map<number, ItemDef>([
      [10, item(10, 'Coins', { stackable: true })],
      [1000, item(1000, 'Knife', { value: 75, noteable: true, noteId })],
      [noteId, item(noteId, 'Knife Note', {
        stackable: true,
        value: 1,
        unnotedId: 1000,
      })],
    ]);
    const { world } = makeWorld(player, npc, defs);

    world.handlePlayerSellItem(player.id, 0, 2, noteId);

    expect(player.inventory[0]).toEqual({ itemId: 10, quantity: 74 });
    expect(npc.shopStock.get(1000)).toBe(10);
  });

  test('selling rolls back the item when coins cannot be added', () => {
    const shop: ShopDef = {
      name: 'General Store',
      restockTicks: 2,
      items: [{ itemId: 1000, price: 100, stock: 10 }],
    };
    const def = npcDef(shop);
    const npc = new Npc(def, 10.5, 10.5, 3, null, null, null, shop);
    const player = new Player('shop_coin_full_sell_test', 10.5, 11.5, fakeWs, 3);
    player.openShopNpcId = npc.npcId;
    player.openShopNpcEntityId = npc.id;
    player.inventory[0] = { itemId: 1000, quantity: 2 };
    player.inventory[1] = { itemId: 10, quantity: MAX_STACK };

    const defs = new Map<number, ItemDef>([
      [10, item(10, 'Coins', { stackable: true })],
      [1000, item(1000, 'Knife', { stackable: true, value: 75 })],
    ]);
    const { world } = makeWorld(player, npc, defs);

    world.handlePlayerSellItem(player.id, 0, 1, 1000);

    expect(player.inventory[0]).toEqual({ itemId: 1000, quantity: 2 });
    expect(player.inventory[1]).toEqual({ itemId: 10, quantity: MAX_STACK });
  });

  test('buying can pay from split legacy coin stacks', () => {
    const shop: ShopDef = {
      name: 'General Store',
      restockTicks: 2,
      items: [{ itemId: 1000, price: 60, stock: 10 }],
    };
    const def = npcDef(shop);
    const npc = new Npc(def, 10.5, 10.5, 3, null, null, null, shop);
    const player = new Player('shop_split_coin_buy_test', 10.5, 11.5, fakeWs, 4);
    player.openShopNpcId = npc.npcId;
    player.openShopNpcEntityId = npc.id;
    player.inventory[0] = { itemId: 10, quantity: 40 };
    player.inventory[1] = { itemId: 10, quantity: 20 };

    const defs = new Map<number, ItemDef>([
      [10, item(10, 'Coins', { stackable: true })],
      [1000, item(1000, 'Knife')],
    ]);
    const { world } = makeWorld(player, npc, defs);

    world.handlePlayerBuyItem(player.id, 1000, 1);

    expect(player.inventory[0]).toEqual({ itemId: 1000, quantity: 1 });
    expect(player.inventory[1]).toBeNull();
    expect(npc.shopStock.get(1000)).toBe(9);
  });

  test('stale shop entity closes instead of retargeting another same-def shop', () => {
    const shop: ShopDef = {
      name: 'General Store',
      restockTicks: 2,
      items: [{ itemId: 1000, price: 10, stock: 10 }],
    };
    const def = npcDef(shop);
    const otherNpc = new Npc(def, 10.5, 10.5, 3, null, null, null, shop);
    const player = new Player('shop_stale_entity_test', 10.5, 11.5, fakeWs, 5);
    player.openShopNpcId = otherNpc.npcId;
    player.openShopNpcEntityId = 9999;
    player.inventory[0] = { itemId: 10, quantity: 100 };

    const defs = new Map<number, ItemDef>([
      [10, item(10, 'Coins', { stackable: true })],
      [1000, item(1000, 'Knife')],
    ]);
    const { world, packets } = makeWorld(player, otherNpc, defs);

    world.handlePlayerBuyItem(player.id, 1000, 1);

    expect(player.inventory[0]).toEqual({ itemId: 10, quantity: 100 });
    expect(otherNpc.shopStock.get(1000)).toBe(10);
    expect(player.openShopNpcId).toBeNull();
    expect(player.openShopNpcEntityId).toBeNull();
    expect(packets[packets.length - 1]).toMatchObject({
      opcode: ServerOpcode.SHOP_CLOSE,
      values: [0],
    });
  });

  test('unsafe shop prices are rejected without mutating stock or inventory', () => {
    const shop: ShopDef = {
      name: 'General Store',
      restockTicks: 2,
      items: [{ itemId: 1000, price: 40000, stock: 10 }],
    };
    const def = npcDef(shop);
    const npc = new Npc(def, 10.5, 10.5, 3, null, null, null, shop);
    const player = new Player('shop_unsafe_price_test', 10.5, 11.5, fakeWs, 6);
    player.openShopNpcId = npc.npcId;
    player.openShopNpcEntityId = npc.id;
    player.inventory[0] = { itemId: 10, quantity: 50000 };

    const defs = new Map<number, ItemDef>([
      [10, item(10, 'Coins', { stackable: true })],
      [1000, item(1000, 'Knife')],
    ]);
    const { world } = makeWorld(player, npc, defs);

    world.handlePlayerBuyItem(player.id, 1000, 1);

    expect(player.inventory[0]).toEqual({ itemId: 10, quantity: 50000 });
    expect(npc.shopStock.get(1000)).toBe(10);
  });
});
