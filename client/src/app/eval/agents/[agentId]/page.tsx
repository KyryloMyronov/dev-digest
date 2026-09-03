/* Route: /eval/agents/[agentId] — one agent's evals (SPEC-04). Thin route
   entry; the view, its trend, compare panel and styles colocate under
   _components/EvalAgentView. `useParams` rather than an async `params` prop,
   matching `/agents/[id]` — this studio is a client-rendered SPA. */
"use client";

import { useParams } from "next/navigation";
import { EvalAgentView } from "./_components/EvalAgentView";

export default function EvalAgentPage() {
  const { agentId } = useParams<{ agentId: string }>();
  return <EvalAgentView agentId={agentId} />;
}
