// src/components/GeoFencePreview.jsx
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

export default function GeoFencePreview({
  projectId,
  taskId,
  height = 360,
  className = "",
  reloadKey,
  fitAllNonce, // bump this number to refit to all current overlays

  // Interactivity
  allowPicking = false,
  onPickLocation,

  // Visuals
  legend = false,
  showLayerToggles = true, // Project toggle shown; Task toggle hidden when taskId is set
  projectStyle = {
    color: "#1e3a8a",
    weight: 2,
    dashArray: null,
    fillColor: "#60a5fa",
    fillOpacity: 0.08,
  },
  taskStyle = {
    color: "#b40909ff",
    weight: 2,
    dashArray: "7,3",
    fillColor: "#f50b0bff",
    fillOpacity: 0.12,
  },

  // ✅ NEW: Coverage overlay (daily progress)
  showTaskCoverage = false,
  coverageStyle = {
    color: "#16a34a",
    weight: 3,
    dashArray: null,
    fillColor: "#22c55e",
    fillOpacity: 0.08,
  },
  coverageLimit = 500,

  // Extras
  fallbackCircle = null,
  taskCircle = null,
  extraFences = [],

  // Points
  renderPointsAsCircles = true,
  pointRadiusMeters = 25,
  pointPixelRadius = 5,

  // Hover tooltips (rich)
  enableHoverLabels = true,

  // Always-on labels
  labelMode = "hover", // "hover" | "always"
  labelMinZoom = null, // number | null
  labelClassName = "gf-label",

  // Optional resolvers
  overlayStyleResolver,
  hoverMetaResolver,

  // Imperative-ish camera control (safe no-op if omitted)
  // Pass { projectId, nonce: Date.now() } to zoom to a project's fences
  focusRequest,

  onLoaded,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerProjectRef = useRef(null);
  const layerTaskRef = useRef(null);
  const layerCoverageRef = useRef(null); // ✅ NEW
  const layerExtraRef = useRef(null);
  const layerPickRef = useRef(null);
  const layerLabelRef = useRef(null);

  const [L, setL] = useState(null);
  const [err, setErr] = useState("");
  const [projectFences, setProjectFences] = useState([]);
  const [taskFences, setTaskFences] = useState([]);
  const [coverageFences, setCoverageFences] = useState([]); // ✅ NEW

  // Layer visibility toggles
  const [showProject, setShowProject] = useState(true);
  const [showTask, setShowTask] = useState(true);
  const [showCoverage, setShowCoverage] = useState(true); // ✅ NEW
  // In a task view, the task layer is always visible (no toggle)
  const taskVisible = taskId ? true : showTask;
  const coverageVisible = taskId ? showCoverage : false;

  /* ----------------------------- Small URL helpers ---------------------------- */
  function apiBaseOrigin() {
    const base = api?.defaults?.baseURL || "";
    return base.replace(/\/api\/?$/i, "");
  }
  function toAbsoluteUrl(u) {
    if (!u) return "";
    const s = String(u);
    if (/^https?:\/\//i.test(s)) return s;
    if (s.startsWith("/")) return apiBaseOrigin() + s;
    return s;
  }

  /* --------------------------- KML/KMZ/GeoJSON helpers ------------------------ */
  function parseKMLToRings(kmlText) {
    try {
      const parser = new DOMParser();
      const xml = parser.parseFromString(kmlText, "application/xml");
      const coordsEls = Array.from(xml.getElementsByTagName("coordinates"));
      const rings = [];
      coordsEls.forEach((el) => {
        const raw = (el.textContent || "").trim();
        if (!raw) return;
        const pts = raw
          .split(/\s+/)
          .map((pair) => {
            const [lng, lat] = pair.split(",").slice(0, 2).map(Number);
            return [lng, lat];
          })
          .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
        if (pts.length >= 3) {
          const first = pts[0];
          const last = pts[pts.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) pts.push(first);
          rings.push(pts);
        }
      });
      return rings;
    } catch {
      return [];
    }
  }

  async function fetchAndParseKmlLike(url) {
    try {
      const abs = toAbsoluteUrl(url);
      const res = await fetch(abs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = (res.headers.get("Content-Type") || "").toLowerCase();

      if (ct.includes("kmz") || /\.kmz(\?|#|$)/i.test(abs)) {
        const blob = await res.blob();
        const { default: JSZip } = await import("jszip");
        const zip = await JSZip.loadAsync(blob);
        const kmlEntry =
          zip.file(/\.kml$/i)[0] ||
          Object.values(zip.files).find((f) => /\.kml$/i.test(f.name));
        if (!kmlEntry) return [];
        const kmlText = await kmlEntry.async("text");
        const rings = parseKMLToRings(kmlText);
        return rings.map((r) => ({ type: "polygon", polygon: r }));
      }

      const kmlText = await res.text();
      const rings = parseKMLToRings(kmlText);
      return rings.map((r) => ({ type: "polygon", polygon: r }));
    } catch {
      return [];
    }
  }

  function geoJSONToFences(geo) {
    try {
      if (!geo) return [];
      const polys =
        geo.type === "Polygon"
          ? [geo.coordinates]
          : geo.type === "MultiPolygon"
            ? geo.coordinates
            : null;
      if (!polys) return [];
      const out = [];
      polys.forEach((poly) => {
        const outer = Array.isArray(poly?.[0]) ? poly[0] : null;
        if (!outer || outer.length < 3) return;
        const ring = outer
          .map(([lng, lat]) => [Number(lng), Number(lat)])
          .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat));
        if (ring.length >= 3) {
          const first = ring[0];
          const last = ring[ring.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
          out.push({ type: "polygon", polygon: ring });
        }
      });
      return out;
    } catch {
      return [];
    }
  }

  // ✅ NEW: GeoJSON (Line/Polygon) => fences (polyline/polygon)
  function geoJSONGeometryToFences(geom, meta = {}) {
    try {
      if (!geom) return [];
      // unwrap Feature
      if (geom.type === "Feature" && geom.geometry) {
        return geoJSONGeometryToFences(geom.geometry, {
          ...meta,
          ...(geom.properties
            ? { meta: { ...(meta?.meta || {}), ...geom.properties } }
            : {}),
        });
      }
      // FeatureCollection
      if (geom.type === "FeatureCollection" && Array.isArray(geom.features)) {
        return geom.features.flatMap((f) => geoJSONGeometryToFences(f, meta));
      }

      const t = String(geom.type || "").toLowerCase();

      const closeRing = (ring) => {
        if (!Array.isArray(ring) || ring.length < 3) return ring || [];
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (!first || !last) return ring;
        if (first[0] !== last[0] || first[1] !== last[1])
          return [...ring, first];
        return ring;
      };

      const toLngLatRing = (arr) =>
        (arr || [])
          .map((p) =>
            Array.isArray(p) && p.length >= 2
              ? [Number(p[0]), Number(p[1])]
              : null,
          )
          .filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));

      const mk = (obj) => ({
        ...obj,
        meta: { ...(meta?.meta || {}), ...(obj?.meta || {}) },
      });

      if (t === "linestring") {
        const line = (geom.coordinates || [])
          .map((p) =>
            Array.isArray(p) && p.length >= 2
              ? [Number(p[0]), Number(p[1])]
              : null,
          )
          .filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        if (line.length >= 2) return [mk({ type: "polyline", path: line })];
        return [];
      }

      if (t === "multilinestring") {
        const lines = Array.isArray(geom.coordinates) ? geom.coordinates : [];
        return lines
          .map((ln) =>
            (ln || [])
              .map((p) =>
                Array.isArray(p) && p.length >= 2
                  ? [Number(p[0]), Number(p[1])]
                  : null,
              )
              .filter(
                (p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]),
              ),
          )
          .filter((ln) => ln.length >= 2)
          .map((ln) => mk({ type: "polyline", path: ln }));
      }

      if (t === "polygon") {
        const outer = Array.isArray(geom.coordinates?.[0])
          ? geom.coordinates[0]
          : null;
        if (!outer) return [];
        const ring = closeRing(toLngLatRing(outer));
        if (ring.length >= 3) return [mk({ type: "polygon", polygon: ring })];
        return [];
      }

      if (t === "multipolygon") {
        const polys = Array.isArray(geom.coordinates) ? geom.coordinates : [];
        const out = [];
        polys.forEach((poly) => {
          const outer = Array.isArray(poly?.[0]) ? poly[0] : null;
          if (!outer) return;
          const ring = closeRing(toLngLatRing(outer));
          if (ring.length >= 3)
            out.push(mk({ type: "polygon", polygon: ring }));
        });
        return out;
      }

      // Point support (rare for coverage but safe)
      if (
        t === "point" &&
        Array.isArray(geom.coordinates) &&
        geom.coordinates.length >= 2
      ) {
        const lng = Number(geom.coordinates[0]);
        const lat = Number(geom.coordinates[1]);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return [mk({ type: "point", lat, lng })];
        }
      }

      return [];
    } catch {
      return [];
    }
  }

  /* -------------------------------- Soft-load Leaflet -------------------------------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await import("leaflet");
        await import("leaflet/dist/leaflet.css");
        if (!cancelled) setL(mod);
      } catch {
        if (!cancelled)
          setErr("Map preview unavailable (Leaflet not installed).");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* ------------------------------ Fetch fences (project) ------------------------------ */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!projectId) {
        setProjectFences([]);
        return;
      }
      try {
        const { data } = await api.get(`/projects/${projectId}/geofences`, {
          headers: { "cache-control": "no-cache" },
        });

        const list = Array.isArray(data?.geoFences)
          ? data.geoFences
          : Array.isArray(data?.fences)
            ? data.fences
            : Array.isArray(data)
              ? data
              : [];

        let merged = [...list];
        if (data?.geoJSON)
          merged = merged.concat(geoJSONToFences(data.geoJSON));
        if (data?.kmlRef?.url)
          merged = merged.concat(await fetchAndParseKmlLike(data.kmlRef.url));

        if (!cancelled) setProjectFences(merged);
      } catch {
        if (!cancelled) setProjectFences([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  /* -------------------------------- Fetch fences (task) -------------------------------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!taskId) {
        setTaskFences([]);
        return;
      }
      try {
        const { data } = await api.get(`/tasks/${taskId}/geofences`, {
          headers: { "cache-control": "no-cache" },
        });

        const list = Array.isArray(data?.geoFences)
          ? data.geoFences
          : Array.isArray(data?.fences)
            ? data.fences
            : Array.isArray(data)
              ? data
              : [];

        let merged = [...list];
        if (data?.geoJSON)
          merged = merged.concat(geoJSONToFences(data.geoJSON));
        if (data?.kmlRef?.url)
          merged = merged.concat(await fetchAndParseKmlLike(data.kmlRef.url));

        if (!cancelled) setTaskFences(merged);
      } catch {
        if (!cancelled) setTaskFences([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, reloadKey]);

  /* -------------------------- ✅ NEW: Fetch task coverage -------------------------- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!taskId || !showTaskCoverage) {
        setCoverageFences([]);
        return;
      }
      try {
        const { data } = await api.get(`/tasks/${taskId}/coverage`, {
          params: { limit: coverageLimit, _ts: Date.now() },
          headers: { "cache-control": "no-cache" },
        });

        const list = Array.isArray(data?.items)
          ? data.items
          : Array.isArray(data?.rows)
            ? data.rows
            : Array.isArray(data)
              ? data
              : [];

        const fences = [];
        list.forEach((c, idx) => {
          let geom =
            c?.geometry ||
            c?.geojson ||
            c?.geoJSON ||
            (c?.feature && c.feature.geometry) ||
            null;

          // normalize Feature wrapper
          if (geom && geom.type === "Feature" && geom.geometry)
            geom = geom.geometry;

          const when = c?.date || c?.createdAt || null;
          const day = when ? new Date(when).toLocaleDateString() : "";
          const label =
            c?.note ||
            c?.title ||
            c?.name ||
            c?.filename ||
            (day ? `Coverage ${day}` : `Coverage ${idx + 1}`);

          const meta = {
            meta: {
              label,
              kind: "task-coverage",
              taskId: String(taskId),
              date: c?.date || null,
              source: c?.source || null,
              _id: c?._id || c?.id || null,
            },
          };

          const converted = geoJSONGeometryToFences(geom, meta);
          converted.forEach((f) => fences.push(f));
        });

        if (!cancelled) setCoverageFences(fences);
      } catch {
        if (!cancelled) setCoverageFences([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [taskId, showTaskCoverage, coverageLimit, reloadKey]);

  useEffect(() => {
    onLoaded?.({ projectFences, taskFences, coverageFences });
  }, [onLoaded, projectFences, taskFences, coverageFences]);

  /* ---------------------------------- Draw helpers ---------------------------------- */
  const isNum = (n) => Number.isFinite(typeof n === "string" ? Number(n) : n);
  const toLatLngPair = (pt) => {
    if (!pt) return null;
    if (Array.isArray(pt) && pt.length >= 2) {
      const lng = Number(pt[0]);
      const lat = Number(pt[1]);
      if (isNum(lat) && isNum(lng)) return [lat, lng];
    } else if (typeof pt === "object") {
      const lat = Number(pt.lat);
      const lng = Number(pt.lng);
      if (isNum(lat) && isNum(lng)) return [lat, lng];
    }
    return null;
  };
  const normalizePolygonLatLng = (polyOrObj) => {
    let poly = polyOrObj;
    if (poly && poly.coordinates) poly = poly.coordinates;

    // GeoJSON Polygon: coordinates = [ [ [lng,lat], ... ] , holes... ]
    // GeoJSON MultiPolygon: coordinates = [ [ [ [lng,lat] ... ] ] , ... ]
    if (
      Array.isArray(poly) &&
      Array.isArray(poly[0]) &&
      Array.isArray(poly[0][0]) &&
      Array.isArray(poly[0][0][0])
    ) {
      poly = poly[0]; // MultiPolygon -> first polygon
    }

    if (!Array.isArray(poly)) return null;
    const ring =
      Array.isArray(poly[0]) &&
      (Array.isArray(poly[0][0]) || typeof poly[0][0] === "object")
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
    const center = (() => {
      if (f?.center) {
        const pair = toLatLngPair(f.center);
        if (pair) return { lat: pair[0], lng: pair[1] };
      }
      if (f?.point) {
        const pair = toLatLngPair(f.point);
        if (pair) return { lat: pair[0], lng: pair[1] };
      }
      if (isNum(f?.lat) && isNum(f?.lng))
        return { lat: Number(f.lat), lng: Number(f.lng) };
      return null;
    })();
    const r = isNum(f?.radius)
      ? Number(f.radius)
      : isNum(f?.radiusMeters)
        ? Number(f.radiusMeters)
        : null;
    return (String(f?.type).toLowerCase() === "circle" ||
      f?.kind === "circle") &&
      center &&
      isNum(r)
      ? { lat: center.lat, lng: center.lng, radius: r }
      : null;
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
    if (String(f?.type).toLowerCase() === "point") {
      const pair = toLatLngPair(f.coordinates || f.point);
      if (pair) return { lat: pair[0], lng: pair[1] };
    }
    if (isNum(f?.lat) && isNum(f?.lng))
      return { lat: Number(f.lat), lng: Number(f.lng) };
    if (f?.geometry && String(f.geometry.type).toLowerCase() === "point") {
      const pair = toLatLngPair(f.geometry.coordinates);
      if (pair) return { lat: pair[0], lng: pair[1] };
    }
    return null;
  };
  const resolvePointRadiusMeters = (feature) => {
    const cand =
      feature?.pointRadiusMeters ??
      feature?.bufferMeters ??
      feature?.radius ??
      feature?.radiusMeters;
    const n = Number(cand);
    return Number.isFinite(n) ? n : Number(pointRadiusMeters) || 25;
  };

  /* ===== Status-aware colour helpers (RAG) ===== */
  const HEX = {
    red: "#ef4444",
    amber: "#f59e0b",
    green: "#10b981",
    gray: "#6b7280",
  };
  const rgba = (hex, a = 0.18) => {
    const m = String(hex || "").replace("#", "");
    if (m.length !== 6) return `rgba(0,0,0,${a})`;
    const r = parseInt(m.slice(0, 2), 16),
      g = parseInt(m.slice(2, 4), 16),
      b = parseInt(m.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  };
  function statusFromOverlay(overlay) {
    const s = String(
      overlay?.meta?.status ?? overlay?.status ?? overlay?.meta?.rag ?? "",
    ).toLowerCase();
    return s;
  }
  function statusStyle(overlay) {
    const s = statusFromOverlay(overlay);
    if (!s) return {};
    if (/\b(fail|critical|overdue|iod|problem)\b/.test(s)) {
      return {
        color: HEX.red,
        fillColor: rgba(HEX.red, 0.12),
        className: "gf-critical-pulse",
      };
    }
    if (/\b(paused|maintenance|blocked|hold)\b/.test(s)) {
      return {
        color: HEX.amber,
        fillColor: rgba(HEX.amber, 0.12),
        dashArray: "6,6",
      };
    }
    if (/\b(finished|closed|pass|healthy|active|started|open)\b/.test(s)) {
      return { color: HEX.green, fillColor: rgba(HEX.green, 0.12) };
    }
    return {};
  }

  /* ------------------------------------- Init map ------------------------------------ */
  useEffect(() => {
    if (!L || !containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: [0, 0],
      zoom: 2,
      preferCanvas: true,
      zoomControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 20,
    }).addTo(map);

    layerProjectRef.current = L.layerGroup().addTo(map);
    layerTaskRef.current = L.layerGroup().addTo(map);
    layerCoverageRef.current = L.layerGroup().addTo(map); // ✅ NEW
    layerExtraRef.current = L.layerGroup().addTo(map);
    layerPickRef.current = L.layerGroup().addTo(map);
    layerLabelRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    if (allowPicking) {
      map.on("click", (e) => {
        const lat = e?.latlng?.lat;
        const lng = e?.latlng?.lng;
        if (!isNum(lat) || !isNum(lng)) return;
        try {
          const pick = layerPickRef.current;
          pick.clearLayers();
          const dot = L.circleMarker([lat, lng], {
            radius: pointPixelRadius,
            color: "#111",
            weight: 1,
            fillColor: "#111",
            fillOpacity: 1,
          }).addTo(pick);
          if (enableHoverLabels)
            dot.bindTooltip("Picked location", {
              direction: "top",
              sticky: true,
              opacity: 0.95,
            });
        } catch {}
        onPickLocation?.({ lat, lng });
      });
    }

    setTimeout(() => {
      try {
        map.invalidateSize(false);
      } catch {}
    }, 50);
  }, [L, allowPicking, onPickLocation, pointPixelRadius, enableHoverLabels]);

  // Add/remove layer groups based on toggles
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const lp = layerProjectRef.current;
    const lt = layerTaskRef.current;
    const lc = layerCoverageRef.current;

    if (lp) {
      if (showProject && !map.hasLayer(lp)) map.addLayer(lp);
      if (!showProject && map.hasLayer(lp)) map.removeLayer(lp);
    }
    if (lt) {
      if (taskVisible && !map.hasLayer(lt)) map.addLayer(lt);
      if (!taskVisible && map.hasLayer(lt)) map.removeLayer(lt);
    }
    if (lc) {
      // coverage is only meaningful in task context
      const want = taskId && showTaskCoverage && coverageVisible;
      if (want && !map.hasLayer(lc)) map.addLayer(lc);
      if (!want && map.hasLayer(lc)) map.removeLayer(lc);
    }
  }, [showProject, taskVisible, taskId, showTaskCoverage, coverageVisible]);

  /* ------------------------------------- Style helpers -------------------------------- */
  function normalizeStyle(s) {
    return {
      color: s?.color ?? "#000",
      weight: Number.isFinite(Number(s?.weight)) ? Number(s.weight) : 2,
      dashArray: s?.dashArray ?? null,
      fillColor: s?.fillColor ?? s?.color ?? "#000",
      fillOpacity: Number.isFinite(Number(s?.fillOpacity))
        ? Number(s.fillOpacity)
        : 0.1,
      className: s?.className || undefined,
    };
  }
  function styleFromOverlay(overlay, baseStyle) {
    const base = normalizeStyle(baseStyle);
    const fromResolver = overlayStyleResolver
      ? overlayStyleResolver(overlay) || {}
      : {};
    const o = overlay?.style || {};
    const color =
      fromResolver.color ||
      o.stroke ||
      o.color ||
      overlay?.meta?.color ||
      base.color;
    const fillColor =
      fromResolver.fillColor ||
      o.fill ||
      o.fillColor ||
      overlay?.meta?.color ||
      base.fillColor;
    const weight = Number.isFinite(fromResolver.weight)
      ? fromResolver.weight
      : Number.isFinite(o.strokeWidth)
        ? Number(o.strokeWidth)
        : base.weight;
    const dashArray = fromResolver.dashArray ?? o.dashArray ?? base.dashArray;
    const fillOpacity = Number.isFinite(fromResolver.fillOpacity)
      ? fromResolver.fillOpacity
      : Number.isFinite(o.fillOpacity)
        ? Number(o.fillOpacity)
        : base.fillOpacity;
    const className = fromResolver.className ?? o.className ?? base.className;

    const stat = statusStyle(overlay);
    return {
      color: stat.color ?? color,
      fillColor: stat.fillColor ?? fillColor,
      weight,
      dashArray: stat.dashArray ?? dashArray,
      fillOpacity,
      className: stat.className ?? className,
    };
  }

  /* --------------------------------- Labels & visibility -------------------------------- */
  const baseTooltip = (f) =>
    f?.meta?.label || f?.title || f?.name || f?.label || null;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const update = () => {
      const group = layerLabelRef.current;
      if (!group) return;

      if (labelMode !== "always") {
        if (map.hasLayer(group)) map.removeLayer(group);
        return;
      }
      if (labelMinZoom != null && Number.isFinite(Number(labelMinZoom))) {
        const ok = map.getZoom() >= Number(labelMinZoom);
        if (ok) {
          if (!map.hasLayer(group)) map.addLayer(group);
        } else {
          if (map.hasLayer(group)) map.removeLayer(group);
        }
      } else {
        if (!map.hasLayer(group)) map.addLayer(group);
      }
    };

    map.on("zoomend", update);
    setTimeout(update, 0);
    return () => {
      map.off("zoomend", update);
    };
  }, [labelMode, labelMinZoom]);

  /* -------------------------------------- Draw layers ---------------------------------- */
  useEffect(() => {
    if (
      !L ||
      !mapRef.current ||
      !layerProjectRef.current ||
      !layerTaskRef.current ||
      !layerCoverageRef.current ||
      !layerExtraRef.current ||
      !layerLabelRef.current
    )
      return;

    const map = mapRef.current;
    const lp = layerProjectRef.current;
    const lt = layerTaskRef.current;
    const lc = layerCoverageRef.current; // ✅ NEW
    const lx = layerExtraRef.current;
    const lbl = layerLabelRef.current;

    lp.clearLayers();
    lt.clearLayers();
    lc.clearLayers();
    lx.clearLayers();
    lbl.clearLayers();

    const bounds = L.latLngBounds([]);
    let drew = false;

    const makeHoverHtml = (overlay) => {
      const meta = hoverMetaResolver ? hoverMetaResolver(overlay) : null;
      if (!meta) {
        const label = baseTooltip(overlay);
        return label ? `<div>${String(label)}</div>` : null;
      }
      const rows = [
        `<div><strong>${meta.taskName || baseTooltip(overlay) || "Task"}</strong></div>`,
        meta.assigneeName ? `<div>Assignee: ${meta.assigneeName}</div>` : "",
        meta.status ? `<div>Status: ${meta.status}</div>` : "",
        meta.due ? `<div>Due: ${meta.due}</div>` : "",
      ].filter(Boolean);
      return rows.length ? rows.join("") : null;
    };

    const bindHoverTooltip = (layer, overlay) => {
      if (!enableHoverLabels || !layer?.bindTooltip) return;
      const html = makeHoverHtml(overlay);
      if (!html) return;
      try {
        layer.bindTooltip(html, {
          direction: "top",
          sticky: true,
          opacity: 0.95,
          className: "leaflet-tooltip",
        });
      } catch {}
    };

    const addPermanentLabelAt = (latlng, text) => {
      if (!text || !latlng) return;
      try {
        const tip = L.tooltip({
          permanent: true,
          direction: "top",
          opacity: 0.9,
          className: `leaflet-tooltip ${labelClassName || ""}`,
          interactive: false,
          offset: [0, -6],
        })
          .setLatLng(latlng)
          .setContent(String(text));
        lbl.addLayer(tip);
      } catch {}
    };

    const drawSet = (
      fences,
      baseStyle,
      targetLayer,
      perFeature = false,
      includeInBounds = true,
    ) => {
      for (const f of fences || []) {
        const st = perFeature
          ? styleFromOverlay(f, baseStyle)
          : normalizeStyle(baseStyle);
        const type = String(
          f?.type || f?.kind || f?.geometry?.type || "",
        ).toLowerCase();
        const name = baseTooltip(f);

        // Polygon
        if (
          type === "polygon" ||
          f?.polygon ||
          (f?.geometry && String(f.geometry.type).toLowerCase() === "polygon")
        ) {
          const latlngs = normalizePolygonLatLng(
            f.polygon || f.geometry || f.coordinates,
          );
          if (latlngs) {
            const poly = L.polygon(latlngs, st).addTo(targetLayer);
            bindHoverTooltip(poly, f);
            if (labelMode === "always" && name) {
              try {
                addPermanentLabelAt(poly.getBounds().getCenter(), name);
              } catch {}
            }
            const b = poly.getBounds?.();
            if (includeInBounds && b?.isValid()) bounds.extend(b);
            drew = true;
            continue;
          }
        }

        // Circle
        if (type === "circle" || f?.radius || f?.radiusMeters) {
          const c = toCircle(f);
          if (c) {
            const circle = L.circle([c.lat, c.lng], {
              ...st,
              radius: c.radius,
            }).addTo(targetLayer);
            bindHoverTooltip(circle, f);
            if (labelMode === "always" && name) {
              try {
                addPermanentLabelAt(circle.getLatLng(), name);
              } catch {}
            }
            const b = circle.getBounds?.();
            if (includeInBounds && b?.isValid()) bounds.extend(b);
            drew = true;
            continue;
          }
        }

        // Line / Polyline (including GeoJSON LineString)
        if (
          type === "line" ||
          type === "polyline" ||
          type === "linestring" ||
          Array.isArray(f?.line) ||
          Array.isArray(f?.path) ||
          (f?.geometry && /linestring/i.test(String(f.geometry.type)))
        ) {
          const latlngs = toPolyline(
            f?.geometry &&
              /linestring/i.test(String(f.geometry.type)) &&
              Array.isArray(f.geometry.coordinates)
              ? { type: "polyline", path: f.geometry.coordinates }
              : f,
          );
          if (latlngs) {
            const pl = L.polyline(latlngs, st).addTo(targetLayer);
            bindHoverTooltip(pl, f);
            if (labelMode === "always" && name) {
              try {
                addPermanentLabelAt(pl.getBounds().getCenter(), name);
              } catch {}
            }
            const b = pl.getBounds?.();
            if (includeInBounds && b?.isValid()) bounds.extend(b);
            drew = true;
            continue;
          }
        }

        // Point
        const pt = toPoint(f);
        if (pt) {
          const dot = L.circleMarker([pt.lat, pt.lng], {
            radius: pointPixelRadius,
            color: st.color,
            weight: 1,
            fillColor: st.color,
            fillOpacity: 1,
            className: st.className,
          }).addTo(targetLayer);
          bindHoverTooltip(dot, f);
          if (labelMode === "always" && name) {
            try {
              addPermanentLabelAt(dot.getLatLng(), name);
            } catch {}
          }
          let b = dot.getLatLng ? L.latLngBounds([dot.getLatLng()]) : null;
          if (renderPointsAsCircles) {
            const r = resolvePointRadiusMeters(f);
            const circle = L.circle([pt.lat, pt.lng], {
              ...st,
              radius: r,
            }).addTo(targetLayer);
            bindHoverTooltip(circle, f);
            const cb = circle.getBounds?.();
            if (cb?.isValid()) b = b ? b.extend(cb) : cb;
          }
          if (includeInBounds && b?.isValid()) bounds.extend(b);
          drew = true;
          continue;
        }
      }
    };

    // Base layers (respect visibility)
    if (showProject) drawSet(projectFences, projectStyle, lp, false, true);
    if (taskVisible) drawSet(taskFences, taskStyle, lt, false, true);

    // ✅ Coverage layer (overlays base task fence; does NOT replace it)
    if (taskId && showTaskCoverage && coverageVisible) {
      drawSet(
        coverageFences,
        coverageStyle,
        lc,
        true, // perFeature styling allowed
        true,
      );
    }

    // Live circle respects taskVisible now
    if (
      taskVisible &&
      taskCircle &&
      isNum(taskCircle.lat) &&
      isNum(taskCircle.lng) &&
      isNum(taskCircle.radius)
    ) {
      const st = normalizeStyle({ ...taskStyle, dashArray: "2,4" });
      const circle = L.circle([taskCircle.lat, taskCircle.lng], {
        ...st,
        radius: Number(taskCircle.radius),
      }).addTo(lx);
      bindHoverTooltip(circle, { meta: { label: "Task buffer (unsaved)" } });
      if (labelMode === "always") {
        try {
          addPermanentLabelAt(circle.getLatLng(), "Task buffer");
        } catch {}
      }
      const b = circle.getBounds?.();
      if (b?.isValid()) bounds.extend(b);
      drew = true;
    }

    // Extra overlays (status-aware per feature)
    drawSet(
      extraFences,
      { color: "#ef4444", fillColor: "#ef4444", weight: 2, fillOpacity: 0.15 },
      lx,
      true,
      true,
    );

    // Fallback
    if (
      !drew &&
      fallbackCircle &&
      isNum(fallbackCircle.lat) &&
      isNum(fallbackCircle.lng) &&
      isNum(fallbackCircle.radius)
    ) {
      const st = normalizeStyle({ ...projectStyle, dashArray: "2,2" });
      const circle = L.circle([fallbackCircle.lat, fallbackCircle.lng], {
        ...st,
        radius: Number(fallbackCircle.radius),
      }).addTo(lx);
      bindHoverTooltip(circle, { meta: { label: "Fallback area" } });
      if (labelMode === "always") {
        try {
          addPermanentLabelAt(circle.getLatLng(), "Fallback area");
        } catch {}
      }
      const b = circle.getBounds?.();
      if (b?.isValid()) bounds.extend(b);
      drew = true;
    }

    try {
      if (drew && bounds.isValid())
        map.fitBounds(bounds.pad(0.15), { animate: false });
      else map.setView([0, 0], 2, { animate: false });
      setTimeout(() => {
        try {
          map.invalidateSize(false);
        } catch {}
      }, 50);
    } catch {}

    // enforce labelMinZoom immediately
    (function enforce() {
      const lbl = layerLabelRef.current;
      if (!lbl) return;
      if (labelMode !== "always") {
        if (map.hasLayer(lbl)) map.removeLayer(lbl);
        return;
      }
      if (labelMinZoom != null && Number.isFinite(Number(labelMinZoom))) {
        const ok = map.getZoom() >= Number(labelMinZoom);
        if (ok) {
          if (!map.hasLayer(lbl)) map.addLayer(lbl);
        } else {
          if (map.hasLayer(lbl)) map.removeLayer(lbl);
        }
      } else {
        if (!map.hasLayer(lbl)) map.addLayer(lbl);
      }
    })();
  }, [
    L,
    projectFences,
    taskFences,
    coverageFences,
    taskCircle,
    fallbackCircle,
    extraFences,
    projectStyle,
    taskStyle,
    coverageStyle,
    reloadKey,
    renderPointsAsCircles,
    pointRadiusMeters,
    pointPixelRadius,
    enableHoverLabels,
    overlayStyleResolver,
    hoverMetaResolver,
    labelMode,
    labelMinZoom,
    labelClassName,
    showProject,
    taskVisible,
    taskId,
    showTaskCoverage,
    coverageVisible,
  ]);

  /* --------------------------- Focus request (zoom to project) --------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !L || !focusRequest) return;

    const pid = String(focusRequest.projectId || "");
    if (!pid) return;

    const candidates = (extraFences || []).filter(
      (f) => String(f?.meta?.projectId || "") === pid,
    );
    const useFences = candidates.length
      ? candidates
      : String(projectId || "") === pid
        ? projectFences
        : [];

    if (!useFences.length) return;

    try {
      const b = L.latLngBounds([]);
      for (const f of useFences) {
        const type = String(
          f?.type || f?.kind || f?.geometry?.type || "",
        ).toLowerCase();
        if (
          type === "polygon" ||
          f?.polygon ||
          (f?.geometry && f.geometry.type === "Polygon")
        ) {
          const latlngs = normalizePolygonLatLng(
            f.polygon || f.geometry || f.coordinates,
          );
          if (latlngs && latlngs.length) b.extend(latlngs);
          continue;
        }
        if (
          type === "line" ||
          type === "polyline" ||
          Array.isArray(f?.line) ||
          Array.isArray(f?.path)
        ) {
          const latlngs = toPolyline(f);
          if (latlngs && latlngs.length) b.extend(latlngs);
          continue;
        }
        const c = toCircle(f);
        if (c) {
          const circle = L.circle([c.lat, c.lng], { radius: c.radius });
          const cb = circle.getBounds?.();
          if (cb?.isValid()) b.extend(cb);
          continue;
        }
        const pt = toPoint(f);
        if (pt) b.extend([[pt.lat, pt.lng]]);
      }
      if (b.isValid()) map.fitBounds(b.pad(0.2), { animate: true });
    } catch {
      /* ignore */
    }
  }, [focusRequest, L, extraFences, projectFences, projectId]);

  /* --------------------------- Refit-to-all on demand --------------------------- */
  useEffect(() => {
    const map = mapRef.current;
    const lp = layerProjectRef.current;
    const lt = layerTaskRef.current;
    const lc = layerCoverageRef.current;
    const lx = layerExtraRef.current;
    if (!L || !map || !lp || !lt || !lc || !lx) return;

    try {
      const bounds = L.latLngBounds([]);
      [lp, lt, lc, lx].forEach((group) => {
        group.eachLayer((layer) => {
          if (layer?.getBounds?.() && layer.getBounds().isValid()) {
            bounds.extend(layer.getBounds());
          } else if (layer?.getLatLng?.()) {
            bounds.extend(L.latLngBounds([layer.getLatLng()]));
          }
        });
      });
      if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.15), { animate: false });
        setTimeout(() => {
          try {
            map.invalidateSize(false);
          } catch {}
        }, 50);
      }
    } catch {
      /* ignore */
    }
  }, [fitAllNonce, L]);

  /* -------------------------------------- Legend -------------------------------------- */
  const Swatch = ({ stroke, fill, dashed }) => (
    <span className="inline-flex items-center gap-1">
      <span
        style={{
          display: "inline-block",
          width: 12,
          height: 12,
          background: fill || stroke,
          border: `2px solid ${stroke || "#000"}`,
          borderRadius: 3,
        }}
      />
      <span
        style={{
          width: 16,
          height: 0,
          borderTop: dashed
            ? `3px dashed ${stroke || "#000"}`
            : `3px solid ${stroke || "#000"}`,
        }}
      />
    </span>
  );

  const Legend = () => (
    <div className="absolute right-2 top-2 bg-white/95 rounded-lg shadow px-3 py-2 text-xs space-y-1 border border-gray-200">
      {projectId && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Swatch
              stroke={projectStyle?.color}
              fill={projectStyle?.fillColor}
            />
            <span className="truncate">Project fences</span>
            <span className="text-[11px] text-gray-500">
              ({projectFences.length})
            </span>
          </div>
          {showLayerToggles && (
            <label className="ml-2 inline-flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={showProject}
                onChange={(e) => setShowProject(e.target.checked)}
              />
              <span>Show</span>
            </label>
          )}
        </div>
      )}

      {taskId && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Swatch
              stroke={taskStyle?.color}
              fill={taskStyle?.fillColor}
              dashed
            />
            <span className="truncate">Task work-area fence</span>
            <span className="text-[11px] text-gray-500">
              ({taskFences.length})
            </span>
          </div>
        </div>
      )}

      {taskId && showTaskCoverage && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Swatch
              stroke={coverageStyle?.color}
              fill={coverageStyle?.fillColor}
            />
            <span className="truncate">Daily progress (coverage)</span>
            <span className="text-[11px] text-gray-500">
              ({coverageFences.length})
            </span>
          </div>
          {showLayerToggles && (
            <label className="ml-2 inline-flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={showCoverage}
                onChange={(e) => setShowCoverage(e.target.checked)}
              />
              <span>Show</span>
            </label>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className={`relative z-0 ${className}`} style={{ height }}>
      <style>{`
        @keyframes gfPulseStroke { 0%{stroke-opacity:1;} 50%{stroke-opacity:0.35;} 100%{stroke-opacity:1;} }
        @keyframes gfPulseFill   { 0%{fill-opacity:.16;} 50%{fill-opacity:.05;} 100%{fill-opacity:.16;} }
        .gf-critical-pulse {
          animation: gfPulseStroke 1200ms ease-in-out infinite, gfPulseFill 1200ms ease-in-out infinite;
        }
      `}</style>

      {err ? (
        <div className="h-full w-full flex items-center justify-center text-sm text-gray-600 bg-gray-100 rounded">
          {err}
        </div>
      ) : (
        <>
          {legend && <Legend />}
          <div
            ref={containerRef}
            className="z-0"
            style={{ height: "100%", width: "100%" }}
          />
        </>
      )}
    </div>
  );
}
