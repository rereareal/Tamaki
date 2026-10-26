export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type LLMCall = (messages: ChatMessage[], tools?: ToolSchema[]) => Promise<ChatMessage>;

import type { ToolContext } from './registry';
import { logger } from '../log';

const log = logger.child('tools');
import { getTool, listToolSchemas } from './registry';

const DEFAULT_TOOL_TIMEOUT = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`tool timeout after ${ms}ms: ${name}`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * OpenAI function calling 循环：最多 maxRounds 轮。
 * tool 错误统一转成 role:'tool' 消息回灌，不抛到业务层。
 */
export async function runWithTools(
  messages: ChatMessage[],
  ctx: ToolContext,
  callLLM: LLMCall,
  maxRounds = 5,
): Promise<string> {
  const convo: ChatMessage[] = [...messages];
  const schemas = listToolSchemas(ctx.isAdmin);

  for (let round = 0; round < maxRounds; round++) {
    const reply = await callLLM(convo, schemas);
    convo.push(reply);

    const calls = reply.tool_calls ?? [];
    if (calls.length === 0) return reply.content?.trim() ?? '';

    for (const call of calls) {
      const name = call.function?.name ?? '';
      const tool = getTool(name);
      log.info('tool call', { name, round: round + 1 });
      let payload: string;

      try {
        if (!tool) throw new Error(`unknown tool: ${name}`);
        if (tool.adminOnly && !ctx.isAdmin) throw new Error(`permission denied: ${name}`);

        let args: Record<string, any> = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          throw new Error(`invalid tool arguments for ${name}`);
        }

        const result = await withTimeout(
          tool.execute(args, ctx),
          tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT,
          name,
        );
        payload = JSON.stringify({ ok: true, result: result ?? null });
      } catch (err) {
        const message = (err as Error).message;
        log.warn('tool failed', { name, error: message });
        payload = JSON.stringify({ ok: false, error: message });
      }

      convo.push({
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: payload.slice(0, 4000),
      });
    }
  }

  log.warn('max tool rounds reached', { maxRounds });
  return '';
}
