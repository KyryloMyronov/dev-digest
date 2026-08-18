"use client";

import React from "react";
import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  ConfidenceNum,
  EmptyState,
  ErrorState,
  SectionLabel,
  Skeleton,
} from "@devdigest/ui";
import { usePrIntent, useDeriveIntent, isFreshFor } from "@/lib/hooks/intent";
import { s } from "./styles";

interface IntentCardProps {
  /** Null while the PR list is still resolving the number → id. */
  prId: string | null;
  /** The PR's current head. A mismatch means the intent describes older code. */
  headSha?: string | null;
}

/** Give up polling after this long; a job that has not landed by now is stuck. */
const DERIVE_TIMEOUT_MS = 90_000;

/**
 * L03 — what this PR is FOR, derived before the review from the title, body,
 * branch, commits, changed files, a linked ticket and any linked plan/spec.
 *
 * Two things this card exists to make visible, because the intent text alone
 * hides both: how the reading was reached (documentation vs. a guess from
 * indirect signals), and whether it still describes the current head.
 */
export function IntentCard({ prId, headSha }: IntentCardProps) {
  const t = useTranslations("prReview.intent");
  // The POST only QUEUES the derivation, so the button's "busy" state lasts
  // until the stored intent is fresh for this head — not until the POST
  // resolves, which happens ~immediately with a 202.
  const [awaiting, setAwaiting] = React.useState(false);
  const { data, isLoading, error, refetch } = usePrIntent(prId, {
    pollUntilHead: awaiting ? (headSha ?? null) : null,
  });
  const derive = useDeriveIntent(prId);
  const fresh = isFreshFor(data, headSha);

  React.useEffect(() => {
    if (!awaiting) return;
    if (fresh) {
      setAwaiting(false);
      return;
    }
    // A stuck or failed job writes NO row (by design — a failure row would
    // poison the cache), so nothing server-side will ever end this wait. Bound
    // it here and hand the user back a button rather than a permanent spinner.
    const timer = setTimeout(() => setAwaiting(false), DERIVE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [awaiting, fresh]);

  const startDerive = () => {
    derive.mutate(undefined, { onSuccess: () => setAwaiting(true) });
  };
  const busy = derive.isPending || awaiting;

  if (isLoading) {
    return (
      <section>
        <SectionLabel icon="Target">{t("title")}</SectionLabel>
        <div style={s.box}>
          <Skeleton width="40%" height={12} />
          <Skeleton height={38} />
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section>
        <SectionLabel icon="Target">{t("title")}</SectionLabel>
        <ErrorState title={t("errorTitle")} body={error.message} onRetry={() => void refetch()} />
      </section>
    );
  }

  if (!data) {
    return (
      <section>
        <SectionLabel icon="Target">{t("title")}</SectionLabel>
        <EmptyState
          icon="Target"
          title={t("emptyTitle")}
          body={t("emptyBody")}
          cta={t("derive")}
          onCta={startDerive}
          ctaLoading={busy}
        />
      </section>
    );
  }

  const indirect = data.derived_from === "indirect";
  const stale = !fresh;

  return (
    <section>
      <SectionLabel icon="Target">{t("title")}</SectionLabel>
      <div style={s.box}>
        <div style={s.headRow}>
          {data.change_type && (
            <Badge icon="Tag" color="var(--text-primary)">
              {t(`changeType.${data.change_type}`)}
            </Badge>
          )}
          {data.confidence != null && <ConfidenceNum value={data.confidence} />}
          {stale && (
            <Badge icon="AlertTriangle" color="var(--warn)" bg="var(--warn-bg)">
              {t("stale")}
            </Badge>
          )}
          <span style={s.spacer} />
          <Button
            kind="ghost"
            icon="RefreshCw"
            onClick={startDerive}
            loading={busy}
          >
            {t("rederive")}
          </Button>
        </div>

        <div style={s.intent}>{data.intent}</div>

        {indirect && (
          <Badge icon="Info" color="var(--warn)" bg="var(--warn-bg)" style={{ alignSelf: "start", whiteSpace: "normal" }}>
            {t("indirect")}
          </Badge>
        )}

        {(data.in_scope.length > 0 || data.out_of_scope.length > 0) && (
          <div style={s.scopeGrid}>
            {data.in_scope.length > 0 && (
              <div>
                <div style={s.scopeLabel}>{t("inScope")}</div>
                <ul style={s.scopeList}>
                  {data.in_scope.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            {data.out_of_scope.length > 0 && (
              <div>
                <div style={s.scopeLabel}>{t("outOfScope")}</div>
                <ul style={s.scopeList}>
                  {data.out_of_scope.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {data.sources.length > 0 && (
          <div style={s.sourcesRow}>
            <span>{t("sources")}</span>
            {data.sources.map((src) => (
              <Badge key={src} mono>
                {src}
              </Badge>
            ))}
          </div>
        )}

        {/* Says out loud what the reviewer prompt also says: intent is context,
            never a limit on what the review checks. */}
        <div style={s.note}>{t("claimNote")}</div>
      </div>
    </section>
  );
}
