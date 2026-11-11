import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseFrontmatter, readClaudeMemories } from '../src/core/memories.ts';
import {
  buildProfile,
  diffProfiles,
  exportMarkdown,
  latestProfile,
  ProfileBuildError,
  type ProfileDoc,
  ProfileSchema,
  profileHistory,
  SessionNoteSchema,
} from '../src/core/profile/build.ts';
import { activityStats, sessionEvidence } from '../src/core/profile/evidence.ts';
import { type JsonRequest, type LlmClient, pickModel } from '../src/core/profile/llm.ts';
import { Store } from '../src/core/store.ts';

const FIX = join(import.meta.dirname, 'fixtures');
const PW = 'Tq8vLm2Xz9';

async function setup(beforeIndex?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'yuchao-profile-'));
  cpSync(FIX, root, { recursive: true });
  const s1 = join(root, 'claude/projects/G--demo/s1.jsonl');
  appendFileSync(
    s1,
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: `服务器 203.0.113.7 root 密码 ${PW}` },
      timestamp: '2026-11-03T00:00:00.000Z',
    }) + '\n',
  );
  beforeIndex?.(root);
  const store = new Store(':memory:');
  await store.index({ claude: join(root, 'claude'), codex: join(root, 'codex') });
  return { store, root };
}

/**
 * 假模型：记录收到的每个请求。
 * 会话总结里故意混入不存在的序号 999；汇总时引用一个存在的 S1 和不存在的 S99，
 * 再加一条只引用 S99 的结论，用来检验引用校验。
 */
class FakeLlm implements LlmClient {
  readonly model = 'fake-model';
  calls: { schema: 'note' | 'profile'; user: string; system: string }[] = [];
  failOn?: string;

