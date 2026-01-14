// src/components/GanttPane.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";

/* ───────────────────────────────── optional open-detail bridge ───────────────────────────────── */
function openDetail(kind, id) {
  const payload = { kind, id: String(id) };
  try {
    const lb = require("../widgets/Lightbox");
    if (lb?.open) {
      lb.open(payload);
      return;
    }
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent("dashboard:openDetail", { detail: payload }));
  } catch {}
}
const openProjectDetail = (p) => openDetail("project", String(p?._id || p?.id || ""));
const openTaskDetail = (t) => openDetail("task", String(t?._id || t?.id || ""));
const openMilestoneDetail = (m) => openDetail("milestone", String(m?._id || m?.id || ""));

/* ─────────────────────────── optional FilterContext bridge + window fallback ─────────────────────────── */
function useOptionalFilters() {
  try {
    const ctx = require("../widgets/FilterContext");
    if (ctx && ctx.useFilters) {
      const slice = ctx.useFilters(["project", "rag", "dr", "groups"]);
      return {
        rag: slice.rag || "",
        dr: slice.dr || {},
        projectIds: (slice.project?.ids || []).map(String),
        groups: (slice.groups?.ids || []).map(String),
      };
    }
  } catch {}
  const [rag, setRag] = React.useState("");
  const [dr, setDr] = React.useState({});
  const [projectIds, setProjectIds] = React.useState([]);
  const [groups, setGroups] = React.useState([]);
  useEffect(() => {
    const h = (e) => {
      const d = e?.detail || {};
      if ("rag" in d) setRag(String(d.rag || ""));
      if ("dr" in d) setDr(d.dr || {});
      if (d.project && Array.isArray(d.project.ids)) setProjectIds(d.project.ids.map(String));
      if (d.groups && Array.isArray(d.groups.ids)) setGroups(d.groups.ids.map(String));
    };
    window.addEventListener("dashboard:filtersChanged", h);
    return () => window.removeEventListener("dashboard:filtersChanged", h);
  }, []);
  return { rag, dr, projectIds, groups };
}

/* ────────────────────────────────────────── date helpers ────────────────────────────────────────── */
const DAY = 24 * 60 * 60 * 1000;
const floorLocal = (d) => {
  if (!d) return null;
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const addDays = (d, n) => {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
};
const diffDays = (a, b) => Math.round((floorLocal(b) - floorLocal(a)) / DAY);
const fmt = (d) => (d ? new Date(d).toLocaleDateString() : "—");

// NEW: month helpers (local)
const startOfMonthLocal = (d) => {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
};
const endOfMonthLocal = (d) => {
  const x = new Date(d);
  x.setMonth(x.getMonth() + 1, 0); // last day of month
  x.setHours(0, 0, 0, 0);
  return x;
};

/* ───────────────────────────── status helpers (canon + color mapping) ───────────────────────────── */
const norm = (s) => String(s || "").toLowerCase();
function canonStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (["finished", "complete", "completed", "closed", "done"].includes(s)) return "finished";
  if (["paused - problem", "paused-problem", "problem", "blocked", "block", "issue"].includes(s))
    return "paused - problem";
  if (["paused", "pause", "on hold", "on-hold", "hold"].includes(s)) return "paused";
  if (["started", "start", "in-progress", "in progress", "open", "active", "running"].includes(s)) return "started";
  return "pending";
}
const isClosedLike = (s) => canonStatus(s) === "finished";
const isPausedLike = (s) => canonStatus(s) === "paused";
const isActiveLike = (s) => canonStatus(s) === "started";
const isProblemLike = (s) => canonStatus(s) === "paused - problem";

const STATUS_COLOR = (s) => {
  const cs = canonStatus(s);
  if (cs === "finished") return "#9ca3af"; // gray
  if (cs === "paused - problem") return "#ef4444"; // red
  if (cs === "paused") return "#f59e0b"; // amber
  if (cs === "started") return "#10b981"; // green
  return "#60a5fa"; // blue (pending/other)
};
const OVERDUE = "#ef4444";

