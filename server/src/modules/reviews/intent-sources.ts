import type { PrIntentRecord, UnifiedDiff } from '@devdigest/shared';
import {
  INDIRECT_CONFIDENCE_CAP,
  MAX_INTENT_CHARS,
  MAX_INTENT_COMMITS,
  MAX_INTENT_FILES,
  MAX_SCOPE_ITEM_CHARS,
  MAX_SCOPE_ITEMS,
  MAX_SPEC_FILES,
  MIN_BODY_CHARS,
} from './constants.js';
import type { IntentExtraction } from './intent-schemas.js';

/**
 * L03 — pure helpers for the intent layer: parsing author-controlled text,
 * clamping model output, computing confidence, and rendering the prompt block.
 *
 * Everything here is a pure function over plain values. That is deliberate: it
 * is the half of this feature most worth testing, and keeping it free of the
 * container means it is testable without Docker, a model, or a clone.
 */

// ---------------------------------------------------------------- references

export interface IssueRefs {
  /** GitHub issue numbers this PR claims to close or references. */
  issues: number[];
  /** Jira-style keys (ABC-123). Detected only — no tracker is wired up. */
  ticketKeys: string[];
}

/**
 * GitHub's own closing keywords, per docs. Case-insensitive.
 * Every inner group is NON-capturing: the issue number must stay group 1.
 */
const CLOSING_KEYWORDS = 'close[sd]?|fix(?:e[sd])?|resolve[sd]?';
const CLOSING_RE = new RegExp(`\\b(?:${CLOSING_KEYWORDS})\\b\\s*:?\\s*#(\\d+)`, 'gi');
const BARE_ISSUE_RE = /(?:^|[\s(])#(\d+)\b/g;
const JIRA_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;

/**
 * Extract issue references from a PR body.
 *
 * Closing keywords rank first (they are the author saying "this PR is about that
 * issue"), then bare `#N` mentions. A Jira-style key is reported separately: this
 * repo has no issue-tracker adapter, so the key is evidence that a ticket exists
 * and nothing at all about what it says.
 */
export function parseIssueRefs(body: string | null | undefined): IssueRefs {
  if (!body) return { issues: [], ticketKeys: [] };

  const ordered: number[] = [];
  const push = (raw: string) => {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && !ordered.includes(n)) ordered.push(n);
  };
  for (const m of body.matchAll(CLOSING_RE)) push(m[1]!);
  for (const m of body.matchAll(BARE_ISSUE_RE)) push(m[1]!);

  const keys: string[] = [];
  for (const m of body.matchAll(JIRA_KEY_RE)) {
    if (!keys.includes(m[0])) keys.push(m[0]);
  }
  return { issues: ordered, ticketKeys: keys };
}

// ------------------------------------------------------------- plan / spec

