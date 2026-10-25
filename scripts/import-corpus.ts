/**
 * 一次性导入日文剧情 CSV + 精选注释到 data/corpora/<corpus-id>/corpus.db。
 *
 * 用法：
 *   tsx scripts/import-corpus.ts --corpus gakuen
 *   tsx scripts/import-corpus.ts --corpus gakuen \
 *     --curated data/corpora/gakuen/curated/example.csv --character example
 *
 * 只导入日文原文；中文翻译由 translate-corpus.ts 另行写入。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { openCorpusDb } from '../src/character/corpus';
import type { CharacterMeta } from '../src/character/loader';

interface RawLine {
  id: string;
  scene: string;
  seq: number;
  speaker: string;
  textJa: string;
  sceneType: string;
  partner: string | null;
}

const CANONICAL_RELATIONS = new Set([
  '制作人',
  '同龄',
  '后辈',
  '家人',
  '对手',
  '年长',
  '粉丝',
  '陌生人',
]);

const TRIGGER_TAGS = new Set([
  '被夸外貌',
  '被夸能力',
  '被请客',
  '被说贪钱',
  '被轻视',
  '生气',
  '对方脱线',
  '聊家人',
]);

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith('--')) {
    return process.argv[idx + 1];
  }
  return fallback;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeText(text: string): string {
  return text
    .replace(/^﻿/, '')
    .replace(/\\n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function matchKey(text: string): string {
  return normalizeText(text)
    .normalize('NFKC')
    .replace(/[\s「」『』（）()]/g, '')
    .replace(/[!！?？。、，,\.…ー〜~～・:：;；]/g, '')
    .toLowerCase();
}

function walkCsv(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walkCsv(path));
    else if (stat.isFile() && name.toLowerCase().endsWith('.csv')) out.push(path);
  }
  return out;
}

function sceneOf(rawDir: string, file: string): string {
  const rel = relative(rawDir, file).split(sep).join('/');
  const at = rel.indexOf('adv/');
  return (at >= 0 ? rel.slice(at) : rel).replace(/\.csv$/i, '');
}

function sceneTypeOf(scene: string): string {
  if (scene.includes('/csprt-') || scene.startsWith('adv/csprt-')) return 'support';
  if (scene.includes('/unit/') || scene.includes('/event/')) return 'cameo';
  return 'main';
}

function cleanPartner(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[（(].*?[）)]/g, '').replace(/[—\-]+/g, '').trim();
  return cleaned || null;
}

function inferRelation(meta: CharacterMeta, partner: string | null): string | null {
  if (!partner) return null;
  if (CANONICAL_RELATIONS.has(partner)) return partner;
  return meta.relations?.[partner] ?? null;
}

function main(): void {
  const corpusId = arg('corpus');
  if (!corpusId) throw new Error('--corpus is required');
  const corporaDir = arg('corpora', process.env.CORPORA_DIR ?? 'data/corpora')!;
  const charactersDir = arg('characters', process.env.CHARACTERS_DIR ?? 'data/characters')!;
  const corpusDir = arg('corpus-dir', join(corporaDir, corpusId))!;
  const rawDir = arg('raw', join(corpusDir, 'raw'))!;
  const out = arg('out', join(corpusDir, 'corpus.db'))!;
  const curatedPath = arg('curated');
  const characterId = arg('character');

  if (!existsSync(rawDir)) throw new Error(`raw dir not found: ${rawDir}`);

  let meta: CharacterMeta | null = null;
  let bindingSpeakers: string[] = [];
  if (curatedPath) {
    if (!characterId) throw new Error('--curated requires --character');
    const metaPath = join(charactersDir, characterId, 'meta.json');
    if (!existsSync(metaPath)) throw new Error(`character meta not found: ${metaPath}`);
    meta = JSON.parse(readFileSync(metaPath, 'utf8')) as CharacterMeta;
    if (!meta.id) throw new Error(`missing id in ${metaPath}`);
    const binding = (meta.corpora ?? []).find((item) => item.id === corpusId);
    if (!binding) throw new Error(`character "${characterId}" is not bound to corpus "${corpusId}"`);
    bindingSpeakers = binding.speakers ?? [];
    if (bindingSpeakers.length === 0) throw new Error(`character "${characterId}" has no speakers for corpus "${corpusId}"`);
  }

  const db = openCorpusDb(out);
  db.exec(`
    DELETE FROM lines;
    DELETE FROM line_meta;
    DELETE FROM speakers;
    DELETE FROM meta;
  `);

  const insertLine = db.prepare(
    `INSERT OR REPLACE INTO lines (id, scene, seq, speaker, text_ja, scene_type, partner)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const speakerCounts = new Map<string, number>();
  const files = walkCsv(rawDir);
  let lineCount = 0;
  let sceneCount = 0;

  db.exec('BEGIN');
  try {
    for (const file of files) {
      const scene = sceneOf(rawDir, file);
      if (!scene) continue;
      const sceneType = sceneTypeOf(scene);
      const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
      const rows = parseCsv(text);

      const parsed: { seq: number; speaker: string; textJa: string }[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        if (row.length < 3) continue;
        const speaker = (row[1] ?? '').trim();
        const body = normalizeText(row[2] ?? '');
        if (!speaker || !body) continue;
        if (speaker === 'name' && body === 'text') continue;
        parsed.push({ seq: i, speaker, textJa: body });
      }
      if (parsed.length === 0) continue;
      sceneCount++;

      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i]!;
        let beforeIdx = -1;
        let afterIdx = -1;
        for (let j = i - 1; j >= 0; j--) {
          if (parsed[j]!.speaker !== item.speaker) {
            beforeIdx = j;
            break;
          }
        }
        for (let j = i + 1; j < parsed.length; j++) {
          if (parsed[j]!.speaker !== item.speaker) {
            afterIdx = j;
            break;
          }
        }
        const partner =
          beforeIdx < 0
            ? afterIdx >= 0
              ? parsed[afterIdx]!.speaker
              : null
            : afterIdx < 0
              ? parsed[beforeIdx]!.speaker
              : i - beforeIdx <= afterIdx - i
                ? parsed[beforeIdx]!.speaker
                : parsed[afterIdx]!.speaker;

        const id = `${scene}#${item.seq}`;
        insertLine.run(id, scene, item.seq, item.speaker, item.textJa, sceneType, partner);
        speakerCounts.set(item.speaker, (speakerCounts.get(item.speaker) ?? 0) + 1);
        lineCount++;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  for (const [name, count] of speakerCounts) {
    db.prepare('INSERT OR REPLACE INTO speakers (name, count) VALUES (?, ?)').run(name, count);
  }

  let curatedCount = 0;
  let syntheticCount = 0;
  if (curatedPath && meta) {
    if (!existsSync(curatedPath)) throw new Error(`curated csv not found: ${curatedPath}`);
    const rows = parseCsv(readFileSync(curatedPath, 'utf8').replace(/^﻿/, ''));
    const header = rows[0] ?? [];
    const index = (name: string) => header.indexOf(name);
    const col = {
      id: index('id'),
      relation: index('关系'),
      partner: index('对象'),
      scene: index('场景'),
      emotion: index('情绪'),
      ja: index('原文'),
      zh: index('中文'),
      note: index('备注'),
      source: index('出典'),
    };
    if (col.id < 0 || col.ja < 0) throw new Error(`unexpected curated header: ${header.join(',')}`);

    // 建立「归一化日文 -> line id」索引，只针对当前角色的台词
    const speakers = [...new Set(bindingSpeakers.filter(Boolean))];
    if (speakers.length === 0) throw new Error('character has no speakers for this corpus');
    const byText = new Map<string, string>();
    for (const row of db
      .prepare('SELECT id, text_ja FROM lines WHERE speaker IN (' + [...speakers].map(() => '?').join(',') + ')')
      .all(...speakers) as unknown as { id: string; text_ja: string }[]) {
      if (!byText.has(matchKey(row.text_ja))) byText.set(matchKey(row.text_ja), row.id);
    }

    const upsertMeta = db.prepare(
      `INSERT INTO line_meta (line_id, relation, tags, emotion, note, kind)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(line_id) DO UPDATE SET
         relation = excluded.relation,
         tags = excluded.tags,
         emotion = excluded.emotion,
         note = excluded.note,
         kind = excluded.kind`,
    );

    db.exec('BEGIN');
    try {
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r]!;
        const id = (row[col.id] ?? '').trim();
        if (!id || id.startsWith('AI')) continue;
        const rawJa = normalizeText(row[col.ja] ?? '');
        if (!rawJa || rawJa.includes('（无）')) continue;

        const relationRaw = (row[col.relation] ?? '').trim();
        const partner = cleanPartner(row[col.partner]);
        const relation = CANONICAL_RELATIONS.has(relationRaw)
          ? relationRaw
          : inferRelation(meta, partner);
        const tags = TRIGGER_TAGS.has(relationRaw) ? [relationRaw] : [];
        const emotion = (row[col.emotion] ?? '').trim() || null;
        const note = (row[col.note] ?? '').trim() || null;

        let lineId = byText.get(matchKey(rawJa));
        if (!lineId) {
          const pieces = rawJa.split(/(?<=」)/).map((s) => s.trim()).filter(Boolean);
          for (const piece of pieces) {
            lineId = byText.get(matchKey(piece));
            if (lineId) break;
          }
        }

        if (!lineId) {
          lineId = `curated:${id}`;
          const syntheticScene = `curated:${id}`;
          const speaker = bindingSpeakers[0] ?? meta.id;
          insertLine.run(lineId, syntheticScene, 0, speaker, rawJa, 'curated', partner);
          syntheticCount++;
        }

        upsertMeta.run(
          lineId,
          relation,
          JSON.stringify(tags),
          emotion,
          note,
          lineId.startsWith('curated:') ? 'snippet' : 'line',
        );
        curatedCount++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  db.exec('DELETE FROM translations WHERE line_id NOT IN (SELECT id FROM lines)');
  db.exec('DELETE FROM speakers');
  db.exec('INSERT INTO speakers (name, count) SELECT speaker, COUNT(*) FROM lines GROUP BY speaker');

  const one = (sql: string) => Number((db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
  const translated = one('SELECT COUNT(*) AS n FROM translations');
  const metaRows: [string, string][] = [
    ['importedAt', String(Date.now())],
    ['rawDir', rawDir],
    ['lines', String(lineCount)],
    ['scenes', String(sceneCount)],
    ['curated', String(curatedCount)],
    ['synthetic', String(syntheticCount)],
    ['translations', String(translated)],
  ];
  for (const [key, value] of metaRows) {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  console.log(
    `[import] lines=${lineCount} scenes=${sceneCount} curated=${curatedCount} synthetic=${syntheticCount} translations=${translated}`,
  );
  console.log(`[import] wrote ${out}`);
  db.close();
}

main();
