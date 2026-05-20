import {
  GAME_WS_PATH,
  CHAT_WS_PATH,
  SERVER_PORT,
  ServerOpcode,
  ClientOpcode,
  encodePacket,
  decodePacket,
  ENCRYPTED_GAME_FRAME,
  deriveGameCipherKey,
  decryptGamePacket,
  encryptGamePacket,
  nonceWordsToBytes,
} from '@projectrs/shared';

export interface PlayerSyncData {
  id: number;
  x: number;
  z: number;
  health: number;
  maxHealth: number;
}

export type MessageHandler = (opcode: ServerOpcode, values: number[]) => void;
export type ChatMessage =
  | { type: 'chat'; from?: string; to?: string; message: string }
  | { type: 'system'; message: string }
  | { type: 'player_info'; entityId: number; name: string; message: string }
  | { type: string; from?: string; to?: string; message: string; entityId?: number; name?: string };
export type ChatHandler = (data: ChatMessage) => void;
export type RawMessageHandler = (data: ArrayBuffer) => void;
export type DisconnectHandler = (event: CloseEvent) => void;

const GAME_HEARTBEAT_INTERVAL_MS = 5_000;
const GAME_HEARTBEAT_TIMEOUT_MS = 60_000;

/** Opcodes whose payload is `[strLen (2 bytes), utf8 bytes, trailing int16s]`
 *  instead of the int16-array layout. Handled exclusively by raw handlers;
 *  the int16 dispatcher must skip them so an even-length UTF-8 payload doesn't
 *  get re-parsed and re-dispatched with garbage values. */
const STRING_PACKET_OPCODES = new Set<number>([
  ServerOpcode.MAP_CHANGE,
  ServerOpcode.DIALOGUE_OPEN,
  ServerOpcode.NPC_NAME,
  ServerOpcode.NPC_ATTACK_ANIM,
  ServerOpcode.QUEST_STATE_SYNC,
  ServerOpcode.QUEST_STAGE_ADVANCED,
]);

export class NetworkManager {
  private gameSocket: WebSocket | null = null;
  private chatSocket: WebSocket | null = null;
  private handlers: Map<ServerOpcode, MessageHandler[]> = new Map();
  private chatHandlers: ChatHandler[] = [];
  private rawHandlers: RawMessageHandler[] = [];
  private connected: boolean = false;
  private localPlayerId: number = -1;

  private disconnectHandler: DisconnectHandler | null = null;
  private openHandlers: (() => void)[] = [];
  private socketGeneration: number = 0;
  private intentionallyClosedSockets = new WeakSet<WebSocket>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastGameMessageAt: number = 0;
  private heartbeatSeq: number = 0;
  private authToken: string = '';
  private gameCipherKey: CryptoKey | null = null;
  private gameCipherNonce: Uint8Array | null = null;
  private sendCipherCounter: number = 0;
  private lastRecvCipherCounter: number = -1;
  private sendCipherQueue: Promise<void> = Promise.resolve();
  private recvCipherQueue: Promise<void> = Promise.resolve();

