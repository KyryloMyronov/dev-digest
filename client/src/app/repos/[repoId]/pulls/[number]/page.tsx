/* PR Detail — /repos/:repoId/pulls/:number. F2 shell extended by A2 with:
   - Findings panel (VerdictBanner + FindingCards)
   - RunReviewDropdown (run all / a specific agent) + live SSE RunStatus
   - Basic file-by-file diff viewer in the Files tab, grouped by review role and
     annotated with the run's findings by L03's Smart Diff
   Tab state lives in query (?tab). */
"use client";

import React from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Skeleton, ErrorState } from "@devdigest/ui";
import { AppShell } from "../../../../../components/app-shell";
import { RepoNotFound } from "@/components/repo-not-found";
import { PrDetailHeader } from "./_components/PrDetailHeader";
import { OverviewTab } from "./_components/OverviewTab";
import { FindingsTab } from "./_components/FindingsTab";
import { DiffTab } from "./_components/DiffTab";
import { diffLineIndex, findingInDiff } from "./_components/DiffTab/helpers";
import RunTraceDrawer from "./_components/RunTraceDrawer";
import { FindingsModal } from "../_components/FindingsModal";
import { usePullDetail, usePulls } from "../../../../../lib/hooks";
import { useQueryClient } from "@tanstack/react-query";
import { usePrReviews, useCancelRun, usePrActiveRuns, usePrRuns, useDeleteRun } from "../../../../../lib/hooks/reviews";
import { intentKeys, pullKeys, runKeys } from "../../../../../lib/hooks/keys";
import { useActiveRepo, useRepoNotFound } from "../../../../../lib/repo-context";
import { ApiError } from "../../../../../lib/api";
import { githubPrUrl } from "../../../../../lib/github-urls";
import type { FindingRecord } from "@devdigest/shared";
import type { PrFindingCounts, Severity } from "@/lib/types";
import type { DiffReveal } from "@/components/diff-viewer";

