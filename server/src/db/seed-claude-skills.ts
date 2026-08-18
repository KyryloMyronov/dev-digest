import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import type { SkillSource, SkillType } from '@devdigest/shared';
import type { Db } from './client.js';
import * as t from './schema.js';

/**
 * Seeds the repo's own `.claude/skills/*​/SKILL.md` into the `skills` table, so
 * the Skills tab lists what the agent directory actually holds.
 *
 * These are two different systems that share a word, and this file is the only
 * bridge between them:
 *
 *   `.claude/skills/**`   files on disk, read by the coding agent
 *   the `skills` table    prompt fragments the studio lists and links to agents
 *
 * Nothing syncs them at run time. This runs at seed time only, so a `SKILL.md`
 * edited afterwards does NOT update its row — see "Refreshing" below.
 *
 * Read from disk rather than inlined the way `seed-prompts.ts` inlines prompt
 * bodies: the 18 files are ~180 KB of markdown that already have an owner, and a
 * copy pasted in here would be stale by the next skill edit.
 *
 * TWO DELIBERATE LIMITS, both worth knowing before trusting a row:
 *
 * 1. **Only `SKILL.md` becomes the body.** A skill's siblings (`check.mjs`,
 *    `rules.md`, `examples.md`) do not. For a documentation skill that loses
 *    nothing. For an executable one — `api-breaking-changes`, `source-scan` —
 *    the row describes a check the app cannot run, exactly as the studio's own
 *    import flow behaves (`client/src/lib/skill-import.ts` reads markdown and
 *    drops executables on purpose). The directory listing is preserved in
 *    `evidence_files` so the gap is visible in the row itself.
 * 2. **Nothing is linked to an agent.** `seed-skills.ts` links its four built-ins
 *    because they were written as review guidance. These were written for a
 *    coding agent, and 18 of them concatenated into the `## Skills / rules`
 *    section would swamp every review prompt. They are seeded enabled but
 *    unlinked; attach the ones you want in the agent's Skills tab.
 *
 * Refreshing: a row is inserted only when no skill of that name exists in the
 * workspace, matching `seedSkills`. Re-running never overwrites a body someone
 * edited in the UI. To pick up an edited `SKILL.md`, delete the row and re-seed.
 */

/** Where `.claude/skills` lives, found by walking up from this file. */
function findSkillsDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  // server/src/db → server/src → server → repo root. Walking rather than
  // `../../..` so this survives being run from `dist/` as well as under tsx.
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, '.claude', 'skills');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function unquote(value: string): string {
  const m = /^(['"])([\s\S]*)\1$/.exec(value.trim());
  return m ? m[2]!.replace(/\\"/g, '"') : value.trim();
}

interface ParsedSkill {
  name: string;
  description: string;
  source: SkillSource;
  body: string;
}

/**
 * Split YAML frontmatter from the markdown below it.
 *
 * A line-based read, not a YAML parse: every `SKILL.md` in this repo keeps its
 * top-level values on one line, and `^key:` under the `m` flag cannot match an
 * indented (nested) key, so `metadata:`/`tags:` blocks are skipped for free.
 */
function parseSkillFile(text: string, dirName: string): ParsedSkill {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const frontmatter = fence?.[1] ?? '';
  const body = (fence ? text.slice(fence[0].length) : text).trim();

  const read = (key: string): string | null => {
    const hit = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(frontmatter);
    return hit ? unquote(hit[1]!) : null;
  };

  // A skill declaring `source: community` in its frontmatter (typescript-expert)
  // is saying where it came from; honour it, otherwise these are extracted from
  // this repo's own filesystem.
  const declared = read('source');
  const source: SkillSource =
    declared === 'community' || declared === 'imported_url' ? declared : 'extracted';

  return {
    name: read('name') ?? dirName,
    description:
      read('description') ??
      `Agent skill from \`.claude/skills/${dirName}/SKILL.md\`. No description declared.`,
    source,
    body,
  };
}

/**
 * `SkillType` for a directory name. The repo's skills are overwhelmingly
 * "how we do this here" guidance, which is what `convention` means; the
 * checkers and the meta-skills have no better home than `custom`.
 * A new skill that matches nothing lands in `custom` — a wrong-but-visible
 * label, not a seed failure.
 */
function classify(name: string): SkillType {
  if (name.includes('security')) return 'security';
  if (/best-practices|patterns|architecture|table-design|testing-library|^zod$|^typescript-expert$/.test(name))
    return 'convention';
  return 'custom';
}

/** How many paths `evidence_files` carries before it stops being a useful list. */
const MAX_EVIDENCE_FILES = 40;

/**
 * Every file in the skill directory, repo-relative, for `evidence_files`.
 *
 * The cap is announced rather than silent: `zod` ships 47 files, and a list
 * that stops at 40 with no marker reads as "that is all of them".
 */
function listSkillFiles(skillDir: string, dirName: string): string[] {
  const all: string[] = [];
  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 2) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel, depth + 1);
      else all.push(`.claude/skills/${dirName}/${rel}`);
    }
  };
  walk(skillDir, '', 0);

  if (all.length <= MAX_EVIDENCE_FILES) return all;
  const kept = all.slice(0, MAX_EVIDENCE_FILES);
  kept.push(`… and ${all.length - MAX_EVIDENCE_FILES} more under .claude/skills/${dirName}/`);
  return kept;
}

/**
 * Insert one skill per `.claude/skills/*​/SKILL.md` that the workspace does not
 * already have. Returns how many rows were created.
 *
 * Never throws on a missing or unreadable directory — a seed that dies because
 * an optional agent-config folder is absent would block every fresh clone that
 * does not have one.
 */
export async function seedClaudeSkills(db: Db, workspaceId: string): Promise<number> {
  const skillsDir = findSkillsDir();
  if (!skillsDir) return 0;

  let dirs: string[];
  try {
    dirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return 0;
  }

  let created = 0;

  for (const dirName of dirs) {
    const file = join(skillsDir, dirName, 'SKILL.md');
    if (!existsSync(file)) continue;

    let parsed: ParsedSkill;
    try {
      parsed = parseSkillFile(readFileSync(file, 'utf8'), dirName);
    } catch {
      continue;
    }
    if (!parsed.body) continue; // a frontmatter-only file is not a skill

    const [existing] = await db
      .select({ id: t.skills.id })
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.name, parsed.name)));
    if (existing) continue;

    const [row] = await db
      .insert(t.skills)
      .values({
        workspaceId,
        name: parsed.name,
        description: parsed.description,
        type: classify(dirName),
        source: parsed.source,
        body: parsed.body,
        enabled: true,
        version: 1,
        evidenceFiles: listSkillFiles(join(skillsDir, dirName), dirName),
      })
      .returning({ id: t.skills.id });

    await db
      .insert(t.skillVersions)
      .values({ skillId: row!.id, version: 1, body: parsed.body })
      .onConflictDoNothing();

    created++;
  }

  return created;
}
