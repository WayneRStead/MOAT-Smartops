// database.js
import * as SQLite from "expo-sqlite";

/**
 * Expo SDK 54 / expo-sqlite ~16 uses the async API:
 *   const db = await SQLite.openDatabaseAsync('name.db')
 */

let dbPromise = null;

async function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync("moatSmartOps.db");
      // WAL is good for concurrent reads/writes
      await db.execAsync(`PRAGMA journal_mode = WAL;`);
      // ✅ Ensure schema exists before anyone tries to insert
      await ensureOfflineEventsSchema(db);
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
  // Create table + indexes
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS offline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventType TEXT NOT NULL,         -- e.g. 'activity-log', 'clock-batch-v2', 'biometric-enroll'
      orgId TEXT,
      userId TEXT,
      entityRef TEXT,                  -- optional: projectId/taskId/targetUserId/etc
      payloadJson TEXT NOT NULL,        -- JSON string
      fileUrisJson TEXT NOT NULL,       -- JSON array of file URIs
      syncStatus TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'synced' | 'failed'
      serverStage TEXT,                -- 'received' | 'applied' (optional)
      errorText TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_offline_events_sync
      ON offline_events(syncStatus, createdAt);

    CREATE INDEX IF NOT EXISTS idx_offline_events_type
      ON offline_events(eventType, createdAt);

    CREATE INDEX IF NOT EXISTS idx_offline_events_org
      ON offline_events(orgId, createdAt);

    CREATE INDEX IF NOT EXISTS idx_offline_events_entityRef
      ON offline_events(entityRef, createdAt);
  `);

  // Migration guard: add missing columns safely (older DBs)
  try {
    const cols = await db.getAllAsync(`PRAGMA table_info(offline_events);`);
    const colNames = new Set((cols || []).map((c) => c?.name).filter(Boolean));

    const addCol = async (name, ddl) => {
      if (!colNames.has(name)) {
        await db.execAsync(`ALTER TABLE offline_events ADD COLUMN ${ddl};`);
      }
    };

    await addCol("eventType", "eventType TEXT");
    await addCol("orgId", "orgId TEXT");
    await addCol("userId", "userId TEXT");
    await addCol("entityRef", "entityRef TEXT");
    await addCol("payloadJson", "payloadJson TEXT NOT NULL DEFAULT '{}'");
    await addCol("fileUrisJson", "fileUrisJson TEXT NOT NULL DEFAULT '[]'");
    await addCol("syncStatus", "syncStatus TEXT NOT NULL DEFAULT 'pending'");
    await addCol("serverStage", "serverStage TEXT");
    await addCol("errorText", "errorText TEXT");
    await addCol("createdAt", "createdAt TEXT NOT NULL DEFAULT ''");
    await addCol("updatedAt", "updatedAt TEXT NOT NULL DEFAULT ''");
  } catch (e) {
    console.log("[DB] schema guard warning", e);
  }
}

/**
 * Initialize SQLite + offline_events outbox table.
 */
export async function initDatabase() {
  await getDb(); // getDb now guarantees schema exists
  console.log("[DB] initDatabase complete (offline_events ready)");
  return true;
}

/**
 * Generic insert into offline_events outbox.
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
      String(eventType || "unknown"),
      orgId ?? null,
      userId ?? null,
      entityRef ?? null,
      payloadJson,
      fileUrisJson,
      createdAt,
      updatedAt,
    ],
  );

  return result?.lastInsertRowId ?? null;
}

/* ------------------------------------------------------------------ */
/*  PRODUCTIVITY MODULE SAVES                                          */
/* ------------------------------------------------------------------ */

export async function saveActivityLog(log) {
  const fileUris = [];
  if (log?.photoUri) fileUris.push(log.photoUri);

  const rowId = await insertOfflineEvent({
    eventType: "activity-log",
    orgId: log?.orgId,
    userId: log?.userId,
    entityRef: log?.taskId || log?.projectId || null,
    payload: log,
    fileUris,
  });

  console.log("[DB] activity-log saved locally with rowId:", rowId);
  return rowId;
}

export async function saveProjectUpdate(update) {
  const rowId = await insertOfflineEvent({
    eventType: "project-update",
    orgId: update?.orgId,
    userId: update?.userId,
    entityRef: update?.projectId || null,
    payload: update,
    fileUris: [],
  });

  console.log("[DB] project-update saved locally with rowId:", rowId);
  return rowId;
}

export async function saveTaskUpdate(update) {
  const rowId = await insertOfflineEvent({
    eventType: "task-update",
    orgId: update?.orgId,
    userId: update?.userId,
    entityRef: update?.taskId || null,
    payload: update,
    fileUris: [],
  });

  console.log("[DB] task-update saved locally with rowId:", rowId);
  return rowId;
}

export async function saveUserDocumentAttachment(doc) {
  const fileUris = [];
  if (doc?.photoUri) fileUris.push(doc.photoUri);

  const rowId = await insertOfflineEvent({
    eventType: "user-document",
    orgId: doc?.orgId,
    userId: doc?.userId,
    entityRef: doc?.projectId || doc?.targetUserId || null,
    payload: doc,
    fileUris,
  });

  console.log("[DB] user-document saved locally with rowId:", rowId);
  return rowId;
}

/* ------------------------------------------------------------------ */
/*  BIOMETRICS MODULE SAVES                                            */
/* ------------------------------------------------------------------ */
/**
 * If your onboarding screen wants to save directly via database.js
 * (instead of its own insertOfflineEvent), use this helper.
 */
export async function saveBiometricEnrollment(enrollment) {
  // enrollment: { orgId, userId, targetUserId, groupId?, profilePhotoUri, biometricPhotoUris:[...], ... }
  const fileUris = [];
  if (enrollment?.profilePhotoUri) fileUris.push(enrollment.profilePhotoUri);
  const bios = Array.isArray(enrollment?.biometricPhotoUris)
    ? enrollment.biometricPhotoUris
    : [];
  for (const u of bios) if (u) fileUris.push(u);

  const rowId = await insertOfflineEvent({
    eventType: "biometric-enroll",
    orgId: enrollment?.orgId,
    userId: enrollment?.userId,
    entityRef: enrollment?.targetUserId || null,
    payload: enrollment,
    fileUris,
  });

  console.log("[DB] biometric-enroll saved locally with rowId:", rowId);
  return rowId;
}

/* ------------------------------------------------------------------ */
/*  COMPAT EXPORTS (so existing screens don’t break)                   */
/* ------------------------------------------------------------------ */

export const saveProjectNote = saveProjectUpdate;
export const saveTaskNote = saveTaskUpdate;
export const saveUserDocument = saveUserDocumentAttachment;

/* ------------------------------------------------------------------ */
/*  DB VIEWER / DEBUG HELPERS                                          */
/* ------------------------------------------------------------------ */

export async function listOfflineEvents(limit = 50) {
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT id, eventType, orgId, userId, entityRef, syncStatus, serverStage, errorText,
            createdAt, updatedAt, payloadJson, fileUrisJson
     FROM offline_events
     ORDER BY id DESC
     LIMIT ?`,
    [limit],
  );

  return (rows || []).map((r) => {
    let payloadPreview = null;
    try {
      const obj = JSON.parse(r.payloadJson || "{}");
      payloadPreview = {
        projectId: obj.projectId ?? obj?.batch?.projectId ?? null,
        taskId: obj.taskId ?? obj?.batch?.taskId ?? null,
        groupId: obj.groupId ?? obj?.batch?.groupId ?? null,
        targetUserId: obj.targetUserId ?? null,
        note: obj.note ?? obj?.batch?.note ?? null,
        title: obj.title ?? null,
      };
    } catch {
      payloadPreview = null;
    }

    return { ...r, payloadPreview };
  });
}

