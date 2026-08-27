/* SkillContextField — the skill editor's project-context surface (SPEC-01,
   AC-20's UI plus AC-31 and AC-32).

   Attached here, INHERITED there: every agent that uses this skill also injects
   these documents, after its own attachments. That is why this surface exists at
   all — a security skill can carry the specs it reasons about instead of every
   agent re-attaching them.

   TRUST, which is not negotiable by this surface: a skill BODY enters the prompt
   un-fenced, as instructions. A document attached to a skill does NOT inherit
   that treatment — it is repository content and is fenced as untrusted data in
   the same single `## Project context` block as an agent's own documents. One
   trust story, one code path.

   Strings come from `messages/en/skills.json` (`skills.context.*`), NOT from the
   Project Context page's catalogue: a screen owns its own messages, and reading
   `context` here made the skill modal throw MISSING_MESSAGE in any test (or
   future provider) that scopes messages to this screen. Same reason the shared
   token cells take their labels as props.

   Scope, stated because the mock suggests otherwise: this is the modal AS IT
   EXISTS. SPEC-01's Non-goals rule out converting the skill editor into a routed
   full-page editor with Preview/Evals/Stats/Versions tabs, and the mock's
   "SERIALIZES AS" panel is wrong as drawn (it shows `## Project specifications`
   and a bare path list; the engine emits `## Project context` with full bodies),
   so no serialized preview is rendered here. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Icon, IconBtn, Skeleton, TextInput } from "@devdigest/ui";
import { useActiveRepo } from "@/lib/repo-context";
import {
  useAttachSkillContextDoc,
  useContextFiles,
  useDetachSkillContextDoc,
  useSkillContextDocs,
} from "@/lib/hooks/project-context";
import { TokenCount, TokenTotal } from "@/components/context-tokens";
import { c } from "./styles";

export function SkillContextField({ skillId }: { skillId: string }) {
  const t = useTranslations("skills");
  const { repoId } = useActiveRepo();

  const list = useContextFiles(repoId);
  const attachments = useSkillContextDocs(skillId, repoId);
  const attach = useAttachSkillContextDoc(skillId, repoId);
  const detach = useDetachSkillContextDoc(skillId, repoId);

  const [query, setQuery] = React.useState("");

  // Array-guarded rather than `?? []`: an unexpected payload is truthy and not
  // iterable, and a throw here unmounts the whole modal (which is exactly how
  // this surface first broke `SkillsListView`'s pre-existing editor test). The
  // hooks normalise as well — this is the render-boundary half of that.
  const attached = Array.isArray(attachments.data) ? attachments.data : [];
  const discoveredFiles = list.data?.files;
  const discovered = Array.isArray(discoveredFiles) ? discoveredFiles : [];
  const attachedPaths = new Set(attached.map((r) => r.path));

  const match = (path: string) =>
    query.trim() === "" || path.toLowerCase().includes(query.trim().toLowerCase());

  const available = discovered.filter((d) => !attachedPaths.has(d.path) && match(d.path));
  const visibleAttached = attached.filter((r) => match(r.path));

  // AC-32 — attached documents only. A `null` count contributes nothing and is
  // reported separately rather than being treated as zero.
  const tokens = attached.reduce((n, r) => n + (r.doc?.tokens ?? 0), 0);
  const pendingCount = attached.filter((r) => r.doc?.tokens == null).length;

  // AC-25's shape, per row rather than per surface.
  const attachingPath = attach.isPending ? attach.variables : null;
  const error = attach.error ?? detach.error;

  if (attachments.isLoading) return <Skeleton height={44} />;

  if (discovered.length === 0 && attached.length === 0) {
    return <p style={c.empty}>{t("context.emptyBody")}</p>;
  }

  return (
    <div style={c.wrap}>
      <TextInput
        value={query}
        onChange={setQuery}
        placeholder={t("context.filterPlaceholder")}
        aria-label={t("context.filterLabel")}
      />

      {attached.length === 0 && <p style={c.empty}>{t("context.noneAttached")}</p>}

      {visibleAttached.length > 0 && (
        <ul style={c.list} aria-label={t("context.attachedTitle")}>
          {visibleAttached.map((row) => (
            <li key={row.path} style={c.row(row.doc == null)}>
              <span className="mono" style={c.path} title={row.path}>
                {row.path}
              </span>
              {row.doc == null && <Badge color="var(--crit)">{t("context.unresolved")}</Badge>}
              <span style={c.right}>
                <TokenCount
                  tokens={row.doc?.tokens ?? null}
                  format={(count) => t("context.tokens", { count })}
                  pendingLabel={t("context.tokensPending")}
                />
                <IconBtn
                  icon="X"
                  label={t("context.detach", { path: row.path })}
                  onClick={() => detach.mutate(row.path)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}

      {available.length > 0 && (
        <>
          <div style={c.sectionHead}>
            <Icon.Plus size={12} />
            <span>{t("context.availableTitle")}</span>
          </div>
          <div style={c.chips}>
            {available.map((doc) => (
              <Button
                key={doc.path}
                kind="secondary"
                size="sm"
                icon="Plus"
                disabled={attachingPath === doc.path}
                onClick={() => attach.mutate(doc.path)}
              >
                {doc.path}
              </Button>
            ))}
          </div>
        </>
      )}

      <div style={c.footer}>
        <TokenTotal
          tokens={tokens}
          pendingCount={pendingCount}
          format={(sum, budget) => t("context.total", { tokens: sum, budget })}
          overBudgetLabel={t("context.overBudget")}
          pendingFormat={(count) => t("context.pendingCount", { count })}
        />
        {error && (
          <span role="alert" style={c.error}>
            {t("context.error", { message: (error as Error).message })}
          </span>
        )}
      </div>
    </div>
  );
}
