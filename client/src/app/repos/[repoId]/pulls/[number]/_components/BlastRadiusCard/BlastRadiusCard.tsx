/* BlastRadiusCard — L04 · Blast Radius. Changed symbols → their callers →
   potentially affected endpoints, served entirely from the repo-intel index
   (no LLM). Lives on the Overview tab, beside the Intent card.

   Layout follows the "BLAST RADIUS" card design (img.png): one card holding the
   section label, a stats row with a Tree | Graph toggle on its right, flat
   collapsible symbol rows (header highlighted while expanded) whose bodies show
   `↳ file:line` caller links along a tree guide line plus endpoint/cron chips,
   and — past a divider — a collapsible bar with the reverse-import endpoint
   paths. Honesty rule carried through from the API: whenever `status !== 'full'`
   a banner explains WHY data may be missing — empty sections are never
   presented as a clean bill of health. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon, Badge, Button, MonoLink, SectionLabel, Skeleton, ErrorState } from "@devdigest/ui";
import MermaidDiagram from "@/components/mermaid-diagram/MermaidDiagram";
import { useBlastRadius } from "@/lib/hooks/blast";
import { githubBlobUrl } from "../../../../../../../lib/github-urls";
import type { BlastSymbolImpact } from "@/lib/types";
import { blastTotals, buildBlastGraph, chainLabel } from "./helpers";
import { storedBlastView, storeBlastView, type BlastViewMode } from "./viewMode";
import { s } from "./styles";

interface BlastRadiusCardProps {
  prId: string | null;
  /** "owner/repo"; null until the repo is loaded — links degrade to plain text. */
  repoFullName: string | null;
  headSha: string | null | undefined;
  /** Reveal a changed file in the Files-changed tab (its lines ARE in the diff). */
  onRevealFile?: (path: string) => void;
}

