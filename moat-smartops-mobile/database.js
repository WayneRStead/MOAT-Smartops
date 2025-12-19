// database.js
import * as SQLite from 'expo-sqlite';

/**
 * Expo SDK 54 / expo-sqlite ~16 uses the async API:
 *   const db = await SQLite.openDatabaseAsync('name.db')
 *
 * Do NOT use SQLite.openDatabase(...) or expo-sqlite/legacy.
 */

let dbPromise = null;

async function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('moatSmartOps.db');
      return db;
    })();
  }
  return dbPromise;
}

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return JSON.stringify({});
  }
}

function safeJsonArray(value) {
  try {
    return JSON.stringify(Array.isArray(value) ? value : []);
  } catch {
    return JSON.stringify([]);
  }
}

async function ensureOfflineEventsSchema(db) {
  // Create the table if it doesn't exist
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS offline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventType TEXT NOT NULL,         -- e.g. 'activity-log', 'project-update', ...
      orgId TEXT,
      userId TEXT,
      entityRef TEXT,                 -- optional: projectId/taskId/docId/etc
      payloadJson TEXT NOT NULL,       -- JSON string
      fileUrisJson TEXT NOT NULL,      -- JSON array of file URIs
      syncStatus TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'synced' | 'failed'
      errorText TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_offline_events_sync
      ON offline_events(syncStatus, createdAt);

    CREATE INDEX IF NOT EXISTS idx_offline_events_type
      ON offline_events(eventType, createdAt);
  `);

  // Lightweight "migration guard":
  // If you ever add a column in future, this prevents "no such column" crashes.
  try {
    const cols = await db.getAllAsync(`PRAGMA table_info(offline_events);`);
    const colNames = new Set((cols || []).map((c) => c?.name).filter(Boolean));

    // Example: if an older DB was created without eventType (rare now, but you saw this once)
    if (!colNames.has('eventType')) {
      await db.execAsync(`ALTER TABLE offline_events ADD COLUMN eventType TEXT;`);
    }
    if (!colNames.has('syncStatus')) {
      await db.execAsync(
        `ALTER TABLE offline_events ADD COLUMN syncStatus TEXT NOT NULL DEFAULT 'pending';`
      );
    }
    if (!colNames.has('errorText')) {
      await db.execAsync(`ALTER TABLE offline_events ADD COLUMN errorText TEXT;`);
    }
    if (!colNames.has('entityRef')) {
      await db.execAsync(`ALTER TABLE offline_events ADD COLUMN entityRef TEXT;`);
    }
    if (!colNames.has('payloadJson')) {
      await db.execAsync(
        `ALTER TABLE offline_events ADD COLUMN payloadJson TEXT NOT NULL DEFAULT '{}';`
      );
    }
    if (!colNames.has('fileUrisJson')) {
      await db.execAsync(
        `ALTER TABLE offline_events ADD COLUMN fileUrisJson TEXT NOT NULL DEFAULT '[]';`
      );
    }
    if (!colNames.has('createdAt')) {
      await db.execAsync(
        `ALTER TABLE offline_events ADD COLUMN createdAt TEXT NOT NULL DEFAULT '';`
      );
    }
    if (!colNames.has('updatedAt')) {
      await db.execAsync(
        `ALTER TABLE offline_events ADD COLUMN updatedAt TEXT NOT NULL DEFAULT '';`
      );
    }
  } catch (e) {
    // If ALTER fails (older SQLite quirks), we still don't want init to crash hard
    console.log('[DB] schema guard warning', e);
  }
}

/**
 * Initialize the outbox table. Everything offline gets stored here first.
 * Later, your sync worker will POST pending rows to backend and mark them synced.
 */
export async function initDatabase() {
  try {
    const db = await getDb();
    await ensureOfflineEventsSchema(db);

    console.log('[DB] SQLite initialised (offline_events table ready)');
    console.log('[DB] initDatabase complete (SQLite ready).');
  } catch (e) {
    console.log('[DB] initDatabase error', e);
    throw e;
  }
}

/**
 * Generic insert into outbox
 */
async function insertOfflineEvent({
  eventType,
  orgId,
  userId,
  entityRef = null,
  payload = {},
  fileUris = [],
}) {
  const db = await getDb();
  const createdAt = nowIso();
  const updatedAt = createdAt;

  const payloadJson = safeJson(payload);
  const fileUrisJson = safeJsonArray(fileUris);

  const result = await db.runAsync(
    `INSERT INTO offline_events
      (eventType, orgId, userId, entityRef, payloadJson, fileUrisJson, syncStatus, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [
      eventType,
      orgId ?? null,
      userId ?? null,
      entityRef,
      payloadJson,
      fileUrisJson,
      createdAt,
      updatedAt,
    ]
  );

  return result.lastInsertRowId;
}

