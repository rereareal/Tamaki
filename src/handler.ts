import type { MessageEvent, MessageSegment } from './types';
import { segmentsToText } from './types';
import type { NapCatClient } from './ws';
import type { MessageStore } from './store/messages';
import { scopeOf } from './store/messages';
import type { MemoryStore } from './store/memory';
import type { ImpressionStore } from './store/impressions';
import { buildContextMessages, inferTags } from './context/builder';
import type { LLMCall } from './tools/runner';
import { runWithTools } from './tools/runner';
import type { ToolContext } from './tools/registry';
import { getTool } from './tools/registry';
import type { CharacterRuntime } from './character/loader';
import type { ProactiveGate } from './proactive';
import { logger } from './log';

const log = logger.child('handler');
const toolsLog = logger.child('tools');

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
  proactive?: ProactiveGate;
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

/**
 * 代码层预执行 search_lines，把结果格式化成系统提示的一部分。
 * 不伪造 assistant(tool_calls)：thinking mode 的 provider 要求 assistant
 * 消息带回 reasoning_content，伪造 tool_calls 会直接 400。
 */
export async function preflightSearchLines(ctx: ToolContext, query: string): Promise<string> {
  if (!ctx.character.corpus || !query) return '';
  const tool = getTool('search_lines');
  if (!tool) return '';

  toolsLog.info('tool call', { name: 'search_lines', preflight: true });
  try {
    const result = await tool.execute({ keyword: query, limit: 5, tags: inferTags(query) }, ctx);
    const lines = (result as any)?.lines;
    if (!Array.isArray(lines) || lines.length === 0) return '';
    return lines
      .map((line: any) => {
        const oneLine = (text: unknown) => String(text ?? '').replace(/\s*\n\s*/g, ' / ').trim();
        const parts = [`原文：${oneLine(line.textJa)}`];
        if (line.textZh) parts.push(`中文：${oneLine(line.textZh)}`);
        if (Array.isArray(line.tags) && line.tags.length > 0) parts.push(`标签：${line.tags.join('/')}`);
        return `- ${parts.join(' ｜ ')}`;
      })
      .join('\n');
  } catch (err) {
    log.warn('tool failed', { name: 'search_lines', preflight: true, error: (err as Error).message });
    return '';
  }
}

export async function handleMessage(evt: MessageEvent, deps: HandlerDeps): Promise<void> {
  const direct = await shouldRespond(evt, deps);
  let proactive = false;

  if (!direct && deps.proactive) {
    proactive = deps.proactive.shouldInterject(evt.group_id, segmentsToText(evt.message).trim().length);
  }

  if (!direct && !proactive) {
    log.debug('not triggered', { messageId: evt.message_id, messageType: evt.message_type });
    return;
  }

  if (proactive) {
    log.info('proactive interject', { messageId: evt.message_id, groupId: evt.group_id });
  } else {
    log.debug('handling', { messageId: evt.message_id, messageType: evt.message_type });
  }

  const botName = deps.getBotName();
  const query = segmentsToText(evt.message.filter((seg) => seg.type !== 'at' && seg.type !== 'reply')).trim();
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

  const preflightText = await preflightSearchLines(ctx, query);
  const preflightSearch = Boolean(deps.character.corpus && query);

  const built = buildContextMessages(evt, {
    store: deps.store,
    memory: deps.memory,
    impressions: deps.impressions,
    character: deps.character,
    botQQ: deps.botQQ,
    botName,
    timeZone: deps.timeZone,
    proactive,
    preflightSearch,
    preflightText,
  });

  const answer = await runWithTools(built.messages, ctx, deps.callLLM, 5);
  if (!answer) {
    log.debug('empty answer', { messageId: evt.message_id });
    return;
  }
  log.debug('answer ready', { messageId: evt.message_id, length: answer.length });

  await deps.reply(evt, [{ type: 'text', data: { text: answer } }]);
}
