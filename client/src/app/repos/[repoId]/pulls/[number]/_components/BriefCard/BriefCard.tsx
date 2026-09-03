"use client";

import React from "react";
import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Icon,
  SectionLabel,
  SeverityBadge,
  Skeleton,
  type Severity,
} from "@devdigest/ui";
import type { FocusEntry, PrBriefRecord, Risk } from "@devdigest/shared";
import { usePrBrief, useDeriveBrief, isBriefFreshFor } from "@/lib/hooks/brief";
import { formatCost } from "@/lib/format-cost";
import {
  BRIEF_RISK_DISPLAY_CAP,
  DERIVE_TIMEOUT_MS,
  MAX_FOCUS_ENTRIES_SHOWN,
  PATH_HEAD_CHARS,
  PATH_TAIL_CHARS,
  SEVERITY_ORDER,
} from "./constants";
import { s } from "./styles";

/** A claim about a place in the diff — a risk, or a review-focus entry. */
export interface BriefCitation {
  file: string;
  start_line?: number | null;
}

interface BriefCardProps {
  /** Null while the PR list is still resolving the number → id. */
  prId: string | null;
  /** The PR's current head. A mismatch means the brief describes older code. */
  headSha?: string | null;
  /** Reveal a file (and optionally a line) in the Files-changed tab. */
  onRevealLocation?: (path: string, line: number | null) => void;
  /**
   * Does this citation resolve against the STUDIO's own diff line index?
   * The persisted brief was grounded against `pr_files` as they were at
   * derivation time; the studio may hold a newer diff, so it re-checks rather
   * than offering a jump that cannot land (AC-42).
   */
  citationInDiff?: (c: BriefCitation) => boolean;
}

// ------------------------------------------------------------------ helpers

/**
 * Elide the MIDDLE of a long path — a 180-character monorepo path is all tail.
 * The caller keeps the raw string as the element's accessible name (AC-45).
 */
export function truncatePath(path: string): string {
  if (path.length <= PATH_HEAD_CHARS + PATH_TAIL_CHARS + 1) return path;
  return `${path.slice(0, PATH_HEAD_CHARS)}…${path.slice(-PATH_TAIL_CHARS)}`;
}

/** `src/config.ts:12`, or just the path when there is no line. */
function locationLabel(file: string, line: number | null | undefined): string {
  return line == null ? file : `${file}:${line}`;
}

/**
 * AC-38 — risks render CRITICAL → WARNING → SUGGESTION.
 *
 * NOTE the deliberate asymmetry with the review-focus list below, which is
 * rendered UNSORTED, in the order the brief lists it (AC-58): the model's
 * ordering IS the recommendation there, and sorting it would destroy the
 * answer. Two adjacent lists, opposite rules.
 */
function sortRisks(risks: Risk[]): Risk[] {
  return [...risks].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity as Severity) -
      SEVERITY_ORDER.indexOf(b.severity as Severity),
  );
}

// ------------------------------------------------------- the location control

/**
 * A real `<button>`, so Enter AND Space both activate it for free (AC-49).
 * Hand-rolling `onKeyDown` on a `<div>` is how the Space case gets missed.
 */
function LocationButton({
  file,
  line,
  inDiff,
  onReveal,
  notInDiffLabel,
  jumpLabel,
}: {
  file: string;
  line: number | null;
  inDiff: boolean;
  onReveal?: (path: string, line: number | null) => void;
  notInDiffLabel: string;
  jumpLabel: (location: string) => string;
}) {
  const location = locationLabel(file, line);
  return (
    <>
      <button
        type="button"
        className="mono"
        style={s.locationButton}
        // AC-45 — the accessible name carries the UNTRUNCATED location as well
        // as the action ("<path>:<line> — Open this location…"), because the
        // visible label is elided. `aria-label` wins the accessible-name
        // computation over `title`, so the full value has to be in HERE; the
        // `title` below is what a sighted mouse user gets on hover.
        aria-label={jumpLabel(location)}
        title={location}
        // AC-66: an unresolvable citation still reveals the FILE, with no line
        // anchor — the behaviour findings already have.
        onClick={() => onReveal?.(file, inDiff ? line : null)}
      >
        <Icon.Code size={12} aria-hidden />
        {locationLabel(truncatePath(file), line)}
      </button>
      {!inDiff && (
        <span
          title={notInDiffLabel}
          aria-label={notInDiffLabel}
          style={{ display: "inline-flex", alignItems: "center" }}
        >
          <Icon.AlertTriangle size={13} style={{ color: "var(--warn)" }} />
        </span>
      )}
    </>
  );
}

