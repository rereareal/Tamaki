/**
 * 把日文台词批量翻译成中文，写入 data/corpora/<corpus-id>/corpus.db 的 translations 表。
 * 本仓库不包含任何译文；脚本默认 dry-run 友好，实际运行需要 LLM_API_KEY。
 *
 * 用法：
 *   tsx scripts/translate-corpus.ts --character example --corpus gakuen --dry-run
 *   tsx scripts/translate-corpus.ts --character example --corpus gakuen --batch 40
 *   # 角色只绑定一个 corpus 时 --corpus 可省略
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CharacterMeta } from '../src/character/loader';

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith('--')) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function loadMeta(charactersDir: string, characterId: string): CharacterMeta {
  const path = join(charactersDir, characterId, 'meta.json');
  if (!existsSync(path)) throw new Error(`character meta not found: ${path}`);
  const meta = JSON.parse(readFileSync(path, 'utf8')) as CharacterMeta;
  if (!meta.id) throw new Error(`missing id in ${path}`);
  return meta;
}

function loadGlossary(charactersDir: string, characterId: string, meta: CharacterMeta): Record<string, string> {
  const path = join(charactersDir, characterId, 'glossary.json');
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    } catch {
      /* ignore */
    }
  }
  return meta.glossary ?? {};
}

