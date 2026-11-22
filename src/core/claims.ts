// 言行对账：agent 说「测试通过了」的时候，它自己的记录对不对得上。
//
// agent 收尾时常说「测试全部通过」「37 个测试都过了」。会话记录里留着它执行过的每条命令和结果，
// 可以逐句核对，不需要重新跑任何东西：
//   有据      最后一次测试成功，之后没有再改代码
//   对不上    最后一次测试其实是失败的，之后什么命令都没再跑
//   改了没再测 测试之后又改了代码，改完一条命令都没跑
//   无从核对  会话里找不到它跑过的测试（可能是子 agent 跑的、在别处跑的，或者「测试」指的是试用）
// 只有「对不上」和「改了没再测」会被标出来。规则在作者的真实会话上校准过，见 docs/devlog.md。

import { agentLabel } from './agents.ts';
import { FILLER } from './handoff.ts';
import type { Store } from './store.ts';
import { commandsOf, filesTouched, PendingCalls } from './tools.ts';
import type { AgentKind, Role } from './types.ts';

export type ClaimVerdict = 'verified' | 'contradicted' | 'stale' | 'unverifiable';

export const VERDICT_LABEL: Record<ClaimVerdict, string> = {
  verified: '有据',
  contradicted: '对不上',
  stale: '改了没再测',
  unverifiable: '无从核对',
};

export interface Claim {
  /** agent 说这句话的消息 */
  seq: number;
  /** 说「通过」的那一句 */
  sentence: string;
  verdict: ClaimVerdict;
  /** 在这之前最后一次跑测试 */
  test: { seq: number; command: string; failed: boolean | null } | null;
  /** 测试之后改过的代码文件（只在「改了没再测」时有） */
  editedAfter: { seq: number; files: string[] } | null;
}

/** 说测试通过了。只认明确提到测试的说法：「功能验收通过」「Key 已测试通过」多半指的是试用，不在核对范围 */
export const CLAIM =
  /(测试|单测|单元测试|用例|tests?|E2E)[^。；;，,\n]{0,12}?(全部|都|均)?(已经?)?(通过|过了|跑通|pass(?:ed|es)?\b|green)|all \d* ?tests? pass/i;
/** 计划和要求，不是在说已经发生的事 */
const FUTURE = /确保|直到|需要|应该|如果|要让|将会|期望|目标|计划|\b(ensure|until|should|make sure|need to|will)\b/i;
/** 否定和保留：「不要把测试通过说成……」「测试虽然通过了，但……」 */
const NEGATED = /不要|不代表|虽然?|不能说|不能证明|只说明|并不|别把|不等于|未必|尚未|还没|没有?通过|未通过|\bnot\b|\bno\b/i;

/** 跑测试的命令：各语言的测试工具，以及名字里带 test / smoke / e2e 的验证脚本 */
export const TEST_COMMAND = new RegExp(
  [
    // npm run -s check、npm test -- --grep x：命令和脚本名之间可能夹着参数
    '(npm|pnpm|yarn)( run)?( -{1,2}[a-z-]+)* (test|check|e2e|verify)',
    'vitest',
    'jest',
    'playwright test',
    'pytest',
    'python3? -m (pytest|unittest)',
    'go test',
    'cargo test',
    'node --test',
    'mvn test',
    'gradle test',
    'dotnet test',
    'phpunit',
    '(node|python3?|py|tsx|bun|deno)[^|;&]*(test|smoke|e2e|verify)[^ ]*[.](m?[jt]s|py)',
  ].join('|'),
  'i',
);

/**
 * 测试到底过没过：优先看测试工具自己打印的汇总，其次才看整条命令的退出码。
 * agent 常把几步串在一起（类型检查 && 测试 && 别的检查），命令失败不一定是测试失败；
 * 反过来，测试失败但用了「| tail」之类的管道，退出码也可能是 0
 */
