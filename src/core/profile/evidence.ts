import { createHash } from 'node:crypto';
import { AGENT_KINDS, agentLabel } from '../agents.ts';
import { IPV4, redact } from '../scan.ts';
import type { Store } from '../store.ts';
import type { AgentKind } from '../types.ts';

// 画像的原材料：本地统计（不经过大模型）和每个会话的证据摘要（会发给大模型）。
// 只使用用户亲手写的话，agent 的回复和工具输出不发送。

export interface ActivityStats {
  sessions: Record<AgentKind, number>;
  userMessages: number;
  activeDays: number;
  firstDay: string | null;
  lastDay: string | null;
  /** 0–23 点各有多少条消息（本地时间） */
  byHour: number[];
  /** 周一到周日 */
  byWeekday: number[];
  topProjects: { name: string; sessions: number }[];
  topTools: { name: string; calls: number }[];
  /** 最常说的短句，例如「继续」 */
  topPhrases: { text: string; count: number }[];
  medianLength: number;
}

export interface SessionEvidence {
  sessionId: string;
  agent: AgentKind;
  title: string;
  project: string | null;
  startedAt: string | null;
  /** 发给模型的文本，已打码 */
  text: string;
  /** 文本里出现的消息序号，用来校验模型给出的引用 */
  seqs: number[];
  /** 文本内容的哈希，内容没变就复用上次的总结 */
  hash: string;
}

const MAX_MESSAGE_CHARS = 600;
const MAX_SESSION_CHARS = 8000;

const localDay = (ts: string) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function projectName(cwd: string | null): string | null {
  if (!cwd) return null;
  // 会话里的工作目录来自写下它的那台机器，可能是 Windows 路径。path.basename 在 Linux 上不认反斜杠，
  // 在 WSL 里读 Windows 的会话时会把整条路径当成项目名，所以两种分隔符都自己切
  return (
    cwd
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || cwd
  );
}

interface UserRow {
  session_id: string;
  seq: number;
  ts: string | null;
  text: string;
}

/**
 * 每条用户消息只归属一个会话：分叉会话复制的历史（时间和内容都相同）留给最早的会话，
 * 否则同一句话会被模型当成多次证据。子 agent 会话里的「用户消息」其实是父 agent 写的，不算。
 */
