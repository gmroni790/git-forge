# github-core-clone-01 forge

A standalone, GitHub-compatible git forge in one Node 22 process, built for
[the contest](https://make.fun/bounty/github-core-clone-01). No UI, no outside
service, no dependencies: the standard library plus the source in this
repository. It serves git smart HTTP, the REST v3 API, GraphQL v4 and MCP from
its own in-memory store.

## Run it

```sh
node main.ts
```

Node 22.18 or later (type stripping is built in). The program needs
`MAKEFUN_ENV_URL` (the suite's origin) and `MAKEFUN_SHOP_TOKEN` (the bearer
token it accepts) in its environment: it binds an ephemeral port, registers
it with the suite, serves until the suite says done, then exits 0. Never
binds 8080 — that is the suite's port.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send, plus `__type` introspection |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` (six tools) |
| `/<owner>/<repo>.git/...` | git smart HTTP: protocol v2 upload-pack (`ls-refs`, `fetch`, shallow/deepen), v0 receive-pack with `report-status` |
| anything else | 404 `{"message":"Not Found"}` |

Git is implemented from scratch on `node:zlib` and `node:crypto`: objects,
packfiles (plain-object generation, delta-aware parsing), pkt-line framing,
fast-forward enforcement, and byte-exact round-trips. Merges are real
three-way squash merges with file-granular conflict detection.

## Determinism

The store is a pure function of the requests it served: timestamps come from a
logical clock seeded by `MAKEFUN_TRIAL_NOW` (never the wall clock), ids are
sequential, there is no randomness, and git objects are stored verbatim. The
same request sequence always yields the same state.

## Layout

- `main.ts`: the entry <-> env lifecycle (bind, register, poll `/done`, exit 0).
- `app.ts`: the HTTP server: body reading, auth gate, request ids, routing.
- `src/store.ts`: the whole store and every business rule (repos, issues, PRs, merges).
- `src/git-objects.ts`: object hashing, packfiles, reachability, tree building.
- `src/git-protocol.ts`, `src/git-http.ts`: the git wire protocol and its routes.
- `src/rest.ts`, `src/graphql.ts`, `src/mcp.ts`: the three API surfaces.
- `src/scenario.ts`: the suite's seeded scenario derivation (viewer login).
- `src/clock.ts`, `src/diff.ts`, `src/util.ts`, `src/types.ts`: support.

## Licence

MIT — see `LICENSE`.
