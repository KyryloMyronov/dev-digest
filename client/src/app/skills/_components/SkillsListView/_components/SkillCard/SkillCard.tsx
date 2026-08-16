/* SkillCard — one skill in the library grid: name, type, description, and the
   global enabled toggle. Clicking opens the preview panel beside the grid. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon, Toggle } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { isImported, typeColor } from "../../helpers";
import { card } from "../../styles";

export function SkillCard({
  skill,
  active,
  onClick,
  onToggle,
}: {
  skill: Skill;
  active?: boolean;
  onClick?: () => void;
  onToggle?: (enabled: boolean) => void;
}) {
  const t = useTranslations("skills");
  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      aria-pressed={!!active}
      style={card.root(!!active, skill.enabled)}
    >
      <div style={card.headerRow}>
        <Icon.Sparkles size={15} style={{ color: typeColor(skill), flexShrink: 0 }} />
        <span style={card.name} title={skill.name}>
          {skill.name}
        </span>
        {onToggle && (
          // Stop propagation: the toggle sits inside a clickable card, and a
          // flip must not also open the preview.
          <div onClick={(e) => e.stopPropagation()}>
            <Toggle on={skill.enabled} onChange={onToggle} size={14} />
          </div>
        )}
      </div>

      <div style={card.description}>
        {skill.description || t("card.noDescription")}
      </div>

      <div style={card.metaRow}>
        <Badge color={typeColor(skill)}>{t(`listItem.type.${skill.type}`)}</Badge>
        {isImported(skill) && (
          <Badge color="var(--warn)" icon="Upload">
            {t("card.imported")}
          </Badge>
        )}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>
          {t("preview.version", { version: skill.version })}
        </span>
      </div>
    </div>
  );
}
