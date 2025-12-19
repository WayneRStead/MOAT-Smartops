// src/pages/Assets.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";

/* --- Status chip --- */
function StatusBadge({ value }) {
  const map = {
    active: "bg-green-100 text-green-800",
    maintenance: "bg-amber-100 text-amber-800",
    retired: "bg-gray-200 text-gray-800",
    lost: "bg-purple-100 text-purple-800",
    stolen: "bg-purple-100 text-purple-800",
  };
  const cls = map[value] || "bg-gray-100 text-gray-800";
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{value || "—"}</span>;
}

/* --- Shared modal (matches Vehicles look) --- */
function Modal({ open, title, onClose, children, footer }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0"
        style={{ background: "rgba(17,24,39,0.60)" }} // dark grey, no see-through content
        onClick={onClose}
      />
      {/* Panel */}
      <div className="relative z-10 w-full max-w-3xl rounded-2xl border border-border bg-white shadow-xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="text-lg font-semibold">{title}</div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="p-4 space-y-3">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-border flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
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

/** Resolve a thumbnail URL for an asset. */
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

  // URL-backed filters
  const [q, setQ] = useState(searchParams.get("q") || "");
  const [projectId, setProjectId] = useState(searchParams.get("projectId") || "");
  const [status, setStatus] = useState(searchParams.get("status") || "");

  // Data
  const [rows, setRows] = useState([]);
  const [projects, setProjects] = useState([]);

  // UX
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  // Create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [createSaving, setCreateSaving] = useState(false);
  const [createErr, setCreateErr] = useState("");
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
  const thumbImgStyle = { width: "100%", height: "100%", objectFit: "cover", display: "block" };

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

  // ---- Derived: filtered rows already done server-side via params; keep memo for consistency if needed later
  const filtered = useMemo(() => rows, [rows]);

  // ---- Row actions
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

  // ---- Create
  async function create(e) {
    e?.preventDefault?.();
    if (createSaving) return;
    setCreateErr("");
    setErr(""); setInfo("");
    try {
      const payload = {
        name: (form.name || "").trim(),
        code: form.code || undefined,
        type: form.type || undefined,
        status: form.status || "active",
        projectId: form.projectId || undefined,
      };
      if (!payload.name) return setCreateErr("Name is required");
      setCreateSaving(true);
      const { data } = await api.post("/assets", payload);
      // Refresh list; keep filters
      setRows(prev => [data, ...prev]);
      setForm({ name: "", code: "", type: "", status: "active", projectId: projectId || "" });
      setInfo("Asset created.");
      setCreateOpen(false);
    } catch (e2) {
      setCreateErr(e2?.response?.data?.error || String(e2));
    } finally {
      setCreateSaving(false);
    }
  }

  const projectName = (id) => projects.find(p => String(p._id) === String(id))?.name || "—";

  // Status tabs to match Vehicles
  const statusTabs = ["", "active", "maintenance", "retired", "lost", "stolen"];
  const statusLabel = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "All");

  return (
    <div className="max-w-7xl mx-auto p-4">
      {/* Header row (Search + Export + New) */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Assets</h1>
        <div className="flex items-center gap-2">
          <input
            className="input input-bordered"
            style={{ minWidth: 260 }}
            placeholder="Search name, code, type…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") syncUrl({ q }); }}
          />
          <button
            className="btn btn-sm"
            type="button"
            onClick={() => syncUrl({ q })}
            title="Apply search"
          >
            Search
          </button>
          <button
            type="button"
            onClick={() => exportAssetsCsv(filtered)}
            disabled={!filtered.length}
            className="btn btn-sm"
            title={!filtered.length ? "No rows to export" : "Export filtered assets to CSV"}
          >
            Export CSV
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => { setCreateOpen(true); setCreateErr(""); }}
          >
            New Asset
          </button>
        </div>
      </div>

      {err && <div className="text-red-600 mt-2">{err}</div>}
      {info && <div className="text-green-700 mt-2">{info}</div>}

      {/* Filters row — Project first, then inline status tabs (no enclosing border) */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="text-sm flex items-center gap-2">
          <span className="text-gray-600">Project</span>
          <select
            className="select select-bordered select-sm"
            value={projectId}
            onChange={(e) => { setProjectId(e.target.value); syncUrl({ projectId: e.target.value }); }}
          >
            <option value="">Any</option>
            {projects.map((p) => (
              <option key={p._id} value={p._id}>{p.name}</option>
            ))}
          </select>
        </label>

        {/* Status tabs (borderless group, like Vehicles) */}
        <div className="flex items-center gap-1 ml-2">
          {statusTabs.map((s) => {
            const active = status === s;
            return (
              <button
                key={s || "all"}
                className={`px-3 py-2 rounded ${active ? "bg-black text-white" : "hover:bg-gray-100"}`}
                onClick={() => { setStatus(s); syncUrl({ status: s }); }}
                type="button"
              >
                {statusLabel(s)}
              </button>
            );
          })}
        </div>

        <div className="ml-auto text-sm text-gray-700">
          Showing <b>{filtered.length}</b> {filtered.length === 1 ? "asset" : "assets"}
        </div>
      </div>

      {/* Table */}
      <div className="mt-3 border rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="p-2 text-left">Photo</th>
              <th className="p-2 text-left">Name / Code</th>
              <th className="p-2 text-left">Type</th>
              <th className="p-2 text-left">Project</th>
              <th className="p-2 text-left">Status</th>
              <th className="p-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => {
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
                      <Link to={`/assets/${r._id}`} className="underline">{r.name || "—"}</Link>
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
                      <select
                        className="select select-bordered select-xs"
                        value={r.status || "active"}
                        onChange={e=>setRowStatus(r._id, e.target.value)}
                      >
                        <option value="active">active</option>
                        <option value="maintenance">maintenance</option>
                        <option value="retired">retired</option>
                        <option value="lost">lost</option>
                        <option value="stolen">stolen</option>
                      </select>
                    </div>
                  </td>

                  <td className="border-t p-2 text-right align-top">
                    <button className="px-2 py-1 border rounded" onClick={()=>del(r._id)}>Delete</button>
                  </td>
                </tr>
              );
            })}
            {!filtered.length && (
              <tr>
                <td colSpan={6} className="p-4 text-center text-gray-600">No assets</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* New Asset Modal (same palette as Vehicles) */}
      <Modal
        open={createOpen}
        title="Create Asset"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setCreateOpen(false)}>Cancel</button>
            <button
              className="btn btn-primary disabled:opacity-60"
              disabled={createSaving}
              onClick={create}
              type="button"
            >
              {createSaving ? "Creating…" : "Create"}
            </button>
          </>
        }
      >
        {createErr && <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">{createErr}</div>}
        <form onSubmit={create} className="grid md:grid-cols-5 gap-2">
          <label className="text-sm md:col-span-2">Name
            <input className="border p-2 w-full" value={form.name}
                   onChange={e=>setForm({...form, name: e.target.value})} required />
          </label>
          <label className="text-sm">Code
            <input className="border p-2 w-full" value={form.code}
                   onChange={e=>setForm({...form, code: e.target.value})} />
          </label>
          <label className="text-sm">Type
            <input className="border p-2 w-full" value={form.type}
                   onChange={e=>setForm({...form, type: e.target.value})} />
          </label>
          <label className="text-sm">Project
            <select className="border p-2 w-full" value={form.projectId || projectId}
                    onChange={e=>setForm({...form, projectId: e.target.value})}>
              <option value="">— none —</option>
              {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
          </label>
          <label className="text-sm">Status
            <select className="border p-2 w-full" value={form.status}
                    onChange={e=>setForm({...form, status: e.target.value})}>
              <option value="active">active</option>
              <option value="maintenance">maintenance</option>
              <option value="retired">retired</option>
              <option value="lost">lost</option>
              <option value="stolen">stolen</option>
            </select>
          </label>
        </form>
        <div className="text-xs text-gray-500">
          Tip: You can leave most fields blank and fill them later.
        </div>
      </Modal>
    </div>
  );
}
