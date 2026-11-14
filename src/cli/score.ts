// yuchao score：成绩单的命令行输出。
import { agentLabel } from '../core/agents.ts';
import { buildScorecard, OUTCOME_LABEL, type ScoreRow } from '../core/scorecard.ts';
import type { Store } from '../core/store.ts';
import type { AgentKind } from '../core/types.ts';
import { bold, day, dim, tag } from './style.ts';

/** 中文在终端里占两格，按显示宽度补齐才能对齐 */
const width = (s: string) => [...s].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
const padEnd = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)));
const padStart = (s: string, n: number) => ' '.repeat(Math.max(0, n - width(s))) + s;

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** 样本少于这个数的行，结论只供参考 */
export const FEW = 5;

function table(title: string, rows: ScoreRow[]) {
  const head = ['', '会话', '顺利', '返工', '没解决', '平均几句', '重试', '输出', '每件顺利的事'];
  const w = [26, 5, 6, 6, 7, 9, 5, 8, 13];
  console.log(`\n${bold(title)}`);
  console.log(dim(head.map((h, i) => (i === 0 ? padEnd(h, w[i]) : padStart(h, w[i]))).join('')));
  for (const r of rows) {
    const few = r.sessions < FEW;
    const cells = [
      padEnd(r.label.length > 24 ? r.label.slice(0, 23) + '…' : r.label, w[0]),
      padStart(String(r.sessions), w[1]),
      padStart(pct(r.smooth, r.sessions), w[2]),
      padStart(pct(r.rework, r.sessions), w[3]),
      padStart(pct(r.unresolved, r.sessions), w[4]),
      padStart(String(r.avgTurns), w[5]),
      padStart(String(r.retries), w[6]),
      padStart(tokens(r.output), w[7]),
      padStart(r.outputPerSmooth === null ? '—' : tokens(r.outputPerSmooth), w[8]),
    ];
    console.log(few ? dim(cells.join('') + '  样本少') : cells.join(''));
  }
}

export interface ScoreFlags {
  days?: number;
  agent?: AgentKind;
  json: boolean;
  /** 列出没解决和返工的会话 */
  all: boolean;
}

export function runScore(store: Store, flags: ScoreFlags) {
  const sc = buildScorecard(store, { days: flags.days, agent: flags.agent });
  if (flags.json) {
    console.log(JSON.stringify(sc, null, 2));
    return;
  }
  if (!sc.sessions.length) {
    console.log('还没有可以统计的会话。先运行 yuchao index。');
    return;
  }

  const total = sc.sessions.length;
  const by = (o: string) => sc.sessions.filter((s) => s.outcome === o).length;
  console.log(
    `${bold('成绩单')}  ${flags.days ? `最近 ${flags.days} 天，` : ''}${total} 个会话：` +
      `顺利 ${pct(by('smooth'), total)}，返工后完成 ${pct(by('rework'), total)}，没解决 ${pct(by('unresolved'), total)}` +
      (sc.handoffs ? `；其中 ${sc.handoffs} 次换了别的 agent 接着做` : ''),
  );

  table('按 agent', sc.byAgent);
  table(
    '按模型（主力模型：一个会话里输出最多的那个）',
    sc.byModel.filter((r) => r.sessions >= 2),
  );

  if (flags.all) {
    for (const outcome of ['unresolved', 'rework'] as const) {
      const xs = sc.sessions.filter((s) => s.outcome === outcome);
      if (!xs.length) continue;
      console.log(`\n${bold(OUTCOME_LABEL[outcome])}（${xs.length}）`);
      for (const s of xs.slice(-20).reverse()) {
        console.log(`  ${tag(s.agent)} ${s.title ?? '（无标题）'}  ${dim(day(s.startedAt))}`);
        console.log(dim(`            ${s.reasons.join('；')}  yuchao show ${s.id}`));
      }
    }
  } else {
    console.log(dim('\n加 --all 列出没解决和返工的会话和原因；--days 30 只看最近 30 天；--json 输出 JSON'));
  }
  console.log(
    dim(
      `\n怎么判断的：没解决 = 最后一次执行命令失败、你说了不行之后再没成功执行过、或者之后换了别的 agent 接着做；` +
        `返工 = 你说过「还是不行」或者换个说法把要求又说了一遍。agent 自己试错再修好不算返工。` +
        `重试 = 一字不差地重发或 Try again，通常是接口出错。样本少于 ${FEW} 个的行仅供参考。`,
    ),
  );
  const dsh = sc.byAgent.find((r) => r.key === 'dsh');
  if (dsh) console.log(dim(`${agentLabel('dsh')} 的记录里没有缓存命中的数据，输入 token 可能不含缓存部分。`));
}
