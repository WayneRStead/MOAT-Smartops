// src/pages/Tasks.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useTheme } from "../ThemeContext";

const STATUSES   = ["pending","in-progress","paused","completed"];
const PRIORITIES = ["low","medium","high"];

export default function Tasks() {
  const { org } = useTheme();

  const [rows, setRows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);

  // filters
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [projectId, setProjectId] = useState("");
  const [userId, setUserId] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");

  // quick create
  const [form, setForm] = useState({
    title: "", description: "", status: "pending", priority: "medium",
    dueAt: "", projectId: "", assignee: "", estimatedDuration: "", tags: "",
    enforceLocationCheck: false,   // NEW
    enforceQRScan: false           // NEW
  });

  // geofence-at-create (optional)
  const [gfFile, setGfFile] = useState(null);
  const [gfRadius, setGfRadius] = useState(50);

  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [warnings, setWarnings] = useState([]); // NEW

  // --- Quick Presets from org ---
  const quickPresets = useMemo(() => {
    const raw = org?.taskPresets ?? org?.tasks?.quickPresets ?? [];
    const toTagsString = (t) => Array.isArray(t) ? t.join(", ") : (t || "");
    return (Array.isArray(raw) ? raw : [])
      .map((p, idx) => {
        if (typeof p === "string") return { key: `p_${idx}`, title: p, tags: "", priority: "" };
        const title = (p?.label || p?.title || "").trim();
        const tags = toTagsString(p?.tags);
        const priority = (p?.priority || "").trim();
        return { key: `p_${idx}`, title, tags, priority };
      })
      .filter(p => p.title);
  }, [org]);

  function applyPreset(p) {
    setForm((f) => ({
      ...f,
      title: p.title || f.title,
      tags: p.tags ?? f.tags,
      priority: PRIORITIES.includes(p.priority) ? p.priority : f.priority,
    }));
  }

  async function loadRefs() {
    try {
      const [p, u] = await Promise.all([
        api.get("/projects", { params: { limit: 1000 } }),
        api.get("/users", { params: { limit: 1000 } }),
      ]);
      setProjects(Array.isArray(p.data) ? p.data : []);
      setUsers(Array.isArray(u.data) ? u.data : []);
    } catch {
      setProjects([]); setUsers([]);
    }
  }

  async function load() {
    setErr(""); setInfo(""); setWarnings([]);
    try {
      const params = { limit: 500 };
      if (q) params.q = q;
      if (status) params.status = status;
      if (priority) params.priority = priority;
      if (projectId) params.projectId = projectId;
      if (userId) params.userId = userId;
      if (dueFrom) params.dueFrom = dueFrom;
      if (dueTo) params.dueTo = dueTo;
      const { data } = await api.get("/tasks", { params });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  useEffect(() => { loadRefs(); load(); }, []);

  async function create(e) {
    e.preventDefault();
    setErr(""); setInfo(""); setWarnings([]);
    try {
      const payload = {
        title: (form.title || "").trim(),
        description: form.description || "",
        status: form.status,
        priority: form.priority,
        dueAt: form.dueAt || undefined,
        projectId: form.projectId || undefined,
        assignee: form.assignee || undefined,
        estimatedDuration:
          form.estimatedDuration !== "" && Number.isFinite(Number(form.estimatedDuration))
            ? Number(form.estimatedDuration)
            : undefined,
        tags: (form.tags || "").split(",").map(s=>s.trim()).filter(Boolean),
        // NEW: enforcement flags
        enforceLocationCheck: !!form.enforceLocationCheck,
        enforceQRScan: !!form.enforceQRScan,
      };
      if (!payload.title) return setErr("Title required");

      // 1) Create the task
      const { data } = await api.post("/tasks", payload);
      setRows(prev => [data, ...prev]);
      if (Array.isArray(data?.warnings) && data.warnings.length) {
        setWarnings(data.warnings);
      }

      // 2) If a geofence file was chosen, upload it immediately to this new task
      if (gfFile) {
        const fd = new FormData();
        fd.append("file", gfFile);
        try {
          await api.post(
            `/tasks/${data._id}/geofences/upload?radius=${encodeURIComponent(gfRadius)}`,
            fd,
            { headers: { "Content-Type": "multipart/form-data" } }
          );
          setInfo("Task created + geofence uploaded.");
        } catch (ge) {
          setErr(ge?.response?.data?.error || "Created, but geofence upload failed.");
        }
      } else {
        setInfo("Task created.");
      }

      // reset
      setForm({
        title:"", description:"", status:"pending", priority:"medium",
        dueAt:"", projectId:"", assignee:"", estimatedDuration:"", tags:"",
        enforceLocationCheck:false, enforceQRScan:false
      });
      setGfFile(null);
      setGfRadius(50);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  const nameOf = (id, arr) => {
    const x = arr.find(a => String(a._id) === String(id));
    return x ? (x.name || x.email || x.username || x._id) : "—";
  };

  function renderEstActualCell(t) {
    const est = t.estimatedDuration;
    const act = t.actualDurationMinutes ?? 0;
    if (est == null) return <>— vs {act}m</>;
    const delta = act - est;
    const sign = delta === 0 ? "±" : (delta > 0 ? "+" : "−");
    const absDelta = Math.abs(delta);
    const color = delta <= 0 ? "#0a7a32" : "#b91c1c";
    return (
      <div className="flex items-center gap-2">
        <span>{est}m vs {act}m</span>
        <span className="px-2 py-0.5 rounded text-white text-xs" style={{ background: color }}>
          {sign}{absDelta}m
        </span>
      </div>
    );
  }

  function ChecksCell({ t }) {
    const chips = [];
    if (t.enforceLocationCheck) chips.push(<span key="loc" className="px-2 py-0.5 border rounded text-xs">Loc</span>);
    if (t.enforceQRScan) chips.push(<span key="qr" className="px-2 py-0.5 border rounded text-xs">QR</span>);
    const gfCount = Array.isArray(t.geoFences) ? t.geoFences.length : 0;
    if (gfCount > 0) chips.push(<span key="gf" className="px-2 py-0.5 border rounded text-xs">{`GF${gfCount > 1 ? `×${gfCount}` : ""}`}</span>);
    return chips.length ? <div className="flex gap-1 flex-wrap">{chips}</div> : <span className="text-gray-400">—</span>;
  }

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">Tasks</h1>
      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}
      {!!warnings.length && (
        <div className="p-2 rounded border border-yellow-400 bg-yellow-50 text-yellow-800 text-sm">
          <b>Heads up:</b> {warnings.join(" ")}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input className="border p-2" placeholder="Search title/desc…" value={q}
               onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==='Enter'&&load()}
               style={{ minWidth: 240 }} />
        <select className="border p-2" value={status} onChange={e=>setStatus(e.target.value)}>
          <option value="">Status (any)</option>
          {STATUSES.map(s=><option key={s} value={s}>{s}</option>)}
        </select>
        <select className="border p-2" value={priority} onChange={e=>setPriority(e.target.value)}>
          <option value="">Priority (any)</option>
          {PRIORITIES.map(p=><option key={p} value={p}>{p}</option>)}
        </select>
        <select className="border p-2" value={projectId} onChange={e=>setProjectId(e.target.value)}>
          <option value="">Project (any)</option>
          {projects.map(p=><option key={p._id} value={p._id}>{p.name}</option>)}
        </select>
        <select className="border p-2" value={userId} onChange={e=>setUserId(e.target.value)}>
          <option value="">Assignee (any)</option>
          {users.map(u=><option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>)}
        </select>
        <input className="border p-2" type="date" value={dueFrom} onChange={e=>setDueFrom(e.target.value)} />
        <input className="border p-2" type="date" value={dueTo} onChange={e=>setDueTo(e.target.value)} />
        <button className="px-3 py-2 border rounded" onClick={load}>Apply</button>
      </div>

      {/* Quick presets */}
      {quickPresets.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-gray-600">Quick add:</span>
          {quickPresets.map(p => (
            <button
              key={p.key}
              type="button"
              className="px-2 py-1 border rounded"
              onClick={() => applyPreset(p)}
              title={[
                p.priority && `Priority: ${p.priority}`,
                p.tags && `Tags: ${p.tags}`
              ].filter(Boolean).join(" • ")}
            >
              {p.title}
            </button>
          ))}
        </div>
      )}

      {/* Quick create */}
      <form onSubmit={create} className="grid md:grid-cols-7 gap-2 border rounded p-3">
        <label className="text-sm md:col-span-2">Title
          <input className="border p-2 w-full" value={form.title} onChange={e=>setForm({...form, title:e.target.value})} required />
        </label>
        <label className="text-sm">Status
          <select className="border p-2 w-full" value={form.status} onChange={e=>setForm({...form, status:e.target.value})}>
            {STATUSES.map(s=><option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="text-sm">Priority
          <select className="border p-2 w-full" value={form.priority} onChange={e=>setForm({...form, priority:e.target.value})}>
            {PRIORITIES.map(p=><option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="text-sm">Due
          <input className="border p-2 w-full" type="date" value={form.dueAt} onChange={e=>setForm({...form, dueAt:e.target.value})} />
        </label>
        <label className="text-sm">Project
          <select className="border p-2 w-full" value={form.projectId} onChange={e=>setForm({...form, projectId:e.target.value})}>
            <option value="">— none —</option>
            {projects.map(p=><option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-sm">Assignee
          <select className="border p-2 w-full" value={form.assignee} onChange={e=>setForm({...form, assignee:e.target.value})}>
            <option value="">— none —</option>
            {users.map(u=><option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>)}
          </select>
        </label>
        <label className="text-sm">Est. (min)
          <input
            className="border p-2 w-full"
            type="number"
            min="0"
            step="1"
            placeholder="e.g. 45"
            value={form.estimatedDuration}
            onChange={e=>setForm({...form, estimatedDuration: e.target.value})}
          />
        </label>

        <label className="text-sm md:col-span-7">Tags (comma)
          <input className="border p-2 w-full" value={form.tags} onChange={e=>setForm({...form, tags:e.target.value})} placeholder="safety, routine" />
        </label>
        <label className="text-sm md:col-span-7">Description
          <textarea className="border p-2 w-full" rows={3} value={form.description} onChange={e=>setForm({...form, description:e.target.value})} />
        </label>

        {/* NEW: Enforcement toggles */}
        <div className="md:col-span-7 flex flex-wrap items-center gap-4 border-t pt-3">
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.enforceLocationCheck}
              onChange={e=>setForm({...form, enforceLocationCheck: e.target.checked})}
            />
            Enforce location check (on start/resume)
          </label>
          <label className="text-sm flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.enforceQRScan}
              onChange={e=>setForm({...form, enforceQRScan: e.target.checked})}
            />
            Require QR before start
          </label>
        </div>

        {/* Geofence-at-create (optional) */}
        <div className="md:col-span-7 grid md:grid-cols-4 gap-2">
          <label className="text-sm md:col-span-2">Geofence file (.geojson / .kml / .kmz)
            <input
              className="border p-2 w-full"
              type="file"
              accept=".geojson,.json,.kml,.kmz,application/json,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/zip"
              onChange={(e)=>setGfFile(e.target.files?.[0] || null)}
            />
          </label>
          <label className="text-sm">Point radius (m)
            <input
              className="border p-2 w-full"
              type="number"
              min="1"
              step="1"
              value={gfRadius}
              onChange={(e)=>setGfRadius(e.target.value)}
              title="Used to buffer Point features into circles"
            />
          </label>
          <div className="text-xs text-gray-600 self-end">
            If provided, the geofence is uploaded right after the task is created.
          </div>
        </div>

        <div className="md:col-span-7">
          <button className="px-3 py-2 bg-black text-white rounded">Create</button>
        </div>
      </form>

      {/* Table */}
      <table className="w-full border text-sm">
        <thead>
          <tr className="bg-gray-50">
            <th className="border p-2 text-left">Title</th>
            <th className="border p-2 text-left">Status</th>
            <th className="border p-2 text-left">Priority</th>
            <th className="border p-2 text-left">Due</th>
            <th className="border p-2 text-left">Est vs Actual</th>
            <th className="border p-2 text-left">Project</th>
            <th className="border p-2 text-left">Assignee</th>
            <th className="border p-2 text-left">Checks</th>{/* NEW */}
            <th className="border p-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(t=>(
            <tr key={t._id}>
              <td className="border p-2">
                <Link className="underline" to={`/tasks/${t._id}`}>{t.title}</Link>
                {(t.tags||[]).length>0 && <div className="text-xs text-gray-600">{(t.tags||[]).join(", ")}</div>}
              </td>
              <td className="border p-2">{t.status}</td>
              <td className="border p-2">{t.priority}</td>
              <td className="border p-2">{t.dueAt ? new Date(t.dueAt).toLocaleDateString() : "—"}</td>
              <td className="border p-2">{renderEstActualCell(t)}</td>
              <td className="border p-2">
                {t.projectId ? <Link className="underline" to={`/projects/${t.projectId}`}>{nameOf(t.projectId, projects)}</Link> : "—"}
              </td>
              <td className="border p-2">
                {t.assignee ? nameOf(t.assignee, users) : "—"}
              </td>
              <td className="border p-2"><ChecksCell t={t} /></td>
              <td className="border p-2 text-right">
                <Link className="px-2 py-1 border rounded" to={`/tasks/${t._id}`}>Open</Link>
              </td>
            </tr>
          ))}
          {!rows.length && <tr><td className="p-4 text-center" colSpan={9}>No tasks</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
