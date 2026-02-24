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
const ROUTER_VERSION = "mobile-router-v2026-02-24-04"; // bump so you can confirm deploy

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

function getDocumentsBucket() {
  const db = mongoose.connection?.db;
  if (!db) return null;
  return new GridFSBucket(db, { bucketName: "documents" });
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

      // ✅ APPLY PROJECT UPDATES (manager note + status + optional attachments)
      // IMPORTANT: Manager notes are stored in ProjectManagerNote collection,
      // not on Project (Project schema does not include managerNotes).
      if (eventType === "project-update") {
        try {
          const Project = require("../models/Project");
          const ProjectManagerNote = require("../models/ProjectManagerNote");

          const orgId = req.orgObjectId || req.user?.orgId;

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

            // --- Extract fields from payload ---
            const statusRaw =
              payload?.status != null
                ? String(payload.status).trim().toLowerCase()
                : "";
            const managerNote =
              payload?.managerNote != null
                ? String(payload.managerNote).trim()
                : "";

            // --- 1) Update Project.status (only allow schema enum values) ---
            const allowedStatus = new Set(["active", "paused", "closed"]);
            const status = allowedStatus.has(statusRaw) ? statusRaw : null;

            if (status) {
              await Project.updateOne(
                { _id: projectObjectId, orgId },
                {
                  $set: {
                    status,
                    updatedAt: new Date(),
                    updatedBy: req.user?._id || null,
                  },
                },
              );
            }

            // --- 2) Create a ProjectManagerNote doc (source of truth) ---
            if (managerNote) {
              const at = payload?.at ? new Date(payload.at) : new Date();

              // Attach any uploaded files from this OfflineEvent to the note.
              // This makes "sick notes" visible via manager notes history.
              const uploadedFiles = Array.isArray(doc?.uploadedFiles)
                ? doc.uploadedFiles
                : [];

              await ProjectManagerNote.create({
                orgId,
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

                // Optional fields (safe if schema supports them; if not, we can add them)
                uploadedFiles,
                sourceOfflineEventId: doc._id,
                createdAtClient: createdAtClient || null,
              });
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

          const orgId = req.orgObjectId || req.user?.orgId;
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

          // Need at least a project link to show under Project detail
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
              // 1) Copy first uploaded file into the Vault bucket ("documents")
              const first = uploaded[0];
              const newFileId = await copyGridFSFile({
                fromBucket,
                toBucket,
                fromFileId: first.fileId,
                filename: first.filename || null,
                contentType: first.contentType || null,
                metadata: {
                  // keep consistent with documents.js GridFS metadata patterns
                  orgId: String(orgId || ""),
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

              // 2) Create a Document record so the Vault + Project can list it
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
              };

              const now = new Date();

              const body = {
                orgId:
                  req.orgObjectId ||
                  (mongoose.Types.ObjectId.isValid(String(orgId))
                    ? new mongoose.Types.ObjectId(String(orgId))
                    : undefined),

                title,
                folder: "",

                // tags are normalized to lowercase in the Document model
                tags: tag ? [tag] : [],

                links,

                access: { visibility: "org", owners: actor ? [actor] : [] },

                versions: [version],
                latest: version,

                createdAt: now,
                updatedAt: now,
                createdBy: actor,
                updatedBy: actor,
              };

              await Document.create(body);
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

          // match orgId whether stored as ObjectId, string, or missing
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
            const d = new Date(raw);
            return isNaN(+d) ? new Date() : d;
          })();

          // -----------------------------
          // Normalize TASK status to Task.js enum world
          // Task.js expects: pending | in-progress | paused | paused-problem | completed
          // and its own setter normalizes some synonyms on save()
          // -----------------------------
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

          // -----------------------------
          // Normalize MILESTONE status to task-milestones.js world (lowercase)
          // STATUS: pending | started | paused | paused - problem | finished
          // -----------------------------
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

            // also accept "paused-problem" from mobile and map it
            if (v === "paused-problem") return "paused - problem";

            return allowed.has(v) ? v : null;
          }

          // -----------------------------
          // Validate IDs
          // -----------------------------
          if (!mongoose.isValidObjectId(taskIdStr)) {
            console.warn("[task-update] invalid taskId", {
              taskIdStr,
              entityRef,
            });
            // still allow ManagerNote creation? no, without taskId it's meaningless
            return;
          }

          const taskObjectId = new mongoose.Types.ObjectId(taskIdStr);

          // -----------------------------
          // 1) Update TASK status (load + save => schema setters run)
          // -----------------------------
          const newTaskStatus = normalizeTaskStatusForTaskModel(
            payload?.status,
          );

          if (!newTaskStatus) {
            console.warn("[task-update] unrecognized task status", {
              raw: payload?.status,
            });
          } else {
            let taskDoc = await Task.findOne({ _id: taskObjectId, $or: orgOr });

            // fallback if org scoping doesn't match stored form
            if (!taskDoc) {
              taskDoc = await Task.findById(taskObjectId);
            }

            if (!taskDoc) {
              console.warn("[task-update] task not found", { taskIdStr });
            } else {
              taskDoc.status = newTaskStatus; // Task schema setter will normalize if needed
              taskDoc.updatedAt = new Date();

              // optional audit fields if your schema tolerates them (Mongo will store anyway)
              taskDoc.updatedBy = req.user?._id || undefined;

              await taskDoc.save();

              console.log("[task-update] Task saved", {
                taskId: String(taskDoc._id),
                status: taskDoc.status,
              });
            }
          }

          // -----------------------------
          // 2) Update TASK MILESTONE status (lowercase)
          // -----------------------------
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

            // fallback (some milestone docs may store orgId differently or not at all)
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

              // match route behavior: finishing stamps actualEndAt if absent
              if (newMilestoneStatus === "finished" && !msDoc.actualEndAt) {
                msDoc.actualEndAt = new Date();
              }
              if (newMilestoneStatus !== "finished") {
                // if you want non-finished to clear actual end (route does this on PATCH)
                msDoc.actualEndAt = null;
              }

              msDoc.updatedAt = new Date();
              await msDoc.save();

              console.log("[task-update] TaskMilestone saved", {
                milestoneId: String(msDoc._id),
                status: msDoc.status,
              });
            }
          } else if (payload?.milestoneStatus != null && !newMilestoneStatus) {
            console.warn("[task-update] unrecognized milestoneStatus", {
              raw: payload?.milestoneStatus,
            });
          }

          // -----------------------------
          // 3) ManagerNote (already working)
          // -----------------------------
          const actorUserId = req.user?._id
            ? new mongoose.Types.ObjectId(String(req.user._id))
            : undefined;

          const projectObjectId = mongoose.isValidObjectId(projectIdStr)
            ? new mongoose.Types.ObjectId(projectIdStr)
            : undefined;

          await ManagerNote.create({
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
          });
        } catch (e) {
          console.error("[task-update] failed to apply task update", e);
        }
      }

      // ✅ APPLY ACTIVITY LOG (Task.actualDurationLog + Task.attachments)
      if (eventType === "activity-log") {
        try {
          const Task = require("../models/Task");
          const orgIdRaw = req.orgObjectId || req.user?.orgId || null;
          const orgIdStr = orgIdRaw != null ? String(orgIdRaw).trim() : "";
          const orgIdObj = mongoose.isValidObjectId(orgIdStr)
            ? new mongoose.Types.ObjectId(orgIdStr)
            : null;

          // Match orgId stored as ObjectId OR string OR missing
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

            // Try org-scoped first, fallback to byId
            let taskDoc = await Task.findOne({ _id: taskObjectId, $or: orgOr });
            if (!taskDoc) taskDoc = await Task.findById(taskObjectId);

            if (!taskDoc) {
              console.warn("[activity-log] task not found", { taskIdStr });
            } else {
              // milestone/deliverable id (optional)
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
                const d = new Date(raw);
                return Number.isNaN(d.getTime()) ? new Date() : d;
              })();

              // ✅ Attach uploadedFiles to Task.attachments using the offline-files URL
              const uploaded = Array.isArray(doc?.uploadedFiles)
                ? doc.uploadedFiles
                : [];
              taskDoc.attachments = Array.isArray(taskDoc.attachments)
                ? taskDoc.attachments
                : [];

              for (const f of uploaded) {
                const fid = String(f?.fileId || "").trim();
                if (!mongoose.isValidObjectId(fid)) continue;

                // This is served by: GET /api/mobile/offline-files/:fileId
                const url = `/mobile/offline-files/${fid}`;

                taskDoc.attachments.push({
                  filename: f.filename || "offline_upload",
                  url,
                  mime: f.contentType || "",
                  size: typeof f.size === "number" ? f.size : undefined,
                  uploadedBy:
                    req.user?.name ||
                    req.user?.email ||
                    String(req.user?._id || ""),
                  uploadedAt: at,
                  note: noteText || "",
                  storage: "mobileOffline",
                  fileId: new mongoose.Types.ObjectId(fid),
                  sourceOfflineEventId: doc._id,
                });
              }

              // ✅ Add log row (what your task screen history uses)
              taskDoc.actualDurationLog = Array.isArray(
                taskDoc.actualDurationLog,
              )
                ? taskDoc.actualDurationLog
                : [];

              const actorId =
                req.user?._id && mongoose.isValidObjectId(String(req.user._id))
                  ? new mongoose.Types.ObjectId(String(req.user._id))
                  : undefined;

              taskDoc.actualDurationLog.push({
                action: uploaded.length ? "photo" : "note",
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

              taskDoc.updatedAt = new Date();
              await taskDoc.save();

              console.log("[activity-log] applied to task", {
                taskId: String(taskDoc._id),
                uploads: uploaded.length,
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
 * ✅ LIST biometric requests
 * GET /api/mobile/biometric-requests?status=pending|approved|rejected|all
 * Optional:
 *  - targetUserId=<id>
 *  - limit=...
 *  - includeApproved=1   (legacy/compat: only used when status is empty)
 */
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

    // Keep includeApproved for backwards compatibility if someone calls without status
    const includeApproved = boolish(req.query.includeApproved);

    const find = { orgId };

    // ✅ OPTION B FIX:
    // - If status === "all": return everything (do not add find.status)
    // - If status is a concrete value: filter to that status
    // - If status missing (defaults to pending): still pending
    if (status && status !== "all") {
      // if someone passes status=all we skip this
      // if someone passes status=pending/approved/rejected we filter
      // For legacy "status=all&includeApproved=0" we still honor status=all => ALL
      find.status = status;
    } else if (!statusRaw) {
      // legacy path: no status provided at all
      // default pending, unless includeApproved=1
      if (!includeApproved) find.status = "pending";
      // if includeApproved=1 and no status, do not force pending
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

      // ✅ ALSO persist the first photo onto the User as a profile reference
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
          // safe even if your schema doesn't declare it (Mongo will store it)
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

// ✅ Enrollment status helper (admin UI + mobile can poll)
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
//   - groupId (optional) - if supplied, filter to that group's members
// -----------------------------

const crypto = require("crypto");

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

      // 1) Probe embedding from uploaded image
      const probeBuf = bufferToFloat32BufferStub(req.file.buffer);
      const probe = bufferToFloat32Array(probeBuf);

      // 2) Optional filter by group members
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

      // 3) Load enrolled embeddings
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

      // 4) Compare cosine similarity
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

      // 5) Threshold
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
