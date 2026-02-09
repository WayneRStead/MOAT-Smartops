// core-backend/routes/mobile.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

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
const ROUTER_VERSION = "mobile-router-v2026-02-09-03";

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
            await BiometricEnrollmentRequest.findOneAndUpdate(
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
          }
        } catch (e2) {
          console.error(
            "[biometrics] failed to upsert BiometricEnrollmentRequest",
            e2,
          );
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

/* -----------------------------
   DOWNLOAD GRIDFS FILE (mobileOffline bucket)
   GET/HEAD /api/mobile/offline-files/:fileId
   ✅ Enforces org ownership via GridFS metadata.orgId
------------------------------*/
router.all("/offline-files/:fileId", requireOrg, async (req, res) => {
  try {
    const bucket = getMobileOfflineBucket();
    if (!bucket) return res.status(503).json({ error: "MongoDB not ready" });

    const orgId = req.orgObjectId || req.user?.orgId;
    const orgIdStr = String(orgId || "").trim();
    if (!orgIdStr)
      return res.status(400).json({ error: "Missing org context" });

    const fileIdStr = String(req.params.fileId || "").trim();
    if (!mongoose.isValidObjectId(fileIdStr)) {
      return res.status(400).json({ error: "Invalid fileId" });
    }

    const fileId = new mongoose.Types.ObjectId(fileIdStr);

    const filesColl = mongoose.connection.db.collection("mobileOffline.files");
    const fileDoc = await filesColl.findOne({
      _id: fileId,
      "metadata.orgId": orgIdStr,
    });
    if (!fileDoc) return res.status(404).json({ error: "File not found" });

    res.setHeader(
      "Content-Type",
      fileDoc.contentType || "application/octet-stream",
    );
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${fileDoc.filename || "file"}"`,
    );

    if (req.method === "HEAD") return res.status(200).end();
    if (req.method !== "GET")
      return res.status(405).json({ error: "Method not allowed" });

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

/* -----------------------------
   BIOMETRIC REQUEST WORKFLOW
------------------------------*/

/**
 * ✅ NEW: LIST biometric requests
 * GET /api/mobile/biometric-requests?status=pending&targetUserId=<id>&limit=200&includeApproved=0
 *
 * Default behaviour:
 * - status defaults to "pending"
 * - returns recent first
 * - limits to 200 (max 1000)
 */
router.get("/biometric-requests", requireOrg, async (req, res) => {
  try {
    const orgId = req.orgObjectId || req.user?.orgId;

    // Only admin-ish should list all requests; otherwise allow self-view only.
    // (If you want it fully open to all authenticated users, remove this block.)
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

    // status filter
    if (status && status !== "all") {
      find.status = status;
    } else if (!includeApproved) {
      // if "all" but includeApproved not set, default to excluding approved/rejected
      find.status = "pending";
    }

    // optional targetUser filter
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

      // Create/Update enrollment (still "pending" until embeddings exist)
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
        await User.updateOne(
          { _id: requestDoc.targetUserId, orgId },
          {
            $set: {
              "biometric.status": "pending",
              "biometric.lastUpdatedAt": new Date(),
            },
          },
        );
      } catch (e3) {
        console.error(
          "[biometrics] failed to update User.biometric summary",
          e3,
        );
      }

      // Mark request approved
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

module.exports = router;
