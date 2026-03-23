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
      await db.execAsync(`PRAGMA journal_mode = WAL;`);
      await ensureOfflineEventsSchema(db);
      await ensureDocumentReadsSchema(db);
      await ensureOfflineDocumentsSchema(db);
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
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS offline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventType TEXT NOT NULL,
      orgId TEXT,
      userId TEXT,
      entityRef TEXT,
      payloadJson TEXT NOT NULL,
      fileUrisJson TEXT NOT NULL,
      syncStatus TEXT NOT NULL DEFAULT 'pending',
      serverStage TEXT,
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
    console.log("[DB] schema guard warning (offline_events)", e);
  }
}

async function ensureDocumentReadsSchema(db) {
  await db.execAsync(`
  CREATE TABLE IF NOT EXISTS document_reads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    orgId TEXT,
    userId TEXT,
    documentId TEXT NOT NULL,
    categoryId TEXT,
    title TEXT,
    type TEXT,
    docUpdatedAt TEXT,
    firstReadAt TEXT NOT NULL,
    lastReadAt TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    syncStatus TEXT NOT NULL DEFAULT 'pending'
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_document_reads_unique
    ON document_reads(userId, documentId);

  CREATE INDEX IF NOT EXISTS idx_document_reads_user
    ON document_reads(userId, firstReadAt);

  CREATE INDEX IF NOT EXISTS idx_document_reads_document
    ON document_reads(documentId, firstReadAt);

  CREATE INDEX IF NOT EXISTS idx_document_reads_sync
    ON document_reads(syncStatus, updatedAt);
`);

  try {
    const cols = await db.getAllAsync(`PRAGMA table_info(document_reads);`);
    const colNames = new Set((cols || []).map((c) => c?.name).filter(Boolean));

    const addCol = async (name, ddl) => {
      if (!colNames.has(name)) {
        await db.execAsync(`ALTER TABLE document_reads ADD COLUMN ${ddl};`);
      }
    };

    await addCol("orgId", "orgId TEXT");
    await addCol("userId", "userId TEXT");
    await addCol("documentId", "documentId TEXT");
    await addCol("categoryId", "categoryId TEXT");
    await addCol("title", "title TEXT");
    await addCol("type", "type TEXT");
    await addCol("docUpdatedAt", "docUpdatedAt TEXT");
    await addCol("firstReadAt", "firstReadAt TEXT");
    await addCol("lastReadAt", "lastReadAt TEXT");
    await addCol("createdAt", "createdAt TEXT");
    await addCol("updatedAt", "updatedAt TEXT");
    await addCol("syncStatus", "syncStatus TEXT NOT NULL DEFAULT 'pending'");
  } catch (e) {
    console.log("[DB] schema guard warning (document_reads)", e);
  }
}

