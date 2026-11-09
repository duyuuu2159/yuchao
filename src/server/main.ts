import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
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

export function createApp(store: Store) {
  let indexing: Promise<unknown> | null = null;

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (path === '/api/stats' && req.method === 'GET') return json(res, 200, store.stats());

      if (path === '/api/sessions' && req.method === 'GET') {
        return json(
          res,
          200,
          store.listSessions({
            agent: agentParam(url.searchParams.get('agent')),
            includeSubagents: url.searchParams.get('all') === '1',
            limit: Math.min(Number(url.searchParams.get('limit') ?? 200), 1000),
            offset: Number(url.searchParams.get('offset') ?? 0),
          }),
        );
      }

      if (path.startsWith('/api/sessions/') && req.method === 'GET') {
        const s = store.getSession(decodeURIComponent(path.slice('/api/sessions/'.length)));
        return s ? json(res, 200, s) : json(res, 404, { error: '找不到这个会话' });
      }

      if (path === '/api/search' && req.method === 'GET') {
        const opts: SearchOptions = { agent: agentParam(url.searchParams.get('agent')), limit: 100 };
        if (url.searchParams.get('tools') === '1') opts.roles = ['user', 'assistant', 'tool_call', 'tool_result'] satisfies Role[];
        return json(res, 200, store.search(url.searchParams.get('q') ?? '', opts));
      }

      if (path === '/api/index' && req.method === 'POST') {
        // 同一时间只跑一次索引，重复点击的请求等同一个结果
        indexing ??= store.index(defaultSourceDirs()).finally(() => (indexing = null));
        return json(res, 200, await indexing);
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
