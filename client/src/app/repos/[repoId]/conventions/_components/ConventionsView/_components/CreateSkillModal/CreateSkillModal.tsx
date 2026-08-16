/* "Create skill from conventions" — review and edit the skill composed from every
   accepted convention, then save it.

   The server composes a DRAFT and writes nothing; this modal saves through the
   ordinary `POST /skills`. So cancelling costs nothing, and the skills module
   stays the only writer of the skills table.

   Split into chrome + a local form because the draft arrives AFTER mount:
   `useState(draft?.name ?? "")` in a single component would latch onto "" and
   never pick the real value up. The chrome renders loading/error and only mounts
   the form once the draft exists, which lets the form take a required draft and
   seed its state from it directly.

   No focus trap — `vendor/ui/kit/Modal` has none, and adding one here would be the
   only trapped modal in the studio. Escape IS handled, since Modal does not. */
"use client";

import React from "react";
import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  ErrorState,
  FormField,
  Icon,
  Modal,
  SelectInput,
  Skeleton,
  TextInput,
  Toggle,
} from "@devdigest/ui";
import type { ConventionSkillDraft, Skill } from "@devdigest/shared";
import { ApiError } from "@/lib/api";
import { useConventionSkillDraft } from "@/lib/hooks/conventions";
import { useCreateSkill } from "@/lib/hooks/skills";
import { SkillBodyEditor } from "../SkillBodyEditor";
import { CREATE_SKILL_MODAL_WIDTH, SKILL_TYPE_OPTIONS } from "../../constants";
import { estimateTokens } from "../../helpers";
import { modal as m } from "../../styles";

export function CreateSkillModal({
  repoId,
  repoName,
  onClose,
  onCreated,
}: {
  repoId: string;
  repoName: string;
  onClose: () => void;
  onCreated?: (skill: Skill) => void;
}) {
  const t = useTranslations("conventions");
  const { data: draft, isLoading, isError, error } = useConventionSkillDraft(repoId);

  // `Modal` does not close on Escape; every modal in the studio wires this itself.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (isLoading) {
    return (
      <Modal width={CREATE_SKILL_MODAL_WIDTH} title={t("createSkill.title")} onClose={onClose}>
        <Skeleton height={280} />
      </Modal>
    );
  }

  if (isError || !draft) {
    return (
      <Modal width={CREATE_SKILL_MODAL_WIDTH} title={t("createSkill.title")} onClose={onClose}>
        <ErrorState
          title={t("createSkill.loadError")}
          body={error instanceof ApiError ? error.message : undefined}
        />
      </Modal>
    );
  }

  return (
    <CreateSkillForm
      draft={draft}
      repoId={repoId}
      repoName={repoName}
      onClose={onClose}
      {...(onCreated ? { onCreated } : {})}
    />
  );
}

function CreateSkillForm({
  draft,
  repoName,
  onClose,
  onCreated,
}: {
  draft: ConventionSkillDraft;
  repoId: string;
  repoName: string;
  onClose: () => void;
  onCreated?: (skill: Skill) => void;
}) {
  const t = useTranslations("conventions");
  const create = useCreateSkill();

  const [name, setName] = React.useState(draft.name);
  const [description, setDescription] = React.useState(draft.description);
  const [type, setType] = React.useState<string>(draft.type);
  const [enabled, setEnabled] = React.useState(true);
  const [body, setBody] = React.useState(draft.body);
  const [error, setError] = React.useState<string | null>(null);

  const dirty = body !== draft.body;
  const valid = name.trim().length > 0 && body.trim().length > 0;
  const pending = create.isPending;

  const submit = async () => {
    setError(null);
    try {
      const skill = await create.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        type: type as ConventionSkillDraft["type"],
        // The origin of this text is the extractor, not a person typing — the
        // library badges it accordingly and `evidence_files` records what it was
        // derived from.
        source: draft.source,
        body,
        enabled,
        evidence_files: draft.evidence_files,
      });
      onCreated?.(skill);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("createSkill.saveFailed"));
    }
  };

  return (
    <Modal
      width={CREATE_SKILL_MODAL_WIDTH}
      title={t("createSkill.title")}
      subtitle={<span className="mono">{draft.name}</span>}
      onClose={pending ? undefined : onClose}
      footer={
        <div style={m.footer}>
          <span style={m.footNote}>
            <Icon.Sparkles size={12} />
            {t("createSkill.footNote")}
          </span>
          <span style={m.footerSpacer} />
          {error && <span style={m.error}>{error}</span>}
          <Button kind="ghost" onClick={onClose} disabled={pending}>
            {t("createSkill.cancel")}
          </Button>
          <Button
            kind="primary"
            icon="Sparkles"
            loading={pending}
            disabled={!valid || pending}
            onClick={() => void submit()}
          >
            {pending ? t("createSkill.saving") : t("createSkill.submit")}
          </Button>
        </div>
      }
    >
      <div style={m.banner}>
        <Icon.Sparkles size={14} style={m.bannerIcon} />
        <span>
          {t("createSkill.banner", { count: draft.convention_count, repo: repoName })}
        </span>
      </div>

      <FormField label={t("createSkill.nameLabel")} required>
        <TextInput
          value={name}
          onChange={setName}
          placeholder={t("createSkill.namePlaceholder")}
          aria-label={t("createSkill.nameLabel")}
        />
      </FormField>

      <FormField label={t("createSkill.descriptionLabel")}>
        <TextInput
          value={description}
          onChange={setDescription}
          placeholder={t("createSkill.descriptionPlaceholder")}
          aria-label={t("createSkill.descriptionLabel")}
        />
      </FormField>

      <div style={m.grid2}>
        <FormField label={t("createSkill.typeLabel")}>
          <SelectInput
            value={type}
            onChange={setType}
            options={SKILL_TYPE_OPTIONS.map((v) => ({
              value: v,
              label: t(`createSkill.type.${v}`),
            }))}
          />
        </FormField>
        <FormField label={t("createSkill.enabledLabel")} hint={t("createSkill.enabledHint")}>
          <Toggle on={enabled} onChange={setEnabled} />
        </FormField>
      </div>

      <FormField label={t("createSkill.bodyLabel")} required>
        <SkillBodyEditor
          filename={`${draft.name}.md`}
          value={body}
          onChange={setBody}
          dirty={dirty}
          tokens={dirty ? estimateTokens(body) : draft.tokens}
        />
      </FormField>
    </Modal>
  );
}
