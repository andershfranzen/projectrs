import { describe, expect, test } from 'bun:test';
import {
  ENCRYPTED_GAME_FRAME_V2,
  GAME_CRYPTO_VERSION,
  PROTOCOL_VERSION,
  buildGameHandshakeTranscript,
  bytesToBase64Url,
  decryptGamePacketV2,
  deriveGameCipherKeysV2,
  encodePacket,
  encryptGamePacketV2,
  exportGamePublicKey,
  generateGameEcdhKeyPair,
  importGameEcdhPublicKey,
  randomBytesBrowser,
  signGameHandshakeTranscript,
  verifyGameHandshakeTranscript,
} from '@projectrs/shared';

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

describe('game socket encryption', () => {
  test('requires signed ECDH transcript and derives matching directional keys', async () => {
    const authToken = 'test-session-token';
    const accountId = 42;
    const deviceId = '11111111-1111-4111-8111-111111111111';
    const connectionId = bytesToBase64Url(randomBytesBrowser(16));
    const serverNonce = bytesToBase64Url(randomBytesBrowser(16));
    const clientNonce = bytesToBase64Url(randomBytesBrowser(16));

    const serverEcdh = await generateGameEcdhKeyPair();
    const clientEcdh = await generateGameEcdhKeyPair();
    const serverPublicKey = await exportGamePublicKey(serverEcdh.publicKey);
    const clientPublicKey = await exportGamePublicKey(clientEcdh.publicKey);
    const deviceSigningKey = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const devicePublicKey = await crypto.subtle.exportKey('jwk', deviceSigningKey.publicKey);

    const transcript = buildGameHandshakeTranscript({
      protocolVersion: PROTOCOL_VERSION,
      accountId,
      deviceId,
      connectionId,
      serverNonce,
      clientNonce,
      serverPublicKey,
      clientPublicKey,
    });
    const signature = await signGameHandshakeTranscript(deviceSigningKey.privateKey, transcript);
    expect(await verifyGameHandshakeTranscript(devicePublicKey, transcript, signature)).toBe(true);

    const tamperedTranscript = buildGameHandshakeTranscript({
      protocolVersion: PROTOCOL_VERSION + 1,
      accountId,
      deviceId,
      connectionId,
      serverNonce,
      clientNonce,
      serverPublicKey,
      clientPublicKey,
    });
    expect(await verifyGameHandshakeTranscript(devicePublicKey, tamperedTranscript, signature)).toBe(false);

    const serverKeys = await deriveGameCipherKeysV2({
      privateKey: serverEcdh.privateKey,
      peerPublicKey: await importGameEcdhPublicKey(clientPublicKey),
      authToken,
      transcript,
      serverNonce,
      clientNonce,
      connectionId,
      accountId,
    });
    const clientKeys = await deriveGameCipherKeysV2({
      privateKey: clientEcdh.privateKey,
      peerPublicKey: await importGameEcdhPublicKey(serverPublicKey),
      authToken,
      transcript,
      serverNonce,
      clientNonce,
      connectionId,
      accountId,
    });

    const packet = encodePacket(10, 1, 2, 3);
    const frame = await encryptGamePacketV2(clientKeys, 'client-to-server', 7, packet);
    expect(frame[0]).toBe(ENCRYPTED_GAME_FRAME_V2);
    expect(frame[1]).toBe(GAME_CRYPTO_VERSION);

    const decrypted = await decryptGamePacketV2(serverKeys, 'client-to-server', exactArrayBuffer(frame));
    expect(decrypted.counter).toBe(7);
    expect([...new Uint8Array(decrypted.plaintext)]).toEqual([...packet]);

    await expect(decryptGamePacketV2(serverKeys, 'server-to-client', exactArrayBuffer(frame))).rejects.toThrow();
  });
});
