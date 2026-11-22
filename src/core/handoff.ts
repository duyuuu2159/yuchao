import { agentLabel, isAgentKind } from './agents.ts';
import { redact } from './scan.ts';
import type { Store } from './store.ts';
import { commandsOf, filesTouched, isShellCall, PendingCalls } from './tools.ts';
import type { AgentKind, Role } from './types.ts';

// 接力：把一个会话整理成一份交接说明，粘贴给另一个 agent 接着做。
// 常见场景：这个 agent 的额度用完了、上下文太长了、或者想换个模型试试。
// 全部在本地从会话记录里提取，不调用大模型、不花钱；默认打码。

interface Msg {
  seq: number;
  ts: string | null;
  role: Role;
  toolName: string | null;
  text: string;
}

export interface HandoffFacts {
  sessionId: string;
  agent: AgentKind;
  title: string;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  userMessages: number;
  toolCalls: number;
  goal: string | null;
  recentAsks: string[];
  files: { path: string; edits: number }[];
  commands: string[];
  errors: string[];
  lastReply: string | null;
}

export interface Handoff {
  facts: HandoffFacts;
  markdown: string;
  chars: number;
  /** 粗略估算：中文一个字约 1 个 token，英文约 4 个字符 1 个 token */
  tokens: number;
}

/** 只是「继续」「好的」这种推进对话的话，不算一条要求 */
export const FILLER = /^(继续|好|好的|嗯|ok|okay|可以|行|是|对|开始|继续做|接着做|yes|y|go)[。.!！~]*$/i;

/** 交接说明里显示的命令：只留前三行，太长的截断 */
export function shortCommand(cmd: string): string {
  const lines = cmd.trim().split('\n');
  const firstLines = lines.slice(0, 3).join('\n');
  return firstLines.length > 240 ? firstLines.slice(0, 240) + '…' : firstLines + (lines.length > 3 ? '\n…' : '');
}

/** 这次调用执行的第一条命令（截断后用于显示）；不是执行命令的调用返回 null */
export function commandOf(toolName: string | null, text: string): string | null {
  const cmd = commandsOf(toolName, text)[0];
  return cmd ? shortCommand(cmd) : null;
}

const ERROR_LINE = /(?:\berror\b|\bfailed\b|traceback|exception|exit code [1-9]|not found|denied|ENOENT|EADDRINUSE|报错|失败|错误)/i;

export function errorOf(text: string): string | null {
  const line = text.split('\n').find((l) => ERROR_LINE.test(l) && l.trim().length > 6);
  if (!line) return null;
  const t = line.trim();
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const shortPath = (p: string, cwd: string | null) => {
  const norm = (x: string) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const c = cwd ? norm(cwd) : null;
  const q = norm(p);
  return c && q.toLowerCase().startsWith(c.toLowerCase() + '/') ? q.slice(c.length + 1) : q;
};

export function extractFacts(session: {
  id: string;
  agent: string;
  title: string | null;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  messages: Msg[];
}): HandoffFacts {
  const users = session.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.text.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const distinct = users.filter((u) => !seen.has(u) && seen.add(u));
  const meaningful = distinct.filter((u) => !FILLER.test(u));

  // 文件按最后一次改动排序：交接时最近在改的才是现场
  const files = new Map<string, { edits: number; last: number }>();
  /** 每次调用是不是在执行命令，等它的结果回来时用 */
  const pending = new PendingCalls<boolean>();
  const commands: string[] = [];
  const errors: string[] = [];
  let toolCalls = 0;
  for (const m of session.messages) {
    if (m.role === 'tool_call') {
      toolCalls++;
      pending.call(isShellCall(m.toolName, m.text));
      for (const f of filesTouched(m.toolName, m.text)) {
        const key = shortPath(f, session.cwd);
        files.set(key, { edits: (files.get(key)?.edits ?? 0) + 1, last: m.seq });
      }
      for (const c of commandsOf(m.toolName, m.text)) commands.push(shortCommand(c));
    } else if (m.role === 'tool_result') {
      // 只看命令的输出，或者工具自己报的错；读文件的结果里出现「失败」二字不算报错
      const shell = pending.result() ?? false;
      const e = shell || /^\s*(error|\[stderr\])/i.test(m.text) ? errorOf(m.text) : null;
      if (e) errors.push(e);
    }
  }
  const lastReply =
    [...session.messages]
      .reverse()
      .find((m) => m.role === 'assistant')
      ?.text.trim() ?? null;
  const dedupeTail = (xs: string[], n: number) => [...new Set([...xs].reverse())].slice(0, n).reverse();

  return {
    sessionId: session.id,
    agent: session.agent as AgentKind,
    title: session.title ?? '（无标题）',
    cwd: session.cwd,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    userMessages: users.length,
    toolCalls,
    goal: meaningful[0] ?? distinct[0] ?? null,
    // 最近的几条要求，不和「最初的目标」重复
    recentAsks: meaningful.slice(1).slice(-6),
    // 按改动次数排，改得多的通常是这次的主战场
    files: [...files]
      .sort((a, b) => b[1].last - a[1].last)
      .slice(0, 15)
      .map(([path, v]) => ({ path, edits: v.edits })),
    commands: dedupeTail(commands, 8),
    errors: dedupeTail(errors, 4),
    lastReply,
  };
}

const AGENT_MEMORY_FILE: Partial<Record<AgentKind, string>> = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
  workbuddy: 'AGENTS.md',
  dsh: 'AGENTS.md',
};

