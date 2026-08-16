# Conventions — derive a repo's house rules and turn them into a Skill

**Status:** shipped
**Lesson:** L02 (the other half — see [`skills.md`](skills.md))

Spec lives in `server/specs/` because the scan pipeline, the grounding gate and
the draft-vs-save boundary are the load-bearing parts; the screens are described
in **Screens** below and implemented in `client/`.

## Problem

Every skill is written by hand or imported. But the most valuable review
guidance for a given repo is already *in* that repo — the team's own habits,
followed consistently and written down nowhere. A reviewer that does not know
them flags the wrong things and misses the right ones, and a maintainer asked to
write them out produces a worse list than the code would: they enumerate the
rules they remember, not the ones they follow.

`skills.md` shipped the library and left this half explicitly unbuilt:
`source: 'extracted'` and `evidence_files` existed with nothing to populate them.

## Scope

- Scan a cloned, indexed repo and derive its conventions, each with a cited file,
  an excerpt, and a confidence.
- Review each derived insight: accept, reject, or rewrite it.
- Merge the accepted set into a Skill the user edits and then saves.
- Re-scan without losing any of that review work.

## Out of scope

- **Enforcing** a convention. The output is a skill body; the existing review
  pipeline is what applies it. Nothing here inspects a diff.
- **Scanning an unindexed repo.** The sample comes from `repo-intel`'s file rank;
  without an index the scan degrades and says so. Indexing is L01's job.
- **Scan history.** One row per repo describes the last scan. Nothing renders a
  past one.
- **Per-convention skills.** The merge is all-accepted → one skill. N skills from
  N conventions would multiply prompt blocks for no gain.
- **Editing an evidence path.** The snippet is editable, the path is not — see
  the decision below.

## Decisions

### The scan is a two-step model dialogue, not one call

Call 1 (`ConventionFileSelection`) sees **paths only** — the top-80 ranked,
junk-filtered files from `RepoIntel.getConventionSamples` — and picks ~12 to
read. Call 2 (`ConventionExtraction`) sees those files' contents and states the
rules.

Sending all 80 files to a single call costs roughly an order of magnitude more
for a worse answer: most of them are near-duplicates of each other (twelve route
modules of the same shape), and the model spends its context re-reading the same
pattern instead of covering a second layer. Letting it choose from the paths
first buys layer coverage for the price of one cheap call.

The two schema names are not incidental — `MockLLMProvider.structuredBySchema`
keys fixtures off them, which is what makes the whole pipeline testable without
Docker or a model. Renaming one without the other breaks that.

### Grounding: an ungrounded rule is dropped, not repaired

`groundCandidates` discards any candidate whose `evidence_path` is not one of the
files actually sent. This is the conventions analogue of the review engine's
citation gate, and it exists for the same reason: a hallucinated citation
produces a rule that *reads* correctly while pointing at a file nobody opened,
and no amount of UI can make that honest. There is no retry — a model that cited
a file it was not given has told us how much it was inferring.

The extraction prompt states that the dropping happens, so the model has a reason
to comply rather than being silently penalised.

### Tri-state, not a boolean

The pre-existing `conventions.accepted boolean` was dropped for
`status ∈ {pending, accepted, rejected}`. Rejecting is a decision worth
remembering: with a boolean, a rejected rule is indistinguishable from an
unreviewed one, so every re-scan re-offers it and the user re-rejects it forever.
The column had zero call sites, so there was no compatibility to preserve.

### Two rule columns

`source_rule` is the model's original wording and never changes; `rule` is what
is displayed and edited. A re-scan matches on a normalised `source_rule`.

Matching on the displayed text instead would break the moment someone edits a
rule: the edited row would no longer match, and the next scan would insert the
model's original right next to the user's rewrite. `edited` then guards the
refresh path — an untouched pending row gets its confidence and evidence
refreshed by a later scan, a decided or rewritten one does not.

`evidence_path` is deliberately not editable. It is the grounding *claim*; if a
user can retype it, the invariant the gate enforces stops meaning anything. The
snippet is editable, because trimming an over-long excerpt is a real improvement
and cannot invalidate anything.

### The skill draft is composed, not saved

`GET /repos/:repoId/conventions/skill-draft` returns an **unsaved** skill built
from the accepted rows: name, description, markdown body, `evidence_files`, and a
token count. The client renders it in an editable form and saves it through the
ordinary `POST /skills`.

Two reasons over a server-side create:

1. The user story is "edit the prospective skill *before* saving". A server-side
   create would have to either write a row the user may cancel, or accept the
   whole edited body back — at which point it *is* `POST /skills`, duplicated.
2. `SkillsService.create` stays the only writer of the `skills` table, so its
   `source`/`type` defaults — which exist specifically to stop a caller
   laundering an import into a local skill — cannot be bypassed.

This is why `container.skillsRepo` was **not** added. `skills.md:497-505` raises
that getter for a cross-module *read* gap; using it to write would give the table
a second writer with its own idea of what a skill is.

