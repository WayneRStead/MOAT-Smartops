// core-backend/routes/mobile.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const crypto = require("crypto");

// ✅ GridFS support (MongoDB file storage)
const { GridFSBucket } = require("mongodb");

// ✅ Auth middleware
const {
  requireAuth,
  resolveOrgContext,
  requireOrg,
} = require("../middleware/auth");

/**
 * 🔎 Router version header so we can prove Render is running THIS file.
 * Change the string if you ever need to confirm another deploy.
 */
const ROUTER_VERSION = "mobile-router-v2026-02-26-01"; // bump so you can confirm deploy

router.use((req, res, next) => {
  res.setHeader("x-mobile-router-version", ROUTER_VERSION);
  next();
});

// ✅ Multer for multipart/form-data (optional)
let multer = null;
try {
  // eslint-disable-next-line global-require
  multer = require("multer");
} catch (e) {
  multer = null;
}

let Org = null;
try {
  Org = require("../models/Org");
} catch {}

/* -----------------------------
   Helpers
------------------------------*/
function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function getMobileOfflineBucket() {
  const db = mongoose.connection?.db;
  if (!db) return null;
  return new GridFSBucket(db, { bucketName: "mobileOffline" });
}

function getDocumentsBucket() {
  const db = mongoose.connection?.db;
  if (!db) return null;
  return new GridFSBucket(db, { bucketName: "documents" });
}

// Small helper to run Express middleware manually (for optional auth)
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    try {
      fn(req, res, (err) => {
        if (err) return reject(err);
        return resolve();
      });
    } catch (e) {
      return reject(e);
    }
  });
}

// Copies a GridFS file from bucket A -> bucket B and returns the NEW fileId (ObjectId)
async function copyGridFSFile({
  fromBucket,
  toBucket,
  fromFileId,
  metadata = {},
  filename = null,
  contentType = null,
}) {
  if (!fromBucket) throw new Error("fromBucket missing");
  if (!toBucket) throw new Error("toBucket missing");

  const srcId = mongoose.isValidObjectId(String(fromFileId))
    ? new mongoose.Types.ObjectId(String(fromFileId))
    : null;

  if (!srcId) throw new Error("Invalid source fileId");

  // Find source file to inherit details when possible
  const srcFiles = await fromBucket.find({ _id: srcId }).limit(1).toArray();
  if (!srcFiles?.length) throw new Error("Source file not found in GridFS");

  const src = srcFiles[0];
  const outName = filename || src.filename || `copied_${Date.now()}`;
  const outType = contentType || src.contentType || "application/octet-stream";

  const uploadStream = toBucket.openUploadStream(outName, {
    contentType: outType,
    metadata,
  });

  await new Promise((resolve, reject) => {
    const dl = fromBucket.openDownloadStream(srcId);
    dl.on("error", reject);
    uploadStream.on("error", reject);
    uploadStream.on("finish", resolve);
    dl.pipe(uploadStream);
  });

  return uploadStream.id; // ObjectId
}

async function saveBuffersToGridFS({ orgId, userId, files }) {
  const bucket = getMobileOfflineBucket();
  if (!bucket) throw new Error("MongoDB not ready for file uploads");

  const out = [];

  for (const f of files || []) {
    if (!f?.buffer) continue;

    // ✅ key that allows <img> loading without auth token
    const downloadKey = crypto.randomBytes(16).toString("hex");

    const filename = `${Date.now()}_${Math.random().toString(16).slice(2)}_${String(
      f.originalname || "upload.bin",
    )}`;

    const meta = {
      orgId: String(orgId || ""),
      userId: String(userId || ""),
      originalname: f.originalname || null,
      mimetype: f.mimetype || null,
      size: f.size || null,
      kind: "offline-event-file",
      createdAt: new Date().toISOString(),
      downloadKey,
    };

    const uploadStream = bucket.openUploadStream(filename, {
      contentType: f.mimetype || "application/octet-stream",
      metadata: meta,
    });

    await new Promise((resolve, reject) => {
      uploadStream.on("finish", resolve);
      uploadStream.on("error", reject);
      uploadStream.end(f.buffer);
    });

    out.push({
      fileId: String(uploadStream.id),
      filename,
      contentType: f.mimetype || null,
      size: f.size || null,
      downloadKey,
    });
  }

  return out;
}

function canApproveBiometrics(user) {
  const roles = []
    .concat(user?.roles || [])
    .concat(user?.role ? [user.role] : [])
    .map((r) =>
      String(r || "")
        .toLowerCase()
        .trim(),
    )
    .filter(Boolean);

  const allow = new Set([
    "admin",
    "superadmin",
    "owner",
    "manager",
    "project-manager",
    "pm",
  ]);
  return roles.some((r) => allow.has(r));
}

function boolish(v) {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on";
}

function toObjectIdOrNull(v) {
  const s = String(v || "").trim();
  return mongoose.isValidObjectId(s) ? new mongoose.Types.ObjectId(s) : null;
}

function asIsoOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  // eslint-disable-next-line no-restricted-globals
  return isNaN(+d) ? null : d.toISOString();
}

function parseDateSafe(v, fallback = new Date()) {
  const d = new Date(v);
  // eslint-disable-next-line no-restricted-globals
  return isNaN(+d) ? fallback : d;
}

/**
 * ✅ “Single source of truth” activity log adapter
 * We try to write into a canonical ActivityLog-style model (if present),
 * so TaskDetail/CSV/KMZ all consume the same log entries as web-created activities.
 *
 * We don’t assume the exact model name; we attempt a few common ones.
 * If none exist, we fall back to the legacy Task.actualDurationLog + Task.attachments.
 */
function tryRequireAny(paths) {
  for (const p of paths) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      return require(p);
    } catch {}
  }
  return null;
}

const ActivityLogModel = tryRequireAny([
  "../models/ActivityLog",
  "../models/TaskActivityLog",
  "../models/TaskActivity",
  "../models/TaskEvent",
  "../models/Activity",
]);

/**
 * Build attachment records that are browser-loadable without auth token (signed key URL).
 */
function buildMobileOfflineAttachments({
  uploadedFiles,
  at,
  req,
  offlineEventId,
  noteText,
}) {
  const out = [];
  for (const f of uploadedFiles || []) {
    const fid = String(f?.fileId || "").trim();
    if (!mongoose.isValidObjectId(fid)) continue;

    const k = String(f?.downloadKey || "").trim();
    const apiUrl = k
      ? `/api/mobile/offline-files/${fid}?k=${encodeURIComponent(k)}`
      : `/api/mobile/offline-files/${fid}`;

    out.push({
      filename: f.filename || "offline_upload",
      url: apiUrl,
      mobileUrl: apiUrl,
      mime: f.contentType || "",
      contentType: f.contentType || "",
      size: typeof f.size === "number" ? f.size : undefined,
      uploadedBy:
        req.user?.name || req.user?.email || String(req.user?._id || ""),
      uploadedAt: at,
      note: noteText || "",
      storage: "mobileOffline",
      fileId: new mongoose.Types.ObjectId(fid),
      sourceOfflineEventId: offlineEventId,
    });
  }
  return out;
}

