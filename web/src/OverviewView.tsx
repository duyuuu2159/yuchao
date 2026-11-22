import { type ReactNode, useEffect, useState } from 'react';
import {
  AGENT_LABEL,
  type AuditResult,
  api,
  type ConfigStatus,
  configApi,
  handoffApi,
  type Scorecard,
  type ServerReport,
  type SessionRow,
  type Stats,
  scoreApi,
  serverApi,
  statsApi,
} from './api.ts';
import { when } from './format.ts';
import { HandoffPanel } from './HandoffPanel.tsx';
import { OutcomeBar, OutcomeLegend } from './ScoreView.tsx';
import { UsageSection } from './UsageSection.tsx';
import { AgentBadge, Cmd, Icon, type IconName, Skeleton, Status, type View } from './ui.tsx';

/** 加载一份数据：undefined 表示还在加载，Error 表示失败 */
function useLoad<T>(load: () => Promise<T>, key: number): T | Error | undefined {
  const [v, setV] = useState<T | Error | undefined>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: load 每次渲染都是新函数，放进依赖会无限请求；只在 key（更新索引次数）变化时重新加载
  useEffect(() => {
    let stale = false;
    load().then(
      (r) => !stale && setV(r),
      (e) => !stale && setV(e instanceof Error ? e : new Error(String(e))),
    );
    return () => {
      stale = true;
    };
  }, [key]);
  return v;
}

const n = (x: number) => x.toLocaleString('zh-CN');

export function OverviewView({ reloadKey, go }: { reloadKey: number; go: (view: View, id?: string | null) => void }) {
  const stats = useLoad(() => statsApi.get(), reloadKey);
  const scan = useLoad(() => api.scan(), reloadKey);
  const configs = useLoad(() => configApi.status(), reloadKey);
  const server = useLoad(async () => ((await serverApi.list()).length ? serverApi.status('') : null), reloadKey);
  const recent = useLoad(() => api.sessions(), reloadKey);
  const score = useLoad(() => scoreApi.get(), reloadKey);

  const relay = useLoad(() => handoffApi.get('latest').catch(() => null), reloadKey);
  const [relayOpen, setRelayOpen] = useState(false);

  return (
    <div className="page overview workbench">
      <header className="workbench-head">
        <div>
          <h1>工作台</h1>
          <p className="meta">直接查看本机已索引的会话和运行情况。</p>
        </div>
        <div className="workbench-action">
          {relay && !(relay instanceof Error) ? (
            <button type="button" className="btn cta" onClick={() => setRelayOpen(true)} title={relay.facts.title ?? undefined}>
              <Icon name="relay" size={16} /> 接力上次的工作
            </button>
          ) : (
            <a className="btn" href="#/sessions">
              <Icon name="chat" size={16} /> 浏览会话
            </a>
          )}
        </div>
      </header>
      {relayOpen && relay && !(relay instanceof Error) && (
        <HandoffPanel sessionId={relay.facts.sessionId} agent={relay.facts.agent} raw={false} onClose={() => setRelayOpen(false)} />
      )}

      <Numbers stats={stats} />
      <div className="workbench-board">
        <div className="workbench-activity">
          <Recent sessions={recent} go={go} />
          <section className="workbench-usage" aria-labelledby="workbench-usage-heading">
            <h2 id="workbench-usage-heading">近期用量</h2>
            <UsageSection reloadKey={reloadKey} onOpen={(id) => go('sessions', id)} />
          </section>
        </div>
        <aside className="workbench-aside" aria-label="本机状态">
          <TokenTotal stats={stats} />
          <ScanCard scan={scan} go={go} />
          <ConfigCard configs={configs} go={go} />
          <ServerCard server={server} go={go} />
          <ScoreCard score={score} go={go} />
        </aside>
      </div>
    </div>
  );
}

/** 大数字写成「亿」「万」：36.5 亿比 3,650,000,000 好读 */
export function bigNumber(n: number): { value: string; unit: string } {
  if (n >= 1e8) return { value: (n / 1e8).toFixed(n >= 1e10 ? 0 : 1), unit: '亿' };
  if (n >= 1e4) return { value: (n / 1e4).toFixed(n >= 1e6 ? 0 : 1), unit: '万' };
  return { value: String(n), unit: '' };
}

/**
 * 本机累计消耗的 token：一个大数字，下面一根按 agent 分段的横条。
 * 段的颜色是各 agent 的识别色，名字和占比都写在下面，不靠颜色读。
 */
