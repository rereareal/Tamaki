import type { ChatMessage, LLMCall, ToolSchema } from './tools/runner';
import type { AppConfig } from './config';
import { logger } from './log';

const log = logger.child('llm');

export type { ChatMessage, LLMCall, ToolSchema };

export interface LLMOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  stub?: boolean;
}

/**
 * OpenAI 兼容客户端。默认 baseUrl 指向 DeepSeek，模型 deepseek-flash。
 * LLM_STUB=1 时不发网络请求，返回可预测文本，便于本地自测。
 */
export function createLLM(opts: LLMOptions): LLMCall {
  if (opts.stub) {
    return async (messages: ChatMessage[]) => {
      const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      const isSummary = messages.some((m) => m.role === 'system' && m.content?.includes('记忆整理器'));
      if (isSummary) {
        return {
          role: 'assistant',
          content: '群友喜欢猫；约定周五晚上一起打游戏；bot 被要求少用表情包。',
        };
      }
      if (lastUser.includes('总结')) {
        return { role: 'assistant', content: '（stub 总结）大家聊了猫和游戏。' };
      }
      return { role: 'assistant', content: `（stub 回复）收到：${lastUser.slice(0, 60)}` };
    };
  }

  let clientPromise: Promise<import('openai').default> | undefined;
  const getClient = async () => {
    if (!clientPromise) {
      clientPromise = import('openai').then(({ default: OpenAI }) => {
        return new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl });
      });
    }
    return clientPromise;
  };

  return async (messages: ChatMessage[], tools?: ToolSchema[]) => {
    const client = await getClient();
    const started = Date.now();
    let res: any;
    try {
      res = await client.chat.completions.create({
        model: opts.model,
        messages: messages as any,
        ...(tools && tools.length > 0 ? { tools: tools as any } : {}),
        temperature: 0.8,
      });
    } catch (err) {
      log.error('completion failed', err, { model: opts.model, ms: Date.now() - started });
      throw err;
    }
    log.debug('completion', { model: opts.model, ms: Date.now() - started, tools: tools?.length ?? 0 });
    const msg = res.choices[0]?.message;
    return {
      role: 'assistant',
      content: msg?.content ?? '',
      ...(msg?.tool_calls ? { tool_calls: msg.tool_calls as any } : {}),
    };
  };
}

export function createLLMFromConfig(cfg: AppConfig['llm']): LLMCall {
  return createLLM(cfg);
}
