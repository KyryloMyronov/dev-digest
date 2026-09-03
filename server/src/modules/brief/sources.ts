import type { UnifiedDiff } from '@devdigest/shared';
import { sliceDiff } from '@devdigest/reviewer-core';
import type { Container } from '../../platform/container.js';
import type { PullRow } from '../../db/rows.js';
import type * as schema from '../../db/schema.js';
import type { RunLogger } from '../../platform/run-logger.js';
import { wrapUntrusted } from '../../platform/prompt.js';
import { BRIEF_PROMPT_TOKEN_CAP } from './constants.js';

/** The repo row, referenced through the schema rather than through another
 *  module's repository — `no-cross-module-internals` forbids importing that
 *  type, and `intent-pipeline.ts` reaches it the same way. */
type RepoRow = typeof schema.repos.$inferSelect;

/**
 * SPEC-02 — brief signal gathering, diff selection and the token cap.
 *
 * NFR-9: THIS FILE PRODUCES PROMPT TEXT AND MUST NOT LOG ANY OF IT. Names,
 * provenance and sizes only — never a body, a commit subject or a hunk.
 *
 * AC-62: every PR-derived signal goes through `wrapUntrusted`, which also
 * neutralises an attempt to close the fence from inside by rewriting
 * `</untrusted>`. NO SIGNAL REACHES THE USER MESSAGE UNFENCED, which is why the
 * assembled message carries exactly one fence per signal and the test counts
 * them.
 */

/** One gathered signal: a labelled, untrusted block plus its source id. */
export interface BriefSignal {
  /** `wrapUntrusted` label. */
  label: string;
  /** The provenance id recorded in the prompt-assembly log. */
  source: string;
  text: string;
}

export interface AssembledBriefPrompt {
  /** The user message: a trusted instruction line plus one fence per signal. */
  message: string;
  /** Changed paths the cap left out, in the same descending order (AC-67). */
  omitted: string[];
  /** Every signal that reached the message, in message order. */
  signals: BriefSignal[];
}

/** Cap on the PR body so a huge author description cannot eat the budget. */
const MAX_BODY_CHARS = 8_000;
/** Cap on the commit-subject block. */
const MAX_COMMITS = 40;

/**
 * The non-diff signals, fixed by D-2: title, body, branch, commit subjects.
 *
 * NO LINKED GITHUB ISSUE AND NO PLAN/SPEC FILE READS — deliberately, and
 * deliberately different from the intent classifier beside it, which gathers
 * both. The accepted consequence is that on a PR with a linked ticket the
 * brief's "why" rests on strictly less evidence than the intent card's. That is
 * recorded in SPEC-02's Open questions; it is not an oversight to fix here.
 */
export async function gatherBriefSignals(
  container: Container,
  args: { pull: PullRow; runLog: RunLogger },
): Promise<BriefSignal[]> {
  const { pull, runLog } = args;
  const signals: BriefSignal[] = [];

  // 1. Title — NOT NULL, always present.
  signals.push({ label: 'pr-title', source: 'title', text: pull.title });

  // 2. Body. Blank is simply one fewer signal.
  if (pull.body && pull.body.trim().length > 0) {
    signals.push({ label: 'pr-body', source: 'pr_body', text: pull.body.slice(0, MAX_BODY_CHARS) });
  } else {
    runLog.info('Brief: PR has no description — one fewer signal');
  }

  // 3. Branch.
  signals.push({ label: 'branch', source: 'branch', text: pull.branch });

  // 4. Commit subjects — best-effort; on throw, omit and log.
  try {
    const commits = await container.pullsRepo.listCommits(pull.id);
    const subjects = commits
      .map((c) => (c.message ?? '').split('\n')[0]?.trim() ?? '')
      .filter((s) => s.length > 0)
      .slice(0, MAX_COMMITS);
    if (subjects.length > 0) {
      signals.push({
        label: 'commits',
        source: 'commits',
        text: subjects.map((s) => `- ${s}`).join('\n'),
      });
    }
  } catch (err) {
    runLog.info(`Brief: could not read commits — ${(err as Error).message}`);
  }

  return signals;
}

/**
 * Assemble the user message under the token cap (AC-22, AC-67, NFR-3).
 *
 * The algorithm, and why each part is the way it is:
 *   - Files are ranked by `additions + deletions` DESCENDING, so what the cap
 *     keeps is the most-changed code rather than whatever the parser emitted
 *     first. `Array.prototype.sort` is stable, so ties keep diff order and the
 *     result is reproducible.
 *   - The budget is the cap MINUS the tokenised system prompt MINUS the
 *     tokenised trusted header MINUS every non-diff signal. Those are not
 *     optional, so they are spent before the diff gets a look in.
 *   - Selection stops at the FIRST file that does not fit, and every file from
 *     there on is recorded as omitted. That makes `omitted` a contiguous tail
 *     in the same descending order — stable and testable — rather than a
 *     scattered set that depends on the exact sizes of later files.
 *   - A file too large for the whole budget is OMITTED, never half-sent: half a
 *     hunk is a citation trap, and AC-67 names it instead.
 *
 * Unlike the intent classifier, which sends paths and counts only "so the cheap
 * model does not cost like the review it precedes", the brief pays for HUNK
 * TEXT — a risk cannot cite a line it has never seen. That is exactly what
 * makes NFR-3 and NFR-4 the load-bearing numbers in this feature.
 */
export function assembleBriefPrompt(
  container: Container,
  args: {
    pull: PullRow;
    repo: RepoRow;
    diff: UnifiedDiff;
    systemPrompt: string;
    signals: BriefSignal[];
  },
): AssembledBriefPrompt {
  const { pull, repo, diff, systemPrompt, signals } = args;
  // Resolved from the container, never constructed: the BPE ranks load once per
  // process, and `TiktokenTokenizer.count` already falls back to a character
  // estimate internally rather than throwing.
  const tokenizer = container.tokenizer;

  const header = `Produce a risk brief for pull request #${pull.number} in ${repo.fullName}.`;

  const fenced = signals.map((s) => wrapUntrusted(s.label, s.text));
  let budget =
    BRIEF_PROMPT_TOKEN_CAP -
    tokenizer.count(systemPrompt) -
    tokenizer.count(header) -
    fenced.reduce((sum, block) => sum + tokenizer.count(block), 0);

  const ranked = [...diff.files].sort(
    (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  );

  const included: BriefSignal[] = [];
  const includedBlocks: string[] = [];
  const omitted: string[] = [];
  let capped = false;

  for (const file of ranked) {
    if (capped) {
      omitted.push(file.path);
      continue;
    }
    const signal: BriefSignal = {
      label: `diff:${file.path}`,
      source: `diff:${file.path}`,
      text: sliceDiff(diff, file.path),
    };
    const block = wrapUntrusted(signal.label, signal.text);
    const cost = tokenizer.count(block);
    if (cost > budget) {
      capped = true;
      omitted.push(file.path);
      continue;
    }
    budget -= cost;
    included.push(signal);
    includedBlocks.push(block);
  }

  return {
    message: [header, ...fenced, ...includedBlocks].join('\n\n'),
    omitted,
    signals: [...signals, ...included],
  };
}
