/**
 * GossipAgent — WebSocket client for the Gossip Mesh relay.
 *
 * Auth: initial JSON frame (NOT URL query params — security).
 * Messages: MessagePack-encoded MessageEnvelope via Codec.
 * Reconnect: exponential backoff with configurable limits.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { Codec, Message, MessageEnvelope } from '@gossip/types';
import { encode as msgpackEncode, decode as msgpackDecode } from '@msgpack/msgpack';

// ─── WebSocket close code labels (RFC 6455) ───────────────────────────────────

const WS_CLOSE_LABELS: Record<number, string> = {
  1000: 'NORMAL',
  1001: 'GOING_AWAY',
  1002: 'PROTOCOL_ERROR',
  1003: 'UNSUPPORTED_DATA',
  1005: 'NO_STATUS',
  1006: 'ABNORMAL_CLOSE',
  1007: 'INVALID_PAYLOAD',
  1008: 'POLICY_VIOLATION',
  1009: 'MESSAGE_TOO_BIG',
  1010: 'MISSING_EXTENSION',
  1011: 'INTERNAL_ERROR',
  1012: 'SERVICE_RESTART',
  1013: 'TRY_AGAIN_LATER',
  1014: 'BAD_GATEWAY',
  1015: 'TLS_HANDSHAKE_FAIL',
};

// ─── Config ───────────────────────────────────────────────────────────────────

export interface GossipAgentConfig {
  agentId: string;
  relayUrl: string;
  apiKey?: string;
  reconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectBaseDelay?: number;
  keepAliveInterval?: number;
}

// ─── GossipAgent ─────────────────────────────────────────────────────────────

export class GossipAgent extends EventEmitter {
  private ws: WebSocket | null = null;
  private codec = new Codec();
  private config: Required<GossipAgentConfig>;
  private seq = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private _connected = false;
  private _sessionId: string | null = null;
  private intentionalDisconnect = false;
  private subscribedChannels: Set<string> = new Set();

  constructor(config: GossipAgentConfig) {
    super();
    this.config = {
      agentId: config.agentId,
      relayUrl: config.relayUrl,
      apiKey: config.apiKey ?? '',
      reconnect: config.reconnect ?? true,
      maxReconnectAttempts: config.maxReconnectAttempts ?? 10,
      reconnectBaseDelay: config.reconnectBaseDelay ?? 1000,
      keepAliveInterval: config.keepAliveInterval ?? 30000,
    };
  }

  get agentId(): string { return this.config.agentId; }
  get sessionId(): string | null { return this._sessionId; }
  isConnected(): boolean {
    return this._connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.relayUrl);

      const timeout = setTimeout(() => {
        ws.removeAllListeners();
        ws.on('error', () => { /* swallow */ });
        ws.close();
        reject(new Error('Connection timeout'));
      }, 10000);

      ws.once('open', () => {
        // Send auth frame
        ws.send(JSON.stringify({ type: 'auth', agentId: this.config.agentId, apiKey: this.config.apiKey || 'default' }));
      });

      ws.once('error', (err: Error) => {
        clearTimeout(timeout);
        ws.removeAllListeners();
        reject(err);
      });

      ws.on('message', (data: WebSocket.RawData) => {
        // Auth handshake — first message is JSON
        if (!this._connected) {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'auth_ok') {
              clearTimeout(timeout);
              this.ws = ws;
              this._connected = true;
              this._sessionId = msg.sessionId;
              this.reconnectAttempts = 0;

              // Swap to binary message handler
              ws.removeAllListeners('message');
              ws.on('message', (d: WebSocket.RawData) => this.handleMessage(d));
              ws.on('close', (code: number, reason: Buffer) => this.handleClose(code, reason));

              this.startKeepAlive();
              this.emit('connect', msg.sessionId);
              resolve();
            } else if (msg.type === 'error') {
              clearTimeout(timeout);
              ws.removeAllListeners();
              ws.close();
              reject(new Error(msg.message ?? 'Auth error'));
            }
          } catch (e) {
            clearTimeout(timeout);
            ws.removeAllListeners();
            ws.close();
            reject(e);
          }
          return;
        }
        this.handleMessage(data);
      });
    });
  }

  async disconnect(): Promise<void> {
    this.stopKeepAlive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (!this.ws) return;

    return new Promise((resolve) => {
      this.intentionalDisconnect = true;
      this._connected = false;
      const ws = this.ws!;
      this.ws = null;

      let settled = false;
      const done = (code = 1000) => {
        if (settled) return;
        settled = true;
        this.intentionalDisconnect = false;
        this.emit('disconnect', code);
        resolve();
      };

      const timer = setTimeout(() => done(1000), 2000);
      ws.once('close', (code: number) => { clearTimeout(timer); done(code); });
      ws.removeAllListeners('message');
      ws.close(1000);
    });
  }

  async sendDirect(to: string, data: Record<string, unknown>): Promise<void> {
    const body = Buffer.from(msgpackEncode(data)) as unknown as Uint8Array;
    const msg = Message.createDirect(this.config.agentId, to, body, { seq: this.seq++ });
    await this.sendEnvelope(msg.envelope);
  }

  async sendChannel(channel: string, data: Record<string, unknown>): Promise<void> {
    const ch = channel.replace(/^#/, '');
    const body = Buffer.from(msgpackEncode(data)) as unknown as Uint8Array;
    const msg = Message.createChannel(this.config.agentId, ch, body, { seq: this.seq++ });
    await this.sendEnvelope(msg.envelope);
  }

  async subscribe(channel: string): Promise<void> {
    const ch = channel.replace(/^#/, '');
    this.subscribedChannels.add(ch);
    const msg = Message.createSubscription(this.config.agentId, ch, undefined, { seq: this.seq++ });
    await this.sendEnvelope(msg.envelope);
  }

  async unsubscribe(channel: string): Promise<void> {
    const ch = channel.replace(/^#/, '');
    this.subscribedChannels.delete(ch);
    const msg = Message.createUnsubscription(this.config.agentId, ch, { seq: this.seq++ });
    await this.sendEnvelope(msg.envelope);
  }

  async sendEnvelope(envelope: MessageEnvelope): Promise<void> {
    if (!this.isConnected()) {
      throw new Error('Not connected to relay');
    }
    const encoded = Buffer.from(this.codec.encode(envelope));
    return new Promise((resolve, reject) => {
      this.ws!.send(encoded, (err) => err ? reject(err) : resolve());
    });
  }

  // ─── Internal ────────────────────────────────────────────────────────────────

  private handleMessage(data: WebSocket.RawData): void {
    try {
      const buf = data instanceof Buffer ? data : Buffer.from(data as ArrayBuffer);
      const envelope = this.codec.decode(buf);
      let body: unknown = null;
      if (envelope.body && envelope.body.length > 0) {
        body = msgpackDecode(envelope.body);
      }
      this.emit('message', body, envelope);
    } catch (err) {
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      } else {
        console.warn('[GossipAgent] Message decode error:', (err as Error).message);
      }
    }
  }

  private handleClose(code: number, reason: Buffer): void {
    this.stopKeepAlive();
    this._connected = false;
    this.ws = null;
    const label = WS_CLOSE_LABELS[code] ?? 'UNKNOWN';
    console.log(`[GossipAgent] Closed: ${label} (${code}) ${reason?.toString() || ''}`);
    if (!this.intentionalDisconnect) {
      this.emit('disconnect', code);
      this.attemptReconnect();
    }
  }

  private attemptReconnect(): void {
    if (!this.config.reconnect || this.intentionalDisconnect) return;
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.warn(`[GossipAgent] Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`);
      return;
    }

    const delay = Math.min(
      this.config.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts),
      30000
    );
    this.reconnectAttempts++;
    console.log(`[GossipAgent] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      if (this.intentionalDisconnect) return;
      try {
        await this.connect();
        console.log('[GossipAgent] Reconnected');
        // Re-subscribe to all channels after reconnection
        for (const ch of this.subscribedChannels) {
          const msg = Message.createSubscription(this.config.agentId, ch, undefined, { seq: this.seq++ });
          await this.sendEnvelope(msg.envelope).catch(() => {});
        }
      } catch (err) {
        console.warn(`[GossipAgent] Reconnect attempt ${this.reconnectAttempts} failed:`, (err as Error).message);
        this.attemptReconnect();
      }
    }, delay);
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this.isConnected()) return;
      const ping = Message.createPing(this.config.agentId, this.config.agentId, { seq: this.seq++ });
      this.sendEnvelope(ping.envelope).catch(() => { /* ignore */ });
    }, this.config.keepAliveInterval);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  toString(): string { return `GossipAgent(${this.config.agentId})`; }
  toJSON(): Record<string, unknown> {
    return { agentId: this.config.agentId, connected: this.isConnected() };
  }
}
