// src/pages/Assets.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";

function StatusBadge({ value }) {
  const map = {
    active: "bg-green-100 text-green-800",
    maintenance: "bg-amber-100 text-amber-800",
    retired: "bg-gray-200 text-gray-800",
  };
  const cls = map[value] || "bg-gray-100 text-gray-800";
  return <span className={`text-xs px-2 py-1 rounded ${cls}`}>{value}</span>;
}

// ---- CSV export helper ----
function exportAssetsCsv(rows) {
  const header = ["Name", "Code", "Type", "ProjectId", "Status", "UpdatedAt"];
  const body = rows.map(r => [
    r.name || "",
    r.code || "",
    r.type || "",
    r.projectId || "",
    r.status || "",
    r.updatedAt ? new Date(r.updatedAt).toISOString() : ""
  ]);

  const csv = [header, ...body]
    .map(cols =>
      cols
        .map(val => {
          const s = String(val ?? "");
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(",")
    )
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "assets.csv";
  a.click();
  URL.revokeObjectURL(url);
}

/** Resolve a thumbnail URL for an asset.
 *  Prefers first gallery/attachments image, then common single-photo fields. */
function thumbUrl(asset) {
  return (
    asset?.photos?.[0]?.url ||
    asset?._images?.[0]?.url ||
    asset?.attachments?.find?.(a => (a.mime || "").startsWith("image/"))?.url ||
    asset?.photoUrl ||
    asset?.imageUrl ||
    asset?.thumbnailUrl ||
    asset?.photo ||
    ""
  );
}

export default function Assets() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState(searchParams.get("q") || "");
  const [projectId, setProjectId] = useState(searchParams.get("projectId") || "");
  const [status, setStatus] = useState(searchParams.get("status") || "");

  const [rows, setRows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const [form, setForm] = useState({ name: "", code: "", type: "", status: "active", projectId: "" });

  // ----- thumbnail sizing (one knob) -----
  const THUMB = 100; // px – adjust here to change list thumb size
  const rowStyle = { height: THUMB + 16 }; // keep rows even
  const thumbBoxStyle = {
    width: THUMB,
    height: THUMB,
    minWidth: THUMB,
    minHeight: THUMB,
    overflow: "hidden",
    borderRadius: 8,
    border: "1px solid #e5e7eb",
    background: "#f9fafb",
  };
  const thumbImgStyle = {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    display: "block",
  };

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
      const { data } = await api.get("/assets", { params });
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

  useEffect(() => { loadProjects(); }, []);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [searchParams]);

  async function create(e) {
    e.preventDefault();
    setErr(""); setInfo("");
    try {
      const payload = {
        name: (form.name || "").trim(),
        code: form.code || undefined,
        type: form.type || undefined,
        status: form.status || "active",
        projectId: form.projectId || undefined,
      };
      if (!payload.name) return setErr("Name is required");
      const { data } = await api.post("/assets", payload);
      setRows(prev => [data, ...prev]);
      setForm({ name: "", code: "", type: "", status: "active", projectId: projectId || "" });
      setInfo("Asset created.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function setRowStatus(id, newStatus) {
    setErr("");
    try {
      const { data } = await api.put(`/assets/${id}`, { status: newStatus });
      setRows(prev => prev.map(r => (r._id === id ? data : r)));
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function del(id) {
    if (!confirm("Delete this asset?")) return;
    setErr(""); setInfo("");
    try {
      await api.delete(`/assets/${id}`);
      setRows(prev => prev.filter(r => r._id !== id));
      setInfo("Asset deleted.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  const projectName = (id) => projects.find(p => String(p._id) === String(id))?.name || "—";

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">Assets</h1>
      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="border p-2"
          placeholder="Search name/code/type…"
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
          <option value="maintenance">maintenance</option>
          <option value="retired">retired</option>
        </select>
        <div className="flex items-center gap-2 ml-auto">
          <button className="px-3 py-2 border rounded" onClick={()=>syncUrl({ q, projectId, status })}>Apply</button>
          <button className="px-3 py-2 border rounded" onClick={() => exportAssetsCsv(rows)}>Export CSV</button>
        </div>
      </div>

      {/* Create */}
      <form onSubmit={create} className="grid md:grid-cols-5 gap-2 border rounded p-3">
        <label className="text-sm md:col-span-2">Name
          <input className="border p-2 w-full" value={form.name} onChange={e=>setForm({...form, name: e.target.value})} required />
        </label>
        <label className="text-sm">Code
          <input className="border p-2 w-full" value={form.code} onChange={e=>setForm({...form, code: e.target.value})} />
        </label>
        <label className="text-sm">Type
          <input className="border p-2 w-full" value={form.type} onChange={e=>setForm({...form, type: e.target.value})} />
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
            <option value="maintenance">maintenance</option>
            <option value="retired">retired</option>
          </select>
        </label>
        <div className="md:col-span-5">
          <button className="px-3 py-2 bg-black text-white rounded">Create</button>
        </div>
      </form>

      {/* Table */}
      <div className="border rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="p-2 text-left">Photo</th>
              <th className="p-2 text-left">Name / Code</th>
              <th className="p-2 text-left">Type</th>
              <th className="p-2 text-left">Project</th>
              <th className="p-2 text-left">Status</th>
              <th className="p-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const url = thumbUrl(r);
              return (
                <tr key={r._id} style={rowStyle}>
                  <td className="border-t p-2 align-top">
                    <Link to={`/assets/${r._id}`} title="Open asset">
                      <div style={thumbBoxStyle}>
                        {url ? (
                          <img
                            src={url}
                            loading="lazy"
                            decoding="async"
                            style={thumbImgStyle}
                            alt=""
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                              const p = e.currentTarget.parentElement;
                              if (p) p.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:11px;">image&nbsp;err</div>';
                            }}
                          />
                        ) : (
                          <div style={{...thumbBoxStyle, display:"flex", alignItems:"center", justifyContent:"center", color:"#9ca3af", fontSize:11}}>
                            no photo
                          </div>
                        )}
                      </div>
                    </Link>
                  </td>

                  <td className="border-t p-2 align-top">
                    <div className="font-medium">
                      <Link to={`/assets/${r._id}`} className="underline">{r.name}</Link>
                    </div>
                    <div className="text-xs text-gray-600">{r.code || "—"}</div>
                  </td>

                  <td className="border-t p-2 align-top">{r.type || "—"}</td>

                  <td className="border-t p-2 align-top">
                    {r.projectId ? <Link className="underline" to={`/projects/${r.projectId}`}>{projectName(r.projectId)}</Link> : "—"}
                  </td>

                  <td className="border-t p-2 align-top">
                    <div className="flex items-center gap-2">
                      <StatusBadge value={r.status || "active"} />
                      <select className="border p-1" value={r.status || "active"} onChange={e=>setRowStatus(r._id, e.target.value)}>
                        <option value="active">active</option>
                        <option value="maintenance">maintenance</option>
                        <option value="retired">retired</option>
                      </select>
                    </div>
                  </td>

                  <td className="border-t p-2 text-right align-top">
                    <button className="px-2 py-1 border rounded" onClick={()=>del(r._id)}>Delete</button>
                  </td>
                </tr>
              );
            })}
            {!rows.length && <tr><td colSpan={6} className="p-4 text-center">No assets</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
