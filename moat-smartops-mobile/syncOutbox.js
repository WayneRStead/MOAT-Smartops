// moat-smartops-mobile/syncOutbox.js
import { API_BASE_URL, apiPost, getAuthHeaders } from "./apiClient";
import {
  getPendingEvents,
  markEventApplied,
  markEventFailed,
  markEventSynced,
} from "./database";

/** Safe JSON parse */
function safeParseJson(s, fallback) {
  try {
    return JSON.parse(s || "");
  } catch {
    return fallback;
  }
}

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "");
  if (!p.startsWith("/")) return `${b}/${p}`;
  return `${b}${p}`;
}

/**
 * Infer server stage from backend response.
 * Backend can return:
 *  - { ok:true, stage:'received' }
 *  - { ok:true, stage:'applied' }
 */
function inferServerStageFromResponse(res) {
  const stage = String(res?.stage || res?.status || "").toLowerCase();
  if (stage === "applied") return "applied";
  return "received";
}

/**
 * Mark as "received" OR "applied" (backend confirmed applied).
 */
async function markSyncedWithStage(rowId, serverStage) {
  if (serverStage === "applied" && typeof markEventApplied === "function") {
    await markEventApplied(rowId);
    return;
  }
  await markEventSynced(rowId);
}

function getFileNameFromUri(uri, fallbackName = "file") {
  const clean = String(uri || "")
    .split("?")[0]
    .trim();
  if (!clean) return fallbackName;

  const last = clean.split("/").pop() || "";
  return last.trim() || fallbackName;
}

function guessFileMeta(uri, fallbackName = "file") {
  const clean = String(uri || "");
  const lower = clean.toLowerCase();

  let type = "image/jpeg";
  let ext = "jpg";

  if (lower.endsWith(".png")) {
    type = "image/png";
    ext = "png";
  } else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    type = "image/jpeg";
    ext = lower.endsWith(".jpeg") ? "jpeg" : "jpg";
  } else if (lower.endsWith(".heic")) {
    type = "image/heic";
    ext = "heic";
  } else if (lower.endsWith(".webp")) {
    type = "image/webp";
    ext = "webp";
  } else if (lower.endsWith(".pdf")) {
    type = "application/pdf";
    ext = "pdf";
  }

  const originalName = getFileNameFromUri(uri, "");
  const name =
    originalName ||
    `${String(fallbackName || "file").replace(/\.[a-z0-9]+$/i, "")}.${ext}`;

  return { type, ext, name };
}

async function parseFetchResponse(res) {
  const text = await res.text().catch(() => "");
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const msg = json?.error || json?.message || text || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = json || { raw: text };
    throw err;
  }

  return json || { ok: true, stage: "received" };
}

function isLocalUploadableUri(uri) {
  const s = String(uri || "").trim();
  if (!s) return false;
  if (s.startsWith("file://")) return true;
  if (s.startsWith("content://")) return true;
  return false;
}

function dedupeUris(list) {
  const out = [];
  const seen = new Set();

  for (const raw of Array.isArray(list) ? list : []) {
    const uri = String(raw || "").trim();
    if (!uri) continue;
    if (seen.has(uri)) continue;
    seen.add(uri);
    out.push(uri);
  }

  return out;
}

/**
 * Build inspection-run multipart files directly from payload.
 * Order matters:
 *  1) item evidence photos
 *  2) signature file last
 *
 * This lets us calculate payload.signatureUploadIndex correctly.
 */
