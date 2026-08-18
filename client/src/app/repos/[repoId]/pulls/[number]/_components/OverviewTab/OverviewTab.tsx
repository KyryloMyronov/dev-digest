"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import { IntentCard } from "../IntentCard";
import { s } from "./styles";

interface OverviewTabProps {
  prBody: string | null | undefined;
  prId: string | null;
  headSha: string | null | undefined;
}

export function OverviewTab({ prBody, prId, headSha }: OverviewTabProps) {
  return (
    <>
      {/* Above the description on purpose: the intent is the derived reading OF
          that description, and it is what the reviewer was actually given. */}
      <IntentCard prId={prId} headSha={headSha} />
      {prBody && (
        <section>
          <SectionLabel icon="MessageSquare">Description</SectionLabel>
          <div style={s.descriptionBox}>{prBody}</div>
        </section>
      )}
    </>
  );
}
