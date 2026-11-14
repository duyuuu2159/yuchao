import { useEffect, useState } from 'react';
import { AGENT_LABEL, AGENTS, type Agent, type CostlySession, type UsageDay, usageApi } from './api.ts';
import { when } from './format.ts';
import { AgentBadge, Skeleton } from './ui.tsx';

/** 大数字写成「亿」「万」 */
export function bigNumber(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(n >= 1e10 ? 0 : 1)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(n >= 1e6 ? 0 : 1)} 万`;
  return String(n);
}

const RANGES = [30, 60, 90];

/**
 * 每天的 token：按 agent 堆叠的柱子。
 * - 颜色跟着 agent 走（固定顺序），筛选、换时间范围都不会重新分配颜色
 * - 段与段之间留 2px 缝；图例写出名字；悬停看当天每个 agent 的数字
 * - 图形对读屏软件隐藏，下面「以表格查看」是同样的数据
 */
function DailyChart({ days }: { days: UsageDay[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((d) => d.total));
  const used = AGENTS.filter((a) => days.some((d) => d.byAgent[a]));
  const label = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
  const tickEvery = Math.ceil(days.length / 8);
  const h = hover === null ? null : days[hover];

  return (
    <figure className="usage-chart">
      <div className="usage-legend">
        {used.map((a) => (
          <span key={a}>
            <i className={'a-' + a} />
            {AGENT_LABEL[a]}
          </span>
        ))}
      </div>
      <div className="usage-plot" aria-hidden="true">
        <span className="usage-max">{bigNumber(max)}</span>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: 悬停提示只是鼠标用户的增强，同样的数据在下面的表格里 */}
        <div className="usage-cols" onMouseLeave={() => setHover(null)}>
          {days.map((d, i) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: 同上
            <div key={d.day} className={'usage-col' + (hover === i ? ' on' : '')} onMouseEnter={() => setHover(i)}>
              <div className="usage-stack" style={{ height: `${(d.total / max) * 100}%` }}>
                {used.map((a) => (d.byAgent[a] ? <span key={a} className={'a-' + a} style={{ flexGrow: d.byAgent[a] }} /> : null))}
              </div>
            </div>
          ))}
        </div>
        {h && hover !== null && (
          <div className="usage-tip" style={{ left: `${((hover + 0.5) / days.length) * 100}%` }}>
            <b>
              {label(h.day)} · {bigNumber(h.total)} token
            </b>
            {used
              .filter((a) => h.byAgent[a])
              .map((a) => (
                <span key={a}>
                  <i className={'a-' + a} />
                  {AGENT_LABEL[a]} {bigNumber(h.byAgent[a] ?? 0)}
                </span>
              ))}
            {!h.total && <span>这天没有用量</span>}
          </div>
        )}
      </div>
      <div className="usage-axis" aria-hidden="true">
        {days.map((d, i) => (
          <span key={d.day}>{i % tickEvery === 0 ? label(d.day) : ''}</span>
        ))}
      </div>
      <details className="table-view">
        <summary>以表格查看</summary>
        <table>
          <thead>
            <tr>
              <th>日期</th>
              {used.map((a) => (
                <th key={a}>{AGENT_LABEL[a]}</th>
              ))}
              <th>合计</th>
            </tr>
          </thead>
          <tbody>
            {days
              .filter((d) => d.total)
              .map((d) => (
                <tr key={d.day}>
                  <th>{d.day}</th>
                  {used.map((a) => (
                    <td key={a}>{d.byAgent[a] ? bigNumber(d.byAgent[a] ?? 0) : '—'}</td>
                  ))}
                  <td>{bigNumber(d.total)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
      <figcaption className="meta">一个会话的用量算在它开始的那一天；输入包括命中缓存的部分。</figcaption>
    </figure>
  );
}

function TopSessions({ top, onOpen }: { top: CostlySession[]; onOpen: (id: string) => void }) {
  return (
    <ol className="usage-top">
      {top.map((s, i) => (
        <li key={s.id}>
          <button type="button" onClick={() => onOpen(s.id)}>
            <em>{String(i + 1).padStart(2, '0')}</em>
            <span className="t">
              <span className="row1">
                <AgentBadge agent={s.agent as Agent} />
                <b>{s.title ?? '（无标题）'}</b>
              </span>
              <span className="meta">
                {s.model ?? '未知模型'} · {when(s.startedAt)} · 输出 {bigNumber(s.output)} · 缓存命中{' '}
                {s.input ? Math.round((s.cacheRead / s.input) * 100) : 0}%
              </span>
            </span>
            <span className="n">{bigNumber(s.input + s.output)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

export function UsageSection({ reloadKey, onOpen }: { reloadKey: number; onOpen: (id: string) => void }) {
  const [range, setRange] = useState(60);
  const [data, setData] = useState<{ days: UsageDay[]; top: CostlySession[] } | null | Error>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey 是「更新索引后重新加载」的触发计数器
  useEffect(() => {
    let stale = false;
    usageApi.get(range).then(
      (r) => !stale && setData(r),
      (e) => !stale && setData(e instanceof Error ? e : new Error(String(e))),
    );
    return () => {
      stale = true;
    };
  }, [range, reloadKey]);

  if (data instanceof Error) return <p className="err">{data.message}</p>;
  if (!data) return <Skeleton height={260} />;
  const total = data.days.reduce((n, d) => n + d.total, 0);

  return (
    <div className="usage">
      <section className="usage-card">
        <header>
          <h3>
            每天的 token{' '}
            <span className="meta">
              最近 {range} 天共 {bigNumber(total)}
            </span>
          </h3>
          <fieldset className="seg small" aria-label="时间范围">
            {RANGES.map((r) => (
              <button key={r} type="button" className={range === r ? 'on' : ''} aria-pressed={range === r} onClick={() => setRange(r)}>
                {r} 天
              </button>
            ))}
          </fieldset>
        </header>
        {total ? <DailyChart days={data.days} /> : <p className="meta">这段时间没有用量记录。</p>}
      </section>
      <section className="usage-card">
        <header>
          <h3>最费 token 的会话</h3>
        </header>
        {data.top.length ? <TopSessions top={data.top} onOpen={onOpen} /> : <p className="meta">还没有用量记录。</p>}
      </section>
    </div>
  );
}
