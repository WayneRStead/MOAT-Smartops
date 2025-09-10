// src/pages/VehicleDetail.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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

export default function VehicleDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [v, setV] = useState(null);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  // Reminders
  const [reminders, setReminders] = useState([]);
  const [nextDue, setNextDue] = useState(null);
  const [rErr, setRErr] = useState("");
  const [rInfo, setRInfo] = useState("");
  const [rForm, setRForm] = useState({ kind: "date", dueDate: "", dueOdometer: "", notes: "" });

  // Logbook
  const [entries, setEntries] = useState([]);
  const [lbErr, setLbErr] = useState("");
  const [lbInfo, setLbInfo] = useState("");

  // Filters
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [minKm, setMinKm] = useState("");
  const [maxKm, setMaxKm] = useState("");

  // Create log entry
  const [form, setForm] = useState({
    title: "",
    notes: "",
    tags: "",
    ts: new Date().toISOString().slice(0, 16), // local datetime input format
    odometerStart: "",
    odometerEnd: "",
  });

  // ----- Loaders -----
  async function load() {
    setErr(""); setInfo("");
    try {
      const { data } = await api.get(`/vehicles/${id}`);
      setV(data);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function loadProjects() {
    try {
      const { data } = await api.get("/projects", { params: { limit: 1000 } });
      setProjects(Array.isArray(data) ? data : []);
    } catch { setProjects([]); }
  }
  async function loadUsers() {
    try {
      const { data } = await api.get("/users", { params: { limit: 1000 } });
      setUsers(Array.isArray(data) ? data : []);
    } catch { setUsers([]); }
  }
  async function loadTasks() {
    try {
      const { data } = await api.get("/tasks", { params: { limit: 1000 } });
      setTasks(Array.isArray(data) ? data : []);
    } catch { setTasks([]); }
  }
  async function loadReminders() {
    setRErr(""); setRInfo("");
    try {
      const { data } = await api.get(`/vehicles/${id}/reminders`);
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
    } catch (e) { setRErr(e?.response?.data?.error || String(e)); }
  }
  async function loadLogbook() {
    setLbErr(""); setLbInfo("");
    try {
      const params = { vehicleId: id, limit: 200 };
      if (q) params.q = q;
      if (tag) params.tag = tag;
      if (minKm !== "") params.minKm = Number(minKm);
      if (maxKm !== "") params.maxKm = Number(maxKm);
      const { data } = await api.get("/logbook", { params });
      setEntries(Array.isArray(data) ? data : []);
    } catch (e) { setLbErr(e?.response?.data?.error || String(e)); }
  }

  useEffect(() => {
    load();
    loadProjects();
    loadUsers();
    loadTasks();
    loadReminders();
    loadLogbook();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ----- Vehicle meta -----
  async function save(patch) {
    try {
      const { data } = await api.put(`/vehicles/${id}`, patch);
      setV(data);
      setInfo("Saved");
      setTimeout(() => setInfo(""), 1200);
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
  }
  async function setStatus(newStatus) { await save({ status: newStatus }); }
  async function del() {
    if (!confirm("Delete this vehicle?")) return;
    try {
      await api.delete(`/vehicles/${id}`);
      navigate("/vehicles");
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
  }

  // ----- Reminders CRUD -----
  async function addReminder(e) {
    e.preventDefault();
    setRErr(""); setRInfo("");
    try {
      const payload = {
        kind: rForm.kind,
        dueDate: rForm.kind === 'date' ? rForm.dueDate : undefined,
        dueOdometer: rForm.kind === 'odometer' ? Number(rForm.dueOdometer) : undefined,
        notes: rForm.notes || "",
      };
      const { data } = await api.post(`/vehicles/${id}/reminders`, payload);
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
      setRForm({ kind: "date", dueDate: "", dueOdometer: "", notes: "" });
      setRInfo("Reminder added.");
    } catch (e) { setRErr(e?.response?.data?.error || String(e)); }
  }
  async function toggleReminderActive(rid, active) {
    try {
      const { data } = await api.put(`/vehicles/${id}/reminders/${rid}`, { active });
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
    } catch (e) { setRErr(e?.response?.data?.error || String(e)); }
  }
  async function deleteReminder(rid) {
    if (!confirm("Delete this reminder?")) return;
    try {
      const { data } = await api.delete(`/vehicles/${id}/reminders/${rid}`);
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
    } catch (e) { setRErr(e?.response?.data?.error || String(e)); }
  }

  // ----- Logbook helpers -----
  async function createEntry(e) {
    e.preventDefault();
    setLbErr(""); setLbInfo("");
    try {
      const payload = {
        vehicleId: id,
        title: (form.title || "").trim(),
        notes: form.notes || "",
        tags: (form.tags || "").split(",").map(s => s.trim()).filter(Boolean),
        ts: form.ts ? new Date(form.ts).toISOString() : undefined,
        odometerStart: form.odometerStart !== "" ? Number(form.odometerStart) : undefined,
        odometerEnd:   form.odometerEnd   !== "" ? Number(form.odometerEnd)   : undefined,
      };
      if (!payload.title) return setLbErr("Title is required");
      const { data } = await api.post("/logbook", payload);
      setEntries(prev => [data, ...prev]);
      setForm({
        title: "",
        notes: "",
        tags: "",
        ts: new Date().toISOString().slice(0, 16),
        odometerStart: "",
        odometerEnd: "",
      });
      setLbInfo("Log entry added.");
    } catch (e) { setLbErr(e?.response?.data?.error || String(e)); }
  }
  async function deleteEntry(entryId) {
    if (!confirm("Delete this log entry?")) return;
    setLbErr(""); setLbInfo("");
    try {
      await api.delete(`/logbook/${entryId}`);
      setEntries(prev => prev.filter(x => x._id !== entryId));
      setLbInfo("Log entry deleted.");
    } catch (e) { setLbErr(e?.response?.data?.error || String(e)); }
  }

  // Quick-add presets
  function preset(type) {
    const ts = new Date().toISOString().slice(0, 16);
    if (type === 'fuel') setForm(f => ({ ...f, title: "Fuel", tags: "fuel", ts }));
    if (type === 'service') setForm(f => ({ ...f, title: "Service", tags: "service", ts }));
    if (type === 'tyres') setForm(f => ({ ...f, title: "Tyres", tags: "tyre", ts }));
    if (type === 'travel') setForm(f => ({ ...f, title: "Travel", tags: "travel", ts }));
  }

  // ----- Derived -----
  const tagOptions = useMemo(() => {
    const s = new Set();
    entries.forEach(e => (e.tags || []).forEach(t => s.add(t)));
    return Array.from(s);
  }, [entries]);

  const totalDistance = useMemo(() => {
    return entries.reduce((acc, e) => {
      if (typeof e.distance === "number") return acc + e.distance;
      if (e.odometerStart != null && e.odometerEnd != null) {
        const d = Math.max(0, Number(e.odometerEnd) - Number(e.odometerStart));
        return acc + (Number.isFinite(d) ? d : 0);
      }
      return acc;
    }, 0);
  }, [entries]);

  function exportCsv() {
    const rows = [
      ["When", "Title", "Odometer Start", "Odometer End", "Distance (km)", "Tags", "Notes"],
      ...entries.map(e => [
        e.ts ? new Date(e.ts).toISOString() : "",
        e.title || "",
        e.odometerStart ?? "",
        e.odometerEnd ?? "",
        (typeof e.distance === "number"
          ? e.distance
          : (e.odometerStart != null && e.odometerEnd != null
              ? Math.max(0, Number(e.odometerEnd) - Number(e.odometerStart))
              : "")),
        (e.tags || []).join("; "),
        (e.notes || "").replace(/\r?\n/g, " "),
      ])
    ];
    const csv = rows.map(r =>
      r.map(cell => {
        const s = String(cell ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")
    ).join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url;
    a.download = `vehicle_${id}_logbook.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // helpers for labels
  const userLabel = (uidOrObj) => {
    if (!uidOrObj) return "—";
    if (typeof uidOrObj === "object" && (uidOrObj.name || uidOrObj.email)) {
      return uidOrObj.name || uidOrObj.email;
    }
    const uid = String(uidOrObj);
    const u = users.find(x => String(x._id) === uid);
    return u ? (u.name || u.email || u.username || uid) : uid;
  };
  const taskLabel = (tidOrObj) => {
    if (!tidOrObj) return "—";
    if (typeof tidOrObj === "object" && (tidOrObj._id || tidOrObj.title)) {
      return tidOrObj.title || tidOrObj._id;
    }
    const tid = String(tidOrObj);
    const t = tasks.find(x => String(x._id) === tid);
    return t ? (t.title || tid) : tid;
  };

  const selectedDriverId = v?.driver?._id || v?.driverId || "";
  const selectedTaskId   = v?.task?._id   || v?.taskId   || "";

  if (!v) return <div className="p-4">Loading… {err && <span style={{ color: "crimson" }}>({err})</span>}</div>;

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Vehicle</h1>
        <div className="flex gap-2">
          <button className="px-3 py-2 border rounded" onClick={del}>Delete</button>
          <button className="px-3 py-2 border rounded" onClick={() => navigate(-1)}>Back</button>
        </div>
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      <div className="grid md:grid-cols-2 gap-4">
        {/* Meta */}
        <div className="border rounded p-3 space-y-3">
          <label className="block text-sm">Registration
            <input className="border p-2 w-full"
                   value={v.reg || ""}
                   onChange={e => setV({ ...v, reg: e.target.value })}
                   onBlur={() => v.reg && save({ reg: v.reg })}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">Make
              <input className="border p-2 w-full"
                     value={v.make || ""}
                     onChange={e => setV({ ...v, make: e.target.value })}
                     onBlur={() => save({ make: v.make || "" })}
              />
            </label>
            <label className="block text-sm">Model
              <input className="border p-2 w-full"
                     value={v.model || ""}
                     onChange={e => setV({ ...v, model: e.target.value })}
                     onBlur={() => save({ model: v.model || "" })}
              />
            </label>
          </div>

          <label className="block text-sm">Year
            <input className="border p-2 w-full" type="number" inputMode="numeric" min="1900" max="2100"
                   value={v.year ?? ""}
                   onChange={e => setV({ ...v, year: e.target.value })}
                   onBlur={() => save({ year: v.year ? Number(v.year) : undefined })}
            />
          </label>

          <label className="block text-sm">Project
            <select className="border p-2 w-full"
                    value={v.projectId || ""}
                    onChange={e => { const pid = e.target.value || ""; setV({ ...v, projectId: pid }); save({ projectId: pid || undefined }); }}>
              <option value="">— none —</option>
              {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
          </label>

          {/* NEW: Driver */}
          <label className="block text-sm">Driver
            <div className="flex items-center gap-2">
              <select
                className="border p-2 w-full"
                value={selectedDriverId}
                onChange={(e) => {
                  const val = e.target.value;
                  setV(prev => ({ ...prev, driverId: val || "", driver: undefined }));
                  save({ driverId: val || null });
                }}
              >
                <option value="">— none —</option>
                {users.map(u => (
                  <option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>
                ))}
              </select>
              {selectedDriverId && (
                <button
                  type="button"
                  className="px-2 py-1 border rounded"
                  onClick={() => { setV(prev => ({ ...prev, driverId: "", driver: null })); save({ driverId: null }); }}
                >
                  Clear
                </button>
              )}
            </div>
            {selectedDriverId && (
              <div className="mt-1 text-xs text-gray-600">
                Currently: {userLabel(v.driver || v.driverId)}
              </div>
            )}
          </label>

          {/* NEW: Task allocation */}
          <label className="block text-sm">Task
            <div className="flex items-center gap-2">
              <select
                className="border p-2 w-full"
                value={selectedTaskId}
                onChange={(e) => {
                  const val = e.target.value;
                  setV(prev => ({ ...prev, taskId: val || "", task: undefined }));
                  save({ taskId: val || null });
                }}
              >
                <option value="">— none —</option>
                {tasks.map(t => (
                  <option key={t._id} value={t._id}>{t.title || t._id}</option>
                ))}
              </select>
              {selectedTaskId && (
                <button
                  type="button"
                  className="px-2 py-1 border rounded"
                  onClick={() => { setV(prev => ({ ...prev, taskId: "", task: null })); save({ taskId: null }); }}
                >
                  Clear
                </button>
              )}
            </div>
            {selectedTaskId && (
              <div className="mt-1 text-xs">
                <Link className="underline" to={`/tasks/${selectedTaskId}`}>Open task</Link>
              </div>
            )}
          </label>

          <label className="block text-sm">Status
            <div className="flex items-center gap-2">
              <StatusBadge value={v.status || "active"} />
              <select className="border p-2"
                      value={v.status || "active"}
                      onChange={e => setStatus(e.target.value)}
              >
                <option value="active">active</option>
                <option value="workshop">workshop</option>
                <option value="retired">retired</option>
              </select>
            </div>
          </label>

          <div className="text-sm text-gray-600">
            Created: {v.createdAt ? new Date(v.createdAt).toLocaleString() : "—"}
            <br />
            Updated: {v.updatedAt ? new Date(v.updatedAt).toLocaleString() : "—"}
          </div>
        </div>

        {/* Service Reminders */}
        <div className="border rounded p-3 space-y-3">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Service Reminders</div>
            <div className="text-sm text-gray-700">
              {nextDue?.dateDue && (
                <span className="mr-3">Next date: <b>{new Date(nextDue.dateDue.dueDate).toLocaleDateString()}</b></span>
              )}
              {nextDue?.odoDue && (
                <span>Next km: <b>{nextDue.odoDue.dueOdometer} km</b></span>
              )}
            </div>
          </div>

          {rErr && <div className="text-red-600">{rErr}</div>}
          {rInfo && <div className="text-green-700">{rInfo}</div>}

          {/* Create */}
          <form onSubmit={addReminder} className="grid md:grid-cols-5 gap-2">
            <label className="text-sm">Type
              <select className="border p-2 w-full" value={rForm.kind} onChange={e => setRForm({ ...rForm, kind: e.target.value })}>
                <option value="date">By date</option>
                <option value="odometer">By odometer</option>
              </select>
            </label>
            {rForm.kind === 'date' ? (
              <label className="text-sm md:col-span-2">Due date
                <input className="border p-2 w-full" type="date" value={rForm.dueDate} onChange={e => setRForm({ ...rForm, dueDate: e.target.value })} required />
              </label>
            ) : (
              <label className="text-sm md:col-span-2">Due km
                <input className="border p-2 w-full" type="number" inputMode="numeric" min="0" value={rForm.dueOdometer} onChange={e => setRForm({ ...rForm, dueOdometer: e.target.value })} required />
              </label>
            )}
            <label className="text-sm md:col-span-2">Notes
              <input className="border p-2 w-full" value={rForm.notes} onChange={e => setRForm({ ...rForm, notes: e.target.value })} />
            </label>
            <div className="md:col-span-5">
              <button className="px-3 py-2 bg-black text-white rounded">Add reminder</button>
            </div>
          </form>

          {/* List */}
          <table className="w-full border text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="border p-2 text-left">Type</th>
                <th className="border p-2 text-left">Due</th>
                <th className="border p-2 text-left">Notes</th>
                <th className="border p-2 text-left">Active</th>
                <th className="border p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(reminders || []).map(r => (
                <tr key={r._id}>
                  <td className="border p-2">{r.kind}</td>
                  <td className="border p-2">
                    {r.kind === 'date'
                      ? (r.dueDate ? new Date(r.dueDate).toLocaleDateString() : '—')
                      : (r.dueOdometer != null ? `${r.dueOdometer} km` : '—')}
                  </td>
                  <td className="border p-2">{r.notes || '—'}</td>
                  <td className="border p-2">
                    <label className="inline-flex items-center gap-2">
                      <input type="checkbox" checked={!!r.active} onChange={e => toggleReminderActive(r._id, e.target.checked)} />
                      <span className="text-xs">{r.active ? 'active' : 'paused'}</span>
                    </label>
                  </td>
                  <td className="border p-2 text-right">
                    <button className="px-2 py-1 border rounded" onClick={() => deleteReminder(r._id)}>Delete</button>
                  </td>
                </tr>
              ))}
              {(!reminders || reminders.length === 0) && (
                <tr><td className="p-4 text-center" colSpan={5}>No reminders</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Logbook */}
      <div className="border rounded p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Logbook</div>
          <div className="flex items-center gap-2">
            <input className="border p-2" placeholder="Search title/notes/tag…" value={q}
                   onChange={e => setQ(e.target.value)}
                   onKeyDown={e => e.key === 'Enter' && loadLogbook()}
                   style={{ minWidth: 240 }} />
            <select className="border p-2" value={tag} onChange={e => setTag(e.target.value)}>
              <option value="">Tag (any)</option>
              {Array.from(new Set(entries.flatMap(e => e.tags || []))).map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className="border p-2 w-28" type="number" inputMode="numeric" min="0" placeholder="Min km"
                   value={minKm} onChange={e => setMinKm(e.target.value)} />
            <input className="border p-2 w-28" type="number" inputMode="numeric" min="0" placeholder="Max km"
                   value={maxKm} onChange={e => setMaxKm(e.target.value)} />
            <button className="px-3 py-2 border rounded" onClick={loadLogbook}>Apply</button>
            <button className="px-3 py-2 border rounded" onClick={exportCsv}>Export CSV</button>
          </div>
        </div>

        <div className="text-sm text-gray-700">
          Total distance (current view): <b>{totalDistance}</b> km
        </div>

        {/* Quick add presets */}
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600">Quick add:</span>
          <button className="px-2 py-1 border rounded" onClick={() => preset('travel')}>Travel</button>
          <button className="px-2 py-1 border rounded" onClick={() => preset('fuel')}>Fuel</button>
          <button className="px-2 py-1 border rounded" onClick={() => preset('service')}>Service</button>
          <button className="px-2 py-1 border rounded" onClick={() => preset('tyres')}>Tyres</button>
        </div>

        {/* Create entry */}
        <form onSubmit={createEntry} className="grid md:grid-cols-6 gap-2">
          <label className="text-sm md:col-span-2">Title
            <input className="border p-2 w-full" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required />
          </label>
          <label className="text-sm">Timestamp
            <input className="border p-2 w-full" type="datetime-local" value={form.ts} onChange={e => setForm({ ...form, ts: e.target.value })} />
          </label>
          <label className="text-sm">Odo start (km)
            <input className="border p-2 w-full" type="number" inputMode="numeric" min="0" value={form.odometerStart}
                   onChange={e => setForm({ ...form, odometerStart: e.target.value })} />
          </label>
          <label className="text-sm">Odo end (km)
            <input className="border p-2 w-full" type="number" inputMode="numeric" min="0" value={form.odometerEnd}
                   onChange={e => setForm({ ...form, odometerEnd: e.target.value })} />
          </label>
          <label className="text-sm">Tags (comma)
            <input className="border p-2 w-full" value={form.tags} onChange={e => setForm({ ...form, tags: e.target.value })} placeholder="service, fuel, tyre" />
          </label>
          <label className="text-sm md:col-span-6">Notes
            <textarea className="border p-2 w-full" rows={3} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
          </label>
          <div className="md:col-span-6">
            <button className="px-3 py-2 bg-black text-white rounded">Add entry</button>
          </div>
        </form>

        {lbErr && <div className="text-red-600">{lbErr}</div>}
        {lbInfo && <div className="text-green-700">{lbInfo}</div>}

        {/* List */}
        <table className="w-full border text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="border p-2 text-left">When</th>
              <th className="border p-2 text-left">Title</th>
              <th className="border p-2 text-left">Odo start</th>
              <th className="border p-2 text-left">Odo end</th>
              <th className="border p-2 text-left">Distance</th>
              <th className="border p-2 text-left">Tags</th>
              <th className="border p-2 text-left">Notes</th>
              <th className="border p-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(e => (
              <tr key={e._id}>
                <td className="border p-2">{e.ts ? new Date(e.ts).toLocaleString() : "—"}</td>
                <td className="border p-2">{e.title}</td>
                <td className="border p-2">{e.odometerStart ?? "—"}</td>
                <td className="border p-2">{e.odometerEnd ?? "—"}</td>
                <td className="border p-2">{(typeof e.distance === "number" ? e.distance :
                  (e.odometerStart != null && e.odometerEnd != null ? Math.max(0, e.odometerEnd - e.odometerStart) : "—"))}</td>
                <td className="border p-2">{(e.tags || []).join(", ") || "—"}</td>
                <td className="border p-2">{e.notes || "—"}</td>
                <td className="border p-2 text-right">
                  <button className="px-2 py-1 border rounded" onClick={() => deleteEntry(e._id)}>Delete</button>
                </td>
              </tr>
            ))}
            {!entries.length && <tr><td className="p-4 text-center" colSpan={8}>No log entries</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
