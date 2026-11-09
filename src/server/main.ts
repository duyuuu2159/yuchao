import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { getAsset, isSea } from 'node:sea';
import { audit, ignoreFinding, unignoreFinding } from '../core/audit.ts';
import { ConfigManager, hasNul, redactConfig } from '../core/configs.ts';
import { diffText } from '../core/diff.ts';
import { readMemories } from '../core/memories.ts';
import { AGENTS, isAgentKind } from '../core/agents.ts';
import { diffProfiles, latestProfile, profileHistory } from '../core/profile/build.ts';
import { activityStats } from '../core/profile/evidence.ts';
import { redact } from '../core/scan.ts';
import { checkServer, deployHistory, loadServers, recordDeploy, type ServerConfig, type ServerReport } from '../core/server.ts';
import { defaultSourceDirs, type SourceDirs } from '../core/sources.ts';
import { Store, type SearchOptions } from '../core/store.ts';
import type { AgentKind, Role } from '../core/types.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function agentParam(v: string | null): AgentKind | undefined {
  return isAgentKind(v) ? v : undefined;
}

/**
 * 本地服务也要防两类攻击：
 * - DNS 重绑定：恶意网站把自己的域名解析到 127.0.0.1 后就能读接口返回值，所以只接受本机的 Host
 * - 跨站请求：任何网页都能向 127.0.0.1 发 POST，所以写操作要求自定义请求头。
 *   浏览器跨域发送自定义请求头前必须先预检，而这里不响应预检
 */
export function isAllowedHost(host: string | undefined): boolean {
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host ?? '');
}

export const WRITE_HEADER = 'x-yuchao';

export interface AppOptions {
  /** 测试时替换掉真实的服务器列表和 ssh 连接 */
  servers?: () => ServerConfig[];
  checkServer?: (s: ServerConfig, raw: boolean) => Promise<ServerReport>;
}

/** 服务器状态缓存 30 秒：网页切换标签时不用每次都连一遍 ssh */
const SERVER_CACHE_MS = 30_000;

