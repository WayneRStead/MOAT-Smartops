// src/components/ProjectTasksTimeline.jsx
import React, { useMemo, useRef } from "react";

/* ---------------- Dates ---------------- */
const DAY = 24 * 60 * 60 * 1000;
const floorLocal = (d) => { if (!d) return null; const x = new Date(d); x.setHours(0,0,0,0); return x; };
const fmt = (d) => (d ? new Date(d).toLocaleDateString() : "—");
const diffDays = (a, b) => Math.round((floorLocal(b) - floorLocal(a)) / DAY);
const addDays = (d, n) => { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; };

/* ---------------- Log helpers (fallbacks) ---------------- */
function firstLogAt(log = [], actions = ["start", "resume", "photo", "complete"]) {
  const rows = (log || []).filter(r => actions.includes(String(r.action || "").toLowerCase()));
  if (!rows.length) return null;
  const at = rows
    .map(r => new Date(r.at))
    .filter(d => !isNaN(+d))
    .sort((a,b) => +a - +b)[0];
  return at || null;
}
function lastLogAt(log = [], actions = ["complete"]) {
  const rows = (log || []).filter(r => actions.includes(String(r.action || "").toLowerCase()));
  if (!rows.length) return null;
  const at = rows
    .map(r => new Date(r.at))
    .filter(d => !isNaN(+d))
    .sort((a,b) => +b - +a)[0];
  return at || null;
}

/* ---------------- Normalizer ---------------- */
function normTask(t, fallbackStart) {
  const id = String(t._id || t.id || "");
  const name = t.title || t.name || "Task";

  // Respect explicit task start fields first
  const explicitStart =
    t.startAt || t.startDate || t.scheduledAt || t.scheduledStart || null;

  // Fallback to earliest relevant log if no explicit start
  const logStart = firstLogAt(t.actualDurationLog);

  // If still nothing, use project start so it renders
  const start = floorLocal(explicitStart || logStart || fallbackStart || null);

  // End date logic: prefer explicit end/due; otherwise last completion log; otherwise start
  const explicitEnd =
    t.endAt || t.endDate || t.dueAt || t.dueDate || t.targetDate || null;

  const logEnd = lastLogAt(t.actualDurationLog, ["complete"]);
  const end = floorLocal(explicitEnd || logEnd || start || null);

  // Map status → palette bucket
  const s = String(t.status || "").toLowerCase();
  let status = "pending";
  if (["started","in progress","in-progress","open","active"].includes(s)) status = "started";
  if (["paused"].includes(s)) status = "paused";
  if (["paused - problem","blocked","problem"].includes(s)) status = "paused - problem";
  if (["finished","complete","completed","done","closed"].includes(s)) status = "finished";

  // Guard: if end < start, pin to 1 day bar at start
  const safeEnd = (start && end && +end < +start) ? start : end;

  return { id, name, start, end: safeEnd || start, raw: t, status };
}

/* ---------------- Colors & layout ---------------- */
const STATUS_COLORS = {
  finished: "#05743780",            // green
  "paused - problem": "#800d0d7e",  // red
  paused: "#d977067c",              // amber
  started: "#0451f89b",             // blue
  pending: "#3ba4fa3b",             // grey/blue
};

const OVERDUE_COLOR = "#ff0101a1";  // red tail after due date
const WEEKEND_BG    = "#51515245";  // weekend tint
const ZEBRA_A       = "transparent";
const ZEBRA_B       = "#0000000a";

const HDR_BG_MONTH  = "#838383ff";
const HDR_BG_DAY    = "#bebebeff";
const HDR_BG_DATE   = "#e2e2e2ff";

const CELL_W  = 26;    // px per day column
const ROW_H   = 26;    // px per task row
const HDR_H   = 24;    // px per header row
const LABEL_W = 220;   // px label column

