import { useEffect, useState } from 'react';
import { type ClaimRow, type ClaimsReport, type ClaimVerdict, claimsApi } from './api.ts';
import { AgentBadge, Icon } from './ui.tsx';

export const VERDICT_LABEL: Record<ClaimVerdict, string> = {
  verified: '有据',
  contradicted: '对不上',
  stale: '改了没再测',
  unverifiable: '无从核对',
};
const VERDICTS: ClaimVerdict[] = ['verified', 'stale', 'contradicted', 'unverifiable'];

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** 一根横条按结论分段；颜色只是辅助，每段的名字和比例在 title 里，表格里另有数字 */
function ClaimBar({ row }: { row: ClaimRow }) {
  return (
    <div className="outcome-bar" role="img" aria-label={VERDICTS.map((v) => `${VERDICT_LABEL[v]} ${row[v]} 次`).join('，')}>
      {VERDICTS.map((v) =>
        row[v] ? <span key={v} className={'cv-' + v} style={{ flexGrow: row[v] }} title={`${VERDICT_LABEL[v]}：${row[v]} 次`} /> : null,
      )}
    </div>
  );
}

/**
 * 言行对账：agent 说「测试通过」的时候，它自己的执行记录对不对得上。
 * 放在成绩单页：成绩单看事情办成没有，这里看 agent 说的话靠不靠得住
 */
export function ClaimsSection({ days, onOpen }: { days?: number; onOpen: (sessionId: string, seq: number | null) => void }) {
  const [r, setR] = useState<ClaimsReport | null | Error>(null);

  useEffect(() => {
    let stale = false;
    setR(null);
    claimsApi.get(days).then(
      (x) => !stale && setR(x),
      (e) => !stale && setR(e instanceof Error ? e : new Error(String(e))),
    );
    return () => {
      stale = true;
    };
  }, [days]);

  if (r instanceof Error) return <p className="err">{r.message}</p>;
  if (!r || !r.claims) return null;
  const verified = r.byAgent.reduce((n, x) => n + x.verified, 0);

  return (
    <section className="claims">
      <div className="score-head">
        <h2 className="section-title">言行对账：说「测试通过」的时候，记录对得上吗</h2>
        <ul className="outcome-legend">
          {VERDICTS.map((v) => (
            <li key={v}>
              <i className={'cv-' + v} />
              {VERDICT_LABEL[v]}
            </li>
          ))}
        </ul>
      </div>
      <p className="share-lead">
        agent 一共说了 <b>{r.claims}</b> 次「测试通过」，<b>{verified}</b> 次能在它自己的执行记录里找到证据
        {r.flagged.length > 0 && (
          <>
            ，<b className="danger">{r.flagged.length}</b> 次对不上
          </>
        )}
      </p>

      <div className="score-table-wrap">
        <table className="score-table">
          <thead>
            <tr>
              <th scope="col">agent</th>
              <th scope="col" className="num">
                说了
              </th>
              <th scope="col" className="bar-col">
                结论
              </th>
              <th scope="col" className="num" title="最后一次测试成功，之后没再改代码">
                有据率
              </th>
              <th scope="col" className="num" title="测试之后又改了代码，改完一条命令都没跑">
                改了没再测
              </th>
              <th scope="col" className="num" title="最后一次测试失败，之后什么都没再跑">
                对不上
              </th>
              <th scope="col" className="num" title="记录里找不到测试，或者之后跑过别的命令">
                无从核对
              </th>
            </tr>
          </thead>
          <tbody>
            {r.byAgent.map((row) => (
              <tr key={row.key}>
                <th scope="row">
                  <AgentBadge agent={row.agents[0]} />
                </th>
                <td className="num">{row.claims}</td>
                <td className="bar-col">
                  <ClaimBar row={row} />
                </td>
                <td className="num strong">{pct(row.verified, row.claims)}%</td>
                <td className="num">{row.stale}</td>
                <td className="num">{row.contradicted}</td>
                <td className="num">{row.unverifiable}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {r.flagged.length > 0 && (
        <ul className="score-sessions claims-flagged">
          {r.flagged.slice(0, 20).map((c) => (
            <li key={`${c.sessionId}:${c.seq}`}>
              <button type="button" onClick={() => onOpen(c.sessionId, c.seq)}>
                <span className="row1">
                  <AgentBadge agent={c.agent} />
                  <span className={'verdict v-' + c.verdict}>{VERDICT_LABEL[c.verdict]}</span>
                  <b>「{c.sentence}」</b>
                </span>
                <span className="row2 meta">
                  {c.verdict === 'stale'
                    ? `测试（${c.test?.command}）之后改了 ${c.editedAfter?.files.map(fileName).join('、')}，改完一条命令都没跑`
                    : `最后一次测试（${c.test?.command}）是失败的，之后什么都没再跑`}
                  {' · '}
                  {c.title ?? '（无标题）'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className={'guard-card' + (r.guard.installed ? ' on' : '')}>
        <Icon name="shield" size={18} />
        <div>
          <b>守门{r.guard.installed ? '已装上' : '还没装'}</b>
          {r.guard.installed ? (
            <span className="meta">
              Claude 说「测试通过」准备停下时，鱼巢当场核对这一轮的记录，对不上就把它拦回去重新确认。已经拦下 {r.guard.blocks} 次。
            </span>
          ) : (
            <span className="meta">
              在命令行运行 <code>yuchao guard install --yes</code>：Claude
              说「测试通过」准备停下时，鱼巢当场核对，对不上就把它拦回去重新确认。只读会话记录，不跑测试、不联网；改设置前先记一个版本。
            </span>
          )}
        </div>
      </div>

      <details className="score-rules">
        <summary>怎么核对的</summary>
        <dl>
          <dt>有据</dt>
          <dd>在这句话之前，最后一次测试是成功的，之后没有再改代码。</dd>
          <dt>改了没再测</dt>
          <dd>测试之后又改了代码文件，改完一条命令都没跑，就说测试通过。改文档、改记忆、改打包发布脚本不算改代码。</dd>
          <dt>对不上</dt>
          <dd>
            最后一次测试的结果是失败，之后什么命令都没再跑，就说测试通过。测试结果优先看测试工具自己打印的汇总（ℹ fail 0、12
            passed），其次才看整条命令的退出码。
          </dd>
          <dt>无从核对</dt>
          <dd>记录里找不到它跑过的测试，或者改完之后跑过别的命令（可能用别的办法验证过）。宁可漏掉，也不冤枉。</dd>
        </dl>
      </details>
    </section>
  );
}
