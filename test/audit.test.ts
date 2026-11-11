import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { audit, ignoreFinding, unignoreFinding } from '../src/core/audit.ts';
import { Store } from '../src/core/store.ts';

const FIX = join(import.meta.dirname, 'fixtures');
const PW = 'Tq8vLm2Xz9';

/** 在样例会话里埋几处秘密：一个 Codex 会话的标题、一条 Claude 用户消息、一条工具调用 */
async function setup(beforeIndex?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'yuchao-audit-'));
  cpSync(FIX, root, { recursive: true });
  appendFileSync(
    join(root, 'codex/session_index.jsonl'),
    JSON.stringify({ id: 'c1', thread_name: `服务器 203.0.113.7 root 密码 ${PW}` }) + '\n',
  );
  const s1 = join(root, 'claude/projects/G--demo/s1.jsonl');
  appendFileSync(
    s1,
    JSON.stringify({ type: 'user', message: { role: 'user', content: `还是连不上，密码 ${PW}` }, timestamp: '2026-11-03T00:00:00.000Z' }) +
      '\n',
  );
  appendFileSync(
    s1,
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', input: { command: `sshpass -p '${PW}' ssh root@203.0.113.7 uptime` } }],
      },
      timestamp: '2026-11-03T00:01:00.000Z',
    }) + '\n',
  );
  appendFileSync(
    s1,
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '数据库 password=Hk3nWq7pZr2' },
      timestamp: '2026-11-03T00:02:00.000Z',
    }) + '\n',
  );
  beforeIndex?.(root);
  const store = new Store(':memory:');
  await store.index({ claude: join(root, 'claude'), codex: join(root, 'codex') });
  return store;
}

test('同一个密码出现在标题、消息、工具调用里，归为一条高风险发现', async () => {
  const store = await setup();
  const r = audit(store);
  assert.equal(r.findings.length, 2);
  const [server, db] = r.findings;
  assert.equal(server.severity, 'high');
  assert.equal(server.count, 3);
  assert.equal(server.sessionCount, 2);
  assert.deepEqual(server.occurrences.map((o) => o.where).sort(), ['title', 'tool_call:Bash', 'user']);
  assert.equal(db.ruleId, 'password');
  assert.equal(db.severity, 'medium');
});

test('报告里任何地方都不出现原文，包括含有密码的会话标题', async () => {
  const store = await setup();
  const json = JSON.stringify(audit(store));
  assert.ok(!json.includes(PW));
  assert.ok(!json.includes('Hk3nWq7pZr2'));
  assert.match(json, /Tq\*+z9/);
});

test('标记误报后不再报告，取消后恢复；重建索引后标记仍然保留', async () => {
  const store = await setup();
  const fp = audit(store).findings[1].fingerprint;
  ignoreFinding(store, fp);
  const r = audit(store);
  assert.equal(r.findings.length, 1);
  assert.equal(r.ignored, 1);
  assert.equal(audit(store, { includeIgnored: true }).findings.length, 2);

  store.db.exec('DELETE FROM files; DELETE FROM messages; DELETE FROM sessions;');
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM scan_ignores').get() as any).n, 1);

  unignoreFinding(store, fp);
  assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM scan_ignores').get() as any).n, 0);
});

test('出现位置优先展示不同会话，便于看出秘密散布的范围', async () => {
  const store = await setup();
  const [server] = audit(store).findings;
  const firstTwo = server.occurrences.slice(0, 2).map((o) => o.sessionId);
  assert.equal(new Set(firstTwo).size, 2);
});

test('分叉会话复制的同一条消息只算一次', async () => {
  const plain = audit(await setup()).findings[0];
  const forked = audit(
    await setup((root) => {
      const dir = join(root, 'claude/projects/G--demo');
      copyFileSync(join(dir, 's1.jsonl'), join(dir, 's1-fork.jsonl'));
    }),
  ).findings[0];
  assert.equal(forked.count, plain.count);
});
