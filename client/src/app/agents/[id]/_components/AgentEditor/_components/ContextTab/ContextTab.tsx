/* ContextTab — attach, order and detach the project-context documents of one
   agent (SPEC-01, AC-17 and AC-23 → AC-35).

   Two lists, deliberately: ATTACHED (ordered, reorderable, detachable) and
   AVAILABLE (everything else this repository discovered). The order of the
   attached list IS the order the documents are concatenated into the prompt, so
   it is shown as a list and not as a set of checkboxes.

   THE REPOSITORY COMES FROM `useActiveRepo()` (D-Q6f), and the consequence is
   worth stating because the spec leaves it unsaid: `agent_context_docs` stores a
   bare, repo-agnostic `path`. An attachment made while viewing repo A is
   resolved at RUN TIME against whatever repository the reviewed PR belongs to.
   That is also exactly why AC-29 exists — a path that resolves nowhere renders
   as an unresolved row instead of vanishing.

   Inherited rows (from the agent's enabled skills) are shown but not editable
   here: they belong to the skill, and the skill editor is where they are changed.
   They still count towards the footer total, because they still reach the prompt.

   Strings come from `messages/en/agents.json` (`agents.context.*`), beside the
   Skills tab's own `agents.skills.*` — this screen owns its messages. Reading
   the Project Context page's `context` catalogue here would make the agent
   editor throw MISSING_MESSAGE in any test that scopes messages to this screen,
   which is what `AgentEditor.test.tsx` does (it passes only because it renders
   the Config tab). Same reason the shared token cells take label props.

   ─── ACCEPTED ACCESSIBILITY CONFLICT (NFR-6 vs AC-19) ──────────────────────
   See the comment at the drag handle below. */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge, Button, EmptyState, Icon, IconBtn, Skeleton, TextInput } from "@devdigest/ui";
import { resolveHref } from "@devdigest/ui";
import type { Agent } from "@devdigest/shared";
import type { AgentContextDoc } from "@/lib/types";
import { useActiveRepo } from "@/lib/repo-context";
import {
  useAgentContextDocs,
  useAttachAgentContextDoc,
  useContextFiles,
  useDetachAgentContextDoc,
  useSetAgentContextDocs,
} from "@/lib/hooks/project-context";
import { TokenCount, TokenTotal } from "@/components/context-tokens";
import { availableDocs, matchesFilter, moveItem, tokenTotals } from "./helpers";
import { s } from "./styles";

