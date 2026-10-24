import type { Db } from './db';
import type { MessageEvent, MessageSegment } from '../types';
import { segmentsToText } from '../types';

export interface MessageRow {
  id: number;
  message_id: number;
  self_id: number;
  post_type: string;
  message_type: 'group' | 'private';
  group_id: number | null;
  user_id: number;
  nickname: string | null;
  is_self: number;
  raw_message: string;
  segments: string;
  created_at: number;
}

export type Scope = `group:${number}` | `private:${number}`;

export function scopeOf(evt: MessageEvent): Scope {
  return evt.message_type === 'group' && evt.group_id !== undefined
    ? `group:${evt.group_id}`
    : `private:${evt.user_id}`;
}

export function parseScope(scope: string): { kind: 'group' | 'private'; id: number } {
  const idx = scope.indexOf(':');
  return { kind: scope.slice(0, idx) as 'group' | 'private', id: Number(scope.slice(idx + 1)) };
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

export function zonedParts(ts: number, timeZone: string) {
  const parts = formatter(timeZone).formatToParts(new Date(ts));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function timezoneOffset(ts: number, timeZone: string): number {
  const p = zonedParts(ts, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (ts - (ts % 1000));
}

function wallToTs(year: number, month: number, day: number, hour: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day, hour, 0, 0);
  let offset = timezoneOffset(wall, timeZone);
  let result = wall - offset;
  const check = timezoneOffset(result, timeZone);
  if (check !== offset) result = wall - check;
  return result;
}

/**
 * 逻辑日界：最近一次 SUMMARY_HOUR:00（按指定时区）。
 * 总结在 03:00 跑，日界就必须也是 03:00，否则 00:00~03:00 会丢掉前一天尚未总结的对话。
 */
export function startOfLogicalDay(ts: number, hour: number, timeZone: string): number {
  const p = zonedParts(ts, timeZone);
  const today = wallToTs(p.year, p.month, p.day, hour, timeZone);
  if (today <= ts) return today;

  const prev = new Date(Date.UTC(p.year, p.month - 1, p.day - 1));
  return wallToTs(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), hour, timeZone);
}

export function formatClock(ts: number, timeZone: string): string {
  const p = zonedParts(ts, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function parseSegments(raw: string): MessageSegment[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function rowToSegments(row: MessageRow): MessageSegment[] {
  return parseSegments(row.segments);
}

export class MessageStore {
  constructor(
    private readonly db: Db,
    private readonly timeZone: string,
    /** 与 summarizer 的定时小时保持一致，作为逻辑日界。 */
    private readonly summaryHour: number,
  ) {}

  saveMessage(evt: MessageEvent): void {
    const nickname = evt.sender?.card || evt.sender?.nickname || String(evt.user_id);
    this.insert({
      messageId: evt.message_id,
      selfId: evt.self_id,
      messageType: evt.message_type,
      groupId: evt.group_id ?? null,
      userId: evt.user_id,
      nickname,
      isSelf: 0,
      rawMessage: evt.raw_message ?? segmentsToText(evt.message),
      segments: evt.message,
      createdAt: Date.now(),
    });
  }

  saveOutbound(params: {
    messageId?: number;
    selfId: number;
    messageType: 'group' | 'private';
    groupId?: number;
    userId: number;
    nickname: string;
    segments: MessageSegment[];
  }): void {
    this.insert({
      messageId: params.messageId ?? 0,
      selfId: params.selfId,
      messageType: params.messageType,
      groupId: params.groupId ?? null,
      userId: params.userId,
      nickname: params.nickname,
      isSelf: 1,
      rawMessage: segmentsToText(params.segments),
      segments: params.segments,
      createdAt: Date.now(),
    });
  }

  private insert(m: {
    messageId: number;
    selfId: number;
    messageType: 'group' | 'private';
    groupId: number | null;
    userId: number;
    nickname: string;
    isSelf: number;
    rawMessage: string;
    segments: MessageSegment[];
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO messages
         (message_id, self_id, post_type, message_type, group_id, user_id, nickname,
          is_self, raw_message, segments, created_at)
         VALUES (?, ?, 'message', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.messageId,
        m.selfId,
        m.messageType,
        m.groupId,
        m.userId,
        m.nickname,
        m.isSelf,
        m.rawMessage,
        JSON.stringify(m.segments),
        m.createdAt,
      );
  }

  /**
   * 当天上下文：下界优先用已总结 cursor；没有 cursor 时回退到最近一次逻辑日界。
   * 这样 00:00~SUMMARY_HOUR 之间不会因为跨零点而丢失前一天尚未总结的对话。
   * 已总结进记忆的对话仍然不会重放。
   */
  getContextMessages(scope: Scope, excludeMessageId?: number, now = Date.now()): MessageRow[] {
    const cursor = this.getCursor(scope);
    const boundary = startOfLogicalDay(now, this.summaryHour, this.timeZone);
    const since = cursor > 0 ? cursor : boundary;
    const { kind, id } = parseScope(scope);
    const cond = kind === 'group' ? 'group_id = ?' : "user_id = ? AND message_type = 'private'";
    let sql = `SELECT * FROM messages WHERE ${cond} AND created_at >= ?`;
    if (excludeMessageId !== undefined) sql += ' AND message_id != ?';
    sql += ' ORDER BY created_at ASC, id ASC';

    // 参数顺序与 SQL 占位符一致：scope 条件 -> since -> 排除的 message_id
    const params: (number | string)[] = [id, since];
    if (excludeMessageId !== undefined) params.push(excludeMessageId);
    return this.db.prepare(sql).all(...params) as unknown as MessageRow[];
  }

  getMessagesBetween(scope: Scope, afterTs: number, endTs: number): MessageRow[] {
    const { kind, id } = parseScope(scope);
    if (kind === 'group') {
      return this.db
        .prepare(
          `SELECT * FROM messages
           WHERE group_id = ? AND created_at > ? AND created_at <= ?
           ORDER BY created_at ASC, id ASC`,
        )
        .all(id, afterTs, endTs) as unknown as MessageRow[];
    }
    return this.db
      .prepare(
        `SELECT * FROM messages
         WHERE message_type = 'private' AND user_id = ? AND created_at > ? AND created_at <= ?
         ORDER BY created_at ASC, id ASC`,
      )
      .all(id, afterTs, endTs) as unknown as MessageRow[];
  }

  countSince(scope: Scope, afterTs: number): number {
    const { kind, id } = parseScope(scope);
    const row =
      kind === 'group'
        ? this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_id = ? AND created_at > ?').get(id, afterTs)
        : this.db
            .prepare("SELECT COUNT(*) AS n FROM messages WHERE message_type = 'private' AND user_id = ? AND created_at > ?")
            .get(id, afterTs);
    return Number((row as { n: number } | undefined)?.n ?? 0);
  }

  listScopes(): Scope[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT
           CASE WHEN message_type = 'group' THEN 'group:' || group_id
                ELSE 'private:' || user_id END AS scope
         FROM messages`,
      )
      .all() as unknown as { scope: string }[];
    return rows.map((r) => r.scope as Scope);
  }

  getCursor(scope: Scope): number {
    const row = this.db.prepare('SELECT last_ts FROM summary_cursor WHERE scope = ?').get(scope) as
      | { last_ts: number }
      | undefined;
    return Number(row?.last_ts ?? 0);
  }

  setCursor(scope: Scope, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO summary_cursor (scope, last_ts) VALUES (?, ?)
         ON CONFLICT(scope) DO UPDATE SET last_ts = excluded.last_ts`,
      )
      .run(scope, ts);
  }
}
