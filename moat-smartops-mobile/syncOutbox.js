// moat-smartops-mobile/syncOutbox.js
// FULL DROP-IN REPLACEMENT
// ✅ JSON posts use apiPost (keeps current behavior)
// ✅ Multipart posts use fetch with:
//    - API_BASE_URL (absolute URL)
//    - Authorization + x-org-id headers from getAuthHeaders()
//    - NO manual Content-Type (FormData boundary must be auto-set)

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
 * If markEventApplied doesn't exist, falls back to markEventSynced.
 */
async function markSyncedWithStage(rowId, serverStage) {
  if (serverStage === "applied" && typeof markEventApplied === "function") {
    await markEventApplied(rowId);
    return;
  }
  await markEventSynced(rowId);
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
  }

  return { type, ext, name: `${fallbackName}.${ext}` };
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

/**
 * Upload offline event to backend with optional photos:
 * - If fileUris exist, use multipart/form-data (FormData)
 * - Else, use JSON apiPost
 */
async function postOfflineEventToServer({ row, payload, fileUris }) {
  const hasFiles = Array.isArray(fileUris) && fileUris.length > 0;

  // ✅ No files: keep your current JSON behaviour (this uses API_BASE_URL + auth headers)
  if (!hasFiles) {
    return await apiPost("/api/mobile/offline-events", {
      localId: row.id,
      eventType: row.eventType,
      orgId: row.orgId,
      userId: row.userId,
      entityRef: row.entityRef,
      payload,
      fileUris: [],
      createdAt: row.createdAt,
    });
  }

  // ✅ With files: multipart upload
  const form = new FormData();

  form.append("localId", String(row.id));
  form.append("eventType", String(row.eventType || ""));
  form.append("orgId", String(row.orgId || ""));
  form.append("userId", String(row.userId || ""));
  form.append("entityRef", row.entityRef ? String(row.entityRef) : "");
  form.append("createdAt", String(row.createdAt || new Date().toISOString()));
  form.append("payloadJson", JSON.stringify(payload || {}));

  fileUris.forEach((uri, idx) => {
    if (!uri) return;
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

  // ✅ IMPORTANT: absolute URL (no relative "/api/..." calls)
  const url = `${API_BASE_URL}/api/mobile/offline-events`;

  // ✅ IMPORTANT: include auth + org headers; do NOT set Content-Type
  const { headers } = await getAuthHeaders();
  // Remove JSON content-type if present (it breaks multipart)
  if (headers && headers["Content-Type"]) delete headers["Content-Type"];

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: form,
  });

  return await parseFetchResponse(res);
}

/**
 * Sync pending offline_events to backend.
 * - Sends ONE event at a time.
 * - Marks each row as synced/failed.
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

      const res = await postOfflineEventToServer({ row, payload, fileUris });

      const serverStage = inferServerStageFromResponse(res);
      await markSyncedWithStage(row.id, serverStage);

      synced++;
    } catch (e) {
      await markEventFailed(row.id, e?.message || "Sync failed");
      failed++;
    }
  }

  return { ok: true, synced, failed };
}
