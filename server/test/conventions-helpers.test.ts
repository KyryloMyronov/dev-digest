import { describe, it, expect } from 'vitest';
import {
  buildSkillDraftBody,
  draftSkillName,
  evidenceFilesOf,
  groundCandidates,
  idleScan,
  matchKey,
  normalizeRule,
  pickSelectedPaths,
  slugifyRule,
  toConventionDto,
  toScanDto,
} from '../src/modules/conventions/helpers.js';
import { MAX_RULE_CHARS, MAX_SNIPPET_CHARS } from '../src/modules/conventions/constants.js';
import type { ConventionRow, ConventionScanRow } from '../src/modules/conventions/repository.js';

/**
 * Unit coverage for the conventions mappers and — the reason this file matters —
 * the grounding gate.
 *
 * `groundCandidates` is the only thing standing between a model's claim and a
 * rule the user is shown as fact. A hallucinated `evidence_path` produces a rule
 * that READS correctly while citing a file that was never opened, which no amount
 * of UI can make honest. The extraction prompt promises such a candidate is
 * discarded; these tests are what make that promise true.
 *
 * `matchKey` is the second load-bearing piece: it is the identity a re-scan
 * matches on, so getting it wrong silently duplicates every edited rule.
 */

const ROW: ConventionRow = {
  id: 'cv-1',
  workspaceId: 'ws-1',
  repoId: 'repo-1',
  sourceRule: 'Route handlers delegate to a service.',
  rule: 'Route handlers delegate to a service.',
  evidencePath: 'src/api/users.ts',
  evidenceSnippet: 'const user = await db.users.find(id);',
  confidence: 0.91,
  status: 'pending',
  edited: false,
  lastSeenAt: new Date('2026-08-11T09:00:00.000Z'),
  createdAt: new Date('2026-08-11T08:00:00.000Z'),
  updatedAt: new Date('2026-08-11T08:30:00.000Z'),
};

const SCAN_ROW: ConventionScanRow = {
  repoId: 'repo-1',
  workspaceId: 'ws-1',
  status: 'done',
  reason: null,
  sampleFiles: 84,
  selectedFiles: 12,
  candidatesFound: 3,
  newCandidates: 3,
  provider: 'openai',
  model: 'gpt-5.4',
  jobId: 'job-1',
  startedAt: new Date('2026-08-11T08:00:00.000Z'),
  finishedAt: new Date('2026-08-11T08:00:30.000Z'),
  error: null,
  updatedAt: new Date('2026-08-11T08:00:30.000Z'),
};

function raw(over: Partial<Parameters<typeof groundCandidates>[0][number]> = {}) {
  return {
    rule: 'Route handlers delegate to a service.',
    evidence_path: 'src/api/users.ts',
    evidence_snippet: 'return service.list();',
    confidence: 0.9,
    ...over,
  };
}

describe('normalizeRule', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeRule('  Route   handlers\n\tdelegate.  ')).toBe('Route handlers delegate.');
  });

  it('caps the length so one runaway rule cannot dominate a prompt', () => {
    expect(normalizeRule('x'.repeat(MAX_RULE_CHARS + 50))).toHaveLength(MAX_RULE_CHARS);
  });
});

describe('matchKey', () => {
  it('ignores case, punctuation and spacing', () => {
    expect(matchKey('Route handlers delegate to a service.')).toBe(
      matchKey('route  handlers   delegate to a SERVICE'),
    );
  });

  it('still matches the ORIGINAL wording after the user rewrites the rule', () => {
    // The whole point of storing `source_rule` separately. If a re-scan keyed off
    // the displayed `rule`, an edited row would look brand new and the model's
    // original would be inserted right next to the user's version.
    const original = 'Route handlers delegate to a service.';
    const edited = 'Route handlers must delegate to a service layer.';
    expect(matchKey(original)).not.toBe(matchKey(edited));
    // …which is why the pipeline hashes `sourceRule`, never `rule`:
    expect(matchKey(ROW.sourceRule)).toBe(matchKey(original));
  });

  it('distinguishes genuinely different rules', () => {
    expect(matchKey('Use async/await.')).not.toBe(matchKey('Use Result types.'));
  });
});

