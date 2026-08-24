/* BlastRadiusCard helpers — pure derivations from the BlastResponse. No React. */
import type { BlastResponse } from "@/lib/types";

/** The header stat row: symbols / callers / endpoints / crons. */
export function blastTotals(data: BlastResponse) {
  const endpoints = new Set<string>();
  const crons = new Set<string>();
  let callers = 0;
  for (const i of data.impacts) {
    callers += i.callers.length;
    for (const c of i.crons_affected) crons.add(c);
    for (const e of i.endpoints_affected) endpoints.add(e);
  }
  for (const e of data.endpoints) endpoints.add(e.endpoint);
  return {
    symbols: data.impacts.length,
    callers,
    endpoints: endpoints.size,
    crons: crons.size,
  };
}

/** Mermaid node labels break on double quotes; nothing else needs escaping. */
const label = (text: string) => `"${text.replace(/"/g, "'")}"`;

/**
 * Impact-flow graph: changed symbol → caller (file:line) → endpoint.
 * Returns null when there is nothing to draw (the view shows `graph.empty`).
 */
export function buildBlastGraph(data: BlastResponse): string | null {
  if (!data.impacts.some((i) => i.callers.length > 0)) return null;
  const lines: string[] = ["flowchart LR"];
  data.impacts.forEach((impact, si) => {
    if (impact.callers.length === 0) return;
    lines.push(`  s${si}[${label(`${impact.symbol}()`)}]`);
    impact.callers.forEach((c, ci) => {
      lines.push(`  s${si} --> c${si}_${ci}[${label(`${c.file}:${c.line}`)}]`);
    });
    impact.endpoints_affected.forEach((e, ei) => {
      lines.push(`  s${si} --> e${si}_${ei}([${label(e)}])`);
    });
    impact.crons_affected.forEach((cr, ki) => {
      lines.push(`  s${si} --> k${si}_${ki}([${label(cr)}])`);
    });
  });
  return lines.join("\n");
}

/** "src/a.ts → src/b.ts → src/routes.ts" for an endpoint's import chain. */
export function chainLabel(chain: string[]): string {
  return chain.join(" → ");
}
