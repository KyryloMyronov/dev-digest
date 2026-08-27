/* hooks/blast.ts — L04 · Blast Radius (GET /pulls/:id/blast).
   A pure index read on the server (no LLM, no GitHub round-trip), so it is
   safe to fetch on every render of the Blast tab. */
"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import type { BlastResponse } from "../types";
import { pullKeys } from "./keys";

export function useBlastRadius(prId: string | null | undefined) {
  return useQuery({
    queryKey: pullKeys.blast(prId),
    queryFn: () => api.get<BlastResponse>(`/pulls/${prId}/blast`),
    enabled: prId != null,
  });
}
