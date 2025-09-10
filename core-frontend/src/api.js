// src/api.js
// If VITE_API_BASE is set, it's prefixed; otherwise rely on Vite proxy (/api -> :5000)
const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

export async function uploadOrgLogo(file) {
  if (!file) throw new Error("No file provided");
  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch("/api/org/logo", {
    method: "POST",
    headers: {
      // keep token behavior consistent with the rest of your file
      Authorization: `Bearer ${localStorage.getItem("token") || ""}`,
    },
    body: fd,
  });

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error || ""; } catch {}
    throw new Error(detail || `Upload failed (${res.status})`);
  }

  // backend returns the updated org or at least { logoUrl }
  return await res.json();
}

// ---------- core fetch helper (always sends token if present) ----------
function authHeader(token) {
  const t = token ?? localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(!isForm ? { 'Content-Type': 'application/json' } : {}),
      ...authHeader(token),
      ...headers,
    },
    body: isForm ? body : (body ? JSON.stringify(body) : undefined),
  });

  const ct = res.headers.get('content-type') || '';
  const parse = ct.includes('application/json') ? () => res.json() : () => res.text();

  if (!res.ok) {
    const msg = await parse().catch(() => `${res.status} ${res.statusText}`);
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return parse();
}

// ---------- auth ----------
export const loginEnvAdmin = (username, password) =>
  request('/api/auth/login', { method: 'POST', body: { username, password } });

export const loginUser = (email, password) =>
  request('/api/auth/login-user', { method: 'POST', body: { email, password } });

// Persist / clear auth (used by your login page & navbar)
export function saveAuth({ token, role, username, email, name }) {
  if (token) localStorage.setItem('token', token);
  if (role)  localStorage.setItem('role', role);
  if (username || email) localStorage.setItem('username', username || email);
  if (name)  localStorage.setItem('name', name);
}
export function clearAuth() {
  localStorage.removeItem('token');
  localStorage.removeItem('role');
  localStorage.removeItem('username');
  localStorage.removeItem('name');
}

// Combined helper (try DB user first, fall back to env-admin)
export async function loginCombined(identifier, password) {
  // try email/password against DB users
  try {
    const res = await loginUser(identifier, password);
    saveAuth({ token: res.token, role: res.role || 'user', username: res.email || identifier, name: res.name });
    return { source: 'db', ...res };
  } catch {}
  // fallback: env-admin (treat identifier as username)
  const res = await loginEnvAdmin(identifier, password);
  saveAuth({ token: res.token, role: res.role || 'admin', username: identifier });
  return { source: 'env', ...res };
}

// ---------- reads (open) ----------
export const getUsers        = () => request('/api/users');
export const getProjects     = () => request('/api/projects');
export const getClockings    = () => request('/api/clockings');
export const getAssets       = () => request('/api/assets');
export const getVehicles     = () => request('/api/vehicles');
export const getInvoices     = () => request('/api/invoices');
export const getInspections  = () => request('/api/inspections');

// ---------- org (read + update; protected on PUT) ----------
export const getOrg    = () => request('/api/org');
export const updateOrg = (data) => request('/api/org', { method: 'PUT', body: data });

// ---------- users (admin/superadmin) ----------
export const createUser    = (u)      => request('/api/users',       { method: 'POST', body: u });
export const updateUserApi = (id, u)  => request(`/api/users/${id}`, { method: 'PUT',  body: u });
export const deleteUserApi = (id)     => request(`/api/users/${id}`, { method: 'DELETE' });

// ---------- projects (examples of protected mutations) ----------
export const createProject = (data, token)   => request('/api/projects',       { method: 'POST', body: data, token });
export const updateProject = (id, data, tok) => request(`/api/projects/${id}`, { method: 'PUT',  body: data, token: tok });
export const deleteProject = (id, token)     => request(`/api/projects/${id}`, { method: 'DELETE', token });

// ---------- uploads ----------
export const uploadFile = (file) => {
  const fd = new FormData();
  fd.append('file', file);
  return request('/api/uploads', { method: 'POST', body: fd });
};

// ---------- billing (Phase 2) ----------
export const getBillingUsage   = (month) => request(`/api/billing/usage${month ? `?month=${month}` : ''}`);
export const getBillingPreview = (month) => request(`/api/billing/preview${month ? `?month=${month}` : ''}`);

// ---------- users bulk upload ----------
export const uploadUsersBulk = (file) => {
  const fd = new FormData();
  fd.append('file', file);
  return request('/api/users/bulk-upload', { method: 'POST', body: fd });
};

// ---------- inspections ----------
export const uploadInspectionFile = (inspectionId, file) => {
  const fd = new FormData();
  fd.append('file', file);
  return request(`/api/uploads/inspection/${inspectionId}`, { method: 'POST', body: fd });
};

export const createInspection = (data) =>
  request('/api/inspections', { method: 'POST', body: data });

export const updateInspection = (id, data) =>
  request(`/api/inspections/${id}`, { method: 'PUT', body: data });

export const deleteInspection = (id) =>
  request(`/api/inspections/${id}`, { method: 'DELETE' });

export const deleteInspectionFile = (inspectionId, filename) =>
  request(`/api/uploads/inspection/${inspectionId}/${encodeURIComponent(filename)}`, { method: 'DELETE' });

// ---------- document vault ----------
export const listDocuments   = (q='') => request(`/api/documents${q}`);
export const createDocument  = (data) => request('/api/documents', { method:'POST', body:data });
export const updateDocument  = (id,d) => request(`/api/documents/${id}`, { method:'PUT', body:d });
export const deleteDocument  = (id)   => request(`/api/documents/${id}`, { method:'DELETE' });
export const uploadDocVersion = (id, file) => {
  const fd = new FormData(); fd.append('file', file);
  return request(`/api/documents/${id}/upload`, { method:'POST', body: fd });
};
