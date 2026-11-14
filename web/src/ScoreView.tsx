import { useEffect, useState } from 'react';
import { type Outcome, type Scorecard, type ScoreRow, scoreApi } from './api.ts';
import { when } from './format.ts';
import { AgentBadge, Empty, ErrorPage, Icon, LoadingPage, PageHeader } from './ui.tsx';

export const OUTCOME_LABEL: Record<Outcome, string> = { smooth: '顺利', rework: '返工后完成', unresolved: '没解决' };
const OUTCOMES: Outcome[] = ['smooth', 'rework', 'unresolved'];

/** 样本少于这个数的行，结论只供参考 */
const FEW = 5;

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/**
 * 一根横条按比例分成三段：顺利、返工后完成、没解决。
 * 颜色只是辅助：每段的名字和比例都写在 title 里，表格里另有数字，图例在页面上方。
 */
export function OutcomeBar({ row }: { row: Pick<ScoreRow, 'sessions' | 'smooth' | 'rework' | 'unresolved'> }) {
  return (
    <div
      className="outcome-bar"
      role="img"
      aria-label={OUTCOMES.map((o) => `${OUTCOME_LABEL[o]} ${pct(row[o], row.sessions)}%`).join('，')}
    >
      {OUTCOMES.map((o) =>
        row[o] ? (
          <span
            key={o}
            className={'seg-' + o}
            style={{ flexGrow: row[o] }}
            title={`${OUTCOME_LABEL[o]}：${row[o]} 个会话（${pct(row[o], row.sessions)}%）`}
          />
        ) : null,
      )}
    </div>
  );
}

export function OutcomeLegend() {
  return (
    <ul className="outcome-legend">
      {OUTCOMES.map((o) => (
        <li key={o}>
          <i className={'seg-' + o} />
          {OUTCOME_LABEL[o]}
        </li>
      ))}
    </ul>
  );
}

const PERIODS: { days?: number; label: string }[] = [{ label: '全部' }, { days: 30, label: '最近 30 天' }, { days: 7, label: '最近 7 天' }];

