import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as z from 'zod';
import { IPV4, redact } from './scan.ts';
import { defaultDbPath, type Store } from './store.ts';

// 服务器面板：用一把专用 SSH 密钥登录服务器，运行只读的状态脚本（server/yuchao-status.py），解析它输出的 JSON。
// 密钥在 authorized_keys 里被绑定到这个脚本（restrict,command=...），登录后不能执行别的命令，
// 所以鱼巢本身没有能力改动服务器；即使密钥泄露，别人也只能看状态。

export interface ServerConfig {
  name: string;
  host: string;
  user: string;
  port: number;
  /** 公网地址，从本机检查 HTTPS 是否可达，例如 https://duyuuu.com */
  url?: string;
}

/** 服务器上安装状态脚本的位置，和 authorized_keys 里的 command 对应 */
export const REMOTE_SCRIPT = '/usr/local/lib/yuchao/status.py';
export const KEY_COMMENT = 'yuchao-readonly';

const home = () => dirname(defaultDbPath());
export const keyPath = () => join(home(), 'ssh', 'yuchao_ed25519');
const configPath = () => join(home(), 'servers.json');

export function loadServers(path = configPath()): ServerConfig[] {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e: any) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export function saveServers(servers: ServerConfig[], path = configPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(servers, null, 2));
}

/** 解析 user@host:port；主机名和用户名只允许常见字符，避免被当成 ssh 的参数 */
export function parseTarget(target: string): { user: string; host: string; port: number } {
  const m = target.match(/^([a-z_][\w.-]*)@([\w.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/i);
  if (!m) throw new Error(`地址格式应为 用户名@主机[:端口]，例如 root@203.0.113.7`);
  return { user: m[1], host: m[2], port: m[3] ? Number(m[3]) : 22 };
}

/** authorized_keys 里的一行：restrict 关掉端口转发、终端等一切额外能力，command 把登录固定到状态脚本 */
export function authorizedKeysLine(publicKey: string): string {
  const key = publicKey.trim().split(/\s+/).slice(0, 2).join(' ');
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+$/.test(key)) throw new Error('不是 ed25519 公钥');
  return `restrict,command="/usr/bin/python3 ${REMOTE_SCRIPT}" ${key} ${KEY_COMMENT}`;
}

type Runner = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const execRunner: Runner = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n').slice(-3).join('\n')));
      else resolve(stdout);
    });
  });

/** 生成专用密钥（不设口令，只能运行只读脚本），已存在就直接用 */
export async function ensureKey(path = keyPath(), run: Runner = execRunner): Promise<string> {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', KEY_COMMENT, '-f', path], 15_000);
  }
  return readFileSync(path + '.pub', 'utf8').trim();
}

/**
 * ssh 参数要点：
 * - BatchMode：不弹密码提示，密钥不行就直接失败
 * - IdentitiesOnly：只用这把密钥，不去试 ssh-agent 里别的钥匙
 * - StrictHostKeyChecking=yes：主机指纹必须已在 known_hosts 里，防止被冒充的服务器骗走连接
 * 远端命令随便写什么都会被 authorized_keys 里的 command 替换掉，这里写 status 只是为了可读
 */
export function sshArgs(s: ServerConfig, key = keyPath()): string[] {
  return ['-i', key, '-p', String(s.port), '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8', '--', `${s.user}@${s.host}`, 'status'];
}

const Service = z.object({ name: z.string(), active: z.string(), sub: z.string(), since: z.string().nullable(), restarts: z.number(), pid: z.number() });
export const StatusSchema = z.object({
  version: z.literal(1),
  host: z.string(),
  time: z.number(),
  uptime: z.number(),
  load: z.array(z.number()),
  cpus: z.number().nullable(),
  memory: z.object({ total: z.number().nullable(), available: z.number().nullable() }),
  disk: z.object({ total: z.number(), used: z.number(), free: z.number() }),
  services: z.array(Service),
  app: z.object({ url: z.string(), status: z.number().nullable(), ms: z.number().nullable(), error: z.string().optional() }),
  releases: z.object({
    current: z.string().nullable(),
    total: z.number(),
    items: z.array(z.object({ name: z.string(), mtime: z.number(), current: z.boolean() })),
  }),
  serviceLog: z.array(z.string()),
  nginxErrors: z.array(z.string()),
});
export type RemoteStatus = z.infer<typeof StatusSchema>;

export interface Warning {
  level: 'bad' | 'warn';
  text: string;
}