export default function PRDetailPage() {
  const params = useParams<{ repoId: string; number: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { repoId, number } = params;
  const { activeRepo } = useActiveRepo();
  const repoNotFound = useRepoNotFound(repoId);
  // The route is keyed by PR number, but every PR API is keyed by the row's
  // uuid — resolve number → uuid via the (cached) pulls list before fetching.
  const { data: pulls, isLoading: pullsLoading } = usePulls(repoId);
  const prId = pulls?.find((p) => p.number === Number(number))?.id ?? null;
  const { data: pr, isLoading: detailLoading, isError, error, refetch } = usePullDetail(prId);

  const isLoading = pullsLoading || (prId != null && detailLoading);
  const {
    data: reviews,
    isPending: reviewsPending,
    isError: reviewsFailed,
    refetch: refetchReviews,
  } = usePrReviews(prId);

  // Live run tracking is SERVER-SOURCED (agent_runs status='running'): survives
  // navigation AND reload, and self-clears via polling when runs finish.
  const qc = useQueryClient();
  const { data: activeRuns } = usePrActiveRuns(prId);
  const { data: prRuns } = usePrRuns(prId);
  const deleteRun = useDeleteRun(prId);
  const liveRunIds = (activeRuns ?? []).map((r) => r.run_id);
  const reviewRunning = liveRunIds.length > 0;
  const cancel = useCancelRun();
  const invalidateActiveRuns = () => {
    if (prId) qc.invalidateQueries({ queryKey: runKeys.activeByPr(prId) });
  };
  // When a run settles (done OR failed) refresh the full run history too, so a
  // just-failed run shows up in "Run history" immediately — no page reload.
  const invalidateRunHistory = () => {
    if (prId) qc.invalidateQueries({ queryKey: runKeys.byPr(prId) });
  };
  // A review run DERIVES and persists the PR intent as shared pre-work, so the
  // Overview card is stale the moment a run settles. Without this the card keeps
  // showing its empty state (staleTime is 30s and refetchOnWindowFocus is off),
  // and its "Derive intent" button then spends a second paid model call on an
  // intent that is already in the database.
  const invalidateIntent = () => {
    if (prId) qc.invalidateQueries({ queryKey: intentKeys.byPr(prId) });
  };
  // A settled run also changes which diff lines carry a finding, which is what
  // the Files tab highlights — refresh the Smart Diff alongside the reviews.
  const invalidateSmartDiff = () => {
    if (prId) qc.invalidateQueries({ queryKey: pullKeys.smartDiff(prId) });
  };

  // Jump-to-finding: page-owned, because the request crosses tabs (a click on
  // the Findings tab must land on the Files tab after it mounts). The token
  // re-triggers an identical jump; the state never reaches the URL — reloading
  // into a half-finished scroll would be noise, not navigation.
  const [diffReveal, setDiffReveal] = React.useState<DiffReveal | null>(null);

  // "blast" is no longer a tab — the blast-radius card lives on the Overview
  // tab now, so old ?tab=blast links land there instead of on a blank page.
  const rawTab = search.get("tab") ?? "overview";
  const tab = rawTab === "blast" ? "overview" : rawTab;
  const traceRunId = search.get("trace");
  const setParam = (key: string, val: string | null) => {
    const sp = new URLSearchParams(search.toString());
    if (val == null) sp.delete(key);
    else sp.set(key, val);
    router.replace(`/repos/${repoId}/pulls/${number}${sp.toString() ? `?${sp.toString()}` : ""}`);
  };
  const setTab = (t: string) => setParam("tab", t);
  const jumpToFinding = (f: FindingRecord) => {
    setDiffReveal((prev) => ({ path: f.file, line: f.start_line ?? null, token: (prev?.token ?? 0) + 1 }));
    setTab("diff");
  };
  // Blast-radius card: a changed symbol's file is by definition in the diff —
  // same cross-tab jump as findings, just without a line anchor.
  const jumpToFile = (path: string) => {
    setDiffReveal((prev) => ({ path, line: null, token: (prev?.token ?? 0) + 1 }));
    setTab("diff");
  };

  // Reviews come newest-first; each is its own run (grouped into accordions).
  const runs = reviews ?? [];
  const allFindings: FindingRecord[] = React.useMemo(
    () => runs.flatMap((r) => r.findings),
    [reviews],
  );
  const lethalTrifecta = allFindings.filter((f) => f.kind === "lethal_trifecta");
  // New-side lines present in the diff — a finding outside this set gets the
  // attention mark on its card instead of a jump that can't land anywhere.
  const diffIndex = React.useMemo(() => diffLineIndex(pr?.files ?? []), [pr?.files]);
  const findingsCount = allFindings.length;
  // Header counters derive from the same ["reviews", prId] query the modal
  // reads, so a counter can never disagree with the list it opens.
  const findingCounts = React.useMemo<PrFindingCounts>(() => {
    const counts: PrFindingCounts = { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 };
    for (const f of allFindings) counts[f.severity] += 1;
    return counts;
  }, [allFindings]);
  // The per-severity findings modal is page-owned, same as on the PR list —
  // rendered as a sibling of the content, never inside the element that opens it.
  const [findingsSeverity, setFindingsSeverity] = React.useState<Severity | null>(null);

  const repoName = activeRepo?.full_name ?? repoId;
  // The real "owner/repo" (null until the repo is loaded) — used to build
  // github.com deep-links for the header and finding file references.
  const repoFullName = activeRepo?.full_name ?? null;
  const crumb = [
    { label: repoName, mono: true, href: `/repos/${repoId}/pulls` },
    { label: "Pull Requests", href: `/repos/${repoId}/pulls` },
    { label: `#${number}`, mono: true },
  ];

  // Stale/unknown :repoId → friendly empty state instead of a 404 error.
  if (repoNotFound) {
    return (
      <AppShell crumb={crumb}>
        <RepoNotFound />
      </AppShell>
    );
  }

  if (isLoading) {
    return (
      <AppShell crumb={crumb}>
        <div style={{ padding: "28px 32px", display: "flex", flexDirection: "column", gap: 16, maxWidth: 1080, margin: "0 auto" }}>
          <Skeleton height={28} width={420} />
          <Skeleton height={16} width={300} />
          <Skeleton height={200} />
        </div>
      </AppShell>
    );
  }

  if (isError || !pr) {
    return (
      <AppShell crumb={crumb}>
        <ErrorState
          fullScreen
          title="Couldn't load this pull request"
          body={error instanceof ApiError ? error.message : `PR #${number} could not be loaded.`}
          onRetry={() => refetch()}
        />
      </AppShell>
    );
  }

  return (
    <AppShell crumb={crumb}>
      <PrDetailHeader
        pr={pr}
        prId={prId}
        tab={tab}
        findingsCount={findingsCount}
        findingCounts={findingCounts}
        githubUrl={repoFullName ? githubPrUrl(repoFullName, pr.number) : null}
        onSetTab={setTab}
        onOpenFindings={setFindingsSeverity}
        onRunStart={() => setTab("findings")}
        onRunsStarted={() => invalidateActiveRuns()}
      />

      <div style={{ padding: "24px 32px 44px", display: "flex", flexDirection: "column", gap: 24, maxWidth: 1080, margin: "0 auto" }}>
        {tab === "overview" && (
          <OverviewTab
            prBody={pr.body}
            prId={prId}
            headSha={pr.head_sha}
            repoFullName={repoFullName}
            onRevealFile={jumpToFile}
          />
        )}

        {tab === "findings" && (
          <FindingsTab
            prId={prId}
            liveRunIds={liveRunIds}
            reviewRunning={reviewRunning}
            lethalTrifecta={lethalTrifecta}
            runs={runs}
            prRuns={prRuns}
            prCommits={pr.commits}
            repoFullName={repoFullName}
            headSha={pr.head_sha}
            cancelMutation={cancel}
            onOpenTrace={(id) => setParam("trace", id)}
            onDelete={(id) => {
              if (window.confirm("Delete this run from history? (its logs are removed too)"))
                deleteRun.mutate(id);
            }}
            onRunDone={() => {
              invalidateActiveRuns();
              invalidateRunHistory();
              invalidateIntent();
              invalidateSmartDiff();
              refetchReviews();
            }}
            onJumpToDiff={jumpToFinding}
            findingInDiff={(f) => findingInDiff(f, diffIndex)}
          />
        )}

        {tab === "diff" && (
          <DiffTab
            prId={prId}
            filesCount={pr.files_count}
            files={pr.files}
            canComment={pr.status === "open"}
            reviews={runs}
            reviewsPending={reviewsPending}
            reviewsFailed={reviewsFailed}
            reveal={diffReveal}
          />
        )}
      </div>

      {findingsSeverity && (
        <FindingsModal
          // The detail contract leaves `id` nullish; the page has already
          // resolved it, and the modal needs it for its reviews query.
          pr={{ ...pr, id: pr.id ?? prId }}
          severity={findingsSeverity}
          onClose={() => setFindingsSeverity(null)}
        />
      )}

      {prId && traceRunId && (
        <RunTraceDrawer
          runId={traceRunId}
          prNumber={pr.number}
          findings={runs.find((r) => r.run_id === traceRunId)?.findings ?? []}
          agentName={runs.find((r) => r.run_id === traceRunId)?.agent_name ?? null}
          onClose={() => setParam("trace", null)}
        />
      )}
    </AppShell>
  );
}