  async json<T>(req: JsonRequest<T>) {
    if (req.schema === (SessionNoteSchema as unknown)) {
      this.calls.push({ schema: 'note', user: req.user, system: req.system });
      if (this.failOn && req.user.includes(this.failOn)) throw new Error('模拟失败');
      const seq = Number(req.user.match(/\[#(\d+)\]/)![1]);
      return {
        data: {
          summary: '排查网站问题',
          traits: [
            { kind: 'skill', claim: '会用 nginx', seqs: [seq, 999] },
            { kind: 'habit', claim: '只有假引用', seqs: [999] },
          ],
        } as T,
        usage: { input: 100, output: 20 },
      };
    }
    assert.equal(req.schema, ProfileSchema as unknown);
    this.calls.push({ schema: 'profile', user: req.user, system: req.system });
    return {
      data: {
        headline: '一个在折腾网站的人',
        sections: [
          {
            title: '技能',
            claims: [
              { text: '会排查 nginx 问题', evidence: ['S1', 's1', 'S99'] },
              { text: '编造的结论', evidence: ['S99'] },
            ],
          },
          { title: '空分组', claims: [{ text: '也是编造的', evidence: [] }] },
        ],
      } as T,
      usage: { input: 500, output: 80 },
    };
  }
}

test('读取 Claude 的记忆文件：解析头部、跳过索引、正文打码', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuchao-mem-'));
  const dir = join(root, 'projects', 'G--demo', 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), '- [x](x.md) — 索引');
  writeFileSync(
    join(dir, 'user-lang.md'),
    `---\nname: user-lang\ndescription: "用户要求用中文回复"\nmetadata:\n  type: user\n  originSessionId: abc\n  modified: 2026-10-01T02:25:20.662Z\n---\n\n用户要求所有回复都用简体中文。服务器密码 ${PW}\n`,
  );
  const ms = readClaudeMemories(root);
  assert.equal(ms.length, 1);
  assert.equal(ms[0].name, 'user-lang');
  assert.equal(ms[0].type, 'user');
  assert.equal(ms[0].description, '用户要求用中文回复');
  assert.equal(ms[0].originSessionId, 'abc');
  assert.equal(ms[0].project, 'G--demo');
  assert.ok(!ms[0].body.includes(PW));
  assert.deepEqual(readClaudeMemories(join(root, 'nope')), []);
  assert.deepEqual(parseFrontmatter('没有头部').meta, {});
  assert.equal(parseFrontmatter('---\ndescription: "at G:\\\\site, say \\"hi\\""\n---\n').meta.description, 'at G:\\site, say "hi"');
});

test('证据只包含用户亲手写的话，带消息序号，密码已打码', async () => {
  const { store } = await setup();
  const ev = sessionEvidence(store);
  assert.deepEqual(ev.map((e) => e.sessionId).sort(), ['claude:s1', 'codex:c1']);
  const s1 = ev.find((e) => e.sessionId === 'claude:s1')!;
  assert.match(s1.text, /\[#0\] 帮我检查 nginx 配置为什么 502/);
  assert.ok(!s1.text.includes('上游服务没启动'), 'agent 的回复不应发送');
  assert.ok(!s1.text.includes('nginx -t'), '工具调用不应发送');
  assert.ok(!s1.text.includes(PW));
  assert.ok(!s1.text.includes('203.0.113.7') && s1.text.includes('[IP]'), 'IP 地址也要隐藏');
  assert.ok(!s1.text.includes('<command-name>'), '注入的上下文不应发送');
  assert.deepEqual(
    sessionEvidence(store, { agent: 'codex' }).map((e) => e.sessionId),
    ['codex:c1'],
  );
});

test('分叉会话复制的用户消息只出现一次，子 agent 会话不算', async () => {
  const { store } = await setup((root) => {
    const dir = join(root, 'claude/projects/G--demo');
    copyFileSync(join(dir, 's1.jsonl'), join(dir, 's1-fork.jsonl'));
  });
  const ids = sessionEvidence(store).map((e) => e.sessionId);
  assert.ok(!ids.includes('claude:s1-fork'));
  assert.ok(!ids.some((id) => id.includes('/')));
});

test('会话太长时保留首尾，中间明确标出省略了多少条', async () => {
  const { store } = await setup((root) => {
    const lines = Array.from({ length: 60 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `第 ${i} 条 ` + '很长的内容'.repeat(40) },
        timestamp: `2026-11-04T00:${String(i).padStart(2, '0')}:00.000Z`,
      }),
    );
    writeFileSync(join(root, 'claude/projects/G--demo/long.jsonl'), lines.join('\n') + '\n');
  });
  const ev = sessionEvidence(store).find((e) => e.sessionId === 'claude:long')!;
  assert.match(ev.text, /…中间省略 \d+ 条消息…/);
  assert.match(ev.text, /第 0 条/);
  assert.match(ev.text, /第 59 条/);
  assert.ok(ev.text.length <= 8200);
});

test('本地统计', async () => {
  const { store } = await setup();
  const st = activityStats(store);
  assert.deepEqual(st.sessions, { claude: 1, codex: 1, workbuddy: 0, dsh: 0 });
  assert.equal(st.userMessages, 3);
  assert.equal(
    st.byHour.reduce((a, b) => a + b, 0),
    3,
  );
  assert.deepEqual(st.topProjects.map((p) => p.name).sort(), ['demo', 'site']);
  assert.equal(
    st.topTools.reduce((n, t) => n + t.calls, 0),
    4,
  );
});

test('生成画像：不存在的引用被剔除，没有有效引用的结论整条丢掉', async () => {
  const { store } = await setup();
  const llm = new FakeLlm();
  const v = await buildProfile(store, llm);
  assert.equal(v.profile.sections.length, 1);
  const [claim] = v.profile.sections[0].claims;
  assert.equal(claim.text, '会排查 nginx 问题');
  assert.equal(claim.evidence.length, 1);
  assert.ok(['claude:s1', 'codex:c1'].includes(claim.evidence[0].sessionId));
  // 每个会话 2 个假序号，汇总时两条结论各引用了一次不存在的 S99
  assert.equal(v.meta.droppedCitations, 2 * 2 + 2);
  assert.equal(v.meta.droppedClaims, 2);
  assert.equal(v.meta.notesGenerated, 2);
  assert.deepEqual(v.meta.usage, { input: 700, output: 120 });
});

test('发给模型的所有内容里都没有原文密码', async () => {
  const { store } = await setup();
  const llm = new FakeLlm();
  await buildProfile(store, llm);
  for (const c of llm.calls) assert.ok(!c.user.includes(PW) && !c.system.includes(PW));
});

test('会话没变时复用缓存的总结，只重新汇总', async () => {
  const { store } = await setup();
  const llm = new FakeLlm();
  await buildProfile(store, llm);
  llm.calls = [];
  const v2 = await buildProfile(store, llm);
  assert.deepEqual(
    llm.calls.map((c) => c.schema),
    ['profile'],
  );
  assert.equal(v2.meta.notesCached, 2);
  assert.equal(profileHistory(store, 'all').length, 2);
  assert.equal(latestProfile(store, 'all')!.id, v2.id);
  assert.equal(latestProfile(store, 'codex'), null);
});

test('单个会话失败不影响整体，失败会被记录', async () => {
  const { store } = await setup();
  const llm = new FakeLlm();
  llm.failOn = '首页卡死';
  const v = await buildProfile(store, llm);
  assert.equal(v.meta.notesFailed.length, 1);
  assert.equal(v.meta.notesFailed[0].sessionId, 'codex:c1');
  assert.equal(v.meta.notesGenerated, 1);
});

test('按 agent 分别生成画像', async () => {
  const { store } = await setup();
  const llm = new FakeLlm();
  const v = await buildProfile(store, llm, { scope: 'codex' });
  assert.equal(v.scope, 'codex');
  assert.equal(v.meta.sessions, 1);
  assert.equal(v.profile.sections[0].claims[0].evidence[0].sessionId, 'codex:c1');
});

test('版本对比和导出', () => {
  const a: ProfileDoc = {
    headline: 'a',
    sections: [
      {
        title: 't',
        claims: [
          { text: '旧结论', evidence: [] },
          { text: '不变', evidence: [] },
        ],
      },
    ],
  };
  const b: ProfileDoc = {
    headline: 'b',
    sections: [
      {
        title: 't',
        claims: [
          { text: '新结论', evidence: [] },
          { text: '不变', evidence: [] },
        ],
      },
    ],
  };
  assert.deepEqual(diffProfiles(a, b), { added: ['新结论'], removed: ['旧结论'] });
  const md = exportMarkdown({ id: 1, scope: 'all', createdAt: '2026-11-09T00:00:00Z', profile: b, meta: { sessions: 3 } as any });
  assert.match(md, /^## 关于我/);
  assert.match(md, /- 新结论/);
  assert.ok(!md.includes('S1'));
});

test('接口一开始就连续失败（例如余额不足）时立即停止，不把所有会话都试一遍', async () => {
  const { store } = await setup((root) => {
    for (let i = 0; i < 10; i++) {
      const line = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `第 ${i} 个会话` },
        timestamp: `2026-11-05T00:0${i}:00.000Z`,
      });
      writeFileSync(join(root, `claude/projects/G--demo/extra${i}.jsonl`), line + '\n');
    }
  });
  let calls = 0;
  const broken: LlmClient = {
    model: 'broken',
    async json() {
      calls++;
      throw new Error('429 Credits不足，请充值');
    },
  };
  await assert.rejects(buildProfile(store, broken), (e: Error) => e instanceof ProfileBuildError && /Credits不足/.test(e.message));
  assert.ok(calls <= 4, `只应尝试前几个会话，实际尝试了 ${calls} 次`);
  assert.equal(profileHistory(store, 'all').length, 0);
});

test('自动挑选模型：优先默认模型，其次最新的 Opus，再次 Sonnet', () => {
  assert.equal(pickModel(['gpt-image-2', 'claude-opus-5-5', 'claude-opus-5']), 'claude-opus-5-5');
  assert.equal(pickModel(['claude-opus-4-8', 'claude-opus-4-10', 'claude-sonnet-5-5']), 'claude-opus-4-10');
  assert.equal(pickModel(['[特价]claude-sonnet-5-5', 'gpt-6']), '[特价]claude-sonnet-5-5');
  assert.equal(pickModel(['gpt-image-2', 'gpt-6']), null);
});
