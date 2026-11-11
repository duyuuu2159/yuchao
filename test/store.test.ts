import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, cpSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SourceDirs } from '../src/core/sources.ts';
import { makeSnippet, Store } from '../src/core/store.ts';

const FIX = join(import.meta.dirname, 'fixtures');

/** 把样例复制到临时目录，测试可以随意修改文件 */
function setup(): { dirs: SourceDirs; store: Store } {
  const root = mkdtempSync(join(tmpdir(), 'yuchao-store-'));
  cpSync(FIX, root, { recursive: true });
  return { dirs: { claude: join(root, 'claude'), codex: join(root, 'codex') }, store: new Store(':memory:') };
}

const C1 = 'codex/sessions/2026/11/01/rollout-2026-11-01T09-00-00-c1.jsonl';

test('首次索引收录全部会话', async () => {
  const { dirs, store } = setup();
  const r = await store.index(dirs);
  assert.equal(r.scanned, 4);
  assert.equal(r.indexed, 4);
  assert.deepEqual(r.errors, []);
  const ids = store
    .listSessions({ includeSubagents: true })
    .map((s) => s.id)
    .sort();
  assert.deepEqual(ids, ['claude:s1', 'claude:s1/agent-abc', 'codex:c1', 'codex:c2']);
});

test('默认列表隐藏子 agent，详情里能看到子会话', async () => {
  const { dirs, store } = setup();
  await store.index(dirs);
  assert.deepEqual(
    store
      .listSessions()
      .map((s) => s.id)
      .sort(),
    ['claude:s1', 'codex:c1'],
  );
  const detail = store.getSession('claude:s1')!;
  assert.equal(detail.messages.length, 7);
  assert.deepEqual(
    detail.children.map((c) => c.id),
    ['claude:s1/agent-abc'],
  );
});

test('文件没变时第二次索引全部跳过', async () => {
  const { dirs, store } = setup();
  await store.index(dirs);
  const r = await store.index(dirs);
  assert.equal(r.indexed, 0);
  assert.equal(r.skipped, 4);
});

test('文件追加内容后只重建这一个会话，且不会产生重复消息', async () => {
  const { dirs, store } = setup();
  await store.index(dirs);
  const path = join(dirs.codex!, '..', C1);
  appendFileSync(
    path,
    JSON.stringify({
      timestamp: '2026-11-01T10:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '顺便部署到线上' }] },
    }) + '\n',
  );
  utimesSync(path, new Date(), new Date());
  const r = await store.index(dirs);
  assert.equal(r.indexed, 1);
  assert.equal(store.search('部署到线上').length, 1);
  assert.equal(store.search('首页卡死').length, 1);
});

test('文件被删除后，对应会话和搜索结果一起清掉', async () => {
  const { dirs, store } = setup();
  await store.index(dirs);
  rmSync(join(dirs.codex!, '..', C1));
  const r = await store.index(dirs);
  assert.equal(r.removed, 1);
  assert.equal(store.getSession('codex:c1'), null);
  assert.equal(store.search('首页卡死').length, 0);
});

test('中文搜索：三字以上走全文索引，两字词也能搜到', async () => {
  const { dirs, store } = setup();
  await store.index(dirs);
  assert.deepEqual(
    store.search('上游服务').map((h) => h.sessionId),
    ['claude:s1'],
  );
  assert.deepEqual(
    store.search('回滚').map((h) => h.sessionId),
    ['claude:s1'],
  );
  // 多个词需要同时出现在同一条消息里
  assert.equal(store.search('回滚 上游服务').length, 1);
  assert.equal(store.search('回滚 首页').length, 0);
});

test('搜索默认只看对话，可以指定搜工具调用；可按 agent 过滤', async () => {
  const { dirs, store } = setup();
  await store.index(dirs);
  assert.equal(store.search('nginx -t').length, 0);
  const hits = store.search('nginx -t', { roles: ['tool_call'] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].toolName, 'Bash');
  assert.equal(store.search('nginx', { agent: 'codex' }).length, 0);
  assert.ok(store.search('nginx', { agent: 'claude' }).length > 0);
});

test('分叉会话复制的历史在搜索结果里只出现一次', async () => {
  const { dirs, store } = setup();
  const proj = join(dirs.claude!, 'projects', 'G--demo');
  copyFileSync(join(proj, 's1.jsonl'), join(proj, 's1-fork.jsonl'));
  appendFileSync(
    join(proj, 's1-fork.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: '分叉后继续回滚' }, timestamp: '2026-11-02T00:00:00.000Z' }) + '\n',
  );
  await store.index(dirs);
  const hits = store.search('回滚');
  assert.equal(hits.length, 2);
  assert.equal(hits[0].sessionId, 'claude:s1-fork');
  assert.equal(hits[0].alsoIn, 0);
  assert.equal(hits[1].alsoIn, 1);
});

test('搜索词里的特殊字符不会破坏查询', async () => {
  const { dirs, store } = setup();
  await store.index(dirs);
  for (const q of ['"', '100%', 'a_b', 'NEAR(', '* OR 1']) assert.doesNotThrow(() => store.search(q));
});

test('解析器版本变化后，已有索引会被清空并重建', async () => {
  const { dirs } = setup();
  const dbPath = join(mkdtempSync(join(tmpdir(), 'yuchao-db-')), 'index.db');
  const a = new Store(dbPath);
  await a.index(dirs);
  a.db.exec('PRAGMA user_version = 0');
  a.close();
  const b = new Store(dbPath);
  assert.equal(b.listSessions().length, 0);
  assert.equal((await b.index(dirs)).indexed, 4);
  b.close();
});

test('摘要截取命中位置附近的文字', () => {
  const text = 'x'.repeat(200) + '关键字' + 'y'.repeat(200);
  const s = makeSnippet(text, ['关键字'], 10);
  assert.equal(s, '…' + 'x'.repeat(10) + '关键字' + 'y'.repeat(7) + '…');
});
