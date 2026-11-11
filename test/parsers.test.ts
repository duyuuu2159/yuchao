import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { parseClaudeFile } from '../src/core/parsers/claude.ts';
import { loadCodexTitles, parseCodexFile } from '../src/core/parsers/codex.ts';

const FIX = join(import.meta.dirname, 'fixtures');
const CLAUDE = join(FIX, 'claude/projects/G--demo');
const CODEX = join(FIX, 'codex/sessions/2026/11/01');
const C1 = join(CODEX, 'rollout-2026-11-01T09-00-00-c1.jsonl');
const C2 = join(CODEX, 'rollout-2026-11-01T09-30-00-c2.jsonl');

const roles = (s: { messages: { role: string }[] }) => s.messages.map((m) => m.role);

test('Claude：基本信息、标题取最后一次改名', async () => {
  const s = await parseClaudeFile(join(CLAUDE, 's1.jsonl'));
  assert.equal(s.id, 'claude:s1');
  assert.equal(s.title, 'nginx 502 排查');
  assert.equal(s.cwd, 'G:\\demo');
  assert.equal(s.parentId, null);
  assert.equal(s.startedAt, '2026-11-01T08:00:00.000Z');
  assert.equal(s.updatedAt, '2026-11-01T08:05:00.000Z');
});

test('Claude：区分用户输入、工具调用和注入的上下文，跳过坏行和空 thinking', async () => {
  const s = await parseClaudeFile(join(CLAUDE, 's1.jsonl'));
  assert.deepEqual(roles(s), ['user', 'assistant', 'tool_call', 'tool_result', 'context', 'context', 'assistant']);
  const call = s.messages[2];
  assert.equal(call.toolName, 'Bash');
  assert.match(call.text, /nginx -t/);
  assert.deepEqual(
    s.messages.map((m) => m.seq),
    [0, 1, 2, 3, 4, 5, 6],
  );
});

test('Claude：子 agent 会话挂到父会话下，没有标题时用首条消息', async () => {
  const s = await parseClaudeFile(join(CLAUDE, 's1/subagents/agent-abc.jsonl'));
  assert.equal(s.id, 'claude:s1/agent-abc');
  assert.equal(s.parentId, 'claude:s1');
  assert.equal(s.title, '搜索所有 location 块');
});

test('Codex：从 session_index 取标题，同一会话以最后一次为准', async () => {
  const titles = await loadCodexTitles(join(FIX, 'codex/session_index.jsonl'));
  const s = await parseCodexFile(C1, titles);
  assert.equal(s.id, 'codex:c1');
  assert.equal(s.title, '排查首页卡死');
  assert.equal(s.cwd, 'C:\\work\\site');
  assert.equal(s.archived, false);
});

test('Codex：提取真实请求、去掉图片标签，忽略系统提示词和加密推理', async () => {
  const s = await parseCodexFile(C1);
  assert.deepEqual(roles(s), [
    'context',
    'user',
    'tool_call',
    'tool_result',
    'tool_call',
    'tool_result',
    'tool_call',
    'context',
    'assistant',
  ]);
  assert.equal(s.messages[1].text, '首页卡死进不去');
  assert.equal(s.messages[5].text, 'active (running)');
  assert.equal(s.messages[6].toolName, 'web_search');
  assert.equal(s.title, '首页卡死进不去');
});

test('Codex：子 agent 只认第一条 session_meta', async () => {
  const s = await parseCodexFile(C2);
  assert.equal(s.id, 'codex:c2');
  assert.equal(s.parentId, 'codex:c1');
  assert.equal(s.cwd, 'C:\\work\\site');
  assert.equal(s.title, '子 agent · Erdos');
});

test('Codex：能直接读取 zstd 压缩的会话，结果与未压缩一致', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuchao-'));
  const zst = join(dir, 'archived_sessions', 'c1.jsonl.zst');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'archived_sessions'));
  writeFileSync(zst, zstdCompressSync(readFileSync(C1)));
  const plain = await parseCodexFile(C1);
  const packed = await parseCodexFile(zst);
  assert.deepEqual(packed.messages, plain.messages);
  assert.equal(packed.archived, true);
});

test('Claude：工作流里的子 agent（subagents 下面还有一层目录）也挂在父会话下', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuchao-wf-'));
  const { mkdirSync } = await import('node:fs');
  const p = join(dir, 'projects', 'G--demo', 'p1', 'subagents', 'workflows', 'wf_1');
  mkdirSync(p, { recursive: true });
  writeFileSync(
    join(p, 'agent-x.jsonl'),
    JSON.stringify({ type: 'user', timestamp: '2026-11-10T00:00:00Z', message: { content: '[Workflow harness — computed task] 做点事' } }) +
      '\n',
  );
  const s = await parseClaudeFile(join(p, 'agent-x.jsonl'));
  assert.equal(s.id, 'claude:p1/agent-x');
  assert.equal(s.parentId, 'claude:p1');
  assert.deepEqual(
    s.messages.map((m) => m.role),
    ['context'],
    '工作流的任务说明不是用户写的',
  );
});
