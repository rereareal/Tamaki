import type { MessageEvent, MessageSegment } from './types';

export interface GuardConfig {
  adminQQ: number;
  allowedGroups: number[];
  dedupWindowMs: number;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

export interface ThrottleConfig {
  baseMinMs: number;
  baseMaxMs: number;
  typeDelay: Record<string, number>;
  random?: () => number;
}

export const DEFAULT_THROTTLE: ThrottleConfig = {
  baseMinMs: 300,
  baseMaxMs: 800,
  typeDelay: { text: 200, image: 800, record: 1500, face: 100 },
};

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function computeSendDelay(segments: MessageSegment[], cfg: ThrottleConfig = DEFAULT_THROTTLE): number {
  const rng = cfg.random ?? Math.random;
  const base = cfg.baseMinMs + rng() * (cfg.baseMaxMs - cfg.baseMinMs);
  let typeDelay = 0;
  for (const seg of segments) {
    typeDelay = Math.max(typeDelay, cfg.typeDelay[seg.type] ?? 0);
  }
  return Math.round(base + typeDelay);
}

/** 串行发送队列：所有出站消息共用一条 Promise 链。 */
export class OutboundQueue {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly cfg: ThrottleConfig = DEFAULT_THROTTLE) {}

  push<T>(segments: MessageSegment[], fn: () => Promise<T>): Promise<T> {
    const delay = computeSendDelay(segments, this.cfg);
    const task = this.chain.then(async () => {
      await sleep(delay);
      return fn();
    });
    // 单个发送失败不能卡死后续队列
    this.chain = task.catch(() => undefined);
    return task;
  }
}

export class Guard {
  private seen = new Map<number, number>();
  private rate = new Map<number, { start: number; count: number }>();

  constructor(private readonly cfg: GuardConfig) {}

  checkWhitelist(evt: MessageEvent): boolean {
    if (evt.message_type === 'group') {
      return evt.group_id !== undefined && this.cfg.allowedGroups.includes(evt.group_id);
    }
    return evt.user_id === this.cfg.adminQQ;
  }

  checkSelf(evt: MessageEvent, botQQ: number): boolean {
    return evt.user_id !== botQQ;
  }

  checkDedup(evt: MessageEvent): boolean {
    const now = Date.now();
    if (this.seen.size > 500) {
      for (const [id, ts] of this.seen) {
        if (now - ts > 60_000) this.seen.delete(id);
      }
    }
    const last = this.seen.get(evt.message_id);
    if (last !== undefined && now - last <= this.cfg.dedupWindowMs) return false;
    this.seen.set(evt.message_id, now);
    return true;
  }

  checkRateLimit(evt: MessageEvent): boolean {
    const now = Date.now();
    const bucket = this.rate.get(evt.user_id);
    if (!bucket || now - bucket.start >= this.cfg.rateLimitWindowMs) {
      this.rate.set(evt.user_id, { start: now, count: 1 });
      return true;
    }
    if (bucket.count >= this.cfg.rateLimitMax) return false;
    bucket.count++;
    return true;
  }

  reset(): void {
    this.seen.clear();
    this.rate.clear();
  }
}
