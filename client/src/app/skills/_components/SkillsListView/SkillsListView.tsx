/* /skills — the skill library. A grid of cards; clicking one opens a preview
   beside it. "Add" either creates a skill from scratch or imports one from a
   file. A skill lives here once and is reused by any number of agents — the
   Agent Editor's Skills tab is where it gets attached. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, Dropdown, EmptyState, ErrorState, Icon, Skeleton } from "@devdigest/ui";
import type { Skill } from "@devdigest/shared";
import { AppShell } from "../../../../components/app-shell";
import { useDeleteSkill, useSkills, useUpdateSkill } from "../../../../lib/hooks/skills";
import { SkillCard } from "./_components/SkillCard";
import { SkillPreview } from "./_components/SkillPreview";
import { SkillEditorModal, type SkillDraft } from "./_components/SkillEditorModal";
import { ImportSkillModal } from "./_components/ImportSkillModal";
import { filterSkills } from "./helpers";
import { s } from "./styles";

/** Which overlay is open. Only one at a time — import hands off to the editor. */
type Overlay =
  | { kind: "none" }
  | { kind: "create"; draft?: SkillDraft }
  | { kind: "edit"; skill: Skill }
  | { kind: "import" };

export function SkillsListView() {
  const t = useTranslations("skills");
  const { data: skills, isLoading, isError, refetch } = useSkills();
  const update = useUpdateSkill();
  const del = useDeleteSkill();

  const [search, setSearch] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [overlay, setOverlay] = React.useState<Overlay>({ kind: "none" });

  const list = filterSkills(skills ?? [], search);
  // Resolve the selection against the LIVE list rather than holding the object:
  // a toggle or an edit replaces the row, and a held copy would show stale text
  // in the preview until the panel was closed and reopened.
  const selected = skills?.find((sk) => sk.id === selectedId) ?? null;

  const close = () => setOverlay({ kind: "none" });

  return (
    <AppShell crumb={[{ label: t("page.crumbLab") }, { label: t("page.crumbSkills") }]}>
      {overlay.kind === "import" && (
        <ImportSkillModal
          onClose={close}
          // The import never saves directly — it fills the editor, so an
          // imported skill goes through the same review-and-confirm as one
          // typed by hand.
          onAccept={(draft) => setOverlay({ kind: "create", draft })}
        />
      )}
      {overlay.kind === "create" && (
        <SkillEditorModal
          draft={overlay.draft}
          onClose={close}
          onSaved={(sk) => setSelectedId(sk.id)}
        />
      )}
      {overlay.kind === "edit" && <SkillEditorModal skill={overlay.skill} onClose={close} />}

      <div style={s.page}>
        <div style={s.main}>
          <div style={s.header}>
            <div style={s.headerText}>
              <h1 style={s.h1}>{t("page.heading")}</h1>
              <p style={s.subtitle}>{t("page.subtitle")}</p>
            </div>
            <div style={s.search}>
              <Icon.Search size={13} style={s.searchIcon} />
              <input
                value={search}
                onChange={(ev) => setSearch(ev.target.value)}
                placeholder={t("page.searchPlaceholder")}
                aria-label={t("page.searchPlaceholder")}
                style={s.searchInput}
              />
            </div>
            <Dropdown
              width={220}
              align="right"
              trigger={
                <Button kind="primary" size="sm" icon="Plus" iconRight="ChevronDown">
                  {t("page.addSkill")}
                </Button>
              }
              items={[
                {
                  label: t("page.menu.create"),
                  icon: "Edit",
                  onClick: () => setOverlay({ kind: "create" }),
                },
                {
                  label: t("page.menu.fromFile"),
                  icon: "Upload",
                  onClick: () => setOverlay({ kind: "import" }),
                },
              ]}
            />
          </div>

          {isLoading && (
            <div style={s.grid}>
              <Skeleton height={130} />
              <Skeleton height={130} />
              <Skeleton height={130} />
            </div>
          )}
          {isError && <ErrorState body={t("page.loadError")} onRetry={() => refetch()} />}
          {!isLoading && !isError && list.length === 0 && (
            <EmptyState
              icon="Sparkles"
              title={t("page.empty.title")}
              body={t("page.empty.body")}
              cta={t("page.empty.cta")}
              onCta={() => setOverlay({ kind: "create" })}
            />
          )}
          {list.length > 0 && (
            <div style={s.grid}>
              {list.map((sk) => (
                <SkillCard
                  key={sk.id}
                  skill={sk}
                  active={sk.id === selectedId}
                  onClick={() => setSelectedId(sk.id === selectedId ? null : sk.id)}
                  onToggle={(enabled) => update.mutate({ id: sk.id, patch: { enabled } })}
                />
              ))}
            </div>
          )}
        </div>

        {selected && (
          // Named: the app shell's sidebar is also a complementary landmark, so
          // an unnamed one here is ambiguous to a screen reader and to a test.
          <aside style={s.aside} aria-label={t("preview.panelLabel")}>
            <SkillPreview
              skill={selected}
              deleting={del.isPending}
              onClose={() => setSelectedId(null)}
              onEdit={() => setOverlay({ kind: "edit", skill: selected })}
              onDelete={() =>
                del.mutate(selected.id, { onSuccess: () => setSelectedId(null) })
              }
            />
          </aside>
        )}
      </div>
    </AppShell>
  );
}
