/* /repos/:repoId/context — the repository's Markdown project context, read-only.
   Everything interactive lives in ProjectContextView; this is only the shell. */
import { ProjectContextView } from "./_components/ProjectContextView";

export default function ProjectContextPage() {
  return <ProjectContextView />;
}
