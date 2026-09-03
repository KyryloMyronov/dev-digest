/* /eval — the workspace Eval Dashboard (SPEC-04 AC-69 … AC-72, AC-108).

   One row per agent, ranked by its latest batch, plus the workspace's 50 newest
   batches newest-first. "Run all agents" is COSTED: the estimate is read before
   the confirmation, and no request is issued until the confirmation is
   accepted — that, not the dialog's presence, is AC-72. */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, EmptyState, ErrorState, Modal, Skeleton } from "@devdigest/ui";
import type { EvalBatchRecord, EvalDashboardAgentRow } from "@devdigest/shared";
import { AppShell } from "../../../../components/app-shell";
import {
  useEvalEstimate,
  useEvalWorkspaceDashboard,
  useRunWorkspaceEval,
} from "../../../../lib/hooks/eval";
import { formatCost } from "../../../../lib/format-cost";
import { s } from "./styles";

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;

export function EvalDashboardView() {
  const t = useTranslations("eval");
  const router = useRouter();

  const dash = useEvalWorkspaceDashboard();
  const [confirming, setConfirming] = React.useState(false);
  // The estimate is only fetched when the confirmation is being composed —
  // there is nothing to show it on before that.
  const estimate = useEvalEstimate(confirming);
  const runAll = useRunWorkspaceEval();

  const agents: EvalDashboardAgentRow[] = Array.isArray(dash.data?.agents)
    ? dash.data!.agents
    : [];
  const batches: EvalBatchRecord[] = Array.isArray(dash.data?.batches)
    ? dash.data!.batches
    : [];

  const crumb = [
    { label: t("page.crumbSkillsLab") },
    { label: t("page.crumbEvalDashboard") },
  ];

  if (dash.isLoading) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.page}>
          <Skeleton height={28} width={280} />
          <div style={{ height: 16 }} />
          <Skeleton height={160} />
        </div>
      </AppShell>
    );
  }

  if (dash.isError) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.page}>
          <ErrorState
            title={t("dashboard.loadError")}
            body={(dash.error as Error)?.message}
            onRetry={() => void dash.refetch()}
          />
        </div>
      </AppShell>
    );
  }

  // AC-70 — one empty state covers BOTH "no agents at all" and "agents but no
  // eval case": in either case there is nothing to measure, and the way out of
  // both is the agent editor.
  const isEmpty = (dash.data?.cases_total ?? 0) === 0;

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>
        <div style={s.header}>
          <div style={s.headerText}>
            <h1 style={s.h1}>{t("dashboard.workspaceTitle")}</h1>
            <p style={s.subtitle}>{t("dashboard.workspaceSubtitle")}</p>
          </div>
          {!isEmpty ? (
            <Button kind="primary" onClick={() => setConfirming(true)}>
              {t("dashboard.runAll")}
            </Button>
          ) : null}
        </div>

        {isEmpty ? (
          <EmptyState
            icon="Gauge"
            title={t("dashboard.empty")}
            cta={t("dashboard.emptyCta")}
            onCta={() => router.push("/agents")}
          />
        ) : (
          <>
            <div style={s.sectionLabel}>{t("dashboard.agentsHeading")}</div>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th} scope="col">{t("dashboard.agentColumn")}</th>
                  <th style={s.th} scope="col">{t("dashboard.casesColumn")}</th>
                  <th style={s.th} scope="col">{t("dashboard.table.recall")}</th>
                  <th style={s.th} scope="col">{t("dashboard.table.precision")}</th>
                  <th style={s.th} scope="col">{t("dashboard.table.citation")}</th>
                  <th style={s.th} scope="col">{t("dashboard.table.pass")}</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.agent_id}>
                    <td style={s.td}>
                      <button
                        type="button"
                        style={s.agentLink}
                        onClick={() => router.push(`/eval/agents/${a.agent_id}`)}
                      >
                        {a.agent_name}
                      </button>
                      {!a.enabled ? (
                        <span style={s.disabledTag}>{t("dashboard.agentDisabled")}</span>
                      ) : null}
                    </td>
                    <td style={s.td}>
                      {t("dashboard.caseCount", { count: a.cases_total })}
                    </td>
                    {/* Spec D-5 — an agent with cases and no batch renders its
                        case count and NO metrics. Nulls, never zeroes: it has
                        not scored 0, it has not run. */}
                    <td style={s.td}>{pct(a.recall)}</td>
                    <td style={s.td}>{pct(a.precision)}</td>
                    <td style={s.td}>{pct(a.citation_accuracy)}</td>
                    <td style={s.td}>
                      {a.latest_batch_id === null
                        ? t("dashboard.neverRun")
                        : `${a.traces_passed ?? 0}/${a.traces_total ?? 0}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* AC-71 / AC-108 — the workspace's newest batches, newest first,
                exactly as the API ordered them. The studio does not re-sort. */}
            <div style={s.sectionLabel}>{t("dashboard.batchesHeading")}</div>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th} scope="col">{t("dashboard.agentColumn")}</th>
                  <th style={s.th} scope="col">{t("dashboard.versionColumn")}</th>
                  <th style={s.th} scope="col">{t("dashboard.table.ranAt")}</th>
                  <th style={s.th} scope="col">{t("dashboard.statusColumn")}</th>
                  <th style={s.th} scope="col">{t("dashboard.triggerColumn")}</th>
                  <th style={s.th} scope="col">{t("dashboard.table.pass")}</th>
                  <th style={s.th} scope="col">{t("dashboard.table.cost")}</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.batch_id}>
                    <td style={s.td}>{b.agent_name ?? "—"}</td>
                    <td style={s.td}>{b.agent_version === null ? "—" : `v${b.agent_version}`}</td>
                    <td style={s.td}>{new Date(b.ran_at).toISOString()}</td>
                    <td style={s.td}>{t(`dashboard.status.${b.status}`)}</td>
                    <td style={s.td}>
                      {b.trigger === null ? "—" : t(`dashboard.trigger.${b.trigger}`)}
                    </td>
                    <td style={s.td}>
                      {b.traces_passed}/{b.traces_total}
                    </td>
                    <td style={s.td}>
                      {formatCost(b.cost_usd, t("dashboard.costUnknown"))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {confirming ? (
          <Modal
            width={520}
            title={t("dashboard.runAllConfirmTitle")}
            onClose={() => setConfirming(false)}
            footer={
              <div style={s.confirmRow}>
                <Button onClick={() => setConfirming(false)}>
                  {t("dashboard.runAllCancel")}
                </Button>
                <Button
                  kind="primary"
                  onClick={() => {
                    runAll.mutate();
                    setConfirming(false);
                  }}
                >
                  {t("dashboard.runAllConfirm")}
                </Button>
              </div>
            }
          >
            <p style={s.confirmBody}>
              {t("dashboard.runAllConfirmBody", {
                agents: estimate.data?.agents ?? 0,
                cases: estimate.data?.cases ?? 0,
                // `null` here means "no priced batch to extrapolate from", NOT
                // $0.00 — the placeholder is the call site's to choose.
                cost: formatCost(estimate.data?.est_cost_usd, t("dashboard.costUnknown")),
              })}
            </p>
          </Modal>
        ) : null}
      </div>
    </AppShell>
  );
}
