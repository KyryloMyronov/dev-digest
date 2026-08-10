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

## 2026-08-09 — `wait --text` matches RENDERED text, so `text-transform` breaks it

**Rubric:** Recurring Errors & Fixes
**Symptom:** a flow step asserting a section heading times out and fails, while
the string is provably correct — it is copied verbatim from
`client/messages/en/*.json`, the component renders it, and the screenshot on
failure shows it on screen. `wait --text "Attach a skill"` fails;
`wait --text "Order matters"` two lines earlier passes.
**Cause:** the heading is styled `textTransform: "uppercase"` (the SECTION LABEL
pattern used across the studio — `SkillsTab/styles.ts` `availableHead`,
`SkillPreview/styles.ts` `sectionLabel`). `wait --text` compares the **rendered**
text, and Chrome's `innerText` applies `text-transform`, so the only string that
matches is `ATTACH A SKILL`. `textContent` would have matched the original case,
which is why the message catalogue looks like the right source and isn't.
**Fix:** do not assert on a heading carrying `text-transform` — assert on the
section's CONTENT instead, which is a stronger claim anyway (in
`09-skills.flow.json`, `api-contract-gate` appearing in the attachable list
proves the section rendered *and* that the filtering is right, where the label
proved neither). If a label really is the only anchor available, match the
transformed casing and say why in the step's `label`. Before blaming the
selector, check the component's `styles.ts` for `textTransform`.

## 2026-08-03 — running the flows with no global `agent-browser`, and under Colima

**Rubric:** What Works
**Symptom:** two separate blocks on a machine that has never run the suite.
`./scripts/e2e.sh` warns `agent-browser not found` and every flow then fails at
step 1; and before that, its Postgres step cannot reach Docker at all under
Colima.
**Cause:** `run.ts` resolves the CLI as the bare name `agent-browser`
(`AGENT_BROWSER_BIN`, default on `$PATH`), and `npx agent-browser` does **not**
put it on `$PATH` — so the documented `npx agent-browser install` downloads
Chrome and still leaves the runner unable to find the binary. Separately,
`e2e.sh` shells out to `docker`, which needs the same Colima socket that
testcontainers does (see `server/insights.md`).
**Fix:** no global install is required. Install once with
`npx --yes agent-browser@<version> install`, then point the runner at the
npx-cached copy — either `AGENT_BROWSER_BIN=<path>` or a two-line `sh` shim on
`$PATH` wrapping `node .../agent-browser/bin/agent-browser.js`. Prefix the
hermetic script with the Colima socket:

```sh
DOCKER_HOST=unix://$HOME/.colima/default/docker.sock ./scripts/e2e.sh
```

Useful while iterating: a flow step is passed verbatim to the CLI, so
`{ "cmd": ["screenshot", "/tmp/x.png"] }` drops a real screenshot mid-flow —
handy for eyeballing a design against a mock. Strip such steps before
committing; the runner already screenshots on failure.

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