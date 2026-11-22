// yuchao guard：Claude Code 的 Stop hook（守门），以及安装、卸载、查看状态。

import { join } from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';
import { ConfigManager } from '../core/configs.ts';
import { checkStop, guardInstalled, installGuard, logBlock, readGuardLog, uninstallGuard } from '../core/guard.ts';
import { defaultSourceDirs } from '../core/sources.ts';
import { Store } from '../core/store.ts';
import { bold, dim, fail } from './style.ts';

const settingsPath = () => join(defaultSourceDirs().claude!, 'settings.json');

/** 写进 settings.json 的命令：单文件程序直接调用自己，开发时用 node 运行入口脚本 */
export function hookCommand(): string {
  if (isSea()) return `"${process.execPath}" guard`;
  return `"${process.execPath}" "${fileURLToPath(new URL('./main.ts', import.meta.url))}" guard`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** 被 Claude Code 调用：读标准输入里的 hook 参数，需要拦就输出 {"decision":"block"} */
async function runHook() {
  try {
    const input = JSON.parse((await readStdin()) || '{}');
    const d = await checkStop(input);
    if (!d) return;
    try {
      logBlock({ at: new Date().toISOString(), sessionId: input.session_id ?? null, verdict: d.claim.verdict, seq: d.claim.seq });
    } catch {
      // 记不下日志不影响拦截
    }
    process.stdout.write(JSON.stringify({ decision: d.decision, reason: d.reason }));
  } catch {
    // 鱼巢自己出错时放行，绝不因为鱼巢的 bug 卡住 agent
  }
}

function status() {
  const path = settingsPath();
  const on = guardInstalled(path);
  const log = readGuardLog();
  console.log(`${bold('守门')}  ${on ? '已装上' : '没有装'}（${path}）`);
  console.log(
    dim(`拦下过 ${log.length} 次${log.length ? `，最近一次 ${new Date(log.at(-1)!.at).toLocaleString('zh-CN', { hour12: false })}` : ''}`),
  );
  if (!on) console.log(dim('装上：yuchao guard install --yes'));
}

export async function runGuard(args: string[], values: { yes?: boolean }) {
  const [sub] = args;
  if (!sub) {
    // 在终端里直接运行时没有 hook 参数可读，显示状态
    if (process.stdin.isTTY) return status();
    return runHook();
  }
  const path = settingsPath();
  switch (sub) {
    case 'status':
      return status();
    case 'install': {
      const command = hookCommand();
      if (!values.yes) {
        console.log(`将在 ${path} 里加一条 Stop hook：\n\n  ${command}\n`);
        console.log(
          'Claude 说「测试通过」准备停下时，鱼巢核对它这一轮的记录；最后一次测试其实失败了、或者改完代码一条命令都没跑，就把它拦回去重新确认。',
        );
        console.log('只读会话记录，不跑测试、不联网。改动前会先用配置管家给 settings.json 记一个版本，随时可以回滚。');
        console.log(dim('\n确认后加上 --yes 再运行一次'));
        return;
      }
      // 先记一版，出了问题可以 yuchao config restore
      const store = new Store();
      try {
        new ConfigManager(store, defaultSourceDirs()).snapshot();
      } finally {
        store.close();
      }
      const r = installGuard(path, command);
      console.log(`${r === 'installed' ? '已装上' : '已更新'}守门：${path}`);
      console.log(dim('改动前的版本已记在配置管家里（yuchao config log .claude/settings）。新开的 Claude Code 会话生效。'));
      return;
    }
    case 'uninstall': {
      if (!values.yes) return console.log(`将从 ${path} 里删掉鱼巢的 Stop hook，其它设置不动。确认后加上 --yes 再运行一次`);
      console.log(uninstallGuard(path) ? '已卸下守门' : '没有装守门，什么都没改');
      return;
    }
    default:
      fail(`未知的子命令：guard ${sub}（可用 install、uninstall、status）`);
  }
}