/**
 * Idempotently upsert an activity log entry into the canonical model, if present.
 * Uses sourceOfflineEventId for dedupe.
 */
async function upsertCanonicalActivityLog({
  orgId,
  taskId,
  projectId,
  milestoneId,
  at,
  action,
  noteText,
  attachments,
  req,
  offlineEventId,
  payload,
}) {
  if (!ActivityLogModel?.findOneAndUpdate)
    return { ok: false, reason: "no_model" };

  const actorUserId =
    req.user?._id && mongoose.isValidObjectId(String(req.user._id))
      ? new mongoose.Types.ObjectId(String(req.user._id))
      : undefined;

  // We keep the document shape flexible; different projects name fields differently.
  // The goal is: TaskDetail/exports see the same collection they already query.
  const setOnInsert = {
    orgId,
    taskId,
    projectId: projectId || undefined,
    milestoneId: milestoneId || undefined,
    at,
    createdAt: new Date(),
    source: "mobile-offline",
    sourceOfflineEventId: offlineEventId,
  };

  const set = {
    updatedAt: new Date(),
    note: noteText || String(payload?.note || "").trim() || "",
    action: action || (attachments?.length ? "photo" : "note"),
    attachments: Array.isArray(attachments) ? attachments : [],
    actor: {
      userId: actorUserId,
      name: req.user?.name || undefined,
      email: req.user?.email || undefined,
      sub: req.user?.sub || req.user?.id || undefined,
    },
  };

  const query = {
    orgId,
    taskId,
    sourceOfflineEventId: offlineEventId,
  };

  // Some schemas might not have this field; still safe to include in update payload.
  // If Mongo strict schema rejects unknown fields, this will throw — and we’ll fall back.
  const updated = await ActivityLogModel.findOneAndUpdate(
    query,
    { $setOnInsert: setOnInsert, $set: set },
    { upsert: true, new: true },
  );

  return { ok: true, doc: updated };
}

/* -----------------------------------------------------------------------------------
   ✅ PUBLIC DOWNLOAD GRIDFS FILE (mobileOffline bucket)
   GET/HEAD /api/mobile/offline-files/:fileId?k=<downloadKey>
----------------------------------------------------------------------------------- */
router.all("/offline-files/:fileId", async (req, res) => {
  try {
    const bucket = getMobileOfflineBucket();
    if (!bucket) return res.status(503).json({ error: "MongoDB not ready" });

    const fileIdStr = String(req.params.fileId || "").trim();
    if (!mongoose.isValidObjectId(fileIdStr)) {
      return res.status(400).json({ error: "Invalid fileId" });
    }
    const fileId = new mongoose.Types.ObjectId(fileIdStr);

    const filesColl = mongoose.connection.db.collection("mobileOffline.files");
    const fileDoc = await filesColl.findOne({ _id: fileId });
    if (!fileDoc) return res.status(404).json({ error: "File not found" });

    const key = String(req.query.k || "").trim();

    // ✅ PATH A: signed key access (no token required)
    if (
      key &&
      fileDoc?.metadata?.downloadKey &&
      key === fileDoc.metadata.downloadKey
    ) {
      res.setHeader(
        "Content-Type",
        fileDoc.contentType || "application/octet-stream",
      );
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${fileDoc.filename || "file"}"`,
      );
      res.setHeader("Cache-Control", "private, max-age=31536000");

      if (req.method === "HEAD") return res.status(200).end();
      if (req.method !== "GET")
        return res.status(405).json({ error: "Method not allowed" });

      const stream = bucket.openDownloadStream(fileId);
      stream.on("error", (err) => {
        console.error("[mobile/offline-files] stream error", err);
        if (!res.headersSent) res.status(500).end("Stream error");
      });
      return stream.pipe(res);
    }

    // ✅ PATH B: secured access (token required)
    if (!req.user || !req.user._id) {
      try {
        await runMiddleware(req, res, requireAuth);
        await runMiddleware(req, res, resolveOrgContext);
      } catch (eAuth) {
        return res.status(401).json({ error: "Missing token" });
      }
    } else {
      if (!req.orgObjectId && !req.orgId) {
        try {
          await runMiddleware(req, res, resolveOrgContext);
        } catch {}
      }
    }

    // require org context
    try {
      await runMiddleware(req, res, requireOrg);
    } catch {
      return res.status(400).json({ error: "Missing org context" });
    }

    const orgId = req.orgObjectId || req.user?.orgId;
    const orgIdStr = String(orgId || "").trim();
    if (!orgIdStr)
      return res.status(400).json({ error: "Missing org context" });

    if (String(fileDoc?.metadata?.orgId || "") !== orgIdStr) {
      return res.status(403).json({ error: "Forbidden" });
    }

    res.setHeader(
      "Content-Type",
      fileDoc.contentType || "application/octet-stream",
    );
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${fileDoc.filename || "file"}"`,
    );
    res.setHeader("Cache-Control", "private, max-age=86400");

    if (req.method === "HEAD") return res.status(200).end();
    if (req.method !== "GET")
      return res.status(405).json({ error: "Method not allowed" });

    const stream = bucket.openDownloadStream(fileId);
    stream.on("error", (err) => {
      console.error("[mobile/offline-files] stream error", err);
      if (!res.headersSent) res.status(500).end("Stream error");
    });
    return stream.pipe(res);
  } catch (e) {
    console.error("[mobile/offline-files] error", e);
    return res.status(500).json({ error: e?.message || "Download failed" });
  }
});

// ✅ Attach auth + org context for everything else in this router
router.use(requireAuth, resolveOrgContext);

/* -----------------------------
   BOOTSTRAP (NO ORG REQUIRED)
------------------------------*/
router.get("/bootstrap", async (req, res) => {
  try {
    res.setHeader("x-mobile-bootstrap", "HIT-BOOTSTRAP");
    console.log("[mobile] BOOTSTRAP HIT", new Date().toISOString());

    const user = req.user;
    if (!user?._id) return res.status(401).json({ error: "Not authenticated" });

    const orgId = user.orgId ? String(user.orgId) : null;
    if (!orgId) return res.json({ ok: true, orgs: [] });

    let orgDoc = null;
    if (Org?.findById && mongoose.isValidObjectId(orgId)) {
      orgDoc = await Org.findById(orgId).select({ name: 1 }).lean();
    }

    return res.json({
      ok: true,
      orgs: [{ _id: orgId, name: orgDoc?.name || "Organisation" }],
    });
  } catch (e) {
    console.error("[mobile/bootstrap] error", e);
    return res.status(500).json({ error: "Bootstrap failed" });
  }
});

/* -----------------------------
   WHOAMI (NO ORG REQUIRED)
------------------------------*/
router.get("/whoami", (req, res) => {
  return res.json({
    ok: true,
    routerVersion: ROUTER_VERSION,
    user: req.user || null,
    orgIdAttached: req.orgId || null,
  });
});

