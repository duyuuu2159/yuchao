import { basename, dirname } from 'node:path';
import { readJsonl } from '../lines.ts';
import { titleFrom, toText } from '../text.ts';
import { clip, type Role, type Session } from '../types.ts';

/**
 * 解析 DeepSeek Harness（dsh）的会话文件：
 *   ~/.dsh/sessions/<工作目录>/<sessionId>/session.v4.jsonl.zstd
 * 文件是事件流，第一行是会话头（子 agent 会话带 parentSession），之后每行一个事件：
 *   user/message      data.content，source.kind 区分来源：只有 user 是人写的，
 *                     runtime-context、time-context、skill-catalog、agent-message 等都是自动注入
 *   assistant/message data.message.content 里有 text / reasoning / tool-call 三种块
 *   tool/result       data.message.content
 *   session/title     先用首句兜底（fallback），再由模型起正式标题，以最后一次为准
 */
export async function parseDshFile(path: string): Promise<Session> {
  const session: Session = {
    id: '',
    agent: 'dsh',
    nativeId: basename(dirname(path)),
    parentId: null,
    title: null,
    cwd: null,
    startedAt: null,
    updatedAt: null,
    archived: false,
    sourcePath: path,
    messages: [],
  };

  let firstUserText: string | null = null;
  let subagentLabel: string | null = null;
  const push = (ts: string | null, role: Role, text: string, toolName: string | null = null) => {
    if (!text.trim()) return;
    session.messages.push({ seq: session.messages.length, ts, role, toolName, text });
  };

  for await (const rec of readJsonl(path)) {
    const time = rec.time ?? rec.createdAt;
    const ts = typeof time === 'number' ? new Date(time).toISOString() : null;
    if (ts) {
      session.startedAt ??= ts;
      session.updatedAt = ts;
    }
    const d = rec.data ?? {};

    switch (rec.type) {
      case 'session':
        if (rec.id) session.nativeId = rec.id;
        session.cwd = rec.cwd ?? null;
        if (rec.parentSession) session.parentId = `dsh:${rec.parentSession}`;
        break;
      case 'subagent/descriptor':
        subagentLabel = d.label ?? null;
        break;
      case 'session/title':
        if (d.title) session.title = d.title;
        break;
      case 'user/message': {
        const text = toText((d.content ?? []).filter((c: any) => c.type === 'text'));
        if (d.source?.kind === 'user') {
          push(ts, 'user', text);
          if (text && firstUserText === null) firstUserText = text;
        } else push(ts, 'context', clip(text), d.source?.kind ?? null);
        break;
      }
      case 'assistant/message':
        for (const b of d.message?.content ?? []) {
          if (b.type === 'text') push(ts, 'assistant', b.text ?? '');
          else if (b.type === 'tool-call') push(ts, 'tool_call', clip(toText(b.arguments)), b.name ?? null);
          // reasoning 块是思考过程，不收录
        }
        break;
      case 'tool/result':
        push(ts, 'tool_result', clip(toText((d.message?.content ?? []).filter((c: any) => c.type === 'text'))));
        break;
      case 'compaction/summary':
        push(ts, 'context', clip(toText(d.summary)));
        break;
    }
  }

  session.id = `dsh:${session.nativeId}`;
  session.title ??= subagentLabel ? `子 agent · ${subagentLabel}` : firstUserText ? titleFrom(firstUserText) : null;
  return session;
}
