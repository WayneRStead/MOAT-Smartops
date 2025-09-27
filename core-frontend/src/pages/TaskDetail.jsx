// src/pages/TaskDetail.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import GroupSelect from "../components/GroupSelect.jsx";
import MilestonesBlock from "../components/MilestonesBlock.jsx";
import InspectionsBlock from "../components/InspectionsBlock.jsx";

const ACTIONS = ["start", "pause", "resume", "complete"];
const PRIORITIES = ["low", "medium", "high", "urgent"];

// Milestone statuses aligned with MilestonesBlock / Gantt
const MS_STATUSES = ["pending", "started", "paused", "paused - problem", "finished"];

/* ------------ Date helpers ------------ */
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
function isSameStr(a, b) { return String(a ?? "") === String(b ?? ""); }

/* ---------------- Status canonizer (map legacy names to Gantt names) ---------------- */
function canonStatus(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (["finished","complete","completed","closed","done"].includes(s)) return "finished";
  if (["paused - problem","paused-problem","problem","blocked","block","issue"].includes(s)) return "paused - problem";
  if (["paused","pause","on hold","on-hold","hold"].includes(s)) return "paused";
  if (["started","start","in-progress","in progress","open","active","running"].includes(s)) return "started";
  return "pending";
}

/* ---------------- URL normalizer ---------------- */
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

/* ---------------- KML / KMZ / GeoJSON export helpers (unchanged) ---------------- */
const PREC = 6;
const r6 = (n) => Number.parseFloat(Number(n).toFixed(PREC));
function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
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
function fencesToGeoJSON(name, fences) {
  const features = [];
  (fences || []).forEach((f, idx) => {
    const rings = fenceToRings(f); if (!rings.length) return;
    features.push({
      type: "Feature",
      properties: { name: `Fence ${idx + 1}`, source: f.source || f._src || "ui", label: f.label || undefined },
      geometry: { type: "Polygon", coordinates: [rings[0]] },
    });
  });
  return { type: "FeatureCollection", name: name || "Fences", features };
}
function safeFileName(s) {
  return String(s || "export").replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}