/* -----------------------------
   LISTS (ORG REQUIRED)
------------------------------*/
router.get("/lists", requireOrg, async (req, res) => {
  try {
    const orgId = req.orgObjectId || req.user?.orgId;

    let Project = null;
    let Task = null;
    let Milestone = null;
    let User = null;
    let Inspection = null;

    try {
      Project = require("../models/Project");
    } catch {}
    try {
      Task = require("../models/Task");
    } catch {}
    try {
      Milestone = require("../models/Milestone");
    } catch {}
    try {
      User = require("../models/User");
    } catch {}
    try {
      Inspection = require("../models/InspectionForm");
    } catch {}

    const projects = Project?.find
      ? await Project.find({ orgId, isDeleted: { $ne: true } })
          .select({ _id: 1, name: 1 })
          .lean()
      : [];

    const tasks = Task?.find
      ? await Task.find({ orgId, isDeleted: { $ne: true } })
          .select({ _id: 1, title: 1, status: 1 })
          .lean()
      : [];

    const milestones = Milestone?.find
      ? await Milestone.find({ orgId, isDeleted: { $ne: true } })
          .select({ _id: 1, name: 1 })
          .lean()
      : [];

    const users = User?.find
      ? await User.find({
          orgId,
          isDeleted: { $ne: true },
          active: { $ne: false },
        })
          .select({ _id: 1, name: 1, email: 1, role: 1, roles: 1 })
          .lean()
      : [];

    const inspections = Inspection?.find
      ? await Inspection.find({ orgId, isDeleted: { $ne: true } })
          .select({ _id: 1, name: 1, status: 1 })
          .lean()
      : [];

    return res.json({
      ok: true,
      projects,
      tasks,
      milestones,
      users,
      assets: [],
      vehicles: [],
      inspections,
      documents: [],
    });
  } catch (e) {
    console.error("[mobile/lists] error", e);
    return res.status(500).json({ error: "Failed to load lists" });
  }
});

/* -----------------------------
   OFFLINE EVENTS INGESTION (ORG REQUIRED)
   ✅ Accepts JSON OR multipart/form-data (files[])
------------------------------*/

// Model: OfflineEvent (kept inside this router for now)
const OfflineEventSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Org", index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    eventType: { type: String, index: true },
    entityRef: { type: String },
    payload: { type: Object },
    fileUris: { type: [String], default: [] }, // legacy
    uploadedFiles: { type: [Object], default: [] }, // {fileId, filename, contentType, size, downloadKey?}
    createdAtClient: { type: String },
    receivedAt: { type: Date, default: Date.now },
    appliedAt: { type: Date, default: null }, // ✅ helps debug “received but not applied”
    appliedTo: { type: Object, default: {} }, // ✅ debug: { activityLogId, taskId, ... }
  },
  { minimize: false },
);

const OfflineEvent =
  mongoose.models.OfflineEvent ||
  mongoose.model("OfflineEvent", OfflineEventSchema);

// Multer middleware (memory storage)
const upload =
  multer && typeof multer === "function"
    ? multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 15 * 1024 * 1024 },
      })
    : null;

