export const ENCRYPTED_GAME_FRAME_V2 = 254;
export const GAME_CRYPTO_VERSION = 2;

export type GameCipherDirection = 'client-to-server' | 'server-to-client';

const encoder = new TextEncoder();

function subtle(): SubtleCrypto {
  const c = globalThis.crypto?.subtle;
  if (!c) throw new Error('WebCrypto subtle API is unavailable');
  return c;
}

export function randomBytesBrowser(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

export interface GameHandshakeTranscriptInput {
  protocolVersion: number;
  accountId: number;
  deviceId: string;
  connectionId: string;
  serverNonce: string;
  clientNonce: string;
  serverPublicKey: JsonWebKey;
  clientPublicKey: JsonWebKey;
}

export interface GameCryptoChallenge {
  version: number;
  connectionId: string;
  accountId: number;
  deviceId: string;
  serverNonce: string;
  serverPublicKey: JsonWebKey;
}

export interface GameCryptoResponse {
  version: number;
  clientNonce: string;
  clientPublicKey: JsonWebKey;
  signature: string;
}

export interface GameCipherKeysV2 {
  clientToServerKey: CryptoKey;
  serverToClientKey: CryptoKey;
  clientToServerIvPrefix: Uint8Array;
  serverToClientIvPrefix: Uint8Array;
  clientToServerAadPrefix: Uint8Array;
  serverToClientAadPrefix: Uint8Array;
  connectionId: string;
  accountId: number;
}

export function buildGameHandshakeTranscript(input: GameHandshakeTranscriptInput): Uint8Array {
  return encoder.encode(stableStringify({
    protocol: 'evilquest-game-v2',
    protocolVersion: input.protocolVersion,
    accountId: input.accountId,
    deviceId: input.deviceId,
    connectionId: input.connectionId,
    serverNonce: input.serverNonce,
    clientNonce: input.clientNonce,
    serverPublicKey: input.serverPublicKey,
    clientPublicKey: input.clientPublicKey,
  }));
}

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', exactArrayBuffer(concatBytes(...parts))));
}

export async function generateGameEcdhKeyPair(): Promise<CryptoKeyPair> {
  return subtle().generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  ) as Promise<CryptoKeyPair>;
}

export async function exportGamePublicKey(key: CryptoKey): Promise<JsonWebKey> {
  return subtle().exportKey('jwk', key);
}

export async function importGameEcdhPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return subtle().importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
}

export async function signGameHandshakeTranscript(privateKey: CryptoKey, transcript: Uint8Array): Promise<string> {
  const sig = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, exactArrayBuffer(transcript));
  return bytesToBase64Url(new Uint8Array(sig));
}

export async function verifyGameHandshakeTranscript(publicKeyJwk: JsonWebKey, transcript: Uint8Array, signature: string): Promise<boolean> {
  const publicKey = await subtle().importKey(
    'jwk',
    publicKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  return subtle().verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    exactArrayBuffer(base64UrlToBytes(signature)),
    exactArrayBuffer(transcript),
  );
}

export async function deriveGameCipherKeysV2(opts: {
  privateKey: CryptoKey;
  peerPublicKey: CryptoKey;
  authToken: string;
  transcript: Uint8Array;
  serverNonce: string;
  clientNonce: string;
  connectionId: string;
  accountId: number;
}): Promise<GameCipherKeysV2> {
  const sharedBits = new Uint8Array(await subtle().deriveBits(
    { name: 'ECDH', public: opts.peerPublicKey },
    opts.privateKey,
    256,
  ));
  const tokenHash = await sha256(encoder.encode(opts.authToken));
  const transcriptHash = await sha256(opts.transcript);
  const serverNonce = base64UrlToBytes(opts.serverNonce);
  const clientNonce = base64UrlToBytes(opts.clientNonce);
  const baseKey = await subtle().importKey(
    'raw',
    exactArrayBuffer(concatBytes(sharedBits, tokenHash, transcriptHash)),
    'HKDF',
    false,
    ['deriveKey', 'deriveBits'],
  );
  const salt = await sha256(encoder.encode('evilquest-game-v2:salt'), serverNonce, clientNonce, tokenHash);
  const deriveAes = (direction: GameCipherDirection) => subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: exactArrayBuffer(salt),
      info: exactArrayBuffer(encoder.encode(`evilquest-game-v2:${direction}:${opts.connectionId}`)),
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  const clientToServerIvHash = await sha256(encoder.encode('evilquest-game-v2:iv:client-to-server'), transcriptHash);
  const serverToClientIvHash = await sha256(encoder.encode('evilquest-game-v2:iv:server-to-client'), transcriptHash);
  return {
    clientToServerKey: await deriveAes('client-to-server'),
    serverToClientKey: await deriveAes('server-to-client'),
    clientToServerIvPrefix: clientToServerIvHash.slice(0, 4),
    serverToClientIvPrefix: serverToClientIvHash.slice(0, 4),
    clientToServerAadPrefix: frameAadPrefixV2(opts.connectionId, opts.accountId, 'client-to-server'),
    serverToClientAadPrefix: frameAadPrefixV2(opts.connectionId, opts.accountId, 'server-to-client'),
    connectionId: opts.connectionId,
    accountId: opts.accountId,
  };
}

