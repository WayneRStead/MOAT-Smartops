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
} from "../lib/vehicleTrips"; // trips API
import { listPurchases, createPurchase, deletePurchase, listVendors } from "../lib/purchases";

function StatusBadge({ value }) {
  const map = {
    active: "bg-green-100 text-green-800",
    workshop: "bg-amber-100 text-amber-800",
    retired: "bg-gray-200 text-gray-800",
  };
  const cls = map[value] || "bg-gray-100 text-gray-800";
  return <span className={`text-xs px-2 py-1 rounded ${cls}`}>{value}</span>;
}

/* Resolve backend-relative URLs (for thumbnails) */
function toAbsoluteUrl(u) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  const base = (api?.defaults?.baseURL || "").replace(/\/api\/?$/i, "");
  return u.startsWith("/") ? base + u : u;
}

/* ---- Service Reminder helpers (status + current ODO) ---- */
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
    const vals = [e?.odometer, e?.odometerEnd, e?.odometerStart]
      .map(Number)
      .filter(Number.isFinite);
    vals.forEach((v) => {
      if (max == null || v > max) max = v;
    });
  });
  return max;
}

/* --- Reminder parsing helpers (category / completion / recurrence / pair) --- */
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

/* ----- Logbook display helpers (back-compat) ----- */
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