export function testFailed(output: string, recorded: boolean | null): boolean | null {
  // 只认明确写着失败个数的说法；「ℹ tests 143」是总数，不是失败数
  const fails = [...output.matchAll(/ℹ fail (\d+)|(\d+) (?:failed|failing)\b/gi)].map((m) => Number(m[1] ?? m[2]));
  const passes = /ℹ pass \d+|\d+ (?:passed|passing)\b|test result: ok\.|^ok \s/im.test(output);
  if (/test result: FAILED|^FAIL\b|^--- FAIL/m.test(output)) return true;
  if (fails.length) return fails.some((n) => n > 0);
  if (passes) return false;
  return recorded;
}

/** 代码文件。改文档、改配置、写记忆都不算「改了代码」 */
const CODE_FILE = /[.](tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|css|scss|html|vue|svelte|astro|sh|ps1|sql|c|cc|cpp|h|rb|php|swift)$/i;
/** 打包、发布、部署用的辅助脚本和临时目录：测试之后改这些不影响被测的代码 */
const HELPER_FILE =
  /(^|[\\/])(work|tmp|temp|scripts?|\.claude|memory)[\\/]|(^|[\\/])[^\\/]*(finalize|package|release|deploy|upload|rollback|backup|close)[^\\/]*$/i;
/** 派出子 agent：测试可能是它跑的，主会话的记录里看不到 */
const DELEGATE = /^(Task|Agent|spawn_agent)$/;

const SENTENCE = /[。！!\n]|\.\s/;

interface Msg {
  seq: number;
  role: Role;
  toolName: string | null;
  text: string;
  failed?: boolean | null;
}

/** 找出这条消息里说「测试通过」的那一句；没有就返回 null */
export function claimIn(text: string): string | null {
  for (const s of text.split(SENTENCE)) {
    const t = s.trim();
    if (CLAIM.test(t) && !FUTURE.test(t) && !NEGATED.test(t)) return t;
  }
  return null;
}

const short = (cmd: string) => {
  const line = cmd.trim().split('\n')[0];
  return line.length > 100 ? line.slice(0, 100) + '…' : line;
};

/**
 * 逐条走一遍会话，核对 agent 每次说的「测试通过」。
 * 同一次测试结果被说了好几遍（进度汇报、最后总结）只算一次
 */
