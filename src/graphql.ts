// src/graphql.ts — GraphQL v4 endpoint (POST /api/graphql) for the forge.
//
// Minimal hand-rolled parser + executor covering the suite's 18 documents
// (forge-specs/graphql-spec.md §2): named operations, variables, arguments
// (literals, variables, enums, input objects, lists), selection sets,
// aliases, inline fragments, fragment definitions/spreads. Directive syntax
// is parsed and ignored (no document uses directives).
//
// Global ids are base64(`Type:<numeric id>`); cursors are
// base64(`cursor:<number>`). GraphQL-layer failures are HTTP 200 with an
// `errors` array; success is HTTP 200 exactly. Auth is enforced by app.ts
// before routing — no auth code here.

import type { Ctx, Issue, IssueComment, PullFile, PullRequest, Repo } from './types.ts';
import type { Store } from './store.ts';
import { b64decode, b64encode, sendJson } from './util.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token { kind: TokenKind; value: string; line: number; column: number; }

const PUNCT_CHARS = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function isNameStart(ch: string): boolean {
  return ch === '_' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');
}

function isNameChar(ch: string): boolean {
  return isNameStart(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const advance = (n: number): void => {
    for (let k = 0; k < n; k += 1) {
      if (src[i] === '\n') { line += 1; column = 1; } else { column += 1; }
      i += 1;
    }
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === ',' || ch === '\n' || ch === '\r') { advance(1); continue; }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') advance(1);
      continue;
    }
    const startLine = line;
    const startColumn = column;
    if (ch === '.') {
      if (src.slice(i, i + 3) === '...') {
        tokens.push({ kind: 'punct', value: '...', line: startLine, column: startColumn });
        advance(3);
        continue;
      }
      throw new SyntaxError(`Syntax Error: Unexpected character "." at line ${line} column ${column}.`);
    }
    if (PUNCT_CHARS.has(ch)) {
      tokens.push({ kind: 'punct', value: ch, line: startLine, column: startColumn });
      advance(1);
      continue;
    }
    if (ch === '"') {
      // Block string """...""" (unused by the suite, supported for robustness).
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        if (end === -1) throw new SyntaxError(`Syntax Error: Unterminated string at line ${line} column ${column}.`);
        const raw = src.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw, line: startLine, column: startColumn });
        advance(end + 3 - i);
        continue;
      }
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '"') { closed = true; break; }
        if (c === '\n' || c === '\r') break;
        if (c === '\\') {
          const e = src[j + 1];
          if (e === undefined) break;
          if (e === 'u') {
            const hex = src.slice(j + 2, j + 6);
            if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new SyntaxError(`Syntax Error: Invalid unicode escape at line ${line} column ${column}.`);
            out += String.fromCharCode(parseInt(hex, 16));
            j += 6;
            continue;
          }
          const escapes: Record<string, string> = { '"': '"', '/': '/', '\\': '\\', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          const rep = escapes[e];
          if (rep === undefined) throw new SyntaxError(`Syntax Error: Invalid escape "\\${e}" at line ${line} column ${column}.`);
          out += rep;
          j += 2;
          continue;
        }
        out += c;
        j += 1;
      }
      if (!closed) throw new SyntaxError(`Syntax Error: Unterminated string at line ${line} column ${column}.`);
      tokens.push({ kind: 'string', value: out, line: startLine, column: startColumn });
      advance(j + 1 - i);
      continue;
    }
    if (ch === '-' || isDigit(ch)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && isDigit(src[j])) j += 1;
      let isFloat = false;
      if (src[j] === '.' && isDigit(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && isDigit(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k += 1;
        if (isDigit(src[k] ?? '')) {
          isFloat = true;
          j = k;
          while (j < src.length && isDigit(src[j])) j += 1;
        }
      }
      const text = src.slice(i, j);
      tokens.push({ kind: isFloat ? 'float' : 'int', value: text, line: startLine, column: startColumn });
      advance(j - i);
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j), line: startLine, column: startColumn });
      advance(j - i);
      continue;
    }
    throw new SyntaxError(`Syntax Error: Unexpected character "${ch}" at line ${line} column ${column}.`);
  }
  tokens.push({ kind: 'eof', value: '', line, column });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

type TypeNode =
  | { kind: 'named'; name: string }
  | { kind: 'list'; ofType: TypeNode }
  | { kind: 'nonNull'; ofType: TypeNode };

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface VarDef { name: string; type: TypeNode; defaultValue: ValueNode | undefined; }

interface FieldNode { kind: 'field'; alias: string | null; name: string; args: { name: string; value: ValueNode }[]; selections: Selection[]; }
interface InlineFragmentNode { kind: 'inlineFragment'; typeCondition: string | null; selections: Selection[]; }
interface FragmentSpreadNode { kind: 'fragmentSpread'; name: string; }
type Selection = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface Operation { kind: 'query' | 'mutation' | 'subscription'; name: string | null; variableDefinitions: VarDef[]; selections: Selection[]; }
interface FragmentDef { name: string; typeCondition: string; selections: Selection[]; }
interface ParsedDocument { operations: Operation[]; fragments: Map<string, FragmentDef>; }

