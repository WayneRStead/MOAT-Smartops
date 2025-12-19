// core-frontend/src/lib/inspectionApi.js
import { api } from "./api";

/**
 * Prefer `/inspections/*`, but transparently retry `/inspection/*`
 * if the server only mounted the singular path.
 */
const PREFERRED_BASE = "/inspections";
const FALLBACK_BASE  = "/inspection";

async function requestWithFallback(method, path, bodyOrConfig, maybeConfig) {
  try {
    if (method === "get" || method === "delete") {
      const { data } = await api[method](PREFERRED_BASE + path, bodyOrConfig);
      return data;
    } else {
      const { data } = await api[method](PREFERRED_BASE + path, bodyOrConfig, maybeConfig);
      return data;
    }
  } catch (err) {
    const status = err?.response?.status;
    if (status === 404 || status === 405) {
      // Retry with the singular base
      if (method === "get" || method === "delete") {
        const { data } = await api[method](FALLBACK_BASE + path, bodyOrConfig);
        return data;
      } else {
        const { data } = await api[method](FALLBACK_BASE + path, bodyOrConfig, maybeConfig);
        return data;
      }
    }
    throw err;
  }
}

// Normalize params so callers can pass either a boolean or an object
function normalizeParams(params, flagKey) {
  if (typeof params === "boolean") return { [flagKey]: params };
  return params && typeof params === "object" ? params : {};
}

/* -------------------- FORMS -------------------- */
export async function listForms(params = {}) {
  const p = normalizeParams(params, "includeDeleted");
  return requestWithFallback("get", "/forms", { params: p });
}
export const getForms = listForms; // alias

export async function getForm(id) {
  return requestWithFallback("get", `/forms/${id}`);
}

export async function createForm(body) {
  return requestWithFallback("post", "/forms", body);
}

export async function updateForm(id, body) {
  return requestWithFallback("put", `/forms/${id}`, body);
}

export async function softDeleteForm(id) {
  return requestWithFallback("delete", `/forms/${id}`);
}
export async function hardDeleteForm(id) {
  return requestWithFallback("delete", `/forms/${id}/hard`);
}

export async function restoreForm(id) {
  return requestWithFallback("post", `/forms/${id}/restore`, {});
}

/* ---- COMPAT (don’t break older imports) ---- */
export const deleteForm = softDeleteForm;
export const deleteFormHard = hardDeleteForm;

/* ---------------- RUN / SUBMISSIONS ---------------- */
export async function runForm(formId, payload) {
  return requestWithFallback(
    "post",
    `/forms/${formId}/run`,
    payload,
    {
      headers: { "Content-Type": "application/json" },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );
}

export async function listSubmissions(params = {}) {
  // supports includeDeleted, subject filters, etc.
  return requestWithFallback("get", "/submissions", { params });
}

export async function getSubmission(id, params = {}) {
  const p = normalizeParams(params, "includeDeleted");
  return requestWithFallback("get", `/submissions/${id}`, { params: p });
}

export async function addSubmissionComment(submissionId, comment) {
  return requestWithFallback("post", `/submissions/${submissionId}/comments`, { comment });
}

// Submission deletion helpers
export async function softDeleteSubmission(id) {
  return requestWithFallback("delete", `/submissions/${id}`);
}
export async function hardDeleteSubmission(id) {
  return requestWithFallback("delete", `/submissions/${id}/hard`);
}
export async function restoreSubmission(id) {
  return requestWithFallback("post", `/submissions/${id}/restore`);
}

/* -------------------- default export -------------------- */
const inspectionApi = {
  // forms
  listForms,
  getForms,
  getForm,
  createForm,
  updateForm,
  softDeleteForm,
  hardDeleteForm,
  restoreForm,
  deleteForm,       // compat
  deleteFormHard,   // compat
  // run / submissions
  runForm,
  listSubmissions,
  getSubmission,
  addSubmissionComment,
  softDeleteSubmission,
  hardDeleteSubmission,
  restoreSubmission,
};
export default inspectionApi;
