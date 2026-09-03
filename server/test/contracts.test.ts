import { describe, it, expect } from 'vitest';
import {
  Review,
  Finding,
  Intent,
  BlastRadius,
  Risks,
  PrHistory,
  SmartDiff,
  Conformance,
  Onboarding,
  EvalRun,
  MemoryItem,
  RunTrace,
  Settings,
  Repo,
  PrDetail,
  PrFileSummariesResponse,
  FeatureModelId,
  EvalExpectedFinding,
  EvalCase,
  EvalCaseInput,
  EvalBatchRecord,
  EvalBatchAccepted,
  EvalBatchStatus,
  EvalDashboardAgentRow,
  EvalWorkspaceDashboard,
  EvalBatchEstimate,
  Agent,
  AgentVersionConfig,
} from '@devdigest/shared';

/**
 * Contract tests — parse/round-trip the fixtures from data.jsx/data2.jsx
 * so feature agents can rely on the schemas matching the prototype data.
 */
describe('AI contracts parse fixtures', () => {
  it('Review + Finding (data.jsx VERDICT/FINDINGS)', () => {
    const review = Review.parse({
      verdict: 'request_changes',
      summary: 'Two blockers before merge.',
      score: 61,
      findings: [
        {
          id: 'f1',
          severity: 'CRITICAL',
          category: 'security',
          title: 'Hardcoded Stripe secret key in commit',
          file: 'src/config.ts',
          start_line: 12,
          end_line: 12,
          rationale: 'Line 12 contains a literal `sk_live_` Stripe key.',
          suggestion: 'Move to env and rotate.',
          confidence: 0.98,
          kind: 'secret_leak',
        },
      ],
    });
    expect(review.findings).toHaveLength(1);
    expect(review.score).toBe(61);
  });

  it('lethal-trifecta Finding variant', () => {
    const f = Finding.parse({
      id: 'f2',
      severity: 'CRITICAL',
      category: 'security',
      title: 'Lethal trifecta',
      file: 'src/api/public/webhooks.ts',
      start_line: 61,
      end_line: 74,
      rationale: 'all three legs present',
      confidence: 0.79,
      kind: 'lethal_trifecta',
      trifecta_components: ['private_data_access', 'untrusted_input', 'exfil_path'],
      evidence: [{ component: 'untrusted_input', file: 'src/api/public/webhooks.ts', line: 61 }],
    });
    expect(f.trifecta_components).toContain('exfil_path');
  });

  it('Intent / BlastRadius / Risks / PrHistory', () => {
    expect(() =>
      Intent.parse({ intent: 'x', in_scope: ['a'], out_of_scope: ['b'] }),
    ).not.toThrow();
    expect(() =>
      BlastRadius.parse({
        changed_symbols: [{ name: 'rateLimit', file: 'a.ts', kind: 'function' }],
        downstream: [
          {
            symbol: 'rateLimit',
            callers: [{ name: 'publicRouter', file: 'b.ts', line: 23 }],
            endpoints_affected: ['GET /x'],
            crons_affected: ['c'],
          },
        ],
        summary: 's',
      }),
    ).not.toThrow();
    expect(() =>
      // SPEC-02 retyped `Risk`: `severity` moved from RiskSeverity
      // (high|medium|low) to the product's Severity, and the shape gained the
      // citation fields `file` / `start_line` / `end_line`. `file_refs` is now
      // `.nullish()` legacy. The fixture follows the contract; nothing is
      // loosened here.
      Risks.parse({
        risks: [
          {
            kind: 'security',
            title: 't',
            explanation: 'e',
            severity: 'CRITICAL',
            file: 'src/a.ts',
            start_line: 10,
            end_line: 12,
            file_refs: [],
          },
        ],
      }),
    ).not.toThrow();
    // The citation fields are REQUIRED — a risk with no line range must not parse.
    expect(() =>
      Risks.parse({
        risks: [{ kind: 'security', title: 't', explanation: 'e', severity: 'CRITICAL' }],
      }),
    ).toThrow();
    expect(() =>
      PrHistory.parse({
        history: [
          {
            pr_number: 401,
            title: 't',
            merged_at: '2026-03-18',
            author: 'a',
            files_overlap: [],
            notes: 'n',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('SmartDiff (data.jsx DIFF)', () => {
    const d = SmartDiff.parse({
      groups: [
        {
          role: 'core',
          files: [{ path: 'a.ts', additions: 84, deletions: 0, finding_lines: [28, 52] }],
        },
      ],
      split_suggestion: { too_big: false, total_lines: 285, proposed_splits: [] },
    });
    expect(d.groups[0]!.role).toBe('core');
  });

  it('Conformance / Onboarding / EvalRun / MemoryItem', () => {
    expect(() =>
      Conformance.parse({
        spec_id: 's1',
        spec_title: 'Spec',
        items: [{ requirement: 'r', status: 'implemented' }],
        completeness_pct: 80,
      }),
    ).not.toThrow();
    expect(() =>
      Onboarding.parse({
        sections: [{ kind: 'architecture', title: 'T', body: 'b', links: [] }],
      }),
    ).not.toThrow();
    expect(() =>
      EvalRun.parse({
        recall: 0.82,
        precision: 0.91,
        citation_accuracy: 0.95,
        traces_passed: 17,
        traces_total: 20,
        duration_ms: 12000,
        cost_usd: 0.23,
        per_trace: [{ name: 't01', pass: true, expected: 'x', actual: 'x' }],
      }),
    ).not.toThrow();
    expect(() =>
      MemoryItem.parse({
        content: 'c',
        scope: 'team',
        kind: 'decision',
        confidence: 0.92,
        sources: [{ pr: 401, context: 'ctx' }],
      }),
    ).not.toThrow();
  });

  it('RunTrace (data2.jsx TRACE single-document)', () => {
    const trace = RunTrace.parse({
      config: { agent: 'Security Reviewer', version: 'v7', model: 'gpt-4.1', pr: 482, source: 'local' },
      stats: {
        duration_ms: 8200,
        tokens_in: 14820,
        tokens_out: 1240,
        cost_usd: 0.0396,
        findings: 3,
        grounding: '3/3 passed',
      },
      prompt_assembly: { system: 's', user: 'u' },
      tool_calls: [{ tool: 'read_file', args: "'src/config.ts'", meta: '1,240 bytes', ms: 120 }],
      raw_output: '{}',
      memory_pulled: [{ pr: 288, text: 'verified via stripe-signature' }],
      specs_read: ['specs/security-baseline.md'],
      log: [{ t: '00.00', kind: 'info', msg: 'started' }],
    });
    expect(trace.tool_calls).toHaveLength(1);
  });
});

describe('SPEC-03 file summaries', () => {
  it('PrFileSummariesResponse — a null cost and a real cost both parse, and null survives', () => {
    const parsed = PrFileSummariesResponse.parse({
      summaries: [
        {
          path: 'src/middleware/ratelimit.ts',
          summary: 'Adds a token-bucket limiter keyed on bucketKey.',
          head_sha: 'abc1234',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash',
          tokens_in: 1200,
          tokens_out: 25,
          // Unpriced model — NOT the same fact as 0, and must not be coalesced.
          cost_usd: null,
          created_at: '2026-08-28T10:00:00.000Z',
        },
        {
          path: 'src/config.ts',
          summary: 'Reads the limiter window from the environment.',
          head_sha: 'abc1234',
          cost_usd: 0.0031,
          created_at: '2026-08-28T10:00:00.000Z',
        },
      ],
      omitted_files: ['src/huge.ts'],
      selected: 2,
      total: 3,
    });
    expect(parsed.summaries[0]!.cost_usd).toBeNull();
    expect(parsed.summaries[1]!.cost_usd).toBe(0.0031);
    // `.nullish()` fields may be absent entirely.
    expect(parsed.summaries[1]!.provider).toBeUndefined();
    expect(parsed.omitted_files).toEqual(['src/huge.ts']);
  });

  it('PrFileSummariesResponse — cost_usd is required (nullable, not optional)', () => {
    expect(() =>
      PrFileSummariesResponse.parse({
        summaries: [
          {
            path: 'a.ts',
            summary: 's',
            head_sha: 'sha',
            created_at: '2026-08-28T10:00:00.000Z',
          },
        ],
        omitted_files: [],
        selected: 1,
        total: 1,
      }),
    ).toThrow();
  });

  it('FeatureModelId accepts the new file_summary id', () => {
    expect(FeatureModelId.parse('file_summary')).toBe('file_summary');
  });
});

describe('platform DTOs', () => {
  it('Settings defaults + passthrough', () => {
    const s = Settings.parse({ extra_key: 'x' });
    expect(s.theme).toBe('dark');
    expect((s as Record<string, unknown>).extra_key).toBe('x');
  });

  it('Repo + PrDetail', () => {
    expect(() =>
      Repo.parse({
        id: 'r1',
        workspace_id: 'w1',
        owner: 'acme',
        name: 'payments-api',
        full_name: 'acme/payments-api',
        default_branch: 'main',
        clone_path: null,
        last_polled_at: null,
        created_by: null,
      }),
    ).not.toThrow();
    expect(() =>
      PrDetail.parse({
        number: 482,
        title: 't',
        author: 'a',
        branch: 'b',
        base: 'main',
        head_sha: 'sha',
        additions: 1,
        deletions: 0,
        files_count: 1,
        status: 'open',
        files: [],
        commits: [],
      }),
    ).not.toThrow();
  });

  it('SPEC-04 — EvalExpectedFinding fills end_line from start_line (AC-21)', () => {
    // AC-21 is a TRANSFORM, not a literal: assert the derived value, not that a
    // fixture with both fields round-trips.
    const one = EvalExpectedFinding.parse({ file: 'a.ts', start_line: 12 });
    expect(one.end_line).toBe(12);
    // An explicit end_line survives untouched.
    expect(EvalExpectedFinding.parse({ file: 'a.ts', start_line: 12, end_line: 40 }).end_line).toBe(
      40,
    );
    // The optional descriptive fields are genuinely optional (a hand-written
    // case carries no id/rationale/confidence — that is why this is not Finding).
    expect(() => EvalExpectedFinding.parse({ start_line: 1 })).toThrow();
    expect(() => EvalExpectedFinding.parse({ file: '', start_line: 1 })).toThrow();
  });

  it('SPEC-04 — EvalCaseInput defaults expectation to must_find (AC-25) and caps at 20 (AC-109)', () => {
    const parsed = EvalCaseInput.parse({
      owner_kind: 'agent',
      owner_id: 'a1',
      name: 'no-expectation-given',
      expected_output: [{ file: 'a.ts', start_line: 3 }],
    });
    // AC-25: the field is absent on the wire and PRESENT in the parsed value.
    expect(parsed.expectation).toBe('must_find');
    // AC-21 applies through the array too.
    expect(parsed.expected_output[0].end_line).toBe(3);
    expect(parsed.input_diff).toBe('');

    // AC-109 — 20 passes, 21 does not.
    const entry = { file: 'a.ts', start_line: 1 };
    const base = { owner_kind: 'agent' as const, owner_id: 'a1', name: 'n' };
    expect(() =>
      EvalCaseInput.parse({ ...base, expected_output: Array.from({ length: 20 }, () => entry) }),
    ).not.toThrow();
    expect(() =>
      EvalCaseInput.parse({ ...base, expected_output: Array.from({ length: 21 }, () => entry) }),
    ).toThrow();
  });

  it('SPEC-04 — EvalCase carries a parsed expectation and expected_output', () => {
    const parsed = EvalCase.parse({
      id: 'c1',
      owner_kind: 'agent',
      owner_id: 'a1',
      name: 'stripe-key-leak',
      input_diff: 'diff --git a/a.ts b/a.ts',
      input_files: null,
      input_meta: { head_sha: 'abc', source_finding_ids: ['f1'] },
      expected_output: [{ file: 'a.ts', start_line: 12 }],
      expectation: 'must_not_flag',
      notes: null,
    });
    expect(parsed.expectation).toBe('must_not_flag');
    expect(parsed.expected_output[0].end_line).toBe(12);
    // AC-22 — an empty array is legal on the shape; the must_find/empty refusal
    // (AC-23) is the service's, not the schema's.
    expect(() =>
      EvalCase.parse({ ...parsed, expected_output: [], expectation: 'must_not_flag' }),
    ).not.toThrow();
  });

  it('SPEC-04 — EvalBatchRecord: running is a status, and null metrics are legal (D-1, D-2)', () => {
    expect(EvalBatchStatus.options).toEqual(['running', 'complete', 'partial', 'failed']);
    const inFlight = EvalBatchRecord.parse({
      batch_id: 'b1',
      agent_id: 'a1',
      agent_name: 'Security Reviewer',
      agent_version: 7,
      ran_at: '2026-09-03T00:00:00.000Z',
      trigger: 'manual',
      status: 'running',
      recall: null,
      precision: null,
      citation_accuracy: null,
      traces_passed: 0,
      traces_total: 0,
      cases_ran: 0,
      cases_total: 5,
      cost_usd: null,
    });
    expect(inFlight.status).toBe('running');
    // `.nullable()`, NOT `.optional()` — the studio must RECEIVE the null and
    // render a placeholder; an absent key and `null` are different facts.
    expect(() => EvalBatchRecord.parse({ ...inFlight, recall: undefined })).toThrow();
  });

  it('SPEC-04 — EvalBatchAccepted / estimate / workspace dashboard', () => {
    expect(() =>
      EvalBatchAccepted.parse({ status: 'accepted', batch_id: 'b1', cases: 3 }),
    ).not.toThrow();
    // A skipped agent in a workspace-wide run: no batch, a stated reason.
    expect(() =>
      EvalBatchAccepted.parse({
        status: 'accepted',
        batch_id: null,
        cases: 0,
        degraded: true,
        reason: 'config_error',
      }),
    ).not.toThrow();
    expect(() => EvalBatchAccepted.parse({ status: 'queued', batch_id: null, cases: 0 })).toThrow();

    // est_cost_usd is nullable: "no priced batch to extrapolate from" is not $0.
    const est = EvalBatchEstimate.parse({ agents: 2, cases: 9, est_cost_usd: null });
    expect(est.est_cost_usd).toBeNull();

    const row = EvalDashboardAgentRow.parse({
      agent_id: 'a1',
      agent_name: 'Security Reviewer',
      agent_version: 7,
      enabled: true,
      cases_total: 5,
      latest_batch_id: null,
      latest_ran_at: null,
      recall: null,
      precision: null,
      citation_accuracy: null,
      traces_passed: null,
      traces_total: null,
      cost_usd: null,
    });
    const dash = EvalWorkspaceDashboard.parse({ agents: [row], batches: [], cases_total: 5 });
    expect(dash.agents).toHaveLength(1);
  });

  it('SPEC-04 — Agent.auto_eval defaults to false; AgentVersionConfig accepts restored_from', () => {
    const agent = Agent.parse({
      id: 'a1',
      name: 'Security Reviewer',
      description: 'd',
      provider: 'openai',
      model: 'gpt-4.1',
      system_prompt: 'p',
      enabled: true,
      version: 7,
    });
    expect(agent.auto_eval).toBe(false);
    expect(Agent.parse({ ...agent, auto_eval: true }).auto_eval).toBe(true);

    // `toAgentVersionDto` parses this shape on EVERY version read, so a snapshot
    // written WITH restored_from must parse, and one written WITHOUT it too.
    const cfg = {
      provider: 'openai' as const,
      model: 'gpt-4.1',
      system_prompt: 'p',
      strategy: 'single-pass' as const,
      ci_fail_on: 'critical' as const,
      repo_intel: true,
      skills: [],
    };
    expect(AgentVersionConfig.parse(cfg).restored_from ?? null).toBeNull();
    expect(AgentVersionConfig.parse({ ...cfg, restored_from: 6 }).restored_from).toBe(6);
  });
});
