// src/lib/api.js
import axios from "axios";

/**
 * Axios client with:
 * - Longer timeout + light retry on transient failures (GET/DELETE only)
 * - Auth + tenant header & optional ?orgId/body param
 * - Inspections aliasing:
 *     /templates, /inspection-templates  → /inspection-forms
 *     /inspections/templates            → /inspections/forms
 *     /inspection-forms                 → /inspections/forms
 *   (works even if the URL starts with /api or is absolute)
 * - Local mock fallback for:
 *     /inspections/forms        (templates)
 *     /inspections/submissions  (completed inspections)
 */

const BASE =
  import.meta.env.VITE_API_BASE ||
  (typeof window !== "undefined" ? window.location.origin : "https://moat-smartops.onrender.com");
const TENANT_HEADER = import.meta.env.VITE_TENANT_HEADER || "X-Org-Id";
const TENANT_PARAM  = import.meta.env.VITE_TENANT_PARAM  || "orgId";
const SEND_TENANT_PARAM = (import.meta.env.VITE_SEND_TENANT_PARAM || "0") === "1";

console.log("[VITE_API_BASE]", import.meta.env.VITE_API_BASE);
console.log("[VITE_TENANT_HEADER]", import.meta.env.VITE_TENANT_HEADER);
console.log("[VITE_TENANT_PARAM]", import.meta.env.VITE_TENANT_PARAM);
console.log("[VITE_SEND_TENANT_PARAM]", import.meta.env.VITE_SEND_TENANT_PARAM);

// ⬆️ default timeout 30s (was 20s)
export const api = axios.create({ baseURL: BASE, timeout: 30000 });

/* ---------------- small utils ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isIdempotent = (m) => ["get", "delete", "head", "options"].includes(String(m || "get").toLowerCase());
const isMultipart = (cfg) => {
  const h = cfg?.headers || {};
  const ct = Object.entries(h).find(([k]) => k.toLowerCase() === "content-type")?.[1] || "";
  return /multipart\/form-data/i.test(ct);
};

function getToken() {
  try { return localStorage.getItem("token") || sessionStorage.getItem("token") || ""; }
  catch { return ""; }
}
function safeParseJwt(t) {
  try { const p = t.split("."); if (p.length < 2) return null; return JSON.parse(atob(p[1])); }
  catch { return null; }
}
function getTenantId() {
  try {
    // ✅ Added support for currentOrgId (your auth flow stores this)
    const stored =
      localStorage.getItem("currentOrgId") || sessionStorage.getItem("currentOrgId") ||
      localStorage.getItem("orgId")        || sessionStorage.getItem("orgId")        ||
      localStorage.getItem("tenantId")     || sessionStorage.getItem("tenantId");
    if (stored) return stored;
    const payload = safeParseJwt(getToken());
    return payload?.orgId || payload?.tenantId || payload?.org || payload?.tenant || null;
  } catch { return null; }
}

/* ---------------- aliasing for templates ---------------- */
const INSPECTION_ALIAS_RULES = [
  { rx: /^\/templates(\/.*)?$/i,              to: (m) => `/inspection-forms${m[1] || ""}` },
  { rx: /^\/inspection-templates(\/.*)?$/i,   to: (m) => `/inspection-forms${m[1] || ""}` },
  { rx: /^\/inspections\/templates(\/.*)?$/i, to: (m) => `/inspections/forms${m[1] || ""}` },
  { rx: /^\/inspection-forms(\/.*)?$/i,       to: (m) => `/inspections/forms${m[1] || ""}` },
];

function splitUrl(u, base) {
  try {
    if (!u) return { path: "/", qs: "" };
    const url = new URL(u, base || BASE);
    return { path: url.pathname, qs: url.search };
  } catch {
    const s = String(u || "");
    const qIdx = s.indexOf("?");
    let path = qIdx >= 0 ? s.slice(0, qIdx) : s;
    const qs = qIdx >= 0 ? s.slice(qIdx) : "";
    path = path.replace(/^[a-z]+:\/\/[^/]+/i, "");
    return { path: path || "/", qs };
  }
}
function applyAlias(path) {
  for (const r of INSPECTION_ALIAS_RULES) {
    const m = path.match(r.rx);
    if (m) return r.to(m);
  }
  return path;
}
function aliasUrl(u) {
  try {
    const { path, qs } = splitUrl(u, BASE);
    const plain = path.replace(/^\/api(\/|$)/i, "/");
    const aliased = applyAlias(plain);
    return aliased === plain ? u : (aliased + qs);
  } catch {
    return u;
  }
}

