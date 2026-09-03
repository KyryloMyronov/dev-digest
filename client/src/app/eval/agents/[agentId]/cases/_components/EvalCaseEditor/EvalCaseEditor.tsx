/* EvalCaseEditor — SPEC-04's routed eval-case editor (AC-76 … AC-79, AC-112).

   A ROUTED PAGE, not a modal (spec D-36): the shipped catalogue already carries
   `page.crumbNewCase` and `page.crumbEvalCase`, which only a routed page needs.

   TWO DISTINCT VALIDITY STATES, deliberately not collapsed (spec D-10):
     • `invalidJson` is SYNTAX, client-side and live (AC-78);
     • a schema-invalid expectation is caught at SAVE and surfaced from the
       server's `error.details` (AC-79).
   Text that parses as JSON but is the wrong shape is valid syntax and an
   invalid schema — showing one badge for both would hide exactly that case. */
"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Badge,
  Button,
  Checkbox,
  ErrorState,
  FormField,
  Skeleton,
  Tabs,
  Textarea,
  TextInput,
} from "@devdigest/ui";
import type { EvalExpectation } from "@devdigest/shared";
import { AppShell } from "../../../../../../../components/app-shell";
import { ApiError } from "../../../../../../../lib/api";
import {
  useCreateEvalCase,
  useEvalCase,
  useRunEvalCase,
  useUpdateEvalCase,
} from "../../../../../../../lib/hooks/eval";
import { EXPECTATION_OPTIONS, INPUT_TABS, type InputTab } from "./constants";
import { zodPathsFrom } from "./helpers";
import { s } from "./styles";

