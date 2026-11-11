// 端到端测试：真正启动命令行程序，用临时目录冒充用户的家目录，从索引到搜索、扫描、接力跑一遍。
// 其它测试直接调用函数；这里检查的是「用户敲下命令后看到的东西」，包括参数解析、退出码和输出。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json' with { type: 'json' };

const ROOT = join(import.meta.dirname, '..');
const FIX = join(import.meta.dirname, 'fixtures');
const MAIN = join(ROOT, 'src', 'cli', 'main.ts');

// 假令牌在运行时拼出来，源码里不出现完整的令牌格式（GitHub 推送保护会拦）
const FAKE_GH = 'gh' + 'p_' + 'e2eTestToken0123456789abcdefABCDEF0123';

/** 搭一个假的家目录：.claude、.codex、.workbuddy 都来自手写样例；数据库也放在里面 */
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'yuchao-e2e-'));
  cpSync(join(FIX, 'claude'), join(home, '.claude'), { recursive: true });
  cpSync(join(FIX, 'codex'), join(home, '.codex'), { recursive: true });
  cpSync(join(FIX, 'workbuddy'), join(home, '.workbuddy'), { recursive: true });
  mkdirSync(join(home, '.yuchao'));
  return home;
}

function cli(home: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [MAIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home, // Linux / macOS 的 os.homedir()
      USERPROFILE: home, // Windows 的 os.homedir()
      YUCHAO_DB: join(home, '.yuchao', 'index.db'),
      NO_COLOR: '1',
    },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('--version 输出 package.json 里的版本号', () => {
  const r = cli(makeHome(), '--version');
  assert.equal(r.code, 0);
  assert.match(r.out, new RegExp(`^yuchao ${pkg.version.replaceAll('.', '\\.')} \\(node `));
});

test('没有参数时打印帮助并正常退出', () => {
  const r = cli(makeHome());
  assert.equal(r.code, 0);
  assert.match(r.out, /用法：/);
});

test('未知命令和未知 agent 以非零退出码失败', () => {
  const home = makeHome();
  assert.notEqual(cli(home, 'frobnicate').code, 0);
  const r = cli(home, 'search', 'nginx', '--agent', 'nope');
  assert.notEqual(r.code, 0);
  assert.match(r.err + r.out, /未知的 agent/);
});

test('索引 → 统计 → 搜索 → 查看：从家目录里找到三个 agent 的会话', () => {
  const home = makeHome();
  const idx = cli(home, 'index');
  assert.equal(idx.code, 0, idx.err);

  const stats = cli(home, 'stats');
  assert.equal(stats.code, 0, stats.err);
  for (const agent of ['claude', 'codex', 'workbuddy']) assert.match(stats.out, new RegExp(agent, 'i'));

  const search = cli(home, 'search', 'nginx');
  assert.equal(search.code, 0, search.err);
  assert.match(search.out, /claude:s1/);

  const show = cli(home, 'show', 'claude:s1');
  assert.equal(show.code, 0, show.err);
  assert.match(show.out, /502/);
});

test('第二次索引没有变化的文件全部跳过', () => {
  const home = makeHome();
  cli(home, 'index');
  const again = cli(home, 'index');
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /新建或更新 0，未变化跳过 [1-9]\d*，/);
});

test('扫描找到会话里的令牌，输出里只有打码后的内容', () => {
  const home = makeHome();
  const line = {
    type: 'user',
    message: { role: 'user', content: `export GITHUB_TOKEN=${FAKE_GH}` },
    uuid: 'e2e1',
    timestamp: '2026-11-01T09:00:00.000Z',
    sessionId: 's1',
  };
  appendFileSync(join(home, '.claude', 'projects', 'G--demo', 's1.jsonl'), JSON.stringify(line) + '\n');
  assert.equal(cli(home, 'index').code, 0);

  const text = cli(home, 'scan');
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /GitHub 令牌/);
  assert.ok(!text.out.includes(FAKE_GH), '终端输出里不能出现令牌原文');

  const json = cli(home, 'scan', '--json');
  assert.equal(json.code, 0, json.err);
  const report = JSON.parse(json.out);
  assert.ok(report.findings.some((f: { ruleName: string }) => f.ruleName === 'GitHub 令牌'));
  assert.ok(!json.out.includes(FAKE_GH), 'JSON 输出里也不能出现令牌原文');
});

test('接力：为最近的会话生成交接说明', () => {
  const home = makeHome();
  cli(home, 'index');
  const r = cli(home, 'handoff', 'claude:s1', '--to', 'codex');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /nginx/);
});

test('配置管家：记录版本 → 查看历史 → 对比 → 回滚（只在临时家目录里操作）', () => {
  const home = makeHome();
  const settings = join(home, '.claude', 'settings.json');
  const keyName = 'ANTHROPIC_' + 'AUTH_TOKEN';
  const secret = 'sk-ant-' + 'e2eConfigSecret0123456789abcdefghij';
  writeFileSync(settings, JSON.stringify({ model: 'opus', env: { [keyName]: secret } }, null, 2) + '\n');
  assert.equal(cli(home, 'index').code, 0); // 索引时顺手记录第一个版本

  writeFileSync(settings, JSON.stringify({ model: 'sonnet', env: { [keyName]: secret } }, null, 2) + '\n');
  const snap = cli(home, 'config', 'snapshot');
  assert.equal(snap.code, 0, snap.err);
  assert.match(snap.out, /记录了新版本/);

  const status = cli(home, 'config');
  assert.equal(status.code, 0, status.err);
  assert.match(status.out, /2 个版本/);

  const log = cli(home, 'config', 'log', 'claude/settings');
  assert.equal(log.code, 0, log.err);
  const ids = [...log.out.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(new Set(ids).size, 2, log.out);
  const oldest = Math.min(...ids);

  const diff = cli(home, 'config', 'diff', 'claude/settings', String(oldest), 'current');
  assert.equal(diff.code, 0, diff.err);
  assert.match(diff.out, /- .*opus/);
  assert.match(diff.out, /\+ .*sonnet/);

  // 查看和对比都必须打码
  const show = cli(home, 'config', 'show', String(oldest));
  assert.equal(show.code, 0, show.err);
  for (const out of [show.out, diff.out]) assert.ok(!out.includes(secret), '配置里的 token 不能原样输出');

  // 不加 --yes 只预览，不改文件
  const preview = cli(home, 'config', 'restore', String(oldest));
  assert.equal(preview.code, 0, preview.err);
  assert.match(readFileSync(settings, 'utf8'), /sonnet/);

  const restore = cli(home, 'config', 'restore', String(oldest), '--yes');
  assert.equal(restore.code, 0, restore.err);
  assert.match(readFileSync(settings, 'utf8'), /opus/);
  assert.match(restore.out, /回滚前的内容保存为 #\d+/);
});

test('配置管家：文件名有歧义或不存在时给出明确提示', () => {
  const home = makeHome();
  const ambiguous = cli(home, 'config', 'log', 'settings');
  assert.notEqual(ambiguous.code, 0);
  assert.match(ambiguous.err + ambiguous.out, /匹配到多个文件/);
  const missing = cli(home, 'config', 'show', '99999');
  assert.notEqual(missing.code, 0);
});
