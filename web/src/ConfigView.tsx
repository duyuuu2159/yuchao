import { useEffect, useState } from 'react';
import { configApi, type ConfigDiff, type ConfigStatus, type ConfigVersion } from './api.ts';
import { when } from './format.ts';
import { Cmd, ErrorPage, LoadingPage, PageHeader, Skeleton } from './ui.tsx';

const SOURCE_LABEL: Record<ConfigVersion['source'], string> = { snapshot: '快照', backup: '旧备份', 'before-restore': '回滚前', restore: '回滚' };

export function ConfigView() {
  const [files, setFiles] = useState<ConfigStatus[] | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    configApi.status().then((fs) => {
      setFiles(fs);
      setPath((p) => p ?? fs.find((f) => f.versions > 0)?.path ?? null);
    }, (e) => setError(e.message));
  }, []);

  if (error) return <ErrorPage title="配置管家" error={error} />;
  if (!files) return <LoadingPage title="配置管家" />;

  return (
    <div className="page configs">
      <PageHeader kicker="04 · 配置" title="配置管家" desc="记录各 agent 配置文件的每个版本，旁边散落的旧备份也整理进同一条时间线。内容里的 key、密码已打码。回滚会改写配置文件，只能在命令行里执行。" />
      <div className="config-files">
        {files.map((f) => (
          <button type="button" key={f.path} className={'config-file' + (f.path === path ? ' active' : '')} disabled={!f.versions} onClick={() => setPath(f.path)}>
            <b>{f.name}</b>
            <span className={'state ' + (!f.exists ? 'muted' : f.error ? 'bad' : f.changed ? 'warn' : 'ok')}>
              {!f.exists ? (f.versions ? '已删除' : '不存在') : f.error ? '当前文件损坏' : f.changed ? '有未记录的修改' : '正常'}
            </span>
            <span className="meta">{f.versions} 个版本</span>
          </button>
        ))}
      </div>
      {path ? <Timeline key={path} path={path} /> : <div className="empty">
          还没有记录任何版本。导入旁边散落的旧备份：<Cmd>yuchao config import</Cmd>
        </div>}
    </div>
  );
}

function Timeline({ path }: { path: string }) {
  const [versions, setVersions] = useState<ConfigVersion[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [against, setAgainst] = useState<'previous' | 'current'>('previous');
  const [diff, setDiff] = useState<ConfigDiff | null>(null);

  useEffect(() => {
    configApi.versions(path).then((vs) => {
      setVersions(vs);
      setSelected(vs[0]?.id ?? null);
    });
  }, [path]);

  useEffect(() => {
    if (!versions || selected === null) return;
    const i = versions.findIndex((v) => v.id === selected);
    // 时间线从新到旧排列，「上一个版本」是列表里的下一项
    const prev = versions[i + 1];
    setDiff(null);
    if (against === 'current') configApi.diff(path, String(selected), 'current').then(setDiff);
    else if (prev) configApi.diff(path, String(prev.id), String(selected)).then(setDiff);
  }, [path, versions, selected, against]);

  if (!versions) return <Skeleton lines={6} />;
  const isOldest = versions.at(-1)?.id === selected;

  return (
    <div className="timeline-layout">
      <ol className="timeline">
        {versions.map((v) => (
          <li key={v.id}>
            <button type="button" className={'version' + (v.id === selected ? ' active' : '') + (v.error ? ' broken' : '')} onClick={() => setSelected(v.id)}>
              <span className="vid">#{v.id}</span>
              <span className="vtime">{when(v.capturedAt)}</span>
              <span className={'state ' + (v.error ? 'bad' : 'ok')}>{v.error ? '损坏' : '正常'}</span>
              <span className="vlabel" title={v.label}>
                {SOURCE_LABEL[v.source]} · {v.label}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <section className="version-detail">
        {selected !== null && (
          <>
            <fieldset className="seg" aria-label="对比对象">
              <button type="button" className={against === 'previous' ? 'on' : ''} aria-pressed={against === 'previous'} onClick={() => setAgainst('previous')}>
                相比上一个版本
              </button>
              <button type="button" className={against === 'current' ? 'on' : ''} aria-pressed={against === 'current'} onClick={() => setAgainst('current')}>
                和当前文件对比
              </button>
            </fieldset>
            {versions.find((v) => v.id === selected)?.error && <p className="err">这个版本已损坏：{versions.find((v) => v.id === selected)!.error}</p>}
            <p className="meta">
              回滚到这个版本：<Cmd>{`yuchao config restore ${selected}`}</Cmd> 先预览改动，确认后加 --yes
            </p>
            {against === 'previous' && isOldest ? <div className="empty">这是最早的版本，没有可以对比的上一版。</div> : <DiffView diff={diff} />}
          </>
        )}
      </section>
    </div>
  );
}

function DiffView({ diff }: { diff: ConfigDiff | null }) {
  if (!diff) return <Skeleton lines={6} />;
  if (diff.broken) return <div className="empty">{diff.broken}</div>;
  const d = diff.diff!;
  return (
    <div className="diff-view">
      <div className="meta">
        {diff.from} → {diff.to} · <span className="add">+{d.added}</span> <span className="del">−{d.removed}</span>
      </div>
      {d.hunks.length === 0 && <div className="empty">内容相同。</div>}
      {d.hunks.map((h) => (
        <pre key={`${h.oldStart}:${h.newStart}`} className="hunk">
          {h.lines.map((l) => (
            // 删除行的旧行号唯一、新增行的新行号唯一、上下文行两个都有，组合起来在一段里不会重复
            <div key={`${l.kind}:${l.oldNo ?? ''}:${l.newNo ?? ''}`} className={'dl ' + l.kind}>
              <span className="ln">{l.oldNo ?? ''}</span>
              <span className="ln">{l.newNo ?? ''}</span>
              <span className="mark">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
              {l.text}
            </div>
          ))}
        </pre>
      ))}
    </div>
  );
}
