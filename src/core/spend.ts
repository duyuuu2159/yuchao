// 用量报告：token 是哪几天、在哪些会话上花掉的。
//
// 会话记录里的用量是按会话汇总的，不知道每次请求的具体时间，所以一个会话的用量算在它开始的那一天。
// 跨天的长会话会让当天的柱子偏高，这是已知的近似。

import type { Store } from './store.ts';
import type { AgentKind } from './types.ts';

export interface UsageDay {
  /** 本地日期 YYYY-MM-DD */
  day: string;
  /** 每个 agent 当天的 token（输入 + 输出） */
  byAgent: Partial<Record<AgentKind, number>>;
  total: number;
}

export interface CostlySession {
  id: string;
  agent: AgentKind;
  title: string | null;
  startedAt: string | null;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
}

export interface UsageReport {
  days: UsageDay[];
  /** 最费 token 的主会话，子 agent 的用量算进主会话 */
  top: CostlySession[];
}

/** 本地时区的日期，和用户在日历上看到的一致 */
export function localDay(ts: string | number | Date): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function usageReport(store: Store, opts: { days?: number; top?: number; now?: Date } = {}): UsageReport {
  const span = opts.days ?? 60;
  const now = opts.now ?? new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (span - 1));

  // 连续的日期轴：没有用量的日子也占一格，柱子之间的间隔才代表真实的时间
  const days: UsageDay[] = [];
  const byDay = new Map<string, UsageDay>();
  for (let i = 0; i < span; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const row: UsageDay = { day: localDay(d), byAgent: {}, total: 0 };
    days.push(row);
    byDay.set(row.day, row);
  }

  const rows = store.db
    .prepare(
      `SELECT s.agent, s.started_at, SUM(u.input + u.output) AS tokens
       FROM session_usage u JOIN sessions s ON s.id = u.session_id
       WHERE s.started_at >= ? GROUP BY s.id`,
    )
    .all(start.toISOString()) as { agent: AgentKind; started_at: string; tokens: number }[];
  for (const r of rows) {
    const row = byDay.get(localDay(r.started_at));
    if (!row) continue;
    row.byAgent[r.agent] = (row.byAgent[r.agent] ?? 0) + r.tokens;
    row.total += r.tokens;
  }

  // 子 agent 归到主会话：按 COALESCE(parent_id, id) 汇总；模型取输出最多的那个
  const top = store.db
    .prepare(
      `WITH per AS (
         SELECT COALESCE(s.parent_id, s.id) AS root, u.model, SUM(u.input) AS input, SUM(u.output) AS output, SUM(u.cache_read) AS cache_read
         FROM session_usage u JOIN sessions s ON s.id = u.session_id
         GROUP BY root, u.model
       ), roots AS (
         SELECT root, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
                (SELECT model FROM per p2 WHERE p2.root = per.root ORDER BY p2.output DESC LIMIT 1) AS model
         FROM per GROUP BY root
       )
       SELECT r.root AS id, s.agent, s.title, s.started_at, r.model, r.input, r.output, r.cache_read
       FROM roots r JOIN sessions s ON s.id = r.root
       ORDER BY r.input + r.output DESC LIMIT ?`,
    )
    .all(opts.top ?? 5) as {
    id: string;
    agent: AgentKind;
    title: string | null;
    started_at: string | null;
    model: string | null;
    input: number;
    output: number;
    cache_read: number;
  }[];

  return {
    days,
    top: top.map((t) => ({
      id: t.id,
      agent: t.agent,
      title: t.title,
      startedAt: t.started_at,
      model: t.model,
      input: t.input,
      output: t.output,
      cacheRead: t.cache_read,
    })),
  };
}
