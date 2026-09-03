/* Route: /eval/agents/[agentId]/cases/new — AC-76's empty case editor. Thin
   route entry; the editor colocates under ../_components/EvalCaseEditor. */
"use client";

import { useParams } from "next/navigation";
import { EvalCaseEditor } from "../_components/EvalCaseEditor";

export default function NewEvalCasePage() {
  const { agentId } = useParams<{ agentId: string }>();
  return <EvalCaseEditor agentId={agentId} />;
}
