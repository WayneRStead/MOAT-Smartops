// src/widgets/widgets/ClockingsWidget.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../lib/api";

/** Registry identity — must match backend ALLOWED_WIDGETS */
export const id = "clockings.today";
export const title = "Clockings";

/* ================= Optional FilterContext bridge ================= */
function useOptionalFilters() {
  let ctx = null;
  try { ctx = require("../FilterContext"); } catch {}
  if (ctx && ctx.useFilters) {
    // include context so we can project-scope via context.projectId
    // NEW: pull applyRagFilter to know when RAG should actually filter
    const slice = ctx.useFilters([
      "rag","dr","project","context","task","people","roles","groups","clockings","applyRagFilter"
    ]);
    return {
      rag: slice.rag || "",
      dr: slice.dr || {},
      context: slice.context || {},
      applyRagFilter: !!slice.applyRagFilter,              // <— NEW
      projectIds: (slice.project?.ids || []).map(String),
      taskIds: (slice.task?.ids || []).map(String),
      peopleIds: (slice.people?.ids || []).map(String),
      roleKeys: (slice.roles || []).map((r) => String(r).toLowerCase()),
      groupIds: (slice.groups?.ids || []).map(String),
      setFilters: ctx.setFilters,
      emit: ctx.emit || ((d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: d }))),
    };
  }

  // Fallback (window-only)
  const [rag, setRag] = React.useState("");
  const [dr, setDr] = React.useState({});
  const [context, setContext] = React.useState({});
  const [projectIds, setProjectIds] = React.useState([]);
  const [taskIds, setTaskIds] = React.useState([]);
  const [peopleIds, setPeopleIds] = React.useState([]);
  const [roleKeys, setRoleKeys] = React.useState([]);
  const [groupIds, setGroupIds] = React.useState([]);
  const [applyRagFilter, setApplyRagFilter] = React.useState(false); // <— NEW

  React.useEffect(() => {
    const h = (e) => {
      const d = e?.detail || {};
      if ("rag" in d) setRag(String(d.rag || ""));
      if ("dr" in d) setDr(d.dr || {});
      if ("context" in d) setContext(d.context || {});
      if (d.project?.ids) setProjectIds(d.project.ids.map(String));
      if (d.task?.ids) setTaskIds(d.task.ids.map(String));
      if (d.people?.ids) setPeopleIds(d.people.ids.map(String));
      if (Array.isArray(d.roles)) setRoleKeys(d.roles.map((r) => String(r).toLowerCase()));
      if (d.groups?.ids) setGroupIds(d.groups.ids.map(String));
      if ("applyRagFilter" in d) setApplyRagFilter(!!d.applyRagFilter); // <— NEW
    };
    window.addEventListener("dashboard:filtersChanged", h);
    return () => window.removeEventListener("dashboard:filtersChanged", h);
  }, []);
  return {
    rag, dr, context, applyRagFilter,
    projectIds, taskIds, peopleIds, roleKeys, groupIds,
    setFilters: null,
    emit: (d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: d })),
  };
}

/* ================= Helpers ================= */
const idOf = (v) => String(v?._id || v?.id || v || "");
const dateOrNull = (d) => { if (!d) return null; const x = new Date(d); return isNaN(+x) ? null : x; };

// Inclusive date-range check
function inDateRangeClocking(rec, dr) {
  const fromAt = dr?.fromAt || dr?.from || "";
  const toAt   = dr?.toAt   || dr?.to   || "";
  if (!fromAt && !toAt) return true;

  const raw =
    rec?.date || rec?.day || rec?.on ||
    rec?.createdAt || rec?.updatedAt || rec?.timestamp ||
    rec?.time || rec?.at || null;

  const d = dateOrNull(raw);
  if (!d) return false;
  const from = fromAt ? new Date(fromAt) : null;
  const to   = toAt   ? new Date(toAt)   : null;
  if (from && d < new Date(from.setHours(0,0,0,0))) return false;
  if (to   && d > new Date(to.setHours(23,59,59,999))) return false;
  return true;
}

// Normalize a clocking into one of our four buckets
function normClocking(r) {
  const text = [
    r?.type, r?.status, r?.reason, r?.state, r?.category, r?.label, r?.note
  ].map(s => String(s || "").toLowerCase()).join(" ");

  if (!text.trim()) return null;

  if (/\b(training|course|induction)\b/.test(text)) return "training";
  if (/\biod|injury\s*on\s*duty|injured\b/.test(text)) return "iod";
  if (/\bsick|ill(ness)?|medical\b/.test(text)) return "sick";
  if (/\b(present|checked\s*in|clocked\s*in|\bin\b)\b/.test(text)) return "present";

  return null;
}