export function renderHandoff(f: HandoffFacts, to?: AgentKind, budget = 6000): string {
  const from = agentLabel(f.agent);
  const day = (ts: string | null) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '未知');
  const quote = (s: string) =>
    s
      .split('\n')
      .map((l) => '> ' + l)
      .join('\n');

  // 预算不够时，先缩短这几段，顺序就是重要程度从低到高
  for (const level of [0, 1, 2, 3]) {
    const replyMax = [1500, 900, 500, 300][level];
    const askMax = [500, 300, 200, 120][level];
    const lines: string[] = [];
    lines.push(`# 接力：${f.title}`);
    lines.push('');
    lines.push(
      `我之前在 ${from} 里做这件事，现在想换${to ? `你（${agentLabel(to)}）` : '你'}接着做。下面是鱼巢从会话记录里自动整理的交接信息，密码和密钥已经打码。` +
        `请先读完，用两三句话复述你理解的目标和进度，再继续；不确定的地方先问我，不要重做已经完成的部分。` +
        (to && AGENT_MEMORY_FILE[to] && f.cwd ? `如果工作目录里有 ${AGENT_MEMORY_FILE[to]}，先读它。` : ''),
    );
    lines.push('');
    lines.push('## 基本情况');
    if (f.cwd) lines.push(`- 工作目录：\`${f.cwd}\``);
    lines.push(`- 时间：${day(f.startedAt)} → ${day(f.updatedAt)}`);
    lines.push(`- 我发了 ${f.userMessages} 条消息，${from} 调用了 ${f.toolCalls} 次工具`);
    if (f.goal) lines.push('', '## 最初的目标', quote(clip(f.goal, askMax * 2)));
    if (f.recentAsks.length) {
      lines.push('', '## 后来补充的要求（从旧到新）');
      f.recentAsks.slice(level >= 2 ? -3 : 0).forEach((a, i) => {
        lines.push(`${i + 1}. ${clip(a.replace(/\n+/g, ' '), askMax)}`);
      });
    }
    if (f.files.length) {
      lines.push('', '## 改过的文件（最近改的在前）');
      for (const x of f.files.slice(0, level >= 2 ? 8 : 15)) lines.push(`- \`${x.path}\`${x.edits > 1 ? `（${x.edits} 次）` : ''}`);
    }
    if (f.commands.length && level < 3) {
      lines.push('', '## 最近执行的命令', '```');
      lines.push(...f.commands.slice(level >= 2 ? -4 : 0));
      lines.push('```');
    }
    if (f.errors.length) {
      lines.push('', '## 最近遇到的报错');
      for (const e of f.errors.slice(level >= 2 ? -2 : 0)) lines.push(`- \`${e.replace(/`/g, "'")}\``);
    }
    if (f.lastReply) lines.push('', `## ${from} 最后说的话`, quote(clip(f.lastReply, replyMax)));
    lines.push('', '---', `*由鱼巢 AgentNest 生成，来源会话 \`${f.sessionId}\`*`);
    const md = lines.join('\n');
    if (md.length <= budget || level === 3) return md;
  }
  return '';
}

export function estimateTokens(text: string): number {
  const cjk = (text.match(/[㐀-鿿＀-￯]/g) ?? []).length;
  return Math.round(cjk + (text.length - cjk) / 4);
}

export function buildHandoff(store: Store, sessionId: string, opts: { to?: string; raw?: boolean; budget?: number } = {}): Handoff | null {
  const s = store.getSession(sessionId);
  if (!s) return null;
  const facts = extractFacts(s as any);
  const to = isAgentKind(opts.to) ? opts.to : undefined;
  let markdown = renderHandoff(facts, to, opts.budget);
  // 从源头上打码一次：文件名、命令、报错里都可能带着密钥
  if (!opts.raw) markdown = redact(markdown);
  return { facts, markdown, chars: markdown.length, tokens: estimateTokens(markdown) };
}

/** 最近一个有你亲手写的话的会话（跳过子 agent 和工作流自动跑的会话），「接力上次的工作」用它 */
export function latestWorkSession(store: Store): string | null {
  const r = store.db
    .prepare(
      "SELECT s.id FROM sessions s WHERE s.parent_id IS NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.role = 'user') ORDER BY s.updated_at DESC LIMIT 1",
    )
    .get() as { id: string } | undefined;
  return r?.id ?? null;
}
