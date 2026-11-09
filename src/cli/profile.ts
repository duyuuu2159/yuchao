import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readClaudeMemories } from '../core/memories.ts';
import { activityStats } from '../core/profile/evidence.ts';
import { buildProfile, diffProfiles, exportMarkdown, latestProfile, previewPayload, profileHistory, type Scope } from '../core/profile/build.ts';
import { AnthropicLlm, claudeCodeSettingsPath, DEFAULT_MODEL, readClaudeCodeConnection } from '../core/profile/llm.ts';
import { defaultSourceDirs } from '../core/sources.ts';
import { defaultDbPath, type Store } from '../core/store.ts';
import { bold, color, day, dim, fail, tag } from './style.ts';

interface ProfileFlags {
  scope?: string;
  model?: string;
  'claude-code-config'?: boolean;
  'no-fallbacks'?: boolean;
  yes?: boolean;
}

const MEMORY_TYPE: Record<string, string> = { user: '关于你', feedback: '做事要求', project: '项目', reference: '参考', other: '其他' };

export function runMemories() {
  const ms = readClaudeMemories(defaultSourceDirs().claudeDir);
  if (!ms.length) return console.log('没有找到 Claude 的记忆文件。');
  console.log(`Claude 在 ${new Set(ms.map((m) => m.project)).size} 个项目里写下了 ${ms.length} 条记忆：`);
  for (const m of ms) {
    console.log(`\n${bold(m.name)} ${dim(`[${MEMORY_TYPE[m.type]}] ${m.project} · ${day(m.modified)}`)}`);
    if (m.description) console.log(`  ${m.description}`);
  }
}

function parseScope(s: string | undefined): Scope {
  if (s === undefined || s === 'all' || s === 'claude' || s === 'codex') return s ?? 'all';
  fail(`未知的范围：${s}（可选 all、claude、codex）`);
}

/** 告诉用户数据会发到哪里，只显示主机名 */
function destination(flags: ProfileFlags): string {
  const base = flags['claude-code-config'] ? readClaudeCodeConnection(claudeCodeSettingsPath(defaultSourceDirs().claudeDir)).baseURL : process.env.ANTHROPIC_BASE_URL;
  return base ? new URL(base).host : 'api.anthropic.com';
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
      console.log(`会话：${tag('claude')} ${st.sessions.claude}  ${tag('codex')} ${st.sessions.codex}`);
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
      const model = flags.model ?? DEFAULT_MODEL;
      const dest = destination(flags);
      if (!flags.yes) {
        console.log(`将把 ${p.sessions.length} 个会话中你写的话（约 ${p.chars.toLocaleString()} 字，已打码）发送到 ${bold(dest)}，使用模型 ${model}。`);
        console.log('已经总结过且没有变化的会话会直接用缓存，不会重复发送。');
        console.log(`确认后加上 --yes 重新运行。想先看具体内容，运行 yuchao profile preview`);
        return;
      }
      const llm = new AnthropicLlm({
        model,
        fallbacks: !flags['no-fallbacks'],
        claudeCodeConfig: flags['claude-code-config'] ? claudeCodeSettingsPath(defaultSourceDirs().claudeDir) : undefined,
      });
      console.error(`发送到 ${dest}，模型 ${model}`);
      const v = await buildProfile(store, llm, {
        scope,
        onProgress: (done, total) => process.stderr.isTTY && process.stderr.write(`\r总结会话 ${done}/${total}`),
      });
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
      fail('用法：yuchao profile stats|preview|build|show|diff|export，详见 yuchao --help');
  }
}
