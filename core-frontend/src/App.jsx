// src/App.jsx
import React from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";

import ProtectedRoute from "./components/ProtectedRoute.jsx";
import FeatureGate from "./components/FeatureGate.jsx";
import Navbar from "./components/Navbar.jsx";

import NotFound from "./pages/NotFound.jsx";
import Forbidden from "./pages/Forbidden.jsx";

import Projects from "./pages/Projects.jsx";
import ProjectDetail from "./pages/ProjectDetail.jsx";
import Users from "./pages/Users.jsx";
import Groups from "./pages/Groups.jsx"; // End-user group view (optional)
import Clockings from "./pages/Clockings.jsx";
import Assets from "./pages/Assets.jsx";
import AssetDetail from "./pages/AssetDetail.jsx";
import Vehicles from "./pages/Vehicles.jsx";
import VehicleDetail from "./pages/VehicleDetail.jsx";
import Invoices from "./pages/Invoices.jsx";
import Inspections from "./pages/Inspections.jsx"; // viewer for /inspections/:id
import AdminUsers from "./pages/AdminUsers.jsx";
import AdminOrg from "./pages/AdminOrg.jsx";
import Login from "./pages/Login.jsx";
import SystemBilling from "./pages/SystemBilling.jsx";
import Vault from "./pages/Vault.jsx";
import DocumentDetail from "./pages/DocumentDetail.jsx";
import Tasks from "./pages/Tasks.jsx";
import TaskDetail from "./pages/TaskDetail.jsx";
import AdminGroups from "./pages/AdminGroups.jsx";
import Trips from "./pages/Trips";
import AdminInspectionForms from "./pages/AdminInspectionForms.jsx";
import AdminInspectionFormBuilder from "./pages/AdminInspectionFormBuilder.jsx";
import InspectionsIndex from "./pages/InspectionsIndex.jsx";
import InspectionRun from "./pages/InspectionRun.jsx";
import InspectionSubmissionView from "./pages/InspectionSubmissionView.jsx";

function isAuthed() {
  return Boolean(localStorage.getItem("token"));
}

function HomeRedirect() {
  return isAuthed() ? <Navigate to="/projects" replace /> : <Navigate to="/login" replace />;
}

function AppLayout() {
  return (
    <>
      <Navbar />
      <Outlet />
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public */}
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signin" element={<Login />} />

        {/* Protected shell with navbar */}
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          {/* Optional: /admin base redirect */}
          <Route path="/admin" element={<Navigate to="/admin/users" replace />} />

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

          {/* End-user Groups (optional, gated under 'users') */}
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

          {/* Admin: Groups (CRUD) */}
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
              <FeatureGate feature="vehicles">{/* or "trips" if you add that flag */}
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
                <InspectionsIndex />
              </FeatureGate>
            }
          />
          <Route
            path="/inspections/:id"
            element={
              <FeatureGate feature="inspections">
                <Inspections />
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
            path="/inspections/submissions/:subId"
            element={
              <FeatureGate feature="inspections">
                <InspectionSubmissionView />
              </FeatureGate>
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

          {/* Admin-only */}
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
            path="/admin/inspections/forms/:formId"
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
