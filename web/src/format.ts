/** 今年的时间省略年份，例如「11/9 10:41」 */
export function when(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString('zh-CN', {
    year: sameYear ? undefined : 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
