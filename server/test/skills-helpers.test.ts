import { describe, it, expect } from 'vitest';
import { skillPromptBlock, toSkillDto } from '../src/modules/_shared/skills.js';
import { isBodyChange, toSkillVersionDto } from '../src/modules/skills/helpers.js';
import type { SkillRow } from '../src/db/rows.js';

/**
 * Unit coverage for the skills mappers and the prompt-block renderer.
 *
 * `skillPromptBlock` is the one place where the trust decision for skills is
 * expressed: a skill's body goes into the prompt as INSTRUCTIONS, and an
 * imported one is distinguished by a visible label rather than by containment.
 * Both halves of that are asserted here, because "imported skills are wrapped in
 * <untrusted>" is the change someone will reach for later, and it would silently
 * neuter every imported skill instead of failing.
 */

const ROW: SkillRow = {
  id: 'sk-1',
  workspaceId: 'ws-1',
  name: 'uncovered-branches',
  description: 'Apply when the diff adds a conditional.',
  type: 'rubric',
  source: 'manual',
  body: '# Uncovered branches\n\nEnumerate the outcomes.',
  enabled: true,
  version: 3,
  evidenceFiles: null,
  createdAt: new Date('2026-08-08T10:00:00.000Z'),
};

describe('toSkillDto', () => {
  it('maps camelCase row keys onto the snake_case wire shape', () => {
    expect(toSkillDto(ROW)).toEqual({
      id: 'sk-1',
      name: 'uncovered-branches',
      description: 'Apply when the diff adds a conditional.',
      type: 'rubric',
      source: 'manual',
      body: '# Uncovered branches\n\nEnumerate the outcomes.',
      enabled: true,
      version: 3,
      evidence_files: null,
    });
  });

  it('normalises a missing evidence_files to null, not undefined', () => {
    // The contract declares it .nullish(); serialising `undefined` would drop
    // the key entirely and make the client branch on absence instead of null.
    expect(toSkillDto({ ...ROW, evidenceFiles: null }).evidence_files).toBeNull();
  });
});

describe('toSkillVersionDto', () => {
  it('renders created_at as an ISO string, never a Date', () => {
    const dto = toSkillVersionDto({
      skillId: 'sk-1',
      version: 2,
      body: 'older body',
      createdAt: new Date('2026-08-01T09:30:00.000Z'),
    });
    expect(dto).toEqual({
      skill_id: 'sk-1',
      version: 2,
      body: 'older body',
      created_at: '2026-08-01T09:30:00.000Z',
    });
  });
});

describe('isBodyChange', () => {
  it('is true only when the patch carries a DIFFERENT body', () => {
    expect(isBodyChange(ROW, { body: 'new body' })).toBe(true);
  });

  it('is false when the patch repeats the current body', () => {
    // Saving the editor without touching the text must not manufacture a
    // version — the history is meant to show real edits.
    expect(isBodyChange(ROW, { body: ROW.body })).toBe(false);
  });

  it('is false for a metadata-only patch', () => {
    expect(isBodyChange(ROW, {})).toBe(false);
  });
});

describe('skillPromptBlock', () => {
  it('renders the name, type and version in the heading', () => {
    const block = skillPromptBlock(toSkillDto(ROW));
    expect(block.split('\n')[0]).toBe('### Skill: uncovered-branches (rubric · v3)');
  });

  it('puts the description above the body as the skill’s interface', () => {
    const block = skillPromptBlock(toSkillDto(ROW));
    expect(block).toContain('Apply when the diff adds a conditional.');
    expect(block.indexOf('Apply when')).toBeLessThan(block.indexOf('# Uncovered branches'));
  });

  it('omits the description line entirely when there is none', () => {
    const block = skillPromptBlock(toSkillDto({ ...ROW, description: '   ' }));
    expect(block).toBe('### Skill: uncovered-branches (rubric · v3)\n# Uncovered branches\n\nEnumerate the outcomes.');
  });

  it.each(['imported_url', 'community'] as const)('labels a %s skill as imported', (source) => {
    const block = skillPromptBlock(toSkillDto({ ...ROW, source }));
    expect(block.split('\n')[0]).toBe(
      '### Skill: uncovered-branches (rubric · v3 · source: imported)',
    );
  });

  it.each(['manual', 'extracted'] as const)('does not label a %s skill as imported', (source) => {
    expect(skillPromptBlock(toSkillDto({ ...ROW, source }))).not.toContain('source: imported');
  });

  it('does NOT wrap the body in <untrusted> — a skill is instructions', () => {
    // Wrapping would hand the body to INJECTION_GUARD, which tells the model
    // everything inside those delimiters is inert data. An imported skill would
    // then be attached, visible in the trace, and completely without effect.
    const block = skillPromptBlock(toSkillDto({ ...ROW, source: 'community' }));
    expect(block).not.toContain('<untrusted');
  });
});
