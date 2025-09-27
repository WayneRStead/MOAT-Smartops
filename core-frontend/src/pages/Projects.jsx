// src/pages/Projects.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";

function TagPill({ t }) {
  return <span className="text-xs px-2 py-1 rounded bg-gray-200 mr-1">{t}</span>;
}

/** Palette & helpers (same vibe as ProjectDetail task palette) */
const MAP_PALETTE = [
  "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728",
  "#9467bd", "#8c564b", "#e377c2", "#7f7f7f",
  "#bcbd22", "#17becf", "#ef4444", "#10b981",
];
const normalizeHex = (c) => {
  if (!c) return "";
  const m = String(c).trim();
  return /^#?[0-9a-f]{6}$/i.test(m) ? (m.startsWith("#") ? m : `#${m}`) : "";
};
const hexToRgba = (hex, a = 0.2) => {
  const h = normalizeHex(hex).slice(1);
  if (h.length !== 6) return `rgba(0,0,0,${a})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
};
const asId = (maybe) =>
  typeof maybe === "string" || typeof maybe === "number"
    ? String(maybe)
    : (maybe && (maybe._id || maybe.id || maybe.userId || maybe.value))
    ? String(maybe._id || maybe.id || maybe.userId || maybe.value)
    : "";

/** Lazy wrapper for the existing map component */
function SafeGeoFencePreview(props) {
  const [Loaded, setLoaded] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let mnt = true;
    import("../components/GeoFencePreview")
      .then((m) => mnt && setLoaded(() => m.default))
      .catch(() => mnt && setErr("Map preview unavailable (Leaflet not installed)."));
    return () => { mnt = false; };
  }, []);
  if (err) {
    return (
      <div
        className="flex items-center justify-center rounded text-sm text-gray-600"
        style={{ height: props.height || 360 }}
      >
        {err}
      </div>
    );
  }
  if (!Loaded) {
    return (
      <div
        className="flex items-center justify-center bg-gray-100 rounded text-sm text-gray-600"
        style={{ height: props.height || 360 }}
      >
        Loading map…
      </div>
    );
  }
  const C = Loaded;
  return <C {...props} />;
}

/** Normalizers (compatible with your ProjectDetail) */
function normPolygon(raw) {
  if (!Array.isArray(raw)) return null;
  const out = raw.map((p) => (Array.isArray(p) ? p : [Number(p.lng), Number(p.lat)]));
  return out.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite)) ? out : null;
}
function normLine(raw) {
  if (!Array.isArray(raw)) return null;
  const out = raw.map((p) => (Array.isArray(p) ? p : [Number(p.lng), Number(p.lat)]));
  return out.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite)) ? out : null;
}
function normCircle(raw) {
  const c = raw.center || raw.point || {};
  const lat = Number(c.lat ?? c[1]);
  const lng = Number(c.lng ?? c[0]);
  const r = Number(raw.radius ?? raw.radiusMeters ?? raw.r);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(r)) return null;
  return { center: { lat, lng }, radius: r };
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

  // Optional: we’ll use users just to show hover labels with manager name if resolvable
  const [users, setUsers] = useState([]);

  // NEW: simple toggle to show always-on name labels on the map
  const [showNames, setShowNames] = useState(false);

  // --- Create / Edit form (unchanged logic) ---
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
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [includeDeleted]);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get("/users", { params: { limit: 500 } });
        setUsers(Array.isArray(data) ? data : []);
      } catch {
        setUsers([]);
      }
    })();
  }, []);

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
        tags: (form.tags || "").split(",").map((s) => s.trim()).filter(Boolean),
      };
      if (!payload.name) return setErr("Project name is required");
      const { data } = await api.post("/projects", payload);
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
        tags: (form.tags || "").split(",").map((s) => s.trim()).filter(Boolean),
      };
      const { data } = await api.put(`/projects/${editing._id}`, payload);
      setRows((prev) => prev.map((r) => (r._id === editing._id ? data : r)));
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
      setRows((prev) => prev.map((r) => (r._id === id ? data : r)));
      setInfo("Project restored.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function updateProjectStatus(id, newStatus) {
    try {
      const { data } = await api.patch(`/projects/${id}/status`, { status: newStatus });
      setRows((prev) => prev.map((r) => (r._id === id ? data : r)));
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  const activeTags = useMemo(() => {
    const set = new Set();
    rows.forEach((r) => (r.tags || []).forEach((t) => set.add(t)));
    return Array.from(set);
  }, [rows]);

  /** ---------------------------------------------
   *  MAP: show all projects' fences (per-project color)
   *  --------------------------------------------- */
  const [projGfById, setProjGfById] = useState({});
  const [projGfLoading, setProjGfLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function fetchAll() {
      const ids = rows.map((r) => String(r._id)).filter(Boolean);
      if (!ids.length) { setProjGfById({}); return; }
      setProjGfLoading(true);
      try {
        const next = {};
        const chunk = 5;
        for (let i = 0; i < ids.length; i += chunk) {
          const slice = ids.slice(i, i + chunk);
          const res = await Promise.all(
            slice.map(async (pid) => {
              try {
                const { data } = await api.get(`/projects/${pid}/geofences`, {
                  headers: { "cache-control": "no-cache" },
                });
                const list =
                  (Array.isArray(data?.geoFences) && data.geoFences) ||
                  (Array.isArray(data?.fences) && data.fences) ||
                  (Array.isArray(data) && data) ||
                  [];
                return { projectId: pid, fences: list };
              } catch {
                return { projectId: pid, fences: [] };
              }
            })
          );
          for (const r of res) next[r.projectId] = r.fences;
          if (cancelled) return;
        }
        if (!cancelled) setProjGfById(next);
      } finally {
        if (!cancelled) setProjGfLoading(false);
      }
    }
    fetchAll();
    return () => { cancelled = true; };
  }, [rows]);

  // Color per project (explicit color -> palette fallback)
  const projectColourMap = useMemo(() => {
    const map = new Map();
    (rows || []).forEach((p, i) => {
      const explicit = normalizeHex(p.color || p.colour || p.hex);
      const fallback = MAP_PALETTE[i % MAP_PALETTE.length];
      map.set(String(p._id), explicit || fallback);
    });
    return map;
  }, [rows]);

  // Build overlays for ALL listed projects (polygons / polylines / circles / points)
  const overlays = useMemo(() => {
    const out = [];
    for (const p of rows || []) {
      const pid = String(p._id);
      const color = projectColourMap.get(pid);
      const fences = projGfById[pid] || [];
      for (const raw of fences) {
        const type = String(raw?.type || raw?.kind || raw?.geometry?.type || "").toLowerCase();

        // polygon
        if (type === "polygon" || raw?.polygon || raw?.geometry?.type === "Polygon") {
          const poly =
            normPolygon(raw?.polygon) ||
            (Array.isArray(raw?.geometry?.coordinates) &&
              Array.isArray(raw.geometry.coordinates[0]) &&
              normPolygon(raw.geometry.coordinates[0])) ||
            null;
          if (poly) {
            out.push({
              id: `${pid}-poly-${out.length}`,
              type: "polygon",
              polygon: poly,
              meta: { label: p.name || "Project", projectId: pid, color },
              style: { stroke: color, strokeWidth: 2, fill: hexToRgba(color, 0.2) },
            });
            continue;
          }
        }

        // polyline
        if (type === "polyline" || type === "line" || Array.isArray(raw?.line) || Array.isArray(raw?.path)) {
          const line = normLine(raw.line || raw.path);
          if (line) {
            out.push({
              id: `${pid}-line-${out.length}`,
              type: "polyline",
              line,
              meta: { label: p.name || "Project", projectId: pid, color },
              style: { stroke: color, strokeWidth: 3 },
            });
            continue;
          }
        }

        // circle
        if (type === "circle" || raw?.radius || raw?.radiusMeters) {
          const c = normCircle(raw);
          if (c) {
            out.push({
              id: `${pid}-circle-${out.length}`,
              type: "circle",
              center: c.center,
              radius: c.radius,
              meta: { label: p.name || "Project", projectId: pid, color },
              style: { stroke: color, strokeWidth: 2, fill: hexToRgba(color, 0.2) },
            });
            continue;
          }
        }

        // point
        if (type === "point" || raw?.geometry?.type === "Point") {
          const coords = Array.isArray(raw?.coordinates)
            ? raw.coordinates
            : Array.isArray(raw?.geometry?.coordinates)
            ? raw.geometry.coordinates
            : null;
          if (Array.isArray(coords) && coords.length >= 2 && coords.every(Number.isFinite)) {
            out.push({
              id: `${pid}-pt-${out.length}`,
              type: "Point",
              coordinates: coords,
              meta: { label: p.name || "Project", projectId: pid, color },
              style: { stroke: color, fill: color, strokeWidth: 2 },
            });
          }
        }
      }
    }
    return out;
  }, [rows, projGfById, projectColourMap]);

  // Legend: only projects that currently have at least one drawn element
  const legendItems = useMemo(() => {
    const drawn = new Set(overlays.map((o) => o.meta?.projectId).filter(Boolean));
    return (rows || [])
      .filter((p) => drawn.has(String(p._id)))
      .map((p) => ({
        id: String(p._id),
        title: p.name || "Project",
        color: projectColourMap.get(String(p._id)),
      }));
  }, [rows, overlays, projectColourMap]);

  // Hover meta (optional; some GeoFencePreview builds can use this)
  function hoverMetaResolver(feature) {
    const pid = String(feature?.meta?.projectId || "");
    const proj = (rows || []).find((r) => String(r._id) === pid);
    if (!proj) return null;
    const mId = asId(proj.manager);
    const mgr =
      (users.find((u) => String(u._id) === mId)?.name) ||
      (users.find((u) => String(u._id) === mId)?.email) ||
      mId ||
      "";
    return {
      projectName: proj.name || "Project",
      managerName: mgr,
      color: projectColourMap.get(pid),
    };
  }
  // Fallback for map colors if your GeoFencePreview reads style/meta.color
  const overlayStyleResolver = (o) => o?.style || { color: o?.meta?.color, fillColor: o?.meta?.color };

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
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          style={{ minWidth: 280 }}
        />
        <select className="border p-2" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Status (any)</option>
          <option value="active">active</option>
          <option value="paused">paused</option>
          <option value="closed">closed</option>
        </select>
        <select className="border p-2" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">Tag (any)</option>
          {activeTags.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={includeDeleted}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />
          Include deleted
        </label>
        <button className="px-3 py-2 border rounded" onClick={load}>Apply</button>
      </div>

      {/* Create / Edit */}
      <form onSubmit={editing ? update : create} className="grid md:grid-cols-3 gap-3 border rounded p-3 mb-4">
        <label className="text-sm">Name
          <input className="border p-2 w-full" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label className="text-sm">Status
          <select className="border p-2 w-full" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="closed">closed</option>
          </select>
        </label>
        <label className="text-sm">Tags (comma)
          <input className="border p-2 w-full" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="site-a, osha" />
        </label>

        <label className="text-sm md:col-span-3">Description
          <textarea className="border p-2 w-full" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>

        <label className="text-sm">Start
          <input className="border p-2 w-full" type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
        </label>
        <label className="text-sm">End
          <input className="border p-2 w-full" type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
        </label>

        <div className="md:col-span-3 text-xs text-gray-600 border-t pt-3">
          After creating a project, you'll be taken to its detail page to set the location/fences.
        </div>

        <div className="flex items-center gap-2 md:col-span-3">
          <button className="px-3 py-2 bg-black text-white rounded">{editing ? "Update" : "Create"}</button>
          {editing && (
            <button type="button" className="px-3 py-2 border rounded" onClick={resetForm}>
              Cancel
            </button>
          )}
        </div>
      </form>

      {/* ORG MAP */}
      <div className="border rounded p-3 mb-4">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Organization Map</div>
          <div className="flex items-center gap-4 text-sm">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={showNames}
                onChange={(e) => setShowNames(e.target.checked)}
              />
              Show names
              <span className="text-gray-500 text-xs">(labels on map)</span>
            </label>
            {projGfLoading && <div className="text-xs text-gray-700">Loading project areas…</div>}
          </div>
        </div>

        {/* Legend */}
        {legendItems.length > 0 && (
          <div className="sticky top-2 z-10 mt-2 max-h-28 overflow-auto rounded border bg-white/90 backdrop-blur px-3 py-2 text-xs shadow-sm">
            <div className="font-medium mb-1">Project Legend</div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1">
              {legendItems.map((it) => (
                <div key={it.id} className="inline-flex items-center gap-2">
                  <svg width="14" height="14" aria-hidden focusable="false">
                    <rect width="14" height="14" rx="2" ry="2" fill={it.color || "#999"} />
                  </svg>
                  <span className="truncate" title={it.title}>{it.title}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <SafeGeoFencePreview
          // no single projectId; we render via extraFences
          height={360}
          className="rounded"
          // Make sure map refreshes appropriately when data changes
          reloadKey={`${rows.length}:${Object.keys(projGfById).length}:${overlays.length}:${showNames}`}
          // We rely on extraFences to draw everything with per-feature color
          extraFences={overlays}
          // These two are used by the enhanced GeoFencePreview builds in your repo
          overlayStyleResolver={(o) => overlayStyleResolver(o)}
          hoverMetaResolver={(o) => hoverMetaResolver(o)}
          // keep the built-in hover labels enabled (uses meta.label)
          enableHoverLabels={true}
          // NEW: always-on label support (from your updated GeoFencePreview.jsx)
          labelMode={showNames ? "always" : "hover"}
          labelMinZoom={8}              // tweak if you want labels only when zoomed in enough
          labelClassName="gf-label"
          // no picking on org overview
          allowPicking={false}
          legend={false}
        />
      </div>

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
          {rows.map((p) => (
            <tr key={p._id} className={p.deletedAt ? "opacity-60" : ""}>
              <td className="border p-2">
                <Link to={`/projects/${p._id}`} className="underline">{p.name}</Link>
                {p.description && <div className="text-xs text-gray-600">{p.description}</div>}
                {p.deletedAt && (
                  <div className="text-xs text-red-700">
                    deleted {new Date(p.deletedAt).toLocaleString()}
                  </div>
                )}
              </td>
              <td className="border p-2">
                <select
                  className="border p-1"
                  value={p.status}
                  onChange={(e) => updateProjectStatus(p._id, e.target.value)}
                  disabled={!!p.deletedAt}
                >
                  <option value="active">active</option>
                  <option value="paused">paused</option>
                  <option value="closed">closed</option>
                </select>
              </td>
              <td className="border p-2">
                {(p.tags || []).length
                  ? (p.tags || []).map((t) => <TagPill key={t} t={t} />)
                  : <span className="text-gray-500">—</span>}
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
                    <button className="px-2 py-1 border rounded mr-2" onClick={() => startEdit(p)}>
                      Edit
                    </button>
                    <button className="px-2 py-1 border rounded" onClick={() => softDelete(p._id)}>
                      Delete
                    </button>
                  </>
                ) : (
                  <button className="px-2 py-1 border rounded" onClick={() => restore(p._id)}>
                    Restore
                  </button>
                )}
              </td>
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td className="p-4 text-center" colSpan={5}>
                No projects
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
