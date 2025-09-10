// src/App.jsx
import React from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import Navbar from "./components/Navbar.jsx";
import FeatureGate from "./components/FeatureGate.jsx";
import NotFound from "./pages/NotFound.jsx";
import Forbidden from "./pages/Forbidden.jsx";

import Projects from "./pages/Projects.jsx";
import ProjectDetail from "./pages/ProjectDetail.jsx";
import Users from "./pages/Users.jsx";
import Clockings from "./pages/Clockings.jsx";
import Assets from "./pages/Assets.jsx";
import AssetDetail from "./pages/AssetDetail.jsx";
import Vehicles from "./pages/Vehicles.jsx";
import VehicleDetail from "./pages/VehicleDetail.jsx";
import Invoices from "./pages/Invoices.jsx";
import Inspections from "./pages/Inspections.jsx";
import AdminUsers from "./pages/AdminUsers.jsx";
import AdminOrg from "./pages/AdminOrg.jsx";
import Login from "./pages/Login.jsx";
import SystemBilling from "./pages/SystemBilling.jsx";
import Vault from "./pages/Vault.jsx";
import DocumentDetail from "./pages/DocumentDetail.jsx";
import Tasks from "./pages/Tasks.jsx";
import TaskDetail from "./pages/TaskDetail.jsx";

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

          {/* Clockings */}
          <Route
            path="/clockings"
            element={
              <FeatureGate feature="clockings">
                <Clockings />
              </FeatureGate>
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
        <Route path="*" element={<div className="p-6">Not found</div>} />
        <Route path="*" element={<NotFound />} />
        <Route path="/forbidden" element={<Forbidden />} />
      </Routes>
    </BrowserRouter>
  );
}
