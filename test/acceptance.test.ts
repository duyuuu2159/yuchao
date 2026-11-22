import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type AcceptanceDocument,
  acceptanceDocument,
  acceptanceEvidenceSeqs,
  linkAcceptanceEvidence,
  setAcceptanceRequirement,
} from '../src/core/acceptance.ts';
import { PARSER_VERSION, Store } from '../src/core/store.ts';
import type { AgentKind, Role } from '../src/core/types.ts';
import { createApp } from '../src/server/main.ts';

const PW = 'Tq8vLm2Xz9';
const ASK = '导出全部记录';
const REVISED = `只导出失败记录。测试服务器密码 ${PW}`;
const PASS = 'ℹ tests 2\nℹ pass 2\nℹ fail 0';
const FAIL = 'ℹ tests 2\nℹ pass 1\nℹ fail 1';

function fixture(store: Store) {
  const session = store.db.prepare(`
    INSERT INTO sessions(id, agent, native_id, cwd, source_path)
    VALUES (?, ?, ?, '/repo', '/synthetic')
  `);
  const message = store.db.prepare(`
    INSERT INTO messages(session_id, seq, ts, role, tool_name, text, failed)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const add = (agent: AgentKind) => {
    const id = `${agent}:fixture`;
    session.run(id, agent, 'fixture');
    let seq = 0;
    const m = (minute: number | null, role: Role, text: string, tool: string | null = null, failed: number | null = null) =>
      message.run(id, seq++, minute === null ? null : new Date(Date.UTC(2026, 10, 22, 9, minute)).toISOString(), role, tool, text, failed);
    return {
      id,
      user: (at: number, text: string) => m(at, 'user', text),
      cmd: (at: number | null, command: string) => m(at, 'tool_call', JSON.stringify({ command }), agent === 'claude' ? 'Bash' : 'shell'),
      out: (at: number, output: string, failed = 0) => m(at, 'tool_result', output, null, failed),
    };
  };
  const claude = add('claude');
  claude.user(1, ASK); // 0
  claude.cmd(2, 'npm test'); // 1
  claude.out(3, 'ℹ tests 37\nℹ pass 37\nℹ fail 0'); // 2
  claude.user(4, REVISED); // 3
  const codex = add('codex');
  codex.cmd(5, 'npm.cmd test -- --grep csv-format');
  codex.out(6, PASS); // 1
  codex.cmd(7, `npm test -- --grep export-failed --password=${PW}`);
  codex.out(8, PASS); // 3
  return { claude, codex };
}

test('协作验收单：旧需求的 37 项证据不继承，跨 Agent 的格式测试不等于覆盖新要求', () => {
  const store = new Store(':memory:');
  try {
    const { claude, codex } = fixture(store);
    assert.deepEqual(acceptanceDocument(store), { revisions: [] });
    setAcceptanceRequirement(store, claude.id, 0, null);
    linkAcceptanceEvidence(store, 1, claude.id, 2, true);
    assert.equal(acceptanceDocument(store).revisions[0].status, 'verified');
    setAcceptanceRequirement(store, claude.id, 3, 1);
    assert.deepEqual(
      acceptanceDocument(store).revisions.map(({ status, evidence }) => [status, evidence.length]),
      [
        ['pending', 0],
        ['verified', 1],
      ],
    );
    assert.throws(() => linkAcceptanceEvidence(store, 1, codex.id, 1, true), /只能给当前要求挂证据/);
    linkAcceptanceEvidence(store, 2, claude.id, 2, true);
    assert.equal(acceptanceDocument(store).revisions[0].evidence[0].afterRequirement, false);
    linkAcceptanceEvidence(store, 2, codex.id, 1, false);
    let current = acceptanceDocument(store).revisions[0];
    assert.equal(current.status, 'pending');
    assert.equal(current.evidence[0].result, 'pass');
    assert.equal(current.evidence[0].covers, false);
    linkAcceptanceEvidence(store, 2, codex.id, 3, true);
    current = acceptanceDocument(store).revisions[0];
    assert.equal(current.status, 'verified');
    assert.equal(current.evidence[0].agent, 'codex');
    assert.equal(current.evidence[0].afterRequirement, true);
    assert.ok(!JSON.stringify(current).includes(PW));
    assert.ok(JSON.stringify(acceptanceDocument(store, true)).includes(PW));
    linkAcceptanceEvidence(store, 2, codex.id, 3, false);
    assert.equal(acceptanceDocument(store).revisions[0].status, 'pending');
    setAcceptanceRequirement(store, claude.id, 3, 2);
    assert.equal(acceptanceDocument(store).revisions.length, 2, '重复选择同一条消息不会再创建一版');
  } finally {
    store.close();
  }
});

test('只挂单独、紧邻的测试命令；缺汇总、取消、零项、截断、覆盖后失败都不冒充通过', () => {
  const store = new Store(':memory:');
  try {
    const { claude, codex } = fixture(store);
    codex.cmd(11, 'npm test && echo pass');
    codex.out(12, PASS); // 5：复合命令
    codex.cmd(13, 'npm test');
    codex.cmd(14, 'ls');
    codex.out(15, PASS); // 8：并发配对不确定
    codex.out(16, 'list contents');
    codex.cmd(17, 'npm tester');
    codex.out(18, PASS); // 11：不是测试脚本
    codex.cmd(19, 'npm test');
    codex.out(20, 'command exited 0'); // 13
    codex.cmd(21, 'npm test');
    codex.out(22, 'ℹ pass 0\nℹ fail 0'); // 15
    codex.cmd(23, 'npm test');
    codex.out(24, PASS + '…[截断，原长 3000]'); // 17
    codex.cmd(25, 'npm test');
    codex.out(26, PASS + '\nuser canceled'); // 19
    codex.cmd(27, 'npm test');
    codex.out(28, PASS, 1); // 21：工具状态与汇总冲突
    codex.cmd(29, 'npm test');
    codex.out(30, FAIL, 1); // 23
    codex.cmd(null, 'npm test');
    codex.out(32, PASS); // 25：跨会话时间不详
    codex.cmd(33, 'npm test');
    codex.out(34, PASS + '\nℹ skipped 1'); // 27
    codex.cmd(35, 'npm test');
    codex.out(36, 'runner not found', 1); // 29：执行失败不等于测试失败
    assert.deepEqual(acceptanceEvidenceSeqs(store.getSession(codex.id)!.messages), [1, 3, 13, 15, 17, 19, 21, 23, 25, 27, 29]);
    setAcceptanceRequirement(store, claude.id, 3, null);
    for (const seq of [5, 8, 11]) assert.throws(() => linkAcceptanceEvidence(store, 1, codex.id, seq, true), /单独测试命令/);
    linkAcceptanceEvidence(store, 1, codex.id, 3, true);
    assert.equal(acceptanceDocument(store).revisions[0].status, 'verified');
    for (const seq of [13, 15, 17, 19, 21, 27, 29]) {
      linkAcceptanceEvidence(store, 1, codex.id, seq, true);
      assert.equal(acceptanceDocument(store).revisions[0].status, 'pending', `输出 #${seq}`);
    }
    linkAcceptanceEvidence(store, 1, codex.id, 23, true);
    assert.equal(acceptanceDocument(store).revisions[0].status, 'failed');
    linkAcceptanceEvidence(store, 1, codex.id, 25, true);
    const [head] = acceptanceDocument(store).revisions;
    assert.equal(head.status, 'pending');
    assert.equal(head.evidence[0].result, 'pass');
    assert.equal(head.evidence[0].afterRequirement, false);
  } finally {
    store.close();
  }
});

