import { ConfigManager, type ConfigVersion, hasNul, redactConfig, type TrackedFile } from '../core/configs.ts';
import { diffText } from '../core/diff.ts';
import { defaultSourceDirs } from '../core/sources.ts';
import type { Store } from '../core/store.ts';
import { bold, color, day, dim, fail } from './style.ts';

interface ConfigFlags {
  yes?: boolean;
  force?: boolean;
}

const SOURCE_LABEL: Record<ConfigVersion['source'], string> = {
  snapshot: '快照',
  backup: '旧备份',
  'before-restore': '回滚前',
  restore: '回滚',
};

const red = color('31');
const green = color('32');
const cyan = color('36');

/** 文件名写一部分就行，例如 codex、settings、AGENTS */
function pickFile(cfg: ConfigManager, query: string | undefined): TrackedFile {
  if (!query) fail('请指定配置文件，例如 codex、settings、AGENTS（运行 yuchao config 查看列表）');
  const files = cfg.tracked();
  const q = query.toLowerCase();
  const exact = files.filter((f) => f.name.toLowerCase().endsWith(q) || f.path.toLowerCase() === q);
  const hits = exact.length ? exact : files.filter((f) => f.name.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (!hits.length) fail(`没有匹配「${query}」的配置文件`);
  fail(`「${query}」匹配到多个文件，请写得更具体：\n${hits.map((f) => '  ' + f.name).join('\n')}`);
}

function versionLine(v: ConfigVersion) {
  const state = v.error ? red('损坏') : green('正常');
  const line = `${cyan('#' + v.id)} ${day(v.capturedAt)} ${state} ${dim(SOURCE_LABEL[v.source])} ${v.label} ${dim(`${v.size} 字节`)}`;
  return v.error ? `${line}\n      ${red(v.error)}` : line;
}

function printDiff(oldText: string, newText: string, oldName: string, newName: string) {
  console.log(dim(`--- ${oldName}\n+++ ${newName}`));
  for (const [text, name] of [
    [oldText, oldName],
    [newText, newName],
  ]) {
    if (hasNul(text)) return console.log(red(`${name} 含有空字节（已损坏），无法逐行对比。`));
  }
  const d = diffText(redactConfig(oldText), redactConfig(newText));
  if (!d.hunks.length) return console.log('内容相同。');
  for (const h of d.hunks) {
    console.log(cyan(`@@ 原第 ${h.oldStart} 行 / 新第 ${h.newStart} 行 @@`));
    for (const l of h.lines)
      console.log(l.kind === 'add' ? green('+ ' + l.text) : l.kind === 'del' ? red('- ' + l.text) : dim('  ' + l.text));
  }
  console.log(dim(`共新增 ${d.added} 行，删除 ${d.removed} 行（key、密码等已打码）`));
}

/** 'current' 表示磁盘上的当前文件 */
function load(cfg: ConfigManager, file: TrackedFile, ref: string): { text: string; name: string } {
  if (ref === 'current') return { text: cfg.currentContent(file.path), name: `${file.name}（当前）` };
  const id = Number(ref.replace(/^#/, ''));
  const v = cfg.version(id);
  if (!v || v.path !== file.path) fail(`${file.name} 没有版本 #${ref}`);
  return { text: cfg.rawContent(id), name: `#${id} ${v.label}` };
}

export function runConfig(store: Store, args: string[], flags: ConfigFlags) {
  const cfg = new ConfigManager(store, defaultSourceDirs());
  const [sub = 'status', a, b, c] = args;
  switch (sub) {
    case 'status': {
      for (const s of cfg.status()) {
        if (!s.exists && !s.versions) {
          console.log(`${dim(s.name)} ${dim('（不存在）')}`);
          continue;
        }
        const state = !s.exists
          ? red('已删除')
          : s.error
            ? red(`当前文件损坏：${s.error}`)
            : s.changed
              ? color('33')('有未记录的修改')
              : green('正常');
        console.log(`${bold(s.name)} ${state} ${dim(`${s.versions} 个版本${s.latest ? '，最近 ' + day(s.latest.capturedAt) : ''}`)}`);
      }
      console.log(dim('\nyuchao config import 导入旁边的旧备份；yuchao config log <文件> 查看历史'));
      break;
    }
    case 'snapshot': {
      const r = cfg.snapshot();
      console.log(r.recorded.length ? `记录了新版本：${r.recorded.join('、')}` : '没有变化。');
      break;
    }
    case 'import': {
      const r = cfg.importBackups();
      console.log(
        `导入 ${r.imported} 个旧备份（其中 ${r.broken} 个格式损坏），${r.duplicates} 个和已有版本内容相同已跳过。原备份文件没有改动。`,
      );
      break;
    }
    case 'log': {
      const file = pickFile(cfg, a);
      const vs = cfg.versions(file.path);
      console.log(`${bold(file.name)} 共 ${vs.length} 个版本，从新到旧：`);
      for (const v of vs) console.log('  ' + versionLine(v));
      break;
    }
    case 'show': {
      const id = Number(a?.replace(/^#/, ''));
      const v = cfg.version(id);
      if (!v) fail(`没有版本 #${a}`);
      console.log(dim(versionLine(v)));
      console.log(redactConfig(cfg.rawContent(id)));
      break;
    }
    case 'diff': {
      // config diff <文件> [旧版本] [新版本]，默认对比最近记录的版本和当前文件
      const file = pickFile(cfg, a);
      const latest = cfg.versions(file.path)[0];
      const from = load(cfg, file, b ?? (latest ? String(latest.id) : 'current'));
      const to = load(cfg, file, c ?? 'current');
      printDiff(from.text, to.text, from.name, to.name);
      break;
    }
    case 'restore': {
      const id = Number(a?.replace(/^#/, ''));
      const v = cfg.version(id);
      if (!v) fail(`没有版本 #${a}`);
      const name = cfg.tracked().find((f) => f.path === v.path)?.name ?? v.path;
      if (!flags.yes) {
        console.log(`将把 ${bold(name)} 回滚到 ${versionLine(v)}，改动如下：\n`);
        printDiff(cfg.currentContent(v.path), cfg.rawContent(id), `${name}（当前）`, `#${id}`);
        if (v.error) console.log(red(`\n注意：这个版本格式有误（${v.error}），需要加 --force 才能回滚。`));
        console.log(`\n当前内容会先自动保存成一个版本，回滚之后也能撤销。确认后加上 --yes 重新运行。`);
        console.log(dim('如果对应的程序（Claude Code、Codex）正在运行，建议先关掉，免得它退出时又把配置写回去。'));
        return;
      }
      try {
        const r = cfg.restore(id, { force: flags.force });
        console.log(green(`已把 ${name} 回滚到 #${id}。`));
        if (r.before) console.log(`回滚前的内容保存为 #${r.before.id}，想撤销就运行：yuchao config restore ${r.before.id} --yes`);
      } catch (e: any) {
        fail(e.message);
      }
      break;
    }
    case 'track':
    case 'untrack': {
      if (!a) fail(`用法：yuchao config ${sub} <文件路径>`);
      try {
        sub === 'track' ? cfg.track(a) : cfg.untrack(a);
      } catch (e: any) {
        fail(e.message);
      }
      console.log(sub === 'track' ? `开始跟踪 ${a}` : `不再跟踪 ${a}（已有的版本记录保留）`);
      break;
    }
    default:
      fail('用法：yuchao config [status|import|snapshot|log|show|diff|restore|track|untrack]，详见 yuchao --help');
  }
}
