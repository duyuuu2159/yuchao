import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type * as z from 'zod';

// 调用大模型的一层薄封装。画像流程只依赖 LlmClient 接口，测试时换成假的实现。

export interface Usage {
  input: number;
  output: number;
}

export interface JsonRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
}

export interface LlmClient {
  readonly model: string;
  json<T>(req: JsonRequest<T>): Promise<{ data: T; usage: Usage }>;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface AnthropicOptions {
  model?: string;
  /** 读取 ~/.claude/settings.json 里 Claude Code 已配置的地址和令牌（例如中转站） */
  claudeCodeConfig?: string;
  /** 模型拒答时由服务端换模型重试。中转站可能不支持这个参数，可以关掉 */
  fallbacks?: boolean;
}

/** 只取连接用的两项，不读其他配置 */
export function readClaudeCodeConnection(settingsPath: string): { baseURL?: string; authToken?: string; apiKey?: string } {
  const env = JSON.parse(readFileSync(settingsPath, 'utf8')).env ?? {};
  return {
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    authToken: env.ANTHROPIC_AUTH_TOKEN || undefined,
    apiKey: env.ANTHROPIC_API_KEY || undefined,
  };
}

export function claudeCodeSettingsPath(claudeDir: string): string {
  return join(claudeDir, 'settings.json');
}

export class AnthropicLlm implements LlmClient {
  readonly model: string;
  private readonly client: Anthropic;
  private readonly fallbacks: boolean;

  constructor(opts: AnthropicOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.fallbacks = opts.fallbacks ?? true;
    // 不传参数时，SDK 自己从环境变量读取 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL
    this.client = opts.claudeCodeConfig ? new Anthropic(readClaudeCodeConnection(opts.claudeCodeConfig)) : new Anthropic();
  }

  /** 列出接口上可用的模型，用来确认中转站上 Claude 模型的名字 */
  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    for await (const m of this.client.models.list()) ids.push(m.id);
    return ids;
  }

  async json<T>(req: JsonRequest<T>): Promise<{ data: T; usage: Usage }> {
    const res = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      ...(this.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      output_config: { effort: req.effort ?? 'medium', format: betaZodOutputFormat(req.schema) },
      // 系统提示词每次都一样，缓存后后续请求只按缓存价格计费
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: req.user }],
    });
    if (res.stop_reason === 'refusal') throw new Error(`模型拒绝回答（${res.stop_details?.category ?? '未说明原因'}）`);
    if (res.stop_reason === 'max_tokens') throw new Error('模型输出被截断（达到 max_tokens），请调大上限');
    if (!res.parsed_output) throw new Error('模型返回的内容不符合要求的格式');
    return { data: res.parsed_output as T, usage: { input: res.usage.input_tokens, output: res.usage.output_tokens } };
  }
}
