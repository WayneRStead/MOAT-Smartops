// moat-smartops-mobile/apiClient.js
import AsyncStorage from "@react-native-async-storage/async-storage";

export const TOKEN_KEY = "@moat:token";
export const ORG_KEY = "@moat:orgId";

// Example: https://moat-smartops.onrender.com
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL || "https://YOUR-RENDER-URL";

export async function getAuthHeaders() {
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  const orgId = await AsyncStorage.getItem(ORG_KEY);

  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (orgId) headers["x-org-id"] = orgId;

  return { headers, token, orgId };
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

export async function apiGet(path) {
  const { headers } = await getAuthHeaders();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "GET",
    headers,
  });
  return parseResponse(res);
}

export async function apiPost(path, body) {
  const { headers } = await getAuthHeaders();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  return parseResponse(res);
}
