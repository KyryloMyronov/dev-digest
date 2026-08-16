import type { SkillType } from "@devdigest/shared";

/**
 * Skill import — parsing, entirely in the browser.
 *
 * A `.md` file or a `.zip` is read here, turned into a preview, and only saved
 * (as an ordinary `POST /skills`) once the user confirms it. Nothing is uploaded
 * before that, so an archive's non-markdown members never leave the machine, let
 * alone reach the API.
 *
 * The rule this module implements is narrow on purpose: **only markdown is
 * read**. An archive may carry scripts, manifests, hooks or binaries — the kind
 * of thing a skill for an agent-with-tools would ship. We list them so the user
 * can see what was in the bundle, and then drop them. There is no code path here
 * that runs, evaluates, resolves or fetches any of it.
 *
 * Everything below is a pure function over strings/bytes except `readSkillFile`,
 * which only adds `File` → bytes.
 */

/** Extensions that would be *executed* by the tool a foreign bundle came from. */
const EXECUTABLE_EXTENSIONS = [
  "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
  "py", "rb", "pl", "php", "lua",
  "js", "mjs", "cjs", "ts", "mts", "cts",
  "exe", "dll", "so", "dylib", "bin", "wasm",
];

/** Archive members skipped without even listing them — packaging noise. */
const NOISE_PATHS = [/(^|\/)__MACOSX\//, /(^|\/)\.DS_Store$/, /\/$/];

export interface SkillImportPreview {
  name: string;
  description: string;
  type: SkillType;
  body: string;
  /** The archive member (or filename) the body came from. */
  sourceFile: string;
  /** Members that were read as data and dropped — never executed. */
  ignored: string[];
  /** The subset of `ignored` that is executable; called out in the preview. */
  executable: string[];
  /** Things the author should know before accepting, e.g. a guessed name. */
  warnings: string[];
}

const VALID_TYPES: readonly SkillType[] = ["rubric", "convention", "security", "custom"];

/** `SKILL.md` first, else the shallowest markdown file, else nothing. */
export function pickCoreMarkdown(paths: string[]): string | undefined {
  const md = paths.filter((p) => /\.mdx?$/i.test(p));
  if (md.length === 0) return undefined;
  const named = md.filter((p) => /(^|\/)SKILL\.mdx?$/i.test(p));
  const pool = named.length > 0 ? named : md;
  // Shallowest wins, then alphabetical — deterministic for a given archive.
  return [...pool].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  )[0];
}

export function isExecutablePath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext !== undefined && ext !== path.toLowerCase() && EXECUTABLE_EXTENSIONS.includes(ext);
}

export function isNoisePath(path: string): boolean {
  return NOISE_PATHS.some((re) => re.test(path));
}

/**
 * Split YAML frontmatter from the body.
 *
 * Deliberately a minimal `key: value` reader rather than a YAML parser: skill
 * frontmatter across every tool that writes one is flat scalars, and pulling in
 * a full YAML engine would mean executing a parser over untrusted input to read
 * three strings. Anything it cannot understand is left in the body, where it is
 * harmless.
 */
export function splitFrontmatter(text: string): {
  meta: Record<string, string>;
  body: string;
} {
  const normalised = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalised);
  if (!match) return { meta: {}, body: normalised.trim() };

  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv?.[1]) continue;
    meta[kv[1].toLowerCase()] = (kv[2] ?? "").trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: normalised.slice(match[0].length).trim() };
}

/** Filename → a usable skill name: drop the extension, keep the slug. */
export function nameFromFilename(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.mdx?$/i, "").trim() || "imported-skill";
}

/** First markdown heading, if the body opens with one. */
function headingOf(body: string): string | undefined {
  return /^#{1,6}\s+(.+)$/m.exec(body)?.[1]?.trim();
}

/**
 * Parse one markdown skill into a preview.
 *
 * Missing metadata is filled in rather than rejected — a skill written for
 * another tool still imports, and the gaps are reported as warnings so the user
 * fixes them in the form instead of silently accepting a guess.
 */
