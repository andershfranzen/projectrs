import { describe, expect, test } from 'bun:test';
import { ENCRYPTED_GAME_FRAME } from '@projectrs/shared';
import { enableGameSocketEncryption, installGameSocketEncryption, type GameSocketData } from '../src/network/GameSocket';

function exactBytes(data: Bun.BufferSource): Uint8Array {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return new Uint8Array(data as unknown as ArrayBuffer);
}

describe('game socket encryption', () => {
  test('keeps packets queued before encryption enablement in plaintext', async () => {
    const sent: Uint8Array[] = [];
    const data: GameSocketData = {
      type: 'game',
      accountId: 1,
      username: 'alice',
      isAdmin: false,
      ip: '127.0.0.1',
      deviceId: '',
      token: 'test-session-token',
    };
    const ws = {
      data: {
        ...data,
      } as GameSocketData,
      sendBinary(data: Bun.BufferSource) {
        sent.push(exactBytes(data));
        return 0;
      },
      close() {},
    };

    installGameSocketEncryption(ws as any);

    ws.sendBinary(new Uint8Array([1, 2, 3]));
    enableGameSocketEncryption(ws as any);
    ws.sendBinary(new Uint8Array([4, 5, 6]));

    await ws.data.crypto?.sendQueue;

    expect(sent).toHaveLength(2);
    expect([...sent[0]]).toEqual([1, 2, 3]);
    expect(sent[1][0]).toBe(ENCRYPTED_GAME_FRAME);
  });
});