### The scan never throws

`runConventionScan` persists every failure and can't-run on the scan row and
resolves. `JobRunner` retries a rejected handler twice, so rethrowing a
deterministic failure — no API key, no clone — would mean three full scans, and
three bills, for one broken configuration. Precedent: `repo-intel`'s `resyncRepo`.

Degraded reasons (`not_indexed`, `no_clone`) short-circuit **before** any model
call. An empty sample from the facade is "no enrichment", never an error, per
`repo-intel/types.ts`.

### A dedicated scan-state table

`convention_scan_state`, one row per repo, modelled on `repo_index_state`. Not
`jobs`: that table has no repo column (you would filter `payload->>'repoId'`), no
place for `sample_files`, and `JobRunner` is its only legal writer. Not columns on
`repos`: that is another module's tenant root, and every future feature would
widen it. A row whose status is `queued`/`running` *is* the "Scanning…" state the
UI polls.

### Prompt authoring — a deviation from `docs/agent-prompts/README.md`

The README's three mandatory end-blocks are reviewer-specific. Blocks 1 and 2
(severity rubric, verdict semantics) exist because the review pipeline recomputes
a score from severities and passes a verdict through; this pipeline has no
severity, no verdict and no diff, so reproducing them would introduce vocabulary
the schema does not have — the exact failure the README warns about at `:69-72`.

Substituted:

1. A **confidence rubric** tied to the 0..1 field, with an anti-inflation line,
   because the UI thresholds and sorts on that number.
2. **Grounding discipline** — the analogue of "cite real `file:line` or the
   finding disappears".

Block 3 (no duplicates, no padding, count is free) is kept verbatim. Everything
else in the README is honoured: the schema stays out of the prompt (field meaning
lives in `.describe()`), repo content is `wrapUntrusted`-wrapped, and the file
budget is phrased as a budget rather than a quota.

## Screens

**Conventions** — `/repos/:repoId/conventions`, nav **SKILLS LAB → Conventions**
(`g c`). Heading names the repo; the subtitle reports what the last scan sampled
and when. A toolbar shows `N of M accepted`, a **Deselect all** that un-accepts in
one request, and **Create skill**, disabled until something is accepted. Each
insight is a card: the rule (editable in place), the evidence path + excerpt with
a copy button, and a confidence meter colour-matched to the kit's
`ConfidenceNum`. Accept / Reject sit beside it. A rejected card stays visible and
dimmed — it has to, or a re-scan would look like it dropped something.

**Create skill from conventions** — a modal over the composed draft: name,
description, type, an enabled switch, and the body in a line-numbered view that
toggles into an editor, with a token count that becomes an estimate once the text
diverges from what the server counted. Cancel leaves nothing behind.

## Contract changes

`@devdigest/shared` → `contracts/knowledge.ts`, extending the existing
`---- Conventions ----` section (mirrored into `client/` via
`scripts/check-contracts.sh`):

- `ConventionStatus` — new enum.
- `ConventionCandidate` — **changed**: `accepted: boolean` → `status`, plus
  `repo_id`, `edited`, timestamps, `last_seen_at`; evidence and confidence become
  `.nullish()` to match their nullable columns.
- `ConventionScanStatus`, `ConventionScan`, `ConventionsView`,
  `ConventionSkillDraft` — new.
- `SkillVersion`, `AgentSkillDetail` — added; the skills module and the client
  already imported them.

