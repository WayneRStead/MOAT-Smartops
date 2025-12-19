// src/widgets/useSelectedProject.js
import { useEffect, useMemo, useState } from "react";

function getCachedProjects() {
  try { return Array.isArray(window.__PROJECTS__) ? window.__PROJECTS__ : []; } catch { return []; }
}
function toId(p){ return String(p?._id || p?.id || ""); }

export default function useSelectedProject() {
  // Try FilterContext if available; else listen to the window event
  let ctx = null;
  try { ctx = require("./FilterContext"); } catch {}

  const [ids, setIds] = useState([]);
  useEffect(() => {
    if (ctx?.useFilters) return; // Context version handles state
    const h = (e) => {
      const d = e?.detail || {};
      if (d?.project?.ids) setIds((d.project.ids || []).map(String));
    };
    window.addEventListener("dashboard:filtersChanged", h);
    return () => window.removeEventListener("dashboard:filtersChanged", h);
  }, [ctx?.useFilters]);

  const selectedIds = (ctx?.useFilters ? (ctx.useFilters(["project"]).project?.ids || []) : ids).map(String);

  // Resolve a name from window.__PROJECTS__ (set by MapPane edit below)
  const projects = getCachedProjects();
  const byId = useMemo(() => {
    const map = new Map();
    for (const p of projects) map.set(toId(p), (p.name || p.title || toId(p)));
    return map;
  }, [projects]);

  const isSingle = selectedIds.length === 1;
  const selectedId = isSingle ? String(selectedIds[0]) : "";
  const selectedName = isSingle ? (byId.get(selectedId) || selectedId) : "";

  return { selectedIds, selectedId, selectedName, isSingleSelected: isSingle };
}
