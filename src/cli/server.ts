import { authorizedKeysLine, checkServer, deployHistory, ensureKey, keyPath, loadServers, parseTarget, recordDeploy, REMOTE_SCRIPT, saveServers, type ServerConfig, type ServerReport } from '../core/server.ts';
import type { Store } from '../core/store.ts';
import { bold, color, day, dim, fail } from './style.ts';

interface ServerFlags {
  url?: string;
  json?: boolean;
}

const red = color('31');
const green = color('32');
const yellow = color('33');
const gb = (n: number) => (n / 1024 ** 3).toFixed(1) + ' GB';
const duration = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)} 天` : `${Math.floor(s / 3600)} 小时`);

function pick(servers: ServerConfig[], name: string | undefined): ServerConfig {
  if (!servers.length) fail('还没有添加服务器。先运行：yuchao server add <名字> <用户名@主机> --url https://你的域名');
  const s = name ? servers.find((x) => x.name === name) : servers[0];
  if (!s) fail(`没有名为「${name}」的服务器（已添加：${servers.map((x) => x.name).join('、')}）`);
  return s;
}

function print(r: ServerReport, history: { release: string; seenAt: string }[]) {
  const s = r.status;
  console.log(`${bold(r.server.name)} ${dim(`${s.host} · 已运行 ${duration(s.uptime)} · 负载 ${s.load.map((x) => x.toFixed(2)).join(' ')}`)}`);
  console.log(r.warnings.length ? r.warnings.map((w) => (w.level === 'bad' ? red('✗ ') : yellow('! ')) + w.text).join('\n') : green('✓ 一切正常'));
  console.log();
  for (const svc of s.services) {
    const state = svc.active === 'active' ? green('运行中') : red(svc.active);
    console.log(`服务 ${bold(svc.name)} ${state} ${dim(`${svc.since ? '启动于 ' + svc.since : ''}`)}`);
  }
  console.log(`应用 ${s.app.url} → ${s.app.status ?? s.app.error} ${dim(s.app.ms !== null ? s.app.ms + ' ms' : '')}`);
  if (r.publicSite) console.log(`公网 ${r.server.url} → ${r.publicSite.status ?? r.publicSite.error} ${dim(r.publicSite.ms !== null ? r.publicSite.ms + ' ms' : '')}`);
  console.log(`磁盘 ${gb(s.disk.used)} / ${gb(s.disk.total)}  内存可用 ${s.memory.available ? gb(s.memory.available) : '—'}`);
  console.log(`\n线上版本 ${bold(s.releases.current ?? '—')} ${dim(`（共 ${s.releases.total} 个 release）`)}`);
  for (const rel of s.releases.items.slice(0, 8)) console.log(`  ${rel.current ? green('●') : dim('○')} ${rel.name} ${dim(day(new Date(rel.mtime * 1000).toISOString()))}`);
  if (history.length > 1) {
    console.log(dim('\n鱼巢观察到的上线记录：'));
    for (const h of history.slice(0, 5)) console.log(dim(`  ${day(h.seenAt)} ${h.release}`));
  }
  const failures = s.serviceLog.filter((l) => /Failed with result/.test(l));
  if (failures.length) console.log(dim(`\n最近的异常退出：\n${failures.slice(-5).map((l) => '  ' + l).join('\n')}`));
}

export async function runServer(store: Store, args: string[], flags: ServerFlags) {
  const servers = loadServers();
  const [sub = 'status', a, b] = args;
  switch (sub) {
    case 'add': {
      if (!a || !b) fail('用法：yuchao server add <名字> <用户名@主机[:端口]> [--url https://域名]');
      let target: ReturnType<typeof parseTarget>;
      try {
        target = parseTarget(b);
      } catch (e: any) {
        fail(e.message);
      }
      if (flags.url && !/^https?:\/\//.test(flags.url)) fail('--url 要以 http:// 或 https:// 开头');
      saveServers([...servers.filter((s) => s.name !== a), { name: a, ...target, url: flags.url }]);
      console.log(`已添加 ${a}。下一步运行 yuchao server setup ${a}，按提示在服务器上安装只读脚本。`);
      break;
    }
    case 'remove':
      saveServers(servers.filter((s) => s.name !== a));
      console.log(`已移除 ${a}（服务器上的密钥和脚本需要自己删除）`);
      break;
    case 'list':
      for (const s of servers) console.log(`${bold(s.name)} ${s.user}@${s.host}:${s.port} ${dim(s.url ?? '')}`);
      if (!servers.length) console.log('还没有添加服务器。');
      break;
    case 'setup': {
      const s = pick(servers, a);
      const pub = await ensureKey();
      console.log(`专用密钥：${keyPath()}（只能用来查看状态）\n`);
      console.log(bold('在服务器上做三件事（需要你自己登录服务器执行，鱼巢不会替你改服务器）：\n'));
      console.log(`1. 把状态脚本放到 ${REMOTE_SCRIPT}：`);
      console.log(dim(`   脚本在 server/yuchao-status.py，顶部的服务名和目录按你的部署修改；只读，不改任何东西\n`));
      console.log(`2. 在 ~${s.user === 'root' ? '' : s.user}/.ssh/authorized_keys 末尾加上这一行：`);
      console.log(`   ${authorizedKeysLine(pub)}\n`);
      console.log(`3. 确认 /etc/ssh/sshd_config 里 PubkeyAuthentication 没有设成 no；改过的话用 sshd -t 检查后再 reload sshd\n`);
      console.log(`完成后运行 yuchao server ${s.name} 检查连接。`);
      break;
    }
    default: {
      // yuchao server [名字]
      const s = pick(servers, sub === 'status' ? a : sub);
      let r: ServerReport;
      try {
        r = await checkServer(s);
      } catch (e: any) {
        fail(`连接 ${s.name} 失败：${e.message}`);
      }
      recordDeploy(store, s.name, r.status.releases.current);
      if (flags.json) console.log(JSON.stringify(r, null, 2));
      else print(r, deployHistory(store, s.name));
    }
  }
}
