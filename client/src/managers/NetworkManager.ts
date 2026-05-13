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

export class NetworkManager {
  private gameSocket: WebSocket | null = null;
  private chatSocket: WebSocket | null = null;
  private handlers: Map<ServerOpcode, MessageHandler[]> = new Map();
  private chatHandlers: ChatHandler[] = [];
  private rawHandlers: RawMessageHandler[] = [];
  private connected: boolean = false;
  private localPlayerId: number = -1;

  private disconnectHandler: (() => void) | null = null;

  connect(token: string): void {
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Vite's WS proxy doesn't reliably upgrade on Windows — connect directly to the server in dev.
    const wsOrigin = import.meta.env.DEV
      ? `${wsProtocol}//localhost:${SERVER_PORT}`
      : `${wsProtocol}//${location.host}`;

    // Game socket (binary) — pass auth token via Sec-WebSocket-Protocol so it
    // doesn't appear in reverse-proxy access logs the way `?token=` would. The
    // server matches `auth.<token>` from the offered protocols and echoes it
    // back to complete the handshake.
    this.gameSocket = new WebSocket(`${wsOrigin}${GAME_WS_PATH}`, [`auth.${token}`]);
    this.gameSocket.binaryType = 'arraybuffer';

    this.gameSocket.onopen = () => {
      console.log('[net] Game socket connected');
      this.connected = true;
    };

    this.gameSocket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Fire raw handlers first (for string packets like MAP_CHANGE)
        for (const handler of this.rawHandlers) {
          handler(event.data);
        }
        const { opcode, values } = decodePacket(event.data);
        this.dispatch(opcode as ServerOpcode, values);
      }
    };

    this.gameSocket.onclose = () => {
      console.log('[net] Game socket disconnected');
      this.connected = false;
      this.disconnectHandler?.();
    };

    // Chat socket (JSON) — same subprotocol auth scheme as the game socket.
    this.chatSocket = new WebSocket(`${wsOrigin}${CHAT_WS_PATH}`, [`auth.${token}`]);

    this.chatSocket.onopen = () => {
      console.log('[net] Chat socket connected');
    };

    this.chatSocket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        for (const handler of this.chatHandlers) {
          handler(data);
        }
      } catch { /* ignore */ }
    };
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandler = handler;
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
    if (!this.gameSocket || !this.connected) return;

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
    if (!this.gameSocket || !this.connected) return;
    this.gameSocket.send(data as BufferSource);
  }

  sendChat(message: string): void {
    if (!this.chatSocket) return;
    this.chatSocket.send(JSON.stringify({ type: 'local', message }));
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Close both sockets cleanly. Used for protocol-version mismatch and
   *  other unrecoverable session-level errors that should drop the player
   *  back to the login screen. */
  close(): void {
    try { this.gameSocket?.close(); } catch {}
    try { this.chatSocket?.close(); } catch {}
    this.gameSocket = null;
    this.chatSocket = null;
    this.connected = false;
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
