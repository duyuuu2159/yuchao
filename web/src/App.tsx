import { useState } from 'react';
import { api, type IndexResult } from './api.ts';
import { ConfigView } from './ConfigView.tsx';
import { OverviewView } from './OverviewView.tsx';
import { ProfileView } from './ProfileView.tsx';
import { ScanView } from './ScanView.tsx';
import { ScoreView } from './ScoreView.tsx';
import { ServerView } from './ServerView.tsx';
import { SessionsView } from './SessionsView.tsx';
import { Icon, type IconName, type ThemeChoice, useRoute, useTheme, type View } from './ui.tsx';

const NAV: { view: View; label: string; icon: IconName }[] = [
  { view: 'overview', label: '概览', icon: 'home' },
  { view: 'sessions', label: '会话', icon: 'chat' },
  { view: 'score', label: '成绩单', icon: 'chart' },
  { view: 'scan', label: '安全扫描', icon: 'shield' },
  { view: 'profile', label: '画像', icon: 'user' },
  { view: 'config', label: '配置', icon: 'sliders' },
  { view: 'server', label: '服务器', icon: 'server' },
];

const THEMES: { value: ThemeChoice; label: string; icon: IconName }[] = [
  { value: 'auto', label: '跟随系统', icon: 'monitor' },
  { value: 'light', label: '浅色', icon: 'sun' },
  { value: 'dark', label: '深色', icon: 'moon' },
];

export function App() {
  const [route, go] = useRoute();
  const [theme, setTheme] = useTheme();
  // 默认打码显示，截图和演示时不会把密码露出去
  const [raw, setRaw] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  async function reindex() {
    setIndexing(true);
    setNotice(null);
    try {
      const r: IndexResult = await api.index();
      setNotice({
        text:
          `已更新 ${r.indexed} 个会话，${r.skipped} 个没有变化，用时 ${(r.ms / 1000).toFixed(1)} 秒` +
          (r.errors.length ? `，${r.errors.length} 个文件解析失败` : ''),
      });
      setReloadKey((k) => k + 1);
    } catch (e: any) {
      setNotice({ text: e.message, error: true });
    } finally {
      setIndexing(false);
    }
  }

  const open = (id: string | null, seq: number | null = null) => go('sessions', id, seq);
  const nextTheme = THEMES[(THEMES.findIndex((t) => t.value === theme) + 1) % THEMES.length];
  const currentTheme = THEMES.find((t) => t.value === theme)!;

  return (
    <div className="app">
      <a className="skip" href="#main">
        跳到正文
      </a>
      <aside className="side">
        <a className="brand" href="#/overview" aria-label="鱼巢 AgentNest · 概览">
          <span className="logo nest-mark" aria-hidden="true">
            <svg
              width="28"
              height="28"
              viewBox="0 0 28 28"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.65"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3.5 14c3.2-5.1 7-6.8 11-5.6 2 .6 3.8 1.8 5.3 3.3l4.7-2.6v9.8l-4.7-2.6c-1.5 1.5-3.3 2.7-5.3 3.3-4 1.2-7.8-.5-11-5.6Z" />
              <path d="M7 23h14" opacity=".55" />
              <circle cx="10" cy="13.4" r=".84" fill="currentColor" stroke="none" />
            </svg>
          </span>
          <span className="brand-text">
            <b>鱼巢</b>
            <small>AgentNest</small>
          </span>
        </a>

        <nav aria-label="页面">
          {NAV.map((n) => (
            <a
              key={n.view}
              href={`#/${n.view}`}
              className={route.view === n.view ? 'on' : ''}
              aria-current={route.view === n.view ? 'page' : undefined}
              title={n.label}
            >
              <Icon name={n.icon} size={18} />
              <span className="nav-label">{n.label}</span>
            </a>
          ))}
        </nav>

        <div className="side-foot">
          <button
            type="button"
            className="side-btn primary"
            onClick={reindex}
            disabled={indexing}
            title="重新读取各个 agent 的会话文件，只处理有变化的"
          >
            <Icon name="refresh" size={18} />
            <span>{indexing ? '索引中…' : '更新索引'}</span>
          </button>
          <label className="side-btn toggle" title="默认把密码、密钥打码显示，方便截图和演示">
            <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} />
            <Icon name="eye" size={18} />
            <span>显示原文</span>
          </label>
          <button
            type="button"
            className="side-btn"
            onClick={() => setTheme(nextTheme.value)}
            title={`外观：${currentTheme.label}（点击切换到${nextTheme.label}）`}
          >
            <Icon name={currentTheme.icon} size={18} />
            <span>{currentTheme.label}</span>
          </button>
        </div>
      </aside>

      <div className="main" id="main">
        {raw && (
          <div className="banner warn" role="status">
            <Icon name="eye" /> 正在显示原文：密码和密钥没有打码，截图或共享屏幕前请关掉。
            <button type="button" className="link" onClick={() => setRaw(false)}>
              恢复打码
            </button>
          </div>
        )}
        {notice && (
          <div className={'banner' + (notice.error ? ' err' : '')} role="status">
            {notice.text}
            <button type="button" className="link" onClick={() => setNotice(null)} aria-label="关闭提示">
              <Icon name="x" size={14} />
            </button>
          </div>
        )}

        {route.view === 'sessions' ? (
          <SessionsView raw={raw} reloadKey={reloadKey} openId={route.id} focusSeq={route.seq} onOpen={open} />
        ) : (
          <main className="scroll">
            {route.view === 'overview' && <OverviewView reloadKey={reloadKey} go={go} />}
            {route.view === 'score' && <ScoreView key={reloadKey} onOpen={open} />}
            {route.view === 'scan' && <ScanView key={reloadKey} onOpen={open} />}
            {route.view === 'profile' && <ProfileView key={reloadKey} onOpen={open} />}
            {route.view === 'config' && <ConfigView key={reloadKey} />}
            {route.view === 'server' && <ServerView raw={raw} />}
          </main>
        )}
      </div>
    </div>
  );
}
