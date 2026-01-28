// core-backend/routes/mobile.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

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
const ROUTER_VERSION = "mobile-router-v2026-01-27-01";

/**
 * IMPORTANT:
 * - requireAuth must NOT require org
 * - resolveOrgContext is safe (it only attaches orgId if present)
 */
router.use((req, res, next) => {
  res.setHeader("x-mobile-router-version", ROUTER_VERSION);
  next();
});

router.use(requireAuth, resolveOrgContext);

/**
 * ✅ BOOTSTRAP (NO ORG REQUIRED)
 * Called BEFORE org selection.
 * Returns orgs for this user so the app can set AsyncStorage ORG_KEY.
 */
router.get("/bootstrap", async (req, res) => {
  try {
    res.setHeader("x-mobile-bootstrap", "HIT-BOOTSTRAP");
    console.log("[mobile] BOOTSTRAP HIT", new Date().toISOString());

    const user = req.user;
    if (!user?._id) return res.status(401).json({ error: "Not authenticated" });

    // Your User model has a REQUIRED single orgId
    const orgId = user.orgId ? String(user.orgId) : null;

    if (!orgId) {
      return res.json({ ok: true, orgs: [] });
    }

    // Optionally fetch org name
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

/**
 * ✅ Debug endpoint (optional but very useful right now)
 * This also does NOT require org.
 */
router.get("/whoami", (req, res) => {
  return res.json({
    ok: true,
    routerVersion: ROUTER_VERSION,
    user: req.user || null,
    orgIdAttached: req.orgId || null,
  });
});

/**
 * ✅ MOBILE LISTS (ORG REQUIRED)
 * Used by Offline screen to cache dropdown data
 */
router.get("/lists", requireOrg, async (req, res) => {
  try {
    const orgId = req.orgObjectId || req.user?.orgId;

    // Lazy-load models so missing ones don’t crash the server
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
          .select({ _id: 1, name: 1, email: 1, role: 1 })
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

/* ------------------ Offline events ingestion (ORG REQUIRED) ------------------ */
const OfflineEventSchema = new mongoose.Schema(
  {
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Org", index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    eventType: { type: String, index: true },
    entityRef: { type: String },
    payload: { type: Object },
    fileUris: { type: [String], default: [] },
    createdAtClient: { type: String },
    receivedAt: { type: Date, default: Date.now },
  },
  { minimize: false },
);

const OfflineEvent =
  mongoose.models.OfflineEvent ||
  mongoose.model("OfflineEvent", OfflineEventSchema);

// ✅ requireOrg is applied ONLY to this route now
router.post("/offline-events", requireOrg, async (req, res) => {
  const body = req.body || {};
  const orgId = req.orgObjectId || req.user?.orgId;
  const userId = req.user?._id || null;

  const doc = await OfflineEvent.create({
    orgId,
    userId,
    eventType: body.eventType || "unknown",
    entityRef: body.entityRef || null,
    payload: body.payload || {},
    fileUris: Array.isArray(body.fileUris) ? body.fileUris : [],
    createdAtClient: body.createdAt || null,
  });

  res.json({ ok: true, id: doc._id });
});

// ✅ Mobile list snapshot for offline caching
// GET /api/mobile/lists
router.get("/lists", requireOrg, async (req, res) => {
  try {
    // We keep these optional so the endpoint works even if a module isn't installed yet.
    const out = { ok: true };

    // --- Projects ---
    try {
      const Project = require("../models/Project");
      const where = Project?.schema?.path("orgId")
        ? { orgId: req.orgObjectId || req.user?.orgId }
        : {};
      out.projects = await Project.find(where)
        .select("_id name title code status")
        .sort({ updatedAt: -1 })
        .limit(2000)
        .lean();
    } catch {
      out.projects = [];
    }

    // --- Tasks ---
    try {
      const Task = require("../models/Task");
      const where = Task?.schema?.path("orgId")
        ? { orgId: req.orgObjectId || req.user?.orgId }
        : {};
      out.tasks = await Task.find(where)
        .select("_id title name status projectId assignedTo assignedUserId")
        .sort({ updatedAt: -1 })
        .limit(5000)
        .lean();
    } catch {
      out.tasks = [];
    }

    // --- Milestones ---
    try {
      const TaskMilestone = require("../models/TaskMilestone");
      const where = TaskMilestone?.schema?.path("orgId")
        ? { orgId: req.orgObjectId || req.user?.orgId }
        : {};
      out.milestones = await TaskMilestone.find(where)
        .select("_id title name projectId taskId status")
        .sort({ updatedAt: -1 })
        .limit(5000)
        .lean();
    } catch {
      out.milestones = [];
    }

    // --- Users ---
    try {
      const User = require("../models/User");
      const where = User?.schema?.path("orgId")
        ? {
            orgId: req.orgObjectId || req.user?.orgId,
            isDeleted: { $ne: true },
          }
        : { isDeleted: { $ne: true } };
      out.users = await User.find(where)
        .select("_id name email role roles")
        .sort({ name: 1 })
        .limit(5000)
        .lean();
    } catch {
      out.users = [];
    }

    // ✅ --- INSPECTIONS (FORMS) ---
    // Your inspection module exposes forms at /inspection/forms
    try {
      const InspectionForm = require("../models/InspectionForm");
      const where = InspectionForm?.schema?.path("orgId")
        ? {
            orgId: req.orgObjectId || req.user?.orgId,
            isDeleted: { $ne: true },
          }
        : { isDeleted: { $ne: true } };

      out.inspections = await InspectionForm.find(where)
        .select(
          "_id title description formType scope subject scoring rolesAllowed updatedAt",
        )
        .sort({ updatedAt: -1 })
        .limit(2000)
        .lean();
    } catch {
      out.inspections = [];
    }

    return res.json(out);
  } catch (e) {
    console.error("[mobile/lists] error", e);
    return res.status(500).json({ error: "Lists fetch failed" });
  }
});

module.exports = router;
