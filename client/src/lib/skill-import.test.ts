import { describe, it, expect } from "vitest";
import {
  isExecutablePath,
  isNoisePath,
  nameFromFilename,
  parseSkillArchive,
  parseSkillMarkdown,
  pickCoreMarkdown,
  splitFrontmatter,
  type ArchiveEntry,
} from "./skill-import";

/**
 * The import parser is the whole security story of the import feature: it is
 * what guarantees only markdown is read and nothing is executed. The assertion
 * that matters most is `parseSkillArchive` never calling `text()` on a
 * non-markdown member — a regression there would be invisible in the UI, since
 * the preview would look exactly the same.
 */

describe("splitFrontmatter", () => {
  it("pulls flat key: value pairs out of a --- block", () => {
    const { meta, body } = splitFrontmatter(
      "---\nname: my-skill\ntype: rubric\n---\n# Heading\n\nText.",
    );
    expect(meta).toEqual({ name: "my-skill", type: "rubric" });
    expect(body).toBe("# Heading\n\nText.");
  });

  it("strips surrounding quotes from a value", () => {
    const { meta } = splitFrontmatter('---\ndescription: "Apply when: always"\n---\nBody');
    expect(meta.description).toBe("Apply when: always");
  });

  it("treats a document without frontmatter as all body", () => {
    const { meta, body } = splitFrontmatter("# Just markdown\n");
    expect(meta).toEqual({});
    expect(body).toBe("# Just markdown");
  });

  it("normalises CRLF and strips a BOM", () => {
    const { meta, body } = splitFrontmatter("﻿---\r\nname: x\r\n---\r\nBody\r\n");
    expect(meta).toEqual({ name: "x" });
    expect(body).toBe("Body");
  });

  it("leaves a line it cannot parse in the meta block alone rather than guessing", () => {
    const { meta } = splitFrontmatter("---\nname: ok\n- not: a scalar\n---\nBody");
    expect(meta).toEqual({ name: "ok" });
  });
});

describe("parseSkillMarkdown", () => {
  it("uses the frontmatter name, description and type", () => {
    const p = parseSkillMarkdown(
      "flake.md",
      "---\nname: test-flake-signals\ndescription: Apply when the diff adds a test.\ntype: convention\n---\n# Flake signals\n\nBody.",
    );
    expect(p).toMatchObject({
      name: "test-flake-signals",
      description: "Apply when the diff adds a test.",
      type: "convention",
      body: "# Flake signals\n\nBody.",
    });
    expect(p.warnings).toEqual([]);
  });

  it("falls back to the first heading when no name is declared, and warns", () => {
    const p = parseSkillMarkdown("whatever.md", "# Corner cases\n\nBody.");
    expect(p.name).toBe("Corner cases");
    expect(p.warnings.some((w) => w.includes("first heading"))).toBe(true);
  });

  it("falls back to the filename when there is no heading either", () => {
    const p = parseSkillMarkdown("some/path/my-rule.md", "Just a paragraph.");
    expect(p.name).toBe("my-rule");
    expect(p.warnings.some((w) => w.includes("filename"))).toBe(true);
  });

  it("warns when the description is missing — it is the skill's interface", () => {
    const p = parseSkillMarkdown("x.md", "---\nname: x\n---\nBody");
    expect(p.description).toBe("");
    expect(p.warnings.some((w) => w.includes("description"))).toBe(true);
  });

  it("downgrades an unknown type to custom and says so", () => {
    const p = parseSkillMarkdown("x.md", "---\nname: x\ntype: wizardry\n---\nBody");
    expect(p.type).toBe("custom");
    expect(p.warnings.some((w) => w.includes("wizardry"))).toBe(true);
  });
});

describe("pickCoreMarkdown", () => {
  it("prefers SKILL.md over any other markdown", () => {
    expect(pickCoreMarkdown(["docs/notes.md", "SKILL.md", "README.md"])).toBe("SKILL.md");
  });

  it("prefers the shallowest SKILL.md when there are several", () => {
    expect(pickCoreMarkdown(["a/b/SKILL.md", "a/SKILL.md"])).toBe("a/SKILL.md");
  });

  it("falls back to the shallowest markdown file", () => {
    expect(pickCoreMarkdown(["deep/dir/a.md", "b.md"])).toBe("b.md");
  });

  it("returns undefined when there is no markdown at all", () => {
    expect(pickCoreMarkdown(["run.sh", "manifest.json"])).toBeUndefined();
  });
});

describe("isExecutablePath / isNoisePath", () => {
  it.each(["hooks/run.sh", "bin/tool.py", "index.mjs", "lib/native.so"])(
    "flags %s as executable",
    (p) => expect(isExecutablePath(p)).toBe(true),
  );

  it.each(["SKILL.md", "manifest.json", "notes.txt", "LICENSE"])(
    "does not flag %s as executable",
    (p) => expect(isExecutablePath(p)).toBe(false),
  );

  it.each(["__MACOSX/._SKILL.md", ".DS_Store", "nested/.DS_Store", "somedir/"])(
    "treats %s as packaging noise",
    (p) => expect(isNoisePath(p)).toBe(true),
  );
});

describe("nameFromFilename", () => {
  it("drops the directory and the extension", () => {
    expect(nameFromFilename("bundle/skills/api-contract-gate.md")).toBe("api-contract-gate");
  });
});

describe("parseSkillArchive", () => {
  /** An entry whose `text()` records that it was read. */
  const entry = (path: string, text: string, log: string[]): ArchiveEntry => ({
    path,
    text: async () => {
      log.push(path);
      return text;
    },
  });

  it("reads ONLY the core markdown — no other member is even opened", async () => {
    const read: string[] = [];
    const preview = await parseSkillArchive("bundle.zip", [
      entry("SKILL.md", "---\nname: safe\ndescription: d\n---\nBody", read),
      entry("hooks/install.sh", "rm -rf /", read),
      entry("scripts/setup.py", "import os", read),
      entry("manifest.json", "{}", read),
    ]);

    expect(read).toEqual(["SKILL.md"]);
    expect(preview.name).toBe("safe");
    expect(preview.ignored).toEqual(["hooks/install.sh", "scripts/setup.py", "manifest.json"]);
    expect(preview.executable).toEqual(["hooks/install.sh", "scripts/setup.py"]);
  });

  it("warns about executable members so the preview can name them", async () => {
    const preview = await parseSkillArchive("bundle.zip", [
      entry("SKILL.md", "---\nname: x\ndescription: d\n---\nBody", []),
      entry("run.sh", "echo hi", []),
    ]);
    expect(preview.warnings.some((w) => w.includes("executable"))).toBe(true);
  });

  it("skips packaging noise instead of listing it as a dropped file", async () => {
    const preview = await parseSkillArchive("bundle.zip", [
      entry("SKILL.md", "---\nname: x\ndescription: d\n---\nBody", []),
      entry("__MACOSX/._SKILL.md", "junk", []),
      entry(".DS_Store", "junk", []),
    ]);
    expect(preview.ignored).toEqual([]);
  });

  it("rejects an archive with no markdown rather than importing something else", async () => {
    await expect(
      parseSkillArchive("bundle.zip", [entry("run.sh", "echo hi", [])]),
    ).rejects.toThrow(/No markdown file/);
  });
});
