// src/mcp.ts — MCP JSON-RPC 2.0 endpoint (POST /mcp) for the forge.
//
// Streamable HTTP, plain-JSON answers only (never SSE), stateless (never
// emits Mcp-Session-Id). Methods: server/discover (2026-07-28 modern era),
// initialize (legacy handshake, all four revisions accepted),
// notifications/initialized (202, empty), tools/list (exactly the six
// canonical tools, built once at module load and reused verbatim),
// tools/call (dispatch to the shared Store). Unknown methods -> -32601,
// unknown tools / missing args -> -32602, non-JSON body -> HTTP 400 + -32700.
// Auth is enforced by app.ts before routing — no auth code here.

import type { ServerResponse } from 'node:http';
import type { Ctx, Issue, PullRequest, Repo } from './types.ts';
import type { Store } from './store.ts';
import { sendJson } from './util.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const MODERN_REVISION = '2026-07-28';

const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION };

// Built once at module load; tools/list returns this verbatim every time so
// its JSON is byte-identical across calls.
interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, Record<string, unknown>>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'integer' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const DISCOVER_RESULT = {
  supportedVersions: [MODERN_REVISION],
  capabilities: { tools: {} },
  serverInfo: SERVER_INFO,
  _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
};

class ToolError extends Error {
  constructor(message: string) { super(message); this.name = 'ToolError'; }
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, id: unknown, code: number, message: string): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
}

function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'content-length': '0' });
  res.end();
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return parseInt(v.trim(), 10);
  return null;
}

/** Resolve owner/repo from `owner`+`repo` or a `full_name` ("owner/repo"). */
function resolveOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = asString(args.owner);
  let repo = asString(args.repo ?? args.repository);
  if (owner === null || repo === null) {
    const full = asString(args.full_name ?? args.repo_full_name ?? args.repository_full_name ?? args.fullName);
    if (full !== null) {
      const idx = full.indexOf('/');
      if (idx > 0) {
        if (owner === null) owner = full.slice(0, idx);
        if (repo === null) repo = full.slice(idx + 1);
      }
    }
  }
  if (owner === null || owner.length === 0 || repo === null || repo.length === 0) return null;
  return { owner, repo };
}

function requireRepo(ctx: Ctx, args: Record<string, unknown>, tool: string): Repo {
  const resolved = resolveOwnerRepo(args);
  if (resolved === null) throw new ToolError(`${tool} requires owner and repo.`);
  const repo = ctx.store.getRepo(resolved.owner, resolved.repo);
  if (repo === null) throw new ToolError(`Repository '${resolved.owner}/${resolved.repo}' not found.`);
  return repo;
}

// ---------------------------------------------------------------------------
// REST-shaped result objects (MCP and REST share the Store; fields match)
// ---------------------------------------------------------------------------

function repoJson(store: Store, repo: Repo, host: string): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: store.viewer.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    html_url: `http://${host}/${repo.fullName}`,
    clone_url: `http://${host}/${repo.fullName}.git`,
  };
}

function issueJson(repo: Repo, issue: Issue, host: string): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user.login, id: issue.user.id },
    labels: issue.labels.map((l) => ({ id: l.id, name: l.name, color: l.color, description: l.description })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `http://${host}/${repo.fullName}/issues/${issue.number}`,
  };
}

function prJson(repo: Repo, pr: PullRequest, host: string): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    head: { ref: pr.headRef, sha: pr.headSha },
    base: { ref: pr.baseRef, sha: pr.baseSha },
    user: { login: pr.user.login, id: pr.user.id },
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    html_url: `http://${host}/${repo.fullName}/pull/${pr.number}`,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function toolCreateRepo(ctx: Ctx, args: Record<string, unknown>): unknown {
  const name = asString(args.name ?? args.repo ?? args.repository);
  if (name === null || name.length === 0) throw new ToolError('create_repo requires a name.');
  const description = asString(args.description ?? args.body) ?? '';
  const priv = typeof args.private === 'boolean' ? args.private : false;
  const repo = ctx.store.createRepo(name, { description, private: priv });
  return repoJson(ctx.store, repo, ctx.host);
}

function toolGetRepo(ctx: Ctx, args: Record<string, unknown>): unknown {
  const repo = requireRepo(ctx, args, 'get_repo');
  return repoJson(ctx.store, repo, ctx.host);
}

function toolCreateIssue(ctx: Ctx, args: Record<string, unknown>): unknown {
  const repo = requireRepo(ctx, args, 'create_issue');
  const title = asString(args.title);
  if (title === null || title.length === 0) throw new ToolError('create_issue requires a title.');
  const body = asString(args.body ?? args.description) ?? '';
  const issue = ctx.store.createIssue(repo, { title, body });
  return issueJson(repo, issue, ctx.host);
}

