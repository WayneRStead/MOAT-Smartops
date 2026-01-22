// moat-smartops-mobile/syncOutbox.js
import { apiPost } from "./apiClient";
import { getPendingEvents, markEventFailed, markEventSynced } from "./database";

function safeParseJson(s, fallback) {
  try {
    return JSON.parse(s || "");
  } catch {
    return fallback;
  }
}

/**
 * Sync pending offline_events to backend.
 * - Sends ONE event at a time (simpler, more reliable).
 * - Marks each row synced/failed.
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

      // NOTE: For now we send fileUris as strings only.
      // Later we’ll upload the actual files (photos) properly.
      await apiPost("/api/mobile/offline-events", {
        localId: row.id,
        eventType: row.eventType,
        orgId: row.orgId,
        userId: row.userId,
        entityRef: row.entityRef,
        payload,
        fileUris,
        createdAt: row.createdAt,
      });

      await markEventSynced(row.id);
      synced++;
    } catch (e) {
      await markEventFailed(row.id, e?.message || "Sync failed");
      failed++;
    }
  }

  return { ok: true, synced, failed };
}
