/* SmartDiffGroups — the changed files of a PR as three collapsible sections
   (core / wiring / boilerplate). Each section keeps its own open state, seeded
   from the role: boilerplate starts shut, because "generated, ignore it" is the
   whole reason the group exists. A manual fold/unfold is remembered for the
   session (foldStore); a reveal request force-opens the section hiding its
   target and is forwarded to the file cards inside. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon } from "@devdigest/ui";
import {
  DiffViewer,
  type DiffAnnotations,
  type DiffCommentApi,
  type DiffReveal,
} from "@/components/diff-viewer";
import { ROLE_META } from "../../constants";
import { type ResolvedGroup } from "../../helpers";
import { groupFold, setGroupFold } from "../../foldStore";
import { s } from "../../styles";

function GroupSection({
  prId,
  group,
  annotations,
  commenting,
  reveal,
  onFileOpenChange,
}: {
  prId: string | null;
  group: ResolvedGroup;
  annotations: DiffAnnotations;
  commenting?: DiffCommentApi;
  reveal?: DiffReveal | null;
  onFileOpenChange?: (path: string, open: boolean) => void;
}) {
  const t = useTranslations("prReview");
  const meta = ROLE_META[group.role];
  // Role default, unless the user folded/unfolded this group earlier in the session.
  const [open, setOpen] = React.useState(groupFold(prId, group.role) ?? meta.openByDefault);
  const label = t(meta.labelKey);

  // A jump into this group must not be swallowed by a collapsed section.
  const containsReveal = !!reveal && group.files.some((f) => f.path === reveal.path);
  React.useEffect(() => {
    if (containsReveal) setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.token, containsReveal]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    setGroupFold(prId, group.role, next);
  };

  return (
    <section style={s.group}>
      <button
        type="button"
        style={s.groupHeader}
        onClick={toggle}
        aria-expanded={open}
      >
        <Icon.ChevronRight
          size={13}
          style={{
            color: "var(--text-muted)",
            transform: open ? "rotate(90deg)" : "none",
            transition: "transform .12s",
            flexShrink: 0,
          }}
        />
        <Badge icon={meta.icon} color={meta.color} bg={meta.bg}>
          {label}
        </Badge>
        <span style={s.groupHint}>{t(meta.hintKey)}</span>
        <span className="tnum" style={s.groupMeta}>
          {t("smartDiff.filesCount", { count: group.files.length })}
        </span>
        {group.findingLines > 0 && (
          <span className="tnum" style={s.groupMeta}>
            {t("smartDiff.findingLines", { count: group.findingLines })}
          </span>
        )}
      </button>
      {open && (
        <DiffViewer
          files={group.files}
          commenting={commenting}
          annotations={annotations}
          reveal={containsReveal ? reveal : null}
          onFileOpenChange={onFileOpenChange}
        />
      )}
    </section>
  );
}

export function SmartDiffGroups({
  prId,
  groups,
  annotations,
  commenting,
  reveal,
  onFileOpenChange,
}: {
  prId: string | null;
  groups: ResolvedGroup[];
  annotations: DiffAnnotations;
  commenting?: DiffCommentApi;
  reveal?: DiffReveal | null;
  onFileOpenChange?: (path: string, open: boolean) => void;
}) {
  return (
    <div style={s.groups}>
      {groups.map((group) => (
        <GroupSection
          key={group.role}
          prId={prId}
          group={group}
          annotations={annotations}
          commenting={commenting}
          reveal={reveal}
          onFileOpenChange={onFileOpenChange}
        />
      ))}
    </div>
  );
}