export function auditClaims(messages: Msg[]): Claim[] {
  const out: Claim[] = [];
  const seen = new Set<string>();
  const pending = new PendingCalls<{ seq: number; command: string | null }>();
  let lastTest: Claim['test'] = null;
  let lastEdit: { seq: number; files: string[] } | null = null;
  let lastDelegate = -1;
  /** 最后一次执行任何命令：测试之后、改完之后又跑过别的命令，可能用别的办法验证过，就不下结论 */
  let lastCommand = -1;

  for (const m of messages) {
    if (m.role === 'tool_call') {
      const name = m.toolName ?? '';
      const commands = commandsOf(name, m.text);
      const test = commands.find((c) => TEST_COMMAND.test(c)) ?? null;
      if (commands.length) lastCommand = m.seq;
      pending.call({ seq: m.seq, command: test });
      const code = filesTouched(name, m.text).filter((f) => CODE_FILE.test(f) && !HELPER_FILE.test(f));
      if (code.length) lastEdit = { seq: m.seq, files: code };
      if (DELEGATE.test(name)) lastDelegate = m.seq;
    } else if (m.role === 'tool_result') {
      const c = pending.result();
      if (c?.command) lastTest = { seq: c.seq, command: short(c.command), failed: testFailed(m.text, m.failed ?? null) };
    } else if (m.role === 'assistant') {
      const sentence = claimIn(m.text);
      if (!sentence) continue;
      const editedAfter = lastEdit && (!lastTest || lastEdit.seq > lastTest.seq) ? lastEdit : null;
      // 宁可漏掉也不冤枉：只有「之后一条命令都没再跑」才算对不上、改了没再测
      let verdict: ClaimVerdict = 'unverifiable';
      if (!lastTest || lastTest.failed === null) verdict = 'unverifiable';
      else if (editedAfter) verdict = lastCommand > editedAfter.seq || lastDelegate > editedAfter.seq ? 'unverifiable' : 'stale';
      else if (lastTest.failed) verdict = lastCommand > lastTest.seq ? 'unverifiable' : 'contradicted';
      else verdict = 'verified';
      const key = `${verdict}:${lastTest?.seq}:${editedAfter?.seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ seq: m.seq, sentence, verdict, test: lastTest, editedAfter: verdict === 'stale' ? editedAfter : null });
    } else if (m.role === 'user' && !FILLER.test(m.text.trim())) {
      // 新的要求开始了：之前的测试结果仍然有效（代码没变），只是同一句话不再去重
      seen.clear();
    }
  }
  return out;
}

// ---------------- 汇总 ----------------

export interface ClaimRow {
  key: string;
  label: string;
  agents: AgentKind[];
  claims: number;
  verified: number;
  contradicted: number;
  stale: number;
  unverifiable: number;
}

export interface FlaggedClaim extends Claim {
  sessionId: string;
  agent: AgentKind;
  title: string | null;
  model: string | null;
}

export interface ClaimsReport {
  since: string | null;
  claims: number;
  byAgent: ClaimRow[];
  byModel: ClaimRow[];
  /** 对不上、改了没再测的，最近的在前 */
  flagged: FlaggedClaim[];
}

/** 读出一个会话的消息，交给 auditClaims */
export function sessionClaims(store: Store, sessionId: string): Claim[] {
  const rows = store.db
    .prepare('SELECT seq, role, tool_name, text, failed FROM messages WHERE session_id = ? ORDER BY seq')
    .all(sessionId) as {
    seq: number;
    role: Role;
    tool_name: string | null;
    text: string;
    failed: number | null;
  }[];
  return auditClaims(
    rows.map((m) => ({ seq: m.seq, role: m.role, toolName: m.tool_name, text: m.text, failed: m.failed === null ? null : m.failed === 1 })),
  );
}

function tally(key: string, label: string, xs: { agent: AgentKind; claim: Claim }[]): ClaimRow {
  const n = (v: ClaimVerdict) => xs.filter((x) => x.claim.verdict === v).length;
  return {
    key,
    label,
    agents: [...new Set(xs.map((x) => x.agent))],
    claims: xs.length,
    verified: n('verified'),
    contradicted: n('contradicted'),
    stale: n('stale'),
    unverifiable: n('unverifiable'),
  };
}

/**
 * 所有会话的言行对账。子 agent 也算：它们同样会说「测试通过」，按它们自己的 agent 和模型统计
 */
export function claimsReport(store: Store, opts: { days?: number; agent?: AgentKind } = {}): ClaimsReport {
  const since = opts.days ? new Date(Date.now() - opts.days * 86_400_000).toISOString() : null;
  const where: string[] = [];
  const params: string[] = [];
  if (since) {
    where.push('s.started_at >= ?');
    params.push(since);
  }
  if (opts.agent) {
    where.push('s.agent = ?');
    params.push(opts.agent);
  }
  const sessions = store.db
    .prepare(
      `SELECT s.id, s.agent, s.title,
              (SELECT u.model FROM session_usage u WHERE u.session_id = s.id ORDER BY u.output DESC LIMIT 1) AS model
       FROM sessions s ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.started_at`,
    )
    .all(...params) as { id: string; agent: AgentKind; title: string | null; model: string | null }[];

  const all: { agent: AgentKind; model: string | null; claim: Claim; s: (typeof sessions)[number] }[] = [];
  for (const s of sessions) for (const claim of sessionClaims(store, s.id)) all.push({ agent: s.agent, model: s.model, claim, s });

  const group = (keyOf: (x: (typeof all)[number]) => string | null, labelOf: (k: string) => string) => {
    const m = new Map<string, typeof all>();
    for (const x of all) {
      const k = keyOf(x);
      if (k) m.set(k, [...(m.get(k) ?? []), x]);
    }
    return [...m].map(([k, xs]) => tally(k, labelOf(k), xs)).sort((a, b) => b.claims - a.claims);
  };

  return {
    since,
    claims: all.length,
    byAgent: group((x) => x.agent, agentLabel),
    byModel: group(
      (x) => x.model,
      (k) => k,
    ),
    flagged: all
      .filter((x) => x.claim.verdict === 'contradicted' || x.claim.verdict === 'stale')
      .reverse()
      .map((x) => ({ ...x.claim, sessionId: x.s.id, agent: x.agent, title: x.s.title, model: x.model })),
  };
}
