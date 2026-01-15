// src/components/MilestonesBlock.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";

/* ---------------- Date helpers ---------------- */
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
const fmt = (d) => (d ? new Date(d).toLocaleDateString() : "—");

/* ---------------- Normalizer ---------------- */
function normalize(m) {
  if (!m) return m;
  const id = m._id || m.id;
  const name = m.name ?? m.title ?? "";

  const startPlanned = m.startPlanned ?? m.startAt ?? m.startDate ?? null;
  const endPlanned =
    m.endPlanned ?? m.endAt ?? m.dueAt ?? m.dueDate ?? m.targetDate ?? null;

  const status = (m.status ?? (m.completed ? "finished" : "pending")).toLowerCase();
  const actualEndAt =
    m.actualEndAt ?? m.endActual ?? m.completedAt ?? null;

  const roadblock = !!(m.isRoadblock ?? m.roadblock ?? m.blocker);
  const requires =
    Array.isArray(m.requires) ? m.requires :
    Array.isArray(m.dependsOn) ? m.dependsOn :
    Array.isArray(m.dependencies) ? m.dependencies : [];

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
  };
}

/* ---------------- Colors & styles ---------------- */
const STATUS_COLORS = {
  finished: "#05743780",            // planned bar (green)
  "paused - problem": "#800d0d7e",  // red
  paused: "#d977067c",              // amber
  started: "#0451f89b",             // blue
  pending: "#3ba4fa3b",             // light blue/gray
};
const ACTUAL_EARLY_COLOR  = "#03623a";   // darker green overlay for early finish
const ACTUAL_LATE_COLOR   = "#6b21a8b5"; // purple overlay/tail for late finish
const OVERDUE_COLOR       = "#ff0101a1"; // red tail (not finished & past plan)
const WEEKEND_BG          = "#51515245";
const ZEBRA_A             = "transparent";
const ZEBRA_B             = "#0000000a";

const HDR_BG_MONTH  = "#838383ff";
const HDR_BG_DAY    = "#bebebeff";
const HDR_BG_DATE   = "#e2e2e2ff";

const CELL_W = 26;     // px per day column
const ROW_H  = 26;     // px per row
const HDR_H  = 24;     // px per header row
const LABEL_W = 220;   // px left label column

/* ---------------- API helpers ---------------- */
async function fetchMilestones(taskId) {
  try {
    const r = await api.get(`/tasks/${taskId}/milestones`, { params: { _ts: Date.now() } });
    const list =
      Array.isArray(r.data) ? r.data :
      Array.isArray(r.data?.items) ? r.data.items :
      Array.isArray(r.data?.milestones) ? r.data.milestones : [];
    return list.map(normalize);
  } catch (e) {
    if (e?.response?.status !== 404) throw e;
  }
  // fallback collection
  const r2 = await api.get(`/milestones`, { params: { taskId, _ts: Date.now() } }).catch(() => ({ data: [] }));
  const list =
    Array.isArray(r2.data) ? r2.data :
    Array.isArray(r2.data?.items) ? r2.data.items :
    Array.isArray(r2.data?.milestones) ? r2.data.milestones : [];
  return list.map(normalize);
}

async function stampActualEndIfMissing(taskId, m) {
  // Only if status is finished and actual not present
  if (!m || m.status !== "finished" || m.actualEndAt) return;
  try {
    const now = new Date().toISOString();
    const body = {
      status: "finished",
      actualEndAt: now,
      endActual: now,
      completedAt: now,
    };
    try {
      await api.patch(`/tasks/${taskId}/milestones/${m._id}`, body);
    } catch (e) {
      if (e?.response?.status === 405) {
        await api.put(`/tasks/${taskId}/milestones/${m._id}`, body);
      } else {
        throw e;
      }
    }
  } catch {
    /* ignore; non-fatal for drawing */
  }
}

