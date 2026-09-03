/* CompareBatches — SPEC-04 phase 2, AC-95 … AC-102.

   Two batches side by side: each metric's before / after / delta, a line diff of
   the two agent versions' system prompts, and a CONFIRMED restore of the older
   version. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Modal } from "@devdigest/ui";
import type { AgentVersion, EvalBatchRecord } from "@devdigest/shared";
import { useAgentVersions } from "../../../../../../../../lib/hooks/agents";
import { useRestoreAgentVersion } from "../../../../../../../../lib/hooks/eval";
import { diffLines, wasTruncated } from "./helpers";
import { s } from "./styles";

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;

const signed = (a: number | null, b: number | null) =>
  a === null || b === null ? "—" : `${a - b > 0 ? "+" : ""}${Math.round((a - b) * 100)}pt`;

const METRICS = [
  { key: "recall", labelKey: "dashboard.table.recall" },
  { key: "precision", labelKey: "dashboard.table.precision" },
  { key: "citation_accuracy", labelKey: "dashboard.table.citation" },
] as const;

export function CompareBatches({
  agentId,
  batches,
  onClose,
}: {
  agentId: string;
  /** Exactly two, in whatever order the table gave them. */
  batches: EvalBatchRecord[];
  onClose: () => void;
}) {
  const t = useTranslations("eval");
  const versions = useAgentVersions(agentId);
  const restore = useRestoreAgentVersion(agentId);
  const [confirming, setConfirming] = React.useState(false);

  // Oldest is "before", newest is "after" — by ran_at, not by selection order.
  const sorted = [...batches].sort((a, b) => Date.parse(a.ran_at) - Date.parse(b.ran_at));
  const before = sorted[0]!;
  const after = sorted[1]!;

  const list: AgentVersion[] = Array.isArray(versions.data) ? versions.data : [];
  const snapshotFor = (v: number | null) =>
    v === null ? undefined : list.find((x) => x.version === v);
  const beforeSnap = snapshotFor(before.agent_version);
  const afterSnap = snapshotFor(after.agent_version);

  // AC-101 — the control names the OLDER of the two versions and reads Restore.
  // "Promote v7" when v7 is already current is a no-op under rollback semantics
  // (spec D-20).
  const olderVersion = Math.min(
    before.agent_version ?? Number.POSITIVE_INFINITY,
    after.agent_version ?? Number.POSITIVE_INFINITY,
  );
  const canRestore = Number.isFinite(olderVersion);

  // AC-100 — two batches of the SAME version diff to nothing.
  const sameVersion = before.agent_version === after.agent_version;
  // AC-99 — `snapshotVersion` is `onConflictDoNothing`, so a version may
  // legitimately have no row. The metrics still render; only the diff is
  // replaced by the notice.
  const missingSnapshot = !sameVersion && (!beforeSnap || !afterSnap);

  const lines =
    sameVersion || missingSnapshot
      ? []
      : diffLines(beforeSnap!.config.system_prompt, afterSnap!.config.system_prompt);
  const truncated =
    !sameVersion && !missingSnapshot
      ? wasTruncated(beforeSnap!.config.system_prompt, afterSnap!.config.system_prompt)
      : false;

  return (
    <Modal
      width={860}
      title={t("compare.title", {
        before: new Date(before.ran_at).toISOString(),
        after: new Date(after.ran_at).toISOString(),
      })}
      onClose={onClose}
      footer={
        <div style={s.footerRow}>
          {canRestore ? (
            <Button kind="primary" onClick={() => setConfirming(true)}>
              {t("compare.restore", { version: olderVersion })}
            </Button>
          ) : null}
        </div>
      }
    >
      {/* AC-95 — before, after and delta, per metric. */}
      <table style={s.table}>
        <thead>
          <tr>
            <th style={s.th} scope="col">{" "}</th>
            <th style={s.th} scope="col">{t("compare.before")}</th>
            <th style={s.th} scope="col">{t("compare.after")}</th>
            <th style={s.th} scope="col">{t("compare.delta")}</th>
          </tr>
        </thead>
        <tbody>
          {METRICS.map((m) => (
            <tr key={m.key}>
              <th style={s.td} scope="row">{t(m.labelKey)}</th>
              <td style={s.td}>{pct(before[m.key])}</td>
              <td style={s.td}>{pct(after[m.key])}</td>
              <td style={s.td}>{signed(after[m.key], before[m.key])}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={s.sectionLabel}>{t("compare.promptDiff")}</div>
      {sameVersion ? (
        <p style={s.notice}>{t("compare.promptDiffEmpty")}</p>
      ) : missingSnapshot ? (
        <p style={s.notice}>{t("compare.snapshotUnavailable")}</p>
      ) : (
        <>
          <pre style={s.diff}>
            {lines.map((l, i) => (
              // AC-97 — added / removed / unchanged distinguishable IN THE
              // ACCESSIBILITY TREE, not by colour alone: each line carries its
              // own visually-hidden word.
              <span key={i} style={s.line(l.kind)}>
                <span style={s.srOnly}>{t(`compare.line${cap(l.kind)}`)} </span>
                {l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " "}
                {l.text}
              </span>
            ))}
          </pre>
          {truncated ? <p style={s.notice}>{t("compare.truncated")}</p> : null}
        </>
      )}

      {confirming ? (
        <Modal
          width={460}
          title={t("compare.restoreConfirmTitle", { version: olderVersion })}
          onClose={() => setConfirming(false)}
          footer={
            <div style={s.footerRow}>
              <Button onClick={() => setConfirming(false)}>
                {t("compare.restoreCancel")}
              </Button>
              <Button
                kind="primary"
                onClick={() => {
                  restore.mutate(olderVersion);
                  setConfirming(false);
                  onClose();
                }}
              >
                {t("compare.restoreConfirm")}
              </Button>
            </div>
          }
        >
          <p style={s.notice}>{t("compare.restoreConfirmBody")}</p>
        </Modal>
      ) : null}
    </Modal>
  );
}

const cap = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);
