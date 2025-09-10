// src/components/GeoFencePreview.jsx
import React, { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

export default function GeoFencePreview({
  projectId,
  taskId,                 // optional: overlay task fences on top of project
  height = 360,
  className = "",
  reloadKey,

  // Interactivity
  allowPicking = false,
  onPickLocation,

  // Visuals
  legend = false,         // tiny legend in the corner
  projectStyle = {
    color: "#1e3a8a",     // blue-800
    weight: 2,
    dashArray: null,
    fillColor: "#60a5fa", // blue-400
    fillOpacity: 0.08,
  },
  taskStyle = {
    color: "#b45309",     // amber-700
    weight: 2,
    dashArray: "7,3",
    fillColor: "#f59e0b", // amber-500
    fillOpacity: 0.12,
  },

  // Extras (supports point / circle / polygon / polyline)
  fallbackCircle = null,  // {lat,lng,radius} when nothing saved yet
  taskCircle = null,      // live pin+buffer (e.g. before save)
  extraFences = [],       // extra markers/polys to render

  // Render Point features as dot + buffered circle
  renderPointsAsCircles = true,
  pointRadiusMeters = 25, // default buffer in meters when feature doesn't override
  pointPixelRadius = 5,   // visual radius (px) for the dot

  // NEW: quick hover labels (uses f.meta.label / f.title / f.name / f.label)
  enableHoverLabels = true,

  // Notify parent when fences fetched (to enable downloads, etc.)
  onLoaded,               // ({ projectFences, taskFences }) => void
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerProjectRef = useRef(null);
  const layerTaskRef = useRef(null);
  const layerExtraRef = useRef(null);
  const layerPickRef = useRef(null);

  const [L, setL] = useState(null);
  const [err, setErr] = useState("");
  const [projectFences, setProjectFences] = useState([]);
  const [taskFences, setTaskFences] = useState([]);

  // Soft-load Leaflet
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await import("leaflet");
        await import("leaflet/dist/leaflet.css");
        if (!cancelled) setL(mod);
      } catch {
        if (!cancelled) setErr("Map preview unavailable (Leaflet not installed).");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Fetch fences (project)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!projectId) { setProjectFences([]); return; }
      try {
        const { data } = await api.get(`/projects/${projectId}/geofences`, {
          headers: { "cache-control": "no-cache" },
        });
        const list = Array.isArray(data?.geoFences) ? data.geoFences
                   : Array.isArray(data?.fences)    ? data.fences
                   : Array.isArray(data)            ? data : [];
        if (!cancelled) setProjectFences(list);
      } catch {
        if (!cancelled) setProjectFences([]);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, reloadKey]);

  // Fetch fences (task)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!taskId) { setTaskFences([]); return; }
      try {
        const { data } = await api.get(`/tasks/${taskId}/geofences`, {
          headers: { "cache-control": "no-cache" },
        });
        const list = Array.isArray(data?.geoFences) ? data.geoFences
                   : Array.isArray(data?.fences)    ? data.fences
                   : Array.isArray(data)            ? data : [];
        if (!cancelled) setTaskFences(list);
      } catch {
        if (!cancelled) setTaskFences([]);
      }
    })();
    return () => { cancelled = true; };
  }, [taskId, reloadKey]);

  // Notify parent whenever we have the latest
  useEffect(() => {
    onLoaded?.({ projectFences, taskFences });
  }, [onLoaded, projectFences, taskFences]);

  // Helpers
  const isNum = (n) => Number.isFinite(typeof n === "string" ? Number(n) : n);

  // Accepts [lng,lat] array OR {lat,lng} object
  const toLatLngPair = (pt) => {
    if (!pt) return null;
    if (Array.isArray(pt) && pt.length >= 2) {
      const lng = Number(pt[0]); const lat = Number(pt[1]);
      if (isNum(lat) && isNum(lng)) return [lat, lng];
    } else if (typeof pt === "object") {
      const lat = Number(pt.lat); const lng = Number(pt.lng);
      if (isNum(lat) && isNum(lng)) return [lat, lng];
    }
    return null;
  };

  // Normalize polygon to [[lat,lng]...]
  const normalizePolygonLatLng = (polyOrObj) => {
    let poly = polyOrObj;
    if (poly && poly.coordinates) poly = poly.coordinates;
    if (!Array.isArray(poly)) return null;
    if (Array.isArray(poly[0]) && Array.isArray(poly[0][0]) && Array.isArray(poly[0][0][0])) {
      poly = poly[0]; // MultiPolygon -> first Polygon
    }
    const ring = Array.isArray(poly[0]) && (Array.isArray(poly[0][0]) || typeof poly[0][0] === "object")
      ? poly[0]
      : poly;
    const out = [];
    for (const p of ring) {
      const pair = toLatLngPair(p);
      if (pair) out.push(pair);
    }
    return out.length >= 3 ? out : null;
  };

  const toCircle = (f) => {
    const pickCenter = () => {
      if (f?.center) {
        const pair = toLatLngPair(f.center);
        if (pair) return { lat: pair[0], lng: pair[1] };
      }
      if (f?.point) {
        const pair = toLatLngPair(f.point);
        if (pair) return { lat: pair[0], lng: pair[1] };
      }
      if (isNum(f?.lat) && isNum(f?.lng)) return { lat: Number(f.lat), lng: Number(f.lng) };
      return null;
    };
    const center = pickCenter();
    const r = isNum(f?.radius) ? Number(f.radius)
            : isNum(f?.radiusMeters) ? Number(f.radiusMeters) : null;
    if ((String(f?.type).toLowerCase() === "circle" || f?.kind === "circle") && center && isNum(r)) {
      return { lat: center.lat, lng: center.lng, radius: r };
    }
    return null;
  };

  const toPolyline = (f) => {
    const line = f?.line || f?.path || f?.coordinates;
    if (!Array.isArray(line)) return null;
    const latlngs = [];
    for (const p of line) {
      const pair = toLatLngPair(p);
      if (pair) latlngs.push(pair);
    }
    return latlngs.length >= 2 ? latlngs : null;
  };

  const toPoint = (f) => {
    // explicit point
    if (String(f?.type).toLowerCase() === "point") {
      const pair = toLatLngPair(f.coordinates || f.point);
      if (pair) return { lat: pair[0], lng: pair[1] };
    }
    // generic lat/lng
    if (isNum(f?.lat) && isNum(f?.lng)) return { lat: Number(f.lat), lng: Number(f.lng) };
    // GeoJSON Feature { geometry: { type: 'Point', coordinates: [lng,lat] } }
    if (f?.geometry && String(f.geometry.type).toLowerCase() === "point") {
      const pair = toLatLngPair(f.geometry.coordinates);
      if (pair) return { lat: pair[0], lng: pair[1] };
    }
    return null;
  };

  const resolvePointRadiusMeters = (feature) => {
    const cand = feature?.pointRadiusMeters ?? feature?.bufferMeters ?? feature?.radius ?? feature?.radiusMeters;
    const n = Number(cand);
    return Number.isFinite(n) ? n : Number(pointRadiusMeters) || 25;
  };

  // Create map once
  useEffect(() => {
    if (!L || !containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, { center: [0, 0], zoom: 2, preferCanvas: true, zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 20,
    }).addTo(map);

    layerProjectRef.current = L.layerGroup().addTo(map);
    layerTaskRef.current    = L.layerGroup().addTo(map);
    layerExtraRef.current   = L.layerGroup().addTo(map);
    layerPickRef.current    = L.layerGroup().addTo(map);
    mapRef.current = map;

    if (allowPicking) {
      map.on("click", (e) => {
        const lat = e?.latlng?.lat; const lng = e?.latlng?.lng;
        if (!isNum(lat) || !isNum(lng)) return;
        try {
          const pick = layerPickRef.current; pick.clearLayers();
          // dot instead of pin
          const dot = L.circleMarker([lat, lng], {
            radius: pointPixelRadius,
            color: "#111",
            weight: 1,
            fillColor: "#111",
            fillOpacity: 1,
          }).addTo(pick);
          if (enableHoverLabels) dot.bindTooltip("Picked location", { direction: "top", sticky: true, opacity: 0.9 });
        } catch {}
        onPickLocation?.({ lat, lng });
      });
    }

    setTimeout(() => { try { map.invalidateSize(false); } catch {} }, 50);
  }, [L, allowPicking, onPickLocation, pointPixelRadius, enableHoverLabels]);

  // Style normalizer
  function normalizeStyle(s) {
    return {
      color: s?.color ?? "#000",
      weight: Number.isFinite(Number(s?.weight)) ? Number(s.weight) : 2,
      dashArray: s?.dashArray ?? null,
      fillColor: s?.fillColor ?? s?.color ?? "#000",
      fillOpacity: Number.isFinite(Number(s?.fillOpacity)) ? Number(s.fillOpacity) : 0.1,
    };
  }

  // Draw everything
  useEffect(() => {
    if (!L || !mapRef.current || !layerProjectRef.current || !layerTaskRef.current || !layerExtraRef.current) return;

    const map = mapRef.current;
    const layerProj = layerProjectRef.current;
    const layerTask = layerTaskRef.current;
    const layerExtra = layerExtraRef.current;

    layerProj.clearLayers();
    layerTask.clearLayers();
    layerExtra.clearLayers();

    const bounds = L.latLngBounds([]);
    let drew = false;

    const labelFor = (f) =>
      f?.meta?.label || f?.title || f?.name || f?.label || null;

    const maybeTooltip = (layer, f) => {
      if (!enableHoverLabels) return;
      const lbl = labelFor(f);
      if (lbl && layer?.bindTooltip) {
        try { layer.bindTooltip(String(lbl), { direction: "top", sticky: true, opacity: 0.9 }); } catch {}
      }
    };

    const drawSet = (fences, style, targetLayer) => {
      const st = normalizeStyle(style);
      for (const f of fences || []) {
        const type = String(f?.type || f?.kind || f?.geometry?.type || "").toLowerCase();

        // polygon
        if (type === "polygon" || (f?.polygon || (f?.geometry && f.geometry.type === "Polygon"))) {
          const latlngs = normalizePolygonLatLng(f.polygon || f.geometry || f.coordinates);
          if (latlngs) {
            const poly = L.polygon(latlngs, st).addTo(targetLayer);
            maybeTooltip(poly, f);
            const b = poly.getBounds?.(); if (b?.isValid()) bounds.extend(b);
            drew = true;
            continue;
          }
        }

        // circle
        if (type === "circle" || f?.radius || f?.radiusMeters) {
          const c = toCircle(f);
          if (c) {
            const circle = L.circle([c.lat, c.lng], { ...st, radius: c.radius }).addTo(targetLayer);
            maybeTooltip(circle, f);
            const b = circle.getBounds?.(); if (b?.isValid()) bounds.extend(b);
            drew = true;
            continue;
          }
        }

        // polyline / line
        if (type === "line" || type === "polyline" || Array.isArray(f?.line) || Array.isArray(f?.path)) {
          const latlngs = toPolyline(f);
          if (latlngs) {
            const pl = L.polyline(latlngs, st).addTo(targetLayer);
            maybeTooltip(pl, f);
            const b = pl.getBounds?.(); if (b?.isValid()) bounds.extend(b);
            drew = true;
            continue;
          }
        }

        // point => dot + (optional) buffered circle
        const pt = toPoint(f);
        if (pt) {
          const dot = L.circleMarker([pt.lat, pt.lng], {
            radius: pointPixelRadius,
            color: st.color || "#000",
            weight: 1,
            fillColor: st.color || "#000",
            fillOpacity: 1,
          }).addTo(targetLayer);
          maybeTooltip(dot, f);

          let b = dot.getLatLng ? L.latLngBounds([dot.getLatLng()]) : null;

          if (renderPointsAsCircles) {
            const radius = resolvePointRadiusMeters(f);
            const circle = L.circle([pt.lat, pt.lng], { ...st, radius }).addTo(targetLayer);
            maybeTooltip(circle, f);
            const cb = circle.getBounds?.();
            if (cb?.isValid()) b = b ? b.extend(cb) : cb;
          }

          if (b?.isValid()) bounds.extend(b);
          drew = true;
          continue;
        }
      }
    };

    // Project below, Task above
    drawSet(projectFences, projectStyle, layerProj);
    drawSet(taskFences,    taskStyle,    layerTask);

    // Live taskCircle (e.g. pin+buffer not yet saved)
    if (taskCircle && isNum(taskCircle.lat) && isNum(taskCircle.lng) && isNum(taskCircle.radius)) {
      const st = normalizeStyle({ ...taskStyle, dashArray: "2,4" });
      const circle = L.circle([taskCircle.lat, taskCircle.lng], { ...st, radius: Number(taskCircle.radius) }).addTo(layerExtra);
      if (enableHoverLabels) try { circle.bindTooltip("Task buffer (unsaved)", { direction: "top", sticky: true, opacity: 0.9 }); } catch {}
      const b = circle.getBounds?.(); if (b?.isValid()) bounds.extend(b);
      drew = true;
    }

    // fallback when absolutely nothing else
    if (!drew && fallbackCircle && isNum(fallbackCircle.lat) && isNum(fallbackCircle.lng) && isNum(fallbackCircle.radius)) {
      const st = normalizeStyle({ ...projectStyle, dashArray: "2,2" });
      const circle = L.circle([fallbackCircle.lat, fallbackCircle.lng], { ...st, radius: Number(fallbackCircle.radius) }).addTo(layerExtra);
      if (enableHoverLabels) try { circle.bindTooltip("Fallback area", { direction: "top", sticky: true, opacity: 0.9 }); } catch {}
      const b = circle.getBounds?.(); if (b?.isValid()) bounds.extend(b);
      drew = true;
    }

    // extra items (supports polygons, circles, polylines, points)
    drawSet(extraFences, { ...taskStyle, color: "#ef4444", fillColor: "#ef4444" }, layerExtra);

    // Fit map
    try {
      if (drew && bounds.isValid()) map.fitBounds(bounds.pad(0.15), { animate: false });
      else map.setView([0, 0], 2, { animate: false });
      setTimeout(() => { try { map.invalidateSize(false); } catch {} }, 50);
    } catch {}

  }, [
    L,
    projectFences,
    taskFences,
    taskCircle,
    fallbackCircle,
    extraFences,
    projectStyle,
    taskStyle,
    reloadKey,
    renderPointsAsCircles,
    pointRadiusMeters,
    pointPixelRadius,
    enableHoverLabels,
  ]);

  // Legend
  const Legend = () => (
    <div className="absolute right-2 top-2 bg-white/90 rounded shadow px-2 py-1 text-xs space-y-1">
      {projectId && (
        <div className="flex items-center gap-2">
          <span style={{ width: 14, height: 0, borderTop: `3px solid ${projectStyle?.color || "#1e3a8a"}` }} />
          <span>Project fences</span>
        </div>
      )}
      {taskId && (
        <div className="flex items-center gap-2">
          <span style={{ width: 14, height: 0, borderTop: `3px dashed ${taskStyle?.color || "#b45309"}` }} />
          <span>Task fences</span>
        </div>
      )}
    </div>
  );

  return (
    <div className={`relative ${className}`} style={{ height }}>
      {err ? (
        <div className="h-full w-full flex items-center justify-center text-sm text-gray-600 bg-gray-100 rounded">
          {err}
        </div>
      ) : (
        <>
          {legend && <Legend />}
          <div ref={containerRef} style={{ height: "100%", width: "100%" }} />
        </>
      )}
    </div>
  );
}
