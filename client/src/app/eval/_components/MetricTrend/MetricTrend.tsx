"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { CHART, SERIES, type SeriesDef } from "./constants";
import { s } from "./styles";

/**
 * SPEC-04 AC-75 — the metric trend.
 *
 * WHY THIS EXISTS RATHER THAN `LineChart` (plan D-7, spec D-28). The vendor
 * `LineChart` renders `<XAxis dataKey="i" hide />` — there are no axis labels at
 * all — and Recharts' `ResponsiveContainer` measures 0×0 under jsdom, so nothing
 * would render to assert on. `client/src/vendor/**` is do-not-touch, so it is
 * neither used nor edited. This is modelled on `Sparkline`
 * (`charts/Sparkline.tsx`), which is plain inline SVG and does render in jsdom.
 *
 * X IS THE BATCH ORDINAL, never a date: batches are not evenly spaced in time,
 * a time axis is not representable here, and OQ-1's "30 days" control is out of
 * scope in phase 1.
 */

export interface MetricTrendPoint {
  recall: number | null;
  precision: number | null;
  citationAccuracy: number | null;
}

export interface MetricTrendProps {
  /** OLDEST FIRST — ordinal 1 is the left-most point. */
  points: readonly MetricTrendPoint[];
  width?: number;
  height?: number;
}

const fmt = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}%`);

/**
 * Build the `d` for one series, breaking the line wherever the metric is null.
 *
 * A null is a fact — "this batch scored nothing" — and joining across it would
 * draw a slope nobody measured.
 */
function pathFor(
  points: readonly MetricTrendPoint[],
  key: SeriesDef["key"],
  w: number,
  h: number,
): string {
  const plotW = w - CHART.padLeft - CHART.padRight;
  const plotH = h - CHART.padTop - CHART.padBottom;
  const x = (i: number) =>
    CHART.padLeft + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => CHART.padTop + (1 - Math.min(Math.max(v, 0), 1)) * plotH;

  let d = "";
  let penDown = false;
  points.forEach((p, i) => {
    const v = p[key];
    if (v === null) {
      penDown = false;
      return;
    }
    d += `${penDown ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    penDown = true;
  });
  return d.trim();
}

export function MetricTrend({
  points,
  width = CHART.width,
  height = CHART.height,
}: MetricTrendProps) {
  const t = useTranslations("eval");

  if (points.length === 0) {
    return <p style={s.empty}>{t("agentPage.trendEmpty")}</p>;
  }

  const plotW = width - CHART.padLeft - CHART.padRight;
  const xAt = (i: number) =>
    CHART.padLeft + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);

  return (
    <div style={s.wrap}>
      <svg
        style={s.svg}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t("agentPage.trendTitle")}
        data-testid="metric-trend"
      >
        {SERIES.map((series) => (
          <path
            key={series.key}
            data-series={series.key}
            d={pathFor(points, series.key, width, height)}
            fill="none"
            // The token literal, not a resolved colour: jsdom preserves it
            // verbatim, which is what binds the contrast table in the test to
            // what this component actually paints.
            stroke={series.token}
            strokeWidth={2}
            strokeDasharray={series.dash}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {/* AC-75 — the x-axis is the batch ORDINAL, drawn as text. */}
        {points.map((_, i) => (
          <text
            key={i}
            x={xAt(i)}
            y={height - 8}
            textAnchor="middle"
            fontSize={10}
            fill="var(--text-secondary)"
          >
            {i + 1}
          </text>
        ))}
      </svg>

      {/* NFR-9 — identity without colour: a dash glyph AND a text label. */}
      <ul style={s.legend}>
        {SERIES.map((series) => (
          <li key={series.key} style={s.legendItem}>
            <svg width={22} height={8} aria-hidden="true">
              <line
                x1={0}
                y1={4}
                x2={22}
                y2={4}
                stroke={series.token}
                strokeWidth={2}
                strokeDasharray={series.dash}
              />
            </svg>
            {t(`dashboard.legend.${series.messageKey}`)}
          </li>
        ))}
      </ul>

      {/*
        AC-75's "exposed as text in the accessibility tree". A chart drawn in
        SVG paths carries no readable numbers; this table does, and it is also
        the table view every chart owes a non-visual reader.
      */}
      <table style={s.srOnly}>
        <caption>{t("agentPage.trendTitle")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("dashboard.batchColumn")}</th>
            {SERIES.map((series) => (
              <th key={series.key} scope="col">
                {t(`dashboard.legend.${series.messageKey}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {points.map((p, i) => (
            <tr key={i}>
              <th scope="row">
                {t("agentPage.trendAxisLabel", { ordinal: i + 1, total: points.length })}
              </th>
              {SERIES.map((series) => (
                <td key={series.key}>{fmt(p[series.key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
