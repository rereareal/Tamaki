import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { config } from './config';
import { openDb } from './store/db';
import { MessageStore, scopeOf } from './store/messages';
import { MemoryStore } from './store/memory';
import { Guard, OutboundQueue } from './guard';
import { NapCatClient } from './ws';
import { createLLMFromConfig } from './llm';
import { Summarizer } from './memory/summarizer';
import { registerBuiltinTools } from './tools/builtin';
import { handleMessage, type HandlerDeps } from './handler';
import type { MessageEvent, MessageSegment } from './types';

const DEFAULT_PERSONA = `你是 Tamaki，一个待在群里的 AI 群友。
说话简短、自然、有分寸，像普通群友而不是客服；不主动说教，不刷屏。
不确定的事就说不确定，不编造群友的信息。`;

function loadPersona(): string {
  try {
    if (existsSync(config.personaPath)) return readFileSync(config.personaPath, 'utf8');
  } catch {
    /* ignore */
  }
  return DEFAULT_PERSONA;
}

export interface Tamaki {
  client: NapCatClient;
  store: MessageStore;
  memory: MemoryStore;
  guard: Guard;
  summarizer: Summarizer;
  stop: () => void;
}

export interface StartOptions {
  callLLM?: import('./tools/runner').LLMCall;
  onReady?: () => void;
}

export function start(opts: StartOptions = {}): Tamaki {
  registerBuiltinTools();

  const db = openDb(config.dbPath);
  const store = new MessageStore(db, config.timeZone, config.summaryHour);
  const memory = new MemoryStore(db, {
    memoryDir: config.memoryDir,
    impressionsDir: config.impressionsDir,
  });

  const guard = new Guard({
    adminQQ: config.adminQQ,
    allowedGroups: config.allowedGroups,
    dedupWindowMs: config.dedupWindowMs,
    rateLimitWindowMs: config.rateLimitWindowMs,
    rateLimitMax: config.rateLimitMax,
  });

  const queue = new OutboundQueue();
  const client = new NapCatClient(config.wsUrl, {
    reconnectDelayMs: config.reconnectDelayMs,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    token: config.wsToken,
  });
  const callLLM = opts.callLLM ?? createLLMFromConfig(config.llm);
  const summarizer = new Summarizer(store, memory, callLLM, {
    timeZone: config.timeZone,
    hour: config.summaryHour,
    threshold: config.summaryThreshold,
  });

  const persona = loadPersona();
  let botName = config.botName;

  const reply: HandlerDeps['reply'] = async (evt: MessageEvent, segments: MessageSegment[]) => {
    await queue.push(segments, async () => {
      const action = evt.message_type === 'group' ? 'send_group_msg' : 'send_private_msg';
      const params =
        evt.message_type === 'group'
          ? { group_id: evt.group_id, message: segments }
          : { user_id: evt.user_id, message: segments };

      const data = await client.callAction<{ message_id?: number }>(action, params);
      store.saveOutbound({
        messageId: data?.message_id,
        selfId: config.botQQ,
        messageType: evt.message_type,
        groupId: evt.group_id,
        // 私聊用对方 QQ，保证私聊上下文按 user_id 过滤时能带上 bot 的回复
        userId: evt.message_type === 'group' ? config.botQQ : evt.user_id,
        nickname: botName || 'bot',
        segments,
      });
    });
  };

  const deps: HandlerDeps = {
    client,
    store,
    memory,
    callLLM,
    reply,
    adminQQ: config.adminQQ,
    botQQ: config.botQQ,
    getBotName: () => botName,
    getPersona: () => persona,
    timeZone: config.timeZone,
  };

  client.onOpen = async () => {
    try {
      const info = await client.callAction<{ user_id?: number; nickname?: string }>('get_login_info', {}, 5_000);
      if (info?.nickname) botName = info.nickname;
      console.log(`[bot] online as ${botName || info?.nickname || config.botQQ}`);
    } catch (err) {
      console.log(`[bot] online (get_login_info failed: ${(err as Error).message})`);
    }
    opts.onReady?.();
  };

  client.onClose = () => console.log('[ws] disconnected');

  client.onEvent = (raw) => {
    if (raw.post_type !== 'message') return;
    const evt = raw as MessageEvent;

    if (!guard.checkSelf(evt, config.botQQ)) return;
    if (!guard.checkWhitelist(evt)) return;
    if (!guard.checkDedup(evt)) return;
    if (!guard.checkRateLimit(evt)) return;

    store.saveMessage(evt);
    const scope = scopeOf(evt);

    void handleMessage(evt, deps)
      .catch((err) => console.error('[handler]', (err as Error).message))
      .finally(() => {
        void summarizer.maybeByThreshold(scope).catch((err) => console.error('[summary]', (err as Error).message));
      });
  };

  const stopScheduler = summarizer.startScheduler();
  client.connect();

  return {
    client,
    store,
    memory,
    guard,
    summarizer,
    stop: () => {
      stopScheduler();
      client.close();
      db.close();
    },
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const app = start();
  const shutdown = () => {
    console.log('\n[bot] shutting down...');
    app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
