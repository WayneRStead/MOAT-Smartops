// src/widgets/widgets/MasterHealthWidget.jsx
import React, { useMemo } from "react";

/** Registry identity */
export const id = "health.master";
export const title = "Portfolio Health";

/* ---- Filter bridge ---- */
function useOptionalFilters() {
  let ctx = null;
  try { ctx = require("../FilterContext"); } catch {}
  if (ctx && ctx.useFilters) {
    const slice = ctx.useFilters(["rag", "dr", "context", "applyRagFilter"]);
    return {
      rag: slice.rag || "",
      dr: slice.dr || {},
      context: slice.context || {},
      applyRagFilter: !!slice.applyRagFilter,
      setFilters: ctx.setFilters,
      emit: ctx.emit || ((d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: d }))),
    };
  }
  // Fallback: window-only
  const [rag, setRagState] = React.useState("");
  const [dr, setDr] = React.useState({});
  const [context, setContext] = React.useState({});
  const applyRagFilter = !!(dr?.fromAt || dr?.toAt || context?.projectId);
  React.useEffect(() => {
    const h = (e) => {
      const d = e?.detail || {};
      if (d.rag !== undefined) setRagState(d.rag || "");
      if (d.dr) setDr(d.dr);
      if (d.context !== undefined) setContext(d.context || {});
    };
    window.addEventListener("dashboard:filtersChanged", h);
    return () => window.removeEventListener("dashboard:filtersChanged", h);
  }, []);
  return {
    rag, dr, context, applyRagFilter,
    setFilters: null,
    emit: (d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: d })),
  };
}

export default function MasterHealthWidget({ bare }) {
  const { rag, context, applyRagFilter, setFilters, emit } = useOptionalFilters();

  // Title changes when a project is focused from the map legend
  const heading = context?.projectName ? `${context.projectName} Health` : "Portfolio Health";

  const options = useMemo(() => ([
    { key: "green", label: "Healthy",   hint: "Active / Passed / Paid / Present" },
    { key: "amber", label: "At Risk",   hint: "Paused / Maintenance / Submitted / Blocked" },
    { key: "red",   label: "Critical",  hint: "Overdue / IOD / Failed / Missing" },
  ]), []);

  function setRag(next) {
    const val = (rag === next ? "" : next); // toggle off on second click
    try { setFilters?.((prev) => ({ ...prev, rag: val })); } catch {}
    emit({ rag: val });
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2">
      {!bare && <div className="font-semibold">{heading}</div>}

      <style>{`
        .rag-grid{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:.5rem; margin-top:.5rem; }
        .rag-btn{
          display:flex; flex-direction:column; align-items:center; justify-content:center;
          border:1px solid #e5e7eb; border-radius:10px; padding:8px 6px; cursor:pointer; user-select:none;
          transition: box-shadow .15s ease, background .15s ease, border-color .15s ease, color .15s ease;
        }
        .rag-btn:hover{ box-shadow:0 0 0 4px rgba(2,132,199,.12); }
        .rag-dot{ width:12px; height:12px; border-radius:9999px; margin-bottom:6px; }
        .rag-lab{ font-size:12px; font-weight:600; line-height:1; }
        .rag-hint{ font-size:10px; color:#6b7280; margin-top:2px; text-align:center; }

        /* Active: fill + halo with the right tone */
        .is-green{ background:#ecfdf5; border-color:#86efac; box-shadow:0 0 0 4px rgba(16,185,129,.18); color:#065f46; }
        .is-amber{ background:#fff7ed; border-color:#fdba74; box-shadow:0 0 0 4px rgba(234,88,12,.18); color:#7c2d12; }
        .is-red{   background:#fef2f2; border-color:#fca5a5; box-shadow:0 0 0 4px rgba(239,68,68,.18); color:#7f1d1d; }

        /* Small state hint (top-right) to explain effect */
        .hint{
          margin-top:6px; font-size:11px; color:#6b7280; text-align:center;
        }
      `}</style>

      <div className="rag-grid" role="group" aria-label={`${heading} filter`}>
        {options.map(opt => {
          const active = rag === opt.key;
          const cls = "rag-btn " + (active
            ? (opt.key === "green" ? "is-green" : opt.key === "amber" ? "is-amber" : "is-red")
            : "");
          const dotStyle =
            opt.key === "green" ? { background:"#10b981" } :
            opt.key === "amber" ? { background:"#ea580c" } :
            { background:"#ef4444" };

          return (
            <button
              key={opt.key}
              type="button"
              className={cls}
              onClick={() => setRag(opt.key)}
              title={active ? `${opt.label} (click to clear)` : opt.hint}
              aria-pressed={active}
            >
              <div className="rag-dot" style={dotStyle} />
              <div className="rag-lab">{opt.label}</div>
              <div className="rag-hint">{opt.hint}</div>
            </button>
          );
        })}
      </div>

      {/* Let users know what RAG will do right now */}
      <div className="hint">
        {applyRagFilter
          ? "RAG will FILTER counts (date range or project in focus)."
          : "RAG only HIGHLIGHTS (counts unchanged)."}
      </div>
    </div>
  );
}
