/* SkillPreview — the panel that opens beside the grid when a skill is picked.
   Read-only: it shows the exact text that goes into an agent's prompt, plus who
   links it. Editing happens in SkillEditorModal. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Icon, IconBtn, Markdown } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { useSkillAgents } from "../../../../../../lib/hooks/skills";
import { isImported, typeColor } from "../../helpers";
import { p } from "./styles";

export function SkillPreview({
  skill,
  onClose,
  onEdit,
  onDelete,
  deleting,
}: {
  skill: Skill;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  deleting?: boolean;
}) {
  const t = useTranslations("skills");
  const { data: agents } = useSkillAgents(skill.id);

  return (
    <>
      <div style={p.header}>
        <Icon.Sparkles size={16} style={{ color: typeColor(skill) }} />
        <div style={p.title} title={skill.name}>
          {skill.name}
        </div>
        <IconBtn icon="X" label={t("preview.close")} onClick={onClose} />
      </div>

      <div style={p.body}>
        <div style={p.badges}>
          <Badge color={typeColor(skill)}>{t(`listItem.type.${skill.type}`)}</Badge>
          <Badge color="var(--text-secondary)">{t(`listItem.source.${skill.source}`)}</Badge>
          <Badge color="var(--text-muted)" mono>
            {t("preview.version", { version: skill.version })}
          </Badge>
          {!skill.enabled && <Badge color="var(--text-muted)">{t("preview.disabled")}</Badge>}
        </div>

        {isImported(skill) && (
          <div style={p.trustNotice}>
            <Icon.AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0 }} />
            <span>{t("preview.importedNotice")}</span>
          </div>
        )}

        <div style={p.sectionLabel}>{t("preview.descriptionLabel")}</div>
        <div style={p.description}>
          {skill.description || t("preview.noDescription")}
        </div>

        <div style={p.sectionLabel}>{t("preview.usedByLabel")}</div>
        <div style={p.usedBy}>
          {agents === undefined
            ? t("preview.usedByLoading")
            : agents.length === 0
              ? t("preview.usedByNone")
              : agents.join(", ")}
        </div>

        <div style={p.sectionLabel}>{t("preview.bodyLabel")}</div>
        <div style={p.markdown}>
          <Markdown>{skill.body}</Markdown>
        </div>
      </div>

      <div style={p.footer}>
        <Button kind="secondary" size="sm" icon="Edit" onClick={onEdit}>
          {t("preview.edit")}
        </Button>
        <Button
          kind="ghost"
          size="sm"
          icon="Trash"
          disabled={deleting}
          onClick={() => {
            const used = agents ?? [];
            const warning = used.length
              ? t("delete.confirmLinked", { name: skill.name, agents: used.join(", ") })
              : t("delete.confirm", { name: skill.name });
            if (window.confirm(warning)) onDelete();
          }}
        >
          {t("preview.delete")}
        </Button>
      </div>
    </>
  );
}