/* ---------------- Component ---------------- */
export default function MilestonesBlock({ taskId, taskStartAt, taskEndAt, taskDueAt, reloadKey }) {
  const [milestones, setMilestones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  const scrollerRef = useRef(null);

  async function reload() {
    setErr(""); setLoading(true);
    try {
      const list = await fetchMilestones(taskId);

      // Auto-stamp missing actual end for finished milestones; then refetch once.
      const needsStamp = list.filter((m) => m.status === "finished" && !m.actualEndAt);
      if (needsStamp.length) {
        await Promise.all(needsStamp.map((m) => stampActualEndIfMissing(taskId, m)));
        const list2 = await fetchMilestones(taskId);
        setMilestones(list2);
      } else {
        setMilestones(list);
      }
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Failed to load deliverables");
      setMilestones([]);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { reload(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [taskId, reloadKey]);

  /* ---------------- Calendar window (locked to task timeframe if given) ---------------- */
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

    const hardStart = floorLocal(taskStartAt);
    const hardEnd   = floorLocal(taskEndAt || taskDueAt);

    let rangeStart = hardStart || minStart;
    let rangeEnd   = hardEnd   || derivedMaxEnd;
    if (+rangeEnd < +rangeStart) rangeEnd = rangeStart;

    // Expand to full ISO weeks
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

  function buildMonths(rangeStart, totalDays) {
    const out = [];
    let i = 0;
    while (i < totalDays) {
      const d = new Date(rangeStart.getTime() + i * DAY);
      const start = i;
      const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      const span = Math.min(diffDays(d, endOfMonth) + 1, totalDays - i);
      const label = d.toLocaleString(undefined, { month: "long", year: "numeric" });
      out.push({ label, start, span });
      i += span;
    }
    return out;
  }

  const gridCols = ` ${LABEL_W}px repeat(${cal.dayObjs.length}, ${CELL_W}px)`;
  const headerRows = 3;

  const scrollToToday = () => {
    if (!scrollerRef.current) return;
    const left = Math.max(0, cal.todayIdx * CELL_W);
    scrollerRef.current.scrollTo({ left, behavior: "smooth" });
  };

  return (
    <div className="border rounded p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-semibold">Deliverables</div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-gray-600">
            Calendar-style Gantt (month/day/date, weekend shading, red “today”, early/late overlays).
          </div>
          <button type="button" className="px-2 py-1 border rounded text-xs" onClick={scrollToToday}>Today</button>
        </div>
      </div>

      {err && <div className="text-red-600 text-sm">{err}</div>}
      {loading && <div className="text-sm text-gray-600">Loading deliverables…</div>}

      {/* ---- Chart ---- */}
      <div
        ref={scrollerRef}
        style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 6 }}
      >
        <div
          style={{
            position: "relative",
            display: "grid",
            gridTemplateColumns: gridCols,
            gridAutoRows: `${ROW_H}px`,
          }}
        >
          {/* Header sticky label column */}
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

          {/* Month row */}
          {cal.months.map((m, idx) => (
            <div key={`mo${idx}`} style={{
              gridColumn: `${m.start + 2} / ${m.start + 2 + m.span}`,
              gridRow: "1 / 2",
              height: HDR_H, lineHeight: `${HDR_H}px`,
              textAlign: "center", fontSize: 12,
              background: HDR_BG_MONTH, borderBottom: "1px solid #e5e7eb"
            }}>{m.label}</div>
          ))}

          {/* Weekday row */}
          {cal.dayObjs.map((o, i) => (
            <div key={`dw${i}`} style={{
              gridColumn: `${i + 2} / ${i + 3}`,
              gridRow: "2 / 3",
              height: HDR_H, lineHeight: `${HDR_H}px`,
              textAlign: "center", fontSize: 12, color: "#111827",
              background: HDR_BG_DAY, borderBottom: "1px solid #e5e7eb",
            }}>{o.dow}</div>
          ))}

          {/* Date row */}
          {cal.dayObjs.map((o, i) => (
            <div key={`d${i}`} style={{
              gridColumn: `${i + 2} / ${i + 3}`,
              gridRow: "3 / 4",
              height: HDR_H, lineHeight: `${HDR_H}px`,
              textAlign: "center", fontSize: 12,
              background: HDR_BG_DATE, borderBottom: "1px solid #e5e7eb",
            }} title={o.d.toDateString()}>{o.dom}</div>
          ))}

          {/* Weekend BG */}
          {cal.dayObjs.map((o, i) => o.isWeekend ? (
            <div key={`wk${i}`} style={{
              gridColumn: `${i + 2} / ${i + 3}`,
              gridRow: `1 / ${headerRows + 1 + milestones.length}`,
              background: WEEKEND_BG,
              zIndex: 0,
            }} />
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

          {/* Rows */}
          {milestones.map((m, i) => {
            const row = headerRows + 1 + i;

            // Label (sticky)
            const labelCell = (
              <div key={`${m._id}-label`} style={{
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
              }} title={m.name}>
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
            const today = floorLocal(new Date());
            const isFinished = m.status === "finished";

            const barCommon = {
              gridRow: `${row} / ${row + 1}`,
              height: Math.max(16, ROW_H - 10),
              alignSelf: "center",
              borderRadius: 4,
              zIndex: 1,
            };

            // Overlays
            const earlyFinish = isFinished && actual && actual < ePlan;
            const lateFinish  = isFinished && actual && actual > ePlan;
            const overdue     = !isFinished && ePlan < today;

            // Index/span helpers
            const actualIdx   = actual ? Math.min(cal.dayObjs.length - 1, diffDays(cal.rangeStart, actual)) : null;
            const earlySpan   = earlyFinish ? Math.max(1, actualIdx - startIdx + 1) : 0;
            const lateSpan    = lateFinish  ? Math.max(1, actualIdx - plannedEndIdx) : 0;
            const overdueIdx  = overdue     ? Math.min(cal.dayObjs.length - 1, diffDays(cal.rangeStart, today)) : null;
            const overdueSpan = overdue     ? Math.max(1, overdueIdx - plannedEndIdx) : 0;

            const color = STATUS_COLORS[m.status] || "#374151";

            return (
              <React.Fragment key={m._id}>
                {labelCell}

                {/* Planned bar */}
                <div
                  style={{
                    ...barCommon,
                    gridColumn: `${startIdx + 2} / span ${spanPlanned}`,
                    background: color,
                    border: m.roadblock ? "3px dashed #860a10ff" : "2px solid transparent",
                    opacity: 0.95,
                  }}
                  title={`${m.name} (${m.status}) • ${fmt(m.startPlanned)} → ${fmt(m.endPlanned)}${lateFinish ? " (late)" : earlyFinish ? " (early)" : ""}`}
                />

                {/* Early actual overlay (dark green) */}
                {earlyFinish && (
                  <div
                    style={{
                      ...barCommon,
                      gridColumn: `${startIdx + 2} / span ${earlySpan}`,
                      background: ACTUAL_EARLY_COLOR,
                      opacity: 0.9,
                    }}
                    title={`Finished early: ${fmt(m.actualEndAt)}`}
                  />
                )}

                {/* Late tail overlay (purple) */}
                {lateFinish && (
                  <div
                    style={{
                      ...barCommon,
                      gridColumn: `${plannedEndIdx + 2} / span ${lateSpan}`,
                      background: ACTUAL_LATE_COLOR,
                      opacity: 0.92,
                    }}
                    title={`Finished late: ${fmt(m.endPlanned)} → ${fmt(m.actualEndAt)}`}
                  />
                )}

                {/* Overdue tail (not finished) */}
                {overdue && (
                  <div
                    style={{
                      ...barCommon,
                      gridColumn: `${plannedEndIdx + 2} / span ${overdueSpan}`,
                      background: OVERDUE_COLOR,
                      opacity: 0.92,
                    }}
                    title={`Overdue since ${fmt(m.endPlanned)}`}
                  />
                )}

                {/* Row rule */}
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
      <div style={{ display:'flex', flexWrap:'wrap', alignItems:'center', columnGap:24, rowGap:10 }}>
        <span><Sw c="#3ba4fa3b" />Pending</span>
        <span><Sw c="#0451f89b" />Started</span>
        <span><Sw c="#d977067c" />Paused</span>
        <span><Sw c="#800d0d7e" />Paused – problem</span>
        <span><Sw c="#05743780" />Finished (planned)</span>
        <span><Sw c={ACTUAL_EARLY_COLOR} />Actual (early)</span>
        <span><Sw c={ACTUAL_LATE_COLOR} />Actual (late)</span>
        <span><Sw c={OVERDUE_COLOR} />Overdue (not finished)</span>
        <span style={{marginLeft:8}}>Weekend shading + red “today” line</span>
      </div>
    </div>
  );
}

/* Small legend swatch */
function Sw({ c }) {
  return <span style={{display:"inline-block", width:12, height:12, background:c, borderRadius:2, marginRight:6}} />;
}
