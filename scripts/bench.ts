// 性能基准：用合成的会话数据测索引和搜索的速度，任何人都能用同一条命令复现。
//
//   node scripts/bench.ts                       默认 1000 个会话 × 每个 100 条消息
//   node scripts/bench.ts --sessions 3000 --messages 120
//   node scripts/bench.ts --json                输出 JSON，方便记录和对比
//
// 数据是按固定种子生成的 Claude Code 格式会话：中文提问、带代码块的回答、工具调用和工具输出混在一起，
// 比例接近真实使用。不读取本机的任何真实会话。

import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from '../src/core/store.ts';

const { values } = parseArgs({
  options: {
    sessions: { type: 'string', default: '1000' },
    messages: { type: 'string', default: '100' },
    json: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});
const SESSIONS = Number(values.sessions);
const MESSAGES = Number(values.messages);

// ---------- 可复现的伪随机数 ----------
let seed = 20261111;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

const TOPICS = ['nginx', 'docker', 'sqlite', 'react', 'typescript', 'webpack', 'systemd', 'redis', 'postgres', 'vite', 'python', 'rust'];
const ASKS = [
  '帮我看看 {t} 为什么报错，昨天还好好的',
  '{t} 的配置怎么写才能支持热更新',
  '把这个 {t} 的脚本改成异步的，顺便加上重试',
  '服务器上 {t} 一直重启，日志在下面',
  '解释一下 {t} 里这段代码在做什么',
  '能不能把 {t} 的构建时间降下来，现在要三分钟',
  '继续',
  '好的，按你说的改',
];
const ANSWERS = [
  '我先看一下 {t} 的配置文件，问题可能出在路径上。',
  '原因是 {t} 的缓存目录没有写权限，改成下面这样就可以：',
  '这段代码在启动时读取 {t} 的环境变量，然后建立连接池。',
  '我把 {t} 的调用改成了并发执行，并在失败时指数退避重试。',
];
const CODE = [
  '```ts\nconst client = await connect(process.env.URL);\nawait client.query("select 1");\n```',
  '```bash\nsudo systemctl restart app && journalctl -u app -n 50\n```',
];
const OUTPUT = [
  'Error: EACCES: permission denied, open /var/cache/app/index',
  'build finished in 2.31s',
  'Active: active (running) since Tue',
  'npm ERR! code ERESOLVE',
];

const fill = (s: string, t: string) => s.replaceAll('{t}', t);

function sessionLines(i: number): string[] {
  const id = `bench-${String(i).padStart(5, '0')}`;
  const t0 = Date.UTC(2026, 0, 1) + i * 3_600_000;
  const lines: string[] = [];
  for (let m = 0; m < MESSAGES; m++) {
    const topic = pick(TOPICS);
    const ts = new Date(t0 + m * 30_000).toISOString();
    const base = { uuid: `${id}-${m}`, timestamp: ts, sessionId: id, cwd: `/home/dev/${topic}` };
    const kind = m % 4; // 用户 → 回答 → 工具调用 → 工具输出，循环
    if (kind === 0) lines.push(JSON.stringify({ ...base, type: 'user', message: { role: 'user', content: fill(pick(ASKS), topic) } }));
    else if (kind === 1)
      lines.push(
        JSON.stringify({
          ...base,
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: `${fill(pick(ANSWERS), topic)}\n\n${pick(CODE)}` }] },
        }),
      );
    else if (kind === 2)
      lines.push(
        JSON.stringify({
          ...base,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: `t${m}`, name: 'Bash', input: { command: `grep -rn ${topic} .` } }],
          },
        }),
      );
    else
      lines.push(
        JSON.stringify({
          ...base,
          type: 'user',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${m - 1}`, content: pick(OUTPUT) }] },
        }),
      );
  }
  return lines;
}

// ---------- 计时工具 ----------
const now = () => performance.now();
function percentile(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const ms = (x: number) => Math.round(x * 10) / 10;

// ---------- 开始 ----------
const root = mkdtempSync(join(tmpdir(), 'yuchao-bench-'));
const claudeDir = join(root, '.claude');
const project = join(claudeDir, 'projects', 'bench');
mkdirSync(project, { recursive: true });
const dbPath = join(root, 'index.db');

const log = (s: string) => !values.json && console.log(s);
log(`生成 ${SESSIONS} 个会话 × ${MESSAGES} 条消息 …`);
let bytes = 0;
for (let i = 0; i < SESSIONS; i++) {
  const text = sessionLines(i).join('\n') + '\n';
  bytes += Buffer.byteLength(text);
  writeFileSync(join(project, `bench-${i}.jsonl`), text);
}

const store = new Store(dbPath);
const dirs = { claude: claudeDir };

let t = now();
const cold = await store.index(dirs);
const coldMs = now() - t;

t = now();
const warm = await store.index(dirs);
const warmMs = now() - t;

// 改动 1% 的会话（追加一条消息），模拟日常使用中的增量更新
const changed = Math.max(1, Math.round(SESSIONS / 100));
for (let i = 0; i < changed; i++) {
  const line = {
    type: 'user',
    uuid: `extra-${i}`,
    timestamp: new Date().toISOString(),
    sessionId: `bench-${i}`,
    message: { role: 'user', content: '再补充一句：顺便检查一下 nginx 的超时设置' },
  };
  appendFileSync(join(project, `bench-${i}.jsonl`), JSON.stringify(line) + '\n');
}
t = now();
const incr = await store.index(dirs);
const incrMs = now() - t;

const QUERIES = ['nginx', '权限', '热更新 docker', '连接池', 'systemctl restart', '指数退避', '构建时间', 'ERESOLVE'];
const latencies: Record<string, number[]> = {};
let hits = 0;
for (const q of QUERIES) {
  store.search(q, { limit: 20 }); // 预热
  latencies[q] = [];
  for (let k = 0; k < 20; k++) {
    t = now();
    hits += store.search(q, { limit: 20 }).length;
    latencies[q].push(now() - t);
  }
}
const all = Object.values(latencies).flat();
store.close();

const messages = SESSIONS * MESSAGES;
const result = {
  machine: { cpu: cpus()[0]?.model.trim(), cores: cpus().length, node: process.version, platform: `${process.platform}-${process.arch}` },
  corpus: { sessions: SESSIONS, messages, sourceMB: ms(bytes / 1024 / 1024), dbMB: ms(statSync(dbPath).size / 1024 / 1024) },
  index: {
    coldMs: Math.round(coldMs),
    messagesPerSecond: Math.round(messages / (coldMs / 1000)),
    unchangedMs: Math.round(warmMs),
    unchangedSkipped: warm.skipped,
    incrementalMs: Math.round(incrMs),
    incrementalFiles: incr.indexed,
  },
  search: {
    queries: QUERIES.length,
    runsEach: 20,
    p50Ms: ms(percentile(all, 50)),
    p95Ms: ms(percentile(all, 95)),
    maxMs: ms(Math.max(...all)),
    hits,
  },
};
if (cold.indexed !== SESSIONS) throw new Error(`冷索引应收录 ${SESSIONS} 个会话，实际 ${cold.indexed}`);
if (incr.indexed !== changed) throw new Error(`增量索引应只重新解析 ${changed} 个文件，实际 ${incr.indexed}`);

if (values.json) console.log(JSON.stringify(result, null, 2));
else {
  const r = result;
  console.log(`
机器        ${r.machine.cpu}（${r.machine.cores} 线程），Node ${r.machine.node}，${r.machine.platform}
数据        ${r.corpus.sessions} 个会话，${r.corpus.messages.toLocaleString()} 条消息，源文件 ${r.corpus.sourceMB} MB → 索引 ${r.corpus.dbMB} MB

冷索引      ${(r.index.coldMs / 1000).toFixed(1)} 秒（${r.index.messagesPerSecond.toLocaleString()} 条/秒）
无变化      ${r.index.unchangedMs} 毫秒（${r.index.unchangedSkipped} 个文件全部跳过）
改动 1%     ${r.index.incrementalMs} 毫秒（只重新解析 ${r.index.incrementalFiles} 个文件）

搜索        ${r.search.queries} 个查询 × ${r.search.runsEach} 次：P50 ${r.search.p50Ms} 毫秒，P95 ${r.search.p95Ms} 毫秒，最慢 ${r.search.maxMs} 毫秒`);
  // 中文在终端里占两格，按显示宽度补空格才能对齐
  const width = (t: string) => [...t].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  for (const q of QUERIES)
    console.log(`            ${q}${' '.repeat(Math.max(1, 20 - width(q)))}P50 ${ms(percentile(latencies[q], 50))} 毫秒`);
}

if (!values.keep) rmSync(root, { recursive: true, force: true });
else log(`\n数据保留在 ${root}`);
