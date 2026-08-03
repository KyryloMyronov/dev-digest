# `@devdigest/e2e` — browser end-to-end

Flow format, runner options, and coverage rationale: [`README.md`](README.md).
Root rules: [`../CLAUDE.md`](../CLAUDE.md).

## Stack

Vercel **agent-browser** (native Rust + CDP CLI) driven by a ~100-line `tsx`
runner. **No Playwright, no LLM, no API key.** npm, not pnpm.

## Commands

```sh
npm install                     # NOT pnpm
npx agent-browser install       # once — downloads Chrome for Testing
../scripts/e2e.sh               # hermetic: isolated stack on 3100/3101/5433, then tears down
npm test                        # against whatever stack is already running
```

## Where things live

```
specs/NN-name.flow.json    the flows — a spec is an ordered list of CLI commands
lib/                       the runner's helpers
run.ts                     executes flows in order against one browser session
agent-browser.json         CLI config
```

## Non-default conventions

- **`specs/` here means *browser flows*, not feature specs.** This package is the
  one exception to the repo-wide `specs/` convention; anything design-doc shaped
  goes in `docs/`.
- **`wait --text` / `wait --url` ARE the assertions.** They exit non-zero on
  timeout, which fails the step and the flow. There is no `expect()` — don't add
  an assertion library.
- **Every `cmd` array is passed verbatim to `agent-browser`.** Keep steps as raw
  CLI commands rather than wrapping them in helpers; the flow file should be
  readable as a transcript.
- **`{BASE}` is substituted** from `E2E_BASE_URL` (default
  `http://localhost:3000`). Never hardcode a host or port in a flow.
- **Flows must be deterministic** — they run without an LLM and must not depend
  on one. Assert on seeded fixtures, never on model output.
- **Prefer the hermetic runner** for anything you'll commit: it seeds its own DB
  on alternate ports and cannot touch your dev data or the `devdigest_pgdata`
  volume.
- Coverage is deliberately **typological, not exhaustive** — one flow per class
  of risk. See [`../TESTING.md`](../TESTING.md) before adding a flow.

## Gotchas

- **The CLI is a prerequisite, not a dependency.** `npx agent-browser install`
  must have run once, or every flow fails identically at step 1.
- Flows share **one browser session** in order, so a flow that leaves the app in
  an odd state can fail the next one. Keep them independent.
- The hermetic stack uses **3100 / 3101 / 5433**; the dev stack uses
  3000 / 3001 / 5432. A flow that passes locally but fails hermetically is
  usually a hardcoded port.
- Seeded fixture references (e.g. PR `#482`) come from `server/src/db/seed.ts` —
  changing the seed breaks flows.

## Do-not-touch

- `node_modules/`, `package-lock.json` — npm-managed.
- `playwright-report/`, `test-results/` — generated, gitignored.

## Docs

Flow format, hermetic vs local runs, coverage → [`README.md`](README.md) ·
Overall test strategy → [`../TESTING.md`](../TESTING.md) ·
Learned gotchas → [`insights.md`](insights.md) ·
Design notes → [`docs/`](docs/README.md)