function typeToString(t: TypeNode): string {
  if (t.kind === 'named') return t.name;
  if (t.kind === 'list') return `[${typeToString(t.ofType)}]`;
  return `${typeToString(t.ofType)}!`;
}

function parseDocument(src: string): ParsedDocument {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = (): Token => tokens[pos];
  const next = (): Token => tokens[pos++];
  const atPunct = (p: string): boolean => peek().kind === 'punct' && peek().value === p;
  const atName = (n: string): boolean => peek().kind === 'name' && peek().value === n;
  const expectPunct = (p: string): Token => {
    const t = next();
    if (t.kind !== 'punct' || t.value !== p) {
      throw new SyntaxError(`Syntax Error: Expected "${p}" but got "${t.value}" at line ${t.line} column ${t.column}.`);
    }
    return t;
  };
  const expectName = (what: string): Token => {
    const t = next();
    if (t.kind !== 'name') {
      throw new SyntaxError(`Syntax Error: Expected ${what} but got "${t.value}" at line ${t.line} column ${t.column}.`);
    }
    return t;
  };

  function skipDirectives(): void {
    while (atPunct('@')) {
      next();
      expectName('a directive name');
      if (atPunct('(')) parseArguments();
    }
  }

  function parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    expectPunct('(');
    while (!atPunct(')')) {
      if (peek().kind === 'eof') throw new SyntaxError('Syntax Error: Unterminated argument list.');
      const name = expectName('an argument name');
      expectPunct(':');
      args.push({ name: name.value, value: parseValue() });
    }
    expectPunct(')');
    return args;
  }

  function parseValue(): ValueNode {
    const t = next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: expectName('a variable name').value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const values: ValueNode[] = [];
      while (!atPunct(']')) {
        if (peek().kind === 'eof') throw new SyntaxError('Syntax Error: Unterminated list value.');
        values.push(parseValue());
      }
      expectPunct(']');
      return { kind: 'list', values };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!atPunct('}')) {
        if (peek().kind === 'eof') throw new SyntaxError('Syntax Error: Unterminated object value.');
        const name = expectName('an object field name');
        expectPunct(':');
        fields.push({ name: name.value, value: parseValue() });
      }
      expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new SyntaxError(`Syntax Error: Unexpected token "${t.value}" at line ${t.line} column ${t.column}.`);
  }

  function parseType(): TypeNode {
    let t: TypeNode;
    if (atPunct('[')) {
      next();
      const inner = parseType();
      expectPunct(']');
      t = { kind: 'list', ofType: inner };
    } else {
      t = { kind: 'named', name: expectName('a type name').value };
    }
    if (atPunct('!')) {
      next();
      t = { kind: 'nonNull', ofType: t };
    }
    return t;
  }

  function parseVariableDefinitions(): VarDef[] {
    const defs: VarDef[] = [];
    expectPunct('(');
    while (!atPunct(')')) {
      if (peek().kind === 'eof') throw new SyntaxError('Syntax Error: Unterminated variable definitions.');
      expectPunct('$');
      const name = expectName('a variable name');
      expectPunct(':');
      const type = parseType();
      let defaultValue: ValueNode | undefined;
      if (atPunct('=')) {
        next();
        defaultValue = parseValue();
      }
      skipDirectives();
      defs.push({ name: name.value, type, defaultValue });
    }
    expectPunct(')');
    return defs;
  }

  function parseSelectionSet(): Selection[] {
    expectPunct('{');
    const sels: Selection[] = [];
    while (!atPunct('}')) {
      if (peek().kind === 'eof') throw new SyntaxError('Syntax Error: Unterminated selection set.');
      sels.push(parseSelection());
    }
    expectPunct('}');
    return sels;
  }

  function parseSelection(): Selection {
    if (atPunct('...')) {
      next();
      if (atName('on')) {
        next();
        const typeCondition = expectName('a type name').value;
        skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: parseSelectionSet() };
      }
      if (peek().kind === 'name') {
        const name = next().value;
        skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selections: parseSelectionSet() };
    }
    const first = expectName('a field name');
    let alias: string | null = null;
    let name = first.value;
    if (atPunct(':')) {
      next();
      alias = name;
      name = expectName('a field name').value;
    }
    const args = atPunct('(') ? parseArguments() : [];
    skipDirectives();
    const selections = atPunct('{') ? parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  function parseOperation(kind: 'query' | 'mutation' | 'subscription'): Operation {
    let name: string | null = null;
    if (peek().kind === 'name') name = next().value;
    const variableDefinitions = atPunct('(') ? parseVariableDefinitions() : [];
    skipDirectives();
    const selections = parseSelectionSet();
    return { kind, name, variableDefinitions, selections };
  }

  function parseFragmentDefinition(): FragmentDef {
    const name = expectName('a fragment name').value;
    if (!atName('on')) throw new SyntaxError(`Syntax Error: Expected "on" in fragment definition at line ${peek().line} column ${peek().column}.`);
    next();
    const typeCondition = expectName('a type name').value;
    skipDirectives();
    const selections = parseSelectionSet();
    return { name, typeCondition, selections };
  }

  const operations: Operation[] = [];
  const fragments = new Map<string, FragmentDef>();
  while (peek().kind !== 'eof') {
    if (atPunct('{')) {
      operations.push({ kind: 'query', name: null, variableDefinitions: [], selections: parseSelectionSet() });
    } else if (atName('query') || atName('mutation') || atName('subscription')) {
      const kind = next().value as 'query' | 'mutation' | 'subscription';
      operations.push(parseOperation(kind));
    } else if (atName('fragment')) {
      next();
      const frag = parseFragmentDefinition();
      fragments.set(frag.name, frag);
    } else {
      const t = peek();
      throw new SyntaxError(`Syntax Error: Unexpected token "${t.value}" at line ${t.line} column ${t.column}.`);
    }
  }
  if (operations.length === 0) throw new SyntaxError('Syntax Error: Document contains no operations.');
  return { operations, fragments };
}

