import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LoggerOptions {
  level?: string;
  dir?: string;
  toFile?: boolean;
  retentionDays?: number;
  timeZone?: string;
}

interface LoggerConfig {
  level: LogLevel;
  dir: string;
  toFile: boolean;
  retentionDays: number;
  timeZone: string;
}

const SECRET_KEY = /(token|secret|password|authorization|api[_-]?key)/i;

function normalizeLevel(value: string | undefined): LogLevel {
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

function dateKey(ts: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(ts);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (key, item) => {
      if (SECRET_KEY.test(key)) return '[redacted]';
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[circular]';
        seen.add(item);
      }
      return item;
    });
  } catch {
    return '"[unserializable]"';
  }
}

function errorMeta(err: unknown, meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (err instanceof Error) return { ...meta, error: err.message, stack: err.stack };
  if (err && typeof err === 'object') return { ...meta, ...(err as Record<string, unknown>) };
  if (err !== undefined) return { ...meta, error: String(err) };
  return meta;
}

/**
 * 轻量运行日志：控制台 + 按天文件。
 * 默认不记录消息正文；meta 里 token/secret/key 等字段会被替换成 [redacted]。
 */
export class Logger {
  private own: LoggerConfig = {
    level: 'info',
    dir: '',
    toFile: false,
    retentionDays: 7,
    timeZone: 'Asia/Shanghai',
  };
  private lastCleanup = '';

  constructor(
    private readonly scope = 'app',
    private readonly parent?: Logger,
  ) {}

  private get config(): LoggerConfig {
    return this.parent ? this.parent.config : this.own;
  }

  configure(opts: LoggerOptions): void {
    if (this.parent) {
      this.parent.configure(opts);
      return;
    }
    this.own = {
      level: normalizeLevel(opts.level),
      dir: opts.dir ?? '',
      toFile: opts.toFile ?? false,
      retentionDays: Math.max(0, opts.retentionDays ?? 7),
      timeZone: opts.timeZone ?? 'Asia/Shanghai',
    };
    if (this.own.toFile && this.own.dir) {
      mkdirSync(this.own.dir, { recursive: true });
      this.cleanup();
    }
  }

  child(scope: string): Logger {
    return new Logger(scope, this);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.write('debug', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.write('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.write('warn', message, meta);
  }

  error(message: string, err?: unknown, meta?: Record<string, unknown>): void {
    this.write('error', message, errorMeta(err, meta));
  }

  private write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const cfg = this.config;
    if (LEVEL_ORDER[level] < LEVEL_ORDER[cfg.level]) return;

    const ts = new Date();
    const line = `${ts.toISOString()} [${level.toUpperCase()}] [${this.scope}] ${message}${
      meta ? ` ${safeJson(meta)}` : ''
    }`;

    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    out(line);

    if (!cfg.toFile || !cfg.dir) return;
    try {
      const date = dateKey(ts, cfg.timeZone);
      if (!this.parent && this.lastCleanup !== date) {
        this.cleanup();
        this.lastCleanup = date;
      }
      appendFileSync(join(cfg.dir, `bot-${date}.log`), `${line}\n`, 'utf8');
    } catch {
      // 日志写盘失败不能影响 bot 运行。
    }
  }

  /** 只保留最近 N 个按天日志文件；0 表示不清理。 */
  private cleanup(): void {
    const cfg = this.config;
    if (!cfg.dir || !existsSync(cfg.dir) || cfg.retentionDays <= 0) return;
    try {
      const files = readdirSync(cfg.dir)
        .filter((name) => /^bot-\d{4}-\d{2}-\d{2}\.log$/.test(name))
        .sort();
      const remove = files.length - cfg.retentionDays;
      for (let i = 0; i < remove; i++) {
        try {
          unlinkSync(join(cfg.dir, files[i]!));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
}

export const logger = new Logger();

export function configureLogger(opts: LoggerOptions): void {
  logger.configure(opts);
}