const MD_PATH_RE = /(?:^|[\s('"`[(])((?:[\w.-]+\/)+[\w.-]+\.mdx?)\b/g;
const BLOB_URL_RE = /https?:\/\/[^\s)]*?\/blob\/[^/\s)]+\/((?:[\w.-]+\/)*[\w.-]+\.mdx?)\b/gi;

/**
 * Repo-relative markdown paths mentioned in a PR body — the plan or spec the
 * description points at.
 *
 * The path comes from author-controlled text and is then joined onto a clone
 * directory, so this is a security boundary, not just parsing: relative only, no
 * traversal, no absolute paths, markdown only, and a hard cap on how many.
 */
export function parseSpecPaths(body: string | null | undefined): string[] {
  if (!body) return [];
  const out: string[] = [];
  const add = (raw: string) => {
    const path = raw.trim();
    if (out.length >= MAX_SPEC_FILES || out.includes(path)) return;
    if (!isSafeRepoPath(path)) return;
    out.push(path);
  };
  // Blob URLs first: an explicit link to a file in the repo is the stronger
  // signal, and the same path may also appear as bare text later in the body.
  for (const m of body.matchAll(BLOB_URL_RE)) add(m[1]!);
  for (const m of body.matchAll(MD_PATH_RE)) add(m[1]!);
  return out;
}

/** Relative, traversal-free, markdown-only. Anything else is rejected outright. */
export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  if (path.startsWith('/') || path.startsWith('~')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(path)) return false; // windows absolute
  if (path.includes('\\') || path.includes('\0')) return false;
  if (path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return false;
  return /\.mdx?$/i.test(path);
}

// ------------------------------------------------------------------ signals

/** Is this body long enough to count as documentation rather than a stub? */
export function isDocumentedBody(body: string | null | undefined): boolean {
  return stripBoilerplate(body).length >= MIN_BODY_CHARS;
}

/**
 * Strip what a PR template leaves behind when nobody fills it in — HTML
 * comments, markdown headings, checklist markers, horizontal rules — so a
 * 900-character untouched template does not read as documentation.
 */
export function stripBoilerplate(body: string | null | undefined): string {
  if (!body) return '';
  return body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s.*$/gm, ' ')
    .replace(/^\s*[-*]\s*\[[ xX]?\]\s*/gm, ' ')
    .replace(/^\s*([-*_])\s*(\1\s*){2,}$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Compact "path (+a/-d)" lines for the changed-files signal. */
export function summariseDiffFiles(diff: UnifiedDiff): string {
  return diff.files
    .slice(0, MAX_INTENT_FILES)
    .map((f) => `${f.path} (+${f.additions}/-${f.deletions})`)
    .join('\n');
}

/** First lines of the first N commit messages — subjects only, no bodies. */
export function summariseCommits(messages: string[]): string {
  return messages
    .slice(0, MAX_INTENT_COMMITS)
    .map((m) => `- ${(m.split('\n')[0] ?? '').trim()}`)
    .filter((l) => l !== '- ')
    .join('\n');
}

// --------------------------------------------------------------- confidence

export type DerivedFrom = 'documented' | 'indirect';

/** Sources that carry a STATED motivation, as opposed to a hint at one. */
const DOCUMENTED_SOURCES = ['pr_body', 'ticket'];

/**
 * Is this reading backed by documentation? `ticket_key_unresolved` deliberately
 * does not count: a Jira key with no tracker attached proves a ticket exists and
 * says nothing about what it contains.
 */
export function classifySources(sources: string[]): DerivedFrom {
  const documented = sources.some(
    (s) => DOCUMENTED_SOURCES.includes(s) || s.startsWith('spec:'),
  );
  return documented ? 'documented' : 'indirect';
}

/**
 * Final confidence = the model's number, capped by what the evidence can bear.
 *
 * The model's self-reported number is a CEILING, never the answer. Verbalized LLM
 * confidence clusters in the 80–100% band almost regardless of evidence, so a
 * derivation from a title and a branch name would otherwise report as near
 * certain. The cap is what makes "we guessed" legible in the UI.
 */
export function applyConfidenceRule(
  sources: string[],
  modelConfidence: number,
): { confidence: number; derivedFrom: DerivedFrom } {
  const derivedFrom = classifySources(sources);
  const bounded = Math.min(Math.max(modelConfidence, 0), 1);
  return {
    confidence: derivedFrom === 'documented' ? bounded : Math.min(bounded, INDIRECT_CONFIDENCE_CAP),
    derivedFrom,
  };
}

// ------------------------------------------------------------------- clamps

/**
 * Enforce the size limits strict `json_schema` mode ignores. A hostile PR body
 * can steer the classifier into emitting a wall of text; the prompt slot has a
 * budget regardless of what came back.
 */
export function clampIntent(raw: IntentExtraction): IntentExtraction {
  const item = (s: string) => s.trim().slice(0, MAX_SCOPE_ITEM_CHARS);
  const list = (xs: string[]) => xs.map(item).filter((s) => s.length > 0).slice(0, MAX_SCOPE_ITEMS);
  return {
    ...raw,
    intent: raw.intent.trim().slice(0, MAX_INTENT_CHARS),
    in_scope: list(raw.in_scope),
    out_of_scope: list(raw.out_of_scope),
    evidence: list(raw.evidence),
  };
}

// ------------------------------------------------------------ prompt block

/**
 * Render the block handed to the reviewer.
 *
 * Low confidence is spelled out in prose, not left as a bare number, because the
 * reviewer model reads this as text: "0.38" means nothing to it, "no stated
 * motivation — inferred from the branch name and the file list" does. Scope is
 * labelled as the author's CLAIM for the same reason — the reviewer must not read
 * it as a boundary on what to check.
 */
export function renderIntentBlock(record: PrIntentRecord): string {
  const lines: string[] = [`Intent: ${record.intent}`];
  if (record.change_type) lines.push(`Change type: ${record.change_type}`);

  if (record.confidence != null) {
    const pct = Math.round(record.confidence * 100);
    lines.push(
      record.derived_from === 'indirect'
        ? `Confidence: ${pct}% — LOW. No PR description, ticket or specification was available; this was inferred from indirect signals (${record.sources.join(', ')}). Treat it as a guess.`
        : `Confidence: ${pct}% — derived from ${record.sources.join(', ')}.`,
    );
  }

  if (record.in_scope.length > 0) {
    lines.push('', 'The author claims this change covers:');
    lines.push(...record.in_scope.map((s) => `- ${s}`));
  }
  if (record.out_of_scope.length > 0) {
    lines.push('', 'The author states these are NOT part of it (a claim, not a limit on review):');
    lines.push(...record.out_of_scope.map((s) => `- ${s}`));
  }
  return lines.join('\n');
}
