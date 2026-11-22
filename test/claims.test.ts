import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { auditClaims, claimIn, testFailed } from '../src/core/claims.ts';
import { checkStop, guardInstalled, installGuard, isGuardCommand, uninstallGuard } from '../src/core/guard.ts';
import { commandsOf, isShellCall, PendingCalls } from '../src/core/tools.ts';
import type { Role } from '../src/core/types.ts';

/** 反斜杠：用字符码拼出来，避免测试源码里的转义写错 */
const B = String.fromCharCode(92);

let seq = 0;
const u = (text: string) => ({ seq: seq++, role: 'user' as Role, toolName: null, text });
const a = (text: string) => ({ seq: seq++, role: 'assistant' as Role, toolName: null, text });
const bash = (command: string) => ({ seq: seq++, role: 'tool_call' as Role, toolName: 'Bash', text: JSON.stringify({ command }) });
const edit = (file_path: string) => ({
  seq: seq++,
  role: 'tool_call' as Role,
  toolName: 'Edit',
  text: JSON.stringify({ file_path, old_string: 'a' }),
});
const out = (failed: boolean | null, text = 'ok') => ({ seq: seq++, role: 'tool_result' as Role, toolName: null, text, failed });
const verdicts = (msgs: Parameters<typeof auditClaims>[0]) => auditClaims(msgs).map((c) => c.verdict);

// ---------------- 读懂工具调用 ----------------

test('Codex 的 exec 脚本：取出里面每一条 exec_command 的完整命令', () => {
  const script = `const r = await tools.exec_command({cmd:"npm test -- --grep ${B}"a b${B}""});\ntext(await tools.exec_command({ cmd: 'node --test' }));`;
  assert.deepEqual(commandsOf('exec', script), ['npm test -- --grep "a b"', 'node --test']);
  assert.deepEqual(commandsOf('exec', 'await tools.mcp__node_repl__js({code:`1`})'), [], '只调用浏览器的脚本不算执行命令');
  // 交接说明里只显示前几行，这里要完整：agent 常把 node --test 放在多行命令的最后
  const long = 'cat > a.ts <<END\nx\ny\nz\nEND\nnode --test';
  assert.deepEqual(commandsOf('Bash', JSON.stringify({ command: long })), [long]);
  assert.deepEqual(commandsOf('Read', JSON.stringify({ command: 'x' })), []);
});

test('旧版 Codex 的 shell 工具：命令写成数组；参数被截断也算执行命令', () => {
  assert.deepEqual(commandsOf('shell', JSON.stringify({ command: ['bash', '-lc', 'npm test'] })), ['npm test']);
  assert.deepEqual(commandsOf('shell', JSON.stringify({ command: ['curl', '-I', 'https://example.com'] })), [
    'curl -I https://example.com',
  ]);
  assert.ok(isShellCall('shell', '{"command":["ba'), '截断的参数取不出命令，但工具名就是执行命令');
  assert.ok(!isShellCall('Read', '{"file_path":"a.ts"}'));
});

test('调用和结果按顺序对上；没等到结果的调用，在下一批调用开始时丢掉', () => {
  const p = new PendingCalls<string>();
  p.call('write');
  p.call('pwsh');
  assert.equal(p.result(), 'write', '并行的两个调用，第一个结果属于第一个调用');
  assert.equal(p.result(), 'pwsh');
  p.call('a');
  p.call('b');
  p.result();
  p.call('c'); // 新的一批开始，b 没等到结果（会话被打断）
  assert.equal(p.result(), 'c');
});

// ---------------- 哪句话算「说测试通过了」 ----------------

test('认得出说测试通过；计划、否定、「试用通过」不算', () => {
  assert.equal(claimIn('改好了。37 个测试全部通过，可以提交了'), '37 个测试全部通过，可以提交了');
  assert.equal(claimIn('All 105 tests pass. Committing.'), 'All 105 tests pass');
  assert.equal(claimIn('改完我会跑一遍，确保测试通过'), null);
  assert.equal(claimIn('不要把测试通过说成实景位置已准确'), null);
  assert.equal(claimIn('测试通过只说明模型内部可走，不能证明布局正确'), null);
  assert.equal(claimIn('Sonnet Key 已验证可用'), null);
});

