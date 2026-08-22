import { describe, expect, it } from 'vitest';
import { CHARACTER_LIMIT, errorResult, guarded, jsonResult, truncate } from '../src/format.js';
import { ApiError, matchRepo, type Repo } from '../src/api.js';

describe('truncate', () => {
  it('returns short strings unchanged', () => {
    expect(truncate('abc', 5)).toBe('abc');
  });
  it('cuts long strings to max length with an ellipsis', () => {
    const out = truncate('a'.repeat(100), 10);
    expect(out).toHaveLength(10);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('jsonResult', () => {
  it('serializes compact JSON', () => {
    expect(jsonResult({ a: 1 }).content[0].text).toBe('{"a":1}');
  });
  it('caps oversized payloads and appends the narrowing hint', () => {
    const big = { blob: 'x'.repeat(CHARACTER_LIMIT * 2) };
    const text = jsonResult(big, 'use limit').content[0].text;
    expect(text.length).toBeLessThan(CHARACTER_LIMIT + 200);
    expect(text).toContain('use limit');
  });
});

describe('guarded', () => {
  it('maps ApiError to an isError result', async () => {
    const fn = guarded(async () => {
      throw new ApiError('boom');
    });
    const res = await fn();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Error: boom');
  });
  it('rethrows unexpected errors', async () => {
    const fn = guarded(async () => {
      throw new TypeError('bug');
    });
    await expect(fn()).rejects.toThrow(TypeError);
  });
  it('passes results through untouched', async () => {
    const res = await guarded(async () => errorResult('x'))();
    expect(res.content[0].text).toBe('Error: x');
  });
});

describe('matchRepo', () => {
  const repos: Repo[] = [
    { id: '1', owner: 'acme', name: 'web', full_name: 'acme/web' },
    { id: '2', owner: 'acme', name: 'api', full_name: 'acme/api' },
    { id: '3', owner: 'other', name: 'api', full_name: 'other/api' },
  ];
  it('matches exact full_name', () => {
    expect(matchRepo(repos, 'acme/api')).toMatchObject({ id: '2' });
  });
  it('matches unique short name', () => {
    expect(matchRepo(repos, 'web')).toMatchObject({ id: '1' });
  });
  it('returns all candidates when the short name is ambiguous', () => {
    const out = matchRepo(repos, 'api');
    expect(Array.isArray(out)).toBe(true);
    expect((out as Repo[]).length).toBe(2);
  });
  it('falls back to case-insensitive substring', () => {
    expect(matchRepo(repos, 'ACME/W')).toMatchObject({ id: '1' });
  });
  it('returns empty array when nothing matches', () => {
    expect(matchRepo(repos, 'nope')).toEqual([]);
  });
});