async function ensureOfflineDocumentsSchema(db) {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS offline_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      documentId TEXT NOT NULL,
      title TEXT,
      folder TEXT,
      channel TEXT,
      updatedAt TEXT,
      createdAt TEXT,
      hasFile INTEGER NOT NULL DEFAULT 0,
      offlineSaved INTEGER NOT NULL DEFAULT 0,
      offlineStatus TEXT,
      offlineUri TEXT,
      offlineFilename TEXT,
      offlineMimeType TEXT,
      offlineTitle TEXT,
      offlineCheckedAt TEXT,
      latestJson TEXT,
      tagsJson TEXT,
      syncedAt TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_offline_documents_unique
      ON offline_documents(documentId);

    CREATE INDEX IF NOT EXISTS idx_offline_documents_status
      ON offline_documents(offlineStatus, offlineCheckedAt);

    CREATE INDEX IF NOT EXISTS idx_offline_documents_folder
      ON offline_documents(folder, title);
  `);

  try {
    const cols = await db.getAllAsync(`PRAGMA table_info(offline_documents);`);
    const colNames = new Set((cols || []).map((c) => c?.name).filter(Boolean));

    const addCol = async (name, ddl) => {
      if (!colNames.has(name)) {
        await db.execAsync(`ALTER TABLE offline_documents ADD COLUMN ${ddl};`);
      }
    };

    await addCol("documentId", "documentId TEXT");
    await addCol("title", "title TEXT");
    await addCol("folder", "folder TEXT");
    await addCol("channel", "channel TEXT");
    await addCol("updatedAt", "updatedAt TEXT");
    await addCol("createdAt", "createdAt TEXT");
    await addCol("hasFile", "hasFile INTEGER NOT NULL DEFAULT 0");
    await addCol("offlineSaved", "offlineSaved INTEGER NOT NULL DEFAULT 0");
    await addCol("offlineStatus", "offlineStatus TEXT");
    await addCol("offlineUri", "offlineUri TEXT");
    await addCol("offlineFilename", "offlineFilename TEXT");
    await addCol("offlineMimeType", "offlineMimeType TEXT");
    await addCol("offlineTitle", "offlineTitle TEXT");
    await addCol("offlineCheckedAt", "offlineCheckedAt TEXT");
    await addCol("latestJson", "latestJson TEXT");
    await addCol("tagsJson", "tagsJson TEXT");
    await addCol("syncedAt", "syncedAt TEXT NOT NULL DEFAULT ''");
  } catch (e) {
    console.log("[DB] schema guard warning (offline_documents)", e);
  }
}

export async function initDatabase() {
  await getDb();
  console.log(
    "[DB] initDatabase complete (offline_events + document_reads + offline_documents ready)",
  );
  return true;
}

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
/*  DOCUMENT READS                                                     */
/* ------------------------------------------------------------------ */

export async function saveDocumentRead(read) {
  const db = await getDb();

  const orgId = read?.orgId ?? null;
  const userId = read?.userId ?? null;
  const documentId = String(read?.documentId || "").trim();
  const categoryId = read?.categoryId ?? null;
  const title = read?.title ?? null;
  const type = read?.type ?? null;
  const docUpdatedAt = read?.docUpdatedAt ?? null;
  const readAt = read?.readAt || nowIso();
  const createdAt = read?.createdAt || nowIso();
  const updatedAt = read?.updatedAt || nowIso();
  const syncStatus = read?.syncStatus || "pending";

  if (!documentId) {
    throw new Error("documentId is required");
  }

  const existing = await db.getFirstAsync(
    `SELECT id, firstReadAt FROM document_reads
     WHERE userId IS ? AND documentId = ?
     LIMIT 1`,
    [userId ?? null, documentId],
  );

  if (existing?.id) {
    await db.runAsync(
      `UPDATE document_reads
       SET orgId = ?,
           categoryId = ?,
           title = ?,
           type = ?,
           docUpdatedAt = ?,
           lastReadAt = ?,
           updatedAt = ?,
           syncStatus = ?
       WHERE id = ?`,
      [
        orgId,
        categoryId,
        title,
        type,
        docUpdatedAt,
        readAt,
        updatedAt,
        syncStatus,
        existing.id,
      ],
    );

    return existing.id;
  }

  const result = await db.runAsync(
    `INSERT INTO document_reads
      (orgId, userId, documentId, categoryId, title, type, docUpdatedAt, firstReadAt, lastReadAt, createdAt, updatedAt, syncStatus)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orgId,
      userId,
      documentId,
      categoryId,
      title,
      type,
      docUpdatedAt,
      readAt,
      readAt,
      createdAt,
      updatedAt,
      syncStatus,
    ],
  );

  return result?.lastInsertRowId ?? null;
}

export async function listDocumentReads(userId = null) {
  const db = await getDb();

  if (userId) {
    const rows = await db.getAllAsync(
      `SELECT *
       FROM document_reads
       WHERE userId = ?
       ORDER BY updatedAt DESC`,
      [String(userId)],
    );
    return rows || [];
  }

  const rows = await db.getAllAsync(
    `SELECT *
     FROM document_reads
     ORDER BY updatedAt DESC`,
  );
  return rows || [];
}

export async function getDocumentReadMap(userId = null) {
  const rows = await listDocumentReads(userId);
  const map = {};

  for (const row of rows) {
    const documentId = String(row?.documentId || "").trim();
    if (!documentId) continue;

    map[documentId] = {
      firstReadAt: row?.firstReadAt || null,
      lastReadAt: row?.lastReadAt || row?.firstReadAt || null,
    };
  }

  return map;
}

export async function getDocumentRead(documentId, userId = null) {
  const db = await getDb();
  const safeDocumentId = String(documentId || "").trim();
  if (!safeDocumentId) return null;

  if (userId) {
    const row = await db.getFirstAsync(
      `SELECT *
       FROM document_reads
       WHERE userId = ? AND documentId = ?
       LIMIT 1`,
      [String(userId), safeDocumentId],
    );
    return row || null;
  }

  const row = await db.getFirstAsync(
    `SELECT *
     FROM document_reads
     WHERE documentId = ?
     LIMIT 1`,
    [safeDocumentId],
  );
  return row || null;
}

/* ------------------------------------------------------------------ */
/*  OFFLINE DOCUMENT CACHE                                             */
/* ------------------------------------------------------------------ */

