// core-backend/routes/mobile.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

// ✅ Multer for multipart/form-data
let multer = null;
try {
  // eslint-disable-next-line global-require
  multer = require("multer");
} catch (e) {
  multer = null;
}

// ✅ GridFS support (MongoDB file storage)
const { GridFSBucket } = require("mongodb");

const {
  requireAuth,
  resolveOrgContext,
  requireOrg,
} = require("../middleware/auth");

let Org = null;
try {
  Org = require("../models/Org");
} catch {}

/**
 * 🔎 Router version header so we can prove Render is running THIS file.
 * Change the string if you ever need to confirm another deploy.
 */
const ROUTER_VERSION = "mobile-router-v2026-02-04-01";

router.use((req, res, next) => {
  res.setHeader("x-mobile-router-version", ROUTER_VERSION);
  next();
});

router.use(requireAuth, resolveOrgContext);

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
  // files from multer memoryStorage: [{ originalname, mimetype, buffer, size }]
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

    // Build a stable reference the app/backend can use later
    out.push({
      fileId: String(uploadStream.id),
      filename,
      contentType: f.mimetype || null,
      size: f.size || null,
      // You already serve documents via /api/files/documents/:fileId.
      // For this bucket, we will add a route later if needed.
      // For now: store fileId and serve via a dedicated endpoint later.
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

    if (!orgId) {
      return res.json({ ok: true, orgs: [] });
    }

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

// Model: OfflineEvent
const OfflineEventSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Org", index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    eventType: { type: String, index: true },
    entityRef: { type: String },
    payload: { type: Object },
    fileUris: { type: [String], default: [] }, // legacy: local URIs / remote refs
    uploadedFiles: { type: [Object], default: [] }, // ✅ new: {fileId, filename, contentType, size}
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
 *      - files[]      (images)
 */
router.post(
  "/offline-events",
  requireOrg,
  (req, res, next) => {
    // If multer isn't installed, just skip multipart parsing.
    // JSON will still work.
    if (!upload) return next();
    // Try parse multipart if Content-Type indicates it
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    if (!ct.includes("multipart/form-data")) return next();
    return upload.array("files")(req, res, next);
  },
  async (req, res) => {
    try {
      const orgId = req.orgObjectId || req.user?.orgId;
      const userId = req.user?._id || null;

      // Detect whether this was JSON or multipart
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
        fileUris = []; // with multipart we store real uploads instead

        // Save uploaded files to GridFS (if any)
        const files = Array.isArray(req.files) ? req.files : [];
        if (files.length) {
          uploadedFiles = await saveBuffersToGridFS({
            orgId,
            userId,
            files,
          });
        }
      } else {
        // JSON mode
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

      return res.json({
        ok: true,
        stage: "received",
        id: doc._id,
        uploadedFilesCount: uploadedFiles.length,
      });
    } catch (e) {
      console.error("[mobile/offline-events] error", e);
      return res
        .status(500)
        .json({ error: e?.message || "Offline ingest failed" });
    }
  },
);

module.exports = router;
