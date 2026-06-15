import { describe, expect, test } from 'bun:test';
import { ClientOpcode, decodePacket } from '@projectrs/shared';
import { DialoguePanel } from './DialoguePanel';

function decodeClientPacket(packet: Uint8Array) {
  return decodePacket(packet.buffer.slice(
    packet.byteOffset,
    packet.byteOffset + packet.byteLength,
  ) as ArrayBuffer);
}

describe('DialoguePanel', () => {
  test('cancelDialogue sends a session-scoped close packet and hides locally', () => {
    const sent: Uint8Array[] = [];
    const panel = Object.create(DialoguePanel.prototype) as any;
    let hidden = false;
    panel.visible = true;
    panel.currentNode = { sessionId: 77, speaker: 'Guide', lines: ['Hello'], options: [] };
    panel.npcEntityId = 123;
    panel.sessionId = 77;
    panel.network = { sendRaw: (packet: Uint8Array) => sent.push(packet) };
    panel.hide = () => { hidden = true; };

    panel.cancelDialogue();

    expect(hidden).toBe(true);
    expect(sent).toHaveLength(1);
    expect(decodeClientPacket(sent[0])).toEqual({
      opcode: ClientOpcode.DIALOGUE_CLOSE,
      values: [123, 77],
    });
  });

  test('terminal options send the choice and hide immediately', () => {
    const sent: Uint8Array[] = [];
    const panel = Object.create(DialoguePanel.prototype) as any;
    let hidden = false;
    let waiting = false;
    panel.visible = true;
    panel.currentNode = {
      sessionId: 88,
      speaker: 'Guide',
      lines: ['Safe travels.'],
      options: [{ label: 'Goodbye.', terminal: true }],
    };
    panel.npcEntityId = 456;
    panel.sessionId = 88;
    panel.waitingForNpcReply = false;
    panel.network = { sendRaw: (packet: Uint8Array) => sent.push(packet) };
    panel.hooks = {
      showPlayerBubble: () => {},
      showNpcBubble: () => {},
      hideNpcBubble: () => {},
    };
    panel.clearNpcBubble = () => {};
    panel.setOptionsVisible = () => {};
    panel.hide = () => { hidden = true; };

    panel.chooseOption(0);
    waiting = panel.waitingForNpcReply;

    expect(hidden).toBe(true);
    expect(waiting).toBe(false);
    expect(sent).toHaveLength(1);
    expect(decodeClientPacket(sent[0])).toEqual({
      opcode: ClientOpcode.DIALOGUE_CHOOSE,
      values: [456, 88, 0],
    });
  });

  test('silent options do not show a player dialogue bubble', () => {
    const sent: Uint8Array[] = [];
    const playerBubbles: string[] = [];
    const panel = Object.create(DialoguePanel.prototype) as any;
    panel.visible = true;
    panel.currentNode = {
      sessionId: 90,
      speaker: 'Guide',
      lines: ['Pick one.'],
      options: [{ label: 'Back.', silent: true }],
    };
    panel.npcEntityId = 321;
    panel.sessionId = 90;
    panel.waitingForNpcReply = false;
    panel.network = { sendRaw: (packet: Uint8Array) => sent.push(packet) };
    panel.hooks = {
      showPlayerBubble: (message: string) => playerBubbles.push(message),
      showNpcBubble: () => {},
      hideNpcBubble: () => {},
    };
    panel.clearNpcBubble = () => {};
    panel.setOptionsVisible = () => {};

    panel.chooseOption(0);

    expect(playerBubbles).toEqual([]);
    expect(panel.waitingForNpcReply).toBe(true);
    expect(sent).toHaveLength(1);
  });

  test('choices-only replies render immediately without waiting for NPC text', () => {
    const panel = Object.create(DialoguePanel.prototype) as any;
    let rendered = false;
    let optionsHidden = false;
    panel.npcReplyDelayTimer = null;
    panel.waitingForNpcReply = true;
    panel.render = () => { rendered = true; };
    panel.setOptionsVisible = (visible: boolean) => { if (!visible) optionsHidden = true; };

    panel.show(777, {
      sessionId: 91,
      speaker: 'Guide',
      lines: [],
      options: [{ label: 'Ask something else.' }],
    });

    expect(panel.waitingForNpcReply).toBe(false);
    expect(rendered).toBe(true);
    expect(optionsHidden).toBe(false);
  });

  test('fallback continue on optionless nodes closes the server dialogue session', () => {
    const sent: Uint8Array[] = [];
    const panel = Object.create(DialoguePanel.prototype) as any;
    let hidden = false;
    panel.visible = true;
    panel.currentNode = {
      sessionId: 99,
      speaker: 'Guide',
      lines: ['That is all I have to say.'],
      options: [],
    };
    panel.npcEntityId = 789;
    panel.sessionId = 99;
    panel.network = { sendRaw: (packet: Uint8Array) => sent.push(packet) };
    panel.hide = () => { hidden = true; };

    panel.chooseOption(0);

    expect(hidden).toBe(true);
    expect(sent).toHaveLength(1);
    expect(decodeClientPacket(sent[0])).toEqual({
      opcode: ClientOpcode.DIALOGUE_CLOSE,
      values: [789, 99],
    });
  });
});
