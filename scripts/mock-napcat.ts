import { WebSocketServer, WebSocket } from 'ws';

export interface RecordedAction {
  action: string;
  params: Record<string, any>;
  ts: number;
}

/**
 * 简易 NapCat / OneBot v11 正向 WS 服务端，仅用于本地自测。
 * 支持：echo 配对、get_login_info、get_msg、send_group_msg、send_private_msg、心跳、注入事件、断线。
 */
export class MockNapCat {
  private wss?: WebSocketServer;
  private clients = new Set<WebSocket>();
  private heartbeat?: NodeJS.Timeout;
  private autoHeartbeat = true;
  private known = new Map<number, number>();
  private seq = 1000;

  actions: RecordedAction[] = [];
  connectionCount = 0;
  lastSentMessageId = 0;

  constructor(
    readonly port: number,
    private readonly botQQ = 10000,
    private readonly botName = 'Tamaki',
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: this.port });
      this.wss = wss;
      wss.on('error', reject);
      wss.on('listening', () => {
        this.heartbeat = setInterval(() => this.broadcastHeartbeat(), 300);
        resolve();
      });

      wss.on('connection', (ws) => {
        this.clients.add(ws);
        this.connectionCount++;
        ws.on('close', () => this.clients.delete(ws));
        ws.on('error', () => this.clients.delete(ws));
        ws.on('message', (raw) => this.handleAction(ws, raw.toString()));
        ws.send(
          JSON.stringify({
            post_type: 'meta_event',
            meta_event_type: 'lifecycle',
            sub_type: 'connect',
            self_id: this.botQQ,
            time: Math.floor(Date.now() / 1000),
          }),
        );
      });
    });
  }

  async stop(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const ws of this.clients) ws.terminate();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
  }

  stopHeartbeat(): void {
    this.autoHeartbeat = false;
    clearInterval(this.heartbeat);
  }

  killConnections(): void {
    for (const ws of this.clients) ws.terminate();
  }

  /** 注入一条消息事件，模拟 NapCat 上报。 */
  inject(evt: {
    message_id: number;
    user_id: number;
    group_id?: number;
    message_type?: 'group' | 'private';
    message: any[];
    nickname?: string;
  }): void {
    const messageType = evt.message_type ?? (evt.group_id !== undefined ? 'group' : 'private');
    this.known.set(evt.message_id, evt.user_id);
    const frame = {
      post_type: 'message',
      message_type: messageType,
      sub_type: 'normal',
      self_id: this.botQQ,
      message_id: evt.message_id,
      user_id: evt.user_id,
      ...(evt.group_id !== undefined ? { group_id: evt.group_id } : {}),
      message: evt.message,
      raw_message: evt.message.map((s) => (s.type === 'text' ? s.data.text : `[${s.type}]`)).join(''),
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: evt.user_id, nickname: evt.nickname ?? `u${evt.user_id}` },
    };
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    }
  }

  actionsSince(index: number, action?: string): RecordedAction[] {
    return this.actions.slice(index).filter((a) => !action || a.action === action);
  }

  private handleAction(ws: WebSocket, raw: string): void {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const action = String(frame.action ?? '');
    const params = (frame.params ?? {}) as Record<string, any>;
    this.actions.push({ action, params, ts: Date.now() });

    let data: any = {};
    if (action === 'get_login_info') {
      data = { user_id: this.botQQ, nickname: this.botName };
    } else if (action === 'get_msg') {
      const id = Number(params.message_id);
      data = { message_id: id, sender: { user_id: this.known.get(id) ?? 999 } };
    } else if (action === 'send_group_msg' || action === 'send_private_msg' || action === 'send_msg') {
      this.lastSentMessageId = ++this.seq;
      // 机器人发出的消息，之后被引用时应能查到 sender 是 bot
      this.known.set(this.lastSentMessageId, this.botQQ);
      data = { message_id: this.lastSentMessageId };
    } else if (action === 'delete_msg') {
      data = {};
    }

    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo }));
  }

  private broadcastHeartbeat(): void {
    if (!this.autoHeartbeat) return;
    const frame = JSON.stringify({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      self_id: this.botQQ,
      time: Math.floor(Date.now() / 1000),
      interval: 300,
    });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
  }
}

// 直接运行：pnpm mock
if (process.argv[1]?.endsWith('mock-napcat.ts')) {
  const mock = new MockNapCat(Number(process.env.MOCK_PORT ?? 3099));
  mock.start().then(() => console.log(`[mock] listening on ${mock.port}`));
}