export function createApp(store: Store, dirs: SourceDirs = defaultSourceDirs(), opts: AppOptions = {}) {
  let indexing: Promise<unknown> | null = null;
  const servers = opts.servers ?? (() => loadServers());
  const check = opts.checkServer ?? ((s, raw) => checkServer(s, { raw }));
  const serverCache = new Map<string, { at: number; report: Promise<ServerReport> }>();

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    if (!isAllowedHost(req.headers.host)) return json(res, 403, { error: '只允许从本机访问' });
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers[WRITE_HEADER] !== '1') {
      return json(res, 403, { error: '缺少请求头 x-yuchao' });
    }
    // 默认打码显示，方便截图和演示；带 raw=1 才返回原文
    const raw = url.searchParams.get('raw') === '1';
    const safe = (s: string | null) => (raw || s === null ? s : redact(s));
    try {
      if (path === '/api/stats' && req.method === 'GET') return json(res, 200, store.stats());

      if (path === '/api/sessions' && req.method === 'GET') {
        const rows = store.listSessions({
          agent: agentParam(url.searchParams.get('agent')),
          includeSubagents: url.searchParams.get('all') === '1',
          limit: Math.min(Number(url.searchParams.get('limit') ?? 200), 1000),
          offset: Number(url.searchParams.get('offset') ?? 0),
        });
        return json(res, 200, rows.map((r) => ({ ...r, title: safe(r.title) })));
      }

      if (path.startsWith('/api/sessions/') && req.method === 'GET') {
        const s = store.getSession(decodeURIComponent(path.slice('/api/sessions/'.length)));
        if (!s) return json(res, 404, { error: '找不到这个会话' });
        return json(res, 200, {
          ...s,
          title: safe(s.title),
          messages: s.messages.map((m: any) => ({ ...m, text: safe(m.text) })),
          children: s.children.map((c) => ({ ...c, title: safe(c.title) })),
        });
      }

      if (path === '/api/search' && req.method === 'GET') {
        const opts: SearchOptions = { agent: agentParam(url.searchParams.get('agent')), limit: 100, redact: !raw };
        if (url.searchParams.get('tools') === '1') opts.roles = ['user', 'assistant', 'tool_call', 'tool_result'] satisfies Role[];
        return json(res, 200, store.search(url.searchParams.get('q') ?? '', opts));
      }

      if (path === '/api/index' && req.method === 'POST') {
        // 同一时间只跑一次索引，重复点击的请求等同一个结果
        indexing ??= store.index(dirs).finally(() => (indexing = null));
        return json(res, 200, await indexing);
      }

      if (path === '/api/scan' && req.method === 'GET') {
        return json(res, 200, audit(store, { includeIgnored: url.searchParams.get('all') === '1' }));
      }

      const ignore = path.match(/^\/api\/scan\/ignore\/([0-9a-f]{16})$/);
      if (ignore && (req.method === 'PUT' || req.method === 'DELETE')) {
        (req.method === 'PUT' ? ignoreFinding : unignoreFinding)(store, ignore[1]);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/profile' && req.method === 'GET') {
        // 只读：生成画像会产生费用，必须在命令行里明确执行 yuchao profile build --yes
        const scopes = ['all', ...AGENTS.map((a) => a.kind)] as const;
        return json(res, 200, {
          stats: activityStats(store),
          memories: readMemories(dirs).map(({ path: _, ...m }) => m),
          latest: Object.fromEntries(scopes.map((sc) => [sc, latestProfile(store, sc)])),
          versions: Object.fromEntries(scopes.map((sc) => [sc, profileHistory(store, sc).length])),
        });
      }

      if (path === '/api/profile/diff' && req.method === 'GET') {
        const sc = url.searchParams.get('scope');
        const scope = isAgentKind(sc) ? sc : 'all';
        const [newer, older] = profileHistory(store, scope);
        return json(res, 200, older ? { from: older.createdAt, to: newer.createdAt, ...diffProfiles(older.profile, newer.profile) } : null);
      }

      // 配置管家：只读。回滚会改写配置文件，必须在命令行里用 yuchao config restore <版本> --yes
      if (path.startsWith('/api/configs') && req.method === 'GET') {
        const cfg = new ConfigManager(store, dirs);
        if (path === '/api/configs') return json(res, 200, cfg.status());
        const file = cfg.tracked().find((f) => f.path === url.searchParams.get('path'));
        if (!file) return json(res, 404, { error: '没有跟踪这个配置文件' });
        if (path === '/api/configs/versions') return json(res, 200, cfg.versions(file.path));
        if (path === '/api/configs/diff') {
          const load = (ref: string | null) => {
            if (!ref || ref === 'current') return { name: '当前文件', text: cfg.currentContent(file.path) };
            const v = cfg.version(Number(ref));
            if (!v || v.path !== file.path) throw new Error(`没有版本 #${ref}`);
            return { name: `#${v.id} ${v.label}`, text: cfg.rawContent(v.id) };
          };
          const from = load(url.searchParams.get('from'));
          const to = load(url.searchParams.get('to'));
          const broken = [from, to].find((x) => hasNul(x.text));
          return json(res, 200, {
            from: from.name,
            to: to.name,
            broken: broken ? `${broken.name} 含有空字节（已损坏），无法逐行对比` : null,
            diff: broken ? null : diffText(redactConfig(from.text), redactConfig(to.text)),
          });
        }
      }

      // 服务器面板：只读。鱼巢的密钥在服务器上只能运行状态脚本，这里也只提供查看
      if (path === '/api/servers' && req.method === 'GET') return json(res, 200, servers());
      if (path === '/api/server' && req.method === 'GET') {
        const list = servers();
        const s = list.find((x) => x.name === url.searchParams.get('name')) ?? list[0];
        if (!s) return json(res, 404, { error: '还没有添加服务器' });
        const key = s.name + (raw ? ':raw' : '');
        let hit = serverCache.get(key);
        if (!hit || url.searchParams.get('fresh') === '1' || Date.now() - hit.at > SERVER_CACHE_MS) {
          hit = { at: Date.now(), report: check(s, raw) };
          serverCache.set(key, hit);
        }
        try {
          const report = await hit.report;
          recordDeploy(store, s.name, report.status.releases.current);
          return json(res, 200, { ...report, history: deployHistory(store, s.name) });
        } catch (e: any) {
          serverCache.delete(key);
          return json(res, 502, { error: `连接 ${s.name} 失败：${e.message}` });
        }
      }

      if (path.startsWith('/api/')) return json(res, 404, { error: '没有这个接口' });
      return serveStatic(path, res);
    } catch (e: any) {
      json(res, 500, { error: e.message ?? String(e) });
    }
  };
}

/**
 * 网页文件的来源：从源码运行时读 web/dist；打包成单文件程序后，网页文件作为内置资源放在 exe 里。
 * 路径按 / 切分后逐段检查，带 .. 的一律拒绝，防止读到网页目录以外的文件。
 */
function readWebFile(rel: string): Buffer | null {
  if (isSea()) {
    try {
      return Buffer.from(getAsset('web/' + rel));
    } catch {
      return null;
    }
  }
  const file = join(import.meta.dirname, '..', '..', 'web', 'dist', ...rel.split('/'));
  return existsSync(file) && statSync(file).isFile() ? readFileSync(file) : null;
}

export function serveStatic(path: string, res: ServerResponse, read = readWebFile) {
  const parts = decodeURIComponent(path).split('/').filter(Boolean);
  // 反斜杠在 Windows 上也是路径分隔符，冒号可能是盘符，都不允许出现
  if (parts.some((p) => p === '..' || p.includes(String.fromCharCode(92)) || p.includes(':'))) {
    res.writeHead(403);
    return res.end();
  }
  let rel = parts.join('/') || 'index.html';
  let body = read(rel);
  // 前端是单页应用，找不到的路径都交给 index.html
  if (!body) body = read((rel = 'index.html'));
  if (!body) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('网页界面还没有构建，请先运行 npm run web:build');
  }
  res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });
  res.end(body);
}

export async function serve(port: number) {
  const store = new Store();
  const server = createServer(createApp(store));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); // 例如端口被占用
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`鱼巢已启动：http://127.0.0.1:${port}`);
  const stop = () => {
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
