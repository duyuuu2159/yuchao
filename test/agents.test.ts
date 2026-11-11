import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { AGENTS } from '../src/core/agents.ts';
import { defaultTracked } from '../src/core/configs.ts';
import { zstdFrames } from '../src/core/lines.ts';
import { readMemories, readWorkBuddyMemories } from '../src/core/memories.ts';
import { parseDshFile } from '../src/core/parsers/dsh.ts';
import { extractUserQuery, parseWorkBuddyFile } from '../src/core/parsers/workbuddy.ts';
import { discover } from '../src/core/sources.ts';
import { Store } from '../src/core/store.ts';

const FIX = join(import.meta.dirname, 'fixtures');
const WB = join(FIX, 'workbuddy');
const roles = (s: { messages: { role: string }[] }) => s.messages.map((m) => m.role);

test('WorkBuddy：只认 <user_query> 里的话，剥掉截图引用和夹带的系统提示', async () => {
  const s = await parseWorkBuddyFile(join(WB, 'projects/c-demo/wb1.jsonl'));
  assert.equal(s.id, 'workbuddy:wb1');
  assert.equal(s.title, 'nginx 502 修复', '标题以最后一次 ai-title 为准');
  assert.equal(s.cwd, 'c:/Users/demo/WorkBuddy/2026-11-02');
  assert.equal(s.startedAt, '2026-11-02T10:00:00.000Z');
  // reasoning 不收录；纯系统提示的用户消息剥完为空，直接丢掉；压缩摘要算上下文；结尾写了一半的行跳过
  assert.deepEqual(roles(s), ['user', 'assistant', 'tool_call', 'tool_result', 'context', 'user', 'assistant']);
  const users = s.messages.filter((m) => m.role === 'user').map((m) => m.text);
  assert.deepEqual(users, ['帮我看看 nginx 为什么 502', '重启一下后端']);
  assert.equal(s.messages[2].toolName, 'Bash');
  assert.match(s.messages[3].text, /Connection refused/);
  assert.ok(!s.messages.some((m) => m.text.includes('思考过程')));
});

test('WorkBuddy：压缩摘要里重放的旧问题不重复计为用户消息', () => {
  assert.equal(extractUserQuery('<cb_summary>\n<user_query>你好</user_query>\n</cb_summary>'), null);
  assert.equal(extractUserQuery('<system-reminder>只有系统提示</system-reminder>'), null);
  assert.equal(extractUserQuery('<user_query>a</user_query>\n<user_query>b</user_query>'), 'a\nb');
});

/** 模拟 DeepSeek Harness 的写法：每批事件压成一个独立的 zstd 帧，首尾相接 */
function writeDsh(dir: string, id: string, batches: unknown[][], tail = Buffer.alloc(0)): string {
  const sessionDir = join(dir, 'sessions', '--C-demo--', id);
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, 'session.v4.jsonl.zstd');
  const frames = batches.map((b) => zstdCompressSync(Buffer.from(b.map((e) => JSON.stringify(e) + '\n').join(''))));
  writeFileSync(path, Buffer.concat([...frames, tail]));
  return path;
}

const T = (s: number) => Date.parse('2026-11-03T08:00:00Z') + s * 1000;

test('DeepSeek Harness：逐帧解压；只有 source.kind=user 是人写的；子 agent 指向父会话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuchao-dsh-'));
  const path = writeDsh(
    dir,
    'child-1',
    [
      [{ type: 'session', version: 4, id: 'child-1', createdAt: T(0), cwd: 'C:/demo', parentSession: 'session-lead', origin: 'subagent' }],
      [
        { type: 'subagent/descriptor', seq: 0, time: T(0), data: { label: '查日志' } },
        {
          type: 'user/message',
          seq: 1,
          time: T(1),
          data: { content: [{ type: 'text', text: 'Current runtime context. cwd=C:/demo' }], source: { kind: 'runtime-context' } },
        },
        {
          type: 'user/message',
          seq: 2,
          time: T(2),
          data: { content: [{ type: 'text', text: '帮我查一下服务器日志' }, { type: 'image' }], source: { kind: 'user' } },
        },
      ],
      [
        {
          type: 'assistant/message',
          seq: 3,
          time: T(3),
          data: {
            message: {
              content: [
                { type: 'reasoning', text: '想一想' },
                { type: 'text', text: '好的，我先登录。' },
                { type: 'tool-call', name: 'pwsh', arguments: '{"command":"ssh demo"}' },
              ],
            },
          },
        },
        { type: 'tool/result', seq: 4, time: T(4), data: { message: { content: [{ type: 'text', text: 'Welcome to Ubuntu' }] } } },
        { type: 'plugin:translator/request', seq: 5, time: T(5), data: { text: '翻译插件的内容不收录' } },
        { type: 'session/title', seq: 6, time: T(6), data: { title: '帮我查一下服', source: { kind: 'fallback' } } },
        { type: 'session/title', seq: 7, time: T(7), data: { title: '服务器日志排查', source: { kind: 'provider' } } },
      ],
    ],
    // 还在写的最后一帧：只有帧头，解压失败应被丢弃
    zstdCompressSync(Buffer.from('{"type":"turn/end"}\n')).subarray(0, 8),
  );
  const s = await parseDshFile(path);
  assert.equal(s.id, 'dsh:child-1');
  assert.equal(s.parentId, 'dsh:session-lead');
  assert.equal(s.title, '服务器日志排查');
  assert.equal(s.cwd, 'C:/demo');
  assert.deepEqual(roles(s), ['context', 'user', 'assistant', 'tool_call', 'tool_result']);
  assert.equal(s.messages[0].toolName, 'runtime-context');
  assert.equal(s.messages[1].text, '帮我查一下服务器日志');
  assert.equal(s.messages[3].toolName, 'pwsh');
  assert.equal(s.updatedAt, new Date(T(7)).toISOString());
});

