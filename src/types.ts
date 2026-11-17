// Shared types for the forge — the contract pinned in interfaces.md.
// Every layer imports its shared shapes from here; this file imports the
// Store only as a type, so there is no runtime cycle.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export type Oid = string; // 40 lowercase hex chars
export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface User { id: number; login: string; name: string; email: string; }

export interface GitObject { type: ObjectType; data: Buffer; }

export interface CommitInfo {
  tree: Oid; parents: Oid[];
  author: string;    // full 'Name <email> ts +0000' line (without 'author ' prefix)
  committer: string; // same shape
  message: string;   // bytes after the blank line, as utf8 (may contain trailing \n)
}

export interface TreeEntry { mode: string; name: string; oid: Oid; kind: 'blob' | 'tree'; }

export interface TagInfo { object: Oid; type: ObjectType; tag: string; tagger: string; message: string; }

export interface Label { id: number; name: string; color: string; description: string; }

export interface IssueComment {
  id: number; issueNumber: number; body: string; user: User;
  createdAt: string; updatedAt: string;
}

export interface Issue {
  number: number; id: number; title: string; body: string;
  state: 'open' | 'closed'; labels: Label[]; user: User;
  comments: IssueComment[];
  createdAt: string; updatedAt: string; closedAt: string | null;
  seq: number; // creation sequence (monotonic per repo) — order by this for sort=created
}

export interface PullRequest {
  number: number; id: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean;
  mergedAt: string | null; mergeCommitSha: Oid | null;
  headRef: string; headSha: Oid; baseRef: string; baseSha: Oid;
  user: User; createdAt: string; updatedAt: string; closedAt: string | null;
  seq: number;
}

export interface PullFile {
  filename: string; status: 'added' | 'modified' | 'removed';
  additions: number; deletions: number; changes: number; sha: Oid;
}

export interface Repo {
  id: number; owner: string; name: string; fullName: string;
  description: string; private: boolean; defaultBranch: string;
  createdAt: string; updatedAt: string; pushedAt: string;
  objects: Map<Oid, GitObject>;
  refs: Map<string, Oid>;      // full refname ('refs/heads/main') -> oid
  headRef: string;             // 'refs/heads/<defaultBranch>'
  labels: Map<string, Label>;  // key: label name LOWERCASED (lookup is case-insensitive)
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  nextNumber: number;          // shared issue/PR counter, starts at 1
  nextCommentId: number;       // starts at 1 (per repo)
  nextLabelId: number;         // starts at 1 (per repo)
  packCache: Map<string, Buffer>; // git layer's pack cache (key includes wants/haves/depth)
  version: number;             // bumped on EVERY mutation (caches key off it)
}

/** HTTP-style error a layer throws; app.ts converts it to status + {"message":...}. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  method: string;            // e.g. 'GET'
  path: string;              // pathname, percent-DECODED (decode each segment; '/' separators kept)
  segments: string[];        // path split on '/', decoded, no empty entries
  query: URLSearchParams;
  body: Buffer;              // full request body (possibly empty)
  host: string;              // request Host header, or 'localhost'
  requestId: string;         // e.g. 'req-00000001' — app.ts assigns, increments per request
  authed: boolean;           // app.ts enforces auth before routing; layers may assume true
}
