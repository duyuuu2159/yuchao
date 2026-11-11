// 演示模式：生成一套假的 agent 数据，用它启动鱼巢。不读取、不修改本机的任何真实会话。
//
//   npm run demo                 生成数据、建索引、启动网页（http://127.0.0.1:4318）
//   npm run demo -- --no-serve   只生成数据和索引（截图脚本用）
//
// 数据是一个开发者三周里用四个 agent 做几个项目的过程：博客上线后 502、记账小程序、毕业设计的数据分析、
// 一个命令行小工具。里面故意混了几处「泄露」的假密钥，让安全扫描页有东西可看。
// 画像用一个本地的假模型接口生成（不联网、不花钱），只为了演示画像页长什么样。

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { zstdCompressSync } from 'node:zlib';

const { values } = parseArgs({ options: { 'no-serve': { type: 'boolean', default: false }, port: { type: 'string', default: '4318' } } });

const ROOT = join(import.meta.dirname, '..');
const HOME = join(tmpdir(), 'yuchao-demo');
rmSync(HOME, { recursive: true, force: true });

const write = (path: string, content: string | Buffer) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

// 假密钥在运行时拼出来：源码里不出现完整格式，免得被当成真的泄露
const FAKE = {
  dbPassword: 'Ledger' + '#2026' + 'demo',
  openai: 'sk-' + 'proj-' + 'DemoOnly0123456789abcdefghijklmnopqrstuvwxyzAB',
  aws: 'AKIA' + 'DEMOONLY' + '7EXAMPLE', // AKIA 后面正好 16 位，和真实格式一致
};

// ---------- 时间：以「现在」为基准往前推，概览页的「今天」「昨天」「本周」才有内容 ----------
const DAY = 86_400_000;
const at = (daysAgo: number, hour: number, minute = 0) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
};

interface Tool {
  name: string;
  input: Record<string, unknown>;
  output: string;
}
interface Turn {
  user: string;
  reply: string;
  tools?: Tool[];
}
interface Story {
  agent: 'claude' | 'codex' | 'workbuddy' | 'dsh';
  id: string;
  title: string;
  cwd: string;
  start: number;
  turns: Turn[];
}

const bash = (command: string, output: string): Tool => ({ name: 'Bash', input: { command }, output });
const edit = (file_path: string, old_string: string, new_string: string): Tool => ({
  name: 'Edit',
  input: { file_path, old_string, new_string },
  output: `The file ${file_path} has been updated.`,
});
const read = (file_path: string, output: string): Tool => ({ name: 'Read', input: { file_path }, output });

const BLOG = 'C:\\code\\blog';
const LEDGER = 'C:\\code\\ledger-miniapp';
const THESIS = 'C:\\code\\thesis-analysis';
const CLI = 'C:\\code\\notes-cli';

