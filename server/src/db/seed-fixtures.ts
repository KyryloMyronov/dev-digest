/**
 * Control-experiment PR fixtures (L02).
 *
 * Two demo PRs whose only job is to make the skills feature's acceptance
 * criterion reproducible: run an agent on the SAME PR twice — once with its
 * skills disabled, once enabled — and the difference is attributable to the
 * skills alone. Walkthrough: `docs/skills/control-experiment.md`.
 *
 *   #486 → **Test Quality Reviewer** + `uncovered-branches`, `corner-cases`
 *   #489 → **General Reviewer** + `api-contract-gate`
 *
 * Both are seeded UNREVIEWED (no `reviews`/`findings` rows, no
 * `last_reviewed_sha`) — running the agents live IS the experiment, so a seeded
 * verdict would answer the question the exercise is meant to ask.
 *
 * The `patch` text is load-bearing, not decoration. These repos are never
 * cloned, so `loadDiff` falls back to `diffFromPrFiles`, which reconstructs the
 * whole review input from these strings — and reviewer-core's grounding gate
 * then DROPS any finding whose cited line does not intersect a real hunk. An
 * `@@` header whose counts disagree with the body produces a run where the
 * model finds the defect and the finding silently disappears. Hunk arithmetic:
 * `oldLines` = context + deletions, `newLines` = context + additions, and each
 * hunk's `newStart` carries the net line delta of the hunks above it.
 *
 * Blank context lines are written as empty strings rather than a bare space, so
 * no editor or formatter can quietly rewrite the fixture by trimming trailing
 * whitespace; `parseUnifiedDiff` treats both as context.
 */

export interface ControlPrFile {
  path: string;
  additions: number;
  deletions: number;
  /** Unified-diff body: `@@` headers plus ` `/`+`/`-` lines. No `diff --git`
   *  or `---`/`+++` header — `diffFromPrFiles` prepends those. */
  patch: string;
}

export interface ControlPr {
  number: number;
  title: string;
  author: string;
  branch: string;
  headSha: string;
  additions: number;
  deletions: number;
  updatedHoursAgo: number;
  /** Shown on the PR page and fed to the reviewer as untrusted context. */
  body: string;
  files: ControlPrFile[];
  commitMessage: string;
}

// ---- #486 — Test Quality Reviewer -----------------------------------------
// The gap is deliberately real and specific: `checkPayoutLimit` has a null-limit
// guard, an over-cap early return, and an exactly-on-the-cap boundary that the
// code treats differently from both neighbours — and the one test in the diff
// passes a single under-cap amount. A reviewer WITHOUT `uncovered-branches` /
// `corner-cases` can truthfully say "the change is tested and the test asserts
// the returned value"; a reviewer WITH them has to name the three unexercised
// outcomes and the `amount === remaining` edge.

const PAYOUT_LIMITS_TS = `@@ -0,0 +1,32 @@
+export interface PayoutLimit {
+  dailyCapMinor: number;
+}
+
+export interface PayoutDecision {
+  allowed: boolean;
+  remaining: number | null;
+  reason?: 'daily_cap_exceeded' | 'cap_reached';
+}
+
+/**
+ * Decide whether a payout of amount (minor units) may proceed under the
+ * workspace's daily cap. A workspace with no limit row is unlimited.
+ */
+export function checkPayoutLimit(
+  amount: number,
+  limit: PayoutLimit | null,
+  spentToday: number,
+): PayoutDecision {
+  if (limit === null) return { allowed: true, remaining: null };
+
+  const remaining = limit.dailyCapMinor - spentToday;
+  if (amount > remaining) {
+    return { allowed: false, remaining, reason: 'daily_cap_exceeded' };
+  }
+  // A payout landing exactly on the cap is allowed, but it closes the day: the
+  // caller must not be told there is room left for another one.
+  if (amount === remaining) {
+    return { allowed: true, remaining: 0, reason: 'cap_reached' };
+  }
+  return { allowed: true, remaining: remaining - amount };
+}`;

const PAYOUT_LIMITS_TEST_TS = `@@ -0,0 +1,11 @@
+import { describe, it, expect } from 'vitest';
+import { checkPayoutLimit } from '../src/payouts/limits.js';
+
+describe('checkPayoutLimit', () => {
+  it('allows a payout below the daily cap', () => {
+    const decision = checkPayoutLimit(2500, { dailyCapMinor: 10000 }, 1000);
+
+    expect(decision.allowed).toBe(true);
+    expect(decision.remaining).toBe(6500);
+  });
+});`;

