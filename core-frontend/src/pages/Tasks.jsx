// src/pages/Tasks.jsx — layout aligned with Projects.jsx (Invoices toolbar + Vehicles modal)
// Adds: Groups filter + Group column in table (minimal layout change)
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useTheme } from "../ThemeContext";

const STATUSES = [
  "pending",
  "in-progress",
  "paused",
  "paused-problem",
  "finished",
];
const PRIORITIES = ["low", "medium", "high"];

export default function Tasks() {
  const { org } = useTheme();

  const [rows, setRows] = useState([]);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [groups, setGroups] = useState([]);

  // filters
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [projectId, setProjectId] = useState("");
  const [userId, setUserId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [dueFrom, setDueFrom] = useState("");
  const [dueTo, setDueTo] = useState("");

  // modal create/edit
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  const [form, setForm] = useState({
    title: "",
    description: "",
    status: "pending",
    priority: "medium",
    startDate: "",
    dueAt: "",
    projectId: "",
    assignee: "",
    estimatedHours: "",
    tags: "",
    enforceLocationCheck: false,
    enforceQRScan: false,
  });

  // geofence-at-create (optional)
  const [gfFile, setGfFile] = useState(null);
  const [gfRadius, setGfRadius] = useState(50);

  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [warnings, setWarnings] = useState([]);

  // --- Quick Presets from org (unchanged logic) ---
  const quickPresets = useMemo(() => {
    const raw = org?.taskPresets ?? org?.tasks?.quickPresets ?? [];
    const toTagsString = (t) => (Array.isArray(t) ? t.join(", ") : t || "");
    return (Array.isArray(raw) ? raw : [])
      .map((p, idx) => {
        if (typeof p === "string")
          return { key: `p_${idx}`, title: p, tags: "", priority: "" };
        const title = (p?.label || p?.title || "").trim();
        const tags = toTagsString(p?.tags);
        const priority = (p?.priority || "").trim();
        return { key: `p_${idx}`, title, tags, priority };
      })
      .filter((p) => p.title);
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
      const [p, u, g] = await Promise.all([
        api.get("/projects", { params: { limit: 1000 } }),
        api.get("/users", { params: { limit: 1000 } }),
        // Groups endpoint — fall back to org groups if API not present
        api
          .get("/groups", { params: { limit: 1000 } })
          .catch(() => ({
            data: Array.isArray(org?.groups) ? org.groups : [],
          })),
      ]);
      setProjects(Array.isArray(p.data) ? p.data : []);
      setUsers(Array.isArray(u.data) ? u.data : []);
      setGroups(Array.isArray(g.data) ? g.data : []);
    } catch {
      setProjects([]);
      setUsers([]);
      setGroups(Array.isArray(org?.groups) ? org.groups : []);
    }
  }

  async function load() {
    setErr("");
    setInfo("");
    setWarnings([]);
    try {
      const params = { limit: 500 };
      if (q) params.q = q;
      if (status) params.status = status;
      if (priority) params.priority = priority;
      if (projectId) params.projectId = projectId;
      if (userId) params.userId = userId;
      if (groupId) params.groupId = groupId; // NEW: filter by group
      if (dueFrom) params.dueFrom = dueFrom;
      if (dueTo) params.dueTo = dueTo;
      const { data } = await api.get("/tasks", { params });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  useEffect(() => {
    loadRefs();
    load();
  }, []); // eslint-disable-line

  function openCreate() {
    setEditing(null);
    setForm({
      title: "",
      description: "",
      status: "pending",
      priority: "medium",
      startDate: "",
      dueAt: "",
      projectId: "",
      assignee: "",
      estimatedHours: "",
      tags: "",
      enforceLocationCheck: false,
      enforceQRScan: false,
    });
    setGfFile(null);
    setGfRadius(50);
    setModalOpen(true);
  }

  function openEdit(t) {
    setEditing(t);
    setForm({
      title: t.title || "",
      description: t.description || "",
      status: t.status || "pending",
      priority: t.priority || "medium",
      // dates
      startDate: t.startDate ? String(t.startDate).slice(0, 10) : "",
      dueAt: t.dueAt ? String(t.dueAt).slice(0, 10) : "",
      // relations
      projectId: t.projectId || "",
      assignee: t.assignee || "",
      // minutes -> hours (string for input)
      estimatedHours:
        t.estimatedDuration != null
          ? String((Number(t.estimatedDuration) || 0) / 60)
          : "",
      tags: (t.tags || []).join(", "),
      enforceLocationCheck: !!t.enforceLocationCheck,
      enforceQRScan: !!t.enforceQRScan,
    });
    setGfFile(null);
    setGfRadius(50);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
  }

  async function submitModal(e) {
    e.preventDefault();
    setErr("");
    setInfo("");
    setWarnings([]);

    try {
      const payload = {
        title: (form.title || "").trim(),
        description: form.description || "",
        status: form.status,
        priority: form.priority,
        projectId: form.projectId || undefined,
        assignee: form.assignee || undefined,
        startDate: form.startDate || undefined,
        dueAt: form.dueAt || undefined,
        // hours -> minutes (backend stores minutes)
        estimatedDuration:
          form.estimatedHours !== "" && form.estimatedHours != null
            ? Math.round(Number(form.estimatedHours) * 60)
            : undefined,
        tags: (form.tags || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        enforceLocationCheck: !!form.enforceLocationCheck,
        enforceQRScan: !!form.enforceQRScan,
      };
      if (!payload.title) return setErr("Title required");

      if (editing) {
        const { data } = await api.put(`/tasks/${editing._id}`, payload);
        setRows((prev) => prev.map((r) => (r._id === editing._id ? data : r)));
        setInfo("Task updated.");
        setModalOpen(false);
        return;
      }

      // Create
      const { data } = await api.post("/tasks", payload);
      setRows((prev) => [data, ...prev]);
      if (Array.isArray(data?.warnings) && data.warnings.length)
        setWarnings(data.warnings);

      // Optional geofence upload after create
      if (gfFile) {
        const fd = new FormData();
        fd.append("file", gfFile);
        try {
          await api.post(
            `/tasks/${data._id}/geofences/upload?radius=${encodeURIComponent(gfRadius)}`,
            fd,
            { headers: { "Content-Type": "multipart/form-data" } },
          );
          setInfo("Task created + geofence uploaded.");
        } catch (ge) {
          setErr(
            ge?.response?.data?.error || "Created, but geofence upload failed.",
          );
        }
      } else {
        setInfo("Task created.");
      }

      setModalOpen(false);
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }

  const nameOf = (id, arr) => {
    const x = arr.find((a) => String(a._id) === String(id));
    return x ? x.name || x.email || x.username || x._id : "—";
  };

  // -------- Groups helpers (robust to shapes) --------
  const asId = (maybe) =>
    typeof maybe === "string" || typeof maybe === "number"
      ? String(maybe)
      : maybe && (maybe._id || maybe.id || maybe.value)
        ? String(maybe._id || maybe.id || maybe.value)
        : "";

  const groupNamesOfTask = (t) => {
    // Accepts: t.groupId, t.group, t.groups (array of ids or objects), t.teamGroups
    const ids = new Set();
    if (t.groupId) ids.add(String(t.groupId));
    if (t.group) ids.add(asId(t.group));
    if (Array.isArray(t.groups))
      t.groups.forEach((g) => {
        const id = asId(g) || String(g);
        if (id) ids.add(id);
      });
    if (Array.isArray(t.teamGroups))
      t.teamGroups.forEach((g) => {
        const id = asId(g) || String(g);
        if (id) ids.add(id);
      });

    const out = [];
    ids.forEach((id) => out.push(nameOf(id, groups)));
    return out.length ? out : null;
  };

  function renderEstActualCell(t) {
    const est = t.estimatedDuration;
    const act = t.actualDurationMinutes ?? 0;
    if (est == null) return <>— vs {act}m</>;
    const delta = act - est;
    const sign = delta === 0 ? "±" : delta > 0 ? "+" : "−";
    const absDelta = Math.abs(delta);
    const color = delta <= 0 ? "#0a7a32" : "#b91c1c";
    return (
      <div className="flex items-center gap-2">
        <span>
          {est}m vs {act}m
        </span>
        <span
          className="px-2 py-0.5 rounded text-white text-xs"
          style={{ background: color }}
        >
          {sign}
          {absDelta}m
        </span>
      </div>
    );
  }

  function ChecksCell({ t }) {
    const chips = [];
    if (t.enforceLocationCheck)
      chips.push(
        <span key="loc" className="px-2 py-0.5 border rounded text-xs">
          Loc
        </span>,
      );
    if (t.enforceQRScan)
      chips.push(
        <span key="qr" className="px-2 py-0.5 border rounded text-xs">
          QR
        </span>,
      );
    const gfCount = Array.isArray(t.geoFences) ? t.geoFences.length : 0;
    if (gfCount > 0)
      chips.push(
        <span
          key="gf"
          className="px-2 py-0.5 border rounded text-xs"
        >{`GF${gfCount > 1 ? `×${gfCount}` : ""}`}</span>,
      );
    return chips.length ? (
      <div className="flex gap-1 flex-wrap">{chips}</div>
    ) : (
      <span className="text-gray-400">—</span>
    );
  }

  return (
    <div className="max-w-7xl mx-auto p-4">
      {/* Shared page utilities (same set as Projects.jsx) */}
      <style>{`
        .card{ background:#fff; border:1px solid #e5e7eb; border-radius:12px; }
        .table{ width:100%; border-collapse:collapse; }
        .table th,.table td{ padding:.5rem; border-top:1px solid #eef2f7; text-align:left; vertical-align:top; }
        .muted{ color:#64748b; }
        .btn{ border:1px solid #e5e7eb; border-radius:10px; padding:8px 12px; background:#fff; font-size:12px; line-height:18px; }
        .btn-sm{ border:1px solid #e5e7eb; border-radius:8px; padding:6px 10px; background:#fff; font-size:12px; line-height:18px; }
        .input, .select { border:1px solid #e5e7eb; border-radius:8px; padding:8px; font-size:12px; }
        .toolbar{ display:flex; align-items:center; gap:8px; white-space:nowrap; overflow-x:auto; padding:6px; border:1px solid #e5e7eb; border-radius:12px; background:#fff; }
        .toolbar > * { flex: 0 0 auto; }
      `}</style>

      {/* Header  */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Tasks</h1>
        <div className="flex items-center gap-2">
          <div className="text-sm text-gray-600">Total: {rows.length}</div>
          <button className="btn btn-primary" onClick={openCreate}>
            New Task
          </button>
        </div>
      </div>

      {/* Single-row toolbar (Invoices style) */}
      <div className="mt-3 toolbar">
        <input
          className="input"
          style={{ width: 200 }}
          placeholder="Search title/desc…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
        />
        <select
          className="select"
          style={{ width: 120 }}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">Status (any)</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: 120 }}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
        >
          <option value="">Priority (any)</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: 120 }}
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">Project (any)</option>
          {projects.map((p) => (
            <option key={p._id} value={p._id}>
              {p.name}
            </option>
          ))}
        </select>
        {/* NEW: Group filter */}
        <select
          className="select"
          style={{ width: 120 }}
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
        >
          <option value="">Group (any)</option>
          {groups.map((g) => (
            <option key={g._id || g.id} value={String(g._id || g.id)}>
              {g.name || g.title || g.label || g._id || g.id}
            </option>
          ))}
        </select>
        <select
          className="select"
          style={{ width: 120 }}
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
        >
          <option value="">Assignee (any)</option>
          {users.map((u) => (
            <option key={u._id} value={u._id}>
              {u.name || u.email || u.username}
            </option>
          ))}
        </select>
        <input
          className="input"
          type="date"
          style={{ width: 120 }}
          value={dueFrom}
          onChange={(e) => setDueFrom(e.target.value)}
        />
        <input
          className="input"
          type="date"
          style={{ width: 120 }}
          value={dueTo}
          onChange={(e) => setDueTo(e.target.value)}
        />
        <button className="btn" style={{ width: 110 }} onClick={load}>
          Apply
        </button>
      </div>

      {err && (
        <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-sm">
          {err}
        </div>
      )}
      {info && (
        <div className="mt-2 rounded border border-green-200 bg-green-100 p-2 text-sm">
          {info}
        </div>
      )}
      {!!warnings.length && (
        <div className="p-2 rounded border border-yellow-400 bg-yellow-50 text-yellow-800 text-sm mt-2">
          <b>Heads up:</b> {warnings.join(" ")}
        </div>
      )}

      {/* Table (Invoices style card) */}
      <div className="card p-3 mt-3">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-semibold">Tasks</h2>
          <div className="muted text-sm">{rows.length} shown</div>
        </div>
        <table className="table text-sm">
          <thead>
            <tr style={{ background: "#f9fafb" }}>
              <th>Title</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Due</th>
              <th>Est vs Actual</th>
              <th>Project</th>
              {/* NEW: Group column */}
              <th>Group</th>
              <th>Assignee</th>
              <th>Checks</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => {
              const groupNames = groupNamesOfTask(t); // array or null
              return (
                <tr key={t._id}>
                  <td className="p-2 align-top">
                    <Link className="underline" to={`/tasks/${t._id}`}>
                      {t.title}
                    </Link>
                    {(t.tags || []).length > 0 && (
                      <div className="text-xs text-gray-600">
                        {(t.tags || []).join(", ")}
                      </div>
                    )}
                  </td>
                  <td className="p-2 align-top">{t.status}</td>
                  <td className="p-2 align-top">{t.priority}</td>
                  <td className="p-2 align-top">
                    {t.dueAt ? new Date(t.dueAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="p-2 align-top">{renderEstActualCell(t)}</td>
                  <td className="p-2 align-top">
                    {t.projectId ? (
                      <Link
                        className="underline"
                        to={`/projects/${t.projectId}`}
                      >
                        {nameOf(t.projectId, projects)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  {/* NEW: Group cell */}
                  <td className="p-2 align-top">
                    {groupNames ? (
                      <div className="flex flex-wrap gap-1">
                        {groupNames.map((g, i) => (
                          <span
                            key={`${t._id}-g-${i}`}
                            className="px-2 py-0.5 rounded bg-gray-200 text-xs"
                          >
                            {g}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-gray-400">—</span>
                    )}
                  </td>
                  <td className="p-2 align-top">
                    {t.assignee ? nameOf(t.assignee, users) : "—"}
                  </td>
                  <td className="p-2 align-top">
                    <ChecksCell t={t} />
                  </td>
                  <td className="p-2 text-right align-top">
                    <div className="inline-flex gap-2">
                      <Link className="btn-sm" to={`/tasks/${t._id}`}>
                        Open
                      </Link>
                      <button className="btn-sm" onClick={() => openEdit(t)}>
                        Edit
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td className="p-4 text-center text-gray-600" colSpan={10}>
                  No tasks
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create / Edit Task Lightbox (Vehicles-style) */}
      {modalOpen && (
        <div
          className="fixed inset-0 z-[100] bg-black/40 flex items-center justify-center p-4"
          onClick={closeModal}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-3xl p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">
                {editing ? "Edit Task" : "Create Task"}
              </h3>
              <button className="text-sm underline" onClick={closeModal}>
                Close
              </button>
            </div>

            {/* Quick presets (optional) */}
            {quickPresets.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-sm text-gray-600">Quick add:</span>
                {quickPresets.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    className="px-2 py-1 border rounded"
                    onClick={() => applyPreset(p)}
                    title={[
                      p.priority && `Priority: ${p.priority}`,
                      p.tags && `Tags: ${p.tags}`,
                    ]
                      .filter(Boolean)
                      .join(" • ")}
                  >
                    {p.title}
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={submitModal} className="grid md:grid-cols-7 gap-3">
              <label className="text-sm md:col-span-3">
                Title
                <input
                  className="border p-2 w-full rounded mt-1"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  required
                />
              </label>
              <label className="text-sm">
                Status
                <select
                  className="border p-2 w-full rounded mt-1"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value })}
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Priority
                <select
                  className="border p-2 w-full rounded mt-1"
                  value={form.priority}
                  onChange={(e) =>
                    setForm({ ...form, priority: e.target.value })
                  }
                >
                  {PRIORITIES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>

              {/* Row: Project + Start + Due */}
              <div className="md:col-span-7 grid md:grid-cols-3 gap-3">
                <label className="text-sm">
                  Project
                  <select
                    className="border p-2 w-full rounded mt-1"
                    value={form.projectId}
                    onChange={(e) =>
                      setForm({ ...form, projectId: e.target.value })
                    }
                  >
                    <option value="">— none —</option>
                    {projects.map((p) => (
                      <option key={p._id} value={p._id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Start
                  <input
                    type="date"
                    className="border p-2 w-full rounded mt-1"
                    value={form.startDate || ""}
                    onChange={(e) =>
                      setForm({ ...form, startDate: e.target.value })
                    }
                  />
                </label>
                <label className="text-sm">
                  Due
                  <input
                    className="border p-2 w-full rounded mt-1"
                    type="date"
                    value={form.dueAt || ""}
                    onChange={(e) =>
                      setForm({ ...form, dueAt: e.target.value })
                    }
                  />
                </label>
              </div>

              <label className="text-sm">
                Assignee
                <select
                  className="border p-2 w-full rounded mt-1"
                  value={form.assignee}
                  onChange={(e) =>
                    setForm({ ...form, assignee: e.target.value })
                  }
                >
                  <option value="">— none —</option>
                  {users.map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.name || u.email || u.username}
                    </option>
                  ))}
                </select>
              </label>

              {/* Est (hrs) — converted to minutes in payload */}
              <label className="text-sm">
                Est. (hrs)
                <input
                  className="border p-2 w-full rounded mt-1"
                  type="number"
                  min="0"
                  step="0.25"
                  placeholder="e.g. 1.5"
                  value={form.estimatedHours}
                  onChange={(e) =>
                    setForm({ ...form, estimatedHours: e.target.value })
                  }
                />
              </label>

              <label className="text-sm md:col-span-7">
                Tags (comma)
                <input
                  className="border p-2 w-full rounded mt-1"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder="safety, routine"
                />
              </label>
              <label className="text-sm md:col-span-7">
                Description
                <textarea
                  className="border p-2 w-full rounded mt-1"
                  rows={3}
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                />
              </label>

              {/* Enforcement toggles */}
              <div className="md:col-span-7 flex flex-wrap items-center gap-10 border-t pt-3">
                <label className="text-sm flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.enforceLocationCheck}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        enforceLocationCheck: e.target.checked,
                      })
                    }
                  />
                  Enforce location check (on start/resume)
                </label>
                <label className="text-sm flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={form.enforceQRScan}
                    onChange={(e) =>
                      setForm({ ...form, enforceQRScan: e.target.checked })
                    }
                  />
                  Require QR before start
                </label>
              </div>

              {/* Geofence-at-create (optional) */}
              {!editing && (
                <div className="md:col-span-7 grid md:grid-cols-4 gap-2">
                  <label className="text-sm md:col-span-2">
                    Geofence file (.geojson / .kml / .kmz)
                    <input
                      className="border p-2 w-full rounded mt-1"
                      type="file"
                      accept=".geojson,.json,.kml,.kmz,application/json,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/zip"
                      onChange={(e) => setGfFile(e.target.files?.[0] || null)}
                    />
                  </label>
                  <label className="text-sm">
                    Point radius (m)
                    <input
                      className="border p-2 w-full rounded mt-1"
                      type="number"
                      min="1"
                      step="1"
                      value={gfRadius}
                      onChange={(e) => setGfRadius(e.target.value)}
                      title="Used to buffer Point features into circles"
                    />
                  </label>
                  <div className="text-xs text-gray-600 self-end">
                    If provided, the geofence is uploaded right after the task
                    is created.
                  </div>
                </div>
              )}

              <div className="md:col-span-7 flex justify-end gap-2">
                <button type="button" className="btn" onClick={closeModal}>
                  Cancel
                </button>
                <button className="btn" type="submit">
                  {editing ? "Update" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
