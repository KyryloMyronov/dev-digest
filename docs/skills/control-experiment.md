# The skills control experiment

The claim a skill makes is that attaching it changes the review. This is how you
check that claim on this workspace, with the variable isolated: **same agent,
same PR, same model — only the skill toggles.**

Two seeded PRs exist for exactly this, on `acme/payments-api`. Both ship
unreviewed; running the agent is the experiment.

| PR | Agent | Skills under test | Planted defect |
|---|---|---|---|
| **#486** Add per-workspace daily payout limits | Test Quality Reviewer | `uncovered-branches`, `corner-cases` | Three untested outcomes in `checkPayoutLimit`, one of them a boundary |
| **#489** Require currency on the refund request | General Reviewer | `api-contract-gate` | An optional request field made required |

Fixtures: [`server/src/db/seed-fixtures.ts`](../../server/src/db/seed-fixtures.ts).
They are idempotent and survive `docker compose down -v` + `pnpm db:seed`.

## What is reproducible, and what is not

Be honest about which half is which:

- **Reproducible.** The assembled prompt and the run log. With the skills off,
  the trace has no `skills` block and the log says
  `Skills disabled, not in prompt: …`. With them on, the block is there,
  `tokens_in` is higher by the size of the block, and the log says
  `Skills attached (N): …`. That difference is mechanical — it is the same every
  time, and it is what the feature actually guarantees.
- **Expected, not guaranteed.** The finding. The model is sampled; a run can
  miss a defect it caught a minute ago, or word it differently, or report it
  under a different severity. Do not treat one skilled run that found nothing as
  proof the skill does nothing — read the prompt first, then re-run.

So the experiment's pass condition is: *the skill block is in the prompt, and
across a couple of runs the skilled condition names the planted defect while the
unskilled condition does not.*

## Running it

### 0. Both conditions, either way of toggling

**In the UI:** Agents → the agent → **Skills** tab. Each attached skill has a
checkbox. Unchecking it keeps the attachment and its position and only removes
the body from the prompt, which is the whole point — the with/without comparison
is one click and nothing has to be re-attached afterwards.

**Over the API** (`:3001`), if you would rather script it:

```sh
# ids
AGENT=$(curl -s localhost:3001/agents \
  | jq -r '.[] | select(.name=="Test Quality Reviewer") | .id')
SKILL=$(curl -s localhost:3001/skills \
  | jq -r '.[] | select(.name=="uncovered-branches") | .id')

# off, then on
curl -s -X PATCH localhost:3001/agents/$AGENT/skills/$SKILL \
  -H 'content-type: application/json' -d '{"enabled":false}'
curl -s -X PATCH localhost:3001/agents/$AGENT/skills/$SKILL \
  -H 'content-type: application/json' -d '{"enabled":true}'
```

A skill has **two** switches and both must be on for it to reach the prompt: the
per-agent link (above) and the skill's own global `enabled` on the Skills page.
Toggling the link is the right lever here — disabling the skill globally would
change the condition for every agent that links it.

Then open the PR and run the agent: **Pull Requests → the PR → Run review →**
pick the agent. Equivalent request:

```sh
PR=$(curl -s localhost:3001/repos/$REPO/pulls | jq -r '.[] | select(.number==486) | .id')
curl -s -X POST localhost:3001/pulls/$PR/review \
  -H 'content-type: application/json' -d "{\"agentId\":\"$AGENT\"}"
```

Run **disabled first**, then enabled. Doing it in that order stops you reading
the skilled result and then finding it "obvious" in the unskilled one.

### 1. PR #486 — Test Quality Reviewer

Disable `uncovered-branches` and `corner-cases` on the agent (leave
`mocking-discipline` alone — the PR has no mocks, so it is inert here and
leaving it attached shows a skill correctly declining to apply).

The diff adds `src/payouts/limits.ts` with `checkPayoutLimit`, wires it into
`src/api/payouts.ts`, and adds `test/payouts-limits.test.ts` with exactly one
test: an under-cap amount, asserting the returned `allowed` and `remaining`.

**Without the skills** — expect an approve or a mild comment. This is not the
model failing: the base Test Quality prompt asks whether the change is tested and
whether the assertion is about the outcome, and here it *is* tested and the
assertion *is* on the returned value. A reviewer can honestly sign this off.

**With the skills** — expect findings that name specific unexercised outcomes:

- the `limit === null` guard (unlimited workspace) — no test passes `null`;
- the `amount > remaining` rejection — no test goes over the cap, so the route's
  new 409 path is unreachable from the suite;
- the `amount === remaining` boundary, which the code deliberately treats
  differently from both neighbours (`remaining: 0`, `reason: 'cap_reached'`) and
  which no test visits.

The first two come from `uncovered-branches`, the third from `corner-cases`.
Findings cite lines in `src/payouts/limits.ts`, which is a new file and therefore
entirely inside one hunk, so grounding keeps them.

### 2. PR #489 — General Reviewer

Disable `api-contract-gate` on the General Reviewer, run, re-enable, run again.

The diff makes `currency` required on `POST /refunds` and deletes the server-side
fallback (`body.currency ?? charge.currency`) that made it optional. The only
caller updated is the endpoint's own integration test.

**Without the skill** — expect an approve. The change is small, internally
consistent, and its own test was updated; nothing in the base General Reviewer
prompt forces the question "who else sends this request?".

**With the skill** — expect a finding that names the mechanism, not just the
label: an existing optional request field made required is a narrowing of what
the endpoint accepts, so every caller still omitting `currency` (the PR body
lists the support dashboard, the mobile client and the nightly auto-refund job)
now gets a 422 on a request that worked yesterday. `api-contract-gate` grades
that CRITICAL.

## Where to see the evidence

- **Run Trace drawer → Trace tab → Prompt assembly.** The `skills` block appears
  only when at least one skill survived both switches. Expand it and you are
  looking at the exact text that went to the model, with each block headed by its
  skill's name, type, version and source.
- **Run Trace drawer → Stats.** `tokens_in` between the two runs. The delta is
  the skills block; it is the cheapest proof that the prompt actually changed.
- **Live Log** (streaming during the run, persisted on the run afterwards):
  - `Skills attached (2): uncovered-branches, corner-cases`
  - `Skills disabled, not in prompt: uncovered-branches, corner-cases`
  A skill that is attached but silently missing from the prompt would be
  indistinguishable from a broken feature, so the skipped ones are logged by
  name too.
- **Findings list.** The outcome — read last, and read it as evidence rather than
  proof.

## Resetting

Re-running `pnpm db:seed` does **not** undo your toggles, deliberately: a
disabled link is the state one half of this experiment runs in, and a re-seed
that re-enabled it would look like the toggle failed to persist. The seed also
leaves the two PRs' existing runs in place. For a genuinely clean slate:
`docker compose down -v && ./scripts/dev.sh`.
