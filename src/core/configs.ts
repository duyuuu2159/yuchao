import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { AGENTS } from './agents.ts';
import { redact } from './scan.ts';
import type { SourceDirs } from './sources.ts';
import type { Store } from './store.ts';

// 配置管家：给各个 agent 的配置文件做版本记录。
// - 快照：内容有变化才记一版，内容按哈希去重存放
// - 导入：把散落在旁边的手工备份（config.toml.bak_xxx）整理进同一条时间线
// - 校验：每个版本都检查能否解析，标出损坏的版本
// - 回滚：先记录当前内容，确认目标版本没坏，再原子写入
// 版本里保存的是原文（回滚需要），显示时一律打码。

export type ConfigFormat = 'json' | 'toml' | 'text';

export interface TrackedFile {
  path: string;
  name: string;
  format: ConfigFormat;
}

export type VersionSource = 'snapshot' | 'backup' | 'before-restore' | 'restore';

export interface ConfigVersion {
  id: number;
  path: string;
  hash: string;
  size: number;
  capturedAt: string;
  source: VersionSource;
  label: string;
  /** 解析失败时的错误信息，null 表示格式正确 */
  error: string | null;
}

export interface FileStatus extends TrackedFile {
  exists: boolean;
  versions: number;
  latest: ConfigVersion | null;
  /** 当前文件和最近记录的版本不一样（有尚未记录的修改） */
  changed: boolean;
  /** 当前文件的格式错误 */
  error: string | null;
}