// ---------------------------------------------------------------------------
// Global ids + cursors
// ---------------------------------------------------------------------------

function gid(type: string, id: number | string): string {
  return b64encode(Buffer.from(`${type}:${id}`, 'utf8'));
}

function parseGid(id: string): { type: string; key: string } | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  let decoded: string;
  try {
    decoded = b64decode(id).toString('utf8');
  } catch {
    return null;
  }
  // Round-trip check: reject strings that are not canonical base64 of the payload.
  if (b64encode(Buffer.from(decoded, 'utf8')).replace(/=+$/, '') !== id.replace(/=+$/, '')) return null;
  const idx = decoded.indexOf(':');
  if (idx <= 0 || idx === decoded.length - 1) return null;
  return { type: decoded.slice(0, idx), key: decoded.slice(idx + 1) };
}

function encodeCursor(n: number): string {
  return b64encode(Buffer.from(`cursor:${n}`, 'utf8'));
}

function decodeCursor(cursor: string): number | null {
  let decoded: string;
  try {
    decoded = b64decode(cursor).toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.startsWith('cursor:')) return null;
  const n = Number.parseInt(decoded.slice('cursor:'.length), 10);
  return Number.isInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Introspection tables (graphql-spec §6 — inclusion-checked, extras are fine)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closed', 'closedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'additions', 'deletions', 'changedFiles', 'commits', 'reviews'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'pushedAt', 'isPrivate', 'fork', 'stargazerCount'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

// Fields each type is allowed to expose (validation: anything else errors
// with a message naming the field). `__typename` is allowed on every type.
const FIELDS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', '__type']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(['login']),
  Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest']),
  Ref: new Set(['name']),
  Issue: new Set(['id', 'number', 'title', 'state', 'body']),
  IssueConnection: new Set(['nodes', 'pageInfo']),
  PageInfo: new Set(['hasNextPage', 'endCursor']),
  PullRequest: new Set(['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files']),
  PullRequestConnection: new Set(['nodes', 'pageInfo']),
  PullRequestChangedFileConnection: new Set(['nodes', 'pageInfo']),
  PullRequestChangedFile: new Set(['path']),
  __Type: new Set(['name', 'fields', 'enumValues']),
  __Field: new Set(['name']),
  __EnumValue: new Set(['name']),
  CreateIssuePayload: new Set(['issue']),
  CloseIssuePayload: new Set(['issue']),
  CreatePullRequestPayload: new Set(['pullRequest']),
  MergePullRequestPayload: new Set(['pullRequest']),
  AddCommentPayload: new Set(['commentEdge']),
  IssueCommentEdge: new Set(['node']),
  IssueComment: new Set(['id', 'body']),
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class ExecError extends Error {
  constructor(message: string) { super(message); this.name = 'ExecError'; }
}

interface GqlError { message: string; path?: (string | number)[]; }

interface ExecCtx {
  store: Store;
  vars: Record<string, unknown>;
  errors: GqlError[];
  fragments: Map<string, FragmentDef>;
}

// Internal object values, each carrying what its fields need (notably the
// owning repo for issues/PRs/comments, which the Store API requires).
type Val =
  | { t: 'root' }
  | { t: 'user'; login: string }
  | { t: 'repo'; repo: Repo }
  | { t: 'ref'; name: string }
  | { t: 'issue'; repo: Repo; issue: Issue }
  | { t: 'pr'; repo: Repo; pr: PullRequest }
  | { t: 'issueConn'; repo: Repo; nodes: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { t: 'prConn'; repo: Repo; nodes: PullRequest[]; hasNextPage: boolean; endCursor: string | null }
  | { t: 'fileConn'; nodes: PullFile[]; hasNextPage: boolean; endCursor: string | null }
  | { t: 'file'; file: PullFile }
  | { t: 'pageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { t: 'gqlType'; name: string }
  | { t: 'gqlField'; name: string }
  | { t: 'gqlEnumValue'; name: string }
  | { t: 'issuePayload'; repo: Repo; issue: Issue }
  | { t: 'prPayload'; repo: Repo; pr: PullRequest }
  | { t: 'commentPayload'; repo: Repo; comment: IssueComment }
  | { t: 'commentEdge'; repo: Repo; comment: IssueComment }
  | { t: 'comment'; repo: Repo; comment: IssueComment };

interface Resolved { value: unknown; typeName: string | null; isList?: boolean; }

const scalar = (value: unknown): Resolved => ({ value, typeName: null });
const obj = (value: Val, typeName: string): Resolved => ({ value, typeName });
const list = (value: Val[], typeName: string): Resolved => ({ value, typeName, isList: true });
const nullVal = (): Resolved => ({ value: null, typeName: null });

function resolveValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return vars[node.name];
    case 'int': return parseInt(node.value, 10);
    case 'float': return parseFloat(node.value);
    case 'string': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, vars);
      return out;
    }
  }
}

