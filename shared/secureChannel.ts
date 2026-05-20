export const ENCRYPTED_GAME_FRAME = 255;
export const SESSION_NONCE_WORDS = 4;

export type GameCipherDirection = 'client-to-server' | 'server-to-client';

const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  const c = globalThis.crypto?.subtle;
  if (!c) throw new Error('WebCrypto subtle API is unavailable');
  return c;
}

export function nonceBytesToWords(nonce: Uint8Array): number[] {
  if (nonce.length !== 8) throw new Error('session nonce must be 8 bytes');
  const view = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  const out: number[] = [];
  for (let i = 0; i < SESSION_NONCE_WORDS; i++) {
    const u = view.getUint16(i * 2);
    out.push(u > 0x7fff ? u - 0x10000 : u);
  }
  return out;
}

export function nonceWordsToBytes(words: number[]): Uint8Array {
  if (words.length < SESSION_NONCE_WORDS) throw new Error('missing session nonce words');
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  for (let i = 0; i < SESSION_NONCE_WORDS; i++) {
    view.setUint16(i * 2, words[i] & 0xffff);
  }
  return out;
}

export async function deriveGameCipherKey(token: string, sessionNonce: Uint8Array): Promise<CryptoKey> {
  const tokenBytes = encoder.encode(token);
  const material = new Uint8Array(tokenBytes.length + sessionNonce.length + 18);
  material.set(encoder.encode('evilquest-game-v1:'), 0);
  material.set(sessionNonce, 18);
  material.set(tokenBytes, 18 + sessionNonce.length);
  const digest = await subtle().digest('SHA-256', material);
  return subtle().importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function frameNonce(sessionNonce: Uint8Array, direction: GameCipherDirection, counter: number): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(sessionNonce.slice(0, 8), 0);
  iv[7] ^= direction === 'client-to-server' ? 0xc3 : 0x3c;
  const view = new DataView(iv.buffer);
  view.setUint32(8, counter >>> 0);
  return iv;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

export async function encryptGamePacket(
  key: CryptoKey,
  sessionNonce: Uint8Array,
  direction: GameCipherDirection,
  counter: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const ciphertext = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv: exactArrayBuffer(frameNonce(sessionNonce, direction, counter)) },
    key,
    exactArrayBuffer(plaintext),
  ));
  const frame = new Uint8Array(1 + 4 + ciphertext.length);
  frame[0] = ENCRYPTED_GAME_FRAME;
  new DataView(frame.buffer).setUint32(1, counter >>> 0);
  frame.set(ciphertext, 5);
  return frame;
}

export async function decryptGamePacket(
  key: CryptoKey,
  sessionNonce: Uint8Array,
  direction: GameCipherDirection,
  frame: ArrayBuffer,
): Promise<{ counter: number; plaintext: ArrayBuffer }> {
  if (frame.byteLength < 6) throw new RangeError('encrypted frame too short');
  const view = new DataView(frame);
  if (view.getUint8(0) !== ENCRYPTED_GAME_FRAME) throw new RangeError('not an encrypted game frame');
  const counter = view.getUint32(1);
  const ciphertext = new Uint8Array(frame, 5);
  const plaintext = await subtle().decrypt(
    { name: 'AES-GCM', iv: exactArrayBuffer(frameNonce(sessionNonce, direction, counter)) },
    key,
    exactArrayBuffer(ciphertext),
  );
  return { counter, plaintext };
}
