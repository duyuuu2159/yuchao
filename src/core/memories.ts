import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { redact } from './scan.ts';

// Claude Code 的记忆文件：~/.claude/projects/<项目>/memory/*.md
// 这是 agent 自己写下的「我对这个用户的了解」，是字面意义上的「agent 眼中的你」。

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'other';

export interface AgentMemory {
  agent: 'claude';
  /** 记忆所在的项目目录名，例如 G--claude-- */
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