router.post(
  "/offline-events",
  requireOrg,
  (req, res, next) => {
    if (!upload) return next();
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("multipart/form-data")) return next();
    return upload.array("files")(req, res, next);
  },
  async (req, res) => {
    try {
      const orgId = req.orgObjectId || req.user?.orgId;
      const userId = req.user?._id || null;

      const ct = String(req.headers["content-type"] || "").toLowerCase();
      const isMultipart = ct.includes("multipart/form-data");

      let eventType = "";
      let entityRef = null;
      let createdAtClient = null;
      let payload = {};
      let fileUris = [];
      let uploadedFiles = [];

      if (isMultipart) {
        eventType = String(req.body?.eventType || "unknown");
        entityRef = req.body?.entityRef ? String(req.body.entityRef) : null;
        createdAtClient = req.body?.createdAt
          ? String(req.body.createdAt)
          : null;

        payload = safeJsonParse(req.body?.payloadJson || "{}", {}) || {};
        fileUris = [];

        const files = Array.isArray(req.files) ? req.files : [];
        if (files.length) {
          uploadedFiles = await saveBuffersToGridFS({ orgId, userId, files });
        }
      } else {
        const body = req.body || {};
        eventType = String(body.eventType || "unknown");
        entityRef = body.entityRef ? String(body.entityRef) : null;
        createdAtClient = body.createdAt ? String(body.createdAt) : null;
        payload = body.payload || {};
        fileUris = Array.isArray(body.fileUris) ? body.fileUris : [];
        uploadedFiles = [];
      }

      // ✅ Normalize mobile event aliases so they behave like web “task activities”
      const eventTypeNorm = String(eventType || "")
        .trim()
        .toLowerCase();
      if (eventTypeNorm === "mobile-activity-log") eventType = "activity-log";
      if (eventTypeNorm === "task-activity") eventType = "activity-log";
      if (eventTypeNorm === "task-activity-log") eventType = "activity-log";

      const doc = await OfflineEvent.create({
        orgId,
        userId,
        eventType,
        entityRef,
        payload,
        fileUris,
        uploadedFiles,
        createdAtClient,
      });

      const appliedTo = {};

      // ✅ APPLY PROJECT UPDATES (manager note + status + optional attachments)
      if (eventType === "project-update") {
        try {
          const Project = require("../models/Project");
          const ProjectManagerNote = require("../models/ProjectManagerNote");

          const orgId2 = req.orgObjectId || req.user?.orgId;

          const projectIdStr = String(
            payload?.projectId || entityRef || "",
          ).trim();
          if (!mongoose.isValidObjectId(projectIdStr)) {
            console.warn("[project-update] invalid projectId", {
              projectIdStr,
            });
          } else if (!Project?.updateOne) {
            console.warn("[project-update] Project model missing updateOne");
          } else {
            const projectObjectId = new mongoose.Types.ObjectId(projectIdStr);

            const statusRaw =
              payload?.status != null
                ? String(payload.status).trim().toLowerCase()
                : "";

            const managerNote =
              payload?.managerNote != null
                ? String(payload.managerNote).trim()
                : "";

            const allowedStatus = new Set(["active", "paused", "closed"]);
            const status = allowedStatus.has(statusRaw) ? statusRaw : null;

            if (status) {
              await Project.updateOne(
                { _id: projectObjectId, orgId: orgId2 },
                {
                  $set: {
                    status,
                    updatedAt: new Date(),
                    updatedBy: req.user?._id || null,
                  },
                },
              );
            }

            if (managerNote) {
              const at = payload?.at ? new Date(payload.at) : new Date();
              const uf = Array.isArray(doc?.uploadedFiles)
                ? doc.uploadedFiles
                : [];

              const noteDoc = await ProjectManagerNote.create({
                orgId: orgId2,
                projectId: projectObjectId,
                status: status || statusRaw || "active",
                note: managerNote,
                at,
                author: {
                  userId: req.user?._id
                    ? new mongoose.Types.ObjectId(String(req.user._id))
                    : undefined,
                  name: req.user?.name || undefined,
                  email: req.user?.email || undefined,
                },
                uploadedFiles: uf,
                sourceOfflineEventId: doc._id,
                createdAtClient: createdAtClient || null,
              });

              appliedTo.projectManagerNoteId = String(noteDoc?._id || "");
              appliedTo.projectId = String(projectObjectId);
            }
          }
        } catch (e3) {
          console.error("[project-update] failed to apply project update", e3);
        }
      }

      // ✅ APPLY USER DOCUMENT UPLOADS INTO VAULT (Document model + documents GridFS bucket)
      if (eventType === "user-document") {
        try {
          const Document = require("../models/Document");

          const orgId2 = req.orgObjectId || req.user?.orgId;
          const actor = req.user?.sub || req.user?._id || null;

          const projectIdStr = String(
            payload?.projectId || entityRef || "",
          ).trim();
          const targetUserIdStr = String(payload?.targetUserId || "").trim();

          const projectRefId = mongoose.isValidObjectId(projectIdStr)
            ? new mongoose.Types.ObjectId(projectIdStr)
            : null;

          const targetUserRefId = mongoose.isValidObjectId(targetUserIdStr)
            ? new mongoose.Types.ObjectId(targetUserIdStr)
            : null;

          if (!projectRefId) {
            console.warn("[user-document] missing/invalid projectId", {
              projectIdStr,
            });
          } else {
            const fromBucket = getMobileOfflineBucket();
            const toBucket = getDocumentsBucket();
            if (!fromBucket || !toBucket)
              throw new Error("Mongo GridFS buckets not ready");

            const uploaded = Array.isArray(doc?.uploadedFiles)
              ? doc.uploadedFiles
              : [];
            if (!uploaded.length) {
              console.warn("[user-document] no uploadedFiles on OfflineEvent", {
                offlineEventId: String(doc?._id),
              });
            } else {
              // ✅ idempotency: if a previous sync already created a Document for this event, skip creating another
              const existing = await Document.findOne({
                orgId: orgId2,
                "latest.meta.offlineEventId": String(doc._id),
              })
                .lean()
                .catch(() => null);

              if (existing?._id) {
                appliedTo.documentId = String(existing._id);
              } else {
                const first = uploaded[0];
                const newFileId = await copyGridFSFile({
                  fromBucket,
                  toBucket,
                  fromFileId: first.fileId,
                  filename: first.filename || null,
                  contentType: first.contentType || null,
                  metadata: {
                    orgId: String(orgId2 || ""),
                    uploadedBy: actor ? String(actor) : "",
                    source: "mobile-offline-event",
                    offlineEventId: String(doc._id),
                    projectId: String(projectRefId),
                    targetUserId: targetUserRefId
                      ? String(targetUserRefId)
                      : undefined,
                  },
                });

                const fileIdStr = String(newFileId);
                const url = `/documents/files/${fileIdStr}`;

                const title = String(payload?.title || "User document").trim();
                const tag = String(payload?.tag || "").trim();

                const links = [
                  { type: "project", module: "project", refId: projectRefId },
                ];
                if (targetUserRefId) {
                  links.push({
                    type: "user",
                    module: "user",
                    refId: targetUserRefId,
                  });
                }

                const version = {
                  filename: first.filename || "file",
                  url,
                  fileId: fileIdStr,
                  mime: first.contentType || "application/octet-stream",
                  size: typeof first.size === "number" ? first.size : undefined,
                  uploadedBy: actor,
                  uploadedAt: new Date(),
                  meta: { offlineEventId: String(doc._id) },
                };

                const now = new Date();

                const body = {
                  orgId:
                    req.orgObjectId ||
                    (mongoose.Types.ObjectId.isValid(String(orgId2))
                      ? new mongoose.Types.ObjectId(String(orgId2))
                      : undefined),
                  title,
                  folder: "",
                  tags: tag ? [tag] : [],
                  links,
                  access: { visibility: "org", owners: actor ? [actor] : [] },
                  versions: [version],
                  latest: {
                    ...version,
                    meta: { offlineEventId: String(doc._id) },
                  },
                  createdAt: now,
                  updatedAt: now,
                  createdBy: actor,
                  updatedBy: actor,
                };

                const docCreated = await Document.create(body);
                appliedTo.documentId = String(docCreated?._id || "");
              }
            }
          }
        } catch (e4) {
          console.error("[user-document] failed to apply vault document", e4);
        }
      }

      // ✅ APPLY TASK UPDATES (Task.status + ManagerNote + TaskMilestone.status)
      if (eventType === "task-update") {
        try {
          const Task = require("../models/Task");
          const TaskMilestone = require("../models/TaskMilestone");
          const ManagerNote = require("../models/ManagerNote");

          const orgIdRaw = req.orgObjectId || req.user?.orgId || null;
          const orgIdStr = orgIdRaw != null ? String(orgIdRaw).trim() : "";
          const orgIdObj = mongoose.isValidObjectId(orgIdStr)
            ? new mongoose.Types.ObjectId(orgIdStr)
            : null;

          const orgOr = [];
          if (orgIdObj) orgOr.push({ orgId: orgIdObj });
          if (orgIdStr) orgOr.push({ orgId: orgIdStr });
          orgOr.push({ orgId: { $exists: false } });

          const taskIdStr = String(payload?.taskId || entityRef || "").trim();
          const projectIdStr = String(payload?.projectId || "").trim();
          const milestoneIdStr = String(
            payload?.milestone || payload?.milestoneId || "",
          ).trim();

          const noteText =
            payload?.note != null ? String(payload.note).trim() : "";

          const at = (() => {
            const raw =
              payload?.updatedAt ||
              payload?.createdAt ||
              createdAtClient ||
              new Date().toISOString();
            return parseDateSafe(raw, new Date());
          })();

          function normalizeTaskStatusForTaskModel(s) {
            if (s == null) return null;
            const v = String(s).trim().toLowerCase();

            if (
              ["pending", "todo", "to-do", "planned", "plan", "open"].includes(
                v,
              )
            )
              return "pending";

            if (
              [
                "started",
                "start",
                "in progress",
                "in-progress",
                "inprogress",
                "resume",
                "resumed",
              ].includes(v)
            )
              return "in-progress";

            if (["pause", "paused"].includes(v)) return "paused";

            if (
              [
                "paused - problem",
                "paused-problem",
                "problem",
                "blocked",
                "block",
                "issue",
              ].includes(v)
            )
              return "paused-problem";

            if (
              [
                "finished",
                "finish",
                "done",
                "complete",
                "completed",
                "closed",
              ].includes(v)
            )
              return "completed";

            return null;
          }

          function normalizeMilestoneStatus(s) {
            if (s == null) return null;
            const v = String(s).trim().toLowerCase();

            if (v === "planned" || v === "plan") return "pending";
            if (["complete", "completed", "done"].includes(v))
              return "finished";

            const allowed = new Set([
              "pending",
              "started",
              "paused",
              "paused - problem",
              "finished",
            ]);

            if (v === "paused-problem") return "paused - problem";
            return allowed.has(v) ? v : null;
          }

          if (!mongoose.isValidObjectId(taskIdStr)) {
            console.warn("[task-update] invalid taskId", {
              taskIdStr,
              entityRef,
            });
            return;
          }

          const taskObjectId = new mongoose.Types.ObjectId(taskIdStr);

          const newTaskStatus = normalizeTaskStatusForTaskModel(
            payload?.status,
          );

          if (!newTaskStatus) {
            console.warn("[task-update] unrecognized task status", {
              raw: payload?.status,
            });
          } else {
            let taskDoc = await Task.findOne({ _id: taskObjectId, $or: orgOr });
            if (!taskDoc) taskDoc = await Task.findById(taskObjectId);

            if (!taskDoc) {
              console.warn("[task-update] task not found", { taskIdStr });
            } else {
              taskDoc.status = newTaskStatus;
              taskDoc.updatedAt = new Date();
              taskDoc.updatedBy = req.user?._id || undefined;
              await taskDoc.save();
              console.log("[task-update] Task saved", {
                taskId: String(taskDoc._id),
                status: taskDoc.status,
              });
              appliedTo.taskId = String(taskDoc._id);
            }
          }

          const newMilestoneStatus = normalizeMilestoneStatus(
            payload?.milestoneStatus,
          );

          if (milestoneIdStr && !mongoose.isValidObjectId(milestoneIdStr)) {
            console.warn("[task-update] invalid milestone id", {
              milestoneIdStr,
            });
          } else if (
            mongoose.isValidObjectId(milestoneIdStr) &&
            newMilestoneStatus
          ) {
            const msObjectId = new mongoose.Types.ObjectId(milestoneIdStr);

            let msDoc = await TaskMilestone.findOne({
              _id: msObjectId,
              taskId: taskObjectId,
              ...(orgIdStr ? { orgId: orgIdStr } : {}),
              isDeleted: { $ne: true },
            });

            if (!msDoc) {
              msDoc = await TaskMilestone.findOne({
                _id: msObjectId,
                taskId: taskObjectId,
                isDeleted: { $ne: true },
              });
            }

            if (!msDoc) {
              console.warn("[task-update] milestone not found for task", {
                milestoneIdStr,
                taskIdStr,
              });
            } else {
              msDoc.status = newMilestoneStatus;
              if (newMilestoneStatus === "finished" && !msDoc.actualEndAt) {
                msDoc.actualEndAt = new Date();
              }
              if (newMilestoneStatus !== "finished") {
                msDoc.actualEndAt = null;
              }
              msDoc.updatedAt = new Date();
              await msDoc.save();
              console.log("[task-update] TaskMilestone saved", {
                milestoneId: String(msDoc._id),
                status: msDoc.status,
              });
              appliedTo.milestoneId = String(msDoc._id);
            }
          } else if (payload?.milestoneStatus != null && !newMilestoneStatus) {
            console.warn("[task-update] unrecognized milestoneStatus", {
              raw: payload?.milestoneStatus,
            });
          }

          const actorUserId = req.user?._id
            ? new mongoose.Types.ObjectId(String(req.user._id))
            : undefined;

          const projectObjectId = mongoose.isValidObjectId(projectIdStr)
            ? new mongoose.Types.ObjectId(projectIdStr)
            : undefined;

          // ✅ idempotent ManagerNote: don't create duplicates on resync
          const existingNote = await ManagerNote.findOne({
            taskId: taskObjectId,
            orgId: orgIdObj || undefined,
            sourceOfflineEventId: doc._id,
          })
            .lean()
            .catch(() => null);

          if (!existingNote?._id) {
            const noteDoc = await ManagerNote.create({
              taskId: taskObjectId,
              projectId: projectObjectId,
              orgId: orgIdObj || undefined,
              at,
              status:
                newTaskStatus || String(payload?.status || "pending").trim(),
              note: noteText || "",
              author: {
                id: actorUserId,
                name: req.user?.name || undefined,
                email: req.user?.email || undefined,
              },
              deletedAt: null,
              sourceOfflineEventId: doc._id,
            });
            appliedTo.managerNoteId = String(noteDoc?._id || "");
          }
        } catch (e) {
          console.error("[task-update] failed to apply task update", e);
        }
      }

      // ✅ APPLY ACTIVITY LOG (CANONICAL FIRST, LEGACY FALLBACK)
      if (eventType === "activity-log") {
        try {
          const Task = require("../models/Task");

          const orgIdRaw = req.orgObjectId || req.user?.orgId || null;
          const orgIdStr = orgIdRaw != null ? String(orgIdRaw).trim() : "";
          const orgIdObj = mongoose.isValidObjectId(orgIdStr)
            ? new mongoose.Types.ObjectId(orgIdStr)
            : null;

          const orgOr = [];
          if (orgIdObj) orgOr.push({ orgId: orgIdObj });
          if (orgIdStr) orgOr.push({ orgId: orgIdStr });
          orgOr.push({ orgId: { $exists: false } });

          const taskIdStr = String(payload?.taskId || entityRef || "").trim();
          if (!mongoose.isValidObjectId(taskIdStr)) {
            console.warn("[activity-log] invalid taskId", {
              taskIdStr,
              entityRef,
            });
          } else {
            const taskObjectId = new mongoose.Types.ObjectId(taskIdStr);

            let taskDoc = await Task.findOne({ _id: taskObjectId, $or: orgOr });
            if (!taskDoc) taskDoc = await Task.findById(taskObjectId);

            if (!taskDoc) {
              console.warn("[activity-log] task not found", { taskIdStr });
            } else {
              const milestoneIdStr = String(
                payload?.milestone || payload?.milestoneId || "",
              ).trim();
              const milestoneObjectId = mongoose.isValidObjectId(milestoneIdStr)
                ? new mongoose.Types.ObjectId(milestoneIdStr)
                : undefined;

              const noteText =
                payload?.note != null ? String(payload.note).trim() : "";

              const at = (() => {
                const raw =
                  payload?.updatedAt ||
                  payload?.createdAt ||
                  createdAtClient ||
                  new Date().toISOString();
                return parseDateSafe(raw, new Date());
              })();

              const uploaded = Array.isArray(doc?.uploadedFiles)
                ? doc.uploadedFiles
                : [];

              const attachments = buildMobileOfflineAttachments({
                uploadedFiles: uploaded,
                at,
                req,
                offlineEventId: doc._id,
                noteText,
              });

              const action =
                String(payload?.action || "").trim() ||
                (attachments.length ? "photo" : "note");

              const projectIdObj =
                taskDoc?.projectId &&
                mongoose.isValidObjectId(String(taskDoc.projectId))
                  ? new mongoose.Types.ObjectId(String(taskDoc.projectId))
                  : toObjectIdOrNull(payload?.projectId) || undefined;

              // ✅ 1) CANONICAL: write to ActivityLog-style collection (single source of truth)
              let canonicalOk = false;
              try {
                const canon = await upsertCanonicalActivityLog({
                  orgId: orgIdObj || orgIdStr || orgIdRaw,
                  taskId: taskObjectId,
                  projectId: projectIdObj,
                  milestoneId: milestoneObjectId,
                  at,
                  action,
                  noteText,
                  attachments,
                  req,
                  offlineEventId: doc._id,
                  payload,
                });
                canonicalOk = !!canon?.ok;
                if (canonicalOk) {
                  appliedTo.activityLogId = String(canon?.doc?._id || "");
                  appliedTo.taskId = String(taskObjectId);
                }
              } catch (eCanon) {
                canonicalOk = false;
                console.warn(
                  "[activity-log] canonical log write failed; will fallback",
                  eCanon?.message || eCanon,
                );
              }

              // ✅ 2) LEGACY FALLBACK: keep Task.actualDurationLog + Task.attachments updated
              // This is ONLY to avoid breaking older UI paths while you transition fully to canonical logs.
              // It is idempotent using sourceOfflineEventId.
              try {
                taskDoc.attachments = Array.isArray(taskDoc.attachments)
                  ? taskDoc.attachments
                  : [];
                taskDoc.actualDurationLog = Array.isArray(
                  taskDoc.actualDurationLog,
                )
                  ? taskDoc.actualDurationLog
                  : [];

                const alreadyHasAttachments = taskDoc.attachments.some(
                  (a) =>
                    String(a?.sourceOfflineEventId || "") === String(doc._id),
                );
                const alreadyHasLog = taskDoc.actualDurationLog.some(
                  (l) =>
                    String(l?.sourceOfflineEventId || "") === String(doc._id),
                );

                if (!alreadyHasAttachments && attachments.length) {
                  for (const a of attachments) taskDoc.attachments.push(a);
                }

                if (!alreadyHasLog) {
                  const actorId =
                    req.user?._id &&
                    mongoose.isValidObjectId(String(req.user._id))
                      ? new mongoose.Types.ObjectId(String(req.user._id))
                      : undefined;

                  taskDoc.actualDurationLog.push({
                    action,
                    at,
                    userId: actorId,
                    actorName: req.user?.name,
                    actorEmail: req.user?.email,
                    actorSub: req.user?.sub || req.user?.id,
                    note: noteText || "",
                    ...(milestoneObjectId
                      ? { milestoneId: milestoneObjectId }
                      : {}),
                    sourceOfflineEventId: doc._id,
                  });
                }
              } catch (eLegacy) {
                console.error(
                  "[activity-log] legacy task log fallback failed",
                  eLegacy,
                );
              }

              // ✅ APPLY ACTIVITY FENCE -> TaskCoverage (from payload.fenceJson)
              try {
                const fenceRaw = payload?.fenceJson;

                if (fenceRaw) {
                  const TaskCoverage = require("../models/TaskCoverage");

                  let fenceObj = null;
                  try {
                    fenceObj =
                      typeof fenceRaw === "string"
                        ? JSON.parse(fenceRaw)
                        : fenceRaw;
                  } catch {
                    fenceObj = null;
                  }

                  const pts = Array.isArray(fenceObj?.points)
                    ? fenceObj.points
                    : [];
                  if (pts.length >= 2) {
                    const coords = pts
                      .map((p) => [Number(p.longitude), Number(p.latitude)])
                      .filter(
                        ([lng, lat]) =>
                          Number.isFinite(lng) && Number.isFinite(lat),
                      );

                    if (coords.length >= 2) {
                      const t = String(fenceObj?.type || "polyline")
                        .toLowerCase()
                        .trim();

                      let geometry = null;

                      if (t === "polygon") {
                        const ring = coords.slice();
                        const first = ring[0];
                        const last = ring[ring.length - 1];
                        if (
                          first &&
                          last &&
                          (first[0] !== last[0] || first[1] !== last[1])
                        ) {
                          ring.push(first);
                        }

                        if (ring.length >= 4) {
                          geometry = {
                            type: "MultiPolygon",
                            coordinates: [[[ring]]],
                          };
                        }
                      } else {
                        geometry = {
                          type: "MultiLineString",
                          coordinates: [coords],
                        };
                      }

                      if (geometry) {
                        const orgId2 = req.orgObjectId || req.user?.orgId;

                        const sourceOfflineEventId = doc?._id;

                        await TaskCoverage.findOneAndUpdate(
                          {
                            orgId: orgId2,
                            taskId: taskObjectId,
                            sourceOfflineEventId,
                          },
                          {
                            $set: {
                              orgId: orgId2,
                              taskId: taskObjectId,
                              projectId: taskDoc?.projectId || undefined,
                              date: at,
                              geometry,
                              stats: { points: coords.length, fences: 1 },
                              source: "mobile-track",
                              uploadedBy: {
                                userId:
                                  req.user?._id &&
                                  mongoose.isValidObjectId(String(req.user._id))
                                    ? new mongoose.Types.ObjectId(
                                        String(req.user._id),
                                      )
                                    : undefined,
                                name: req.user?.name || undefined,
                                email: req.user?.email || undefined,
                              },
                              note: String(payload?.note || "").trim(),
                              sourceOfflineEventId,
                            },
                            $setOnInsert: {
                              createdAt: new Date(),
                            },
                          },
                          { upsert: true, new: true },
                        );

                        appliedTo.coverageFromFence = true;
                        console.log(
                          "[activity-log] TaskCoverage saved from fenceJson",
                          {
                            taskId: String(taskObjectId),
                            type: geometry.type,
                            points: coords.length,
                            sourceOfflineEventId: String(sourceOfflineEventId),
                          },
                        );
                      }
                    }
                  }
                }
              } catch (eFence) {
                console.error(
                  "[activity-log] failed to save TaskCoverage from fenceJson",
                  eFence,
                );
              }

              taskDoc.updatedAt = new Date();
              await taskDoc.save();

              console.log("[activity-log] applied", {
                taskId: String(taskDoc._id),
                canonicalModel: !!ActivityLogModel,
                canonicalAttempted: true,
                attachments: attachments.length,
                noteLen: noteText.length,
                milestoneId: milestoneIdStr || null,
              });
            }
          }
        } catch (e5) {
          console.error("[activity-log] failed to apply activity log", e5);
        }
      }

      // ------------------------------------------------------------
      // BIOMETRICS: create/upsert ONE BiometricEnrollmentRequest
      // keyed by sourceOfflineEventId so resync won't create duplicates
      // ------------------------------------------------------------
      if (eventType === "biometric-enroll") {
        try {
          const BiometricEnrollmentRequest = require("../models/BiometricEnrollmentRequest");

          const targetUserIdStr = String(
            payload?.targetUserId || entityRef || "",
          ).trim();
          const performedByUserIdStr = String(
            payload?.performedByUserId ||
              payload?.performedByMongoUserId ||
              userId ||
              "",
          ).trim();

          if (!mongoose.isValidObjectId(targetUserIdStr)) {
            console.warn("[biometrics] missing/invalid targetUserId", {
              targetUserIdStr,
            });
          } else if (!mongoose.isValidObjectId(performedByUserIdStr)) {
            console.warn("[biometrics] missing/invalid performedByUserId", {
              performedByUserIdStr,
            });
          } else {
            const enrReq = await BiometricEnrollmentRequest.findOneAndUpdate(
              { orgId, sourceOfflineEventId: doc._id },
              {
                $setOnInsert: {
                  orgId,
                  sourceOfflineEventId: doc._id,
                  status: "pending",
                  createdAtClient: createdAtClient
                    ? new Date(String(createdAtClient))
                    : undefined,
                  createdAt: new Date(),
                },
                $set: {
                  targetUserId: new mongoose.Types.ObjectId(targetUserIdStr),
                  performedByUserId: new mongoose.Types.ObjectId(
                    performedByUserIdStr,
                  ),
                  performedByEmail: payload?.performedByEmail || null,
                  performedByRoles: Array.isArray(payload?.performedByRoles)
                    ? payload.performedByRoles
                    : [],
                  groupId: mongoose.isValidObjectId(
                    String(payload?.groupId || ""),
                  )
                    ? new mongoose.Types.ObjectId(String(payload.groupId))
                    : undefined,
                  uploadedFiles: Array.isArray(doc?.uploadedFiles)
                    ? doc.uploadedFiles
                    : [],
                  updatedAt: new Date(),
                },
              },
              { upsert: true, new: true },
            );
            appliedTo.biometricRequestId = String(enrReq?._id || "");
          }
        } catch (e2) {
          console.error(
            "[biometrics] failed to upsert BiometricEnrollmentRequest",
            e2,
          );
        }
      }

      // ✅ mark applied debug fields (best-effort; never fail the ingest)
      try {
        await OfflineEvent.updateOne(
          { _id: doc._id },
          { $set: { appliedAt: new Date(), appliedTo } },
        );
      } catch {}

      return res.json({
        ok: true,
        stage: "received",
        id: doc._id,
        uploadedFilesCount: Array.isArray(doc.uploadedFiles)
          ? doc.uploadedFiles.length
          : 0,
        appliedTo,
        routerVersion: ROUTER_VERSION,
      });
    } catch (e) {
      console.error("[mobile/offline-events] error", e);
      return res
        .status(500)
        .json({ error: e?.message || "Offline ingest failed" });
    }
  },
);