export async function getPendingEvents(limit = 50) {
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM offline_events
     WHERE syncStatus = 'pending'
     ORDER BY createdAt ASC
     LIMIT ?`,
    [limit],
  );
  return rows || [];
}

export async function markEventSynced(id) {
  const db = await getDb();
  const updatedAt = nowIso();
  await db.runAsync(
    `UPDATE offline_events
     SET syncStatus='synced',
         serverStage='received',
         errorText=NULL,
         updatedAt=?
     WHERE id=?`,
    [updatedAt, id],
  );
}

export async function markEventApplied(id) {
  const db = await getDb();
  const updatedAt = nowIso();
  await db.runAsync(
    `UPDATE offline_events
     SET syncStatus='synced',
         serverStage='applied',
         errorText=NULL,
         updatedAt=?
     WHERE id=?`,
    [updatedAt, id],
  );
}

export async function markEventFailed(id, errorText) {
  const db = await getDb();
  const updatedAt = nowIso();
  await db.runAsync(
    `UPDATE offline_events
     SET syncStatus='failed',
         errorText=?,
         updatedAt=?
     WHERE id=?`,
    [String(errorText || "Unknown error"), updatedAt, id],
  );
}

export async function resetFailedToPending() {
  const db = await getDb();
  const updatedAt = nowIso();
  await db.runAsync(
    `UPDATE offline_events
     SET syncStatus='pending',
         errorText=NULL,
         updatedAt=?
     WHERE syncStatus='failed'`,
    [updatedAt],
  );
}

export async function countEventsByType() {
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT eventType, COUNT(*) as count
     FROM offline_events
     GROUP BY eventType
     ORDER BY count DESC`,
  );
  return rows || [];
}

