// src/components/ProjectGeofenceUpload.jsx
import React, { useEffect, useState } from "react";
import {
  getProjectGeofences,
  uploadProjectGeofences,
  clearProjectGeofences,
} from "../lib/api";

export default function ProjectGeofenceUpload({ projectId, onUpdated }) {
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function refresh() {
    setErr("");
    try {
      const fences = await getProjectGeofences(projectId);
      setCount(Array.isArray(fences) ? fences.length : 0);
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Failed to load fences");
    }
  }

  useEffect(() => { refresh(); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [projectId]);

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setErr("");
    try {
      await uploadProjectGeofences(projectId, file);
      await refresh();
      onUpdated && onUpdated();
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Upload failed");
    } finally {
      setBusy(false);
      e.target.value = ""; // reset input
    }
  }

  async function onClear() {
    if (!window.confirm("Remove all project fences?")) return;
    setBusy(true); setErr("");
    try {
      await clearProjectGeofences(projectId);
      await refresh();
      onUpdated && onUpdated();
    } catch (e) {
      setErr(e?.response?.data?.error || e?.message || "Clear failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ fontWeight: 600 }}>Project geofences</div>
        <div style={{ fontSize: 12, color: "#6b7280" }}>
          {count} polygon{count === 1 ? "" : "s"}
        </div>
      </div>

      {err && <div style={{ color: "#b91c1c", fontSize: 13, marginTop: 8 }}>{err}</div>}

      <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label
          style={{
            border: "1px solid #d1d5db",
            borderRadius: 6,
            padding: "6px 10px",
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "Uploading…" : "Upload .geojson / .kml / .kmz"}
          <input
            type="file"
            accept=".geojson,.kml,.kmz,application/json,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz,application/zip"
            onChange={onFile}
            style={{ display: "none" }}
            disabled={busy}
          />
        </label>

        <button
          onClick={onClear}
          disabled={busy || count === 0}
          style={{
            border: "1px solid #d1d5db",
            borderRadius: 6,
            padding: "6px 10px",
            background: "white",
            cursor: busy || count === 0 ? "not-allowed" : "pointer",
            opacity: busy || count === 0 ? 0.6 : 1,
          }}
        >
          Clear fences
        </button>
      </div>

      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>
        Supports polygons only. KMZ should contain a <code>doc.kml</code> or a single KML.
      </div>
    </div>
  );
}
