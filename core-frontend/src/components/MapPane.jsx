// src/components/MapPane.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";

/* ---- optional FilterContext bridge ---- */
function useOptionalFilters() {
  let ctx = null;
  try { ctx = require("../widgets/FilterContext"); } catch {}
  if (ctx && ctx.useFilters) {
    const slice = ctx.useFilters(["project", "rag", "dr", "groups"]);
    return {
      rag: slice.rag || "",
      dr: slice.dr || {},
      projectIds: (slice.project?.ids || []).map(String),
      groups: (slice.groups?.ids || []).map(String),
      setFilters: ctx.setFilters,
      emit: ctx.emit || ((d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: d }))),
    };
  }
  // window event fallback
  const [rag, setRag] = React.useState("");
  const [dr, setDr] = React.useState({});
  const [projectIds, setProjectIds] = React.useState([]);
  const [groups, setGroups] = React.useState([]);
  useEffect(() => {
    const h = (e) => {
      const d = e?.detail || {};
      if ("rag" in d) setRag(String(d.rag || ""));
      if ("dr" in d) setDr(d.dr || {});
      if (d.project && Array.isArray(d.project.ids)) setProjectIds(d.project.ids.map(String));
      if (d.groups && Array.isArray(d.groups.ids)) setGroups(d.groups.ids.map(String));
    };
    window.addEventListener("dashboard:filtersChanged", h);
    return () => window.removeEventListener("dashboard:filtersChanged", h);
  }, []);
  return {
    rag, dr, projectIds, groups,
    setFilters: null,
    emit: (d) => window.dispatchEvent(new CustomEvent("dashboard:filtersChanged", { detail: d })),
  };
}

/* ---- helpers ---- */
const toId = (p) => String(p?._id || p?.id || "");
const labelOf = (p) => String(p?.name || p?.title || toId(p));
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "-");
function isClosedLike(s){ const t=norm(s); return ["done","closed","complete","completed","cancelled","canceled","void"].includes(t); }
function isPausedLike(s){ const t=norm(s); return ["paused","paused-problem","on-hold","hold","pause"].includes(t); }
function endOf(p){ return p.end || p.endDate || p.due || p.deadlineAt || p.finishAt || null; }
function startOf(p){ return p.start || p.startDate || p.begin || p.startAt || null; }
function isOverdueProject(p, now = new Date()){ const d=endOf(p); if(!d) return false; const x=new Date(d); return !isNaN(+x)&&x<now&&!isClosedLike(p.status); }
function intersectsRange(p, fromAt, toAt){
  if (!fromAt && !toAt) return true;
  const s = startOf(p) ? new Date(startOf(p)) : null;
  const e = endOf(p)   ? new Date(endOf(p))   : null;
  const from = fromAt ? new Date(fromAt) : null;
  const to   = toAt   ? new Date(toAt)   : null;
  const left  = s ? s.getTime() : -Infinity;
  const right = e ? e.getTime() : +Infinity;
  const L = from ? from.getTime() : -Infinity;
  const R = to   ? to.getTime()   : +Infinity;
  return left <= R && right >= L;
}
function projectGroups(p){
  const pool = []
    .concat(p.groupId || [])
    .concat(p.groups || [])
    .concat(p.group || [])
    .concat(p.teamGroups || []);
  const out = new Set();
  for (const v of pool.flat()) {
    const s = String(v?._id || v?.id || v || "");
    if (s) out.add(s);
  }
  return Array.from(out);
}

