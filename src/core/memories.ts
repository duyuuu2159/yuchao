import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { redact } from './scan.ts';
import type { SourceDirs } from './sources.ts';
import type { AgentKind } from './types.ts';

// agent 自己写下的「我对这个用户的了解」，是字面意义上的「agent 眼中的你」：
// - Claude Code：~/.claude/projects/<项目>/memory/*.md，一条记忆一个文件，带 YAML 头
// - WorkBuddy：~/.workbuddy/USER.md（它眼中的用户）、MEMORY.md（长期记忆）、memory/<用户id>_memory.md（用户画像），
//   每个文件是一整篇笔记

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'other';

export interface AgentMemory {
  agent: AgentKind;
  /** 记忆所在的项目目录名，例如 G--claude--；全局记忆为空串 */
  project: string;
  name: string;
  description: string;
  type: MemoryType;
  /** 已打码的正文 */
  body: string;
  /** 写下这条记忆的会话，方便追溯 */
  originSessionId: string | null;
  modified: string | null;
  path: string;
}

/** 只解析记忆文件用到的简单 YAML 头：`key: value` 和一层缩进的 metadata */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv || kv[2] === '') continue;
    // 双引号字符串里的 \" 和 \\ 要还原，例如 "G:\\claude网站"
    meta[kv[1]] = /^".*"$/.test(kv[2]) ? kv[2].slice(1, -1).replace(/\\(["\\])/g, '$1') : kv[2];
  }
  return { meta, body: m[2].trim() };
}

const TYPES = new Set<MemoryType>(['user', 'feedback', 'project', 'reference']);

export function readClaudeMemories(claudeDir: string): AgentMemory[] {
  const projects = join(claudeDir, 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const out: AgentMemory[] = [];
  for (const project of dirs) {
    const memDir = join(projects, project, 'memory');
    let files: string[];
    try {
      if (!statSync(memDir).isDirectory()) continue;
      files = readdirSync(memDir);
    } catch {
      continue;
    }
    for (const f of files) {
      // MEMORY.md 只是索引，内容都在各自的文件里
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      const path = join(memDir, f);
      const { meta, body } = parseFrontmatter(readFileSync(path, 'utf8'));
      out.push({
        agent: 'claude',
        project,
        name: meta.name ?? basename(f, '.md'),
        description: redact(meta.description ?? ''),
        type: TYPES.has(meta.type as MemoryType) ? (meta.type as MemoryType) : 'other',
        body: redact(body),
        originSessionId: meta.originSessionId ?? null,
        modified: meta.modified ?? null,
        path,
      });
    }
  }
  return out.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));
}

const WORKBUDDY_NOTES: { file: string; type: MemoryType; description: string }[] = [
  { file: 'USER.md', type: 'user', description: 'WorkBuddy 记录的用户资料' },
  { file: 'MEMORY.md', type: 'other', description: 'WorkBuddy 的长期记忆' },
];

export function readWorkBuddyMemories(dir: string): AgentMemory[] {
  const notes = WORKBUDDY_NOTES.map((n) => ({ ...n, path: join(dir, n.file) }));
  try {
    for (const f of readdirSync(join(dir, 'memory'))) {
      if (f.endsWith('_memory.md'))
        notes.push({ file: f, type: 'user', description: 'WorkBuddy 整理的用户画像', path: join(dir, 'memory', f) });
    }
  } catch {
    // 没有 memory 目录
  }
  const out: AgentMemory[] = [];
  for (const n of notes) {
    let text: string;
    let mtime: Date;
    try {
      text = readFileSync(n.path, 'utf8');
      mtime = statSync(n.path).mtime;
    } catch {
      continue;
    }
    const { body } = parseFrontmatter(text);
    if (!body.trim()) continue;
    out.push({
      agent: 'workbuddy',
      project: '',
      name: n.file,
      description: n.description,
      type: n.type,
      body: redact(body),
      originSessionId: null,
      modified: mtime.toISOString(),
      path: n.path,
    });
  }
  return out;
}

/** 所有 agent 的记忆，按修改时间从新到旧 */
export function readMemories(dirs: SourceDirs): AgentMemory[] {
  const all = [...(dirs.claude ? readClaudeMemories(dirs.claude) : []), ...(dirs.workbuddy ? readWorkBuddyMemories(dirs.workbuddy) : [])];
  return all.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));
}