function frameNonceV2(keys: GameCipherKeysV2, direction: GameCipherDirection, counter: number): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(direction === 'client-to-server' ? keys.clientToServerIvPrefix : keys.serverToClientIvPrefix, 0);
  new DataView(iv.buffer).setBigUint64(4, BigInt(counter));
  return iv;
}

function frameAadV2(keys: GameCipherKeysV2, direction: GameCipherDirection, counter: number): Uint8Array {
  const prefix = direction === 'client-to-server' ? keys.clientToServerAadPrefix : keys.serverToClientAadPrefix;
  const aad = new Uint8Array(prefix.byteLength + 8);
  aad.set(prefix, 0);
  new DataView(aad.buffer).setBigUint64(prefix.byteLength, BigInt(counter));
  return aad;
}

function frameAadPrefixV2(connectionId: string, accountId: number, direction: GameCipherDirection): Uint8Array {
  const connectionIdBytes = encoder.encode(connectionId);
  if (connectionIdBytes.byteLength > 0xffff) throw new RangeError('connection id too long');
  const prefix = new Uint8Array(13 + connectionIdBytes.byteLength);
  const view = new DataView(prefix.buffer);
  prefix.set([0x65, 0x71, 0x67, 0x32], 0); // "eqg2"
  view.setUint8(4, GAME_CRYPTO_VERSION);
  view.setUint32(5, accountId);
  view.setUint8(9, direction === 'client-to-server' ? 1 : 2);
  view.setUint16(10, connectionIdBytes.byteLength);
  prefix.set(connectionIdBytes, 12);
  prefix[12 + connectionIdBytes.byteLength] = 0;
  return prefix;
}

export async function encryptGamePacketV2(
  keys: GameCipherKeysV2,
  direction: GameCipherDirection,
  counter: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = direction === 'client-to-server' ? keys.clientToServerKey : keys.serverToClientKey;
  const ciphertext = new Uint8Array(await subtle().encrypt(
    {
      name: 'AES-GCM',
      iv: exactArrayBuffer(frameNonceV2(keys, direction, counter)),
      additionalData: exactArrayBuffer(frameAadV2(keys, direction, counter)),
    },
    key,
    exactArrayBuffer(plaintext),
  ));
  const frame = new Uint8Array(1 + 1 + 8 + ciphertext.length);
  frame[0] = ENCRYPTED_GAME_FRAME_V2;
  frame[1] = GAME_CRYPTO_VERSION;
  new DataView(frame.buffer).setBigUint64(2, BigInt(counter));
  frame.set(ciphertext, 10);
  return frame;
}

export async function decryptGamePacketV2(
  keys: GameCipherKeysV2,
  direction: GameCipherDirection,
  frame: ArrayBuffer,
): Promise<{ counter: number; plaintext: ArrayBuffer }> {
  if (frame.byteLength < 11) throw new RangeError('encrypted v2 frame too short');
  const view = new DataView(frame);
  if (view.getUint8(0) !== ENCRYPTED_GAME_FRAME_V2) throw new RangeError('not an encrypted v2 game frame');
  if (view.getUint8(1) !== GAME_CRYPTO_VERSION) throw new RangeError('unsupported game crypto version');
  const counter = Number(view.getBigUint64(2));
  if (!Number.isSafeInteger(counter)) throw new RangeError('encrypted v2 counter too large');
  const key = direction === 'client-to-server' ? keys.clientToServerKey : keys.serverToClientKey;
  const ciphertext = new Uint8Array(frame, 10);
  const plaintext = await subtle().decrypt(
    {
      name: 'AES-GCM',
      iv: exactArrayBuffer(frameNonceV2(keys, direction, counter)),
      additionalData: exactArrayBuffer(frameAadV2(keys, direction, counter)),
    },
    key,
    exactArrayBuffer(ciphertext),
  );
  return { counter, plaintext };
}
