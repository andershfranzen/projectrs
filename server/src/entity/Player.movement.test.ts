import { describe, expect, test } from 'bun:test';
import { Player } from './Player';

function makePlayer(): Player {
  return new Player('movement-test', 0.5, 0.5, {} as Player['ws']);
}

describe('Player movement queue', () => {
  test('remaining queue comparison distinguishes same-destination reroutes', () => {
    const player = makePlayer();
    player.setMoveQueue([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
    ]);

    expect(player.remainingMoveQueueMatches([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
    ])).toBe(true);
    expect(player.remainingMoveQueueMatches([
      { x: 1.5, z: 1.5 },
      { x: 2.5, z: 0.5 },
    ])).toBe(false);
  });

  test('remaining queue comparison starts from the active queue cursor', () => {
    const player = makePlayer();
    player.setMoveQueue([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
    ]);
    player.movementCredit = 1;
    player.processMovement(1);

    expect(player.remainingMoveQueueMatches([
      { x: 2.5, z: 0.5 },
    ])).toBe(true);
    expect(player.remainingMoveQueueMatches([
      { x: 1.5, z: 0.5 },
      { x: 2.5, z: 0.5 },
    ])).toBe(false);
  });

  test('trimming to next step keeps only the active destination tile', () => {
    const player = makePlayer();
    player.setMoveQueue([
      { x: 1.5, z: 1.5 },
      { x: 2.5, z: 2.5 },
      { x: 3.5, z: 2.5 },
    ]);
    player.movementCredit = 0.75;
    player.movementCreditUpdatedAtMs = 12345;

    expect(player.trimMoveQueueToNextStep()).toBe(true);
    expect(player.remainingMoveSteps()).toBe(1);
    expect(player.getMoveDestination()).toEqual({ x: 1.5, z: 1.5 });
    expect(player.movementCredit).toBe(0.75);
    expect(player.movementCreditUpdatedAtMs).toBe(12345);
  });
});
