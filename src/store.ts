// The Store: all forge state, all business logic entry points. Pure in-memory
// Maps; no http, no JSON shaping beyond plain data (shaping lives in the API
// layers). Every mutation bumps repo.version; metadata mutations bump
// updatedAt, ref mutations bump pushedAt — all stamps from the logical clock.
// No Date.now, no Math.random anywhere.

import { Clock } from './clock.ts';
import { buildCommit, buildTreeFromFiles, flattenTree, hashObject, parseCommit, parseTag, parseTree, ZERO_OID } from './git-objects.ts';
import { diffFileMaps } from './diff.ts';
import { DEFAULT_BRANCH, viewerUser } from './scenario.ts';
import { ApiError } from './types.ts';
import type { CommitInfo, GitObject, Issue, IssueComment, Label, ObjectType, Oid, PullFile, PullRequest, Repo, User } from './types.ts';

/** Reads MAKEFUN_TRIAL_NOW once for the clock base. */
export function createStore(): Store {
  return new Store(process.env.MAKEFUN_TRIAL_NOW ?? '');
}

const OID_RE = /^[0-9a-f]{40}$/i;

export class Store {
  readonly viewer: User;
  readonly clock: Clock;
  readonly repos: Map<string, Repo>; // key: `${owner}/${name}` — owner is ALWAYS viewer.login
  private nextRepoId: number;        // starts at 1
  private nextGlobalId: number;      // starts at 1 — issue/PR global `id` fields

  constructor(baseIso = '') {
    this.viewer = viewerUser();
    this.clock = new Clock(baseIso);
    this.repos = new Map();
    this.nextRepoId = 1;
    this.nextGlobalId = 1;
  }

  // --- repos ---

