# e2e — insights

Append-only log of things that cost real time. Newest first. One entry per
gotcha; if it becomes a rule everyone must follow, promote it to `CLAUDE.md` and
leave the entry here as the explanation.

Format: `## YYYY-MM-DD — one-line title` then symptom → cause → fix.

Entries also carry `**Rubric:**` — one of: What Works · What Doesn't Work ·
Codebase Patterns · Tool & Library Notes · Recurring Errors & Fixes ·
Session Notes · Open Questions. Find one with
`grep -n '^\*\*Rubric:\*\* Open Questions' insights.md`. Written by the
`engineering-insights` skill; see `../.claude/skills/engineering-insights/`.

---

## 2026-07-30 — every flow fails identically at step 1

**Rubric:** Recurring Errors & Fixes
**Symptom:** all flows fail on their first `open`, with no browser window.
**Cause:** the `agent-browser` CLI is a prerequisite, not an npm dependency —
`npx agent-browser install` (which downloads Chrome for Testing) has never run on
this machine.
**Fix:** run it once. It is not part of `npm install`.

## 2026-07-30 — `specs/` here does not mean what it means elsewhere

**Rubric:** Codebase Patterns
**Symptom:** confusion about where to put a design note in this package.
**Cause:** repo-wide, `<package>/specs/` holds forward-looking feature specs. In
`e2e/` the folder predates that convention and holds `NN-name.flow.json` browser
flows.
**Fix:** flows stay in `specs/`; anything design-doc shaped goes in `docs/`.

## 2026-07-30 — passes on the dev stack, fails hermetically

**Rubric:** Recurring Errors & Fixes
**Symptom:** a flow is green locally and red in `../scripts/e2e.sh` or CI.
**Cause:** a hardcoded host/port. The hermetic stack runs web 3100, API 3101,
Postgres 5433; the dev stack runs 3000/3001/5432.
**Fix:** always use `{BASE}`, substituted from `E2E_BASE_URL`. Never write
`localhost:3000` in a flow.

## 2026-07-30 — flows share one browser session, in order

**Rubric:** Codebase Patterns
**Symptom:** a flow passes alone and fails in the suite.
**Cause:** `run.ts` executes flows sequentially against a single session, so
leftover navigation or state leaks forward.
**Fix:** each flow must establish its own starting point (`open {BASE}/...`)
rather than assuming a fresh browser.

## 2026-07-30 — changing the seed breaks flows silently

**Rubric:** Codebase Patterns
**Symptom:** `wait --text "#482"` times out after unrelated backend work.
**Cause:** flows assert on fixtures from `server/src/db/seed.ts` (e.g. PR #482);
the seed is the contract.
**Fix:** treat seeded identifiers as a public interface of the seed. Change the
seed and the flows together.