// 把鱼巢打包成一个 exe：双击即用，不需要另外安装 Node.js。
// 用的是 Node 自带的「单文件可执行程序」（SEA）：把打包好的脚本和网页文件塞进一份 node.exe 的副本里。
//
//   npm run build:exe   →   dist/yuchao.exe
//
// 步骤：构建网页 → esbuild 把所有 TypeScript 和依赖合成一个 CommonJS 文件 → 生成 SEA 数据 → 注入 node.exe 副本

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { build } from 'esbuild';

const root = join(import.meta.dirname, '..');
const dist = join(root, 'dist');
const exe = join(dist, process.platform === 'win32' ? 'yuchao.exe' : 'yuchao');
const step = (s) => console.log(`\n▶ ${s}`);
// Windows 上 npx 是 .cmd 脚本，必须经过 shell；node.exe 的路径里有空格（Program Files），不能经过 shell
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: cmd === 'npx' && process.platform === 'win32' });

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

step('构建网页');
run('npx', ['vite', 'build', 'web']);

step('合成单个脚本');
await build({
  entryPoints: [join(root, 'src/cli/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs', // SEA 的入口只支持 CommonJS
  target: 'node24',
  outfile: join(dist, 'yuchao.cjs'),
  // 打包后网页文件从 exe 的内置资源读取，用不到源码目录
  define: { 'import.meta.dirname': '"."' },
  logLevel: 'warning',
});

step('收集网页文件作为内置资源');
const webDist = join(root, 'web', 'dist');
const assets = {};
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else assets['web/' + relative(webDist, p).replaceAll('\\', '/')] = p;
  }
};
walk(webDist);
console.log(`  ${Object.keys(assets).length} 个文件`);

step('生成 SEA 数据');
const blob = join(dist, 'sea-prep.blob');
const config = join(dist, 'sea-config.json');
writeFileSync(
  config,
  JSON.stringify({ main: join(dist, 'yuchao.cjs'), output: blob, disableExperimentalSEAWarning: true, assets }, null, 2),
);
run(process.execPath, ['--experimental-sea-config', config]);

step('注入 node 可执行文件的副本');
copyFileSync(process.execPath, exe);
const args = [exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
run('npx', ['postject', ...args]);

for (const f of ['yuchao.cjs', 'sea-prep.blob', 'sea-config.json']) rmSync(join(dist, f));
console.log(`\n✓ ${relative(root, exe)}（${(statSync(exe).size / 1024 / 1024).toFixed(0)} MB）`);
