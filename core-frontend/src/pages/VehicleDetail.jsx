// src/pages/VehicleDetail.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import Modal from "../components/Modal"; // <-- change path if your Modal lives elsewhere
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

function Metric({ label, value }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="text-sm text-gray-600">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
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

/* Resolve backend-relative URLs (for thumbnails, receipts, etc.) */
function toAbsoluteUrl(u) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;

  const backend = import.meta.env.VITE_API_BASE || import.meta.env.VITE_BACKEND_ORIGIN || "";
  if (backend) {
    const b = String(backend).replace(/\/+$/, "");
    const path = u.startsWith("/") ? u : `/${u}`;
    return `${b}${path}`;
  }

  const baseFromApi = (api?.defaults?.baseURL || "").replace(/\/api\/?$/i, "").replace(/\/+$/, "");
  const base =
    baseFromApi || (typeof window !== "undefined" ? `${window.location.protocol}//${window.location.host}` : "");
  return u.startsWith("/") ? `${base}${u}` : `${base}/${u}`;
}

function normalizeStoredUrl(u) {
  if (!u) return "";
  return String(u).trim();
}

function tripPhotoUrl(trip, which /* "start" | "end" */) {
  const photo =
    which === "start"
      ? trip?.startPhoto || trip?.start_photo || trip?.startImage || trip?.startPhotoUrl
      : trip?.endPhoto || trip?.end_photo || trip?.endImage || trip?.endPhotoUrl;

  let url =
    (typeof photo === "string" && photo) ||
    (photo && typeof photo.url === "string" && photo.url) ||
    "";

  if (!url && photo && typeof photo === "object") {
    const filename = typeof photo.filename === "string" ? photo.filename : "";
    if (filename) url = `/files/vehicle-trips/${filename}`;
  }

  if (!url) return "";

  const backend = import.meta.env.VITE_API_BASE || import.meta.env.VITE_BACKEND_ORIGIN || "";
  if (/^https?:\/\//i.test(url)) return url;
  const b = backend.replace(/\/+$/, "");
  const u = url.startsWith("/") ? url : `/${url}`;
  return b ? `${b}${u}` : u;
}

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

  // Logbook
  const [entries, setEntries] = useState([]);
  const [lbErr, setLbErr] = useState("");
  const [lbInfo, setLbInfo] = useState("");
  const [lbModalOpen, setLbModalOpen] = useState(false);
  const [lbForm, setLbForm] = useState({
    type: "service",
    ts: new Date().toISOString().slice(0, 16),
    odometer: "",
    cost: "",
    vendor: "",
    tags: "",
    notes: "",
  });

  // Trips
  const [openTrip, setOpenTrip] = useState(null);
  const [trips, setTrips] = useState([]);
  const [tripsLoading, setTripsLoading] = useState(false);
  const [tripErr, setTripErr] = useState("");
  const [tripInfo, setTripInfo] = useState("");
  const [tripSaving, setTripSaving] = useState(false);
  const [tripModalErr, setTripModalErr] = useState("");

  const [odoStart, setOdoStart] = useState("");
  const [odoEnd, setOdoEnd] = useState("");
  const [startFile, setStartFile] = useState(null);
  const [endFile, setEndFile] = useState(null);
  const [tripNotes, setTripNotes] = useState("");
  const [tripUsage, setTripUsage] = useState("business");

  const [startTripOpen, setStartTripOpen] = useState(false);
  const [endTripOpen, setEndTripOpen] = useState(false);

  const [tripProjectId, setTripProjectId] = useState("");
  const [tripTaskId, setTripTaskId] = useState("");

  // Purchases
  const [vendors, setVendors] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [pErr, setPErr] = useState("");
  const [pInfo, setPInfo] = useState("");
  const [purchaseModalOpen, setPurchaseModalOpen] = useState(false);
  const [pPhotoFile, setPPhotoFile] = useState(null);
  const PURCHASE_TYPES = ["service", "repair", "tyres", "parts", "fuel", "toll", "registration", "other"];
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

  // Inspections list + Quick View modal (THIS MUST BE INSIDE THE COMPONENT)
  const [inspections, setInspections] = useState([]);
  const [inspErr, setInspErr] = useState("");
  const [inspInfo, setInspInfo] = useState("");

  const [subViewOpen, setSubViewOpen] = useState(false);
  const [subView, setSubView] = useState(null);
  const [subViewErr, setSubViewErr] = useState("");
  const [subViewIframeUrl, setSubViewIframeUrl] = useState("");

  // ---------- label helpers ----------
  function userLabelFrom(list, uidOrObj) {
    if (!uidOrObj) return "—";
    if (typeof uidOrObj === "object" && (uidOrObj.name || uidOrObj.email)) {
      return uidOrObj.name || uidOrObj.email;
    }
    const uid = String(uidOrObj);
    const u = (list || []).find((x) => String(x._id) === uid);
    return u ? (u.name || u.email || u.username || uid) : uid;
  }
  function projectLabelFrom(list, pid) {
    if (!pid) return "—";
    const p = (list || []).find((pr) => String(pr._id) === String(pid));
    return p?.name || String(pid);
  }
  function taskLabelFrom(list, tidOrObj) {
    if (!tidOrObj) return "—";
    if (typeof tidOrObj === "object" && (tidOrObj._id || tidOrObj.title)) {
      return tidOrObj.title || tidOrObj._id;
    }
    const tid = String(tidOrObj);
    const t = (list || []).find((x) => String(x._id) === tid);
    return t ? (t.title || tid) : tid;
  }

  const userLabel = (x) => userLabelFrom(users, x);
  const projectLabel = (x) => projectLabelFrom(projects, x);
  const taskLabel = (x) => taskLabelFrom(tasks, x);

  useEffect(() => {
    setTripProjectId(v?.projectId || "");
    setTripTaskId(v?.taskId || "");
    setPForm((f) => ({ ...f, projectId: v?.projectId || "", taskId: v?.taskId || "" }));
  }, [v?.projectId, v?.taskId]);

  // ----- Loaders -----
  async function loadVehicle() {
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

  async function loadLogbook() {
    setLbErr("");
    setLbInfo("");
    try {
      const { data } = await api.get(`/vehicles/${id}/logbook`, { params: { limit: 200 } });
      const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
      setEntries(list);
    } catch (e) {
      // soft-fail if endpoint doesn't exist
      if (e?.response?.status === 404) {
        setEntries([]);
        return;
      }
      setLbErr(e?.response?.data?.error || String(e));
    }
  }

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
      if (!open) open = list.find((t) => !t.endedAt) || null;
      setOpenTrip(open);
      setTrips(list);
    } catch (e) {
      setTripErr(e?.response?.data?.error || String(e));
    } finally {
      setTripsLoading(false);
    }
  }

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

  async function loadInspections() {
    setInspErr("");
    setInspInfo("");

    // Primary: submissions list (filter client side by subjectAtRun: {type:'vehicle', id})
    try {
      const { data } = await api.get("/inspections/submissions", { params: { limit: 500 } });
      const all = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
      const mine = all
        .filter((sub) => {
          const subj = sub?.subjectAtRun || sub?.subject || {};
          return String(subj?.type || "").toLowerCase() === "vehicle" && String(subj?.id) === String(id);
        })
        .map((sub) => ({
          _id: sub?._id || sub?.id,
          ts: sub?.createdAt || sub?.updatedAt || sub?.submittedAt || sub?.ts || null,
          title: sub?.formTitle || sub?.title || sub?.formName || "Inspection",
          userId: sub?.runBy?.userId || sub?.runBy?._id || sub?.userId || sub?.user,
          status: sub?.overallResult || sub?.status || sub?.result || "—",
          _raw: sub,
        }));

      setInspections(mine);
      return;
    } catch (e) {
      if (e?.response?.status !== 404) setInspErr(e?.response?.data?.error || String(e));
    }

    // Fallback: none
    setInspections([]);
  }

  useEffect(() => {
    loadVehicle();
    loadProjects();
    loadUsers();
    loadTasks();
    loadReminders();
    loadLogbook();
    loadTrips();
    loadVendorsList();
    loadPurchasesList();
    loadInspections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ----- Derived -----
  const currentOdo = useMemo(() => {
    const tMax = latestOdoFromTrips(trips);
    const lMax = latestOdoFromEntries(entries);
    if (tMax == null && lMax == null) return null;
    if (tMax == null) return lMax;
    if (lMax == null) return tMax;
    return Math.max(tMax, lMax);
  }, [trips, entries]);

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

  function taskMatchesProject(tid, pid) {
    if (!tid) return true;
    if (!pid) return true;
    const t = tasks.find((x) => String(x._id) === String(tid));
    return t ? String(t.projectId) === String(pid) : false;
  }

  // ---------- Core actions ----------
  async function saveVehicle(patch) {
    try {
      const { data } = await api.put(`/vehicles/${id}`, patch);
      setV(data);
      setInfo("Saved");
      setTimeout(() => setInfo(""), 1200);
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

  async function delVehicle() {
    if (!confirm("Delete this vehicle?")) return;
    try {
      await api.delete(`/vehicles/${id}`);
      navigate("/vehicles");
    } catch (e) {
      setErr(e?.response?.data?.error || String(e));
    }
  }

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
    } catch (e2) {
      setRErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function toggleReminderActive(rid, active) {
    try {
      const { data } = await api.put(`/vehicles/${id}/reminders/${rid}`, { active });
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
    } catch (e2) {
      setRErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function deleteReminder(rid) {
    if (!confirm("Delete this reminder?")) return;
    try {
      const { data } = await api.delete(`/vehicles/${id}/reminders/${rid}`);
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
    } catch (e2) {
      setRErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function createLogEntry(e) {
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

      const payload = {
        vehicleId: id,
        title: (lbForm.type || "other").charAt(0).toUpperCase() + (lbForm.type || "other").slice(1),
        type: lbForm.type,
        vendor: lbForm.vendor,
        cost: costNum,
        notes: lbForm.notes || "",
        tags: [lbForm.type, ...tagList],
        ts: lbForm.ts ? new Date(lbForm.ts).toISOString() : undefined,
        odometer: odoNum,
        odometerStart: odoNum,
        odometerEnd: odoNum,
      };

      // Try a sane default endpoint; if yours differs, change it here.
      const { data } = await api.post(`/vehicles/${id}/logbook`, payload).catch(async (err1) => {
        if (err1?.response?.status === 404) {
          const r = await api.post(`/logbook`, payload);
          return r;
        }
        throw err1;
      });

      setEntries((prev) => [data, ...prev]);
      setLbInfo("Log entry added.");
      setLbModalOpen(false);
      setLbForm({
        type: "service",
        ts: new Date().toISOString().slice(0, 16),
        odometer: "",
        cost: "",
        vendor: "",
        tags: "",
        notes: "",
      });
    } catch (e2) {
      setLbErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function handleStartTrip(e) {
    e?.preventDefault?.();
    setTripModalErr("");
    setTripErr("");
    setTripInfo("");

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
        tags: [usageTag],
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
      setTripModalErr("");
      setStartTripOpen(false);

      await loadTrips();
      setTripInfo("Trip started.");
      setTimeout(() => setTripInfo(""), 1500);
    } catch (e2) {
      setTripModalErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function handleEndTrip(e) {
    e?.preventDefault?.();
    if (!openTrip) return;

    setTripModalErr("");
    setTripErr("");
    setTripInfo("");

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
      setTripModalErr("");
      setEndTripOpen(false);

      await loadTrips();
      setTripInfo("Trip ended.");
      setTimeout(() => setTripInfo(""), 1500);
    } catch (e2) {
      setTripModalErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function apiUpdateTrip(_vehId, tripId, patch) {
    return compatUpdateTrip(tripId, patch, { vehicleId: _vehId });
  }

  async function handleAddPurchase(e) {
    e?.preventDefault?.();
    setPErr("");
    setPInfo("");
    try {
      const payload = {
        vehicleId: id,
        vendorId: pForm.vendorId || undefined,
        vendorName: !pForm.vendorId && pForm.newVendorName.trim() ? pForm.newVendorName.trim() : undefined,
        type: pForm.type,
        date: pForm.date ? new Date(pForm.date).toISOString() : undefined,
        cost: pForm.cost !== "" ? Number(pForm.cost) : undefined,
        projectId: pForm.projectId || undefined,
        taskId: pForm.taskId || undefined,
        notes: pForm.notes || "",
      };

      // optional: receipt upload (reuses trip uploader)
      if (pPhotoFile) {
        try {
          const { url } = await uploadTripPhoto(pPhotoFile);
          if (url) payload.receiptPhotoUrl = normalizeStoredUrl(url);
        } catch {
          // ignore upload errors
        }
      }

      const created = await createPurchase(payload);
      setPurchases((prev) => [created, ...prev]);
      setPurchaseModalOpen(false);
      setPPhotoFile(null);
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
      setPInfo("Purchase added.");
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

  async function openInspectionSubmissionQuickView(submissionRow) {
    const subId = submissionRow?._id || submissionRow?.id;

    setSubViewErr("");
    setSubView(submissionRow || null);
    setSubViewIframeUrl("");
    setSubViewOpen(true);

    if (!subId) return;

    try {
      const { data } = await api.get(`/inspections/submissions/${subId}`, {
        headers: { Accept: "application/json" },
        params: { _ts: Date.now() },
      });

      if (data && typeof data === "object") {
        setSubView(data);
        return;
      }

      setSubView(null);
      setSubViewIframeUrl(`/inspections/submissions/${subId}?embed=1`);
    } catch (e) {
      setSubViewErr(e?.response?.data?.error || e?.message || "Failed to load submission details.");
      setSubView(null);
      setSubViewIframeUrl(`/inspections/submissions/${subId}?embed=1`);
    }
  }

  // ----- Guard -----
  if (!v) {
    return (
      <div className="mx-auto max-w-7xl p-4">
        Loading… {err && <span style={{ color: "crimson" }}>({err})</span>}
      </div>
    );
  }
  const selectedDriverId = v?.driver?._id || v?.driverId || "";

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
          <button className="btn btn-ghost" onClick={delVehicle}>
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
          <Metric label="Project" value={projectLabel(v.projectId)} />
          <Metric label="Driver" value={userLabel(v.driver || v.driverId)} />
          <Metric label="Status" value={String(v.status || "active")} />
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
        <div className="rounded-xl border border-border bg-panel p-3 space-y-3">
          <div className="text-lg font-semibold mb-1">Meta</div>

          <label className="block text-sm">
            Registration
            <input
              className="w-full"
              value={v.reg ?? ""}
              onChange={(e) => setV({ ...v, reg: e.target.value })}
              onBlur={() => saveVehicle({ reg: v.reg || "" })}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              Make
              <input
                className="w-full"
                value={v.make ?? ""}
                onChange={(e) => setV({ ...v, make: e.target.value })}
                onBlur={() => saveVehicle({ make: v.make || "" })}
              />
            </label>
            <label className="block text-sm">
              Model
              <input
                className="w-full"
                value={v.model ?? ""}
                onChange={(e) => setV({ ...v, model: e.target.value })}
                onBlur={() => saveVehicle({ model: v.model || "" })}
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
                onBlur={() => saveVehicle({ year: v.year ? Number(v.year) : undefined })}
              />
            </label>
            <label className="block text-sm">
              VIN
              <input
                className="w-full"
                value={v.vin ?? ""}
                onChange={(e) => setV({ ...v, vin: e.target.value })}
                onBlur={() => saveVehicle({ vin: v.vin || "" })}
              />
            </label>
          </div>

          <label className="block text-sm">
            Type
            <input
              className="w-full"
              value={v.type ?? ""}
              onChange={(e) => setV({ ...v, type: e.target.value })}
              onBlur={() => saveVehicle({ type: v.type || "", vehicleType: v.type || "" })}
            />
          </label>

          <label className="block text-sm">
            Project
            <select
              className="w-full"
              value={v.projectId || ""}
              onChange={(e) => {
                const pid = e.target.value || "";
                setV((prev) => ({ ...prev, projectId: pid, taskId: "" }));
                saveVehicle({ projectId: pid || null, taskId: null });
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

          <label className="block text-sm">
            Driver
            <div className="flex items-center gap-2">
              <select
                className="w-full"
                value={selectedDriverId}
                onChange={(e) => {
                  const val = e.target.value;
                  setV((prev) => ({ ...prev, driverId: val || "", driver: undefined }));
                  saveVehicle({ driverId: val || null });
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
                    saveVehicle({ driverId: null });
                  }}
                >
                  Clear
                </button>
              )}
            </div>
            {selectedDriverId && <div className="mt-1 text-xs text-gray-600">Currently: {userLabel(v.driver || v.driverId)}</div>}
          </label>

          <label className="block text-sm">
            Task
            <select
              className="w-full"
              value={v.taskId || ""}
              onChange={(e) => {
                const val = e.target.value || "";
                setV((prev) => ({ ...prev, taskId: val }));
                saveVehicle({ taskId: val || null });
              }}
            >
              <option value="">— none —</option>
              {tasksForVehicleProject.map((t) => (
                <option key={t._id} value={t._id}>
                  {t.title || t._id}
                </option>
              ))}
            </select>
            {v.taskId && (
              <div className="mt-1 text-xs">
                <Link className="link" to={`/tasks/${v.taskId}`}>
                  Open task
                </Link>
              </div>
            )}
          </label>

          <label className="block text-sm">
            Status
            <div className="flex items-center gap-2">
              <StatusBadge value={v.status || "active"} />
              <select value={v.status || "active"} onChange={(e) => saveVehicle({ status: e.target.value })}>
                <option value="active">active</option>
                <option value="workshop">workshop</option>
                <option value="retired">retired</option>
                <option value="stolen">stolen</option>
              </select>
            </div>
          </label>
        </div>

        {/* -------- Reminders -------- */}
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
            {nextDue?.dateDue?.dueDate && (
              <span className="mr-3">
                Next date: <b>{new Date(nextDue.dateDue.dueDate).toLocaleDateString()}</b>
              </span>
            )}
            {nextDue?.odoDue?.dueOdometer != null && (
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
                <input className="w-full" type="number" inputMode="numeric" min="0" value={rForm.dueOdometer} onChange={(e) => setRForm({ ...rForm, dueOdometer: e.target.value })} required />
              </label>
            )}

            <label className="text-sm md:col-span-5">
              Notes
              <input className="w-full" value={rForm.notes} onChange={(e) => setRForm({ ...rForm, notes: e.target.value })} />
            </label>

            {rForm.category === "service" && (
              <>
                <div className="md:col-span-12 border-t border-border my-2" />
                <label className="text-sm md:col-span-2 inline-flex items-center gap-2">
                  <input type="checkbox" checked={rForm.recurring} onChange={(e) => setRForm((f) => ({ ...f, recurring: e.target.checked }))} />
                  <span>Recurring</span>
                </label>
                <label className="text-sm md:col-span-2">
                  Every (days)
                  <input className="w-full" type="number" min="0" value={rForm.recurDays} onChange={(e) => setRForm((f) => ({ ...f, recurDays: e.target.value }))} disabled={!rForm.recurring} />
                </label>
                <label className="text-sm md:col-span-2">
                  Every (km)
                  <input className="w-full" type="number" min="0" value={rForm.recurKm} onChange={(e) => setRForm((f) => ({ ...f, recurKm: e.target.value }))} disabled={!rForm.recurring} />
                </label>
                <div className="text-xs text-gray-600 md:col-span-6">Set one or both.</div>
              </>
            )}

            <div className="md:col-span-12">
              <button className="btn btn-primary" type="submit">
                Add reminder
              </button>
            </div>
          </form>

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead className="bg-thead">
                <HeaderRow headers={["Category", "Type", "Due", "Notes", "Active", "Status", "Actions"]} />
              </thead>
              <tbody>
                {(reminders || [])
                  .filter((r) => (showCompletedReminders ? true : reminderStatus(r, currentOdo).code !== "completed"))
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
                    return (
                      <tr key={r._id} style={rowTintStyle}>
                        <td className="border-b border-border p-2">{cat}</td>
                        <td className="border-b border-border p-2">{r.kind}</td>
                        <td className="border-b border-border p-2">
                          {r.kind === "date"
                            ? r.dueDate
                              ? new Date(r.dueDate).toLocaleDateString()
                              : "—"
                            : r.dueOdometer != null
                            ? `${r.dueOdometer} km`
                            : "—"}
                        </td>
                        <td className="border-b border-border p-2">{stripReminderTokens(r.notes || "—") || "—"}</td>
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
                          <button type="button" className="btn btn-sm mr-1" onClick={() => deleteReminder(r._id)}>
                            Delete
                          </button>
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

      {/* ---------------- Trips ---------------- */}
      <div id="trips" className="rounded-xl border border-border bg-panel p-3 space-y-3 scroll-mt-20">
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">Vehicle Trips</div>
          <div className="flex items-center gap-2">
            {!openTrip ? (
              <button type="button" className="btn" onClick={() => (setTripModalErr(""), setStartTripOpen(true))}>
                Start trip
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => (setTripModalErr(""), setEndTripOpen(true))}>
                End trip
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {tripsLoading && <div className="text-sm text-gray-500">Loading…</div>}
          {!startTripOpen && !endTripOpen && tripErr && <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">{tripErr}</div>}
          {tripInfo && <div className="rounded border border-green-200 bg-green-100 p-2 text-sm">{tripInfo}</div>}
        </div>

        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-thead">
              <HeaderRow headers={["Started", "Ended", "ODO", "Project", "Task", "Photos", "Notes"]} />
            </thead>
            <tbody>
              {trips.length ? (
                trips.map((trip) => {
                  const sUrl = tripPhotoUrl(trip, "start");
                  const eUrl = tripPhotoUrl(trip, "end");
                  return (
                    <tr key={trip._id}>
                      <td className="border-b border-border p-2">{trip.startedAt ? new Date(trip.startedAt).toLocaleString() : "—"}</td>
                      <td className="border-b border-border p-2">{trip.endedAt ? new Date(trip.endedAt).toLocaleString() : "—"}</td>
                      <td className="border-b border-border p-2">
                        {trip.odoStart ?? "—"} → {trip.odoEnd ?? "—"}
                      </td>
                      <td className="border-b border-border p-2">{trip.projectId ? projectLabel(trip.projectId) : "—"}</td>
                      <td className="border-b border-border p-2">{trip.taskId ? taskLabel(trip.taskId) : "—"}</td>
                      <td className="border-b border-border p-2">
                        <div className="flex gap-2">
                          {sUrl ? (
                            <a href={sUrl} target="_blank" rel="noreferrer" title="Start photo">
                              <img src={sUrl} alt="Start" style={{ width: 72, height: 48, objectFit: "cover", borderRadius: 6 }} />
                            </a>
                          ) : null}
                          {eUrl ? (
                            <a href={eUrl} target="_blank" rel="noreferrer" title="End photo">
                              <img src={eUrl} alt="End" style={{ width: 72, height: 48, objectFit: "cover", borderRadius: 6 }} />
                            </a>
                          ) : null}
                        </div>
                      </td>
                      <td className="border-b border-border p-2">{trip.notes || "—"}</td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td className="p-3 text-center" colSpan={7}>
                    No trips yet
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
          <button type="button" className="btn" onClick={() => setPurchaseModalOpen(true)}>
            Add purchase
          </button>
        </div>

        <div className="flex items-center gap-2">
          {pErr && <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">{pErr}</div>}
          {pInfo && <div className="rounded border border-green-200 bg-green-100 p-2 text-sm">{pInfo}</div>}
        </div>

        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-thead">
              <HeaderRow headers={["Date", "Type", "Cost", "Notes", "Receipt", "Actions"]} />
            </thead>
            <tbody>
              {purchases.length ? (
                purchases.map((p) => {
                  const candidate =
                    p.receiptPhoto?.url ||
                    p.receiptPhotoUrl ||
                    p.photo?.url ||
                    p.photoUrl ||
                    (Array.isArray(p.attachments) && p.attachments[0]?.url) ||
                    (typeof p.receipt === "string" ? p.receipt : p.receipt?.url) ||
                    "";
                  const url = candidate ? toAbsoluteUrl(candidate) : "";
                  return (
                    <tr key={p._id}>
                      <td className="border-b border-border p-2">{p.date ? new Date(p.date).toLocaleDateString() : "—"}</td>
                      <td className="border-b border-border p-2">{p.type || "—"}</td>
                      <td className="border-b border-border p-2">{p.cost ?? "—"}</td>
                      <td className="border-b border-border p-2">{p.notes || "—"}</td>
                      <td className="border-b border-border p-2">
                        {url ? (
                          <a href={url} target="_blank" rel="noreferrer" title="Receipt">
                            <img src={url} alt="Receipt" style={{ width: 72, height: 48, objectFit: "cover", borderRadius: 6 }} />
                          </a>
                        ) : (
                          <span className="text-xs text-gray-400">—</span>
                        )}
                      </td>
                      <td className="border-b border-border p-2 text-right">
                        <button type="button" className="btn btn-sm" onClick={() => handleDeletePurchase(p._id)}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td className="p-3 text-center" colSpan={6}>
                    No purchases yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- Logbook + Inspections ---------------- */}
      <div id="logbook" className="rounded-xl border border-border bg-panel p-3 space-y-3 scroll-mt-20">
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">Logbook</div>
          <button type="button" className="btn" onClick={() => setLbModalOpen(true)}>
            Add entry
          </button>
        </div>

        {lbErr && <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">{lbErr}</div>}
        {lbInfo && <div className="rounded border border-green-200 bg-green-100 p-2 text-sm">{lbInfo}</div>}

        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-thead">
              <HeaderRow headers={["When", "Type", "Odometer", "Cost", "Vendor", "Notes"]} />
            </thead>
            <tbody>
              {entries.length ? (
                entries.map((e) => (
                  <tr key={e._id}>
                    <td className="border-b border-border p-2">{e.ts ? new Date(e.ts).toLocaleString() : "—"}</td>
                    <td className="border-b border-border p-2">{resolveEntryType(e)}</td>
                    <td className="border-b border-border p-2">{e.odometer ?? e.odometerEnd ?? e.odometerStart ?? "—"}</td>
                    <td className="border-b border-border p-2">{e.cost ?? "—"}</td>
                    <td className="border-b border-border p-2">{e.vendor ?? "—"}</td>
                    <td className="border-b border-border p-2">{e.notes ?? "—"}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="p-4 text-center" colSpan={6}>
                    No log entries
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="rounded-xl border border-border p-3">
          <div className="text-md font-semibold mb-2">Inspections</div>
          {inspErr && <div className="rounded border border-red-200 bg-red-50 p-2 text-sm mb-2">{inspErr}</div>}
          {inspInfo && <div className="rounded border border-green-200 bg-green-100 p-2 text-sm mb-2">{inspInfo}</div>}

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
                      <td className="border-b border-border p-2">{insp.title || "Inspection"}</td>
                      <td className="border-b border-border p-2">{userLabel(insp.userId || insp.user)}</td>
                      <td className="border-b border-border p-2">{insp.status || "—"}</td>
                      <td className="border-b border-border p-2 text-right">
                        <button
                          type="button"
                          className="px-2 py-1 border rounded"
                          onClick={() => openInspectionSubmissionQuickView(insp)}  // <-- FIXED (was s)
                        >
                          View
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
      {/* ---- Trip Start Modal ---- */}
      <Modal
        open={startTripOpen}
        title="Start trip"
        onClose={() => {
          setTripModalErr("");
          setStartTripOpen(false);
        }}
        footer={
          <button className="btn" onClick={handleStartTrip}>
            Start trip
          </button>
        }
      >
        {tripModalErr && <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">{tripModalErr}</div>}

        <div className="grid md:grid-cols-2 gap-3">
          <label className="text-sm">
            Odometer start
            <input className="w-full" type="number" min="0" required value={odoStart} onChange={(e) => setOdoStart(e.target.value)} />
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

      {/* ---- Trip End Modal ---- */}
      <Modal
        open={endTripOpen}
        title="End trip"
        onClose={() => {
          setTripModalErr("");
          setEndTripOpen(false);
        }}
        footer={
          <button className="btn" onClick={handleEndTrip}>
            End trip
          </button>
        }
      >
        {tripModalErr && <div className="rounded border border-red-200 bg-red-50 p-2 text-sm">{tripModalErr}</div>}

        {!openTrip ? (
          <div className="text-sm text-gray-600">No open trip.</div>
        ) : (
          <div className="grid md:grid-cols-2 gap-3">
            <div className="md:col-span-2 text-sm">
              <b>Open trip:</b> started {openTrip.startedAt ? new Date(openTrip.startedAt).toLocaleString() : "—"} · ODO start:{" "}
              {openTrip.odoStart ?? "—"}
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
                  if (tripModalErr) setTripModalErr("");
                }}
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

      {/* ---- Add Purchase Modal ---- */}
      <Modal
        open={purchaseModalOpen}
        title="Add purchase"
        onClose={() => setPurchaseModalOpen(false)}
        footer={
          <button className="btn btn-primary" onClick={handleAddPurchase}>
            Add purchase
          </button>
        }
      >
        <form onSubmit={handleAddPurchase} className="grid md:grid-cols-2 gap-2" onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}>
          <label className="text-sm">
            Vendor
            <select className="w-full" value={pForm.vendorId} onChange={(e) => setPForm((f) => ({ ...f, vendorId: e.target.value }))}>
              <option value="">— none —</option>
              {vendors.map((vnd) => (
                <option key={vnd._id || vnd.id} value={vnd._id || vnd.id}>
                  {vnd.name}
                </option>
              ))}
            </select>
          </label>

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
              {(pForm.projectId ? tasks.filter((t) => String(t.projectId) === String(pForm.projectId)) : tasks).map((t) => (
                <option key={t._id} value={t._id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm md:col-span-2">
            Notes
            <input className="w-full" value={pForm.notes} onChange={(e) => setPForm((f) => ({ ...f, notes: e.target.value }))} />
          </label>
        </form>
      </Modal>

      {/* ---- Add Logbook Entry Modal ---- */}
      <Modal
        open={lbModalOpen}
        title="Add logbook entry"
        onClose={() => setLbModalOpen(false)}
        footer={
          <button className="btn btn-primary" onClick={createLogEntry}>
            Add entry
          </button>
        }
      >
        <form onSubmit={createLogEntry} className="grid md:grid-cols-3 gap-2" onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}>
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
            <input className="w-full" value={lbForm.tags} onChange={(e) => setLbForm({ ...lbForm, tags: e.target.value })} />
          </label>
          <label className="text-sm md:col-span-3">
            Notes
            <textarea className="w-full" rows={3} value={lbForm.notes} onChange={(e) => setLbForm({ ...lbForm, notes: e.target.value })} />
          </label>
        </form>
      </Modal>

      {/* ---- Inspection Submission Quick View Modal ---- */}
      <Modal
        open={subViewOpen}
        onClose={() => {
          setSubViewOpen(false);
          setSubViewIframeUrl("");
        }}
        title={subView?.form?.title || subView?.formTitle || subView?.templateTitle || "Submission"}
        width={980}
      >
        {subViewErr && <div className="text-red-600 text-sm mb-2">{subViewErr}</div>}

        {subViewIframeUrl ? (
          <iframe title="Inspection Submission" src={subViewIframeUrl} className="w-full border rounded" style={{ height: "70vh" }} />
        ) : subView ? (
          <div className="space-y-2 text-sm">
            {Array.isArray(subView.answers) && subView.answers.length ? (
              <div className="space-y-1">
                {subView.answers.map((a, i) => (
                  <div key={i} className="border rounded p-2">
                    <div className="font-medium">{a?.label || a?.question || `Q${i + 1}`}</div>
                    <div className="text-gray-700 whitespace-pre-wrap">
                      {typeof a?.value === "string"
                        ? a.value
                        : JSON.stringify(a?.value ?? a?.answer ?? "", null, 2)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-gray-600">No answers on this submission.</div>
            )}
          </div>
        ) : (
          <div className="text-sm text-gray-600">Loading…</div>
        )}
      </Modal>
    </div>
  );
}
