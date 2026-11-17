// src/rest.ts — REST v3 router.
//
// Implements every /api/v3 route in rest-spec.md §6, plus the extras the MCP
// checks use: GET /api/v3/user, GET .../git/refs/heads/{branch} and
// GET .../branches/{branch}. Branch names may contain '/': they arrive as one
// percent-decoded segment (or split across segments), so handlers re-join the
// remaining segments with '/'. Contents paths are handled the same way.
// Every response is JSON; app.ts sets X-GitHub-Request-Id before routing.
// Errors are thrown as ApiError and converted to status + {"message"} by app.ts.

import { ApiError } from './types.ts';
import type { CommitInfo, Ctx, Issue, IssueComment, Label, PullRequest, Repo, User } from './types.ts';
import { b64decode, b64encode, sendJson } from './util.ts';

const OAUTH_SCOPES = 'repo, read:org';
const SHA_RE = /^[0-9a-f]{40}$/i;
const NUM_RE = /^\d+$/;

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function baseUrl(ctx: Ctx): string {
  return `http://${ctx.host}`;
}

function nodeId(kind: string, id: string | number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Percent-encode a repo-relative path segment by segment (keeps '/'). */
function encodePath(path: string): string {
  return path.split('/').map((p) => encodeURIComponent(p)).join('/');
}

/** 'Name <email> 1735689600 +0000' -> { name, email, ts }. */
function parseIdent(line: string): { name: string; email: string; ts: number } {
  const m = /^([^<]*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (m === null) return { name: '', email: '', ts: 0 };
  return { name: m[1], email: m[2], ts: Number(m[3]) };
}

/** Epoch seconds -> ISO 8601 UTC. Pure arithmetic (no Date): deterministic. */
function isoFromSec(sec: number): string {
  const days = Math.floor(sec / 86400);
  const rem = sec - days * 86400;
  const hh = Math.floor(rem / 3600);
  const mm = Math.floor((rem % 3600) / 60);
  const ss = rem % 60;
  // Civil date from days-since-epoch (Howard Hinnant's algorithm).
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');
  return `${pad(year, 4)}-${pad(m, 2)}-${pad(d, 2)}T${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}.000Z`;
}

/**
 * Parse the request body as a JSON object. Empty body -> {}.
 * Malformed JSON -> 400. Non-object JSON (array, string, ...) -> 422.
 */
function parseBodyObject(ctx: Ctx): Record<string, unknown> {
  if (ctx.body.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Problems parsing JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(422, 'Validation Failed');
  }
  return parsed as Record<string, unknown>;
}

/** Resolve a repo; a missing repo or a foreign owner is a 404, never a 403. */
function requireRepo(ctx: Ctx, owner: string, name: string): Repo {
  const repo = ctx.store.getRepo(owner, name);
  if (repo === null) throw new ApiError(404, 'Not Found');
  return repo;
}

function parseNumber(s: string): number | null {
  if (!NUM_RE.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const v = body[key];
  return typeof v === 'string' ? v : undefined;
}

function stringArrayField(body: Record<string, unknown>, key: string): string[] | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

type ListState = 'open' | 'closed' | 'all';

function normalizeState(value: string | null, fallback: ListState): ListState {
  if (value === null) return fallback;
  const v = value.toLowerCase();
  if (v === 'open' || v === 'closed' || v === 'all') return v;
  return fallback;
}

/* ------------------------------------------------------------------ */
/* pagination (Link headers with ABSOLUTE urls, per rest-spec §4)      */
/* ------------------------------------------------------------------ */

interface PageParams { page: number; perPage: number; }

function pageParams(query: URLSearchParams): PageParams {
  let perPage = Number.parseInt(query.get('per_page') ?? '', 10);
  if (!Number.isFinite(perPage)) perPage = 30;
  perPage = Math.min(100, Math.max(1, perPage));
  let page = Number.parseInt(query.get('page') ?? '', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  return { page, perPage };
}

function pageUrl(ctx: Ctx, page: number, perPage: number): string {
  const path = `/${ctx.segments.map((s) => encodeURIComponent(s)).join('/')}`;
  const q = new URLSearchParams(ctx.query);
  q.set('page', String(page));
  q.set('per_page', String(perPage));
  return `http://${ctx.host}${path}?${q.toString()}`;
}

/** Slice one page out of a full list and build the Link header (if >1 page). */
function paginate<T>(items: readonly T[], ctx: Ctx): { pageItems: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(ctx.query);
  const totalPages = Math.ceil(items.length / perPage);
  const pageItems = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (totalPages > 1) {
    const links: string[] = [`<${pageUrl(ctx, 1, perPage)}>; rel="first"`];
    if (page > 1) links.push(`<${pageUrl(ctx, page - 1, perPage)}>; rel="prev"`);
    if (page < totalPages) links.push(`<${pageUrl(ctx, page + 1, perPage)}>; rel="next"`);
    links.push(`<${pageUrl(ctx, totalPages, perPage)}>; rel="last"`);
    headers.link = links.join(', ');
  }
  return { pageItems, headers };
}

/* ------------------------------------------------------------------ */
/* response shaping (full GitHub-shaped objects; extras never hurt)    */
/* ------------------------------------------------------------------ */

function userJson(user: User, ctx: Ctx): Record<string, unknown> {
  const base = baseUrl(ctx);
  const login = encodeURIComponent(user.login);
  return {
    login: user.login,
    id: user.id,
    node_id: nodeId('User', user.id),
    avatar_url: '',
    gravatar_id: '',
    url: `${base}/api/v3/users/${login}`,
    html_url: `${base}/${login}`,
    followers_url: `${base}/api/v3/users/${login}/followers`,
    following_url: `${base}/api/v3/users/${login}/following{/other_user}`,
    gists_url: `${base}/api/v3/users/${login}/gists{/gist_id}`,
    starred_url: `${base}/api/v3/users/${login}/starred{/owner}{/repo}`,
    subscriptions_url: `${base}/api/v3/users/${login}/subscriptions`,
    organizations_url: `${base}/api/v3/users/${login}/orgs`,
    repos_url: `${base}/api/v3/users/${login}/repos`,
    events_url: `${base}/api/v3/users/${login}/events{/privacy}`,
    received_events_url: `${base}/api/v3/users/${login}/received_events`,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

function repoJson(repo: Repo, ctx: Ctx): Record<string, unknown> {
  const base = baseUrl(ctx);
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  let openIssues = 0;
  for (const issue of repo.issues.values()) {
    if (issue.state === 'open') openIssues += 1;
  }
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    private: repo.private,
    owner: userJson(ctx.store.viewer, ctx),
    html_url: `${base}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: repoUrl,
    forks_url: `${repoUrl}/forks`,
    keys_url: `${repoUrl}/keys{/key_id}`,
    collaborators_url: `${repoUrl}/collaborators{/collaborator}`,
    teams_url: `${repoUrl}/teams`,
    hooks_url: `${repoUrl}/hooks`,
    issue_events_url: `${repoUrl}/issues/events{/number}`,
    events_url: `${repoUrl}/events`,
    assignees_url: `${repoUrl}/assignees{/user}`,
    branches_url: `${repoUrl}/branches{/branch}`,
    tags_url: `${repoUrl}/tags`,
    blobs_url: `${repoUrl}/git/blobs{/sha}`,
    git_tags_url: `${repoUrl}/git/tags{/sha}`,
    git_refs_url: `${repoUrl}/git/refs{/sha}`,
    trees_url: `${repoUrl}/git/trees{/sha}`,
    statuses_url: `${repoUrl}/statuses/{sha}`,
    languages_url: `${repoUrl}/languages`,
    stargazers_url: `${repoUrl}/stargazers`,
    contributors_url: `${repoUrl}/contributors`,
    subscribers_url: `${repoUrl}/subscribers`,
    subscription_url: `${repoUrl}/subscription`,
    compares_url: `${repoUrl}/compare/{base}...{head}`,
    merges_url: `${repoUrl}/merges`,
    archive_url: `${repoUrl}/{archive_format}{/ref}`,
    downloads_url: `${repoUrl}/downloads`,
    issues_url: `${repoUrl}/issues{/number}`,
    pulls_url: `${repoUrl}/pulls{/number}`,
    milestones_url: `${repoUrl}/milestones{/number}`,
    notifications_url: `${repoUrl}/notifications{?since,all,participating}`,
    labels_url: `${repoUrl}/labels{/name}`,
    releases_url: `${repoUrl}/releases{/id}`,
    deployments_url: `${repoUrl}/deployments`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: `git://${ctx.host}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${ctx.host}:${repo.owner}/${repo.name}.git`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    svn_url: `${base}/${repo.owner}/${repo.name}`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: Label, ctx: Ctx, repo: Repo): Record<string, unknown> {
  const base = baseUrl(ctx);
  return {
    id: label.id,
    node_id: nodeId('Label', label.id),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(issue: Issue, ctx: Ctx, repo: Repo): Record<string, unknown> {
  const base = baseUrl(ctx);
  const issueUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`;
  return {
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    url: issueUrl,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `${issueUrl}/labels{/name}`,
    comments_url: `${issueUrl}/comments`,
    events_url: `${issueUrl}/events`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.user, ctx),
    labels: issue.labels.map((l) => labelJson(l, ctx, repo)),
    assignee: null,
    locked: false,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function commentJson(comment: IssueComment, ctx: Ctx, repo: Repo, issueNumber: number): Record<string, unknown> {
  const base = baseUrl(ctx);
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user, ctx),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    author_association: 'OWNER',
  };
}

function prJson(pr: PullRequest, ctx: Ctx, repo: Repo): Record<string, unknown> {
  const base = baseUrl(ctx);
  const viewer = ctx.store.viewer;
  const prUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`;
  let mergeable: boolean | null = null;
  if (pr.state === 'open') {
    try {
      mergeable = ctx.store.isMergeable(repo, pr);
    } catch {
      mergeable = null;
    }
  } else {
    mergeable = false;
  }
  let additions = 0;
  let deletions = 0;
  let changedFiles = 0;
  try {
    const files = ctx.store.pullFiles(repo, pr);
    changedFiles = files.length;
    for (const f of files) {
      additions += f.additions;
      deletions += f.deletions;
    }
  } catch {
    // Leave the counts at zero; the diff fields are unasserted.
  }
  const refJson = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(viewer, ctx),
    repo: repoJson(repo, ctx),
  });
  return {
    id: pr.id,
    node_id: nodeId('PullRequest', pr.id),
    url: prUrl,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pr.number}`,
    diff_url: `${base}/${repo.owner}/${repo.name}/pull/${pr.number}.diff`,
    patch_url: `${base}/${repo.owner}/${repo.name}/pull/${pr.number}.patch`,
    issue_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    body: pr.body,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    merged: pr.merged,
    mergeable,
    mergeable_state: pr.state === 'open'
      ? (mergeable === true ? 'clean' : mergeable === false ? 'dirty' : 'unknown')
      : 'closed',
    merged_by: pr.merged ? userJson(viewer, ctx) : null,
    head: refJson(pr.headRef, pr.headSha),
    base: refJson(pr.baseRef, pr.baseSha),
    user: userJson(pr.user, ctx),
    labels: [],
    draft: false,
    additions,
    deletions,
    changed_files: changedFiles,
    author_association: 'OWNER',
  };
}

function commitJson(sha: string, info: CommitInfo, ctx: Ctx, repo: Repo): Record<string, unknown> {
  const base = baseUrl(ctx);
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const author = parseIdent(info.author);
  const committer = parseIdent(info.committer);
  const viewer = ctx.store.viewer;
  return {
    sha,
    node_id: nodeId('Commit', sha),
    commit: {
      author: { name: author.name, email: author.email, date: isoFromSec(author.ts) },
      committer: { name: committer.name, email: committer.email, date: isoFromSec(committer.ts) },
      message: info.message,
      tree: { sha: info.tree, url: `${repoUrl}/git/trees/${info.tree}` },
      url: `${repoUrl}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${repoUrl}/commits/${sha}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `${repoUrl}/commits/${sha}/comments`,
    author: userJson(viewer, ctx),
    committer: userJson(viewer, ctx),
    parents: info.parents.map((p) => ({
      sha: p,
      url: `${repoUrl}/commits/${p}`,
      html_url: `${base}/${repo.owner}/${repo.name}/commit/${p}`,
    })),
  };
}

/** Full commit shape for a known sha; falls back to a minimal shape. */
function commitDetailJson(ctx: Ctx, repo: Repo, sha: string, fallbackMessage: string): Record<string, unknown> {
  try {
    const found = ctx.store.listCommits(repo, sha);
    if (found.length > 0) return commitJson(found[0].sha, found[0].info, ctx, repo);
  } catch {
    // Fall through to the minimal shape.
  }
  const base = baseUrl(ctx);
  const viewer = ctx.store.viewer;
  return {
    sha,
    node_id: nodeId('Commit', sha),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
    message: fallbackMessage,
    author: { name: viewer.name, email: viewer.email },
    committer: { name: viewer.name, email: viewer.email },
  };
}

function refJson(ctx: Ctx, repo: Repo, ref: string, sha: string): Record<string, unknown> {
  const base = baseUrl(ctx);
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
  return {
    ref,
    node_id: nodeId('Ref', `${repo.id}:${ref}`),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/heads/${encodePath(branch)}`,
    object: {
      sha,
      type: 'commit',
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
    },
  };
}

function branchJson(ctx: Ctx, repo: Repo, name: string, sha: string): Record<string, unknown> {
  const base = baseUrl(ctx);
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    name,
    commit: {
      sha,
      url: `${repoUrl}/commits/${sha}`,
    },
    protected: false,
    protection: {
      enabled: false,
      required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] },
    },
    protection_url: `${repoUrl}/branches/${encodePath(name)}/protection`,
  };
}

function fileJson(ctx: Ctx, repo: Repo, path: string, blob: Buffer, oid: string, size: number): Record<string, unknown> {
  const base = baseUrl(ctx);
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const encoded = encodePath(path);
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name: basename(path),
    path,
    content: b64encode(blob),
    sha: oid,
    url: `${repoUrl}/contents/${encoded}`,
    git_url: `${repoUrl}/git/blobs/${oid}`,
    html_url: `${base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${encoded}`,
    download_url: `${base}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${encoded}`,
    _links: {
      git: `${repoUrl}/git/blobs/${oid}`,
      self: `${repoUrl}/contents/${encoded}`,
      html: `${base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${encoded}`,
    },
  };
}

function dirEntryJson(ctx: Ctx, repo: Repo, name: string, path: string, oid: string, kind: 'blob' | 'tree', size: number): Record<string, unknown> {
  const base = baseUrl(ctx);
  const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
  const encoded = encodePath(path);
  return {
    type: kind === 'blob' ? 'file' : 'dir',
    size,
    name,
    path,
    sha: oid,
    url: `${repoUrl}/contents/${encoded}`,
    git_url: kind === 'blob' ? `${repoUrl}/git/blobs/${oid}` : `${repoUrl}/git/trees/${oid}`,
    html_url: kind === 'blob'
      ? `${base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${encoded}`
      : `${base}/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${encoded}`,
    download_url: kind === 'blob' ? `${base}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${encoded}` : null,
    _links: {
      git: kind === 'blob' ? `${repoUrl}/git/blobs/${oid}` : `${repoUrl}/git/trees/${oid}`,
      self: `${repoUrl}/contents/${encoded}`,
      html: kind === 'blob'
        ? `${base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${encoded}`
        : `${base}/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${encoded}`,
    },
  };
}

/* ------------------------------------------------------------------ */
/* router                                                              */
/* ------------------------------------------------------------------ */

export async function routeRest(ctx: Ctx): Promise<boolean> {
  const s = ctx.segments;
  if (s[0] !== 'api' || s[1] !== 'v3') return false;
  const rest = s.slice(2);
  const method = ctx.method;

  // GET /api/v3[/] — API root. X-OAuth-Scopes is asserted (repos.root).
  if (rest.length === 0) {
    if (method !== 'GET') throw new ApiError(404, 'Not Found');
    const base = baseUrl(ctx);
    sendJson(ctx.res, 200, {
      current_user_url: `${base}/api/v3/user`,
      current_user_authorizations_html_url: `${base}/settings/connections/applications{/client_id}`,
      authorizations_url: `${base}/api/v3/authorizations`,
      code_search_url: `${base}/api/v3/search/code{?q,per_page,page}`,
      commit_search_url: `${base}/api/v3/search/commits{?q,per_page,page}`,
      emails_url: `${base}/api/v3/user/emails`,
      emojis_url: `${base}/api/v3/emojis`,
      events_url: `${base}/api/v3/events`,
      feeds_url: `${base}/api/v3/feeds`,
      followers_url: `${base}/api/v3/user/followers`,
      following_url: `${base}/api/v3/user/following{/target_user}`,
      gists_url: `${base}/api/v3/gists{/gist_id}`,
      hub_url: `${base}/api/v3/hub`,
      issue_search_url: `${base}/api/v3/search/issues{?q,per_page,page}`,
      issues_url: `${base}/api/v3/issues`,
      keys_url: `${base}/api/v3/user/keys`,
      label_search_url: `${base}/api/v3/search/labels{?q,repository_id,per_page,page}`,
      notifications_url: `${base}/api/v3/notifications`,
      organization_url: `${base}/api/v3/orgs/{org}`,
      organization_repositories_url: `${base}/api/v3/orgs/{org}/repos{?type,page,per_page}`,
      organization_teams_url: `${base}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${base}/api/v3/gists/public`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${base}/api/v3/search/repositories{?q,per_page,page}`,
      current_user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page}`,
      starred_url: `${base}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${base}/api/v3/gists/starred`,
      topic_search_url: `${base}/api/v3/search/topics{?q,per_page,page}`,
      user_url: `${base}/api/v3/users/{user}`,
      user_organizations_url: `${base}/api/v3/user/orgs`,
      user_repositories_url: `${base}/api/v3/users/{user}/repos{?type,page,per_page}`,
      user_search_url: `${base}/api/v3/search/users{?q,per_page,page}`,
    }, { 'x-oauth-scopes': OAUTH_SCOPES });
    return true;
  }

  // GET /api/v3/meta
  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') throw new ApiError(404, 'Not Found');
    sendJson(ctx.res, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      installed_version: '1.0.0',
    });
    return true;
  }

  // GET /api/v3/user — the viewer (needed by the MCP checks).
  if (rest[0] === 'user' && rest.length === 1) {
    if (method !== 'GET') throw new ApiError(404, 'Not Found');
    const viewer = ctx.store.viewer;
    sendJson(ctx.res, 200, {
      ...userJson(viewer, ctx),
      company: null,
      blog: '',
      location: null,
      hireable: null,
      bio: null,
      twitter_username: null,
      public_repos: ctx.store.listRepos().length,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    });
    return true;
  }

  // /api/v3/user/repos — create + list the viewer's repos.
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'POST') {
      const body = parseBodyObject(ctx);
      const name = stringField(body, 'name');
      if (name === undefined || name === '') throw new ApiError(422, 'Validation Failed');
      const description = stringField(body, 'description');
      const isPrivate = typeof body.private === 'boolean' ? body.private : undefined;
      const repo = ctx.store.createRepo(name, { description, private: isPrivate });
      sendJson(ctx.res, 201, repoJson(repo, ctx));
      return true;
    }
    if (method === 'GET') {
      const repos = ctx.store.listRepos().map((r) => repoJson(r, ctx));
      const { pageItems, headers } = paginate(repos, ctx);
      sendJson(ctx.res, 200, pageItems, headers);
      return true;
    }
    throw new ApiError(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const repo = requireRepo(ctx, rest[1], rest[2]);
    const sub = rest.slice(3);

    // The repo itself: GET / PATCH / DELETE.
    if (sub.length === 0) {
      if (method === 'GET') {
        sendJson(ctx.res, 200, repoJson(repo, ctx));
        return true;
      }
      if (method === 'PATCH') {
        const body = parseBodyObject(ctx);
        const description = stringField(body, 'description');
        const updated = ctx.store.updateRepo(repo, description === undefined ? {} : { description });
        sendJson(ctx.res, 200, repoJson(updated, ctx));
        return true;
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(repo);
        ctx.res.writeHead(204, { 'content-type': 'application/json; charset=utf-8' });
        ctx.res.end();
        return true;
      }
      throw new ApiError(404, 'Not Found');
    }

    switch (sub[0]) {
      case 'git': {
        if (sub[1] !== 'refs') throw new ApiError(404, 'Not Found');
        if (sub.length === 2) {
          if (method === 'POST') {
            // POST /git/refs — create a branch (ref).
            const body = parseBodyObject(ctx);
            const ref = stringField(body, 'ref');
            const sha = stringField(body, 'sha');
            if (ref === undefined || !ref.startsWith('refs/heads/') || ref === 'refs/heads/') {
              throw new ApiError(422, 'Validation Failed');
            }
            if (sha === undefined || !SHA_RE.test(sha)) {
              throw new ApiError(422, 'Validation Failed');
            }
            const created = ctx.store.createRef(repo, ref, sha.toLowerCase());
            sendJson(ctx.res, 201, refJson(ctx, repo, created.ref, created.sha));
            return true;
          }
          if (method === 'GET') {
            // GET /git/refs — list refs (unasserted, GitHub-compatible).
            const refs = [...repo.refs.entries()]
              .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
              .map(([refName, oid]) => refJson(ctx, repo, refName, oid));
            const { pageItems, headers } = paginate(refs, ctx);
            sendJson(ctx.res, 200, pageItems, headers);
            return true;
          }
          throw new ApiError(404, 'Not Found');
        }
        // GET /git/refs/heads/{branch} — branch may contain '/'.
        if (sub[2] === 'heads' && sub.length >= 4 && method === 'GET') {
          const branch = sub.slice(3).join('/');
          const sha = ctx.store.getRef(repo, `refs/heads/${branch}`);
          if (sha === null) throw new ApiError(404, 'Not Found');
          sendJson(ctx.res, 200, refJson(ctx, repo, `refs/heads/${branch}`, sha));
          return true;
        }
        throw new ApiError(404, 'Not Found');
      }

      case 'branches': {
        if (sub.length === 1) {
          if (method !== 'GET') throw new ApiError(404, 'Not Found');
          const branches = ctx.store.listBranches(repo)
            .map((b) => branchJson(ctx, repo, b.name, b.sha));
          const { pageItems, headers } = paginate(branches, ctx);
          sendJson(ctx.res, 200, pageItems, headers);
          return true;
        }
        // GET /branches/{branch} — branch may contain '/'.
        if (method === 'GET') {
          const branch = sub.slice(1).join('/');
          const sha = ctx.store.getRef(repo, `refs/heads/${branch}`);
          if (sha === null) throw new ApiError(404, 'Not Found');
          sendJson(ctx.res, 200, branchJson(ctx, repo, branch, sha));
          return true;
        }
        throw new ApiError(404, 'Not Found');
      }

      case 'commits': {
        if (sub.length === 1) {
          if (method !== 'GET') throw new ApiError(404, 'Not Found');
          // ?sha= is a branch name (may contain '/') or an oid; absent = default branch.
          const commits = ctx.store.listCommits(repo, ctx.query.get('sha'));
          const shaped = commits.map((c) => commitJson(c.sha, c.info, ctx, repo));
          const { pageItems, headers } = paginate(shaped, ctx);
          sendJson(ctx.res, 200, pageItems, headers);
          return true;
        }
        // GET /commits/{sha} — single commit (unasserted, GitHub-compatible).
        if (method === 'GET') {
          const ref = sub.slice(1).join('/');
          const commits = ctx.store.listCommits(repo, ref);
          if (commits.length === 0) throw new ApiError(404, 'Not Found');
          sendJson(ctx.res, 200, commitJson(commits[0].sha, commits[0].info, ctx, repo));
          return true;
        }
        throw new ApiError(404, 'Not Found');
      }

      case 'contents': {
        // Everything after /contents/ is one repo-relative path (slashes kept).
        const path = sub.slice(1).join('/');
        if (method === 'GET') {
          const result = ctx.store.readPath(repo, ctx.query.get('ref'), path);
          if (result === null) throw new ApiError(404, 'Not Found');
          if (result.kind === 'file') {
            sendJson(ctx.res, 200, fileJson(ctx, repo, path, result.blob, result.oid, result.size));
            return true;
          }
          sendJson(ctx.res, 200, result.entries.map((e) => {
            let size = 0;
            if (e.kind === 'blob') {
              size = ctx.store.getObject(repo, e.oid)?.data.length ?? 0;
            }
            return dirEntryJson(ctx, repo, e.name, e.path, e.oid, e.kind, size);
          }));
          return true;
        }
        if (method === 'PUT') {
          if (path === '') throw new ApiError(422, 'Validation Failed');
          const body = parseBodyObject(ctx);
          const message = stringField(body, 'message');
          const content = stringField(body, 'content');
          if (message === undefined) throw new ApiError(422, 'Validation Failed');
          if (content === undefined) throw new ApiError(422, 'Validation Failed');
          let bytes: Buffer;
          try {
            bytes = b64decode(content);
          } catch {
            throw new ApiError(422, 'Validation Failed');
          }
          const branch = stringField(body, 'branch');
          const sha = stringField(body, 'sha');
          if (sha === undefined) {
            // GitHub requires `sha` when updating an existing file.
            const existing = ctx.store.readPath(repo, branch ?? null, path);
            if (existing !== null) throw new ApiError(422, 'Validation Failed');
          }
          const result = ctx.store.putContents(repo, { path, message, content: bytes, branch, sha });
          const base = baseUrl(ctx);
          const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
          const encoded = encodePath(path);
          sendJson(ctx.res, result.created ? 201 : 200, {
            content: {
              name: basename(path),
              path,
              sha: result.contentSha,
              size: bytes.length,
              url: `${repoUrl}/contents/${encoded}`,
              html_url: `${base}/${repo.owner}/${repo.name}/blob/${branch ?? repo.defaultBranch}/${encoded}`,
              git_url: `${repoUrl}/git/blobs/${result.contentSha}`,
              download_url: `${base}/${repo.owner}/${repo.name}/raw/${branch ?? repo.defaultBranch}/${encoded}`,
              type: 'file',
              encoding: 'base64',
            },
            commit: commitDetailJson(ctx, repo, result.commitSha, message),
          });
          return true;
        }
        if (method === 'DELETE') {
          // DELETE carries a JSON body ({message, sha}) — it must be parsed.
          if (path === '') throw new ApiError(422, 'Validation Failed');
          const body = parseBodyObject(ctx);
          const message = stringField(body, 'message');
          const sha = stringField(body, 'sha');
          if (message === undefined || sha === undefined) throw new ApiError(422, 'Validation Failed');
          const result = ctx.store.deleteContents(repo, { path, message, sha });
          sendJson(ctx.res, 200, {
            content: null,
            commit: commitDetailJson(ctx, repo, result.commitSha, message),
          });
          return true;
        }
        throw new ApiError(404, 'Not Found');
      }

      case 'labels': {
        if (sub.length === 1) {
          if (method === 'POST') {
            const body = parseBodyObject(ctx);
            const name = stringField(body, 'name');
            if (name === undefined || name === '') throw new ApiError(422, 'Validation Failed');
            const color = stringField(body, 'color')?.replace(/^#/, '') ?? 'ededed';
            const label = ctx.store.createLabel(repo, name, color);
            sendJson(ctx.res, 201, labelJson(label, ctx, repo));
            return true;
          }
          if (method === 'GET') {
            const labels = [...repo.labels.values()].map((l) => labelJson(l, ctx, repo));
            const { pageItems, headers } = paginate(labels, ctx);
            sendJson(ctx.res, 200, pageItems, headers);
            return true;
          }
          throw new ApiError(404, 'Not Found');
        }
        // GET /labels/{name} (unasserted, GitHub-compatible; names may hold '/').
        if (method === 'GET') {
          const label = repo.labels.get(sub.slice(1).join('/').toLowerCase());
          if (label === undefined) throw new ApiError(404, 'Not Found');
          sendJson(ctx.res, 200, labelJson(label, ctx, repo));
          return true;
        }
        throw new ApiError(404, 'Not Found');
      }

      case 'issues': {
        if (sub.length === 1) {
          if (method === 'POST') {
            const body = parseBodyObject(ctx);
            const title = stringField(body, 'title');
            if (title === undefined) throw new ApiError(422, 'Validation Failed');
            const issueBody = stringField(body, 'body') ?? '';
            const labels = stringArrayField(body, 'labels');
            const issue = ctx.store.createIssue(repo, { title, body: issueBody, labels });
            sendJson(ctx.res, 201, issueJson(issue, ctx, repo));
            return true;
          }
          if (method === 'GET') {
            const state = normalizeState(ctx.query.get('state'), 'open');
            const direction = ctx.query.get('direction') === 'asc' ? 'asc' : 'desc';
            const issues = ctx.store.listIssues(repo, { state, sort: 'created', direction });
            const shaped = issues.map((i) => issueJson(i, ctx, repo));
            const { pageItems, headers } = paginate(shaped, ctx);
            sendJson(ctx.res, 200, pageItems, headers);
            return true;
          }
          throw new ApiError(404, 'Not Found');
        }
        const n = parseNumber(sub[1]);
        if (n === null) throw new ApiError(404, 'Not Found');
        if (sub.length === 2) {
          if (method === 'GET') {
            const issue = ctx.store.getIssue(repo, n);
            if (issue === null) throw new ApiError(404, 'Not Found');
            sendJson(ctx.res, 200, issueJson(issue, ctx, repo));
            return true;
          }
          if (method === 'PATCH') {
            const body = parseBodyObject(ctx);
            const patch: { state?: 'open' | 'closed'; title?: string; body?: string; labels?: string[] } = {};
            if (body.state !== undefined) {
              if (body.state !== 'open' && body.state !== 'closed') throw new ApiError(422, 'Validation Failed');
              patch.state = body.state;
            }
            const title = stringField(body, 'title');
            if (title !== undefined) patch.title = title;
            const issueBody = stringField(body, 'body');
            if (issueBody !== undefined) patch.body = issueBody;
            const labels = stringArrayField(body, 'labels');
            if (labels !== undefined) patch.labels = labels;
            const issue = ctx.store.updateIssue(repo, n, patch);
            sendJson(ctx.res, 200, issueJson(issue, ctx, repo));
            return true;
          }
          throw new ApiError(404, 'Not Found');
        }
        if (sub[2] === 'comments' && sub.length === 3) {
          if (method === 'POST') {
            const body = parseBodyObject(ctx);
            const commentBody = stringField(body, 'body');
            if (commentBody === undefined) throw new ApiError(422, 'Validation Failed');
            const comment = ctx.store.createComment(repo, n, commentBody);
            sendJson(ctx.res, 201, commentJson(comment, ctx, repo, n));
            return true;
          }
          if (method === 'GET') {
            const comments = ctx.store.listComments(repo, n);
            const shaped = comments.map((c) => commentJson(c, ctx, repo, n));
            const { pageItems, headers } = paginate(shaped, ctx);
            sendJson(ctx.res, 200, pageItems, headers);
            return true;
          }
          throw new ApiError(404, 'Not Found');
        }
        throw new ApiError(404, 'Not Found');
      }

      case 'pulls': {
        if (sub.length === 1) {
          if (method === 'POST') {
            const body = parseBodyObject(ctx);
            const title = stringField(body, 'title');
            let head = stringField(body, 'head');
            let base = stringField(body, 'base');
            if (title === undefined || head === undefined || head === '' || base === undefined || base === '') {
              throw new ApiError(422, 'Validation Failed');
            }
            // Accept GitHub's owner:branch form as well as a plain branch name
            // (branch names cannot contain ':', so stripping is unambiguous).
            if (head.includes(':')) head = head.slice(head.lastIndexOf(':') + 1);
            if (base.includes(':')) base = base.slice(base.lastIndexOf(':') + 1);
            const prBody = stringField(body, 'body') ?? '';
            const pr = ctx.store.createPull(repo, { title, body: prBody, head, base });
            sendJson(ctx.res, 201, prJson(pr, ctx, repo));
            return true;
          }
          if (method === 'GET') {
            const state = normalizeState(ctx.query.get('state'), 'open');
            const pulls = ctx.store.listPulls(repo, { state });
            const shaped = pulls.map((p) => prJson(p, ctx, repo));
            const { pageItems, headers } = paginate(shaped, ctx);
            sendJson(ctx.res, 200, pageItems, headers);
            return true;
          }
          throw new ApiError(404, 'Not Found');
        }
        const n = parseNumber(sub[1]);
        if (n === null) throw new ApiError(404, 'Not Found');
        if (sub.length === 2) {
          if (method !== 'GET') throw new ApiError(404, 'Not Found');
          const pr = ctx.store.getPull(repo, n);
          if (pr === null) throw new ApiError(404, 'Not Found');
          sendJson(ctx.res, 200, prJson(pr, ctx, repo));
          return true;
        }
        if (sub[2] === 'files' && sub.length === 3) {
          if (method !== 'GET') throw new ApiError(404, 'Not Found');
          const pr = ctx.store.getPull(repo, n);
          if (pr === null) throw new ApiError(404, 'Not Found');
          const base = baseUrl(ctx);
          const repoUrl = `${base}/api/v3/repos/${repo.owner}/${repo.name}`;
          const files = ctx.store.pullFiles(repo, pr).map((f) => ({
            sha: f.sha,
            filename: f.filename,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            changes: f.changes,
            blob_url: `${repoUrl}/git/blobs/${f.sha}`,
            raw_url: `${base}/${repo.owner}/${repo.name}/raw/${encodePath(pr.headRef)}/${encodePath(f.filename)}`,
            contents_url: `${repoUrl}/contents/${encodePath(f.filename)}?ref=${encodeURIComponent(pr.headRef)}`,
          }));
          const { pageItems, headers } = paginate(files, ctx);
          sendJson(ctx.res, 200, pageItems, headers);
          return true;
        }
        if (sub[2] === 'merge' && sub.length === 3) {
          if (method !== 'PUT') throw new ApiError(404, 'Not Found');
          // Validates the JSON body; the store always squash-merges.
          parseBodyObject(ctx);
          const result = ctx.store.mergePull(repo, n);
          sendJson(ctx.res, 200, { sha: result.sha, merged: result.merged, message: result.message });
          return true;
        }
        throw new ApiError(404, 'Not Found');
      }

      default:
        throw new ApiError(404, 'Not Found');
    }
  }

  throw new ApiError(404, 'Not Found');
}