test('测试过没过：看测试工具自己的汇总，其次才看整条命令的退出码', () => {
  // 类型检查 && 测试 && 真实数据检查：最后一步失败了，测试本身是通过的
  assert.equal(testFailed('ℹ tests 7\nℹ pass 7\nℹ fail 0\nError: ENOENT', true), false);
  assert.equal(testFailed('Tests:       1 failed, 9 passed, 10 total', false), true, '测试失败但用了管道，退出码是 0');
  assert.equal(testFailed('===== 12 passed in 0.4s =====', null), false);
  assert.equal(testFailed('test result: FAILED. 3 passed; 1 failed', false), true);
  assert.equal(testFailed('ℹ tests 143', true), true, '「ℹ tests 143」是总数；看不出成败时用退出码');
  assert.equal(testFailed('no summary here', null), null);
});

// ---------------- 核对 ----------------

test('有据：最后一次测试成功，之后没再改代码', () => {
  seq = 0;
  assert.deepEqual(
    verdicts([u('修一下登录'), edit('src/login.ts'), out(false), bash('npm test'), out(false), a('改好了，12 个测试全部通过')]),
    ['verified'],
  );
});

test('改了没再测：测试之后又改了代码，改完一条命令都没跑', () => {
  seq = 0;
  const [c] = auditClaims([u('修一下登录'), bash('npm run -s test'), out(false), edit('src/login.ts'), out(false), a('测试全部通过了')]);
  assert.equal(c.verdict, 'stale');
  assert.deepEqual(c.editedAfter?.files, ['src/login.ts']);
  assert.equal(c.test?.command, 'npm run -s test', '命令和脚本名之间夹着参数也认得');
});

test('改完之后跑过别的命令：可能用别的办法验证过，不下结论', () => {
  seq = 0;
  assert.deepEqual(
    verdicts([
      u('修一下'),
      bash('npm test'),
      out(false),
      edit('src/a.ts'),
      out(false),
      bash('node -e "require(1)"'),
      out(false),
      a('测试全部通过'),
    ]),
    ['unverifiable'],
  );
});

test('测试之后改的是文档、记忆、发布脚本，不算改了代码', () => {
  seq = 0;
  assert.deepEqual(
    verdicts([
      u('修一下'),
      bash('npm test'),
      out(false),
      edit('README.md'),
      out(false),
      edit('C:/Users/me/.claude/memory/notes.md'),
      out(false),
      edit('work/package-v52.py'),
      out(false),
      a('测试全部通过'),
    ]),
    ['verified'],
  );
});

test('对不上：最后一次测试失败，之后什么都没跑；跑过别的就不下结论', () => {
  seq = 0;
  assert.deepEqual(verdicts([u('修一下'), bash('npm test'), out(true, 'ℹ fail 2'), a('测试都通过了')]), ['contradicted']);
  seq = 0;
  assert.deepEqual(
    verdicts([u('修一下'), bash('npm test'), out(true, 'ℹ fail 2'), bash('node scripts/check.mjs'), out(false), a('测试都通过了')]),
    ['unverifiable'],
  );
});

test('无从核对：记录里找不到测试；同一个结果说好几遍只算一次', () => {
  seq = 0;
  assert.deepEqual(verdicts([u('配一下 key'), bash('curl -s api/models'), out(false), a('Key 测试通过')]), ['unverifiable']);
  seq = 0;
  assert.deepEqual(verdicts([u('修一下'), bash('npm test'), out(false), a('测试通过'), a('总结：测试全部通过')]), ['verified']);
});

test('Codex：exec 脚本里跑的测试、改的文件都认得', () => {
  seq = 0;
  const exec = (script: string) => ({ seq: seq++, role: 'tool_call' as Role, toolName: 'exec', text: script });
  const [c] = auditClaims([
    u('修一下'),
    exec('text(await tools.exec_command({cmd:"npm test"}))'),
    out(false, 'Script completed\nOutput:\n22 passing'),
    exec('await tools.apply_patch("*** Begin Patch\n*** Update File: src/terrain.js\n@@\n-a\n+b\n*** End Patch")'),
    out(false, 'Script completed'),
    a('22 项测试全部通过'),
  ]);
  assert.equal(c.verdict, 'stale');
  assert.deepEqual(c.editedAfter?.files, ['src/terrain.js']);
});

// ---------------- 守门 ----------------