/* ---- deterministic color per project ---- */
function hashStr(s){
  let h = 2166136261 >>> 0;
  for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function colorForProject(p){
  const palette = [
    "#2563eb", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
    "#0ea5e9", "#22c55e", "#eab308", "#f97316", "#06b6d4",
  ];
  const idx = hashStr(toId(p) || labelOf(p)) % palette.length;
  return palette[idx];
}
function hexToRgba(hex, a){
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return "rgba(0,0,0,0.14)";
  const r = parseInt(m[1],16), g=parseInt(m[2],16), b=parseInt(m[3],16);
  return `rgba(${r},${g},${b},${a})`;
}

/* ---- shape normalizers ---- */
function normPolygon(raw){ if(!Array.isArray(raw)) return null;
  const out = raw.map(p=> Array.isArray(p)?p:[Number(p.lng),Number(p.lat)]);
  return out.every(pt=>Array.isArray(pt)&&pt.length===2&&pt.every(Number.isFinite)) ? out : null;
}
function normLine(raw){ if(!Array.isArray(raw)) return null;
  const out = raw.map(p=> Array.isArray(p)?p:[Number(p.lng),Number(p.lat)]);
  return out.every(pt=>Array.isArray(pt)&&pt.length===2&&pt.every(Number.isFinite)) ? out : null;
}
function normCircle(raw){ const c=raw?.center || raw?.point || {};
  const lat=Number(c.lat??c[1]), lng=Number(c.lng??c[0]), r=Number(raw?.radius??raw?.radiusMeters??raw?.r);
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||!Number.isFinite(r)) return null;
  return { center:{lat,lng}, radius:r };
}

/* ---- task status helpers ---- */
function isCriticalTask(t) {
  const s = norm(t?.status);
  const now = new Date();
  const due = t?.dueAt ? new Date(t.dueAt) : null;
  const overdue = due && !isNaN(+due) && +due < +now && !["done","closed","complete","completed"].includes(s);
  const hint = ["critical","overdue","iod","problem","blocked"].some(k => s.includes(k));
  const highPri = norm(t?.priority).includes("high");
  return !!(overdue || hint || highPri);
}
function taskStrokeColor(t, base) {
  return isCriticalTask(t) ? "#ef4444" : base; // red for critical
}

/* ---- legend chip ---- */
function Chip({ label, toneColor, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`map-chip ${active ? "is-active" : ""}`}
      title={active ? `${label} (click to clear)` : label}
      aria-pressed={!!active}
      style={{
        borderColor: toneColor,
        boxShadow: active ? `0 0 0 4px ${hexToRgba(toneColor, 0.18)}` : "none",
        background: active ? hexToRgba(toneColor, 0.08) : "#fff",
        color: active ? "#111827" : "#374151",
      }}
    >
      <span className="map-chip-lab">{label}</span>
    </button>
  );
}

