import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { inRangeInclusiveISO, addRangeToParams } from "../util/dateRange";

export const id = "invoices";
export const title = "Invoices";

/* ---- Filter bridge (rag + date range + project context) ---- */
function useOptionalFilters() {
  let ctx = null;
  try { ctx = require("../FilterContext"); } catch {}
  if (ctx && ctx.useFilters) {
    const slice = ctx.useFilters(["rag", "dr", "context"]);
    return {
      rag: slice.rag || "",
      dr: slice.dr || {},
      context: slice.context || {},
      setFilters: ctx.setFilters,
      emit: ctx.emit || ((d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged",{ detail:d }))),
    };
  }
  // window fallback
  const [rag, setRag] = React.useState("");
  const [dr, setDr] = React.useState({});
  const [context, setContext] = React.useState({});
  React.useEffect(() => {
    const h = (e) => {
      if (e?.detail?.rag !== undefined) setRag(e.detail.rag || "");
      if (e?.detail?.dr  !== undefined) setDr(e.detail.dr  || {});
      if (e?.detail?.context !== undefined) setContext(e.detail.context || {});
    };
    window.addEventListener("dashboard:filtersChanged", h);
    return () => window.removeEventListener("dashboard:filtersChanged", h);
  }, []);
  return {
    rag, dr, context, setFilters: null,
    emit: (d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged",{ detail:d })),
  };
}

/* ---- helpers ---- */
function dateOrNull(d) {
  if (!d) return null;
  const x = new Date(d);
  return isNaN(+x) ? null : x;
}
function dueFrom(row) {
  const submitted = row.submittedAt || row.issuedAt || row.createdAt;
  const termsDays = Number(row.termsDays ?? row.terms ?? 0);
  const base = dateOrNull(submitted);
  if (!base) return null;
  const dt = new Date(base);
  dt.setHours(23, 59, 59, 999);
  dt.setDate(dt.getDate() + (Number.isFinite(termsDays) ? termsDays : 0));
  return dt.toISOString();
}
function statusOf(row) {
  const raw = String(row.status || "").toLowerCase();
  if (raw === "void" || raw === "cancelled" || raw === "canceled") return "void";
  if (raw === "paid" || row.paidAt) return "paid";
  const due = dueFrom(row);
  if (due && new Date(due) < new Date()) return "overdue";
  return "submitted";
}
function projIdOf(inv) {
  return String(
    inv.projectId ||
    inv.project?.id || inv.project?._id ||
    inv.links?.projectId ||
    ""
  );
}

/* ---- widget ---- */
export default function InvoicesSummaryWidget({ bare }) {
  const { rag, dr, context /*, emit*/ } = useOptionalFilters();

  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState(""); // visual only

  // fetch (date-range aware)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const params = addRangeToParams(dr, { limit: 1000, _ts: Date.now() });
        const { data } = await api.get("/invoices", { params, timeout: 12000 });
        if (!alive) return;
        const list = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
        setRows(list);
        setErr("");
      } catch (e) {
        if (!alive) return;
        setRows([]);
        setErr(e?.response?.data?.error || String(e));
      }
    })();
    return () => { alive = false; };
  }, [dr?.fromAt, dr?.toAt, dr?.from, dr?.to]);

  // scope by Date Range
  const dateScoped = useMemo(() => {
    return rows.filter(r =>
      inRangeInclusiveISO(r.paidAt || r.submittedAt || r.issuedAt || r.createdAt, dr)
    );
  }, [rows, dr]);

  // scope by Project Context (map legend)
  const scoped = useMemo(() => {
    const pid = String(context?.projectId || "");
    if (!pid) return dateScoped;
    return dateScoped.filter(inv => projIdOf(inv) === pid);
  }, [dateScoped, context?.projectId]);

  // counts
  const buckets = useMemo(() => {
    const b = { paid: 0, submitted: 0, overdue: 0, void: 0 };
    for (const inv of scoped) b[statusOf(inv)] += 1;
    return b;
  }, [scoped]);

  // RAG -> visual default; counts unaffected
  const ragBucket = useMemo(() => (
    rag === "green" ? "paid" :
    rag === "amber" ? "submitted" :
    rag === "red"   ? "overdue" : ""
  ), [rag]);

  function onClickBucket(key) {
    setPicked(prev => (prev === key ? "" : key));
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2">
      {!bare && <div className="font-semibold">Invoices</div>}

      <style>{`
        .grid4{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.25rem; margin-top:.5rem; }
        .chip{
          display:flex; flex-direction:column; align-items:center; justify-content:center;
          text-align:center;
          border:1px solid #e5e7eb; border-radius:10px; padding:6px 8px; min-height:54px;
          transition: box-shadow .15s ease, background .15s ease, border-color .15s ease, color .15s ease;
        }
        .chip:hover{ box-shadow:0 0 0 4px rgba(2,132,199,.12); }
        .lab{ font-size:12px; font-weight:600; line-height:1; }
        .cnt{ font-size:11px; margin-top:4px; }

        .on.green  { background:#ecfdf5; border-color:#10b981; color:#065f46; }
        .on.amber  { background:#fff7ed; border-color:#ea580c; color:#7c2d12; }
        .on.red    { background:#fef2f2; border-color:#ef4444; color:#7f1d1d; }
        .on.gray   { background:#f3f4f6; border-color:#9ca3af; color:#374151; }

        .halo.green{ box-shadow:0 0 0 4px rgba(16,185,129,.18); }
        .halo.amber{ box-shadow:0 0 0 4px rgba(234,88,12,.18); }
        .halo.red  { box-shadow:0 0 0 4px rgba(239,68,68,.18); }
        .halo.gray { box-shadow:0 0 0 4px rgba(107,114,128,.18); }
      `}</style>

      <div className="grid4">
        {[
          { key: "paid",      tone: "green", label: "Paid",      val: buckets.paid },
          { key: "submitted", tone: "amber", label: "Submitted", val: buckets.submitted },
          { key: "overdue",   tone: "red",   label: "Overdue",   val: buckets.overdue },
          { key: "void",      tone: "gray",  label: "Void",      val: buckets.void },
        ].map(c => {
          const active = picked ? (picked === c.key) : (ragBucket === c.key && !picked);
          const onCls = active ? `on ${c.tone}` : "";
          const halo  = c.val > 0 ? `halo ${c.tone}` : "";
          return (
            <button
              key={c.key}
              type="button"
              className={`chip ${onCls} ${halo}`}
              title={active ? "Click to clear" : `Filter: ${c.label}`}
              onClick={() => onClickBucket(c.key)}
            >
              <div className="lab">{c.label}</div>
              <div className="cnt">{c.val}</div>
            </button>
          );
        })}
      </div>

      {err && <div className="mt-2 text-xs text-red-600">{err}</div>}
    </div>
  );
}
