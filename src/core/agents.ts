import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCodexTitles, parseCodexFile } from './parsers/codex.ts';
import { parseClaudeFile } from './parsers/claude.ts';
import { parseDshFile } from './parsers/dsh.ts';
import { parseWorkBuddyFile } from './parsers/workbuddy.ts';
import type { AgentKind, Session } from './types.ts';

/**
 * 每个 agent 一个适配器。索引、扫描、画像、配置管家都只通过这里认识 agent，
 * 接入一个新 agent = 写一个解析器 + 在 AGENTS 里加一项。
 */
export interface AgentAdapter {
  kind: AgentKind;
  /** 界面上显示的名字 */
  label: string;
  /** 数据目录，相对用户主目录 */
  home: string;
  /** 找出所有会话文件；目录不存在说明没装这个 agent，返回空 */
  sessionFiles(dir: string): string[];
  parse(path: string, titles: Map<string, string>): Promise<Session>;
  /** 标题存在会话文件之外的 agent（Codex 改名只写 session_index），每次索引都同步一遍 */
  titles?(dir: string): Promise<Map<string, string>>;
  /** 配置管家默认跟踪的文件 */
  configFiles(dir: string): string[];
}

export function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e: any) {
    if (e.code === 'ENOENT') return out;
    throw e;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, keep, out);
    else if (keep(e.name)) out.push(p);
  }
  return out;
}

const isJsonl = (n: string) => n.endsWith('.jsonl');

export const AGENTS: AgentAdapter[] = [
  {
    kind: 'claude',
    label: 'Claude Code',
    home: '.claude',
    sessionFiles: (dir) => walk(join(dir, 'projects'), isJsonl),
    parse: (path) => parseClaudeFile(path),
    configFiles: (dir) => [join(dir, 'settings.json'), join(dir, 'CLAUDE.md')],
  },
  {
    kind: 'codex',
    label: 'Codex',
    home: '.codex',
    sessionFiles: (dir) => {
      const keep = (n: string) => n.endsWith('.jsonl') || n.endsWith('.jsonl.zst');
      return [...walk(join(dir, 'sessions'), keep), ...walk(join(dir, 'archived_sessions'), keep)];
    },
    parse: (path, titles) => parseCodexFile(path, titles),
    titles: (dir) => loadCodexTitles(join(dir, 'session_index.jsonl')),
    configFiles: (dir) => [join(dir, 'config.toml'), join(dir, 'AGENTS.md')],
  },
  {
    kind: 'workbuddy',
    label: 'WorkBuddy',
    home: '.workbuddy',
    // 同目录下的 *.file-rollback.ndjson 是文件改动的回滚记录，不是对话
    sessionFiles: (dir) => walk(join(dir, 'projects'), isJsonl),
    parse: (path) => parseWorkBuddyFile(path),
    configFiles: (dir) => [join(dir, 'settings.json'), join(dir, 'models.json'), join(dir, 'mcp.json'), join(dir, 'AGENTS.md')],
  },
  {
    kind: 'dsh',
    label: 'DeepSeek Harness',
    home: '.dsh',
    sessionFiles: (dir) => walk(join(dir, 'sessions'), (n) => n.endsWith('.jsonl.zstd')),
    parse: (path) => parseDshFile(path),
    // .credentials.yaml 存的是登录凭据，不跟踪，免得把密钥复制进索引库
    configFiles: (dir) => [join(dir, 'AGENTS.md'), join(dir, 'profiles', 'desktop', 'cordis.yml'), join(dir, 'profiles', 'desktop', 'cordis.patch.yml')],
  },
];

export const AGENT_KINDS = AGENTS.map((a) => a.kind);

export function adapter(kind: AgentKind): AgentAdapter {
  return AGENTS.find((a) => a.kind === kind)!;
}

export const agentLabel = (kind: string) => AGENTS.find((a) => a.kind === kind)?.label ?? kind;

export const isAgentKind = (v: unknown): v is AgentKind => AGENT_KINDS.includes(v as AgentKind);
