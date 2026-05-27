import { describe, expect, test } from 'bun:test';
import { ServerOpcode } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

describe('inventory drop after eating', () => {
  test('food delay blocks another eat but still allows dropping an item', () => {
    const world = Object.create(World.prototype) as any;
    const player = new Player('drop_after_eat', 10.5, 10.5, fakeWs, 1);
    player.inventory[0] = { itemId: 12, quantity: 2 };
    player.inventory[1] = { itemId: 23, quantity: 1 };

    const sentOpcodes: ServerOpcode[] = [];
    world.currentTick = 100;
    world.players = new Map([[player.id, player]]);
    world.groundItems = new Map();
    world.despawningItemIds = new Set();
    world.chunkManagers = new Map();
    world.data = { getItem: (itemId: number) => itemId === 12 ? { id: 12, name: 'Food', healAmount: 3 } : null };
    world.clearPendingObjectIntents = () => {};
    world.closeNpcUiContext = () => {};
    world.cancelSkilling = () => {};
    world.cancelItemProduction = () => {};
    world.allocateGroundItemId = () => 30000;
    world.forEachPlayerNearOnFloor = () => {};
    world.sendInventory = () => {};
    world.sendToPlayer = (_player: Player, opcode: ServerOpcode) => { sentOpcodes.push(opcode); };

    world.handlePlayerEat(player.id, 0, 12);
    expect(player.inventory[0]).toEqual({ itemId: 12, quantity: 1 });
    expect(player.getActiveDelayReason(101)).toBe('eat');

    world.currentTick = 101;
    world.handlePlayerEat(player.id, 0, 12);
    expect(player.inventory[0]).toEqual({ itemId: 12, quantity: 1 });

    world.handlePlayerDrop(player.id, 1, 23);
    expect(player.inventory[1]).toBeNull();
    const dropped = world.groundItems.get(30000);
    expect(dropped?.itemId).toBe(23);
    expect(dropped?.quantity).toBe(1);
    expect(sentOpcodes).toContain(ServerOpcode.PLAYER_STATS);
  });
});
