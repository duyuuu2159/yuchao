import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager, findBackups, redactConfig, validate } from '../src/core/configs.ts';
import { diffText } from '../src/core/diff.ts';
import { Store } from '../src/core/store.ts';

// 假的 key 在运行时拼接，避免源码里出现长得像真 key 的字符串
const KEY = 'sk' + '-' + 'Zx8Kq2Lm9Np4Rt6Vw1Yb3Cd5Fg7Hj0';
const TOKEN = 'Tq8vLm2Xz9Ab';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'yuchao-cfg-'));
  const claudeDir = join(root, '.claude');
  const codexDir = join(root, '.codex');
  mkdirSync(claudeDir);
  mkdirSync(codexDir);
  const dirs = { claude: claudeDir, codex: codexDir };
  const store = new Store(':memory:');
  const cfg = new ConfigManager(store, dirs);
  const at = (path: string, content: string, iso: string) => {
    writeFileSync(path, content);
    utimesSync(path, new Date(iso), new Date(iso));
  };
  return { root, dirs, store, cfg, at, toml: join(codexDir, 'config.toml'), json: join(claudeDir, 'settings.json') };
}

test('格式校验：JSON、TOML 损坏时给出原因，其他文本不校验', () => {
  assert.equal(validate('json', '{"a": 1}'), null);
  assert.match(validate('json', '{"a": 1,')!, /JSON/);
  assert.equal(validate('toml', 'model = "gpt"\n[x]\ny = 1'), null);
  assert.match(validate('toml', 'a = [1,')!, /unfinished array/);
  assert.equal(validate('text', '随便什么'), null);
});

test('配置打码：通用规则之外，名字里带 key、token、secret 的字段值也打码', () => {
  const text = `{"env": {"ANTHROPIC_AUTH_TOKEN": "${TOKEN}", "OPENAI_API_KEY": "${KEY}", "MODEL": "claude-opus-5-5"}}\nexperimental_bearer_token = "${TOKEN}"\nmodel = "gpt-6.1-sol"\nmodel_auto_compact_token_limit = 240000`;
  const r = redactConfig(text);
  assert.ok(!r.includes(TOKEN) && !r.includes(KEY), r);
  assert.match(r, /claude-opus-5-5/);
  assert.match(r, /gpt-6\.1-sol/);
  assert.match(r, /token_limit = 240000/, '纯数字不打码');
});

test('找出和配置放在一起的手工备份，不把无关文件算进来', () => {
  const { at, toml, dirs } = setup();
  at(toml, 'a = 1', '2026-11-01T00:00:00Z');
  for (const n of ['config.toml.bak_20260722_184528', 'config.toml.corrupted', 'config.toml.ccr-original', 'config.toml.bak_before_cpp140', 'config.toml.lock', 'other.toml', 'config.tomlx.bak']) {
    writeFileSync(join(dirs.codex!, n), 'x = 1');
  }
  const names = findBackups(toml).map((p) => p.split(/[\\/]/).pop()).sort();
  assert.deepEqual(names, ['config.toml.bak_20260722_184528', 'config.toml.bak_before_cpp140', 'config.toml.ccr-original', 'config.toml.corrupted']);
});

