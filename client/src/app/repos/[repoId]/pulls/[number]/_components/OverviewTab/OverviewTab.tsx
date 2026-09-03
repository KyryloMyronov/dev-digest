"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import { BriefCard, type BriefCitation } from "../BriefCard";
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
  /**
   * Reveal a file AND a line (used by the brief card). Deliberately NOT merged
   * with `onRevealFile`: the blast card genuinely has no line, and collapsing
   * the two would force a `null` through a signature that means something else.
   */
  onRevealLocation?: (path: string, line: number | null) => void;
  /** Does a brief citation resolve in the studio's own diff line index (AC-42)? */
  citationInDiff?: (c: BriefCitation) => boolean;
}

export function OverviewTab({
  prBody,
  prId,
  headSha,
  repoFullName,
  onRevealFile,
  onRevealLocation,
  citationInDiff,
}: OverviewTabProps) {
  return (
    <>
      {/* SPEC-02 AC-30 — ONE brief card, three sections (why → risks → review
          focus), ABOVE the Intent/Blast grid: it is the thing a reviewer
          arriving cold reads first, and it is what tells them where to start. */}
      <BriefCard
        prId={prId}
        headSha={headSha}
        onRevealLocation={onRevealLocation}
        citationInDiff={citationInDiff}
      />
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