/* -----------------------------
   BIOMETRIC REQUEST WORKFLOW
------------------------------*/

// ✅ LIST biometric requests
router.get("/biometric-requests", requireOrg, async (req, res) => {
  try {
    const orgId = req.orgObjectId || req.user?.orgId;

    if (!canApproveBiometrics(req.user)) {
      return res.status(403).json({ error: "Not allowed" });
    }

    const BiometricEnrollmentRequest = require("../models/BiometricEnrollmentRequest");

    const limit = Math.min(parseInt(req.query.limit || "200", 10) || 200, 1000);

    const statusRaw = String(req.query.status || "")
      .trim()
      .toLowerCase();
    const status = statusRaw || "pending";

    const targetUserIdStr = String(req.query.targetUserId || "").trim();
    const includeApproved = boolish(req.query.includeApproved);

    const find = { orgId };

    if (status && status !== "all") {
      find.status = status;
    } else if (!statusRaw) {
      if (!includeApproved) find.status = "pending";
    }

    if (targetUserIdStr) {
      if (!mongoose.isValidObjectId(targetUserIdStr)) {
        return res.status(400).json({ error: "Invalid targetUserId" });
      }
      find.targetUserId = new mongoose.Types.ObjectId(targetUserIdStr);
    }

    const rows = await BiometricEnrollmentRequest.find(find)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    return res.json({ ok: true, requests: rows });
  } catch (e) {
    console.error("[biometrics] list requests error", e);
    return res.status(500).json({ error: e?.message || "List failed" });
  }
});

