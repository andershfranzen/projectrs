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
    [411, { id: 411, name: 'Green Cape', stackable: false, noteable: true, noteId: 20411 }],
    [20411, { id: 20411, name: 'Green Cape', stackable: true, unnotedId: 411 }],
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

describe('bank notes', () => {
  test('withdraw-as-note gives a stackable noted variant and keeps bank canonical', () => {
    const { world, bankUpdates, inventorySends } = makeWorld();
    const player = new Player('bank_note_withdraw', 12.5, 18.5, fakeWs, 84);
    player.openInterface = 'bank';
    player.bankWithdrawMode = 'note';
    player.bank[2] = { itemId: 411, quantity: 3 };
    world.players.set(player.id, player);

    world.handleBankWithdraw(player.id, 2, 411, -1);

    expect(player.bank[2]).toBeNull();
    expect(player.inventory[0]).toEqual({ itemId: 20411, quantity: 3 });
    expect(inventorySends.count).toBe(1);
    expect(bankUpdates).toEqual([[2, 0, 0, 0]]);
  });

  test('depositing notes stores the unnoted item in the bank', () => {
    const { world, bankUpdates } = makeWorld();
    const player = new Player('bank_note_deposit', 12.5, 18.5, fakeWs, 85);
    player.openInterface = 'bank';
    player.inventory[0] = { itemId: 20411, quantity: 5 };
    world.players.set(player.id, player);

    world.handleBankDeposit(player.id, 0, 20411, -1);

    expect(player.inventory[0]).toBeNull();
    expect(player.bank[0]).toEqual({ itemId: 411, quantity: 5 });
    expect(bankUpdates).toEqual([[0, 411, 0, 5]]);
  });

  test('using notes at a bank converts as many as inventory space allows', () => {
    const { world, inventorySends } = makeWorld();
    const player = new Player('bank_note_unnote', 12.5, 18.5, fakeWs, 86);
    player.inventory[0] = { itemId: 20411, quantity: 3 };
    player.inventory[1] = { itemId: 10, quantity: 50 };
    for (let i = 3; i < player.inventory.length; i++) player.inventory[i] = { itemId: 10, quantity: 1 };
    world.players.set(player.id, player);

    const handled = world.unnoteInventorySlotAtBank(player, 0, 20411);

    expect(handled).toBe(true);
    expect(player.inventory[0]).toEqual({ itemId: 20411, quantity: 2 });
    expect(player.inventory[2]).toEqual({ itemId: 411, quantity: 1 });
    expect(inventorySends.count).toBe(1);
  });
});

describe('bank item reorder', () => {
  test('swaps two occupied bank slots without delay', () => {
    const { world, bankUpdates } = makeWorld();
    const player = new Player('bank_reorder_swap', 12.5, 18.5, fakeWs, 81);
    player.openInterface = 'bank';
    player.bank[2] = { itemId: 10, quantity: 500 };
    player.bank[9] = { itemId: 411, quantity: 1 };
    world.players.set(player.id, player);

    world.handleBankMoveItem(player.id, 2, 9, 10);

    expect(player.bank[2]).toEqual({ itemId: 411, quantity: 1 });
    expect(player.bank[9]).toEqual({ itemId: 10, quantity: 500 });
    expect(player.getActiveDelayReason(100)).toBeNull();
    expect(bankUpdates).toEqual([
      [2, 411, 0, 1],
      [9, 10, 0, 500],
    ]);
  });

  test('moves a bank item into an empty slot', () => {
    const { world, bankUpdates } = makeWorld();
    const player = new Player('bank_reorder_empty', 12.5, 18.5, fakeWs, 82);
    player.openInterface = 'bank';
    player.bank[4] = { itemId: 411, quantity: 3 };
    world.players.set(player.id, player);

    world.handleBankMoveItem(player.id, 4, 12, 411);

    expect(player.bank[4]).toBeNull();
    expect(player.bank[12]).toEqual({ itemId: 411, quantity: 3 });
    expect(bankUpdates).toEqual([
      [4, 0, 0, 0],
      [12, 411, 0, 3],
    ]);
  });

  test('requires an open bank interface and a current source item match', () => {
    const { world, bankUpdates } = makeWorld();
    const player = new Player('bank_reorder_guarded', 12.5, 18.5, fakeWs, 83);
    player.bank[2] = { itemId: 10, quantity: 500 };
    player.bank[9] = { itemId: 411, quantity: 1 };
    world.players.set(player.id, player);

    world.handleBankMoveItem(player.id, 2, 9, 10);
    player.openInterface = 'bank';
    world.handleBankMoveItem(player.id, 2, 9, 411);

    expect(player.bank[2]).toEqual({ itemId: 10, quantity: 500 });
    expect(player.bank[9]).toEqual({ itemId: 411, quantity: 1 });
    expect(bankUpdates).toEqual([]);
  });
});