function normalizeInspectionRunPayloadAndFiles(payload, fallbackFileUris = []) {
  const nextPayload =
    payload && typeof payload === "object"
      ? JSON.parse(JSON.stringify(payload))
      : {};

  const uploadUris = [];
  const items = Array.isArray(nextPayload?.items) ? nextPayload.items : [];

  // item photos first
  for (const item of items) {
    const photoUri = String(item?.evidence?.photoUrl || "").trim();
    if (isLocalUploadableUri(photoUri)) {
      uploadUris.push(photoUri);
    }
  }

  // include any fallback fileUris from DB too, but avoid duplicates
  for (const uri of Array.isArray(fallbackFileUris) ? fallbackFileUris : []) {
    if (isLocalUploadableUri(uri)) {
      uploadUris.push(String(uri).trim());
    }
  }

  const dedupedEvidenceUris = dedupeUris(uploadUris);

  // signature last
  const signatureUri = String(
    nextPayload?.signoff?.signatureFileUri || "",
  ).trim();

  let signatureUploadIndex = -1;
  const finalUris = [...dedupedEvidenceUris];

  if (isLocalUploadableUri(signatureUri)) {
    signatureUploadIndex = finalUris.length;
    finalUris.push(signatureUri);
  }

  nextPayload.signatureUploadIndex = signatureUploadIndex;

  return {
    payload: nextPayload,
    fileUris: finalUris,
  };
}

/**
 * Upload offline event to backend with optional files.
 * - JSON events use apiPost
 * - Multipart events use fetch + FormData
 */
async function postOfflineEventToServer({ row, payload, fileUris }) {
  const eventType = String(row?.eventType || "")
    .trim()
    .toLowerCase();

  let finalPayload = payload || {};
  let finalFileUris = Array.isArray(fileUris) ? fileUris.filter(Boolean) : [];

  // IMPORTANT:
  // inspection-run must derive upload files from payload items + signature
  if (eventType === "inspection-run") {
    const normalized = normalizeInspectionRunPayloadAndFiles(
      finalPayload,
      finalFileUris,
    );
    finalPayload = normalized.payload;
    finalFileUris = normalized.fileUris;
  }

  const hasFiles = finalFileUris.length > 0;

  // ✅ No files: keep current JSON mobile-offline behavior
  if (!hasFiles) {
    return await apiPost("/api/mobile/offline-events", {
      localId: row.id,
      eventType: row.eventType,
      orgId: row.orgId,
      userId: row.userId,
      entityRef: row.entityRef,
      payload: finalPayload,
      fileUris: [],
      createdAt: row.createdAt,
    });
  }

  // ✅ With files: multipart upload for mobile offline ingest
  const form = new FormData();

  form.append("localId", String(row.id));
  form.append("eventType", String(row.eventType || ""));
  form.append("orgId", String(row.orgId || ""));
  form.append("userId", String(row.userId || ""));
  form.append("entityRef", row.entityRef ? String(row.entityRef) : "");
  form.append("createdAt", String(row.createdAt || new Date().toISOString()));
  form.append("payloadJson", JSON.stringify(finalPayload || {}));

  finalFileUris.forEach((uri, idx) => {
    const meta = guessFileMeta(
      uri,
      `offline_${row.eventType}_${row.id}_${idx}`,
    );

    form.append("files", {
      uri: String(uri),
      name: meta.name,
      type: meta.type,
    });
  });

  const url = joinUrl(API_BASE_URL, "/api/mobile/offline-events");

  const auth = await getAuthHeaders({ json: false });
  const headers = { ...(auth?.headers || {}) };

  // IMPORTANT: never set Content-Type manually for FormData
  delete headers["Content-Type"];

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: form,
  });

  return await parseFetchResponse(res);
}

/**
 * Sync pending offline_events to backend.
 * - Sends one event at a time
 * - Marks each row as synced or failed
 */
export async function syncOutbox({ limit = 25 } = {}) {
  const pending = await getPendingEvents(limit);

  if (!pending.length) {
    return { ok: true, synced: 0, failed: 0 };
  }

  let synced = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const payload = safeParseJson(row.payloadJson, {});
      const fileUris = safeParseJson(row.fileUrisJson, []);

      const res = await postOfflineEventToServer({
        row,
        payload,
        fileUris,
      });

      const serverStage = inferServerStageFromResponse(res);
      await markSyncedWithStage(row.id, serverStage);
      synced += 1;
    } catch (e) {
      console.log("[SYNC] failed row", row?.id, row?.eventType, e);
      await markEventFailed(row.id, e?.message || "Sync failed");
      failed += 1;
    }
  }

  return { ok: true, synced, failed };
}
