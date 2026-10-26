import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CorpusBinding, CorpusDefinition } from './loader';
import { logger } from '../log';

const log = logger.child('corpus');

export interface CorpusLine {
  corpusId: string;
  id: string;
  scene: string;
  seq: number;
  speaker: string;
  textJa: string;
  textZh: string | null;
  sceneType: string;
  partner: string | null;
  relation: string | null;
  tags: string[];
  emotion: string | null;
  note: string | null;
  kind: string;
}

export interface SearchOptions {
  limit?: number;
  relation?: string;
  emotion?: string;
  tags?: string[];
}

export interface CorpusStats {
  lines: number;
  translated: number;
  curated: number;
  corpora: number;
}

export interface CorpusRow {
  id: string;
  scene: string;
  seq: number;
  speaker: string;
  text_ja: string;
  scene_type: string | null;
  partner: string | null;
  text_zh: string | null;
  relation: string | null;
  tags: string | null;
  emotion: string | null;
  note: string | null;
  kind: string | null;
}

interface ScoredLine {
  line: CorpusLine;
  score: number;
}

export const CORPUS_SCHEMA = `
CREATE TABLE IF NOT EXISTS lines (
  id TEXT PRIMARY KEY,
  scene TEXT NOT NULL,
  seq INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  text_ja TEXT NOT NULL,
  scene_type TEXT NOT NULL DEFAULT 'main',
  partner TEXT
);
CREATE INDEX IF NOT EXISTS idx_lines_speaker ON lines(speaker);
CREATE INDEX IF NOT EXISTS idx_lines_scene_seq ON lines(scene, seq);

CREATE TABLE IF NOT EXISTS translations (
  line_id TEXT PRIMARY KEY,
  text_zh TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'llm',
  model TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_translations_text ON translations(text_zh);

CREATE TABLE IF NOT EXISTS line_meta (
  line_id TEXT PRIMARY KEY,
  relation TEXT,
  tags TEXT,
  emotion TEXT,
  note TEXT,
  kind TEXT NOT NULL DEFAULT 'line'
);

CREATE TABLE IF NOT EXISTS speakers (
  name TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openCorpusDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec(CORPUS_SCHEMA);
  return db;
}

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toLine(row: CorpusRow, relations: Record<string, string>, corpusId: string): CorpusLine {
  return {
    corpusId,
    id: row.id,
    scene: row.scene,
    seq: Number(row.seq),
    speaker: row.speaker,
    textJa: row.text_ja,
    textZh: row.text_zh ?? null,
    sceneType: row.scene_type ?? 'main',
    partner: row.partner ?? null,
    relation: row.relation ?? (row.partner ? relations[row.partner] ?? null : null),
    tags: parseTags(row.tags),
    emotion: row.emotion ?? null,
    note: row.note ?? null,
    kind: row.kind ?? 'line',
  };
}

const SELECT_LINE = `
  SELECT l.id, l.scene, l.seq, l.speaker, l.text_ja, l.scene_type, l.partner,
         t.text_zh,
         m.relation, m.tags, m.emotion, m.note, m.kind
  FROM lines l
  LEFT JOIN translations t ON t.line_id = l.id
  LEFT JOIN line_meta m ON m.line_id = l.id
