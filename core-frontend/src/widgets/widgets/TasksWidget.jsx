import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";

/** Registry identity (keep in sync with backend + AdminOrg) */
export const id = "tasks.all";
export const title = "Tasks";

/* ================= Optional FilterContext bridge ================= */
function useOptionalFilters() {
  let ctx = null;
  try { ctx = require("../FilterContext"); } catch {}
  if (ctx && ctx.useFilters) {
    // we read rag (highlight), dr (date range), and project context from map legend
    const slice = ctx.useFilters(["rag", "dr", "context"]);
    return {
      rag: slice.rag || "",
      dr: slice.dr || {},                                   // { fromAt, toAt }
      context: slice.context || {},                         // { projectId? }
      setFilters: ctx.setFilters,
      emit: ctx.emit || ((d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: d }))),
    };
  }
  // Fallback: listen to window events
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
  return { rag, dr, context, setFilters: null, emit: (d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: d })) };
}

/* ================= Helpers ================= */
const toId = (t) => String(t?._id || t?.id || "");
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "-");

function isClosedLike(s) {
  const t = norm(s);
  return ["done","closed","complete","completed","cancelled","canceled","void"].includes(t);
}
function isPausedLike(s) {
  const t = norm(s);
  return ["paused","paused-problem","on-hold","hold","pause"].includes(t);
}
function isStartedLike(s) {
  const t = norm(s);
  return ["open","in-progress","started","active","doing"].includes(t);
}
function dueOf(t) {
  return t.dueAt || t.dueDate || t.endAt || t.endDate || t.deadlineAt || t.due || null;
}
function startOf(t) {
  return t.startAt || t.startDate || t.begin || t.createdAt || null;
}
function isOverdueTask(t, now = new Date()) {
  const d = dueOf(t);
  if (!d) return false;
  const x = new Date(d);
  return !isNaN(+x) && x < now && !isClosedLike(t.status);
}
function intersectsRangeTask(t, fromAt, toAt) {
  if (!fromAt && !toAt) return true;
  const s = startOf(t) ? new Date(startOf(t)) : null;
  const e = dueOf(t)   ? new Date(dueOf(t))   : null;
  const from = fromAt ? new Date(fromAt) : null;
  const to   = toAt   ? new Date(toAt)   : null;
  const left  = s ? s.getTime() : -Infinity;
  const right = e ? e.getTime() : +Infinity;
  const L = from ? from.getTime() : -Infinity;
  const R = to   ? to.getTime()   : +Infinity;
  return left <= R && right >= L;
}
function taskProjectId(t) {
  return String(t.projectId || t.project?._id || t.project?.id || "");
}

/* ================= UI chip ================= */
function Chip({ label, count, active, tone, halo, onClick, disabled }) {
  const ton = tone || "gray";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
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
export default function TasksWidget({ bare }) {
  const { rag, dr, context, setFilters, emit } = useOptionalFilters();

  const [rows, setRows] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  // local focus (single-select); RAG is highlight-only
  const [picked, setPicked] = useState(""); // "open" | "paused" | "overdue" | "closed" | ""

  // Load tasks once
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setErr("");
      try {
        const { data } = await api.get("/tasks", { params: { limit: 2000, _ts: Date.now() }, timeout: 10000 });
        if (!alive) return;
        const list = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
        setRows(list);
      } catch (e) {
        if (!alive) return;
        setErr(e?.response?.data?.error || String(e));
        setRows([]);
      } finally {
        if (!alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  /* ---- RAG highlight only ---- */
  const ragHighlight = useMemo(() => (
    rag === "green" ? "open" :
    rag === "amber" ? "paused" :
    rag === "red"   ? "overdue" : ""
  ), [rag]);

  /* ---- scope by DateRange + Project context ---- */
  const scoped = useMemo(() => {
    if (!rows.length) return [];
    const fromAt = dr?.fromAt || dr?.from || "";
    const toAt   = dr?.toAt   || dr?.to   || "";
    const pid = String(context?.projectId || "");

    return rows.filter((t) => {
      if (!intersectsRangeTask(t, fromAt, toAt)) return false;
      if (pid && taskProjectId(t) !== pid) return false;
      return true;
    });
  }, [rows, dr?.fromAt, dr?.toAt, dr?.from, dr?.to, context?.projectId]);

  /* ---- bucket counts ---- */
  const buckets = useMemo(() => {
    const out = { open: 0, paused: 0, overdue: 0, closed: 0 };
    const now = new Date();
    for (const t of scoped) {
      let key = "open";
      if (isClosedLike(t.status)) key = "closed";
      else if (isOverdueTask(t, now)) key = "overdue";
      else if (isPausedLike(t.status)) key = "paused";
      else if (isStartedLike(t.status)) key = "open";
      out[key] += 1;
    }
    return out;
  }, [scoped]);

  /* ---- focused list (ids) for broadcast (optional) ---- */
  const focusedList = useMemo(() => {
    if (!picked) return [];
    const now = new Date();
    return scoped
      .filter((t) => {
        if (picked === "closed") return isClosedLike(t.status);
        if (picked === "overdue") return isOverdueTask(t, now);
        if (picked === "paused") return isPausedLike(t.status);
        // open
        return !isClosedLike(t.status) && !isOverdueTask(t, now) && !isPausedLike(t.status);
      })
      .map(toId)
      .filter(Boolean);
  }, [scoped, picked]);

  /* ---- broadcast (guarded) ---- */
  const prevSigRef = useRef("");
  useEffect(() => {
    const ids = picked ? focusedList : [];
    const sig = JSON.stringify({ k: picked || "", n: ids.length });
    if (sig === prevSigRef.current) return;
    prevSigRef.current = sig;

    const payload = { task: { status: picked ? [picked] : [], ids } };
    try { setFilters?.((prev) => ({ ...prev, task: { ...(prev?.task || {}), ...payload.task } })); } catch {}
    emit(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, focusedList.length]);

  /* ---- click handlers ---- */
  function onPick(key) {
    setPicked((prev) => (prev === key ? "" : key));
  }

  /* ---- UI ---- */
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2">
      {!bare && <div className="font-semibold">Tasks</div>}

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
          { key: "open",    label: "Open",    tone: "green", count: buckets.open },
          { key: "paused",  label: "Paused",  tone: "amber", count: buckets.paused },
          { key: "overdue", label: "Overdue", tone: "red",   count: buckets.overdue },
          { key: "closed",  label: "Closed",  tone: "gray",  count: buckets.closed },
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
              disabled={false}
              onClick={() => onPick(b.key)}
            />
          );
        })}
      </div>
    </div>
  );
}
