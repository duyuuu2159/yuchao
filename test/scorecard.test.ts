import assert from 'node:assert/strict';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseClaudeFile } from '../src/core/parsers/claude.ts';
import { parseCodexFile } from '../src/core/parsers/codex.ts';
import { parseWorkBuddyFile } from '../src/core/parsers/workbuddy.ts';
import { buildScorecard, detectHandoffs, judge, sessionSignals } from '../src/core/scorecard.ts';
import { Store } from '../src/core/store.ts';
import { claudeFailed, codexFailed, dshFailed, workbuddyFailed } from '../src/core/toolstatus.ts';
import type { Role } from '../src/core/types.ts';

const FIX = join(import.meta.dirname, 'fixtures');

// ---------------- 执行结果：用 agent 自己记录的，不在输出里找关键词 ----------------

test('执行结果：四家 agent 各自的写法', () => {
  assert.equal(claudeFailed({ is_error: true }, 'Exit code 1'), true);
  assert.equal(claudeFailed({ is_error: false }, 'ok'), false);
  assert.equal(claudeFailed({}, 'ok'), false, 'Claude 缺省 is_error 表示成功');

  assert.equal(codexFailed('Script failed\nWall time 1.0 seconds'), true);
  assert.equal(codexFailed('Script completed\nWall time 0.8 seconds\nOutput:\n'), false);
  assert.equal(codexFailed('Script completed\nOutput:\nExit code: 2'), true, '脚本跑完但里面的命令失败了');
  assert.equal(codexFailed('Exit code: 0\nWall time: 1 seconds'), false);
  assert.equal(codexFailed('Process exited with code 1'), true);
  assert.equal(codexFailed('{"message":"Wait timed out.","timed_out":true}'), null, '等待超时不是成败');
  assert.equal(codexFailed('Script running with cell ID 3'), null);

  assert.equal(workbuddyFailed('completed', 'Command completed with exit code 1'), true);
  assert.equal(workbuddyFailed('completed', 'Command completed with exit code 0'), false);
  assert.equal(workbuddyFailed('completed', 'file contents'), false);
  assert.equal(workbuddyFailed('incomplete', ''), true);
  assert.equal(workbuddyFailed('cancelled', ''), null, '用户取消不算 agent 失败');

  assert.equal(dshFailed({ isError: true }, 'Error: glob search failed'), true);
  assert.equal(dshFailed({ isError: false }, 'ok'), false);
});

test('执行结果：输出里有 error 字样但执行成功的，不算失败', () => {
  // 原来按关键词判断时，这几种都被当成了报错
  for (const out of ['except Exception as e:', '[stills] done: 3 ok, 0 failed', 'PASS 无控制台错误', '} catch (error) {']) {
    assert.equal(claudeFailed({}, out), false, out);
  }
});

test('执行结果：用户自己中断或拒绝的调用，不算 agent 失败', () => {
  assert.equal(claudeFailed({ is_error: true }, "The user doesn't want to proceed with this tool use."), null);
  assert.equal(dshFailed({ isError: true }, 'Error: the user cancelled ask_user_question'), null);
  assert.equal(dshFailed({ isError: true }, 'Error: tool call aborted'), null);
});

// ---------------- 用量 ----------------

test('用量：Claude 同一次回复的多个内容块只算一次，输入包括缓存', async () => {
  const s = await parseClaudeFile(join(FIX, 'claude', 'projects', 'G--demo', 's1.jsonl'));
  assert.deepEqual(s.usage, [{ model: 'claude-opus-5-5', requests: 1, input: 1000, output: 50, cacheRead: 700 }]);
});

test('用量：Codex 的累计值相减得到每次请求；重复出现的累计值不重复计算', async () => {
  const s = await parseCodexFile(join(FIX, 'codex', 'sessions', '2026', '11', '01', 'rollout-2026-11-01T09-00-00-c1.jsonl'));
  assert.deepEqual(s.usage, [{ model: 'gpt-6-astra', requests: 2, input: 2500, output: 100, cacheRead: 1800 }]);
});

