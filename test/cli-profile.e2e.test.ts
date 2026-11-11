// 端到端测试：画像生成的完整链路。
// 测试里起一个假的 OpenAI 兼容接口，让 `yuchao profile build` 真的通过 HTTP 去请求它，检查三件事：
//   1. 模型编造的引用（不存在的消息序号、会话编号）会被程序剔除，不会出现在画像里
//   2. 发给模型的只有用户自己写的话：没有 agent 的回复，密钥已打码
//   3. key 只出现在请求头里
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const FIX = join(import.meta.dirname, 'fixtures');
const MAIN = join(ROOT, 'src', 'cli', 'main.ts');

// 运行时拼出来，源码里不出现完整格式
const FAKE_GH = 'gh' + 'p_' + 'profileE2eToken0123456789abcdefABCDEF';
const FAKE_API_KEY = 'test-key-' + 'not-a-real-secret';
const ASSISTANT_TEXT = '我先看一下 upstream 配置。'; // fixture 里 agent 说的话，不应该发出去

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'yuchao-profile-e2e-'));
  cpSync(join(FIX, 'claude'), join(home, '.claude'), { recursive: true });
  cpSync(join(FIX, 'codex'), join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.yuchao'));
  // 用户在会话里贴过一个令牌：发给模型之前必须打码
  const line = {
    type: 'user',
    message: { role: 'user', content: `顺便帮我配一下 GITHUB_TOKEN=${FAKE_GH}，部署脚本要用` },
    uuid: 'p1',
    timestamp: '2026-11-01T09:00:00.000Z',
    sessionId: 's1',
  };
  appendFileSync(join(home, '.claude', 'projects', 'G--demo', 's1.jsonl'), JSON.stringify(line) + '\n');
  return home;
}

/** 异步启动命令行：假接口和它在同一个进程里，用 spawnSync 会把接口也卡住 */
function cli(home: string, ...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, YUCHAO_DB: join(home, '.yuchao', 'index.db'), NO_COLOR: '1' },
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

interface Captured {
  auth: string | undefined;
  system: string;
  user: string;
}

/**
 * 假的 /v1/chat/completions。按系统提示词区分两种请求：
 * - 逐个会话总结：返回一条引用真实序号的观察，和一条引用不存在序号 #99999 的观察
 * - 汇总画像：返回一条引用 S1 的结论，和一条引用不存在的 S999 的结论
 */
async function fakeLlm() {
  const requests: Captured[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const system: string = body.messages[0].content;
    const user: string = body.messages[1].content;
    requests.push({ auth: req.headers.authorization, system, user });

    let content: unknown;
    if (system.includes('亲手写的话')) {
      const realSeq = Number(/\[#(\d+)\]/.exec(user)?.[1] ?? 0);
      content = {
        summary: '想排查 nginx 502',
        traits: [
          { kind: 'skill', claim: '会用 nginx -t 检查配置', seqs: [realSeq] },
          { kind: 'habit', claim: '编造的观察：每天凌晨四点起床', seqs: [99999] },
        ],
      };
    } else {
      content = {
        headline: '在折腾服务器的人',
        sections: [
          {
            title: '在做的事',
            claims: [
              { text: '真实结论：在排查网站的 502 错误', evidence: ['S1'] },
              { text: '编造结论：拿过编程比赛金奖', evidence: ['S999'] },
            ],
          },
        ],
      };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

test('profile build：对着假接口跑完整流程，编造的引用被剔除，发出去的内容已打码', async () => {
  const home = makeHome();
  const llm = await fakeLlm();
  try {
    assert.equal((await cli(home, 'index')).code, 0);

    // key 写在文件里，不出现在命令行参数中
    const keyFile = join(home, 'key.env');
    writeFileSync(keyFile, `YUCHAO_BASE_URL=${llm.url}\nYUCHAO_API_KEY=${FAKE_API_KEY}\nYUCHAO_PROVIDER=openai\n`);

    // 不加 --yes 只提示费用，不发请求
    const dry = await cli(home, 'profile', 'build', '--key-file', keyFile, '--model', 'fake-model');
    assert.equal(dry.code, 0, dry.err);
    assert.equal(llm.requests.length, 0, '没加 --yes 时不能发出任何请求');

    const r = await cli(home, 'profile', 'build', '--yes', '--key-file', keyFile, '--model', 'fake-model');
    assert.equal(r.code, 0, r.err + r.out);
    assert.ok(llm.requests.length >= 2, '至少有一次会话总结和一次汇总');

    // 2. 发出去的内容
    const sent = llm.requests.map((q) => q.user).join('\n');
    assert.ok(!sent.includes(FAKE_GH), '令牌原文不能发给模型');
    assert.ok(!sent.includes(ASSISTANT_TEXT), 'agent 的回复不能发给模型');
    assert.ok(sent.includes('nginx'), '用户自己写的话应该发出去');
    // 3. key 只在请求头里
    for (const q of llm.requests) assert.equal(q.auth, `Bearer ${FAKE_API_KEY}`);
    assert.ok(!sent.includes(FAKE_API_KEY));

    // 1. 画像里只有有出处的结论
    const show = await cli(home, 'profile', 'show');
    assert.equal(show.code, 0, show.err);
    assert.match(show.out, /真实结论：在排查网站的 502 错误/);
    assert.ok(!show.out.includes('编造结论'), '引用不存在会话的结论必须被丢掉');
    assert.ok(!show.out.includes('凌晨四点'), '引用不存在消息的观察必须被丢掉');

    // 导出给 CLAUDE.md 的片段同样干净
    const exported = await cli(home, 'profile', 'export');
    assert.equal(exported.code, 0, exported.err);
    assert.ok(!exported.out.includes('编造'));
  } finally {
    llm.close();
  }
});

test('profile preview：写出的预览文件里没有令牌原文，也没有 agent 的回复', async () => {
  const home = makeHome();
  assert.equal((await cli(home, 'index')).code, 0);
  const r = await cli(home, 'profile', 'preview');
  assert.equal(r.code, 0, r.err);
  const preview = readFileSync(join(home, '.yuchao', 'profile-preview.txt'), 'utf8');
  assert.ok(preview.includes('nginx'));
  assert.ok(!preview.includes(FAKE_GH));
  assert.ok(!preview.includes(ASSISTANT_TEXT));
});

test('profile stats 和 memories 在没有大模型的情况下可用', async () => {
  const home = makeHome();
  await cli(home, 'index');
  const stats = await cli(home, 'profile', 'stats');
  assert.equal(stats.code, 0, stats.err);
  assert.match(stats.out, /活跃 \d+ 天/);
  const mem = await cli(home, 'memories');
  assert.equal(mem.code, 0, mem.err);
});

test('接口返回错误时以非零退出码失败，并给出提示', async () => {
  const home = makeHome();
  await cli(home, 'index');
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const keyFile = join(home, 'key.env');
    writeFileSync(keyFile, `YUCHAO_BASE_URL=http://127.0.0.1:${(server.address() as AddressInfo).port}\nYUCHAO_API_KEY=x\nYUCHAO_PROVIDER=openai\n`);
    const r = await cli(home, 'profile', 'build', '--yes', '--key-file', keyFile, '--model', 'fake-model');
    assert.notEqual(r.code, 0);
    assert.match(r.err + r.out, /401|invalid api key/);
  } finally {
    server.close();
  }
});
