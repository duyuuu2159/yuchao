import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { redact } from './scan.ts';
import { AGENTS, adapter } from './agents.ts';
import { discover, type SourceDirs } from './sources.ts';
import type { AgentKind, Role, Session } from './types.ts';

/** 解析器或表结构有变化时加 1，已有的索引会在下次打开时清空重建 */
export const PARSER_VERSION = 7;

export function defaultDbPath(): string {
  return process.env.YUCHAO_DB ?? join(homedir(), '.yuchao', 'index.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path       TEXT PRIMARY KEY,
  agent      TEXT NOT NULL,
  mtime_ms   REAL NOT NULL,
  size       INTEGER NOT NULL,
  session_id TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  agent       TEXT NOT NULL,
  native_id   TEXT NOT NULL,
  parent_id   TEXT,
  title       TEXT,
  cwd         TEXT,
  started_at  TEXT,
  updated_at  TEXT,
  archived    INTEGER NOT NULL DEFAULT 0,
  source_path TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  ts         TEXT,
  role       TEXT NOT NULL,
  tool_name  TEXT,
  text       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
-- trigram 分词把文本切成连续三个字的片段，不需要中文分词词典也能搜中文
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
-- 用户标记为误报的扫描结果，只存指纹，不存原文；重建索引时保留
CREATE TABLE IF NOT EXISTS scan_ignores (
  fingerprint TEXT PRIMARY KEY,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
`;

export interface IndexResult {
  scanned: number;
  indexed: number;
  skipped: number;
  removed: number;
  errors: { path: string; error: string }[];
  ms: number;
}

export interface SearchOptions {
  agent?: AgentKind;
  /** 默认只搜用户和 agent 的对话，不搜工具输出和注入的上下文 */
  roles?: Role[];
  sessionId?: string;
  limit?: number;
  /** 摘要和标题里的密码、密钥打码显示（截取摘要之前先打码，避免秘密被截成两半漏掉） */
  redact?: boolean;
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
  agent: AgentKind;
  cwd: string | null;
  /** 同一条消息还出现在几个分叉会话里 */
  alsoIn: number;
}

export interface SessionRow {
  id: string;
  agent: AgentKind;
  parentId: string | null;
  title: string | null;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  archived: boolean;
  messageCount: number;
}

export const DEFAULT_ROLES: Role[] = ['user', 'assistant'];

export class Store {
  readonly db: DatabaseSync;

  constructor(path = defaultDbPath()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    // 解析规则改变后，没改动的文件也要重新解析，否则旧结果会一直留在库里
    const { user_version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (user_version !== PARSER_VERSION) {
      this.db.exec('DELETE FROM files; DELETE FROM messages; DELETE FROM sessions;');
      this.db.exec(`PRAGMA user_version = ${PARSER_VERSION}`);
    }
  }

  close() {
    this.db.close();
  }

  /**
   * 增量索引：文件的修改时间和大小都没变就跳过，变了就整份重新解析。
   * 会话文件是追加写入的，整份重解析比按行续读简单得多，而单个文件解析只要几十毫秒。
   */
  async index(dirs: SourceDirs, onProgress?: (done: number, total: number) => void): Promise<IndexResult> {
    const t0 = performance.now();
    const files = discover(dirs);
    // 标题存在会话文件之外的 agent，先把标题表读出来
    const titles = new Map<string, Map<string, string>>();
    for (const a of AGENTS) {
      const dir = dirs[a.kind];
      if (dir && a.titles) titles.set(a.kind, await a.titles(dir));
    }
    const known = new Map<string, { mtime_ms: number; size: number }>();
    for (const r of this.db.prepare('SELECT path, mtime_ms, size FROM files').all() as any[]) known.set(r.path, r);

    const result: IndexResult = { scanned: files.length, indexed: 0, skipped: 0, removed: 0, errors: [], ms: 0 };

    // 先处理已经消失的文件（被删除，或从 sessions 移到了 archived_sessions）
    const present = new Set(files.map((f) => f.path));
    for (const path of known.keys()) {
      if (!present.has(path)) {
        this.transaction(() => this.removeFile(path));
        result.removed++;
      }
    }

    let done = 0;
    for (const f of files) {
      done++;
      let st;
      try {
        st = statSync(f.path);
      } catch {
        continue; // 扫描后被删掉了
      }
      const prev = known.get(f.path);
      if (prev && prev.mtime_ms === st.mtimeMs && prev.size === st.size) {
        result.skipped++;
      } else {
        try {
          const session = await adapter(f.agent).parse(f.path, titles.get(f.agent) ?? new Map());
          this.transaction(() => {
            this.removeFile(f.path);
            this.writeSession(session);
            this.db
              .prepare('INSERT INTO files(path, agent, mtime_ms, size, session_id) VALUES (?, ?, ?, ?, ?)')
              .run(f.path, f.agent, st.mtimeMs, st.size, session.id);
          });
          result.indexed++;
        } catch (e: any) {
          result.errors.push({ path: f.path, error: e.message ?? String(e) });
        }
      }
      onProgress?.(done, files.length);
    }

    // 例如 Codex 改名只写 session_index，不动会话文件，所以每次都同步一遍标题
    const rename = this.db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND agent = ?');
    this.transaction(() => {
      for (const [agent, map] of titles) for (const [id, title] of map) rename.run(title, `${agent}:${id}`, agent);
    });

    result.ms = Math.round(performance.now() - t0);
    return result;
  }

  private transaction(fn: () => void) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private removeFile(path: string) {
    const row = this.db.prepare('SELECT session_id FROM files WHERE path = ?').get(path) as any;
    if (row?.session_id) this.removeSession(row.session_id);
    this.db.prepare('DELETE FROM files WHERE path = ?').run(path);
  }

  private removeSession(id: string) {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  private writeSession(s: Session) {
    // 同一会话 id 可能来自另一个文件（例如归档时被复制），以最新解析的为准
    this.removeSession(s.id);
    this.db
      .prepare(
        `INSERT INTO sessions(id, agent, native_id, parent_id, title, cwd, started_at, updated_at, archived, source_path, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.agent, s.nativeId, s.parentId, s.title, s.cwd, s.startedAt, s.updatedAt, s.archived ? 1 : 0, s.sourcePath, s.messages.length);
    const ins = this.db.prepare('INSERT INTO messages(session_id, seq, ts, role, tool_name, text) VALUES (?, ?, ?, ?, ?, ?)');
    for (const m of s.messages) ins.run(s.id, m.seq, m.ts, m.role, m.toolName, m.text);
  }

  /**
   * 搜索：空格分隔的多个词需要同时出现。
   * trigram 索引只能匹配 3 个字及以上的词，「回滚」这样的两字词退回到 LIKE 逐条扫描。
   */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const terms = query.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const long = terms.filter((t) => [...t].length >= 3);
    const short = terms.filter((t) => [...t].length < 3);

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (long.length) {
      where.push('m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)');
      params.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' '));
    }
    for (const t of short) {
      where.push("m.text LIKE ? ESCAPE '\\'");
      params.push(`%${t.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    }
    const roles = opts.roles ?? DEFAULT_ROLES;
    where.push(`m.role IN (${roles.map(() => '?').join(',')})`);
    params.push(...roles);
    if (opts.agent) {
      where.push('s.agent = ?');
      params.push(opts.agent);
    }
    if (opts.sessionId) {
      where.push('m.session_id = ?');
      params.push(opts.sessionId);
    }
    const limit = opts.limit ?? 50;
    // 多取一些，给去重留余量
    params.push(limit * 4);

    const rows = this.db
      .prepare(
        `SELECT m.id, m.session_id, m.seq, m.ts, m.role, m.tool_name, m.text, s.title, s.agent, s.cwd, s.started_at
         FROM messages m JOIN sessions s ON s.id = m.session_id
         WHERE ${where.join(' AND ')}
         ORDER BY m.ts DESC, s.started_at ASC, s.id ASC LIMIT ?`,
      )
      .all(...params) as any[];

    // 分叉出来的会话会复制原会话的全部历史，同一时间、同一内容只保留最早的会话（原始会话）
    const hits = new Map<string, SearchHit & { startedAt: string | null }>();
    for (const r of rows) {
      const key = `${r.ts}\u0000${r.role}\u0000${r.text}`;
      const seen = hits.get(key);
      if (seen) {
        seen.alsoIn++;
        continue;
      }
      if (hits.size >= limit) continue;
      hits.set(key, {
        messageId: r.id,
        sessionId: r.session_id,
        seq: r.seq,
        ts: r.ts,
        role: r.role,
        toolName: r.tool_name,
        snippet: makeSnippet(opts.redact ? redact(r.text) : r.text, terms),
        title: opts.redact && r.title ? redact(r.title) : r.title,
        agent: r.agent,
        cwd: r.cwd,
        alsoIn: 0,
        startedAt: r.started_at,
      });
    }
    return [...hits.values()].map(({ startedAt: _, ...hit }) => hit);
  }

  listSessions(opts: { agent?: AgentKind; includeSubagents?: boolean; limit?: number; offset?: number } = {}): SessionRow[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.agent) {
      where.push('agent = ?');
      params.push(opts.agent);
    }
    if (!opts.includeSubagents) where.push('parent_id IS NULL');
    params.push(opts.limit ?? 100, opts.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params) as any[];
    return rows.map(toSessionRow);
  }

  getSession(id: string) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!row) return null;
    const messages = this.db
      .prepare('SELECT seq, ts, role, tool_name AS toolName, text FROM messages WHERE session_id = ? ORDER BY seq')
      .all(id);
    const children = (this.db.prepare('SELECT * FROM sessions WHERE parent_id = ? ORDER BY started_at').all(id) as any[]).map(toSessionRow);
    return { ...toSessionRow(row), sourcePath: row.source_path as string, messages, children };
  }

  stats() {
    const q = (sql: string) => this.db.prepare(sql).all() as any[];
    return {
      sessions: q('SELECT agent, COUNT(*) AS n FROM sessions GROUP BY agent'),
      messages: q('SELECT role, COUNT(*) AS n FROM messages GROUP BY role'),
      range: q('SELECT MIN(started_at) AS first, MAX(updated_at) AS last FROM sessions')[0],
    };
  }
}

function toSessionRow(r: any): SessionRow {
  return {
    id: r.id,
    agent: r.agent,
    parentId: r.parent_id,
    title: r.title,
    cwd: r.cwd,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    archived: r.archived === 1,
    messageCount: r.message_count,
  };
}

/** 截取第一个命中词前后的一段文字作为摘要 */
export function makeSnippet(text: string, terms: string[], radius = 60): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  const flat = (s: string) => s.replace(/\s+/g, ' ');
  if (at === -1) return flat(text.slice(0, radius * 2));
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  return (start > 0 ? '…' : '') + flat(text.slice(start, end)) + (end < text.length ? '…' : '');
}
