import type { MessageEvent, MessageSegment } from './types';
import { segmentsToText } from './types';
import type { NapCatClient } from './ws';
import type { MessageStore } from './store/messages';
import { scopeOf } from './store/messages';
import type { MemoryStore } from './store/memory';
import type { ImpressionStore } from './store/impressions';
import { buildContextMessages } from './context/builder';
import type { LLMCall } from './tools/runner';
import { runWithTools } from './tools/runner';
import type { ToolContext } from './tools/registry';
import type { CharacterRuntime } from './character/loader';
import { logger } from './log';

const log = logger.child('handler');

export type ReplyFn = (evt: MessageEvent, segments: MessageSegment[]) => Promise<void>;

export interface HandlerDeps {
  client: NapCatClient;
  store: MessageStore;
  memory: MemoryStore;
  impressions: ImpressionStore;
  callLLM: LLMCall;
  reply: ReplyFn;
  adminQQ: number;
  botQQ: number;
  getBotName: () => string;
  character: CharacterRuntime;
  timeZone: string;
}

function isMentioned(evt: MessageEvent, botQQ: number): boolean {
  return evt.message.some((seg) => seg.type === 'at' && String(seg.data?.qq) === String(botQQ));
}

async function isReplyToBot(evt: MessageEvent, deps: HandlerDeps): Promise<boolean> {
  const replySeg = evt.message.find((seg) => seg.type === 'reply');
  if (!replySeg) return false;
  try {
    const data = await deps.client.callAction<{ sender?: { user_id?: number } }>(
      'get_msg',
      { message_id: Number((replySeg.data as any)?.id) },
      3_000,
    );
    return String(data?.sender?.user_id) === String(deps.botQQ);
  } catch {
    return false;
  }
}

function containsKeyword(evt: MessageEvent, keyword: string): boolean {
  if (!keyword) return false;
  return segmentsToText(evt.message).includes(keyword);
}

export async function shouldRespond(evt: MessageEvent, deps: HandlerDeps): Promise<boolean> {
  if (evt.message_type === 'private') return true;
  if (isMentioned(evt, deps.botQQ)) return true;
  if (containsKeyword(evt, deps.getBotName())) return true;
  return isReplyToBot(evt, deps);
}

export async function handleMessage(evt: MessageEvent, deps: HandlerDeps): Promise<void> {
  if (!(await shouldRespond(evt, deps))) {
    log.debug('not triggered', { messageId: evt.message_id, messageType: evt.message_type });
    return;
  }

  log.debug('handling', { messageId: evt.message_id, messageType: evt.message_type });

  const botName = deps.getBotName();
  const ctx: ToolContext = {
    evt,
    isAdmin: evt.user_id === deps.adminQQ,
    scope: scopeOf(evt),
    store: deps.store,
    memory: deps.memory,
    impressions: deps.impressions,
    botQQ: deps.botQQ,
    botName,
    character: deps.character,
    reply: (segments) => deps.reply(evt, segments),
  };

  const built = buildContextMessages(evt, {
    store: deps.store,
    memory: deps.memory,
    impressions: deps.impressions,
    character: deps.character,
    botQQ: deps.botQQ,
    botName,
    timeZone: deps.timeZone,
  });

  const answer = await runWithTools(built.messages, ctx, deps.callLLM, 5);
  if (!answer) {
    log.debug('empty answer', { messageId: evt.message_id });
    return;
  }
  log.debug('answer ready', { messageId: evt.message_id, length: answer.length });

  await deps.reply(evt, [{ type: 'text', data: { text: answer } }]);
}
