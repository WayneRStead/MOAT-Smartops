// src/App.jsx
import React from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
  useLocation,
} from "react-router-dom";

import PublicAuth from "./pages/PublicAuth";

import FeatureGate from "./components/FeatureGate.jsx";
import Navbar from "./components/Navbar.jsx";

import NotFound from "./pages/NotFound.jsx";
import Forbidden from "./pages/Forbidden.jsx";

import ProjectsDashboard from "./pages/ProjectsDashboard.jsx";
import Projects from "./pages/Projects.jsx";
import ProjectDetail from "./pages/ProjectDetail.jsx";
import Users from "./pages/Users.jsx";
import Groups from "./pages/Groups.jsx";
import Clockings from "./pages/Clockings.jsx";
import Assets from "./pages/Assets.jsx";
import AssetDetail from "./pages/AssetDetail.jsx";
import Vehicles from "./pages/Vehicles.jsx";
import VehicleDetail from "./pages/VehicleDetail.jsx";
import Invoices from "./pages/Invoices.jsx";
import AdminUsers from "./pages/AdminUsers.jsx";
import AdminOrg from "./pages/AdminOrg.jsx";
import SystemBilling from "./pages/SystemBilling.jsx";
import Vault from "./pages/Vault.jsx";
import DocumentDetail from "./pages/DocumentDetail.jsx";
import Tasks from "./pages/Tasks.jsx";
import TaskDetail from "./pages/TaskDetail.jsx";
import AdminGroups from "./pages/AdminGroups.jsx";
import Trips from "./pages/Trips";
import OrgBilling from "./pages/OrgBilling";
import Timesheet from "./pages/Timesheet";
import ForgotPassword from "./pages/ForgotPassword";
import ResetPassword from "./pages/ResetPassword";

// Inspections
import AdminInspectionForms from "./pages/AdminInspectionForms.jsx";
import AdminInspectionFormBuilder from "./pages/AdminInspectionFormBuilder.jsx";
import Inspections from "./pages/Inspections.jsx";
import InspectionRun from "./pages/InspectionRun.jsx";
import InspectionSubmissionView from "./pages/InspectionSubmissionView.jsx";
import AdminInspectionSubmissions from "./pages/AdminInspectionSubmissions.jsx";

// Global cockpit
import SuperAdminDashboard from "./pages/SuperAdminDashboard.jsx";

/* ---------------- helpers: auth + org scope ---------------- */
function safeParseJwt(t) {
  try {
    const p = String(t || "").split(".");
    if (p.length < 2) return null;
    return JSON.parse(atob(p[1]));
  } catch {
    return null;
  }
}
function getToken() {
  try {
    return (
      localStorage.getItem("token") ||
      sessionStorage.getItem("token") ||
      ""
    );
  } catch {
    return "";
  }
}
function getPayload() {
  return safeParseJwt(getToken());
}
function getSavedOrgId() {
  try {
    return (
      localStorage.getItem("orgId") ||
      sessionStorage.getItem("orgId") ||
      localStorage.getItem("tenantId") ||
      sessionStorage.getItem("tenantId") ||
      null
    );
  } catch {
    return null;
  }
}
function getOrgIdFromToken() {
  const payload = getPayload();
  return payload?.orgId || payload?.tenantId || null;
}
function isAuthed() {
  return !!getToken();
}
function hasOrgContext() {
  return !!(getSavedOrgId() || getOrgIdFromToken());
}

function normRole(r) {
  if (!r) return "";
  return String(r).trim().toLowerCase().replace(/\s+/g, "-");
}

/* ---- role checks based on JWT ---- */
function userHasAnyRole(requiredRoles = []) {
  if (!requiredRoles.length) return true; // no roles specified = allow
  const payload = getPayload();
  if (!payload) return false;

  const globalRole = normRole(payload.globalRole);
  // Global superadmin override: allowed everywhere
  if (globalRole === "superadmin") return true;

  const tokenRoles = Array.isArray(payload.roles) ? payload.roles : [];
  const primary = payload.role ? [payload.role] : [];
  const all = [...tokenRoles, ...primary].map(normRole);

  const required = requiredRoles.map(normRole);
  return all.some((r) => required.includes(r));
}

