// 与 src/core/store.ts 中返回给前端的数据结构保持一致

export type Agent = 'claude' | 'codex' | 'workbuddy' | 'dsh';
export const AGENTS: Agent[] = ['claude', 'codex', 'workbuddy', 'dsh'];
export const AGENT_LABEL: Record<Agent, string> = { claude: 'Claude', codex: 'Codex', workbuddy: 'WorkBuddy', dsh: 'DeepSeek' };
export type Role = 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'context';

export interface SessionRow {
  id: string;
  agent: Agent;
  parentId: string | null;
  title: string | null;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  messageCount: number;
}

export interface Message {
  seq: number;
  ts: string | null;
  role: Role;
  toolName: string | null;
  text: string;
}

export interface SessionDetail extends SessionRow {
  sourcePath: string;
  messages: Message[];
  children: SessionRow[];
}

export interface SearchHit {
  messageId: number;
  sessionId: string;
  seq: number;
  ts: string | null;
  role: Role;
  toolName: string | null;
  snippet: string;
  title: string | null;
  agent: Agent;
  cwd: string | null;
  alsoIn: number;
}

export interface IndexResult {
  scanned: number;
  indexed: number;
  skipped: number;
  removed: number;
  errors: { path: string; error: string }[];
  ms: number;
}

export interface Occurrence {
  sessionId: string;
  title: string | null;
  agent: Agent;
  seq: number | null;
  ts: string | null;
  where: string;
  context: string;
}

export interface Finding {
  fingerprint: string;
  ruleId: string;
  ruleName: string;
  severity: 'high' | 'medium';
  masked: string;
  count: number;
  sessionCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  occurrences: Occurrence[];
}

export interface AuditResult {
  scannedMessages: number;
  scannedTitles: number;
  ignored: number;
  ms: number;
  findings: Finding[];
}