const PAYOUTS_ROUTE_TS = `@@ -14,5 +14,6 @@
 import { payoutsRepo } from '../db/payouts.js';
 import { toPayoutDto } from './dto.js';
+import { checkPayoutLimit } from '../payouts/limits.js';

 export async function payoutRoutes(app: FastifyInstance) {
   app.post('/payouts', async (req, reply) => {
@@ -31,6 +32,12 @@
     const { amount, destination } = req.body;
     const workspace = await requireWorkspace(req);

+    const spentToday = await payoutsRepo.spentToday(workspace.id);
+    const decision = checkPayoutLimit(amount, workspace.payoutLimit, spentToday);
+    if (!decision.allowed) {
+      return reply.code(409).send({ error: decision.reason });
+    }
+
     const payout = await payoutsRepo.create({
       workspaceId: workspace.id,
       amount,`;

// ---- #489 — General Reviewer ----------------------------------------------
// ONE breaking mechanism, from the `api-contract-gate` body: an existing
// OPTIONAL request field made REQUIRED. The second hunk deletes the server-side
// fallback that made it optional in the first place, so the break is visible in
// the diff rather than inferred, and the test hunk shows the author updating
// only their own caller. Nothing else in the PR is wrong — a reviewer WITHOUT
// the skill reads it as a small, well-scoped tightening.

const REFUNDS_ROUTE_TS = `@@ -12,7 +12,7 @@

 const RefundBody = z.object({
   charge_id: z.string().uuid(),
   amount_minor: z.number().int().positive(),
-  currency: z.string().length(3).optional(),
+  currency: z.string().length(3),
   reason: z.string().max(280).optional(),
 });
@@ -34,8 +34,7 @@
     const body = RefundBody.parse(req.body);
     const charge = await chargesRepo.byId(body.charge_id);
     if (!charge) throw new NotFoundError('Charge not found');

-    // Callers that omit currency inherit it from the charge being refunded.
-    const currency = body.currency ?? charge.currency;
+    const currency = body.currency;

     const refund = await refundsRepo.create({`;

const REFUNDS_TEST_TS = `@@ -21,7 +21,7 @@
     const res = await app.inject({
       method: 'POST',
       url: '/refunds',
-      payload: { charge_id: charge.id, amount_minor: 500 },
+      payload: { charge_id: charge.id, amount_minor: 500, currency: 'EUR' },
     });

     expect(res.statusCode).toBe(201);`;

export const CONTROL_EXPERIMENT_PRS: ControlPr[] = [
  {
    number: 486,
    title: 'Add per-workspace daily payout limits',
    author: 'sara.lin',
    branch: 'feat/payout-daily-limits',
    headSha: 'b7c8d9e0f1a2',
    additions: 50,
    deletions: 0,
    updatedHoursAgo: 2,
    body:
      'Payouts are now capped per workspace per day. `checkPayoutLimit` returns the ' +
      'remaining allowance so the route can reject over-cap payouts with a 409 ' +
      'instead of letting them through. Added a unit test for the new helper.',
    commitMessage: 'Cap payouts at the workspace daily limit',
    files: [
      { path: 'src/payouts/limits.ts', additions: 32, deletions: 0, patch: PAYOUT_LIMITS_TS },
      {
        path: 'test/payouts-limits.test.ts',
        additions: 11,
        deletions: 0,
        patch: PAYOUT_LIMITS_TEST_TS,
      },
      { path: 'src/api/payouts.ts', additions: 7, deletions: 0, patch: PAYOUTS_ROUTE_TS },
    ],
  },
  {
    number: 489,
    title: 'Require currency on the refund request',
    author: 'deepak.r',
    branch: 'fix/refund-currency-required',
    headSha: 'c8d9e0f1a2b3',
    additions: 3,
    deletions: 4,
    updatedHoursAgo: 1,
    // The caller list is deliberate: `api-contract-gate` tells the reviewer to
    // "name the caller that breaks", and without it the best possible finding is
    // the generic "any caller omitting currency". Equally deliberate is that the
    // author states it as neutral context and never draws the conclusion — the
    // whole point of the experiment is whether the SKILL makes the reviewer draw
    // it. An author who wrote "note: this is breaking" would hand over the
    // answer and the with/without comparison would measure nothing.
    body:
      'The ledger should record the refund currency explicitly rather than inferring ' +
      'it from the charge, so `currency` is now required on POST /refunds and the ' +
      'server-side fallback is gone. Updated the refunds integration test to send it. ' +
      'POST /refunds is called by the support dashboard, the mobile client and the ' +
      'nightly auto-refund job.',
    commitMessage: 'Make currency required on POST /refunds',
    files: [
      { path: 'src/api/refunds.ts', additions: 2, deletions: 3, patch: REFUNDS_ROUTE_TS },
      { path: 'test/refunds.test.ts', additions: 1, deletions: 1, patch: REFUNDS_TEST_TS },
    ],
  },
];
