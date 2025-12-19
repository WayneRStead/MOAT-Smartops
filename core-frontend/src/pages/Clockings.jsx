// src/pages/Clockings.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom"; // ★ for Timesheet button
import { api } from "../lib/api";
import ClockingEditForm from "../components/ClockingEditForm";
import { useTheme } from "../ThemeContext";

const ATTENDANCE_TYPES = ["present","in","out","training","sick","leave","iod","overtime"];

/** Helpers for <input type="datetime-local"> **/
function toLocalInput(dtLike) {
  if (!dtLike) return "";
  const d = new Date(dtLike);
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 16);
}
function fromLocalInput(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** pretty-print values in audit table */
function fmtVal(v) {
  if (v == null) return "—";
  if (typeof v === "object") {
    try { return JSON.stringify(v, null, 2); }
    catch { return String(v); }
  }
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** CSV helpers **/
function csvEscape(val) {
  if (val === null || val === undefined) return "";
  const s = String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function rowsToCsv(rows, columns) {
  const header = columns.map(c => csvEscape(c.header || c.key)).join(",");
  const body = rows.map(r =>
    columns.map(c => {
      const v = typeof c.get === "function" ? c.get(r) : r[c.key];
      return csvEscape(v);
    }).join(",")
  ).join("\n");
  return `${header}\n${body}`;
}
function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** small concurrency helper for export */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { results[idx] = await fn(items[idx], idx); }
      catch { results[idx] = undefined; }
    }
  });
  await Promise.all(workers);
  return results;
}

