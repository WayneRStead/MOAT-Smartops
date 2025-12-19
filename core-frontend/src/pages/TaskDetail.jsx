// src/pages/TaskDetail.jsx  (Part 1/3)
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import GroupSelect from "../components/GroupSelect.jsx";
import MilestonesBlock from "../components/MilestonesBlock.jsx";
import { api } from "../lib/api";

/* ===========================
   Constants / helpers
=========================== */
const PRIORITIES = ["low", "medium", "high", "urgent"];
const MS_STATUSES = ["pending", "started", "paused", "paused - problem", "finished"];

function toLocalDateInputValue(date) {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}
function toLocalDateOnly(date) {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 10);
}
function fromLocalDateTimeInput(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function fromLocalDateOnly(s) {
  if (!s) return null;
  const d = new Date(`${s}T00:00:00`);
  return isNaN(d.getTime()) ? null : d.toISOString();
}
function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* label/status helpers */
function canonStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (["finished","complete","completed","closed","done"].includes(s)) return "finished";
  if (["paused - problem","paused-problem","problem","blocked","block","issue"].includes(s)) return "paused - problem";
  if (["paused","pause","on hold","on-hold","hold"].includes(s)) return "paused";
  if (["started","start","in-progress","in progress","open","active","running"].includes(s)) return "started";
  return "pending";
}

