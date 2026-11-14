import { useEffect, useState } from 'react';
import {
  type ActivityStats,
  AGENT_LABEL,
  AGENTS,
  type AgentMemory,
  type ProfileDiff,
  type ProfileOverview,
  type ProfileVersion,
  profileApi,
  type Scope,
} from './api.ts';
import { when } from './format.ts';
import { AgentBadge, Cmd, ErrorPage, LoadingPage, PageHeader } from './ui.tsx';

const SCOPE_LABEL = (s: Scope) => (s === 'all' ? '综合' : `${AGENT_LABEL[s]} 眼中`);
const MEMORY_TYPE: Record<AgentMemory['type'], string> = {
  user: '关于你',
  feedback: '做事要求',
  project: '项目',
  reference: '参考',
  other: '其他',
};

export function ProfileView({ onOpen }: { onOpen: (sessionId: string) => void }) {
  const [data, setData] = useState<ProfileOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    profileApi.overview().then(setData, (e) => setError(e.message));
  }, []);

  if (error) return <ErrorPage title="Agent 眼中的你" error={error} />;
  if (!data) return <LoadingPage title="Agent 眼中的你" />;

  return (
    <div className="page profile">
      <PageHeader
        kicker="04 · 画像"
        title="Agent 眼中的你"
        desc="三个角度：本地统计出来的相处方式、agent 自己写下的记忆、大模型从你写的话里整理的画像（每条结论都附出处）。"
      />
      <Stats stats={data.stats} />
      <Memories memories={data.memories} onOpen={onOpen} />
      <Profiles latest={data.latest} versions={data.versions} onOpen={onOpen} />
    </div>
  );
}

function Stats({ stats }: { stats: ActivityStats }) {
  const peak = stats.byHour.indexOf(Math.max(...stats.byHour));
  return (
    <section>
      <h2>你和 AI 的相处方式</h2>
      <p className="hint">这一部分完全在本地计算，没有调用大模型。分叉会话复制的消息只算一次。</p>
      <div className="scan-summary">
        <div className="stat">
          <b>{stats.activeDays}</b>
          <span>活跃天数</span>
        </div>
        <div className="stat">
          <b>{stats.userMessages}</b>
          <span>亲手写的消息</span>
        </div>
        <div className="stat">
          <b>{AGENTS.reduce((n, a) => n + (stats.sessions[a] ?? 0), 0)}</b>
          <span
            title={AGENTS.filter((a) => stats.sessions[a])
              .map((a) => `${AGENT_LABEL[a]} ${stats.sessions[a]}`)
              .join('，')}
          >
            个会话，来自 {AGENTS.filter((a) => stats.sessions[a]).length} 个 agent
          </span>
        </div>
        <div className="stat">
          <b>{peak}点</b>
          <span>最活跃的时段</span>
        </div>
      </div>
      <HourChart byHour={stats.byHour} />
      <div className="chips-row">
        <span className="meta">你最常说的话</span>
        {stats.topPhrases.map((p) => (
          <span key={p.text} className="chip">
            「{p.text}」×{p.count}
          </span>
        ))}
      </div>
      <div className="chips-row">
        <span className="meta">会话最多的项目</span>
        {stats.topProjects.map((p) => (
          <span key={p.name} className="chip">
            {p.name} · {p.sessions}
          </span>
        ))}
      </div>
    </section>
  );
}

