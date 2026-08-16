import type { ConventionCandidate, ConventionScan } from '@devdigest/shared';
import type { ConventionRow, ConventionScanRow } from './repository.js';
import {
  DRAFT_NAME_SUFFIX,
  MAX_RULE_CHARS,
  MAX_SELECTED_FILES,
  MAX_SNIPPET_CHARS,
} from './constants.js';

/**
 * Pure helpers for the conventions module — normalisation, the re-scan identity,
 * the grounding gate, and DTO mapping. No I/O, no `this`, no container.
 *
 * The grounding gate is the reason the extraction prompt can honestly promise
 * that an ungrounded rule is discarded, so it lives here where it is cheap to
 * test exhaustively.
 */

/** Collapse whitespace, trim, and cap length. What we store as the rule. */
export function normalizeRule(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_RULE_CHARS);
}

/**
 * The re-scan identity of a rule.
 *
 * Derived from `source_rule` (the model's original wording), NOT the displayed
 * `rule` — a rule the user has rewritten must still be recognised as
 * already-seen, or every scan would re-insert the model's original alongside the
 * user's edit. Lowercased and stripped of punctuation so trivial rewording
 * between runs of the same model does not read as a new rule.
 */
export function matchKey(sourceRule: string): string {
  return sourceRule
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface RawCandidate {
  rule: string;
  evidence_path: string;
  evidence_snippet: string;
  confidence: number;
}

export interface GroundedCandidate {
  sourceRule: string;
  rule: string;
  evidencePath: string;
  evidenceSnippet: string;
  confidence: number;
}

/**
 * Keep only candidates we can stand behind.
 *
 * Drops an empty rule, and drops any candidate citing a file that was never sent
 * to the model — the conventions analogue of the review engine's citation gate
 * (`reviewer-core/src/grounding.ts`). A hallucinated path is the failure mode
 * that matters here: the rule may read plausibly while its evidence points at a
 * file that does not exist, and the user has no way to tell.
 *
 * Also dedupes within the batch by `matchKey`, keeping the highest confidence, so
 * one scan cannot produce two rows that a re-scan would then have to reconcile.
 */
export function groundCandidates(
  raw: RawCandidate[],
  allowedPaths: ReadonlySet<string>,
): GroundedCandidate[] {
  const byKey = new Map<string, GroundedCandidate>();

  for (const item of raw) {
    const rule = normalizeRule(item.rule ?? '');
    if (!rule) continue;
    if (!allowedPaths.has(item.evidence_path)) continue;

    const key = matchKey(rule);
    if (!key) continue;

    const candidate: GroundedCandidate = {
      sourceRule: rule,
      rule,
      evidencePath: item.evidence_path,
      evidenceSnippet: (item.evidence_snippet ?? '').slice(0, MAX_SNIPPET_CHARS),
      confidence: clampConfidence(item.confidence),
    };

    const seen = byKey.get(key);
    if (!seen || candidate.confidence > seen.confidence) byKey.set(key, candidate);
  }

  return [...byKey.values()];
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Reconcile the model's file picks against the paths we actually offered.
 *
 * Hallucinated paths are dropped; the survivors keep the ranker's order rather
 * than the model's, so the most important files are read first when the cap
 * bites. A selection that survives empty falls back to the top-ranked files —
 * a bad pick degrades the scan's focus, it never aborts the scan.
 */
export function pickSelectedPaths(
  modelPaths: string[],
  samples: string[],
  max = MAX_SELECTED_FILES,
): string[] {
  const wanted = new Set(modelPaths);
  const kept = samples.filter((p) => wanted.has(p));
  const chosen = kept.length > 0 ? kept : samples;
  return chosen.slice(0, max);
}

/** Map a `conventions` row to the wire DTO. Absent evidence is `null`, never `undefined`. */
export function toConventionDto(row: ConventionRow): ConventionCandidate {
  return {
    id: row.id,
    repo_id: row.repoId ?? '',
    rule: row.rule,
    evidence_path: row.evidencePath ?? null,
    evidence_snippet: row.evidenceSnippet ?? null,
    confidence: row.confidence ?? null,
    status: row.status,
    edited: row.edited,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    last_seen_at: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
  };
}

/** Map a `convention_scan_state` row to the wire DTO. */
export function toScanDto(row: ConventionScanRow): ConventionScan {
  return {
    repo_id: row.repoId,
    status: row.status,
    reason: row.reason ?? null,
    sample_files: row.sampleFiles,
    selected_files: row.selectedFiles,
    candidates_found: row.candidatesFound,
    new_candidates: row.newCandidates,
    provider: row.provider ?? null,
    model: row.model ?? null,
    started_at: row.startedAt ? row.startedAt.toISOString() : null,
    finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
    error: row.error ?? null,
  };
}

/**
 * The scan state of a repo that has never been scanned. Synthesised, never
 * persisted, so `GET` can always answer 200 with a shape the UI can branch on
 * instead of the client having to treat a 404 as "not scanned yet".
 */
export function idleScan(repoId: string): ConventionScan {
  return {
    repo_id: repoId,
    status: 'idle',
    reason: null,
    sample_files: 0,
    selected_files: 0,
    candidates_found: 0,
    new_candidates: 0,
    provider: null,
    model: null,
    started_at: null,
    finished_at: null,
    error: null,
  };
}

/** `acme/payments-api` → `payments-api-conventions`. */
export function draftSkillName(repoFullName: string): string {
  const short = repoFullName.split('/').pop() ?? repoFullName;
  return `${short}${DRAFT_NAME_SUFFIX}`;
}

/**
 * Compose the markdown body of a skill from accepted conventions.
 *
 * Deterministic — same rows in, same bytes out — so the draft can be diffed and
 * asserted on, and so re-opening the modal never silently reshuffles a body the
 * user was in the middle of editing.
 */
export function buildSkillDraftBody(
  repoFullName: string,
  rows: Pick<ConventionRow, 'rule' | 'evidencePath' | 'evidenceSnippet'>[],
  sampleFiles: number,
): string {
  const name = draftSkillName(repoFullName);
  const out: string[] = [
    `# ${name}`,
    '',
    `House conventions for \`${repoFullName}\`. Flag changes that violate any rule below and cite the offending \`file:line\`.`,
  ];

  for (const row of rows) {
    out.push('', `## ${slugifyRule(row.rule)}`, row.rule);
    if (row.evidencePath) {
      out.push('', `Detected in \`${row.evidencePath}\`:`);
      if (row.evidenceSnippet) out.push('', '```', row.evidenceSnippet, '```');
    }
  }

  out.push(
    '',
    '---',
    '',
    `Derived from ${rows.length} accepted convention${rows.length === 1 ? '' : 's'} over ${sampleFiles} sampled file${sampleFiles === 1 ? '' : 's'}.`,
  );
  return out.join('\n');
}

/** A rule sentence as a short kebab-case heading. */
export function slugifyRule(rule: string): string {
  const slug = rule
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
    .join('-');
  return slug || 'convention';
}

/** The deduped, sorted evidence paths behind a set of conventions. */
export function evidenceFilesOf(rows: Pick<ConventionRow, 'evidencePath'>[]): string[] {
  const paths = rows.map((r) => r.evidencePath).filter((p): p is string => !!p);
  return [...new Set(paths)].sort();
}
