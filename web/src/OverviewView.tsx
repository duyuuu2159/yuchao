import { useEffect, useState, type ReactNode } from 'react';
import { HandoffPanel } from './HandoffPanel.tsx';
import { AGENT_LABEL, AGENTS, api, configApi, handoffApi, serverApi, statsApi, type AuditResult, type ConfigStatus, type ServerReport, type SessionRow, type Stats } from './api.ts';
import { when } from './format.ts';
import { AgentBadge, Cmd, Icon, Skeleton, Status, type IconName, type View } from './ui.tsx';

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

  const relay = useLoad(() => handoffApi.get('latest').catch(() => null), reloadKey);
  const [relayOpen, setRelayOpen] = useState(false);

  return (
    <div className="page overview">
      <Masthead stats={stats} />
      <section className="hero">
        <h1>
          把每个 agent，
          <br />
          <span className="grad">都收进一个巢</span>
          <span className="dot">。</span>
        </h1>
        <div className="hero-cols">
          <div className="hero-col">
            <span className="label">卷首语</span>
            <Editorial stats={stats} scan={scan} />
          </div>
          <div className="hero-col">
            <span className="label">本期目录</span>
            <ol className="toc">
              {TOC.map(([v, name], i) => (
                <li key={v}>
                  <a href={'#/' + v}>
                    <em>{String(i + 1).padStart(2, '0')}</em>
                    {name}
                  </a>
                </li>
              ))}
            </ol>
          </div>
          <div className="hero-col">
            <span className="label">从这里开始</span>
            {relay instanceof Error || relay === null ? (
              <p className="meta">还没有可以接力的会话。</p>
            ) : !relay ? (
              <Skeleton lines={2} />
            ) : (
              <>
                <button type="button" className="btn cta" onClick={() => setRelayOpen(true)}>
                  <Icon name="relay" /> 接力上次的工作
                </button>
                <p className="meta relay-hint">
                  上次在 {AGENT_LABEL[relay.facts.agent]} 里：{relay.facts.title}
                </p>
              </>
            )}
            <a className="text-link" href="#/sessions">
              翻翻所有会话 <Icon name="arrow" size={14} />
            </a>
          </div>
        </div>
      </section>
      {relayOpen && relay && !(relay instanceof Error) && (
        <HandoffPanel sessionId={relay.facts.sessionId} agent={relay.facts.agent} raw={false} onClose={() => setRelayOpen(false)} />
      )}

      <SectionLabel no="01" name="此刻" />
      <Numbers stats={stats} />
      <div className="cards">
        <ScanCard scan={scan} go={go} />
        <ConfigCard configs={configs} go={go} />
        <ServerCard server={server} go={go} />
        <AgentsCard stats={stats} go={go} />
      </div>
      <SectionLabel no="02" name="最近" />
      <Recent sessions={recent} go={go} />
    </div>
  );
}

const TOC: [View, string][] = [
  ['sessions', '翻会话'],
  ['scan', '查泄露'],
  ['profile', '看画像'],
  ['config', '管配置'],
  ['server', '看服务器'],
];

const WEEK = '日一二三四五六';

/** 刊头：和个人网站一样，把这一天当成杂志的一期，期数是记录开始以来的第几天 */
function Masthead({ stats }: { stats: Stats | Error | undefined }) {
  const now = new Date();
  const first = stats && !(stats instanceof Error) && stats.range.first ? new Date(stats.range.first) : null;
  const issue = first ? Math.floor((now.getTime() - first.getTime()) / 86400000) + 1 : null;
  return (
    <div className="masthead">
      <span>
        <b>鱼巢</b> · 一本关于你和 AI 的本地杂志
      </span>
      <span>
        {issue !== null && `第 ${issue} 期 · `}
        {now.getFullYear()}.{now.getMonth() + 1}.{now.getDate()} · 星期{WEEK[now.getDay()]}
      </span>
    </div>
  );
}

