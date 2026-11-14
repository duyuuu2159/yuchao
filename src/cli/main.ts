#!/usr/bin/env node
import { isSea } from 'node:sea';
import { parseArgs } from 'node:util';
import pkg from '../../package.json' with { type: 'json' };
import { AGENT_KINDS, isAgentKind } from '../core/agents.ts';
import { audit, ignoreFinding, unignoreFinding } from '../core/audit.ts';
import { ConfigManager } from '../core/configs.ts';
import { defaultSourceDirs } from '../core/sources.ts';
import { defaultDbPath, type SearchOptions, Store } from '../core/store.ts';
import type { AgentKind, Role } from '../core/types.ts';
import { runConfig } from './config.ts';
import { runMemories, runProfile } from './profile.ts';
import { bold, color, day, dim, fail, tag } from './style.ts';

const HELP = `鱼巢 AgentNest —— 把多个 AI agent 的本地会话管在一起

用法：
  yuchao index                     扫描并增量索引各个 agent 的会话
  yuchao search <关键词...>        搜索对话（多个词需同时出现）
      --agent <名字>               只搜某个 agent（claude、codex、workbuddy、dsh）
      --tools                      同时搜索工具调用和工具输出
      --limit <n>                  最多显示多少条（默认 20）
  yuchao sessions                  按最近活动列出会话
      --agent <名字>  --limit <n>  --all（包含子 agent）
  yuchao show <会话 id>            查看一个会话的完整对话
      --tools                      同时显示工具调用
  yuchao stats                     索引统计
  yuchao scan                      扫描会话里泄露的密码、密钥和令牌（只显示打码后的内容）
      --all                        包括已标记为误报的
      --json                       输出 JSON
  yuchao scan ignore <指纹>        把一条发现标记为误报
  yuchao scan unignore <指纹>      取消误报标记
  yuchao memories                  查看 Claude 已经写下的关于你的记忆
  yuchao profile stats             本地统计：活跃时间、项目、常说的话（不调用大模型）
  yuchao profile preview           生成「将要发给大模型的内容」供检查，不发送
  yuchao profile models            列出接口上可用的 Claude 模型（支持 --claude-code-config）
  yuchao profile build --yes       调用大模型生成画像（会产生费用）
      --scope all|<agent>          按全部会话，或只按某个 agent 的会话生成（默认 all）
      --model <模型>|auto          默认 claude-opus-5-5；auto 从接口的模型列表里自动挑选
      --base-url <地址> --ask-key  使用指定的接口，并在终端里询问 key（不显示、不保存）
      --key-file <文件>            从文件读取 YUCHAO_BASE_URL、YUCHAO_API_KEY（可选 YUCHAO_PROVIDER）
      --provider anthropic|openai  接口格式；只提供 GPT 等模型的中转站用 openai
      --claude-code-config         复用 ~/.claude/settings.json 里 Claude Code 的接口地址和令牌
      --no-fallbacks               不使用服务端拒答回退（中转站不支持时使用）
  yuchao profile show [--scope]    查看最新画像和每条结论的出处
  yuchao profile diff [--scope]    对比最近两个版本
  yuchao profile export [--scope]  导出成可以放进 CLAUDE.md / AGENTS.md 的 Markdown
  yuchao config                    各 agent 配置文件的状态（Claude settings.json、Codex config.toml 等）
  yuchao config import             把旁边散落的旧备份导入版本时间线（原文件不动）
  yuchao config log <文件>         查看版本历史，文件名写一部分即可，例如 codex、settings
  yuchao config diff <文件> [旧] [新]  对比两个版本，默认对比最近版本和当前文件；current 表示当前文件
  yuchao config show <版本号>      查看某个版本的内容（已打码）
  yuchao config restore <版本号> --yes  回滚到某个版本，会先保存当前内容；损坏的版本需要 --force
  yuchao config track|untrack <路径>    增加或取消跟踪的配置文件
  yuchao score [--days 30] [--all]  成绩单：每个 agent、每个模型把事办成了多少，花了多少 token（--json 输出 JSON）
  yuchao handoff <会话id> [--to codex]  接力：把会话整理成交接说明，粘贴给另一个 agent 接着做（本地生成，已打码）
  yuchao server [名字]             服务器面板：服务、版本、磁盘、最近的异常（只读，--json 输出 JSON）
  yuchao server add <名字> <用户名@主机[:端口]> [--url https://域名]  添加服务器
  yuchao server setup [名字]       生成只读专用密钥，打印服务器上需要做的配置
  yuchao server list|remove        列出或移除服务器
  yuchao serve [--port 4317]       启动本地网页界面
  yuchao --version                 显示版本号

数据库位置：${defaultDbPath()}（可用环境变量 YUCHAO_DB 修改）`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: 'string' },
    tools: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    limit: { type: 'string' },
    port: { type: 'string', default: '4317' },
    json: { type: 'boolean', default: false },
    scope: { type: 'string', default: 'all' },
    model: { type: 'string' },
    'claude-code-config': { type: 'boolean', default: false },
    'no-fallbacks': { type: 'boolean', default: false },
    'base-url': { type: 'string' },
    'ask-key': { type: 'boolean', default: false },
    'key-file': { type: 'string' },
    provider: { type: 'string' },
    url: { type: 'string' },
    to: { type: 'string' },
    days: { type: 'string' },
    yes: { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
  },
});

