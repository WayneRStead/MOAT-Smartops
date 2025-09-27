// src/lib/inspectionsApi.js
import { api } from "./api";

/* ---------------- Normalizer ---------------- */
function normalizeTemplate(t) {
  if (!t) return t;
  const id = String(t._id || t.id || "");
  const title = t.title ?? t.name ?? "Untitled form";
  const version = t.version ?? t.revision ?? t.v ?? null;
  const updatedAt = t.updatedAt || t.modifiedAt || t.modified_on || t.lastUpdatedAt || null;
  const fields =
    Array.isArray(t.schema) ? t.schema
    : Array.isArray(t.fields) ? t.fields
    : Array.isArray(t.definition) ? t.definition
    : Array.isArray(t.form) ? t.form
    : [];
  return { ...t, _id: id, id, title, version, updatedAt, fields };
}

function toCreatePayload(v) {
  // accept { title, name, fields/schema/definition, version }
  const title = (v.title ?? v.name ?? "").trim();
  const fields =
    Array.isArray(v.fields) ? v.fields
    : Array.isArray(v.schema) ? v.schema
    : Array.isArray(v.definition) ? v.definition
    : Array.isArray(v.form) ? v.form
    : [];
  const version = v.version ?? v.revision ?? 1;
  return { title, fields, version };
}

function toUpdatePayload(v) {
  const out = {};
  if ("title" in v || "name" in v) out.title = (v.title ?? v.name ?? "").trim();
  if ("version" in v || "revision" in v) out.version = v.version ?? v.revision;
  if ("fields" in v || "schema" in v || "definition" in v || "form" in v) {
    out.fields =
      Array.isArray(v.fields) ? v.fields
      : Array.isArray(v.schema) ? v.schema
      : Array.isArray(v.definition) ? v.definition
      : Array.isArray(v.form) ? v.form
      : [];
  }
  return out;
}

/* ---------------- Core fallbacks ---------------- */
// GET one
export async function getInspectionTemplate(id) {
  const idStr = String(id);
  const attempts = [
    () => api.get(`/inspection-forms/${idStr}`),
    () => api.get(`/inspections/forms/${idStr}`),
    () => api.get(`/inspection-templates/${idStr}`),   // legacy (will alias if you added the interceptor)
    () => api.get(`/inspections/templates/${idStr}`),  // legacy (will alias if you added the interceptor)
  ];
  let lastErr;
  for (const tryFn of attempts) {
    try { const r = await tryFn(); return normalizeTemplate(r.data); }
    catch (e) { if (e?.response?.status !== 404) throw e; lastErr = e; }
  }
  throw lastErr || new Error("Template not found");
}

// LIST
export async function listInspectionTemplates(params = {}) {
  const qp = { limit: 500, _ts: Date.now(), ...params };
  const attempts = [
    () => api.get("/inspection-forms", { params: qp }),
    () => api.get("/inspections/forms", { params: qp }),
    () => api.get("/inspection-templates", { params: qp }),
    () => api.get("/inspections/templates", { params: qp }),
  ];
  let lastErr;
  for (const tryFn of attempts) {
    try {
      const r = await tryFn();
      const raw =
        Array.isArray(r.data?.items) ? r.data.items :
        Array.isArray(r.data?.forms) ? r.data.forms :
        Array.isArray(r.data?.templates) ? r.data.templates :
        Array.isArray(r.data) ? r.data : [];
      return raw.map(normalizeTemplate);
    } catch (e) {
      if (e?.response?.status !== 404) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error("No forms endpoint available");
}

// CREATE
export async function createInspectionTemplate(value) {
  const body = toCreatePayload(value);
  const attempts = [
    () => api.post("/inspection-forms", body),
    () => api.post("/inspections/forms", body),
    () => api.post("/inspection-templates", body),  // legacy (aliased if shim is installed)
    () => api.post("/inspections/templates", body), // legacy (aliased if shim is installed)
  ];
  let lastErr;
  for (const tryFn of attempts) {
    try { const r = await tryFn(); return normalizeTemplate(r.data); }
    catch (e) { if (e?.response?.status !== 404) throw e; lastErr = e; }
  }
  throw lastErr || new Error("Create endpoint not available");
}

// UPDATE
export async function updateInspectionTemplate(id, value) {
  const idStr = String(id);
  const body = toUpdatePayload(value);
  // prefer PATCH, fallback to PUT
  const attempts = [
    () => api.patch(`/inspection-forms/${idStr}`, body),
    () => api.put(`/inspection-forms/${idStr}`, body),
    () => api.patch(`/inspections/forms/${idStr}`, body),
    () => api.put(`/inspections/forms/${idStr}`, body),
    () => api.patch(`/inspection-templates/${idStr}`, body),
    () => api.put(`/inspection-templates/${idStr}`, body),
    () => api.patch(`/inspections/templates/${idStr}`, body),
    () => api.put(`/inspections/templates/${idStr}`, body),
  ];
  let lastErr;
  for (const tryFn of attempts) {
    try { const r = await tryFn(); return normalizeTemplate(r.data); }
    catch (e) {
      const st = e?.response?.status;
      if (st && st !== 404 && st !== 405) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error("Update endpoint not available");
}

// DELETE
export async function deleteInspectionTemplate(id) {
  const idStr = String(id);
  const attempts = [
    () => api.delete(`/inspection-forms/${idStr}`),
    () => api.delete(`/inspections/forms/${idStr}`),
    () => api.delete(`/inspection-templates/${idStr}`),
    () => api.delete(`/inspections/templates/${idStr}`),
  ];
  let lastErr;
  for (const tryFn of attempts) {
    try { await tryFn(); return; }
    catch (e) {
      if (e?.response?.status !== 404) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error("Delete endpoint not available");
}