/** 卷首语：用今天的真实数字写一句话，不是固定文案 */
function Editorial({ stats, scan }: { stats: Stats | Error | undefined; scan: AuditResult | Error | undefined }) {
  if (!stats || stats instanceof Error) return <Skeleton lines={2} />;
  const agents = stats.sessions.filter((s) => s.n).length;
  const you = stats.messages.find((m) => m.role === 'user')?.n ?? 0;
  const high = scan && !(scan instanceof Error) ? scan.findings.filter((f) => f.severity === 'high').length : null;
  return (
    <p className="editorial">
      你和 {agents} 个 agent 一共说了 {n(you)} 句话。
      {high === null ? '' : high > 0 ? `其中藏着 ${high} 个高风险的秘密，记得去换掉。` : '没有发现泄露的秘密，很好。'}
    </p>
  );
}

function SectionLabel({ no, name }: { no: string; name: string }) {
  return (
    <h2 className="section-label">
      <span className="kicker">
        {no} · {name}
      </span>
    </h2>
  );
}

function Numbers({ stats }: { stats: Stats | Error | undefined }) {
  if (stats instanceof Error) return <p className="err">{stats.message}</p>;
  if (!stats) return <Skeleton height={76} />;
  const role = (r: string) => stats.messages.find((m) => m.role === r)?.n ?? 0;
  const sessions = stats.sessions.reduce((a, s) => a + s.n, 0);
  const days = stats.range.first && stats.range.last ? Math.max(1, Math.round((Date.parse(stats.range.last) - Date.parse(stats.range.first)) / 86400000)) : 0;
  const items: [string, string, string?][] = [
    [n(sessions), '个会话', `来自 ${stats.sessions.filter((s) => s.n).length} 个 agent，含子 agent`],
    [n(role('user')), '条你写的消息'],
    [n(role('assistant')), '条 agent 回复'],
    [n(role('tool_call')), '次工具调用'],
    [n(days), '天的记录', stats.range.first ? `从 ${when(stats.range.first)} 起` : undefined],
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

function Card({ icon, title, view, go, action, children }: { icon: IconName; title: string; view: View; go: (v: View) => void; action: string; children: ReactNode }) {
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
        <p className="meta">扫描了 {n(scan.scannedMessages)} 条消息，用时 {(scan.ms / 1000).toFixed(1)} 秒。所有内容打码显示。</p>
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

function AgentsCard({ stats, go }: { stats: Stats | Error | undefined } & Go) {
  let body: ReactNode;
  if (stats instanceof Error) body = <p className="err">{stats.message}</p>;
  else if (!stats) body = <Skeleton lines={4} />;
  else {
    const count = (a: string) => stats.sessions.find((s) => s.agent === a)?.n ?? 0;
    const max = Math.max(1, ...AGENTS.map(count));
    // 同一种颜色的横条比长短，名字和数字直接写在旁边，不靠颜色区分
    body = (
      <table className="agent-bars">
        <tbody>
          {AGENTS.map((a) => (
            <tr key={a}>
              <th>{AGENT_LABEL[a]}</th>
              <td>
                <div className="hbar" style={{ width: `${(count(a) / max) * 100}%` }} />
              </td>
              <td>{count(a)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <Card icon="user" title="各 agent 的会话数" view="profile" go={go} action="看看 agent 眼中的你">
      {body}
    </Card>
  );
}

function Recent({ sessions, go }: { sessions: SessionRow[] | Error | undefined } & Go) {
  return (
    <section className="recent">
      {sessions instanceof Error ? (
        <p className="err">{sessions.message}</p>
      ) : !sessions ? (
        <Skeleton lines={5} />
      ) : sessions.length === 0 ? (
        <p className="meta">还没有数据。点左下角的「更新索引」，读取本机各个 agent 的会话。</p>
      ) : (
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
      )}
    </section>
  );
}
