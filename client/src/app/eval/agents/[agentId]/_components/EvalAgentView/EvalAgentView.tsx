/* /eval/agents/[agentId] — one agent's evals (SPEC-04 AC-73 … AC-75, AC-93 … AC-102).

   Metric tiles, the ordinal-axis trend, the deterministic regression banner and
   the recent-batches table, plus phase 2's two-batch compare.

   THE BANNER IS COMPOSED HERE (plan D-14). The API returns `alert_metric` and
   `alert_delta` and nothing else; the sentence comes from `eval.json`. With only
   a metric name and a number crossing the wire, the banner has nowhere to put a
   causal clause the code cannot justify — "a new false positive slipped in" is
   an inference code cannot make (spec D-31, UX-3). */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Checkbox, ErrorState, Skeleton } from "@devdigest/ui";
import type { EvalBatchRecord } from "@devdigest/shared";
import { AppShell } from "../../../../../../components/app-shell";
import { useEvalAgentDashboard } from "../../../../../../lib/hooks/eval";
import { formatCost } from "../../../../../../lib/format-cost";
import { MetricTrend, type MetricTrendPoint } from "../../../../_components/MetricTrend";
import { CompareBatches } from "./_components/CompareBatches";
import { s } from "./styles";

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;

const METRICS = [
  { key: "recall", labelKey: "dashboard.metrics.recall" },
  { key: "precision", labelKey: "dashboard.metrics.precision" },
  { key: "citation_accuracy", labelKey: "dashboard.metrics.citationAccuracy" },
] as const;

export function EvalAgentView({ agentId }: { agentId: string }) {
  const t = useTranslations("eval");
  const router = useRouter();
  const dash = useEvalAgentDashboard(agentId);

  const batches: EvalBatchRecord[] = Array.isArray(dash.data?.batches)
    ? dash.data!.batches
    : [];
  const latest = batches[0];

  // AC-93 / AC-94 — Compare is enabled at EXACTLY two selections.
  const [selected, setSelected] = React.useState<string[]>([]);
  const [comparing, setComparing] = React.useState(false);
  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const crumb = [
    { label: t("page.crumbSkillsLab") },
    { label: t("page.crumbEvalDashboard") },
    { label: dash.data?.agent_name ?? t("page.crumbEvals") },
  ];

  if (dash.isLoading) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.page}>
          <Skeleton height={26} width={260} />
          <div style={{ height: 16 }} />
          <Skeleton height={140} />
        </div>
      </AppShell>
    );
  }
  if (dash.isError) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.page}>
          <ErrorState
            title={t("agentPage.loadError")}
            body={(dash.error as Error)?.message}
            onRetry={() => void dash.refetch()}
          />
        </div>
      </AppShell>
    );
  }

  // Oldest first — ordinal 1 is the left-most point of the trend (AC-75).
  const points: MetricTrendPoint[] = [...batches]
    .reverse()
    .map((b) => ({
      recall: b.recall,
      precision: b.precision,
      citationAccuracy: b.citation_accuracy,
    }));

  const alertMetric = dash.data?.alert_metric ?? null;
  const alertDelta = dash.data?.alert_delta ?? null;

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>
        <div style={s.header}>
          <div style={s.headerText}>
            <h1 style={s.h1}>
              {t("agentPage.title", { name: dash.data?.agent_name ?? "" })}
            </h1>
            <button type="button" style={s.back} onClick={() => router.push("/eval")}>
              {t("agentPage.back")}
            </button>
          </div>
        </div>

        {alertMetric !== null && alertDelta !== null ? (
          <div style={s.alert} role="status">
            <span style={s.alertLabel}>{t("agentPage.alertLabel")}</span>
            <span>
              {t("agentPage.alert", {
                metric: alertMetric,
                delta: `${Math.round(alertDelta * 100)}pt`,
              })}
            </span>
          </div>
        ) : null}

        <div style={s.tiles}>
          {METRICS.map((m) => (
            <div key={m.key} style={s.tile}>
              <div style={s.tileLabel}>{t(m.labelKey)}</div>
              <div style={s.tileValue}>{pct(latest?.[m.key])}</div>
            </div>
          ))}
        </div>

        <div style={s.sectionLabel}>{t("agentPage.trendTitle")}</div>
        <div style={s.chartCard}>
          <MetricTrend points={points} />
        </div>

        <div style={s.sectionLabel}>{t("dashboard.batchesHeading")}</div>
        <div style={s.compareBar}>
          <Button
            kind="secondary"
            disabled={selected.length !== 2}
            onClick={() => setComparing(true)}
          >
            {t("agentPage.compare")}
          </Button>
          <span style={s.hint}>{t("agentPage.compareHint")}</span>
        </div>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th} scope="col">
                {t("agentPage.compare")}
              </th>
              <th style={s.th} scope="col">{t("dashboard.table.ranAt")}</th>
              <th style={s.th} scope="col">{t("dashboard.versionColumn")}</th>
              <th style={s.th} scope="col">{t("dashboard.statusColumn")}</th>
              <th style={s.th} scope="col">{t("dashboard.table.recall")}</th>
              <th style={s.th} scope="col">{t("dashboard.table.precision")}</th>
              <th style={s.th} scope="col">{t("dashboard.table.citation")}</th>
              <th style={s.th} scope="col">{t("dashboard.table.pass")}</th>
              <th style={s.th} scope="col">{t("dashboard.table.cost")}</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b, i) => (
              <tr key={b.batch_id}>
                <td style={s.td}>
                  <Checkbox
                    checked={selected.includes(b.batch_id)}
                    onChange={() => toggle(b.batch_id)}
                    label={t("agentPage.batchOrdinal", { ordinal: batches.length - i })}
                  />
                </td>
                <td style={s.td}>{new Date(b.ran_at).toISOString()}</td>
                <td style={s.td}>{b.agent_version === null ? "—" : `v${b.agent_version}`}</td>
                <td style={s.td}>{t(`dashboard.status.${b.status}`)}</td>
                <td style={s.td}>{pct(b.recall)}</td>
                <td style={s.td}>{pct(b.precision)}</td>
                <td style={s.td}>{pct(b.citation_accuracy)}</td>
                <td style={s.td}>
                  {b.traces_passed}/{b.traces_total}
                </td>
                <td style={s.td}>{formatCost(b.cost_usd, t("dashboard.costUnknown"))}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {comparing && selected.length === 2 ? (
          <CompareBatches
            agentId={agentId}
            batches={batches.filter((b) => selected.includes(b.batch_id))}
            onClose={() => setComparing(false)}
          />
        ) : null}
      </div>
    </AppShell>
  );
}
