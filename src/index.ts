import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { config } from './config';
import { openDb } from './store/db';
import { MessageStore, closeStaleSessions, scopeOf, startSession } from './store/messages';
import { MemoryStore } from './store/memory';
import { ImpressionStore } from './store/impressions';
import { Guard, OutboundQueue } from './guard';
import { NapCatClient } from './ws';
import { createLLMFromConfig } from './llm';
import { Summarizer } from './memory/summarizer';
import { registerBuiltinTools } from './tools/builtin';
import { handleMessage, type HandlerDeps } from './handler';
import {
  loadCharacterRegistry,
  loadCorpusRegistry,
  readActiveCharacterId,
  resolveCharacter,
  type CharacterRuntime,
} from './character/loader';
import { openCorpusLibrary } from './character/corpus';
import type { MessageEvent, MessageSegment } from './types';
import { configureLogger, logger } from './log';
import { ProactiveGate } from './proactive';

const log = logger.child('app');

export interface Tamaki {
  client: NapCatClient;
  store: MessageStore;
  memory: MemoryStore;
  impressions: ImpressionStore;
  guard: Guard;
  summarizer: Summarizer;
  character: CharacterRuntime;
  stop: () => void;
}

export interface StartOptions {
  callLLM?: import('./tools/runner').LLMCall;
  onReady?: () => void;
}

