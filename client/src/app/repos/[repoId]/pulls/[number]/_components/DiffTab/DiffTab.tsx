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
import { DiffViewer, type DiffCommentApi, type DiffReveal } from "@/components/diff-viewer";
import { useTranslations } from "next-intl";
import { usePrComments, useCreatePrComment } from "@/lib/hooks/reviews";
import { useSmartDiff } from "@/lib/hooks";
import { notify } from "@/lib/toast";
import type { PrFile, ReviewRecord } from "@devdigest/shared";
import {
  buildAnnotations,
  currentFindings,
  resolveGroups,
  withFoldOverrides,
  withRoleTags,
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
    return withFoldOverrides(tagged, files, (path) => fileFold(prId, path));
  }, [smart, reviews, files, prId, smartActive, t]);

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
            {groups.length > 0 && (
              <div style={s.modeToggle}>
                <Button
                  kind="tertiary"
                  size="sm"
                  icon="ListChecks"
                  active={mode === "standard"}
                  onClick={() => selectMode("standard")}
                >
                  {t("smartDiff.standardMode")}
                </Button>
                <Button
                  kind="tertiary"
                  size="sm"
                  icon="Layers"
                  active={mode === "smart"}
                  onClick={() => selectMode("smart")}
                >
                  {t("smartDiff.smartMode")}
                </Button>
              </div>
            )}
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
        Files changed · {filesCount} files
        {smartActive && " · "}
        {smartActive && <span style={s.groupMeta}>{t("smartDiff.groupedByRole")}</span>}
      </SectionLabel>

      <div style={s.wrap}>
        {smart && <SplitSuggestion suggestion={smart.split_suggestion} />}
        {smartActive ? (
          <SmartDiffGroups
            prId={prId}
            groups={groups}
            annotations={annotations}
            commenting={commenting}
            reveal={reveal ?? null}
            onFileOpenChange={(path, open) => setFileFold(prId, path, open)}
          />
        ) : (
          <DiffViewer
            files={files}
            commenting={commenting}
            annotations={annotations}
            reveal={reveal ?? null}
            onFileOpenChange={(path, open) => setFileFold(prId, path, open)}
          />
        )}
      </div>
    </section>
  );
}
