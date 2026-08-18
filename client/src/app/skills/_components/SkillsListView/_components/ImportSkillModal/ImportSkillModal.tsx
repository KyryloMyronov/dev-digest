/* ImportSkillModal — pick a .md or .zip, read it IN THE BROWSER, show exactly
   what would be saved, and save nothing until the user confirms.

   Two properties this screen exists to make visible:
     1. Nothing executes. An archive's scripts/binaries are listed and dropped;
        only markdown is read. No part of the file is uploaded before confirm.
     2. An imported body becomes instructions in an agent's prompt. The preview
        shows the full text, and the trust notice says so plainly. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Icon, Markdown, Modal } from "@devdigest/ui";
import { readSkillFile, type SkillImportPreview } from "../../../../../../lib/skill-import";
import { IMPORT_ACCEPT } from "../../constants";
import type { SkillDraft } from "../SkillEditorModal";
import { i } from "./styles";

export function ImportSkillModal({
  onClose,
  onAccept,
}: {
  onClose: () => void;
  /** Hands the parsed skill to the editor, where it is reviewed and saved. */
  onAccept: (draft: SkillDraft) => void;
}) {
  const t = useTranslations("skills");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [preview, setPreview] = React.useState<SkillImportPreview | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reading, setReading] = React.useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPreview(null);
    setFileName(file.name);
    setReading(true);
    try {
      setPreview(await readSkillFile(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("import.readFailed"));
    } finally {
      setReading(false);
    }
  };

  return (
    <Modal
      width={780}
      title={t("import.title")}
      subtitle={t("import.subtitle")}
      onClose={onClose}
      footer={
        <div style={i.footer}>
          <span style={i.footerNote}>{t("import.footerNote")}</span>
          <Button kind="ghost" size="sm" onClick={onClose}>
            {t("import.cancel")}
          </Button>
          <Button
            kind="primary"
            size="sm"
            disabled={!preview}
            onClick={() =>
              preview &&
              onAccept({
                name: preview.name,
                description: preview.description,
                type: preview.type,
                body: preview.body,
                // Recorded so the skill is badged as imported everywhere, and so
                // its prompt block carries `source: imported`.
                source: "imported_url",
              })
            }
          >
            {t("import.accept")}
          </Button>
        </div>
      }
    >
      <div style={i.body}>
        <input
          ref={inputRef}
          type="file"
          accept={IMPORT_ACCEPT}
          aria-label={t("import.fileLabel")}
          onChange={(ev) => void pick(ev.target.files?.[0])}
          style={i.fileInput}
        />

        <div style={i.picker}>
          <Icon.Upload size={16} style={{ color: "var(--text-muted)" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={i.pickerTitle}>{fileName ?? t("import.noFile")}</div>
            <div style={i.pickerHint}>{t("import.pickerHint")}</div>
          </div>
          <Button kind="secondary" size="sm" onClick={() => inputRef.current?.click()}>
            {t("import.choose")}
          </Button>
        </div>

        {reading && <div style={i.status}>{t("import.reading")}</div>}
        {error && (
          <div style={i.error} role="alert">
            {error}
          </div>
        )}

        {preview && (
          <>
            <div style={i.trustNotice}>
              <Icon.AlertTriangle size={14} style={{ color: "var(--warn)", flexShrink: 0 }} />
              <span>{t("import.trustNotice")}</span>
            </div>

            <div style={i.metaGrid}>
              <span style={i.metaKey}>{t("import.metaName")}</span>
              <span style={i.metaValue}>{preview.name}</span>
              <span style={i.metaKey}>{t("import.metaType")}</span>
              <span style={i.metaValue}>{t(`listItem.type.${preview.type}`)}</span>
              <span style={i.metaKey}>{t("import.metaSource")}</span>
              <span className="mono" style={i.metaValue}>
                {preview.sourceFile}
              </span>
              <span style={i.metaKey}>{t("import.metaDescription")}</span>
              <span style={i.metaValue}>
                {preview.description || t("import.noDescription")}
              </span>
            </div>

            {preview.warnings.length > 0 && (
              <ul style={i.warnings}>
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}

            {preview.ignored.length > 0 && (
              <div style={i.ignored}>
                <div style={i.ignoredHead}>
                  {t("import.ignoredTitle", { count: preview.ignored.length })}
                  {preview.executable.length > 0 && (
                    <Badge color="var(--warn)">
                      {t("import.executableCount", { count: preview.executable.length })}
                    </Badge>
                  )}
                </div>
                <ul style={i.ignoredList}>
                  {preview.ignored.map((path) => (
                    <li key={path} className="mono" style={i.ignoredItem}>
                      {path}
                      {preview.executable.includes(path) && (
                        <span style={i.execTag}>{t("import.executableTag")}</span>
                      )}
                    </li>
                  ))}
                </ul>
                <div style={i.ignoredNote}>{t("import.ignoredNote")}</div>
              </div>
            )}

            <div style={i.sectionLabel}>{t("import.bodyLabel")}</div>
            <div style={i.markdown}>
              <Markdown>{preview.body}</Markdown>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
