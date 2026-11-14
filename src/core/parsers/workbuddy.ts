import { basename } from 'node:path';
import { readJsonl } from '../lines.ts';
import { titleFrom, toText } from '../text.ts';
import { workbuddyFailed } from '../toolstatus.ts';
import { clip, type Role, type Session } from '../types.ts';
import { deepFind, deepFindObject, UsageTally } from '../usage.ts';

/**
 * 解析 WorkBuddy（腾讯 CodeBuddy 系的桌面 agent）的会话文件：
 *   ~/.workbuddy/projects/<工作目录>/<sessionId>.jsonl
 * 目录布局和 Claude Code 一样，但每条记录是 OpenAI Agents 风格的条目：
 *   message(user|assistant) / function_call / function_call_result / reasoning / ai-title
 * 用户消息里混着大段系统提示，用户亲手写的话包在 <user_query> 里。
 */
export async function parseWorkBuddyFile(path: string): Promise<Session> {
  const nativeId = basename(path, '.jsonl');
  const session: Session = {
    id: `workbuddy:${nativeId}`,
    agent: 'workbuddy',
    nativeId,
    parentId: null,
    title: null,
    cwd: null,
    startedAt: null,
    updatedAt: null,
    archived: false,
    sourcePath: path,
    messages: [],
    usage: [],
  };
  const tally = new UsageTally();

  let firstUserText: string | null = null;
  const push = (ts: string | null, role: Role, text: string, toolName: string | null = null, failed: boolean | null = null) => {
    if (!text.trim()) return;
    session.messages.push({ seq: session.messages.length, ts, role, toolName, text, failed });
  };

  for await (const rec of readJsonl(path)) {
    const ts = typeof rec.timestamp === 'number' ? new Date(rec.timestamp).toISOString() : null;
    if (ts) {
      session.startedAt ??= ts;
      session.updatedAt = ts;
    }
    // 用量记在 agent 的回复上，OpenAI 的口径：inputTokens 已经包含命中缓存的部分
    if (rec.type === 'message' && rec.role === 'assistant') {
      const u = deepFindObject(rec, 'usage');
      if (u) {
        const cached = (u.inputTokensDetails ?? []).reduce((n: number, d: any) => n + (d?.cached_tokens ?? 0), 0);
        tally.add(deepFind(rec, 'model'), { input: u.inputTokens, output: u.outputTokens, cacheRead: cached }, u.requests ?? 1);
      }
    }
    if (!session.cwd && typeof rec.cwd === 'string') session.cwd = rec.cwd;

    switch (rec.type) {
      case 'ai-title':
        if (rec.aiTitle) session.title = rec.aiTitle;
        break;
      case 'message': {
        const parts = Array.isArray(rec.content) ? rec.content : [];
        if (rec.role === 'assistant') {
          push(ts, 'assistant', toText(parts.filter((c: any) => c.type === 'output_text')));
        } else if (rec.role === 'user') {
          const raw = toText(parts.filter((c: any) => c.type === 'input_text'));
          const query = extractUserQuery(raw);
          if (query === null) push(ts, 'context', clip(stripReminders(raw)));
          else {
            push(ts, 'user', query);
            if (query && firstUserText === null) firstUserText = query;
          }
        }
        break;
      }
      case 'function_call':
        push(ts, 'tool_call', clip(toText(rec.arguments)), rec.name ?? null);
        break;
      case 'function_call_result':
        {
          const out = toText(rec.output?.text ?? rec.output);
          push(ts, 'tool_result', clip(out), null, workbuddyFailed(rec.status, out));
        }
        break;
      // reasoning 是模型的思考过程，和 Claude 的 thinking 一样不收录
    }
  }

  session.title ??= firstUserText ? titleFrom(firstUserText) : null;
  session.usage = tally.list();
  return session;
}

/**
 * 取出 <user_query> 里的内容；没有这个标签的「用户消息」是客户端注入的（模式切换提示等）。
 * - 压缩上下文时生成的 <cb_summary> 会把之前每一句 <user_query> 原样重放，整条算上下文，否则会重复计数
 * - <user_query> 里偶尔也夹着 <system-reminder>（工具出错后的恢复提示），要剥掉
 * - 粘贴截图时会带上 `@image#1:文件名` 引用，只保留文字
 */
export function extractUserQuery(text: string): string | null {
  if (text.includes('<cb_summary>')) return null;
  const queries = [...text.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map((m) => m[1]);
  if (!queries.length) return null;
  return stripReminders(queries.join('\n'))
    .replace(/@image#\d+:\S+/g, '')
    .trim();
}

function stripReminders(text: string): string {
  return text.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '').trim();
}