/* ─────────────────────────────────────────── filtering ─────────────────────────────────────────── */
const toId = (x) => String(x?._id || x?.id || "");
const dateInRange = (start, end, fromAt, toAt) => {
  if (!fromAt && !toAt) return true;
  const s = start ? new Date(start) : null;
  const e = end ? new Date(end) : null;
  const L = fromAt ? new Date(fromAt) : null;
  const R = toAt ? new Date(toAt) : null;
  const left = s ? +s : -Infinity;
  const right = e ? +e : +s || Date.now();
  const LL = L ? +L : -Infinity;
  const RR = R ? +R : +Infinity;
  return left <= RR && right >= LL;
};

// consider overdue by dates as “red”
function isProjectOverdue(p) {
  const end = p.endDate || p.end || p.endAt || p.due || p.deadlineAt || null;
  const e = floorLocal(end);
  const today = floorLocal(new Date());
  if (!e || !today) return false;
  return !isClosedLike(p.status) && e < today;
}

// rag mapping uses project object so red = overdue OR “problem”,
// amber = paused, green = active AND NOT overdue.
function withinRagProject(p, rag) {
  if (!rag) return true;
  if (rag === "green") return isActiveLike(p.status) && !isProjectOverdue(p);
  if (rag === "amber") return isPausedLike(p.status);
  if (rag === "red") return isProjectOverdue(p) || isProblemLike(p.status);
  return true;
}

