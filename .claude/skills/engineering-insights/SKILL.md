---
name: engineering-insights
description: Captures durable engineering insights into the right package's insights.md at the end of a substantive session, and recalls existing ones before work starts. Use when wrapping up a task, when the user asks what was learned, or when something non-obvious just cost real time — a gotcha, a dead end, a convention discovered, a dependency quirk, a recurring error and its fix. Also use at the start of a task to read what past sessions already learned about the package being touched. Writes are strictly append-only and guarded.
allowed-tools: Read, Grep, Glob, Edit, Bash(./.claude/skills/engineering-insights/guard.sh *)
disallowed-tools: Write
---

# Engineering Insights

Two phases. **RECALL** before work, **CAPTURE** after. Most invocations are
CAPTURE; RECALL is normally triggered by the rule in the root `CLAUDE.md`
rather than by loading this skill.

> **`Write` is unavailable while this skill is active.** That is deliberate —
> it makes a whole-file overwrite of an `insights.md` impossible rather than
> merely forbidden. The restriction clears with your next message. If a target
> file does not exist, stop and say so; do not attempt to create it here.

## Where each insight goes

Route by **where the fix landed**, not where the symptom appeared.

| Touched | File |
|---|---|
| `server/**` — including `src/modules/repo-intel/` and `src/vendor/shared/` | `server/insights.md` |
| `client/**` | `client/insights.md` |
| `reviewer-core/**` | `reviewer-core/insights.md` |
| `e2e/**` | `e2e/insights.md` |
| `scripts/`, `docs/`, `.github/`, root configs, or a fix spanning two packages | `insights.md` (repo root) |

A contract change touching both `server/src/vendor/shared/` and
`client/src/vendor/shared/` is cross-cutting → root.

## Phase 1 — RECALL

Before the first edit of a task:

1. Determine the package from the routing table above.
2. `Read` that package's `insights.md` **and** the root `insights.md`.
3. Treat entries as high-confidence guidance unless something says otherwise.
4. If an entry contradicts the code as it stands now, **the code wins** — the
   entry is stale. Note the contradiction and capture it later under
   *Open Questions*. Do not silently follow a stale entry.

## Phase 2 — CAPTURE

Three gates, in order. Any gate can end the process with **nothing written**.
Writing nothing is a valid, common, correct outcome.

### Gate 1 — Is it substantial?

Capture only from a session that ran roughly **30 minutes or more** and
contained a real problem, decision, or discovery.

Skip: routine edits that went as expected, renames, formatting, dependency
bumps that installed cleanly, anything the user simply asked for and got.
Signal quality beats volume — a file nobody trusts is worse than a short one.

### Gate 2 — Is it already there?

**Mandatory before every write.** `Grep` the target file for the key term
(the error string, the symbol, the package name).

- Already covered → **write nothing**.
- Covered but now wrong or incomplete → write a **new** entry with a
  `**Supersedes:**` line naming the old one. Never edit or delete the old entry.
- Genuinely new → continue.

### Gate 3 — Is it actionable cold?

An agent with no memory of this session must read the entry and **know what to
do**, with no follow-up question. Name the file, the symbol, the number, the
command.

| Rejected | Accepted |
|---|---|
| "Promises can be tricky" | "`Promise.all()` on the pipeline ingest times out past ~30 items — use `Promise.allSettled()` in batches of 10" |
| "be careful with async" | "checkout state always goes through Zustand (`cartStore.ts`) — the cart is shared by 3 components; local state does not work here" |

Also reject anything that fails the 5-minute test: *would this save someone
five minutes next time?* If not, it is noise. See `rubrics.md` for the full
filter.

## The seven rubrics

Every entry carries exactly one.

| Rubric | For |
|---|---|
| **What Works** | An approach or solution that turned out right |
| **What Doesn't Work** | Dead ends and anti-patterns — **most often skipped, most valuable** |
| **Codebase Patterns** | A convention or architectural decision discovered, not documented |
| **Tool & Library Notes** | A dependency quirk |
| **Recurring Errors & Fixes** | An error seen more than once, with its fix |
| **Session Notes** | A dated summary worth keeping when it fits nothing else |
| **Open Questions** | Left unresolved — latent risks, known constraints, contradictions |

Definitions and what does *not* qualify: `rubrics.md`.

## Entry format

Matches what is already in these files. Newest first, so a new entry goes
directly below the `---` separator.

```markdown
## YYYY-MM-DD — one-line title

**Rubric:** Recurring Errors & Fixes
**Symptom:** what was actually observed
**Cause:** why it happened
**Fix:** what to do — concrete enough to act on without asking
```

`**Supersedes:** YYYY-MM-DD — old title` goes after `**Rubric:**` when it
applies. `Symptom` may be `none yet — latent` for an *Open Questions* entry.

## How to write it — append-only, enforced

1. **Snapshot** first:

   ```sh
   ./.claude/skills/engineering-insights/guard.sh snapshot <file>
   ```

2. **`Read`** the file (also satisfies Gate 2).

3. **`Edit` with a two-line anchor.** `old_string` is the `---` separator plus
   the heading line of the current first entry. Reproduce **both verbatim** in
   `new_string`, with the new entry between them:

   ```
   old_string:  ---\n\n## 2026-07-30 — existing first entry
   new_string:  ---\n\n## 2026-08-02 — new entry\n…body…\n\n## 2026-07-30 — existing first entry
   ```

   For a file with no entries yet, the anchor is the bare `---`. If that file
   also has no trailing newline, `---\n` will not match — anchor on `---`
   alone, and leave the file ending in a newline.

4. **Verify**:

   ```sh
   ./.claude/skills/engineering-insights/guard.sh verify <file>
   ```

   Non-zero exit means a pre-existing line was removed or modified. Restore
   with the printed `cp` command, then retry with a tighter anchor. Never
   "fix up" the file by hand after a failed verify.

Never reflow, rewrap, re-sort, renumber, or tidy an existing entry. A
whitespace-only change to someone else's line is a lost lesson in the next
merge.

## Additional resources

- `rubrics.md` — the seven rubrics in full, plus what never belongs here
- `examples.md` — accepted and rejected entries, drawn from this repo
- `maintenance.md` — pruning, contradictions, size limits, the L06 hook
- `references.md` — sources