// src/lib/api.js
import axios from "axios";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || "http://localhost:5000/api",
});

// attach token if present
api.interceptors.request.use((config) => {
  const t = localStorage.getItem("token");
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

// ---------- ORG HELPERS ----------
export async function getOrg() {
  const { data } = await api.get("/org");
  return data;
}

export async function updateOrg(payload) {
  const { data } = await api.put("/org", payload);
  return data; // should return the updated org object
}

export async function uploadOrgLogo(file) {
  const fd = new FormData();
  // IMPORTANT: backend expects the file under the 'logo' field
  fd.append("logo", file);
  const { data } = await api.post("/org/logo", fd, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data; // expect updated org with .logoUrl
}

// --- tasks helpers (add) ---
export async function taskAction(id, body) {
  const { data } = await api.post(`/tasks/${id}/action`, body);
  return data;
}

// Upload 1..N photos (with optional lat/lng). Field name 'photos'.
export async function uploadTaskPhotos(id, files, meta = {}) {
  const fd = new FormData();
  [...files].forEach((f) => fd.append("photos", f));
  if (meta.lat != null) fd.append("lat", String(meta.lat));
  if (meta.lng != null) fd.append("lng", String(meta.lng));
  const { data } = await api.post(`/tasks/${id}/photos`, fd, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
}

// Query tasks by project quickly
export async function listProjectTasks(projectId, params = {}) {
  const p = { ...params, projectId, limit: params.limit ?? 100 };
  const { data } = await api.get("/tasks", { params: p });
  return Array.isArray(data) ? data : [];
}

// ---------- (export anything else you already had here) ----------
// e.g. documents, projects, etc.
// export async function listDocuments(params) { ... }
