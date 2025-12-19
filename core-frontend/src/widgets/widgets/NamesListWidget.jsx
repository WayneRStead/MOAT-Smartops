import React, { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { inRangeInclusiveISO } from "../util/dateRange";

export const id = "namesList";
export const title = "People";

/* ---- Filter bridge: ONLY rag, dr, context ---- */
function useOptionalFilters() {
  let ctx = null; try { ctx = require("../FilterContext"); } catch {}
  if (ctx && ctx.useFilters) {
    const slice = ctx.useFilters(["rag","dr","context"]);
    return {
      rag: slice.rag || "",
      dr: slice.dr || {},
      context: slice.context || {},
      setFilters: ctx.setFilters,
      emit: ctx.emit || ((d)=>window.dispatchEvent(new CustomEvent("dashboard:filtersChanged",{detail:d}))),
    };
  }
  // fallback
  const [rag,setRag]=React.useState("");
  const [dr,setDr]=React.useState({});
  const [context,setContext]=React.useState({});
  React.useEffect(()=>{
    const h=(e)=>{
      if(e?.detail?.rag!==undefined) setRag(e.detail.rag||"");
      if(e?.detail?.dr!==undefined) setDr(e.detail.dr||{});
      if(e?.detail?.context!==undefined) setContext(e.detail.context||{});
    };
    window.addEventListener("dashboard:filtersChanged",h);
    return ()=>window.removeEventListener("dashboard:filtersChanged",h);
  },[]);
  return {
    rag, dr, context,
    setFilters:null,
    emit:(d)=>window.dispatchEvent(new CustomEvent("dashboard:filtersChanged",{detail:d})),
  };
}

/* ---- helpers ---- */
function pickName(u){
  return u?.name || u?.fullName ||
    [u?.firstName, u?.lastName].filter(Boolean).join(" ") ||
    u?.email || u?.username || String(u?._id || u?.id || "");
}
function normalizeRole(r){
  if (!r) return "";
  let s = String(r).trim().toLowerCase().replace(/[_\s]+/g,"-");
  if (s === "groupleader") s = "group-leader";
  if (s === "pm") s = "project-manager";
  if (s === "super-admin" || s === "superadministrator") s = "superadmin";
  if (s === "administrator" || s === "owner") s = "admin";
  if (s === "worker") s = "user";
  return s;
}
function rolesOfUser(u){
  const raw = []
    .concat(u?.role ? [u.role] : [])
    .concat(Array.isArray(u?.roles) ? u.roles : [])
    .concat(u?.isAdmin ? ["admin"] : []);
  return Array.from(new Set(raw.flatMap(v=>String(v).split(",")).map(normalizeRole).filter(Boolean)));
}
const idOf = (x) => String(x?._id || x?.id || x || "");
const isClosedLike = (s)=>["done","closed","complete","completed","cancelled","void"].includes(String(s||"").toLowerCase());
const isPausedLike = (s)=>["paused","pause","paused-problem","on-hold","hold"].includes(String(s||"").toLowerCase());
function dueOf(t){ return t.dueAt||t.dueDate||t.endAt||t.endDate||t.deadlineAt||t.due||null; }
function isOverdueTask(t){
  const d = dueOf(t);
  if (!d) return false;
  const x = new Date(d);
  return !isNaN(+x) && x < new Date() && !isClosedLike(t.status);
}

/* Try many shapes to see user links on task/project */
function usersFromTask(t){
  const out = new Set(); const id = (v)=>String(v?._id||v?.id||v||"");
  const add = (v)=>{ const s=id(v); if(s) out.add(s); };
  [t.assigneeId, t.ownerId, t.createdBy, t.requestedBy].forEach(add);
  (Array.isArray(t.assignees)?t.assignees:[]).forEach(add);
  (Array.isArray(t.members)?t.members:[]).forEach(add);
  (Array.isArray(t.people)?t.people:[]).forEach(add);
  return out;
}
function usersFromProject(p){
  const out = new Set(); const id=(v)=>String(v?._id||v?.id||v||"");
  const add = (v)=>{ const s=id(v); if(s) out.add(s); };
  [p.managerId, p.ownerId, p.createdBy].forEach(add);
  (Array.isArray(p.owners)?p.owners:[]).forEach(add);
  (Array.isArray(p.members)?p.members:[]).forEach(add);
  (Array.isArray(p.team)?p.team:[]).forEach(add);
  (Array.isArray(p.people)?p.people:[]).forEach(add);
  return out;
}

export default function NamesListWidget({ bare }) {
  const { rag, dr, context, setFilters, emit } = useOptionalFilters();

  const [users, setUsers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [projects, setProjects] = useState([]);
  const [err, setErr] = useState("");

  // selected single person
  const [selIds, setSelIds] = useState([]);

  // load data (best-effort)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [uR, tR, pR] = await Promise.allSettled([
          api.get("/users",    { params: { limit: 2000, _ts: Date.now() }, timeout: 12000 }),
          api.get("/tasks",    { params: { limit: 2000, _ts: Date.now() }, timeout: 12000 }),
          api.get("/projects", { params: { limit: 2000, _ts: Date.now() }, timeout: 12000 }),
        ]);
        if (!alive) return;
        const toList = (r)=> r.status==="fulfilled" ? (Array.isArray(r.value.data) ? r.value.data : Array.isArray(r.value.data?.rows) ? r.value.data.rows : []) : [];
        setUsers(toList(uR)); setTasks(toList(tR)); setProjects(toList(pR));
        setErr("");
      } catch (e) {
        if (!alive) return;
        setUsers([]); setTasks([]); setProjects([]);
        setErr(e?.response?.data?.error || String(e));
      }
    })();
    return () => { alive = false; };
  }, []);

  // Build indices for overdue/paused involvement (date-range aware)
  const overdueIds = useMemo(() => {
    const out = new Set();
    for (const t of tasks) {
      if (!inRangeInclusiveISO(t.updatedAt || t.endDate || t.createdAt, dr)) continue;
      if (isOverdueTask(t)) usersFromTask(t).forEach(id => out.add(id));
    }
    for (const p of projects) {
      if (!inRangeInclusiveISO(p.updatedAt || p.endDate || p.createdAt, dr)) continue;
      const end = p.end || p.endDate || p.due;
      if (end) {
        const d = new Date(end);
        if (!isNaN(+d) && d < new Date() && !isClosedLike(p.status)) {
          usersFromProject(p).forEach(id => out.add(id));
        }
      }
    }
    return out;
  }, [tasks, projects, dr]);

  const pausedIds = useMemo(() => {
    const out = new Set();
    for (const t of tasks) {
      if (!inRangeInclusiveISO(t.updatedAt || t.createdAt, dr)) continue;
      if (isPausedLike(t.status)) usersFromTask(t).forEach(id=>out.add(id));
    }
    for (const p of projects) {
      if (!inRangeInclusiveISO(p.updatedAt || p.createdAt, dr)) continue;
      if (isPausedLike(p.status)) usersFromProject(p).forEach(id=>out.add(id));
    }
    return out;
  }, [tasks, projects, dr]);

  // Filter by Date Range + Project Context ONLY
  const filtered = useMemo(() => {
    const pid = String(context?.projectId || "");
    // If a project is focused, show people linked to that project (directly or via tasks in that project)
    const inProject = new Set();
    if (pid) {
      projects.forEach(p => {
        if (String(p._id || p.id) === pid) usersFromProject(p).forEach(id => inProject.add(id));
      });
      tasks.forEach(t => {
        const tp = String(t.projectId || t.project?._id || t.project?.id || "");
        if (tp === pid) usersFromTask(t).forEach(id => inProject.add(id));
      });
    }

    return users
      .filter(u => {
        if (!pid) return true; // org-wide
        return inProject.has(idOf(u));
      })
      .sort((a,b)=>pickName(a).localeCompare(pickName(b)));
  }, [users, projects, tasks, context?.projectId]);

  // RAG shading (for info/halo): red = overdue, amber = paused (highlight only)
  function toneFor(u){
    const id = idOf(u);
    if (rag === "red"   || overdueIds.has(id)) return "red";
    if (rag === "amber" || pausedIds.has(id))  return "amber";
    return "";
  }

  // publish selection (single-select; optional cross-widget sync)
  function publish(ids){
    setSelIds(ids);
    const payload = { people: { ids }, names: ids, userIds: ids };
    try { setFilters?.((prev)=>({ ...prev, ...payload })); } catch {}
    emit(payload);
  }
  function onPick(u){
    const id = idOf(u);
    publish(selIds.includes(id) ? [] : [id]);
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-2">
      {!bare && <div className="font-semibold">People</div>}

      <style>{`
        .names-scroll{ max-height: 112px; overflow-y: auto; margin-top:.5rem; } /* ~4 rows */
        .name{
          display:block; padding:4px 8px; border:1px solid transparent; border-radius:8px;
          cursor:pointer; user-select:none;
          transition: box-shadow .15s ease, border-color .15s ease, background .15s ease, color .15s ease;
          font-size: 13px; line-height: 18px;
        }
        .name:hover{ box-shadow:0 0 0 3px rgba(2,132,199,.12); }
        .name.active{ border-color:#2563eb; background:#eff6ff; color:#1e40af; }
        .halo.red{   box-shadow:0 0 0 3px rgba(239,68,68,.18); }
        .halo.amber{ box-shadow:0 0 0 3px rgba(234,88,12,.18); }
      `}</style>

      {err && <div className="text-xs text-red-600">{err}</div>}

      <div className="names-scroll">
        <ul className="flex flex-col gap-1">
          {filtered.map(u => {
            const id   = idOf(u);
            const name = pickName(u);
            const on   = selIds.includes(id);
            const tone = toneFor(u);
            const halo = tone ? `halo ${tone}` : "";
            return (
              <li key={id}>
                <span
                  className={`name ${on ? "active" : ""} ${halo}`}
                  onClick={()=>onPick(u)}
                  onKeyDown={(e)=>{ if(e.key==="Enter"||e.key===" ") onPick(u); }}
                  role="button"
                  tabIndex={0}
                  title={on ? "Selected (click to clear)" : "Select person"}
                >
                  {name}
                </span>
              </li>
            );
          })}
          {!filtered.length && <li className="text-xs text-gray-500">No matches.</li>}
        </ul>
      </div>
    </div>
  );
}
