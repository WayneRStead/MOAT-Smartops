// src/pages/Timesheet.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useTheme } from "../ThemeContext";

/* ---------- small helpers ---------- */
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseYmd(s) {
  if (!s) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  return isNaN(dt.getTime()) ? null : dt;
}
function isWeekend(ymdStr) {
  const d = parseYmd(ymdStr);
  if (!d) return false;
  const day = d.getDay(); // 0=Sun,6=Sat
  return day === 0 || day === 6;
}
function fmtHours(h) {
  if (!Number.isFinite(h) || h <= 0) return "";
  return h.toFixed(2);
}

/* CSV helpers (copied pattern from Clockings.jsx) */
function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function rowsToCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const headerLine = headers.map(csvEscape).join(",");
  const body = rows
    .map((r) => headers.map((h) => csvEscape(r[h])).join(","))
    .join("\n");
  return `${headerLine}\n${body}`;
}
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* --------- helpers to understand users/groups --------- */
function staffNoOf(userObj) {
  if (!userObj) return "";
  return (
    userObj.staffNumber ||
    userObj.staffNo ||
    userObj.employeeNumber ||
    userObj.employeeNo ||
    userObj.staff_code ||
    ""
  );
}
function idNumberOf(userObj) {
  if (!userObj) return "";
  return (
    userObj.idNumber ||
    userObj.idNo ||
    userObj.nationalId ||
    userObj.id ||
    ""
  );
}

/* ---------- hour calculation from clockings ---------- */
/**
 * Given sorted clockings for a single user+day, approximate hours worked.
 * Any non-"out" attendance type ("present","in","training","overtime")
 * starts a segment; "out" ends the current segment.
 */
function calcHoursForDay(events) {
  if (!events || !events.length) return 0;
  // sort by time ascending
  const sorted = [...events].sort(
    (a, b) => new Date(a.at || a.createdAt).getTime() - new Date(b.at || b.createdAt).getTime()
  );
  let openStart = null;
  let totalMs = 0;
  for (const ev of sorted) {
    const type = String(ev.type || "").toLowerCase();
    const at = ev.at ? new Date(ev.at).getTime() : null;
    if (!Number.isFinite(at)) continue;

    if (type === "out") {
      if (openStart != null) {
        const delta = at - openStart;
        if (delta > 0 && delta < 1000 * 60 * 60 * 24) {
          totalMs += delta;
        }
        openStart = null;
      }
    } else {
      // start of a segment
      if (openStart == null) {
        openStart = at;
      } else {
        // already open: close previous segment and reopen
        const delta = at - openStart;
        if (delta > 0 && delta < 1000 * 60 * 60 * 24) {
          totalMs += delta;
        }
        openStart = at;
      }
    }
  }
  // ignore trailing open segment (no "out")
  return totalMs / (1000 * 60 * 60); // hours
}

/* ---------- code calculation (P/T/S/L/I) ---------- */
function calcCodeForDay(events) {
  if (!events || !events.length) return "";
  const types = new Set(events.map((e) => String(e.type || "").toLowerCase()));
  // Priority: T > S > L > I > P
  if (types.has("training")) return "T";
  if (types.has("sick")) return "S";
  if (types.has("leave")) return "L";
  if (types.has("iod")) return "I";
  if (types.has("present") || types.has("in") || types.has("overtime")) return "P";
  return "";
}

