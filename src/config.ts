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

function float(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for env ${name}: ${raw}`);
  return n;
}

const dataDir = resolve(process.env.DATA_DIR ?? 'data');
const runtimeDir = resolve(dataDir, 'runtime');

const allowedGroups = required('ALLOWED_GROUPS')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

const proactiveGroups = (process.env.PROACTIVE_GROUPS ?? allowedGroups.join(','))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);

const llmApiKey = process.env.LLM_STUB === '1' ? process.env.LLM_API_KEY ?? 'stub' : required('LLM_API_KEY');
const llmBaseUrl = (process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const searchBaseUrl = (process.env.SEARCH_BASE_URL ?? llmBaseUrl).replace(/\/+$/, '');
const toolsBaseUrl = searchBaseUrl.endsWith('/v1') ? searchBaseUrl : `${searchBaseUrl}/v1`;
const searchUrl = process.env.SEARCH_API_URL ?? `${toolsBaseUrl}/tools/search`;
const fetchUrl = process.env.FETCH_API_URL ?? `${toolsBaseUrl}/tools/fetch`;

export const config = {
  wsUrl: process.env.WS_URL ?? 'ws://127.0.0.1:3001',
  wsToken: process.env.WS_TOKEN?.trim() ?? '',
  botQQ: Number(required('BOT_QQ')),
  adminQQ: Number(required('ADMIN_QQ')),
  allowedGroups,
  botName: process.env.BOT_NAME?.trim() ?? '',

  dataDir,
  runtimeDir,
  dbPath: resolve(runtimeDir, 'bot.db'),
  logDir: resolve(process.env.LOG_DIR ?? resolve(runtimeDir, 'logs')),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  logToFile: process.env.LOG_TO_FILE !== '0',
  logRetentionDays: int('LOG_RETENTION_DAYS', 7),
  corporaDir: resolve(process.env.CORPORA_DIR ?? resolve(dataDir, 'corpora')),
  activeCharacterFile: resolve(process.env.ACTIVE_CHARACTER_FILE ?? resolve(runtimeDir, 'active-character.txt')),

  /** 本地角色定义目录；默认与 corpora 同级。 */
  charactersDir: resolve(process.env.CHARACTERS_DIR ?? resolve(dataDir, 'characters')),

  timeZone: process.env.TZ_NAME ?? 'Asia/Shanghai',
  summaryHour: int('SUMMARY_HOUR', 3),
  summaryThreshold: int('SUMMARY_THRESHOLD', 200),

  proactive: {
    enabled: process.env.PROACTIVE_ENABLED === '1',
    chance: float('PROACTIVE_CHANCE', 0.05),
    idleMs: int('PROACTIVE_IDLE_MS', 10 * 60_000),
    cooldownMs: int('PROACTIVE_COOLDOWN_MS', 30 * 60_000),
    maxPerHour: int('PROACTIVE_MAX_PER_HOUR', 3),
    minTextLength: int('PROACTIVE_MIN_TEXT_LENGTH', 6),
    groups: proactiveGroups,
  },

  dedupWindowMs: 5_000,
  rateLimitWindowMs: 10_000,
  rateLimitMax: 5,
  heartbeatTimeoutMs: int('WS_HEARTBEAT_TIMEOUT_MS', 90_000),
  reconnectDelayMs: int('WS_RECONNECT_DELAY_MS', 3_000),

  llm: {
    apiKey: llmApiKey,
    baseUrl: llmBaseUrl,
    model: process.env.LLM_MODEL ?? 'deepseek-flash',
    stub: process.env.LLM_STUB === '1',
  },

  search: {
    /** 与 pi 的 deepseek-search 扩展同一组接口。 */
    url: searchUrl,
    fetchUrl,
    apiKey: process.env.SEARCH_API_KEY ?? llmApiKey,
  },
};

export type AppConfig = typeof config;