// Very tolerant role map for people list lookups
function normalizeRole(r) {
  if (!r) return "";
  let s = String(r).trim().toLowerCase().replace(/[_\s]+/g, "-");
  if (s === "groupleader") s = "group-leader";
  if (s === "pm") s = "project-manager";
  if (s === "super-admin") s = "superadmin";
  if (s === "administrator" || s === "owner") s = "admin";
  if (s === "worker") s = "user";
  return s;
}
function rolesOfUser(u) {
  const raw = []
    .concat(u?.role ? [u.role] : [])
    .concat(Array.isArray(u?.roles) ? u.roles : [])
    .concat(u?.isAdmin ? ["admin"] : []);
  return Array.from(new Set(raw.flatMap(v => String(v).split(",")).map(normalizeRole).filter(Boolean)));
}

/* ================= Reusable chip ================= */
function Chip({ label, count, tone, active, halo, onClick, disabled }) {
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
export default function ClockingsWidget({ bare }) {
  const {
    rag, dr, context, applyRagFilter, projectIds, taskIds, peopleIds, roleKeys, groupIds,
    setFilters, emit
  } = useOptionalFilters();

  const [rows, setRows] = useState([]);
  const [users, setUsers] = useState([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  // local focus (single-select) — disabled while RAG is active (kept as-is)
  const [picked, setPicked] = useState(""); // "present" | "training" | "sick" | "iod" | ""

  /* ---- Load clockings (respect DR when calling API; still guard locally) ---- */
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setErr("");
      try {
        const hasDr = !!(dr?.fromAt || dr?.toAt || dr?.from || dr?.to);
        const params = { limit: 5000, _ts: Date.now() };
        if (hasDr) {
          if (dr.fromAt || dr.from) params.start = (dr.fromAt || dr.from);
          if (dr.toAt || dr.to) params.end = (dr.toAt || dr.to);
        } else {
          // default to "today"
          const t = new Date();
          const iso = t.toISOString().slice(0,10);
          params.start = iso; params.end = iso;
        }

        const r = await api.get("/clockings", { params, timeout: 12000 });
        if (!alive) return;

        const arr = Array.isArray(r.data) ? r.data : Array.isArray(r.data?.rows) ? r.data.rows : [];
        setRows(arr);
      } catch (e) {
        if (!alive) return;
        setErr(e?.response?.data?.error || String(e));
        setRows([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [dr?.fromAt, dr?.toAt, dr?.from, dr?.to]);

  /* ---- Load users (for role filter) ---- */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await api.get("/users", { params: { limit: 2000, _ts: Date.now() } });
        if (!alive) return;
        setUsers(Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : []);
      } catch {
        if (!alive) return;
        setUsers([]);
      }
    })();
    return () => { alive = false; };
  }, []);

  /* ---- Scope rows by DR + (conditionally) Project + Tasks/People/Groups/Roles ---- */
  const scopedRows = useMemo(() => {
    // Only apply project scoping if applyRagFilter is ON (DR or a focused project is active).
    // This prevents RAG alone from changing counts.
    const focusedProjectId = String(context?.projectId || "");
    const shouldProjectFilter = !!applyRagFilter;                     // <— NEW
    const wantProj = shouldProjectFilter
      ? (focusedProjectId ? new Set([focusedProjectId]) : new Set(projectIds.map(String)))
      : new Set();                                                    // ignore projects when false

    const wantTask = new Set(taskIds.map(String));
    const wantPeople = new Set(peopleIds.map(String));
    const wantGroups = new Set(groupIds.map(String));
    const wantRoles = new Set(roleKeys.map(String));

    // Build user → roles map once
    const roleMap = new Map(users.map(u => [idOf(u._id || u.id), rolesOfUser(u)]));

    return rows.filter((r) => {
      if (!inDateRangeClocking(r, dr)) return false;

      // project/task filters (if API includes those fields)
      if (wantProj.size) {
        const pid = String(r.projectId || r.project?.id || r.project?._id || "");
        if (!pid || !wantProj.has(pid)) return false;
      }
      if (wantTask.size) {
        const tid = String(r.taskId || r.task?.id || r.task?._id || "");
        if (!tid || !wantTask.has(tid)) return false;
      }

      // people filter
      const uid = idOf(r.user || r.userId || r.uid);
      if (wantPeople.size && (!uid || !wantPeople.has(uid))) return false;

      // groups filter (if present on record)
      if (wantGroups.size) {
        const gpool = []
          .concat(r.groupId || [])
          .concat(r.groups || [])
          .concat(r.group || []);
        const gids = new Set(gpool.flat().map(idOf).filter(Boolean));
        if (![...gids].some(g => wantGroups.has(g))) return false;
      }

      // roles filter
      if (wantRoles.size) {
        const roles = roleMap.get(uid) || [];
        if (!roles.some((rk) => wantRoles.has(rk))) return false;
      }

      return true;
    });
  }, [
    rows, dr?.fromAt, dr?.toAt, dr?.from, dr?.to,
    context?.projectId, projectIds, taskIds, peopleIds, groupIds, roleKeys,
    users, applyRagFilter // <— NEW
  ]);

  /* ---- Totals per bucket ---- */
  const totals = useMemo(() => {
    const b = { present: 0, training: 0, sick: 0, iod: 0 };
    for (const r of scopedRows) {
      const k = normClocking(r);
      if (k && k in b) b[k] += 1;
    }
    return b;
  }, [scopedRows]);

  /* ---- Master RAG → highlight keys (counts unaffected) ---- */
  // green = present + training; amber = sick; red = iod
  const ragKeys = useMemo(() => {
    if (rag === "green") return new Set(["present", "training"]);
    if (rag === "amber") return new Set(["sick"]);
    if (rag === "red") return new Set(["iod"]);
    return new Set();
  }, [rag]);
  const ragOwned = ragKeys.size > 0;

  /* ---- Local selection ---- */
  function onPick(key) {
    if (ragOwned) return;
    setPicked((prev) => (prev === key ? "" : key));
  }

  // Which keys are "active" (for filled chip) and which have halos (>0)
  const activeKeys = useMemo(() => {
    if (ragOwned) return ragKeys;
    return picked ? new Set([picked]) : new Set();
  }, [ragOwned, ragKeys, picked]);

  const haloKeys = useMemo(() => {
    const h = new Set();
    if (totals.present > 0) h.add("present");
    if (totals.training > 0) h.add("training");
    if (totals.sick > 0) h.add("sick");
    if (totals.iod > 0) h.add("iod");
    return h;
  }, [totals]);

  /* ---- Broadcast selection (unchanged) ---- */
  const userIdsSelected = useMemo(() => {
    const keys = activeKeys.size ? activeKeys : new Set();
    if (!keys.size) return [];
    const out = new Set();
    for (const r of scopedRows) {
      const k = normClocking(r);
      if (k && keys.has(k)) {
        const uid = idOf(r.user || r.userId || r.uid);
        if (uid) out.add(uid);
      }
    }
    return Array.from(out);
  }, [scopedRows, activeKeys]);

  const prevSigRef = useRef("");
  useEffect(() => {
    const payload = {
      clockings: {
        status: Array.from(activeKeys),
        userIds: userIdsSelected,
      },
      people: {
        ids: userIdsSelected,
      },
    };
    const sig = JSON.stringify(payload);
    if (sig === prevSigRef.current) return;
    prevSigRef.current = sig;

    try { setFilters?.((prev) => ({ ...prev, clockings: payload.clockings, people: payload.people })); } catch {}
    emit(payload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userIdsSelected.length, activeKeys.size]);

  /* ---- UI ---- */
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2">
      {!bare && <div className="font-semibold">Clockings</div>}

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
        <Chip
          label="Present"
          count={totals.present}
          tone="green"
          active={activeKeys.has("present")}
          halo={haloKeys.has("present")}
          disabled={ragOwned}
          onClick={() => onPick("present")}
        />
        <Chip
          label="Training"
          count={totals.training}
          tone="green"
          active={activeKeys.has("training")}
          halo={haloKeys.has("training")}
          disabled={ragOwned}
          onClick={() => onPick("training")}
        />
        <Chip
          label="Sick"
          count={totals.sick}
          tone="amber"
          active={activeKeys.has("sick")}
          halo={haloKeys.has("sick")}
          disabled={ragOwned}
          onClick={() => onPick("sick")}
        />
        <Chip
          label="IOD"
          count={totals.iod}
          tone="red"
          active={activeKeys.has("iod")}
          halo={haloKeys.has("iod")}
          disabled={ragOwned}
          onClick={() => onPick("iod")}
        />
      </div>
    </div>
  );
}
