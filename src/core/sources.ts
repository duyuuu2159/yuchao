import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentKind } from './types.ts';

export interface SourceDirs {
  /** 默认 ~/.claude */
  claudeDir: string;
  /** 默认 ~/.codex */
  codexDir: string;
}

export function defaultSourceDirs(): SourceDirs {
  return { claudeDir: join(homedir(), '.claude'), codexDir: join(homedir(), '.codex') };
}

export interface SourceFile {
  agent: AgentKind;
  path: string;
}

function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e: any) {
    if (e.code === 'ENOENT') return out; // 没装这个 agent
    throw e;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, out);
    else if (keep(e.name)) out.push(p);
  }
  return out;
}

/** 找出所有会话文件 */
export function discover(dirs: SourceDirs): SourceFile[] {
  const claude = walk(join(dirs.claudeDir, 'projects'), (n) => n.endsWith('.jsonl'));
  const isCodex = (n: string) => n.endsWith('.jsonl') || n.endsWith('.jsonl.zst');
  const codex = [
    ...walk(join(dirs.codexDir, 'sessions'), isCodex),
    ...walk(join(dirs.codexDir, 'archived_sessions'), isCodex),
  ];
  return [
    ...claude.map((path) => ({ agent: 'claude' as const, path })),
    ...codex.map((path) => ({ agent: 'codex' as const, path })),
  ];
}
