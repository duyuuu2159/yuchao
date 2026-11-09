#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { defaultSourceDirs } from '../core/sources.ts';
import { defaultDbPath, Store, type SearchOptions } from '../core/store.ts';
import type { AgentKind, Role } from '../core/types.ts';

const HELP = `鱼巢 AgentNest —— 把多个 AI agent 的本地会话管在一起

用法：
  yuchao index                     扫描并增量索引 Claude Code / Codex 的会话
  yuchao search <关键词...>        搜索对话（多个词需同时出现）
      --agent claude|codex         只搜某个 agent
      --tools                      同时搜索工具调用和工具输出
      --limit <n>                  最多显示多少条（默认 20）
  yuchao sessions                  按最近活动列出会话
      --agent claude|codex  --limit <n>  --all（包含子 agent）
  yuchao show <会话 id>            查看一个会话的完整对话
      --tools                      同时显示工具调用
  yuchao stats                     索引统计
  yuchao serve [--port 4317]       启动本地网页界面

数据库位置：${defaultDbPath()}（可用环境变量 YUCHAO_DB 修改）`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: 'string' },
    tools: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    limit: { type: 'string' },
    port: { type: 'string', default: '4317' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const [cmd, ...rest] = positionals;
const agent = values.agent as AgentKind | undefined;
if (agent && agent !== 'claude' && agent !== 'codex') fail(`未知的 agent：${agent}`);
const limit = values.limit ? Number(values.limit) : undefined;

// 输出到管道或文件时不带颜色控制符
const color = (code: string) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = color('2');
const bold = color('1');
const tag = (a: string) => (a === 'claude' ? color('33')('claude') : color('36')('codex '));
const you = color('32')('你');
const them = color('35')('agent');
const day = (ts: string | null) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—');

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (values.help || !cmd) {
  console.log(HELP);
  process.exit(0);
}

const store = new Store();
try {
  switch (cmd) {
    case 'index': {
      const r = await store.index(defaultSourceDirs(), (done, total) => {
        if (process.stderr.isTTY) process.stderr.write(`\r索引中 ${done}/${total}`);
      });
      if (process.stderr.isTTY) process.stderr.write('\n');
      console.log(`扫描 ${r.scanned} 个文件：新建或更新 ${r.indexed}，未变化跳过 ${r.skipped}，已删除 ${r.removed}，用时 ${(r.ms / 1000).toFixed(1)} 秒`);
      for (const e of r.errors) console.log(`  解析失败 ${e.path}：${e.error}`);
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
    case 'serve': {
      const { serve } = await import('../server/main.ts');
      store.close();
      await serve(Number(values.port));
      break;
    }
    default:
      fail(`未知命令：${cmd}\n\n${HELP}`);
  }
} finally {
  if (cmd !== 'serve') store.close();
}