describe('groundCandidates', () => {
  const allowed = new Set(['src/api/users.ts', 'src/lib/redis.ts']);

  it('keeps a candidate citing a file that was actually sent', () => {
    expect(groundCandidates([raw()], allowed)).toHaveLength(1);
  });

  it('DROPS a candidate citing a file that was never sent', () => {
    // The failure this whole gate exists for: a plausible rule pointing at a
    // path the model invented. Nothing downstream can detect it.
    expect(groundCandidates([raw({ evidence_path: 'src/does/not/exist.ts' })], allowed)).toEqual(
      [],
    );
  });

  it('drops an empty or whitespace-only rule', () => {
    expect(groundCandidates([raw({ rule: '   ' })], allowed)).toEqual([]);
  });

  it('truncates an oversized snippet', () => {
    const [kept] = groundCandidates([raw({ evidence_snippet: 'y'.repeat(999) })], allowed);
    expect(kept!.evidenceSnippet).toHaveLength(MAX_SNIPPET_CHARS);
  });

  it('clamps a confidence outside 0..1 instead of storing it', () => {
    expect(groundCandidates([raw({ confidence: 4 })], allowed)[0]!.confidence).toBe(1);
    expect(groundCandidates([raw({ confidence: -2 })], allowed)[0]!.confidence).toBe(0);
    expect(groundCandidates([raw({ confidence: NaN })], allowed)[0]!.confidence).toBe(0);
  });

  it('dedupes within one batch, keeping the most confident wording', () => {
    const out = groundCandidates(
      [
        raw({ rule: 'Route handlers delegate to a service.', confidence: 0.6 }),
        raw({ rule: 'route handlers delegate to a service', confidence: 0.95 }),
      ],
      allowed,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe(0.95);
  });

  it('seeds sourceRule from the model wording, so the row is matchable later', () => {
    const [kept] = groundCandidates([raw({ rule: '  Use   async/await.  ' })], allowed);
    expect(kept!.sourceRule).toBe('Use async/await.');
    expect(kept!.rule).toBe(kept!.sourceRule);
  });
});

describe('pickSelectedPaths', () => {
  const samples = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];

  it('keeps only offered paths, in RANK order rather than the model’s order', () => {
    // Rank order matters because the cap truncates: reading the model's third
    // choice before the ranker's first wastes the budget on a lesser file.
    expect(pickSelectedPaths(['c.ts', 'a.ts'], samples, 4)).toEqual(['a.ts', 'c.ts']);
  });

  it('drops hallucinated paths', () => {
    expect(pickSelectedPaths(['a.ts', 'nope.ts'], samples, 4)).toEqual(['a.ts']);
  });

  it('clamps to the cap', () => {
    expect(pickSelectedPaths(samples, samples, 2)).toEqual(['a.ts', 'b.ts']);
  });

  it('falls back to the top-ranked files when EVERY pick was hallucinated', () => {
    // A useless selection must degrade the scan's focus, never abort the scan.
    expect(pickSelectedPaths(['x.ts', 'y.ts'], samples, 2)).toEqual(['a.ts', 'b.ts']);
  });

  it('falls back when the model returns nothing at all', () => {
    expect(pickSelectedPaths([], samples, 3)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});

describe('toConventionDto', () => {
  it('maps camelCase row keys onto the snake_case wire shape', () => {
    expect(toConventionDto(ROW)).toEqual({
      id: 'cv-1',
      repo_id: 'repo-1',
      rule: 'Route handlers delegate to a service.',
      evidence_path: 'src/api/users.ts',
      evidence_snippet: 'const user = await db.users.find(id);',
      confidence: 0.91,
      status: 'pending',
      edited: false,
      created_at: '2026-08-11T08:00:00.000Z',
      updated_at: '2026-08-11T08:30:00.000Z',
      last_seen_at: '2026-08-11T09:00:00.000Z',
    });
  });

  it('normalises absent evidence to null, not undefined', () => {
    // The contract declares these .nullish(); serialising `undefined` drops the
    // key and makes the client branch on absence instead of null.
    const dto = toConventionDto({
      ...ROW,
      evidencePath: null,
      evidenceSnippet: null,
      confidence: null,
      lastSeenAt: null,
    });
    expect(dto.evidence_path).toBeNull();
    expect(dto.evidence_snippet).toBeNull();
    expect(dto.confidence).toBeNull();
    expect(dto.last_seen_at).toBeNull();
  });
});

describe('toScanDto / idleScan', () => {
  it('maps the scan row, exposing sample_files as the UI’s "detected from N"', () => {
    expect(toScanDto(SCAN_ROW)).toMatchObject({
      repo_id: 'repo-1',
      status: 'done',
      sample_files: 84,
      selected_files: 12,
      candidates_found: 3,
      provider: 'openai',
      model: 'gpt-5.4',
      finished_at: '2026-08-11T08:00:30.000Z',
    });
  });

  it('synthesises an idle scan with zeroes for a never-scanned repo', () => {
    // Synthesised rather than 404 so the client has exactly one shape to branch
    // on, instead of treating a status code as a domain state.
    expect(idleScan('repo-9')).toMatchObject({
      repo_id: 'repo-9',
      status: 'idle',
      sample_files: 0,
      candidates_found: 0,
      finished_at: null,
    });
  });
});

describe('draftSkillName / slugifyRule', () => {
  it('names the skill after the repo, not the owner', () => {
    expect(draftSkillName('acme/payments-api')).toBe('payments-api-conventions');
  });

  it('handles a name with no owner segment', () => {
    expect(draftSkillName('payments-api')).toBe('payments-api-conventions');
  });

  it('turns a rule sentence into a short kebab heading', () => {
    expect(slugifyRule('Always use async/await instead of .then() chains')).toBe(
      'always-use-async-await-instead',
    );
  });

  it('never yields an empty heading', () => {
    expect(slugifyRule('!!!')).toBe('convention');
  });
});

describe('evidenceFilesOf', () => {
  it('dedupes and sorts, and drops rows with no citation', () => {
    expect(
      evidenceFilesOf([
        { evidencePath: 'src/b.ts' },
        { evidencePath: 'src/a.ts' },
        { evidencePath: 'src/b.ts' },
        { evidencePath: null },
      ]),
    ).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('buildSkillDraftBody', () => {
  const rows = [
    {
      rule: 'Always use async/await instead of .then() chains.',
      evidencePath: 'src/api/users.ts',
      evidenceSnippet: 'const user = await db.users.find(id);',
    },
    {
      rule: 'Redis access goes through the src/lib/redis.ts singleton.',
      evidencePath: 'src/lib/redis.ts',
      evidenceSnippet: 'export const redis = new Redis(config.redisUrl);',
    },
  ];

  it('emits one section per rule, with its evidence', () => {
    const body = buildSkillDraftBody('acme/payments-api', rows, 84);
    expect(body).toContain('# payments-api-conventions');
    expect(body).toContain('## always-use-async-await-instead');
    expect(body).toContain('Detected in `src/api/users.ts`:');
    expect(body).toContain('const user = await db.users.find(id);');
    expect(body).toContain('Derived from 2 accepted conventions over 84 sampled files.');
  });

  it('loses no rule text — the body IS the skill', () => {
    const body = buildSkillDraftBody('acme/payments-api', rows, 84);
    for (const r of rows) expect(body).toContain(r.rule);
  });

  it('is deterministic, so re-opening the modal cannot reshuffle a body mid-edit', () => {
    expect(buildSkillDraftBody('acme/payments-api', rows, 84)).toBe(
      buildSkillDraftBody('acme/payments-api', rows, 84),
    );
  });

  it('singularises the provenance line for one rule and one file', () => {
    expect(buildSkillDraftBody('acme/x', [rows[0]!], 1)).toContain(
      'Derived from 1 accepted convention over 1 sampled file.',
    );
  });

  it('omits the fence when a rule has evidence but no snippet', () => {
    const body = buildSkillDraftBody(
      'acme/x',
      [{ rule: 'A rule.', evidencePath: 'src/a.ts', evidenceSnippet: null }],
      3,
    );
    expect(body).toContain('Detected in `src/a.ts`:');
    expect(body).not.toContain('```');
  });
});
