import { getStoredToken } from "@/lib/api";
import type { ChatQueryPayload, WsServerEvent } from "@/lib/types";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/chat";

type EventListener = (event: WsServerEvent) => void;
type ErrorListener = (error: Error) => void;

export class ChatSocketClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<EventListener>();
  private errorListeners = new Set<ErrorListener>();
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private manualClose = false;
  private openPromise: Promise<void> | null = null;

  subscribe(listener: EventListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onError(listener: ErrorListener) {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.openPromise) {
      return this.openPromise;
    }

    const token = getStoredToken();
    if (!token) {
      throw new Error("Authentication token missing");
    }

    this.manualClose = false;

    this.openPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
      this.socket = socket;

      socket.onopen = () => {
        this.reconnectAttempts = 0;
        resolve();
      };

      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as WsServerEvent;
          this.listeners.forEach((listener) => listener(payload));
        } catch {
          this.errorListeners.forEach((listener) =>
            listener(new Error("Failed to parse WebSocket message")),
          );
        }
      };

      socket.onerror = () => {
        reject(new Error("WebSocket connection failed"));
      };

      socket.onclose = () => {
        this.openPromise = null;
        this.socket = null;
        if (!this.manualClose) {
          this.scheduleReconnect();
        }
      };
    });

    return this.openPromise.finally(() => {
      this.openPromise = null;
    });
  }

  async send(payload: ChatQueryPayload) {
    await this.connect();
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }
    this.socket.send(JSON.stringify(payload));
  }

  close() {
    this.manualClose = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= 5 || typeof window === "undefined") {
      this.errorListeners.forEach((listener) =>
        listener(new Error("WebSocket disconnected and retries were exhausted")),
      );
      return;
    }

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 15000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.connect().catch((error) => {
        this.errorListeners.forEach((listener) => listener(error));
      });
    }, delay);
  }
}

export const chatSocket = new ChatSocketClient();