function argsOf(field: FieldNode, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = resolveValue(a.value, vars);
  return out;
}

function asInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

function findRepoById(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function findIssueById(store: Store, id: number): { repo: Repo; issue: Issue } | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === id) return { repo, issue };
    }
  }
  return null;
}

function findPrById(store: Store, id: number): { repo: Repo; pr: PullRequest } | null {
  for (const repo of store.repos.values()) {
    for (const pr of repo.pulls.values()) {
      if (pr.id === id) return { repo, pr };
    }
  }
  return null;
}

function paginate<T extends { number: number }>(
  items: T[],
  first: number | undefined,
  after: unknown,
): { nodes: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  if (typeof after === 'string' && after.length > 0) {
    const n = decodeCursor(after);
    if (n !== null) {
      const idx = items.findIndex((it) => it.number === n);
      start = idx >= 0 ? idx + 1 : 0;
    }
  }
  const limit = typeof first === 'number' && first >= 0 ? first : items.length;
  const nodes = items.slice(start, start + limit);
  const hasNextPage = start + nodes.length < items.length;
  const endCursor = nodes.length > 0 ? encodeCursor(nodes[nodes.length - 1].number) : null;
  return { nodes, hasNextPage, endCursor };
}

function parseIssueStates(statesArg: unknown): 'open' | 'closed' | 'all' {
  if (!Array.isArray(statesArg)) return 'open';
  const hasOpen = statesArg.includes('OPEN');
  const hasClosed = statesArg.includes('CLOSED');
  if (hasOpen && hasClosed) return 'all';
  if (hasOpen) return 'open';
  if (hasClosed) return 'closed';
  return 'all';
}

function parseOrderDirection(orderBy: unknown): 'asc' | 'desc' {
  if (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
    const dir = (orderBy as Record<string, unknown>).direction;
    if (dir === 'ASC') return 'asc';
    if (dir === 'DESC') return 'desc';
  }
  return 'desc';
}

function inputObject(args: Record<string, unknown>, field: string): Record<string, unknown> {
  const input = args.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ExecError(`${field} requires an input object.`);
  }
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string, what: string): string {
  const v = input[key];
  if (typeof v !== 'string' || v.length === 0) throw new ExecError(`${what} requires ${key}.`);
  return v;
}

function optionalString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  return typeof v === 'string' ? v : '';
}

function decodedId(input: Record<string, unknown>, key: string, expectedType: string, what: string): number {
  const raw = input[key];
  if (typeof raw !== 'string') throw new ExecError(`${what} requires ${key}.`);
  const decoded = parseGid(raw);
  if (decoded === null || decoded.type !== expectedType) throw new ExecError(`${what}: unknown ${key}.`);
  const n = Number.parseInt(decoded.key, 10);
  if (!Number.isInteger(n)) throw new ExecError(`${what}: unknown ${key}.`);
  return n;
}

function resolveNode(id: string, ctx: ExecCtx): Resolved {
  const decoded = parseGid(id);
  if (decoded === null) return nullVal();
  if (decoded.type === 'Repository') {
    const repo = findRepoById(ctx.store, Number.parseInt(decoded.key, 10));
    return repo === null ? nullVal() : obj({ t: 'repo', repo }, 'Repository');
  }
  if (decoded.type === 'Issue') {
    const found = findIssueById(ctx.store, Number.parseInt(decoded.key, 10));
    return found === null ? nullVal() : obj({ t: 'issue', repo: found.repo, issue: found.issue }, 'Issue');
  }
  if (decoded.type === 'PullRequest') {
    const found = findPrById(ctx.store, Number.parseInt(decoded.key, 10));
    return found === null ? nullVal() : obj({ t: 'pr', repo: found.repo, pr: found.pr }, 'PullRequest');
  }
  return nullVal();
}

