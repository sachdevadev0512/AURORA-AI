import io, { Socket } from 'socket.io-client';
import { getSocketAuthToken, getSocketClientOptions } from '../utils/socketAuth';

type EventHandler = (...args: unknown[]) => void;

class AuroraSocketClient {
  private socket: Socket | null = null;
  private userId: string | null = null;
  /** Persist handlers across disconnect/reconnect so listeners stay active. */
  private handlers = new Map<string, Map<EventHandler, EventHandler>>();

  private bindStoredHandlers() {
    if (!this.socket) return;
    for (const [event, handlerMap] of this.handlers) {
      for (const wrapper of handlerMap.values()) {
        this.socket.on(event, wrapper);
      }
    }
  }

  connect(userId: string) {
    const nextUserId = String(userId);
    const socketUrl = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';
    const token = getSocketAuthToken();

    if (!token) return;

    if (this.socket && this.userId !== nextUserId) {
      this.socket.disconnect();
      this.socket = null;
    }

    this.userId = nextUserId;

    if (!this.socket) {
      this.socket = io(socketUrl, {
        ...getSocketClientOptions(),
        autoConnect: true,
      });

      this.socket.on('connect', () => {
        if (this.userId) {
          this.socket?.emit('joinUser', this.userId);
        }
      });

      this.socket.io.on('reconnect', () => {
        if (this.userId) {
          this.socket?.emit('joinUser', this.userId);
        }
      });

      this.bindStoredHandlers();
    } else {
      this.socket.auth = { token };
      if (!this.socket.connected) {
        this.socket.connect();
      } else {
        this.socket.emit('joinUser', nextUserId);
      }
    }
  }

  on(event: string, handler: EventHandler) {
    const wrapper: EventHandler = (...args) => handler(...args);
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Map());
    }
    this.handlers.get(event)!.set(handler, wrapper);
    this.socket?.on(event, wrapper);

    return () => {
      this.socket?.off(event, wrapper);
      this.handlers.get(event)?.delete(handler);
    };
  }

  disconnect() {
    if (this.socket) {
      if (this.userId) {
        this.socket.emit('leaveUser', this.userId);
      }
      this.socket.disconnect();
    }
    this.socket = null;
    this.userId = null;
    this.handlers.clear();
  }

  get connected() {
    return this.socket?.connected ?? false;
  }
}

export const auroraSocket = new AuroraSocketClient();