// GET a request (debug + UI)
router.get("/biometric-requests/:requestId", requireOrg, async (req, res) => {
  try {
    const orgId = req.orgObjectId || req.user?.orgId;

    const requestIdStr = String(req.params.requestId || "").trim();
    if (!mongoose.isValidObjectId(requestIdStr)) {
      return res.status(400).json({ error: "Invalid requestId" });
    }

    const BiometricEnrollmentRequest = require("../models/BiometricEnrollmentRequest");
    const requestDoc = await BiometricEnrollmentRequest.findOne({
      _id: new mongoose.Types.ObjectId(requestIdStr),
      orgId,
    }).lean();

    if (!requestDoc)
      return res.status(404).json({ error: "Request not found" });

    return res.json({ ok: true, request: requestDoc });
  } catch (e) {
    console.error("[biometrics] get request error", e);
    return res.status(500).json({ error: e?.message || "Fetch failed" });
  }
});

// APPROVE
router.post(
  "/biometric-requests/:requestId/approve",
  requireOrg,
  async (req, res) => {
    try {
      if (!canApproveBiometrics(req.user)) {
        return res.status(403).json({ error: "Not allowed" });
      }

      const orgId = req.orgObjectId || req.user?.orgId;
      const approverUserId = req.user?._id || null;

      const requestIdStr = String(req.params.requestId || "").trim();
      if (!mongoose.isValidObjectId(requestIdStr)) {
        return res.status(400).json({ error: "Invalid requestId" });
      }

      const BiometricEnrollmentRequest = require("../models/BiometricEnrollmentRequest");
      const BiometricEnrollment = require("../models/BiometricEnrollment");

      const requestDoc = await BiometricEnrollmentRequest.findOne({
        _id: new mongoose.Types.ObjectId(requestIdStr),
        orgId,
      });

      if (!requestDoc)
        return res.status(404).json({ error: "Request not found" });

      if (String(requestDoc.status || "").toLowerCase() !== "pending") {
        return res.json({
          ok: true,
          message: `Request already ${requestDoc.status}`,
          requestStatus: requestDoc.status,
        });
      }

      const uploadedFiles = Array.isArray(requestDoc.uploadedFiles)
        ? requestDoc.uploadedFiles
        : [];

      const photoFileIds = uploadedFiles
        .map((f) => String(f?.fileId || "").trim())
        .filter((s) => mongoose.isValidObjectId(s))
        .map((s) => new mongoose.Types.ObjectId(s));

      const enrollment = await BiometricEnrollment.findOneAndUpdate(
        { orgId, userId: requestDoc.targetUserId },
        {
          $set: {
            status: "pending",
            photoFileIds,
            sourceRequestId: requestDoc._id,
            approvedBy: approverUserId,
            approvedAt: new Date(),
          },
        },
        { new: true, upsert: true },
      );

      try {
        const User = require("../models/User");
        const firstPhotoFileIdStr = uploadedFiles?.[0]?.fileId
          ? String(uploadedFiles[0].fileId).trim()
          : "";
        const firstPhotoFileId = mongoose.isValidObjectId(firstPhotoFileIdStr)
          ? new mongoose.Types.ObjectId(firstPhotoFileIdStr)
          : null;

        const setPatch = {
          "biometric.status": "pending",
          "biometric.lastUpdatedAt": new Date(),
        };

        if (firstPhotoFileId) {
          setPatch["photo.fileId"] = firstPhotoFileId;
          setPatch["photo.source"] = "biometric-request";
          setPatch["photo.updatedAt"] = new Date();
        }

        await User.updateOne(
          { _id: requestDoc.targetUserId, orgId },
          { $set: setPatch },
        );
      } catch (e3) {
        console.error(
          "[biometrics] failed to update User.biometric summary / photo",
          e3,
        );
      }

      requestDoc.status = "approved";
      requestDoc.approvedByUserId = approverUserId;
      requestDoc.approvedAt = new Date();
      await requestDoc.save();

      return res.json({
        ok: true,
        requestId: requestDoc._id,
        requestStatus: requestDoc.status,
        enrollmentId: enrollment._id,
        enrollmentStatus: enrollment.status,
        photosCount: photoFileIds.length,
      });
    } catch (e) {
      console.error("[biometrics] approve request error", e);
      return res.status(500).json({ error: e?.message || "Approve failed" });
    }
  },
);