  private closeQuietly(socket: WebSocket | null): void {
    if (!socket) return;
    this.intentionallyClosedSockets.add(socket);
    try { socket.close(); } catch {}
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private markGameMessageReceived(): void {
    this.lastGameMessageAt = performance.now();
  }

  private startHeartbeat(socket: WebSocket, generation: number): void {
    this.stopHeartbeat();
    this.lastGameMessageAt = performance.now();
    this.heartbeatTimer = setInterval(() => {
      if (generation !== this.socketGeneration || this.gameSocket !== socket) return;
      if (socket.readyState !== WebSocket.OPEN) return;

      const now = performance.now();
      if (now - this.lastGameMessageAt > GAME_HEARTBEAT_TIMEOUT_MS) {
        console.warn('[net] Game socket heartbeat timed out');
        this.failGameSocket(socket, 4000, 'heartbeat timeout');
        return;
      }

      this.heartbeatSeq = (this.heartbeatSeq + 1) & 0x7fff;
      try {
        void this.sendFrame(socket, encodePacket(ClientOpcode.CLIENT_PING, this.heartbeatSeq));
      } catch {
        this.failGameSocket(socket, 4001, 'send failed');
      }
    }, GAME_HEARTBEAT_INTERVAL_MS);
  }

  private failGameSocket(socket: WebSocket | null, code: number, reason: string): void {
    if (socket && this.gameSocket !== socket) return;
    this.stopHeartbeat();
    this.socketGeneration++;
    this.connected = false;
    if (socket && this.gameSocket === socket) this.gameSocket = null;
    try { socket?.close(code, reason); } catch {}
    this.disconnectHandler?.(new CloseEvent('close', {
      code,
      reason,
      wasClean: false,
    }));
  }

  connect(token: string): void {
    this.socketGeneration++;
    const generation = this.socketGeneration;
    this.connected = false;
    this.stopHeartbeat();
    this.closeQuietly(this.gameSocket);
    this.closeQuietly(this.chatSocket);
    this.gameSocket = null;
    this.chatSocket = null;
    this.authToken = token;
    this.gameCipherKey = null;
    this.gameCipherNonce = null;
    this.sendCipherCounter = 0;
    this.lastRecvCipherCounter = -1;
    this.sendCipherQueue = Promise.resolve();
    this.recvCipherQueue = Promise.resolve();

    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Vite's WS proxy doesn't reliably upgrade on Windows — connect directly to the server in dev.
    const wsOrigin = import.meta.env.DEV
      ? `${wsProtocol}//localhost:${SERVER_PORT}`
      : `${wsProtocol}//${location.host}`;

    // Game socket (binary) — pass auth token via Sec-WebSocket-Protocol so it
    // doesn't appear in reverse-proxy access logs the way `?token=` would. The
    // server matches `auth.<token>` from the offered protocols and echoes it
    // back to complete the handshake.
    const gameSocket = new WebSocket(`${wsOrigin}${GAME_WS_PATH}`, [`auth.${token}`]);
    this.gameSocket = gameSocket;
    gameSocket.binaryType = 'arraybuffer';

    gameSocket.onopen = () => {
      if (generation !== this.socketGeneration || this.gameSocket !== gameSocket) return;
      if (import.meta.env.DEV) console.log('[net] Game socket connected');
      this.connected = true;
      this.startHeartbeat(gameSocket, generation);
      for (const handler of this.openHandlers) handler();
      this.openHandlers.length = 0;
    };

    gameSocket.onmessage = (event) => {
      if (generation !== this.socketGeneration || this.gameSocket !== gameSocket) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      this.markGameMessageReceived();
      this.recvCipherQueue = this.recvCipherQueue
        .then(() => this.handleGameMessage(gameSocket, generation, event.data))
        .catch((e) => {
          console.warn('[net] Failed to process game packet:', e);
          this.failGameSocket(gameSocket, 4006, 'packet decrypt failed');
        });
    };

    const handlePlainMessage = (data: ArrayBuffer) => {
      // Raw handlers consume string-layout packets (UTF-8 payload + trailing
      // int16s — different shape from the standard binary protocol).
      for (const handler of this.rawHandlers) {
        handler(data);
      }
      // String-packet opcodes are handled exclusively above. Skip the int16
      // dispatch path so we never (a) throw on odd-length UTF-8 payloads or
      // (b) silently re-dispatch garbage int16s when the payload length
      // happens to be even. Real decode errors on int16 packets still throw.
      const opcode = new DataView(data).getUint8(0);
      if (STRING_PACKET_OPCODES.has(opcode)) return;
      const { values } = decodePacket(data);
      this.dispatch(opcode as ServerOpcode, values);
    };

    this.handlePlainGameMessage = handlePlainMessage;

    gameSocket.onclose = (event) => {
      if (generation !== this.socketGeneration || this.gameSocket !== gameSocket) return;
      if (import.meta.env.DEV) console.log('[net] Game socket disconnected');
      this.connected = false;
      this.stopHeartbeat();
      this.gameSocket = null;
      if (!this.intentionallyClosedSockets.has(gameSocket)) {
        this.disconnectHandler?.(event);
      }
    };

    // Chat socket (JSON) — same subprotocol auth scheme as the game socket.
    const chatSocket = new WebSocket(`${wsOrigin}${CHAT_WS_PATH}`, [`auth.${token}`]);
    this.chatSocket = chatSocket;

    chatSocket.onopen = () => {
      if (generation !== this.socketGeneration || this.chatSocket !== chatSocket) return;
      if (import.meta.env.DEV) console.log('[net] Chat socket connected');
      if (this.localPlayerId >= 0) {
        chatSocket.send(JSON.stringify({ type: 'identify', playerId: this.localPlayerId }));
      }
    };

    chatSocket.onmessage = (event) => {
      if (generation !== this.socketGeneration || this.chatSocket !== chatSocket) return;
      try {
        const data = JSON.parse(event.data);
        for (const handler of this.chatHandlers) {
          handler(data);
        }
      } catch { /* ignore */ }
    };

    chatSocket.onclose = () => {
      if (generation !== this.socketGeneration || this.chatSocket !== chatSocket) return;
      this.chatSocket = null;
    };
  }

  private handlePlainGameMessage: ((data: ArrayBuffer) => void) | null = null;

  private async handleGameMessage(socket: WebSocket, generation: number, data: ArrayBuffer): Promise<void> {
    if (generation !== this.socketGeneration || this.gameSocket !== socket) return;
    let plain = data;
    if (new DataView(data).getUint8(0) === ENCRYPTED_GAME_FRAME) {
      if (!this.gameCipherKey || !this.gameCipherNonce) throw new Error('encrypted frame before session key');
      const decrypted = await decryptGamePacket(this.gameCipherKey, this.gameCipherNonce, 'server-to-client', data);
      if (decrypted.counter <= this.lastRecvCipherCounter) throw new Error('replayed encrypted frame');
      this.lastRecvCipherCounter = decrypted.counter;
      plain = decrypted.plaintext;
    }

    const opcode = new DataView(plain).getUint8(0);
    if (opcode === ServerOpcode.LOGIN_OK) {
      const { values } = decodePacket(plain);
      if (values.length >= 9 && !this.gameCipherKey) {
        this.gameCipherNonce = nonceWordsToBytes(values.slice(5, 9));
        this.gameCipherKey = await deriveGameCipherKey(this.authToken, this.gameCipherNonce);
      }
    }

    this.handlePlainGameMessage?.(plain);
  }

  private sendFrame(socket: WebSocket, packet: Uint8Array): Promise<void> {
    this.sendCipherQueue = this.sendCipherQueue.then(async () => {
      if (this.gameSocket !== socket || socket.readyState !== WebSocket.OPEN) return;
      const frame = this.gameCipherKey && this.gameCipherNonce
        ? await encryptGamePacket(this.gameCipherKey, this.gameCipherNonce, 'client-to-server', this.sendCipherCounter++, packet)
        : packet;
      socket.send(frame as BufferSource);
    }).catch((e) => {
      console.warn('[net] Failed to send encrypted game packet:', e);
      this.failGameSocket(socket, 4007, 'packet encrypt failed');
    });
    return this.sendCipherQueue;
  }

  onDisconnect(handler: DisconnectHandler): void {
    this.disconnectHandler = handler;
  }

  /** Register a one-shot handler that runs the next time the game socket
   *  finishes opening. If the socket is already open, the handler fires
   *  on the next microtask so behavior is consistent regardless of timing. */
  onOpen(handler: () => void): void {
    if (this.connected) {
      Promise.resolve().then(handler);
    } else {
      this.openHandlers.push(handler);
    }
  }

  on(opcode: ServerOpcode, handler: MessageHandler): void {
    if (!this.handlers.has(opcode)) {
      this.handlers.set(opcode, []);
    }
    this.handlers.get(opcode)!.push(handler);
  }

  onChat(handler: ChatHandler): void {
    this.chatHandlers.push(handler);
  }

  onRawMessage(handler: RawMessageHandler): void {
    this.rawHandlers.push(handler);
  }

  private dispatch(opcode: ServerOpcode, values: number[]): void {
    const handlers = this.handlers.get(opcode);
    if (handlers) {
      for (const handler of handlers) {
        handler(opcode, values);
      }
    }
  }

  sendMove(path: { x: number; z: number }[]): boolean {
    if (!this.gameSocket) return false;
    if (!this.connected || this.gameSocket.readyState !== WebSocket.OPEN) {
      this.failGameSocket(this.gameSocket, 4002, 'move send while disconnected');
      return false;
    }

    // Encode: [opcode, pathLength, x1*10, z1*10, x2*10, z2*10, ...]
    const maxSteps = Math.min(path.length, 50); // Cap path length
    const values = [maxSteps];
    for (let i = 0; i < maxSteps; i++) {
      values.push(Math.round(path[i].x * 10));
      values.push(Math.round(path[i].z * 10));
    }
    try {
      void this.sendFrame(this.gameSocket, encodePacket(ClientOpcode.PLAYER_MOVE, ...values));
      return true;
    } catch {
      this.failGameSocket(this.gameSocket, 4003, 'move send failed');
      return false;
    }
  }

  sendRaw(data: Uint8Array): boolean {
    if (!this.gameSocket) return false;
    if (!this.connected || this.gameSocket.readyState !== WebSocket.OPEN) {
      this.failGameSocket(this.gameSocket, 4004, 'packet send while disconnected');
      return false;
    }
    try {
      void this.sendFrame(this.gameSocket, data);
      return true;
    } catch {
      this.failGameSocket(this.gameSocket, 4005, 'packet send failed');
      return false;
    }
  }

  sendChat(message: string): void {
    if (!this.chatSocket || this.chatSocket.readyState !== WebSocket.OPEN) return;
    this.chatSocket.send(JSON.stringify({ type: 'local', message }));
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Close both sockets cleanly. Used for protocol-version mismatch and
   *  other unrecoverable session-level errors that should drop the player
   *  back to the login screen. */
  close(): void {
    this.socketGeneration++;
    this.stopHeartbeat();
    this.closeQuietly(this.gameSocket);
    this.closeQuietly(this.chatSocket);
    this.gameSocket = null;
    this.chatSocket = null;
    this.connected = false;
    this.openHandlers.length = 0;
  }

  getLocalPlayerId(): number {
    return this.localPlayerId;
  }

  setLocalPlayerId(id: number): void {
    this.localPlayerId = id;
    // Identify on chat socket
    if (this.chatSocket?.readyState === WebSocket.OPEN) {
      this.chatSocket.send(JSON.stringify({ type: 'identify', playerId: id }));
    }
  }
}