Editing `ConventionCandidate` in place, against the barrel's "extend, don't
edit" note, is deliberate: it had zero consumers on either side of the wire and
was the slot reserved for this feature.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/repos/:repoId/conventions` | `{ scan, items }`. Synthesises an `idle` scan — never 404s a never-scanned repo |
| `POST` | `/repos/:repoId/conventions/scan` | 202 always (after the repo check); degrades to `{degraded, reason}` |
| `PATCH` | `/repos/:repoId/conventions/:id` | `status` / `rule` / `evidence_snippet`; empty patch → 422 |
| `POST` | `/repos/:repoId/conventions/status` | many ids at once — "Deselect all" |
| `GET` | `/repos/:repoId/conventions/skill-draft` | read-only; 422 until something is accepted |

`POST /skills` gains `evidence_files` — the field `skills.md` reserved.

One combined read rather than separate list and scan endpoints: polling one query
while `scan.status ∈ {queued,running}` refreshes the list in the same round trip
that observes the scan finishing, with no cross-query invalidation to get wrong.

## Schema changes

Generated with `pnpm db:generate` (`0011_red_dagger`, `0012_misty_tattoo`).

- `conventions`: `+source_rule`, `+status`, `+edited`, `+last_seen_at`,
  `+created_at`, `+updated_at`, `-accepted`; unique index on
  `(workspace_id, repo_id, source_rule)` and an index on `repo_id`.
- `convention_scan_state`: new.
- `agent_skills`: `+enabled`. Not this feature's column — migration `0011_cultured_the_fallen`
  added it but was never in `_journal.json`, so it had never applied anywhere,
  while `meta/0011_snapshot.json` claimed it existed. Left alone, the next
  `db:generate` would have emitted a spurious `DROP COLUMN` into an unrelated
  migration. The orphan pair was deleted and the column declared in
  `schema/agents.ts` so it regenerates honestly. **The routes that would toggle
  it are still unbuilt** — the column exists so `AgentSkillDetail.enabled` has
  real backing.

Two migrations rather than one because drizzle-kit prompts interactively when a
table both gains and loses a column in the same diff, and that prompt cannot be
answered in a non-interactive run.

## Seeding

`seed-conventions.ts`, called from `seed()`: three pending conventions on
`acme/payments-api` plus a scan row reporting 84 sample files, finished an hour
ago. The demo repo has no clone and is never indexed, so a real extraction can
only ever degrade — without these rows the screen is permanently empty on a fresh
`./scripts/dev.sh` and the browser flow has nothing deterministic to assert on.
Confidences (0.91 / 0.85 / 0.78) straddle both colour thresholds so the meter
demonstrates more than one state, and they double as the sort order.

## Acceptance criteria

- [x] A user can run an analysis of a repo for conventions — `POST .../scan` →
      202, job handler registered · `conventions.it.test.ts`
- [x] The two-step dialogue is used, selection sees paths only, extraction sees
      the files · `conventions-scan.test.ts`
- [x] A rule citing a file that was never sent is dropped ·
      `conventions-helpers.test.ts`, `conventions-scan.test.ts`
- [x] An empty sample or a missing clone degrades with a reason and **zero model
      calls** · `conventions-scan.test.ts`
- [x] A model failure is recorded, not rethrown into JobRunner's retry ·
      `conventions-scan.test.ts`
- [x] A user can see all found conventions, with evidence and confidence ·
      `ConventionsView.test.tsx`, `10-conventions.flow.json` (read-only)
- [x] A user can accept / reject one insight, and the counter follows the server
      list · `ConventionsView.test.tsx`, `conventions.it.test.ts`
- [x] A user can edit one insight; it is marked `edited` ·
      `ConventionsView.test.tsx`, `conventions.it.test.ts`
- [x] A re-scan preserves accepted, rejected and edited rows, and adds only what
      is new · `conventions-scan.test.ts`, `conventions.it.test.ts`
- [x] Opening the create-skill modal writes nothing ·
      `ConventionsView.test.tsx`, `conventions.it.test.ts`
- [x] A user can edit the prospective body and metadata, and the **edited** body
      is what is saved · `ConventionsView.test.tsx`
- [x] Saving records `source: 'extracted'` and `evidence_files` ·
      `conventions.it.test.ts` (the seam), `ConventionsView.test.tsx` (the wire)
- [x] Cancelling saves nothing · `ConventionsView.test.tsx`
- [x] Every route is workspace-scoped; unknown → 404, non-uuid → 422 ·
      `conventions.it.test.ts`
- [x] The confidence meter cannot drift from the kit's numeric readout ·
      `helpers.test.ts`

**Not automatable.** The suites run against `MockLLMProvider`, so they assert
what was **sent** to the model, never what a model concluded from it. Whether the
derived conventions are *good* — whether a real model reads twelve files and
finds rules a maintainer would recognise — is a manual experiment against a real
indexed repo, not a test.

**The browser flow is read-only** (`e2e/specs/10-conventions.flow.json`): it
asserts the seeded screen, the joined scan summary, and every card's evidence and
confidence. It deliberately stops short of accept → compose → save, because
`find role button --name Accept` is ambiguous with three identical Accept buttons
on screen, and the flows must stay deterministic. That chain is asserted precisely
in `conventions.it.test.ts` (over real Postgres, including the `POST /skills`
seam) and in `ConventionsView.test.tsx` (over the DOM).

## Open questions

- **`extracted` is not in `FOREIGN_SOURCES`** (`_shared/skills.ts`), so an
  extracted skill's prompt block carries no provenance label. Defensible — the
  text was derived from the user's own repo, not imported from a stranger — but
  it is derived from untrusted *file contents* by a model, which is a weaker claim
  than "a person wrote this". Worth revisiting if extracted skills ever get large.
- **`pnpm build` does not copy `src/prompts` → `dist/prompts`**, which
  `platform/prompts.ts:12-14` says it must. `onboarding.system.md` has the same
  problem but no caller, so this feature is the first that would break a compiled
  `pnpm start`. Pre-existing; fix belongs in its own commit.
- **`pnpm lint:arch` reports 8 pre-existing violations** in `workspace`,
  `settings`, `pulls` and `polling` routes — a half-finished repository
  extraction, untouched here. The conventions module contributes none.
- **No cost attribution.** A scan spends two model calls and records neither
  tokens nor cost, while a review run records both. Root `insights.md` warns that
  `cost_usd` null ≠ 0; there is currently nowhere on `convention_scan_state` to
  put it.