/** 单一系列的柱状图：一种颜色、不需要图例，悬停显示数值，并提供表格视图 */
function HourChart({ byHour }: { byHour: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...byHour, 1);
  return (
    <figure className="hour-chart">
      <figcaption>
        各时段的消息数 <span className="meta">（本地时间）</span>
      </figcaption>
      {/* 图形只给看得见的人；读屏软件读下面的「以表格查看」，所以整块 aria-hidden，悬停提示也只是鼠标用户的增强 */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 见上一行 */}
      <div className="bars" onMouseLeave={() => setHover(null)} aria-hidden="true">
        {byHour.map((n, h) => (
          // biome-ignore lint/a11y/noStaticElementInteractions lint/suspicious/noArrayIndexKey: 同上；h 是 0–23 点，本身就是稳定的身份
          <div key={h} className="bar-slot" onMouseEnter={() => setHover(h)}>
            <div className="bar" style={{ height: `${(n / max) * 100}%` }} />
            {hover === h && (
              <div className="tip">
                {h}:00–{h + 1}:00 · <b>{n}</b> 条
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="axis">
        {[0, 6, 12, 18].map((h) => (
          <span key={h} style={{ left: `${((h + 0.5) / 24) * 100}%` }}>
            {h}点
          </span>
        ))}
      </div>
      <details className="table-view">
        <summary>以表格查看</summary>
        <table>
          <tbody>
            {byHour.map((n, h) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: h 是 0–23 点，本身就是稳定的身份
              <tr key={h}>
                <th>{h}:00</th>
                <td>{n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

function Memories({ memories, onOpen }: { memories: AgentMemory[]; onOpen: (sessionId: string) => void }) {
  return (
    <section>
      <h2>agent 已经记住的事</h2>
      <p className="hint">
        这些是 agent 在和你合作时自己写下的记忆，下次对话会自动读取：Claude Code 存在 ~/.claude/projects/*/memory/，WorkBuddy 存在
        ~/.workbuddy 的 USER.md、MEMORY.md 和 memory/ 里。
      </p>
      {memories.length === 0 && <div className="empty">没有找到记忆文件。</div>}
      <div className="memories">
        {memories.map((m) => (
          <details key={m.agent + m.project + m.name} className="memory">
            <summary>
              <AgentBadge agent={m.agent} />
              <span className={'mem-type ' + m.type}>{MEMORY_TYPE[m.type]}</span>
              <b>{m.description || m.name}</b>
              <span className="meta">
                {m.project ? m.project + ' · ' : ''}
                {when(m.modified)}
              </span>
            </summary>
            <pre>{m.body}</pre>
            {m.originSessionId && (
              <button type="button" className="link" onClick={() => onOpen(`${m.agent}:${m.originSessionId}`)}>
                查看写下这条记忆的会话 →
              </button>
            )}
          </details>
        ))}
      </div>
    </section>
  );
}

function Profiles({
  latest,
  versions,
  onOpen,
}: {
  latest: ProfileOverview['latest'];
  versions: ProfileOverview['versions'];
  onOpen: (sessionId: string) => void;
}) {
  const available = (['all', ...AGENTS] as Scope[]).filter((s) => latest[s]);
  const [scope, setScope] = useState<Scope>(available[0] ?? 'all');
  const [diff, setDiff] = useState<ProfileDiff | null>(null);
  const v = latest[scope];

  useEffect(() => {
    setDiff(null);
    if (versions[scope] >= 2) profileApi.diff(scope).then(setDiff, () => setDiff(null));
  }, [scope, versions]);

  return (
    <section>
      <h2>大模型整理的画像</h2>
      {available.length === 0 ? (
        <div className="empty">
          还没有生成过。生成会把你写的话（已打码）发给大模型并产生费用，所以只能在命令行里明确执行：
          <Cmd>yuchao profile preview</Cmd>
          <Cmd>yuchao profile build --yes</Cmd>
        </div>
      ) : (
        <>
          <fieldset className="seg" aria-label="画像范围">
            {(['all', ...AGENTS] as Scope[])
              .filter((s) => s === 'all' || latest[s])
              .map((s) => (
                <button
                  type="button"
                  key={s}
                  className={scope === s ? 'on' : ''}
                  aria-pressed={scope === s}
                  disabled={!latest[s]}
                  onClick={() => setScope(s)}
                >
                  {SCOPE_LABEL(s)}
                </button>
              ))}
          </fieldset>
          {v ? <ProfileCard v={v} onOpen={onOpen} /> : <div className="empty">这个范围还没有生成画像。</div>}
          {diff && (diff.added.length > 0 || diff.removed.length > 0) && (
            <div className="diff">
              <h3>
                和上一版相比（{when(diff.from)} → {when(diff.to)}）
              </h3>
              {diff.added.map((t) => (
                <div key={'+' + t} className="added">
                  + {t}
                </div>
              ))}
              {diff.removed.map((t) => (
                <div key={'-' + t} className="removed">
                  − {t}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ProfileCard({ v, onOpen }: { v: ProfileVersion; onOpen: (sessionId: string) => void }) {
  return (
    <article className="profile-card">
      <p className="headline">{v.profile.headline}</p>
      <p className="meta">
        版本 #{v.id} · {when(v.createdAt)} · {v.meta.model} · 依据 {v.meta.sessions} 个会话 · 引用校验剔除了 {v.meta.droppedCitations}{' '}
        个不存在的引用、{v.meta.droppedClaims} 条没有依据的结论
      </p>
      {v.profile.sections.map((s) => (
        <div key={s.title} className="profile-section">
          <h3>{s.title}</h3>
          <ul>
            {s.claims.map((c) => (
              <Claim key={c.text} claim={c} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      ))}
    </article>
  );
}

type ClaimData = ProfileVersion['profile']['sections'][number]['claims'][number];

/** 出处多时默认只显示前几个，避免一片标签盖过结论本身 */
function Claim({ claim, onOpen }: { claim: ClaimData; onOpen: (sessionId: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? claim.evidence : claim.evidence.slice(0, 3);
  return (
    <li>
      {claim.text}
      <span className="evidence">
        {shown.map((e) => (
          <button type="button" key={e.sessionId} className="chip" title={e.title} onClick={() => onOpen(e.sessionId)}>
            {AGENT_LABEL[e.agent]} · {e.title.length > 14 ? e.title.slice(0, 14) + '…' : e.title}
          </button>
        ))}
        {claim.evidence.length > shown.length && (
          <button type="button" className="chip more" onClick={() => setAll(true)} title="显示全部出处">
            +{claim.evidence.length - shown.length}
          </button>
        )}
      </span>
    </li>
  );
}
