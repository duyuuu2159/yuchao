import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assess,
  authorizedKeysLine,
  checkServer,
  deployHistory,
  ensureKey,
  loadServers,
  parseTarget,
  type RemoteStatus,
  recordDeploy,
  saveServers,
  sshArgs,
} from '../src/core/server.ts';
import { Store } from '../src/core/store.ts';

const SERVER = { name: 'demo', host: '203.0.113.7', user: 'root', port: 22 };
const GB = 1024 ** 3;
const PW = 'Tq8v' + 'Lm2Xz9';

function sample(over: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    version: 1,
    host: 'demo-host',
    time: 1794200000,
    uptime: 26 * 86400,
    load: [0.5, 0.6, 0.4],
    cpus: 4,
    memory: { total: 4 * GB, available: 3 * GB },
    disk: { total: 58 * GB, used: 51 * GB, free: 7 * GB },
    services: [
      { name: 'duyuuu', active: 'active', sub: 'running', since: 'Mon 2026-11-09 12:10:48 UTC', restarts: 0, pid: 726453 },
      { name: 'nginx', active: 'active', sub: 'running', since: null, restarts: 0, pid: 1 },
    ],
    app: { url: 'http://127.0.0.1:3000/', status: 200, ms: 8 },
    releases: {
      current: 'r64',
      total: 136,
      items: [
        { name: 'r64', mtime: 1794200000, current: true },
        { name: 'r63', mtime: 1794190000, current: false },
      ],
    },
    serviceLog: ["2026-11-09T05:37:36+0000 host systemd[1]: duyuuu.service: Failed with result 'exit-code'."],
    nginxErrors: [`2026/11/09 connect() failed, client: 198.51.100.23, request: "GET /?password=${PW}"`],
    ...over,
  };
}

const fakeSsh = (out: string) => {
  const calls: string[][] = [];
  const run = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    return out;
  };
  return { run, calls };
};

test('地址解析：只接受 用户名@主机[:端口]，挡住伪装成 ssh 参数的输入', () => {
  assert.deepEqual(parseTarget('root@203.0.113.7'), { user: 'root', host: '203.0.113.7', port: 22 });
  assert.deepEqual(parseTarget('deploy@example.com:2222'), { user: 'deploy', host: 'example.com', port: 2222 });
  for (const bad of ['-oProxyCommand=calc@x', 'root@-oProxyCommand=calc', 'root@a b', 'example.com', 'root@host;rm']) {
    assert.throws(() => parseTarget(bad), /地址格式/, bad);
  }
});

test('authorized_keys 这一行把密钥锁死在只读脚本上', () => {
  const line = authorizedKeysLine('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample= someone@pc\n');
  assert.equal(
    line,
    'restrict,command="/usr/bin/python3 /usr/local/lib/yuchao/status.py" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample= yuchao-readonly',
  );
  assert.throws(() => authorizedKeysLine('ssh-rsa AAAA x'));
  assert.throws(() => authorizedKeysLine('ssh-ed25519 AAAA" ,command="sh'));
});

test('ssh 参数：不弹密码、只用专用密钥、主机指纹必须已知，目标前有 -- 分隔', () => {
  const args = sshArgs(SERVER, '/k');
  for (const o of ['BatchMode=yes', 'IdentitiesOnly=yes', 'StrictHostKeyChecking=yes']) assert.ok(args.includes(o), o);
  assert.equal(args[args.indexOf('--') + 1], 'root@203.0.113.7');
});

test('检查服务器：解析状态、挑出问题，日志里的密码和访客 IP 打码', async () => {
  const { run, calls } = fakeSsh(JSON.stringify(sample()));
  const r = await checkServer(SERVER, { run, key: '/k' });
  assert.equal(calls[0][0], 'ssh');
  assert.equal(r.status.releases.current, 'r64');
  assert.deepEqual(
    r.warnings.map((w) => w.level + ':' + w.text),
    ['warn:磁盘已用 88%，release 目录有 136 个，可以清理旧的', 'warn:最近 7 天服务异常退出 1 次'],
  );
  const text = JSON.stringify(r);
  assert.ok(!text.includes(PW), '密码打码');
  assert.ok(!text.includes('198.51.100.23'), '访客 IP 打码');
  assert.ok((await checkServer(SERVER, { run, key: '/k', raw: true })).status.nginxErrors[0].includes('198.51.100.23'));
});

test('服务挂了、应用打不开要标成严重问题', () => {
  const s = sample({
    services: [{ name: 'duyuuu', active: 'failed', sub: 'failed', since: null, restarts: 3, pid: 0 }],
    app: { url: 'x', status: null, ms: null, error: 'URLError' },
  });
  const levels = assess(s, { status: 502, ms: 30 })
    .filter((w) => w.level === 'bad')
    .map((w) => w.text);
  assert.deepEqual(levels, ['服务 duyuuu 不在运行（failed）', '应用本机访问失败：URLError', '公网访问失败：502']);
});

test('服务器返回的不是状态 JSON（例如 command 没配好）时给出明确提示', async () => {
  await assert.rejects(checkServer(SERVER, { run: fakeSsh('Welcome to Ubuntu').run, key: '/k' }), /authorized_keys/);
  await assert.rejects(checkServer(SERVER, { run: fakeSsh('{"version":2}').run, key: '/k' }), /格式不对/);
});

test('上线记录：线上版本变化时才记一笔', () => {
  const store = new Store(':memory:');
  assert.equal(recordDeploy(store, 'demo', 'r63', '2026-11-09T01:00:00Z'), true);
  assert.equal(recordDeploy(store, 'demo', 'r63', '2026-11-09T02:00:00Z'), false);
  assert.equal(recordDeploy(store, 'demo', 'r64', '2026-11-09T03:00:00Z'), true);
  assert.equal(recordDeploy(store, 'demo', null), false);
  assert.deepEqual(
    deployHistory(store, 'demo').map((h) => h.release),
    ['r64', 'r63'],
  );
});

test('服务器列表的保存和读取；专用密钥只生成一次', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuchao-srvcfg-'));
  assert.deepEqual(loadServers(join(dir, 'servers.json')), []);
  saveServers([SERVER], join(dir, 'servers.json'));
  assert.deepEqual(loadServers(join(dir, 'servers.json')), [SERVER]);

  let keygen = 0;
  const key = join(dir, 'ssh', 'k');
  const run = async (_f: string, args: string[]) => {
    keygen++;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args[args.indexOf('-f') + 1] + '.pub', 'ssh-ed25519 AAAAtest yuchao-readonly\n');
    writeFileSync(args[args.indexOf('-f') + 1], 'private');
    return '';
  };
  assert.equal(await ensureKey(key, run), 'ssh-ed25519 AAAAtest yuchao-readonly');
  await ensureKey(key, run);
  assert.equal(keygen, 1);
  assert.equal(readFileSync(key, 'utf8'), 'private');
});
