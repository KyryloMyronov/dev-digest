import { describe, it, expect } from 'vitest';
import type { PrIntentRecord, UnifiedDiff } from '@devdigest/shared';
import {
  applyConfidenceRule,
  clampIntent,
  classifySources,
  isDocumentedBody,
  isSafeRepoPath,
  parseIssueRefs,
  parseSpecPaths,
  renderIntentBlock,
  stripBoilerplate,
  summariseCommits,
  summariseDiffFiles,
} from '../src/modules/reviews/intent-sources.js';
import { INDIRECT_CONFIDENCE_CAP, MAX_SCOPE_ITEMS } from '../src/modules/reviews/constants.js';

/**
 * L03 — the pure half of the intent layer.
 *
 * These functions parse AUTHOR-CONTROLLED text and then decide what the review
 * is told and how confident it is allowed to sound, so they are the part worth
 * testing hardest: `parseSpecPaths` is a path-traversal boundary, and
 * `applyConfidenceRule` is the only thing stopping a guess from being presented
 * as a fact.
 */

describe('parseIssueRefs', () => {
  it('finds closing-keyword references first, then bare mentions', () => {
    const refs = parseIssueRefs('See #7 for background.\n\nCloses #412.');
    expect(refs.issues).toEqual([412, 7]);
  });

  it('accepts every GitHub closing keyword, case-insensitively', () => {
    for (const kw of ['Closes', 'closed', 'fix', 'Fixes', 'fixed', 'resolve', 'Resolves']) {
      expect(parseIssueRefs(`${kw} #9`).issues).toEqual([9]);
    }
  });

  it('deduplicates a number referenced twice', () => {
    expect(parseIssueRefs('Fixes #5. Also see #5.').issues).toEqual([5]);
  });

  it('reports a Jira-style key separately from GitHub issues', () => {
    const refs = parseIssueRefs('ACME-123 — rate limiting. Closes #8.');
    expect(refs.ticketKeys).toEqual(['ACME-123']);
    expect(refs.issues).toEqual([8]);
  });

  it('does not mistake a lowercase word-dash-number for a ticket key', () => {
    expect(parseIssueRefs('bump node-18 to node-22').ticketKeys).toEqual([]);
  });

  it('returns empty for a null body', () => {
    expect(parseIssueRefs(null)).toEqual({ issues: [], ticketKeys: [] });
  });
});

describe('parseSpecPaths', () => {
  it('finds a relative markdown path', () => {
    expect(parseSpecPaths('Implements docs/plans/rate-limit.md')).toEqual([
      'docs/plans/rate-limit.md',
    ]);
  });

  it('extracts the repo path out of a GitHub blob URL', () => {
    expect(
      parseSpecPaths('spec: https://github.com/acme/api/blob/main/server/specs/intent.md'),
    ).toEqual(['server/specs/intent.md']);
  });

  it('caps how many files it will read', () => {
    const body = 'a/one.md b/two.md c/three.md d/four.md';
    expect(parseSpecPaths(body).length).toBeLessThanOrEqual(2);
  });

  it('rejects traversal, absolute paths and non-markdown', () => {
    // The whole point of the helper: these come from a PR body and are then
    // joined onto a clone directory.
    expect(parseSpecPaths('see ../../etc/passwd.md')).toEqual([]);
    expect(parseSpecPaths('see /etc/shadow.md')).toEqual([]);
    expect(parseSpecPaths('see docs/../../secrets.md')).toEqual([]);
    expect(parseSpecPaths('see src/index.ts')).toEqual([]);
  });

  it('agrees with isSafeRepoPath on the individual rules', () => {
    expect(isSafeRepoPath('docs/a.md')).toBe(true);
    expect(isSafeRepoPath('docs/a.mdx')).toBe(true);
    expect(isSafeRepoPath('../a.md')).toBe(false);
    expect(isSafeRepoPath('/a.md')).toBe(false);
    expect(isSafeRepoPath('C:/a.md')).toBe(false);
    expect(isSafeRepoPath('docs\\a.md')).toBe(false);
    expect(isSafeRepoPath('docs/a.ts')).toBe(false);
  });
});

describe('isDocumentedBody', () => {
  it('treats an unfilled PR template as undocumented', () => {
    // Long enough to pass a naive length check, empty of content.
    const template = `<!-- Describe your change here. Keep it short and link the ticket. -->
## What
## Why
## How to test
## Checklist
- [ ] tests
- [ ] docs
- [ ] changelog
---
<!-- Reviewers: please read the contributing guide before commenting on style -->`;
    expect(template.length).toBeGreaterThan(200);
    expect(stripBoilerplate(template).length).toBeLessThan(200);
    expect(isDocumentedBody(template)).toBe(false);
  });

  it('treats real prose of sufficient length as documentation', () => {
    expect(isDocumentedBody('x'.repeat(250))).toBe(true);
  });

  it('treats an empty or missing body as undocumented', () => {
    expect(isDocumentedBody(null)).toBe(false);
    expect(isDocumentedBody('   ')).toBe(false);
  });
});