export default function Timesheet() {
  const { org } = useTheme();
  const accent = org?.accentColor || "#2a7fff";

  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [rowsRaw, setRowsRaw] = useState([]); // raw clockings

  const [from, setFrom] = useState(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return ymd(start);
  });
  const [to, setTo] = useState(() => ymd(new Date()));
  const [filterUserId, setFilterUserId] = useState("");
  const [filterGroupId, setFilterGroupId] = useState("");
  const [mode, setMode] = useState("code"); // "code" | "time"

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  /* --------- lookups --------- */
  const userById = useMemo(() => {
    const m = new Map();
    users.forEach((u) => m.set(String(u._id), u));
    return m;
  }, [users]);

  /* groupsByUserId: same idea as in Clockings.jsx */
  const groupsByUserId = useMemo(() => {
    const map = new Map();
    const add = (uid, gid, gname) => {
      if (!uid || !gid) return;
      const key = String(uid);
      const rec = map.get(key) || { ids: [], names: [] };
      const gidS = String(gid);
      if (!rec.ids.includes(gidS)) rec.ids.push(gidS);
      if (gname && !rec.names.includes(String(gname))) rec.names.push(String(gname));
      map.set(key, rec);
    };

    (groups || [])
      .filter((g) => !g?.isDeleted)
      .forEach((g) => {
        const gid = g?._id;
        const gname = g?.name || String(gid);

        const memberUserIds = Array.isArray(g?.memberUserIds) ? g.memberUserIds : [];
        const leaderUserIds = Array.isArray(g?.leaderUserIds) ? g.leaderUserIds : [];
        const membersLegacy = Array.isArray(g?.members) ? g.members : [];

        memberUserIds.forEach((uid) => add(uid, gid, gname));
        leaderUserIds.forEach((uid) => add(uid, gid, gname));
        membersLegacy.forEach((m) => {
          if (!m) return;
          if (typeof m === "string") add(m, gid, gname);
          else {
            const uid = m.userId || m._id || m.id;
            if (uid) add(uid, gid, gname);
          }
        });
      });

    return map;
  }, [groups]);

  const userGroupNames = (uid) =>
    (groupsByUserId.get(String(uid))?.names || []).join(", ");

  const userGroupHas = (uid, gid) => {
    const rec = groupsByUserId.get(String(uid));
    if (!rec) return false;
    return rec.ids.includes(String(gid));
  };

  /* --------- date list for columns --------- */
  const days = useMemo(() => {
    const start = parseYmd(from);
    const end = parseYmd(to);
    if (!start || !end || start > end) return [];
    const out = [];
    let d = new Date(start);
    while (d <= end) {
      out.push({
        key: ymd(d),
        label: String(d.getDate()).padStart(2, "0"),
      });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }, [from, to]);

  /* --------- load reference data once --------- */
  useEffect(() => {
    async function loadRefs() {
      try {
        const [usersRes, groupsRes] = await Promise.all([
          api.get("/users", { params: { limit: 1000 } }),
          api.get("/groups", { params: { limit: 1000 } }),
        ]);
        setUsers(Array.isArray(usersRes.data) ? usersRes.data : []);
        setGroups(Array.isArray(groupsRes.data) ? groupsRes.data : []);
      } catch {
        // ignore for now
      }
    }
    loadRefs();
  }, []);

  /* --------- fetch clockings when "Run report" clicked --------- */
  async function runReport() {
    setErr("");
    setInfo("");
    setLoading(true);
    try {
      const params = { limit: 5000 };

      if (from) params.from = from;
      if (to) {
        // inclusive end date using < next day trick (as in Clockings)
        const end = parseYmd(to);
        if (end) {
          const next = new Date(end);
          next.setDate(next.getDate() + 1);
          params.to = ymd(next);
        }
      }
      if (filterUserId) params.userId = filterUserId;
      // IMPORTANT: no groupId param; we filter client-side using groupsByUserId

      const { data } = await api.get("/clockings", { params });
      let list = Array.isArray(data)
        ? data
        : Array.isArray(data?.rows)
        ? data.rows
        : [];

      // client-side group filtering
      if (!filterUserId && filterGroupId) {
        const gid = String(filterGroupId);
        list = list.filter((r) => userGroupHas(r.userId, gid));
      }

      setRowsRaw(list);
      setInfo(`Loaded ${list.length} clockings for report.`);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
      setRowsRaw([]);
    } finally {
      setLoading(false);
    }
  }

  /* --------- build timesheet rows --------- */
  const timesheetRows = useMemo(() => {
    if (!rowsRaw.length || !days.length) return [];

    // group events by userId+day
    const byUserDay = new Map(); // key: `${uid}|${ymd}` -> events[]
    for (const ev of rowsRaw) {
      const uid = String(ev.userId || (ev.user && ev.user._id) || "");
      if (!uid) continue;
      const d = ev.at ? new Date(ev.at) : ev.createdAt ? new Date(ev.createdAt) : null;
      if (!d || isNaN(d.getTime())) continue;
      const dayKey = ymd(d);
      if (!days.some((x) => x.key === dayKey)) continue; // outside selected range
      const key = `${uid}|${dayKey}`;
      const arr = byUserDay.get(key) || [];
      arr.push(ev);
      byUserDay.set(key, arr);
    }

    // Which users actually appear?
    const userIdsInData = new Set();
    for (const key of byUserDay.keys()) {
      const [uid] = key.split("|");
      if (uid) userIdsInData.add(uid);
    }

    const rows = [];
    const sortedUserIds = Array.from(userIdsInData).sort((a, b) => {
      const ua = userById.get(a);
      const ub = userById.get(b);
      const na = ua?.name || ua?.email || a;
      const nb = ub?.name || ub?.email || b;
      return na.localeCompare(nb);
    });

    for (const uid of sortedUserIds) {
      const u = userById.get(uid) || {};
      const row = {
        staffNo: staffNoOf(u),
        name: u.name || u.email || uid,
        idNumber: idNumberOf(u),
        group: userGroupNames(uid),
        totalsWorking: 0,
        totalsT: 0,
        totalsS: 0,
        totalsL: 0,
        totalsI: 0,
        totalHours: 0,
        cells: {}, // dayKey -> { code, hours }
      };

      for (const d of days) {
        const key = `${uid}|${d.key}`;
        const events = byUserDay.get(key) || [];

        if (mode === "code") {
          const code = calcCodeForDay(events);
          row.cells[d.key] = { code, hours: null };
          // update totals
          if (code === "P") row.totalsWorking += 1;
          if (code === "T") row.totalsT += 1;
          if (code === "S") row.totalsS += 1;
          if (code === "L") row.totalsL += 1;
          if (code === "I") row.totalsI += 1;
        } else {
          const hours = calcHoursForDay(events);
          row.cells[d.key] = { code: "", hours };
          row.totalHours += hours;
        }
      }

      rows.push(row);
    }

    return rows;
  }, [rowsRaw, days, userById, userGroupNames, mode]);

  /* --------- export CSV of current table --------- */
  function exportCsv() {
    if (!timesheetRows.length || !days.length) {
      setErr("Nothing to export – run the report first.");
      return;
    }

    const headersBase = ["StaffNo", "Name", "IDNumber", "Group"];
    const dayHeaders = days.map((d) => d.key); // YYYY-MM-DD
    const endHeaders =
      mode === "code"
        ? ["WorkingDays(P)", "TrainingDays(T)", "SickDays(S)", "LeaveDays(L)", "IODays(I)"]
        : ["TotalHours"];

    const csvRows = timesheetRows.map((r) => {
      const base = {
        StaffNo: r.staffNo,
        Name: r.name,
        IDNumber: r.idNumber,
        Group: r.group,
      };
      const dayVals = {};
      for (const d of days) {
        const cell = r.cells[d.key] || {};
        dayVals[d.key] = mode === "code" ? (cell.code || "") : fmtHours(cell.hours);
      }
      const endVals =
        mode === "code"
          ? {
              "WorkingDays(P)": r.totalsWorking,
              "TrainingDays(T)": r.totalsT,
              "SickDays(S)": r.totalsS,
              "LeaveDays(L)": r.totalsL,
              "IODays(I)": r.totalsI,
            }
          : { TotalHours: fmtHours(r.totalHours) };

      return { ...base, ...dayVals, ...endVals };
    });

    const orderedRows = csvRows.map((r) => {
      const out = {};
      for (const h of [...headersBase, ...dayHeaders, ...endHeaders]) {
        out[h] = r[h] ?? "";
      }
      return out;
    });

    const csv = rowsToCsv(orderedRows);
    triggerDownload(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      `timesheet_${from || "from"}_${to || "to"}.csv`
    );
  }

  /* --------- print (use browser's Save as PDF) --------- */
  function handlePrint() {
    window.print();
  }

  return (
    <div className="max-w-[95vw] mx-auto p-4" style={{ "--accent": accent }}>
      <style>{`
        .btn{border:1px solid #e5e7eb;border-radius:10px;padding:6px 10px;background:#fff;font-size:0.875rem}
        .btn:hover{box-shadow:0 1px 0 rgba(0,0,0,.04)}
        .btn-accent{background:var(--accent,#2a7fff);color:#fff;border-color:var(--accent,#2a7fff)}
        .btn-sm{padding:4px 8px;border-radius:8px}
        .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px}
        .table{width:100%;border-collapse:collapse;font-size:0.72rem}
        .table th,.table td{border:1px solid #e5e7eb;padding:2px 4px;text-align:center}
        .table th{background:#f9fafb;font-weight:600}
        .weekend-col{background:#f3f4f6}
        .timesheet-container{overflow-x:auto}

        @media print {
          body{background:#fff}
          .no-print{display:none!important}
          .table th,.table td{font-size:8px;padding:2px}
          .card{border:none}
        }
      `}</style>

      <div className="flex items-center justify-between gap-3 flex-wrap no-print">
        <h1 className="text-2xl font-semibold">Timesheet</h1>
        <div className="flex items-center gap-2">
          <button className="btn btn-sm" onClick={exportCsv}>
            Export CSV
          </button>
          <button className="btn btn-sm" onClick={handlePrint}>
            Print / PDF
          </button>
        </div>
      </div>

      {err && (
        <div className="no-print mt-2 px-3 py-2 rounded-lg bg-red-50 text-red-700 text-sm border border-red-200">
          {err}
        </div>
      )}
      {info && (
        <div className="no-print mt-2 px-3 py-2 rounded-lg bg-emerald-50 text-emerald-700 text-sm border border-emerald-200">
          {info}
        </div>
      )}

      {/* Filters */}
      <div className="card no-print mt-3 p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            From
            <input
              type="date"
              className="border rounded p-1 ml-2"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="text-sm">
            To
            <input
              type="date"
              className="border rounded p-1 ml-2"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>

          <label className="text-sm">
            User
            <select
              className="border rounded p-1 ml-2"
              value={filterUserId}
              onChange={(e) => setFilterUserId(e.target.value)}
            >
              <option value="">Any</option>
              {users.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.name || u.email || u.username}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            Group
            <select
              className="border rounded p-1 ml-2"
              value={filterGroupId}
              onChange={(e) => setFilterGroupId(e.target.value)}
            >
              <option value="">Any</option>
              {(groups || [])
                .filter((g) => !g?.isDeleted)
                .map((g) => (
                  <option key={g._id} value={g._id}>
                    {g.name}
                  </option>
                ))}
            </select>
          </label>

          <label className="text-sm">
            Mode
            <select
              className="border rounded p-1 ml-2"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="code">Code-based (P/T/S/L/I)</option>
              <option value="time">Time-based (hours)</option>
            </select>
          </label>

          <button className="btn btn-accent ml-auto" onClick={runReport} disabled={loading}>
            {loading ? "Loading…" : "Run report"}
          </button>
        </div>

        <div className="text-xs text-gray-500">
          Code mode: P = Present / In / Overtime, T = Training, S = Sick, L = Leave, I = Injury on Duty.
          Weekends are shaded.
        </div>
      </div>

      {/* Timesheet table */}
      <div className="card mt-4 p-3 timesheet-container">
        {(!timesheetRows.length || !days.length) && (
          <div className="text-sm text-gray-500 p-2">
            Run the report to see the timesheet for your selection.
          </div>
        )}

        {timesheetRows.length > 0 && days.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th rowSpan={2}>Staff #</th>
                <th rowSpan={2}>Name</th>
                <th rowSpan={2}>ID Number</th>
                <th rowSpan={2}>Group</th>
                <th colSpan={days.length}>Attendance</th>
                {mode === "code" ? (
                  <>
                    <th rowSpan={2}>P</th>
                    <th rowSpan={2}>T</th>
                    <th rowSpan={2}>S</th>
                    <th rowSpan={2}>L</th>
                    <th rowSpan={2}>I</th>
                  </>
                ) : (
                  <th rowSpan={2}>Total Hrs</th>
                )}
              </tr>
              <tr>
                {days.map((d) => (
                  <th
                    key={d.key}
                    className={isWeekend(d.key) ? "weekend-col" : ""}
                  >
                    {d.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {timesheetRows.map((r, idx) => (
                <tr key={idx}>
                  <td>{r.staffNo}</td>
                  <td style={{ textAlign: "left" }}>{r.name}</td>
                  <td>{r.idNumber}</td>
                  <td style={{ textAlign: "left" }}>{r.group}</td>
                  {days.map((d) => {
                    const cell = r.cells[d.key] || {};
                    return (
                      <td
                        key={d.key}
                        className={isWeekend(d.key) ? "weekend-col" : ""}
                      >
                        {mode === "code"
                          ? cell.code || ""
                          : fmtHours(cell.hours)}
                      </td>
                    );
                  })}
                  {mode === "code" ? (
                    <>
                      <td>{r.totalsWorking || ""}</td>
                      <td>{r.totalsT || ""}</td>
                      <td>{r.totalsS || ""}</td>
                      <td>{r.totalsL || ""}</td>
                      <td>{r.totalsI || ""}</td>
                    </>
                  ) : (
                    <td>{fmtHours(r.totalHours)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
