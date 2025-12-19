// src/pages/ProjectsDashboard.jsx
import React from "react";

/* widgets */
import * as Roles from "../widgets/widgets/RolesWidget";
import * as Names from "../widgets/widgets/NamesListWidget";
import * as Groups from "../widgets/widgets/GroupsWidget";
import * as Projects from "../widgets/widgets/ProjectsWidget";
import * as Tasks from "../widgets/widgets/TasksWidget";
import * as Invoices from "../widgets/widgets/InvoicesSummaryWidget";
import * as Clockings from "../widgets/widgets/ClockingsWidget";
import * as Assets from "../widgets/widgets/AssetsWidget";
import * as Vehicles from "../widgets/widgets/VehiclesWidget";
import * as Inspections from "../widgets/widgets/InspectionsWidget";
import * as MasterHealth from "../widgets/widgets/MasterHealthWidget";
import * as DateRange from "../widgets/widgets/DateRangeWidget";

import MapPane from "../components/MapPane";
import GanttPane from "../components/GanttPane";
import ProjectOverviewPanel from "../components/ProjectOverviewPanel";

/* widget registry for AdminOrg toggles */
const WIDGETS = {
  "health.master": MasterHealth,
  // NOTE: dateRange intentionally omitted here so AdminOrg doesn't hide it during testing
  roles: Roles,
  namesList: Names,
  groups: Groups,
  "clockings.today": Clockings,
  "projects.all": Projects,
  "tasks.all": Tasks,
  inspections: Inspections,
  invoices: Invoices,
  assets: Assets,
  vehicles: Vehicles,
};

const WKEY = "org.dashboardWidgets";
const SERVER_TO_CANON = { people: "names", nameslist: "namesList" };
const toCanon = (id) => { const k = String(id || "").toLowerCase(); return SERVER_TO_CANON[k] || id; };
function loadWidgetsLocal() { try { return JSON.parse(localStorage.getItem(WKEY) || "[]"); } catch { return []; } }

export default function ProjectsDashboard() {
  const enabled = React.useMemo(() => {
    const raw =
      (window.__ORG__ && Array.isArray(window.__ORG__.dashboardWidgets) && window.__ORG__.dashboardWidgets) ||
      loadWidgetsLocal();
    const canon = (Array.isArray(raw) ? raw : []).map(toCanon);
    const fallback = [
      "health.master",
      "roles","namesList","groups","clockings.today",
      "projects.all","tasks.all","inspections",
      "invoices","assets","vehicles",
    ];
    return (canon.length ? canon : fallback).filter((id) => !!WIDGETS[id]);
  }, []);
  const has = (id) => enabled.includes(id);

  return (
    <div className="dashboard-shell">
      <style>{`
        :root { --gap: 12px; --border:#e5e7eb; --muted:#6b7280; }
        .dashboard-shell{ max-width: 1400px; margin: 0 auto; padding: 12px; }
        .top-row{ display:grid; grid-template-columns: 1fr 1fr; gap: var(--gap); align-items:stretch; }
        @media (max-width: 1100px){ .top-row{ grid-template-columns: 1fr; } }

        .main-grid{ display:grid; gap: var(--gap); margin-top: var(--gap);
          grid-template-columns: 1.6fr 1.6fr; align-items: start; }
        @media (max-width: 1200px){ .main-grid{ grid-template-columns: 1fr; } }

        .widgets-grid{ display:grid; gap: var(--gap); grid-template-columns: repeat(3,minmax(0,1fr)); }
        @media (max-width: 1100px){ .widgets-grid{ grid-template-columns: 1fr; } }

        .bucket{ border:1px solid var(--border); border-radius: 12px; background:#fff; padding: 10px; }
        .bucket h3{ font-weight: 700; font-size: 14px; margin: 2px 0 8px; }
        .bucket .col{ display: grid; gap: 8px; }

        .card { border:1px solid var(--border); border-radius: 12px; background:#fff; padding: 10px; }

        .right-rail{ display: grid; gap: var(--gap); align-content: start; align-self: start; }
        .map-card{ padding: 10px; } /* align with other cards */

        .bottom-strip{ display:grid; gap: var(--gap); margin-top: var(--gap); grid-template-columns: 1fr; }

        /* === Dashboard-only: make sure any modal/lightbox sits ABOVE the app sidebar === */
        /* Covers common libraries (ReactModal, MUI, AntD, HeadlessUI, Radix) and our own classes */
        .dashboard-shell :where(
          .ReactModal__Overlay,
          .ReactModal__Content,
          .MuiModal-root,
          .MuiBackdrop-root,
          .MuiDialog-root,
          .ant-modal-root,
          .ant-modal-wrap,
          .ant-modal-mask,
          .modal,
          .modal-overlay,
          .dialog-overlay,
          [role="dialog"],
          #modal-root,
          #modals
        ){
          z-index: 1000 !important;     /* higher than any sidebar layer */
          position: fixed !important;   /* detach from local grid/flow to avoid offsets */
        }

        /* Keep our own right-rail well below modals, just in case */
        .dashboard-shell .right-rail,
        .dashboard-shell .card,
        .dashboard-shell .bucket {
          position: relative;
          z-index: 1;
        }
      `}</style>

      {/* Top controls */}
      <div className="top-row">
        <div className="card"><MasterHealth.default /></div>
        {/* Always show DateRange for testing; later we can guard with Admin toggle */}
        <div className="card"><DateRange.default /></div>
      </div>

      {/* Main */}
      <div className="main-grid">
        <div>
          <div className="widgets-grid">
            <section className="bucket">
              <h3>People &amp; Teams</h3>
              <div className="col">
                {has("roles") && <Roles.default />}
                {has("namesList") && <Names.default />}
                {has("groups") && <Groups.default />}
                {has("clockings.today") && <Clockings.default />}
              </div>
            </section>

            <section className="bucket">
              <h3>Operations</h3>
              <div className="col">
                {has("projects.all") && <Projects.default />}
                {has("tasks.all") && <Tasks.default />}
                {has("inspections") && <Inspections.default />}
              </div>
            </section>

            <section className="bucket">
              <h3>Resources</h3>
              <div className="col">
                {has("invoices") && <Invoices.default />}
                {has("assets") && <Assets.default />}
                {has("vehicles") && <Vehicles.default />}
              </div>
            </section>
          </div>
        </div>

        <aside className="right-rail">
          <div className="card map-card"><MapPane /></div>
        </aside>
      </div>

      {/* Overview + Gantt */}
      <div className="bottom-strip">
        <div className="card"><ProjectOverviewPanel /></div>
        <div className="card"><GanttPane /></div>
      </div>
    </div>
  );
}