export function ContextTab({ agent }: { agent: Agent }) {
  const t = useTranslations("agents");
  const router = useRouter();
  const { repoId } = useActiveRepo();

  const list = useContextFiles(repoId);
  const attachments = useAgentContextDocs(agent.id, repoId);
  const attach = useAttachAgentContextDoc(agent.id, repoId);
  const detach = useDetachAgentContextDoc(agent.id, repoId);
  const reorder = useSetAgentContextDocs(agent.id, repoId);

  const [query, setQuery] = React.useState("");
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);

  // Everything below is derived from the two queries on every render. Nothing is
  // mirrored into state, so the rows, the header counts and the footer total can
  // never disagree with each other.
  // Array-guarded rather than `?? []`: an unexpected payload (a proxy error
  // page, a fetch mock that does not know these endpoints) is truthy and not
  // iterable, and a throw during render takes the whole agent editor down. The
  // hooks normalise too; this is the render-boundary half of the same posture.
  const attached: AgentContextDoc[] = Array.isArray(attachments.data) ? attachments.data : [];
  const discoveredFiles = list.data?.files;
  const discovered = Array.isArray(discoveredFiles) ? discoveredFiles : [];
  const attachedPaths = new Set(attached.map((r) => r.path));
  const available = availableDocs(discovered, attachedPaths);
  const { tokens, pendingCount } = tokenTotals(attached);

  const visibleAttached = attached.filter((r) => matchesFilter(r.path, query));
  const visibleAvailable = available.filter((d) => matchesFilter(d.path, query));

  // AC-25 — the pending row, not a global flag: one shared `isPending` would
  // disable every row at once. TanStack exposes the in-flight `variables`, which
  // for these mutations IS the row's path.
  const attachingPath = attach.isPending ? attach.variables : null;
  const detachingPath = detach.isPending ? detach.variables : null;
  const mutationError = attach.error ?? detach.error ?? reorder.error;

  /** Reorder the agent's OWN paths; inherited rows belong to their skill. */
  const applyReorder = (from: number, to: number) => {
    const own = attached.filter((r) => !r.inherited_from).map((r) => r.path);
    if (from < 0 || to < 0 || from >= own.length || to >= own.length) return;
    reorder.mutate(moveItem(own, from, to));
  };

  if (list.isLoading || attachments.isLoading) {
    return (
      <div style={s.wrap}>
        <div style={s.list}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </div>
    );
  }

  // AC-27 — nothing to attach: either the repository has no Markdown under the
  // three roots, or it is still cloning. Either way the next step is the same
  // page, reached with `resolveHref` so `:repoId` is filled exactly as the
  // sidebar fills it.
  if (discovered.length === 0 && attached.length === 0) {
    return (
      <div style={s.wrap}>
        <EmptyState
          icon="FileText"
          title={t("context.emptyTitle")}
          body={t("context.emptyBody")}
          cta={t("context.emptyCta")}
          onCta={() => router.push(resolveHref("/repos/:repoId/context", repoId))}
        />
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <h2 style={s.h2}>{t("context.title")}</h2>
        {/* AC-28 — attached count AND discovered count, in one badge. */}
        <Badge color="var(--accent)">
          {t("context.counts", { attached: attached.length, discovered: discovered.length })}
        </Badge>
      </div>
      <p style={s.hint}>{t("context.hint")}</p>

      <div style={s.filterRow}>
        {/* AC-24 — a plain controlled input; the filter is derived, never stored
            as a second list. */}
        <TextInput
          value={query}
          onChange={setQuery}
          placeholder={t("context.filterPlaceholder")}
          aria-label={t("context.filterLabel")}
        />
      </div>

      <div style={s.sectionHead}>
        <Icon.Check size={13} />
        <span>{t("context.attachedTitle")}</span>
      </div>

      {attached.length === 0 && <p style={s.empty}>{t("context.noneAttached")}</p>}
      {attached.length > 0 && visibleAttached.length === 0 && (
        <p style={s.empty}>{t("context.noMatches", { q: query })}</p>
      )}

      {visibleAttached.length > 0 && (
        <ul style={s.list} aria-label={t("context.attachedTitle")}>
          {visibleAttached.map((row) => {
            const ownIndex = attached
              .filter((r) => !r.inherited_from)
              .findIndex((r) => r.path === row.path);
            const inherited = !!row.inherited_from;
            const unresolved = row.doc === null || row.doc === undefined;
            return (
              <li
                key={row.path}
                style={s.row({ dragging: dragIndex === ownIndex && !inherited, unresolved })}
                draggable={!inherited && !reorder.isPending}
                onDragStart={() => !inherited && setDragIndex(ownIndex)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragIndex !== null && !inherited) applyReorder(dragIndex, ownIndex);
                  setDragIndex(null);
                }}
                onDragEnd={() => setDragIndex(null)}
              >
                {/*
                  ACCEPTED CONFLICT — NFR-6 (WCAG 2.2 SC 2.1.1) vs AC-19.
                  This reorder is drag-only, as UX-2 in SPEC-01 draws it, and
                  UX-2's own text says a drag-only reorder fails SC 2.1.1 — which
                  NFR-6 requires of "every reorder control". The arrow-button
                  alternative was offered twice and declined twice by the author,
                  so the handles stand and the gap is recorded rather than fixed
                  here. Every OTHER control on this tab (filter, attach, detach,
                  the empty state's link) is a real focusable element and fully
                  keyboard-operable. Do not close this quietly in either
                  direction: adding arrows changes an author decision, and
                  dropping the keyboard requirement elsewhere hides it.
                */}
                {!inherited && (
                  <span style={s.grip} aria-hidden="true" title={t("context.dragHint", { path: row.path })}>
                    {/* `Menu`'s three bars read as a grip. The kit has no
                        `GripVertical` and adding an icon would edit
                        `src/vendor/ui/icons.tsx`, which is outside this build's
                        one signed-off exception (`nav.ts`). */}
                    <Icon.Menu size={14} />
                  </span>
                )}

                <span className="mono" style={s.path} title={row.path}>
                  {row.path}
                </span>

                {/* AC-23 — an inherited row names the skill it came from. */}
                {inherited && (
                  <Badge color="var(--text-muted)">
                    {t("context.inherited", { skill: row.inherited_from })}
                  </Badge>
                )}

                {/* AC-29 — the attachment outlived the file. Shown, flagged, and
                    still removable; never silently dropped. */}
                {unresolved && <Badge color="var(--crit)">{t("context.unresolved")}</Badge>}

                <span style={s.rowRight}>
                  {/* AC-31 — a count on every row, attached or not. */}
                  <TokenCount
                    tokens={row.doc?.tokens ?? null}
                    format={(count) => t("context.tokens", { count })}
                    pendingLabel={t("context.tokensPending")}
                  />
                  {!inherited && (
                    <IconBtn
                      icon="X"
                      label={t("context.detach", { path: row.path })}
                      onClick={() => detach.mutate(row.path)}
                      {...(detachingPath === row.path ? { active: true } : {})}
                    />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div style={s.sectionHead}>
        <Icon.Plus size={13} />
        <span>{t("context.availableTitle")}</span>
      </div>

      {available.length === 0 && <p style={s.empty}>{t("context.noneAvailable")}</p>}
      {available.length > 0 && visibleAvailable.length === 0 && (
        <p style={s.empty}>{t("context.noMatches", { q: query })}</p>
      )}

      {visibleAvailable.length > 0 && (
        <ul style={s.list} aria-label={t("context.availableTitle")}>
          {visibleAvailable.map((doc) => (
            <li key={doc.path} style={s.row({ dragging: false, unresolved: false })}>
              <span className="mono" style={s.path} title={doc.path}>
                {doc.path}
              </span>
              <span style={s.rowRight}>
                <TokenCount
                  tokens={doc.tokens}
                  format={(count) => t("context.tokens", { count })}
                  pendingLabel={t("context.tokensPending")}
                />
                <Button
                  kind="secondary"
                  size="sm"
                  icon="Plus"
                  // AC-25 — only THIS row's control is disabled while its own
                  // mutation is in flight.
                  disabled={attachingPath === doc.path}
                  onClick={() => attach.mutate(doc.path)}
                >
                  {t("context.attach", { path: doc.path })}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div style={s.footer}>
        {/* AC-32 + AC-33 — attached documents only, in the error colour past the
            budget. */}
        <TokenTotal
          tokens={tokens}
          pendingCount={pendingCount}
          format={(sum, budget) => t("context.total", { tokens: sum, budget })}
          overBudgetLabel={t("context.overBudget")}
          pendingFormat={(count) => t("context.pendingCount", { count })}
        />
        {mutationError && (
          // AC-26's other half: the rollback happens in the hook, the message
          // happens here — announced in place, with no focus move (NFR-8).
          <span role="alert" style={s.error}>
            {t("context.error", { message: (mutationError as Error).message })}
          </span>
        )}
      </div>
    </div>
  );
}
