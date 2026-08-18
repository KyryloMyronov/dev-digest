/* SplitSuggestion — the "this PR is large" banner above the grouped diff, with
   the areas the server proposes cutting it into. Renders nothing for a PR that
   is a reasonable size, and nothing more than the headline when the change is
   large but confined to one area (there is no honest cut to propose). */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import type { SmartDiff } from "@/lib/types";
import { s } from "../../styles";

export function SplitSuggestion({ suggestion }: { suggestion: SmartDiff["split_suggestion"] }) {
  const t = useTranslations("prReview");
  if (!suggestion.too_big) return null;

  return (
    <div style={s.splitCard} role="note">
      <div style={s.splitTitle}>
        <Icon.AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0 }} />
        {t("smartDiff.largeTitle", { lines: suggestion.total_lines })}
      </div>
      {suggestion.proposed_splits.length > 0 && (
        <>
          <div style={s.splitBody}>{t("smartDiff.largeBody")}</div>
          <ul style={s.splitList}>
            {suggestion.proposed_splits.map((split) => (
              <li key={split.name} style={s.splitRow}>
                <span className="mono" style={{ color: "var(--text-primary)" }}>
                  {split.name}
                </span>
                <span>{t("smartDiff.filesCount", { count: split.files.length })}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
