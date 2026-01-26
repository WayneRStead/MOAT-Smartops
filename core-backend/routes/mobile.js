// core-backend/routes/mobile.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const {
  requireAuth,
  resolveOrgContext,
  requireOrg,
} = require("../middleware/auth");

// Models (safe require)
let User, Org;
try {
  User = require("../models/User");
} catch {}
try {
  Org = require("../models/Org");
} catch {}

/* -----------------------------------------------------------
   AUTH ONLY (no org required yet)
----------------------------------------------------------- */
router.use(requireAuth, resolveOrgContext);

/**
 * ✅ MOBILE BOOTSTRAP
 * Returns orgs available to the signed-in user.
 * IMPORTANT: must NOT require org context.
 */
router.get("/bootstrap", async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) return res.status(401).json({ error: "Missing user" });

    // If your User model stores org membership differently, adjust here.
    // Common patterns:
    // - user.orgId (single org)
    // - user.orgIds (array)
    // - user.orgs (array of objects)
    // We'll handle multiple possibilities defensively.

    let orgIds = [];

    // 1) direct orgId
    if (req.user?.orgId) orgIds.push(String(req.user.orgId));

    // 2) orgIds array
    if (Array.isArray(req.user?.orgIds)) {
      orgIds.push(...req.user.orgIds.map((x) => String(x)));
    }

    // 3) orgs array of { orgId } or strings
    if (Array.isArray(req.user?.orgs)) {
      for (const o of req.user.orgs) {
        if (!o) continue;
        if (typeof o === "string") orgIds.push(o);
        else if (o.orgId) orgIds.push(String(o.orgId));
        else if (o._id) orgIds.push(String(o._id));
      }
    }

    orgIds = [...new Set(orgIds)].filter(Boolean);

    // If we still have none, try fetching the full user record (in case req.user is minimal)
    if (!orgIds.length && User?.findById) {
      const full = await User.findById(userId).lean();
      if (full?.orgId) orgIds.push(String(full.orgId));
      if (Array.isArray(full?.orgIds))
        orgIds.push(...full.orgIds.map((x) => String(x)));
      if (Array.isArray(full?.orgs)) {
        for (const o of full.orgs) {
          if (!o) continue;
          if (typeof o === "string") orgIds.push(o);
          else if (o.orgId) orgIds.push(String(o.orgId));
          else if (o._id) orgIds.push(String(o._id));
        }
      }
      orgIds = [...new Set(orgIds)].filter(Boolean);
    }

    // Load org docs
    let orgs = [];
    if (Org?.find && orgIds.length) {
      orgs = await Org.find({ _id: { $in: orgIds } })
        .select({ name: 1 })
        .lean();
    }

    // Always return something predictable
    return res.json({
      ok: true,
      user: { _id: String(userId), email: req.user?.email || null },
      orgs: (orgs || []).map((o) => ({
        _id: String(o._id),
        name: o.name || "Organisation",
      })),
    });
  } catch (e) {
    console.error("[mobile/bootstrap] error", e);
    return res.status(500).json({ error: "Bootstrap failed" });
  }
});

/* -----------------------------------------------------------
   ORG-REQUIRED ROUTES (everything below needs org context)
----------------------------------------------------------- */
router.use(requireOrg);

/**
 * Offline event ingestion
 */
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

router.post("/offline-events", async (req, res) => {
  const body = req.body || {};

  // orgId from resolved org context
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