test('用量：WorkBuddy 按 OpenAI 口径，输入已含缓存', async () => {
  const s = await parseWorkBuddyFile(join(FIX, 'workbuddy', 'projects', 'c-demo', 'wb1.jsonl'));
  assert.equal(s.usage[0].model, 'glm-5.2');
  // 样例里有两条回复，各 3000 输入、其中 2000 命中缓存
  assert.deepEqual(s.usage, [{ model: 'glm-5.2', requests: 2, input: 6000, output: 240, cacheRead: 4000 }]);
});

// ---------------- 成败判断 ----------------

let seq = 0;
const u = (text: string) => ({ seq: seq++, role: 'user' as Role, toolName: null, text });
const a = (text: string) => ({ seq: seq++, role: 'assistant' as Role, toolName: null, text });
const call = (toolName: string) => ({ seq: seq++, role: 'tool_call' as Role, toolName, text: '{}' });
const result = (failed: boolean | null, text = 'output') => ({ seq: seq++, role: 'tool_result' as Role, toolName: null, text, failed });

test('判断：一路顺利', () => {
  const sig = sessionSignals([u('帮我给博客加站内搜索'), call('Bash'), result(false), a('加好了'), u('好的')]);
  assert.deepEqual(judge(sig, false), { outcome: 'smooth', reasons: [] });
});

test('判断：agent 自己试错再修好，不算返工', () => {
  const sig = sessionSignals([
    u('把测试跑通'),
    call('Bash'),
    result(true, 'FAIL 2 tests'),
    call('Bash'),
    result(true, 'FAIL 1 test'),
    call('Bash'),
    result(false, 'PASS'),
    a('都通过了'),
  ]);
  assert.equal(sig.errors, 2);
  assert.equal(judge(sig, false).outcome, 'smooth');
});

test('判断：你说了「还是不行」是返工；换个说法又说一遍也是返工', () => {
  // 你说了不行，agent 接着改并且执行成功了：返工后完成（你没再回话不代表没解决）
  assert.equal(
    judge(sessionSignals([u('修一下首页 502'), a('改好了'), u('还是不行，一样 502'), call('Bash'), result(false), a('这次好了')]), false)
      .outcome,
    'rework',
  );
  // 你说了不行，之后 agent 什么都没做成：没解决
  assert.equal(
    judge(sessionSignals([u('修一下首页 502'), a('改好了'), u('还是不行，一样 502'), a('再看看')]), false).outcome,
    'unresolved',
  );
  const sig = sessionSignals([u('把首页的图片改成懒加载'), a('改好了'), u('首页的图片改成懒加载，下面的也要')]);
  assert.equal(sig.reAsks, 1);
  assert.equal(judge(sig, false).outcome, 'rework');
});

test('判断：恰好包含在之前长句里的短话不算重说', () => {
  const sig = sessionSignals([u('我的 claude desktop 没有 sonnet 和 haiku 模型，帮我搞一下'), a('装好了'), u('没有'), u('继续继续')]);
  assert.equal(sig.reAsks, 0);
});

test('判断：一字不差地重发和「Try again」是重试（接口问题），不算返工', () => {
  const sig = sessionSignals([u('帮我写一个 SVG 动画'), u('帮我写一个 SVG 动画'), u('Try again'), u('请再试一次'), a('写好了')]);
  assert.equal(sig.retries, 3);
  assert.equal(sig.reAsks, 0);
  assert.equal(judge(sig, false).outcome, 'smooth');
});

