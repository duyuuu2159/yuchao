// 命令行输出的颜色和格式。输出到管道或文件时不带颜色控制符。

export const color = (code: string) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = color('2');
export const bold = color('1');
const AGENT_COLOR: Record<string, string> = { claude: '33', codex: '36', workbuddy: '34', dsh: '35' };
/** 等宽的 agent 标签，让后面的标题对齐 */
export const tag = (a: string) => color(AGENT_COLOR[a] ?? '37')(a.padEnd(9));
export const day = (ts: string | null) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—');

export function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
