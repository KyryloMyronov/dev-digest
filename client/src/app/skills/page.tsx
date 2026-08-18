import { SkillsListView } from "./_components/SkillsListView";

/* Route: /skills (the skill library). Thin route entry — the view, its cards,
   preview panel, editor and import modals, styles, constants, helpers and i18n
   are colocated under _components/SkillsListView. */
export default function SkillsPage() {
  return <SkillsListView />;
}
