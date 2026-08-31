/* DiffTab — the Files changed tab.
   L03 · Smart Diff: a toggle in the tab header switches between the Standard
   flat file list and the Smart view, which groups files by the role they play
   in the review (core / wiring / boilerplate), badges review findings on the
   files, highlights the lines they point at, and shows a split suggestion for
   an over-large PR. Smart is the default; the choice persists per PR
   (localStorage) and toggling is pure client state — no navigation, no
   re-fetch. The grouping itself is server-side, deterministic and free
   (`GET /pulls/:id/smart-diff` — no model call), so it is fetched with the tab;
   until it lands, or when it has no groups, the tab is the flat viewer it
   always was. A `reveal` request (click a finding elsewhere) expands whatever
   hides the target line and scrolls to it, switching view mode only if the
   smart view genuinely lacks the file. */
"use client";

import React from "react";
import { SectionLabel, Button, Badge } from "@devdigest/ui";
import {
  DiffViewer,
  type DiffCommentApi,
  type DiffReveal,
  type DiffSummaryApi,
} from "@/components/diff-viewer";
import { useTranslations } from "next-intl";
import { usePrComments, useCreatePrComment } from "@/lib/hooks/reviews";
import { useSmartDiff } from "@/lib/hooks";
import {
  DERIVE_TIMEOUT_MS,
  useDeriveFileSummaries,
  usePrFileSummaries,
} from "@/lib/hooks/file-summary";
import { formatCost } from "@/lib/format-cost";
import { notify } from "@/lib/toast";
import type { PrFile, ReviewRecord } from "@devdigest/shared";
import {
  buildAnnotations,
  currentFindings,
  resolveGroups,
  withFoldOverrides,
  withRoleTags,
  withSummaries,
} from "./helpers";
import { fileFold, setFileFold } from "./foldStore";
import { storedViewMode, storeViewMode, type DiffViewMode } from "./viewMode";
import { ROLE_META } from "./constants";
import { SmartDiffGroups } from "./_components/SmartDiffGroups";
import { SplitSuggestion } from "./_components/SplitSuggestion";
import { s } from "./styles";

interface DiffTabProps {
  prId: string | null;
  filesCount: number;
  files: PrFile[];
  /** Inline commenting is offered only on open PRs (GitHub rejects otherwise). */
  canComment?: boolean;
  /**
   * The PR's persisted reviews, newest-first. The file badges are built from
   * each agent's CURRENT review only, matching what the smart-diff endpoint
   * counts — see `currentFindings`.
   */
  reviews?: ReviewRecord[];
  /** Reviews query state — the findings badge must tell "0" apart from
   *  "not loaded yet" and "failed to load". */
  reviewsPending?: boolean;
  reviewsFailed?: boolean;
  /** Jump-to-finding request (page-owned so it survives the tab switch). */
  reveal?: DiffReveal | null;
  /** SPEC-03 AC-58 — the commit the PR is on right now; a stored summary naming
   *  a different one is badged stale rather than hidden. */
  headSha?: string | null;
  /** SPEC-03 AC-41 — the PR's aggregate, already on `PrMeta`. */
  additions?: number;
  deletions?: number;
}