test('判断：最后一次执行命令失败是没解决；查询类工具失败、用户中断都不算', () => {
  assert.equal(
    judge(sessionSignals([u('部署上线'), call('Bash'), result(true, 'ssh: connect refused'), a('连不上服务器')]), false).outcome,
    'unresolved',
  );
  assert.equal(
    judge(sessionSignals([u('查一下配置'), call('glob'), result(true, 'no match'), a('没找到，换个地方看了，配置在这里')]), false).outcome,
    'smooth',
  );
  assert.equal(judge(sessionSignals([u('部署上线'), call('Bash'), result(null, 'user cancelled')]), false).outcome, 'smooth');
  // 最后失败了，但你随后说了「好了」：问题已经在别处解决
  assert.equal(
    judge(sessionSignals([u('部署上线'), call('Bash'), result(true, 'warning'), u('好了，我手动弄好了')]), false).outcome,
    'smooth',
  );
});

test('判断：你最后一句在说不行、或者之后换了别的 agent 接着做，是没解决', () => {
  assert.equal(judge(sessionSignals([u('修一下登录'), a('改好了'), u('还是不行，算了')]), false).outcome, 'unresolved');
  const { outcome, reasons } = judge(sessionSignals([u('修一下登录'), a('改好了')]), true);
  assert.equal(outcome, 'unresolved');
  assert.deepEqual(reasons, ['之后换了别的 agent 接着做']);
});

// ---------------- 接力 ----------------

const sess = (id: string, agent: 'claude' | 'codex' | 'workbuddy', start: string, end: string, firstAsk: string, title = id) => ({
  id,
  agent,
  title,
  startedAt: start,
  updatedAt: end,
  firstAsk,
});

test('接力：以鱼巢的交接说明开头的会话，能找到它接手的那个', () => {
  const m = detectHandoffs([
    sess('c1', 'claude', '2026-11-01T08:00:00Z', '2026-11-01T09:00:00Z', '博客部署后 502', '博客上线后一直 502'),
    sess(
      'x1',
      'codex',
      '2026-11-02T10:00:00Z',
      '2026-11-02T11:00:00Z',
      '# 接力：博客上线后一直 502\n\n我之前在 Claude Code 里做这件事，现在想换你接着做。',
    ),
  ]);
  assert.equal(m.get('c1'), 'x1');
});

test('接力：结束后 12 小时内，在另一个 agent 里问了几乎同样的问题', () => {
  const ask = '服务器上的 nginx 一直返回 502，帮我看看 upstream 的配置';
  const m = detectHandoffs([
    sess('c1', 'claude', '2026-11-01T08:00:00Z', '2026-11-01T09:00:00Z', ask),
    sess('x1', 'codex', '2026-11-01T10:00:00Z', '2026-11-01T11:00:00Z', ask + '，之前没修好'),
    // 在同一个 agent 里再问不算接力（x2 和 x1 都是 Codex）；隔了两天也不算
    sess('x2', 'codex', '2026-11-01T12:00:00Z', '2026-11-01T13:00:00Z', ask),
    sess('w1', 'workbuddy', '2026-11-04T10:00:00Z', '2026-11-04T11:00:00Z', ask),
  ]);
  assert.deepEqual([...m], [['c1', 'x1']]);
});

// ---------------- 汇总 ----------------

test('成绩单：按 agent 和模型汇总，子 agent 的用量算进主会话', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuchao-score-'));
  cpSync(FIX, root, { recursive: true });
  const store = new Store(':memory:');
  await store.index({ claude: join(root, 'claude'), codex: join(root, 'codex'), workbuddy: join(root, 'workbuddy') });
  const sc = buildScorecard(store);

  assert.deepEqual(sc.byAgent.map((r) => r.key).sort(), ['claude', 'codex', 'workbuddy']);
  const claude = sc.byAgent.find((r) => r.key === 'claude')!;
  assert.equal(claude.sessions, 1, '子 agent 不单独算一个会话');
  assert.equal(claude.smooth + claude.rework + claude.unresolved, claude.sessions);
  assert.ok(sc.byModel.some((r) => r.key === 'gpt-6-astra' && r.output === 100));
  for (const s of sc.sessions) assert.ok(s.signals.turns > 0, '你一句话都没说的会话不参与统计');
});
