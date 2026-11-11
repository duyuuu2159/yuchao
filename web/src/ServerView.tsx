import { useCallback, useEffect, useState } from 'react';
import { type ServerConfig, type ServerReport, serverApi } from './api.ts';
import { when } from './format.ts';
import { Cmd, Empty, ErrorPage, LoadingPage, PageHeader, Skeleton } from './ui.tsx';

const gb = (n: number) => (n / 1024 ** 3).toFixed(1) + ' GB';
const uptime = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)} 天` : `${Math.floor(s / 3600)} 小时`);
const httpOk = (status: number | null) => status !== null && status < 400;

export function ServerView({ raw }: { raw: boolean }) {
  const [servers, setServers] = useState<ServerConfig[] | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    serverApi.list().then(
      (list) => {
        setServers(list);
        setName(list[0]?.name ?? null);
      },
      (e) => setError(e.message),
    );
  }, []);

  if (error) return <ErrorPage title="服务器" error={error} />;
  if (!servers) return <LoadingPage title="服务器" />;

  return (
    <div className="page configs server-page">
      <PageHeader
        kicker="05 · 服务器"
        title="服务器"
        desc="鱼巢用一把专用密钥登录服务器，这把密钥在服务器上被锁定为只能运行一个只读的状态脚本：不能执行其他命令，也不能转发端口。所以这里只能看，不能改。日志里的密码和访客 IP 默认打码。"
      />
      {servers.length === 0 ? (
        <div className="empty">
          还没有添加服务器。在命令行里运行：
          <Cmd>yuchao server add 名字 root@服务器IP --url https://你的域名</Cmd>
          <Cmd>yuchao server setup</Cmd>
          然后按提示在服务器上安装状态脚本和密钥。
        </div>
      ) : (
        <>
          {servers.length > 1 && (
            <fieldset className="seg" aria-label="选择服务器">
              {servers.map((s) => (
                <button
                  type="button"
                  key={s.name}
                  className={s.name === name ? 'on' : ''}
                  aria-pressed={s.name === name}
                  onClick={() => setName(s.name)}
                >
                  {s.name}
                </button>
              ))}
            </fieldset>
          )}
          {name && <Report key={name + raw} name={name} raw={raw} />}
        </>
      )}
    </div>
  );
}

function Report({ name, raw }: { name: string; raw: boolean }) {
  const [report, setReport] = useState<ServerReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    (fresh: boolean) => {
      setLoading(true);
      setError(null);
      serverApi
        .status(name, raw, fresh)
        .then(setReport, (e) => setError(e.message))
        .finally(() => setLoading(false));
    },
    [name, raw],
  );
  useEffect(() => load(false), [load]);

  if (!report)
    return error ? (
      <Empty icon="alert" title="连接失败">
        {error}
      </Empty>
    ) : (
      <Skeleton lines={8} />
    );
  const s = report.status;
  const diskPct = Math.round((s.disk.used / s.disk.total) * 100);
  const memPct = s.memory.total && s.memory.available !== null ? Math.round((1 - s.memory.available / s.memory.total) * 100) : null;
  const failures = s.serviceLog.filter((l) => /Failed with result/.test(l));

  return (
    <div className="server">
      <div className="server-head">
        <b>{report.server.name}</b>
        <span className="meta">
          {report.server.user}@{report.server.host} · {s.host} · 已运行 {uptime(s.uptime)} · 负载{' '}
          {s.load.map((x) => x.toFixed(2)).join(' ')}
        </span>
        <span className="meta">检查于 {when(report.checkedAt)}</span>
        <button type="button" onClick={() => load(true)} disabled={loading}>
          {loading ? '检查中…' : '重新检查'}
        </button>
      </div>
      {error && <p className="err">{error}（下面是上一次的结果）</p>}

      <ul className="server-warnings">
        {report.warnings.length === 0 ? (
          <li className="state ok">✓ 一切正常</li>
        ) : (
          report.warnings.map((w) => (
            <li key={w.text} className={'state ' + w.level}>
              {w.level === 'bad' ? '✗' : '!'} {w.text}
            </li>
          ))
        )}
      </ul>

      <div className="scan-summary">
        {s.services.map((svc) => (
          <div key={svc.name} className="stat">
            <b className={svc.active === 'active' ? '' : 'danger'}>{svc.active === 'active' ? '运行中' : svc.active}</b>
            <span>
              服务 {svc.name}
              {svc.since ? ` · 启动于 ${when(svc.since)}` : ''}
            </span>
          </div>
        ))}
        <div className="stat">
          <b className={httpOk(s.app.status) ? '' : 'danger'}>{s.app.status ?? s.app.error}</b>
          <span>本机访问应用{s.app.ms !== null ? ` · ${s.app.ms} ms` : ''}</span>
        </div>
        {report.publicSite && (
          <div className="stat">
            <b className={httpOk(report.publicSite.status) ? '' : 'danger'}>{report.publicSite.status ?? report.publicSite.error}</b>
            <span>
              公网 {report.server.url}
              {report.publicSite.ms !== null ? ` · ${report.publicSite.ms} ms` : ''}
            </span>
          </div>
        )}
      </div>

      <div className="meters">
        <Meter label="磁盘" pct={diskPct} detail={`${gb(s.disk.used)} / ${gb(s.disk.total)}，剩 ${gb(s.disk.free)}`} />
        {memPct !== null && <Meter label="内存" pct={memPct} detail={`可用 ${gb(s.memory.available!)} / ${gb(s.memory.total!)}`} />}
      </div>

      <div className="timeline-layout">
        <section>
          <h3>
            发布记录{' '}
            <span className="meta">
              共 {s.releases.total} 个 release，显示最近 {s.releases.items.length} 个
            </span>
          </h3>
          <ol className="timeline">
            {s.releases.items.map((r) => (
              <li key={r.name}>
                <div className={'version' + (r.current ? ' active' : '')}>
                  <span className="vtime">{when(new Date(r.mtime * 1000).toISOString())}</span>
                  {r.current && <span className="state ok">线上</span>}
                  <span className="vlabel">{r.name}</span>
                </div>
              </li>
            ))}
          </ol>
          {report.history.length > 0 && (
            <p className="meta">
              鱼巢观察到的上线记录：
              {report.history
                .slice(0, 6)
                .map((h) => `${when(h.seenAt)} ${h.release}`)
                .join('；')}
            </p>
          )}
        </section>
        <section>
          <h3>
            最近 7 天的服务告警 <span className="meta">{failures.length ? `异常退出 ${failures.length} 次` : ''}</span>
          </h3>
          <Log lines={s.serviceLog} empty="没有告警。" />
          <h3>nginx 错误日志（最后 {s.nginxErrors.length} 行）</h3>
          <Log lines={s.nginxErrors} empty="没有错误。" />
        </section>
      </div>
    </div>
  );
}

/** 用量条：数字和文字说明始终显示，颜色只是辅助 */
function Meter({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  const level = pct >= 90 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
  return (
    <div className="meter">
      <div className="meter-label">
        <b>{label}</b> {pct}% <span className="meta">{detail}</span>
        {level !== 'ok' && <span className={'state ' + level}>{level === 'bad' ? '快满了' : '偏高'}</span>}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: 原生 <meter> 在各浏览器里外观不一致且难以定制，这里用 role="meter" 加完整的 aria-value 属性 */}
      <div className="meter-track" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className={'meter-fill ' + level} style={{ width: pct + '%' }} />
      </div>
    </div>
  );
}

function Log({ lines, empty }: { lines: string[]; empty: string }) {
  if (!lines.length) return <div className="empty">{empty}</div>;
  return <pre className="server-log">{lines.join('\n')}</pre>;
}
