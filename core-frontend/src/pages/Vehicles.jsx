// src/pages/Vehicles.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";

function StatusBadge({ value }) {
  const map = {
    active: "bg-green-100 text-green-800",
    workshop: "bg-amber-100 text-amber-800",
    retired: "bg-gray-200 text-gray-800",
  };
  const cls = map[value] || "bg-gray-100 text-gray-800";
  return <span className={`text-xs px-2 py-1 rounded ${cls}`}>{value}</span>;
}

export default function Vehicles() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState(searchParams.get("q") || "");
  const [projectId, setProjectId] = useState(searchParams.get("projectId") || "");
  const [status, setStatus] = useState(searchParams.get("status") || "");

  const [rows, setRows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [tasks, setTasks] = useState([]);

  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const [form, setForm] = useState({
    reg: "", make: "", model: "", year: "", status: "active", projectId: ""
  });

  function syncUrl(next = {}) {
    const u = new URLSearchParams();
    const qv = next.q ?? q;
    const pv = next.projectId ?? projectId;
    const sv = next.status ?? status;
    if (qv) u.set("q", qv);
    if (pv) u.set("projectId", pv);
    if (sv) u.set("status", sv);
    setSearchParams(u);
  }

  async function load() {
    setErr(""); setInfo("");
    try {
      const params = { limit: 500 };
      if (q) params.q = q;
      if (projectId) params.projectId = projectId;
      if (status) params.status = status;
      const { data } = await api.get("/vehicles", { params });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function loadProjects() {
    try {
      const { data } = await api.get("/projects", { params: { limit: 1000 } });
      setProjects(Array.isArray(data) ? data : []);
    } catch {
      setProjects([]);
    }
  }

  async function loadUsers() {
    try {
      const { data } = await api.get("/users", { params: { limit: 1000 } });
      setUsers(Array.isArray(data) ? data : []);
    } catch {
      setUsers([]);
    }
  }

  async function loadTasks() {
    try {
      // Pull a broad set so labels work across the table.
      const { data } = await api.get("/tasks", { params: { limit: 1000 } });
      setTasks(Array.isArray(data) ? data : []);
    } catch {
      setTasks([]);
    }
  }

  useEffect(() => { loadProjects(); loadUsers(); loadTasks(); }, []);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [searchParams]);

  async function create(e) {
    e.preventDefault();
    setErr(""); setInfo("");
    try {
      const payload = {
        reg: (form.reg || "").trim(),
        make: form.make || undefined,
        model: form.model || undefined,
        year: form.year ? Number(form.year) : undefined,
        status: form.status || "active",
        projectId: form.projectId || undefined,
      };
      if (!payload.reg) return setErr("Registration is required");
      const { data } = await api.post("/vehicles", payload);
      setRows(prev => [data, ...prev]);
      setForm({ reg: "", make: "", model: "", year: "", status: "active", projectId: projectId || "" });
      setInfo("Vehicle created.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function setRowStatus(id, newStatus) {
    setErr("");
    try {
      const { data } = await api.put(`/vehicles/${id}`, { status: newStatus });
      setRows(prev => prev.map(r => (r._id === id ? data : r)));
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function del(id) {
    if (!confirm("Delete this vehicle?")) return;
    setErr(""); setInfo("");
    try {
      await api.delete(`/vehicles/${id}`);
      setRows(prev => prev.filter(r => r._id !== id));
      setInfo("Vehicle deleted.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  const projectName = (id) =>
    projects.find(p => String(p._id) === String(id))?.name || "—";

  // quick maps for labels
  const userMap = useMemo(() => {
    const m = new Map();
    users.forEach(u => m.set(String(u._id), u.name || u.email || u.username || String(u._id)));
    return m;
  }, [users]);

  const taskMap = useMemo(() => {
    const m = new Map();
    tasks.forEach(t => m.set(String(t._id), t.title || String(t._id)));
    return m;
  }, [tasks]);

  const driverLabel = (driver) => {
    if (!driver) return "—";
    if (typeof driver === "object" && (driver.name || driver.email)) {
      return driver.name || driver.email;
    }
    return userMap.get(String(driver)) || String(driver);
  };

  const taskCell = (task) => {
    if (!task) return "—";
    if (typeof task === "object" && task._id) {
      return <Link className="underline" to={`/tasks/${task._id}`}>{task.title || task._id}</Link>;
    }
    const id = String(task);
    const label = taskMap.get(id) || id;
    return <Link className="underline" to={`/tasks/${id}`}>{label}</Link>;
  };

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">Vehicles</h1>
      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="border p-2"
          placeholder="Search reg/make/model…"
          value={q}
          onChange={e=>setQ(e.target.value)}
          onKeyDown={e=>{ if(e.key==='Enter') syncUrl({ q }); }}
          style={{ minWidth: 240 }}
        />
        <select
          className="border p-2"
          value={projectId}
          onChange={e=>{ setProjectId(e.target.value); syncUrl({ projectId: e.target.value }); }}
        >
          <option value="">Project (any)</option>
          {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
        </select>
        <select
          className="border p-2"
          value={status}
          onChange={e=>{ setStatus(e.target.value); syncUrl({ status: e.target.value }); }}
        >
          <option value="">Status (any)</option>
          <option value="active">active</option>
          <option value="workshop">workshop</option>
          <option value="retired">retired</option>
        </select>
        <button className="px-3 py-2 border rounded" onClick={()=>syncUrl({ q, projectId, status })}>Apply</button>
      </div>

      {/* Create */}
      <form onSubmit={create} className="grid md:grid-cols-6 gap-2 border rounded p-3">
        <label className="text-sm">Registration
          <input className="border p-2 w-full" value={form.reg} onChange={e=>setForm({...form, reg: e.target.value})} required />
        </label>
        <label className="text-sm">Make
          <input className="border p-2 w-full" value={form.make} onChange={e=>setForm({...form, make: e.target.value})} />
        </label>
        <label className="text-sm">Model
          <input className="border p-2 w-full" value={form.model} onChange={e=>setForm({...form, model: e.target.value})} />
        </label>
        <label className="text-sm">Year
          <input className="border p-2 w-full" type="number" inputMode="numeric" min="1900" max="2100"
                 value={form.year} onChange={e=>setForm({...form, year: e.target.value})} />
        </label>
        <label className="text-sm">Project
          <select className="border p-2 w-full" value={form.projectId || projectId} onChange={e=>setForm({...form, projectId: e.target.value})}>
            <option value="">— none —</option>
            {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-sm">Status
          <select className="border p-2 w-full" value={form.status} onChange={e=>setForm({...form, status: e.target.value})}>
            <option value="active">active</option>
            <option value="workshop">workshop</option>
            <option value="retired">retired</option>
          </select>
        </label>
        <div className="md:col-span-6">
          <button className="px-3 py-2 bg-black text-white rounded">Create</button>
        </div>
      </form>

      {/* Table */}
      <table className="w-full border text-sm">
        <thead>
          <tr className="bg-gray-50">
            <th className="border p-2 text-left">Registration</th>
            <th className="border p-2 text-left">Make/Model</th>
            <th className="border p-2 text-left">Year</th>
            <th className="border p-2 text-left">Project</th>
            {/* NEW */}
            <th className="border p-2 text-left">Driver</th>
            <th className="border p-2 text-left">Task</th>
            <th className="border p-2 text-left">Status</th>
            <th className="border p-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r._id}>
              <td className="border p-2">
                <div className="font-medium">
                  <Link to={`/vehicles/${r._id}`} className="underline">{r.reg}</Link>
                </div>
              </td>
              <td className="border p-2">{[r.make, r.model].filter(Boolean).join(" ") || "—"}</td>
              <td className="border p-2">{r.year || "—"}</td>
              <td className="border p-2">
                {r.projectId
                  ? <Link className="underline" to={`/projects/${r.projectId}`}>{projectName(r.projectId)}</Link>
                  : "—"}
              </td>
              {/* NEW driver cell */}
              <td className="border p-2">
                {r.driver?.name || r.driver?.email
                  ? (r.driver.name || r.driver.email)
                  : driverLabel(r.driverId)}
              </td>
              {/* NEW task cell */}
              <td className="border p-2">
                {r.task?.title
                  ? <Link className="underline" to={`/tasks/${r.task._id}`}>{r.task.title}</Link>
                  : taskCell(r.taskId)}
              </td>
              <td className="border p-2">
                <div className="flex items-center gap-2">
                  <StatusBadge value={r.status || "active"} />
                  <select
                    className="border p-1"
                    value={r.status || "active"}
                    onChange={e=>setRowStatus(r._id, e.target.value)}
                  >
                    <option value="active">active</option>
                    <option value="workshop">workshop</option>
                    <option value="retired">retired</option>
                  </select>
                </div>
              </td>
              <td className="border p-2 text-right">
                <button className="px-2 py-1 border rounded" onClick={()=>del(r._id)}>Delete</button>
              </td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={8} className="p-4 text-center">No vehicles</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
