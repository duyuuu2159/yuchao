// yuchao claims：言行对账的命令行输出。

import { claimsReport, VERDICT_LABEL } from '../core/claims.ts';
import { redact } from '../core/scan.ts';
import type { Store } from '../core/store.ts';
import type { AgentKind } from '../core/types.ts';
import { bold, dim, tag } from './style.ts';

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

export function runClaims(store: Store, flags: { days?: number; agent?: AgentKind; json: boolean }) {
  const r = claimsReport(store, { days: flags.days, agent: flags.agent });
  if (flags.json) {
    console.log(
      JSON.stringify(
        { ...r, flagged: r.flagged.map((c) => ({ ...c, sentence: redact(c.sentence), title: c.title && redact(c.title) })) },
        null,
        2,
      ),
    );
    return;
  }
  if (!r.claims) {
    console.log('还没有找到 agent 说「测试通过」的地方。先运行 yuchao index。');
    return;
  }
  console.log(`${bold('言行对账')}  agent 说了 ${r.claims} 次「测试通过」，逐句和它自己的执行记录核对：\n`);
  console.log(dim('                说了   有据   对不上  改了没再测  无从核对   有据率'));
  for (const row of r.byAgent) {
    const cells = [row.claims, row.verified, row.contradicted, row.stale, row.unverifiable].map((n, i) =>
      String(n).padStart(i === 0 ? 4 : i === 3 ? 9 : 7),
    );
    console.log(`  ${tag(row.key)}${cells.join('')}${pct(row.verified, row.claims).padStart(9)}`);
  }
  if (r.flagged.length) {
    console.log(`\n${bold('对不上的')}（${r.flagged.length}）`);
    for (const c of r.flagged.slice(0, 20)) {
      console.log(`  ${tag(c.agent)} ${VERDICT_LABEL[c.verdict]}  「${redact(c.sentence).slice(0, 60)}」`);
      const why =
        c.verdict === 'stale'
          ? `测试（${redact(c.test?.command ?? '')}）之后改了 ${c.editedAfter?.files.map((f) => f.split(/[\\/]/).pop()).join('、')}，改完没再跑命令`
          : `最后一次测试（${redact(c.test?.command ?? '')}）失败，之后没再跑`;
      console.log(dim(`            ${why}  yuchao show ${c.sessionId}`));
    }
  } else {
    console.log(dim('\n没有发现对不上的说法。'));
  }
  console.log(
    dim(
      '\n有据 = 最后一次测试成功、之后没再改代码；对不上 = 最后一次测试失败、之后什么都没再跑；改了没再测 = 改完代码一条命令都没跑；' +
        '无从核对 = 记录里找不到测试，或者之后跑过别的命令（可能用别的办法验证过）。宁可漏掉，也不冤枉。',
    ),
  );
}
