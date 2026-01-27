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
      Inspection = require("../models/Inspection");
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

module.exports = router;
