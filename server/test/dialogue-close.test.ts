import { describe, expect, test } from 'bun:test';
import { ServerOpcode } from '@projectrs/shared';
import { World } from '../src/World';

function makeWorldWithDialogue(state: { npcEntityId: number; sessionId: number }) {
  const sent: Array<{ opcode: ServerOpcode; values: number[] }> = [];
  const player = {
    id: 1,
    openDialogueState: {
      npcEntityId: state.npcEntityId,
      sessionId: state.sessionId,
      nodeId: 'root',
      visibleOptionIndices: [0],
    },
  };
  const world = Object.create(World.prototype) as any;
  world.players = new Map([[player.id, player]]);
  world.dialogueScheduledSteps = [
    { playerId: player.id, sessionId: state.sessionId },
    { playerId: player.id, sessionId: state.sessionId + 1 },
    { playerId: 2, sessionId: state.sessionId },
  ];
  world.sendToPlayer = (_player: unknown, opcode: ServerOpcode, ...values: number[]) => {
    sent.push({ opcode, values });
  };
  return { world, player, sent };
}

describe('dialogue close', () => {
  test('Escape close only closes the matching dialogue session', () => {
    const { world, player, sent } = makeWorldWithDialogue({ npcEntityId: 50, sessionId: 7 });

    world.handleDialogueClose(player.id, 50, 7);

    expect(player.openDialogueState).toBeNull();
    expect(world.dialogueScheduledSteps).toEqual([
      { playerId: player.id, sessionId: 8 },
      { playerId: 2, sessionId: 7 },
    ]);
    expect(sent).toEqual([{ opcode: ServerOpcode.DIALOGUE_CLOSE, values: [7] }]);
  });

  test('stale Escape close packets are ignored', () => {
    const { world, player, sent } = makeWorldWithDialogue({ npcEntityId: 50, sessionId: 7 });

    world.handleDialogueClose(player.id, 50, 8);
    world.handleDialogueClose(player.id, 51, 7);

    expect(player.openDialogueState).not.toBeNull();
    expect(world.dialogueScheduledSteps).toHaveLength(3);
    expect(sent).toEqual([]);
  });
});
