// src/components/ProtectedRoute.jsx
import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useTheme } from "../ThemeContext";

export default function ProtectedRoute({
  children,
  roles,            // optional: ['admin','manager',...]
  moduleKey,        // optional: 'projects' | 'assets' | ...
}) {
  const token = localStorage.getItem("token");
  const location = useLocation();
  const { org } = useTheme();

  // 1) Auth
  if (!token) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  // 2) Role check (if you already attach role to the token or user context, plug it in here)
  if (roles && roles.length) {
    try {
      const payload = JSON.parse(atob(token.split(".")[1] || "")) || {};
      const userRole = payload.role || payload.claims?.role;
      if (!roles.includes(userRole)) {
        return <Navigate to="/forbidden" replace />;
      }
    } catch {
      return <Navigate to="/forbidden" replace />;
    }
  }

  // 3) Module feature-flag check
  if (moduleKey) {
    // org.modules is an array in the UI; if the backend sends an object, normalize
    const enabledList = Array.isArray(org?.modules)
      ? org.modules
      : Object.entries(org?.modules || {})
          .filter(([, v]) => !!v)
          .map(([k]) => k);

    const enabled = new Set(enabledList);
    if (!enabled.has(moduleKey)) {
      // Hide access when module is disabled
      return <Navigate to="/forbidden" replace />;
    }
  }

  return children;
}
