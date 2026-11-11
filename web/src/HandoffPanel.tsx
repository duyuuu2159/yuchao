import { useEffect, useRef, useState } from 'react';
import { AGENT_LABEL, AGENTS, handoffApi, type Agent, type Handoff } from './api.ts';
import { Markdown } from './Markdown.tsx';
import { AgentBadge, Icon, Skeleton } from './ui.tsx';

/**
 * 接力：把一个会话整理成交接说明，复制后粘贴给另一个 agent。
 * 用原生 <dialog>：自带焦点限制、Esc 关闭和背景遮罩，不用自己处理。
 */
export function HandoffPanel({ sessionId, agent, raw, onClose }: { sessionId: string; agent: Agent; raw: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [to, setTo] = useState<Agent | undefined>(AGENTS.find((a) => a !== agent));
  const [h, setH] = useState<Handoff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'preview' | 'source'>('preview');

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  useEffect(() => {
    setH(null);
    setError(null);
    handoffApi.get(sessionId, to, raw).then(setH, (e) => setError(e.message));
  }, [sessionId, to, raw]);

  function download() {
    if (!h) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([h.markdown], { type: 'text/markdown;charset=utf-8' }));
    a.download = `接力-${h.facts.title.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    // 点遮罩关闭只是鼠标用户的快捷方式；键盘用户用 Esc（<dialog> 原生支持）或右上角的关闭按钮
    // biome-ignore lint/a11y/useKeyWithClickEvents: 见上一行
    <dialog
      ref={ref}
      className="handoff"
      onClose={onClose}
      onClick={(e) => e.target === ref.current && ref.current.close()}
      aria-labelledby="handoff-title"
    >
      <header className="handoff-head">
        <div>
          <span className="kicker">接力</span>
          <h2 id="handoff-title">
            换一个 agent 接着做<span className="dot">。</span>
          </h2>
          <p>
            额度用完、上下文太长、或者想换个模型试试时用。鱼巢在本地从会话记录里整理出目标、改过的文件、命令和报错，不调用大模型，也不花钱。
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={() => ref.current?.close()} aria-label="关闭">
          <Icon name="x" />
        </button>
      </header>

      <div className="handoff-route">
        <span className="from">
          <small>从</small>
          <AgentBadge agent={agent} />
        </span>
        <Icon name="arrow" />
        <fieldset className="seg" aria-label="交给哪个 agent">
          {AGENTS.filter((a) => a !== agent).map((a) => (
            <button type="button" key={a} className={to === a ? 'on' : ''} aria-pressed={to === a} onClick={() => setTo(a)}>
              {AGENT_LABEL[a]}
            </button>
          ))}
          <button type="button" className={to === undefined ? 'on' : ''} aria-pressed={to === undefined} onClick={() => setTo(undefined)}>
            不指定
          </button>
        </fieldset>
      </div>

      {error ? (
        <p className="err">{error}</p>
      ) : !h ? (
        <Skeleton lines={8} />
      ) : (
        <>
          <ul className="handoff-facts">
            <li>
              <b>{h.facts.files.length}</b> 个改过的文件
            </li>
            <li>
              <b>{h.facts.commands.length}</b> 条最近的命令
            </li>
            <li>
              <b>{h.facts.errors.length}</b> 个报错
            </li>
            <li title="中文按一字一个 token、英文按四个字符一个 token 粗略估算">
              约 <b>{h.tokens.toLocaleString()}</b> token
            </li>
          </ul>
          <div className="handoff-body">
            <fieldset className="seg small" aria-label="显示方式">
              <button
                type="button"
                className={view === 'preview' ? 'on' : ''}
                aria-pressed={view === 'preview'}
                onClick={() => setView('preview')}
              >
                预览
              </button>
              <button
                type="button"
                className={view === 'source' ? 'on' : ''}
                aria-pressed={view === 'source'}
                onClick={() => setView('source')}
              >
                原文
              </button>
            </fieldset>
            {view === 'preview' ? <Markdown text={h.markdown} /> : <pre className="handoff-source">{h.markdown}</pre>}
          </div>
          {raw && <p className="handoff-warn">「显示原文」开着：这份说明里的密码和密钥没有打码，粘贴到别处前请确认。</p>}
          <footer className="handoff-foot">
            <span className="meta">复制后，在{to ? ` ${AGENT_LABEL[to]} ` : '新的 agent '}里开一个新对话，直接粘贴。</span>
            <button type="button" className="btn ghost" onClick={download}>
              下载 .md
            </button>
            <CopyBig text={h.markdown} />
          </footer>
        </>
      )}
    </dialog>
  );
}

function CopyBig({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1800);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      className="btn cta"
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => setDone(true),
          () => {},
        )
      }
    >
      <Icon name={done ? 'check' : 'copy'} />
      {done ? '已复制，去粘贴吧' : '复制交接说明'}
    </button>
  );
}
