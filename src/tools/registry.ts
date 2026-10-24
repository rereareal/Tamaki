import type { MessageEvent, MessageSegment } from '../types';
import type { MemoryStore } from '../store/memory';
import type { MessageStore, Scope } from '../store/messages';
import type { ToolSchema } from './runner';

export interface ToolContext {
  evt: MessageEvent;
  isAdmin: boolean;
  scope: Scope;
  store: MessageStore;
  memory: MemoryStore;
  botQQ: number;
  botName: string;
  /** 需要主动发消息时用（当前内置 tool 未使用）。 */
  reply?: (segments: MessageSegment[]) => Promise<void>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  adminOnly?: boolean;
  timeoutMs?: number;
  execute(args: Record<string, any>, ctx: ToolContext): Promise<unknown>;
}

const registry = new Map<string, Tool>();

export function registerTool(tool: Tool): void {
  if (registry.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`);
  registry.set(tool.name, tool);
}

export function getTool(name: string): Tool | undefined {
  return registry.get(name);
}

export function listTools(isAdmin: boolean): Tool[] {
  return [...registry.values()].filter((t) => !t.adminOnly || isAdmin);
}

export function listToolSchemas(isAdmin: boolean): ToolSchema[] {
  return listTools(isAdmin).map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function clearTools(): void {
  registry.clear();
}
