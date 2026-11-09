import { execFile } from 'node:child_process';
import { ConfigManager } from '../core/configs.ts';
import { defaultSourceDirs } from '../core/sources.ts';
import { Store } from '../core/store.ts';
import { serve } from '../server/main.ts';

/** 用系统默认浏览器打开网址 */
export function openBrowser(url: string) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, { windowsHide: true }, () => {});
}

/**
 * 双击 yuchao.exe 时运行：增量更新索引、记录配置变化，然后启动本地网页并打开浏览器。
 * 已经有一个鱼巢在运行（端口被占用）时，直接打开它的页面。
 */
export async function runDesktop(port: number) {
  const url = `http://127.0.0.1:${port}`;
  console.log('鱼巢 AgentNest\n');

  const store = new Store();
  try {
    console.log('正在更新索引（第一次会比较久，之后只处理有变化的会话）…');
    let shown = 0;
    const r = await store.index(defaultSourceDirs(), (done, total) => {
      const pct = Math.floor((done / total) * 10) * 10;
      if (pct > shown) process.stdout.write(`  ${(shown = pct)}%`);
    });
    console.log(`\n已更新 ${r.indexed} 个会话文件，${r.skipped} 个没有变化，用时 ${(r.ms / 1000).toFixed(1)} 秒`);
    if (r.errors.length) console.log(`${r.errors.length} 个文件解析失败，可以在命令行运行 yuchao index 查看详情`);
    new ConfigManager(store, defaultSourceDirs()).snapshot();
  } finally {
    store.close();
  }

  try {
    await serve(port);
  } catch (e: any) {
    if (e.code !== 'EADDRINUSE') throw e;
    console.log(`端口 ${port} 已被占用，应该是鱼巢已经在运行，直接打开它。`);
    openBrowser(url);
    return;
  }
  openBrowser(url);
  console.log('\n浏览器没有自动打开的话，手动访问上面的地址。关闭这个窗口即可退出。');
}
