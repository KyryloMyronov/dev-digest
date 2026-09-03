/**
 * JobRunner — per-kind deadlines.
 *
 * No Docker: `timeoutFor` is pure bookkeeping over `register`, so the runner is
 * built on a never-touched `Db` stub. The enqueue path that races the deadline
 * is covered with a real Postgres in `brief.it.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { JobRunner } from '../src/platform/jobs.js';
import type { Db } from '../src/db/client.js';

const noop = async () => undefined;

describe('JobRunner.timeoutFor', () => {
  it('a kind registered without an override races the runner default', () => {
    const runner = new JobRunner({} as Db);
    runner.register('poll_repo', noop);
    expect(runner.timeoutFor('poll_repo')).toBe(120_000);
    expect(runner.timeoutFor('never-registered')).toBe(120_000);
  });

  it('a kind registered with `timeoutMs` races its own deadline, and only that kind does', () => {
    const runner = new JobRunner({} as Db, { timeoutMs: 5_000 });
    runner.register('eval-batch', noop, { timeoutMs: 1_200_000 });
    runner.register('poll_repo', noop);
    expect(runner.timeoutFor('eval-batch')).toBe(1_200_000);
    expect(runner.timeoutFor('poll_repo')).toBe(5_000);
  });

  it('re-registering without an override drops the previous one', () => {
    const runner = new JobRunner({} as Db);
    runner.register('eval-batch', noop, { timeoutMs: 1_200_000 });
    runner.register('eval-batch', noop);
    expect(runner.timeoutFor('eval-batch')).toBe(120_000);
  });
});
