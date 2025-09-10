// src/pages/Clockings.jsx
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

const ATTENDANCE_TYPES = ["present","in","out","training","sick","leave","iod","overtime"];

export default function Clockings() {
  // reference data
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);

  // filters for history
  const [q, setQ] = useState("");
  const [filterProjectId, setFilterProjectId] = useState("");
  const [filterUserId, setFilterUserId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [typeFilter, setTypeFilter] = useState("");

  // history
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  // row editing
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({ type: "present", at: "", projectId: "", notes: "" });

  // create form
  const [isBulk, setIsBulk] = useState(true);
  const [projectId, setProjectId] = useState("");
  const [type, setType] = useState("present");
  const [at, setAt] = useState(() => new Date().toISOString().slice(0,16));
  const [notes, setNotes] = useState("");
  const [selectedUsers, setSelectedUsers] = useState([]);   // for bulk
  const [singleUser, setSingleUser] = useState("");         // for single

  // geo (optional)
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [acc, setAcc] = useState("");

  // messages
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  // quick lookups
  const userName = useMemo(() => {
    const m = new Map();
    users.forEach(u => m.set(String(u._id), u.name || u.email || u.username || String(u._id)));
    return id => m.get(String(id)) || String(id || "—");
  }, [users]);

  const projectName = useMemo(() => {
    const m = new Map();
    projects.forEach(p => m.set(String(p._id), p.name || String(p._id)));
    return id => m.get(String(id)) || "—";
  }, [projects]);

  // limit user choices to selected project's members (if available)
  const eligibleUsers = useMemo(() => {
    if (!projectId) return users;
    const proj = projects.find(p => String(p._id) === String(projectId));
    const memberIds = new Set((proj?.members || []).map(String));
    if (!memberIds.size) return users;
    return users.filter(u => memberIds.has(String(u._id)));
  }, [projectId, users, projects]);

  // load reference data
  async function loadUsers() {
    try {
      const { data } = await api.get("/users", { params: { limit: 1000 } });
      setUsers(Array.isArray(data) ? data : []);
    } catch { setUsers([]); }
  }
  async function loadProjects() {
    try {
      const { data } = await api.get("/projects", { params: { limit: 1000 } });
      setProjects(Array.isArray(data) ? data : []);
    } catch { setProjects([]); }
  }

  // load history
  async function load() {
    setErr(""); setInfo(""); setLoading(true);
    try {
      const params = { limit: 500 };
      if (q) params.q = q;
      if (filterProjectId) params.projectId = filterProjectId;
      if (filterUserId) params.userId = filterUserId;
      if (from) params.from = from;
      if (to) params.to = to;
      if (typeFilter) params.type = typeFilter;

      const { data } = await api.get("/clockings", { params });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadUsers();
    loadProjects();
    load();
  }, []);

  // present location button
  function useMyLocation() {
    setErr(""); setInfo("");
    if (!navigator.geolocation) {
      setErr("Geolocation not supported in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude, longitude, accuracy } = pos.coords || {};
        setLat(latitude?.toFixed(6) ?? "");
        setLng(longitude?.toFixed(6) ?? "");
        setAcc(Number.isFinite(accuracy) ? Math.round(accuracy) : "");
        setInfo("Location captured.");
        setTimeout(() => setInfo(""), 1200);
      },
      err => setErr(err?.message || "Failed to get location"),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  // toggle user checkbox (bulk)
  function toggleUser(id) {
    setSelectedUsers(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  async function submitClocking(e) {
    e.preventDefault();
    setErr(""); setInfo("");

    try {
      const payloadBase = {
        type,
        notes,
        at: at ? new Date(at).toISOString() : undefined,
        projectId: projectId || undefined, // never send "" or "undefined"
      };

      const nLat = lat !== "" ? Number(lat) : undefined;
      const nLng = lng !== "" ? Number(lng) : undefined;
      const nAcc = acc !== "" ? Number(acc) : undefined;
      if (Number.isFinite(nLat) && Number.isFinite(nLng)) {
        payloadBase.lat = nLat;
        payloadBase.lng = nLng;
        if (Number.isFinite(nAcc)) payloadBase.acc = nAcc;
      }

      if (isBulk) {
        if (!selectedUsers.length) return setErr("Select at least one user.");
        await api.post("/clockings", { ...payloadBase, userIds: selectedUsers });
        setInfo(`Clocked ${selectedUsers.length} user(s).`);
        setSelectedUsers([]);
      } else {
        if (!singleUser) return setErr("Pick a user.");
        await api.post("/clockings", { ...payloadBase, userId: singleUser });
        setInfo("Clocking saved.");
        setSingleUser("");
      }

      setNotes("");
      setAt(new Date().toISOString().slice(0,16));
      await load();
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  // ----- row edit/delete -----
  function startEdit(row) {
    setEditingId(row._id);
    setEditForm({
      type: row.type || "present",
      at: row.at ? new Date(row.at).toISOString().slice(0,16) : new Date().toISOString().slice(0,16),
      projectId: row.projectId || "",
      notes: row.notes || "",
    });
  }
  function cancelEdit() {
    setEditingId(null);
  }
  async function saveEdit(id) {
    setErr(""); setInfo("");
    try {
      const payload = {
        type: editForm.type,
        at: editForm.at ? new Date(editForm.at).toISOString() : undefined,
        projectId: editForm.projectId || undefined,
        notes: editForm.notes || "",
      };
      const { data } = await api.put(`/clockings/${id}`, payload);
      setRows(prev => prev.map(r => (r._id === id ? data : r)));
      setEditingId(null);
      setInfo("Updated.");
      setTimeout(() => setInfo(""), 1200);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function del(id) {
    if (!confirm("Delete this clocking?")) return;
    setErr(""); setInfo("");
    try {
      await api.delete(`/clockings/${id}`);
      setRows(prev => prev.filter(r => r._id !== id));
      setInfo("Deleted.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  return (
    <div className="p-4 space-y-4">
      <h1 className="text-xl font-semibold">Clockings</h1>
      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      {/* Create */}
      <form onSubmit={submitClocking} className="border rounded p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm">
            Mode
            <select className="border p-2 ml-2" value={isBulk ? "bulk" : "single"} onChange={e => setIsBulk(e.target.value === "bulk")}>
              <option value="bulk">Bulk (select many)</option>
              <option value="single">Single user</option>
            </select>
          </label>

          <label className="text-sm">
            Project
            <select className="border p-2 ml-2" value={projectId} onChange={e => setProjectId(e.target.value)}>
              <option value="">— none —</option>
              {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
          </label>

          <label className="text-sm">
            Type
            <select className="border p-2 ml-2" value={type} onChange={e => setType(e.target.value)}>
              {ATTENDANCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>

          <label className="text-sm">
            Time
            <input className="border p-2 ml-2" type="datetime-local" value={at} onChange={e => setAt(e.target.value)} />
          </label>
        </div>

        {/* Location (optional) */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2">
            <button type="button" className="px-3 py-2 border rounded" onClick={useMyLocation}>Use my location</button>
            <small className="text-gray-600">Optional</small>
          </div>
          <label className="text-sm">
            Lat
            <input className="border p-2 ml-2 w-40" value={lat} onChange={e => setLat(e.target.value)} placeholder="e.g. -26.2041" />
          </label>
          <label className="text-sm">
            Lng
            <input className="border p-2 ml-2 w-40" value={lng} onChange={e => setLng(e.target.value)} placeholder="e.g. 28.0473" />
          </label>
          <label className="text-sm">
            Acc (m)
            <input className="border p-2 ml-2 w-28" value={acc} onChange={e => setAcc(e.target.value)} placeholder="optional" />
          </label>
        </div>

        {/* Notes */}
        <label className="block text-sm">
          Notes
          <input className="border p-2 w-full" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional note…" />
        </label>

        {/* User selection */}
        {isBulk ? (
          <div>
            <div className="text-sm font-medium mb-2">Select users</div>
            <div className="grid md:grid-cols-3 gap-2">
              {eligibleUsers.map(u => (
                <label key={u._id} className="flex items-center gap-2 border rounded p-2">
                  <input
                    type="checkbox"
                    checked={selectedUsers.includes(u._id)}
                    onChange={() => toggleUser(u._id)}
                  />
                  <span>{u.name || u.email || u.username}</span>
                </label>
              ))}
            </div>
          </div>
        ) : (
          <label className="block text-sm">
            User
            <select className="border p-2 w-full" value={singleUser} onChange={e => setSingleUser(e.target.value)}>
              <option value="">— pick a user —</option>
              {eligibleUsers.map(u => (
                <option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>
              ))}
            </select>
          </label>
        )}

        <div>
          <button className="px-3 py-2 bg-black text-white rounded">Save clocking</button>
        </div>
      </form>

      {/* Filters for history */}
      <div className="border rounded p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="border p-2"
            placeholder="Search notes/type…"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && load()}
            style={{ minWidth: 240 }}
          />
          <select className="border p-2" value={filterProjectId} onChange={e => setFilterProjectId(e.target.value)}>
            <option value="">Project (any)</option>
            {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
          <select className="border p-2" value={filterUserId} onChange={e => setFilterUserId(e.target.value)}>
            <option value="">User (any)</option>
            {users.map(u => <option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>)}
          </select>
          <select className="border p-2" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">Type (any)</option>
            {ATTENDANCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className="border p-2" type="date" value={from} onChange={e => setFrom(e.target.value)} />
          <input className="border p-2" type="date" value={to} onChange={e => setTo(e.target.value)} />
          <button className="px-3 py-2 border rounded" onClick={load}>Apply</button>
        </div>
      </div>

      {/* History table */}
      <div className="border rounded">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="p-2 text-left">When</th>
              <th className="p-2 text-left">User</th>
              <th className="p-2 text-left">Project</th>
              <th className="p-2 text-left">Type</th>
              <th className="p-2 text-left">Location</th>
              <th className="p-2 text-left">Notes</th>
              <th className="p-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td className="p-4 text-center" colSpan={7}>Loading…</td></tr>
            ) : rows.length ? (
              rows.map(r => {
                const isEditing = editingId === r._id;
                return (
                  <tr key={r._id}>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        r.at ? new Date(r.at).toLocaleString() : "—"
                      ) : (
                        <input
                          className="border p-1"
                          type="datetime-local"
                          value={editForm.at}
                          onChange={e => setEditForm(f => ({ ...f, at: e.target.value }))}
                        />
                      )}
                    </td>
                    <td className="border-t p-2">{r.user?.name || r.user?.email || userName(r.userId)}</td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        r.project?.name || projectName(r.projectId)
                      ) : (
                        <select
                          className="border p-1"
                          value={editForm.projectId}
                          onChange={e => setEditForm(f => ({ ...f, projectId: e.target.value }))}
                        >
                          <option value="">— none —</option>
                          {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        r.type || "—"
                      ) : (
                        <select
                          className="border p-1"
                          value={editForm.type}
                          onChange={e => setEditForm(f => ({ ...f, type: e.target.value }))}
                        >
                          {ATTENDANCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="border-t p-2">
                      {r.location && (r.location.lat != null && r.location.lng != null)
                        ? `${r.location.lat.toFixed?.(5) ?? r.location.lat}, ${r.location.lng.toFixed?.(5) ?? r.location.lng}` +
                          (r.location.acc != null ? ` (${r.location.acc}m)` : "")
                        : "—"}
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        r.notes || "—"
                      ) : (
                        <input
                          className="border p-1 w-full"
                          value={editForm.notes}
                          onChange={e => setEditForm(f => ({ ...f, notes: e.target.value }))}
                        />
                      )}
                    </td>
                    <td className="border-t p-2 text-right">
                      {!isEditing ? (
                        <>
                          <button className="px-2 py-1 border rounded mr-2" onClick={() => startEdit(r)}>Edit</button>
                          <button className="px-2 py-1 border rounded" onClick={() => del(r._id)}>Delete</button>
                        </>
                      ) : (
                        <>
                          <button className="px-2 py-1 border rounded mr-2" onClick={() => saveEdit(r._id)}>Save</button>
                          <button className="px-2 py-1 border rounded" onClick={cancelEdit}>Cancel</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr><td className="p-4 text-center" colSpan={7}>No clockings</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