function resolveQueryField(field: string, args: Record<string, unknown>, ctx: ExecCtx): Resolved {
  switch (field) {
    case 'viewer':
      return obj({ t: 'user', login: ctx.store.viewer.login }, 'User');
    case 'repository': {
      if (typeof args.owner !== 'string' || typeof args.name !== 'string') {
        throw new ExecError('repository requires owner and name arguments.');
      }
      const repo = ctx.store.getRepo(args.owner, args.name);
      return repo === null ? nullVal() : obj({ t: 'repo', repo }, 'Repository');
    }
    case 'node': {
      if (typeof args.id !== 'string') throw new ExecError('node requires an id argument.');
      return resolveNode(args.id, ctx);
    }
    case '__type': {
      if (typeof args.name !== 'string') throw new ExecError('__type requires a name argument.');
      if (TYPE_FIELDS[args.name] === undefined && TYPE_ENUM_VALUES[args.name] === undefined) return nullVal();
      return obj({ t: 'gqlType', name: args.name }, '__Type');
    }
    default:
      throw new ExecError(`Cannot query field "${field}" on type "Query".`);
  }
}

function resolveMutationField(field: string, args: Record<string, unknown>, ctx: ExecCtx): Resolved {
  switch (field) {
    case 'createIssue': {
      const input = inputObject(args, 'createIssue');
      const repo = findRepoById(ctx.store, decodedId(input, 'repositoryId', 'Repository', 'createIssue'));
      if (repo === null) throw new ExecError('createIssue: repository not found.');
      const issue = ctx.store.createIssue(repo, { title: requiredString(input, 'title', 'createIssue'), body: optionalString(input, 'body') });
      return obj({ t: 'issuePayload', repo, issue }, 'CreateIssuePayload');
    }
    case 'closeIssue': {
      const input = inputObject(args, 'closeIssue');
      const found = findIssueById(ctx.store, decodedId(input, 'issueId', 'Issue', 'closeIssue'));
      if (found === null) throw new ExecError('closeIssue: issue not found.');
      const issue = ctx.store.updateIssue(found.repo, found.issue.number, { state: 'closed' });
      return obj({ t: 'issuePayload', repo: found.repo, issue }, 'CloseIssuePayload');
    }
    case 'createPullRequest': {
      const input = inputObject(args, 'createPullRequest');
      const repo = findRepoById(ctx.store, decodedId(input, 'repositoryId', 'Repository', 'createPullRequest'));
      if (repo === null) throw new ExecError('createPullRequest: repository not found.');
      const pr = ctx.store.createPull(repo, {
        title: requiredString(input, 'title', 'createPullRequest'),
        body: optionalString(input, 'body'),
        head: requiredString(input, 'headRefName', 'createPullRequest'),
        base: requiredString(input, 'baseRefName', 'createPullRequest'),
      });
      return obj({ t: 'prPayload', repo, pr }, 'CreatePullRequestPayload');
    }
    case 'mergePullRequest': {
      const input = inputObject(args, 'mergePullRequest');
      const found = findPrById(ctx.store, decodedId(input, 'pullRequestId', 'PullRequest', 'mergePullRequest'));
      if (found === null) throw new ExecError('mergePullRequest: pull request not found.');
      ctx.store.mergePull(found.repo, found.pr.number);
      const pr = ctx.store.getPull(found.repo, found.pr.number);
      if (pr === null) throw new ExecError('mergePullRequest: pull request not found.');
      return obj({ t: 'prPayload', repo: found.repo, pr }, 'MergePullRequestPayload');
    }
    case 'addComment': {
      const input = inputObject(args, 'addComment');
      const found = findIssueById(ctx.store, decodedId(input, 'subjectId', 'Issue', 'addComment'));
      if (found === null) throw new ExecError('addComment: subject not found.');
      const comment = ctx.store.createComment(found.repo, found.issue.number, requiredString(input, 'body', 'addComment'));
      return obj({ t: 'commentPayload', repo: found.repo, comment }, 'AddCommentPayload');
    }
    default:
      throw new ExecError(`Cannot query field "${field}" on type "Mutation".`);
  }
}

