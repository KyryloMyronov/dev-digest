/* FindingsModal — the findings behind ONE severity counter of a PR row.

   Read-only by design: accept/dismiss live on the PR detail page, which owns
   the mutation and its cache. This reuses that page's ["reviews", prId] query,
   so opening a counter usually paints from cache and the two surfaces can't
   drift. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import {
  CategoryTag,
  ErrorState,
  EmptyState,
  Markdown,
  MonoLink,
  ConfidenceNum,
  Modal,
  SectionLabel,
  SeverityBadge,
  Skeleton,
  SEV,
  type Category,
} from "@devdigest/ui";
import type { FindingRecord } from "@devdigest/shared";
import type { PrMeta, Severity } from "@/lib/types";
import { usePrReviews } from "@/lib/hooks/reviews";
import { useActiveRepo } from "@/lib/repo-context";
import { ApiError } from "@/lib/api";
import { githubBlobUrl } from "@/lib/github-urls";
import { FINDINGS_MODAL_WIDTH, SKELETON_ROWS } from "../../constants";
import { s } from "./styles";

/** Format a finding's line range ("11" when single-line, else "11-15"). */
function lineLabel(f: Pick<FindingRecord, "start_line" | "end_line">): string {
  return f.start_line === f.end_line ? `${f.start_line}` : `${f.start_line}-${f.end_line}`;
}

export function FindingsModal({
  pr,
  severity,
  onClose,
}: {
  pr: PrMeta;
  severity: Severity;
  onClose: () => void;
}) {
  const t = useTranslations("prReview");
  const { activeRepo } = useActiveRepo();
  // Mounted only while open, so the fetch is genuinely lazy — no row in the
  // list requests findings until its counter is clicked.
  const { data: reviews, isLoading, isError, error, refetch } = usePrReviews(pr.id);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const severityLabel = t(`list.findings.severity.${severity}`);
  // Reviews arrive newest-first; keep that order so the freshest run's findings
  // read first, exactly as on the detail page.
  const findings = (reviews ?? [])
    .flatMap((r) => r.findings)
    .filter((f) => f.severity === severity);

  return (
    <Modal
      width={FINDINGS_MODAL_WIDTH}
      title={t("list.findings.modalTitle", { severity: severityLabel })}
      subtitle={t("list.findings.modalSubtitle", { number: pr.number, title: pr.title })}
      onClose={onClose}
    >
      <div style={s.body}>
        {isLoading ? (
          <div style={s.loadingStack}>
            {Array.from({ length: SKELETON_ROWS }).map((_, i) => (
              <Skeleton key={i} height={72} />
            ))}
          </div>
        ) : isError ? (
          <ErrorState
            title={t("list.findings.errorTitle")}
            body={error instanceof ApiError ? error.message : t("list.findings.errorBody")}
            onRetry={() => refetch()}
          />
        ) : findings.length === 0 ? (
          // Reachable without a stale counter: a finding deleted with its run
          // while the list was still showing the old count lands here.
          <EmptyState
            icon="CheckCircle"
            title={t("list.findings.emptyTitle")}
            body={t("list.findings.emptyBody", { severity: severityLabel.toLowerCase() })}
          />
        ) : (
          <>
            <SectionLabel icon={SEV[severity].icon}>
              {t("list.findings.count", { count: findings.length })}
            </SectionLabel>
            <div style={s.list}>
              {findings.map((f) => (
                <FindingItem
                  key={f.id}
                  f={f}
                  repoFullName={activeRepo?.full_name ?? null}
                  headSha={pr.head_sha}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** One finding: severity + title + category, file:line + confidence, rationale. */
function FindingItem({
  f,
  repoFullName,
  headSha,
}: {
  f: FindingRecord;
  repoFullName: string | null;
  headSha: string;
}) {
  const t = useTranslations("prReview");
  const accepted = !!f.accepted_at;
  const dismissed = !!f.dismissed_at;
  const fileHref = repoFullName
    ? githubBlobUrl(repoFullName, headSha, f.file, f.start_line, f.end_line)
    : undefined;

  return (
    <div style={s.item(SEV[f.severity].c, accepted || dismissed)}>
      <div style={s.head}>
        <div style={s.badgeWrap}>
          <SeverityBadge severity={f.severity} compact />
        </div>
        <div style={s.headMain}>
          <div style={s.titleRow}>
            <span style={s.title(dismissed)}>{f.title}</span>
            <CategoryTag category={f.category as Category} />
            {accepted && <span style={s.acceptedTag}>{t("finding.accepted")}</span>}
            {dismissed && <span style={s.dismissedTag}>{t("finding.dismissed")}</span>}
          </div>
          <div style={s.metaRow}>
            <MonoLink href={fileHref}>
              {f.file}:{lineLabel(f)}
            </MonoLink>
            <ConfidenceNum value={f.confidence} />
          </div>
          <div style={s.prose}>
            <Markdown>{f.rationale}</Markdown>
          </div>
          {f.suggestion && (
            <div style={s.suggestionWrap}>
              <div style={s.suggestionLabel}>{t("finding.suggestedFix")}</div>
              <div style={s.prose}>
                <Markdown>{f.suggestion}</Markdown>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}