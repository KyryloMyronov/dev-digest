/* FindingsCounters — the FINDINGS cell of a PR row: all three severities,
   always, each non-empty one opening that severity's modal. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { SeverityBadge } from "@devdigest/ui";
import type { PrFindingCounts, Severity } from "@/lib/types";
import { SEVERITY_ORDER } from "../../constants";
import { s } from "../../styles";

/** A never-reviewed PR reads as a clean one: the cell is never empty. */
const ZERO_COUNTS: PrFindingCounts = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };

export function FindingsCounters({
  counts,
  onOpen,
}: {
  /** Null/undefined ⇒ the PR has never been reviewed; rendered as all-zero. */
  counts?: PrFindingCounts | null;
  onOpen: (severity: Severity) => void;
}) {
  const t = useTranslations("prReview");
  // All three counters are always present — a zero is a fact worth reading, and
  // the column keeps one shape all the way down. "Never reviewed" is left to the
  // score cell's "—"; here it is indistinguishable from reviewed-and-clean.
  const c = counts ?? ZERO_COUNTS;

  return (
    <div style={s.findingsCell}>
      {SEVERITY_ORDER.map((sev) => {
        const n = c[sev];
        const label = t(`list.findings.severity.${sev}`);
        // A zero counter has nothing to open — it stays a dimmed, inert badge
        // rather than a button onto an empty modal.
        if (n === 0) {
          return (
            <span
              key={sev}
              title={t("list.findings.zeroLabel", { severity: label })}
              style={s.counterEmpty}
            >
              <SeverityBadge severity={sev} compact count={0} />
            </span>
          );
        }
        return (
          <button
            key={sev}
            type="button"
            // The whole row navigates on click — a counter must not.
            onClick={(e) => {
              e.stopPropagation();
              onOpen(sev);
            }}
            aria-label={t("list.findings.counterLabel", { count: n, severity: label })}
            style={s.counterBtn}
          >
            <SeverityBadge severity={sev} compact count={n} />
          </button>
        );
      })}
    </div>
  );
}