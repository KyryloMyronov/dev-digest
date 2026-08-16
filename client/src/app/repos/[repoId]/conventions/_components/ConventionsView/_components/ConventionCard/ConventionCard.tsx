/* One derived convention, awaiting review: the rule, the evidence behind it, how
   confident the extractor was, and Accept / Reject.

   Dumb by design — no hooks, no mutations. Every action is raised to
   ConventionsView, which owns the mutations and the modal. The card is not
   clickable as a whole, so there is no row-level navigation for a nested control
   to fight with. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, IconBtn, ProgressBar, TextInput } from "@devdigest/ui";
import type { ConventionCandidate } from "@devdigest/shared";
import { EvidenceBlock } from "../EvidenceBlock";
import { CONFIDENCE_BAR_WIDTH } from "../../constants";
import { confidenceColor, confidencePct } from "../../helpers";
import { card } from "../../styles";

export function ConventionCard({
  candidate,
  busy,
  onAccept,
  onReject,
  onEditRule,
}: {
  candidate: ConventionCandidate;
  busy?: boolean;
  onAccept: () => void;
  onReject: () => void;
  onEditRule: (rule: string) => void;
}) {
  const t = useTranslations("conventions");
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(candidate.rule);

  const accepted = candidate.status === "accepted";
  const rejected = candidate.status === "rejected";
  const pct = confidencePct(candidate.confidence);

  const startEdit = () => {
    // Seed from the LIVE rule each time, not once at mount: a re-scan or another
    // edit can have replaced the text since this card first rendered.
    setDraft(candidate.rule);
    setEditing(true);
  };

  const save = () => {
    const next = draft.trim();
    if (next && next !== candidate.rule) onEditRule(next);
    setEditing(false);
  };

  return (
    <div style={card.root(candidate.status)}>
      <div style={card.body}>
        {editing ? (
          <div>
            <TextInput
              value={draft}
              onChange={setDraft}
              placeholder={t("card.rulePlaceholder")}
              aria-label={t("card.ruleLabel")}
            />
            <div style={card.editActions}>
              <Button kind="primary" size="sm" onClick={save} disabled={!draft.trim()}>
                {t("card.saveEdit")}
              </Button>
              <Button kind="ghost" size="sm" onClick={() => setEditing(false)}>
                {t("card.cancelEdit")}
              </Button>
            </div>
          </div>
        ) : (
          <div style={card.ruleRow}>
            <div style={card.rule}>{candidate.rule}</div>
            <IconBtn icon="Edit" label={t("card.edit")} size={26} onClick={startEdit} />
          </div>
        )}

        {candidate.evidence_path && (
          <EvidenceBlock
            path={candidate.evidence_path}
            code={candidate.evidence_snippet ?? ""}
          />
        )}

        {pct !== null && (
          <div style={card.footer}>
            <span style={card.footerLabel}>{t("card.confidence")}</span>
            <div style={{ width: CONFIDENCE_BAR_WIDTH }}>
              <ProgressBar value={pct} color={confidenceColor(pct)} height={5} />
            </div>
            <span className="mono tnum" style={card.footerPct}>
              {pct}%
            </span>
          </div>
        )}
      </div>

      <div style={card.actions}>
        <Button
          kind={accepted ? "primary" : "secondary"}
          size="sm"
          full
          loading={busy}
          {...(accepted ? { icon: "Check" as const } : {})}
          onClick={onAccept}
        >
          {accepted ? t("card.accepted") : t("card.accept")}
        </Button>
        <Button
          kind={rejected ? "danger" : "secondary"}
          size="sm"
          full
          icon="X"
          loading={busy}
          onClick={onReject}
        >
          {rejected ? t("card.rejected") : t("card.reject")}
        </Button>
      </div>
    </div>
  );
}
