// src/pages/Inspections.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";

function StatusBadge({ value }) {
  const map = {
    "open": "bg-blue-100 text-blue-800",
    "in-progress": "bg-purple-100 text-purple-800",
    "closed": "bg-gray-200 text-gray-800",
    "planned": "bg-amber-100 text-amber-800",
  };
  const cls = map[value] || "bg-gray-100 text-gray-800";
  return <span className={`text-xs px-2 py-1 rounded ${cls}`}>{value}</span>;
}

export default function Inspections() {
  const [searchParams, setSearchParams] = useSearchParams();

  // filters
  const [q, setQ] = useState(searchParams.get("q") || "");
  const [projectId, setProjectId] = useState(searchParams.get("projectId") || "");
  const [status, setStatus] = useState(searchParams.get("status") || "");

  // data
  const [rows, setRows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);

  // create form
  const [form, setForm] = useState({
    title: "",
    status: "planned",
    scheduledAt: "",
    assignee: "",
    projectId: "",
  });

  // ui
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  function syncUrl(params = {}) {
    const next = new URLSearchParams();
    if (params.q ?? q) next.set("q", params.q ?? q);
    if (params.projectId ?? projectId) next.set("projectId", params.projectId ?? projectId);
    if (params.status ?? status) next.set("status", params.status ?? status);
    setSearchParams(next);
  }

  async function load() {
    setErr(""); setInfo("");
    try {
      const params = {};
      if (q) params.q = q;
      if (projectId) params.projectId = projectId;
      if (status) params.status = status;
      params.limit = 500;

      const { data } = await api.get("/inspections", { params });
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

  useEffect(() => {
    loadProjects();
    loadUsers();
  }, []);

  // reload when URL filters change
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ---------- actions ----------
  async function create(e) {
    e.preventDefault();
    setErr(""); setInfo("");
    try {
      const payload = {
        title: (form.title || "").trim(),
        status: form.status || "planned",
        projectId: form.projectId || undefined,
        scheduledAt: form.scheduledAt || undefined,
        assignee: form.assignee || undefined,
      };
      if (!payload.title) return setErr("Title is required");
      const { data } = await api.post("/inspections", payload);
      setRows(prev => [data, ...prev]);
      setForm({ title: "", status: "planned", scheduledAt: "", assignee: "", projectId: projectId || "" });
      setInfo("Inspection created.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function setRowStatus(id, newStatus) {
    setErr("");
    try {
      const { data } = await api.put(`/inspections/${id}`, { status: newStatus });
      setRows(prev => prev.map(r => (r._id === id ? data : r)));
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function del(id) {
    if (!confirm("Delete this inspection?")) return;
    setErr(""); setInfo("");
    try {
      await api.delete(`/inspections/${id}`);
      setRows(prev => prev.filter(r => r._id !== id));
      setInfo("Inspection deleted.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  // helpers
  const projectMap = useMemo(() => {
    const m = new Map();
    projects.forEach(p => m.set(String(p._id), p));
    return m;
  }, [projects]);

  const userLabel = (id) => {
    const u = users.find(x => String(x._id) === String(id));
    return u ? (u.name || u.email || u.username) : "—";
  };

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">Inspections</h1>
      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="border p-2"
          placeholder="Search title/notes…"
          value={q}
          onChange={(e)=>setQ(e.target.value)}
          onKeyDown={(e)=>{ if(e.key==='Enter'){ syncUrl({ q }); }}}
          style={{ minWidth: 240 }}
        />
        <select
          className="border p-2"
          value={projectId}
          onChange={(e)=>{ setProjectId(e.target.value); syncUrl({ projectId: e.target.value }); }}
        >
          <option value="">Project (any)</option>
          {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
        </select>
        <select
          className="border p-2"
          value={status}
          onChange={(e)=>{ setStatus(e.target.value); syncUrl({ status: e.target.value }); }}
        >
          <option value="">Status (any)</option>
          <option value="planned">planned</option>{/* mapped to 'open' on backend */}
          <option value="open">open</option>
          <option value="in-progress">in-progress</option>
          <option value="closed">closed</option>
        </select>
        <button className="px-3 py-2 border rounded" onClick={()=>syncUrl({ q, projectId, status })}>Apply</button>
      </div>

      {/* Create */}
      <form onSubmit={create} className="grid md:grid-cols-5 gap-2 border rounded p-3">
        <label className="text-sm md:col-span-2">Title
          <input className="border p-2 w-full" value={form.title} onChange={e=>setForm({...form, title: e.target.value})} required />
        </label>
        <label className="text-sm">Project
          <select className="border p-2 w-full" value={form.projectId || projectId} onChange={e=>setForm({...form, projectId: e.target.value})}>
            <option value="">— none —</option>
            {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
        </label>
        <label className="text-sm">Status
          <select className="border p-2 w-full" value={form.status} onChange={e=>setForm({...form, status: e.target.value})}>
            <option value="planned">planned</option>
            <option value="open">open</option>
            <option value="in-progress">in-progress</option>
            <option value="closed">closed</option>
          </select>
        </label>
        <label className="text-sm">Scheduled
          <input className="border p-2 w-full" type="datetime-local" value={form.scheduledAt} onChange={e=>setForm({...form, scheduledAt: e.target.value})} />
        </label>
        <label className="text-sm md:col-span-4">Assignee
          <select className="border p-2 w-full" value={form.assignee} onChange={e=>setForm({...form, assignee: e.target.value})}>
            <option value="">— none —</option>
            {users.map(u => <option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>)}
          </select>
        </label>
        <div className="md:col-span-1 flex items-end">
          <button className="px-3 py-2 bg-black text-white rounded w-full">Create</button>
        </div>
      </form>

      {/* Table */}
      <table className="w-full border text-sm">
        <thead>
          <tr className="bg-gray-50">
            <th className="border p-2 text-left">Title</th>
            <th className="border p-2 text-left">Project</th>
            <th className="border p-2 text-left">Status</th>
            <th className="border p-2 text-left">Scheduled</th>
            <th className="border p-2 text-left">Assignee</th>
            <th className="border p-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r._id}>
              <td className="border p-2">
                <div className="font-medium">{r.title}</div>
                <div className="mt-1"><StatusBadge value={r.status || "open"} /></div>
              </td>
              <td className="border p-2">
                {r.projectId ? (
                  <Link className="underline" to={`/projects/${r.projectId}`}>
                    {projectMap.get(String(r.projectId))?.name || String(r.projectId)}
                  </Link>
                ) : "—"}
              </td>
              <td className="border p-2">
                <select
                  className="border p-1"
                  value={r.status || "open"}
                  onChange={e => setRowStatus(r._id, e.target.value)}
                >
                  <option value="planned">planned</option>
                  <option value="open">open</option>
                  <option value="in-progress">in-progress</option>
                  <option value="closed">closed</option>
                </select>
              </td>
              <td className="border p-2">{r.scheduledAt ? new Date(r.scheduledAt).toLocaleString() : "—"}</td>
              <td className="border p-2">{userLabel(r.assignee)}</td>
              <td className="border p-2 text-right">
                <button className="px-2 py-1 border rounded" onClick={()=>del(r._id)}>Delete</button>
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr><td className="p-4 text-center" colSpan={6}>No inspections</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