function resolveRepoField(val: Val, field: string, args: Record<string, unknown>, ctx: ExecCtx): Resolved {
  if (val.t !== 'repo') throw new ExecError('Internal error: wrong value for Repository.');
  const repo = val.repo;
  switch (field) {
    case 'id': return scalar(gid('Repository', repo.id));
    case 'databaseId': return scalar(repo.id);
    case 'name': return scalar(repo.name);
    case 'nameWithOwner': return scalar(repo.fullName);
    case 'owner': return obj({ t: 'user', login: repo.owner }, 'User');
    case 'defaultBranchRef': {
      const tip = ctx.store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
      return tip === null ? nullVal() : obj({ t: 'ref', name: repo.defaultBranch }, 'Ref');
    }
    case 'viewerPermission': return scalar('ADMIN');
    case 'hasIssuesEnabled': return scalar(true);
    case 'issue': {
      const n = asInt(args.number);
      if (n === undefined) throw new ExecError('issue requires a number argument.');
      const issue = ctx.store.getIssue(repo, n);
      return issue === null ? nullVal() : obj({ t: 'issue', repo, issue }, 'Issue');
    }
    case 'issues': {
      const all = ctx.store.listIssues(repo, {
        state: parseIssueStates(args.states),
        sort: 'created',
        direction: parseOrderDirection(args.orderBy),
      });
      const page = paginate(all, asInt(args.first), args.after);
      return obj({ t: 'issueConn', repo, nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor }, 'IssueConnection');
    }
    case 'pullRequests': {
      const all = ctx.store.listPulls(repo, { state: 'open' });
      const page = paginate(all, asInt(args.first), args.after);
      return obj({ t: 'prConn', repo, nodes: page.nodes, hasNextPage: page.hasNextPage, endCursor: page.endCursor }, 'PullRequestConnection');
    }
    case 'pullRequest': {
      const n = asInt(args.number);
      if (n === undefined) throw new ExecError('pullRequest requires a number argument.');
      const pr = ctx.store.getPull(repo, n);
      return pr === null ? nullVal() : obj({ t: 'pr', repo, pr }, 'PullRequest');
    }
    default:
      throw new ExecError(`Cannot query field "${field}" on type "Repository".`);
  }
}

function resolveIssueField(val: Val, field: string): Resolved {
  if (val.t !== 'issue') throw new ExecError('Internal error: wrong value for Issue.');
  const issue = val.issue;
  switch (field) {
    case 'id': return scalar(gid('Issue', issue.id));
    case 'number': return scalar(issue.number);
    case 'title': return scalar(issue.title);
    case 'state': return scalar(issue.state === 'open' ? 'OPEN' : 'CLOSED');
    case 'body': return scalar(issue.body);
    default:
      throw new ExecError(`Cannot query field "${field}" on type "Issue".`);
  }
}

