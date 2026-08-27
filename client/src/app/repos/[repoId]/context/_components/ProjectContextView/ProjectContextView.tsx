/* /repos/:repoId/context — the Project Context screen.

   Read-only by design: this build discovers the Markdown a repository already
   contains and lets a reviewer read it. There is NO create, edit, upload or
   delete affordance anywhere on this page, and adding one is a spec change.

   Six states, each distinct:
     · loading      → skeleton rows (AC-9, in DocList)
     · error+retry  → ErrorState with retry (AC-10, in DocList)
     · empty        → names specs/ docs/ insights/ (AC-8, in DocList)
     · cloning      → 409 repo_not_cloned, named repository (AC-5, HERE)
     · populated    → rows + preview
     · preview error→ inline, list still interactive (AC-12, in DocPreview)

   AC-5 is handled here rather than in DocList because it is a fact about the
   REPOSITORY, not about the list: there is no list to show a state for yet. */
"use client";

import React from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, EmptyState } from "@devdigest/ui";
import { AppShell } from "@/components/app-shell";
import { RepoNotFound } from "@/components/repo-not-found";
import { ApiError } from "@/lib/api";
import { useActiveRepo, useRepoNotFound } from "@/lib/repo-context";
import { useContextDoc, useContextFiles, useReindexContext } from "@/lib/hooks/project-context";
import { ContextFooter } from "./_components/ContextFooter";
import { DocList } from "./_components/DocList";
import { DocPreview } from "./_components/DocPreview";
import { s } from "./styles";

/** True when the list read failed specifically because the clone is not ready. */
function isNotCloned(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.code === "repo_not_cloned");
}

function errorBody(error: unknown): string | undefined {
  return error instanceof ApiError ? error.message : undefined;
}

export function ProjectContextView() {
  const t = useTranslations("context");
  const params = useParams<{ repoId: string }>();
  const repoId = params.repoId;
  const { activeRepo } = useActiveRepo();
  const repoNotFound = useRepoNotFound(repoId);

  const list = useContextFiles(repoId);
  const [selected, setSelected] = React.useState<string | null>(null);
  const doc = useContextDoc(repoId, selected);
  const reindex = useReindexContext();

  const repoName = activeRepo?.full_name ?? t("page.repoFallback");
  const crumb = [{ label: t("page.crumbWorkspace") }, { label: t("page.title") }];

  // Derived from the live list, never mirrored into state: the selected row and
  // its header count then cannot disagree with what is on screen.
  const selectedDoc = list.data?.files.find((f) => f.path === selected) ?? null;

  if (repoNotFound) {
    return (
      <AppShell crumb={crumb}>
        <RepoNotFound />
      </AppShell>
    );
  }

  // AC-5 — the repository is still cloning. A distinct state, and the copy names
  // the repository so it is clear WHICH one is not ready.
  if (list.isError && isNotCloned(list.error)) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.main}>
          <EmptyState
            icon="GitBranch"
            title={t("cloning.title")}
            body={t("cloning.body", { repo: repoName })}
            cta={t("cloning.cta")}
            onCta={() => list.refetch()}
          />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell crumb={crumb}>
      <div style={s.main}>
        <div style={s.header}>
          <div style={s.headerText}>
            <h1 style={s.h1}>
              {t("page.headingPrefix")}
              <span className="mono" style={s.repoName}>
                {repoName}
              </span>
            </h1>
            <p style={s.subtitle}>{t("page.subtitle")}</p>
          </div>
          <Button
            kind="secondary"
            size="sm"
            icon="RefreshCw"
            loading={reindex.isPending}
            disabled={reindex.isPending}
            onClick={() => reindex.mutate(repoId)}
          >
            {reindex.isPending ? t("indexing") : t("reindex")}
          </Button>
        </div>

        <div style={s.split}>
          <div style={s.listCol}>
            <DocList
              data={list.data}
              isLoading={list.isLoading}
              isError={list.isError}
              errorBody={errorBody(list.error)}
              selected={selected}
              onSelect={setSelected}
              onRetry={() => list.refetch()}
            />
          </div>
          <div style={s.previewCol}>
            <DocPreview
              path={selected}
              attachedAgents={selectedDoc?.attached_agents ?? null}
              data={doc.data}
              isLoading={doc.isLoading && !!selected}
              isError={doc.isError}
              errorBody={errorBody(doc.error)}
              onRetry={() => doc.refetch()}
            />
          </div>
        </div>

        {/* AC-16 — the footer reports the discovered count and the scan time.
            Rendered once the list has resolved; there is nothing to count while
            it is still in flight. */}
        {list.data && (
          <ContextFooter total={list.data.total} scannedAt={list.data.scanned_at} />
        )}
      </div>
    </AppShell>
  );
}