export default function MapPane(){
  const { rag, dr, projectIds, groups, setFilters, emit } = useOptionalFilters();
  const [rows, setRows] = useState([]);
  const [err, setErr]   = useState("");
  const [loading, setLoading] = useState(false);

  // cache of project → fences (array of shapes)
  const fencesCacheRef = useRef(new Map()); // pid -> { loaded:boolean, fences:[] }
  // cache of project → tasks (and their fences)
  const taskFencesCacheRef = useRef(new Map()); // pid -> { tasks:[], fencesByTask: Map }

  // NEW: bump this whenever caches update so layers redraw when async loads finish
  const [drawNonce, setDrawNonce] = useState(0);

  // Leaflet refs
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  // Load projects (prefer window cache)
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true); setErr("");
      try {
        const w = (typeof window !== "undefined" ? window : {});
        const cached = Array.isArray(w.__PROJECTS__) ? w.__PROJECTS__ : null;
        if (cached) { if (alive) { setRows(cached); setLoading(false); } return; }
        const { data } = await api.get("/projects", { params: { limit: 2000, _ts: Date.now() }, timeout: 10000 });
        if (!alive) return;
        const list = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : [];
        setRows(list);
        try { window.__PROJECTS__ = Array.isArray(list) ? list : []; } catch {}
      } catch (e) {
        if (!alive) return;
        setErr(e?.response?.data?.error || String(e)); setRows([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  // RAG scope (same mapping as ProjectsWidget)
  const ragKey = rag === "green" ? "active" : rag === "amber" ? "paused" : rag === "red" ? "overdue" : "";

  const scoped = useMemo(() => {
    if (!rows.length) return [];
    const fromAt = dr?.fromAt || dr?.from || "";
    const toAt   = dr?.toAt   || dr?.to   || "";
    const wantGroups = (groups || []).map(String);
    const restrictGroups = wantGroups.length > 0;
    return rows.filter((p) => {
      if (!intersectsRange(p, fromAt, toAt)) return false;
      if (restrictGroups) {
        const pg = projectGroups(p);
        if (!pg.some(g => wantGroups.includes(String(g)))) return false;
      }
      if (ragKey) {
        const now = new Date();
        const paused = isPausedLike(p.status);
        const overdue = isOverdueProject(p, now);
        const closed  = isClosedLike(p.status);
        const active  = !paused && !overdue && !closed;
        if (ragKey === "active"  && !active)  return false;
        if (ragKey === "paused"  && !paused)  return false;
        if (ragKey === "overdue" && !overdue) return false;
      }
      return true;
    });
  }, [rows, dr?.fromAt, dr?.toAt, dr?.from, dr?.to, groups, ragKey]);

  const legend = useMemo(() => {
    const list = scoped.slice();
    list.sort((a,b) => labelOf(a).localeCompare(labelOf(b)));
    return list;
  }, [scoped]);

  // click -> focus/clear + publish context for title swap
  function pickProject(p){
    const id = toId(p);
    const isActive = projectIds.includes(id);
    const nextIds = isActive ? [] : [id];
    const nextContext = nextIds.length === 1
      ? { projectId: id, projectName: labelOf(p) }
      : {}; // clear when none focused

    try {
      setFilters?.((prev) => ({
        ...prev,
        project: { ...(prev?.project || {}), ids: nextIds, status: [] },
        context: nextContext,
      }));
    } catch {}
    emit({ project: { ids: nextIds, status: [] }, context: nextContext });

    // Keep FilterContext listeners (and any legacy consumers) perfectly in sync
    if (nextContext.projectId) {
      window.dispatchEvent(new CustomEvent("map:projectSelected", {
        detail: { projectId: nextContext.projectId, name: nextContext.projectName }
      }));
    } else {
      window.dispatchEvent(new CustomEvent("map:projectCleared"));
    }
  }

  /* =========================
     Leaflet map init
     ========================= */
  useEffect(() => {
    const L = (typeof window !== "undefined" ? window.L : null);
    if (!L) return;

    if (!mapRef.current) {
      const el = document.getElementById("dashboard-leaflet-map");
      if (!el) return;
      const map = L.map(el, { zoomControl: true });
      L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }
      ).addTo(map);
      map.setView([0,0], 2);
      mapRef.current = map;
      layerRef.current = L.layerGroup().addTo(map);
    }
  }, []);

  /* =========================
     Fetch project fences lazily
     ========================= */
  useEffect(() => {
    let cancelled = false;
    const toDraw = (legend.length && projectIds.length ? legend.filter(p => projectIds.includes(toId(p))) : legend);
    const idsNeeded = toDraw.map(toId).filter(Boolean);

    (async () => {
      const missing = idsNeeded.filter(pid => !fencesCacheRef.current.has(pid));
      if (!missing.length) return;
      const batchSize = 5;
      for (let i=0; i<missing.length; i+=batchSize) {
        const slice = missing.slice(i, i+batchSize);
        const res = await Promise.all(slice.map(async(pid) => {
          try {
            const { data } = await api.get(`/projects/${pid}/geofences`, { params: { _ts: Date.now() } });
            const fences =
              (Array.isArray(data?.geoFences) && data.geoFences) ||
              (Array.isArray(data?.fences) && data.fences) ||
              (Array.isArray(data) && data) || [];
            return { pid, fences };
          } catch {
            return { pid, fences: [] };
          }
        }));
        if (cancelled) return;
        res.forEach(({ pid, fences }) => fencesCacheRef.current.set(pid, { loaded: true, fences }));
        // bump draw so polygons appear immediately after arriving
        setDrawNonce(n => n + 1);
      }
    })();

    return () => { cancelled = true; };
  }, [legend, projectIds]);

  /* =========================
     Fetch task overlays when a single project is focused
     ========================= */
  useEffect(() => {
    let cancelled = false;
    if (projectIds.length !== 1) return;
    const pid = String(projectIds[0] || "");
    if (!pid) return;

    (async () => {
      if (taskFencesCacheRef.current.has(pid)) {
        // Ensure a redraw when focusing a project whose tasks were cached earlier
        setDrawNonce(n => n + 1);
        return;
      }

      try {
        const { data } = await api.get("/tasks", { params: { projectId: pid, limit: 2000 } });
        const tasks = Array.isArray(data) ? data : (Array.isArray(data?.rows) ? data.rows : []);
        const fencesByTask = new Map();

        const batch = 6;
        for (let i=0; i<tasks.length; i+=batch) {
          const part = tasks.slice(i, i+batch);
          const partRes = await Promise.all(part.map(async(t) => {
            try {
              const { data } = await api.get(`/tasks/${t._id || t.id}/geofences`, { params: { _ts: Date.now() } });
              const list = (Array.isArray(data?.geoFences) && data.geoFences) ||
                           (Array.isArray(data?.fences) && data.fences) ||
                           (Array.isArray(data) && data) || [];
              return { id: String(t._id || t.id), fences: list, task: t };
            } catch {
              return { id: String(t._id || t.id), fences: [], task: t };
            }
          }));
          if (cancelled) return;
          partRes.forEach(r => fencesByTask.set(r.id, { fences: r.fences, task: r.task }));
        }

        if (!cancelled) {
          taskFencesCacheRef.current.set(pid, { tasks, fencesByTask });
          // bump draw so task overlays + pulses render immediately
          setDrawNonce(n => n + 1);
        }
      } catch {
        taskFencesCacheRef.current.set(pid, { tasks: [], fencesByTask: new Map() });
        setDrawNonce(n => n + 1);
      }
    })();

    return () => { cancelled = true; };
  }, [projectIds]);

  /* =========================
     Render layers (+ critical pulse)
     ========================= */
  useEffect(() => {
    const L = (typeof window !== "undefined" ? window.L : null);
    if (!L || !mapRef.current || !layerRef.current) return;

    const map = mapRef.current;
    const layer = layerRef.current;

    layer.clearLayers();
    let anyBounds = null;

    // Ensure pulse CSS is present once
    (function ensurePulseCss(){
      if (document.getElementById("pulse-dot-css")) return;
      const style = document.createElement("style");
      style.id = "pulse-dot-css";
      style.textContent = `
        @keyframes pulseRing {
          0% { box-shadow: 0 0 0 0 rgba(239,68,68,0.45); }
          70% { box-shadow: 0 0 0 14px rgba(239,68,68,0); }
          100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
        }
        .pulse-dot {
          width: 10px; height: 10px; border-radius: 50%;
          background: #ef4444; border: 2px solid white;
          box-shadow: 0 0 0 0 rgba(239,68,68,0.45);
          animation: pulseRing 1.6s infinite;
        }
      `;
      document.head.appendChild(style);
    })();

    const focused = legend.filter(p => projectIds.includes(toId(p)));
    const toDraw = focused.length ? focused : legend;

    // draw project fences
    toDraw.forEach((p) => {
      const pid = toId(p);
      const color = colorForProject(p);
      const cached = fencesCacheRef.current.get(pid);
      const fences = cached?.fences || [];

      fences.forEach((raw) => {
        const t = String(raw?.type || raw?.kind || raw?.geometry?.type || "").toLowerCase();

        if (t === "polygon" || raw?.polygon || raw?.geometry?.type === "Polygon") {
          const poly =
            normPolygon(raw?.polygon) ||
            (Array.isArray(raw?.geometry?.coordinates) && Array.isArray(raw.geometry.coordinates[0]) && normPolygon(raw.geometry.coordinates[0])) ||
            null;
          if (poly) {
            const lyr = L.polygon(poly.map(([lng, lat]) => [lat, lng]), {
              color, weight: 2, fillOpacity: 0.08,
            }).addTo(layer);
            const bb = lyr.getBounds?.();
            if (bb && bb.isValid && bb.isValid()) anyBounds = anyBounds ? anyBounds.extend(bb) : bb;
            return;
          }
        }

        if (t === "polyline" || t === "line" || Array.isArray(raw?.line) || Array.isArray(raw?.path)) {
          const line = normLine(raw.line || raw.path);
          if (line) {
            const lyr = L.polyline(line.map(([lng, lat]) => [lat, lng]), {
              color, weight: 3,
            }).addTo(layer);
            const bb = lyr.getBounds?.();
            if (bb && bb.isValid && bb.isValid()) anyBounds = anyBounds ? anyBounds.extend(bb) : bb;
            return;
          }
        }

        if (t === "circle" || raw?.radius || raw?.radiusMeters) {
          const c = normCircle(raw);
          if (c) {
            const lyr = L.circle([c.center.lat, c.center.lng], {
              radius: c.radius, color, weight: 2, fillOpacity: 0.08,
            }).addTo(layer);
            const bb = lyr.getBounds?.();
            if (bb && bb.isValid && bb.isValid()) anyBounds = anyBounds ? anyBounds.extend(bb) : bb;
            return;
          }
        }

        if (t === "point" || raw?.geometry?.type === "Point") {
          const coords =
            (Array.isArray(raw?.coordinates) && raw.coordinates) ||
            (Array.isArray(raw?.geometry?.coordinates) && raw.geometry.coordinates) || null;
          if (Array.isArray(coords) && coords.length >= 2 && coords.every(Number.isFinite)) {
            const [lng, lat] = coords;
            const lyr = L.circleMarker([lat, lng], { radius: 5, color, weight: 2, fillOpacity: 0.9 }).addTo(layer);
            const bb = lyr.getBounds?.();
            if (bb && bb.isValid && bb.isValid()) anyBounds = anyBounds ? anyBounds.extend(bb) : bb;
            return;
          }
        }
      });
    });

    // task overlays when exactly one is focused
    if (focused.length === 1 && focused[0]) {
      const pid = toId(focused[0]);
      const baseColor = colorForProject(focused[0]);
      const taskBundle = taskFencesCacheRef.current.get(pid);

      (taskBundle?.tasks || []).forEach((t) => {
        const gf = t.locationGeoFence;
        if (gf && gf.lat != null && gf.lng != null) {
          const lat = Number(gf.lat), lng = Number(gf.lng);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            const tColor = taskStrokeColor(t, baseColor);
            const lyr = (window.L).circleMarker([lat, lng], { radius: 4, color: tColor, weight: 2, fillOpacity: 0.9 })
              .bindTooltip(String(t.title || "Task"), { direction: "top" })
              .addTo(layer);
            const bb = lyr.getBounds?.();
            if (bb && bb.isValid && bb.isValid()) anyBounds = anyBounds ? anyBounds.extend(bb) : bb;

            if (isCriticalTask(t)) {
              const div = (window.L).divIcon({ className: "pulse-dot" });
              (window.L).marker([lat, lng], { icon: div, interactive: false }).addTo(layer);
            }
          }
        }
      });

      if (taskBundle?.fencesByTask instanceof Map) {
        taskBundle.fencesByTask.forEach(({ fences, task }) => {
          fences.forEach((raw) => {
            const t = String(raw?.type || raw?.kind || raw?.geometry?.type || "").toLowerCase();
            const tColor = taskStrokeColor(task, baseColor);
            let centerForPulse = null;

            if (t === "polygon" || raw?.polygon || raw?.geometry?.type === "Polygon") {
              const poly =
                normPolygon(raw?.polygon) ||
                (Array.isArray(raw?.geometry?.coordinates) && Array.isArray(raw.geometry.coordinates[0]) && normPolygon(raw.geometry.coordinates[0])) ||
                null;
              if (poly) {
                const lyr = (window.L).polygon(poly.map(([lng, lat]) => [lat, lng]), {
                  color: tColor, weight: 1.5, dashArray: "4 4", fillOpacity: 0,
                }).bindTooltip(String(task?.title || "Task"), { direction: "top" }).addTo(layer);
                try { centerForPulse = lyr.getBounds().getCenter(); } catch {}
                const bb = lyr.getBounds?.();
                if (bb && bb.isValid && bb.isValid()) anyBounds = anyBounds ? anyBounds.extend(bb) : bb;
              }
            } else if (t === "polyline" || t === "line" || Array.isArray(raw?.line) || Array.isArray(raw?.path)) {
              const line = normLine(raw.line || raw.path);
              if (line) {
                const lyr = (window.L).polyline(line.map(([lng, lat]) => [lat, lng]), {
                  color: tColor, weight: 2, dashArray: "4 4",
                }).bindTooltip(String(task?.title || "Task"), { direction: "top" }).addTo(layer);
                try { centerForPulse = lyr.getBounds().getCenter(); } catch {}
                const bb = lyr.getBounds?.();
                if (bb && bb.isValid && bb.isValid()) anyBounds = anyBounds ? anyBounds.extend(bb) : bb;
              }
            } else if (t === "circle" || raw?.radius || raw?.radiusMeters) {
              const c = normCircle(raw);
              if (c) {
                const lyr = (window.L).circle([c.center.lat, c.center.lng], {
                  radius: c.radius, color: tColor, weight: 1.5, dashArray: "4 4", fillOpacity: 0,
                }).bindTooltip(String(task?.title || "Task"), { direction: "top" }).addTo(layer);
                centerForPulse = { lat: c.center.lat, lng: c.center.lng };
                const bb = lyr.getBounds?.();
                if (bb && bb.isValid && bb.isValid()) anyBounds = anyBounds ? anyBounds.extend(bb) : bb;
              }
            } else if (t === "point" || raw?.geometry?.type === "Point") {
              const coords =
                (Array.isArray(raw?.coordinates) && raw.coordinates) ||
                (Array.isArray(raw?.geometry?.coordinates) && raw.geometry.coordinates) || null;
              if (Array.isArray(coords) && coords.length >= 2 && coords.every(Number.isFinite)) {
                const [lng, lat] = coords;
                const lyr = (window.L).circleMarker([lat, lng], { radius: 4, color: tColor, weight: 1, fillOpacity: 0.9 })
                  .bindTooltip(String(task?.title || "Task"), { direction: "top" })
                  .addTo(layer);
                centerForPulse = { lat, lng };
                const bb = lyr.getBounds?.();
                if (bb && bb.isValid && bb.isValid()) anyBounds = anyBounds ? anyBounds.extend(bb) : bb;
              }
            }

            if (isCriticalTask(task) && centerForPulse) {
              const div = (window.L).divIcon({ className: "pulse-dot" });
              (window.L).marker([centerForPulse.lat, centerForPulse.lng], { icon: div, interactive: false }).addTo(layer);
            }
          });
        });
      }
    }

    if (anyBounds) {
      try { map.fitBounds(anyBounds.pad(0.2)); } catch {}
    }
  }, [legend, projectIds, drawNonce]); // <-- redraw when caches finish loading

  return (
    <div>
      <style>{`
        .map-legend-row{
          display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;
        }

        /* Namespaced legend button to avoid global .chip collisions */
        .map-chip{
          appearance:none; -webkit-appearance:none; box-sizing:border-box;
          display:inline-flex; align-items:center; justify-content:center;
          border:1px solid #e5e7eb; border-radius:8px;
          padding:6px 8px;
          min-height:0; height:auto;
          font: inherit; font-size:12px; line-height:1;
          background:#fff; color:#374151;
          cursor:pointer; user-select:none; white-space:nowrap; max-width:240px;
          transition: box-shadow .15s ease, background .15s ease, border-color .15s ease, color .15s ease;
        }
        .map-chip::-moz-focus-inner{ border:0; padding:0; }
        .map-chip:hover{ box-shadow:0 0 0 4px rgba(2,132,199,.10); }
        .map-chip.is-active{ font-weight:600; }
        .map-chip-lab{ display:inline-block; line-height:1; }

        .map-holder{
          border:1px dashed #e5e7eb; border-radius:10px; overflow:hidden; background:#fafafa;
          height: 420px;
          position: relative;
        }
        #dashboard-leaflet-map{ position:absolute; inset:0; }
        .placeholder{
          position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
          color:#6b7280;
        }
      `}</style>

      {/* Horizontal legend across the top */}
      <div className="map-legend-row" aria-label="Project legend">
        {legend.map((p) => {
          const id = toId(p);
          const active = projectIds.includes(id);
          const toneColor = colorForProject(p);
          return (
            <Chip
              key={id}
              label={labelOf(p)}
              toneColor={toneColor}
              active={active}
              onClick={() => pickProject(p)}
            />
          );
        })}
        {!legend.length && !loading && (
          <span style={{ fontSize: 12, color:"#6b7280" }}>No projects.</span>
        )}
      </div>

      {/* Map area */}
      <div className="map-holder">
        <div id="dashboard-leaflet-map" />
        {!((typeof window !== "undefined") && window.L) && (
          <div className="placeholder">
            Map placeholder — Leaflet not loaded yet
          </div>
        )}
      </div>

      {loading && <div className="mt-2 text-xs text-gray-500">Loading projects…</div>}
      {err && <div className="mt-2 text-xs text-red-600">{err}</div>}
    </div>
  );
}