export function EvalCaseEditor({
  agentId,
  caseId,
}: {
  agentId: string;
  /** Absent on `/cases/new` — AC-76's empty editor. */
  caseId?: string;
}) {
  const t = useTranslations("eval");
  const router = useRouter();

  const existing = useEvalCase(caseId ?? null);
  const create = useCreateEvalCase(agentId);
  const update = useUpdateEvalCase(agentId);
  const runCase = useRunEvalCase(agentId);

  const [name, setName] = React.useState("");
  const [diff, setDiff] = React.useState("");
  const [expectation, setExpectation] = React.useState<EvalExpectation>("must_find");
  const [expectedText, setExpectedText] = React.useState("[]");
  const [tab, setTab] = React.useState<InputTab>("diff");
  // OQ-2 — client-side state, persisted nowhere. No column, no contract field.
  const [runOnSave, setRunOnSave] = React.useState(false);
  const [hydrated, setHydrated] = React.useState(false);

  React.useEffect(() => {
    if (!existing.data || hydrated) return;
    setName(existing.data.name);
    setDiff(existing.data.input_diff);
    setExpectation(existing.data.expectation);
    setExpectedText(JSON.stringify(existing.data.expected_output, null, 2));
    setHydrated(true);
  }, [existing.data, hydrated]);

  // AC-78 — syntax only, and live.
  const parsed = React.useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(expectedText) as unknown };
    } catch {
      return { ok: false as const, value: undefined };
    }
  }, [expectedText]);

  const saveError = (create.error ?? update.error) as unknown;
  // AC-79 — the Zod path the SERVER returned, rendered verbatim.
  const zodPaths =
    saveError instanceof ApiError ? zodPathsFrom(saveError.details) : [];

  const crumb = [
    { label: t("page.crumbSkillsLab") },
    { label: t("page.crumbEvalDashboard") },
    { label: caseId ? t("page.crumbEvalCase") : t("page.crumbNewCase") },
  ];

  if (caseId && existing.isLoading) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.page}>
          <Skeleton height={26} width={240} />
          <div style={{ height: 16 }} />
          <Skeleton height={200} />
        </div>
      </AppShell>
    );
  }
  if (caseId && existing.isError) {
    return (
      <AppShell crumb={crumb}>
        <div style={s.page}>
          <ErrorState
            title={t("caseEditor.loadError")}
            body={(existing.error as Error)?.message}
            onRetry={() => void existing.refetch()}
          />
        </div>
      </AppShell>
    );
  }

  const onSave = () => {
    if (!parsed.ok) return;
    const body = {
      owner_kind: "agent" as const,
      owner_id: agentId,
      name,
      input_diff: diff,
      expectation,
      // The server re-parses this against `EvalExpectedFinding[]`; a 422 with
      // the failing path is the answer, not a client-side guess at the schema.
      expected_output: parsed.value as never,
    };
    const after = () => {
      if (runOnSave && caseId) runCase.mutate(caseId);
      router.push(`/agents/${agentId}?tab=evals`);
    };
    if (caseId) update.mutate({ caseId, body }, { onSuccess: after });
    else create.mutate(body, { onSuccess: after });
  };

  return (
    <AppShell crumb={crumb}>
      <div style={s.page}>
        <div style={s.header}>
          <div style={s.headerText}>
            <h1 style={s.h1}>
              {caseId ? t("caseEditor.caseTitle", { name }) : t("caseEditor.newCase")}
            </h1>
            <button
              type="button"
              style={s.back}
              onClick={() => router.push(`/agents/${agentId}?tab=evals`)}
            >
              {t("caseEditor.backToEvals")}
            </button>
          </div>
        </div>

        <FormField label={t("caseEditor.nameLabel")} required>
          <TextInput
            value={name}
            onChange={setName}
            placeholder={t("caseEditor.namePlaceholder")}
            aria-label={t("caseEditor.nameLabel")}
          />
        </FormField>

        <FormField label={t("caseEditor.inputLabel")}>
          <Tabs
            tabs={INPUT_TABS.map((k) => ({ key: k, label: t(`caseEditor.tabs.${k}`) }))}
            value={tab}
            onChange={(v) => setTab(v as InputTab)}
          />
          {tab === "diff" ? (
            <Textarea
              value={diff}
              onChange={setDiff}
              rows={10}
              mono
              placeholder={t("caseEditor.diffPlaceholder")}
            />
          ) : (
            // AC-112 — the frozen diff renders as TEXT content. No
            // `dangerouslySetInnerHTML` anywhere on this path.
            <pre style={s.diffPane}>{diff}</pre>
          )}
        </FormField>

        {/* AC-77 — a two-option control, ABOVE the expected-output editor. */}
        <FormField label={t("expectation.label")}>
          <div role="radiogroup" aria-label={t("expectation.label")} style={s.segmented}>
            {EXPECTATION_OPTIONS.map((opt) => (
              <Button
                key={opt}
                role="radio"
                aria-checked={expectation === opt}
                kind={expectation === opt ? "primary" : "secondary"}
                onClick={() => setExpectation(opt)}
              >
                {t(`expectation.${opt}`)}
              </Button>
            ))}
          </div>
        </FormField>

        <FormField
          label={t("caseEditor.expectedOutput")}
          right={
            <div style={s.badgeRow}>
              <Badge color={parsed.ok ? "var(--ok)" : "var(--crit)"}>
                {parsed.ok ? t("caseEditor.validJson") : t("caseEditor.invalidJson")}
              </Badge>
            </div>
          }
        >
          <Textarea
            value={expectedText}
            onChange={setExpectedText}
            rows={8}
            mono
            placeholder='[{"file":"src/config.ts","start_line":12}]'
          />
        </FormField>

        {zodPaths.length > 0 ? (
          <div style={s.error} role="alert">
            {zodPaths.map((p) => (
              <div key={p}>{t("caseEditor.schemaError", { path: p })}</div>
            ))}
          </div>
        ) : null}

        <Checkbox
          checked={runOnSave}
          onChange={setRunOnSave}
          label={t("caseEditor.runOnSave")}
        />

        <div style={s.footer}>
          <Button
            kind="primary"
            onClick={onSave}
            disabled={!parsed.ok || name.trim() === ""}
          >
            {create.isPending || update.isPending
              ? t("caseEditor.saving")
              : t("caseEditor.save")}
          </Button>
          {caseId ? (
            <Button onClick={() => runCase.mutate(caseId)} disabled={runCase.isPending}>
              {runCase.isPending ? t("caseEditor.running") : t("caseEditor.runCase")}
            </Button>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
