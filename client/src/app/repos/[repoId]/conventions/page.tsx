/* /repos/:repoId/conventions — house rules derived from the repo's own source.
   Everything interactive lives in ConventionsView; this is only the route shell. */
import { ConventionsView } from "./_components/ConventionsView";

export default function ConventionsPage() {
  return <ConventionsView />;
}
