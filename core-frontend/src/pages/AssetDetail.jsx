// src/pages/AssetDetail.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, fileUrl } from "../lib/api";

/* ---------------- time helpers ---------------- */
function toLocalDateTimeInput(date) {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  const off = d.getTimezoneOffset();
  const local = new Date(d.getTime() - off * 60000);
  return local.toISOString().slice(0, 16);
}
function fromLocalDateTimeInput(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/* ---------------- small helpers ---------------- */
function shortId(x) {
  const s = String(x || "");
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
function UploaderName({ att }) {
  const by =
    att?.uploadedByLabel ||
    att?.uploadedByDisplay ||
    att?.uploadedBy?.name ||
    att?.uploadedBy?.email ||
    (typeof att?.uploadedBy === "string" ? shortId(att.uploadedBy) : "");
  return <span>{by || "Unknown"}</span>;
}

/* ------------ inspection subject matching helpers ------------ */
function sameId(a, b) {
  if (a == null || b == null) return false;
  return String(a).trim() === String(b).trim();
}
function sameText(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
function isForAsset(ins, asset) {
  if (!ins || !asset) return false;

  const subj = ins.subjectAtRun || ins.subject || {};
  const links = ins.links || {};

  // Type check (be lenient)
  const typeRaw =
    subj.type ||
    subj.subjectType ||
    links.subjectType ||
    links.entityType ||
    links.scope ||
    "";
  const t = String(typeRaw).toLowerCase();
  const isAssetType =
    t === "asset" || t === "assets" || t === "asset-item" || t === "equipment";

  // Candidate IDs from multiple shapes
  const candId =
    subj.id ||
    subj.subjectId ||
    subj.assetId ||
    links.assetId ||
    links.subjectId ||
    ins.entityId ||
    ins.targetId;

  // Candidate labels/names
  const candLabel =
    subj.label ||
    subj.name ||
    subj.code ||
    ins.subjectLabel ||
    ins.subjectName ||
    ins.assetLabel;

  const matchById = sameId(candId, asset._id);
  const matchByLabel =
    sameText(candLabel, asset.name) || (asset.code && sameText(candLabel, asset.code));

  // If backend stuck id elsewhere in `by` etc.
  const altId = ins.by?.assetId || ins.meta?.assetId;
  const matchByAltId = sameId(altId, asset._id);

  return (isAssetType && (matchById || matchByLabel)) || matchByAltId;
}

/* ---------------- Leaflet mini map ---------------- */
import { MapContainer, TileLayer, CircleMarker } from "react-leaflet";
import "leaflet/dist/leaflet.css";

function LeafletPreview({ lat, lng, height = 240 }) {
  const invalid =
    lat == null ||
    lng == null ||
    lat === "" ||
    lng === "" ||
    isNaN(Number(lat)) ||
    isNaN(Number(lng));

  if (invalid) {
    return (
      <div
        className="flex items-center justify-center border rounded-lg text-sm text-gray-500 bg-white"
        style={{ width: "100%", height }}
        title="Set coordinates to preview"
      >
        Map preview
      </div>
    );
  }

  const center = [Number(lat), Number(lng)];
  const openUrl = `https://www.openstreetmap.org/?mlat=${center[0]}&mlon=${center[1]}#map=15/${center[0]}/${center[1]}`;

  return (
    <div
      className="relative border rounded-lg overflow-hidden bg-white"
      style={{ width: "100%", height }}
    >
      <MapContainer
        center={center}
        zoom={14}
        style={{ width: "100%", height: "100%" }}
        scrollWheelZoom={false}
        doubleClickZoom={false}
        dragging={false}
        zoomControl={false}
        keyboard={false}
        boxZoom={false}
        touchZoom={false}
        attributionControl={true}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> contributors'
        />
        <CircleMarker center={center} radius={8} />
      </MapContainer>
      {/* Click-through overlay */}
      <a
        href={openUrl}
        target="_blank"
        rel="noreferrer"
        className="absolute inset-0"
        title="Open in OpenStreetMap"
        aria-label="Open in OpenStreetMap"
      />
    </div>
  );
}

/* ---------------- Reusable UI bits ---------------- */
function Card({ title, children, right, className = "" }) {
  return (
    <div className={`rounded-xl border bg-white shadow-sm ${className}`}>
      {(title || right) && (
        <div className="px-3 py-2 border-b flex items-center justify-between">
          {title ? <div className="font-semibold">{title}</div> : <div />}
          {right || null}
        </div>
      )}
      <div className="p-3">{children}</div>
    </div>
  );
}

function Modal({ open, onClose, title, children, width = 860 }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center"
      style={{ background: "rgba(17,24,39,0.45)" }} // gray-900/45
      onMouseDown={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full"
        style={{ maxWidth: width, maxHeight: "90vh", overflow: "auto" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="text-lg font-semibold m-0">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="text-xl leading-none">
            ✕
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

/* ---------------- Page ---------------- */
export default function AssetDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [asset, setAsset] = useState(null);
  const [projects, setProjects] = useState([]);

  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [saving, setSaving] = useState(false);

  // location inputs
  const [latInput, setLatInput] = useState("");
  const [lngInput, setLngInput] = useState("");

  // ambient coords for log/attachments (auto-gathered quietly)
  const [ambientPos, setAmbientPos] = useState({ lat: null, lng: null, acc: null });

  // attachments
  const [file, setFile] = useState(null);
  const [fileNote, setFileNote] = useState("");
  const [fileErr, setFileErr] = useState("");

  // label options
  const [labelSize, setLabelSize] = useState("small");
  const [includeQR, setIncludeQR] = useState(true);
  const [includeBar, setIncludeBar] = useState(true);

  // maintenance
  const [mForm, setMForm] = useState({ date: "", note: "" });

  // schedule
  const [schedule, setSchedule] = useState([]);
  const [schedEnabled, setSchedEnabled] = useState(true);
  const [schedForm, setSchedForm] = useState({
    at: toLocalDateTimeInput(new Date()),
    title: "",
    note: "",
  });

  // inspections
  const [inspections, setInspections] = useState([]);
  const [insLoading, setInsLoading] = useState(false);
  const [insErr, setInsErr] = useState("");
  const [previewInspection, setPreviewInspection] = useState(null);

  // scanned context from URL (no new hook imports)
  const scannedContext = (() => {
    try {
      const q = new URLSearchParams(window.location.search);
      const v = (q.get("scanned") || "").toLowerCase();
      return v === "1" || v === "true";
    } catch {
      return false;
    }
  })();

  /* ------------ loaders ------------ */
  async function load() {
    setErr("");
    setInfo("");
    try {
      const { data } = await api.get(`/assets/${id}`);
      setAsset(data || null);
      const la = data?.location?.lat ?? data?.lat;
      const lo = data?.location?.lng ?? data?.lng;
      setLatInput(la != null ? String(la) : "");
      setLngInput(lo != null ? String(lo) : "");
      return data || null; // <-- allow caller to chain
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
      return null;
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
  async function loadSchedule() {
    try {
      const { data } = await api.get(`/assets/${id}/schedule`);
      if (Array.isArray(data)) {
        setSchedule(data);
        setSchedEnabled(true);
      } else {
        setSchedule([]);
        setSchedEnabled(false);
      }
    } catch {
      setSchedEnabled(false);
    }
  }

  // --------- UPDATED: pull inspection SUBMISSIONS by subject (with fallbacks) ---------
  async function loadInspections(assetSnapshot) {
    setInsLoading(true);
    setInsErr("");
    try {
      const normalize = (r) =>
        Array.isArray(r?.data?.items)
          ? r.data.items
          : Array.isArray(r?.data?.results)
          ? r.data.results
          : Array.isArray(r?.data)
          ? r.data
          : [];

      const attempts = [
        { url: "/inspection-submissions", params: { subjectType: "asset", subjectId: id, limit: 400 } },
        { url: "/inspectionsubmissions", params: { subjectType: "asset", subjectId: id, limit: 400 } },
        { url: "/inspection-submissions", params: { subject: id, limit: 400 } }, // some APIs accept subject=<id>
        // Legacy/compat fallbacks:
        { url: "/inspections", params: { assetId: id, limit: 400 } },
        { url: "/inspections", params: { entityId: id, entityType: "asset", limit: 400 } },
        { url: "/inspections", params: { targetId: id, scope: "asset", limit: 400 } },
      ];

      let arr = [];
      for (const t of attempts) {
        try {
          const resp = await api.get(t.url, { params: t.params });
          const cand = normalize(resp);
          if (cand?.length) {
            arr = cand;
            break;
          }
        } catch {
          /* keep trying */
        }
      }

      // Filter strictly to this asset (handles mixed backends)
      const snap = assetSnapshot || asset;
      if (snap) arr = arr.filter((ins) => isForAsset(ins, snap));

      // Newest first; prefer submittedAt/completedAt
      arr.sort(
        (a, b) =>
          new Date(b.submittedAt || b.completedAt || b.createdAt || 0) -
          new Date(a.submittedAt || a.completedAt || a.createdAt || 0)
      );

      setInspections(arr);
    } catch (e) {
      setInsErr(e?.response?.data?.error || String(e));
    } finally {
      setInsLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      const a = await load(); // ensure we have the asset snapshot
      await loadProjects();
      await loadSchedule();
      await loadInspections(a); // pass snapshot so subject filter works immediately
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // quietly capture ambient geolocation for logs/attachments
  useEffect(() => {
    if (!navigator.geolocation) return;
    const opts = { enableHighAccuracy: true, maximumAge: 15000, timeout: 10000 };
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const la = Number(pos.coords.latitude?.toFixed(6));
        const lo = Number(pos.coords.longitude?.toFixed(6));
        const ac = Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null;
        setAmbientPos({ lat: la, lng: lo, acc: ac });
      },
      () => {}, // silent fail
      opts
    );
  }, []);

  const projName = useMemo(() => {
    if (!asset?.projectId) return "—";
    const p = projects.find((x) => String(x._id) === String(asset.projectId));
    return p?.name || String(asset.projectId);
  }, [asset, projects]);

  /* ------------ save helpers ------------ */
  async function savePatch(patch) {
    setSaving(true);
    setErr("");
    try {
      const { data } = await api.put(`/assets/${id}`, patch);
      setAsset(data);
      setInfo("Saved");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally {
      setSaving(false);
    }
  }

  function n(v) {
    if (v === "" || v == null) return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  async function saveLocation(e) {
    e?.preventDefault?.();
    setErr("");
    setInfo("");
    const la = n(latInput),
      lo = n(lngInput);
    if (la == null || lo == null) return setErr("Enter valid numeric Lat & Lng");
    await savePatch({ lat: la, lng: lo });
  }
  function useMyLocation() {
    setErr("");
    if (!navigator.geolocation) return setErr("Geolocation not supported");
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const la = Number(pos.coords.latitude.toFixed(6));
        const lo = Number(pos.coords.longitude.toFixed(6));
        setLatInput(String(la));
        setLngInput(String(lo));
        await savePatch({ lat: la, lng: lo });
      },
      (ge) => setErr(ge?.message || "Failed to get current position"),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
    );
  }

  // attachments
  async function uploadPhoto(e) {
    e?.preventDefault?.();
    setFileErr("");
    setInfo("");
    try {
      if (!file) return setFileErr("Choose an image first.");
      const fd = new FormData();
      fd.append("file", file);
      if (fileNote) fd.append("note", fileNote);
      // include ambient coords + scanned flag if available
      if (ambientPos.lat != null && ambientPos.lng != null) {
        fd.append("lat", String(ambientPos.lat));
        fd.append("lng", String(ambientPos.lng));
        if (ambientPos.acc != null) fd.append("acc", String(ambientPos.acc));
      }
      if (scannedContext) fd.append("scanned", "1");

      const { data } = await api.post(`/assets/${id}/attachments`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setAsset(data);
      setFile(null);
      setFileNote("");
      setInfo("Photo uploaded.");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) {
      setFileErr(e?.response?.data?.error || String(e));
    }
  }
  async function deleteAttachment(attId) {
    if (!window.confirm("Delete this attachment?")) return;
    setErr("");
    setInfo("");
    try {
      const { data } = await api.delete(`/assets/${id}/attachments/${attId}`);
      setAsset(data);
      setInfo("Attachment deleted.");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  // maintenance
  async function addMaintenance(e) {
    e?.preventDefault?.();
    setErr("");
    setInfo("");
    try {
      const payload = {
        date: mForm.date ? fromLocalDateTimeInput(mForm.date) : undefined,
        note: (mForm.note || "").trim(),
      };
      if (ambientPos.lat != null && ambientPos.lng != null) {
        payload.lat = ambientPos.lat;
        payload.lng = ambientPos.lng;
        if (ambientPos.acc != null) payload.acc = ambientPos.acc;
      }
      if (scannedContext) payload.scanned = true;

      const { data } = await api.post(`/assets/${id}/maintenance`, payload);
      setAsset(data);
      setMForm({ date: "", note: "" });
      setInfo("Maintenance entry added.");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function delMaintenance(mid) {
    if (!window.confirm("Delete this maintenance entry?")) return;
    setErr("");
    setInfo("");
    try {
      const { data } = await api.delete(`/assets/${id}/maintenance/${mid}`);
      if (data && data._id) setAsset(data);
      else await load();
      setInfo("Maintenance entry deleted.");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  // schedule
  async function addSchedule(e) {
    e?.preventDefault?.();
    if (!schedEnabled) return;
    setErr("");
    setInfo("");
    try {
      const body = {
        at: schedForm.at ? fromLocalDateTimeInput(schedForm.at) : null,
        title: (schedForm.title || "").trim() || undefined,
        note: (schedForm.note || "").trim() || undefined,
      };
      await api.post(`/assets/${id}/schedule`, body);
      await loadSchedule();
      setSchedForm({ at: toLocalDateTimeInput(new Date()), title: "", note: "" });
      setInfo("Schedule item added.");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function delSchedule(sid) {
    if (!window.confirm("Delete this schedule item?")) return;
    setErr("");
    setInfo("");
    try {
      await api.delete(`/assets/${id}/schedule/${sid}`);
      await loadSchedule();
      setInfo("Schedule item deleted.");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  // export maintenance CSV with lat/lng/acc/scanned
  function exportMaintenanceCsv() {
    const rows = (asset?.maintenance || [])
      .slice()
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
    const header = ["date", "note", "by", "lat", "lng", "acc", "scanned", "createdAt"];
    const csv = [
      header,
      ...rows.map((m) => [
        m.date ? new Date(m.date).toISOString() : "",
        (m.note || "").replace(/\r?\n/g, " ").trim(),
        m.by || "",
        m.lat ?? "",
        m.lng ?? "",
        m.acc ?? "",
        m.scanned ? "yes" : "",
        m.createdAt ? new Date(m.createdAt).toISOString() : "",
      ]),
    ]
      .map((cols) =>
        cols
          .map((v) => {
            const s = String(v ?? "");
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(",")
      )
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `asset_${asset?._id || "log"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportKmz() {
    // use API to include auth headers; receive blob; trigger download
    api
      .get(`/assets/${id}/export-kmz`, { responseType: "blob" })
      .then(({ data }) => {
        const blob = new Blob([data], { type: "application/vnd.google-earth.kmz" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const safe = (asset?.name || asset?.code || "asset").replace(/[^\w.-]+/g, "_");
        a.href = url;
        a.download = `${safe}_geo.kmz`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch((e) => setErr(e?.response?.data?.error || String(e)));
  }

  // label printing
  function assetDeepLink() {
    try {
      return `${window.location.origin}/assets/${asset?._id}`;
    } catch {
      return `/assets/${asset?._id}`;
    }
  }
  const qrSize = labelSize === "small" ? 180 : 240;
  const barcodeScale = labelSize === "small" ? 3 : 4;
  const qrImg = includeQR
    ? `https://api.qrserver.com/v1/create-qr-code/?size=${qrSize}x${qrSize}&data=${encodeURIComponent(
        assetDeepLink()
      )}`
    : null;
  const barcodeText = asset?.code || asset?._id || "";
  const barImg =
    includeBar && barcodeText
      ? `https://bwipjs-api.metafloor.com/?bcid=code128&text=${encodeURIComponent(
          barcodeText
        )}&includetext&scale=${barcodeScale}`
      : null;

  function printLabel() {
    const w = window.open("", "_blank", "width=600,height=400");
    if (!w) return;
    const title = asset?.name || "Asset";
    const proj = projName;
    const code = asset?.code || "";
    const thumb = (asset?.attachments || [])[0]?.url || "";
    const css = `
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; margin:0; padding:12px; background:#fff;}
      .card{border:1px solid #ddd; padding:12px; border-radius:10px; width:${labelSize === "small" ? "320px" : "400px"}}
      .row{display:flex; gap:12px; align-items:center}
      .title{font-weight:600; font-size:${labelSize === "small" ? "14px" : "16px"}}
      .sub{color:#666; font-size:12px}
      img{display:block}
      .photo{width:${labelSize === "small" ? "64px" : "80px"}; height:${labelSize === "small" ? "64px" : "80px"}; object-fit:cover; border:1px solid #ddd; border-radius:8px}
      .codes{margin-top:8px; display:flex; gap:12px; align-items:center}
      .codes img{max-height:${labelSize === "small" ? "128px" : "160px"}}
      .muted{color:#777; font-size:11px; margin-top:6px; word-break:break-all}
    `;
    w.document.write(`
<!doctype html>
<html><head><meta charset="utf-8"><title>Label - ${title}</title>
<style>${css}</style></head>
<body>
  <div class="card">
    <div class="row">
      ${thumb ? `<img class="photo" src="${thumb}" alt="photo"/>` : ``}
      <div style="min-width:0">
        <div class="title">${title}</div>
        ${code ? `<div class="sub">Code: ${code}</div>` : ``}
        ${proj && proj !== "—" ? `<div class="sub">Project: ${proj}</div>` : ``}
      </div>
    </div>
    <div class="codes">
      ${qrImg ? `<img src="${qrImg}" alt="qr" />` : ``}
      ${barImg ? `<img src="${barImg}" alt="barcode" />` : ``}
    </div>
    <div class="muted">${assetDeepLink()}</div>
  </div>
  <script>window.onload = () => { setTimeout(()=>window.print(), 50); };</script>
</body></html>`);
    w.document.close();
  }

  if (!asset) {
    return <div className="max-w-7xl mx-auto p-4">{err ? err : "Loading…"}</div>;
  }

  return (
    <div className="max-w-7xl mx-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-semibold">Asset</h1>
        <div className="flex gap-2">
          <button className="px-3 py-2 border rounded" onClick={() => navigate(-1)}>
            Back
          </button>
          <button
            className="px-3 py-2 border rounded"
            onClick={async () => {
              if (!confirm("Delete this asset?")) return;
              try {
                await api.delete(`/assets/${id}`);
                navigate("/assets");
              } catch (e) {
                setErr(e?.response?.data?.error || String(e));
              }
            }}
          >
            Delete
          </button>
        </div>
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      {/* Top grid: meta + location */}
      <div className="grid md:grid-cols-2 gap-4">
        <Card title="Details" className="space-y-3">
          <label className="block text-sm">
            Name
            <input
              className="mt-1 border p-2 w-full rounded"
              value={asset.name || ""}
              onChange={(e) => setAsset((a) => ({ ...(a || {}), name: e.target.value }))}
              onBlur={() => asset.name && savePatch({ name: asset.name })}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              Code
              <input
                className="mt-1 border p-2 w-full rounded"
                value={asset.code || ""}
                onChange={(e) => setAsset((a) => ({ ...(a || {}), code: e.target.value }))}
                onBlur={() => savePatch({ code: asset.code || "" })}
              />
            </label>
            <label className="block text-sm">
              Type
              <input
                className="mt-1 border p-2 w-full rounded"
                value={asset.type || ""}
                onChange={(e) => setAsset((a) => ({ ...(a || {}), type: e.target.value }))}
                onBlur={() => savePatch({ type: asset.type || "" })}
              />
            </label>
          </div>

          <label className="block text-sm">
            Status
            <select
              className="mt-1 border p-2 w-full rounded"
              value={asset.status || "active"}
              onChange={(e) => {
                const v = e.target.value;
                setAsset((a) => ({ ...(a || {}), status: v }));
                savePatch({ status: v });
              }}
              disabled={saving}
            >
              <option value="active">active</option>
              <option value="maintenance">maintenance</option>
              <option value="retired">retired</option>
              <option value="lost">lost</option>
              <option value="stolen">stolen</option>
            </select>
          </label>

          <label className="block text-sm">
            Project
            <select
              className="mt-1 border p-2 w-full rounded"
              value={asset.projectId || ""}
              onChange={(e) => {
                const v = e.target.value;
                setAsset((a) => ({ ...(a || {}), projectId: v }));
                savePatch({ projectId: v || null });
              }}
            >
              <option value="">— none —</option>
              {projects.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </select>
            {asset.projectId && (
              <div className="mt-1 text-xs">
                Linked to:{" "}
                <Link className="underline" to={`/projects/${asset.projectId}`}>
                  {projName}
                </Link>
              </div>
            )}
          </label>

          <label className="block text-sm">
            Notes
            <textarea
              className="mt-1 border p-2 w-full rounded"
              rows={3}
              value={asset.notes || ""}
              onChange={(e) => setAsset((a) => ({ ...(a || {}), notes: e.target.value }))}
              onBlur={() => savePatch({ notes: asset.notes || "" })}
            />
          </label>

          <div className="text-sm text-gray-600">
            Created: {asset.createdAt ? new Date(asset.createdAt).toLocaleString() : "—"}
            <br />
            Updated: {asset.updatedAt ? new Date(asset.updatedAt).toLocaleString() : "—"}
          </div>
        </Card>

        <Card title="Location">
          <form onSubmit={saveLocation} className="grid md:grid-cols-2 gap-3">
            <label className="text-sm">
              Lat
              <input
                className="mt-1 border p-2 w-full rounded"
                value={latInput}
                onChange={(e) => setLatInput(e.target.value)}
                placeholder="-33.123456"
              />
            </label>
            <label className="text-sm">
              Lng
              <input
                className="mt-1 border p-2 w-full rounded"
                value={lngInput}
                onChange={(e) => setLngInput(e.target.value)}
                placeholder="18.654321"
              />
            </label>

            <div className="md:col-span-2">
              <LeafletPreview lat={latInput} lng={lngInput} height={240} />
              <div className="text-xs text-gray-600 mt-1">Click the map to open OpenStreetMap.</div>
            </div>

            <div className="md:col-span-2 flex items-center gap-2">
              <button type="button" className="px-3 py-2 border rounded" onClick={useMyLocation}>
                Use my location
              </button>
              <button className="px-3 py-2 bg-black text-white rounded ml-auto" type="submit">
                Save location
              </button>
            </div>
          </form>

          <div className="text-xs text-gray-600 mt-2">Saved directly on the asset; no Vault needed.</div>
        </Card>
      </div>

      {/* Label options */}
      <Card title="Label options">
        <div className="flex flex-wrap items-center gap-3">
          <select className="border p-2 text-sm rounded" value={labelSize} onChange={(e) => setLabelSize(e.target.value)}>
            <option value="small">small</option>
            <option value="medium">medium</option>
          </select>
          <label className="text-sm inline-flex items-center gap-1">
            <input type="checkbox" checked={includeQR} onChange={(e) => setIncludeQR(e.target.checked)} />
            QR
          </label>
          <label className="text-sm inline-flex items-center gap-1">
            <input type="checkbox" checked={includeBar} onChange={(e) => setIncludeBar(e.target.checked)} />
            Barcode
          </label>
          <button className="px-3 py-2 border rounded" onClick={printLabel}>
            Print Label
          </button>
        </div>
      </Card>

      {/* Attachments */}
      <Card title="Attachments">
        {fileErr && <div className="text-red-600 text-sm mb-2">{fileErr}</div>}

        <form onSubmit={uploadPhoto} className="flex flex-wrap items-end gap-3">
          <label className="text-sm" style={{ minWidth: 260 }}>
            File
            <input
              className="mt-1 border p-2 w-full rounded"
              type="file"
              accept="image/*"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>
          <label className="text-sm" style={{ flex: 1, minWidth: 220 }}>
            Note
            <input
              className="mt-1 border p-2 w-full rounded"
              placeholder="Optional note for this photo"
              value={fileNote}
              onChange={(e) => setFileNote(e.target.value)}
            />
          </label>
          <button className="px-3 py-2 border rounded" type="submit">
            Add
          </button>
        </form>

        <div className="mt-3 flex flex-wrap gap-3">
          {(asset.attachments || []).length === 0 && (
            <div className="text-sm text-gray-600">No attachments yet.</div>
          )}
          {(asset.attachments || []).map((att) => {
            const isImage = (att.mime || "").startsWith("image/");
            const uploadedAt = att.uploadedAt ? new Date(att.uploadedAt).toLocaleString() : "";
            return (
              <div key={att._id || att.url} className="border rounded-lg overflow-hidden bg-white" style={{ width: 160 }}>
                <a
                  href={att.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                  title={att.filename || "Open attachment"}
                >
                  <div
                    className="bg-gray-100"
                    style={{
                      width: "100%",
                      height: 110,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "hidden",
                    }}
                  >
                    {isImage ? (
                      <img
                        src={att.url}
                        alt={att.filename || "attachment"}
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                          const p = e.currentTarget.parentElement;
                          if (p) p.innerHTML = "<div style='font-size:40px'>📄</div>";
                        }}
                      />
                    ) : (
                      <div className="text-4xl" aria-hidden>
                        📄
                      </div>
                    )}
                  </div>
                </a>
                <div className="p-2 text-xs">
                  <div className="font-medium truncate" title={att.filename}>
                    {att.filename || "Attachment"}
                  </div>
                  {uploadedAt && <div className="text-gray-600">{uploadedAt}</div>}
                  <div className="text-gray-600">
                    by <UploaderName att={att} />
                  </div>
                  {att.scanned && (
                    <div className="mt-1 inline-block px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800">Scanned</div>
                  )}
                  {att.lat != null && att.lng != null && (
                    <div className="text-gray-700 mt-1">
                      📍 {att.lat}, {att.lng}
                      {att.acc != null ? ` (${att.acc}m)` : ""}
                    </div>
                  )}
                  {att.note && (
                    <div
                      className="text-gray-700 mt-1"
                      style={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                      title={att.note}
                    >
                      {att.note}
                    </div>
                  )}
                </div>
                <div className="p-2 pt-0 text-right">
                  <button className="px-2 py-1 border rounded" onClick={() => deleteAttachment(att._id)} type="button">
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Maintenance */}
      <Card
        title="Log"
        right={
          <div className="flex items-center gap-2">
            <button className="px-2 py-1 border rounded text-sm" onClick={exportMaintenanceCsv}>
              Export log CSV
            </button>
            <button className="px-2 py-1 border rounded text-sm" onClick={exportKmz}>
              Export KMZ
            </button>
          </div>
        }
      >
        <form onSubmit={addMaintenance} className="grid md:grid-cols-3 gap-3">
          <label className="text-sm">
            When
            <input
              className="mt-1 border p-2 w-full rounded"
              type="datetime-local"
              value={mForm.date}
              onChange={(e) => setMForm((f) => ({ ...f, date: e.target.value }))}
            />
          </label>
          <label className="text-sm md:col-span-2">
            Note
            <input
              className="mt-1 border p-2 w-full rounded"
              value={mForm.note}
              onChange={(e) => setMForm((f) => ({ ...f, note: e.target.value }))}
              placeholder="e.g. Replaced filter / annual service"
            />
          </label>
          <div className="md:col-span-3">
            <button className="px-3 py-2 bg-black text-white rounded">Add entry</button>
          </div>
        </form>

        {!asset.maintenance?.length ? (
          <div className="text-sm text-gray-600 mt-2">No entries.</div>
        ) : (
          <div className="mt-2 divide-y rounded border">
            {asset.maintenance
              .slice()
              .reverse()
              .map((m) => (
                <div key={m._id} className="p-2 flex items-center justify-between">
                  <div className="text-sm">
                    <div className="font-medium">
                      {m.note || "(no note)"}{" "}
                      {m.scanned && (
                        <span className="ml-2 inline-block px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800">
                          Scanned
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-600">
                      {m.date ? new Date(m.date).toLocaleString() : "—"} {m.by ? `• ${m.by}` : ""}
                      {m.lat != null && m.lng != null && (
                        <>
                          {" "}
                          • 📍 {m.lat}, {m.lng}
                          {m.acc != null ? ` (${m.acc}m)` : ""}
                        </>
                      )}
                    </div>
                  </div>
                  <button className="px-2 py-1 border rounded" onClick={() => delMaintenance(m._id)}>
                    Delete
                  </button>
                </div>
              ))}
          </div>
        )}
      </Card>

      {/* Inspections */}
      <Card title="Inspections">
        {insErr && <div className="text-red-600 text-sm mb-2">{insErr}</div>}
        {insLoading ? (
          <div className="text-sm text-gray-600">Loading inspections…</div>
        ) : !inspections.length ? (
          <div className="text-sm text-gray-600">No inspections for this asset.</div>
        ) : (
          <div className="rounded border divide-y">
            {inspections.map((ins) => {
              const title =
                ins.title || ins.templateName || ins.formName || `Inspection ${ins._id ? `#${shortId(ins._id)}` : ""}`;

              const who =
                ins.inspector?.name ||
                ins.inspector?.email ||
                ins.by?.name ||
                ins.by?.email ||
                ins.user?.name ||
                ins.user?.email ||
                ins.inspector ||
                ins.by ||
                "—";

              const whenRaw = ins.submittedAt || ins.completedAt || ins.createdAt;
              const when = whenRaw ? new Date(whenRaw).toLocaleString() : "—";

              const status =
                ins.status || ins.result || (ins.pass === true ? "pass" : ins.pass === false ? "fail" : "—");

              return (
                <div key={ins._id || `${whenRaw || ""}-${title}`} className="p-2 flex items-center justify-between">
                  <div className="text-sm min-w-0">
                    <button
                      type="button"
                      className="font-medium underline underline-offset-2 text-left truncate"
                      title="View inspection"
                      onClick={() => setPreviewInspection(ins)}
                    >
                      {title}
                    </button>
                    <div className="text-xs text-gray-600">
                      {when} • {who} • {status}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="px-2 py-1 border rounded"
                      onClick={() => setPreviewInspection(ins)}
                      title="Quick view"
                    >
                      View
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Schedule (optional) */}
      {schedEnabled && (
        <Card title="Schedule">
          <form onSubmit={addSchedule} className="grid md:grid-cols-3 gap-3">
            <label className="text-sm">
              When
              <input
                className="mt-1 border p-2 w-full rounded"
                type="datetime-local"
                value={schedForm.at}
                onChange={(e) => setSchedForm((f) => ({ ...f, at: e.target.value }))}
              />
            </label>
            <label className="text-sm">
              Title
              <input
                className="mt-1 border p-2 w-full rounded"
                placeholder="e.g. Service due / Inspection"
                value={schedForm.title}
                onChange={(e) => setSchedForm((f) => ({ ...f, title: e.target.value }))}
              />
            </label>
            <label className="text-sm">
              Note
              <input
                className="mt-1 border p-2 w-full rounded"
                placeholder="Optional details"
                value={schedForm.note}
                onChange={(e) => setSchedForm((f) => ({ ...f, note: e.target.value }))}
              />
            </label>
            <div className="md:col-span-3">
              <button className="px-3 py-2 border rounded" type="submit">
                Add schedule
              </button>
            </div>
          </form>

          {!schedule.length ? (
            <div className="text-sm text-gray-600 mt-2">No scheduled items.</div>
          ) : (
            <div className="mt-2 rounded border divide-y">
              {schedule
                .slice()
                .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0))
                .map((s) => (
                  <div key={s._id} className="p-2 flex items-center justify-between">
                    <div className="text-sm">
                      <div className="font-medium">
                        {s.title || "Schedule"} — {s.at ? new Date(s.at).toLocaleString() : "—"}
                      </div>
                      {s.note && <div className="text-xs text-gray-600">{s.note}</div>}
                    </div>
                    <button className="px-2 py-1 border rounded" onClick={() => delSchedule(s._id)}>
                      Delete
                    </button>
                  </div>
                ))}
            </div>
          )}
        </Card>
      )}

      {/* Quick View modal for an inspection */}
      <Modal
        open={!!previewInspection}
        onClose={() => setPreviewInspection(null)}
        title={
          previewInspection
            ? previewInspection.title || previewInspection.templateName || previewInspection.formName || "Inspection"
            : "Inspection"
        }
      >
        {previewInspection ? (
          <div className="space-y-3">
            <div className="text-sm text-gray-700">
              <div>
                <b>Submitted:</b>{" "}
                {previewInspection.submittedAt
                  ? new Date(previewInspection.submittedAt).toLocaleString()
                  : previewInspection.completedAt
                  ? new Date(previewInspection.completedAt).toLocaleString()
                  : previewInspection.createdAt
                  ? new Date(previewInspection.createdAt).toLocaleString()
                  : "—"}
              </div>
              <div>
                <b>By:</b>{" "}
                {previewInspection.inspector?.name ||
                  previewInspection.inspector?.email ||
                  previewInspection.by?.name ||
                  previewInspection.by?.email ||
                  previewInspection.user?.name ||
                  previewInspection.user?.email ||
                  "—"}
              </div>
              <div>
                <b>Status:</b>{" "}
                {previewInspection.status ||
                  previewInspection.result ||
                  (previewInspection.pass === true
                    ? "pass"
                    : previewInspection.pass === false
                    ? "fail"
                    : "—")}
              </div>
            </div>

            {Array.isArray(previewInspection.answers) && (
              <div className="border rounded p-2">
                <div className="font-medium mb-1 text-sm">Answers</div>
                <div className="grid gap-1">
                  {previewInspection.answers.map((a, idx) => (
                    <div key={idx} className="text-sm">
                      <span className="font-medium">{a?.question || a?.label || `Q${idx + 1}`}:</span>{" "}
                      <span>{String(a?.answer ?? a?.value ?? "—")}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {previewInspection.sections && Array.isArray(previewInspection.sections) && (
              <div className="border rounded p-2">
                <div className="font-medium mb-1 text-sm">Sections</div>
                <div className="grid gap-2">
                  {previewInspection.sections.map((sec, i) => (
                    <div key={i}>
                      <div className="text-sm font-semibold">{sec.title || `Section ${i + 1}`}</div>
                      {Array.isArray(sec.items) && (
                        <div className="ml-3 grid gap-1">
                          {sec.items.map((it, j) => (
                            <div key={j} className="text-sm">
                              <span className="font-medium">{it.label || it.question || `Item ${j + 1}`}:</span>{" "}
                              <span>{String(it.value ?? it.answer ?? "—")}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!previewInspection.answers && !previewInspection.sections && (
              <pre className="text-xs bg-gray-50 p-2 rounded overflow-auto">
                {JSON.stringify(previewInspection, null, 2)}
              </pre>
            )}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
