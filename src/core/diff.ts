// 逐行对比两段文本，输出类似 git diff 的分块结果。
// 配置文件通常只有几百行，最长公共子序列（LCS）足够快；先去掉首尾相同的行，进一步缩小计算量。

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null };

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffResult {
  added: number;
  removed: number;
  hunks: Hunk[];
}

const MAX_CELLS = 25_000_000;

function lineDiff(a: string[], b: string[]): DiffLine[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: 'same', text: a[i], oldNo: i + 1, newNo: i + 1 });

  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS) {
    // 太大时退化为「整段删除 + 整段新增」，结果仍然正确，只是不够精细
    for (const [i, t] of midA.entries()) out.push({ kind: 'del', text: t, oldNo: start + i + 1, newNo: null });
    for (const [j, t] of midB.entries()) out.push({ kind: 'add', text: t, oldNo: null, newNo: start + j + 1 });
  } else {
    // lcs[i][j] = midA[i..] 与 midB[j..] 的最长公共子序列长度
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = midA[i] === midB[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ kind: 'same', text: midA[i], oldNo: start + i + 1, newNo: start + j + 1 });
        i++;
        j++;
      } else if (j < m && (i === n || lcs[i * w + j + 1] > lcs[(i + 1) * w + j])) {
        // 平局时先输出删除，和 git diff 的习惯一致
        out.push({ kind: 'add', text: midB[j], oldNo: null, newNo: start + j + 1 });
        j++;
      } else {
        out.push({ kind: 'del', text: midA[i], oldNo: start + i + 1, newNo: null });
        i++;
      }
    }
  }

  for (let k = 0; k < a.length - endA; k++) {
    out.push({ kind: 'same', text: a[endA + k], oldNo: endA + k + 1, newNo: endB + k + 1 });
  }
  return out;
}

const splitLines = (s: string) => (s === '' ? [] : s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));

/** 对比两段文本，只保留有变化的地方和前后 context 行 */
export function diffText(oldText: string, newText: string, context = 3): DiffResult {
  const lines = lineDiff(splitLines(oldText), splitLines(newText));
  const changed = lines.map((l, i) => (l.kind === 'same' ? -1 : i)).filter((i) => i >= 0);
  const hunks: Hunk[] = [];
  let current: { from: number; to: number } | null = null;
  const ranges: { from: number; to: number }[] = [];
  for (const i of changed) {
    const from = Math.max(0, i - context);
    const to = Math.min(lines.length - 1, i + context);
    if (current && from <= current.to + 1) current.to = to;
    else {
      current = { from, to };
      ranges.push(current);
    }
  }
  for (const r of ranges) {
    const slice = lines.slice(r.from, r.to + 1);
    const firstOld = slice.find((l) => l.oldNo !== null)?.oldNo ?? 0;
    const firstNew = slice.find((l) => l.newNo !== null)?.newNo ?? 0;
    hunks.push({ oldStart: firstOld, newStart: firstNew, lines: slice });
  }
  return {
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'del').length,
    hunks,
  };
}
