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

async function get<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

const qs = (o: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(o).filter((e): e is [string, string] => !!e[1])).toString();

export const api = {
  sessions: (agent?: Agent) => get<SessionRow[]>(`/api/sessions?${qs({ agent, limit: '1000' })}`),
  session: (id: string) => get<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
  search: (q: string, agent?: Agent, tools?: boolean) => get<SearchHit[]>(`/api/search?${qs({ q, agent, tools: tools ? '1' : undefined })}`),
  index: () => get<IndexResult>('/api/index', { method: 'POST' }),
};
