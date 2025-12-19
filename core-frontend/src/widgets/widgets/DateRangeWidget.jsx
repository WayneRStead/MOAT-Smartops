// src/widgets/widgets/DateRangeWidget.jsx
import React from "react";

/** Registry identity */
export const id = "date.range";
export const title = "Date Range";

function useOptionalFilters() {
  let ctx = null;
  try { ctx = require("../FilterContext"); } catch {}
  if (ctx && ctx.useFilters) {
    const slice = ctx.useFilters(["dr"]);
    return {
      dr: slice.dr || {},
      setFilters: ctx.setFilters,
      emit: ctx.emit || ((d)=>window.dispatchEvent(new CustomEvent("dashboard:filtersChanged",{detail:d}))),
    };
  }
  const [dr, setDr] = React.useState({});
  React.useEffect(()=>{
    const h=(e)=>{ if(e?.detail?.dr!==undefined) setDr(e.detail.dr||{}); };
    window.addEventListener("dashboard:filtersChanged", h);
    return ()=>window.removeEventListener("dashboard:filtersChanged", h);
  },[]);
  return {
    dr,
    setFilters: null,
    emit: (d)=>window.dispatchEvent(new CustomEvent("dashboard:filtersChanged",{detail:d})),
  };
}

function startOfDayISO(s){
  if(!s) return "";
  const d = new Date(s);
  if (isNaN(+d)) return "";
  d.setHours(0,0,0,0);
  return d.toISOString();
}
function endOfDayISO(s){
  if(!s) return "";
  const d = new Date(s);
  if (isNaN(+d)) return "";
  d.setHours(23,59,59,999);
  return d.toISOString();
}

export default function DateRangeWidget({ bare }) {
  const { dr, setFilters, emit } = useOptionalFilters();
  const [from, setFrom] = React.useState(dr?.from?.slice(0,10) || "");
  const [to, setTo]     = React.useState(dr?.to?.slice(0,10)   || "");

  React.useEffect(()=>{ // sync if external changes occur
    if ((dr?.from || "")?.slice(0,10) !== from) setFrom((dr?.from || "").slice(0,10));
    if ((dr?.to   || "")?.slice(0,10) !== to)   setTo((dr?.to   || "").slice(0,10));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dr?.from, dr?.to]);

  function apply() {
    const payload = (from || to) ? {
      from: from ? new Date(from).toISOString() : "",
      to:   to   ? new Date(to).toISOString()   : "",
      // convenience fields for backends that prefer explicit bounds
      fromAt: startOfDayISO(from),
      toAt:   endOfDayISO(to),
    } : {};
    try { setFilters?.((prev)=>({ ...prev, dr: payload })); } catch {}
    emit({ dr: payload });
  }
  function clear() {
    setFrom(""); setTo("");
    try { setFilters?.((prev)=>({ ...prev, dr: {} })); } catch {}
    emit({ dr: {} });
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2">
      {!bare && <div className="font-semibold">Date Range</div>}
      <div className="mt-2 flex items-center gap-2">
        <input
          type="date"
          value={from}
          onChange={(e)=>setFrom(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
          aria-label="From date"
        />
        <span className="text-xs text-gray-500">to</span>
        <input
          type="date"
          value={to}
          onChange={(e)=>setTo(e.target.value)}
          className="border rounded px-2 py-1 text-sm"
          aria-label="To date"
        />
        <button type="button" className="border rounded px-2 py-1 text-sm" onClick={apply}>
          Apply
        </button>
        {(dr?.from || dr?.to) && (
          <button type="button" className="border rounded px-2 py-1 text-sm" onClick={clear} title="Clear date range">
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
