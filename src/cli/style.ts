// 命令行输出的颜色和格式。输出到管道或文件时不带颜色控制符。

export const color = (code: string) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = color('2');
export const bold = color('1');
export const tag = (a: string) => (a === 'claude' ? color('33')('claude') : color('36')('codex '));
export const day = (ts: string | null) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—');

export function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}