function ScoreTable({ rows, kind }: { rows: ScoreRow[]; kind: 'agent' | 'model' }) {
  return (
    <div className="score-table-wrap">
      <table className="score-table">
        <thead>
          <tr>
            <th scope="col">{kind === 'agent' ? 'agent' : '主力模型'}</th>
            <th scope="col" className="num">
              会话
            </th>
            <th scope="col" className="bar-col">
              结果
            </th>
            <th scope="col" className="num">
              顺利
            </th>
            <th scope="col" className="num" title="平均每个会话你说了几句话">
              平均几句
            </th>
            <th scope="col" className="num" title="每个顺利完成的会话，平均花了多少输出 token">
              每件顺利的事
            </th>
            <th scope="col" className="num" title="输入里命中缓存的比例，越高越省钱">
              缓存命中
            </th>
            <th scope="col" className="num" title="一字不差地重发或 Try again：通常是接口或中转站出错">
              接口重试
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const few = r.sessions < FEW;
            return (
              <tr key={r.key} className={few ? 'few' : undefined}>
                <th scope="row">
                  {kind === 'agent' ? <AgentBadge agent={r.agents[0]} /> : <code>{r.label}</code>}
                  {kind === 'model' && (
                    <span className="meta">
                      {r.agents.map((a) => (
                        <AgentBadge key={a} agent={a} />
                      ))}
                    </span>
                  )}
                  {few && <span className="few-tag">样本少</span>}
                </th>
                <td className="num">{r.sessions}</td>
                <td className="bar-col">
                  <OutcomeBar row={r} />
                </td>
                <td className="num strong">{pct(r.smooth, r.sessions)}%</td>
                <td className="num">{r.avgTurns}</td>
                <td className="num">{r.outputPerSmooth === null ? '—' : tokens(r.outputPerSmooth)}</td>
                <td className="num">{r.input ? `${pct(r.cacheRead, r.input)}%` : '—'}</td>
                <td className="num">{r.retries}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ScoreView({ onOpen }: { onOpen: (sessionId: string, seq: number | null) => void }) {
  const [days, setDays] = useState<number | undefined>(undefined);
  const [sc, setSc] = useState<Scorecard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Outcome>('unresolved');

  useEffect(() => {
    setSc(null);
    scoreApi.get(days).then(setSc, (e) => setError(e.message));
  }, [days]);

  if (error) return <ErrorPage title="成绩单" error={error} />;
  if (!sc) return <LoadingPage title="成绩单" />;

  const total = sc.sessions.length;
  const count = (o: Outcome) => sc.sessions.filter((s) => s.outcome === o).length;
  const retries = sc.byAgent.reduce((n, r) => n + r.retries, 0);
  const listed = sc.sessions.filter((s) => s.outcome === show).reverse();
  const models = sc.byModel.filter((r) => r.sessions >= 2);

  return (
    <div className="page score">
      <PageHeader
        kicker="02 · 成绩单"
        title="谁把事办成了"
        desc="别的工具告诉你花了多少 token，这里看值不值：每个会话最后是顺利完成、返工后完成，还是没解决。判断只依据会话里实际发生的事——agent 记录的执行结果、你说过的话、有没有换别的 agent 接着做——不调用大模型，每个结论都能点进去看原因。"
      >
        <fieldset className="seg" aria-label="时间范围">
          {PERIODS.map((p) => (
            <button
              key={p.label}
              type="button"
              className={days === p.days ? 'on' : ''}
              aria-pressed={days === p.days}
              onClick={() => setDays(p.days)}
            >
              {p.label}
            </button>
          ))}
        </fieldset>
      </PageHeader>

      {total === 0 ? (
        <Empty icon="chart" title="还没有可以统计的会话">
          更新索引后再来看看。你一句话都没说的会话（例如只有自动注入的内容）不参与统计。
        </Empty>
      ) : (
        <>
          <section className="score-summary">
            <div className="stat">
              <b>{total}</b>
              <span>个会话</span>
            </div>
            <div className="stat">
              <b className="ok">{pct(count('smooth'), total)}%</b>
              <span>顺利</span>
            </div>
            <div className="stat">
              <b>{pct(count('rework'), total)}%</b>
              <span>返工后完成</span>
            </div>
            <div className="stat">
              <b className={count('unresolved') ? 'danger' : ''}>{count('unresolved')}</b>
              <span>个没解决</span>
            </div>
            <div className="stat">
              <b>{sc.handoffs}</b>
              <span>次换 agent 接着做</span>
            </div>
            <div className="stat">
              <b>{retries}</b>
              <span>次接口重试</span>
            </div>
          </section>

          <div className="score-head">
            <h2 className="section-title">按 agent</h2>
            <OutcomeLegend />
          </div>
          <ScoreTable rows={sc.byAgent} kind="agent" />

          {models.length > 0 && (
            <>
              <div className="score-head">
                <h2 className="section-title">按模型</h2>
                <span className="meta">一个会话里输出最多的模型算作它的主力模型；只用过一次的模型不列出</span>
              </div>
              <ScoreTable rows={models} kind="model" />
            </>
          )}

          <p className="meta score-caveat">
            <Icon name="alert" size={13} /> 不同 agent
            接到的活难度不一样：交给它的都是小事，「每件顺利的事」自然便宜。横向比较时看同一类任务，样本少于 {FEW} 个的行仅供参考。
            {sc.byAgent.some((r) => r.key === 'dsh') && ' DeepSeek Harness 的记录里没有缓存数据，它的输入可能不含缓存部分。'}
          </p>

          <div className="score-head">
            <h2 className="section-title">逐个会话</h2>
            <fieldset className="seg small" aria-label="显示哪一类会话">
              {(['unresolved', 'rework', 'smooth'] as const).map((o) => (
                <button key={o} type="button" className={show === o ? 'on' : ''} aria-pressed={show === o} onClick={() => setShow(o)}>
                  {OUTCOME_LABEL[o]} {count(o)}
                </button>
              ))}
            </fieldset>
          </div>
          {listed.length === 0 ? (
            <p className="meta">没有{OUTCOME_LABEL[show]}的会话。</p>
          ) : (
            <ul className="score-sessions">
              {listed.slice(0, 50).map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => onOpen(s.id, null)}>
                    <span className="row1">
                      <AgentBadge agent={s.agent} />
                      <b>{s.title ?? '（无标题）'}</b>
                      <span className="meta">{when(s.startedAt)}</span>
                    </span>
                    <span className="row2 meta">
                      {s.reasons.length ? s.reasons.join('；') : `你说了 ${s.signals.turns} 句，agent 调用了 ${s.signals.toolCalls} 次工具`}
                      {s.model && ` · ${s.model}`}
                      {s.output > 0 && ` · 输出 ${tokens(s.output)} token`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <details className="score-rules">
            <summary>怎么判断的</summary>
            <dl>
              <dt>没解决</dt>
              <dd>
                最后一次执行命令失败；你说了「还是不行」之后 agent 再没成功执行过任何操作；或者之后在别的 agent
                里接着做同一件事（用鱼巢的接力，或者 12 小时内问了几乎同样的问题）。
              </dd>
              <dt>返工后完成</dt>
              <dd>你说过「还是不行」「不是这样」之类的话，或者换个说法把同一个要求又说了一遍，但最后没有落到「没解决」。</dd>
              <dt>顺利</dt>
              <dd>以上都没有。agent 自己试错再修好不算返工——这是正常的工作方式，你感受不到。</dd>
              <dt>接口重试</dt>
              <dd>
                一字不差地重发同一句话，或者 Try again、请再试一次：通常是请求失败（超时、额度不够、中转站出错），反映的是接口稳不稳，不是
                agent 能力。
              </dd>
              <dt>执行结果</dt>
              <dd>
                用 agent 自己记录的成败：Claude 的 is_error、Codex 的 Script failed 和退出码、WorkBuddy 的 exit code、DeepSeek 的
                isError。不在输出文字里找 error 这类词——代码片段和「0 failed」都会被误判。你自己中断的调用不算失败。
              </dd>
            </dl>
          </details>
        </>
      )}
    </div>
  );
}