const MAX_SIZE = 2 * 1024 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config_blobs (
  hash    TEXT PRIMARY KEY,
  content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS config_versions (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL,
  hash        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  source      TEXT NOT NULL,
  label       TEXT NOT NULL,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS config_versions_path ON config_versions(path, captured_at);
CREATE TABLE IF NOT EXISTS config_tracked (
  path TEXT PRIMARY KEY
);
`;

export function formatOf(path: string): ConfigFormat {
  const ext = extname(path).toLowerCase();
  return ext === '.json' ? 'json' : ext === '.toml' ? 'toml' : 'text';
}

export const hasNul = (s: string) => s.includes('\0');

/** 检查内容能否按格式解析，返回错误信息；格式正确返回 null */
export function validate(format: ConfigFormat, content: string): string | null {
  // 写文件时崩溃或断电，常见结果是文件大小对、内容却全是 0
  if (hasNul(content)) return /^\0+$/.test(content) ? '内容全是空字节（0），通常是写入时程序崩溃或断电' : '内容含有空字节，文件可能已损坏';
  try {
    if (format === 'json') JSON.parse(content);
    else if (format === 'toml') parseToml(content);
    return null;
  } catch (e: any) {
    return String(e.message ?? e).split('\n')[0];
  }
}

const SECRET_KEY = /(["']?[\w.-]*(?:key|token|secret|password|passwd|pwd|auth)[\w.-]*["']?\s*[:=]\s*["']?)([^"'\s,}]{6,})/gi;

/** 配置专用打码：除了通用规则，名字里带 key、token、secret、password 的字段值一律打码 */
export function redactConfig(text: string): string {
  return redact(text).replace(SECRET_KEY, (_, head: string, value: string) =>
    // 已经打过码的、纯数字的（例如 token_limit = 240000）不处理
    value.includes('*') || /^\d+$/.test(value) ? head + value : head + value.slice(0, 2) + '*'.repeat(Math.min(value.length - 2, 10)),
  );
}

export const displayPath = (p: string) => (p.startsWith(homedir()) ? '~' + p.slice(homedir().length).replace(/\\/g, '/') : p);

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** 默认跟踪的配置文件 */
export function defaultTracked(dirs: SourceDirs): string[] {
  return AGENTS.flatMap((a) => (dirs[a.kind] ? a.configFiles(dirs[a.kind]!) : []));
}

/** 和配置文件放在一起的手工备份，例如 config.toml.bak_20260722、settings.json.bak-before-proxy */
export function findBackups(path: string): string[] {
  const dir = dirname(path);
  const base = basename(path);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n !== base && n.startsWith(base + '.') && /bak|backup|corrupt|orig|save/i.test(n.slice(base.length)))
    .map((n) => join(dir, n))
    .filter((p) => {
      try {
        const st = statSync(p);
        return st.isFile() && st.size <= MAX_SIZE;
      } catch {
        return false;
      }
    });
}

export class ConfigManager {
  private readonly store: Store;
  private readonly dirs: SourceDirs;

  constructor(store: Store, dirs: SourceDirs) {
    this.store = store;
    this.dirs = dirs;
    store.db.exec(SCHEMA);
    this.revalidate();
  }

  /** 用当前的校验规则重新检查已有版本，规则改进后旧记录的结论也跟着更新 */
  private revalidate() {
    const rows = this.store.db.prepare('SELECT v.id, v.path, v.error, b.content FROM config_versions v JOIN config_blobs b ON b.hash = v.hash').all() as any[];
    const update = this.store.db.prepare('UPDATE config_versions SET error = ? WHERE id = ?');
    for (const r of rows) {
      const error = validate(formatOf(r.path), r.content);
      if (error !== r.error) update.run(error, r.id);
    }
  }

  tracked(): TrackedFile[] {
    const extra = (this.store.db.prepare('SELECT path FROM config_tracked').all() as any[]).map((r) => r.path as string);
    const paths = [...new Set([...defaultTracked(this.dirs), ...extra].map((p) => resolve(p)))];
    return paths.map((path) => ({ path, name: displayPath(path), format: formatOf(path) }));
  }

  track(path: string) {
    const p = resolve(path);
    if (!existsSync(p)) throw new Error(`文件不存在：${p}`);
    this.store.db.prepare('INSERT OR IGNORE INTO config_tracked(path) VALUES (?)').run(p);
  }

  untrack(path: string) {
    this.store.db.prepare('DELETE FROM config_tracked WHERE path = ?').run(resolve(path));
  }

  private latest(path: string): ConfigVersion | null {
    const r = this.store.db.prepare('SELECT * FROM config_versions WHERE path = ? ORDER BY captured_at DESC, id DESC LIMIT 1').get(path);
    return r ? toVersion(r) : null;
  }

  private record(path: string, content: string, capturedAt: string, source: VersionSource, label: string): ConfigVersion {
    const hash = sha(content);
    this.store.db.prepare('INSERT OR IGNORE INTO config_blobs(hash, content) VALUES (?, ?)').run(hash, content);
    const error = validate(formatOf(path), content);
    const r = this.store.db
      .prepare('INSERT INTO config_versions(path, hash, size, captured_at, source, label, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(path, hash, Buffer.byteLength(content), capturedAt, source, label, error);
    return { id: Number(r.lastInsertRowid), path, hash, size: Buffer.byteLength(content), capturedAt, source, label, error };
  }

  /** 给有变化的配置文件各记一版。版本时间取文件的修改时间，也就是这份内容真正写下的时间 */
  snapshot(): { recorded: string[]; unchanged: number; missing: number } {
    const recorded: string[] = [];
    let unchanged = 0;
    let missing = 0;
    for (const f of this.tracked()) {
      if (!existsSync(f.path)) {
        missing++;
        continue;
      }
      const st = statSync(f.path);
      if (st.size > MAX_SIZE) continue;
      const content = readFileSync(f.path, 'utf8');
      if (this.latest(f.path)?.hash === sha(content)) {
        unchanged++;
        continue;
      }
      this.record(f.path, content, st.mtime.toISOString(), 'snapshot', '自动快照');
      recorded.push(f.name);
    }
    return { recorded, unchanged, missing };
  }

  /** 把旁边的手工备份导入时间线；内容和已有版本相同的跳过。原备份文件不动 */
  importBackups(): { imported: number; duplicates: number; broken: number } {
    let imported = 0;
    let duplicates = 0;
    let broken = 0;
    const seen = this.store.db.prepare('SELECT 1 FROM config_versions WHERE path = ? AND hash = ? LIMIT 1');
    for (const f of this.tracked()) {
      for (const b of findBackups(f.path)) {
        const content = readFileSync(b, 'utf8');
        if (seen.get(f.path, sha(content))) {
          duplicates++;
          continue;
        }
        const v = this.record(f.path, content, statSync(b).mtime.toISOString(), 'backup', basename(b));
        imported++;
        if (v.error) broken++;
      }
    }
    return { imported, duplicates, broken };
  }

  status(): FileStatus[] {
    return this.tracked().map((f) => {
      const exists = existsSync(f.path);
      const latest = this.latest(f.path);
      const versions = (this.store.db.prepare('SELECT COUNT(*) AS n FROM config_versions WHERE path = ?').get(f.path) as any).n;
      let changed = false;
      let error: string | null = null;
      if (exists) {
        const content = readFileSync(f.path, 'utf8');
        changed = latest?.hash !== sha(content);
        error = validate(f.format, content);
      }
      return { ...f, exists, versions, latest, changed, error };
    });
  }

  versions(path: string): ConfigVersion[] {
    return (this.store.db.prepare('SELECT * FROM config_versions WHERE path = ? ORDER BY captured_at DESC, id DESC').all(resolve(path)) as any[]).map(toVersion);
  }

  version(id: number): ConfigVersion | null {
    const r = this.store.db.prepare('SELECT * FROM config_versions WHERE id = ?').get(id);
    return r ? toVersion(r) : null;
  }

  /** 原文，只在回滚时使用；显示一律走 redactConfig */
  rawContent(id: number): string {
    const r = this.store.db.prepare('SELECT b.content FROM config_versions v JOIN config_blobs b ON b.hash = v.hash WHERE v.id = ?').get(id) as any;
    if (!r) throw new Error(`没有版本 #${id}`);
    return r.content;
  }

  /** 当前文件内容；文件不存在时返回空字符串 */
  currentContent(path: string): string {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  }

  /**
   * 回滚到某个版本：
   *   1. 目标版本格式有误时拒绝（除非 force）
   *   2. 先把当前内容记录成一个版本，回滚本身也可以撤销
   *   3. 写到同目录的临时文件再改名替换，写到一半出错也不会留下半个文件
   *   4. 写完重新读取核对
   */
  restore(id: number, opts: { force?: boolean } = {}): { before: ConfigVersion | null; after: ConfigVersion } {
    const target = this.version(id);
    if (!target) throw new Error(`没有版本 #${id}`);
    if (target.error && !opts.force) throw new Error(`版本 #${id} 的格式有误（${target.error}），回滚后程序可能无法启动。确定要回滚请加 --force`);
    const content = this.rawContent(id);

    let before: ConfigVersion | null = null;
    if (existsSync(target.path)) {
      const current = readFileSync(target.path, 'utf8');
      const latest = this.latest(target.path);
      before = latest?.hash === sha(current) ? latest : this.record(target.path, current, new Date().toISOString(), 'before-restore', `回滚到 #${id} 之前的内容`);
    }

    const tmp = `${target.path}.yuchao-tmp-${process.pid}`;
    writeFileSync(tmp, content);
    renameSync(tmp, target.path);
    if (sha(readFileSync(target.path, 'utf8')) !== target.hash) throw new Error('写入后核对失败，文件内容和目标版本不一致');

    const after = this.record(target.path, content, new Date().toISOString(), 'restore', `回滚到 #${id}`);
    return { before, after };
  }
}

function toVersion(r: any): ConfigVersion {
  return { id: r.id, path: r.path, hash: r.hash, size: r.size, capturedAt: r.captured_at, source: r.source, label: r.label, error: r.error };
}
