import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Db } from './db';
import type { Scope } from './messages';
import { parseScope } from './messages';

function readSafe(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}

function writeSafe(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function scopeKey(scope: Scope): string {
  const { kind, id } = parseScope(scope);
  return `${kind === 'group' ? 'group' : 'user'}_${id}`;
}

/**
 * 长期记忆：summarizer 写 MD，同时把版本写入 memories 表。
 * 群友印象不在这里，见 store/impressions.ts。
 */
export class MemoryStore {
  constructor(
    private readonly db: Db,
    private readonly memoryDir: string,
    private readonly characterId: string,
  ) {}

  memoryPath(scope: Scope): string {
    return resolve(this.memoryDir, `${scopeKey(scope)}.md`);
  }

  loadMemory(scope: Scope): string {
    return readSafe(this.memoryPath(scope)).trim();
  }

  saveMemory(scope: Scope, content: string): void {
    const body = `# ${scopeKey(scope)} 记忆\n\n${content.trim()}\n`;
    writeSafe(this.memoryPath(scope), body);
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM memories WHERE character_id = ? AND scope = ?')
      .get(this.characterId, scope) as { v: number | null } | undefined;
    const next = Number(row?.v ?? 0) + 1;
    this.db
      .prepare('INSERT INTO memories (character_id, scope, version, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(this.characterId, scope, next, content.trim(), Date.now());
  }

  memoryVersions(scope: Scope): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE character_id = ? AND scope = ?')
      .get(this.characterId, scope) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  /** 关键词检索 MD 记忆，供 LLM 主动回溯已总结内容。 */
  searchMemory(scope: Scope, keyword: string, limit = 8): string {
    const text = this.loadMemory(scope);
    if (!text) return '';
    const needle = keyword.toLowerCase();
    const hits = text
      .split('\n')
      .filter((line) => line.trim() && line.toLowerCase().includes(needle))
      .slice(0, limit);
    return hits.join('\n');
  }
}