/* ───────────────────────────────────────── layout constants ───────────────────────────────────────── */
const CELL_W = 26;
const ROW_H = 24;
const HDR_H = 24;
const SEPARATOR = "#e5e7eb";
const LABEL_W = 240;

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════ */
export default function GanttPane() {
  const { rag, dr, projectIds, groups } = useOptionalFilters();

  const [projects, setProjects] = useState([]);
  const [tasksByProject, setTasksByProject] = useState(new Map());
  const [milesByTask, setMilesByTask] = useState(new Map());
  const [openProjects, setOpenProjects] = useState(new Set());
  const [openTasks, setOpenTasks] = useState(new Set());
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const wrapRef = useRef(null);
  const scrollerRef = useRef(null);

  /* ─────────────────────────────── load projects ─────────────────────────────── */
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setErr("");
      try {
        const { data } = await api.get("/projects", { params: { limit: 2000, _ts: Date.now() }, timeout: 12000 });
        if (!alive) return;
        setProjects(Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : []);
      } catch (e) {
        if (alive) setErr(e?.response?.data?.error || String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* ───────────────────────────── tasks for opened projects ───────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = Array.from(openProjects).filter((pid) => !tasksByProject.has(pid));
      for (const pid of ids) {
        try {
          const { data } = await api.get("/tasks", { params: { projectId: pid, limit: 2000 } });
          const rows = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
          if (cancelled) return;
          setTasksByProject((prev) => new Map(prev).set(pid, rows));
        } catch {
          if (cancelled) return;
          setTasksByProject((prev) => new Map(prev).set(pid, []));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openProjects, tasksByProject]);

  /* ───────────────────────────── milestones for opened tasks (normalized) ───────────────────────────── */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ids = Array.from(openTasks).filter((tid) => !milesByTask.has(tid));
      for (const tid of ids) {
        try {
          let data;
          try {
            const res = await api.get(`/tasks/${tid}/milestones`, { params: { limit: 2000, _ts: Date.now() } });
            data = res.data;
          } catch {
            const res = await api.get(`/milestones`, { params: { taskId: tid, limit: 2000, _ts: Date.now() } });
            data = res.data;
          }

          const normalize = (arr) =>
            (Array.isArray(arr) ? arr : []).map((m, i) => {
              const id = m._id || m.id || `m_${i}`;
              const startAt =
                m.startPlanned || m.startAt || m.startDate || m.scheduledAt || m.beginAt || m.start || null;
              const dueAt =
                m.endPlanned || m.dueAt || m.endAt || m.endDate || m.targetAt || m.targetDate || m.date || null;
              const actualEndAt = m.endActual ?? m.actualEndAt ?? m.completedAt ?? null;
              return {
                _id: id,
                id,
                title: m.title || m.name || m.label || `Milestone ${i + 1}`,
                name: m.title || m.name || m.label || `Milestone ${i + 1}`,
                status: canonStatus(m.status || (m.completed ? "finished" : "pending")),
                isRoadblock: !!(m.isRoadblock ?? m.roadblock ?? m.blocker),
                dependsOn: Array.isArray(m.dependsOn) ? m.dependsOn : Array.isArray(m.requires) ? m.requires : [],
                blockedBy: Array.isArray(m.blockedBy) ? m.blockedBy : [],
                startAt,
                dueAt,
                actualEndAt,
                endPlanned: m.endPlanned || null,
                endAt: m.endAt || null,
                targetDate: m.targetDate || null,
                createdAt: m.createdAt || null,
              };
            });

          const rows = normalize(data);
          if (cancelled) return;
          setMilesByTask((prev) => new Map(prev).set(tid, rows));
        } catch {
          if (cancelled) return;
          setMilesByTask((prev) => new Map(prev).set(tid, []));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openTasks, milesByTask]);

  /* ───────────────────────────── filter projects by rag/date/groups/projectIds ───────────────────────────── */
  const filteredProjects = useMemo(() => {
    const fromAt = dr?.fromAt || dr?.from || "";
    const toAt = dr?.toAt || dr?.to || "";
    const wanted = projectIds || [];
    const restrictIds = wanted.length > 0;
    const wantedGroups = (groups || []).map(String);
    const restrictGroups = wantedGroups.length > 0;

    return projects.filter((p) => {
      if (restrictIds && !wanted.includes(toId(p))) return false;
      if (restrictGroups) {
        const pool = []
          .concat(p.groupId || [])
          .concat(p.groups || [])
          .concat(p.group || [])
          .concat(p.teamGroups || []);
        const pg = new Set(pool.flat().map((x) => String(x?._id || x?.id || x || "")));
        if (![...pg].some((g) => wantedGroups.includes(g))) return false;
      }
      if (!withinRagProject(p, rag)) return false;
      const s = p.startDate || p.start || p.startAt;
      const e = p.endDate || p.end || p.endAt || p.due || p.deadlineAt;
      if (!dateInRange(s, e, fromAt, toAt)) return false;
      return true;
    });
  }, [projects, projectIds, groups, rag, dr?.fromAt, dr?.toAt, dr?.from, dr?.to]);

  /* ───────────────────────────── calendar domain ─────────────────────────────
     CHANGE: if no date range filter is set, default to “present month window”
             (with a small buffer), not min/max of data.
  ─────────────────────────────────────────────────────────────────────────── */
  const cal = useMemo(() => {
    const fromAt = dr?.fromAt || dr?.from || "";
    const toAt = dr?.toAt || dr?.to || "";
    const today = floorLocal(new Date());

    let rangeStart, rangeEnd;
    if (fromAt || toAt) {
      rangeStart = floorLocal(fromAt || new Date(Date.now() - 30 * DAY));
      rangeEnd = floorLocal(toAt || new Date(Date.now() + 60 * DAY));
    } else {
      // DEFAULT: current month (buffer so you can see a bit before/after)
      const monthStart = startOfMonthLocal(today);
      const monthEnd = endOfMonthLocal(today);
      rangeStart = addDays(monthStart, -15);
      rangeEnd = addDays(monthEnd, +15);
    }

    if (+rangeEnd < +rangeStart) rangeEnd = rangeStart;
    const days = diffDays(rangeStart, rangeEnd) + 1;

    const dayObjs = Array.from({ length: days }, (_, i) => {
      const d = addDays(rangeStart, i);
      const dowNum = d.getDay();
      return {
        d,
        dom: d.getDate(),
        dow: d.toLocaleDateString(undefined, { weekday: "short" }),
        isWeekend: dowNum === 0 || dowNum === 6,
      };
    });

    const months = [];
    let i = 0;
    while (i < days) {
      const d = addDays(rangeStart, i);
      const m = d.getMonth(),
        y = d.getFullYear();
      const label = d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
      let span = 0;
      while (i + span < days) {
        const d2 = addDays(rangeStart, i + span);
        if (d2.getMonth() !== m || d2.getFullYear() !== y) break;
        span++;
      }
      months.push({ label, start: i, span });
      i += span;
    }

    const todayIdx = Math.max(0, Math.min(days - 1, diffDays(rangeStart, today)));
    return { rangeStart, rangeEnd, dayObjs, months, todayIdx };
  }, [filteredProjects, tasksByProject, milesByTask, dr?.fromAt, dr?.toAt, dr?.from, dr?.to]);

  /* ───────────────────────────── flatten rows (tree) ───────────────────────────── */
  const rows = useMemo(() => {
    const out = [];
    filteredProjects.forEach((p) => {
      const pid = toId(p);
      out.push({ type: "project", id: pid, label: p.name || pid, item: p });
      if (openProjects.has(pid)) {
        const tasks = tasksByProject.get(pid) || [];
        tasks.forEach((t) => {
          const tid = toId(t);
          out.push({ type: "task", id: tid, label: t.title || tid, parentId: pid, item: t });
          if (openTasks.has(tid)) {
            const ms = milesByTask.get(tid) || [];
            ms.forEach((m) =>
              out.push({
                type: "milestone",
                id: toId(m),
                label: m.title || m.name || toId(m),
                parentId: tid,
                item: m,
              })
            );
          }
        });
      }
    });
    return out;
  }, [filteredProjects, openProjects, openTasks, tasksByProject, milesByTask]);

  const headerRows = 3; // Month, Day, Date
  const HEADER_OFFSET = headerRows * HDR_H;
  const svgHeight = rows.length * ROW_H + 24;

  /* ───────────────────────────── toggles ───────────────────────────── */
  const toggleProject = (pid) =>
    setOpenProjects((prev) => {
      const next = new Set(prev);
      next.has(pid) ? next.delete(pid) : next.add(pid);
      return next;
    });
  const toggleTask = (tid) =>
    setOpenTasks((prev) => {
      const next = new Set(prev);
      next.has(tid) ? next.delete(tid) : next.add(tid);
      return next;
    });

  /* ───────────────────────────── “today” scroll helper ───────────────────────────── */
  const scrollToToday = () => {
    const sc = scrollerRef.current;
    if (!sc) return;
    const colLeft = cal.todayIdx * CELL_W;
    const viewport = sc.clientWidth || 0;
    const centerTarget = Math.max(0, colLeft - Math.max(0, (viewport - CELL_W) / 2));
    const fiveBefore = Math.max(0, (cal.todayIdx - 5) * CELL_W);
    const target = viewport ? centerTarget : fiveBefore;
    sc.scrollTo({ left: target, behavior: "smooth" });
  };

  // NEW: auto-center today on mount / when calendar changes
  useEffect(() => {
    const sc = scrollerRef.current;
    if (!sc) return;
    requestAnimationFrame(() => {
      const colLeft = cal.todayIdx * CELL_W;
      const viewport = sc.clientWidth || 0;
      const centerTarget = Math.max(0, colLeft - Math.max(0, (viewport - CELL_W) / 2));
      sc.scrollLeft = centerTarget;
    });
  }, [cal.todayIdx, cal.dayObjs.length]);

  /* ───────────────────────────── dependency elbows (milestone-to-milestone) ───────────────────────────── */
  const edges = useMemo(() => {
    const idx = new Map();
    rows.forEach((r, i) => {
      if (r.type !== "milestone") return;
      const m = r.item;
      const whenRaw =
        canonStatus(m.status) === "finished" && (m.actualEndAt || m.completedAt || m.endActual)
          ? m.actualEndAt || m.completedAt || m.endActual
          : m.dueAt || m.endAt || m.endPlanned || m.targetDate || m.date || m.startAt || m.startPlanned || m.scheduledAt || m.at || m.createdAt || null;
      const at = whenRaw ? floorLocal(whenRaw) : null;
      if (!at) return;
      const x = Math.max(0, diffDays(cal.rangeStart, at)) * CELL_W;
      idx.set(r.id, { row: i, x });
    });
    const out = [];
    rows.forEach((r) => {
      if (r.type !== "milestone") return;
      const m = r.item;
      const deps = []
        .concat(Array.isArray(m.dependsOn) ? m.dependsOn : [])
        .concat(Array.isArray(m.blockedBy) ? m.blockedBy : [])
        .map(String)
        .filter(Boolean);
      deps.forEach((did) => {
        const A = idx.get(did);
        const B = idx.get(r.id);
        if (A && B) out.push({ from: A, to: B });
      });
    });
    return out;
  }, [rows, cal.rangeStart]);

  /* ══════════════════════════════════════════════════════════════════════════════════════════════════════ */
  return (
    <div ref={wrapRef} className="g-wrap">
      <style>{`
        .g-wrap { width:100%; }
        .g-legend { display:flex; gap:8px; flex-wrap:wrap; font-size:12px; margin-bottom:6px; align-items:center; justify-content:space-between; }
        .g-pill { display:inline-flex; align-items:center; gap:6px; padding:2px 8px; border:1px solid #e5e7eb; border-radius:999px; }
        .g-dot { width:10px; height:10px; border-radius:50%; }
        .g-row { display:grid; grid-template-columns: ${LABEL_W}px 1fr; gap:8px; }
        .g-left { position:relative; }
        .g-tree-line { position:absolute; left:0; right:0; height:${ROW_H}px; display:flex; align-items:center; }
        .g-arrow { width:18px; text-align:center; cursor:pointer; user-select:none; font-size:18px; }
        .g-lab { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
        .g-click { cursor:pointer; }
        .g-click:hover { text-decoration: underline; }
        .g-chart { border:1px solid #e5e7eb; background:#fff; border-radius:8px; overflow:hidden; }
      `}</style>

      {/* legend + today */}
      <div className="g-legend">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className="g-pill">
            <span className="g-dot" style={{ background: "#10b981" }} />
            Active
          </span>
          <span className="g-pill">
            <span className="g-dot" style={{ background: "#f59e0b" }} />
            Paused
          </span>
          <span className="g-pill">
            <span className="g-dot" style={{ background: "#ef4444" }} />
            Overdue / Blocked
          </span>
          <span className="g-pill">
            <span className="g-dot" style={{ background: "#9ca3af" }} />
            Closed
          </span>
        </div>
        <button className="g-pill" onClick={scrollToToday} title="Scroll to today">
          Today
        </button>
      </div>

      <div className="g-row" style={{ height: svgHeight + headerRows * HDR_H }}>
        {/* LEFT: names with expanders */}
        <div className="g-left" aria-label="tree">
          {/* sticky header cells for Month/Day/Date in left column */}
          <div style={{ position: "sticky", top: 0, zIndex: 3 }}>
            <div
              style={{
                boxSizing: "border-box",
                height: HDR_H,
                lineHeight: `${HDR_H}px`,
                padding: "0 8px",
                background: "#838383ff",
                color: "#111827",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              Month
            </div>
            <div
              style={{
                boxSizing: "border-box",
                height: HDR_H,
                lineHeight: `${HDR_H}px`,
                padding: "0 8px",
                background: "#bebebeff",
                color: "#111827",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              Day
            </div>
            <div
              style={{
                boxSizing: "border-box",
                height: HDR_H,
                lineHeight: `${HDR_H}px`,
                padding: "0 8px",
                background: "#e2e2e2ff",
                color: "#111827",
                borderBottom: "1px solid #e5e7eb",
              }}
            >
              Date
            </div>
          </div>

          {rows.map((r, i) => {
            const top = headerRows * HDR_H + i * ROW_H;
            const zebra = i % 2 === 0 ? "transparent" : "#0000000a";
            if (r.type === "project") {
              const pid = r.id;
              const open = openProjects.has(pid);
              return (
                <div key={r.type + pid} className="g-tree-line" style={{ top, background: zebra }}>
                  <div
                    className="g-arrow"
                    title="Click arrow to expand/collapse Gantt"
                    onClick={() => toggleProject(pid)}
                  >
                    {open ? "▾" : "▸"}
                  </div>
                  <div className="g-lab g-click" title="Open project details" onClick={() => openProjectDetail(r.item)}>
                    {r.label}
                  </div>
                </div>
              );
            }
            if (r.type === "task") {
              const tid = r.id;
              const open = openTasks.has(tid);
              return (
                <div key={r.type + tid} className="g-tree-line" style={{ top, paddingLeft: 16, background: zebra }}>
                  <div
                    className="g-arrow"
                    title="Click arrow to expand/collapse Gantt"
                    onClick={() => toggleTask(tid)}
                  >
                    {open ? "▾" : "▸"}
                  </div>
                  <div className="g-lab g-click" title="Open task details" onClick={() => openTaskDetail(r.item)}>
                    {r.label}
                  </div>
                </div>
              );
            }
            return (
              <div key={r.type + r.id} className="g-tree-line" style={{ top, paddingLeft: 32, background: zebra }}>
                <div className="g-lab" title={r.label}>
                  ◆ {r.label}
                </div>
              </div>
            );
          })}
        </div>

        {/* RIGHT: calendar grid + bars */}
        <div className="g-chart" ref={scrollerRef} style={{ overflowX: "auto", position: "relative" }}>
          <div
            style={{
              position: "relative",
              display: "grid",
              gridTemplateColumns: `repeat(${cal.dayObjs.length}, ${CELL_W}px)`,
              gridAutoRows: `${ROW_H}px`,
              minWidth: cal.dayObjs.length * CELL_W,
            }}
          >
            {/* Month row */}
            {cal.months.map((m, idx) => (
              <div
                key={`m${idx}`}
                style={{
                  gridColumn: `${m.start + 1} / ${m.start + 1 + m.span}`,
                  gridRow: "1 / 2",
                  height: HDR_H,
                  lineHeight: `${HDR_H}px`,
                  textAlign: "center",
                  fontSize: 12,
                  background: "#838383ff",
                  borderBottom: "1px solid #e5e7eb",
                  position: "sticky",
                  top: 0,
                  zIndex: 1,
                }}
              >
                {m.label}
              </div>
            ))}
            {/* Day-of-week row */}
            {cal.dayObjs.map((o, i) => (
              <div
                key={`dow${i}`}
                style={{
                  gridColumn: `${i + 1} / ${i + 2}`,
                  gridRow: "2 / 3",
                  height: HDR_H,
                  lineHeight: `${HDR_H}px`,
                  textAlign: "center",
                  fontSize: 12,
                  background: "#bebebeff",
                  borderBottom: "1px solid #e5e7eb",
                  position: "sticky",
                  top: HDR_H * 1,
                  zIndex: 1,
                }}
              >
                {o.dow}
              </div>
            ))}
            {/* Date row */}
            {cal.dayObjs.map((o, i) => (
              <div
                key={`dom${i}`}
                style={{
                  gridColumn: `${i + 1} / ${i + 2}`,
                  gridRow: "3 / 4",
                  height: HDR_H,
                  lineHeight: `${HDR_H}px`,
                  textAlign: "center",
                  fontSize: 12,
                  background: "#e2e2e2ff",
                  borderBottom: "1px solid #e5e7eb",
                  position: "sticky",
                  top: HDR_H * 2,
                  zIndex: 1,
                }}
                title={o.d.toDateString()}
              >
                {o.dom}
              </div>
            ))}

            {/* weekend shading (behind everything) */}
            {cal.dayObjs.map((o, i) =>
              o.isWeekend ? (
                <div
                  key={`wk${i}`}
                  style={{
                    gridColumn: `${i + 1} / ${i + 2}`,
                    gridRow: `${headerRows + 1} / ${headerRows + 1 + rows.length}`,
                    background: "#51515230",
                    zIndex: 0,
                  }}
                />
              ) : null
            )}

            {/* TODAY line */}
            <div
              style={{
                gridColumn: `${cal.todayIdx + 1} / ${cal.todayIdx + 2}`,
                gridRow: `1 / ${headerRows + 1 + rows.length}`,
                justifySelf: "center",
                width: 4,
                background: "#ef444457",
                opacity: 0.9,
                pointerEvents: "none",
                zIndex: 2,
              }}
              title="Today"
            />

            {/* zebra row underlay */}
            {rows.map((_, i) => {
              const row = headerRows + 1 + i;
              const zebra = i % 2 === 0 ? "transparent" : "#0000000a";
              return (
                <div
                  key={`zebra-${i}`}
                  style={{
                    gridColumn: `1 / ${1 + cal.dayObjs.length}`,
                    gridRow: `${row} / ${row + 1}`,
                    background: zebra,
                    zIndex: 0,
                  }}
                />
              );
            })}

            {/* bars + diamonds */}
            {rows.map((r, i) => {
              const row = headerRows + 1 + i;

              if (r.type === "project") {
                const p = r.item;
                const s = floorLocal(p.startDate || p.start || p.startAt);
                const e = floorLocal(p.endDate || p.end || p.endAt || p.due || p.deadlineAt || s);
                if (!s || !e) return null;
                const sIdx = Math.max(0, diffDays(cal.rangeStart, s));
                const eIdx = Math.min(cal.dayObjs.length - 1, diffDays(cal.rangeStart, e));
                const span = Math.max(1, eIdx - sIdx + 1);
                const col = STATUS_COLOR(p.status);
                const barH = Math.max(16, ROW_H - 10);
                const today = floorLocal(new Date());
                const overdue = !isClosedLike(p.status) && e < today;
                const oIdx = overdue ? Math.min(cal.dayObjs.length - 1, diffDays(cal.rangeStart, today)) : null;
                const oSpan = overdue ? Math.max(1, oIdx - eIdx) : 0;

                return (
                  <React.Fragment key={"p" + r.id}>
                    <div
                      title={`${r.label} (${canonStatus(p.status)}) • ${fmt(s)} → ${fmt(e)}`}
                      onClick={() => openProjectDetail(p)}
                      style={{
                        gridColumn: `${sIdx + 1} / span ${span}`,
                        gridRow: `${row} / ${row + 1}`,
                        background: col,
                        height: barH,
                        alignSelf: "center",
                        borderRadius: 4,
                        opacity: 0.85,
                        cursor: "pointer",
                      }}
                    />
                    {overdue && (
                      <div
                        style={{
                          gridColumn: `${eIdx + 1} / span ${oSpan}`,
                          gridRow: `${row} / ${row + 1}`,
                          background: OVERDUE,
                          height: barH,
                          alignSelf: "center",
                          borderRadius: 4,
                          opacity: 0.92,
                        }}
                        title={`Overdue since ${fmt(e)}`}
                      />
                    )}
                  </React.Fragment>
                );
              }

              if (r.type === "task") {
                const t = r.item;
                const s = floorLocal(t.startAt || t.startDate || t.createdAt);
                const e = floorLocal(t.dueAt || t.endAt || t.endDate || t.finishAt || s);
                if (!s || !e) return null;
                const sIdx = Math.max(0, diffDays(cal.rangeStart, s));
                const eIdx = Math.min(cal.dayObjs.length - 1, diffDays(cal.rangeStart, e));
                const span = Math.max(1, eIdx - sIdx + 1);
                const col = STATUS_COLOR(t.status);
                const barH = Math.max(16, ROW_H - 10);
                const today = floorLocal(new Date());
                const overdue = !isClosedLike(t.status) && e < today;
                const oIdx = overdue ? Math.min(cal.dayObjs.length - 1, diffDays(cal.rangeStart, today)) : null;
                const oSpan = overdue ? Math.max(1, oIdx - eIdx) : 0;

                return (
                  <React.Fragment key={"t" + r.id}>
                    <div
                      title={`${r.label} (${canonStatus(t.status)}) • ${fmt(s)} → ${fmt(e)}`}
                      onClick={() => openTaskDetail(t)}
                      style={{
                        gridColumn: `${sIdx + 1} / span ${span}`,
                        gridRow: `${row} / ${row + 1}`,
                        background: col,
                        height: barH,
                        alignSelf: "center",
                        borderRadius: 3,
                        opacity: 0.95,
                        cursor: "pointer",
                      }}
                    />
                    {overdue && (
                      <div
                        style={{
                          gridColumn: `${eIdx + 1} / span ${oSpan}`,
                          gridRow: `${row} / ${row + 1}`,
                          background: OVERDUE,
                          height: barH,
                          alignSelf: "center",
                          borderRadius: 3,
                          opacity: 0.92,
                        }}
                        title={`Overdue since ${fmt(e)}`}
                      />
                    )}
                  </React.Fragment>
                );
              }

              // milestone diamond (clickable)
              const m = r.item;
              const whenRaw =
                canonStatus(m.status) === "finished" && (m.actualEndAt || m.completedAt || m.endActual)
                  ? m.actualEndAt || m.completedAt || m.endActual
                  : m.dueAt ||
                    m.endAt ||
                    m.endPlanned ||
                    m.targetDate ||
                    m.date ||
                    m.startAt ||
                    m.startPlanned ||
                    m.scheduledAt ||
                    m.at ||
                    m.createdAt ||
                    null;
              const at = floorLocal(whenRaw);
              if (!at) return null;

              const xIdx = Math.max(0, Math.min(cal.dayObjs.length - 1, diffDays(cal.rangeStart, at)));
              const col = STATUS_COLOR(m.status);
              const size = 12;

              return (
                <div
                  key={"m" + r.id}
                  title={`${r.label} (${canonStatus(m.status)}) • ${fmt(at)}`}
                  onClick={() => openMilestoneDetail(m)}
                  style={{
                    gridColumn: `${xIdx + 1} / ${xIdx + 2}`,
                    gridRow: `${row} / ${row + 1}`,
                    justifySelf: "center",
                    alignSelf: "center",
                    width: size,
                    height: size,
                    transform: "rotate(45deg)",
                    background: col,
                    border: m.isRoadblock ? "2px dashed #111" : "2px solid #fff",
                    boxShadow: "0 0 0 1px rgba(17,24,39,0.15)",
                    zIndex: 4,
                    cursor: "pointer",
                  }}
                />
              );
            })}

            {/* dependency elbows */}
            <svg
              width={cal.dayObjs.length * CELL_W}
              height={svgHeight}
              style={{ position: "absolute", left: 0, top: headerRows * HDR_H, pointerEvents: "none" }}
            >
              {edges.map((e, idx) => {
                const y1 = e.from.row * ROW_H + ROW_H / 2;
                const y2 = e.to.row * ROW_H + ROW_H / 2;
                const x1 = e.from.x + CELL_W / 2;
                const x2 = e.to.x + CELL_W / 2;
                const mid = (x1 + x2) / 2;
                const path = `M ${x1} ${y1} L ${mid} ${y1} L ${mid} ${y2} L ${x2} ${y2}`;
                return (
                  <g key={"edge" + idx} opacity="0.55">
                    <path d={path} stroke="#374151" strokeWidth="1.5" fill="none" />
                    <polygon points={`${x2},${y2} ${x2 - 5},${y2 - 3} ${x2 - 5},${y2 + 3}`} fill="#374151" />
                  </g>
                );
              })}
            </svg>
          </div>
        </div>
      </div>

      {loading && <div style={{ marginTop: 6, fontSize: 12, color: "#6b7280" }}>Loading…</div>}
      {err && <div style={{ marginTop: 6, fontSize: 12, color: "#b91c1c" }}>{err}</div>}
    </div>
  );
}
