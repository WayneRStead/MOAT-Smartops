// moat-smartops-mobile/apiClient.js
import AsyncStorage from "@react-native-async-storage/async-storage";

// Primary keys
export const TOKEN_KEY = "@moat:token";
export const ORG_KEY = "@moat:orgId";
export const CACHE_ME_KEY = "@moat:cache:me";
export const USER_ID_KEY = "@moat:userId";

// Fallback keys used elsewhere in the app
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

const USER_ID_KEYS_FALLBACK = [USER_ID_KEY, "@moat:userid", "moat:userid"];

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

export async function apiPost(path, body) {
  const { headers } = await getAuthHeaders({ json: true });
  const res = await fetch(joinUrl(API_BASE_URL, path), {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  return parseResponse(res);
}

export async function apiPut(path, body) {
  const { headers } = await getAuthHeaders({ json: true });
  const res = await fetch(joinUrl(API_BASE_URL, path), {
    method: "PUT",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  return parseResponse(res);
}

export async function apiDelete(path) {
  const { headers } = await getAuthHeaders({ json: true });
  const res = await fetch(joinUrl(API_BASE_URL, path), {
    method: "DELETE",
    headers,
  });
  return parseResponse(res);
}

// multipart/form-data POST
export async function apiPostForm(path, formData) {
  const { headers } = await getAuthHeaders({ json: false });

  const res = await fetch(joinUrl(API_BASE_URL, path), {
    method: "POST",
    headers,
    body: formData,
  });

  return parseResponse(res);
}

// Fetch backend user profile and cache it locally
export async function refreshCachedMe() {
  try {
    const data = await apiGet("/api/mobile/whoami");
    const user = data?.user || null;

    if (user) {
      await AsyncStorage.setItem(CACHE_ME_KEY, JSON.stringify(user));

      const userId = user?._id || user?.id || user?.userId || "";

      if (userId) {
        await AsyncStorage.setItem(USER_ID_KEY, String(userId));
      }
    }

    return user;
  } catch (e) {
    console.log("[apiClient] refreshCachedMe failed", e?.message || e);
    return null;
  }
}

export async function getCachedMe() {
  try {
    const raw = await AsyncStorage.getItem(CACHE_ME_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function getStoredUserId() {
  const found = await getFirstStorageValue(USER_ID_KEYS_FALLBACK);
  return found.value ? String(found.value) : "";
}
