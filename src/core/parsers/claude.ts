import { basename } from 'node:path';
import { readJsonl } from '../lines.ts';
import { isClaudeContext, titleFrom, toText } from '../text.ts';
import { claudeFailed } from '../toolstatus.ts';
import { clip, type Role, type Session } from '../types.ts';
import { UsageTally } from '../usage.ts';

/**
 * 解析 Claude Code 的会话文件：
 *   ~/.claude/projects/<项目>/<sessionId>.jsonl
 *   ~/.claude/projects/<项目>/<sessionId>/subagents/agent-<id>.jsonl   （子 agent）
 *   ~/.claude/projects/<项目>/<sessionId>/subagents/workflows/<wf>/agent-<id>.jsonl   （工作流里的子 agent）
 */
export async function parseClaudeFile(path: string): Promise<Session> {
  const stem = basename(path, '.jsonl');
  // 路径里出现 subagents 目录就是子 agent，它前面一级是父会话的 id；层级可能不止一层
  const parts = path.split(/[\\/]/);
  const subIdx = parts.lastIndexOf('subagents');
  const isSub = subIdx > 0;
  const parentNative = isSub ? parts[subIdx - 1] : null;
  const nativeId = isSub ? `${parentNative}/${stem}` : stem;

  const session: Session = {
    id: `claude:${nativeId}`,
    agent: 'claude',
    nativeId,
    parentId: parentNative ? `claude:${parentNative}` : null,
    title: null,
    cwd: null,
    startedAt: null,
    updatedAt: null,
    archived: false,
    sourcePath: path,
    messages: [],
    usage: [],
  };
  // Claude Code 把一次回复的每个内容块各写成一行，每行带着同一份 usage，按消息 id 去重
  const usageById = new Map<string, { model: string | null; u: any }>();

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
    if (!session.cwd && typeof rec.cwd === 'string') session.cwd = rec.cwd;

    // 标题可能被改过多次，以最后一次为准
    if (rec.type === 'custom-title' && rec.customTitle) session.title = rec.customTitle;

    if (rec.type === 'assistant' && rec.message?.usage) {
      const id = rec.message.id ?? rec.uuid;
      if (id) usageById.set(id, { model: rec.message.model ?? null, u: rec.message.usage });
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const content = rec.message?.content;
    const meta = rec.isMeta === true || rec.isCompactSummary === true;

    if (rec.type === 'user') {
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const b of blocks) {
        if (b.type === 'text') {
          const context = meta || isClaudeContext(b.text);
          push(ts, context ? 'context' : 'user', b.text);
          if (!context && firstUserText === null) firstUserText = b.text;
        } else if (b.type === 'tool_result') {
          {
            const out = toText(b.content);
            push(ts, 'tool_result', clip(out), null, claudeFailed(b, out));
          }
        }
      }
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text') push(ts, 'assistant', b.text);
        else if (b.type === 'tool_use') push(ts, 'tool_call', clip(toText(b.input)), b.name ?? null);
        // thinking 块暂不收录：大多为空或只有签名
      }
    }
  }

  const tally = new UsageTally();
  for (const { model, u } of usageById.values()) {
    // <synthetic> 是客户端自己生成的占位回复（例如被中断），不是真正的模型请求
    if (model === '<synthetic>') continue;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cacheRead;
    tally.add(model, { input, output: u.output_tokens, cacheRead });
  }
  session.usage = tally.list();
  session.title ??= firstUserText ? titleFrom(firstUserText) : null;
  return session;
}