`;

/**
 * 单个语料库。一个 corpus 一个 DB；角色可以绑定多个 corpus。
 * 查询主键是 speaker + 日文/中文子串；排序在 TS 侧做简单加权。
 */
export class CorpusStore {
  constructor(
    private readonly db: DatabaseSync,
    readonly corpusId: string,
    private readonly speakers: string[],
    private readonly relations: Record<string, string>,
  ) {}

  get enabled(): boolean {
    return this.speakers.length > 0;
  }

  search(query: string, opts: SearchOptions = {}): CorpusLine[] {
    return this.searchScored(query, opts)
      .slice(0, Math.max(1, Math.min(10, opts.limit ?? 5)))
      .map((item) => item.line);
  }

  searchScored(query: string, opts: SearchOptions = {}): ScoredLine[] {
    const text = query.trim();
    if (!text || this.speakers.length === 0) return [];

    const terms = [...new Set([text, ...text.split(/[\s,，。！？!?…、:：;；/|]+/).filter((t) => t.length >= 2)])];
    const speakerMarks = this.speakers.map(() => '?').join(',');
    const termSql = terms.map(() => "(l.text_ja LIKE ? ESCAPE '\\' OR t.text_zh LIKE ? ESCAPE '\\')").join(' OR ');
    const params: (string | number)[] = [...this.speakers];
    for (const term of terms) {
      const like = `%${escapeLike(term)}%`;
      params.push(like, like);
    }

    let rows: CorpusRow[];
    try {
      rows = this.db
        .prepare(`${SELECT_LINE} WHERE l.speaker IN (${speakerMarks}) AND (${termSql}) LIMIT 160`)
        .all(...params) as unknown as CorpusRow[];
    } catch (err) {
      log.warn('search failed', { corpusId: this.corpusId, error: (err as Error).message });
      return [];
    }

    let lines = rows.map((row) => toLine(row, this.relations, this.corpusId));

    if (opts.relation) lines = lines.filter((line) => line.relation === opts.relation);
    if (opts.emotion) {
      const needle = opts.emotion.toLowerCase();
      lines = lines.filter((line) => line.emotion?.toLowerCase().includes(needle));
    }
    if (opts.tags?.length) {
      const wanted = new Set(opts.tags);
      lines = lines.filter((line) => line.tags.some((tag) => wanted.has(tag)));
    }

    const scored = lines.map((line) => ({ line, score: this.score(line, text, terms, opts) }));
    scored.sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    const result: ScoredLine[] = [];
    for (const item of scored) {
      const key = item.line.textJa.replace(/\s+/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item);
    }
    return result;
  }

  /**
   * 按 tags 检索。用于中文消息没有命中原文/译文时，按主题标签兜底。
   */
  searchByTags(tags: string[], opts: SearchOptions = {}): CorpusLine[] {
    const wanted = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
    if (wanted.length === 0 || this.speakers.length === 0) return [];

    const speakerMarks = this.speakers.map(() => '?').join(',');
    const tagSql = wanted.map(() => "m.tags LIKE ? ESCAPE '\\'").join(' OR ');
    const tagParams = wanted.map((tag) => `%"${escapeLike(tag)}"%`);
    let rows: CorpusRow[];
    try {
      rows = this.db
        .prepare(
          `${SELECT_LINE} WHERE l.speaker IN (${speakerMarks}) AND m.tags IS NOT NULL AND (${tagSql}) LIMIT 240`,
        )
        .all(...this.speakers, ...tagParams) as unknown as CorpusRow[];
    } catch (err) {
      log.warn('tag search failed', { corpusId: this.corpusId, error: (err as Error).message });
      return [];
    }

    const wantedSet = new Set(wanted);
    const lines = rows.map((row) => toLine(row, this.relations, this.corpusId));
    const scored = lines
      .map((line) => ({
        line,
        score:
          line.tags.filter((tag) => wantedSet.has(tag)).length * 20 +
          (line.kind === 'snippet' ? 5 : 0) +
          (line.sceneType === 'main' ? 5 : line.sceneType === 'support' ? 3 : 0),
      }))
      .sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    const result: CorpusLine[] = [];
    const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
    for (const { line } of scored) {
      const key = line.textJa.replace(/\s+/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(line);
      if (result.length >= limit) break;
    }
    return result;
  }

  get(id: string): CorpusLine | null {
    const row = this.db.prepare(`${SELECT_LINE} WHERE l.id = ?`).get(id) as CorpusRow | undefined;
    return row ? toLine(row, this.relations, this.corpusId) : null;
  }

  /** 取同场景前后各 radius 行，用于参考台词的上下文。 */
  context(line: CorpusLine, radius = 1): CorpusLine[] {
    if (line.scene.startsWith('curated:')) return [line];
    const rows = this.db
      .prepare(`${SELECT_LINE} WHERE l.scene = ? AND l.seq BETWEEN ? AND ? ORDER BY l.seq ASC`)
      .all(line.scene, line.seq - radius, line.seq + radius) as unknown as CorpusRow[];
    return rows.map((row) => toLine(row, this.relations, this.corpusId));
  }

  stats(): CorpusStats {
    const one = (sql: string) => Number((this.db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
    return {
      lines: one('SELECT COUNT(*) AS n FROM lines'),
      translated: one('SELECT COUNT(*) AS n FROM translations'),
      curated: one("SELECT COUNT(*) AS n FROM line_meta WHERE kind IN ('line','snippet')"),
      corpora: 1,
    };
  }

  close(): void {
    this.db.close();
  }

  private score(line: CorpusLine, query: string, terms: string[], opts: SearchOptions): number {
    const q = query.toLowerCase();
    let score = 0;

    if (line.textZh?.toLowerCase().includes(q)) score += 100;
    if (line.textJa.toLowerCase().includes(q)) score += 80;
    if ((line.textZh ?? '').trim() === query.trim()) score += 40;
    if (line.textJa.trim() === query.trim()) score += 40;

    for (const term of terms) {
      const t = term.toLowerCase();
      if (line.textZh?.toLowerCase().includes(t)) score += 15;
      if (line.textJa.toLowerCase().includes(t)) score += 10;
    }

    if (opts.relation && line.relation === opts.relation) score += 20;
    if (opts.tags?.length) score += line.tags.filter((t) => opts.tags!.includes(t)).length * 15;
    if (opts.emotion && line.emotion?.toLowerCase().includes(opts.emotion.toLowerCase())) score += 10;
    if (line.kind === 'snippet') score += 5;
    if (line.sceneType === 'main') score += 5;
    else if (line.sceneType === 'support') score += 3;
    if (line.textJa.length <= 60) score += 2;
    return score;
  }
}

/**
 * 一个角色可以绑定多个 corpus。这里负责跨库检索、合并排序和上下文分发。
 */
export class CorpusLibrary {
  constructor(private readonly stores: CorpusStore[]) {}

  get enabled(): boolean {
    return this.stores.length > 0;
  }

  get corpusIds(): string[] {
    return this.stores.map((store) => store.corpusId);
  }

  search(query: string, opts: SearchOptions = {}): CorpusLine[] {
    const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
    const merged: ScoredLine[] = [];

    for (const store of this.stores) {
      merged.push(...store.searchScored(query, { ...opts, limit }));
    }

    merged.sort((a, b) => b.score - a.score);

    const seen = new Set<string>();
    const result: CorpusLine[] = [];
    for (const item of merged) {
      const key = `${item.line.corpusId}:${item.line.textJa.replace(/\s+/g, '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(item.line);
      if (result.length >= limit) break;
    }
    return result;
  }

  searchByTags(tags: string[], opts: SearchOptions = {}): CorpusLine[] {
    const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
    const merged: CorpusLine[] = [];
    for (const store of this.stores) {
      merged.push(...store.searchByTags(tags, { ...opts, limit }));
    }
    const seen = new Set<string>();
    const result: CorpusLine[] = [];
    for (const line of merged) {
      const key = `${line.corpusId}:${line.textJa.replace(/\s+/g, '')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(line);
      if (result.length >= limit) break;
    }
    return result;
  }

  context(line: CorpusLine, radius = 1): CorpusLine[] {
    const store = this.stores.find((item) => item.corpusId === line.corpusId);
    return store ? store.context(line, radius) : [line];
  }

  stats(): CorpusStats {
    return this.stores.reduce<CorpusStats>(
      (acc, store) => {
        const stats = store.stats();
        return {
          lines: acc.lines + stats.lines,
          translated: acc.translated + stats.translated,
          curated: acc.curated + stats.curated,
          corpora: acc.corpora + 1,
        };
      },
      { lines: 0, translated: 0, curated: 0, corpora: 0 },
    );
  }

  close(): void {
    for (const store of this.stores) store.close();
  }
}

export function openCorpusStore(
  path: string,
  corpusId: string,
  speakers: string[],
  relations: Record<string, string>,
): CorpusStore | null {
  if (!existsSync(path)) return null;
  try {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 3000;');
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lines'")
      .get() as { name?: string } | undefined;
    if (!table) {
      db.close();
      return null;
    }
    return new CorpusStore(db, corpusId, speakers, relations);
  } catch (err) {
    log.warn('open failed', { corpusId, error: (err as Error).message });
    return null;
  }
}

export function openCorpusLibrary(
  bindings: CorpusBinding[],
  corpora: Map<string, CorpusDefinition>,
  relations: Record<string, string>,
): CorpusLibrary | null {
  const stores: CorpusStore[] = [];
  for (const binding of bindings) {
    const def = corpora.get(binding.id);
    if (!def) {
      log.warn('character corpus binding not found', { corpusId: binding.id });
      continue;
    }
    const store = openCorpusStore(def.dbPath, def.id, binding.speakers, relations);
    if (!store) {
      log.warn('corpus.db missing', { corpusId: def.id, path: def.dbPath });
      continue;
    }
    stores.push(store);
  }
  return stores.length > 0 ? new CorpusLibrary(stores) : null;
}