export function parseSkillMarkdown(path: string, text: string): SkillImportPreview {
  const { meta, body } = splitFrontmatter(text);
  const warnings: string[] = [];

  let name = meta.name?.trim();
  if (!name) {
    const heading = headingOf(body);
    name = heading ?? nameFromFilename(path);
    warnings.push(
      heading
        ? `No "name" in frontmatter — using the first heading, "${name}".`
        : `No "name" in frontmatter — using the filename, "${name}".`,
    );
  }

  const description = (meta.description ?? "").trim();
  if (!description) {
    warnings.push(
      'No "description" in frontmatter. The description is the skill\'s interface — write one before saving.',
    );
  }

  const declaredType = meta.type?.trim().toLowerCase();
  let type: SkillType = "custom";
  if (declaredType && (VALID_TYPES as readonly string[]).includes(declaredType)) {
    type = declaredType as SkillType;
  } else if (declaredType) {
    warnings.push(`Unknown type "${declaredType}" — imported as "custom".`);
  }

  return {
    name,
    description,
    type,
    body,
    sourceFile: path,
    ignored: [],
    executable: [],
    warnings,
  };
}

/** A minimal archive reader's output — one path per member, with its bytes. */
export interface ArchiveEntry {
  path: string;
  text: () => Promise<string>;
}

/**
 * Build a preview from an archive's listing, reading ONLY the core markdown.
 *
 * Note the shape of this function: it takes entries whose contents are behind a
 * lazy `text()`, and calls it exactly once — on the core. Every other member is
 * recorded by path and never read at all.
 */
export async function parseSkillArchive(
  archiveName: string,
  entries: ArchiveEntry[],
): Promise<SkillImportPreview> {
  const members = entries.map((e) => e.path).filter((p) => !isNoisePath(p));
  const corePath = pickCoreMarkdown(members);
  if (!corePath) {
    throw new Error(
      `No markdown file in ${archiveName}. A skill archive must contain a SKILL.md (or another .md file).`,
    );
  }

  const core = entries.find((e) => e.path === corePath)!;
  const preview = parseSkillMarkdown(corePath, await core.text());

  const ignored = members.filter((p) => p !== corePath);
  const executable = ignored.filter(isExecutablePath);
  if (executable.length > 0) {
    preview.warnings.push(
      `${executable.length} executable file(s) in this archive were not read and will not be saved.`,
    );
  }

  return { ...preview, ignored, executable };
}

/**
 * Read a `File` through `FileReader` rather than `Blob.text()` /
 * `Blob.arrayBuffer()`.
 *
 * Those two are the obvious call, and they are what the browser would use — but
 * jsdom 25 implements neither, so the whole import path becomes untestable the
 * moment it depends on them. `FileReader` is present everywhere, including
 * jsdom, and costs one wrapper.
 */
function readFile(file: File, as: "text"): Promise<string>;
function readFile(file: File, as: "buffer"): Promise<ArrayBuffer>;
function readFile(file: File, as: "text" | "buffer"): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(reader.result as string | ArrayBuffer);
    if (as === "text") reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

/** Read a picked file into a preview. `.zip` goes through JSZip, `.md` direct. */
export async function readSkillFile(file: File): Promise<SkillImportPreview> {
  if (/\.zip$/i.test(file.name)) {
    // Imported lazily so the ~100kB unzip library is only fetched by someone who
    // actually imports an archive.
    const { default: JSZip } = await import("jszip");
    const zip = await JSZip.loadAsync(await readFile(file, "buffer"));
    const entries: ArchiveEntry[] = [];
    zip.forEach((path, entry) => {
      if (entry.dir) return;
      entries.push({ path, text: () => entry.async("string") });
    });
    return parseSkillArchive(file.name, entries);
  }
  if (!/\.mdx?$/i.test(file.name)) {
    throw new Error(`Unsupported file type. Import a .md file or a .zip containing one.`);
  }
  return parseSkillMarkdown(file.name, await readFile(file, "text"));
}
