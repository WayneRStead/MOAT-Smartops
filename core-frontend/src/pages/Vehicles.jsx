// src/pages/Vehicles.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";

/* --- Reuse the same StatusBadge look as VehicleDetail --- */
function StatusBadge({ value }) {
  const map = {
    active: "bg-green-100 text-green-800",
    workshop: "bg-amber-100 text-amber-800",
    retired: "bg-gray-200 text-gray-800",
  };
  const cls = map[value] || "bg-gray-100 text-gray-800";
  return <span className={`text-xs px-2 py-1 rounded ${cls}`}>{value || "—"}</span>;
}

/* --- Label helpers --- */
function userLabelFrom(users, uidOrObj) {
  if (!uidOrObj) return "—";
  if (typeof uidOrObj === "object" && (uidOrObj.name || uidOrObj.email)) {
    return uidOrObj.name || uidOrObj.email;
  }
  const uid = String(uidOrObj);
  const u = users.find((x) => String(x._id) === uid);
  return u ? (u.name || u.email || u.username || uid) : uid;
}
function projectLabelFrom(projects, pid) {
  if (!pid) return "—";
  const p = projects.find((pr) => String(pr._id) === String(pid));
  return p?.name || String(pid);
}

/* --- Small utility for CSV escaping --- */
function csvEscape(s) {
  const str = String(s ?? "");
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

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
  const [statusFilter, setStatusFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [driverFilter, setDriverFilter] = useState("");

  // Create-new inline panel
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    reg: "",
    make: "",
    model: "",
    year: "",
    status: "active",
    projectId: "",
    driverId: "",
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
      // sort by updated desc
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
          v.reg, v.make, v.model, v.year,
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
      [
        "Registration",
        "Make",
        "Model",
        "Year",
        "Status",
        "Driver",
        "Project",
        "Created",
        "Updated",
      ],
      ...filtered.map((v) => [
        v.reg ?? "",
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

  // ---- Filter chips (badges) ----
  const activeChips = useMemo(() => {
    const chips = [];
    if (q.trim()) chips.push({ k: "q", label: `Search: "${q.trim()}"` });
    if (statusFilter) chips.push({ k: "status", label: `Status: ${statusFilter}` });
    if (projectFilter) chips.push({ k: "project", label: `Project: ${projectLabel(projectFilter)}` });
    if (driverFilter) chips.push({ k: "driver", label: `Driver: ${userLabel(driverFilter)}` });
    return chips;
  }, [q, statusFilter, projectFilter, driverFilter, users, projects]);

  function clearChip(k) {
    if (k === "q") setQ("");
    if (k === "status") setStatusFilter("");
    if (k === "project") setProjectFilter("");
    if (k === "driver") setDriverFilter("");
  }
  function clearAllFilters() {
    setQ("");
    setStatusFilter("");
    setProjectFilter("");
    setDriverFilter("");
  }

  // ---- Create New Vehicle ----
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
      };
      const { data } = await api.post("/vehicles", payload);
      // Option A: jump to the new vehicle detail (most convenient to continue editing)
      navigate(`/vehicles/${data._id || data.id}`);
      // Option B (commented): stay on list and refresh
      // await loadVehicles();
      // setShowCreate(false);
      // setInfo("Vehicle created.");
      // setTimeout(() => setInfo(""), 1200);
    } catch (e2) {
      setCreateErr(e2?.response?.data?.error || String(e2));
    } finally {
      setCreateSaving(false);
    }
  }

  function toggleCreate() {
    setShowCreate((s) => !s);
    setCreateErr("");
  }

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Vehicles</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportCsv}
            disabled={!filtered.length}
            className="px-3 py-2 border rounded"
            title={!filtered.length ? "No rows to export" : "Export filtered vehicles to CSV"}
          >
            Export CSV
          </button>
          <button
            type="button"
            className="px-3 py-2 border rounded"
            onClick={toggleCreate}
            aria-expanded={showCreate ? "true" : "false"}
            aria-controls="create-vehicle-panel"
          >
            {showCreate ? "Close" : "New Vehicle"}
          </button>
        </div>
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      {/* Create new panel */}
      {showCreate && (
        <form
          id="create-vehicle-panel"
          onSubmit={handleCreate}
          className="border rounded p-3 space-y-2 bg-gray-50"
        >
          <div className="text-sm font-semibold">Create Vehicle</div>
          {createErr && <div className="text-red-600 text-sm">{createErr}</div>}

          <div className="grid gap-2 md:grid-cols-4">
            <label className="text-sm">
              Registration
              <input
                className="border p-2 w-full"
                value={createForm.reg}
                onChange={(e) => setCreateForm((f) => ({ ...f, reg: e.target.value }))}
                placeholder="e.g. ABC123"
              />
            </label>
            <label className="text-sm">
              Make
              <input
                className="border p-2 w-full"
                value={createForm.make}
                onChange={(e) => setCreateForm((f) => ({ ...f, make: e.target.value }))}
                placeholder="e.g. Toyota"
              />
            </label>
            <label className="text-sm">
              Model
              <input
                className="border p-2 w-full"
                value={createForm.model}
                onChange={(e) => setCreateForm((f) => ({ ...f, model: e.target.value }))}
                placeholder="e.g. Hilux"
              />
            </label>
            <label className="text-sm">
              Year
              <input
                className="border p-2 w-full"
                type="number"
                inputMode="numeric"
                min="1900"
                max="2100"
                value={createForm.year}
                onChange={(e) => setCreateForm((f) => ({ ...f, year: e.target.value }))}
                placeholder="e.g. 2020"
              />
            </label>

            <label className="text-sm">
              Status
              <select
                className="border p-2 w-full"
                value={createForm.status}
                onChange={(e) => setCreateForm((f) => ({ ...f, status: e.target.value }))}
              >
                <option value="active">active</option>
                <option value="workshop">workshop</option>
                <option value="retired">retired</option>
              </select>
            </label>

            <label className="text-sm">
              Project
              <select
                className="border p-2 w-full"
                value={createForm.projectId}
                onChange={(e) => setCreateForm((f) => ({ ...f, projectId: e.target.value }))}
              >
                <option value="">— none —</option>
                {projects.map((p) => (
                  <option key={p._id} value={p._id}>{p.name}</option>
                ))}
              </select>
            </label>

            <label className="text-sm">
              Driver
              <select
                className="border p-2 w-full"
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

          <div className="flex items-center gap-2 pt-1">
            <button
              className="px-3 py-2 bg-black text-white rounded disabled:opacity-60"
              disabled={createSaving}
              type="submit"
              title={createSaving ? "Creating…" : "Create and open"}
            >
              {createSaving ? "Creating…" : "Create & Open"}
            </button>
            <button
              type="button"
              className="px-3 py-2 border rounded"
              onClick={() => {
                setShowCreate(false);
                setCreateErr("");
              }}
            >
              Cancel
            </button>
            <div className="text-xs text-gray-500 ml-auto">
              Tip: You can leave most fields blank and fill them later.
            </div>
          </div>
        </form>
      )}

      {/* Filters */}
      <fieldset className="border rounded p-3">
        <legend className="px-2 text-xs uppercase tracking-wide text-gray-600">Filters</legend>

        <div className="grid gap-2 md:grid-cols-4">
          <label className="text-sm">
            Search
            <input
              className="border p-2 w-full"
              placeholder="Reg, make, model, driver, project…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>

          <label className="text-sm">
            Status
            <select
              className="border p-2 w-full"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">Any</option>
              <option value="active">active</option>
              <option value="workshop">workshop</option>
              <option value="retired">retired</option>
            </select>
          </label>

          <label className="text-sm">
            Project
            <select
              className="border p-2 w-full"
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
            >
              <option value="">Any</option>
              {projects.map((p) => (
                <option key={p._id} value={p._id}>{p.name}</option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            Driver
            <select
              className="border p-2 w-full"
              value={driverFilter}
              onChange={(e) => setDriverFilter(e.target.value)}
            >
              <option value="">Any</option>
              {users.map((u) => (
                <option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>
              ))}
            </select>
          </label>
        </div>

        {/* Active filter chips */}
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {activeChips.length === 0 ? (
            <span className="text-xs text-gray-500">No filters applied</span>
          ) : (
            activeChips.map((chip) => (
              <span
                key={chip.k}
                className="inline-flex items-center gap-2 text-xs bg-gray-100 text-gray-800 rounded-full pl-2 pr-1 py-1"
                title="Click × to remove"
              >
                {chip.label}
                <button
                  type="button"
                  className="w-5 h-5 leading-none text-gray-600 hover:text-black"
                  onClick={() => clearChip(chip.k)}
                >
                  ×
                </button>
              </span>
            ))
          )}

          <div className="ml-auto">
            <button
              type="button"
              onClick={clearAllFilters}
              disabled={activeChips.length === 0}
              className="px-3 py-1 border rounded text-sm"
              title={activeChips.length === 0 ? "Nothing to clear" : "Clear all filters"}
            >
              Clear filters
            </button>
          </div>
        </div>
      </fieldset>

      {/* Counts */}
      <div className="text-sm text-gray-700">
        Showing <b>{filtered.length}</b> of {vehicles.length} {loading ? "(loading…)" : ""}
      </div>

      {/* Table */}
      <div className="border rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 sticky top-0 z-10">
            <tr>
              <th className="p-2 text-left">Registration</th>
              <th className="p-2 text-left">Vehicle</th>
              <th className="p-2 text-left">Status</th>
              <th className="p-2 text-left">Driver</th>
              <th className="p-2 text-left">Project</th>
              <th className="p-2 text-left">Updated</th>
              <th className="p-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length ? (
              filtered.map((v) => {
                const drvId = v?.driver?._id || v?.driverId || "";
                const isSaving = !!saving[v._id];
                return (
                  <tr key={v._id} className="border-t">
                    <td className="p-2 align-top">
                      <Link className="underline" to={`/vehicles/${v._id}`}>{v.reg || "—"}</Link>
                    </td>
                    <td className="p-2 align-top">
                      <div className="font-medium">
                        {(v.make || "—")}{v.model ? ` ${v.model}` : ""}{v.year ? ` · ${v.year}` : ""}
                      </div>
                      <div className="text-xs text-gray-600">
                        Created {v.createdAt ? new Date(v.createdAt).toLocaleDateString() : "—"}
                      </div>
                    </td>
                    <td className="p-2 align-top">
                      <div className="flex items-center gap-2">
                        <StatusBadge value={v.status || "active"} />
                        <select
                          className="border p-1 text-xs"
                          value={v.status || "active"}
                          onChange={(e) => updateStatus(v._id, e.target.value)}
                          disabled={isSaving}
                          title={isSaving ? "Saving…" : "Change status"}
                        >
                          <option value="active">active</option>
                          <option value="workshop">workshop</option>
                          <option value="retired">retired</option>
                        </select>
                        {isSaving && <span className="text-xs text-gray-500">Saving…</span>}
                      </div>
                    </td>
                    <td className="p-2 align-top">{userLabel(drvId)}</td>
                    <td className="p-2 align-top">
                      {v.projectId ? (
                        <Link className="underline" to={`/projects/${v.projectId}`}>
                          {projectLabel(v.projectId)}
                        </Link>
                      ) : "—"}
                    </td>
                    <td className="p-2 align-top">
                      {v.updatedAt ? new Date(v.updatedAt).toLocaleString() : "—"}
                    </td>
                    <td className="p-2 align-top text-right">
                      <Link className="px-2 py-1 border rounded" to={`/vehicles/${v._id}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td className="p-4 text-center text-gray-600" colSpan={7}>
                  {loading ? "Loading vehicles…" : "No vehicles match your filters"}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