/** --- KML helpers --- **/
function kmlEsc(s = "") {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function val(v) { return v == null ? "" : String(v); }
function makeKmlPlacemarkFromClocking(r, opts) {
  const lat = r?.location?.lat ?? r?.lat;
  const lng = r?.location?.lng ?? r?.lng;
  if (!(Number.isFinite(lat) && Number.isFinite(lng))) return "";
  const acc = r?.location?.acc ?? r?.acc;
  const whenIso = r.at ? new Date(r.at).toISOString() : "";
  const user = opts.userName(r.userId) || (r.user?.name || r.user?.email || "");
  const proj = opts.projectName(r.projectId) || (r.project?.name || "");
  const lastBy = r.lastEditedBy?.name || r.lastEditedBy?.email || (r.lastEditedBy ? String(r.lastEditedBy) : "");
  const reason = r._lastEditReason || "";
  const name = [r.type || "clocking", user && `- ${user}`, whenIso && `@ ${whenIso}`].filter(Boolean).join(" ");
  const description = [
    user && `User: ${user}`,
    proj && `Project: ${proj}`,
    r.type && `Type: ${r.type}`,
    whenIso && `When: ${whenIso}`,
    r.notes && `Notes: ${r.notes}`,
  ].filter(Boolean).join("\n");
  return `
    <Placemark>
      <name>${kmlEsc(name)}</name>
      ${description ? `<description>${kmlEsc(description)}</description>` : ""}
      ${whenIso ? `<TimeStamp><when>${kmlEsc(whenIso)}</when></TimeStamp>` : ""}
      <ExtendedData>
        <Data name="id"><value>${kmlEsc(r._id || "")}</value></Data>
        <Data name="type"><value>${kmlEsc(r.type || "")}</value></Data>
        <Data name="user"><value>${kmlEsc(user)}</value></Data>
        <Data name="project"><value>${kmlEsc(proj)}</value></Data>
        <Data name="notes"><value>${kmlEsc(val(r.notes))}</value></Data>
        <Data name="lat"><value>${kmlEsc(lat)}</value></Data>
        <Data name="lng"><value>${kmlEsc(lng)}</value></Data>
        <Data name="acc_m"><value>${kmlEsc(val(acc))}</value></Data>
        <Data name="lastEditedAt"><value>${kmlEsc(r.lastEditedAt ? new Date(r.lastEditedAt).toISOString() : "")}</value></Data>
        <Data name="lastEditedBy"><value>${kmlEsc(lastBy)}</value></Data>
        <Data name="lastEditReason"><value>${kmlEsc(reason)}</value></Data>
      </ExtendedData>
      <Point><coordinates>${lng},${lat},0</coordinates></Point>
    </Placemark>
  `.trim();
}
function makeKmlDocument(placemarks, docName = "Clockings Export") {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${kmlEsc(docName)}</name>
    ${placemarks.join("\n")}
  </Document>
</kml>`;
}

/** ★ robust getters for method + staff number **/
function methodOf(r) {
  const m = r?.method || r?.meta?.method || r?.source;
  if (m) return String(m).toLowerCase();
  if (r?.biometric === true || r?.faceMatch === true || r?.facial === true) return "biometric";
  return "manual";
}
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

export default function Clockings() {
  const { org } = useTheme();
  const accent = org?.accentColor || "#2a7fff";

  // reference data
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [groups, setGroups] = useState([]);

  // filters for history
  const [q, setQ] = useState("");
  const [filterProjectId, setFilterProjectId] = useState("");
  const [filterUserId, setFilterUserId] = useState("");
  const [filterGroupId, setFilterGroupId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  // history
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  // create form (now in modal)
  const [createOpen, setCreateOpen] = useState(false);
  const [isBulk, setIsBulk] = useState(true);
  const [projectId, setProjectId] = useState("");
  const [type, setType] = useState("present");
  const [at, setAt] = useState(() => toLocalInput(new Date()));
  const [notes, setNotes] = useState("");
  const [selectedUsers, setSelectedUsers] = useState([]);   // for bulk
  const [singleUser, setSingleUser] = useState("");         // for single

  // geo (optional)
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [acc, setAcc] = useState("");

  // messages
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  // edit modal
  const [editOpen, setEditOpen] = useState(false);
  const [editingRow, setEditingRow] = useState(null);

  // audit modal
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditRows, setAuditRows] = useState([]);
  const [auditHeader, setAuditHeader] = useState(null);

  // compact "reason" cache for table hover
  const [reasonCache, setReasonCache] = useState({});

  // export busy
  const [exportBusy, setExportBusy] = useState(false);

  // quick lookups
  const userById = useMemo(() => {
    const m = new Map();
    users.forEach(u => m.set(String(u._id), u));
    return id => m.get(String(id));
  }, [users]);

  const userName = useMemo(() => {
    const m = new Map();
    users.forEach(u => m.set(String(u._id), u.name || u.email || u.username || String(u._id)));
    return id => m.get(String(id)) || String(id || "—");
  }, [users]);

  const projectName = useMemo(() => {
    const m = new Map();
    projects.forEach(p => m.set(String(p._id), p.name || String(p._id)));
    return id => m.get(String(id)) || "—";
  }, [projects]);

  /** ───────────────────────────── Block A: Groups mapping ─────────────────────────────
   * Build:
   *  - groupsByUserId: Map<userId, { ids: string[], names: string[] }>
   * Handles both new schema (memberUserIds/leaderUserIds) and legacy (members).
   */
  const groupsByUserId = useMemo(() => {
    const map = new Map(); // userId -> { ids: string[], names: string[] }

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
      .filter(g => !g?.isDeleted) // only active groups
      .forEach(g => {
        const gid = g?._id;
        const gname = g?.name || String(gid);

        // New schema
        const memberUserIds = Array.isArray(g?.memberUserIds) ? g.memberUserIds : [];
        const leaderUserIds = Array.isArray(g?.leaderUserIds) ? g.leaderUserIds : [];

        // Legacy: members: string[] or object[]
        const membersLegacy = Array.isArray(g?.members) ? g.members : [];

        memberUserIds.forEach(uid => add(uid, gid, gname));
        leaderUserIds.forEach(uid => add(uid, gid, gname));

        membersLegacy.forEach(m => {
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

  /** human-readable list of a user's group names */
  const userGroupNames = (uid) => (groupsByUserId.get(String(uid))?.names || []).join(", ");

  /** membership test by group _id */
  const userGroupHas = (uid, groupId) => {
    const rec = groupsByUserId.get(String(uid));
    if (!rec) return false;
    return rec.ids.includes(String(groupId));
  };
  /** ──────────────────────────── end Block A ──────────────────────────── */

  // users eligible by project
  const eligibleUsers = useMemo(() => {
    if (!projectId) return users;
    const proj = projects.find(p => String(p._id) === String(projectId));
    const memberIds = new Set((proj?.members || []).map(String));
    if (!memberIds.size) return users;
    return users.filter(u => memberIds.has(String(u._id)));
  }, [projectId, users, projects]);

  // latest status per user to know who is "in"
  const latestTypeByUser = useMemo(() => {
    const map = new Map();
    // assume rows are mixed; reduce to latest by at timestamp or order
    rows.forEach(r => {
      const key = String(r.userId);
      const t = new Date(r.at || r.createdAt || 0).getTime();
      const prev = map.get(key);
      if (!prev || t > prev.t) map.set(key, { t, type: String(r.type || "").toLowerCase() });
    });
    return map; // Map<userId,{t,type}>
  }, [rows]);

  /** ★ restrict who can be clocked OFF */
  const currentlyInSet = useMemo(() => {
    const IN_TYPES = new Set(["present","in","training","overtime"]);
    const set = new Set();
    latestTypeByUser.forEach((v, uid) => {
      if (IN_TYPES.has(v.type)) set.add(String(uid));
    });
    return set;
  }, [latestTypeByUser]);

  const eligibleUsersByType = useMemo(() => {
    if (String(type).toLowerCase() !== "out") return eligibleUsers;
    const only = eligibleUsers.filter(u => currentlyInSet.has(String(u._id)));
    return only;
  }, [type, eligibleUsers, currentlyInSet]);

  // load reference data
  async function loadUsers() {
    try { const { data } = await api.get("/users", { params: { limit: 1000 } }); setUsers(Array.isArray(data) ? data : []); }
    catch { setUsers([]); }
  }
  async function loadProjects() {
    try { const { data } = await api.get("/projects", { params: { limit: 1000 } }); setProjects(Array.isArray(data) ? data : []); }
    catch { setProjects([]); }
  }
  async function loadGroups() {
    try { const { data } = await api.get("/groups", { params: { limit: 1000 } }); setGroups(Array.isArray(data) ? data : []); }
    catch { setGroups([]); }
  }

  function getSearchParams() {
  const params = { limit: 500 };
  if (q) params.q = q;
  if (filterProjectId) params.projectId = filterProjectId;
  if (filterUserId) params.userId = filterUserId;

  // IMPORTANT:
  // Do NOT send groupId to the backend for now.
  // The backend's group filter likely only understands legacy fields,
  // which drops rows for newly created groups before we can client-filter.
  // We fetch the broader set and apply the strict client-side filter in load().
  // if (filterGroupId) params.groupId = filterGroupId;
  // Inclusive date range: from (start of day) ... to (END of day)
  // Implemented by sending `to` as (selected to + 1 day), i.e. exclusive upper bound.
  const addDays = (yyyyMmDd, n) => {
    const d = new Date(yyyyMmDd);
    if (isNaN(d)) return "";
    d.setDate(d.getDate() + n);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  if (from) params.from = from;           // inclusive start
  if (to)   params.to   = addDays(to, 1); // inclusive end by using < next day
  if (typeFilter) params.type = typeFilter;

  return params;
}

  async function load() {
    setErr(""); setInfo(""); setLoading(true);
    try {
      const { data } = await api.get("/clockings", { params: getSearchParams() });
      let list = Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : []);

      /** ───────────────────────────── Block B: client-side group filter ─────────────────────────────
       * Strict id-based check so new & legacy groups work immediately, even if the backend ignores groupId.
       */
      if (filterGroupId) {
        const gid = String(filterGroupId);
        list = list.filter(r => userGroupHas(r.userId, gid));
      }
      /** ──────────────────────────── end Block B ──────────────────────────── */

      setRows(list);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
    loadProjects();
    loadGroups();
    load();
  }, []);

  // present location button
  function useMyLocation() {
    setErr(""); setInfo("");
    if (!navigator.geolocation) { setErr("Geolocation not supported in this browser."); return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude, longitude, accuracy } = pos.coords || {};
        setLat(latitude?.toFixed(6) ?? "");
        setLng(longitude?.toFixed(6) ?? "");
        setAcc(Number.isFinite(accuracy) ? Math.round(accuracy) : "");
        setInfo("Location captured."); setTimeout(() => setInfo(""), 1200);
      },
      err => setErr(err?.message || "Failed to get location"),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  // toggle user (pill)
  function toggleUser(id) {
    setSelectedUsers(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function submitClocking(e) {
    e.preventDefault();
    setErr(""); setInfo("");
    try {
      const payloadBase = {
        type,
        notes,
        at: fromLocalInput(at) || undefined,
        projectId: projectId || undefined,
      };
      const nLat = lat !== "" ? Number(lat) : undefined;
      const nLng = lng !== "" ? Number(lng) : undefined;
      const nAcc = acc !== "" ? Number(acc) : undefined;
      if (Number.isFinite(nLat) && Number.isFinite(nLng)) {
        payloadBase.lat = nLat; payloadBase.lng = nLng;
        if (Number.isFinite(nAcc)) payloadBase.acc = nAcc;
      }
      if (isBulk) {
        const pool = type.toLowerCase() === "out" ? eligibleUsersByType : eligibleUsers; // ★ restrict on OUT
        const selected = selectedUsers.filter(id => pool.some(u => String(u._id) === String(id)));
        if (!selected.length) return setErr(type.toLowerCase() === "out" ? "Pick users who are clocked in." : "Select at least one user.");
        await api.post("/clockings", { ...payloadBase, userIds: selected });
        setInfo(`Clocked ${selected.length} user(s).`);
        setSelectedUsers([]);
      } else {
        const pool = type.toLowerCase() === "out" ? eligibleUsersByType : eligibleUsers; // ★ restrict on OUT
        if (!singleUser || !pool.some(u => String(u._id) === String(singleUser))) {
          return setErr(type.toLowerCase() === "out" ? "Pick a user who is clocked in." : "Pick a user.");
        }
        await api.post("/clockings", { ...payloadBase, userId: singleUser });
        setInfo("Clocking saved."); setSingleUser("");
      }
      setNotes("");
      setAt(toLocalInput(new Date()));
      await load();
      setCreateOpen(false);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function del(id) {
    if (!confirm("Delete this clocking?")) return;
    setErr(""); setInfo("");
    try {
      await api.delete(`/clockings/${id}`);
      setRows(prev => prev.filter(r => r._id !== id));
      setInfo("Deleted.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  function openEdit(row) { setEditingRow(row); setEditOpen(true); }
  function closeEdit() { setEditOpen(false); setEditingRow(null); }

  async function openAudit(row) {
    setAuditOpen(true); setAuditLoading(true); setAuditRows([]);
    setAuditHeader({ at: row.at, userId: row.userId, projectId: row.projectId, type: row.type, _id: row._id });
    try {
      const { data } = await api.get(`/clockings/${row._id}/audit`);
      const list = Array.isArray(data?.editLog) ? data.editLog : [];
      list.sort((a,b) => new Date(b.editedAt).getTime() - new Date(a.editedAt).getTime());
      setAuditRows(list);
      setAuditHeader(h => ({
        ...h,
        lastEditedAt: data?.lastEditedAt || null,
        lastEditedBy: data?.lastEditedBy || null,
      }));
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setAuditLoading(false);
    }
  }
  function closeAudit() { setAuditOpen(false); setAuditRows([]); setAuditHeader(null); }

  async function preloadReason(id) {
    if (!id || reasonCache[id] !== undefined) return;
    try {
      const { data } = await api.get(`/clockings/${id}/audit`);
      const list = Array.isArray(data?.editLog) ? data.editLog : [];
      list.sort((a,b) => new Date(b.editedAt).getTime() - new Date(a.editedAt).getTime());
      const note = (list.find(x => (x.note || "").trim())?.note || "").trim();
      setReasonCache(prev => ({ ...prev, [id]: note }));
    } catch {
      setReasonCache(prev => ({ ...prev, [id]: "" }));
    }
  }

  /** ---- Export helpers ---- **/
  // ★ include group, method, staffNumber in CSV
  const exportColumns = useMemo(() => ([
    { key: "_id", header: "id" },
    { key: "at", header: "at", get: r => r.at ? new Date(r.at).toISOString() : "" },
    { key: "type", header: "type" },
    { key: "user", header: "user", get: r => r.user?.name || r.user?.email || userName(r.userId) },
    { key: "project", header: "project", get: r => r.project?.name || projectName(r.projectId) },
    { key: "group", header: "group", get: r => userGroupNames(r.userId) },          // ★
    { key: "method", header: "method", get: r => methodOf(r) },                      // ★
    { key: "staffNumber", header: "staffNumber", get: r => staffNoOf(userById(r.userId)) }, // ★
    { key: "lat", header: "lat", get: r => r.location?.lat ?? r.lat ?? "" },
    { key: "lng", header: "lng", get: r => r.location?.lng ?? r.lng ?? "" },
    { key: "acc", header: "acc", get: r => r.location?.acc ?? r.acc ?? "" },
    { key: "notes", header: "notes" },
    { key: "lastEditedAt", header: "lastEditedAt", get: r => r.lastEditedAt ? new Date(r.lastEditedAt).toISOString() : "" },
    { key: "lastEditedBy", header: "lastEditedBy", get: r => r.lastEditedBy?.name || r.lastEditedBy?.email || "" },
    { key: "lastEditReason", header: "lastEditReason", get: r => r._lastEditReason || "" },
  ]), [userName, projectName, userById, groupsByUserId]);

  async function fetchAllForExport(params) {
    const { data } = await api.get("/clockings", { params: { ...params, limit: 10000 }, headers: { "cache-control": "no-cache" } });
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.rows)) return data.rows;
    return [];
  }
  async function fetchLatestEditReason(id) {
    if (reasonCache[id] !== undefined) return reasonCache[id] || "";
    try {
      const { data } = await api.get(`/clockings/${id}/audit`);
      const list = Array.isArray(data?.editLog) ? data.editLog : [];
      list.sort((a,b) => new Date(b.editedAt).getTime() - new Date(a.editedAt).getTime());
      const note = (list.find(x => (x.note || "").trim())?.note || "").trim();
      return note;
    } catch { return ""; }
  }
  async function exportCsv() {
    setErr(""); setExportBusy(true);
    try {
      const params = getSearchParams();
      const all = await fetchAllForExport(params);
      const reasons = await mapWithConcurrency(all, 6, async (row) => await fetchLatestEditReason(row._id));
      const withReasons = all.map((r, i) => ({ ...r, _lastEditReason: reasons[i] || "" }));
      const csv = rowsToCsv(withReasons, exportColumns);
      triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8" }), "clockings.csv");
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Failed to export CSV.");
    } finally {
      setExportBusy(false);
    }
  }
  async function exportKml() {
    setErr(""); setExportBusy(true);
    try {
      const params = getSearchParams();
      const all = await fetchAllForExport(params);
      const reasons = await mapWithConcurrency(all, 6, async (row) => await fetchLatestEditReason(row._id));
      const enriched = all.map((r, i) => ({ ...r, _lastEditReason: reasons[i] || "" }));
      const placemarks = enriched.map(r => makeKmlPlacemarkFromClocking(r, { userName, projectName })).filter(Boolean);
      if (!placemarks.length) { setErr("No clockings with coordinates in the current search to export."); setExportBusy(false); return; }
      const kml = makeKmlDocument(placemarks, "Clockings Export");
      triggerDownload(new Blob([kml], { type: "application/vnd.google-earth.kml+xml;charset=utf-8" }), "clockings.kml");
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Failed to export KML.");
    } finally { setExportBusy(false); }
  }

  return (
    <div className="max-w-7xl mx-auto p-4" style={{ "--accent": accent }}>
      {/* local styles */}
      <style>{`
        .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px}
        .btn{border:1px solid #e5e7eb;border-radius:10px;padding:8px 12px;background:#fff}
        .btn:hover{box-shadow:0 1px 0 rgba(0,0,0,.04)}
        .btn-sm{padding:6px 10px;border-radius:8px}
        .btn-accent{background:var(--accent,#2a7fff);color:#fff;border-color:var(--accent,#2a7fff)}
        .btn-danger{background:#b91c1c;color:#fff;border-color:#7f1d1d}
        .pill{
          border:1px solid var(--border,#e5e7eb);
          padding:.35rem .7rem;border-radius:9999px;cursor:pointer;
          font-weight:600;background:#fff;color:#111827;
        }
        .pill.active{background:var(--accent,#2a7fff);border-color:var(--accent,#2a7fff);color:#fff}
        .table{width:100%;border-collapse:collapse}
        .table th,.table td{padding:.5rem;border-top:1px solid #eef2f7;text-align:left}
        .muted{color:#64748b}

        /* compact filter grid */
        .filters-grid{
          display:grid;
          grid-template-columns: repeat(6, minmax(0,1fr));
          gap:.5rem;
        }
        @media (max-width: 1200px){
          .filters-grid{ grid-template-columns: repeat(3, minmax(0,1fr)); }
        }
        @media (max-width: 640px){
          .filters-grid{ grid-template-columns: repeat(2, minmax(0,1fr)); }
        }

        /* user pills */
        .user-pills{
          border:1px solid #e5e7eb;border-radius:10px;max-height:40vh;overflow:auto;
          padding:.5rem; background:#fff;
        }
        .user-pills .chip{
          display:inline-flex; align-items:center; gap:.5rem;
          border:1px solid #e5e7eb; border-radius:9999px;
          padding:.35rem .65rem; margin:.25rem;
          background:#fff; color:#111827; cursor:pointer;
          user-select:none; transition:transform .05s ease;
          max-width:100%; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;
        }
        .user-pills .chip:active{ transform:scale(0.98); }
        .user-pills .chip.active{
          background:var(--accent,#2a7fff); border-color:var(--accent,#2a7fff); color:#fff;
        }
        .user-pills .chip .name{ overflow:hidden; text-overflow:ellipsis; }
      `}</style>

      {/* Header row */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Clockings</h1>
        {/* ★ moved "New clocking" out of here */}
      </div>

      {err && <div className="text-red-600 mt-2">{err}</div>}
      {info && <div className="text-green-700 mt-2">{info}</div>}

      {/* Exports toolbar */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            className="px-3 py-2 border rounded"
            onClick={exportCsv}
            disabled={exportBusy}
            title="Export current search as CSV (includes last edit reason)"
          >
            {exportBusy ? "Exporting…" : "Export CSV"}
          </button>
          <button
            className="px-3 py-2 border rounded"
            onClick={exportKml}
            disabled={exportBusy}
            title="Export current search as KML (points; includes last edit reason)"
          >
            {exportBusy ? "Exporting…" : "Export KML"}
          </button>
          {/* ★ New clocking inline and next to Export KML */}
          <button className="btn btn-accent" onClick={() => setCreateOpen(true)}>New clocking</button>
        </div>
        {/* ★ Timesheet button (wire route later) */}
        <div className="flex items-center gap-2">
          <Link to="/timesheet" className="px-3 py-2 border rounded" title="Open Timesheet view">
            Timesheet
          </Link>
        </div>
      </div>

      {/* ===== Filters (compact 1–2 rows) ===== */}
      <div className="card p-4 mt-3">
        <div className="filters-grid items-center">
          <input
            className="border p-2 rounded"
            placeholder="Search notes/type…"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && load()}
          />
          <select className="border p-2 rounded" value={filterProjectId} onChange={e => setFilterProjectId(e.target.value)}>
            <option value="">Project (any)</option>
            {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
          <select className="border p-2 rounded" value={filterUserId} onChange={e => setFilterUserId(e.target.value)}>
            <option value="">User (any)</option>
            {users.map(u => <option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>)}
          </select>
          <select className="border p-2 rounded" value={filterGroupId} onChange={e => setFilterGroupId(e.target.value)}>
            <option value="">Group (any)</option>
            {(groups || []).filter(g => !g?.isDeleted).map(g => <option key={g._id} value={g._id}>{g.name}</option>)}
          </select>
          <select className="border p-2 rounded" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">Type (any)</option>
            {ATTENDANCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <div className="mt-2 flex items-center gap-2">
          <input
             className="!w-48 flex-none border rounded text-sm p-1.5"
             type="date"
             value={from}
             onChange={e => setFrom(e.target.value)}
          />
          <input
             className="!w-48 flex-none border rounded text-sm p-1.5"
             type="date"
             value={to}
             onChange={e => setTo(e.target.value)}
          />
        </div>

        <div className="mt-3 flex items-center justify-start gap-2">
          <button className="btn" onClick={load}>Apply</button>
        </div>
      </div>

      {/* ===== History table ===== */}
      <div className="card mt-3 overflow-x-auto">
        <table className="table text-sm">
          <thead>
            <tr style={{ background: "#f9fafb" }}>
              <th>When</th>
              <th>User</th>
              <th>Group</th> {/* ★ new column */}
              <th>Project</th>
              <th>Type</th>
              <th>Location</th>
              <th>Notes</th>
              <th>Edited</th>
              <th>Edited by</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td className="p-4 text-center" colSpan={10}>Loading…</td></tr>
            ) : rows.length ? (
              rows.map(r => (
                <tr key={r._id}>
                  <td className="border-top p-2">{r.at ? new Date(r.at).toLocaleString() : "—"}</td>
                  <td className="border-top p-2">{r.user?.name || r.user?.email || userName(r.userId)}</td>
                  <td className="border-top p-2">{userGroupNames(r.userId) || "—"}</td> {/* ★ */}
                  <td className="border-top p-2">{r.project?.name || projectName(r.projectId)}</td>
                  <td className="border-top p-2">{r.type || "—"}</td>
                  <td className="border-top p-2">
                    {r.location && (r.location.lat != null && r.location.lng != null)
                      ? `${r.location.lat.toFixed?.(5) ?? r.location.lat}, ${r.location.lng.toFixed?.(5) ?? r.location.lng}` +
                        (r.location.acc != null ? ` (${r.location.acc}m)` : "")
                      : "—"}
                  </td>
                  <td className="border-top p-2">{r.notes || "—"}</td>
                  <td className="border-top p-2">
                    {r.lastEditedAt ? (
                      <div className="flex items-center gap-2">
                        <span>{new Date(r.lastEditedAt).toLocaleString()}</span>
                        <button
                          type="button"
                          className="text-xs px-1.5 py-0.5 border rounded hover:bg-gray-50"
                          title={
                            reasonCache[r._id] && reasonCache[r._id].length
                              ? `Reason: ${reasonCache[r._id]}`
                              : "Hover to load reason"
                          }
                          onMouseEnter={() => preloadReason(r._id)}
                          onFocus={() => preloadReason(r._id)}
                          aria-label="View last edit reason"
                        >
                          ℹ️
                        </button>
                      </div>
                    ) : "—"}
                  </td>
                  <td className="border-top p-2">
                    {r.lastEditedBy?.name || r.lastEditedBy?.email || (r.lastEditedBy ? String(r.lastEditedBy) : "—")}
                  </td>
                  <td className="border-top p-2 text-right whitespace-nowrap">
                    <button className="btn btn-sm mr-2" onClick={() => openAudit(r)}>Audit</button>
                    <button className="btn btn-sm mr-2" onClick={() => openEdit(r)}>Edit</button>
                    <button className="btn btn-sm" onClick={() => del(r._id)}>Delete</button>
                  </td>
                </tr>
              ))
            ) : (
              <tr><td className="p-4 text-center" colSpan={10}>No clockings</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ===== Create Modal (lightbox) ===== */}
      {createOpen && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">New clocking</h3>
              <button className="text-sm underline" onClick={() => setCreateOpen(false)}>Close</button>
            </div>

            <form onSubmit={submitClocking} className="space-y-3">
              {/* Row 1: Mode | Project | Type | Time | Save */}
              <div className="flex items-end justify-between gap-3 flex-wrap">
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-sm">
                    Mode
                    <select className="border p-2 ml-2 rounded" value={isBulk ? "bulk" : "single"} onChange={e => setIsBulk(e.target.value === "bulk")}>
                      <option value="bulk">Bulk (select many)</option>
                      <option value="single">Single user</option>
                    </select>
                  </label>
                  <label className="text-sm">
                    Project
                    <select className="border p-2 ml-2 rounded" value={projectId} onChange={e => setProjectId(e.target.value)}>
                      <option value="">— none —</option>
                      {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
                    </select>
                  </label>
                  <label className="text-sm">
                    Type
                    <select className="border p-2 ml-2 rounded" value={type} onChange={e => setType(e.target.value)}>
                      {ATTENDANCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </label>
                  <label className="text-sm">
                    Time
                    <input className="border p-2 ml-2 rounded" type="datetime-local" value={at} onChange={e => setAt(e.target.value)} />
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <button className="btn btn-accent" type="submit">Save clocking</button>
                </div>
              </div>

              {/* Location + Notes */}
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-sm flex flex-col items-start">
                  <span className="muted mb-1">Optional</span>
                  <button type="button" className="btn" onClick={useMyLocation}>Use my location</button>
                </label>

                <label className="text-sm">
                  Lat
                  <input className="border p-2 ml-2 rounded w-40" value={lat} onChange={e => setLat(e.target.value)} placeholder="e.g. -26.2041" />
                </label>
                <label className="text-sm">
                  Lng
                  <input className="border p-2 ml-2 rounded w-40" value={lng} onChange={e => setLng(e.target.value)} placeholder="e.g. 28.0473" />
                </label>
                <label className="text-sm">
                  Acc (m)
                  <input className="border p-2 ml-2 rounded w-28" value={acc} onChange={e => setAcc(e.target.value)} placeholder="optional" />
                </label>
              </div>

              <label className="block text-sm">
                Notes
                <input className="border p-2 rounded w-full" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional note…" />
              </label>

              {/* User selection — pill toggles */}
              {isBulk ? (
                <div>
                  <div className="text-sm font-medium mb-2">Select users</div>
                  <div className="user-pills">
                    {(type.toLowerCase() === "out" ? eligibleUsersByType : eligibleUsers).map(u => { // ★ restrict on OUT
                      const active = selectedUsers.includes(u._id);
                      return (
                        <button
                          key={u._id}
                          type="button"
                          className={`chip ${active ? "active" : ""}`}
                          onClick={() => toggleUser(u._id)}
                          title={u.name || u.email || u.username}
                          aria-pressed={active}
                        >
                          <span className="name">{u.name || u.email || u.username}</span>
                          {active && <span aria-hidden="true">✓</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <label className="block text-sm">
                  User
                  <select
                    className="border p-2 rounded w-full"
                    value={singleUser}
                    onChange={e => setSingleUser(e.target.value)}
                  >
                    <option value="">— pick a user —</option>
                    {(type.toLowerCase() === "out" ? eligibleUsersByType : eligibleUsers).map(u => ( // ★ restrict on OUT
                      <option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>
                    ))}
                  </select>
                </label>
              )}
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editOpen && editingRow && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Edit clocking</h3>
              <button className="text-sm underline" onClick={closeEdit}>Close</button>
            </div>
            <ClockingEditForm
              clocking={editingRow}
              users={users}
              projects={projects}
              onSaved={async () => {
                closeEdit();
                await load();
                setInfo("Updated.");
                setTimeout(() => setInfo(""), 1200);
              }}
              onCancel={closeEdit}
            />
          </div>
        </div>
      )}

      {/* Audit Modal */}
      {auditOpen && (
        <div className="fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Clocking audit</h3>
              <button className="text-sm underline" onClick={closeAudit}>Close</button>
            </div>

            {auditHeader && (
              <div className="text-sm mb-3 p-2 rounded border bg-gray-50 space-y-1">
                <div><b>ID:</b> {auditHeader._id}</div>
                <div><b>When:</b> {auditHeader.at ? new Date(auditHeader.at).toLocaleString() : "—"}</div>
                <div><b>User:</b> {userName(auditHeader.userId)}</div>
                <div><b>Project:</b> {projectName(auditHeader.projectId)}</div>
                <div><b>Type:</b> {auditHeader.type || "—"}</div>
                {auditHeader.lastEditedAt && (
                  <div>
                    <b>Last edit:</b> {new Date(auditHeader.lastEditedAt).toLocaleString()}{" "}
                    by {auditHeader.lastEditedBy?.name || auditHeader.lastEditedBy?.email || "—"}
                  </div>
                )}
              </div>
            )}

            {auditLoading ? (
              <div className="p-3 text-sm text-gray-600">Loading…</div>
            ) : auditRows.length ? (
              <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
                {auditRows.map((r, idx) => (
                  <div key={idx} className="border rounded p-3">
                    <div className="text-sm space-y-1">
                      <div className="flex flex-wrap gap-3">
                        <span><b>Edited:</b> {r.editedAt ? new Date(r.editedAt).toLocaleString() : "—"}</span>
                        <span><b>By:</b> {r.editedBy?.name || r.editedBy?.email || r.editedBy || "—"}</span>
                      </div>
                      {r.note && (
                        <div>
                          <b>Reason:</b> <span className="italic text-gray-700">{r.note}</span>
                        </div>
                      )}
                    </div>
                    <div className="mt-2">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-gray-50">
                            <th className="p-1 text-left">Field</th>
                            <th className="p-1 text-left">Before</th>
                            <th className="p-1 text-left">After</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(r.changes || []).map((c, i2) => (
                            <tr key={i2}>
                              <td className="border-t p-1 align-top font-mono">{c.field}</td>
                              <td className="border-t p-1 align-top font-mono whitespace-pre-wrap break-words">{fmtVal(c.before)}</td>
                              <td className="border-t p-1 align-top font-mono whitespace-pre-wrap break-words">{fmtVal(c.after)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-3 text-sm text-gray-600">No edits recorded.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
