import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, isAllowedHost } from '../src/server/main.ts';
import { Store } from '../src/core/store.ts';

const server = createServer(createApp(new Store(':memory:')));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as AddressInfo).port;
after(() => server.close());

function call(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode!, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('只接受本机的 Host，挡住 DNS 重绑定', async () => {
  assert.equal(isAllowedHost('127.0.0.1:4317'), true);
  assert.equal(isAllowedHost('localhost:4317'), true);
  assert.equal(isAllowedHost('[::1]:4317'), true);
  assert.equal(isAllowedHost('evil.example.com'), false);
  assert.equal(isAllowedHost('127.0.0.1.evil.com'), false);
  assert.equal(isAllowedHost(undefined), false);
  assert.equal((await call('GET', '/api/stats', { host: 'evil.example.com' })).status, 403);
  assert.equal((await call('GET', '/api/stats')).status, 200);
});

test('写操作必须带自定义请求头', async () => {
  const fp = '0123456789abcdef';
  assert.equal((await call('PUT', `/api/scan/ignore/${fp}`)).status, 403);
  assert.equal((await call('PUT', `/api/scan/ignore/${fp}`, { 'x-yuchao': '1' })).status, 200);
  assert.equal((await call('DELETE', `/api/scan/ignore/${fp}`, { 'x-yuchao': '1' })).status, 200);
});

test('扫描接口返回结构；未知接口返回 404', async () => {
  const r = await call('GET', '/api/scan');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.findings, []);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

test('会话、标题和搜索结果默认打码，raw=1 才返回原文', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuchao-srv-'));
  cpSync(join(import.meta.dirname, 'fixtures'), root, { recursive: true });
  const PW = 'Tq8vLm2Xz9';
  appendFileSync(join(root, 'codex/session_index.jsonl'), JSON.stringify({ id: 'c1', thread_name: `服务器 203.0.113.7 root 密码 ${PW}` }) + '\n');
  const store = new Store(':memory:');
  await store.index({ claudeDir: join(root, 'claude'), codexDir: join(root, 'codex') });

  const srv = createServer(createApp(store));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const get = async (p: string) => (await fetch(base + p)).text();
  try {
    for (const p of ['/api/sessions', '/api/sessions/codex%3Ac1', '/api/search?q=203.0.113']) assert.ok(!(await get(p)).includes(PW), p);
    assert.ok((await get('/api/sessions?raw=1')).includes(PW));
  } finally {
    srv.close();
  }
});
