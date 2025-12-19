// src/services/auth.js
import { api } from "../lib/api";

const STORAGE_KEYS = {
  token: "token",
  user: "user",
  orgs: "orgs",
  currentOrgId: "currentOrgId",
};

/* ---------------------- localStorage helpers ---------------------- */
function setItem(key, value) {
  try {
    if (value === undefined || value === null) {
      localStorage.removeItem(key);
    } else if (typeof value === "string") {
      localStorage.setItem(key, value);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // ignore
  }
}

function getItem(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  } catch {
    return null;
  }
}

/* ---------------------------- AUTH CORE ---------------------------- */

// payload: { email?: string, username?: string, password: string }
export async function login(payload) {
  const { data } = await api.post("/auth/login", payload);

  // Expecting: { token, user, orgs, currentOrgId }
  if (data?.token) {
    setItem(STORAGE_KEYS.token, data.token);
  }
  if (data?.user) {
    setItem(STORAGE_KEYS.user, data.user);
  }
  if (data?.orgs) {
    setItem(STORAGE_KEYS.orgs, data.orgs);
  }
  if (data?.currentOrgId !== undefined) {
    setItem(STORAGE_KEYS.currentOrgId, data.currentOrgId);
  }

  return data.user;
}

export function logout() {
  try {
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem(STORAGE_KEYS.user);
    localStorage.removeItem(STORAGE_KEYS.orgs);
    localStorage.removeItem(STORAGE_KEYS.currentOrgId);
  } catch {
    // ignore
  }
  window.location.href = "/login"; // adjust if your route is different
}

export function getUser() {
  return getItem(STORAGE_KEYS.user);
}

export function getToken() {
  const tok = getItem(STORAGE_KEYS.token);
  return typeof tok === "string" ? tok : null;
}

export function getOrgs() {
  const orgs = getItem(STORAGE_KEYS.orgs);
  return Array.isArray(orgs) ? orgs : [];
}

export function getCurrentOrgId() {
  const id = getItem(STORAGE_KEYS.currentOrgId);
  return id || null;
}

/**
 * Call backend /auth/me to refresh user + org info.
 * Keeps signature compatible by returning only data.user.
 */
export async function whoAmI() {
  const { data } = await api.get("/auth/me");
  // data: { user, orgs, currentOrgId }
  if (data?.user) {
    setItem(STORAGE_KEYS.user, data.user);
  }
  if (data?.orgs) {
    setItem(STORAGE_KEYS.orgs, data.orgs);
  }
  if (data?.currentOrgId !== undefined) {
    setItem(STORAGE_KEYS.currentOrgId, data.currentOrgId);
  }
  return data.user;
}

/* ------------------------ ORG SWITCHING ------------------------ */

/**
 * Switch active org and update token.
 * body: { orgId }
 * response: { token, currentOrgId, roles }
 */
export async function switchOrg(orgId) {
  const { data } = await api.post("/auth/switch-org", { orgId });

  if (data?.token) {
    setItem(STORAGE_KEYS.token, data.token);
  }
  if (data?.currentOrgId !== undefined) {
    setItem(STORAGE_KEYS.currentOrgId, data.currentOrgId);
  }

  // You may want to refetch /auth/me after switching if you need fresh user/orgs.
  return data;
}

/* ----------------------- PASSWORD RESET ----------------------- */

/**
 * Request a password reset link.
 * POST /auth/forgot-password
 * body: { email }
 * Note: response is intentionally generic: { ok, message }
 */
export async function requestPasswordReset(email) {
  const { data } = await api.post("/auth/forgot-password", { email });
  return data; // { ok: true, message: "..." }
}

/**
 * Complete a password reset.
 * POST /auth/reset-password
 * body: { token, password }
 */
export async function resetPassword({ token, password }) {
  const { data } = await api.post("/auth/reset-password", { token, password });
  return data; // { ok: true, message: "..." } or error
}
