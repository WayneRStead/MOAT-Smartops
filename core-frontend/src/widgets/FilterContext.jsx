import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

/**
 * FilterContext v2
 * - rag: "green" | "amber" | "red" | ""
 * - dr:  { fromAt?: string, toAt?: string }
 * - project: { ids?: string[], status?: string[] }  // kept for backward compat (emits)
 * - context: { projectId?: string, projectName?: string } // NEW: “focused project” from map legend
 *
 * Semantics:
 * - RAG alone: highlight-only (do NOT change counts)
 * - RAG + DateRange OR RAG + project context: filter counts
 * - Project context comes from the map legend (or anywhere) via:
 *   window.dispatchEvent(new CustomEvent("map:projectSelected",{ detail:{ projectId, name } }))
 *   window.dispatchEvent(new CustomEvent("map:projectCleared"))
 */

const Ctx = createContext(null);

export function FilterProvider({ children }) {
  const [filters, setFilters] = useState({
    rag: "",
    dr: {},
    project: {},
    context: {}, // { projectId, projectName }
  });

  // Broadcast helper (unchanged API for widgets)
  const emit = (delta) => {
    // allow partial updates + emit window event for non-context consumers
    try {
      setFilters((prev) => ({ ...prev, ...delta }));
    } catch {}
    window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: delta }));
  };

  // Listen for map legend selection → set/clear project context
  useEffect(() => {
    const onPick = (e) => {
      const id = String(e?.detail?.projectId || "");
      const name = String(e?.detail?.name || "");
      if (!id) return;
      setFilters((prev) => ({ ...prev, context: { projectId: id, projectName: name } }));
      // Note: do not clobber existing project.ids; context is the driver
      window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: { context: { projectId: id, projectName: name } } }));
    };
    const onClear = () => {
      setFilters((prev) => ({ ...prev, context: {} }));
      window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: { context: {} } }));
    };
    window.addEventListener("map:projectSelected", onPick);
    window.addEventListener("map:projectCleared", onClear);
    return () => {
      window.removeEventListener("map:projectSelected", onPick);
      window.removeEventListener("map:projectCleared", onClear);
    };
  }, []);

  // Derived convenience flags:
  const hasDR = !!(filters?.dr?.fromAt || filters?.dr?.toAt || filters?.dr?.from || filters?.dr?.to);
  const hasContextProject = !!filters?.context?.projectId;

  /**
   * Rule used by widgets:
   * - applyRagFilter = (hasDR || hasContextProject)
   * - If false: RAG is cosmetic only (halo/highlight)
   */
  const derived = useMemo(() => ({
    ...filters,
    applyRagFilter: hasDR || hasContextProject,
  }), [filters, hasDR, hasContextProject]);

  const value = useMemo(() => ({
    ...derived,
    setFilters,
    emit,
    useFilters: (keys) => {
      // optional slice hook used by some widgets
      if (!Array.isArray(keys) || !keys.length) return derived;
      const out = {};
      for (const k of keys) out[k] = derived[k];
      return out;
    },
  }), [derived]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFilters(keys) {
  const ctx = useContext(Ctx);
  if (!ctx) return {};
  return ctx.useFilters(keys);
}
export function useFilterContext() {
  const ctx = useContext(Ctx);
  return ctx || {};
}
