/* The skill body, as a small file view: a filename header with a token count, and
   a line-numbered preview that toggles into a plain editor.

   TWO deliberate departures worth knowing about:

   1. The edit mode uses a RAW <textarea>, not the kit's `Textarea`, which
      `client/CLAUDE.md` would normally forbid. The kit component destructures a
      closed prop set and forwards no `...rest`, so it can carry neither an
      `aria-label` nor an id — and there is no visible label to associate, since
      the header is shared with the preview. Its fixed font metrics also cannot be
      matched to the preview's line grid, so toggling would reflow the text.

   2. The preview colours whole HEADING LINES only, with a regex. That is exactly
      what the design shows, and it keeps this dependency-free — a syntax
      highlighter is a new dependency for two shades of one token type. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Icon, IconBtn } from "@devdigest/ui";
import { bodyLines, isHeadingLine } from "../../helpers";
import { bodyEditor as b } from "../../styles";

export function SkillBodyEditor({
  filename,
  value,
  onChange,
  dirty,
  tokens,
}: {
  filename: string;
  value: string;
  onChange: (v: string) => void;
  /** True once the user has edited — drives the badge and the "~" token label. */
  dirty: boolean;
  tokens: number;
}) {
  const t = useTranslations("conventions");
  const [editing, setEditing] = React.useState(false);

  return (
    <div style={b.root}>
      <div style={b.head}>
        <Icon.FileText size={13} />
        <span className="mono" style={b.filename}>
          {filename}
        </span>
        {dirty && <Badge>{t("body.unsaved")}</Badge>}
        <span style={b.headSpacer} />
        <span className="mono tnum" style={b.tokens}>
          {dirty ? t("body.tokensApprox", { count: tokens }) : t("body.tokens", { count: tokens })}
        </span>
        <IconBtn
          icon={editing ? "Eye" : "Edit"}
          label={editing ? t("body.preview") : t("body.edit")}
          size={26}
          onClick={() => setEditing((e) => !e)}
        />
      </div>

      {editing ? (
        <textarea
          className="mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={t("body.editLabel")}
          style={b.textarea}
        />
      ) : (
        <div style={b.scroll}>
          {bodyLines(value).map((line, i) => (
            <div key={i} style={b.line}>
              <span className="mono tnum" style={b.gutter}>
                {i + 1}
              </span>
              <span
                className="mono"
                style={{ ...b.text, ...(isHeadingLine(line) ? b.heading : b.plain) }}
              >
                {/* A non-breaking space holds the row's height on a blank line. */}
                {line === "" ? " " : line}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