export function BlastRadiusCard({ prId, repoFullName, headSha, onRevealFile }: BlastRadiusCardProps) {
  const t = useTranslations("blast");
  const { data, isPending, isError, refetch } = useBlastRadius(prId);

  const [view, setView] = React.useState<BlastViewMode>("tree");
  React.useEffect(() => {
    const stored = storedBlastView(prId);
    if (stored) setView(stored);
  }, [prId]);
  const selectView = (v: BlastViewMode) => {
    setView(v);
    storeBlastView(prId, v);
  };
  const [endpointsOpen, setEndpointsOpen] = React.useState(false);

  if (isPending) {
    return (
      <section aria-label={t("title")} style={s.section}>
        <div style={s.card}>
          <div style={s.cardLabel}>
            <SectionLabel icon="Target">{t("title")}</SectionLabel>
          </div>
          <Skeleton height={20} width={360} />
          <Skeleton height={120} />
        </div>
      </section>
    );
  }

  if (isError || !data) {
    return <ErrorState title={t("error")} onRetry={() => refetch()} />;
  }

  const totals = blastTotals(data);
  const graph = buildBlastGraph(data);
  const linkTo = (file: string, line?: number) =>
    repoFullName && headSha ? githubBlobUrl(repoFullName, headSha, file, line) : undefined;

  return (
    <section aria-label={t("title")} style={s.section}>
      <div style={s.card}>
        {/* The toggle lives on the label row (SectionLabel's `right` slot), not
            the stats row — in the half-width Overview column the stats row has
            no room left, and a wrapped toggle reads as misalignment. */}
        <div style={s.cardLabel}>
          <SectionLabel
            icon="Target"
            right={
              <div style={s.modeToggle}>
                <Button kind="tertiary" size="sm" active={view === "tree"} onClick={() => selectView("tree")}>
                  {t("view.tree")}
                </Button>
                <Button kind="tertiary" size="sm" active={view === "graph"} onClick={() => selectView("graph")}>
                  {t("view.graph")}
                </Button>
              </div>
            }
          >
            {t("title")}
          </SectionLabel>
        </div>

        <div style={s.statsRow}>
          <span style={s.stat}>
            <Icon.Code size={13} />
            <span className="tnum" style={s.statNum}>{totals.symbols}</span>{" "}
            {t("stat.symbols", { count: totals.symbols })}
          </span>
          <span style={s.stat}>
            <Icon.CornerDownRight size={13} />
            <span className="tnum" style={s.statNum}>{totals.callers}</span>{" "}
            {t("stat.callers", { count: totals.callers })}
          </span>
          <span style={s.stat}>
            <Icon.Globe size={13} />
            <span className="tnum" style={s.statNum}>{totals.endpoints}</span>{" "}
            {t("stat.endpoints", { count: totals.endpoints })}
          </span>
          <span style={s.stat}>
            <Icon.Clock size={13} />
            <span className="tnum" style={s.statNum}>{totals.crons}</span>{" "}
            {t("stat.crons", { count: totals.crons })}
          </span>
        </div>

        {data.status !== "full" && (
          <div role="status" style={s.banner(data.status === "degraded")}>
            <Icon.AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0, marginTop: 1 }} />
            <span>
              <strong>{t(`status.${data.status}`)}</strong>
              {data.reason ? ` — ${data.reason}` : null}
            </span>
          </div>
        )}

        {view === "graph" ? (
          graph ? (
            <div role="img" aria-label={t("graph.ariaLabel")}>
              <MermaidDiagram chart={graph} />
            </div>
          ) : (
            <div style={s.emptyNote}>{t("graph.empty")}</div>
          )
        ) : data.impacts.length === 0 ? (
          data.status === "full" && <div style={s.emptyNote}>{t("noSymbols")}</div>
        ) : totals.callers === 0 ? (
          <div style={s.emptyNote}>{t("noDownstream", { count: totals.symbols })}</div>
        ) : (
          <div style={s.symbolList}>
            {data.impacts.map((impact) => (
              <SymbolRow
                key={`${impact.file}:${impact.symbol}`}
                impact={impact}
                linkTo={linkTo}
                onRevealFile={onRevealFile}
              />
            ))}
          </div>
        )}

        <div style={s.footer}>
          <div
            style={s.endpointsBar}
            role="button"
            tabIndex={0}
            aria-expanded={endpointsOpen}
            onClick={() => setEndpointsOpen((o) => !o)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setEndpointsOpen((o) => !o);
              }
            }}
          >
            <Icon.Globe size={14} style={{ color: "var(--text-muted)" }} />
            <span style={s.endpointsBarTitle}>{t("endpoints.title")}</span>
            <Badge>{data.endpoints.length}</Badge>
            <Icon.ChevronDown
              size={15}
              style={{
                marginLeft: "auto",
                color: "var(--text-muted)",
                transform: endpointsOpen ? "rotate(180deg)" : undefined,
                transition: "transform .12s",
              }}
            />
          </div>
          {endpointsOpen &&
            (data.endpoints.length === 0 ? (
              <div style={s.emptyNote}>{t("endpoints.empty")}</div>
            ) : (
              <div style={s.endpointList}>
                {data.endpoints.map((e, i) => (
                  <div key={`${e.endpoint}|${e.file}|${i}`} style={s.endpointRow}>
                    <Badge mono color="var(--accent-text)" bg="var(--accent-bg)">
                      {e.endpoint}
                    </Badge>
                    <MonoLink href={linkTo(e.file)}>{e.file}</MonoLink>
                    {e.chain.length > 1 && (
                      <span className="mono" style={s.chain}>
                        {chainLabel(e.chain)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))}
        </div>
      </div>
    </section>
  );
}

function SymbolRow({
  impact,
  linkTo,
  onRevealFile,
}: {
  impact: BlastSymbolImpact;
  linkTo: (file: string, line?: number) => string | undefined;
  onRevealFile?: (path: string) => void;
}) {
  const t = useTranslations("blast");
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div>
      <div style={s.symbolHeader(expanded)} onClick={() => setExpanded((e) => !e)}>
        <Icon.ChevronRight
          size={14}
          style={{
            color: "var(--text-muted)",
            transform: expanded ? "rotate(90deg)" : undefined,
            transition: "transform .12s",
          }}
        />
        <Icon.Code size={13} style={{ color: "var(--accent-text)" }} />
        <span className="mono" style={s.symbolName}>
          {impact.symbol}()
        </span>
        <span className="tnum" style={s.symbolMeta}>
          {t("callerCount", { count: impact.callers.length })}
        </span>
      </div>

      {expanded && (
        <div style={s.symbolBody}>
          <div style={s.callerTree}>
            {/* The declaring file is a changed file, so it IS in the diff —
                jump in-app rather than leaving for GitHub. */}
            <div style={s.callerRow}>
              <Icon.File size={12} style={{ color: "var(--text-muted)" }} />
              {onRevealFile ? (
                <MonoLink onClick={() => onRevealFile(impact.file)}>{impact.file}</MonoLink>
              ) : (
                <MonoLink href={linkTo(impact.file)}>{impact.file}</MonoLink>
              )}
            </div>
            {impact.callers.map((c) => (
              <div key={`${c.file}:${c.line}:${c.symbol}`} style={s.callerRow}>
                <Icon.CornerDownRight size={12} style={{ color: "var(--text-muted)" }} />
                <MonoLink href={linkTo(c.file, c.line)}>
                  {c.file}:{c.line}
                </MonoLink>
              </div>
            ))}
            {impact.callers_truncated && <div style={s.truncatedNote}>{t("truncated")}</div>}
          </div>
          {(impact.endpoints_affected.length > 0 || impact.crons_affected.length > 0) && (
            <div style={s.chipRow}>
              {impact.endpoints_affected.map((e) => (
                <Badge key={e} mono icon="Globe" color="var(--accent-text)" bg="var(--accent-bg)">
                  {e}
                </Badge>
              ))}
              {impact.crons_affected.map((c) => (
                <Badge key={c} mono icon="Clock" color="var(--warn)" bg="var(--warn-bg)">
                  {c}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
