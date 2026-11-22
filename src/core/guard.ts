// 守门：Claude Code 的 Stop hook。
//
// agent 说完「测试全部通过」准备停下时，Claude Code 会先运行这个 hook。鱼巢读这一轮的会话记录，
// 用言行对账（claims.ts）核对这句话：最后一次测试其实失败了、或者改完代码一条命令都没跑，就把它拦回去，
// 理由会作为下一条消息交给 agent，让它重新跑测试或者更正说法。
//
// 不跑任何测试、不联网、不改文件，只读会话记录；核对不出问题、或者鱼巢自己出错时一律放行，
// 绝不因为鱼巢的 bug 卡住 agent。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { auditClaims, type Claim } from './claims.ts';
import { parseClaudeFile } from './parsers/claude.ts';
import { defaultDbPath } from './store.ts';

/** Claude Code 通过标准输入传给 Stop hook 的内容（只列出用到的字段） */
export interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  /** 这一轮已经被 Stop hook 拦过一次：再拦就可能来回拉锯，放行 */
  stop_hook_active?: boolean;
}

export interface GuardDecision {
  decision: 'block';
  reason: string;
  claim: Claim;
}

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** 交给 agent 的理由：说清楚哪句话、对不上在哪里、该怎么做 */
export function guardReason(c: Claim): string {
  const test = c.test ? `最后一次测试（${c.test.command}）` : '最后一次测试';
  const detail =
    c.verdict === 'stale' && c.editedAfter
      ? `${test}之后你又改了 ${c.editedAfter.files.map(fileName).join('、')}，改完没有再运行任何命令`
      : `${test}的结果是失败，之后没有再运行过`;
  return `鱼巢言行对账：你说「${c.sentence}」，但会话记录里${detail}。请重新运行测试确认结果；如果确实没有通过，请如实告诉用户。`;
}

/** 核对最近一轮：从你最后一句话之后，agent 说的「测试通过」 */
export async function checkStop(input: StopHookInput): Promise<GuardDecision | null> {
  if (input.stop_hook_active) return null;
  const path = input.transcript_path;
  if (!path || !existsSync(path)) return null;
  const { messages } = await parseClaudeFile(path);
  const lastAsk = messages.findLast((m) => m.role === 'user' && m.text.trim())?.seq ?? -1;
  const bad = auditClaims(messages).filter((c) => c.seq > lastAsk && (c.verdict === 'contradicted' || c.verdict === 'stale'));
  const claim = bad.at(-1);
  return claim ? { decision: 'block', reason: guardReason(claim), claim } : null;
}

// ---------------- 拦截记录 ----------------

/** 每拦一次记一行（时间、会话、结论），不记会话内容 */
export interface GuardLogEntry {
  at: string;
  sessionId: string | null;
  verdict: string;
  seq: number;
}

export const guardLogPath = () => join(dirname(defaultDbPath()), 'guard.jsonl');

export function logBlock(entry: GuardLogEntry, path = guardLogPath()) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n');
}

export function readGuardLog(path = guardLogPath()): GuardLogEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as GuardLogEntry];
      } catch {
        return [];
      }
    });
}

// ---------------- 安装到 ~/.claude/settings.json ----------------

interface HookEntry {
  type?: string;
  command?: string;
}
interface Settings {
  hooks?: Record<string, { matcher?: string; hooks?: HookEntry[] }[]>;
  [k: string]: unknown;
}

/** 认出鱼巢自己装的那一条：命令里有 yuchao，并以 guard 结尾 */
export const isGuardCommand = (cmd: string | undefined) => !!cmd && /yuchao/i.test(cmd) && /\sguard"?$/.test(cmd.trim());

function readSettings(path: string): Settings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as Settings;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} 不是一个 JSON 对象，没有改动它`);
  return parsed;
}

export function guardInstalled(settingsPath: string): boolean {
  const s = readSettings(settingsPath);
  return (s.hooks?.Stop ?? []).some((g) => (g.hooks ?? []).some((h) => isGuardCommand(h.command)));
}

/** 加一条 Stop hook；已经装过就替换成新的命令（例如程序换了位置）。其它设置原样保留 */
export function installGuard(settingsPath: string, command: string): 'installed' | 'updated' {
  const s = readSettings(settingsPath);
  const groups = (s.hooks?.Stop ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isGuardCommand(h.command)) }));
  const existed = guardInstalled(settingsPath);
  const kept = groups.filter((g) => g.hooks.length);
  s.hooks = { ...s.hooks, Stop: [...kept, { hooks: [{ type: 'command', command }] }] };
  writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
  return existed ? 'updated' : 'installed';
}

/** 只删掉鱼巢那一条，别的 hook 不动；Stop 空了就把这个键去掉 */
export function uninstallGuard(settingsPath: string): boolean {
  if (!guardInstalled(settingsPath)) return false;
  const s = readSettings(settingsPath);
  const kept = (s.hooks?.Stop ?? [])
    .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isGuardCommand(h.command)) }))
    .filter((g) => g.hooks.length);
  const hooks = { ...s.hooks };
  if (kept.length) hooks.Stop = kept;
  else delete hooks.Stop;
  if (Object.keys(hooks).length) s.hooks = hooks;
  else delete s.hooks;
  writeFileSync(settingsPath, JSON.stringify(s, null, 2) + '\n');
  return true;
}