async function get<T>(url: string, init?: RequestInit): Promise<T> {
  // 本地服务要求写操作带上这个请求头，用来挡住其他网站发来的跨站请求
  const res = await fetch(url, { ...init, headers: { 'x-yuchao': '1', ...init?.headers } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

const qs = (o: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => !!e[1])).toString();

const flag = (b?: boolean) => (b ? '1' : undefined);

/** raw 为 true 时返回原文；默认服务端会把密码、密钥打码 */
export const api = {
  sessions: (agent?: Agent, raw?: boolean) => get<SessionRow[]>(`/api/sessions?${qs({ agent, limit: '1000', raw: flag(raw) })}`),
  session: (id: string, raw?: boolean) => get<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}?${qs({ raw: flag(raw) })}`),
  search: (q: string, agent?: Agent, tools?: boolean, raw?: boolean) =>
    get<SearchHit[]>(`/api/search?${qs({ q, agent, tools: flag(tools), raw: flag(raw) })}`),
  index: () => get<IndexResult>('/api/index', { method: 'POST' }),
  scan: (all?: boolean) => get<AuditResult>(`/api/scan?${qs({ all: flag(all) })}`),
  ignore: (fingerprint: string, ignored: boolean) =>
    get<{ ok: true }>(`/api/scan/ignore/${fingerprint}`, { method: ignored ? 'PUT' : 'DELETE' }),
};

export interface ActivityStats {
  sessions: Record<Agent, number>;
  userMessages: number;
  activeDays: number;
  firstDay: string | null;
  lastDay: string | null;
  byHour: number[];
  byWeekday: number[];
  topProjects: { name: string; sessions: number }[];
  topTools: { name: string; calls: number }[];
  topPhrases: { text: string; count: number }[];
  medianLength: number;
}

export interface AgentMemory {
  agent: Agent;
  project: string;
  name: string;
  description: string;
  type: 'user' | 'feedback' | 'project' | 'reference' | 'other';
  body: string;
  originSessionId: string | null;
  modified: string | null;
}

export type Scope = 'all' | Agent;

export interface ProfileVersion {
  id: number;
  scope: Scope;
  createdAt: string;
  profile: {
    headline: string;
    sections: { title: string; claims: { text: string; evidence: { sessionId: string; title: string; agent: Agent }[] }[] }[];
  };
  meta: { model: string; sessions: number; droppedCitations: number; droppedClaims: number; notesFailed: unknown[] };
}

export interface ProfileOverview {
  stats: ActivityStats;
  memories: AgentMemory[];
  latest: Record<Scope, ProfileVersion | null>;
  versions: Record<Scope, number>;
}

export interface ProfileDiff {
  from: string;
  to: string;
  added: string[];
  removed: string[];
}

export const profileApi = {
  overview: () => get<ProfileOverview>('/api/profile'),
  diff: (scope: Scope) => get<ProfileDiff | null>(`/api/profile/diff?scope=${scope}`),
};

export interface ConfigVersion {
  id: number;
  path: string;
  hash: string;
  size: number;
  capturedAt: string;
  source: 'snapshot' | 'backup' | 'before-restore' | 'restore';
  label: string;
  error: string | null;
}

export interface ConfigStatus {
  path: string;
  name: string;
  format: 'json' | 'toml' | 'text';
  exists: boolean;
  versions: number;
  latest: ConfigVersion | null;
  changed: boolean;
  error: string | null;
}

export interface ConfigDiff {
  from: string;
  to: string;
  broken: string | null;
  diff: {
    added: number;
    removed: number;
    hunks: {
      oldStart: number;
      newStart: number;
      lines: { kind: 'same' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null }[];
    }[];
  } | null;
}

export const configApi = {
  status: () => get<ConfigStatus[]>('/api/configs'),
  versions: (path: string) => get<ConfigVersion[]>(`/api/configs/versions?${qs({ path })}`),
  diff: (path: string, from: string, to: string) => get<ConfigDiff>(`/api/configs/diff?${qs({ path, from, to })}`),
};

export interface ServerConfig {
  name: string;
  host: string;
  user: string;
  port: number;
  url?: string;
}

export interface ServerService {
  name: string;
  active: string;
  sub: string;
  since: string | null;
  restarts: number;
}

export interface ServerReport {
  server: ServerConfig;
  checkedAt: string;
  status: {
    host: string;
    uptime: number;
    load: number[];
    cpus: number | null;
    memory: { total: number | null; available: number | null };
    disk: { total: number; used: number; free: number };
    services: ServerService[];
    app: { url: string; status: number | null; ms: number | null; error?: string };
    releases: { current: string | null; total: number; items: { name: string; mtime: number; current: boolean }[] };
    serviceLog: string[];
    nginxErrors: string[];
  };
  publicSite: { status: number | null; ms: number | null; error?: string } | null;
  warnings: { level: 'bad' | 'warn'; text: string }[];
  history: { release: string; seenAt: string }[];
}

export const serverApi = {
  list: () => get<ServerConfig[]>('/api/servers'),
  status: (name: string, raw?: boolean, fresh?: boolean) =>
    get<ServerReport>(`/api/server?${qs({ name, raw: flag(raw), fresh: flag(fresh) })}`),
};

export interface Stats {
  sessions: { agent: Agent; n: number }[];
  messages: { role: Role; n: number }[];
  range: { first: string | null; last: string | null };
  usage: {
    total: { requests: number; input: number; output: number; cacheRead: number };
    byAgent: { agent: Agent; input: number; output: number }[];
    since: string | null;
  };
}

export const statsApi = {
  get: () => get<Stats>('/api/stats'),
};

export interface Handoff {
  facts: {
    sessionId: string;
    agent: Agent;
    title: string;
    cwd: string | null;
    userMessages: number;
    toolCalls: number;
    files: { path: string; edits: number }[];
    commands: string[];
    errors: string[];
  };
  markdown: string;
  chars: number;
  tokens: number;
}

export const handoffApi = {
  get: (id: string, to?: Agent, raw?: boolean) => get<Handoff>(`/api/handoff/${encodeURIComponent(id)}?${qs({ to, raw: flag(raw) })}`),
};

// ---------------- 成绩单 ----------------

export type Outcome = 'smooth' | 'rework' | 'unresolved';

export interface SessionScore {
  id: string;
  agent: Agent;
  title: string | null;
  startedAt: string | null;
  model: string | null;
  outcome: Outcome;
  reasons: string[];
  handedOffTo: string | null;
  signals: { turns: number; toolCalls: number; errors: number; retries: number; reAsks: number; negatives: number };
  input: number;
  output: number;
  cacheRead: number;
}

export interface ScoreRow {
  key: string;
  label: string;
  agents: Agent[];
  sessions: number;
  smooth: number;
  rework: number;
  unresolved: number;
  avgTurns: number;
  retries: number;
  failures: number;
  input: number;
  output: number;
  cacheRead: number;
  outputPerSmooth: number | null;
}

export interface Scorecard {
  since: string | null;
  sessions: SessionScore[];
  byAgent: ScoreRow[];
  byModel: ScoreRow[];
  handoffs: number;
}

export const scoreApi = {
  get: (days?: number, raw?: boolean) => get<Scorecard>(`/api/scorecard?${qs({ days: days ? String(days) : undefined, raw: flag(raw) })}`),
};
