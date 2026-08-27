/* SkillsTab — attach, enable/disable and reorder the skills of one agent.

   Three distinct actions, deliberately not collapsed into one:
     • ATTACH   makes a workspace skill this agent's (a row in agent_skills);
     • ENABLE   puts an attached skill's body in the prompt; disabling keeps the
                attachment and the position, so the with/without comparison is a
                single click and the trace shows the block appear and disappear;
     • REORDER  sets the order the blocks are concatenated in.

   Reordering is by arrow buttons rather than drag-and-drop: it needs no
   dependency, works from the keyboard, and is testable without simulating
   pointer events. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Checkbox, EmptyState, Icon, IconBtn, type IconName } from "@devdigest/ui";
import { Skeleton } from "@devdigest/ui";
import type { Agent, AgentSkillDetail } from "@devdigest/shared";
import {
  useAgentSkills,
  useSetAgentSkills,
  useToggleAgentSkill,
  useUnlinkAgentSkill,
  useSkills,
} from "../../../../../../../lib/hooks/skills";
import { moveItem, toLinkPayload, typeColor } from "./helpers";
import { s } from "./styles";

/**
 * A disabled-capable icon button. The kit's `IconBtn` has no `disabled` prop, so
 * rather than change a shared primitive for one caller, this row-local button
 * keeps the disabled state real (the element is genuinely disabled, not just
 * dimmed) for the top and bottom rows.
 *
 * NOTE, corrected: an earlier version of this comment claimed `src/vendor/ui` is
 * "mirrored rather than authored here". That is true of `src/vendor/shared`,
 * which is a one-directional copy of the server's contracts pinned by
 * `scripts/check-contracts.sh` — but NOT of `src/vendor/ui`, which has no
 * upstream anywhere in this repository. `client/AGENTS.md` calls it "the in-repo
 * design system" and its own README asks you to update the showcase when you
 * change a component. Editing the kit is therefore a decision about scope, not
 * a forbidden edit to a mirror.
 */
function ReorderButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const I = Icon[icon];
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      style={s.reorderBtn(!!disabled)}
    >
      <I size={13} />
    </button>
  );
}

export function SkillsTab({ agent }: { agent: Agent }) {
  const t = useTranslations("agents");
  const { data: links, isLoading } = useAgentSkills(agent.id);
  const { data: allSkills } = useSkills();
  const setSkills = useSetAgentSkills(agent.id);
  const toggle = useToggleAgentSkill(agent.id);
  const unlink = useUnlinkAgentSkill(agent.id);

  const linked: AgentSkillDetail[] = links ?? [];
  const linkedIds = new Set(linked.map((l) => l.skill_id));
  const available = (allSkills ?? []).filter((sk) => !linkedIds.has(sk.id));
  const enabledCount = linked.filter((l) => l.enabled).length;

  const reorder = (from: number, to: number) =>
    setSkills.mutate(toLinkPayload(moveItem(linked, from, to)));

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <h2 style={s.h2}>{t("skills.title")}</h2>
        <Badge color="var(--accent)">
          {t("skills.enabledCount", { linked: enabledCount, total: linked.length })}
        </Badge>
      </div>
      <p style={s.hint}>{t("skills.orderHint")}</p>

      {isLoading && (
        <div style={s.list}>
          <Skeleton height={46} />
          <Skeleton height={46} />
        </div>
      )}

      {!isLoading && linked.length === 0 && (
        <EmptyState
          icon="Sparkles"
          title={t("skills.emptyTitle")}
          body={t("skills.emptyBody")}
        />
      )}

      {linked.length > 0 && (
        <ul style={s.list}>
          {linked.map((link, idx) => (
            <li key={link.skill_id} style={s.row(link.enabled)}>
              <div style={s.reorder}>
                <ReorderButton
                  icon="ArrowUp"
                  label={t("skills.moveUp", { name: link.skill.name })}
                  disabled={idx === 0 || setSkills.isPending}
                  onClick={() => reorder(idx, idx - 1)}
                />
                <ReorderButton
                  icon="ArrowDown"
                  label={t("skills.moveDown", { name: link.skill.name })}
                  disabled={idx === linked.length - 1 || setSkills.isPending}
                  onClick={() => reorder(idx, idx + 1)}
                />
              </div>

              <Checkbox
                checked={link.enabled}
                onChange={(enabled) => toggle.mutate({ skillId: link.skill_id, enabled })}
                label={
                  <span className="mono" style={s.name}>
                    {link.skill.name}
                  </span>
                }
              />

              {/* A skill switched off globally cannot reach any prompt, however
                  this link is set — say so rather than showing a checked box
                  that does nothing. */}
              {!link.skill.enabled && (
                <Badge color="var(--text-muted)">{t("skills.globallyDisabled")}</Badge>
              )}

              <div style={s.rowRight}>
                <Badge color={typeColor(link.skill)}>{link.skill.type}</Badge>
                <IconBtn
                  icon="X"
                  label={t("skills.detach", { name: link.skill.name })}
                  onClick={() => !unlink.isPending && unlink.mutate(link.skill_id)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      <div style={s.availableHead}>
        <Icon.Plus size={13} style={{ color: "var(--text-muted)" }} />
        <span>{t("skills.availableTitle")}</span>
      </div>
      {available.length === 0 ? (
        <p style={s.availableEmpty}>{t("skills.availableEmpty")}</p>
      ) : (
        <div style={s.availableList}>
          {available.map((sk) => (
            <Button
              key={sk.id}
              kind="secondary"
              size="sm"
              icon="Plus"
              disabled={setSkills.isPending}
              onClick={() =>
                setSkills.mutate([...toLinkPayload(linked), { skill_id: sk.id, enabled: true }])
              }
            >
              {sk.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
