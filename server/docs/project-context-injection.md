# Why project-context documents enter the prompt the way they do

This page is for whoever next changes the review prompt, the attachment surface,
or the run-start read path. It explains four decisions that the code can only
show you the *result* of: the slot that already existed, the single fenced block,
the trust boundary a skill cannot cross, and why one containment check was not
enough. Usage, routes and limits are in
[`../src/modules/project-context/README.md`](../src/modules/project-context/README.md);
this page is only the reasoning.

## The slot existed long before anything fed it

`reviewer-core` has had a `specs` slot and a rendered `## Project context`
section since well before the Project Context feature. At the commit before the
feature landed (`b509971`), `git show b509971:reviewer-core/src/prompt.ts`
declares `specs?: string[]` and pushes `## Project context` into the user
message, while `git show b509971:server/src/modules/reviews/run-executor.ts`
passes no `specs` at all and hardcodes `specs_read: []` in both trace builders.

So reading the engine gives a misleading impression of what this feature is.
`reviewer-core` received **one** production line: the fence label
(`reviewer-core/src/prompt.ts:183-193`). Everything else is server-side wiring —
attachment tables, a resolver, and three lines in `run-executor`
(`run-executor.ts:248,275-280,388-392`). If you are hunting a bug in the injected
text, the engine is almost certainly not where it lives.

## One block, and the fence label is the document's path

Every document lands inside a single `## Project context` section, each body in
its own `<untrusted source="…">` fence, and the `source` attribute is the
document's repository-relative path
(`reviewer-core/src/prompt.ts:186-192`). Two consequences are worth stating,
because both are cheap to break:

- **The prompt and the trace name the same things.** `RunTrace.specs_read` holds
  the injected paths in prompt order (`run-executor.ts:388`), so a reader of the
  trace can match a fence in the prompt text to a row in the trace without
  guessing. A label of `spec-0` — which is still what a caller passing a bare
  string gets (`reviewer-core/src/prompt.ts:190`, pinned by
  `reviewer-core/test/prompt.test.ts:239-243`) — cannot do that.
- **The label is a label.** `reviewer-core` does not derive, resolve or validate
  it; purity is that package's contract, and a path with unicode or an emoji
  passes through unmodified (`reviewer-core/test/prompt.test.ts:229-236`). A body
  that tries to close the fence is escaped instead
  (`reviewer-core/src/prompt.ts:41-46`, asserted at
  `reviewer-core/test/prompt.test.ts:245-266`).

## A skill-inherited document is still untrusted

An agent inherits the documents of its enabled skills (`resolver.ts:154-166`),
and this is the one place a reader is likely to reason by analogy and get it
wrong. Skill *bodies* are trusted-ish: they are joined and pushed as
`## Skills / rules` with `source: 'trusted'` and `untrusted: false`, un-fenced
(`reviewer-core/src/prompt.ts:177-178,236-237`).
Inheritance does **not** carry that treatment over. A document arriving by way of
a skill is still repository content written by whoever can push to the
repository, so it goes into the same single `## Project context` block, fenced
like every other document, with no marker distinguishing it.

That gives the feature exactly one trust story and one code path, and it is
enforced by construction rather than by a check: the resolver returns plain
`texts`/`injected` arrays with no provenance
(`server/src/modules/project-context/types.ts:18-25`), so nothing downstream
*can* treat an inherited document differently. Keep it that way. If a future
change needs provenance in the prompt, the question to answer first is what stops
a skill from being a laundering route for un-fenced repository text.

## The layer must never fail a review

Grounding is an enhancement; a review without it is worth much more than no
review. So every failure in this layer degrades to a shorter list plus a log
line, and the guarantee is repeated at three levels rather than trusted once:
the resolver (`resolver.ts:195-213`), the facade (`service.ts:402-419`), and the
caller in `run-executor` (`run-executor.ts:452-475`).

The third wrapper looks redundant and is not. The integration test for this
property replaces the whole facade with an object whose only method throws
(`server/test/reviews.it.test.ts:445-476`), so nothing inside the module is in
the call path; the caller's `try/catch` is the only thing between that throw and
a failed run. A reviewer tempted to delete it should run that test first.

The other half of the posture is observability. A block missing because the user
detached the document and a block missing because a read failed are
indistinguishable in the assembled prompt, so the Live Log lines are the only
thing that tells them apart (`run-executor.ts:476-497`). They carry paths and
counts. No document body reaches a log call, and `PromptSectionMetric` has no
field that could hold one (`reviewer-core/src/prompt.ts:128-144`) — the guarantee
is structural, not a redaction step.

## Three containment layers, and why `lstat` was not enough

The documents the resolver reads are **persisted** paths from
`agent_context_docs` / `skill_context_docs`, submitted by a user and stored
indefinitely. Three checks stand between such a path and a host file:

| Layer | Check | Covers what the others cannot |
|---|---|---|
| Discovery | the walk never emits a symlink (`walk.ts:118`) | Makes an attachable path a real file — but the walk is not in the run-time loop |
| Attach | the submitted path must be in the discovered set (`service.ts:478-497`) | Stops an arbitrary string at the door, once per attach rather than once per document per run |
| Run | `realpath` plus containment against a `realpath`'d clone root (`resolver.ts:269-273`) | Closes the gap between the attach-time check and the read |

The adapter's own guard is underneath all three: `SimpleGitClient.readFile`
resolves the joined path and asserts containment before any fs call
(`server/src/adapters/git/simple-git.ts:148-171`). It is **lexical** — a symlink
that lives inside the clone and points out of it is "contained" by that test, so
it cannot be the only defence.

The run-time layer exists because layer 2 is a time-of-check and the read is the
time-of-use. A repository owner can attach a real file, then replace it in the
repository with a symlink to a host path; a resync hard-resets the clone
(`server/src/adapters/git/simple-git.ts:78-89`), so the link lands on disk while
the persisted path is unchanged, and re-attaching never happens.

The first attempt at that layer was `lstat` plus `isSymbolicLink()`, and it was
insufficient: `lstat` does not follow the **final** path component but does
follow every intermediate one. Replacing the `specs/sub` *directory* of an
attached `specs/sub/foo.md` therefore yielded `isSymbolicLink() === false`, a
path still lexically inside the clone, and a read that returned the host file.
`realpath` resolves every component, which closes the class instead of one
instance of it (`resolver.ts:30-44`). Both vectors — the swapped file and the
swapped directory — are in `resolver.test.ts:298-339`, and a test that only swaps
the file passes against the insufficient fix, which is how the gap survived a
review round.

Two smaller decisions in the same area, recorded so they are not reopened by
accident:

- **The guard was not moved into the adapter.** `realpath` there would add a
  syscall to every file read in the system, not just to context documents. The
  resolver pays two calls per document instead (`resolver.ts:269-280`).
- **The resolver does not re-walk the clone.** Membership is the door's job;
  re-validating per run would put a full traversal on the critical path of every
  LLM call (`resolver.ts:19-29`).

## Where this leaves the trust story

- Prompt-injection defence for these documents is the shared `INJECTION_GUARD`
  plus the fence, not text scanning — the same posture as the diff and the PR
  body (`reviewer-core/src/prompt.ts:6-9`, and the *Review context* section of
  [`../README.md`](../README.md)).
- The path itself is user-controlled and stays inside the clone by the three
  layers above.
- A skipped document is visible in `RunTrace.specs_skipped` and in the Live Log,
  never silently dropped — though nothing renders `specs_skipped` yet.
