import { useEffect, useState } from 'react';
import { AGENT_LABEL, type Diagnosis, diagnosisApi, type MarkKind, type Message } from './api.ts';
import { when } from './format.ts';
import { OUTCOME_LABEL } from './ScoreView.tsx';
import { Icon } from './ui.tsx';

/** 时间线上每种标记：放在哪一行、叫什么。形状和颜色在 style.css 的 .tm-* 里，图例用同样的形状 */
const KINDS: { kind: MarkKind; label: string; lane: 'you' | 'agent' }[] = [
  { kind: 'ask', label: '你提的要求', lane: 'you' },
  { kind: 'negative', label: '说不行', lane: 'you' },
  { kind: 'reask', label: '换个说法重说', lane: 'you' },
  { kind: 'retry', label: '重发 / Try again', lane: 'you' },
  { kind: 'positive', label: '说好了', lane: 'you' },
  { kind: 'error', label: '执行失败', lane: 'agent' },
];
const LABEL = Object.fromEntries(KINDS.map((k) => [k.kind, k.label])) as Record<MarkKind, string>;

/**
 * 复盘：这个会话最后怎么样、为什么，以及整个过程里在哪儿出过状况。
 * - 两行时间线：上面是你说的话，下面是 agent 执行失败的地方；横轴是会话里的第几条记录
 * - 收尾卡住的那一段（之后再没好起来）铺一层底色
 * - 点标记、点理由、点图例都跳到对应的消息；图例是按钮，键盘也能逐个跳
 * - 图形对读屏软件隐藏，同样的信息在理由和图例里
 */
export function SessionRetro({
  id,
  raw,
  messages,
  focusSeq,
  onJump,
  onOpenSession,
}: {
  id: string;
  raw: boolean;
  messages: Message[];
  focusSeq: number | null;
  onJump: (seq: number) => void;
  onOpenSession: (id: string) => void;
}) {
  const [d, setD] = useState<Diagnosis | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    let stale = false;
    setD(null);
    setHover(null);
    diagnosisApi.get(id, raw).then(
      (r) => !stale && setD(r),
      // 复盘是附加信息，拿不到时不影响阅读会话
      () => !stale && setD(null),
    );
    return () => {
      stale = true;
    };
  }, [id, raw]);

  if (!d || (!d.outcome && !d.marks.length)) return null;

  const [lo, hi] = d.span;
  const x = (seq: number) => ((seq - lo) / Math.max(1, hi - lo)) * 100;
  const count = (k: MarkKind) => d.marks.filter((m) => m.kind === k).length;
  const stuck = d.signals.at.stuckFrom;
  const excerpt = (seq: number) => {
    const t =
      messages
        .find((m) => m.seq === seq)
        ?.text.replace(/\s+/g, ' ')
        .trim() ?? '';
    return t.length > 90 ? t.slice(0, 90) + '…' : t;
  };
  /** 跳到当前位置之后的下一处，到底了从头再来 */
  const next = (k: MarkKind) => {
    const xs = d.marks.filter((m) => m.kind === k);
    const after = xs.find((m) => m.seq > (focusSeq ?? -1)) ?? xs[0];
    if (after) onJump(after.seq);
  };
  const h = hover === null ? null : d.marks[hover];
  const first = messages[0]?.ts ?? null;
  const last = messages.at(-1)?.ts ?? null;

  return (
    <section className="retro" aria-label="复盘">
      <div className="retro-head">
        <span className="kicker">复盘</span>
        {d.outcome ? (
          <span className={'retro-outcome o-' + d.outcome}>
            <i className={'seg-' + d.outcome} />
            {OUTCOME_LABEL[d.outcome]}
          </span>
        ) : (
          <span className="meta">{d.note}</span>
        )}
        {d.reasons.map((r) =>
          r.seq === null ? null : (
            <button key={r.text} type="button" className="retro-reason" onClick={() => onJump(r.seq!)}>
              {r.text} <Icon name="arrow" size={12} />
            </button>
          ),
        )}
        {d.outcome === 'smooth' && <span className="meta">没有说过不行，最后也没有卡住</span>}
      </div>

      {(d.handedOffFrom || d.handedOffTo) && (
        <div className="retro-links">
          {d.handedOffFrom && (
            <button type="button" className="chip" onClick={() => onOpenSession(d.handedOffFrom!.id)}>
              <Icon name="back" size={12} /> 接手自 {AGENT_LABEL[d.handedOffFrom.agent]}：{d.handedOffFrom.title ?? '（无标题）'}
            </button>
          )}
          {d.handedOffTo && (
            <button type="button" className="chip" onClick={() => onOpenSession(d.handedOffTo!.id)}>
              之后换到 {AGENT_LABEL[d.handedOffTo.agent]} 接着做：{d.handedOffTo.title ?? '（无标题）'} <Icon name="arrow" size={12} />
            </button>
          )}
        </div>
      )}

      <div className="trace" aria-hidden="true">
        {(['you', 'agent'] as const).map((lane) => (
          <div key={lane} className="trace-lane">
            <span className="trace-who">{lane === 'you' ? '你' : 'agent'}</span>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: 悬停提示只是鼠标用户的增强，键盘用下面的图例按钮逐个跳 */}
            <div className="trace-track" onMouseLeave={() => setHover(null)}>
              {stuck !== null && (
                <div className="trace-stuck" style={{ left: `${x(stuck)}%` }}>
                  {lane === 'you' && <span>卡在这里</span>}
                </div>
              )}
              {focusSeq !== null && focusSeq >= lo && focusSeq <= hi && <div className="trace-now" style={{ left: `${x(focusSeq)}%` }} />}
              {d.marks.map((m, i) =>
                KINDS.find((k) => k.kind === m.kind)?.lane === lane ? (
                  <button
                    key={m.seq}
                    type="button"
                    tabIndex={-1}
                    className={'tm tm-' + m.kind + (hover === i ? ' on' : '')}
                    style={{ left: `${x(m.seq)}%` }}
                    onMouseEnter={() => setHover(i)}
                    onClick={() => onJump(m.seq)}
                  >
                    <i />
                  </button>
                ) : null,
              )}
              {h && KINDS.find((k) => k.kind === h.kind)?.lane === lane && (
                <div className={'trace-tip' + (x(h.seq) > 60 ? ' left' : '')} style={{ left: `${x(h.seq)}%` }}>
                  <b>
                    {LABEL[h.kind]} · 第 {h.seq - lo + 1} 条
                  </b>
                  <span>{excerpt(h.seq) || '（没有文字）'}</span>
                </div>
              )}
            </div>
          </div>
        ))}
        <div className="trace-axis">
          <span>{first ? when(first) : '开始'}</span>
          <span>{last ? when(last) : '结束'}</span>
        </div>
      </div>

      <div className="trace-legend">
        {KINDS.map(({ kind, label }) => {
          const n = count(kind);
          if (!n) return null;
          return (
            <button key={kind} type="button" onClick={() => next(kind)} title={`跳到下一处「${label}」`}>
              <span className={'tm tm-' + kind}>
                <i />
              </span>
              {label} <b>{n}</b>
            </button>
          );
        })}
        {stuck !== null && (
          <button type="button" onClick={() => onJump(stuck)} title="从这条开始，之后再没好起来">
            <span className="tm-stuck-key" />
            卡住的地方
          </button>
        )}
      </div>
    </section>
  );
}
