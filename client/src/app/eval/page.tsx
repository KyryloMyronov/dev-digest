import { EvalDashboardView } from "./_components/EvalDashboardView";

/* Route: /eval — the workspace Eval Dashboard (SPEC-04). Thin route entry; the
   view, its tables, confirmation modal and styles colocate under
   _components/EvalDashboardView. */
export default function EvalPage() {
  return <EvalDashboardView />;
}
