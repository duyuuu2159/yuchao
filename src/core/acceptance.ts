import { createHash } from 'node:crypto';
import { TEST_COMMAND, testFailed } from './claims.ts';
import { redact } from './scan.ts';
import type { Store } from './store.ts';
import { commandsOf } from './tools.ts';
import { stoppedByUser } from './toolstatus.ts';
import type { AgentKind, Message } from './types.ts';

interface Reference {
  sessionId: string;
  seq: number;
  agent: AgentKind;
  available: boolean;
}

type TestResult = 'pass' | 'fail' | 'unknown';

export interface AcceptanceEvidence extends Reference {
  command: string | null;
  result: TestResult;
  covers: boolean;
  afterRequirement: boolean;
}

export interface AcceptanceRevision {
  id: number;
  source: Reference & { text: string };
  evidence: AcceptanceEvidence[];
  status: 'pending' | 'verified' | 'failed';
}

export interface AcceptanceDocument {
  revisions: AcceptanceRevision[];
}

type Entry = { id: number; session_id: string; seq: number; agent: AgentKind; fingerprint: string };
type EvidenceEntry = Entry & { revision_id: number; covers: number };
type Session = NonNullable<ReturnType<Store['getSession']>>;
type Candidate = { call: Message; result: Message; command: string };

