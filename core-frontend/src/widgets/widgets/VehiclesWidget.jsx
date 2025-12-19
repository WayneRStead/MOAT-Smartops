import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";

export const id = "vehicles";
export const title = "Vehicles";

/* ---- Optional FilterContext (read-only) ---- */
function useOptionalFilters() {
  let ctx = null;
  try { ctx = require("../FilterContext"); } catch {}
  if (ctx && ctx.useFilters) {
    const slice = ctx.useFilters(["rag", "dr", "context"]);
    return {
      rag: slice.rag || "",
      dr: slice.dr || {},                          // { fromAt, toAt } optional
      context: slice.context || {},                // { projectId? }
    };
  }
  // Fallback: listen to window events only (read-only)
  const [rag, setRag] = React.useState("");
  const [dr, setDr] = React.useState({});
  const [context, setContext] = React.useState({});
  useEffect(() => {
    const h = (e) => {
      const d = e?.detail || {};
      if ("rag" in d) setRag(String(d.rag || ""));
      if ("dr" in d) setDr(d.dr || {});
      if ("context" in d) setContext(d.context || {});
    };
    window.addEventListener("dashboard:filtersChanged", h);
    return () => window.removeEventListener("dashboard:filtersChanged", h);
  }, []);
  return { rag, dr, context };
}

/* ---------------- Helpers ---------------- */
const idOf = (v) => String(v?._id || v?.id || v || "");
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");

function normStatus(v) {
  const raw = norm(v.status || v.state || v.condition || "");
  if (["stolen", "missing"].includes(raw)) return "stolen";
  if (["retired", "decommissioned", "inactive", "disposed"].includes(raw)) return "retired";
  if (["workshop", "maintenance", "maint", "repair", "service", "servicing", "in_maintenance"].includes(raw)) return "workshop";
  if (["active", "inuse", "available", "deployed"].includes(raw)) return "active";

  const tagStr = JSON.stringify(v.tags || v.labels || v.flags || "").toLowerCase();
  if (/\bstolen|missing\b/.test(tagStr)) return "stolen";
  if (/\bmaint|repair|service|workshop\b/.test(tagStr)) return "workshop";
  if (/\bretired|decommissioned|disposed\b/.test(tagStr)) return "retired";
  return "active";
}
function vehicleProjectId(v) {
  return (
    idOf(v.projectId) ||
    idOf(v.project?._id || v.project?.id) ||
    ""
  );
}

// Inclusive range test on a handful of plausible date fields; if none available, treat as in-range
function inRangeInclusiveVehicle(v, fromAt, toAt) {
  const fields = [v.updatedAt, v.createdAt, v.statusAt, v.workshopAt, v.assignedAt].filter(Boolean);
  if (!fromAt && !toAt) return true;
  if (!fields.length) return true;

  const F = fromAt ? new Date(fromAt).getTime() : -Infinity;
  const T = toAt   ? new Date(toAt).getTime()   : +Infinity;

  for (const f of fields) {
    const t = new Date(f).getTime();
    if (!Number.isFinite(t)) continue;
    if (t >= F && t <= T) return true;
  }
  return false;
}

/* ---------------- UI Chip ---------------- */
function Chip({ label, count, active, tone, halo, onClick, disabled }) {
  const ton = tone || "gray";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`chip ${active ? `on ${ton}` : ""} ${halo ? `halo ${ton}` : ""}`}
      title={disabled ? `${label} (controlled by Portfolio Health)` : (active ? `${label} (click to clear)` : `Filter: ${label}`)}
      aria-pressed={!!active}
    >
      <span className="chip-lab">{label}</span>
      <span className="chip-val">{count}</span>
    </button>
  );
}

