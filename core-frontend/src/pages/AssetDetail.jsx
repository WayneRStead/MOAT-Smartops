// src/pages/AssetDetail.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";

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

/* ---------- Minimal uploader display helpers ---------- */
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
/* ------------------------------------------------------ */

export default function AssetDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [asset, setAsset] = useState(null);
  const [projects, setProjects] = useState([]);

  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [saving, setSaving] = useState(false);

  // location inputs (like Clockings)
  const [latInput, setLatInput] = useState("");
  const [lngInput, setLngInput] = useState("");

  // attachment UI
  const [file, setFile] = useState(null);
  const [fileNote, setFileNote] = useState("");
  const [fileErr, setFileErr] = useState("");

  // label options (used for printing)
  const [labelSize, setLabelSize] = useState("small");
  const [includeQR, setIncludeQR] = useState(true);
  const [includeBar, setIncludeBar] = useState(true);

  // ----- Maintenance -----
  const [mForm, setMForm] = useState({ date: "", note: "" });

  // ----- Schedule (gracefully degrades if API not present) -----
  const [schedule, setSchedule] = useState([]);
  const [schedEnabled, setSchedEnabled] = useState(true);
  const [schedForm, setSchedForm] = useState({ at: toLocalDateTimeInput(new Date()), title: "", note: "" });

  async function load() {
    setErr(""); setInfo("");
    try {
      const { data } = await api.get(`/assets/${id}`);
      setAsset(data || null);

      const la = data?.location?.lat ?? data?.lat;
      const lo = data?.location?.lng ?? data?.lng;
      setLatInput(la != null ? String(la) : "");
      setLngInput(lo != null ? String(lo) : "");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function loadProjects() {
    try {
      const { data } = await api.get("/projects", { params: { limit: 1000 } });
      setProjects(Array.isArray(data) ? data : []);
    } catch { setProjects([]); }
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
    } catch (e) {
      if (e?.response?.status === 404) {
        setSchedEnabled(false);
      } else {
        setSchedEnabled(false);
      }
    }
  }

  useEffect(() => {
    load();
    loadProjects();
    loadSchedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const projName = useMemo(() => {
    if (!asset?.projectId) return "—";
    const p = projects.find(x => String(x._id) === String(asset.projectId));
    return p?.name || String(asset.projectId);
  }, [asset, projects]);

  async function savePatch(patch) {
    setSaving(true); setErr("");
    try {
      const { data } = await api.put(`/assets/${id}`, patch);
      setAsset(data);
      setInfo("Saved");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    } finally { setSaving(false); }
  }

  // ---- location: send only {lat, lng} like Clockings ----
  function n(v) {
    if (v === "" || v == null) return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  }
  async function saveLocation(e) {
    e?.preventDefault?.();
    setErr(""); setInfo("");
    const la = n(latInput), lo = n(lngInput);
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
        setLatInput(String(la)); setLngInput(String(lo));
        await savePatch({ lat: la, lng: lo });
      },
      (ge) => setErr(ge?.message || "Failed to get current position"),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
    );
  }

  // ---- attachments (like TaskDetail) ----
  async function uploadPhoto(e) {
    e?.preventDefault?.();
    setFileErr(""); setInfo("");
    try {
      if (!file) return setFileErr("Choose an image first.");
      const fd = new FormData();
      fd.append("file", file);
      if (fileNote) fd.append("note", fileNote);
      const { data } = await api.post(`/assets/${id}/attachments`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setAsset(data);
      setFile(null); setFileNote("");
      setInfo("Photo uploaded.");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) {
      setFileErr(e?.response?.data?.error || String(e));
    }
  }
  async function deleteAttachment(attId) {
    if (!window.confirm("Delete this attachment?")) return;
    setErr(""); setInfo("");
    try {
      const { data } = await api.delete(`/assets/${id}/attachments/${attId}`);
      setAsset(data);
      setInfo("Attachment deleted.");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
  }

  // ---- Maintenance ----
  async function addMaintenance(e) {
    e?.preventDefault?.();
    setErr(""); setInfo("");
    try {
      const payload = {
        date: mForm.date ? fromLocalDateTimeInput(mForm.date) : undefined,
        note: (mForm.note || "").trim(),
      };
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
    setErr(""); setInfo("");
    try {
      const { data } = await api.delete(`/assets/${id}/maintenance/${mid}`);
      if (data && data._id) {
        setAsset(data);
      } else {
        await load();
      }
      setInfo("Maintenance entry deleted.");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  // ---- Schedule ----
  async function addSchedule(e) {
    e?.preventDefault?.();
    if (!schedEnabled) return;
    setErr(""); setInfo("");
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
    setErr(""); setInfo("");
    try {
      await api.delete(`/assets/${id}/schedule/${sid}`);
      await loadSchedule();
      setInfo("Schedule item deleted.");
      setTimeout(() => setInfo(""), 1000);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  // ---- QR / barcode ----
  function assetDeepLink() {
    try { return `${window.location.origin}/assets/${asset?._id}`; }
    catch { return `/assets/${asset?._id}`; }
  }
  const qrSize = labelSize === "small" ? 180 : 240;
  const barcodeScale = labelSize === "small" ? 3 : 4;
  const qrImg = includeQR
    ? `https://api.qrserver.com/v1/create-qr-code/?size=${qrSize}x${qrSize}&data=${encodeURIComponent(assetDeepLink())}`
    : null;
  const barcodeText = asset?.code || asset?._id || "";
  const barImg = includeBar && barcodeText
    ? `https://bwipjs-api.metafloor.com/?bcid=code128&text=${encodeURIComponent(barcodeText)}&includetext&scale=${barcodeScale}`
    : null;

  function printLabel() {
    const w = window.open("", "_blank", "width=600,height=400");
    if (!w) return;
    const title = asset?.name || "Asset";
    const proj = projName;
    const code = asset?.code || "";
    const thumb = (asset?.attachments || [])[0]?.url || "";
    const css = `
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; margin:0; padding:12px;}
      .card{border:1px solid #ddd; padding:12px; border-radius:10px; width:${labelSize==="small"?"320px":"400px"}}
      .row{display:flex; gap:12px; align-items:center}
      .title{font-weight:600; font-size:${labelSize==="small"?"14px":"16px"}}
      .sub{color:#666; font-size:12px}
      img{display:block}
      .photo{width:${labelSize==="small"?"64px":"80px"}; height:${labelSize==="small"?"64px":"80px"}; object-fit:cover; border:1px solid #ddd; border-radius:8px}
      .codes{margin-top:8px; display:flex; gap:12px; align-items:center}
      .codes img{max-height:${labelSize==="small"?"128px":"160px"}}
      .muted{color:#777; font-size:11px; margin-top:6px}
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

  if (!asset) return <div className="p-4">{err ? err : "Loading…"}</div>;

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Asset</h1>
        <div className="flex gap-2">
          <select className="border p-2 text-sm" value={labelSize} onChange={e=>setLabelSize(e.target.value)}>
            <option value="small">label: small</option>
            <option value="medium">label: medium</option>
          </select>
          <label className="text-sm inline-flex items-center gap-1">
            <input type="checkbox" checked={includeQR} onChange={e=>setIncludeQR(e.target.checked)} />
            QR
          </label>
          <label className="text-sm inline-flex items-center gap-1">
            <input type="checkbox" checked={includeBar} onChange={e=>setIncludeBar(e.target.checked)} />
            Barcode
          </label>
          <button className="px-3 py-2 border rounded" onClick={printLabel}>Print Label</button>
          <button className="px-3 py-2 border rounded" onClick={()=>navigate(-1)}>Back</button>
          <button
            className="px-3 py-2 border rounded"
            onClick={async ()=>{
              if (!confirm("Delete this asset?")) return;
              try { await api.delete(`/assets/${id}`); navigate("/assets"); }
              catch (e) { setErr(e?.response?.data?.error || String(e)); }
            }}
          >
            Delete
          </button>
        </div>
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      {/* Meta & fields */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="border rounded p-3 space-y-3">
          <label className="block text-sm">Name
            <input className="border p-2 w-full"
              value={asset.name || ""}
              onChange={e => setAsset(a => ({...(a||{}), name: e.target.value}))}
              onBlur={() => asset.name && savePatch({ name: asset.name })}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">Code
              <input className="border p-2 w-full"
                value={asset.code || ""}
                onChange={e => setAsset(a => ({...(a||{}), code: e.target.value}))}
                onBlur={() => savePatch({ code: asset.code || "" })}
              />
            </label>
            <label className="block text-sm">Type
              <input className="border p-2 w-full"
                value={asset.type || ""}
                onChange={e => setAsset(a => ({...(a||{}), type: e.target.value}))}
                onBlur={() => savePatch({ type: asset.type || "" })}
              />
            </label>
          </div>

          <label className="block text-sm">Status
            <select className="border p-2 w-full"
              value={asset.status || "active"}
              onChange={e => { const v = e.target.value; setAsset(a => ({...(a||{}), status: v})); savePatch({ status: v }); }}
              disabled={saving}
            >
              <option value="active">active</option>
              <option value="maintenance">maintenance</option>
              <option value="retired">retired</option>
            </select>
          </label>

          <label className="block text-sm">Project
            <select className="border p-2 w-full"
              value={asset.projectId || ""}
              onChange={e => { const v = e.target.value; setAsset(a => ({...(a||{}), projectId: v})); savePatch({ projectId: v || null }); }}>
              <option value="">— none —</option>
              {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
            {asset.projectId && (
              <div className="mt-1 text-xs">
                Linked to: <Link className="underline" to={`/projects/${asset.projectId}`}>{projName}</Link>
              </div>
            )}
          </label>

          <label className="block text-sm">Notes
            <textarea className="border p-2 w-full" rows={3}
              value={asset.notes || ""}
              onChange={e => setAsset(a => ({...(a||{}), notes: e.target.value}))}
              onBlur={() => savePatch({ notes: asset.notes || "" })}
            />
          </label>

          <div className="text-sm text-gray-600">
            Created: {asset.createdAt ? new Date(asset.createdAt).toLocaleString() : "—"}<br />
            Updated: {asset.updatedAt ? new Date(asset.updatedAt).toLocaleString() : "—"}
          </div>
        </div>

        {/* Location (like Clockings) */}
        <div className="border rounded p-3 space-y-3">
          <div className="font-semibold">Location (lat/lng)</div>
          <form onSubmit={saveLocation} className="grid md:grid-cols-4 gap-2">
            <label className="text-sm">Lat
              <input className="border p-2 w-full" value={latInput} onChange={e=>setLatInput(e.target.value)} placeholder="-33.123456" />
            </label>
            <label className="text-sm">Lng
              <input className="border p-2 w-full" value={lngInput} onChange={e=>setLngInput(e.target.value)} placeholder="18.654321" />
            </label>
            <div className="flex items-end gap-2 md:col-span-2">
              <button type="button" className="px-3 py-2 border rounded" onClick={useMyLocation}>Use my location</button>
              <a className="px-3 py-2 border rounded"
                href={latInput && lngInput ? `https://www.google.com/maps?q=${latInput},${lngInput}` : undefined}
                target="_blank" rel="noreferrer"
                onClick={(e)=>{ if(!(latInput && lngInput)) e.preventDefault(); }}>
                Open in Maps
              </a>
              <button className="px-3 py-2 bg-black text-white rounded ml-auto" type="submit">Save location</button>
            </div>
          </form>
          <div className="text-xs text-gray-600">Saved directly on the asset; no Vault needed.</div>
        </div>
      </div>

      {/* Attachments (thumbnails only) */}
      <div className="border rounded p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold">Attachments</div>
        </div>

        {fileErr && <div className="text-red-600 text-sm">{fileErr}</div>}

        <form onSubmit={uploadPhoto} className="flex flex-wrap items-end gap-3">
          <label className="text-sm" style={{ minWidth: 260 }}>
            File
            <input className="border p-2 w-full" type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
          <label className="text-sm" style={{ flex: 1, minWidth: 220 }}>
            Note
            <input className="border p-2 w-full" placeholder="Optional note for this photo" value={fileNote} onChange={(e) => setFileNote(e.target.value)} />
          </label>
          <button className="px-3 py-2 border rounded" type="submit">Add</button>
        </form>

        <div className="flex flex-wrap gap-3">
          {(asset.attachments || []).length === 0 && (<div className="text-sm text-gray-600">No attachments yet.</div>)}
          {(asset.attachments || []).map((att) => {
            const isImage = (att.mime || "").startsWith("image/");
            const uploadedAt = att.uploadedAt ? new Date(att.uploadedAt).toLocaleString() : "";
            return (
              <div key={att._id || att.url} className="border rounded overflow-hidden bg-white" style={{ width: 160 }}>
                <a href={att.url} target="_blank" rel="noopener noreferrer" className="block" title={att.filename || "Open attachment"}>
                  <div className="bg-gray-100" style={{ width: "100%", height: 110, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
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
                      <div className="text-4xl" aria-hidden>📄</div>
                    )}
                  </div>
                </a>
                <div className="p-2 text-xs">
                  <div className="font-medium truncate" title={att.filename}>{att.filename || "Attachment"}</div>
                  {uploadedAt && <div className="text-gray-600">{uploadedAt}</div>}
                  <div className="text-gray-600">
                    by <UploaderName att={att} />
                  </div>
                  {att.note && (
                    <div
                      className="text-gray-700 mt-1"
                      style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}
                      title={att.note}
                    >
                      {att.note}
                    </div>
                  )}
                </div>
                <div className="p-2 pt-0 text-right">
                  <button className="px-2 py-1 border rounded" onClick={() => deleteAttachment(att._id)} type="button">Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Maintenance */}
      <div className="border rounded p-3 space-y-3">
        <div className="font-semibold">Maintenance</div>

        <form onSubmit={addMaintenance} className="grid md:grid-cols-3 gap-2">
          <label className="text-sm">When
            <input
              className="border p-2 w-full"
              type="datetime-local"
              value={mForm.date}
              onChange={e=>setMForm(f => ({ ...f, date: e.target.value }))}
            />
          </label>
          <label className="text-sm md:col-span-2">Note
            <input
              className="border p-2 w-full"
              value={mForm.note}
              onChange={e=>setMForm(f => ({ ...f, note: e.target.value }))}
              placeholder="e.g. Replaced filter / annual service"
            />
          </label>
          <div className="md:col-span-3">
            <button className="px-3 py-2 bg-black text-white rounded">Add entry</button>
          </div>
        </form>

        {!asset.maintenance?.length ? (
          <div className="text-sm text-gray-600">No entries.</div>
        ) : (
          <div className="grid gap-2">
            {asset.maintenance.slice().reverse().map(m => (
              <div key={m._id} className="flex items-center justify-between border p-2 rounded">
                <div className="text-sm">
                  <div className="font-medium">{m.note || "(no note)"}</div>
                  <div className="text-xs text-gray-600">
                    {m.date ? new Date(m.date).toLocaleString() : "—"} {m.by ? `• ${m.by}` : ""}
                  </div>
                </div>
                <button className="px-2 py-1 border rounded" onClick={()=>delMaintenance(m._id)}>Delete</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Schedule (optional feature) */}
      {schedEnabled && (
        <div className="border rounded p-3 space-y-3">
          <div className="font-semibold">Schedule</div>
          <form onSubmit={addSchedule} className="grid md:grid-cols-3 gap-2">
            <label className="text-sm">When
              <input
                className="border p-2 w-full"
                type="datetime-local"
                value={schedForm.at}
                onChange={e=>setSchedForm(f => ({ ...f, at: e.target.value }))}
              />
            </label>
            <label className="text-sm">Title
              <input
                className="border p-2 w-full"
                placeholder="e.g. Service due / Inspection"
                value={schedForm.title}
                onChange={e=>setSchedForm(f => ({ ...f, title: e.target.value }))}
              />
            </label>
            <label className="text-sm">Note
              <input
                className="border p-2 w-full"
                placeholder="Optional details"
                value={schedForm.note}
                onChange={e=>setSchedForm(f => ({ ...f, note: e.target.value }))}
              />
            </label>
            <div className="md:col-span-3">
              <button className="px-3 py-2 border rounded" type="submit">Add schedule</button>
            </div>
          </form>

          {!schedule.length ? (
            <div className="text-sm text-gray-600">No scheduled items.</div>
          ) : (
            <div className="grid gap-2">
              {schedule
                .slice()
                .sort((a,b)=> new Date(a.at||0) - new Date(b.at||0))
                .map(s => (
                  <div key={s._id} className="flex items-center justify-between border rounded p-2">
                    <div className="text-sm">
                      <div className="font-medium">
                        {s.title || "Schedule"} — {s.at ? new Date(s.at).toLocaleString() : "—"}
                      </div>
                      {s.note && <div className="text-xs text-gray-600">{s.note}</div>}
                    </div>
                    <button className="px-2 py-1 border rounded" onClick={()=>delSchedule(s._id)}>Delete</button>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
