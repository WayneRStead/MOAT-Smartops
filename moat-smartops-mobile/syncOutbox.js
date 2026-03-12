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

function buildInspectionRunRequest(payload, row) {
  return {
    formId: payload?.formId || row?.entityRef || "",
    run: payload?.payload || payload,
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
  const files = Array.isArray(fileUris) ? fileUris.filter(Boolean) : [];

  // ✅ inspections go to their dedicated endpoint
  if (eventType === "inspection-run") {
    const body = buildInspectionRunRequest(payload, row);
    return await apiPost(
      `/api/inspections/forms/${encodeURIComponent(body.formId)}/run`,
      body.run,
    );
  }

  const hasFiles = files.length > 0;

  // ✅ No files: keep current JSON mobile-offline behavior
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

  // ✅ With files: multipart upload for mobile offline ingest
  const form = new FormData();

  form.append("localId", String(row.id));
  form.append("eventType", String(row.eventType || ""));
  form.append("orgId", String(row.orgId || ""));
  form.append("userId", String(row.userId || ""));
  form.append("entityRef", row.entityRef ? String(row.entityRef) : "");
  form.append("createdAt", String(row.createdAt || new Date().toISOString()));
  form.append("payloadJson", JSON.stringify(payload || {}));

  files.forEach((uri, idx) => {
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
