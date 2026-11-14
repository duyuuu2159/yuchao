import { readJsonl } from '../lines.ts';
import { extractCodexRequest, isCodexContext, stripImageTags, titleFrom, toText } from '../text.ts';
import { codexFailed } from '../toolstatus.ts';
import { clip, type Role, type Session } from '../types.ts';
import { UsageTally } from '../usage.ts';

/**
 * 解析 Codex 的会话文件：
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl(.zst)
 *   ~/.codex/archived_sessions/...                      （已归档）
 * 会话标题不在会话文件里，而在 ~/.codex/session_index.jsonl，由调用方传入。
 */
export async function parseCodexFile(path: string, titles: Map<string, string> = new Map()): Promise<Session> {
  const session: Session = {
    id: '',
    agent: 'codex',
    nativeId: '',
    parentId: null,
    title: null,
    cwd: null,
    startedAt: null,
    updatedAt: null,
    archived: /[\\/]archived_sessions[\\/]/.test(path),
    sourcePath: path,
    messages: [],
    usage: [],
  };
  const tally = new UsageTally();
  let model: string | null = null;
  let prevTotal: any = null;

  let firstUserText: string | null = null;
  const push = (ts: string | null, role: Role, text: string, toolName: string | null = null, failed: boolean | null = null) => {
    if (!text.trim()) return;
    session.messages.push({ seq: session.messages.length, ts, role, toolName, text, failed });
  };

  for await (const rec of readJsonl(path)) {
    const ts: string | null = rec.timestamp ?? null;
    if (ts) {
      session.startedAt ??= ts;
      session.updatedAt = ts;
    }
    const p = rec.payload ?? {};

    // 分叉出来的会话文件里会重复出现父会话的 session_meta，只认第一条
    if (rec.type === 'session_meta') {
      if (!session.nativeId) {
        session.nativeId = p.id ?? p.session_id;
        session.cwd = p.cwd ?? null;
        const parent = p.source?.subagent?.thread_spawn?.parent_thread_id ?? p.parent_thread_id;
        if (parent) session.parentId = `codex:${parent}`;
        if (p.agent_nickname) session.title = `子 agent · ${p.agent_nickname}`;
      }
      continue;
    }

    // 当前用的模型记在每一轮的 turn_context 里，中途可能切换
    if (rec.type === 'turn_context' && typeof p.model === 'string') model = p.model;

    // 用量：token_count 记的是累计值，和上一条相减得到这次请求的量；
    // 相减出现负数（例如压缩上下文后重新计数）时改用当次的 last_token_usage
    if (rec.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
      const t = p.info.total_token_usage;
      const d = prevTotal && {
        input: (t.input_tokens ?? 0) - (prevTotal.input_tokens ?? 0),
        output: (t.output_tokens ?? 0) - (prevTotal.output_tokens ?? 0),
        cacheRead: (t.cached_input_tokens ?? 0) - (prevTotal.cached_input_tokens ?? 0),
      };
      const last = p.info.last_token_usage ?? t;
      const u =
        d && d.input >= 0 && d.output >= 0
          ? d
          : { input: last.input_tokens, output: last.output_tokens, cacheRead: last.cached_input_tokens };
      // 同一个累计值可能连续出现两次，相减为 0 时不算一次请求
      if (u.input > 0 || u.output > 0) tally.add(model, u);
      prevTotal = t;
      continue;
    }

    if (rec.type === 'compacted') {
      push(ts, 'context', clip(toText(p.message)));
      continue;
    }
    if (rec.type !== 'response_item') continue;

    switch (p.type) {
      case 'message': {
        const text = toText((p.content ?? []).filter((c: any) => c.type === 'input_text' || c.type === 'output_text'));
        if (p.role === 'assistant') push(ts, 'assistant', text);
        else if (p.role === 'user') {
          if (isCodexContext(text)) push(ts, 'context', clip(text));
          else {
            const clean = stripImageTags(extractCodexRequest(text));
            push(ts, 'user', clean);
            if (clean && firstUserText === null) firstUserText = clean;
          }
        }
        // developer 角色是系统提示词，不收录
        break;
      }
      case 'agent_message':
        push(ts, 'context', clip(toText((p.content ?? []).filter((c: any) => c.type === 'input_text'))), `agent:${p.author}`);
        break;
      case 'function_call':
        push(ts, 'tool_call', clip(toText(p.arguments)), p.name ?? null);
        break;
      case 'custom_tool_call':
        push(ts, 'tool_call', clip(toText(p.input)), p.name ?? null);
        break;
      case 'web_search_call':
        push(ts, 'tool_call', toText(p.action?.query), 'web_search');
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
        {
          const out = toText(p.output);
          push(ts, 'tool_result', clip(out), null, codexFailed(out));
        }
        break;
    }
  }

  if (!session.nativeId) throw new Error('缺少 session_meta，无法识别会话');
  session.id = `codex:${session.nativeId}`;
  const indexed = titles.get(session.nativeId);
  session.usage = tally.list();
  if (indexed) session.title = indexed;
  else session.title ??= firstUserText ? titleFrom(firstUserText) : null;
  return session;
}

/** 读取 ~/.codex/session_index.jsonl，同一会话改名多次时以最后一条为准 */
export async function loadCodexTitles(indexPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    for await (const rec of readJsonl(indexPath)) {
      if (rec.id && rec.thread_name) map.set(rec.id, rec.thread_name);
    }
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  return map;
}
