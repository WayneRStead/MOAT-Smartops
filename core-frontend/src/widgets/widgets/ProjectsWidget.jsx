import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";

/** Registry identity (keep in sync with backend + AdminOrg) */
export const id = "projects.all";
export const title = "Projects";

/* ================= Optional FilterContext bridge ================= */
function useOptionalFilters() {
  let ctx = null;
  try { ctx = require("../FilterContext"); } catch {}
  if (ctx && ctx.useFilters) {
    const slice = ctx.useFilters(["rag", "dr", "context"]);
    return {
      rag: slice.rag || "",
      dr: slice.dr || {}, // { fromAt, toAt }
      context: slice.context || {}, // { projectId?, projectName? }
      setFilters: ctx.setFilters,
      emit: ctx.emit || ((d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: d }))),
    };
  }
  // Fallback (window events)
  const [rag, setRag] = React.useState("");
  const [dr, setDr] = React.useState({});
  const [context, setContext] = React.useState({});
  React.useEffect(() => {
    const h = (e) => {
      const d = e?.detail || {};
      if ("rag" in d) setRag(String(d.rag || ""));
      if ("dr" in d) setDr(d.dr || {});
      if ("context" in d) setContext(d.context || {});
    };
    window.addEventListener("dashboard:filtersChanged", h);
    return () => window.removeEventListener("dashboard:filtersChanged", h);
  }, []);
  return {
    rag, dr, context,
    setFilters: null,
    emit: (d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: d })),
  };
}

/* ================= Helpers ================= */
const toId = (p) => String(p?._id || p?.id || "");
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "-");

function isClosedLike(s) {
  const t = norm(s);
  return ["done", "closed", "complete", "completed", "cancelled", "canceled", "void"].includes(t);
}
function isPausedLike(s) {
  const t = norm(s);
  return ["paused", "paused-problem", "on-hold", "hold", "pause"].includes(t);
}
function isOpenLike(s) {
  const t = norm(s);
  return ["open", "in-progress", "started", "active", "doing"].includes(t);
}
function endOf(p) {
  return p.end || p.endDate || p.due || p.deadlineAt || p.finishAt || null;
}
function startOf(p) {
  return p.start || p.startDate || p.begin || p.startAt || null;
}
function isOverdueProject(p, now = new Date()) {
  const d = endOf(p);
  if (!d) return false;
  const x = new Date(d);
  return !isNaN(+x) && x < now && !isClosedLike(p.status);
}
function intersectsRange(p, fromAt, toAt) {
  if (!fromAt && !toAt) return true;
  const s = startOf(p) ? new Date(startOf(p)) : null;
  const e = endOf(p) ? new Date(endOf(p)) : null;

  const from = fromAt ? new Date(fromAt) : null;
  const to   = toAt   ? new Date(toAt)   : null;

  if (!s && !e) return true;

  const left  = s ? s.getTime() : -Infinity;
  const right = e ? e.getTime() : +Infinity;
  const L = from ? from.getTime() : -Infinity;
  const R = to   ? to.getTime()   : +Infinity;

  return left <= R && right >= L;
}

/* ================= UI chip ================= */
function Chip({ label, count, active, tone, halo, onClick }) {
  const ton = tone || "gray";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`chip ${active ? `on ${ton}` : ""} ${halo ? `halo ${ton}` : ""}`}
      title={active ? `${label} (click to clear)` : `Filter: ${label}`}
      aria-pressed={!!active}
    >
      <span className="chip-lab">{label}</span>
      <span className="chip-val">{count}</span>
    </button>
  );
}