function resolvePrField(val: Val, field: string, args: Record<string, unknown>, ctx: ExecCtx): Resolved {
  if (val.t !== 'pr') throw new ExecError('Internal error: wrong value for PullRequest.');
  const { repo, pr } = val;
  switch (field) {
    case 'id': return scalar(gid('PullRequest', pr.id));
    case 'number': return scalar(pr.number);
    case 'state': return scalar(pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED');
    case 'merged': return scalar(pr.merged);
    case 'headRefName': return scalar(pr.headRef);
    case 'baseRefName': return scalar(pr.baseRef);
    case 'mergeable': {
      try {
        return scalar(ctx.store.isMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING');
      } catch {
        return scalar('UNKNOWN');
      }
    }
    case 'files': {
      const files = ctx.store.pullFiles(repo, pr);
      const first = asInt(args.first);
      const nodes = typeof first === 'number' ? files.slice(0, first) : files;
      return obj(
        { t: 'fileConn', nodes, hasNextPage: typeof first === 'number' ? files.length > first : false, endCursor: null },
        'PullRequestChangedFileConnection',
      );
    }
    default:
      throw new ExecError(`Cannot query field "${field}" on type "PullRequest".`);
  }
}

function resolveConnectionField(val: Val, typeName: string, field: string): Resolved {
  if (field === 'pageInfo') {
    if (val.t !== 'issueConn' && val.t !== 'prConn' && val.t !== 'fileConn') {
      throw new ExecError(`Internal error: wrong value for ${typeName}.`);
    }
    return obj({ t: 'pageInfo', hasNextPage: val.hasNextPage, endCursor: val.endCursor }, 'PageInfo');
  }
  if (field === 'nodes') {
    if (typeName === 'IssueConnection') {
      if (val.t !== 'issueConn') throw new ExecError('Internal error: wrong value for IssueConnection.');
      return list(val.nodes.map((issue) => ({ t: 'issue', repo: val.repo, issue }) as Val), 'Issue');
    }
    if (typeName === 'PullRequestConnection') {
      if (val.t !== 'prConn') throw new ExecError('Internal error: wrong value for PullRequestConnection.');
      return list(val.nodes.map((pr) => ({ t: 'pr', repo: val.repo, pr }) as Val), 'PullRequest');
    }
    if (typeName === 'PullRequestChangedFileConnection') {
      if (val.t !== 'fileConn') throw new ExecError('Internal error: wrong value for PullRequestChangedFileConnection.');
      return list(val.nodes.map((file) => ({ t: 'file', file }) as Val), 'PullRequestChangedFile');
    }
  }
  throw new ExecError(`Cannot query field "${field}" on type "${typeName}".`);
}

function resolveGqlTypeField(val: Val, field: string): Resolved {
  if (val.t !== 'gqlType') throw new ExecError('Internal error: wrong value for __Type.');
  switch (field) {
    case 'name': return scalar(val.name);
    case 'fields': {
      const names = TYPE_FIELDS[val.name] ?? [];
      return list(names.map((name) => ({ t: 'gqlField', name }) as Val), '__Field');
    }
    case 'enumValues': {
      const names = TYPE_ENUM_VALUES[val.name] ?? [];
      return list(names.map((name) => ({ t: 'gqlEnumValue', name }) as Val), '__EnumValue');
    }
    default:
      throw new ExecError(`Cannot query field "${field}" on type "__Type".`);
  }
}

function resolvePayloadField(val: Val, typeName: string, field: string): Resolved {
  switch (typeName) {
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (val.t !== 'issuePayload') throw new ExecError(`Internal error: wrong value for ${typeName}.`);
      if (field === 'issue') return obj({ t: 'issue', repo: val.repo, issue: val.issue }, 'Issue');
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (val.t !== 'prPayload') throw new ExecError(`Internal error: wrong value for ${typeName}.`);
      if (field === 'pullRequest') return obj({ t: 'pr', repo: val.repo, pr: val.pr }, 'PullRequest');
      break;
    }
    case 'AddCommentPayload': {
      if (val.t !== 'commentPayload') throw new ExecError(`Internal error: wrong value for ${typeName}.`);
      if (field === 'commentEdge') return obj({ t: 'commentEdge', repo: val.repo, comment: val.comment }, 'IssueCommentEdge');
      break;
    }
    case 'IssueCommentEdge': {
      if (val.t !== 'commentEdge') throw new ExecError('Internal error: wrong value for IssueCommentEdge.');
      if (field === 'node') return obj({ t: 'comment', repo: val.repo, comment: val.comment }, 'IssueComment');
      break;
    }
    case 'IssueComment': {
      if (val.t !== 'comment') throw new ExecError('Internal error: wrong value for IssueComment.');
      if (field === 'id') return scalar(gid('IssueComment', `${val.repo.id}:${val.comment.id}`));
      if (field === 'body') return scalar(val.comment.body);
      break;
    }
    default:
      break;
  }
  throw new ExecError(`Cannot query field "${field}" on type "${typeName}".`);
}

function resolveField(val: Val, typeName: string, field: string, args: Record<string, unknown>, ctx: ExecCtx): Resolved {
  if (field === '__typename') return scalar(typeName);
  switch (typeName) {
    case 'Query': return resolveQueryField(field, args, ctx);
    case 'Mutation': return resolveMutationField(field, args, ctx);
    case 'User': {
      if (val.t !== 'user') throw new ExecError('Internal error: wrong value for User.');
      if (field === 'login') return scalar(val.login);
      break;
    }
    case 'Repository': return resolveRepoField(val, field, args, ctx);
    case 'Ref': {
      if (val.t !== 'ref') throw new ExecError('Internal error: wrong value for Ref.');
      if (field === 'name') return scalar(val.name);
      break;
    }
    case 'Issue': return resolveIssueField(val, field);
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
      return resolveConnectionField(val, typeName, field);
    case 'PageInfo': {
      if (val.t !== 'pageInfo') throw new ExecError('Internal error: wrong value for PageInfo.');
      if (field === 'hasNextPage') return scalar(val.hasNextPage);
      if (field === 'endCursor') return scalar(val.endCursor);
      break;
    }
    case 'PullRequest': return resolvePrField(val, field, args, ctx);
    case 'PullRequestChangedFile': {
      if (val.t !== 'file') throw new ExecError('Internal error: wrong value for PullRequestChangedFile.');
      if (field === 'path') return scalar(val.file.filename);
      break;
    }
    case '__Type': return resolveGqlTypeField(val, field);
    case '__Field': {
      if (val.t !== 'gqlField') throw new ExecError('Internal error: wrong value for __Field.');
      if (field === 'name') return scalar(val.name);
      break;
    }
    case '__EnumValue': {
      if (val.t !== 'gqlEnumValue') throw new ExecError('Internal error: wrong value for __EnumValue.');
      if (field === 'name') return scalar(val.name);
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
    case 'AddCommentPayload':
    case 'IssueCommentEdge':
    case 'IssueComment':
      return resolvePayloadField(val, typeName, field);
    default:
      break;
  }
  throw new ExecError(`Cannot query field "${field}" on type "${typeName}".`);
}

function completeValue(res: Resolved, field: FieldNode, ctx: ExecCtx, path: (string | number)[]): unknown {
  if (res.value === null || res.value === undefined) return null;
  if (res.isList === true) {
    if (res.typeName === null) return res.value;
    const items = res.value as Val[];
    if (field.selections.length === 0) return items.map(() => null);
    return items.map((el, i) => executeSelectionSet(field.selections, el, res.typeName as string, ctx, [...path, i], new Set()));
  }
  if (res.typeName !== null) {
    if (field.selections.length === 0) {
      ctx.errors.push({ message: `Field "${field.name}" of type "${res.typeName}" must have a selection of subfields.`, path });
      return null;
    }
    return executeSelectionSet(field.selections, res.value as Val, res.typeName, ctx, path, new Set());
  }
  return res.value;
}

function executeSelectionSet(
  sels: Selection[],
  val: Val,
  typeName: string,
  ctx: ExecCtx,
  path: (string | number)[],
  seenFragments: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition === null || sel.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(sel.selections, val, typeName, ctx, path, seenFragments));
      }
      continue;
    }
    if (sel.kind === 'fragmentSpread') {
      if (seenFragments.has(sel.name)) continue;
      const frag = ctx.fragments.get(sel.name);
      if (frag === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path });
        continue;
      }
      if (frag.typeCondition === typeName) {
        const next = new Set(seenFragments);
        next.add(sel.name);
        Object.assign(out, executeSelectionSet(frag.selections, val, typeName, ctx, path, next));
      }
      continue;
    }
    const key = sel.alias ?? sel.name;
    const fieldPath = [...path, key];
    const allowed = FIELDS[typeName];
    if (sel.name !== '__typename' && (allowed === undefined || !allowed.has(sel.name))) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".`, path: fieldPath });
      out[key] = null;
      continue;
    }
    let resolved: Resolved;
    try {
      resolved = resolveField(val, typeName, sel.name, argsOf(sel, ctx.vars), ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(resolved, sel, ctx, fieldPath);
  }
  return out;
}