function toolListIssues(ctx: Ctx, args: Record<string, unknown>): unknown {
  const repo = requireRepo(ctx, args, 'list_issues');
  const stateArg = asString(args.state);
  const state = stateArg === 'closed' ? 'closed' : stateArg === 'all' ? 'all' : 'open';
  const issues = ctx.store.listIssues(repo, { state, sort: 'created', direction: 'desc' });
  return issues.map((issue) => issueJson(repo, issue, ctx.host));
}

function toolCreatePullRequest(ctx: Ctx, args: Record<string, unknown>): unknown {
  const repo = requireRepo(ctx, args, 'create_pull_request');
  const title = asString(args.title);
  if (title === null || title.length === 0) throw new ToolError('create_pull_request requires a title.');
  const head = asString(args.head);
  if (head === null || head.length === 0) throw new ToolError('create_pull_request requires a head branch.');
  const base = asString(args.base);
  if (base === null || base.length === 0) throw new ToolError('create_pull_request requires a base branch.');
  const body = asString(args.body ?? args.description) ?? '';
  const pr = ctx.store.createPull(repo, { title, body, head, base });
  return prJson(repo, pr, ctx.host);
}

function toolMergePullRequest(ctx: Ctx, args: Record<string, unknown>): unknown {
  const repo = requireRepo(ctx, args, 'merge_pull_request');
  const pullNumber = asInt(args.pull_number ?? args.pull_request_number ?? args.pr_number ?? args.number);
  if (pullNumber === null) throw new ToolError('merge_pull_request requires a pull_number.');
  const pr = ctx.store.getPull(repo, pullNumber);
  if (pr === null) throw new ToolError(`Pull request #${pullNumber} not found.`);
  ctx.store.mergePull(repo, pullNumber);
  const merged = ctx.store.getPull(repo, pullNumber);
  if (merged === null) throw new ToolError(`Pull request #${pullNumber} not found.`);
  return prJson(repo, merged, ctx.host);
}

function dispatchTool(ctx: Ctx, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': return toolCreateRepo(ctx, args);
    case 'get_repo': return toolGetRepo(ctx, args);
    case 'create_issue': return toolCreateIssue(ctx, args);
    case 'list_issues': return toolListIssues(ctx, args);
    case 'create_pull_request': return toolCreatePullRequest(ctx, args);
    case 'merge_pull_request': return toolMergePullRequest(ctx, args);
    default: throw new ToolError(`Unknown tool: ${name}`);
  }
}

function toolResult(obj: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * POST /mcp only (plus DELETE -> 200 empty, tolerated for session close).
 * Plain-JSON answers only, never SSE, never emits Mcp-Session-Id.
 */
export async function routeMcp(ctx: Ctx): Promise<boolean> {
  if (ctx.path !== '/mcp') return false;
  if (ctx.method === 'DELETE') {
    sendEmpty(ctx.res, 200);
    return true;
  }
  if (ctx.method !== 'POST') return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx.res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(ctx.res, 200, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const req = parsed as Record<string, unknown>;
  const hasId = Object.prototype.hasOwnProperty.call(req, 'id');
  const id = hasId ? req.id : null;
  const method = req.method;

  if (typeof method !== 'string' || method.length === 0) {
    rpcError(ctx.res, id, -32600, 'Invalid Request: missing method.');
    return true;
  }

  // Notifications carry no id and get no JSON-RPC response.
  if (method.startsWith('notifications/') || !hasId) {
    sendEmpty(ctx.res, 202);
    return true;
  }

  const params = req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params)
    ? (req.params as Record<string, unknown>)
    : {};

  switch (method) {
    case 'server/discover': {
      rpcResult(ctx.res, id, DISCOVER_RESULT);
      return true;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' && params.protocolVersion.length > 0
        ? params.protocolVersion
        : MODERN_REVISION;
      rpcResult(ctx.res, id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return true;
    }
    case 'tools/list': {
      rpcResult(ctx.res, id, { tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string' || name.length === 0) {
        rpcError(ctx.res, id, -32602, 'Invalid params: tool name is required.');
        return true;
      }
      let args: Record<string, unknown> = {};
      if (params.arguments !== undefined) {
        if (params.arguments === null || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) {
          rpcError(ctx.res, id, -32602, 'Invalid params: arguments must be an object.');
          return true;
        }
        args = params.arguments as Record<string, unknown>;
      }
      try {
        const result = dispatchTool(ctx, name, args);
        rpcResult(ctx.res, id, toolResult(result));
      } catch (err) {
        rpcError(ctx.res, id, -32602, err instanceof Error ? err.message : String(err));
      }
      return true;
    }
    default: {
      rpcError(ctx.res, id, -32601, `Method not found: ${method}`);
      return true;
    }
  }
}