function TokenTotal({ stats }: { stats: Stats | Error | undefined }) {
  if (!stats || stats instanceof Error) {
    return (
      <section className="token-total">
        <h2>本机用量</h2>
        {stats instanceof Error ? <p className="err">{stats.message}</p> : <Skeleton lines={3} />}
      </section>
    );
  }
  const { total, byAgent, since } = stats.usage;
  const all = total.input + total.output;
  const big = bigNumber(all);
  const share = (a: { input: number; output: number }) => (all ? ((a.input + a.output) / all) * 100 : 0);
  const cache = total.input ? Math.round((total.cacheRead / total.input) * 100) : 0;
  return (
    <section className="token-total">
      <h2>本机用量</h2>
      <p className="token-big">
        <b>{big.value}</b>
        <span>{big.unit} token</span>
      </p>
      {all > 0 && (
        <div
          className="token-bar"
          role="img"
          aria-label={byAgent.map((a) => `${AGENT_LABEL[a.agent]} ${Math.round(share(a))}%`).join('，')}
        >
          {byAgent.map((a) => (
            <span
              key={a.agent}
              className={'a-' + a.agent}
              style={{ flexGrow: a.input + a.output }}
              title={`${AGENT_LABEL[a.agent]}：${bigNumber(a.input + a.output).value}${bigNumber(a.input + a.output).unit} token`}
            />
          ))}
        </div>
      )}
      <ul className="token-legend">
        {byAgent.map((a) => (
          <li key={a.agent}>
            <i className={'a-' + a.agent} />
            {AGENT_LABEL[a.agent]} <b>{share(a) > 0 && share(a) < 1 ? '<1' : Math.round(share(a))}%</b>
          </li>
        ))}
      </ul>
      <p className="meta">
        {n(total.requests)} 次请求，输出 {bigNumber(total.output).value} {bigNumber(total.output).unit}
        <br />
        输入里 {cache}% 命中缓存{since && `，从 ${new Date(since).getMonth() + 1} 月 ${new Date(since).getDate()} 日起`}
      </p>
    </section>
  );
}

