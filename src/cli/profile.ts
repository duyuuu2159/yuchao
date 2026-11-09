import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT_KINDS, agentLabel, isAgentKind } from '../core/agents.ts';
import { readMemories } from '../core/memories.ts';
import { activityStats } from '../core/profile/evidence.ts';
import { buildProfile, ProfileBuildError, diffProfiles, exportMarkdown, latestProfile, previewPayload, profileHistory, type Scope } from '../core/profile/build.ts';
import { AnthropicLlm, claudeCodeSettingsPath, DEFAULT_MODEL, pickModel, readClaudeCodeConnection, type AnthropicOptions } from '../core/profile/llm.ts';
import { defaultSourceDirs } from '../core/sources.ts';
import { defaultDbPath, type Store } from '../core/store.ts';
import { OpenAiCompatibleLlm } from '../core/profile/openai.ts';
import type { LlmClient } from '../core/profile/llm.ts';
import { askSecret } from './secret.ts';
import { bold, color, day, dim, fail, tag } from './style.ts';

interface ProfileFlags {
  scope?: string;
  model?: string;
  'claude-code-config'?: boolean;
  'no-fallbacks'?: boolean;
  'base-url'?: string;
  'ask-key'?: boolean;
  'key-file'?: string;
  provider?: string;
  yes?: boolean;
}

/** anthropic：Claude 官方格式（默认）；openai：/v1/chat/completions 格式，例如只提供 GPT 模型的中转站 */
function makeLlm(conn: AnthropicOptions, model: string, provider: string): LlmClient {
  if (provider === 'anthropic') return new AnthropicLlm({ ...conn, model });
  if (provider !== 'openai') fail(`未知的接口格式：${provider}（可选 anthropic、openai）`);
  if (!conn.baseURL || !conn.apiKey) fail('OpenAI 兼容接口需要 --key-file，或者 --base-url 加 --ask-key');
  return new OpenAiCompatibleLlm({ baseURL: conn.baseURL, apiKey: conn.apiKey, model });
}

const MEMORY_TYPE: Record<string, string> = { user: '关于你', feedback: '做事要求', project: '项目', reference: '参考', other: '其他' };

export function runMemories() {
  const ms = readMemories(defaultSourceDirs());
  if (!ms.length) return console.log('没有找到 agent 的记忆文件。');
  const counts = AGENT_KINDS.map((k) => [k, ms.filter((m) => m.agent === k).length] as const).filter(([, n]) => n);
  console.log(`共 ${ms.length} 条记忆：${counts.map(([k, n]) => `${agentLabel(k)} ${n} 条`).join('，')}`);
  for (const m of ms) {
    console.log(`\n${tag(m.agent)} ${bold(m.name)} ${dim(`[${MEMORY_TYPE[m.type]}] ${m.project ? m.project + ' · ' : ''}${day(m.modified)}`)}`);
    if (m.description) console.log(`  ${m.description}`);
  }
}

function parseScope(s: string | undefined): Scope {
  if (s === undefined || s === 'all' || isAgentKind(s)) return s ?? 'all';
  fail(`未知的范围：${s}（可选 all、${AGENT_KINDS.join('、')}）`);
}

/** 告诉用户数据会发到哪里，只显示主机名 */
function destination(flags: ProfileFlags): string {
  if (flags['base-url']) return new URL(flags['base-url']).host;
  const fromFile = flags['key-file'] && readKeyFile(flags['key-file']).YUCHAO_BASE_URL;
  if (fromFile) return new URL(fromFile).host;
  const base = flags['claude-code-config'] ? readClaudeCodeConnection(claudeCodeSettingsPath(defaultSourceDirs().claude!)).baseURL : process.env.ANTHROPIC_BASE_URL;
  return base ? new URL(base).host : 'api.anthropic.com';
}

/** 读取 `KEY=VALUE` 格式的 key 文件；# 开头的是注释 */
export function readKeyFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^['"](.*)['"]$/, '$1');
  }
  return out;
}

/**
 * 连接方式，优先级：--key-file > --base-url / --ask-key > --claude-code-config > 环境变量。
 * --ask-key 在终端里询问 key，key 不经过命令行参数，所以不会留在命令历史里。
 */