/* ------------------------------------------------------------------ */
/*  PRODUCTIVITY MODULE SAVES                                          */
/* ------------------------------------------------------------------ */

export async function saveActivityLog(log) {
  const fileUris = [];
  if (log?.photoUri) fileUris.push(log.photoUri);

  const rowId = await insertOfflineEvent({
    eventType: 'activity-log',
    orgId: log?.orgId,
    userId: log?.userId,
    entityRef: log?.taskId || log?.projectId || null,
    payload: log,
    fileUris,
  });

  console.log('[DB] activity-log saved locally with rowId:', rowId);
  return rowId;
}

export async function saveProjectUpdate(update) {
  const rowId = await insertOfflineEvent({
    eventType: 'project-update',
    orgId: update?.orgId,
    userId: update?.userId,
    entityRef: update?.projectId || null,
    payload: update,
    fileUris: [],
  });

  console.log('[DB] project-update saved locally with rowId:', rowId);
  return rowId;
}

export async function saveTaskUpdate(update) {
  const rowId = await insertOfflineEvent({
    eventType: 'task-update',
    orgId: update?.orgId,
    userId: update?.userId,
    entityRef: update?.taskId || null,
    payload: update,
    fileUris: [],
  });

  console.log('[DB] task-update saved locally with rowId:', rowId);
  return rowId;
}

export async function saveUserDocumentAttachment(doc) {
  const fileUris = [];
  if (doc?.photoUri) fileUris.push(doc.photoUri);

  const rowId = await insertOfflineEvent({
    eventType: 'user-document',
    orgId: doc?.orgId,
    userId: doc?.userId,
    entityRef: doc?.projectId || doc?.targetUserId || null,
    payload: doc,
    fileUris,
  });

  console.log('[DB] user-document saved locally with rowId:', rowId);
  return rowId;
}

/* ------------------------------------------------------------------ */
/*  COMPAT EXPORTS (so existing screens don’t break)                   */
/* ------------------------------------------------------------------ */

// If some screens import these older names, keep them working:
export const saveProjectNote = saveProjectUpdate;
export const saveTaskNote = saveTaskUpdate;
export const saveUserDocument = saveUserDocumentAttachment;

/* ------------------------------------------------------------------ */
/*  DB VIEWER / DEBUG HELPERS (NEXT STEP IN OUR ORDER)                 */
/* ------------------------------------------------------------------ */

/**
 * Returns newest events first, ready for a "Debug DB" screen.
 * Each row includes a parsed preview field (payloadPreview) for quick display.
 */
export async function listOfflineEvents(limit = 50) {
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT id, eventType, orgId, userId, entityRef, syncStatus, errorText, createdAt, updatedAt, payloadJson, fileUrisJson
     FROM offline_events
     ORDER BY id DESC
     LIMIT ?`,
    [limit]
  );

  return (rows || []).map((r) => {
    let payloadPreview = null;
    try {
      const obj = JSON.parse(r.payloadJson || '{}');
      // keep it light for UI: a couple useful fields if present
      payloadPreview = {
        projectId: obj.projectId ?? null,
        taskId: obj.taskId ?? null,
        milestone: obj.milestone ?? null,
        note: obj.note ?? obj.managerNote ?? null,
        title: obj.title ?? null,
      };
    } catch {
      payloadPreview = null;
    }

    return {
      ...r,
      payloadPreview,
    };
  });
}

/* ------------------------------------------------------------------ */
/*  SYNC QUEUE HELPERS (used when wiring backend sync)                 */
/* ------------------------------------------------------------------ */

export async function getPendingEvents(limit = 50) {
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM offline_events
     WHERE syncStatus = 'pending'
     ORDER BY createdAt ASC
     LIMIT ?`,
    [limit]
  );
  return rows || [];
}

export async function markEventSynced(id) {
  const db = await getDb();
  const updatedAt = nowIso();
  await db.runAsync(
    `UPDATE offline_events
     SET syncStatus='synced', errorText=NULL, updatedAt=?
     WHERE id=?`,
    [updatedAt, id]
  );
}

