import { mkdirSync, type Stats, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AGENTS, adapter } from './agents.ts';
import { redact } from './scan.ts';
import { discover, type SourceDirs, type SourceFile } from './sources.ts';
import type { AgentKind, Role, Session } from './types.ts';

/** 解析器或表结构有变化时加 1，已有的索引会在下次打开时清空重建 */
export const PARSER_VERSION = 7;

export function defaultDbPath(): string {
  return process.env.YUCHAO_DB ?? join(homedir(), '.yuchao', 'index.db');
}

/** 让全文索引跟着 messages 表自动更新。首次建索引时会暂时去掉它们，见 Store.index */
const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;`;

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
-- 搜索默认只看用户和 agent 的话，而工具调用和工具输出占了消息的八成以上。
-- 有了这个索引，两字词的 LIKE 扫描只需要扫对话，真实数据上从 79 毫秒降到 16 毫秒（见 docs/perf.md）
CREATE INDEX IF NOT EXISTS messages_role_ts ON messages(role, ts);
-- trigram 分词把文本切成连续三个字的片段，不需要中文分词词典也能搜中文
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  text, content='messages', content_rowid='id', tokenize='trigram'
);
${FTS_TRIGGERS}
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
    // 页缓存上限从默认的 2 MB 调到 64 MB（按需占用）。搜索要按命中的 id 逐条回表，
    // 缓存太小时几乎每次都要重新读页：10 万条消息的基准里，常见词的搜索因此慢了 4 倍（见 docs/perf.md）
    this.db.exec('PRAGMA cache_size = -65536;');
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

    // 首次建索引（包括解析规则升级后清空重建）走批量模式：先只写 messages 表，最后一次性重建全文索引。
    // trigram 全文索引逐行更新时，写库时间有九成花在它身上；10 万条消息一次性重建要 1.5 秒，逐行要 9 秒（见 docs/perf.md）。
    // 日常增量只改几个文件，继续用触发器逐行更新——一次性重建要把全表重算一遍，对增量反而更慢。
    const bulk = known.size === 0 && files.length > 0;
    if (bulk) {
      // 整个批量过程在一个事务里：中途出错或进程被杀，数据库回到开始前的样子，不会留下「触发器没了、索引建了一半」的状态
      this.db.exec('BEGIN');
      // 删除触发器也去掉：最后的 rebuild 会丢掉索引里的全部旧数据重新计算，批量过程中逐条写删除记录纯属白做
      this.db.exec('DROP TRIGGER messages_ai; DROP TRIGGER messages_ad;');
    }
    try {
      await this.indexFiles(files, known, titles, bulk, result, onProgress);
      if (bulk) {
        this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`);
        // rebuild 留下的段结构会让之后每次增量写入都触发昂贵的自动合并（实测增量更新从 0.2 秒变成 1.2 秒），
        // 整理成一个段之后增量写入反而比逐行建出来的索引更快
        this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES ('optimize')`);
        this.db.exec(FTS_TRIGGERS);
        this.db.exec('COMMIT');
        // 一个大事务会让 WAL 文件涨到和数据库差不多大；不在这里收尾，下一次写入就要替它把几十 MB 搬回主库
        this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      }
    } catch (e) {
      if (bulk) this.db.exec('ROLLBACK');
      throw e;
    }

    // 例如 Codex 改名只写 session_index，不动会话文件，所以每次都同步一遍标题
    const rename = this.db.prepare('UPDATE sessions SET title = ? WHERE id = ? AND agent = ?');
    this.transaction(() => {
      for (const [agent, map] of titles) for (const [id, title] of map) rename.run(title, `${agent}:${id}`, agent);
    });

    result.ms = Math.round(performance.now() - t0);
    return result;
  }

  private async indexFiles(
    files: SourceFile[],
    known: Map<string, { mtime_ms: number; size: number }>,
    titles: Map<string, Map<string, string>>,
    bulk: boolean,
    result: IndexResult,
    onProgress?: (done: number, total: number) => void,
  ) {
    let done = 0;
    for (const f of files) {
      done++;
      let st: Stats;
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
          // 批量模式下外层已经有事务，用 SAVEPOINT 让一个文件出错时只撤销它自己
          (bulk ? this.savepoint : this.transaction).call(this, () => {
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
  }

  private savepoint(fn: () => void) {
    this.db.exec('SAVEPOINT file');
    try {
      fn();
      this.db.exec('RELEASE file');
    } catch (e) {
      this.db.exec('ROLLBACK TO file; RELEASE file');
      throw e;
    }
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
      .run(
        s.id,
        s.agent,
        s.nativeId,
        s.parentId,
        s.title,
        s.cwd,
        s.startedAt,
        s.updatedAt,
        s.archived ? 1 : 0,
        s.sourcePath,
        s.messages.length,
      );
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
    // 有全文检索词时，命中的 id 由全文索引给出，应该拿这些 id 去查；m.role 前面的一元 + 让 SQLite 别用角色索引，
    // 否则它会改成先扫一遍全部对话再逐条比对全文命中，常见词慢一倍。只有两字词时才需要角色索引来缩小 LIKE 的扫描范围
    where.push(`${long.length ? '+' : ''}m.role IN (${roles.map(() => '?').join(',')})`);
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

    // 分两步：先只用小字段（id、时间）排出最新的 N 条，再按 id 取回正文和会话信息。
    // 常见词会命中几千条，一步到位的话排序要带着几千段正文，两步走快一倍（见 docs/perf.md）
    const rows = this.db
      .prepare(
        `WITH top AS (
           SELECT m.id, m.ts, s.started_at, s.id AS sid
           FROM messages m JOIN sessions s ON s.id = m.session_id
           WHERE ${where.join(' AND ')}
           ORDER BY m.ts DESC, s.started_at ASC, s.id ASC LIMIT ?
         )
         SELECT m.id, m.session_id, m.seq, m.ts, m.role, m.tool_name, m.text, s.title, s.agent, s.cwd, s.started_at
         FROM top JOIN messages m ON m.id = top.id JOIN sessions s ON s.id = top.sid
         ORDER BY top.ts DESC, top.started_at ASC, top.sid ASC`,
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
