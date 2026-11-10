import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandOf, errorOf, estimateTokens, extractFacts, filesTouched, renderHandoff } from '../src/core/handoff.ts';
import { redact } from '../src/core/scan.ts';

type M = { seq: number; ts: string | null; role: any; toolName: string | null; text: string };
let seq = 0;
const m = (role: string, text: string, toolName: string | null = null): M => ({ seq: seq++, ts: '2026-11-09T08:00:00Z', role, toolName, text });

const PW = 'Tq8v' + 'Lm2Xz9Q';
const session = {
  id: 'claude:s1',
  agent: 'claude',
  title: '修复登录页',
  cwd: 'G:\\demo',
  startedAt: '2026-11-09T08:00:00Z',
  updatedAt: '2026-11-09T09:00:00Z',
  messages: [
    m('user', '登录页点了没反应，帮我修一下'),
    m('assistant', '我先看看代码。'),
    m('tool_call', JSON.stringify({ file_path: 'G:\\demo\\src\\login.ts' }), 'Read'),
    m('tool_result', '12  // 登录失败时显示提示'),
    m('tool_call', JSON.stringify({ file_path: 'G:\\demo\\src\\login.ts', old_string: 'a', new_string: 'b' }), 'Edit'),
    m('tool_call', JSON.stringify({ command: 'npm test' }), 'Bash'),
    m('tool_result', '> test\nError: expected 200, got 500\n    at login.test.ts:9'),
    m('user', '继续'),
    m('user', '继续'),
    m('user', `顺便把数据库密码 ${PW} 换成环境变量`),
    m('tool_call', '*** Begin Patch\n*** Update File: src/db.ts\n@@\n-a\n+b\n*** End Patch', 'apply_patch'),
    m('assistant', '已经改好了，测试还剩一个失败，原因是会话过期时间写错了。'),
  ],
};

test('提取文件：Edit/Write 的 file_path、apply_patch 里的文件，读文件不算改动；JSON 被截断也能取到', () => {
  assert.deepEqual(filesTouched('Edit', '{"file_path":"C:\\\\a\\\\b.ts","old_string":"x'), ['C:\\a\\b.ts']);
  assert.deepEqual(filesTouched('Read', '{"file_path":"x.ts"}'), []);
  assert.deepEqual(filesTouched('exec', 'tools.apply_patch("*** Begin Patch\\n*** Add File: web/a.css\\n+x")'), ['web/a.css']);
});

test('提取命令：只认执行命令的工具，长命令只留前几行', () => {
  assert.equal(commandOf('Bash', '{"command":"npm test"}'), 'npm test');
  assert.equal(commandOf('exec_command', '{"cmd":"git status"}'), 'git status');
  assert.equal(commandOf('Read', '{"command":"x"}'), null);
  assert.match(commandOf('Bash', JSON.stringify({ command: 'a\nb\nc\nd\ne' }))!, /^a\nb\nc\n…$/);
});

test('报错：只取有报错字样的那一行', () => {
  assert.equal(errorOf('> test\nError: expected 200, got 500\n  at x'), 'Error: expected 200, got 500');
  assert.equal(errorOf('all good'), null);
});

test('交接要点：目标、补充要求（去掉「继续」和重复）、改过的文件按最近排、命令、报错、最后的回复', () => {
  const f = extractFacts(session);
  assert.equal(f.goal, '登录页点了没反应，帮我修一下');
  assert.deepEqual(f.recentAsks, [`顺便把数据库密码 ${PW} 换成环境变量`]);
  assert.deepEqual(f.files, [
    { path: 'src/db.ts', edits: 1 },
    { path: 'src/login.ts', edits: 1 },
  ]);
  assert.deepEqual(f.commands, ['npm test']);
  assert.deepEqual(f.errors, ['Error: expected 200, got 500'], '读文件结果里的「失败」不算报错');
  assert.equal(f.userMessages, 4);
  assert.equal(f.toolCalls, 4);
  assert.match(f.lastReply!, /会话过期时间/);
});

test('生成的说明：写明来源和接手的 agent，打码后不含原文密码', () => {
  const md = redact(renderHandoff(extractFacts(session), 'codex'));
  assert.match(md, /^# 接力：修复登录页/);
  assert.match(md, /我之前在 Claude Code 里做这件事，现在想换你（Codex）接着做/);
  assert.match(md, /AGENTS\.md/);
  assert.match(md, /## 改过的文件/);
  assert.ok(!md.includes(PW));
});

test('超出长度预算时逐级缩短，但标题和目标始终保留', () => {
  const long = { ...session, messages: [...session.messages, m('assistant', '很长的回复'.repeat(2000))] };
  const full = renderHandoff(extractFacts(long), undefined, 100000);
  const short = renderHandoff(extractFacts(long), undefined, 1500);
  assert.ok(short.length < full.length);
  assert.match(short, /## 最初的目标/);
});

test('token 估算：中文按字，英文按 4 个字符', () => {
  assert.equal(estimateTokens('鱼巢'), 2);
  assert.equal(estimateTokens('abcdefgh'), 2);
});

test('Write 写入的内容里碰巧有补丁格式的文字，不算改了那些文件', () => {
  const text = JSON.stringify({ file_path: 'test/a.test.ts', content: '*** Update File: src/db.ts\n' });
  assert.deepEqual(filesTouched('Write', text), ['test/a.test.ts']);
});