/* ---------------- local mocks: templates + submissions ---------------- */
const LS_FORMS = "mock:inspections:forms";
const LS_SUBMS = "mock:inspections:subms";

const isFormsPath = (p) => /\/(inspections\/forms|inspection-forms)(\/?|\/.+)$/i.test(p || "");
const isSubsPath  = (p) => /\/inspections\/submissions(\/?|\/.+)$/i.test(p || "");

function lsLoad(key, fallback = []) { try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; } }
function lsSave(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }
function newId() { return (crypto?.randomUUID?.() || `id_${Math.random().toString(36).slice(2)}_${Date.now()}`); }

function resOK(config, data, status = 200) { return { data, status, statusText: "OK", headers: {}, config, request: {} }; }
function resErr(config, status = 404, data = { error: "Not found" }) {
  const err = new Error(data?.error || String(status));
  err.response = { data, status, statusText: "Error", headers: {}, config, request: {} };
  err.config = config;
  throw err;
}
function actorFromToken() {
  const p = safeParseJwt(getToken()) || {};
  return { userId: p._id || p.sub || null, email: p.email || null };
}

async function inspectionsMockAdapter(config) {
  const u = config.url || "";
  const { path } = splitUrl(u, BASE);
  const method = (config.method || "get").toLowerCase();

  let body = {};
  try {
    const raw = config.data;
    body =
      raw instanceof FormData ? {} :
      typeof raw === "string" && raw ? JSON.parse(raw) :
      (raw && typeof raw === "object" ? raw : {});
  } catch { body = {}; }

  const nowISO = () => new Date().toISOString();

  /* --------- TEMPLATES (forms) --------- */
  if (isFormsPath(path)) {
    const m = path.match(/^\/(?:.+\/)?(?:inspections\/forms|inspection-forms)(?:\/([^/?#]+))?/i);
    const id = m && m[1] ? decodeURIComponent(m[1]) : null;
    let items = lsLoad(LS_FORMS, []);

    if (method === "get" && !id) {
      const limit = Number(config.params?.limit) || 1000;
      const { projectId, taskId, role } = config.params || {};
      let out = items.slice();
      if (projectId || taskId || role) {
        out = out.filter(f => {
          const s = f.scope || {};
          if (s.isGlobal) return true;
          const prj = !projectId || (Array.isArray(s.projectIds) && s.projectIds.map(String).includes(String(projectId)));
          const tsk = !taskId   || (Array.isArray(s.taskIds)    && s.taskIds.map(String).includes(String(taskId)));
          const rol = !role     || (Array.isArray(s.roles)      && s.roles.includes(role));
          return prj && tsk && rol;
        });
      }
      out.sort((a,b)=> new Date(b.updatedAt||0) - new Date(a.updatedAt||0));
      return resOK(config, out.slice(0, limit), 200);
    }
    if (method === "get" && id) {
      const f = items.find(x => String(x._id||x.id) === String(id));
      if (!f) return resErr(config, 404, { error: "Form not found" });
      return resOK(config, f, 200);
    }
    if (method === "post" && !id) {
      const now = nowISO();
      const title = (body.title || body.name || "").trim() || "Untitled form";
      const created = {
        _id: newId(),
        title,
        name: title,
        version: body.version ?? 1,
        fields: Array.isArray(body.fields) ? body.fields : [],
        status: body.status || "draft",
        scope: body.scope || { isGlobal: true, projectIds: [], taskIds: [], roles: [] },
        createdAt: now, updatedAt: now,
        ...body,
      };
      created.title = created.title || created.name || "Untitled form";
      created.name  = created.name  || created.title;
      items.push(created); lsSave(LS_FORMS, items);
      return resOK(config, created, 201);
    }
    if ((method === "put" || method === "patch") && id) {
      const idx = items.findIndex(x => String(x._id||x.id) === String(id));
      if (idx < 0) return resErr(config, 404, { error: "Form not found" });
      const merged = {
        ...items[idx],
        ...body,
        title: (body.title || body.name || items[idx].title || items[idx].name || "Untitled form").trim(),
        name:  (body.name  || body.title || items[idx].name  || items[idx].title || "Untitled form").trim(),
        updatedAt: nowISO(),
      };
      merged.scope = merged.scope || { isGlobal: true, projectIds: [], taskIds: [], roles: [] };
      items[idx] = merged; lsSave(LS_FORMS, items);
      return resOK(config, merged, 200);
    }
    if (method === "delete" && id) {
      const before = items.length;
      items = items.filter(x => String(x._id||x.id) !== String(id));
      if (items.length === before) return resErr(config, 404, { error: "Form not found" });
      lsSave(LS_FORMS, items);
      return resOK(config, { ok: true }, 200);
    }
    return resErr(config, 400, { error: "Unsupported forms op" });
  }

  /* --------- SUBMISSIONS --------- */
  if (isSubsPath(path)) {
    const m = path.match(/^\/(?:.+\/)?inspections\/submissions(?:\/([^/?#]+))?/i);
    const id = m && m[1] ? decodeURIComponent(m[1]) : null;
    let items = lsLoad(LS_SUBMS, []);

    if (method === "get" && !id) {
      const { templateId, projectId, taskId, limit } = config.params || {};
      let out = items.slice();
      if (templateId) out = out.filter(s => String(s.templateId) === String(templateId));
      if (projectId)  out = out.filter(s => String(s.projectId || "") === String(projectId));
      if (taskId)     out = out.filter(s => String(s.taskId || "") === String(taskId));
      out.sort((a,b)=> new Date(b.submittedAt||0) - new Date(a.submittedAt||0));
      return resOK(config, out.slice(0, Number(limit)||500), 200);
    }
    if (method === "get" && id) {
      const s = items.find(x => String(x._id||x.id) === String(id));
      if (!s) return resErr(config, 404, { error: "Submission not found" });
      return resOK(config, s, 200);
    }
    if (method === "post" && !id) {
      const now = nowISO();
      const actor = actorFromToken();
      const created = { _id: newId(), status: "submitted", ...body, submittedAt: now, actor };
      items.push(created); lsSave(LS_SUBMS, items);
      return resOK(config, created, 201);
    }
    if ((method === "put" || method === "patch") && id) {
      const idx = items.findIndex(x => String(x._id||x.id) === String(id));
      if (idx < 0) return resErr(config, 404, { error: "Submission not found" });
      const prev = items[idx];
      const merged = {
        ...prev,
        ...body,
        managerNote: (body.managerNote != null) ? body.managerNote : prev.managerNote,
        status: body.status || prev.status,
        signoff: { ...(prev.signoff || {}), ...(body.signoff || {}) },
        updatedAt: nowISO(),
      };
      items[idx] = merged; lsSave(LS_SUBMS, items);
      return resOK(config, merged, 200);
    }
    if (method === "delete" && id) {
      const before = items.length;
      items = items.filter(x => String(x._id||x.id) !== String(id));
      if (items.length === before) return resErr(config, 404, { error: "Submission not found" });
      lsSave(LS_SUBMS, items);
      return resOK(config, { ok: true }, 200);
    }
    return resErr(config, 400, { error: "Unsupported submissions op" });
  }

  return resErr(config, 404, { error: "Unknown path" });
}

function shouldMockAfterError(respOrStatus, url) {
  const status = typeof respOrStatus === "number" ? respOrStatus : respOrStatus?.status;
  if (!(status === 404 || status === 500)) return false;
  const { path } = splitUrl(url || "", BASE);
  return isFormsPath(path) || isSubsPath(path);
}

/* ---------------- interceptors ---------------- */
api.interceptors.request.use((config) => {
  try {
    // strip cache-control to avoid CORS preflights
    if (config.headers) {
      for (const k of Object.keys(config.headers)) {
        if (k.toLowerCase() === "cache-control") delete config.headers[k];
      }
    }
    // default Accept
    config.headers = config.headers || {};
    if (!config.headers.Accept) config.headers.Accept = "application/json";

    // Auth
    const t = getToken();
    if (t && !config.headers.Authorization) config.headers.Authorization = `Bearer ${t}`;

    // Tenant
    const tenantId = getTenantId();
    if (tenantId) {
      // existing configurable header
      if (!config.headers[TENANT_HEADER]) config.headers[TENANT_HEADER] = tenantId;
      // ✅ also set lowercase variant expected server-side after Node lowercases headers
      if (!config.headers["x-org-id"]) config.headers["x-org-id"] = tenantId;

      if (SEND_TENANT_PARAM) {
        const method = (config.method || "get").toLowerCase();
        if (method === "get" || method === "delete") {
          config.params = config.params || {};
          if (!(TENANT_PARAM in config.params)) config.params[TENANT_PARAM] = tenantId;
        } else if (method === "post" || method === "put" || method === "patch") {
          if (config.data instanceof FormData) {
            if (!config.data.has(TENANT_PARAM)) config.data.append(TENANT_PARAM, tenantId);
          } else if (config.data && typeof config.data === "object") {
            if (!(TENANT_PARAM in config.data)) config.data = { [TENANT_PARAM]: tenantId, ...config.data };
          } else {
            config.data = { [TENANT_PARAM]: tenantId };
          }
        }
      }
    }

    // Aliases
    if (config.url) config.url = aliasUrl(config.url);
  } catch {}
  return config;
});

/* ---- RETRY then MOCK fallback ---- */
api.interceptors.response.use(
  (r) => r,
  async (error) => {
    const cfg = error?.config || {};
    const method = (cfg.method || "get").toLowerCase();

    // 1) Light retry for timeouts / transient network errors (idempotent only)
    const transient =
      error.code === "ECONNABORTED" ||
      error.message?.toLowerCase?.().includes("timeout") ||
      (!error.response && (error.code === "ERR_NETWORK" || error.message?.toLowerCase?.().includes("network")));

    const maxRetries = Number.isFinite(cfg._maxRetries) ? Number(cfg._maxRetries) : 2;
    const count = Number(cfg._retryCount || 0);

    const safeToRetry =
      !cfg._noRetry &&
      transient &&
      isIdempotent(method) &&
      !isMultipart(cfg) &&
      count < maxRetries;

    if (safeToRetry) {
      cfg._retryCount = count + 1;
      // exponential backoff with jitter: 300ms, 600–900ms
      const base = 300 * Math.pow(2, count);
      const jitter = Math.random() * 300;
      await sleep(base + jitter);
      return api.request(cfg);
    }

    // 2) If no retry (or retries exhausted), apply inspections mock fallback for 404/500 or no-response
    try {
      const { response, config } = error || {};
      if (!config) throw error;

      if (!config._mockRetried && shouldMockAfterError(response?.status, config.url)) {
        const retryCfg = { ...config, _mockRetried: true, adapter: inspectionsMockAdapter };
        return api.request(retryCfg);
      }
      const pathOnly = splitUrl(config.url, BASE).path;
      if (!response && (isFormsPath(pathOnly) || isSubsPath(pathOnly)) && !config._mockRetried) {
        const retryCfg = { ...config, _mockRetried: true, adapter: inspectionsMockAdapter };
        return api.request(retryCfg);
      }
    } catch { /* ignore and fall through */ }

    // 3) Surface the original error
    return Promise.reject(error);
  }
);

/* ---------------- convenience APIs ---------------- */

// ORG
export async function getOrg() { const { data } = await api.get("/org"); return data; }
export async function updateOrg(payload) { const { data } = await api.put("/org", payload); return data; }
export async function uploadOrgLogo(file) {
  const fd = new FormData(); fd.append("logo", file);
  const { data } = await api.post(`/org/logo`, fd, { headers: { "Content-Type": "multipart/form-data" }, _noRetry: true });
  return data;
}

// TASKS
export async function taskAction(id, body) { const { data } = await api.post(`/tasks/${id}/action`, body, { _noRetry: true }); return data; }
export async function uploadTaskPhotos(id, files, meta = {}) {
  const fd = new FormData();
  [...files].forEach((f) => fd.append("photos", f));
  if (meta.lat != null) fd.append("lat", String(meta.lat));
  if (meta.lng != null) fd.append("lng", String(meta.lng));
  const { data } = await api.post(`/tasks/${id}/photos`, fd, {
    headers: { "Content-Type": "multipart/form-data" },
    _noRetry: true,
    timeout: 60000, // uploads can take longer
  });
  return data;
}

// Projects
function projectIdFromTask(t) {
  const v = t?.projectId ?? t?.project_id ?? t?.projectID ?? t?.projectRef ?? t?.project ??
            (t?.project && (t.project._id || t.project.id)) ?? (t?.project && t.project.$oid) ??
            (t?.projectId && t.projectId.$oid) ?? null;
  if (!v) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (typeof v === "object") return v.$oid ? String(v.$oid) : String(v);
  return String(v);
}
function taskMatchesProject(t, pid) {
  const want = String(pid);
  const got = projectIdFromTask(t);
  return got && String(got) === want;
}
export async function listProjectTasks(projectId, params = {}) {
  const p = { ...params, limit: params.limit ?? 1000, _maxRetries: 2 };
  const accept = (data) => {
    if (Array.isArray(data) && data.length > 0) return data;
    if (Array.isArray(data?.items) && data.items.length > 0) return data.items;
    if (Array.isArray(data?.tasks) && data.tasks.length > 0) return data.tasks;
    return null;
  };
  try { const { data } = await api.get(`/projects/${projectId}/tasks`, { params: p }); const ok = accept(data); if (ok) return ok; } catch {}
  for (const key of ["projectId", "project", "project_id"]) {
    try { const { data } = await api.get(`/tasks`, { params: { ...p, [key]: projectId } }); const ok = accept(data); if (ok) return ok.filter((t) => taskMatchesProject(t, projectId)); } catch {}
  }
  try { const { data } = await api.get(`/tasks`, { params: p }); if (Array.isArray(data)) return data.filter((t) => taskMatchesProject(t, projectId)); } catch {}
  return [];
}
export async function listProjects(params = {}) {
  const { q, status, tag, limit } = params;
  const { data } = await api.get("/projects", { params: { q, status, tag, limit }, _maxRetries: 2 });
  return Array.isArray(data) ? data : [];
}
export async function getProject(id) { const { data } = await api.get(`/projects/${id}`, { _maxRetries: 2 }); return data; }
export async function createProject(payload) { const { data } = await api.post("/projects", payload, { _noRetry: true }); return data; }
export async function updateProject(id, payload) { const { data } = await api.put(`/projects/${id}`, payload, { _noRetry: true }); return data; }
export async function deleteProject(id) { await api.delete(`/projects/${id}`, { _maxRetries: 2 }); return true; }
export async function getProjectGeofences(id) {
  const { data } = await api.get(`/projects/${id}/geofences`, { _maxRetries: 2 });
  if (Array.isArray(data?.geoFences)) return data.geoFences;
  if (Array.isArray(data?.fences))    return data.fences;
  return Array.isArray(data) ? data : [];
}
export async function setProjectGeofences(id, geoFences) { const { data } = await api.put(`/projects/${id}/geofences`, { geoFences }, { _noRetry: true }); return data; }
export async function appendProjectGeofences(id, geoFences) { const { data } = await api.patch(`/projects/${id}/geofences`, { geoFences }, { _noRetry: true }); return data; }
export async function clearProjectGeofences(id) { const { data } = await api.delete(`/projects/${id}/geofences`, { _noRetry: true }); return data; }
export async function uploadProjectGeofences(id, file) {
  const fd = new FormData(); fd.append("file", file);
  const { data } = await api.post(`/projects/${id}/geofences/upload`, fd, {
    headers: { "Content-Type": "multipart/form-data" },
    _noRetry: true,
    timeout: 60000,
  });
  return data;
}

// --- Milestones helper (robust; optional projectId for nested routes) ---
export async function listTaskMilestones(taskId, projectId) {
  const normalize = (arr) =>
    (Array.isArray(arr) ? arr : []).map((m, i) => ({
      id: String(m.id || m._id || m.key || i),
      name: m.name || m.title || m.label || `Milestone ${i + 1}`,
    }));

  if (projectId) {
    try {
      const { data } = await api.get(`/projects/${projectId}/tasks/${taskId}/milestones`, { _maxRetries: 2 });
      if (Array.isArray(data?.items)) return normalize(data.items);
      if (Array.isArray(data?.milestones)) return normalize(data.milestones);
      if (Array.isArray(data)) return normalize(data);
    } catch {}
  }
  const candidates = [
    `/tasks/${taskId}/milestones`,
    `/tasks/${taskId}/checkpoints`,
    `/tasks/${taskId}/stages`,
  ];
  for (const url of candidates) {
    try {
      const { data } = await api.get(url, { _maxRetries: 2 });
      if (Array.isArray(data?.items)) return normalize(data.items);
      if (Array.isArray(data?.milestones)) return normalize(data.milestones);
      if (Array.isArray(data?.checkpoints)) return normalize(data.checkpoints);
      if (Array.isArray(data?.stages)) return normalize(data.stages);
      if (Array.isArray(data)) return normalize(data);
    } catch {}
  }
  try {
    const { data: t } = await api.get(`/tasks/${taskId}`, { _maxRetries: 2 });
    const raw = t?.milestones || t?.checkpoints || t?.stages || t?.phases || t?.steps || [];
    return normalize(raw);
  } catch {
    return [];
  }
}

// quick role checker
export function currentUserHasRole(role) {
  try {
    const tok = localStorage.getItem("token") || "";
    const payload = JSON.parse(atob(tok.split(".")[1] || "")) || {};
    const r = (payload.role || payload.roles || "");
    if (Array.isArray(r)) return r.map(String).includes(String(role));
    return String(r) === String(role);
  } catch { return false; }
}