export interface ServerReport {
  server: ServerConfig;
  checkedAt: string;
  status: RemoteStatus;
  publicSite: { status: number | null; ms: number | null; error?: string } | null;
  warnings: Warning[];
}

/** 从状态里挑出需要注意的地方，命令行和网页共用 */
export function assess(s: RemoteStatus, publicSite: ServerReport['publicSite']): Warning[] {
  const out: Warning[] = [];
  for (const svc of s.services) if (svc.active !== 'active') out.push({ level: 'bad', text: `服务 ${svc.name} 不在运行（${svc.active}）` });
  if (s.app.status !== 200) out.push({ level: 'bad', text: `应用本机访问失败：${s.app.status ?? s.app.error}` });
  if (publicSite && publicSite.status !== 200) out.push({ level: 'bad', text: `公网访问失败：${publicSite.status ?? publicSite.error}` });
  const used = s.disk.used / s.disk.total;
  if (used >= 0.9) out.push({ level: 'bad', text: `磁盘已用 ${Math.round(used * 100)}%` });
  else if (used >= 0.8) out.push({ level: 'warn', text: `磁盘已用 ${Math.round(used * 100)}%，release 目录有 ${s.releases.total} 个，可以清理旧的` });
  const failures = s.serviceLog.filter((l) => /Failed with result/.test(l)).length;
  if (failures) out.push({ level: 'warn', text: `最近 7 天服务异常退出 ${failures} 次` });
  if (s.memory.total && s.memory.available !== null && s.memory.available / s.memory.total < 0.1) out.push({ level: 'warn', text: '可用内存不足 10%' });
  return out;
}

/** 日志里可能有密钥和访客 IP，默认打码 */
export function sanitizeStatus(s: RemoteStatus, raw = false): RemoteStatus {
  if (raw) return s;
  const clean = (l: string) => redact(l).replace(IPV4, '[IP]');
  return { ...s, serviceLog: s.serviceLog.map(clean), nginxErrors: s.nginxErrors.map(clean) };
}

async function probePublic(url: string): Promise<ServerReport['publicSite']> {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8000) });
    return { status: r.status, ms: Math.round(performance.now() - t0) };
  } catch (e: any) {
    return { status: null, ms: null, error: e.cause?.code ?? e.name };
  }
}

export async function checkServer(server: ServerConfig, opts: { run?: Runner; key?: string; raw?: boolean } = {}): Promise<ServerReport> {
  const run = opts.run ?? execRunner;
  const [out, publicSite] = await Promise.all([run('ssh', sshArgs(server, opts.key), 20_000), server.url ? probePublic(server.url) : Promise.resolve(null)]);
  let json: unknown;
  try {
    json = JSON.parse(out);
  } catch {
    throw new Error(`服务器返回的不是状态 JSON，检查 authorized_keys 里的 command 是否指向 ${REMOTE_SCRIPT}`);
  }
  const parsed = StatusSchema.safeParse(json);
  if (!parsed.success) throw new Error(`状态脚本的输出格式不对，可能版本不一致：${parsed.error.issues[0]?.message}`);
  const status = sanitizeStatus(parsed.data, opts.raw);
  return { server, checkedAt: new Date().toISOString(), status, publicSite, warnings: assess(parsed.data, publicSite) };
}

// 观察到的上线记录：每次检查时，如果线上 release 和上次不同就记一笔。
// 服务器上的 release 目录可能被清理，本地这份记录不会丢。
const SCHEMA = `
CREATE TABLE IF NOT EXISTS server_deploys (
  id       INTEGER PRIMARY KEY,
  server   TEXT NOT NULL,
  release  TEXT NOT NULL,
  seen_at  TEXT NOT NULL
);`;

export function recordDeploy(store: Store, server: string, release: string | null, at = new Date().toISOString()): boolean {
  if (!release) return false;
  store.db.exec(SCHEMA);
  const last = store.db.prepare('SELECT release FROM server_deploys WHERE server = ? ORDER BY id DESC LIMIT 1').get(server) as { release: string } | undefined;
  if (last?.release === release) return false;
  store.db.prepare('INSERT INTO server_deploys(server, release, seen_at) VALUES (?, ?, ?)').run(server, release, at);
  return true;
}

export function deployHistory(store: Store, server: string, limit = 50): { release: string; seenAt: string }[] {
  store.db.exec(SCHEMA);
  return (store.db.prepare('SELECT release, seen_at FROM server_deploys WHERE server = ? ORDER BY id DESC LIMIT ?').all(server, limit) as any[]).map((r) => ({ release: r.release, seenAt: r.seen_at }));
}