// -------------------------------------------------------------------- risks

function RiskRow({
  risk,
  inDiff,
  onReveal,
  notInDiffLabel,
  jumpLabel,
}: {
  risk: Risk;
  inDiff: boolean;
  onReveal?: (path: string, line: number | null) => void;
  notInDiffLabel: string;
  jumpLabel: (location: string) => string;
}) {
  return (
    <div style={s.riskRow}>
      <div style={s.riskBadgeWrap}>
        {/* NO `compact`: that variant drops the label and leaves colour + icon
            carrying the whole meaning — the exact WCAG 1.4.1 failure NFR-5
            forbids. AC-37 wants an icon AND a text label. */}
        <SeverityBadge severity={risk.severity as Severity} />
      </div>
      <div style={s.riskMain}>
        {/* Model-authored text, rendered as TEXT and never as markup (AC-46):
            a `javascript:` URL or an `<b>` in a risk title must be inert. */}
        <span style={s.riskTitle} title={risk.title} aria-label={risk.title}>
          {risk.title}
        </span>
        <div style={s.locationRow}>
          <LocationButton
            file={risk.file}
            line={risk.start_line}
            inDiff={inDiff}
            onReveal={onReveal}
            notInDiffLabel={notInDiffLabel}
            jumpLabel={jumpLabel}
          />
        </div>
        <span style={s.riskExplanation}>{risk.explanation}</span>
      </div>
    </div>
  );
}

function FocusRow({
  entry,
  inDiff,
  onReveal,
  notInDiffLabel,
  jumpLabel,
}: {
  entry: FocusEntry;
  inDiff: boolean;
  onReveal?: (path: string, line: number | null) => void;
  notInDiffLabel: string;
  jumpLabel: (location: string) => string;
}) {
  return (
    <div style={s.locationRow}>
      <LocationButton
        file={entry.file}
        line={entry.start_line ?? null}
        inDiff={inDiff}
        onReveal={onReveal}
        notInDiffLabel={notInDiffLabel}
        jumpLabel={jumpLabel}
      />
      <span style={s.dash}>—</span>
      <span style={s.reason} title={entry.reason} aria-label={entry.reason}>
        {entry.reason}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------- shell

function CardShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={s.section}>
      <div style={s.box}>
        <div style={s.boxLabel}>
          <SectionLabel icon="Shield">{title}</SectionLabel>
        </div>
        {children}
      </div>
    </section>
  );
}

// -------------------------------------------------------------------- card

/**
 * SPEC-02 — the PR brief: why this change exists, what is risky about it, and
 * where to start reading. One card, three sections, in that order (AC-30),
 * above the Intent/Blast grid.
 *
 * Every location it offers has been gated twice: once against the diff before
 * it was persisted (server-side grounding), and once against the studio's OWN
 * line index before a jump is offered (AC-42) — because the brief may have been
 * grounded against an older `pr_files`.
 */