function systemPrompt(displayName: string, glossary: Record<string, string>): string {
  const terms = Object.entries(glossary)
    .map(([ja, zh]) => `${ja} => ${zh}`)
    .join('\n');
  return [
    `你是日文到中文的台词翻译，正在翻译角色「${displayName}」的台词。`,
    '要求：自然口语中文；保留语气、省略号、口癖；不要合并或拆分句子；不要解释；不要添加原文没有的信息。',
    terms ? `术语表：\n${terms}` : '',
    '只输出 JSON，格式：{"items":[{"id":"...","zh":"..."}]}',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function extractJson(text: string): any {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in response');
  return JSON.parse(text.slice(start, end + 1));
}

async function callLLM(
  baseUrl: string,
  apiKey: string,
  model: string,
  system: string,
  items: { id: string; ja: string }[],
): Promise<{ id: string; zh: string }[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify({ items }) },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as any;
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('empty LLM response');
  const parsed = extractJson(content);
  if (!Array.isArray(parsed?.items)) throw new Error('LLM JSON missing items');
  return parsed.items
    .filter((item: any) => item && typeof item.id === 'string' && typeof item.zh === 'string')
    .map((item: any) => ({ id: item.id, zh: item.zh.trim() }))
    .filter((item: { zh: string }) => item.zh.length > 0);
}

async function main(): Promise<void> {
  const characterId = arg('character');
  if (!characterId) throw new Error('--character is required');
  const charactersDir = arg('characters', process.env.CHARACTERS_DIR ?? 'data/characters')!;
  const corporaDir = arg('corpora', process.env.CORPORA_DIR ?? 'data/corpora')!;
  const batchSize = Math.max(1, Math.min(100, Number(arg('batch', '40')) || 40));
  const limit = Math.max(0, Number(arg('limit', '0')) || 0);
  const dryRun = flag('dry-run');
  const force = flag('force');

  const meta = loadMeta(charactersDir, characterId);
  const bindings = meta.corpora ?? [];
  let corpusId = arg('corpus');
  if (!corpusId) {
    if (bindings.length === 1) corpusId = bindings[0]!.id;
    else throw new Error(`--corpus is required (bindings: ${bindings.map((b) => b.id).join(', ') || 'none'})`);
  }
  const binding = bindings.find((item) => item.id === corpusId);
  if (!binding) throw new Error(`character "${characterId}" is not bound to corpus "${corpusId}"`);
  const speakers = (binding.speakers ?? []).filter(Boolean);
  if (speakers.length === 0) throw new Error(`no speakers for corpus "${corpusId}" in ${characterId}/meta.json`);

  const corpusPath = arg('corpus-db', join(corporaDir, corpusId, 'corpus.db'))!;
  if (!existsSync(corpusPath)) throw new Error(`corpus db not found: ${corpusPath}`);
  const glossary = loadGlossary(charactersDir, characterId, meta);

  const db = new DatabaseSync(corpusPath);
  db.exec('PRAGMA busy_timeout = 3000;');

  const speakerMarks = speakers.map(() => '?').join(',');
  const sql = force
    ? `SELECT l.id, l.scene, l.text_ja
       FROM lines l
       WHERE l.speaker IN (${speakerMarks})
       ORDER BY l.scene, l.seq`
    : `SELECT l.id, l.scene, l.text_ja
       FROM lines l
       LEFT JOIN translations t ON t.line_id = l.id
       WHERE l.speaker IN (${speakerMarks}) AND t.line_id IS NULL
       ORDER BY l.scene, l.seq`;
  const rows = db.prepare(sql).all(...speakers) as unknown as {
    id: string;
    scene: string;
    text_ja: string;
  }[];

  // 同一句日文只翻一次，再映射回多个 line id。
  const unique = new Map<string, { scene: string; text: string; ids: string[] }>();
  for (const row of rows) {
    const key = row.text_ja.replace(/\s+/g, '');
    const existing = unique.get(key);
    if (existing) existing.ids.push(row.id);
    else unique.set(key, { scene: row.scene, text: row.text_ja, ids: [row.id] });
  }

  let entries = [...unique.values()];
  if (limit > 0) entries = entries.slice(0, limit);

  console.log(
    `[translate] character=${characterId} corpus=${corpusId} lines=${rows.length} unique=${unique.size} todo=${entries.length} batch=${batchSize}`,
  );

  if (entries.length === 0) {
    console.log('[translate] nothing to do');
    db.close();
    return;
  }

  const system = systemPrompt(meta.displayName || meta.id, glossary);

  if (dryRun) {
    const preview = entries.slice(0, Math.min(3, entries.length)).map((entry, index) => ({
      id: String(index + 1),
      ja: entry.text,
    }));
    console.log('[translate] dry-run, no API call');
    console.log(system);
    console.log(JSON.stringify({ items: preview }, null, 2));
    db.close();
    return;
  }

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error('LLM_API_KEY is required (or use --dry-run)');
  }
  const baseUrl = arg('base-url', process.env.LLM_BASE_URL ?? 'https://api.deepseek.com/v1')!;
  const model = arg('model', process.env.LLM_MODEL ?? 'deepseek-flash')!;

  const upsert = db.prepare(
    `INSERT INTO translations (line_id, text_zh, source, model, updated_at)
     VALUES (?, ?, 'llm', ?, ?)
     ON CONFLICT(line_id) DO UPDATE SET
       text_zh = excluded.text_zh,
       source = excluded.source,
       model = excluded.model,
       updated_at = excluded.updated_at`,
  );

  let translated = 0;
  let failed = 0;

  for (let offset = 0; offset < entries.length; offset += batchSize) {
    const batch = entries.slice(offset, offset + batchSize);
    const items = batch.map((entry, index) => ({ id: String(index + 1), ja: entry.text }));
    let result: { id: string; zh: string }[] | null = null;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result = await callLLM(baseUrl, apiKey, model, system, items);
        break;
      } catch (err) {
        lastError = err as Error;
        console.error(`[translate] batch ${offset / batchSize + 1} attempt ${attempt} failed: ${lastError.message}`);
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }

    if (!result) {
      failed++;
      continue;
    }

    const byId = new Map(result.map((item) => [item.id, item.zh]));
    db.exec('BEGIN');
    try {
      for (let i = 0; i < batch.length; i++) {
        const entry = batch[i]!;
        const zh = byId.get(String(i + 1));
        if (!zh) continue;
        for (const lineId of entry.ids) {
          upsert.run(lineId, zh, model, Date.now());
        }
        translated++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    console.log(
      `[translate] ${Math.min(offset + batchSize, entries.length)}/${entries.length} unique lines done (${translated} translated)`,
    );
  }

  const count = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM translations').get() as { n: number } | undefined)?.n ?? 0,
  );
  console.log(`[translate] finished, translations=${count}, failedBatches=${failed}`);
  db.close();
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[translate] fatal:', (err as Error).message);
  process.exit(1);
});