/** 写一份最小的 Claude Code 会话记录 */
function transcript(events: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'yuchao-guard-'));
  const path = join(dir, 'g1.jsonl');
  const base = { sessionId: 'g1', cwd: 'G:/demo', timestamp: '2026-11-20T08:00:00.000Z' };
  writeFileSync(path, events.map((e, i) => JSON.stringify({ ...base, uuid: `e${i}`, ...e })).join('\n') + '\n');
  return path;
}
const said = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const tool = (id: string, name: string, input: object) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: string, is_error = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] },
});
const reply = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('守门：改完代码没跑就说测试通过，拦回去并说明原因', async () => {
  const path = transcript([
    said('修一下登录'),
    tool('t1', 'Bash', { command: 'npm test' }),
    result('t1', 'ℹ pass 12\nℹ fail 0'),
    tool('t2', 'Edit', { file_path: 'G:/demo/src/login.ts', old_string: 'a', new_string: 'b' }),
    result('t2', 'The file has been updated.'),
    reply('改好了，12 个测试全部通过。'),
  ]);
  const d = await checkStop({ transcript_path: path });
  assert.equal(d?.decision, 'block');
  assert.match(d!.reason, /12 个测试全部通过/);
  assert.match(d!.reason, /login\.ts/);
  assert.match(d!.reason, /npm test/);
});

test('守门：重新跑过测试、已经被拦过一次、或者问题出在更早的轮次，都放行', async () => {
  const ok = transcript([
    said('修一下登录'),
    tool('t1', 'Edit', { file_path: 'G:/demo/src/login.ts', old_string: 'a', new_string: 'b' }),
    result('t1', 'ok'),
    tool('t2', 'Bash', { command: 'npm test' }),
    result('t2', 'ℹ pass 12\nℹ fail 0'),
    reply('12 个测试全部通过。'),
  ]);
  assert.equal(await checkStop({ transcript_path: ok }), null);

  const bad = transcript([
    said('修一下'),
    tool('t1', 'Bash', { command: 'npm test' }),
    result('t1', 'ℹ fail 1', true),
    reply('测试都通过了。'),
  ]);
  assert.equal((await checkStop({ transcript_path: bad }))?.claim.verdict, 'contradicted');
  assert.equal(await checkStop({ transcript_path: bad, stop_hook_active: true }), null, '已经拦过一次，不再拉锯');

  const earlier = transcript([
    said('修一下'),
    tool('t1', 'Bash', { command: 'npm test' }),
    result('t1', 'ℹ fail 1', true),
    reply('测试都通过了。'),
    said('好，再帮我写个 README'),
    reply('写好了。'),
  ]);
  assert.equal(await checkStop({ transcript_path: earlier }), null, '只核对你最后一句话之后的这一轮');
  assert.equal(await checkStop({ transcript_path: join(tmpdir(), 'no-such-file.jsonl') }), null);
});

test('安装守门：只加自己那一条，其它设置和 hook 原样保留；重复安装不重复；卸载只删自己', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuchao-settings-'));
  const path = join(dir, 'settings.json');
  const other = { type: 'command', command: 'echo done' };
  writeFileSync(
    path,
    JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [other] }], PreToolUse: [{ matcher: 'Bash', hooks: [other] }] } }),
  );
  const cmd = '"C:/tools/yuchao.exe" guard';
  assert.ok(isGuardCommand(cmd));
  assert.ok(!isGuardCommand('echo done'));

  assert.equal(installGuard(path, cmd), 'installed');
  assert.equal(installGuard(path, cmd), 'updated');
  const s = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(s.model, 'opus');
  assert.deepEqual(s.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [other] }]);
  assert.deepEqual(
    s.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) => g.hooks.map((h) => h.command)),
    ['echo done', cmd],
  );
  assert.ok(guardInstalled(path));

  assert.equal(uninstallGuard(path), true);
  assert.equal(uninstallGuard(path), false);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).hooks.Stop, [{ hooks: [other] }]);
  assert.ok(!guardInstalled(path));

  // 没有 settings.json 时新建；里面不是 JSON 对象时拒绝改动
  const fresh = join(dir, 'new.json');
  installGuard(fresh, cmd);
  assert.ok(guardInstalled(fresh));
  writeFileSync(join(dir, 'bad.json'), '[1,2]');
  assert.throws(() => installGuard(join(dir, 'bad.json'), cmd), /不是一个 JSON 对象/);
});
