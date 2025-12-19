// src/widgets/registry.js
// Central registry: keep ids EXACTLY matching backend ALLOWED_WIDGETS.

import * as RolesWidget from "./widgets/RolesWidget";
import * as NamesWidget from "./widgets/NamesListWidget";
import * as ProjectsWidget from "./widgets/ProjectsWidget";
import * as TasksWidget from "./widgets/TasksWidget";
import * as ClockingsWidget from "./widgets/ClockingsWidget";
import * as InvoicesWidget from "./widgets/InvoicesSummaryWidget";
import * as AssetsWidget from "./widgets/AssetsWidget";
import * as VehiclesWidget from "./widgets/VehiclesWidget";
import * as InspectionsWidget from "./widgets/InspectionsWidget";
import * as GroupsWidget from "./widgets/GroupsWidget";
import * as MasterHealthWidget from "./widgets/MasterHealthWidget";
import * as RiskSummaryWidget from "./widgets/RiskSummaryWidget";
import * as DateRangeWidget from "./widgets/DateRangeWidget";

// Optional legacy → canonical id mapping (helps old data/localStorage)
// IMPORTANT: map TO the actual ids exported by the widget files (and allowed by backend)
const LEGACY_TO_CANON = {
  names: "namesList",
  people: "namesList",
  projects: "projects.all",
  tasks: "tasks.all",
  clockings: "clockings.today",
  daterange: "date.range",
  // DO NOT remap "groups" away from "groups"
  //groups: "groups.all", // <-- ❌ remove this line
  // health/risk only if you had older keys you need to carry over:
  // health: "health.master",
  // riskSummary: "risk",
};

const ENTRIES = [
  { id: RolesWidget.id,           title: RolesWidget.title,           component: RolesWidget.default },
  { id: NamesWidget.id,           title: NamesWidget.title,           component: NamesWidget.default },
  { id: ProjectsWidget.id,        title: ProjectsWidget.title,        component: ProjectsWidget.default },
  { id: TasksWidget.id,           title: TasksWidget.title,           component: TasksWidget.default },
  { id: ClockingsWidget.id,       title: ClockingsWidget.title,       component: ClockingsWidget.default },
  { id: InvoicesWidget.id,        title: InvoicesWidget.title,        component: InvoicesWidget.default },
  { id: AssetsWidget.id,          title: AssetsWidget.title,          component: AssetsWidget.default },
  { id: VehiclesWidget.id,        title: VehiclesWidget.title,        component: VehiclesWidget.default },
  { id: InspectionsWidget.id,     title: InspectionsWidget.title,     component: InspectionsWidget.default },
  { id: GroupsWidget.id,          title: GroupsWidget.title,          component: GroupsWidget.default },
  { id: MasterHealthWidget.id,    title: MasterHealthWidget.title,    component: MasterHealthWidget.default },
  { id: RiskSummaryWidget.id,     title: RiskSummaryWidget.title,     component: RiskSummaryWidget.default },
  { id: DateRangeWidget.id,       title: DateRangeWidget.title,       component: DateRangeWidget.default },
];

// Exported list the rest of the app uses (AdminOrg, etc.)
export const ALL_WIDGETS = ENTRIES.map(({ id, title }) => ({ id, title }));

// Helper: find by id (with legacy fallback)
export function resolveWidget(id) {
  const wanted = String(id || "");
  const canon = LEGACY_TO_CANON[wanted] || wanted;
  return ENTRIES.find(e => e.id === canon);
}

// Helper: normalize an array of ids -> only allowed, deduped, in given order
export function normalizeWidgets(arr) {
  const allowed = new Set(ALL_WIDGETS.map(w => w.id));
  const seen = new Set();
  const out = [];
  for (const raw of (Array.isArray(arr) ? arr : [])) {
    const wanted = String(raw || "");
    const id = LEGACY_TO_CANON[wanted] || wanted;
    if (!allowed.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
