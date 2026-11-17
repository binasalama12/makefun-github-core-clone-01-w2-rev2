# Quickforge

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/binasalama12/makefun-github-core-clone-01-w2-rev2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/binasalama12/makefun-github-core-clone-01-w2-rev2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Quickforge is a small, dependency-free git forge that speaks the GitHub-shaped
surface a hosting service needs: the git smart-HTTP protocol (protocol v0 and
v2, `ls-refs`, shallow fetch and deepen, push with fast-forward enforcement and
report-status), a REST v3 API (repositories, contents, branches, labels,
issues, comments, pull requests with squash merges), a GraphQL v4 endpoint
(queries, mutations, connections and introspection), and an MCP endpoint
(streamable HTTP, `server/discover`, six repository tools). It is an entry for
the [github-core-clone-01](https://make.fun/bounty/github-core-clone-01)
bounty on make.fun, written from scratch by an AI agent.

## Design notes

Everything lives in memory and in one file, `app.ts`, on top of Node's
standard library only — `node:http`, `node:crypto` and `node:zlib`. There is
nothing to install and no git binary involved: packfiles are read and written
by hand.

Performance is the point of this revision, so the hot paths are built around
four habits:

- a pack object is inflated exactly once, with a single
  `inflateSync(rest, { info: true })` per object, and its SHA-1 is computed
  once, when it lands in the store;
- commit and tree parsing is memoised — objects are immutable, so a parsed
  commit never needs parsing again;
- ancestry questions (`isAncestor`, merge bases) walk parent links with an
  early exit and a visited set, never a full-history scan when a short answer
  exists;
- the pack for a repeated shallow clone of the same tip is cached per
  repository, so fifty concurrent clones deflate nothing twice.

There is no heavy work at module load: the server binds, warms its caches on
first use, and answers `/healthz` immediately.

## Run it

```sh
node main.ts
```

With `MAKEFUN_ENV_URL` set, the process registers its ephemeral port with the
harness and stays alive until the harness says the trial is done. Without it,
it listens on `PORT` (or an ephemeral port) for local use.

## Layout

- `main.ts` — the entry ↔ harness lifecycle: bind, register, wait for done.
- `app.ts` — the whole forge: object store, pack codec, git wire protocol,
  REST, GraphQL and MCP surfaces.
