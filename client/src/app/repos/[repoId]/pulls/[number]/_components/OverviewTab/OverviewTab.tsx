"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import { IntentCard } from "../IntentCard";
import { BlastRadiusCard } from "../BlastRadiusCard";
import { s } from "./styles";

interface OverviewTabProps {
  prBody: string | null | undefined;
  prId: string | null;
  headSha: string | null | undefined;
  /** "owner/repo"; null until the repo is loaded — blast links degrade to plain text. */
  repoFullName: string | null;
  /** Reveal a changed file in the Files-changed tab (used by the blast card). */
  onRevealFile?: (path: string) => void;
}

export function OverviewTab({ prBody, prId, headSha, repoFullName, onRevealFile }: OverviewTabProps) {
  return (
    <>
      {/* Above the description on purpose: the intent is the derived reading OF
          that description, and it is what the reviewer was actually given.
          Blast radius sits beside it — what the PR MEANS next to what it TOUCHES. */}
      <div style={s.cardsGrid}>
        <div style={s.gridCell}>
          <IntentCard prId={prId} headSha={headSha} />
        </div>
        <div style={s.gridCell}>
          <BlastRadiusCard
            prId={prId}
            repoFullName={repoFullName}
            headSha={headSha}
            onRevealFile={onRevealFile}
          />
        </div>
      </div>
      {prBody && (
        <section>
          <SectionLabel icon="MessageSquare">Description</SectionLabel>
          <div style={s.descriptionBox}>{prBody}</div>
        </section>
      )}
    </>
  );
}