export function DiffTab({
  prId,
  filesCount,
  files,
  canComment,
  reviews,
  reviewsPending,
  reviewsFailed,
  reveal,
  headSha,
  additions,
  deletions,
}: DiffTabProps) {
  const t = useTranslations("prReview");
  const { data: comments } = usePrComments(prId);
  const create = useCreatePrComment(prId);
  const { data: smart } = useSmartDiff(prId);
  // Comments start hidden so the diff is clean by default — toggle to reveal.
  const [showComments, setShowComments] = React.useState(false);

  // Smart is the default; the persisted per-PR choice wins. Read in an effect,
  // not the initializer: this component is server-pre-rendered and
  // localStorage exists only on the client.
  const [mode, setMode] = React.useState<DiffViewMode>("smart");
  React.useEffect(() => {
    const stored = storedViewMode(prId);
    if (stored) setMode(stored);
  }, [prId]);
  const selectMode = (m: DiffViewMode) => {
    setMode(m);
    storeViewMode(prId, m);
  };

  const commentCount = comments?.length ?? 0;

  // ---- SPEC-03 · file summaries -------------------------------------------
  //
  // THE TWO WAITS LIVE HERE (AC-63 / AC-64), because only the tab knows about
  // both. `prLevelPending` is one derivation over the whole selection;
  // `pending` is the per-file control's own set. Each gets its own
  // DERIVE_TIMEOUT_MS timer (AC-57), and the query polls while EITHER is
  // active.
  //
  // Their stop conditions differ on purpose. A per-file summary landing bumps
  // `selected` by one, which does NOT satisfy `selected === total`, so the
  // PR-level wait continues while the landed summary renders — that is AC-64,
  // true by construction rather than by accident. On a token-capped PR
  // `selected < total` forever, so the PR-level wait ends at AC-57's 90 s; that
  // is the NORMAL exit for a capped PR, not a failure, and the summaries that
  // did land are already on screen.
  const [prLevelPending, setPrLevelPending] = React.useState(false);
  const [pending, setPending] = React.useState<ReadonlySet<string>>(() => new Set());
  const [timedOut, setTimedOut] = React.useState(false);
  const timers = React.useRef<number[]>([]);
  React.useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
    },
    [],
  );

  const waiting = prLevelPending || pending.size > 0;
  const summariesQuery = usePrFileSummaries(prId, { pollWhile: waiting });
  const derive = useDeriveFileSummaries(prId);
  const summaryData = summariesQuery.data;

  // The server's own state ends both waits: a derivation started in another tab
  // clears them too, which a client-only flag could not do.
  React.useEffect(() => {
    if (!summaryData) return;
    if (prLevelPending && summaryData.selected >= summaryData.total) setPrLevelPending(false);
    if (pending.size > 0) {
      const landed = new Set(summaryData.summaries.map((x) => x.path));
      setPending((prev) => {
        const next = new Set([...prev].filter((p) => !landed.has(p)));
        return next.size === prev.size ? prev : next;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryData]);

  const startPrLevelDerivation = () => {
    setTimedOut(false);
    setPrLevelPending(true);
    derive.mutate({});
    // AC-57 — give up after 90 s and return the control to idle.
    timers.current.push(
      window.setTimeout(() => {
        setPrLevelPending(false);
        setTimedOut(true);
      }, DERIVE_TIMEOUT_MS),
    );
  };

  const deriveOne = React.useCallback(
    (path: string) => {
      setTimedOut(false);
      setPending((prev) => new Set(prev).add(path));
      derive.mutate({ path });
      timers.current.push(
        window.setTimeout(() => {
          setPending((prev) => {
            const next = new Set(prev);
            next.delete(path);
            return next;
          });
        }, DERIVE_TIMEOUT_MS),
      );
    },
    [derive],
  );

  // Labels arrive RESOLVED: `FileCard` and `CodeLine` are shared components, and
  // one that resolves its own i18n namespace crashes any screen whose catalogue
  // lacks it (client insights.md 2026-08-27).
  const summaryApi: DiffSummaryApi = {
    onDerive: deriveOne,
    prLevelPending,
    pending,
    loading: summariesQuery.isPending,
    labels: {
      derive: t("smartDiff.deriveFile"),
      deriving: t("smartDiff.deriveFileBusy"),
      noPatch: t("smartDiff.deriveFileNoPatch"),
    },
  };

  // AC-59 — the running total, through the SHARED formatter, with an explicit
  // placeholder for null. NEVER `cost_usd ?? 0`: `null` (unpriced) and `0`
  // (genuinely free) are different facts, which is why `formatCost` takes the
  // placeholder as an argument. This total is exactly D-1's apportioned sum.
  const costTotal = React.useMemo(() => {
    const rows = summaryData?.summaries ?? [];
    const priced = rows.filter((r) => r.cost_usd != null);
    return priced.length === 0 ? null : priced.reduce((n, r) => n + (r.cost_usd ?? 0), 0);
  }, [summaryData]);

  const commenting: DiffCommentApi = {
    comments: comments ?? [],
    canComment: !!canComment && !!prId,
    showComments,
    posting: create.isPending,
    onSubmit: async (input) => {
      try {
        const res = await create.mutateAsync(input);
        setShowComments(true); // a just-posted comment shouldn't stay hidden
        return res;
      } catch (err) {
        notify.error(err instanceof Error ? err.message : "Couldn't post the comment to GitHub.");
        throw err;
      }
    },
  };

  const groups = React.useMemo(
    () => (smart ? resolveGroups(smart, files) : []),
    [smart, files],
  );

  // A jump target the smart view can't show (the two payloads can disagree for
  // a render — see `resolveGroups`) falls back to the flat list. The
  // auto-switch is a detour, not a preference, so it is not persisted.
  React.useEffect(() => {
    if (!reveal || groups.length === 0) return;
    if (!groups.some((g) => g.files.some((f) => f.path === reveal.path))) setMode("standard");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.token, groups]);

  const smartActive = mode === "smart" && groups.length > 0;

  const annotations = React.useMemo(() => {
    const base = smart ? buildAnnotations(smart, currentFindings(reviews ?? [])) : {};
    const tagged =
      smartActive && smart
        ? withRoleTags(base, smart, (role) => {
            const meta = ROLE_META[role];
            return { label: t(meta.labelKey), color: meta.color, bg: meta.bg };
          })
        : base;
    const withSummary = withSummaries(tagged, summaryData, headSha, t("smartDiff.staleSummary"));
    return withFoldOverrides(withSummary, files, (path) => fileFold(prId, path));
  }, [smart, reviews, files, prId, smartActive, t, summaryData, headSha]);

  // The badge counts what the file badges count: each agent's current,
  // non-dismissed findings. The Findings tab's total can legitimately be
  // higher — it is the run history and shows superseded passes on purpose.
  const findingsTotal = React.useMemo(
    () => currentFindings(reviews ?? []).filter((f) => !f.dismissed_at).length,
    [reviews],
  );

  // Three visually distinct states: a real count (including an explicit "0"),
  // still loading, and failed — a hidden or absent badge must never be read as
  // "no findings".
  const findingsBadge = reviewsFailed ? (
    <span title={t("smartDiff.findingsFailedHint")}>
      <Badge icon="AlertTriangle" color="var(--warn)" bg="transparent">
        {t("smartDiff.findingsFailed")}
      </Badge>
    </span>
  ) : reviewsPending ? (
    <span title={t("smartDiff.findingsPendingHint")}>
      <Badge color="var(--text-muted)" bg="transparent">
        {t("smartDiff.findingsPending")}
      </Badge>
    </span>
  ) : (
    <Badge
      color={findingsTotal > 0 ? "var(--accent-text)" : "var(--text-muted)"}
      bg={findingsTotal > 0 ? "var(--accent-bg)" : "var(--bg-hover)"}
    >
      {t("smartDiff.findingsBadge", { count: findingsTotal })}
    </Badge>
  );

  return (
    <section>
      <SectionLabel
        icon="Code"
        right={
          <div style={s.headerRight}>
            {findingsBadge}
            {/* AC-42 — `Smart order` FIRST in the DOM, then `Original order`.
                AC-43 — the `groups.length > 0` conditional is SHIPPED behaviour
                and stays: a toggle with nothing to toggle into is a dead
                control.

                P-4 FIREWALL. These are the exact lines P-4 concerns, and P-4
                was REJECTED by the author: the missing `aria-pressed` stays as
                recorded pre-existing debt with a named follow-up. `Button`
                spreads `...rest`, so the fix is one attribute away — DO NOT add
                `aria-pressed`, `role="radio"` or `aria-current` here. Sweeping
                it in silently is the failure mode. */}
            {groups.length > 0 && (
              <div style={s.modeToggle}>
                <Button
                  kind="tertiary"
                  size="sm"
                  icon="Layers"
                  active={mode === "smart"}
                  onClick={() => selectMode("smart")}
                >
                  {t("smartDiff.smartMode")}
                </Button>
                <Button
                  kind="tertiary"
                  size="sm"
                  icon="ListChecks"
                  active={mode === "standard"}
                  onClick={() => selectMode("standard")}
                >
                  {t("smartDiff.standardMode")}
                </Button>
              </div>
            )}
            {/* THE ONE SURFACE NO ACCEPTANCE CRITERION NAMES. AC-13 defines the
                PR-level derivation and AC-63/AC-64 presuppose a way to start
                it, but no criterion requires this control. A deliberate,
                minimal widening — flagged here rather than absorbed silently. */}
            <Button
              kind="tertiary"
              size="sm"
              icon="Sparkles"
              disabled={prLevelPending || !prId}
              onClick={startPrLevelDerivation}
            >
              {prLevelPending ? t("smartDiff.summariseAllBusy") : t("smartDiff.summariseAll")}
            </Button>
            {commentCount > 0 && (
              <Button
                kind="ghost"
                size="sm"
                icon={showComments ? "EyeOff" : "Eye"}
                onClick={() => setShowComments((v) => !v)}
              >
                {showComments ? "Hide comments" : "Show comments"} ({commentCount})
              </Button>
            )}
          </div>
        }
      >
        {t("smartDiff.sectionLabel")}
      </SectionLabel>

      {/* AC-41 — the count and the aggregate, a SIBLING immediately below the
          label: `SectionLabel` has no slot beneath it (`vendor/**` is
          do-not-touch, so the primitive is not edited). The aggregate comes
          from the PR row when the page passes it, else from the files. */}
      <div style={s.aggregate}>
        <span className="tnum">
          {t("smartDiff.fileAggregate", {
            count: filesCount,
            additions: additions ?? files.reduce((n, f) => n + f.additions, 0),
            deletions: deletions ?? files.reduce((n, f) => n + f.deletions, 0),
          })}
        </span>
        {/* AC-59 — the running total, whenever any summary is available. */}
        {(summaryData?.summaries.length ?? 0) > 0 && (
          <span className="tnum">
            {t("smartDiff.costTotal", { cost: formatCost(costTotal, t("smartDiff.costUnknown")) })}
          </span>
        )}
        {/* AC-60 — under D-2 this reads "eligible but not summarised", NOT
            "dropped by the token cap"; the per-file control (AC-51) is what
            distinguishes the two on screen. */}
        {(summaryData?.omitted_files.length ?? 0) > 0 && (
          <span className="tnum">
            {t("smartDiff.summarised", {
              selected: summaryData!.selected,
              total: summaryData!.total,
            })}
          </span>
        )}
      </div>

      {/* AC-48 — P-7: one sentence separating this ordering from the brief's
          review focus. Without it the reviewer reconciles two "where do I
          start?" answers alone. */}
      <p style={s.vsBrief}>{t("smartDiff.vsBrief")}</p>

      {/* AC-71 — WCAG 2.2 · 4.1.3. A derivation landing is announced without
          moving focus. NOTE for anyone tempted to widen this: 4.1.3 does NOT
          govern a tab switch — its Understanding document lists selecting a
          different tab among the changes that are NOT status messages. Do not
          wrap the view-mode toggle or the tab switch in a live region. */}
      <div role="status" aria-live="polite" style={s.statusRegion}>
        {waiting
          ? t("smartDiff.statusDeriving")
          : timedOut
            ? t("smartDiff.statusTimedOut")
            : (summaryData?.summaries.length ?? 0) > 0
              ? t("smartDiff.statusReady")
              : t("smartDiff.statusIdle")}
      </div>

      <div style={s.wrap}>
        {/* AC-55 — the read failed: an explicit state with a RETRY control,
            branching on the query's error. The SPA has no server-rendered
            fallback, so every screen owes a real error state. */}
        {summariesQuery.isError && (
          <div style={s.summariesError}>
            <span>{t("smartDiff.summariesFailed")}</span>
            <Button kind="tertiary" size="sm" icon="RefreshCw" onClick={() => summariesQuery.refetch()}>
              {t("smartDiff.summariesRetry")}
            </Button>
          </div>
        )}
        {smart && <SplitSuggestion suggestion={smart.split_suggestion} />}
        {smartActive ? (
          <SmartDiffGroups
            prId={prId}
            groups={groups}
            annotations={annotations}
            commenting={commenting}
            summary={summaryApi}
            reveal={reveal ?? null}
            onFileOpenChange={(path, open) => setFileFold(prId, path, open)}
          />
        ) : (
          <DiffViewer
            files={files}
            commenting={commenting}
            annotations={annotations}
            summary={summaryApi}
            reveal={reveal ?? null}
            onFileOpenChange={(path, open) => setFileFold(prId, path, open)}
          />
        )}
      </div>
    </section>
  );
}
