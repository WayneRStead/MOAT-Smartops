// src/lib/vehicleTrips.js
import { api } from "./api";

/* ------------------------ small helpers ------------------------ */
function toISO(val) {
  if (val == null || val === "") return undefined;
  try {
    if (val instanceof Date) return val.toISOString();
    // Handles both full ISO and <input type="datetime-local"> strings
    const d = new Date(String(val));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  } catch {}
  return undefined;
}
function num(n) {
  if (n === "" || n == null) return undefined;
  const x = Number(n);
  return Number.isFinite(x) ? x : undefined;
}
function stripUndef(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/* ----------------------------- reads --------------------------- */
export async function listTrips(vehicleId, params = {}) {
  // Server returns an array; keep it. If it ever returns {items:[]}, handle that too.
  const { data } = await api.get(`/vehicles/${vehicleId}/trips`, { params });
  const list = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);
  return list;
}
export function getOpenTrip(vehicleId) {
  return api.get(`/vehicles/${vehicleId}/trips/open`).then(r => r.data);
}
export function getTrip(id) {
  return api.get(`/vehicle-trips/${id}`).then(r => r.data);
}
export function getTripAudit(id) {
  return api.get(`/vehicle-trips/${id}/audit`).then(r => r.data);
}

/* ----------------------- create / updates ---------------------- */
export function startTrip(vehicleId, payload) {
  // payload: { odoStart, projectId?, taskId?, startPhotoUrl?, tags?, notes? }
  return api.post(`/vehicles/${vehicleId}/trips/start`, payload).then(r => r.data);
}
export function endTrip(vehicleId, tripId, payload) {
  // payload: { odoEnd, endPhotoUrl?, notes? }
  return api.post(`/vehicles/${vehicleId}/trips/${tripId}/end`, payload).then(r => r.data);
}

/**
 * Update a trip, trying multiple route variants for maximum compatibility.
 * @param {string} tripId
 * @param {object} patch
 * @param {object} [opts]  - { vehicleId?: string } to try nested routes first
 */
export async function updateTrip(tripId, patch = {}, opts = {}) {
  const vehId = opts.vehicleId || patch?.vehicleId;

  // normalize + mirror fields many APIs expect
  const clean = stripUndef({
    ...patch,
    startedAt: toISO(patch?.startedAt),
    endedAt: toISO(patch?.endedAt),
    odoStart: num(patch?.odoStart),
    odoEnd: num(patch?.odoEnd),
    // mirror driver id fieldnames
    driverUserId: patch?.driverUserId || patch?.driverId,
    driverId: patch?.driverUserId || patch?.driverId,
  });

  // Try canonical first, then aliases and nested variants
  const attempts = [
    { m: "patch", u: `/vehicle-trips/${tripId}` }, // canonical (hyphen)
    { m: "patch", u: `/vehicleTrips/${tripId}` },  // alias (camel)
  ];

  if (vehId) {
    attempts.push(
      { m: "put",   u: `/vehicles/${vehId}/trips/${tripId}` },
      { m: "patch", u: `/vehicles/${vehId}/trips/${tripId}` },
    );
  }

  // Generic trips collections some apps expose
  attempts.push(
    { m: "put",   u: `/trips/${tripId}` },
    { m: "patch", u: `/trips/${tripId}` },
  );

  let lastErr;
  for (const a of attempts) {
    try {
      const { data } = await api[a.m](a.u, clean);
      return data;
    } catch (e) {
      const code = e?.response?.status;
      // keep trying on "endpoint not found / not allowed" style errors
      if ([404, 405, 400, 501].includes(code)) { lastErr = e; continue; }
      throw e; // other errors (403, 500, validation) should surface immediately
    }
  }
  throw lastErr || new Error("Trip update endpoint not found.");
}

/**
 * Optional helper if you ever need to remove a mistaken trip.
 * Tries nested first if vehicleId is provided.
 */
export async function deleteTrip(tripId, opts = {}) {
  const vehId = opts.vehicleId;
  const paths = [
    vehId ? `/vehicles/${vehId}/trips/${tripId}` : null,
    `/vehicle-trips/${tripId}`,
    `/vehicleTrips/${tripId}`,
    `/trips/${tripId}`,
  ].filter(Boolean);

  let lastErr;
  for (const u of paths) {
    try {
      await api.delete(u);
      return true;
    } catch (e) {
      const code = e?.response?.status;
      if ([404, 405, 400, 501].includes(code)) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error("Trip delete endpoint not found.");
}

/* ----------------------------- uploads ------------------------- */
// Option A: pre-upload a photo, then pass its URL into startTrip/endTrip
export async function uploadTripPhoto(file) {
  const fd = new FormData();
  fd.append("file", file);
  const { data } = await api.post(`/vehicle-trips/upload`, fd, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data; // { url, filename, mime, size }
}

// Option B: attach directly to an existing trip
export async function uploadStartPhoto(tripId, file) {
  const fd = new FormData();
  fd.append("file", file);
  const { data } = await api.post(`/vehicle-trips/${tripId}/upload-start`, fd, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
}
export async function uploadEndPhoto(tripId, file) {
  const fd = new FormData();
  fd.append("file", file);
  const { data } = await api.post(`/vehicle-trips/${tripId}/upload-end`, fd, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
}
