import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENTS } from './agents.ts';
import type { AgentKind } from './types.ts';

/** 每个 agent 的数据目录；没列出的 agent 不参与索引（测试里只给临时目录，避免读到本机真实数据） */
export type SourceDirs = Partial<Record<AgentKind, string>>;

export function defaultSourceDirs(): SourceDirs {
  return Object.fromEntries(AGENTS.map((a) => [a.kind, join(homedir(), a.home)]));
}

export interface SourceFile {
  agent: AgentKind;
  path: string;
}

/** 找出所有会话文件 */
export function discover(dirs: SourceDirs): SourceFile[] {
  return AGENTS.flatMap((a) => {
    const dir = dirs[a.kind];
    return dir ? a.sessionFiles(dir).map((path) => ({ agent: a.kind, path })) : [];
  });
}