async function connect(flags: ProfileFlags): Promise<AnthropicOptions> {
  const opts: AnthropicOptions = { fallbacks: !flags['no-fallbacks'] };
  if (flags['key-file']) {
    const conf = readKeyFile(flags['key-file']);
    if (!conf.YUCHAO_API_KEY) fail(`${flags['key-file']} 里的 YUCHAO_API_KEY 还是空的，粘贴 key 后保存再运行。`);
    opts.baseURL = (flags['base-url'] ?? conf.YUCHAO_BASE_URL)?.replace(/\/v1\/?$/, '');
    opts.apiKey = conf.YUCHAO_API_KEY;
  } else if (flags['base-url'] || flags['ask-key']) {
    // SDK 会自己拼上 /v1/messages，用户照抄中转站给的 .../v1 地址时去掉结尾的 /v1
    opts.baseURL = flags['base-url']?.replace(/\/v1\/?$/, '');
    if (flags['ask-key']) opts.apiKey = await askSecret(`请粘贴 ${destination(flags)} 的 key（不会显示），然后按回车：`);
    if (flags['ask-key'] && !opts.apiKey) fail('没有输入 key');
  } else if (flags['claude-code-config']) {
    opts.claudeCodeConfig = claudeCodeSettingsPath(defaultSourceDirs().claude!);
  }
  return opts;
}

/** 根据接口返回的错误，给出下一步建议 */
export function hint(error: string): string {
  if (/\b429\b|credit|余额|quota|充值/i.test(error)) return '建议：接口的额度或余额不足，请到对应平台充值，或换一个接口。';
  if (/\b40[13]\b|auth|token|key/i.test(error)) return '建议：key 无效或没有权限，检查 key 是否正确、是否已作废。';
  if (/\b404\b|model/i.test(error)) return '建议：模型名可能不对，运行 yuchao profile models 查看可用的模型。';
  if (/fallback|beta/i.test(error)) return '建议：接口可能不支持拒答回退，加上 --no-fallbacks 重试。';
  return '建议：检查网络和接口地址后重试。';
}

function printProfile(store: Store, scope: Scope) {
  const v = latestProfile(store, scope);
  if (!v) return console.log(`还没有生成过画像（范围 ${scope}）。先运行 yuchao profile build`);
  console.log(bold(v.profile.headline));
  console.log(dim(`版本 #${v.id} · ${day(v.createdAt)} · ${v.meta.model} · 依据 ${v.meta.sessions} 个会话`));
  for (const s of v.profile.sections) {
    console.log(`\n${bold(s.title)}`);
    for (const c of s.claims) {
      console.log(`  · ${c.text}`);
      console.log(dim(`      出处：${c.evidence.map((e) => `${e.title}（${e.sessionId}）`).join('；')}`));
    }
  }
}

