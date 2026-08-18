---
name: test-flake-signals
description: Apply when the diff adds or changes a test. Report constructs that make it pass or fail depending on timing, ordering, environment, or shared state.
type: convention
---

# Flake signals

A flaky test is worse than a missing one: it trains the team to re-run CI until
it is green, and the day it catches a real defect nobody believes it. Flakiness
is almost always visible in the source — you do not need to run the test to spot
these.

## Report

- **Real time.** `setTimeout`, `sleep`, `await new Promise(r => setTimeout(r, n))`
  used to wait for something to finish. The number is a bet on machine speed and
  CI loses it. Wait for the condition (`vi.waitFor`, Testing Library's
  `findBy*`/`waitFor`), or drive the clock with `vi.useFakeTimers()`.
- **Wall-clock and randomness.** `Date.now()`, `new Date()`, `Math.random()`,
  `crypto.randomUUID()` in an assertion or in an input the assertion depends on.
  A test that compares against "now" fails at midnight, at a month boundary, or
  when the runner is slow between the two reads.
- **Order dependence.** State that survives between tests: a module-level `let`,
  a shared array or `Map` mutated in a test body, a `beforeAll` fixture that
  later tests write to, a database row created in one `it` and read in another.
  These pass in file order and fail under `--shuffle`, in parallel, or when a
  single test is run with `.only`.
- **Missing cleanup.** A spy, timer, environment variable, global patch, network
  interceptor or DB row created and never restored. The damage lands in a
  *different* test, which is why it reads as unrelated flake.
- **Unawaited work.** A promise not awaited, an event handler asserted on without
  waiting for it, a `test()` body that returns before the assertion runs. Vitest
  will happily pass a test whose assertions have not executed yet.
- **Environment assumptions.** Locale-dependent formatting (`toLocaleString`,
  currency, month names), timezone-dependent dates, filesystem path separators,
  a fixed port, a hard-coded temp path, or reliance on network access.
- **Concurrency without a barrier.** `Promise.all` over operations that write the
  same row or key, asserted as if the order were fixed.

## Method

For each test the diff adds or changes, ask three questions:
1. Would it still pass if every other test in the suite ran first?
2. Would it still pass on a machine ten times slower?
3. Would it still pass in a different timezone, locale, and at 23:59:59?

A "no" or "I cannot tell" to any of them is a finding. Name the construct, the
line, and which of the three questions it fails.

## Severity

- **CRITICAL** — the flake is in a test that gates a merge and fails
  intermittently in a way that will be silenced by a re-run culture rather than
  fixed. Reserve this for shared mutable state across tests, which corrupts
  *other* tests' results too.
- **WARNING** — the ordinary case: a sleep, a real-clock assertion, missing
  cleanup within one test.
- **SUGGESTION** — a construct that is only theoretically flaky here but sets a
  pattern others will copy.

Do not report a fixed `sleep` inside a helper that is explicitly testing timeout
behaviour, and do not ask for fake timers where the test does not involve time.
