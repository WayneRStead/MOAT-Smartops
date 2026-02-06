// core-backend/routes/mobile.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

// ✅ GridFS support (MongoDB file storage)
const { GridFSBucket } = require("mongodb");

// ✅ Auth middleware MUST be imported before router.use(...)
const {
  requireAuth,
  resolveOrgContext,
  requireOrg,
} = require("../middleware/auth");

/**
 * 🔎 Router version header so we can prove Render is running THIS file.
 * Change the string if you ever need to confirm another deploy.
 */
const ROUTER_VERSION = "mobile-router-v2026-02-05-06";

router.use((req, res, next) => {
  res.setHeader("x-mobile-router-version", ROUTER_VERSION);
  next();
});

// ✅ Attach auth + org context for all routes in this router
router.use(requireAuth, resolveOrgContext);

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

async function saveBuffersToGridFS({ orgId, userId, files }) {
  const bucket = getMobileOfflineBucket();
  if (!bucket) throw new Error("MongoDB not ready for file uploads");

  const out = [];

  for (const f of files || []) {
    if (!f?.buffer) continue;

    const filename = `${Date.now()}_${Math.random()
      .toString(16)
      .slice(2)}_${String(f.originalname || "upload.bin")}`;

    const meta = {
      orgId: String(orgId || ""),
      userId: String(userId || ""),
      originalname: f.originalname || null,
      mimetype: f.mimetype || null,
      size: f.size || null,
      kind: "offline-event-file",
      createdAt: new Date().toISOString(),
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
    });
  }

  return out;
}

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
    uploadedFiles: { type: [Object], default: [] }, // {fileId, filename, contentType, size}
    createdAtClient: { type: String },
    receivedAt: { type: Date, default: Date.now },
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
        limits: { fileSize: 15 * 1024 * 1024 }, // 15MB per file
      })
    : null;

/**
 * POST /api/mobile/offline-events
 * Supports:
 * 1) JSON:
 *    { eventType, entityRef, payload, fileUris, createdAt }
 *
 * 2) multipart/form-data:
 *    fields:
 *      - eventType
 *      - entityRef
 *      - createdAt
 *      - payloadJson  (JSON string)
 *    files:
 *      - files        (repeatable)
 */
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
        fileUris = []; // we store uploads instead

        const files = Array.isArray(req.files) ? req.files : [];
        if (files.length) {
          uploadedFiles = await saveBuffersToGridFS({
            orgId,
            userId,
            files,
          });
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

      // ------------------------------------------------------------
      // BIOMETRICS: create ONE BiometricEnrollmentRequest (workflow row)
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
            await BiometricEnrollmentRequest.create({
              orgId,
              targetUserId: new mongoose.Types.ObjectId(targetUserIdStr),
              performedByUserId: new mongoose.Types.ObjectId(
                performedByUserIdStr,
              ),
              performedByEmail: payload?.performedByEmail || null,
              performedByRoles: Array.isArray(payload?.performedByRoles)
                ? payload.performedByRoles
                : [],
              groupId: mongoose.isValidObjectId(String(payload?.groupId || ""))
                ? new mongoose.Types.ObjectId(String(payload.groupId))
                : undefined,
              status: "pending",
              uploadedFiles: Array.isArray(doc?.uploadedFiles)
                ? doc.uploadedFiles
                : [],
              sourceOfflineEventId: doc?._id,
              createdAtClient: createdAtClient
                ? new Date(String(createdAtClient))
                : undefined,
            });
          }
        } catch (e2) {
          console.error(
            "[biometrics] failed to create BiometricEnrollmentRequest",
            e2,
          );
          // Do not fail offline ingest — keep mobile reliable
        }
      }

      return res.json({
        ok: true,
        stage: "received",
        id: doc._id,
        uploadedFilesCount: Array.isArray(doc.uploadedFiles)
          ? doc.uploadedFiles.length
          : 0,
      });
    } catch (e) {
      console.error("[mobile/offline-events] error", e);
      return res
        .status(500)
        .json({ error: e?.message || "Offline ingest failed" });
    }
  },
);

// -----------------------------
//  DOWNLOAD GRIDFS FILE (mobileOffline bucket)
//  GET /api/mobile/offline-files/:fileId
// -----------------------------
router.get("/offline-files/:fileId", requireOrg, async (req, res) => {
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

    res.setHeader(
      "Content-Type",
      fileDoc.contentType || "application/octet-stream",
    );
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${fileDoc.filename || "file"}"`,
    );

    const stream = bucket.openDownloadStream(fileId);

    stream.on("error", (err) => {
      console.error("[mobile/offline-files] stream error", err);
      if (!res.headersSent) res.status(500).end("Stream error");
    });

    stream.pipe(res);
  } catch (e) {
    console.error("[mobile/offline-files] error", e);
    return res.status(500).json({ error: e?.message || "Download failed" });
  }
});

module.exports = router;
