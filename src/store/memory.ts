import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Db } from './db';
import type { Scope } from './messages';
import { parseScope } from './messages';

export interface MemoryPaths {
  memoryDir: string;
  impressionsDir: string;
}

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

export class MemoryStore {
  constructor(
    private readonly db: Db,
    private readonly paths: MemoryPaths,
  ) {}

  memoryPath(scope: Scope): string {
    return resolve(this.paths.memoryDir, `${scopeKey(scope)}.md`);
  }

  impressionPath(groupId: number): string {
    return resolve(this.paths.impressionsDir, `group_${groupId}.md`);
  }

  loadMemory(scope: Scope): string {
    return readSafe(this.memoryPath(scope)).trim();
  }

  saveMemory(scope: Scope, content: string): void {
    const body = `# ${scopeKey(scope)} 记忆\n\n${content.trim()}\n`;
    writeSafe(this.memoryPath(scope), body);
    const row = this.db.prepare('SELECT MAX(version) AS v FROM memories WHERE scope = ?').get(scope) as
      | { v: number | null }
      | undefined;
    const next = Number(row?.v ?? 0) + 1;
    this.db
      .prepare('INSERT INTO memories (scope, version, content, created_at) VALUES (?, ?, ?, ?)')
      .run(scope, next, content.trim(), Date.now());
  }

  memoryVersions(scope: Scope): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE scope = ?').get(scope) as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }

  loadImpressions(groupId: number): string {
    return readSafe(this.impressionPath(groupId)).trim();
  }

  getImpression(groupId: number, userId: number): string {
    const lines = readSafe(this.impressionPath(groupId)).split('\n');
    const marker = `（${userId}）`;
    const start = lines.findIndex((line) => line.startsWith('## ') && line.includes(marker));
    if (start === -1) return '';
    let end = start + 1;
    while (end < lines.length && !lines[end]!.startsWith('## ')) end++;
    return lines.slice(start + 1, end).join('\n').trim();
  }

  /** 按节更新某个群友的印象；同一 uid 的旧小节会被整段替换。 */
  upsertImpression(groupId: number, userId: number, nickname: string, content: string): void {
    const path = this.impressionPath(groupId);
    const raw = readSafe(path);
    const header = `# 群 ${groupId} 印象簿`;
    const lines = raw ? raw.split('\n') : [header, ''];
    const marker = `（${userId}）`;
    let start = lines.findIndex((line) => line.startsWith('## ') && line.includes(marker));

    if (start === -1) {
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      lines.push('', `## ${nickname}${marker}`, content.trim(), '');
    } else {
      let end = start + 1;
      while (end < lines.length && !lines[end]!.startsWith('## ')) end++;
      lines.splice(start, end - start, `## ${nickname}${marker}`, content.trim(), '');
    }

    writeSafe(path, lines.join('\n'));
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
