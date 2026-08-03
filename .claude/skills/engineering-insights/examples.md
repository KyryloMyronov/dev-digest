# Examples

## Rejected vs accepted

The rule: an agent with no memory of the session reads the entry and knows what
to do. No follow-up question.

| ❌ Rejected | ✅ Accepted |
|---|---|
| "Promises can be tricky" | "`Promise.all()` on the pipeline ingest times out past ~30 items — use `Promise.allSettled()` in batches of 10" |
| "be careful with async" | "checkout state always goes through Zustand (`cartStore.ts`) — the cart is shared by 3 components; local state does not work here" |
| "watch out for the zod version" | "`server` and `reviewer-core` can resolve different zod instances, so `instanceof z.ZodError` is unreliable across that boundary — `app.ts:138` also matches by shape; do not simplify it" |
| "the seed matters for e2e" | "flows assert on fixtures from `server/src/db/seed.ts` (e.g. PR `#482`) — treat seeded identifiers as a public interface; change the seed and the flows together" |

What the accepted column has and the rejected one does not: a file path, a
symbol, a threshold, or a command. Something to act on.

## Entries in this repo worth copying the shape of

**A tool quirk with the literal error string** — someone will grep for it
(`client/insights.md`):

```markdown
## 2026-07-30 — `ERR_PNPM_IGNORED_BUILDS` on install (esbuild, sharp)

**Rubric:** Recurring Errors & Fixes
**Symptom:** `pnpm install` fails with
`[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@…, sharp@…`.
**Cause:** pnpm 10+ won't run dependency build scripts unless each package is
explicitly approved. `client/pnpm-workspace.yaml` existed but held the
placeholder `set this to true or false`, which is not a boolean and therefore
counts as *unapproved*.
**Fix:** real booleans in `allowBuilds:` … Commit the file: it's needed by CI
and every other machine.
```

Note the cause explains *why the placeholder counted as unapproved*. Without
that sentence the next person retries the same placeholder.

**A latent risk, nothing broken yet** (`server/insights.md`):

```markdown
## 2026-07-30 — stale-run reaping is single-instance only

**Rubric:** Open Questions
**Symptom:** none yet — latent.
**Cause:** `app.ts:81` reaps every `agent_runs` row still marked `running` at
boot, on the assumption that a fresh process owns no in-flight runs. Correct
for one API instance per DB; with replicas it would kill live runs on a peer.
**Fix:** if this ever runs replicated, add per-instance scoping or heartbeats
first. The reap is awaited before listening on purpose — don't make it async.
```

`Symptom: none yet — latent` is the honest form. It stops a reader from hunting
for a bug that has not happened.

**A deliberate design that looks like a bug** (`reviewer-core/insights.md`):

```markdown
## 2026-07-30 — the reported score is recomputed, not the model's

**Rubric:** Codebase Patterns
**Symptom:** the score doesn't match what the model returned.
**Cause:** intentional. `score` is derived from the findings that survived
grounding (`src/review/run.ts:238`), so score, findings, and verdict can never
contradict each other.
**Fix:** nothing — don't "restore" the model's self-reported score.
```

`**Fix:** nothing — don't …` is a real fix. It stops the next agent from
"correcting" working code.

## Superseding

Never edit or delete. Add a new entry above:

```markdown
## 2026-09-14 — pnpm 11 approves builds per package, not per workspace

**Rubric:** Tool & Library Notes
**Supersedes:** 2026-07-30 — `ERR_PNPM_IGNORED_BUILDS` on install (esbuild, sharp)
**Symptom:** …
```

The old entry stays. It is the record of what was believed and when — which is
what makes a bad wrap-up recoverable.