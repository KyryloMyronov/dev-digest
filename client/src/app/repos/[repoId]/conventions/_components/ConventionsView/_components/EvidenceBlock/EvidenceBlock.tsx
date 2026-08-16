/* The evidence behind one convention: the file it was found in, plus the excerpt
   that shows the rule being followed.

   No line numbers here on purpose — the citation is a `path` and a few lines, and
   a gutter would imply the excerpt's line numbers match the file's, which they do
   not. The line-numbered view belongs to the skill body, where the text IS the
   whole document. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@devdigest/ui";
import { ev } from "../../styles";
import { COPIED_RESET_MS } from "./constants";

export function EvidenceBlock({ path, code }: { path: string; code: string }) {
  const t = useTranslations("conventions");
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // A re-scan unmounts cards mid-timer, so the reset has to be cancellable —
  // otherwise it fires setState on a component that is gone.
  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = () => {
    void navigator.clipboard?.writeText(code);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  return (
    <div style={ev.root}>
      <div style={ev.head}>
        <span className="mono" style={ev.path} title={path}>
          {path}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={t("evidence.copy")}
          title={copied ? t("evidence.copied") : t("evidence.copy")}
          style={ev.copyBtn}
        >
          {copied ? <Icon.Check size={12} /> : <Icon.Copy size={12} />}
        </button>
      </div>
      <pre className="mono" style={ev.pre}>
        {code}
      </pre>
    </div>
  );
}
