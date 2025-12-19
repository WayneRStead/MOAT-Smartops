// src/pages/Vehicles.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";

/* --- Compact status chip --- */
function StatusBadge({ value }) {
  const map = {
    active: "bg-green-100 text-green-800",
    workshop: "bg-amber-100 text-amber-800",
    retired: "bg-gray-200 text-gray-800",
    stolen: "bg-red-100 text-red-700",
  };
  const cls = map[value] || "bg-gray-100 text-gray-800";
  return <span className={`text-xs px-2 py-0.5 rounded ${cls}`}>{value || "—"}</span>;
}

/* --- Small modal (same family look as elsewhere) --- */
function Modal({ open, title, onClose, children, footer }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center">
      {/* dark grey backdrop (no blur, not see-through content behind) */}
      <div
        className="absolute inset-0"
        style={{ background: "rgba(17,24,39,0.60)" }} // ~tailwind bg-black/60
        onClick={onClose}
      />
      {/* white panel */}
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

/* --- Label helpers --- */
function userLabelFrom(users, uidOrObj) {
  if (!uidOrObj) return "—";
  if (typeof uidOrObj === "object" && (uidOrObj.name || uidOrObj.email))
    return uidOrObj.name || uidOrObj.email;
  const uid = String(uidOrObj);
  const u = users.find((x) => String(x._id) === uid);
  return u ? (u.name || u.email || u.username || uid) : uid;
}
function projectLabelFrom(projects, pid) {
  if (!pid) return "—";
  const p = projects.find((pr) => String(pr._id) === String(pid));
  return p?.name || String(pid);
}

/* --- CSV escaping --- */
function csvEscape(s) {
  const str = String(s ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/* --- Vehicle type options (mirror backend enum) --- */
const VEHICLE_TYPES = [
  "car",
  "pickup",
  "truck",
  "van",
  "motorcycle",
  "bus",
  "trailer",
  "equipment",
  "other",
];

export default function Vehicles() {
  const navigate = useNavigate();

  const [vehicles, setVehicles] = useState([]);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  // Inline save state (per-row)
  const [saving, setSaving] = useState({}); // { [vehicleId]: true }

  // Filters
  const [q, setQ] = useState(""); // search
  const [statusFilter, setStatusFilter] = useState(""); // "", "active", "workshop", "retired", "stolen"
  const [projectFilter, setProjectFilter] = useState("");
  const [driverFilter, setDriverFilter] = useState("");

  // Create (now as modal)
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    reg: "",
    make: "",
    model: "",
    year: "",
    status: "active",
    projectId: "",
    driverId: "",
    vin: "",
    vehicleType: "car",
  });
  const [createSaving, setCreateSaving] = useState(false);
  const [createErr, setCreateErr] = useState("");

  // ---- Loaders ----
  async function loadVehicles() {
    setErr("");
    setLoading(true);
    try {
      const { data } = await api.get("/vehicles", { params: { limit: 1000 } });
      const arr = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
      arr.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
      setVehicles(arr);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setLoading(false);
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
    loadVehicles();
    loadProjects();
    loadUsers();
  }, []);

  // ---- Derived labels ----
  const userLabel = (x) => userLabelFrom(users, x);
  const projectLabel = (x) => projectLabelFrom(projects, x);

  // ---- Filtering ----
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return vehicles.filter((v) => {
      if (statusFilter && (v.status || "") !== statusFilter) return false;
      if (projectFilter && String(v.projectId || "") !== String(projectFilter)) return false;
      const drvId = v?.driver?._id || v?.driverId || "";
      if (driverFilter && String(drvId) !== String(driverFilter)) return false;
      if (term) {
        const hay = [
          v.reg, v.make, v.model, v.year, v.vin, v.vehicleType, v.status,
          userLabel(drvId),
          projectLabel(v.projectId),
        ].map((x) => String(x ?? "").toLowerCase());
        if (!hay.some((s) => s.includes(term))) return false;
      }
      return true;
    });
  }, [vehicles, statusFilter, projectFilter, driverFilter, q, users, projects]);

  // ---- Inline update: status ----
  async function updateStatus(vehicleId, nextStatus) {
    if (!vehicleId) return;
    setErr("");
    setInfo("");
    setSaving((m) => ({ ...m, [vehicleId]: true }));
    try {
      const { data } = await api.put(`/vehicles/${vehicleId}`, { status: nextStatus });
      setVehicles((prev) => prev.map((x) => (String(x._id) === String(vehicleId) ? data : x)));
      setInfo("Status updated.");
      setTimeout(() => setInfo(""), 1200);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setSaving((m) => ({ ...m, [vehicleId]: false }));
    }
  }

  // ---- Export CSV (filtered rows) ----
  function exportCsv() {
    const rows = [
      ["Registration","VIN","Type","Make","Model","Year","Status","Driver","Project","Created","Updated"],
      ...filtered.map((v) => [
        v.reg ?? "",
        v.vin ?? "",
        v.vehicleType ?? "",
        v.make ?? "",
        v.model ?? "",
        v.year ?? "",
        v.status ?? "",
        userLabel(v.driver || v.driverId),
        projectLabel(v.projectId),
        v.createdAt ? new Date(v.createdAt).toISOString() : "",
        v.updatedAt ? new Date(v.updatedAt).toISOString() : "",
      ]),
    ];
    const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "vehicles.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- Create New Vehicle (modal submit) ----
  async function handleCreate(e) {
    e?.preventDefault?.();
    if (createSaving) return;
    setCreateErr("");
    setErr("");
    setInfo("");
    setCreateSaving(true);
    try {
      const payload = {
        reg: createForm.reg || undefined,
        make: createForm.make || undefined,
        model: createForm.model || undefined,
        year: createForm.year ? Number(createForm.year) : undefined,
        status: createForm.status || "active",
        projectId: createForm.projectId || undefined,
        driverId: createForm.driverId || undefined,
        vin: createForm.vin || undefined,
        vehicleType: createForm.vehicleType || undefined,
      };
      const { data } = await api.post("/vehicles", payload);
      navigate(`/vehicles/${data._id || data.id}`);
    } catch (e2) {
      setCreateErr(e2?.response?.data?.error || String(e2));
    } finally {
      setCreateSaving(false);
    }
  }

  const statusTabs = ["", "active", "workshop", "retired", "stolen"];
  const statusLabel = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "All");

  return (
    <div className="max-w-7xl mx-auto p-4">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Vehicles</h1>
        <div className="flex items-center gap-2">
          <input
            className="input input-bordered"
            style={{ minWidth: 260 }}
            placeholder="Search reg, VIN, type, make, model, driver, project…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            type="button"
            onClick={exportCsv}
            disabled={!filtered.length}
            className="btn btn-sm"
            title={!filtered.length ? "No rows to export" : "Export filtered vehicles to CSV"}
          >
            Export CSV
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => { setCreateOpen(true); setCreateErr(""); }}
          >
            New Vehicle
          </button>
        </div>
      </div>

      {err && <div className="text-red-600 mt-2">{err}</div>}
      {info && <div className="text-green-700 mt-2">{info}</div>}

      {/* Filters row — project first, then status tabs to the right (no outer border box) */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="text-sm flex items-center gap-2">
          <span className="text-gray-600">Project</span>
          <select
            className="select select-bordered select-sm"
            value={projectFilter}
            onChange={(e) => setProjectFilter(e.target.value)}
          >
            <option value="">Any</option>
            {projects.map((p) => (
              <option key={p._id} value={p._id}>{p.name}</option>
            ))}
          </select>
        </label>

        {/* Status tabs (borderless group) */}
        <div className="flex items-center gap-1 ml-2">
          {statusTabs.map((s) => {
            const active = statusFilter === s;
            return (
              <button
                key={s || "all"}
                className={`px-3 py-2 rounded ${active ? "bg-black text-white" : "hover:bg-gray-100"}`}
                onClick={() => setStatusFilter(s)}
                type="button"
              >
                {statusLabel(s)}
              </button>
            );
          })}
        </div>

        {/* Optional: Driver filter stays inline too */}
        <label className="text-sm flex items-center gap-2 ml-2">
          <span className="text-gray-600">Driver</span>
          <select
            className="select select-bordered select-sm"
            value={driverFilter}
            onChange={(e) => setDriverFilter(e.target.value)}
          >
            <option value="">Any</option>
            {users.map((u) => (
              <option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>
            ))}
          </select>
        </label>

        <div className="ml-auto text-sm text-gray-700">
          Showing <b>{filtered.length}</b> of {vehicles.length} {loading ? "(loading…)" : ""}
        </div>
      </div>

      {/* Table */}
      <div className="mt-3 overflow-x-auto rounded-xl border">
        <table className="table w-full">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="whitespace-nowrap">Registration</th>
              <th>Vehicle</th>
              <th>Status</th>
              <th>Driver</th>
              <th>Project</th>
              <th className="whitespace-nowrap">Updated</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length ? (
              filtered.map((v) => {
                const drvId = v?.driver?._id || v?.driverId || "";
                const drvName = userLabel(drvId);
                const projName = projectLabel(v.projectId);
                const isSaving = !!saving[v._id];
                return (
                  <tr key={v._id}>
                    <td className="whitespace-nowrap align-top">
                      <Link className="underline" to={`/vehicles/${v._id}`}>{v.reg || "—"}</Link>
                    </td>
                    <td className="align-top">
                      <div className="font-medium truncate" title={`${v.make || ""} ${v.model || ""} ${v.year || ""}`.trim()}>
                        {(v.make || "—")}{v.model ? ` ${v.model}` : ""}{v.year ? ` · ${v.year}` : ""}
                      </div>
                      <div className="text-xs text-gray-600">
                        VIN: {v.vin || "—"}{v.vehicleType ? ` · ${v.vehicleType}` : ""}
                      </div>
                      <div className="text-xs text-gray-600">
                        Created {v.createdAt ? new Date(v.createdAt).toLocaleDateString() : "—"}
                      </div>
                    </td>
                    <td className="align-top">
                      <div className="flex items-center gap-2">
                        <StatusBadge value={v.status || "active"} />
                        <select
                          className="select select-bordered select-xs"
                          value={v.status || "active"}
                          onChange={(e) => updateStatus(v._id, e.target.value)}
                          disabled={isSaving}
                          title={isSaving ? "Saving…" : "Change status"}
                        >
                          <option value="active">active</option>
                          <option value="workshop">workshop</option>
                          <option value="retired">retired</option>
                          <option value="stolen">stolen</option>
                        </select>
                      </div>
                    </td>
                    <td className="align-top">
                      <div className="truncate max-w-[220px]" title={drvName}>{drvName}</div>
                    </td>
                    <td className="align-top">
                      {v.projectId ? (
                        <Link className="underline block truncate max-w-[240px]" to={`/projects/${v.projectId}`} title={projName}>
                          {projName}
                        </Link>
                      ) : "—"}
                    </td>
                    <td className="whitespace-nowrap align-top tabular-nums">
                      {v.updatedAt ? new Date(v.updatedAt).toLocaleString() : "—"}
                    </td>
                    <td className="text-right align-top">
                      <Link className="btn btn-sm" to={`/vehicles/${v._id}`}>Open</Link>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td className="p-4 text-gray-600" colSpan={7}>
                  {loading ? "Loading vehicles…" : "No vehicles match your filters"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* New Vehicle Modal */}
      <Modal
        open={createOpen}
        title="Create Vehicle"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <button
              className="btn"
              onClick={() => setCreateOpen(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="btn btn-primary disabled:opacity-60"
              disabled={createSaving}
              onClick={handleCreate}
              type="button"
            >
              {createSaving ? "Creating…" : "Create & Open"}
            </button>
          </>
        }
      >
        {createErr && <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">{createErr}</div>}
        <div className="grid gap-2 md:grid-cols-4">
          <label className="text-sm">Registration
            <input
              className="w-full"
              value={createForm.reg}
              onChange={(e) => setCreateForm((f) => ({ ...f, reg: e.target.value }))}
            />
          </label>
          <label className="text-sm">VIN
            <input
              className="w-full"
              placeholder="17 characters"
              value={createForm.vin}
              onChange={(e) => setCreateForm((f) => ({ ...f, vin: e.target.value.toUpperCase() }))}
            />
          </label>
          <label className="text-sm">Type
            <select
              className="w-full"
              value={createForm.vehicleType}
              onChange={(e) => setCreateForm((f) => ({ ...f, vehicleType: e.target.value }))}
            >
              {VEHICLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="text-sm">Year
            <input
              className="w-full"
              type="number"
              min="1900"
              max="2100"
              value={createForm.year}
              onChange={(e) => setCreateForm((f) => ({ ...f, year: e.target.value }))}
            />
          </label>
          <label className="text-sm">Make
            <input
              className="w-full"
              value={createForm.make}
              onChange={(e) => setCreateForm((f) => ({ ...f, make: e.target.value }))}
            />
          </label>
          <label className="text-sm">Model
            <input
              className="w-full"
              value={createForm.model}
              onChange={(e) => setCreateForm((f) => ({ ...f, model: e.target.value }))}
            />
          </label>
          <label className="text-sm">Status
            <select
              className="w-full"
              value={createForm.status}
              onChange={(e) => setCreateForm((f) => ({ ...f, status: e.target.value }))}
            >
              <option value="active">active</option>
              <option value="workshop">workshop</option>
              <option value="retired">retired</option>
              <option value="stolen">stolen</option>
            </select>
          </label>
          <label className="text-sm">Project
            <select
              className="w-full"
              value={createForm.projectId}
              onChange={(e) => setCreateForm((f) => ({ ...f, projectId: e.target.value }))}
            >
              <option value="">— none —</option>
              {projects.map((p) => (
                <option key={p._id} value={p._id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">Driver
            <select
              className="w-full"
              value={createForm.driverId}
              onChange={(e) => setCreateForm((f) => ({ ...f, driverId: e.target.value }))}
            >
              <option value="">— none —</option>
              {users.map((u) => (
                <option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="text-xs text-gray-500">
          Tip: You can leave most fields blank and fill them later.
        </div>
      </Modal>
    </div>
  );
}