export class AcceptanceError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function recognizedCommand(call: Message): string | null {
  const commands = commandsOf(call.toolName, call.text);
  if (commands.length !== 1) return null;
  const command = commands[0].trim();
  // 不从脚本、管道、并行命令或命令替换里推断哪次测试跑了。
  if (/[\r\n;|&`]|\$\(/.test(command)) return null;
  const direct = command.replace(/^(npm|pnpm|yarn)\.(?:cmd|exe)\b/i, '$1').replace(/^npx(?:\.cmd)?(?: --no-install)? +/i, '');
  const match = TEST_COMMAND.exec(direct);
  const next = match ? direct.charAt(match[0].length) : '';
  return match?.index === 0 && (!next || /\s/.test(next)) ? command : null;
}

/** 索引没有调用编号；仅链接一问一答的结果，不猜测一批并发工具的对应关系。 */
function candidates(messages: Message[]): Map<number, Candidate> {
  const found = new Map<number, Candidate>();
  let call: Message | null = null;
  let parallel = false;
  for (const message of messages) {
    if (message.role === 'tool_call') {
      parallel ||= call !== null;
      call = message;
    } else {
      if (message.role === 'tool_result' && call && !parallel) {
        const command = recognizedCommand(call);
        if (command) found.set(message.seq, { call, result: message, command });
      }
      call = null;
      parallel = false;
    }
  }
  return found;
}

export function acceptanceEvidenceSeqs(messages: Message[]): number[] {
  return [...candidates(messages).keys()];
}

function summarize(output: string): TestResult {
  // 不因为退出码为 0 就显示有据：命令可能没有执行任何用例，或汇总在截断处之后。
  // 只认测试框架自己的正数通过汇总，不认描述、单个 OK 或只写「0 failed」的结果。
  const passed =
    /^(?:ℹ|#) pass [1-9]\d*\s*$|^(?:Tests:\s+.*|=+ +)?[1-9]\d* (?:passed|passing)\b|^test result: ok\. [1-9]\d* passed\b|^Passed! +(?:- )?Failed: +0, +Passed: +[1-9]\d*\b|^ok\s+\S+\s+(?:\d+(?:\.\d+)?s|\(cached\))\s*$|^PASS [1-9]\d* tests\s*$/im;
  if (testFailed(output, null) === true) return 'fail';
  if (/…\[截断，原长 \d+\]$|^(?:ℹ|#) (?:skip(?:ped)?|todo|cancelled) [1-9]\d*\s*$|\b[1-9]\d* (?:skipped|ignored)\b/im.test(output)) {
    return 'unknown';
  }
  return passed.test(output) ? 'pass' : 'unknown';
}

function resultOf(message: Message): TestResult {
  if (stoppedByUser(message.text)) return 'unknown';
  const result = summarize(message.text);
  // 只把确实观察到的测试失败称作「失败」；命令报错（如测试脚本不存在）不能反推用例失败。
  // 汇总与工具执行状态矛盾时也不确认通过。
  return message.failed === true && result === 'pass' ? 'unknown' : result;
}

function safeCommand(command: string): string {
  // shell 的 --password=value 参数不在通用密码扫描的匹配范围；这里只对命令显示补一层。
  return redact(command).replace(
    /(^|\s)(--(?:password|passwd|pwd|passphrase|(?:api[-_]?)?key|(?:access[-_]?)?token|secret))(=|\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
    '$1$2$3[已打码]',
  );
}

function fingerprint(session: Session, ...messages: Message[]): string {
  // 用内容和时间约束 seq 这个指针，重建索引后不能把位置上一条不同的消息当成旧证据。
  return createHash('sha256')
    .update(
      JSON.stringify([
        session.agent,
        session.cwd,
        messages.map(({ seq, ts, role, toolName, text, failed }) => [seq, ts, role, toolName, text, failed]),
      ]),
    )
    .digest('hex');
}

function acceptedAfter(requirement: Message | null, sameSession: boolean, { call, result }: Candidate): boolean {
  if (!requirement) return false;
  if (sameSession) return call.seq > requirement.seq;
  if (!requirement.ts || !call.ts || !result.ts) return false;
  const at = Date.parse(call.ts);
  return at > Date.parse(requirement.ts) && Date.parse(result.ts) >= at;
}

const ref = (entry: Entry, available: boolean): Reference => ({
  sessionId: entry.session_id,
  seq: entry.seq,
  agent: entry.agent,
  available,
});

export function acceptanceDocument(store: Store, raw = false): AcceptanceDocument {
  const revisions = store.db.prepare('SELECT * FROM acceptance_revisions ORDER BY id DESC').all() as unknown as Entry[];
  const links = store.db.prepare('SELECT * FROM acceptance_evidence ORDER BY id DESC').all() as unknown as EvidenceEntry[];
  const sessions = new Map<string, Session | null>();
  const outputs = new Map<string, Map<number, Candidate>>();
  const evidenceByRevision = new Map<number, EvidenceEntry[]>();
  const safe = raw ? (s: string) => s : redact;
  for (const link of links) {
    if (!evidenceByRevision.has(link.revision_id)) evidenceByRevision.set(link.revision_id, []);
    evidenceByRevision.get(link.revision_id)?.push(link);
  }
  const sessionOf = (id: string) => {
    if (!sessions.has(id)) sessions.set(id, store.getSession(id));
    return sessions.get(id);
  };
  return {
    revisions: revisions.map((revision) => {
      const source = sessionOf(revision.session_id);
      const user = source?.messages.find((m) => m.seq === revision.seq && m.role === 'user');
      const requirement = user && source && fingerprint(source, user) === revision.fingerprint ? user : null;
      const evidence = (evidenceByRevision.get(revision.id) ?? []).map((link): AcceptanceEvidence => {
        const session = sessionOf(link.session_id);
        if (session && !outputs.has(link.session_id)) outputs.set(link.session_id, candidates(session.messages));
        const hit = outputs.get(link.session_id)?.get(link.seq);
        const candidate = hit && session && fingerprint(session, hit.call, hit.result) === link.fingerprint ? hit : null;
        return {
          ...ref(link, candidate !== null),
          command: candidate ? (raw ? candidate.command : safeCommand(candidate.command)) : null,
          result: candidate ? resultOf(candidate.result) : 'unknown',
          covers: link.covers === 1,
          afterRequirement: candidate !== null && acceptedAfter(requirement, revision.session_id === link.session_id, candidate),
        };
      });
      // 按挂入顺序，以最后一次人工标明覆盖的结果为准；新要求、新的未明结果或缺失的来源均不会沿用旧的绿色状态。
      const covering = evidence.find((entry) => entry.covers);
      const result = covering?.afterRequirement ? covering.result : 'unknown';
      return {
        id: revision.id,
        source: { ...ref(revision, requirement !== null), text: requirement ? safe(requirement.text) : '' },
        evidence,
        status: result === 'pass' ? 'verified' : result === 'fail' ? 'failed' : 'pending',
      };
    }),
  };
}

function currentRevision(store: Store): Entry | undefined {
  return store.db.prepare('SELECT * FROM acceptance_revisions ORDER BY id DESC LIMIT 1').get() as unknown as Entry | undefined;
}

/** 签入新需求时对照界面读到的当前版本，避免两个页面同时替换导致悄悄覆盖。 */
export function setAcceptanceRequirement(store: Store, sessionId: string, seq: number, expectedRevisionId: number | null): void {
  const head = currentRevision(store);
  if ((head?.id ?? null) !== expectedRevisionId) throw new AcceptanceError(409, '验收单刚刚更新，请刷新后再试');
  const source = store.getSession(sessionId);
  const user = source?.messages.find((m) => m.seq === seq && m.role === 'user');
  if (!source || !user) throw new AcceptanceError(404, '找不到这条用户消息');
  const signature = fingerprint(source, user);
  if (head?.session_id === sessionId && head.seq === seq && head.fingerprint === signature) return;
  const insert = store.db
    .prepare(`
    INSERT INTO acceptance_revisions(session_id, seq, agent, fingerprint)
    SELECT ?, ?, ?, ? WHERE (SELECT max(id) FROM acceptance_revisions) IS ?
  `)
    .run(sessionId, seq, source.agent, signature, expectedRevisionId);
  if (!insert.changes) throw new AcceptanceError(409, '验收单刚刚更新，请刷新后再试');
}

export function linkAcceptanceEvidence(store: Store, revisionId: number, sessionId: string, seq: number, covers: boolean): void {
  const head = currentRevision(store);
  if (head?.id !== revisionId) throw new AcceptanceError(409, '只能给当前要求挂证据，请刷新后再试');
  const session = store.getSession(sessionId);
  const candidate = session && candidates(session.messages).get(seq);
  if (!session || !candidate) throw new AcceptanceError(422, '找不到这条输出对应的单独测试命令');
  const signature = fingerprint(session, candidate.call, candidate.result);
  const upsert = store.db
    .prepare(`
    INSERT INTO acceptance_evidence(revision_id, session_id, seq, agent, fingerprint, covers)
    SELECT ?, ?, ?, ?, ?, ? WHERE (SELECT max(id) FROM acceptance_revisions) = ?
    ON CONFLICT(revision_id, session_id, seq)
    DO UPDATE SET fingerprint = excluded.fingerprint, covers = excluded.covers
  `)
    .run(revisionId, sessionId, seq, session.agent, signature, covers ? 1 : 0, revisionId);
  if (!upsert.changes) throw new AcceptanceError(409, '只能给当前要求挂证据，请刷新后再试');
}
