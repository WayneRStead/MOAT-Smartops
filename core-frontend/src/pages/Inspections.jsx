// core-frontend/src/pages/Inspections.jsx
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import {
  hardDeleteForm,
  hardDeleteSubmission,
  listForms,
  listSubmissions,
  restoreSubmission,
  softDeleteForm,
  softDeleteSubmission,
} from "../lib/inspectionApi";

/* ------------ role normalization to match backend ------------- */
const CANON_ROLES = [
  "user",
  "group-leader",
  "project-manager",
  "manager",
  "admin",
  "superadmin",
];
function normalizeRole(r) {
  if (!r) return "";
  let s = String(r).trim().toLowerCase();
  s = s.replace(/\s+/g, "-");
  if (s === "worker" || s === "member") s = "user";
  if (s === "groupleader") s = "group-leader";
  if (s === "pm") s = "project-manager";
  if (s === "super-admin") s = "superadmin";
  return CANON_ROLES.includes(s) ? s : "";
}
function unique(arr) {
  return Array.from(new Set(arr));
}

/* ---- robust current user (window + JWT fallback) ---- */
function normalizeStr(x) {
  return String(x || "").trim();
}
function getCurrentUserSafe() {
  let u = window.__CURRENT_USER__ || {};
  if (!u || (!u._id && !u.id && !u.userId && !u.email && !u.name)) {
    try {
      const tok = localStorage.getItem("token");
      if (tok && tok.split(".").length === 3) {
        const payload = JSON.parse(atob(tok.split(".")[1] || ""));
        const maybe = payload?.user || payload;
        u = {
          _id: maybe?._id || maybe?.id || maybe?.userId,
          id: maybe?.id,
          userId: maybe?.userId,
          email: maybe?.email,
          name: maybe?.name,
          role: maybe?.role,
          roles: maybe?.roles || [],
        };
      }
    } catch {}
  }
  const raw = []
    .concat(u?.role ? [u.role] : [])
    .concat(Array.isArray(u?.roles) ? u.roles : []);
  const rolesNormalized = unique(raw.map(normalizeRole).filter(Boolean));
  return { ...(u || {}), roles: rolesNormalized };
}
const me = getCurrentUserSafe();

// Allow PM/Manager/Admin/Superadmin to manage submissions
const canAdminSubFrom = (user) =>
  (user?.roles || []).some((r) =>
    ["project-manager", "manager", "admin", "superadmin"].includes(r),
  );

/* ------------ subject + location helpers (display + search + export) ------------- */
function subjectDisplay(sub) {
  const s = sub?.subjectAtRun || {};
  const type = String(s?.type || "none").toLowerCase();
  if (type === "none") return { type: "General", label: "—" };
  const t =
    type === "vehicle"
      ? "Vehicle"
      : type === "asset"
        ? "Asset"
        : type === "performance"
          ? "Performance"
          : type;
  const label = s?.label || s?.id || "—";
  return { type: t, rawType: type, label: String(label) };
}
function pickLocation(sub) {
  const cands = [
    sub?.location,
    sub?.locationAtRun,
    sub?.coords,
    sub?.gps,
    sub?.metadata?.location,
    sub?.subjectAtRun?.location,
  ].filter(Boolean);
  for (const loc of cands) {
    const lat = Number(loc.lat ?? loc.latitude);
    const lng = Number(loc.lng ?? loc.lon ?? loc.longitude);
    const accuracy = Number(loc.accuracy ?? loc.acc);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return {
        lat,
        lng,
        accuracy: Number.isFinite(accuracy) ? accuracy : undefined,
      };
    }
  }
  return null;
}
function locationBadgeText(sub) {
  const loc = pickLocation(sub);
  if (!loc) return "";
  const accTxt = Number.isFinite(loc.accuracy)
    ? ` ±${Math.round(loc.accuracy)}m`
    : "";
  return `${loc.lat.toFixed(6)}, ${loc.lng.toFixed(6)}${accTxt}`;
}