/* paths */
function apiBaseOrigin() {
  const base = api?.defaults?.baseURL || "";
  return base.replace(/\/api\/?$/i, "");
}
function toAbsoluteUrl(u) {
  if (!u) return "";
  let url = String(u);
  if (url.startsWith("/files/docs/")) url = url.replace(/^\/files\/docs\//, "/documents/");
  if (url.startsWith("/files/vault/")) url = url.replace(/^\/files\/vault\//, "/documents/");
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/")) return apiBaseOrigin() + url;
  return url;
}

/* ---- KML/KMZ export ---- */
const PREC = 6;
const r6 = (n) => Number.parseFloat(Number(n).toFixed(PREC));
function closeRing(coords) {
  if (!coords?.length) return coords || [];
  const first = coords[0]; const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) return [...coords, first];
  return coords;
}
function circleToRing(center, radiusMeters, steps = 64) {
  const lat = Number(center.lat); const lng = Number(center.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusMeters)) return [];
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const dLat = radiusMeters / mPerDegLat;
  const dLngBase = radiusMeters / (mPerDegLng || 1e-9);
  const ring = [];
  for (let i = 0; i < steps; i++) {
    const theta = (i / steps) * Math.PI * 2;
    ring.push([r6(lng + dLngBase * Math.cos(theta)), r6(lat + dLat * Math.sin(theta))]);
  }
  return closeRing(ring);
}
function fenceToRings(f) {
  if (!f) return [];
  if (f.type === "polygon" && Array.isArray(f.polygon) && f.polygon.length >= 3) {
    const ring = closeRing(f.polygon.map(([lng, lat]) => [r6(lng), r6(lat)]));
    return [ring];
  }
  if (f.type === "circle" && f.center && f.radius != null) return [circleToRing(f.center, Number(f.radius) || 0, 72)];
  if (f.type === "point" && f.point) return [circleToRing({ lat: f.point.lat, lng: f.point.lng }, 10, 32)];
  return [];
}
function fencesToKML(name, fences) {
  const title = escapeXml(name || "Fences");
  let placemarks = "";
  (fences || []).forEach((f, idx) => {
    const rings = fenceToRings(f);
    if (!rings.length) return;
    const coords = rings[0].map(([lng, lat]) => `${lng},${lat},0`).join(" ");
    placemarks += `
<Placemark>
  <name>${escapeXml(`Fence ${idx + 1}`)}</name>
  <Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates></LinearRing></outerBoundaryIs></Polygon>
</Placemark>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document><name>${title}</name>${placemarks}</Document>
</kml>`;
}
async function downloadKMZ(filename, kmlString) {
  try {
    // Primary path: zip KML as KMZ
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("doc.kml", kmlString);

    const blob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    // Safety net: if JSZip/module fails, fall back to plain KML download
    console.error("KMZ export failed, falling back to KML:", err);

    const fallbackName = filename.replace(/\.kmz$/i, ".kml");
    const blob = new Blob([kmlString], {
      type: "application/vnd.google-earth.kml+xml;charset=utf-8",
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fallbackName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

/** Lazy map wrapper */
function SafeGeoFencePreview(props) {
  const [Loaded, setLoaded] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let mounted = true;
    import("../components/GeoFencePreview")
      .then((m) => mounted && setLoaded(() => m.default))
      .catch(() => mounted && setErr("Map preview unavailable (leaflet not installed)."));
    return () => { mounted = false; };
  }, []);
  if (err) return <div className="flex items-center justify-center rounded text-sm text-gray-600" style={{height: props.height || 320}}>{err}</div>;
  if (!Loaded) return <div className="flex items-center justify-center bg-gray-100 rounded text-sm text-gray-600" style={{height: props.height || 320}}>Loading map…</div>;
  const C = Loaded;
  return <C {...props} />;
}

/* -------- Normalize task -------- */
function idOf(x) {
  if (!x) return "";
  if (typeof x === "string") return x;
  return String(x._id || x.id || "");
}
function normalizeTask(t) {
  if (!t) return t;
  const _id = t._id || t.id;
  const title = t.title ?? t.name ?? "";
  const dueAt = t.dueAt ?? t.dueDate ?? t.deadlineAt ?? null;
  const firstStartFromLog =
    Array.isArray(t?.actualDurationLog)
      ? (t.actualDurationLog
          .filter(e => ["start","resume"].includes(String(e.action)))
          .map(e => e.at)
          .sort()[0] || null)
      : null;
  const startDate = t.startDate ?? t.startAt ?? firstStartFromLog ?? null;

  let assignee = t.assignee ?? null;
  const assignedTo = Array.isArray(t.assignedTo) ? t.assignedTo : null;
  const assignedUserIds = Array.isArray(t.assignedUserIds) ? t.assignedUserIds : null;
  if (!assignee) {
    if (assignedTo?.length) assignee = assignedTo[0];
    else if (assignedUserIds?.length) assignee = assignedUserIds[0];
  }

  const assignedGroupIds = Array.isArray(t.assignedGroupIds) ? t.assignedGroupIds.map(idOf) : [];
  const groupId = t.groupId ?? (assignedGroupIds.length ? assignedGroupIds[0] : null);
  const normUserIds =
    assignedUserIds?.map(idOf) ??
    (assignedTo ? assignedTo.map(idOf) : []);

  return {
    ...t,
    _id,
    title,
    dueAt,
    startDate,
    assignee,
    assignedUserIds: normUserIds,
    assignedGroupIds,
    groupId,
    projectId: t.projectId ?? idOf(t.project),
  };
}

/* --------- Milestone normalizer ---------- */
function normMilestone(ms) {
  const id = String(ms._id || ms.id || "");
  const title = ms.title || ms.name || "";
  const startAt =
    ms.startPlanned || ms.startAt || ms.startDate || ms.scheduledAt || ms.beginAt || ms.start || null;
  const dueAt =
    ms.endPlanned || ms.dueAt || ms.endAt || ms.endDate || ms.targetAt || ms.targetDate || ms.date || null;
  const status = canonStatus(ms.status || (ms.completed ? "finished" : "pending"));
  const isRoadblock = !!(ms.isRoadblock ?? ms.roadblock ?? ms.is_blocker ?? false);
  const dependsOn = ms.dependsOn || ms.roadblockDependency || null;
  const actualEndAt = ms.endActual ?? ms.actualEndAt ?? ms.completedAt ?? null;
  return { ...ms, _id: id, id, title, startAt, dueAt, status, isRoadblock, dependsOn, actualEndAt };
}

/* -------------- API helpers --------------- */
async function sendTaskUpdate(id, patch, prefer = "put") {
  try {
    return prefer === "put"
      ? await api.put(`/tasks/${id}`, patch)
      : await api.patch(`/tasks/${id}`, patch);
  } catch (e) {
    const st = e?.response?.status;
    if (st === 405 || st === 501) {
      return prefer === "put"
        ? await api.patch(`/tasks/${id}`, patch)
        : await api.put(`/tasks/${id}`, patch);
    }
    throw e;
  }
}

/* -------- Manager Notes helpers ---------- */
async function fetchManagerNotes(taskId, fallbackFromTask = []) {
  try {
    const { data } = await api.get(`/tasks/${taskId}/manager-notes`, {
      params: { _ts: Date.now() },
    });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    const st = e?.response?.status;
    if (st === 404 || st === 405) {
      return Array.isArray(fallbackFromTask) ? fallbackFromTask : [];
    }
    throw e;
  }
}

/* ============= Small UI bits ============= */
function Modal({ open, title, onClose, children, footer, size="lg" }) {
  if (!open) return null;
  const maxW = size === "sm" ? "max-w-md" : size === "lg" ? "max-w-3xl" : "max-w-5xl";
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className={`relative z-10 w-full ${maxW} rounded-2xl border bg-white shadow-xl`}>
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="text-lg font-semibold">{title}</div>
          <button className="text-sm underline" onClick={onClose}>Close</button>
        </div>
        <div className="p-4 space-y-3 max-h-[78vh] overflow-auto">{children}</div>
        {footer && <div className="px-4 py-3 border-t flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/* ===================== Component ===================== */
export default function TaskDetail({ id: propId, onClose }) {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const id = propId ?? routeId;

  // Core lookups / data
  const [task, setTask] = useState(null);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);

  // UI state
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [saving, setSaving] = useState(false);
  const lastGoodTaskRef = useRef(null);
  const saveGateRef = useRef({ assignee: false, start: false, due: false });

  // PRINT container ref
  const printRef = useRef(null);

  // Global date filter (affects inspections + activity + milestone table render)
  const [fltFrom, setFltFrom] = useState(""); // YYYY-MM-DD
  const [fltTo, setFltTo] = useState("");

  // Overview inline-edit state (mirrors task)
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("medium");
  const [startOn, setStartOn] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [projectId, setProjectId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [assignee, setAssignee] = useState("");
  const [tags, setTags] = useState("");
  const [description, setDescription] = useState("");

  // Map / geofence
  const [enforceLocationCheck, setEnforceLocationCheck] = useState(false);
  const [enforceQRScan, setEnforceQRScan] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [radius, setRadius] = useState("");
  const [gfCount, setGfCount] = useState(0);
  const [gfSource, setGfSource] = useState("none");
  const [taskFenceApi, setTaskFenceApi] = useState("unknown");
  const [mapBump, setMapBump] = useState(0);
  const [dlProject, setDlProject] = useState([]);
  const [dlTask, setDlTask] = useState([]);
  const [showPin, setShowPin] = useState(true);
  const [showTaskGeofence, setShowTaskGeofence] = useState(true);

  // Exporting state (kmz only)
  const [exporting, setExporting] = useState(null);

  // Milestones
  const [milestones, setMilestones] = useState([]);
  const [mErr, setMErr] = useState("");
  const [mInfo, setMInfo] = useState("");
  const [mReloadKey, setMReloadKey] = useState(0);
  const [msModalOpen, setMsModalOpen] = useState(false);
  const [msForm, setMsForm] = useState({ title: "", startAt: "", endAt: "", status: "pending", isRoadblock: false });

  // Inspections
  const [forms, setForms] = useState([]);
  const [formsErr, setFormsErr] = useState([]);
  const [subs, setSubs] = useState([]);
  const [subsErr, setSubsErr] = useState("");
  const [subViewOpen, setSubViewOpen] = useState(false);
  const [subView, setSubView] = useState(null);
  const [subViewErr, setSubViewErr] = useState("");
  const [subViewPreferHtml, setSubViewPreferHtml] = useState(true); // (kept for future)
  const [mgrNoteBySubId, setMgrNoteBySubId] = useState(new Map());

  // Activity
  const [logOpen, setLogOpen] = useState(false);
  const [logType, setLogType] = useState("productivity"); // 'productivity' | 'attachment'
  const [logAction, setLogAction] = useState("start");
  const [logAt, setLogAt] = useState(toLocalDateInputValue(new Date()));
  const [logNote, setLogNote] = useState("");
  const [logFile, setLogFile] = useState(null);
  const [logErr, setLogErr] = useState("");
  const [logMilestoneId, setLogMilestoneId] = useState("");

  // NEW: Activity sorting + edit binding
  const [activitySort, setActivitySort] = useState("desc"); // 'desc' newest first | 'asc'
  const [editingLogId, setEditingLogId] = useState(null);   // null => add, else edit

  // Image lightbox
  const [imgOpen, setImgOpen] = useState(false);
  const [imgSrc, setImgSrc] = useState("");
  const [imgCaption, setImgCaption] = useState("");

  // Manager status+notes
  const [mgrStatus, setMgrStatus] = useState("pending");
  const [mgrNote, setMgrNote] = useState("");
  const [managerNotes, setManagerNotes] = useState([]);

  const usersById = useMemo(() => {
    const m = new Map(); users.forEach(u => m.set(String(u._id), u)); return m;
  }, [users]);
  const userLabel = (u) => {
    if (!u) return "—";
    const idStr = String(u._id || u);
    const populated = (u && (u.name || u.email)) ? u : usersById.get(idStr);
    return populated ? (populated.name || populated.email || populated.username || idStr) : idStr;
  };
  const projectLabel = (pid) => {
    const p = projects.find(pr => String(pr._id) === String(pid));
    return p?.name || "—";
  };
  const groupsById = useMemo(() => {
    const m = new Map(); groups.forEach(g => m.set(String(g._id), g)); return m;
  }, [groups]);

  /* ---------- load lookups ---------- */
  useEffect(() => {
    (async () => {
      try {
        const [p, u, g] = await Promise.all([
          api.get("/projects", { params: { limit: 1000 } }),
          api.get("/users",    { params: { limit: 1000 } }),
          api.get("/groups",   { params: { limit: 1000 } }),
        ]);
        setProjects(Array.isArray(p.data) ? p.data : []);
        setUsers(Array.isArray(u.data) ? u.data : []);
        setGroups(Array.isArray(g.data) ? g.data : []);
      } catch {}
    })();
  }, []);
// src/pages/TaskDetail.jsx  (Part 2/3) — continue
  /* ---------- fences helpers ---------- */
  function normalizeFencesPayload(data) {
    if (Array.isArray(data?.geoFences)) return data.geoFences;
    if (Array.isArray(data?.fences))    return data.fences;
    if (Array.isArray(data))            return data;
    return [];
  }
  async function computeEffectiveFences(taskId, pid) {
    if (taskFenceApi !== "absent") {
      try {
        const t = await api.get(`/tasks/${taskId}/geofences`);
        const tf = normalizeFencesPayload(t.data);
        if (taskFenceApi === "unknown") setTaskFenceApi("present");
        if (tf.length) {
          setGfCount(tf.length);
          setGfSource("task");
          return;
        }
      } catch (e) {
        if (e?.response?.status === 404) setTaskFenceApi("absent");
      }
    }
    if (pid) {
      try {
        const p = await api.get(`/projects/${pid}/geofences`);
        const pf = normalizeFencesPayload(p.data);
        setGfCount(pf.length);
        setGfSource(pf.length ? "project" : "none");
        return;
      } catch {}
    }
    setGfCount(0); setGfSource("none");
  }

  /* ---------- load task + manager notes ---------- */
  async function loadTask() {
    setErr(""); setInfo("");
    try {
      const { data } = await api.get(`/tasks/${id}`);
      const norm = normalizeTask(data || null);
      setTask(norm);
      lastGoodTaskRef.current = norm;

      // mirror into editables
      setTitle(norm?.title || "");
      setPriority(norm?.priority || "medium");
      setStartOn(toLocalDateOnly(norm?.startDate || norm?.startAt) || "");
      setDueOn(toLocalDateOnly(norm?.dueAt) || "");
      setProjectId(norm?.projectId || "");
      const seedGid =
        (norm?.groupId && String(norm.groupId)) ||
        (Array.isArray(norm?.assignedGroupIds) && norm.assignedGroupIds.length ? String(norm.assignedGroupIds[0]) : "");
      setGroupId(seedGid || "");
      const a = norm?.assignee || (Array.isArray(norm?.assignedTo) && norm.assignedTo.length ? norm.assignedTo[0] : "");
      setAssignee(a ? String(a._id || a) : "");
      setTags(Array.isArray(norm?.tags) ? norm.tags.join(", ") : "");
      setDescription(norm?.description || "");

      setEnforceLocationCheck(!!norm?.enforceLocationCheck);
      setEnforceQRScan(!!norm?.enforceQRScan);
      setLat(norm?.locationGeoFence?.lat ?? "");
      setLng(norm?.locationGeoFence?.lng ?? "");
      setRadius(norm?.locationGeoFence?.radius ?? "");

      // manager controls seed
      setMgrStatus(canonStatus(norm?.status || "pending"));
      setMgrNote("");

      // Load manager notes
      try {
        const notes = await fetchManagerNotes(id, Array.isArray(norm?.managerNotes) ? norm.managerNotes : []);
        setManagerNotes(Array.isArray(notes) ? notes : []);
      } catch {
        setManagerNotes(Array.isArray(norm?.managerNotes) ? norm.managerNotes : []);
      }

      await computeEffectiveFences(id, norm?.projectId || "");
      setMapBump((b) => b + 1);
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || String(e);
      setErr(msg);
      console.error("Load task failed:", e?.response?.data || e);
    }
  }
  useEffect(() => { loadTask();   }, [id]);

  /* ---------- milestones ---------- */
  async function loadMilestones() {
    setMErr("");
    try {
      let data;
      try {
        const res = await api.get(`/tasks/${id}/milestones`, { params: { limit: 500, _ts: Date.now() } });
        data = res.data;
      } catch (e) {
        const res = await api.get("/milestones", { params: { taskId: id, limit: 500, _ts: Date.now() } });
        data = res.data;
      }
      const list = Array.isArray(data) ? data.map(normMilestone) : [];
      setMilestones(list);
    } catch (e) {
      setMilestones([]);
      setMErr(e?.response?.data?.error || "Failed to load milestones");
    }
  }
  useEffect(() => { loadMilestones();   }, [id]);

  function buildMilestonePayload(ms, patch) {
    const out = {};
    if ("title" in patch) {
      const name = (patch.title || "").trim();
      out.title = name; out.name = name;
    }
    if ("startAt" in patch) {
      const s = patch.startAt || null;
      out.startPlanned = s; out.startAt = s; out.startDate = s; out.scheduledAt = s;
    }
    if ("endAt" in patch) {
      const e = patch.endAt || null;
      out.endPlanned = e; out.endAt = e; out.endDate = e; out.dueAt = e; out.dueDate = e; out.targetDate = e;
    }
    if ("status" in patch) {
      const st = canonStatus(patch.status);
      out.status = st; out.completed = st === "finished";
      if (st === "finished" && !ms.actualEndAt && !("actualEndAt" in patch)) {
        const now = new Date().toISOString();
        out.endActual = now; out.actualEndAt = now; out.completedAt = now;
      }
    }
    if ("isRoadblock" in patch) { const b = !!patch.isRoadblock; out.isRoadblock = b; out.roadblock = b; }
    if ("dependsOn" in patch) { const arr = patch.dependsOn ? [String(patch.dependsOn)] : []; out.dependsOn = arr; out.requires = arr; out.dependencies = arr; }
    if ("actualEndAt" in patch) { const a = patch.actualEndAt || null; out.endActual = a; out.actualEndAt = a; out.completedAt = a; }
    out.taskId = id;
    return out;
  }
  async function patchMilestone(ms, patch) {
    const payload = buildMilestonePayload(ms, patch);
    try {
      try { await api.patch(`/tasks/${id}/milestones/${ms._id}`, payload); }
      catch (e) {
        if (e?.response?.status === 405) await api.put(`/tasks/${id}/milestones/${ms._id}`, payload);
        else throw e;
      }
    } catch (e2) {
      try { await api.patch(`/milestones/${ms._id}`, payload); }
      catch (e3) {
        if (e3?.response?.status === 405) await api.put(`/milestones/${ms._id}`, payload);
        else throw e3;
      }
    }
  }

  // Create Milestone
  async function createMilestone() {
    setMErr(""); setMInfo("");
    try {
      const title = (msForm.title || "").trim();
      if (!title) { setMErr("Title is required"); return; }
      const status = canonStatus(msForm.status || "pending");
      const sISO = msForm.startAt ? fromLocalDateOnly(msForm.startAt) : null;
      const eISO = msForm.endAt ? fromLocalDateOnly(msForm.endAt) : null;
      const payload = {
        title, name: title,
        status,
        isRoadblock: !!msForm.isRoadblock,
        roadblock: !!msForm.isRoadblock,
        taskId: id,
        ...(sISO ? { startPlanned: sISO, startAt: sISO, startDate: sISO, scheduledAt: sISO } : {}),
        ...(eISO ? { endPlanned: eISO, endAt: eISO, endDate: eISO, dueAt: eISO, dueDate: eISO, targetDate: eISO } : {}),
      };
      try {
        await api.post(`/tasks/${id}/milestones`, payload);
      } catch (e) {
        const st = e?.response?.status;
        if (st === 404 || st === 405) {
          await api.post(`/milestones`, payload);
        } else {
          throw e;
        }
      }
      setMsModalOpen(false);
      setMsForm({ title: "", startAt: "", endAt: "", status: "pending", isRoadblock: false });
      await loadMilestones();
      setMReloadKey((k) => k + 1);
      setMInfo("Milestone added."); setTimeout(() => setMInfo(""), 1000);
    } catch (e) {
      setMErr(e?.response?.data?.error || String(e));
    }
  }

  /* ---------- optimistic save helpers ---------- */
  async function optimisticSave(patch, applyLocal) {
    setErr(""); setSaving(true);
    const prev = lastGoodTaskRef.current;
    try {
      if (applyLocal) applyLocal();
      const { data } = await sendTaskUpdate(id, patch, "put");
      const norm = normalizeTask(data);
      setTask(norm);
      lastGoodTaskRef.current = norm;
      setSaving(false);
    } catch (e) {
      if (prev) setTask(prev);
      setSaving(false);
      const raw = e?.response?.data;
      const msg = raw?.error || raw?.message || JSON.stringify(raw || {}) || String(e);
      setErr(msg);
      console.error("Save failed:", raw || e);
    }
  }

  const getAssigneeIdFromTask = (t) =>
    t?.assignee ?? (Array.isArray(t?.assignedTo) && t.assignedTo[0]) ?? (Array.isArray(t?.assignedUserIds) && t.assignedUserIds[0]) ?? null;

  async function saveAssigneeOnce(nextAssigneeIdRaw) {
    const nextAssigneeId = String(nextAssigneeIdRaw || "");
    const current = lastGoodTaskRef.current;
    if (!current) return;
    const currentId = String(getAssigneeIdFromTask(current) || "");
    if (currentId === String(nextAssigneeId || "")) return;
    if (saveGateRef.current.assignee) return;

    saveGateRef.current.assignee = true;
    try {
      await optimisticSave(
        {
          assignee: nextAssigneeId || null,
          assigneeId: nextAssigneeId || null,
          assignedUserIds: nextAssigneeId ? [nextAssigneeId] : [],
          assignedTo: nextAssigneeId ? [nextAssigneeId] : [],
        },
        () =>
          setTask((t) => ({
            ...(t || {}),
            assignee: nextAssigneeId || null,
            assignedUserIds: nextAssigneeId ? [nextAssigneeId] : [],
            assignedTo: nextAssigneeId ? [nextAssigneeId] : [],
          }))
      );
      setInfo("Assignee saved."); setTimeout(()=>setInfo(""), 1000);
    } finally {
      saveGateRef.current.assignee = false;
    }
  }
  async function saveStartOnce(nextLocalDateStr) {
    const current = lastGoodTaskRef.current;
    if (!current) return;
    const haveLocal = toLocalDateOnly(current.startDate || current.startAt || current.scheduledAt) || "";
    if (haveLocal === String(nextLocalDateStr || "")) return;
    if (saveGateRef.current.start) return;
    const iso = nextLocalDateStr ? fromLocalDateOnly(nextLocalDateStr) : null;

    saveGateRef.current.start = true;
    try {
      await optimisticSave(
        { startDate: iso || null, startAt: iso || null, scheduledAt: iso || null },
        () => setTask((t) => ({ ...(t || {}), startDate: iso || null }))
      );
      setInfo("Start date saved."); setTimeout(()=>setInfo(""), 1000);
    } finally {
      saveGateRef.current.start = false;
    }
  }
  async function saveDueOnce(nextLocalDateStr) {
    const current = lastGoodTaskRef.current;
    if (!current) return;
    const haveLocal = toLocalDateOnly(current.dueAt || current.dueDate || current.deadlineAt) || "";
    if (haveLocal === String(nextLocalDateStr || "")) return;
    if (saveGateRef.current.due) return;
    const iso = nextLocalDateStr ? fromLocalDateOnly(nextLocalDateStr) : null;
    saveGateRef.current.due = true;
    try {
      await optimisticSave(
        { dueAt: iso || null, dueDate: nextLocalDateStr || null, deadlineAt: iso || null },
        () => setTask((t) => ({ ...(t||{}), dueAt: iso || null }))
      );
      setInfo("Due date saved."); setTimeout(()=>setInfo(""), 1000);
    } finally {
      saveGateRef.current.due = false;
    }
  }

  /* ---------- forms & submissions ---------- */
  async function loadForms() {
    try {
      const params = { limit: 200, taskId: id };
      if (projectId) params.projectId = projectId;
      const { data } = await api.get("/inspections/forms", { params });
      setForms(Array.isArray(data) ? data : []);
      setFormsErr("");
    } catch (e) {
      setForms([]); setFormsErr(e?.response?.data?.error || "Failed to load forms");
    }
  }
  async function loadSubs() {
    try {
      const params = { limit: 200, taskId: id };
      if (projectId) params.projectId = projectId;
      const { data } = await api.get("/inspections/submissions", { params });
      setSubs(Array.isArray(data) ? data : []);
      setSubsErr("");
    } catch (e) {
      setSubs([]); setSubsErr(e?.response?.data?.error || "Failed to load submissions");
    }
  }
  useEffect(() => { loadForms(); loadSubs();   }, [id, projectId]);
    /* ---------- submission field resolver (robust) ---------- */
  function resolveSubmissionFields(s) {
    // DATE
    const submittedRaw =
      s?.submittedAt || s?.createdAt || s?.completedAt || s?.finishedAt || s?.updatedAt || null;
    const submitted = submittedRaw ? new Date(submittedRaw) : null;

    // INSPECTOR (many shapes)
     const runBy = s?.runBy && typeof s.runBy === "object" ? s.runBy : null;
  const actorObj =
    runBy ||
    s?.actor ||
    (s?.user && (typeof s.user === "object" ? s.user : null)) ||
    null;

  const actorId = String(
    actorObj?.userId ||
    actorObj?._id ||
    actorObj?.id ||
    s?.userId ||
    s?.createdBy ||
    ""
  );

  const actorFromUsers = actorId && usersById.get(actorId)
    ? (usersById.get(actorId).name || usersById.get(actorId).email)
    : "";

  const inspector =
    actorFromUsers ||
    runBy?.name ||
    runBy?.email ||
    actorObj?.name ||
    actorObj?.email ||
    s?.userName ||
    s?.createdByName ||
    actorId ||
    "—";

    // MANAGER NOTE (common nests)
     let managerNote = "—";
  if (Array.isArray(s?.managerComments) && s.managerComments.length) {
    const latest = s.managerComments
      .slice()
      .sort((a, b) => +new Date(b.at || b.createdAt || b.date || 0) - +new Date(a.at || a.createdAt || a.date || 0))[0];
    managerNote = latest?.comment?.trim?.() ? latest.comment : "—";
  } else {
    managerNote =
      s?.managerNote ||
      s?.note ||
      s?.meta?.managerNote ||
      s?.review?.note ||
      s?.reviewNote ||
      "—";
  }

    // OUTCOME (keep your existing logic, but provide fallback)
    const answers = Array.isArray(s?.answers) ? s.answers : [];
    const anyFail = answers.some(a => a?.result === "fail" || a?.pass === false);
    const outcome = s?.status === "needs-follow-up" ? "NEEDS FOLLOW-UP" : (anyFail ? "FAIL" : "PASS");

    // FORM TITLE
    const formTitle =
      s?.form?.title || s?.formTitle || s?.templateTitle || s?.templateName || "Form";

    // coords
    const lat = (s?.lat ?? s?.location?.lat ?? s?.coords?.lat ?? s?.meta?.lat ?? null);
    const lng = (s?.lng ?? s?.location?.lng ?? s?.coords?.lng ?? s?.meta?.lng ?? null);

    return { submitted, inspector, managerNote, outcome, formTitle, lat, lng };
  }

  /* ---------- geofence ops ---------- */
  const fallbackCircle =
    lat !== "" && lng !== ""
      ? (() => {
          const L = Number(lat);
          const G = Number(lng);
          const R = radius === "" ? 50 : Number(radius);
          return Number.isFinite(L) && Number.isFinite(G) && Number.isFinite(R)
            ? { lat: L, lng: G, radius: R }
            : null;
        })()
      : null;

  const taskCircle = showPin && lat !== "" && lng !== ""
    ? (() => {
        const L = Number(lat);
        const G = Number(lng);
        const R = radius === "" ? 50 : Number(radius);
        return Number.isFinite(L) && Number.isFinite(G) && Number.isFinite(R)
          ? { lat: L, lng: G, radius: R }
          : null;
      })()
    : null;

  async function saveGeofence(e) {
    e?.preventDefault?.();
    setErr(""); setInfo("");
    try {
      const gf = (lat !== "" && lng !== "") ? {
        lat: Number(lat),
        lng: Number(lng),
        radius: radius !== "" ? Number(radius) : 50,
      } : undefined;

      const { data } = await sendTaskUpdate(id, {
        enforceLocationCheck,
        enforceQRScan,
        locationGeoFence: gf,
      }, "put");

      const norm = normalizeTask(data);
      setTask(norm);
      lastGoodTaskRef.current = norm;
      await computeEffectiveFences(id, norm?.projectId || "");
      setMapBump(b=>b+1);
      setInfo("Pin & enforcement saved.");
      setTimeout(() => setInfo(""), 1200);
    } catch (e2) {
      const raw = e2?.response?.data;
      const msg = raw?.error || raw?.message || JSON.stringify(raw || {}) || String(e2);
      setErr(msg);
    }
  }

  async function uploadTaskFencesFile(file) {
    if (!file) throw new Error("Choose a .geojson, .kml or .kmz file first.");
    try {
      try {
        const fd = new FormData();
        fd.append("file", file);
        await api.post(`/tasks/${id}/geofences/upload`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      } catch (e) {
        const status = e?.response?.status;
        if (status && status !== 404) throw e;
        // client-side normalize (fallback)
        const textOrZip = await file.arrayBuffer();
        const name = (file.name || "").toLowerCase();
        let rings = [];
        if (name.endsWith(".geojson") || name.endsWith(".json")) {
          const td = new TextDecoder("utf-8"); const text = td.decode(textOrZip);
          const obj = JSON.parse(text);
          rings = parseGeoJSONToRings(obj);
        } else if (name.endsWith(".kml")) {
          const td = new TextDecoder("utf-8"); const text = td.decode(textOrZip);
          rings = parseKMLToRings(text);
        } else if (name.endsWith(".kmz")) {
          const { default: JSZip } = await import("jszip");
          const zip = await JSZip.loadAsync(textOrZip);
          const kmlEntry = Object.values(zip.files).find((f) => /\.kml$/i.test(f.name));
          if (!kmlEntry) throw new Error("No .kml found inside .kmz");
          const kmlText = await kmlEntry.async("text");
          rings = parseKMLToRings(kmlText);
        } else {
          throw new Error("Unsupported file type. Use .geojson, .kml or .kmz");
        }
        if (!rings.length) throw new Error("No polygons found in file.");
        const fences = rings.map(r => ({ type: "polygon", polygon: r }));
        try { await api.put(`/tasks/${id}/geofences`, { fences }); }
        catch { await api.post(`/tasks/${id}/geofences/import`, { fences }); }
      }
      await computeEffectiveFences(id, projectId);
      setMapBump(b => b + 1);
    } catch (e) {
      throw e;
    }
  }
  function parseGeoJSONToRings(obj) {
    const rings = [];
    const pushPoly = (coords) => {
      if (!Array.isArray(coords)) return;
      const outer = coords[0];
      if (!Array.isArray(outer) || outer.length < 3) return;
      const cleaned = outer.map(([lng, lat]) => [r6(Number(lng)), r6(Number(lat))])
        .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
      if (cleaned.length >= 3) rings.push(closeRing(cleaned));
    };
    const handle = (g) => {
      if (!g) return;
      if (g.type === "Polygon") pushPoly(g.coordinates);
      if (g.type === "MultiPolygon") (g.coordinates || []).forEach(pushPoly);
    };
    if (obj.type === "FeatureCollection") (obj.features || []).forEach((f) => handle(f?.geometry));
    else if (obj.type === "Feature") handle(obj.geometry);
    else handle(obj);
    return rings;
  }
  function parseKMLToRings(kmlString) {
    const parser = new DOMParser();
    const xml = parser.parseFromString(kmlString, "application/xml");
    const coordsEls = Array.from(xml.getElementsByTagName("coordinates"));
    const rings = [];
    coordsEls.forEach((el) => {
      const raw = (el.textContent || "").trim();
      if (!raw) return;
      const pts = raw.split(/\s+/).map((pair) => {
        const [lng, lat] = pair.split(",").slice(0, 2).map(Number);
        return [r6(lng), r6(lat)];
      }).filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
      if (pts.length >= 3) rings.push(closeRing(pts));
    });
    return rings;
  }

  async function clearTaskFences() {
    if (!window.confirm("Remove all task-specific fences? (Project fences, if any, will still apply)")) return;
    try {
      try { await api.delete(`/tasks/${id}/geofences`); }
      catch { await api.post(`/tasks/${id}/geofences/clear`); }
      await computeEffectiveFences(id, projectId);
      setMapBump(b => b + 1);
      setInfo("Task fences cleared."); setTimeout(()=>setInfo(""),1000);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || String(e));
    }
  }
  async function refreshEffectiveFences() {
    setErr(""); await computeEffectiveFences(id, projectId); setMapBump((b) => b + 1);
  }

  /* ---------- actions/logs ---------- */
  async function doAction(action) {
    setErr(""); setInfo("");
    try {
     const body = { action };

// Always *attempt* to capture location if available
const coords = await new Promise((resolve) => {
  if (!navigator.geolocation) return resolve(null);
  navigator.geolocation.getCurrentPosition(
    (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
    () => resolve(null),
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 8000 }
  );
});
if (coords) {
  body.lat = coords.lat;
  body.lng = coords.lng;
}
      await api.post(`/tasks/${id}/action`, body);
      await loadTask();
      setInfo(`Action: ${action}`); setTimeout(() => setInfo(""), 1000);
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
  }

  // Add / Edit Log submit (productivity or photo)
async function submitLog() {
  setLogErr("");
  try {
    if (logType === "attachment") {
      // PHOTO
      if (!editingLogId) {
        if (!logFile) throw new Error("Choose a photo to upload.");

        const fd = new FormData();
        fd.append("file", logFile);
        if (logNote) fd.append("note", logNote);

        // If you want milestone info to travel with the photo, send it too
        if (logMilestoneId) {
          fd.append("milestoneId", logMilestoneId);
          fd.append("milestone", logMilestoneId);
          fd.append("milestone_id", logMilestoneId);
        }

        // Always try capture lat/lng when taking a photo
if (navigator.geolocation) {
  const coords = await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 8000 }
    );
  });
  if (coords) {
    fd.append("lat", coords.lat);
    fd.append("lng", coords.lng);
  }
}

        await api.post(`/tasks/${id}/attachments`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });

        // Rely on the backend to create the "photo" log entry for this attachment.
      } else {
        // Editing an existing photo log: still patch the log metadata (time, note, milestone)
        await api.patch(`/tasks/${id}/logs/${editingLogId}`, {
          at: fromLocalDateTimeInput(logAt),
          action: "photo",
          note: logNote || "",
          ...(logMilestoneId
            ? { milestoneId: logMilestoneId, milestone: logMilestoneId, milestone_id: logMilestoneId }
            : { milestoneId: null, milestone: null, milestone_id: null }),
        });
      }
    } else {
      // PRODUCTIVITY
      const payload = {
        action: logAction,
        at: fromLocalDateTimeInput(logAt),
        note: logNote || "",
        ...(logMilestoneId
          ? { milestoneId: logMilestoneId, milestone: logMilestoneId, milestone_id: logMilestoneId }
          : { milestoneId: null, milestone: null, milestone_id: null }),
      };

      // Always *attempt* location capture if available (for any action)
if (navigator.geolocation) {
  const coords = await new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 8000 }
    );
  });
  if (coords) {
    payload.lat = coords.lat;
    payload.lng = coords.lng;
  }
}

      if (!editingLogId) {
        await api.post(`/tasks/${id}/logs`, payload);
      } else {
        await api.patch(`/tasks/${id}/logs/${editingLogId}`, payload);
      }
    }

    setLogOpen(false);
    setEditingLogId(null);
    setLogFile(null);
    setLogNote("");
    setLogMilestoneId("");
    await loadTask();
    setInfo("Log saved.");
    setTimeout(() => setInfo(""), 1000);
  } catch (e) {
    setLogErr(e?.response?.data?.error || e?.message || String(e));
  }
}

  /* ---------- Manager status + notes ---------- */
  async function saveManagerStatusAndNote() {
    setErr(""); setInfo("");
    const nextStatus = canonStatus(mgrStatus || "pending");
    const note = (mgrNote || "").trim();

    try {
      await optimisticSave(
        { status: nextStatus },
        () => setTask((t) => ({ ...(t||{}), status: nextStatus }))
      );

      if (note) {
        const entry = { at: new Date().toISOString(), status: nextStatus, note };
        try {
          await api.post(`/tasks/${id}/manager-notes`, entry);
          const fresh = await fetchManagerNotes(id, []);
          setManagerNotes(Array.isArray(fresh) ? fresh : []);
        } catch (e) {
          const st = e?.response?.status;
          if (st === 404 || st === 405) {
            const existing = Array.isArray(lastGoodTaskRef.current?.managerNotes)
              ? lastGoodTaskRef.current.managerNotes
              : [];
            await optimisticSave(
              { managerNotes: [...existing, entry] },
              () => setManagerNotes((prev) => [...prev, entry])
            );
          } else {
            throw e;
          }
        }
        setMgrNote("");
      }
      setInfo("Status & manager note saved."); setTimeout(()=>setInfo(""),1200);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  /* ---------- PRINT / “Print PDF” ---------- */
  function printPDF() {
    try {
      const node = printRef.current;
      if (!node) return window.print();

      const win = window.open("", "_blank", "noopener,noreferrer,width=1024,height=768");
      if (!win) return window.print();

      const doc = win.document;
      doc.open();
      doc.write("<!doctype html><html><head><meta charset='utf-8'><title>Task</title></head><body></body></html>");

      const head = doc.head;
      document.querySelectorAll('link[rel="stylesheet"], style').forEach((el) => {
        const clone = el.cloneNode(true);
        head.appendChild(clone);
      });

      const style = doc.createElement("style");
      style.textContent = `
        @page { size: A4; margin: 12mm; }
        body { background: #fff; }
        .print-container { max-width: 1024px; margin: 0 auto; }
      `;
      head.appendChild(style);

      const wrap = doc.createElement("div");
      wrap.className = "print-container";
      wrap.innerHTML = node.outerHTML;
      doc.body.appendChild(wrap);

      setTimeout(() => {
        win.focus();
        win.print();
        win.close();
      }, 300);
    } catch {
      window.print();
    }
  }

  async function deleteTask() {
    if (!window.confirm("Delete this task? This cannot be undone.")) return;
    setErr(""); setInfo("");
    try {
      await api.delete(`/tasks/${id}`);
      setInfo("Task deleted.");
      if (onClose) onClose();
      else navigate(-1);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  /* ---------- date filter helpers ---------- */
  const inDateWindow = (iso) => {
    if (!iso) return false;
    const d = new Date(iso);
    if (isNaN(+d)) return false;
    const fromOk = !fltFrom || d >= new Date(`${fltFrom}T00:00:00`);
    const toOk   = !fltTo   || d <  new Date(`${fltTo}T23:59:59.999`);
    return fromOk && toOk;
  };

  // Map milestoneId => title for quick lookup
  const msTitleById = useMemo(() => {
    const m = new Map();
    (milestones || []).forEach(x => m.set(String(x._id || x.id), x.title || "Milestone"));
    return m;
  }, [milestones]);
// src/pages/TaskDetail.jsx  (Part 3/3) — continue

  if (!task) return <div className="p-4">{err ? err : "Loading…"}</div>;

  const actualMins = task.actualDurationMinutes ?? 0;
  const estMins = task.estimatedDuration ?? null;
  const delta = estMins != null ? actualMins - estMins : null;
  const savingDot = saving ? <span className="ml-2 text-xs text-gray-500">Saving…</span> : null;

  /* ====================== UI ====================== */
  return (
    <div className="max-w-7xl mx-auto p-4" ref={printRef}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold truncate">{task.title || "Task"}</h1>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Global date filter */}
          <div className="flex items-end gap-2 text-sm mr-2">
            <label className="block">
              <div className="text-xs text-gray-600">From</div>
              <input type="date" className="border p-2 rounded" value={fltFrom} onChange={e=>setFltFrom(e.target.value)} />
            </label>
            <label className="block">
              <div className="text-xs text-gray-600">To</div>
              <input type="date" className="border p-2 rounded" value={fltTo} onChange={e=>setFltTo(e.target.value)} />
            </label>
            {(fltFrom || fltTo) && (
              <button className="px-2 py-2 border rounded" onClick={()=>{ setFltFrom(""); setFltTo(""); }}>
                Clear
              </button>
            )}
          </div>

          <button className="px-3 py-2 border rounded" onClick={deleteTask}>Delete</button>
          <button className="px-3 py-2 border rounded" onClick={printPDF}>Print PDF</button>
          <button className="px-3 py-2 border rounded" onClick={() => (onClose ? onClose() : navigate(-1))}>Back</button>
        </div>
      </div>

      {err && <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-sm">{err}</div>}
      {info && <div className="mt-2 rounded border border-green-200 bg-green-100 p-2 text-sm">{info}</div>}

      {/* Top row: Overview (left) | Manager (right) */}
      <div className="grid gap-4 lg:grid-cols-2 mt-3">
        {/* Overview (inline edits) */}
        <div className="border rounded-2xl p-4 space-y-3 bg-white">
          <div className="font-semibold">Details</div>

          <label className="text-sm block">
            Title {savingDot}
            <input
              className="border p-2 w-full rounded mt-1"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() =>
                title !== (lastGoodTaskRef.current?.title || "") &&
                optimisticSave(
                  { title: title?.trim() || "" },
                  () => setTask((t) => ({ ...(t||{}), title: title?.trim() || "" }))
                )
              }
              placeholder="Task title"
            />
          </label>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm block">
              Priority
              <select
                className="border p-2 w-full rounded mt-1"
                value={priority}
                onChange={(e) => {
                  const v = e.target.value;
                  setPriority(v);
                  if (v !== (lastGoodTaskRef.current?.priority || ""))
                    optimisticSave(
                      { priority: v },
                      () => setTask((t) => ({ ...(t||{}), priority: v }))
                    );
                }}
              >
                {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>

            <label className="text-sm block">
              Project
              <select
                className="border p-2 w-full rounded mt-1"
                value={projectId}
                onChange={(e) => {
                  const v = e.target.value;
                  setProjectId(v);
                  if (String(v || "") !== String(lastGoodTaskRef.current?.projectId || "")) {
                    optimisticSave(
                      { projectId: v || null },
                      () => setTask((t) => ({ ...(t||{}), projectId: v || null }))
                    ).then(() => {
                      computeEffectiveFences(id, v || "");
                      setMapBump((b)=>b+1);
                    });
                  }
                }}
              >
                <option value="">— none —</option>
                {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
              </select>
            </label>

            <label className="text-sm block">
              Start date
              <input
                className="border p-2 w-full rounded mt-1"
                type="date"
                value={startOn}
                onChange={(e) => setStartOn(e.target.value)}
                onBlur={() => saveStartOnce(startOn)}
              />
            </label>

            <label className="text-sm block">
              Due date
              <input
                className="border p-2 w-full rounded mt-1"
                type="date"
                value={dueOn}
                onChange={(e) => setDueOn(e.target.value)}
                onBlur={() => saveDueOnce(dueOn)}
              />
            </label>

            <label className="text-sm block">
              Group
              <div className="mt-1">
                <GroupSelect
                  value={groupId || null}
                  onChange={(gid) => {
                    const gidStr = gid ? String(gid) : "";
                    setGroupId(gidStr);
                    const patch = { groupId: gid || null, assignedGroupIds: gid ? [gid] : [] };
                    optimisticSave(
                      patch,
                      () => setTask((t) => ({ ...(t || {}), groupId: gid || null, assignedGroupIds: gid ? [gid] : [] }))
                    );
                  }}
                  placeholder="(optional) assign a group"
                />
              </div>
            </label>

            <label className="text-sm block">
              Assignee
              <select
                className="border p-2 w-full rounded mt-1"
                value={assignee}
                onChange={async (e) => { const v = e.target.value; setAssignee(v); await saveAssigneeOnce(v); }}
              >
                <option value="">— none —</option>
                {users.map(u => <option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>)}
              </select>
            </label>
          </div>

          <label className="text-sm block">
            Tags (comma)
            <input
              className="border p-2 w-full rounded mt-1"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              onBlur={() => {
                const arr = tags.split(",").map(s => s.trim()).filter(Boolean);
                const prev = Array.isArray(lastGoodTaskRef.current?.tags) ? lastGoodTaskRef.current.tags : [];
                if (JSON.stringify(arr) !== JSON.stringify(prev)) {
                  optimisticSave(
                    { tags: arr, labels: arr },
                    () => setTask((t) => ({ ...(t||{}), tags: arr }))
                  );
                }
              }}
              placeholder="site-a, safety, urgent"
            />
          </label>

          <label className="text-sm block">
            Description
            <textarea
              className="border p-2 w-full rounded mt-1"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() =>
                (description || "") !== (lastGoodTaskRef.current?.description || "") &&
                optimisticSave(
                  { description: description || "" },
                  () => setTask((t) => ({ ...(t||{}), description: description || "" }))
                )
              }
              placeholder="Task details…"
            />
          </label>

          <div className="text-xs text-gray-600">
            Estimated vs Actual:&nbsp;
            {estMins != null ? `${estMins}m` : "—"} vs {actualMins}m
            {delta != null && (
              <span className={delta <= 0 ? "text-green-700" : "text-red-700"}>
                {" "}({Math.abs(delta)}m {delta <= 0 ? "ahead" : "behind"})
              </span>
            )}
          </div>
        </div>

        {/* Manager (status selector + notes area) */}
        <div className="space-y-4">
          <div className="border rounded-2xl p-4 bg-white">
            <div className="font-semibold mb-2">Task Manager</div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm block">
                Status
                <select
                  className="border p-2 w-full rounded mt-1"
                  value={mgrStatus}
                  onChange={(e)=>setMgrStatus(canonStatus(e.target.value))}
                >
                  {MS_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>

              <div className="md:col-span-2">
                <label className="text-sm block">
                  Task manager note (optional)
                  <textarea
                    className="border p-2 w-full rounded mt-1"
                    rows={3}
                    value={mgrNote}
                    onChange={(e)=>setMgrNote(e.target.value)}
                    placeholder="Context for this status update, blockers, decisions…"
                  />
                </label>
              </div>

              <div className="md:col-span-2 flex justify-end gap-2">
                <button className="px-3 py-2 border rounded" onClick={saveManagerStatusAndNote}>Save</button>
              </div>
            </div>

            {Array.isArray(managerNotes) && managerNotes.length > 0 && (
              <div className="mt-4">
                <div className="text-sm font-medium mb-1">Recent manager notes</div>
                <div className="space-y-2">
                  {managerNotes
                    .slice()
                    .sort((a,b)=> +new Date(b.at || b.createdAt || 0) - +new Date(a.at || a.createdAt || 0))
                    .map((n, idx) => (
                      <div key={(n._id || n.id || idx) + ":" + (n.at || n.createdAt || "")} className="text-sm border rounded p-2 bg-gray-50">
                        <div className="text-xs text-gray-600 mb-1">
                          {(n.at || n.createdAt) ? new Date(n.at || n.createdAt).toLocaleString() : "—"} {n.status ? `• ${canonStatus(n.status)}` : ""}
                          {n.author?.name ? ` • ${n.author.name}` : n.author?.email ? ` • ${n.author.email}` : ""}
                        </div>
                        <div style={{whiteSpace:"pre-wrap"}}>{n.note}</div>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Geofencing */}
      <div className="border rounded-2xl p-4 mt-4 bg-white">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="font-semibold">Geofencing</div>
          <div className="text-sm text-gray-600">
            Effective fences: <b>{gfCount}</b> <span className="ml-2">source: <i>{gfSource}</i></span>
          </div>
        </div>

        {/* toggles row */}
        <div className="flex flex-wrap items-center gap-4 mt-3">
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showPin} onChange={(e)=>setShowPin(e.target.checked)} />
            Show task pin
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showTaskGeofence} onChange={(e)=>setShowTaskGeofence(e.target.checked)} />
            Show task geofence
          </label>
          <div className="ml-auto text-xs text-gray-500">
            Legend shows automatically when features are present.
          </div>
        </div>

        {/* Map */}
        <div className="mt-3">
          <SafeGeoFencePreview
            projectId={task.projectId}
            taskId={showTaskGeofence && taskFenceApi === "present" ? id : undefined}
            showTaskCoverage={true}
            height={360}
            className="relative rounded z-0"
            reloadKey={`${mapBump}:${gfCount}:${lat}:${lng}:${radius}:${showPin}:${showTaskGeofence}`}
            fallbackCircle={fallbackCircle}
            taskCircle={taskCircle}
            extraFences={[]}
            allowPicking={true}
            legend={true}
            onPickLocation={({ lat: L, lng: G }) => {
              setLat(L.toFixed(PREC)); setLng(G.toFixed(PREC));
              if (!radius) setRadius(50);
              setInfo(`Pin set at ${L.toFixed(PREC)}, ${G.toFixed(PREC)} — click “Save location” to persist.`);
              setTimeout(()=>setInfo(""),2000);
            }}
            onLoaded={({ projectFences, taskFences }) => {
              setDlProject(projectFences || []);
              setDlTask(taskFences || []);
            }}
            canToggleTask={false}
          />
        </div>

        {/* controls */}
        <form onSubmit={saveGeofence} className="mt-3 space-y-3">
          {/* coords row */}
          <div className="flex flex-wrap gap-3 items-end">
            <label className="text-sm">Lat
              <input className="border p-2 w-full rounded ml-2" style={{minWidth:140}} value={lat} onChange={e=>setLat(e.target.value)} placeholder="-33.123456" />
            </label>
            <label className="text-sm">Lng
              <input className="border p-2 w-full rounded ml-2" style={{minWidth:140}} value={lng} onChange={e=>setLng(e.target.value)} placeholder="18.654321" />
            </label>
            <label className="text-sm">Radius (m)
              <input className="border p-2 w-full rounded ml-2" type="number" min="5" value={radius} onChange={e=>setRadius(e.target.value)} placeholder="50" />
            </label>
            <button type="button" className="px-3 py-2 border rounded"
              onClick={()=>{
                if (!navigator.geolocation) return setErr("Geolocation not supported by this browser.");
                navigator.geolocation.getCurrentPosition(
                  (pos) => {
                    setLat(pos.coords.latitude.toFixed(PREC));
                    setLng(pos.coords.longitude.toFixed(PREC));
                    if (!radius) setRadius(50);
                  },
                  (ge) => setErr(ge?.message || "Failed to get current position"),
                  { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
                );
              }}>Use my location</button>
            <button className="px-3 py-2 border rounded" type="submit">Save location</button>
          </div>

          {/* upload/clear row */}
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm" style={{ minWidth: 260 }}>
              GeoJSON/KML/KMZ
              <input className="border p-2 w-full rounded mt-1" type="file" accept=".geojson,.json,.kml,.kmz" onChange={async (e) => {
                const file = e.target.files?.[0] || null;
                if (!file) return;
                try { await uploadTaskFencesFile(file); setInfo("Fences updated."); setTimeout(()=>setInfo(""),1000); }
                catch (er) { setErr(er?.response?.data?.error || er?.message || String(er)); }
                finally { e.target.value = ""; }
              }} />
            </label>
            <button className="px-3 py-2 border rounded" type="button" onClick={clearTaskFences}>Clear fences</button>
            <button className="px-3 py-2 border rounded" type="button" onClick={refreshEffectiveFences}>Refresh</button>
            <div className="ml-auto flex gap-2">
              <button
                className="px-3 py-2 border rounded disabled:opacity-50"
                disabled={!dlProject?.length || exporting === "project"}
                onClick={async () => {
                  try { setExporting("project"); const name = `project_${(projectLabel(projectId) || projectId || "project").replace(/[^\w\-]+/g, "_")}`; const kml = fencesToKML(name, dlProject); await downloadKMZ(`${name}.kmz`, kml); setInfo(`Exported ${name}.kmz`); setTimeout(()=>setInfo(""),1000); }
                  finally { setExporting(null); }
                }}
                type="button"
              >
                {exporting === "project" ? "Exporting…" : "Export Project KMZ"}
              </button>
              <button
                className="px-3 py-2 border rounded disabled:opacity-50"
                disabled={!(dlTask?.length || taskCircle) || exporting === "task"}
                onClick={async () => {
                  try {
                    setExporting("task");
                    const fences = [...(dlTask || [])];
                    if (taskCircle) fences.push({ type: "circle", center: { lat: Number(lat), lng: Number(lng) }, radius: Number(radius || 50) });
                    const name = `task_${(task?.title || id || "task").replace(/[^\w\-]+/g, "_")}`;
                    const kml = fencesToKML(name, fences);
                    await downloadKMZ(`${name}.kmz`, kml);
                    setInfo(`Exported ${name}.kmz`); setTimeout(()=>setInfo(""),1000);
                  } finally { setExporting(null); }
                }}
                type="button"
              >
                {exporting === "task" ? "Exporting…" : "Export Task KMZ"}
              </button>
            </div>
          </div>

          {/* enforcement toggles */}
          <div className="flex flex-wrap items-center gap-4">
            <label className="text-sm inline-flex items-center gap-2">
              <input type="checkbox" checked={enforceLocationCheck} onChange={e => setEnforceLocationCheck(e.target.checked)} />
              Enforce location check (on start/resume)
            </label>
            <label className="text-sm inline-flex items-center gap-2">
              <input type="checkbox" checked={enforceQRScan} onChange={e => setEnforceQRScan(e.target.checked)} />
              Require QR before start
            </label>
          </div>
        </form>
      </div>

      {/* Gantt */}
      <div className="mt-4">
        <MilestonesBlock
          key={`${id}:${mReloadKey}`}
          taskId={id}
          taskStartAt={task?.startAt || task?.startDate || task?.scheduledAt || null}
          taskEndAt={task?.dueAt || task?.dueDate || null}
          taskDueAt={task?.dueAt || null}
          reloadKey={mReloadKey}
        />
      </div>

      {/* Milestones list */}
      <div className="border rounded-2xl p-4 mt-4 bg-white space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Milestones</div>
          <button className="px-3 py-2 border rounded" onClick={()=>setMsModalOpen(true)}>Add milestone</button>
        </div>
        {mErr && <div className="text-red-600 text-sm">{mErr}</div>}
        {mInfo && <div className="text-green-700 text-sm">{mInfo}</div>}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="p-2 text-left">Title</th>
                <th className="p-2 text-left">Start date</th>
                <th className="p-2 text-left">End date</th>
                <th className="p-2 text-left">Actual end</th>
                <th className="p-2 text-left">Status</th>
                <th className="p-2 text-left">Is roadblock</th>
                <th className="p-2 text-left">Roadblock dependency</th>
                <th className="p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(milestones.length ? milestones : []).slice()
                .filter(ms => {
                  if (!fltFrom && !fltTo) return true;
                  const sOk = ms.startAt ? inDateWindow(ms.startAt) : false;
                  const eOk = ms.dueAt   ? inDateWindow(ms.dueAt)   : false;
                  return sOk || eOk;
                })
                .sort((a,b)=>{
                  const as = +new Date(a.startAt || 0);
                  const bs = +new Date(b.startAt || 0);
                  return as - bs || (+new Date(a.dueAt || 0) - +new Date(b.dueAt || 0));
                })
                .map(ms=>{
                  const mid = String(ms._id || ms.id);
                  const rbOptions = milestones.filter(m => String(m._id||m.id)!==mid && !!m.isRoadblock);
                  const saveWrap = async (patch) => {
                    try {
                      setMErr(""); setMInfo("");
                      await patchMilestone(ms, patch);
                      await loadMilestones();
                      setMReloadKey(k => k + 1);
                      setMInfo("Milestone saved."); setTimeout(()=>setMInfo(""), 1000);
                    } catch (e) { setMErr(e?.response?.data?.error || String(e)); }
                  };
                  return (
                    <tr key={mid}>
                      <td className="border-t p-2" style={{minWidth:220}}>
                        <input className="border p-2 w-full rounded" defaultValue={ms.title || ""} onBlur={(e)=>{ const v=(e.target.value||"").trim(); if (v !== (ms.title||"")) saveWrap({ title: v }); }} placeholder="Milestone title" />
                      </td>
                      <td className="border-t p-2" style={{minWidth:150}}>
                        <input className="border p-2 rounded" type="date" defaultValue={toLocalDateOnly(ms.startAt)} onBlur={(e)=>{ const v=e.target.value; if (toLocalDateOnly(ms.startAt)!==v) saveWrap({ startAt: fromLocalDateOnly(v) }); }} />
                      </td>
                      <td className="border-t p-2" style={{minWidth:150}}>
                        <input className="border p-2 rounded" type="date" defaultValue={toLocalDateOnly(ms.dueAt)} onBlur={(e)=>{ const v=e.target.value; if (toLocalDateOnly(ms.dueAt)!==v) saveWrap({ endAt: fromLocalDateOnly(v) }); }} />
                      </td>
                      <td className="border-t p-2" style={{minWidth:150}}>
                        <input
                          className="border p-2 rounded"
                          type="date"
                          defaultValue={toLocalDateOnly(ms.actualEndAt)}
                          onBlur={(e) => {
                            const v = e.target.value;
                            const nextISO = v ? fromLocalDateOnly(v) : null;
                            const prev = toLocalDateOnly(ms.actualEndAt);
                            if (v === prev) return;
                            const patch = nextISO
                              ? { actualEndAt: nextISO, status: "finished" }
                              : { actualEndAt: null };
                            saveWrap(patch);
                          }}
                        />
                      </td>
                      <td className="border-t p-2" style={{minWidth:160}}>
                        <select
                          className="border p-2 rounded"
                          defaultValue={canonStatus(ms.status)}
                          onChange={(e) => {
                            const next = canonStatus(e.target.value);
                            if (next === canonStatus(ms.status)) return;
                            if (next === "finished" && !ms.actualEndAt) {
                              saveWrap({ status: next, actualEndAt: new Date().toISOString() });
                            } else {
                              saveWrap({ status: next });
                            }
                          }}
                        >
                          {MS_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>
                      <td className="border-t p-2" style={{minWidth:130}}>
                        <label className="inline-flex items-center gap-2">
                          <input type="checkbox" defaultChecked={!!ms.isRoadblock} onChange={(e)=> saveWrap({ isRoadblock: e.target.checked })} />
                          <span className="text-xs text-gray-700">Roadblock</span>
                        </label>
                      </td>
                      <td className="border-t p-2" style={{minWidth:240}}>
                        <select className="border p-2 rounded w-full" defaultValue={ms.dependsOn ? String(ms.dependsOn) : ""} onChange={(e)=>{ const v=e.target.value||""; const next=v? v : null; const prev = ms.dependsOn ? String(ms.dependsOn) : ""; if (String(next||"")!==prev) saveWrap({ dependsOn: next }); }}>
                          <option value="">— none —</option>
                          {rbOptions.map(opt => <option key={opt._id || opt.id} value={opt._id || opt.id}>{opt.title || "Untitled"} (roadblock)</option>)}
                        </select>
                      </td>
                      <td className="border-t p-2 text-right whitespace-nowrap" style={{minWidth:120}}>
                        <button className="px-2 py-1 border rounded" onClick={async ()=>{
                          if (!window.confirm("Delete this milestone?")) return;
                          try {
                            setMErr(""); setMInfo("");
                            try { await api.delete(`/tasks/${id}/milestones/${mid}`); }
                            catch { await api.delete(`/milestones/${mid}`); }
                            await loadMilestones();
                            setMReloadKey(k => k + 1);
                            setMInfo("Milestone deleted."); setTimeout(()=>setMInfo(""), 1000);
                          } catch (e) { setMErr(e?.response?.data?.error || String(e)); }
                        }} type="button">Delete</button>
                      </td>
                    </tr>
                  );
                })}
              {!milestones.length && <tr><td className="p-4 text-center" colSpan={8}>No milestones yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* Inspections */}
      <div className="border rounded-2xl p-4 mt-4 bg-white space-y-4">
        <div className="flex items-center justify-between">
          <div className="font-medium bg-gray-50 rounded px-2 py-1 flex items-center justify-between w-full">
            <span className="font-semibold">Inspections</span>
          </div>
        </div>

        {/* Available forms */}
        <div className="space-y-2">
          {formsErr && <div className="text-red-600 text-sm">{formsErr}</div>}
          {forms.length ? (
            <table className="w-full text-sm">
              <thead><tr className="bg-gray-50">
                <th className="p-2 text-left">Available Forms</th>
                <th className="p-2 text-left">Scope</th>
                <th className="p-2 text-right">Run</th>
              </tr></thead>
              <tbody>
                {forms.map((f) => {
                  const formId = f._id || f.id;
                  const s = f?.scope || {};
                  const isGlobal = !!(s.isGlobal || (!Array.isArray(s.projectIds) && !Array.isArray(s.taskIds)));
                  const onTask = Array.isArray(s.taskIds) && s.taskIds.map(String).includes(String(id));
                  const onProject = Array.isArray(s.projectIds) && s.projectIds.map(String).includes(String(projectId));
                  const scopeText = isGlobal ? "Global" : onTask ? "Task" : onProject ? "Project" : "Scoped";
                  const qs = new URLSearchParams({ projectId: projectId || "", taskId: id }).toString();
                  return (
                    <tr key={formId}>
                      <td className="border-t p-2">{f.title || f.name || "Form"}</td>
                      <td className="border-t p-2">{scopeText}</td>
                      <td className="border-t p-2 text-right">
                        <Link className="px-2 py-1 border rounded" to={`/inspections/forms/${formId}/open?${qs}`}>Run</Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <div className="text-sm text-gray-600">No forms available for this task yet.</div>}
        </div>

        {/* Recent submissions (filtered) */}
        <div className="space-y-2">
          <div className="font-medium text-sm bg-gray-50 rounded px-2 py-1 flex items-center justify-between">
            <span className="font-semibold">Recent Inspection Submissions</span>
            <div className="flex gap-2">
              <button className="px-2 py-1 border rounded text-xs" onClick={async ()=>{
                const withCoords = (subs || []).filter((s)=> {
                  if (!inDateWindow(s?.submittedAt)) return false;
                  const lat = Number(s?.lat ?? s?.location?.lat ?? s?.coords?.lat ?? s?.meta?.lat);
                  const lng = Number(s?.lng ?? s?.location?.lng ?? s?.coords?.lng ?? s?.meta?.lng);
                  return Number.isFinite(lat) && Number.isFinite(lng);
                });
                if (!withCoords.length) { setErr("No lat/lng on submissions (in filter window) to export."); return; }
                const title = `inspections_${(task?.title || id).replace(/[^\w\-]+/g,"_")}`;
                const placemarks = withCoords.map((s)=>{
                  const lat = Number(s?.lat ?? s?.location?.lat ?? s?.coords?.lat ?? s?.meta?.lat);
                  const lng = Number(s?.lng ?? s?.location?.lng ?? s?.coords?.lng ?? s?.meta?.lng);
                  const when = s.submittedAt ? new Date(s.submittedAt).toLocaleString() : "—";
                  const answers = Array.isArray(s?.answers) ? s.answers : [];
                  const anyFail = answers.some(a => a?.result === "fail" || a?.pass === false);
                  const outcome = s?.status === "needs-follow-up" ? "NEEDS FOLLOW-UP" : (anyFail ? "FAIL" : "PASS");
                  const formTitle = s?.form?.title || s?.formTitle || s?.templateTitle || s?.templateName || "Form";
                  const inspector = usersById.get(String(s?.actor?.userId || ""))?.name
                    || s?.actor?.name || s?.actor?.email || "—";
                  const desc = escapeXml(`Date: ${when}\nForm: ${formTitle}\nOutcome: ${outcome}\nInspector: ${inspector}`);
                  return `
<Placemark>
  <name>${escapeXml(formTitle)}</name>
  <description>${desc}</description>
  <Point><coordinates>${r6(lng)},${r6(lat)},0</coordinates></Point>
</Placemark>`;
                }).join("");
                const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document><name>${escapeXml(title)}</name>${placemarks}</Document>
</kml>`;
                await downloadKMZ(`${title}.kmz`, kml);
                setInfo("Exported inspection submissions KMZ."); setTimeout(()=>setInfo(""), 1000);
              }}>Export Submissions KMZ</button>
            </div>
          </div>
          {subsErr && <div className="text-red-600 text-sm">{subsErr}</div>}
          {(subs.filter(s => !fltFrom && !fltTo ? true : inDateWindow(s?.submittedAt))).length ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50">
                  <th className="p-2 text-left">Submitted</th>
                  <th className="p-2 text-left">Form</th>
                  <th className="p-2 text-left">Outcome</th>
                  <th className="p-2 text-left">Inspector</th>
                  <th className="p-2 text-left">Lat</th>
                  <th className="p-2 text-left">Lng</th>
                  <th className="p-2 text-right">Actions</th>
                </tr>
              </thead>
                            <tbody>
                {subs
                  .filter(s => !fltFrom && !fltTo ? true : inDateWindow(s?.submittedAt || s?.createdAt || s?.updatedAt))
                  .map((s) => {
                    const { submitted, inspector, outcome, formTitle, lat, lng } = resolveSubmissionFields(s);
                    const whenText = submitted ? submitted.toLocaleString() : "—";
                    const latV = Number.isFinite(Number(lat)) ? r6(Number(lat)) : "—";
                    const lngV = Number.isFinite(Number(lng)) ? r6(Number(lng)) : "—";
                    return (
                      <tr key={s._id || s.id}>
                        <td className="border-t p-2">{whenText}</td>
                        <td className="border-t p-2">{formTitle}</td>
                        <td className="border-t p-2">
                          <span className={`px-2 py-0.5 rounded-full text-xs border ${outcome==="PASS"?"bg-green-50 text-green-700 border-green-200": outcome==="FAIL"?"bg-red-50 text-red-700 border-red-200":"bg-amber-50 text-amber-800 border-amber-200"}`}>
                            {outcome}
                          </span>
                        </td>
                        <td className="border-t p-2">{inspector}</td>
                        <td className="border-t p-2">{latV}</td>
                        <td className="border-t p-2">{lngV}</td>
                        <td className="border-t p-2 text-right">
                          <button
                            className="px-2 py-1 border rounded"
                            onClick={async ()=>{
                              try {
                                setSubViewErr(""); setSubView(s); // show fallback immediately
                                setSubViewOpen(true);

                                const subId = s._id || s.id;
                                const { data } = await api.get(`/inspections/submissions/${subId}`, {
                                  headers: { Accept: "application/json" }
                                });
                                if (data && typeof data === "object" && data.error) {
                                  throw new Error(data.error);
                                }
                                if (data && (Array.isArray(data.answers) || data.submittedAt || data.form || data.actor)) {
                                  setSubView(data);
                                } else {
                                  throw new Error("Missing token");
                                }
                              } catch (e) {
                                // Fallback to full Submission View page (like ProjectDetail)
                                try {
                                  const subId = s._id || s.id;
                                  window.open(`/inspections/submissions/${subId}`, "_blank", "noopener,noreferrer");
                                  setSubViewOpen(false);
                                } catch {}
                                setSubViewErr(e?.message || "Failed to load submission details.");
                              }
                            }}
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          ) : <div className="text-sm text-gray-600">No submissions in this date range.</div>}
        </div>
      </div>

      {/* Activity / Logs */}
      <div className="border rounded-2xl p-4 mt-4 bg-white">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Activity</div>
          <div className="flex items-center gap-3">
            <label className="text-sm flex items-center gap-1">
              <span className="text-gray-600">Sort:</span>
              <select
                className="border p-2 rounded"
                value={activitySort}
                onChange={(e)=>setActivitySort(e.target.value)}
              >
                <option value="desc">Newest first</option>
                <option value="asc">Oldest first</option>
              </select>
            </label>

            <div className="flex gap-2">
              <button className="px-3 py-2 border rounded" onClick={()=>{ 
                setEditingLogId(null);
                setLogErr("");
                setLogType("productivity");
                setLogAction("start");
                setLogAt(toLocalDateInputValue(new Date()));
                setLogNote("");
                setLogMilestoneId("");
                setLogOpen(true);
              }}>Add log entry</button>

              <button
  className="px-3 py-2 border rounded"
  onClick={async () => {
    const rows = (task.actualDurationLog || []).filter((e) =>
      !fltFrom && !fltTo ? true : inDateWindow(e.at)
    );
    if (!rows.length) {
      setErr("No activity rows in this date range.");
      return;
    }

    // Added lat/lng into the export
    const headers = ["when", "action", "milestone", "by", "lat", "lng", "note"];

    const csvLines = [headers.join(",")].concat(
      rows.map((e) => {
        const safe = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;

        const by =
          e.userId && (e.userId.name || e.userId.email)
            ? (e.userId.name || e.userId.email)
            : (e.actorName || e.actorEmail || e.actorSub || "");

        const rowMilestoneId =
          e.milestoneId ||
          e.milestone ||
          (e.meta && e.meta.milestoneId) ||
          "";
        const milestoneName = rowMilestoneId
          ? msTitleById.get(String(rowMilestoneId)) || String(rowMilestoneId)
          : "";

        const whenIso = e.at ? new Date(e.at).toISOString() : "";

        const latVal = Number.isFinite(Number(e.lat))
          ? r6(Number(e.lat))
          : "";
        const lngVal = Number.isFinite(Number(e.lng))
          ? r6(Number(e.lng))
          : "";

        return [
          safe(whenIso),
          safe(e.action),
          safe(milestoneName),
          safe(by),
          safe(latVal),
          safe(lngVal),
          safe(e.note || ""),
        ].join(",");
      })
    );

    const csv = csvLines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `activity_${(task?.title || id).replace(/[^\w\-]+/g, "_")}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }}
>
  Export Activity CSV
</button>

              <button
  className="px-3 py-2 border rounded"
  onClick={async () => {
    try {
      const { data } = await api.get(`/tasks/${id}/coverage`, { params: { limit: 500 } });

      const list =
        Array.isArray(data?.items) ? data.items :
        Array.isArray(data?.rows)  ? data.rows  :
        Array.isArray(data)        ? data      : [];

      let placemarks = "";

      // 1) Try coverage geometry from backend
      if (list.length) {
        const filtered = list.filter((c) =>
          !fltFrom && !fltTo ? true : inDateWindow(c?.date || c?.createdAt)
        );

        filtered.forEach((c, i) => {
          const name = c.title || c.filename || `Coverage ${i + 1}`;

          let geom =
            c.geometry ||
            c.geojson ||
            c.geoJSON ||
            (c.feature && c.feature.geometry) ||
            null;

          if (!geom) return;
          if (geom.type === "Feature" && geom.geometry) geom = geom.geometry;

          if (geom.type === "LineString" && Array.isArray(geom.coordinates)) {
            const coords = geom.coordinates
              .map(([lng, lat]) => `${r6(lng)},${r6(lat)},0`)
              .join(" ");
            placemarks += `
<Placemark>
  <name>${escapeXml(name)}</name>
  <LineString><coordinates>${coords}</coordinates></LineString>
</Placemark>`;
          } else if (geom.type === "Polygon" && Array.isArray(geom.coordinates) && geom.coordinates[0]) {
            const outer = geom.coordinates[0];
            const coords = outer
              .map(([lng, lat]) => `${r6(lng)},${r6(lat)},0`)
              .join(" ");
            placemarks += `
<Placemark>
  <name>${escapeXml(name)}</name>
  <Polygon>
    <outerBoundaryIs>
      <LinearRing><coordinates>${coords}</coordinates></LinearRing>
    </outerBoundaryIs>
  </Polygon>
</Placemark>`;
          }
        });
      }

      // 2) If no usable coverage from backend, FALL BACK to logs with lat/lng
      if (!placemarks.trim()) {
        const logsWithCoords = (task.actualDurationLog || []).filter((e) => {
          const hasCoords =
            Number.isFinite(Number(e.lat)) &&
            Number.isFinite(Number(e.lng));
          if (!hasCoords) return false;
          return !fltFrom && !fltTo ? true : inDateWindow(e.at);
        });

        if (!logsWithCoords.length) {
          setErr("No coverage uploaded yet and no logs with lat/lng in this date range.");
          return;
        }

        // Sort logs by time
        const sorted = logsWithCoords
          .slice()
          .sort((a, b) => +new Date(a.at || 0) - +new Date(b.at || 0));

        // 2a) One Point Placemark per log entry (gives you markers + info)
        sorted.forEach((e, idx) => {
          const when = e.at ? new Date(e.at).toLocaleString() : "—";

          const rowMilestoneId =
            e.milestoneId ||
            e.milestone ||
            (e.meta && e.meta.milestoneId) ||
            "";
          const milestoneName = rowMilestoneId
            ? msTitleById.get(String(rowMilestoneId)) || String(rowMilestoneId)
            : "";

          const name = `${e.action || "log"} #${idx + 1}`;
          const descText = [
            `When: ${when}`,
            milestoneName ? `Milestone: ${milestoneName}` : null,
            e.note ? `Note: ${e.note}` : null,
          ]
            .filter(Boolean)
            .join("\n");

          placemarks += `
<Placemark>
  <name>${escapeXml(name)}</name>
  <description>${escapeXml(descText)}</description>
  <Point><coordinates>${r6(e.lng)},${r6(e.lat)},0</coordinates></Point>
</Placemark>`;
        });

        // 2b) Optional LineString track joining all log points
        if (sorted.length > 1) {
          const coords = sorted
            .map((e) => `${r6(e.lng)},${r6(e.lat)},0`)
            .join(" ");

          placemarks += `
<Placemark>
  <name>${escapeXml((task?.title || id || "Task coverage") + " track")}</name>
  <LineString><coordinates>${coords}</coordinates></LineString>
</Placemark>`;
        }
      }

      if (!placemarks.trim()) {
        setErr("Coverage records were found, but no usable geometry could be created.");
        return;
      }

      const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escapeXml(task?.title || id)}</name>
    ${placemarks}
  </Document>
</kml>`;

      await downloadKMZ(
        `coverage_${(task?.title || id).replace(/[^\w\-]+/g, "_")}.kmz`,
        kml
      );
      setInfo("Exported coverage KMZ.");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }}
>
  Export Coverage KMZ
</button>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto mt-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="p-2 text-left">When</th>
                <th className="p-2 text-left">Action</th>
                <th className="p-2 text-left">Milestone</th>
                <th className="p-2 text-left">By</th>
                <th className="p-2 text-left">Note / Photo</th>
                <th className="p-2 text-right">Edit</th>
              </tr>
            </thead>
            <tbody>
              {(task.actualDurationLog || []).length ? (
                (task.actualDurationLog || [])
                  .filter(e => !fltFrom && !fltTo ? true : inDateWindow(e.at))
                  .slice()
                  .sort((a,b)=>{
                    const da = +new Date(a.at || 0);
                    const db = +new Date(b.at || 0);
                    return activitySort === "desc" ? db - da : da - db;
                  })
                  .map((e) => {
                    const rowId = String(e._id || "");
                    const by = (e.userId && (e.userId.name || e.userId.email))
                      ? (e.userId.name || e.userId.email)
                      : (e.actorName || e.actorEmail || e.actorSub || "—");

                    let thumb = null;
                    if (String(e.action) === "photo" && Array.isArray(task.attachments) && task.attachments.length) {
                      const at = +new Date(e.at || 0);
                      let best = null, bestDiff = Infinity;
                      for (const a of task.attachments) {
                        if (!(a?.mime || "").startsWith("image/")) continue;
                        const t = +new Date(a.uploadedAt || 0);
                        const d = Math.abs(t - at);
                        if (d < bestDiff) { bestDiff = d; best = a; }
                      }
                      if (best) {
                        const url = toAbsoluteUrl(best.url || best.downloadUrl || "");
                        thumb = (
                          <button
                            className="inline-block rounded overflow-hidden border"
                            title={best.filename || "Photo"}
                            onClick={()=>{ setImgSrc(url); setImgCaption(best.filename || "Photo"); setImgOpen(true); }}
                            style={{ width: 80, height: 60 }}
                          >
                            <img src={url} alt="photo" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          </button>
                        );
                      }
                    }

                    const rowMilestoneId =
                      e.milestoneId || e.milestone || (e.meta && e.meta.milestoneId) || "";
                    const milestoneName = rowMilestoneId
                      ? (msTitleById.get(String(rowMilestoneId)) || String(rowMilestoneId))
                      : "—";

                    return (
                      <tr key={rowId}>
                        <td className="border-t p-2">{e.at ? new Date(e.at).toLocaleString() : "—"}</td>
                        <td className="border-t p-2">{e.action}</td>
                        <td className="border-t p-2">{milestoneName}</td>
                        <td className="border-t p-2">{by}</td>
                        <td className="border-t p-2" style={{maxWidth: 480}}>
                          <div className="flex items-center gap-3">
                            {thumb}
                            <div className="whitespace-pre-wrap">{e.note || "—"}</div>
                          </div>
                        </td>
                        <td className="border-t p-2 text-right whitespace-nowrap">
                          <button
                            className="px-2 py-1 border rounded mr-2"
                            onClick={()=>{
                              setLogErr("");
                              setLogType(String(e.action) === "photo" ? "attachment" : "productivity");
                              setLogAction(["start","pause","resume","complete"].includes(String(e.action)) ? String(e.action) : "start");
                              setLogAt(toLocalDateInputValue(e.at));
                              setLogNote(e.note || "");
                              setLogMilestoneId(rowMilestoneId ? String(rowMilestoneId) : "");
                              setEditingLogId(rowId);
                              setLogOpen(true);
                            }}
                          >
                            Edit
                          </button>
                          <button className="px-2 py-1 border rounded" onClick={()=>{
                            if (!window.confirm("Delete this log entry?")) return;
                            (async ()=>{
                              try { await api.delete(`/tasks/${id}/logs/${rowId}`); await loadTask(); }
                              catch(er){ setErr(er?.response?.data?.error || String(er)); }
                            })();
                          }}>Delete</button>
                        </td>
                      </tr>
                    );
                  })
              ) : (
                <tr><td className="p-4 text-center" colSpan={6}>No progress yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add milestone modal */}
      <Modal
        open={msModalOpen}
        title="Add Milestone"
        onClose={()=>setMsModalOpen(false)}
        footer={
          <>
            <button className="px-3 py-2 border rounded" onClick={()=>setMsModalOpen(false)}>Cancel</button>
            <button className="px-3 py-2 border rounded" onClick={createMilestone}>Add</button>
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          <label className="text-sm md:col-span-2">Title
            <input className="border p-2 w-full rounded mt-1" value={msForm.title} onChange={e=>setMsForm({...msForm, title:e.target.value})} placeholder="Milestone title" />
          </label>
          <label className="text-sm">Start date
            <input className="border p-2 w-full rounded mt-1" type="date" value={msForm.startAt} onChange={e=>setMsForm({...msForm, startAt:e.target.value})} />
          </label>
          <label className="text-sm">End date
            <input className="border p-2 w-full rounded mt-1" type="date" value={msForm.endAt} onChange={e=>setMsForm({...msForm, endAt:e.target.value})} />
          </label>
          <label className="text-sm">Status
            <select className="border p-2 w-full rounded mt-1" value={msForm.status} onChange={e=>setMsForm({...msForm, status:e.target.value})}>
              {MS_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="text-sm inline-flex items-center gap-2">
            <input type="checkbox" checked={msForm.isRoadblock} onChange={e=>setMsForm({...msForm, isRoadblock: e.target.checked})} />
            Roadblock
          </label>
        </div>
      </Modal>

      {/* Add/Edit log modal */}
      <Modal
        open={logOpen}
        title={editingLogId ? "Edit Log Entry" : "Add Log Entry"}
        onClose={()=>{ setLogOpen(false); setEditingLogId(null); }}
        footer={
          <>
            <button className="px-3 py-2 border rounded" onClick={()=>{ setLogOpen(false); setEditingLogId(null); }}>Cancel</button>
            <button className="px-3 py-2 border rounded" onClick={submitLog}>Save</button>
          </>
        }
      >
        {logErr && <div className="text-red-600 text-sm">{logErr}</div>}
        <div className="space-y-3">
          <label className="text-sm">Type
            <select className="border p-2 w-full rounded mt-1" value={logType} onChange={e=>setLogType(e.target.value)}>
              <option value="productivity">Productivity (start/pause/resume/complete)</option>
              <option value="attachment">Photo</option>
            </select>
          </label>

          {logType === "productivity" && (
            <label className="text-sm">Action
              <select className="border p-2 w-full rounded mt-1" value={logAction} onChange={e=>setLogAction(e.target.value)}>
                <option value="start">start</option>
                <option value="pause">pause</option>
                <option value="resume">resume</option>
                <option value="complete">complete</option>
              </select>
            </label>
          )}

          <label className="text-sm">When
            <input
              className="border p-2 w-full rounded mt-1"
              type="datetime-local"
              value={logAt}
              onChange={e=>setLogAt(e.target.value)}
            />
          </label>

          <label className="text-sm">Milestone (optional)
            <select
              className="border p-2 w-full rounded mt-1"
              value={logMilestoneId}
              onChange={(e)=>setLogMilestoneId(e.target.value)}
            >
              <option value="">— none —</option>
              {(milestones || []).map(ms => (
                <option key={ms._id || ms.id} value={ms._id || ms.id}>
                  {ms.title || "Milestone"}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">Note
            <textarea
              className="border p-2 w-full rounded mt-1"
              rows={3}
              value={logNote}
              onChange={e=>setLogNote(e.target.value)}
              placeholder={logType === "attachment" ? "Optional note about the photo…" : "Optional note…"}
            />
          </label>

          {logType === "attachment" && !editingLogId && (
            <label className="text-sm">Photo
              <input
                className="border p-2 w-full rounded mt-1"
                type="file"
                accept="image/*"
                onChange={(e)=>setLogFile(e.target.files?.[0] || null)}
              />
              {logFile && (
                <div className="text-xs text-gray-600 mt-1">
                  Selected: <span className="font-medium">{logFile.name}</span>
                </div>
              )}
            </label>
          )}

          <div className="text-xs text-gray-600">
            Location is already enforced for Start/Resume when enabled on the task.
          </div>
        </div>
      </Modal>

      {/* Image lightbox */}
      <Modal
        open={imgOpen}
        title={imgCaption || "Photo"}
        onClose={()=>setImgOpen(false)}
        size="xl"
        footer={<button className="px-3 py-2 border rounded" onClick={()=>setImgOpen(false)}>Close</button>}
      >
        <div className="w-full">
          {imgSrc ? <img src={imgSrc} alt={imgCaption||"photo"} className="max-h-[70vh] w-auto mx-auto" /> : "No image"}
        </div>
      </Modal>

      {/* Submission viewer lightbox */}
      <Modal
        open={subViewOpen}
        title={subView?.form?.title || subView?.formTitle || subView?.templateTitle || "Submission"}
        onClose={()=>setSubViewOpen(false)}
        size="xl"
        footer={<button className="px-3 py-2 border rounded" onClick={()=>setSubViewOpen(false)}>Close</button>}
      >
        {subViewErr && <div className="text-red-600 text-sm">{subViewErr}</div>}
        {subView ? (
          <div className="space-y-2 text-sm">
            <div className="text-gray-600">
              Submitted: {subView.submittedAt ? new Date(subView.submittedAt).toLocaleString() : "—"}
              {" • "}
              Inspector: {usersById.get(String(subView?.actor?.userId || ""))?.name
                || subView?.actor?.name || subView?.actor?.email || "—"}
              {" • "}
              Manager note: {subView?.managerNote || subView?.note || subView?.meta?.managerNote || "—"}
            </div>
            {Array.isArray(subView.answers) && subView.answers.length ? (
              <div className="space-y-1">
                {subView.answers.map((a, i)=>(
                  <div key={i} className="border rounded p-2">
                    <div className="font-medium">{a?.label || a?.question || `Q${i+1}`}</div>
                    <div className="text-gray-700 whitespace-pre-wrap">
                      {typeof a?.value === "string" ? a.value : JSON.stringify(a?.value ?? "", null, 2)}
                    </div>
                  </div>
                ))}
              </div>
            ) : <div className="text-gray-600">No answers on this submission.</div>}
          </div>
        ) : <div className="text-sm text-gray-600">Loading…</div>}
      </Modal>
    </div>
  );
}