/* ================= Widget ================= */
export default function ProjectsWidget({ bare }) {
  const { rag, dr, context, setFilters, emit } = useOptionalFilters();

  const [rows, setRows] = useState([]);
  const [err, setErr]   = useState("");
  const [loading, setLoading] = useState(false);

  // local chip selection (single-select). RAG is highlight-only.
  const [picked, setPicked] = useState(""); // "active" | "paused" | "overdue" | "closed" | ""

  /* ------------------------ load projects ------------------------ */
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setErr("");
      try {
        const { data } = await api.get("/projects", { params: { limit: 2000, _ts: Date.now() }, timeout: 10000 });
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

  /* --------------------- highlight (RAG) only --------------------- */
  const ragHighlight = useMemo(() => (
    rag === "green" ? "active" :
    rag === "amber" ? "paused" :
    rag === "red"   ? "overdue" : ""
  ), [rag]);

  /* --------------------- scoped by DR + Context ------------------- */
  const scoped = useMemo(() => {
    if (!rows.length) return [];
    const fromAt = dr?.fromAt || dr?.from || "";
    const toAt   = dr?.toAt   || dr?.to   || "";
    const pid = String(context?.projectId || "");

    return rows.filter((p) => {
      if (!intersectsRange(p, fromAt, toAt)) return false;
      if (pid && toId(p) !== pid) return false; // when a project is focused, show only that project
      return true;
    });
  }, [rows, dr?.fromAt, dr?.toAt, dr?.from, dr?.to, context?.projectId]);

  /* ------------------------- bucket counts ----------------------- */
  const buckets = useMemo(() => {
    const out = { active: 0, paused: 0, overdue: 0, closed: 0 };
    const now = new Date();
    for (const p of scoped) {
      let key = "active";
      if (isClosedLike(p.status)) key = "closed";
      else if (isOverdueProject(p, now)) key = "overdue";
      else if (isPausedLike(p.status)) key = "paused";
      else if (isOpenLike(p.status)) key = "active";
      out[key] += 1;
    }
    return out;
  }, [scoped]);

  /* ------------------- ids for broadcasting ---------------------- */
  const focusedList = useMemo(() => {
    if (!picked) return [];
    const now = new Date();
    return scoped
      .filter((p) => {
        if (picked === "closed") return isClosedLike(p.status);
        if (picked === "overdue") return isOverdueProject(p, now);
        if (picked === "paused")  return isPausedLike(p.status);
        return !isClosedLike(p.status) && !isOverdueProject(p, now) && !isPausedLike(p.status);
      })
      .map(toId)
      .filter(Boolean);
  }, [scoped, picked]);

  /* ------------------- broadcast (only project.ids) --------------- */
  const prevSigRef = useRef("");
  useEffect(() => {
    const ids = picked ? focusedList : [];
    const sig = JSON.stringify({ k: picked || "", n: ids.length });
    if (sig === prevSigRef.current) return;
    prevSigRef.current = sig;

    const payload = { project: { ids, status: picked ? [picked] : [] } };
    try { setFilters?.((prev) => ({ ...prev, project: { ...(prev?.project || {}), ...payload.project } })); } catch {}
    emit(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, focusedList.length]);

  /* -------------------------- handlers --------------------------- */
  function onPick(key) {
    setPicked((prev) => (prev === key ? "" : key));
  }

  /* ---------------------------- UI ------------------------------- */
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2">
      {!bare && <div className="font-semibold">Projects</div>}

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

        .on.green{ background:#ecfdf5; border-color:#10b981; color:#065f46; }
        .on.amber{ background:#fff7ed; border-color:#ea580c; color:#7c2d12; }
        .on.red{   background:#fef2f2; border-color:#ef4444; color:#7f1d1d; }
        .on.gray{  background:#f3f4f6; border-color:#9ca3af; color:#374151; }

        .halo.green{ box-shadow:0 0 0 4px rgba(16,185,129,.18); }
        .halo.amber{ box-shadow:0 0 0 4px rgba(234,88,12,.18); }
        .halo.red{   box-shadow:0 0 0 4px rgba(239,68,68,.18); }
        .halo.gray{  box-shadow:0 0 0 4px rgba(107,114,128,.18); }
      `}</style>

      {err && <div className="mt-1 text-xs text-red-600">{err}</div>}
      {loading && <div className="mt-1 text-xs text-gray-500">Loading…</div>}

      <div className="grid4">
        {[
          { key: "active",  label: "Active",  tone: "green",  count: buckets.active },
          { key: "paused",  label: "Paused",  tone: "amber",  count: buckets.paused },
          { key: "overdue", label: "Overdue", tone: "red",    count: buckets.overdue },
          { key: "closed",  label: "Closed",  tone: "gray",   count: buckets.closed },
        ].map((b) => {
          const active = picked ? picked === b.key : (!picked && ragHighlight === b.key);
          const halo = b.count > 0; // halo when there’s something to see
          return (
            <Chip
              key={b.key}
              label={b.label}
              count={b.count}
              active={active}
              halo={halo}
              tone={b.tone}
              onClick={() => onPick(b.key)}
            />
          );
        })}
      </div>
    </div>
  );
}