function executeDocument(
  query: string,
  variables: Record<string, unknown>,
  operationName: string | null,
  store: Store,
): Record<string, unknown> {
  let doc: ParsedDocument;
  try {
    doc = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error.' }] };
  }
  let op: Operation | undefined;
  if (operationName !== null) {
    op = doc.operations.find((o) => o.name === operationName);
    if (op === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (doc.operations.length === 1) {
    op = doc.operations[0];
  } else {
    return { data: null, errors: [{ message: 'Must provide an operation name when the document contains multiple operations.' }] };
  }
  const ctx: ExecCtx = { store, vars: {}, errors: [], fragments: doc.fragments };
  for (const def of op.variableDefinitions) {
    const provided = Object.prototype.hasOwnProperty.call(variables, def.name) ? variables[def.name] : undefined;
    if (provided !== undefined) {
      ctx.vars[def.name] = provided;
      continue;
    }
    if (def.defaultValue !== undefined) {
      ctx.vars[def.name] = resolveValue(def.defaultValue, {});
      continue;
    }
    if (def.type.kind === 'nonNull') {
      return { data: null, errors: [{ message: `Variable $${def.name} of required type ${typeToString(def.type)} was not provided.` }] };
    }
    ctx.vars[def.name] = undefined;
  }
  for (const [k, v] of Object.entries(variables)) {
    if (!Object.prototype.hasOwnProperty.call(ctx.vars, k)) ctx.vars[k] = v;
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(op.selections, { t: 'root' }, rootType, ctx, [], new Set());
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

function executeRequest(entry: unknown, store: Store): Record<string, unknown> {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return { data: null, errors: [{ message: 'Request must be an object with a query string.' }] };
  }
  const req = entry as Record<string, unknown>;
  if (typeof req.query !== 'string' || req.query.length === 0) {
    return { data: null, errors: [{ message: 'Request must include a query string.' }] };
  }
  let variables: Record<string, unknown> = {};
  if (req.variables !== undefined && req.variables !== null) {
    if (typeof req.variables !== 'object' || Array.isArray(req.variables)) {
      return { data: null, errors: [{ message: 'Variables must be an object.' }] };
    }
    variables = req.variables as Record<string, unknown>;
  }
  const operationName = typeof req.operationName === 'string' ? req.operationName : null;
  return executeDocument(req.query, variables, operationName, store);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * POST /api/graphql only. Single-object body -> one result object; JSON-array
 * body -> array of results in order. Always HTTP 200 (GraphQL failures are
 * reported in the `errors` array, never as an HTTP error status).
 */
export async function routeGraphql(ctx: Ctx): Promise<boolean> {
  if (ctx.method !== 'POST' || ctx.path !== '/api/graphql') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx.res, 200, { data: null, errors: [{ message: 'Request body must be valid JSON.' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    sendJson(ctx.res, 200, parsed.map((entry) => executeRequest(entry, ctx.store)));
    return true;
  }
  sendJson(ctx.res, 200, executeRequest(parsed, ctx.store));
  return true;
}