export function BriefCard({ prId, headSha, onRevealLocation, citationInDiff }: BriefCardProps) {
  const t = useTranslations("prReview.brief");
  // The POST only QUEUES the derivation, so the control's "busy" state lasts
  // until the stored brief is fresh for this head — not until the POST
  // resolves, which happens ~immediately with a 202.
  const [awaiting, setAwaiting] = React.useState(false);
  const [phase, setPhase] = React.useState<"idle" | "deriving" | "ready" | "timedOut">("idle");
  const { data, isLoading, error, refetch } = usePrBrief(prId, {
    pollUntilHead: awaiting ? (headSha ?? null) : null,
  });
  const derive = useDeriveBrief(prId);
  const fresh = isBriefFreshFor(data, headSha);

  React.useEffect(() => {
    if (!awaiting) return;
    if (fresh) {
      setAwaiting(false);
      setPhase("ready");
      return;
    }
    // A stuck or failed derivation writes NO row (AC-11, by design — a failure
    // row would poison the cache), so nothing server-side will ever end this
    // wait. Bound it here and hand the user back a button rather than a
    // permanent spinner (AC-35).
    const timer = setTimeout(() => {
      setAwaiting(false);
      setPhase("timedOut");
    }, DERIVE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [awaiting, fresh]);

  const startDerive = () => {
    derive.mutate(undefined, {
      onSuccess: () => {
        setAwaiting(true);
        setPhase("deriving");
      },
    });
  };
  const busy = derive.isPending || awaiting;

  // AC-48 — every derivation state change is announced through a status region.
  // NOTE (NFR-5): 4.1.3 does NOT govern the cross-tab reveal — its Understanding
  // document lists selecting a different tab in a tablist among the changes that
  // are not status messages. Do not wrap the tab switch in a live region.
  const statusText =
    phase === "deriving"
      ? t("statusDeriving")
      : phase === "ready"
        ? t("statusReady")
        : phase === "timedOut"
          ? t("statusTimedOut")
          : "";
  const status = (
    <div role="status" aria-live="polite" style={s.srOnly}>
      {statusText}
    </div>
  );

  if (isLoading) {
    return (
      <CardShell title={t("title")}>
        {status}
        <Skeleton width="35%" height={12} />
        <Skeleton height={44} />
        <Skeleton width="60%" height={12} />
        <Skeleton height={64} />
      </CardShell>
    );
  }

  if (error) {
    return (
      <CardShell title={t("title")}>
        {status}
        <ErrorState title={t("errorTitle")} body={error.message} onRetry={() => void refetch()} />
      </CardShell>
    );
  }

  // AC-31 — "no brief derived" is a different fact from "derived, but every
  // risk was dropped" and from "genuinely no risks found". Only THIS branch
  // offers the derivation control.
  if (!data) {
    return (
      <CardShell title={t("title")}>
        {status}
        <EmptyState
          icon="Shield"
          title={t("emptyTitle")}
          body={t("emptyBody")}
          cta={t("derive")}
          onCta={startDerive}
          ctaLoading={busy}
        />
      </CardShell>
    );
  }

  return (
    <CardShell title={t("title")}>
      {status}
      <BriefBody
        data={data}
        fresh={fresh}
        busy={busy}
        onDerive={startDerive}
        onRevealLocation={onRevealLocation}
        citationInDiff={citationInDiff}
      />
    </CardShell>
  );
}

function BriefBody({
  data,
  fresh,
  busy,
  onDerive,
  onRevealLocation,
  citationInDiff,
}: {
  data: PrBriefRecord;
  fresh: boolean;
  busy: boolean;
  onDerive: () => void;
  onRevealLocation?: (path: string, line: number | null) => void;
  citationInDiff?: (c: BriefCitation) => boolean;
}) {
  const t = useTranslations("prReview.brief");
  const resolves = (c: BriefCitation) => (citationInDiff ? citationInDiff(c) : true);

  const risks = data.risks ?? [];
  const sorted = sortRisks(risks);
  const shown = sorted.slice(0, BRIEF_RISK_DISPLAY_CAP);
  const focusEntries = (data.focus?.entries ?? []).slice(0, MAX_FOCUS_ENTRIES_SHOWN);
  const dropped = data.grounding?.dropped ?? 0;
  // AC-45 — depends on the ROW's own location, so it is a formatter, not a
  // precomputed string; `LocationButton` builds the label where it has the data.
  const jumpLabel = (location: string) => t("jump", { location });
  const notInDiffLabel = t("notInDiff");

  return (
    <>
      <div style={s.headRow}>
        {/* AC-36 — the staleness badge sits ABOVE the rendered content, and the
            content stays visible: a stale brief is still information. */}
        {!fresh && (
          <Badge icon="AlertTriangle" color="var(--warn)" bg="var(--warn-bg)">
            {t("stale")}
          </Badge>
        )}
        <span style={s.spacer} />
        <Button kind="ghost" icon="RefreshCw" onClick={onDerive} loading={busy}>
          {t("rederive")}
        </Button>
      </div>

      {/* ---- 1. why (AC-30's first section) ---- */}
      <div style={s.block}>
        <div style={s.blockLabel}>{t("whyLabel")}</div>
        {data.why ? (
          <span style={s.prose}>{data.why.summary}</span>
        ) : (
          // AC-47 — a section the derivation did not produce renders its OWN
          // empty state and its siblings keep rendering.
          <span style={s.muted}>{t("whyEmpty")}</span>
        )}
      </div>

      {/* ---- 2. risks ---- */}
      <div style={s.block}>
        <div style={s.blockLabel}>{t("risksLabel")}</div>
        {shown.length > 0 ? (
          <div style={s.riskList}>
            {shown.map((risk, i) => (
              <RiskRow
                key={`${risk.file}:${risk.start_line}:${i}`}
                risk={risk}
                inDiff={resolves(risk)}
                onReveal={onRevealLocation}
                notInDiffLabel={notInDiffLabel}
                jumpLabel={jumpLabel}
              />
            ))}
          </div>
        ) : dropped > 0 ? (
          // AC-29's studio half: "everything was ungrounded" and "no risks
          // found" are different facts, and the dropped count separates them.
          <span style={s.muted}>{t("risksAllDropped", { dropped })}</span>
        ) : (
          <span style={s.muted}>{t("risksEmpty")}</span>
        )}
        {/* AC-39 — reachable only because the card's cap (10) is below the
            server's clamp (20). */}
        {risks.length > shown.length && (
          <span style={s.muted}>
            {t("showingRisks", { shown: shown.length, total: risks.length })}
          </span>
        )}
      </div>

      {/* ---- 3. review focus ---- */}
      <div style={s.block}>
        <div style={s.blockLabel}>{t("focusLabel")}</div>
        {data.focus && focusEntries.length > 0 ? (
          <div style={s.focusList}>
            {/* AC-58 — UNSORTED, in the order the brief lists them. Contrast
                with the risk list above, which is sorted by severity. */}
            {focusEntries.map((entry, i) => (
              <FocusRow
                key={`${entry.file}:${entry.start_line}:${i}`}
                entry={entry}
                inDiff={resolves(entry)}
                onReveal={onRevealLocation}
                notInDiffLabel={notInDiffLabel}
                jumpLabel={jumpLabel}
              />
            ))}
          </div>
        ) : (
          <span style={s.muted}>{t("focusEmpty")}</span>
        )}
      </div>

      <div style={s.footer}>
        {/* AC-44 — `null` (unpriced, or served from cache) and `0` (a genuinely
            free model) are different facts, so the placeholder is passed in
            rather than the value coalesced. Never `cost_usd ?? 0`. */}
        <span>{t("cost", { cost: formatCost(data.cost_usd, t("costUnknown")) })}</span>
        {data.model && <Badge mono>{data.model}</Badge>}
        {data.tokens_in != null && data.tokens_out != null && (
          <span className="tnum">
            {t("tokens", { in: data.tokens_in, out: data.tokens_out })}
          </span>
        )}
        {data.omitted_files.length > 0 && (
          <span title={data.omitted_files.join("\n")}>
            {t("omitted", { count: data.omitted_files.length })}
          </span>
        )}
      </div>
    </>
  );
}
