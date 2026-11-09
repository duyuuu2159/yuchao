import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { audit, ignoreFinding, unignoreFinding } from '../core/audit.ts';
import { readClaudeMemories } from '../core/memories.ts';
import { diffProfiles, latestProfile, profileHistory } from '../core/profile/build.ts';
import { activityStats } from '../core/profile/evidence.ts';
import { redact } from '../core/scan.ts';
import { defaultSourceDirs } from '../core/sources.ts';
import { Store, type SearchOptions } from '../core/store.ts';
import type { AgentKind, Role } from '../core/types.ts';

const WEB_DIST = join(import.meta.dirname, '..', '..', 'web', 'dist');
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
  return v === 'claude' || v === 'codex' ? v : undefined;
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

export function createApp(store: Store) {
  let indexing: Promise<unknown> | null = null;

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
        indexing ??= store.index(defaultSourceDirs()).finally(() => (indexing = null));
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
        const scopes = ['all', 'claude', 'codex'] as const;
        return json(res, 200, {
          stats: activityStats(store),
          memories: readClaudeMemories(defaultSourceDirs().claudeDir).map(({ path: _, ...m }) => m),
          latest: Object.fromEntries(scopes.map((sc) => [sc, latestProfile(store, sc)])),
          versions: Object.fromEntries(scopes.map((sc) => [sc, profileHistory(store, sc).length])),
        });
      }

      if (path === '/api/profile/diff' && req.method === 'GET') {
        const sc = url.searchParams.get('scope');
        const scope = sc === 'claude' || sc === 'codex' ? sc : 'all';
        const [newer, older] = profileHistory(store, scope);
        return json(res, 200, older ? { from: older.createdAt, to: newer.createdAt, ...diffProfiles(older.profile, newer.profile) } : null);
      }

      if (path.startsWith('/api/')) return json(res, 404, { error: '没有这个接口' });
      return serveStatic(path, res);
    } catch (e: any) {
      json(res, 500, { error: e.message ?? String(e) });
    }
  };
}

function serveStatic(path: string, res: ServerResponse) {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('网页界面还没有构建，请先运行 npm run web:build');
  }
  let file = normalize(join(WEB_DIST, decodeURIComponent(path)));
  if (!file.startsWith(WEB_DIST + sep) && file !== WEB_DIST) {
    res.writeHead(403);
    return res.end();
  }
  // 前端是单页应用，找不到的路径都交给 index.html
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, 'index.html');
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}

export async function serve(port: number) {
  const store = new Store();
  const server = createServer(createApp(store));
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  console.log(`鱼巢已启动：http://127.0.0.1:${port}`);
  const stop = () => {
    server.close();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