/* ------------------------------------------------------------------ */
/*  VEHICLES / ASSETS MODULE SAVES                                     */
/* ------------------------------------------------------------------ */

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
    source = "disc-scan",
    discRaw = null,
  } = vehicle || {};

  if (!regNumber || !make) {
    throw new Error("Vehicle requires regNumber and make");
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
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  const rowId = await insertOfflineEvent({
    eventType: "vehicle-create",
    orgId,
    userId,
    entityRef: regNumber, // for dedupe
    payload,
    fileUris: [],
  });

  console.log("[DB] vehicle-create saved locally with rowId:", rowId);
  return rowId;
}

export async function saveVehicleTrip(trip) {
  const fileUris = [];
  if (trip?.photoUri) fileUris.push(trip.photoUri);
  if (trip?.odometerPhotoUri) fileUris.push(trip.odometerPhotoUri);

  const rowId = await insertOfflineEvent({
    eventType: "vehicle-trip",
    orgId: trip?.orgId,
    userId: trip?.userId,
    entityRef: trip?.regNumber || null,
    payload: trip,
    fileUris,
  });

  console.log("[DB] vehicle-trip saved locally with rowId:", rowId);
  return rowId;
}

export async function saveVehiclePurchase(purchase) {
  const fileUris = [];
  if (purchase?.odometerPhotoUri) fileUris.push(purchase.odometerPhotoUri);

  const rowId = await insertOfflineEvent({
    eventType: "vehicle-purchase",
    orgId: purchase?.orgId,
    userId: purchase?.userId,
    entityRef: purchase?.regNumber || null,
    payload: purchase,
    fileUris,
  });

  console.log("[DB] vehicle-purchase saved locally with rowId:", rowId);
  return rowId;
}

export async function saveVehicleLog(log) {
  const fileUris = [];
  if (log?.photoUri) fileUris.push(log.photoUri);

  const rowId = await insertOfflineEvent({
    eventType: "vehicle-log",
    orgId: log?.orgId,
    userId: log?.userId,
    entityRef: log?.regNumber || null,
    payload: log,
    fileUris,
  });

  console.log("[DB] vehicle-log saved locally with rowId:", rowId);
  return rowId;
}

export async function saveAssetCreate(asset) {
  const rowId = await insertOfflineEvent({
    eventType: "asset-create",
    orgId: asset?.orgId,
    userId: asset?.userId,
    entityRef: asset?.assetCode || null,
    payload: asset,
    fileUris: [],
  });

  console.log("[DB] asset-create saved locally with rowId:", rowId);
  return rowId;
}

export async function saveAssetLog(log) {
  const fileUris = [];
  if (log?.photoUri) fileUris.push(log.photoUri);

  const rowId = await insertOfflineEvent({
    eventType: "asset-log",
    orgId: log?.orgId,
    userId: log?.userId,
    entityRef: log?.assetCode || null,
    payload: log,
    fileUris,
  });

  console.log("[DB] asset-log saved locally with rowId:", rowId);
  return rowId;
}

/* ------------------------------------------------------------------ */
/*  CLOCKING MODULE SAVES                                              */
/* ------------------------------------------------------------------ */
/**
 * Save a clocking batch (header + people) into offline_events outbox.
 *
 * batch: { orgId, projectId?, taskId?, groupId, clockType, note, createdAt, updatedAt, capturedByUserId? }
 * people: [{ userId, name, method, status, note, manualPhotoUri? }]
 */
export async function saveClockBatch(batch, people) {
  const safeBatch = batch || {};
  const safePeople = Array.isArray(people) ? people : [];

  const fileUris = [];
  for (const p of safePeople) {
    if (p?.manualPhotoUri) fileUris.push(p.manualPhotoUri);
  }

  const payload = {
    batch: {
      orgId: safeBatch.orgId ?? null,
      projectId: safeBatch.projectId ?? null,
      taskId: safeBatch.taskId ?? null,
      groupId: safeBatch.groupId ?? null,
      clockType: safeBatch.clockType ?? null,
      note: safeBatch.note ?? "",
      createdAt: safeBatch.createdAt ?? nowIso(),
      updatedAt: safeBatch.updatedAt ?? nowIso(),
    },
    people: safePeople.map((p) => ({
      userId: p?.userId ?? null,
      name: p?.name ?? "",
      method: p?.method ?? "list",
      status: p?.status ?? "present",
      note: p?.note ?? "",
      manualPhotoUri: p?.manualPhotoUri ?? null,
    })),
  };

  const rowId = await insertOfflineEvent({
    eventType: "clock-batch-v2",
    orgId: safeBatch.orgId,
    userId: safeBatch?.capturedByUserId || safeBatch?.userId || null,
    entityRef:
      safeBatch?.groupId || safeBatch?.taskId || safeBatch?.projectId || null,
    payload,
    fileUris,
  });

  console.log("[DB] clock-batch saved locally with rowId:", rowId);
  return rowId;
}
