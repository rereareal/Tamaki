import WebSocket from 'ws';
import type { OneBotEvent } from './types';
import { logger } from './log';

const log = logger.child('ws');

interface Pending {
  resolve: (data: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface NapCatClientOptions {
  reconnectDelayMs?: number;
  heartbeatTimeoutMs?: number;
  /** NapCat 配置的 access token，以 Authorization: Bearer 发送。 */
  token?: string;
}

/**
 * 正向 WebSocket 客户端。
 * - echo 配对 action 调用
 * - 断线 reject 所有 pending，固定 3s 重连
 * - heartbeat 90s 无消息强制 terminate 触发重连
 */
export class NapCatClient {
  private ws?: WebSocket;
  private pending = new Map<string, Pending>();
  private echoSeq = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private closedByUser = false;

  lastHeartbeat = 0;
  onEvent?: (evt: OneBotEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;

  constructor(
    private readonly url: string,
    private readonly opts: NapCatClientOptions = {},
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    this.closedByUser = false;
    const wsOptions = this.opts.token ? { headers: { Authorization: `Bearer ${this.opts.token}` } } : undefined;
    const ws = new WebSocket(this.url, wsOptions);
    this.ws = ws;

    ws.on('open', () => {
      log.debug('connected');
      this.lastHeartbeat = Date.now();
      this.startHeartbeatWatch();
      this.onOpen?.();
    });

    ws.on('message', (raw) => {
      try {
        this.handleFrame(raw.toString());
      } catch (err) {
        log.warn('bad frame', { error: (err as Error).message });
      }
    });

    ws.on('error', (err) => {
      if (!this.closedByUser) log.warn('websocket error', { error: err.message });
    });

    ws.on('close', (code) => {
      log.debug('closed', { code });
      this.stopHeartbeatWatch();
      this.rejectAll(new Error('websocket closed'));
      this.onClose?.();
      if (!this.closedByUser) this.scheduleReconnect();
    });
  }

  close(): void {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.stopHeartbeatWatch();
    this.rejectAll(new Error('websocket closed by user'));
    this.ws?.close();
  }

  /** 调用 OneBot action，按 retcode=0 判定成功。 */
  callAction<T = any>(action: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (!this.isOpen) return Promise.reject(new Error(`websocket not open (action: ${action})`));

    const echo = ++this.echoSeq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(echo));
        reject(new Error(`action timeout: ${action}`));
      }, timeoutMs);
      this.pending.set(String(echo), {
        resolve: resolve as (data: any) => void,
        reject,
        timer,
      });
      this.ws!.send(JSON.stringify({ action, params, echo }));
    });
  }

  private handleFrame(raw: string): void {
    const frame = JSON.parse(raw) as Record<string, any>;

    if (frame.echo !== undefined) {
      const key = String(frame.echo);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (frame.retcode === 0) pending.resolve(frame.data);
      else pending.reject(new Error(`action failed: retcode=${frame.retcode} ${frame.msg ?? frame.wording ?? ''}`.trim()));
      return;
    }

    if (frame.post_type === 'meta_event' && frame.meta_event_type === 'heartbeat') {
      this.lastHeartbeat = Date.now();
    }
    this.onEvent?.(frame as OneBotEvent);
  }

  private startHeartbeatWatch(): void {
    this.stopHeartbeatWatch();
    const timeout = this.opts.heartbeatTimeoutMs ?? 90_000;
    const tick = Math.min(10_000, Math.max(250, Math.floor(timeout / 3)));
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastHeartbeat > timeout) {
        log.warn('heartbeat timeout, reconnecting');
        this.ws?.terminate();
      }
    }, tick);
  }

  private stopHeartbeatWatch(): void {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = this.opts.reconnectDelayMs ?? 3_000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      log.info('reconnecting');
      this.connect();
    }, delay);
  }

  private rejectAll(err: Error): void {
    for (const [key, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(key);
    }
  }
}
