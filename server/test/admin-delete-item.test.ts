import { describe, expect, test } from 'bun:test';
import { ServerOpcode } from '@projectrs/shared';
import { World } from '../src/World';
import type { GameEventLogInput } from '../src/Database';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function makeWorld(): { world: any; events: GameEventLogInput[]; inventorySends: { count: number }; bankUpdates: number[][] } {
  const events: GameEventLogInput[] = [];
  const inventorySends = { count: 0 };
  const bankUpdates: number[][] = [];
  const itemDefs = new Map([
    [10, { id: 10, name: 'Coins', stackable: true }],
    [411, { id: 411, name: 'Green Cape', stackable: false }],
  ]);
  const world = Object.create(World.prototype) as any;
  world.currentTick = 100;
  world.players = new Map();
  world.data = {
    itemDefs,
    getItem(itemId: number) {
      return itemDefs.get(itemId) ?? null;
    },
  };
  world.db = {
    recordGameEvent(event: GameEventLogInput) {
      events.push(event);
    },
  };
  world.sendInventory = () => {
    inventorySends.count++;
  };
  world.sendToPlayer = (_player: Player, opcode: ServerOpcode, ...values: number[]) => {
    if (opcode === ServerOpcode.BANK_UPDATE_SLOT) bankUpdates.push(values);
  };
  return { world, events, inventorySends, bankUpdates };
}

describe('admin item deletion', () => {
  test('admin deletes an inventory stack without creating a ground item', () => {
    const { world, events, inventorySends } = makeWorld();
    const player = new Player('admin_delete_inv', 12.5, 18.5, fakeWs, 77);
    player.isAdmin = true;
    player.inventory[4] = { itemId: 10, quantity: 1234 };
    world.players.set(player.id, player);

    world.handleAdminDeleteInventoryItem(player.id, 4, 10);

    expect(player.inventory[4]).toBeNull();
    expect(inventorySends.count).toBe(1);
    expect(player.getActiveDelayReason(100)).toBe('generic');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'admin',
      severity: 'warning',
      actorAccountId: 77,
      actorName: 'admin_delete_inv',
      itemId: 10,
      itemName: 'Coins',
      quantity: 1234,
      details: {
        action: 'delete_item',
        container: 'inventory',
        slot: 4,
        expectedItemId: 10,
      },
    });
  });

  test('non-admin inventory delete packets are ignored server-side', () => {
    const { world, events, inventorySends } = makeWorld();
    const player = new Player('not_admin_delete_inv', 12.5, 18.5, fakeWs, 78);
    player.inventory[4] = { itemId: 10, quantity: 1234 };
    world.players.set(player.id, player);

    world.handleAdminDeleteInventoryItem(player.id, 4, 10);

    expect(player.inventory[4]).toEqual({ itemId: 10, quantity: 1234 });
    expect(inventorySends.count).toBe(0);
    expect(events).toEqual([]);
  });

  test('admin deletes a bank stack and sends a bank slot clear', () => {
    const { world, events, bankUpdates } = makeWorld();
    const player = new Player('admin_delete_bank', 12.5, 18.5, fakeWs, 79);
    player.isAdmin = true;
    player.openInterface = 'bank';
    player.bank[7] = { itemId: 411, quantity: 2 };
    world.players.set(player.id, player);

    world.handleAdminDeleteBankItem(player.id, 7, 411);

    expect(player.bank[7]).toBeNull();
    expect(player.getActiveDelayReason(100)).toBe('generic');
    expect(bankUpdates).toEqual([[7, 0, 0, 0]]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'admin',
      severity: 'warning',
      actorAccountId: 79,
      actorName: 'admin_delete_bank',
      itemId: 411,
      itemName: 'Green Cape',
      quantity: 2,
      details: {
        action: 'delete_item',
        container: 'bank',
        slot: 7,
        expectedItemId: 411,
      },
    });
  });

  test('bank deletion requires an open bank interface', () => {
    const { world, events, bankUpdates } = makeWorld();
    const player = new Player('admin_closed_bank', 12.5, 18.5, fakeWs, 80);
    player.isAdmin = true;
    player.bank[7] = { itemId: 411, quantity: 2 };
    world.players.set(player.id, player);

    world.handleAdminDeleteBankItem(player.id, 7, 411);

    expect(player.bank[7]).toEqual({ itemId: 411, quantity: 2 });
    expect(bankUpdates).toEqual([]);
    expect(events).toEqual([]);
  });
});