/* ---- ProtectedRoute: requires token + orgId; optional roles ---- */
function ProtectedRoute({ children, roles }) {
  if (!isAuthed()) return <Navigate to="/public/auth" replace />;

  // For now, every protected page still expects an org context.
  // If you ever want a truly org-less global screen, you could relax this.
  if (!hasOrgContext()) return <Navigate to="/public/auth" replace />;

  if (roles && roles.length) {
    if (!userHasAnyRole(roles)) {
      return <Navigate to="/forbidden" replace />;
    }
  }

  return children;
}

/* ---- Home redirect: go to dashboard if ready, else to public auth ---- */
function HomeRedirect() {
  return isAuthed() && hasOrgContext() ? (
    <Navigate to="/projects-dashboard" replace />
  ) : (
    <Navigate to="/public/auth" replace />
  );
}

/* ---- App layout: hide Navbar on public routes or when not scoped ---- */
function AppLayout() {
  const location = useLocation();
  const path = location.pathname || "";
  const isPublicRoute =
    path.startsWith("/public/") ||
    path === "/login" ||
    path === "/signup" ||
    path === "/signin";

  const showChrome = !isPublicRoute && isAuthed() && hasOrgContext();

  if (!showChrome) {
    // Bare render (no sidebar) for public auth and pre-scope states
    return (
      <div style={{ minHeight: "100dvh", background: "var(--bg, #f7f7fb)" }}>
        <main style={{ minWidth: 0, padding: 16 }}>
          <Outlet />
        </main>
      </div>
    );
  }

  // Authenticated + org-scoped shell
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr", // sidebar | content
        minHeight: "100dvh",
        background: "var(--bg, #f7f7fb)",
      }}
    >
      <Navbar />
      <main style={{ minWidth: 0, padding: 16 }}>
        <Outlet />
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public entry points */}
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/public/auth" element={<PublicAuth />} />
        <Route path="/login" element={<PublicAuth />} />
        <Route path="/signup" element={<PublicAuth />} />
        <Route path="/signin" element={<PublicAuth />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />

        {/* Protected shell (Navbar shown only when authed + org-scoped) */}
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          {/* Optional: /admin base redirect */}
          <Route path="/admin" element={<Navigate to="/admin/users" replace />} />

          {/* Global superadmin cockpit */}
          <Route
            path="/super-admin"
            element={
              <ProtectedRoute roles={["superadmin"]}>
                <SuperAdminDashboard />
              </ProtectedRoute>
            }
          />

          {/* Projects Dashboard */}
          <Route
            path="/projects-dashboard"
            element={
              <FeatureGate feature="projects">
                <ProjectsDashboard />
              </FeatureGate>
            }
          />

          {/* Projects */}
          <Route
            path="/projects"
            element={
              <FeatureGate feature="projects">
                <Projects />
              </FeatureGate>
            }
          />
          <Route
            path="/projects/:id"
            element={
              <FeatureGate feature="projects">
                <ProjectDetail />
              </FeatureGate>
            }
          />

          {/* Users */}
          <Route
            path="/users"
            element={
              <FeatureGate feature="users">
                <Users />
              </FeatureGate>
            }
          />

          {/* End-user Groups */}
          <Route
            path="/groups"
            element={
              <FeatureGate feature="users">
                <Groups />
              </FeatureGate>
            }
          />

          {/* Clockings */}
          <Route
            path="/clockings"
            element={
              <FeatureGate feature="clockings">
                <Clockings />
              </FeatureGate>
            }
          />

          <Route 
            path="/timesheet"
            element={
              <Timesheet />
            } 
          />

          {/* Admin: Groups */}
          <Route
            path="/admin/groups"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <AdminGroups />
              </ProtectedRoute>
            }
          />

          {/* Assets */}
          <Route
            path="/assets"
            element={
              <FeatureGate feature="assets">
                <Assets />
              </FeatureGate>
            }
          />
          <Route
            path="/assets/:id"
            element={
              <FeatureGate feature="assets">
                <AssetDetail />
              </FeatureGate>
            }
          />

          {/* Vehicles */}
          <Route
            path="/vehicles"
            element={
              <FeatureGate feature="vehicles">
                <Vehicles />
              </FeatureGate>
            }
          />
          <Route
            path="/vehicles/:id"
            element={
              <FeatureGate feature="vehicles">
                <VehicleDetail />
              </FeatureGate>
            }
          />
          <Route
            path="/trips"
            element={
              <FeatureGate feature="vehicles">
                <Trips />
              </FeatureGate>
            }
          />

          {/* Invoices */}
          <Route
            path="/invoices"
            element={
              <FeatureGate feature="invoices">
                <Invoices />
              </FeatureGate>
            }
          />

          {/* Inspections */}
          <Route
            path="/inspections"
            element={
              <FeatureGate feature="inspections">
                <Inspections />
              </FeatureGate>
            }
          />
          <Route
            path="/inspections/submissions/:subId"
            element={
              <FeatureGate feature="inspections">
                <InspectionSubmissionView />
              </FeatureGate>
            }
          />
          <Route
            path="/inspections/:subId"
            element={
              <FeatureGate feature="inspections">
                <InspectionSubmissionView />
              </FeatureGate>
            }
          />
          <Route
            path="/inspections/forms/:formId/open"
            element={
              <FeatureGate feature="inspections">
                <InspectionRun />
              </FeatureGate>
            }
          />
          <Route
            path="/inspections/forms/:formId/run"
            element={
              <FeatureGate feature="inspections">
                <InspectionRun />
              </FeatureGate>
            }
          />
          <Route
            path="/inspections/run/:id"
            element={
              <FeatureGate feature="inspections">
                <InspectionRun />
              </FeatureGate>
            }
          />

          <Route
            path="/admin/inspections/submissions"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <AdminInspectionSubmissions />
              </ProtectedRoute>
            }
          />

          {/* Vault */}
          <Route
            path="/vault"
            element={
              <FeatureGate feature="vault">
                <Vault />
              </FeatureGate>
            }
          />
          <Route
            path="/vault/:id"
            element={
              <FeatureGate feature="vault">
                <DocumentDetail />
              </FeatureGate>
            }
          />

          {/* Admin */}
          <Route
            path="/admin/users"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <AdminUsers />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/org"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <AdminOrg />
              </ProtectedRoute>
            }
          />

          {/* 🔹 Org admin billing (new) */}
          <Route
            path="/admin/billing"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <OrgBilling />
              </ProtectedRoute>
            }
          />

          {/* System-level billing (existing) */}
          <Route
            path="/system/billing"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <SystemBilling />
              </ProtectedRoute>
            }
          />

          {/* Admin: Inspection Form Builder */}
          <Route
            path="/admin/inspections/forms"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <AdminInspectionForms />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/inspections/forms/new"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <AdminInspectionFormBuilder mode="create" />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/inspections/forms/:id/edit"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <AdminInspectionFormBuilder mode="edit" />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/inspections/forms/:id"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <AdminInspectionFormBuilder mode="edit" />
              </ProtectedRoute>
            }
          />

          {/* Aliases for /admin/inspection/... */}
          <Route
            path="/admin/inspection/forms"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <AdminInspectionForms />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/inspection/forms/new"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <AdminInspectionFormBuilder mode="create" />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/inspection/forms/:id/edit"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <AdminInspectionFormBuilder mode="edit" />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin/inspection/forms/:id"
            element={
              <ProtectedRoute roles={["admin", "superadmin"]}>
                <AdminInspectionFormBuilder mode="edit" />
              </ProtectedRoute>
            }
          />

          {/* Tasks */}
          <Route
            path="/tasks"
            element={
              <FeatureGate feature="tasks">
                <Tasks />
              </FeatureGate>
            }
          />
          <Route
            path="/tasks/:id"
            element={
              <FeatureGate feature="tasks">
                <TaskDetail />
              </FeatureGate>
            }
          />
        </Route>

        {/* Fallbacks */}
        <Route path="/forbidden" element={<Forbidden />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  );
}