export function start(opts: StartOptions = {}): Tamaki {
  configureLogger({
    level: config.logLevel,
    dir: config.logDir,
    toFile: config.logToFile,
    retentionDays: config.logRetentionDays,
    timeZone: config.timeZone,
  });
  log.info('starting', {
    botQQ: config.botQQ,
    charactersDir: config.charactersDir,
    corporaDir: config.corporaDir,
    activeCharacterFile: config.activeCharacterFile,
    dbPath: config.dbPath,
    logDir: config.logDir,
  });

  registerBuiltinTools();

  const db = openDb(config.dbPath);
  // 上次进程崩溃时留下的 open session，按最后心跳收尾。
  closeStaleSessions(db);

  const registry = loadCharacterRegistry(config.charactersDir);
  const corpora = loadCorpusRegistry(config.corporaDir);
  const activeId = readActiveCharacterId(config.activeCharacterFile);
  const resolved = resolveCharacter(registry, activeId, config.botName);
  const definition = resolved.character;

  if (resolved.fallback) {
    log.warn('character fallback', { reason: resolved.reason, characterId: definition.id });
  } else {
    log.info('character active', { characterId: definition.id, displayName: definition.displayName });
  }

  const sessionId = startSession(db, definition.id);
  log.info('session started', { characterId: definition.id, sessionId });
  const runtimeDir = resolve(config.runtimeDir, definition.id);
  const memoryDir = resolve(runtimeDir, 'memory');
  const impressionsDir = resolve(runtimeDir, 'impressions');

  const store = new MessageStore(db, config.timeZone, config.summaryHour, definition.id, sessionId);
  const memory = new MemoryStore(db, memoryDir, definition.id);
  const impressions = new ImpressionStore(impressionsDir);
  const corpus = openCorpusLibrary(definition.corpora, corpora, definition.meta.relations ?? {});

  if (!corpus) {
    log.warn('no usable corpus binding; search_lines disabled', { characterId: definition.id });
  } else {
    const stats = corpus.stats();
    log.info('corpus ready', {
      corpora: corpus.corpusIds,
      lines: stats.lines,
      translated: stats.translated,
      curated: stats.curated,
    });
  }

  const proactive = new ProactiveGate(config.proactive);
  log.info('proactive config', {
    enabled: proactive.enabled,
    chance: config.proactive.chance,
    idleMs: config.proactive.idleMs,
    cooldownMs: config.proactive.cooldownMs,
    maxPerHour: config.proactive.maxPerHour,
    groups: config.proactive.groups,
  });

  const character: CharacterRuntime = {
    ...definition,
    corpus,
    memory,
    impressions,
    sessionId,
    runtimeDir,
    memoryDir,
  };

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
    characterName: definition.displayName,
  });

  let botName = config.botName;

  const reply: HandlerDeps['reply'] = async (evt: MessageEvent, segments: MessageSegment[]) => {
    log.debug('reply queued', {
      messageType: evt.message_type,
      groupId: evt.group_id,
      userId: evt.user_id,
      segments: segments.map((seg) => seg.type),
    });
    await queue.push(segments, async () => {
      const action = evt.message_type === 'group' ? 'send_group_msg' : 'send_private_msg';
      const params =
        evt.message_type === 'group'
          ? { group_id: evt.group_id, message: segments }
          : { user_id: evt.user_id, message: segments };

      const data = await client.callAction<{ message_id?: number }>(action, params);
      log.debug('reply sent', { messageId: data?.message_id, messageType: evt.message_type });
      if (evt.group_id !== undefined) proactive.noteBotMessage(evt.group_id);
      store.saveOutbound({
        messageId: data?.message_id,
        selfId: config.botQQ,
        messageType: evt.message_type,
        groupId: evt.group_id,
        // 私聊用对方 QQ，保证私聊上下文按 user_id 过滤时能带上 bot 的回复
        userId: evt.message_type === 'group' ? config.botQQ : evt.user_id,
        nickname: botName || definition.displayName,
        segments,
      });
    });
  };

  const deps: HandlerDeps = {
    client,
    store,
    memory,
    impressions,
    callLLM,
    reply,
    adminQQ: config.adminQQ,
    botQQ: config.botQQ,
    getBotName: () => botName,
    character,
    proactive,
    timeZone: config.timeZone,
  };

  client.onOpen = async () => {
    try {
      const info = await client.callAction<{ user_id?: number; nickname?: string }>('get_login_info', {}, 5_000);
      if (info?.nickname) botName = info.nickname;
      log.info('bot online', { nickname: botName || info?.nickname || config.botQQ, botQQ: config.botQQ });
    } catch (err) {
      log.warn('bot online but get_login_info failed', { error: (err as Error).message });
    }
    opts.onReady?.();
  };

  client.onClose = () => log.info('websocket disconnected');

  client.onEvent = (raw) => {
    if (raw.post_type !== 'message') return;
    const evt = raw as MessageEvent;

    if (!guard.checkSelf(evt, config.botQQ)) {
      log.debug('drop message', { reason: 'self', messageId: evt.message_id });
      return;
    }
    if (!guard.checkWhitelist(evt)) {
      log.debug('drop message', { reason: 'whitelist', messageId: evt.message_id, groupId: evt.group_id });
      return;
    }
    if (!guard.checkDedup(evt)) {
      log.debug('drop message', { reason: 'dedup', messageId: evt.message_id });
      return;
    }
    if (!guard.checkRateLimit(evt)) {
      log.debug('drop message', { reason: 'rate-limit', messageId: evt.message_id, userId: evt.user_id });
      return;
    }

    store.touchSession();
    store.saveMessage(evt);
    const scope = scopeOf(evt);
    log.debug('message accepted', {
      messageId: evt.message_id,
      messageType: evt.message_type,
      groupId: evt.group_id,
      userId: evt.user_id,
      scope,
    });

    void handleMessage(evt, deps)
      .catch((err) => log.error('handler failed', err, { messageId: evt.message_id }))
      .finally(() => {
        void summarizer.maybeByThreshold(scope).catch((err) => log.error('threshold summary failed', err, { scope }));
      });
  };

  const sessionTimer = setInterval(() => store.touchSession(), 60_000);
  sessionTimer.unref?.();

  const stopScheduler = summarizer.startScheduler();
  client.connect();

  return {
    client,
    store,
    memory,
    impressions,
    guard,
    summarizer,
    character,
    stop: () => {
      clearInterval(sessionTimer);
      stopScheduler();
      store.endSession();
      log.info('session ended', { characterId: character.id, sessionId });
      corpus?.close();
      client.close();
      db.close();
    },
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const app = start();
  const shutdown = () => {
    log.info('shutting down');
    app.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