test('验收定位可重启保留；改写消息、索引重建不能让旧证据误指', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuchao-acceptance-'));
  const db = join(dir, 'check.sqlite');
  let store = new Store(db);
  try {
    const { claude, codex } = fixture(store);
    setAcceptanceRequirement(store, claude.id, 3, null);
    linkAcceptanceEvidence(store, 1, codex.id, 3, true);
    const original = acceptanceDocument(store);
    assert.equal(original.revisions[0].status, 'verified');
    store.close();
    store = new Store(db);
    assert.deepEqual(acceptanceDocument(store), original);
    store.db.prepare('UPDATE messages SET failed = 1 WHERE session_id = ? AND seq = 3').run(codex.id);
    let [current] = acceptanceDocument(store).revisions;
    assert.equal(current.status, 'pending');
    assert.equal(current.evidence[0].available, false);
    assert.equal(current.evidence[0].command, null);
    store.db.prepare('UPDATE messages SET ts = NULL WHERE session_id = ? AND seq = 3').run(claude.id);
    [current] = acceptanceDocument(store).revisions;
    assert.equal(current.source.available, false);
    assert.equal(current.source.text, '');
    store.db.exec(`PRAGMA user_version = ${PARSER_VERSION - 1}`);
    store.close();
    store = new Store(db);
    [current] = acceptanceDocument(store).revisions;
    assert.equal(store.getSession(claude.id), null);
    assert.equal(current.evidence.length, 1, '手动纪录不会随索引清空');
    assert.equal(current.status, 'pending');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('验收 HTTP 接口使用既有写保护、参数校验和默认打码，并给会话返回可挂证据的位置', async () => {
  const store = new Store(':memory:');
  const { claude, codex } = fixture(store);
  const server = createServer(createApp(store, {}));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const req = (path: string, init?: RequestInit) => fetch(base + '/api/acceptance' + path, init);
  const body = (o: unknown) => ({
    method: 'POST',
    headers: { 'x-yuchao': '1', 'content-type': 'application/json' },
    body: JSON.stringify(o),
  });
  try {
    const initial = await req('');
    assert.equal(initial.status, 200);
    assert.equal(initial.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await initial.json(), { revisions: [] });
    assert.equal((await req('/requirement', { method: 'POST' })).status, 403);
    assert.equal((await req('/requirement', { ...body({}), headers: { 'x-yuchao': '1' } })).status, 415);
    assert.equal((await req('/requirement', { ...body({}), body: 'broken' })).status, 400);
    assert.equal((await req('/requirement', { ...body({}), body: ' '.repeat(5000) })).status, 413);
    assert.equal((await req('/requirement', body([1, 2]))).status, 400);
    assert.equal((await req('/requirement', body({ sessionId: claude.id, seq: -1 }))).status, 400);
    const requirement = { sessionId: claude.id, seq: 3, expectedRevisionId: null };
    assert.equal((await req('/requirement', body({ sessionId: claude.id, seq: 3 }))).status, 400);
    assert.equal((await req('/requirement', body({ ...requirement, seq: 1 }))).status, 404);
    assert.equal((await req('/requirement', body(requirement))).status, 200);
    assert.equal((await req('/requirement', body(requirement))).status, 409);
    const link = { revisionId: 1, sessionId: codex.id, seq: 3, covers: true };
    assert.equal((await req('/evidence', body({ ...link, covers: 'true' }))).status, 400);
    assert.equal((await req('/evidence', body({ ...link, revisionId: 9 }))).status, 409);
    assert.equal((await req('/evidence', body({ ...link, seq: 0 }))).status, 422);
    const added = await req('/evidence', body(link));
    assert.equal(added.status, 200);
    const result = (await added.json()) as AcceptanceDocument;
    assert.equal(result.revisions[0].status, 'verified');
    assert.ok(!JSON.stringify(result).includes(PW));
    assert.ok((await (await req('?raw=1')).text()).includes(PW));
    const session = await fetch(base + '/api/sessions/' + encodeURIComponent(codex.id));
    const detail = (await session.json()) as { acceptanceEvidenceSeqs: number[] };
    assert.deepEqual(detail.acceptanceEvidenceSeqs, [1, 3]);
  } finally {
    server.close();
    store.close();
  }
});