const [cmd, ...rest] = positionals;
const agent = values.agent as AgentKind | undefined;
if (agent && !isAgentKind(agent)) fail(`未知的 agent：${agent}（可选 ${AGENT_KINDS.join('、')}）`);
const limit = values.limit ? Number(values.limit) : undefined;

const you = color('32')('你');
const them = color('35')('agent');

if (values.version) {
  console.log(`yuchao ${pkg.version} (node ${process.versions.node}, ${process.platform}-${process.arch})`);
  process.exit(0);
}

if (!cmd && !values.help && isSea()) {
  // 双击 yuchao.exe：更新索引，启动网页并打开浏览器
  import('./desktop.ts').then(({ runDesktop }) => runDesktop(Number(values.port))).catch((e) => fail(e?.stack ?? String(e)));
} else if (values.help || !cmd) {
  console.log(HELP);
  process.exit(0);
}

// 不用顶层 await：打包成单文件程序时，Node 只支持 CommonJS 入口
async function run(store: Store) {
  try {
    switch (cmd) {
      case 'index': {
        const r = await store.index(defaultSourceDirs(), (done, total) => {
          if (process.stderr.isTTY) process.stderr.write(`\r索引中 ${done}/${total}`);
        });
        if (process.stderr.isTTY) process.stderr.write('\n');
        console.log(
          `扫描 ${r.scanned} 个文件：新建或更新 ${r.indexed}，未变化跳过 ${r.skipped}，已删除 ${r.removed}，用时 ${(r.ms / 1000).toFixed(1)} 秒`,
        );
        for (const e of r.errors) console.log(`  解析失败 ${e.path}：${e.error}`);
        // 顺手给配置文件拍快照：每次索引都会经过这里，配置的变化就能自然积累成历史
        const snap = new ConfigManager(store, defaultSourceDirs()).snapshot();
        if (snap.recorded.length) console.log(`配置有变化，已记录新版本：${snap.recorded.join('、')}`);
        break;
      }
      case 'search': {
        const q = rest.join(' ');
        if (!q) fail('请输入要搜索的关键词');
        const opts: SearchOptions = { agent, limit: limit ?? 20 };
        if (values.tools) opts.roles = ['user', 'assistant', 'tool_call', 'tool_result'] satisfies Role[];
        const hits = store.search(q, opts);
        if (!hits.length) console.log('没有找到结果。如果刚用过 agent，先运行 yuchao index');
        for (const h of hits) {
          console.log(`${tag(h.agent)} ${bold(h.title ?? '(无标题)')} ${dim(day(h.ts))}`);
          console.log(`  ${dim(h.role + (h.toolName ? ':' + h.toolName : ''))} ${h.snippet}`);
          if (h.alsoIn) console.log(dim(`  （另有 ${h.alsoIn} 个分叉会话包含同一条消息）`));
          console.log(dim(`  yuchao show ${h.sessionId}`));
        }
        break;
      }
      case 'sessions': {
        for (const s of store.listSessions({ agent, includeSubagents: values.all, limit: limit ?? 30 })) {
          console.log(`${tag(s.agent)} ${dim(day(s.updatedAt))} ${bold(s.title ?? '(无标题)')} ${dim(`${s.messageCount} 条 · ${s.id}`)}`);
        }
        break;
      }
      case 'show': {
        const s = store.getSession(rest[0] ?? fail('请提供会话 id'));
        if (!s) fail(`找不到会话 ${rest[0]}`);
        console.log(`${tag(s.agent)} ${bold(s.title ?? '(无标题)')}`);
        console.log(dim(`${s.cwd ?? ''}  ${day(s.startedAt)} → ${day(s.updatedAt)}  ${s.sourcePath}`));
        for (const c of s.children) console.log(dim(`  子 agent：${c.title} (${c.id})`));
        const shown = new Set<string>(values.tools ? ['user', 'assistant', 'tool_call', 'tool_result'] : ['user', 'assistant']);
        for (const m of s.messages as any[]) {
          if (!shown.has(m.role)) continue;
          const who = m.role === 'user' ? you : m.role === 'assistant' ? them : dim(m.role + (m.toolName ? ':' + m.toolName : ''));
          console.log(`\n${who} ${dim(day(m.ts))}\n${m.text}`);
        }
        break;
      }
      case 'stats': {
        const st = store.stats();
        for (const r of st.sessions) console.log(`${tag(r.agent)} ${r.n} 个会话`);
        console.log(st.messages.map((r: any) => `${r.role} ${r.n}`).join('  '));
        console.log(dim(`时间跨度：${day(st.range.first)} → ${day(st.range.last)}`));
        break;
      }
      case 'scan': {
        const [sub, fp] = rest;
        if (sub === 'ignore' || sub === 'unignore') {
          if (!fp) fail('请提供指纹（yuchao scan 输出里的 16 位编号）');
          (sub === 'ignore' ? ignoreFinding : unignoreFinding)(store, fp);
          console.log(sub === 'ignore' ? `已标记为误报：${fp}` : `已取消误报标记：${fp}`);
          break;
        }
        if (sub) fail(`未知的子命令：scan ${sub}`);
        const r = audit(store, { includeIgnored: values.all });
        if (values.json) {
          console.log(JSON.stringify(r, null, 2));
          break;
        }
        const high = r.findings.filter((f) => f.severity === 'high');
        console.log(`扫描了 ${r.scannedMessages} 条消息和 ${r.scannedTitles} 个会话标题，用时 ${(r.ms / 1000).toFixed(1)} 秒`);
        console.log(
          `发现 ${r.findings.length} 个不同的秘密，其中高风险 ${high.length} 个` + (r.ignored ? `；另有 ${r.ignored} 处已标记为误报` : ''),
        );
        for (const f of r.findings) {
          const sev = f.severity === 'high' ? color('31')('高风险') : color('33')('中风险');
          console.log(`
  ${sev} ${bold(f.ruleName)} ${f.masked}  ${dim(`指纹 ${f.fingerprint}`)}`);
          console.log(dim(`  出现 ${f.count} 次，涉及 ${f.sessionCount} 个会话，${day(f.firstSeen)} → ${day(f.lastSeen)}`));
          for (const o of f.occurrences.slice(0, 3)) {
            console.log(`  ${dim(o.where === 'title' ? '会话标题' : o.where)} ${o.context}`);
            console.log(dim(`    ${o.title ?? ''}  yuchao show ${o.sessionId}`));
          }
          if (f.occurrences.length > 3) console.log(dim(`  …还有 ${f.count - 3} 处`));
        }
        break;
      }
      case 'config':
        runConfig(store, rest, values);
        break;
      case 'score': {
        const { runScore } = await import('./score.ts');
        const days = values.days ? Number(values.days) : undefined;
        if (days !== undefined && !(days > 0)) fail('--days 要是正数，例如 --days 30');
        runScore(store, { days, agent, json: values.json, all: values.all });
        break;
      }
      case 'handoff': {
        const { buildHandoff } = await import('../core/handoff.ts');
        if (values.to && !isAgentKind(values.to)) fail(`未知的 agent：${values.to}（可选 ${AGENT_KINDS.join('、')}）`);
        const { latestWorkSession } = await import('../core/handoff.ts');
        const id = rest[0] === 'latest' ? latestWorkSession(store) : rest[0];
        if (!id) fail('用法：yuchao handoff <会话id|latest> [--to codex]（会话 id 可以用 yuchao sessions 查看）');
        const h = buildHandoff(store, id, { to: values.to });
        if (!h) fail(`找不到会话 ${id}`);
        console.log(h.markdown);
        console.error(
          dim(`
约 ${h.chars} 字、${h.tokens} token。可以重定向到文件，或者用 | clip 复制到剪贴板。`),
        );
        break;
      }
      case 'server': {
        const { runServer } = await import('./server.ts');
        await runServer(store, rest, values);
        break;
      }
      case 'memories':
        runMemories();
        break;
      case 'profile':
        await runProfile(store, rest[0], values);
        break;
      case 'serve': {
        const { serve } = await import('../server/main.ts');
        store.close();
        await serve(Number(values.port)).catch((e) => {
          if (e.code === 'EADDRINUSE') fail(`端口 ${values.port} 已被占用：鱼巢可能已经在运行，或者用 --port 换一个端口`);
          throw e;
        });
        break;
      }
      default:
        fail(`未知命令：${cmd}\n\n${HELP}`);
    }
  } finally {
    if (cmd !== 'serve') store.close();
  }
}

if (cmd) run(new Store()).catch((e) => fail(e?.stack ?? String(e)));
