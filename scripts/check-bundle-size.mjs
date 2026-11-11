// 包体积预算：网页的 JS 经过 gzip 后不能超过预算（见 docs/ui-brief.md「不做什么」）。
// 不引入 UI 库、图标库、Markdown 库，这个数字就是检验。CI 里每次构建后运行，超出预算就失败。
//
//   npm run web:build && node scripts/check-bundle-size.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_KB = 100;
const assets = join(import.meta.dirname, '..', 'web', 'dist', 'assets');

let files;
try {
  files = readdirSync(assets).filter((f) => f.endsWith('.js'));
} catch {
  console.error('找不到 web/dist/assets，请先运行 npm run web:build');
  process.exit(1);
}

let total = 0;
for (const f of files) {
  const kb = gzipSync(readFileSync(join(assets, f)), { level: 9 }).length / 1024;
  total += kb;
  console.log(`  ${f}  ${kb.toFixed(1)} KB (gzip)`);
}
const line = `JS 合计 ${total.toFixed(1)} KB (gzip)，预算 ${BUDGET_KB} KB`;
if (total > BUDGET_KB) {
  console.error(`✗ ${line}，超出 ${(total - BUDGET_KB).toFixed(1)} KB`);
  process.exit(1);
}
console.log(`✓ ${line}，还剩 ${(BUDGET_KB - total).toFixed(1)} KB`);
