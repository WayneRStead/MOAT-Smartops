// src/pages/TaskDetail.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";

const ACTIONS = ["start", "pause", "resume", "complete"];
const PRIORITIES = ["low", "medium", "high"];

function toLocalDateInputValue(date) {
  if (!date) return "";
  const d = new Date(date);
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0, 16);
}
function toLocalDateOnly(date) {
  if (!date) return "";
  const d = new Date(date);
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

/* ---------------- URL normalizer (fix :5173 & /files/docs) ---------------- */
function apiBaseOrigin() {
  const base = api?.defaults?.baseURL || "";
  // e.g. http://localhost:5000/api -> http://localhost:5000
  return base.replace(/\/api\/?$/i, "");
}
function toAbsoluteUrl(u) {
  if (!u) return "";
  let url = String(u);

  // Fix legacy prefixes coming back from some places
  if (url.startsWith("/files/docs/")) {
    url = url.replace(/^\/files\/docs\//, "/documents/");
  }
  if (url.startsWith("/files/vault/")) {
    url = url.replace(/^\/files\/vault\//, "/documents/");
  }

  // Already absolute?
  if (/^https?:\/\//i.test(url)) return url;

  // Root-relative -> prefix backend origin
  if (url.startsWith("/")) {
    return apiBaseOrigin() + url;
  }

  // Fallback as-is
  return url;
}

function CheckBadge({ ok, label, title }) {
  const cls = ok
    ? "bg-green-100 text-green-800 border-green-300"
    : "bg-gray-100 text-gray-700 border-gray-300";
  const icon = ok ? "✅" : "—";
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border ${cls}`}
      title={title}
      aria-label={`${label}: ${ok ? "enabled" : "off"}`}
    >
      <span>{icon}</span>
      <span className="font-medium">{label}</span>
    </span>
  );
}

/** Safe lazy wrapper for the map */
function SafeGeoFencePreview({
  projectId,
  taskId,
  height = 320,
  className = "",
  reloadKey,
  showTaskCoverage = true,
  fallbackCircle = null,
  taskCircle = null,
  allowPicking = false,
  onPickLocation,
  extraFences = [],
  legend = false,
  projectStyle,
  taskStyle,
  onLoaded,
}) {
  const [Loaded, setLoaded] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let mounted = true;
    import("../components/GeoFencePreview")
      .then((m) => mounted && setLoaded(() => m.default))
      .catch(() => mounted && setErr("Map preview unavailable (leaflet not installed)."));
    return () => { mounted = false; };
  }, []);
  if (err) return <div className="flex items-center justify-center rounded text-sm text-gray-600" style={{height}}>{err}</div>;
  if (!Loaded) return <div className="flex items-center justify-center bg-gray-100 rounded text-sm text-gray-600" style={{height}}>Loading map…</div>;
  return (
    <Loaded
      projectId={projectId}
      taskId={taskId}
      showTaskCoverage={showTaskCoverage}
      height={height}
      className={className}
      reloadKey={reloadKey}
      fallbackCircle={fallbackCircle}
      taskCircle={taskCircle}
      allowPicking={allowPicking}
      onPickLocation={onPickLocation}
      extraFences={extraFences}
      legend={legend}
      projectStyle={projectStyle}
      taskStyle={taskStyle}
      onLoaded={onLoaded}
    />
  );
}

export default function TaskDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [task, setTask] = useState(null);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);

  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [saving, setSaving] = useState(false);
  const lastGoodTaskRef = useRef(null);

  // Editable fields (local mirrors for inline UI)
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [dueAt, setDueAt] = useState(""); // YYYY-MM-DD
  const [projectId, setProjectId] = useState("");
  const [assignee, setAssignee] = useState("");
  const [tags, setTags] = useState("");

  // Add-log
  const [newAction, setNewAction] = useState("start");
  const [newAt, setNewAt] = useState(toLocalDateInputValue(new Date()));
  const [newNote, setNewNote] = useState("");

  // Inline edit log
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

  // Geofences summary
  const [gfCount, setGfCount] = useState(0);
  const [gfSource, setGfSource] = useState("none");
  const [taskFenceApi, setTaskFenceApi] = useState("unknown"); // 'unknown' | 'present' | 'absent'

  // Map styling + downloads + reload control
  const [taskStroke, setTaskStroke] = useState("#b45309");
  const [taskFill, setTaskFill]     = useState("#f59e0b");
  const [taskDash, setTaskDash]     = useState("6,4");
  const [projectStroke, setProjectStroke] = useState("#1e3a8a");
  const [projectFill, setProjectFill]     = useState("#60a5fa");
  const [mapBump, setMapBump] = useState(0);
  const [dlProject, setDlProject] = useState([]);
  const [dlTask, setDlTask]       = useState([]);

  // Edit toggle
  const [editOpen, setEditOpen] = useState(false);

  // ---- Refs / lookups ----
  useEffect(() => {
    (async () => {
      try {
        const [p, u] = await Promise.all([
          api.get("/projects", { params: { limit: 1000 } }),
          api.get("/users", { params: { limit: 1000 } }),
        ]);
        setProjects(Array.isArray(p.data) ? p.data : []);
        setUsers(Array.isArray(u.data) ? u.data : []);
      } catch { /* ignore */ }
    })();
  }, []);

  const usersById = useMemo(() => {
    const m = new Map();
    users.forEach(u => m.set(String(u._id), u));
    return m;
  }, [users]);
  const userLabel = (u) => {
    if (!u) return "—";
    const id = String(u._id || u);
    const populated = (u && (u.name || u.email)) ? u : usersById.get(id);
    return populated ? (populated.name || populated.email || populated.username || id) : id;
  };
  const projectLabel = (pid) => {
    const p = projects.find(pr => String(pr._id) === String(pid));
    return p?.name || "—";
  };

  // ---- Normalize fences payload ----
  function normalizeFencesPayload(data) {
    if (Array.isArray(data?.geoFences)) return data.geoFences;
    if (Array.isArray(data?.fences)) return data.fences;
    if (Array.isArray(data)) return data;
    return [];
  }

  // ---- Compute effective fences ----
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
        if (e?.response?.status === 404) {
          setTaskFenceApi("absent");
        }
      }
    }

    if (pid) {
      try {
        const p = await api.get(`/projects/${pid}/geofences`);
        const pf = normalizeFencesPayload(p.data);
        setGfCount(pf.length);
        setGfSource(pf.length ? "project" : "none");
        return;
      } catch { /* ignore */ }
    }

    setGfCount(0);
    setGfSource("none");
  }

  // ---- Load task ----
  async function load() {
    setErr(""); setInfo("");
    try {
      const { data } = await api.get(`/tasks/${id}`);
      setTask(data || null);
      lastGoodTaskRef.current = data || null;

      // seed inline controls
      setTitle(data?.title || "");
      setDescription(data?.description || "");
      setPriority(data?.priority || "medium");
      setDueAt(toLocalDateOnly(data?.dueAt) || "");
      setProjectId(data?.projectId || "");
      const a = data?.assignee || (Array.isArray(data?.assignedTo) && data.assignedTo.length ? data.assignedTo[0] : "");
      setAssignee(a ? String(a._id || a) : "");
      setTags(Array.isArray(data?.tags) ? data.tags.join(", ") : "");

      setEnforceLocationCheck(!!data?.enforceLocationCheck);
      setEnforceQRScan(!!data?.enforceQRScan);
      setLat(data?.locationGeoFence?.lat ?? "");
      setLng(data?.locationGeoFence?.lng ?? "");
      setRadius(data?.locationGeoFence?.radius ?? "");

      await computeEffectiveFences(id, data?.projectId || "");
      setMapBump((b) => b + 1);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);

  // ---- Optimistic inline save helper ----
  async function optimisticSave(patch, applyLocal) {
    setErr("");
    setSaving(true);
    const prev = lastGoodTaskRef.current;
    try {
      if (applyLocal) applyLocal();
      const { data } = await api.put(`/tasks/${id}`, patch);
      setTask(data);
      lastGoodTaskRef.current = data;
      setSaving(false);
    } catch (e) {
      if (prev) setTask(prev);
      setSaving(false);
      setErr(e?.response?.data?.error || String(e));
    }
  }

  // ---- Geofencing helpers ----
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

  const taskPoint =
    lat && lng
      ? [{ type: "point", point: { lat: Number(lat), lng: Number(lng) } }]
      : [];

  function handlePick({ lat: L, lng: G }) {
    setLat(L.toFixed(6));
    setLng(G.toFixed(6));
    if (!radius) setRadius(50);
    setInfo(`Pin set at ${L.toFixed(6)}, ${G.toFixed(6)} — click “Save pin & enforcement” to persist.`);
    setTimeout(() => setInfo(""), 2000);
  }

  async function saveGeofence(e) {
    e?.preventDefault?.();
    setErr(""); setInfo("");
    try {
      const gf = (lat !== "" && lng !== "") ? {
        lat: Number(lat),
        lng: Number(lng),
        radius: radius !== "" ? Number(radius) : 50,
      } : undefined;

      const { data } = await api.put(`/tasks/${id}`, {
        enforceLocationCheck,
        enforceQRScan,
        locationGeoFence: gf,
      });
      setTask(data);
      lastGoodTaskRef.current = data;
      await computeEffectiveFences(id, data?.projectId || "");
      setMapBump(b=>b+1);
      setInfo("Pin & enforcement saved.");
      setTimeout(() => setInfo(""), 1200);
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }

  // ---- Actions / Logs / Attachments ----
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
      setInfo(`Action: ${action}`);
      setTimeout(() => setInfo(""), 1000);
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
  }

  async function addLog(e) {
    e?.preventDefault?.();
    setErr(""); setInfo("");
    try {
      const body = { action: newAction, at: fromLocalDateTimeInput(newAt), note: newNote || "" };
      await api.post(`/tasks/${id}/logs`, body);
      await load();
      setInfo("Log added.");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
  }
  function beginEdit(row) {
    setEditId(String(row._id));
    setEditAction(row.action);
    setEditAt(toLocalDateInputValue(row.at));
    setEditNote(row.note || "");
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

  async function uploadPhoto(e) {
    e?.preventDefault?.();
    setFileErr(""); setInfo("");
    try {
      if (!file) return setFileErr("Choose an image first.");
      const fd = new FormData();
      fd.append("file", file);
      if (fileNote) fd.append("note", fileNote);
      await api.post(`/tasks/${id}/attachments`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await load();
      setInfo("Photo uploaded."); setTimeout(() => setInfo(""), 1000);
    } catch (e) {
      setFileErr(e?.response?.data?.error || String(e));
    }
  }
  async function deleteAttachment(attId) {
    if (!window.confirm("Delete this attachment?")) return;
    setErr(""); setInfo("");
    try {
      await api.delete(`/tasks/${id}/attachments/${attId}`);
      await load();
      setInfo("Attachment deleted."); setTimeout(() => setInfo(""), 1000);
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
  }

  // ---- Effective fences refresh ----
  async function refreshEffectiveFences() {
    setErr("");
    await computeEffectiveFences(id, projectId);
    setMapBump((b) => b + 1);
  }

  const savingDot = saving ? <span className="ml-2 text-xs text-gray-500">Saving…</span> : null;

  if (!task) return <div className="p-4">{err ? err : "Loading…"}</div>;

  const actualMins = task.actualDurationMinutes ?? 0;
  const estMins = task.estimatedDuration ?? null;
  const delta = estMins != null ? actualMins - estMins : null;

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold">Task Detail</h1>
        </div>
        <div className="flex gap-2">
          <button className="px-3 py-2 border rounded" onClick={() => setEditOpen(v => !v)}>
            {editOpen ? "Close edit" : "Edit"}
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
            <div className="text-sm"><b>Due:</b> {task.dueAt ? new Date(task.dueAt).toLocaleDateString() : "—"}</div>
            <div className="text-sm"><b>Project:</b>{" "}
              {task.projectId ? <Link className="underline" to={`/projects/${task.projectId}`}>{projectLabel(task.projectId)}</Link> : "—"}
            </div>
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

            <label className="text-sm">
              Due date
              <input
                className="border p-2 w-full"
                type="date"
                value={dueAt}
                onChange={(e) => {
                  const v = e.target.value;
                  setDueAt(v);
                  const iso = fromLocalDateOnly(v);
                  if ((iso || "") !== (lastGoodTaskRef.current?.dueAt || "")) {
                    optimisticSave(
                      { dueAt: iso || null },
                      () => setTask((t) => ({ ...(t||{}), dueAt: iso || null }))
                    );
                  }
                }}
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

            <label className="text-sm">
              Assignee
              <select
                className="border p-2 w-full"
                value={assignee}
                onChange={(e) => {
                  const v = e.target.value;
                  setAssignee(v);
                  const payload = { assignee: v || null };
                  optimisticSave(
                    payload,
                    () => setTask((t) => ({ ...(t||{}), assignee: v || null }))
                  );
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
                      { tags: arr },
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
          className="rounded"
          reloadKey={`${mapBump}:${gfCount}:${lat}:${lng}:${radius}:${taskStroke}:${taskFill}:${taskDash}:${projectStroke}:${projectFill}`}
          fallbackCircle={fallbackCircle}
          taskCircle={taskCircle}
          extraFences={[]}
          allowPicking={true}
          legend={true}
          projectStyle={{
            color: projectStroke,
            fillColor: projectFill,
            fillOpacity: 0.08,
            weight: 2,
          }}
          taskStyle={{
            color: taskStroke,
            fillColor: taskFill,
            fillOpacity: 0.12,
            weight: 2,
            dashArray: taskDash || null,
          }}
          onPickLocation={({ lat: L, lng: G }) => {
            handlePick({ lat: L, lng: G });
          }}
          onLoaded={({ projectFences, taskFences }) => {
            setDlProject(projectFences || []);
            setDlTask(taskFences || []);
          }}
        />

        {/* Style controls + downloads */}
        <div className="grid md:grid-cols-2 gap-3">
          {/* Task style */}
          <div className="border rounded p-2">
            <div className="text-sm font-medium mb-2">Task fence style</div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                Stroke
                <input type="color" className="ml-2 align-middle" value={taskStroke}
                  onChange={(e) => { setTaskStroke(e.target.value); setMapBump(b => b+1); }} />
              </label>
              <label className="text-sm">
                Fill
                <input type="color" className="ml-2 align-middle" value={taskFill}
                  onChange={(e) => { setTaskFill(e.target.value); setMapBump(b => b+1); }} />
              </label>
              <label className="text-sm">
                Dash
                <select className="border p-2 ml-2"
                  value={taskDash}
                  onChange={(e)=>{ setTaskDash(e.target.value); setMapBump(b => b+1); }}>
                  <option value="">solid</option>
                  <option value="4,4">4,4</option>
                  <option value="6,4">6,4</option>
                  <option value="8,4">8,4</option>
                  <option value="2,6">2,6</option>
                </select>
              </label>
            </div>
          </div>

          {/* Project style */}
          <div className="border rounded p-2">
            <div className="text-sm font-medium mb-2">Project fence style</div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                Stroke
                <input type="color" className="ml-2 align-middle" value={projectStroke}
                  onChange={(e) => { setProjectStroke(e.target.value); setMapBump(b => b+1); }} />
              </label>
              <label className="text-sm">
                Fill
                <input type="color" className="ml-2 align-middle" value={projectFill}
                  onChange={(e) => { setProjectFill(e.target.value); setMapBump(b => b+1); }} />
              </label>
            </div>
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
                    setLat(pos.coords.latitude.toFixed(6));
                    setLng(pos.coords.longitude.toFixed(6));
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

        <form onSubmit={uploadPhoto} className="flex flex-wrap items-end gap-3">
          <label className="text-sm" style={{ minWidth: 260 }}>
            File
            <input className="border p-2 w-full" type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
          <label className="text-sm" style={{ flex: 1, minWidth: 220 }}>
            Note
            <input className="border p-2 w-full" placeholder="Optional note for this photo" value={fileNote} onChange={(e) => setFileNote(e.target.value)} />
          </label>
          <button className="px-3 py-2 border rounded" type="submit">Add</button>
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
                      <img src={url} alt={att.filename || "attachment"} style={{ width: "100%", height: "100%", objectFit: "cover" }}
                           onError={(e) => { e.currentTarget.style.display = "none"; const p = e.currentTarget.parentElement; if (p) p.innerHTML = "<div style='font-size:40px'>📄</div>"; }} />
                    ) : (<div className="text-4xl" aria-hidden>📄</div>)}
                  </div>
                </a>
                <div className="p-2 text-xs">
                  <div className="font-medium truncate" title={att.filename}>{att.filename || "Attachment"}</div>
                  {uploadedAt && <div className="text-gray-600">{uploadedAt}</div>}
                  {att.uploadedBy && <div className="text-gray-600">by {att.uploadedBy}</div>}
                  {att.note && (
                    <div className="text-gray-700 mt-1" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }} title={att.note}>
                      {att.note}
                    </div>
                  )}
                </div>
                <div className="p-2 pt-0 text-right">
                  <button className="px-2 py-1 border rounded" onClick={() => deleteAttachment(att._id)} type="button">Delete</button>
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
