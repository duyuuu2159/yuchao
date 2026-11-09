import { basename, dirname } from 'node:path';
import { readJsonl } from '../lines.ts';
import { clip, type Role, type Session } from '../types.ts';
import { isClaudeContext, titleFrom, toText } from '../text.ts';

/**
 * 解析 Claude Code 的会话文件：
 *   ~/.claude/projects/<项目>/<sessionId>.jsonl
 *   ~/.claude/projects/<项目>/<sessionId>/subagents/agent-<id>.jsonl   （子 agent）
 */
export async function parseClaudeFile(path: string): Promise<Session> {
  const stem = basename(path, '.jsonl');
  const isSub = basename(dirname(path)) === 'subagents';
  const parentNative = isSub ? basename(dirname(dirname(path))) : null;
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
  };

  let firstUserText: string | null = null;
  const push = (ts: string | null, role: Role, text: string, toolName: string | null = null) => {
    if (!text.trim()) return;
    session.messages.push({ seq: session.messages.length, ts, role, toolName, text });
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
          push(ts, 'tool_result', clip(toText(b.content)));
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

  session.title ??= firstUserText ? titleFrom(firstUserText) : null;
  return session;
}
