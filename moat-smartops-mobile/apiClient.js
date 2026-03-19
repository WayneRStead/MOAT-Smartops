import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import * as Linking from "expo-linking";
import { Platform } from "react-native";

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

export function buildApiUrl(path) {
  return joinUrl(API_BASE_URL, path);
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

export async function fetchMobileLibraryDocuments() {
  return apiGet("/api/documents/mobile/library");
}

function sanitizeFilename(name) {
  return String(name || "document")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .trim();
}

function extFromMime(mime) {
  const m = String(mime || "").toLowerCase();

  if (m.includes("pdf")) return ".pdf";
  if (m.includes("png")) return ".png";
  if (m.includes("jpeg")) return ".jpg";
  if (m.includes("jpg")) return ".jpg";
  if (m.includes("webp")) return ".webp";
  if (m.includes("gif")) return ".gif";
  if (m.includes("mp4")) return ".mp4";
  if (m.includes("quicktime")) return ".mov";
  if (m.includes("mpeg")) return ".mp3";
  if (m.includes("wav")) return ".wav";
  if (m.includes("msword")) return ".doc";
  if (m.includes("officedocument.wordprocessingml.document")) return ".docx";
  if (m.includes("excel")) return ".xls";
  if (m.includes("officedocument.spreadsheetml.sheet")) return ".xlsx";
  if (m.includes("json")) return ".json";
  if (m.includes("csv")) return ".csv";
  if (m.includes("plain")) return ".txt";

  return "";
}

function ensureExtension(filename, mime) {
  const safe = sanitizeFilename(filename || "document");
  if (/\.[a-z0-9]{2,8}$/i.test(safe)) return safe;
  const ext = extFromMime(mime);
  return `${safe}${ext}`;
}

function guessMimeTypeFromFilename(name = "") {
  const lower = String(name || "").toLowerCase();

  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".doc")) return "application/msword";
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".xls")) return "application/vnd.ms-excel";
  if (lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".txt")) return "text/plain";

  return "application/octet-stream";
}

function normalizeDocumentInput(doc) {
  const latest = doc?.latest || {};
  const urlPath = String(latest?.url || "").trim();
  const filename = ensureExtension(
    latest?.filename || doc?.title || "document",
    latest?.mime || "",
  );
  const mimeType =
    String(latest?.mime || "").trim() || guessMimeTypeFromFilename(filename);

  return {
    urlPath,
    filename,
    mimeType,
    title: String(doc?.title || filename || "document"),
  };
}

async function ensureDirectoryExists(dirUri) {
  const info = await FileSystem.getInfoAsync(dirUri);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dirUri, { intermediates: true });
  }
}

async function fileExists(uri) {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return !!info.exists;
  } catch {
    return false;
  }
}

async function downloadProtectedFile({
  urlPath,
  filename,
  targetDirectory,
  forceRedownload = false,
}) {
  if (!urlPath) {
    throw new Error("Document file URL is missing");
  }

  const { headers } = await getAuthHeaders({ json: false });
  const absoluteUrl = buildApiUrl(urlPath);
  const safeFilename = sanitizeFilename(filename || "document");
  const dirUri = targetDirectory;
  const fileUri = `${dirUri}${safeFilename}`;

  await ensureDirectoryExists(dirUri);

  if (!forceRedownload) {
    const exists = await fileExists(fileUri);
    if (exists) {
      return fileUri;
    }
  }

  const result = await FileSystem.downloadAsync(absoluteUrl, fileUri, {
    headers,
  });

  if (!result?.uri) {
    throw new Error("Download failed");
  }

  return result.uri;
}

export async function downloadProtectedDocumentToCache(doc, options = {}) {
  const normalized = normalizeDocumentInput(doc);

  const uri = await downloadProtectedFile({
    urlPath: normalized.urlPath,
    filename: normalized.filename,
    targetDirectory: `${FileSystem.cacheDirectory}documents/`,
    forceRedownload: !!options.forceRedownload,
  });

  return {
    uri,
    filename: normalized.filename,
    mimeType: normalized.mimeType,
    title: normalized.title,
  };
}

export async function saveProtectedDocumentOffline(doc, options = {}) {
  const normalized = normalizeDocumentInput(doc);

  const uri = await downloadProtectedFile({
    urlPath: normalized.urlPath,
    filename: normalized.filename,
    targetDirectory: `${FileSystem.documentDirectory}offline-documents/`,
    forceRedownload: !!options.forceRedownload,
  });

  return {
    uri,
    filename: normalized.filename,
    mimeType: normalized.mimeType,
    title: normalized.title,
  };
}

async function openLocalFile(uri, mimeType) {
  if (!uri) {
    throw new Error("Local file URI is missing");
  }

  if (Platform.OS === "android") {
    const contentUri = await FileSystem.getContentUriAsync(uri);

    await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
      data: contentUri,
      flags: 1,
      type: mimeType || "application/octet-stream",
    });

    return true;
  }

  const canOpen = await Linking.canOpenURL(uri);
  if (!canOpen) {
    throw new Error("No compatible app is available to open this document.");
  }

  await Linking.openURL(uri);
  return true;
}

export async function openProtectedDocument(doc) {
  const saved = await saveProtectedDocumentOffline(doc);
  await openLocalFile(saved.uri, saved.mimeType);

  return {
    ok: true,
    uri: saved.uri,
    filename: saved.filename,
    mimeType: saved.mimeType,
    title: saved.title,
    openedOfflineCopy: true,
  };
}

export async function getOfflineDocumentUri(doc) {
  const normalized = normalizeDocumentInput(doc);
  const uri = `${FileSystem.documentDirectory}offline-documents/${sanitizeFilename(normalized.filename)}`;
  const exists = await fileExists(uri);

  return {
    exists,
    uri,
    filename: normalized.filename,
    mimeType: normalized.mimeType,
    title: normalized.title,
  };
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
