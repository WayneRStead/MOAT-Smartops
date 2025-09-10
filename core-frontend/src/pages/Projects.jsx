// src/pages/Projects.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";

function TagPill({ t }) {
  return <span className="text-xs px-2 py-1 rounded bg-gray-200 mr-1">{t}</span>;
}

export default function Projects() {
  const navigate = useNavigate();

  const [rows, setRows] = useState([]);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [tag, setTag] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const emptyForm = {
    name: "",
    description: "",
    status: "active",
    startDate: "",
    endDate: "",
    manager: "",
    members: [],
    tags: "",
  };
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null);

  async function load() {
    setErr(""); setInfo("");
    try {
      const params = {};
      if (q) params.q = q;
      if (status) params.status = status;
      if (tag) params.tag = tag;
      if (includeDeleted) params.includeDeleted = 1;
      params.limit = 200;
      const { data } = await api.get("/projects", { params });
      setRows(data || []);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [includeDeleted]);

  function resetForm() {
    setForm(emptyForm);
    setEditing(null);
  }

  async function create(e) {
    e.preventDefault();
    setErr(""); setInfo("");

    try {
      const payload = {
        name: form.name.trim(),
        description: form.description || "",
        status: form.status || "active",
        startDate: form.startDate || undefined,
        endDate: form.endDate || undefined,
        manager: form.manager || undefined,
        members: Array.isArray(form.members) ? form.members : [],
        tags: (form.tags || "").split(",").map(s => s.trim()).filter(Boolean),
      };
      if (!payload.name) return setErr("Project name is required");

      const { data } = await api.post("/projects", payload);

      // Smooth workflow: jump straight to the project's detail page
      resetForm();
      navigate(`/projects/${data._id}`, { replace: false });
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function update(e) {
    e.preventDefault();
    if (!editing) return;
    setErr(""); setInfo("");

    try {
      const payload = {
        name: form.name.trim(),
        description: form.description || "",
        status: form.status || "active",
        startDate: form.startDate || undefined,
        endDate: form.endDate || undefined,
        manager: form.manager || undefined,
        members: Array.isArray(form.members) ? form.members : [],
        tags: (form.tags || "").split(",").map(s => s.trim()).filter(Boolean),
      };
      const { data } = await api.put(`/projects/${editing._id}`, payload);

      setRows(prev => prev.map(r => (r._id === editing._id ? data : r)));
      resetForm();
      setInfo("Project updated.");
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }

  function startEdit(p) {
    setEditing(p);
    setForm({
      name: p.name || "",
      description: p.description || "",
      status: p.status || "active",
      startDate: p.startDate ? p.startDate.slice(0, 10) : "",
      endDate: p.endDate ? p.endDate.slice(0, 10) : "",
      manager: p.manager || "",
      members: Array.isArray(p.members) ? p.members : [],
      tags: (p.tags || []).join(", "),
    });
  }

  async function softDelete(id) {
    if (!confirm("Delete this project?")) return;
    setErr(""); setInfo("");
    try {
      await api.delete(`/projects/${id}`);
      await load();
      setInfo("Project deleted (soft).");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function restore(id) {
    setErr(""); setInfo("");
    try {
      const { data } = await api.patch(`/projects/${id}/restore`);
      setRows(prev => prev.map(r => (r._id === id ? data : r)));
      setInfo("Project restored.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function updateProjectStatus(id, newStatus) {
    try {
      const { data } = await api.patch(`/projects/${id}/status`, { status: newStatus });
      setRows(prev => prev.map(r => (r._id === id ? data : r)));
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  const activeTags = useMemo(() => {
    const set = new Set();
    rows.forEach(r => (r.tags || []).forEach(t => set.add(t)));
    return Array.from(set);
  }, [rows]);

  return (
    <div className="p-4">
      <h1 className="text-xl font-semibold mb-3">Projects</h1>
      {err && <div className="text-red-600 mb-2">{err}</div>}
      {info && <div className="text-green-700 mb-2">{info}</div>}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          className="border p-2"
          placeholder="Search name/desc/tag…"
          value={q}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load()}
          style={{ minWidth: 280 }}
        />
        <select className="border p-2" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">Status (any)</option>
          <option value="active">active</option>
          <option value="paused">paused</option>
          <option value="closed">closed</option>
        </select>
        <select className="border p-2" value={tag} onChange={e => setTag(e.target.value)}>
          <option value="">Tag (any)</option>
          {activeTags.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={includeDeleted} onChange={e => setIncludeDeleted(e.target.checked)} />
          Include deleted
        </label>
        <button className="px-3 py-2 border rounded" onClick={load}>Apply</button>
      </div>

      {/* Create / Edit */}
      <form onSubmit={editing ? update : create} className="grid md:grid-cols-3 gap-3 border rounded p-3 mb-4">
        <label className="text-sm">Name
          <input className="border p-2 w-full" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label className="text-sm">Status
          <select className="border p-2 w-full" value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="closed">closed</option>
          </select>
        </label>
        <label className="text-sm">Tags (comma)
          <input className="border p-2 w-full" value={form.tags} onChange={e => setForm({ ...form, tags: e.target.value })} placeholder="site-a, osha" />
        </label>

        <label className="text-sm md:col-span-3">Description
          <textarea className="border p-2 w-full" rows={2} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
        </label>

        <label className="text-sm">Start
          <input className="border p-2 w-full" type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} />
        </label>
        <label className="text-sm">End
          <input className="border p-2 w-full" type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} />
        </label>

        <div className="md:col-span-3 text-xs text-gray-600 border-t pt-3">
          After creating a project, you'll be taken to its detail page to set the location/fences.
        </div>

        <div className="flex items-center gap-2 md:col-span-3">
          <button className="px-3 py-2 bg-black text-white rounded">{editing ? "Update" : "Create"}</button>
          {editing && <button type="button" className="px-3 py-2 border rounded" onClick={resetForm}>Cancel</button>}
        </div>
      </form>

      {/* Table */}
      <table className="w-full border text-sm">
        <thead>
          <tr className="bg-gray-50">
            <th className="border p-2 text-left">Name</th>
            <th className="border p-2 text-left">Status</th>
            <th className="border p-2 text-left">Tags</th>
            <th className="border p-2 text-left">Dates</th>
            <th className="border p-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => (
            <tr key={p._id} className={p.deletedAt ? "opacity-60" : ""}>
              <td className="border p-2">
                <Link to={`/projects/${p._id}`} className="underline">{p.name}</Link>
                {p.description && <div className="text-xs text-gray-600">{p.description}</div>}
                {p.deletedAt && <div className="text-xs text-red-700">deleted {new Date(p.deletedAt).toLocaleString()}</div>}
              </td>
              <td className="border p-2">
                <select
                  className="border p-1"
                  value={p.status}
                  onChange={e => updateProjectStatus(p._id, e.target.value)}
                  disabled={!!p.deletedAt}
                >
                  <option value="active">active</option>
                  <option value="paused">paused</option>
                  <option value="closed">closed</option>
                </select>
              </td>
              <td className="border p-2">
                {(p.tags || []).length ? (p.tags || []).map(t => <TagPill key={t} t={t} />) : <span className="text-gray-500">—</span>}
              </td>
              <td className="border p-2">
                <div className="text-xs">
                  {p.startDate ? `Start: ${new Date(p.startDate).toLocaleDateString()}` : "Start: —"}
                  <br />
                  {p.endDate ? `End: ${new Date(p.endDate).toLocaleDateString()}` : "End: —"}
                </div>
              </td>
              <td className="border p-2 text-right">
                {!p.deletedAt ? (
                  <>
                    <button className="px-2 py-1 border rounded mr-2" onClick={() => startEdit(p)}>Edit</button>
                    <button className="px-2 py-1 border rounded" onClick={() => softDelete(p._id)}>Delete</button>
                  </>
                ) : (
                  <button className="px-2 py-1 border rounded" onClick={() => restore(p._id)}>Restore</button>
                )}
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr><td className="p-4 text-center" colSpan={5}>No projects</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
