/* EvalsTab — SPEC-04's Evals tab in the agent editor.

   Three metric tiles over the agent's LATEST batch, its case list, and the run
   control. AC-59 … AC-67 and AC-112 all land here.

   The batch list is POLLED (`useEvalBatches`), not awaited: `POST
   /agents/:id/eval-runs` answers 202 and the work happens on the JobRunner, so
   "running" is a state the studio reads back rather than one it holds. */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge, Button, EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import type { Agent, EvalBatchRecord, EvalCase } from "@devdigest/shared";
import {
  useEvalAgentDashboard,
  useEvalBatches,
  useEvalCases,
  useRunAgentEvalBatch,
} from "../../../../../../../lib/hooks/eval";
import { formatCost } from "../../../../../../../lib/format-cost";
import { s } from "./styles";

const METRICS = [
  { key: "recall", labelKey: "dashboard.metrics.recall" },
  { key: "precision", labelKey: "dashboard.metrics.precision" },
  { key: "citation_accuracy", labelKey: "dashboard.metrics.citationAccuracy" },
] as const;

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;

const signedPct = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 100)}pt`;

export function EvalsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("eval");
  const router = useRouter();

  const cases = useEvalCases(agent.id);
  const batches = useEvalBatches(agent.id);
  const dashboard = useEvalAgentDashboard(agent.id);
  const run = useRunAgentEvalBatch(agent.id);

  // A truthy non-array satisfies `?.` and then throws on `.map`, unmounting the
  // whole tree with an error that points nowhere near the cause
  // (`client/insights.md` 2026-08-27). `Array.isArray`, never `??`.
  const caseList: EvalCase[] = Array.isArray(cases.data) ? cases.data : [];
  const batchList: EvalBatchRecord[] = Array.isArray(batches.data) ? batches.data : [];

  const [latest, previous] = batchList; // newest first
  // AC-66 — the running state is DERIVED from the polled payload, not from the
  // mutation's own pending flag: the request finished the moment it returned
  // 202, and the batch had not.
  const isRunning = batchList.some((b) => b.status === "running") || run.isPending;

  // AC-61 / AC-62 — deltas only at two or more batches.
  const deltas = previous
    ? {
        recall: delta(latest?.recall, previous.recall),
        precision: delta(latest?.precision, previous.precision),
        citation_accuracy: delta(latest?.citation_accuracy, previous.citation_accuracy),
      }
    : null;

  /**
   * AC-63 — the per-case counts, keyed by case id.
   *
   * They come from `EvalDashboard.recent_runs`, which is the ONLY producer of
   * `EvalRunRecord.expected_count` / `.actual_count`: the batch aggregate
   * carries ratios, and a ratio cannot be un-divided. A case absent from this
   * map has never run, which is AC-64's label.
   */
  const countsByCase = React.useMemo(() => {
    const runs = Array.isArray(dashboard.data?.recent_runs)
      ? dashboard.data!.recent_runs
      : [];
    const m = new Map<string, { expected: number; actual: number }>();
    for (const r of runs) {
      if (r.expected_count == null && r.actual_count == null) continue;
      m.set(r.case_id, { expected: r.expected_count ?? 0, actual: r.actual_count ?? 0 });
    }
    return m;
  }, [dashboard.data]);

  if (cases.isLoading || batches.isLoading) {
    return (
      <div style={s.wrap}>
        <Skeleton height={22} width={220} />
        <div style={{ height: 12 }} />
        <Skeleton height={90} />
      </div>
    );
  }
  if (cases.error) {
    return (
      <div style={s.wrap}>
        <ErrorState
          title={t("dashboard.loadError")}
          body={(cases.error as Error).message}
          onRetry={() => void cases.refetch()}
        />
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <div style={s.headerText}>
          <h2 style={s.h2}>{t("evalsTab.metricsTitle")}</h2>
        </div>
        <Button
          onClick={() => run.mutate()}
          disabled={isRunning || caseList.length === 0}
          aria-label={t("evalsTab.runAria")}
        >
          {isRunning
            ? t("evalsTab.running")
            : t("dashboard.runEval", { count: caseList.length })}
        </Button>
      </div>
      <p style={s.hint}>{t("evalsTab.metricsSubtitle")}</p>

      {/* WCAG 2.2 SC 4.1.3 — the batch's start and completion are announced. */}
      <div role="status" aria-live="polite" style={s.srOnly}>
        {isRunning ? t("evalsTab.runStarted") : latest ? t("evalsTab.runFinished") : ""}
      </div>

      <div style={s.tiles}>
        {METRICS.map((m) => (
          <div key={m.key} style={s.tile}>
            <div style={s.tileLabel}>{t(m.labelKey)}</div>
            <div style={s.tileValue}>{pct(latest?.[m.key])}</div>
            {deltas ? (
              <div style={s.tileDelta}>{signedPct(deltas[m.key])}</div>
            ) : null}
          </div>
        ))}
      </div>
      {!deltas ? <p style={s.hint}>{t("evalsTab.noDeltas")}</p> : null}

      <div style={s.sectionLabel}>{t("evalsTab.casesHeading")}</div>

      {caseList.length === 0 ? (
        // AC-65 — an empty state that OFFERS to create one, rather than a
        // blank panel.
        <EmptyState
          icon="Gauge"
          title={t("evalsTab.emptyCases")}
          cta={t("evalsTab.createFirst")}
          onCta={() => router.push(`/eval/agents/${agent.id}/cases/new`)}
        />
      ) : (
        <ul style={s.list}>
          {caseList.map((c) => {
            const counts = countsByCase.get(c.id) ?? null;
            return (
              <li key={c.id} style={s.row}>
                <div style={s.rowMain}>
                  {/* AC-112 — text content. No HTML sink on this path. */}
                  <div style={s.rowName}>{c.name}</div>
                  <div style={s.rowMeta}>
                    {counts
                      ? t("evalsTab.countsSummary", {
                          expected: counts.expected,
                          actual: counts.actual,
                        })
                      : t("evalsTab.neverRun")}
                  </div>
                </div>
                {/* AC-67 / UX-2 — the expectation, on every row. Without it a
                    must_not_flag case carrying a forbidden CRITICAL finding is
                    indistinguishable from a must_find case, and "expected 1,
                    got 1" reads as a pass for the opposite assertion. */}
                <Badge
                  color={
                    c.expectation === "must_not_flag" ? "var(--crit)" : "var(--accent)"
                  }
                >
                  {t(`expectation.${c.expectation}`)}
                </Badge>
                <Button
                  kind="ghost"
                  onClick={() => router.push(`/eval/agents/${agent.id}/cases/${c.id}`)}
                >
                  {t("evalsTab.edit")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <div style={s.sectionLabel}>{t("evalsTab.batchesHeading")}</div>
      {batchList.length === 0 ? (
        <p style={s.hint}>{t("dashboard.noRuns")}</p>
      ) : (
        <table style={s.batchTable}>
          <thead>
            <tr>
              <th style={s.th} scope="col">
                {t("dashboard.table.ranAt")}
              </th>
              <th style={s.th} scope="col">
                {t("dashboard.statusColumn")}
              </th>
              <th style={s.th} scope="col">
                {t("dashboard.table.recall")}
              </th>
              <th style={s.th} scope="col">
                {t("dashboard.table.precision")}
              </th>
              <th style={s.th} scope="col">
                {t("dashboard.table.citation")}
              </th>
              <th style={s.th} scope="col">
                {t("dashboard.table.pass")}
              </th>
              <th style={s.th} scope="col">
                {t("dashboard.table.cost")}
              </th>
            </tr>
          </thead>
          <tbody>
            {batchList.map((b) => (
              <tr key={b.batch_id}>
                <td style={s.td}>{new Date(b.ran_at).toLocaleString()}</td>
                <td style={s.td}>{t(`dashboard.status.${b.status}`)}</td>
                <td style={s.td}>{pct(b.recall)}</td>
                <td style={s.td}>{pct(b.precision)}</td>
                <td style={s.td}>{pct(b.citation_accuracy)}</td>
                <td style={s.td}>
                  {b.traces_passed}/{b.traces_total}
                </td>
                {/* `null` here means "not priced", never $0.00. */}
                <td style={s.td}>{formatCost(b.cost_usd, t("dashboard.costUnknown"))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function delta(a: number | null | undefined, b: number | null | undefined): number {
  return typeof a === "number" && typeof b === "number" ? a - b : 0;
}