// ---------- label helpers usable before useMemo ----------
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

  // Logbook (non-travel)
  const [entries, setEntries] = useState([]);
  const [lbErr, setLbErr] = useState("");
  const [lbInfo, setLbInfo] = useState("");

  // Create log entry (non-travel)
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
  const [tripErr, setTripErr] = useState("");
  const [tripInfo, setTripInfo] = useState("");
  const [tripSaving, setTripSaving] = useState(false);

  const [odoStart, setOdoStart] = useState("");
  const [odoEnd, setOdoEnd] = useState("");
  const [startFile, setStartFile] = useState(null);
  const [endFile, setEndFile] = useState(null);
  const [tripNotes, setTripNotes] = useState("");

  // Optional project/task selection for a trip (defaults to vehicle’s current)
  const [tripProjectId, setTripProjectId] = useState("");
  const [tripTaskId, setTripTaskId] = useState("");

  // Trip filter UI state (search for Vehicle Trips)
  const [tripDriverFilter, setTripDriverFilter] = useState("");
  const [tripProjectFilter, setTripProjectFilter] = useState("");
  const [tripTaskFilter, setTripTaskFilter] = useState("");

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
  });

  // ---------- Purchases state ----------
  const [vendors, setVendors] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [pErr, setPErr] = useState("");
  const [pInfo, setPInfo] = useState("");
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

  useEffect(() => {
    setTripProjectId(v?.projectId || "");
    setTripTaskId(v?.taskId || "");
    setPForm((f) => ({ ...f, projectId: v?.projectId || "", taskId: v?.taskId || "" }));
  }, [v?.projectId, v?.taskId]);

  // ----- Loaders -----
  async function load() {
    setErr(""); setInfo("");
    try {
      const { data } = await api.get(`/vehicles/${id}`);
      setV(data);
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
  async function loadUsers() {
    try {
      const { data } = await api.get("/users", { params: { limit: 1000 } });
      setUsers(Array.isArray(data) ? data : []);
    } catch { setUsers([]); }
  }
  async function loadTasks() {
    try {
      const { data } = await api.get("/tasks", { params: { limit: 1000 } });
      setTasks(Array.isArray(data) ? data : []);
    } catch { setTasks([]); }
  }
  async function loadReminders() {
    setRErr(""); setRInfo("");
    try {
      const { data } = await api.get(`/vehicles/${id}/reminders`);
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
    } catch (e) { setRErr(e?.response?.data?.error || String(e)); }
  }
  async function loadLogbook() {
    setLbErr(""); setLbInfo("");
    try {
      const params = { vehicleId: id, limit: 200 };
      const { data } = await api.get("/logbook", { params });
      setEntries(Array.isArray(data) ? data : []);
    } catch (e) { setLbErr(e?.response?.data?.error || String(e)); }
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
    setPErr(""); setPInfo("");
    try {
      const data = await listPurchases({ vehicleId: id, limit: 200 });
      setPurchases(Array.isArray(data) ? data : []);
    } catch (e) {
      setPErr(e?.response?.data?.error || String(e));
    }
  }

  /* -------- Trips loader -------- */
  async function loadTrips() {
    setTripErr(""); setTripsLoading(true);
    try {
      const open = await getOpenTrip(id).catch(() => null);
      setOpenTrip(open || null);
      const data = await listTrips(id, { limit: 200 }).catch(() => []);
      setTrips(Array.isArray(data) ? data : []);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ----- Vehicle meta -----
  async function save(patch) {
    try {
      const { data } = await api.put(`/vehicles/${id}`, patch);
      setV(data);
      setInfo("Saved");
      setTimeout(() => setInfo(""), 1200);
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
  }
  async function setStatus(newStatus) { await save({ status: newStatus }); }
  async function del() {
    if (!confirm("Delete this vehicle?")) return;
    try {
      await api.delete(`/vehicles/${id}`);
      navigate("/vehicles");
    } catch (e) { setErr(e?.response?.data?.error || String(e)); }
  }

  /* -------- Recurrence helpers -------- */
  function addDaysISO(baseISO, addDays) {
    const d = baseISO ? new Date(baseISO) : new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + Number(addDays || 0));
    return d.toISOString().slice(0, 10);
  }
  async function generateNextFromRecurringTokens(sourceReminderNotes, completedDateISO, odoAtCompletion) {
    const cat = (parseReminderCategory(sourceReminderNotes) || "service");
    const recurDays = parseRecurDays(sourceReminderNotes);
    const recurKm = parseRecurKm(sourceReminderNotes);

    if (!recurDays && !recurKm) return;

    const pairId = recurDays && recurKm ? Math.random().toString(36).slice(2, 8) + "-" + Date.now().toString(36) : "";

    const baseTokens = [
      `(Type: ${cat})`,
      recurDays ? `(RecurDays: ${recurDays})` : "",
      recurKm ? `(RecurKm: ${recurKm})` : "",
      pairId ? `(Pair: ${pairId})` : "",
    ].filter(Boolean).join(" ");

    if (recurDays) {
      const nextDate = addDaysISO(completedDateISO, recurDays);
      await api.post(`/vehicles/${id}/reminders`, {
        kind: "date",
        dueDate: nextDate,
        notes: baseTokens,
      }).catch(()=>{});
    }
    if (recurKm) {
      const odoBase = Number(odoAtCompletion ?? currentOdo ?? 0);
      const dueKm = odoBase + Number(recurKm);
      await api.post(`/vehicles/${id}/reminders`, {
        kind: "odometer",
        dueOdometer: dueKm,
        notes: baseTokens,
      }).catch(()=>{});
    }
  }

  // ----- Reminders CRUD -----
  async function addReminder(e) {
    e.preventDefault();
    setRErr(""); setRInfo("");
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
        dueDate: rForm.kind === 'date' ? rForm.dueDate : undefined,
        dueOdometer: rForm.kind === 'odometer' ? Number(rForm.dueOdometer) : undefined,
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
    } catch (e) { setRErr(e?.response?.data?.error || String(e)); }
  }
  async function toggleReminderActive(rid, active) {
    try {
      const { data } = await api.put(`/vehicles/${id}/reminders/${rid}`, { active });
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
    } catch (e) { setRErr(e?.response?.data?.error || String(e)); }
  }
  async function deleteReminder(rid) {
    if (!confirm("Delete this reminder?")) return;
    try {
      const { data } = await api.delete(`/vehicles/${id}/reminders/${rid}`);
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
    } catch (e) { setRErr(e?.response?.data?.error || String(e)); }
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
      recurring: (recurDays || recurKm) ? true : false,
      recurDays: recurDays ? String(recurDays) : "",
      recurKm: recurKm ? String(recurKm) : "",
    });
  }
  function cancelEditReminder() {
    setREditId("");
    setREditForm({
      kind: "date", category: "service", dueDate: "", dueOdometer: "", notes: "", _completedToken: "",
      recurring: false, recurDays: "", recurKm: ""
    });
  }
  async function saveEditReminder() {
    if (!rEditId) return;
    setRErr(""); setRInfo("");
    try {
      const original = reminders.find((x) => String(x._id) === String(rEditId));
      const completedToken = rEditForm._completedToken
        || parseReminderCompletedOn(original?.notes || "")
        || "";
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
      if (original?.kind === "odometer") patch.dueOdometer = rEditForm.dueOdometer !== "" ? Number(rEditForm.dueOdometer) : null;

      const { data } = await api.put(`/vehicles/${id}/reminders/${rEditId}`, patch);
      setReminders(data.reminders || []);
      setNextDue(data.nextDue || null);
      setRInfo("Reminder updated.");
      cancelEditReminder();
    } catch (e2) {
      setRErr(e2?.response?.data?.error || String(e2));
    }
  }

  // ----- Logbook helpers (non-travel) -----
  async function createEntry(e) {
    e.preventDefault();
    setLbErr(""); setLbInfo("");

    try {
      const tagList = (lbForm.tags || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const costNum = lbForm.cost !== "" ? Number(lbForm.cost) : undefined;
      const odoNum = lbForm.odometer !== "" ? Number(lbForm.odometer) : undefined;

      const title = (lbForm.type || "other").charAt(0).toUpperCase() + (lbForm.type || "other").slice(1);
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

      const { data } = await api.post("/logbook", payload);
      setEntries((prev) => [data, ...prev]);

      if (lbForm.completeReminderId) {
        const r = (reminders || []).find(x => String(x._id) === String(lbForm.completeReminderId));
        const existingNotes = r?.notes || "";
        const completedDate = lbForm.ts ? lbForm.ts.slice(0, 10) : new Date().toISOString().slice(0, 10);

        // 1) Mark selected reminder completed
        const withoutCompleted = existingNotes.replace(/\(\s*Completed:\s*[^)]+?\)\s*/i, "").trim();
        const newNotes = `${withoutCompleted} (Completed: ${completedDate})`.trim();
        await api.put(`/vehicles/${id}/reminders/${lbForm.completeReminderId}`, { active: false, notes: newNotes });

        // 2) Close sibling if paired
        const pairId = parsePairId(existingNotes);
        if (pairId) {
          const siblings = (reminders || []).filter(
            rr => rr.active && String(rr._id) !== String(lbForm.completeReminderId) && parsePairId(rr.notes || "") === pairId
          );
          for (const sib of siblings) {
            const sibBase = (sib.notes || "").replace(/\(\s*Completed:\s*[^)]+?\)\s*/i, "").trim();
            const sibNote = `${sibBase} (Completed: ${completedDate})`.trim();
            await api.put(`/vehicles/${id}/reminders/${sib._id}`, { active: false, notes: sibNote }).catch(()=>{});
          }
        }

        // 3) Auto-generate next reminder(s)
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
    } catch (e2) {
      setLbErr(e2?.response?.data?.error || String(e2));
    }
  }
  async function deleteEntry(entryId) {
    if (!confirm("Delete this log entry?")) return;
    setLbErr(""); setLbInfo("");
    try {
      await api.delete(`/logbook/${entryId}`);
      setEntries((prev) => prev.filter((x) => x._id !== entryId));
      setLbInfo("Log entry deleted.");
    } catch (e2) {
      setLbErr(e2?.response?.data?.error || String(e2));
    }
  }

  // Logbook inline edit helpers
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
    setLbEditForm({
      type: "service", ts: "", odometer: "", cost: "", vendor: "", tags: "", notes: ""
    });
  }
  async function saveLbEdit() {
    if (!lbEditId) return;
    setLbErr(""); setLbInfo("");
    try {
      const tagList = (lbEditForm.tags || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const costNum = lbEditForm.cost !== "" ? Number(lbEditForm.cost) : undefined;
      const odoNum = lbEditForm.odometer !== "" ? Number(lbEditForm.odometer) : undefined;

      const title = (lbEditForm.type || "other").charAt(0).toUpperCase() + (lbEditForm.type || "other").slice(1);
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

      const { data } = await api.put(`/logbook/${lbEditId}`, patch);
      setEntries((prev) => prev.map((x) => (String(x._id) === String(lbEditId) ? data : x)));
      setLbInfo("Log entry updated.");
      cancelLbEdit();
    } catch (e2) {
      setLbErr(e2?.response?.data?.error || String(e2));
    }
  }

  // Quick-add presets
  function preset(kind) {
    const ts = new Date().toISOString().slice(0, 16);
    if (kind === "fuel") setLbForm((f) => ({ ...f, type: "other", tags: "fuel", ts }));
    if (kind === "service") setLbForm((f) => ({ ...f, type: "service", tags: "service", ts }));
    if (kind === "tyres") setLbForm((f) => ({ ...f, type: "tyres", tags: "tyre", ts }));
  }

  /* ---------------- Trips actions ---------------- */
  async function handleStartTrip(e) {
    e?.preventDefault?.();
    setTripErr("");
    setTripInfo("");
    try {
      let startPhotoUrl;
      if (startFile) {
        const { url } = await uploadTripPhoto(startFile);
        startPhotoUrl = url;
      }
      const payload = {
        odoStart: Number(odoStart),
        projectId: tripProjectId || undefined,
        taskId: tripTaskId || undefined,
        startPhotoUrl,
        tags: ["general"],
      };
      await startTrip(id, payload);
      setOdoStart("");
      setStartFile(null);
      setTripNotes("");
      await loadTrips();
      setTripInfo("Trip started.");
      setTimeout(() => setTripInfo(""), 1500);
    } catch (e2) {
      setTripErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function handleEndTrip(e) {
    e?.preventDefault?.();
    if (!openTrip) return;
    setTripErr("");
    setTripInfo("");
    try {
      let endPhotoUrl;
      if (endFile) {
        const { url } = await uploadTripPhoto(endFile);
        endPhotoUrl = url;
      }
      const patch = {
        odoEnd: Number(odoEnd),
        endPhotoUrl,
      };
      if (tripNotes && tripNotes.trim() !== "") patch.notes = tripNotes.trim();

      await endTrip(id, openTrip._id, patch);
      setOdoEnd("");
      setEndFile(null);
      setTripNotes("");
      await loadTrips();
      setTripInfo("Trip ended.");
      setTimeout(() => setTripInfo(""), 1500);
    } catch (e2) {
      setTripErr(e2?.response?.data?.error || String(e2));
    }
  }

     // Trip inline edit helpers
  async function apiUpdateTrip(_vehId, tripId, patch) {
    // keep driverId mirror + remove undefineds
    const clean = Object.fromEntries(
      Object.entries({
        ...patch,
        driverId: patch?.driverUserId || patch?.driverId || undefined,
      }).filter(([, v]) => v !== undefined)
    );

    // single canonical endpoint (router exposes /vehicleTrips/:id; api baseURL includes /api)
    const { data } = await api.patch(`/vehicleTrips/${tripId}`, clean);
    return data;
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
    });
  }
  function cancelEditTrip() {
    setTripEditId("");
    setTripEditForm({
      startedAt: "", endedAt: "", odoStart: "", odoEnd: "", driverUserId: "", projectId: "", taskId: "", notes: ""
    });
  }
  async function saveEditTrip() {
    if (!tripEditId || tripSaving) return;
    setTripErr("");
    setTripInfo("");
    setTripSaving(true);
    try {
      const patch = {
        startedAt: tripEditForm.startedAt ? new Date(tripEditForm.startedAt).toISOString() : undefined,
        endedAt: tripEditForm.endedAt ? new Date(tripEditForm.endedAt).toISOString() : undefined,
        odoStart: tripEditForm.odoStart !== "" ? Number(tripEditForm.odoStart) : undefined,
        odoEnd: tripEditForm.odoEnd !== "" ? Number(tripEditForm.odoEnd) : undefined,
        driverUserId: tripEditForm.driverUserId || undefined,
        // also include driverId to satisfy APIs that use this field name
        driverId: tripEditForm.driverUserId || undefined,
        projectId: tripEditForm.projectId || undefined,
        taskId: tripEditForm.taskId || undefined,
        notes: tripEditForm.notes || undefined,
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
    return tasks.filter(t => String(t.projectId) === String(pid));
  }, [tasks, v?.projectId]);

  const tasksForTripProject = useMemo(() => {
    const pid = tripProjectId || "";
    if (!pid) return tasks;
    return tasks.filter(t => String(t.projectId) === String(pid));
  }, [tasks, tripProjectId]);

  const tasksForTripEditProject = useMemo(() => {
    const pid = tripEditForm.projectId || "";
    if (!pid) return tasks;
    return tasks.filter(t => String(t.projectId) === String(pid));
  }, [tasks, tripEditForm.projectId]);

  const tasksForPurchaseProject = useMemo(() => {
    const pid = pForm.projectId || "";
    if (!pid) return tasks;
    return tasks.filter(t => String(t.projectId) === String(pid));
  }, [tasks, pForm.projectId]);

  const tasksForPurchaseEditProject = useMemo(() => {
    const pid = editForm.projectId || "";
    if (!pid) return tasks;
    return tasks.filter(t => String(t.projectId) === String(pid));
  }, [tasks, editForm.projectId]);

  function taskMatchesProject(tid, pid) {
    if (!tid) return true;
    if (!pid) return true;
    const t = tasks.find(x => String(x._id) === String(tid));
    return t ? String(t.projectId) === String(pid) : false;
  }

  // ----- Derived -----
  const currentOdo = useMemo(() => {
    const tMax = latestOdoFromTrips(trips);
    const lMax = latestOdoFromEntries(entries);
    if (tMax == null && lMax == null) return null;
    if (tMax == null) return lMax;
    if (lMax == null) return tMax;
    return Math.max(tMax, lMax);
  }, [trips, entries]);

  const tripDriverOptions = useMemo(() => {
    const ids = Array.from(new Set(trips.map(t => t.driverUserId || t.driverId).filter(Boolean).map(String)));
    return ids.map(id => ({ id, label: userLabel(id) }));
  }, [trips, users]);
  const tripProjectOptions = useMemo(() => {
    const ids = Array.from(new Set(trips.map(t => t.projectId).filter(Boolean).map(String)));
    return ids.map(id => ({ id, label: projectLabel(id) }));
  }, [trips, projects]);
  const tripTaskOptions = useMemo(() => {
    const ids = Array.from(new Set(trips.map(t => t.taskId).filter(Boolean).map(String)));
    return ids.map(id => ({ id, label: taskLabel(id) }));
  }, [trips, tasks]);

  const filteredTrips = useMemo(() => {
    return trips.filter(t => {
      if (tripDriverFilter && String(t.driverUserId || t.driverId) !== String(tripDriverFilter)) return false;
      if (tripProjectFilter && String(t.projectId) !== String(tripProjectFilter)) return false;
      if (tripTaskFilter && String(t.taskId) !== String(tripTaskFilter)) return false;
      return true;
    });
  }, [trips, tripDriverFilter, tripProjectFilter, tripTaskFilter]);

  // Exporters (unchanged)
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
    const csv = rows.map((r) =>
      r.map((cell) => {
        const s = String(cell ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")
    ).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vehicle_${id}_logbook.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportTripCsv() {
    const rows = [
      ["Started","Ended","Odometer Start","Odometer End","Distance (km)","Driver","Project","Task","Notes","Start Photo","End Photo"],
      ...filteredTrips.map((t) => [
        t.startedAt ? new Date(t.startedAt).toISOString() : "",
        t.endedAt ? new Date(t.endedAt).toISOString() : "",
        t.odoStart ?? "",
        t.odoEnd ?? "",
        t.distance ?? (t.odoStart != null && t.odoEnd != null ? Math.max(0, Number(t.odoEnd) - Number(t.odoStart)) : ""),
        userLabel(t.driverUserId || t.driverId),
        projectLabel(t.projectId),
        taskLabel(t.taskId),
        (t.notes || "").replace(/\r?\n/g, " "),
        t.startPhoto?.url ? toAbsoluteUrl(t.startPhoto.url) : "",
        t.endPhoto?.url ? toAbsoluteUrl(t.endPhoto.url) : "",
      ]),
    ];
    const csv = rows.map((r) =>
      r.map((cell) => {
        const s = String(cell ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(",")
    ).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `vehicle_${id}_trips.csv`;
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

  async function handleAddPurchase(e) {
    e.preventDefault();
    setPErr(""); setPInfo("");
    try {
      let vendorId = pForm.vendorId || "";
      let newVendor = null;

      if ((vendorId === "" || vendorId === "__new__") && pForm.newVendorName.trim()) {
        newVendor = await apiCreateVendor(pForm.newVendorName.trim());
        vendorId = newVendor?._id || newVendor?.id || "";
        await loadVendorsList();
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
      setPInfo("Purchase added.");
    } catch (e2) {
      setPErr(e2?.response?.data?.error || String(e2));
    }
  }

  async function handleDeletePurchase(rowId) {
    if (!confirm("Delete this purchase?")) return;
    setPErr(""); setPInfo("");
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
  }

  async function saveEditPurchase() {
    if (!editId) return;
    setPErr(""); setPInfo("");

    try {
      let vendorId = editForm.vendorId || "";
      if ((vendorId === "" || vendorId === "__new__") && editForm.newVendorName.trim()) {
        const vnew = await apiCreateVendor(editForm.newVendorName.trim());
        vendorId = vnew?._id || vnew?.id || "";
        await loadVendorsList();
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
      };

      const updated = await apiUpdatePurchase(editId, patch);
      setPurchases((prev) => prev.map((row) => (row._id === editId ? updated : row)));
      setPInfo("Purchase updated.");
      setTimeout(() => setPInfo(""), 1500);
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
    setV(prev => ({
      ...prev,
      projectId: pid,
      taskId: invalidTask ? "" : prev.taskId,
      task: invalidTask ? undefined : prev.task
    }));
    save({
      projectId: pid ? pid : null,
      ...(invalidTask ? { taskId: null } : {})
    });
  }

  // --- Section nav ---
  const sectionButtons = [
    { id: "meta", label: "Meta" },
    { id: "reminders", label: "Reminders" },
    { id: "trips", label: "Trips" },
    { id: "purchases", label: "Purchases" },
    { id: "logbook", label: "Logbook" },
  ];
  function scrollToSection(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (!v) return <div className="p-4">Loading… {err && <span style={{ color: "crimson" }}>({err})</span>}</div>;

  return (
    <div className="p-4 space-y-4">
      {/* Page heading */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Vehicle</h1>
        <div className="flex gap-2">
          <button className="px-3 py-2 border rounded" onClick={del}>Delete</button>
          <button className="px-3 py-2 border rounded" onClick={() => navigate(-1)}>Back</button>
        </div>
      </div>

      {/* Section buttons */}
      <div className="flex flex-wrap items-center gap-2 border-b pb-3" aria-label="Sections">
        {sectionButtons.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => scrollToSection(s.id)}
            className="inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-800 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-black/20 active:translate-y-px"
          >
            {s.label}
          </button>
        ))}
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {info && <div className="text-green-700">{info}</div>}

      {/* -------- Meta -------- */}
      <div id="meta" className="grid md:grid-cols-2 gap-4 scroll-mt-20">
        {/* Meta */}
        <div className="border rounded p-3 space-y-3">
          <div className="text-lg font-semibold mb-1">Meta</div>

          <label className="block text-sm">Registration
            <input className="border p-2 w-full"
                   value={v.reg ?? ""}
                   onChange={e => setV({ ...v, reg: e.target.value })}
                   onBlur={() => v.reg && save({ reg: v.reg })}
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">Make
              <input className="border p-2 w-full"
                     value={v.make ?? ""}
                     onChange={e => setV({ ...v, make: e.target.value })}
                     onBlur={() => save({ make: v.make || "" })}
              />
            </label>
            <label className="block text-sm">Model
              <input className="border p-2 w-full"
                     value={v.model ?? ""}
                     onChange={e => setV({ ...v, model: e.target.value })}
                     onBlur={() => save({ model: v.model || "" })}
              />
            </label>
          </div>

          <label className="block text-sm">Year
            <input className="border p-2 w-full" type="number" inputMode="numeric" min="1900" max="2100"
                   value={v.year ?? ""}
                   onChange={e => setV({ ...v, year: e.target.value })}
                   onBlur={() => save({ year: v.year ? Number(v.year) : undefined })}
            />
          </label>

          <label className="block text-sm">Project
            <select
              className="border p-2 w-full"
              value={v.projectId || ""}
              onChange={handleVehicleProjectChange}
            >
              <option value="">— none —</option>
              {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
          </label>

          {/* Driver */}
          <label className="block text-sm">Driver
            <div className="flex items-center gap-2">
              <select
                className="border p-2 w-full"
                value={selectedDriverId}
                onChange={(e) => {
                  const val = e.target.value;
                  setV(prev => ({ ...prev, driverId: val || "", driver: undefined }));
                  save({ driverId: val || null });
                }}
              >
                <option value="">— none —</option>
                {users.map(u => (
                  <option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>
                ))}
              </select>
              {selectedDriverId && (
                <button
                  type="button"
                  className="px-2 py-1 border rounded"
                  onClick={() => { setV(prev => ({ ...prev, driverId: "", driver: null })); save({ driverId: null }); }}
                >
                  Clear
                </button>
              )}
            </div>
            {selectedDriverId && (
              <div className="mt-1 text-xs text-gray-600">
                Currently: {userLabel(v.driver || v.driverId)}
              </div>
            )}
          </label>

          {/* Task allocation (filtered by selected project) */}
          <label className="block text-sm">Task
            <div className="flex items-center gap-2">
              <select
                className="border p-2 w-full"
                value={v?.task?._id || v?.taskId || ""}
                onChange={(e) => {
                  const val = e.target.value || "";
                  setV(prev => ({ ...prev, taskId: val, task: undefined }));
                  save({ taskId: val || null });
                }}
              >
                <option value="">— none —</option>
                {tasksForVehicleProject.map(t => (
                  <option key={t._id} value={t._id}>{t.title || t._id}</option>
                ))}
              </select>
              {(v?.task?._id || v?.taskId) && (
                <button
                  type="button"
                  className="px-2 py-1 border rounded"
                  onClick={() => { setV(prev => ({ ...prev, taskId: "", task: null })); save({ taskId: null }); }}
                >
                  Clear
                </button>
              )}
            </div>
            {(v?.task?._id || v?.taskId) && (
              <div className="mt-1 text-xs">
                <Link className="underline" to={`/tasks/${v?.task?._id || v?.taskId}`}>Open task</Link>
              </div>
            )}
          </label>

          <label className="block text-sm">Status
            <div className="flex items-center gap-2">
              <StatusBadge value={v.status || "active"} />
              <select className="border p-2"
                      value={v.status || "active"}
                      onChange={e => setStatus(e.target.value)}
              >
                <option value="active">active</option>
                <option value="workshop">workshop</option>
                <option value="retired">retired</option>
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
        <div id="reminders" className="border rounded p-3 space-y-3 scroll-mt-20">
          <div className="text-lg font-semibold">Service Reminders</div>

          <div className="text-sm text-gray-700">
            {nextDue?.dateDue && (
              <span className="mr-3">Next date: <b>{new Date(nextDue.dateDue.dueDate).toLocaleDateString()}</b></span>
            )}
            {nextDue?.odoDue && (
              <span className="mr-3">Next km: <b>{nextDue.odoDue.dueOdometer} km</b></span>
            )}
            {currentOdo != null && (
              <span>Current ODO: <b>{currentOdo} km</b></span>
            )}
          </div>

          {rErr && <div className="text-red-600">{rErr}</div>}
          {rInfo && <div className="text-green-700">{rInfo}</div>}

          {/* Create */}
          <form onSubmit={addReminder} className="grid md:grid-cols-12 gap-2">
            <label className="text-sm md:col-span-2">
              Category
              <select
                className="border p-2 w-full"
                value={rForm.category}
                onChange={(e) => setRForm({ ...rForm, category: e.target.value })}
              >
                {LOG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="text-sm md:col-span-2">
              Type
              <select className="border p-2 w-full" value={rForm.kind} onChange={e => setRForm({ ...rForm, kind: e.target.value })}>
                <option value="date">By date</option>
                <option value="odometer">By odometer</option>
              </select>
            </label>
            {rForm.kind === 'date' ? (
              <label className="text-sm md:col-span-3">Due date
                <input className="border p-2 w-full" type="date" value={rForm.dueDate} onChange={e => setRForm({ ...rForm, dueDate: e.target.value })} required />
              </label>
            ) : (
              <label className="text-sm md:col-span-3">Due km
                <input className="border p-2 w-full" type="number" inputMode="numeric" min="0" value={rForm.dueOdometer} onChange={e => setRForm({ ...rForm, dueOdometer: e.target.value })} required />
              </label>
            )}
            <label className="text-sm md:col-span-5">Notes
              <input className="border p-2 w-full" value={rForm.notes} onChange={e => setRForm({ ...rForm, notes: e.target.value })} />
            </label>

            {/* Recurring options for service */}
            {rForm.category === "service" && (
              <>
                <div className="md:col-span-12 border-t my-2" />
                <label className="text-sm md:col-span-2 inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={rForm.recurring}
                    onChange={(e) => setRForm((f) => ({ ...f, recurring: e.target.checked }))}
                  />
                  <span>Recurring</span>
                </label>
                <label className="text-sm md:col-span-2">
                  Every (days)
                  <input
                    className="border p-2 w-full"
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
                    className="border p-2 w-full"
                    type="number"
                    min="0"
                    value={rForm.recurKm}
                    onChange={(e) => setRForm((f) => ({ ...f, recurKm: e.target.value }))}
                    placeholder="e.g. 10000"
                    disabled={!rForm.recurring}
                  />
                </label>
                <div className="text-xs text-gray-600 md:col-span-6">
                  Set one or both. If both are set, the system adds a paired date+km reminder for the next cycle and will auto-close the sibling when one is completed.
                </div>
              </>
            )}

            <div className="md:col-span-12">
              <button className="px-3 py-2 bg-black text-white rounded" type="submit">Add reminder</button>
            </div>
          </form>

          {/* List (inline edit like Purchases) */}
          <table className="w-full border text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="border p-2 text-left">Category</th>
                <th className="border p-2 text-left">Type</th>
                <th className="border p-2 text-left">Due</th>
                <th className="border p-2 text-left">Notes</th>
                <th className="border p-2 text-left">Active</th>
                <th className="border p-2 text-left">Status</th>
                <th className="border p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(reminders || []).map(r => {
                const cat = parseReminderCategory(r.notes || "") || "—";
                const s = reminderStatus(r, currentOdo);
                const completedOn = parseReminderCompletedOn(r.notes || "");
                const rowTintClass =
                  s.code === "overdue" ? "bg-red-50" :
                  s.code === "due-soon" ? "bg-amber-50" : "";
                const rowTintStyle =
                  s.code === "overdue" ? { backgroundColor: "#fee2e2" } :
                  s.code === "due-soon" ? { backgroundColor: "#fffbeb" } : {};
                const badgeStyle =
                  s.code === "overdue" ? { backgroundColor: "#fee2e2", color: "#991b1b" } :
                  s.code === "due-soon" ? { backgroundColor: "#fef3c7", color: "#92400e" } :
                  s.code === "paused" ? { backgroundColor: "#e5e7eb", color: "#374151" } :
                  s.code === "completed" ? { backgroundColor: "#dbeafe", color: "#1e40af" } :
                  { backgroundColor: "#d1fae5", color: "#065f46" };

                const isEditing = rEditId === r._id;

                return (
                  <tr key={r._id} className={rowTintClass} style={rowTintStyle}>
                    <td className="border p-2">
                      {!isEditing ? (
                        cat
                      ) : (
                        <select
                          className="border p-1"
                          value={rEditForm.category}
                          onChange={(e)=>setREditForm(f=>({...f,category:e.target.value}))}
                        >
                          {LOG_TYPES.map((t)=><option key={t} value={t}>{t}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="border p-2">{r.kind}</td>
                    <td className="border p-2">
                      {!isEditing ? (
                        r.kind === 'date'
                          ? (r.dueDate ? new Date(r.dueDate).toLocaleDateString() : '—')
                          : (r.dueOdometer != null ? `${r.dueOdometer} km` : '—')
                      ) : (
                        r.kind === "date" ? (
                          <input
                            className="border p-1"
                            type="date"
                            value={rEditForm.dueDate}
                            onChange={(e)=>setREditForm(f=>({...f,dueDate:e.target.value}))}
                          />
                        ) : (
                          <input
                            className="border p-1 w-28"
                            type="number"
                            inputMode="numeric"
                            min="0"
                            value={rEditForm.dueOdometer}
                            onChange={(e)=>setREditForm(f=>({...f,dueOdometer:e.target.value}))}
                          />
                        )
                      )}
                    </td>
                    <td className="border p-2">
                      {!isEditing ? (
                        stripReminderTokens(r.notes || "—") || "—"
                      ) : (
                        <div className="flex flex-col gap-2">
                          <input
                            className="border p-1 w-full"
                            value={rEditForm.notes}
                            onChange={(e)=>setREditForm(f=>({...f,notes:e.target.value}))}
                          />
                          {rEditForm.category === "service" && (
                            <div className="flex items-end gap-2 text-xs">
                              <label className="inline-flex items-center gap-1">
                                <input
                                  type="checkbox"
                                  checked={rEditForm.recurring}
                                  onChange={(e)=>setREditForm(f=>({...f,recurring:e.target.checked}))}
                                />
                                <span>Recurring</span>
                              </label>
                              <label>
                                Days:&nbsp;
                                <input
                                  className="border p-1 w-20"
                                  type="number"
                                  min="0"
                                  value={rEditForm.recurDays}
                                  onChange={(e)=>setREditForm(f=>({...f,recurDays:e.target.value}))}
                                  disabled={!rEditForm.recurring}
                                />
                              </label>
                              <label>
                                Km:&nbsp;
                                <input
                                  className="border p-1 w-24"
                                  type="number"
                                  min="0"
                                  value={rEditForm.recurKm}
                                  onChange={(e)=>setREditForm(f=>({...f,recurKm:e.target.value}))}
                                  disabled={!rEditForm.recurring}
                                />
                              </label>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="border p-2">
                      {s.code === "completed" ? (
                        <span className="text-xs">Completed{completedOn ? ` on ${completedOn}` : ""}</span>
                      ) : (
                        <label className="inline-flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={!!r.active}
                            onChange={e => toggleReminderActive(r._id, e.target.checked)}
                          />
                          <span className="text-xs">{r.active ? 'active' : 'paused'}</span>
                        </label>
                      )}
                    </td>
                    <td className="border p-2">
                      <span className={`text-xs px-2 py-1 rounded ${s.badgeClass}`} style={badgeStyle}>{s.label}</span>
                    </td>
                    <td className="border p-2 text-right">
                      {!isEditing ? (
                        <>
                          <button type="button" className="px-2 py-1 border rounded mr-1" onClick={()=>beginEditReminder(r)}>Edit</button>
                          <button type="button" className="px-2 py-1 border rounded" onClick={() => deleteReminder(r._id)}>Delete</button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="px-2 py-1 border rounded mr-1" onClick={saveEditReminder}>Save</button>
                          <button type="button" className="px-2 py-1 border rounded" onClick={cancelEditReminder}>Cancel</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {(!reminders || reminders.length === 0) && (
                <tr><td className="p-4 text-center" colSpan={7}>No reminders</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- Vehicle Trips ---------------- */}
      <div id="trips" className="border rounded p-3 space-y-3 scroll-mt-20">
        <div className="text-lg font-semibold">Vehicle Trips</div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {tripsLoading && <div className="text-sm text-gray-500">Loading…</div>}
            {tripErr && <div className="text-red-600 text-sm">{tripErr}</div>}
            {tripInfo && <div className="text-green-700 text-sm">{tripInfo}</div>}
          </div>
          <button
            className="px-3 py-2 border rounded"
            onClick={exportTripCsv}
            disabled={!filteredTrips.length}
            title={!filteredTrips.length ? "No trips to export" : "Export trips to CSV"}
            type="button"
          >
            Export Trip CSV
          </button>
        </div>

        {/* Trip Filters */}
        <fieldset className="border rounded p-3">
          <legend className="px-2 text-xs uppercase tracking-wide text-gray-600">Trip Filters</legend>
          <div className="flex flex-wrap gap-2 items-end">
            <label className="text-sm">
              Driver
              <select
                className="border p-2 w-48"
                value={tripDriverFilter}
                onChange={(e) => setTripDriverFilter(e.target.value)}
              >
                <option value="">Any</option>
                {tripDriverOptions.map(opt => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Project
              <select
                className="border p-2 w-48"
                value={tripProjectFilter}
                onChange={(e) => setTripProjectFilter(e.target.value)}
              >
                <option value="">Any</option>
                {tripProjectOptions.map(opt => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Task
              <select
                className="border p-2 w-48"
                value={tripTaskFilter}
                onChange={(e) => setTripTaskFilter(e.target.value)}
              >
                <option value="">Any</option>
                {tripTaskOptions.map(opt => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="px-3 py-2 border rounded"
              onClick={() => { setTripDriverFilter(""); setTripProjectFilter(""); setTripTaskFilter(""); }}
            >
              Clear filters
            </button>
            <div className="text-sm text-gray-600 ml-auto">
              Showing <b>{filteredTrips.length}</b> of {trips.length}
            </div>
          </div>
        </fieldset>

        {/* Start/End Trip */}
        {!openTrip ? (
          <form onSubmit={handleStartTrip} className="grid md:grid-cols-2 gap-3">
            <label className="text-sm">
              Odometer start
              <input
                className="border p-2 w-full"
                type="number"
                min="0"
                required
                value={odoStart}
                onChange={e => setOdoStart(e.target.value)}
                placeholder="e.g. 10234.5"
              />
            </label>

            <label className="text-sm">
              Photo (start)
              <input
                className="border p-2 w-full"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={e => setStartFile(e.target.files?.[0] || null)}
              />
            </label>

            <label className="text-sm">
              Project (optional)
              <select
                className="border p-2 w-full"
                value={tripProjectId}
                onChange={e => {
                  const pid = e.target.value || "";
                  setTripProjectId(pid);
                  if (tripTaskId && !taskMatchesProject(tripTaskId, pid)) setTripTaskId("");
                }}
              >
                <option value="">— none —</option>
                {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
              </select>
            </label>

            <label className="text-sm">
              Task (optional)
              <select
                className="border p-2 w-full"
                value={tripTaskId}
                onChange={(e) => setTripTaskId(e.target.value)}
              >
                <option value="">— none —</option>
                {tasksForTripProject.map(t => <option key={t._id} value={t._id}>{t.title}</option>)}
              </select>
            </label>

            <div className="md:col-span-2">
              <button className="px-3 py-2 border rounded" type="submit">
                Start trip
              </button>
            </div>
          </form>
        ) : (
          <form onSubmit={handleEndTrip} className="grid md:grid-cols-2 gap-3 bg-yellow-50 border border-yellow-200 p-3 rounded">
            <div className="md:col-span-2 text-sm">
              <b>Open trip:</b> started {openTrip.startedAt ? new Date(openTrip.startedAt).toLocaleString() : "—"} &middot; ODO start: {openTrip.odoStart ?? "—"}
            </div>

            <label className="text-sm">
              Odometer end
              <input
                className="border p-2 w-full"
                type="number"
                min={openTrip.odoStart ?? 0}
                required
                value={odoEnd}
                onChange={e => setOdoEnd(e.target.value)}
                placeholder="e.g. 10245.8"
              />
            </label>

            <label className="text-sm">
              Photo (end)
              <input
                className="border p-2 w-full"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={e => setEndFile(e.target.files?.[0] || null)}
              />
            </label>

            <label className="text-sm md:col-span-2">
              Notes (optional)
              <input
                className="border p-2 w-full"
                value={tripNotes}
                onChange={(e) => setTripNotes(e.target.value)}
                placeholder="Trip notes…"
              />
            </label>

            <div className="md:col-span-2">
              <button className="px-3 py-2 border rounded" type="submit">End trip</button>
            </div>
          </form>
        )}

        {/* Trip list with inline edit */}
        <div className="border rounded overflow-x-auto mt-3">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="p-2 text-left">Started</th>
                <th className="p-2 text-left">Ended</th>
                <th className="p-2 text-left">ODO</th>
                <th className="p-2 text-left">Driver</th>
                <th className="p-2 text-left">Project</th>
                <th className="p-2 text-left">Task</th>
                <th className="p-2 text-left">Distance</th>
                <th className="p-2 text-left">Photos</th>
                <th className="p-2 text-left">Notes</th>
                <th className="p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredTrips.length ? filteredTrips.map(trip => {
                const isEditing = tripEditId === trip._id;
                const isOpenRow = openTrip && String(openTrip._id) === String(trip._id);
                return (
                  <tr key={trip._id}>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        trip.startedAt ? new Date(trip.startedAt).toLocaleString() : "—"
                      ) : (
                        <input
                          className="border p-1"
                          type="datetime-local"
                          value={tripEditForm.startedAt}
                          onChange={(e)=>setTripEditForm(f=>({...f,startedAt:e.target.value}))}
                        />
                      )}
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        trip.endedAt ? new Date(trip.endedAt).toLocaleString() : "—"
                      ) : (
                        <input
                          className="border p-1"
                          type="datetime-local"
                          value={tripEditForm.endedAt}
                          onChange={(e)=>setTripEditForm(f=>({...f,endedAt:e.target.value}))}
                        />
                      )}
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        <>
                          {trip.odoStart ?? "—"} → {trip.odoEnd ?? "—"}
                        </>
                      ) : (
                        <div className="flex items-center gap-1">
                          <input
                            className="border p-1 w-24"
                            type="number"
                            inputMode="numeric"
                            value={tripEditForm.odoStart}
                            onChange={(e)=>setTripEditForm(f=>({...f,odoStart:e.target.value}))}
                            placeholder="start"
                          />
                          <span>→</span>
                          <input
                            className="border p-1 w-24"
                            type="number"
                            inputMode="numeric"
                            value={tripEditForm.odoEnd}
                            onChange={(e)=>setTripEditForm(f=>({...f,odoEnd:e.target.value}))}
                            placeholder="end"
                          />
                        </div>
                      )}
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        userLabel(trip.driverUserId || trip.driverId)
                      ) : (
                        <select
                          className="border p-1"
                          value={tripEditForm.driverUserId}
                          onChange={(e)=>setTripEditForm(f=>({...f,driverUserId:e.target.value}))}
                        >
                          <option value="">— none —</option>
                          {users.map(u => <option key={u._id} value={u._id}>{u.name || u.email || u.username}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        trip.projectId ? <Link className="underline" to={`/projects/${trip.projectId}`}>{projectLabel(trip.projectId)}</Link> : "—"
                      ) : (
                        <select
                          className="border p-1"
                          value={tripEditForm.projectId}
                          onChange={(e)=>{
                            const pid = e.target.value || "";
                            setTripEditForm(f=>({
                              ...f,
                              projectId: pid,
                              taskId: f.taskId && !taskMatchesProject(f.taskId, pid) ? "" : f.taskId
                            }));
                          }}
                        >
                          <option value="">— none —</option>
                          {projects.map(p => <option key={p._id} value={p._id}>{p.name}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        trip.taskId ? <Link className="underline" to={`/tasks/${trip.taskId}`}>{taskLabel(trip.taskId)}</Link> : "—"
                      ) : (
                        <select
                          className="border p-1"
                          value={tripEditForm.taskId}
                          onChange={(e)=>setTripEditForm(f=>({...f,taskId:e.target.value}))}
                        >
                          <option value="">— none —</option>
                          {tasksForTripEditProject.map(t => <option key={t._id} value={t._id}>{t.title}</option>)}
                        </select>
                      )}
                    </td>
                    <td className="border-t p-2">{trip.distance != null ? `${trip.distance} km` : "—"}</td>
                    <td className="border-t p-2">
                      <div className="flex gap-2">
                        {trip.startPhoto?.url && (
                          <a href={toAbsoluteUrl(trip.startPhoto.url)} target="_blank" rel="noreferrer" title="Start photo">
                            <img
                              src={toAbsoluteUrl(trip.startPhoto.url)}
                              alt="Start"
                              style={{ width: 72, height: 48, objectFit: "cover", borderRadius: 6 }}
                            />
                          </a>
                        )}
                        {trip.endPhoto?.url && (
                          <a href={toAbsoluteUrl(trip.endPhoto.url)} target="_blank" rel="noreferrer" title="End photo">
                            <img
                              src={toAbsoluteUrl(trip.endPhoto.url)}
                              alt="End"
                              style={{ width: 72, height: 48, objectFit: "cover", borderRadius: 6 }}
                            />
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        trip.notes || "—"
                      ) : (
                        <input
                          className="border p-1 w-full"
                          value={tripEditForm.notes}
                          onChange={(e)=>setTripEditForm(f=>({...f,notes:e.target.value}))}
                        />
                      )}
                    </td>
                    <td className="border-t p-2 text-right">
                      {!isEditing ? (
                        <>
                          {!isOpenRow ? (
                            <button type="button" className="px-2 py-1 border rounded" onClick={()=>beginEditTrip(trip)}>Edit</button>
                          ) : (
                            <span className="text-xs text-gray-500">End trip to edit</span>
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="px-2 py-1 border rounded mr-1"
                            onClick={saveEditTrip}
                            disabled={tripSaving}
                            title={tripSaving ? "Saving…" : "Save changes"}
                          >
                            {tripSaving ? "Saving…" : "Save"}
                          </button>
                          <button type="button" className="px-2 py-1 border rounded" onClick={cancelEditTrip} disabled={tripSaving}>
                            Cancel
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              }) : (
                <tr><td className="p-3 text-center" colSpan={10}>No trips match filters</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- Purchases ---------------- */}
      <div id="purchases" className="border rounded p-3 space-y-3 scroll-mt-20">
        <div className="text-lg font-semibold">Purchases</div>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {pErr && <div className="text-red-600 text-sm">{pErr}</div>}
            {pInfo && <div className="text-green-700 text-sm">{pInfo}</div>}
          </div>
        </div>

        {/* Create purchase */}
        <form onSubmit={handleAddPurchase} className="grid md:grid-cols-6 gap-2">
          <label className="text-sm">
            Vendor
            <select
              className="border p-2 w-full"
              value={pForm.vendorId}
              onChange={(e) => setPForm((f) => ({ ...f, vendorId: e.target.value }))}
            >
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
              <input
                className="border p-2 w-full"
                value={pForm.newVendorName}
                onChange={(e) => setPForm((f) => ({ ...f, newVendorName: e.target.value }))}
                placeholder="e.g. AutoCare Pty"
              />
            </label>
          )}

          <label className="text-sm">
            Type
            <select
              className="border p-2 w-full"
              value={pForm.type}
              onChange={(e) => setPForm((f) => ({ ...f, type: e.target.value }))}
            >
              {PURCHASE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            Date
            <input
              className="border p-2 w-full"
              type="date"
              value={pForm.date}
              onChange={(e) => setPForm((f) => ({ ...f, date: e.target.value }))}
            />
          </label>

          <label className="text-sm">
            Cost
            <input
              className="border p-2 w-full"
              type="number"
              inputMode="decimal"
              min="0"
              value={pForm.cost}
              onChange={(e) => setPForm((f) => ({ ...f, cost: e.target.value }))}
            />
          </label>

          <label className="text-sm">
            Project
            <select
              className="border p-2 w-full"
              value={pForm.projectId}
              onChange={(e) => {
                const pid = e.target.value || "";
                setPForm((f) => ({
                  ...f,
                  projectId: pid,
                  taskId: f.taskId && !taskMatchesProject(f.taskId, pid) ? "" : f.taskId
                }));
              }}
            >
              <option value="">— none —</option>
              {projects.map((p) => (
                <option key={p._id} value={p._id}>{p.name}</option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            Task
            <select
              className="border p-2 w-full"
              value={pForm.taskId}
              onChange={(e) => setPForm((f) => ({ ...f, taskId: e.target.value }))}
            >
              <option value="">— none —</option>
              {tasksForPurchaseProject.map((t) => (
                <option key={t._id} value={t._id}>{t.title}</option>
              ))}
            </select>
          </label>

          <label className="text-sm md:col-span-6">
            Notes
            <input
              className="border p-2 w-full"
              value={pForm.notes}
              onChange={(e) => setPForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="What was purchased / reference / invoice # …"
            />
          </label>

          <div className="md:col-span-6">
            <button className="px-3 py-2 bg-black text-white rounded" type="submit">Add purchase</button>
          </div>
        </form>

        {/* Purchases list */}
        <div className="border rounded overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50">
                <th className="p-2 text-left">Date</th>
                <th className="p-2 text-left">Type</th>
                <th className="p-2 text-left">Vendor</th>
                <th className="p-2 text-left">Cost</th>
                <th className="p-2 text-left">Project</th>
                <th className="p-2 text-left">Task</th>
                <th className="p-2 text-left">Notes</th>
                <th className="p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {purchases.length ? purchases.map((p) => {
                const isEditing = editId === p._id;
                return (
                  <tr key={p._id}>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        p.date ? new Date(p.date).toLocaleDateString() : "—"
                      ) : (
                        <input
                          className="border p-1 w-36"
                          type="date"
                          value={editForm.date}
                          onChange={(e) => setEditForm((f) => ({ ...f, date: e.target.value }))}
                        />
                      )}
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        p.type || "—"
                      ) : (
                        <select
                          className="border p-1"
                          value={editForm.type}
                          onChange={(e) => setEditForm((f) => ({ ...f, type: e.target.value }))}
                        >
                          {PURCHASE_TYPES.map((t) => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        vendorLabel(p.vendor)
                      ) : (
                        <div className="flex items-center gap-2">
                          <select
                            className="border p-1"
                            value={editForm.vendorId}
                            onChange={(e) => setEditForm((f) => ({ ...f, vendorId: e.target.value }))}
                          >
                            <option value="">— none —</option>
                            {vendors.map((vnd) => (
                              <option key={vnd._id || vnd.id} value={vnd._id || vnd.id}>
                                {vnd.name}
                              </option>
                            ))}
                            <option value="__new__">+ Add new vendor…</option>
                          </select>
                          {(editForm.vendorId === "" || editForm.vendorId === "__new__") && (
                            <input
                              className="border p-1"
                              placeholder="New vendor"
                              value={editForm.newVendorName}
                              onChange={(e) => setEditForm((f) => ({ ...f, newVendorName: e.target.value }))}
                            />
                          )}
                        </div>
                      )}
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        p.cost ?? "—"
                      ) : (
                        <input
                          className="border p-1 w-24"
                          type="number"
                          inputMode="decimal"
                          min="0"
                          value={editForm.cost}
                          onChange={(e) => setEditForm((f) => ({ ...f, cost: e.target.value }))}
                        />
                      )}
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        projectLabel(p.projectId)
                      ) : (
                        <select
                          className="border p-1"
                          value={editForm.projectId}
                          onChange={(e) => {
                            const pid = e.target.value || "";
                            setEditForm(f => ({
                              ...f,
                              projectId: pid,
                              taskId: f.taskId && !taskMatchesProject(f.taskId, pid) ? "" : f.taskId
                            }));
                          }}
                        >
                          <option value="">— none —</option>
                          {projects.map((pr) => (
                            <option key={pr._id} value={pr._id}>{pr.name}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        taskLabel(p.taskId)
                      ) : (
                        <select
                          className="border p-1"
                          value={editForm.taskId}
                          onChange={(e) => setEditForm((f) => ({ ...f, taskId: e.target.value }))}
                        >
                          <option value="">— none —</option>
                          {tasksForPurchaseEditProject.map((t) => (
                            <option key={t._id} value={t._id}>{t.title}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="border-t p-2">
                      {!isEditing ? (
                        p.notes || "—"
                      ) : (
                        <input
                          className="border p-1 w-full"
                          value={editForm.notes}
                          onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                        />
                      )}
                    </td>
                    <td className="border-t p-2 text-right">
                      {!isEditing ? (
                        <>
                          <button type="button" className="px-2 py-1 border rounded mr-1" onClick={() => beginEditPurchase(p)}>
                            Edit
                          </button>
                          <button type="button" className="px-2 py-1 border rounded" onClick={() => handleDeletePurchase(p._id)}>
                            Delete
                          </button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="px-2 py-1 border rounded mr-1" onClick={saveEditPurchase}>
                            Save
                          </button>
                          <button type="button" className="px-2 py-1 border rounded" onClick={cancelEdit}>
                            Cancel
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              }) : (
                <tr><td className="p-3 text-center" colSpan={8}>No purchases yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ---------------- Logbook (non-travel) ---------------- */}
      <div id="logbook" className="border rounded p-3 space-y-3 scroll-mt-20">
        <div className="text-lg font-semibold">Logbook</div>

        <div className="text-sm text-gray-700">
          Entries: <b>{entries.length}</b>
        </div>

        {/* Create entry */}
        <form onSubmit={createEntry} className="grid md:grid-cols-6 gap-2">
          <label className="text-sm">
            Type
            <select className="border p-2 w-full" value={lbForm.type} onChange={e => setLbForm({ ...lbForm, type: e.target.value })}>
              {LOG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="text-sm">
            Timestamp
            <input className="border p-2 w-full" type="datetime-local" value={lbForm.ts} onChange={e => setLbForm({ ...lbForm, ts: e.target.value })} />
          </label>
          <label className="text-sm">
            Odometer (km)
            <input className="border p-2 w-full" type="number" inputMode="numeric" min="0"
                   value={lbForm.odometer} onChange={e => setLbForm({ ...lbForm, odometer: e.target.value })} />
          </label>
          <label className="text-sm">
            Cost
            <input className="border p-2 w-full" type="number" inputMode="decimal" min="0"
                   value={lbForm.cost} onChange={e => setLbForm({ ...lbForm, cost: e.target.value })} />
          </label>
          <label className="text-sm">
            Vendor
            <input className="border p-2 w-full" value={lbForm.vendor} onChange={e => setLbForm({ ...lbForm, vendor: e.target.value })} />
          </label>
          <label className="text-sm">
            Tags (comma)
            <input className="border p-2 w-full" value={lbForm.tags} onChange={e => setLbForm({ ...lbForm, tags: e.target.value })} placeholder="service, warranty" />
          </label>
          <label className="text-sm md:col-span-6">
            Notes
            <textarea className="border p-2 w-full" rows={3} value={lbForm.notes} onChange={e => setLbForm({ ...lbForm, notes: e.target.value })} />
          </label>
          <label className="text-sm md:col-span-3">
            Completes reminder (optional)
            <select className="border p-2 w-full"
                    value={lbForm.completeReminderId}
                    onChange={e => setLbForm({ ...lbForm, completeReminderId: e.target.value })}>
              <option value="">— none —</option>
              {(reminders || []).filter(r => r.active).map(r => (
                <option key={r._id} value={r._id}>
                  {(parseReminderCategory(r.notes || "") || "—") + " · " + (r.kind === 'date'
                    ? `Date: ${r.dueDate ? new Date(r.dueDate).toLocaleDateString() : '—'}`
                    : `Odo: ${r.dueOdometer ?? '—'} km`)}
                </option>
              ))}
            </select>
          </label>
          <div className="md:col-span-6">
            <button className="px-3 py-2 bg-black text-white rounded" type="submit">Add entry</button>
          </div>
        </form>

        {lbErr && <div className="text-red-600">{lbErr}</div>}
        {lbInfo && <div className="text-green-700">{lbInfo}</div>}

        {/* List with inline edit like Purchases */}
        <table className="w-full border text-sm">
          <thead>
            <tr className="bg-gray-50">
              <th className="border p-2 text-left">When</th>
              <th className="border p-2 text-left">Type</th>
              <th className="border p-2 text-left">Odometer</th>
              <th className="border p-2 text-left">Cost</th>
              <th className="border p-2 text-left">Vendor</th>
              <th className="border p-2 text-left">Tags</th>
              <th className="border p-2 text-left">Notes</th>
              <th className="border p-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(e => {
              const d = entryDisplay(e);
              const isEditing = lbEditId === e._id;
              return (
                <tr key={e._id}>
                  <td className="border p-2">
                    {!isEditing ? (
                      d.ts ? new Date(d.ts).toLocaleString() : "—"
                    ) : (
                      <input
                        className="border p-1"
                        type="datetime-local"
                        value={lbEditForm.ts}
                        onChange={(ev)=>setLbEditForm(f=>({...f,ts:ev.target.value}))}
                      />
                    )}
                  </td>
                  <td className="border p-2">
                    {!isEditing ? (
                      d.type
                    ) : (
                      <select
                        className="border p-1"
                        value={lbEditForm.type}
                        onChange={(ev)=>setLbEditForm(f=>({...f,type:ev.target.value}))}
                      >
                        {LOG_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    )}
                  </td>
                  <td className="border p-2">
                    {!isEditing ? (
                      d.odometer ?? "—"
                    ) : (
                      <input
                        className="border p-1 w-24"
                        type="number"
                        inputMode="numeric"
                        value={lbEditForm.odometer}
                        onChange={(ev)=>setLbEditForm(f=>({...f,odometer:ev.target.value}))}
                      />
                    )}
                  </td>
                  <td className="border p-2">
                    {!isEditing ? (
                      d.cost !== "" ? d.cost : "—"
                    ) : (
                      <input
                        className="border p-1 w-24"
                        type="number"
                        inputMode="decimal"
                        min="0"
                        value={lbEditForm.cost}
                        onChange={(ev)=>setLbEditForm(f=>({...f,cost:ev.target.value}))}
                      />
                    )}
                  </td>
                  <td className="border p-2">
                    {!isEditing ? (
                      d.vendor || "—"
                    ) : (
                      <input
                        className="border p-1"
                        value={lbEditForm.vendor}
                        onChange={(ev)=>setLbEditForm(f=>({...f,vendor:ev.target.value}))}
                      />
                    )}
                  </td>
                  <td className="border p-2">
                    {!isEditing ? (
                      (d.tags || []).join(", ") || "—"
                    ) : (
                      <input
                        className="border p-1"
                        value={lbEditForm.tags}
                        onChange={(ev)=>setLbEditForm(f=>({...f,tags:ev.target.value}))}
                      />
                    )}
                  </td>
                  <td className="border p-2">
                    {!isEditing ? (
                      d.notes || "—"
                    ) : (
                      <input
                        className="border p-1 w-full"
                        value={lbEditForm.notes}
                        onChange={(ev)=>setLbEditForm(f=>({...f,notes:ev.target.value}))}
                      />
                    )}
                  </td>
                  <td className="border p-2 text-right">
                    {!isEditing ? (
                      <>
                        <button type="button" className="px-2 py-1 border rounded mr-1" onClick={()=>beginEditEntry(e)}>Edit</button>
                        <button type="button" className="px-2 py-1 border rounded" onClick={() => deleteEntry(e._id)}>Delete</button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="px-2 py-1 border rounded mr-1" onClick={saveLbEdit}>Save</button>
                        <button type="button" className="px-2 py-1 border rounded" onClick={cancelLbEdit}>Cancel</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {!entries.length && <tr><td className="p-4 text-center" colSpan={8}>No log entries</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
