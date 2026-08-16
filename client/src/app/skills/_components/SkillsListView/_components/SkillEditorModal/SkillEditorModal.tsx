/* SkillEditorModal — create a skill, or edit an existing one. The same form
   serves both, and the import flow hands it a pre-filled draft so an imported
   skill is reviewed and corrected in exactly the same fields before it is
   saved. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import { Button, FormField, Modal, SelectInput, Textarea, TextInput } from "@devdigest/ui";
import type { Skill, SkillSource, SkillType } from "@devdigest/shared";
import { useCreateSkill, useUpdateSkill } from "../../../../../../lib/hooks/skills";
import { ApiError } from "../../../../../../lib/api";
import { TYPE_OPTIONS } from "../../constants";
import { e } from "./styles";

/** A form's worth of skill, before it has an id. */
export interface SkillDraft {
  name: string;
  description: string;
  type: SkillType;
  body: string;
  /** Carried through from an import so the saved row records its true origin. */
  source?: SkillSource;
}

export function SkillEditorModal({
  skill,
  draft,
  onClose,
  onSaved,
}: {
  /** Present → edit that skill. Absent → create. */
  skill?: Skill;
  /** Initial values for a create (used by the import flow). */
  draft?: SkillDraft;
  onClose: () => void;
  onSaved?: (skill: Skill) => void;
}) {
  const t = useTranslations("skills");
  const create = useCreateSkill();
  const update = useUpdateSkill();

  const [name, setName] = React.useState(skill?.name ?? draft?.name ?? "");
  const [description, setDescription] = React.useState(
    skill?.description ?? draft?.description ?? "",
  );
  const [type, setType] = React.useState<SkillType>(skill?.type ?? draft?.type ?? "custom");
  const [body, setBody] = React.useState(skill?.body ?? draft?.body ?? "");
  const [error, setError] = React.useState<string | null>(null);

  const pending = create.isPending || update.isPending;
  const valid = name.trim().length > 0 && body.trim().length > 0;

  const save = async () => {
    setError(null);
    try {
      const saved = skill
        ? await update.mutateAsync({
            id: skill.id,
            patch: { name: name.trim(), description: description.trim(), type, body },
          })
        : await create.mutateAsync({
            name: name.trim(),
            description: description.trim(),
            type,
            body,
            // Only an import supplies this; a hand-written skill lets the server
            // default it to 'manual' rather than claiming an origin.
            ...(draft?.source ? { source: draft.source } : {}),
          });
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("editor.saveFailed"));
    }
  };

  return (
    <Modal
      width={760}
      title={skill ? t("editor.editTitle") : t("editor.createTitle")}
      subtitle={t("editor.subtitle")}
      onClose={pending ? undefined : onClose}
      footer={
        <div style={e.footer}>
          {error && <span style={e.error}>{error}</span>}
          <Button kind="ghost" size="sm" onClick={onClose} disabled={pending}>
            {t("editor.cancel")}
          </Button>
          <Button kind="primary" size="sm" onClick={save} disabled={!valid} loading={pending}>
            {pending ? t("editor.saving") : t("editor.save")}
          </Button>
        </div>
      }
    >
      <div style={e.body}>
        <FormField label={t("editor.nameLabel")} hint={t("editor.nameHint")} required>
          <TextInput value={name} onChange={setName} placeholder={t("editor.namePlaceholder")} />
        </FormField>

        <FormField label={t("editor.descriptionLabel")} hint={t("editor.descriptionHint")}>
          <Textarea
            value={description}
            onChange={setDescription}
            rows={3}
            placeholder={t("editor.descriptionPlaceholder")}
          />
        </FormField>

        <FormField label={t("editor.typeLabel")} hint={t("editor.typeHint")}>
          <SelectInput
            value={type}
            onChange={(v) => setType(v as SkillType)}
            mono={false}
            options={TYPE_OPTIONS.map((v) => ({ value: v, label: t(`listItem.type.${v}`) }))}
          />
        </FormField>

        <FormField
          label={t("editor.bodyLabel")}
          hint={skill ? t("editor.bodyHintVersioned") : t("editor.bodyHint")}
          required
        >
          <Textarea
            value={body}
            onChange={setBody}
            rows={16}
            mono
            placeholder={t("editor.bodyPlaceholder")}
          />
        </FormField>
      </div>
    </Modal>
  );
}
