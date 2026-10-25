import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CorpusLibrary } from './corpus';
import type { MemoryStore } from '../store/memory';
import { logger } from '../log';

const log = logger.child('character');
import type { ImpressionStore } from '../store/impressions';

export interface CorpusBinding {
  id: string;
  speakers: string[];
}

export interface CharacterMeta {
  id: string;
  displayName?: string;
  corpora?: CorpusBinding[];
  aliases?: string[];
  relations?: Record<string, string>;
  glossary?: Record<string, string>;
}

export interface CorpusMeta {
  id: string;
  displayName?: string;
}

export interface CorpusDefinition {
  id: string;
  displayName: string;
  dir: string;
  dbPath: string;
  meta: CorpusMeta;
}

export interface CharacterDefinition {
  id: string;
  displayName: string;
  /** 角色定义目录（本地，通常被 gitignore）。 */
  dir: string;
  meta: CharacterMeta;
  corpora: CorpusBinding[];
  persona: string;
  glossary: Record<string, string>;
  isFallback: boolean;
}

export interface CharacterRuntime extends CharacterDefinition {
  corpus: CorpusLibrary | null;
  memory: MemoryStore;
  impressions: ImpressionStore;
  sessionId: number;
  runtimeDir: string;
  memoryDir: string;
}

export const DEFAULT_PERSONA = `你是群里的一个普通 AI 群友。
说话简短、自然、有分寸；不懂就说不懂，不编造群友的信息。`;

function readText(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

function readJson<T>(path: string): T | undefined {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeBindings(raw: CharacterMeta): CorpusBinding[] {
  if (!Array.isArray(raw.corpora)) return [];
  return raw.corpora
    .map((item) => ({
      id: String(item?.id ?? '').trim(),
      speakers: Array.isArray(item?.speakers) ? item.speakers.map(String).filter(Boolean) : [],
    }))
    .filter((item) => item.id && item.speakers.length > 0);
}

function loadDefinition(dir: string, id: string): CharacterDefinition | null {
  const metaPath = join(dir, 'meta.json');
  if (!existsSync(metaPath)) return null;

  const raw = readJson<CharacterMeta>(metaPath);
  if (!raw || typeof raw !== 'object') {
    log.warn('invalid meta.json', { path: metaPath });
    return null;
  }

  const corpora = normalizeBindings(raw);
  const meta: CharacterMeta = {
    ...raw,
    id: String(raw.id || id),
    displayName: raw.displayName || raw.id || id,
    corpora,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.map(String) : [],
    relations: raw.relations ?? {},
  };

  const glossary = readJson<Record<string, string>>(join(dir, 'glossary.json')) ?? meta.glossary ?? {};

  return {
    id: meta.id,
    displayName: String(meta.displayName),
    dir,
    meta,
    corpora,
    persona: readText(join(dir, 'persona.md')).trim() || DEFAULT_PERSONA,
    glossary,
    isFallback: false,
  };
}

/**
 * 扫描角色定义目录，不硬编码任何角色。
 * 只认 `<dir>/meta.json`；`_template`、隐藏目录会被跳过。
 */
export function loadCharacterRegistry(charactersDir: string): Map<string, CharacterDefinition> {
  const registry = new Map<string, CharacterDefinition>();
  if (!existsSync(charactersDir)) return registry;

  let entries;
  try {
    entries = readdirSync(charactersDir, { withFileTypes: true });
  } catch {
    return registry;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const dir = resolve(charactersDir, entry.name);
    const def = loadDefinition(dir, entry.name);
    if (!def) continue;
    if (registry.has(def.id)) {
      log.warn('duplicate character id, keeping first', { characterId: def.id });
      continue;
    }
    registry.set(def.id, def);
  }
  return registry;
}

/**
 * 扫描语料库目录，每个子目录是一个 corpus。
 * 允许暂时没有 corpus.db（导入前），运行时再 warn + 跳过。
 */
export function loadCorpusRegistry(corporaDir: string): Map<string, CorpusDefinition> {
  const registry = new Map<string, CorpusDefinition>();
  if (!existsSync(corporaDir)) return registry;

  let entries;
  try {
    entries = readdirSync(corporaDir, { withFileTypes: true });
  } catch {
    return registry;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const dir = resolve(corporaDir, entry.name);
    const raw = readJson<CorpusMeta>(join(dir, 'meta.json'));
    const id = String(raw?.id || entry.name);
    registry.set(id, {
      id,
      displayName: String(raw?.displayName || raw?.id || entry.name),
      dir,
      dbPath: join(dir, 'corpus.db'),
      meta: { id, displayName: String(raw?.displayName || raw?.id || entry.name) },
    });
  }
  return registry;
}

/** 读 active-character 文件（默认 data/runtime/active-character.txt）。 */
export function readActiveCharacterId(file: string): string | undefined {
  const text = readText(file);
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    return value;
  }
  return undefined;
}

export function createFallbackDefinition(botName: string): CharacterDefinition {
  return {
    id: 'default',
    displayName: botName || 'Tamaki',
    dir: '',
    meta: { id: 'default', displayName: botName || 'Tamaki', corpora: [], aliases: [], relations: {} },
    corpora: [],
    persona: DEFAULT_PERSONA,
    glossary: {},
    isFallback: true,
  };
}

export interface ResolvedCharacter {
  character: CharacterDefinition;
  fallback: boolean;
  reason?: string;
}

/**
 * file > 目录里的 default > 内置 fallback。
 * 找不到角色时只 warn，不阻止机器人启动。
 */
export function resolveCharacter(
  registry: Map<string, CharacterDefinition>,
  activeId: string | undefined,
  botName: string,
): ResolvedCharacter {
  if (activeId) {
    const found = registry.get(activeId);
    if (found) return { character: found, fallback: false };
    const fallback = createFallbackDefinition(botName);
    log.warn('active character not found, using fallback', { activeId });
    return { character: fallback, fallback: true, reason: `unknown character: ${activeId}` };
  }

  const defaultCharacter = registry.get('default');
  if (defaultCharacter) return { character: defaultCharacter, fallback: false };

  return {
    character: createFallbackDefinition(botName),
    fallback: true,
    reason: 'no active-character.txt and no default character',
  };
}