test('zstd 多帧：一个汉字被切在两帧之间也能拼回来；压缩数据里碰巧出现魔数也不会切坏', () => {
  const text = Buffer.from('{"t":"鱼巢"}\n');
  const cut = text.indexOf(Buffer.from('巢')) + 1; // 切在「巢」的 3 个字节中间
  const a = zstdCompressSync(text.subarray(0, cut));
  const b = zstdCompressSync(text.subarray(cut));
  assert.equal(Buffer.concat([...zstdFrames(Buffer.concat([a, b]))]).toString(), '{"t":"鱼巢"}\n');

  // 压不动的随机字节会被原样存进帧里，在中间放一个魔数，就模拟出「压缩数据中间碰巧出现帧头」
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  let seed = 7;
  const noise = (n: number) =>
    Buffer.from(
      Array.from({ length: n }, () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return seed & 0xff;
      }),
    );
  const tricky = Buffer.concat([noise(40), MAGIC, noise(40)]);
  const first = zstdCompressSync(tricky);
  assert.ok(first.indexOf(MAGIC, 4) > 0, '帧中间确实出现了魔数');
  const frames = [...zstdFrames(Buffer.concat([first, zstdCompressSync(Buffer.from('z'))]))];
  assert.deepEqual(
    frames.map((f) => f.toString('hex')),
    [tricky.toString('hex'), '7a'],
  );
});

test('只索引传入了目录的 agent；WorkBuddy 的文件回滚记录不当成会话', async () => {
  assert.deepEqual(
    discover({ workbuddy: WB }).map((f) => f.agent + ':' + f.path.replace(WB, '').replace(/\\/g, '/')),
    ['workbuddy:/projects/c-demo/wb1.jsonl'],
  );
  assert.deepEqual(discover({}), []);

  const store = new Store(':memory:');
  const dsh = mkdtempSync(join(tmpdir(), 'yuchao-dsh-'));
  writeDsh(dsh, 'session-a', [
    [
      { type: 'session', id: 'session-a', createdAt: T(0), cwd: 'C:/demo' },
      { type: 'user/message', time: T(1), data: { content: [{ type: 'text', text: '部署 nginx' }], source: { kind: 'user' } } },
    ],
  ]);
  const r = await store.index({ workbuddy: WB, dsh });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(
    store
      .stats()
      .sessions.map((x: any) => `${x.agent}:${x.n}`)
      .sort(),
    ['dsh:1', 'workbuddy:1'],
  );
  assert.deepEqual(
    store
      .search('nginx')
      .map((h) => h.agent)
      .sort(),
    ['dsh', 'workbuddy'],
  );
});

test('每个 agent 都声明了标签、数据目录和配置文件；凭据文件不跟踪', () => {
  for (const a of AGENTS) {
    assert.ok(a.label && a.home.startsWith('.'), a.kind);
    assert.ok(a.configFiles('/x').length > 0, a.kind);
  }
  const tracked = defaultTracked({ dsh: '/home/.dsh', workbuddy: '/home/.workbuddy' });
  assert.ok(!tracked.some((p) => /credential/i.test(p)));
  assert.ok(tracked.some((p) => p.endsWith('models.json')));
});

test('WorkBuddy 的记忆：USER.md、MEMORY.md 和用户画像，正文打码', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuchao-wbmem-'));
  mkdirSync(join(dir, 'memory'));
  writeFileSync(join(dir, 'USER.md'), '---\nsummary: "User profile record"\n---\n\n# USER.md\n- **Notes:** 偏好效率');
  writeFileSync(join(dir, 'MEMORY.md'), '# MEMORY.md\n服务器 203.0.113.9 root 密码 Tq8vLm2Xz9');
  writeFileSync(join(dir, 'memory', 'u1_memory.md'), '# User Memory Profile\n喜欢直接进入正题');
  writeFileSync(join(dir, 'memory', 'u1_memory.md.bak'), '旧版本');
  const ms = readWorkBuddyMemories(dir);
  assert.deepEqual(ms.map((m) => `${m.name}:${m.type}`).sort(), ['MEMORY.md:other', 'USER.md:user', 'u1_memory.md:user']);
  assert.ok(ms.every((m) => m.agent === 'workbuddy'));
  assert.ok(!ms.find((m) => m.name === 'USER.md')!.body.includes('summary'), 'YAML 头不进正文');
  assert.ok(!JSON.stringify(ms).includes('Tq8vLm2Xz9'), '密码要打码');
  assert.equal(readMemories({ workbuddy: dir }).length, 3);
  assert.deepEqual(readMemories({}), []);
});
