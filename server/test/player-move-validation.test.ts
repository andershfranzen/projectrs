import { describe, expect, test } from 'bun:test';
import { ServerOpcode } from '@projectrs/shared';
import { World } from '../src/World';
import { Player } from '../src/entity/Player';

const fakeWs = {
  sendBinary() {},
  send() {},
} as any;

function makeWorldHarness() {
  const player = new Player('runner', 0.5, 0.5, fakeWs, 1);
  const packets: { opcode: ServerOpcode; values: number[] }[] = [];
  const counters = { actionRevisions: 0 };
  const map = {
    width: 32,
    height: 32,
    isWallBlocked: () => false,
    isWallBlockedOnFloor: () => false,
  };
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[player.id, player]]);
  world.activeDuels = new Set();
  world.sultansMineDoorTransitFor = () => null;
  world.repairOrCompleteSultansMineDoorTransit = () => {};
  world.bumpActionRevision = () => { counters.actionRevisions++; };
  world.clearCombatTarget = () => {};
  world.clearQueuedPlayerActions = () => {};
  world.cancelSkilling = () => {};
  world.cancelItemProduction = () => {};
  world.closeOpenInterface = () => {};
  world.closeShopForPlayer = () => {};
  world.sendDialogueClose = () => {};
  world.getPlayerMap = () => map;
  world.isPlayerMovementTileBlocked = (_player: Player, _map: unknown, x: number, z: number) => x < 0 || z < 0 || x >= map.width || z >= map.height;
  world.resolvePlayerMovementLayerAt = (_map: unknown, _x: number, _z: number, state: unknown) => state;
  world.sendToPlayer = (_player: Player, opcode: ServerOpcode, ...values: number[]) => {
    packets.push({ opcode, values });
  };
  world.sendNearbyDoorUpdates = () => {};
  return { world, player, packets, counters };
}

describe('player move validation', () => {
  test('recovers stale predicted turn paths with an authoritative route to the requested destination', () => {
    const { world, player, packets } = makeWorldHarness();

    world.handlePlayerMove(player.id, [
      { x: 2.5, z: 1.5 },
      { x: 5.5, z: 1.5 },
    ]);

    expect(player.hasMoveQueue()).toBe(true);
    expect(player.getMoveDestination()).toEqual({ x: 5.5, z: 1.5 });
    expect(packets.some(packet => packet.opcode === ServerOpcode.PATH_TRUNCATED)).toBe(false);
  });

  test('coalesces duplicate active move requests without resetting movement credit', () => {
    const { world, player, counters } = makeWorldHarness();

    world.handlePlayerMove(player.id, [
      { x: 2.5, z: 0.5 },
      { x: 5.5, z: 0.5 },
    ]);
    player.movementCredit = 1.25;
    player.movementCreditUpdatedAtMs = 12345;

    world.handlePlayerMove(player.id, [
      { x: 1.5, z: 0.5 },
      { x: 5.5, z: 0.5 },
    ]);

    expect(player.getMoveDestination()).toEqual({ x: 5.5, z: 0.5 });
    expect(player.movementCredit).toBe(1.25);
    expect(player.movementCreditUpdatedAtMs).toBe(12345);
    expect(counters.actionRevisions).toBe(2);
  });

  test('retargeting an active move preserves movement credit cadence', () => {
    const { world, player } = makeWorldHarness();

    world.handlePlayerMove(player.id, [
      { x: 2.5, z: 0.5 },
      { x: 5.5, z: 0.5 },
    ]);
    player.movementCredit = 0.8;
    player.movementCreditUpdatedAtMs = 12345;

    world.handlePlayerMove(player.id, [
      { x: 1.5, z: 0.5 },
      { x: 3.5, z: 1.5 },
      { x: 5.5, z: 1.5 },
    ]);

    expect(player.getMoveDestination()).toEqual({ x: 5.5, z: 1.5 });
    expect(player.movementCredit).toBe(0.8);
    expect(player.movementCreditUpdatedAtMs).toBe(12345);
  });
});