/* ---------------- Widget ---------------- */
export default function VehiclesWidget({ bare }) {
  const { rag, dr, context } = useOptionalFilters();

  const [rows, setRows] = useState([]);
  const [err, setErr]   = useState("");
  const [loading, setLoading] = useState(false);

  // local chip selection (single-select). RAG is highlight-only.
  const [picked, setPicked] = useState(""); // "active" | "workshop" | "stolen" | "retired" | ""

  /* ----------- load vehicles once ----------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setErr("");
      try {
        const { data } = await api.get("/vehicles", { params: { limit: 2000, _ts: Date.now() }, timeout: 10000 });
        if (!alive) return;
        const list = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
        setRows(list);
      } catch (e) {
        if (!alive) return;
        setErr(e?.response?.data?.error || String(e));
        setRows([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  /* ----------- highlight (RAG) only ----------- */
  const ragHighlight = useMemo(() => (
    rag === "green" ? "active" :
    rag === "amber" ? "workshop" :
    rag === "red"   ? "stolen" : ""
  ), [rag]);

  /* ----------- apply DR + Project context ----------- */
  const scoped = useMemo(() => {
    if (!rows.length) return [];
    const fromAt = dr?.fromAt || dr?.from || "";
    const toAt   = dr?.toAt   || dr?.to   || "";
    const pid = String(context?.projectId || "");

    return rows.filter((v) => {
      if (!inRangeInclusiveVehicle(v, fromAt, toAt)) return false;
      if (pid && vehicleProjectId(v) !== pid) return false; // when a project is focused, show only vehicles of that project
      return true;
    });
  }, [rows, dr?.fromAt, dr?.toAt, dr?.from, dr?.to, context?.projectId]);

  /* ----------- bucket counts ----------- */
  const buckets = useMemo(() => {
    const out = { active: 0, workshop: 0, stolen: 0, retired: 0 };
    for (const v of scoped) out[normStatus(v)] += 1;
    return out;
  }, [scoped]);

  /* ----------- click handler ----------- */
  function onPick(key) {
    setPicked((prev) => (prev === key ? "" : key));
  }

  /* ----------- UI ----------- */
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2">
      {!bare && <div className="font-semibold">Vehicles</div>}

      <style>{`
        .grid4{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.35rem; margin-top:.5rem; }
        .chip{
          display:flex; flex-direction:column; align-items:center; justify-content:center;
          border:1px solid #e5e7eb; border-radius:10px; padding:8px 6px; cursor:pointer; user-select:none;
          transition: box-shadow .15s ease, background .15s ease, border-color .15s ease, color .15s ease;
          min-height: 56px;
        }
        .chip:hover{ box-shadow:0 0 0 4px rgba(2,132,199,.10); }
        .chip:disabled{ opacity:.75; cursor:default; }

        .chip-lab{ font-size:11px; line-height:1; text-align:center; }
        .chip-val{ font-size:11px; font-weight:700; margin-top:4px; line-height:1; }

        .on.green{  background:#ecfdf5; border-color:#10b981; color:#065f46; }
        .on.amber{  background:#fff7ed; border-color:#ea580c; color:#7c2d12; }
        .on.red{    background:#fef2f2; border-color:#ef4444; color:#7f1d1d; }
        .on.gray{   background:#f3f4f6; border-color:#9ca3af; color:#374151; }

        .halo.green{ box-shadow:0 0 0 4px rgba(16,185,129,.18); }
        .halo.amber{ box-shadow:0 0 0 4px rgba(234,88,12,.18); }
        .halo.red{   box-shadow:0 0 0 4px rgba(239,68,68,.18); }
        .halo.gray{  box-shadow:0 0 0 4px rgba(107,114,128,.18); }
      `}</style>

      {err && <div className="mt-1 text-xs text-red-600">{err}</div>}
      {loading && <div className="mt-1 text-xs text-gray-500">Loading…</div>}

      <div className="grid4">
        {[
          { key: "active",   label: "Active",   tone: "green",  count: buckets.active },
          { key: "workshop", label: "Workshop", tone: "amber",  count: buckets.workshop },
          { key: "stolen",   label: "Stolen",   tone: "red",    count: buckets.stolen },
          { key: "retired",  label: "Retired",  tone: "gray",   count: buckets.retired },
        ].map((b) => {
          const active = picked ? picked === b.key : (!picked && ragHighlight === b.key);
          const halo = b.count > 0;
          return (
            <Chip
              key={b.key}
              label={b.label}
              count={b.count}
              active={active}
              halo={halo}
              tone={b.tone}
              onClick={() => onPick(b.key)}
              disabled={false}
            />
          );
        })}
      </div>
    </div>
  );
}