export async function upsertOfflineDocumentCache(row) {
  const db = await getDb();

  const documentId = String(
    row?.id || row?._id || row?.documentId || "",
  ).trim();
  if (!documentId) return null;

  const syncedAt = nowIso();

  const existing = await db.getFirstAsync(
    `SELECT id FROM offline_documents WHERE documentId = ? LIMIT 1`,
    [documentId],
  );

  const values = [
    documentId,
    row?.title ?? null,
    row?.folder ?? null,
    row?.channel ?? null,
    row?.updatedAt ?? null,
    row?.createdAt ?? null,
    row?.hasFile ? 1 : 0,
    row?.offlineSaved ? 1 : 0,
    row?.offlineStatus ?? null,
    row?.offlineUri ?? null,
    row?.offlineFilename ?? null,
    row?.offlineMimeType ?? null,
    row?.offlineTitle ?? null,
    row?.offlineCheckedAt ?? null,
    safeJson(row?.latest ?? null),
    safeJsonArray(row?.tags ?? []),
    syncedAt,
  ];

  if (existing?.id) {
    await db.runAsync(
      `UPDATE offline_documents
       SET documentId = ?,
           title = ?,
           folder = ?,
           channel = ?,
           updatedAt = ?,
           createdAt = ?,
           hasFile = ?,
           offlineSaved = ?,
           offlineStatus = ?,
           offlineUri = ?,
           offlineFilename = ?,
           offlineMimeType = ?,
           offlineTitle = ?,
           offlineCheckedAt = ?,
           latestJson = ?,
           tagsJson = ?,
           syncedAt = ?
       WHERE id = ?`,
      [...values, existing.id],
    );

    return existing.id;
  }

  const result = await db.runAsync(
    `INSERT INTO offline_documents
      (documentId, title, folder, channel, updatedAt, createdAt, hasFile, offlineSaved,
       offlineStatus, offlineUri, offlineFilename, offlineMimeType, offlineTitle,
       offlineCheckedAt, latestJson, tagsJson, syncedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    values,
  );

  return result?.lastInsertRowId ?? null;
}

export async function upsertOfflineDocumentCacheBatch(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const ids = [];

  for (const row of safeRows) {
    try {
      const id = await upsertOfflineDocumentCache(row);
      if (id) ids.push(id);
    } catch (e) {
      console.log("[DB] failed to upsert offline document cache row", e);
    }
  }

  return ids;
}

export async function listOfflineDocuments() {
  const db = await getDb();
  const rows = await db.getAllAsync(
    `SELECT *
     FROM offline_documents
     ORDER BY folder ASC, title ASC`,
  );

  return (rows || []).map((row) => {
    let latest = null;
    let tags = [];

    try {
      latest = row?.latestJson ? JSON.parse(row.latestJson) : null;
    } catch {
      latest = null;
    }

    try {
      tags = row?.tagsJson ? JSON.parse(row.tagsJson) : [];
    } catch {
      tags = [];
    }

    return {
      id: row?.documentId || "",
      _id: row?.documentId || "",
      title: row?.title || "",
      folder: row?.folder || "",
      channel: row?.channel || "",
      updatedAt: row?.updatedAt || null,
      createdAt: row?.createdAt || null,
      hasFile: !!row?.hasFile,
      offlineSaved: !!row?.offlineSaved,
      offlineStatus: row?.offlineStatus || "not-downloaded",
      offlineUri: row?.offlineUri || "",
      offlineFilename: row?.offlineFilename || "",
      offlineMimeType: row?.offlineMimeType || "",
      offlineTitle: row?.offlineTitle || "",
      offlineCheckedAt: row?.offlineCheckedAt || null,
      latest,
      tags,
      syncedAt: row?.syncedAt || null,
    };
  });
}

export async function getOfflineDocumentCacheMap() {
  const rows = await listOfflineDocuments();
  const map = {};

  for (const row of rows) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    map[id] = row;
  }

  return map;
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

export async function saveBiometricEnrollment(enrollment) {
  const fileUris = [];
  if (enrollment?.profilePhotoUri) fileUris.push(enrollment.profilePhotoUri);

  const bios = Array.isArray(enrollment?.biometricPhotoUris)
    ? enrollment.biometricPhotoUris
    : [];

  for (const u of bios) {
    if (u) fileUris.push(u);
  }

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
/*  INSPECTIONS MODULE SAVES                                           */
/* ------------------------------------------------------------------ */

export async function saveInspectionRun(run) {
  const payload = run?.payload || run || {};
  const fileUris = [];

  const signatureFileUri = payload?.signoff?.signatureFileUri || null;
  if (signatureFileUri) {
    fileUris.push(signatureFileUri);
  }

  const items = Array.isArray(payload?.items) ? payload.items : [];
  for (const item of items) {
    const photoUri =
      item?.photoUri ||
      item?.evidence?.photoUrl ||
      item?.evidence?.photoUri ||
      null;

    if (photoUri) fileUris.push(photoUri);
  }

  const dedupedFileUris = [...new Set(fileUris.filter(Boolean))];

  const rowId = await insertOfflineEvent({
    eventType: "inspection-run",
    orgId: run?.orgId ?? payload?.orgId ?? null,
    userId: run?.userId ?? payload?.userId ?? null,
    entityRef: run?.formId ?? payload?.formId ?? null,
    payload,
    fileUris: dedupedFileUris,
  });

  console.log("[DB] inspection-run saved locally with rowId:", rowId);
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
        projectId:
          obj.projectId ??
          obj?.batch?.projectId ??
          obj?.links?.projectId ??
          null,
        taskId: obj.taskId ?? obj?.batch?.taskId ?? obj?.links?.taskId ?? null,
        milestoneId: obj.milestoneId ?? obj?.links?.milestoneId ?? null,
        groupId: obj.groupId ?? obj?.batch?.groupId ?? null,
        targetUserId: obj.targetUserId ?? null,
        formId: obj.formId ?? null,
        note: obj.note ?? obj?.batch?.note ?? obj?.overallNote ?? null,
        title: obj.title ?? obj?.formName ?? obj?.formTitle ?? null,
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
    entityRef: regNumber,
    payload,
    fileUris: [],
  });

  console.log("[DB] vehicle-create saved locally with rowId:", rowId);
  return rowId;
}

export async function saveVehicleTrip(trip) {
  const fileUris = [];

  if (trip?.odometerStartPhotoUri) fileUris.push(trip.odometerStartPhotoUri);
  if (trip?.odometerEndPhotoUri) fileUris.push(trip.odometerEndPhotoUri);
  if (trip?.odometerPhotoUri) fileUris.push(trip.odometerPhotoUri);
  if (trip?.photoUri) fileUris.push(trip.photoUri);

  const dedupedFileUris = [...new Set(fileUris.filter(Boolean))];

  const rowId = await insertOfflineEvent({
    eventType: "vehicle-trip",
    orgId: trip?.orgId,
    userId: trip?.userId,
    entityRef: trip?.regNumber || null,
    payload: trip,
    fileUris: dedupedFileUris,
  });

  console.log("[DB] vehicle-trip saved locally with rowId:", rowId);
  return rowId;
}

export async function saveVehiclePurchase(purchase) {
  const fileUris = [];

  if (purchase?.slipPhotoUri) fileUris.push(purchase.slipPhotoUri);
  if (purchase?.odometerPhotoUri) fileUris.push(purchase.odometerPhotoUri);
  if (purchase?.photoUri) fileUris.push(purchase.photoUri);

  const dedupedFileUris = [...new Set(fileUris.filter(Boolean))];

  const rowId = await insertOfflineEvent({
    eventType: "vehicle-purchase",
    orgId: purchase?.orgId,
    userId: purchase?.userId,
    entityRef: purchase?.regNumber || null,
    payload: purchase,
    fileUris: dedupedFileUris,
  });

  console.log("[DB] vehicle-purchase saved locally with rowId:", rowId);
  return rowId;
}

export async function saveVehicleLog(log) {
  const fileUris = [];
  if (log?.photoUri) fileUris.push(log.photoUri);

  const dedupedFileUris = [...new Set(fileUris.filter(Boolean))];

  const rowId = await insertOfflineEvent({
    eventType: "vehicle-log",
    orgId: log?.orgId,
    userId: log?.userId,
    entityRef: log?.regNumber || null,
    payload: log,
    fileUris: dedupedFileUris,
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

  const dedupedFileUris = [...new Set(fileUris.filter(Boolean))];

  const rowId = await insertOfflineEvent({
    eventType: "asset-log",
    orgId: log?.orgId,
    userId: log?.userId,
    entityRef: log?.assetCode || null,
    payload: log,
    fileUris: dedupedFileUris,
  });

  console.log("[DB] asset-log saved locally with rowId:", rowId);
  return rowId;
}

/* ------------------------------------------------------------------ */
/*  CLOCKING MODULE SAVES                                              */
/* ------------------------------------------------------------------ */

export async function saveClockBatch(batch, people) {
  const safeBatch = batch || {};
  const safePeople = Array.isArray(people) ? people : [];

  const fileUris = [];
  for (const p of safePeople) {
    if (p?.manualPhotoUri) fileUris.push(p.manualPhotoUri);
  }

  const loc =
    safeBatch?.location && typeof safeBatch.location === "object"
      ? safeBatch.location
      : null;

  const nLat = loc?.lat ?? loc?.latitude ?? null;
  const nLng = loc?.lng ?? loc?.longitude ?? null;
  const nAcc = loc?.acc ?? loc?.accuracy ?? null;

  const hasCoords =
    Number.isFinite(Number(nLat)) && Number.isFinite(Number(nLng));

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
      ...(hasCoords
        ? {
            location: {
              lat: Number(nLat),
              lng: Number(nLng),
              ...(Number.isFinite(Number(nAcc)) ? { acc: Number(nAcc) } : {}),
            },
          }
        : {}),
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