function uniqueUserMessages(store: Store): Map<string, UserRow[]> {
  const rows = store.db
    .prepare(
      `SELECT m.session_id, m.seq, m.ts, m.text FROM messages m JOIN sessions s ON s.id = m.session_id
       WHERE m.role = 'user' AND s.parent_id IS NULL
       ORDER BY s.started_at ASC, s.id ASC, m.seq ASC`,
    )
    .all() as unknown as UserRow[];
  const seen = new Set<string>();
  const bySession = new Map<string, UserRow[]>();
  for (const r of rows) {
    const key = `${r.ts}\u0000${r.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let list = bySession.get(r.session_id);
    if (!list) {
      list = [];
      bySession.set(r.session_id, list);
    }
    list.push(r);
  }
  return bySession;
}

export function activityStats(store: Store): ActivityStats {
  const bySession = uniqueUserMessages(store);
  const msgs = [...bySession.values()].flat();
  const byHour = Array(24).fill(0);
  const byWeekday = Array(7).fill(0);
  const days = new Set<string>();
  for (const m of msgs) {
    if (!m.ts) continue;
    const d = new Date(m.ts);
    byHour[d.getHours()]++;
    byWeekday[(d.getDay() + 6) % 7]++;
    days.add(localDay(m.ts));
  }
  const sortedDays = [...days].sort();

  const sessions = Object.fromEntries(AGENT_KINDS.map((k) => [k, 0])) as Record<AgentKind, number>;
  const projects = new Map<string, number>();
  for (const s of store.db.prepare('SELECT id, agent, cwd FROM sessions WHERE parent_id IS NULL').all() as any[]) {
    if (!bySession.has(s.id)) continue;
    sessions[s.agent as AgentKind]++;
    const p = projectName(s.cwd);
    if (p) projects.set(p, (projects.get(p) ?? 0) + 1);
  }

  const phrases = new Map<string, number>();
  for (const m of msgs) {
    const t = m.text.trim();
    if ([...t].length <= 8) phrases.set(t, (phrases.get(t) ?? 0) + 1);
  }
  const lengths = msgs.map((m) => [...m.text].length).sort((a, b) => a - b);

  const top = <K extends string>(map: Map<string, number>, n: number, key: K, val: string) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => ({ [key]: k, [val]: v }));

  return {
    sessions,
    userMessages: msgs.length,
    activeDays: days.size,
    firstDay: sortedDays[0] ?? null,
    lastDay: sortedDays.at(-1) ?? null,
    byHour,
    byWeekday,
    topProjects: top(projects, 8, 'name', 'sessions') as ActivityStats['topProjects'],
    topTools: (
      store.db
        .prepare(
          "SELECT tool_name AS name, COUNT(*) AS calls FROM messages WHERE role = 'tool_call' AND tool_name IS NOT NULL GROUP BY tool_name ORDER BY calls DESC LIMIT 10",
        )
        .all() as any[]
    ).map((r) => ({ name: r.name, calls: r.calls })),
    topPhrases: (top(phrases, 10, 'text', 'count') as ActivityStats['topPhrases']).filter((p) => p.count >= 2),
    medianLength: lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0,
  };
}

/** 发给模型前的脱敏：密码、密钥打码，IP 地址也隐藏（单独不算秘密，但没必要交给第三方） */
export function sanitize(text: string): string {
  return redact(text).replace(IPV4, '[IP]');
}

function clipMessage(text: string): string {
  const chars = [...text];
  return chars.length > MAX_MESSAGE_CHARS
    ? chars.slice(0, MAX_MESSAGE_CHARS).join('') + `…[本条还有 ${chars.length - MAX_MESSAGE_CHARS} 字未发送]`
    : text;
}

/**
 * 每个会话的证据：用户写的话，带上消息序号 [#seq]，供模型引用。
 * 会话太长时保留开头和结尾，中间明确标出省略了多少条，不悄悄截断。
 */
export function sessionEvidence(store: Store, opts: { agent?: AgentKind } = {}): SessionEvidence[] {
  const bySession = uniqueUserMessages(store);
  const out: SessionEvidence[] = [];
  const sessions = store.db
    .prepare('SELECT id, agent, title, cwd, started_at FROM sessions WHERE parent_id IS NULL ORDER BY started_at ASC, id ASC')
    .all() as any[];
  for (const s of sessions) {
    if (opts.agent && s.agent !== opts.agent) continue;
    const rows = bySession.get(s.id);
    if (!rows?.length) continue;

    const lines = rows.map((r) => ({ seq: r.seq, line: `[#${r.seq}] ${clipMessage(sanitize(r.text)).replace(/\s*\n\s*/g, ' ⏎ ')}` }));
    let kept = lines;
    let omitted = 0;
    const total = (ls: typeof lines) => ls.reduce((n, l) => n + l.line.length + 1, 0);
    if (total(lines) > MAX_SESSION_CHARS) {
      const head: typeof lines = [];
      const tail: typeof lines = [];
      let budget = MAX_SESSION_CHARS;
      for (let i = 0, j = lines.length - 1; i <= j; ) {
        const pick = head.length <= tail.length * 1.5 ? lines[i] : lines[j];
        if (pick.line.length + 1 > budget) break;
        budget -= pick.line.length + 1;
        if (pick === lines[i]) head.push(lines[i++]);
        else tail.unshift(lines[j--]);
      }
      omitted = lines.length - head.length - tail.length;
      kept = [...head, { seq: -1, line: `…中间省略 ${omitted} 条消息…` }, ...tail];
    }

    const title = sanitize(s.title ?? '（无标题）');
    const project = projectName(s.cwd);
    const header = `${agentLabel(s.agent)}｜${title}｜项目 ${project ?? '未知'}｜${s.started_at ? localDay(s.started_at) : '日期未知'}`;
    const text = header + '\n' + kept.map((l) => l.line).join('\n');
    out.push({
      sessionId: s.id,
      agent: s.agent,
      title,
      project,
      startedAt: s.started_at,
      text,
      seqs: kept.filter((l) => l.seq >= 0).map((l) => l.seq),
      hash: createHash('sha256').update(text).digest('hex').slice(0, 16),
    });
  }
  return out;
}
