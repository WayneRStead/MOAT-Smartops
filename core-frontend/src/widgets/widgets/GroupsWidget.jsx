// src/widgets/widgets/GroupsWidget.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";

/** Registry identity — must match backend + registry LEGACY map */
export const id = "groups";
export const title = "Groups";

/* ================= Optional FilterContext bridge ================= */
function useOptionalFilters() {
  let ctx = null;
  try { ctx = require("../FilterContext"); } catch {}
  if (ctx && ctx.useFilters) {
    // read rag (master), dr (date range), project focus via context, and current groups
    const slice = ctx.useFilters(["rag", "dr", "project", "context", "groups"]);
    return {
      rag: slice.rag || "",
      dr: slice.dr || {},
      context: slice.context || {},
      projectFocusIds: (slice.project?.ids || []).map(String), // legacy fallback
      currentGroups: (slice.groups?.ids || []).map(String),    // may be empty
      setFilters: ctx.setFilters,
      emit: ctx.emit || ((d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: d }))),
    };
  }

  // Fallback: minimal window-event bridge
  const [rag, setRag] = React.useState("");
  const [dr, setDr] = React.useState({});
  const [context, setContext] = React.useState({});
  const [projectFocusIds, setProjectFocusIds] = React.useState([]);
  const [currentGroups, setCurrentGroups] = React.useState([]);
  useEffect(() => {
    const h = (e) => {
      const d = e?.detail || {};
      if ("rag" in d) setRag(String(d.rag || ""));
      if ("dr" in d) setDr(d.dr || {});
      if ("context" in d) setContext(d.context || {});
      if (d.project && Array.isArray(d.project.ids)) setProjectFocusIds(d.project.ids.map(String));
      if (d.groups && Array.isArray(d.groups.ids)) setCurrentGroups(d.groups.ids.map(String));
    };
    window.addEventListener("dashboard:filtersChanged", h);
    return () => window.removeEventListener("dashboard:filtersChanged", h);
  }, []);
  return {
    rag, dr, context, projectFocusIds, currentGroups,
    setFilters: null,
    emit: (d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: d })),
  };
}

/* ================= Helpers ================= */
const idOf = (v) => String(v?._id || v?.id || v || "");
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "-");

function isClosedLike(s) {
  const t = norm(s);
  return ["done","closed","complete","completed","cancelled","canceled","void"].includes(t);
}
function dueOf(t) {
  return t.dueAt || t.dueDate || t.endAt || t.endDate || t.deadlineAt || t.due || null;
}
function startOf(t) {
  return t.startAt || t.startDate || t.begin || t.createdAt || null;
}
function intersectsRangeTask(t, fromAt, toAt) {
  if (!fromAt && !toAt) return true;              // include edges (inclusive)
  const s = startOf(t) ? new Date(startOf(t)) : null;
  const e = dueOf(t)   ? new Date(dueOf(t))   : null;
  const from = fromAt ? new Date(fromAt) : null;
  const to   = toAt   ? new Date(toAt)   : null;
  const left  = s ? s.getTime() : -Infinity;
  const right = e ? e.getTime() : +Infinity;
  const L = from ? from.getTime() : -Infinity;
  const R = to   ? to.getTime()   : +Infinity;
  return left <= R && right >= L;                 // overlapping intervals
}
function taskGroupIds(t) {
  const pool = []
    .concat(t.groupId || [])
    .concat(t.groups || [])
    .concat(t.group || [])
    .concat(t.assigneeGroupId || []);
  const out = new Set();
  for (const v of pool.flat()) {
    const s = idOf(v);
    if (s) out.add(s);
  }
  return Array.from(out);
}
function taskProjectId(t) {
  return String(t.projectId || t.project?._id || t.project?.id || "");
}

