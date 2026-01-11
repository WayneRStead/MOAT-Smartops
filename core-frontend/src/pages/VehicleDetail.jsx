// src/pages/VehicleDetail.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import {
  getOpenTrip,
  listTrips,
  startTrip,
  endTrip,
  uploadTripPhoto,
  updateTrip as compatUpdateTrip,
} from "../lib/vehicleTrips";
import { listPurchases, createPurchase, deletePurchase, listVendors } from "../lib/purchases";

/* ---------- Small UI bits ---------- */
function StatusBadge({ value }) {
  const map = {
    active: "bg-green-100 text-green-800",
    workshop: "bg-amber-100 text-amber-800",
    retired: "bg-gray-200 text-gray-800",
    stolen: "bg-purple-200 text-purple-800",
  };
  const cls = map[value] || "bg-gray-200 text-gray-800";
  return <span className={`chip ${cls}`}>{String(value || "—").toUpperCase()}</span>;
}

/* HeaderRow with no stray whitespace (prevents hydration warnings) */
function HeaderRow({ headers }) {
  return (
    <tr>
      {headers.map((h) => (
        <th key={h} className="border-b border-border p-2 text-left">
          {h}
        </th>
      ))}
    </tr>
  );
}

/* Tiny modal / lightbox */
function Modal({ open, title, onClose, children, footer }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.35)" }} onClick={onClose} />
      <div className="relative z-10 w-full max-w-2xl rounded-2xl border border-border bg-white p-4 shadow-xl">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-lg font-semibold">{title}</div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="space-y-3">{children}</div>
        {footer && <div className="mt-4 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

/* Resolve backend-relative URLs (for thumbnails) */
function toAbsoluteUrl(u) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  const baseFromApi = (api?.defaults?.baseURL || "").replace(/\/api\/?$/i, "").replace(/\/+$/, "");
  const base =
    baseFromApi ||
    (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.host}` : "");
  return u.startsWith("/") ? `${base}${u}` : `${base}/${u}`;
}

// Normalize URLs we store in Mongo so they remain valid across deployments.
// If the backend returns a relative path, we keep it relative (e.g. "/uploads/..").
// If it returns an absolute URL, we keep it absolute.
function normalizeStoredUrl(u) {
  if (!u) return "";
  return String(u).trim();
}

// Read trip photo URL regardless of backend shape:
// - trip.startPhoto.url
// - trip.startPhotoUrl
// - trip.startPhoto (string)
// Same for end.
function tripPhotoUrl(trip, which /* "start" | "end" */) {
  const photo =
    which === "start"
      ? (trip?.startPhoto || trip?.start_photo || trip?.startImage)
      : (trip?.endPhoto || trip?.end_photo || trip?.endImage);

  // 1) If backend stored a direct URL, use it
  let url =
    (typeof photo === "string" && photo) ||
    (photo && typeof photo.url === "string" && photo.url) ||
    "";

  // 2) If no url, but we have a filename, build the /files URL
  // IMPORTANT: do NOT use photo._id (Mongoose subdocs often have _id!)
  if (!url) {
    const filename =
      (photo && typeof photo.filename === "string" && photo.filename) ||
      "";

    if (filename) url = `/files/vehicle-trips/${filename}`;
  }

  if (!url) return "";

  // 3) Make relative /files URLs absolute to the backend origin
  // so the browser loads from Render, not Vercel.
  const backend =
    import.meta.env.VITE_API_BASE ||
    import.meta.env.VITE_BACKEND_ORIGIN ||
    "";

  // If already absolute (http/https), return as is
  if (/^https?:\/\//i.test(url)) return url;

  // Ensure we don't double up slashes
  const b = backend.replace(/\/+$/, "");
  const u = url.startsWith("/") ? url : `/${url}`;
  return `${b}${u}`;
}

/* --- Geolocation helper (non-blocking) --- */
function getGeo(timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords || {};
        if (typeof latitude === "number" && typeof longitude === "number") {
          resolve({ lat: latitude, lng: longitude, accuracy });
        } else resolve(null);
      },
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10000 }
    );
  });
}

/* ---- Odometer helpers ---- */
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function latestOdoFromTrips(trips) {
  let max = null;
  (trips || []).forEach((t) => {
    const vals = [t?.odoEnd, t?.odoStart].map(Number).filter(Number.isFinite);
    vals.forEach((v) => {
      if (max == null || v > max) max = v;
    });
  });
  return max;
}
function latestOdoFromEntries(entries) {
  let max = null;
  (entries || []).forEach((e) => {
    const vals = [e?.odometer, e?.odometerEnd, e?.odometerStart].map(Number).filter(Number.isFinite);
    vals.forEach((v) => {
      if (max == null || v > max) max = v;
    });
  });
  return max;
}

/* --- Reminder helpers ---- */
function parseReminderCategory(notes = "") {
  const m = notes.match(/\(\s*Type:\s*([^)]+?)\s*\)/i);
  return m ? m[1].trim().toLowerCase() : "";
}
function parseReminderCompletedOn(notes = "") {
  const m = notes.match(/\(\s*Completed:\s*([^)]+?)\s*\)/i);
  return m ? m[1].trim() : "";
}
function parseRecurDays(notes = "") {
  const m = notes.match(/\(\s*RecurDays:\s*([^)]+?)\s*\)/i);
  const n = m ? Number(m[1].trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function parseRecurKm(notes = "") {
  const m = notes.match(/\(\s*RecurKm:\s*([^)]+?)\s*\)/i);
  const n = m ? Number(m[1].trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function parsePairId(notes = "") {
  const m = notes.match(/\(\s*Pair:\s*([^)]+?)\s*\)/i);
  return m ? m[1].trim() : "";
}
function stripReminderTokens(notes = "") {
  return (notes || "")
    .replace(/\(\s*(Type|Completed|RecurDays|RecurKm|Pair)\s*:\s*[^)]+?\)\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** returns {code: 'overdue'|'due-soon'|'ok'|'paused'|'completed', badgeClass, label} */
function reminderStatus(rem, currentOdo, today = startOfToday()) {
  const completedOn = parseReminderCompletedOn(rem?.notes || "");
  if (!rem?.active && completedOn) {
    return { code: "completed", badgeClass: "bg-blue-100 text-blue-800", label: "Completed" };
  }
  if (!rem?.active) {
    return { code: "paused", badgeClass: "bg-gray-200 text-gray-800", label: "Paused" };
  }
  if (rem.kind === "date") {
    const due = rem.dueDate ? new Date(rem.dueDate) : null;
    if (!due) return { code: "ok", badgeClass: "bg-green-100 text-green-800", label: "OK" };
    const dueMid = new Date(due);
    dueMid.setHours(0, 0, 0, 0);
    if (dueMid < today) return { code: "overdue", badgeClass: "bg-red-100 text-red-800", label: "Overdue" };
    const days = Math.round((dueMid - today) / (24 * 3600 * 1000));
    if (days <= 7) return { code: "due-soon", badgeClass: "bg-amber-100 text-amber-800", label: `Due in ${days}d` };
    return { code: "ok", badgeClass: "bg-green-100 text-green-800", label: "OK" };
  }
  if (rem.kind === "odometer") {
    const dueKm = Number(rem.dueOdometer);
    if (!Number.isFinite(dueKm) || currentOdo == null) {
      return { code: "ok", badgeClass: "bg-green-100 text-green-800", label: "OK" };
    }
    if (currentOdo >= dueKm) return { code: "overdue", badgeClass: "bg-red-100 text-red-800", label: "Overdue" };
    const remaining = Math.max(0, dueKm - currentOdo);
    if (remaining <= 500) {
      return { code: "due-soon", badgeClass: "bg-amber-100 text-amber-800", label: `Due in ${remaining} km` };
    }
    return { code: "ok", badgeClass: "bg-green-100 text-green-800", label: "OK" };
  }
  return { code: "ok", badgeClass: "bg-green-100 text-green-800", label: "OK" };
}

/* ----- Logbook helpers ----- */
const LOG_TYPES = ["service", "repair", "inspection", "registration", "incident", "tyres", "other"];
function resolveEntryType(e) {
  if (e?.type) return e.type;
  const t = String(e?.title || "").toLowerCase();
  const tagHit = (e?.tags || [])
    .map(String)
    .map((x) => x.toLowerCase())
    .find((x) => LOG_TYPES.includes(x));
  if (LOG_TYPES.includes(t)) return t;
  if (tagHit) return tagHit;
  return "other";
}
/** Parse "(Vendor: ...)" and "(Cost: ...)" out of notes when backend doesn't have fields */
function parseVendorCostFromNotes(notes = "") {
  let clean = notes;
  let vendor = undefined;
  let cost = undefined;
  const vendorRx = /\(\s*Vendor:\s*([^)]+?)\s*\)/i;
  const costRx = /\(\s*Cost:\s*([^)]+?)\s*\)/i;
  const vMatch = clean.match(vendorRx);
  if (vMatch) {
    vendor = vMatch[1].trim();
    clean = clean.replace(vendorRx, "").trim();
  }
  const cMatch = clean.match(costRx);
  if (cMatch) {
    const raw = cMatch[1].trim();
    const n = Number(raw.replace(/[^0-9.]/g, ""));
    cost = Number.isFinite(n) ? n : raw;
    clean = clean.replace(costRx, "").trim();
  }
  clean = clean.replace(/\s{2,}/g, " ").trim();
  return { vendor, cost, notesClean: clean };
}
function entryDisplay(e) {
  const parsed = parseVendorCostFromNotes(e?.notes || "");
  return {
    type: resolveEntryType(e),
    odometer: e?.odometer ?? e?.odometerEnd ?? e?.odometerStart ?? "",
    vendor: e?.vendor ?? parsed.vendor ?? "",
    cost: e?.cost ?? parsed.cost ?? "",
    tags: e?.tags || [],
    ts: e?.ts,
    notes: parsed.notesClean || e?.notes || "",
  };
}

/* ---------- label helpers ---------- */
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
function taskLabelFrom(tasks, tidOrObj) {
  if (!tidOrObj) return "—";
  if (typeof tidOrObj === "object" && (tidOrObj._id || tidOrObj.title)) {
    return tidOrObj.title || tidOrObj._id;
  }
  const tid = String(tidOrObj);
  const t = tasks.find((x) => String(x._id) === tid);
  return t ? (t.title || tid) : tid;
}

export default function VehicleDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [v, setV] = useState(null);
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  // Reminders
  const [reminders, setReminders] = useState([]);
  const [nextDue, setNextDue] = useState(null);
  const [rErr, setRErr] = useState("");
  const [rInfo, setRInfo] = useState("");
  const [rForm, setRForm] = useState({
    kind: "date",
    category: "service",
    dueDate: "",
    dueOdometer: "",
    notes: "",
    recurring: false,
    recurDays: "",
    recurKm: "",
  });
  const [showCompletedReminders, setShowCompletedReminders] = useState(false);

  // Reminders inline edit
  const [rEditId, setREditId] = useState("");
  const [rEditForm, setREditForm] = useState({
    kind: "date",
    category: "service",
    dueDate: "",
    dueOdometer: "",
    notes: "",
    _completedToken: "",
    recurring: false,
    recurDays: "",
    recurKm: "",
  });

  // Logbook
  const [entries, setEntries] = useState([]);
  const [lbErr, setLbErr] = useState("");
  const [lbInfo, setLbInfo] = useState("");

  // Create log entry (modal)
  const [lbModalOpen, setLbModalOpen] = useState(false);
  const [lbForm, setLbForm] = useState({
    type: "service",
    ts: new Date().toISOString().slice(0, 16),
    odometer: "",
    cost: "",
    vendor: "",
    tags: "",
    notes: "",
    completeReminderId: "",
  });

  // Logbook inline edit
  const [lbEditId, setLbEditId] = useState("");
  const [lbEditForm, setLbEditForm] = useState({
    type: "service",
    ts: "",
    odometer: "",
    cost: "",
    vendor: "",
    tags: "",
    notes: "",
  });

  /* ---------------- Vehicle Trips state ---------------- */
  const [openTrip, setOpenTrip] = useState(null);
  const [trips, setTrips] = useState([]);
  const [tripsLoading, setTripsLoading] = useState(false);

  // tripErr now: for non-modal trip errors (e.g. list load / inline edit)
  const [tripErr, setTripErr] = useState("");
  const [tripInfo, setTripInfo] = useState("");
  const [tripSaving, setTripSaving] = useState(false);

  // NEW: modal-scoped trip error (shows inside the lightbox)
  const [tripModalErr, setTripModalErr] = useState("");

  const [odoStart, setOdoStart] = useState("");
  const [odoEnd, setOdoEnd] = useState("");
  const [startFile, setStartFile] = useState(null);
  const [endFile, setEndFile] = useState(null);
  const [tripNotes, setTripNotes] = useState("");

  // NEW: trip usage (business/private)
  const [tripUsage, setTripUsage] = useState("business"); // default

  // Trip create modals
  const [startTripOpen, setStartTripOpen] = useState(false);
  const [endTripOpen, setEndTripOpen] = useState(false);

  // Optional project/task selection for a trip
  const [tripProjectId, setTripProjectId] = useState("");
  const [tripTaskId, setTripTaskId] = useState("");

  // Trip filter UI state
  const [tripDriverFilter, setTripDriverFilter] = useState("");
  const [tripProjectFilter, setTripProjectFilter] = useState("");
  const [tripTaskFilter, setTripTaskFilter] = useState("");
  const [tripDateFrom, setTripDateFrom] = useState("");
  const [tripDateTo, setTripDateTo] = useState("");

  // Trip inline edit
  const [tripEditId, setTripEditId] = useState("");
  const [tripEditForm, setTripEditForm] = useState({
    startedAt: "",
    endedAt: "",
    odoStart: "",
    odoEnd: "",
    driverUserId: "",
    projectId: "",
    taskId: "",
    notes: "",
    usage: "business",
  });

  // ---------- Purchases state ----------
  const [vendors, setVendors] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [pErr, setPErr] = useState("");
  const [pInfo, setPInfo] = useState("");
  const PURCHASE_TYPES = ["service", "repair", "tyres", "parts", "fuel", "toll", "registration", "other"];
  const [pPhotoFile, setPPhotoFile] = useState(null); // for "Add purchase"
  const [editPhotoFile, setEditPhotoFile] = useState(null); // for inline "Edit purchase"

  // Purchases modal
  const [purchaseModalOpen, setPurchaseModalOpen] = useState(false);

  const [pForm, setPForm] = useState({
    vendorId: "",
    newVendorName: "",
    type: "service",
    date: new Date().toISOString().slice(0, 10),
    cost: "",
    projectId: "",
    taskId: "",
    notes: "",
  });

  const [editId, setEditId] = useState(""); // purchase being edited
  const [editForm, setEditForm] = useState({
    vendorId: "",
    newVendorName: "",
    type: "service",
    date: "",
    cost: "",
    projectId: "",
    taskId: "",
    notes: "",
  });

  // Inspections
  const [inspections, setInspections] = useState([]);
  const [inspErr, setInspErr] = useState("");
  const [inspInfo, setInspInfo] = useState("");

  useEffect(() => {
    setTripProjectId(v?.projectId || "");
    setTripTaskId(v?.taskId || "");
    setPForm((f) => ({ ...f, projectId: v?.projectId || "", taskId: v?.taskId || "" }));
  }, [v?.projectId, v?.taskId]);

  const [inspModalOpen, setInspModalOpen] = useState(false);
  const [inspModalHtml, setInspModalHtml] = useState("");
  const [inspModalTitle, setInspModalTitle] = useState("");

  async function openInspectionLightbox(insp) {
  try {
    const { data } = await api.get(`/inspections/submissions/${insp._id}`);
    // backend returns JSON (not HTML) based on what you showed
    const sub = data || {};

    const title = sub?.formTitle || insp.title || "Inspection";
    const result = sub?.overallResult || sub?.status || "—";
    const score = sub?.scoringSummary?.percentScore;
    const followUp = sub?.followUpDate ? new Date(sub.followUpDate).toLocaleDateString() : "";
    const ranAt = sub?.createdAt ? new Date(sub.createdAt).toLocaleString() : "";
    const by = sub?.runBy?.name || sub?.runBy?.email || "—";

    const items = Array.isArray(sub?.items) ? sub.items : [];
    const rows = items
      .map((it, idx) => {
        const q = it?.label || it?.title || it?.question || `Item ${idx + 1}`;
        const r = it?.result || it?.answer || it?.value || it?.status || "";
        const c = it?.comment || it?.notes || "";
        return `<tr>
          <td style="padding:6px;border-bottom:1px solid #eee;">${String(q)}</td>
          <td style="padding:6px;border-bottom:1px solid #eee;">${String(r)}</td>
          <td style="padding:6px;border-bottom:1px solid #eee;">${String(c)}</td>
        </tr>`;
      })
      .join("");

    const html = `
      <div style="font-family:ui-sans-serif,system-ui;padding:8px">
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px">
          <div><b>Result:</b> ${String(result)}</div>
          ${Number.isFinite(Number(score)) ? `<div><b>Score:</b> ${Number(score).toFixed(1)}%</div>` : ""}
          ${followUp ? `<div><b>Follow-up:</b> ${followUp}</div>` : ""}
        </div>
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:10px;color:#444">
          <div><b>Ran:</b> ${ranAt || "—"}</div>
          <div><b>By:</b> ${String(by)}</div>
        </div>
        <div style="overflow:auto;border:1px solid #eee;border-radius:10px">
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <thead>
              <tr style="background:#fafafa">
                <th style="text-align:left;padding:8px;border-bottom:1px solid #eee;">Item</th>
                <th style="text-align:left;padding:8px;border-bottom:1px solid #eee;">Result</th>
                <th style="text-align:left;padding:8px;border-bottom:1px solid #eee;">Comment</th>
              </tr>
            </thead>
            <tbody>
              ${rows || `<tr><td colspan="3" style="padding:10px">No item details.</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `;

    setInspModalTitle(title);
    setInspModalHtml(html);
    setInspModalOpen(true);
  } catch (e) {
    setInspModalTitle("Inspection");
    setInspModalHtml("<div style='padding:12px;color:#b91c1c'>Failed to load inspection.</div>");
    setInspModalOpen(true);
  }
}

  // ----- Loaders -----
  async function load() {
    setErr("");
    setInfo("");
    try {
      const { data } = await api.get(`/vehicles/${id}`);
      setV((prev) => {
        const type = data?.type ?? data?.vehicleType ?? prev?.type ?? "";
        return { ...data, type };
      });
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
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
  async function loadTasks() {
    try {
      const { data } = await api.get("/tasks", { params: { limit: 1000 } });
      setTasks(Array.isArray(data) ? data : []);
    } catch {
      setTasks([]);
    }
  }
  async function loadReminders() {
    setRErr("");
    setRInfo("");
    try {
      const { data } = await api.get(`/vehicles/${id}/reminders`);
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
    } catch (e) {
      setRErr(e?.response?.data?.error || String(e));
    }
  }

  // --- Logbook API wrappers (fix "not found" by trying multiple endpoints + quiet 404s) ---
  function normalizeListResp(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.rows)) return data.rows;
    if (Array.isArray(data?.results)) return data.results;
    return [];
  }
  async function apiGetLogbookList() {
    const attempts = [
      { method: "get", url: "/logbook", params: { vehicleId: id, limit: 200 } },
      { method: "get", url: "/logbooks", params: { vehicleId: id, limit: 200 } },
      { method: "get", url: `/vehicles/${id}/logbook`, params: { limit: 200 } },
      { method: "get", url: `/vehicles/${id}/logbook-entries`, params: { limit: 200 } },
      { method: "get", url: `/vehicles/${id}/entries`, params: { limit: 200 } },
    ];

    let lastErr = null;
    for (const a of attempts) {
      try {
        const { data } = await api[a.method](a.url, a.params ? { params: a.params } : undefined);
        const list = normalizeListResp(data);
        if (Array.isArray(list)) return list;
        return [];
      } catch (e) {
        lastErr = e;
        if (e?.response?.status === 404) continue; // try next
        // for non-404, keep trying others but remember the error
        continue;
      }
    }

    // if everything 404, return empty with no error
    if (lastErr?.response?.status === 404) return [];
    throw lastErr || new Error("Failed to load logbook");
  }

  async function apiCreateLogbookEntry(payload) {
    const attempts = [
      { url: "/logbook", body: payload },
      { url: "/logbooks", body: payload },
      { url: `/vehicles/${id}/logbook`, body: payload },
      { url: `/vehicles/${id}/logbook-entries`, body: payload },
    ];
    let lastErr = null;
    for (const a of attempts) {
      try {
        const { data } = await api.post(a.url, a.body);
        return data;
      } catch (e) {
        lastErr = e;
        if (e?.response?.status === 404) continue;
        continue;
      }
    }
    throw lastErr || new Error("Failed to create log entry");
  }

  async function apiUpdateLogbookEntry(entryId, patch) {
    const attempts = [
      { url: `/logbook/${entryId}`, body: patch },
      { url: `/logbooks/${entryId}`, body: patch },
      { url: `/vehicles/${id}/logbook/${entryId}`, body: patch },
      { url: `/vehicles/${id}/logbook-entries/${entryId}`, body: patch },
    ];
    let lastErr = null;
    for (const a of attempts) {
      try {
        const { data } = await api.put(a.url, a.body);
        return data;
      } catch (e) {
        lastErr = e;
        if (e?.response?.status === 404) continue;
        continue;
      }
    }
    throw lastErr || new Error("Failed to update log entry");
  }

  async function apiDeleteLogbookEntry(entryId) {
    const attempts = [
      { url: `/logbook/${entryId}` },
      { url: `/logbooks/${entryId}` },
      { url: `/vehicles/${id}/logbook/${entryId}` },
      { url: `/vehicles/${id}/logbook-entries/${entryId}` },
    ];
    let lastErr = null;
    for (const a of attempts) {
      try {
        await api.delete(a.url);
        return true;
      } catch (e) {
        lastErr = e;
        if (e?.response?.status === 404) continue;
        continue;
      }
    }
    throw lastErr || new Error("Failed to delete log entry");
  }

  async function loadLogbook() {
    setLbErr("");
    setLbInfo("");
    try {
      const list = await apiGetLogbookList();
      setEntries(Array.isArray(list) ? list : []);
    } catch (e) {
      // only show a "real" error (not a missing endpoint)
      const msg = e?.response?.data?.error || String(e);
      setLbErr(msg);
    }
  }

  // Purchases loaders
  async function loadVendorsList() {
    try {
      const data = await listVendors();
      setVendors(Array.isArray(data) ? data : []);
    } catch {
      setVendors([]);
    }
  }
  async function loadPurchasesList() {
    setPErr("");
    setPInfo("");
    try {
      const data = await listPurchases({ vehicleId: id, limit: 200 });
      setPurchases(Array.isArray(data) ? data : []);
    } catch (e) {
      setPErr(e?.response?.data?.error || String(e));
    }
  }

  // REPLACE: loadInspections with proper multi-endpoint attempts + normalization
