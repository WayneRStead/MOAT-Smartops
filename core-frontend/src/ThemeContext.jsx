// src/ThemeContext.jsx
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { getOrg } from "./api";

const ThemeCtx = createContext({ org: null, setOrg: () => {} });

export function ThemeProvider({ children }) {
  const [org, setOrg] = useState(null);

  // Load org (never throw)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await getOrg();
        if (alive) setOrg(data || {});
      } catch (e) {
        console.warn("getOrg failed:", e);
        if (alive) setOrg({});
      }
    })();
    return () => { alive = false; };
  }, []);

  // Derive theme & accent with legacy fallbacks
  const themeMode = useMemo(() => {
    if (org?.themeMode) return org.themeMode;            // "light" | "dark" | "system"
    if (org?.theme?.mode) return org.theme.mode;         // legacy
    return "system";
  }, [org]);

  const accent = useMemo(() => {
    return org?.accentColor || org?.theme?.color || "#2a7fff";
  }, [org]);

  // Apply theme + accent (safe in any browser)
  const mqlRef = useRef(null);
  useEffect(() => {
    const root = document.documentElement;
    try {
      root.style.setProperty("--accent", accent);
    } catch {}

    // remove old listener if any
    try {
      if (mqlRef.current?.removeEventListener) {
        mqlRef.current.removeEventListener("change", mqlRef.current._handler);
        mqlRef.current = null;
      }
    } catch {}

    if (themeMode === "light" || themeMode === "dark") {
      root.dataset.theme = themeMode;
      return;
    }

    // system
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
