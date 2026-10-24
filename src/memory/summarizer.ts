import type { MemoryStore } from '../store/memory';
import type { MessageStore, Scope } from '../store/messages';
import { formatClock, rowToSegments, zonedParts } from '../store/messages';
import { segmentsToText } from '../types';
import type { ChatMessage, LLMCall } from '../tools/runner';

export interface SummarizerOptions {
  timeZone: string;
  hour: number;
  threshold: number;
}

const SUMMARY_SYSTEM =
  '你是记忆整理器。阅读「现有记忆」和「新增对话」，输出更新后的完整记忆正文。' +
  '要求：800 字以内；保留偏好、约定、关键事件、人物关系；丢弃寒暄、重复和一次性闲聊；' +
  '只输出记忆正文，不要标题、不要解释、不要代码块。';

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
        console.error(`[summary] ${scope} failed:`, (err as Error).message);
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
      console.log('[summary] daily run', dateKey);
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
      { role: 'system', content: SUMMARY_SYSTEM },
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
    console.log(`[summary] ${scope}: ${rows.length} messages -> memory v${this.memory.memoryVersions(scope)}`);
    return true;
  }
}
