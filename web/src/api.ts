// 与 src/core/store.ts 中返回给前端的数据结构保持一致

export type Agent = 'claude' | 'codex';
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
  ignore: (fingerprint: string, ignored: boolean) => get<{ ok: true }>(`/api/scan/ignore/${fingerprint}`, { method: ignored ? 'PUT' : 'DELETE' }),
};
