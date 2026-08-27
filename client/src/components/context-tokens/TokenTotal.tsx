/* TokenTotal — the summed token count of the ATTACHED documents (AC-32), in the
   error colour once it passes the run budget (AC-33).

   Shared by the agent Context tab and the skill editor's Context surface, and
   label-driven for the reason given in TokenCount.tsx.

   Documents with no persisted count contribute nothing to the sum and are
   reported separately, because a total that silently treated `null` as 0 would
   read as "well under budget" for a repository the token job has not reached
   yet. `--crit` is an existing variable and meets 4.5:1 in both themes; the
   over-budget state is also stated in WORDS, so it never rests on colour alone
   (WCAG 1.4.1). */
"use client";

import React from "react";
import { PROJECT_CONTEXT_TOKEN_BUDGET } from "./constants";

export function TokenTotal({
  tokens,
  pendingCount,
  format,
  overBudgetLabel,
  pendingFormat,
}: {
  tokens: number;
  pendingCount: number;
  /** e.g. `(tokens, budget) => t("context.total", { tokens, budget })`. */
  format: (tokens: number, budget: number) => string;
  /** e.g. `t("context.overBudget")`. */
  overBudgetLabel: string;
  /** e.g. `(n) => t("context.pendingCount", { count: n })`. */
  pendingFormat: (count: number) => string;
}) {
  const over = tokens > PROJECT_CONTEXT_TOKEN_BUDGET;

  return (
    // NFR-8 (SC 4.1.3) — the total changes as rows are attached and detached, so
    // it is announced politely, in place, with no focus move.
    <span
      role="status"
      aria-live="polite"
      style={{
        fontSize: 12.5,
        fontWeight: over ? 700 : 500,
        color: over ? "var(--crit)" : "var(--text-secondary)",
      }}
    >
      <span className="tnum">{format(tokens, PROJECT_CONTEXT_TOKEN_BUDGET)}</span>
      {over && <span> {overBudgetLabel}</span>}
      {pendingCount > 0 && <span> {pendingFormat(pendingCount)}</span>}
    </span>
  );
}