test('快照：内容有变化才记一版，版本时间取文件的修改时间', () => {
  const { cfg, at, toml } = setup();
  at(toml, 'model = "a"\n', '2026-10-01T00:00:00Z');
  assert.deepEqual(cfg.snapshot().recorded, [cfg.tracked().find((f) => f.path === toml)!.name]);
  assert.deepEqual(cfg.snapshot().recorded, []);
  at(toml, 'model = "b"\n', '2026-10-02T00:00:00Z');
  cfg.snapshot();
  const vs = cfg.versions(toml);
  assert.equal(vs.length, 2);
  assert.equal(vs[0].capturedAt, '2026-10-02T00:00:00.000Z');
  assert.equal(vs[1].capturedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(cfg.status().find((s) => s.path === toml)!.changed, false);
});

test('导入旧备份：按修改时间排进时间线，重复的跳过，损坏的标出来，原备份不动', () => {
  const { cfg, at, toml, dirs } = setup();
  at(toml, 'model = "now"\n', '2026-11-01T00:00:00Z');
  cfg.snapshot();
  at(join(dirs.codex!, 'config.toml.bak_1'), 'model = "old"\n', '2026-08-01T00:00:00Z');
  at(join(dirs.codex!, 'config.toml.bak_2'), 'model = "now"\n', '2026-09-01T00:00:00Z');
  at(join(dirs.codex!, 'config.toml.corrupted'), 'model = [\n', '2026-07-01T00:00:00Z');
  const r = cfg.importBackups();
  assert.deepEqual(r, { imported: 2, duplicates: 1, broken: 1 });
  const vs = cfg.versions(toml);
  assert.deepEqual(vs.map((v) => v.label), ['自动快照', 'config.toml.bak_1', 'config.toml.corrupted']);
  assert.ok(vs[2].error);
  assert.equal(readFileSync(join(dirs.codex!, 'config.toml.corrupted'), 'utf8'), 'model = [\n');
  assert.deepEqual(cfg.importBackups(), { imported: 0, duplicates: 3, broken: 0 });
});

test('回滚：先记录当前内容，写入目标版本，回滚本身也能撤销', () => {
  const { cfg, at, toml } = setup();
  at(toml, 'model = "good"\n', '2026-10-01T00:00:00Z');
  cfg.snapshot();
  const good = cfg.versions(toml)[0];
  at(toml, 'model = "bad idea"\n', '2026-10-02T00:00:00Z');
  // 有修改但还没拍快照，回滚时会先把它记下来
  const { before, after } = cfg.restore(good.id);
  assert.equal(readFileSync(toml, 'utf8'), 'model = "good"\n');
  assert.equal(before!.source, 'before-restore');
  assert.equal(cfg.rawContent(before!.id), 'model = "bad idea"\n');
  assert.equal(after.source, 'restore');
  // 撤销回滚
  cfg.restore(before!.id);
  assert.equal(readFileSync(toml, 'utf8'), 'model = "bad idea"\n');
});

test('回滚到损坏的版本会被拒绝，除非明确 force', () => {
  const { cfg, at, toml, dirs } = setup();
  at(toml, 'model = "ok"\n', '2026-10-01T00:00:00Z');
  at(join(dirs.codex!, 'config.toml.corrupted'), 'model = [\n', '2026-07-01T00:00:00Z');
  cfg.snapshot();
  cfg.importBackups();
  const broken = cfg.versions(toml).find((v) => v.error)!;
  assert.throws(() => cfg.restore(broken.id), /格式有误/);
  assert.equal(readFileSync(toml, 'utf8'), 'model = "ok"\n');
  cfg.restore(broken.id, { force: true });
  assert.equal(readFileSync(toml, 'utf8'), 'model = [\n');
});

test('当前文件损坏时，状态里能看出来', () => {
  const { cfg, at, json } = setup();
  at(json, '{"a": 1', '2026-10-01T00:00:00Z');
  const s = cfg.status().find((x) => x.path === json)!;
  assert.equal(s.exists, true);
  assert.ok(s.error);
  assert.equal(s.changed, true);
  assert.equal(cfg.status().find((x) => x.name.endsWith('CLAUDE.md'))!.exists, false);
});

test('额外跟踪的文件', () => {
  const { cfg, root } = setup();
  const extra = join(root, 'router.toml');
  writeFileSync(extra, 'x = 1');
  cfg.track(extra);
  assert.ok(cfg.tracked().some((f) => f.path === extra));
  cfg.untrack(extra);
  assert.ok(!cfg.tracked().some((f) => f.path === extra));
  assert.throws(() => cfg.track(join(root, 'nope.toml')), /不存在/);
});

test('差异对比：增删行数、分块和行号', () => {
  const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n');
  const b = ['a', 'b', 'C', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].join('\n');
  const d = diffText(a, b, 1);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
  assert.equal(d.hunks.length, 2);
  assert.deepEqual(d.hunks[0].lines.map((l) => `${l.kind}:${l.text}`), ['same:b', 'del:c', 'add:C', 'same:d']);
  assert.equal(d.hunks[0].oldStart, 2);
  assert.deepEqual(d.hunks[1].lines.at(-1), { kind: 'add', text: 'k', oldNo: null, newNo: 11 });
  assert.deepEqual(diffText('same', 'same').hunks, []);
  assert.equal(diffText('', 'x\ny').added, 2);
  assert.equal(diffText('a\r\nb\r\n', 'a\nb\n').hunks.length, 0, 'CRLF 和 LF 不算差异');
});

test('全是空字节的文件（写入时崩溃）给出明确原因', () => {
  assert.match(validate('toml', '\0'.repeat(50))!, /全是空字节/);
  assert.match(validate('json', '{"a": 1}\0')!, /含有空字节/);
});