const STORIES: Story[] = [
  // ---------------- 博客：上线后 502 ----------------
  {
    agent: 'claude',
    id: 'demo-blog-502',
    title: '博客上线后一直 502',
    cwd: BLOG,
    start: at(0, 9, 12),
    turns: [
      {
        user: '博客部署到服务器之后访问一直是 502，nginx 配置我贴在下面了，帮我看看',
        reply: '502 说明 nginx 连不上后面的 Next.js 进程。我先确认服务有没有在跑，再看 upstream 指向的端口对不对。',
        tools: [
          bash('systemctl status blog --no-pager', 'blog.service - Blog\n   Active: activating (auto-restart) (Result: exit-code)'),
          bash('journalctl -u blog -n 20 --no-pager', 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'),
        ],
      },
      {
        user: '内存不够？服务器是 2G 的',
        reply:
          '对，进程在构建或启动时内存溢出，被 systemd 反复重启，所以 nginx 一直连不上。两个办法：\n\n1. 在本地构建好再上传，服务器只负责运行\n2. 限制 Node 的堆大小并加 swap\n\n```bash\nsudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile\nsudo mkswap /swapfile && sudo swapon /swapfile\n```\n\n我建议先做第 1 条，服务器上不再跑 `next build`。',
        tools: [edit(`${BLOG}\\deploy.sh`, 'npm run build', 'rsync -az .next/ server:/opt/blog/.next/')],
      },
      {
        user: '改完了，现在能打开了，但是首页图片很慢',
        reply: '图片都是原图直出的，最大的一张 4.2 MB。我把它们转成 WebP 并生成缩略图，首页只加载缩略图。',
        tools: [
          bash('npx sharp-cli -i public/images/*.jpg -o public/images/ -f webp -q 80', 'Converted 23 files'),
          edit(`${BLOG}\\components\\Hero.tsx`, 'src="/images/cover.jpg"', 'src="/images/cover.webp" loading="lazy"'),
        ],
      },
    ],
  },
  {
    agent: 'codex',
    id: 'demo-blog-https',
    title: '给博客配 HTTPS 和自动续期',
    cwd: BLOG,
    start: at(1, 21, 40),
    turns: [
      {
        user: '帮我给 blog.example.com 配上 HTTPS，证书要能自动续期',
        reply: '用 certbot 的 nginx 插件签发，它会顺手改好 nginx 配置并装上续期的定时器。',
        tools: [
          bash('sudo certbot --nginx -d blog.example.com', 'Successfully deployed certificate for blog.example.com'),
          bash('systemctl list-timers | grep certbot', 'certbot.timer  Sat 2026-11-14 03:12:00'),
        ],
      },
      {
        user: '续期失败的话我怎么知道',
        reply: '可以加一个续期后的钩子，失败时发邮件；或者简单点，每周看一次 `certbot renew --dry-run` 的结果。',
      },
    ],
  },
  {
    agent: 'claude',
    id: 'demo-blog-search',
    title: '博客加站内搜索',
    cwd: BLOG,
    start: at(4, 20, 5),
    turns: [
      {
        user: '博客想加一个站内搜索，文章不多，大概五十篇，不想引入 Algolia',
        reply: '五十篇文章完全可以在构建时生成一份索引 JSON，浏览器里用简单的倒排索引查。中文的话按字切分就够用。',
        tools: [
          edit(`${BLOG}\\scripts\\build-search.ts`, '', 'export function buildIndex(posts: Post[]) { /* ... */ }'),
          bash('npm run build', 'Generated search index: 52 posts, 38 KB'),
        ],
      },
      { user: '继续', reply: '搜索框加好了，支持键盘上下选择，回车打开文章。' },
    ],
  },
  // ---------------- 记账小程序 ----------------
  {
    agent: 'workbuddy',
    id: 'demo-ledger-db',
    title: '记账小程序：连不上数据库',
    cwd: LEDGER,
    start: at(2, 14, 30),
    turns: [
      {
        user: `后端连数据库一直报 access denied，连接串是 mysql://ledger:${FAKE.dbPassword}@127.0.0.1:3306/ledger`,
        reply: 'access denied 一般是用户只允许从 localhost 登录，而连接用的是 127.0.0.1。在 MySQL 里这两个算不同的主机。',
        tools: [bash('mysql -e "select user, host from mysql.user where user=\'ledger\'"', 'ledger  localhost')],
      },
      {
        user: '那我改成 localhost 吗',
        reply: '可以，或者给 127.0.0.1 也授权。另外连接串里的密码别写在代码里，放到 `.env`，并把 `.env` 加进 `.gitignore`。',
        tools: [edit(`${LEDGER}\\server\\db.ts`, "const url = 'mysql://...'", 'const url = process.env.DATABASE_URL')],
      },
    ],
  },
  {
    agent: 'workbuddy',
    id: 'demo-ledger-chart',
    title: '记账小程序：月度统计图',
    cwd: LEDGER,
    start: at(6, 19, 0),
    turns: [
      {
        user: '想在首页加一个本月支出的环形图，按分类显示',
        reply: '小程序里用 canvas 自己画就行，数据量很小，不需要引入图表库。分类超过 6 个的合并成「其他」，颜色才分得清。',
        tools: [edit(`${LEDGER}\\pages\\index\\chart.js`, '', 'function drawDonut(ctx, parts) { /* ... */ }')],
      },
      { user: '颜色能不能跟主题色一致', reply: '改成从主题色派生的一组颜色了，深色模式下也单独调过亮度。' },
    ],
  },
  {
    agent: 'claude',
    id: 'demo-ledger-export',
    title: '记账小程序：导出 Excel',
    cwd: LEDGER,
    start: at(9, 22, 15),
    turns: [
      {
        user: '用户想把账单导出成 Excel，要按月份分 sheet',
        reply: '服务端用 exceljs 生成，每个月一个 sheet，最后一行是合计。文件不落盘，直接以流的形式返回。',
        tools: [
          edit(`${LEDGER}\\server\\export.ts`, '', 'export async function exportXlsx(userId: string, res: Response) { /* ... */ }'),
          bash('npm test -- export', 'PASS server/export.test.ts (3 tests)'),
        ],
      },
    ],
  },
  // ---------------- 毕业设计：数据分析 ----------------
  {
    agent: 'dsh',
    id: 'demo-thesis-clean',
    title: '毕业设计：问卷数据清洗',
    cwd: THESIS,
    start: at(3, 10, 0),
    turns: [
      {
        user: '问卷导出了 1200 份，有一些明显乱填的（全选同一个选项、用时不到 30 秒），帮我筛掉',
        reply: '按你说的两条规则：所有量表题答案相同、或者作答时间少于 30 秒，都标为无效。筛完后保留 1087 份。',
        tools: [
          { name: 'python', input: { code: 'df = df[(df.duration >= 30) & (df[scale_cols].nunique(axis=1) > 1)]' }, output: '1087 rows' },
        ],
      },
      {
        user: '信度怎么算',
        reply: "用 Cronbach's α，每个维度分别算。五个维度都在 0.78 以上，可以在论文里写「量表信度良好」。",
        tools: [{ name: 'python', input: { code: 'pg.cronbach_alpha(df[dim_cols])' }, output: '(0.812, array([0.79, 0.83]))' }],
      },
    ],
  },
  {
    agent: 'dsh',
    id: 'demo-thesis-regression',
    title: '毕业设计：回归分析和画图',
    cwd: THESIS,
    start: at(5, 15, 20),
    turns: [
      {
        user: '想看学习时长对成绩的影响，控制年级和性别',
        reply: '做一个多元线性回归。学习时长的系数显著为正（β=0.31，p<0.001），年级和性别的影响不显著。',
        tools: [
          { name: 'python', input: { code: "smf.ols('score ~ hours + C(grade) + C(gender)', df).fit()" }, output: 'R-squared: 0.214' },
        ],
      },
      {
        user: '图里的中文显示成方框了',
        reply:
          'matplotlib 默认字体没有中文。设置成系统里的中文字体就好：\n\n```python\nplt.rcParams["font.sans-serif"] = ["Microsoft YaHei"]\nplt.rcParams["axes.unicode_minus"] = False\n```',
      },
    ],
  },
  {
    agent: 'codex',
    id: 'demo-thesis-latex',
    title: '论文排版：参考文献格式',
    cwd: THESIS,
    start: at(12, 16, 45),
    turns: [
      {
        user: '学校要求 GB/T 7714 的参考文献格式，用 LaTeX 怎么弄',
        reply: '用 biblatex-gb7714-2015 宏包，编译链换成 xelatex + biber。',
        tools: [bash('latexmk -xelatex thesis.tex', 'Output written on thesis.pdf (42 pages).')],
      },
    ],
  },
  // ---------------- 命令行小工具 ----------------
  {
    agent: 'codex',
    id: 'demo-cli-init',
    title: 'notes-cli：从零开始',
    cwd: CLI,
    start: at(14, 20, 0),
    turns: [
      {
        user: '想写一个命令行记笔记的小工具，`note add 内容` 就能记一条，`note find 关键词` 能搜',
        reply: '用 Node 写，数据存在 `~/.notes/notes.jsonl`，一行一条。搜索先用简单的包含匹配，以后再考虑全文索引。',
        tools: [
          bash('npm init -y && npm i commander', 'added 1 package'),
          edit(`${CLI}\\src\\index.ts`, '', "program.command('add <text...>').action(add)"),
        ],
      },
      { user: '好的，按你说的改', reply: '加好了 `note list --today`，按时间倒序列出今天的笔记。' },
    ],
  },
  {
    agent: 'claude',
    id: 'demo-cli-publish',
    title: 'notes-cli：发布到 npm',
    cwd: CLI,
    start: at(7, 21, 30),
    turns: [
      {
        user: '准备发到 npm，要注意什么',
        reply:
          '三件事：`files` 字段只包含编译后的代码；`bin` 指向的文件第一行要有 `#!/usr/bin/env node`；先用 `npm pack` 看一下包里到底有什么。',
        tools: [bash('npm pack --dry-run', 'Tarball Contents\n1.2kB dist/index.js\n0.8kB package.json\n2.1kB README.md')],
      },
      {
        user: `CI 里发布需要 token，我先把 OPENAI_API_KEY=${FAKE.openai} 也放进去，后面摘要功能要用`,
        reply:
          '这个 key 已经出现在对话记录里了，建议马上去后台作废、重新生成一个。CI 里的密钥要放在仓库的 Secrets 设置里，用 `${{ secrets.OPENAI_API_KEY }}` 引用，不要写进代码或命令。',
      },
    ],
  },
  {
    agent: 'workbuddy',
    id: 'demo-cli-backup',
    title: '笔记自动备份到对象存储',
    cwd: CLI,
    start: at(1, 10, 10),
    turns: [
      {
        user: `笔记想每天备份到 S3，我的 AWS_ACCESS_KEY_ID=${FAKE.aws}，帮我写个脚本`,
        reply: '脚本里不要直接写 key，用 AWS CLI 的配置文件或环境变量。另外建议单独建一个只能写这个桶的 IAM 用户，权限越小越好。',
        tools: [edit(`${CLI}\\scripts\\backup.sh`, '', 'aws s3 cp ~/.notes/notes.jsonl s3://my-notes-backup/$(date +%F).jsonl')],
      },
    ],
  },
  {
    agent: 'dsh',
    id: 'demo-cli-test',
    title: 'notes-cli：补测试',
    cwd: CLI,
    start: at(0, 14, 0),
    turns: [
      {
        user: '给 find 命令补上测试，特别是中文和大小写',
        reply: '加了 6 个用例：中文关键词、英文大小写不敏感、多个关键词同时出现、空结果、特殊字符、超长笔记。',
        tools: [bash('npm test', 'tests 14  pass 14  fail 0')],
      },
      { user: '继续', reply: '顺手修了一个问题：关键词里有正则特殊字符（比如 `c++`）时会报错，现在按普通文本匹配。' },
    ],
  },
];

// ---------- 四种格式的写法 ----------
const iso = (t: number) => new Date(t).toISOString();

/** 会话里的时间：每条消息比上一条晚 40 秒 */
function ticker(start: number) {
  const c = {
    now: start,
    next() {
      c.now += 40_000;
      return c.now;
    },
  };
  return c;
}

function writeClaude(s: Story) {
  const project = s.cwd.replace(/[:\\]/g, '-');
  const lines: object[] = [];
  const clock = ticker(s.start);
  let n = 0;
  const base = () => ({ uuid: `${s.id}-${n++}`, timestamp: iso(clock.next()), sessionId: s.id, cwd: s.cwd });
  lines.push({ type: 'custom-title', customTitle: s.title, sessionId: s.id });
  for (const turn of s.turns) {
    lines.push({ ...base(), type: 'user', message: { role: 'user', content: turn.user } });
    for (const [i, tool] of (turn.tools ?? []).entries()) {
      const id = `${s.id}-t${n}-${i}`;
      lines.push({
        ...base(),
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool.name, input: tool.input }] },
      });
      lines.push({
        ...base(),
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: tool.output }] },
      });
    }
    lines.push({ ...base(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: turn.reply }] } });
  }
  write(join(HOME, '.claude', 'projects', project, `${s.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const codexIndex: object[] = [];
function writeCodex(s: Story) {
  const clock = ticker(s.start);
  const rec = (payload: object, type = 'response_item') => ({ timestamp: iso(clock.next()), type, payload });
  const lines: object[] = [rec({ id: s.id, cwd: s.cwd, originator: 'Codex Desktop' }, 'session_meta')];
  for (const [k, turn] of s.turns.entries()) {
    lines.push(rec({ type: 'message', role: 'user', content: [{ type: 'input_text', text: turn.user }] }));
    for (const [i, tool] of (turn.tools ?? []).entries()) {
      const call_id = `c${k}-${i}`;
      const command = tool.name === 'Bash' ? ['bash', '-lc', String(tool.input.command)] : [tool.name, JSON.stringify(tool.input)];
      lines.push(rec({ type: 'function_call', name: 'shell', arguments: JSON.stringify({ command }), call_id }));
      lines.push(rec({ type: 'function_call_output', call_id, output: tool.output }));
    }
    lines.push(rec({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.reply }] }));
  }
  const d = new Date(s.start);
  const dir = join(
    HOME,
    '.codex',
    'sessions',
    String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  );
  write(
    join(dir, `rollout-${iso(s.start).slice(0, 19).replace(/:/g, '-')}-${s.id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
  codexIndex.push({ id: s.id, thread_name: s.title, updated_at: iso(clock.now) });
}

function writeWorkBuddy(s: Story) {
  const clock = ticker(s.start);
  let n = 0;
  const common = () => ({ id: `${s.id}-${n++}`, timestamp: clock.next(), sessionId: s.id, cwd: s.cwd });
  const lines: object[] = [{ type: 'session-meta', ...common(), meta: {} }];
  for (const [k, turn] of s.turns.entries()) {
    lines.push({
      type: 'message',
      role: 'user',
      ...common(),
      content: [{ type: 'input_text', text: `<user_query>${turn.user}</user_query>` }],
    });
    for (const [i, tool] of (turn.tools ?? []).entries()) {
      const callId = `w${k}-${i}`;
      lines.push({ type: 'function_call', ...common(), callId, name: tool.name, arguments: JSON.stringify(tool.input) });
      lines.push({
        type: 'function_call_result',
        ...common(),
        callId,
        name: tool.name,
        status: 'completed',
        output: { type: 'text', text: tool.output },
      });
    }
    lines.push({
      type: 'message',
      role: 'assistant',
      ...common(),
      status: 'completed',
      content: [{ type: 'output_text', text: turn.reply }],
    });
  }
  write(
    join(HOME, '.workbuddy', 'projects', s.cwd.replace(/[:\\]/g, '-').toLowerCase(), `${s.id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

function writeDsh(s: Story) {
  const clock = ticker(s.start);
  const ev = (type: string, data: object) => ({ type, time: clock.next(), data });
  const lines: object[] = [{ type: 'session', id: s.id, cwd: s.cwd, time: s.start }, ev('session/title', { title: s.title })];
  for (const turn of s.turns) {
    lines.push(ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: turn.user }] }));
    for (const tool of turn.tools ?? []) {
      lines.push(ev('assistant/message', { message: { content: [{ type: 'tool-call', name: tool.name, arguments: tool.input }] } }));
      lines.push(ev('tool/result', { message: { content: [{ type: 'text', text: tool.output }] } }));
    }
    lines.push(ev('assistant/message', { message: { content: [{ type: 'text', text: turn.reply }] } }));
  }
  // 和真实的 DeepSeek Harness 一样：每一行单独压缩成一个 zstd 帧，首尾相接
  const frames = lines.map((l) => zstdCompressSync(Buffer.from(JSON.stringify(l) + '\n')));
  write(join(HOME, '.dsh', 'sessions', s.cwd.replace(/[:\\]/g, '-'), s.id, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
}

const writers = { claude: writeClaude, codex: writeCodex, workbuddy: writeWorkBuddy, dsh: writeDsh };
for (const s of STORIES) writers[s.agent](s);
write(join(HOME, '.codex', 'session_index.jsonl'), codexIndex.map((l) => JSON.stringify(l)).join('\n') + '\n');

// ---------- 记忆和配置 ----------
write(
  join(HOME, '.claude', 'projects', BLOG.replace(/[:\\]/g, '-'), 'memory', 'deploy.md'),
  '---\nname: blog-deploy\ndescription: 博客的部署方式\n---\n\n服务器只有 2G 内存，构建在本地完成，服务器只负责运行。部署脚本是 deploy.sh。\n',
);
write(
  join(HOME, '.claude', 'projects', LEDGER.replace(/[:\\]/g, '-'), 'memory', 'secrets.md'),
  '---\nname: no-secrets-in-code\ndescription: 用户希望密钥都放在 .env\n---\n\n数据库连接串和 API key 放在 .env，不写进代码；.env 已加入 .gitignore。\n',
);
write(join(HOME, '.workbuddy', 'USER.md'), '# 用户\n\n在读本科，课余做个人项目：博客、记账小程序、命令行工具。喜欢先问清楚原因再动手。\n');
write(
  join(HOME, '.claude', 'settings.json'),
  JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(npm test)'] } }, null, 2) + '\n',
);
write(join(HOME, '.codex', 'config.toml'), 'model = "gpt-5-codex"\napproval_policy = "on-request"\n');
write(join(HOME, '.codex', 'AGENTS.md'), '# 约定\n\n- 回答用中文\n- 改代码前先说明要改哪些文件\n');

// ---------- 用 demo 家目录运行鱼巢 ----------
const env = { ...process.env, HOME, USERPROFILE: HOME, YUCHAO_DB: join(HOME, '.yuchao', 'index.db') };
const run = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli', 'main.ts'), ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', () => {});
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`yuchao ${args.join(' ')} 退出码 ${code}`))));
  });

await run(['index']);
// 改一次配置再索引，配置页就有两个版本可以对比
write(
  join(HOME, '.claude', 'settings.json'),
  JSON.stringify({ model: 'sonnet', permissions: { allow: ['Bash(npm test)', 'Bash(npm run build)'] } }, null, 2) + '\n',
);
await run(['index']);

// 画像：本地的假模型接口，按会话内容拼出总结，引用的都是真实的消息序号和会话编号
const fake = createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  const system: string = body.messages[0].content;
  const user: string = body.messages[1].content;
  let content: unknown;
  if (system.includes('亲手写的话')) {
    // 逐个会话总结：发来的文本已经打过码，看到打码痕迹就说明用户在这个会话里贴过密钥
    const seqs = [...user.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1]));
    const first = /\[#\d+\]\s*(.+)/.exec(user)?.[1]?.slice(0, 40) ?? '';
    const leaked = /\*{4,}|已打码/.test(user);
    content = {
      summary: `想解决：${first}${leaked ? '；对话里贴过密钥' : ''}`,
      traits: seqs.length ? [{ kind: 'habit', claim: '遇到问题会先贴出报错和配置再提问', seqs: seqs.slice(0, 1) }] : [],
    };
  } else {
    // 汇总：每条结论只引用内容真的相符的会话，和真实模型被要求做的一样
    const blocks = user.split(/\n{2,}/).map((b) => ({ id: /^\[(S\d+)\]/.exec(b)?.[1] ?? '', text: b }));
    const cite = (re: RegExp, max = 4) =>
      blocks
        .filter((b) => b.id && re.test(b.text))
        .slice(0, max)
        .map((b) => b.id);
    content = {
      headline: '一边上学一边做个人项目的开发者，部署和数据分析都在边做边学',
      sections: [
        {
          title: '在做的事',
          claims: [
            { text: '同时在做个人博客、记账小程序和一个命令行笔记工具', evidence: cite(/博客|记账|notes-cli|笔记/) },
            { text: '在写毕业论文，用问卷数据做清洗、信度分析和回归', evidence: cite(/毕业设计|论文/) },
          ],
        },
        {
          title: '和 AI 协作的习惯',
          claims: [
            {
              text: '服务器和部署问题多交给 Claude Code，数据分析多用 DeepSeek Harness',
              evidence: cite(/Claude Code｜博客|DeepSeek Harness/),
            },
            { text: '遇到问题习惯先贴报错和配置，再问原因', evidence: cite(/502|access denied|方框|报错/) },
          ],
        },
        {
          title: '值得注意的地方',
          claims: [{ text: '有几次把数据库密码和 API key 直接贴进了对话，建议作废后改用环境变量', evidence: cite(/贴过密钥/) }],
        },
      ],
    };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0 },
    }),
  );
});
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
const keyFile = join(HOME, 'demo-key.env');
write(keyFile, `YUCHAO_BASE_URL=http://127.0.0.1:${(fake.address() as AddressInfo).port}\nYUCHAO_API_KEY=demo\nYUCHAO_PROVIDER=openai\n`);
await run(['profile', 'build', '--yes', '--key-file', keyFile, '--model', 'demo-local-fake']);
fake.close();

console.log(`演示数据已生成：${HOME}`);
console.log(`共 ${STORIES.length} 个会话，四个 agent；画像由本地假模型生成，仅用于演示`);

if (!values['no-serve']) {
  console.log(`\n启动网页：http://127.0.0.1:${values.port}\n按 Ctrl+C 退出`);
  spawn(process.execPath, [join(ROOT, 'src', 'cli', 'main.ts'), 'serve', '--port', values.port], { env, stdio: 'inherit' });
}