export async function runProfile(store: Store, sub: string | undefined, flags: ProfileFlags) {
  const scope = parseScope(flags.scope);
  switch (sub) {
    case 'stats': {
      const st = activityStats(store);
      console.log(`${st.firstDay} → ${st.lastDay}，活跃 ${bold(String(st.activeDays))} 天，亲手写了 ${bold(String(st.userMessages))} 条消息（中位数 ${st.medianLength} 字）`);
      console.log(`会话：${AGENT_KINDS.filter((k) => st.sessions[k]).map((k) => `${agentLabel(k)} ${st.sessions[k]}`).join('  ')}`);
      const peak = st.byHour.indexOf(Math.max(...st.byHour));
      console.log(`最活跃的时段：${peak}:00–${peak + 1}:00`);
      console.log('\n各时段消息数：');
      const max = Math.max(...st.byHour, 1);
      st.byHour.forEach((n, h) => console.log(`  ${String(h).padStart(2)}点 ${'█'.repeat(Math.round((n / max) * 30))} ${dim(String(n))}`));
      console.log(`\n项目：${st.topProjects.map((p) => `${p.name}(${p.sessions})`).join('  ')}`);
      console.log(`agent 最常用的工具：${st.topTools.map((t) => `${t.name}(${t.calls})`).join('  ')}`);
      console.log(`你最常说的话：${st.topPhrases.map((p) => `「${p.text}」×${p.count}`).join('  ')}`);
      break;
    }
    case 'preview': {
      const p = previewPayload(store, scope);
      const out = join(dirname(defaultDbPath()), 'profile-preview.txt');
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `【系统提示词，每个会话都会附带】\n${p.system}\n\n` + p.sessions.map((s, i) => `【第 ${i + 1} 个会话 ${s.sessionId}】\n${s.text}`).join('\n\n'));
      console.log(`将发送 ${p.sessions.length} 个会话、约 ${p.chars.toLocaleString()} 字（只有你写的话，已打码）。`);
      console.log(`完整内容已写到 ${out}，发送前可以先打开检查。`);
      break;
    }
    case 'build': {
      const p = previewPayload(store, scope);
      const dest = destination(flags);
      const wanted = flags.model ?? DEFAULT_MODEL;
      if (!flags.yes) {
        console.log(`将把 ${p.sessions.length} 个会话中你写的话（约 ${p.chars.toLocaleString()} 字，已打码）发送到 ${bold(dest)}，使用模型 ${wanted === 'auto' ? '（自动从接口上挑选）' : wanted}。`);
        console.log('已经总结过且没有变化的会话会直接用缓存，不会重复发送。');
        console.log(`确认后加上 --yes 重新运行。想先看具体内容，运行 yuchao profile preview`);
        return;
      }
      const conn = await connect(flags);
      const provider = flags.provider ?? (flags['key-file'] && readKeyFile(flags['key-file']).YUCHAO_PROVIDER) ?? 'anthropic';
      let model = wanted;
      if (model === 'auto') {
        if (provider === 'openai') fail('OpenAI 兼容接口需要用 --model 指定模型名，可以先运行 yuchao profile models 查看。');
        const picked = pickModel(await new AnthropicLlm(conn).listModels());
        if (!picked) fail(`${dest} 上没有可用的 Claude 模型。如果它只提供 GPT 等模型，加上 --provider openai --model <模型名>。`);
        model = picked;
      }
      const llm = makeLlm(conn, model, provider);
      console.error(`发送到 ${dest}，模型 ${model}`);
      let v;
      try {
        v = await buildProfile(store, llm, {
          scope,
          onProgress: (done, total) => process.stderr.isTTY && process.stderr.write(`\r总结会话 ${done}/${total}`),
        });
      } catch (e: any) {
        if (process.stderr.isTTY) process.stderr.write('\n');
        if (e instanceof ProfileBuildError) fail(`${e.message}\n${hint(e.firstError)}`);
        // 汇总那一步失败时，已经总结好的会话都在缓存里，重跑不会重复花钱
        fail(`生成失败：${e.message ?? e}\n已经总结好的会话已缓存，重新运行会从缓存继续。`);
      }
      if (process.stderr.isTTY) process.stderr.write('\n');
      const m = v.meta;
      console.log(`完成：新总结 ${m.notesGenerated} 个会话，复用缓存 ${m.notesCached} 个，失败 ${m.notesFailed.length} 个；用时 ${(m.ms / 1000).toFixed(0)} 秒`);
      console.log(`token：输入 ${m.usage.input.toLocaleString()}，输出 ${m.usage.output.toLocaleString()}`);
      console.log(`引用校验：剔除了 ${m.droppedCitations} 个不存在的引用，丢掉了 ${m.droppedClaims} 条没有依据的结论`);
      for (const f of m.notesFailed.slice(0, 5)) console.log(color('31')(`  失败 ${f.sessionId}：${f.error}`));
      console.log('');
      printProfile(store, scope);
      break;
    }
    case 'models': {
      const ids = await new AnthropicLlm(await connect(flags)).listModels();
      const claude = ids.filter((id) => /claude/i.test(id));
      console.log(`${destination(flags)} 上有 ${ids.length} 个模型，其中 Claude 模型 ${claude.length} 个：`);
      for (const id of claude) console.log(`  ${id}`);
      const picked = pickModel(ids);
      if (picked) console.log(dim(`--model auto 会选择：${picked}`));
      break;
    }
    case 'show':
      printProfile(store, scope);
      break;
    case 'diff': {
      const [newer, older] = profileHistory(store, scope);
      if (!older) return console.log('至少要有两个版本才能对比。');
      const d = diffProfiles(older.profile, newer.profile);
      console.log(dim(`#${older.id}（${day(older.createdAt)}） → #${newer.id}（${day(newer.createdAt)}）`));
      for (const t of d.added) console.log(color('32')(`+ ${t}`));
      for (const t of d.removed) console.log(color('31')(`- ${t}`));
      if (!d.added.length && !d.removed.length) console.log('结论没有变化。');
      break;
    }
    case 'export': {
      const v = latestProfile(store, scope);
      if (!v) fail('还没有生成过画像。先运行 yuchao profile build');
      console.log(exportMarkdown(v, activityStats(store)));
      break;
    }
    default:
      fail('用法：yuchao profile stats|preview|models|build|show|diff|export，详见 yuchao --help');
  }
}
