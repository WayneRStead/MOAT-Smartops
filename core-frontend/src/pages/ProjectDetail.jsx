// src/pages/ProjectDetail.jsx
// Project detail with task pins and task-area overlays rendered on top of project fences.
// Works with your imperative Leaflet-based GeoFencePreview.jsx (the one you pasted).

import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { api } from "../lib/api";
import { listProjectTasks } from "../lib/api";

// Lazy loader that won’t break hooks if Leaflet is missing
function SafeGeoFencePreview({
  projectId,
  height = 360,
  className = "",
  reloadKey,
  fallbackCircle = null,
  allowPicking = false,
  onPickLocation,
  extraFences = [], // overlays: task pins + task areas (polygon/polyline/circle/point)
}) {
  const [Loaded, setLoaded] = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    let mounted = true;
    import("../components/GeoFencePreview")
      .then((m) => {
        if (!mounted) return;
        setLoaded(() => m.default);
      })
      .catch(() => {
        if (!mounted) return;
        setErr("Map preview unavailable (Leaflet not installed).");
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (err) {
    return (
      <div className="flex items-center justify-center rounded text-sm text-gray-600" style={{ height }}>
        {err}
      </div>
    );
  }
  if (!Loaded) {
    return (
      <div className="flex items-center justify-center bg-gray-100 rounded text-sm text-gray-600" style={{ height }}>
        Loading map…
      </div>
    );
  }
  return (
    <Loaded
      projectId={projectId}
      height={height}
      className={className}
      reloadKey={reloadKey}
      fallbackCircle={fallbackCircle}
      allowPicking={allowPicking}
      onPickLocation={onPickLocation}
      // Your imperative component accepts extraFences with polygon/line/circle/point
      extraFences={extraFences}
      // Keep the legend off here; Project view shows both sets
      legend={false}
    />
  );
}

function TagEditor({ value = [], onChange }) {
  const [text, setText] = useState((value || []).join(", "));
  useEffect(() => setText((value || []).join(", ")), [value]);
  return (
    <input
      className="border p-2 w-full"
      placeholder="site-a, osha"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const tags = e.target.value
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        onChange?.(tags);
      }}
    />
  );
}

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  // --- Top-level state ---
  const [p, setP] = useState(null);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  const [users, setUsers] = useState([]);
  const [projectTasks, setProjectTasks] = useState([]);

  const [docs, setDocs] = useState([]);
  const [docQuery, setDocQuery] = useState("");
  const [docPick, setDocPick] = useState("");

  const [inspections, setInspections] = useState([]);
  const [inspErr, setInspErr] = useState("");
  const [inspInfo, setInspInfo] = useState("");
  const [inspForm, setInspForm] = useState({
    title: "",
    status: "planned",
    scheduledAt: "",
    assignee: "",
  });

  // Proof (Vault)
  const [proofUser, setProofUser] = useState("");
  const [proofTitle, setProofTitle] = useState("");
  const [proofTags, setProofTags] = useState("");
  const [proofFile, setProofFile] = useState(null);
  const [proofErr, setProofErr] = useState("");
  const [proofInfo, setProofInfo] = useState("");

  // Single-circle “project location” helpers
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [radius, setRadius] = useState("");

  // Geofence file & summary
  const [gfFile, setGfFile] = useState(null);
  const [gfBuffer, setGfBuffer] = useState(50);
  const [gfCount, setGfCount] = useState(0);
  const [gfSource, setGfSource] = useState("none");

  // Replace vs Append (default: replace)
  const [replaceFences, setReplaceFences] = useState(true);

  // Overlay toggles
  const [showTaskPins, setShowTaskPins] = useState(true);
  const [showTaskAreas, setShowTaskAreas] = useState(true);

  // Map of taskId -> array of geofences from /tasks/:id/geofences
  const [taskGfByTask, setTaskGfByTask] = useState({});
  const [taskGfLoading, setTaskGfLoading] = useState(false);

  // --- Data loading ---
  useEffect(() => {
    loadProject();
    loadUsers();
    loadDocs();
    loadInspections();
    loadProjectTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function loadProject() {
    setErr("");
    setInfo("");
    try {
      const { data } = await api.get(`/projects/${id}`);
      setP(data);
      await refreshFenceSummary(true); // prefill Lat/Lng/Radius if a saved circle exists
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function loadUsers() {
    try {
      const { data } = await api.get("/users", { params: { limit: 500 } });
      setUsers(Array.isArray(data) ? data : []);
    } catch {
      setUsers([]);
    }
  }
  async function loadDocs(q = "") {
    try {
      const params = { limit: 50 };
      if (q) params.q = q;
      const { data } = await api.get("/documents", { params });
      setDocs(Array.isArray(data) ? data : []);
    } catch {
      setDocs([]);
    }
  }
  async function loadInspections() {
    try {
      const { data } = await api.get("/inspections", {
        params: { projectId: id, limit: 200 },
      });
      setInspections(Array.isArray(data) ? data : []);
      setInspErr("");
    } catch (e) {
      setInspErr(e?.response?.data?.error || "Failed to load inspections");
    }
  }
  async function loadProjectTasks() {
    try {
      const rows = await listProjectTasks(id, { limit: 1000 });
      setProjectTasks(Array.isArray(rows) ? rows : []);
    } catch {
      setProjectTasks([]);
    }
  }

  // --- Fetch each task's geofences when tasks change / toggled on ---
  useEffect(() => {
    if (!showTaskAreas || !(projectTasks && projectTasks.length)) {
      setTaskGfByTask({});
      return;
    }

    let cancelled = false;
    async function fetchAll() {
      setTaskGfLoading(true);
      try {
        const ids = projectTasks.map((t) => String(t._id)).filter(Boolean);
        const chunkSize = 5;
        const nextMap = {};

        for (let i = 0; i < ids.length; i += chunkSize) {
          const slice = ids.slice(i, i + chunkSize);
          const results = await Promise.all(
            slice.map(async (taskId) => {
              try {
                const { data } = await api.get(`/tasks/${taskId}/geofences`, {
                  headers: { "cache-control": "no-cache" },
                });
                const list =
                  (Array.isArray(data?.geoFences) && data.geoFences) ||
                  (Array.isArray(data?.fences) && data.fences) ||
                  (Array.isArray(data) && data) ||
                  [];
                return { taskId, fences: list };
              } catch {
                return { taskId, fences: [] };
              }
            })
          );
          for (const r of results) nextMap[r.taskId] = r.fences;
          if (cancelled) return;
        }

        if (!cancelled) setTaskGfByTask(nextMap);
      } finally {
        if (!cancelled) setTaskGfLoading(false);
      }
    }

    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [projectTasks, showTaskAreas]);

  // --- Generic save helpers ---
  async function save(patch) {
    try {
      const { data } = await api.put(`/projects/${id}`, patch);
      setP(data);
      setInfo("Saved");
      setTimeout(() => setInfo(""), 1200);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function setStatus(newStatus) {
    try {
      const { data } = await api.patch(`/projects/${id}/status`, {
        status: newStatus,
      });
      setP(data);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function softDelete() {
    if (!confirm("Delete this project?")) return;
    try {
      await api.delete(`/projects/${id}`);
      await loadProject();
      setInfo("Project deleted.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function restore() {
    try {
      const { data } = await api.patch(`/projects/${id}/restore`);
      setP(data);
      setInfo("Project restored.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  // --- Vault links ---
  async function linkDoc() {
    if (!docPick) return;
    try {
      await api.post(`/documents/${docPick}/links`, {
        type: "project",
        refId: id,
      });
      setInfo("Linked document.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function unlinkDoc(docId) {
    try {
      await api.delete(`/documents/${docId}/links`, {
        data: { type: "project", refId: id },
      });
      setInfo("Unlinked document.");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  const linkedDocs = useMemo(() => {
    const ref = String(id);
    return (docs || []).filter((d) =>
      (d.links || []).some(
        (l) => (l.type || l.module) === "project" && String(l.refId) === ref
      )
    );
  }, [docs, id]);

  // --- Inspections ---
  async function createInspection(e) {
    e.preventDefault();
    setInspErr("");
    setInspInfo("");
    try {
      const payload = {
        title: (inspForm.title || "").trim(),
        status: inspForm.status || "planned",
        projectId: id,
        scheduledAt: inspForm.scheduledAt || undefined,
        assignee: inspForm.assignee || undefined,
      };
      if (!payload.title) return setInspErr("Title is required");
      const { data } = await api.post("/inspections", payload);
      setInspections((prev) => [data, ...prev]);
      setInspForm({
        title: "",
        status: "planned",
        scheduledAt: "",
        assignee: "",
      });
      setInspInfo("Inspection created.");
    } catch (e) {
      setInspErr(e?.response?.data?.error || String(e));
    }
  }
  async function updateInspectionStatus(inspId, status) {
    try {
      const { data } = await api.put(`/inspections/${inspId}`, { status });
      setInspections((prev) => prev.map((i) => (i._id === inspId ? data : i)));
    } catch (e) {
      setInspErr(e?.response?.data?.error || String(e));
    }
  }
  async function deleteInspection(inspId) {
    if (!confirm("Delete this inspection?")) return;
    try {
      await api.delete(`/inspections/${inspId}`);
      await loadInspections();
      setInspInfo("Inspection deleted.");
    } catch (e) {
      setInspErr(e?.response?.data?.error || String(e));
    }
  }
  async function restoreInspection(inspId) {
    try {
      const { data } = await api.patch(`/inspections/${inspId}/restore`);
      setInspections((prev) => prev.map((i) => (i._id === inspId ? data : i)));
      setInspInfo("Inspection restored.");
    } catch (e) {
      setInspErr(e?.response?.data?.error || String(e));
    }
  }

  // --- Geofencing / Location ---
  // circle -> polygon ring ([ [lng,lat], ... ])
  function makeCirclePolygon(lati, lngi, radiusMeters, steps = 64) {
    const R = 6371000;
    const lat1 = (lati * Math.PI) / 180;
    const lon1 = (lngi * Math.PI) / 180;
    const d = radiusMeters / R;

    const ring = [];
    for (let i = 0; i <= steps; i++) {
      const brng = (2 * Math.PI * i) / steps;
      const sinLat1 = Math.sin(lat1);
      const cosLat1 = Math.cos(lat1);
      const sinD = Math.sin(d);
      const cosD = Math.cos(d);

      const sinLat2 = sinLat1 * cosD + cosLat1 * sinD * Math.cos(brng);
      const lat2 = Math.asin(sinLat2);

      const y = Math.sin(brng) * sinD * cosLat1;
      const x = cosD - sinLat1 * sinLat2;
      const lon2 = lon1 + Math.atan2(y, x);

      const outLat = (lat2 * 180) / Math.PI;
      const outLng = ((lon2 * 180) / Math.PI + 540) % 360 - 180;
      ring.push([outLng, outLat]); // server expects [lng,lat]
    }
    return ring;
  }

  // Read existing fences + optional prefill from circle
  async function refreshFenceSummary(prefill = false) {
    try {
      const { data } = await api.get(`/projects/${id}/geofences`, {
        headers: { "cache-control": "no-cache" },
      });
      const fences = Array.isArray(data?.geoFences)
        ? data.geoFences
        : Array.isArray(data?.fences)
        ? data.fences
        : Array.isArray(data)
        ? data
        : [];
      setGfCount(fences.length);
      setGfSource(fences.length ? "project" : "none");

      if (prefill) {
        const circle = fences.find(
          (f) => String(f?.type).toLowerCase() === "circle"
        );
        if (circle) {
          let L2, G2, R2;
          if (circle.center && typeof circle.center === "object") {
            if (Array.isArray(circle.center)) {
              G2 = Number(circle.center[0]);
              L2 = Number(circle.center[1]);
            } else {
              L2 = Number(circle.center.lat);
              G2 = Number(circle.center.lng);
            }
          }
          if ((L2 === undefined || G2 === undefined) && circle.point) {
            G2 = Number(circle.point.lng);
            L2 = Number(circle.point.lat);
          }
          R2 = Number(circle.radius ?? circle.radiusMeters);
          if (Number.isFinite(L2)) setLat(String(L2));
          if (Number.isFinite(G2)) setLng(String(G2));
          if (Number.isFinite(R2)) setRadius(String(R2));
        }
      }
    } catch {
      setGfCount(0);
      setGfSource("none");
    }
  }

  function circleFromInputs() {
    if (lat === "" || lng === "") return null;
    const L2 = Number(lat);
    const G2 = Number(lng);
    const R2 = radius === "" ? 50 : Number(radius);
    if (!Number.isFinite(L2) || !Number.isFinite(G2) || !Number.isFinite(R2))
      return null;
    return { lat: L2, lng: G2, radius: R2 };
  }

  // Persist as polygon (matches upload route)
  async function persistCircleAsPolygon(projectId, { lat, lng, radius }) {
    const polygon = makeCirclePolygon(lat, lng, radius, 64);
    const body = { geoFences: [{ type: "polygon", polygon }] };

    if (replaceFences) {
      try {
        await api.delete(`/projects/${projectId}/geofences`);
      } catch {}
    }

    const attempts = [
      { m: "patch", u: `/projects/${projectId}/geofences`, b: body },
      { m: "post", u: `/projects/${projectId}/geofences`, b: body },
      { m: "put", u: `/projects/${projectId}/geofences`, b: body },
    ];

    let lastErr;
    for (const a of attempts) {
      try {
        await api[a.m](a.u, a.b, { headers: { "Content-Type": "application/json" } });
        return { ok: true };
      } catch (e) {
        lastErr = e;
      }
    }

    try { await api.delete(`/projects/${projectId}/geofences`); } catch {}
    try {
      await api.post(`/projects/${projectId}/geofences`, body, {
        headers: { "Content-Type": "application/json" },
      });
      return { ok: true };
    } catch (e2) {
      return { ok: false, error: lastErr || e2 };
    }
  }

  async function handleSaveLocation(e) {
    e?.preventDefault?.();
    setErr("");
    setInfo("");

    const c = circleFromInputs();
    if (!c) {
      setErr("Please enter valid Lat, Lng and Radius.");
      return;
    }

    const { ok, error } = await persistCircleAsPolygon(id, c);
    if (!ok) {
      setErr(error?.response?.data?.error || String(error) || "Failed to save location.");
      return;
    }

    await refreshFenceSummary(true);
    setInfo("Location saved.");
    setTimeout(() => setInfo(""), 1200);
  }

  // Upload / Clear
  async function uploadGeofenceFile(e) {
    e?.preventDefault?.();
    setErr("");
    setInfo("");
    if (!gfFile) return setErr("Choose a .geojson, .kml or .kmz file first.");
    try {
      if (replaceFences) {
        try {
          await api.delete(`/projects/${id}/geofences`);
        } catch {}
      }

      const fd = new FormData();
      fd.append("file", gfFile);

      const qs = [
        `radius=${encodeURIComponent(Number(gfBuffer) || 50)}`,
        `buffer=${encodeURIComponent(Number(gfBuffer) || 50)}`,
        `radiusMeters=${encodeURIComponent(Number(gfBuffer) || 50)}`,
      ];

      let lastErr;
      for (const q of qs) {
        try {
          await api.post(`/projects/${id}/geofences/upload?${q}`, fd);
          setGfFile(null);
          await refreshFenceSummary(true);
          setInfo(replaceFences ? "Fences replaced with uploaded file." : "Fences uploaded (appended).");
          setTimeout(() => setInfo(""), 1200);
          return;
        } catch (eTry) {
          lastErr = eTry;
        }
      }
      throw lastErr || new Error("Upload failed");
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function clearAllFences() {
    if (!window.confirm("Remove ALL geofences from this project?")) return;
    setErr("");
    setInfo("");
    try {
      await api.delete(`/projects/${id}/geofences`);
      await refreshFenceSummary(true);
      setInfo("Project geofences cleared.");
      setTimeout(() => setInfo(""), 1200);
    } catch (e2) {
      setErr(e2?.response?.data?.error || String(e2));
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      setErr("Geolocation not supported by this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(6));
        setLng(pos.coords.longitude.toFixed(6));
        if (!radius) setRadius("50");
      },
      (ge) => setErr(ge?.message || "Failed to get current position"),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
    );
  }

  // --- Proof (Vault) ---
  async function attachProof(e) {
    e.preventDefault();
    setProofErr("");
    setProofInfo("");

    if (!proofUser) {
      setProofErr("Pick a user.");
      return;
    }
    if (!proofFile) {
      setProofErr("Choose a file.");
      return;
    }

    try {
      const title = (proofTitle || proofFile.name || "Proof").trim();
      const tags = (proofTags || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const { data: doc } = await api.post("/documents", {
        title,
        folder: `projects/${id}/proof`,
        tags,
        links: [
          { type: "project", refId: id },
          { type: "user", refId: proofUser },
        ],
        access: { visibility: "org" },
      });

      const fd = new FormData();
      fd.append("file", proofFile);
      await api.post(`/documents/${doc._id}/upload`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      setProofInfo("Proof attached via Vault.");
      setProofFile(null);
      setProofTitle("");
      setProofTags("");
      setProofUser("");
      loadDocs();
    } catch (e) {
      setProofErr(e?.response?.data?.error || String(e));
    }
  }

  // --- Task overlays helpers (format to match YOUR GeoFencePreview.jsx) ---
  // Helpers to coerce task geofence shapes into the formats your component renders.
  function normPolygon(rawPolygon) {
    // Expect [[lng,lat], ...]. If objects, coerce.
    if (!Array.isArray(rawPolygon)) return null;
    const out = rawPolygon.map((p) =>
      Array.isArray(p) ? p : [Number(p.lng), Number(p.lat)]
    );
    if (!out.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite)))
      return null;
    return out;
  }
  function normLine(rawLine) {
    if (!Array.isArray(rawLine)) return null;
    const out = rawLine.map((p) =>
      Array.isArray(p) ? p : [Number(p.lng), Number(p.lat)]
    );
    if (!out.every((pt) => Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite)))
      return null;
    return out;
  }
  function normCircle(raw) {
    const c = raw.center || raw.point || {};
    const lat = Number(c.lat ?? c[1]);
    const lng = Number(c.lng ?? c[0]);
    const radius = Number(raw.radius ?? raw.radiusMeters ?? raw.r);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius)) return null;
    return { center: { lat, lng }, radius };
  }

  // Build overlays (pins + areas) for ALL tasks in this project
  const taskOverlays = useMemo(() => {
    const out = [];

    // Pins (task lng/lat)
    if (showTaskPins) {
      for (const t of projectTasks || []) {
        const gf = t.locationGeoFence;
        if (gf && gf.lat != null && gf.lng != null) {
          const lat = Number(gf.lat);
          const lng = Number(gf.lng);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            // Your Leaflet preview accepts GeoJSON-like Point OR {lat,lng}; prefer Point
            out.push({
              id: `${t._id}-pin`,
              type: "Point",
              coordinates: [lng, lat], // [lng,lat]
              title: t.title || "Task",
            });
          }
        }
      }
    }

    // Areas (polygon / polyline / circle) — real data from /tasks/:id/geofences
    if (showTaskAreas) {
      for (const t of projectTasks || []) {
        const fences = taskGfByTask[String(t._id)] || [];
        for (const raw of fences) {
          const type = String(raw?.type || raw?.kind || raw?.geometry?.type || "").toLowerCase();

          // polygon (accept polygon: [[lng,lat]...] or geometry.coordinates)
          if (type === "polygon" || raw?.polygon || raw?.geometry?.type === "Polygon") {
            const poly =
              normPolygon(raw?.polygon) ||
              // GeoJSON polygon: coordinates: [ [ [lng,lat], ... ] ]
              (Array.isArray(raw?.geometry?.coordinates) &&
                Array.isArray(raw.geometry.coordinates[0]) &&
                normPolygon(raw.geometry.coordinates[0])) ||
              null;

            if (poly) {
              out.push({
                id: `${t._id}-poly-${out.length}`,
                type: "polygon",
                polygon: poly, // [[lng,lat]...]
                meta: { label: t.title || "Task", taskId: String(t._id || "") },
              });
              continue;
            }
          }

          // polyline / line (accept line: [[lng,lat]...])
          if (type === "polyline" || type === "line" || Array.isArray(raw?.line) || Array.isArray(raw?.path)) {
            const line = normLine(raw.line || raw.path);
            if (line) {
              out.push({
                id: `${t._id}-line-${out.length}`,
                type: "polyline",
                line,
                meta: { label: t.title || "Task", taskId: String(t._id || "") },
              });
              continue;
            }
          }

          // circle (center+radius)
          if (type === "circle" || raw?.radius || raw?.radiusMeters) {
            const c = normCircle(raw);
            if (c) {
              out.push({
                id: `${t._id}-circle-${out.length}`,
                type: "circle",
                center: c.center, // {lat,lng}
                radius: c.radius,
                meta: { label: t.title || "Task", taskId: String(t._id || "") },
              });
              continue;
            }
          }

          // bare point (if returned as a geofence)
          if (type === "point" || raw?.geometry?.type === "Point") {
            const coords = Array.isArray(raw?.coordinates)
              ? raw.coordinates
              : Array.isArray(raw?.geometry?.coordinates)
              ? raw.geometry.coordinates
              : null;
            if (Array.isArray(coords) && coords.length >= 2 && coords.every(Number.isFinite)) {
              out.push({
                id: `${t._id}-pt-${out.length}`,
                type: "Point",
                coordinates: coords, // [lng,lat]
                meta: { label: t.title || "Task", taskId: String(t._id || "") },
              });
            }
          }
        }
      }
    }

    return out;
  }, [projectTasks, taskGfByTask, showTaskPins, showTaskAreas]);

  // --- Render ---
  if (!p) {
    return (
      <div className="p-4">
        Loading… {err && <span style={{ color: "crimson" }}>({err})</span>}
      </div>
    );
  }

  const fallbackCircle =
    gfCount === 0 && lat !== "" && lng !== ""
      ? (() => {
          const L2 = Number(lat),
            G2 = Number(lng),
            R2 = radius === "" ? 50 : Number(radius);
          if (Number.isFinite(L2) && Number.isFinite(G2) && Number.isFinite(R2)) {
            return { lat: L2, lng: G2, radius: R2 };
          }
          return null;
        })()
      : null;

  const userLabel = (maybe) => {
    if (!maybe) return "—";
    const idStr = String(maybe?._id || maybe);
    const u = users.find((x) => String(x._id) === idStr);
    return u ? u.name || u.email || u.username || idStr : idStr;
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Project</h1>
        <div className="flex gap-2">
          {!p.deletedAt ? (
            <button className="px-3 py-2 border rounded" onClick={softDelete}>
              Delete
            </button>
          ) : (
            <button className="px-3 py-2 border rounded" onClick={restore}>
              Restore
            </button>
          )}
          <button className="px-3 py-2 border rounded" onClick={() => navigate(-1)}>
            Back
          </button>
        </div>
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      <div className="grid md:grid-cols-2 gap-4">
        {/* Meta */}
        <div className="border rounded p-3 space-y-3">
          <label className="block text-sm">
            Name
            <input
              className="border p-2 w-full"
              value={p.name || ""}
              onChange={(e) => setP({ ...p, name: e.target.value })}
              onBlur={() => p.name && save({ name: p.name })}
            />
          </label>

          <label className="block text-sm">
            Status
            <select
              className="border p-2 w-full"
              value={p.status || "active"}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="active">active</option>
              <option value="paused">paused</option>
              <option value="closed">closed</option>
            </select>
          </label>

          <label className="block text-sm">
            Description
            <textarea
              className="border p-2 w-full"
              rows={3}
              value={p.description || ""}
              onChange={(e) => setP({ ...p, description: e.target.value })}
              onBlur={() => save({ description: p.description || "" })}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              Start
              <input
                className="border p-2 w-full"
                type="date"
                value={p.startDate ? p.startDate.slice(0, 10) : ""}
                onChange={(e) =>
                  setP({
                    ...p,
                    startDate: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : "",
                  })
                }
                onBlur={() => save({ startDate: p.startDate || undefined })}
              />
            </label>
            <label className="block text-sm">
              End
              <input
                className="border p-2 w-full"
                type="date"
                value={p.endDate ? p.endDate.slice(0, 10) : ""}
                onChange={(e) =>
                  setP({
                    ...p,
                    endDate: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : "",
                  })
                }
                onBlur={() => save({ endDate: p.endDate || undefined })}
              />
            </label>
          </div>

          <label className="block text-sm">
            Tags
            <TagEditor
              value={p.tags || []}
              onChange={(t) => {
                setP({ ...p, tags: t });
                save({ tags: t });
              }}
            />
          </label>

          <div className="text-sm text-gray-600">
            Created: {p.createdAt ? new Date(p.createdAt).toLocaleString() : "—"}
            <br />
            Updated: {p.updatedAt ? new Date(p.updatedAt).toLocaleString() : "—"}
            {p.deletedAt && (
              <>
                <br />
                <span className="text-red-700">
                  Deleted: {new Date(p.deletedAt).toLocaleString()}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Team + Proof */}
        <div className="border rounded p-3 space-y-3">
          <div className="font-semibold">Team</div>

          <label className="block text-sm">
            Manager
            <select
              className="border p-2 w-full"
              value={p.manager || ""}
              onChange={(e) => {
                const v = e.target.value || "";
                setP({ ...p, manager: v });
                save({ manager: v || undefined });
              }}
            >
              <option value="">— none —</option>
              {users.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.name || u.email || u.username}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            Members
            <select
              className="border p-2 w-full"
              multiple
              value={Array.isArray(p.members) ? p.members.map(String) : []}
              onChange={(e) => {
                const vals = Array.from(e.target.selectedOptions).map(
                  (o) => o.value
                );
                setP({ ...p, members: vals });
                save({ members: vals });
              }}
              size={6}
            >
              {users.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.name || u.email || u.username}
                </option>
              ))}
            </select>
          </label>

          <div className="border rounded p-3 space-y-2">
            <div className="font-medium text-sm">Attach Proof (Vault)</div>
            {proofErr && <div className="text-red-600 text-sm">{proofErr}</div>}
            {proofInfo && (
              <div className="text-green-700 text-sm">{proofInfo}</div>
            )}
            <form onSubmit={attachProof} className="grid md:grid-cols-2 gap-2">
              <label className="text-sm">
                User
                <select
                  className="border p-2 w-full"
                  value={proofUser}
                  onChange={(e) => setProofUser(e.target.value)}
                  required
                >
                  <option value="">— select a user —</option>
                  {users.map((u) => (
                    <option key={u._id} value={u._id}>
                      {u.name || u.email || u.username}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-sm">
                Title
                <input
                  className="border p-2 w-full"
                  placeholder="e.g. Sick note 2025-08-26"
                  value={proofTitle}
                  onChange={(e) => setProofTitle(e.target.value)}
                />
              </label>
              <label className="text-sm md:col-span-2">
                Tags (comma)
                <input
                  className="border p-2 w-full"
                  placeholder="sick, proof"
                  value={proofTags}
                  onChange={(e) => setProofTags(e.target.value)}
                />
              </label>
              <label className="text-sm md:col-span-2">
                File
                <input
                  type="file"
                  className="border p-2 w-full"
                  onChange={(e) => setProofFile(e.target.files?.[0] || null)}
                  required
                />
              </label>
              <div className="md:col-span-2">
                <button className="px-3 py-2 bg-black text-white rounded">
                  Attach
                </button>
              </div>
            </form>
            <div className="text-xs text-gray-600">
              Files are stored in the Vault and auto-linked to this project and
              the selected user.
            </div>
          </div>
        </div>
      </div>

      {/* Location & Geofencing */}
      <div className="border rounded p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Project Location</div>
          <div className="text-sm text-gray-600">
            Fences: <b>{gfCount}</b>{" "}
            <span className="ml-2">
              source: <i>{gfSource}</i>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-sm">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={showTaskPins}
              onChange={(e) => setShowTaskPins(e.target.checked)}
            />
            Show task pins
          </label>
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={showTaskAreas}
              onChange={(e) => setShowTaskAreas(e.target.checked)}
            />
            Show task geofences
          </label>

          <div className="flex items-center gap-4 text-xs text-gray-700">
            <span className="inline-flex items-center gap-2">
              <span
                className="inline-block w-3 h-3 rounded-full bg-blue-500"
                aria-hidden
              ></span>
              Project fences
            </span>
            <span className="inline-flex items-center gap-2">
              <span
                className="inline-block w-3 h-3 rounded-full bg-red-500"
                aria-hidden
              ></span>
              Task overlays
            </span>
            {taskGfLoading && <span>Loading task areas…</span>}
          </div>
        </div>

        {gfCount > 0 && (
          <div className="p-2 rounded bg-amber-50 border text-amber-900 text-sm">
            This project already has <b>{gfCount}</b> fence{gfCount > 1 ? "s" : ""}.<br />
            Changes below will <b>{replaceFences ? "replace" : "append to"}</b> current
            fences.
          </div>
        )}

        <SafeGeoFencePreview
          projectId={id}
          height={360}
          className="rounded"
          reloadKey={`${gfCount}:${showTaskPins}:${showTaskAreas}:${taskOverlays.length}:${Object.keys(taskGfByTask).length}:${p?.updatedAt || ""}`}
          fallbackCircle={fallbackCircle}
          allowPicking={replaceFences || gfCount === 0}
          onPickLocation={({ lat: pickedLat, lng: pickedLng }) => {
            setLat(pickedLat.toFixed(6));
            setLng(pickedLng.toFixed(6));
            if (!radius) setRadius("50");
            setInfo(
              `Pin set at ${pickedLat.toFixed(6)}, ${pickedLng.toFixed(
                6
              )} — click “Save location” to persist.`
            );
            setTimeout(() => setInfo(""), 2000);
          }}
          extraFences={taskOverlays}
        />

        <div className="flex items-center gap-3 text-sm">
          <label className="inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={replaceFences}
              onChange={(e) => setReplaceFences(e.target.checked)}
            />
            Replace existing fences (recommended)
          </label>
          <span className="text-gray-500">
            {replaceFences
              ? "We'll clear existing fences before saving/uploading."
              : "We'll add to existing fences."}
          </span>
        </div>

        <form onSubmit={handleSaveLocation} className="grid md:grid-cols-5 gap-2">
          <label className="text-sm">
            Lat
            <input
              className="border p-2 w-full"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              placeholder="-33.123456"
            />
          </label>
          <label className="text-sm">
            Lng
            <input
              className="border p-2 w-full"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              placeholder="18.654321"
            />
          </label>
          <label className="text-sm">
            Radius (m)
            <input
              className="border p-2 w-full"
              type="number"
              min="5"
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              placeholder="50"
            />
          </label>
          <div className="flex items-end gap-2 md:col-span-2">
            <button
              type="button"
              className="px-3 py-2 border rounded"
              onClick={useMyLocation}
            >
              Use my location
            </button>
            <a
              className="px-3 py-2 border rounded"
              href={lat && lng ? `https://www.google.com/maps?q=${lat},${lng}` : undefined}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                if (!(lat && lng)) e.preventDefault();
              }}
            >
              Open in Maps
            </a>
            <button className="px-3 py-2 bg-black text-white rounded ml-auto" type="submit">
              Save location
            </button>
          </div>
        </form>

        <form onSubmit={uploadGeofenceFile} className="flex flex-wrap items-end gap-3">
          <label className="text-sm" style={{ minWidth: 260 }}>
            Upload .geojson / .kml / .kmz
            <input
              className="border p-2 w-full"
              type="file"
              accept=".geojson,.json,.kml,.kmz,application/json,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/zip"
              onChange={(e) => setGfFile(e.target.files?.[0] || null)}
            />
          </label>
          <label className="text-sm">
            Geofence buffer size (m)
            <input
              className="border p-2 ml-2 w-28"
              type="number"
              min="1"
              step="1"
              value={gfBuffer}
              onChange={(e) => setGfBuffer(e.target.value)}
              title="Used to buffer Point features into circles"
            />
          </label>
          <button className="px-3 py-2 border rounded" type="submit">
            Upload Fences
          </button>
          <button className="px-3 py-2 border rounded" type="button" onClick={clearAllFences}>
            Clear Project Fences
          </button>
          <button
            className="px-3 py-2 border rounded"
            type="button"
            onClick={() => refreshFenceSummary(true)}
          >
            Refresh
          </button>
        </form>

        <div className="text-xs text-gray-600">
          Saving a pin or uploading a file will <b>{replaceFences ? "replace" : "append to"}</b> the
          current fences based on the checkbox above. You don’t need to press “Clear Project Fences”
          first.
        </div>
      </div>

      {/* Vault links */}
      <div className="border rounded p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Linked Documents (Vault)</div>
          <Link to="/vault" className="underline">
            Go to Vault
          </Link>
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <input
            className="border p-2"
            placeholder="Search docs…"
            value={docQuery}
            onChange={(e) => {
              setDocQuery(e.target.value);
              loadDocs(e.target.value);
            }}
            style={{ minWidth: 240 }}
          />
          <select
            className="border p-2"
            value={docPick}
            onChange={(e) => setDocPick(e.target.value)}
            style={{ minWidth: 320 }}
          >
            <option value="">— select a document —</option>
            {docs.map((d) => (
              <option key={d._id} value={d._id}>
                {d.title} {d.folder ? ` • ${d.folder}` : ""}{" "}
                {(d.tags || []).length ? ` • ${d.tags.join(",")}` : ""}
              </option>
            ))}
          </select>
          <button className="px-3 py-2 border rounded" onClick={linkDoc} disabled={!docPick}>
            Link
          </button>
        </div>

        {/* ====== UPDATED PRESENTATION WITH EXTRA COLUMNS ====== */}
        {linkedDocs.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="p-2 text-left">Title</th>
                <th className="p-2 text-left">For</th>
                <th className="p-2 text-left">Date</th>
                <th className="p-2 text-left">Tags</th>
                <th className="p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {linkedDocs.map((d) => {
                const title = d.title || d.latest?.filename || "Document";
                const userLink = (d.links || []).find(
                  (l) => (l.type || l.module) === "user"
                );
                const userName = userLabel(userLink?.refId);
                const whenISO =
                  d.latest?.uploadedAt || d.createdAt || d.updatedAt || null;
                const whenText = whenISO
                  ? new Date(whenISO).toLocaleString()
                  : "—";
                const tagsText = (d.tags || []).join(", ");

                return (
                  <tr key={d._id}>
                    <td className="border-t p-2">
                      <Link to={`/vault/${d._id}`} className="underline">
                        {title}
                      </Link>
                    </td>
                    <td className="border-t p-2">{userName}</td>
                    <td className="border-t p-2">{whenText}</td>
                    <td className="border-t p-2">{tagsText || "—"}</td>
                    <td className="border-t p-2 text-right">
                      <div className="inline-flex gap-2">
                        <Link
                          to={`/vault/${d._id}`}
                          className="px-2 py-1 border rounded"
                          title="Open in Vault"
                        >
                          Open
                        </Link>
                        <button
                          className="px-2 py-1 border rounded"
                          onClick={() => unlinkDoc(d._id)}
                        >
                          Unlink
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="text-sm text-gray-600">No linked documents.</div>
        )}
      </div>

      {/* Tasks */}
      <div className="border rounded p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Tasks for this Project</div>
          <div className="flex gap-2">
            <button className="px-3 py-2 border rounded" onClick={loadProjectTasks}>
              Refresh
            </button>
            <Link to="/tasks" className="px-3 py-2 border rounded">
              Open Tasks
            </Link>
          </div>
        </div>

        {projectTasks.length ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="p-2 text-left">Title</th>
                <th className="p-2 text-left">Status</th>
                <th className="p-2 text-left">Assignee</th>
                <th className="p-2 text-left">Due</th>
                <th className="p-2 text-right">Open</th>
              </tr>
            </thead>
            <tbody>
              {projectTasks.map((t) => (
                <tr key={t._id}>
                  <td className="border-t p-2">{t.title}</td>
                  <td className="border-t p-2">{t.status}</td>
                  <td className="border-t p-2">
                    {t.assignee ? userLabel(t.assignee) : "—"}
                  </td>
                  <td className="border-t p-2">
                    {t.dueAt ? new Date(t.dueAt).toLocaleDateString() : "—"}
                  </td>
                  <td className="border-t p-2 text-right">
                    <Link className="px-2 py-1 border rounded" to={`/tasks/${t._id}`}>
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-sm text-gray-600">No tasks for this project.</div>
        )}
      </div>

      {/* Inspections */}
      <div className="border rounded p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Inspections for this Project</div>
          <Link to="/inspections" className="underline">
            All inspections
          </Link>
        </div>

        {inspErr && <div className="text-red-600">{inspErr}</div>}
        {inspInfo && <div className="text-green-700">{inspInfo}</div>}

        <form onSubmit={createInspection} className="grid md:grid-cols-4 gap-2">
          <label className="text-sm md:col-span-2">
            Title
            <input
              className="border p-2 w-full"
              value={inspForm.title}
              onChange={(e) => setInspForm({ ...inspForm, title: e.target.value })}
              required
            />
          </label>
          <label className="text-sm">
            Status
            <select
              className="border p-2 w-full"
              value={inspForm.status}
              onChange={(e) => setInspForm({ ...inspForm, status: e.target.value })}
            >
              <option value="planned">planned</option>
              <option value="open">open</option>
              <option value="closed">closed</option>
            </select>
          </label>
          <label className="text-sm">
            Scheduled
            <input
              className="border p-2 w-full"
              type="datetime-local"
              value={inspForm.scheduledAt}
              onChange={(e) => setInspForm({ ...inspForm, scheduledAt: e.target.value })}
            />
          </label>
          <label className="text-sm md:col-span-3">
            Assignee
            <select
              className="border p-2 w-full"
              value={inspForm.assignee}
              onChange={(e) => setInspForm({ ...inspForm, assignee: e.target.value })}
            >
              <option value="">— none —</option>
              {users.map((u) => (
                <option key={u._id} value={u._id}>
                  {u.name || u.email || u.username}
                </option>
              ))}
            </select>
          </label>
          <div className="md:col-span-1 flex items-end">
            <button className="px-3 py-2 border rounded w-full">Create</button>
          </div>
        </form>

        <table className="w-full border text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="border p-2 text-left">Title</th>
              <th className="border p-2 text-left">Status</th>
              <th className="border p-2 text-left">Scheduled</th>
              <th className="border p-2 text-left">Assignee</th>
              <th className="border p-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {inspections.map((ins) => (
              <tr key={ins._id} className={ins.deletedAt ? "opacity-60" : ""}>
                <td className="border p-2">
                  <span className="underline">{ins.title}</span>
                  {ins.deletedAt && (
                    <div className="text-xs text-red-700">
                      deleted {new Date(ins.deletedAt).toLocaleString()}
                    </div>
                  )}
                </td>
                <td className="border p-2">
                  <select
                    className="border p-1"
                    value={ins.status || "planned"}
                    onChange={(e) => updateInspectionStatus(ins._id, e.target.value)}
                    disabled={!!ins.deletedAt}
                  >
                    <option value="planned">planned</option>
                    <option value="open">open</option>
                    <option value="closed">closed</option>
                  </select>
                </td>
                <td className="border p-2">
                  <div className="text-xs">
                    {ins.scheduledAt ? new Date(ins.scheduledAt).toLocaleString() : "—"}
                  </div>
                </td>
                <td className="border p-2">
                  <div className="text-xs">
                    {(() => {
                      const u = users.find((x) => String(x._id) === String(ins.assignee));
                      return u ? u.name || u.email || u.username : "—";
                    })()}
                  </div>
                </td>
                <td className="border p-2 text-right">
                  {!ins.deletedAt ? (
                    <button
                      className="px-2 py-1 border rounded"
                      onClick={() => deleteInspection(ins._id)}
                    >
                      Delete
                    </button>
                  ) : (
                    <button
                      className="px-2 py-1 border rounded"
                      onClick={() => restoreInspection(ins._id)}
                    >
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!inspections.length && (
              <tr>
                <td className="p-4 text-center" colSpan={5}>
                  No inspections for this project.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
