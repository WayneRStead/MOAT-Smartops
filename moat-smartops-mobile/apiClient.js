// moat-smartops-mobile/apiClient.js
import AsyncStorage from "@react-native-async-storage/async-storage";

// Keep your primary keys:
export const TOKEN_KEY = "@moat:token";
export const ORG_KEY = "@moat:orgId";

// Fallback keys used elsewhere in the app (compat)
const TOKEN_KEYS_FALLBACK = [
  TOKEN_KEY,
  "@moat:cache:token",
  "@moat:cache:authToken",
  "@moat:token",
  "token",
];

const ORG_KEYS_FALLBACK = [
  ORG_KEY,
  "@moat:cache:orgid",
  "@moat:cache:orgId",
  "@moat:orgid",
  "@moat:orgId",
  "moat:orgid",
  "moat:orgId",
];

// Example: https://moat-smartops.onrender.com
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL || "https://YOUR-RENDER-URL";

async function getFirstStorageValue(keys) {
  for (const k of keys) {
    try {
      const v = await AsyncStorage.getItem(k);
      if (v) return { key: k, value: v };
    } catch {
      // ignore
    }
  }
  return { key: null, value: null };
}

export async function getAuthHeaders({ json = true } = {}) {
  const tokenFound = await getFirstStorageValue(TOKEN_KEYS_FALLBACK);
  const orgFound = await getFirstStorageValue(ORG_KEYS_FALLBACK);

  const headers = {};

  // Only set JSON content-type when sending JSON
  if (json) headers["Content-Type"] = "application/json";

  if (tokenFound.value) headers.Authorization = `Bearer ${tokenFound.value}`;
  if (orgFound.value) headers["x-org-id"] = orgFound.value;

  return {
    headers,
    token: tokenFound.value,
    tokenKey: tokenFound.key,
    orgId: orgFound.value,
    orgKey: orgFound.key,
  };
}

async function parseResponse(res) {
  const text = await res.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    const msg = json?.error || json?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "");
  if (!p.startsWith("/")) return `${b}/${p}`;
  return `${b}${p}`;
}

export async function apiGet(path) {
  const { headers } = await getAuthHeaders({ json: true });
  const res = await fetch(joinUrl(API_BASE_URL, path), {
    method: "GET",
    headers,
  });
  return parseResponse(res);
}

// JSON POST (existing behavior, but more robust)
export async function apiPost(path, body) {
  const { headers } = await getAuthHeaders({ json: true });
  const res = await fetch(joinUrl(API_BASE_URL, path), {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  return parseResponse(res);
}

// ✅ NEW: multipart/form-data POST (for photos)
export async function apiPostForm(path, formData) {
  // IMPORTANT: do NOT set Content-Type for FormData (fetch will set boundary)
  const { headers } = await getAuthHeaders({ json: false });

  const res = await fetch(joinUrl(API_BASE_URL, path), {
    method: "POST",
    headers,
    body: formData,
  });

  return parseResponse(res);
}
