// src/lib/api.js
import axios from "axios";

/**
 * Axios client with:
 * - Auth + tenant header & optional ?orgId/body param
 * - Inspections aliasing:
 *     /templates, /inspection-templates  → /inspection-forms
 *     /inspections/templates            → /inspections/forms
 *     /inspection-forms                 → /inspections/forms
 *   (works even if the URL starts with /api or is absolute)
 * - Local mock fallback for:
 *     /inspections/forms        (templates)
 *     /inspections/submissions  (completed inspections)
 *   when server returns 404/500 or is unreachable.
 */

const BASE = import.meta.env.VITE_API_BASE || "http://localhost:5000/api";
const TENANT_HEADER = import.meta.env.VITE_TENANT_HEADER || "X-Org-Id";
const TENANT_PARAM  = import.meta.env.VITE_TENANT_PARAM  || "orgId";
const SEND_TENANT_PARAM = (import.meta.env.VITE_SEND_TENANT_PARAM || "0") === "1";

export const api = axios.create({ baseURL: BASE, timeout: 20000 });

/* ---------------- safe helpers ---------------- */
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
    const stored =
      localStorage.getItem("orgId") || sessionStorage.getItem("orgId") ||
      localStorage.getItem("tenantId") || sessionStorage.getItem("tenantId");
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

// Robust splitter for absolute or relative URLs
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
    path = path.replace(/^[a-z]+:\/\/[^/]+/i, ""); // strip protocol/host if present
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
    // If the path starts with /api, strip it before applying aliases,
    // then return a relative path so Axios rejoins with baseURL.
    const plain = path.replace(/^\/api(\/|$)/i, "/");
    const aliased = applyAlias(plain);
    return aliased === plain ? u : (aliased + qs);
  } catch {
    return u;
  }
}

/* ---------------- local mocks: templates + submissions ---------------- */
const LS_FORMS = "mock:inspections:forms";
const LS_SUBMS = "mock:inspections:submissions";

// match anywhere in the path (handles /api/ prefix or other prefixes)
const isFormsPath = (p) => /\/(inspections\/forms|inspection-forms)(\/?|\/.+)$/i.test(p || "");
const isSubsPath  = (p) => /\/inspections\/submissions(\/?|\/.+)$/i.test(p || "");

