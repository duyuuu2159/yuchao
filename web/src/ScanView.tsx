import { useEffect, useState } from 'react';
import { type AuditResult, api, type Finding } from './api.ts';
import { when } from './format.ts';
import { AgentBadge, Empty, ErrorPage, LoadingPage, PageHeader } from './ui.tsx';

const RULE_ADVICE: Record<string, string> = {
  server_credential: '这是一整套能直接登录服务器的信息。建议改密码，改用 SSH 密钥登录，并关闭密码登录。',
  sshpass: '命令行里的密码会留在会话和 shell 历史里。建议改用 SSH 密钥登录。',
  private_key: '私钥一旦泄露，拿到它的人就能冒充你登录。建议重新生成密钥对，并在服务器上删除旧公钥。',
  openai_key: '到对应平台（或中转站）的后台作废这个 key，再生成新的。',
  anthropic_key: '到 Anthropic Console 作废这个 key，再生成新的。',
  github_token: '到 GitHub → Settings → Developer settings 撤销这个令牌。',
  aws_key: '到 AWS IAM 停用并删除这个 Access Key。',
  google_key: '到 Google Cloud Console 删除或限制这个 key。',
  url_credential: '修改这个服务的密码，连接信息改用环境变量。',
  password: '如果这是正在使用的密码，建议修改；如果是测试数据，可以标记为误报。',
  generic_secret: '确认它是否仍然有效，有效的话到对应服务作废并重新生成。',
};

export function ScanView({ onOpen }: { onOpen: (sessionId: string, seq: number | null) => void }) {
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload 是「标记误报后重新扫描」的触发计数器，函数体里不需要读它
  useEffect(() => {
    setResult(null);
    Promise.all([api.scan(showIgnored), showIgnored ? api.scan(false) : null]).then(
      ([all, active]) => {
        setResult(all);
        // 显示全部时，用「全部」减去「未忽略」得到已忽略的指纹
        if (active) {
          const live = new Set(active.findings.map((f) => f.fingerprint));
          setIgnored(new Set(all.findings.filter((f) => !live.has(f.fingerprint)).map((f) => f.fingerprint)));
        } else setIgnored(new Set());
      },
      (e) => setError(e.message),
    );
  }, [showIgnored, reload]);

  async function toggleIgnore(f: Finding) {
    try {
      await api.ignore(f.fingerprint, !ignored.has(f.fingerprint));
      setReload((n) => n + 1);
    } catch (e: any) {
      setError(e.message);
    }
  }

  if (error) return <ErrorPage title="安全扫描" error={error} />;
  if (!result) return <LoadingPage title="安全扫描" />;

  const high = result.findings.filter((f) => f.severity === 'high').length;
  const total = result.findings.reduce((n, f) => n + f.count, 0);

  return (
    <div className="page scan">
      <PageHeader
        kicker="02 · 安全"
        title="安全扫描"
        desc="找出会话里泄露的密码、API key 和私钥。所有内容都已打码，报告里不会出现原文；同一个秘密出现在多处时归为一条，依据是它的指纹（SHA-256 的前 16 位，无法反推出原文）。"
      />
      <section className="scan-summary">
        <div className="stat">
          <b className={high ? 'danger' : ''}>{high}</b>
          <span>高风险秘密</span>
        </div>
        <div className="stat">
          <b>{result.findings.length - high}</b>
          <span>中风险秘密</span>
        </div>
        <div className="stat">
          <b>{total}</b>
          <span>处出现</span>
        </div>
        <div className="stat muted">
          <span>
            扫描了 {result.scannedMessages.toLocaleString()} 条消息和 {result.scannedTitles} 个会话标题，用时{' '}
            {(result.ms / 1000).toFixed(1)} 秒{result.ignored > 0 && !showIgnored && `；${result.ignored} 处已标记为误报`}
          </span>
          <label className="check">
            <input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} />
            显示已标记的误报
          </label>
        </div>
      </section>

      {result.findings.length === 0 && (
        <Empty icon="shield" title="没有发现泄露">
          会话里没有找到密码、密钥或令牌。
        </Empty>
      )}

      {result.findings.map((f) => (
        <article key={f.fingerprint} className={'finding ' + f.severity + (ignored.has(f.fingerprint) ? ' ignored' : '')}>
          <header>
            <span className={'sev ' + f.severity}>{f.severity === 'high' ? '高风险' : '中风险'}</span>
            <b>{f.ruleName}</b>
            <code>{f.masked}</code>
            <span className="meta">
              出现 {f.count} 次 · {f.sessionCount} 个会话 · {when(f.firstSeen)} → {when(f.lastSeen)}
            </span>
            <button type="button" className="link" onClick={() => toggleIgnore(f)}>
              {ignored.has(f.fingerprint) ? '取消误报标记' : '标记为误报'}
            </button>
          </header>
          <p className="advice">{RULE_ADVICE[f.ruleId]}</p>
          <ul>
            {f.occurrences.slice(0, 5).map((o) => (
              <li key={`${o.sessionId}:${o.where}:${o.seq}`}>
                <button type="button" className="occ" onClick={() => onOpen(o.sessionId, o.seq)}>
                  <AgentBadge agent={o.agent} />
                  <span className="where">{o.where === 'title' ? '会话标题' : o.where}</span>
                  <span className="occ-title">{o.title ?? '（无标题）'}</span>
                  <span className="meta">{when(o.ts)}</span>
                  <span className="ctx">{o.context}</span>
                </button>
              </li>
            ))}
          </ul>
          {f.count > 5 && <div className="meta">还有 {f.count - 5} 处，这里优先展示不同会话里最近的一处</div>}
        </article>
      ))}
    </div>
  );
}