export async function markEventFailed(id, errorText) {
  const db = await getDb();
  const updatedAt = nowIso();
  await db.runAsync(
    `UPDATE offline_events
     SET syncStatus='failed', errorText=?, updatedAt=?
     WHERE id=?`,
    [String(errorText || 'Unknown error'), updatedAt, id]
  );
}

export async function resetFailedToPending() {
  const db = await getDb();
  const updatedAt = nowIso();
  await db.runAsync(
    `UPDATE offline_events
     SET syncStatus='pending', errorText=NULL, updatedAt=?
     WHERE syncStatus='failed'`,
    [updatedAt]
  );
}

export async function countEventsByType() {
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT eventType, COUNT(*) as count
     FROM offline_events
     GROUP BY eventType
     ORDER BY count DESC`
  );
  return rows || [];
}

export async function saveVehicleCreate(vehicle) {
  const {
    orgId,
    userId,
    regNumber,
    vin,
    vehicleType,
    make,
    model,
    year,
    source = 'disc-scan',
    discRaw = null,
  } = vehicle || {};

  if (!regNumber || !make) {
    throw new Error('Vehicle requires regNumber and make');
  }

  const payload = {
    orgId,
    userId,
    regNumber,
    vin: vin || null,
    vehicleType: vehicleType || null,
    make,
    model: model || null,
    year: year || null,
    source,
    discRaw,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const rowId = await insertOfflineEvent({
    eventType: 'vehicle-create',
    orgId,
    userId,
    entityRef: regNumber, // critical for dedupe
    payload,
    fileUris: [],
  });

  console.log('[DB] vehicle-create saved locally with rowId:', rowId);
  return rowId;
}

export async function saveVehicleTrip(trip) {
  // trip: { kind: 'trip-start'|'trip-end', regNumber, vehicle, odometer/photo, coords, ... }
  const fileUris = [];
  if (trip?.photoUri) fileUris.push(trip.photoUri);
  if (trip?.odometerPhotoUri) fileUris.push(trip.odometerPhotoUri);

  const rowId = await insertOfflineEvent({
    eventType: 'vehicle-trip',
    orgId: trip?.orgId,
    userId: trip?.userId,
    entityRef: trip?.regNumber || null,
    payload: trip,
    fileUris,
  });

  console.log('[DB] vehicle-trip saved locally with rowId:', rowId);
  return rowId;
}

export async function saveVehiclePurchase(purchase) {
  // purchase: { regNumber, vendor/type/cost, odometerPhotoUri, coords, ... }
  const fileUris = [];
  if (purchase?.odometerPhotoUri) fileUris.push(purchase.odometerPhotoUri);

  const rowId = await insertOfflineEvent({
    eventType: 'vehicle-purchase',
    orgId: purchase?.orgId,
    userId: purchase?.userId,
    entityRef: purchase?.regNumber || null,
    payload: purchase,
    fileUris,
  });

  console.log('[DB] vehicle-purchase saved locally with rowId:', rowId);
  return rowId;
}

export async function saveVehicleLog(log) {
  // log: { regNumber, type, cost, notes, photoUri, coords, ... }
  const fileUris = [];
  if (log?.photoUri) fileUris.push(log.photoUri);

  const rowId = await insertOfflineEvent({
    eventType: 'vehicle-log',
    orgId: log?.orgId,
    userId: log?.userId,
    entityRef: log?.regNumber || null,
    payload: log,
    fileUris,
  });

  console.log('[DB] vehicle-log saved locally with rowId:', rowId);
  return rowId;
}

export async function saveAssetCreate(asset) {
  const rowId = await insertOfflineEvent({
    eventType: 'asset-create',
    orgId: asset?.orgId,
    userId: asset?.userId,
    entityRef: asset?.assetCode || null,
    payload: asset,
    fileUris: [],
  });

  console.log('[DB] asset-create saved locally with rowId:', rowId);
  return rowId;
}

export async function saveAssetLog(log) {
  const fileUris = [];
  if (log?.photoUri) fileUris.push(log.photoUri);

  const rowId = await insertOfflineEvent({
    eventType: 'asset-log',
    orgId: log?.orgId,
    userId: log?.userId,
    entityRef: log?.assetCode || null,
    payload: log,
    fileUris,
  });

  console.log('[DB] asset-log saved locally with rowId:', rowId);
  return rowId;
}
