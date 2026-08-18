# Repo invariants

Rules that break **this** repo. The vendored skills know React and Fastify;
none of them knows that `@devdigest/shared` exists twice or that pnpm 11
refuses unapproved build scripts. All of these are checkable without an LLM,
so they run first and cost nothing.

Implementation: [`invariants.mjs`](invariants.mjs) (`CHECKS`).

| # | id | Severity | Fires when |
|---|---|---|---|
| 1 | `locked-skill-edited` | critical | a skill listed in `skills-lock.json` was edited by hand |
| 2 | `contract-mirror-drift` | critical | `check-contracts.sh` fails for a changeset touching `vendor/shared/` |
| 3 | `migration-rewritten` | critical | an existing `server/src/db/migrations/*.sql` was modified or deleted |
| 4 | `table-without-workspace-scope` | critical / info | a **new** `pgTable` has no `workspace_id` |
| 5 | `dependency-may-need-allow-builds` | major | a new dependency is absent from that package's `allowBuilds:` |
| 6 | `env-file-committed`, `secret-in-diff` | critical | an `.env` file or a credential-shaped string is in the changeset |
| 7 | `stray-artifact` | major | a binary/scratch file is in the changeset |

---

### 1 — hash-locked skills

`skills-lock.json` is the machine-readable truth about which skills get
overwritten on the next upstream sync. Editing one is not wrong so much as
*futile*: the change disappears silently.

The lock and the skills directory do not agree today — `architecture-patterns`
and `github-workflow-automation` are locked but not installed, while
`mermaid-diagram`, `react-best-practices`, `react-testing-library` and
`security` are installed but unlocked, despite `.claude/skills/README.md`
claiming everything but three skills is locked. The check follows the lock
file, because that is what the sync tool reads.

### 2 — contract mirror

`@devdigest/shared` is canonical at `server/src/vendor/shared/` and hand-copied
to `client/src/vendor/shared/`. No build step ties them together and both
packages type-check against their own copy, so drift surfaces only at runtime.

**This check delegates to `./scripts/check-contracts.sh` and does not
reimplement it.** The first version inferred drift from *which side changed*
and produced five false positives on its first real branch: that branch had
legitimately run `--fix` to sync a mirror already stale on `main`, so only the
client side appeared in the diff while the two trees matched perfectly. Only
the end state matters, and one `diff -r` is the authority on it.

### 3 — applied migrations

drizzle-kit output. A new `.sql` file is normal. Modifying or deleting one that
already ran leaves every existing database on a schema nobody can reproduce
from the repo. Fix forward with `cd server && pnpm db:generate`.

### 4 — workspace scoping

*Every domain table carries `workspace_id`* is the repo's headline invariant —
it is what keeps queries from crossing tenants. But it has a legitimate
exception: child tables scope through a parent FK. `pr_files` has no
`workspace_id`; it reaches a workspace via `pr_id → pull_requests`.

So the check grades by what the new table has:

- no `workspace_id` **and** no `.references(...)` → **critical**, the table is
  genuinely unscoped
- no `workspace_id` **but** a FK → **info**, confirm the parent is scoped

Only tables whose `pgTable(` line is an *added* line are examined. Pre-existing
tables are not this PR's problem.

### 5 — pnpm build scripts

pnpm 11 blocks a dependency's install scripts unless it is listed under
`allowBuilds:` in that package's `pnpm-workspace.yaml` (`server/` and
`client/` each have their own). Miss it and install fails with
`ERR_PNPM_IGNORED_BUILDS` — in CI, not on the machine where it was added.

Advisory rather than a verdict: whether a package *has* install scripts is only
knowable after installing it. The check lists new dependencies and the current
`allowBuilds` entries and leaves the call to you.

Dependency names come from the parsed manifest, not from diff lines — matching
`"key": "value"` on raw diff text reported the `lint:arch` npm script as a new
dependency.

### 6 — secrets

`.env` in the changeset, or an added line matching a credential shape (OpenAI,
GitHub PAT, AWS key id, Slack token, PEM private key). One finding per file is
enough to block. The patterns are written so they cannot match their own source
text — otherwise this file would flag itself.

### 7 — stray artifacts

`git ls-files` over every image extension returns **zero** results: this repo
tracks no binaries at all. So anything binary in a changeset is a screenshot or
scratch output that leaked in, until proven otherwise. Allowed by exception:
`client/public/**`, `**/assets/**`, `**/__fixtures__/**`.

---

## Adding an invariant

1. Write the check in `invariants.mjs` and register it in `CHECKS`.
2. Add a row above **and a section explaining the blast radius** — what breaks,
   and where it surfaces. A check that cannot explain that is noise.
3. Check whether a script already enforces it. Delegating beats reimplementing;
   see #2.
4. Prove it fires. `CHECKS` is exported so a synthetic changeset can drive a
   single check, positive and negative. A check that silently stops firing
   looks exactly like a clean branch.
