/* Route: /eval/agents/[agentId]/cases/[caseId] — one eval case. Thin route
   entry; the editor colocates under ../_components/EvalCaseEditor. */
"use client";

import { useParams } from "next/navigation";
import { EvalCaseEditor } from "../_components/EvalCaseEditor";

export default function EvalCasePage() {
  const { agentId, caseId } = useParams<{ agentId: string; caseId: string }>();
  return <EvalCaseEditor agentId={agentId} caseId={caseId} />;
}
