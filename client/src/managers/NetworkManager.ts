import {
  GAME_WS_PATH,
  CHAT_WS_PATH,
  SERVER_PORT,
  ServerOpcode,
  ClientOpcode,
  encodePacket,
  decodePacket,
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

/** Opcodes whose payload is `[strLen (2 bytes), utf8 bytes, trailing int16s]`
 *  instead of the int16-array layout. Handled exclusively by raw handlers;
 *  the int16 dispatcher must skip them so an even-length UTF-8 payload doesn't
 *  get re-parsed and re-dispatched with garbage values. */
const STRING_PACKET_OPCODES = new Set<number>([
  ServerOpcode.MAP_CHANGE,
  ServerOpcode.DIALOGUE_OPEN,
  ServerOpcode.NPC_NAME,
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

  private closeQuietly(socket: WebSocket | null): void {
    if (!socket) return;
    this.intentionallyClosedSockets.add(socket);
    try { socket.close(); } catch {}
  }

  connect(token: string): void {
    this.socketGeneration++;
    const generation = this.socketGeneration;
    this.connected = false;
    this.closeQuietly(this.gameSocket);
    this.closeQuietly(this.chatSocket);
    this.gameSocket = null;
    this.chatSocket = null;

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
      console.log('[net] Game socket connected');
      this.connected = true;
      for (const handler of this.openHandlers) handler();
      this.openHandlers.length = 0;
    };

    gameSocket.onmessage = (event) => {
      if (generation !== this.socketGeneration || this.gameSocket !== gameSocket) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      // Raw handlers consume string-layout packets (UTF-8 payload + trailing
      // int16s — different shape from the standard binary protocol).
      for (const handler of this.rawHandlers) {
        handler(event.data);
      }
      // String-packet opcodes are handled exclusively above. Skip the int16
      // dispatch path so we never (a) throw on odd-length UTF-8 payloads or
      // (b) silently re-dispatch garbage int16s when the payload length
      // happens to be even. Real decode errors on int16 packets still throw.
      const opcode = new DataView(event.data).getUint8(0);
      if (STRING_PACKET_OPCODES.has(opcode)) return;
      const { values } = decodePacket(event.data);
      this.dispatch(opcode as ServerOpcode, values);
    };

    gameSocket.onclose = (event) => {
      if (generation !== this.socketGeneration || this.gameSocket !== gameSocket) return;
      console.log('[net] Game socket disconnected');
      this.connected = false;
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
      console.log('[net] Chat socket connected');
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

  sendMove(path: { x: number; z: number }[]): void {
    if (!this.gameSocket || !this.connected || this.gameSocket.readyState !== WebSocket.OPEN) return;

    // Encode: [opcode, pathLength, x1*10, z1*10, x2*10, z2*10, ...]
    const maxSteps = Math.min(path.length, 50); // Cap path length
    const values = [maxSteps];
    for (let i = 0; i < maxSteps; i++) {
      values.push(Math.round(path[i].x * 10));
      values.push(Math.round(path[i].z * 10));
    }
    this.gameSocket.send(encodePacket(ClientOpcode.PLAYER_MOVE, ...values) as BufferSource);
  }

  sendRaw(data: Uint8Array): void {
    if (!this.gameSocket || !this.connected || this.gameSocket.readyState !== WebSocket.OPEN) return;
    this.gameSocket.send(data as BufferSource);
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
