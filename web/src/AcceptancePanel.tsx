import { type Ref, useEffect, useId, useRef, useState } from 'react';
import { type AcceptanceCard, type AcceptanceRevision, type AcceptanceSource, acceptanceApi } from './api.ts';
import { AgentBadge, Icon, Status } from './ui.tsx';

export type AcceptanceDraft = {
  sessionId: string;
  seq: number;
  preview: string;
} & ({ kind: 'requirement'; expectedRevisionId: number | null } | { kind: 'evidence'; revisionId: number; covers: boolean });

export type AcceptanceOpen = (id: string, seq: number) => void;

export function useAcceptanceCard(reloadKey: number) {
  const [card, setCard] = useState<AcceptanceCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const version = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry 和 reloadKey 分别触发手动重试、索引后刷新
  useEffect(() => {
    setError(null);
    const controller = new AbortController();
    const startingVersion = version.current;
    acceptanceApi.get(controller.signal).then(
      (next) => {
        if (!controller.signal.aborted && version.current === startingVersion) setCard(next);
      },
      (e: Error) => {
        if (!controller.signal.aborted && version.current === startingVersion) setError(e.message);
      },
    );
    return () => controller.abort();
  }, [retry, reloadKey]);

  return {
    card,
    error,
    refresh: () => setRetry((value) => value + 1),
    update: (next: AcceptanceCard) => {
      version.current++;
      setError(null);
      setCard(next);
    },
  };
}

const STATUS = {
  pending: { label: '待验', level: 'warn' },
  verified: { label: '有据', level: 'ok' },
  failed: { label: '未通过', level: 'bad' },
} as const;

const RESULT = {
  pass: { label: '测试通过', level: 'ok' },
  fail: { label: '测试未通过', level: 'bad' },
  unknown: { label: '结果不明', level: 'muted' },
} as const;

function Source({ source, label, onOpen }: { source: AcceptanceSource; label: string; onOpen: AcceptanceOpen }) {
  return (
    <div className="accept-source">
      <AgentBadge agent={source.agent} />
      {source.available ? (
        <button type="button" className="text-link" onClick={() => onOpen(source.sessionId, source.seq)}>
          {label} <Icon name="arrow" size={13} />
        </button>
      ) : (
        <span className="meta">来源当前不可读</span>
      )}
    </div>
  );
}

function Revision({ revision, onOpen, current = false }: { revision: AcceptanceRevision; onOpen: AcceptanceOpen; current?: boolean }) {
  return (
    <div className="accept-revision">
      <div className="accept-source">
        <span className="accept-version">要求 #{revision.id}</span>
        <span aria-live={current ? 'polite' : undefined}>
          <Status level={STATUS[revision.status].level}>{STATUS[revision.status].label}</Status>
        </span>
      </div>
      <p className="accept-quote">{revision.source.text || '要求原文当前不可读'}</p>
      <Source source={revision.source} label="查看要求原话" onOpen={onOpen} />
      {revision.evidence.length > 0 && (
        <ul className="accept-evidence">
          {revision.evidence.map((e) => (
            <li key={`${e.sessionId}:${e.seq}`}>
              <div className="accept-source">
                <Status level={RESULT[e.result].level}>{RESULT[e.result].label}</Status>
                <span className="meta">{e.covers ? '已确认覆盖此要求' : '仅作参考'}</span>
              </div>
              {e.command && <code>{e.command}</code>}
              <Source source={e} label="查看测试输出" onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AcceptancePanel({
  state,
  onOpen,
  headingRef,
}: {
  state: ReturnType<typeof useAcceptanceCard>;
  onOpen: AcceptanceOpen;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const heading = useId();
  const [current, ...history] = state.card?.revisions ?? [];
  return (
    <section className="accept-card" aria-labelledby={heading}>
      <div className="accept-title">
        <Icon name="relay" />
        <h2 id={heading} tabIndex={-1} ref={headingRef}>
          接力验收单
        </h2>
      </div>
      {state.error && (
        <p className="err" role="alert">
          读取失败：{state.error}{' '}
          <button type="button" className="text-link" onClick={state.refresh}>
            重试
          </button>
        </p>
      )}
      {!state.card && !state.error && <p className="meta">正在读取验收单…</p>}
      {state.card && !current && <p className="meta">还没有验收要求。找到你发出的消息，点「设为验收要求」开始。</p>}
      {current && (
        <>
          <Revision revision={current} onOpen={onOpen} current />
          <p className="meta">
            {current.status === 'pending'
              ? '待验：在任意会话中显示工具调用，找到测试输出，挂为证据并确认它是否覆盖当前要求。'
              : '结果来自所挂的历史测试，不代表当前工作区已验证。'}
          </p>
        </>
      )}
      {history.length > 0 && (
        <details className="accept-history">
          <summary>历史要求（{history.length}）</summary>
          <p className="meta">这些要求已经被替换；原有证据不会影响当前状态。</p>
          {history.map((r) => (
            <Revision key={r.id} revision={r} onOpen={onOpen} />
          ))}
        </details>
      )}
    </section>
  );
}

export function AcceptanceDialog({
  draft,
  onClose,
  onSaved,
  onError,
}: {
  draft: AcceptanceDraft;
  onClose: () => void;
  onSaved: (card: AcceptanceCard) => void;
  onError: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [covers, setCovers] = useState(draft.kind === 'evidence' && draft.covers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replacing = draft.kind === 'requirement' && draft.expectedRevisionId !== null;
  const action = draft.kind === 'evidence' ? '保存证据' : replacing ? '替换要求' : '保存要求';

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function save() {
    const { sessionId, seq } = draft;
    setBusy(true);
    setError(null);
    try {
      const card =
        draft.kind === 'requirement'
          ? await acceptanceApi.requirement({ sessionId, seq, expectedRevisionId: draft.expectedRevisionId })
          : await acceptanceApi.evidence({ sessionId, seq, revisionId: draft.revisionId, covers });
      onSaved(card);
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
      onError();
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      className="handoff accept-dialog"
      onClose={onClose}
      onCancel={(e) => busy && e.preventDefault()}
      aria-labelledby={titleId}
    >
      <header className="handoff-head">
        <div>
          <h2 id={titleId}>{draft.kind === 'requirement' ? '设为验收要求' : '挂为验收证据'}</h2>
          {draft.kind === 'requirement' && !replacing && <p>所选消息将作为要求原话，保存后可回到这条消息。</p>}
          {replacing && <p>新要求会从「待验」开始；旧要求和证据留在历史里，不会继承。</p>}
          {draft.kind === 'evidence' && <p>这条输出将挂到要求 #{draft.revisionId}。不勾选时仅作参考，不计入验收状态。</p>}
        </div>
      </header>
      <p className="accept-quote">{draft.preview}</p>
      {draft.kind === 'evidence' && (
        <label className="check">
          <input type="checkbox" checked={covers} onChange={(e) => setCovers(e.target.checked)} disabled={busy} />
          我确认这次测试覆盖当前要求
        </label>
      )}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <footer className="handoff-foot">
        <button type="button" className="btn ghost" onClick={() => ref.current?.close()} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn cta" onClick={save} disabled={busy}>
          {busy ? '保存中…' : action}
        </button>
      </footer>
    </dialog>
  );
}
