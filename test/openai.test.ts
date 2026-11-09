import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as z from 'zod';
import { OpenAiCompatibleLlm } from '../src/core/profile/openai.ts';

// 假的 OpenAI 兼容接口：按请求里的用户消息决定返回什么
let requests: { url: string; auth: string; body: any }[] = [];
let failuresLeft = 0;
const server = createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const body = JSON.parse(data);
    requests.push({ url: req.url!, auth: req.headers.authorization ?? '', body });
    const user: string = body.messages.at(-1).content;
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const ok = (content: string, finish = 'stop') => reply(200, { choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
    if (req.headers.authorization !== 'Bearer good-key') return reply(401, { error: { message: 'Invalid token' } });
    if (user === 'flaky' && failuresLeft-- > 0) return reply(429, { error: { message: 'slow down' } });
    if (user === 'fenced') return ok('```json\n{"answer": 42}\n```');
    if (user === 'wrong') return ok('{"answer": "forty-two"}');
    if (user === 'prose') return ok('答案是 42');
    if (user === 'cut') return ok('{"answer": 4', 'length');
    ok('{"answer": 42}');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const Schema = z.object({ answer: z.number().int() });
const llm = (key = 'good-key', baseURL = `${base}/v1`) => new OpenAiCompatibleLlm({ baseURL, apiKey: key, model: 'gpt-test', maxRetries: 2 });
const ask = (client: OpenAiCompatibleLlm, user: string) => client.json({ system: '回答问题', user, schema: Schema });

test('正常返回：请求地址、鉴权头、JSON Schema 和 token 统计', async () => {
  requests = [];
  const r = await ask(llm(), 'ok');
  assert.deepEqual(r, { data: { answer: 42 }, usage: { input: 11, output: 7 } });
  const [req] = requests;
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.auth, 'Bearer good-key');
  assert.equal(req.body.model, 'gpt-test');
  assert.equal(req.body.response_format.type, 'json_schema');
  assert.deepEqual(req.body.response_format.json_schema.schema.required, ['answer']);
  assert.ok(!JSON.stringify(req.body.response_format).includes('maximum'), '整数范围不应发给模型');
});

test('接口地址写不写 /v1、末尾带不带斜杠都能拼对', async () => {
  for (const b of [base, `${base}/`, `${base}/v1`, `${base}/v1/`]) {
    requests = [];
    await ask(llm('good-key', b), 'ok');
    assert.equal(requests[0].url, '/v1/chat/completions', b);
  }
});

test('包在 ```json 代码块里的回答也能解析', async () => {
  assert.equal((await ask(llm(), 'fenced')).data.answer, 42);
});

test('429 会重试，重试成功就正常返回', async () => {
  requests = [];
  failuresLeft = 2;
  assert.equal((await ask(llm(), 'flaky')).data.answer, 42);
  assert.equal(requests.length, 3);
});

test('不符合格式、不是 JSON、被截断、key 无效都会报错，而不是返回半成品', async () => {
  await assert.rejects(ask(llm(), 'wrong'), /不符合要求的格式/);
  await assert.rejects(ask(llm(), 'prose'), /不是合法的 JSON/);
  await assert.rejects(ask(llm(), 'cut'), /被截断/);
  await assert.rejects(ask(llm('bad-key'), 'ok'), /401 Invalid token/);
});
