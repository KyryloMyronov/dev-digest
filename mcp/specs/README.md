# `mcp/specs/` — specs that change this package only

A spec is written **before** the code and describes what "done" means. Once the
feature ships, the spec stays as the record of intent; behaviour documentation
belongs in [`../README.md`](../README.md).

**This folder holds the specs whose work is confined to `mcp/`.** The MCP server
fronts the REST API over stdio, so most of what it exposes already exists
server-side; a feature that also needs a new or changed endpoint touches two
packages and goes in the repo-root [`specs/`](../../specs/README.md) folder
instead. So does any change to a shared Zod contract. The full routing table is
in that README.

`SPEC-NN-slug.md`, with `NN` **globally unique across the repository** and
allocated as max existing + 1 over every spec folder at once. Every spec is
indexed once, in [`specs/README.md`](../../specs/README.md#index) — this file
keeps no second table.

Write one with the [`spec-creator`](../../.claude/agents/spec-creator.md) agent.
It runs in two passes: questions and design findings first, the file once you
have answered.

## Template

The section list and the writing rule for each section live in
[`.claude/skills/spec-creator/references/template.md`](../../.claude/skills/spec-creator/references/template.md),
mirrored for humans in [`specs/README.md`](../../specs/README.md#template).

Two MCP-specific things that template expects you to fill in:

- **Which REST endpoint the tool fronts**, under *Module interactions*, cited as
  `path:line` in `server/src/modules/**/routes.ts`. If it does not exist yet, the
  spec is cross-module and belongs in the root folder.
- **Behaviour when the API is unreachable or answers slowly** — an MCP client is
  a separate process with its own timeout, so this is an `IF … THEN` acceptance
  criterion, not an implementation detail.

The tool description an MCP tool advertises is read by another model. Treat it as
part of the contract and state it in the spec, not as something the implementer
invents.