// REJECT
router.post(
  "/biometric-requests/:requestId/reject",
  requireOrg,
  async (req, res) => {
    try {
      if (!canApproveBiometrics(req.user)) {
        return res.status(403).json({ error: "Not allowed" });
      }

      const orgId = req.orgObjectId || req.user?.orgId;
      const rejectorUserId = req.user?._id || null;

      const requestIdStr = String(req.params.requestId || "").trim();
      if (!mongoose.isValidObjectId(requestIdStr)) {
        return res.status(400).json({ error: "Invalid requestId" });
      }

      const reason = String(req.body?.reason || "").trim();

      const BiometricEnrollmentRequest = require("../models/BiometricEnrollmentRequest");
      const requestDoc = await BiometricEnrollmentRequest.findOne({
        _id: new mongoose.Types.ObjectId(requestIdStr),
        orgId,
      });

      if (!requestDoc)
        return res.status(404).json({ error: "Request not found" });

      if (String(requestDoc.status || "").toLowerCase() !== "pending") {
        return res.json({
          ok: true,
          message: `Request already ${requestDoc.status}`,
          requestStatus: requestDoc.status,
        });
      }

      requestDoc.status = "rejected";
      requestDoc.rejectedByUserId = rejectorUserId;
      requestDoc.rejectedAt = new Date();
      requestDoc.rejectReason = reason || null;
      await requestDoc.save();

      return res.json({
        ok: true,
        requestId: requestDoc._id,
        requestStatus: requestDoc.status,
      });
    } catch (e) {
      console.error("[biometrics] reject request error", e);
      return res.status(500).json({ error: e?.message || "Reject failed" });
    }
  },
);