describe('classifySources / applyConfidenceRule', () => {
  it('counts a real body, a resolved ticket and a spec as documentation', () => {
    expect(classifySources(['title', 'pr_body'])).toBe('documented');
    expect(classifySources(['title', 'ticket'])).toBe('documented');
    expect(classifySources(['title', 'spec:docs/plan.md'])).toBe('documented');
  });

  it('does NOT count an unresolved ticket key as documentation', () => {
    // A Jira key with no tracker attached proves a ticket exists and says
    // nothing about what it contains.
    expect(classifySources(['title', 'branch', 'ticket_key_unresolved'])).toBe('indirect');
  });

  it('does NOT count a stub body as documentation', () => {
    expect(classifySources(['title', 'pr_body_stub', 'files'])).toBe('indirect');
  });

  it('caps a confident model when only indirect signals were available', () => {
    const { confidence, derivedFrom } = applyConfidenceRule(['title', 'branch', 'files'], 0.95);
    expect(derivedFrom).toBe('indirect');
    expect(confidence).toBe(INDIRECT_CONFIDENCE_CAP);
  });

  it('never RAISES a low model confidence, documented or not', () => {
    expect(applyConfidenceRule(['pr_body'], 0.2).confidence).toBe(0.2);
    expect(applyConfidenceRule(['title'], 0.2).confidence).toBe(0.2);
  });

  it('passes a documented reading through unchanged', () => {
    expect(applyConfidenceRule(['title', 'pr_body'], 0.9).confidence).toBe(0.9);
  });

  it('clamps an out-of-range number from the model', () => {
    expect(applyConfidenceRule(['pr_body'], 1.7).confidence).toBe(1);
    expect(applyConfidenceRule(['pr_body'], -0.4).confidence).toBe(0);
  });
});

describe('clampIntent', () => {
  it('enforces the caps strict json_schema mode ignores', () => {
    const out = clampIntent({
      intent: 'x'.repeat(5000),
      change_type: 'feature',
      in_scope: Array.from({ length: 40 }, (_, i) => `item ${i}`),
      out_of_scope: ['  padded  ', ''],
      confidence: 0.8,
      evidence: ['pr-body'],
    });
    expect(out.intent.length).toBe(600);
    expect(out.in_scope.length).toBe(MAX_SCOPE_ITEMS);
    expect(out.out_of_scope).toEqual(['padded']);
  });
});

describe('summarisers', () => {
  it('renders changed files as path (+a/-d)', () => {
    const diff = {
      raw: '',
      files: [{ path: 'src/a.ts', additions: 12, deletions: 3, hunks: [] }],
    } as unknown as UnifiedDiff;
    expect(summariseDiffFiles(diff)).toBe('src/a.ts (+12/-3)');
  });

  it('keeps commit subjects only, dropping bodies', () => {
    expect(summariseCommits(['fix: retry\n\nlong body here', 'chore: bump'])).toBe(
      '- fix: retry\n- chore: bump',
    );
  });
});

describe('renderIntentBlock', () => {
  const base: PrIntentRecord = {
    pr_id: 'pr-1',
    intent: 'Make the nightly sync survive upstream rate limiting.',
    in_scope: ['retry with backoff'],
    out_of_scope: ['changing the schedule'],
    change_type: 'bugfix',
    confidence: 0.9,
    sources: ['title', 'pr_body'],
    derived_from: 'documented',
    provider: 'openrouter',
    model: 'deepseek/deepseek-v4-flash',
    cost_usd: 0.0001,
    head_sha: 'abc123',
    created_at: '2026-08-17T00:00:00.000Z',
  };

  it('spells low confidence out in prose, not as a bare number', () => {
    const text = renderIntentBlock({
      ...base,
      confidence: 0.38,
      derived_from: 'indirect',
      sources: ['title', 'branch', 'files'],
    });
    expect(text).toContain('LOW');
    expect(text).toContain('Treat it as a guess');
    expect(text).toContain('title, branch, files');
  });

  it('labels scope as the author’s claim, never as a limit', () => {
    const text = renderIntentBlock(base);
    expect(text).toContain('The author claims this change covers');
    expect(text).toContain('a claim, not a limit on review');
  });

  it('omits the confidence line when nothing was recorded', () => {
    expect(renderIntentBlock({ ...base, confidence: null })).not.toContain('Confidence');
  });
});