/* ================= UI chip ================= */
function Chip({ label, count, active, halo, tone, onClick, disabled }) {
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

/* ================= Widget (Active / Idle) ================= */
export default function GroupsWidget({ bare }) {
  const { rag, dr, context, projectFocusIds, currentGroups, setFilters, emit } = useOptionalFilters();

  const [groups, setGroups] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  // local picked bucket (single-select)
  const [picked, setPicked] = useState(""); // "active" | "idle" | ""

  /* ---- Load groups + tasks ---- */
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setErr("");
      try {
        const [g, t] = await Promise.all([
          api.get("/groups", { params: { limit: 2000, _ts: Date.now() }, timeout: 10000 }),
          api.get("/tasks",  { params: { limit: 2000, _ts: Date.now() }, timeout: 10000 }),
        ]);
        if (!alive) return;
        const gl = Array.isArray(g.data) ? g.data : Array.isArray(g.data?.rows) ? g.data.rows : [];
        const tl = Array.isArray(t.data) ? t.data : Array.isArray(t.data?.rows) ? t.data.rows : [];
        setGroups(gl);
        setTasks(tl);
      } catch (e) {
        if (!alive) return;
        setErr(e?.response?.data?.error || String(e));
        setGroups([]); setTasks([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  /* ---- RAG highlight only (no red mapping here) ---- */
  const ragHighlight = rag === "green" ? "active" : rag === "amber" ? "idle" : "";
  // UI highlight prefers actual user pick; otherwise show RAG highlight
  const uiKey = picked || ragHighlight;

  /* ---- Scope tasks by DateRange + Project selection (context.projectId preferred) ---- */
  const scopedTasks = useMemo(() => {
    if (!tasks.length) return [];
    const fromAt = dr?.fromAt || dr?.from || "";
    const toAt   = dr?.toAt   || dr?.to   || "";
    const focusedProjectId = String(context?.projectId || "");
    const wantProjects = focusedProjectId
      ? [focusedProjectId]
      : (projectFocusIds || []).map(String);
    const restrictByProjects = wantProjects.length > 0;

    return tasks.filter((t) => {
      if (!intersectsRangeTask(t, fromAt, toAt)) return false;
      if (restrictByProjects) {
        const pid = taskProjectId(t);
        if (!pid || !wantProjects.includes(String(pid))) return false;
      }
      return true;
    });
  }, [tasks, dr?.fromAt, dr?.toAt, dr?.from, dr?.to, context?.projectId, projectFocusIds]);

  /* ---- Which groups are "active" (assigned to any non-closed scoped task) ---- */
  const activeGroupIdSet = useMemo(() => {
    const set = new Set();
    for (const t of scopedTasks) {
      if (isClosedLike(t.status)) continue; // ignore closed tasks
      for (const gid of taskGroupIds(t)) set.add(gid); // dedupe by Set
    }
    return set;
  }, [scopedTasks]);

  /* ---- Totals across all groups ---- */
  const totals = useMemo(() => {
    const allGroupIds = groups.map(idOf);
    const activeCount = allGroupIds.reduce((n, gid) => n + (activeGroupIdSet.has(gid) ? 1 : 0), 0);
    const idleCount = Math.max(0, allGroupIds.length - activeCount);
    return { active: activeCount, idle: idleCount };
  }, [groups, activeGroupIdSet]);

  /* ---- Focused IDs for broadcast when a bucket is explicitly selected ---- */
  const focusedGroupIds = useMemo(() => {
    if (!picked) return []; // IMPORTANT: only when user actually picks
    const allGroupIds = groups.map(idOf);
    if (picked === "active") return allGroupIds.filter((gid) => activeGroupIdSet.has(gid));
    if (picked === "idle")   return allGroupIds.filter((gid) => !activeGroupIdSet.has(gid));
    return [];
  }, [groups, activeGroupIdSet, picked]);

  /* ---- Broadcast selection — DO NOT broadcast when only RAG is active ---- */
  const prevSigRef = useRef("");
  useEffect(() => {
    // If there is no local pick and we only have a RAG highlight, don't change filters.
    if (!picked && ragHighlight) {
      return; // highlight-only: no emit, no setFilters
    }

    const hasDate = !!(dr?.fromAt || dr?.toAt || dr?.from || dr?.to);
    const hasProjects = !!(context?.projectId) || (projectFocusIds || []).length > 0;

    const ids = picked ? focusedGroupIds : (hasDate || hasProjects ? [] : currentGroups);

    const payload = { groups: { status: picked ? [picked] : [], ids } };
    const sig = JSON.stringify(payload);
    if (sig === prevSigRef.current) return;
    prevSigRef.current = sig;

    try { setFilters?.((prev) => ({ ...prev, groups: payload.groups })); } catch {}
    emit(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, focusedGroupIds, dr?.fromAt, dr?.toAt, dr?.from, dr?.to, context?.projectId, projectFocusIds?.length]);

  /* ---- Interactions ---- */
  function onPick(key) {
    setPicked((prev) => (prev === key ? "" : key));
  }

  /* ---- UI ---- */
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2">
      {!bare && <div className="font-semibold">Groups</div>}

      <style>{`
        .grid2{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.35rem; margin-top:.5rem; }
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

        .halo.green{ box-shadow:0 0 0 4px rgba(16,185,129,.18); }
        .halo.amber{ box-shadow:0 0 0 4px rgba(234,88,12,.18); }
      `}</style>

      {err && <div className="mt-1 text-xs text-red-600">{err}</div>}
      {loading && <div className="mt-1 text-xs text-gray-500">Loading…</div>}

      <div className="grid2">
        {[
          { key: "active", label: "Active", tone: "green", count: totals.active },
          { key: "idle",   label: "Idle",   tone: "amber", count: totals.idle },
        ].map((b) => {
          const isActive = uiKey === b.key;         // UI highlight = pick OR RAG
          const halo = b.count > 0;
          return (
            <Chip
              key={b.key}
              label={b.label}
              count={b.count}
              active={isActive}
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
