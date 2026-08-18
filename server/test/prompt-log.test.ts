import { describe, it, expect, beforeEach } from 'vitest';
import type { PromptSectionMetric } from '@devdigest/reviewer-core';
import { logPromptAssembly } from '../src/platform/prompt-log.js';
import { loadConfig } from '../src/platform/config.js';

/**
 * The prompt-assembly logger.
 *
 * The claim this file exists to hold up is a SECURITY claim — "no prompt content
 * can reach the log stream" — so it is asserted against the serialised payload,
 * not against the shape of the call.
 */

const SECTIONS: PromptSectionMetric[] = [
  { name: 'system', source: 'agent', untrusted: false, chars: 1200 },
  { name: '## PR description', source: 'pr-description', untrusted: true, chars: 340 },
  { name: '## Project context', source: 'spec', untrusted: true, chars: 5000, tokens: 1250 },
  { name: '## Diff to review', source: 'diff', untrusted: true, chars: 18_000, tokens: 4500 },
];

const CTX = {
  correlationId: 'corr-1',
  stage: 'review',
  provider: 'openai',
  model: 'gpt-4.1',
  runId: 'run-1',
  prId: 'pr-1',
};

interface Line {
  level: 'info' | 'debug' | 'warn' | 'error';
  obj: unknown;
  msg?: string;
}

let lines: Line[];
const log = {
  info: (obj: unknown, msg?: string) => lines.push({ level: 'info', obj, msg }),
  debug: (obj: unknown, msg?: string) => lines.push({ level: 'debug', obj, msg }),
  warn: (obj: unknown, msg?: string) => lines.push({ level: 'warn', obj, msg }),
  error: (obj: unknown, msg?: string) => lines.push({ level: 'error', obj, msg }),
};

beforeEach(() => {
  lines = [];
});

describe('logPromptAssembly', () => {
  it('always emits one summary line with the model, sizes and correlation id', () => {
    logPromptAssembly(log, CTX, SECTIONS, { verbose: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('info');
    expect(lines[0]!.obj).toMatchObject({
      event: 'prompt_assembly',
      correlationId: 'corr-1',
      stage: 'review',
      provider: 'openai',
      model: 'gpt-4.1',
      runId: 'run-1',
      prId: 'pr-1',
      sections: 4,
      chars: 24_540,
      // Separately totalled: "how much of this prompt was external data" is the
      // number worth watching when a review starts behaving oddly.
      untrustedChars: 23_340,
      tokens: 5750,
    });
  });

  it('adds one DEBUG line per section only in verbose mode', () => {
    logPromptAssembly(log, CTX, SECTIONS, { verbose: true });
    const debug = lines.filter((l) => l.level === 'debug');
    expect(debug).toHaveLength(4);
    expect(debug[3]!.obj).toMatchObject({
      event: 'prompt_section',
      name: '## Diff to review',
      source: 'diff',
      untrusted: true,
      chars: 18_000,
      tokens: 4500,
      correlationId: 'corr-1',
    });
  });

  it('logs NO section content — in either mode', () => {
    // A metric has no field that could hold text, so this is really asserting
    // that the logger does not invent one (a preview, a first line, a sample).
    logPromptAssembly(log, CTX, SECTIONS, { verbose: true });
    const serialised = JSON.stringify(lines);
    for (const forbidden of ['diff --git', 'sk_live', 'BEGIN PRIVATE KEY', '<untrusted']) {
      expect(serialised).not.toContain(forbidden);
    }
    // No key OUTSIDE this allowlist ever appears on a section line. Stated as a
    // subset rather than an equality because `tokens` is present only when a
    // counter ran — an equality here would fail for the honest reason and pass
    // for the dangerous one (a new content-bearing key added to the allowlist).
    const ALLOWED = new Set([
      'event',
      'correlationId',
      'stage',
      'runId',
      'name',
      'source',
      'untrusted',
      'chars',
      'tokens',
    ]);
    for (const line of lines.filter((l) => l.level === 'debug')) {
      for (const key of Object.keys(line.obj as object)) {
        expect(ALLOWED.has(key), `unexpected key on a section log line: ${key}`).toBe(true);
      }
    }
  });

  it('omits token totals entirely when nothing was counted', () => {
    const noTokens = SECTIONS.map(({ tokens: _t, ...rest }) => rest);
    logPromptAssembly(log, CTX, noTokens, { verbose: false });
    expect(lines[0]!.obj).not.toHaveProperty('tokens');
    expect(lines[0]!.msg).not.toContain('tokens');
  });

  it('is a no-op without a logger', () => {
    expect(() => logPromptAssembly(undefined, CTX, SECTIONS, { verbose: true })).not.toThrow();
  });
});

describe('PROMPT_LOG_VERBOSE is local-only', () => {
  const base = { DATABASE_URL: 'postgres://x/y' } as NodeJS.ProcessEnv;

  it('is honoured in development', () => {
    const c = loadConfig({ ...base, NODE_ENV: 'development', PROMPT_LOG_VERBOSE: 'true' });
    expect(c.promptLogVerbose).toBe(true);
    expect(c.promptLogVerboseSuppressed).toBe(false);
  });

  it('is REFUSED in production, and says so', () => {
    const c = loadConfig({ ...base, NODE_ENV: 'production', PROMPT_LOG_VERBOSE: 'true' });
    expect(c.promptLogVerbose).toBe(false);
    // The flag being ignored must be observable — app.ts warns on this.
    expect(c.promptLogVerboseSuppressed).toBe(true);
  });

  it('defaults off, and is not "suppressed" when it was never asked for', () => {
    const c = loadConfig({ ...base, NODE_ENV: 'production' });
    expect(c.promptLogVerbose).toBe(false);
    expect(c.promptLogVerboseSuppressed).toBe(false);
  });
});