function Numbers({ stats }: { stats: Stats | Error | undefined }) {
  if (stats instanceof Error) return <p className="err">{stats.message}</p>;
  if (!stats) return <Skeleton height={76} />;
  const role = (r: string) => stats.messages.find((m) => m.role === r)?.n ?? 0;
  const sessions = stats.sessions.reduce((a, s) => a + s.n, 0);
  const days =
    stats.range.first && stats.range.last
      ? Math.max(1, Math.round((Date.parse(stats.range.last) - Date.parse(stats.range.first)) / 86400000))
      : 0;
  const items: [string, string, string?][] = [
    [n(sessions), '会话', '含子 agent'],
    [n(role('user')), '用户消息', `${n(role('assistant'))} 条 agent 回复`],
    [n(role('tool_call')), '工具调用'],
    [n(stats.sessions.filter((s) => s.n).length), '已收录 Agent', `共 ${n(days)} 天记录`],
  ];
  return (
    <dl className="numbers">
      {items.map(([value, label, hint]) => (
        <div key={label} title={hint}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Card({
  icon,
  title,
  view,
  go,
  action,
  children,
}: {
  icon: IconName;
  title: string;
  view: View;
  go: (v: View) => void;
  action: string;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <h2>
        <Icon name={icon} /> {title}
      </h2>
      <div className="card-body">{children}</div>
      <button type="button" className="card-link" onClick={() => go(view)}>
        {action} <Icon name="arrow" size={14} />
      </button>
    </section>
  );
}

type Go = { go: (v: View, id?: string | null) => void };

function ScanCard({ scan, go }: { scan: AuditResult | Error | undefined } & Go) {
  let body: ReactNode;
  if (scan instanceof Error) body = <p className="err">{scan.message}</p>;
  else if (!scan) body = <Skeleton />;
  else {
    const high = scan.findings.filter((f) => f.severity === 'high').length;
    const sessions = new Set(scan.findings.flatMap((f) => f.occurrences.map((o) => o.sessionId))).size;
    body = (
      <>
        <p className="big">
          <b>{scan.findings.length}</b> 个泄露的秘密
        </p>
        {scan.findings.length === 0 ? (
          <Status level="ok">没有发现泄露</Status>
        ) : (
          <Status level={high ? 'bad' : 'warn'}>
            {high} 个高风险，至少出现在 {sessions} 个会话里
          </Status>
        )}
        <p className="meta">
          扫描了 {n(scan.scannedMessages)} 条消息，用时 {(scan.ms / 1000).toFixed(1)} 秒。所有内容打码显示。
        </p>
      </>
    );
  }
  return (
    <Card icon="shield" title="安全扫描" view="scan" go={go} action="查看并处理">
      {body}
    </Card>
  );
}

function ConfigCard({ configs, go }: { configs: ConfigStatus[] | Error | undefined } & Go) {
  let body: ReactNode;
  if (configs instanceof Error) body = <p className="err">{configs.message}</p>;
  else if (!configs) body = <Skeleton />;
  else {
    const present = configs.filter((c) => c.exists);
    const broken = present.filter((c) => c.error);
    const changed = present.filter((c) => c.changed && !c.error);
    const versions = configs.reduce((a, c) => a + c.versions, 0);
    body = (
      <>
        <p className="big">
          <b>{present.length}</b> 个配置文件，<b>{versions}</b> 个历史版本
        </p>
        {broken.length > 0 ? (
          <Status level="bad">{broken.length} 个当前文件已损坏</Status>
        ) : changed.length > 0 ? (
          <Status level="warn">{changed.length} 个有未记录的修改</Status>
        ) : (
          <Status level="ok">当前文件格式都正常</Status>
        )}
        <p className="meta">每次更新索引时自动记录变化，改坏了可以对比和回滚。</p>
      </>
    );
  }
  return (
    <Card icon="sliders" title="配置管家" view="config" go={go} action="查看版本时间线">
      {body}
    </Card>
  );
}

function ServerCard({ server, go }: { server: ServerReport | null | Error | undefined } & Go) {
  let body: ReactNode;
  if (server instanceof Error) body = <Status level="bad">{server.message}</Status>;
  else if (server === undefined) body = <Skeleton />;
  else if (server === null)
    body = (
      <>
        <p className="meta">还没有添加服务器。添加后可以在这里看到服务、线上版本和磁盘。</p>
        <Cmd>yuchao server add 名字 root@服务器IP</Cmd>
      </>
    );
  else {
    const s = server.status;
    const disk = Math.round((s.disk.used / s.disk.total) * 100);
    const worst = server.warnings.some((w) => w.level === 'bad') ? 'bad' : server.warnings.length ? 'warn' : 'ok';
    body = (
      <>
        <p className="big">
          <b>{server.server.name}</b> 线上版本 {s.releases.current ?? '—'}
        </p>
        {server.warnings.length === 0 ? (
          <Status level="ok">服务运行正常</Status>
        ) : (
          <Status level={worst}>
            {server.warnings[0].text}
            {server.warnings.length > 1 && `，另有 ${server.warnings.length - 1} 项`}
          </Status>
        )}
        <p className="meta">
          磁盘已用 {disk}% · {s.releases.total} 个 release · 检查于 {when(server.checkedAt)}
        </p>
      </>
    );
  }
  return (
    <Card icon="server" title="服务器" view="server" go={go} action="打开服务器面板">
      {body}
    </Card>
  );
}

function ScoreCard({ score, go }: { score: Scorecard | Error | undefined } & Go) {
  let body: ReactNode;
  if (score instanceof Error) body = <p className="err">{score.message}</p>;
  else if (!score) body = <Skeleton lines={4} />;
  else if (!score.sessions.length) body = <p className="meta">更新索引后，这里会显示每个 agent 把事办成了多少。</p>;
  else {
    const total = score.sessions.length;
    const smooth = score.sessions.filter((s) => s.outcome === 'smooth').length;
    // 每个 agent 一行：名字、结果条、顺利的比例；比例直接写成数字，不靠颜色读
    body = (
      <>
        <p className="big">
          <b>{Math.round((smooth / total) * 100)}%</b> 的会话顺利完成
        </p>
        <table className="score-mini">
          <tbody>
            {score.byAgent.map((r) => (
              <tr key={r.key}>
                <th>{AGENT_LABEL[r.agents[0]]}</th>
                <td>
                  <OutcomeBar row={r} />
                </td>
                <td>{Math.round((r.smooth / r.sessions) * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <OutcomeLegend />
      </>
    );
  }
  return (
    <Card icon="chart" title="成绩单" view="score" go={go} action="看看谁把事办成了">
      {body}
    </Card>
  );
}

function Recent({ sessions, go }: { sessions: SessionRow[] | Error | undefined } & Go) {
  return (
    <section className="recent">
      <header className="workbench-section-head">
        <h2>最近会话</h2>
        <a href="#/sessions">
          全部会话 <Icon name="arrow" size={14} />
        </a>
      </header>
      {sessions instanceof Error ? (
        <p className="err">{sessions.message}</p>
      ) : !sessions ? (
        <Skeleton lines={5} />
      ) : sessions.length === 0 ? (
        <p className="meta">还没有数据。点左下角的「更新索引」，读取本机各个 agent 的会话。</p>
      ) : (
        <div className="workbench-session-table">
          <div className="workbench-table-label" aria-hidden="true">
            <span>会话标题</span>
            <span>Agent</span>
            <span>更新时间</span>
          </div>
          <ul>
            {sessions.slice(0, 6).map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => go('sessions', s.id)}>
                  <span className="title">{s.title ?? '（无标题）'}</span>
                  <AgentBadge agent={s.agent} />
                  <span className="meta">{when(s.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
