// 从 CHANGELOG.md 里取出某个版本的那一节，作为 GitHub Release 的说明。
//
//   node scripts/release-notes.mjs 0.2.0
//
// 同时检查 package.json 的版本号和要发布的版本一致，避免打错标签。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!version) {
  console.error('用法：node scripts/release-notes.mjs <版本号>');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) {
  console.error(`package.json 的版本是 ${pkg.version}，要发布的是 ${version}，请先改成一致`);
  process.exit(1);
}

const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split('\n');
const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
if (start < 0) {
  console.error(`CHANGELOG.md 里没有 ${version} 这一节`);
  process.exit(1);
}
let end = lines.findIndex((l, i) => i > start && (l.startsWith('## [') || /^\[[^\]]+\]: /.test(l)));
if (end < 0) end = lines.length;
// 相对链接在 Release 页面上会失效，改成指向这个版本标签下的文件
const repo = `https://github.com/duyuuu2159/yuchao/blob/v${version}/`;
const body = lines
  .slice(start + 1, end)
  .join('\n')
  .trim()
  .replace(/\]\((?!https?:|#)([^)]+)\)/g, (_, path) => `](${repo}${path})`);
console.log(body);
