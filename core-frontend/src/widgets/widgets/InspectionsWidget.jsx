import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { addRangeToParams, inRangeInclusiveISO } from "../util/dateRange";

export const id = "inspections";
export const title = "Inspections";

/* ---------- Filter bridge: RAG + DateRange + Project Context ---------- */
function useOptionalFilters(){
  let ctx = null; try { ctx = require("../FilterContext"); } catch {}
  if (ctx && ctx.useFilters){
    const slice = ctx.useFilters(["rag","dr","context"]);
    return {
      rag: slice.rag || "",
      dr:  slice.dr  || {},
      context: slice.context || {},
      setFilters: ctx.setFilters,
      emit: ctx.emit || ((d)=>window.dispatchEvent(new CustomEvent("dashboard:filtersChanged",{detail:d}))),
    };
  }
  // window fallback
  const [rag,setRag] = React.useState("");
  const [dr,setDr]   = React.useState({});
  const [context,setContext] = React.useState({});
  React.useEffect(()=>{
    const h=(e)=>{
      const d = e?.detail || {};
      if (d.rag !== undefined) setRag(d.rag || "");
      if (d.dr  !== undefined) setDr(d.dr  || {});
      if (d.context !== undefined) setContext(d.context || {});
    };
    window.addEventListener("dashboard:filtersChanged", h);
    return ()=>window.removeEventListener("dashboard:filtersChanged", h);
  },[]);
  return {
    rag, dr, context,
    setFilters:null,
    emit:(d)=>window.dispatchEvent(new CustomEvent("dashboard:filtersChanged",{detail:d})),
  };
}

/* -------------------------------- Helpers -------------------------------- */
const idStr = (v) => String(v?._id || v?.id || v?.userId || v?.assetId || v?.vehicleId || v || "");
function outcomeOf(r){
  const raw = String(r.overallResult || r.result || r.outcome || "").toLowerCase();
  if (raw.includes("fail")) return "failed";
  if (raw.includes("pass")) return "passed";
  if (r.passed === true)  return "passed";
  if (r.passed === false) return "failed";
  const items = Array.isArray(r.items) ? r.items : [];
  if (items.length) {
    const anyFail = items.some(it => String(it.result||"").toLowerCase()==="fail" || it.criticalTriggered);
    return anyFail ? "failed" : "passed";
  }
  return "passed";
}

function linkIdsFromSubmission(sub){
  const out = {
    projectId:"", projectIds:[]
  };
  const L = sub?.links || {};
  out.projectId  = idStr(L.projectId || sub.projectId || sub.project?.id);
  out.projectIds = []
    .concat(L.projectIds || [])
    .concat(sub.projects || [])
    .map(idStr).filter(Boolean);
  return out;
}

/* -------------------------------- Widget -------------------------------- */
export default function InspectionsWidget({ bare }) {
  const { rag, dr, context } = useOptionalFilters();

  const [rows, setRows] = useState([]);
  const [err, setErr]   = useState("");
  const [picked, setPicked] = useState(""); // local (visual) when no RAG

  // Fetch submissions (date-range aware)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const params = addRangeToParams(dr, { limit: 1600, _ts: Date.now() });
        const { data } = await api.get("/inspections/submissions", { params, timeout: 14000 });
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

  // Narrow to date range first
  const dateScoped = useMemo(() => {
    return rows.filter(r => inRangeInclusiveISO(
      r.submittedAt || r.createdAt || r.updatedAt, dr
    ));
  }, [rows, dr]);

  // Apply ONLY project context from map legend
  const scoped = useMemo(() => {
    const pid = String(context?.projectId || "");
    if (!pid) return dateScoped;
    return dateScoped.filter(r => {
      const L = linkIdsFromSubmission(r);
      return (L.projectId && L.projectId === pid) || (L.projectIds || []).includes(pid);
    });
  }, [dateScoped, context?.projectId]);

  // Count
  const counts = useMemo(() => {
    const b = { passed:0, failed:0 };
    for (const r of scoped) b[outcomeOf(r)] += 1;
    return b;
  }, [scoped]);

  // RAG → which chip is “on” (highlight only, does not affect counts)
  const ragBucket = useMemo(() => (
    rag === "green" ? "passed" :
    rag === "red"   ? "failed" : ""
  ), [rag]);

  const effective = ragBucket || picked || "";

  function onClick(key){
    if (ragBucket) return;                 // under MasterHealth control
    setPicked(prev => prev === key ? "" : key);
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2">
      {!bare && <div className="font-semibold">Inspections</div>}

      <style>{`
        .grid2{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.25rem; margin-top:.5rem; }
        .chip{
          display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;
          border:1px solid #e5e7eb; border-radius:10px; padding:6px 8px; min-height:54px;
          transition: box-shadow .15s ease, background .15s ease, border-color .15s ease, color .15s ease;
        }
        .chip:hover{ box-shadow:0 0 0 4px rgba(2,132,199,.12); }
        .lab{ font-size:12px; font-weight:600; line-height:1; }
        .cnt{ font-size:11px; margin-top:4px; }
        .on.green{ background:#ecfdf5; border-color:#10b981; color:#065f46; }
        .on.red  { background:#fef2f2; border-color:#ef4444; color:#7f1d1d; }
        .halo.green{ box-shadow:0 0 0 4px rgba(16,185,129,.18); }
        .halo.red  { box-shadow:0 0 0 4px rgba(239,68,68,.18); }
      `}</style>

      <div className="grid2">
        {[
          { key:"passed", tone:"green", label:"Passed", val:counts.passed },
          { key:"failed", tone:"red",   label:"Failed", val:counts.failed },
        ].map(c=>{
          const active = effective === c.key;
          const onCls  = active ? `on ${c.tone}` : "";
          const halo   = c.val > 0 ? `halo ${c.tone}` : "";
          return (
            <button
              key={c.key}
              type="button"
              className={`chip ${onCls} ${halo}`}
              title={ragBucket ? "Controlled by Portfolio Health" : (active ? "Click to clear" : `Filter: ${c.label}`)}
              onClick={()=>onClick(c.key)}
              disabled={!!ragBucket}
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