  createRepo(name: string, opts: { description?: string; private?: boolean }): Repo {
    const key = `${this.viewer.login}/${name}`;
    if (this.repos.has(key)) throw new ApiError(422, `Repository '${name}' already exists`);
    const now = this.clock.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: this.viewer.login,
      name,
      fullName: key,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now, updatedAt: now, pushedAt: now,
      objects: new Map(), refs: new Map(),
      headRef: `refs/heads/${DEFAULT_BRANCH}`,
      labels: new Map(), issues: new Map(), pulls: new Map(),
      nextNumber: 1, nextCommentId: 1, nextLabelId: 1,
      packCache: new Map(), version: 1,
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** null when owner !== viewer.login OR repo missing (caller maps to 404). */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== this.viewer.login) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  /** Creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.fullName);
  }

  updateRepo(repo: Repo, patch: { description?: string }): Repo {
    if (patch.description !== undefined) repo.description = patch.description;
    repo.version += 1;
    repo.updatedAt = this.clock.nowIso();
    return repo;
  }

  // --- git objects / refs ---

  /** sha1, store, return oid. Bumps version when the object is new. */
  putObject(repo: Repo, type: ObjectType, data: Buffer): Oid {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.version += 1;
    }
    return oid;
  }

  getObject(repo: Repo, oid: Oid): GitObject | null {
    return repo.objects.get(oid) ?? null;
  }

  hasObject(repo: Repo, oid: Oid): boolean {
    return repo.objects.has(oid);
  }

  /**
   * Apply one receive-pack ref command. Returns per-ref outcome; NEVER throws
   * for a refused update (returns {ok:false, reason}). Rules (git-spec §8.3):
   * create (old=ZERO): ref must not exist; new oid's objects must exist.
   * update: old must equal current tip; new must descend from old (FF), else
   *   {ok:false, reason:'non-fast-forward'}; new oid's objects must exist.
   * delete (new=ZERO): old must equal current tip; ref must exist.
   * On success bumps repo.version + pushedAt (for branch updates/creates).
   */
  applyRefUpdate(repo: Repo, ref: string, oldOid: Oid, newOid: Oid): { ok: boolean; reason?: string } {
    const current = repo.refs.get(ref) ?? null;
    if (newOid === ZERO_OID) {
      if (current === null) return { ok: false, reason: 'ref does not exist' };
      if (oldOid !== current) return { ok: false, reason: 'stale old value' };
      repo.refs.delete(ref);
      repo.version += 1;
      return { ok: true };
    }
    if (oldOid === ZERO_OID) {
      if (current !== null) return { ok: false, reason: 'ref already exists' };
      if (!repo.objects.has(newOid)) return { ok: false, reason: 'unknown object' };
      repo.refs.set(ref, newOid);
      repo.version += 1;
      if (ref.startsWith('refs/heads/')) repo.pushedAt = this.clock.nowIso();
      return { ok: true };
    }
    if (current === null) return { ok: false, reason: 'ref does not exist' };
    if (oldOid !== current) return { ok: false, reason: 'stale old value' };
    if (!repo.objects.has(newOid)) return { ok: false, reason: 'unknown object' };
    if (!this.isAncestor(repo, oldOid, newOid)) return { ok: false, reason: 'non-fast-forward' };
    repo.refs.set(ref, newOid);
    repo.version += 1;
    if (ref.startsWith('refs/heads/')) repo.pushedAt = this.clock.nowIso();
    return { ok: true };
  }

  getRef(repo: Repo, ref: string): Oid | null {
    return repo.refs.get(ref) ?? null;
  }

  /** refs/heads/*, sorted by name. */
  listBranches(repo: Repo): { name: string; sha: Oid }[] {
    const out: { name: string; sha: Oid }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  /** Walk parents; ancestor==descendant => true. Tag objects are peeled. */
  isAncestor(repo: Repo, ancestor: Oid, descendant: Oid): boolean {
    const a = this.peelToCommit(repo, ancestor);
    const d = this.peelToCommit(repo, descendant);
    if (a === null || d === null) return ancestor === descendant;
    if (a === d) return true;
    const seen = new Set<Oid>();
    const stack = [d];
    while (stack.length > 0) {
      const oid = stack.pop() as Oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) {
        if (p === a) return true;
        stack.push(p);
      }
    }
    return false;
  }

  /** First common ancestor (BFS from both). Tag objects are peeled. */
  mergeBase(repo: Repo, a: Oid, b: Oid): Oid | null {
    const startA = this.peelToCommit(repo, a);
    const startB = this.peelToCommit(repo, b);
    if (startA === null || startB === null) return null;
    const ancestorsA = new Set<Oid>();
    const queueA = [startA];
    for (let i = 0; i < queueA.length; i += 1) {
      const oid = queueA[i];
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') queueA.push(...parseCommit(obj.data).parents);
    }
    const seenB = new Set<Oid>();
    const queueB = [startB];
    for (let i = 0; i < queueB.length; i += 1) {
      const oid = queueB[i];
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') queueB.push(...parseCommit(obj.data).parents);
    }
    return null;
  }

  /**
   * Newest-first walk from the tip of `ref` (branch name or full refname or
   * oid; null => default branch). Unknown ref => ApiError(404). Full history
   * walk (all parents), depth-first with a visited set, emitting in visit
   * order. An unborn branch yields [].
   */
  listCommits(repo: Repo, ref: string | null): { sha: Oid; info: CommitInfo }[] {
    if (ref !== null && !this.refExists(repo, ref)) throw new ApiError(404, `Unknown ref '${ref}'`);
    const tip = this.resolveTip(repo, ref);
    if (tip === null) return [];
    const start = this.peelToCommit(repo, tip);
    if (start === null) throw new ApiError(404, `Ref '${ref ?? repo.defaultBranch}' does not point to a commit`);
    const out: { sha: Oid; info: CommitInfo }[] = [];
    const visited = new Set<Oid>();
    const stack = [start];
    while (stack.length > 0) {
      const oid = stack.pop() as Oid;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const info = parseCommit(obj.data);
      out.push({ sha: oid, info });
      for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]);
    }
    return out;
  }

  /**
   * Create a commit object (author/committer = viewer, logical clock) and move
   * `branch` to it. parentOid null => root commit. Returns the commit oid.
   * The message is stored verbatim (no trailing newline added).
   */
  commitOnBranch(repo: Repo, branch: string, message: string, treeOid: Oid, parentOid: Oid | null): Oid {
    const sec = this.clock.nowSec();
    const ident = `${this.viewer.name} <${this.viewer.email}> ${sec} +0000`;
    const data = buildCommit({
      tree: treeOid,
      parents: parentOid === null ? [] : [parentOid],
      author: ident,
      committer: ident,
      message,
    });
    const oid = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.version += 1;
    repo.pushedAt = this.clock.nowIso();
    return oid;
  }

  // --- contents (backed by real git objects) ---

  /**
   * Read a path at a ref (branch name / oid / null=default branch).
   * Returns file | dir listing | null when the ref, path, or repo state is
   * missing (caller maps to 404). Empty (unborn) repo => null.
   */
  readPath(repo: Repo, ref: string | null, path: string):
    | { kind: 'file'; blob: Buffer; oid: Oid; size: number }
    | { kind: 'dir'; entries: { name: string; path: string; oid: Oid; kind: 'blob' | 'tree' }[] }
    | null {
    const tip = this.resolveTip(repo, ref);
    if (tip === null) return null;
    const treeOid = this.commitTree(repo, tip);
    if (treeOid === null) return null;
    const clean = path.replace(/^\/+|\/+$/g, '');
    if (clean === '') return { kind: 'dir', entries: this.dirEntries(repo, treeOid, '') };
    const segments = clean.split('/');
    let currentTree = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const obj = repo.objects.get(currentTree);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
      if (!entry || entry.mode === '160000') return null;
      const isLast = i === segments.length - 1;
      if (entry.kind === 'tree') {
        if (!isLast) { currentTree = entry.oid; continue; }
        return { kind: 'dir', entries: this.dirEntries(repo, entry.oid, clean) };
      }
      if (!isLast) return null;
      const blob = repo.objects.get(entry.oid);
      if (!blob) return null;
      return { kind: 'file', blob: blob.data, oid: entry.oid, size: blob.data.length };
    }
    return null;
  }

  /**
   * Create/update a file: builds a new tree + commit on `branch` (default:
   * default branch). opts.sha (when given) must equal the file's current blob
   * oid else ApiError(409). Unknown branch => ApiError(422).
   * Works on an unborn repo (creates the default branch).
   */
  putContents(repo: Repo, opts: { path: string; message: string; content: Buffer; branch?: string; sha?: string }):
    { contentSha: Oid; commitSha: Oid; created: boolean } {
    const branch = opts.branch ?? repo.defaultBranch;
    const parentOid = repo.refs.get(`refs/heads/${branch}`) ?? null;
    if (parentOid === null && (repo.refs.size !== 0 || branch !== repo.defaultBranch)) {
      throw new ApiError(422, `Unknown branch '${branch}'`);
    }
    const clean = opts.path.replace(/^\/+|\/+$/g, '');
    const segments = clean.split('/');
    if (clean === '' || segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new ApiError(422, `Invalid path '${opts.path}'`);
    }
    const baseTreeOid = parentOid === null ? null : this.commitTree(repo, parentOid);
    const current = parentOid === null ? null : this.readPath(repo, branch, clean);
    if (current !== null && current.kind === 'dir') {
      throw new ApiError(422, `Path '${opts.path}' is a directory`);
    }
    const currentOid = current !== null && current.kind === 'file' ? current.oid : null;
    const existed = currentOid !== null;
    if (opts.sha !== undefined) {
      if (!existed) throw new ApiError(422, `File '${opts.path}' does not exist`);
      if (opts.sha.toLowerCase() !== (currentOid as string).toLowerCase()) {
        throw new ApiError(409, `sha does not match the current blob for '${opts.path}'`);
      }
    } else if (existed) {
      throw new ApiError(422, `sha is required to update '${opts.path}'`);
    }
    const changes = new Map<string, Buffer | null>([[clean, opts.content]]);
    const { treeOid, created } = buildTreeFromFiles((oid) => this.getObject(repo, oid), baseTreeOid, changes);
    for (const o of created) this.putObject(repo, o.type, o.data);
    const commitSha = this.commitOnBranch(repo, branch, opts.message, treeOid, parentOid);
    return { contentSha: hashObject('blob', opts.content), commitSha, created: !existed };
  }

  /**
   * Delete a file: commit on the default branch. Missing file => ApiError(404).
   * opts.sha mismatch => ApiError(409).
   */
  deleteContents(repo: Repo, opts: { path: string; message: string; sha: string }): { commitSha: Oid } {
    const branch = repo.defaultBranch;
    const parentOid = repo.refs.get(`refs/heads/${branch}`) ?? null;
    if (parentOid === null) throw new ApiError(404, `File '${opts.path}' not found`);
    const current = this.readPath(repo, branch, opts.path);
    if (current === null || current.kind !== 'file') throw new ApiError(404, `File '${opts.path}' not found`);
    if (opts.sha.toLowerCase() !== current.oid.toLowerCase()) {
      throw new ApiError(409, `sha does not match the current blob for '${opts.path}'`);
    }
    const baseTreeOid = this.commitTree(repo, parentOid);
    const changes = new Map<string, Buffer | null>([[opts.path.replace(/^\/+|\/+$/g, ''), null]]);
    const { treeOid, created } = buildTreeFromFiles((oid) => this.getObject(repo, oid), baseTreeOid, changes);
    for (const o of created) this.putObject(repo, o.type, o.data);
    const commitSha = this.commitOnBranch(repo, branch, opts.message, treeOid, parentOid);
    return { commitSha };
  }

  /**
   * ref must be 'refs/heads/<branch>'; sha must be an existing commit; ref
   * must not exist yet. Else ApiError(422).
   */
  createRef(repo: Repo, ref: string, sha: Oid): { ref: string; sha: Oid } {
    if (!ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
      throw new ApiError(422, `Invalid ref '${ref}'`);
    }
    const obj = repo.objects.get(sha);
    if (!obj || obj.type !== 'commit') throw new ApiError(422, `Unknown commit '${sha}'`);
    if (repo.refs.has(ref)) throw new ApiError(422, `Ref '${ref}' already exists`);
    repo.refs.set(ref, sha);
    repo.version += 1;
    repo.pushedAt = this.clock.nowIso();
    return { ref, sha };
  }

  // --- labels / issues / comments ---

  /** 422 if a label of that name exists (case-insensitive). */
  createLabel(repo: Repo, name: string, color: string): Label {
    const key = name.toLowerCase();
    if (repo.labels.has(key)) throw new ApiError(422, `Label '${name}' already exists`);
    const label: Label = { id: repo.nextLabelId++, name, color, description: '' };
    repo.labels.set(key, label);
    repo.version += 1;
    repo.updatedAt = this.clock.nowIso();
    return label;
  }

  /** Unknown label name => ApiError(422). Labels matched case-insensitively. */
  createIssue(repo: Repo, opts: { title: string; body: string; labels?: string[] }): Issue {
    const labels: Label[] = [];
    for (const name of opts.labels ?? []) {
      const label = repo.labels.get(name.toLowerCase());
      if (!label) throw new ApiError(422, `Unknown label '${name}'`);
      labels.push(label);
    }
    const number = repo.nextNumber++;
    const now = this.clock.nowIso();
    const issue: Issue = {
      number, id: this.nextGlobalId++, title: opts.title, body: opts.body,
      state: 'open', labels, user: this.viewer, comments: [],
      createdAt: now, updatedAt: now, closedAt: null, seq: number,
    };
    repo.issues.set(number, issue);
    repo.version += 1;
    repo.updatedAt = now;
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | null {
    return repo.issues.get(number) ?? null;
  }

  /** Default state 'open', sort 'created', direction 'desc'. Order by seq. */
  listIssues(repo: Repo, opts: { state?: 'open' | 'closed' | 'all'; sort?: 'created'; direction?: 'asc' | 'desc' }): Issue[] {
    const state = opts.state ?? 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    const direction = opts.direction ?? 'desc';
    list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    return list;
  }

  /** Unknown issue => ApiError(404); unknown label => ApiError(422). Sets closedAt on close. */
  updateIssue(repo: Repo, number: number, patch: { state?: 'open' | 'closed'; title?: string; body?: string; labels?: string[] }): Issue {
    const issue = repo.issues.get(number);
    if (!issue) throw new ApiError(404, `Issue #${number} not found`);
    let labels: Label[] | undefined;
    if (patch.labels !== undefined) {
      labels = [];
      for (const name of patch.labels) {
        const label = repo.labels.get(name.toLowerCase());
        if (!label) throw new ApiError(422, `Unknown label '${name}'`);
        labels.push(label);
      }
    }
    const now = this.clock.nowIso();
    if (patch.state === 'closed' && issue.state !== 'closed') issue.closedAt = now;
    if (patch.state === 'open') issue.closedAt = null;
    if (patch.state !== undefined) issue.state = patch.state;
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    if (labels !== undefined) issue.labels = labels;
    issue.updatedAt = now;
    repo.version += 1;
    repo.updatedAt = now;
    return issue;
  }

  /** Unknown issue => 404. */
  createComment(repo: Repo, issueNumber: number, body: string): IssueComment {
    const issue = repo.issues.get(issueNumber);
    if (!issue) throw new ApiError(404, `Issue #${issueNumber} not found`);
    const now = this.clock.nowIso();
    const comment: IssueComment = {
      id: repo.nextCommentId++, issueNumber, body, user: this.viewer, createdAt: now, updatedAt: now,
    };
    issue.comments.push(comment);
    issue.updatedAt = now;
    repo.version += 1;
    repo.updatedAt = now;
    return comment;
  }

  /** Unknown issue => 404; creation order. */
  listComments(repo: Repo, issueNumber: number): IssueComment[] {
    const issue = repo.issues.get(issueNumber);
    if (!issue) throw new ApiError(404, `Issue #${issueNumber} not found`);
    return issue.comments.slice();
  }

  // --- pull requests ---

  /**
   * head/base are branch names; both must exist else ApiError(422).
   * headSha/baseSha frozen from live branch tips at creation.
   */
  createPull(repo: Repo, opts: { title: string; body: string; head: string; base: string }): PullRequest {
    const headSha = repo.refs.get(`refs/heads/${opts.head}`) ?? null;
    const baseSha = repo.refs.get(`refs/heads/${opts.base}`) ?? null;
    if (headSha === null) throw new ApiError(422, `Unknown branch '${opts.head}'`);
    if (baseSha === null) throw new ApiError(422, `Unknown branch '${opts.base}'`);
    const number = repo.nextNumber++;
    const now = this.clock.nowIso();
    const pr: PullRequest = {
      number, id: this.nextGlobalId++, title: opts.title, body: opts.body,
      state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
      headRef: opts.head, headSha, baseRef: opts.base, baseSha,
      user: this.viewer, createdAt: now, updatedAt: now, closedAt: null, seq: number,
    };
    repo.pulls.set(number, pr);
    repo.version += 1;
    repo.updatedAt = now;
    return pr;
  }

  getPull(repo: Repo, number: number): PullRequest | null {
    return repo.pulls.get(number) ?? null;
  }

  /** Default 'open'; newest first. */
  listPulls(repo: Repo, opts: { state?: 'open' | 'closed' | 'all' }): PullRequest[] {
    const state = opts.state ?? 'open';
    let list = [...repo.pulls.values()];
    if (state !== 'all') list = list.filter((p) => p.state === state);
    list.sort((a, b) => b.seq - a.seq);
    return list;
  }

  /** merge-base(head, base) -> head diff. */
  pullFiles(repo: Repo, pr: PullRequest): PullFile[] {
    const mb = this.mergeBase(repo, pr.headSha, pr.baseSha);
    const headTree = this.commitTree(repo, pr.headSha);
    const baseTree = mb === null ? null : this.commitTree(repo, mb);
    const get = (oid: Oid): GitObject | null => this.getObject(repo, oid);
    const oldMap = baseTree === null ? new Map<string, { oid: Oid; mode: string }>() : flattenTree(get, baseTree);
    const newMap = headTree === null ? new Map<string, { oid: Oid; mode: string }>() : flattenTree(get, headTree);
    return diffFileMaps(oldMap, newMap, (oid) => repo.objects.get(oid)?.data ?? null);
  }

  /** False when three-way merge vs CURRENT base tip conflicts (or PR not open). */
  isMergeable(repo: Repo, pr: PullRequest): boolean {
    if (pr.state !== 'open' || pr.merged) return false;
    const plan = this.planMerge(repo, pr);
    return plan !== null && !plan.conflict;
  }

  /**
   * Squash-merge onto the CURRENT base tip: one commit (parent = base tip,
   * tree = base tree + head's net changes vs merge-base, message =
   * `<title> (#<number>)`), base branch advances, PR closed+merged with
   * mergedAt + mergeCommitSha. Unknown PR => ApiError(404). Already
   * merged/closed => ApiError(405). Conflict => ApiError(405).
   */
  mergePull(repo: Repo, number: number): { sha: Oid; merged: true; message: string } {
    const pr = repo.pulls.get(number);
    if (!pr) throw new ApiError(404, `Pull request #${number} not found`);
    if (pr.state !== 'open' || pr.merged) throw new ApiError(405, `Pull request #${number} is not open`);
    const plan = this.planMerge(repo, pr);
    if (plan === null || plan.conflict) throw new ApiError(405, `Pull request #${number} cannot be merged`);
    const { treeOid, created } = buildTreeFromFiles((oid) => this.getObject(repo, oid), plan.baseTreeOid, plan.changes);
    for (const o of created) this.putObject(repo, o.type, o.data);
    const message = `${pr.title} (#${pr.number})`;
    const sha = this.commitOnBranch(repo, pr.baseRef, message, treeOid, plan.baseTip);
    const now = this.clock.nowIso();
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = now;
    pr.mergeCommitSha = sha;
    pr.closedAt = now;
    pr.updatedAt = now;
    repo.version += 1;
    repo.updatedAt = now;
    return { sha, merged: true, message: 'Pull Request successfully merged' };
  }

  // --- private helpers ---

  /** Follow tag objects to a commit oid; null when missing / not a commit. */
  private peelToCommit(repo: Repo, oid: Oid): Oid | null {
    let cur = oid;
    const seen = new Set<Oid>();
    for (;;) {
      if (seen.has(cur)) return null;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj) return null;
      if (obj.type === 'commit') return cur;
      if (obj.type === 'tag') { cur = parseTag(obj.data).object; continue; }
      return null;
    }
  }

  /** The tree oid of a commit (peeling tags); null when unresolvable. */
  private commitTree(repo: Repo, oid: Oid): Oid | null {
    const commitOid = this.peelToCommit(repo, oid);
    if (commitOid === null) return null;
    const obj = repo.objects.get(commitOid);
    if (!obj) return null;
    return parseCommit(obj.data).tree;
  }

  /**
   * Resolve a ref to a tip oid: null => default branch; 40-hex => the object
   * itself (when present); 'refs/...' => the ref; otherwise a branch name.
   * Null when the ref is unknown or the branch is unborn.
   */
  private resolveTip(repo: Repo, ref: string | null): Oid | null {
    if (ref === null) return repo.refs.get(repo.headRef) ?? null;
    if (OID_RE.test(ref)) {
      const oid = ref.toLowerCase();
      return repo.objects.has(oid) ? oid : null;
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    return repo.refs.get(`refs/heads/${ref}`) ?? null;
  }

  /** Does this ref name exist (branch, full refname, or present object oid)? */
  private refExists(repo: Repo, ref: string): boolean {
    if (OID_RE.test(ref)) return repo.objects.has(ref.toLowerCase());
    if (ref.startsWith('refs/')) return repo.refs.has(ref);
    return repo.refs.has(`refs/heads/${ref}`);
  }

  /** Direct children of a tree, with repo-relative paths. */
  private dirEntries(repo: Repo, treeOid: Oid, prefix: string): { name: string; path: string; oid: Oid; kind: 'blob' | 'tree' }[] {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return [];
    const out: { name: string; path: string; oid: Oid; kind: 'blob' | 'tree' }[] = [];
    for (const e of parseTree(obj.data)) {
      if (e.mode === '160000') continue;
      out.push({ name: e.name, path: prefix === '' ? e.name : `${prefix}/${e.name}`, oid: e.oid, kind: e.kind });
    }
    return out;
  }

  /**
   * Three-way merge plan vs the CURRENT base tip. Conflict rule (file-granular):
   * for each path, B = merge-base content, H = head content, T = current-base
   * content (blob oid or absent). Conflict iff H != B AND T != B AND H != T.
   * Squash tree: start from T's tree; for each path where H != B, set to H
   * (or delete if H absent). Returns null when the merge is impossible
   * (base branch gone, no merge-base, missing objects).
   */
  private planMerge(repo: Repo, pr: PullRequest): { baseTip: Oid; baseTreeOid: Oid; changes: Map<string, Buffer | null>; conflict: boolean } | null {
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? null;
    if (baseTip === null) return null;
    const mb = this.mergeBase(repo, pr.headSha, baseTip);
    if (mb === null) return null;
    const baseTreeOid = this.commitTree(repo, baseTip);
    const headTreeOid = this.commitTree(repo, pr.headSha);
    const mbTreeOid = this.commitTree(repo, mb);
    if (baseTreeOid === null || headTreeOid === null || mbTreeOid === null) return null;
    const get = (oid: Oid): GitObject | null => this.getObject(repo, oid);
    const bMap = flattenTree(get, mbTreeOid);
    const hMap = flattenTree(get, headTreeOid);
    const tMap = flattenTree(get, baseTreeOid);
    const changes = new Map<string, Buffer | null>();
    let conflict = false;
    const paths = new Set<string>([...bMap.keys(), ...hMap.keys(), ...tMap.keys()]);
    for (const path of paths) {
      const b = bMap.get(path)?.oid ?? null;
      const h = hMap.get(path)?.oid ?? null;
      const t = tMap.get(path)?.oid ?? null;
      if (h === b) continue; // head unchanged vs merge-base: keep T's version
      if (t !== b && h !== t) { conflict = true; continue; }
      if (h === null) {
        changes.set(path, null);
      } else {
        const blob = repo.objects.get(h);
        if (!blob) { conflict = true; continue; }
        changes.set(path, blob.data);
      }
    }
    return { baseTip, baseTreeOid, changes, conflict };
  }
}
