import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

/**
 * 群友印象：每个角色、每个群一份 MD，存的是主观判断，不是客观事实。
 * 和长期记忆分开，因为生命周期不同：印象由工具低频更新，没有版本/cursor。
 */
export class ImpressionStore {
  constructor(private readonly impressionsDir: string) {}

  impressionPath(groupId: number): string {
    return resolve(this.impressionsDir, `group_${groupId}.md`);
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
    const start = lines.findIndex((line) => line.startsWith('## ') && line.includes(marker));

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
}