function downloadTextFile(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
async function downloadKMZ(filename, kmlString) {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file("doc.kml", kmlString);
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/** ------------ Simple parsers to import fences client-side (fallback) ----------- */
async function readFileAsText(file) {
  const buf = await file.arrayBuffer();
  const td = new TextDecoder("utf-8");
  return td.decode(buf);
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
async function parseKMZToRings(file) {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const kmlEntry = Object.values(zip.files).find((f) => /\.kml$/i.test(f.name));
  if (!kmlEntry) return [];
  const kmlText = await kmlEntry.async("text");
  return parseKMLToRings(kmlText);
}

/** Safe lazy wrapper for the map */
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

/* ---------------- Normalize server task shape ---------------- */
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

  // Derive start from fields/logs
  const firstStartFromLog =
    Array.isArray(t?.actualDurationLog)
      ? (t.actualDurationLog
          .filter(e => ["start","resume"].includes(String(e.action)))
          .map(e => e.at)
          .sort()[0] || null)
      : null;
  const startDate = t.startDate ?? t.startAt ?? firstStartFromLog ?? null;

  // assignee
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

/* -------------- Utility getters --------------- */
const getAssigneeIdFromTask = (task) => {
  if (!task) return "";
  const cand =
    task.assignee ??
    (Array.isArray(task.assignedTo) && task.assignedTo[0]) ??
    (Array.isArray(task.assignedUserIds) && task.assignedUserIds[0]) ??
    null;
  return idOf(cand);
};
const getDueLocalDateFromTask = (task) => {
  const iso = task?.dueAt ?? task?.dueDate ?? task?.deadlineAt ?? task?.endAt ?? null;
  return toLocalDateOnly(iso);
};
const getStartLocalDateFromTask = (task) => {
  const iso = task?.startDate ?? task?.startAt ?? task?.scheduledAt ?? null;
  return toLocalDateOnly(iso);
};

/* ---------------- API helpers: PUT first, PATCH fallback ---------------- */
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

/* ---------------- Milestone normalizer ---------------- */
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

/* ---------------- Component ---------------- */
export default function TaskDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [task, setTask] = useState(null);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);

  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [saving, setSaving] = useState(false);
  const lastGoodTaskRef = useRef(null);

  const saveGateRef = useRef({ assignee: false, start: false, due: false });

  const [toast, setToast] = useState(null);
  const showToast = (text) => { setToast(text); setTimeout(() => setToast(null), 1800); };

  // Editable (task)
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [startOn, setStartOn] = useState(""); // local YYYY-MM-DD
  const [dueAt, setDueAt] = useState("");     // local YYYY-MM-DD
  const [projectId, setProjectId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [assignee, setAssignee] = useState("");
  const [tags, setTags] = useState("");

  // Logs
  const [newAction, setNewAction] = useState("start");
  const [newAt, setNewAt] = useState(toLocalDateInputValue(new Date()));
  const [newNote, setNewNote] = useState("");
  const [editId, setEditId] = useState(null);
  const [editAction, setEditAction] = useState("start");
  const [editAt, setEditAt] = useState("");
  const [editNote, setEditNote] = useState("");

  // Attachments
  const [file, setFile] = useState(null);
  const [fileNote, setFileNote] = useState("");
  const [fileErr, setFileErr] = useState("");

  // Location / QR
  const [enforceLocationCheck, setEnforceLocationCheck] = useState(false);
  const [enforceQRScan, setEnforceQRScan] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [radius, setRadius] = useState("");

  // Fences summary
  const [gfCount, setGfCount] = useState(0);
  const [gfSource, setGfSource] = useState("none");
  const [taskFenceApi, setTaskFenceApi] = useState("unknown");

  // Map styling
  const [taskStroke] = useState("#9c0b12ff");
  const [taskFill]   = useState("#e96666ff");
  const [taskDash]   = useState("6,4");
  const [projectStroke] = useState("#1e3a8a");
  const [projectFill]   = useState("#60a5fa");
  const [mapBump, setMapBump] = useState(0);
  const [dlProject, setDlProject] = useState([]);
  const [dlTask, setDlTask]       = useState([]);

  const [projFormat, setProjFormat] = useState("auto");
  const [taskFormat, setTaskFormat] = useState("auto");
  const [comboFormat, setComboFormat] = useState("auto");
  const [projNameOverride, setProjNameOverride] = useState("");
  const [taskNameOverride, setTaskNameOverride] = useState("");
  const [comboNameOverride, setComboNameOverride] = useState("");
  const [exporting, setExporting] = useState(null);

  const [editOpen, setEditOpen] = useState(false);

  // Geofence upload
  const [gfFile, setGfFile] = useState(null);
  const [gfUploading, setGfUploading] = useState(false);
  const [gfUploadErr, setGfUploadErr] = useState("");

  const [extraFences, setExtraFences] = useState([]);

  // ---------- Milestones ----------
  const [milestones, setMilestones] = useState([]);
  const [mErr, setMErr] = useState("");
  const [mInfo, setMInfo] = useState("");
  const [mReloadKey, setMReloadKey] = useState(0); // force Gantt remount after saves

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

  // Build a PATCH/PUT body compatible with varied backends
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
    if ("isRoadblock" in patch) {
      const b = !!patch.isRoadblock;
      out.isRoadblock = b; out.roadblock = b;
    }
    if ("dependsOn" in patch) {
      const arr = patch.dependsOn ? [String(patch.dependsOn)] : [];
      out.dependsOn = arr; out.requires = arr; out.dependencies = arr;
    }
    if ("actualEndAt" in patch) {
      const a = patch.actualEndAt || null;
      out.endActual = a; out.actualEndAt = a; out.completedAt = a;
    }
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
      // fallback to plain /milestones/:id
      try {
        await api.patch(`/milestones/${ms._id}`, payload);
      } catch (e3) {
        if (e3?.response?.status === 405) await api.put(`/milestones/${ms._id}`, payload);
        else throw e3;
      }
    }
  }

  // Lookups
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
  const groupLabel = (gid) => {
    const g = gid ? groupsById.get(String(gid)) : null;
    return g?.name || "—";
  };

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
          setExtraFences([]);
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
        setExtraFences([]);
        return;
      } catch {}
    }
    setGfCount(0); setGfSource("none"); setExtraFences([]);
  }

  async function load() {
    setErr(""); setInfo("");
    try {
      const { data } = await api.get(`/tasks/${id}`);
      const norm = normalizeTask(data || null);
      setTask(norm);
      lastGoodTaskRef.current = norm;

      setTitle(norm?.title || "");
      setDescription(norm?.description || "");
      setPriority(norm?.priority || "medium");
      setStartOn(toLocalDateOnly(norm?.startDate || norm?.startAt) || "");
      setDueAt(toLocalDateOnly(norm?.dueAt) || "");
      setProjectId(norm?.projectId || "");

      const seedGid =
        (norm?.groupId && String(norm.groupId)) ||
        (Array.isArray(norm?.assignedGroupIds) && norm.assignedGroupIds.length ? String(norm.assignedGroupIds[0]) : "");
      setGroupId(seedGid || "");

      const a = norm?.assignee || (Array.isArray(norm?.assignedTo) && norm.assignedTo.length ? norm.assignedTo[0] : "");
      setAssignee(a ? String(a._id || a) : "");
      setTags(Array.isArray(norm?.tags) ? norm.tags.join(", ") : "");

      setEnforceLocationCheck(!!norm?.enforceLocationCheck);
      setEnforceQRScan(!!norm?.enforceQRScan);
      setLat(norm?.locationGeoFence?.lat ?? "");
      setLng(norm?.locationGeoFence?.lng ?? "");
      setRadius(norm?.locationGeoFence?.radius ?? "");

      await computeEffectiveFences(id, norm?.projectId || "");
      setMapBump((b) => b + 1);
    } catch (e) {
      const msg = e?.response?.data?.error || e?.message || String(e);
      setErr(msg);
      console.error("Load task failed:", e?.response?.data || e);
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);
  useEffect(() => { loadMilestones(); /* eslint-disable-next-line */ }, [id]);

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

  /* ---------------- Safe single-endpoint saves (assignee, start, due) ---------------- */
  async function saveAssigneeOnce(nextAssigneeIdRaw) {
    const nextAssigneeId = String(nextAssigneeIdRaw || "");
    const current = lastGoodTaskRef.current;
    if (!current) return;

    const currentId = getAssigneeIdFromTask(current);
    if (String(currentId || "") === String(nextAssigneeId || "")) return;
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

    const haveLocal = getStartLocalDateFromTask(current) || "";
    if (String(haveLocal) === String(nextLocalDateStr || "")) return;
    if (saveGateRef.current.start) return;

    const iso = nextLocalDateStr ? fromLocalDateOnly(nextLocalDateStr) : null;

    saveGateRef.current.start = true;
    try {
      await optimisticSave(
        { startDate: iso || null, startAt: iso || null },
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

    const haveLocal = getDueLocalDateFromTask(current) || "";
    if (String(haveLocal) === String(nextLocalDateStr || "")) return;
    if (saveGateRef.current.due) return;

    const iso = nextLocalDateStr ? fromLocalDateOnly(nextLocalDateStr) : null;

    saveGateRef.current.due = true;
    try {
      await optimisticSave(
        { dueAt: iso || null, dueDate: nextLocalDateStr || null, deadlineAt: iso || null },
        () => setTask((t) => ({ ...(t || {}), dueAt: iso || null }))
      );
      setInfo("Due date saved."); setTimeout(()=>setInfo(""), 1000);
    } finally {
      saveGateRef.current.due = false;
    }
  }

  async function savePendingEditsThenClose() {
    if (!editOpen) { setEditOpen(true); return; }
    const prev = lastGoodTaskRef.current || {};

    // sticky fields
    const wantA = String(assignee || "");
    const haveA = String(getAssigneeIdFromTask(prev) || "");
    if (wantA !== haveA) await saveAssigneeOnce(wantA);

    const wantS = String(startOn || "");
    const haveS = String(getStartLocalDateFromTask(prev) || "");
    if (wantS !== haveS) await saveStartOnce(wantS);

    const wantD = String(dueAt || "");
    const haveD = String(getDueLocalDateFromTask(prev) || "");
    if (wantD !== haveD) await saveDueOnce(wantD);

    const patch = {};
    const applyLocal = {};

    if (!isSameStr(title, prev.title)) { patch.title = title?.trim() || ""; applyLocal.title = patch.title; }
    if (!isSameStr(priority, prev.priority)) { patch.priority = priority; applyLocal.priority = priority; }
    if (!isSameStr(projectId, prev.projectId)) { patch.projectId = projectId || null; applyLocal.projectId = patch.projectId; }
    const prevG = prev.groupId ? String(prev.groupId) : "";
    if (!isSameStr(groupId, prevG)) {
      patch.groupId = groupId || null; patch.assignedGroupIds = groupId ? [groupId] : [];
      applyLocal.groupId = patch.groupId; applyLocal.assignedGroupIds = patch.assignedGroupIds;
    }
    const tagArr = tags.split(",").map(s => s.trim()).filter(Boolean);
    const prevTags = Array.isArray(prev.tags) ? prev.tags : [];
    if (JSON.stringify(tagArr) !== JSON.stringify(prevTags)) {
      patch.tags = tagArr; patch.labels = tagArr; applyLocal.tags = tagArr;
    }
    if (!isSameStr(description, prev.description)) { patch.description = description || ""; applyLocal.description = patch.description; }

    if (!Object.keys(patch).length) { setEditOpen(false); return; }
    await optimisticSave(patch, () => setTask(t => ({ ...(t || {}), ...applyLocal })));
    setEditOpen(false);
  }

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

  const taskCircle =
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
      console.error("Save geofence failed:", raw || e2);
    }
  }

  async function uploadTaskFences() {
    setGfUploadErr("");
    if (!gfFile) { setGfUploadErr("Choose a .geojson, .kml or .kmz file first."); return; }
    setGfUploading(true);
    try {
      try {
        const fd = new FormData();
        fd.append("file", gfFile);
        await api.post(`/tasks/${id}/geofences/upload`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      } catch (e) {
        const status = e?.response?.status;
        if (status && status !== 404) throw e;
        const name = (gfFile.name || "").toLowerCase();
        let rings = [];
        if (name.endsWith(".geojson") || name.endsWith(".json")) {
          const text = await readFileAsText(gfFile);
          const obj = JSON.parse(text);
          rings = parseGeoJSONToRings(obj);
        } else if (name.endsWith(".kml")) {
          const text = await readFileAsText(gfFile);
          rings = parseKMLToRings(text);
        } else if (name.endsWith(".kmz")) {
          rings = await parseKMZToRings(gfFile);
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
      setGfFile(null);
      showToast("Fences updated");
    } catch (e) {
      setGfUploadErr(e?.response?.data?.error || e?.message || String(e));
    } finally {
      setGfUploading(false);
    }
  }

  async function clearTaskFences() {
    if (!window.confirm("Remove all task-specific fences? (Project fences, if any, will still apply)")) return;
    setGfUploadErr("");
    try {
      try { await api.delete(`/tasks/${id}/geofences`); }
      catch { await api.post(`/tasks/${id}/geofences/clear`); }
      await computeEffectiveFences(id, projectId);
      setMapBump(b => b + 1);
      showToast("Task fences cleared");
    } catch (e) {
      setGfUploadErr(e?.response?.data?.error || e?.message || String(e));
    }
  }

  async function doAction(action) {
    setErr(""); setInfo("");
    try {
      const body = { action };
      if ((action === "start" || action === "resume") && task?.enforceLocationCheck) {
        const coords = await new Promise((resolve) => {
          if (!navigator.geolocation) return resolve(null);
          navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            () => resolve(null),
            { enableHighAccuracy: true, maximumAge: 10000, timeout: 8000 }
          );
        });
        if (coords) { body.lat = coords.lat; body.lng = coords.lng; }
      }
      await api.post(`/tasks/${id}/action`, body);
      await load();
      setInfo(`Action: ${action}`); setTimeout(() => setInfo(""), 1000);
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
  }

  async function addLog(e) {
    e?.preventDefault?.(); setErr(""); setInfo("");
    try {
      const body = { action: newAction, at: fromLocalDateTimeInput(newAt), note: newNote || "" };
      await api.post(`/tasks/${id}/logs`, body);
      await load();
      setInfo("Log added."); setTimeout(() => setInfo(""), 1000);
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
  }
  function beginEdit(row) {
    setEditId(String(row._id)); setEditAction(row.action); setEditAt(toLocalDateInputValue(row.at)); setEditNote(row.note || "");
  }
  function cancelEdit() {
    setEditId(null); setEditAction("start"); setEditAt(""); setEditNote("");
  }
  async function saveEdit(e) {
    e?.preventDefault?.();
    if (!editId) return;
    setErr(""); setInfo("");
    try {
      const body = { action: editAction, at: fromLocalDateTimeInput(editAt), note: editNote };
      await api.patch(`/tasks/${id}/logs/${editId}`, body);
      await load();
      setInfo("Log updated."); setTimeout(() => setInfo(""), 1000);
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
  }
  async function deleteLog(rowId) {
    if (!window.confirm("Delete this log entry?")) return;
    setErr(""); setInfo("");
    try {
      await api.delete(`/tasks/${id}/logs/${rowId}`);
      await load();
      setInfo("Log deleted."); setTimeout(() => setInfo(""), 1000);
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
  }

  async function refreshEffectiveFences() {
    setErr(""); await computeEffectiveFences(id, projectId); setMapBump((b) => b + 1);
  }

  function nameForProject() {
    const name = projectLabel(projectId) || String(projectId || "project");
    return `project_${safeFileName(name)}`;
  }
  function nameForTask() {
    const name = task?.title || String(id || "task");
    return `task_${safeFileName(name)}`;
  }
  function nameForCombo() {
    const p = projectLabel(projectId) || "project";
    const t = task?.title || "task";
    return `fences_${safeFileName(p)}_${safeFileName(t)}`;
  }
  function autoOr(format) { return (format && format !== "auto") ? format : "kml"; }

  async function exportFences(kind, fences, format, nameOverride, defaultName) {
    if (!fences?.length) return;
    const effective = autoOr(format);
    const base = nameOverride?.trim() || defaultName;
    try {
      if (effective === "geojson") {
        const fc = fencesToGeoJSON(base, fences);
        downloadTextFile(`${base}.geojson`, "application/geo+json", JSON.stringify(fc, null, 2));
        showToast(`Exported as GeoJSON (${base}.geojson)`); return;
      }
      if (effective === "kml") {
        const kml = fencesToKML(base, fences);
        downloadTextFile(`${base}.kml`, "application/vnd.google-earth.kml+xml", kml);
        showToast(`Exported as KML (${base}.kml)`); return;
      }
      if (effective === "kmz") {
        setExporting(kind);
        const kml = fencesToKML(base, fences);
        await downloadKMZ(`${base}.kmz`, kml);
        setExporting(null);
        showToast(`Exported as KMZ (${base}.kmz)`); return;
      }
    } catch (e) {
      setExporting(null);
      const msg = e?.message || String(e);
      if (/jszip/i.test(msg) || /Cannot find module 'jszip'/.test(msg)) {
        alert("KMZ export requires the 'jszip' package.\nInstall with: npm i jszip\n\n" + msg);
      } else {
        alert("Export failed: " + msg);
      }
    }
  }
  async function exportCombined(format, nameOverride) {
    const both = [...(dlProject || []), ...(dlTask || [])];
    if (!both.length) return;
    const base = nameOverride?.trim() || nameForCombo();
    const effective = autoOr(format);
    try {
      if (effective === "geojson") {
        const fc = fencesToGeoJSON(base, both);
        downloadTextFile(`${base}.geojson`, "application/geo+json", JSON.stringify(fc, null, 2));
        showToast(`Exported as GeoJSON (${base}.geojson)`); return;
      }
      if (effective === "kml") {
        const kml = fencesToKML(base, both);
        downloadTextFile(`${base}.kml`, "application/vnd.google-earth.kml+xml", kml);
        showToast(`Exported as KML (${base}.kml)`); return;
      }
      if (effective === "kmz") {
        setExporting("combo");
        const kml = fencesToKML(base, both);
        await downloadKMZ(`${base}.kmz`, kml);
        setExporting(null);
        showToast(`Exported as KMZ (${base}.kmz)`); return;
      }
    } catch (e) {
      setExporting(null);
      const msg = e?.message || String(e);
      if (/jszip/i.test(msg) || /Cannot find module 'jszip'/.test(msg)) {
        alert("KMZ export requires the 'jszip' package.\nInstall with: npm i jszip\n\n" + msg);
      } else {
        alert("Export failed: " + msg);
      }
    }
  }

  const savingDot = saving ? <span className="ml-2 text-xs text-gray-500">Saving…</span> : null;

  if (!task) return <div className="p-4">{err ? err : "Loading…"}</div>;

  const actualMins = task.actualDurationMinutes ?? 0;
  const estMins = task.estimatedDuration ?? null;
  const delta = estMins != null ? actualMins - estMins : null;
  const displayGroupId =
    task?.groupId ||
    (Array.isArray(task?.assignedGroupIds) && task.assignedGroupIds.length ? task.assignedGroupIds[0] : null);

  return (
    <div className="p-4 space-y-4">
      {toast && (
        <div className="fixed bottom-4 right-4 bg-black text-white text-sm px-3 py-2 rounded shadow-md z-50">
          {toast}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">Task Detail</h1>
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-2 border rounded" onClick={savePendingEditsThenClose}>
            {editOpen ? "Save & close" : "Edit"}
          </button>
          <button className="px-3 py-2 border rounded" onClick={() => navigate(-1)}>Back</button>
        </div>
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      {/* Summary / Inline Edit */}
      <div className="border rounded p-3 space-y-2">
        {!editOpen ? (
          <>
            <div className="text-sm"><b>Title:</b> {task.title}</div>
            <div className="text-sm"><b>Priority:</b> {task.priority}</div>
            <div className="text-sm">
              <b>Start:</b>{" "}
              {(task.startDate || task.startAt)
                ? new Date(task.startDate || task.startAt).toLocaleDateString()
                : "—"}
            </div>
            <div className="text-sm"><b>Due:</b> {task.dueAt ? new Date(task.dueAt).toLocaleDateString() : "—"}</div>
            <div className="text-sm"><b>Project:</b>{" "}
              {task.projectId ? <Link className="underline" to={`/projects/${task.projectId}`}>{projectLabel(task.projectId)}</Link> : "—"}
            </div>
            <div className="text-sm"><b>Group:</b> {displayGroupId ? groupLabel(displayGroupId) : "—"}</div>
            <div className="text-sm"><b>Assignee:</b>{" "}
              {task.assignee ? userLabel(task.assignee)
                : (Array.isArray(task.assignedTo) && task.assignedTo.length ? userLabel(task.assignedTo[0]) : "—")}
            </div>
            {(task.tags || []).length > 0 && (
              <div className="text-xs text-gray-600"><b>Tags:</b> {(task.tags || []).join(", ")}</div>
            )}
            {task.description && (<div className="text-sm whitespace-pre-wrap">{task.description}</div>)}
            <div className="text-sm">
              <b>Estimated vs Actual:</b>{" "}
              {estMins != null ? `${estMins}m` : "—"} vs {actualMins}m
              {delta != null && (
                <span className={delta <= 0 ? "text-green-700" : "text-red-700"}>
                  {" "}({Math.abs(delta)}m {delta <= 0 ? "ahead" : "behind"})
                </span>
              )}
            </div>
          </>
        ) : (
          <form className="grid md:grid-cols-2 gap-3" onSubmit={(e)=>e.preventDefault()}>
            <label className="text-sm md:col-span-2">
              Title {savingDot}
              <input
                className="border p-2 w-full"
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

            <label className="text-sm">
              Priority
              <select
                className="border p-2 w-full"
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

            {/* Start date (date-only) */}
            <label className="text-sm">
              Start date
              <input
                className="border p-2 w-full"
                type="date"
                value={startOn}
                onChange={(e) => setStartOn(e.target.value)}
                onBlur={() => saveStartOnce(startOn)}
              />
            </label>

            {/* Due date (date-only) */}
            <label className="text-sm">
              Due date
              <input
                className="border p-2 w-full"
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
                onBlur={() => saveDueOnce(dueAt)}
              />
            </label>

            <label className="text-sm">
              Project
              <select
                className="border p-2 w-full"
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
                {projects.map(p => (
                  <option key={p._id} value={p._id}>{p.name}</option>
                ))}
              </select>
            </label>

            {/* Group selector */}
            <label className="text-sm">
              Group
              <div className="mt-1">
                <GroupSelect
                  value={groupId || null}
                  onChange={(gid) => {
                    const gidStr = gid ? String(gid) : "";
                    setGroupId(gidStr);
                    const patch = {
                      groupId: gid || null,
                      assignedGroupIds: gid ? [gid] : [],
                    };
                    optimisticSave(
                      patch,
                      () => setTask((t) => ({
                        ...(t || {}),
                        groupId: gid || null,
                        assignedGroupIds: gid ? [gid] : [],
                      }))
                    );
                  }}
                  placeholder="(optional) assign a group"
                />
              </div>
            </label>

            <label className="text-sm">
              Assignee
              <select
                className="border p-2 w-full"
                value={assignee}
                onChange={async (e) => {
                  const v = e.target.value;
                  setAssignee(v);
                  await saveAssigneeOnce(v);
                }}
              >
                <option value="">— none —</option>
                {users.map(u => (
                  <option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>
                ))}
              </select>
            </label>

            <label className="text-sm md:col-span-2">
              Tags (comma)
              <input
                className="border p-2 w-full"
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

            <label className="text-sm md:col-span-2">
              Description
              <textarea
                className="border p-2 w-full"
                rows={4}
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

            <div className="md:col-span-2 text-xs text-gray-600">
              Changes save automatically {savingDot}
            </div>
          </form>
        )}
      </div>

      {/* Milestones timeline (Gantt) */}
      <MilestonesBlock
        key={`${id}:${mReloadKey}`} // remount after each list save
        taskId={id}
        taskStartAt={task?.startAt || task?.startDate || task?.scheduledAt || null}
        taskEndAt={task?.dueAt || task?.dueDate || null}
        taskDueAt={task?.dueAt || null}
      />

      {/* Milestones LIST — inline-edit, date-only, auto-save, shows Actual end */}
      <div className="border rounded p-3 space-y-3">
        <div className="font-semibold">Milestones</div>
        {mErr && <div className="text-red-600">{mErr}</div>}
        {mInfo && <div className="text-green-700">{mInfo}</div>}

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
                      setMReloadKey(k => k + 1); // refresh Gantt instantly
                      setMInfo("Milestone saved."); setTimeout(()=>setMInfo(""), 1000);
                    } catch (e) {
                      setMErr(e?.response?.data?.error || String(e));
                    }
                  };

                  return (
                    <tr key={mid}>
                      {/* Title: uncontrolled input, save on blur */}
                      <td className="border-t p-2" style={{minWidth:220}}>
                        <input
                          className="border p-2 w-full"
                          defaultValue={ms.title || ""}
                          onBlur={(e)=>{
                            const v = (e.target.value || "").trim();
                            if (v !== (ms.title || "")) saveWrap({ title: v });
                          }}
                          placeholder="Milestone title"
                        />
                      </td>

                      {/* Start date: date-only, save on blur */}
                      <td className="border-t p-2" style={{minWidth:150}}>
                        <input
                          className="border p-2"
                          type="date"
                          defaultValue={toLocalDateOnly(ms.startAt)}
                          onBlur={(e)=>{
                            const v = e.target.value;
                            if (toLocalDateOnly(ms.startAt) !== v) {
                              const iso = fromLocalDateOnly(v);
                              saveWrap({ startAt: iso });
                            }
                          }}
                        />
                      </td>

                      {/* End date: date-only, save on blur */}
                      <td className="border-t p-2" style={{minWidth:150}}>
                        <input
                          className="border p-2"
                          type="date"
                          defaultValue={toLocalDateOnly(ms.dueAt)}
                          onBlur={(e)=>{
                            const v = e.target.value;
                            if (toLocalDateOnly(ms.dueAt) !== v) {
                              const iso = fromLocalDateOnly(v);
                              saveWrap({ endAt: iso });
                            }
                          }}
                        />
                      </td>

                      {/* Actual end (read-only; set auto when status -> finished) */}
                      <td className="border-t p-2" style={{minWidth:150}}>
                        {ms.actualEndAt ? new Date(ms.actualEndAt).toLocaleDateString() : "—"}
                      </td>

                      {/* Status: select; onChange saves immediately; ensures canon status; auto-sets actualEndAt if finishing */}
                      <td className="border-t p-2" style={{minWidth:160}}>
                        <select
                          className="border p-2"
                          defaultValue={canonStatus(ms.status)}
                          onChange={(e)=>{
                            const next = canonStatus(e.target.value);
                            if (next !== canonStatus(ms.status)) saveWrap({ status: next });
                          }}
                        >
                          {MS_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </td>

                      {/* Is roadblock: checkbox, save on change */}
                      <td className="border-t p-2" style={{minWidth:130}}>
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            defaultChecked={!!ms.isRoadblock}
                            onChange={(e)=> saveWrap({ isRoadblock: e.target.checked })}
                          />
                          <span className="text-xs text-gray-700">Roadblock</span>
                        </label>
                      </td>

                      {/* Roadblock dependency: select single (only roadblocks), save on change */}
                      <td className="border-t p-2" style={{minWidth:240}}>
                        <select
                          className="border p-2 w-full"
                          defaultValue={ms.dependsOn ? String(ms.dependsOn) : ""}
                          onChange={(e)=>{
                            const v = e.target.value || "";
                            // only allow selecting a roadblock (list is already filtered)
                            const next = v ? v : null;
                            const prev = ms.dependsOn ? String(ms.dependsOn) : "";
                            if (String(next || "") !== prev) saveWrap({ dependsOn: next });
                          }}
                        >
                          <option value="">— none —</option>
                          {rbOptions.map(opt => (
                            <option key={opt._id || opt.id} value={opt._id || opt.id}>
                              {opt.title || "Untitled"} (roadblock)
                            </option>
                          ))}
                        </select>
                      </td>

                      {/* Delete */}
                      <td className="border-t p-2 text-right whitespace-nowrap" style={{minWidth:120}}>
                        <button
                          className="px-2 py-1 border rounded"
                          onClick={async ()=>{
                            if (!window.confirm("Delete this milestone?")) return;
                            try {
                              setMErr(""); setMInfo("");
                              try { await api.delete(`/tasks/${id}/milestones/${mid}`); }
                              catch { await api.delete(`/milestones/${mid}`); }
                              await loadMilestones();
                              setMReloadKey(k => k + 1);
                              setMInfo("Milestone deleted."); setTimeout(()=>setMInfo(""), 1000);
                            } catch (e) {
                              setMErr(e?.response?.data?.error || String(e));
                            }
                          }}
                          type="button"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              {!milestones.length && <tr><td className="p-4 text-center" colSpan={8}>No milestones yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {/* Visibility & Access */}
      <div className="border rounded p-3 space-y-3">
        <div className="font-semibold">Visibility & Access</div>

        <label className="text-sm">
          Mode
          <select
            className="border p-2 w-full"
            value={task.visibilityMode || "org"}
            onChange={(e) => {
              const v = e.target.value;
              optimisticSave(
                { visibilityMode: v },
                () => setTask((t) => ({ ...(t || {}), visibilityMode: v }))
              );
            }}
          >
            <option value="org">Everyone in org</option>
            <option value="assignees">Assigned users only</option>
            <option value="groups">Assigned groups only</option>
            <option value="assignees+groups">Users or Groups</option>
          </select>
        </label>

        <label className="text-sm">
          Assigned users
          <select
            multiple
            className="border p-2 w-full"
            value={(task.assignedUserIds || []).map(String)}
            onChange={(e) => {
              const vals = Array.from(e.target.selectedOptions).map(o => o.value);
              optimisticSave(
                { assignedUserIds: vals },
                () => setTask((t) => ({ ...(t||{}), assignedUserIds: vals }))
              );
            }}
          >
            {users.map(u => (
              <option key={u._id} value={u._id}>
                {u.name || u.email || u.username || u._id}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          Assigned groups
          <select
            multiple
            className="border p-2 w-full"
            value={(task.assignedGroupIds || []).map(String)}
            onChange={(e) => {
              const vals = Array.from(e.target.selectedOptions).map(o => o.value);
              optimisticSave(
                { assignedGroupIds: vals },
                () => setTask((t) => ({ ...(t||{}), assignedGroupIds: vals }))
              );
            }}
          >
            {groups.map(g => (
              <option key={g._id} value={g._id}>{g.name}</option>
            ))}
          </select>
        </label>

        <div className="text-xs text-gray-600">
          <div>• <b>Everyone in org</b>: visible to all users in the org.</div>
          <div>• <b>Assigned users only</b>: only users listed above can see the task.</div>
          <div>• <b>Assigned groups only</b>: only members of selected groups can see it.</div>
          <div>• <b>Users or Groups</b>: visible if the viewer is either assigned individually, or is in one of the selected groups.</div>
        </div>
      </div>

      <InspectionsBlock taskId={id} taskDueAt={task?.dueAt || task?.dueDate || null} />

      {/* Geofencing + Map */}
      <div className="border rounded p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Geofencing</div>
          <div className="text-sm text-gray-600">
            Effective fences: <b>{gfCount}</b> <span className="ml-2">source: <i>{gfSource}</i></span>
          </div>
        </div>

        <SafeGeoFencePreview
          projectId={task.projectId}
          taskId={taskFenceApi === "present" ? id : undefined}
          showTaskCoverage={true}
          height={320}
          className="relative rounded mb-3 z-0"
          reloadKey={`${mapBump}:${gfCount}:${lat}:${lng}:${radius}:${taskStroke}:${taskFill}:${taskDash}:${projectStroke}:${projectFill}`}
          fallbackCircle={fallbackCircle}
          taskCircle={taskCircle}
          extraFences={extraFences}
          allowPicking={true}
          legend={true}
          projectStyle={{ color: projectStroke, fillColor: projectFill, fillOpacity: 0.08, weight: 2 }}
          taskStyle={{ color: taskStroke, fillColor: taskFill, fillOpacity: 0.12, weight: 2, dashArray: taskDash || null }}
          onPickLocation={({ lat: L, lng: G }) => {
            setLat(L.toFixed(PREC)); setLng(G.toFixed(PREC));
            if (!radius) setRadius(50);
            setInfo(`Pin set at ${L.toFixed(PREC)}, ${G.toFixed(PREC)} — click “Save pin & enforcement” to persist.`);
            setTimeout(()=>setInfo(""),2000);
          }}
          onLoaded={({ projectFences, taskFences }) => {
            setDlProject(projectFences || []);
            setDlTask(taskFences || []);
          }}
          canToggleTask={false}
        />

        {/* Export fences */}
        <div className="border rounded p-2 mt-2 relative z-50">
          <div className="text-sm font-medium mb-2">Export fences</div>

          {/* Project export */}
          <div className="border rounded p-2 mt-2" style={{ position: "relative", zIndex: 1 }}>
            <button
              className="px-3 py-2 border rounded disabled:opacity-50"
              disabled={!dlProject?.length || exporting === "project"}
              onClick={() => exportFences("project", dlProject, projFormat, projNameOverride, nameForProject())}
              type="button"
            >
              {exporting === "project" ? "Exporting…" : "Export Project"}
            </button>
            <select className="border p-2" value={projFormat} onChange={(e)=>setProjFormat(e.target.value)}>
              <option value="auto">Auto</option>
              <option value="kml">KML</option>
              <option value="kmz">KMZ</option>
              <option value="geojson">GeoJSON</option>
            </select>
            <input className="border p-2" style={{ minWidth: 180 }} placeholder={nameForProject()} value={projNameOverride} onChange={(e)=>setProjNameOverride(e.target.value)} />
          </div>

          {/* Task export */}
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <button
              className="px-3 py-2 border rounded disabled:opacity-50"
              disabled={!dlTask?.length || exporting === "task"}
              onClick={() => exportFences("task", dlTask, taskFormat, taskNameOverride, nameForTask())}
              type="button"
            >
              {exporting === "task" ? "Exporting…" : "Export Task"}
            </button>
            <select className="border p-2" value={taskFormat} onChange={(e)=>setTaskFormat(e.target.value)}>
              <option value="auto">Auto</option>
              <option value="kml">KML</option>
              <option value="kmz">KMZ</option>
              <option value="geojson">GeoJSON</option>
            </select>
            <input className="border p-2" style={{ minWidth: 180 }} placeholder={nameForTask()} value={taskNameOverride} onChange={(e)=>setTaskNameOverride(e.target.value)} />
          </div>

          {/* Combined export */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="px-3 py-2 border rounded disabled:opacity-50"
              disabled={!(dlProject?.length || dlTask?.length) || exporting === "combo"}
              onClick={() => exportCombined(comboFormat, comboNameOverride)}
              type="button"
            >
              {exporting === "combo" ? "Exporting…" : "Export Combined"}
            </button>
            <select className="border p-2" value={comboFormat} onChange={(e)=>setComboFormat(e.target.value)}>
              <option value="auto">Auto</option>
              <option value="kml">KML</option>
              <option value="kmz">KMZ</option>
              <option value="geojson">GeoJSON</option>
            </select>
            <input className="border p-2" style={{ minWidth: 220 }} placeholder={nameForCombo()} value={comboNameOverride} onChange={(e)=>setComboNameOverride(e.target.value)} />
          </div>

          {!dlProject?.length && !dlTask?.length && (
            <div className="text-xs text-gray-600 mt-2">
              No fences available yet — set a task pin or add project fences to enable export.
            </div>
          )}
        </div>

        {/* Upload / Clear Task Fences */}
        <div className="border rounded p-2">
          <div className="text-sm font-medium mb-2">Upload / Replace task fences</div>
          {gfUploadErr && <div className="text-sm text-red-600 mb-2">{gfUploadErr}</div>}
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm" style={{ minWidth: 260 }}>
              File (.geojson, .kml, .kmz)
              <input className="border p-2 w-full" type="file" accept=".geojson,.json,.kml,.kmz" onChange={(e) => setGfFile(e.target.files?.[0] || null)} />
            </label>
            <button className="px-3 py-2 border rounded disabled:opacity-50" onClick={uploadTaskFences} disabled={!gfFile || gfUploading} type="button">
              {gfUploading ? "Uploading…" : "Upload fences"}
            </button>
            <button className="px-3 py-2 border rounded" onClick={clearTaskFences} type="button">Clear task fences</button>
          </div>
          <div className="text-xs text-gray-600 mt-2">
            We’ll try your server endpoint <code>/tasks/:id/geofences/upload</code> first; if it isn’t available, we parse the file client-side and send normalized polygons.
          </div>
        </div>

        <form onSubmit={saveGeofence} className="space-y-3">
          <div className="flex flex-wrap gap-4 items-center">
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={enforceLocationCheck} onChange={e => setEnforceLocationCheck(e.target.checked)} />
              Enforce location check (on start/resume)
            </label>
            <label className="text-sm flex items-center gap-2">
              <input type="checkbox" checked={enforceQRScan} onChange={e => setEnforceQRScan(e.target.checked)} />
              Require QR before start
            </label>
            <button className="px-3 py-2 border rounded" type="submit">Save pin &amp; enforcement</button>
            <button className="px-3 py-2 border rounded" type="button" onClick={refreshEffectiveFences}>Refresh</button>
          </div>

          <div className="grid md:grid-cols-4 gap-2">
            <label className="text-sm">Lat
              <input className="border p-2 w-full" value={lat} onChange={e=>setLat(e.target.value)} placeholder="-33.123456" />
            </label>
            <label className="text-sm">Lng
              <input className="border p-2 w-full" value={lng} onChange={e=>setLng(e.target.value)} placeholder="18.654321" />
            </label>
            <label className="text-sm">Radius (m)
              <input className="border p-2 w-full" type="number" min="5" value={radius} onChange={e=>setRadius(e.target.value)} placeholder="50" />
            </label>
            <div className="flex items-end gap-2">
              <button type="button" className="px-3 py-2 border rounded" onClick={()=>{
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
              <a className="px-3 py-2 border rounded"
                 href={lat && lng ? `https://www.google.com/maps?q=${lat},${lng}` : undefined}
                 target="_blank" rel="noreferrer"
                 onClick={(e)=>{ if(!(lat && lng)) e.preventDefault(); }}>
                Open in Maps
              </a>
            </div>
          </div>
        </form>

        <div className="text-xs text-gray-600">
          Tip: If task has no fences, it will automatically inherit from its project (if any).
        </div>
      </div>

      {/* Attachments */}
      <div className="border rounded p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Attachments</div>
        </div>

        {fileErr && <div className="text-red-600 text-sm">{fileErr}</div>}

        <form onSubmit={(e)=>{e.preventDefault();}} className="flex flex-wrap items-end gap-3">
          <label className="text-sm" style={{ minWidth: 260 }}>
            File
            <input className="border p-2 w-full" type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
          <label className="text-sm" style={{ flex: 1, minWidth: 220 }}>
            Note
            <input className="border p-2 w-full" placeholder="Optional note for this photo" value={fileNote} onChange={(e) => setFileNote(e.target.value)} />
          </label>
          <button
            className="px-3 py-2 border rounded"
            onClick={async (e) => {
              e.preventDefault();
              setFileErr(""); setInfo("");
              try {
                if (!file) return setFileErr("Choose an image first.");
                const fd = new FormData();
                fd.append("file", file);
                if (fileNote) fd.append("note", fileNote);
                await api.post(`/tasks/${id}/attachments`, fd, { headers: { "Content-Type": "multipart/form-data" } });
                await load();
                setInfo("Photo uploaded."); setTimeout(() => setInfo(""), 1000);
                setFile(null); setFileNote("");
              } catch (e2) { setFileErr(e2?.response?.data?.error || String(e2)); }
            }}
            type="button"
          >
            Add
          </button>
        </form>

        <div className="flex flex-wrap gap-3">
          {(task.attachments || []).length === 0 && (<div className="text-sm text-gray-600">No attachments yet.</div>)}
          {(task.attachments || []).map((att) => {
            const isImage = (att.mime || "").startsWith("image/");
            const url = toAbsoluteUrl(att.url || att.downloadUrl || "");
            const uploadedAt = att.uploadedAt ? new Date(att.uploadedAt).toLocaleString() : "";
            return (
              <div key={att._id || att.url} className="border rounded overflow-hidden bg-white" style={{ width: 160 }}>
                <a href={url} target="_blank" rel="noopener noreferrer" className="block" title={att.filename || "Open attachment"}>
                  <div className="bg-gray-100" style={{ width: "100%", height: 110, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                    {isImage ? (
                      <img
                        src={url}
                        alt={att.filename || "attachment"}
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                          const p = e.currentTarget.parentElement;
                          if (p) p.innerHTML = "<div style='font-size:40px'>📄</div>";
                        }}
                      />
                    ) : (<div className="text-4xl" aria-hidden>📄</div>)}
                  </div>
                </a>
                <div className="p-2 text-xs">
                  <div className="font-medium truncate" title={att.filename}>{att.filename || "Attachment"}</div>
                  {uploadedAt && <div className="text-gray-600">{uploadedAt}</div>}
                  {att.uploadedBy && <div className="text-gray-600">by {att.uploadedBy}</div>}
                  {att.note && (
                    <div
                      className="text-gray-700 mt-1"
                      style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
                      title={att.note}
                    >
                      {att.note}
                    </div>
                  )}
                </div>
                <div className="p-2 pt-0 text-right">
                  <button className="px-2 py-1 border rounded" onClick={async () => {
                    if (!window.confirm("Delete this attachment?")) return;
                    setErr(""); setInfo("");
                    try { await api.delete(`/tasks/${id}/attachments/${att._id}`); await load(); setInfo("Attachment deleted."); setTimeout(()=>setInfo(""), 1000); }
                    catch (e2) { setErr(e2?.response?.data?.error || String(e2)); }
                  }} type="button">Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Add manual log */}
      <form onSubmit={addLog} className="border rounded p-3 space-y-2">
        <div className="font-semibold">Add log entry</div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">Action
            <select className="border p-2 ml-2" value={newAction} onChange={e=>setNewAction(e.target.value)}>
              {["start","pause","resume","complete","photo"].map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="text-sm">When
            <input className="border p-2 ml-2" type="datetime-local" value={newAt} onChange={e=>setNewAt(e.target.value)} />
          </label>
          <label className="text-sm" style={{ flex: 1, minWidth: 220 }}>Note
            <input className="border p-2 ml-2 w-full" value={newNote} onChange={e=>setNewNote(e.target.value)} placeholder="Optional note..." />
          </label>
          <button className="px-3 py-2 border rounded" type="submit">Add</button>
        </div>
      </form>

      {/* Progress log */}
      <div className="border rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="p-2 text-left">When</th>
              <th className="p-2 text-left">Action</th>
              <th className="p-2 text-left">By</th>
              <th className="p-2 text-left">Note</th>
              <th className="p-2 text-right">Edit</th>
            </tr>
          </thead>
          <tbody>
            {(task.actualDurationLog || []).length ? (
              (task.actualDurationLog || []).map((e) => {
                const rowId = String(e._id || "");
                const by = (e.userId && (e.userId.name || e.userId.email))
                  ? (e.userId.name || e.userId.email)
                  : (e.actorName || e.actorEmail || e.actorSub || "—");
                const isEditing = editId === rowId;
                return (
                  <tr key={rowId}>
                    <td className="border-t p-2">
                      {isEditing ? (
                        <input className="border p-2" type="datetime-local" value={editAt} onChange={ev => setEditAt(ev.target.value)} />
                      ) : (e.at ? new Date(e.at).toLocaleString() : "—")}
                    </td>
                    <td className="border-t p-2">
                      {isEditing ? (
                        <select className="border p-2" value={editAction} onChange={ev=>setEditAction(ev.target.value)}>
                          {["start","pause","resume","complete","photo"].map(a => <option key={a} value={a}>{a}</option>)}
                        </select>
                      ) : e.action}
                    </td>
                    <td className="border-t p-2">{by}</td>
                    <td className="border-t p-2" style={{maxWidth: 360}}>
                      {isEditing ? (
                        <input className="border p-2 w-full" value={editNote} onChange={ev => setEditNote(ev.target.value)} placeholder="Optional note…" />
                      ) : (e.note || "—")}
                    </td>
                    <td className="border-t p-2 text-right whitespace-nowrap">
                      {isEditing ? (
                        <>
                          <button className="px-2 py-1 border rounded mr-2" onClick={saveEdit}>Save</button>
                          <button className="px-2 py-1 border rounded" onClick={cancelEdit} type="button">Cancel</button>
                        </>
                      ) : (
                        <>
                          <button className="px-2 py-1 border rounded mr-2" onClick={() => beginEdit(e)} type="button">Edit</button>
                          <button className="px-2 py-1 border rounded" onClick={() => deleteLog(rowId)} type="button">Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr><td className="p-4 text-center" colSpan={5}>No progress yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
