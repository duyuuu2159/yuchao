import * as z from 'zod';
import type { JsonRequest, LlmClient, Usage } from './llm.ts';

// OpenAI 兼容接口（/v1/chat/completions）。很多中转站只提供这种格式和 GPT 系列模型。
// 用 JSON Schema 约束输出格式，返回后再用 zod 校验一遍，不信任接口一定遵守。

export interface OpenAiOptions {
  baseURL: string;
  apiKey: string;
  model: string;
  /** 单次请求超时，默认 5 分钟 */
  timeoutMs?: number;
  /** 429 和 5xx 的重试次数 */
  maxRetries?: number;
}

export class OpenAiCompatibleLlm implements LlmClient {
  readonly model: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(opts: OpenAiOptions) {
    this.model = opts.model;
    this.url = opts.baseURL.replace(/\/+$/, '').replace(/(\/v1)?$/, '/v1') + '/chat/completions';
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  async json<T>(req: JsonRequest<T>): Promise<{ data: T; usage: Usage }> {
    // JSON Schema 里的整数范围对模型没有意义，只会占 token
    const schema = JSON.parse(JSON.stringify(z.toJSONSchema(req.schema), (k, v) => (k === 'minimum' || k === 'maximum' || k === '$schema' ? undefined : v)));
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? 16000,
      messages: [
        { role: 'system', content: req.system + '\n\n只输出符合要求格式的 JSON，不要输出其他文字。' },
        { role: 'user', content: req.user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'result', schema, strict: true } },
    };

    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.maxRetries) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    const payload: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${payload?.error?.message ?? res.statusText}`);

    const choice = payload.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('模型输出被截断（达到 max_tokens），请调大上限');
    const text: string = choice?.message?.content ?? '';
    // 有的模型会把 JSON 包在 ```json 代码块里
    const raw = text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('模型返回的不是合法的 JSON');
    }
    const checked = req.schema.safeParse(parsed);
    if (!checked.success) throw new Error(`模型返回的内容不符合要求的格式：${checked.error.issues[0]?.message}`);
    return { data: checked.data, usage: { input: payload.usage?.prompt_tokens ?? 0, output: payload.usage?.completion_tokens ?? 0 } };
  }
}