function lsLoad(key, fallback = []) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch { return fallback; }
}
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

  // parse JSON body if axios passed a string
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
    // allow optional prefix like /api/
    const m = path.match(/^\/(?:.+\/)?(?:inspections\/forms|inspection-forms)(?:\/([^/?#]+))?/i);
    const id = m && m[1] ? decodeURIComponent(m[1]) : null;
    let items = lsLoad(LS_FORMS, []);

    // GET list
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

    // GET one
    if (method === "get" && id) {
      const f = items.find(x => String(x._id||x.id) === String(id));
      if (!f) return resErr(config, 404, { error: "Form not found" });
      return resOK(config, f, 200);
    }

    // POST create
    if (method === "post" && !id) {
      const now = nowISO();
      const title = (body.title || body.name || "").trim() || "Untitled form";
      const created = {
        _id: newId(),
        title,
        name: title, // keep both for compatibility
        version: body.version ?? 1,
        fields: Array.isArray(body.fields) ? body.fields : [],
        status: body.status || "draft",
        scope: body.scope || { isGlobal: true, projectIds: [], taskIds: [], roles: [] },
        createdAt: now, updatedAt: now,
        ...body,
      };
      // ensure both title & name in sync
      created.title = created.title || created.name || "Untitled form";
      created.name  = created.name  || created.title;
      items.push(created); lsSave(LS_FORMS, items);
      return resOK(config, created, 201);
    }

    // PUT/PATCH update
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

    // DELETE
    if (method === "delete" && id) {
      const before = items.length;
      items = items.filter(x => String(x._id||x.id) !== String(id));
      if (items.length === before) return resErr(config, 404, { error: "Form not found" });
      lsSave(LS_FORMS, items);
      return resOK(config, { ok: true }, 200);
    }

    return resErr(config, 400, { error: "Unsupported forms op" });
  }

  /* --------- SUBMISSIONS (completed inspections) --------- */
  if (isSubsPath(path)) {
    const m = path.match(/^\/(?:.+\/)?inspections\/submissions(?:\/([^/?#]+))?/i);
    const id = m && m[1] ? decodeURIComponent(m[1]) : null;
    let items = lsLoad(LS_SUBMS, []);

    // GET list (filterable)
    if (method === "get" && !id) {
      const { templateId, projectId, taskId, limit } = config.params || {};
      let out = items.slice();
      if (templateId) out = out.filter(s => String(s.templateId) === String(templateId));
      if (projectId)  out = out.filter(s => String(s.projectId || "") === String(projectId));
      if (taskId)     out = out.filter(s => String(s.taskId || "") === String(taskId));
      out.sort((a,b)=> new Date(b.submittedAt||0) - new Date(a.submittedAt||0));
      return resOK(config, out.slice(0, Number(limit)||500), 200);
    }

    // GET one
    if (method === "get" && id) {
      const s = items.find(x => String(x._id||x.id) === String(id));
      if (!s) return resErr(config, 404, { error: "Submission not found" });
      return resOK(config, s, 200);
    }

    // POST create (new completed inspection)
    if (method === "post" && !id) {
      const now = nowISO();
      const actor = actorFromToken();
      const created = {
        _id: newId(),
        status: "submitted",
        ...body,
        submittedAt: now,
        actor,
      };
      items.push(created); lsSave(LS_SUBMS, items);
      return resOK(config, created, 201);
    }

    // PUT/PATCH update
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

    // DELETE (optional)
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
    // Clean cache-control to avoid CORS preflights
    if (config.headers) {
      for (const k of Object.keys(config.headers)) {
        if (k.toLowerCase() === "cache-control") delete config.headers[k];
      }
    }

    // Auth
    const t = getToken();
    if (t) {
      config.headers = config.headers || {};
      if (!config.headers.Authorization) config.headers.Authorization = `Bearer ${t}`;
    }

    // Tenant
    const tenantId = getTenantId();
    if (tenantId) {
      config.headers = config.headers || {};
      if (!config.headers[TENANT_HEADER]) config.headers[TENANT_HEADER] = tenantId;

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

    // Aliases (allow absolute or /api prefixed)
    if (config.url) config.url = aliasUrl(config.url);
  } catch {}
  return config;
});

api.interceptors.response.use(
  (r) => r,
  async (error) => {
    try {
      const { response, config } = error || {};
      if (!config) throw error;

      // On 404/500 for target paths: retry via local mock
      if (!config._mockRetried && shouldMockAfterError(response?.status, config.url)) {
        const retryCfg = { ...config, _mockRetried: true, adapter: inspectionsMockAdapter };
        return api.request(retryCfg);
      }

      // No response (network), but URL matches our targets → try mock
      const pathOnly = splitUrl(config.url, BASE).path;
      if (!response && (isFormsPath(pathOnly) || isSubsPath(pathOnly)) && !config._mockRetried) {
        const retryCfg = { ...config, _mockRetried: true, adapter: inspectionsMockAdapter };
        return api.request(retryCfg);
      }
    } catch {}
    return Promise.reject(error);
  }
);

/* ---------------- convenience APIs ---------------- */

// ORG
export async function getOrg() { const { data } = await api.get("/org"); return data; }
export async function updateOrg(payload) { const { data } = await api.put("/org", payload); return data; }
export async function uploadOrgLogo(file) {
  const fd = new FormData(); fd.append("logo", file);
  const { data } = await api.post("/org/logo", fd, { headers: { "Content-Type": "multipart/form-data" } });
  return data;
}

// TASKS
export async function taskAction(id, body) { const { data } = await api.post(`/tasks/${id}/action`, body); return data; }
export async function uploadTaskPhotos(id, files, meta = {}) {
  const fd = new FormData();
  [...files].forEach((f) => fd.append("photos", f));
  if (meta.lat != null) fd.append("lat", String(meta.lat));
  if (meta.lng != null) fd.append("lng", String(meta.lng));
  const { data } = await api.post(`/tasks/${id}/photos`, fd, { headers: { "Content-Type": "multipart/form-data" } });
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
  const p = { ...params, limit: params.limit ?? 1000 };
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
  const { data } = await api.get("/projects", { params: { q, status, tag, limit } });
  return Array.isArray(data) ? data : [];
}
export async function getProject(id) { const { data } = await api.get(`/projects/${id}`); return data; }
export async function createProject(payload) { const { data } = await api.post("/projects", payload); return data; }
export async function updateProject(id, payload) { const { data } = await api.put(`/projects/${id}`, payload); return data; }
export async function deleteProject(id) { await api.delete(`/projects/${id}`); return true; }
export async function getProjectGeofences(id) {
  const { data } = await api.get(`/projects/${id}/geofences`);
  if (Array.isArray(data?.geoFences)) return data.geoFences;
  if (Array.isArray(data?.fences))    return data.fences;
  return Array.isArray(data) ? data : [];
}
export async function setProjectGeofences(id, geoFences) { const { data } = await api.put(`/projects/${id}/geofences`, { geoFences }); return data; }
export async function appendProjectGeofences(id, geoFences) { const { data } = await api.patch(`/projects/${id}/geofences`, { geoFences }); return data; }
export async function clearProjectGeofences(id) { const { data } = await api.delete(`/projects/${id}/geofences`); return data; }
export async function uploadProjectGeofences(id, file) {
  const fd = new FormData(); fd.append("file", file);
  const { data } = await api.post(`/projects/${id}/geofences/upload`, fd, { headers: { "Content-Type": "multipart/form-data" } });
  return data;
}

// --- Milestones helper (robust; optional projectId for nested routes) ---
export async function listTaskMilestones(taskId, projectId) {
  const normalize = (arr) =>
    (Array.isArray(arr) ? arr : []).map((m, i) => ({
      id: String(m.id || m._id || m.key || i),
      name: m.name || m.title || m.label || `Milestone ${i + 1}`,
    }));

  // 1) Project-scoped endpoints (optional)
  if (projectId) {
    try {
      const { data } = await api.get(`/projects/${projectId}/tasks/${taskId}/milestones`);
      if (Array.isArray(data?.items)) return normalize(data.items);
      if (Array.isArray(data?.milestones)) return normalize(data.milestones);
      if (Array.isArray(data)) return normalize(data);
    } catch {}
  }

  // 2) Common task-scoped endpoints
  const candidates = [
    `/tasks/${taskId}/milestones`,
    `/tasks/${taskId}/checkpoints`,
    `/tasks/${taskId}/stages`,
  ];
  for (const url of candidates) {
    try {
      const { data } = await api.get(url);
      if (Array.isArray(data?.items)) return normalize(data.items);
      if (Array.isArray(data?.milestones)) return normalize(data.milestones);
      if (Array.isArray(data?.checkpoints)) return normalize(data.checkpoints);
      if (Array.isArray(data?.stages)) return normalize(data.stages);
      if (Array.isArray(data)) return normalize(data);
    } catch {}
  }

  // 3) Fallback: task detail with embedded arrays under various keys
  try {
    const { data: t } = await api.get(`/tasks/${taskId}`);
    const raw =
      t?.milestones ||
      t?.checkpoints ||
      t?.stages ||
      t?.phases ||
      t?.steps ||
      [];
    return normalize(raw);
  } catch {
    return [];
  }
}

// (optional) quick role checker you can reuse in UI
export function currentUserHasRole(role) {
  try {
    const tok = localStorage.getItem("token") || "";
    const payload = JSON.parse(atob(tok.split(".")[1] || "")) || {};
    const r = (payload.role || payload.roles || "");
    if (Array.isArray(r)) return r.map(String).includes(String(role));
    return String(r) === String(role);
  } catch { return false; }
}
