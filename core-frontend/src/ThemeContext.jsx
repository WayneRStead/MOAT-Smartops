// src/ThemeContext.jsx
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
// ⚠️ Make sure this path matches your project structure:
import { getOrg } from "./lib/api"; // was "./api" in your paste

const ThemeCtx = createContext({ org: null, setOrg: () => {} });

/* ---- tiny helpers (local only) ---- */
function getToken() {
  try {
    return localStorage.getItem("token") || sessionStorage.getItem("token") || "";
  } catch {
    return "";
  }
}

// ✅ Include currentOrgId; keep the others for backward compat.
function getOrgIdFromStorage() {
  try {
    return (
      localStorage.getItem("currentOrgId") ||
      sessionStorage.getItem("currentOrgId") ||
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

export function ThemeProvider({ children }) {
  const [org, setOrg] = useState(null);

  // Load org when authed and (ideally) org-scoped
  useEffect(() => {
    let alive = true;

    async function load() {
      const token = getToken();
      const orgId = getOrgIdFromStorage();

      // If not signed in, set empty org to keep UI alive
      if (!token) {
        if (alive) setOrg({});
        return;
      }

      try {
        /**
         * We try to fetch the org even if orgId is missing, because:
         * - Your axios interceptor can derive orgId from token payload
         * - Or the server may default to the user's primary org
         * This avoids the "defaults" screen after a fresh login.
         */
        const data = await getOrg();
        if (alive) setOrg(data || {});
      } catch (_e) {
        // If it failed and there was no orgId, keep the UI alive with {}
        if (alive) setOrg({});
      }
    }

    load();

    // Re-evaluate when any of these change (e.g., login, org switch)
    const onStorage = (ev) => {
      if (!ev || !ev.key) return;
      // ✅ Listen for currentOrgId too
      if (["token", "currentOrgId", "orgId", "tenantId"].includes(ev.key)) {
        load();
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      alive = false;
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // Derive theme & accent with legacy fallbacks
  const themeMode = useMemo(() => {
    if (org?.themeMode) return org.themeMode;   // "light" | "dark" | "system"
    if (org?.theme?.mode) return org.theme.mode;
    return "system";
  }, [org]);

  const accent = useMemo(() => {
    return org?.accentColor || org?.theme?.color || "#2a7fff";
  }, [org]);

  // Apply theme + accent
  const mqlRef = useRef(null);
  useEffect(() => {
    const root = document.documentElement;
    try { root.style.setProperty("--accent", accent); } catch {}

    // clean previous listener
    try {
      if (mqlRef.current?.removeEventListener && mqlRef.current?._handler) {
        mqlRef.current.removeEventListener("change", mqlRef.current._handler);
        mqlRef.current = null;
      }
    } catch {}

    if (themeMode === "light" || themeMode === "dark") {
      root.dataset.theme = themeMode;
      return;
    }

    // "system"
    const mql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    const apply = () => { root.dataset.theme = mql && mql.matches ? "dark" : "light"; };
    apply();

    if (mql?.addEventListener) {
      const handler = () => apply();
      mql.addEventListener("change", handler);
      mql._handler = handler;
      mqlRef.current = mql;
    }
    return () => {
      try {
        if (mqlRef.current?.removeEventListener && mqlRef.current?._handler) {
          mqlRef.current.removeEventListener("change", mqlRef.current._handler);
          mqlRef.current = null;
        }
      } catch {}
    };
  }, [themeMode, accent]);

  return (
    <ThemeCtx.Provider value={{ org, setOrg }}>
      {children}
    </ThemeCtx.Provider>
  );
}

export const useTheme = () => useContext(ThemeCtx);