async function loadInspections() {
  setInspErr("");
  setInspInfo("");

  function normalizeList(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.rows)) return data.rows;
    if (Array.isArray(data?.results)) return data.results;
    return [];
  }

  // We normalize to the fields your table expects
  function normalizeSubmission(sub) {
    const subj = sub?.subjectAtRun || sub?.subject || {};
    return {
      _id: sub?._id || sub?.id,
      ts: sub?.createdAt || sub?.updatedAt || sub?.submittedAt || sub?.ts || null,
      title: sub?.formTitle || sub?.title || sub?.formName || "Inspection",
      userId: sub?.runBy?.userId || sub?.runBy?._id || sub?.userId || sub?.user,
      status: sub?.overallResult || sub?.status || sub?.result || "—",
      subjectType: subj?.type,
      subjectId: subj?.id,
      _raw: sub,
      _source: "submission",
    };
  }

  function isThisVehicle(sub) {
    const vid = String(id);
    const subj = sub?.subjectAtRun || sub?.subject || {};
    const subjType = String(subj?.type || "").toLowerCase();
    const subjId = subj?.id != null ? String(subj.id) : "";
    return subjType === "vehicle" && subjId === vid;
  }

  try {
    // ✅ Primary: submissions list, then filter client-side
    // (even if backend doesn’t support query params, this still works)
    const { data } = await api.get("/inspections/submissions", { params: { limit: 500 } });
    const all = normalizeList(data);
    const mine = all.filter(isThisVehicle).map(normalizeSubmission);

    if (mine.length) {
      setInspections(mine);
      return;
    }
  } catch (e) {
    // if this fails, we keep going to fallback
    if (e?.response?.status !== 404) setInspErr(e?.response?.data?.error || String(e));
  }

  // Fallback: your logbook-based inspection entries (keeps your previous behavior)
  const fromLogbook = (entries || [])
    .filter((e) => (String(e?.type || "").toLowerCase() === "inspection") || resolveEntryType(e) === "inspection")
    .map((e) => ({
      _id: e._id,
      ts: e.ts || e.date,
      title: e.title || "Inspection",
      userId: e.userId || e.user,
      status: e.status || e.result || (e.notes ? "recorded" : "—"),
      _source: "logbook",
    }));

  setInspections(fromLogbook);

  // Only show an error if we had a real non-404 failure
  if (lastNon404) {
    setInspErr(lastNon404?.response?.data?.error || String(lastNon404));
  }
}

  /* -------- Trips loader (robust to 404 on /open) -------- */
  async function loadTrips() {
    setTripErr("");
    setTripsLoading(true);
    try {
      let open = null;
      try {
        open = await getOpenTrip(id);
      } catch (e) {
        if (e?.response?.status !== 404) throw e;
      }
      const data = await listTrips(id, { limit: 200 }).catch(() => []);
      const list = Array.isArray(data) ? data : [];
      if (!open) {
        open = list.find((t) => !t.endedAt); // derive open trip if endpoint missing
      }
      setOpenTrip(open || null);
      setTrips(list);
    } catch (e) {
      setTripErr(e?.response?.data?.error || String(e));
    } finally {
      setTripsLoading(false);
    }
  }

  useEffect(() => {
    load();
    loadProjects();
    loadUsers();
    loadTasks();
    loadReminders();
    loadLogbook();
    loadTrips();
    loadVendorsList();
    loadPurchasesList();
    // important: if inspections depend on logbook fallback, reload after entries arrives
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    loadInspections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  // ----- Vehicle meta -----
  async function save(patch) {
    try {
      const { data } = await api.put(`/vehicles/${id}`, patch);
      setV(data);
      setInfo("Saved");
      setTimeout(() => setInfo(""), 1200);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }
  async function setStatus(newStatus) {
    await save({ status: newStatus });
  }
  async function del() {
    if (!confirm("Delete this vehicle?")) return;
    try {
      await api.delete(`/vehicles/${id}`);
      navigate("/vehicles");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  /* -------- Recurrence helpers -------- */
  function addDaysISO(baseISO, addDays) {
    const d = baseISO ? new Date(baseISO) : new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + Number(addDays || 0));
    return d.toISOString().slice(0, 10);
  }

  // ----- Derived (needed before generateNext...) -----
  const currentOdo = useMemo(() => {
    const tMax = latestOdoFromTrips(trips);
    const lMax = latestOdoFromEntries(entries);
    if (tMax == null && lMax == null) return null;
    if (tMax == null) return lMax;
    if (lMax == null) return tMax;
    return Math.max(tMax, lMax);
  }, [trips, entries]);

  async function generateNextFromRecurringTokens(sourceReminderNotes, completedDateISO, odoAtCompletion) {
    const cat = parseReminderCategory(sourceReminderNotes) || "service";
    const recurDays = parseRecurDays(sourceReminderNotes);
    const recurKm = parseRecurKm(sourceReminderNotes);
    if (!recurDays && !recurKm) return;
    const pairId =
      recurDays && recurKm
        ? Math.random().toString(36).slice(2, 8) + "-" + Date.now().toString(36)
        : "";
    const baseTokens = [
      `(Type: ${cat})`,
      recurDays ? `(RecurDays: ${recurDays})` : "",
      recurKm ? `(RecurKm: ${recurKm})` : "",
      pairId ? `(Pair: ${pairId})` : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (recurDays) {
      const nextDate = addDaysISO(completedDateISO, recurDays);
      await api
        .post(`/vehicles/${id}/reminders`, { kind: "date", dueDate: nextDate, notes: baseTokens })
        .catch(() => {});
    }
    if (recurKm) {
      const odoBase = Number(odoAtCompletion ?? currentOdo ?? 0);
      const dueKm = odoBase + Number(recurKm);
      await api
        .post(`/vehicles/${id}/reminders`, { kind: "odometer", dueOdometer: dueKm, notes: baseTokens })
        .catch(() => {});
    }
  }

  // ----- Reminders CRUD -----
  async function addReminder(e) {
    e.preventDefault();
    setRErr("");
    setRInfo("");
    try {
      const typeToken = rForm.category ? ` (Type: ${rForm.category})` : "";
      const recurTokens =
        rForm.recurring && rForm.category === "service"
          ? `${rForm.recurDays ? ` (RecurDays: ${Number(rForm.recurDays)})` : ""}${
              rForm.recurKm ? ` (RecurKm: ${Number(rForm.recurKm)})` : ""
            }`
          : "";
      const payload = {
        kind: rForm.kind,
        dueDate: rForm.kind === "date" ? rForm.dueDate : undefined,
        dueOdometer: rForm.kind === "odometer" ? Number(rForm.dueOdometer) : undefined,
        notes: `${rForm.notes || ""}${typeToken}${recurTokens}`.trim(),
      };
      const { data } = await api.post(`/vehicles/${id}/reminders`, payload);
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
      setRForm({
        kind: "date",
        category: "service",
        dueDate: "",
        dueOdometer: "",
        notes: "",
        recurring: false,
        recurDays: "",
        recurKm: "",
      });
      setRInfo("Reminder added.");
    } catch (e) {
      setRErr(e?.response?.data?.error || String(e));
    }
  }
  async function toggleReminderActive(rid, active) {
    try {
      const { data } = await api.put(`/vehicles/${id}/reminders/${rid}`, { active });
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
    } catch (e) {
      setRErr(e?.response?.data?.error || String(e));
    }
  }
  async function deleteReminder(rid) {
    if (!confirm("Delete this reminder?")) return;
    try {
      const { data } = await api.delete(`/vehicles/${id}/reminders/${rid}`);
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
    } catch (e) {
      setRErr(e?.response?.data?.error || String(e));
    }
  }

  // Reminders inline edit helpers
  function beginEditReminder(r) {
    const baseNotes = (r.notes || "")
      .replace(/\(\s*Type:\s*[^)]+?\)\s*/i, "")
      .replace(/\(\s*Completed:\s*[^)]+?\)\s*/i, "")
      .replace(/\(\s*RecurDays:\s*[^)]+?\)\s*/i, "")
      .replace(/\(\s*RecurKm:\s*[^)]+?\)\s*/i, "")
      .replace(/\(\s*Pair:\s*[^)]+?\)\s*/i, "")
      .trim();
    const recurDays = parseRecurDays(r.notes || "");
    const recurKm = parseRecurKm(r.notes || "");
    setREditId(r._id);
    setREditForm({
      kind: r.kind,
      category: parseReminderCategory(r.notes || "") || "service",
      dueDate: r.kind === "date" && r.dueDate ? new Date(r.dueDate).toISOString().slice(0, 10) : "",
      dueOdometer: r.kind === "odometer" && r.dueOdometer != null ? String(r.dueOdometer) : "",
      notes: baseNotes,
      _completedToken: parseReminderCompletedOn(r.notes || "") || "",
      recurring: recurDays || recurKm ? true : false,
      recurDays: recurDays ? String(recurDays) : "",
      recurKm: recurKm ? String(recurKm) : "",
    });
  }
  function cancelEditReminder() {
    setREditId("");
    setREditForm({
      kind: "date",
      category: "service",
      dueDate: "",
      dueOdometer: "",
      notes: "",
      _completedToken: "",
      recurring: false,
      recurDays: "",
      recurKm: "",
    });
  }
  async function saveEditReminder() {
    if (!rEditId) return;
    setRErr("");
    setRInfo("");
    try {
      const original = reminders.find((x) => String(x._id) === String(rEditId));
      const completedToken =
        rEditForm._completedToken || parseReminderCompletedOn(original?.notes || "") || "";
      const typeToken = rEditForm.category ? ` (Type: ${rEditForm.category})` : "";
      const completedTag = completedToken ? ` (Completed: ${completedToken})` : "";
      const recurTokens =
        rEditForm.recurring && rEditForm.category === "service"
          ? `${rEditForm.recurDays ? ` (RecurDays: ${Number(rEditForm.recurDays)})` : ""}${
              rEditForm.recurKm ? ` (RecurKm: ${Number(rEditForm.recurKm)})` : ""
            }`
          : "";
      const newNotes = `${rEditForm.notes || ""}${typeToken}${recurTokens}${completedTag}`.trim();
      const patch = { notes: newNotes };
      if (original?.kind === "date") patch.dueDate = rEditForm.dueDate || "";
      if (original?.kind === "odometer")
        patch.dueOdometer = rEditForm.dueOdometer !== "" ? Number(rEditForm.dueOdometer) : null;
      const { data } = await api.put(`/vehicles/${id}/reminders/${rEditId}`, patch);
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
      setRInfo("Reminder updated.");
      cancelEditReminder();
    } catch (e2) {
      setRErr(e2?.response?.data?.error || String(e2));
    }
  }

  // ----- Logbook CRUD -----
  async function createEntry(e) {
    e?.preventDefault?.();
    setLbErr("");
    setLbInfo("");
    try {
      const tagList = (lbForm.tags || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const costNum = lbForm.cost !== "" ? Number(lbForm.cost) : undefined;
      const odoNum = lbForm.odometer !== "" ? Number(lbForm.odometer) : undefined;
      const title =
        (lbForm.type || "other").charAt(0).toUpperCase() + (lbForm.type || "other").slice(1);
      const prettyCost = Number.isFinite(costNum) ? ` (Cost: ${costNum})` : "";
      const prettyVendor = lbForm.vendor ? ` (Vendor: ${lbForm.vendor})` : "";
      const combinedNotes = `${lbForm.notes || ""}${prettyVendor}${prettyCost}`.trim();
      const payload = {
        vehicleId: id,
        title,
        type: lbForm.type,
        vendor: lbForm.vendor,
        cost: costNum,
        notes: combinedNotes,
        tags: [lbForm.type, ...tagList],
        ts: lbForm.ts ? new Date(lbForm.ts).toISOString() : undefined,
        odometerStart: odoNum,
        odometerEnd: odoNum,
        odometer: odoNum,
      };

      const data = await apiCreateLogbookEntry(payload);

      setEntries((prev) => [data, ...prev]);
      if (lbForm.completeReminderId) {
        const r = (reminders || []).find((x) => String(x._id) === String(lbForm.completeReminderId));
        const existingNotes = r?.notes || "";
        const completedDate = lbForm.ts ? lbForm.ts.slice(0, 10) : new Date().toISOString().slice(0, 10);
        const withoutCompleted = existingNotes.replace(/\(\s*Completed:\s*[^)]+?\)\s*/i, "");
        const newNotes = `${withoutCompleted} (Completed: ${completedDate})`.trim();
        await api.put(`/vehicles/${id}/reminders/${lbForm.completeReminderId}`, {
          active: false,
          notes: newNotes,
        });
        const pairId = parsePairId(existingNotes);
        if (pairId) {
          const siblings = (reminders || []).filter(
            (rr) =>
              rr.active &&
              String(rr._id) !== String(lbForm.completeReminderId) &&
              parsePairId(rr.notes || "") === pairId
          );
          for (const sib of siblings) {
            const sibBase = (sib.notes || "").replace(/\(\s*Completed:\s*[^)]+?\)\s*/i, "").trim();
            const sibNote = `${sibBase} (Completed: ${completedDate})`.trim();
            await api.put(`/vehicles/${id}/reminders/${sib._id}`, { active: false, notes: sibNote }).catch(() => {});
          }
        }
        const odoForNext = lbForm.odometer !== "" ? Number(lbForm.odometer) : currentOdo;
        await generateNextFromRecurringTokens(existingNotes, completedDate, odoForNext);
        await loadReminders();
      }
      setLbForm({
        type: "service",
        ts: new Date().toISOString().slice(0, 16),
        odometer: "",
        cost: "",
        vendor: "",
        tags: "",
        notes: "",
        completeReminderId: "",
      });
      setLbInfo("Log entry added.");
      setLbModalOpen(false);
    } catch (e2) {
      setLbErr(e2?.response?.data?.error || String(e2));
    }
  }
  async function deleteEntry(entryId) {
    if (!confirm("Delete this log entry?")) return;
    setLbErr("");
    setLbInfo("");
    try {
      await apiDeleteLogbookEntry(entryId);
      setEntries((prev) => prev.filter((x) => x._id !== entryId));
      setLbInfo("Log entry deleted.");
    } catch (e2) {
      setLbErr(e2?.response?.data?.error || String(e2));
    }
  }
  function beginEditEntry(entry) {
    const d = entryDisplay(entry);
    const tagRest = (entry.tags || []).filter((t) => t && t.toLowerCase() !== (d.type || "").toLowerCase());
    setLbEditId(entry._id);
    setLbEditForm({
      type: d.type || "other",
      ts: entry.ts ? new Date(entry.ts).toISOString().slice(0, 16) : new Date().toISOString().slice(0, 16),
      odometer: d.odometer ?? "",
      cost: d.cost ?? "",
      vendor: d.vendor ?? "",
      tags: tagRest.join(", "),
      notes: d.notes || "",
    });
  }
  function cancelLbEdit() {
    setLbEditId("");
    setLbEditForm({ type: "service", ts: "", odometer: "", cost: "", vendor: "", tags: "", notes: "" });
  }
  async function saveLbEdit() {
    if (!lbEditId) return;
    setLbErr("");
    setLbInfo("");
    try {
      const tagList = (lbEditForm.tags || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const costNum = lbEditForm.cost !== "" ? Number(lbEditForm.cost) : undefined;
      const odoNum = lbEditForm.odometer !== "" ? Number(lbEditForm.odometer) : undefined;
      const title =
        (lbEditForm.type || "other").charAt(0).toUpperCase() + (lbEditForm.type || "other").slice(1);
      const prettyCost = Number.isFinite(costNum) ? ` (Cost: ${costNum})` : "";
      const prettyVendor = lbEditForm.vendor ? ` (Vendor: ${lbEditForm.vendor})` : "";
      const combinedNotes = `${lbEditForm.notes || ""}${prettyVendor}${prettyCost}`.trim();
      const patch = {
        title,
        type: lbEditForm.type,
        vendor: lbEditForm.vendor,
        cost: costNum,
        notes: combinedNotes,
        tags: [lbEditForm.type, ...tagList],
        ts: lbEditForm.ts ? new Date(lbEditForm.ts).toISOString() : undefined,
        odometerStart: odoNum,
        odometerEnd: odoNum,
        odometer: odoNum,
      };

      const data = await apiUpdateLogbookEntry(lbEditId, patch);

      setEntries((prev) => prev.map((x) => (String(x._id) === String(lbEditId) ? data : x)));
      setLbInfo("Log entry updated.");
      cancelLbEdit();
    } catch (e2) {
      setLbErr(e2?.response?.data?.error || String(e2));
    }
  }

  // NEW: Usage helpers (private/business) inferred from tags or explicit field
  function getUsageFromTrip(t) {
    const tags = (t?.tags || []).map((x) => String(x).toLowerCase());
    if (String(t?.usage || "").toLowerCase() === "private") return "private";
    if (String(t?.usage || "").toLowerCase() === "business") return "business";
    if (tags.includes("private")) return "private";
    if (tags.includes("business")) return "business";
    return "business";
  }

  /* ---------------- Trips actions ---------------- */
  async function handleStartTrip(e) {
    e?.preventDefault?.();
    setTripModalErr("");
    setTripErr("");
    setTripInfo("");

    // basic client-side check
    const s = Number(odoStart);
    if (!Number.isFinite(s) || s < 0) {
      setTripModalErr("Enter a valid odometer start.");
      return;
    }

    try {
      let startPhotoUrl;
      if (startFile) {
        const { url } = await uploadTripPhoto(startFile);
        startPhotoUrl = normalizeStoredUrl(url);
      }
      const g = await getGeo().catch(() => null);
      const usageTag = tripUsage === "private" ? "private" : "business";
      const payload = {
        odoStart: s,
        projectId: tripProjectId || undefined,
        taskId: tripTaskId || undefined,
        startPhotoUrl,
        tags: [usageTag], // put usage in tags for visibility
        ...(g
          ? {
              startLocation: { type: "Point", coordinates: [g.lng, g.lat] },
              startLng: g.lng,
              startLat: g.lat,
              startAccuracy: g.accuracy,
            }
          : {}),
      };
      await startTrip(id, payload);
      setOdoStart("");
      setStartFile(null);
      setTripNotes("");
      setTripUsage("business");
      await loadTrips();
      setTripInfo("Trip started.");
      setTimeout(() => setTripInfo(""), 1500);
      setStartTripOpen(false);
    } catch (e2) {
      // IMPORTANT: show errors inside the lightbox
      setTripModalErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function handleEndTrip(e) {
    e?.preventDefault?.();
    if (!openTrip) return;

    setTripModalErr("");
    setTripErr("");
    setTripInfo("");

    // client-side validation so the error appears IN the lightbox
    const start = Number(openTrip?.odoStart);
    const end = Number(odoEnd);

    if (!Number.isFinite(end) || end < 0) {
      setTripModalErr("Enter a valid odometer end.");
      return;
    }
    if (Number.isFinite(start) && end < start) {
      setTripModalErr(`Odometer end cannot be lower than the start (${start}).`);
      return;
    }

    try {
      let endPhotoUrl;
      if (endFile) {
        const { url } = await uploadTripPhoto(endFile);
        endPhotoUrl = normalizeStoredUrl(url);
      }
      const g = await getGeo().catch(() => null);
      const patch = {
        odoEnd: end,
        endPhotoUrl,
        ...(tripNotes && tripNotes.trim() ? { notes: tripNotes.trim() } : {}),
        ...(g
          ? {
              endLocation: { type: "Point", coordinates: [g.lng, g.lat] },
              endLng: g.lng,
              endLat: g.lat,
              endAccuracy: g.accuracy,
            }
          : {}),
      };
      await endTrip(id, openTrip._id, patch);
      setOdoEnd("");
      setEndFile(null);
      setTripNotes("");
      await loadTrips();
      setTripInfo("Trip ended.");
      setTimeout(() => setTripInfo(""), 1500);
      setEndTripOpen(false);
    } catch (e2) {
      // IMPORTANT: show errors inside the lightbox
      setTripModalErr(e2?.response?.data?.error || String(e2));
    }
  }

  // Trip inline edit helpers
  async function apiUpdateTrip(_vehId, tripId, patch) {
    return compatUpdateTrip(tripId, patch, { vehicleId: _vehId });
  }
  function beginEditTrip(t) {
    setTripInfo("");
    setTripErr("");
    setTripEditId(t._id);
    setTripEditForm({
      startedAt: t.startedAt ? new Date(t.startedAt).toISOString().slice(0, 16) : "",
      endedAt: t.endedAt ? new Date(t.endedAt).toISOString().slice(0, 16) : "",
      odoStart: t.odoStart ?? "",
      odoEnd: t.odoEnd ?? "",
      driverUserId: String(t.driverUserId || t.driverId || ""),
      projectId: String(t.projectId || ""),
      taskId: String(t.taskId || ""),
      notes: t.notes || "",
      usage: getUsageFromTrip(t),
    });
  }
  function cancelEditTrip() {
    setTripEditId("");
    setTripEditForm({
      startedAt: "",
      endedAt: "",
      odoStart: "",
      odoEnd: "",
      driverUserId: "",
      projectId: "",
      taskId: "",
      notes: "",
      usage: "business",
    });
  }
  async function saveEditTrip() {
    if (!tripEditId || tripSaving) return;
    setTripErr("");
    setTripInfo("");
    setTripSaving(true);
    try {
      const usageTag = tripEditForm.usage === "private" ? "private" : "business";
      const patch = {
        startedAt: tripEditForm.startedAt ? new Date(tripEditForm.startedAt).toISOString() : undefined,
        endedAt: tripEditForm.endedAt ? new Date(tripEditForm.endedAt).toISOString() : undefined,
        odoStart: tripEditForm.odoStart !== "" ? Number(tripEditForm.odoStart) : undefined,
        odoEnd: tripEditForm.odoEnd !== "" ? Number(tripEditForm.odoEnd) : undefined,
        driverUserId: tripEditForm.driverUserId || undefined,
        driverId: tripEditForm.driverUserId || undefined,
        projectId: tripEditForm.projectId || undefined,
        taskId: tripEditForm.taskId || undefined,
        notes: tripEditForm.notes || undefined,
        tags: [usageTag],
        usage: usageTag,
      };
      await apiUpdateTrip(id, tripEditId, patch);
      await loadTrips();
      setTripInfo("Trip updated.");
      setTimeout(() => setTripInfo(""), 1500);
      cancelEditTrip();
    } catch (e2) {
      setTripErr(e2?.response?.data?.error || String(e2));
    } finally {
      setTripSaving(false);
    }
  }

  // ---------- label wrappers ----------
  const userLabel = (x) => userLabelFrom(users, x);
  const projectLabel = (x) => projectLabelFrom(projects, x);
  const taskLabel = (x) => taskLabelFrom(tasks, x);

  // ----- Task filtering helpers -----
  const tasksForVehicleProject = useMemo(() => {
    const pid = v?.projectId || "";
    if (!pid) return tasks;
    return tasks.filter((t) => String(t.projectId) === String(pid));
  }, [tasks, v?.projectId]);

  const tasksForTripProject = useMemo(() => {
    const pid = tripProjectId || "";
    if (!pid) return tasks;
    return tasks.filter((t) => String(t.projectId) === String(pid));
  }, [tasks, tripProjectId]);

  const tasksForTripEditProject = useMemo(() => {
    const pid = tripEditForm.projectId || "";
    if (!pid) return tasks;
    return tasks.filter((t) => String(t.projectId) === String(pid));
  }, [tasks, tripEditForm.projectId]);

  const tasksForPurchaseProject = useMemo(() => {
    const pid = pForm.projectId || "";
    if (!pid) return tasks;
    return tasks.filter((t) => String(t.projectId) === String(pid));
  }, [tasks, pForm.projectId]);

  const tasksForPurchaseEditProject = useMemo(() => {
    const pid = editForm.projectId || "";
    if (!pid) return tasks;
    return tasks.filter((t) => String(t.projectId) === String(pid));
  }, [tasks, editForm.projectId]);

  function taskMatchesProject(tid, pid) {
    if (!tid) return true;
    if (!pid) return true;
    const t = tasks.find((x) => String(x._id) === String(tid));
    return t ? String(t.projectId) === String(pid) : false;
  }

  const lastServiceDate = useMemo(() => {
    const svc = (entries || [])
      .filter((e) => resolveEntryType(e) === "service" && e.ts)
      .sort((a, b) => new Date(b.ts) - new Date(a.ts));
    return svc[0]?.ts || null;
  }, [entries]);

  const tripDriverOptions = useMemo(() => {
    const ids = Array.from(new Set(trips.map((t) => t.driverUserId || t.driverId).filter(Boolean).map(String)));
    return ids.map((id2) => ({ id: id2, label: userLabel(id2) }));
  }, [trips, users]);

  const tripProjectOptions = useMemo(() => {
    const ids = Array.from(new Set(trips.map((t) => t.projectId).filter(Boolean).map(String)));
    return ids.map((id2) => ({ id: id2, label: projectLabel(id2) }));
  }, [trips, projects]);

  const tripTaskOptions = useMemo(() => {
    const ids = Array.from(new Set(trips.map((t) => t.taskId).filter(Boolean).map(String)));
    return ids.map((id2) => ({ id: id2, label: taskLabel(id2) }));
  }, [trips, tasks]);

  const filteredTrips = useMemo(() => {
    return trips.filter((t) => {
      if (tripDriverFilter && String(t.driverUserId || t.driverId) !== String(tripDriverFilter)) return false;
      if (tripProjectFilter && String(t.projectId) !== String(tripProjectFilter)) return false;
      if (tripTaskFilter && String(t.taskId) !== String(tripTaskFilter)) return false;
      if (tripDateFrom) {
        const from = new Date(tripDateFrom);
        if (t.startedAt && new Date(t.startedAt) < from) return false;
      }
      if (tripDateTo) {
        const to = new Date(tripDateTo);
        to.setHours(23, 59, 59, 999);
        if (t.startedAt && new Date(t.startedAt) > to) return false;
      }
      return true;
    });
  }, [trips, tripDriverFilter, tripProjectFilter, tripTaskFilter, tripDateFrom, tripDateTo]);

  // --------- Exports ----------
  function exportLogbookCsv() {
    const rows = [
      ["When", "Type", "Odometer (km)", "Cost", "Vendor", "Tags", "Notes"],
      ...entries.map((e) => {
        const d = entryDisplay(e);
        return [
          d.ts ? new Date(d.ts).toISOString() : "",
          d.type,
          d.odometer ?? "",
          d.cost ?? "",
          d.vendor ?? "",
          (d.tags || []).join("; "),
          (d.notes || "").replace(/\r?\n/g, " "),
        ];
      }),
    ];
    const csv = rows
      .map((r) =>
        r
          .map((cell) => {
            const s = String(cell ?? "");
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(",")
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vehicle_${id}_logbook.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Robust coordinate picker
  function pickLngLat(obj, prefix) {
    if (!obj) return null;
    if (obj.coordinates && Array.isArray(obj.coordinates) && obj.coordinates.length >= 2) {
      const [lng, lat] = obj.coordinates;
      if (Number.isFinite(Number(lng)) && Number.isFinite(Number(lat))) return [Number(lng), Number(lat)];
    }
    const cand = [
      [obj[`${prefix}Lng`], obj[`${prefix}Lat`]],
      [obj[`${prefix}Lon`], obj[`${prefix}Lat`]],
      [obj[`${prefix}Long`], obj[`${prefix}Lat`]],
      [obj[`${prefix}_lng`], obj[`${prefix}_lat`]],
      [obj[`${prefix}_lon`], obj[`${prefix}_lat`]],
      [obj[`${prefix}_long`], obj[`${prefix}_lat`]],
    ];
    for (const [lng, lat] of cand) {
      if (lng != null && lat != null && Number.isFinite(Number(lng)) && Number.isFinite(Number(lat))) {
        return [Number(lng), Number(lat)];
      }
    }
    const nested = obj[prefix];
    if (nested && nested.lng != null && nested.lat != null) {
      const { lng, lat } = nested;
      if (Number.isFinite(Number(lng)) && Number.isFinite(Number(lat))) return [Number(lng), Number(lat)];
    }
    return null;
  }

  // ADD: Export Trips CSV with usage + coordinates
  function exportTripCsv() {
    const rows = [
      [
        "Started",
        "Ended",
        "OdoStart",
        "OdoEnd",
        "Distance(km)",
        "Driver",
        "Project",
        "Task",
        "Usage",
        "StartLng",
        "StartLat",
        "EndLng",
        "EndLat",
        "Notes",
      ],
      ...filteredTrips.map((t) => {
        const start = pickLngLat(t.startLocation || {}, "") || pickLngLat(t, "start") || ["", ""];
        const end = pickLngLat(t.endLocation || {}, "") || pickLngLat(t, "end") || ["", ""];
        const usage = getUsageFromTrip(t);
        const who = userLabel(t.driverUserId || t.driverId);
        const proj = projectLabel(t.projectId);
        const task = taskLabel(t.taskId);
        const dist =
          t.distance ??
          (t.odoStart != null && t.odoEnd != null ? Math.max(0, Number(t.odoEnd) - Number(t.odoStart)) : "");
        return [
          t.startedAt ? new Date(t.startedAt).toISOString() : "",
          t.endedAt ? new Date(t.endedAt).toISOString() : "",
          t.odoStart ?? "",
          t.odoEnd ?? "",
          dist,
          who,
          proj,
          task,
          usage,
          start[0],
          start[1],
          end[0],
          end[1],
          (t.notes || "").replace(/\r?\n/g, " "),
        ];
      }),
    ];

    const csv = rows
      .map((r) =>
        r
          .map((cell) => {
            const s = String(cell ?? "");
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(",")
      )
      .join("\n");

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vehicle_${v?.reg || id}_trips.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // REPLACE: exportTripsKml with stronger coordinate discovery
  function exportTripsKml() {
    const esc = (s) => String(s ?? "").replace(/[<&>]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m]));
    const header = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Vehicle ${esc(v?.reg || id)} Trips</name>`;
    const footer = `</Document></kml>`;

    const items = filteredTrips.flatMap((t, i) => {
      const start =
        pickLngLat(t.startLocation || {}, "") ||
        pickLngLat(t, "start") ||
        pickLngLat({ start: { lng: t?.start?.lng, lat: t?.start?.lat } }, "start") ||
        null;

      const end =
        pickLngLat(t.endLocation || {}, "") ||
        pickLngLat(t, "end") ||
        pickLngLat({ end: { lng: t?.end?.lng, lat: t?.end?.lat } }, "end") ||
        null;

      const who = userLabel(t.driverUserId || t.driverId);
      const proj = projectLabel(t.projectId);
      const task = taskLabel(t.taskId);
      const usage = getUsageFromTrip(t);
      const dist =
        t.distance ??
        (t.odoStart != null && t.odoEnd != null ? Math.max(0, Number(t.odoEnd) - Number(t.odoStart)) : "");

      const desc = [
        `<b>Started</b>: ${t.startedAt ? new Date(t.startedAt).toLocaleString() : "—"}`,
        `<b>Ended</b>: ${t.endedAt ? new Date(t.endedAt).toLocaleString() : "—"}`,
        `<b>Odo</b>: ${t.odoStart ?? "—"} → ${t.odoEnd ?? "—"}`,
        `<b>Distance</b>: ${dist || "—"} km`,
        `<b>Driver</b>: ${esc(who)}`,
        `<b>Project</b>: ${esc(proj)}`,
        `<b>Task</b>: ${esc(task)}`,
        `<b>Usage</b>: ${esc(usage)}`,
        t.notes ? `<b>Notes</b>: ${esc(t.notes)}` : "",
      ]
        .filter(Boolean)
        .join("<br/>");

      const name = `Trip ${i + 1} ${t.startedAt ? new Date(t.startedAt).toISOString() : ""}`;

      if (start && end) {
        return [
          `<Placemark><name>${esc(name)}</name><description><![CDATA[${desc}]]></description><LineString><coordinates>${start[0]},${start[1]},0 ${end[0]},${end[1]},0</coordinates></LineString></Placemark>`,
          `<Placemark><name>${esc(name)} (Start)</name><Point><coordinates>${start[0]},${start[1]},0</coordinates></Point></Placemark>`,
          `<Placemark><name>${esc(name)} (End)</name><Point><coordinates>${end[0]},${end[1]},0</coordinates></Point></Placemark>`,
        ];
      }
      if (start) {
        return [
          `<Placemark><name>${esc(name)} (Start)</name><description><![CDATA[${desc}]]></description><Point><coordinates>${start[0]},${start[1]},0</coordinates></Point></Placemark>`,
        ];
      }
      if (end) {
        return [
          `<Placemark><name>${esc(name)} (End)</name><description><![CDATA[${desc}]]></description><Point><coordinates>${end[0]},${end[1]},0</coordinates></Point></Placemark>`,
        ];
      }
      return [`<Placemark><name>${esc(name)}</name><description><![CDATA[${desc}]]></description></Placemark>`];
    });

    const kml = `${header}\n${items.join("\n")}\n${footer}`;
    const blob = new Blob([kml], { type: "application/vnd.google-earth.kml+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vehicle_${v?.reg || id}_trips.kml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- Purchases helpers ----------
  function vendorLabel(vendor) {
    if (!vendor) return "—";
    if (typeof vendor === "string") return vendor;
    return vendor.name || vendor.title || vendor.company || String(vendor._id || vendor.id || "—");
  }
  async function apiCreateVendor(name) {
    const { data } = await api.post("/vendors", { name });
    return data;
  }
  async function apiUpdatePurchase(purchaseId, patch) {
    const { data } = await api.put(`/purchases/${purchaseId}`, patch);
    return data;
  }
  // Reuse trip uploader for receipts
  async function uploadPurchasePhoto(file) {
    if (!file) return null;
    try {
      const { url } = await uploadTripPhoto(file);
      return url ? { url: normalizeStoredUrl(url) } : null;
    } catch {
      return null;
    }
  }

  async function handleAddPurchase(e) {
    e?.preventDefault?.();
    setPErr("");
    setPInfo("");
    try {
      let vendorId = pForm.vendorId || "";
      let newVendor = null;
      if ((vendorId === "" || vendorId === "__new__") && pForm.newVendorName.trim()) {
        newVendor = await apiCreateVendor(pForm.newVendorName.trim());
        vendorId = newVendor?._id || newVendor?.id || "";
        await loadVendorsList();
      }
      let receiptPhotoUrl;
      if (pPhotoFile) {
        const up = await uploadPurchasePhoto(pPhotoFile);
        if (up?.url) receiptPhotoUrl = up.url;
      }
      const payload = {
        vehicleId: id,
        vendorId: vendorId || undefined,
        vendorName: !vendorId && pForm.newVendorName.trim() ? pForm.newVendorName.trim() : undefined,
        type: pForm.type,
        date: pForm.date ? new Date(pForm.date).toISOString() : undefined,
        cost: pForm.cost !== "" ? Number(pForm.cost) : undefined,
        projectId: pForm.projectId || undefined,
        taskId: pForm.taskId || undefined,
        notes: pForm.notes || "",
        ...(receiptPhotoUrl ? { receiptPhotoUrl } : {}),
      };
      const created = await createPurchase(payload);
      setPurchases((prev) => [created, ...prev]);
      setPForm({
        vendorId: "",
        newVendorName: "",
        type: "service",
        date: new Date().toISOString().slice(0, 10),
        cost: "",
        projectId: v?.projectId || "",
        taskId: v?.taskId || "",
        notes: "",
      });
      setPPhotoFile(null);
      setPInfo("Purchase added.");
      setPurchaseModalOpen(false);
    } catch (e2) {
      setPErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function handleDeletePurchase(rowId) {
    if (!confirm("Delete this purchase?")) return;
    setPErr("");
    setPInfo("");
    try {
      await deletePurchase(rowId);
      setPurchases((prev) => prev.filter((x) => x._id !== rowId));
      setPInfo("Purchase deleted.");
    } catch (e2) {
      setPErr(e2?.response?.data?.error || String(e2));
    }
  }

  function beginEditPurchase(p) {
    setEditId(p._id);
    setEditForm({
      vendorId: String(p.vendorId || p.vendor?._id || ""),
      newVendorName: "",
      type: p.type || "service",
      date: p.date ? new Date(p.date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      cost: p.cost ?? "",
      projectId: String(p.projectId || ""),
      taskId: String(p.taskId || ""),
      notes: p.notes || "",
    });
  }
  function cancelEdit() {
    setEditId("");
    setEditForm({
      vendorId: "",
      newVendorName: "",
      type: "service",
      date: "",
      cost: "",
      projectId: "",
      taskId: "",
      notes: "",
    });
    setEditPhotoFile(null);
  }

  async function saveEditPurchase() {
    if (!editId) return;
    setPErr("");
    setPInfo("");
    try {
      let vendorId = editForm.vendorId || "";
      if ((vendorId === "" || vendorId === "__new__") && editForm.newVendorName.trim()) {
        const vnew = await apiCreateVendor(editForm.newVendorName.trim());
        vendorId = vnew?._id || vnew?.id || "";
        await loadVendorsList();
      }
      let receiptPhotoUrl;
      if (editPhotoFile) {
        const up = await uploadPurchasePhoto(editPhotoFile);
        if (up?.url) receiptPhotoUrl = up.url;
      }
      const patch = {
        vendorId: vendorId || undefined,
        vendorName: !vendorId && editForm.newVendorName.trim() ? editForm.newVendorName.trim() : undefined,
        type: editForm.type,
        date: editForm.date ? new Date(editForm.date).toISOString() : undefined,
        cost: editForm.cost !== "" ? Number(editForm.cost) : undefined,
        projectId: editForm.projectId || undefined,
        taskId: editForm.taskId || undefined,
        notes: editForm.notes || "",
        ...(receiptPhotoUrl ? { receiptPhotoUrl } : {}),
      };
      const updated = await apiUpdatePurchase(editId, patch);
      setPurchases((prev) => prev.map((row) => (row._id === editId ? updated : row)));
      setPInfo("Purchase updated.");
      cancelEdit();
    } catch (e2) {
      setPErr(e2?.response?.data?.error || String(e2));
    }
  }

  const selectedDriverId = v?.driver?._id || v?.driverId || "";

  // ----- Handlers that keep project/task in sync -----
  function handleVehicleProjectChange(e) {
    const pid = e.target.value || "";
    const invalidTask = v?.taskId && !taskMatchesProject(v.taskId, pid);
    setV((prev) => ({
      ...prev,
      projectId: pid,
      taskId: invalidTask ? "" : prev.taskId,
      task: invalidTask ? undefined : prev.task,
    }));
    save({ projectId: pid ? pid : null, ...(invalidTask ? { taskId: null } : {}) });
  }

  // --- Section nav ---
  const sectionButtons = [
    { id: "meta", label: "Meta" },
    { id: "reminders", label: "Reminders" },
    { id: "trips", label: "Trips" },
    { id: "purchases", label: "Purchases" },
    { id: "logbook", label: "Logbook" },
  ];
  function scrollToSection(sectionId) {
    const el = document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ----- UI derived header bits -----
  const meta = useMemo(() => {
    const name = v ? v.name || v.displayName || [v.make, v.model].filter(Boolean).join(" ") || "Vehicle" : "Vehicle";
    return {
      name,
      vin: v?.vin ?? "—",
      reg: v?.reg ?? v?.registration ?? "—",
      year: v?.year ?? "—",
      type: v?.type ?? "—",
      status: v?.status || "active",
    };
  }, [v]);

  if (!v) {
    return (
      <div className="mx-auto max-w-7xl p-4">
        Loading… {err && <span style={{ color: "crimson" }}>({err})</span>}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl p-4 space-y-4">
      {/* Page header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{meta.name}</h1>
            <StatusBadge value={meta.status} />
          </div>
          <div className="mt-1 text-sm text-gray-600">
            VIN: <b>{meta.vin}</b> • Reg: <b>{meta.reg}</b> • Year: <b>{meta.year}</b> • Type: <b>{meta.type}</b>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-ghost" onClick={del}>
            Delete
          </button>
          <button className="btn" onClick={() => window.print()}>
            Print PDF
          </button>
          <button className="btn" onClick={() => navigate(-1)}>
            Back
          </button>
        </div>
      </div>

      {/* Key metrics */}
      <div className="rounded-xl border border-border bg-panel p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <Metric label="Odometer" value={currentOdo != null ? `${currentOdo.toLocaleString()} km` : "—"} />
          <Metric label="Last Service" value={lastServiceDate ? new Date(lastServiceDate).toLocaleDateString() : "—"} />
          <Metric label="Project" value={projectLabel(v.projectId)} />
          <Metric label="Driver" value={userLabel(v.driver || v.driverId)} />
        </div>
      </div>

      {/* Section buttons */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3" aria-label="Sections">
        {sectionButtons.map((s) => (
          <button key={s.id} type="button" onClick={() => scrollToSection(s.id)} className="btn btn-sm">
            {s.label}
          </button>
        ))}
      </div>

      {err && <div className="rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-sm">{err}</div>}
      {info && <div className="rounded-xl border border-green-200 bg-green-100 p-3 text-sm">{info}</div>}

      {/* -------- Meta -------- */}
      <div id="meta" className="grid gap-4 md:grid-cols-2 scroll-mt-20">
        {/* Meta card */}
        <div className="rounded-xl border border-border bg-panel p-3 space-y-3">
          <div className="text-lg font-semibold mb-1">Meta</div>

          <label className="block text-sm">
            Registration
            <input
              className="w-full"
              value={v.reg ?? ""}
              onChange={(e) => setV({ ...v, reg: e.target.value })}
              onBlur={() => save({ reg: v.reg || "" })}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              Make
              <input
                className="w-full"
                value={v.make ?? ""}
                onChange={(e) => setV({ ...v, make: e.target.value })}
                onBlur={() => save({ make: v.make || "" })}
              />
            </label>
            <label className="block text-sm">
              Model
              <input
                className="w-full"
                value={v.model ?? ""}
                onChange={(e) => setV({ ...v, model: e.target.value })}
                onBlur={() => save({ model: v.model || "" })}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              Year
              <input
                className="w-full"
                type="number"
                inputMode="numeric"
                min="1900"
                max="2100"
                value={v.year ?? ""}
                onChange={(e) => setV({ ...v, year: e.target.value })}
                onBlur={() => save({ year: v.year ? Number(v.year) : undefined })}
              />
            </label>
            <label className="block text-sm">
              VIN
              <input
                className="w-full"
                value={v.vin ?? ""}
                onChange={(e) => setV({ ...v, vin: e.target.value })}
                onBlur={() => save({ vin: v.vin || "" })}
                placeholder="e.g. 1HGBH41JXMN109186"
              />
            </label>
          </div>

          <label className="block text-sm">
            Type
            <input
              className="w-full"
              value={v.type ?? ""}
              onChange={(e) => setV({ ...v, type: e.target.value })}
              onBlur={() => save({ type: v.type || "", vehicleType: v.type || "" })}
              placeholder="e.g. Ute, Van, Truck"
            />
          </label>

          <label className="block text-sm">
            Project
            <select className="w-full" value={v.projectId || ""} onChange={handleVehicleProjectChange}>
              <option value="">— none —</option>
              {projects.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          {/* Driver */}
          <label className="block text-sm">
            Driver
            <div className="flex items-center gap-2">
              <select
                className="w-full"
                value={selectedDriverId}
                onChange={(e) => {
                  const val = e.target.value;
                  setV((prev) => ({ ...prev, driverId: val || "", driver: undefined }));
                  save({ driverId: val || null });
                }}
              >
                <option value="">— none —</option>
                {users.map((u) => (
                  <option key={u._id} value={u._id}>
                    {u.name || u.email || u.username}
                  </option>
                ))}
              </select>
              {selectedDriverId && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setV((prev) => ({ ...prev, driverId: "", driver: null }));
                    save({ driverId: null });
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            {selectedDriverId && <div className="mt-1 text-xs text-gray-600">Currently: {userLabel(v.driver || v.driverId)}</div>}
          </label>

          {/* Task allocation */}
          <label className="block text-sm">
            Task
            <div className="flex items-center gap-2">
              <select
                className="w-full"
                value={v?.task?._id || v?.taskId || ""}
                onChange={(e) => {
                  const val = e.target.value || "";
                  setV((prev) => ({ ...prev, taskId: val, task: undefined }));
                  save({ taskId: val || null });
                }}
              >
                <option value="">— none —</option>
                {tasksForVehicleProject.map((t) => (
                  <option key={t._id} value={t._id}>
                    {t.title || t._id}
                  </option>
                ))}
              </select>
              {(v?.task?._id || v?.taskId) && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => {
                    setV((prev) => ({ ...prev, taskId: "", task: null }));
                    save({ taskId: null });
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            {(v?.task?._id || v?.taskId) && (
              <div className="mt-1 text-xs">
                <Link className="link" to={`/tasks/${v?.task?._id || v?.taskId}`}>
                  Open task
                </Link>
              </div>
            )}
          </label>

          <label className="block text-sm">
            Status
            <div className="flex items-center gap-2">
              <StatusBadge value={v.status || "active"} />
              <select value={v.status || "active"} onChange={(e) => setStatus(e.target.value)}>
                <option value="active">active</option>
                <option value="workshop">workshop</option>
                <option value="retired">retired</option>
                <option value="stolen">stolen</option>
              </select>
            </div>
          </label>

          <div className="text-sm text-gray-600">
            Created: {v.createdAt ? new Date(v.createdAt).toLocaleString() : "—"}
            <br />
            Updated: {v.updatedAt ? new Date(v.updatedAt).toLocaleString() : "—"}
          </div>
        </div>

        {/* -------- Reminders (with Recurring) -------- */}
        <div id="reminders" className="rounded-xl border border-border bg-panel p-3 space-y-3 scroll-mt-20">
          <div className="flex items-center justify-between">
            <div className="text-lg font-semibold">Service Reminders</div>
            <button
              type="button"
              className={`chip ${showCompletedReminders ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-700"}`}
              onClick={() => setShowCompletedReminders((s) => !s)}
            >
              {showCompletedReminders ? "Hide completed" : "Show completed"}
            </button>
          </div>

          <div className="text-sm text-gray-700">
            {nextDue?.dateDue && (
              <span className="mr-3">
                Next date: <b>{new Date(nextDue.dateDue.dueDate).toLocaleDateString()}</b>
              </span>
            )}
            {nextDue?.odoDue && (
              <span className="mr-3">
                Next km: <b>{nextDue.odoDue.dueOdometer} km</b>
              </span>
            )}
            {currentOdo != null && (
              <span>
                Current ODO: <b>{currentOdo} km</b>
              </span>
            )}
          </div>

          {rErr && <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">{rErr}</div>}
          {rInfo && <div className="rounded border border-green-200 bg-green-100 p-2 text-sm">{rInfo}</div>}

          {/* Create */}
          <form onSubmit={addReminder} className="grid md:grid-cols-12 gap-2">
            <label className="text-sm md:col-span-2">
              Category
              <select className="w-full" value={rForm.category} onChange={(e) => setRForm({ ...rForm, category: e.target.value })}>
                {LOG_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm md:col-span-2">
              Type
              <select className="w-full" value={rForm.kind} onChange={(e) => setRForm({ ...rForm, kind: e.target.value })}>
                <option value="date">By date</option>
                <option value="odometer">By odometer</option>
              </select>
            </label>
            {rForm.kind === "date" ? (
              <label className="text-sm md:col-span-3">
                Due date
                <input className="w-full" type="date" value={rForm.dueDate} onChange={(e) => setRForm({ ...rForm, dueDate: e.target.value })} required />
              </label>
            ) : (
              <label className="text-sm md:col-span-3">
                Due km
                <input
                  className="w-full"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  value={rForm.dueOdometer}
                  onChange={(e) => setRForm({ ...rForm, dueOdometer: e.target.value })}
                  required
                />
              </label>
            )}
            <label className="text-sm md:col-span-5">
              Notes
              <input className="w-full" value={rForm.notes} onChange={(e) => setRForm({ ...rForm, notes: e.target.value })} />
            </label>

            {/* Recurring options for service */}
            {rForm.category === "service" && (
              <>
                <div className="md:col-span-12 border-t border-border my-2" />
                <label className="text-sm md:col-span-2 inline-flex items-center gap-2">
                  <input type="checkbox" checked={rForm.recurring} onChange={(e) => setRForm((f) => ({ ...f, recurring: e.target.checked }))} />
                  <span>Recurring</span>
                </label>
                <label className="text-sm md:col-span-2">
                  Every (days)
                  <input
                    className="w-full"
                    type="number"
                    min="0"
                    value={rForm.recurDays}
                    onChange={(e) => setRForm((f) => ({ ...f, recurDays: e.target.value }))}
                    placeholder="e.g. 365"
                    disabled={!rForm.recurring}
                  />
                </label>
                <label className="text-sm md:col-span-2">
                  Every (km)
                  <input
                    className="w-full"
                    type="number"
                    min="0"
                    value={rForm.recurKm}
                    onChange={(e) => setRForm((f) => ({ ...f, recurKm: e.target.value }))}
                    placeholder="e.g. 10000"
                    disabled={!rForm.recurring}
                  />
                </label>
                <div className="text-xs text-gray-600 md:col-span-6">
                  Set one or both. If both are set, the system pairs date+km reminders and will auto-close the sibling when one completes.
                </div>
              </>
            )}

            <div className="md:col-span-12">
              <button className="btn btn-primary" type="submit">
                Add reminder
              </button>
            </div>
          </form>

          {/* List */}
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-thead">
                <HeaderRow headers={["Category", "Type", "Due", "Notes", "Active", "Status", "Actions"]} />
              </thead>
              <tbody>
                {(reminders || [])
                  .filter((r) => {
                    const s = reminderStatus(r, currentOdo);
                    return showCompletedReminders ? true : s.code !== "completed";
                  })
                  .map((r) => {
                    const cat = parseReminderCategory(r.notes || "") || "—";
                    const s = reminderStatus(r, currentOdo);
                    const completedOn = parseReminderCompletedOn(r.notes || "");
                    const rowTintStyle =
                      s.code === "overdue"
                        ? { backgroundColor: "#fee2e2" }
                        : s.code === "due-soon"
                        ? { backgroundColor: "#fffbeb" }
                        : {};
                    const isEditing = rEditId === r._id;
                    return (
                      <tr key={r._id} style={rowTintStyle}>
                        <td className="border-b border-border p-2">
                          {!isEditing ? (
                            cat
                          ) : (
                            <select
                              className="p-1 border border-border rounded"
                              value={rEditForm.category}
                              onChange={(e) => setREditForm((f) => ({ ...f, category: e.target.value }))}
                            >
                              {LOG_TYPES.map((t) => (
                                <option key={t} value={t}>
                                  {t}
                                </option>
                              ))}
                            </select>
                          )}
                        </td>
                        <td className="border-b border-border p-2">{r.kind}</td>
                        <td className="border-b border-border p-2">
                          {!isEditing ? (
                            r.kind === "date"
                              ? r.dueDate
                                ? new Date(r.dueDate).toLocaleDateString()
                                : "—"
                              : r.dueOdometer != null
                              ? `${r.dueOdometer} km`
                              : "—"
                          ) : r.kind === "date" ? (
                            <input
                              className="p-1 border border-border rounded"
                              type="date"
                              value={rEditForm.dueDate}
                              onChange={(e) => setREditForm((f) => ({ ...f, dueDate: e.target.value }))}
                            />
                          ) : (
                            <input
                              className="p-1 border border-border rounded w-28"
                              type="number"
                              inputMode="numeric"
                              min="0"
                              value={rEditForm.dueOdometer}
                              onChange={(e) => setREditForm((f) => ({ ...f, dueOdometer: e.target.value }))}
                            />
                          )}
                        </td>
                        <td className="border-b border-border p-2">
                          {!isEditing ? (
                            stripReminderTokens(r.notes || "—") || "—"
                          ) : (
                            <div className="flex flex-col gap-2">
                              <input
                                className="p-1 border border-border rounded w-full"
                                value={rEditForm.notes}
                                onChange={(e) => setREditForm((f) => ({ ...f, notes: e.target.value }))}
                              />
                              {rEditForm.category === "service" && (
                                <div className="flex items-end gap-2 text-xs">
                                  <label className="inline-flex items-center gap-1">
                                    <input
                                      type="checkbox"
                                      checked={rEditForm.recurring}
                                      onChange={(e) => setREditForm((f) => ({ ...f, recurring: e.target.checked }))}
                                    />
                                    <span>Recurring</span>
                                  </label>
                                  <label>
                                    Days:&nbsp;
                                    <input
                                      className="p-1 border border-border rounded w-20"
                                      type="number"
                                      min="0"
                                      value={rEditForm.recurDays}
                                      onChange={(e) => setREditForm((f) => ({ ...f, recurDays: e.target.value }))}
                                      disabled={!rEditForm.recurring}
                                    />
                                  </label>
                                  <label>
                                    Km:&nbsp;
                                    <input
                                      className="p-1 border border-border rounded w-24"
                                      type="number"
                                      min="0"
                                      value={rEditForm.recurKm}
                                      onChange={(e) => setREditForm((f) => ({ ...f, recurKm: e.target.value }))}
                                      disabled={!rEditForm.recurring}
                                    />
                                  </label>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="border-b border-border p-2">
                          {s.code === "completed" ? (
                            <span className="text-xs">Completed{completedOn ? ` on ${completedOn}` : ""}</span>
                          ) : (
                            <label className="inline-flex items-center gap-2">
                              <input type="checkbox" checked={!!r.active} onChange={(e) => toggleReminderActive(r._id, e.target.checked)} />
                              <span className="text-xs">{r.active ? "active" : "paused"}</span>
                            </label>
                          )}
                        </td>
                        <td className="border-b border-border p-2">
                          <span className={`text-xs px-2 py-1 rounded ${s.badgeClass}`}>{s.label}</span>
                        </td>
                        <td className="border-b border-border p-2 text-right">
                          {!isEditing ? (
                            <>
                              <button type="button" className="btn btn-sm mr-1" onClick={() => beginEditReminder(r)}>
                                Edit
                              </button>
                              <button type="button" className="btn btn-sm" onClick={() => deleteReminder(r._id)}>
                                Delete
                              </button>
                            </>
                          ) : (
                            <>
                              <button type="button" className="btn btn-sm mr-1" onClick={saveEditReminder}>
                                Save
                              </button>
                              <button type="button" className="btn btn-sm" onClick={cancelEditReminder}>
                                Cancel
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                {(!reminders || reminders.length === 0) && (
                  <tr>
                    <td className="p-4 text-center" colSpan={7}>
                      No reminders
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ---------------- Vehicle Trips ---------------- */}
      <div id="trips" className="rounded-xl border border-border bg-panel p-3 space-y-3 scroll-mt-20">
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">Vehicle Trips</div>
          <div className="flex items-center gap-2">
            {!openTrip ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setTripModalErr("");
                  setStartTripOpen(true);
                }}
              >
                Start trip
              </button>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setTripModalErr("");
                  setEndTripOpen(true);
                }}
              >
                End trip
              </button>
            )}
            <button className="btn" onClick={exportTripsKml} disabled={!filteredTrips.length} title={!filteredTrips.length ? "No trips to export" : "Export trips to KML"} type="button">
              Export KML
            </button>
            <button className="btn" onClick={exportTripCsv} disabled={!filteredTrips.length} title={!filteredTrips.length ? "No trips to export" : "Export trips to CSV"} type="button">
              Export CSV
            </button>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {tripsLoading && <div className="text-sm text-gray-500">Loading…</div>}

            {/* IMPORTANT: only show tripErr in the card when no trip modal is open */}
            {!startTripOpen && !endTripOpen && tripErr && (
              <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">{tripErr}</div>
            )}

            {tripInfo && <div className="rounded border border-green-200 bg-green-100 p-2 text-sm">{tripInfo}</div>}
          </div>
        </div>

        {/* Trip Filters */}
        <fieldset className="rounded-xl border border-border p-3">
          <legend className="px-2 text-xs uppercase tracking-wide text-gray-600">Trip Filters</legend>
          <div className="flex flex-wrap gap-2 items-end">
            <label className="text-sm">
              Driver
              <select className="w-48" value={tripDriverFilter} onChange={(e) => setTripDriverFilter(e.target.value)}>
                <option value="">Any</option>
                {tripDriverOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Project
              <select className="w-48" value={tripProjectFilter} onChange={(e) => setTripProjectFilter(e.target.value)}>
                <option value="">Any</option>
                {tripProjectOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Task
              <select className="w-48" value={tripTaskFilter} onChange={(e) => setTripTaskFilter(e.target.value)}>
                <option value="">Any</option>
                {tripTaskOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              From
              <input className="w-44" type="date" value={tripDateFrom} onChange={(e) => setTripDateFrom(e.target.value)} />
            </label>
            <label className="text-sm">
              To
              <input className="w-44" type="date" value={tripDateTo} onChange={(e) => setTripDateTo(e.target.value)} />
            </label>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setTripDriverFilter("");
                setTripProjectFilter("");
                setTripTaskFilter("");
                setTripDateFrom("");
                setTripDateTo("");
              }}
            >
              Clear filters
            </button>
            <div className="text-sm text-gray-600 ml-auto">
              Showing <b>{filteredTrips.length}</b> of {trips.length}
            </div>
          </div>
        </fieldset>

        {/* Trip list with inline edit */}
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-thead">
              <HeaderRow headers={["Started", "Ended", "ODO", "Driver", "Project", "Task", "Usage", "Distance", "Photos", "Notes", "Actions"]} />
            </thead>
            <tbody>
              {filteredTrips.length ? (
                filteredTrips.map((trip) => {
                  const isEditing = tripEditId === trip._id;
                  const isOpenRow = openTrip && String(openTrip._id) === String(trip._id);
                  const usage = getUsageFromTrip(trip);
                  return (
                    <tr key={trip._id}>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          trip.startedAt ? new Date(trip.startedAt).toLocaleString() : "—"
                        ) : (
                          <input
                            className="p-1 border border-border rounded"
                            type="datetime-local"
                            value={tripEditForm.startedAt}
                            onChange={(e) => setTripEditForm((f) => ({ ...f, startedAt: e.target.value }))}
                          />
                        )}
                      </td>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          trip.endedAt ? new Date(trip.endedAt).toLocaleString() : "—"
                        ) : (
                          <input
                            className="p-1 border border-border rounded"
                            type="datetime-local"
                            value={tripEditForm.endedAt}
                            onChange={(e) => setTripEditForm((f) => ({ ...f, endedAt: e.target.value }))}
                          />
                        )}
                      </td>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          <>
                            {trip.odoStart ?? "—"} → {trip.odoEnd ?? "—"}
                          </>
                        ) : (
                          <div className="flex items-center gap-1">
                            <input
                              className="p-1 border border-border rounded w-24"
                              type="number"
                              inputMode="numeric"
                              value={tripEditForm.odoStart}
                              onChange={(e) => setTripEditForm((f) => ({ ...f, odoStart: e.target.value }))}
                              placeholder="start"
                            />
                            <span>→</span>
                            <input
                              className="p-1 border border-border rounded w-24"
                              type="number"
                              inputMode="numeric"
                              value={tripEditForm.odoEnd}
                              onChange={(e) => setTripEditForm((f) => ({ ...f, odoEnd: e.target.value }))}
                              placeholder="end"
                            />
                          </div>
                        )}
                      </td>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          userLabel(trip.driverUserId || trip.driverId)
                        ) : (
                          <select
                            className="p-1 border border-border rounded"
                            value={tripEditForm.driverUserId}
                            onChange={(e) => setTripEditForm((f) => ({ ...f, driverUserId: e.target.value }))}
                          >
                            <option value="">— none —</option>
                            {users.map((u) => (
                              <option key={u._id} value={u._id}>
                                {u.name || u.email || u.username}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          trip.projectId ? (
                            <Link className="link" to={`/projects/${trip.projectId}`}>
                              {projectLabel(trip.projectId)}
                            </Link>
                          ) : (
                            "—"
                          )
                        ) : (
                          <select
                            className="p-1 border border-border rounded"
                            value={tripEditForm.projectId}
                            onChange={(e) => {
                              const pid = e.target.value || "";
                              setTripEditForm((f) => ({
                                ...f,
                                projectId: pid,
                                taskId: f.taskId && !taskMatchesProject(f.taskId, pid) ? "" : f.taskId,
                              }));
                            }}
                          >
                            <option value="">— none —</option>
                            {projects.map((p) => (
                              <option key={p._id} value={p._id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          trip.taskId ? (
                            <Link className="link" to={`/tasks/${trip.taskId}`}>
                              {taskLabel(trip.taskId)}
                            </Link>
                          ) : (
                            "—"
                          )
                        ) : (
                          <select
                            className="p-1 border border-border rounded"
                            value={tripEditForm.taskId}
                            onChange={(e) => setTripEditForm((f) => ({ ...f, taskId: e.target.value }))}
                          >
                            <option value="">— none —</option>
                            {tasksForTripEditProject.map((t) => (
                              <option key={t._id} value={t._id}>
                                {t.title}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          usage
                        ) : (
                          <select className="p-1 border border-border rounded" value={tripEditForm.usage} onChange={(e) => setTripEditForm((f) => ({ ...f, usage: e.target.value }))}>
                            <option value="business">business</option>
                            <option value="private">private</option>
                          </select>
                        )}
                      </td>
                      <td className="border-b border-border p-2">{trip.distance != null ? `${trip.distance} km` : "—"}</td>
                      <td className="border-b border-border p-2">
  <div className="flex gap-2">
    {(() => {
      const sUrl = tripPhotoUrl(trip, "start");
      return sUrl ? (
        <a href={sUrl} target="_blank" rel="noreferrer" title="Start photo">
          <img
            src={sUrl}
            alt="Start"
            style={{ width: 72, height: 48, objectFit: "cover", borderRadius: 6 }}
          />
        </a>
      ) : null;
    })()}
    {(() => {
      const eUrl = tripPhotoUrl(trip, "end");
      return eUrl ? (
        <a href={eUrl} target="_blank" rel="noreferrer" title="End photo">
          <img
            src={eUrl}
            alt="End"
            style={{ width: 72, height: 48, objectFit: "cover", borderRadius: 6 }}
          />
        </a>
      ) : null;
    })()}
  </div>
</td>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          trip.notes || "—"
                        ) : (
                          <input className="p-1 border border-border rounded w-full" value={tripEditForm.notes} onChange={(e) => setTripEditForm((f) => ({ ...f, notes: e.target.value }))} />
                        )}
                      </td>
                      <td className="border-b border-border p-2 text-right">
                        {!isEditing ? (
                          !isOpenRow ? (
                            <button type="button" className="btn btn-sm" onClick={() => beginEditTrip(trip)}>
                              Edit
                            </button>
                          ) : (
                            <span className="text-xs text-gray-500">End trip to edit</span>
                          )
                        ) : (
                          <>
                            <button type="button" className="btn btn-sm mr-1" onClick={saveEditTrip} disabled={tripSaving} title={tripSaving ? "Saving…" : "Save changes"}>
                              {tripSaving ? "Saving…" : "Save"}
                            </button>
                            <button type="button" className="btn btn-sm" onClick={cancelEditTrip} disabled={tripSaving}>
                              Cancel
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td className="p-3 text-center" colSpan={11}>
                    No trips match filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- Purchases ---------------- */}
      <div id="purchases" className="rounded-xl border border-border bg-panel p-3 space-y-3 scroll-mt-20">
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">Purchases</div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn" onClick={() => setPurchaseModalOpen(true)}>
              Add purchase
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {pErr && <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">{pErr}</div>}
          {pInfo && <div className="rounded border border-green-200 bg-green-100 p-2 text-sm">{pInfo}</div>}
        </div>

        {/* Purchases list */}
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-thead">
              <HeaderRow headers={["Date", "Type", "Vendor", "Cost", "Project", "Task", "Notes", "Receipt", "Actions"]} />
            </thead>
            <tbody>
              {purchases.length ? (
                purchases.map((p) => {
                  const isEditing = editId === p._id;
                  return (
                    <tr key={p._id}>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          p.date ? new Date(p.date).toLocaleDateString() : "—"
                        ) : (
                          <input className="p-1 border border-border rounded w-36" type="date" value={editForm.date} onChange={(e) => setEditForm((f) => ({ ...f, date: e.target.value }))} />
                        )}
                      </td>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          p.type || "—"
                        ) : (
                          <select className="p-1 border border-border rounded" value={editForm.type} onChange={(e) => setEditForm((f) => ({ ...f, type: e.target.value }))}>
                            {PURCHASE_TYPES.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          vendorLabel(p.vendor)
                        ) : (
                          <div className="flex items-center gap-2">
                            <select className="p-1 border border-border rounded" value={editForm.vendorId} onChange={(e) => setEditForm((f) => ({ ...f, vendorId: e.target.value }))}>
                              <option value="">— none —</option>
                              {vendors.map((vnd) => (
                                <option key={vnd._id || vnd.id} value={vnd._id || vnd.id}>
                                  {vnd.name}
                                </option>
                              ))}
                              <option value="__new__">+ Add new vendor…</option>
                            </select>
                            {(editForm.vendorId === "" || editForm.vendorId === "__new__") && (
                              <input className="p-1 border border-border rounded" placeholder="New vendor" value={editForm.newVendorName} onChange={(e) => setEditForm((f) => ({ ...f, newVendorName: e.target.value }))} />
                            )}
                          </div>
                        )}
                      </td>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          p.cost ?? "—"
                        ) : (
                          <input className="p-1 border border-border rounded w-24" type="number" inputMode="decimal" min="0" value={editForm.cost} onChange={(e) => setEditForm((f) => ({ ...f, cost: e.target.value }))} />
                        )}
                      </td>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          projectLabel(p.projectId)
                        ) : (
                          <select
                            className="p-1 border border-border rounded"
                            value={editForm.projectId}
                            onChange={(e) => {
                              const pid = e.target.value || "";
                              setEditForm((f) => ({ ...f, projectId: pid, taskId: f.taskId && !taskMatchesProject(f.taskId, pid) ? "" : f.taskId }));
                            }}
                          >
                            <option value="">— none —</option>
                            {projects.map((pr) => (
                              <option key={pr._id} value={pr._id}>
                                {pr.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          taskLabel(p.taskId)
                        ) : (
                          <select className="p-1 border border-border rounded" value={editForm.taskId} onChange={(e) => setEditForm((f) => ({ ...f, taskId: e.target.value }))}>
                            <option value="">— none —</option>
                            {tasksForPurchaseEditProject.map((t) => (
                              <option key={t._id} value={t._id}>
                                {t.title}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="border-b border-border p-2">
                        {!isEditing ? (
                          p.notes || "—"
                        ) : (
                          <input className="p-1 border border-border rounded w-full" value={editForm.notes} onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))} />
                        )}
                      </td>

                      {/* Receipt */}
                      <td className="border-b border-border p-2">
                        {(() => {
                          const candidate =
                            p.receiptPhoto?.url ||
                            p.receiptPhotoUrl ||
                            p.photo?.url ||
                            p.photoUrl ||
                            (Array.isArray(p.attachments) && p.attachments[0]?.url) ||
                            (typeof p.receipt === "string" ? p.receipt : p.receipt?.url) ||
                            "";

                          const url = candidate ? toAbsoluteUrl(candidate) : "";

                          if (isEditing) {
                            return (
                              <div className="text-left">
                                {url && (
                                  <div className="mb-2">
                                    <a href={url} target="_blank" rel="noreferrer" className="link text-xs">
                                      Open current
                                    </a>
                                  </div>
                                )}
                                <label className="text-xs">
                                  Replace receipt photo
                                  <input className="w-full" type="file" accept="image/*" onChange={(e) => setEditPhotoFile(e.target.files?.[0] || null)} />
                                </label>
                              </div>
                            );
                          }

                          return url ? (
                            <a href={url} target="_blank" rel="noreferrer" title="Receipt">
                              <img src={url} alt="Receipt" style={{ width: 72, height: 48, objectFit: "cover", borderRadius: 6 }} />
                            </a>
                          ) : (
                            <span className="text-xs text-gray-400">—</span>
                          );
                        })()}
                      </td>

                      <td className="border-b border-border p-2 text-right">
                        {!isEditing ? (
                          <>
                            <button type="button" className="btn btn-sm mr-1" onClick={() => beginEditPurchase(p)}>
                              Edit
                            </button>
                            <button type="button" className="btn btn-sm" onClick={() => handleDeletePurchase(p._id)}>
                              Delete
                            </button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="btn btn-sm mr-1" onClick={saveEditPurchase}>
                              Save
                            </button>
                            <button type="button" className="btn btn-sm" onClick={cancelEdit}>
                              Cancel
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td className="p-3 text-center" colSpan={9}>
                    No purchases yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- Logbook (non-travel) ---------------- */}
      <div id="logbook" className="rounded-xl border border-border bg-panel p-3 space-y-3 scroll-mt-20">
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">Logbook</div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn" onClick={() => setLbModalOpen(true)}>
              Add entry
            </button>
            <button className="btn" onClick={exportLogbookCsv}>
              Export CSV
            </button>
          </div>
        </div>

        <div className="text-sm text-gray-700">
          Entries: <b>{entries.length}</b>
        </div>

        {lbErr && <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">{lbErr}</div>}
        {lbInfo && <div className="rounded border border-green-200 bg-green-100 p-2 text-sm">{lbInfo}</div>}

        {/* List with inline edit */}
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-thead">
              <HeaderRow headers={["When", "Type", "Odometer", "Cost", "Vendor", "Tags", "Notes", "Actions"]} />
            </thead>
            <tbody>
              {entries.map((e) => {
                const d = entryDisplay(e);
                const isEditing = lbEditId === e._id;
                return (
                  <tr key={e._id}>
                    <td className="border-b border-border p-2">
                      {!isEditing ? (
                        d.ts ? new Date(d.ts).toLocaleString() : "—"
                      ) : (
                        <input className="p-1 border border-border rounded" type="datetime-local" value={lbEditForm.ts} onChange={(ev) => setLbEditForm((f) => ({ ...f, ts: ev.target.value }))} />
                      )}
                    </td>
                    <td className="border-b border-border p-2">
                      {!isEditing ? (
                        d.type
                      ) : (
                        <select className="p-1 border border-border rounded" value={lbEditForm.type} onChange={(ev) => setLbEditForm((f) => ({ ...f, type: ev.target.value }))}>
                          {LOG_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="border-b border-border p-2">
                      {!isEditing ? (
                        d.odometer ?? "—"
                      ) : (
                        <input className="p-1 border border-border rounded w-24" type="number" inputMode="numeric" value={lbEditForm.odometer} onChange={(ev) => setLbEditForm((f) => ({ ...f, odometer: ev.target.value }))} />
                      )}
                    </td>
                    <td className="border-b border-border p-2">
                      {!isEditing ? (
                        d.cost !== "" ? d.cost : "—"
                      ) : (
                        <input className="p-1 border border-border rounded w-24" type="number" inputMode="decimal" min="0" value={lbEditForm.cost} onChange={(ev) => setLbEditForm((f) => ({ ...f, cost: ev.target.value }))} />
                      )}
                    </td>
                    <td className="border-b border-border p-2">
                      {!isEditing ? (
                        d.vendor || "—"
                      ) : (
                        <input className="p-1 border border-border rounded" value={lbEditForm.vendor} onChange={(ev) => setLbEditForm((f) => ({ ...f, vendor: ev.target.value }))} />
                      )}
                    </td>
                    <td className="border-b border-border p-2">
                      {!isEditing ? (
                        (d.tags || []).join(", ") || "—"
                      ) : (
                        <input className="p-1 border border-border rounded" value={lbEditForm.tags} onChange={(ev) => setLbEditForm((f) => ({ ...f, tags: ev.target.value }))} />
                      )}
                    </td>
                    <td className="border-b border-border p-2">
                      {!isEditing ? (
                        d.notes || "—"
                      ) : (
                        <input className="p-1 border border-border rounded w-full" value={lbEditForm.notes} onChange={(ev) => setLbEditForm((f) => ({ ...f, notes: ev.target.value }))} />
                      )}
                    </td>
                    <td className="border-b border-border p-2 text-right">
                      {!isEditing ? (
                        <>
                          <button type="button" className="btn btn-sm mr-1" onClick={() => beginEditEntry(e)}>
                            Edit
                          </button>
                          <button type="button" className="btn btn-sm" onClick={() => deleteEntry(e._id)}>
                            Delete
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="btn btn-sm mr-1" onClick={saveLbEdit}>
                            Save
                          </button>
                          <button type="button" className="btn btn-sm" onClick={cancelLbEdit}>
                            Cancel
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!entries.length && (
                <tr>
                  <td className="p-4 text-center" colSpan={8}>
                    No log entries
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Inspections inline list (view links) */}
        <div className="rounded-xl border border-border p-3">
          <div className="text-md font-semibold mb-2">Inspections</div>
          {!inspections.length ? (
            <div className="text-sm text-gray-600">No inspections recorded for this vehicle.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-thead">
                  <HeaderRow headers={["Date", "Title", "Performed by", "Result", "Actions"]} />
                </thead>
                <tbody>
                  {inspections.map((insp) => (
                    <tr key={insp._id}>
                      <td className="border-b border-border p-2">{insp.ts ? new Date(insp.ts).toLocaleString() : "—"}</td>
                      <td className="border-b border-border p-2">{insp.title || insp.templateName || "Inspection"}</td>
                      <td className="border-b border-border p-2">{userLabel(insp.userId || insp.user)}</td>
                      <td className="border-b border-border p-2">{insp.status || insp.result || "—"}</td>
                      <td className="border-b border-border p-2 text-right">
                       {insp._id && insp._source !== "logbook" && (
<Link className="btn btn-sm mr-2" to={`/inspections/submissions/${insp._id}`}>
  View
</Link>
)}
                        <button type="button" className="link text-sm underline" onClick={() => openInspectionLightbox(insp)} title="Quick view">
                          view
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ---- Modals ---- */}
      <Modal
        open={startTripOpen}
        title="Start trip"
        onClose={() => {
          setTripModalErr("");
          setStartTripOpen(false);
        }}
        footer={
          <>
            <button className="btn" onClick={handleStartTrip}>
              Start trip
            </button>
          </>
        }
      >
        {tripModalErr && <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">{tripModalErr}</div>}

        <div className="grid md:grid-cols-2 gap-3">
          <label className="text-sm">
            Odometer start
            <input className="w-full" type="number" min="0" required value={odoStart} onChange={(e) => setOdoStart(e.target.value)} placeholder="e.g. 10234.5" />
          </label>
          <label className="text-sm">
            Photo (start)
            <input className="w-full" type="file" accept="image/*" capture="environment" onChange={(e) => setStartFile(e.target.files?.[0] || null)} />
          </label>
          <label className="text-sm">
            Usage
            <select className="w-full" value={tripUsage} onChange={(e) => setTripUsage(e.target.value)}>
              <option value="business">business</option>
              <option value="private">private</option>
            </select>
          </label>
          <div />
          <label className="text-sm">
            Project (optional)
            <select
              className="w-full"
              value={tripProjectId}
              onChange={(e) => {
                const pid = e.target.value || "";
                setTripProjectId(pid);
                if (tripTaskId && !taskMatchesProject(tripTaskId, pid)) setTripTaskId("");
              }}
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
            Task (optional)
            <select className="w-full" value={tripTaskId} onChange={(e) => setTripTaskId(e.target.value)}>
              <option value="">— none —</option>
              {tasksForTripProject.map((t) => (
                <option key={t._id} value={t._id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Modal>

      <Modal
        open={endTripOpen}
        title="End trip"
        onClose={() => {
          setTripModalErr("");
          setEndTripOpen(false);
        }}
        footer={
          <>
            <button className="btn" onClick={handleEndTrip}>
              End trip
            </button>
          </>
        }
      >
        {tripModalErr && <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">{tripModalErr}</div>}

        {!openTrip ? (
          <div className="text-sm text-gray-600">No open trip.</div>
        ) : (
          <div className="grid md:grid-cols-2 gap-3">
            <div className="md:col-span-2 text-sm">
              <b>Open trip:</b> started {openTrip.startedAt ? new Date(openTrip.startedAt).toLocaleString() : "—"} · ODO start: {openTrip.odoStart ?? "—"}
            </div>
            <label className="text-sm">
              Odometer end
              <input
                className="w-full"
                type="number"
                min={openTrip.odoStart ?? 0}
                required
                value={odoEnd}
                onChange={(e) => {
                  setOdoEnd(e.target.value);
                  // clear modal error as user edits
                  if (tripModalErr) setTripModalErr("");
                }}
                placeholder="e.g. 10245.8"
              />
            </label>
            <label className="text-sm">
              Photo (end)
              <input className="w-full" type="file" accept="image/*" capture="environment" onChange={(e) => setEndFile(e.target.files?.[0] || null)} />
            </label>
            <label className="text-sm md:col-span-2">
              Notes (optional)
              <input className="w-full" value={tripNotes} onChange={(e) => setTripNotes(e.target.value)} placeholder="Trip notes…" />
            </label>
          </div>
        )}
      </Modal>

      <Modal
        open={purchaseModalOpen}
        title="Add purchase"
        onClose={() => setPurchaseModalOpen(false)}
        footer={
          <>
            <button className="btn btn-primary" onClick={handleAddPurchase}>
              Add purchase
            </button>
          </>
        }
      >
        <form onSubmit={handleAddPurchase} className="grid md:grid-cols-2 gap-2" onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}>
          <label className="text-sm">
            Vendor
            <select className="w-full" value={pForm.vendorId} onChange={(e) => setPForm((f) => ({ ...f, vendorId: e.target.value }))}>
              <option value="">— none —</option>
              {vendors.map((vnd) => (
                <option key={vnd._id || vnd.id} value={vnd._id || vnd.id}>
                  {vnd.name}
                </option>
              ))}
              <option value="__new__">+ Add new vendor…</option>
            </select>
          </label>
          {(pForm.vendorId === "" || pForm.vendorId === "__new__") && (
            <label className="text-sm">
              New vendor name
              <input className="w-full" value={pForm.newVendorName} onChange={(e) => setPForm((f) => ({ ...f, newVendorName: e.target.value }))} placeholder="e.g. AutoCare Pty" />
            </label>
          )}
          <label className="text-sm">
            Type
            <select className="w-full" value={pForm.type} onChange={(e) => setPForm((f) => ({ ...f, type: e.target.value }))}>
              {PURCHASE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Date
            <input className="w-full" type="date" value={pForm.date} onChange={(e) => setPForm((f) => ({ ...f, date: e.target.value }))} />
          </label>
          <label className="text-sm">
            Cost
            <input className="w-full" type="number" inputMode="decimal" min="0" value={pForm.cost} onChange={(e) => setPForm((f) => ({ ...f, cost: e.target.value }))} />
          </label>

          {/* receipt photo */}
          <label className="text-sm">
            Receipt photo (optional)
            <input className="w-full" type="file" accept="image/*" onChange={(e) => setPPhotoFile(e.target.files?.[0] || null)} />
          </label>

          <label className="text-sm">
            Project
            <select
              className="w-full"
              value={pForm.projectId}
              onChange={(e) => {
                const pid = e.target.value || "";
                setPForm((f) => ({ ...f, projectId: pid, taskId: f.taskId && !taskMatchesProject(f.taskId, pid) ? "" : f.taskId }));
              }}
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
            Task
            <select className="w-full" value={pForm.taskId} onChange={(e) => setPForm((f) => ({ ...f, taskId: e.target.value }))}>
              <option value="">— none —</option>
              {tasksForPurchaseProject.map((t) => (
                <option key={t._id} value={t._id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm md:col-span-2">
            Notes
            <input className="w-full" value={pForm.notes} onChange={(e) => setPForm((f) => ({ ...f, notes: e.target.value }))} placeholder="What was purchased / reference / invoice # …" />
          </label>
        </form>
      </Modal>

      <Modal
        open={inspModalOpen}
        title={inspModalTitle}
        onClose={() => setInspModalOpen(false)}
        footer={
          <>
            <button className="btn" onClick={() => setInspModalOpen(false)}>
              Close
            </button>
          </>
        }
      >
        <div className="max-h-[70vh] overflow-auto border border-border rounded p-2">
          {/* eslint-disable-next-line react/no-danger */}
          <div dangerouslySetInnerHTML={{ __html: inspModalHtml }} />
        </div>
      </Modal>

      <Modal
        open={lbModalOpen}
        title="Add logbook entry"
        onClose={() => setLbModalOpen(false)}
        footer={
          <>
            <button className="btn btn-primary" onClick={createEntry}>
              Add entry
            </button>
          </>
        }
      >
        <form onSubmit={createEntry} className="grid md:grid-cols-3 gap-2" onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}>
          <label className="text-sm">
            Type
            <select className="w-full" value={lbForm.type} onChange={(e) => setLbForm({ ...lbForm, type: e.target.value })}>
              {LOG_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            Timestamp
            <input className="w-full" type="datetime-local" value={lbForm.ts} onChange={(e) => setLbForm({ ...lbForm, ts: e.target.value })} />
          </label>
          <label className="text-sm">
            Odometer (km)
            <input className="w-full" type="number" inputMode="numeric" min="0" value={lbForm.odometer} onChange={(e) => setLbForm({ ...lbForm, odometer: e.target.value })} />
          </label>
          <label className="text-sm">
            Cost
            <input className="w-full" type="number" inputMode="decimal" min="0" value={lbForm.cost} onChange={(e) => setLbForm({ ...lbForm, cost: e.target.value })} />
          </label>
          <label className="text-sm">
            Vendor
            <input className="w-full" value={lbForm.vendor} onChange={(e) => setLbForm({ ...lbForm, vendor: e.target.value })} />
          </label>
          <label className="text-sm">
            Tags (comma)
            <input className="w-full" value={lbForm.tags} onChange={(e) => setLbForm({ ...lbForm, tags: e.target.value })} placeholder="service, warranty" />
          </label>
          <label className="text-sm md:col-span-3">
            Notes
            <textarea className="w-full" rows={3} value={lbForm.notes} onChange={(e) => setLbForm({ ...lbForm, notes: e.target.value })} />
          </label>
          <label className="text-sm md:col-span-3">
            Completes reminder (optional)
            <select className="w-full" value={lbForm.completeReminderId} onChange={(e) => setLbForm({ ...lbForm, completeReminderId: e.target.value })}>
              <option value="">— none —</option>
              {(reminders || []).filter((r) => r.active).map((r) => (
                <option key={r._id} value={r._id}>
                  {(parseReminderCategory(r.notes || "") || "—") +
                    " · " +
                    (r.kind === "date"
                      ? `Date: ${r.dueDate ? new Date(r.dueDate).toLocaleDateString() : "—"}`
                      : `Odo: ${r.dueOdometer ?? "—"} km`)}
                </option>
              ))}
            </select>
          </label>
          <div className="md:col-span-3">
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm" onClick={() => { setLbForm((f) => ({ ...f, type: "service", tags: "service", ts: new Date().toISOString().slice(0, 16) })); }}>
                + Service
              </button>
              <button type="button" className="btn btn-sm" onClick={() => { setLbForm((f) => ({ ...f, type: "tyres", tags: "tyre", ts: new Date().toISOString().slice(0, 16) })); }}>
                + Tyres
              </button>
              <button type="button" className="btn btn-sm" onClick={() => { setLbForm((f) => ({ ...f, type: "other", tags: "fuel", ts: new Date().toISOString().slice(0, 16) })); }}>
                + Fuel
              </button>
            </div>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/* ---------- tiny presentational helpers ---------- */
function Metric({ label, value }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="text-sm text-gray-600">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}