/* ----------------------- simple ZIP (store) to make KMZ ----------------------- */
function crc32(buf) {
  let c = ~0 >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function strToUint8(str) {
  return new TextEncoder().encode(str);
}
function u32(n) {
  const b = new Uint8Array(4);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  b[2] = (n >>> 16) & 0xff;
  b[3] = (n >>> 24) & 0xff;
  return b;
}
function u16(n) {
  const b = new Uint8Array(2);
  b[0] = n & 0xff;
  b[1] = (n >>> 8) & 0xff;
  return b;
}
function concatU8(arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
function makeKmz(kmlString, innerName = "doc.kml") {
  const fileNameBytes = strToUint8(innerName);
  const data = strToUint8(kmlString);
  const sigLocal = strToUint8("PK\u0003\u0004");
  const sigCD = strToUint8("PK\u0001\u0002");
  const sigEnd = strToUint8("PK\u0005\u0006");
  const version = u16(20);
  const flags = u16(0);
  const methodStore = u16(0); // no compression
  const time = u16(0),
    date = u16(0);
  const crc = u32(crc32(data));
  const size = u32(data.length);
  const nameLen = u16(fileNameBytes.length);
  const extraLen = u16(0);
  const commentLen = u16(0);
  const diskNum = u16(0);
  const intAttr = u16(0);
  const extAttr = u32(0);
  const relOffset = u32(0); // placeholder for now

  // Local file header
  const localHeader = concatU8([
    sigLocal,
    version,
    flags,
    methodStore,
    time,
    date,
    crc,
    size,
    size,
    nameLen,
    extraLen,
    fileNameBytes,
  ]);
  const localOffset = 0;
  const afterLocalLen = localHeader.length + data.length;

  // Central directory header
  const cdHeader = concatU8([
    sigCD,
    u16(20),
    version,
    flags,
    methodStore,
    time,
    date,
    crc,
    size,
    size,
    nameLen,
    extraLen,
    commentLen,
    diskNum,
    intAttr,
    extAttr,
    u32(localOffset),
    fileNameBytes,
  ]);

  // End of central directory
  const cdSize = u32(cdHeader.length);
  const cdOffset = u32(afterLocalLen);
  const total = u16(1);
  const end = concatU8([
    sigEnd,
    diskNum,
    diskNum,
    total,
    total,
    cdSize,
    cdOffset,
    commentLen,
  ]);

  const zip = concatU8([localHeader, data, cdHeader, end]);
  return new Blob([zip], { type: "application/vnd.google-earth.kmz" });
}

/* ---------------------------- KML builder for export ---------------------------- */
function xmlEscape(s) {
  return String(s ?? "").replace(/[<>&'"]/g, (ch) =>
    ch === "<"
      ? "&lt;"
      : ch === ">"
        ? "&gt;"
        : ch === "&"
          ? "&amp;"
          : ch === '"'
            ? "&quot;"
            : "&apos;",
  );
}
function buildKml(
  subs,
  { projectNames = {}, taskNames = {}, milestoneNames = {} } = {},
) {
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>MOAT SmartOps – Inspections</name>
  <Style id="pass">
    <IconStyle><color>ff20a35a</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/grn-circle.png</href></Icon></IconStyle>
  </Style>
  <Style id="fail">
    <IconStyle><color>ff1b1b99</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/red-circle.png</href></Icon></IconStyle>
  </Style>
  <Style id="na">
    <IconStyle><color>ff7f7f7f</color><scale>1.1</scale><Icon><href>http://maps.google.com/mapfiles/kml/paddle/wht-circle.png</href></Icon></IconStyle>
  </Style>
`;
  const placemarks = subs
    .map((s) => {
      const loc = pickLocation(s);
      if (!loc) return "";
      const subj = subjectDisplay(s);
      const title = s.formTitle || s.title || "Inspection";

      // IDs
      const projId = s?.links?.projectId;
      const taskId = s?.links?.taskId;
      const mileId = s?.links?.milestoneId;

      // Human names using the maps from component state
      const proj = projId ? projectNames[String(projId)] || String(projId) : "";
      const task = taskId ? taskNames[String(taskId)] || String(taskId) : "";
      const mileKey = taskId && mileId ? `${taskId}:${mileId}` : null;
      const mile =
        mileId && mileKey
          ? milestoneNames[mileKey] || String(mileId)
          : mileId
            ? String(mileId)
            : "";

      // Inspector
      const inspector =
        s?.runBy?.name ||
        s?.runBy?.email ||
        s?.signoff?.name ||
        s?.signoff?.email ||
        "";

      // Outcome / status with fallback from answers
      const answers = Array.isArray(s?.answers) ? s.answers : [];
      const anyFail = answers.some(
        (a) => a?.result === "fail" || a?.pass === false,
      );

      let status = String(s?.overallResult || "").toLowerCase();
      if (!status || status === "na") {
        status = anyFail ? "fail" : "pass";
      }

      // Scope
      const scope = s?.scopeAtRun || s?.scope?.type || "";

      // When
      const createdRaw =
        s?.submittedAt ||
        s?.createdAt ||
        s?.completedAt ||
        s?.finishedAt ||
        s?.updatedAt;
      const dateStr = createdRaw ? new Date(createdRaw).toLocaleString() : "";

      // “Description” / subject text – best-effort
      const descriptionText =
        s?.subjectAtRun?.description ||
        s?.description ||
        s?.summary ||
        s?.note ||
        s?.managerNote ||
        "";

      const descHtml = `
      <![CDATA[
        <div style="font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;font-size:12px">
          <h3 style="margin:0 0 6px 0">${xmlEscape(title)}</h3>
          <table cellpadding="4" cellspacing="0">
            <tr><td><b>Date run</b></td><td>${xmlEscape(dateStr)}</td></tr>
            <tr><td><b>Inspector</b></td><td>${xmlEscape(inspector)}</td></tr>
            <tr><td><b>Project</b></td><td>${xmlEscape(proj)}</td></tr>
            <tr><td><b>Task</b></td><td>${xmlEscape(task)}</td></tr>
            <tr><td><b>Milestone</b></td><td>${xmlEscape(mile)}</td></tr>
            <tr><td><b>Subject</b></td><td>${xmlEscape(subj.type)} – ${xmlEscape(subj.label)}</td></tr>
            <tr><td><b>Status</b></td><td>${xmlEscape(status.toUpperCase())}</td></tr>
            <tr><td><b>Scope</b></td><td>${xmlEscape(String(scope))}</td></tr>
          </table>
        </div>
      ]]>`;

      const styleUrl =
        status === "pass" ? "#pass" : status === "fail" ? "#fail" : "#na";

      // KML uses lon,lat[,alt]
      const lon = loc.lng;
      const lat = loc.lat;
      return `
  <Placemark>
    <name>${xmlEscape(title)}</name>
    <styleUrl>${styleUrl}</styleUrl>
    <description>${descHtml}</description>
    <ExtendedData>
  <Data>
  <Data name="project"><value>${xmlEscape(proj || "")}</value></Data>
  <Data name="task"><value>${xmlEscape(task || "")}</value></Data>
  <Data name="milestone"><value>${xmlEscape(mile || "")}</value></Data>
  <Data name="subjectType"><value>${xmlEscape(subj.rawType || "")}</value></Data>
  <Data name="subjectLabel"><value>${xmlEscape(subj.label)}</value></Data>
  <Data name="description"><value>${xmlEscape(descriptionText)}</value></Data>
  <Data name="inspector"><value>${xmlEscape(inspector || "")}</value></Data>
  <Data name="dateRun"><value>${xmlEscape(dateStr || "")}</value></Data>
  <Data name="outcome"><value>${xmlEscape(status)}</value></Data>
</ExtendedData>
    <Point><coordinates>${lon},${lat},0</coordinates></Point>
  </Placemark>`;
    })
    .filter(Boolean)
    .join("\n");

  const footer = `
</Document>
</kml>`;
  return header + placemarks + footer;
}

/* ------------------------------- Component ------------------------------- */
export default function Inspections() {
  const [tab, setTab] = useState("submitted"); // "submitted" | "forms"
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [mineOnly, setMineOnly] = useState(false);
  const [showDeletedSubs, setShowDeletedSubs] = useState(false);
  const [showDeletedForms, setShowDeletedForms] = useState(false);

  // Pagination (submitted list)
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // Submitted inspections
  const [subs, setSubs] = useState([]);
  const [loadingSubs, setLoadingSubs] = useState(true);
  const [errSubs, setErrSubs] = useState("");

  // Available forms
  const [forms, setForms] = useState([]);
  const [loadingForms, setLoadingForms] = useState(true);
  const [errForms, setErrForms] = useState("");

  // Human names for IDs
  const [projectNames, setProjectNames] = useState({});
  const [taskNames, setTaskNames] = useState({});
  const [milestoneNames, setMilestoneNames] = useState({}); // key = `${taskId}:${milestoneId}`

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [q]);

  // Reset pagination when filters/search change
  useEffect(() => {
    setPage(1);
  }, [qDeb, mineOnly, showDeletedSubs]); // FIX: include showDeletedSubs so pages reset when toggling deleted

  // Load submissions (always include deleted; filter client-side)
  async function loadSubs() {
    setErrSubs("");
    setLoadingSubs(true);
    try {
      // FIX: always include deleted from server, then filter by toggle on client
      const rows = await listSubmissions({ limit: 400, includeDeleted: true });
      setSubs(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setSubs([]);
      setErrSubs(
        e?.response?.data?.error || e?.message || "Failed to load submissions",
      );
    } finally {
      setLoadingSubs(false);
    }
  }
  useEffect(() => {
    loadSubs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showDeletedSubs]); // keep reload on toggle (ok even if we fetch all)

  // Load forms (always include deleted; filter client-side)
  async function loadForms() {
    setErrForms("");
    setLoadingForms(true);
    try {
      // FIX: always include deleted from server, then filter by toggle on client
      const rows = await listForms({ includeDeleted: true });
      setForms(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setForms([]);
      setErrForms(
        e?.response?.data?.error || e?.message || "Failed to load forms",
      );
    } finally {
      setLoadingForms(false);
    }
  }
  useEffect(() => {
    loadForms();
  }, [showDeletedForms]); // FIX: reload on toggle to keep behavior consistent

  // ----- Backfill human names for IDs -----
  useEffect(() => {
    const wantProjects = new Set();
    const wantTasks = new Set();
    const wantMilestones = new Set(); // taskId:milestoneId

    for (const s of subs || []) {
      if (s?.links?.projectId) wantProjects.add(String(s.links.projectId));
      if (s?.links?.taskId) wantTasks.add(String(s.links.taskId));
      if (s?.links?.taskId && s?.links?.milestoneId) {
        wantMilestones.add(`${s.links.taskId}:${s.links.milestoneId}`);
      }
    }
    for (const f of forms || []) {
      const sc = f?.scope || {};
      if (sc.projectId && !sc.projectName)
        wantProjects.add(String(sc.projectId));
      if (sc.taskId && !sc.taskName) wantTasks.add(String(sc.taskId));
      if (sc.taskId && sc.milestoneId && !sc.milestoneName) {
        wantMilestones.add(`${sc.taskId}:${sc.milestoneId}`);
      }
    }

    (async () => {
      const missing = [...wantProjects].filter((id) => !projectNames[id]);
      if (!missing.length) return;
      const next = {};
      const chunks = chunk(missing, 6);
      for (const group of chunks) {
        await Promise.all(
          group.map(async (id) => {
            try {
              const { data } = await api.get(`/projects/${id}`);
              next[id] = labelOf(data) || id;
            } catch {
              next[id] = id;
            }
          }),
        );
      }
      if (Object.keys(next).length)
        setProjectNames((prev) => ({ ...prev, ...next }));
    })();

    (async () => {
      const missing = [...wantTasks].filter((id) => !taskNames[id]);
      if (!missing.length) return;
      const next = {};
      const chunks = chunk(missing, 6);
      for (const group of chunks) {
        await Promise.all(
          group.map(async (id) => {
            try {
              const { data } = await api.get(`/tasks/${id}`);
              next[id] = labelOf(data) || id;
            } catch {
              next[id] = id;
            }
          }),
        );
      }
      if (Object.keys(next).length)
        setTaskNames((prev) => ({ ...prev, ...next }));
    })();

    (async () => {
      const missingPairs = [...wantMilestones].filter(
        (k) => !milestoneNames[k],
      );
      if (!missingPairs.length) return;
      const byTask = new Map();
      for (const key of missingPairs) {
        const [taskId, milestoneId] = key.split(":");
        if (!byTask.has(taskId)) byTask.set(taskId, new Set());
        byTask.get(taskId).add(milestoneId);
      }
      const next = {};
      const tasksToFetch = [...byTask.keys()];
      const chunks = chunk(tasksToFetch, 4);
      for (const group of chunks) {
        await Promise.all(
          group.map(async (taskId) => {
            try {
              const { data } = await api.get(`/tasks/${taskId}/milestones`);
              const arr = Array.isArray(data) ? data : [];
              const wanted = byTask.get(taskId) || new Set();
              for (const mId of wanted) {
                const found = arr.find(
                  (m) => String(m._id || m.id) === String(mId),
                );
                next[`${taskId}:${mId}`] = labelOf(found) || mId;
              }
            } catch {
              for (const mId of byTask.get(taskId) || []) {
                next[`${taskId}:${mId}`] = mId;
              }
            }
          }),
        );
      }
      if (Object.keys(next).length)
        setMilestoneNames((prev) => ({ ...prev, ...next }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subs, forms]);

  /* ===== Helpers for readable rows ===== */
  function labelOf(x) {
    return x?.name || x?.title || x?.label || "";
  }
  function idToName(id, map) {
    if (!id) return "";
    return map[String(id)] || String(id);
  }
  function humanProject(id) {
    if (!id) return "—";
    return projectNames[String(id)] || String(id);
  }
  function humanTask(id) {
    if (!id) return "—";
    return taskNames[String(id)] || String(id);
  }
  function humanMilestone(taskId, milestoneId) {
    if (!milestoneId) return "—";
    if (!taskId) return String(milestoneId);
    return milestoneNames[`${taskId}:${milestoneId}`] || String(milestoneId);
  }
  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  /* ---- upgraded MineOnly matcher: id/email/name + signoff name ---- */
  function isMine(sub) {
    const ru = sub?.runBy || {};
    const meId = normalizeStr(me._id || me.id || me.userId);
    const ruId = normalizeStr(ru._id || ru.id || ru.userId);
    if (meId && ruId && meId === ruId) return true;

    const meEmail = normalizeStr(me.email).toLowerCase();
    const ruEmail = normalizeStr(ru.email).toLowerCase();
    if (meEmail && ruEmail && meEmail === ruEmail) return true;

    const meName = normalizeStr(me.name).toLowerCase();
    const ruName = normalizeStr(ru.name).toLowerCase();
    if (meName && ruName && meName === ruName) return true;

    const signName = normalizeStr(sub?.signoff?.name).toLowerCase();
    if (meName && signName && meName === signName) return true;

    return false;
  }

  /* ===== Submitted: filter + sort + pagination ===== */
  const submittedFiltered = useMemo(() => {
    const needle = qDeb;
    const rows = (subs || [])
      .map((s) => {
        const proj = humanProject(s?.links?.projectId);
        const task = humanTask(s?.links?.taskId);
        const mile = humanMilestone(s?.links?.taskId, s?.links?.milestoneId);
        const inspector = s?.runBy?.name || s?.signoff?.name || "—";
        const date = s?.createdAt ? new Date(s.createdAt) : null;
        const dateStr = date ? date.toLocaleString() : "—";
        const scope = s?.scopeAtRun || s?.scope?.type || "global";
        const type = s?.formType || "standard";
        const title = s?.formTitle || "Form";
        const status = (s?.overallResult || "pass").toLowerCase();
        const isDeleted = !!s?.isDeleted;
        const subj = subjectDisplay(s);
        const locTxt = locationBadgeText(s) || "";

        const searchable =
          `${title} ${type} ${scope} ${proj} ${task} ${mile} ${inspector} ${dateStr} ${status} ${
            isDeleted ? "deleted" : ""
          } ${subj.type} ${subj.label} ${locTxt}`.toLowerCase();
        const matchesSearch = !needle || searchable.includes(needle);
        const matchesMine = !mineOnly || isMine(s);
        const matchesDeleted = showDeletedSubs || !isDeleted; // FIX: hide deleted unless toggle is on

        if (!matchesSearch || !matchesMine || !matchesDeleted) return null;

        return {
          _id: s._id,
          raw: s,
          title,
          type,
          scope,
          project: proj,
          task,
          milestone: mile,
          inspector,
          createdAt: date?.getTime() || 0,
          dateStr,
          status,
          isDeleted,
          subjectType: subj.type,
          subjectLabel: subj.label,
          locationText: locTxt,
        };
      })
      .filter(Boolean);

    rows.sort((a, b) => b.createdAt - a.createdAt);
    return rows;
  }, [
    subs,
    qDeb,
    mineOnly,
    projectNames,
    taskNames,
    milestoneNames,
    showDeletedSubs,
  ]); // FIX: depend on showDeletedSubs

  const submittedPage = useMemo(() => {
    const start = (page - 1) * pageSize;
    return submittedFiltered.slice(start, start + pageSize);
  }, [submittedFiltered, page, pageSize]);

  const totalSubmitted = submittedFiltered.length;
  const pageCount = Math.max(1, Math.ceil(totalSubmitted / pageSize));
  const startIndex = totalSubmitted ? (page - 1) * pageSize + 1 : 0;
  const endIndex = Math.min(totalSubmitted, page * pageSize);

  // For KMZ export, use ALL filtered rows (ignore pagination) but only those with coords
  const filteredWithCoords = useMemo(
    () => submittedFiltered.map((r) => r.raw).filter((s) => !!pickLocation(s)),
    [submittedFiltered],
  );

  /* ===== Available forms (search only) ===== */
  const formRows = useMemo(() => {
    const needle = qDeb;
    const rows = (forms || [])
      .map((f) => {
        const scope = f?.scope?.type || "global";
        const type = f?.formType || "standard";
        const title = f?.title || "Form";
        const proj =
          f?.scope?.projectName || idToName(f?.scope?.projectId, projectNames);
        const task =
          f?.scope?.taskName || idToName(f?.scope?.taskId, taskNames);
        const mile =
          f?.scope?.milestoneName ||
          (f?.scope?.taskId && f?.scope?.milestoneId
            ? milestoneNames[`${f.scope.taskId}:${f.scope.milestoneId}`]
            : "");

        const isDeleted = !!f.isDeleted; // FIX: inspect deletion
        if (!showDeletedForms && isDeleted) return null; // FIX: hide unless toggled

        const searchable =
          `${title} ${type} ${scope} ${proj} ${task} ${mile}`.toLowerCase();
        const match = !needle || searchable.includes(needle);
        if (!match) return null;

        return {
          _id: f._id,
          title,
          type,
          scope,
          project: proj || "—",
          task: task || "—",
          milestone: mile || "—",
          isDeleted,
          updatedAt: f?.updatedAt ? new Date(f.updatedAt).getTime() : 0,
        };
      })
      .filter(Boolean);

    rows.sort((a, b) => b.updatedAt - a.updatedAt);
    return rows;
  }, [forms, qDeb, projectNames, taskNames, milestoneNames, showDeletedForms]); // FIX: depend on showDeletedForms

  // Submission actions
  async function onSoftDeleteSub(id) {
    if (!confirm("Soft delete this submission?")) return;
    try {
      await softDeleteSubmission(id);
      await loadSubs();
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || "Soft delete failed");
    }
  }
  async function onRestoreSub(id) {
    try {
      await restoreSubmission(id);
      await loadSubs();
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || "Restore failed");
    }
  }
  async function onHardDeleteSub(id) {
    if (!confirm("This will permanently delete the submission. Continue?"))
      return;
    try {
      await hardDeleteSubmission(id);
      await loadSubs();
    } catch (e) {
      alert(e?.response?.data?.error || e?.message || "Hard delete failed");
    }
  }

  const canAdminSub = canAdminSubFrom(me);
  const isAdmin =
    (me.roles || []).includes("admin") ||
    (me.roles || []).includes("superadmin");

  function exportKmz() {
    // Prefer filtered rows (respect search/mineOnly), but if none,
    // fall back to ALL submissions that have coordinates.
    const preferred = filteredWithCoords;
    const allWithCoords = (subs || []).filter((s) => !!pickLocation(s));
    const exportSet = preferred.length ? preferred : allWithCoords;

    if (!exportSet.length) {
      alert("No inspections with coordinates found to export.");
      return;
    }

    const kml = buildKml(exportSet);

    // Debug: uncomment if you want to see the KML in console
    // console.log("Inspection KMZ KML:\n", kml);

    const blob = makeKmz(kml, "inspections.kml");
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    a.download = `inspections-${stamp}.kmz`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="max-w-7xl mx-auto p-4">
      {/* Local chip + loc pill styles */}
      <style>{`
        :root{--border:#e5e7eb}
        .chip{display:inline-flex;align-items:center;padding:.25rem .5rem;border-radius:9999px;font-weight:600;border:1px solid #e5e7eb}
        .chip-pass{background:#ecfdf5;border-color:#10b981;color:#065f46}
        .chip-fail{background:#fef2f2;border-color:#ef4444;color:#7f1d1d}
        .chip-na{background:#f3f4f6;border-color:#9ca3af;color:#374151}
        .loc-pill{display:inline-flex;align-items:center;font-size:12px;border:1px solid var(--border);padding:2px 6px;border-radius:9999px;color:#374151;background:#f9fafb}
      `}</style>

      {/* Title row */}
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Inspections</h1>

        {/* Export KMZ (filtered) */}
        {tab === "submitted" && (
          <div className="flex items-center gap-2">
            <button
              className="btn btn-sm"
              disabled={!filteredWithCoords.length}
              onClick={exportKmz}
              title={
                filteredWithCoords.length
                  ? "Export the filtered list to KMZ"
                  : "Nothing to export (no coordinates in filtered set)"
              }
            >
              Export KMZ ({filteredWithCoords.length})
            </button>
          </div>
        )}
      </div>

      {/* Controls row */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          className="input input-bordered"
          style={{ minWidth: 280 }}
          placeholder="Search title, type, scope, project, task, milestone, inspector, subject, location…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        {/* Segmented buttons */}
        <div className="inline-flex rounded overflow-hidden">
          <button
            className={`px-3 py-2 border ${tab === "submitted" && !mineOnly ? "bg-black text-white border-black" : "bg-white"}`}
            onClick={() => {
              setTab("submitted");
              setMineOnly(false);
            }}
          >
            Submitted
          </button>
          <button
            className={`px-3 py-2 border -ml-px ${tab === "forms" ? "bg-black text-white border-black" : "bg-white"}`}
            onClick={() => setTab("forms")}
          >
            Available Forms
          </button>
          <button
            className={`px-3 py-2 border -ml-px ${tab === "submitted" && mineOnly ? "bg-black text-white border-black" : "bg-white"}`}
            onClick={() => {
              setMineOnly((v) => {
                const next = !v;
                if (tab !== "submitted") setTab("submitted");
                return next;
              });
            }}
            aria-pressed={mineOnly}
            title="Show only inspections I ran"
          >
            Mine Only
          </button>
        </div>

        {/* Show deleted toggle (submissions view) */}
        {tab === "submitted" && (
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={showDeletedSubs}
              onChange={(e) => setShowDeletedSubs(e.target.checked)}
            />
            Show deleted
          </label>
        )}

        {/* Right-side utilities for Forms */}
        {tab === "forms" && (
          <div className="ml-auto flex items-center gap-3">
            <label className="text-sm flex items-center gap-2">
              <input
                type="checkbox"
                checked={showDeletedForms}
                onChange={(e) => setShowDeletedForms(e.target.checked)}
              />
              Show deleted
            </label>
            {isAdmin ? (
              <Link to="/admin/inspection/forms" className="btn btn-sm">
                Manage Forms
              </Link>
            ) : null}
          </div>
        )}
      </div>

      {/* ===== Submitted Inspections ===== */}
      {tab === "submitted" && (
        <div className="mt-3">
          {errSubs && <div className="text-red-600 mb-2">{errSubs}</div>}
          <div className="overflow-x-auto rounded-xl border">
            <table className="table w-full">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Scope</th>
                  <th>Project</th>
                  <th>Task</th>
                  <th>Milestone</th>
                  <th>Subject</th>
                  <th>Inspector</th>
                  <th>Date Submitted</th>
                  <th>Status</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loadingSubs ? (
                  <tr>
                    <td colSpan={11} className="p-4">
                      Loading…
                    </td>
                  </tr>
                ) : submittedPage.length ? (
                  submittedPage.map((r) => (
                    <tr key={r._id} className={r.isDeleted ? "opacity-70" : ""}>
                      <td>
                        <div className="flex items-center gap-2">
                          <span>{r.title}</span>
                          {r.isDeleted && (
                            <span className="px-2 py-0.5 rounded-full text-xs border bg-amber-50 text-amber-800 border-amber-200">
                              deleted
                            </span>
                          )}
                          {r.locationText ? (
                            <span
                              className="loc-pill"
                              title={r.locationText}
                              aria-label={`Location ${r.locationText}`}
                            >
                              📍
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="capitalize">{r.type}</td>
                      <td className="capitalize">{r.scope}</td>
                      <td>{r.project || "—"}</td>
                      <td>{r.task || "—"}</td>
                      <td>{r.milestone || "—"}</td>
                      <td>
                        <div className="text-xs">
                          <div className="font-medium">{r.subjectType}</div>
                          <div
                            className="text-gray-600 truncate max-w-[180px]"
                            title={r.subjectLabel}
                          >
                            {r.subjectLabel || "—"}
                          </div>
                        </div>
                      </td>
                      <td>{r.inspector || "—"}</td>
                      <td>{r.dateStr}</td>
                      <td>
                        <span
                          className={`chip ${
                            r.status === "pass"
                              ? "chip-pass"
                              : r.status === "fail"
                                ? "chip-fail"
                                : "chip-na"
                          }`}
                        >
                          {r.status.toUpperCase()}
                        </span>
                      </td>
                      <td className="text-right">
                        <div className="inline-flex gap-2">
                          <Link
                            to={`/inspections/${r._id}`}
                            className="btn btn-sm"
                          >
                            View
                          </Link>
                          {canAdminSub && !r.isDeleted && (
                            <button
                              className="btn btn-sm"
                              onClick={() => onSoftDeleteSub(r._id)}
                            >
                              Delete
                            </button>
                          )}
                          {canAdminSub && r.isDeleted && (
                            <>
                              <button
                                className="btn btn-sm"
                                onClick={() => onRestoreSub(r._id)}
                              >
                                Restore
                              </button>
                              <button
                                className="btn btn-sm btn-error"
                                onClick={() => onHardDeleteSub(r._id)}
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={11} className="p-4 text-gray-600">
                      {mineOnly
                        ? "No submissions found for you."
                        : "No submissions found."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination controls */}
          <div className="mt-3 flex items-center justify-between flex-wrap gap-3">
            <div className="text-sm">
              Showing {startIndex}-{endIndex} of {totalSubmitted}
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm">Rows per page</label>
              <select
                className="select select-bordered"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(parseInt(e.target.value, 10));
                  setPage(1);
                }}
              >
                {[10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Prev
              </button>
              <div className="text-sm">
                Page {page} / {pageCount}
              </div>
              <button
                className="btn btn-sm"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ===== Available Forms ===== */}
      {tab === "forms" && (
        <div className="mt-3">
          <div className="mb-2 flex items-center justify-between">
            {errForms && <div className="text-red-600">{errForms}</div>}
          </div>
          <div className="overflow-x-auto rounded-xl border">
            <table className="table w-full">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Scope</th>
                  <th>Project</th>
                  <th>Task</th>
                  <th>Milestone</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loadingForms ? (
                  <tr>
                    <td colSpan={7} className="p-4">
                      Loading…
                    </td>
                  </tr>
                ) : formRows.length ? (
                  formRows.map((f) => (
                    <tr key={f._id} className={f.isDeleted ? "opacity-60" : ""}>
                      <td>
                        <div className="flex items-center gap-2">
                          <span>{f.title}</span>
                          {f.isDeleted && (
                            <span className="px-2 py-0.5 rounded-full text-xs border bg-amber-50 text-amber-800 border-amber-200">
                              deleted
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="capitalize">{f.type}</td>
                      <td className="capitalize">{f.scope}</td>
                      <td>{f.project}</td>
                      <td>{f.task}</td>
                      <td>{f.milestone}</td>
                      <td className="text-right">
                        <div className="inline-flex gap-2">
                          <Link
                            to={`/inspections/run/${f._id}`}
                            className="btn btn-sm"
                          >
                            Run
                          </Link>
                          {isAdmin ? (
                            <>
                              {!f.isDeleted && (
                                <button
                                  className="btn btn-sm"
                                  onClick={async () => {
                                    if (!confirm("Delete this form?")) return;
                                    await softDeleteForm(f._id);
                                    await loadForms();
                                  }}
                                >
                                  Delete
                                </button>
                              )}
                              {f.isDeleted && (
                                <button
                                  className="btn btn-sm btn-error"
                                  onClick={async () => {
                                    if (!confirm("Hard delete permanently?"))
                                      return;
                                    await hardDeleteForm(f._id);
                                    await loadForms();
                                  }}
                                >
                                  Delete
                                </button>
                              )}
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7} className="p-4 text-gray-600">
                      No forms found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
