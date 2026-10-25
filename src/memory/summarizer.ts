import type { MemoryStore } from '../store/memory';
import type { MessageStore, Scope } from '../store/messages';
import { formatClock, rowToSegments, zonedParts } from '../store/messages';
import { segmentsToText } from '../types';
import type { ChatMessage, LLMCall } from '../tools/runner';
import { logger } from '../log';

const log = logger.child('summary');

export interface SummarizerOptions {
  timeZone: string;
  hour: number;
  threshold: number;
  characterName?: string;
}

function summarySystem(characterName?: string): string {
  return (
    `你是记忆整理器${characterName ? `，正在为角色「${characterName}」整理群聊记忆` : ''}。` +
    '阅读「现有记忆」和「新增对话」，输出更新后的完整记忆正文。' +
    '只记录可核对的事实：谁说了什么、约定、事件、明确表达过的偏好、时间/人物。' +
    '不写性格评价、动机猜测、情绪判断；不写「某人很温柔/不靠谱」这类主观结论。' +
    '用「X 表示/提到/答应……」归因，不替对方下结论；无法确认的内容不要写。' +
    'bot 自己的话只保留明确承诺或约定，其余不复述。' +
    '800 字以内；丢弃寒暄、重复和一次性闲聊；' +
    '只输出记忆正文，不要标题、不要解释、不要代码块。'
  );
}

export class Summarizer {
  private locks = new Map<string, Promise<boolean>>();
  private lastDaily = '';

  constructor(
    private readonly store: MessageStore,
    private readonly memory: MemoryStore,
    private readonly callLLM: LLMCall,
    private readonly opts: SummarizerOptions,
  ) {}

  /** 把 cursor 之后的新对话压缩进 MD 记忆，成功后推进 cursor。 */
  summarizeScope(scope: Scope): Promise<boolean> {
    const running = this.locks.get(scope);
    if (running) return running;

    const task = this.doSummarize(scope).finally(() => this.locks.delete(scope));
    this.locks.set(scope, task);
    return task;
  }

  async maybeByThreshold(scope: Scope): Promise<boolean> {
    const cursor = this.store.getCursor(scope);
    if (this.store.countSince(scope, cursor) < this.opts.threshold) return false;
    return this.summarizeScope(scope);
  }

  async summarizeAll(): Promise<void> {
    for (const scope of this.store.listScopes()) {
      try {
        await this.summarizeScope(scope);
      } catch (err) {
        log.error('scope summary failed', err, { scope });
      }
    }
  }

  /** 每天 opts.hour 点跑一次；返回停止函数。 */
  startScheduler(): () => void {
    const timer = setInterval(() => {
      const now = new Date();
      const p = zonedParts(now.getTime(), this.opts.timeZone);
      const dateKey = `${p.year}-${p.month}-${p.day}`;
      if (p.hour !== this.opts.hour || p.minute !== 0) return;
      if (this.lastDaily === dateKey) return;
      this.lastDaily = dateKey;
      log.info('daily run', { date: dateKey });
      void this.summarizeAll();
    }, 30_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async doSummarize(scope: Scope): Promise<boolean> {
    const cursor = this.store.getCursor(scope);
    const end = Date.now();
    const rows = this.store.getMessagesBetween(scope, cursor, end);
    if (rows.length === 0) return false;

    const transcript = rows
      .map((row) => {
        const text = segmentsToText(rowToSegments(row));
        if (!text) return '';
        return `[${formatClock(row.created_at, this.opts.timeZone)}] ${row.is_self ? '我' : row.nickname ?? '群友'}: ${text}`;
      })
      .filter(Boolean)
      .join('\n');

    if (!transcript) return false;

    const old = this.memory.loadMemory(scope);
    const messages: ChatMessage[] = [
      { role: 'system', content: summarySystem(this.opts.characterName) },
      {
        role: 'user',
        content: `【现有记忆】\n${old || '（空）'}\n\n【新增对话】\n${transcript}`,
      },
    ];

    const res = await this.callLLM(messages);
    const content = (res.content ?? '')
      .trim()
      .replace(/^```(?:markdown)?\s*/i, '')
      .replace(/```$/, '')
      .trim();
    if (!content) return false;

    this.memory.saveMemory(scope, content.slice(0, 1600));
    this.store.setCursor(scope, end);
    log.info('summarized', { scope, messages: rows.length, version: this.memory.memoryVersions(scope) });
    return true;
  }
}
