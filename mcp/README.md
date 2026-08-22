# `@devdigest/mcp` — MCP server

Exposes DevDigest's reviewer capabilities to MCP clients (Claude Code, Claude
Desktop, …) over **stdio**. It is a thin front for the REST API on `:3001` —
it owns no database, no contracts, and no review logic; the API is its
contract. This is the L04 roadmap deliverable (`devdigest-mcp`).

## Tools

| Tool | What it does |
|---|---|
| `list_agents` | List the configured reviewer agents (lean fields — no prompts). |
| `run_agent_on_pull_request` | Start an async review run; returns `run_id`s immediately. |
| `get_findings` | Reviews + findings for a PR, and run status — the polling tool. |
| `get_conventions` | Conventions extracted from a repo (default: accepted only). |
| `get_blast_radius` | **Stub** — answers `not_implemented` until wired to repo-intel. |

Repos are addressed by name (`owner/name`), PRs by number; the server resolves
them to ids via `GET /repos` and `GET /repos/:id/pulls`.

## Run

```sh
npm install            # npm, NOT pnpm (standalone package, like reviewer-core/e2e)
npm run typecheck
npm test               # hermetic — points the API client at a dead port
npm start              # stdio server (for a client that spawns it; not useful in a terminal)
```

Prerequisite for real calls: the dev stack (`../scripts/dev.sh`) — the API must
answer on `http://localhost:3001` (override with `DEVDIGEST_API_URL`). Without
it every tool degrades to an actionable "API is not reachable" error.

## Register with Claude Code

The repo root ships a project-scoped [`.mcp.json`](../.mcp.json) — opening the
repo in Claude Code offers the `devdigest` server automatically (after
`npm install` here). Check with `claude mcp list` or `/mcp` in a session.

## Inspect by hand

```sh
npx @modelcontextprotocol/inspector --cli node_modules/.bin/tsx src/index.ts --method tools/list
npx @modelcontextprotocol/inspector --cli node_modules/.bin/tsx src/index.ts \
  --method tools/call --tool-name list_agents
```

## Design rules (why the code looks like this)

- **Token-lean by design.** Tool definitions are injected into the model's
  context at every session start, so: 5 tools only, descriptions ≤ 2 short
  sentences, flat input schemas, no server `instructions`. Responses strip
  heavy fields (agent `system_prompt`, traces), truncate long text, default
  `limit` on findings, and hard-cap output at 25 000 chars (Claude Code's
  default MCP output budget). `test/server.test.ts` enforces the surface size.
- **stdout is the JSON-RPC channel** — never `console.log`; diagnostics go to
  stderr.
- **No `@devdigest/shared` import.** Shared resolves backwards into the
  server's source tree (see `reviewer-core/insights.md`); this package stays
  extractable by treating the REST API as the contract and keeping its own
  minimal type projections in `src/api.ts`.
- **Async runs, portable pattern.** `run_agent_on_pull_request` returns run ids
  immediately (the server fires-and-forgets runs); `get_findings` polls. MCP's
  native "Tasks" extension is still experimental — don't depend on it.
- **Errors for the model**: API failures become `isError: true` results with a
  short, actionable message (what's wrong + what to call instead), never stack
  traces. Unknown repo/PR/agent errors list the known candidates.
- Known race: a run flips to `done` *before* its review/findings persist
  (`server/insights.md`); `get_findings` reports "finalizing — retry" instead
  of a false "no findings".
