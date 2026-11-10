import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AGENT_LABEL, type Agent } from './api.ts';

// 公共组件和小工具：图标、agent 标签、页头、命令、骨架占位、地址路由、明暗模式。

const ICONS = {
  home: 'M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1z',
  chat: 'M4 4h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H9l-4 3v-3H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
  shield: 'M10 3l6 2v4.5c0 3.6-2.5 6.3-6 7.5-3.5-1.2-6-3.9-6-7.5V5zM7.5 10l2 2 3.5-4',
  user: 'M10 10a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5zM3.5 17c.6-3 3.2-4.5 6.5-4.5s5.900 1.5 6.5 4.5',
  sliders: 'M4 6h7M15 6h1M4 14h1M9 14h7M13 4v4M7 12v4',
  server: 'M4 4h12a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 11h12a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1zM6 6.5h.01M6 13.500h.01',
  refresh: 'M16 10a6 6 0 0 1-10.600 3.800M4 10a6 6 0 0 1 10.600-3.800M14.500 3v3.500H11M5.500 17v-3.500H9',
  sun: 'M10 13.500a3.500 3.500 0 1 0 0-7 3.500 3.500 0 0 0 0 7zM10 2v1.500M10 16.500V18M2 10h1.500M16.500 10H18M4.300 4.300l1.100 1.100M14.600 14.600l1.100 1.100M4.300 15.700l1.100-1.100M14.600 5.400l1.100-1.100',
  moon: 'M16.500 11.500A6.500 6.500 0 0 1 8.500 3.500a6.500 6.500 0 1 0 8 8z',
  monitor: 'M3.500 4h13a.500.500 0 0 1 .500.500v8a.500.500 0 0 1-.500.500h-13a.500.500 0 0 1-.500-.500v-8a.500.500 0 0 1 .500-.500zM7 16.500h6M10 13v3.500',
  search: 'M9 15A6 6 0 1 0 9 3a6 6 0 0 0 0 12zM13.500 13.500 17 17',
  copy: 'M7 7V4.500a.500.500 0 0 1 .500-.500h8a.500.500 0 0 1 .500.500v8a.500.500 0 0 1-.500.500H13M4.500 7h8a.500.500 0 0 1 .500.500v8a.500.500 0 0 1-.500.500h-8a.500.500 0 0 1-.500-.500v-8a.500.500 0 0 1 .500-.500z',
  check: 'M4.500 10.500l3.500 3.500 7.500-8',
  eye: 'M2.500 10s2.700-5 7.500-5 7.500 5 7.500 5-2.700 5-7.500 5-7.500-5-7.500-5zM10 12.250a2.250 2.250 0 1 0 0-4.500 2.250 2.250 0 0 0 0 4.500z',
  alert: 'M10 3.500 17.500 16h-15zM10 8.500v3.500M10 14h.01',
  x: 'M5 5l10 10M15 5L5 15',
  back: 'M11.500 5 6.500 10l5 5',
  arrow: 'M4 10h12M11.500 5.500 16 10l-4.500 4.500',
  relay: 'M3 7h9.500M9.500 4l3 3-3 3M17 13H7.500M10.500 10l-3 3 3 3',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.600" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

/** 小圆点 + 名字：颜色只是辅助，名字始终写出来 */
export function AgentBadge({ agent }: { agent: Agent }) {
  return (
    <span className={'agent ' + agent}>
      <i />
      {AGENT_LABEL[agent]}
    </span>
  );
}

/** 页头：杂志式的小标签（编号 · 栏目），大标题以一个粉色句号收尾，和个人网站的标题风格一致 */
export function PageHeader({ kicker, title, desc, children }: { kicker?: string; title: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        {kicker && <span className="kicker">{kicker}</span>}
        <h1>
          {title}
          <span className="dot">。</span>
        </h1>
        {desc && <p>{desc}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

/** 状态：图标 + 文字，颜色只做辅助 */
export function Status({ level, children }: { level: 'ok' | 'warn' | 'bad' | 'muted'; children: ReactNode }) {
  return (
    <span className={'state ' + level}>
      {level !== 'muted' && <Icon name={level === 'ok' ? 'check' : 'alert'} size={13} />}
      {children}
    </span>
  );
}

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <button className="copy" title={label} aria-label={label} onClick={() => navigator.clipboard.writeText(text).then(() => setDone(true), () => {})}>
      <Icon name={done ? 'check' : 'copy'} size={14} />
      {done ? '已复制' : ''}
    </button>
  );
}

/** 需要在命令行里执行的命令，带复制按钮 */
export function Cmd({ children }: { children: string }) {
  return (
    <span className="cmd">
      <code>{children}</code>
      <CopyButton text={children} label="复制命令" />
    </span>
  );
}

export function Skeleton({ lines = 3, height }: { lines?: number; height?: number }) {
  if (height) return <div className="skeleton block" style={{ height }} aria-hidden="true" />;
  return (
    <div className="skeleton-lines" aria-busy="true" aria-label="加载中">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${[92, 78, 60, 85, 70][i % 5]}%` }} />
      ))}
    </div>
  );
}

export function Empty({ icon = 'search', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={28} />
      <b>{title}</b>
      {children && <div>{children}</div>}
    </div>
  );
}

// ───────── 地址路由：#/页面/会话id?seq=消息序号 ─────────

export const VIEWS = ['overview', 'sessions', 'scan', 'profile', 'config', 'server'] as const;
export type View = (typeof VIEWS)[number];

export interface Route {
  view: View;
  id: string | null;
  seq: number | null;
}

export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [view, ...rest] = path.split('/');
  const seq = new URLSearchParams(query).get('seq');
  let id: string | null = null;
  try {
    id = rest.length ? decodeURIComponent(rest.join('/')) : null;
  } catch {
    // 地址被改坏了，当作没有打开会话
  }
  return { view: (VIEWS as readonly string[]).includes(view) ? (view as View) : 'overview', id: id || null, seq: seq !== null && /^\d+$/.test(seq) ? Number(seq) : null };
}

export function routeHash(view: View, id: string | null = null, seq: number | null = null): string {
  return `#/${view}${id ? '/' + encodeURIComponent(id) : ''}${id && seq !== null ? '?seq=' + seq : ''}`;
}

const subscribeHash = (fn: () => void) => {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
};

export function useRoute(): [Route, (view: View, id?: string | null, seq?: number | null) => void] {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const go = (view: View, id: string | null = null, seq: number | null = null) => {
    window.location.hash = routeHash(view, id, seq);
  };
  return [parseRoute(hash), go];
}

// ───────── 明暗模式 ─────────

export type ThemeChoice = 'auto' | 'light' | 'dark';
const THEME_KEY = 'yuchao-theme';
const dark = () => window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme(choice: ThemeChoice) {
  document.documentElement.dataset.theme = choice === 'auto' ? (dark().matches ? 'dark' : 'light') : choice;
}

export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === 'light' || saved === 'dark' ? saved : 'auto';
  });
  useEffect(() => {
    applyTheme(choice);
    if (choice === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
    if (choice !== 'auto') return;
    const mq = dark();
    const onChange = () => applyTheme('auto');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [choice]);
  return [choice, setChoice];
}

/** 页面数据还没回来时：先把页头画出来，正文用骨架占位，避免页面跳动 */
export function LoadingPage({ title }: { title: string }) {
  return (
    <div className="page">
      <PageHeader title={title} />
      <Skeleton height={76} />
      <Skeleton lines={6} />
    </div>
  );
}

export function ErrorPage({ title, error }: { title: string; error: string }) {
  return (
    <div className="page">
      <PageHeader title={title} />
      <Empty icon="alert" title="加载失败">
        {error}
      </Empty>
    </div>
  );
}
