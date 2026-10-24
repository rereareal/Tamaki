import type { MessageEvent, MessageSegment } from '../types';
import { segmentsToText } from '../types';
import type { MessageStore, Scope } from '../store/messages';
import { formatClock, rowToSegments, scopeOf } from '../store/messages';
import type { MemoryStore } from '../store/memory';
import type { ChatMessage } from '../tools/runner';

export interface ContextDeps {
  store: MessageStore;
  memory: MemoryStore;
  persona: string;
  botQQ: number;
  botName: string;
  timeZone: string;
  maxMemoryChars?: number;
  maxImpressionChars?: number;
  maxTodayChars?: number;
}

export interface BuiltContext {
  messages: ChatMessage[];
  system: string;
  scope: Scope;
}

function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return `…${text.slice(text.length - max)}`;
}

function clipHead(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function currentUserText(evt: MessageEvent): string {
  const nickname = evt.sender?.card || evt.sender?.nickname || String(evt.user_id);
  const body = segmentsToText(evt.message) || '[空消息]';
  return `[${nickname}] ${body}`;
}

function lineOf(ts: number, nickname: string | null, isSelf: number, segments: MessageSegment[], tz: string): string {
  const text = segmentsToText(segments);
  if (!text) return '';
  return `[${formatClock(ts, tz)}] ${isSelf ? '我' : nickname ?? '群友'}: ${text}`;
}

/**
 * 上下文 = 系统提示（人设 + 记忆 + 印象）+ 当天消息 + 当前新消息。
 * 当天消息的下界是已总结 cursor（没有 cursor 时回退到 SUMMARY_HOUR 逻辑日界），
 * 已总结历史不重放；零点到总结时间之间也不会丢前一天未总结的对话。
 */
export function buildContextMessages(evt: MessageEvent, deps: ContextDeps): BuiltContext {
  const scope = scopeOf(evt);
  const rows = deps.store.getContextMessages(scope, evt.message_id);

  const lines = rows
    .map((row) => lineOf(row.created_at, row.nickname, row.is_self, rowToSegments(row), deps.timeZone))
    .filter(Boolean);

  let today = lines.join('\n');
  const todayBudget = deps.maxTodayChars ?? 4000;
  if (today.length > todayBudget) {
    // 从最新往回取，保证上下文以最近对话结尾
    const kept: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (used + line.length + 1 > todayBudget && kept.length > 0) break;
      kept.push(line);
      used += line.length + 1;
    }
    today = `…（更早的今日消息已省略）\n${kept.reverse().join('\n')}`;
  }

  const memory = clipHead(deps.memory.loadMemory(scope), deps.maxMemoryChars ?? 1000);
  const groupId = evt.group_id;
  const impressions =
    groupId !== undefined ? clipHead(deps.memory.loadImpressions(groupId), deps.maxImpressionChars ?? 500) : '';

  const system = [
    deps.persona.trim(),
    '',
    '## 长期记忆',
    memory || '（暂无）',
    '',
    '## 群友印象',
    impressions || '（暂无）',
    '',
    '## 今日对话（截至当前）',
    today || '（今天还没有其他对话）',
    '',
    '请以你自己的身份直接回复最新一条消息。不要复述上下文，不要解释规则。',
  ].join('\n');

  return {
    scope,
    system,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: currentUserText(evt) },
    ],
  };
}
