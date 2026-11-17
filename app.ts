// app.ts — the server: HTTP plumbing + dispatch.
//
// Owns one Store (created once via createStore()), reads the full request body
// (cap 64 MiB), assigns a request id and sets X-GitHub-Request-Id on EVERY
// response, enforces the bearer auth gate, and dispatches in the pinned order:
//
//   GET /healthz -> 200 {"ok":true} (no auth)
//   /api/graphql -> routeGraphql
//   /api/v3      -> routeRest
//   /mcp         -> routeMcp
//   /<owner>/<repo>.git/... -> routeGit
//   anything else -> 404 JSON {"message":"Not Found"}
//
// An ApiError thrown by a layer becomes its status + {"message":...}; any other
// throw becomes 500 JSON. Never redirects, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore } from './src/store.ts';
import { ApiError, type Ctx } from './src/types.ts';
import { sendJson } from './src/util.ts';
import { routeGit } from './src/git-http.ts';
import { routeRest } from './src/rest.ts';
import { routeGraphql } from './src/graphql.ts';
import { routeMcp } from './src/mcp.ts';

/** Bodies larger than this are answered 413 (untested; a safety cap). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Split a pathname on '/' and percent-decode each segment; empty entries are
 * dropped. A segment that fails to decode is kept raw rather than failing
 * the whole request.
 */
function decodeSegments(pathname: string): string[] {
  const out: string[] = [];
  for (const part of pathname.split('/')) {
    if (part === '') continue;
    try {
      out.push(decodeURIComponent(part));
    } catch {
      out.push(part);
    }
  }
  return out;
}

/** Read the full request body. Resolves null when the body exceeds the cap. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(Buffer.concat(chunks)));
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  // ONE Store for the whole server; createStore reads MAKEFUN_TRIAL_NOW once.
  const store = createStore();
  // The bearer token, read once at startup. Empty means "accept everything".
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requestCounter += 1;
    const requestId = `req-${String(requestCounter).padStart(8, '0')}`;
    // Set before any layer runs, so every response carries it — including
    // 401s, 404s, 204s and 500s.
    res.setHeader('x-github-request-id', requestId);
    try {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      const segments = decodeSegments(url.pathname);
      const path = `/${segments.join('/')}`;
      const method = req.method ?? 'GET';
      const host = req.headers.host ?? 'localhost';

      const body = await readBody(req);
      if (body === null) {
        sendJson(res, 413, { message: 'Request Entity Too Large' });
        return;
      }

      // The env's boot probe: no auth, answered twice within the boot budget.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Auth gate: exact Bearer match against MAKEFUN_SHOP_TOKEN.
      let authed = true;
      if (token !== '') {
        authed = req.headers.authorization === `Bearer ${token}`;
        if (!authed) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
      }

      const ctx: Ctx = {
        req,
        res,
        store,
        method,
        path,
        segments,
        query: url.searchParams,
        body,
        host,
        requestId,
        authed,
      };

      let handled = false;
      if (segments[0] === 'api' && segments[1] === 'graphql') {
        handled = await routeGraphql(ctx);
      } else if (segments[0] === 'api' && segments[1] === 'v3') {
        handled = await routeRest(ctx);
      } else if (segments[0] === 'mcp') {
        handled = await routeMcp(ctx);
      } else if (segments.length >= 2 && segments[1].endsWith('.git')) {
        handled = await routeGit(ctx);
      }
      if (!handled) {
        sendJson(res, 404, { message: 'Not Found' });
      }
    } catch (err) {
      if (res.headersSent) {
        // Too late to answer; just end the response.
        try {
          res.end();
        } catch {
          // The socket is already gone; nothing left to do.
        }
        return;
      }
      if (err instanceof ApiError) {
        sendJson(res, err.status, { message: err.message });
      } else {
        process.stderr.write(`[entry] internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        sendJson(res, 500, { message: 'Internal Server Error' });
      }
    }
  }

  return createServer((req, res) => {
    void handle(req, res);
  });
}
