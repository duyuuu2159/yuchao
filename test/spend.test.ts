import assert from 'node:assert/strict';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localDay, usageReport } from '../src/core/spend.ts';
import { Store } from '../src/core/store.ts';

const FIX = join(import.meta.dirname, 'fixtures');

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'yuchao-spend-'));
  cpSync(FIX, root, { recursive: true });
  const store = new Store(':memory:');
  await store.index({ claude: join(root, 'claude'), codex: join(root, 'codex'), workbuddy: join(root, 'workbuddy') });
  return store;
}

test('用量报告：连续的日期轴，没有用量的日子补 0，每天按 agent 分开', async () => {
  const store = await setup();
  // 样例会话都在 2026-11-01 / 11-02，取到 11-10 为止的 14 天
  const r = usageReport(store, { days: 14, now: new Date(2026, 10, 10, 12) });
  assert.equal(r.days.length, 14);
  assert.equal(r.days[0].day, '2026-10-28');
  assert.equal(r.days.at(-1)?.day, '2026-11-10');
  for (let i = 1; i < r.days.length; i++) assert.ok(r.days[i].day > r.days[i - 1].day, '日期递增且不重复');

  const total = r.days.reduce((n, d) => n + d.total, 0);
  // Claude 1000 + 50，Codex 2500 + 100，WorkBuddy 6000 + 240
  assert.equal(total, 1050 + 2600 + 6240);
  const nov1 = r.days.find((d) => d.day === localDay('2026-11-01T08:00:01.000Z'))!;
  assert.equal(nov1.byAgent.claude, 1050);
  assert.ok(r.days.filter((d) => d.total === 0).length >= 10, '没有用量的日子也在轴上');
});

test('用量报告：时间范围之外的会话不算', async () => {
  const store = await setup();
  const r = usageReport(store, { days: 7, now: new Date(2026, 11, 31) });
  assert.equal(
    r.days.reduce((n, d) => n + d.total, 0),
    0,
  );
});

test('用量报告：最费 token 的会话按总量排序，带主力模型', async () => {
  const store = await setup();
  const { top } = usageReport(store, { top: 3, now: new Date(2026, 10, 10) });
  assert.deepEqual(
    top.map((t) => [t.agent, t.model, t.input + t.output]),
    [
      ['workbuddy', 'glm-5.2', 6240],
      ['codex', 'gpt-6-astra', 2600],
      ['claude', 'claude-opus-5-5', 1050],
    ],
  );
});
