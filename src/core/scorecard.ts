// 成绩单：每个 agent、每个模型到底有没有把事办成。
//
// 别的用量工具只回答「花了多少 token」。鱼巢同时拿着几家 agent 的记录，可以回答「值不值」：
// 一个会话最后是顺利完成、返工后完成，还是没解决（报错收尾、你说了不行、或者换了别的 agent 接手）。
//
// 判断全部基于会话里实际发生的事，每个结论都带着理由，不调用大模型：
//   没解决  最后一次命令以报错收尾 / 你最后一句话在说不行 / 之后在别的 agent 里接着做（接力）
//   返工    你说过「还是不行」之类的话 / 同一个要求说了不止一遍
//   （agent 自己试错再修好是正常的工作方式，你感受不到，所以不算返工；作为「自己纠错」的次数单独显示）
//   顺利    以上都没有
// 样本少时结论不可靠，界面上会显示每个数字背后有几个会话。

import { agentLabel } from './agents.ts';
import { errorOf, FILLER, SHELL_TOOLS } from './handoff.ts';
import type { Store } from './store.ts';
import type { AgentKind, Role } from './types.ts';

export type Outcome = 'smooth' | 'rework' | 'unresolved';

export const OUTCOME_LABEL: Record<Outcome, string> = { smooth: '顺利', rework: '返工后完成', unresolved: '没解决' };

/** 用户在说「不行」：只认明确的说法，宁可漏掉也不要误判 */
export const NEGATIVE =
  /还是不行|还是不对|还是报错|还是一样|又报错|又出错|还是没用|没有用|不管用|没反应|打不开了?|不是这样|不是我要的|你理解错|搞错了|改坏了|越改越|重新来|算了吧?$|根本没/;
/** 请求失败后的重试：客户端的「Try again」，或者自己打的「再试一次」 */
export const RETRY = /^(?:try again|retry|请?再试一次|重试一?下?|再来一次)[。.!！]*$/i;

/** 用户在说「好了」 */
export const POSITIVE = /好了|可以了|成功了|解决了|没问题了|搞定|能用了|可以用了|正常了|完美|太好了|谢谢|感谢|ok了/i;

interface Msg {
  seq: number;
  role: Role;
  toolName: string | null;
  text: string;
  /** agent 记录的执行结果，见 toolstatus.ts */
  failed?: boolean | null;
}

export interface SessionSignals {
  turns: number;
  toolCalls: number;
  errors: number;
  /** 出现三次以上的同一个报错（已归一化） */
  repeatedErrors: number;
  negatives: number;
  positives: number;
  /** 换个说法把同一个要求又说了一遍（意思相近、措辞不同）：agent 没听懂或没做好 */
  reAsks: number;
  /** 一字不差地重发、或者「Try again」：通常是请求失败（接口超时、额度不够、中转站出错），问题在服务，不在 agent */
  retries: number;
  /** 最后一次执行命令（Bash、PowerShell 等）以失败收尾，之后你也没说「好了」。查文件、读网页这类查询失败不算 */
  endedOnError: boolean;
  /** 你最后一句有内容的话在说不行，而且之后 agent 没有再成功执行过任何操作（成功了就算返工后完成） */
  endedNegative: boolean;
}

