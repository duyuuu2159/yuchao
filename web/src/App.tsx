import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { AGENT_LABEL, AGENTS, api, type Agent, type IndexResult, type Message, type SearchHit, type SessionDetail, type SessionRow } from './api.ts';
import { when } from './format.ts';
import { ConfigView } from './ConfigView.tsx';
import { ProfileView } from './ProfileView.tsx';
import { ScanView } from './ScanView.tsx';


/** 把命中的关键词包上 <mark> */
function highlight(text: string, terms: string[]): ReactNode {
  const words = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return text;
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function App() {
  const [view, setView] = useState<'sessions' | 'scan' | 'profile' | 'config'>('sessions');
  // 默认打码显示，截图和演示时不会把密码露出去
  const [raw, setRaw] = useState(false);
  const [agent, setAgent] = useState<Agent | undefined>();
  const [query, setQuery] = useState('');
  const [withTools, setWithTools] = useState(false);
  const q = useDebounced(query.trim(), 250);
  const terms = useMemo(() => q.split(/\s+/).filter(Boolean), [q]);

  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [focusSeq, setFocusSeq] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [lastIndex, setLastIndex] = useState<IndexResult | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

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

  async function reindex() {
    setIndexing(true);
    setError(null);
    try {
      setLastIndex(await api.index());
      setReloadKey((k) => k + 1);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIndexing(false);
    }
  }

  function open(id: string, seq: number | null = null) {
    setView('sessions');
    setOpenId(id);
    setFocusSeq(seq);
  }

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo">鱼巢</span>
          <span className="sub">AgentNest</span>
        </div>
        <nav className="tabs" aria-label="页面">
          <button className={view === 'sessions' ? 'on' : ''} onClick={() => setView('sessions')}>
            会话
          </button>
          <button className={view === 'scan' ? 'on' : ''} onClick={() => setView('scan')}>
            安全扫描
          </button>
          <button className={view === 'profile' ? 'on' : ''} onClick={() => setView('profile')}>
            画像
          </button>
          <button className={view === 'config' ? 'on' : ''} onClick={() => setView('config')}>
            配置
          </button>
        </nav>
        <input
          className="search"
          type="search"
          placeholder="搜索所有 agent 的对话，多个词用空格分开"
          value={query}
          onChange={(e) => (setQuery(e.target.value), setView('sessions'))}
          autoFocus
        />
        <div className="seg" role="group" aria-label="按 agent 筛选">
          {[undefined, ...AGENTS].map((a) => (
            <button key={a ?? 'all'} className={agent === a ? 'on' : ''} onClick={() => setAgent(a)}>
              {a ? AGENT_LABEL[a] : '全部'}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={withTools} onChange={(e) => setWithTools(e.target.checked)} />
          含工具调用
        </label>
        <label className="check" title="默认把密码、密钥打码显示，方便截图和演示">
          <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />
          显示原文
        </label>
        <button className="primary" onClick={reindex} disabled={indexing}>
          {indexing ? '索引中…' : '更新索引'}
        </button>
      </header>

      {(error || lastIndex) && (
        <div className={error ? 'notice err' : 'notice'}>
          {error ??
            `已更新 ${lastIndex!.indexed} 个会话，${lastIndex!.skipped} 个没有变化，用时 ${(lastIndex!.ms / 1000).toFixed(1)} 秒` +
              (lastIndex!.errors.length ? `，${lastIndex!.errors.length} 个文件解析失败` : '')}
          <button className="link" onClick={() => (setError(null), setLastIndex(null))}>
            关闭
          </button>
        </div>
      )}

      {view === 'scan' ? (
        <main className="detail">
          <ScanView key={reloadKey} onOpen={open} />
        </main>
      ) : view === 'profile' ? (
        <main className="detail">
          <ProfileView key={reloadKey} onOpen={open} />
        </main>
      ) : view === 'config' ? (
        <main className="detail">
          <ConfigView key={reloadKey} />
        </main>
      ) : (
        <div className="body">
          <aside className="list">
            {hits ? (
              <>
                <div className="list-head">找到 {hits.length >= 100 ? '100+' : hits.length} 条</div>
                {hits.length === 0 && <div className="empty">没有结果。两个字以下的词会逐条扫描，可以试试换个说法。</div>}
                {hits.map((h) => (
                  <button key={h.messageId} className={'item' + (openId === h.sessionId && focusSeq === h.seq ? ' active' : '')} onClick={() => open(h.sessionId, h.seq)}>
                    <div className="item-top">
                      <span className={'badge ' + h.agent}>{AGENT_LABEL[h.agent]}</span>
                      <span className="title">{h.title ?? '（无标题）'}</span>
                    </div>
                    <div className="snippet">
                      <span className="role">{h.role === 'user' ? '你' : h.role === 'assistant' ? 'agent' : h.toolName ?? h.role}</span>
                      {highlight(h.snippet, terms)}
                    </div>
                    <div className="meta">
                      {when(h.ts)}
                      {h.alsoIn > 0 && ` · 另有 ${h.alsoIn} 个分叉会话`}
                    </div>
                  </button>
                ))}
              </>
            ) : (
              <>
                <div className="list-head">{sessions.length} 个会话</div>
                {sessions.length === 0 && <div className="empty">还没有数据，点右上角「更新索引」。</div>}
                {sessions.map((s) => (
                  <button key={s.id} className={'item' + (openId === s.id ? ' active' : '')} onClick={() => open(s.id)}>
                    <div className="item-top">
                      <span className={'badge ' + s.agent}>{AGENT_LABEL[s.agent]}</span>
                      <span className="title">{s.title ?? '（无标题）'}</span>
                    </div>
                    <div className="meta">
                      {when(s.updatedAt)} · {s.messageCount} 条{s.archived && ' · 已归档'}
                    </div>
                  </button>
                ))}
              </>
            )}
          </aside>

          <main className="detail">
            {openId ? (
              <SessionView id={openId} raw={raw} focusSeq={focusSeq} terms={terms} onOpen={open} />
            ) : (
              <div className="placeholder">
                <p>从左边选一个会话，或者在上面搜索。</p>
                <p className="hint">鱼巢只读取你本机的会话文件，不会修改它们，也不会上传任何数据。</p>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

function SessionView({ id, raw, focusSeq, terms, onOpen }: { id: string; raw: boolean; focusSeq: number | null; terms: string[]; onOpen: (id: string) => void }) {
  const [s, setS] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTools, setShowTools] = useState(false);
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
    if (m && (m.role === 'tool_call' || m.role === 'tool_result')) setShowTools(true);
  }, [s, focusSeq]);

  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: 'center' });
  }, [s, focusSeq, showTools]);

  if (error) return <div className="placeholder err">{error}</div>;
  if (!s) return <div className="placeholder">加载中…</div>;

  const visible = s.messages.filter((m) => showTools || m.role === 'user' || m.role === 'assistant');
  const toolCount = s.messages.filter((m) => m.role === 'tool_call').length;

  return (
    <article>
      <header className="detail-head">
        <div className="item-top">
          <span className={'badge ' + s.agent}>{AGENT_LABEL[s.agent]}</span>
          <h1>{s.title ?? '（无标题）'}</h1>
        </div>
        <div className="meta">
          {when(s.startedAt)} → {when(s.updatedAt)} · {s.messageCount} 条记录 · {toolCount} 次工具调用
        </div>
        {s.cwd && <div className="meta mono">工作目录 {s.cwd}</div>}
        <div className="meta mono">来源 {s.sourcePath}</div>
        {s.parentId && (
          <button className="link" onClick={() => onOpen(s.parentId!)}>
            ← 返回父会话
          </button>
        )}
        {s.children.length > 0 && (
          <div className="children">
            子 agent：
            {s.children.map((c) => (
              <button key={c.id} className="chip" onClick={() => onOpen(c.id)}>
                {c.title ?? c.id}
              </button>
            ))}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} />
          显示工具调用和注入的上下文
        </label>
      </header>

      <div className="messages">
        {visible.map((m) => (
          <MessageView key={m.seq} m={m} focused={m.seq === focusSeq} terms={terms} ref={m.seq === focusSeq ? focusRef : undefined} />
        ))}
      </div>
    </article>
  );
}

function MessageView({ m, focused, terms, ref }: { m: Message; focused: boolean; terms: string[]; ref?: Ref<HTMLDivElement> }) {
  const cls = 'msg ' + m.role + (focused ? ' focused' : '');
  const body = focused ? highlight(m.text, terms) : m.text;
  if (m.role === 'user' || m.role === 'assistant') {
    return (
      <div className={cls} ref={ref}>
        <div className="who">
          {m.role === 'user' ? '你' : 'agent'} <span className="ts">{when(m.ts)}</span>
        </div>
        <div className="text">{body}</div>
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
        <pre>{body}</pre>
      </details>
    </div>
  );
}
