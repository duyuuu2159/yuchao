import { useEffect, useMemo, useRef, useState, type Ref } from 'react';
import { AGENT_LABEL, AGENTS, api, type Agent, type Message, type SearchHit, type SessionDetail, type SessionRow } from './api.ts';
import { when } from './format.ts';
import { highlight, Markdown } from './Markdown.tsx';
import { HandoffPanel } from './HandoffPanel.tsx';
import { AgentBadge, Empty, Icon, Skeleton } from './ui.tsx';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** 按日期分组：今天、昨天、最近 7 天，更早的按月 */
export function dateGroup(ts: string | null, now = new Date()): string {
  if (!ts) return '时间未知';
  const d = new Date(ts);
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = Math.floor((day0 - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff < 7) return '最近 7 天';
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1} 月` : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

function grouped<T>(rows: T[], ts: (r: T) => string | null): [string, T[]][] {
  const out: [string, T[]][] = [];
  for (const r of rows) {
    const g = dateGroup(ts(r));
    if (out.at(-1)?.[0] === g) out.at(-1)![1].push(r);
    else out.push([g, [r]]);
  }
  return out;
}

interface Props {
  raw: boolean;
  reloadKey: number;
  openId: string | null;
  focusSeq: number | null;
  onOpen: (id: string | null, seq?: number | null) => void;
}

export function SessionsView({ raw, reloadKey, openId, focusSeq, onOpen }: Props) {
  const [agent, setAgent] = useState<Agent | undefined>();
  const [query, setQuery] = useState('');
  const [withTools, setWithTools] = useState(false);
  const q = useDebounced(query.trim(), 250);
  const terms = useMemo(() => q.split(/\s+/).filter(Boolean), [q]);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.sessions(agent, raw).then(setSessions, (e) => setError(e.message));
  }, [agent, raw, reloadKey]);

  useEffect(() => {
    if (!q) return setHits(null);
    let stale = false;
    api.search(q, agent, withTools, raw).then(
      (r) => !stale && setHits(r),
      (e) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [q, agent, withTools, raw, reloadKey]);

  // 「/」或 Ctrl+K 聚焦搜索框；正在别的输入框里打字时不抢焦点
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={'sessions' + (openId ? ' has-open' : '')}>
      <aside className="list">
        <div className="list-tools">
          <label className="search">
            <Icon name="search" />
            <input ref={searchRef} type="search" placeholder="搜索所有 agent 的对话" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索对话，多个词用空格分开" />
            <kbd>/</kbd>
          </label>
          <div className="filters">
            <div className="seg" role="group" aria-label="按 agent 筛选">
              {[undefined, ...AGENTS].map((a) => (
                <button key={a ?? 'all'} className={agent === a ? 'on' : ''} aria-pressed={agent === a} onClick={() => setAgent(a)}>
                  {a ? AGENT_LABEL[a] : '全部'}
                </button>
              ))}
            </div>
            {q && (
              <label className="check" title="同时搜索 agent 执行的命令和工具输出">
                <input type="checkbox" checked={withTools} onChange={(e) => setWithTools(e.target.checked)} />
                含工具调用
              </label>
            )}
          </div>
        </div>

        <div className="list-body">
          {error && <div className="err pad">{error}</div>}
          {hits ? (
            <>
              <div className="list-count">找到 {hits.length >= 100 ? '100+' : hits.length} 条</div>
              {hits.length === 0 && <Empty title="没有结果">两个字以下的词会逐条扫描，可以换个说法，或者勾选「含工具调用」。</Empty>}
              {hits.map((h) => (
                <button key={h.messageId} className={'item' + (openId === h.sessionId && focusSeq === h.seq ? ' active' : '')} onClick={() => onOpen(h.sessionId, h.seq)}>
                  <div className="title">{h.title ?? '（无标题）'}</div>
                  <div className="snippet">
                    <span className="role">{h.role === 'user' ? '你' : h.role === 'assistant' ? 'agent' : h.toolName ?? h.role}</span>
                    {highlight(h.snippet, terms)}
                  </div>
                  <div className="item-meta">
                    <AgentBadge agent={h.agent} />
                    <span>{when(h.ts)}</span>
                    {h.alsoIn > 0 && <span>另有 {h.alsoIn} 个分叉会话</span>}
                  </div>
                </button>
              ))}
            </>
          ) : !sessions ? (
            <div className="pad">
              <Skeleton lines={8} />
            </div>
          ) : sessions.length === 0 ? (
            <Empty icon="chat" title="还没有会话">点左下角的「更新索引」，读取本机各个 agent 的会话。</Empty>
          ) : (
            grouped(sessions, (s) => s.updatedAt).map(([label, rows]) => (
              <section key={label}>
                <h2 className="group">
                  {label} <span>{rows.length}</span>
                </h2>
                {rows.map((s) => (
                  <button key={s.id} className={'item' + (openId === s.id ? ' active' : '')} onClick={() => onOpen(s.id)}>
                    <div className="title">{s.title ?? '（无标题）'}</div>
                    <div className="item-meta">
                      <AgentBadge agent={s.agent} />
                      <span>{when(s.updatedAt)}</span>
                      <span>{s.messageCount} 条</span>
                      {s.archived && <span>已归档</span>}
                    </div>
                  </button>
                ))}
              </section>
            ))
          )}
        </div>
      </aside>

      <main className="reader">
        {openId ? (
          <SessionView id={openId} raw={raw} focusSeq={focusSeq} terms={terms} onOpen={onOpen} />
        ) : (
          <Empty icon="chat" title="选一个会话开始阅读">
            或者按 <kbd>/</kbd> 搜索。鱼巢只读取本机的会话文件，不会修改它们，也不会上传任何数据。
          </Empty>
        )}
      </main>
    </div>
  );
}

function SessionView({ id, raw, focusSeq, terms, onOpen }: { id: string; raw: boolean; focusSeq: number | null; terms: string[]; onOpen: Props['onOpen'] }) {
  const [s, setS] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);
  const [relay, setRelay] = useState(false);
  const focusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setS(null);
    setError(null);
    api.session(id, raw).then(setS, (e) => setError(e.message));
  }, [id, raw]);

  // 从搜索结果点进来时，命中的是工具调用就自动展开工具
  useEffect(() => {
    if (!s || focusSeq === null) return;
    const m = s.messages.find((x) => x.seq === focusSeq);
    if (m && (m.role === 'tool_call' || m.role === 'tool_result' || m.role === 'context')) setShowTools(true);
  }, [s, focusSeq]);

  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: 'center' });
  }, [s, focusSeq, showTools]);

  if (error) return <Empty icon="alert" title="打不开这个会话">{error}</Empty>;
  if (!s)
    return (
      <div className="reader-inner">
        <Skeleton lines={10} />
      </div>
    );

  const visible = s.messages.filter((m) => showTools || m.role === 'user' || m.role === 'assistant');
  const toolCount = s.messages.filter((m) => m.role === 'tool_call').length;
  const hidden = s.messages.length - s.messages.filter((m) => m.role === 'user' || m.role === 'assistant').length;

  return (
    <article>
      <header className="reader-head">
        <div className="reader-inner">
          <button className="back" onClick={() => onOpen(null)}>
            <Icon name="back" /> 返回列表
          </button>
          <div className="reader-title">
            <h1>{s.title ?? '（无标题）'}</h1>
            <button className="btn cta small" onClick={() => setRelay(true)} title="把这个会话整理成交接说明，粘贴给另一个 agent 接着做">
              <Icon name="relay" /> 接力
            </button>
          </div>
          <div className="item-meta">
            <AgentBadge agent={s.agent} />
            <span>
              {when(s.startedAt)} → {when(s.updatedAt)}
            </span>
            <span>{s.messageCount} 条记录</span>
            <span>{toolCount} 次工具调用</span>
          </div>
          {hidden > 0 && (
            <label className="check">
              <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} />
              显示工具调用和注入的上下文（{hidden} 条）
            </label>
          )}
        </div>
      </header>

      <div className="reader-inner reader-sub">
        <details className="source">
          <summary>来源和工作目录</summary>
          {s.cwd && <div className="mono">工作目录 {s.cwd}</div>}
          <div className="mono">会话文件 {s.sourcePath}</div>
        </details>
        {(s.parentId || s.children.length > 0) && (
          <div className="children">
            {s.parentId && (
              <button className="chip" onClick={() => onOpen(s.parentId!)}>
                <Icon name="back" size={12} /> 父会话
              </button>
            )}
            {s.children.length > 0 && <span>子 agent</span>}
            {s.children.map((c) => (
              <button key={c.id} className="chip" onClick={() => onOpen(c.id)}>
                {c.title ?? c.id}
              </button>
            ))}
          </div>
        )}
      </div>

      {relay && <HandoffPanel sessionId={s.id} agent={s.agent} raw={raw} onClose={() => setRelay(false)} />}

      <div className="reader-inner messages">
        {visible.length === 0 && <Empty title="这个会话里没有对话内容">只有工具调用或注入的上下文，勾选上面的选项可以查看。</Empty>}
        {visible.map((m) => (
          <MessageView key={m.seq} m={m} focused={m.seq === focusSeq} terms={terms} ref={m.seq === focusSeq ? focusRef : undefined} />
        ))}
      </div>
    </article>
  );
}

function MessageView({ m, focused, terms, ref }: { m: Message; focused: boolean; terms: string[]; ref?: Ref<HTMLDivElement> }) {
  const cls = 'msg ' + m.role + (focused ? ' focused' : '');
  if (m.role === 'user' || m.role === 'assistant') {
    return (
      <div className={cls} ref={ref}>
        <div className="who">
          {m.role === 'user' ? '你' : 'agent'} <span className="ts">{when(m.ts)}</span>
        </div>
        <Markdown text={m.text} terms={focused ? terms : []} />
      </div>
    );
  }
  const label = m.role === 'tool_call' ? `调用 ${m.toolName ?? '工具'}` : m.role === 'tool_result' ? '工具输出' : `上下文${m.toolName ? ' · ' + m.toolName : ''}`;
  return (
    <div className={cls} ref={ref}>
      <details open={focused}>
        <summary>
          {label} <span className="ts">{when(m.ts)}</span>
        </summary>
        <pre>{focused ? highlight(m.text, terms) : m.text}</pre>
      </details>
    </div>
  );
}