/** 字符二元组，用来粗略比较两句话像不像；中文按字、英文按字母，不需要分词 */
function bigrams(text: string): Set<string> {
  const t = text.toLowerCase().replace(/\s+/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

export function similarity(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / (x.size + y.size - both);
}

/**
 * 重合度：短的那句话有多少落在长的那句里。「再说一遍」经常是原话加上补充（「……下面的也要」），
 * 用相似度会被多出来的字拉低，用重合度才认得出来
 */
export function overlap(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / Math.min(x.size, y.size);
}

/** 报错去掉数字、路径、引号里的内容，同一类错误才能归到一起 */
function normalizeError(e: string): string {
  return e
    .toLowerCase()
    .replace(/(["'`]).*?\1/g, '"…"')
    .replace(/[a-z]:[\\/][^\s]*|\/[^\s]*/gi, '<路径>')
    .replace(/\d+/g, '#')
    .slice(0, 120);
}

export function sessionSignals(messages: Msg[]): SessionSignals {
  const s: SessionSignals = {
    turns: 0,
    toolCalls: 0,
    errors: 0,
    repeatedErrors: 0,
    negatives: 0,
    positives: 0,
    reAsks: 0,
    retries: 0,
    endedOnError: false,
    endedNegative: false,
  };
  const asks: string[] = [];
  const errorCounts = new Map<string, number>();
  let lastKnownFailed = false;
  let lastTool: string | null = null;
  let positiveAfterLastError = false;
  let lastMeaningful: string | null = null;
  let succeededSinceLastAsk = false;

  for (const m of messages) {
    if (m.role === 'user') {
      const text = m.text.trim();
      if (!text) continue;
      s.turns++;
      if (NEGATIVE.test(text)) s.negatives++;
      if (POSITIVE.test(text)) {
        s.positives++;
        positiveAfterLastError = true;
      }
      if (RETRY.test(text) || asks.includes(text)) {
        // 一字不差地重发通常是上一次没发出去或者出错了
        s.retries++;
      } else if (!FILLER.test(text)) {
        lastMeaningful = text;
        succeededSinceLastAsk = false;
        // 换个说法又说了一遍：两句都不短、长度相差不到一倍，而且短的那句大部分出现在长的那句里。
        // 长度限制是为了排除「没有」「接着」这种恰好包含在之前长句里的短话
        const similarLength = (x: string) => Math.min(x.length, text.length) * 2 >= Math.max(x.length, text.length);
        if (text.length >= 8 && asks.some((a) => a.length >= 8 && similarLength(a) && overlap(a, text) >= 0.8)) s.reAsks++;
        asks.push(text);
      }
    } else if (m.role === 'tool_call') {
      s.toolCalls++;
      lastTool = m.toolName;
    } else if (m.role === 'tool_result' && m.failed != null) {
      // 只认 agent 自己记录的执行结果；不知道成败的（还在运行、等待超时、被用户中断）不参与判断
      if (lastTool && SHELL_TOOLS.test(lastTool)) lastKnownFailed = m.failed;
      if (!m.failed) succeededSinceLastAsk = true;
      if (m.failed) {
        s.errors++;
        positiveAfterLastError = false;
        // 归类用：取输出里像报错的那一行，没有就取第一行
        const line = errorOf(m.text) ?? m.text.trim().split(/\r?\n/)[0] ?? '';
        const k = normalizeError(line);
        errorCounts.set(k, (errorCounts.get(k) ?? 0) + 1);
      }
    }
  }
  s.repeatedErrors = [...errorCounts.values()].filter((n) => n >= 3).length;
  s.endedOnError = lastKnownFailed && !positiveAfterLastError;
  s.endedNegative = lastMeaningful !== null && NEGATIVE.test(lastMeaningful) && !POSITIVE.test(lastMeaningful) && !succeededSinceLastAsk;
  return s;
}

export function judge(sig: SessionSignals, handedOff: boolean): { outcome: Outcome; reasons: string[] } {
  const unresolved: string[] = [];
  if (handedOff) unresolved.push('之后换了别的 agent 接着做');
  if (sig.endedOnError) unresolved.push('最后一次命令以报错收尾');
  if (sig.endedNegative) unresolved.push('你最后一句在说不行');
  if (unresolved.length) return { outcome: 'unresolved', reasons: unresolved };

  const rework: string[] = [];
  if (sig.negatives) rework.push(`说过 ${sig.negatives} 次「还是不行」`);
  if (sig.reAsks) rework.push(`同一个要求换个说法又说了 ${sig.reAsks} 次`);
  if (rework.length) return { outcome: 'rework', reasons: rework };
  return { outcome: 'smooth', reasons: [] };
}

// ---------------- 接力：这个会话之后是不是换了别的 agent 接着做 ----------------

interface HandoffCandidate {
  id: string;
  agent: AgentKind;
  title: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  firstAsk: string | null;
}

/** 鱼巢生成的交接说明，开头是「# 接力：<原会话标题>」，下一段是「我之前在 <agent> 里做这件事」 */
const HANDOFF_NOTE = /^#\s*接力：(.+)\n[\s\S]*?我之前在\s*(.+?)\s*里做这件事/;

/**
 * 找出「A 之后在别的 agent 里接着做」的配对，返回 被接手的会话 id → 接手的会话 id。
 * 两种证据：
 *   1. 接手的会话以鱼巢的交接说明开头，标题和 agent 对得上（确定）
 *   2. A 结束后 12 小时内，另一个 agent 的会话第一句话和 A 的第一句话高度相似（同一个问题换个地方问）
 */
export function detectHandoffs(sessions: HandoffCandidate[]): Map<string, string> {
  const out = new Map<string, string>();
  const sorted = [...sessions].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  for (const [i, b] of sorted.entries()) {
    if (!b.firstAsk) continue;
    const note = HANDOFF_NOTE.exec(b.firstAsk);
    if (note) {
      const [, title, from] = note;
      const src = sorted
        .slice(0, i)
        .reverse()
        .find((a) => a.agent !== b.agent && (a.title ?? '').trim() === title.trim() && agentLabel(a.agent) === from.trim());
      if (src && !out.has(src.id)) out.set(src.id, b.id);
      continue;
    }
    if (b.firstAsk.length < 12) continue;
    const bStart = Date.parse(b.startedAt ?? '');
    const src = sorted
      .slice(0, i)
      .reverse()
      .find((a) => {
        if (a.agent === b.agent || !a.firstAsk || out.has(a.id)) return false;
        const gap = bStart - Date.parse(a.updatedAt ?? a.startedAt ?? '');
        return gap >= 0 && gap <= 12 * 3600_000 && similarity(a.firstAsk, b.firstAsk!) >= 0.5;
      });
    if (src) out.set(src.id, b.id);
  }
  return out;
}

// ---------------- 汇总 ----------------

export interface SessionScore {
  id: string;
  agent: AgentKind;
  title: string | null;
  startedAt: string | null;
  model: string | null;
  outcome: Outcome;
  reasons: string[];
  handedOffTo: string | null;
  signals: SessionSignals;
  input: number;
  output: number;
  cacheRead: number;
}

export interface ScoreRow {
  key: string;
  label: string;
  /** agent 维度时是 agent 名，模型维度时是这个模型主要在哪些 agent 里用 */
  agents: AgentKind[];
  sessions: number;
  smooth: number;
  rework: number;
  unresolved: number;
  /** 平均每个会话你说了几句话 */
  avgTurns: number;
  /** 请求失败后重发的次数：反映接口和中转站稳不稳，不反映 agent 的能力 */
  retries: number;
  /** agent 执行失败的次数（之后大多自己修好了）：反映试错多少 */
  failures: number;
  input: number;
  output: number;
  cacheRead: number;
  /** 每个顺利完成的会话平均消耗多少输出 token；没有顺利的会话时为 null */
  outputPerSmooth: number | null;
}

export interface Scorecard {
  since: string | null;
  sessions: SessionScore[];
  byAgent: ScoreRow[];
  byModel: ScoreRow[];
  handoffs: number;
}

function aggregate(scores: SessionScore[], keyOf: (s: SessionScore) => string | null, labelOf: (k: string) => string): ScoreRow[] {
  const groups = new Map<string, SessionScore[]>();
  for (const s of scores) {
    const k = keyOf(s);
    if (!k) continue;
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  return [...groups]
    .map(([key, xs]) => {
      const smooth = xs.filter((x) => x.outcome === 'smooth').length;
      const output = xs.reduce((n, x) => n + x.output, 0);
      return {
        key,
        label: labelOf(key),
        agents: [...new Set(xs.map((x) => x.agent))],
        sessions: xs.length,
        smooth,
        rework: xs.filter((x) => x.outcome === 'rework').length,
        unresolved: xs.filter((x) => x.outcome === 'unresolved').length,
        avgTurns: Math.round((xs.reduce((n, x) => n + x.signals.turns, 0) / xs.length) * 10) / 10,
        retries: xs.reduce((n, x) => n + x.signals.retries, 0),
        failures: xs.reduce((n, x) => n + x.signals.errors, 0),
        input: xs.reduce((n, x) => n + x.input, 0),
        output,
        cacheRead: xs.reduce((n, x) => n + x.cacheRead, 0),
        outputPerSmooth: smooth ? Math.round(output / smooth) : null,
      };
    })
    .sort((a, b) => b.sessions - a.sessions);
}

/**
 * 计算成绩单。只看顶层会话：子 agent 是主会话派出去干活的，它们的 token 算进主会话，成败跟着主会话走。
 * 你一句话都没说的会话（例如只有自动注入的内容）不参与统计。
 */
export function buildScorecard(store: Store, opts: { days?: number; agent?: AgentKind } = {}): Scorecard {
  const since = opts.days ? new Date(Date.now() - opts.days * 86_400_000).toISOString() : null;
  const where = ['s.parent_id IS NULL'];
  const params: string[] = [];
  if (since) {
    where.push('s.started_at >= ?');
    params.push(since);
  }
  if (opts.agent) {
    where.push('s.agent = ?');
    params.push(opts.agent);
  }
  const sessions = store.db
    .prepare(`SELECT s.id, s.agent, s.title, s.started_at, s.updated_at FROM sessions s WHERE ${where.join(' AND ')} ORDER BY s.started_at`)
    .all(...params) as { id: string; agent: AgentKind; title: string | null; started_at: string | null; updated_at: string | null }[];

  const msgStmt = store.db.prepare('SELECT seq, role, tool_name, text, failed FROM messages WHERE session_id = ? ORDER BY seq');
  // 子 agent 的用量算进主会话：按「自己或父会话是它」汇总
  const useStmt = store.db.prepare(
    `SELECT u.model, SUM(u.input) AS input, SUM(u.output) AS output, SUM(u.cache_read) AS cache_read
     FROM session_usage u JOIN sessions s ON s.id = u.session_id
     WHERE s.id = ? OR s.parent_id = ? GROUP BY u.model ORDER BY SUM(u.output) DESC`,
  );

  const prepared = sessions.map((s) => {
    const messages = (
      msgStmt.all(s.id) as { seq: number; role: Role; tool_name: string | null; text: string; failed: number | null }[]
    ).map((m) => ({
      seq: m.seq,
      role: m.role,
      toolName: m.tool_name,
      text: m.text,
      failed: m.failed === null ? null : m.failed === 1,
    }));
    const firstAsk = messages.find((m) => m.role === 'user' && m.text.trim() && !FILLER.test(m.text.trim()))?.text.trim() ?? null;
    return { s, messages, firstAsk, signals: sessionSignals(messages) };
  });

  const handoffs = detectHandoffs(
    prepared.map((p) => ({
      id: p.s.id,
      agent: p.s.agent,
      title: p.s.title,
      startedAt: p.s.started_at,
      updatedAt: p.s.updated_at,
      firstAsk: p.firstAsk,
    })),
  );

  const scores: SessionScore[] = [];
  for (const p of prepared) {
    if (p.signals.turns === 0) continue;
    const usage = useStmt.all(p.s.id, p.s.id) as { model: string; input: number; output: number; cache_read: number }[];
    const handedOffTo = handoffs.get(p.s.id) ?? null;
    const { outcome, reasons } = judge(p.signals, handedOffTo !== null);
    scores.push({
      id: p.s.id,
      agent: p.s.agent,
      title: p.s.title,
      startedAt: p.s.started_at,
      // 一个会话里可能换过模型，以输出最多的那个为主
      model: usage[0]?.model ?? null,
      outcome,
      reasons,
      handedOffTo,
      signals: p.signals,
      input: usage.reduce((n, u) => n + u.input, 0),
      output: usage.reduce((n, u) => n + u.output, 0),
      cacheRead: usage.reduce((n, u) => n + u.cache_read, 0),
    });
  }

  return {
    since,
    sessions: scores,
    byAgent: aggregate(scores, (s) => s.agent, agentLabel),
    byModel: aggregate(
      scores,
      (s) => s.model,
      (k) => k,
    ),
    handoffs: [...handoffs.keys()].filter((id) => scores.some((s) => s.id === id)).length,
  };
}
