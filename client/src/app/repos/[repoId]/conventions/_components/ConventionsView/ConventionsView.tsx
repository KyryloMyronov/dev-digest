/* /repos/:repoId/conventions — the Conventions screen.
   Scan a cloned repo for its house rules, review each derived insight, and merge
   the accepted ones into a Skill. */
"use client";

import React from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, EmptyState, ErrorState, Skeleton } from "@devdigest/ui";
import type { ConventionStatus } from "@devdigest/shared";
import { AppShell } from "@/components/app-shell";
import { RepoNotFound } from "@/components/repo-not-found";
import { ApiError } from "@/lib/api";
import { useActiveRepo, useRepoNotFound } from "@/lib/repo-context";
import {
  useConventions,
  useSetConventionStatuses,
  useStartConventionScan,
  useUpdateConvention,
} from "@/lib/hooks/conventions";
import { ConventionCard } from "./_components/ConventionCard";
import { CreateSkillModal } from "./_components/CreateSkillModal";
import { SKELETON_CARDS, SKELETON_HEIGHT } from "./constants";
import { acceptedIds, isScanning, relativeTime } from "./helpers";
import { s } from "./styles";

export function ConventionsView() {
  const t = useTranslations("conventions");
  const params = useParams<{ repoId: string }>();
  const repoId = params.repoId;
  const { activeRepo } = useActiveRepo();
  const repoNotFound = useRepoNotFound(repoId);

  const { data, isLoading, isError, error, refetch } = useConventions(repoId);
  const startScan = useStartConventionScan(repoId);
  const update = useUpdateConvention(repoId);
  const setMany = useSetConventionStatuses(repoId);

  // The modal is owned HERE and rendered as a sibling of the card stack. `Modal`
  // is position:fixed but stays a DOM child of wherever it mounts, so a modal
  // opened from inside a card would bubble its clicks — the backdrop's close
  // click included — into that card's handlers. See client/insights.md.
  const [creating, setCreating] = React.useState(false);

  const items = data?.items ?? [];
  const scan = data?.scan;
  // Derived from the live list, not held in state: the counter and the button's
  // enablement then cannot disagree with the cards above them.
  const accepted = acceptedIds(items);
  const scanning = isScanning(scan) || startScan.isPending;

  const repoName = activeRepo?.full_name?.split("/").pop() ?? t("page.repoFallback");
  const crumb = [{ label: t("page.crumbLab") }, { label: t("page.crumbConventions") }];

  // React Query 5 exposes the in-flight variables, so "which card is busy" needs
  // no extra state — and cannot be left stale by a failed mutation.
  const busyId = update.isPending ? update.variables?.id : null;

  if (repoNotFound) {
    return (
      <AppShell crumb={crumb}>
        <RepoNotFound />
      </AppShell>
    );
  }

  const setStatus = (id: string, status: ConventionStatus) => update.mutate({ id, patch: { status } });

  const subtitle = () => {
    if (!scan || scan.status === "idle") return t("page.neverScanned");
    if (scanning) return t("page.scanning");
    // Re-scanning cannot fix a model that can't serve the schema, so this one
    // failure reason gets its own message rather than "try again".
    if (scan.status === "failed" && scan.reason === "model_unsupported") {
      return t("page.scanModelUnsupported");
    }
    if (scan.status === "failed") return t("page.scanFailed");
    if (scan.status === "degraded") return t("page.scanDegraded");
    return t("page.scanSummary", {
      files: scan.sample_files,
      ago: relativeTime(scan.finished_at),
    });
  };

  return (
    <AppShell crumb={crumb}>
      {creating && (
        <CreateSkillModal
          repoId={repoId}
          repoName={repoName}
          onClose={() => setCreating(false)}
        />
      )}

      <div style={s.main}>
        <div style={s.header}>
          <div style={s.headerText}>
            <h1 style={s.h1}>
              {t("page.headingPrefix")}
              <span className="mono" style={s.repoName}>
                {repoName}
              </span>
            </h1>
            <p style={s.subtitle}>{subtitle()}</p>
          </div>
          <Button
            kind="secondary"
            size="sm"
            icon="RefreshCw"
            loading={scanning}
            disabled={scanning}
            onClick={() => startScan.mutate()}
          >
            {scanning ? t("page.scanning") : t("page.rescan")}
          </Button>
        </div>

        {isLoading && (
          <div style={s.loadingStack}>
            {Array.from({ length: SKELETON_CARDS }).map((_, i) => (
              <Skeleton key={i} height={SKELETON_HEIGHT} />
            ))}
          </div>
        )}

        {isError && (
          <ErrorState
            title={t("page.loadError")}
            body={error instanceof ApiError ? error.message : undefined}
            onRetry={() => refetch()}
          />
        )}

        {!isLoading && !isError && items.length === 0 && (
          <EmptyState
            icon="ListChecks"
            title={t("page.empty.title")}
            body={t("page.empty.body")}
            cta={t("page.empty.cta")}
            ctaLoading={scanning}
            onCta={() => startScan.mutate()}
          />
        )}

        {items.length > 0 && (
          <>
            <div style={s.toolbar}>
              <Button
                kind="ghost"
                size="sm"
                icon="X"
                disabled={accepted.length === 0 || setMany.isPending}
                loading={setMany.isPending}
                onClick={() => setMany.mutate({ ids: accepted, status: "pending" })}
              >
                {t("toolbar.deselectAll")}
              </Button>
              <span style={s.counter}>
                {t("toolbar.acceptedOf", { accepted: accepted.length, total: items.length })}
              </span>
              <span style={s.toolbarSpacer} />
              <Button
                kind="primary"
                size="sm"
                icon="Sparkles"
                disabled={accepted.length === 0}
                onClick={() => setCreating(true)}
              >
                {t("toolbar.createSkill")}
              </Button>
            </div>

            <div style={s.stack}>
              {items.map((c) => (
                <ConventionCard
                  key={c.id}
                  candidate={c}
                  busy={c.id === busyId}
                  onAccept={() => setStatus(c.id, "accepted")}
                  onReject={() => setStatus(c.id, "rejected")}
                  onEditRule={(rule) => update.mutate({ id: c.id, patch: { rule } })}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
