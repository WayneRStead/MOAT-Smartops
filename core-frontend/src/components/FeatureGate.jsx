// src/components/FeatureGate.jsx
import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useTheme } from "../ThemeContext";

/**
 * Usage:
 * <FeatureGate feature="projects"><Projects/></FeatureGate>
 *
 * Accepts:
 * - org.modules as an array: ["projects","assets",...]
 * - org.modules as an object: { projects: true, assets: false, ... }
 */
export default function FeatureGate({ feature, children }) {
  const { org } = useTheme();
  const location = useLocation();

  // If org not loaded yet, render children to avoid flashes/loops.
  if (!org) return children;

  const mods = org.modules;

  // Normalize to a Set of enabled keys
  let enabled = new Set();
  if (Array.isArray(mods)) {
    enabled = new Set(mods);
  } else if (mods && typeof mods === "object") {
    enabled = new Set(Object.keys(mods).filter((k) => mods[k] !== false));
  }

  // If modules not configured, default to permissive (all enabled)
  const hasConfig = enabled.size > 0;
  const allowed = hasConfig ? enabled.has(feature) : true;

  if (!allowed) {
    return (
      <Navigate
        to="/forbidden"
        replace
        state={{ from: location, reason: "feature_disabled", feature }}
      />
    );
  }

  return children;
}