export default function ProjectTasksTimeline({
  tasks = [],
  projectStart = null,
  projectEnd   = null,
  title = "Tasks timeline",
}) {
  const projStartF = floorLocal(projectStart);
  const projEndF   = floorLocal(projectEnd);

  // Normalize tasks with start/end
  const data = useMemo(
    () => tasks.map(t => normTask(t, projStartF)),
    [tasks, projStartF]
  );

  /* ---------------- Calendar window (LOCKED to project range if provided) ---------------- */
  const cal = useMemo(() => {
    const today = floorLocal(new Date());

    const hardStart = projStartF;
    const hardEnd   = projEndF;

    let rangeStart, rangeEnd;
    if (hardStart && hardEnd) {
      rangeStart = hardStart;
      rangeEnd   = hardEnd;
    } else {
      const starts = data.map(d => d.start).filter(Boolean);
      const ends   = data.map(d => d.end).filter(Boolean);
      const minStart = starts.length ? new Date(Math.min(...starts.map(d=>+d))) : today;
      const maxEnd   = ends.length   ? new Date(Math.max(...ends.map(d=>+d), +today)) : today;
      rangeStart = hardStart || minStart;
      rangeEnd   = hardEnd   || maxEnd;
    }

    if (+rangeEnd < +rangeStart) rangeEnd = rangeStart;

    const days = diffDays(rangeStart, rangeEnd) + 1;

    const dayObjs = Array.from({ length: days }, (_, i) => {
      const d = addDays(rangeStart, i);
      const dowNum = d.getDay();
      return {
        d,
        iso: d.toISOString().slice(0,10),
        dom: d.getDate(),
        dow: d.toLocaleDateString(undefined, { weekday: "short" }),
        isWeekend: (dowNum === 0 || dowNum === 6),
      };
    });

    // Month spans for top header
    const months = [];
    let i = 0;
    while (i < days) {
      const d = addDays(rangeStart, i);
      const m = d.getMonth(), y = d.getFullYear();
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
  }, [data, projStartF, projEndF]);

  const gridCols = ` ${LABEL_W}px repeat(${cal.dayObjs.length}, ${CELL_W}px)`;
  const headerRows = 3; // Month, Day, Date (top→bottom)

  // --- New: scroller ref + "Today" button ---
  const scrollerRef = useRef(null);
  const scrollToToday = () => {
    if (!scrollerRef.current) return;
    const left = Math.max(0, cal.todayIdx * CELL_W);
    scrollerRef.current.scrollTo({ left, behavior: "smooth" });
  };

  return (
    <div className="border rounded p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{title}</div>
        <button className="px-2 py-1 border rounded text-xs" onClick={scrollToToday} title="Scroll to today">
          Today
        </button>
      </div>

      <div ref={scrollerRef} style={{ overflowX: "auto", border: "1px solid #e5e7eb", borderRadius: 6 }}>
        <div
          style={{
            position: "relative",
            display: "grid",
            gridTemplateColumns: gridCols,
            gridAutoRows: `${ROW_H}px`,
          }}
        >
          {/* ========== Header labels column (Month / Day / Date) ========== */}
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

          {/* ========== Month header (spanning segments) ========== */}
          {cal.months.map((m, idx) => (
            <div key={`m${idx}`} style={{
              gridColumn: `${m.start + 2} / ${m.start + 2 + m.span}`,
              gridRow: "1 / 2",
              height: HDR_H, lineHeight: `${HDR_H}px`,
              textAlign: "center", fontSize: 12,
              background: HDR_BG_MONTH, borderBottom: "1px solid #e5e7eb"
            }}>
              {m.label}
            </div>
          ))}

          {/* ========== Day-of-week header ========== */}
          {cal.dayObjs.map((o, i) => (
            <div key={`dow${i}`} style={{
              gridColumn: `${i + 2} / ${i + 3}`,
              gridRow: "2 / 3",
              height: HDR_H, lineHeight: `${HDR_H}px`,
              textAlign: "center", fontSize: 12,
              color: "#111827",
              background: HDR_BG_DAY, borderBottom: "1px solid #e5e7eb"
            }}>
              {o.dow}
            </div>
          ))}

          {/* ========== Date (day-of-month) header ========== */}
          {cal.dayObjs.map((o, i) => (
            <div key={`dom${i}`} style={{
              gridColumn: `${i + 2} / ${i + 3}`,
              gridRow: "3 / 4",
              height: HDR_H, lineHeight: `${HDR_H}px`,
              textAlign: "center", fontSize: 12,
              background: HDR_BG_DATE, borderBottom: "1px solid #e5e7eb"
            }}
            title={o.d.toDateString()}>
              {o.dom}
            </div>
          ))}

          {/* ========== Zebra underlay for task rows ========== */}
          {data.map((_, i) => {
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

          {/* ========== Weekend underlay columns ========== */}
          {cal.dayObjs.map((o, i) => o.isWeekend ? (
            <div
              key={`wknd-${i}`}
              style={{
                gridColumn: `${i + 2} / ${i + 3}`,
                gridRow: `1 / ${headerRows + 1 + data.length}`,
                background: WEEKEND_BG,
                zIndex: 0,
              }}
              title="Weekend"
            />
          ) : null)}

          {/* ========== Today line ========== */}
          <div
            style={{
              gridColumn: `${cal.todayIdx + 2} / ${cal.todayIdx + 3}`,
              gridRow: `1 / ${headerRows + 1 + data.length}`,
              justifySelf: "center",
              width: 4, background: "#ef444479",
              opacity: 0.9, pointerEvents: "none", zIndex: 3
            }}
            title="Today"
          />

          {/* ========== Task rows ========== */}
          {data.map((t, i) => {
            const row = headerRows + 1 + i;

            // Label cell (sticky)
            const label = (
              <div key={`${t.id}-label`} style={{
                gridColumn: "1 / 2", gridRow: `${row} / ${row + 1}`,
                lineHeight: `${ROW_H}px`, height: ROW_H,
                padding: "0 8px", fontSize: 12,
                borderTop: "1px solid #e5e7eb",
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                background: "white",
                position: "sticky", left: 0, zIndex: 2
              }} title={t.name}>
                {t.name}
              </div>
            );

            if (!t.start || !t.end) return label;

            const startIdx = Math.max(0, diffDays(cal.rangeStart, t.start));
            const endIdx   = Math.min(cal.dayObjs.length - 1, diffDays(cal.rangeStart, t.end));
            const spanPlanned = Math.max(1, endIdx - startIdx + 1);

            // Overdue tail: only if not finished and due/end < today
            const today = floorLocal(new Date());
            const isDone = t.status === "finished";
            const overdue = !isDone && t.end < today;
            const overdueEndIdx = overdue ? Math.min(cal.dayObjs.length - 1, diffDays(cal.rangeStart, today)) : null;
            const overdueSpan   = overdue ? Math.max(1, overdueEndIdx - endIdx) : 0;

            const color = STATUS_COLORS[t.status] || "#111827c0";
            const barCommon = {
              gridRow: `${row} / ${row + 1}`,
              height: Math.max(16, ROW_H - 10),
              alignSelf: "center",
              borderRadius: 4,
              zIndex: 2,
            };

            return (
              <React.Fragment key={t.id}>
                {label}

                {/* planned segment */}
                <div
                  style={{
                    ...barCommon,
                    gridColumn: `${startIdx + 2} / span ${spanPlanned}`,
                    background: color,
                    border: "2px solid transparent",
                    opacity: 0.96,
                  }}
                  title={`${t.name} (${t.status}) • ${fmt(t.start)} → ${fmt(t.end)}`}
                />

                {/* overdue tail (due → today) */}
                {overdue && (
                  <div
                    style={{
                      ...barCommon,
                      gridColumn: `${endIdx + 2} / span ${overdueSpan}`,
                      background: OVERDUE_COLOR,
                      opacity: 0.92,
                    }}
                    title={`Overdue since ${fmt(t.end)}`}
                  />
                )}

                {/* row rule */}
                <div style={{
                  gridColumn: `2 / ${2 + cal.dayObjs.length}`,
                  gridRow: `${row} / ${row + 1}`,
                  borderTop: "1px solid #e5e7eb",
                  zIndex: 1,
                }} />
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
        <span><span style={{display:"inline-block", width:12, height:12, background:OVERDUE_COLOR, borderRadius:2, marginRight:6}} />Overdue</span>
        <span style={{marginLeft:8}}>Weekend shading + red “today” line</span>
      </div>
    </div>
  );
}
