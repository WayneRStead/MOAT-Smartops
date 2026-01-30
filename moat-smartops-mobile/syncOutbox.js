// moat-smartops-mobile/syncOutbox.js
import { apiPost } from "./apiClient";
import {
  getPendingEvents,
  // Optional: only works if you added it to database.js (Step 3B)
  markEventApplied,
  markEventFailed,
  markEventSynced,
} from "./database";

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
 *  - { ok:true, stage:'received' }  (common now)
 *  - { ok:true, stage:'applied' }   (later when backend applier is ready)
 * If nothing useful returned, default to 'received'.
 */
function inferServerStageFromResponse(res) {
  const stage = String(res?.stage || res?.status || "").toLowerCase();
  if (stage === "applied") return "applied";
  return "received";
}

/**
 * Mark as "sent to server" (received) OR "applied" (backend confirmed applied).
 * - If markEventApplied doesn't exist yet in database.js, we safely fall back to markEventSynced.
 */
async function markSyncedWithStage(rowId, serverStage) {
  if (serverStage === "applied" && typeof markEventApplied === "function") {
    await markEventApplied(rowId);
    return;
  }
  // received (or fallback)
  await markEventSynced(rowId);
}

/**
 * Sync pending offline_events to backend.
 * - Sends ONE event at a time (simpler, more reliable).
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

      // Send to backend
      const res = await apiPost("/api/mobile/offline-events", {
        localId: row.id,
        eventType: row.eventType,
        orgId: row.orgId,
        userId: row.userId,
        entityRef: row.entityRef,
        payload,
        fileUris,
        createdAt: row.createdAt,
      });

      // Decide stage:
      // - today: almost always "received"
      // - later: backend applier can return "applied"
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