// ✅ Enrollment status helper
router.get(
  "/biometric-enrollment-status/:userId",
  requireOrg,
  async (req, res) => {
    try {
      const orgId = req.orgObjectId || req.user?.orgId;

      const userIdStr = String(req.params.userId || "").trim();
      if (!mongoose.isValidObjectId(userIdStr)) {
        return res.status(400).json({ error: "Invalid userId" });
      }

      const BiometricEnrollment = require("../models/BiometricEnrollment");

      const enr = await BiometricEnrollment.findOne({
        orgId,
        userId: new mongoose.Types.ObjectId(userIdStr),
      })
        .sort({ updatedAt: -1, _id: -1 })
        .select({ status: 1, templateVersion: 1, updatedAt: 1, approvedAt: 1 })
        .lean();

      return res.json({ ok: true, enrollment: enr || null });
    } catch (e) {
      console.error("[biometrics] status error", e);
      return res.status(500).json({ error: e?.message || "Status failed" });
    }
  },
);

// -----------------------------
// BIOMETRIC IDENTIFY (ORG REQUIRED)
// POST /api/mobile/biometric-identify
// multipart/form-data:
//   - photo: file (required)
//   - groupId (optional)
// -----------------------------

function bufferToFloat32BufferStub(buf) {
  const hash = crypto.createHash("sha256").update(buf).digest(); // 32 bytes
  const out = new Float32Array(128);
  for (let i = 0; i < out.length; i++) {
    const b = hash[i % hash.length];
    out[i] = (b / 255) * 2 - 1;
  }
  return Buffer.from(out.buffer);
}

function bufferToFloat32Array(buf) {
  if (!buf) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 4) return null;
  const usable = b.slice(0, Math.floor(b.length / 4) * 4);
  return new Float32Array(usable.buffer, usable.byteOffset, usable.length / 4);
}

function cosineSimilarity(a, b) {
  if (!a || !b) return -1;
  const n = Math.min(a.length, b.length);
  if (n <= 0) return -1;

  let dot = 0;
  let na = 0;
  let nb = 0;

  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }

  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (!denom) return -1;
  return dot / denom;
}

router.post(
  "/biometric-identify",
  requireOrg,
  (req, res, next) => {
    if (!upload) {
      return res.status(503).json({
        ok: false,
        error: "File upload not available (multer missing)",
      });
    }
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("multipart/form-data")) {
      return res.status(400).json({
        ok: false,
        error: "Expected multipart/form-data with field 'photo'",
      });
    }
    return upload.single("photo")(req, res, next);
  },
  async (req, res) => {
    try {
      const orgId = req.orgObjectId || req.user?.orgId;
      if (!orgId) return res.status(400).json({ ok: false, error: "No org" });

      if (!req.file?.buffer) {
        return res.status(400).json({
          ok: false,
          error: "Missing photo file (field name must be 'photo')",
        });
      }

      const probeBuf = bufferToFloat32BufferStub(req.file.buffer);
      const probe = bufferToFloat32Array(probeBuf);

      const groupIdStr = String(req.body?.groupId || "").trim();
      let memberUserIds = null;

      if (mongoose.isValidObjectId(groupIdStr)) {
        try {
          const Group = require("../models/Group");
          const group = await Group.findOne({
            _id: new mongoose.Types.ObjectId(groupIdStr),
            orgId,
          })
            .select({ memberUserIds: 1, members: 1, userIds: 1 })
            .lean();

          const arr =
            group?.memberUserIds || group?.members || group?.userIds || [];
          if (Array.isArray(arr) && arr.length) {
            memberUserIds = arr
              .map((x) => String(x?._id || x?.id || x || ""))
              .filter((s) => mongoose.isValidObjectId(s))
              .map((s) => new mongoose.Types.ObjectId(s));
          }
        } catch {}
      }

      const BiometricEnrollment = require("../models/BiometricEnrollment");

      const find = {
        orgId,
        status: "enrolled",
        embedding: { $exists: true, $ne: null },
      };
      if (memberUserIds?.length) find.userId = { $in: memberUserIds };

      const enrolled = await BiometricEnrollment.find(find)
        .select({ userId: 1, templateVersion: 1 })
        .select("+embedding")
        .limit(2000)
        .lean();

      if (!enrolled.length) {
        return res.json({
          ok: true,
          matchedUserId: null,
          score: null,
          reason: "no_enrolled_users",
          templateVersion: null,
        });
      }

      let best = { userId: null, score: -1, templateVersion: null };

      for (const e of enrolled) {
        const embArr = bufferToFloat32Array(e.embedding);
        if (!embArr) continue;

        const score = cosineSimilarity(probe, embArr);
        if (score > best.score) {
          best = {
            userId: e.userId ? String(e.userId) : null,
            score,
            templateVersion: e.templateVersion || null,
          };
        }
      }

      const THRESHOLD = 0.78;

      if (!best.userId || best.score < THRESHOLD) {
        return res.json({
          ok: true,
          matchedUserId: null,
          score: best.score >= 0 ? Number(best.score.toFixed(4)) : null,
          reason: "no_match",
          templateVersion: best.templateVersion,
        });
      }

      return res.json({
        ok: true,
        matchedUserId: best.userId,
        score: Number(best.score.toFixed(4)),
        reason: "matched",
        templateVersion: best.templateVersion,
      });
    } catch (e) {
      console.error("[mobile/biometric-identify] error", e);
      return res.status(500).json({
        ok: false,
        error: e?.message || "Identify failed",
      });
    }
  },
);

module.exports = router;
