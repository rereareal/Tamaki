import { parseScope } from '../store/messages';
import { registerTool } from './registry';

let registered = false;

export function registerBuiltinTools(): void {
  if (registered) return;
  registered = true;

  registerTool({
    name: 'update_impression',
    description:
      '更新当前群里某个群友的印象簿小节。当你对某人的性格、偏好、说话方式有了稳定判断时调用；不要记录一次性寒暄。',
    parameters: {
      type: 'object',
      properties: {
        user_id: { type: 'integer', description: '群友 QQ 号' },
        nickname: { type: 'string', description: '群昵称/名片' },
        content: { type: 'string', description: '该群友的印象内容，2-5 句，中文' },
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
        const old = ctx.memory.getImpression(groupId, userId);
        if (old) content = `${old}\n${content}`;
      }
      ctx.memory.upsertImpression(groupId, userId, nickname, content);
      return { updated: true, path: ctx.memory.impressionPath(groupId) };
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
