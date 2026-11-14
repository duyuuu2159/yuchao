// token 用量：四家 agent 记录的口径各不一样，这里统一成一种。
//
//   input      这次请求发给模型的全部输入，包括命中缓存的部分
//   cacheRead  其中命中缓存的部分（通常便宜得多）
//   output     模型输出，包括思考过程
//
// 各家的原始字段：
//   Claude    input_tokens 不含缓存，另有 cache_creation_input_tokens、cache_read_input_tokens
//   Codex     input_tokens 已含 cached_input_tokens；记录的是累计值，要相减得到每次请求的量
//   WorkBuddy inputTokens 已含 inputTokensDetails[].cached_tokens（OpenAI 的口径）
//   DeepSeek Harness  只有 inputTokens / outputTokens

export interface ModelUsage {
  model: string;
  /** 请求次数 */
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** 按模型累加一个会话里的用量 */
export class UsageTally {
  private readonly byModel = new Map<string, ModelUsage>();

  add(model: string | null | undefined, u: { input?: unknown; output?: unknown; cacheRead?: unknown }, requests = 1) {
    const input = num(u.input);
    const output = num(u.output);
    if (!input && !output) return;
    const key = model?.trim() || '未知模型';
    const cur = this.byModel.get(key) ?? { model: key, requests: 0, input: 0, output: 0, cacheRead: 0 };
    cur.requests += requests;
    cur.input += input;
    cur.output += output;
    cur.cacheRead += Math.min(num(u.cacheRead), input);
    this.byModel.set(key, cur);
  }

  list(): ModelUsage[] {
    return [...this.byModel.values()].sort((a, b) => b.output + b.input - (a.output + a.input));
  }
}

/** 在一条记录里找某个键的第一个字符串值（各家把模型名放在不同的层级里） */
export function deepFind(obj: unknown, key: string, depth = 4): string | null {
  if (!obj || typeof obj !== 'object' || depth < 0) return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec[key] === 'string' && rec[key]) return rec[key] as string;
  for (const v of Object.values(rec)) {
    if (v && typeof v === 'object') {
      const hit = deepFind(v, key, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** 在一条记录里找某个键对应的第一个对象（WorkBuddy 的 usage 嵌在不同层级里） */
export function deepFindObject(obj: unknown, key: string, depth = 4): Record<string, any> | null {
  if (!obj || typeof obj !== 'object' || depth < 0) return null;
  const rec = obj as Record<string, unknown>;
  const v = rec[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, any>;
  for (const child of Object.values(rec)) {
    if (child && typeof child === 'object') {
      const hit = deepFindObject(child, key, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}
