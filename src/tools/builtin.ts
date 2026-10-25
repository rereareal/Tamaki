import { parseScope } from '../store/messages';
import { registerTool } from './registry';

let registered = false;

export function registerBuiltinTools(): void {
  if (registered) return;
  registered = true;

  registerTool({
    name: 'update_impression',
    description:
      '更新当前群里某个群友的主观印象小节。写性格、沟通风格、边界、相处感受；标注不确定性，不要写可验证事实、隐私或敏感推断，也不要记录一次性寒暄。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'integer', description: '群友 QQ 号' },
        nickname: { type: 'string', description: '群昵称/名片' },
        content: { type: 'string', description: '主观印象，2-5 句，中文；允许以后被修正，不要写事实流水账' },
        mode: { type: 'string', enum: ['replace', 'append'], description: '默认 replace' },
      },
      required: ['user_id', 'content'],
    },
    async execute(args, ctx) {
      const { kind, id: groupId } = parseScope(ctx.scope);
      if (kind !== 'group') return { skipped: true, reason: '印象簿只按群维护，私聊不写入' };

      const userId = Number(args.user_id);
      if (!Number.isFinite(userId)) throw new Error('user_id must be a number');
      const nickname = String(args.nickname || (ctx.evt.user_id === userId ? ctx.evt.sender?.card || ctx.evt.sender?.nickname : '') || userId);
      let content = String(args.content ?? '').trim();
      if (!content) throw new Error('content is required');
      if (args.mode === 'append') {
        const old = ctx.impressions.getImpression(groupId, userId);
        if (old) content = `${old}\n${content}`;
      }
      ctx.impressions.upsertImpression(groupId, userId, nickname, content);
      return { updated: true, path: ctx.impressions.impressionPath(groupId) };
    },
  });


  registerTool({
    name: 'search_lines',
    description:
      '检索当前角色的日文台词库，返回原文与已有中文翻译。keyword 可用日文或中文；只借用语感，不要逐字照搬，也不要引用出典。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '检索词，日文或中文均可' },
        limit: { type: 'integer', description: '返回条数，1-10，默认 5' },
        relation: { type: 'string', description: '可选：制作人/同龄/后辈/家人/对手/年长/粉丝/陌生人' },
        emotion: { type: 'string', description: '可选：情绪关键词，包含匹配' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：被夸外貌/被夸能力/被请客/被说贪钱/被轻视/生气/对方脱线/聊家人',
        },
      },
      required: ['keyword'],
    },
    async execute(args, ctx) {
      const corpus = ctx.character.corpus;
      if (!corpus) return { skipped: true, reason: '台词库尚未导入（data/corpus.db 不存在）' };

      const keyword = String(args.keyword ?? '').trim();
      if (!keyword) throw new Error('keyword is required');
      const limit = Math.max(1, Math.min(10, Number(args.limit ?? 5) || 5));
      const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;

      const lines = corpus.search(keyword, {
        limit,
        relation: args.relation ? String(args.relation) : undefined,
        emotion: args.emotion ? String(args.emotion) : undefined,
        tags,
      });
      return {
        lines,
        note: '仅作语感参考，不要照搬，不要引用出典。',
      };
    },
  });

  registerTool({
    name: 'search_memory',

    description: '按关键词检索本会话已经总结进长期记忆的内容，用于回溯较早的约定或事件。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，如“生日”“游戏”“约定”' },
      },
      required: ['query'],
    },
    async execute(args, ctx) {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('query is required');
      const hits = ctx.memory.searchMemory(ctx.scope, query);
      return hits ? { hits } : { hits: '', note: '长期记忆中没有匹配内容' };
    },
  });
}
