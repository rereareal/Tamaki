import { resolve } from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for env ${name}: ${raw}`);
  return n;
}

const dataDir = resolve(process.env.DATA_DIR ?? 'data');

export const config = {
  wsUrl: process.env.WS_URL ?? 'ws://127.0.0.1:3001',
  wsToken: process.env.WS_TOKEN?.trim() ?? '',
  botQQ: Number(required('BOT_QQ')),
  adminQQ: Number(required('ADMIN_QQ')),
  allowedGroups: required('ALLOWED_GROUPS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  botName: process.env.BOT_NAME?.trim() ?? '',

  dataDir,
  dbPath: resolve(dataDir, 'bot.db'),
  memoryDir: resolve(dataDir, 'memory'),
  impressionsDir: resolve(dataDir, 'impressions'),
  personaPath: resolve(dataDir, 'persona.md'),

  timeZone: process.env.TZ_NAME ?? 'Asia/Shanghai',
  summaryHour: int('SUMMARY_HOUR', 3),
  summaryThreshold: int('SUMMARY_THRESHOLD', 200),

  dedupWindowMs: 5_000,
  rateLimitWindowMs: 10_000,
  rateLimitMax: 5,
  heartbeatTimeoutMs: int('WS_HEARTBEAT_TIMEOUT_MS', 90_000),
  reconnectDelayMs: int('WS_RECONNECT_DELAY_MS', 3_000),

  llm: {
    apiKey: process.env.LLM_STUB === '1' ? process.env.LLM_API_KEY ?? 'stub' : required('LLM_API_KEY'),
    baseUrl: process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1',
    model: process.env.LLM_MODEL ?? 'deepseek-flash',
    stub: process.env.LLM_STUB === '1',
  },
};

export type AppConfig = typeof config;
