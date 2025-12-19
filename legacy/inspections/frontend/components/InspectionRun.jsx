// src/components/MilestonesBlock.jsx
import React, { useEffect, useMemo, useState, useRef } from "react";
import { api } from "../lib/api";

/* ---------------- Dates ---------------- */
const DAY = 24 * 60 * 60 * 1000;
const toDate = (v) => (v ? new Date(v) : null);
const floorLocal = (d) => {
  if (!d) return null;
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const toLocalDateOnly = (d) => {
  const x = floorLocal(d);
  return x ? x.toISOString().slice(0, 10) : "";
};
const fromLocalDateOnly = (s) => {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
};
const fmt = (d) => (d ? new Date(d).toLocaleDateString() : "—");

function startOfISOWeek(d) {
  const x = floorLocal(d);
  const day = (x.getDay() + 6) % 7; // Mon=0..Sun=6
  return new Date(x.getTime() - day * DAY);
}
function endOfISOWeek(d) {
  const s = startOfISOWeek(d);
  return new Date(s.getTime() + 6 * DAY);
}
function diffDays(a, b) {
  return Math.round((floorLocal(b) - floorLocal(a)) / DAY);
}

/* Build month spans across the grid */
function buildMonths(rangeStart, totalDays) {
  const months = [];
  let i = 0;
  while (i < totalDays) {
    const d = new Date(rangeStart.getTime() + i * DAY);
    const start = i;
    const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const span = Math.min(diffDays(d, endOfMonth) + 1, totalDays - i);
    const label = d.toLocaleString(undefined, { month: "long", year: "numeric" });
    months.push({ label, start, span });
    i += span;
  }
  return months;
}

/* ---------------- Normalizer ---------------- */
function normalize(m) {
  if (!m) return m;
  const id = m._id || m.id;
  const name = m.name ?? m.title ?? "";

  // Prefer planned fields for bars; allow aliases
  const startPlanned = m.startPlanned ?? m.startAt ?? m.startDate ?? null;
  const endPlanned =
    m.endPlanned ?? m.endAt ?? m.dueAt ?? m.dueDate ?? m.targetDate ?? null;

  const status = m.status ?? (m.completed ? "finished" : "pending");
  const actualEndAt = m.endActual ?? m.actualEndAt ?? m.completedAt ?? null;
  const roadblock = !!(m.isRoadblock ?? m.roadblock ?? m.blocker);
  const requires =
    Array.isArray(m.requires) ? m.requires :
    Array.isArray(m.dependsOn) ? m.dependsOn :
    Array.isArray(m.dependencies) ? m.dependencies : [];

  const taskId = m.taskId ?? m.task ?? (m.task && (m.task._id || m.task.id)) ?? null;
  return {
    ...m,
    _id: id,
    name,
    startPlanned,
    endPlanned,
    status,
    actualEndAt,
    roadblock,
    requires,
    taskId,
  };
}
const STATUSES = ["pending", "started", "paused", "paused - problem", "finished"];
const idOf = (x) => (typeof x === "string" ? x : (x?._id || x?.id || ""));

/* ---------------- Tenancy hint (optional) ---------------- */
function getTenantKV() {
  const key =
    (typeof import.meta !== "undefined" && import.meta?.env?.VITE_TENANT_PARAM) || "orgId";
  const headerVal = api?.defaults?.headers?.common?.["X-Org-Id"];
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem("orgId") : null;
  const val = headerVal || stored || null;
  return val ? { [key]: val } : {};
}

/* ---------------- API ---------------- */
async function loadMilestones(taskId) {
  try {
    const r = await api.get(`/tasks/${taskId}/milestones`);
    const list = Array.isArray(r.data)
      ? r.data
      : Array.isArray(r.data?.items) ? r.data.items
      : Array.isArray(r.data?.milestones) ? r.data.milestones
      : [];
    return list.map(normalize);
  } catch (e) {
    if (e?.response?.status !== 404) throw e;
  }
  try {
    const r = await api.get(`/milestones`, { params: { taskId } });
    const list = Array.isArray(r.data)
      ? r.data
      : Array.isArray(r.data?.items) ? r.data.items
      : Array.isArray(r.data?.milestones) ? r.data.milestones
      : [];
    return list.map(normalize);
  } catch {}
  return [];
}

async function createMilestone(taskId, { name, startISO, endISO }) {
  const base = { taskId, ...getTenantKV() };
  const body = { ...base, name: name.trim(), startPlanned: startISO, endPlanned: endISO };
  const alt  = { ...base, title: name.trim(), startPlanned: startISO, endPlanned: endISO };

  try {
    const res = await api.post(`/tasks/${taskId}/milestones`, body);
    return res?.data || null;
  } catch (e1) {
    if (e1?.response?.status === 400) {
      const res2 = await api.post(`/tasks/${taskId}/milestones`, alt);
      return res2?.data || null;
    }
    throw e1;
  }
}

async function patchMilestone(taskId, milestoneId, patch) {
  const out = { ...getTenantKV() };
  if ("name" in patch) out.name = patch.name;
  if ("startAt" in patch) {
    out.startPlanned = patch.startAt;
    out.startAt = patch.startAt;
    out.startDate = patch.startAt;
  }
  if ("endAt" in patch) {
    out.endPlanned = patch.endAt;
    out.endAt = patch.endAt;
    out.dueAt = patch.endAt;
    out.dueDate = patch.endAt;
    out.targetDate = patch.endAt;
  }
  if ("status" in patch) out.status = patch.status;
  if ("roadblock" in patch) out.isRoadblock = !!patch.roadblock;
  if ("requires" in patch) {
    const reqs = (patch.requires || []).map(String);
    out.requires = reqs; out.dependsOn = reqs; out.dependencies = reqs;
  }
  if ("actualEndAt" in patch) out.endActual = patch.actualEndAt;

  try {
    const r = await api.patch(`/tasks/${taskId}/milestones/${milestoneId}`, out);
    return r?.data || null;
  } catch (e) {
    if (e?.response?.status === 405) {
      const r2 = await api.put(`/tasks/${taskId}/milestones/${milestoneId}`, out);
      return r2?.data || null;
    }
    throw e;
  }
}

async function deleteMilestone(taskId, milestoneId) {
  await api.delete(`/tasks/${taskId}/milestones/${milestoneId}`).catch(async (e) => {
    if (e?.response?.status === 405) {
      await api.delete(`/milestones/${milestoneId}`);
    } else throw e;
  });
}

/* ---------------- Colors & styles (matched to ProjectTasksTimeline) ---------------- */
const STATUS_COLORS = {
  finished: "#05743780",            // green
  "paused - problem": "#800d0d7e",  // red
  paused: "#d977067c",              // amber
  started: "#0451f89b",             // blue
  pending: "#3ba4fa3b",             // near-black
};
const OVERRUN_COLOR = "#ff0101a1";     // red tail (actual > planned)
const OVERDUE_COLOR = "#ff0101a1";     // red tail (planned < today & not finished)
const WEEKEND_BG    = "#51515245";     // same weekend tint
const ZEBRA_A       = "transparent";
const ZEBRA_B       = "#0000000a";

const HDR_BG_MONTH  = "#838383ff";
const HDR_BG_DAY    = "#bebebeff";
const HDR_BG_DATE   = "#e2e2e2ff";

const CELL_W = 26;     // px per day column
const ROW_H  = 26;     // px per row
const HDR_H  = 24;     // px per header row
const LABEL_W = 220;   // px left label column

/* ---------------- Component ---------------- */
export default function MilestonesBlock({ taskId, taskStartAt, taskEndAt, taskDueAt }) {
  const [milestones, setMilestones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [savingId, setSavingId] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // New milestone form
  const [name, setName] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [status, setStatus] = useState("pending");
  const [roadblock, setRoadblock] = useState(false);
  const [requires, setRequires] = useState([]);

  const maxEndDate = toLocalDateOnly(taskDueAt);
  const scrollerRef = useRef(null);

  const showErr = (e) => {
    const msg =
      e?.response?.data?.error ||
      e?.response?.data?.message ||
      (typeof e?.response?.data === "string" ? e.response.data : "") ||
      e?.message || "Request failed";
    setErr(msg);
  };

  async function reload() {
    setErr(""); setLoading(true);
    try { setMilestones(await loadMilestones(taskId)); }
    catch (e) { showErr(e); }
    finally { setLoading(false); }
  }
  useEffect(() => { reload(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [taskId]);

  const roadblocks = useMemo(() => milestones.filter(m => !!m.roadblock), [milestones]);

  function validateDates(s, e) {
    if (!s) return "Start date is required.";
    if (!e) return "End date is required.";
    const sISO = fromLocalDateOnly(s);
    const eISO = fromLocalDateOnly(e);
    if (sISO && eISO && new Date(sISO) > new Date(eISO)) return "Start date cannot be after end date.";
    if (eISO && taskDueAt && new Date(eISO) > new Date(taskDueAt)) return "End date cannot be after the task's due date.";
    return "";
  }

  async function addMilestone(ev) {
    ev?.preventDefault?.();
    if (submitting) return;
    setErr("");

    const val = validateDates(startAt, endAt);
    if (val) return setErr(val);
    if (!name.trim()) return setErr("Name is required.");

    // Requires must be roadblocks
    const reqSet = new Set(requires);
    const nonRoad = Array.from(reqSet).filter(id => !roadblocks.find(r => String(r._id) === String(id)));
    if (nonRoad.length) return setErr("Only milestones marked as roadblocks can be selected in 'Requires'.");

    const sISO = fromLocalDateOnly(startAt);
    const eISO = fromLocalDateOnly(endAt);

    setSubmitting(true);
    try {
      const created = await createMilestone(taskId, { name, startISO: sISO, endISO: eISO });

      // Find id if not returned
      let mid = idOf(created);
      if (!mid) {
        const ls = await loadMilestones(taskId);
        const found = ls.find(m =>
          (m.name || "").trim() === name.trim() &&
          toLocalDateOnly(m.startPlanned) === startAt &&
          toLocalDateOnly(m.endPlanned) === endAt
        );
        mid = idOf(found);
      }

      // Optional patch
      const patch = { status, roadblock, requires: Array.from(reqSet) };
      if (mid) await patchMilestone(taskId, mid, patch).catch(()=>{});

      // Reset & reload
      setName(""); setStartAt(""); setEndAt("");
      setStatus("pending"); setRoadblock(false); setRequires([]);
      await reload();
    } catch (e) {
      showErr(e);
    } finally {
      setSubmitting(false);
    }
  }

  async function saveRow(m, patch) {
    if (savingId) return;
    setErr(""); setSavingId(String(m._id));

    const next = { ...patch };
    if (patch.status === "finished" && !m.actualEndAt) {
      next.actualEndAt = new Date().toISOString();
    }

    // Validate dates if changed
    const newStart = "startAt" in next ? next.startAt : m.startPlanned;
    const newEnd   = "endAt"   in next ? next.endAt   : m.endPlanned;
    const s = toLocalDateOnly(newStart);
    const e = toLocalDateOnly(newEnd);
    const val = validateDates(s, e);
    if (val) { setSavingId(null); return setErr(val); }

    // Requires only roadblocks (and no self)
    const reqIds = (next.requires ?? m.requires ?? []).map(String);
    const reqNotRoad = reqIds.filter(id => !roadblocks.find(r => String(r._id) === id) && String(m._id) !== id);
    if (reqNotRoad.length) { setSavingId(null); return setErr("Requires can only include milestones marked as roadblocks."); }

    try {
      const updatedRaw = await patchMilestone(taskId, m._id, next);
      const updated = normalize(updatedRaw || { ...m, ...next });
      setMilestones(ms => ms.map(x => (String(x._id) === String(m._id) ? updated : x)));
    } catch (e) {
      showErr(e);
    } finally {
      setSavingId(null);
    }
  }

  async function deleteRow(m) {
    if (!window.confirm(`Delete milestone "${m.name}"?`)) return;
    setErr("");
    try {
      await deleteMilestone(taskId, m._id);
      setMilestones(ms => ms.filter(x => String(x._id) !== String(m._id)));
    } catch (e) {
      showErr(e);
    }
  }

  /* ---------------- Calendar window (LOCKED to task timeframe if provided) ---------------- */
  const cal = useMemo(() => {
    const today = floorLocal(new Date());

    const starts = milestones.map((m) => toDate(m.startPlanned)).filter(Boolean);
    const endsPlanned = milestones.map((m) => toDate(m.endPlanned)).filter(Boolean);
    const endsActual  = milestones.map((m) => toDate(m.actualEndAt)).filter(Boolean);

    const minStart = starts.length ? new Date(Math.min(...starts.map((d)=>+d))) : (floorLocal(taskStartAt) || today);

    const maxEndCand = [
      ...endsPlanned.map((d)=>+d),
      ...endsActual.map((d)=>+d),
      taskDueAt ? +floorLocal(new Date(taskDueAt)) : -Infinity,
      +today,
    ].filter((n)=>Number.isFinite(n));
    const derivedMaxEnd = maxEndCand.length ? new Date(Math.max(...maxEndCand)) : today;

    // Hard project range from props (if present)
    const hardStart = floorLocal(taskStartAt);
    const hardEnd   = floorLocal(taskEndAt || taskDueAt);

    let rangeStart = hardStart || minStart;
    let rangeEnd   = hardEnd   || derivedMaxEnd;

    if (+rangeEnd < +rangeStart) rangeEnd = rangeStart;

    // Expand to full ISO weeks (nice grid)
    rangeStart = startOfISOWeek(rangeStart);
    rangeEnd   = endOfISOWeek(rangeEnd);

    const days = diffDays(rangeStart, rangeEnd) + 1;
    const dayObjs = Array.from({ length: days }, (_, i) => {
      const d = new Date(rangeStart.getTime() + i * DAY);
      return {
        d,
        iso: d.toISOString().slice(0,10),
        dow: d.toLocaleDateString(undefined,{ weekday:"short" }),
        dom: d.getDate(),
        isWeekend: (d.getDay() === 0 || d.getDay() === 6),
      };
    });

    const months = buildMonths(rangeStart, days);
    const todayIdx = Math.max(0, Math.min(days - 1, diffDays(rangeStart, today)));

    return { rangeStart, rangeEnd, dayObjs, months, todayIdx };
  }, [milestones, taskStartAt, taskEndAt, taskDueAt]);

  /* ---------------- Render ---------------- */
  const gridCols = ` ${LABEL_W}px repeat(${cal.dayObjs.length}, ${CELL_W}px)`;
  const headerRows = 3; // Month / Day / Date

  const scrollToToday = () => {
    if (!scrollerRef.current) return;
    const left = Math.max(0, cal.todayIdx * CELL_W);
    scrollerRef.current.scrollTo({ left, behavior: "smooth" });
  };

  return (
    <div className="border rounded p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold">Milestones</div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-gray-600">
            Calendar-style Gantt (month / day / date, weekend shading, today line, overrun/overdue).
          </div>
          <button
            type="button"
            className="px-2 py-1 border rounded text-xs"
            onClick={scrollToToday}
            title="Scroll to today"
          >
            Today
          </button>
        </div>
      </div>

      {err && <div className="text-red-600 text-sm">{err}</div>}

      {/* Add new */}
      <form className="grid md:grid-cols-3 gap-3 items-end" onSubmit={addMilestone}>
        <label className="text-sm md:col-span-3">
          Name
          <input className="border p-2 w-full" value={name} onChange={(e)=>setName(e.target.value)} placeholder="Milestone name" />
        </label>

        <label className="text-sm">
          Start date
          <input className="border p-2 w-full" type="date" value={startAt} onChange={(e)=>setStartAt(e.target.value)} />
        </label>
        <label className="text-sm">
          End date
          <input
            className="border p-2 w-full"
            type="date"
            value={endAt}
            max={maxEndDate || undefined}
            onChange={(e)=>setEndAt(e.target.value)}
            title={maxEndDate ? `Must be on or before ${new Date(taskDueAt).toLocaleDateString()}` : ""}
          />
        </label>
        <label className="text-sm">
          Status
          <select className="border p-2 w-full" value={status} onChange={(e)=>setStatus(e.target.value)}>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <div className="md:col-span-3 flex flex-wrap items-center gap-4">
          <label className="text-sm flex items-center gap-2">
            <input type="checkbox" checked={roadblock} onChange={(e)=>setRoadblock(e.target.checked)} />
            Roadblock
          </label>

          <label className="text-sm flex-1 min-w-[220px]">
            Requires (roadblocks)
            <select
              className="border p-2 w-full"
              multiple
              value={requires}
              onChange={(e) => setRequires(Array.from(e.target.selectedOptions).map(o=>o.value))}
            >
              {roadblocks.map(m => (
                <option key={m._id} value={m._id}>{m.name}</option>
              ))}
            </select>
          </label>

          <button className="px-3 py-2 border rounded disabled:opacity-50" type="submit" disabled={submitting}>
            {submitting ? "Adding…" : "Add milestone"}
          </button>
        </div>
      </form>

      {/* -------- Calendar Gantt (grid) -------- */}
      <div
        ref={scrollerRef}
        style={{
          overflowX: "auto",
          border: "1px solid #e5e7eb",
          borderRadius: 6,
        }}
      >
        {/* Grid wrapper */}
        <div
          style={{
            position: "relative",
            display: "grid",
            gridTemplateColumns: gridCols,
            gridAutoRows: `${ROW_H}px`,
          }}
        >
          {/* ----- Header labels column (sticky left) ----- */}
          <div style={{
            gridColumn: "1 / 2", gridRow: "1 / 2",
            height: HDR_H, lineHeight: `${HDR_H}px`,
            padding: "0 8px", fontSize: 12, color: "#374151",
            background: HDR_BG_MONTH, borderBottom: "1px solid #e5e7eb",
            position: "sticky", left: 0, zIndex: 4
          }}>Month</div>
          <div style={{
            gridColumn: "1 / 2", gridRow: "2 / 3",
            height: HDR_H, lineHeight: `${HDR_H}px`,
            padding: "0 8px", fontSize: 12, color: "#374151",
            background: HDR_BG_DAY, borderBottom: "1px solid #e5e7eb",
            position: "sticky", left: 0, zIndex: 4
          }}>Day</div>
          <div style={{
            gridColumn: "1 / 2", gridRow: "3 / 4",
            height: HDR_H, lineHeight: `${HDR_H}px`,
            padding: "0 8px", fontSize: 12, color: "#374151",
            background: HDR_BG_DATE, borderBottom: "1px solid #e5e7eb",
            position: "sticky", left: 0, zIndex: 4
          }}>Date</div>

          {/* Month spans (top row) */}
          {cal.months.map((m, idx) => (
            <div
              key={`mo${idx}`}
              style={{
                gridColumn: `${m.start + 2} / ${m.start + 2 + m.span}`,
                gridRow: "1 / 2",
                height: HDR_H, lineHeight: `${HDR_H}px`,
                textAlign: "center", fontSize: 12,
                background: HDR_BG_MONTH, borderBottom: "1px solid #e5e7eb"
              }}
            >
              {m.label}
            </div>
          ))}

          {/* Weekday names (middle row) */}
          {cal.dayObjs.map((o, i) => (
            <div
              key={`dw${i}`}
              style={{
                gridColumn: `${i + 2} / ${i + 3}`,
                gridRow: "2 / 3",
                height: HDR_H, lineHeight: `${HDR_H}px`,
                textAlign: "center", fontSize: 12, color: "#111827",
                background: HDR_BG_DAY, borderBottom: "1px solid #e5e7eb",
              }}
            >
              {o.dow}
            </div>
          ))}

          {/* Date numbers (bottom header row) */}
          {cal.dayObjs.map((o, i) => (
            <div
              key={`d${i}`}
              style={{
                gridColumn: `${i + 2} / ${i + 3}`,
                gridRow: "3 / 4",
                height: HDR_H, lineHeight: `${HDR_H}px`,
                textAlign: "center", fontSize: 12,
                background: HDR_BG_DATE, borderBottom: "1px solid #e5e7eb",
              }}
              title={o.d.toDateString()}
            >
              {o.dom}
            </div>
          ))}

          {/* Zebra underlay for rows */}
          {milestones.map((_, i) => {
            const row = headerRows + 1 + i;
            const zebra = i % 2 === 0 ? ZEBRA_A : ZEBRA_B;
            return (
              <div
                key={`zebra-${i}`}
                style={{
                  gridColumn: `2 / ${2 + cal.dayObjs.length}`,
                  gridRow: `${row} / ${row + 1}`,
                  background: zebra,
                  zIndex: 0,
                }}
              />
            );
          })}

          {/* Weekend background (Sa/Su) UNDER everything else */}
          {cal.dayObjs.map((o, i) => o.isWeekend ? (
            <div
              key={`wkbg${i}`}
              style={{
                gridColumn: `${i + 2} / ${i + 3}`,
                gridRow: `1 / ${headerRows + 1 + milestones.length}`,
                background: WEEKEND_BG,
                zIndex: 0,
              }}
            />
          ) : null)}

          {/* TODAY line */}
          <div
            style={{
              gridColumn: `${cal.todayIdx + 2} / ${cal.todayIdx + 3}`,
              gridRow: `1 / ${headerRows + 1 + milestones.length}`,
              justifySelf: "center",
              width: 4, background: "#ef444479",
              opacity: 0.9, pointerEvents: "none", zIndex: 3
            }}
            title="Today"
          />

          {/* ----- Milestone rows ----- */}
          {milestones.map((m, i) => {
            const row = headerRows + 1 + i;

            // label cell (sticky left)
            const labelCell = (
              <div
                key={`${m._id}-label`}
                style={{
                  gridColumn: "1 / 2",
                  gridRow: `${row} / ${row + 1}`,
                  lineHeight: `${ROW_H}px`,
                  height: ROW_H,
                  padding: "0 8px",
                  fontSize: 12,
                  borderTop: "1px solid #e5e7eb",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  background: "white",
                  position: "sticky",
                  left: 0,
                  zIndex: 2,
                }}
                title={m.name}
              >
                {m.name}
              </div>
            );

            const s = floorLocal(m.startPlanned);
            const ePlan = floorLocal(m.endPlanned);
            if (!s || !ePlan) return labelCell;

            const startIdx = Math.max(0, diffDays(cal.rangeStart, s));
            const plannedEndIdx = Math.min(cal.dayObjs.length - 1, diffDays(cal.rangeStart, ePlan));
            const spanPlanned = Math.max(1, plannedEndIdx - startIdx + 1);

            const actual = floorLocal(m.actualEndAt);
            const hasOverrun = actual && actual > ePlan;
            const actualEndIdx = hasOverrun ? Math.min(cal.dayObjs.length - 1, diffDays(cal.rangeStart, actual)) : null;
            const spanOverrun = hasOverrun ? Math.max(1, actualEndIdx - plannedEndIdx) : 0;

            // Overdue tail (planned < today, not finished, and no actual beyond plan)
            const today = floorLocal(new Date());
            const isDone = m.status === "finished";
            const overdue = !isDone && ePlan < today && (!actual || actual <= ePlan);
            const overdueEndIdx = overdue ? Math.min(cal.dayObjs.length - 1, diffDays(cal.rangeStart, today)) : null;
            const spanOverdue = overdue ? Math.max(1, overdueEndIdx - plannedEndIdx) : 0;

            const color = STATUS_COLORS[m.status] || "#374151";
            const barCommon = {
              gridRow: `${row} / ${row + 1}`,
              height: Math.max(16, ROW_H - 10),
              alignSelf: "center",
              borderRadius: 4,
              zIndex: 1,
            };

            return (
              <React.Fragment key={m._id}>
                {labelCell}

                {/* planned segment */}
                <div
                  style={{
                    ...barCommon,
                    gridColumn: `${startIdx + 2} / span ${spanPlanned}`,
                    background: color,
                    border: m.roadblock ? "3px dashed #860a10ff" : "2px solid transparent",
                    opacity: 0.95,
                  }}
                  title={`${m.name} (${m.status}) • ${fmt(m.startPlanned)} → ${fmt(m.endPlanned)}${hasOverrun ? " (overrun)" : overdue ? " (overdue)" : ""}`}
                />

                {/* overrun segment (actual > planned) */}
                {hasOverrun && (
                  <div
                    style={{
                      ...barCommon,
                      gridColumn: `${plannedEndIdx + 2} / span ${spanOverrun}`,
                      background: OVERRUN_COLOR,
                      opacity: 0.92,
                    }}
                    title={`Overrun: ${fmt(m.endPlanned)} → ${fmt(m.actualEndAt)}`}
                  />
                )}

                {/* overdue tail (planned < today, not finished) */}
                {overdue && (
                  <div
                    style={{
                      ...barCommon,
                      gridColumn: `${plannedEndIdx + 2} / span ${spanOverdue}`,
                      background: OVERDUE_COLOR,
                      opacity: 0.92,
                    }}
                    title={`Overdue since ${fmt(m.endPlanned)}`}
                  />
                )}

                {/* row rule */}
                <div
                  style={{
                    gridColumn: `2 / ${2 + cal.dayObjs.length}`,
                    gridRow: `${row} / ${row + 1}`,
                    borderTop: "1px solid #e5e7eb",
                    zIndex: 0,
                  }}
                />
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', columnGap: 32, rowGap: 12 }}>
        <span><span style={{display:"inline-block", width:12, height:12, background:"#3ba4fa3b", borderRadius:2, marginRight:6}} />Pending</span>
        <span><span style={{display:"inline-block", width:12, height:12, background:"#0451f89b", borderRadius:2, marginRight:6}} />Started</span>
        <span><span style={{display:"inline-block", width:12, height:12, background:"#d977067c", borderRadius:2, marginRight:6}} />Paused</span>
        <span><span style={{display:"inline-block", width:12, height:12, background:"#800d0d7e", borderRadius:2, marginRight:6}} />Paused – problem</span>
        <span><span style={{display:"inline-block", width:12, height:12, background:"#05743780", borderRadius:2, marginRight:6}} />Finished</span>
        <span><span style={{display:"inline-block", width:12, height:12, background:OVERDUE_COLOR, borderRadius:2, marginRight:6}} />Overrun/Overdue</span>
        <span><span style={{display:"inline-block", width:12, height:12, border:"3px dashed #860a10ff", borderRadius:2, marginRight:6}} />Roadblock</span>
        <span style={{marginLeft:8}}>Weekend shading + red “today” line</span>
      </div>

      {/* Editable list (kept as-is) */}
      {/* ... (unchanged table editor from your file) ... */}

      {loading && <div className="text-sm text-gray-600">Loading milestones…</div>}
      {savingId && <div className="text-sm text-gray-600">Saving…</div>}
    </div>
  );
}
